// Each view keeps the size its grips were dragged to (src/core/layout.ts
// sizeSlot, viewShape; island.rs keeps them): making the chat big leaves the
// home as small as it was, and the other way round.

import { test } from "node:test";
import assert from "node:assert/strict";
import { homeWidth, islandSize, newLookQuestionHeight, questionsHeight, sizeSlot, viewShape } from "../src/core/layout.ts";

const shared = { islandWidth: 640, islandHeight: 0 };

test("the chat and a Live call share a slot, every other view has its own", () => {
  assert.equal(sizeSlot("prompt"), "chat");
  assert.equal(sizeSlot("live"), "chat");
  assert.equal(sizeSlot("home"), "home");
  assert.equal(sizeSlot("tools"), "tools");
  assert.equal(sizeSlot("settings"), "settings");
  // The launch greeting keeps its own 640 × 150 whatever was dragged.
  assert.equal(sizeSlot("greeting"), null);
  // The drop zone and the upload keep their own 640 × 176 the same way.
  assert.equal(sizeSlot("upload"), null);
  assert.equal(sizeSlot("uploading"), null);
});

test("before any view has a size of its own, every view takes the shared one", () => {
  const kept = { islandWidth: 900, islandHeight: 400 };
  assert.deepEqual(viewShape(kept, "home"), { width: 900, height: 400 });
  assert.deepEqual(viewShape(kept, "prompt"), { width: 900, height: 400 });
  assert.deepEqual(viewShape({ ...kept, islandSizes: {} }, "tools"), { width: 900, height: 400 });
});

test("the home made as small as it goes stays small when the chat is made big", () => {
  const kept = {
    ...shared,
    islandSizes: { home: { width: 440, height: 0 }, chat: { width: 1100, height: 600 } },
  };
  // The chat, and a Live call in the chat's room, are big.
  assert.deepEqual(islandSize("expanded", "prompt", 3, viewShape(kept, "prompt")), { w: 1100, h: 600 });
  assert.equal(islandSize("expanded", "live", 0, viewShape(kept, "live")).w, 1100);
  // The home is as narrow as it was left, and no taller than what it lists.
  const home = viewShape(kept, "home");
  assert.deepEqual(home, { width: 440, height: 0 });
  assert.equal(homeWidth(home, false), 440 + 880 - 640);
  // A view never resized still has the shared size.
  assert.deepEqual(islandSize("expanded", "overview", 0, viewShape(kept, "overview")), { w: 640, h: 160 });
  assert.deepEqual(viewShape(kept, "settings"), { width: 640, height: 0 });
});

test("the home made big leaves the chat as it was", () => {
  const kept = { ...shared, islandSizes: { home: { width: 1000, height: 500 } } };
  assert.deepEqual(viewShape(kept, "home"), { width: 1000, height: 500 });
  assert.deepEqual(viewShape(kept, "prompt"), { width: 640, height: 0 });
  assert.equal(islandSize("expanded", "prompt", 0, viewShape(kept, "prompt")).h, 240);
});

test("a question in several parts is as tall as its tallest part", () => {
  const q = (n, multiSelect = false) => ({ options: Array.from({ length: n }, (_, i) => ({ label: String(i) })), multiSelect });
  // The second has more choices and a Done button: the card is its height from the first part on.
  assert.equal(questionsHeight([q(2), q(3, true), q(4)]), newLookQuestionHeight(4, false));
  assert.equal(questionsHeight([q(2), q(4, true)]), newLookQuestionHeight(4, true));
  assert.equal(questionsHeight([q(2)]), newLookQuestionHeight(2, false));
  assert.equal(questionsHeight([q(2), q(20)]), 440);
});
