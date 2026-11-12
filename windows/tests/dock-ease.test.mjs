// The island let go after a move (src/island/dock-ease.ts, island.rs drag):
// the window springs to its place while the page eases the island from
// where it was drawn to its new anchor. On screen it must move as one spring,
// with no frame where it jumps, even when the page hears of the drop late.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOCK_DAMPING, DOCK_RESPONSE, DockEase } from "../src/island/dock-ease.ts";

const FRAME = 1 / 60;

/** island.rs Axis: the window's spring, sub-stepped at 240 Hz. */
function axis(x) {
  const omega = (2 * Math.PI) / DOCK_RESPONSE;
  return {
    x,
    v: 0,
    step(target, dt) {
      const steps = Math.max(1, Math.ceil(dt * 240));
      const h = dt / steps;
      for (let i = 0; i < steps; i++) {
        const a = -omega * omega * (this.x - target) - 2 * DOCK_DAMPING * omega * this.v;
        this.v += a * h;
        this.x += this.v * h;
      }
    },
  };
}

/**
 * A drop, frame by frame, on one axis (ms; the springs start at 0): the
 * window at `w0` springs to `t` (island.rs, stepped on every frame); the
 * island was drawn at `drawn` in the window and its new anchor is `anchor`.
 * The page hears of the drop at `heard` and draws its frames `phase` ms
 * before each frame of the display. Returns where the island is on screen
 * at each frame shown.
 */
function drop({ w0, t, drawn, anchor, heard = -40, phase = 0, frames = 90 }) {
  const win = axis(w0);
  const ease = new DockEase();
  const seen = [];
  let anchored = drawn;
  let started = false;
  for (let f = -3; f < frames; f++) {
    const shown = f * FRAME * 1000;
    const page = shown - phase;
    if (!started && page >= heard) {
      ease.start({ x: anchored + ease.offset.x, y: 0 }, { x: anchor, y: 0 }, 0, page);
      anchored = anchor;
      started = true;
    }
    if (shown > 0) win.step(t, FRAME);
    ease.tick(page);
    seen.push(win.x + anchored + ease.offset.x);
  }
  return seen;
}

const biggestStep = (seen) => Math.max(...seen.slice(1).map((v, i) => Math.abs(v - seen[i])));

/** The same move as one spring, from where it was let go to its place. */
function oneSpring(from, to, frames = 90) {
  const one = axis(from);
  const seen = [from, from, from, from];
  for (let f = 1; f < frames; f++) {
    one.step(to, FRAME);
    seen.push(one.x);
  }
  return seen;
}

test("the window and the island's ease have the same spring", () => {
  const rust = readFileSync(new URL("../src-tauri/src/island.rs", import.meta.url), "utf8");
  const read = (name) => Number(rust.match(new RegExp(`const ${name}: f64 = ([0-9.]+);`))[1]);
  assert.equal(read("BOUNCE_RESPONSE"), DOCK_RESPONSE);
  assert.equal(read("BOUNCE_DAMPING"), DOCK_DAMPING);
});

test("let go mid-screen, the island goes to its place as one spring", () => {
  // Dropped low on a 150 % laptop: the window stays on the display and the
  // island is drawn 136 px further down in it (island.rs shift).
  const at = { w0: 400, t: 300, drawn: 10, anchor: 146 };
  const seen = drop(at);
  const one = oneSpring(410, 446);
  assert.equal(seen[0], 410, "it starts where it was let go");
  for (let f = 0; f < seen.length; f++) {
    assert.ok(Math.abs(seen[f] - one[f]) < 0.5, `frame ${f}: ${seen[f].toFixed(1)} where one spring is at ${one[f].toFixed(1)}`);
  }
});

test("drawn a little before or after the window moves, it still goes one way", () => {
  // The window goes up 100 px while the island goes down 136 px in it: a
  // page out of step would show it going the wrong way first.
  const at = { w0: 400, t: 300, drawn: 10, anchor: 146 };
  for (const phase of [-8, -4, 4, 8]) {
    const seen = drop({ ...at, phase });
    const back = Math.max(...seen.slice(1).map((v, i) => seen[i] - v));
    assert.ok(back < 12, `page ${phase} ms off the display: it went ${back.toFixed(1)} px the wrong way`);
    assert.ok(Math.abs(seen.at(-1) - 446) < 0.5, "it ends at its place");
  }
});

test("heard after the window started, the island never jumps", () => {
  // Flipped from the top to the bottom of its window: 400 px apart.
  const at = { w0: 300, t: 700, drawn: 10, anchor: 410 };
  const fastest = biggestStep(drop(at));
  for (const heard of [10, 30, 60, 200]) {
    const seen = drop({ ...at, heard });
    const step = biggestStep(seen);
    assert.ok(step <= fastest * 1.05, `heard ${heard} ms late: a step of ${step.toFixed(1)} px (the move's own: ${fastest.toFixed(1)})`);
    assert.ok(Math.abs(seen.at(-1) - (at.t + at.anchor)) < 0.5, `heard ${heard} ms late, it ends at its place`);
  }
});

test("the window resized under it, the island keeps its place on screen", () => {
  const ease = new DockEase();
  ease.start({ x: 0, y: 120 }, { x: 0, y: 20 }, 0, 0);
  ease.tick(16);
  const before = 20 + ease.offset.y;
  // A bottom anchor moves with the window's height: 40 px taller.
  ease.keepPlace({ x: 0, y: 20 }, { x: 0, y: 60 }, 16);
  assert.ok(Math.abs(60 + ease.offset.y - before) < 1e-9, "drawn at the same place");
  for (let i = 2; i < 120; i++) ease.tick(i * 16);
  assert.equal(ease.active, false);
  assert.deepEqual(ease.offset, { x: 0, y: 0 });
});

test("picked up again mid-ease, it stays where it is drawn", () => {
  const ease = new DockEase();
  ease.start({ x: 50, y: 0 }, { x: 0, y: 0 }, 0, 0);
  for (let i = 1; i <= 5; i++) ease.tick(i * 16);
  const held = ease.offset.x;
  ease.hold();
  for (let i = 6; i < 36; i++) ease.tick(i * 16);
  assert.equal(ease.offset.x, held, "it does not move while carried");
  assert.equal(ease.active, false);
  // Put down again: from where it is drawn.
  ease.start({ x: held, y: 0 }, { x: 10, y: 0 }, 600, 600);
  assert.equal(ease.offset.x, held - 10);
});

test("it waits for the window: still until the spring starts", () => {
  const ease = new DockEase();
  ease.start({ x: 0, y: 136 }, { x: 0, y: 0 }, 50, 0);
  ease.tick(20);
  ease.tick(49);
  assert.equal(ease.offset.y, 136);
  ease.tick(66);
  assert.ok(ease.offset.y < 136 && ease.offset.y > 120, `${ease.offset.y}`);
});

test("re-anchored in place, nothing eases", () => {
  const ease = new DockEase();
  ease.start({ x: 216, y: 10 }, { x: 216, y: 10 }, 0, 0);
  assert.equal(ease.active, false);
  assert.deepEqual(ease.offset, { x: 0, y: 0 });
});
