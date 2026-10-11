// Settings → General → Energy: how hard Lumo works. The same rules as
// src-tauri/src/energy.rs, which runs Rust's own pollers by them; this side
// draws the island and asks the page's pollers (the calendar, the music, the
// plan usage) by them.
//
// - "none": nothing spared, everything asked more often (near real time);
// - "light": as Lumo always was;
// - "saver": energy saving — the closed island draws 15 frames a second,
//   Lumo dozes while the mouse is away (eyes shut, grey, still) and stops
//   moving once the mouse rests, and everything is asked less often;
// - "auto": "saver" on battery; on mains power, what "On mains power" says
//   ("none" or "light").

import { N_ } from "../i18n/i18n";

export type EnergyMode = "none" | "light" | "auto" | "saver";
export type EnergyOnPower = "none" | "light";
export type Effort = "realtime" | "light" | "saver";

export const ENERGY_MODES: readonly { id: EnergyMode; label: string }[] = [
  { id: "none", label: N_("None — near real time") },
  { id: "light", label: N_("Light") },
  { id: "auto", label: N_("Automatic") },
  { id: "saver", label: N_("On — save energy") },
];

export const ENERGY_ON_POWER: readonly { id: EnergyOnPower; label: string }[] = [
  { id: "light", label: N_("Light") },
  { id: "none", label: N_("None — near real time") },
];

export function parseEnergyMode(v: unknown): EnergyMode {
  return v === "none" || v === "light" || v === "saver" ? v : "auto";
}

export function parseOnPower(v: unknown): EnergyOnPower {
  return v === "none" ? "none" : "light";
}

/** The effort a setting asks for, given the power source (energy.rs effective). */
export function effectiveEffort(mode: unknown, onPower: unknown, onBattery: boolean): Effort {
  switch (mode) {
    case "none": return "realtime";
    case "light": return "light";
    case "saver": return "saver";
    case "auto": return onBattery ? "saver" : onPower === "none" ? "realtime" : "light";
    // A value this build does not know: the usual way.
    default: return "light";
  }
}

/** One value for each effort. */
export function byEffort<T>(effort: Effort, realtime: T, light: T, saver: T): T {
  return effort === "realtime" ? realtime : effort === "saver" ? saver : light;
}

// ── The closed island while saving energy ─────────────────────────────────────

/** Frames a second of the closed island while saving energy (30 otherwise). */
export const SAVER_FPS = 15;
/** The mouse this far from the island (page pixels): Lumo dozes. */
export const DOZE_DISTANCE = 160;
/** The mouse at rest this long: Lumo stops moving (ms). */
export const STILL_AFTER_MS = 1000;

/** How far (x, y) is from a rectangle, 0 inside it. */
export function distanceTo(x: number, y: number, r: { x: number; y: number; w: number; h: number }): number {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
  return Math.hypot(dx, dy);
}
