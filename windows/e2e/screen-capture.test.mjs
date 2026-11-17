// A screen capture over the island (island.rs CAPTURE_TOOLS, platform
// foreground_changed): its overlay stays above the island, even when the
// island climbed above it a moment before, and the island neither opens
// under the capture's mouse nor hears its clicks; once the capture ends the
// island is back on top and opens as before. An image the tool pinned to the
// screen is no capture: the island keeps opening under the mouse while it is
// in front. With the island set to close on a click outside it, the clicks of
// a capture (picking the window to take) never close it (#265). An overlay
// that shows over everything without ever taking the front, as the Windows 11
// Snipping Tool's can, is a capture too: with Open on hover, the island under
// it neither opens nor climbs above it.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

/** How many times Lumo's log says a capture opened (platform foreground_changed). */
function capturesLogged() {
  const log = join(app.profile, "local", "com.rccrd12.lumo", "lumo.log");
  if (!existsSync(log)) return 0;
  return readFileSync(log, "utf8").split(/\r?\n/).filter((l) => l.includes("screen capture open")).length;
}

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

flow(G, "An image the tool pinned to the screen is no capture: the island opens under the mouse while it is in front", app, async () => {
  await frontTool();
  const logged = capturesLogged();
  const pin = await tool.pin();
  step(`pinned image ${pin.hwnd}: ${pin.seen}`);
  try {
    assert.ok(pin.front, "the pinned image came to the front");
    await sleep(800);
    // Which of two always-on-top windows ends up in front is a race between
    // the two programs (each may raise itself again), so it is only written
    // down; what the user sees is that the island does not go deaf.
    await lumoAround(pin.hwnd);
    assert.equal(capturesLogged(), logged, "Lumo did not take the pinned image for a capture");

    step("the island opens under the mouse while the pinned image is in front");
    await app.open();
    await app.closed();
  } finally {
    await tool.unpin();
  }
});

flow(G, "Closing on a click outside: a click in a capture leaves the island open, one with no capture closes it", app, async () => {
  step("Lumo again, set to close the open island on a click outside it (Settings → Island)");
  await app.quit();
  await app.launch({ settings: { islandClose: "click" } });
  await app.open();
  const s = await app.screen();
  // Where the user picks a window to capture: away from the island.
  const elsewhere = { x: s.w / 2, y: s.h * 0.62 };
  const overlay = await tool.capture();
  step(`overlay ${overlay.hwnd}: ${overlay.seen}`);
  try {
    assert.ok(overlay.front, "the overlay came to the front");
    await sleep(500);
    step("a click on the capture, away from the island, as when it is told which window to take");
    await app.mouse.glide(elsewhere.x, elsewhere.y);
    await sleep(300);
    await app.mouse.down();
    await sleep(60);
    await app.mouse.up();
    await sleep(800);
  } finally {
    step(`the capture ends: ${await tool.end()}`);
  }
  await sleep(1_500);
  const h = await app.islandHeight();
  step(`the island after the capture: ${Math.round(h)} px tall`);
  assert.ok(h > 100, "the click that belonged to the capture did not close the island");

  step("a click outside the island with no capture open closes it, as set");
  await app.mouse.glide(elsewhere.x, elsewhere.y);
  await sleep(300);
  await app.mouse.down();
  await sleep(60);
  await app.mouse.up();
  await d.until("return document.getElementById('island').getBoundingClientRect().height < 60", 5_000, "the island closing on a click outside it");
});

flow(G, "An overlay that never takes the front is a capture too: with Open on hover the island neither opens under it nor climbs above it", app, async () => {
  step("Lumo again, set to open on hover (Settings → Island)");
  await app.quit();
  await app.launch({ settings: { islandHoverOpen: true } });
  await frontTool();
  const overlay = await tool.quiet();
  step(`overlay ${overlay.hwnd}: ${overlay.seen}`);
  try {
    assert.ok(!overlay.front, "the overlay is over everything without being in front");
    await sleep(500);
    let z = await lumoAround(overlay.hwnd);
    assert.equal(z.above, 0, "no window of Lumo's above the overlay as it comes");

    step("the cursor rests on the island, under the overlay, as when a capture's selection starts there");
    const box = await app.islandBox();
    await app.mouse.glide(box.x + box.w / 2, box.y + box.h / 2);
    await sleep(2_000);
    const h = await app.islandHeight();
    step(`the island under the overlay: ${Math.round(h)} px tall`);
    z = await lumoAround(overlay.hwnd);
    assert.ok(h < 60, "the island did not open under the capture's mouse");
    assert.equal(z.above, 0, "no window of Lumo's climbed above the overlay");
  } finally {
    await app.away();
    step(`the capture ends: ${await tool.end()}`);
  }
  await sleep(1_000);

  step("with no capture, the cursor on the island opens it, as set");
  const box = await app.islandBox();
  await app.mouse.glide(box.x + box.w / 2, box.y + box.h / 2);
  await d.until("return document.getElementById('island').getBoundingClientRect().height > 100", 6_000, "the island opening on hover");
  await app.closed();
});
