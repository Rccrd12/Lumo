// Settings → Agents: Claude Code and Antigravity, one card each, saying in
// plain words what works — installed, signed in, its terminal sessions in the
// island, its plan in the header — with what is technical (files, the relay,
// the status line) folded under Technical details. Every write to an agent's
// own config still shows the exact change first, with a backup, and waits for
// a click (claude.ts reviewChange, agents.ts reviewAgentHooks).

import { Bridge, type AgentHookStatus, type CliInfo, type HookStatus } from "../../core/bridge";
import { clear, h, svg } from "../../views/dom";
import { ICONS } from "../../views/icons";
import { INSTALL_COMMANDS } from "../../core/cli-install";
import { N_, t } from "../../i18n/i18n";
import { errorText, setting, statusDot } from "../parts";
import { save, settings, toggle } from "../store";
import { reviewAgentHooks } from "../agents";
import { SIGN_IN_HOLD_MS } from "../../views/chat-fix";
import { HOOKS_CHANGE, PLAN_SETTINGS_TEXT, STATUS_LINE_CHANGE, agentPlanToggle, reviewChange } from "./claude";

export const CARD_TEXT = {
  allSet: N_("All connected"),
  oneStep: N_("One step missing"),
  missing: N_("Not installed"),
  installed: N_("Installed on this PC"),
  version: N_("Version {version}"),
  checking: N_("Checking…"),
  installHint: N_("Not on this PC yet. Paste this command in PowerShell to install it:"),
  copy: N_("Copy"),
  copied: N_("Copied"),
  signIn: N_("Sign-in"),
  claudeSignInHint: N_("With your Claude plan, in Claude Code's own window. Lumo never sees or keeps your sign-in."),
  agySignInHint: N_("With your Google account, in agy's own window. Lumo never sees or keeps your sign-in."),
  openSignIn: N_("Open sign-in…"),
  claudeSessions: N_("Terminal sessions in the island"),
  claudeSessionsOn: N_("You see them, approve permissions and answer questions from here."),
  claudeSessionsOff: N_("Not connected yet: Lumo shows you the change to settings.json before writing it."),
  agySessions: N_("Sessions and commands in the island"),
  agySessionsOn: N_("The Antigravity app's and agy's sessions show here, and agy's commands come as Allow / Deny."),
  agySessionsOff: N_("Not connected yet: agy skips the commands it should ask you about, and its answer only says it didn't run them."),
  connect: N_("Connect…"),
  update: N_("Update…"),
  planUsage: N_("Plan usage"),
  askAnthropic: N_("Ask Anthropic"),
  askAnthropicHint: N_("Lumo asks Anthropic for your plan's usage every 3 minutes while the island is open, as /usage does, so it shows outside the terminal too. Claude Code's sign-in is only read, never kept."),
  details: N_("Technical details"),
  program: N_("Program"),
  relay: N_("Relay"),
  statusLine: N_("Status line relay"),
  hooksFile: N_("Hooks file"),
  installedLower: N_("installed"),
  notInstalledLower: N_("not installed"),
  reinstallHooks: N_("Reinstall hooks…"),
  uninstallHooks: N_("Uninstall hooks…"),
  installRelay: N_("Install relay…"),
  uninstallRelay: N_("Uninstall relay…"),
  reinstall: N_("Reinstall…"),
  uninstall: N_("Uninstall…"),
  relayMissing: N_("The relay isn't installed yet."),
  outdated: N_("This version of Lumo installs the hooks a little differently: Claude Code no longer waits for Lumo, except to ask for a permission. Reinstall them to get it."),
  noRelay: N_("lumo-hook.exe is not in place yet. Restart Lumo; if it still fails, build it with `cargo build -p lumo-hook`."),
  cantOpen: N_("It couldn't open: {error}"),
  signInOpened: N_("A window opened: sign in there."),
  connected: N_("Connected"),
};

/** Rust's chat providers (claude_code.rs, antigravity_cli.rs PROVIDER). */
const CLAUDE = "claude-code";
const AGY = "antigravity-cli";

/** Whether the technical details of each card are open: a redrawn card keeps them as they were. */
const detailsOpen = new Set<string>();

/** The card's state beside its name: green, amber (a step to go) or red (not installed). */
function cardHead(title: string, state: "ok" | "step" | "missing"): HTMLElement {
  const color = state === "ok" ? "#22c55e" : state === "step" ? "#f5a524" : "#f4505e";
  const words = state === "ok" ? CARD_TEXT.allSet : state === "step" ? CARD_TEXT.oneStep : CARD_TEXT.missing;
  return h("h2", { class: "agent-card-head" },
    h("span", { text: title }),
    h("i", { class: "dot", style: `background:${color}` }),
    h("span", { class: "agent-card-state", text: t(words) }));
}

/** The check beside a row that works. */
function check(): HTMLElement {
  return h("span", { class: "agent-card-check", role: "img", "aria-label": t(CARD_TEXT.connected), title: t(CARD_TEXT.connected) }, svg(ICONS.check, 15, { stroke: 2.4 }));
}

