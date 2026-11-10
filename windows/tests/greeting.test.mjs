// The launch greeting (src/character/greeting.ts): the island is Lumo's light,
// so the opening is that light coming on — a spark, a line, the island
// unrolling under it, his eyes opening in the middle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GREETING_END, LIGHT_GREET_SMILE, lightGreetFrame } from "../src/character/greeting.ts";
import { COMPACT_W } from "../src/core/layout.ts";

test("the greeting is short", () => {
  assert.ok(GREETING_END <= 1.5, `ends at ${GREETING_END} s`);
  assert.ok(LIGHT_GREET_SMILE < GREETING_END, "he smiles before it ends");
});

test("a spark, then a line, then the island unrolls under it", () => {
  const spark = lightGreetFrame(0.1, COMPACT_W);
  assert.ok(spark.w < 12 && spark.h < 12, `a spark: ${spark.w}×${spark.h}`);
  assert.equal(spark.spark, 1, "all light");
  assert.ok(Math.abs(spark.eyes) < 1e-9, "no eyes yet");

  const line = lightGreetFrame(0.4, COMPACT_W);
  assert.ok(line.w > 100 && line.h <= 10, `a line: ${line.w}×${line.h}`);

  const end = lightGreetFrame(GREETING_END, COMPACT_W);
  assert.ok(Math.abs(end.w - (COMPACT_W + 72)) < 0.5, `as wide as the closed island and a little more: ${end.w}`);
  assert.ok(Math.abs(end.h - 64) < 0.5, `${end.h}`);
  assert.ok(Math.abs(end.spark) < 1e-9, "its black body");
  assert.ok(end.eyes > 0.99, "his eyes open");
});

test("its corner is never more than half its height", () => {
  for (let t = 0; t <= GREETING_END; t += 1 / 60) {
    const f = lightGreetFrame(t, COMPACT_W);
    assert.ok(f.r <= f.h / 2 + 1e-9, `t=${t.toFixed(3)}: r ${f.r} for h ${f.h}`);
    assert.ok(f.w > 0 && f.h > 0, `t=${t.toFixed(3)}`);
  }
});

test("a narrower closed island makes a narrower opening", () => {
  const wide = lightGreetFrame(GREETING_END, COMPACT_W);
  const narrow = lightGreetFrame(GREETING_END, COMPACT_W - 80);
  assert.ok(Math.abs(wide.w - narrow.w - 80) < 0.5);
});
