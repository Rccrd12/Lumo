// Settings → Claude Code and the other CLIs: the changes to Claude Code's
// settings.json (each shown as a diff first, for its card in
// sections/agent-cards.ts), background sessions, Codex's plan usage, the
// Claude API key and models, and the Antigravity, Codex, Copilot and Cursor CLIs.

import { Bridge, type HookPreview, type ModelInfo } from "../../core/bridge";
import { isHidden, providerDef, visibleProviders } from "../../core/providers";
import { h, clear } from "../../views/dom";
import { accentDot, cancelledByHand, renderDiff, sectionHead, setting, statusDot, wideSetting } from "../parts";
import { PLAN_AGENT, agentPlanOn } from "../../core/plan";
import { parseBackgroundMode } from "../../core/background";
import { N_, t } from "../../i18n/i18n";
import { KEY_STORE, save, select, settings, toggle } from "../store";

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

export const HOOKS_CHANGE: Change = {
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

export const STATUS_LINE_CHANGE: Change = {
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
export async function reviewChange(
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

export function backgroundSection(): HTMLElement {
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
 * Codex's weekly limit in the island's header. Claude Code's and Antigravity
 * CLI's are in their own cards (sections/agent-cards.ts).
 */
export const PLAN_SETTINGS_TEXT = {
  get claude() { return t("Shows your Claude plan's 5-hour and weekly limits in the island's header, through a status line relay in ~/.claude/settings.json. A status line you already have keeps working. Pro and Max plans only."); },
  get codex() { return t("Shows your Codex plan's weekly limit in the island's header, asked from the Codex CLI; nothing is installed. Codex must be signed in with ChatGPT."); },
  get showCodex() { return t("Show Codex plan in the island"); },
  get antigravity() { return t("Shows your Antigravity CLI quotas (5-hour and weekly) in the island's header, asked from agy as its /usage does; nothing is installed. agy must be signed in with your Google account."); },
};

/** Codex's or agy's switch: on by itself once the agent is added, until turned off here. */
export function agentPlanToggle(kind: "codex" | "antigravity", connected: Record<string, boolean>): HTMLElement {
  return toggle(agentPlanOn(kind, settings, connected[PLAN_AGENT[kind]] ?? false), (on) => {
    if (kind === "codex") settings.showCodexPlanInNotch = on;
    else settings.showAntigravityPlanInNotch = on;
    const others = (settings.hiddenPlanPills ?? []).filter((k) => k !== kind);
    settings.hiddenPlanPills = on ? others : [...others, kind];
    void save();
  });
}

export function planSection(connected: Record<string, boolean>): HTMLElement {
  return h("section", {}, ...sectionHead(t("Plan usage")),
    h("div", { class: "setting-list" },
      // Codex: nothing to install, Lumo asks the Codex CLI when the pill shows.
      setting(PLAN_SETTINGS_TEXT.showCodex, PLAN_SETTINGS_TEXT.codex, agentPlanToggle("codex", connected)),
    ));
}

// ── Claude API section ────────────────────────────────────────────────────────

const MODELS: [string, string][] = [
  ["claude-fable-5-2", "Claude Fable 5.2"],
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["claude-haiku-5-5", "Claude Haiku 5.5"],
];

/** What Claude Code runs: its own default, or one of the current models, until Claude Code lists its own. */
const CLAUDE_CODE_MODELS: [string, string][] = [
  ["default", N_("Default")],
  ["claude-fable-5-2", "Fable 5.2"],
  ["claude-opus-5-5", "Opus 5.5"],
  ["claude-sonnet-5-5", "Sonnet 5.5"],
  ["claude-haiku-5-5", "Haiku 5.5"],
];

/** The older versions Claude Code lists, apart in the field (the chat's "More models"). */
export const MORE_MODELS = N_("More models ({count})");

const NO_KEY = N_("No key yet. Only the Anthropic API needs one: Claude Code uses your Claude plan.");

export function apiSection(hasKey: boolean): HTMLElement {
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
  // Its models are those Claude Code lists once the field is opened (the
  // older versions apart, as in the chat's "More models"); these until then.
  const ccModel = h("select", {}) as HTMLSelectElement;
  const ccFill = (offered: ModelInfo[]) => {
    const ccSaved = settings.chatModels["claude-code"] || "default";
    clear(ccModel);
    for (const m of offered.filter((m) => !m.older)) ccModel.append(h("option", { value: m.id, text: m.label }));
    const older = offered.filter((m) => m.older);
    if (older.length) {
      const group = h("optgroup", { label: t(MORE_MODELS, { count: older.length }) });
      for (const m of older) group.append(h("option", { value: m.id, text: m.label }));
      ccModel.append(group);
    }
    if (!offered.some((m) => m.id === ccSaved)) ccModel.append(h("option", { value: ccSaved, text: ccSaved }));
    ccModel.value = ccSaved;
  };
  ccFill(CLAUDE_CODE_MODELS.map(([id, label]) => ({ id, label: t(label) })));
  let ccAsked = false;
  const ccAsk = () => {
    if (ccAsked) return;
    ccAsked = true;
    Bridge.chatModels("claude-code").then((listed) => { if (listed.length) ccFill(listed); }, () => {});
  };
  ccModel.addEventListener("focus", ccAsk);
  ccModel.addEventListener("pointerdown", ccAsk);
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
export const COPILOT_MISSING = N_("Not on this PC yet: install it with npm install -g @github/copilot, then run copilot once in a terminal to sign in.");
export const CURSOR_MISSING = N_("Not on this PC yet: install it from cursor.com/cli, then run cursor-agent login once in a terminal to sign in.");

/**
 * Antigravity CLI, Codex, Copilot CLI and Cursor CLI need no key either:
 * each runs with the account signed in to it, Google's for `agy`
 * (antigravity_cli.rs), ChatGPT's for `codex` (codex_chat.rs), GitHub's for
 * `copilot` and Cursor's for `cursor-agent` (acp_chat.rs). Their models come
 * from the CLI itself (`agy models`, Codex's `model/list`, what a new ACP
 * session offers), asked only once the list is opened.
 */
export function cliSection(id: "antigravity-cli" | "codex" | "copilot-cli" | "cursor-cli", note: string, missing?: string): HTMLElement {
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
