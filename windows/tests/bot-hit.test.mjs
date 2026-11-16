// Where a press, or the mouse resting, counts as being on Lumo (src/core/layout.ts onLumo):
// on the open island he is his eyes alone, and only his eyes are him.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EYES_HIT_PAD, newLookBot, onLumo } from "../src/core/layout.ts";
import { LOOK_EYES } from "../src/character/looks.ts";

const TOP_BAR_H = 42; // island.ts TOP_BAR_H: 8 pt inset + 34 pt header
const W = 760;
const placed = newLookBot("prompt", W);
// island.ts updateBotTargets: the canvas is the diameter / 0.6 wide; his radius is 0.3 of it.
const bot = { cx: placed.cx, cy: placed.cy, size: placed.diameter / 0.6 };
const R = bot.size * 0.3;

test("each eye, and a little around it, is his", () => {
  for (const sd of [-1, 1]) {
    const ex = bot.cx + sd * LOOK_EYES.x * R;
    const ey = bot.cy + LOOK_EYES.y * R;
    assert.equal(onLumo(ex, ey, bot, true), true);
    // The eye's own edges, even looking all the way aside.
    const half = { w: (LOOK_EYES.w * R) / 2, h: (LOOK_EYES.h * R) / 2 };
    assert.equal(onLumo(ex + sd * (half.w + 0.1 * R), ey, bot, true), true);
    assert.equal(onLumo(ex, ey - half.h - 0.075 * R, bot, true), true);
    assert.equal(onLumo(ex, ey + half.h + 0.075 * R, bot, true), true);
  }
  assert.equal(onLumo(bot.cx, bot.cy, bot, true), true, "between the eyes");
});

test("the box stays close to the eyes", () => {
  const halfW = 0.5 * R + EYES_HIT_PAD;
  const halfH = 0.3 * R + EYES_HIT_PAD;
  assert.ok(halfW < 25 && halfH < 17, `about ${2 * halfW} × ${2 * halfH} px`);
  assert.equal(onLumo(bot.cx + halfW + 1, bot.cy, bot, true), false);
  assert.equal(onLumo(bot.cx, bot.cy - halfH - 1, bot, true), false);
  assert.equal(onLumo(bot.cx, bot.cy + halfH + 1, bot, true), false);
  // Inside the top bar, which he never leaves.
  assert.ok(bot.cy + halfH < TOP_BAR_H);
});

test("a provider chip right under his eyes is the chip's, not his", () => {
  // The model picker's chips start just below the top bar, inside the old circle.
  for (const y of [TOP_BAR_H, TOP_BAR_H + 10, 60, 75]) {
    assert.equal(onLumo(bot.cx, y, bot, false), true, `the whole circle reaches y=${y}`);
    assert.equal(onLumo(bot.cx, y, bot, true), false, `y=${y} belongs to the view`);
  }
});

test("the top bar around his eyes is the island's", () => {
  assert.equal(onLumo(bot.cx + 40, bot.cy, bot, true), false);
  assert.equal(onLumo(bot.cx - 40, bot.cy, bot, true), false);
  assert.equal(onLumo(bot.cx, 2, bot, true), false);
});

test("whole, he keeps his circle", () => {
  const compact = { cx: 30, cy: 16, size: 66 };
  assert.equal(onLumo(30, 44, compact, false), true);
  assert.equal(onLumo(30 + 40, 16, compact, false), false);
});
