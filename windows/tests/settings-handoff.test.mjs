// Settings inside the island (src/settings/handoff.ts): a change to another
// program's settings is never written from there (confirmed.rs takes it only
// from the Settings window), so a click opens the window with the same change
// on screen, once, while it is fresh.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { sent } from "./tauri.mjs";

installFakeDom();
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const H = await import("../src/settings/handoff.ts");

const NOW = 1_800_000_000_000;

test("a hand-off names a known change, and only a recent one counts", () => {
  for (const what of ["hooks", "statusline", "plan", "agent:codex", "agent:antigravity", "agent:copilot-cli"]) {
    assert.deepEqual(H.parseHandoff(H.handoffText(what, true, NOW), NOW + 1000), { what, install: true, at: NOW }, what);
  }
  assert.equal(H.parseHandoff(H.handoffText("hooks", false, NOW), NOW).install, false);
  // Unknown, malformed, stale or from the future: nothing.
  for (const raw of [
    null, "", "{", "[]", "42",
    H.handoffText("settings.json", true, NOW),
    H.handoffText("agent:", true, NOW),
    H.handoffText("agent:../x", true, NOW),
    JSON.stringify({ what: "hooks", install: "yes", at: NOW }),
    JSON.stringify({ what: "hooks", install: true }),
  ]) {
    assert.equal(H.parseHandoff(raw, NOW), null, String(raw));
  }
  assert.equal(H.parseHandoff(H.handoffText("hooks", true, NOW), NOW + H.HANDOFF_FRESH_MS + 1), null);
  assert.equal(H.parseHandoff(H.handoffText("hooks", true, NOW + 60_000), NOW), null);
});

test("the island's click leaves the change and opens the window, which takes it once", () => {
  mem.clear();
  let opened = 0;
  assert.equal(H.handOff("agent:codex", false, () => { opened += 1; }, NOW), true);
  assert.equal(opened, 1);
  assert.ok(mem.has(H.HANDOFF_KEY));

  const reviewed = [];
  const block = { scrolled: 0, scrollIntoView() { this.scrolled += 1; } };
  H.onHandoff("agent:codex", (install) => {
    reviewed.push(install);
    return block;
  });
  const shown = [];
  const taken = H.takeHandoff((h) => shown.push(h.what), NOW + 2000);
  assert.deepEqual(taken, { what: "agent:codex", install: false, at: NOW });
  assert.deepEqual(shown, ["agent:codex"]);
  assert.deepEqual(reviewed, [false]);
  assert.equal(block.scrolled, 1);
  // Taken once: the next time the window comes to the front shows nothing.
  assert.ok(!mem.has(H.HANDOFF_KEY));
  assert.equal(H.takeHandoff(() => shown.push("again"), NOW + 3000), null);
  assert.deepEqual(reviewed, [false]);
});

test("a stale hand-off, or one no section shows, is dropped without a preview", () => {
  mem.clear();
  const reviewed = [];
  H.onHandoff("hooks", (install) => { reviewed.push(install); });
  H.handOff("hooks", true, () => {}, NOW);
  assert.equal(H.takeHandoff(() => {}, NOW + H.HANDOFF_FRESH_MS + 1), null);
  assert.ok(!mem.has(H.HANDOFF_KEY));
  H.handOff("agent:nobody", true, () => {}, NOW);
  assert.equal(H.takeHandoff(() => {}, NOW), null);
  assert.deepEqual(reviewed, []);
});

test("inside the island, Install… says where to confirm and opens the Settings window", () => {
  mem.clear();
  const before = sent("open_settings_window").length;
  const body = document.createElement("div");
  let back = 0;
  H.reviewInWindow(body, "hooks", true, () => { back += 1; });
  assert.equal(sent("open_settings_window").length, before + 1);
  assert.equal(H.parseHandoff(mem.get(H.HANDOFF_KEY), Date.now()).what, "hooks");
  assert.match(body.textContent, /Settings window/);
  const buttons = body.find("button");
  assert.equal(buttons.length, 2);
  // Open in a window again (the window was closed meanwhile), and Back.
  buttons[0].fire("click");
  assert.equal(sent("open_settings_window").length, before + 2);
  buttons[1].fire("click");
  assert.equal(back, 1);
});
