// Settings window — the place where anything that writes to disk is confirmed.
// Stage 2 covers the Claude Code hooks and the general preferences; API keys and
// integrations land here too in a later stage.

import "../core/legacy";
import "./settings.css";
import { Bridge, EMBEDDED, onEvent, type HookPreview, type HookStatus, type ModelInfo, type ShortcutsReport } from "../core/bridge";
import { CUSTOM_SERVER_KEY, effortFor, effortsFor, providerDef, urlExposure } from "../core/providers";
import {
  ISLAND_SHORTCUTS, SHORTCUTS, SHORTCUT_TEXT, activeKeys, displayKeys, duplicates, effective,
  recordPress, type Binding,
} from "../core/shortcuts";
import { DEFAULT_SETTINGS, parseCloseMode, parseMotion, type Settings } from "../core/state";
import { LOOK_KEYS, LUMO_LOOKS, parseLook } from "../mochi/wardrobe";
import {
  MAX_DECLARED, PILL_CATEGORIES, availablePills, chooseMainPill, isComingSoon, mainPillChoices,
  sanitizeDeclared, toggleDeclared, type PillDefinition,
} from "../core/pills";
import { h, clear } from "../views/dom";
import { agentsSection } from "./agents";
import { colorDot } from "./colors";
import { renderDiff, statusDot } from "./parts";
import { updatesSection } from "./updates";
import { FRAME_CLOSE, FRAME_READY } from "../views/settings-frame";
import { LIVE_EXTENDED, LIVE_MODEL, THINKING_LEVELS, VOICES, parseLiveModel, parseThinking, parseVoice } from "../live/protocol";
import { VOICE_SETTINGS } from "../live/strings";
import {
  LANGUAGES, N_, isRtl, onLanguageChange, resolveLanguage, setLanguage, systemLanguages, t, tn,
} from "../i18n/i18n";

/** Where secrets.rs keeps the keys on this OS. */
const KEY_STORE = navigator.userAgent.includes("Windows")
  ? "Windows Credential Manager"
  : "Secret Service (GNOME Keyring, KWallet)";

let settings: Settings = { ...DEFAULT_SETTINGS };
let version = "";

const root = document.getElementById("settings-root")!;

async function save() {
  await Bridge.saveSettings(settings);
}

/** A colour was picked for a pill's Mochi (see ./colors.ts): the island follows. */
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
    h("h2", {}, statusDot(status.installed), h("span", { text: "Claude Code" })),
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
      h("div", {
        class: "hint",
        text: status.installed
          ? t("Lumo is hooked into your Claude Code sessions. Tool calls, questions and permission requests show up in the island, and you can answer them there.")
          : t("Install the hooks to see your Claude Code sessions in the island and approve permissions without leaving what you are doing."),
      }),
      h("div", { class: "row" },
        h("label", { text: "settings.json" }),
        h("span", { class: "path", text: status.settingsPath }),
      ),
      h("div", { class: "row" },
        h("label", { text: t("Relay") }),
        h("span", { class: "path", text: status.hookPath }),
        statusDot(status.hookReady),
      ),
    );

    if (!status.hookReady) {
      body.append(h("div", {
        class: "notice warn",
        text: t("lumo-hook.exe is not in place yet. Restart Lumo; if it still fails, build it with `cargo build -p lumo-hook`."),
      }));
    }

    const actions = h("div", { class: "row" });
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

// ── Plan usage section ────────────────────────────────────────────────────────

/**
 * The 5-hour and weekly limits in the island's header. They come from Claude
 * Code's status line, so the relay has to be the status line first: turning the
 * switch on without it starts the install, and the switch only stays on once
 * that has been confirmed. A status line the user had keeps working.
 */
const PLAN_SETTINGS_TEXT = {
  get claude() { return t("Shows your Claude plan usage (5-hour and weekly limits) in the island's header. Lumo adds a status line relay in ~/.claude/settings.json. If you already have a status line, it keeps working as before. Pro and Max plans only."); },
  get showClaude() { return t("Show in notch"); },
  get codex() { return t("Shows your Codex plan usage (weekly limit and free resets left) in the island's header. Lumo asks the Codex CLI (codex app-server) when the pill shows; nothing is installed. Codex must be signed in with ChatGPT."); },
  get showCodex() { return t("Show Codex plan in the notch"); },
};

