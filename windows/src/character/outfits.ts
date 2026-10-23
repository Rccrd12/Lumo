// Lumo's outfits, drawn in code: a leaf, round glasses, a bow tie, headphones
// and a scarf. Lumo's antennae stay free, so nothing covers the top of his head
// but the leaf's stem, between them.
//
// Coordinates are BotEngine's body space: origin at the body centre, y down,
// R = W × 0.3, rx = LUMO_RX R, ry = LUMO_RY R. The head is a superellipsoid whose
// horizontal radius at height y (y up, −1…1) is (1 − |y|^e)^(1/e), e = LUMO_EXP, so its
// silhouette matches the body at yaw = pitch = 0. Accessories are seen slightly
// from above and follow the head pitch only partly.

import { Ease } from "../core/anim";
import type { Outfit, OutfitSelection } from "./wardrobe";
import { SCRIPT_FONTS } from "../core/fonts";
import { LUMO_BOTTOM, LUMO_EXP, LUMO_EYE, LUMO_GLOW, LUMO_RX, LUMO_RY, LUMO_TOP, drawLumoFront } from "./lumo";
import { LOOK_SHAPE, drawLookStill, isRoundLook, lookEyeCentres, type RoundLook } from "./looks";
import type { LumoLook } from "./wardrobe";

const EXP = LUMO_EXP;
const VIEW_TILT = -0.3;
const ACC_PITCH = 0.4;
const EYE_W = LUMO_EYE.w;
const EYE_H = LUMO_EYE.h;
const EYE_SP = LUMO_EYE.spread;
const EYE_P = LUMO_EYE.pitch;

/** Below this radius the small details (veins, dots, stitches) are left out. */
const SIMPLIFY_BELOW_R = 16;

type Ctx = CanvasRenderingContext2D;
type Vec3 = readonly [number, number, number];
interface P3 { x: number; y: number; z: number }

/** Head geometry + the spring lag of the soft parts (−1…1, in head units). */
export interface Head {
  R: number;
  rx: number;
  ry: number;
  yaw: number;
  pitch: number;
  physDx: number;
  physDy: number;
  /**
   * A round look (looks.ts): where its eyes are, in head space, for the
   * glasses; and how far the head's centre sits below the body's origin.
   */
  eyes?: EyeFrame[];
  cy?: number;
}

export function makeHead(R: number, yaw = 0, pitch = 0, physDx = 0, physDy = 0): Head {
  return { R, rx: R * LUMO_RX, ry: R * LUMO_RY, yaw, pitch, physDx, physDy };
}

/**
 * The head of a round look (Filo, Punto, Goccia): its outline's size, its eyes
 * where looks.ts draws them, and only a little of the turn, since a round
 * look's eyes slide rather than turn with the head.
 */
export function roundHead(
  look: RoundLook, R: number, yaw = 0, pitch = 0, physDx = 0, physDy = 0,
  eyes: { lx: number; ly: number; es: number } = { lx: 0, ly: 0, es: 1 },
): Head {
  const s = LOOK_SHAPE[look];
  const cy = s.dy * R;
  const frames: EyeFrame[] = lookEyeCentres(look, R, { lx: eyes.lx, ly: eyes.ly, morph: 0 }).map((c, i) => ({
    sd: i === 0 ? -1 : 1,
    x: c.x,
    y: c.y - cy,
    fx: 1,
    fy: 1,
    visible: true,
    w: R * EYE_W * eyes.es,
    h: R * EYE_H * eyes.es,
  }));
  return {
    R, rx: R * s.rx, ry: R * (s.top + s.bottom) / 2,
    yaw: yaw * 0.16, pitch: pitch * 0.3, physDx, physDy, eyes: frames, cy,
  };
}

// ── 3D helpers ────────────────────────────────────────────────────────────────

/** Radius of the horizontal ring of the head at height y. */
function ringR(y: number): number {
  const a = Math.min(1, Math.abs(y));
  return Math.pow(1 - Math.pow(a, EXP), 1 / EXP);
}

