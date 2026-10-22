// The chat's commands: what the menu offers once "/" is the field's first
// character (views/chat.ts draws it). Lumo's own commands work with every
// provider and never reach the AI; Claude Code's go to the CLI as they are
// typed (claude_code.rs), and the list is the one its last turn reported
// (`chat-commands`), else the few every Claude Code has. Antigravity CLI runs
// with its commands turned off (antigravity_cli.rs) and the other providers
// have none: their /compact shows, greyed, saying so. Pure data and helpers,
// so they can be tested without a webview.

import { N_ } from "../i18n/i18n";
import { isCliProvider } from "./providers";

/** What one of Lumo's own commands does in the chat. */
export type SlashAction = "new" | "history" | "model" | "attach" | "screen" | "permissions" | "timer";

export interface SlashCommand {
  /** Without the slash. */
  name: string;
  /** What it does, as an N_ key; a CLI's own command without one says whose it is. */
  note: string;
  /** An ICONS name (views/icons.ts). */
  icon: string;
  /** Lumo's own, or the CLI's (sent as typed). */
  kind: "lumo" | "cli";
  action?: SlashAction;
  /** Waits for what follows it in the field (`/timer 10m pasta`) instead of running. */
  args?: boolean;
  /** Why it cannot run with this provider (an N_ key): shown greyed. */
  off?: string;
}

export const SLASH_STRINGS = {
  timer: N_("Start a timer on the closed island"),
  compact: N_("Sum up the conversation so far"),
  context: N_("Show how full the context is"),
  onlyClaudeCode: N_("Only with Claude Code"),
};

const LUMO: readonly SlashCommand[] = [
  { name: "new", note: N_("New chat"), icon: "plus", kind: "lumo", action: "new" },
  { name: "history", note: N_("Past chats"), icon: "clock", kind: "lumo", action: "history" },
  { name: "model", note: N_("Switch provider or model"), icon: "gear", kind: "lumo", action: "model" },
  { name: "attach", note: N_("Attach a file"), icon: "paperclip", kind: "lumo", action: "attach" },
  { name: "screen", note: N_("Share your screen or open windows"), icon: "display", kind: "lumo", action: "screen" },
  { name: "permissions", note: N_("Permissions"), icon: "shield", kind: "lumo", action: "permissions" },
  { name: "timer", note: SLASH_STRINGS.timer, icon: "timer", kind: "lumo", action: "timer", args: true },
];

/** What every Claude Code answers to, before a turn says what this one has. */
export const CLAUDE_CODE_DEFAULT = ["compact", "context"];

/** Claude Code's commands Lumo leaves out: a new chat is Lumo's /new. */
const CLAUDE_CODE_HIDDEN = new Set(["clear"]);

const CLI_NOTES: Record<string, string> = {
  compact: SLASH_STRINGS.compact,
  context: SLASH_STRINGS.context,
};

/** A command's name as a CLI may report it: letters, digits and `-_:.`. */
export function isCommandName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,63}$/.test(name);
}

/**
 * The menu's commands with `provider`: Lumo's (the shield's only for the
 * CLIs), then Claude Code's (`reported`, as its last turn listed them).
 */
export function slashCommands(provider: string, reported: readonly string[] | null): SlashCommand[] {
  const lumo = LUMO.filter((c) => c.action !== "permissions" || isCliProvider(provider));
  if (provider !== "claude-code") {
    return [...lumo, { name: "compact", note: SLASH_STRINGS.compact, icon: "terminal", kind: "cli", off: SLASH_STRINGS.onlyClaudeCode }];
  }
  const taken = new Set(lumo.map((c) => c.name));
  const seen = new Set<string>();
  const cli: SlashCommand[] = [];
  for (const name of reported && reported.length > 0 ? reported : CLAUDE_CODE_DEFAULT) {
    if (!isCommandName(name) || taken.has(name) || CLAUDE_CODE_HIDDEN.has(name) || seen.has(name)) continue;
    seen.add(name);
    cli.push({ name, note: CLI_NOTES[name] ?? "", icon: "terminal", kind: "cli" });
  }
  return [...lumo, ...cli];
}

/** What the menu filters by: the word after a leading "/", or null when the menu has no business showing. */
export function slashQuery(value: string): string | null {
  const m = /^\/(\S*)$/.exec(value);
  return m ? m[1].toLowerCase() : null;
}

/** The commands `query` picks: those starting with it first, then those containing it. */
export function slashMatches(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  if (!query) return [...commands];
  const q = query.toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  const contains = commands.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q));
  return [...starts, ...contains];
}

/** A typed message that is one of Lumo's own commands, run here instead of sent (arguments: only /timer takes any). */
export function lumoCommand(text: string, provider: string): SlashAction | null {
  const m = /^\/(\S+)\s*$/.exec(text.trim());
  if (!m) return null;
  const c = slashCommands(provider, null).find((c) => c.kind === "lumo" && c.name === m[1].toLowerCase());
  return c && !c.args ? c.action ?? null : null;
}