/** The installed row: its version, or how to install it. */
function installedRow(info: CliInfo | null | undefined, command: string): HTMLElement {
  if (info === undefined) return setting(t(CARD_TEXT.installed), t(CARD_TEXT.checking));
  // Rust didn't answer: nothing is said rather than something wrong.
  if (info === null) return setting(t(CARD_TEXT.installed), null);
  if (info?.installed) {
    return setting(t(CARD_TEXT.installed), info.version ? t(CARD_TEXT.version, { version: info.version }) : null, check());
  }
  const copy = h("button", { text: t(CARD_TEXT.copy) });
  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(command).then(() => {
      copy.textContent = t(CARD_TEXT.copied);
      window.setTimeout(() => (copy.textContent = t(CARD_TEXT.copy)), 1500);
    }, () => {});
  });
  const hint = h("span", {}, t(CARD_TEXT.installHint), h("span", { class: "agent-card-command" }, h("code", { text: command }), copy));
  return setting(t(CARD_TEXT.installed), hint);
}

/** The sign-in row: a button that opens the CLI's own sign-in, which Lumo never sees. */
function signInRow(provider: string, hint: string, installed: boolean): HTMLElement {
  const said = h("span", { class: "agent-card-error", role: "status" });
  const open = h("button", { text: t(CARD_TEXT.openSignIn) });
  open.disabled = !installed;
  open.addEventListener("click", () => {
    // One window at a time: the button waits a moment, and says where to look.
    said.textContent = "";
    said.classList.remove("ok");
    open.disabled = true;
    Bridge.cliSignIn(provider).then(
      () => {
        said.textContent = t(CARD_TEXT.signInOpened);
        said.classList.add("ok");
      },
      (err) => (said.textContent = t(CARD_TEXT.cantOpen, { error: errorText(err) })),
    );
    window.setTimeout(() => (open.disabled = !installed), SIGN_IN_HOLD_MS);
  });
  return setting(t(CARD_TEXT.signIn), h("span", {}, t(hint), said), open);
}

/** Technical details, folded: open stays open when the card is drawn again. */
function details(key: string, ...rows: (HTMLElement | null)[]): HTMLElement {
  const el = h("details", { class: "agent-details" },
    h("summary", { text: t(CARD_TEXT.details) }),
    h("div", { class: "setting-list" }, ...rows));
  el.open = detailsOpen.has(key);
  el.addEventListener("toggle", () => (el.open ? detailsOpen.add(key) : detailsOpen.delete(key)));
  return el;
}

// ── Claude Code ───────────────────────────────────────────────────────────────

