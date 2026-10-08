// The island's edges: its width, the chat's height, and the window that holds
// them (src/core/layout.ts — island.rs sizes the window the same way).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SHAPE, chatHeight, islandSize, panelSize } from "../src/core/layout.ts";

test("by default the island and the window are the Mac's", () => {
  assert.deepEqual(islandSize("expanded", "overview", 0, DEFAULT_SHAPE), { w: 640, h: 160 });
  assert.deepEqual(panelSize(DEFAULT_SHAPE), { w: 720, h: 320 });
  assert.equal(chatHeight(DEFAULT_SHAPE, 0), 240);
});

test("a wider island is wide in every open view, and the window steps up by 40", () => {
  const wide = { width: 900, chatHeight: 0 };
  assert.equal(islandSize("expanded", "settings", 0, wide).w, 900);
  assert.equal(islandSize("expanded", "prompt", 3, wide).w, 900);
  assert.deepEqual(panelSize(wide), { w: 1000, h: 320 });
  // Closed, it is the usual pill.
  assert.equal(islandSize("compact", "overview", 0, wide).w, 288);
});

test("a picked chat height replaces the growing one, within limits", () => {
  const tall = { width: 640, chatHeight: 500 };
  assert.equal(islandSize("expanded", "prompt", 0, tall).h, 500);
  assert.equal(islandSize("expanded", "overview", 0, tall).h, 160);
  assert.deepEqual(panelSize(tall), { w: 720, h: 520 });
  assert.equal(chatHeight({ width: 640, chatHeight: 5000 }, 0), 640);
  assert.equal(chatHeight({ width: 640, chatHeight: 50 }, 0), 200);
});

test("nonsense sizes fall back to the usual ones", () => {
  const silly = { width: Number.NaN, chatHeight: Number.NaN };
  assert.deepEqual(islandSize("expanded", "prompt", 0, silly), { w: 640, h: 240 });
  assert.deepEqual(panelSize(silly), { w: 720, h: 320 });
  assert.equal(islandSize("expanded", "overview", 0, { width: 10, chatHeight: 0 }).w, 560);
});
