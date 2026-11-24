// The steps on the agent's card (src/views/ticker.ts): one ticker serves every
// pill, so the rows always hold the focused task's own steps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { Ticker } = await import("../src/views/ticker.ts");

const task = (id, stepSeq) => ({ id, steps: [1, 2, 3, 4, 5, 6].map((i) => `${id}${i}`), stepSeq });

test("another task's steps are laid out at once, never scrolled in under the last one's", () => {
  const ticker = new Ticker();
  let now = 0;
  const settle = () => {
    for (let i = 0; i < 50; i++) ticker.tick((now += 50));
  };
  const shown = () => ticker.rows.slice(0, ticker.shown).map((r) => `${r.text}#${r.seq}`);
  ticker.sync(task("a", 5));
  settle();
  const lines = ticker.shown;
  assert.ok(lines >= 1);
  // Same number of steps: the rows were the first task's.
  ticker.sync(task("b", 5));
  settle();
  assert.deepEqual(shown(), ["b1", "b2", "b3", "b4", "b5", "b6"].slice(-lines).map((s, i, all) => `${s}#${5 - (all.length - 1 - i)}`));
  // More steps: none of the first task's is left, nor queued.
  ticker.sync(task("a", 5));
  settle();
  ticker.sync(task("c", 6));
  settle();
  assert.ok(shown().every((row) => row.startsWith("c")), `only c's steps: ${shown()}`);
  assert.equal(shown().at(-1), "c6#6");
});
