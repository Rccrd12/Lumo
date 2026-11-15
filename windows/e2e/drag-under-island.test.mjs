// What a hand does with the mouse right under the island (island.rs
// spawn_cursor_poll `came_near`, platform may_carry_file and window_moving,
// src/island/window-move.ts), with the real mouse and a program of the test's
// own under the island (lib/drag-source.mjs):
//
// - a file picked up there, by a real OLE drag as File Explorer's, opens the
//   drop zone at its own 640 × 176 (even with sizes kept from before for the
//   other views, and a stale one kept under the drop zone's name), and the
//   file arrives when let go on it (#234, #270, #235, #260);
// - a maximised window dragged by its title bar from under the island comes
//   out of full screen and stays where it is let go; the island stays closed
//   (#270);
// - text selected by dragging under the island is selected; the island stays
//   closed (#270);
// - a window carried across the closed island with Open on hover on does not
//   open it, nor does letting go of it there; the next hover opens it (#277).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before } from "node:test";

import { Lumo } from "./lib/app.mjs";
import { DragSource } from "./lib/drag-source.mjs";
import { sleep } from "./lib/driver.mjs";
import { flow, step } from "./lib/flow.mjs";

const G = "Under the island";
const app = new Lumo("drag-under-island");
const d = app.d;
const source = new DragSource();

// Sizes dragged before for the home and the chat, and a stale one under the
// drop zone's name (kept by a build before #260): the drop zone keeps its own.
const SETTINGS = {
  islandHoverOpen: true,
  islandSizes: {
    home: { width: 900, height: 520 },
    chat: { width: 900, height: 520 },
    upload: { width: 900, height: 520 },
    uploading: { width: 900, height: 520 },
  },
};

before(async () => {
  await app.launch({ settings: SETTINGS });
  await source.start();
});
afterEach(async () => {
  await app.mouse.up();
  await source.hide().catch(() => {});
  await app.closed();
});
after(async () => {
  source.stop();
  await app.close();
});

/** The island's window on the screen, physical pixels: the panel the island is drawn in. */
const panel = () => d.js("const r = devicePixelRatio; return { x: screenX * r, y: screenY * r, w: innerWidth * r, h: innerHeight * r, r };");

// The drop zone, as a file carried over the island shows it: the upload
// sequence's canvas (src/upload/canvas.ts), the views fading under it. The
// drop zone's view (.drop-card) stays in the page, transparent, all along.
const DROP_ZONE = "return !!document.querySelector('#upload-layer.on')";

/** True once the island is open, or shows the drop zone. */
const opened = () => d.js(`return document.getElementById('island').getBoundingClientRect().height >= 60 || !!document.querySelector('#upload-layer.on')`);

/** How many times Lumo's log says a file drag reached the page with `type` (island.ts onDragDrop). */
function dragsLogged(type) {
  const log = join(app.profile, "local", "com.rccrd12.lumo", "lumo.log");
  if (!existsSync(log)) return 0;
  return readFileSync(log, "utf8").split(/\r?\n/).filter((l) => l.includes(`drag ${type} `)).length;
}

/**
 * Moves the held cursor to (x, y) in `steps`, looking after each few whether
 * the island opened: the number of looks that found it open.
 */
async function carry(x, y, steps = 16) {
  const from = app.mouse.at;
  let open = 0;
  for (let i = 1; i <= steps; i++) {
    await app.mouse.move(from.x + ((x - from.x) * i) / steps, from.y + ((y - from.y) * i) / steps);
    await sleep(40);
    if (i % 4 === 0 && (await opened())) open += 1;
  }
  return open;
}

/** Looks at the island for `ms`: how many looks found it open. */
async function watch(ms) {
  let open = 0;
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await opened()) open += 1;
    await sleep(150);
  }
  return open;
}

