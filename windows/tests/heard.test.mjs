// What Lumo heard for a chat (src/core/heard.ts): its lines among the chat's
// messages, and what waits to be seen (the closed island, the waves, the bar,
// Past chats).

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LINES_PER_CHAT, addHeard, addPending, dropHeard, heardIn, heardLine, markAsked, placeHeard, seenChat, waitingElsewhere, wavesLit,
} from "../src/core/heard.ts";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

beforeEach(() => mem.clear());

const watch = (id, chatId, more = {}) => ({ id, repo: "", number: 0, until: "new", task: "", chatId, startedAt: 0, source: "email", target: "", mode: "once", ...more });
const line = (chatId, at, id = 1, more = {}) => heardLine({ watch: watch(id, chatId, more), met: true, summary: `heard at ${at}` }, `Chat ${chatId}`, at);

test("a line says what was heard, on one line, in the chat that asked", () => {
  const l = heardLine({ watch: watch(3, "c1"), met: true, summary: "New email\n  from   Marco" }, "Mail for Giulia", 1000);
  assert.equal(l.chatId, "c1");
  assert.equal(l.chatTitle, "Mail for Giulia");
  assert.equal(l.summary, "New email from Marco");
  assert.equal(l.id, "3:1000");
  assert.equal(l.ended, true, "a once watch is over once it fired");
  const every = heardLine({ watch: watch(3, "c1", { mode: "every" }), met: true, summary: "x", ended: false }, "", 1);
  assert.equal(every.ended, false);
  const long = heardLine({ watch: watch(3, "c1"), met: true, summary: "a".repeat(1000) }, "", 1);
  assert.ok(long.summary.length <= 400 && long.summary.endsWith("…"));
});

test("lines are kept with their chat, oldest first, the oldest going past the limit", () => {
  for (let i = 0; i < MAX_LINES_PER_CHAT + 5; i++) addHeard(line("c1", 100 - i, i));
  addHeard(line("c2", 5));
  const kept = heardIn("c1");
  assert.equal(kept.length, MAX_LINES_PER_CHAT);
  assert.ok(kept.every((l, i) => i === 0 || kept[i - 1].at <= l.at));
  assert.equal(kept.at(-1).at, 100);
  assert.equal(heardIn("c2").length, 1);
  assert.deepEqual(heardIn(""), []);
});

test("the same line is kept once; Ask goes once asked; a deleted chat's lines go", () => {
  const l = line("c1", 10);
  addHeard(l);
  addHeard(l);
  assert.equal(heardIn("c1").length, 1);
  markAsked("c1", l.id);
  assert.equal(heardIn("c1")[0].asked, true);
  dropHeard("c1");
  assert.deepEqual(heardIn("c1"), []);
});

test("a chat gone past the history's end loses its lines when another is heard", () => {
  addHeard(line("old", 1));
  addHeard(line("kept", 2));
  addHeard(line("new", 3), new Set(["kept"]));
  assert.deepEqual(heardIn("old"), []);
  assert.equal(heardIn("kept").length, 1);
  assert.equal(heardIn("new").length, 1);
});

test("lines go between the messages by time, the newest after the last", () => {
  const messages = [{ at: 10 }, { at: 20 }, {}, { at: 40 }];
  const { before, after } = placeHeard(messages, [line("c", 45), line("c", 15), line("c", 5), line("c", 30)]);
  assert.deepEqual(before.map((ls) => ls.map((l) => l.at)), [[5], [15], [], [30]], "a message without a time takes none before it");
  assert.deepEqual(after.map((l) => l.at), [45]);
  assert.deepEqual(placeHeard([], [line("c", 1)]).after.length, 1);
});

test("one waiting line per chat, the newest standing for it, until it is seen", () => {
  let pending = [];
  pending = addPending(pending, line("a", 1));
  pending = addPending(pending, line("b", 2));
  pending = addPending(pending, line("a", 3));
  assert.deepEqual(pending.map((p) => [p.chatId, p.at]), [["b", 2], ["a", 3]]);
  assert.equal(seenChat(pending, "zzz"), pending, "nothing changes for a chat that waits for nothing");
  pending = seenChat(pending, "a");
  assert.deepEqual(pending.map((p) => p.chatId), ["b"]);
});

test("the bar shows the newest line of another chat, and how many more wait", () => {
  const pending = [line("a", 1), line("b", 2), line("c", 3)];
  assert.equal(waitingElsewhere(pending, "c").line.chatId, "b");
  assert.equal(waitingElsewhere(pending, "c").more, 1);
  assert.equal(waitingElsewhere(pending, "x").more, 2);
  assert.equal(waitingElsewhere([line("a", 1)], "a"), null, "the chat on screen is not shown its own");
});

test("the waves light for this chat's watches, or another chat waiting", () => {
  const w = watch(1, "a");
  assert.equal(wavesLit([w], [], "a"), true);
  assert.equal(wavesLit([w], [], "b"), false, "a watch of another chat");
  assert.equal(wavesLit([{ ...w, paused: true }], [], "a"), false);
  assert.equal(wavesLit([], [line("b", 1)], "a"), true);
  assert.equal(wavesLit([], [line("a", 1)], "a"), false, "this chat's own line is seen here");
});
