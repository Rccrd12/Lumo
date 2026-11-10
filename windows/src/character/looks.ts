// Lumo as he looks: Filo, a ring of light with lit eyes (variant 05 of the
// "Punto" concept), drawn in code. The agents' minis are lumo.ts.
//
// Body space as in engine.ts: origin at the body centre, y down, R the size
// unit (the engine's R = W × 0.3). The light takes the state's colour: warm at
// rest, blue while an agent works, orange when it waits for you, red on an
// error, green when it is done.

import { lerp } from "../core/anim";
import { rgba, type RGB } from "./lumo";
import { ease } from "./motion";

/** The light at rest: a warm glow (#FFE09E). */
export const LOOK_IDLE: RGB = [1, 0.88, 0.62];
const WHITE: RGB = [1, 1, 1];
const TAU = Math.PI * 2;

/** The eyes: centre (± x, y) and size, in units of R. */
export const LOOK_EYES = { x: 0.3, y: -0.02, w: 0.19, h: 0.4 } as const;

export interface LookPose {
  R: number;
  /** Seconds, for the spiral and star eyes. */
  t: number;
  /** The light's colour. */
  c: RGB;
  /** 0…1: how brightly it shines. */
  shine: number;
  /** 0…1: the "your turn" heartbeat. */
  pulse: number;
  /** 0…1: the ripple ring's strength, and its phase 0…1. */
  ripple: number;
  rp: number;
  /** The closed island's sizes: lines get a floor so they still read. */
  small: boolean;
  /** 0…1: the halo and the ripple fade with it (the drop sequence's box). */
  presence: number;
}

export const mixRGB = (a: RGB, b: RGB, k: number): RGB => [
  a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k,
];


/** How much the canvas is scaled: shadows are not, so their blur is scaled by hand. */
export function pxScale(x: CanvasRenderingContext2D): number {
  const m = typeof x.getTransform === "function" ? x.getTransform() : null;
  return m ? Math.hypot(m.a, m.b) || 1 : 1;
}

// ── Outline ───────────────────────────────────────────────────────────────────

/**
 * The ring's outline, a circle of radius R. With `morph` > 0 each point slides
 * towards `box(ca, sa)` (the drop sequence turns him into a box).
 */
export function lookBodyPath(
  R: number, morph = 0,
  box?: (ca: number, sa: number) => { x: number; y: number },
): Path2D {
  const p = new Path2D();
  const n = 72;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * TAU;
    let px = R * Math.cos(a);
    let py = R * Math.sin(a);
    if (box && morph >= 0.005) {
      const b = box(Math.cos(a), Math.sin(a));
      px = lerp(px, b.x, morph);
      py = lerp(py, b.y, morph);
    }
    if (i === 0) p.moveTo(px, py);
    else p.lineTo(px, py);
  }
  p.closePath();
  return p;
}

// ── Light ─────────────────────────────────────────────────────────────────────

function halo(x: CanvasRenderingContext2D, cx: number, cy: number, r: number, c: RGB, a: number) {
  if (a <= 0.003 || r <= 0) return;
  const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, rgba(c, a));
  g.addColorStop(0.45, rgba(c, a * 0.4));
  g.addColorStop(1, rgba(c, 0));
  x.fillStyle = g;
  x.beginPath();
  x.arc(cx, cy, r, 0, TAU);
  x.fill();
}

/** An expanding ring of light: the insistent "your turn" ripple. */
function ripple(x: CanvasRenderingContext2D, P: LookPose, r0: number, r1: number, cy: number) {
  if (P.ripple <= 0.01 || P.presence <= 0.01) return;
  const k = P.rp;
  const a = 0.55 * Math.pow(1 - k, 1.6) * P.ripple * P.presence;
  if (a <= 0.003) return;
  x.strokeStyle = rgba(mixRGB(P.c, WHITE, 0.2), a);
  x.lineWidth = Math.max(1, P.R * 0.07 * (1 - k * 0.5));
  x.beginPath();
  x.arc(0, cy, P.R * lerp(r0, r1, ease(k)), 0, TAU);
  x.stroke();
}

/** What shines around him, drawn before the body: the ripple and the halo. */
export function drawLookBehind(x: CanvasRenderingContext2D, P: LookPose) {
  const { R } = P;
  x.save();
  ripple(x, P, 1.05, 1.75, 0);
  halo(x, 0, 0, R * 1.3, P.c, (0.08 + 0.2 * P.shine) * P.presence);
  x.restore();
}

