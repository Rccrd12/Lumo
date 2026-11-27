// The upload bar follows the real copy into the inbox (src/upload/meter.ts):
// never ahead of the bytes, never ahead of a short minimum fill, full only
// once every copy landed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MIN_FILL, UploadMeter, partFraction, totalFraction } from "../src/upload/meter.ts";

const part = (done, total, landed = false) => ({ source: "s", name: "n", done, total, landed });

/** Steps `meter` from `from` to `to` seconds after the bar starts, a frame at a time. */
function run(meter, from, to, each) {
  let shown;
  for (let t = from; t <= to + 1e-9; t += 1 / 60) {
    shown = meter.step(t, 1 / 60);
    each?.(t, shown);
  }
  return shown;
}

test("a copy is full only once it landed", () => {
  assert.equal(partFraction(part(0, null)), 0);
  assert.equal(partFraction(part(50, 100)), 0.5);
  assert.ok(partFraction(part(100, 100)) < 1);
  assert.equal(partFraction(part(100, 100, true)), 1);
  assert.equal(partFraction(part(0, 0, true)), 1);
});

test("the whole drop goes by bytes: a big file counts for more", () => {
  assert.equal(totalFraction([]), 0);
  const big = part(0, 900);
  const small = part(100, 100, true);
  assert.ok(Math.abs(totalFraction([big, small]) - 0.1) < 1e-9);
  assert.ok(totalFraction([part(900, 900), small]) < 1);
  assert.equal(totalFraction([part(900, 900, true), small]), 1);
});

test("a file copied at once fills the bar in the minimum time, no sooner", () => {
  const meter = new UploadMeter([{ name: "a.pdf", source: "C:/a.pdf" }]);
  meter.progress("C:/a.pdf", 2_000_000, 2_000_000);
  meter.land("C:/a.pdf");
  // Before the bar starts (Lumo still eating the file) it stays empty.
  assert.equal(run(meter, -1, -0.02).total, 0);
  let fullAt = null;
  run(meter, 0, MIN_FILL + 0.2, (t, s) => {
    if (fullAt == null && s.total >= 1) fullAt = t;
  });
  assert.ok(fullAt != null && fullAt >= MIN_FILL - 0.02 && fullAt <= MIN_FILL + 0.05, `full at ${fullAt}`);
});

test("a slow copy: the bar follows the bytes and waits for the copy to land", () => {
  const meter = new UploadMeter([{ name: "big.mov", source: "D:/big.mov" }]);
  let shown = 0;
  for (let i = 0; i <= 600; i++) {
    const t = i / 60;
    const real = Math.min(1, t / 10);
    meter.progress("D:/big.mov", Math.round(real * 1e9), 1e9);
    const s = meter.step(t, 1 / 60);
    assert.ok(s.total >= shown, "never goes back");
    assert.ok(s.total <= Math.min(real, 0.99) + 1e-9, `ahead of the copy at ${t}`);
    shown = s.total;
  }
  assert.ok(shown > 0.95 && shown < 1, "all bytes there, not landed yet: not full");
  meter.land("D:/big.mov");
  assert.equal(run(meter, 10, 10.6).total, 1);
});

test("each file has its own bar, and a failed one leaves without holding the rest", () => {
  const meter = new UploadMeter([
    { name: "a", source: "a" },
    { name: "b", source: "b" },
  ]);
  meter.progress("a", 10, 10);
  meter.land("a");
  meter.progress("b", 5, 100);
  const s = run(meter, 0, 2);
  assert.equal(s.each[0], 1);
  assert.ok(s.each[1] <= 0.05 + 1e-9);
  assert.ok(s.total < 0.2);
  meter.remove("b");
  assert.deepEqual(meter.names, ["a"]);
  assert.equal(run(meter, 2, 3).total, 1);
});

test("progress for a file not in this drop changes nothing", () => {
  const meter = new UploadMeter([{ name: "a", source: "a" }]);
  meter.progress("elsewhere", 10, 10);
  assert.equal(meter.parts[0].total, null);
});
