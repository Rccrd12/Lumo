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
