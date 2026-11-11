// The island's size: dragged with its grips (the real mouse: Rust follows the
// cursor while the button is held), per view, and kept across a restart.

import assert from "node:assert/strict";
import { after, before } from "node:test";

import { Lumo } from "./lib/app.mjs";
import { sleep } from "./lib/driver.mjs";
import { flow, step } from "./lib/flow.mjs";

const G = "Island size";
const app = new Lumo("island-size");
const d = app.d;

before(() => app.launch());
after(() => app.close());

const widthOf = async () => (await app.islandBox()).cssW;

/** Drags the island's right edge by `dx` page pixels, then puts the cursor back on it. */
async function dragRight(dx) {
  const grip = await app.onScreen(".edge.edge-right.on");
  assert.ok(grip, "the island's right edge can be dragged");
  const r = (await app.screen()).r;
  step(`drags the right edge by ${dx} px`);
  await app.mouse.drag(grip, { x: grip.x + dx * r, y: grip.y });
  await sleep(800);
  const box = await app.islandBox();
  await app.mouse.move(box.x + box.w / 2, box.y + 20);
  await sleep(300);
}

/** Opens the home under the cursor. */
async function openHome() {
  await app.open();
  await d.visible(".home-field", 8_000, "the home's Ask me anything field");
}

flow(G, "Resizing the chat leaves the home's size alone", app, async () => {
  await openHome();
  await dragRight(-400);
  const home = await widthOf();
  step(`home narrowed to ${home} px`);

  step("opens the chat from the home's field");
  await d.click(await d.visible(".home-field"));
  await d.gone(".home-field", 5_000);
  await sleep(600);
  const chatBefore = await widthOf();
  await dragRight(150);
  const chat = await widthOf();
  step(`chat from ${chatBefore} px to ${chat} px`);
  assert.ok(chat > chatBefore + 50, "dragging the chat's edge widens the chat");

  step("goes back to the home");
  await d.click(await d.visible(".back-btn", 5_000, "the Back button"));
  await d.visible(".home-field", 5_000, "the home");
  await sleep(800);
  const homeAfter = await widthOf();
  step(`home is ${homeAfter} px`);
  assert.ok(Math.abs(homeAfter - home) <= 2, `the home was ${home} px wide and is ${homeAfter} px after the chat was widened`);
}, { todo: "the island has one shared size, so the chat's width carries over to the home (reported 11/11/2026)" });

flow(G, "The size picked is kept after Lumo restarts", app, async () => {
  await app.closed();
  await openHome();
  await dragRight(-200);
  const before = await widthOf();
  step(`home at ${before} px; Lumo restarts`);
  await app.closed();
  await app.quit();
  await app.launch({ fresh: false });
  await openHome();
  const afterRestart = await widthOf();
  step(`home at ${afterRestart} px after the restart`);
  assert.ok(Math.abs(afterRestart - before) <= 2, `the home was ${before} px wide before the restart and ${afterRestart} px after`);
});
