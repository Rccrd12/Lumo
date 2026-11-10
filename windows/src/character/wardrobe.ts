// The wardrobe's pure logic. Besides the island's edge light (core/layout.ts
// EDGE_LIGHTS), the wardrobe view picks the mouse Claude wears while it uses
// the computer, stored in the preferences as `computerCursor` and `computerAim`.

import { N_, labels, t } from "../i18n/i18n";

/**
 * The mouse Claude wears while it uses the computer (computer.rs draws it),
 * picked in the wardrobe and stored as `computerCursor`: a dark arrow with a
 * white edge, or Lucciola's butter one. Keep the raw values stable once shipped.
 */
export const COMPUTER_CURSORS = ["direct", "lucciola"] as const;

export type ComputerCursor = (typeof COMPUTER_CURSORS)[number];

export const DEFAULT_COMPUTER_CURSOR: ComputerCursor = "direct";

// ── User-visible strings ──────────────────────────────────────────────────────

/** Claude's mouse, by its names, and the Aim switch beside it. */
export const COMPUTER_CURSOR_KEYS: Record<ComputerCursor, string> = {
  direct: N_("Direct · the dark arrow"),
  lucciola: N_("Lucciola · the butter arrow"),
};

export const COMPUTER_CURSOR_LABELS: Record<ComputerCursor, string> = labels(COMPUTER_CURSOR_KEYS);

export const AIM_KEY = N_("Aim · corners close in before a click");

// ── Logic ─────────────────────────────────────────────────────────────────────

/** A stored mouse → a mouse. Anything unknown is the dark arrow (computer.rs reads it the same way). */
export function parseComputerCursor(raw: unknown): ComputerCursor {
  return raw === "lucciola" ? "lucciola" : DEFAULT_COMPUTER_CURSOR;
}

/** One of Claude's mice, or the Aim switch, under the pointer. */
export interface CursorHover {
  cursor: ComputerCursor | "aim";
}

/** The grey text at the right of the wardrobe header for a mouse, or the Aim switch, under the pointer. */
export function cursorName(hovered: CursorHover): string {
  return hovered.cursor === "aim" ? t(AIM_KEY) : COMPUTER_CURSOR_LABELS[hovered.cursor];
}
