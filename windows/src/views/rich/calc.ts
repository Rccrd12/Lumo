// The ```lumo-calc and ```lumo-plot cards: a formula to play with, its
// inputs on sliders. The model declares them; it never writes code:
//
//   ```lumo-calc Ohm's law
//   formula: I = \frac{V}{R}
//   input: V | voltage | 0..24 | 12 | V
//   input: R | resistance | 1..100 | 10 | Ω
//   output: I | current | V / R | A
//   output: P | power | V * I | W
//   ```
//
//   ```lumo-plot Sine wave
//   formula: y = A\sin(\omega x)
//   y: A * sin(omega * x)
//   x: 0..12
//   input: A | amplitude | 0..2 | 1.4
//   input: omega | angular frequency | 0.5..4 | 1.6 | rad/s
//   ```
//
// An input is `symbol | name | min..max | value | unit`, the unit optional, a
// step after the range (`0..10 step 0.5`) or as a sixth field. An output is
// `symbol | name | expression | unit`, its expression over the inputs and
// the outputs above it. A chart draws one to three `y:` curves of x over
// `x: min..max` (else -10..10), between `yrange: min..max` or, without one,
// what its curves span wherever its sliders go (see autoRange), so a
// slider's change shows against a fixed frame. The formulas are read by
// core/expr.ts.
//
// Forgiving where models slip (a key's case, `$ω$` for omega, a unit written
// into the value, `y: -1..1` for the range), but a block whose formulas can't
// be read, or which names something it never declares, is no card: null,
// and markdown.ts shows it as code.

import { h } from "../dom";
import { compile, normalizeName, GREEK, type Expr } from "../../core/expr";
import { language } from "../../i18n/i18n";
import { head, remember, type RichContext } from "./index";
import "./calc.css";
import { onResize } from "./resize";

export const MAX_CALC_INPUTS = 6;
export const MAX_CALC_OUTPUTS = 6;
export const MAX_PLOT_INPUTS = 4;
export const MAX_CURVES = 3;
/** The chart's height, in CSS pixels, at the least: the island is low. */
export const PLOT_HEIGHT = 92;
/** The chart's height at the most, however tall the island is pulled. */
export const PLOT_MAX_HEIGHT = 460;

/**
 * The chart's height for a chat log `log` CSS pixels high, with `chrome` of
 * the card around the chart (its top line, the sliders), when the curves
 * would look their best `want` high (idealHeight): as tall as they want, as
 * far as the whole card fits the log; never under PLOT_HEIGHT.
 */
export function plotHeight(log: number, chrome: number, want = PLOT_MAX_HEIGHT): number {
  const room = Math.min(PLOT_MAX_HEIGHT, log - chrome - 12);
  return Math.round(Math.max(PLOT_HEIGHT, Math.min(want, room)));
}

/**
 * How high the chart wants to be for its curves to read well. A wave or a
 * line spreads evenly over the chart's height and reads at PLOT_HEIGHT; an
 * exponential or a parabola spends most of its length in a band of it (along
 * the bottom, near its vertex) and asks for more, the narrower that band the
 * more. The band is the middle half of where the curve's points fall, as a
 * share of the y range; the narrowest curve decides. A flat line asks for
 * nothing. Read at the inputs' first values, so the card keeps its height
 * while the sliders move.
 */
export function idealHeight(plot: Plot): number {
  const [x0, x1] = plot.x;
  const [y0, y1] = plot.y;
  const scope: Record<string, number> = Object.create(null);
  for (const i of plot.inputs) scope[i.name] = i.value;
  const n = 240;
  let narrowest = 0.5;
  for (const curve of plot.curves) {
    const at: number[] = [];
    for (let i = 0; i <= n; i++) {
      scope.x = x0 + ((x1 - x0) * i) / n;
      const v = safe(curve.expr, scope);
      if (Number.isFinite(v) && v >= y0 && v <= y1) at.push((v - y0) / (y1 - y0));
    }
    if (at.length < 12) continue;
    at.sort((a, b) => a - b);
    const band = at[Math.floor(at.length * 0.75)] - at[Math.floor(at.length * 0.25)];
    if (band >= 0.02) narrowest = Math.min(narrowest, band);
  }
  return PLOT_HEIGHT * (0.5 / narrowest) ** 2;
}
/** The curves' colours, in order: the cards' accent, then green and amber. */
export const CURVE_COLORS = ["#8fc7ff", "#34d399", "#f5a524"];

export interface Input {
  /** The name the formulas use (omega, V_out). */
  name: string;
  /** What it is, in the model's words; "" when it gave none. */
  label: string;
  min: number;
  max: number;
  step: number;
  /** Where its slider starts. */
  value: number;
  unit: string;
}

export interface Output {
  name: string;
  label: string;
  expr: Expr;
  unit: string;
}

export interface Calc {
  title: string;
  /** TeX shown in the top line; "" when there is none. */
  formula: string;
  inputs: Input[];
  outputs: Output[];
}

