// Windows' folder picker, from Choose… in the Listening form: it belongs to
// the island, so it shows over it (the island is always on top, and a window
// of no one's would open under it), and a click in it is no click elsewhere:
// the Listening form stays, waiting for the folder.

import assert from "node:assert/strict";
import { after, before } from "node:test";

import { Lumo } from "./lib/app.mjs";
import { answerBox, filePicker } from "./lib/dialog.mjs";
import { sleep } from "./lib/driver.mjs";
import { flow, step } from "./lib/flow.mjs";

const G = "Pickers";
const app = new Lumo("pickers");
const d = app.d;

before(() => app.launch());
after(() => app.close());

/** The Listening panel is open in the chat. */
const hearing = () => d.js("return !!document.querySelector('.chat-body.hearing')");

/** The first displayed element for `css` whose text is `text`. */
async function byText(css, text) {
  for (const id of await d.all(css)) {
    if ((await d.displayed(id)) && (await d.text(id)).trim() === text) return id;
  }
  return null;
}

flow(G, "Choose… opens the folder picker over the island, and a click in it keeps the Listening form", app, async () => {
  await app.open();
  step("opens the chat from the home's field, then the Listening panel");
  await app.click(await d.visible(".home-field", 8_000, "the home's Ask me anything field"));
  await d.visible(".chat-input", 5_000, "the chat's field");
  await app.click(await d.visible(".listen-btn", 5_000, "the chat's Listening button"));
  await d.until("return !!document.querySelector('.chat-body.hearing')", 5_000, "the Listening panel");

  step("+ → Files and folders → Choose…");
  await app.click(await d.visible(".listen-card.add", 5_000, "the card that adds a watch"));
  const tile = await byText(".listen-source .listen-source-name", "Files and folders");
  assert.ok(tile, "a Files and folders tile");
  await app.click(tile);
  await d.visible(".listen-target-row input", 5_000, "the form's folder field");
  const choose = await byText(".listen-head-btn", "Choose…");
  assert.ok(choose, "Choose… next to the folder field");
  await app.click(choose);

  const picker = filePicker(app.proc.pid, 15);
  step(`the picker: ${JSON.stringify(picker)}`);
  assert.ok(picker.found, `Windows' folder picker came up: ${picker.raw ?? ""}`);
  assert.equal(picker.ownerPid, app.proc.pid, "it belongs to a window of Lumo's");
  assert.equal(picker.ownerTopmost, true, "that window is the island, always on top: the picker shows over it");

  step("a click in the picker, on its title bar");
  const r = picker.rect;
  await app.mouse.move(r.x + Math.min(120, r.w / 3), r.y + 12);
  await sleep(300);
  await app.mouse.down();
  await sleep(60);
  await app.mouse.up();
  await sleep(500);
  assert.equal(await hearing(), true, "the Listening form stays while the picker is up");

  step("Cancel in the picker");
  const cancel = answerBox(app.proc.pid, "Cancel", 10);
  step(`Cancel: ${JSON.stringify(cancel)}`);
  assert.ok(cancel.pressed, `the picker's Cancel: ${cancel.raw}`);
  await sleep(500);
  assert.equal(await hearing(), true, "the Listening form is still there after the picker");
  assert.ok(await d.find(".listen-target-row input"), "with its folder field");
});
