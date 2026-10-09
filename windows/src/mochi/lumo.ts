// Lumo as a little firefly (Lucciola, one of his looks in the wardrobe; his
// round looks are looks.ts): what makes him one — the glowing tail under him,
// the two wings behind, the antennae on top. Drawn around the body that
// engine.ts (and the launch greeting) draws, in its body space: origin at the
// body centre, y down, R the body's size unit, rx/ry its half width/height.

import { TIPS_REST, ease, type TipLights } from "./motion";

export type RGB = readonly [number, number, number]; // components 0…1

/**
 * His body: a round little ball, a touch taller than wide. Half width and half
 * height in units of R, and the superellipse exponent of its outline (2 would
 * be a true ellipse). The engine, the outfits, the greeting and the drop
 * sequence all draw this same shape.
 */
export const LUMO_RX = 1.0;
export const LUMO_RY = 0.96;
export const LUMO_EXP = 2.2;
/** His eyes: big and round, set a little apart and low (units of R, radians). */
export const LUMO_EYE = { w: 0.3, h: 0.33, spread: 0.42, pitch: -0.1 } as const;

/** His body: warm butter, lighter at the top. */
export const LUMO_TOP: RGB = [1, 0.965, 0.847]; // #FFF6D8
export const LUMO_BOTTOM: RGB = [0.953, 0.851, 0.541]; // #F3D98A
/** His light when nothing is going on: a soft firefly yellow-green. */
export const LUMO_GLOW: RGB = [0.851, 1, 0.42]; // #D9FF6B
const INK = "rgb(26,20,18)";

const rgba = (c: RGB, a = 1) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

export interface LumoPose {
  R: number;
  rx: number;
  ry: number;
  /** Seconds, for the flutter and the pulse. */
  t: number;
  /** The light's colour: his glow, or the state's colour while he works. */
  glow: RGB;
  /** 0…1: how strongly the tail shines (brighter while busy). */
  shine: number;
  /** How fast the wings beat: 0 = still, 1 = buzzing. */
  flap: number;
  /** Spring lag of the antennae, −1…1. */
  lagX: number;
  lagY: number;
  /** 0…1: everything fades out with it (the drop sequence morph). */
  presence: number;
  /** 0…1: the tail's "your turn" heartbeat (motion.ts). */
  beat?: number;
  /** 0…1: the ripple ring's strength, and its phase 0…1. */
  ripple?: number;
  rp?: number;
  /** The antenna lights in the state (motion.ts tipLights); at rest without it. */
  tips?: TipLights;
}

/** The light first (a halo behind everything), then the wings. */
export function drawLumoBehind(x: CanvasRenderingContext2D, p: LumoPose) {
  if (p.presence <= 0.01) return;
  const { R, rx, ry } = p;
  x.save();
  x.globalAlpha *= p.presence;

  // The ripple when he waits for you: a ring of light leaving his body.
  const rip = p.ripple ?? 0;
  if (rip > 0.01) {
    const k = p.rp ?? 0;
    const a = 0.55 * Math.pow(1 - k, 1.6) * rip;
    if (a > 0.003) {
      x.strokeStyle = rgba(mix(p.glow, [1, 1, 1], 0.2), a);
      x.lineWidth = Math.max(1, R * 0.07 * (1 - k * 0.5));
      x.beginPath();
      x.arc(0, 0, R * (1 + 0.5 * ease(k)), 0, Math.PI * 2);
      x.stroke();
    }
  }

  // Wings: on each side a big forewing and a smaller hindwing, clear as glass,
  // fluttering from his upper back.
  const beat = Math.sin(p.t * (8 + 26 * p.flap)) * (0.07 + 0.2 * p.flap);
  const lw = Math.max(0.6, R * 0.03);
  for (const sd of [-1, 1]) {
    for (const [len, wid, ang, ox, oy, k] of [
      [0.66, 0.31, -0.66, 0.28, -0.44, 1],
      [0.48, 0.24, -0.16, 0.4, -0.2, 0.7],
    ] as const) {
      x.save();
      x.translate(sd * rx * ox, ry * oy);
      x.rotate(sd * (ang - beat * k));
      const w = new Path2D();
      w.ellipse(sd * R * len, 0, R * len, R * wid, 0, 0, Math.PI * 2);
      const g = x.createLinearGradient(0, -R * wid, sd * R * len * 2, R * wid);
      g.addColorStop(0, "rgba(225,240,255,0.42)");
      g.addColorStop(0.6, "rgba(205,235,255,0.26)");
      g.addColorStop(1, rgba(p.glow, 0.32));
      x.fillStyle = g;
      x.fill(w);
      x.strokeStyle = "rgba(255,255,255,0.72)";
      x.lineWidth = lw;
      x.stroke(w);
      if (R >= 12) {
        // Veins, so they read as wings.
        x.beginPath();
        x.moveTo(sd * R * 0.06, 0);
        x.quadraticCurveTo(sd * R * len * 0.9, -R * wid * 0.25, sd * R * len * 1.8, R * wid * 0.1);
        x.moveTo(sd * R * len * 0.7, -R * wid * 0.05);
        x.lineTo(sd * R * len * 1.35, -R * wid * 0.62);
        x.strokeStyle = "rgba(255,255,255,0.38)";
        x.lineWidth = lw * 0.8;
        x.stroke();
      }
      x.restore();
    }
  }

  // The tail: a round lantern under him, with its halo. It carries his light,
  // and the state's colour while an agent works.
  // It beats with his heart when he waits for you.
  const heart = p.beat ?? 0;
  const pulse = 0.85 + 0.15 * Math.sin(p.t * 2.4);
  const glowA = Math.min(1, (0.3 + 0.5 * p.shine) * pulse * (1 + 0.5 * heart));
  const tx = 0;
  const ty = ry * 0.98;
  const haloR = R * 0.95 * (1 + 0.12 * heart);
  const halo = x.createRadialGradient(tx, ty, R * 0.12, tx, ty, haloR);
  halo.addColorStop(0, rgba(p.glow, glowA));
  halo.addColorStop(0.55, rgba(p.glow, glowA * 0.35));
  halo.addColorStop(1, rgba(p.glow, 0));
  x.fillStyle = halo;
  x.beginPath();
  x.arc(tx, ty, haloR, 0, Math.PI * 2);
  x.fill();

  const bulb = x.createRadialGradient(tx, ty + R * 0.1, R * 0.04, tx, ty, R * 0.52);
  bulb.addColorStop(0, `rgba(255,255,235,${0.75 + 0.25 * p.shine})`);
  bulb.addColorStop(0.5, rgba(p.glow, 1));
  bulb.addColorStop(1, rgba(mix(p.glow, [0.45, 0.55, 0.1], 0.4), 1));
  x.fillStyle = bulb;
  x.beginPath();
  x.ellipse(tx, ty, R * 0.6, R * 0.44, 0, 0, Math.PI * 2);
  x.fill();
  if (R >= 12) {
    // Two soft stripes, like a firefly's belly.
    x.strokeStyle = "rgba(90,90,30,0.25)";
    x.lineWidth = Math.max(0.6, R * 0.04);
    for (const dy of [0.12, 0.26]) {
      const half = Math.sqrt(Math.max(0, 1 - (dy / 0.44) ** 2)) * R * 0.6 * 0.92;
      x.beginPath();
      x.moveTo(tx - half, ty + R * dy);
      x.quadraticCurveTo(tx, ty + R * (dy + 0.07), tx + half, ty + R * dy);
      x.stroke();
    }
  }
  x.restore();
}

