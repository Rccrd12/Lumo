// The island's shape: its width and height from the grips, the edge it hangs
// from, and which grips each edge offers (src/core/layout.ts — island.rs uses
// the same numbers).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHAT_LISTENING, CHAT_PANEL_OPEN, CORNER_OFFSET, DEFAULT_SHAPE, chatHeight, cornerOf, gripFactors, islandSize, parseDock } from "../src/core/layout.ts";

test("the default shape gives the island its usual sizes", () => {
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

test("the drop zone and the upload keep their own 640 × 176, whatever size was dragged", () => {
  for (const shape of [{ width: 900, height: 0 }, { width: 1200, height: 500 }, { width: 560, height: 640 }]) {
    assert.deepEqual(islandSize("expanded", "upload", 0, shape), { w: 640, h: 176 });
    assert.deepEqual(islandSize("expanded", "uploading", 0, shape), { w: 640, h: 176 });
  }
});

test("a picked height makes every open view at least that tall", () => {
  const tall = { width: 640, height: 500 };
  assert.equal(islandSize("expanded", "prompt", 0, tall).h, 500);
  assert.equal(islandSize("expanded", "overview", 0, tall).h, 500);
  // Never shorter than a view needs, nor the chat than 200.
  assert.equal(islandSize("expanded", "live", 0, { width: 640, height: 160 }).h, 240);
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

test("in a corner the island grows away from it", () => {
  // island.rs CORNER: the same number either way along the edge.
  const rs = readFileSync(new URL("../src-tauri/src/island.rs", import.meta.url), "utf8");
  assert.match(rs, new RegExp(`pub const CORNER: f64 = ${CORNER_OFFSET.toLocaleString("en").replaceAll(",", "_")}\\.0;`));
  assert.equal(cornerOf(CORNER_OFFSET), "end");
  assert.equal(cornerOf(-CORNER_OFFSET), "start");
  assert.equal(cornerOf(900), null);
  assert.equal(cornerOf(Number.NaN), null);
  // Top right: the right side stays against the edge, the left one moves alone.
  assert.equal(gripFactors("right", "top", "end"), null);
  assert.equal(gripFactors("bottom-right", "top", "end"), null);
  assert.deepEqual(gripFactors("left", "top", "end"), { fx: -1, fy: 0 });
  assert.deepEqual(gripFactors("bottom-left", "top", "end"), { fx: -1, fy: 1 });
  // Bottom left: the right side and the top.
  assert.equal(gripFactors("left", "bottom", "start"), null);
  assert.deepEqual(gripFactors("top-right", "bottom", "start"), { fx: 1, fy: -1 });
  // Not in a corner: as before.
  assert.deepEqual(gripFactors("right", "top", null), { fx: 2, fy: 0 });
});

test("nonsense falls back to the usual", () => {
  const silly = { width: Number.NaN, height: Number.NaN };
  assert.deepEqual(islandSize("expanded", "prompt", 0, silly), { w: 640, h: 240 });
  assert.equal(islandSize("expanded", "overview", 0, { width: 10, height: 0 }).w, 560);
  assert.equal(parseDock("sideways"), "top");
  assert.equal(parseDock("right"), "right");
});

test("the distance from the edge: none, light (the usual), medium (past the hover margin) or wide", async () => {
  const { edgeGap, EDGE_GAP } = await import("../src/core/layout.ts");
  assert.equal(edgeGap("none"), 0);
  assert.equal(edgeGap("light"), EDGE_GAP);
  assert.equal(edgeGap(undefined), EDGE_GAP);
  assert.ok(edgeGap("medium") > 14 && edgeGap("medium") < edgeGap("wide"));
  assert.equal(edgeGap("wide"), 28);
});

test("the Listening panel gets more room than a list, and a taller picked height still wins", () => {
  assert.equal(chatHeight(DEFAULT_SHAPE, CHAT_PANEL_OPEN), 340);
  assert.equal(chatHeight(DEFAULT_SHAPE, CHAT_LISTENING), 440);
  assert.equal(chatHeight({ width: 640, height: 600 }, CHAT_LISTENING), 600);
});

test("the closed island width narrows the closed island alone, and what it says still widens it", async () => {
  const { compactWidth, COMPACT_W, NOTCH_W } = await import("../src/core/layout.ts");
  assert.equal(compactWidth(undefined), COMPACT_W);
  assert.equal(compactWidth("normal"), COMPACT_W);
  assert.ok(compactWidth("narrower") < COMPACT_W && compactWidth("narrow") < compactWidth("narrower"));
  // Lumo's 36 px room at one end, the energy leaf's at the other.
  assert.equal(compactWidth("lumo"), 72);
  const narrow = compactWidth("narrow");
  assert.deepEqual(islandSize("compact", "overview", 0, DEFAULT_SHAPE, "top", null, narrow), { w: narrow, h: 32 });
  assert.deepEqual(islandSize("compact", "overview", 0, DEFAULT_SHAPE, "left", null, narrow), { w: 32, h: narrow });
  assert.equal(islandSize("compact", "overview", 0, DEFAULT_SHAPE, "top", { w: 400, h: 32 }, narrow).w, 400);
  // Hidden, it never widens on its way into the edge; open, it is as it was.
  assert.equal(islandSize("hidden", "overview", 0, DEFAULT_SHAPE, "top", null, 72).w, 72);
  assert.equal(islandSize("hidden", "overview", 0, DEFAULT_SHAPE, "top", null, COMPACT_W).w, NOTCH_W);
  assert.deepEqual(islandSize("expanded", "overview", 0, DEFAULT_SHAPE, "top", null, 72), { w: 640, h: 160 });
});

test("a dragged file opens the island at the same distance in the page and in Rust", () => {
  const rust = readFileSync(new URL("../src-tauri/src/island.rs", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/island/island.ts", import.meta.url), "utf8");
  const near = (source, pattern) => Number(source.match(pattern)[1]);
  assert.equal(near(rust, /const DRAG_NEAR: f64 = ([0-9.]+);/), near(page, /const DRAG_NEAR = ([0-9.]+);/));
});
