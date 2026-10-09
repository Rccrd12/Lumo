// The launch greeting: a little light zips into the island and blooms into
// Lumo, who flutters, smiles, blinks, lights up blue and settles in the compact
// island. About 1.3 s, plus the 340 ms collapse. He blooms in his look: a round
// one (looks.ts) or the firefly.
// Everything is laid out in a 640×150 reference space.

import { closeCurve } from "../core/anim";
import { Sound } from "../core/sound";
import { COMPACT_BOT_X, COMPACT_W, NOTCH_H } from "../core/layout";
import {
  LUMO_BOTTOM, LUMO_EXP, LUMO_GLOW, LUMO_RX, LUMO_RY, LUMO_TOP, drawLumoBehind, drawLumoFront, type RGB,
} from "./lumo";
import {
  LOOK_IDLE, LOOK_SHAPE, drawLookBehind, drawLookBody, drawLookEyes, isRoundLook, lookBodyPath,
  type LookPose, type RoundLook,
} from "./looks";
import { DEFAULT_LOOK, type LumoLook } from "./wardrobe";

// ── Timing (seconds) ──────────────────────────────────────────────────────────

const T = {
  /** The light flies in. */
  fly1: 0.32,
  /** It blooms into Lumo. */
  bloom1: 0.6,
  /** A happy squint, then a blink. */
  happy0: 0.62,
  happy1: 0.86,
  blink: 0.95,
  /** The activity badge pops and he turns blue. */
  badge: 1.0,
  tint0: 0.95,
  tint1: 1.2,
  end: 1.3,
  autoLeave: 1.5,
  COLLAPSE: 0.34,
};

export const GREETING_END = T.end;

/** The greeting's own sound, played from the start (greeting.wav, made by scripts/gen-sounds.mjs). */
const GREETING_SOUND = "greeting";

// ── Geometry (640×150) ────────────────────────────────────────────────────────

export const GREETING_W = 640;
export const GREETING_H = 150;
const C0 = { x: 320, y: 88 };
const HB = 58;
/** Lumo's width over his height. */
export const ASP = LUMO_RX / LUMO_RY;
const EAR_HB = 17;
const CARD = { x: 10, y: 36, w: 620, h: 104 };
const CARD_R = 20;
/** Where the light comes from: out of the top of the island, looping in from the right. */
const SPARK0 = { x: C0.x - 30, y: 4 };
const SPARK_CTRL = { x: C0.x + 150, y: 36 };

/** The compact island the greeting lands in. */
const COMPACT = {
  width: COMPACT_W,
  height: NOTCH_H,
  botDiameter: Math.min(20, Math.max(0, NOTCH_H - 6)),
  botCenterY: NOTCH_H / 2,
};

// ── Easing ────────────────────────────────────────────────────────────────────

