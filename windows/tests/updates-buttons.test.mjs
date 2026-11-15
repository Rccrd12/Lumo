// Settings → Updates on a beta (src/settings/updates.ts): Update the beta and
// Back to the release are buttons on their own, with no line beside or under
// them (#276). Drawn from a check of GitHub as Rust answers it (update_check).

import { registerHooks } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { internals } from "./tauri.mjs";

// The changelog Vite builds in (vite.config.ts): none needed here.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "virtual:lumo-changelog") return { url: "data:text/javascript,export default ''", shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

installFakeDom();
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

let answer = null;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  if (cmd === "update_check") return answer;
  return plainInvoke(cmd, args);
};

const { updatesSection } = await import("../src/settings/updates.ts");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A beta 0.22.2-442 newer than the one installed, on top of the release 0.22.1. */
const onBeta = () => ({
  current: "0.22.2-438",
  latest: "0.22.1",
  newer: false,
  notes: "",
  assetUrl: "https://github.com/Rccrd12/Lumo/releases/download/windows-v0.22.1/Lumo-Windows-0.22.1-setup.exe",
  currentBeta: true,
  beta: {
    version: "0.22.2-442",
    newer: true,
    publishedAt: "2026-11-15T18:41:40Z",
    assetUrl: "https://github.com/Rccrd12/Lumo/releases/download/windows-beta/Lumo-Windows-0.22.2-442-setup.exe",
    included: [{ number: 276, title: "Settings → Updates: the beta's buttons without the line beside them", updatedAt: "2026-11-15T16:51:18Z" }],
    excluded: [],
  },
});

const elements = (root) => [...root.walk()];
const buttons = (root) => elements(root).filter((e) => e.tagName === "BUTTON");
const byText = (root, re) => buttons(root).find((b) => re.test(b.textContent.trim()));

test("on a beta, Update the beta and Back to the release are buttons alone on their row", async () => {
  answer = onBeta();
  const section = updatesSection("0.22.2-438", document.createElement("div"), document.createElement("div"), () => true);
  const check = buttons(section)[0];
  assert.ok(check, "the Check for updates button");
  check.fire("click");
  await flush();
  await flush();

  const update = byText(section, /^Update the beta$/);
  assert.ok(update, `Update the beta is offered: ${buttons(section).map((b) => b.textContent).join(" | ")}`);
  const back = byText(section, /^Back to the release 0\.22\.1$/);
  assert.ok(back, "Back to the release 0.22.1 is offered");

  for (const b of [update, back]) {
    const row = b.parentElement;
    assert.ok(row.classList.contains("row"), "the button sits on a row of its own");
    assert.deepEqual(row.children, [b], `nothing beside "${b.textContent}"`);
    // Nor under it: the next thing in the section is not a hint about it.
    const after = row.parentElement.children[row.parentElement.children.indexOf(row) + 1];
    assert.ok(!after || !after.classList.contains("hint"), `no line under "${b.textContent}"`);
  }
  assert.ok(
    !elements(section).some((e) => /installs it by itself|Your settings stay/.test(e.textContent) && e.children.length === 0),
    "the two lines #276 took out are gone",
  );
});
