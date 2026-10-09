// Lumo, the little firefly: what makes him one — the glowing tail under him,
// the two wings behind, the antennae on top. Drawn around the body that
// engine.ts (and the launch greeting) draws, in its body space: origin at the
// body centre, y down, R the body's size unit, rx/ry its half width/height.

export type RGB = readonly [number, number, number]; // components 0…1

/**
 * His body: a smooth oval, a little taller than wide. Half width and half
 * height in units of R, and the superellipse exponent of its outline (2 is a
 * true ellipse). The engine, the outfits, the greeting, the drop sequence and
 * scripts/gen-icons.mjs all draw this same shape.
 */
export const LUMO_RX = 0.9;
export const LUMO_RY = 0.98;
export const LUMO_EXP = 2.05;
/** His eyes: small upright ovals, calm and set close (units of R, radians). */
export const LUMO_EYE = { w: 0.17, h: 0.27, spread: 0.35, pitch: -0.06 } as const;

/** His body: ivory, a touch of champagne towards the bottom. */
export const LUMO_TOP: RGB = [0.992, 0.976, 0.941]; // #FDF9F0
export const LUMO_BOTTOM: RGB = [0.898, 0.851, 0.757]; // #E5D9C1
/** His light when nothing is going on: a warm, quiet gold. */
export const LUMO_GLOW: RGB = [1, 0.835, 0.478]; // #FFD57A

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
}

/** The light first (a halo behind everything), then the wings. */
export function drawLumoBehind(x: CanvasRenderingContext2D, p: LumoPose) {
  if (p.presence <= 0.01) return;
  const { R, rx, ry } = p;
  x.save();
  x.globalAlpha *= p.presence;

  // The light: a soft glow low behind him, no bulb — he carries it, he isn't one.
  const pulse = 0.88 + 0.12 * Math.sin(p.t * 2.1);
  const glowA = (0.26 + 0.38 * p.shine) * pulse;
  const ty = ry * 0.8;
  const haloR = R * 1.0;
  const halo = x.createRadialGradient(0, ty, R * 0.05, 0, ty, haloR);
  halo.addColorStop(0, rgba(p.glow, glowA));
  halo.addColorStop(0.5, rgba(p.glow, glowA * 0.3));
  halo.addColorStop(1, rgba(p.glow, 0));
  x.fillStyle = halo;
  x.beginPath();
  x.arc(0, ty, haloR, 0, Math.PI * 2);
  x.fill();

  // Wings: one slim pair, swept back like a dragonfly's, clear as glass.
  const beat = Math.sin(p.t * (7 + 24 * p.flap)) * (0.05 + 0.16 * p.flap);
  const lw = Math.max(0.5, R * 0.022);
  for (const sd of [-1, 1]) {
    for (const [len, wid, ang, ox, oy, k, a] of [
      [0.5, 0.17, -0.46, 0.55, -0.4, 1, 1],
      [0.38, 0.12, 0.04, 0.66, -0.1, 0.7, 0.8],
    ] as const) {
      x.save();
      x.translate(sd * rx * ox, ry * oy);
      x.rotate(sd * (ang - beat * k));
      const w = new Path2D();
      w.ellipse(sd * R * len, 0, R * len, R * wid, 0, 0, Math.PI * 2);
      const g = x.createLinearGradient(0, 0, sd * R * len * 2, 0);
      g.addColorStop(0, `rgba(235,242,250,${0.34 * a})`);
      g.addColorStop(1, `rgba(220,232,245,${0.14 * a})`);
      x.fillStyle = g;
      x.fill(w);
      x.strokeStyle = `rgba(255,255,255,${0.55 * a})`;
      x.lineWidth = lw;
      x.stroke(w);
      if (R >= 14) {
        // One fine vein down the middle.
        x.beginPath();
        x.moveTo(sd * R * 0.05, 0);
        x.quadraticCurveTo(sd * R * len, -R * wid * 0.12, sd * R * len * 1.75, 0);
        x.strokeStyle = `rgba(255,255,255,${0.28 * a})`;
        x.lineWidth = lw * 0.8;
        x.stroke();
      }
      x.restore();
    }
  }
  x.restore();
}

/** The antennae, drawn over the body: two fine lines with a point of light. */
export function drawLumoFront(x: CanvasRenderingContext2D, p: LumoPose) {
  if (p.presence <= 0.01) return;
  const { R, ry } = p;
  x.save();
  x.globalAlpha *= p.presence;
  const sway = Math.sin(p.t * 2.6) * 0.03 * (0.4 + p.flap);
  for (const sd of [-1, 1]) {
    const bx = sd * R * 0.2;
    const by = -ry * 0.94;
    const tipX = sd * R * 0.5 - p.lagX * R * 0.15 + sway * R;
    const tipY = -R * 1.36 - p.lagY * R * 0.1;
    x.beginPath();
    x.moveTo(bx, by);
    x.bezierCurveTo(sd * R * 0.2, -R * 1.18, sd * R * 0.34, -R * 1.34, tipX, tipY);
    x.strokeStyle = "rgba(176,164,146,0.95)"; // warm grey: reads on the dark island and on him
    x.lineWidth = Math.max(0.7, R * 0.035);
    x.lineCap = "round";
    x.stroke();
    const tipR = Math.max(0.9, R * 0.065);
    const tip = x.createRadialGradient(tipX, tipY, 0, tipX, tipY, tipR * 3);
    tip.addColorStop(0, rgba(p.glow, 0.35 + 0.35 * p.shine));
    tip.addColorStop(1, rgba(p.glow, 0));
    x.fillStyle = tip;
    x.beginPath();
    x.arc(tipX, tipY, tipR * 3, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = rgba(mix(p.glow, [1, 1, 0.94], 0.45), 1);
    x.beginPath();
    x.arc(tipX, tipY, tipR, 0, Math.PI * 2);
    x.fill();
  }
  x.restore();
}

function mix(a: RGB, b: RGB, k: number): RGB {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}