const E = {
  out: (t: number) => 1 - Math.pow(1 - t, 3),
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  back: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const seg = (t: number, a: number, b: number) => clamp((t - a) / (b - a), 0, 1);

// ── Pose ──────────────────────────────────────────────────────────────────────

type EyeType = "dot" | "happy";

export interface Pose {
  hb: number; x: number; y: number; sx: number; sy: number;
  eye: EyeType; open: number;
  badge: number; tint: number; halo: number; fx: number;
  /** The flying light: where it is and how bright (0 once he has bloomed). */
  sparkX: number; sparkY: number; spark: number;
  card: number;
}

/** The light's path into the island, k = 0…1. */
function sparkAt(k: number): { x: number; y: number } {
  const u = 1 - k;
  return {
    x: u * u * SPARK0.x + 2 * u * k * SPARK_CTRL.x + k * k * C0.x,
    y: u * u * SPARK0.y + 2 * u * k * SPARK_CTRL.y + k * k * C0.y,
  };
}

function greetPose(t: number): Pose {
  const fly = E.inOut(seg(t, 0, T.fly1));
  const s = sparkAt(fly);
  const bloom = seg(t, T.fly1 - 0.04, T.bloom1);
  // Body height: grows from the light with a back ease.
  const hb = t < T.fly1 - 0.04 ? 0 : lerp(HB * 0.12, HB, E.back(bloom));

  // Hovering: a gentle bob once he is out, wings buzzing (lumo.ts).
  const hover = seg(t, T.bloom1 - 0.1, T.bloom1 + 0.1);
  const y = C0.y + Math.sin((t - T.bloom1) * Math.PI * 2 * 1.6) * HB * 0.035 * hover;

  // A little pop of squash as he blooms.
  const popK = t >= T.bloom1 - 0.08 && t < T.bloom1 + 0.14 ? Math.sin(Math.PI * seg(t, T.bloom1 - 0.08, T.bloom1 + 0.14)) : 0;
  const sx = 1 + 0.08 * popK;
  const sy = 1 - 0.08 * popK;

  const eye: EyeType = t >= T.happy0 && t < T.happy1 ? "happy" : "dot";
  const bk = seg(t, T.blink, T.blink + 0.12);
  const open = bk > 0 && bk < 1 ? 1 - Math.sin(Math.PI * bk) * 0.94 : 1;

  return {
    hb, x: C0.x, y, sx, sy,
    eye, open,
    badge: E.back(seg(t, T.badge, T.badge + 0.22)),
    tint: 0.6 * E.inOut(seg(t, T.tint0, T.tint1)),
    halo: E.out(seg(t, T.fly1 - 0.05, T.bloom1)),
    fx: 1,
    sparkX: s.x,
    sparkY: s.y,
    spark: 1 - seg(t, T.fly1 - 0.02, T.fly1 + 0.12),
    card: seg(t, 0.04, 0.24),
  };
}

function smallPose(): Pose {
  return {
    hb: (EAR_HB * COMPACT.botDiameter) / 20,
    x: GREETING_W / 2 - COMPACT.width / 2 + COMPACT_BOT_X,
    y: COMPACT.botCenterY,
    sx: 1, sy: 1,
    eye: "dot", open: 1,
    badge: 1, tint: 0.6, halo: 0.6,
    fx: 1,
    sparkX: 0, sparkY: 0, spark: 0,
    card: 0,
  };
}

/** Lumo's pose `t` seconds in; `tc` is when the collapse began (∞ if not yet). */
export function greetingPose(t: number, tc = Number.POSITIVE_INFINITY): Pose {
  if (t < tc) return greetPose(Math.min(t, T.end + 10));
  const a = greetPose(tc);
  const b = smallPose();
  // Same curve and duration (340 ms) as the island shrinking around him, so
  // the island never gets ahead of him and cuts him off.
  const k = seg(t, tc, tc + T.COLLAPSE);
  const e = k >= 1 ? 1 : closeCurve(k);
  const p: Pose = { ...a };
  p.x = lerp(a.x, b.x, e);
  p.y = lerp(a.y, b.y, e);
  p.hb = lerp(a.hb, b.hb, e);
  p.badge = lerp(a.badge, b.badge, e);
  p.tint = lerp(a.tint, b.tint, e);
  p.halo = lerp(a.halo, b.halo, e);
  p.card = a.card * (1 - seg(t, tc, tc + 0.18));
  p.spark = a.spark * (1 - seg(t, tc, tc + 0.1));
  p.sx = lerp(a.sx, 1, e);
  p.sy = lerp(a.sy, 1, e);
  const bk = seg(t, tc + 0.14, tc + 0.26);
  p.eye = "dot";
  p.open = bk > 0 && bk < 1 ? 1 - Math.sin(Math.PI * bk) * 0.94 : 1;
  p.fx = 1 - seg(t, tc, tc + 0.2);
  return p;
}

/**
 * Bounding box of Lumo's body (and the firefly's glowing tail) in the 640×150
 * space — what must stay inside the island so nothing of him is cut off.
 */
export function lumoBounds(p: Pose, look: LumoLook = DEFAULT_LOOK): { left: number; right: number; top: number; bottom: number } | null {
  const hh = p.hb / 2;
  const hw = hh * ASP;
  if (hh <= 0.4) return null;
  const R = hh / LUMO_RY;
  if (isRoundLook(look)) {
    // The outline, and the half of Filo's ring that lies outside it.
    const s = LOOK_SHAPE[look];
    const rim = R * 0.06;
    return {
      left: p.x - (R * s.rx + rim) * p.sx,
      right: p.x + (R * s.rx + rim) * p.sx,
      top: p.y + (R * (s.dy - s.top) - rim) * p.sy,
      bottom: p.y + (R * (s.dy + s.bottom) + rim) * p.sy,
    };
  }
  const bottom = Math.max(hh, hh * 0.98 + R * 0.44);
  return {
    left: p.x - hw * p.sx,
    right: p.x + hw * p.sx,
    top: p.y - hh * p.sy,
    bottom: p.y + bottom * p.sy,
  };
}

// ── Particles (seeded, so every launch is the same) ───────────────────────────

interface Mote { a: number; d: number; s: number; al: number; t0: number }

const MOTES: Mote[] = (() => {
  let seed = 11;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  return Array.from({ length: 18 }, () => ({
    a: rnd() * Math.PI * 2,
    d: 0.9 + rnd() * 1.1,
    s: 1.2 + rnd() * 1.6,
    al: 0.5 + rnd() * 0.5,
    t0: T.fly1 + rnd() * 0.12,
  }));
})();

// ── Drawing ───────────────────────────────────────────────────────────────────

function rr(x: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, R: number) {
  const r = Math.max(0, Math.min(R, W / 2, H / 2));
  x.beginPath();
  x.moveTo(X + r, Y);
  x.arcTo(X + W, Y, X + W, Y + H, r);
  x.arcTo(X + W, Y + H, X, Y + H, r);
  x.arcTo(X, Y + H, X, Y, r);
  x.arcTo(X, Y, X + W, Y, r);
  x.closePath();
}

function lumoPath(hw: number, hh: number): Path2D {
  const n = LUMO_EXP;
  const p = new Path2D();
  const steps = 96;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const px = hw * (ca < 0 ? -1 : 1) * Math.pow(Math.abs(ca), 2 / n);
    const py = hh * (sa < 0 ? -1 : 1) * Math.pow(Math.abs(sa), 2 / n);
    if (i === 0) p.moveTo(px, py);
    else p.lineTo(px, py);
  }
  p.closePath();
  return p;
}

