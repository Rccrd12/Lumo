// What Lumo heard, in the chat (src/views/chat.ts with src/core/heard.ts): a
// line in the chat that asked, the AI woken only for a task, a task done in
// its own chat while the one on screen stays, and what waits to be seen (the
// bar with Open that chat and Close, the waves, the clock's badge).

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, emit, internals, sent } from "./tauri.mjs";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

installFakeDom();
const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { loadChats, saveChat } = await import("../src/core/chats.ts");
const { setCompactNewsHandler } = await import("../src/core/compact.ts");

let answers;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : answers[cmd];
  return result;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let view;
const $ = (cls) => view.el.querySelector(cls);

const watch = (id, chatId, task = "", more = {}) => ({ id, repo: "", number: 0, until: "new", task, chatId, startedAt: 0, source: "email", target: "", mode: "once", ...more });

beforeEach(() => {
  mem.clear();
  calls.length = 0;
  answers = {};
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {} };
  State.startChat();
  State.chatHistory = [
    { id: 1, role: "user", content: "Mail for Giulia", at: 1000, turn: 0 },
    { id: 2, role: "assistant", content: "Here it is.", at: 2000, turn: 1 },
  ];
  State.chatSession = null;
  State.mode = "expanded";
  State.view = "prompt";
  State.listening = [];
  State.listenPending = [];
  saveChat({ id: State.chatId, title: "Mail for Giulia", updatedAt: 2, provider: "claude-code", session: null, turns: [{ role: "user", content: "Mail for Giulia" }, { role: "assistant", content: "Here it is." }] });
  saveChat({ id: "release", title: "Release 0.23", updatedAt: 1, provider: "claude-code", session: null, turns: [{ role: "user", content: "Release 0.23" }, { role: "assistant", content: "Ok." }] });
  view = buildPrompt(() => {});
  $(".chat-input").value = "";
  view.sync();
});

test("only to be told, in the chat on screen: a line in the chat, the AI not woken", async () => {
  emit("listen-fired", { watch: watch(1, State.chatId), met: true, summary: "New email from Marco: Quote", ended: true });
  await flush();
  view.sync();
  const rows = view.el.find(".heard-row");
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /New email from Marco: Quote/);
  assert.equal(sent("chat_send").length, 0, "nothing is sent to the AI");
  assert.deepEqual(State.listenPending, [], "the chat is open: seen at once");

  // Ask Claude: what was heard goes as a message, and the button goes.
  answers.chat_send = { text: "Marco wrote about the quote.", turns: 4 };
  const ask = rows[0].find(".listen-head-btn").find((b) => /^Ask /.test(b.textContent));
  assert.ok(ask, "Ask is offered");
  ask.fire("click");
  await flush();
  await flush();
  view.sync();
  assert.equal(sent("chat_send").length, 1);
  assert.match(sent("chat_send")[0].query, /New email from Marco: Quote/);
  assert.equal(view.el.find(".heard-row")[0].find(".listen-head-btn").filter((b) => /^Ask /.test(b.textContent)).length, 0);
});

