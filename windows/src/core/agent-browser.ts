// The agents' hidden browser tabs (src-tauri/src/browser.rs, lumo-hook --mcp
// --tools=browser): what one of their actions does, in words, for the Allow /
// Deny card. Approving "mcp__lumo__browser_open" says nothing; approving
// "Open in a new browser tab · https://example.com" says where it goes.
//
// Pure: the tool's name and input in, the card's line out.

import { N_, t } from "../i18n/i18n";

/** Lumo's browser tools (hook/src/mcp.rs BROWSER_NAMES). */
const NAMES = new Set([
  "browser_open", "browser_read", "browser_click", "browser_type", "browser_scroll", "browser_screenshot", "browser_close",
]);

/**
 * Which of Lumo's browser tools an agent's tool name is: Claude Code calls
 * them `mcp__lumo__browser_<name>`. Null for any other tool.
 */
export function browserToolName(tool: string): string | null {
  // Only the server named `lumo`, with nothing in front but the agent's own
  // `mcp` (as lumo_tool in hook/src/mcp.rs): "mcp__work_lumo__…" is another server's.
  const m = /^(?:mcp[_/.:-]+)?lumo[_/.:-]+([a-z_]+)$/i.exec(tool);
  const name = m?.[1].toLowerCase() ?? "";
  return NAMES.has(name) ? name : null;
}

/** True for one of Lumo's browser tools. */
export function isBrowserTool(tool: string): boolean {
  return browserToolName(tool) != null;
}

export const BROWSER_TEXT = {
  openNew: N_("Open in a new browser tab"),
  open: N_("Open in browser tab {tab}"),
  read: N_("Read browser tab {tab}"),
  click: N_("Click in browser tab {tab}"),
  type: N_("Type in browser tab {tab}"),
  scrollUp: N_("Scroll up in browser tab {tab}"),
  scrollDown: N_("Scroll down in browser tab {tab}"),
  screenshot: N_("Look at browser tab {tab}"),
  close: N_("Close browser tab {tab}"),
  /** The line above, for every browser action: where it happens. */
  apart: N_("In a hidden tab of its own, apart from your browser: none of your accounts."),
  /** The line above for an address of this PC or the local network (browser.rs ask_local): asked in every mode. */
  local: N_("An address on this PC or your local network, not the internet: Lumo asks before an agent goes there."),
};

/** True for browser_open's own card for this PC or the local network (browser.rs ask_local). */
export function isLocalOpen(tool: string, input: Record<string, unknown>): boolean {
  return browserToolName(tool) === "browser_open" && input.local === true;
}

/**
 * A number the agent gave, as text; "?" for none. Only a JSON number, as
 * browser.rs `number` takes: one sent as text is refused there, never run.
 */
function num(v: unknown): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : "?";
}

/** Typed text for the card: ⏎ at each Enter (then a new line), ⇥ at each Tab, as computer use shows it. */
function typedText(text: string): string {
  return text.replace(/\r\n?|\n/g, "⏎\n").replace(/\t/g, "⇥");
}

/**
 * The card's line for a browser action ("Open in a new browser tab ·
 * https://example.com", "Click in browser tab 2 · [12]", "Type in browser tab
 * 2 · hello⏎"), or null when `tool` is not one of Lumo's browser tools. What
 * is done comes first, then " · " and on what, as describeComputerAction.
 */
export function describeBrowserAction(tool: string, input: Record<string, unknown>): string | null {
  const name = browserToolName(tool);
  if (name == null) return null;
  const tab = num(input.tab);
  const line = (label: string, detail: string) => (detail ? `${t(label, { tab })} · ${detail}` : t(label, { tab }));
  switch (name) {
    case "browser_open": {
      // The address whole, as the agent wrote it: Allow allows exactly that one.
      const url = typeof input.url === "string" ? input.url.trim() : "";
      // Any tab given loads there (browser.rs), or is refused when it is no number: never a new tab.
      return line(input.tab != null ? BROWSER_TEXT.open : BROWSER_TEXT.openNew, url);
    }
    case "browser_read":
      return line(BROWSER_TEXT.read, "");
    case "browser_click": {
      const at = typeof input.ref === "number" ? `[${input.ref}]` : typeof input.x === "number" || typeof input.y === "number" ? `${num(input.x)}, ${num(input.y)}` : "";
      return line(BROWSER_TEXT.click, at);
    }
    case "browser_type": {
      // All the text, as it will be typed; ⏎ at its end when Enter follows.
      const text = typeof input.text === "string" ? typedText(input.text) : "";
      const into = typeof input.ref === "number" ? `[${input.ref}] ` : "";
      return line(BROWSER_TEXT.type, `${into}${text}${input.submit === true ? "⏎" : ""}`);
    }
    case "browser_scroll": {
      const pages = typeof input.pages === "number" && input.pages !== 1 ? `×${input.pages}` : "";
      return line(input.direction === "up" ? BROWSER_TEXT.scrollUp : BROWSER_TEXT.scrollDown, pages);
    }
    case "browser_screenshot":
      return line(BROWSER_TEXT.screenshot, "");
    case "browser_close":
      return line(BROWSER_TEXT.close, "");
    default:
      return null;
  }
}
