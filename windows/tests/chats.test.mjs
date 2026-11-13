// Past chats (src/core/chats.ts): kept newest first, capped, deleted one by one.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CHATS, PICTURE_CHARS, RECAP_PICTURES, boundPictures, chatTitle, compactOf, deleteChat, joinOwnAnswer, loadChats, saveChat, setCompact, toSavedTurn,
} from "../src/core/chats.ts";

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

test("what Claude Code writes by itself joins what the conversation kept too, as Rust's add_own does", () => {
  // An answer stopped with nothing written keeps "(No answer.)" in Rust: the own answer joins it there.
  const turns = [{ role: "user", content: "Open Notepad" }, { role: "assistant", content: "", kept: "(No answer.)" }];
  joinOwnAnswer(turns, "Notepad is open.");
  assert.equal(turns[1].content, "Notepad is open.");
  assert.equal(turns[1].kept, "(No answer.)\n\nNotepad is open.");
  // None kept: none made up.
  const plain = [{ role: "user", content: "a" }, { role: "assistant", content: "A" }];
  joinOwnAnswer(plain, "B");
  assert.equal("kept" in plain[1], false);
});

test("the own answer's save keeps each turn's time, what it kept and its recap", () => {
  const recap = { agent: "Claude Code", color: "#D97757", actions: 1, ms: 1000, steps: [{ text: "Open", status: "done" }] };
  const history = [
    { id: 1, role: "user", content: "Open Notepad", at: 5 },
    { id: 2, role: "assistant", content: "", at: 6, kept: "(No answer.)", stopped: true, computer: recap },
    { id: 3, role: "assistant", content: "Error", failed: true },
  ];
  joinOwnAnswer(history, "Done.");
  const turns = history.filter((m) => !m.failed).map(toSavedTurn);
  assert.deepEqual(turns, [
    { role: "user", content: "Open Notepad", at: 5 },
    { role: "assistant", content: "Done.", at: 6, kept: "(No answer.)\n\nDone.", computer: recap },
  ]);
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

// ── Computer use recaps' pictures ─────────────────────────────────────────────

const picture = (n) => "A".repeat(n);
/** A chat with one computer use answer, its steps' pictures `size` characters each. */
const computerChat = (id, size = 100, pictures = 2) => ({
  ...chat(id),
  turns: [
    { role: "user", content: `Use the computer ${id}` },
    {
      role: "assistant", content: "Done.",
      computer: {
        agent: "Claude Code", color: "#D97757", actions: 3, ms: 9000,
        steps: Array.from({ length: pictures }, (_, i) => ({ text: `Step ${i + 1}`, status: "done", image: picture(size) })),
      },
    },
  ],
});
const pictured = (c) => c.turns.some((t) => t.computer?.steps.some((s) => s.image));

test("only the newest recaps keep their pictures; the older keep their steps' text", () => {
  for (let i = 0; i < RECAP_PICTURES + 3; i++) saveChat(computerChat(`c${i}`));
  const list = loadChats();
  assert.equal(list.length, RECAP_PICTURES + 3, "every chat is kept");
  assert.deepEqual(list.map(pictured), list.map((_, i) => i < RECAP_PICTURES));
  const old = list.at(-1).turns[1].computer;
  assert.deepEqual(old.steps, [{ text: "Step 1", status: "done" }, { text: "Step 2", status: "done" }]);
  assert.deepEqual([old.actions, old.ms, old.agent], [3, 9000, "Claude Code"]);
  // In a chat, its last answers come first.
  const two = { ...computerChat("two"), turns: [...computerChat("x").turns, ...computerChat("y").turns] };
  const [bounded] = boundPictures([two], 1);
  assert.deepEqual(bounded.turns.map((t) => !!t.computer?.steps[0].image), [false, false, false, true]);
  assert.equal(two.turns[1].computer.steps[0].image.length, 100, "the list given is not changed");
});

test("the pictures together stay within their budget", () => {
  const half = Math.floor(PICTURE_CHARS / 4);
  // Two pictures of a quarter each: two recaps fit, the third would be over.
  for (const id of ["a", "b", "c"]) saveChat(computerChat(id, half));
  assert.deepEqual(loadChats().map((c) => [c.id, pictured(c)]), [["c", true], ["b", true], ["a", false]]);
});

test("with storage full, the pictures go before any chat, the oldest recap's first", () => {
  for (const id of ["a", "b", "c"]) saveChat(computerChat(id, 1000));
  quota = JSON.stringify(loadChats()).length + 400;
  // A new chat with no pictures needs room: the oldest recap's pictures go, every chat stays.
  saveChat({ ...chat("d"), turns: [{ role: "user", content: "x".repeat(1000) }] });
  assert.deepEqual(loadChats().map((c) => [c.id, pictured(c)]), [["d", false], ["c", true], ["b", true], ["a", false]]);
  // Fuller still: every picture goes, and only then a chat.
  const textOnly = loadChats().map((c) => boundPictures([c], 0)[0]);
  quota = JSON.stringify(textOnly).length + 500;
  saveChat({ ...chat("e"), turns: [{ role: "user", content: "x".repeat(1000) }] });
  const ids = loadChats().map((c) => c.id);
  assert.ok(ids.length < 5 && ids[0] === "e", ids.join());
  assert.ok(loadChats().every((c) => !pictured(c)), "no picture is kept while a chat is dropped");
  // The steps' text stays.
  assert.ok(loadChats().filter((c) => c.turns[1]?.computer).every((c) => c.turns[1].computer.steps.length === 2));
});
