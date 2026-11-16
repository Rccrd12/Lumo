// Each chat keeps what was written and attached in it and not sent yet, and
// what its AI may do without asking (views/chat.ts parkDraft, core/chats.ts
// chatPermissionsOf): another chat, or a new one, starts with its own, and
// coming back to a chat brings them back as they were left.

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
const { chatPermissionsOf, loadChats, saveChat, setChatPermissions } = await import("../src/core/chats.ts");

let answers;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : answers[cmd];
  return result;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let view;
let n = 0;
beforeEach(() => {
  mem.clear();
  calls.length = 0;
  answers = { secret_present: true, chat_send: { text: "ok", turns: 2 } };
  State.settings = { ...DEFAULT_SETTINGS, chatProvider: "claude-code", chatModels: {} };
  State.chatId = `draft-${++n}`;
  State.chatHistory = [];
  State.stateOverride = null;
  State.view = "prompt";
  State.droppedFile = null;
  State.moreFiles = [];
  State.promptContext = null;
  State.chatSession = null;
  State.chatSlot = "chat";
  view = buildPrompt(() => {});
  view.sync();
});

const $ = (cls) => view.el.querySelector(cls);
const button = (title) => view.el.find(".tool-btn").find((b) => b.getAttribute("title") === title);
const field = () => $(".chat-input");

function type(key) {
  const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
  for (const fn of field().listeners.get("keydown")) fn(event);
  return event;
}

async function ask(text) {
  field().value = text;
  type("Enter");
  await flush();
  await flush();
  view.sync();
}

function newChat() {
  button("New chat").fire("click");
  view.sync();
}

function reopen(title) {
  button("Past chats").fire("click");
  view.el.find(".history-row").find((r) => r.getAttribute("title") === title).fire("click");
  view.sync();
}

/** Picks a row of the shield's list, by its name. */
function shield(name) {
  $(".perm-btn").fire("click");
  view.el.find(".perm-row").find((r) => r.querySelector(".picker-model-name").textContent === name).fire("click");
  view.sync();
}

const attached = () => [State.droppedFile?.name, ...State.moreFiles.map((f) => f.name)].filter(Boolean);
const lit = () => $(".perm-btn").classList.contains("lit");

test("text and files not sent wait in their chat; a new chat starts empty", async () => {
  await ask("summarise the lease");
  const a = State.chatId;
  field().value = "and compare it with";
  State.droppedFile = { name: "lease.pdf", path: String.raw`C:\inbox\lease.pdf` };
  State.promptContext = { kind: "file", name: "lease.pdf", path: String.raw`C:\inbox\lease.pdf` };
  State.moreFiles = [{ name: "old-lease.pdf", path: String.raw`C:\inbox\old-lease.pdf` }];
  view.sync();

  newChat();
  assert.notEqual(State.chatId, a);
  assert.equal(field().value, "", "the new chat's field is empty");
  assert.deepEqual(attached(), []);
  assert.equal(State.promptContext, null);

  await ask("plan the move");
  field().value = "half written in B";
  reopen("summarise the lease");
  assert.equal(State.chatId, a);
  assert.equal(field().value, "and compare it with");
  assert.deepEqual(attached(), ["lease.pdf", "old-lease.pdf"]);
  assert.equal(State.promptContext?.name, "lease.pdf");

  reopen("plan the move");
  assert.equal(field().value, "half written in B");
  assert.deepEqual(attached(), []);

  // Sent from its own chat, the draft goes as any message does, with its files.
  reopen("summarise the lease");
  type("Enter");
  await flush();
  await flush();
  const last = sent("chat_send").at(-1);
  assert.equal(last.query, "and compare it with");
  assert.equal(last.context?.name, "lease.pdf");
  assert.equal(field().value, "");
});

test("the files waiting in another chat's draft are never tidied from under it", async () => {
  await ask("one");
  State.droppedFile = { name: "keep.pdf", path: String.raw`C:\inbox\keep.pdf` };
  newChat();
  await ask("two");
  // Deleting chat "two" releases its copies, but keeps those another draft holds.
  button("Past chats").fire("click");
  const row = view.el.find(".history-row").find((r) => r.getAttribute("title") === "two");
  row.find(".history-delete")[0].fire("click");
  const released = sent("inbox_release");
  for (const r of released) assert.ok(r.keep.includes(String.raw`C:\inbox\keep.pdf`));
  reopen("one");
  assert.deepEqual(attached(), ["keep.pdf"]);
});

