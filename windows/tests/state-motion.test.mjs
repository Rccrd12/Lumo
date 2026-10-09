// How Lumo moves and shines in each state — the "Punto" concept's poses ported
// to the app (src/mochi/motion.ts), and the engine reading them for every look.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLEND_S, blendMotion, blendTips, finishedSmiles, flashOf, heartbeat, hop, motionKind, poolOfLight,
  ripplePhase, settleTime, stateGaze, stateMotion, tipLights,
} from "../src/mochi/motion.ts";
import { BotEngine } from "../src/mochi/engine.ts";

const near = (a, b, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≈ ${b}`);
const zero = (v, msg = "") => near(v, 0, 1e-12, msg);
const range = (from, to, dt = 0.01) => {
  const out = [];
  for (let v = from; v <= to + 1e-9; v += dt) out.push(v);
  return out;
};

// ── The states ────────────────────────────────────────────────────────────────

test("the engine's states map onto the concept's five", () => {
  assert.equal(motionKind("idle"), "idle");
  for (const s of ["working", "thinking", "searching"]) assert.equal(motionKind(s), "working");
  for (const s of ["approval", "question"]) assert.equal(motionKind(s), "waiting");
  assert.equal(motionKind("error"), "error");
  assert.equal(motionKind("finished"), "finished");
  for (const s of ["sleeping", "dizzy", "ratelimit"]) assert.equal(motionKind(s), "other");
});

// ── Idle and working: loops that follow the motion setting ───────────────────

test("at rest he breathes, and keeps still with motion off", () => {
  let lo = 1, hi = 1;
  for (const t of range(0, 4.2, 0.05)) {
    const m = stateMotion("idle", t, t, 1);
    lo = Math.min(lo, m.scale);
    hi = Math.max(hi, m.scale);
    const still = stateMotion("idle", t, t, 0);
    assert.equal(still.scale, 1);
    zero(still.dy);
    near(still.shine, 0.42);
  }
  near(hi, 1.014, 1e-3, "swells");
  near(lo, 0.986, 1e-3, "and shrinks");
});

test("working he pulses brighter and bobs every 1.5 s", () => {
  const top = stateMotion("working", 0, 1.5 / 4, 1);
  near(top.dy, -0.07, 1e-9, "up");
  near(top.shine, 0.98, 1e-9);
  near(top.squash, -0.5, 1e-9, "Goccia stretches as it rises");
  const again = stateMotion("working", 0, 1.5 / 4 + 1.5, 1);
  near(again.dy, top.dy, 1e-9, "a 1.5 s period");
  zero(stateMotion("working", 0, 1.5 / 4, 0).dy, "still with motion off");
  // Thinking is the same, slower.
  near(stateMotion("thinking", 0, 2.2 / 4, 1).dy, -0.07, 1e-9);
});

// ── Waiting: the heartbeat and the ripple ────────────────────────────────────

test("waiting, the light beats twice every 1.1 s, the second softer", () => {
  near(heartbeat(0.12), 1, 1e-9, "first beat");
  near(heartbeat(0.36), 0.75, 1e-3, "second beat");
  assert.ok(heartbeat(0.8) < 0.01, "then quiet");
  near(heartbeat(0.12 + 1.1 * 3), 1, 1e-9, "every 1.1 s");
  near(heartbeat(-0.98), 1, 1e-9, "for any clock");
});

test("the ripple leaves on the first beat and grows over the whole beat", () => {
  near(ripplePhase(0.12), 0, 1e-9);
  near(ripplePhase(0.12 + 0.55), 0.5, 1e-9);
  for (const t of range(0, 3, 0.07)) {
    const k = ripplePhase(t);
    assert.ok(k >= 0 && k < 1, `${t}: ${k}`);
  }
});

test("waiting beats and ripples whatever the motion setting", () => {
  for (const amb of [0, 1]) {
    const m = stateMotion("approval", 5, 0.12, amb);
    assert.equal(m.ripple, 1);
    near(m.pulse, 1, 1e-9);
    near(m.scale, 1.07, 1e-9, "swells on the beat");
    near(m.shine, 1, 1e-9);
  }
  assert.equal(stateMotion("idle", 0, 0.12, 1).ripple, 0, "no ripple at rest");
});

// ── Error: one shake, a flash, × eyes looking down ───────────────────────────

test("an error shakes once, dying out in 0.6 s, then sinks a little", () => {
  let most = 0;
  for (const local of range(0, 0.6, 0.005)) most = Math.max(most, Math.abs(stateMotion("error", local, 0, 1).dx));
  assert.ok(most > 0.08 && most <= 0.13, `shake ${most}`);
  zero(stateMotion("error", 0, 0, 1).dx, "starts in place");
  for (const local of [0.6, 0.8, 2]) zero(stateMotion("error", local, 0, 1).dx, `still at ${local}`);
  // Early swings are wider than late ones.
  const swing = (a, b) => Math.max(...range(a, b, 0.002).map((l) => Math.abs(stateMotion("error", l, 0, 1).dx)));
  assert.ok(swing(0, 0.12) > swing(0.4, 0.55) * 2);
  const later = stateMotion("error", 3, 0, 1);
  near(later.dy, 0.03, 1e-6, "sinks");
  near(later.scale, 0.97, 1e-6, "a little smaller");
  near(later.shine, 0.36, 1e-6, "dim");
  near(stateMotion("error", 0, 0, 1).shine, 1, 1e-9, "flash");
});

test("the flash fades fast on an error, slower when it is done", () => {
  assert.equal(flashOf("error", 0), 1);
  assert.equal(flashOf("finished", 0), 1);
  assert.ok(flashOf("error", 0.5) < flashOf("finished", 0.5));
  assert.ok(flashOf("error", 1) < 0.01);
  assert.equal(flashOf("working", 0), 0);
});

// ── Finished: a hop, a squash on landing, ^^ ─────────────────────────────────

test("done, he hops 0.2 R in half a second and squashes on landing", () => {
  near(hop(0.25), 1, 1e-9);
  assert.equal(hop(0.5), 0);
  assert.equal(hop(1), 0);
  near(stateMotion("finished", 0.25, 0, 1).dy, -0.2, 1e-9, "top of the hop");
  assert.ok(stateMotion("finished", 0.2, 0, 1).squash < -0.4, "stretched in the air");
  assert.ok(stateMotion("finished", 0.6, 0, 1).squash > 0.7, "squashed on landing");
  zero(stateMotion("finished", 0.8, 0, 1).squash);
  zero(stateMotion("finished", 0.8, 0, 1).dy);
  near(stateMotion("finished", 0, 0, 1).shine, 0.97, 1e-9, "a burst of light");
  // Then a soft glow that swells and ebbs every 3 s while he moves on his own.
  const glow = range(3, 6, 0.1).map((l) => stateMotion("finished", l, 0, 1).shine);
  assert.ok(Math.max(...glow) - Math.min(...glow) > 0.14);
  const still = range(3, 6, 0.1).map((l) => stateMotion("finished", l, 0, 0).shine);
  assert.ok(Math.max(...still) - Math.min(...still) < 0.01);
});

test("done, he smiles ^^ for two seconds, then now and then", () => {
  for (const l of [0, 1, 1.99]) assert.equal(finishedSmiles(l, 1), true, `${l}`);
  for (const l of [2.1, 3, 3.9]) assert.equal(finishedSmiles(l, 1), false, `${l}`);
  for (const l of [4.1, 4.5, 4.1 + 2.6]) assert.equal(finishedSmiles(l, 1), true, `${l}`);
  for (const l of [0, 3, 10]) assert.equal(finishedSmiles(l, 0), true, "always, with motion off");
});

test("his eyes look up at you when he waits, down on an error, up a little when done", () => {
  assert.ok(stateGaze("approval") < -0.5);
  assert.ok(stateGaze("error") > 0.3);
  assert.ok(stateGaze("finished") < 0);
  assert.equal(stateGaze("idle"), null);
  assert.equal(stateGaze("working"), null);
});

test("frames are asked for until the shake, the hop and the flash are over", () => {
  assert.ok(settleTime("error") >= 0.6);
  assert.ok(settleTime("finished") >= 0.75);
  assert.ok(flashOf("finished", settleTime("finished")) < 0.02);
  assert.equal(settleTime("idle"), 0);
  assert.equal(settleTime("working"), 0);
});

// ── From one state to the next ───────────────────────────────────────────────

test("one state's pose eases into the next one's", () => {
  const a = stateMotion("approval", 1, 0.12, 1);
  const b = stateMotion("idle", 0, 0.12, 1);
  assert.deepEqual(blendMotion(a, b, 0), { ...a });
  assert.equal(blendMotion(a, b, 1), b);
  const mid = blendMotion(a, b, 0.5);
  near(mid.scale, (a.scale + b.scale) / 2);
  near(mid.ripple, 0.5);
  assert.equal(mid.rp, a.rp, "the ripple keeps travelling as it fades");
});

// ── The firefly's antenna lights ─────────────────────────────────────────────

test("the firefly's antenna lights twinkle in turn at rest", () => {
  for (const t of range(0, 3.1, 0.1)) {
    const l = tipLights("idle", 0, t, 1);
    near(l.a[0] + l.a[1], 1.5, 1e-9);
  }
  const l = tipLights("idle", 0, 3.1 / 4, 1);
  near(l.a[0], 1, 1e-9);
  near(l.a[1], 0.5, 1e-9);
  const still = tipLights("idle", 0, 3.1 / 4, 0);
  assert.deepEqual(still.a, [0.75, 0.75], "steady with motion off");
});

test("working, they twinkle quickly and trail the bob", () => {
  const vals = range(0, 1.5, 0.02).map((t) => tipLights("working", 0, t, 1));
  assert.ok(Math.max(...vals.map((v) => v.a[0])) > 0.95);
  assert.ok(Math.min(...vals.map((v) => v.a[0])) < 0.45);
  assert.ok(Math.max(...vals.map((v) => Math.abs(v.sy))) > 0.05);
  // The lift lags the body's bob (stateMotion's dy) by about 0.9 rad.
  const body = (t) => stateMotion("working", 0, t, 1).dy;
  const tips = (t) => tipLights("working", 0, t, 1).sy;
  const peak = (f) => range(0, 1.5, 0.005).reduce((b, t) => (f(t) < f(b) ? t : b), 0);
  near(peak(tips) - peak(body), (0.9 / (Math.PI * 2)) * 1.5, 0.02, "lag");
});

test("waiting, they perk up with the heartbeat; on an error they droop and dim", () => {
  const beat = tipLights("approval", 0, 0.16, 0);
  near(beat.a[0], 1, 1e-9);
  assert.ok(beat.sy < -0.09 && beat.sx > 0.07, "up and apart");
  const rest = tipLights("approval", 0, 0.8, 0);
  assert.ok(rest.a[0] < 0.6);
  const err = tipLights("error", 1, 0, 1);
  assert.ok(err.sy > 0.1, "lower");
  assert.ok(err.a[0] < 0.5 && err.a[1] < 0.5, "dimmer");
});

test("done, they sparkle, again every 2.6 s while he moves on his own", () => {
  near(tipLights("finished", 0.35, 0, 1).sp, 1, 1e-9);
  assert.ok(tipLights("finished", 1.2, 0, 1).sp < 0.01);
  near(tipLights("finished", 0.35 + 2.6, 0, 1).sp, 1, 1e-9);
  assert.ok(tipLights("finished", 0.35 + 2.6, 0, 0).sp < 0.01, "only once with motion off");
  assert.equal(tipLights("working", 0.35, 0, 1).sp, 0);
});

test("the lights ease from one state to the next, a sparkle only as it arrives", () => {
  const a = tipLights("error", 2, 0, 1);
  const b = tipLights("finished", 0.35, 0, 1);
  const mid = blendTips(a, b, 0.5);
  near(mid.sy, (a.sy + b.sy) / 2);
  near(mid.sp, 0.5);
  assert.equal(blendTips(a, b, 1), b);
});

// ── Goccia's pool of light ───────────────────────────────────────────────────

test("Goccia's pool of light shrinks and fades as the drop lifts", () => {
  assert.deepEqual(poolOfLight(0), { lift: 0, r: 1, a: 1 });
  assert.deepEqual(poolOfLight(0.05), { lift: 0, r: 1, a: 1 }, "sinking does not grow it");
  const up = poolOfLight(-0.2);
  near(up.lift, 0.6);
  assert.ok(up.r < 0.9 && up.a < 0.75);
  near(poolOfLight(-1).a, 0.5, 1e-9, "never gone");
});

// ── The engine, every look ───────────────────────────────────────────────────

let clock = 5000;
const realNow = performance.now;
const step = (e, seconds, fps = 30) => {
  for (let i = 0; i < seconds * fps; i++) {
    clock += 1000 / fps;
    e.update(1 / fps);
  }
};

test("the engine plays the concept's poses, eased from state to state", (t) => {
  Object.defineProperty(performance, "now", { value: () => clock, configurable: true, writable: true });
  t.after(() => Object.defineProperty(performance, "now", { value: realNow, configurable: true, writable: true }));

  const e = new BotEngine();
  e.look = "punto";
  e.ambient = 1;
  e.setState("error", true);
  let shake = 0;
  for (let i = 0; i < 15; i++) {
    step(e, 1 / 30);
    shake = Math.max(shake, Math.abs(e.statePose().dx));
    assert.equal(e.ox, 0, "with no tween of its own");
  }
  assert.ok(shake > 0.03, `a round look shakes (${shake})`);
  step(e, 1);
  zero(e.statePose().dx);

  // The face changes a beat after the light.
  e.setState("finished");
  assert.equal(e.stateEye(), "flat", "the × eyes for a moment");
  step(e, BLEND_S);
  assert.equal(e.stateEye(), "happy");
  step(e, 2.3);
  assert.equal(e.stateEye(), "pill", "smiled a while, the eyes open again");
  e.ambient = 0;
  assert.equal(e.stateEye(), "happy", "keeps smiling with motion off");
  e.ambient = 1;

  // From waiting back to rest, the beat fades instead of stopping dead.
  e.setState("approval");
  step(e, 2);
  e.setState("idle");
  step(e, 0.1);
  assert.ok(e.statePose().ripple > 0.3, "the ripple fades out");
  step(e, BLEND_S);
  assert.equal(e.statePose().ripple, 0);

  // The firefly's antenna lights follow the state too.
  const f = new BotEngine();
  f.look = "lucciola";
  f.setState("error", true);
  step(f, 1);
  assert.ok(f.tipPose().sy > 0.1, "droop");
  f.setState("approval");
  step(f, 1);
  assert.equal(f.busy, true, "his tail beats while he waits");

  // The agents' minis keep their own eyes.
  const mini = new BotEngine();
  mini.isMini = true;
  mini.setState("finished", true);
  step(mini, 3);
  assert.equal(mini.stateEye(), "happy");
});