/** The antennae, drawn over the body. */
export function drawLumoFront(x: CanvasRenderingContext2D, p: LumoPose) {
  if (p.presence <= 0.01) return;
  const { R, ry } = p;
  x.save();
  x.globalAlpha *= p.presence;
  const sway = Math.sin(p.t * 3.1) * 0.04 * (0.3 + p.flap);
  const tips = p.tips ?? TIPS_REST;
  for (const sd of [-1, 1]) {
    // How bright this tip is now (motion.ts): 1 is as bright as ever.
    const lit = tips.a[sd < 0 ? 0 : 1];
    const bx = sd * R * 0.3;
    const by = -ry * 0.86;
    const tipX = sd * R * (0.62 + tips.sx) - p.lagX * R * 0.18 + sway * R;
    const tipY = R * (-1.42 + tips.sy) - p.lagY * R * 0.12;
    x.beginPath();
    x.moveTo(bx, by);
    x.quadraticCurveTo(sd * R * 0.28, -R * 1.25, tipX, tipY);
    x.strokeStyle = INK;
    x.lineWidth = Math.max(0.8, R * 0.06);
    x.lineCap = "round";
    x.stroke();
    // A little light at each tip.
    const tipR = Math.max(1, R * 0.11);
    const haloR = tipR * (2 + 0.6 * lit);
    const tip = x.createRadialGradient(tipX, tipY, 0, tipX, tipY, haloR);
    tip.addColorStop(0, rgba(p.glow, Math.min(1, (0.55 + 0.4 * p.shine) * (0.35 + 0.65 * lit))));
    tip.addColorStop(1, rgba(p.glow, 0));
    x.fillStyle = tip;
    x.beginPath();
    x.arc(tipX, tipY, haloR, 0, Math.PI * 2);
    x.fill();
    const bead = x.createRadialGradient(tipX - tipR * 0.3, tipY - tipR * 0.3, 0, tipX, tipY, tipR);
    bead.addColorStop(0, `rgba(255,255,240,${0.55 + 0.45 * lit})`);
    bead.addColorStop(1, rgba(mix(p.glow, [0.12, 0.12, 0.1], 0.45 * (1 - lit)), 1));
    x.fillStyle = bead;
    x.beginPath();
    x.arc(tipX, tipY, tipR, 0, Math.PI * 2);
    x.fill();
    if (tips.sp > 0.05 && R >= 12) {
      // A tiny four-point sparkle when it is done.
      const s = tipR * (1.4 + 2.2 * tips.sp);
      x.fillStyle = `rgba(255,255,250,${0.85 * tips.sp})`;
      x.beginPath();
      x.moveTo(tipX, tipY - s);
      x.quadraticCurveTo(tipX, tipY, tipX + s, tipY);
      x.quadraticCurveTo(tipX, tipY, tipX, tipY + s);
      x.quadraticCurveTo(tipX, tipY, tipX - s, tipY);
      x.quadraticCurveTo(tipX, tipY, tipX, tipY - s);
      x.fill();
    }
  }
  x.restore();
}

function mix(a: RGB, b: RGB, k: number): RGB {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
