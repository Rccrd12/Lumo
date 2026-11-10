// The wardrobe's logic: the mouse Claude wears while it uses the computer
// (src/character/wardrobe.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { cursorName, parseComputerCursor } from "../src/character/wardrobe.ts";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";

test("Claude's mouse: the dark arrow unless Lucciola was picked, as computer.rs reads it", () => {
  assert.equal(parseComputerCursor("lucciola"), "lucciola");
  assert.equal(parseComputerCursor("direct"), "direct");
  for (const raw of [undefined, null, "", "orange", 3]) assert.equal(parseComputerCursor(raw), "direct");
  assert.equal(DEFAULT_SETTINGS.computerCursor, "direct");
  assert.equal(DEFAULT_SETTINGS.computerAim, true);
  assert.equal(cursorName({ cursor: "direct" }), "Direct · the dark arrow");
  assert.equal(cursorName({ cursor: "lucciola" }), "Lucciola · the butter arrow");
  assert.equal(cursorName({ cursor: "aim" }), "Aim · corners close in before a click");
});
