// Settings inside the island write only after Yes in Windows' own box
// (confirmed.rs by_hand). A click on that box is no click outside the island:
// while it is up the island counts it as one of its dialogs (core/bridge.ts),
// so "close on a click outside" leaves the island and Settings open.

import { test } from "node:test";
import assert from "node:assert/strict";
import { internals } from "./tauri.mjs";

const { isDialogOpen, lendTauri, onDialogsChanged } = await import("../src/core/bridge.ts");
const { readFileSync } = await import("node:fs");

test("Windows' box asked from Settings in the island counts as a dialog of the island", async () => {
  lendTauri();
  const host = window.__LUMO_HOST__;
  const usual = internals.invoke;
  let answer;
  internals.invoke = (cmd, args) => (cmd === "hooks_apply" ? new Promise((r) => { answer = r; }) : usual(cmd, args));
  try {
    const write = host.invoke("hooks_apply", { install: true, fingerprint: "f" });
    await Promise.resolve();
    assert.equal(isDialogOpen(), true, "the box is up");
    answer("done");
    assert.equal(await write, "done");
    assert.equal(isDialogOpen(), false, "the box is gone");
    // A Cancel (an error back from Rust) closes it too.
    internals.invoke = () => Promise.reject(new Error("cancelled"));
    await assert.rejects(host.invoke("status_line_apply", { install: true, fingerprint: "f" }));
    assert.equal(isDialogOpen(), false);
    // Anything else Settings asks is no dialog.
    internals.invoke = () => new Promise(() => {});
    void host.invoke("hooks_preview", {});
    await Promise.resolve();
    assert.equal(isDialogOpen(), false);
  } finally {
    internals.invoke = usual;
  }
});

test("the island is told when Windows' box opens and closes, so its leave countdown waits for it", async () => {
  lendTauri();
  const host = window.__LUMO_HOST__;
  const usual = internals.invoke;
  const seen = [];
  onDialogsChanged(() => seen.push(isDialogOpen()));
  let answer;
  internals.invoke = (cmd, args) => (cmd === "agent_hooks_apply" ? new Promise((r) => { answer = r; }) : usual(cmd, args));
  try {
    const write = host.invoke("agent_hooks_apply", {});
    await Promise.resolve();
    assert.deepEqual(seen, [true]);
    answer("done");
    await write;
    assert.deepEqual(seen, [true, false]);
  } finally {
    internals.invoke = usual;
    onDialogsChanged(() => {});
  }
});

test("Settings in the island close on leave as every other view does (island.ts applyBehaviour)", () => {
  // They used to stay open whatever Settings → Island said.
  const island = readFileSync(new URL("../src/island/island.ts", import.meta.url), "utf8");
  const start = island.indexOf("private applyBehaviour()");
  const body = island.slice(start, island.indexOf("\n  }\n", start));
  assert.match(body, /closeOnLeave = mode === "timer" \|\| mode === "leave"/);
  assert.doesNotMatch(body, /State\.view/, "the close mode does not depend on the view");
});
