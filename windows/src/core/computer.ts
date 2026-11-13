// Computer use for the chat's Claude Code (src-tauri/src/computer.rs, lumo-hook
// --mcp): what one of its actions does, in words, for the Allow / Deny card.
// Approving "mcp__lumo__left_click" says nothing; approving "Click · 640, 320"
// or "Type · Hello" says what will happen.
//
// Pure: the tool's name and input in, the card's line out.

import { N_, t } from "../i18n/i18n";

/** Lumo's tools (lumo-hook --mcp, hook/src/mcp.rs NAMES). */
const NAMES = new Set([
  "screenshot", "zoom", "left_click", "right_click", "middle_click", "double_click", "triple_click", "mouse_move",
  "left_click_drag", "scroll", "type", "key", "wait", "cursor_position",
]);

/**
 * Which of Lumo's tools an agent's tool name is: Claude Code calls them
 * `mcp__lumo__<name>`, Antigravity CLI may put something else in front
 * (`mcp_lumo_<name>`, `lumo/<name>`). Null for any other tool.
 */
export function computerToolName(tool: string): string | null {
  const m = /(?:^|[_/.:-])lumo[_/.:-]+([a-z_]+)$/i.exec(tool);
  const name = m?.[1].toLowerCase() ?? "";
  return NAMES.has(name) ? name : null;
}

export const COMPUTER_TEXT = {
  click: N_("Click"),
  rightClick: N_("Right click"),
  middleClick: N_("Middle click"),
  doubleClick: N_("Double click"),
  tripleClick: N_("Triple click"),
  move: N_("Move the mouse"),
  drag: N_("Drag"),
  type: N_("Type"),
  key: N_("Press"),
  screenshot: N_("Look at the screen"),
  zoom: N_("Look closer at the screen"),
  wait: N_("Wait"),
  cursor: N_("Find the mouse"),
  here: N_("where the mouse is"),
  stopped: N_("Computer use over"),
  using: N_("Using the computer"),
};

/**
 * The permission card's line when Windows says what is at the point
 * (views/computer-card.ts): the action and the thing it acts on. `{name}` is
 * what Windows calls it (UI Automation), drawn apart from the words.
 */
export const COMPUTER_ON_TEXT = {
  left_click: N_("Click on «{name}»"),
  right_click: N_("Right click on «{name}»"),
  middle_click: N_("Middle click on «{name}»"),
  double_click: N_("Double click on «{name}»"),
  triple_click: N_("Triple click on «{name}»"),
  mouse_move: N_("Move the mouse to «{name}»"),
  left_click_drag: N_("Drag to «{name}»"),
  scroll_up: N_("Scroll up on «{name}»"),
  scroll_down: N_("Scroll down on «{name}»"),
  scroll_left: N_("Scroll left on «{name}»"),
  scroll_right: N_("Scroll right on «{name}»"),
};

/** Each way of scrolling, in full: a direction alone is also a value elsewhere ("left"). */
const SCROLLS: Record<string, string> = {
  up: N_("Scroll up"),
  down: N_("Scroll down"),
  left: N_("Scroll left"),
  right: N_("Scroll right"),
};


/** True for one of Lumo's computer use tools. */
export function isComputerTool(tool: string): boolean {
  return computerToolName(tool) != null;
}

/** Typed text for the card: ⏎ at each Enter (then a new line), ⇥ at each Tab. */
function typedText(text: string): string {
  return text.replace(/\r\n?|\n/g, "⏎\n").replace(/\t/g, "⇥");
}

/** A point the agent gave ([x, y], two numbers), or null. */
function pointOf(v: unknown): [number, number] | null {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n)) ? [v[0], v[1]] : null;
}

function point(v: unknown): string | null {
  const p = pointOf(v);
  return p ? `${p[0]}, ${p[1]}` : null;
}

/** The tools that act on a point of the screen: the card shows it (the drag: where it ends). */
const POINTED = new Set(["left_click", "right_click", "middle_click", "double_click", "triple_click", "mouse_move", "left_click_drag", "scroll"]);

/**
 * The point a computer use action acts on, in the pixels of the agent's last
 * screenshot: a click's, a move's, a scroll's, a drag's end. Null for an
 * action with no point (typing, keys, looking) or one given none (where the
 * mouse already is).
 */
export function computerPoint(tool: string, input: Record<string, unknown>): [number, number] | null {
  const name = computerToolName(tool);
  return name != null && POINTED.has(name) ? pointOf(input.coordinate) : null;
}

/**
 * The card's words for an action on a thing Windows named ("Click on «Save
 * as…»"), in three parts so the name can be drawn apart: the words before it,
 * the name, the words after it (the order is the language's). Null for an
 * action with no point, or no name.
 */
