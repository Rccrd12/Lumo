// How Lumo moves and shines in each state, as numbers — the "Punto" concept's
// poses (design: punto-varianti.html) ported to the app. engine.ts reads them
// every frame and looks.ts and lumo.ts draw them; nothing here touches a canvas,
// so the timings can be tested on their own.
//
// The concept's five states map onto the engine's: idle; working (also
// thinking and searching); waiting (approval, and a question); error; finished.
// `local` is the time since the state began, `t` a free-running clock for the
// loops, and `amb` how much Lumo moves on his own (Settings → Island → Lumo
// moves): the loops scale with it, what happens when the state begins (the
// shake, the hop, the flash) and the "your turn" heartbeat do not.

import { lerp } from "../core/anim";
import type { BotStateName } from "../core/layout";

const TAU = Math.PI * 2;

export const ease = (k: number) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
const mod = (v: number, m: number) => ((v % m) + m) % m;

/** Seconds over which one state's pose eases into the next one's. */
export const BLEND_S = 0.38;
/** The face changes a beat after the light: the old eyes stay until the blend is this far. */
export const FACE_K = 0.3;

export type MotionKind = "idle" | "working" | "waiting" | "error" | "finished" | "other";

export function motionKind(s: BotStateName): MotionKind {
  switch (s) {
    case "idle":
      return "idle";
    case "working":
    case "thinking":
    case "searching":
      return "working";
    case "approval":
    case "question":
      return "waiting";
    case "error":
      return "error";
    case "finished":
      return "finished";
    default:
      return "other";
  }
}

/** The waiting heartbeat, 0…1: two beats every 1.1 s, the second softer. */
export function heartbeat(t: number, c1 = 0.12, c2 = 0.36, w = 0.07): number {
  const u = mod(t, 1.1);
  const g = (c: number) => Math.exp(-(((u - c) / w) ** 2));
  return Math.max(g(c1), 0.75 * g(c2));
}

/** Where the ripple ring is, 0…1: it leaves on the first beat. */
export function ripplePhase(t: number): number {
  return mod((mod(t, 1.1) - 0.12) / 1.1, 1);
}

/** One pose: what the body does (units of R) and how its light shines. */
export interface StateMotion {
  /** 0…1: how brightly it shines. */
  shine: number;
  scale: number;
  /** Offset of the whole body, in units of R (the error's shake, the finish's hop). */
  dx: number;
  dy: number;
  /** 0…1: the "your turn" heartbeat. */
  pulse: number;
  /** 0…1: the ripple ring's strength, and its phase 0…1. */
  ripple: number;
  rp: number;
}

const REST: StateMotion = { scale: 1, dx: 0, dy: 0, shine: 0.5, pulse: 0, ripple: 0, rp: 0 };

/** The pose of `state`, `local` seconds after it began. */
export function stateMotion(state: BotStateName, local: number, t: number, amb: number): StateMotion {
  const m: StateMotion = { ...REST };
  const lit = Math.min(1, amb);
  switch (motionKind(state)) {
    case "idle": {
      // Breathing: a slow swell of the light and the body.
      const b = Math.sin((TAU * t) / 4.2);
      m.shine = 0.42 + 0.22 * b * lit;
      m.scale = 1 + 0.014 * b * amb;
      m.dy = -0.02 * b * amb;
      break;
    }
    case "working": {
      // A brighter, quicker pulse, bobbing as it goes.
      const ph = (TAU * t) / (state === "thinking" ? 2.2 : 1.5);
      m.shine = 0.78 + 0.2 * Math.sin(ph) * lit;
      m.scale = 1 + 0.015 * Math.sin(ph) * amb;
      m.dy = -0.07 * Math.sin(ph) * amb;
      break;
    }
    case "waiting": {
      // Two beats and a ripple, every 1.1 s, whatever the motion setting.
      m.pulse = heartbeat(t);
      m.shine = 0.55 + 0.45 * m.pulse;
      m.scale = 1 + 0.07 * m.pulse;
      m.dy = -0.04 * m.pulse;
      m.ripple = 1;
      m.rp = ripplePhase(t);
      break;
    }
    case "error": {
      // One shake that dies out in 0.6 s, a flash, then it sinks a little.
      const k = Math.max(0, 1 - local / 0.6);
      m.dx = Math.sin(local * TAU * 9) * 0.13 * k ** 1.2;
      m.shine = 0.36 + 0.64 * flashOf("error", local);
      m.scale = 1 - 0.03 * (1 - Math.exp(-local * 6));
      m.dy = 0.03 * (1 - Math.exp(-local * 6));
      break;
    }
    case "finished": {
      // A hop, a burst of light, then a soft glow.
      const h = hop(local);
      m.dy = -0.2 * h;
      m.shine = 0.62 + 0.08 * Math.sin((TAU * local) / 3) * lit + 0.35 * flashOf("finished", local);
      break;
    }
    default:
      switch (state) {
        case "ratelimit":
          m.shine = 0.3;
          m.dy = 0.03;
          break;
        case "sleeping":
          m.shine = 0.12;
          break;
        case "dizzy":
          m.shine = 0.6;
          break;
      }
  }
  return m;
}

/** The finish's hop, 0…1, over its first half second. */
export function hop(local: number): number {
  return local >= 0 && local < 0.5 ? Math.sin((Math.PI * local) / 0.5) : 0;
}

/** 1 → 0: the burst of light on an error (fast) or when it is done (slower). */
export function flashOf(state: BotStateName, local: number): number {
  const kind = motionKind(state);
  if (kind === "error") return Math.exp(-Math.max(0, local) * 5);
  if (kind === "finished") return Math.exp(-Math.max(0, local) * 3);
  return 0;
}

/**
 * How long what happens when `state` begins lasts (the shake, the hop, the
 * flash, the first sparkle): frames are asked for until then, whatever the
 * motion setting.
 */
export function settleTime(state: BotStateName): number {
  const kind = motionKind(state);
  return kind === "error" ? 1.0 : kind === "finished" ? 1.5 : 0;
}

/** Eases from the previous state's pose into the current one (k 0…1). */
export function blendMotion(a: StateMotion, b: StateMotion, k: number): StateMotion {
  if (k >= 1) return b;
  return {
    shine: lerp(a.shine, b.shine, k),
    scale: lerp(a.scale, b.scale, k),
    dx: lerp(a.dx, b.dx, k),
    dy: lerp(a.dy, b.dy, k),
    pulse: lerp(a.pulse, b.pulse, k),
    ripple: lerp(a.ripple, b.ripple, k),
    // A ripple on its way out keeps travelling as it fades.
    rp: a.ripple > 0 && b.ripple <= 0 ? a.rp : b.rp,
  };
}

/**
 * Done: ^^ for two seconds, then the usual eyes (that blink), smiling ^^ again
 * for 0.6 s every 2.6 s. With Lumo still (motion off) he keeps smiling.
 */
export function finishedSmiles(local: number, amb: number): boolean {
  if (amb <= 0 || local < 2.0) return true;
  return mod(local - 2.0, 2.6) > 2.0;
}

/**
 * Where Lumo's eyes look in a state, −1…1 (y down), or null to follow the
 * mouse: up at you when he waits, down at the floor on an error, up a little,
 * pleased, when he is done.
 */
export function stateGaze(state: BotStateName): number | null {
  switch (motionKind(state)) {
    case "waiting":
      return state === "approval" ? -0.72 : null;
    case "error":
      return 0.45;
    case "finished":
      return -0.25;
    default:
      return null;
  }
}
