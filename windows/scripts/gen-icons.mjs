// Draws Lumo, the little firefly, into the PNG/ICO set Tauri needs. No
// dependencies: the icons are rasterised here (painted back to front, sample by
// sample) and encoded with node:zlib, so the app icon stays "drawn in code"
// like the character itself. Same shapes as src/mochi/lumo.ts and the engine.
//
//   node scripts/gen-icons.mjs

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

// ── Lumo ──────────────────────────────────────────────────────────────────────

const BODY_TOP = [253, 249, 240]; // #FDF9F0
const BODY_BOTTOM = [229, 217, 193]; // #E5D9C1
const GLOW = [255, 213, 122]; // #FFD57A
const INK = [26, 20, 18]; // #1A1412
const STEM = [58, 52, 48];
const RIM = [26, 20, 18];
const WING = [205, 222, 240];

const SS = 4; // supersampling factor

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const mixc = (a, b, t) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t);

// His shape and eyes: LUMO_RX, LUMO_RY, LUMO_EXP and LUMO_EYE in src/mochi/lumo.ts.
const SHAPE = { rx: 0.9, ry: 0.98, exp: 2.05 };
const EYE = { w: 0.17, h: 0.27, spread: 0.35, pitch: -0.06 };

/** Superellipse test in body-local coordinates. */
function insideBody(x, y, rx, ry) {
  const n = SHAPE.exp;
  return Math.pow(Math.abs(x / rx), n) + Math.pow(Math.abs(y / ry), n) <= 1;
}

function insidePill(x, y, w, h) {
  const hw = w / 2;
  const hh = h / 2;
  const r = Math.min(hw, hh);
  const cx = Math.max(-hw + r, Math.min(hw - r, x));
  const cy = Math.max(-hh + r, Math.min(hh - r, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Points along a quadratic curve, for the antennae. */
function quad(p0, c, p1, n = 24) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]);
  }
  return pts;
}

