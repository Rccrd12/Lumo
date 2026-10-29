// What the computer use overlay draws (src/computer/fx.ts).

import { test } from "node:test";
import assert from "node:assert/strict";

const { aimSide, along, ease, keyCaps, sparks, toCss, typedTail } = await import("../src/computer/fx.ts");

test("the glow follows the mouse on the same eased curve", () => {
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.ok(Math.abs(ease(0.5) - 0.5) < 1e-9);
  assert.ok(ease(0.1) < 0.1 && ease(0.9) > 0.9);
  assert.equal(ease(-3), 0);
  assert.equal(ease(7), 1);
  const a = { x: 0, y: 0 };
  const b = { x: 100, y: 50 };
  assert.deepEqual(along(a, b, 0, 400), a);
  assert.deepEqual(along(a, b, 400, 400), b);
  assert.deepEqual(along(a, b, 9999, 400), b, "never past the end");
  assert.deepEqual(along(a, b, 10, 0), b, "no time: already there");
});

test("screen pixels become the page's on a scaled display", () => {
  assert.deepEqual(toCss([300, 150], 1.5), { x: 200, y: 100 });
  assert.deepEqual(toCss([300, 150], 1), { x: 300, y: 150 });
  assert.deepEqual(toCss([300, 150], 0), { x: 300, y: 150 }, "a missing scale is 1");
});

test("keys read as keycaps", () => {
  assert.deepEqual(keyCaps("ctrl+s"), ["Ctrl", "S"]);
  assert.deepEqual(keyCaps("ctrl+shift+Page_Down"), ["Ctrl", "Shift", "PgDn"]);
  assert.deepEqual(keyCaps("Return"), ["Enter"]);
  assert.deepEqual(keyCaps("super"), ["Win"]);
  assert.deepEqual(keyCaps("alt+F4"), ["Alt", "F4"]);
  assert.deepEqual(keyCaps("ctrl++"), ["Ctrl", "+"]);
  assert.deepEqual(keyCaps(""), []);
});

test("the typing bubble shows the end of the text, on one line", () => {
  assert.equal(typedTail("ciao\nmondo"), "ciao mondo");
  const long = typedTail("x".repeat(100), 10);
  assert.equal([...long].length, 10);
  assert.ok(long.startsWith("…"));
});

test("the Aim corners start wide and close in on the spot by the end of the glide", () => {
  assert.equal(aimSide(0, 600), 46);
  assert.equal(aimSide(100, 600), 46, "wide for the first part of the way");
  assert.equal(aimSide(600, 600), 24);
  assert.equal(aimSide(9999, 600), 24, "never tighter than the spot");
  assert.equal(aimSide(0, 0), 24, "no glide: already there");
  let last = Infinity;
  for (let e = 0; e <= 600; e += 50) {
    const side = aimSide(e, 600);
    assert.ok(side <= last, `${e}: ${side}`);
    last = side;
  }
});

test("a click's sparks fly all round, a little turned each time", () => {
  const a = sparks(7, 0);
  assert.equal(a.length, 7);
  for (const { dx, dy } of a) {
    const r = Math.hypot(dx, dy);
    assert.ok(r > 16 && r <= 22.01, String(r));
  }
  // All round: some go each way.
  assert.ok(a.some((s) => s.dx > 0) && a.some((s) => s.dx < 0));
  assert.ok(a.some((s) => s.dy > 0) && a.some((s) => s.dy < 0));
  assert.notDeepEqual(sparks(7, 0.37), a);
});
