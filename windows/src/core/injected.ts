// What Claude Code writes into a session as if the user had typed it, and that
// reaches UserPromptSubmit as its `prompt`: the note that a background task
// (a command, an agent) is over (`<task-notification>`), reminders meant for
// the model (`<system-reminder>`), what a slash command or a `!` command
// printed. The island never shows these tags: a task's note becomes a step of
// its own words, the rest says nothing.

/** A background task's note: how it ended and what it was. */
export interface TaskNote {
  /** Claude Code's `<status>`: completed, failed, killed… ("" when it says none). */
  status: string;
  /** What ran, from the summary's quotes (`Background command "npm test" completed` → "npm test"), else "". */
  name: string;
  /** The summary and the result in plain words, for the step's detail. */
  text: string;
}

export type PromptKind =
  /** Typed by the user (a slash command or a `!` command as typed): `text` is what to show. */
  | { kind: "user"; text: string }
  /** A background task is over. */
  | { kind: "task"; note: TaskNote }
  /** Only words for the model: nothing to show. */
  | { kind: "hidden" };

/** Blocks that are for the model only, wherever they are in the prompt. */
const HIDDEN_TAGS = [
  "system-reminder", "local-command-stdout", "local-command-stderr", "local-command-caveat",
  "bash-stdout", "bash-stderr", "user-prompt-submit-hook", "command-message", "command-contents",
];

/** A tag of Claude Code's own: lower case, with a hyphen (`<task-notification>`), never one of HTML's. */
const OWN_TAG = /^<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)>/;

/** The text inside `<tag>…</tag>` (to the end when the relay cut the prompt before its closing tag), or null. */
function inner(text: string, tag: string): string | null {
  const open = text.indexOf(`<${tag}>`);
  if (open < 0) return null;
  const from = open + tag.length + 2;
  const close = text.indexOf(`</${tag}>`, from);
  return (close < 0 ? text.slice(from) : text.slice(from, close)).trim();
}

/** `text` without each `<tag>…</tag>` block (an unclosed one runs to the end). */
function without(text: string, tag: string): string {
  let out = text;
  for (;;) {
    const open = out.indexOf(`<${tag}>`);
    if (open < 0) return out;
    const close = out.indexOf(`</${tag}>`, open);
    out = out.slice(0, open) + (close < 0 ? "" : out.slice(close + tag.length + 3));
  }
}

function taskNote(body: string): TaskNote {
  const summary = (inner(body, "summary") ?? "").replace(/\s+/g, " ");
  const result = inner(body, "result") ?? "";
  const quoted = summary.match(/"([^"]+)"/);
  return {
    status: (inner(body, "status") ?? "").toLowerCase(),
    name: quoted ? quoted[1].trim() : "",
    text: [summary, result].filter(Boolean).join("\n\n"),
  };
}

/** What a session's prompt is: the user's words, a background task's note, or nothing to show. */
export function readPrompt(prompt: string): PromptKind {
  const note = inner(prompt, "task-notification");
  if (note != null && prompt.trimStart().startsWith("<task-notification>")) return { kind: "task", note: taskNote(note) };
  // A slash command as typed: `/name args`.
  const command = inner(prompt, "command-name");
  if (command != null) {
    const args = inner(prompt, "command-args") ?? "";
    const name = command.startsWith("/") ? command : `/${command}`;
    return { kind: "user", text: args ? `${name} ${args}` : name };
  }
  // A `!` command as typed.
  const bash = inner(prompt, "bash-input");
  if (bash != null) return bash ? { kind: "user", text: `! ${bash}` } : { kind: "hidden" };
  let text = prompt;
  for (const tag of HIDDEN_TAGS) text = without(text, tag);
  text = text.trim();
  // Any other block of Claude Code's own the prompt starts with is not the user's either.
  for (let own = text.match(OWN_TAG); own; own = text.match(OWN_TAG)) text = without(text, own[1]).trim();
  return text ? { kind: "user", text } : { kind: "hidden" };
}
