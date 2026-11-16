// Draws Lumo, his two eyes on a black disc with the island's light under it,
// into the PNG/ICO set Tauri needs. No dependencies: the icons are rasterised
// here (painted back to front, sample by sample) and encoded with node:zlib, so
// the app icon stays "drawn in code" like the character itself. The eyes are
// those of src/character/looks.ts (LOOK_EYES, lookInk of LOOK_IDLE), the light
// under the disc the island's own (look-new.css --lumo-light, the "glow" edge).
//
//   node scripts/gen-icons.mjs

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");

// ── Lumo ──────────────────────────────────────────────────────────────────────

const LIGHT = [255, 214, 140]; // #FFD68C, look-new.css --lumo-light
const EYES = [255, 244, 218]; // #FFF4DA, looks.ts lookInk(LOOK_IDLE)
const DISC_TOP = [31, 31, 36]; // #1F1F24
const DISC_BOTTOM = [6, 6, 7]; // #060607
const WHITE = [255, 255, 255];

const SS = 4; // supersampling factor

const mixc = (a, b, t) => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t);

/** Inside a rounded rectangle (x, y the point; X, Y its top left corner). */
function insideRRect(x, y, X, Y, W, H, R) {
  const cx = Math.max(X + R, Math.min(X + W - R, x));
  const cy = Math.max(Y + R, Math.min(Y + H - R, y));
  return x >= X && x <= X + W && y >= Y && y <= Y + H && (x - cx) ** 2 + (y - cy) ** 2 <= R * R;
}

/** 1 − Φ(z): how much of a Gaussian blur reaches z standard deviations out. */
function tail(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    * Math.exp(-(z * z) / 2);
  return z >= 0 ? (1 - erf) / 2 : (1 + erf) / 2;
}

/** The light under the disc: how strong, how far down and how soft (of the size). */
const GLOW = { alpha: 0.45, drop: 0.05, blur: 0.05 };
/** The disc's lower part, lit from below: how much (small icons have no glow, so more). */
const LIT = 0.22;
const LIT_SMALL = 0.45;

/** The layers, back to front: each returns [r, g, b, a] at a point of the square, or null. */
function lumoLayers(size) {
  // Small icons fill their square, drop the soft glow and set the eyes on whole pixels.
  const small = size < 40;
  const c = size / 2;
  const R = small ? size / 2 - 1 : size * 0.4;
  const cy = small ? c : c - size * 0.03;
  const layers = [];

  // The island's light under the disc: its shadow, lit and dropped a little.
  if (!small) {
    const sigma = size * GLOW.blur;
    const oy = cy + size * GLOW.drop;
    layers.push((x, y) => {
      const d = Math.hypot(x - c, y - oy) - R;
      return d > 3.5 * sigma ? null : [...LIGHT, GLOW.alpha * tail(d / sigma)];
    });
  }
  // The black disc, darker towards the bottom.
  const inDisc = (x, y) => Math.hypot(x - c, y - cy) <= R;
  layers.push((x, y) => (inDisc(x, y) ? [...mixc(DISC_TOP, DISC_BOTTOM, y / size), 1] : null));
  // Its lower part lit from below.
  const litTop = cy + R * 0.3;
  const litMax = small ? LIT_SMALL : LIT;
  layers.push((x, y) => {
    if (!inDisc(x, y) || y <= litTop) return null;
    return [...LIGHT, litMax * Math.min(1, (y - litTop) / (cy + R - litTop))];
  });
  // A faint edge, so the disc holds on a dark taskbar.
  const lw = Math.max(1, size / 128);
  const rimA = small ? 0.22 : 0.13;
  layers.push((x, y) => (Math.abs(Math.hypot(x - c, y - cy) - R) <= lw / 2 ? [...WHITE, rimA] : null));

  // The eyes: two crisp lit pills (looks.ts LOOK_EYES: w 0.475 of h, 1.5 h apart).
  const h0 = R * 0.6;
  const spread = h0 * 1.5;
  const ecy = small ? cy : cy - R * 0.04;
  let eyes;
  if (small) {
    const h = h0 * 1.15;
    const ew = Math.max(2, Math.round(h * 0.475));
    const eh = Math.max(4, Math.round(h));
    const half = Math.round(spread / 2 - ew / 2);
    const lx = Math.round(c - half - ew);
    const top = Math.round(ecy - eh / 2);
    const r = ew <= 2 ? 0.6 : ew / 2;
    eyes = [lx, size - lx - ew].map((X) => [X, top, ew, eh, r]);
  } else {
    const ew = h0 * 0.475;
    eyes = [-1, 1].map((sd) => [c + (sd * spread) / 2 - ew / 2, ecy - h0 / 2, ew, h0, ew / 2]);
  }
  layers.push((x, y) => (eyes.some((e) => insideRRect(x, y, ...e)) ? [...EYES, 1] : null));
  return layers;
}

function renderLumo(size) {
  const px = new Uint8Array(size * size * 4);
  const layers = lumoLayers(size);
  const total = SS * SS;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Premultiplied sum over the samples.
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const lx = x + (sx + 0.5) / SS;
          const ly = y + (sy + 0.5) / SS;
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
