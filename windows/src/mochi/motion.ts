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

import type { BotStateName } from "../core/layout";

const TAU = Math.PI * 2;

export const ease = (k: number) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const mod = (v: number, m: number) => ((v % m) + m) % m;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

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
  /** −1…1: Goccia's stretch (−) and squash (+) on its flat base. */
  squash: number;
  /** 0…1: the "your turn" heartbeat. */
  pulse: number;
  /** 0…1: the ripple ring's strength, and its phase 0…1. */
  ripple: number;
  rp: number;
}

const REST: StateMotion = { scale: 1, dx: 0, dy: 0, squash: 0, shine: 0.5, pulse: 0, ripple: 0, rp: 0 };

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
      m.squash = -0.5 * Math.sin(ph) * amb;
      break;
    }
    case "waiting": {
      // Two beats and a ripple, every 1.1 s, whatever the motion setting.
      m.pulse = heartbeat(t);
      m.shine = 0.55 + 0.45 * m.pulse;
      m.scale = 1 + 0.07 * m.pulse;
      m.dy = -0.04 * m.pulse;
      m.squash = -0.5 * m.pulse;
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
      // A hop, a squash on landing, a burst of light, then a soft glow.
      const h = hop(local);
      const land = local > 0.45 && local < 0.75 ? Math.sin((Math.PI * (local - 0.45)) / 0.3) : 0;
      m.dy = -0.2 * h;
      m.squash = -0.6 * h + 0.8 * land;
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
    squash: lerp(a.squash, b.squash, k),
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

// ── The firefly's antenna lights (Lucciola) ───────────────────────────────────

/** The two lights at his antennae's tips: spread and lift (units of R), brightness, sparkle. */
export interface TipLights {
  /** Spread outwards and offset downwards, in units of R. */
  sx: number;
  sy: number;
  /** 0…1, left then right. */
  a: [number, number];
  /** 0…1: the four-point sparkle when he is done. */
  sp: number;
}

export const TIPS_REST: TipLights = { sx: 0, sy: 0, a: [1, 1], sp: 0 };

/**
 * They twinkle in turn at rest, twinkle quickly and trail the bob while an
 * agent works, perk up with the heartbeat when he waits, droop and dim on an
 * error, and sparkle when he is done.
 */
export function tipLights(state: BotStateName, local: number, t: number, amb: number): TipLights {
  const lit = Math.min(1, amb);
  switch (motionKind(state)) {
    case "idle": {
      const tw = Math.sin((TAU * t) / 3.1) * lit;
      return { sx: 0, sy: 0.03 * Math.sin((TAU * t) / 4.2 - 1) * lit, a: [0.75 + 0.25 * tw, 0.75 - 0.25 * tw], sp: 0 };
    }
    case "working": {
      const ph = (TAU * t) / (state === "thinking" ? 2.2 : 1.5);
      const tw = Math.sin(t * 7) * lit;
      return { sx: 0, sy: -0.06 * Math.sin(ph - 0.9) * lit, a: [0.7 + 0.3 * tw, 0.7 - 0.3 * tw], sp: 0 };
    }
    case "waiting": {
      const p = heartbeat(t, 0.16, 0.4, 0.08);
      return { sx: 0.08 * p, sy: -0.1 * p, a: [0.55 + 0.45 * p, 0.55 + 0.45 * p], sp: 0 };
    }
    case "error":
      return { sx: 0.12, sy: 0.15, a: [0.4, 0.4], sp: 0 };
    case "finished": {
      // Every 2.6 s while he moves on his own; only the first one otherwise.
      const u = amb > 0 ? mod(local, 2.6) : local;
      return { sx: 0.04, sy: -0.04, a: [1, 1], sp: Math.exp(-(((u - 0.35) / 0.18) ** 2)) };
    }
    default:
      return { ...TIPS_REST, a: [1, 1] };
  }
}

export function blendTips(a: TipLights, b: TipLights, k: number): TipLights {
  if (k >= 1) return b;
  return {
    sx: lerp(a.sx, b.sx, k),
    sy: lerp(a.sy, b.sy, k),
    a: [lerp(a.a[0], b.a[0], k), lerp(a.a[1], b.a[1], k)],
    sp: b.sp * k,
  };
}

// ── Goccia's pool of light ────────────────────────────────────────────────────

/**
 * The pool of light under Goccia stays on the floor while the drop moves: it
 * shrinks and fades as the drop lifts (`dy` < 0, units of R). Its radius and
 * strength, as factors of the pool at rest.
 */
export function poolOfLight(dy: number): { lift: number; r: number; a: number } {
  const lift = clamp01(-dy * 3);
  return { lift, r: (1.05 - 0.25 * lift) / 1.05, a: 1 - 0.5 * lift };
}
