// Which permission requests are simple enough to answer from the closed
// island (Settings → Island → "Allow simple requests from the closed island"):
// tools that only read, and shell commands that only look. Anything else —
// an edit, a write, a command that changes something, or one this cannot
// read with certainty — opens the island on its full card, as before.
//
// Answering is always an explicit click on Allow or Deny: nothing here allows
// anything by itself. It only decides where the buttons are.

import { N_ } from "../i18n/i18n";
import { buildFileDiff } from "./diff";
import type { ApprovalInfo } from "./state";

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
const FIND_ACTING = /\s-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)(\s|$)/;

/** Options that make a looking command write a file or run a program. */
const ACTING_OPTIONS: Record<string, RegExp> = {
  rg: /^--pre(=|$)/,
  tree: /^-o$/,
  date: /^(-s|--set)(=|$)/,
};

/** git's options before the subcommand that change nothing ("-C <dir>" is read on its own). */
const GIT_QUIET_OPTIONS = new Set(["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs"]);

/** `git branch` arguments that only list. */
const BRANCH_LISTING = new Set(["-a", "-r", "-v", "-vv", "--all", "--remotes", "--list", "--show-current"]);

/** One command of a pipeline or a list: true when it only looks. */
function looks(segment: string): boolean {
  const words = segment.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  // "C:\Windows\System32\where.exe" or "/usr/bin/ls" → "where", "ls".
  const name = words[0].split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
  if (name === "git") {
    // Options before the subcommand: only the few that change nothing. "-c",
    // "--config-env", "--exec-path" and the like can make git run a program
    // ("git -ccore.pager=… log"), and "--git-dir"/"--work-tree" point it elsewhere.
    let at = 1;
    while (at < words.length && words[at].startsWith("-")) {
      const option = words[at];
      if (option === "-C") at += 2;
      else if (GIT_QUIET_OPTIONS.has(option)) at += 1;
      else return false;
    }
    const sub = words[at]?.toLowerCase() ?? "";
    const rest = words.slice(at + 1);
    // "git branch new" makes a branch: only the listing forms look.
    if (sub === "branch") return rest.every((w) => BRANCH_LISTING.has(w));
    if (sub === "remote") return rest.length === 0 || (rest.length === 1 && rest[0] === "-v");
    // "git reflog expire" and "git reflog delete" rewrite the reflog.
    if (sub === "reflog" && rest.some((w) => w === "expire" || w === "delete")) return false;
    // "git grep -O<program>" opens the matches in that program.
    if (sub === "grep" && rest.some((w) => /^(-O|--open-files-in-pager)/.test(w))) return false;
    return GIT_LOOKING.has(sub) && !words.some((w) => /^--output(=|$)/.test(w));
  }
  if (!LOOKING.has(name)) return false;
  if (name === "find" && FIND_ACTING.test(` ${words.slice(1).join(" ")}`)) return false;
  // "hostname new" renames the computer.
  if (name === "hostname") return words.length === 1;
  const acting = ACTING_OPTIONS[name];
  return !acting || !words.slice(1).some((w) => acting.test(w));
}

