// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "../core/legacy";
import "./settings.css";
import { Bridge, EMBEDDED, onEvent, type GoogleCalendarStatus, type HookPreview, type HookStatus, type MailAccount, type ModelInfo, type ShortcutsReport, type UnslothStudio } from "../core/bridge";
import {
  CUSTOM_SERVER_KEY, UNSLOTH_SERVER_KEY, effortFor, effortsFor, parsePermissionMode, permissionModesFor, isHidden, providerDef, urlExposure, visibleProviders,
} from "../core/providers";
import {
  ISLAND_SHORTCUTS, SHORTCUTS, SHORTCUT_TEXT, activeKeys, displayKeys, duplicates, effective,
  recordPress, type Binding,
} from "../core/shortcuts";
import { DEFAULT_SETTINGS, aiReads, parseCloseMode, parseMotion, type Settings } from "../core/state";
import { GoogleSync, MAX_GOOGLE_CALENDARS, isShown } from "../core/google-calendar";
import {
  MAX_DECLARED, PILL_CATEGORIES, availablePills, chooseMainPill, mainPillChoices,
  sanitizeDeclared, toggleDeclared, type PillDefinition,
} from "../core/pills";
import { h, clear } from "../views/dom";
import { agentsSection } from "./agents";
import { colorDot } from "./colors";
import { accentDot, cancelledByHand, errorText, group, renderDiff, sectionHead, setting, statusDot, wideSetting } from "./parts";
import { SEARCH_STRINGS, applySearch } from "./search";
import { ENERGY_MODES, ENERGY_ON_POWER, effectiveEffort, parseEnergyMode, parseOnPower } from "../core/energy";
import { PLAN_AGENT, agentPlanOn } from "../core/plan";
import { parseBackgroundMode } from "../core/background";
import { betaChanged, changelogSection, updatesSection } from "./updates";
import { localModelsBlock, type UnslothMemory } from "./local-models";
import { MENU_ITEMS, pickedItems, withItem } from "../core/context-menu";
import { installTextMenu } from "../views/context-menu";
import { FRAME_CLOSE, FRAME_READY, FRAME_SHOWN } from "../views/settings-frame";
import { LIVE_EXTENDED, LIVE_MODEL, THINKING_LEVELS, VOICES, parseLiveModel, parseThinking, parseVoice } from "../live/protocol";
import { VOICE_SETTINGS } from "../live/strings";
import {
  LANGUAGES, N_, isRtl, onLanguageChange, resolveLanguage, setLanguage, systemLanguages, t, tn,
} from "../i18n/i18n";

/** Where secrets.rs keeps the keys. */
const KEY_STORE = "Windows Credential Manager";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";
/** The computer runs on its battery (energy.rs), for General → Energy. */
let onBattery = false;
/** Redraws General → Energy's line about the power source. */
let energyRedraw: (() => void) | null = null;

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

/** A colour was picked for a pill's Lumo (see ./colors.ts): the island follows. */
function pickColor(next: Record<string, string>) {
  settings.pillColors = next;
  void save();
}

// ── Reusable bits ─────────────────────────────────────────────────────────────

function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

// ── Changes to Claude Code's settings.json ────────────────────────────────────

/** One kind of change to ~/.claude/settings.json, with the words that go with it. */
interface Change {
  preview: (install: boolean) => Promise<HookPreview | null>;
  apply: (install: boolean, fingerprint: string) => Promise<string | null>;
  installText: string;
  removeText: string;
  installButton: string;
  removeButton: string;
  /** The note once written; `backup` is "" when there was no file to back up. */
  done: (backup: string) => string;
}

const HOOKS_CHANGE: Change = {
  preview: Bridge.hooksPreview,
  apply: Bridge.hooksApply,
  get installText() { return t("This is exactly what will change in your settings.json. Your own hooks are left untouched."); },
  get removeText() { return t("This removes Lumo's entries only. Your own hooks are left untouched."); },
  get installButton() { return t("Back up and write"); },
  get removeButton() { return t("Back up and remove"); },
  done: (backup) => backup
    ? t("Done. Previous settings saved as {backup}. Open a new Claude Code session to pick the hooks up.", { backup })
    : t("Done. Open a new Claude Code session to pick the hooks up."),
};

const STATUS_LINE_CHANGE: Change = {
  preview: Bridge.statusLinePreview,
  apply: Bridge.statusLineApply,
  get installText() { return t("This is exactly what will change: only the status line. If you already have one it keeps working, Lumo's relay runs it for you."); },
  get removeText() { return t("This puts your previous status line back, or removes the entry if there was none."); },
  get installButton() { return t("Back up and write"); },
  get removeButton() { return t("Back up and remove"); },
  done: (backup) => backup
    ? t("Done. Previous settings saved as {backup}. The numbers appear after the next reply of a Claude Code session.", { backup })
    : t("Done. The numbers appear after the next reply of a Claude Code session."),
};

/**
 * Shows the diff of a change in `body` and writes it only after an explicit
 * click, and only if settings.json still matches the diff that was shown.
 * `back` redraws the section; `applied` runs a moment after a successful write.
 */
async function reviewChange(
  body: HTMLElement,
  change: Change,
  install: boolean,
  back: () => void,
  applied: () => void,
) {
  let preview;
  try {
    preview = await change.preview(install);
  } catch (err) {
    // An unreadable or invalid settings.json stops here rather than being
    // treated as empty and written over.
    clear(body);
    body.append(
      h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }),
      h("div", { class: "row" }, h("button", { text: t("Back"), onclick: back })),
    );
    return;
  }
  if (!preview) return;
  clear(body);
  body.append(
    h("div", { class: "hint", text: install ? change.installText : change.removeText }),
    renderDiff(preview.diff),
    h("div", { class: "row" },
      h("span", {
        class: "path",
        text: preview.backup
          ? t("Backup → {path}", { path: preview.backup })
          : t("No settings.json yet — nothing to back up."),
      }),
    ),
  );
  const confirm = h("button", {
    class: install ? "primary" : "danger",
    text: install ? change.installButton : change.removeButton,
  });
  confirm.addEventListener("click", async () => {
    confirm.disabled = true;
    try {
      const backup = await change.apply(install, preview.fingerprint);
      clear(body);
      body.append(h("div", { class: "notice ok", text: change.done(backup ?? "") }));
      window.setTimeout(applied, 2600);
    } catch (err) {
      confirm.disabled = false;
      if (cancelledByHand(err)) return;
      body.append(h("div", { class: "notice err", text: t("Could not write: {error}", { error: String(err) }) }));
    }
  });
  body.append(h("div", { class: "row" }, confirm, h("button", { text: t("Cancel"), onclick: back })));
}

// ── Claude Code section ───────────────────────────────────────────────────────

function claudeSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h(
    "section",
    {},
    ...sectionHead("Claude Code", null, statusDot(status.installed)),
    body,
  );

  const redraw = () => {
    clear(body);
    draw();
  };
  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    redraw();
    const head = section.querySelector("h2")!;
    clear(head);
    head.append(statusDot(status.installed), h("span", { text: "Claude Code" }));
  };

  function draw() {
    body.append(
      h("p", {
        class: "section-intro",
        text: status.installed
          ? t("Lumo is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there.")
          : t("Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing."),
      }),
      setting("settings.json", h("span", { class: "path", text: status.settingsPath })),
      setting(h("span", { class: "with-dot" }, t("Relay"), statusDot(status.hookReady)), h("span", { class: "path", text: status.hookPath })),
    );

    if (status.installed && status.current === false) {
      body.append(h("div", {
        class: "notice warn",
        text: t("This version of Lumo installs the hooks a little differently: Claude Code no longer waits for Lumo, except to ask for a permission. Reinstall them to get it."),
      }));
    }
    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: t("lumo-hook.exe is not in place yet. Restart Lumo; if it still fails, build it with `cargo build -p lumo-hook`."),
      }));
    }

    const actions = h("div", { class: "row end" });
    const install = h("button", {
      class: "primary",
      text: status.installed ? t("Reinstall hooks…") : t("Install hooks…"),
      onclick: () => void reviewChange(body, HOOKS_CHANGE, true, redraw, () => void rebuild()),
    });
    // Writing hook commands that point at a relay which isn't there would give
    // every Claude Code session a broken hook and nothing to show for it.
    if (!status.hookReady) {
      install.disabled = true;
      install.title = t("The relay isn't installed yet.");
    }
    actions.append(install);
    if (status.installed) {
      actions.append(h("button", {
        class: "danger",
        text: t("Uninstall hooks…"),
        onclick: () => void reviewChange(body, HOOKS_CHANGE, false, redraw, () => void rebuild()),
      }));
    }
    body.append(actions);
  }

  draw();
  return section;
}

// ── Background sessions section ───────────────────────────────────────────────

/** Sessions another program starts on its own (core/background.ts). */
const BACKGROUND_SETTINGS_TEXT = {
  get title() { return t("Background sessions"); },
  get intro() {
    return t("Sessions another program starts on its own, not you: Claude Code run with ‑p or through the Agent SDK, or any agent started with LUMO_BACKGROUND=1. Grouped, each program gets one row, with no sound or alert for every answer and one notice when it is done. Permission requests always come up.");
  },
  get show() { return t("Show them"); },
  get grouped() { return t("Grouped"); },
  get single() { return t("One by one"); },
  get hidden() { return t("Hidden"); },
};

function backgroundSection(): HTMLElement {
  const menu = select(
    [
      ["grouped", BACKGROUND_SETTINGS_TEXT.grouped],
      ["single", BACKGROUND_SETTINGS_TEXT.single],
      ["hidden", BACKGROUND_SETTINGS_TEXT.hidden],
    ],
    parseBackgroundMode(settings.backgroundSessions),
    (v) => { settings.backgroundSessions = v; void save(); },
  );
  return h("section", {},
    ...sectionHead(BACKGROUND_SETTINGS_TEXT.title, BACKGROUND_SETTINGS_TEXT.intro),
    h("div", { class: "setting-list" }, setting(BACKGROUND_SETTINGS_TEXT.show, null, menu)));
}

// ── Plan usage section ────────────────────────────────────────────────────────

/**
 * The 5-hour and weekly limits in the island's header. They come from Claude
 * Code's status line, so the relay has to be the status line first: turning the
 * switch on without it starts the install, and the switch only stays on once
 * that has been confirmed. A status line the user had keeps working.
 */
const PLAN_SETTINGS_TEXT = {
  get claude() { return t("Shows your Claude plan's 5-hour and weekly limits in the island's header, through a status line relay in ~/.claude/settings.json. A status line you already have keeps working. Pro and Max plans only."); },
  get showClaude() { return t("Show in the island"); },
  get claudeTitle() { return t("Claude plan"); },
  get codex() { return t("Shows your Codex plan's weekly limit in the island's header, asked from the Codex CLI; nothing is installed. Codex must be signed in with ChatGPT."); },
  get showCodex() { return t("Show Codex plan in the island"); },
  get antigravity() { return t("Shows your Antigravity CLI quotas (5-hour and weekly) in the island's header, asked from agy as its /usage does; nothing is installed. agy must be signed in with your Google account."); },
  get showAntigravity() { return t("Show Antigravity CLI usage in the island"); },
};

function planSection(status: HookStatus, connected: Record<string, boolean>): HTMLElement {
  const body = h("div", { class: "setting-list" });
  const section = h("section", {}, ...sectionHead(t("Plan usage")), body);

  const redraw = () => {
    clear(body);
    draw();
  };
  const rebuild = async () => {
    const fresh = await Bridge.hooksStatus();
    if (fresh) Object.assign(status, fresh);
    settings.planRelayInstalled = status.planRelayInstalled;
    // Cancelled or failed: a switch that was waiting for the install falls back.
    if (!status.planRelayInstalled) settings.showPlanInNotch = false;
    redraw();
  };

  /** Codex's or agy's switch: on by itself once the agent is added, until turned off here. */
  function agentPlanToggle(kind: "codex" | "antigravity"): HTMLElement {
    return toggle(agentPlanOn(kind, settings, connected[PLAN_AGENT[kind]] ?? false), (on) => {
      if (kind === "codex") settings.showCodexPlanInNotch = on;
      else settings.showAntigravityPlanInNotch = on;
      const others = (settings.hiddenPlanPills ?? []).filter((k) => k !== kind);
      settings.hiddenPlanPills = on ? others : [...others, kind];
      void save();
    });
  }

  function draw() {
    // The switch shows "on" while the install it asked for is being reviewed.
    const sw = toggle(settings.showPlanInNotch, (on) => {
      if (!on) {
        settings.showPlanInNotch = false;
        void save();
      } else if (status.planRelayInstalled) {
        settings.showPlanInNotch = true;
        void save();
      } else {
        // Turned on before the relay is in: install it first; it stays on once confirmed.
        void reviewChange(body, STATUS_LINE_CHANGE, true, () => void rebuild(), () => {
          settings.planRelayInstalled = true;
          settings.showPlanInNotch = true;
          void save().then(rebuild);
        });
      }
    });
    body.append(
      group(PLAN_SETTINGS_TEXT.claudeTitle),
      setting(PLAN_SETTINGS_TEXT.showClaude, PLAN_SETTINGS_TEXT.claude, sw),
      setting(h("span", { class: "with-dot" }, t("Relay"), statusDot(status.planRelayInstalled)),
        status.planRelayInstalled ? t("installed") : t("not installed"),
        status.planRelayInstalled
          ? h("button", {
              class: "danger",
              text: t("Uninstall relay…"),
              onclick: () => void reviewChange(body, STATUS_LINE_CHANGE, false, redraw, () => void rebuild()),
            })
          : h("button", {
              class: "primary",
              text: t("Install relay…"),
              onclick: () => void reviewChange(body, STATUS_LINE_CHANGE, true, redraw, () => void rebuild()),
            }),
      ),
      setting(t("Ask Anthropic"),
        t("Lumo asks Anthropic for your plan's usage every 3 minutes while the island is open, as /usage does, so it shows outside the terminal too. Claude Code's sign-in is only read, never kept."),
        toggle(settings.planUsageOnline, (on) => {
          settings.planUsageOnline = on;
          void save();
        })),
      // Codex: nothing to install, Lumo asks the Codex CLI when the pill shows.
      group("Codex"),
      setting(PLAN_SETTINGS_TEXT.showCodex, PLAN_SETTINGS_TEXT.codex,
        agentPlanToggle("codex"),
      ),
      // Antigravity CLI: the same, Lumo asks agy when the pill shows.
      group("Antigravity CLI"),
      setting(PLAN_SETTINGS_TEXT.showAntigravity, PLAN_SETTINGS_TEXT.antigravity,
        agentPlanToggle("antigravity"),
      ),
    );
  }

  draw();
  return section;
}

