// Synthesises Lumo's 29 sounds from code and writes them to assets/sounds/.
// No dependencies, no samples: every sound is built here out of oscillators,
// FM, Karplus-Strong plucks and filtered noise, with envelopes, an echo and a
// small reverb written by hand. The noise comes from a seeded PRNG, so running
// the script twice gives byte-identical files.
//
//   npm run sounds        (or: node scripts/gen-sounds.mjs)
//
// Lumo is a small glowing firefly, so the palette is soft and warm: glowing
// bells (a detuned twin partial makes them pulse gently, like a glow), little
// FM plucks, bubbles and airy whooshes, mostly in C major. They play often and
// quietly (the player's default gain is 0.12), so attacks are never sharp and
// nothing sits high in the treble for long.
//
// Output: 16-bit PCM, mono, 44.1 kHz. Each file starts and ends on a zero
// sample (short fades), and is normalised to its own peak level below.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "assets", "sounds");
const SR = 44100;
const TAU = Math.PI * 2;

// ── Determinism ───────────────────────────────────────────────────────────────

/** mulberry32: small, fast, and the same sequence on every machine. */
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, so each sound gets its own noise sequence, independent of the others. */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── Pitches ───────────────────────────────────────────────────────────────────

const SEMI = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };
/** "C6" → 1046.5 Hz, "F#5" → 740 Hz (A4 = 440). */
function hz(name) {
  const m = /^([A-G])(#|b)?(\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  const s = SEMI[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + (Number(m[3]) - 4) * 12;
  return 440 * 2 ** (s / 12);
}

/** Exponential glide f0 → f1 over `dur` seconds (eased), then holds f1. */
const glide = (f0, f1, dur, from = 0) => (t) => {
  const k = Math.min(1, Math.max(0, (t - from) / dur));
  const e = k * k * (3 - 2 * k);
  return f0 * (f1 / f0) ** e;
};

// ── Timbres: [ratio, amplitude, decay multiplier] ─────────────────────────────

/** Soft glowing bell. The 1.0025 twin beats slowly against the fundamental: the glow. */
const GLOW = [[1, 1], [1.0025, 0.45], [2, 0.2, 1.8], [3, 0.06, 2.6], [4.17, 0.03, 3.4]];
/** Glassier chime for sparkles. */
const CHIME = [[1, 1], [1.0018, 0.5], [2.76, 0.16, 2.2], [5.4, 0.05, 3.6]];
/** Small wooden mallet, for dots and ticks. */
const MALLET = [[1, 1], [3.93, 0.1, 3], [9.8, 0.015, 6]];
/** Mellow, almost a hum. */
const SOFT = [[1, 1], [2, 0.18, 1.5], [3, 0.05, 2]];
/** Fuller, voice-like; lowpassed after, for grumbles and yawns. */
const HUM = [[1, 1], [2, 0.35], [3, 0.12], [4, 0.05]];

// ── Building blocks ───────────────────────────────────────────────────────────

class Track {
  constructor(name, dur) {
    this.name = name;
    this.dur = dur;
    this.len = Math.round(dur * SR);
    this.d = new Float64Array(this.len);
    this.rnd = prng(hash(name));
  }
  /** Sample range [start, end) of an event, clipped to the track. */
  span(at, len) {
    const s = Math.max(0, Math.round(at * SR));
    const e = Math.min(this.len, Math.round((at + len) * SR));
    return [s, e];
  }
  /** Seconds left in the track after `at`. */
  rest(at) {
    return Math.max(0, this.dur - at);
  }
}

/** Raised-cosine attack, exponential decay, raised-cosine release at `len`. */
function envAD(t, len, attack, decay, release) {
  if (t < 0 || t >= len) return 0;
  let a = t < attack ? 0.5 - 0.5 * Math.cos((Math.PI * t) / attack) : Math.exp(-(t - attack) / decay);
  const r = len - t;
  if (r < release) a *= 0.5 - 0.5 * Math.cos((Math.PI * r) / release);
  return a;
}

/** Swell that peaks at `peak` seconds and is back to zero at `len`. */
const swell = (len, peak) => (t) => {
  if (t <= 0 || t >= len) return 0;
  return t < peak ? Math.sin((Math.PI / 2) * (t / peak)) ** 2 : Math.cos((Math.PI / 2) * ((t - peak) / (len - peak))) ** 2;
};

/**
 * Additive oscillator with optional FM, vibrato and tremolo.
 * `freq` is a number or a function of the note's own time.
 */
function tone(tr, o) {
  const {
    at = 0, freq, amp = 1, partials = [[1, 1]], attack = 0.004, decay = 0.2,
    vib = 0, vibRate = 5.5, vibDelay = 0, trem = 0, tremRate = 5,
    fm = 0, fmRatio = 1, fmDecay = 0.05, env,
  } = o;
  const len = Math.min(o.len ?? tr.rest(at), tr.rest(at));
  const release = o.release ?? Math.min(0.03, len * 0.25);
  const f = typeof freq === "function" ? freq : () => freq;
  const [s, e] = tr.span(at, len);
  const ph = new Float64Array(partials.length);
  let pm = 0;
  for (let i = s; i < e; i++) {
    const t = i / SR - at;
    let f0 = f(t);
    if (vib) f0 *= 1 + vib * Math.sin(TAU * vibRate * t) * Math.min(1, Math.max(0, (t - vibDelay) / 0.1));
    let mod = 0;
    if (fm) {
      pm += (TAU * f0 * fmRatio) / SR;
      mod = fm * Math.exp(-t / fmDecay) * Math.sin(pm);
    }
    let v = 0;
    for (let p = 0; p < partials.length; p++) {
      const [ratio, a, dm = 1] = partials[p];
      const fp = f0 * ratio;
      if (fp > 15000) continue;
      ph[p] += (TAU * fp) / SR;
      const pe = dm === 1 ? 1 : Math.exp((-t * (dm - 1)) / decay);
      v += a * pe * Math.sin(ph[p] + mod);
    }
    let g = env ? env(t) : envAD(t, len, attack, decay, release);
    if (trem) g *= 1 - trem * (0.5 - 0.5 * Math.cos(TAU * tremRate * t));
    tr.d[i] += amp * g * v;
  }
}

/** Zavalishin's TPT state-variable filter (stable when the cutoff moves). */
function svf() {
  let ic1 = 0;
  let ic2 = 0;
  return (v0, fc, q, mode) => {
    const g = Math.tan((Math.PI * Math.min(fc, SR * 0.45)) / SR);
    const k = 1 / q;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = v0 - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    return mode === "lp" ? v2 : mode === "bp" ? v1 : v0 - k * v1 - v2;
  };
}

/** Filtered noise burst; `f` (cutoff/centre) may move over time. */
function noise(tr, o) {
  const { at = 0, amp = 1, type = "bp", f = 1000, q = 0.7, attack = 0.005, decay = 0.05, env } = o;
  const len = Math.min(o.len ?? tr.rest(at), tr.rest(at));
  const release = Math.min(0.03, len * 0.25);
  const fc = typeof f === "function" ? f : () => f;
  const filt = svf();
  const [s, e] = tr.span(at, len);
  for (let i = s; i < e; i++) {
    const t = i / SR - at;
    const y = filt(tr.rnd() * 2 - 1, fc(t), q, type);
    tr.d[i] += amp * (env ? env(t) : envAD(t, len, attack, decay, release)) * y;
  }
}

/** Airy whoosh: band-passed noise whose centre glides f0 → f1. */
function whoosh(tr, at, len, f0, f1, amp, peak = len * 0.4, q = 1.1) {
  noise(tr, { at, len, amp, type: "bp", f: glide(f0, f1, len), q, env: swell(len, peak) });
}

/** Karplus-Strong plucked string, warm (lowpassed excitation, slow decay). */
function pluck(tr, { at = 0, freq, amp = 1, decay = 0.3, bright = 0.5, len }) {
  const L = Math.min(len ?? tr.rest(at), tr.rest(at));
  const n = Math.round(L * SR);
  if (n <= 0) return;
  const y = new Float64Array(n + 2);
  const P = SR / freq - 0.5; // the two-point average adds half a sample of delay
  const P0 = Math.min(n, Math.ceil(P) + 1);
  let lp = 0;
  let mean = 0;
  for (let i = 0; i < P0; i++) {
    lp += bright * (tr.rnd() * 2 - 1 - lp);
    y[i] = lp;
    mean += lp;
  }
  mean /= P0;
  for (let i = 0; i < P0; i++) y[i] -= mean;
  const rho = Math.exp(-1 / (freq * decay));
  const read = (x) => {
    const i0 = Math.floor(x);
    const fr = x - i0;
    return y[i0] * (1 - fr) + y[i0 + 1] * fr;
  };
  for (let i = P0; i < n; i++) y[i] = rho * 0.5 * (read(i - P) + read(i - P - 1));
  const s = Math.round(at * SR);
  const rel = Math.min(0.03, L * 0.25);
  for (let i = 0; i < n && s + i < tr.len; i++) {
    const t = i / SR;
    tr.d[s + i] += amp * envAD(t, L, 0.003, 1e9, rel) * y[i];
  }
}

// Shorthands for the voices used most.
const bell = (tr, at, f, amp = 1, decay = 0.3, o = {}) =>
  tone(tr, { at, freq: f, amp, partials: GLOW, attack: 0.003, decay, ...o });
const chime = (tr, at, f, amp = 1, decay = 0.08, o = {}) =>
  tone(tr, { at, freq: f, amp, partials: CHIME, attack: 0.002, decay, ...o });
const fmPluck = (tr, at, f, amp = 1, decay = 0.12, o = {}) =>
  tone(tr, { at, freq: f, amp, partials: [[1, 1], [2, 0.15, 2]], fm: 1.0, fmDecay: 0.03, attack: 0.002, decay, ...o });
const bubble = (tr, at, f0, f1, sweep, amp = 1, decay = 0.04) =>
  tone(tr, { at, freq: glide(f0, f1, sweep), amp, attack: 0.002, decay, len: Math.min(tr.rest(at), decay * 7) });

// ── Effects ───────────────────────────────────────────────────────────────────

/** Small Freeverb-style room: six damped combs, two allpasses, mixed in. */
function reverb(tr, { mix = 0.2, size = 1, fb = 0.78, damp = 0.35 } = {}) {
  const dry = tr.d;
  const wet = new Float64Array(tr.len);
  const pre = Math.round(0.006 * SR);
  for (const base of [1116, 1188, 1277, 1356, 1422, 1491]) {
    const D = Math.max(1, Math.round(base * size));
    const buf = new Float64Array(D);
    let idx = 0;
    let store = 0;
    for (let i = 0; i < tr.len; i++) {
      const x = i >= pre ? dry[i - pre] : 0;
      const out = buf[idx];
      store = out * (1 - damp) + store * damp;
      buf[idx] = x + store * fb;
      idx = (idx + 1) % D;
      wet[i] += out / 6;
    }
  }
  for (const base of [556, 441]) {
    const D = Math.max(1, Math.round(base * size));
    const buf = new Float64Array(D);
    let idx = 0;
    for (let i = 0; i < tr.len; i++) {
      const b = buf[idx];
      const x = wet[i];
      wet[i] = b - x;
      buf[idx] = x + b * 0.5;
      idx = (idx + 1) % D;
    }
  }
  for (let i = 0; i < tr.len; i++) dry[i] += mix * wet[i];
}

/** Feedback echo, each repeat a little darker. */
function echo(tr, { time, fb = 0.35, mix = 0.5, tone: k = 0.35 }) {
  const D = Math.round(time * SR);
  const dry = Float64Array.from(tr.d);
  const e = new Float64Array(tr.len);
  let lp = 0;
  for (let i = 0; i < tr.len; i++) {
    const src = i >= D ? dry[i - D] + fb * e[i - D] : 0;
    lp += k * (src - lp);
    e[i] = lp;
  }
  for (let i = 0; i < tr.len; i++) tr.d[i] += mix * e[i];
}

/** Two-pole lowpass over the whole track. */
function lowpass(tr, fc, q = 0.707) {
  const f = svf();
  for (let i = 0; i < tr.len; i++) tr.d[i] = f(tr.d[i], fc, q, "lp");
}

/** DC block, fades in/out to a zero sample, peak normalisation, 16-bit. */
function master(tr, peakDb) {
  const d = tr.d;
  let x1 = 0;
  let y1 = 0;
  const R = 1 - (TAU * 20) / SR;
  for (let i = 0; i < tr.len; i++) {
    const y = d[i] - x1 + R * y1;
    x1 = d[i];
    y1 = y;
    d[i] = y;
  }
  const fin = Math.max(2, Math.round(0.0015 * SR));
  const fout = Math.max(2, Math.round(Math.min(0.08, Math.max(0.008, tr.dur * 0.12)) * SR));
  for (let i = 0; i < fin; i++) d[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fin);
  for (let i = 0; i < fout; i++) d[tr.len - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / (fout - 1));
  let peak = 0;
  for (let i = 0; i < tr.len; i++) peak = Math.max(peak, Math.abs(d[i]));
  const gain = peak > 0 ? 10 ** (peakDb / 20) / peak : 0;
  const pcm = new Int16Array(tr.len);
  for (let i = 0; i < tr.len; i++) pcm[i] = Math.max(-32767, Math.min(32767, Math.round(d[i] * gain * 32767)));
  return pcm;
}

function wav(pcm) {
  const bytes = pcm.length * 2;
  const b = Buffer.alloc(44 + bytes);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + bytes, 4);
  b.write("WAVE", 8, "ascii");
  b.write("fmt ", 12, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(bytes, 40);
  for (let i = 0; i < pcm.length; i++) b.writeInt16LE(pcm[i], 44 + i * 2);
  return b;
}

// ── The sounds ────────────────────────────────────────────────────────────────
// [duration s, peak dBFS, build]. Durations match the previous set's so every
// timing built around them (the greeting above all) still lines up. Events
// that need you peak at -6 dBFS; small UI sounds that fire constantly (hover,
// tick, clicks, whooshes) sit lower so they stay a whisper next to them.

const SOUNDS = {
  // Island peeking out of hiding: a little breath of air and a glint.
  peek: [0.446, -14, (tr) => {
    whoosh(tr, 0, 0.32, 450, 2000, 0.45, 0.14, 0.9);
    bell(tr, 0.1, hz("E6"), 0.7, 0.12, { attack: 0.012 });
    bell(tr, 0.18, hz("B6"), 0.3, 0.08);
    reverb(tr, { mix: 0.22, size: 0.8 });
  }],

  // Island opening: rising whoosh, a soft upward glide that blooms into a glow.
  open: [0.503, -14, (tr) => {
    whoosh(tr, 0, 0.36, 320, 2600, 0.55, 0.16);
    tone(tr, { at: 0, len: 0.3, freq: glide(hz("C5"), hz("G5"), 0.16), partials: SOFT, amp: 0.35, attack: 0.02, decay: 0.1 });
    bell(tr, 0.15, hz("G6"), 0.55, 0.12);
    bell(tr, 0.21, hz("C7"), 0.35, 0.1);
    reverb(tr, { mix: 0.22, size: 0.8 });
  }],

  // Island closing: the same, folding back down.
  close: [0.429, -16, (tr) => {
    whoosh(tr, 0, 0.3, 2600, 320, 0.55, 0.1);
    tone(tr, { at: 0, len: 0.3, freq: glide(hz("G5"), hz("C5"), 0.16), partials: SOFT, amp: 0.35, attack: 0.01, decay: 0.1 });
    bell(tr, 0.14, hz("G5"), 0.4, 0.1);
    reverb(tr, { mix: 0.2, size: 0.8 });
  }],

  // Pointer over something: the faintest wooden tick.
  hover: [0.084, -26, (tr) => {
    tone(tr, { at: 0.001, len: 0.08, freq: glide(1480, 1568, 0.012), partials: MALLET, attack: 0.0015, decay: 0.022 });
  }],

  // UI click: a round little "bip".
  blip: [0.102, -18, (tr) => {
    fmPluck(tr, 0.001, glide(hz("C6"), 1108, 0.03), 1, 0.03, { len: 0.1 });
    tone(tr, { at: 0.001, len: 0.1, freq: hz("C5"), amp: 0.25, attack: 0.002, decay: 0.03 });
  }],

  // Lumo poked: a soft thump and a springy "boi-oing".
  slap: [0.602, -8, (tr) => {
    tone(tr, { at: 0.001, len: 0.25, freq: glide(200, 95, 0.07), amp: 1, attack: 0.002, decay: 0.06 });
    noise(tr, { at: 0.001, len: 0.03, type: "bp", f: 1800, q: 0.9, amp: 0.35, attack: 0.0008, decay: 0.008 });
    tone(tr, {
      at: 0.01, len: 0.55, partials: SOFT, amp: 0.55, attack: 0.004, decay: 0.16,
      freq: (t) => 520 * (1 + 0.09 * Math.exp(-t / 0.12) * Math.sin(TAU * 16 * t)),
    });
    reverb(tr, { mix: 0.12, size: 0.6 });
  }],

  // Poked again: a muffled two-note "hmph".
  annoyed: [0.592, -12, (tr) => {
    tone(tr, { at: 0.003, len: 0.17, freq: glide(hz("D5"), hz("D5") * 0.98, 0.15), partials: HUM, amp: 0.8, attack: 0.015, decay: 0.12 });
    tone(tr, {
      at: 0.17, len: 0.4, freq: glide(hz("A4"), hz("A4") * 0.94, 0.3), partials: HUM, amp: 0.9,
      attack: 0.02, decay: 0.2, vib: 0.01, vibRate: 9, vibDelay: 0.05,
    });
    lowpass(tr, 1600);
    reverb(tr, { mix: 0.12, size: 0.7 });
  }],

  // Poked too much: a wobbly falling swirl with stars twinkling around it.
  dizzy: [0.982, -9, (tr) => {
    const fall = glide(820, 360, 0.85);
    tone(tr, {
      at: 0.003, len: 0.95, partials: SOFT, amp: 0.6, attack: 0.03, decay: 0.45,
      freq: (t) => fall(t) * (1 + 0.05 * Math.sin(TAU * 6.5 * t)),
    });
    for (const [at, n, a] of [[0.08, "C7", 0.22], [0.26, "A6", 0.2], [0.44, "E7", 0.15], [0.62, "G6", 0.16], [0.78, "D7", 0.12]]) {
      chime(tr, at, hz(n), a, 0.06);
    }
    reverb(tr, { mix: 0.25, size: 1 });
  }],

  // Clicked hello: a bright rising "hi!".
  greet: [0.751, -6, (tr) => {
    bubble(tr, 0.003, 400, 800, 0.04, 0.5, 0.04);
    fmPluck(tr, 0.02, hz("G5"), 0.7, 0.14);
    bell(tr, 0.02, hz("G5"), 0.35, 0.2);
    fmPluck(tr, 0.11, glide(hz("C6"), hz("C6") * 1.012, 0.05), 0.85, 0.25);
    bell(tr, 0.11, hz("C6"), 0.45, 0.3);
    chime(tr, 0.2, hz("G6"), 0.15, 0.1);
    reverb(tr, { mix: 0.22, size: 0.9 });
  }],

  // An agent starts working: two little bubbles rising.
  work: [0.376, -16, (tr) => {
    bubble(tr, 0.002, hz("G4"), hz("G5"), 0.03, 0.8, 0.05);
    fmPluck(tr, 0.004, hz("G5"), 0.5, 0.07);
    bubble(tr, 0.1, hz("C5"), hz("C6"), 0.03, 0.8, 0.05);
    fmPluck(tr, 0.102, hz("C6"), 0.6, 0.09);
    reverb(tr, { mix: 0.18, size: 0.7 });
  }],

  // Agent done: a warm glowing arpeggio over a soft bed.
  finish: [1.159, -6, (tr) => {
    [["C6", 0.003, 0.75, 0.35], ["E6", 0.075, 0.8, 0.35], ["G6", 0.15, 0.85, 0.4], ["C7", 0.225, 1, 0.5]]
      .forEach(([n, at, a, d]) => bell(tr, at, hz(n), a, d));
    for (const n of ["C5", "G5"]) tone(tr, { at: 0.1, freq: hz(n), amp: 0.15, attack: 0.15, decay: 0.4 });
    reverb(tr, { mix: 0.28, size: 1.1, fb: 0.8 });
  }],

  // Something failed: a gentle falling "uh-oh", not an alarm.
  error: [0.838, -8, (tr) => {
    tone(tr, { at: 0.003, len: 0.2, freq: hz("E5"), partials: SOFT, amp: 0.85, fm: 0.7, fmDecay: 0.06, attack: 0.006, decay: 0.18 });
    tone(tr, { at: 0.17, freq: glide(hz("C#5"), hz("C#5") * 0.97, 0.4), partials: SOFT, amp: 1, fm: 0.7, fmDecay: 0.06, attack: 0.008, decay: 0.3 });
    tone(tr, { at: 0.17, freq: glide(hz("C#4"), hz("C#4") * 0.97, 0.4), amp: 0.25, attack: 0.01, decay: 0.3 });
    lowpass(tr, 3000);
    reverb(tr, { mix: 0.2, size: 0.9 });
  }],

  // Permission request: a clear two-note "ding-ding" up, friendly.
  approval: [0.877, -6, (tr) => {
    bell(tr, 0.003, hz("A5"), 0.9, 0.3, { fm: 0.5, fmDecay: 0.05 });
    bell(tr, 0.15, hz("E6"), 1, 0.35, { fm: 0.5, fmDecay: 0.05 });
    chime(tr, 0.15, hz("E7"), 0.15, 0.08);
    reverb(tr, { mix: 0.25, size: 1 });
  }],

  // An agent asks something: "hm?", the second note lifting at the end.
  question: [0.704, -7, (tr) => {
    tone(tr, { at: 0.003, len: 0.2, freq: hz("G5"), partials: SOFT, amp: 0.8, fm: 0.9, attack: 0.008, decay: 0.15 });
    tone(tr, {
      at: 0.16, len: 0.5, freq: glide(hz("D6"), hz("E6"), 0.16, 0.06), partials: SOFT, amp: 1,
      fm: 0.9, attack: 0.01, decay: 0.25, vib: 0.004, vibRate: 6, vibDelay: 0.1,
    });
    reverb(tr, { mix: 0.22, size: 0.9 });
  }],

  // Approved: quick bright "ta-ding".
  approve: [0.596, -8, (tr) => {
    fmPluck(tr, 0.003, hz("C6"), 0.7, 0.12);
    bell(tr, 0.003, hz("C6"), 0.4, 0.15);
    fmPluck(tr, 0.075, hz("G6"), 0.8, 0.18);
    bell(tr, 0.075, hz("G6"), 0.5, 0.25);
    reverb(tr, { mix: 0.22, size: 0.9 });
  }],

  // A file swallowed: "gul-p", then Lumo glows a little.
  gulp: [0.749, -8, (tr) => {
    tone(tr, { at: 0.003, len: 0.2, freq: glide(720, 210, 0.11), partials: [[1, 1], [2, 0.2, 2]], amp: 1, attack: 0.004, decay: 0.07 });
    bubble(tr, 0.15, 260, 620, 0.035, 0.6, 0.04);
    bell(tr, 0.3, hz("G6"), 0.35, 0.18, { attack: 0.02 });
    bell(tr, 0.36, hz("D7"), 0.2, 0.15, { attack: 0.015 });
    reverb(tr, { mix: 0.2, size: 0.9 });
  }],

  // A toggle flipped: a tiny wooden tick.
  tick: [0.072, -26, (tr) => {
    tone(tr, { at: 0.001, len: 0.068, freq: hz("A6"), partials: MALLET, attack: 0.001, decay: 0.014 });
    noise(tr, { at: 0.001, len: 0.008, type: "hp", f: 4000, q: 0.7, amp: 0.15, attack: 0.0005, decay: 0.0015 });
  }],

  // Chat message sent: off it flies, with a spark.
  send: [0.479, -14, (tr) => {
    whoosh(tr, 0, 0.3, 700, 3200, 0.6, 0.12);
    tone(tr, { at: 0, len: 0.25, freq: glide(660, 1760, 0.13), partials: SOFT, amp: 0.45, attack: 0.01, decay: 0.06 });
    chime(tr, 0.13, hz("C7"), 0.25, 0.08);
    reverb(tr, { mix: 0.2, size: 0.7 });
  }],

  // Hearts: two warm swelling notes with a little vibrato and a sparkle.
  love: [0.791, -9, (tr) => {
    tone(tr, { at: 0.003, len: 0.3, freq: hz("C6"), partials: SOFT, amp: 0.7, attack: 0.03, decay: 0.25, vib: 0.006, vibDelay: 0.05 });
    tone(tr, { at: 0.17, len: 0.6, freq: hz("E6"), partials: SOFT, amp: 0.85, attack: 0.035, decay: 0.32, vib: 0.006, vibDelay: 0.05 });
    bell(tr, 0.17, hz("E6"), 0.25, 0.3);
    chime(tr, 0.3, hz("G7"), 0.12, 0.08);
    chime(tr, 0.4, hz("C7"), 0.1, 0.08);
    reverb(tr, { mix: 0.28, size: 1 });
  }],

  // Bubble pop, and a smaller one after it.
  pop: [0.38, -16, (tr) => {
    bubble(tr, 0.002, 280, 900, 0.04, 1, 0.035);
    bubble(tr, 0.085, 420, 1250, 0.03, 0.35, 0.025);
    reverb(tr, { mix: 0.18, size: 0.6 });
  }],

  // Proud: a mini fanfare up to a held, shimmering note.
  proud: [0.864, -6, (tr) => {
    [["G5", 0.003, 0.6], ["B5", 0.075, 0.65], ["D6", 0.15, 0.7]].forEach(([n, at, a]) => fmPluck(tr, at, hz(n), a, 0.1));
    bell(tr, 0.23, hz("G6"), 1, 0.4, { vib: 0.004, vibRate: 6, vibDelay: 0.15 });
    fmPluck(tr, 0.23, hz("G6"), 0.5, 0.2);
    chime(tr, 0.3, hz("D7"), 0.15, 0.1);
    reverb(tr, { mix: 0.26, size: 1 });
  }],

  // Wink: a quick double sparkle, "ti-ting".
  wink: [0.213, -18, (tr) => {
    chime(tr, 0.003, hz("G6"), 0.7, 0.04);
    chime(tr, 0.055, hz("D7"), 0.55, 0.05);
    reverb(tr, { mix: 0.15, size: 0.5 });
  }],

  // Yawn: a soft hummed rise and long fall, with a breath through it.
  yawn: [0.73, -16, (tr) => {
    const up = glide(480, 680, 0.25);
    const down = glide(680, 380, 0.4, 0.25);
    const env = (t) => (t < 0.12 ? Math.sin((Math.PI / 2) * (t / 0.12)) ** 2
      : t < 0.45 ? 1 - (0.25 * (t - 0.12)) / 0.33
      : t < 0.7 ? 0.75 * Math.cos((Math.PI / 2) * ((t - 0.45) / 0.25)) ** 2 : 0);
    tone(tr, { at: 0.003, len: 0.72, freq: (t) => (t < 0.25 ? up(t) : down(t)), partials: HUM, amp: 0.6, env });
    noise(tr, { at: 0.003, len: 0.72, type: "bp", f: 1100, q: 0.8, amp: 0.25, env });
    lowpass(tr, 1600);
    reverb(tr, { mix: 0.15, size: 0.8 });
  }],

  // A file attached: two warm plucks and a glint.
  attach: [0.903, -8, (tr) => {
    pluck(tr, { at: 0.003, freq: hz("A5"), amp: 0.8, decay: 0.25, bright: 0.3 });
    pluck(tr, { at: 0.065, freq: hz("E6"), amp: 0.75, decay: 0.3, bright: 0.3 });
    bell(tr, 0.13, hz("A6"), 0.25, 0.2);
    reverb(tr, { mix: 0.26, size: 1 });
  }],

  // Thinking: three soft wandering dots.
  think: [0.44, -14, (tr) => {
    [["E5", 0.003, 0.6], ["D5", 0.11, 0.7], ["G5", 0.22, 0.85]]
      .forEach(([n, at, a]) => tone(tr, { at, len: 0.2, freq: hz(n), partials: MALLET, amp: a, fm: 0.5, fmDecay: 0.02, attack: 0.002, decay: 0.05 }));
    reverb(tr, { mix: 0.18, size: 0.6 });
  }],

  // Searching: a soft sonar ping and its echoes.
  search: [0.457, -14, (tr) => {
    tone(tr, { at: 0.003, len: 0.15, freq: glide(1240, 1320, 0.03), partials: [[1, 1], [2, 0.08, 2]], amp: 1, attack: 0.004, decay: 0.05 });
    echo(tr, { time: 0.11, fb: 0.38, mix: 0.55, tone: 0.35 });
    reverb(tr, { mix: 0.12, size: 0.7 });
  }],

  // Rate limit: three wooden notes stepping down and slowing, "take a breather".
  rate: [0.674, -10, (tr) => {
    tone(tr, { at: 0.003, len: 0.2, freq: hz("G5"), partials: MALLET, amp: 1, attack: 0.002, decay: 0.09 });
    tone(tr, { at: 0.16, len: 0.24, freq: hz("E5"), partials: MALLET, amp: 0.85, attack: 0.002, decay: 0.09 });
    tone(tr, { at: 0.37, len: 0.3, freq: glide(hz("C5"), hz("C5") * 0.97, 0.2), partials: MALLET, amp: 0.8, attack: 0.002, decay: 0.1 });
    reverb(tr, { mix: 0.2, size: 0.8 });
  }],

  // Falling asleep: two mellow notes drifting down.
  sleep: [0.453, -18, (tr) => {
    tone(tr, { at: 0.003, len: 0.2, freq: hz("E5"), partials: SOFT, amp: 0.8, attack: 0.02, decay: 0.12 });
    tone(tr, { at: 0.15, len: 0.3, freq: glide(hz("C5"), hz("C5") * 0.985, 0.25), partials: SOFT, amp: 0.75, attack: 0.03, decay: 0.16 });
    lowpass(tr, 2500);
    reverb(tr, { mix: 0.2, size: 0.9 });
  }],

  // The launch greeting. Lined up with the animation in src/mochi/greeting.ts:
  // fall-in sparkles (0–0.55), ring burst 0.45, land 0.56, bounce 0.63,
  // slide 0.85, plunge 1.2 and spring 1.3, the wave and its little tune
  // (1.45–2.45, the glow pulsing at the hand's 5 Hz), tuck 2.45, badge 2.72,
  // glide back 2.85–3.45, blinks 3.05 and 3.7, blue glow chord from 3.85.
  greeting: [4.173, -6, (tr) => {
    // Fall-in: warp streaks as a falling breath, sparkles stepping down.
    whoosh(tr, 0, 0.55, 3000, 800, 0.15, 0.35);
    ["G7", "E7", "D7", "C7", "A6", "G6", "E6", "D6"].forEach((n, i) =>
      chime(tr, 0.03 + i * 0.06, hz(n), 0.05 + i * 0.015, 0.05));
    // Ring burst: a soft bloom.
    for (const n of ["C5", "G5"]) tone(tr, { at: 0.45, len: 0.6, freq: hz(n), amp: 0.25, attack: 0.05, decay: 0.3 });
    chime(tr, 0.45, hz("C7"), 0.3, 0.2);
    // Land, bounce.
    tone(tr, { at: 0.555, len: 0.2, freq: glide(330, 196, 0.06), amp: 0.7, attack: 0.003, decay: 0.06 });
    bubble(tr, 0.63, 330, 880, 0.08, 0.55, 0.07);
    fmPluck(tr, 0.72, hz("C6"), 0.4, 0.1);
    // Slide to the side.
    whoosh(tr, 0.85, 0.35, 600, 1200, 0.1, 0.15);
    // Plunge and spring.
    tone(tr, { at: 1.2, len: 0.12, freq: glide(hz("C5"), hz("G4"), 0.1), partials: SOFT, amp: 0.25, attack: 0.01, decay: 0.08 });
    bubble(tr, 1.3, hz("G4"), hz("D6"), 0.06, 0.6, 0.06);
    fmPluck(tr, 1.36, hz("G6"), 0.5, 0.12);
    // The wave: a little tune, the glow pulsing at the hand's rate underneath.
    for (const n of ["C5", "E5", "G5"]) {
      tone(tr, { at: 1.45, len: 1.0, freq: hz(n), amp: 0.12, env: swell(1.0, 0.35), trem: 0.5, tremRate: 5 });
    }
    [["C6", 1.45, 0.55], ["E6", 1.55, 0.5], ["G6", 1.65, 0.6], ["E6", 1.85, 0.55]].forEach(([n, at, a]) => {
      fmPluck(tr, at, hz(n), a * 0.6, 0.1);
      bell(tr, at, hz(n), a * 0.5, 0.18);
    });
    // "Cou-cou": the brightest moment, two notes falling a third.
    fmPluck(tr, 2.05, hz("G6"), 0.6, 0.18);
    bell(tr, 2.05, hz("G6"), 1, 0.3);
    fmPluck(tr, 2.25, hz("E6"), 0.55, 0.2);
    bell(tr, 2.25, hz("E6"), 0.95, 0.35, { vib: 0.004, vibRate: 5, vibDelay: 0.1 });
    // Tuck the hands.
    tone(tr, { at: 2.45, len: 0.25, freq: glide(hz("G5"), hz("C5"), 0.22), partials: SOFT, amp: 0.25, attack: 0.02, decay: 0.12 });
    // Badge pops in.
    bubble(tr, 2.72, 300, 950, 0.035, 0.6, 0.03);
    chime(tr, 2.74, hz("C7"), 0.2, 0.06);
    // Glide back to the centre, a few motes trailing.
    whoosh(tr, 2.85, 0.6, 400, 1400, 0.12, 0.3);
    [["E7", 2.95, 0.12], ["D7", 3.15, 0.1], ["G6", 3.35, 0.1]].forEach(([n, at, a]) => chime(tr, at, hz(n), a, 0.07));
    // Blinks.
    for (const at of [3.05, 3.7]) tone(tr, { at, len: 0.06, freq: hz("G6"), partials: MALLET, amp: 0.12, attack: 0.002, decay: 0.015 });
    // Blue glow: a warm chord swelling in, bells on top.
    for (const n of ["C5", "E5", "G5", "C6"]) tone(tr, { at: 3.55, freq: hz(n), amp: 0.1, env: swell(0.62, 0.4) });
    bell(tr, 3.85, hz("C6"), 0.6, 0.4);
    bell(tr, 3.88, hz("G6"), 0.5, 0.4);
    bell(tr, 3.91, hz("C7"), 0.35, 0.35);
    reverb(tr, { mix: 0.25, size: 1.1 });
  }],
};

// ── Main ──────────────────────────────────────────────────────────────────────

/** The names the app loads (SOUND_NAMES in src/core/sound.ts) must be exactly these. */
function checkNames() {
  const src = readFileSync(join(ROOT, "src", "core", "sound.ts"), "utf8");
  const m = /SOUND_NAMES\s*=\s*\[([\s\S]*?)\]/.exec(src);
  if (!m) return;
  const names = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
  const ours = Object.keys(SOUNDS).sort();
  if (names.join() !== ours.join()) {
    throw new Error(`SOUND_NAMES (${names.join(", ")}) and this script (${ours.join(", ")}) differ`);
  }
}

checkNames();
mkdirSync(OUT, { recursive: true });
console.log("sound       dur s   peak dBFS");
for (const [name, [dur, peakDb, build]] of Object.entries(SOUNDS)) {
  const tr = new Track(name, dur);
  build(tr);
  lowpass(tr, 7000); // nothing fizzy up top
  const pcm = master(tr, peakDb);
  let peak = 0;
  for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  writeFileSync(join(OUT, `${name}.wav`), wav(pcm));
  console.log(`${name.padEnd(10)} ${(pcm.length / SR).toFixed(3).padStart(6)}   ${(20 * Math.log10(peak / 32768)).toFixed(2).padStart(6)}`);
}
console.log(`${Object.keys(SOUNDS).length} sounds written to ${OUT}`);
