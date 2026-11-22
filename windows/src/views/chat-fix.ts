// What puts a chat's CLI right, in Lumo's words: a card in place of a failed
// answer when Claude Code or the Antigravity CLI isn't signed in or isn't
// installed, and one under an answer of agy's that skipped commands because
// Lumo isn't connected to it yet. Rust says which (chat.rs FIX_MARK).

import { h } from "./dom";
import { copyButton } from "./markdown";
import { Bridge, type ChatFix } from "../core/bridge";
import { INSTALL_COMMANDS } from "../core/cli-install";
import { N_, t, tl } from "../i18n/i18n";

export type { ChatFix };

const FIXES: readonly ChatFix[] = ["claude-sign-in", "claude-install", "agy-sign-in", "agy-install", "agy-hooks"];

/** Ends a failed answer's text, before what it puts right (chat.rs FIX_MARK). */
const FIX_MARK = "⁤";

/** Rust's chat providers (claude_code.rs, antigravity_cli.rs PROVIDER). */
const CLAUDE = "claude-code";
const AGY = "antigravity-cli";

export const FIX_TEXT = {
  claudeSignInTitle: N_("Claude Code isn't signed in to your Claude plan"),
  claudeSignInBody: N_("It takes a moment, once: Claude Code opens in a window of its own and asks you to sign in (if it doesn't, type /login there). Then press Retry."),
  claudeSignIn: N_("Sign in to Claude"),
  agySignInTitle: N_("Antigravity CLI isn't signed in"),
  agySignInBody: N_("It takes a moment, once: Antigravity CLI opens in a window of its own and asks you to sign in with your Google account. Then press Retry."),
  agySignIn: N_("Sign in with Google"),
  private: N_("Lumo never sees or keeps your sign-in"),
  claudeInstallTitle: N_("Claude Code isn't installed yet"),
  agyInstallTitle: N_("Antigravity CLI isn't installed yet"),
  installBody: N_("Paste this command in PowerShell to install it, then sign in once and press Retry."),
  retry: N_("Retry"),
  hooksTitle: N_("Antigravity CLI skipped commands it should have asked you about"),
  hooksBody: N_("To ask you here, Lumo needs to connect to Antigravity CLI: it shows you the change before writing it, and from then on each command comes to the island as Allow / Deny."),
  hooksButton: N_("Connect in Settings…"),
  signInFailed: N_("It couldn't open: {error}"),
  signInOpened: N_("A window opened: sign in there, then press Retry."),
};

/** How long a sign-in button waits after a click, so a second click doesn't open a second window. */
export const SIGN_IN_HOLD_MS = 4000;

/** A failed answer's text without what puts it right, and what does (none: just the text). */
export function splitFix(text: string): [string, ChatFix | undefined] {
  const at = text.lastIndexOf(FIX_MARK);
  if (at < 0) return [text, undefined];
  const fix = text.slice(at + 1).trim() as ChatFix;
  return [text.slice(0, at), FIXES.includes(fix) ? fix : undefined];
}

/** What a card's buttons do: the question again, and Settings → Agents. */
export interface FixActions {
  onRetry?: () => void;
  openAgents?: () => void;
}

/** The card for `fix`; `detail` is the CLI's own words, small under it when there are any. */
export function fixCard(fix: ChatFix, detail: string, actions: FixActions): HTMLElement {
  const card = h("div", { class: "chat-fix", "data-fix": fix });
  const title = (key: string) => h("div", { class: "chat-fix-title", text: tl(key) });
  const body = (key: string) => h("div", { class: "chat-fix-body", text: tl(key) });
  const button = (key: string, primary: boolean, run: () => void) => {
    const btn = h("button", { class: primary ? "chat-fix-btn primary" : "chat-fix-btn", text: tl(key) });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      run();
    });
    return btn;
  };
  const retry = actions.onRetry ? button(FIX_TEXT.retry, false, actions.onRetry) : null;
  const said = h("div", { class: "chat-fix-note", role: "status" });
  said.hidden = true;
  const signIn = (provider: string, label: string) => {
    const btn: HTMLButtonElement = button(label, true, () => {
      // One window at a time: the button waits a moment, and says where to look.
      btn.disabled = true;
      said.hidden = true;
      said.classList.remove("ok");
      Bridge.cliSignIn(provider).then(
        () => {
          said.textContent = t(FIX_TEXT.signInOpened);
          said.classList.add("ok");
          said.hidden = false;
        },
        (err) => {
          said.textContent = t(FIX_TEXT.signInFailed, { error: String(err).replace(/^Error:\s*/, "") });
          said.hidden = false;
        },
      );
      window.setTimeout(() => (btn.disabled = false), SIGN_IN_HOLD_MS);
    }) as HTMLButtonElement;
    return btn;
  };
  const row = (...items: (HTMLElement | null)[]) => h("div", { class: "chat-fix-actions" }, ...items);
  switch (fix) {
    case "claude-sign-in":
    case "agy-sign-in": {
      const claude = fix === "claude-sign-in";
      card.append(
        title(claude ? FIX_TEXT.claudeSignInTitle : FIX_TEXT.agySignInTitle),
        body(claude ? FIX_TEXT.claudeSignInBody : FIX_TEXT.agySignInBody),
        row(signIn(claude ? CLAUDE : AGY, claude ? FIX_TEXT.claudeSignIn : FIX_TEXT.agySignIn), retry, h("span", { class: "chat-fix-hint", text: tl(FIX_TEXT.private) })),
      );
      break;
    }
    case "claude-install":
    case "agy-install": {
      const command = fix === "claude-install" ? INSTALL_COMMANDS.claude : INSTALL_COMMANDS.agy;
      card.append(
        title(fix === "claude-install" ? FIX_TEXT.claudeInstallTitle : FIX_TEXT.agyInstallTitle),
        body(FIX_TEXT.installBody),
        h("div", { class: "chat-fix-command" }, h("code", { text: command }), copyButton(command, "chat-fix-copy", 12)),
      );
      if (retry) card.append(row(retry));
      break;
    }
    case "agy-hooks": {
      const open = actions.openAgents;
      card.append(title(FIX_TEXT.hooksTitle), body(FIX_TEXT.hooksBody));
      if (open) card.append(row(button(FIX_TEXT.hooksButton, true, open)));
      break;
    }
  }
  card.append(said);
  if (detail) card.append(h("div", { class: "chat-fix-detail", text: detail }));
  return card;
}