/** The body: a ring of light, a faint glow filling it. */
export function drawLookBody(x: CanvasRenderingContext2D, P: LookPose, body: Path2D) {
  const { R, c } = P;
  x.save();
  const lw = Math.max(P.small ? 1.8 : 1.4, R * 0.11);
  // A faint glow filling the ring, brighter at the rim.
  const ig = x.createRadialGradient(0, 0, 0, 0, 0, R);
  ig.addColorStop(0, rgba(c, 0.04 + 0.06 * P.shine));
  ig.addColorStop(0.75, rgba(c, 0.08 + 0.1 * P.shine));
  ig.addColorStop(1, rgba(c, 0.2 + 0.2 * P.shine));
  x.fillStyle = ig;
  x.fill(body);
  x.strokeStyle = rgba(mixRGB(c, WHITE, 0.3 + 0.2 * P.shine));
  x.lineWidth = lw;
  x.lineJoin = "round";
  x.shadowColor = rgba(c, 0.9);
  x.shadowBlur = Math.max(4, R * 0.32) * (0.6 + 0.7 * P.shine) * pxScale(x);
  x.stroke(body);
  x.restore();
}

/** Rosy cheeks (love, proud, happy), under the eyes. */
export function drawLookBlush(x: CanvasRenderingContext2D, P: LookPose, body: Path2D, v: number) {
  if (v <= 0.01) return;
  const { R } = P;
  x.save();
  x.clip(body);
  x.fillStyle = `rgba(255,120,150,${0.42 * v})`;
  for (const sd of [-1, 1]) {
    x.beginPath();
    x.ellipse(sd * R * 0.56, R * (LOOK_EYES.y + 0.26), R * 0.16, R * 0.09, 0, 0, TAU);
    x.fill();
  }
  x.restore();
}

// ── Eyes ──────────────────────────────────────────────────────────────────────

/** The engine's eye shapes (engine.ts EyeShape), plus the drop sequence's "content". */
export type LookEyeShape =
  | "pill" | "wide" | "dot" | "line" | "flat" | "happy" | "closed"
  | "spiral" | "heart" | "star" | "tired" | "wink" | "cup" | "content";

export interface LookEyes {
  shape: LookEyeShape;
  /** Where they look, −1…1 (x right, y down). */
  lx: number;
  ly: number;
  /** 0 = shut (a blink), 1 = open. */
  open: number;
  /** Size multiplier (surprised, hovering). */
  es: number;
  /** Turned round the centre (the dizzy roll). */
  roll: number;
  /** The drop sequence's box: the eyes move down a little. */
  morph: number;
}

/** Where each eye's centre is, in body space. */
export function lookEyeCentres(R: number, e: Pick<LookEyes, "lx" | "ly" | "morph">): { x: number; y: number }[] {
  const o = LOOK_EYES;
  const ox = e.lx * 0.1 * R;
  const oy = e.ly * 0.075 * R + e.morph * 0.2 * R;
  return [-1, 1].map((sd) => ({ x: sd * o.x * R + ox, y: o.y * R + oy }));
}

/** The eyes' ink: lit, a paler shade of the light. */
export function lookInk(c: RGB): string {
  return rgba(mixRGB(c, WHITE, 0.62));
}

export function drawLookEyes(x: CanvasRenderingContext2D, P: LookPose, e: LookEyes) {
  const { R } = P;
  const o = LOOK_EYES;
  const w = Math.max(o.w * R * e.es, P.small ? 2.2 : 0);
  const h = Math.max(o.h * R * e.es, P.small ? 4.6 : 0);
  const ink = lookInk(P.c);
  const blur = Math.max(3, w * 1.1) * pxScale(x);
  const centres = lookEyeCentres(R, e);
  x.save();
  if (Math.abs(e.roll) > 0.001) x.rotate(e.roll);
  centres.forEach((c, i) => {
    const sd = i === 0 ? -1 : 1;
    x.save();
    x.translate(c.x, c.y);
    x.fillStyle = ink;
    x.strokeStyle = ink;
    x.shadowColor = ink;
    x.shadowBlur = blur;
    drawLookEye(x, e.shape, w, h, sd, e.open, P, ink);
    x.restore();
  });
  x.restore();
}

