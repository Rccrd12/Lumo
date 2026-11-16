// Claude Code lists the models of the user's plan (claude_code.rs `listed`):
// the picker shows the current ones, then "More models", which opens on the
// older versions. Open by itself when the chat is on one of them.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { internals, sent } from "./tauri.mjs";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

installFakeDom();
const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");

/** What Claude Code lists, as Rust passes it on. */
const LISTED = [
  { id: "default", label: "Default (Fable 5.2)" },
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-fable-5-2", label: "Fable 5.2" },
  { id: "claude-fable-5-1", label: "Fable 5.1", older: true },
  { id: "claude-opus-4-8", label: "Opus 4.8", older: true },
];

const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (cmd === "chat_models") return args.provider === "claude-code" ? LISTED : [{ id: "gpt-4o", label: "gpt-4o" }];
  if (cmd === "secret_present") return true;
  return result;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let view;
let chats = 0;
beforeEach(() => {
  mem.clear();
  State.chatId = `more-${++chats}`;
  State.chatHistory = [];
  State.view = "prompt";
});

async function openPicker(model) {
  State.settings = { ...DEFAULT_SETTINGS, chatProvider: "claude-code", chatModels: { "claude-code": model } };
  view = buildPrompt(() => {});
  view.sync();
  view.el.querySelector(".model-btn").fire("click");
  await flush();
  await flush();
}

const rows = () => view.el.find(".picker-model").map((r) => r.textContent);
const more = () => view.el.querySelector(".picker-more");

test("the older versions wait under More models, after the current ones, and open on a click", async () => {
  await openPicker("claude-opus-5-5");
  assert.deepEqual(rows(), ["Default (Fable 5.2)", "Opus 5.5", "Fable 5.2", "More models (2)"]);
  assert.equal(more().getAttribute("aria-expanded"), "false");

  more().fire("click");
  assert.deepEqual(rows(), ["Default (Fable 5.2)", "Opus 5.5", "Fable 5.2", "More models (2)", "Fable 5.1", "Opus 4.8"]);
  assert.ok(more().classList.contains("open"));
  assert.ok(view.el.querySelector(".picker.models").classList.contains("on"), "opening them keeps the picker open");

  view.el.find(".picker-model").find((r) => r.textContent === "Opus 4.8").fire("click");
  assert.equal(State.settings.chatModels["claude-code"], "claude-opus-4-8");
  assert.equal(sent("save_settings").at(-1).settings.chatModels["claude-code"], "claude-opus-4-8");

  // The next time the picker opens, the chat is on an older version: it shows, ticked.
  view.el.querySelector(".model-btn").fire("click");
  await flush();
  assert.ok(more().classList.contains("open"));
  assert.equal(view.el.querySelector(".picker-model.on").textContent, "Opus 4.8");
});

test("a chat on an older version finds More models already open, its model ticked", async () => {
  await openPicker("claude-fable-5-1");
  assert.ok(more().classList.contains("open"));
  assert.equal(view.el.querySelector(".picker-model.on").textContent, "Fable 5.1");
  // A click shuts it all the same.
  more().fire("click");
  assert.deepEqual(rows(), ["Default (Fable 5.2)", "Opus 5.5", "Fable 5.2", "More models (2)"]);
});

test("a list without older versions has no More models", async () => {
  State.settings = { ...DEFAULT_SETTINGS, chatProvider: "openai", chatModels: { openai: "gpt-4o" } };
  view = buildPrompt(() => {});
  view.sync();
  view.el.querySelector(".model-btn").fire("click");
  await flush();
  await flush();
  assert.equal(more(), null);
});
