// Lumo's looks: Filo (a ring of light, the default), Punto, Goccia and Lucciola
// (the firefly). The setting, the renderer it picks, and every state, emote
// and outfit drawn in every look without throwing (src/mochi/looks.ts, engine.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LOOK, LOOK_LABELS, LUMO_LOOKS, OUTFIT_SELECTIONS, parseLook, wardrobeHeader,
} from "../src/mochi/wardrobe.ts";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";
import { BOT_STATES, BotEngine } from "../src/mochi/engine.ts";
import { isRoundLook } from "../src/mochi/looks.ts";
import { drawLookIcon, drawWardrobeIcon } from "../src/mochi/outfits.ts";
import { Greeting, GREETING_END, greetingPose, lumoBounds } from "../src/mochi/greeting.ts";
import { drawLookDropping } from "../src/mochi/looks.ts";

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
const OUTFITS = OUTFIT_SELECTIONS.filter((o) => o !== "auto" && o !== "none");

// ── The setting ───────────────────────────────────────────────────────────────

test("Lumo is Filo unless another look was chosen", () => {
  assert.equal(DEFAULT_LOOK, "filo");
  assert.equal(DEFAULT_SETTINGS.lumoCharacter, "filo");
  assert.deepEqual([...LUMO_LOOKS], ["filo", "punto", "goccia", "lucciola"]);
  for (const look of LUMO_LOOKS) assert.equal(parseLook(look), look);
  for (const raw of [undefined, null, "", "perla", "Filo", 3, {}]) assert.equal(parseLook(raw), "filo");
});

test("only the firefly is not a round look", () => {
  assert.deepEqual(LUMO_LOOKS.filter(isRoundLook), ["filo", "punto", "goccia"]);
});

test("the wardrobe header names a hovered look", () => {
  const d = new Date(2026, 7, 1, 12);
  assert.equal(wardrobeHeader({ look: "goccia" }, "none", d), LOOK_LABELS.goccia);
  assert.equal(wardrobeHeader({ look: "lucciola" }, "auto", d), "Lucciola · the firefly");
  assert.equal(wardrobeHeader(null, "none", d), "None");
});

// ── The renderer the look picks ───────────────────────────────────────────────

/** Draws one frame of `e` and returns what was called. */
function frame(e, W = 60, H = 80) {
  const ctx = fakeContext();
  e.draw(ctx, W, H);
  return ctx.calls;
}

test("the look decides how the engine draws him; the agents' minis keep their shape", () => {
  const e = new BotEngine();
  assert.equal(e.look, "filo");
  assert.equal(e.round, true);
  // The firefly's lantern is an ellipse on the canvas; a round look at rest has none.
  assert.equal(frame(e).get("ellipse") ?? 0, 0);
  e.look = "lucciola";
  assert.equal(e.round, false);
  assert.ok((frame(e).get("ellipse") ?? 0) > 0, "the firefly's tail");
  const mini = new BotEngine();
  mini.isMini = true;
  mini.bodyColor = [0.5, 0.2, 0.9];
  assert.equal(mini.round, false);
});

test("a round look takes the state's colour, warm at rest", () => {
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

// ── Every state, emote and outfit, in every look ──────────────────────────────

for (const look of LUMO_LOOKS) {
  test(`${look}: every state draws, from the closed island to the big views`, () => {
    for (const W of [20 / 0.6, 56 / 0.6, 150]) {
      for (const s of STATES) {
        const e = new BotEngine();
        e.look = look;
        e.particleOverhang = 20;
        e.setState(s, true);
        for (let i = 0; i < 6; i++) {
          step(e, 0.15);
          frame(e, W, W + 20);
        }
      }
    }
  });

  test(`${look}: every emote and eye draws`, () => {
    const e = new BotEngine();
    e.look = look;
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

  test(`${look}: every outfit, the box a file is dropped into, a poke and a wave`, () => {
    for (const o of OUTFITS) {
      const e = new BotEngine();
      e.look = look;
      e.setOutfit(o, false);
      e.lookX = 0.8;
      e.lookY = -0.5;
      step(e, 0.3);
      frame(e);
      e.setState("dizzy");
      step(e, 0.5);
      frame(e);
    }
    const e = new BotEngine();
    e.look = look;
    e.animateMorph(1, 100);
    step(e, 0.2);
    e.slotHTarget = 0.42;
    step(e, 0.2);
    frame(e);
    e.gulp();
    step(e, 0.3);
    frame(e);
    e.resetMorph();
    e.bodyColor = [0.2, 0.6, 0.4];
    step(e, 0.2);
    frame(e);
  });

  test(`${look}: the wardrobe's buttons draw`, () => {
    drawLookIcon(fakeContext(), 28, look);
    for (const sel of OUTFIT_SELECTIONS) drawWardrobeIcon(fakeContext(), 28, sel, "leaf", "AUTO", look);
  });

  test(`${look}: the greeting blooms into him, inside the island`, () => {
    const g = new Greeting();
    g.look = look;
    for (let t = 0; t < GREETING_END + 1; t += 0.05) {
      const b = lumoBounds(greetingPose(t), look);
      if (b) {
        assert.ok(b.bottom <= 150 && b.top >= 0, `t=${t}: ${JSON.stringify(b)}`);
        assert.ok(b.left >= 0 && b.right <= 640, `t=${t}: ${JSON.stringify(b)}`);
      }
    }
    g.draw(fakeContext());
  });

  if (isRoundLook(look)) {
    test(`${look}: the drop sequence draws him turning into the box`, () => {
      for (const [morph, eye] of [[0, "pill"], [0.5, "cup"], [1, "cup"], [1, "content"]]) {
        drawLookDropping(fakeContext(), look, {
          x: 100, y: 90, d: 60, sx: 1, sy: 1, tilt: 0, hop: 0, t: 1.2, morph, mouth: 0.3, eye, lookX: 0.4, lookY: -0.3,
        });
      }
    });
  }
}

// ── Frames: nothing more than the firefly asks for ───────────────────────────

test("a round look at rest asks for no frames when Lumo only moves when something happens", () => {
  const e = new BotEngine();
  e.ambient = 0;
  e.setState("working", true);
  step(e, 4);
  e.setState("idle");
  step(e, 2);
  // Only the blinks (a fifth of a second every few seconds) ask for frames, as for the firefly.
  let busy = 0;
  for (let i = 0; i < 300; i++) {
    step(e, 1 / 30);
    if (e.busy) busy++;
  }
  assert.ok(busy < 300 * 0.25, `busy ${busy} frames out of 300`);
  assert.equal(e.ambientActive, false);
  // Calm: the island keeps drawing him at its gentle rate, as for the firefly.
  e.ambient = 1;
  assert.equal(e.ambientActive, true);
});

test("every look keeps its heartbeat going while something waits for you", () => {
  for (const look of LUMO_LOOKS) {
    const e = new BotEngine();
    e.look = look;
    e.ambient = 0;
    e.setState("question", true);
    step(e, 3);
    assert.equal(e.busy, true, look);
    e.setState("idle");
    step(e, 1);
    assert.ok(quietSoon(e), `${look} settles at rest`);
  }
});

test("an error and a finish light a round look up, then settle", () => {
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

test("the firefly still jolts on an error and rolls when it is done", () => {
  const e = new BotEngine();
  e.look = "lucciola";
  e.ambient = 0;
  e.setState("error", true);
  step(e, 0.06);
  assert.ok(Math.abs(e.ox) > 0.01, "a jolt");
  e.setState("finished");
  step(e, 0.3);
  assert.ok(e.roll > 0, "a roll");
});