export function claudeCard(status: HookStatus): HTMLElement {
  const section = h("section", { class: "agent-card" });
  let info: CliInfo | null | undefined;

  const redraw = () => {
    clear(section);
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
  /** A change to settings.json, shown in the card in place of its rows until it is written or cancelled. */
  const review = (change: typeof HOOKS_CHANGE, install: boolean, applied: () => void = () => void rebuild()) => {
    const body = h("div", { class: "setting-block" });
    clear(section);
    section.append(cardHead("Claude Code", state()), body);
    void reviewChange(body, change, install, redraw, applied);
  };
  const state = () => (info && !info.installed ? "missing" : status.installed && status.current !== false ? "ok" : "step");

  function draw() {
    const installed = info?.installed ?? true;
    // The hooks: a check once in; Connect… (the diff first) until then; Update… when this version writes them differently.
    const connect = h("button", { class: "primary", text: t(status.installed ? CARD_TEXT.update : CARD_TEXT.connect) });
    connect.addEventListener("click", () => review(HOOKS_CHANGE, true));
    if (!status.hookReady) {
      connect.disabled = true;
      connect.title = t(CARD_TEXT.relayMissing);
    }
    const linked = status.installed && status.current !== false;
    const sessions = setting(t(CARD_TEXT.claudeSessions), t(linked ? CARD_TEXT.claudeSessionsOn : status.installed ? CARD_TEXT.outdated : CARD_TEXT.claudeSessionsOff), linked ? check() : connect);

    // Plan usage: the status line relay first, written only once its change is confirmed.
    const plan = toggle(settings.showPlanInNotch, (on) => {
      if (!on || status.planRelayInstalled) {
        settings.showPlanInNotch = on;
        void save();
        return;
      }
      review(STATUS_LINE_CHANGE, true, () => {
        settings.planRelayInstalled = true;
        settings.showPlanInNotch = true;
        void save().then(rebuild);
      });
    });
    const ask = toggle(settings.planUsageOnline, (on) => {
      settings.planUsageOnline = on;
      void save();
    });

    const hooksButtons: HTMLElement[] = [];
    if (status.installed) {
      const again = h("button", { text: t(CARD_TEXT.reinstallHooks) });
      again.addEventListener("click", () => review(HOOKS_CHANGE, true));
      again.disabled = !status.hookReady;
      const remove = h("button", { class: "danger", text: t(CARD_TEXT.uninstallHooks) });
      remove.addEventListener("click", () => review(HOOKS_CHANGE, false));
      hooksButtons.push(again, remove);
    }
    const relayButton = h("button", {
      class: status.planRelayInstalled ? "danger" : "",
      text: t(status.planRelayInstalled ? CARD_TEXT.uninstallRelay : CARD_TEXT.installRelay),
    });
    relayButton.addEventListener("click", () => review(STATUS_LINE_CHANGE, !status.planRelayInstalled));

    section.append(
      cardHead("Claude Code", state()),
      h("div", { class: "setting-list" },
        installedRow(info, INSTALL_COMMANDS.claude),
        signInRow(CLAUDE, CARD_TEXT.claudeSignInHint, installed),
        sessions,
        setting(t(CARD_TEXT.planUsage), PLAN_SETTINGS_TEXT.claude, plan),
        setting(t(CARD_TEXT.askAnthropic), t(CARD_TEXT.askAnthropicHint), ask),
      ),
      ...(status.hookReady ? [] : [h("div", { class: "notice warn", text: t(CARD_TEXT.noRelay) })]),
      details("claude",
        info?.path ? setting(t(CARD_TEXT.program), h("span", { class: "path", text: info.path })) : null,
        setting("settings.json", h("span", { class: "path", text: status.settingsPath }), ...hooksButtons),
        setting(h("span", { class: "with-dot" }, t(CARD_TEXT.relay), statusDot(status.hookReady)), h("span", { class: "path", text: status.hookPath })),
        setting(h("span", { class: "with-dot" }, t(CARD_TEXT.statusLine), statusDot(status.planRelayInstalled)),
          t(status.planRelayInstalled ? CARD_TEXT.installedLower : CARD_TEXT.notInstalledLower), relayButton),
      ),
    );
  }

  draw();
  void Bridge.cliInfo(CLAUDE).then((found) => {
    info = found;
    redraw();
  });
  return section;
}

// ── Antigravity ───────────────────────────────────────────────────────────────

/**
 * Antigravity: the app and agy read the same hooks (agents.rs), which bring
 * their sessions to the island and agy's commands as Allow / Deny.
 * `hooks` is null when Lumo could not list them.
 */
export function antigravityCard(hooks: AgentHookStatus | null, connected: Record<string, boolean>): HTMLElement {
  const section = h("section", { class: "agent-card" });
  let status = hooks;
  let info: CliInfo | null | undefined;

  const redraw = () => {
    clear(section);
    draw();
  };
  const refresh = async () => {
    const list = await Bridge.agentHooksList();
    status = list?.find((a) => a.id === "antigravity") ?? status;
    redraw();
  };
  const state = () => (info && !info.installed ? "missing" : status?.installed ? "ok" : "step");
  const review = (install: boolean) => {
    if (!status) return;
    const body = h("div", { class: "setting-block" });
    clear(section);
    section.append(cardHead("Antigravity", state()), body);
    void reviewAgentHooks(body, status, install, redraw, () => void refresh());
  };

  function draw() {
    const installed = info?.installed ?? true;
    const linked = status?.installed ?? false;
    const connect = h("button", { class: "primary", text: t(CARD_TEXT.connect) });
    connect.addEventListener("click", () => review(true));
    if (!status?.hookReady) {
      connect.disabled = true;
      connect.title = t(CARD_TEXT.relayMissing);
    }
    const hooksButtons: HTMLElement[] = [];
    if (linked) {
      const again = h("button", { text: t(CARD_TEXT.reinstall) });
      again.addEventListener("click", () => review(true));
      again.disabled = !status?.hookReady;
      const remove = h("button", { class: "danger", text: t(CARD_TEXT.uninstall) });
      remove.addEventListener("click", () => review(false));
      hooksButtons.push(again, remove);
    }
    section.append(
      cardHead("Antigravity", state()),
      h("div", { class: "setting-list" },
        installedRow(info, INSTALL_COMMANDS.agy),
        signInRow(AGY, CARD_TEXT.agySignInHint, installed),
        status ? setting(t(CARD_TEXT.agySessions), t(linked ? CARD_TEXT.agySessionsOn : CARD_TEXT.agySessionsOff), linked ? check() : connect) : null,
        setting(t(CARD_TEXT.planUsage), PLAN_SETTINGS_TEXT.antigravity, agentPlanToggle("antigravity", connected)),
      ),
      details("antigravity",
        info?.path ? setting(t(CARD_TEXT.program), h("span", { class: "path", text: info.path })) : null,
        status ? setting(t(CARD_TEXT.hooksFile), h("span", { class: "path", text: status.path }), ...hooksButtons) : null,
      ),
    );
  }

  draw();
  void Bridge.cliInfo(AGY).then((found) => {
    info = found;
    redraw();
  });
  return section;
}