// ── Claude API section ────────────────────────────────────────────────────────

const MODELS: [string, string][] = [
  ["claude-fable-5-2", "Claude Fable 5.2"],
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["claude-haiku-5-5", "Claude Haiku 5.5"],
];

/** What Claude Code runs: its own default, or one of the current models. */
const CLAUDE_CODE_MODELS: [string, string][] = [
  ["default", N_("Default")],
  ["claude-fable-5-2", "Fable 5.2"],
  ["claude-opus-5-5", "Opus 5.5"],
  ["claude-sonnet-5-5", "Sonnet 5.5"],
  ["claude-haiku-5-5", "Haiku 5.5"],
];

const NO_KEY = N_("No key yet. Only the Anthropic API needs one: Claude Code uses your Claude plan.");

function apiSection(hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const state = h("span", { text: hasKey ? t("Key saved in the {store}.", { store: KEY_STORE }) : t(NO_KEY) });

  const field = h("input", {
    type: "password",
    placeholder: hasKey ? `••••••••••••  ${t("(stored)")}` : "sk-ant-...",
    style: "flex:1 1 auto;min-width:0",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;

  const saveBtn = h("button", { class: "primary", text: t("Save key") });
  const clearBtn = h("button", { class: "danger", text: t("Remove") });
  const feedback = h("div", {});

  async function refresh() {
    const present = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
    dot.style.background = present ? "#22c55e" : "#f4505e";
    state.textContent = present
      ? t("Key saved in the {store}.", { store: KEY_STORE })
      : t(NO_KEY);
    field.placeholder = present ? `••••••••••••  ${t("(stored)")}` : "sk-ant-...";
    clearBtn.style.display = present ? "" : "none";
  }

  saveBtn.addEventListener("click", async () => {
    const value = field.value.trim();
    if (!value) return;
    clear(feedback);
    try {
      await Bridge.secretSet("anthropic-api-key", value);
      field.value = "";
      feedback.append(h("div", { class: "notice ok", text: t("Saved. It never touches disk.") }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: t("Could not save: {error}", { error: String(err) }) }));
    }
  });

  clearBtn.addEventListener("click", async () => {
    clear(feedback);
    try {
      await Bridge.secretClear("anthropic-api-key");
      feedback.append(h("div", { class: "notice ok", text: t("Key removed.") }));
      await refresh();
    } catch (err) {
      feedback.append(h("div", { class: "notice err", text: t("Could not remove: {error}", { error: String(err) }) }));
    }
  });

  const model = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of MODELS) model.append(h("option", { value: id, text: label }));
  if (!MODELS.some(([id]) => id === settings.model)) {
    model.append(h("option", { value: settings.model, text: settings.model }));
  }
  model.value = settings.model;
  model.addEventListener("change", () => {
    settings.model = model.value;
    void save();
  });

  clearBtn.style.display = hasKey ? "" : "none";

  // Claude Code needs no key: it runs with the plan the user signed in with.
  const ccModel = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of CLAUDE_CODE_MODELS) ccModel.append(h("option", { value: id, text: t(label) }));
  const ccSaved = settings.chatModels["claude-code"] || "default";
  if (!CLAUDE_CODE_MODELS.some(([id]) => id === ccSaved)) {
    ccModel.append(h("option", { value: ccSaved, text: ccSaved }));
  }
  ccModel.value = ccSaved;
  ccModel.addEventListener("change", () => {
    settings.chatModels = { ...settings.chatModels, "claude-code": ccModel.value };
    void save();
  });

  return h(
    "section",
    {},
    ...sectionHead("Claude", null, dot),
    setting("Claude Code", t("Uses your Claude plan. No key needed."), ccModel),
    wideSetting(t("API key"), state, field, saveBtn, clearBtn),
    setting(t("Model"), null, model),
    feedback,
  );
}

// ── Antigravity CLI, Codex, Copilot CLI and Cursor CLI sections ──────────────

/** How to get Copilot CLI and Cursor CLI, while they aren't on this PC (acp_chat.rs). */
const COPILOT_MISSING = N_("Not on this PC yet: install it with npm install -g @github/copilot, then run copilot once in a terminal to sign in.");
const CURSOR_MISSING = N_("Not on this PC yet: install it from cursor.com/cli, then run cursor-agent login once in a terminal to sign in.");

/**
 * Antigravity CLI, Codex, Copilot CLI and Cursor CLI need no key either:
 * each runs with the account signed in to it, Google's for `agy`
 * (antigravity_cli.rs), ChatGPT's for `codex` (codex_chat.rs), GitHub's for
 * `copilot` and Cursor's for `cursor-agent` (acp_chat.rs). Their models come
 * from the CLI itself (`agy models`, Codex's `model/list`, what a new ACP
 * session offers), asked only once the list is opened.
 */
function cliSection(id: "antigravity-cli" | "codex" | "copilot-cli" | "cursor-cli", note: string, missing?: string): HTMLElement {
  const p = providerDef(id);
  // Copilot CLI and Cursor CLI say how to get them while they aren't on this PC.
  const absent = h("p", { class: "hint", text: missing ? t(missing) : "" });
  absent.hidden = true;
  if (missing) Bridge.chatProviders().then((ready) => { if (ready) absent.hidden = ready.includes(id); }, () => {});
  const model = h("select", {}) as HTMLSelectElement;
  const fill = (offered: { id: string; label: string }[]) => {
    const saved = settings.chatModels[p.id] || "default";
    const list = offered.some((m) => m.id === "default") ? offered : [{ id: "default", label: t("Default") }, ...offered];
    clear(model);
    for (const m of list) model.append(h("option", { value: m.id, text: m.label }));
    if (!list.some((m) => m.id === saved)) model.append(h("option", { value: saved, text: saved }));
    model.value = saved;
  };
  fill([]);
  let asked = false;
  const ask = () => {
    if (asked) return;
    asked = true;
    // Not installed or not signed in: "Default" stays, and the chat says why.
    Bridge.chatModels(p.id).then(fill, () => {});
  };
  model.addEventListener("focus", ask);
  model.addEventListener("pointerdown", ask);
  model.addEventListener("change", () => {
    settings.chatModels = { ...settings.chatModels, [p.id]: model.value };
    void save();
  });
  // Off, the CLI leaves the chat's providers; the chat in use moves to another one.
  const shown = toggle(!isHidden(settings, p.id), async (on) => {
    const rest = (settings.hiddenChatProviders ?? []).filter((x) => x !== p.id);
    settings.hiddenChatProviders = on ? rest : [...rest, p.id];
    if (!on && settings.chatProvider === p.id) {
      const ready = await Bridge.chatProviders();
      const next = visibleProviders(settings, Array.isArray(ready) ? new Set(ready) : null).find((x) => x.id !== p.id);
      if (next) settings.chatProvider = next.id;
    }
    void save();
  });

  return h(
    "section",
    {},
    ...sectionHead(p.name, null, accentDot(p.accent)),
    setting(t("Show in the chat"), t("Off, it leaves the chat's list of providers. Nothing is uninstalled."), shown),
    setting(t("Model"), t(note), model),
    absent,
  );
}

// ── Active pills section ──────────────────────────────────────────────────────

/**
 * The tools you use: pick the main workspace tool, which is
 * always on and takes no slot, and declare the agents and chat providers you
 * want as pills. Services are declared in Integrations below, next to their keys.
 */
function activePillsSection(connected: Record<string, boolean>): HTMLElement {
  const slots = h("div", { class: "hint" });
  const main = h("select", {}) as HTMLSelectElement;
  for (const def of mainPillChoices()) main.append(h("option", { value: def.id, text: def.name }));
  main.addEventListener("change", () => {
    const next = chooseMainPill(settings, main.value);
    if (!next) return;
    settings.mainPill = next.mainPill;
    settings.activeIntegrations = next.activeIntegrations;
    declaredChanged();
  });
  const groups = h("div", { style: "display:flex;flex-direction:column;gap:12px" });

  /** Why a pill would show nothing yet. */
  function hint(def: PillDefinition): string | null {
    if (def.connect.kind === "hooks" && !connected[def.id]) return t("Hooks not installed");
    if (def.connect.kind === "key" && !connected[def.id] && !(def.connect.orSetting && settings[def.connect.orSetting])) {
      return t("Key not configured");
    }
    if (def.connect.kind === "server" && !settings[def.connect.field]) return t("Not connected");
    return null;
  }

  function row(def: PillDefinition): HTMLElement {
    const isMain = def.id === settings.mainPill;
    const on = settings.activeIntegrations.includes(def.id);
    const full = !isMain && !on && settings.activeIntegrations.length >= MAX_ACTIVE;
    const el = h("div", { class: full ? "pill-row full" : "pill-row" },
      colorDot(def, "width:10px;height:10px", () => settings.pillColors, pickColor),
      h("span", { class: "name", text: def.name }),
    );
    if (isMain) {
      el.append(h("span", { class: "state", text: t("Main") }));
      return el;
    }
    const why = hint(def);
    el.append(h("span", { class: "state", text: why ?? "" }));
    const sw = h("button", { class: on ? "switch on" : "switch" }) as HTMLButtonElement;
    sw.disabled = full;
    sw.addEventListener("click", () => {
      const next = toggleDeclared(settings, def.id);
      if (!next) return;
      settings.activeIntegrations = next;
      declaredChanged();
    });
    el.append(sw);
    return el;
  }

  function draw() {
    const used = settings.activeIntegrations.length;
    slots.textContent = t("{used}/{max} slots in use — the main tool doesn't take one.", { used, max: MAX_ACTIVE });
    slots.classList.toggle("full", used >= MAX_ACTIVE);
    main.value = settings.mainPill;
    clear(groups);
    for (const cat of PILL_CATEGORIES) {
      if (cat.id === "service") continue;
      const pills = availablePills().filter((p) => p.category === cat.id);
      if (pills.length === 0) continue;
      groups.append(h("div", { class: "pill-group" }, h("h3", { text: t(cat.title) }), ...pills.map(row)));
    }
  }
  declaredViews.push(draw);
  draw();

  return h(
    "section",
    {},
    ...sectionHead(t("Active pills"), t("Choose the tools you use. Lumo only shows what you declare here.")),
    setting(t("Main tool"), slots, main),
    groups,
  );
}

// ── Chat providers section ────────────────────────────────────────────────────

const CHAT_STRINGS = {
  get providersTitle() { return t("Chat providers"); },
  get providersHint() { return t("Chat with Google AI, OpenAI or OpenRouter: add a key here, then pick the model above the chat box. Keys stay in the system keychain. These providers can only answer, never act on this computer."); },
  get stored() { return `••••••••  ${t("(stored)")}`; },
  get save() { return t("Save"); },
  get remove() { return t("Remove"); },
  get localTitle() { return t("Local models"); },
  get localHint() { return t("Chat with a model you run yourself: Ollama, LM Studio or any OpenAI-compatible server (vLLM, llama.cpp…). Leave the address empty for the usual one on this computer."); },
  get connect() { return t("Connect"); },
  get connecting() { return t("Connecting…"); },
  get disconnect() { return t("Disconnect"); },
  get useInChat() { return t("Use in chat"); },
  get inUse() { return t("In use"); },
  get keyOptional() { return t("API key (optional)"); },
  get localOnly() { return t("Nothing leaves your PC: the server runs on this computer."); },
  get remote() { return t("This address is another machine: what you ask is sent to it."); },
  get remoteHttp() { return t("This address is another machine, over plain http: what you ask travels unencrypted."); },
  get keyOverHttp() { return t("Warning: the key would be sent unencrypted (http://) to another machine. Use https://, or a server on this computer."); },
  get invalid() { return t("Not a valid http:// or https:// address."); },
  noModels: (name: string) => t("No models yet. Download one in {name} first.", { name }),
  models: (n: number) => tn("{count} model", "{count} models", n),
};

interface CloudDef {
  id: "google" | "openai" | "openrouter";
  name: string;
  placeholder: string;
  where: string;
}

const CLOUD: CloudDef[] = [
  { id: "google", name: "Google AI", placeholder: "AIza…", where: "aistudio.google.com" },
  { id: "openai", name: "OpenAI", placeholder: "sk-…", where: "platform.openai.com" },
  { id: "openrouter", name: "OpenRouter", placeholder: "sk-or-…", where: "openrouter.ai/keys" },
];

function chatProvidersSection(
  present: Record<string, boolean>,
  keyChanged: (key: string, on: boolean) => void,
): HTMLElement {
  const list = h("div", {});
  for (const def of CLOUD) {
    const p = providerDef(def.id);
    const key = p.key!;
    const input = h("input", {
      type: "password",
      placeholder: present[key] ? CHAT_STRINGS.stored : def.placeholder,
      autocomplete: "off",
      spellcheck: "false",
      style: "flex:1 1 auto;min-width:0",
    }) as HTMLInputElement;
    const dotEl = statusDot(present[key] ?? false);
    const saveBtn = h("button", { text: CHAT_STRINGS.save });
    const removeBtn = h("button", { class: "danger", text: CHAT_STRINGS.remove });
    const refresh = () => {
      input.placeholder = present[key] ? CHAT_STRINGS.stored : def.placeholder;
      dotEl.style.background = present[key] ? "#22c55e" : "#f4505e";
      removeBtn.style.display = present[key] ? "" : "none";
    };
    saveBtn.addEventListener("click", async () => {
      const value = input.value.trim();
      if (!value) return;
      try {
        await Bridge.secretSet(key, value);
        present[key] = true;
        input.value = "";
        keyChanged(key, true);
      } catch {
        dotEl.style.background = "#f5a524";
        return;
      }
      refresh();
    });
    removeBtn.addEventListener("click", async () => {
      try {
        await Bridge.secretClear(key);
        present[key] = false;
        keyChanged(key, false);
      } catch {
        dotEl.style.background = "#f5a524";
        return;
      }
      refresh();
    });
    refresh();
    list.append(
      wideSetting(h("span", { class: "with-dot" }, accentDot(p.accent), def.name, dotEl),
        t("Key from {site}", { site: def.where }),
        input, saveBtn, removeBtn),
    );
  }
  return h(
    "section",
    {},
    ...sectionHead(CHAT_STRINGS.providersTitle, CHAT_STRINGS.providersHint),
    ...list.children,
  );
}

// ── Remaining usage in the chat ───────────────────────────────────────────────

