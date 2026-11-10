// Lumo is Filo, a ring of light; the agents' minis are little balls. Every
// state, emote and eye drawn in both without throwing (src/character/looks.ts,
// engine.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";
import { BOT_STATES, BotEngine } from "../src/character/engine.ts";

// ── A canvas that only records ────────────────────────────────────────────────

class FakePath {
  constructor() { this.ops = 0; }
}
for (const m of ["moveTo", "lineTo", "closePath", "arc", "arcTo", "ellipse", "quadraticCurveTo", "bezierCurveTo", "rect", "roundRect"]) {
  FakePath.prototype[m] = function () { this.ops++; };
}
globalThis.Path2D ??= FakePath;

/** A 2D context: every call is counted, numbers are checked for NaN. */
function fakeContext() {
  const calls = new Map();
  const state = { shadowBlur: 0, globalAlpha: 1 };
  const gradient = { addColorStop(o, c) {
    assert.ok(Number.isFinite(o) && o >= 0 && o <= 1, `colour stop ${o}`);
    assert.ok(!/NaN/.test(String(c)), `colour ${c}`);
  } };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === "canvas") return { width: 300, height: 300 };
      if (key === "calls") return calls;
      if (key === "getTransform") return () => ({ a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 });
      if (key === "measureText") return (s) => ({ width: String(s).length * 4 });
      if (key === "createLinearGradient" || key === "createRadialGradient") {
        return (...args) => {
          for (const a of args) assert.ok(Number.isFinite(a), `${key}(${args.join(", ")})`);
          return gradient;
        };
      }
      return (...args) => {
        for (const a of args) if (typeof a === "number") assert.ok(Number.isFinite(a), `${String(key)}(${args.join(", ")})`);
        calls.set(key, (calls.get(key) ?? 0) + 1);
      };
    },
    set(target, key, value) {
      if (typeof value === "number") assert.ok(Number.isFinite(value), `${String(key)} = ${value}`);
      target[key] = value;
      return true;
    },
  });
  return ctx;
}

// ── A clock of our own, so tweens and pulses can be stepped through ───────────

let clock = 1000;
Object.defineProperty(performance, "now", { value: () => clock, configurable: true, writable: true });
const step = (e, seconds, fps = 30) => {
  for (let i = 0; i < seconds * fps; i++) {
    clock += 1000 / fps;
    e.update(1 / fps);
  }
};

/** Within a second he stops asking for frames (a blink may be under way). */
const quietSoon = (e) => {
  for (let i = 0; i < 30; i++) {
    if (!e.busy) return true;
    step(e, 1 / 30);
  }
  return !e.busy;
};

const STATES = Object.keys(BOT_STATES);
const EMOTES = ["love", "surprised", "proud", "wink", "yawn", "happy", "annoyed"];
/** Lumo himself, or one of the agents' minis. */
const KINDS = ["filo", "mini"];
function engine(kind) {
  const e = new BotEngine();
  if (kind === "mini") {
    e.isMini = true;
    e.bodyColor = [0.5, 0.2, 0.9];
  }
  return e;
}

// ── No look to pick ───────────────────────────────────────────────────────────

test("there is no look nor outfit to pick any more", () => {
  assert.equal("lumoCharacter" in DEFAULT_SETTINGS, false);
  assert.equal("lumoOutfit" in DEFAULT_SETTINGS, false);
});

// ── Lumo and the minis ────────────────────────────────────────────────────────

/** Draws one frame of `e` and returns what was called. */
function frame(e, W = 60, H = 80) {
  const ctx = fakeContext();
  e.draw(ctx, W, H);
  return ctx.calls;
}

test("Lumo is drawn as Filo's ring of light; the agents' minis keep their shape", () => {
  const e = new BotEngine();
  assert.equal(e.round, true);
  // Filo at rest has no ellipse on the canvas.
  assert.equal(frame(e).get("ellipse") ?? 0, 0);
  const mini = engine("mini");
  assert.equal(mini.round, false);
  frame(mini);
});

test("Filo takes the state's colour, warm at rest", () => {
  const e = new BotEngine();
  e.ambient = 0;
  step(e, 2);
  assert.ok(e.glow[0] > 0.95 && e.glow[1] > 0.85 && e.glow[2] < 0.7, `warm: ${e.glow}`);
  e.setState("working");
  step(e, 3);
  assert.ok(e.glow[2] > 0.95 && e.glow[0] < 0.3, `blue: ${e.glow}`);
  e.setState("error");
  step(e, 3);
  assert.ok(e.glow[0] > 0.9 && e.glow[1] < 0.4, `red: ${e.glow}`);
});

