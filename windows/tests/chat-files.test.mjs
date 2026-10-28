// The chat's files (src/core/chat-files.ts): one row per file, newest first,
// keeping what says most about it, kept by chat and dropped with the chat.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { saveChat } from "../src/core/chats.ts";
import {
  MAX_FILES, addChatFile, aiKind, chatFiles, dropChatFiles, fileName, filesByKind, removeChatFile, rewindChatFiles, withFile,
} from "../src/core/chat-files.ts";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const chat = (id) => ({ id, title: id, updatedAt: 1, provider: "claude-code", session: null, turns: [{ role: "user", content: id }] });

beforeEach(() => mem.clear());

test("a file is listed once, newest first, with everything that happened to it", () => {
  addChatFile("a", "read", String.raw`C:\Docs\report.pdf`, undefined, 1);
  addChatFile("a", "created", String.raw`C:\Work\game.py`, undefined, 2);
  addChatFile("a", "edited", "c:/work/game.py", undefined, 3);
  const list = addChatFile("a", "edited", String.raw`C:\Docs\report.pdf`, undefined, 4);
  assert.deepEqual(list.map((f) => [f.name, f.kinds, f.at]), [["report.pdf", ["read", "edited"], 4], ["game.py", ["edited", "created"], 3]]);
  assert.equal(aiKind(list[0]), "edited", "the most telling of what the AI did");
  assert.equal(chatFiles("b").length, 0, "each chat its own");
});

test("an attachment and the file the AI read where it is are one row, with the file's own path", () => {
  addChatFile("a", "attached", String.raw`C:\Users\me\AppData\Local\com.rccrd12.lumo\inbox\Analisi2 (2).tex`, "Analisi2.tex", 1);
  const list = addChatFile("a", "read", String.raw`C:\Users\me\OneDrive\LaTeX\Analisi2.tex`, undefined, 2);
  assert.deepEqual(list.map((f) => [f.path, f.kinds]), [[String.raw`C:\Users\me\OneDrive\LaTeX\Analisi2.tex`, ["attached", "read"]]]);
  // Attached again later: still one row, still where the file is.
  const again = addChatFile("a", "attached", String.raw`C:\inbox\Analisi2.tex`, "Analisi2.tex", 3);
  assert.equal(again.length, 1);
  assert.equal(again[0].path, String.raw`C:\Users\me\OneDrive\LaTeX\Analisi2.tex`);
  assert.equal(aiKind({ ...again[0], kinds: ["attached"] }), null);
});

test("rows saved apart by 0.13.0 come together when read", () => {
  mem.set("lumo.chatFiles.v1", JSON.stringify({
    a: [
      { path: String.raw`C:\OneDrive\Analisi2.tex`, name: "Analisi2.tex", kind: "read", at: 2 },
      { path: String.raw`C:\inbox\Analisi2.tex`, name: "Analisi2.tex", kind: "attached", at: 1 },
    ],
  }));
  assert.deepEqual(chatFiles("a").map((f) => [f.path, f.kinds]), [[String.raw`C:\OneDrive\Analisi2.tex`, ["attached", "read"]]]);
});

test("an attached file keeps its own name, and a chat keeps only its newest files", () => {
  const list = addChatFile("a", "attached", String.raw`C:\inbox\report (2).pdf`, "report.pdf");
  assert.equal(list[0].name, "report.pdf");
  let many = [];
  for (let i = 0; i < MAX_FILES + 5; i++) many = withFile(many, { path: `/f${i}`, name: `f${i}`, kinds: ["read"], at: i });
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

test("the chat's files are shown in a folder per kind, a file in each of its kinds, empty kinds left out", () => {
  addChatFile("a", "attached", String.raw`C:\inbox\notes.md`, "notes.md", 1);
  addChatFile("a", "read", String.raw`C:\Docs\notes.md`, undefined, 2);
  addChatFile("a", "created", String.raw`C:\Work\game.py`, undefined, 3);
  const groups = filesByKind(chatFiles("a"));
  assert.deepEqual(groups.map((g) => [g.kind, g.files.map((f) => f.name)]), [
    ["attached", ["notes.md"]],
    ["read", ["notes.md"]],
    ["created", ["game.py"]],
  ]);
  assert.deepEqual(filesByKind([]), []);
});

test("an edited message takes back what happened in the turns it drops", () => {
  // Turn 0: notes.md attached; turn 2: it is read, and b.pdf attached; turn 4: game.py created.
  addChatFile("a", "attached", String.raw`C:\inbox\notes.md`, "notes.md", 1, 0);
  addChatFile("a", "read", String.raw`C:\inbox\notes.md`, undefined, 2, 2);
  addChatFile("a", "attached", String.raw`C:\inbox\b.pdf`, "b.pdf", 3, 2);
  addChatFile("a", "created", String.raw`C:\Work\game.py`, undefined, 4, 4);
  // A file saved before turns were kept stays.
  addChatFile("a", "read", String.raw`C:\Old\old.txt`, undefined, 0);
  const kept = rewindChatFiles("a", 2);
  assert.deepEqual(kept.map((f) => [f.name, f.kinds]), [["old.txt", ["read"]], ["notes.md", ["attached"]]]);
  assert.deepEqual(chatFiles("a").map((f) => f.name), ["old.txt", "notes.md"], "kept in storage");
  assert.deepEqual(rewindChatFiles("a", 0).map((f) => f.name), ["old.txt"]);
  assert.deepEqual(rewindChatFiles("nobody", 0), []);
});

test("a file's × takes it out of the list, with the inbox's copy of it", () => {
  addChatFile("a", "attached", String.raw`C:\inbox\notes (2).md`, "notes.md", 1);
  addChatFile("a", "read", String.raw`C:\Docs\notes.md`, undefined, 2);
  addChatFile("a", "edited", String.raw`C:\Work\game.py`, undefined, 3);
  const [notes] = chatFiles("a").filter((f) => f.name === "notes.md");
  assert.deepEqual(removeChatFile("a", notes).map((f) => f.name), ["game.py"]);
  assert.deepEqual(chatFiles("a").map((f) => f.name), ["game.py"]);
});
