// What the computer use overlay draws (src/computer/fx.ts).

import { test } from "node:test";
import assert from "node:assert/strict";

const { along, ease, keyCaps, toCss, typedTail } = await import("../src/computer/fx.ts");

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
