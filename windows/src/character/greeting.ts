// The launch greeting: Lumo is the island's light, so it is that light coming
// on. A spark on the edge of the screen stretches into a line, the island
// unrolls under it and his eyes open in the middle and smile; about 1.3 s,
// plus the 340 ms collapse when the mouse leaves first. The island draws it
// (island.ts, lightGreetFrame); this times it and plays its sound.

import { lerp, seg } from "../core/anim";
import { Sound } from "../core/sound";

// ── Timing (seconds) ──────────────────────────────────────────────────────────

const T = {
  end: 1.3,
  COLLAPSE: 0.34,
};

export const GREETING_END = T.end;

/** The opening's sound, lined up with it (greeting-light.wav, made by scripts/gen-sounds.mjs). */
const GREETING_SOUND = "greeting-light";

// ── Easing ────────────────────────────────────────────────────────────────────

const E = {
  out: (t: number) => 1 - Math.pow(1 - t, 3),
  back: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

// ── The opening ───────────────────────────────────────────────────────────────

/** What the opening shows at one moment: the island itself and Lumo's eyes in it. */
export interface LightGreetFrame {
  /** The island's size and corner, in page pixels. */
  w: number;
  h: number;
  r: number;
  /** How much of the island is still light (1: a spark, a line; 0: its black body). */
  spark: number;
  /** His eyes' size, 0…1 (0: not there yet). */
  eyes: number;
}

/**
 * Lumo is the island's light and his eyes, so the opening is that light
 * coming on (concept A). A spark on the edge of the screen stretches into a
 * line, the island unrolls under it, his eyes open in the middle and smile; at
 * T.end it folds into the closed island like any other view.
 */
export function lightGreetFrame(t: number, compactW: number): LightGreetFrame {
  const bigW = compactW + 72;
  const bigH = 64;
  const sparkK = E.back(seg(t, 0, 0.22));
  const stretch = E.out(seg(t, 0.18, 0.5));
  const unroll = seg(t, 0.44, 0.86);
  // A soft spring as it unrolls: a touch past, then back.
  const sp = unroll >= 1 ? 1 : 1 - Math.exp(-6 * unroll) * Math.cos(10 * unroll);
  let w: number;
  let h: number;
  if (t < 0.18) {
    w = h = lerp(2, 10, sparkK);
  } else {
    w = lerp(10, bigW, stretch);
    h = unroll > 0 ? lerp(3, bigH, sp) : lerp(10, 3, stretch);
  }
  const r = Math.min(h / 2, 22);
  const spark = 1 - E.out(seg(t, 0.46, 0.6));
  const eyes = E.back(seg(t, 0.72, 0.9));
  return { w, h, r, spark, eyes };
}

/** When the opening smiles (the island sends the emote). */
export const LIGHT_GREET_SMILE = 0.96;

// ── Controller ────────────────────────────────────────────────────────────────

/**
 * Times the opening (the island draws it, island.ts lightGreetFrame) and plays
 * its sound. `onComplete` fires once at T.end (or right after the collapse
 * when interrupted) so the FSM can move on.
 */
export class Greeting {
  private startMs = 0;
  private tc = Number.POSITIVE_INFINITY;
  private fired = false;
  private timers: number[] = [];

  onComplete: (() => void) | null = null;

  start() {
    this.startMs = performance.now();
    this.tc = Number.POSITIVE_INFINITY;
    this.fired = false;
    this.cancelTimers();
    // The sound plays from the start; it fades when the greeting view goes away (see leave()).
    Sound.play(GREETING_SOUND);
    this.timers.push(window.setTimeout(() => this.fire(), (T.end + 0.05) * 1000));
  }

  /** Mouse left — collapse from now. */
  interrupt() {
    const t = (performance.now() - this.startMs) / 1000;
    if (!Number.isFinite(this.tc) || this.tc > t) this.tc = t;
    this.cancelTimers();
    // This one fires when the collapse is over (leave() follows at once, so
    // not in `timers`).
    const started = this.startMs;
    if (!this.fired) window.setTimeout(() => this.startMs === started && this.fire(), T.COLLAPSE * 1000);
    Sound.fadeOut(GREETING_SOUND, 0.25);
  }

  /** The greeting view is gone: let what is left of its sound fade away. */
  leave() {
    this.cancelTimers();
    Sound.fadeOut(GREETING_SOUND, 0.2);
  }

  get elapsed(): number {
    return (performance.now() - this.startMs) / 1000;
  }

  get done(): boolean {
    return this.fired;
  }

  private fire() {
    if (this.fired) return;
    this.fired = true;
    this.cancelTimers();
    this.onComplete?.();
  }

  private cancelTimers() {
    this.timers.forEach((id) => window.clearTimeout(id));
    this.timers = [];
  }
}