/** The quiet line next to the chat's model picker (core/chat-usage.ts). Off until turned on. */
function chatUsageSection(): HTMLElement {
  return h(
    "section",
    {},
    ...sectionHead(t("Remaining usage")),
    setting(t("Show remaining usage in the chat"),
      t("A ring next to the past chats shows how much the provider in use has used; a click shows each limit and when it resets. For Claude Code it needs the relay from {path}. Nothing is shown for Google or the local models.", { path: `${t("Agents")} → ${t("Plan usage")}` }),
      toggle(settings.chatShowUsage, (on) => {
        settings.chatShowUsage = on;
        void save();
      }),
    ),
  );
}

// ── Security ─────────────────────────────────────────────────────────────────

const SECURITY = {
  get title() { return t("Security"); },
  get intro() { return t("What the AI may see and do on its own. Lumo never approves a permission or sends anything for you without your click."); },
  get onItsOwn() { return t("What it may do on its own"); },
  get permissions() { return t("Default permissions"); },
  get permissionsHint() { return t("How free Claude Code, Codex and Antigravity CLI are in the chat. The shield in the chat changes it too."); },
  get computerHint() { return t("Only while it answers: the screen it uses glows, and Esc stops it. With Ask every time, each click waits for yours."); },
  get webHint() { return t("For the models that can't search on their own. Free, no account: only the useful passages reach the model."); },
  get sees() { return t("What it sees with every message"); },
  get seesHint() { return t("Only the chat's AI gets them. The × on a chip leaves one out of a single message."); },
  get windows() { return t("Open windows"); },
  get windowsHint() { return t("Their titles and the documents they show."); },
  get folders() { return t("File Explorer folders"); },
  get foldersHint() { return t("The open folders and the list of their files."); },
  get tabs() { return t("Browser tabs"); },
  get tabsHint() { return t("The tabs open in your browsers."); },
  get accounts() { return t("Your accounts"); },
  get mailHint() { return t("At first the AI may only read. If you let it send, each email waits for your click on its card. Nothing is ever deleted for good."); },
  get calendarHint() { return t("Read your coming events, or nothing."); },
  get outlookStart() { return t("Open Outlook if it's closed"); },
  get outlookStartHint() { return t("When Lumo starts, it opens classic Outlook in the background, with no window. If you close it yourself, Lumo doesn't open it again until it next starts."); },
  get githubHint() { return t("Read your pull requests, issues and checks when you ask. Off until you turn it on."); },
  get readAndSend() { return t("Read and send"); },
  get readSendManage() { return t("Read, send and manage"); },
  get readOnly() { return t("Read only"); },
  get noAccess() { return t("No access"); },
  get alwaysOn() { return t("Always on"); },
  get keys() { return t("Keys and passwords stay in Windows Credential Manager, never in a file."); },
  get noData() { return t("No usage data: Lumo talks only to the services you set up."); },
  get pipe() { return t("Only your Windows account can talk to Lumo through the pipe the agents' hooks use."); },
  get updates() { return t("An update is installed only if it matches the one GitHub published."); },
};

/** The chat's permission modes, by the names its shield gives them (views/chat.ts). */
const PERMISSION_NAMES: Record<string, string> = {
  default: N_("Ask every time"), auto: N_("Auto"), plan: N_("Plan only"),
};

/** Lumo's own web search (web_search.rs), for the providers that have none. */
const WEB_SETTINGS = {
  get label() { return t("Search the web for the AI"); },
};

/** The images in the chat's answers (views/rich/image.ts, web_image.rs). */
const WEB_IMAGES = {
  get label() { return t("Images from the web"); },
  get hint() { return t("An image in an answer from Wikimedia is shown at once; from any other public https site, after a click on Load image, since the AI writes the address and it could carry what the AI read. An email's images, after a click on Load images: its sender's site then learns it was opened. Off: just its site and a button to open it in the browser."); },
};

const MAIL_IMAGES = {
  get label() { return t("Email images always"); },
  get hint() { return t("An email in the island's Email view shows its images at once, with no click on Load images: its sender's site then learns it was opened. The tracking pixels Lumo recognises are never loaded."); },
};

const COMPUTER_SETTINGS = {
  get label() { return t("Let Claude use the computer"); },
  get claudeOnly() { return t("In the chat, pick Claude Code as the provider to use it."); },
};

/**
 * Settings → Security: what the chat's agents may do on their own (the
 * permissions, computer use, web search), what goes with every message,
 * what the AI may do with the email, the calendar and GitHub, and what Lumo
 * always does without a switch.
 */
function securitySection(): HTMLElement {
  // The one mode every CLI starts from (Antigravity CLI keeps its own, picked in the chat).
  const mode = parsePermissionMode(settings.chatPermissionMode, "claude-code");
  const permissions = select(
    permissionModesFor("claude-code").map((m): [string, string] => [m, t(PERMISSION_NAMES[m])]),
    mode,
    (v) => { settings.chatPermissionMode = v; void save(); },
  );
  const access = (value: string, onChange: (v: string) => void, send = false) => select(
    [
      ...(send ? [["manage", SECURITY.readSendManage], ["send", SECURITY.readAndSend]] as [string, string][] : []),
      ["read", SECURITY.readOnly],
      ["none", SECURITY.noAccess],
    ],
    send && (value === "send" || value === "manage") ? value : aiReads(value) ? "read" : "none",
    onChange,
  );
  const mailAccess = access(settings.aiMailAccess, (v) => { settings.aiMailAccess = v; void save(); }, true);
  const calendarAccess = access(settings.aiCalendarAccess, (v) => { settings.aiCalendarAccess = v; void save(); });
  const githubAccess = access(settings.aiGithubAccess === "read" ? "read" : "none", (v) => { settings.aiGithubAccess = v; void save(); });
  // The section's menus, one width, one under the other.
  for (const menu of [permissions, mailAccess, calendarAccess, githubAccess]) menu.classList.add("security-select");
  // An email's images at once: only with the images from the web on.
  const mailImages = setting(MAIL_IMAGES.label, MAIL_IMAGES.hint,
    toggle(settings.mailImagesAlways === true, (on) => { settings.mailImagesAlways = on; void save(); }),
  );
  mailImages.hidden = settings.webImages === false;
  const note = h("p", { class: "hint", text: COMPUTER_SETTINGS.claudeOnly });
  const showNote = () => {
    note.hidden = !(settings.chatComputerUse && settings.chatProvider !== "claude-code");
  };
  showNote();
  return h(
    "section",
    {},
    ...sectionHead(SECURITY.title, SECURITY.intro),
    group(SECURITY.onItsOwn),
    setting(SECURITY.permissions, SECURITY.permissionsHint, permissions),
    setting(COMPUTER_SETTINGS.label, SECURITY.computerHint,
      toggle(settings.chatComputerUse === true, (on) => {
        settings.chatComputerUse = on;
        showNote();
        void save();
      }),
    ),
    note,
    setting(WEB_SETTINGS.label, SECURITY.webHint,
      toggle(settings.chatWebSearch === true, (on) => { settings.chatWebSearch = on; void save(); }),
    ),
    setting(WEB_IMAGES.label, WEB_IMAGES.hint,
      toggle(settings.webImages !== false, (on) => {
        settings.webImages = on;
        mailImages.hidden = !on;
        void save();
      }),
    ),
    mailImages,
    group(SECURITY.sees),
    h("p", { class: "hint group-hint", text: SECURITY.seesHint }),
    setting(SECURITY.windows, SECURITY.windowsHint,
      toggle(settings.chatShareOpen !== false, (on) => { settings.chatShareOpen = on; void save(); }),
    ),
    setting(SECURITY.folders, SECURITY.foldersHint,
      toggle(settings.chatShareExplorer, (on) => { settings.chatShareExplorer = on; void save(); }),
    ),
    setting(SECURITY.tabs, SECURITY.tabsHint,
      toggle(settings.chatShareTabs === true, (on) => { settings.chatShareTabs = on; void save(); }),
    ),
    group(SECURITY.accounts),
    setting(t("Email"), SECURITY.mailHint, mailAccess),
    setting(SECURITY.outlookStart, SECURITY.outlookStartHint,
      toggle(settings.outlookStart === true, (on) => { settings.outlookStart = on; void save(); }),
    ),
    setting(t("Calendar"), SECURITY.calendarHint, calendarAccess),
    setting("GitHub", SECURITY.githubHint, githubAccess),
    group(SECURITY.alwaysOn),
    h("ul", { class: "always-on" },
      h("li", { text: SECURITY.keys }),
      h("li", { text: SECURITY.noData }),
      h("li", { text: SECURITY.pipe }),
      h("li", { text: SECURITY.updates }),
    ),
  );
}

// ── Voice: Gemini Live ────────────────────────────────────────────────────────

const THINKING_NAMES: Record<string, string> = { low: N_("Low"), medium: N_("Medium"), high: N_("High") };
/** Claude Code's effort levels, as the chat's picker names them. */
const EFFORT_NAMES: Record<string, string> = {
  low: N_("Low"), medium: N_("Medium"), high: N_("High"), xhigh: N_("Extra high"), max: N_("Max"),
};

function select(options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const el = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of options) el.append(h("option", { value: id, text: label }));
  el.value = value;
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

/**
 * Gemini Live (src/live): the Google AI key (the same one as the chat's), the
 * model, its thinking, its voice, whether it may look at the screen, and who
 * takes what it can't do.
 */