const css = (c: RGB, a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
/** The blue he takes on at the end of the greeting, as on the island. */
const GREET_BLUE: RGB = [127 / 255, 180 / 255, 234 / 255];

/** The light he is made of: the firefly's yellow-green, or a round look's warm glow. */
const restLight = (look: LumoLook): RGB => (isRoundLook(look) ? LOOK_IDLE : LUMO_GLOW);

function glowColor(p: Pose, look: LumoLook): RGB {
  const k = Math.min(1, p.tint / 0.5);
  const from = restLight(look);
  return [
    from[0] + (GREET_BLUE[0] - from[0]) * k,
    from[1] + (GREET_BLUE[1] - from[1]) * k,
    from[2] + (GREET_BLUE[2] - from[2]) * k,
  ];
}

/** The light flying in, with a short fading trail. */
function drawSpark(x: CanvasRenderingContext2D, t: number, p: Pose, look: LumoLook) {
  if (p.spark <= 0.01) return;
  for (let i = 6; i >= 0; i--) {
    const tt = t - i * 0.018;
    if (tt < 0) continue;
    const s = sparkAt(E.inOut(seg(tt, 0, T.fly1)));
    const k = 1 - i / 7;
    const r = 2 + 4 * k;
    const g = x.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 3);
    g.addColorStop(0, css(restLight(look), 0.8 * k * p.spark));
    g.addColorStop(1, css(restLight(look), 0));
    x.fillStyle = g;
    x.beginPath();
    x.arc(s.x, s.y, r * 3, 0, Math.PI * 2);
    x.fill();
  }
  x.fillStyle = `rgba(255,255,240,${p.spark})`;
  x.beginPath();
  x.arc(p.sparkX, p.sparkY, 3, 0, Math.PI * 2);
  x.fill();
}