function planSection(status: HookStatus): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:12px" });
  const section = h("section", {}, h("h2", {}, h("span", { text: t("Plan usage") })), body);

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
      h("div", {
        class: "hint",
        text: PLAN_SETTINGS_TEXT.claude,
      }),
      h("div", { class: "row" }, h("label", { text: PLAN_SETTINGS_TEXT.showClaude }), sw),
      h("div", { class: "row" },
        h("label", { text: t("Relay") }),
        statusDot(status.planRelayInstalled),
        h("span", { class: "hint", text: status.planRelayInstalled ? t("installed") : t("not installed") }),
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
      // Codex: nothing to install, Lumo asks the Codex CLI when the pill shows.
      h("div", { class: "hint", text: PLAN_SETTINGS_TEXT.codex }),
      h("div", { class: "row" },
        h("label", { text: PLAN_SETTINGS_TEXT.showCodex }),
        toggle(settings.showCodexPlanInNotch, (on) => {
          settings.showCodexPlanInNotch = on;
          void save();
        }),
      ),
    );
  }

  draw();
  return section;
}

// ── Claude API section ────────────────────────────────────────────────────────

const MODELS: [string, string][] = [
  ["claude-opus-5-5", "Claude Opus 5.5"],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5"],
  ["claude-haiku-5-5", "Claude Haiku 5.5"],
];

/** What Claude Code runs: its own default, or one of the current models. */
const CLAUDE_CODE_MODELS: [string, string][] = [
  ["default", N_("Default")],
  ["claude-opus-5-5", "Opus 5.5"],
  ["claude-sonnet-5-5", "Sonnet 5.5"],
  ["claude-haiku-5-5", "Haiku 5.5"],
];

const NO_KEY = N_("No key yet. Only the Anthropic API needs one: Claude Code uses your Claude plan.");

function apiSection(hasKey: boolean): HTMLElement {
  const dot = statusDot(hasKey);
  const state = h("span", { class: "hint", text: hasKey ? t("Key saved in the {store}.", { store: KEY_STORE }) : t(NO_KEY) });

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
    h("h2", {}, dot, h("span", { text: "Claude" })),
    h("div", { class: "row" }, h("label", { text: "Claude Code" }), ccModel),
    h("div", { class: "hint", style: "margin:-4px 0 0 144px", text: t("Uses your Claude plan. No key needed.") }),
    state,
    h("div", { class: "row" }, h("label", { text: t("API key") }), field, saveBtn, clearBtn),
    h("div", { class: "row" }, h("label", { text: t("Model") }), model),
    feedback,
  );
}

// ── Antigravity CLI section ───────────────────────────────────────────────────

/**
 * Antigravity CLI needs no key either: it runs with the Google account signed
 * in to `agy` (antigravity_cli.rs). Its models come from `agy models`, asked
 * only once the list is opened.
 */
function agyCliSection(): HTMLElement {
  const p = providerDef("antigravity-cli");
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

  return h(
    "section",
    {},
    h("h2", {}, h("i", { class: "dot", style: `background:${p.accent};margin-right:8px` }), h("span", { text: p.name })),
    h("div", { class: "row" }, h("label", { text: t("Model") }), model),
    h("div", { class: "hint", style: "margin:-4px 0 0 144px", text: t("Uses your Google account. No key needed.") }),
  );
}

// ── Active pills section ──────────────────────────────────────────────────────

/**
 * The tools you use (Mac 0.1.1–0.1.2): pick the main workspace tool, which is
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

  /** Why a pill would show nothing yet, as on the Mac's row. */
  function hint(def: PillDefinition): string | null {
    if (isComingSoon(def.id)) return t("Coming soon");
    if (def.connect.kind === "hooks" && !connected[def.id]) return t("Hooks not installed");
    if (def.connect.kind === "key" && !connected[def.id]) return t("Key not configured");
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
    h("h2", {}, h("span", { text: t("Active pills") })),
    h("div", { class: "hint", text: t("Choose the tools you use. Lumo only shows what you declare here.") }),
    slots,
    h("div", { class: "row" }, h("label", { text: t("Main tool") }), main),
    groups,
  );
}

