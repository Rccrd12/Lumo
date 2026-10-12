// The sessions behind each pill (src/core/pill-sessions.ts): who owns it, who
// is still at work, and when a silent one is forgotten.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PillSessions, SILENT_MID_TURN_MS, SILENT_MS } from "../src/core/pill-sessions.ts";

const clock = () => {
  const c = { at: 1_000, now: () => c.at };
  return c;
};

test("the oldest session at work owns the pill, else the one heard from last", () => {
  const c = clock();
  const r = new PillSessions(c.now);
  r.touch("p", "a", "/a", "a", "SessionStart");
  c.at += 1;
  r.touch("p", "b", "/b", "b", "SessionStart");
  assert.equal(r.owner("p").id, "b");
  c.at += 1;
  r.touch("p", "b", "/b", "b", "PreToolUse");
  c.at += 1;
  r.touch("p", "a", "/a", "a", "PreToolUse");
  assert.equal(r.owner("p").id, "a");
  r.touch("p", "a", "/a", "a", "Stop");
  assert.equal(r.owner("p").id, "b");
});

test("only another session at work counts as busy", () => {
  const r = new PillSessions(clock().now);
  r.touch("p", "a", "/a", "a", "UserPromptSubmit");
  assert.equal(r.othersBusy("p", "a"), false);
  r.touch("p", "b", "/b", "b", "UserPromptSubmit");
  assert.equal(r.othersBusy("p", "a"), true);
  r.touch("p", "b", "/b", "b", "Stop");
  assert.equal(r.othersBusy("p", "a"), false);
  // An event with no session cannot tell: never busy, never counted.
  r.touch("p", "", "/c", "c", "PreToolUse");
  assert.equal(r.live("p").length, 2);
  assert.equal(r.othersBusy("p", ""), false);
});

test("ending a session leaves the others; no id ends them all", () => {
  const r = new PillSessions(clock().now);
  r.touch("p", "a", "/a", "a", "SessionStart");
  r.touch("p", "b", "/b", "b", "SessionStart");
  r.end("p", "a");
  assert.deepEqual(r.live("p").map((s) => s.id), ["b"]);
  r.touch("p", "a", "/a", "a", "SessionStart");
  r.end("p", "");
  assert.deepEqual(r.live("p"), []);
});

test("a silent session is forgotten: 30 minutes mid-turn, 12 hours otherwise", () => {
  const c = clock();
  const r = new PillSessions(c.now);
  r.touch("p", "busy", "/a", "a", "PreToolUse");
  r.touch("p", "idle", "/b", "b", "Stop");
  c.at += SILENT_MID_TURN_MS - 1;
  assert.equal(r.live("p").length, 2);
  c.at += 1;
  assert.deepEqual(r.live("p").map((s) => s.id), ["idle"]);
  c.at += SILENT_MS;
  assert.deepEqual(r.live("p"), []);
  assert.equal(r.owner("p"), null);
});