export function computerActionOn(tool: string, input: Record<string, unknown>, name: string): { before: string; name: string; after: string } | null {
  const tool_ = computerToolName(tool);
  const named = name.replace(/\s+/g, " ").trim();
  if (tool_ == null || !POINTED.has(tool_) || !named) return null;
  // A scroll that does not say which way is not said on the thing: the card
  // keeps its plain line rather than a way it may not go.
  const dir = scrollDirection(input);
  if (tool_ === "scroll" && dir == null) return null;
  const key = (tool_ === "scroll" ? `scroll_${dir}` : tool_) as keyof typeof COMPUTER_ON_TEXT;
  const words = t(COMPUTER_ON_TEXT[key]);
  const at = words.indexOf("{name}");
  if (at < 0) return { before: words, name: "", after: "" };
  // The quotes go with the name: the words around it are what is done.
  const open = /[«“„"'‘「『][\s\u00a0]*$/.exec(words.slice(0, at))?.[0] ?? "";
  const close = /^[\s\u00a0]*[»”"'’」』]/.exec(words.slice(at + 6))?.[0] ?? "";
  return { before: words.slice(0, at - open.length), name: `${open}${named}${close}`, after: words.slice(at + 6 + close.length) };
}

/**
 * Which way a scroll goes, from the request's own input (its
 * scroll_direction), null when it says none of the four. The card takes it
 * from there, never from its translated line.
 */
export function scrollDirection(input: Record<string, unknown>): "up" | "down" | "left" | "right" | null {
  const dir = input.scroll_direction;
  return dir === "up" || dir === "down" || dir === "left" || dir === "right" ? dir : null;
}

/**
 * describeComputerAction's line in two: what is done ("Click") and on what
 * ("640, 320", the text to type, the keys), "" when it says nothing more.
 */
export function splitComputerLine(line: string): { label: string; detail: string } {
  const at = line.indexOf(" · ");
  return at < 0 ? { label: line, detail: "" } : { label: line.slice(0, at), detail: line.slice(at + 3) };
}

/**
 * Where the screen's crop goes in the card's `boxW`×`boxH` thumbnail, and
 * where its point lands there: the crop fills the box (cut on two sides if
 * its shape differs), moved so the point stays inside, at least `margin` from
 * the edges when it can.
 */
export function peekPlacement(
  crop: { width: number; height: number; at: [number, number] },
  boxW: number,
  boxH: number,
  margin = 8,
): { scale: number; left: number; top: number; x: number; y: number } {
  const w = crop.width > 0 ? crop.width : boxW;
  const h = crop.height > 0 ? crop.height : boxH;
  const scale = Math.max(boxW / w, boxH / h);
  const fit = (p: number, size: number, box: number) => {
    const scaled = size * scale;
    // Centred, then moved just enough for the point to be in the box.
    let off = (box - scaled) / 2;
    const at = p * scale + off;
    const m = Math.min(margin, box / 2);
    if (at < m) off += m - at;
    if (at > box - m) off -= at - (box - m);
    // Never past the crop's own edges.
    return Math.min(0, Math.max(box - scaled, off));
  };
  const left = fit(crop.at[0], w, boxW);
  const top = fit(crop.at[1], h, boxH);
  const round = (n: number) => Math.round(n * 100) / 100;
  return { scale: round(scale), left: round(left), top: round(top), x: round(crop.at[0] * scale + left), y: round(crop.at[1] * scale + top) };
}

/**
 * The card's line for a computer use action ("Click · 640, 320", "Type ·
 * Hello", "Press · ctrl+s"), or null when `tool` is not one of Lumo's.
 */
export function describeComputerAction(tool: string, input: Record<string, unknown>): string | null {
  const name = computerToolName(tool);
  if (name == null) return null;
  const at = point(input.coordinate) ?? t(COMPUTER_TEXT.here);
  const held = typeof input.text === "string" && input.text.trim() ? ` (${input.text.trim()})` : "";
  const line = (label: string, detail: string) => (detail ? `${t(label)} · ${detail}` : t(label));
  switch (name) {
    case "left_click":
      return line(COMPUTER_TEXT.click, at + held);
    case "right_click":
      return line(COMPUTER_TEXT.rightClick, at + held);
    case "middle_click":
      return line(COMPUTER_TEXT.middleClick, at + held);
    case "double_click":
      return line(COMPUTER_TEXT.doubleClick, at + held);
    case "triple_click":
      return line(COMPUTER_TEXT.tripleClick, at + held);
    case "mouse_move":
      return line(COMPUTER_TEXT.move, at);
    case "left_click_drag": {
      const from = point(input.start_coordinate) ?? "?";
      return line(COMPUTER_TEXT.drag, `${from} → ${at}`);
    }
    case "scroll": {
      const dir = typeof input.scroll_direction === "string" ? input.scroll_direction : "";
      const amount = typeof input.scroll_amount === "number" ? ` ×${input.scroll_amount}` : "";
      return line(SCROLLS[dir] ?? SCROLLS.down, `${at}${amount}`);
    }
    case "type": {
      // All of it, as it will be typed: each line break is an Enter (a
      // command run in a terminal or in Run), each tab a Tab, so both are
      // shown where they fall. The card wraps and scrolls a long text; the
      // relay marks one it had to cut, which can't be allowed.
      const text = typeof input.text === "string" ? typedText(input.text) : "";
      return line(COMPUTER_TEXT.type, text);
    }
    case "key": {
      const keys = typeof input.text === "string" ? input.text.trim() : "";
      const times = typeof input.repeat === "number" && input.repeat > 1 ? ` ×${input.repeat}` : "";
      return line(COMPUTER_TEXT.key, keys + times);
    }
    case "screenshot":
      return t(COMPUTER_TEXT.screenshot);
    case "zoom":
      return t(COMPUTER_TEXT.zoom);
    case "wait":
      return t(COMPUTER_TEXT.wait);
    case "cursor_position":
      return t(COMPUTER_TEXT.cursor);
    default:
      return null;
  }
}
