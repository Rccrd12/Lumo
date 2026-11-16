// Where a chat is read (src/views/read-place.ts): the element at the top of
// the log and how far into it, found again once the log was laid out at
// another width (the island closing to its small size and opening again).

import { test } from "node:test";
import assert from "node:assert/strict";

const { readPlace, putPlace } = await import("../src/views/read-place.ts");

/**
 * A log laid out as a column: each block has a height, its children laid out
 * one under the other inside it. Rects follow the log's scrollTop.
 */
function fakeLog(blocks, height = 100) {
  const log = { scrollTop: 0, clientHeight: height, children: [] };
  log.getBoundingClientRect = () => ({ top: 0, bottom: height, height });
  const make = (spec, parentTop) => {
    const el = { children: [], spec, matches: () => false };
    el.top = () => parentTop() + spec.y;
    el.getBoundingClientRect = () => {
      const top = el.top();
      return { top, bottom: top + spec.h, height: spec.h };
    };
    el.children = (spec.kids ?? []).map((k) => make(k, el.top));
    return el;
  };
  log.children = blocks.map((b) => make(b, () => -log.scrollTop));
  return log;
}

/** A column of blocks of these heights, `gap` apart, each with `kids` lines of 20 px. */
function column(heights, gap = 6) {
  let y = 0;
  return heights.map((h) => {
    const block = { y, h, kids: Array.from({ length: Math.floor(h / 20) }, (_, i) => ({ y: i * 20, h: 20 })) };
    y += h + gap;
    return block;
  });
}

test("the place is the line at the top of the log and how far into it", () => {
  const log = fakeLog(column([100, 200, 100]));
  log.scrollTop = 156; // 50 px into the second block: its third line, half way
  assert.deepEqual(readPlace(log), { path: [1, 2], share: 0.5, gap: 0 });
});

test("a line starting a little below the top keeps its distance", () => {
  const log = fakeLog(column([100, 200, 100]));
  log.scrollTop = 103; // in the gap between the first two blocks
  assert.deepEqual(readPlace(log), { path: [1], share: 0, gap: 3 });
});

test("laid out again at another width, the same line comes back to the top", () => {
  const log = fakeLog(column([100, 200, 100]));
  log.scrollTop = 156;
  const place = readPlace(log);
  // Narrower: every block twice as tall, its lines too.
  const narrow = fakeLog(column([200, 400, 200]).map((b) => ({ ...b, kids: b.kids.map((k, i) => ({ y: i * 40, h: 40 })) })));
  narrow.scrollTop = 156; // where the browser left it, if nothing kept the place
  assert.equal(putPlace(narrow, place), true);
  // Second block at 206, its third line at 80 inside it, half of it: 306.
  assert.equal(narrow.scrollTop, 306);
});

test("a place whose message is gone is not put back", () => {
  const log = fakeLog(column([100, 200, 100]));
  log.scrollTop = 400;
  const place = readPlace(log);
  const shorter = fakeLog(column([100]));
  assert.equal(putPlace(shorter, place), false);
});

test("a log with nothing shown has no place", () => {
  assert.equal(readPlace(fakeLog([], 0)), null);
});
