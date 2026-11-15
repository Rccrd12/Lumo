// While the computer is in use, the island's clicks never reach its window
// (src-tauri/src/click_hold.rs): Windows would bring it to the front and close
// what the agent opened. Rust hands each press and release here instead, and
// the page clicks what is under them, as the click itself would have.

import { Bridge } from "../core/bridge";

let pressed: Element | null = null;

/** What the log says a click landed on: its tag and first class. */
function what(e: Element | null): string {
  if (!e) return "nothing";
  const cls = typeof e.className === "string" ? e.className.split(" ")[0] : "";
  return cls ? `${e.tagName?.toLowerCase()}.${cls}` : String(e.tagName ?? "?").toLowerCase();
}

/** The innermost element holding both `a` and `b`, where a click lands. */
function common(a: Element, b: Element): Element | null {
  for (let e: Element | null = a; e; e = e.parentElement) if (e.contains(b)) return e;
  return null;
}

/** A press (`down`) or release at `x`, `y` (CSS pixels in the island's page). */
export function heldClick(down: boolean, x: number, y: number): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const at = document.elementFromPoint(x, y);
  const init: MouseEventInit = {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: down ? 1 : 0,
  };
  void Bridge.log(`held click ${down ? "down" : "up"} at ${Math.round(x)},${Math.round(y)} on ${what(at)}`);
  if (down) {
    pressed = at;
    at?.dispatchEvent(new MouseEvent("mousedown", init));
    // A field pressed gets the cursor (the press takes the keyboard for it, as a real one would).
    if (at instanceof HTMLInputElement || at instanceof HTMLTextAreaElement) at.focus();
    return;
  }
  const from = pressed;
  pressed = null;
  (at ?? window).dispatchEvent(new MouseEvent("mouseup", init));
  const target = from && at ? common(from, at) : null;
  target?.dispatchEvent(new MouseEvent("click", init));
}