/** Little motes of light thrown out as he blooms. */
function drawMotes(x: CanvasRenderingContext2D, t: number, p: Pose, look: LumoLook) {
  for (const m of MOTES) {
    const k = seg(t, m.t0, m.t0 + 0.6);
    if (k <= 0 || k >= 1) continue;
    const d = HB * m.d * E.out(k);
    const mx = C0.x + Math.cos(m.a) * d * 1.4;
    const my = C0.y + Math.sin(m.a) * d * 0.7;
    x.fillStyle = css(restLight(look), m.al * (1 - k) * p.fx);
    x.beginPath();
    x.arc(mx, my, m.s * (1 - k * 0.5), 0, Math.PI * 2);
    x.fill();
  }
}

/** His own light, two passes for a soft aura. */
function drawHalo(x: CanvasRenderingContext2D, p: Pose, hw: number, glow: RGB) {
  if (p.halo > 0) {
    for (const [R, alpha] of [[hw * 2.4, 0.16], [hw * 3.8, 0.06]] as const) {
      const g = x.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
      g.addColorStop(0, css(glow, alpha * p.halo));
      g.addColorStop(1, css(glow, 0));
      x.fillStyle = g;
      x.beginPath();
      x.arc(p.x, p.y, R, 0, Math.PI * 2);
      x.fill();
    }
  }
}

