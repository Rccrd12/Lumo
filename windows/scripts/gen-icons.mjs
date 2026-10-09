// Draws Lumo, a ring of light (Filo), into the PNG/ICO set Tauri needs. No
// dependencies: the icons are rasterised here (painted back to front, sample by
// sample) and encoded with node:zlib, so the app icon stays "drawn in code"
// like the character itself. Same shapes as src/mochi/looks.ts.
//
//   node scripts/gen-icons.mjs

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

// ── Lumo ──────────────────────────────────────────────────────────────────────
// Filo, his look by default: a ring of light with two lit eyes, as drawn by
// src/mochi/looks.ts, on a dark disc so it reads on light taskbars too.

const LIGHT = [255, 224, 158]; // #FFE09E, LOOK_IDLE
const RING = [255, 241, 214]; // the light, whitened as the ring draws it
const EYES = [255, 244, 224];
const DISC = [20, 18, 17];
const RIM = [26, 20, 18]; // #1A1412, a hairline outside the ring

const SS = 4; // supersampling factor

const mixc = (a, b, t) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t);

function insidePill(x, y, w, h) {
  const hw = w / 2;
  const hh = h / 2;
  const r = Math.min(hw, hh);
  const cx = Math.max(-hw + r, Math.min(hw - r, x));
  const cy = Math.max(-hh + r, Math.min(hh - r, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Distance from a point to a pill's outline (0 inside). */
function pillDistance(x, y, w, h) {
  const hw = w / 2;
  const hh = h / 2;
  const r = Math.min(hw, hh);
  const cx = Math.max(-hw + r, Math.min(hw - r, x));
  const cy = Math.max(-hh + r, Math.min(hh - r, y));
  return Math.max(0, Math.hypot(x - cx, y - cy) - r);
}

/** The layers, back to front: each returns [r, g, b, a] at a centred point, or null. */
function lumoLayers(size) {
  // Small icons fill more of their square and get thicker lines.
  const small = size <= 32;
  const R = size * (small ? 0.4 : 0.36);
  const lw = Math.max(1.6, R * (small ? 0.17 : 0.11));
  const rim = Math.max(0.6, R * 0.035);
  const glow = small ? R * 0.18 : R * 0.34;
  const layers = [];

  // The light around the ring.
  layers.push((x, y) => {
    const d = Math.hypot(x, y) - (R + lw / 2);
    if (d <= 0 || d >= glow) return null;
    return [...LIGHT, 0.55 * (1 - d / glow) ** 2];
  });
  // A hairline of ink outside the ring, so it holds on a white taskbar.
  layers.push((x, y) => {
    const d = Math.hypot(x, y) - (R + lw / 2);
    return d > -0.2 && d <= rim ? [...RIM, 0.55] : null;
  });
  // The dark disc inside, with the ring's faint light towards the rim.
  layers.push((x, y) => {
    const d = Math.hypot(x, y) / R;
    if (d > 1) return null;
    return [...mixc(DISC, LIGHT, 0.06 + 0.22 * d ** 3), 1];
  });
  // The ring.
  layers.push((x, y) => (Math.abs(Math.hypot(x, y) - R) <= lw / 2 ? [...RING, 1] : null));

  // The eyes: two lit pills with a soft glow (looks.ts LOOK_EYES.filo).
  const ew = Math.max(1.7, R * 0.2);
  const eh = Math.max(3.4, R * 0.42);
  const ex = Math.max(2.1, R * 0.3);
  const ey = -R * 0.02;
  const eg = small ? 0 : ew * 0.9;
  layers.push((x, y) => {
    let best = Infinity;
    for (const sd of [-1, 1]) best = Math.min(best, pillDistance(x - sd * ex, y - ey, ew, eh));
    if (best === 0 || eg === 0 || best >= eg) return null;
    return [...LIGHT, 0.5 * (1 - best / eg) ** 2];
  });
  layers.push((x, y) => {
    for (const sd of [-1, 1]) if (insidePill(x - sd * ex, y - ey, ew, eh)) return [...EYES, 1];
    return null;
  });
  return { layers, cy: size / 2 };
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
