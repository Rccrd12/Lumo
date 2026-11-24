// The chat's model picker (views/chat.ts): provider chips, then the chosen
// provider's models, their effort, and a local model's load and eject.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, onEvent, type LocalLoad, type ModelInfo, type UnslothStudio, UNSLOTH_STUDIO_EVENT } from "../core/bridge";
import { activeModel, apiCaps, capsContext, capsWords, effortFor, effortsFor, isApiProvider, localCapsOf, pickModel, providerDef, setLocalCaps, anyProviderReady, visibleProviders, withModel, type ProviderDef } from "../core/providers";
import { groupByEffort, groupOf, levelOf, splitEffort, variantFor } from "../core/effort-groups";
import { cliModelName } from "../core/model-names";
import { isOrchestratorRow, offersOrchestrator, orchestratorListed, orchestratorModel, orchestratorRoles, parseOrchestrator, defaultOrchestrator, roleName, stepRole, withRoleLevel, type Orchestration } from "../core/orchestrator";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { t, tl } from "../i18n/i18n";
import { CONTEXT_STRINGS } from "../core/context-usage";
import { AGY, saveSettings } from "./chat-attach";
import { ACTIVITY_STRINGS } from "./chat-messages";
import { LOAD_MINUS, LOAD_PLUS, LOAD_STRINGS, STRINGS, effortLabel } from "./chat-strings";

// ── Model picker ──────────────────────────────────────────────────────────────

interface Picker {
  el: HTMLElement;
  open(): void;
  close(): void;
  /** Asks a local model's server what the model picked can do, when it changed (or `force`d). */
  refreshCaps(force?: boolean): void;
  /**
   * The model to use in place of `model` with provider `id` when its list no
   * longer offers it (a model retired since a chat was on it), else null.
   */
  replacementFor(id: string, model: string): Promise<string | null>;
  /** Antigravity CLI: `model`'s name and level when the list has other levels of it, else null. */
  variantOf(model: string): { base: string; level: string } | null;
  /** The name provider `id`'s list gave `model`, once it was asked; else undefined. */
  labelOf(id: string, model: string): string | undefined;
  readonly isOpen: boolean;
}

/**
 * The providers set up on this computer (lib.rs chat_providers), asked each
 * time the picker opens; null until the first answer, or with no Rust to ask.
 */
export let readyProviders: ReadonlySet<string> | null = null;

/**
 * Provider chips, then the chosen provider's models — ModelPickerView.
 * `onPicked` once a provider or a model is picked: the chat on screen keeps it.
 */