/** The island's size once it stops springing, page pixels. */
async function settledSize() {
  let last = await app.islandBox();
  for (let i = 0; i < 30; i++) {
    await sleep(150);
    const now = await app.islandBox();
    if (Math.abs(now.cssW - last.cssW) < 0.5 && Math.abs(now.cssH - last.cssH) < 0.5) return [Math.round(now.cssW), Math.round(now.cssH)];
    last = now;
  }
  return [Math.round(last.cssW), Math.round(last.cssH)];
}

flow(G, "A file picked up under the island opens the drop zone at its own 640 × 176, and arrives", app, async () => {
  const at = await source.show();
  await sleep(800);
  const isl = await app.islandBox();
  const pan = await panel();
  step(`island ${JSON.stringify(isl)}, its window ${JSON.stringify(pan)}, the window under it ${JSON.stringify(at)}`);
  // On the file's half of the window, beside the island and under its window.
  const x0 = Math.min(Math.max(at.fileX + 30, isl.x + isl.w + 80), pan.x + pan.w - 30);
  const y0 = Math.min(isl.y + isl.h + 90 * pan.r, pan.y + pan.h - 30);
  const enters = dragsLogged("enter");
  step(`picks the file up at ${Math.round(x0)}, ${Math.round(y0)}`);
  await app.mouse.move(x0, y0);
  await sleep(400);
  await app.mouse.down();
  await sleep(200);
  step("carries it onto the closed island");
  await carry(isl.x + isl.w / 2, isl.y + isl.h / 2, 24);
  await d.until(DROP_ZONE, 8_000, "the drop zone");
  const size = await settledSize();
  step(`the drop zone: ${size.join(" × ")}`);
  assert.ok(Math.abs(size[0] - 640) <= 2 && Math.abs(size[1] - 176) <= 2, `the drop zone keeps its own 640 × 176, not a size kept for another view: ${size.join(" × ")}`);
  assert.ok(dragsLogged("enter") > enters, "the page heard the drag come in");

  step("lets it go on the drop zone");
  const zone = await app.islandBox();
  await app.mouse.glide(zone.x + zone.w / 2, zone.y + zone.h / 2, 6);
  await sleep(500);
  await app.mouse.up();
  const end = Date.now() + 8_000;
  let dropped = await source.dropped();
  while (dropped !== "Copy" && Date.now() < end) {
    await sleep(250);
    dropped = await source.dropped();
  }
  step(`the drag came back with: ${dropped}`);
  assert.equal(dropped, "Copy", "the island took the file");
  for (let i = 0; i < 30 && dragsLogged("drop") === 0; i++) await sleep(200);
  assert.ok(dragsLogged("drop") > 0, "the page received the file");
});

flow(G, "A maximised window dragged by its title bar from under the island comes out of full screen; the island stays closed", app, async () => {
  const at = await source.show();
  await sleep(800);
  const before = await source.state();
  const isl = await app.islandBox();
  const pan = await panel();
  // The title bar beside the island, under its window, clear of the window's own title and buttons.
  const x0 = Math.max(isl.x - 90 * pan.r, 260);
  step(`the window ${JSON.stringify(before)}, its title bar at y ${at.titleY}; presses it at x ${Math.round(x0)}`);
  assert.equal(before.state, "Maximized");
  await app.mouse.move(x0, at.titleY);
  await sleep(400);
  await app.mouse.down();
  await sleep(150);
  const during = await carry(x0 + 40 * pan.r, at.titleY + 220 * pan.r, 20);
  await sleep(300);
  await app.mouse.up();
  await sleep(800);
  const let_go = await source.state();
  step(`after letting go: ${JSON.stringify(let_go)}`);
  assert.equal(during, 0, "the island did not open while the window was dragged");
  assert.equal(await watch(1_500), 0, "nor after");
  assert.equal(let_go.state, "Normal", "the window came out of full screen");

  step("the cursor goes on: the window stays where it was let go");
  await app.mouse.glide(app.mouse.at.x + 150 * pan.r, app.mouse.at.y + 80 * pan.r);
  await sleep(600);
  const later = await source.state();
  step(`then: ${JSON.stringify(later)}`);
  assert.deepEqual([later.x, later.y], [let_go.x, let_go.y], "the window no longer follows the mouse: it got the release");
});

