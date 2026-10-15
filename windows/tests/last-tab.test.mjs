// The island reopens on the tab it was left on (State.defaultView).

import { test } from "node:test";
import assert from "node:assert/strict";
import { State } from "../src/core/state.ts";

test("the island reopens on the tab it was left on", () => {
  assert.equal(State.defaultView(), "prompt");
  State.noteTab("overview");
  assert.equal(State.defaultView(), State.agentsView());
  // Views outside the tabs leave the choice as it was.
  for (const v of ["settings", "wardrobe", "note", "upload", "greeting"]) State.noteTab(v);
  assert.equal(State.defaultView(), State.agentsView());
  State.noteTab("prompt");
  assert.equal(State.defaultView(), "prompt");
  State.noteTab("empty");
  assert.equal(State.lastTab, "agents");
  State.noteTab("live");
  assert.equal(State.lastTab, "chat");
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
