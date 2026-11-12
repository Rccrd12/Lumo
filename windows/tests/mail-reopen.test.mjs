// The island closed on its own on the Email view opens there again, on the
// email or the list it showed (views/mail-view.ts, State.defaultView);
// Escape, another view, or the Email pill turned off leave it as before.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const keys = [];
globalThis.window = { addEventListener: (type, fn) => { if (type === "keydown") keys.push(fn); }, focus: () => {} };

const { State, DEFAULT_SETTINGS } = await import("../src/core/state.ts");
const { buildMailView } = await import("../src/views/mail-view.ts");

const MAIL = "integration_mail";
const view = buildMailView({ blip: () => {}, setView: () => {} });
const escape = () => {
  const e = { key: "Escape", stopImmediatePropagation: () => {} };
  for (const fn of keys) fn(e);
};
function shown() {
  State.view = "mail";
  State.mode = "expanded";
  State.notify();
  view.sync();
}
function folded() {
  State.mode = "compact";
  State.notify();
}

test("closed on its own on the Email view, the island opens there again", () => {
  State.settings = { ...DEFAULT_SETTINGS, activeIntegrations: [MAIL] };
  State.pendingApproval = null;
  shown();
  folded();
  assert.equal(State.mailLeftOpen, true);
  assert.equal(State.defaultView(), "mail");
  // Opened there again, then another view: it no longer comes back to Email.
  shown();
  State.view = "prompt";
  State.notify();
  assert.equal(State.mailLeftOpen, false);
  assert.notEqual(State.defaultView(), "mail");
});

test("Escape from the list closes it for good: the next opening is the usual one", () => {
  State.settings = { ...DEFAULT_SETTINGS, activeIntegrations: [MAIL] };
  shown();
  escape();
  folded();
  assert.equal(State.mailLeftOpen, false);
  assert.notEqual(State.defaultView(), "mail");
});

test("a card waiting comes first, and with the Email pill off the island doesn't open on it", () => {
  State.settings = { ...DEFAULT_SETTINGS, activeIntegrations: [MAIL] };
  shown();
  folded();
  assert.equal(State.defaultView(), "mail");
  State.settings = { ...DEFAULT_SETTINGS, activeIntegrations: [] };
  assert.notEqual(State.defaultView(), "mail");
  State.settings = { ...DEFAULT_SETTINGS, activeIntegrations: [MAIL] };
  State.pendingApproval = { id: "r1", tool: "Bash", input: {}, sessionId: "s" };
  assert.notEqual(State.defaultView(), "mail");
  State.pendingApproval = null;
});
