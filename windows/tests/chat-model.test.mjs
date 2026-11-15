// Each chat keeps its own provider and model (src/core/chats.ts chatModelOf):
// back on a chat, the picker shows what that chat was on, and its questions
// go to that provider and model, even while another chat is on screen.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, internals, sent } from "./tauri.mjs";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

installFakeDom();
const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { chatModelOf, deleteChat, loadChats, saveChat, setChatModel } = await import("../src/core/chats.ts");
const { onChatModel } = await import("../src/core/providers.ts");

/** What the mocked Rust side answers, by command. */
let answers;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : answers[cmd];
  return result;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let view;
let chats = 0;
beforeEach(() => {
  mem.clear();
  calls.length = 0;
  answers = {
    secret_present: true,
    chat_send: { text: "ok", turns: 2 },
    chat_models: ({ provider }) => (provider === "openai"
      ? [{ id: "gpt-4o", label: "gpt-4o" }, { id: "gpt-4.1", label: "gpt-4.1" }]
      : [{ id: "claude-opus-5-5", label: "claude-opus-5-5" }, { id: "claude-sonnet-5-5", label: "claude-sonnet-5-5" }]),
  };
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {} };
  State.chatId = `model-${++chats}`;
  State.chatHistory = [];
  State.stateOverride = null;
  State.view = "prompt";
  State.droppedFile = null;
  State.chatSession = null;
  State.chatSlot = "chat";
  view = buildPrompt(() => {});
  view.sync();
});

const $ = (cls) => view.el.querySelector(cls);
const button = (title) => view.el.find(".tool-btn").find((b) => b.getAttribute("title") === title);
const shown = () => $(".model-name").textContent;

function type(key) {
  const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
  for (const fn of $(".chat-input").listeners.get("keydown")) fn(event);
  return event;
}

async function ask(text) {
  $(".chat-input").value = text;
  type("Enter");
  await flush();
  await flush();
  view.sync();
}

/** Picks a provider's chip, then one of its models, as the user would. */
async function pick(provider, model) {
  $(".model-btn").fire("click");
  await flush();
  view.el.find(".picker-chip").find((c) => c.textContent === provider)?.fire("click");
  await flush();
  await flush();
  view.el.find(".picker-model").find((m) => m.textContent === model).fire("click");
  view.sync();
}

function reopen(title) {
  button("Past chats").fire("click");
  view.el.find(".history-row").find((r) => r.getAttribute("title") === title).fire("click");
  view.sync();
}

/** The provider and model each question went to Rust with. */
const asked = () => sent("chat_send").map((a) => [a.query, a.provider, a.model]);

test("back on a chat, the picker shows the model that chat was on, not the last one picked", async () => {
  await ask("summarise the lease");
  const a = State.chatId;
  assert.equal(shown(), "claude-opus-5-5");

  button("New chat").fire("click");
  view.sync();
  await pick("OpenAI", "gpt-4.1");
  await ask("sort the dates");
  assert.equal(shown(), "gpt-4.1");

  reopen("summarise the lease");
  assert.equal(State.chatId, a);
  assert.equal(State.settings.chatProvider, "anthropic");
  assert.equal(shown(), "claude-opus-5-5");
  assert.equal(sent("save_settings").at(-1).settings.chatProvider, "anthropic", "the next new chat starts on it");
  await ask("and the deposit?");

  reopen("sort the dates");
  assert.equal(shown(), "gpt-4.1");
  await ask("newest first");

  assert.deepEqual(asked(), [
    ["summarise the lease", "anthropic", "claude-opus-5-5"],
    ["sort the dates", "openai", "gpt-4.1"],
    ["and the deposit?", "anthropic", "claude-opus-5-5"],
    ["newest first", "openai", "gpt-4.1"],
  ]);
  assert.deepEqual(loadChats().map((c) => [c.title, c.provider, c.model]), [
    ["sort the dates", "openai", "gpt-4.1"],
    ["summarise the lease", "anthropic", "claude-opus-5-5"],
  ]);
});

