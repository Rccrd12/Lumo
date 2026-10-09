// Gemini Live — what was said, as Google transcribes it in pieces while the
// user and Gemini talk, put together line by line for the call view and the
// chat history.

import type { SavedTurn } from "../core/chats";

export interface LiveLine {
  role: "user" | "model";
  text: string;
}

/** Lines the view keeps; the history gets all of them. */
const MAX_LINES = 400;

export class Transcript {
  lines: LiveLine[] = [];
  /** The line the next piece of the same speaker joins, if it is still open. */
  private open: LiveLine | null = null;

  /** A piece of what the user said (or typed, `typed`: it is a whole line). */
  heard(text: string, typed = false) {
    this.add("user", text, typed);
  }

  /** A piece of what Gemini said. */
  said(text: string) {
    this.add("model", text, false);
  }

  /** Gemini's turn is over, or the user spoke over it: the next piece starts a line. */
  close() {
    this.open = null;
  }

  private add(role: LiveLine["role"], text: string, whole: boolean) {
    if (!text) return;
    if (this.open?.role !== role || whole) {
      if (!text.trim()) return;
      this.open = { role, text: "" };
      this.lines.push(this.open);
      if (this.lines.length > MAX_LINES) this.lines.shift();
    }
    this.open.text = joinPiece(this.open.text, text);
    if (whole) this.open = null;
  }

  clear() {
    this.lines = [];
    this.open = null;
  }

  /** The conversation as chat turns: one per line, a speaker's lines in a row joined. */
  turns(): SavedTurn[] {
    const out: SavedTurn[] = [];
    for (const line of this.lines) {
      const content = line.text.trim();
      if (!content) continue;
      const role = line.role === "user" ? "user" : "assistant";
      const last = out[out.length - 1];
      if (last?.role === role) last.content = `${last.content}\n\n${content}`;
      else out.push({ role, content });
    }
    return out;
  }
}

/**
 * Google's pieces carry their own spaces (and none between Chinese
 * characters), so they are joined as they come; only a line's first piece
 * loses its leading space.
 */
export function joinPiece(sofar: string, piece: string): string {
  return sofar ? sofar + piece : piece.replace(/^\s+/, "");
}