function voiceSection(
  present: Record<string, boolean>,
  keyChanged: (key: string, on: boolean) => void,
  shortcuts: ShortcutsReport | null,
): HTMLElement {
  const key = providerDef("google").key!;
  const input = h("input", {
    type: "password", autocomplete: "off", spellcheck: "false", style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  const dotEl = statusDot(present[key] ?? false);
  const saveBtn = h("button", { text: CHAT_STRINGS.save });
  const removeBtn = h("button", { class: "danger", text: CHAT_STRINGS.remove });
  const refresh = () => {
    input.placeholder = present[key] ? CHAT_STRINGS.stored : "AIza…";
    dotEl.style.background = present[key] ? "#22c55e" : "#f4505e";
    removeBtn.style.display = present[key] ? "" : "none";
  };
  saveBtn.addEventListener("click", async () => {
    const value = input.value.trim();
    if (!value) return;
    try {
      await Bridge.secretSet(key, value);
    } catch {
      dotEl.style.background = "#f5a524";
      return;
    }
    present[key] = true;
    input.value = "";
    keyChanged(key, true);
    // The chat's own Google AI row shows it too, on the next draw.
    void rerender();
  });
  removeBtn.addEventListener("click", async () => {
    try {
      await Bridge.secretClear(key);
    } catch {
      dotEl.style.background = "#f5a524";
      return;
    }
    present[key] = false;
    keyChanged(key, false);
    void rerender();
  });
  refresh();

  const model = parseLiveModel(settings.liveModel);
  const thinkingRow = setting(t(VOICE_SETTINGS.thinking), t(VOICE_SETTINGS.thinkingHint),
    select(THINKING_LEVELS.map((l) => [l, t(THINKING_NAMES[l])]), parseThinking(settings.liveThinking), (v) => {
      settings.liveThinking = v;
      void save();
    }),
  );
  const showThinking = (m: string) => {
    thinkingRow.hidden = m !== LIVE_EXTENDED;
  };
  showThinking(model);

  const { modelRow: helperModelRow, problem: helperProblem, effortRow: helperEffortRow, draw: drawHelper } = helperChoices();
  drawHelper();

  const def = SHORTCUTS.find((s) => s.id === "talkToGemini");
  const binding = shortcuts && def ? effective(def, settings.shortcuts) : null;
  const keys = displayKeys(binding?.keys ?? def?.defaultKeys ?? "Ctrl+Alt+L");

  return h(
    "section",
    {},
    ...sectionHead("Gemini Live", t(VOICE_SETTINGS.hint, { keys }), accentDot("#22d3ee")),
    wideSetting(h("span", { class: "with-dot" }, t(VOICE_SETTINGS.key), dotEl),
      t("Key from {site}", { site: "aistudio.google.com" }),
      input, saveBtn, removeBtn),
    setting(t(VOICE_SETTINGS.model), null,
      select([[LIVE_MODEL, "Gemini 3.8 Live"], [LIVE_EXTENDED, "Gemini 3.8 Live Extended Thinking"]], model, (v) => {
        settings.liveModel = v;
        showThinking(v);
        void save();
      }),
    ),
    thinkingRow,
    setting(t(VOICE_SETTINGS.voice), null,
      select([["", t(VOICE_SETTINGS.automatic)], ...VOICES.map((v): [string, string] => [v, v])], parseVoice(settings.liveVoice), (v) => {
        settings.liveVoice = v;
        void save();
      }),
    ),
    setting(t(VOICE_SETTINGS.screen), t(VOICE_SETTINGS.screenHint),
      toggle(settings.liveScreen, (on) => {
        settings.liveScreen = on;
        void save();
      }),
    ),
    setting(t(VOICE_SETTINGS.helper), t(VOICE_SETTINGS.helperHint),
      select([["claude-code", "Claude Code"], ["antigravity-cli", "Antigravity CLI"]], helperId(), (v) => {
        settings.liveHelper = v;
        // Each helper has its own models: the new one starts on its own choice.
        settings.liveHelperModel = "default";
        void save();
        drawHelper();
      }),
    ),
    helperModelRow,
    helperProblem,
    helperEffortRow,
  );
}

const helperId = () => (settings.liveHelper === "antigravity-cli" ? "antigravity-cli" : "claude-code");

/**
 * The helper's model and effort (Settings → Voice): the models the chat's
 * picker offers for that helper, asked only when this page is drawn (agy
 * lists its own); the effort for Claude Code only, as in the chat.
 */
function helperChoices(): { modelRow: HTMLElement; problem: HTMLElement; effortRow: HTMLElement; draw: () => void } {
  const models = h("select", {}) as HTMLSelectElement;
  const efforts = h("select", {}) as HTMLSelectElement;
  const modelRow = setting(t(VOICE_SETTINGS.helperModel), null, models);
  const effortRow = setting(t(VOICE_SETTINGS.helperEffort), null, efforts);
  const problem = h("div", { class: "notice warn" });
  models.addEventListener("change", () => {
    settings.liveHelperModel = models.value;
    void save();
  });
  efforts.addEventListener("change", () => {
    settings.liveHelperEffort = efforts.value;
    void save();
  });
  let ticket = 0;

  const fill = (list: ModelInfo[]) => {
    clear(models);
    const saved = settings.liveHelperModel || "default";
    const all = list.some((m) => m.id === saved) ? list : [...list, { id: saved, label: saved }];
    for (const m of all) models.append(h("option", { value: m.id, text: m.id === "default" ? t("Default") : m.label }));
    models.value = saved;
  };

  const draw = () => {
    const id = helperId();
    const mine = ++ticket;
    problem.hidden = true;
    fill([{ id: "default", label: t("Default") }]);
    models.disabled = true;
    void Bridge.chatModels(id).then(
      (list) => {
        if (mine !== ticket) return;
        models.disabled = false;
        fill(list.length ? list : [{ id: "default", label: t("Default") }]);
      },
      (err) => {
        if (mine !== ticket) return;
        models.disabled = false;
        problem.textContent = String(err).replace(/^Error:\s*/, "");
        problem.hidden = false;
      },
    );
    const levels = effortsFor(id);
    effortRow.hidden = levels.length === 0;
    clear(efforts);
    for (const e of levels) efforts.append(h("option", { value: e, text: e ? t(EFFORT_NAMES[e] ?? e) : t("Auto") }));
    efforts.value = effortFor(id, settings.liveHelperEffort);
  };
  return { modelRow, problem, effortRow, draw };
}

// ── Local models section ──────────────────────────────────────────────────────

type LocalId = "ollama" | "lmstudio" | "unsloth" | "custom";
/** The servers that take a key, and its credential store entry. */
const KEYED: Partial<Record<LocalId, string>> = { custom: CUSTOM_SERVER_KEY, unsloth: UNSLOTH_SERVER_KEY };

/** Redraws the local models section after a change made elsewhere (the island). */
let localRedraw: (() => void) | null = null;

/** Unsloth Studio's key field: its sk-unsloth key, from its Settings → API. */
const UNSLOTH_KEY_HINT = N_("Its key, sk-unsloth-… (Unsloth Studio → Settings → API)");

const LOCAL: Record<LocalId, { name: string; usual: string }> = {
  ollama: { name: "Ollama", usual: "http://127.0.0.1:11434" },
  lmstudio: { name: "LM Studio", usual: "http://127.0.0.1:1234" },
  // Its port is the one `unsloth run` prints: 8888, else 8000 (both are tried).
  unsloth: { name: "Unsloth Studio", usual: "http://127.0.0.1:8888" },
  // No usual address: any server that speaks the OpenAI API.
  custom: { name: N_("OpenAI-compatible"), usual: "" },
};

/** What an address means for the user's data, as a hint line. */
function exposureNotice(url: string, withKey: boolean): HTMLElement | null {
  switch (urlExposure(url)) {
    case "local":
      return h("div", { class: "hint", text: CHAT_STRINGS.localOnly });
    case "remote":
      return h("div", { class: "hint", text: CHAT_STRINGS.remote });
    case "remote-http":
      return withKey
        ? h("div", { class: "notice warn", text: CHAT_STRINGS.keyOverHttp })
        : h("div", { class: "hint", text: CHAT_STRINGS.remoteHttp });
    case "invalid":
      return url.trim() ? h("div", { class: "notice err", text: CHAT_STRINGS.invalid }) : null;
  }
}

/** A local model's chat compacted by itself when its context is nearly full (views/chat.ts). */
const AUTO_COMPACT = {
  get label() { return t("Compact by itself when the context is full"); },
  get hint() { return t("Over 80 %, before the question goes: the model starts again from a summary of the chat."); },
};

/** Unsloth Studio started and stopped by Lumo (unsloth_studio.rs). */
const UNSLOTH_START = {
  label: N_("Start and stop it by itself"),
  hint: N_("When you pick it in the chat, Lumo starts Unsloth Studio in the background, with no window."),
  notInstalled: N_("Not found on this computer: install Unsloth Studio first."),
  notHere: N_("Only for Unsloth Studio on this computer."),
  stopAfter: N_("Stop after"),
  stopAfterHint: N_("Only if Lumo started it: an Unsloth Studio you opened stays on."),
  minutes5: N_("5 minutes with no question"),
  minutes15: N_("15 minutes with no question"),
  hour: N_("1 hour with no question"),
  exit: N_("When Lumo quits"),
  never: N_("Never"),
  off: N_("Off: it starts when you use it in the chat."),
  offPlain: N_("Off."),
  start: N_("Start now"),
  stop: N_("Stop now"),
  starting: N_("Starting Unsloth Studio…"),
  seconds: N_("{seconds} s"),
  ownedAfter: N_("Started by Lumo: it stops after {minutes} minutes with no question."),
  ownedExit: N_("Started by Lumo: it stops when Lumo quits."),
  ownedNever: N_("Started by Lumo: it stays on."),
};

/** Unsloth Studio's address is this computer: the only one Lumo starts. */
function unslothHere(): boolean {
  return urlExposure(settings.unslothUrl) === "local";
}

/** "Start and stop it by itself" and "Stop after", under a connected Unsloth Studio. */
function unslothStartBlock(): HTMLElement {
  const block = h("div", {});
  const hint = h("span", { text: t(UNSLOTH_START.hint) });
  const stopAfter = select(
    [
      ["5", t(UNSLOTH_START.minutes5)],
      ["15", t(UNSLOTH_START.minutes15)],
      ["60", t(UNSLOTH_START.hour)],
      ["exit", t(UNSLOTH_START.exit)],
      ["never", t(UNSLOTH_START.never)],
    ],
    settings.unslothStopAfter || "15",
    (v) => { settings.unslothStopAfter = v; void save().then(() => unslothMemory.refresh()); },
  );
  block.append(
    setting(t(UNSLOTH_START.label), hint, toggle(settings.unslothAutoStart !== false, (on) => {
      settings.unslothAutoStart = on;
      void save().then(() => unslothMemory.refresh());
    })),
    setting(t(UNSLOTH_START.stopAfter), t(UNSLOTH_START.stopAfterHint), stopAfter),
  );
  // Not installed, or connected at another computer's address: said in place of the hint.
  if (!unslothHere()) hint.textContent = t(UNSLOTH_START.notHere);
  else void Bridge.unslothStudioStatus().then((s) => { if (s && !s.installed) hint.textContent = t(UNSLOTH_START.notInstalled); });
  return block;
}

/**
 * The In memory row of Unsloth Studio, while it is off, starting, or on and
 * started by Lumo (local-models.ts asks this for the words and the buttons).
 */
const unslothMemory: UnslothMemory = {
  refresh: () => {},
  async describe(reachable: boolean, live?: UnslothStudio) {
    const s = live ?? (await Bridge.unslothStudioStatus());
    if (!s) return null;
    if (s.state === "starting") {
      const seconds = s.seconds >= 2 ? t(UNSLOTH_START.seconds, { seconds: s.seconds }) : "";
      return { starting: t(UNSLOTH_START.starting), seconds };
    }
    if (reachable) {
      if (!s.owned) return null;
      const after = settings.unslothStopAfter || "15";
      const line = after === "exit" ? t(UNSLOTH_START.ownedExit)
        : after === "never" ? t(UNSLOTH_START.ownedNever)
        : t(UNSLOTH_START.ownedAfter, { minutes: after });
      return { line, stop: t(UNSLOTH_START.stop) };
    }
    // Off, and Lumo can start it: no error, only what happens next.
    if (!s.installed || !unslothHere()) return null;
    return { off: t(settings.unslothAutoStart !== false ? UNSLOTH_START.off : UNSLOTH_START.offPlain), start: t(UNSLOTH_START.start) };
  },
  start: () => Bridge.unslothStudioStart(),
  stop: () => Bridge.unslothStudioStop().then(() => {}),
};

function localSection(keys: Partial<Record<LocalId, boolean>>): HTMLElement {
  const body = h("div", { class: "setting-list" });
  const section = h(
    "section",
    {},
    ...sectionHead(CHAT_STRINGS.localTitle, CHAT_STRINGS.localHint),
    body,
    h("div", { class: "setting-list" },
      setting(AUTO_COMPACT.label, AUTO_COMPACT.hint,
        toggle(settings.chatAutoCompact !== false, (on) => { settings.chatAutoCompact = on; void save(); }),
      ),
    ),
  );
  const redraw = () => {
    clear(body);
    for (const id of Object.keys(LOCAL) as LocalId[]) body.append(serverBlock(id));
  };

  function serverBlock(id: LocalId): HTMLElement {
    const def = LOCAL[id];
    const p = providerDef(id);
    const field = p.urlField!;
    const connected = settings[field] !== "";
    const status = h("div", {});
    const exposure = h("div", {});
    const label = () => h("span", { class: "with-dot" }, accentDot(p.accent), t(def.name));
    const block = h("div", { class: "setting-block" });

    if (connected) {
      const inUse = settings.chatProvider === id;
      const use = h("button", { class: inUse ? "" : "primary", text: inUse ? CHAT_STRINGS.inUse : CHAT_STRINGS.useInChat });
      use.disabled = inUse;
      use.addEventListener("click", () => {
        settings.chatProvider = id;
        void save().then(redraw);
      });
      const disconnect = h("button", { class: "danger", text: CHAT_STRINGS.disconnect });
      disconnect.addEventListener("click", async () => {
        settings[field] = "";
        if (settings.chatProvider === id) settings.chatProvider = "anthropic";
        const entry = KEYED[id];
        if (entry) {
          await Bridge.secretClear(entry).catch(() => {});
          keys[id] = false;
        }
        await save();
        redraw();
      });
      block.append(
        setting(h("span", { class: "with-dot" }, label(), statusDot(true)), h("span", { class: "path", text: settings[field] }), use, disconnect),
        status,
      );
      exposure.append(exposureNotice(settings[field], keys[id] === true) ?? "");
      block.append(exposure);
      // Unsloth Studio on this computer: Lumo starts it when the chat needs it, and stops it.
      if (id === "unsloth") block.append(unslothStartBlock());
      // What Ollama, LM Studio and Unsloth Studio hold in memory (and a model to download where offered).
      if (id === "ollama" || id === "lmstudio" || id === "unsloth") {
        block.append(localModelsBlock(id, id === "unsloth" ? unslothMemory : undefined));
      }
      return block;
    }

    const input = h("input", {
      type: "text",
      placeholder: def.usual || "https://llm.example.com",
      style: "flex:1 1 auto;min-width:0",
      spellcheck: "false",
      autocomplete: "off",
    }) as HTMLInputElement;
    // A custom server may want a key; it goes to the keychain, never to settings.json.
    const key = h("input", {
      type: "password",
      placeholder: keys[id] ? CHAT_STRINGS.stored : id === "unsloth" ? t(UNSLOTH_KEY_HINT) : CHAT_STRINGS.keyOptional,
      style: "flex:1 1 auto;min-width:0",
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    const connect = h("button", { class: "primary", text: CHAT_STRINGS.connect });

    const showExposure = () => {
      clear(exposure);
      const withKey = KEYED[id] !== undefined && (keys[id] === true || key.value.trim() !== "");
      const notice = exposureNotice(input.value || def.usual, withKey);
      if (notice) exposure.append(notice);
    };
    input.addEventListener("input", showExposure);
    key.addEventListener("input", showExposure);

    connect.addEventListener("click", async () => {
      connect.disabled = true;
      clear(status);
      status.append(h("div", { class: "hint", text: CHAT_STRINGS.connecting }));
      try {
        const keyed = id === "custom" || id === "unsloth" ? id : undefined;
        const typedKey = keyed ? key.value.trim() : "";
        if (keyed && typedKey) {
          // Stored with this address: the key is only ever sent there.
          await Bridge.localSetKey(input.value || def.usual, typedKey, keyed);
          key.value = "";
          keys[id] = true;
        }
        const server = await Bridge.localConnect(id, input.value);
        // Found at another address (Unsloth Studio on its other port): the key goes with it.
        if (keyed && typedKey && server.models.length) await Bridge.localSetKey(server.url, typedKey, keyed);
        if (!server.models.length) {
          clear(status);
          status.append(h("div", { class: "notice err", text: CHAT_STRINGS.noModels(t(def.name)) }));
        } else {
          settings[field] = server.url;
          if (!server.models.includes(settings.chatModels[id] ?? "")) {
            settings.chatModels = { ...settings.chatModels, [id]: server.models[0] };
          }
          await save();
          redraw();
          return;
        }
      } catch (err) {
        clear(status);
        status.append(h("div", { class: "notice err", text: String(err).replace(/^Error:\s*/, "") }));
      }
      connect.disabled = false;
    });

    block.append(wideSetting(label(), null, input, connect));
    if (KEYED[id]) block.append(h("div", { class: "setting-extra" }, key));
    block.append(status, exposure);
    showExposure();
    return block;
  }

  redraw();
  localRedraw = redraw;
  return section;
}

// ── Integrations section ──────────────────────────────────────────────────────

interface IntegrationDef {
  id: string;
  name: string;
  color: string;
  /** Credential Manager keys, in the order they are shown. */
  fields: { key: string; label: string; placeholder: string; secret: boolean }[];
  /** What the key needs, shown under its field. */
  hint?: string;
}

const INTEGRATIONS: IntegrationDef[] = [
  { id: "integration_stripe", name: "Stripe", color: "#0570DE",
    fields: [{ key: "stripe-api-key", label: N_("Secret key"), placeholder: "sk_live_…", secret: true }] },
  { id: "integration_github", name: "GitHub", color: "#F4505E",
    fields: [{ key: "github-token", label: N_("Token"), placeholder: "ghp_…", secret: true }],
    hint: N_("Classic token with the repo scope, or fine-grained with read access to Pull requests, Commit statuses and Actions.") },
  { id: "integration_vercel", name: "Vercel", color: "#7C5CFF",
    fields: [{ key: "vercel-token", label: N_("Token"), placeholder: "…", secret: true }] },
  { id: "integration_n8n", name: "n8n", color: "#F29B38",
    fields: [
      { key: "n8n-url", label: N_("Instance URL"), placeholder: "https://n8n.example.com", secret: false },
      { key: "n8n-api-key", label: N_("API key"), placeholder: "…", secret: true },
    ] },
  { id: "integration_resend", name: "Resend", color: "#22C55E",
    fields: [{ key: "resend-api-key", label: N_("API key"), placeholder: "re_…", secret: true }] },
  { id: "integration_notion", name: "Notion", color: "#8C8C8C",
    fields: [{ key: "notion-api-key", label: N_("Integration token"), placeholder: "ntn_…", secret: true }] },
  { id: "integration_calcom", name: "Cal.com", color: "#C9956A",
    fields: [{ key: "calcom-api-key", label: N_("API key"), placeholder: "cal_…", secret: true }] },
  // The inbox over IMAP (mail.rs), and the classic Outlook on this PC (outlook.rs): mailSourceRows,
  // with the IMAP accounts listed by imapAccounts rather than these fields.
  { id: "integration_mail", name: N_("Email"), color: "#EA4335",
    fields: [],
    hint: N_("New emails show on the closed island. You can use Outlook, IMAP or both together.") },
];

const MAX_ACTIVE = MAX_DECLARED;

/** Everything that shows the declared pills, redrawn when any of them changes. */
const declaredViews: (() => void)[] = [];

function declaredChanged() {
  for (const redraw of declaredViews) redraw();
  void save();
}

function integrationsSection(
  present: Record<string, boolean>,
  keyChanged: (key: string, on: boolean) => void,
): HTMLElement {
  const note = h("p", { class: "section-intro" });
  const list = h("div", { class: "setting-list" });

  function updateNote() {
    const used = settings.activeIntegrations.length;
    note.textContent = t("Pick up to {max} pills to show next to Lumo — {used}/{max} in use. Keys are stored in the {store}, never on disk.", { max: MAX_ACTIVE, used, store: KEY_STORE });
  }
  declaredViews.push(updateNote);

  for (const def of INTEGRATIONS) {
    const active = settings.activeIntegrations.includes(def.id);
    const sw = h("button", { class: active ? "switch on" : "switch" });
    sw.addEventListener("click", () => {
      const on = settings.activeIntegrations.includes(def.id);
      if (on) {
        settings.activeIntegrations = settings.activeIntegrations.filter((x) => x !== def.id);
      } else {
        if (settings.activeIntegrations.length >= MAX_ACTIVE) return;
        settings.activeIntegrations = [...settings.activeIntegrations, def.id];
      }
      sw.classList.toggle("on", !on);
      declaredChanged();
    });

    const rows = h("div", { class: "field-rows" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? CHAT_STRINGS.stored : t(field.placeholder),
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: t("Save") });
      const removeBtn = h("button", { class: "danger", text: CHAT_STRINGS.remove });
      const dotEl = statusDot(present[field.key] ?? false);
      const refresh = () => {
        input.placeholder = present[field.key] ? CHAT_STRINGS.stored : t(field.placeholder);
        dotEl.style.background = present[field.key] ? "#22c55e" : "#f4505e";
        removeBtn.style.display = present[field.key] ? "" : "none";
      };
      // An empty field saves nothing: what is stored goes only with Remove.
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        if (!value) return;
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = true;
          input.value = "";
          refresh();
          keyChanged(field.key, true);
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      removeBtn.addEventListener("click", async () => {
        try {
          await Bridge.secretClear(field.key);
          present[field.key] = false;
          refresh();
          keyChanged(field.key, false);
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      refresh();
      rows.append(
        h("div", { class: "field-row" },
          h("label", { text: t(field.label) }),
          input, saveBtn, removeBtn, dotEl,
        ),
      );
    }

    list.append(
      h("div", { class: "integration" },
        setting(
          // Service names stay as they are ("Resend" is a name, not "send again"); only "Email" is a word.
          h("span", { class: "with-dot" }, colorDot(def, "", () => settings.pillColors, pickColor), def.id === "integration_mail" ? t(def.name) : def.name),
          def.hint ? t(def.hint) : null,
          sw,
        ),
        ...(def.id === "integration_mail" ? mailSourceRows(imapAccounts(keyChanged)) : [rows]),
        def.id === "integration_mail" ? promotionsRow() : null,
      ),
    );
  }

  updateNote();
  return h("section", {}, ...sectionHead(t("Integrations")), note, list);
}

const MAIL_SOURCES = {
  get outlook() { return t("Outlook on this PC"); },
  get outlookHint() { return t("Classic Outlook, already set up: no password."); },
  get account() { return t("Account"); },
  get imapHint() { return t("Gmail, iCloud or another server, with an app password. Gmail's is made at myaccount.google.com/apppasswords, with 2-Step Verification on."); },
  get closed() { return t("Outlook is closed: the emails come back as soon as you open it."); },
  get missing() { return t("Classic Outlook isn't installed on this PC. The new Outlook can't be read by other apps: use IMAP."); },
};

/**
 * `listener` on the window's `type` events while `el` is on the page: each
 * redraw of Settings builds its rows again, and a listener of the rows it
 * replaced goes at its next event instead of piling up (one more Outlook and
 * account check per focus at every redraw).
 */
function whileShown(el: HTMLElement, type: "focus", listener: () => void) {
  const once = () => {
    if (!el.isConnected) {
      window.removeEventListener(type, once);
      return;
    }
    listener();
  };
  window.addEventListener(type, once);
}

/**
 * Settings → Pills → Email's two sources, one switch each: the classic
 * Outlook on this PC with the accounts it has (outlook.rs), and IMAP with its
 * address, app password and server (mail.rs). Both can be on.
 */
function mailSourceRows(imapFields: HTMLElement): HTMLElement[] {
  const found = h("span", { style: "flex:1 1 auto;min-width:0;opacity:.9" });
  const dot = statusDot(false);
  const account = h("div", { class: "field-rows" },
    h("div", { class: "field-row" }, h("label", { text: MAIL_SOURCES.account }), found, dot));
  // What Outlook says now: asked only while it runs, it is never started from here.
  const showOutlook = async () => {
    account.hidden = !settings.mailOutlook;
    if (!settings.mailOutlook) return;
    const status = await Bridge.outlookStatus();
    if (!status) return;
    const running = status.installed && status.running;
    found.textContent = !status.installed ? MAIL_SOURCES.missing
      : !status.running ? MAIL_SOURCES.closed
      : status.accounts.join(", ") || "Outlook";
    found.title = found.textContent;
    found.style.opacity = running ? ".9" : ".6";
    dot.style.background = running ? "#22c55e" : status.installed ? "#8a8f98" : "#f4505e";
  };
  const showImap = () => { imapFields.hidden = !settings.mailImap; };
  void showOutlook();
  showImap();
  whileShown(found, "focus", () => void showOutlook());
  return [
    setting(MAIL_SOURCES.outlook, MAIL_SOURCES.outlookHint,
      toggle(settings.mailOutlook, (v) => { settings.mailOutlook = v; void showOutlook(); void save(); })),
    account,
    setting("IMAP", MAIL_SOURCES.imapHint,
      toggle(settings.mailImap, (v) => { settings.mailImap = v; showImap(); void save(); })),
    imapFields,
  ];
}

/** Settings → Pills → Email → IMAP's words. */
const IMAP_ACCOUNTS = {
  get add() { return t("+ Add an account"); },
  get title() { return t("New IMAP account"); },
  get check() { return t("Check and save"); },
  get checking() { return t("Checking…"); },
  get notSaved() { return t("Nothing was saved."); },
  get defaultTip() { return t("New emails go out from this account. A reply goes out from the account the email came to."); },
  found: (server: string) => t("found from the address: {server}", { server }),
};

/** As many IMAP accounts as mail.rs keeps (MAX_ACCOUNTS). */
const MAX_MAIL_ACCOUNTS = 5;

/** An account's dot: read, refused, paused, or not connected yet. */
const ACCOUNT_DOT: Record<MailAccount["state"], string> = {
  ok: "#22c55e", error: "#f4505e", paused: "#8a8f98", connecting: "#f5a524",
};

/**
 * Settings → Pills → Email → IMAP: the accounts stored (mail.rs), each with
 * its state, a switch that pauses it and Remove; under them, one form to add
 * another, saved only once its server took the address and the password.
 * The first account is the default: a new email goes out of it.
 */
function imapAccounts(keyChanged: (key: string, on: boolean) => void): HTMLElement {
  const box = h("div", { class: "mail-accounts" });
  const list = h("div", { class: "mail-account-list" });
  const addBtn = h("button", { text: IMAP_ACCOUNTS.add });
  const addRow = h("div", { class: "mail-account-add" }, addBtn);
  let shown: MailAccount[] = [];

  const address = h("input", { type: "text", placeholder: "you@gmail.com", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const password = h("input", { type: "password", placeholder: "abcd efgh ijkl mnop", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const server = h("input", { type: "text", placeholder: t("found from the address"), autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const problem = h("div", { class: "mail-account-error" });
  const cancel = h("button", { text: t("Cancel") }) as HTMLButtonElement;
  const checkBtn = h("button", { class: "primary", text: IMAP_ACCOUNTS.check }) as HTMLButtonElement;
  const field = (label: string, input: HTMLElement) => h("div", { class: "field-row" }, h("label", { text: label }), input);
  const form = h("div", { class: "mail-account-form" },
    h("div", { class: "mail-account-form-title", text: IMAP_ACCOUNTS.title }),
    field(t("Address"), address),
    field(t("App password"), password),
    field(t("IMAP server"), server),
    problem,
    h("div", { class: "mail-account-actions" }, cancel, checkBtn),
  );
  form.hidden = true;
  problem.hidden = true;

  const paused = (a: string) => settings.mailPaused.some((p) => p.toLowerCase() === a.toLowerCase());
  const setPaused = (a: string, on: boolean) => {
    const rest = settings.mailPaused.filter((p) => p.toLowerCase() !== a.toLowerCase());
    settings.mailPaused = on ? [...rest, a.toLowerCase()] : rest;
    void save();
  };

  const row = (a: MailAccount, first: boolean): HTMLElement => {
    const line = a.state === "error" && a.error ? `${a.host} · ${a.error}`
      : a.state === "paused" ? `${a.host} · ${t("Paused")}`
      : a.state === "connecting" ? `${a.host} · ${t("Connecting…")}`
      : a.host;
    const chip = first ? h("span", { class: "mail-account-default", text: t("Default"), title: IMAP_ACCOUNTS.defaultTip }) : null;
    const remove = h("button", { class: "danger", text: CHAT_STRINGS.remove }) as HTMLButtonElement;
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await Bridge.mailAccountRemove(a.address);
        if (paused(a.address)) setPaused(a.address, false);
      } catch {
        remove.disabled = false;
        return;
      }
      await refresh();
    });
    const on = !paused(a.address);
    return h("div", { class: on ? "mail-account" : "mail-account off" },
      h("i", { class: "dot", style: `background:${ACCOUNT_DOT[a.state] ?? ACCOUNT_DOT.connecting}` }),
      h("div", { class: "mail-account-text" },
        h("div", { class: "mail-account-name" }, h("span", { class: "mail-account-address", text: a.address, title: a.address }), chip),
        h("span", { class: a.state === "error" ? "mail-account-line bad" : "mail-account-line", text: line, title: line }),
      ),
      toggle(on, (v) => { setPaused(a.address, !v); later(); }),
      remove,
    );
  };

  async function refresh() {
    const accounts = (await Bridge.mailAccounts()) ?? [];
    const had = shown.length > 0;
    shown = accounts;
    list.replaceChildren(...accounts.map((a, i) => row(a, i === 0)));
    list.hidden = accounts.length === 0;
    addRow.hidden = !form.hidden || accounts.length >= MAX_MAIL_ACCOUNTS;
    if (had !== accounts.length > 0) keyChanged("mail-app-password", accounts.length > 0);
  }
  /** The state of a connection that just started, a few seconds on. */
  let timers: number[] = [];
  const later = () => {
    for (const id of timers) clearTimeout(id);
    timers = [1500, 6000, 15000].map((ms) => window.setTimeout(() => void refresh(), ms));
    void refresh();
  };

  const close = () => {
    form.hidden = true;
    problem.hidden = true;
    address.value = password.value = server.value = "";
    server.placeholder = t("found from the address");
    addRow.hidden = shown.length >= MAX_MAIL_ACCOUNTS;
  };
  addBtn.addEventListener("click", () => {
    form.hidden = false;
    addRow.hidden = true;
    address.focus();
  });
  cancel.addEventListener("click", close);
  address.addEventListener("input", async () => {
    const typed = address.value.trim();
    const found = typed.includes("@") ? (await Bridge.mailServerFor(typed)) ?? "" : "";
    if (address.value.trim() !== typed) return;
    server.placeholder = found ? IMAP_ACCOUNTS.found(found) : t("found from the address");
  });
  const submit = async () => {
    if (checkBtn.disabled) return;
    if (!address.value.trim() || !password.value.trim()) {
      (address.value.trim() ? password : address).focus();
      return;
    }
    checkBtn.disabled = cancel.disabled = true;
    checkBtn.textContent = IMAP_ACCOUNTS.checking;
    problem.hidden = true;
    try {
      await Bridge.mailAccountAdd(address.value.trim(), password.value.trim(), server.value.trim());
      close();
      later();
    } catch (err) {
      problem.replaceChildren(h("i", { class: "dot", style: "background:#f4505e" }), h("span", { text: `${errorText(err)} ${IMAP_ACCOUNTS.notSaved}` }));
      problem.hidden = false;
    } finally {
      checkBtn.disabled = cancel.disabled = false;
      checkBtn.textContent = IMAP_ACCOUNTS.check;
    }
  };
  checkBtn.addEventListener("click", () => void submit());
  for (const input of [address, password, server]) {
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") void submit(); });
  }
  whileShown(box, "focus", () => void refresh());
  void refresh();
  box.append(list, form, addRow);
  return box;
}

/** Settings → Pills → Email: the promotional emails left out of the island (mail.rs). */
function promotionsRow(): HTMLElement {
  return setting(
    t("Hide promotional emails"),
    t("On Gmail, the ones in its Promotions tab; with other providers, the ones with an unsubscribe link (newsletters, offers)."),
    toggle(settings.mailHidePromotions, (v) => { settings.mailHidePromotions = v; void save(); }),
  );
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  // The volume as a percentage of its range, beside the bar.
  const percent = h("span", { class: "volume-pct" });
  const showPercent = () => {
    percent.textContent = `${Math.round((Number(volume.value) / 0.2) * 100)}%`;
  };
  showPercent();
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    showPercent();
    void save();
  });

  return h(
    "section",
    {},
    ...sectionHead(t("General")),
    setting(t("Sound"), null,
      volume,
      percent,
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
    ),
    languageRow(),
    setting(t("Launch at startup"), null,
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
    ...energyRows(),
    ...recapRows(),
    ...contextMenuRows(),
  );
}

/** What General → Energy says of the power source, with Automatic. */
const ENERGY_NOW = {
  battery: N_("On battery now: saving energy."),
  realtime: N_("Plugged in now: near real time."),
  usual: N_("Plugged in now: as usual."),
};

/**
 * Settings → General → Energy (core/energy.ts, energy.rs): how hard Lumo
 * works, and with "Automatic" what it does on mains power.
 */
function energyRows(): HTMLElement[] {
  const mode = h("select", {}) as HTMLSelectElement;
  for (const m of ENERGY_MODES) mode.append(h("option", { value: m.id, text: t(m.label) }));
  mode.value = parseEnergyMode(settings.energyMode);
  const onPower = h("select", {}) as HTMLSelectElement;
  for (const m of ENERGY_ON_POWER) onPower.append(h("option", { value: m.id, text: t(m.label) }));
  onPower.value = parseOnPower(settings.energyOnPower);
  const now = h("span", { class: "hint" });
  const powerRow = setting(t("On mains power"), t("with Automatic, what Lumo does while the computer is plugged in; on battery it saves energy"), onPower);
  const redraw = () => {
    const auto = mode.value === "auto";
    powerRow.hidden = !auto;
    const effort = effectiveEffort(mode.value, onPower.value, onBattery);
    now.textContent = !auto ? ""
      : t(onBattery ? ENERGY_NOW.battery : effort === "realtime" ? ENERGY_NOW.realtime : ENERGY_NOW.usual);
  };
  mode.addEventListener("change", () => {
    settings.energyMode = mode.value;
    redraw();
    void save();
  });
  onPower.addEventListener("change", () => {
    settings.energyOnPower = onPower.value;
    redraw();
    void save();
  });
  energyRedraw = redraw;
  redraw();
  return [
    setting(
      t("Energy saving"),
      h("span", {},
        t("How often Lumo checks the inbox, the calendar and the services, and how much he moves on the closed island. Automatic saves energy on battery."),
        h("br"), now),
      mode,
    ),
    powerRow,
  ];
}

/**
 * Settings → General → Right-click menu: what it offers besides Refresh and
 * the text actions, one switch each, in the menu's order.
 */
function contextMenuRows(): HTMLElement[] {
  const items = MENU_ITEMS.map((item) =>
    setting(t(item.label), null, toggle(pickedItems(settings.contextMenu).some((i) => i.id === item.id), (v) => {
      settings.contextMenu = withItem(settings.contextMenu, item.id, v);
      void save();
    })));
  // Named like the other settings of General (Weekly recap…), its switches under it.
  return [
    setting(t("Right-click menu"), t("Pick what the right-click menu on the island offers, besides Refresh (Ctrl+R) and, in a text field, Cut, Copy and Paste.")),
    h("div", { class: "setting-list" }, ...items),
  ];
}

// ── Island section ────────────────────────────────────────────────────────────

/** Where the island lives and how big it is drawn. */
function islandSection(): HTMLElement {
  const screen = h("select", {}) as HTMLSelectElement;
  screen.append(
    h("option", { value: "primary", text: t("Main display") }),
    h("option", { value: "cursor", text: t("Display under the cursor") }),
  );
  screen.value = settings.screen;
  void Bridge.listMonitors().then((list) => {
    for (const m of list ?? []) screen.append(h("option", { value: m.key, text: m.label }));
    // Set again now the option exists. A display saved under an older key (moved,
    // resized, or saved before names were kept) is shown by its place or its
    // name; one that is gone shows as the main one.
    const saved = settings.screen;
    const [place, name] = saved.split("|");
    const keys = (list ?? []).map((m) => m.key);
    screen.value =
      keys.find((k) => k === saved) ??
      (saved.startsWith("at:") ? keys.find((k) => k.split("|")[0] === place) : undefined) ??
      (name ? keys.find((k) => k.split("|")[1] === name) : undefined) ??
      saved;
    if (!screen.value) screen.value = "primary";
  });
  screen.addEventListener("change", () => {
    settings.screen = screen.value;
    void save();
  });

  // How big the island is drawn; Ctrl + / Ctrl − in the island do the same.
  const size = h("select", {}) as HTMLSelectElement;
  for (const pct of [80, 90, 100, 115, 130, 145, 160]) {
    size.append(h("option", { value: String(pct / 100), text: `${pct} %` }));
  }
  const nearest = [...size.options].reduce((best, o) =>
    Math.abs(Number(o.value) - settings.islandZoom) < Math.abs(Number(best.value) - settings.islandZoom) ? o : best);
  size.value = nearest.value;
  size.addEventListener("change", () => {
    settings.islandZoom = Number(size.value);
    void save();
  });

  // How far the island sits from the edge it hangs from.
  const gap = select([
    ["none", t("None")],
    ["light", t("Light (default)")],
    ["medium", t("Medium")],
    ["wide", t("Wide")],
  ], ["none", "medium", "wide"].includes(settings.islandEdgeGap) ? settings.islandEdgeGap : "light", (v) => {
    settings.islandEdgeGap = v;
    void save();
  });
  // How wide the closed island is, the rest of the island as it is.
  const compactW = select([
    ["normal", t("Wide (default)")],
    ["narrower", t("Mid-width")],
    ["narrow", t("Short")],
    ["lumo", t("Just Lumo")],
  ], ["narrower", "narrow", "lumo"].includes(settings.islandCompactWidth) ? settings.islandCompactWidth : "normal", (v) => {
    settings.islandCompactWidth = v;
    void save();
  });
  // The island's icons, against their usual size.
  const icons = h("select", {}) as HTMLSelectElement;
  for (const pct of [100, 125, 150]) {
    icons.append(h("option", { value: String(pct / 100), text: `${pct} %` }));
  }
  icons.value = [...icons.options].reduce((best, o) =>
    Math.abs(Number(o.value) - settings.iconScale) < Math.abs(Number(best.value) - settings.iconScale) ? o : best).value;
  icons.addEventListener("change", () => {
    settings.iconScale = Number(icons.value);
    void save();
  });

  // How much Lumo moves on his own.
  const motion = h("select", {}) as HTMLSelectElement;
  for (const [value, label] of [
    ["calm", N_("Calm")],
    ["lively", N_("Lively")],
    ["still", N_("Only when something happens")],
  ] as const) motion.append(h("option", { value, text: t(label) }));
  motion.value = parseMotion(settings.lumoMotion);
  motion.addEventListener("change", () => {
    settings.lumoMotion = motion.value;
    void save();
  });

  return h(
    "section",
    {},
    ...sectionHead(t("Island")),
    ...behaviourRows(),
    group("Lumo"),
    setting(t("Lumo moves"), null, motion),
    group(t("Position and size")),
    setting(t("Island lives on"), null, screen),
    setting(t("Island size"), null, size),
    setting(t("Closed island width"), t("only the closed island: the text, the icons and the open island keep their size. What it has to say still widens it"), compactW),
    setting(t("Distance from the edge"), t("between the island and the edge of the screen it is docked to. With Medium the mouse can cross the top of the screen above the island without opening it"), gap),
    setting(t("Icon size"), null, icons),
    setting(t("Put the island back in the centre"), null,
      h("button", { text: t("Put back"), onclick: () => void Bridge.islandRecenter() })),
    h("p", { class: "section-note" },
      t("Drag the top bar to move the island: near an edge it docks to it. Drag an edge or a corner to resize it; a double click puts the usual size back.")),
  );
}

/** When the island opens and closes by itself. */
function behaviourRows(): HTMLElement[] {
  const close = h("select", {}) as HTMLSelectElement;
  close.append(
    h("option", { value: "timer", text: t("After a few seconds") }),
    h("option", { value: "leave", text: t("As soon as the mouse leaves") }),
    h("option", { value: "click", text: t("On a click outside the island") }),
    h("option", { value: "never", text: t("Only when I close it") }),
  );
  close.value = parseCloseMode(settings.islandClose);

  const seconds = h("input", {
    type: "number", min: "5", max: "120", step: "1",
    value: String(Math.round(settings.autoCloseInterval)),
    style: "width:72px",
  }) as HTMLInputElement;
  seconds.addEventListener("change", () => {
    settings.autoCloseInterval = Math.max(5, Math.min(120, Number(seconds.value) || 15));
    seconds.value = String(settings.autoCloseInterval);
    void save();
  });
  const secondsHint = h("span", { class: "unit", text: t("seconds after you leave the island") });
  const showSeconds = () => {
    const on = close.value === "timer";
    seconds.style.display = on ? "" : "none";
    secondsHint.style.display = on ? "" : "none";
  };
  showSeconds();
  close.addEventListener("change", () => {
    settings.islandClose = parseCloseMode(close.value);
    showSeconds();
    void save();
  });

  return [
    group(t("Opening and closing")),
    setting(t("Close the open island"), null, close, h("span", { class: "with-unit" }, seconds, secondsHint)),
    setting(t("Open on hover"), t("opens the closed island when the mouse rests on it"),
      toggle(settings.islandHoverOpen, (v) => { settings.islandHoverOpen = v; void save(); })),
    setting(t("Hide when unused"), t("the closed island slips into the edge of the screen a minute after you leave it"),
      toggle(settings.islandAutoHide, (v) => { settings.islandAutoHide = v; void save(); })),
    group(t("The closed island")),
    setting(t("Say what's going on"), t("the closed island says what the AI is doing, and when an answer or an email arrives"),
      toggle(settings.compactActivity, (v) => { settings.compactActivity = v; void save(); })),
    setting(t("Show the music playing"), t("with play, pause and skip, when nothing else is showing"),
      toggle(settings.compactMedia, (v) => { settings.compactMedia = v; void save(); })),
    setting(t("Allow simple requests from the closed island"),
      t("reads and commands that only look (ls, git status…) are answered from the closed island; anything else opens the full card"),
      toggle(settings.quickApprovals !== false, (v) => { settings.quickApprovals = v; void save(); })),
    group(t("Live Activities")),
    googleCalendarRow(),
    calendarRow(),
  ];
}

const GOOGLE_CAL = {
  get hint() {
    return t("Sign in with your Google account: Lumo reads your calendars without changing them, and sees a new event within a minute (within 15 while saving energy). The client and the access stay in the {store}, and Lumo talks only to Google.", { store: KEY_STORE });
  },
  get guideTitle() { return t("Once only: your own Google client (free, about 10 minutes)"); },
  get guide() {
    return [
      t("In Google Cloud Console, create a project, for example “Lumo”."),
      t("APIs & Services → Library → Google Calendar API → Enable."),
      t("OAuth consent screen: External, then Publish app under Audience (in Testing, Google ends the access every 7 days)."),
      t("Clients → Create client → Desktop app, then paste its ID and secret here."),
    ];
  },
  get openConsole() { return t("Open Google Cloud Console"); },
  get clientId() { return t("Client ID"); },
  get clientSecret() { return t("Client secret"); },
  get signIn() { return t("Sign in with Google"); },
  get signInAgain() { return t("Sign in again"); },
  get waiting() { return t("Continue in the browser…"); },
  get waitingHint() { return t("The browser opened: choose the account and allow Lumo to read the calendar."); },
  get mismatch() { return t("Google says redirect_uri_mismatch? The client is not a Desktop app: create one of that type, paste its ID and secret, and sign in again."); },
  get unverified() { return t("Google says it hasn't verified the app? It is your own client: choose Advanced, then go to your project."); },
  get tooMany() { return t("The island reads at most {max} calendars: turn off the ones you don't need.", { max: MAX_GOOGLE_CALENDARS }); },
  get pasteFirst() { return t("Paste your Google client's ID and secret first."); },
  get ended() { return t("Access ended: sign in again."); },
  get pick() { return t("Calendars to show on the island"); },
  get removeClient() { return t("Remove client"); },
  get notRevoked() { return t("Google could not be reached: Lumo no longer uses the access, but to end it at Google too, remove Lumo in your Google account (Security → Third-party connections)."); },
  shown: (shown: number, count: number) => t("Calendars on the island: {shown} of {count}", { shown, count }),
};

/** Where step 1 and 2 of the guide happen: the Calendar API's page, which offers to pick or create a project. */
const GOOGLE_CONSOLE = "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com";

/**
 * Settings → Island → Google Calendar: the user's own OAuth client (a short
 * guide to make one in Google Cloud Console, its ID and secret), the sign-in
 * in the browser (google_calendar.rs), then the account's calendars to pick
 * for the island (settings.googleCalendars, core/google-calendar.ts).
 */
function googleCalendarRow(): HTMLElement {
  const dotEl = statusDot(false);
  const body = h("div", { class: "mail-accounts", style: "flex:1 1 auto;min-width:0" });
  const row = wideSetting(h("span", { class: "with-dot" }, "Google Calendar", dotEl), GOOGLE_CAL.hint, body);
  const sync = new GoogleSync((path, query) => Bridge.googleCalendarGet(path, query));
  let problem = "";
  /** While a sign-in waits for the browser: asks each second whether it ended (here or in another Settings), then draws the row again. */
  let waitTimer: number | null = null;
  /** The status the row was last drawn with. */
  let drawn: GoogleCalendarStatus | null = null;

  const problemLine = () => problem
    ? h("div", { class: "mail-account-error" }, h("i", { class: "dot", style: "background:#f4505e" }), h("span", { text: problem }))
    : null;

  const signIn = async (button: HTMLButtonElement) => {
    button.disabled = true;
    problem = "";
    // The browser opens; the row says what to do there until it comes back.
    window.setTimeout(() => void render(), 300);
    try {
      await Bridge.googleCalendarSignIn();
      sync.reset();
    } catch (err) {
      problem = errorText(err);
    } finally {
      void render();
    }
  };

  const clientForm = (stored: boolean) => {
    const field = (label: string, type: string, placeholder: string) => {
      const input = h("input", { type, placeholder, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
      return { input, row: h("div", { class: "field-row" }, h("label", { text: label }), input) };
    };
    const id = field(GOOGLE_CAL.clientId, "text", stored ? CHAT_STRINGS.stored : "…apps.googleusercontent.com");
    const secret = field(GOOGLE_CAL.clientSecret, "password", stored ? CHAT_STRINGS.stored : "GOCSPX-…");
    const go = h("button", { class: "primary", text: GOOGLE_CAL.signIn }) as HTMLButtonElement;
    go.addEventListener("click", async () => {
      const [idValue, secretValue] = [id.input.value.trim(), secret.input.value.trim()];
      // Empty fields keep what is stored; a new client needs both.
      if ((!idValue || !secretValue) && !(stored && !idValue && !secretValue)) {
        problem = GOOGLE_CAL.pasteFirst;
        void render();
        return;
      }
      try {
        if (idValue) await Bridge.secretSet("google-calendar-client-id", idValue);
        if (secretValue) await Bridge.secretSet("google-calendar-client-secret", secretValue);
      } catch (err) {
        problem = errorText(err);
        void render();
        return;
      }
      void signIn(go);
    });
    const consoleBtn = h("button", { text: GOOGLE_CAL.openConsole });
    consoleBtn.addEventListener("click", () => void Bridge.openUrl(GOOGLE_CONSOLE));
    const guide = h("div", { class: "section-note" },
      h("div", { class: "mail-account-form-title", text: GOOGLE_CAL.guideTitle }),
      h("ol", { style: "margin:6px 0 8px 18px;display:flex;flex-direction:column;gap:3px" },
        ...GOOGLE_CAL.guide.map((step) => h("li", { text: step }))),
      consoleBtn);
    // Disconnect keeps the client (Google Cloud Console may not show its secret again): it goes only from here.
    const remove = stored ? h("button", { class: "danger", text: GOOGLE_CAL.removeClient }) as HTMLButtonElement : null;
    remove?.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await Bridge.secretClear("google-calendar-client-id");
        await Bridge.secretClear("google-calendar-client-secret");
        problem = "";
      } catch (err) {
        problem = errorText(err);
      }
      void render();
    });
    return [guide, h("div", { class: "field-rows" }, id.row, secret.row), h("div", { class: "mail-account-actions", style: "justify-content:flex-start" }, go, remove)];
  };

  const signOutButton = () => {
    const out = h("button", { class: "danger", text: CHAT_STRINGS.disconnect }) as HTMLButtonElement;
    out.addEventListener("click", async () => {
      out.disabled = true;
      try {
        const revoked = await Bridge.googleCalendarSignOut();
        sync.reset();
        problem = revoked ? "" : GOOGLE_CAL.notRevoked;
      } catch (err) {
        problem = errorText(err);
      }
      void render();
    });
    return out;
  };

  const calendarsList = async (list: HTMLElement, account: HTMLElement, line: HTMLElement, unreadable: Record<string, string>) => {
    try {
      const calendars = await sync.list();
      const picks = () => settings.googleCalendars ?? {};
      // The island reads the first MAX_GOOGLE_CALENDARS shown (core/google-calendar.ts): the count says so.
      const count = () => {
        const shown = calendars.filter((c) => isShown(c, picks())).length;
        line.textContent = GOOGLE_CAL.shown(Math.min(shown, MAX_GOOGLE_CALENDARS), calendars.length);
        line.classList.toggle("bad", shown > MAX_GOOGLE_CALENDARS);
        line.title = shown > MAX_GOOGLE_CALENDARS ? GOOGLE_CAL.tooMany : "";
        tooMany.style.display = shown > MAX_GOOGLE_CALENDARS ? "" : "none";
      };
      const tooMany = h("span", { class: "hint", text: GOOGLE_CAL.tooMany, style: "margin:4px 0 0 2px" });
      const primary = calendars.find((c) => c.primary);
      if (primary) account.textContent = primary.id;
      count();
      list.replaceChildren(h("span", { class: "hint", text: GOOGLE_CAL.pick, style: "margin:4px 0 0 2px" }), tooMany,
        ...calendars.map((c) => h("div", { class: "mail-account", style: "grid-template-columns:auto minmax(0,1fr) auto" },
          h("i", { class: "dot", style: `background:${c.color}` }),
          h("div", { class: "mail-account-text" }, h("span", { class: "mail-account-address", text: c.name, title: c.name }),
            // Google no longer lets the account read it (no longer shared, deleted): its events left the island, and this says why.
            unreadable[c.id] ? h("span", { class: "mail-account-line bad", text: unreadable[c.id], title: unreadable[c.id] }) : null),
          toggle(isShown(c, picks()), (on) => {
            settings.googleCalendars = { ...picks(), [c.id]: on };
            count();
            void save();
          }))));
    } catch (err) {
      // Lumo is paused: nothing is read until it resumes, and nothing failed.
      if (errorText(err) === "paused") return;
      // Google may have refused the permission on this very ask: then the row offers Sign in again.
      if ((await Bridge.googleCalendarStatus())?.needsSignIn) {
        void render();
        return;
      }
      line.textContent = errorText(err);
      line.classList.add("bad");
    }
  };

  const render = async () => {
    const status = await Bridge.googleCalendarStatus();
    if (!status) return;
    drawn = status;
    if (waitTimer != null) window.clearInterval(waitTimer);
    waitTimer = null;
    const parts: (HTMLElement | null)[] = [];
    if (status.signingIn) {
      dotEl.style.background = "#f5a524";
      const cancel = h("button", { text: t("Cancel") }) as HTMLButtonElement;
      cancel.addEventListener("click", () => {
        cancel.disabled = true;
        void Bridge.googleCalendarCancel();
      });
      parts.push(h("div", { class: "mail-account-actions", style: "justify-content:flex-start" },
        h("button", { text: GOOGLE_CAL.waiting, disabled: true }), cancel),
        h("span", { class: "hint", text: GOOGLE_CAL.waitingHint }),
        h("span", { class: "hint", text: GOOGLE_CAL.unverified }),
        h("span", { class: "hint", text: GOOGLE_CAL.mismatch }));
      waitTimer = window.setInterval(async () => {
        if (!row.isConnected) {
          if (waitTimer != null) window.clearInterval(waitTimer);
          waitTimer = null;
          return;
        }
        if (!(await Bridge.googleCalendarStatus())?.signingIn) void render();
      }, 1_000);
    } else if (status.signedIn) {
      const bad = status.needsSignIn;
      dotEl.style.background = bad ? "#f4505e" : "#22c55e";
      const account = h("span", { class: "mail-account-address", text: "Google" });
      const line = h("span", { class: bad ? "mail-account-line bad" : "mail-account-line", text: bad ? GOOGLE_CAL.ended : "" });
      const again = bad ? h("button", { class: "primary", text: GOOGLE_CAL.signInAgain }) as HTMLButtonElement : null;
      again?.addEventListener("click", () => void signIn(again));
      parts.push(h("div", { class: "mail-account", style: bad ? "" : "grid-template-columns:auto minmax(0,1fr) auto" },
        h("i", { class: "dot", style: `background:${bad ? "#f4505e" : "#22c55e"}` }),
        h("div", { class: "mail-account-text" }, h("div", { class: "mail-account-name" }, account), line),
        again, signOutButton()));
      const list = h("div", { class: "mail-account-list" });
      parts.push(list);
      if (!bad) void calendarsList(list, account, line, status.unreadable ?? {});
    } else {
      dotEl.style.background = "#f4505e";
      parts.push(...clientForm(status.client));
    }
    parts.push(problemLine());
    body.replaceChildren(...parts.filter((p): p is HTMLElement => p != null));
  };
  void render();
  // Back on screen: the island may have learned meanwhile that Google ended the access (or a sign-in in the other window).
  const recheck = async () => {
    if (waitTimer != null || !row.isConnected) return;
    const status = await Bridge.googleCalendarStatus();
    if (status && (status.signedIn !== drawn?.signedIn || status.needsSignIn !== drawn?.needsSignIn
      || JSON.stringify(status.unreadable ?? {}) !== JSON.stringify(drawn?.unreadable ?? {}))) void render();
  };
  const onMessage = (e: MessageEvent) => {
    if (!row.isConnected) {
      window.removeEventListener("message", onMessage);
      return;
    }
    if (e.source === window.parent && e.origin === location.origin && e.data === FRAME_SHOWN) void recheck();
  };
  window.addEventListener("message", onMessage);
  whileShown(row, "focus", () => void recheck());
  return row;
}

/** The live activities' calendar: its iCal address, kept in the credential store (calendar.rs). */
function calendarRow(): HTMLElement {
  const key = "calendar-ics-url";
  const input = h("input", {
    type: "password",
    placeholder: "https://calendar.google.com/calendar/ical/…/basic.ics",
    autocomplete: "off",
    spellcheck: "false",
    style: "flex:1 1 auto;min-width:0",
  }) as HTMLInputElement;
  const dotEl = statusDot(false);
  const saveBtn = h("button", { text: t("Save") });
  const removeBtn = h("button", { class: "danger", text: CHAT_STRINGS.remove });
  const show = (stored: boolean) => {
    input.placeholder = stored ? CHAT_STRINGS.stored : "https://calendar.google.com/calendar/ical/…/basic.ics";
    dotEl.style.background = stored ? "#22c55e" : "#f4505e";
    removeBtn.style.display = stored ? "" : "none";
  };
  show(false);
  void Bridge.secretPresent(key).then((on) => show(on === true));
  // An empty field saves nothing: the address goes only with Remove.
  saveBtn.addEventListener("click", async () => {
    const value = input.value.trim();
    if (!value) return;
    try {
      await Bridge.secretSet(key, value);
      input.value = "";
      show(true);
    } catch {
      dotEl.style.background = "#f5a524";
    }
  });
  removeBtn.addEventListener("click", async () => {
    try {
      await Bridge.secretClear(key);
      show(false);
    } catch {
      dotEl.style.background = "#f5a524";
    }
  });
  return wideSetting(h("span", { class: "with-dot" }, t("Calendar"), dotEl),
    t("The calendar's secret iCal address. Google Calendar: Settings → your calendar → Integrate calendar → Secret address in iCal format. It stays in the {store}, and Lumo only reads it.", { store: KEY_STORE }),
    input, saveBtn, removeBtn);
}

/**
 * Settings → General → Language: "System" follows the
 * system's language when Lumo has it (else English), or one of the ten.
 * Both windows and the tray switch in place, without a restart.
 */
function languageRow(): HTMLElement {
  const select = h("select", {}) as HTMLSelectElement;
  select.append(h("option", { value: "", text: t("System") }));
  for (const { code, name } of LANGUAGES) select.append(h("option", { value: code, text: name, lang: code }));
  select.value = LANGUAGES.some((l) => l.code === settings.language) ? settings.language : "";
  select.addEventListener("change", () => {
    settings.language = select.value;
    void save();
    applyLanguage();
  });
  return setting(t("Language"), null, select);
}

// ── Shortcuts section ─────────────────────────────────────────────────────────

const SHORTCUTS_UI = {
  get title() { return t("Shortcuts"); },
  get hint() { return t("Work from any app. Click a shortcut to change it, then press the new keys — Esc cancels, Backspace removes it."); },
  get global() { return t("From anywhere"); },
  get island() { return t("In the open island"); },
  get recording() { return t("Press keys…"); },
  get none() { return t("None"); },
  get reset() { return t("Reset to defaults"); },
  get inUse() { return t("In use by another app"); },
  get duplicate() { return t("Used twice"); },
  get invalid() { return t("Not a valid shortcut"); },
  get unavailable() { return t("Not available"); },
  types: (ch: string) => t("Types “{char}”", { char: ch }),
  typesNote: (keys: string, ch: string) =>
    t("{keys} types “{char}” on your keyboard, so it can't be a shortcut. Pick another key.", { keys, char: ch }),
  get needsModifier() { return t("Hold Ctrl, Alt or the Windows key with it."); },
  get unsupportedKey() { return t("That key can't be used in a shortcut."); },
};

function shortcutsSection(initial: ShortcutsReport | null): HTMLElement {
  let report = initial;
  const list = h("div", { class: "shortcut-list" });
  const feedback = h("div", {});

  let stopRecording: (() => void) | null = null;
  /** The shortcut being recorded: draw() shows its key waiting for a press. */
  let recordingId: string | null = null;

  function store(id: string, binding: Binding) {
    settings.shortcuts = { ...settings.shortcuts, [id]: binding };
    void save();
  }

  function tagFor(id: string, dups: Set<string>): HTMLElement | null {
    if (dups.has(id)) return h("span", { class: "tag err", text: SHORTCUTS_UI.duplicate });
    const st = report?.actions.find((a) => a.id === id);
    switch (st?.status) {
      case "inUse": return h("span", { class: "tag warn", text: SHORTCUTS_UI.inUse });
      case "duplicate": return h("span", { class: "tag err", text: SHORTCUTS_UI.duplicate });
      case "invalid": return h("span", { class: "tag err", text: SHORTCUTS_UI.invalid });
      case "typesCharacter": return h("span", { class: "tag warn", text: SHORTCUTS_UI.types(st.typed ?? "?") });
      case "unsupported": return h("span", { class: "tag", text: SHORTCUTS_UI.unavailable });
      default: return null;
    }
  }

  function record(id: string, binding: Binding) {
    // A recording under way ends first, and its end redraws the list: the
    // key clicked is drawn anew, so it is draw() that shows it recording,
    // not the button clicked, which may be gone by then.
    stopRecording?.();
    clear(feedback);
    recordingId = id;
    draw();
    void Bridge.shortcutsSuspend(true);

    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const result = recordPress(e);
      switch (result.kind) {
        case "pending":
          return;
        case "keys":
          finish();
          store(id, { keys: result.keys, enabled: true });
          return;
        case "clear":
          finish();
          store(id, { keys: "", enabled: binding.enabled });
          return;
        case "typesCharacter":
          finish();
          feedback.append(h("div", {
            class: "notice warn",
            text: SHORTCUTS_UI.typesNote(displayKeys(result.keys), result.typed),
          }));
          return;
        case "needsModifier":
          feedback.replaceChildren(h("div", { class: "notice warn", text: SHORTCUTS_UI.needsModifier }));
          return;
        case "unsupported":
          feedback.replaceChildren(h("div", { class: "notice warn", text: SHORTCUTS_UI.unsupportedKey }));
          return;
        case "cancel":
          finish();
          return;
      }
    };
    const onBlur = () => finish();

    function finish() {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      stopRecording = null;
      recordingId = null;
      // Takes the global shortcuts back, from what is saved by now.
      void Bridge.shortcutsSuspend(false);
      draw();
    }
    stopRecording = finish;
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
  }

  function draw() {
    clear(list);
    const dups = duplicates(activeKeys(settings.shortcuts));
    for (const d of SHORTCUTS) {
      const binding = effective(d, settings.shortcuts);
      const recording = d.id === recordingId;
      const keycap = h("button", {
        class: recording ? "keycap recording" : "keycap",
        text: recording ? SHORTCUTS_UI.recording : binding.keys ? displayKeys(binding.keys) : SHORTCUTS_UI.none,
      }) as HTMLButtonElement;
      keycap.disabled = !binding.enabled;
      keycap.addEventListener("click", () => record(d.id, binding));
      const sw = toggle(binding.enabled, (on) => store(d.id, { keys: binding.keys, enabled: on }));
      const tag = binding.enabled ? tagFor(d.id, dups) : null;
      list.append(h("div", { class: binding.enabled ? "row shortcut" : "row shortcut off" },
        sw,
        h("span", { class: "shortcut-name", text: t(SHORTCUT_TEXT[d.id]) }),
        ...(tag ? [tag] : []),
        keycap,
      ));
    }
  }

  const islandList = h("div", { class: "shortcut-list" });
  for (const row of ISLAND_SHORTCUTS) {
    islandList.append(h("div", { class: "row shortcut" },
      h("span", { class: "shortcut-name", text: t(row.description) }),
      h("span", { class: "keycap static", text: row.keys }),
    ));
  }

  const reset = h("button", {
    text: SHORTCUTS_UI.reset,
    onclick: () => {
      stopRecording?.();
      settings.shortcuts = {};
      clear(feedback);
      void save();
      draw();
    },
  });

  // The events are listened to once (see main); only the section on screen redraws.
  shortcutsListener = {
    report(fresh) {
      report = fresh;
      if (!stopRecording) draw();
    },
    settingsChanged() {
      if (!stopRecording) draw();
    },
    stop() {
      stopRecording?.();
    },
  };

  draw();
  return h(
    "section",
    {},
    ...sectionHead(SHORTCUTS_UI.title, SHORTCUTS_UI.hint),
    group(SHORTCUTS_UI.global),
    list,
    feedback,
    h("div", { class: "row end" }, reset),
    group(SHORTCUTS_UI.island),
    islandList,
  );
}

/** Settings → General → Weekly recap. The prefs live with the history in Rust. */
function recapRows(): HTMLElement[] {
  const T = {
    label: t("Weekly recap"),
    keep: t("Keep a history of my coding sessions"),
    clear: t("Clear history"),
    cleared: t("History cleared."),
    about: t("Counts and project names only — never commands, files or prompts. Kept on this computer for 12 weeks."),
  };
  const feedback = h("span", { class: "hint" });
  const sw = toggle(true, (v) => { void Bridge.recapSetEnabled(v); });
  void Bridge.recapPrefs().then((prefs) => {
    if (prefs) sw.classList.toggle("on", prefs.enabled);
  });
  const clearBtn = h("button", {
    class: "danger",
    text: T.clear,
    onclick: async () => {
      clearBtn.disabled = true;
      await Bridge.recapClear();
      feedback.textContent = T.cleared;
      window.setTimeout(() => {
        clearBtn.disabled = false;
        feedback.textContent = "";
      }, 2400);
    },
  }) as HTMLButtonElement;
  return [
    setting(T.label, h("span", {}, T.keep, h("br"), T.about), feedback, clearBtn, sw),
  ];
}

// ── Language ──────────────────────────────────────────────────────────────────

/** The shortcuts section on screen, told about the events listened to once in main. */
let shortcutsListener: {
  report(fresh: ShortcutsReport): void;
  settingsChanged(): void;
  /** Ends a recording in progress (the section is being left). */
  stop(): void;
} | null = null;

/**
 * Shows the language Settings asks for. A change redraws the window in place,
 * where it was scrolled to: nothing reloads, nothing is written.
 */
function applyLanguage() {
  setLanguage(resolveLanguage(settings.language, systemLanguages()));
}

function applyDirection() {
  document.documentElement.dir = isRtl() ? "rtl" : "ltr";
  document.title = t("Settings — Lumo");
}

let rendering: Promise<void> | null = null;
let renderAgain = false;

/** Redraws every section from fresh state, keeping the scroll position. */
async function rerender() {
  if (rendering) {
    renderAgain = true;
    return;
  }
  const scroll = document.scrollingElement?.scrollTop ?? 0;
  rendering = render();
  try {
    await rendering;
  } finally {
    rendering = null;
  }
  if (document.scrollingElement) document.scrollingElement.scrollTop = scroll;
  if (renderAgain) {
    renderAgain = false;
    await rerender();
  }
}

// ── Sections ──────────────────────────────────────────────────────────────────

/** The list on the left, in its order; each entry shows one page of cards. */
const PAGES = [
  { id: "general", label: N_("General") },
  { id: "island", label: N_("Island") },
  { id: "chat", label: N_("Chat") },
  { id: "voice", label: VOICE_SETTINGS.page },
  { id: "agents", label: N_("Agents") },
  { id: "pills", label: N_("Pills & integrations") },
  { id: "shortcuts", label: N_("Shortcuts") },
  { id: "security", label: N_("Security") },
  { id: "updates", label: N_("Updates") },
] as const;

type PageId = (typeof PAGES)[number]["id"];

/** Where the selected section is remembered between openings (this window only). */
const PAGE_KEY = "lumo.settings.page";

function isPage(id: unknown): id is PageId {
  return PAGES.some((p) => p.id === id);
}

function storedPage(): PageId {
  try {
    const id = window.localStorage.getItem(PAGE_KEY);
    if (isPage(id)) return id;
  } catch {
    // No storage (private mode, blocked): start on the first section.
  }
  return "general";
}

/** The section on screen; it survives every redraw of the window. */
let currentPage: PageId = storedPage();

/** Shows one section and marks it in the list; `fromClick` also scrolls back to the top. */
function showPage(id: PageId, fromClick = true) {
  if (fromClick && id !== currentPage) {
    // A shortcut being recorded would otherwise catch keys typed elsewhere.
    shortcutsListener?.stop();
    currentPage = id;
    try {
      window.localStorage.setItem(PAGE_KEY, id);
    } catch {
      // Not remembered next time; it still shows now.
    }
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-page]")) {
    const on = el.dataset.page === currentPage;
    if (el.classList.contains("page")) el.hidden = !on;
    else {
      el.classList.toggle("on", on);
      if (on) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    }
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

/** Shown inside the island (views/settings-frame.ts) rather than in its own window. */
const embedded = EMBEDDED || new URLSearchParams(location.search).has("embedded");

function tellIsland(message: string) {
  window.parent.postMessage(message, location.origin);
}

async function main() {
  // Never the webview's menu: Cut, Copy, Paste and Select all in a field.
  installTextMenu();
  // The island's "Customize this menu…" picked a page while this window was open.
  window.addEventListener("storage", (e) => {
    if (e.key === PAGE_KEY && isPage(e.newValue)) showPage(e.newValue);
  });
  if (embedded) {
    document.body.classList.add("embedded");
    // settings.html paints its window colour inline, before any style loads.
    document.body.style.background = "transparent";
    // Escape closes the island, as it does from any other view. The shortcut
    // recorder takes its own Escape first (capture), and so does a colour palette.
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !e.defaultPrevented) tellIsland(FRAME_CLOSE);
    });
  }
  const boot = await Bridge.boot();
  if (boot) {
    settings = { ...settings, ...boot.settings };
    version = boot.version;
    onBattery = boot.onBattery === true;
  }
  void onEvent<boolean>("energy-power", (now) => {
    onBattery = now === true;
    energyRedraw?.();
  });
  setLanguage(resolveLanguage(settings.language, systemLanguages()));
  applyDirection();
  applyLook();
  onLanguageChange(() => {
    applyDirection();
    void rerender();
  });
  // Whatever goes wrong drawing a section, the island stops waiting for the
  // page (and the error is in lumo.log), rather than saying "Opening Settings…" for ever.
  try {
    await render();
  } catch (err) {
    void Bridge.log(`settings: ${String(err)}`);
  }
  if (embedded) tellIsland(FRAME_READY);

  void onEvent<ShortcutsReport>("shortcuts-status", (fresh) => shortcutsListener?.report(fresh));
  // Settings saved elsewhere since they were drawn (the island, the other
  // window): the page, which stays loaded, is drawn again when it comes back
  // on screen. Its own saves come back here too, with nothing new in them.
  let stale = false;
  const backOnScreen = () => {
    if (!stale) return;
    stale = false;
    void rerender();
  };
  if (embedded) {
    window.addEventListener("message", (e) => {
      if (e.source === window.parent && e.origin === location.origin && e.data === FRAME_SHOWN) backOnScreen();
    });
  } else {
    window.addEventListener("focus", backOnScreen);
  }
  void onEvent<Settings>("settings-changed", (s) => {
    // Where the island sits and its size, saved as it is dragged or resized,
    // are on no page here: they never draw the page again, which would wipe
    // what is being typed (an API key) or the diff open.
    if (Object.entries(s).some(([k, v]) => !UNSHOWN_KEYS.has(k) && JSON.stringify(v) !== JSON.stringify((settings as unknown as Record<string, unknown>)[k]))) {
      stale = true;
    }
    const before = `${settings.chatProvider}|${settings.ollamaUrl}|${settings.lmstudioUrl}|${settings.unslothUrl}|${settings.customUrl}`;
    settings = { ...settings, ...s };
    shortcutsListener?.settingsChanged();
    for (const redraw of declaredViews) redraw();
    const after = `${settings.chatProvider}|${settings.ollamaUrl}|${settings.lmstudioUrl}|${settings.unslothUrl}|${settings.customUrl}`;
    if (before !== after) localRedraw?.();
    applyLanguage();
  });
}

/** The settings the island keeps for itself, shown by no page of Settings. */
const UNSHOWN_KEYS = new Set(["islandDock", "islandOffset", "islandFloat", "islandWidth", "islandHeight", "islandSizes"]);

/** Inside the island, Settings take the island's look (settings.css, html.look-new). */
function applyLook() {
  if (embedded) document.documentElement.classList.add("look-new");
}

/** Reads what the sections show and draws them all. */
async function render() {
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, current: false, planRelayInstalled: false, settingsPath: "", hookPath: "", hookReady: false,
  };
  const agents = await Bridge.agentHooksList();

  const hasKey = (await Bridge.secretPresent("anthropic-api-key")) ?? false;
  const shortcutReport = await Bridge.shortcutsStatus();

  const keys = [
    "stripe-api-key", "github-token", "vercel-token",
    "n8n-url", "n8n-api-key", "resend-api-key", "notion-api-key", "calcom-api-key",
    "mail-address", "mail-app-password", "mail-imap-server",
  ];
  const present: Record<string, boolean> = {};
  for (const k of keys) present[k] = (await Bridge.secretPresent(k)) ?? false;

  // A main pill this build can run, and no pill declared twice.
  settings = { ...settings, ...sanitizeDeclared(settings) };
  const connected: Record<string, boolean> = { ...((await Bridge.agentHooksStatus()) ?? {}) };
  for (const def of availablePills()) {
    if (def.connect.kind === "key") {
      connected[def.id] = present[def.connect.key] ?? (await Bridge.secretPresent(def.connect.key)) ?? false;
    }
  }
  /** A chat provider's or an integration's key was saved or removed: its pill's row says so at once. */
  const keyChanged = (key: string, on: boolean) => {
    for (const def of availablePills()) {
      if (def.connect.kind === "key" && def.connect.key === key) connected[def.id] = on;
    }
    for (const redraw of declaredViews) redraw();
  };
  const chatKeys: Record<string, boolean> = {};
  for (const def of CLOUD) {
    const key = providerDef(def.id).key!;
    chatKeys[key] = (await Bridge.secretPresent(key)) ?? false;
  }
  const serverKeys: Partial<Record<LocalId, boolean>> = {
    custom: (await Bridge.secretPresent(CUSTOM_SERVER_KEY)) ?? false,
    unsloth: (await Bridge.secretPresent(UNSLOTH_SERVER_KEY)) ?? false,
  };

  declaredViews.length = 0;
  localRedraw = null;
  // A shortcut being recorded ends with the section it was in.
  shortcutsListener?.stop();
  shortcutsListener = null;

  // Every section is built, so what one redraws (declaredViews, the local
  // models, the shortcuts) works as before; only the selected one shows.
  const pages: Record<PageId, HTMLElement[]> = {
    general: [generalSection()],
    island: [islandSection()],
    chat: [apiSection(hasKey), cliSection("antigravity-cli", N_("Uses your Google account. No key needed.")), cliSection("codex", N_("Uses your ChatGPT account. No key needed.")), cliSection("copilot-cli", N_("Uses your GitHub Copilot plan. No key needed."), COPILOT_MISSING), cliSection("cursor-cli", N_("Uses your Cursor plan. No key needed."), CURSOR_MISSING), chatProvidersSection(chatKeys, keyChanged), localSection(serverKeys), chatUsageSection()],
    voice: [voiceSection(chatKeys, keyChanged, shortcutReport)],
    agents: [claudeSection(status), agentsSection(agents), backgroundSection(), planSection(status, connected)],
    pills: [activePillsSection(connected), integrationsSection(present, keyChanged)],
    shortcuts: [shortcutsSection(shortcutReport)],
    security: [securitySection()],
    updates: [
      updatesSection(version, setting(t("Check when Lumo opens"),
        t("Each time Lumo opens, it asks GitHub once whether a newer version is out, and says so on the island."),
        toggle(settings.updateCheckOnOpen !== false, (v) => { settings.updateCheckOnOpen = v; void save(); }),
      ), setting(t("Beta versions"),
        t("One build with every change not released yet, to try them before they come out. It can have bugs."),
        toggle(settings.updateBeta === true, (v) => { settings.updateBeta = v; void save(); betaChanged(); }),
      ), () => settings.updateBeta === true),
      changelogSection(version),
    ],
  };

  const nav = h("nav", { class: "nav", "aria-label": t("Settings") });
  const content = h("main", { class: "content" });
  for (const page of PAGES) {
    const button = h("button", {
      class: "nav-item",
      "data-page": page.id,
      text: t(page.label),
      onclick: () => {
        // A section picked from the list: the search is done.
        if (searchQuery) {
          searchQuery = "";
          const field = root.querySelector<HTMLInputElement>(".settings-search");
          if (field) field.value = "";
          showSearch();
        }
        showPage(page.id);
      },
    });
    nav.append(button);
    content.append(h("div", { class: "page", "data-page": page.id }, ...pages[page.id]));
  }

  // The search above the list: what is typed shows the matching settings of every section.
  const search = h("input", {
    type: "search",
    class: "settings-search",
    placeholder: t(SEARCH_STRINGS.placeholder),
    "aria-label": t(SEARCH_STRINGS.placeholder),
    spellcheck: "false",
  }) as HTMLInputElement;
  search.value = searchQuery;
  search.addEventListener("input", () => {
    searchQuery = search.value;
    showSearch();
  });
  search.addEventListener("keydown", (e) => {
    // Escape empties the field first; a second one closes the island, as ever.
    if (e.key === "Escape" && search.value) {
      e.preventDefault();
      search.value = "";
      searchQuery = "";
      showSearch();
    }
  });
  const noMatch = h("p", { class: "search-none" });
  content.prepend(noMatch);

  clear(root);
  root.append(
    h("aside", { class: "sidebar" },
      h("h1", {}, h("span", { text: "Lumo" }), h("span", { class: "version", text: version })),
      search,
      nav,
    ),
    content,
  );
  showPage(currentPage, false);
  showSearch();
}

/** What the search field holds; kept when the sections are drawn again. */
let searchQuery = "";

/** Every section with the settings that match the search, or the open section when it is empty. */
function showSearch() {
  const content = root.querySelector<HTMLElement>(".content");
  const noMatch = root.querySelector<HTMLElement>(".search-none");
  if (!content || !noMatch) return;
  const searching = searchQuery.trim() !== "";
  root.classList.toggle("searching", searching);
  if (!searching) {
    applySearch(content, "");
    noMatch.hidden = true;
    showPage(currentPage, false);
    return;
  }
  for (const el of root.querySelectorAll<HTMLElement>("[data-page]")) {
    if (el.classList.contains("page")) el.hidden = false;
    else {
      el.classList.remove("on");
      el.removeAttribute("aria-current");
    }
  }
  const found = applySearch(content, searchQuery);
  noMatch.textContent = t(SEARCH_STRINGS.none, { query: searchQuery.trim() });
  noMatch.hidden = found;
}

void main();