test("a model picked in a chat without asking anything is still there when it comes back", async () => {
  await ask("summarise the lease");
  button("New chat").fire("click");
  view.sync();
  await ask("sort the dates");

  reopen("summarise the lease");
  await pick("Anthropic", "claude-sonnet-5-5");
  const saved = () => loadChats().find((c) => c.title === "summarise the lease");
  assert.equal(saved().model, "claude-sonnet-5-5");
  assert.equal(loadChats()[0].title, "sort the dates", "picking does not move the chat up the history");

  reopen("sort the dates");
  assert.equal(shown(), "claude-opus-5-5");
  reopen("summarise the lease");
  assert.equal(shown(), "claude-sonnet-5-5");
});

test("a new chat starts on the model the picker shows", async () => {
  await pick("OpenAI", "gpt-4o");
  await ask("first");
  button("New chat").fire("click");
  view.sync();
  assert.equal(shown(), "gpt-4o");
  await ask("second");
  assert.deepEqual(asked().map((a) => a[1]), ["openai", "openai"]);
});

test("a model picked while the chat's first answer is written is the one it is saved with", async () => {
  let answer;
  answers.chat_send = () => new Promise((resolve) => (answer = resolve));
  await ask("long one");
  await pick("Anthropic", "claude-sonnet-5-5");
  answer({ text: "done", turns: 2 });
  await flush();
  await flush();
  const saved = loadChats().find((c) => c.title === "long one");
  assert.deepEqual([saved.provider, saved.model], ["anthropic", "claude-sonnet-5-5"]);
  assert.equal(sent("chat_send")[0].model, "claude-opus-5-5", "the question already sent kept its own");
});

test("a chat saved before each chat kept its model goes back to its provider, with that provider's model", () => {
  saveChat({ id: "old", title: "old one", updatedAt: 1, provider: "openai", session: null, turns: [{ role: "user", content: "old one" }] });
  State.settings = { ...State.settings, chatModels: { openai: "gpt-4o" } };
  reopen("old one");
  assert.equal(State.settings.chatProvider, "openai");
  assert.equal(shown(), "gpt-4o");
});

test("a provider the picker no longer offers leaves the picker as it is", () => {
  const settings = { ...DEFAULT_SETTINGS, chatModels: {} };
  const hidden = { ...settings, hiddenChatProviders: ["codex"] };
  assert.equal(onChatModel(hidden, { provider: "codex", model: "gpt-5" }), hidden);
  assert.equal(onChatModel(settings, { provider: "openai", model: "gpt-4o" }, new Set(["anthropic"])), settings, "no key any more");
  assert.equal(onChatModel(settings, { provider: "ollama", model: "llama3" }), settings, "no server address");
  assert.equal(onChatModel(settings, { provider: "gone", model: "x" }), settings);
  assert.equal(onChatModel(settings, null), settings);
  const on = onChatModel(settings, { provider: "openai", model: "gpt-4.1" }, new Set(["openai"]));
  assert.deepEqual([on.chatProvider, on.chatModels.openai], ["openai", "gpt-4.1"]);
});

test("what was picked in a chat goes with it, and goes when it is deleted", () => {
  setChatModel("fresh", "google", "gemini-2.0-flash");
  assert.deepEqual(chatModelOf("fresh"), { provider: "google", model: "gemini-2.0-flash" });
  saveChat({ id: "fresh", title: "t", updatedAt: 1, provider: "anthropic", model: "claude-opus-5-5", session: null, turns: [{ role: "user", content: "t" }] });
  assert.deepEqual([loadChats()[0].provider, loadChats()[0].model], ["google", "gemini-2.0-flash"]);
  deleteChat("fresh");
  assert.equal(chatModelOf("fresh"), null);
});

