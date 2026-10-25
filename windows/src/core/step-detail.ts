// What a step shows once opened (views/steps.ts): the part of a hook event its
// one-line row cuts short. No DOM, so it can be tested on its own.

import type { StepDetail } from "./state";

/** Past this, a detail is cut: twenty steps of it stay small. */
export const MAX_DETAIL = 4000;

/** The `tool_input` fields that say what a call acts on, most specific first. */
const CODE_FIELDS = ["command", "pattern", "query", "url", "file_path", "path"] as const;
/** The ones that say why, in words. */
const TEXT_FIELDS = ["description", "prompt"] as const;

function cap(text: string): string {
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)}…` : text;
}

function str(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A TodoWrite list, one task a line, marked by where it stands. */
function todoLines(input: Record<string, unknown>): string | null {
  const todos = input.todos;
  if (!Array.isArray(todos)) return null;
  const marks: Record<string, string> = { completed: "✓", in_progress: "›" };
  const lines = todos
    .map((todo) => {
      if (!todo || typeof todo !== "object") return null;
      const { content, status } = todo as { content?: unknown; status?: unknown };
      if (typeof content !== "string" || !content.trim()) return null;
      return `${marks[typeof status === "string" ? status : ""] ?? "○"} ${content.trim()}`;
    })
    .filter((line): line is string => line != null);
  return lines.length ? lines.join("\n") : null;
}

/**
 * The detail of a tool call: what it acts on (the whole command, path, URL…)
 * and what the agent said it is for. A tool with neither shows its input as it
 * came, so an MCP tool still says what it was given.
 */
export function toolStepDetail(tool: string, input: Record<string, unknown>): StepDetail | null {
  const code = CODE_FIELDS.map((k) => str(input, k)).filter((v): v is string => v != null);
  const text = TEXT_FIELDS.map((k) => str(input, k)).filter((v): v is string => v != null);
  const todos = tool === "TodoWrite" ? todoLines(input) : null;
  if (todos) text.push(todos);
  const detail: StepDetail = {};
  if (text.length) detail.text = cap([...new Set(text)].join("\n\n"));
  if (code.length) detail.code = cap([...new Set(code)].join("\n"));
  if (detail.text || detail.code) return detail;
  if (Object.keys(input).length === 0) return null;
  try {
    return { code: cap(JSON.stringify(input, null, 2)) };
  } catch {
    return null;
  }
}

/** The whole of a text whose row shows only `shown`; nothing when that is all of it. */
export function fullTextDetail(full: string | null | undefined, shown: string): StepDetail | null {
  const text = full?.trim();
  if (!text || text === shown.trim()) return null;
  return { text: cap(text) };
}

/** A failed call: the error the agent got, then what was called. */
export function failureDetail(tool: string, input: Record<string, unknown>, error: unknown): StepDetail | null {
  const call = toolStepDetail(tool, input);
  const message = typeof error === "string" && error.trim() ? cap(error.trim()) : undefined;
  if (!message) return call;
  return { text: message, code: call?.code };
}

/**
 * True when opening the step shows more than its row: a detail that says
 * something the row's own text does not already.
 */
export function addsToRow(detail: StepDetail | null, row: string): detail is StepDetail {
  if (!detail) return false;
  if (detail.text) return true;
  return !!detail.code && !row.includes(detail.code);
}

/**
 * How the steps card shows a step: its own line when that is all there is,
 * the whole text when the line is only its start (a prompt cut at 60), and the
 * line marked as cut when the detail holds the rest (a command cut at 40).
 * `detail` is what is left to open, or null.
 */
export function openedRow(row: string, detail: StepDetail | null): { text: string; detail: StepDetail | null } {
  if (!addsToRow(detail, row)) return { text: row, detail: null };
  if (detail.text && !detail.code && detail.text.startsWith(row) && !detail.text.includes("\n")) {
    return { text: detail.text, detail: null };
  }
  const tail = row.slice(row.lastIndexOf(" · ") + 3);
  const cut = !!detail.code && tail.length > 0 && tail !== detail.code && detail.code.startsWith(tail);
  return { text: cut ? `${row}…` : row, detail };
}
