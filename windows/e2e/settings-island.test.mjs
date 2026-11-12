// Settings inside the island: a change to another program's settings (here
// the plan usage relay in Claude Code's settings.json) is looked at and
// confirmed in the island itself. Since the page can't tell Rust it is
// Settings, the write goes only after Windows' own Yes / No box, which no
// page can click (confirmed.rs by_hand); the separate Settings window stays shut.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before } from "node:test";

import { Lumo } from "./lib/app.mjs";
import { answerBox, windowsOnScreen } from "./lib/dialog.mjs";
import { sleep } from "./lib/driver.mjs";
import { flow, step } from "./lib/flow.mjs";

const G = "Settings in the island";
const app = new Lumo("settings-island");
const d = app.d;

before(() => app.launch());
after(() => app.close());

/** The Settings page in the island's frame, as the page script sees it. */
const FRAME = "document.querySelector('.settings-frame iframe')?.contentDocument";

const settingsJson = () => join(app.profile, "home", ".claude", "settings.json");
const relayWritten = () => existsSync(settingsJson()) && /statusLine/.test(readFileSync(settingsJson(), "utf8"));

async function openSettingsInIsland() {
  step("opens the island, then ⋯ → Settings");
  await app.open();
  await app.click(await d.visible(".more-btn", 8_000, "the island's ⋯ button"));
  await d.visible(".ctx-menu .ctx-item", 5_000, "the ⋯ menu");
  let settings = null;
  for (const id of await d.all(".ctx-menu .ctx-item")) {
    if ((await d.displayed(id)) && /^settings$/i.test((await d.text(id)).trim())) settings = id;
  }
  assert.ok(settings, "a Settings item in the ⋯ menu");
  await app.click(settings);
  await d.until("return !!document.querySelector('.settings-frame iframe.ready')", 20_000, "Settings ready in the island");
  await d.js(`const doc = ${FRAME}; doc.querySelector('[data-page="agents"]')?.click();`);
  await sleep(500);
}

async function showRelayPreview() {
  step("Install relay…, in the island");
  const clicked = await d.js(`
    const doc = ${FRAME};
    const b = [...doc.querySelectorAll('button')].find((b) => /^install relay/i.test(b.textContent.trim()));
    if (!b) return false;
    b.click();
    return true;`);
  assert.ok(clicked, "an Install relay… button in the island's Settings");
  await d.until(`return !!${FRAME}.querySelector('.diff')`, 10_000, "the diff in the island");
}

/** Presses the preview's Back up and write, in the island. */
async function confirmInIsland() {
  await d.js(`
    const doc = ${FRAME};
    const b = [...doc.querySelectorAll('.diff ~ .row button.primary, .diff ~ * button.primary')].find((b) => b.offsetParent);
    b.click();`);
}

/** The preview as the island shows it, to tell a box still open from one never shown. */
function previewState() {
  return d.js(`const doc = ${FRAME}; return {
    diff: !!doc.querySelector('.diff'),
    waiting: [...doc.querySelectorAll('.diff ~ .row button.primary')].some((b) => b.disabled),
    ok: !!doc.querySelector('.notice.ok'),
    error: [...doc.querySelectorAll('.notice.err')].map((n) => n.textContent),
  };`);
}

flow(G, "The relay is installed from the island after Windows' Yes, and the window stays shut", app, async () => {
  await openSettingsInIsland();
  await showRelayPreview();
  assert.equal(relayWritten(), false);

  step("Back up and write, then Cancel in Windows' box");
  await confirmInIsland();
  const no = answerBox(app.proc.pid, "Cancel");
  step(`Windows' box: ${JSON.stringify(no)}; the island: ${JSON.stringify(await previewState())}`);
  assert.ok(no.pressed, `a Yes / No box with Cancel came up: ${no.raw}`);
  await sleep(800);
  assert.equal(relayWritten(), false, "nothing written after Cancel");
  const after = await d.js(`const doc = ${FRAME}; return {
    diff: !!doc.querySelector('.diff'),
    error: [...doc.querySelectorAll('.notice.err')].map((n) => n.textContent),
  };`);
  assert.deepEqual(after, { diff: true, error: [] }, "Cancel leaves the preview, with no error");

  step("Back up and write again, then Yes");
  await confirmInIsland();
  const yes = answerBox(app.proc.pid, "Back up and write");
  step(`Windows' box: ${JSON.stringify(yes)}; the island: ${JSON.stringify(await previewState())}`);
  assert.ok(yes.pressed, `the box's Back up and write: ${yes.raw}`);
  await d.until(`return !!${FRAME}.querySelector('.notice.ok')`, 10_000, "the island saying it is done");
  assert.ok(relayWritten(), "settings.json has the status line relay");

  // The separate Settings window never came up (Windows lists only the
  // windows on screen; the island is one, untitled "Lumo").
  const shown = windowsOnScreen(app.proc.pid);
  step(`Lumo's windows on screen: ${JSON.stringify(shown)}`);
  assert.ok(shown.length > 0, "Lumo's windows are listed");
  assert.ok(!shown.some((title) => /settings/i.test(title)), "the Settings window stays shut");
});

flow(G, "No write without its preview, even from the island", app, async () => {
  step("the island's page asks for a write it never previewed");
  const answer = await d.js(`
    return window.__TAURI_INTERNALS__.invoke("status_line_apply", { install: false, fingerprint: "made-up" })
      .then(() => "written", (e) => "refused: " + String(e));`);
  step(answer);
  assert.match(answer, /^refused/);
  // Refused before any box: none comes up.
  const box = answerBox(app.proc.pid, "Cancel", 2);
  assert.equal(box.found, false, `no box for a write with no preview: ${box.raw}`);
});

flow(G, "The separate Settings window, made only when first opened, shows its page", app, async () => {
  const before = await d.windows();
  assert.equal(before.settings, undefined, "no Settings window until it is asked for");

  step("Open in a window");
  await d.js(`window.__TAURI_INTERNALS__.invoke("open_settings_window"); return true;`);
  let handles = {};
  for (let i = 0; !handles.settings; i++) {
    if (i > 50) throw new Error(`the Settings window did not come up: ${Object.keys(handles).join(", ")}`);
    await sleep(200);
    handles = await d.windows();
  }
  // Not blank: the page has drawn its sections.
  await d.switchTo(handles.settings);
  await d.until("return document.querySelectorAll('[data-page]').length > 0", 20_000, "the Settings window's sections");
  const shown = windowsOnScreen(app.proc.pid);
  step(`Lumo's windows on screen: ${JSON.stringify(shown)}`);
  assert.ok(shown.some((title) => /settings/i.test(title)), "the Settings window is on screen");

  step("Open in a window again: the same window, not a second one");
  await d.switchTo(handles.island);
  await d.js(`window.__TAURI_INTERNALS__.invoke("open_settings_window"); return true;`);
  await sleep(800);
  const again = await d.call("GET", d.s("/window/handles"));
  assert.equal(again.length, Object.keys(handles).length, "no second Settings window");
  await d.switchTo(handles.island);
});
