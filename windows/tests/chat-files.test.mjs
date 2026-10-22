// The chat's files (src/core/chat-files.ts): one row per file, newest first,
// keeping what says most about it, kept by chat and dropped with the chat.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { saveChat } from "../src/core/chats.ts";
import { MAX_FILES, addChatFile, chatFiles, dropChatFiles, fileName, withFile } from "../src/core/chat-files.ts";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const chat = (id) => ({ id, title: id, updatedAt: 1, provider: "claude-code", session: null, turns: [{ role: "user", content: id }] });

beforeEach(() => mem.clear());

test("a file is listed once, newest first, keeping what says most about it", () => {
  addChatFile("a", "read", String.raw`C:\Docs\report.pdf`, undefined, 1);
  addChatFile("a", "created", String.raw`C:\Work\game.py`, undefined, 2);
  addChatFile("a", "edited", "c:/work/game.py", undefined, 3);
  const list = addChatFile("a", "edited", String.raw`C:\Docs\report.pdf`, undefined, 4);
  assert.deepEqual(list.map((f) => [f.name, f.kind, f.at]), [["report.pdf", "edited", 4], ["game.py", "created", 3]]);
  // Read again after it was changed: still changed.
  const again = addChatFile("a", "read", String.raw`C:\Docs\report.pdf`, undefined, 5);
  assert.equal(again[0].kind, "edited");
  assert.equal(chatFiles("b").length, 0, "each chat its own");
});

test("an attached file keeps its own name, and a chat keeps only its newest files", () => {
  const list = addChatFile("a", "attached", String.raw`C:\inbox\report (2).pdf`, "report.pdf");
  assert.equal(list[0].name, "report.pdf");
  let many = [];
  for (let i = 0; i < MAX_FILES + 5; i++) many = withFile(many, { path: `/f${i}`, name: `f${i}`, kind: "read", at: i });
  assert.equal(many.length, MAX_FILES);
  assert.equal(many[0].name, `f${MAX_FILES + 4}`);
  assert.equal(fileName(String.raw`C:\a\b\notes.md`), "notes.md");
  assert.equal(fileName("/home/me/x.txt"), "x.txt");
});

test("a deleted chat's files are forgotten, and so are those of chats no longer kept", () => {
  saveChat(chat("kept"));
  addChatFile("kept", "read", "/a.txt");
  addChatFile("gone", "read", "/b.txt");
  dropChatFiles("gone");
  assert.equal(chatFiles("gone").length, 0);
  addChatFile("old", "read", "/c.txt");
  addChatFile("kept", "read", "/d.txt");
  assert.equal(chatFiles("old").length, 0, "not among the past chats");
  assert.equal(chatFiles("kept").length, 2);
});

test("storage that is broken or of another shape leaves an empty list", () => {
  mem.set("lumo.chatFiles.v1", "{nope");
  assert.deepEqual(chatFiles("a"), []);
  mem.set("lumo.chatFiles.v1", JSON.stringify({ a: [{ path: 1 }, { path: "/x", name: "x", kind: "weird", at: 1 }] }));
  assert.deepEqual(chatFiles("a"), []);
});
