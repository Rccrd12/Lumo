// A computer use turn in the chat (src/views/chat.ts): stopped before a word,
// its recap is still kept under the answer and saved, and Claude Code's own
// answer saved after it keeps each turn as it was (src/core/chats.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { emit, internals } from "./tauri.mjs";

installFakeDom();
const mem = new Map();
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { loadChats } = await import("../src/core/chats.ts");

/** What the mocked Rust side answers, by command. */
let answers = {};
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : answers[cmd];
  return result;
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const recap = {
  agent: "Claude Code", color: "#D97757", actions: 4, ms: 30_000, stopped: true,
  steps: [{ text: "Open Notepad", status: "done" }, { text: "Write the text", status: "active" }],
};

test("stopped before a word while it used the computer: the answer is kept with its recap, as Rust kept the turn", async () => {
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {}, chatProvider: "claude-code" };
  State.chatHistory = [];
  State.view = "prompt";
  const view = buildPrompt(() => {});
  view.sync();
  // Rust committed the turn with "(No answer.)" (claude_code.rs) and sends the recap.
  answers.chat_send = { text: "", stopped: true, turns: 2, kept: "(No answer.)", computer: recap };
  view.el.querySelector(".chat-input").value = "Write hello in Notepad";
  view.el.querySelector(".send-btn").fire("click");
  for (let i = 0; i < 4; i++) await flush();
  view.sync();
  assert.deepEqual(
    State.chatHistory.map((m) => [m.role, m.content, m.turn, m.stopped ?? false, m.kept ?? null]),
    [["user", "Write hello in Notepad", 0, false, null], ["assistant", "", 1, true, "(No answer.)"]],
  );
  assert.equal(State.chatHistory[1].computer.stopped, true);
  assert.ok(view.el.querySelector(".cu-recap"), "the recap is under the answer");
  const saved = loadChats().find((c) => c.id === State.chatId);
  assert.deepEqual(saved.turns[1].computer.steps.map((s) => s.text), ["Open Notepad", "Write the text"]);
  assert.equal(saved.turns[1].kept, "(No answer.)");

  // Claude Code writes by itself afterwards: the save keeps each turn's time, what it kept and its recap.
  emit("chat-own-answer", { chat: State.chatId, text: "Notepad is open.", session: null });
  for (let i = 0; i < 3; i++) await flush();
  const after = loadChats().find((c) => c.id === State.chatId);
  assert.equal(after.turns[1].content, "Notepad is open.");
  assert.equal(after.turns[1].kept, "(No answer.)\n\nNotepad is open.", "as Rust's add_own joins it");
  assert.equal(typeof after.turns[0].at, "number");
  assert.equal(typeof after.turns[1].at, "number");
  assert.equal(after.turns[1].computer.stopped, true);
});
