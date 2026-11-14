// A screen capture over the island (island.rs CAPTURE_TOOLS, platform
// foreground_changed): its overlay stays above the island, even when the
// island climbed above it a moment before, and the island neither opens
// under the capture's mouse nor hears its clicks; once the capture ends the
// island is back on top and opens as before. An image the tool pinned to the
// screen is no capture: the island stays above it.

import assert from "node:assert/strict";
import { after, before } from "node:test";

import { Lumo } from "./lib/app.mjs";
import { FakeCapture } from "./lib/capture.mjs";
import { sleep } from "./lib/driver.mjs";
import { flow, step } from "./lib/flow.mjs";

const G = "Screen capture";
const app = new Lumo("screen-capture");
const d = app.d;
const tool = new FakeCapture();

before(async () => {
  await app.launch();
  await tool.start();
});
after(async () => {
  tool.stop();
  await app.close();
});

/** A click on the tool's ordinary window, so it is in front and may bring its others there. */
async function frontTool() {
  const m = tool.main;
  await app.mouse.move(m.x + m.w / 2, m.y + m.h / 2);
  await sleep(200);
  await app.mouse.down();
  await sleep(50);
  await app.mouse.up();
  await sleep(500);
}

/** Where Lumo's windows are among the always-on-top ones, against `hwnd`'s: { above, under }. */
async function lumoAround(hwnd) {
  const order = await tool.order();
  const at = order.findIndex((w) => w.hwnd === hwnd);
  assert.ok(at >= 0, `the tool's window is on top: ${JSON.stringify(order)}`);
  const lumo = order.map((w, i) => (w.pid === app.proc.pid ? i : -1)).filter((i) => i >= 0);
  step(`always on top, front to back: ${order.map((w) => (w.hwnd === hwnd ? "TOOL" : w.pid === app.proc.pid ? "LUMO" : "other")).join(" ")}`);
  return { above: lumo.filter((i) => i < at).length, under: lumo.filter((i) => i > at).length };
}

flow(G, "A capture's overlay stays above the island, which neither opens under its mouse nor hears its clicks", app, async () => {
  step("the tool in front, then its capture: its own window first, the overlay after");
  await frontTool();
  const overlay = await tool.capture();
  step(`overlay ${overlay.hwnd}: ${overlay.seen}`);
  try {
    assert.ok(overlay.front, "the overlay came to the front");
    await sleep(500);
    await underTheCapture(overlay);
  } finally {
    step("the capture ends: the tool's window comes to the front");
    step(`after it: ${await tool.end()}`);
  }
  await sleep(800);
  await app.away();
  await sleep(500);
  step("the island opens as before");
  await app.open();
  await app.closed();
});

/** With the capture open: the island under it, deaf to its mouse. */
async function underTheCapture(overlay) {
  const z = await lumoAround(overlay.hwnd);
  assert.equal(z.above, 0, "no window of Lumo's above the capture's overlay");
  assert.ok(z.under > 0, "the island is still on screen, under the overlay");

  step("the cursor over the island, then a press there: the capture's");
  const box = await app.islandBox();
  await d.js("window.__e2eMove = null");
  await app.mouse.glide(box.x + box.w / 2, box.y + box.h / 2);
  await sleep(800);
  await app.mouse.down();
  await sleep(60);
  await app.mouse.up();
  await sleep(1_000);
  assert.equal(await d.js("return window.__e2eMove"), null, "the island's page heard no move of the mouse");
  assert.ok((await app.islandHeight()) < 60, "the island stayed closed");
}

flow(G, "An image the tool pinned to the screen is no capture: the island stays above it and opens", app, async () => {
  await frontTool();
  const pin = await tool.pin();
  step(`pinned image ${pin.hwnd}: ${pin.seen}`);
  try {
    assert.ok(pin.front, "the pinned image came to the front");
    await sleep(800);

    const z = await lumoAround(pin.hwnd);
    assert.ok(z.above > 0, "the island is above the pinned image");

    step("the island opens under the mouse while the pinned image is in front");
    await app.open();
    await app.closed();
  } finally {
    await tool.unpin();
  }
});