/** The activity badge, popping at his top left. */
function drawBadge(x: CanvasRenderingContext2D, p: Pose, hw: number, hh: number) {
  if (p.badge <= 0.01) return;
  const br = hh * 0.3;
  x.save();
  x.translate(-hw * 0.78, -hh * 0.72);
  x.scale(p.badge, p.badge);
  x.fillStyle = "#000";
  x.beginPath();
  x.arc(0, 0, br + hh * 0.07, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = "#3BA0F5";
  x.beginPath();
  x.arc(0, 0, br, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = "#0B1B3A";
  for (const i of [-1, 0, 1]) {
    x.beginPath();
    x.arc(i * br * 0.5, 0, br * 0.17, 0, Math.PI * 2);
    x.fill();
  }
  x.restore();
}

/** A round look blooming: its light, its outline and its eyes (looks.ts). */
function drawRound(x: CanvasRenderingContext2D, p: Pose, t: number, look: RoundLook) {
  const hh = p.hb / 2;
  if (hh <= 0.4) return;
  const R = hh / LUMO_RY;
  const hw = R * LOOK_SHAPE[look].rx;
  const c = glowColor(p, look);
  drawHalo(x, p, hw, c);

  x.save();
  x.translate(p.x, p.y);
  x.scale(p.sx, p.sy);
  const P: LookPose = {
    R, t, c, shine: 0.4 + 0.5 * p.halo, pulse: 0, ripple: 0, rp: 0, small: R < 20, presence: 1,
  };
  drawLookBehind(x, look, P);
  drawLookBody(x, look, P, lookBodyPath(look, R));
  drawLookEyes(x, look, P, {
    shape: p.eye === "happy" ? "happy" : "pill", lx: 0, ly: 0, open: p.open, es: 1, roll: 0, morph: 0,
  });
  drawBadge(x, p, hw, R * LOOK_SHAPE[look].top);
  x.restore();
}

function drawLumo(x: CanvasRenderingContext2D, p: Pose, t: number) {
  const hh = p.hb / 2;
  const hw = hh * ASP;
  if (hh <= 0.4) return;
  const glow = glowColor(p, "lucciola");
  drawHalo(x, p, hw, glow);

  x.save();
  x.translate(p.x, p.y);
  x.scale(p.sx, p.sy);

  const lumo = {
    R: hh / LUMO_RY,
    rx: hw,
    ry: hh,
    t,
    glow,
    shine: 0.5 + 0.5 * p.halo,
    flap: 1,
    lagX: 0,
    lagY: 0,
    presence: 1,
  };
  drawLumoBehind(x, lumo);

  const body = lumoPath(hw, hh);
  const g = x.createLinearGradient(hw * 0.6, -hh, -hw * 0.6, hh);
  g.addColorStop(0, css(LUMO_TOP));
  g.addColorStop(1, css(LUMO_BOTTOM));
  x.fillStyle = g;
  x.fill(body);

  if (p.tint > 0) {
    const tg = x.createLinearGradient(0, hh, 0, -hh * 0.1);
    tg.addColorStop(0, `rgba(127,180,234,${p.tint * 0.4})`);
    tg.addColorStop(1, "rgba(127,180,234,0)");
    x.fillStyle = tg;
    x.fill(body);
  }

  // Eyes
  x.save();
  x.clip(body);
  x.fillStyle = "#16171A";
  x.strokeStyle = "#16171A";
  const er = p.hb * 0.078;
  const sp = p.hb * 0.21;
  const ly = hh * 0.1;
  for (const sd of [-1, 1]) {
    x.save();
    x.translate(sd * sp, ly);
    if (p.eye === "happy") {
      x.lineWidth = er * 0.95;
      x.lineCap = "round";
      x.beginPath();
      x.arc(0, er * 0.6, er * 1.25, Math.PI * 1.15, Math.PI * 1.85);
      x.stroke();
    } else {
      x.scale(1, Math.max(0.12, p.open));
      x.beginPath();
      x.arc(0, 0, er, 0, Math.PI * 2);
      x.fill();
      if (p.open > 0.6) {
        // The sparkle in his eyes, as on the island.
        x.fillStyle = "rgba(255,255,255,0.92)";
        x.beginPath();
        x.arc(er * 0.3, -er * 0.4, er * 0.4, 0, Math.PI * 2);
        x.fill();
        x.fillStyle = "#16171A";
      }
    }
    x.restore();
  }
  x.restore();
  drawLumoFront(x, lumo);
  drawBadge(x, p, hw, hh);

  x.restore();
}

// ── Controller ────────────────────────────────────────────────────────────────

/**
 * Runs the greeting animation on its own canvas. `onComplete` fires once at
 * T.end (or right after the collapse when interrupted) so the FSM can move on.
 */
export class Greeting {
  private startMs = 0;
  private tc = Number.POSITIVE_INFINITY;
  private fired = false;
  private timers: number[] = [];

  onComplete: (() => void) | null = null;
  /** The look he blooms in; the island sets it. */
  look: LumoLook = DEFAULT_LOOK;

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

  draw(x: CanvasRenderingContext2D) {
    const t = this.elapsed;
    if (!this.fired && t >= T.end && this.tc >= T.autoLeave) this.fire();

    const p = greetingPose(t, this.tc);
    x.clearRect(0, 0, GREETING_W, GREETING_H);

    if (p.card > 0) {
      x.save();
      x.globalAlpha = p.card;
      rr(x, CARD.x, CARD.y, CARD.w, CARD.h, CARD_R);
      x.fillStyle = "#141518";
      x.fill();
      x.restore();

      x.save();
      rr(x, CARD.x, CARD.y, CARD.w, CARD.h, CARD_R);
      x.clip();
      drawMotes(x, t, p, this.look);
      x.restore();
    }

    drawSpark(x, t, p, this.look);
    if (isRoundLook(this.look)) drawRound(x, p, t, this.look);
    else drawLumo(x, p, t);
  }
}
