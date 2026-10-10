// The island's shape: its width and height from the grips, the edge it hangs
// from, and which grips each edge offers (src/core/layout.ts — island.rs uses
// the same numbers).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SHAPE, chatHeight, gripFactors, islandSize, parseDock } from "../src/core/layout.ts";

test("by default the island is the Mac's", () => {
  assert.deepEqual(islandSize("expanded", "overview", 0, DEFAULT_SHAPE), { w: 640, h: 160 });
  assert.equal(chatHeight(DEFAULT_SHAPE, 0), 240);
  assert.deepEqual(islandSize("compact", "overview", 0, DEFAULT_SHAPE), { w: 288, h: 32 });
});

test("a wider island is wide in every open view", () => {
  const wide = { width: 900, height: 0 };
  assert.equal(islandSize("expanded", "settings", 0, wide).w, 900);
  assert.equal(islandSize("expanded", "prompt", 3, wide).w, 900);
  // Closed, it is the usual pill.
  assert.equal(islandSize("compact", "overview", 0, wide).w, 288);
});

test("the launch greeting keeps its own 640 × 150, whatever size was dragged", () => {
  for (const shape of [{ width: 900, height: 0 }, { width: 1200, height: 500 }, { width: 560, height: 640 }]) {
    assert.deepEqual(islandSize("expanded", "greeting", 0, shape), { w: 640, h: 150 });
  }
});

test("a picked height makes every open view at least that tall", () => {
  const tall = { width: 640, height: 500 };
  assert.equal(islandSize("expanded", "prompt", 0, tall).h, 500);
  assert.equal(islandSize("expanded", "overview", 0, tall).h, 500);
  // Never shorter than a view needs, nor the chat than 200.
  assert.equal(islandSize("expanded", "mail", 0, { width: 640, height: 160 }).h, 240);
  assert.equal(chatHeight({ width: 640, height: 160 }, 0), 200);
  assert.equal(chatHeight({ width: 640, height: 5000 }, 0), 640);
});

test("on a side the closed island stands upright", () => {
  assert.deepEqual(islandSize("compact", "overview", 0, DEFAULT_SHAPE, "left"), { w: 32, h: 288 });
  assert.deepEqual(islandSize("hidden", "overview", 0, DEFAULT_SHAPE, "right"), { w: 0, h: 184 });
  assert.deepEqual(islandSize("hidden", "overview", 0, DEFAULT_SHAPE, "bottom"), { w: 184, h: 0 });
  // Open, it reads the same on every edge.
  assert.deepEqual(islandSize("expanded", "overview", 0, DEFAULT_SHAPE, "left"), { w: 640, h: 160 });
});

test("each edge offers the grips away from it", () => {
  // On top: the sides move together, the bottom moves alone.
  assert.deepEqual(gripFactors("right", "top"), { fx: 2, fy: 0 });
  assert.deepEqual(gripFactors("bottom-left", "top"), { fx: -2, fy: 1 });
  assert.equal(gripFactors("top", "top"), null);
  assert.equal(gripFactors("top-right", "top"), null);
  // At the bottom, the top edge pulls upwards.
  assert.deepEqual(gripFactors("top", "bottom"), { fx: 0, fy: -1 });
  // On the left, the right edge moves alone and top and bottom move together.
  assert.deepEqual(gripFactors("right", "left"), { fx: 1, fy: 0 });
  assert.deepEqual(gripFactors("top", "left"), { fx: 0, fy: -2 });
  assert.equal(gripFactors("bottom-left", "left"), null);
  assert.deepEqual(gripFactors("bottom-left", "right"), { fx: -1, fy: 2 });
});

test("nonsense falls back to the usual", () => {
  const silly = { width: Number.NaN, height: Number.NaN };
  assert.deepEqual(islandSize("expanded", "prompt", 0, silly), { w: 640, h: 240 });
  assert.equal(islandSize("expanded", "overview", 0, { width: 10, height: 0 }).w, 560);
  assert.equal(parseDock("sideways"), "top");
  assert.equal(parseDock("right"), "right");
});

test("the distance from the edge: none, medium (the usual) or wide", async () => {
  const { edgeGap, EDGE_GAP } = await import("../src/core/layout.ts");
  assert.equal(edgeGap("none"), 0);
  assert.equal(edgeGap("medium"), EDGE_GAP);
  assert.equal(edgeGap(undefined), EDGE_GAP);
  assert.equal(edgeGap("wide"), 24);
});