// ── Every state, emote and eye ────────────────────────────────────────────────

for (const kind of KINDS) {
  test(`${kind}: every state draws, from the closed island to the big views`, () => {
    for (const W of [20 / 0.6, 56 / 0.6, 150]) {
      for (const s of STATES) {
        const e = engine(kind);
        e.particleOverhang = 20;
        e.setState(s, true);
        for (let i = 0; i < 6; i++) {
          step(e, 0.15);
          frame(e, W, W + 20);
        }
      }
    }
  });

  test(`${kind}: every emote and eye draws`, () => {
    const e = engine(kind);
    for (const m of EMOTES) {
      e.triggerEmote(m, 0.5);
      step(e, 0.1);
      frame(e);
      e.setPermanentEmote(m);
      step(e, 0.1);
      frame(e);
    }
    e.setPermanentEmote(null);
    for (const eye of ["pill", "wide", "dot", "line", "flat", "happy", "closed", "spiral", "heart", "star", "tired", "wink", "cup"]) {
      e.eyeOverride = eye;
      e.eyeOverrideUntil = Number.POSITIVE_INFINITY;
      frame(e, 20 / 0.6, 40);
      frame(e, 150, 170);
    }
  });

  test(`${kind}: looking around, dizzy, the box a file is dropped into, a poke and a wave`, () => {
    const d = engine(kind);
    d.lookX = 0.8;
    d.lookY = -0.5;
    step(d, 0.3);
    frame(d);
    d.setState("dizzy");
    step(d, 0.5);
    frame(d);
    const e = engine(kind);
    e.animateMorph(1, 100);
    step(e, 0.2);
    e.slotHTarget = 0.42;
    step(e, 0.2);
    frame(e);
    e.gulp();
    step(e, 0.3);
    frame(e);
    e.resetMorph();
    e.slap();
    e.greet();
    e.bodyColor = [0.2, 0.6, 0.4];
    step(e, 0.2);
    frame(e);
  });
}

test("the closed island and the open island's top bar: only Filo's eyes", () => {
  const e = new BotEngine();
  e.eyesOnly = true;
  e.setState("working", true);
  step(e, 0.3);
  const calls = frame(e, 20 / 0.6, 40);
  // No ring of light: nothing is stroked round him, no halo is filled behind him.
  assert.equal(calls.get("stroke") ?? 0, 0);
  assert.ok((calls.get("fill") ?? 0) > 0, "his eyes");
});

// ── Frames ────────────────────────────────────────────────────────────────────

test("Filo at rest asks for no frames when Lumo only moves when something happens", () => {
  const e = new BotEngine();
  e.ambient = 0;
  e.setState("working", true);
  step(e, 4);
  e.setState("idle");
  step(e, 2);
  // Only the blinks (a fifth of a second every few seconds) ask for frames.
  let busy = 0;
  for (let i = 0; i < 300; i++) {
    step(e, 1 / 30);
    if (e.busy) busy++;
  }
  assert.ok(busy < 300 * 0.25, `busy ${busy} frames out of 300`);
  assert.equal(e.ambientActive, false);
  // Calm: the island keeps drawing him at its gentle rate.
  e.ambient = 1;
  assert.equal(e.ambientActive, true);
});

test("his heartbeat keeps going while something waits for you", () => {
  const e = new BotEngine();
  e.ambient = 0;
  e.setState("question", true);
  step(e, 3);
  assert.equal(e.busy, true);
  e.setState("idle");
  step(e, 1);
  assert.ok(quietSoon(e), "settles at rest");
});

test("an error and a finish light Filo up, then settle", () => {
  const e = new BotEngine();
  e.ambient = 0;
  e.setState("error", true);
  assert.equal(e.flash, 1);
  step(e, 2);
  assert.ok(e.flash < 0.01);
  assert.ok(quietSoon(e));
  e.setState("finished");
  step(e, 0.3);
  assert.ok(e.flash > 0.35);
  assert.ok(e.statePose().dy < -0.1, "a hop");
  assert.equal(e.roll, 0, "no roll");
  step(e, 2);
  assert.ok(quietSoon(e), "then still");
});

test("the agents' minis still jolt on an error and roll when they are done", () => {
  const e = engine("mini");
  e.ambient = 0;
  e.setState("error", true);
  step(e, 0.06);
  assert.ok(Math.abs(e.ox) > 0.01, "a jolt");
  e.setState("finished");
  step(e, 0.3);
  assert.ok(e.roll > 0, "a roll");
});