flow(G, "Text selected by dragging under the island is selected; the island stays closed", app, async () => {
  const at = await source.show();
  await sleep(800);
  const isl = await app.islandBox();
  const pan = await panel();
  // In the text, beside the island and under its window, then towards the island.
  const x0 = Math.max(isl.x - 260 * pan.r, 40);
  const y0 = Math.max(at.textY + 20 * pan.r, isl.y + isl.h + 70 * pan.r);
  step(`selects from ${Math.round(x0)}, ${Math.round(y0)} towards the island`);
  await app.mouse.move(x0, y0);
  await sleep(400);
  await app.mouse.down();
  await sleep(150);
  const during = await carry(isl.x - 20 * pan.r, isl.y + isl.h + 30 * pan.r, 20);
  await sleep(400);
  await app.mouse.up();
  await sleep(500);
  const selected = await source.selected();
  step(`${selected} characters selected`);
  assert.equal(during, 0, "the island did not open while text was selected");
  assert.equal(await watch(1_500), 0, "nor after");
  assert.equal(await d.js(DROP_ZONE), false, "no drop zone");
  assert.ok(selected > 0, "the text box got its drag and its release: text is selected");
});

flow(G, "A window carried across the island with Open on hover on does not open it, nor let go on it; the next hover does", app, async () => {
  const m = await source.mover();
  await sleep(800);
  const isl = await app.islandBox();
  const pan = await panel();
  const grab = { x: m.x + 110 * pan.r, y: m.titleY };
  // Under the island's middle, not on the screen's top edge (where Windows would maximise the window).
  const over = { x: isl.x + isl.w / 2, y: Math.max(isl.y + isl.h / 2, 14) };
  step(`the window ${JSON.stringify(m)}; takes it by its title bar at ${Math.round(grab.x)}, ${Math.round(grab.y)}`);
  await app.mouse.move(grab.x, grab.y);
  await sleep(400);
  await app.mouse.down();
  await sleep(150);
  let open = await carry(over.x, over.y, 24);
  step("rests on the island with the window, longer than Open on hover waits");
  open += await watch(1_200);
  step("carries it on past the island and lets go");
  open += await carry(isl.x + isl.w + 260 * pan.r, over.y + 160 * pan.r, 16);
  await app.mouse.up();
  await sleep(600);
  open += await watch(1_000);
  const moved = await source.moverAt();
  step(`the window now ${JSON.stringify(moved)}`);
  assert.equal(open, 0, "the island did not open for a window carried over it");
  assert.ok(Math.abs(moved.x - m.x) > 100, "the window moved with the mouse");

  step("takes it again and lets go with the cursor on the island");
  // As a hand comes back to it: from a little below, not from where the first
  // carry let go (the same pixel, which the cursor poll would never see move).
  const again = { x: moved.x + 150 * pan.r, y: moved.y + (m.titleY - m.y) };
  await app.mouse.move(again.x, again.y + 90 * pan.r);
  await sleep(300);
  await app.mouse.glide(again.x, again.y);
  await sleep(400);
  await app.mouse.down();
  await sleep(150);
  const carried = await carry(over.x, over.y, 20);
  await sleep(300);
  await app.mouse.up();
  const after = await watch(1_500);
  const there = await source.moverAt();
  step(`the window now ${JSON.stringify(there)}; looks that found the island open: ${carried} while carried, ${after} after letting go`);
  assert.ok(Math.abs(there.x - moved.x) > 100, "the window moved with the mouse again");
  assert.equal(carried + after, 0, "a window let go on the island does not open it either");

  step("the cursor leaves, then rests on the island: Open on hover opens it");
  await app.mouse.glide(over.x, over.y + 260 * pan.r);
  await sleep(800);
  await app.mouse.glide(over.x, over.y);
  await d.until("return document.getElementById('island').getBoundingClientRect().height > 100", 5_000, "the island opening on a hover");
});