// ── Chat providers section ────────────────────────────────────────────────────

const CHAT_STRINGS = {
  get providersTitle() { return t("Chat providers"); },
  get providersHint() { return t("Chat with Google AI, OpenAI or OpenRouter instead of Claude: add a key here, then click the model name above the chat box to switch provider and model. Keys stay in the system keychain. These providers get no web search and no tools: they can answer, never act on this computer."); },
  get stored() { return `••••••••  ${t("(stored)")}`; },
  get save() { return t("Save"); },
  get remove() { return t("Remove"); },
  get localTitle() { return t("Local models"); },
  get localHint() { return t("Chat with a model you run yourself: Ollama or LM Studio (leave the address empty for the usual one on this computer), or any server that speaks the OpenAI API, such as vLLM or llama.cpp. Once connected, pick it above the chat box."); },
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
  const list = h("div", { style: "display:flex;flex-direction:column;gap:8px" });
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
      h("div", { class: "row" },
        h("label", {},
          h("i", { class: "dot", style: `background:${p.accent};margin-right:8px` }),
          h("span", { text: def.name }),
        ),
        input, saveBtn, removeBtn, dotEl,
      ),
      h("div", { class: "hint", style: "margin:-4px 0 0 144px", text: t("Key from {site}", { site: def.where }) }),
    );
  }
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: CHAT_STRINGS.providersTitle })),
    h("div", { class: "hint", text: CHAT_STRINGS.providersHint }),
    list,
  );
}

// ── Remaining usage in the chat ───────────────────────────────────────────────

/** The quiet line next to the chat's model picker (core/chat-usage.ts). Off until turned on. */
function chatUsageSection(): HTMLElement {
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Remaining usage") })),
    h("div", { class: "hint", text: t("Shows what the provider in use has left, in a small line next to the model name above the chat box: your Claude plan's 5-hour and weekly limits for Claude Code (with the relay from {path}), the rate limits Anthropic and OpenAI send back with each answer, and your OpenRouter key's credits, asked from OpenRouter when the chat opens and after an answer. Nothing is shown for Google or the local models.", { path: `${t("Agents")} → ${t("Plan usage")}` }) }),
    h("div", { class: "row" },
      h("label", { text: t("Show remaining usage in the chat") }),
      toggle(settings.chatShowUsage, (on) => {
        settings.chatShowUsage = on;
        void save();
      }),
    ),
  );
}

// ── What goes with every message ─────────────────────────────────────────────

const SHARING_TEXT = {
  get title() { return t("Share with the chat"); },
  get hint() { return t("When this is on, every message you send carries the path of the folder open in File Explorer and the list of what is in it (names, sizes, dates), as if you picked it from the screen button. Its chip shows above the chat before you send; its × leaves it out of that message."); },
  get explorer() { return t("Always share the folder open in File Explorer"); },
  get linux() { return t("Not available on Linux yet."); },
};