/** Head-local point (x right, y up, z toward the viewer) → body space, with depth. */
function proj(H: Head, p: Vec3): P3 {
  const [x, y, z] = p;
  const cy = Math.cos(H.yaw);
  const sy = Math.sin(H.yaw);
  const x1 = x * cy + z * sy;
  const z1 = -x * sy + z * cy;
  const pitch = VIEW_TILT + H.pitch * ACC_PITCH;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const y2 = y * cp + z1 * sp;
  const z2 = -y * sp + z1 * cp;
  return { x: x1 * H.rx, y: -y2 * H.ry, z: z2 };
}

/** Point on the head surface at height y, longitude lon (0 = facing the viewer), scaled by s. */
function surf(y: number, lon: number, s = 1): Vec3 {
  const r = ringR(y) * s;
  return [r * Math.sin(lon), y, r * Math.cos(lon)];
}

/** The visible half of a projected closed ring, left → right, cut at its silhouette. */
function frontSilhouette(pts: P3[]): P3[] {
  const n = pts.length;
  if (n < 2) return pts;
  let minI = 0;
  let maxI = 0;
  for (let i = 1; i < n; i++) {
    if (pts[i].x < pts[minI].x) minI = i;
    if (pts[i].x > pts[maxI].x) maxI = i;
  }
  if (minI === maxI) return [pts[minI]];
  const walk = (step: number) => {
    const out: P3[] = [];
    let i = minI;
    for (;;) {
      out.push(pts[i]);
      if (i === maxI || out.length > n) break;
      i = (i + step + n) % n;
    }
    return out;
  };
  const a = walk(1);
  const b = walk(-1);
  const za = a.reduce((s, q) => s + q.z, 0) / a.length;
  const zb = b.reduce((s, q) => s + q.z, 0) / b.length;
  return za >= zb ? a : b;
}

function ring(H: Head, y: number, s: number, n = 120): P3[] {
  const pts: P3[] = [];
  for (let i = 0; i < n; i++) pts.push(proj(H, surf(y, -Math.PI + (i / n) * 2 * Math.PI, s)));
  return pts;
}

/** Front arc of the ring at height y, ordered left → right. */
function frontArc(H: Head, y: number, s: number): P3[] {
  return frontSilhouette(ring(H, y, s));
}

/** Lumo's body outline, same superellipse as the engine. */
export function bodyOutline(rx: number, ry: number): Path2D {
  const p = new Path2D();
  const n = 96;
  const e = 2 / EXP;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const x = rx * Math.sign(ca) * Math.pow(Math.abs(ca), e);
    const y = ry * Math.sign(sa) * Math.pow(Math.abs(sa), e);
    if (i === 0) p.moveTo(x, y);
    else p.lineTo(x, y);
  }
  p.closePath();
  return p;
}

function lin(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, stops: [number, string][]) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

function rad(ctx: Ctx, x: number, y: number, r0: number, r1: number, stops: [number, string][]) {
  const g = ctx.createRadialGradient(x, y, r0, x, y, Math.max(0.001, r1));
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ── Eyes ──────────────────────────────────────────────────────────────────────

export interface EyeFrame {
  sd: number;
  x: number;
  y: number;
  fx: number;
  fy: number;
  visible: boolean;
  w: number;
  h: number;
}

/** Where the engine draws the eyes — the glasses sit on these. */
export function eyeFrames(H: Head): EyeFrame[] {
  if (H.eyes) return H.eyes;
  return [-1, 1].map((sd) => {
    const eyeYaw = sd * EYE_SP + H.yaw;
    const eyePitch = EYE_P + H.pitch;
    const cp = Math.cos(eyePitch);
    return {
      sd,
      visible: Math.cos(eyeYaw) * cp > 0.04,
      x: Math.sin(eyeYaw) * cp * H.rx,
      y: -Math.sin(eyePitch) * H.ry,
      fx: Math.max(0.18, Math.cos(eyeYaw)),
      fy: Math.max(0.18, cp),
      w: H.R * EYE_W,
      h: H.R * EYE_H,
    };
  });
}


// ── Leaf (a sprout on top, between the antennae) ─────────────────────────────

function leafShape(ctx: Ctx, len: number, wid: number) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(len * 0.3, -wid, len * 0.75, -wid * 0.9, len, 0);
  ctx.bezierCurveTo(len * 0.75, wid * 0.9, len * 0.3, wid, 0, 0);
  ctx.closePath();
}

