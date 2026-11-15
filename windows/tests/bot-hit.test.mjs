// Where a press, or the mouse resting, counts as being on Lumo (src/core/layout.ts onLumo):
// on the open island he sits in the top bar, and the view below it keeps its clicks.

import { test } from "node:test";
import assert from "node:assert/strict";
import { NEW_LOOK_BOT, newLookBot, onLumo } from "../src/core/layout.ts";

const TOP_BAR_H = 42; // island.ts TOP_BAR_H: 8 pt inset + 34 pt header
const W = 760;
const placed = newLookBot("prompt", W);
// island.ts updateBotTargets: the canvas is the diameter / 0.6 wide.
const bot = { cx: placed.cx, cy: placed.cy, size: placed.diameter / 0.6 };

test("his eyes in the top bar are still his", () => {
  assert.equal(onLumo(bot.cx, NEW_LOOK_BOT.cy, bot, TOP_BAR_H), true);
  assert.equal(onLumo(bot.cx + 20, 10, bot, TOP_BAR_H), true);
  assert.equal(onLumo(bot.cx, TOP_BAR_H - 1, bot, TOP_BAR_H), true);
});

test("a provider chip right under his eyes is the chip's, not his", () => {
  // The model picker's chips start just below the top bar, inside the old circle.
  for (const y of [TOP_BAR_H, TOP_BAR_H + 10, 60, 75]) {
    assert.equal(onLumo(bot.cx, y, bot, null), true, `the old circle reached y=${y}`);
    assert.equal(onLumo(bot.cx, y, bot, TOP_BAR_H), false, `y=${y} belongs to the view`);
  }
});

test("far from him is never him", () => {
  assert.equal(onLumo(bot.cx + 200, 20, bot, TOP_BAR_H), false);
  assert.equal(onLumo(20, 20, bot, TOP_BAR_H), false);
});

test("in the middle of the island (the greeting) he keeps his whole circle", () => {
  const centred = { cx: W / 2, cy: 90, size: 120 };
  assert.equal(onLumo(W / 2, 130, centred, TOP_BAR_H), true);
  assert.equal(onLumo(W / 2, 50, centred, TOP_BAR_H), true);
});

test("the closed island is all his", () => {
  const compact = { cx: 30, cy: 16, size: 66 };
  assert.equal(onLumo(30, 44, compact, null), true);
});
