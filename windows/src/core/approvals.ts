// Which permission requests are simple enough to answer from the closed
// island (Settings → Island → "Allow simple requests from the closed island"):
// tools that only read, and shell commands that only look. Anything else —
// an edit, a write, a command that changes something, or one this cannot
// read with certainty — opens the island on its full card, as before.
//
// Answering is always an explicit click on Allow or Deny: nothing here allows
// anything by itself. It only decides where the buttons are.

import { N_ } from "../i18n/i18n";

/** Tools that only read (Claude Code's names, and the common ones of other agents). */
const READ_TOOLS = new Set([
  "read", "glob", "grep", "ls", "notebookread", "websearch", "todowrite", "todoread",
  "read_file", "list_directory", "list_dir", "search_files", "view", "find_files",
  // Antigravity's
  "view_file", "view_file_outline", "view_code_item", "grep_search", "find_by_name",
]);

/** Tools that run a shell command, whose command is read below. */
const SHELL_TOOLS = new Set(["bash", "shell", "powershell", "run_shell_command", "run_command", "exec", "local_shell", "terminal"]);

/** Commands that only look, whatever their arguments (those that can change something are checked below). */
const LOOKING = new Set([
  "ls", "dir", "pwd", "cat", "type", "head", "tail", "wc", "echo", "which", "where", "whoami", "date",
  "tree", "file", "stat", "du", "df", "grep", "rg", "findstr", "find", "less", "more", "uname", "hostname",
  "get-childitem", "gci", "get-content", "gc", "get-location", "gl", "select-string", "sls", "test-path",
  "get-item", "gi", "resolve-path", "get-date", "get-command", "gcm", "measure-object",
]);

/** git's subcommands that only look. */
const GIT_LOOKING = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "reflog", "grep", "ls-tree",
]);

/** `find` options that act on what they find. */
const FIND_ACTING = /\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/;

/** One command of a pipeline or a list: true when it only looks. */
function looks(segment: string): boolean {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  // "C:\Windows\System32\where.exe" or "/usr/bin/ls" → "where", "ls".
  const name = words[0].split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
  if (name === "git") {
    const sub = words.slice(1).find((w) => !w.startsWith("-"))?.toLowerCase() ?? "";
    if (sub === "branch") return !words.some((w) => /^-(d|D|m|M|c|C|-delete|-move|-copy)$/.test(w)) && words.length <= 3;
    if (sub === "remote") return words.length === 2 || (words.length === 3 && words[2] === "-v");
    return GIT_LOOKING.has(sub) && !words.some((w) => /^--output(=|$)/.test(w));
  }
  if (!LOOKING.has(name)) return false;
  if (name === "find" && FIND_ACTING.test(` ${words.slice(1).join(" ")}`)) return false;
  return true;
}

/** A shell command made only of commands that look, with no redirection or substitution. */
export function isLookingCommand(command: string): boolean {
  const text = command.trim();
  if (!text || text.length > 400) return false;
  // Writing to a file, running something inside, or a background job: not simple.
  if (/[>`]|\$\(|<\(|(^|[^&])&($|[^&])/.test(text)) return false;
  return text.split(/\|\||&&|[|;\n]/).every(looks);
}

/** True when the request only reads or looks, and can be answered from the closed island. */
export function isSimpleRequest(tool: string, input: Record<string, unknown>): boolean {
  const name = tool.toLowerCase();
  if (READ_TOOLS.has(name)) return true;
  if (SHELL_TOOLS.has(name)) {
    const command = input.command ?? input.cmd ?? input.script ?? input.CommandLine;
    const text = Array.isArray(command) ? command.join(" ") : command;
    return typeof text === "string" && isLookingCommand(text);
  }
  return false;
}

/**
 * The chat's Antigravity CLI run in Auto (Settings → chat → the shield): a
 * request this lets through runs without a card. agy has no judgement of its
 * own that Lumo can use headless (antigravity_cli.rs), so this is Lumo's: a
 * command that only looks, as above, and never one agy itself marked as not
 * safe to run alone. Everything else, and anything uncertain, still asks.
 */
export function autoAllows(tool: string, input: Record<string, unknown>): boolean {
  if (input.SafeToAutoRun === false || input.safeToAutoRun === false) return false;
  return isSimpleRequest(tool, input);
}

/**
 * Where agents explain a call in their own words: Claude Code's Bash and
 * PowerShell (`description`), Gemini CLI's shell (`description`), Codex's
 * (`justification`), Antigravity's (`toolSummary`), and a few common others.
 */
const REASON_FIELDS = ["description", "Description", "justification", "explanation", "Explanation", "toolSummary"];

/** The longest explanation the card shows; the whole one is its tooltip anyway. */
const MAX_REASON = 300;

/**
 * What the agent says the request is for, in its own words, on one line; null
 * when it said nothing (or only repeated the command).
 */
export function requestReason(input: Record<string, unknown>): string | null {
  const command = [input.command, input.CommandLine].find((c) => typeof c === "string") as string | undefined;
  for (const field of REASON_FIELDS) {
    const value = input[field];
    if (typeof value !== "string") continue;
    const line = value.replace(/\s+/g, " ").trim();
    if (!line || line === command?.trim()) continue;
    return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line;
  }
  return null;
}

/** What a request does, when the agent did not say: English, shown through t(). */
export const REQUEST_KINDS = {
  looks: N_("Only looks: changes nothing."),
  command: N_("Runs a command that can change things."),
  edit: N_("Changes a file."),
  web: N_("Reads a web page."),
  mcp: N_("Uses a tool of {server} (MCP)."),
} as const;

/** Tools that change a file (Claude Code's and Antigravity's). */
const EDIT_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit", "write_to_file", "replace_file_content", "multi_replace_file_content", "write_file", "replace"]);

/** Tools that read a web page. */
const WEB_TOOLS = new Set(["webfetch", "read_url_content", "web_fetch"]);

/**
 * What the request does, read off the request itself: the line the card shows
 * when the agent gave no reason. Null for a tool it cannot say anything sure
 * about.
 */
export function requestKind(tool: string, input: Record<string, unknown>): { text: string; vars?: Record<string, string> } | null {
  const name = tool.toLowerCase();
  if (isSimpleRequest(tool, input)) return { text: REQUEST_KINDS.looks };
  if (SHELL_TOOLS.has(name)) return { text: REQUEST_KINDS.command };
  if (EDIT_TOOLS.has(name)) return { text: REQUEST_KINDS.edit };
  if (WEB_TOOLS.has(name)) return { text: REQUEST_KINDS.web };
  const mcp = /^mcp__(.+?)__/.exec(tool);
  if (mcp) return { text: REQUEST_KINDS.mcp, vars: { server: mcp[1] } };
  return null;
}

/**
 * Y or N, the keys shown on the permission card's buttons, as a decision; null
 * for any other key, a held key, or one with Ctrl, Alt or the Windows key.
 */
export function approvalKey(
  e: { key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; repeat: boolean },
): "allow" | "deny" | null {
  if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return null;
  const key = e.key.toLowerCase();
  return key === "y" ? "allow" : key === "n" ? "deny" : null;
}
