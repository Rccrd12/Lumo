// A simple request on the closed island (src/island/compact.ts): its place in
// the queue follows the queue, and Allow keeps its guard against clicks meant
// for something else across that redraw.

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const mem = new Map();
globalThis.localStorage ??= {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const { State } = await import("../src/core/state.ts");
const { CompactStrip } = await import("../src/island/compact.ts");

const request = (id) => ({ requestId: id, pillId: "claude-code", tool: "Bash", command: "ls", project: "proj", quick: true });

test("the queue empties: the request on show no longer says 1/3, and its click guard is kept", () => {
  const decided = [];
  const strip = new CompactStrip({ reveal() {}, openChat() {}, changed() {}, decide: (d, id) => decided.push([d, id]) });
  State.pendingApproval = request("a");
  State.approvalQueue = [request("b"), request("c")];
  mock.timers.enable({ apis: ["Date"] });
  const now = mock.method(performance, "now", () => 1000);
  try {
    strip.sync(false, false);
    assert.equal(strip.el.querySelector(".cp-approval-who").textContent, "proj · 1/3");
    // Bug 45: answered elsewhere, the others go; the one on show stays.
    State.approvalQueue = [];
    now.mock.mockImplementation(() => 1500);
    strip.sync(false, false);
    assert.equal(strip.el.querySelector(".cp-approval-who").textContent, "proj");
    // Drawn again, it is still the request that came up at 1000: a click at 1700 counts.
    now.mock.mockImplementation(() => 1700);
    strip.el.querySelector(".cp-action.allow").fire("click");
    assert.deepEqual(decided, [["allow", "a"]]);
  } finally {
    now.mock.restore();
    mock.timers.reset();
    State.pendingApproval = null;
    State.approvalQueue = [];
  }
});
