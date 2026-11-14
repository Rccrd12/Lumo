// Settings inside the island (src/views/settings-frame.ts): the page in the
// frame is told each time Settings come back on screen, through a tab and the
// gear as much as through the gear alone, so it shows what changed meanwhile.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
// The page's messages come to the window; none in this test.
window.addEventListener ??= () => {};
globalThis.location ??= { origin: "http://tauri.localhost" };
const { buildSettingsFrame, FRAME_SHOWN, fieldHold, settingsHold } = await import("../src/views/settings-frame.ts");
const { State } = await import("../src/core/state.ts");

test("Settings coming back after another tab tell the page to show what changed", () => {
  const host = buildSettingsFrame({ openSettingsWindow() {}, collapse() {}, closeSettings() {} });
  State.mode = "expanded";
  State.view = "settings";
  host.sync();
  const frame = host.el.find("IFRAME")[0];
  assert.ok(frame, "the page loads the first time");
  const told = [];
  frame.contentWindow = { postMessage: (m) => told.push(m) };
  // Another tab: the island syncs the view that just went off (island.ts).
  State.view = "prompt";
  host.sync();
  State.view = "settings";
  host.sync();
  assert.deepEqual(told, [FRAME_SHOWN]);
  // Still on screen: nothing more.
  host.sync();
  assert.deepEqual(told, [FRAME_SHOWN]);
});

test("a field of Settings being written in holds the island open, as the chat's does", () => {
  const field = (tagName, type, value = "") => ({ tagName, type, value });
  // A key half pasted, a name typed: the mouse slipping off doesn't fold it.
  assert.equal(fieldHold(field("INPUT", "password", "sk-ant-")), "keep");
  assert.equal(fieldHold(field("INPUT", "text", "Riccardo")), "keep");
  assert.equal(fieldHold(field("TEXTAREA", "textarea", "a note")), "keep");
  // The cursor in an empty field, a list opened: a while.
  assert.equal(fieldHold(field("INPUT", "url")), "linger");
  assert.equal(fieldHold(field("INPUT", "", "  ")), "linger");
  assert.equal(fieldHold(field("SELECT", "select-one", "timer")), "linger");
  // Only clicked in, as saved (a model's name, a server's address): a while, not for good.
  assert.equal(fieldHold(field("INPUT", "text", "llama3.2"), "llama3.2"), "linger");
  assert.equal(fieldHold(field("INPUT", "text", "llama3.2:8b"), "llama3.2"), "keep");
  // The search only finds: a while, whatever is typed in it.
  assert.equal(fieldHold(field("INPUT", "search", "email")), "linger");
  // A switch or a button pressed, nothing focused: nothing to wait for.
  assert.equal(fieldHold(field("INPUT", "checkbox", "on")), "none");
  assert.equal(fieldHold(field("BUTTON", "button")), "none");
  assert.equal(fieldHold(null), "none");

  // In the island: only the field of the frame the cursor is in, while the island has the keyboard.
  const host = buildSettingsFrame({ openSettingsWindow() {}, collapse() {}, closeSettings() {} });
  State.mode = "expanded";
  State.view = "settings";
  host.sync();
  const frame = host.el.find("IFRAME")[0];
  frame.contentDocument = { activeElement: field("INPUT", "password", "sk-ant-") };
  document.hasFocus = () => true;
  document.activeElement = frame;
  assert.equal(settingsHold(), "keep");
  // Another app has the keyboard, or the cursor is no longer in the frame.
  document.hasFocus = () => false;
  assert.equal(settingsHold(), "none");
  document.hasFocus = () => true;
  document.activeElement = document.body;
  assert.equal(settingsHold(), "none");

  // The page tells the island what a field held as the cursor came into it:
  // clicked in, as saved, a while; written in since, for good.
  const listeners = new Map();
  const saved = field("INPUT", "text", "http://localhost:11434");
  frame.contentDocument = { activeElement: saved, addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]) };
  frame.contentWindow = { addEventListener() {} };
  frame.fire("load");
  for (const fn of listeners.get("focusin") ?? []) fn({ target: saved });
  document.activeElement = frame;
  assert.equal(settingsHold(), "linger");
  saved.value = "http://localhost:11435";
  assert.equal(settingsHold(), "keep");
});