export interface Plot {
  title: string;
  formula: string;
  /** The curves, each a formula of x, with the text they were written as. */
  curves: { expr: Expr; source: string }[];
  x: [number, number];
  /** The y range: given, or what the curves span at the inputs' first values. */
  y: [number, number];
  inputs: Input[];
}

// ── Reading ───────────────────────────────────────────────────────────────────

/** `input: …`, `- Output = …`: a line's key and the rest. */
const LINE = /^[ \t]*(?:[-*+•][ \t]+)?([A-Za-z]+)[ \t]*[:=][ \t]*(.*?)[ \t]*$/;
const FORMULA_KEYS = new Set(["formula", "tex", "equation", "latex"]);
const INPUT_KEYS = new Set(["input", "in", "slider", "param", "parameter", "var", "variable"]);
const OUTPUT_KEYS = new Set(["output", "out", "result"]);
const CURVE_KEYS = new Set(["y", "f", "curve", "plot"]);
const X_KEYS = new Set(["x", "xrange", "domain"]);
const Y_KEYS = new Set(["yrange", "range"]);

interface Line {
  key: string;
  value: string;
}

function lines(body: string): Line[] {
  const out: Line[] = [];
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    const m = LINE.exec(raw);
    if (m) out.push({ key: m[1].toLowerCase(), value: m[2] });
  }
  return out;
}