function leaf(ctx: Ctx, H: Head, simple: boolean) {
  const a = proj(H, surf(0.97, 0, 1));
  const R = H.R;
  const sway = H.physDx * 0.35;
  ctx.save();
  ctx.translate(a.x, a.y + R * 0.04);
  ctx.rotate(sway);
  // The stem.
  const stemTop = { x: R * 0.04, y: -R * 0.26 };
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(-R * 0.05, -R * 0.14, stemTop.x, stemTop.y);
  ctx.strokeStyle = "#4E8A2E";
  ctx.lineWidth = Math.max(0.8, R * 0.06);
  ctx.lineCap = "round";
  ctx.stroke();
  // The big leaf, to the right, and a small one to the left.
  for (const [sd, len, wid, ang] of [[1, 0.5, 0.2, -0.55], [-1, 0.3, 0.13, -0.5]] as const) {
    ctx.save();
    ctx.translate(stemTop.x, stemTop.y);
    ctx.scale(sd, 1);
    ctx.rotate(ang);
    leafShape(ctx, R * len, R * wid);
    ctx.fillStyle = lin(ctx, 0, -R * wid, R * len, R * wid, [[0, "#A6E36B"], [1, "#3F9E3A"]]);
    ctx.fill();
    if (!simple) {
      ctx.beginPath();
      ctx.moveTo(R * len * 0.08, 0);
      ctx.quadraticCurveTo(R * len * 0.5, -R * wid * 0.12, R * len * 0.9, 0);
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = Math.max(0.5, R * 0.025);
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

// ── Round glasses (pinned to the real eye positions) ──────────────────────────

function roundGlasses(ctx: Ctx, H: Head, body: Path2D, simple: boolean) {
  const eyes = eyeFrames(H);
  // On a round look the eyes sit closer: the lenses shrink to keep a bridge.
  const d = H.eyes ? Math.min(H.R * 0.62, Math.abs(eyes[1].x - eyes[0].x) * 0.86) : H.R * 0.62;
  const frame = "#2D5D66";
  ctx.save();
  ctx.clip(body);
  ctx.lineCap = "round";
  ctx.strokeStyle = frame;
  const [l, r] = eyes;
  if (l.visible && r.visible) {
    // A straight bridge, a little above the middle of the lenses.
    ctx.beginPath();
    ctx.moveTo(l.x + (d / 2) * l.fx, l.y - d * 0.12);
    ctx.lineTo(r.x - (d / 2) * r.fx, r.y - d * 0.12);
    ctx.lineWidth = H.R * 0.07;
    ctx.stroke();
  }
  ctx.lineWidth = H.R * 0.06;
  for (const e of eyes) {
    if (!e.visible) continue;
    ctx.beginPath();
    ctx.moveTo(e.x + (e.sd * d) / 2 * e.fx, e.y - d * 0.05);
    ctx.lineTo(e.sd * H.rx * 1.05, e.y - d * 0.16);
    ctx.stroke();
  }
  for (const e of eyes) {
    if (!e.visible) continue;
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.scale(e.fx, e.fy);
    ctx.beginPath();
    ctx.arc(0, 0, d / 2, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(170,235,240,0.2)";
    ctx.fill();
    ctx.lineWidth = H.R * 0.09;
    ctx.strokeStyle = frame;
    ctx.stroke();
    if (!simple) {
      // A slanted glint across the lens.
      ctx.save();
      ctx.clip();
      ctx.rotate(-0.7);
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.fillRect(-d * 0.1, -d, d * 0.12, d * 2);
      ctx.restore();
    }
    ctx.restore();
  }
  ctx.restore();
}

// ── Bow tie (under his face, turns with the head) ─────────────────────────────

function bowTie(ctx: Ctx, H: Head, simple: boolean) {
  const a = proj(H, surf(-0.52, 0, 1.03));
  if (a.z < -0.1) return;
  const s = H.R * 0.27;
  const sq = Math.max(0.35, Math.cos(H.yaw));
  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.scale(sq, 1);
  for (const sd of [-1, 1]) {
    const wing = new Path2D();
    wing.moveTo(0, 0);
    wing.lineTo(sd * s * 1.3, -s * 0.7);
    wing.quadraticCurveTo(sd * s * 1.5, 0, sd * s * 1.3, s * 0.7);
    wing.closePath();
    ctx.fillStyle = lin(ctx, 0, -s, 0, s, [[0, "#5B6CFF"], [1, "#2F3BB8"]]);
    ctx.fill(wing);
    if (!simple) {
      ctx.save();
      ctx.clip(wing);
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      for (const [dx, dy] of [[0.55, -0.3], [0.95, 0.25], [1.2, -0.25], [0.6, 0.35]]) {
        ctx.beginPath();
        ctx.arc(sd * s * dx, s * dy, s * 0.09, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }
  roundRect(ctx, -s * 0.24, -s * 0.32, s * 0.48, s * 0.64, s * 0.14);
  ctx.fillStyle = lin(ctx, 0, -s * 0.3, 0, s * 0.3, [[0, "#7381FF"], [1, "#27309A"]]);
  ctx.fill();
  ctx.restore();
}

// ── Headphones (the far cup goes behind the head) ─────────────────────────────

/** The side of the head an ear cup sits on: in 3D, so it turns with him. */
function cupAt(H: Head, sd: number): P3 {
  return proj(H, [sd * 1.04, 0.1, 0.05]);
}

function headphoneCup(ctx: Ctx, H: Head, sd: number, simple: boolean) {
  const c = cupAt(H, sd);
  const R = H.R;
  const w = R * 0.32;
  const hgt = R * 0.58;
  ctx.save();
  ctx.translate(c.x, c.y);
  roundRect(ctx, -w / 2, -hgt / 2, w, hgt, w * 0.45);
  ctx.fillStyle = lin(ctx, -w / 2, -hgt / 2, w / 2, hgt / 2, [[0, "#4A4E5A"], [1, "#1F2128"]]);
  ctx.fill();
  if (!simple) {
    // The coloured cushion against his head.
    roundRect(ctx, -sd * w * 0.5 - w * 0.14, -hgt * 0.42, w * 0.28, hgt * 0.84, w * 0.14);
    ctx.fillStyle = "#FF8A5B";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(sd * w * 0.1, 0, w * 0.17, 0, Math.PI * 2);
    ctx.fillStyle = rgbaOf(LUMO_GLOW, 0.9);
    ctx.fill();
  }
  ctx.restore();
}

function headphoneBand(ctx: Ctx, H: Head) {
  const l = cupAt(H, -1);
  const r = cupAt(H, 1);
  const top = proj(H, [0, 1.12, -0.05]);
  ctx.beginPath();
  ctx.moveTo(l.x, l.y - H.R * 0.18);
  ctx.bezierCurveTo(l.x - H.R * 0.05, top.y - H.R * 0.1, r.x + H.R * 0.05, top.y - H.R * 0.1, r.x, r.y - H.R * 0.18);
  ctx.strokeStyle = "#2B2E36";
  ctx.lineWidth = Math.max(1, H.R * 0.13);
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = Math.max(0.5, H.R * 0.035);
  ctx.stroke();
}

// ── Scarf (a mint knit, low around him, one end hanging) ──────────────────────

function scarf(ctx: Ctx, H: Head, simple: boolean) {
  const s = 1.06;
  const y0 = -0.3;
  const y1 = -0.72;
  const top = frontArc(H, y0, s);
  const bot = frontArc(H, y1, s);
  if (top.length === 0 || bot.length === 0) return;
  const band = new Path2D();
  top.forEach((q, i) => (i ? band.lineTo(q.x, q.y) : band.moveTo(q.x, q.y)));
  for (let i = bot.length - 1; i >= 0; i--) band.lineTo(bot[i].x, bot[i].y);
  band.closePath();

  const knit: [number, string][] = [[0, "#7FE3C8"], [1, "#1F9D83"]];
  ctx.save();
  ctx.clip(bodyOutline(H.rx * s, H.ry * s));
  ctx.fillStyle = lin(ctx, 0, -H.ry * 0.3, 0, H.ry * 0.75, knit);
  ctx.fill(band);
  ctx.save();
  ctx.clip(band);
  // A cream stripe along the middle.
  const mid = frontArc(H, (y0 + y1) / 2, s);
  ctx.beginPath();
  mid.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
  ctx.strokeStyle = "rgba(255,248,225,0.9)";
  ctx.lineWidth = H.R * 0.07;
  ctx.stroke();
  if (!simple) {
    // Little knit stitches.
    ctx.strokeStyle = "rgba(10,90,70,0.3)";
    ctx.lineWidth = H.R * 0.025;
    ctx.lineCap = "round";
    for (let lon = -1.3; lon <= 1.31; lon += 0.26) {
      for (const yy of [y0 - 0.06, y1 + 0.07]) {
        const q = proj(H, surf(yy, lon, s));
        if (q.z < 0.1) continue;
        ctx.beginPath();
        ctx.moveTo(q.x - H.R * 0.035, q.y - H.R * 0.03);
        ctx.lineTo(q.x, q.y + H.R * 0.02);
        ctx.lineTo(q.x + H.R * 0.035, q.y - H.R * 0.03);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
  ctx.fillStyle = lin(ctx, 0, -H.ry * 0.5, 0, H.ry * 0.3, [[0, "rgba(255,255,255,0.16)"], [1, "rgba(0,0,0,0.1)"]]);
  ctx.fill(band);
  ctx.restore();

  // The end, hanging from his right side and swinging a little.
  const k = proj(H, surf((y0 + y1) / 2, 0.75, s * 1.02));
  if (k.z <= 0) return;
  const sw = H.physDx * H.rx * 0.12;
  const len = H.ry * 0.55;
  const end = new Path2D();
  end.moveTo(k.x - H.R * 0.13, k.y - H.R * 0.04);
  end.quadraticCurveTo(k.x - H.R * 0.1 + sw, k.y + len * 0.5, k.x - H.R * 0.06 + sw * 1.4, k.y + len);
  end.lineTo(k.x + H.R * 0.18 + sw * 1.4, k.y + len * 0.96);
  end.quadraticCurveTo(k.x + H.R * 0.15 + sw, k.y + len * 0.45, k.x + H.R * 0.13, k.y - H.R * 0.04);
  end.closePath();
  ctx.fillStyle = lin(ctx, 0, k.y, 0, k.y + len, knit);
  ctx.fill(end);
  ctx.save();
  ctx.clip(end);
  ctx.fillStyle = "rgba(255,248,225,0.9)";
  ctx.fillRect(k.x - H.R * 0.4 + sw, k.y + len * 0.55, H.R * 0.8, H.R * 0.07);
  ctx.restore();
  // Fringe.
  ctx.strokeStyle = "#1F9D83";
  ctx.lineWidth = Math.max(0.6, H.R * 0.035);
  ctx.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    const fx = k.x - H.R * 0.03 + sw * 1.4 + i * H.R * 0.065;
    ctx.beginPath();
    ctx.moveTo(fx, k.y + len * 0.97);
    ctx.lineTo(fx + sw * 0.2, k.y + len * 0.97 + H.ry * 0.12);
    ctx.stroke();
  }
}

// ── Layers and transitions ────────────────────────────────────────────────────

let scratch: HTMLCanvasElement | null = null;

/**
 * Draws `fn` at `alpha` as one layer, so overlapping parts don't show through
 * each other while an outfit fades (SwiftUI's drawLayer on macOS).
 */
function withLayer(ctx: Ctx, alpha: number, fn: (c: Ctx) => void) {
  if (alpha >= 0.999) {
    ctx.save();
    fn(ctx);
    ctx.restore();
    return;
  }
  const W = ctx.canvas.width;
  const Hh = ctx.canvas.height;
  scratch ??= document.createElement("canvas");
  if (scratch.width < W || scratch.height < Hh) {
    scratch.width = Math.max(scratch.width, W);
    scratch.height = Math.max(scratch.height, Hh);
  }
  const s = scratch.getContext("2d");
  if (!s) return;
  s.setTransform(1, 0, 0, 1, 0, 0);
  s.clearRect(0, 0, W, Hh);
  s.setTransform(ctx.getTransform());
  s.save();
  fn(s);
  s.restore();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha *= alpha;
  ctx.drawImage(scratch, 0, 0, W, Hh, 0, 0, W, Hh);
  ctx.restore();
}

/** On the face: behind the head once it has turned away. */
const ON_FACE: ReadonlySet<Outfit> = new Set(["roundGlasses", "bowTie", "scarf"]);

export interface OutfitState {
  /** 0 = gone, 1 = fully on. Animated by the engine. */
  presence: number;
  /** The drop sequence's box morph: outfits fade away as he turns into a box. */
  morph: number;
}

function faceTurnedAway(H: Head): boolean {
  return proj(H, [0, 0, 1]).z < 0;
}

function drawFace(ctx: Ctx, outfit: Outfit, H: Head, body: Path2D, simple: boolean) {
  switch (outfit) {
    case "roundGlasses": roundGlasses(ctx, H, body, simple); break;
    case "scarf": scarf(ctx, H, simple); break;
    case "bowTie": bowTie(ctx, H, simple); break;
    default: break;
  }
}

function layerAlpha(st: OutfitState): number {
  const morphFade = 1 - Math.min(1, Math.max(0, (st.morph - 0.3) / 0.2));
  return morphFade * Math.min(1, st.presence * 2.5);
}

/**
 * The parts behind Lumo's body. `ctx` is in body space (translated to the body
 * centre, tilted and squashed exactly like the body).
 */
export function drawOutfitBehind(ctx: Ctx, outfit: Outfit, H: Head, st: OutfitState) {
  if (outfit === "none") return;
  const alpha = layerAlpha(st);
  if (alpha <= 0.005) return;
  const simple = H.R < SIMPLIFY_BELOW_R;
  const body = bodyOutline(H.rx, H.ry);

  ctx.save();
  if (H.cy) ctx.translate(0, H.cy);
  if (ON_FACE.has(outfit)) {
    if (faceTurnedAway(H)) withLayer(ctx, alpha, (l) => drawFace(l, outfit, H, body, simple));
  } else if (outfit === "headphones") {
    withLayer(ctx, alpha, (l) => {
      for (const sd of [-1, 1]) if (cupAt(H, sd).z < 0) headphoneCup(l, H, sd, simple);
    });
  }
  ctx.restore();
}

/** The parts in front of Lumo, drawn after the body, the eyes and the antennae. */
export function drawOutfitFront(ctx: Ctx, outfit: Outfit, H: Head, st: OutfitState) {
  if (outfit === "none") return;
  if (ON_FACE.has(outfit) && faceTurnedAway(H)) return;
  const alpha = layerAlpha(st);
  if (alpha <= 0.005) return;
  const simple = H.R < SIMPLIFY_BELOW_R;
  const body = bodyOutline(H.rx, H.ry);
  const p = st.presence;
  const posP = Ease.back(p);

  ctx.save();
  if (H.cy) ctx.translate(0, H.cy);
  if (outfit === "leaf" || outfit === "headphones") {
    // Put on from above, settling with a little overshoot.
    const k = 0.85 + 0.15 * posP;
    ctx.translate(0, -(1 - posP) * H.ry);
    ctx.scale(k, k);
  } else if (outfit === "roundGlasses") {
    ctx.translate(0, (1 - p) * 0.25 * H.ry);
  } else if (outfit === "scarf") {
    ctx.translate(0, (1 - p) * 0.3 * H.ry);
  } else if (outfit === "bowTie") {
    ctx.scale(Math.max(0.001, posP), Math.max(0.001, posP));
  }
  withLayer(ctx, alpha, (l) => {
    switch (outfit) {
      case "leaf": leaf(l, H, simple); break;
      case "headphones":
        headphoneBand(l, H);
        for (const sd of [-1, 1]) if (cupAt(H, sd).z >= 0) headphoneCup(l, H, sd, simple);
        break;
      default: drawFace(l, outfit, H, body, simple);
    }
  });
  ctx.restore();
}

// ── Wardrobe icons ────────────────────────────────────────────────────────────

const INK = "rgb(26,20,18)";

function rgbaOf(c: readonly [number, number, number], a = 1): string {
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
}

/** Where a round look's icon sits: R and the centre's drop below the middle. */
const ICON_ROUND = { R: 8.4, dy: 1.6 };

/** A little round look (Filo, Punto, Goccia) wearing `outfit`. */
function iconRound(ctx: Ctx, size: number, look: RoundLook, outfit: Outfit) {
  const { R, dy } = ICON_ROUND;
  const H = roundHead(look, R);
  const st: OutfitState = { presence: 1, morph: 0 };
  ctx.save();
  ctx.translate(size / 2, size / 2 + dy);
  drawOutfitBehind(ctx, outfit, H, st);
  drawLookStill(ctx, look, R);
  drawOutfitFront(ctx, outfit, H, st);
  ctx.restore();
}

/** A little Lumo wearing `outfit`, centred in a `size`×`size` icon. */
function iconLumo(ctx: Ctx, size: number, outfit: Outfit) {
  const R = 9;
  const H = makeHead(R);
  const cx = size / 2;
  const cy = size / 2 + R * 0.45;
  const st: OutfitState = { presence: 1, morph: 0 };
  ctx.save();
  ctx.translate(cx, cy);
  drawOutfitBehind(ctx, outfit, H, st);
  const body = bodyOutline(H.rx, H.ry);
  ctx.fillStyle = lin(ctx, H.rx * 0.7, -H.ry * 0.85, -H.rx * 0.8, H.ry * 0.9, [[0, rgbaOf(LUMO_TOP)], [1, rgbaOf(LUMO_BOTTOM)]]);
  ctx.fill(body);
  ctx.fillStyle = rad(ctx, 0, 0, R * 0.15, R * 1.25, [[0, "rgba(0,0,0,0)"], [0.6, "rgba(0,0,0,0)"], [1, "rgba(0,0,0,0.18)"]]);
  ctx.fill(body);
  ctx.save();
  ctx.clip(body);
  ctx.fillStyle = INK;
  for (const e of eyeFrames(H)) {
    if (!e.visible) continue;
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.scale(e.fx, e.fy);
    const hh = Math.max(e.h, e.w * 0.3);
    roundRect(ctx, -e.w / 2, -hh / 2, e.w, hh, Math.min(e.w / 2, hh / 2));
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
  drawLumoFront(ctx, {
    R, rx: H.rx, ry: H.ry, t: 0, glow: LUMO_GLOW, shine: 0.6, flap: 0, lagX: 0, lagY: 0, presence: 1,
  });
  drawOutfitFront(ctx, outfit, H, st);
  ctx.restore();
}

/**
 * One wardrobe button's picture — drawOutfitIcon on macOS. "auto" shows the
 * season's outfit with an AUTO tag, "none" a crossed-out circle.
 */
export function drawWardrobeIcon(
  ctx: Ctx, size: number, selection: OutfitSelection, seasonal: Outfit, autoLabel: string,
  look: LumoLook = "lucciola",
) {
  ctx.clearRect(0, 0, size, size);
  if (selection === "none") {
    const r = 6.5;
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.strokeStyle = "#454850";
    ctx.lineWidth = 1.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.82, 0, Math.PI * 2);
    ctx.moveTo(-r * 0.56, r * 0.56);
    ctx.lineTo(r * 0.56, -r * 0.56);
    ctx.stroke();
    ctx.restore();
    return;
  }
  const outfit = selection === "auto" ? seasonal : selection;
  if (isRoundLook(look)) iconRound(ctx, size, look, outfit);
  else iconLumo(ctx, size, outfit);
  if (selection !== "auto") return;
  const R = 9;
  const by = isRoundLook(look)
    ? size / 2 + ICON_ROUND.dy + ICON_ROUND.R * 0.8
    : size / 2 + R * 0.45 + R * LUMO_RY * 0.72;
  const bw = 14;
  const bh = 6.5;
  ctx.save();
  ctx.translate(size / 2, by);
  roundRect(ctx, -bw / 2, -bh / 2, bw, bh, bh / 2);
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  // A longer translation of "AUTO" gets a smaller font rather than overflowing the badge.
  let fontPx = 4.2;
  ctx.font = `600 ${fontPx}px system-ui, "Segoe UI", ${SCRIPT_FONTS}, sans-serif`;
  while (ctx.measureText(autoLabel).width > bw - 2 && fontPx > 2.6) {
    fontPx -= 0.2;
    ctx.font = `600 ${fontPx}px system-ui, "Segoe UI", ${SCRIPT_FONTS}, sans-serif`;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(autoLabel, 0, 0.2);
  ctx.restore();
}

/** One look button's picture in the wardrobe: the look itself, at rest. */
export function drawLookIcon(ctx: Ctx, size: number, look: LumoLook) {
  ctx.clearRect(0, 0, size, size);
  if (isRoundLook(look)) {
    ctx.save();
    ctx.translate(size / 2, size / 2);
    drawLookStill(ctx, look, ICON_ROUND.R);
    ctx.restore();
  } else {
    iconLumo(ctx, size, "none");
  }
}
