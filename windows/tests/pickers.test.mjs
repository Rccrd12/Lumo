// Windows' file and folder pickers of the island (Choose… in the Listening
// form, the chat's paperclip, Attach on an email's card). A press in one is
// no press elsewhere: the island stays open, and the panel that opened the
// picker stays too, waiting for what is picked (core/bridge.ts dialogs).

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { emit, internals } from "./tauri.mjs";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

installFakeDom();
// The chat asks whether a press was on an element; Rust's press is on none.
globalThis.Element ??= class {};
const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { Bridge, isDialogOpen } = await import("../src/core/bridge.ts");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Each picker's answer, held until the test gives it. */
let picks;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  if (cmd === "pick_folder" || cmd === "pick_file" || cmd === "pick_attachments") {
    return new Promise((resolve) => picks.set(cmd, resolve));
  }
  return plainInvoke(cmd, args);
};

let view;
const $ = (cls) => view.el.querySelector(cls);

beforeEach(() => {
  mem.clear();
  picks = new Map();
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {} };
  State.startChat();
  State.mode = "expanded";
  State.view = "prompt";
  State.listening = [];
  State.listenPending = [];
  view = buildPrompt(() => {});
  $(".chat-input").value = "";
  view.sync();
});

/** The Listening panel, on the form for files and folders. */
function folderForm() {
  $(".listen-btn").fire("click");
  view.sync();
  assert.ok(view.el.querySelector(".chat-body").classList.contains("hearing"), "the Listening panel is open");
  view.el.find(".listen-card").find((c) => c.classList.contains("add")).fire("click");
  view.sync();
  const tile = view.el.find(".listen-source")[1];
  assert.match(tile.textContent, /Files and folders/);
  tile.fire("click");
  view.sync();
  const choose = view.el.find(".listen-head-btn").find((b) => b.textContent === "Choose…" && !b.hidden);
  assert.ok(choose, "Choose… is offered for a folder");
  return choose;
}

test("a press in the folder picker leaves the Listening form open, and the picked folder fills it", async () => {
  const choose = folderForm();
  choose.fire("click");
  await flush();
  assert.ok(picks.has("pick_folder"), "Windows' folder picker is up");
  assert.equal(isDialogOpen(), true);

  // The user clicks in the picker: Rust tells of a press away from the island.
  emit("outside-press", null);
  view.sync();
  assert.ok(view.el.querySelector(".chat-body").classList.contains("hearing"), "the panel stays");

  picks.get("pick_folder")("C:\\Users\\me\\Downloads");
  await flush();
  assert.equal(isDialogOpen(), false);
  assert.equal(view.el.find(".listen-target-row")[0].find("input")[0].value, "C:\\Users\\me\\Downloads");

  // With no picker up, a press elsewhere closes the panel as before.
  emit("outside-press", null);
  view.sync();
  assert.ok(!view.el.querySelector(".chat-body").classList.contains("hearing"));
});

test("the picker of an email's Attach counts as the island's own, as the others do", async () => {
  const attach = Bridge.pickAttachments();
  await flush();
  assert.equal(isDialogOpen(), true, "a press in it is no press elsewhere");
  picks.get("pick_attachments")([{ name: "a.pdf", size: 3, path: "C:\\a.pdf" }]);
  assert.deepEqual(await attach, [{ name: "a.pdf", size: 3, path: "C:\\a.pdf" }]);
  assert.equal(isDialogOpen(), false);
});