export function buildPicker(onChange: () => void, openSettings: () => void, onPicked: () => void): Picker {
  const chips = h("div", { class: "picker-chips" });
  const list = h("div", { class: "picker-list" });
  // Claude Code only: how hard it thinks (claude --effort), on a short slider
  // with the level it is on beside it, and Auto (its model's own level) above.
  const efforts = h("div", { class: "picker-efforts" });
  const el = h("div", { class: "picker models" }, chips, h("div", { class: "picker-rule" }), list, efforts);
  // Asked once ahead, so the first opening already shows the right chips.
  void Bridge.chatProviders().then((ids) => {
    if (Array.isArray(ids)) readyProviders = new Set(ids);
  });

  /**
   * The slider's levels and what it is on. Antigravity CLI: the levels of the
   * model in use (its variants by effort), and a level picks that variant, with
   * no Auto (its CLI has no level of its own to fall back on).
   */
  function effortSpec(p: ProviderDef): { levels: string[]; current: () => string; set: (e: string) => void; auto: boolean } {
    if (p.id === AGY) {
      const groups = groupByEffort((cache.get(p.id) ?? []).map((m) => m.id));
      const group = groupOf(groups, activeModel(State.settings));
      return {
        levels: group?.levels ?? [],
        current: () => levelOf(groups, activeModel(State.settings)),
        set: (e) => {
          if (group?.ids.has(e)) State.settings = withModel(State.settings, p.id, group.ids.get(e)!);
        },
        auto: false,
      };
    }
    return {
      levels: effortsFor(p.id).filter((e) => e !== ""),
      current: () => effortFor(p.id, State.settings.chatEffort),
      set: (e) => {
        State.settings = { ...State.settings, chatEffort: e };
      },
      auto: true,
    };
  }

  function drawEfforts() {
    clear(efforts);
    efforts.classList.remove("orchestrator");
    const p = providerDef(State.settings.chatProvider);
    if (p.id === AGY && drawOrchestrator(p)) return;
    const spec = effortSpec(p);
    efforts.hidden = spec.levels.length === 0;
    if (efforts.hidden) return;
    const s = slider(p, spec);
    // One short row, so the model list keeps its room: the slider, the level
    // it is on, and Auto at the end.
    efforts.append(h("div", { class: "effort-row" }, s.track, s.value, spec.auto ? s.auto : null));
    s.show();
    fitEfforts();
  }

  /**
   * Antigravity CLI's Orchestrator in use: a row for its planner and one for
   * its executor, each with ‹ › to change the model (only those agy lets take
   * that role) and its own effort slider. False when it is not in use.
   */
  function drawOrchestrator(p: ProviderDef): boolean {
    const o = parseOrchestrator(activeModel(State.settings));
    const ids = (cache.get(AGY) ?? []).map((m) => m.id);
    const groups = groupByEffort(ids);
    if (!o || !offersOrchestrator(ids, groups)) return false;
    lastOrchestration = o;
    const roles = orchestratorRoles(groups);
    const save = (next: Orchestration) => {
      State.settings = withModel(State.settings, p.id, orchestratorModel(next));
      saveSettings();
      Sound.play("blip");
      const listed = cache.get(AGY);
      if (listed) drawModels(p, listed);
      else drawEfforts();
      onChange();
    };
    const row = (role: keyof Orchestration, label: string, count: number) => {
      const g = groupOf(groups, o[role]);
      const spec = {
        levels: g?.levels ?? [],
        current: () => levelOf(groups, parseOrchestrator(activeModel(State.settings))?.[role] ?? ""),
        set: (e: string) => {
          const now = parseOrchestrator(activeModel(State.settings));
          if (now) State.settings = withModel(State.settings, p.id, orchestratorModel(withRoleLevel(groups, now, role, e)));
        },
        auto: false,
      };
      const arrow = (step: number, icon: string, hint: string) => {
        const b = h("button", { class: "orch-step", title: t(hint), "aria-label": t(hint), text: icon, disabled: count < 2 });
        // From the pick as it is now: its sliders may have moved since this was drawn.
        b.addEventListener("click", () => save(stepRole(groups, parseOrchestrator(activeModel(State.settings)) ?? o, role, step)));
        return b;
      };
      const name = h("span", { class: "orch-model", text: roleName(o[role]), title: o[role] });
      const s = spec.levels.length > 1 ? slider(p, spec) : null;
      efforts.append(
        h("div", { class: "effort-row orch-row" },
          h("span", { class: "orch-role", text: t(label) }),
          arrow(-1, "‹", STRINGS.previousModel), name, arrow(1, "›", STRINGS.nextModel),
          s ? s.track : null, s ? s.value : null),
      );
      s?.show();
    };
    efforts.hidden = false;
    efforts.classList.add("orchestrator");
    row("planner", STRINGS.planner, roles.planners.length);
    row("executor", STRINGS.executor, roles.executors.length);
    return true;
  }

  /** An effort slider for `spec`: its track, the level it is on, and Auto (shown only where `spec.auto`). */
  function slider(p: ProviderDef, spec: ReturnType<typeof effortSpec>) {
    const levels = spec.levels;
    const last = levels.length - 1;

    const auto = h(
      "button",
      { class: "effort-auto", title: t(STRINGS.autoHint), style: `--accent:${p.accent}` },
      h("span", { text: t(STRINGS.effortAuto) }),
      h("span", { class: "effort-auto-note", text: t(STRINGS.recommended) }),
    );
    const value = h("span", { class: "effort-value" });
    // A track that fills up to the knob, with a mark for each level. Dragged,
    // the knob goes to the nearest level as soon as the pointer is past half
    // the way to it, with an ease; let go, that level is picked. On Auto there
    // is no knob: a click picks a level.
    const fill = h("i", { class: "effort-fill" });
    const knob = h("i", { class: "effort-knob" });
    const ticks = h("div", { class: "effort-ticks" }, ...levels.map(() => h("i")));
    const track = h("div", {
      class: "effort-track effort-slider",
      role: "slider",
      tabindex: "0",
      "aria-label": t(STRINGS.effort),
      "aria-valuemin": "0",
      "aria-valuemax": String(last),
      style: `--accent:${p.accent}`,
    }, ticks, fill, knob);

    /** Where the knob is, 0–1 along the track. */
    const place = (frac: number) => {
      const f = Math.max(0, Math.min(1, frac));
      track.style.setProperty("--at", String(f));
    };
    /** Draws the saved level (or Auto) without saving anything. */
    const show = () => {
      const current = spec.current();
      const index = levels.indexOf(current);
      auto.classList.toggle("on", !current);
      track.classList.toggle("auto", !current);
      track.setAttribute("aria-valuenow", String(Math.max(0, index)));
      track.setAttribute("aria-valuetext", effortLabel(current));
      value.textContent = effortLabel(current);
      place(index < 0 ? 0 : index / last);
    };
    const pick = (e: string) => {
      show();
      if (e === spec.current()) return;
      spec.set(e);
      saveSettings();
      Sound.play("blip");
      show();
      onChange();
    };
    auto.addEventListener("click", () => pick(""));

    const fracAt = (clientX: number) => {
      const r = track.getBoundingClientRect();
      // The knob's centre stays inside the track by half its width.
      const inset = parseFloat(getComputedStyle(track).getPropertyValue("--edge")) || 11;
      return r.width > 2 * inset ? (clientX - r.left - inset) / (r.width - 2 * inset) : 0;
    };
    track.addEventListener("pointerdown", (e) => {
      const pe = e as PointerEvent;
      if (pe.button !== 0) return;
      pe.preventDefault();
      track.focus();
      track.setPointerCapture?.(pe.pointerId);
      track.classList.add("dragging");
      track.classList.remove("auto");
      // Past half the way to the next level, the knob is on it already: it
      // moves from level to level as it is dragged, each step eased.
      let shown = -1;
      const follow = (x: number) => {
        const index = Math.round(Math.max(0, Math.min(1, fracAt(x))) * last);
        if (index === shown) return;
        shown = index;
        place(index / last);
        value.textContent = effortLabel(levels[index]);
      };
      follow(pe.clientX);
      const move = (m: Event) => follow((m as PointerEvent).clientX);
      const up = (u: Event) => {
        track.removeEventListener("pointermove", move);
        track.removeEventListener("pointerup", up);
        track.removeEventListener("pointercancel", up);
        track.classList.remove("dragging");
        // Settles on the nearest level, with the ease of the knob's transition.
        const index = Math.round(Math.max(0, Math.min(1, fracAt((u as PointerEvent).clientX))) * last);
        pick(levels[index]);
      };
      track.addEventListener("pointermove", move);
      track.addEventListener("pointerup", up);
      track.addEventListener("pointercancel", up);
    });
    track.addEventListener("keydown", (e) => {
      const key = (e as KeyboardEvent).key;
      const current = levels.indexOf(spec.current());
      const to = key === "ArrowRight" || key === "ArrowUp" ? Math.min(last, current + 1)
        : key === "ArrowLeft" || key === "ArrowDown" ? Math.max(0, current < 0 ? 0 : current - 1)
        : key === "Home" ? 0 : key === "End" ? last : null;
      if (to == null) return;
      e.preventDefault();
      e.stopPropagation();
      pick(levels[to]);
    });

    return { track, value, auto, show };
  }

  /**
   * In a narrow picker Auto first comes up to the slider (its margin), then
   * loses "Recommended", then goes: the slider and its level never give way.
   */
  function fitEfforts() {
    const row = efforts.firstElementChild as HTMLElement | null;
    const auto = row?.querySelector<HTMLElement>(".effort-auto");
    if (!row || !auto) return;
    auto.classList.remove("no-note", "no-room");
    const over = () => row.scrollWidth > row.clientWidth;
    if (over()) auto.classList.add("no-note");
    if (over()) auto.classList.add("no-room");
  }
  // Only when the picker's width changes (opened, or the island resized).
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => fitEfforts()).observe(efforts);

  /** Models already asked for, by provider; a model server is asked again each time. */
  const cache = new Map<string, ModelInfo[]>();
  let isOpen = false;
  let request = 0;
  /**
   * "More models" (Claude Code's older versions) opened or shut by a click;
   * null until then, each time the picker opens: open when the chat is on one.
   */
  let olderOpen: boolean | null = null;
  /** The Orchestrator pick last in use, so a click on its row brings it back. */
  let lastOrchestration: Orchestration | null = null;

  function drawChips() {
    clear(chips);
    for (const p of visibleProviders(State.settings, readyProviders)) {
      const on = p.id === State.settings.chatProvider;
      const chip = h(
        "button",
        { class: on ? "picker-chip on" : "picker-chip", style: `--accent:${p.accent}` },
        h("i", { class: "picker-dot" }),
        h("span", { text: t(p.name) }),
      );
      chip.addEventListener("click", () => {
        if (p.id === State.settings.chatProvider) return;
        State.settings = { ...State.settings, chatProvider: p.id };
        saveSettings();
        onPicked();
        Sound.play("pop");
        drawChips();
        drawEfforts();
        void loadModels();
        onChange();
      });
      chips.append(chip);
    }
  }

  function status(text: string, withSettings = false) {
    clear(list);
    const line = h("div", { class: "picker-status", text });
    if (withSettings) {
      line.append(
        h("button", {
          class: "picker-link",
          text: tl(STRINGS.openSettings),
          onclick: () => {
            try {
              window.localStorage.setItem("lumo.settings.page", "chat");
            } catch {
              // Settings open on the page they were on.
            }
            openSettings();
          },
        }),
      );
    }
    list.append(line);
  }

  /**
   * A local model's server is asked what the model picked can do (pictures,
   * tools, reasoning, its context) each time the model changes: the effort
   * slider, the screenshots and the line next to the model follow. A provider
   * called by its API says it in its model list, once the picker has it: no
   * call of its own.
   */
  let capsKey = "";
  function refreshCaps(force = false) {
    if (force) capsKey = "";
    const p = providerDef(State.settings.chatProvider);
    const model = activeModel(State.settings);
    const api = isApiProvider(p.id);
    const key = (p.urlField || api) && model ? `${p.id}|${model}|${api && cache.has(p.id) ? "listed" : ""}` : "";
    if (key === capsKey) return;
    capsKey = key;
    if (!key) return;
    if (api) {
      setLocalCaps(p.id, apiCaps(cache.get(p.id)?.find((m) => m.id === model)));
      drawEfforts();
      onChange();
      return;
    }
    setLocalCaps(p.id, null);
    void Bridge.localCaps(p.id, model)
      .then((caps) => {
        if (capsKey !== key) return;
        setLocalCaps(p.id, caps);
        drawCaps();
        drawEfforts();
        onChange();
      })
      .catch(() => {});
  }

  /** What the local model picked can do, on its row: "Images · Tools · Thinking · Context 64k / 256k". */
  function drawCaps() {
    const p = providerDef(State.settings.chatProvider);
    const slot = list.querySelector<HTMLElement>(".picker-model.on .picker-model-caps");
    if (!slot || !p.urlField) return;
    const caps = localCapsOf(p.id);
    const context = capsContext(caps);
    const words = capsWords(caps).map((w) => t(w));
    if (context) words.push(`${t(CONTEXT_STRINGS.title)} ${context}`);
    slot.textContent = words.join(" · ");
  }

  function drawModels(p: ProviderDef, listed: ModelInfo[]) {
    clear(list);
    const current = activeModel(State.settings);
    // Antigravity CLI: a model's variants by effort on one row, the slider below.
    const groups = p.id === AGY ? groupByEffort(listed.map((m) => m.id)) : null;
    let models: ModelInfo[] = groups
      ? groups.map((g) => {
          const alone = g.levels.length === 0 ? listed.find((m) => m.id === g.ids.get("")) : undefined;
          return alone ?? { id: [...g.ids.values()].includes(current) ? current : variantFor(g, levelOf(groups, current)), label: g.name };
        })
      : listed;
    // Antigravity CLI's Orchestrator: its rows (one per planner) are one, where
    // the first of them is, with the planner and the executor under the list.
    if (groups && p.id === AGY) {
      const ids = listed.map((m) => m.id);
      const at = models.findIndex((m) => isOrchestratorRow(m.id));
      models = models.filter((m) => !isOrchestratorRow(m.id));
      const pick = parseOrchestrator(current) ?? lastOrchestration ?? defaultOrchestrator(groups);
      if (at >= 0 && pick && offersOrchestrator(ids, groups)) {
        models.splice(at, 0, { id: orchestratorModel(pick), label: "Orchestrator" });
      }
    }
    /**
     * The model a click on a row picks. A group's: the variant at the level in
     * use when it is clicked (the slider may have moved since the list was drawn).
     */
    const picked = (m: ModelInfo): string => {
      const g = groups ? groupOf(groups, m.id) : undefined;
      if (!groups || !g || g.levels.length === 0) return m.id;
      const now = activeModel(State.settings);
      return [...g.ids.values()].includes(now) ? now : variantFor(g, levelOf(groups, now));
    };
    const rowFor = (m: ModelInfo): HTMLElement => {
      const on = m.id === current;
      const orch = p.id === AGY ? parseOrchestrator(m.id) : null;
      const row = h(
        "button",
        { class: on ? "picker-model on" : "picker-model", style: `--accent:${p.accent}`, title: orch ? `${orch.planner} → ${orch.executor}` : m.id },
        // agy lists its models by id: by their names here, the id on hover.
        h("span", { class: "picker-model-name", text: p.id === AGY ? cliModelName(p.id, m.label) : m.label }),
        orch ? h("span", { class: "picker-model-sub", text: `${roleName(orch.planner)} → ${roleName(orch.executor)}` }) : null,
        on && p.urlField ? h("span", { class: "picker-model-caps" }) : null,
        on ? svg(ICONS.check, 11, { stroke: 2.2 }) : null,
      );
      if (holds(p)) row.append(loadButton(p, m.id));
      row.addEventListener("click", () => {
        State.settings = withModel(State.settings, p.id, picked(m));
        saveSettings();
        onPicked();
        Sound.play("blip");
        // Orchestrator stays open: its planner and executor are set under the list.
        if (orch) {
          drawModels(p, listed);
          onChange();
          return;
        }
        close();
        refreshCaps();
      });
      return row;
    };
    // Claude Code's older versions wait under "More models", after the current
    // ones; open by themselves when the chat uses one, so its tick shows.
    const older = models.filter((m) => m.older);
    for (const m of older.length ? models.filter((m) => !m.older) : models) list.append(rowFor(m));
    if (older.length) {
      const opened = olderOpen ?? older.some((m) => m.id === current);
      const more = h(
        "button",
        { class: opened ? "picker-model picker-more open" : "picker-model picker-more", "aria-expanded": String(opened) },
        h("span", { class: "picker-model-name", text: t(STRINGS.moreModels, { count: older.length }) }),
        svg(ICONS.chevronDown, 11, { stroke: 2.2 }),
      );
      more.addEventListener("click", () => {
        olderOpen = !opened;
        drawModels(p, listed);
        // Opened: the list moves to the versions it shows, "More models" on top.
        const now = list.querySelector<HTMLElement>(".picker-more");
        if (olderOpen && now) list.scrollTop += now.getBoundingClientRect().top - list.getBoundingClientRect().top;
      });
      list.append(more);
      if (opened) for (const m of older) list.append(rowFor(m));
    }
    drawCaps();
    // The sliders first: Orchestrator's two rows take room from the list.
    if (groups) drawEfforts();
    list.querySelector(".picker-model.on")?.scrollIntoView({ block: "nearest" });
    if (holds(p)) void drawLoaded(p, models.map((m) => m.id));
  }

  /** Ollama and LM Studio load and eject models; a custom server doesn't say. */
  function holds(p: ProviderDef): boolean {
    return p.id === "ollama" || p.id === "lmstudio" || p.id === "unsloth";
  }

  /** Which models are in memory: − on those, + on the others. */
  async function drawLoaded(p: ProviderDef, ids: string[]) {
    const ticket = request;
    let loaded: string[];
    try {
      loaded = await Bridge.localLoadedOf(p.id, ids);
    } catch {
      return;
    }
    if (ticket !== request || !isOpen) return;
    for (const b of list.querySelectorAll<HTMLElement>(".picker-model-load")) {
      if (b.dataset.busy) continue;
      setLoadState(b, loaded.includes(b.dataset.model ?? "") ? "loaded" : "unloaded");
    }
  }

  function setLoadState(b: HTMLElement, state: "loaded" | "unloaded" | "busy", percent?: number) {
    b.dataset.state = state;
    b.hidden = false;
    clear(b);
    if (state === "busy") {
      b.dataset.busy = "1";
      b.title = t(LOAD_STRINGS.loading);
      b.append(h("span", { class: "picker-model-load-pct", text: percent != null ? `${percent}%` : "…" }));
      return;
    }
    delete b.dataset.busy;
    b.title = t(state === "loaded" ? LOAD_STRINGS.eject : LOAD_STRINGS.load);
    b.append(svg(state === "loaded" ? LOAD_MINUS : LOAD_PLUS, 15, { stroke: 1.6 }));
  }

  /** The round − / + at the far right of a local model's row. */
  function loadButton(p: ProviderDef, model: string): HTMLElement {
    const b = h("span", { class: "picker-model-load", role: "button" });
    b.dataset.model = model;
    b.hidden = true;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (b.dataset.busy) return;
      const eject = b.dataset.state === "loaded";
      setLoadState(b, "busy");
      const done = eject ? Bridge.localUnloadModel(p.id, model) : Bridge.localLoad(p.id, model);
      Sound.play("blip");
      void done
        .then(() => setLoadState(b, eject ? "unloaded" : "loaded"))
        .catch((err) => {
          setLoadState(b, eject ? "loaded" : "unloaded");
          b.title = String(err).replace(/^Error:\s*/, "");
        })
        .finally(() => {
          if (State.settings.chatProvider === p.id && activeModel(State.settings) === model) {
            capsKey = "";
            refreshCaps();
          }
        });
    });
    return b;
  }

  void onEvent<LocalLoad>("local-load", (e) => {
    for (const b of list.querySelectorAll<HTMLElement>(".picker-model-load")) {
      if (b.dataset.model === e.model && b.dataset.busy) setLoadState(b, "busy", Math.round(e.percent));
    }
  });

  async function loadModels() {
    const p = providerDef(State.settings.chatProvider);
    const ticket = ++request;
    const cached = p.urlField ? undefined : cache.get(p.id);
    if (cached) {
      drawModels(p, cached);
      return;
    }
    // Nothing is asked of a provider that has no key yet.
    if (p.key && !(await Bridge.secretPresent(p.key))) {
      if (ticket === request) status(t(STRINGS.noKey), true);
      return;
    }
    if (ticket !== request) return;
    status(t(STRINGS.loading));
    // Unsloth Studio off: Lumo starts it before it lists the models, and says so.
    const starting = p.id === "unsloth"
      ? await onEvent<UnslothStudio>(UNSLOTH_STUDIO_EVENT, (s) => {
          if (ticket !== request || s.state !== "starting") return;
          const seconds = s.seconds >= 2 ? ` ${t(ACTIVITY_STRINGS.seconds, { seconds: s.seconds })}` : "";
          status(`${t(ACTIVITY_STRINGS.starting)}${seconds}`);
        })
      : null;
    try {
      const models = await Bridge.chatModels(p.id).finally(() => starting?.());
      if (ticket !== request) return;
      if (!p.urlField) cache.set(p.id, models);
      const keep = pickModel(p, offered(p.id, models), activeModel(State.settings));
      if (keep && keep !== activeModel(State.settings)) {
        State.settings = withModel(State.settings, p.id, keep);
        saveSettings();
        onPicked();
        onChange();
      }
      // The list says what its models take: the effort slider follows.
      if (isApiProvider(p.id)) refreshCaps();
      drawModels(p, models);
    } catch (err) {
      if (ticket === request) status(String(err).replace(/^Error:\s*/, ""), Boolean(p.key));
    }
  }

  /** Nothing set up at all: a pointer to Settings in place of chips and models. */
  function drawNothingReady(): boolean {
    const none = readyProviders != null && !anyProviderReady(State.settings, readyProviders);
    el.classList.toggle("empty", none);
    if (none) {
      clear(chips);
      status(t(STRINGS.noProvider), true);
      efforts.hidden = true;
    }
    return none;
  }

  function open() {
    isOpen = true;
    olderOpen = null;
    el.classList.add("on");
    drawChips();
    drawEfforts();
    onChange();
    if (!drawNothingReady()) void loadModels();
    // Which are set up may have changed in Settings since: asked again each time.
    void Bridge.chatProviders().then((ids) => {
      const key = (set: ReadonlySet<string> | null) => (set ? [...set].sort().join() : null);
      const before = key(readyProviders);
      // No answer (no Rust to ask): every provider shows, as before.
      readyProviders = Array.isArray(ids) ? new Set(ids) : null;
      if (!isOpen || before === key(readyProviders)) return;
      drawChips();
      if (!drawNothingReady()) {
        drawEfforts();
        void loadModels();
      }
    });
  }

  function close() {
    isOpen = false;
    request++;
    el.classList.remove("on");
    onChange();
  }

  async function replacementFor(id: string, model: string): Promise<string | null> {
    const p = providerDef(id);
    if (p.id !== id || !model) return null;
    let models = p.urlField ? undefined : cache.get(p.id);
    if (!models) {
      // The list is asked only where that costs nothing more than the picker
      // opening on it: a provider called by its API with its key, or Claude
      // Code's own list. No CLI or model server is started for it.
      if (!isApiProvider(p.id) && p.id !== "claude-code") return null;
      if (p.key && !(await Bridge.secretPresent(p.key))) return null;
      const listed = await Bridge.chatModels(p.id);
      if (!Array.isArray(listed)) return null;
      models = listed;
      cache.set(p.id, models);
    }
    const keep = pickModel(p, offered(p.id, models, model), model);
    return keep && keep !== model ? keep : null;
  }

  /**
   * The ids `models` offers, with the Orchestrator pick in use (`model`) when
   * agy's list still allows it: it is no id of the list's own.
   */
  function offered(id: string, models: ModelInfo[], model = activeModel(State.settings)): string[] {
    const ids = models.map((m) => m.id);
    return id === AGY && orchestratorListed(ids, groupByEffort(ids), model) ? [...ids, model] : ids;
  }

  return {
    el,
    open,
    close,
    refreshCaps,
    replacementFor,
    variantOf(model: string) {
      if (parseOrchestrator(model)) return null;
      // Before the list is asked (the CLI is started only by the picker), its name says it.
      const listed = cache.get(AGY);
      if (!listed) return splitEffort(model);
      return groupOf(groupByEffort(listed.map((m) => m.id)), model)?.levels.length ? splitEffort(model) : null;
    },
    labelOf(id: string, model: string) {
      return cache.get(id)?.find((m) => m.id === model)?.label;
    },
    get isOpen() {
      return isOpen;
    },
  };
}