test("heard for another chat: the bar names it, the waves and the clock light, Close is as if it was opened", async () => {
  const here = State.chatId;
  emit("listen-fired", { watch: watch(2, "release"), met: true, summary: "#241 is ready to merge", ended: true });
  await flush();
  view.sync();
  assert.equal(State.chatId, here, "the chat on screen stays");
  assert.equal(State.listenPending.length, 1);
  const bar = $(".heard-bar");
  assert.equal(bar.hidden, false);
  assert.match(bar.textContent, /#241 is ready to merge/);
  assert.match(bar.textContent, /Release 0\.23/);
  assert.ok($(".listen-btn").classList.contains("listening"), "the waves light");
  assert.equal($(".history-badge").textContent, "1");
  assert.equal(view.el.find(".heard-row").length, 0, "not in this chat");

  bar.find(".listen-head-btn").find((b) => b.textContent === "Close").fire("click");
  view.sync();
  assert.equal($(".heard-bar").hidden, true);
  assert.deepEqual(State.listenPending, []);
  assert.ok(!$(".listen-btn").classList.contains("listening"), "nothing else waits, nothing listens here");
  assert.equal($(".history-badge").textContent, "");
});

test("heard while the island is hidden: the closed island comes out to say it", async () => {
  let news = 0;
  setCompactNewsHandler(() => news++);
  try {
    // The chat on screen, open: seen at once, nothing to come out for.
    emit("listen-fired", { watch: watch(1, State.chatId), met: true, summary: "New email from Marco: Quote", ended: true });
    await flush();
    assert.equal(news, 0);
    // Hidden: what another chat heard waits, and the island comes out for it.
    State.mode = "hidden";
    emit("listen-fired", { watch: watch(2, "release"), met: true, summary: "#241 is ready to merge", ended: true });
    await flush();
    assert.equal(State.listenPending.length, 1);
    assert.equal(news, 1);
  } finally {
    setCompactNewsHandler(null);
  }
});

test("Open that chat brings it on screen, with its line", async () => {
  emit("listen-fired", { watch: watch(2, "release"), met: true, summary: "#241 is ready to merge", ended: true });
  await flush();
  view.sync();
  $(".heard-bar").find(".listen-head-btn").find((b) => b.textContent === "Open that chat").fire("click");
  view.sync();
  assert.equal(State.chatId, "release");
  assert.deepEqual(State.listenPending, []);
  assert.equal($(".heard-bar").hidden, true);
  assert.equal(view.el.find(".heard-row").length, 1);
});

test("a task for another chat is done there, in the background; the chat on screen stays as it is", async () => {
  const here = State.chatId;
  let finish;
  answers.chat_send = () => new Promise((resolve) => (finish = resolve));
  emit("listen-fired", { watch: watch(3, "release", "merge it with squash"), met: true, summary: "#241 is ready to merge", ended: true });
  await flush();
  await flush();
  view.sync();
  assert.deepEqual(sent("chat_load").map((a) => a.chatId), ["release"], "its conversation, beside the one on screen");
  assert.equal(sent("chat_restore").length, 0, "the chat on screen is not dropped");
  assert.deepEqual(sent("chat_send").map((a) => a.chatId), ["release"]);
  assert.match(sent("chat_send")[0].query, /merge it with squash/);
  assert.equal(State.chatId, here);
  assert.equal(State.chatHistory.length, 2, "nothing joined the chat on screen");
  assert.match($(".heard-bar").textContent, /takes care of it/);

  finish({ text: "Merged.", turns: 4 });
  await flush();
  await flush();
  const saved = loadChats().find((c) => c.id === "release");
  assert.deepEqual(saved.turns.map((t) => t.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(saved.turns.at(-1).content, "Merged.");
  assert.equal(State.chatId, here);
});

test("a task for another chat goes to that chat's provider and model; the picker stays on the one on screen", async () => {
  saveChat({ ...loadChats().find((c) => c.id === "release"), provider: "openai", model: "gpt-4.1" });
  answers.chat_send = { text: "Merged.", turns: 4 };
  emit("listen-fired", { watch: watch(7, "release", "merge it"), met: true, summary: "#241 is ready to merge", ended: true });
  await flush();
  await flush();
  assert.deepEqual(sent("chat_send").map((a) => [a.chatId, a.provider, a.model]), [["release", "openai", "gpt-4.1"]]);
  assert.equal(State.settings.chatProvider, "anthropic");
  assert.equal(sent("save_settings").length, 0);
});

test("a task for another chat on a model since retired goes to the one its provider offers now", async () => {
  saveChat({ ...loadChats().find((c) => c.id === "release"), provider: "anthropic", model: "claude-retired-3" });
  answers.secret_present = true;
  answers.chat_models = [{ id: "claude-opus-5-5", label: "claude-opus-5-5" }, { id: "claude-sonnet-5-5", label: "claude-sonnet-5-5" }];
  answers.chat_send = { text: "Merged.", turns: 4 };
  emit("listen-fired", { watch: watch(8, "release", "merge it"), met: true, summary: "#241 is ready to merge", ended: true });
  for (let i = 0; i < 6; i++) await flush();
  assert.deepEqual(sent("chat_send").map((a) => [a.chatId, a.provider, a.model]), [["release", "anthropic", "claude-opus-5-5"]]);
  assert.equal(loadChats().find((c) => c.id === "release").model, "claude-opus-5-5");
});

test("a watch that goes on offers Stop listening on its line", async () => {
  const w = watch(4, State.chatId, "", { mode: "every" });
  emit("listen-changed", [w]);
  emit("listen-fired", { watch: w, met: true, summary: "New email", ended: false });
  await flush();
  view.sync();
  const stop = view.el.find(".heard-row")[0].find(".listen-head-btn").find((b) => b.textContent === "Stop listening");
  assert.ok(stop);
  stop.fire("click");
  await flush();
  assert.deepEqual(sent("listen_stop"), [{ id: 4 }]);
});

test("a chat that was deleted: only to be told, the closed island says it; nothing waits", async () => {
  emit("listen-fired", { watch: watch(5, "gone"), met: true, summary: "New email", ended: true });
  await flush();
  view.sync();
  assert.deepEqual(State.listenPending, []);
  assert.equal(sent("chat_send").length, 0);
});

test("a task for the chat put aside by the tool workshop waits until it is back, then goes there", async () => {
  const here = State.chatId;
  answers.chat_send = { text: "Merged.", turns: 4 };
  State.useSlot("forge");
  view.sync();
  emit("listen-fired", { watch: watch(6, here, "merge it"), met: true, summary: "#7 is ready to merge", ended: true });
  await flush();
  await flush();
  assert.equal(sent("chat_send").length, 0, "its history is put aside: nothing goes meanwhile");
  State.useSlot("chat");
  view.sync();
  await flush();
  await flush();
  await flush();
  assert.deepEqual(sent("chat_send").map((a) => a.chatId), [here]);
  assert.equal(State.chatHistory.length, 4, "the message and its answer joined the chat on screen");
});

test("a watch started from a new, still empty chat keeps its line there", async () => {
  State.startChat();
  view.sync();
  const fresh = State.chatId;
  State.mode = "compact";
  emit("listen-fired", { watch: watch(7, fresh), met: true, summary: "New email", ended: true });
  await flush();
  assert.deepEqual(State.listenPending.map((p) => p.chatId), [fresh], "it waits in that chat, not as a deleted one");
  State.mode = "expanded";
  view.sync();
  assert.equal(view.el.find(".heard-row").length, 1);
  assert.deepEqual(State.listenPending, [], "seen once the chat is open");
});

test("Ask stays while a question is edited: nothing was sent", async () => {
  emit("listen-fired", { watch: watch(8, State.chatId), met: true, summary: "New email", ended: true });
  await flush();
  view.sync();
  const edit = view.el.find(".msg-edit")[0];
  assert.ok(edit, "the first question can be edited");
  edit.fire("click");
  view.sync();
  const ask = () => view.el.find(".heard-row")[0].find(".listen-head-btn").find((b) => /^Ask /.test(b.textContent));
  ask().fire("click");
  view.sync();
  assert.equal(sent("chat_send").length, 0);
  assert.ok(ask(), "the button is still there");
});

test("a new, empty chat put aside by the workshop still gets its line", async () => {
  State.startChat();
  view.sync();
  const fresh = State.chatId;
  State.useSlot("forge");
  view.sync();
  emit("listen-fired", { watch: watch(9, fresh), met: true, summary: "New email", ended: true });
  await flush();
  assert.deepEqual(State.listenPending.map((p) => p.chatId), [fresh]);
  State.useSlot("chat");
  view.sync();
  assert.equal(view.el.find(".heard-row").length, 1);
});

test("a deleted chat's task lands in a new chat, whose line can still stop the watch", async () => {
  let finish;
  answers.chat_send = () => new Promise((resolve) => (finish = resolve));
  const w = watch(10, "gone", "sort it", { mode: "every" });
  emit("listen-changed", [w]);
  emit("listen-fired", { watch: w, met: true, summary: "New email", ended: false });
  await flush();
  await flush();
  const made = sent("chat_send")[0].chatId;
  assert.notEqual(made, "gone");
  $(".heard-bar").find(".listen-head-btn").find((b) => b.textContent === "Open that chat").fire("click");
  view.sync();
  assert.equal(State.chatId, made);
  const stop = view.el.find(".heard-row")[0].find(".listen-head-btn").find((b) => b.textContent === "Stop listening");
  assert.ok(stop);
  finish({ text: "Sorted.", turns: 2 });
  await flush();
});