/** A shell command made only of commands that look, with no redirection or substitution. */
export function isLookingCommand(command: string): boolean {
  const text = command.trim();
  if (!text || text.length > 400) return false;
  // Writing to a file, running something inside (a PowerShell script block or
  // subexpression too), or a background job: not simple.
  if (/[>`{}()]|\$\(|<\(|(^|[^&])&($|[^&])/.test(text)) return false;
  // A lone carriage return ends a command too, in PowerShell and in cmd.
  return text.split(/\|\||&&|\r\n?|[|;\n]/).every(looks);
}

/** The longest command or path the closed island's card takes: what its two lines hold. */
export const QUICK_COMMAND_MAX = 80;

const isShortLine = (text: string) => !/[\r\n]/.test(text.trim()) && text.trim().length <= QUICK_COMMAND_MAX;

/**
 * True when the request only reads or looks, and can be answered from the
 * closed island: whole on its two lines, so Allow there never allows a line
 * that was not on screen (a longer one goes to the full card).
 */
export function isSimpleRequest(tool: string, input: Record<string, unknown>): boolean {
  const name = tool.toLowerCase();
  if (READ_TOOLS.has(name)) return Object.values(input).every((v) => typeof v !== "string" || isShortLine(v));
  if (SHELL_TOOLS.has(name)) {
    const command = input.command ?? input.cmd ?? input.script ?? input.CommandLine;
    const text = Array.isArray(command) ? command.join(" ") : command;
    return typeof text === "string" && isShortLine(text) && isLookingCommand(text);
  }
  return false;
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
  delete: N_("Deletes a file."),
  move: N_("Moves or renames a file."),
  web: N_("Reads a web page."),
  mcp: N_("Uses a tool of {server} (MCP)."),
} as const;

/** Tools that change a file (Claude Code's and Antigravity's). */
const EDIT_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit", "write_to_file", "replace_file_content", "multi_replace_file_content", "write_file", "replace"]);

/** A deletion and a move, as the cards of Copilot CLI and Cursor CLI name them (acp_chat.rs card). */
const DELETE_TOOLS = new Set(["delete"]);
const MOVE_TOOLS = new Set(["move"]);

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
  if (DELETE_TOOLS.has(name)) return { text: REQUEST_KINDS.delete };
  if (MOVE_TOOLS.has(name)) return { text: REQUEST_KINDS.move };
  if (WEB_TOOLS.has(name)) return { text: REQUEST_KINDS.web };
  const mcp = /^mcp__(.+?)__/.exec(tool);
  if (mcp) return { text: REQUEST_KINDS.mcp, vars: { server: mcp[1] } };
  return null;
}

/** What a file tool asks to write, counted for its permission card: the lines it adds and removes, and a new text's size. */
export interface EditStat {
  added: number;
  removed: number;
  /** Write: the size of the whole text it writes. */
  bytes?: number;
}

/**
 * The lines a Write, Edit, MultiEdit or NotebookEdit asks to change, for the
 * line under the file on its card: the card names the file Allow allows, and
 * this says how much is written there without showing the text. Null for any
 * other tool, or a call that changes nothing.
 */
export function editStat(tool: string, input: Record<string, unknown>): EditStat | null {
  if (tool === "NotebookEdit") {
    const source = input.new_source;
    if (typeof source !== "string" || input.edit_mode === "delete" || !source) return null;
    const lines = source.replace(/\r\n/g, "\n").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return { added: lines.length, removed: 0 };
  }
  if (tool !== "Write" && tool !== "Edit" && tool !== "MultiEdit") return null;
  const diff = buildFileDiff(tool, input);
  if (!diff) return null;
  const stat: EditStat = { added: diff.added, removed: diff.removed };
  if (tool === "Write" && typeof input.content === "string") stat.bytes = new TextEncoder().encode(input.content).length;
  return stat;
}

/** What a permission card offers besides Deny (views.ts buildApproval). */
export interface ApprovalOffer {
  /** Allow, or Approve on a plan. */
  allow: boolean;
  /** "Too long to show here whole": the request was cut, and Allow is gone. */
  cutNote: boolean;
  sessionAllow: boolean;
  /** "Approve and let it edit files without asking", on a plan from a session. */
  planEdits: boolean;
  /** The line that sends the request back: to the agent named on the card, or to its own window. */
  answerThere: "agent" | "elsewhere" | null;
}

/**
 * The buttons of a permission card. A request the relay had to cut
 * (`cut`) was never on the card whole: nothing allows it from here, a plan's
 * Approve included (pipe.rs refuses it anyway), so no button is left that
 * does nothing. Only Deny, and the agent's own prompt where it has one.
 */
export function approvalOffer(req: Pick<ApprovalInfo, "cut" | "email" | "plan" | "sessionAllow" | "fromChat" | "answerIn"> | null | undefined): ApprovalOffer {
  const email = !!req?.email;
  const plan = !email && (req?.plan?.length ?? 0) > 0;
  const cut = req?.cut === true && !email;
  const elsewhere = cut && !req?.fromChat;
  return {
    allow: !cut,
    cutNote: cut,
    sessionAllow: req?.sessionAllow === true && !plan && !cut,
    planEdits: plan && !req?.fromChat && !cut,
    answerThere: req?.answerIn && !plan ? "agent" : elsewhere ? "elsewhere" : null,
  };
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

/**
 * The request whose card Y and N may answer: one the user turned to by
 * themselves, with a click on the card or the shortcut to the waiting card
 * (island/shortcuts.ts). A card that comes up while the chat is being typed
 * in leaves Y and N to the chat.
 */
let keysFor: string | null = null;

/** Y and N now answer the card of `requestId`: the user turned to it. */
export function armApprovalKeys(requestId: string | null | undefined): void {
  keysFor = requestId || null;
}

/** Whether Y and N answer the card of `requestId`. */
export function approvalKeysArmed(requestId: string | null | undefined): boolean {
  return keysFor != null && keysFor === requestId;
}
