// Settings → General → Energy (src/core/energy.ts; src-tauri/src/energy.rs
// has the same rules for Rust's pollers): what each choice means, and Lumo
// still enough, saving energy, for the island to stop drawing him.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  byEffort, distanceTo, effectiveEffort, parseEnergyMode, parseOnPower,
} from "../src/core/energy.ts";
import { BotEngine } from "../src/mochi/engine.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";

test("the choice and the power source make the effort", () => {
  assert.equal(effectiveEffort("none", "light", true), "realtime");
  assert.equal(effectiveEffort("light", "none", true), "light");
  assert.equal(effectiveEffort("saver", "none", false), "saver");
  assert.equal(effectiveEffort("auto", "light", true), "saver");
  assert.equal(effectiveEffort("auto", "none", true), "saver", "on battery Automatic always saves");
  assert.equal(effectiveEffort("auto", "light", false), "light");
  assert.equal(effectiveEffort("auto", "none", false), "realtime");
  assert.equal(effectiveEffort("turbo", "none", false), "light", "an unknown choice is the usual way");
  assert.equal(byEffort("realtime", 1, 2, 3), 1);
  assert.equal(byEffort("light", 1, 2, 3), 2);
  assert.equal(byEffort("saver", 1, 2, 3), 3);
});

test("Automatic, plugged in as usual, is the default: nothing changes until the battery", () => {
  assert.equal(parseEnergyMode(DEFAULT_SETTINGS.energyMode), "auto");
  assert.equal(parseOnPower(DEFAULT_SETTINGS.energyOnPower), "light");
  assert.equal(parseEnergyMode("whatever"), "auto");
  assert.equal(parseOnPower("whatever"), "light");
  State.settings = { ...DEFAULT_SETTINGS };
  State.onBattery = false;
  assert.equal(State.effort, "light");
  State.onBattery = true;
  assert.equal(State.effort, "saver");
  State.onBattery = false;
});

test("how far the mouse is from the island", () => {
  const r = { x: 100, y: 0, w: 200, h: 40 };
  assert.equal(distanceTo(150, 20, r), 0, "inside");
  assert.equal(distanceTo(50, 20, r), 50);
  assert.equal(distanceTo(300, 70, r), 30);
  assert.equal(distanceTo(340, 70, r), 50);
});

let clock = 5000;
const realNow = performance.now;
const step = (e, seconds, fps = 30) => {
  for (let i = 0; i < seconds * fps; i++) {
    clock += 1000 / fps;
    e.update(1 / fps);
  }
};

test("dozing still, Lumo eases into his sleep and asks for no more frames", (t) => {
  Object.defineProperty(performance, "now", { value: () => clock, configurable: true, writable: true });
  t.after(() => Object.defineProperty(performance, "now", { value: realNow, configurable: true, writable: true }));

  const e = new BotEngine();
  e.look = "punto";
  e.ambient = 1;
  e.setState("sleeping");
  step(e, 3);
  assert.equal(e.busy, true, "asleep he breathes and his z's float");

  e.still = true;
  step(e, 3);
  assert.equal(e.busy, false, "dozing for energy: nothing moves");
  assert.equal(e.ambientActive, false);

  // At rest with the mouse still, awake: his idle hover stops too.
  const a = new BotEngine();
  a.look = "punto";
  a.ambient = 1;
  a.setState("idle");
  step(a, 3);
  assert.equal(a.ambientActive, true, "calm, he hovers");
  a.still = true;
  step(a, 3);
  assert.equal(a.ambientActive, false);
  assert.equal(a.busy, false);

  // The mouse moves again: he comes back to life.
  a.still = false;
  assert.equal(a.ambientActive, true);
});
