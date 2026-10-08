// Past chats (src/core/chats.ts): kept newest first, capped, deleted one by one.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CHATS, chatTitle, deleteChat, loadChats, saveChat } from "../src/core/chats.ts";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const chat = (id, title = id) => ({ id, title, updatedAt: 1, provider: "claude-code", session: null, turns: [{ role: "user", content: title }] });

beforeEach(() => mem.clear());

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
  mem.set("coucou.chats.v1", "{not json");
  assert.deepEqual(loadChats(), []);
  mem.set("coucou.chats.v1", JSON.stringify([{ nope: 1 }, chat("ok")]));
  assert.deepEqual(loadChats().map((c) => c.id), ["ok"]);
});

test("the title is the first question on one line, shortened", () => {
  assert.equal(chatTitle([{ role: "assistant", content: "hi" }, { role: "user", content: "  what\nis   this?" }]), "what is this?");
  assert.equal(chatTitle([{ role: "user", content: "x".repeat(100) }]).length, 60);
  assert.equal(chatTitle([]), "");
});
