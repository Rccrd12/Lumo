// The island going into the edge of the screen nearest to it and coming back
// out of it (src/island/edge-close.ts): its two ends close toward each other
// and toward that edge together, and meet as they reach it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLOSE_MAX_S, CLOSE_MIN_S, EdgeClose, closeDuration, closingFade, closingRect, meetPoint, smoother,
} from "../src/island/edge-close.ts";

// The closed island, 288 × 32, floating in a 720 × 680 window that reaches the top of the screen.
const PILL = { x: 216, y: 210, w: 288, h: 32 };
const VW = 720;
const VH = 680;

test("smooth at both ends", () => {
  assert.equal(smoother(0), 0);
  assert.equal(smoother(1), 1);
  assert.equal(smoother(0.5), 0.5);
  assert.equal(smoother(-1), 0);
  assert.equal(smoother(2), 1);
  // Barely moving as it starts and as it arrives.
  assert.ok(smoother(0.05) < 0.002);
  assert.ok(smoother(0.95) > 0.998);
});

test("the ends meet on the edge, straight across from the island's middle", () => {
  assert.deepEqual(meetPoint(PILL, "top", VW, VH), { x: 360, y: 0 });
  assert.deepEqual(meetPoint(PILL, "bottom", VW, VH), { x: 360, y: VH });
  assert.deepEqual(meetPoint(PILL, "left", VW, VH), { x: 0, y: 226 });
  assert.deepEqual(meetPoint(PILL, "right", VW, VH), { x: VW, y: 226 });
});

test("as it is at the start, gone past the edge at the end", () => {
  assert.deepEqual(closingRect(PILL, 14, "top", VW, VH, 0), { rect: PILL, radius: 14 });
  // Its ends met: one round as thick as the island, just past the edge.
  assert.deepEqual(closingRect(PILL, 14, "top", VW, VH, 1), { rect: { x: 344, y: -32, w: 32, h: 32 }, radius: 16 });
  assert.deepEqual(closingRect(PILL, 14, "left", VW, VH, 1).rect, { x: -32, y: 210, w: 32, h: 32 });
  assert.deepEqual(closingRect(PILL, 14, "right", VW, VH, 1).rect, { x: VW, y: 210, w: 32, h: 32 });
  assert.deepEqual(closingRect(PILL, 14, "bottom", VW, VH, 1).rect, { x: 344, y: VH, w: 32, h: 32 });
});

test("both ends close toward each other and toward the edge at once", () => {
  const half = closingRect(PILL, 14, "top", VW, VH, 0.5).rect;
  // Each end half-way to where they meet: shorter by as much on both sides…
  assert.equal(half.x - PILL.x, PILL.x + PILL.w - (half.x + half.w));
  assert.equal(half.w, (288 + 32) / 2);
  // …and half-way up to the edge, still as thick.
  assert.equal(half.y, (210 - 32) / 2);
  assert.equal(half.h, 32);
  // Into a side, the far end travels farther, both arriving together.
  const side = closingRect(PILL, 14, "left", VW, VH, 0.5).rect;
  assert.equal(side.x, (216 - 32) / 2);
  assert.equal(side.x + side.w, (504 + 0) / 2);
});

test("an open island closes into a round as thick as the closed one", () => {
  const open = { x: 40, y: 10, w: 640, h: 400 };
  const end = closingRect(open, 22, "top", 720, 480, 1);
  assert.deepEqual(end, { rect: { x: 344, y: -32, w: 32, h: 32 }, radius: 16 });
  // Upright on a side, its two ends are its top and bottom.
  const upright = { x: 10, y: 96, w: 32, h: 288 };
  assert.deepEqual(closingRect(upright, 14, "left", 720, 480, 1).rect, { x: -32, y: 224, w: 32, h: 32 });
});

test("longer the farther the edge, within its bounds", () => {
  const docked = { x: 216, y: 10, w: 288, h: 32 };
  assert.ok(closeDuration(docked, "top", 720, 480) < closeDuration(PILL, "top", VW, VH));
  assert.ok(closeDuration(docked, "top", 720, 480) >= CLOSE_MIN_S);
  assert.equal(closeDuration({ x: 0, y: 5000, w: 288, h: 32 }, "top", 720, 9000), CLOSE_MAX_S);
});

test("what it holds fades on the last part of the way", () => {
  assert.equal(closingFade(0), 1);
  assert.equal(closingFade(0.6), 1);
  assert.equal(closingFade(1), 0);
  assert.ok(closingFade(0.8) > 0 && closingFade(0.8) < 1);
});

test("eased over time, turned back from where it is", () => {
  const e = new EdgeClose();
  assert.equal(e.value, 0);
  assert.equal(e.active, false);
  e.close(1000, 0.5);
  assert.equal(e.active, true);
  e.tick(1250);
  assert.equal(e.value, 0.5);
  e.tick(1500);
  assert.equal(e.value, 1);
  assert.equal(e.active, false);
  // Brought back half-way through a close: only the way it went, back.
  e.open(2000, 0.5);
  e.tick(2125);
  e.close(2125, 0.5);
  const at = e.value;
  e.tick(2125 + 500 * (1 - at));
  assert.equal(e.value, 1);
  // Nothing to do: done at once.
  e.close(3000, 0.5);
  assert.equal(e.active, false);
});
