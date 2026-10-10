// Which permission requests are simple enough to answer from the closed
// island (Settings → Island → "Allow simple requests from the closed island"):
// tools that only read, and shell commands that only look. Anything else —
// an edit, a write, a command that changes something, or one this cannot
// read with certainty — opens the island on its full card, as before.
//
// Answering is always an explicit click on Allow or Deny: nothing here allows
// anything by itself. It only decides where the buttons are.

/** Tools that only read (Claude Code's names, and the common ones of other agents). */
const READ_TOOLS = new Set([
  "read", "glob", "grep", "ls", "notebookread", "websearch", "todowrite", "todoread",
  "read_file", "list_directory", "list_dir", "search_files", "view", "find_files",
]);

/** Tools that run a shell command, whose command is read below. */
const SHELL_TOOLS = new Set(["bash", "shell", "powershell", "run_shell_command", "exec", "local_shell", "terminal"]);

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
    const command = input.command ?? input.cmd ?? input.script;
    const text = Array.isArray(command) ? command.join(" ") : command;
    return typeof text === "string" && isLookingCommand(text);
  }
  return false;
}