test("the text of an edit given up is not kept as a draft", async () => {
  await ask("first question");
  // Edit puts the question back in the field.
  view.el.find(".msg-edit")[0].fire("click");
  view.sync();
  assert.equal(field().value, "first question");
  newChat();
  await ask("other");
  reopen("first question");
  assert.equal(field().value, "");
});

test("the shield is each chat's own: a new chat starts on the default, a chat comes back with its own", async () => {
  await ask("refactor the parser");
  const a = State.chatId;
  shield("Auto");
  assert.ok(lit());
  assert.equal(State.settings.chatPermissionMode, "default", "the default stays");
  assert.deepEqual(chatPermissionsOf(a), { chatPermissionMode: "auto", chatPermissionModeAgy: "" });

  newChat();
  assert.ok(!lit(), "a new chat asks, as Settings → Security says");
  await ask("look at the logs");
  shield("Plan only");

  reopen("refactor the parser");
  assert.ok(lit());
  await ask("now the tests");
  reopen("look at the logs");
  await ask("and the errors?");

  assert.deepEqual(sent("chat_send").map((s) => [s.query, s.permissionMode]), [
    ["refactor the parser", "default"],
    ["look at the logs", "default"],
    ["now the tests", "auto"],
    ["and the errors?", "plan"],
  ]);
  assert.deepEqual(loadChats().map((c) => [c.title, c.permissions?.chatPermissionMode]), [
    ["look at the logs", "plan"],
    ["refactor the parser", "auto"],
  ]);
});

test("a new chat starts on Settings → Security's default; a chat already asked keeps the one it had", async () => {
  State.settings = { ...State.settings, chatPermissionMode: "auto" };
  view.sync();
  assert.ok(lit());
  await ask("with auto");
  State.settings = { ...State.settings, chatPermissionMode: "default" };
  newChat();
  assert.ok(!lit());
  await ask("with ask");
  reopen("with auto");
  assert.ok(lit(), "the default it was asked with stays its own");
  await ask("again");
  assert.deepEqual(sent("chat_send").map((s) => s.permissionMode), ["auto", "default", "auto"]);
});

test("Antigravity CLI keeps its own mode in each chat too", async () => {
  State.settings = { ...State.settings, chatProvider: "antigravity-cli" };
  view.sync();
  shield("Auto");
  assert.deepEqual(chatPermissionsOf(State.chatId), { chatPermissionMode: "default", chatPermissionModeAgy: "auto" });
  await ask("build it");
  assert.deepEqual([sent("chat_send")[0].permissionMode, sent("chat_send")[0].permissionModeAgy], ["default", "auto"]);
  newChat();
  assert.ok(!lit());
});

test("permissions picked before a chat's first answer is saved stay with it", () => {
  setChatPermissions("unsaved", { chatPermissionMode: "plan", chatPermissionModeAgy: "" });
  saveChat({ id: "unsaved", title: "t", updatedAt: 1, provider: "claude-code", session: null, turns: [{ role: "user", content: "t" }] });
  assert.equal(loadChats()[0].permissions.chatPermissionMode, "plan");
  // Saved again without them (an answer came), they stay.
  saveChat({ id: "unsaved", title: "t", updatedAt: 2, provider: "claude-code", session: null, turns: [{ role: "user", content: "t" }] });
  assert.equal(chatPermissionsOf("unsaved").chatPermissionMode, "plan");
});

test("a chat saved before each chat kept its permissions goes by the default", () => {
  saveChat({ id: "old", title: "old one", updatedAt: 1, provider: "claude-code", session: null, turns: [{ role: "user", content: "old one" }, { role: "assistant", content: "ok" }] });
  State.settings = { ...State.settings, chatPermissionMode: "plan" };
  reopen("old one");
  assert.ok(lit());
  assert.equal($(".perm-btn").title.includes("Plan only"), true);
});
