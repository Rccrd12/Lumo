// The new look's home (Settings → Island → New look): one list, as on the
// concept's board, laid out wide rather than tall. On the left what waits for
// you and the sessions at work; on the right the live activities as small
// tiles and the other pills as a row of names; the field to the chat under
// it all. A session or a pill opens its card (the overview); a waiting
// request is answered here only by a click on N or Y, as on its own card.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { State, type AgentTask } from "../core/state";
import { sessionSubtitle } from "../core/pills";
import { lastTextStep } from "../core/diff";
import { ACTIVITIES_TEXT, eventWhen, type ActivitiesAction, type ActivitiesData } from "./activities-view";
import { N_, language, t, tl } from "../i18n/i18n";
import { Bridge, type Decision } from "../core/bridge";
import { parseDuration, type TimerActivity } from "../core/compact";
import type { PlanKind } from "../core/plan";
import { planPillParts, visiblePlanKinds } from "./usage";
import { TOOLS_STRINGS } from "./tools";

export const HOME_TEXT = {
  needsYou: N_("Needs you"),
  paused: N_("Paused"),
  stop: N_("Stop the timer"),
};

/** The timer ring's radius, and its length. */
const RING_R = 22;
const RING_C = 2 * Math.PI * RING_R;

/** What the home needs from the island. */
export interface HomeActions {
  openSession(id: string): void;
  openRequest(): void;
  decide(d: Decision, requestId: string): void;
  openChat(): void;
  openPlan(kind: PlanKind): void;
  makeTool(): void;
  activityData(): ActivitiesData;
  activity(a: ActivitiesAction): void;
  blip(): void;
}

/** How long a request that just came up ignores clicks on N and Y (views.ts CLICK_GUARD_MS). */
const CLICK_GUARD_MS = 600;
/** Rows shown before the list scrolls. */
const MAX_SESSIONS = 3;

// The home's measures, for its height (homeHeight) and look-new.css.
const TOP = 44;
const LABEL_H = 24;
const ROW_H = 54;
const ROW_GAP = 6;
const TILE_H = 82;
const CHIPS_H = 34;
const FIELD_H = 40;
const GAP = 12;
const BOTTOM = 12;

function tilesOf(data: ActivitiesData): ("timer" | "music" | "calendar" | "mail")[] {
  const tiles: ("timer" | "music" | "calendar" | "mail")[] = [];
  // Put away with the "⋯" menu's Live Activities (the usual look's panel,
  // folded or off, has no say here: on the home they are shown by default).
  if (State.settings.homeActivities === false) return tiles;
  // The timer and the music always (a timer to start, what plays); the
  // calendar and the email once they are set up, empty or not.
  tiles.push("timer", "music");
  if (data.calendar.configured) tiles.push("calendar");
  if (data.mail.on) tiles.push("mail");
  return tiles;
}

/** The sessions the home lists, and the other pills it names (the email's is its tile, when shown). */
export function homeLists(active: (t: AgentTask) => boolean, data: ActivitiesData): { sessions: AgentTask[]; others: AgentTask[] } {
  const mailTile = tilesOf(data).includes("mail");
  return {
    sessions: State.tasks.filter(active),
    others: State.tasks.filter((x) => !active(x) && !(mailTile && x.id === "integration_mail")),
  };
}

/** The home's height for what it shows now: rows on the left, tiles on the right, the field under them. */
export function homeHeight(sessions: number, waiting: boolean, data: ActivitiesData, chips: number): number {
  const shown = Math.min(sessions, MAX_SESSIONS);
  let left = 0;
  if (waiting) left += LABEL_H + ROW_H;
  if (shown) left += (waiting ? GAP : 0) + LABEL_H + shown * ROW_H + (shown - 1) * ROW_GAP;
  if (!left) left = ROW_H;
  const tiles = tilesOf(data).length;
  // Three side by side in one row (look-new.css .three), else two to a row.
  const rows = tiles === 3 ? 1 : Math.ceil(tiles / 2);
  const right = tiles ? rows * TILE_H + (rows - 1) * 8 : 0;
  return TOP + Math.max(left, right) + (chips ? GAP + CHIPS_H : 0) + GAP + FIELD_H + BOTTOM;
}

