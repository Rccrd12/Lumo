// Computer use for the chat's Claude Code (src-tauri/src/computer.rs, lumo-hook
// --mcp): what one of its actions does, in words, for the Allow / Deny card.
// Approving "mcp__lumo__left_click" says nothing; approving "Click · 640, 320"
// or "Type · Hello" says what will happen.
//
// Pure: the tool's name and input in, the card's line out.

import { N_, t } from "../i18n/i18n";

/** The MCP server's tools are `mcp__lumo__<name>`. */
const PREFIX = "mcp__lumo__";

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
  stopped: N_("Stopped: Claude no longer uses the computer"),
  using: N_("Using the computer"),
};

/** Each way of scrolling, in full: a direction alone is also a value elsewhere ("left"). */
const SCROLLS: Record<string, string> = {
  up: N_("Scroll up"),
  down: N_("Scroll down"),
  left: N_("Scroll left"),
  right: N_("Scroll right"),
};

/** Typed text on the card: long enough to know it, on one line. */
const TYPED_PREVIEW = 120;

/** True for one of Lumo's computer use tools. */
export function isComputerTool(tool: string): boolean {
  return tool.startsWith(PREFIX);
}

function point(v: unknown): string | null {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number") ? `${v[0]}, ${v[1]}` : null;
}

/**
 * The card's line for a computer use action ("Click · 640, 320", "Type ·
 * Hello", "Press · ctrl+s"), or null when `tool` is not one of Lumo's.
 */
export function describeComputerAction(tool: string, input: Record<string, unknown>): string | null {
  if (!isComputerTool(tool)) return null;
  const name = tool.slice(PREFIX.length);
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
      const text = typeof input.text === "string" ? input.text.replace(/\s+/g, " ").trim() : "";
      const shown = [...text].length > TYPED_PREVIEW ? `${[...text].slice(0, TYPED_PREVIEW - 1).join("")}…` : text;
      return line(COMPUTER_TEXT.type, shown);
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
