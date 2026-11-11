// Settings inside the island write only after Yes in Windows' own box
// (confirmed.rs by_hand). A click on that box is no click outside the island:
// while it is up the island counts it as one of its dialogs (core/bridge.ts),
// so "close on a click outside" leaves the island and Settings open.

import { test } from "node:test";
import assert from "node:assert/strict";
import { internals } from "./tauri.mjs";

const { isDialogOpen, lendTauri } = await import("../src/core/bridge.ts");

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
