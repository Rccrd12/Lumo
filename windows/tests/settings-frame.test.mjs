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
const { buildSettingsFrame, FRAME_SHOWN } = await import("../src/views/settings-frame.ts");
const { State } = await import("../src/core/state.ts");

test("Settings coming back after another tab tell the page to show what changed", () => {
  const host = buildSettingsFrame({ openSettingsWindow() {}, collapse() {} });
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
