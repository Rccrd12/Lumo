// Past chats' dots (src/core/chat-marks.ts, concept puntini-chat): what a chat
// not on screen has for the user, and what is kept for it until it is opened.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { chatDot, clearMark, loadMarks, markChat, needsUser, oneLine, pruneMarks } from "../src/core/chat-marks.ts";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
beforeEach(() => mem.clear());

const idle = { onScreen: false, waiting: false, working: null };

test("nothing to know: no dot", () => {
  assert.equal(chatDot(idle, undefined), null);
});

test("the chat on screen never has a dot", () => {
  const mark = { kind: "unread", text: "Hi", at: 1 };
  assert.equal(chatDot({ onScreen: true, waiting: true, working: "Thinking…" }, mark), null);
});

test("waiting for the user comes first, then at work, then what is kept", () => {
  const mark = { kind: "error", text: "Limit reached", at: 1 };
  assert.deepEqual(chatDot({ ...idle, waiting: true, working: "Thinking…" }, mark), { kind: "waiting", detail: "" });
  assert.deepEqual(chatDot({ ...idle, working: "Thinking…" }, mark), { kind: "working", detail: "Thinking…" });
  assert.deepEqual(chatDot(idle, mark), { kind: "error", detail: "Limit reached" });
});

test("the badge counts what needs the user, not a chat at work", () => {
  assert.equal(needsUser(null), false);
  assert.equal(needsUser({ kind: "working", detail: "" }), false);
  for (const kind of ["waiting", "error", "unread"]) assert.equal(needsUser({ kind, detail: "" }), true);
});

test("a new answer is kept across a restart until the chat is opened", () => {
  let marks = markChat({}, "c1", "unread", "**Here** is the draft:\n\n- one\n- two", 5);
  assert.deepEqual(loadMarks(), { c1: { kind: "unread", text: "Here is the draft: - one - two", at: 5 } });
  marks = clearMark(marks, "c1");
  assert.deepEqual(marks, {});
  assert.deepEqual(loadMarks(), {});
  assert.equal(localStorage.getItem("lumo.chatMarks.v1"), null);
});

test("clearing a chat without a mark changes nothing", () => {
  const marks = markChat({}, "c1", "unread", "Hi");
  assert.equal(clearMark(marks, "c2"), marks);
});

test("marks of chats that are gone are dropped", () => {
  let marks = markChat({}, "c1", "unread", "a");
  marks = markChat(marks, "c2", "error", "b");
  marks = pruneMarks(marks, ["c2"]);
  assert.deepEqual(Object.keys(marks), ["c2"]);
  assert.deepEqual(Object.keys(loadMarks()), ["c2"]);
});

test("what storage holds that is not a mark is passed over", () => {
  localStorage.setItem("lumo.chatMarks.v1", JSON.stringify({ a: { kind: "x", text: "", at: 1 }, b: 3, c: { kind: "unread", text: "ok", at: 2 } }));
  assert.deepEqual(loadMarks(), { c: { kind: "unread", text: "ok", at: 2 } });
  localStorage.setItem("lumo.chatMarks.v1", "[");
  assert.deepEqual(loadMarks(), {});
});

test("an answer on one line: code, pictures and links' addresses go", () => {
  assert.equal(oneLine("# Title\n```js\nx()\n```\nSee [the docs](https://x.y) ![p](https://i)"), "Title See the docs");
  assert.equal(oneLine("x".repeat(400)).length, 160);
  assert.equal(oneLine("**Ciao Giulia**, a _domani_"), "Ciao Giulia, a domani");
});