/** A formula with no names in it (2, -0.5, 2pi), or null. */
function constant(text: string): number | null {
  try {
    const expr = compile(text);
    if (expr.vars.length) return null;
    const v = expr.evaluate({});
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** `0..24`, `-1 … 1`, `0 to 2pi`, `1–100`, with `step 0.5` after it or not. */
export function parseRange(text: string): { min: number; max: number; step: number | null } | null {
  const m = /^\s*\[?\s*(.+?)\s*(?:\.\.\.?|…|\bto\b|–|—)\s*(.+?)\s*\]?\s*(?:\bstep\s*[:=]?\s*(.+?))?\s*$/i.exec(text);
  if (!m) return null;
  let min = constant(m[1]);
  let max = constant(m[2]);
  if (min === null || max === null || min === max) return null;
  if (min > max) [min, max] = [max, min];
  const step = m[3] != null ? constant(m[3]) : null;
  return { min, max, step: step !== null && step > 0 ? step : null };
}

/** 1, 2 or 5 times a power of ten, the nearest to `raw`. */
export function roundStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/**
 * A slider's step when the model gave none: about a hundredth of the range,
 * so it moves finely. A range of a few units to a few tens (an amplitude of
 * 0..2, a voltage of 0..24), the kind most played with, moves by tenths
 * instead: its value reads with one decimal (1.4, not 1.40) and still has
 * twenty stops or more.
 */
export function niceStep(span: number): number {
  if (span >= 2 && span < 50) return 0.1;
  return roundStep(span / 100);
}

/**
 * A line's fields: split on `|`, or, in a line with none, on the commas
 * outside parentheses, the way the system prompt spells the template (it
 * can't show a `|`), so `max(a, b)` stays one field.
 */
export function fieldsOf(text: string): string[] {
  if (text.includes("|")) return text.split("|").map((f) => f.trim());
  const fields: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if ((c === ")" || c === "]" || c === "}") && depth > 0) depth--;
    else if (c === "," && depth === 0) {
      fields.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  fields.push(text.slice(from).trim());
  return fields;
}

/** `V | voltage | 0..24 | 12 | V`, and the shapes near it; null when it has no name or range. */
export function parseInput(text: string): Input | null {
  const fields = fieldsOf(text);
  const name = normalizeName(fields[0] ?? "");
  if (!name) return null;
  const at = fields.findIndex((f, i) => i > 0 && parseRange(f) !== null);
  if (at < 0) return null;
  const range = parseRange(fields[at])!;
  const label = fields.slice(1, at).filter(Boolean).join(" · ");
  const rest = fields.slice(at + 1);
  let value: number | null = null;
  let unit = "";
  let step = range.step;
  if (rest.length) {
    value = constant(rest[0]);
    if (value === null) {
      // `12 V`: a value with its unit, or a unit and no value.
      const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(.*)$/i.exec(rest[0]);
      if (m) {
        value = Number(m[1]);
        unit = m[2];
      } else unit = rest[0];
      rest.shift();
    } else rest.shift();
  }
  if (rest.length && !unit) unit = rest.shift()!;
  if (rest.length && step === null) {
    const s = constant(rest[0]);
    if (s !== null && s > 0) step = s;
  }
  const span = range.max - range.min;
  if (step === null || step > span) step = niceStep(span);
  if (value === null) value = range.min + span / 2;
  value = Math.min(range.max, Math.max(range.min, value));
  return { name, label, min: range.min, max: range.max, step, value, unit };
}

/**
 * `I | current | V / R | A`, or `I = V / R | current | A`, or `I | V / R`;
 * its formula read, null when it can't be.
 */
function parseOutput(text: string): Output | null {
  const fields = fieldsOf(text);
  let name: string | null;
  let label = "";
  let source: string;
  let unit = "";
  const eq = fields[0].indexOf("=");
  if (eq > 0) {
    name = normalizeName(fields[0].slice(0, eq));
    source = fields[0].slice(eq + 1);
    [label = "", unit = ""] = fields.slice(1);
  } else if (fields.length >= 3) {
    name = normalizeName(fields[0]);
    [label, source, unit = ""] = fields.slice(1);
  } else if (fields.length === 2) {
    name = normalizeName(fields[0]);
    source = fields[1];
  } else return null;
  if (!name) return null;
  try {
    return { name, label, expr: compile(source), unit };
  } catch {
    return null;
  }
}

/** A formula for the top line: what is between `$`s, or the whole. */
function formulaOf(text: string): string {
  const s = text.trim();
  const m = /^\$\$?([\s\S]+?)\$?\$$/.exec(s) ?? /^\\\(([\s\S]+)\\\)$/.exec(s) ?? /^\\\[([\s\S]+)\\\]$/.exec(s);
  return (m ? m[1] : s).trim();
}

/** The inputs of a block, null when one can't be read or two share a name. */
function inputsOf(found: Line[], max: number): Input[] | null {
  const inputs: Input[] = [];
  for (const line of found) {
    if (!INPUT_KEYS.has(line.key)) continue;
    const input = parseInput(line.value);
    if (!input || inputs.some((i) => i.name === input.name)) return null;
    inputs.push(input);
  }
  return inputs.length <= max ? inputs : null;
}

/** Reads a lumo-calc block; null when it is no calculator (see the top of the file). */
export function parseCalc(title: string, body: string): Calc | null {
  const found = lines(body);
  const inputs = inputsOf(found, MAX_CALC_INPUTS);
  if (!inputs || !inputs.length) return null;
  const known = new Set(inputs.map((i) => i.name));
  const outputs: Output[] = [];
  let formula = "";
  for (const line of found) {
    if (FORMULA_KEYS.has(line.key)) formula ||= formulaOf(line.value);
    if (!OUTPUT_KEYS.has(line.key)) continue;
    const output = parseOutput(line.value);
    if (!output || known.has(output.name)) return null;
    // Only what is declared above it: an input, or an output before it.
    if (!output.expr.vars.every((v) => known.has(v))) return null;
    known.add(output.name);
    outputs.push(output);
  }
  if (!outputs.length || outputs.length > MAX_CALC_OUTPUTS) return null;
  return { title: title.trim(), formula, inputs, outputs };
}

/** Reads a lumo-plot block; null when it is no chart (see the top of the file). */
export function parsePlot(title: string, body: string): Plot | null {
  const found = lines(body);
  const inputs = inputsOf(found, MAX_PLOT_INPUTS);
  if (!inputs || inputs.some((i) => i.name === "x")) return null;
  const known = new Set(["x", ...inputs.map((i) => i.name)]);
  const curves: Plot["curves"] = [];
  let x: [number, number] = [-10, 10];
  let y: [number, number] | null = null;
  let formula = "";
  for (const line of found) {
    if (FORMULA_KEYS.has(line.key)) formula ||= formulaOf(line.value);
    else if (X_KEYS.has(line.key)) {
      const r = parseRange(line.value);
      if (!r) return null;
      x = [r.min, r.max];
    } else if (Y_KEYS.has(line.key) || (CURVE_KEYS.has(line.key) && parseRange(line.value))) {
      // `y: -1..1` is a range, not a curve.
      const r = parseRange(line.value);
      if (!r) return null;
      y = [r.min, r.max];
    } else if (CURVE_KEYS.has(line.key)) {
      let expr: Expr;
      try {
        expr = compile(line.value);
      } catch {
        return null;
      }
      if (!expr.vars.every((v) => known.has(v))) return null;
      curves.push({ expr, source: line.value });
    }
  }
  if (!curves.length || curves.length > MAX_CURVES) return null;
  const plot: Plot = { title: title.trim(), formula, curves, x, y: y ?? [-1, 1], inputs };
  if (!y) {
    // The chat reads a block again at each redraw: its frame is worked out once.
    let frame = FRAMES.get(body);
    if (!frame) {
      frame = autoRange(plot, startValues(inputs));
      if (FRAMES.size >= 64) FRAMES.delete(FRAMES.keys().next().value!);
      FRAMES.set(body, frame);
    }
    plot.y = [...frame];
  }
  return plot;
}

/** The auto frames of the charts read lately, by their block's text. */
const FRAMES = new Map<string, [number, number]>();

/** The inputs' first values, by name. */
function startValues(inputs: Input[]): Record<string, number> {
  const values: Record<string, number> = Object.create(null);
  for (const i of inputs) values[i.name] = i.value;
  return values;
}

/**
 * The frame a chart is drawn in when the model gave none: what its curves
 * span over x for every place its sliders can take them (each at its
 * start, its least and its most), so the curve never leaves the frame as a
 * slider moves, padded a twentieth on each side. When that is far wider
 * than the curves at the sliders' start (exp(k·x) with a large k), the
 * curves at the start would be a flat line: the frame is theirs instead.
 * A curve that shoots off (tan near its poles) would flatten the rest too:
 * when its values beyond the middle nine tenths reach more than four times
 * as far as the middle does, and they rise there without end, they are left
 * out. A bounded curve (a sine at any of its sliders' places, a resonance's
 * sharp peak) keeps its whole height.
 */
export function autoRange(plot: Pick<Plot, "curves" | "x"> & { inputs?: Input[] }, values: Record<string, number>): [number, number] {
  const start = spanOf(plot, [values], 240);
  if (!start) return [-1, 1];
  const inputs = plot.inputs ?? [];
  let frame = start;
  if (inputs.length) {
    let scopes: Record<string, number>[] = [{ ...values }];
    for (const i of inputs) {
      const at = [...new Set([i.min, values[i.name] ?? i.value, i.max])];
      scopes = scopes.flatMap((scope) => at.map((v) => ({ ...scope, [i.name]: v })));
    }
    // Some 10,000 points at most: four sliders make 81 places.
    const n = Math.max(40, Math.min(240, Math.round(10000 / (scopes.length * plot.curves.length))));
    const all = spanOf(plot, scopes, n);
    // A curve flat at the start (A·sin x with A at 0) has no span to compare
    // with: the sliders alone make its shape, so the frame is theirs.
    const flat = start[1] - start[0] < 1e-9 * Math.max(1, Math.abs(start[1]));
    if (all && (flat || all[1] - all[0] <= 20 * (start[1] - start[0]))) frame = all;
  }
  const [lo, hi] = frame;
  if (hi - lo < 1e-9 * Math.max(1, Math.abs(hi))) {
    const pad = Math.abs(hi) / 2 || 1;
    return [lo - pad, hi + pad];
  }
  const pad = (hi - lo) / 20;
  return [lo - pad, hi + pad];
}

/**
 * The least and most the curves take over x in these scopes, null when none
 * is a number. Each curve at each place is measured on its own, so a pole in
 * one curve never cuts the peaks of another. A far value is left out (see
 * autoRange) only when it is a pole, one that grows without end between its
 * samples: a sharp peak (a resonance) is high but ends, and is kept.
 */
function spanOf(plot: Pick<Plot, "curves" | "x">, scopes: Record<string, number>[], n: number): [number, number] | null {
  const [x0, x1] = plot.x;
  const at = (i: number) => x0 + ((x1 - x0) * i) / n;
  let lo = Infinity;
  let hi = -Infinity;
  const values = new Float64Array(n + 1);
  const seen: number[] = [];
  for (const place of scopes) {
    const scope: Record<string, number> = { ...place, x: 0 };
    for (const curve of plot.curves) {
      seen.length = 0;
      let top = -1;
      let bottom = -1;
      for (let i = 0; i <= n; i++) {
        scope.x = at(i);
        const v = safe(curve.expr, scope);
        values[i] = v;
        if (!Number.isFinite(v)) continue;
        seen.push(v);
        if (top < 0 || v > values[top]) top = i;
        if (bottom < 0 || v < values[bottom]) bottom = i;
      }
      if (!seen.length) continue;
      seen.sort((a, b) => a - b);
      let least = seen[0];
      let most = seen[seen.length - 1];
      const qlo = seen[Math.floor(seen.length * 0.05)];
      const qhi = seen[Math.ceil(seen.length * 0.95) - 1];
      if (most - least > 4 * (qhi - qlo) && qhi > qlo) {
        const near = (i: number): [number, number] => [at(Math.max(0, i - 1)), at(Math.min(n, i + 1))];
        if (pole(curve.expr, scope, ...near(top), 1, most)) most = qhi;
        if (pole(curve.expr, scope, ...near(bottom), -1, least)) least = qlo;
      }
      lo = Math.min(lo, least);
      hi = Math.max(hi, most);
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * Whether a curve's highest sample (`sign` 1) or lowest (-1), `seen`, is
 * the edge of a pole between the samples around it, a to b: the most it
 * takes there, found by narrowing in, is a thousand times further out, or
 * no number at all (1/0).
 */
function pole(expr: Expr, scope: Record<string, number>, a: number, b: number, sign: 1 | -1, seen: number): boolean {
  const f = (x: number) => {
    scope.x = x;
    const v = safe(expr, scope) * sign;
    return Number.isNaN(v) ? -Infinity : v;
  };
  let most = seen * sign;
  for (let k = 0; k < 48 && b - a > 1e-12 * Math.max(1, Math.abs(a)); k++) {
    const m1 = a + (b - a) / 3;
    const m2 = b - (b - a) / 3;
    const f1 = f(m1);
    const f2 = f(m2);
    most = Math.max(most, f1, f2);
    if (most === Infinity) return true;
    if (f1 < f2) a = m1;
    else b = m2;
  }
  return most - seen * sign > 1000 * Math.max(Math.abs(seen), 1e-300);
}

/** A formula's value, NaN when it throws. */
function safe(expr: Expr, scope: Record<string, number>): number {
  try {
    return expr.evaluate(scope);
  } catch {
    return NaN;
  }
}

// ── Numbers ───────────────────────────────────────────────────────────────────

const formats = new Map<string, Intl.NumberFormat>();

function formatter(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const id = `${language()}|${JSON.stringify(options)}`;
  let f = formats.get(id);
  if (!f) {
    try {
      f = new Intl.NumberFormat(language(), options);
    } catch {
      f = new Intl.NumberFormat(undefined, options);
    }
    formats.set(id, f);
  }
  return f;
}

function format(options: Intl.NumberFormatOptions, n: number): string {
  return formatter(options).format(n);
}

const SUPERSCRIPT: Record<string, string> = { "-": "⁻", "−": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };

/**
 * A number in scientific notation as it is written by hand, 1.2 × 10⁻⁴,
 * rather than 1.2E-4, whose minus the tabular digits set far apart. Where
 * the language writes its own digits (Arabic), which have no superscript
 * forms, it stays as the language writes it.
 */
function scientific(options: Intl.NumberFormatOptions, n: number): string {
  const parts = formatter({ ...options, notation: "scientific" }).formatToParts(n);
  const at = parts.findIndex((p) => p.type === "exponentSeparator");
  if (at < 0) return parts.map((p) => p.value).join("");
  const mantissa = parts.slice(0, at).map((p) => p.value).join("");
  const exponent = parts.slice(at + 1).map((p) => p.value).join("");
  const sup = [...exponent].map((c) => SUPERSCRIPT[c] ?? "");
  if (sup.some((c) => !c)) return parts.map((p) => p.value).join("");
  if (exponent === "0") return mantissa;
  // Narrow no-break spaces: the number never breaks over two lines.
  return `${mantissa}\u202f×\u202f${format({ maximumFractionDigits: 0 }, 10)}${sup.join("")}`;
}

/**
 * A result in the app's language: three or four significant digits; "—"
 * when it is no number. From a ten-thousandth down, or from a million up,
 * in scientific notation, so the ones a slider moves through on their way
 * (0.00012 next to 0.00144) read alike.
 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return format({ maximumFractionDigits: 0 }, 0);
  const a = Math.abs(n);
  if (a >= 1e6 || a < 1e-4) return scientific({ minimumSignificantDigits: 3, maximumSignificantDigits: 3 }, n);
  if (a >= 1000) return format({ maximumFractionDigits: 0 }, n);
  return format({ minimumSignificantDigits: 3, maximumSignificantDigits: 4 }, n);
}

/**
 * A slider's value, with as many decimals as its step has, or as the value
 * itself has when it starts off the step's grid (9.81 on a step of 0.2). A
 * step finer than a millionth (a charge in coulombs, a wavelength in metres)
 * would need more decimals than a chip holds: such a value is written in
 * scientific notation, with the digits that tell one step from the next.
 */
export function formatValue(n: number, step: number, own = true): string {
  const need = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  if (need > 6) {
    if (n === 0) return format({ maximumFractionDigits: 0 }, 0);
    const digits = Math.min(21, Math.max(1, Math.floor(Math.log10(Math.abs(n)) + 1e-9) + need + 1));
    return scientific({ minimumSignificantDigits: digits, maximumSignificantDigits: digits }, n);
  }
  const mine = own ? (/\.(\d{1,4})$/.exec(String(n))?.[1].length ?? 0) : 0;
  const shown = Math.min(6, Math.max(need, mine));
  return format({ minimumFractionDigits: shown, maximumFractionDigits: shown }, n);
}

// ── Names as TeX ──────────────────────────────────────────────────────────────

const GREEK_NAMES = new Set(Object.values(GREEK));

/** A name's TeX: omega as \omega, V_out as V_{out}, a longer name such as speed as \mathit{speed}. */
export function texName(name: string): string {
  const cut = name.indexOf("_");
  const base = cut > 0 ? name.slice(0, cut) : name;
  const sub = cut > 0 ? name.slice(cut + 1) : "";
  const part = (s: string) => (GREEK_NAMES.has(s) && s !== "omicron" ? `\\${s}` : s.length > 1 ? `\\mathit{${s}}` : s);
  const subTex = sub
    .split("_")
    .filter(Boolean)
    .map((s) => (GREEK_NAMES.has(s) ? `\\${s}` : s))
    .join(",");
  return subTex ? `${part(base)}_{${subTex}}` : part(base);
}

// ── Drawing ───────────────────────────────────────────────────────────────────

/** The formula of the top line, small, on the right; nothing without one. */
function headFormula(formula: string, ctx: RichContext): HTMLElement | null {
  if (!formula) return null;
  return h("span", { class: "rc-head-tex", title: formula }, ctx.math(formula));
}

/**
 * An input's slider: its symbol, name and value over a track filled up to
 * the thumb. Moving it writes the value into `values` and calls `changed`.
 */
function slider(input: Input, values: Record<string, number>, ctx: RichContext, changed: () => void): HTMLElement {
  const chip = h("span", { class: "rc-slider-val" });
  // A range input only stops on min + k·step: when the span is no multiple
  // of the step (1..100000 by 1000) its last stop would fall short of max.
  // Its end goes up to the next stop, and that stop reads as max.
  const stops = (input.max - input.min) / input.step;
  const whole = Math.abs(stops - Math.round(stops)) < 1e-6;
  const end = whole ? input.max : Number((input.min + Math.ceil(stops) * input.step).toPrecision(12));
  const range = h("input", {
    class: "rc-range",
    type: "range",
    // The track fills from the left, in Arabic too, as a scale of numbers does.
    dir: "ltr",
    min: input.min,
    max: end,
    step: input.step,
    value: values[input.name],
    "aria-label": input.label || input.name,
  }) as HTMLInputElement;
  const show = () => {
    const v = values[input.name];
    const text = `${formatValue(v, input.step)}${input.unit ? ` ${input.unit}` : ""}`;
    chip.textContent = text;
    range.setAttribute("aria-valuetext", text);
    const share = (v - input.min) / (input.max - input.min);
    range.style.setProperty("--p", `${Math.round(Math.min(1, Math.max(0, share)) * 1000) / 10}%`);
  };
  range.addEventListener("input", () => {
    const v = Number(range.value);
    if (!Number.isFinite(v)) return;
    values[input.name] = Math.min(input.max, v);
    show();
    changed();
  });
  show();
  const top = h("div", { class: "rc-slider-top" }, h("span", { class: "rc-slider-sym" }, ctx.math(texName(input.name))));
  if (input.label) top.append(h("span", { class: "rc-slider-name", text: input.label, title: input.label }));
  top.append(h("span", { class: "rc-sp" }), chip);
  return h("div", { class: "rc-slider" }, top, range);
}

/** The values a card's sliders are at, kept by its block across redraws. */
function valuesFor(key: string, inputs: Input[]): Record<string, number> {
  const values = remember(key, () => startValues(inputs));
  // A value that went missing (a memory from an older shape) starts again.
  for (const i of inputs) if (!Number.isFinite(values[i.name])) values[i.name] = i.value;
  return values;
}

/** Every output for these input values, each after the ones it may use. */
export function evaluateCalc(calc: Calc, values: Record<string, number>): Record<string, number> {
  const scope: Record<string, number> = Object.create(null);
  for (const i of calc.inputs) scope[i.name] = values[i.name] ?? i.value;
  const results: Record<string, number> = Object.create(null);
  for (const o of calc.outputs) {
    const v = safe(o.expr, scope);
    scope[o.name] = v;
    results[o.name] = v;
  }
  return results;
}

/** The calculator: sliders on the left, the results on the right, updated as a slider moves. */
export function renderCalc(calc: Calc, ctx: RichContext, key: string): HTMLElement {
  const values = valuesFor(key, calc.inputs);
  const numbers = new Map<string, HTMLElement>();
  const outs = calc.outputs.map((o) => {
    const num = h("span", { class: "rc-out-num" });
    numbers.set(o.name, num);
    const name = h("div", { class: "rc-out-name" }, h("span", { class: "rc-out-sym" }, ctx.math(texName(o.name))));
    if (o.label) name.append(h("span", { class: "rc-out-label", text: o.label, title: o.label }));
    const row = h("div", { class: "rc-out-row" }, num);
    if (o.unit) row.append(h("span", { class: "rc-out-unit", text: o.unit, title: o.unit }));
    return h("div", { class: "rc-out" }, name, row);
  });
  const update = () => {
    const results = evaluateCalc(calc, values);
    for (const [name, num] of numbers) num.textContent = formatNumber(results[name]);
  };
  const sliders = calc.inputs.map((i) => slider(i, values, ctx, update));
  update();
  return h(
    "div",
    { class: "rc-card rc-calc" },
    head("calc", calc.title, ctx, headFormula(calc.formula, ctx)),
    h(
      "div",
      { class: "rc-calc-body" },
      h("div", { class: "rc-calc-in" }, ...sliders),
      h("div", { class: "rc-calc-out" + (calc.outputs.length > 3 ? " two" : "") }, ...outs),
    ),
  );
}

/**
 * The curves as lines in a `width` × `height` box, each a list of pieces:
 * a curve breaks where it is no number, and where it jumps from beyond one
 * edge to beyond the other (tan at its poles), instead of a line across.
 */
export function tracePlot(plot: Plot, values: Record<string, number>, width: number, height: number): [number, number][][][] {
  const [x0, x1] = plot.x;
  const [y0, y1] = plot.y;
  const scope: Record<string, number> = Object.create(null);
  for (const i of plot.inputs) scope[i.name] = values[i.name] ?? i.value;
  const n = Math.max(2, Math.min(1200, Math.round(width)));
  return plot.curves.map((curve) => {
    const pieces: [number, number][][] = [];
    let piece: [number, number][] = [];
    let side = 0;
    for (let i = 0; i <= n; i++) {
      scope.x = x0 + ((x1 - x0) * i) / n;
      const v = safe(curve.expr, scope);
      if (!Number.isFinite(v)) {
        if (piece.length) pieces.push(piece);
        piece = [];
        continue;
      }
      const now = v > y1 ? 1 : v < y0 ? -1 : 0;
      if (piece.length && now && side === -now) {
        pieces.push(piece);
        piece = [];
      }
      side = now;
      // Far beyond the box is drawn just beyond it, which the canvas clips.
      const py = Math.min(2 * height, Math.max(-height, height - ((v - y0) / (y1 - y0)) * height));
      piece.push([(width * i) / n, py]);
    }
    if (piece.length) pieces.push(piece);
    return pieces;
  });
}

/** Grid lines at a round step, about `count` of them over the span. */
function ticks(lo: number, hi: number, count: number): number[] {
  const step = roundStep((hi - lo) / count);
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9 && out.length < 50; v += step) out.push(v);
  return out;
}

/**
 * Draws the chart on `canvas`, `width` CSS pixels wide, with what the curves
 * are at `hover` (CSS pixels from the left) while the pointer is on it.
 */
function drawPlot(canvas: HTMLCanvasElement, plot: Plot, values: Record<string, number>, width: number, H: number, hover: number | null) {
  const g = canvas.getContext?.("2d");
  if (!g || width <= 0) return;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const pw = Math.round(width * dpr);
  const ph = Math.round(H * dpr);
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, H);
  const [x0, x1] = plot.x;
  const [y0, y1] = plot.y;
  const X = (x: number) => ((x - x0) / (x1 - x0)) * width;
  const Y = (y: number) => H - ((y - y0) / (y1 - y0)) * H;
  const crisp = (v: number) => Math.round(v) + 0.5;

  // A light line at each round x, and the axes where they fall inside the frame.
  g.lineWidth = 1;
  g.strokeStyle = "rgba(255, 255, 255, 0.06)";
  g.beginPath();
  for (const t of ticks(x0, x1, 10)) {
    g.moveTo(crisp(X(t)), 0);
    g.lineTo(crisp(X(t)), H);
  }
  g.stroke();
  g.strokeStyle = "rgba(255, 255, 255, 0.16)";
  g.beginPath();
  if (y0 <= 0 && y1 >= 0) {
    g.moveTo(0, crisp(Y(0)));
    g.lineTo(width, crisp(Y(0)));
  }
  if (x0 < 0 && x1 > 0) {
    g.moveTo(crisp(X(0)), 0);
    g.lineTo(crisp(X(0)), H);
  }
  g.stroke();

  const traces = tracePlot(plot, values, width, H);

  // A faint area between the first curve and the x axis (or the frame's edge).
  const base = Y(Math.min(y1, Math.max(y0, 0)));
  const fade = g.createLinearGradient(0, 0, 0, H);
  fade.addColorStop(0, "rgba(143, 199, 255, 0.2)");
  fade.addColorStop(1, "rgba(143, 199, 255, 0)");
  g.fillStyle = fade;
  for (const piece of traces[0] ?? []) {
    if (piece.length < 2) continue;
    g.beginPath();
    g.moveTo(piece[0][0], base);
    for (const [px, py] of piece) g.lineTo(px, py);
    g.lineTo(piece[piece.length - 1][0], base);
    g.closePath();
    g.fill();
  }

  // The curves, the first on top, each with a soft glow of its colour.
  g.lineWidth = 2;
  g.lineJoin = "round";
  g.lineCap = "round";
  for (let c = traces.length - 1; c >= 0; c--) {
    const color = CURVE_COLORS[c % CURVE_COLORS.length];
    g.strokeStyle = color;
    g.shadowColor = color + "99";
    g.shadowBlur = 6;
    g.beginPath();
    for (const piece of traces[c]) {
      piece.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
      if (piece.length === 1) g.lineTo(piece[0][0] + 0.01, piece[0][1]);
    }
    g.stroke();
  }
  g.shadowBlur = 0;

  if (hover !== null) drawReading(g, plot, values, traces, width, H, Math.min(width, Math.max(0, hover)));
}

/**
 * Under the pointer: a thin line, a dot where each curve crosses it, and
 * the values there in a small label beside it (x, then each curve's y in
 * its colour), so the chart reads without numbers on its edges. x has the
 * decimals one pixel tells apart, and every y the same ones as each other,
 * so the numbers keep their shape as the pointer moves. The label sits at
 * the top, or at the bottom when the curves run more through the top there.
 */
function drawReading(g: CanvasRenderingContext2D, plot: Plot, values: Record<string, number>, traces: [number, number][][][], width: number, H: number, px: number) {
  const [x0, x1] = plot.x;
  const [y0, y1] = plot.y;
  const x = x0 + ((x1 - x0) * px) / width;
  const scope: Record<string, number> = Object.create(null);
  for (const i of plot.inputs) scope[i.name] = values[i.name] ?? i.value;
  scope.x = x;
  const ys = plot.curves.map((c) => safe(c.expr, scope));

  g.strokeStyle = "rgba(255, 255, 255, 0.22)";
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(Math.round(px) + 0.5, 0);
  g.lineTo(Math.round(px) + 0.5, H);
  g.stroke();
  ys.forEach((v, c) => {
    if (!Number.isFinite(v) || v < y0 || v > y1) return;
    g.beginPath();
    g.arc(px, H - ((v - y0) / (y1 - y0)) * H, 3.5, 0, 2 * Math.PI);
    g.fillStyle = CURVE_COLORS[c % CURVE_COLORS.length];
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = "#0e0f11";
    g.stroke();
  });

  // The label: `x = 3.20   y = 1.12`, beside the line on its roomier side.
  const xStep = roundStep((x1 - x0) / width);
  const yStep = roundStep((y1 - y0) / H);
  // Rounded first, so a value just under zero reads 0.00, not -0.00.
  const fixed = (v: number, step: number) => formatValue(Math.round(v / step) * step || 0, step, false);
  const parts: { text: string; color: string }[] = [{ text: `x = ${fixed(x, xStep)}`, color: "rgba(255, 255, 255, 0.6)" }];
  ys.forEach((v, c) =>
    parts.push({
      text: `y = ${Number.isFinite(v) ? fixed(v, yStep) : "—"}`,
      color: plot.curves.length > 1 ? CURVE_COLORS[c % CURVE_COLORS.length] : "#e8e9ec",
    }),
  );
  let family = "system-ui, 'Segoe UI', sans-serif";
  try {
    family = getComputedStyle(g.canvas).fontFamily || family;
  } catch {
    // No styles to read (a canvas outside the page): the fallback.
  }
  g.font = `500 10px ${family}`;
  g.textBaseline = "middle";
  g.textAlign = "left";
  const gap = 8;
  const widths = parts.map((p) => g.measureText(p.text).width);
  const w = Math.ceil(widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1) + 12);
  const left = px + 8 + w <= width ? px + 8 : Math.max(0, px - 8 - w);
  let crossing = 0;
  for (const pieces of traces)
    for (const piece of pieces)
      for (const [qx, qy] of piece) if (qx >= left - 2 && qx <= left + w + 2) crossing += qy <= 23 ? 1 : qy >= H - 23 ? -1 : 0;
  const top = crossing > 0 ? H - 20 : 4;
  g.fillStyle = "#0e0f11";
  g.strokeStyle = "rgba(255, 255, 255, 0.08)";
  g.lineWidth = 1;
  g.beginPath();
  if (g.roundRect) g.roundRect(Math.round(left) + 0.5, top + 0.5, w, 16, 5);
  else g.rect(Math.round(left) + 0.5, top + 0.5, w, 16);
  g.fill();
  g.stroke();
  let at = Math.round(left) + 6.5;
  parts.forEach((p, i) => {
    g.fillStyle = p.color;
    g.fillText(p.text, at, top + 8.5);
    at += widths[i] + gap;
  });
}

/**
 * The chart, sliders in a row under it. It is drawn when its width is known
 * or changes (a ResizeObserver, quiet while nothing moves), when a slider
 * moves and when the pointer moves over it; nothing runs in between.
 */
export function renderPlot(plot: Plot, ctx: RichContext, key: string): HTMLElement {
  const values = valuesFor(key, plot.inputs);
  const canvas = h("canvas", {
    class: "rc-plot-canvas",
    role: "img",
    "aria-label": plot.curves.map((c) => `y = ${c.source}`).join("; "),
    height: PLOT_HEIGHT,
  }) as HTMLCanvasElement;
  const frame = h("div", { class: "rc-plot-frame" }, canvas);
  let width = 0;
  let height = PLOT_HEIGHT;
  let hover: number | null = null;
  const draw = () => drawPlot(canvas, plot, values, width, height, hover);
  const sliders = plot.inputs.map((i) => slider(i, values, ctx, draw));
  // The values under the pointer, drawn as it moves and gone when it leaves.
  const point = (e: PointerEvent) => {
    hover = e.clientX - canvas.getBoundingClientRect().left;
    draw();
  };
  canvas.addEventListener("pointermove", point);
  canvas.addEventListener("pointerdown", point);
  canvas.addEventListener("pointerleave", () => {
    hover = null;
    draw();
  });
  const el = h("div", { class: "rc-card rc-plot" }, head("plot", plot.title, ctx, headFormula(plot.formula, ctx)), frame);
  if (sliders.length) el.append(h("div", { class: "rc-plot-in" + (sliders.length > 2 ? " many" : "") }, ...sliders));
  // Drawn again when its width changes, or the chat's height (the island
  // pulled taller or lower): the chart takes the height the card has room
  // for. Nothing runs while neither changes; a card gone stops watching.
  let log: Element | null = null;
  const watch = onResize(frame, () => {
    if (!el.isConnected) {
      // Gone from the chat: the chat's height is no longer this card's business.
      if (log) watch?.unobserve(log);
      log = null;
      return;
    }
    if (!log && (log = el.closest(".chat-log"))) watch?.observe(log);
    const w = Math.floor(canvas.getBoundingClientRect().width);
    const chrome = el.getBoundingClientRect().height - canvas.getBoundingClientRect().height;
    const ht = log ? plotHeight(log.clientHeight, chrome, idealHeight(plot)) : PLOT_HEIGHT;
    if (w === width && ht === height) return;
    width = w;
    if (ht !== height) {
      height = ht;
      canvas.style.height = `${ht}px`;
    }
    draw();
  });
  return el;
}