export function buildHome(actions: HomeActions, active: (t: AgentTask) => boolean) {
  const left = h("div", { class: "home-left" });
  const right = h("div", { class: "home-right" });
  const tilesEl = h("div", { class: "home-tiles" });
  const chipsEl = h("div", { class: "home-chips" });
  // The plans' usage, at the end of the services' line: written out when it
  // fits, only the numbers when that fits, else not at all (fitUsage).
  const usageEl = h("div", { class: "home-usage" });
  right.append(tilesEl);
  const field = h("button", { class: "ask-field home-field", onclick: () => actions.openChat() },
    h("span", { class: "ph", text: tl("Ask me anything…") }));
  // Beside the field: straight into the tool workshop (views/forge.ts), as Tools' "Add a tool" does.
  const makeTool = h("button", { class: "home-make-tool", title: tl(TOOLS_STRINGS.addHint), onclick: () => actions.makeTool() },
    svg(ICONS.wrench, 13, { stroke: 1.8 }), h("span", { text: tl(TOOLS_STRINGS.add) }));
  const el = h("div", { class: "view home" }, h("div", { class: "home-cols" }, left, right), chipsEl,
    h("div", { class: "home-ask" }, field, makeTool));

  // The timer's field outlives the tiles' rebuilds, so what is typed in it stays.
  const timerInput = h("input", {
    class: "tile-input", type: "text", spellcheck: "false", autocomplete: "off",
    placeholder: tl(ACTIVITIES_TEXT.timerHint), "aria-label": tl(ACTIVITIES_TEXT.timer),
  }) as HTMLInputElement;
  // The island only gets the keyboard once asked (as the chat's field does).
  timerInput.addEventListener("mousedown", () => {
    if (document.hasFocus()) return;
    void Bridge.focusWindow(true);
    window.setTimeout(() => timerInput.focus(), 60);
  });
  timerInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const m = /^(\S+)\s*(.*)$/.exec(timerInput.value.trim());
    const ms = m ? parseDuration(m[1]) : null;
    if (!m || ms == null) {
      timerInput.classList.add("bad");
      window.setTimeout(() => timerInput.classList.remove("bad"), 600);
      return;
    }
    timerInput.value = "";
    timerInput.blur();
    actions.activity({ kind: "timer", ms, label: m[2] });
  });

  let leftKey = "";
  let rightKey = "";
  let usageKey = "";
  /** The room the usage was last fitted to: the line's width, what the services take. */
  let fitKey = "";

  /** Full names, numbers only, or nothing: the most of it that fits after the services. */
  function fitUsage() {
    if (!usageEl.childElementCount || State.view !== "home") return;
    const width = chipsEl.clientWidth;
    const row = chipsEl.querySelector<HTMLElement>(".home-chip-row");
    const name = chipsEl.querySelector<HTMLElement>(".home-chips-name");
    // What the services need, whole, and the 10px gaps between the line's parts.
    // (The line's own width says nothing: it stretches into what is free.)
    const first = row?.firstElementChild as HTMLElement | null;
    const last = row?.lastElementChild as HTMLElement | null;
    const services = first && last ? last.offsetLeft + last.offsetWidth - first.offsetLeft : 0;
    const used = (name ? name.offsetWidth + 10 : 0) + (services ? services + 10 : 0) + 4;
    const key = `${width}:${used}`;
    if (key === fitKey) return;
    fitKey = key;
    for (const mode of ["full", "short", "none"] as const) {
      usageEl.className = `home-usage ${mode}`;
      if (mode === "none" || usageEl.scrollWidth <= width - used) break;
    }
  }
  let shownFor: string | null = null;
  let shownAt = 0;
  /** The running timer's countdown and ring, moved on by tick(). */
  const timerEls: { el: HTMLElement; ring: SVGCircleElement; timer: TimerActivity }[] = [];

  const guarded = (d: Decision) => () => {
    if (performance.now() - shownAt < CLICK_GUARD_MS || shownFor == null) return;
    actions.decide(d, shownFor);
  };

  function waitingCard(): HTMLElement | null {
    const req = State.pendingApproval;
    if (!req) return null;
    const task = State.tasks.find((x) => x.id === req.pillId) ?? null;
    const name = req.project ?? task?.name ?? "";
    const who = h("div", { class: "home-who" },
      task ? dot(task.color, 8) : null,
      h("span", { class: "n", text: name }),
      h("span", { class: "s", text: req.email ? t("wants to send an email") : req.questions ? t("is asking a question") : `· ${t(sessionSubtitle(req.pillId))}` }));
    const what = req.questions
      ? h("div", { class: "home-line", text: req.questions[0]?.question ?? "" })
      : h("div", { class: "home-line" }, h("code", { text: req.email ? req.email.subject : req.command || req.tool }));
    const ends: HTMLElement[] = [];
    // An email is read whole before it goes, and a question has options: their card opens.
    if (req.email || req.questions) {
      ends.push(h("button", { class: "home-btn acc", text: tl("Open"), onclick: () => actions.openRequest() }));
    } else {
      ends.push(
        h("button", { class: "home-btn", title: tl("Deny"), text: "N", onclick: guarded("deny") }),
        h("button", { class: "home-btn acc", title: tl("Allow"), text: "Y", onclick: guarded("allow") }),
      );
    }
    const row = h("div", { class: "home-row hot" }, h("div", { class: "home-text" }, who, what), ...ends);
    // A click on the words opens the whole card, with what it is for.
    row.addEventListener("click", (e) => {
      if (!(e.target as Element).closest("button")) actions.openRequest();
    });
    return row;
  }

  function sessionRow(task: AgentTask): HTMLElement {
    const done = task.state === "finished";
    const failed = task.state === "error";
    const step = done ? task.finalLine || lastTextStep(task.steps) : lastTextStep(task.steps);
    const line = done ? `${t("Done")}${step ? ` · ${step}` : ""}` : failed ? `${t("Error")}${step ? ` · ${step}` : ""}` : step ?? "";
    const count = task.steps.length > 1 && !done ? `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}` : "";
    return h("button", { class: "home-row", onclick: () => actions.openSession(task.id) },
      h("div", { class: "home-text" },
        h("div", { class: "home-who" },
          dot(task.color, 8),
          h("span", { class: "n", text: task.name }),
          // An agent's pill is named after it: no need to say it twice.
          t(sessionSubtitle(task.id)) !== task.name ? h("span", { class: "s", text: `· ${t(sessionSubtitle(task.id))}` }) : null),
        h("div", { class: `home-line${done ? " ok" : failed ? " err" : ""}`, text: line })),
      count ? h("span", { class: "home-count", text: count }) : null);
  }

  function label(text: string, n?: number): HTMLElement {
    return h("div", { class: "home-label" }, h("span", { text }), n != null ? h("span", { class: "c", text: String(n) }) : null);
  }

  function remaining(endsAt: number): string {
    const s = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    const m = Math.floor(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
  }

  /** The ring round what is left of a timer (52 px, its fill set by tick()). */
  function timerRing(): { el: SVGSVGElement; fill: SVGCircleElement } {
    const NS = "http://www.w3.org/2000/svg";
    const el = document.createElementNS(NS, "svg") as SVGSVGElement;
    el.setAttribute("viewBox", "0 0 52 52");
    el.setAttribute("class", "tile-ring");
    const circle = (cls: string) => {
      const c = document.createElementNS(NS, "circle") as SVGCircleElement;
      c.setAttribute("cx", "26");
      c.setAttribute("cy", "26");
      c.setAttribute("r", String(RING_R));
      c.setAttribute("class", cls);
      el.append(c);
      return c;
    };
    circle("tile-ring-track");
    const fill = circle("tile-ring-fill");
    fill.setAttribute("stroke-dasharray", String(RING_C));
    return { el, fill };
  }

  function tile(kind: "timer" | "music" | "calendar" | "mail", data: ActivitiesData): HTMLElement {
    switch (kind) {
      case "timer": {
        const timer = data.timers[0];
        // None running: one to type ("15m pasta", Enter), or three to start with a click.
        if (!timer) {
          const start = (minutes: number) => h("button", {
            class: "tile-chip", text: `${minutes}m`,
            onclick: () => actions.activity({ kind: "timer", ms: minutes * 60_000, label: "" }),
          });
          return h("div", { class: "home-tile" },
            h("label", { class: "tile-field" }, svg(ICONS.clock, 12, { stroke: 1.8 }), timerInput),
            h("div", { class: "tile-chips" }, start(5), start(10), start(25)));
        }
        // Running: the time on the left, a ring of what is left on the right;
        // under the mouse the ring gives way to pause (or go on) and ×.
        const paused = timer.pausedLeft != null;
        const big = h("div", { class: "tile-big", text: remaining(timer.endsAt) });
        const ring = timerRing();
        timerEls.push({ el: big, ring: ring.fill, timer });
        const ctl = (icon: string, title: string, run: () => void) =>
          h("button", { class: "tile-ctl", title: t(title), "aria-label": t(title), onclick: run }, svg(icon, 11));
        return h("div", { class: `home-tile tile-timer${paused ? " paused" : ""}` },
          h("div", { class: "tile-timer-text" },
            h("div", { class: "tile-kick" }, svg(ICONS.clock, 12, { stroke: 1.8 }),
              h("span", { text: paused ? t(HOME_TEXT.paused) : timer.label || t(ACTIVITIES_TEXT.timer) })),
            big),
          h("div", { class: "tile-timer-side" }, ring.el,
            h("div", { class: "tile-timer-ctls" },
              ctl(paused ? ICONS.play : ICONS.pause, paused ? ACTIVITIES_TEXT.play : ACTIVITIES_TEXT.pause,
                () => actions.activity({ kind: "pauseTimer", id: timer.id })),
              ctl(ICONS.xmark, HOME_TEXT.stop, () => actions.activity({ kind: "cancelTimer", id: timer.id })))));
      }
      case "music": {
        const media = data.media;
        // The whole tile plays or pauses (with nothing playing, it asks the
        // last player to go on); its own buttons do only what they say.
        const playPause = (tileEl: HTMLElement) => {
          tileEl.addEventListener("click", (e) => {
            if (!(e.target as Element).closest("button")) actions.activity({ kind: "media", action: "toggle" });
          });
          return tileEl;
        };
        if (!media) {
          return playPause(h("div", { class: "home-tile link", title: t(ACTIVITIES_TEXT.play) },
            h("div", { class: "tile-kick" }, svg(ICONS.play, 10), h("span", { text: t(ACTIVITIES_TEXT.music) })),
            h("div", { class: "tile-sub", text: t(ACTIVITIES_TEXT.nothingPlaying) })));
        }
        const ctl = (icon: string, title: string, action: "toggle" | "next") =>
          h("button", { class: "tile-ctl", title: t(title), onclick: () => actions.activity({ kind: "media", action }) }, svg(icon, 11));
        return playPause(h("div", { class: "home-tile link", title: t(media.playing ? ACTIVITIES_TEXT.pause : ACTIVITIES_TEXT.play) },
          h("div", { class: "tile-kick" }, dot("#22c55e", 6), h("span", { text: media.app || t(ACTIVITIES_TEXT.music) })),
          h("div", { class: "tile-title", text: media.title }),
          h("div", { class: "tile-ctls" },
            ctl(media.playing ? ICONS.pause : ICONS.play, media.playing ? ACTIVITIES_TEXT.pause : ACTIVITIES_TEXT.play, "toggle"),
            ctl(ICONS.forward, ACTIVITIES_TEXT.next, "next"),
            h("span", { class: "tile-sub", text: media.artist }))));
      }
      case "calendar": {
        const [first, second] = data.calendar.events;
        const now = Date.now();
        // Opens the calendar on the web, or its Settings when it has no site.
        const opens = (tileEl: HTMLElement) => {
          tileEl.addEventListener("click", () => actions.activity(data.calendar.link ? { kind: "calendarWeb" } : { kind: "settings" }));
          return tileEl;
        };
        if (!first) {
          return opens(h("div", { class: "home-tile link" },
            h("div", { class: "tile-kick" }, svg(ICONS.calendar, 12, { stroke: 1.8 }), h("span", { text: t(ACTIVITIES_TEXT.calendar) })),
            h("div", { class: "tile-sub", text: t(ACTIVITIES_TEXT.nothingSoon) })));
        }
        const tileEl = h("div", { class: "home-tile link" },
          h("div", { class: "tile-kick" }, svg(ICONS.calendar, 12, { stroke: 1.8 }),
            h("span", { text: first.allDay ? t(ACTIVITIES_TEXT.allDay) : eventWhen(first, now, language()) })),
          h("div", { class: "tile-title", text: first.title }),
          second ? h("div", { class: "tile-sub", text: `${second.title} · ${second.allDay ? t(ACTIVITIES_TEXT.allDay) : eventWhen(second, now, language())}` }) : null);
        return opens(tileEl);
      }
      case "mail": {
        const mail = data.mail.messages;
        if (!mail.length) {
          const quiet = h("div", { class: "home-tile link" },
            h("div", { class: "tile-kick" }, svg(ICONS.envelope, 12, { stroke: 1.8 }), h("span", { text: t(ACTIVITIES_TEXT.email) })),
            h("div", { class: "tile-sub", text: t(ACTIVITIES_TEXT.noUnread) }));
          quiet.addEventListener("click", () => actions.activity({ kind: "inbox" }));
          return quiet;
        }
        const tileEl = h("div", { class: "home-tile link" },
          h("div", { class: "tile-kick" }, dot("#f4505e", 6), h("span", { text: `${t(ACTIVITIES_TEXT.email)} · ${mail.length}` })),
          h("div", { class: "tile-title", text: mail[0].from }),
          h("div", { class: "tile-sub", text: mail[0].subject }));
        tileEl.addEventListener("click", () => actions.activity({ kind: "inbox" }));
        return tileEl;
      }
    }
  }

  // Shown, or the island resized without anything else changing: fitted again.
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => fitUsage()).observe(chipsEl);

  return {
    el,
    tick(): boolean {
      for (const { el: big, ring, timer } of timerEls) {
        const text = remaining(timer.endsAt);
        if (big.textContent !== text) big.textContent = text;
        const left = Math.max(0, Math.min(1, (timer.endsAt - Date.now()) / timer.total));
        const offset = (RING_C * (1 - left)).toFixed(1);
        if (ring.getAttribute("stroke-dashoffset") !== offset) ring.setAttribute("stroke-dashoffset", offset);
      }
      return false;
    },
    sync() {
      const req = State.pendingApproval;
      const id = req?.requestId ?? null;
      if (id !== shownFor) {
        shownFor = id;
        shownAt = performance.now();
      }
      const data = actions.activityData();
      const { sessions, others } = homeLists(active, data);

      // Rebuilt only when what they show changes: a rebuild between a mouse-down
      // and its mouse-up would swallow the click.
      const lk = [
        language(), id, req?.command, req?.questions?.[0]?.question, req?.email?.subject, State.approvalQueue.length,
        ...sessions.map((x) => `${x.id}:${x.name}:${x.color}:${x.state}:${x.stepIndex}:${x.steps.length}:${lastTextStep(x.steps)}:${x.finalLine ?? ""}`),
      ].join("~");
      if (lk !== leftKey) {
        leftKey = lk;
        clear(left);
        const waiting = waitingCard();
        if (waiting) left.append(label(t(HOME_TEXT.needsYou), 1 + State.approvalQueue.length), waiting);
        if (sessions.length) {
          left.append(label(t("In progress"), sessions.length),
            h("div", { class: "home-rows" }, ...sessions.map(sessionRow)));
        }
        if (!waiting && !sessions.length) {
          left.append(h("div", { class: "home-empty" },
            h("div", { class: "n", text: t("Nothing running right now.") }),
            h("div", { class: "s", text: t("Drop a file or window, or ask me anything.") })));
        }
      }

      const tiles = tilesOf(data);
      const kinds = visiblePlanKinds();
      const rk = [
        language(), ...tiles,
        // (A paused timer's endsAt moves with the clock: what is left says it.)
        ...data.timers.map((x) => `${x.id}:${x.label}:${x.pausedLeft != null ? `p${x.pausedLeft}` : x.endsAt}`),
        data.media ? `${data.media.app}:${data.media.title}:${data.media.artist}:${data.media.playing}` : "",
        ...data.calendar.events.slice(0, 2).map((e) => `${e.title}:${e.start}`),
        ...data.mail.messages.slice(0, 1).map((m) => `${m.id}:${m.from}:${m.subject}`), data.mail.messages.length,
        ...others.map((x) => `${x.id}:${x.name}:${x.color}:${x.pillBadge ?? ""}`),
      ].join("~");
      if (rk !== rightKey) {
        rightKey = rk;
        const typing = document.activeElement === timerInput;
        clear(tilesEl);
        timerEls.length = 0;
        for (const kind of tiles) tilesEl.append(tile(kind, data));
        if (typing && timerInput.isConnected) timerInput.focus();
        tilesEl.hidden = tiles.length === 0;
        right.classList.toggle("three", tiles.length === 3);
        clear(chipsEl);
        usageKey = "";
        if (others.length) {
          // One line across the island, its name first, as on the board.
          chipsEl.append(h("span", { class: "home-chips-name", text: t("Services") }),
            h("div", { class: "home-chip-row" }, ...others.map((x) => {
              const chip = h("button", { class: "home-chip", onclick: () => actions.openSession(x.id) },
                dot(x.color, 7), h("span", { text: x.id === "integration_claude" ? "VS Code" : x.name }));
              if (x.pillBadge) chip.classList.add(`badge-${x.pillBadge}`);
              return chip;
            })));
        }
        chipsEl.hidden = others.length === 0 && kinds.length === 0;
        right.hidden = tiles.length === 0;
      }
      const uk = kinds.map((kind) => {
        const p = planPillParts(kind);
        return `${kind}:${p.value}:${p.color}`;
      }).join("~");
      if (uk !== usageKey) {
        usageKey = uk;
        clear(usageEl);
        usageEl.append(...kinds.map((kind) => {
          const p = planPillParts(kind);
          return h("button", { class: "home-plan", title: `${p.name} ${p.value}`, onclick: () => actions.openPlan(kind) },
            dot(p.color, 7), h("span", { class: "home-plan-name", text: p.name }), h("span", { class: "home-plan-pct", text: p.value }));
        }));
        if (usageEl.parentElement !== chipsEl || chipsEl.lastElementChild !== usageEl) chipsEl.append(usageEl);
        fitKey = "";
      }
      fitUsage();
    },
  };
}