function chatSharingSection(): HTMLElement {
  const windows = navigator.userAgent.includes("Windows");
  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: SHARING_TEXT.title })),
    h("div", { class: "hint", text: SHARING_TEXT.hint }),
    h("div", { class: "row" },
      h("label", { text: t("Tell the AI what's open") }),
      toggle(settings.chatShareOpen !== false, (on) => {
        settings.chatShareOpen = on;
        void save();
      }),
    ),
    h("div", { class: "hint", text: t("With every message: the open windows' titles and the documents they show (a PDF, a Word or Excel file…), found on disk, so the AI can read the one you ask about. Only the chat's provider gets them, with that message.") }),
    h("div", { class: "row" },
      h("label", { text: SHARING_TEXT.explorer }),
      toggle(settings.chatShareExplorer, (on) => {
        settings.chatShareExplorer = on;
        void save();
      }),
    ),
    windows ? null : h("div", { class: "hint", text: SHARING_TEXT.linux }),
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
  const thinkingRow = h("div", { class: "row" },
    h("label", { text: t(VOICE_SETTINGS.thinking) }),
    select(THINKING_LEVELS.map((l) => [l, t(THINKING_NAMES[l])]), parseThinking(settings.liveThinking), (v) => {
      settings.liveThinking = v;
      void save();
    }),
  );
  const thinkingHint = h("div", { class: "hint", style: "margin:-4px 0 0 144px", text: t(VOICE_SETTINGS.thinkingHint) });
  const showThinking = (m: string) => {
    thinkingRow.hidden = m !== LIVE_EXTENDED;
    thinkingHint.hidden = m !== LIVE_EXTENDED;
  };
  showThinking(model);

  const { modelRow: helperModelRow, problem: helperProblem, effortRow: helperEffortRow, draw: drawHelper } = helperChoices();
  drawHelper();

  const windows = navigator.userAgent.includes("Windows");
  const def = SHORTCUTS.find((s) => s.id === "talkToGemini");
  const binding = shortcuts && def ? effective(def, settings.shortcuts) : null;
  const keys = displayKeys(binding?.keys ?? def?.defaultKeys ?? "Ctrl+Alt+L");

  return h(
    "section",
    {},
    h("h2", {}, h("i", { class: "dot", style: "background:#22d3ee;margin-right:8px" }), h("span", { text: "Gemini Live" })),
    h("div", { class: "hint", text: t(VOICE_SETTINGS.hint, { keys }) }),
    h("div", { class: "row" },
      h("label", { text: t(VOICE_SETTINGS.key) }),
      input, saveBtn, removeBtn, dotEl,
    ),
    h("div", { class: "hint", style: "margin:-4px 0 0 144px", text: t("Key from {site}", { site: "aistudio.google.com" }) }),
    h("div", { class: "row" },
      h("label", { text: t(VOICE_SETTINGS.model) }),
      select([[LIVE_MODEL, "Gemini 3.8 Live"], [LIVE_EXTENDED, "Gemini 3.8 Live Extended Thinking"]], model, (v) => {
        settings.liveModel = v;
        showThinking(v);
        void save();
      }),
    ),
    thinkingRow,
    thinkingHint,
    h("div", { class: "row" },
      h("label", { text: t(VOICE_SETTINGS.voice) }),
      select([["", t(VOICE_SETTINGS.automatic)], ...VOICES.map((v): [string, string] => [v, v])], parseVoice(settings.liveVoice), (v) => {
        settings.liveVoice = v;
        void save();
      }),
    ),
    h("div", { class: "row" },
      h("label", { text: t(VOICE_SETTINGS.screen) }),
      toggle(settings.liveScreen && windows, (on) => {
        settings.liveScreen = on;
        void save();
      }),
    ),
    h("div", { class: "hint", style: "margin:-4px 0 0 144px", text: t(windows ? VOICE_SETTINGS.screenHint : VOICE_SETTINGS.screenLinux) }),
    h("div", { class: "row" },
      h("label", { text: t(VOICE_SETTINGS.helper) }),
      select([["claude-code", "Claude Code"], ["antigravity-cli", "Antigravity CLI"]], helperId(), (v) => {
        settings.liveHelper = v;
        // Each helper has its own models: the new one starts on its own choice.
        settings.liveHelperModel = "default";
        void save();
        drawHelper();
      }),
    ),
    h("div", { class: "hint", style: "margin:-4px 0 0 144px", text: t(VOICE_SETTINGS.helperHint) }),
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
  const modelRow = h("div", { class: "row" }, h("label", { text: t(VOICE_SETTINGS.helperModel) }), models);
  const effortRow = h("div", { class: "row" }, h("label", { text: t(VOICE_SETTINGS.helperEffort) }), efforts);
  const problem = h("div", { class: "hint", style: "margin:-4px 0 0 144px" });
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

type LocalId = "ollama" | "lmstudio" | "custom";

/** Redraws the local models section after a change made elsewhere (the island). */
let localRedraw: (() => void) | null = null;

const LOCAL: Record<LocalId, { name: string; usual: string }> = {
  ollama: { name: "Ollama", usual: "http://127.0.0.1:11434" },
  lmstudio: { name: "LM Studio", usual: "http://127.0.0.1:1234" },
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

function localSection(customKey: boolean): HTMLElement {
  const body = h("div", { style: "display:flex;flex-direction:column;gap:14px" });
  const section = h(
    "section",
    {},
    h("h2", {}, h("span", { text: CHAT_STRINGS.localTitle })),
    h("div", { class: "hint", text: CHAT_STRINGS.localHint }),
    body,
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
    const label = h("label", {},
      h("i", { class: "dot", style: `background:${p.accent};margin-right:8px` }),
      h("span", { text: t(def.name) }),
    );
    const block = h("div", { style: "display:flex;flex-direction:column;gap:6px" });

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
        if (id === "custom") {
          await Bridge.secretClear(CUSTOM_SERVER_KEY).catch(() => {});
          customKey = false;
        }
        await save();
        redraw();
      });
      block.append(
        h("div", { class: "row" }, label, h("span", { class: "path", text: settings[field] }), statusDot(true), use, disconnect),
        status,
      );
      exposure.append(exposureNotice(settings[field], id === "custom" && customKey) ?? "");
      block.append(exposure);
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
      placeholder: customKey ? CHAT_STRINGS.stored : CHAT_STRINGS.keyOptional,
      style: "flex:1 1 auto;min-width:0",
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    const connect = h("button", { class: "primary", text: CHAT_STRINGS.connect });

    const showExposure = () => {
      clear(exposure);
      const withKey = id === "custom" && (customKey || key.value.trim() !== "");
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
        if (id === "custom" && key.value.trim()) {
          // Stored with this address: the key is only ever sent there.
          await Bridge.localSetKey(input.value || def.usual, key.value.trim());
          key.value = "";
          customKey = true;
        }
        const server = await Bridge.localConnect(id, input.value);
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

    block.append(h("div", { class: "row" }, label, input, connect));
    if (id === "custom") block.append(h("div", { class: "row" }, h("label", { text: "" }), key));
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
  // The inbox over IMAP (mail.rs): read only, never sends.
  { id: "integration_mail", name: N_("Email"), color: "#EA4335",
    fields: [
      { key: "mail-address", label: N_("Address"), placeholder: "you@gmail.com", secret: false },
      { key: "mail-app-password", label: N_("App password"), placeholder: "abcd efgh ijkl mnop", secret: true },
      { key: "mail-imap-server", label: N_("IMAP server"), placeholder: N_("found from the address"), secret: false },
    ],
    hint: N_("New emails show on the closed island, with Summarize and Draft a reply. Lumo only reads the inbox: it never sends, deletes or marks anything as read. Gmail: turn on 2-Step Verification, then create an app password at myaccount.google.com/apppasswords. The server is needed only for providers other than Gmail, Outlook, iCloud and Yahoo.") },
];

const MAX_ACTIVE = MAX_DECLARED;

/** Everything that shows the declared pills, redrawn when any of them changes. */
const declaredViews: (() => void)[] = [];

function declaredChanged() {
  for (const redraw of declaredViews) redraw();
  void save();
}

function integrationsSection(present: Record<string, boolean>): HTMLElement {
  const note = h("div", { class: "hint" });
  const list = h("div", { style: "display:flex;flex-direction:column;gap:14px" });

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

    const rows = h("div", { style: "display:flex;flex-direction:column;gap:6px;flex:1 1 auto;min-width:0" });
    for (const field of def.fields) {
      const input = h("input", {
        type: field.secret ? "password" : "text",
        placeholder: present[field.key] ? CHAT_STRINGS.stored : t(field.placeholder),
        autocomplete: "off",
        spellcheck: "false",
        style: "flex:1 1 auto;min-width:0",
      }) as HTMLInputElement;
      const saveBtn = h("button", { text: t("Save") });
      const dotEl = statusDot(present[field.key] ?? false);
      saveBtn.addEventListener("click", async () => {
        const value = input.value.trim();
        try {
          await Bridge.secretSet(field.key, value);
          present[field.key] = value.length > 0;
          input.value = "";
          input.placeholder = value ? CHAT_STRINGS.stored : t(field.placeholder);
          dotEl.style.background = value ? "#22c55e" : "#f4505e";
        } catch {
          dotEl.style.background = "#f5a524";
        }
      });
      rows.append(
        h("div", { class: "row" },
          h("label", { style: "min-width:104px", text: t(field.label) }),
          input, saveBtn, dotEl,
        ),
      );
    }

    if (def.hint) rows.append(h("div", { class: "hint", text: t(def.hint) }));

    list.append(
      h("div", { style: "display:flex;gap:12px;align-items:flex-start" },
        h("div", { style: "display:flex;align-items:center;gap:8px;min-width:132px;padding-top:4px" },
          sw,
          colorDot(def, "", () => settings.pillColors, pickColor),
          h("span", { style: "font-size:12.5px", text: t(def.name) }),
        ),
        rows,
      ),
    );
  }

  updateNote();
  return h("section", {}, h("h2", {}, h("span", { text: t("Integrations") })), note, list);
}

// ── General section ───────────────────────────────────────────────────────────

function generalSection(): HTMLElement {
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    value: String(settings.soundVolume),
  }) as HTMLInputElement;
  volume.addEventListener("input", () => {
    settings.soundVolume = Number(volume.value);
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("General") })),
    h("div", { class: "row" },
      h("label", { text: t("Sound") }),
      toggle(settings.soundEnabled, (v) => { settings.soundEnabled = v; void save(); }),
      volume,
    ),
    languageRow(),
    h("div", { class: "row" },
      h("label", { text: t("Launch at startup") }),
      toggle(settings.autostart, (v) => { settings.autostart = v; void save(); }),
    ),
    ...recapRows(),
  );
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

  // The island's icons, against the Mac's size.
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

  // His look, as in the wardrobe.
  const look = h("select", {}) as HTMLSelectElement;
  for (const value of LUMO_LOOKS) look.append(h("option", { value, text: t(LOOK_KEYS[value]) }));
  look.value = parseLook(settings.lumoCharacter);
  look.addEventListener("change", () => {
    settings.lumoCharacter = look.value;
    void save();
  });

  return h(
    "section",
    {},
    h("h2", {}, h("span", { text: t("Island") })),
    ...behaviourRows(),
    h("div", { class: "row" },
      h("label", { text: t("Lumo moves") }),
      motion,
    ),
    h("div", { class: "row" },
      h("label", { text: t("Lumo's look") }),
      look,
    ),
    h("div", { class: "row" },
      h("label", { text: t("Island lives on") }),
      screen,
    ),
    h("div", { class: "row" },
      h("label", { text: t("Island size") }),
      size,
      h("button", { text: t("Put the island back in the centre"), onclick: () => void Bridge.islandRecenter() }),
    ),
    h("div", { class: "row" },
      h("label", { text: t("Icon size") }),
      icons,
    ),
    h("div", { class: "row" },
      h("span", { class: "hint", text: t("Drag the island by its top bar (or the closed island anywhere) to move it: let go anywhere and it stays there; near an edge of the screen it docks to it, upright on the sides, centred when you drop it near the middle.") }),
    ),
    h("div", { class: "row" },
      h("span", { class: "hint", text: t("Drag an edge or a corner of the open island to resize it. A double click on it puts the usual size back.") }),
    ),
  );
}

