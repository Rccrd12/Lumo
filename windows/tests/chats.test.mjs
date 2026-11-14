// Past chats (src/core/chats.ts): kept newest first, capped, deleted one by one.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CHATS, chatTitle, cliOf, compactOf, deleteChat, joinOwnAnswer, loadChats, saveChat, setChatCli, setCompact } from "../src/core/chats.ts";

const mem = new Map();
/** How many characters the fake storage holds, like WebView2's quota. */
let quota = Infinity;
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => {
    if (String(v).length > quota) throw new Error("QuotaExceededError");
    mem.set(k, String(v));
  },
  removeItem: (k) => mem.delete(k),
};

const chat = (id, title = id) => ({ id, title, updatedAt: 1, provider: "claude-code", session: null, turns: [{ role: "user", content: title }] });

beforeEach(() => {
  mem.clear();
  quota = Infinity;
});

test("a saved chat comes first, and saving it again moves it up without a copy", () => {
  saveChat(chat("a"));
  saveChat(chat("b"));
  assert.deepEqual(loadChats().map((c) => c.id), ["b", "a"]);
  saveChat({ ...chat("a"), title: "again" });
  assert.deepEqual(loadChats().map((c) => [c.id, c.title]), [["a", "again"], ["b", "b"]]);
});

test("the oldest chats go past the cap, and a deleted one is gone", () => {
  for (let i = 0; i < MAX_CHATS + 5; i++) saveChat(chat(`c${i}`));
  const ids = loadChats().map((c) => c.id);
  assert.equal(ids.length, MAX_CHATS);
  assert.equal(ids[0], `c${MAX_CHATS + 4}`);
  deleteChat(ids[0]);
  assert.ok(!loadChats().some((c) => c.id === ids[0]));
});

test("unreadable storage reads as no chats", () => {
  mem.set("lumo.chats.v1", "{not json");
  assert.deepEqual(loadChats(), []);
  mem.set("lumo.chats.v1", JSON.stringify([{ nope: 1 }, chat("ok")]));
  assert.deepEqual(loadChats().map((c) => c.id), ["ok"]);
});

test("the title is the first question on one line, shortened", () => {
  assert.equal(chatTitle([{ role: "assistant", content: "hi" }, { role: "user", content: "  what\nis   this?" }]), "what is this?");
  assert.equal(chatTitle([{ role: "user", content: "x".repeat(100) }]).length, 60);
  assert.equal(chatTitle([]), "");
});

test("past chats are searched in questions and answers, accents and case aside", async () => {
  const { searchChats } = await import("../src/core/chats.ts");
  const chat = (id, title, ...turns) => ({ id, title, updatedAt: 0, provider: "claude-code", session: null,
    turns: turns.map((content, i) => ({ role: i % 2 ? "assistant" : "user", content })) });
  const chats = [
    chat("a", "Perché il PDF non si apre?", "Perché il PDF non si apre?", "Prova ad aprirlo con un altro lettore, poi dimmi."),
    chat("b", "Ricetta della pasta", "Ricetta della pasta", "Acqua, sale e 10 minuti di cottura."),
  ];
  assert.deepEqual(searchChats(chats, ""), []);
  assert.deepEqual(searchChats(chats, "perche").map((x) => x.chat.id), ["a"]);
  const hit = searchChats(chats, "LETTORE")[0];
  assert.equal(hit.chat.id, "a");
  assert.equal(hit.snippet.slice(hit.match[0], hit.match[1]), "lettore");
  // Every word must be there, in any message of the chat.
  assert.deepEqual(searchChats(chats, "pasta cottura").map((x) => x.chat.id), ["b"]);
  assert.deepEqual(searchChats(chats, "pasta pdf"), []);
});

test("a compacted chat keeps its summary until it is deleted", () => {
  saveChat(chat("a"));
  saveChat(chat("b"));
  setCompact("a", { upto: 2, summary: "S" });
  assert.deepEqual(compactOf("a"), { upto: 2, summary: "S" });
  assert.equal(compactOf("b"), null);
  setCompact("b", { upto: 4, summary: "T" });
  deleteChat("a");
  assert.equal(compactOf("a"), null);
  assert.deepEqual(compactOf("b"), { upto: 4, summary: "T" });
  setCompact("b", null);
  assert.equal(compactOf("b"), null);
});

test("a chat keeps what its CLI sessions saw until it is deleted or edited", () => {
  saveChat(chat("a"));
  saveChat(chat("b"));
  const state = '{"last":"claude-code","sessions":[{"provider":"claude-code","id":"s","seen":2}]}';
  setChatCli("a", state);
  assert.equal(cliOf("a"), state);
  assert.equal(cliOf("b"), null);
  // A chat whose first answer is still coming keeps it too.
  setChatCli("new", state);
  assert.equal(cliOf("new"), state);
  setChatCli("b", state);
  deleteChat("a");
  assert.equal(cliOf("a"), null);
  assert.equal(cliOf("b"), state);
  setChatCli("b", null);
  assert.equal(cliOf("b"), null);
  // Storage full: nothing breaks, the chat opens as before (every turn seen).
  quota = 10;
  setChatCli("b", state);
  assert.equal(cliOf("b"), null);
});

test("what Claude Code writes by itself joins the last answer, before a question still waiting", () => {
  const turns = [
    { role: "user", content: "Measure it and tell me when it is done" },
    { role: "assistant", content: "Started: I'll write when it ends." },
    { role: "user", content: "Done yet?" },
  ];
  assert.equal(joinOwnAnswer(turns, "Done: 42 ms."), true);
  assert.equal(turns[1].content, "Started: I'll write when it ends.\n\nDone: 42 ms.");
  assert.equal(turns.length, 3, "still question, answer, question");
  // A failed answer is never saved: the one before it takes it.
  const failed = [{ role: "user", content: "a" }, { role: "assistant", content: "A" }, { role: "user", content: "b" }, { role: "assistant", content: "Error", failed: true }];
  joinOwnAnswer(failed, "B");
  assert.equal(failed[1].content, "A\n\nB");
  assert.equal(failed[3].content, "Error");
  assert.equal(joinOwnAnswer([{ role: "user", content: "a" }], "B"), false);
});

test("with storage full, the oldest chats go and the newest is still saved", () => {
  const long = (id) => ({ ...chat(id), turns: [{ role: "user", content: "x".repeat(1000) }] });
  for (const id of ["a", "b", "c"]) saveChat(long(id));
  quota = 2500;
  const kept = saveChat(long("d"));
  assert.deepEqual(kept.map((c) => c.id), ["d", "c"]);
  assert.deepEqual(loadChats().map((c) => c.id), ["d", "c"]);
  saveChat(long("e"));
  assert.deepEqual(loadChats().map((c) => c.id), ["e", "d"], "and it goes on saving");
});
