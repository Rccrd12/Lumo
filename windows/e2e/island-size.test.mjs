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

const widthOf = () => app.settledWidth();

/** Drags the island's right edge by `dx` page pixels, then puts the cursor back on it. */
async function dragRight(dx) {
  const grip = await d.find(".edge.edge-right.on");
  assert.ok(grip, "the island's right edge can be dragged");
  const before = await widthOf();
  const hit = await app.aim(grip);
  step(`drags the right edge by ${dx} px from ${before} px (cursor ${hit})`);
  // Pressed anywhere else, the drag would move the island instead.
  assert.equal(hit, "on target", "the cursor is on the island's right edge before the drag");
  const r = (await app.screen()).r;
  await app.mouse.drag(null, { dx: dx * r, dy: 0 });
  await sleep(800);
  step(`now ${await widthOf()} px; the page's last press: ${JSON.stringify(await app.lastPress())}`);
  const box = await app.islandBox();
  await app.mouse.move(box.x + box.w / 2, box.y + 20);
  await sleep(300);
}

/** From the home, the chat. */
async function openChat() {
  step("opens the chat from the home's field");
  await app.click(await d.visible(".home-field"));
  await d.gone(".home-field", 5_000);
}

/** Opens the island and goes to the home (it reopens on the view it was left on). */
async function openHome() {
  await app.open();
  for (let i = 0; i < 3 && !(await d.find(".home-field")); i++) {
    const back = await d.find(".back-btn");
    if (!back) break;
    step("goes back towards the home");
    await app.click(back);
    await sleep(600);
  }
  await d.visible(".home-field", 8_000, "the home's Ask me anything field");
}

flow(G, "The chat's size is kept after Lumo restarts", app, async () => {
  await openHome();
  await openChat();
  await dragRight(150);
  const before = await widthOf();
  step(`chat at ${before} px; Lumo restarts`);
  await app.closed();
  await app.quit();
  await app.launch({ fresh: false });
  await app.open();
  if (await d.find(".home-field")) await openChat();
  const afterRestart = await widthOf();
  step(`chat at ${afterRestart} px after the restart`);
  assert.ok(Math.abs(afterRestart - before) <= 2, `the chat was ${before} px wide before the restart and ${afterRestart} px after`);
});

flow(G, "Resizing the chat leaves the home's size alone", app, async () => {
  await app.closed();
  await openHome();
  await dragRight(-400);
  const home = await widthOf();
  step(`home narrowed to ${home} px`);

  await openChat();
  const chatBefore = await widthOf();
  await dragRight(150);
  const chat = await widthOf();
  step(`chat from ${chatBefore} px to ${chat} px`);
  assert.ok(chat > chatBefore + 50, "dragging the chat's edge widens the chat");

  step("goes back to the home");
  await app.click(await d.visible(".back-btn", 5_000, "the Back button"));
  await d.visible(".home-field", 5_000, "the home");
  await sleep(800);
  const homeAfter = await widthOf();
  step(`home is ${homeAfter} px`);
  assert.ok(Math.abs(homeAfter - home) <= 2, `the home was ${home} px wide and is ${homeAfter} px after the chat was widened`);
});