/** When the island opens and closes by itself. */
function behaviourRows(): HTMLElement[] {
  const close = h("select", {}) as HTMLSelectElement;
  close.append(
    h("option", { value: "timer", text: t("A few seconds after the mouse leaves") }),
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
  const secondsHint = h("span", { class: "hint", text: t("seconds after you leave the island") });
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
    h("div", { class: "row" },
      h("label", { text: t("Close the open island") }),
      close,
      seconds,
      secondsHint,
    ),
    h("div", { class: "row" },
      h("label", { text: t("Open on hover") }),
      toggle(settings.islandHoverOpen, (v) => { settings.islandHoverOpen = v; void save(); }),
      h("span", { class: "hint", text: t("opens the closed island when the mouse rests on it") }),
    ),
    h("div", { class: "row" },
      h("label", { text: t("Hide when unused") }),
      toggle(settings.islandAutoHide, (v) => { settings.islandAutoHide = v; void save(); }),
      h("span", { class: "hint", text: t("the closed island slips into the edge of the screen a minute after you leave it") }),
    ),
    h("div", { class: "row" },
      h("label", { text: t("Say what's going on") }),
      toggle(settings.compactActivity, (v) => { settings.compactActivity = v; void save(); }),
      h("span", { class: "hint", text: t("the closed island says what the AI is doing, and when an answer or an email arrives") }),
    ),
    h("div", { class: "row" },
      h("label", { text: t("Show the music playing") }),
      toggle(settings.compactMedia, (v) => { settings.compactMedia = v; void save(); }),
      h("span", { class: "hint", text: t("with play, pause and skip, when nothing else is showing") }),
    ),
    h("div", { class: "row" },
      h("label", { text: t("Live Activities") }),
      toggle(settings.activitiesPanel !== false, (v) => { settings.activitiesPanel = v; void save(); }),
      h("span", { class: "hint", text: t("beside the open island: timers, the music, the calendar and the newest emails") }),
    ),
    calendarRow(),
  ];
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
  void Bridge.secretPresent(key).then((on) => {
    if (on) {
      input.placeholder = CHAT_STRINGS.stored;
      dotEl.style.background = "#22c55e";
    }
  });
  const saveBtn = h("button", { text: t("Save") });
  saveBtn.addEventListener("click", async () => {
    const value = input.value.trim();
    try {
      await Bridge.secretSet(key, value);
      input.value = "";
      input.placeholder = value ? CHAT_STRINGS.stored : "https://calendar.google.com/calendar/ical/…/basic.ics";
      dotEl.style.background = value ? "#22c55e" : "#f4505e";
    } catch {
      dotEl.style.background = "#f5a524";
    }
  });
  return h("div", { style: "display:flex;flex-direction:column;gap:4px" },
    h("div", { class: "row" }, h("label", { text: t("Calendar") }), input, saveBtn, dotEl),
    h("div", { class: "hint", text: t("The calendar's secret iCal address. Google Calendar: Settings → your calendar → Integrate calendar → Secret address in iCal format. It stays in the {store}, and Lumo only reads it.", { store: KEY_STORE }) }),
  );
}

