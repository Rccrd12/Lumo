// Every webview made after the island (the Settings window, the computer
// overlay) must ask for the island's own browser arguments, or it comes up
// blank with no error (lib.rs BROWSER_ARGS). Since the Settings window is made
// when first opened, a release where the two drift apart shows a blank window,
// and the end-to-end tests, built with their own arguments, would not see it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const lib = read("../src-tauri/src/lib.rs").replace(/\r\n/g, "\n");
const island = (conf) => JSON.parse(read(conf)).app.windows.find((w) => w.label === "island").additionalBrowserArgs;
const args = (feature) => {
  const m = lib.match(new RegExp(`#\\[cfg\\(${feature}\\)\\]\\npub\\(crate\\) const BROWSER_ARGS: &str = "([^"]*)";`));
  assert.ok(m, `BROWSER_ARGS for ${feature} in lib.rs`);
  return m[1];
};

test("the release's later windows ask for the island's browser arguments", () => {
  assert.equal(args('not\\(feature = "e2e"\\)'), island("../src-tauri/tauri.conf.json"));
});

test("so do the end-to-end build's", () => {
  assert.equal(args('feature = "e2e"'), island("../src-tauri/tauri.e2e.conf.json"));
});