/** One eye, at the origin, `w` × `h` (the open pill's size). */
export function drawLookEye(
  x: CanvasRenderingContext2D, shape: LookEyeShape, w: number, h: number, sd: number,
  open: number, P: Pick<LookPose, "R" | "t" | "small">, ink: string,
) {
  const R = P.R;
  const sm = P.small;
  switch (shape) {
    case "wide": {
      const ww = w * 1.14;
      const hh = Math.max(ww * 0.5, h * 1.12 * open);
      rrect(x, -ww / 2, -hh / 2, ww, hh, ww / 2);
      x.fill();
      break;
    }
    case "dot": {
      // Surprised: round open eyes.
      x.scale(1, Math.max(0.15, open));
      x.beginPath();
      x.arc(0, 0, Math.max(w * 0.72, sm ? 1.6 : 0), 0, TAU);
      x.fill();
      break;
    }
    case "line":
      // Annoyed: two slanted bars.
      x.rotate(-sd * 0.22);
      rrect(x, -w * 0.85, -w * 0.24, w * 1.7, Math.max(w * 0.48, sm ? 1.5 : 0), w * 0.24);
      x.fill();
      break;
    case "flat": {
      // An error: × eyes, the one look nobody misreads, even at 28 px.
      const a = Math.max(sm ? 1.9 : 0, w * 0.62);
      x.lineWidth = Math.max(sm ? 1.4 : 0, w * 0.42);
      x.lineCap = "round";
      x.beginPath();
      x.moveTo(-a, -a); x.lineTo(a, a);
      x.moveTo(a, -a); x.lineTo(-a, a);
      x.stroke();
      break;
    }
    case "happy":
      // ^^
      x.lineWidth = Math.max(sm ? 1.5 : 0, w * 0.5);
      x.lineCap = "round";
      x.beginPath();
      x.arc(0, h * 0.2, w * 0.85, Math.PI * 1.12, Math.PI * 1.88);
      x.stroke();
      break;
    case "closed":
    case "content":
      // Asleep, or content: a soft arc down.
      x.lineWidth = Math.max(sm ? 1.3 : 0, w * 0.42);
      x.lineCap = "round";
      x.beginPath();
      x.arc(0, -h * 0.12, w * 0.8, Math.PI * 0.15, Math.PI * 0.85);
      x.stroke();
      break;
    case "spiral": {
      const u = R * 0.26;
      x.lineWidth = Math.max(1, u * 0.24);
      x.lineCap = "round";
      x.beginPath();
      for (let a = 0; a < 4.4 * Math.PI; a += 0.2) {
        const r = u * (0.07 + a * 0.066);
        const aa = a + P.t * 9 * sd;
        if (a === 0) x.moveTo(Math.cos(aa) * r, Math.sin(aa) * r);
        else x.lineTo(Math.cos(aa) * r, Math.sin(aa) * r);
      }
      x.stroke();
      break;
    }
    case "heart":
      x.fillStyle = "#FF4D6D";
      if (x.shadowBlur > 0) x.shadowColor = "rgba(255,77,109,0.9)";
      heartPath(x, Math.max(R * 0.3, sm ? 2.6 : 0));
      x.fill();
      x.fillStyle = ink;
      break;
    case "star":
      x.fillStyle = "#F7B32B";
      if (x.shadowBlur > 0) x.shadowColor = "rgba(247,179,43,0.9)";
      x.rotate(P.t * 1.5 * sd);
      starPath(x, Math.max(R * 0.28, sm ? 2.6 : 0), Math.max(R * 0.125, sm ? 1.2 : 0));
      x.fill();
      x.fillStyle = ink;
      break;
    case "tired":
      // Heavy lids: the lower half of the eye under a flat lid.
      rrect(x, -w / 2, -h * 0.02, w, h * 0.4, w / 2);
      x.fill();
      rrect(x, -w * 0.66, -h * 0.12, w * 1.32, Math.max(w * 0.3, sm ? 1.2 : 0), w * 0.15);
      x.fill();
      break;
    case "wink":
      if (sd < 0) {
        drawLookEye(x, "pill", w, h, sd, open, P, ink);
      } else {
        drawLookEye(x, "happy", w, h, sd, open, P, ink);
      }
      break;
    case "cup": {
      // Flat top, round bottom: while the box is open for a file.
      const hh = Math.max(h * open, w * 0.42);
      const cr = Math.min(w / 2, hh / 2);
      x.beginPath();
      x.moveTo(-w / 2, -hh / 2);
      x.lineTo(w / 2, -hh / 2);
      x.lineTo(w / 2, hh / 2 - cr);
      x.quadraticCurveTo(w / 2, hh / 2, w / 2 - cr, hh / 2);
      x.lineTo(-w / 2 + cr, hh / 2);
      x.quadraticCurveTo(-w / 2, hh / 2, -w / 2, hh / 2 - cr);
      x.closePath();
      x.fill();
      break;
    }
    default: {
      // The pill: two slits that blink.
      const hh = Math.max(w * 0.42, h * open);
      rrect(x, -w / 2, -hh / 2, w, hh, w / 2);
      x.fill();
    }
  }
}

// ── Paths ─────────────────────────────────────────────────────────────────────

function rrect(x: CanvasRenderingContext2D, X: number, Y: number, W: number, H: number, r: number) {
  const rr = Math.max(0, Math.min(r, W / 2, H / 2));
  x.beginPath();
  x.moveTo(X + rr, Y);
  x.arcTo(X + W, Y, X + W, Y + H, rr);
  x.arcTo(X + W, Y + H, X, Y + H, rr);
  x.arcTo(X, Y + H, X, Y, rr);
  x.arcTo(X, Y, X + W, Y, rr);
  x.closePath();
}

export function heartPath(x: CanvasRenderingContext2D, s: number) {
  x.beginPath();
  x.moveTo(0, s * 0.38);
  x.bezierCurveTo(-s * 1.05, -s * 0.15, -s * 0.5, -s * 0.95, 0, -s * 0.38);
  x.bezierCurveTo(s * 0.5, -s * 0.95, s * 1.05, -s * 0.15, 0, s * 0.38);
  x.closePath();
}

export function starPath(x: CanvasRenderingContext2D, ro: number, ri: number) {
  x.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? ri : ro;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    x.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  x.closePath();
}
