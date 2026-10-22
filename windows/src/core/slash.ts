// The chat's commands: what the menu offers once "/" is the field's first
// character (views/chat.ts draws it). Lumo's own commands work with every
// provider and never reach the AI; Claude Code's go to the CLI as they are
// typed (claude_code.rs), and the list is the one its last turn reported
// (`chat-commands`), else the few every Claude Code has. Antigravity CLI runs
// with its commands turned off (antigravity_cli.rs) and the other providers
// have none. Only what can be used with the provider picked is listed.
//
// The user's tools (the Tools tab) that have a command come between the two:
// `/pdfcraft merge these two files` asks the AI to use that tool for what
// follows, with every provider that can use the user's tools, once the
// supervisor has read the tool as it is (as agents get it). Pure data and
// helpers, so they can be tested without a webview.

import { N_ } from "../i18n/i18n";
import { isCliProvider } from "./providers";

/** What one of Lumo's own commands does in the chat. */
export type SlashAction = "new" | "history" | "model" | "attach" | "screen" | "permissions" | "timer";

export interface SlashCommand {
  /** Without the slash. */
  name: string;
  /** What it does, as an N_ key; a CLI's own command without one says whose it is. */
  note: string;
  /** Shown as it is instead of `note`: a tool's name. */
  text?: string;
  /** An ICONS name (views/icons.ts). */
  icon: string;
  /** Lumo's own, the CLI's (sent as typed), or one of the user's tools. */
  kind: "lumo" | "cli" | "tool";
  /** The tool it calls. */
  tool?: { id: string; name: string };
  action?: SlashAction;
  /** Waits for what follows it in the field (`/timer 10m pasta`) instead of running. */
  args?: boolean;
}

export const SLASH_STRINGS = {
  timer: N_("Start a timer on the closed island"),
  compact: N_("Sum up the conversation so far"),
  context: N_("Show how full the context is"),
};

/** A tool as the menu needs it (core/tools.ts ToolInfo). */
export interface CommandTool {
  id: string;
  name: string;
  command?: string;
  enabled: boolean;
  missing?: boolean;
  reviewed?: boolean;
  params?: readonly unknown[];
}

/** The providers the user's tools go to (claude.rs, openai_compat.rs, claude_code.rs). */
export function usesYourTools(provider: string): boolean {
  return ["", "anthropic", "openai", "google", "openrouter", "claude-code"].includes(provider);
}

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
export function slashCommands(provider: string, reported: readonly string[] | null, tools: readonly CommandTool[] = []): SlashCommand[] {
  const lumo = [...LUMO.filter((c) => c.action !== "permissions" || isCliProvider(provider)), ...toolCommands(provider, tools)];
  if (provider !== "claude-code") return lumo;
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

/** The commands of the user's tools the provider can use: on, reviewed as they are, each once. */
function toolCommands(provider: string, tools: readonly CommandTool[]): SlashCommand[] {
  if (!usesYourTools(provider)) return [];
  const taken = new Set(LUMO.map((c) => c.name));
  const out: SlashCommand[] = [];
  for (const tool of tools) {
    const name = tool.command ?? "";
    if (!tool.enabled || tool.missing || !tool.reviewed || !isCommandName(name) || taken.has(name)) continue;
    taken.add(name);
    out.push({
      name, note: "", text: tool.name, icon: "wrench", kind: "tool", tool: { id: tool.id, name: tool.name },
      // A tool with something to be told waits for it in the field.
      args: (tool.params?.length ?? 0) > 0,
    });
  }
  return out;
}

/** A typed message that calls one of the user's tools ("/pdfcraft merge a.pdf"): the tool and what follows. */
export function toolCommand(text: string, provider: string, tools: readonly CommandTool[]): { tool: { id: string; name: string }; rest: string } | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  const c = toolCommands(provider, tools).find((c) => c.name === m[1].toLowerCase());
  return c?.tool ? { tool: c.tool, rest: (m[2] ?? "").trim() } : null;
}

/** What goes to the AI for a tool's command: use that tool, for what the user wrote after it. */
export function toolAsk(tool: { id: string; name: string }, rest: string): string {
  const ask = `Use my Lumo tool "${tool.name}" (tool id: ${tool.id}) for this.`;
  return rest ? `${ask}\n\n${rest}` : ask;
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