function distToPolyline(x, y, pts) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const dx = bx - ax;
    const dy = by - ay;
    const t = clamp01(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

/** The layers, back to front: each returns [r, g, b, a] at a body-local point, or null. */
function lumoLayers(size) {
  const R = size * 0.29;
  const rx = R * SHAPE.rx;
  const ry = R * SHAPE.ry;
  const rim = Math.max(0.6, R * 0.05); // dark outline so the tray icon reads on light themes
  const withWings = size >= 48;
  const layers = [];

  // Wings: one slim pair, swept back.
  if (withWings) {
    for (const sd of [-1, 1]) {
      for (const [len, wid, ang, ox, oy] of [[0.5, 0.17, -0.46, 0.55, -0.4], [0.38, 0.12, 0.04, 0.66, -0.1]]) {
        const tx = sd * rx * ox;
        const ty = ry * oy;
        const ca = Math.cos(-sd * ang);
        const sa = Math.sin(-sd * ang);
        layers.push((x, y) => {
          const qx = (x - tx) * ca - (y - ty) * sa;
          const qy = (x - tx) * sa + (y - ty) * ca;
          const e = ((qx - sd * R * len) / (R * len)) ** 2 + (qy / (R * wid)) ** 2;
          if (e > 1) return null;
          const edge = 1 - Math.sqrt(e) < rim / (R * wid) ? 1 : 0;
          return edge ? [130, 150, 175, 0.9] : [...WING, 0.8];
        });
      }
    }
  }

  // His light: a soft glow low behind him.
  const ty = ry * 0.8;
  layers.push((x, y) => {
    const d = Math.hypot(x, y - ty) / (R * 1.0);
    if (d >= 1) return null;
    return [...GLOW, 0.7 * (1 - d) ** 1.5];
  });

  // The body, with its outline.
  layers.push((x, y) => (insideBody(x, y, rx + rim, ry + rim) && !insideBody(x, y, rx, ry) ? [...RIM, 1] : null));
  layers.push((x, y) => {
    if (!insideBody(x, y, rx, ry)) return null;
    // Gradient top-right → bottom-left, like the Canvas gradient, plus the soft highlight.
    const t = clamp01((x * -0.6 + y * 0.8) / (2 * ry) + 0.5);
    let c = mixc(BODY_TOP, BODY_BOTTOM, t);
    const h = Math.hypot(x - rx * 0.34, y + ry * 0.46) / (R * 0.42);
    if (h < 1) c = mixc(c, [255, 255, 255], 0.5 * (1 - h));
    return [...c, 1];
  });

  // Eyes — same geometry as BotEngine, with their sparkle.
  const cp = Math.cos(EYE.pitch);
  const ex = Math.sin(EYE.spread) * cp * rx;
  const ey = -Math.sin(EYE.pitch) * ry;
  const ew = R * EYE.w * Math.max(0.18, Math.cos(EYE.spread));
  const eh = R * EYE.h * Math.max(0.18, cp);
  const sparkle = size >= 32;
  layers.push((x, y) => {
    for (const sd of [-1, 1]) {
      const lx = x - sd * ex;
      const ly = y - ey;
      if (!insidePill(lx, ly, ew, eh)) continue;
      if (sparkle && Math.hypot(lx - ew * 0.12, ly + eh * 0.24) < ew * 0.19) return [255, 255, 255, 1];
      return [...INK, 1];
    }
    return null;
  });

  // Antennae, each with a little light at the tip.
  const lw = Math.max(0.9, R * 0.05);
  const tipR = Math.max(1, R * 0.09);
  for (const sd of [-1, 1]) {
    const tip = [sd * R * 0.5, -R * 1.36];
    const pts = quad([sd * R * 0.2, -ry * 0.94], [sd * R * 0.24, -R * 1.28], tip);
    layers.push((x, y) => (distToPolyline(x, y, pts) <= lw / 2 ? [...STEM, 1] : null));
    layers.push((x, y) => {
      const d = Math.hypot(x - tip[0], y - tip[1]);
      if (d <= tipR) return [...mixc([255, 255, 240], GLOW, d / tipR), 1];
      if (d <= tipR * 2.4) return [...GLOW, 0.5 * (1 - (d - tipR) / (tipR * 1.4))];
      return null;
    });
  }
  return { layers, cy: size / 2 + R * 0.1 };
}

function renderLumo(size) {
  const px = new Uint8Array(size * size * 4);
  const { layers, cy } = lumoLayers(size);
  const cx = size / 2;
  const total = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Premultiplied sum over the samples.
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const lx = x + (sx + 0.5) / SS - cx;
          const ly = y + (sy + 0.5) / SS - cy;
          let cr = 0, cg = 0, cb = 0, ca = 0;
          for (const layer of layers) {
            const c = layer(lx, ly);
            if (!c) continue;
            const al = c[3];
            cr = c[0] * al + cr * (1 - al);
            cg = c[1] * al + cg * (1 - al);
            cb = c[2] * al + cb * (1 - al);
            ca = al + ca * (1 - al);
          }
          r += cr; g += cg; b += cb; a += ca;
        }
      }
      if (a === 0) continue;
      const o = (y * size + x) * 4;
      px[o] = Math.round(r / a);
      px[o + 1] = Math.round(g / a);
      px[o + 2] = Math.round(b / a);
      px[o + 3] = Math.round((a / total) * 255);
    }
  }
  return px;
}

// ── PNG ───────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── ICO (PNG-in-ICO, Vista and later) ─────────────────────────────────────────

function encodeICO(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = header.length + dir.length;
  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size;
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0;
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

// ── Go ────────────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });

const png = (size) => encodePNG(size, renderLumo(size));

const files = {
  "32x32.png": png(32),
  "128x128.png": png(128),
  "128x128@2x.png": png(256),
  "icon.png": png(512),
};
for (const [name, data] of Object.entries(files)) {
  writeFileSync(join(OUT, name), data);
  console.log(`${name} — ${data.length} bytes`);
}

const ico = encodeICO([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: png(size) })));
writeFileSync(join(OUT, "icon.ico"), ico);
console.log(`icon.ico — ${ico.length} bytes`);
