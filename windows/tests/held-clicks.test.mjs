// The island's clicks kept from its window while the computer is in use
// (src/island/held-clicks.ts, click_hold.rs): the page clicks what is under them.

import { test } from "node:test";
import assert from "node:assert/strict";

const log = [];
class El {
  constructor(name, parent = null) {
    this.name = name;
    this.parentElement = parent;
  }
  contains(other) {
    for (let e = other; e; e = e.parentElement) if (e === this) return true;
    return false;
  }
  dispatchEvent(ev) {
    log.push(`${this.name}:${ev.type}@${ev.clientX},${ev.clientY}`);
    return true;
  }
}
globalThis.MouseEvent ??= class {
  constructor(type, init) {
    this.type = type;
    Object.assign(this, init);
  }
};
globalThis.HTMLInputElement ??= class {};
globalThis.HTMLTextAreaElement ??= class {};
globalThis.dispatchEvent ??= (ev) => log.push(`window:${ev.type}`);
const card = new El("card");
const button = new El("allow", card);
const label = new El("label", button);
const other = new El("deny", card);
let under = null;
globalThis.document ??= {};
document.elementFromPoint = () => under;

const { heldClick } = await import("../src/island/held-clicks.ts");

test("a press and a release on the same button click it", () => {
  log.length = 0;
  under = label;
  heldClick(true, 10, 20);
  heldClick(false, 11, 20);
  assert.deepEqual(log, ["label:mousedown@10,20", "label:mouseup@11,20", "label:click@11,20"]);
});

test("pressed on one button and let go on another: only what holds both is clicked", () => {
  log.length = 0;
  under = button;
  heldClick(true, 1, 1);
  under = other;
  heldClick(false, 50, 1);
  assert.deepEqual(log, ["allow:mousedown@1,1", "deny:mouseup@50,1", "card:click@50,1"]);
});

test("a release with no press before it clicks nothing", () => {
  log.length = 0;
  under = button;
  heldClick(false, 3, 3);
  assert.deepEqual(log, ["allow:mouseup@3,3"]);
});

test("nothing for a point that is not a number", () => {
  log.length = 0;
  heldClick(true, Number.NaN, 2);
  assert.deepEqual(log, []);
});
