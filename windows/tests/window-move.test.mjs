// A window dragged or resized across the island (src/island/window-move.ts,
// island.rs window_moving): the cursor riding over the island never opens it,
// nor does letting go of the window there. A file drag is not a window move,
// so it still opens the island for the drop (island.rs may_carry_file).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { heldByWindowMove } from "../src/island/window-move.ts";

/** Runs cursor ticks of [moving, over] and answers whether each counted as on the island. */
function onIsland(ticks) {
  let held = false;
  return ticks.map(([moving, over]) => {
    held = heldByWindowMove(held, moving, over);
    return over && !held;
  });
}

test("a window carried across the island never puts the cursor on it", () => {
  assert.deepEqual(
    onIsland([[true, false], [true, true], [true, true], [true, false], [false, false]]),
    [false, false, false, false, false],
  );
});

test("a window let go on the island: on it only after leaving and coming back", () => {
  assert.deepEqual(
    onIsland([[true, true], [false, true], [false, true], [false, false], [false, true]]),
    [false, false, false, false, true],
  );
});

test("a window let go away from the island leaves the next hover as it was", () => {
  assert.deepEqual(onIsland([[true, false], [false, false], [false, true]]), [false, false, true]);
});

test("without a window being moved, a hover is a hover", () => {
  assert.deepEqual(onIsland([[false, false], [false, true], [false, true]]), [false, true, true]);
});

test("Rust sends the window move with the cursor and the page reads it", () => {
  const rust = readFileSync(new URL("../src-tauri/src/island.rs", import.meta.url), "utf8");
  const platform = readFileSync(new URL("../src-tauri/src/platform/windows.rs", import.meta.url), "utf8");
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const island = readFileSync(new URL("../src/island/island.ts", import.meta.url), "utf8");
  // The payload is camelCase, so window_moving reaches the page as windowMoving.
  assert.match(rust, /#\[serde\(rename_all = "camelCase"\)\]\s*pub struct CursorPayload \{[^}]*pub window_moving: bool,/);
  assert.match(rust, /CursorPayload \{ x, y, window_moving \}/);
  // The foreground thread's move or size loop: what a dragged file never sets.
  assert.match(platform, /pub fn window_moving\(\) -> bool \{[\s\S]*?GetGUIThreadInfo\(0, &mut info\)[\s\S]*?GUI_INMOVESIZE/);
  assert.match(main, /island\.onCursor\(x, y, windowMoving === true\)/);
  // Held, the cursor is off the island: no hover opening, no entry, no love.
  assert.match(island, /const inIsland = !claudes && !this\.windowMoveHold && over;/);
  assert.match(island, /const overBot = !claudes && !this\.windowMoveHold &&/);
});
