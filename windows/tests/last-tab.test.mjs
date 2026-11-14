// The island reopens on the tab it was left on (State.defaultView).

import { test } from "node:test";
import assert from "node:assert/strict";
import { State } from "../src/core/state.ts";

test("the island opens on the home, then reopens on the tab it was left on", () => {
  assert.equal(State.defaultView(), "home", "nothing open yet: the home");
  State.noteTab("prompt");
  assert.equal(State.defaultView(), "prompt");
  // Views outside the tabs leave the choice as it was.
  for (const v of ["settings", "wardrobe", "note", "upload", "greeting"]) State.noteTab(v);
  assert.equal(State.defaultView(), "prompt");
  State.noteTab("overview");
  assert.equal(State.defaultView(), "home", "a session's card is on the home");
  State.noteTab("home");
  assert.equal(State.lastTab, "agents");
  State.noteTab("live");
  assert.equal(State.lastTab, "chat");
  State.noteTab("prompt");
});

test("a file dropped and not yet asked about opens the chat", () => {
  State.noteTab("home");
  State.droppedFile = { name: "a.txt", path: "C:\\a.txt" };
  try {
    assert.equal(State.defaultView(), "prompt");
    State.droppedFile = { ...State.droppedFile, sent: true };
    assert.equal(State.defaultView(), "home", "once it went, as before");
  } finally {
    State.droppedFile = null;
    State.noteTab("prompt");
  }
});

test("a card waiting for an answer still comes first", () => {
  State.noteTab("overview");
  State.pendingApproval = { questions: null };
  try {
    assert.equal(State.defaultView(), "approval");
  } finally {
    State.pendingApproval = null;
    State.noteTab("prompt");
  }
});

test("Settings the island closed on by itself come back on the next opening, once", () => {
  State.noteTab("home");
  State.settingsLeftOpen = true;
  assert.equal(State.openingView(), "settings");
  assert.equal(State.settingsLeftOpen, false, "asked once");
  assert.equal(State.openingView(), "home", "then where it usually opens");
});

test("a card waiting for an answer comes before Settings left open", () => {
  State.noteTab("home");
  State.settingsLeftOpen = true;
  State.pendingApproval = { questions: null };
  try {
    assert.equal(State.openingView(), "approval");
    assert.equal(State.settingsLeftOpen, false);
  } finally {
    State.pendingApproval = null;
  }
});

test("Escape in Settings closes them for good: the island opens where it usually does (settings-frame.ts)", async () => {
  const { buildSettingsFrame, FRAME_CLOSE } = await import("../src/views/settings-frame.ts");
  const listeners = [];
  const add = window.addEventListener;
  window.addEventListener = (type, fn) => { if (type === "message") listeners.push(fn); };
  const did = [];
  try {
    const { installFakeDom } = await import("./fakedom.mjs");
    installFakeDom();
    globalThis.location ??= { origin: "http://tauri.localhost" };
    const host = buildSettingsFrame({ openSettingsWindow() {}, collapse: () => did.push("collapse"), closeSettings: () => did.push("closeSettings") });
    State.mode = "expanded";
    State.view = "settings";
    host.sync();
    const frame = host.el.find("IFRAME")[0];
    frame.contentWindow = {};
    for (const fn of listeners) fn({ source: frame.contentWindow, data: FRAME_CLOSE });
    assert.deepEqual(did, ["closeSettings"]);
  } finally {
    window.addEventListener = add;
    State.mode = "hidden";
    State.view = "home";
  }
});

test("the shortcut that opens the island brings back Settings it folded on its own, as a click does", async () => {
  const { runGlobalShortcut } = await import("../src/island/shortcuts.ts");
  const opened = [];
  const host = { alert: (v) => opened.push(v), takeKeyboard() {}, emote() {}, collapse() {}, setView() {}, holdOpen() {} };
  State.noteTab("home");
  State.mode = "compact";
  State.settingsLeftOpen = true;
  try {
    runGlobalShortcut(host, "toggleIsland", () => {});
    assert.deepEqual(opened, ["settings"]);
    assert.equal(State.settingsLeftOpen, false, "once");
  } finally {
    State.settingsLeftOpen = false;
  }
});