test("a voice call's transcript, reopened, leaves the picker as it is, and so the next new chat", async () => {
  await pick("Anthropic", "claude-sonnet-5-5");
  await ask("work question");
  // As live/session.ts saves a call.
  saveChat({ id: "call", title: "voice call", updatedAt: 1, provider: "google", call: true, session: null, turns: [{ role: "user", content: "voice call" }, { role: "assistant", content: "hi" }] });
  const settingsSaved = sent("save_settings").length;
  reopen("voice call");
  assert.equal(State.chatId, "call");
  assert.equal(State.settings.chatProvider, "anthropic");
  assert.equal(shown(), "claude-sonnet-5-5");
  assert.equal(sent("save_settings").length, settingsSaved);
  await ask("and in writing?");
  button("New chat").fire("click");
  view.sync();
  await ask("next work question");
  assert.deepEqual(asked().slice(-2), [
    ["and in writing?", "anthropic", "claude-sonnet-5-5"],
    ["next work question", "anthropic", "claude-sonnet-5-5"],
  ]);
});

test("a voice call carried on in writing keeps the model that answered it", async () => {
  saveChat({ id: "call", title: "voice call", updatedAt: 1, provider: "google", call: true, session: null, turns: [{ role: "user", content: "voice call" }, { role: "assistant", content: "hi" }] });
  reopen("voice call");
  await pick("OpenAI", "gpt-4.1");
  await ask("in writing");
  button("New chat").fire("click");
  view.sync();
  await pick("Anthropic", "claude-opus-5-5");
  reopen("voice call");
  assert.equal(shown(), "gpt-4.1");
});

test("a chat on a model since retired comes back on the one the picker would pick, and the next new chat too", async () => {
  await pick("Anthropic", "claude-opus-5-5");
  await ask("today");
  saveChat({ id: "spring", title: "spring chat", updatedAt: 1, provider: "anthropic", model: "claude-retired-3", session: null, turns: [{ role: "user", content: "spring chat" }, { role: "assistant", content: "ok" }] });
  reopen("spring chat");
  await flush();
  await flush();
  view.sync();
  assert.equal(shown(), "claude-opus-5-5");
  assert.equal(loadChats().find((c) => c.id === "spring").model, "claude-opus-5-5");
  assert.equal(sent("save_settings").at(-1).settings.model, "claude-opus-5-5");
  await ask("follow up");
  button("New chat").fire("click");
  view.sync();
  await ask("brand new");
  assert.deepEqual(asked().slice(-2).map((a) => a[2]), ["claude-opus-5-5", "claude-opus-5-5"]);
});

test("a question asked right after the chat opens waits for its model to be checked", async () => {
  saveChat({ id: "spring", title: "spring chat", updatedAt: 1, provider: "anthropic", model: "claude-retired-3", session: null, turns: [{ role: "user", content: "spring chat" }, { role: "assistant", content: "ok" }] });
  const list = answers.chat_models;
  let listed;
  answers.chat_models = (args) => new Promise((resolve) => (listed = () => resolve(list(args))));
  reopen("spring chat");
  await ask("at once");
  assert.equal(sent("chat_send").length, 0, "not sent before the list came");
  listed();
  await flush();
  await flush();
  await flush();
  assert.deepEqual(asked().at(-1), ["at once", "anthropic", "claude-opus-5-5"]);
});

test("a model still offered is left as it is; a CLI or a model server is not started to check one", async () => {
  saveChat({ id: "kept", title: "kept chat", updatedAt: 1, provider: "openai", model: "gpt-4.1", session: null, turns: [{ role: "user", content: "kept chat" }, { role: "assistant", content: "ok" }] });
  saveChat({ id: "agy", title: "agy chat", updatedAt: 2, provider: "antigravity-cli", model: "gemini-old", session: null, turns: [{ role: "user", content: "agy chat" }, { role: "assistant", content: "ok" }] });
  reopen("kept chat");
  await flush();
  await flush();
  assert.equal(loadChats().find((c) => c.id === "kept").model, "gpt-4.1");
  const listsAsked = sent("chat_models").length;
  reopen("agy chat");
  await flush();
  await flush();
  assert.equal(sent("chat_models").slice(listsAsked).filter((a) => a.provider === "antigravity-cli").length, 0);
  assert.equal(loadChats().find((c) => c.id === "agy").model, "gemini-old");
});
