// What the computer use overlay draws, worked out without a page (the
// overlay itself is src/computer/main.ts; Rust sends it `computer-fx`).
//
// The overlay covers the screen Claude works on. Rust gives points in the
// screen's physical pixels, from its top left corner; the page draws in CSS
// pixels, which on a scaled display (125 %, 150 %) are bigger.

/** One effect, as computer.rs sends it. Points are [x, y], physical pixels of the screen. */
export type Fx =
  | { kind: "show" }
  | { kind: "hide" }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "stopped" }
  | { kind: "look" }
  | { kind: "move"; from: [number, number]; to: [number, number]; ms: number }
  | { kind: "drag"; from: [number, number]; to: [number, number]; ms: number }
  | { kind: "click"; at: [number, number]; button: "left" | "right" | "middle"; count: number }
  | { kind: "scroll"; at: [number, number]; dx: number; dy: number }
  | { kind: "type"; at: [number, number]; text: string }
  | { kind: "key"; at: [number, number]; keys: string }
  | { kind: "wait"; at: [number, number]; ms: number };

/**
 * Ease in and out (cubic): the same curve computer.rs moves the real mouse
 * on, so the glow that follows it lands with it.
 */
export function ease(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

/** A point of the screen in the page's CSS pixels. */
export function toCss(p: [number, number], dpr: number): { x: number; y: number } {
  const scale = dpr > 0 && Number.isFinite(dpr) ? dpr : 1;
  return { x: p[0] / scale, y: p[1] / scale };
}

/** Where the glide is after `elapsed` of `ms`. */
export function along(from: { x: number; y: number }, to: { x: number; y: number }, elapsed: number, ms: number) {
  const e = ms > 0 ? ease(elapsed / ms) : 1;
  return { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
}

/** Pretty names for the keys of a combination. */
const KEY_NAMES: Record<string, string> = {
  ctrl: "Ctrl", control: "Ctrl", shift: "Shift", alt: "Alt", option: "Alt",
  super: "Win", win: "Win", windows: "Win", cmd: "Win", command: "Win", meta: "Win",
  return: "Enter", enter: "Enter", tab: "Tab", escape: "Esc", esc: "Esc",
  backspace: "⌫", back_space: "⌫", delete: "Del", del: "Del", space: "Space",
  up: "↑", down: "↓", left: "←", right: "→",
  page_up: "PgUp", pageup: "PgUp", prior: "PgUp", page_down: "PgDn", pagedown: "PgDn", next: "PgDn",
  home: "Home", end: "End", insert: "Ins", plus: "+", minus: "−",
};

/** "ctrl+shift+t" → ["Ctrl", "Shift", "T"], as keycaps. */
export function keyCaps(keys: string): string[] {
  const parts: string[] = [];
  let rest = keys.trim();
  while (rest) {
    const i = rest.indexOf("+");
    if (i === 0) {
      parts.push("+");
      rest = rest.slice(rest.startsWith("++") && rest.length === 2 ? 2 : 1);
      continue;
    }
    if (i < 0) {
      parts.push(rest);
      break;
    }
    parts.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => KEY_NAMES[p.toLowerCase()] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)));
}

/** What the typing bubble shows: the end of what was typed, on one line. */
export function typedTail(text: string, max = 28): string {
  const line = text.replace(/\s+/g, " ");
  const chars = [...line];
  return chars.length <= max ? line : `…${chars.slice(chars.length - max + 1).join("")}`;
}
