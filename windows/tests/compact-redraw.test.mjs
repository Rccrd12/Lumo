// The closed island never stays wide and empty: after a reply, it came back
// from the edge as wide as its activities, with none of them on it, until it
// was opened and closed again. It is redrawn whatever else fails when the
// state changes, and it checks each frame that what it shows matches its mode.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { State } from "../src/core/state.ts";

test("a failing listener does not keep the others, the island's own included, from hearing a change", () => {
  const heard = [];
  const errors = [];
  const error = console.error;
  console.error = (...args) => errors.push(args);
  const off = [
    State.subscribe(() => heard.push("before")),
    State.subscribe(() => {
      throw new Error("a view failed");
    }),
    State.subscribe(() => heard.push("island")),
  ];
  try {
    assert.doesNotThrow(() => State.notify());
  } finally {
    console.error = error;
    for (const f of off) f();
  }
  assert.deepEqual(heard, ["before", "island"]);
  assert.equal(errors.length, 1, "the failure is still written to the console");
});

const island = readFileSync(new URL("../src/island/island.ts", import.meta.url), "utf8");

test("each frame, the closed island's strip is checked against the mode, and redrawn if it missed a change", () => {
  const frame = island.slice(island.indexOf("private frame = "), island.indexOf("private updateBotTargets"));
  const check = frame.indexOf("this.compact.onScreen !== this.compactOn");
  const draw = frame.indexOf("this.syncDom()");
  assert.ok(check > 0, "the frame compares what the strip shows with the mode");
  assert.ok(check < draw, "a mismatch is redrawn in the same frame");
  assert.match(frame, /try \{\s*this\.syncDom\(\);\s*\} catch/, "a view failing to draw does not stop the frames");
});

test("the island marks itself to redraw before anything else it does on a change", () => {
  const at = island.indexOf("State.subscribe(() => {");
  const body = island.slice(at, island.indexOf("});", at));
  assert.ok(body.indexOf("this.dirty = true") < body.indexOf("this.fsm"), "dirty first");
});

test("one view failing to draw never keeps the closed island from being drawn", () => {
  const dom = island.slice(island.indexOf("private syncDom()"), island.indexOf("this.compact.sync(compactOn)"));
  assert.match(dom, /try \{\s*view\.sync\(\);\s*\} catch/);
});