/**
 * Settings → General → Language, as on the Mac: "System" follows the
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
  return h("div", { class: "row" }, h("label", { text: t("Language") }), select);
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
  get wayland() {
    return t("Your Wayland desktop doesn't let apps listen for keys outside their own windows. Add the shortcuts in your system's keyboard settings instead, with these commands:");
  },
  get noDisplay() { return t("No display server was found, so global shortcuts are off."); },
};

function shortcutsSection(initial: ShortcutsReport | null): HTMLElement {
  let report = initial;
  const list = h("div", { class: "shortcut-list" });
  const feedback = h("div", {});
  const blockedNote = h("div", {});

  let stopRecording: (() => void) | null = null;

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

  function record(id: string, binding: Binding, button: HTMLButtonElement) {
    stopRecording?.();
    clear(feedback);
    button.classList.add("recording");
    button.textContent = SHORTCUTS_UI.recording;
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
      if (!d.ported) continue;
      const binding = effective(d, settings.shortcuts);
      const keycap = h("button", {
        class: "keycap",
        text: binding.keys ? displayKeys(binding.keys) : SHORTCUTS_UI.none,
      }) as HTMLButtonElement;
      keycap.disabled = !binding.enabled;
      keycap.addEventListener("click", () => record(d.id, binding, keycap));
      const sw = toggle(binding.enabled, (on) => store(d.id, { keys: binding.keys, enabled: on }));
      const tag = binding.enabled ? tagFor(d.id, dups) : null;
      list.append(h("div", { class: binding.enabled ? "row shortcut" : "row shortcut off" },
        sw,
        h("span", { class: "shortcut-name", text: t(SHORTCUT_TEXT[d.id]) }),
        ...(tag ? [tag] : []),
        keycap,
      ));
    }

    clear(blockedNote);
    if (report?.blocked === "wayland") {
      const commands = h("div", { class: "diff" });
      for (const d of SHORTCUTS) {
        if (d.ported) commands.append(h("div", { class: "ctx", text: `${report.command} ${d.id}` }));
      }
      blockedNote.append(h("div", { class: "notice warn", text: SHORTCUTS_UI.wayland }), commands);
    } else if (report?.blocked) {
      blockedNote.append(h("div", { class: "notice warn", text: SHORTCUTS_UI.noDisplay }));
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
    h("h2", {}, h("span", { text: SHORTCUTS_UI.title })),
    h("div", { class: "hint", text: SHORTCUTS_UI.hint }),
    h("div", { class: "subhead", text: SHORTCUTS_UI.global }),
    list,
    blockedNote,
    feedback,
    h("div", { class: "row" }, reset),
    h("div", { class: "subhead", text: SHORTCUTS_UI.island }),
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
    h("div", { class: "row" },
      h("label", { text: T.label }),
      sw,
      h("span", { class: "hint", text: T.keep }),
    ),
    h("div", { class: "row" },
      h("label", {}),
      clearBtn,
      feedback,
    ),
    h("div", { class: "row" },
      h("label", {}),
      h("span", { class: "hint", style: "flex:1 1 0;min-width:0", text: T.about }),
    ),
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
  }
  setLanguage(resolveLanguage(settings.language, systemLanguages()));
  applyDirection();
  onLanguageChange(() => {
    applyDirection();
    void rerender();
  });
  await render();
  if (embedded) tellIsland(FRAME_READY);

  void onEvent<ShortcutsReport>("shortcuts-status", (fresh) => shortcutsListener?.report(fresh));
  void onEvent<Settings>("settings-changed", (s) => {
    const before = `${settings.chatProvider}|${settings.ollamaUrl}|${settings.lmstudioUrl}|${settings.customUrl}`;
    settings = { ...settings, ...s };
    shortcutsListener?.settingsChanged();
    for (const redraw of declaredViews) redraw();
    const after = `${settings.chatProvider}|${settings.ollamaUrl}|${settings.lmstudioUrl}|${settings.customUrl}`;
    if (before !== after) localRedraw?.();
    applyLanguage();
  });
}

/** Reads what the sections show and draws them all. */
async function render() {
  const status = (await Bridge.hooksStatus()) ?? {
    installed: false, planRelayInstalled: false, settingsPath: "", hookPath: "", hookReady: false,
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
  /** A chat provider's key was saved or removed: its pill's row says so at once. */
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
  const customKey = (await Bridge.secretPresent(CUSTOM_SERVER_KEY)) ?? false;

  declaredViews.length = 0;
  localRedraw = null;
  shortcutsListener = null;

  // Every section is built, so what one redraws (declaredViews, the local
  // models, the shortcuts) works as before; only the selected one shows.
  const pages: Record<PageId, HTMLElement[]> = {
    general: [generalSection()],
    island: [islandSection()],
    chat: [apiSection(hasKey), agyCliSection(), chatProvidersSection(chatKeys, keyChanged), localSection(customKey), chatUsageSection()],
    voice: [voiceSection(chatKeys, keyChanged, shortcutReport)],
    agents: [claudeSection(status), agentsSection(agents), planSection(status)],
    pills: [activePillsSection(connected), integrationsSection(present)],
    shortcuts: [shortcutsSection(shortcutReport)],
    updates: [updatesSection(version)],
  };
  // The chat page ends on what goes with every message.
  pages.chat.push(chatSharingSection());

  const nav = h("nav", { class: "nav", "aria-label": t("Settings") });
  const content = h("main", { class: "content" });
  for (const page of PAGES) {
    const button = h("button", {
      class: "nav-item",
      "data-page": page.id,
      text: t(page.label),
      onclick: () => showPage(page.id),
    });
    nav.append(button);
    content.append(h("div", { class: "page", "data-page": page.id }, ...pages[page.id]));
  }

  clear(root);
  root.append(
    h("aside", { class: "sidebar" },
      h("h1", {}, h("span", { text: "Lumo" }), h("span", { class: "version", text: version })),
      nav,
    ),
    content,
  );
  showPage(currentPage, false);
}

void main();
