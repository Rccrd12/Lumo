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
// what its curves span at the inputs' first values, so a slider's change
// shows against a fixed frame. The formulas are read by core/expr.ts.
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

export const MAX_CALC_INPUTS = 6;
export const MAX_CALC_OUTPUTS = 6;
export const MAX_PLOT_INPUTS = 4;
export const MAX_CURVES = 3;
/** The chart's height, in CSS pixels: the island is low. */
export const PLOT_HEIGHT = 92;
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

/** A step of 1, 2 or 5 times a power of ten, about a hundredth of the range. */
export function niceStep(span: number): number {
  const raw = span / 100;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

/** `V | voltage | 0..24 | 12 | V`, and the shapes near it; null when it has no name or range. */
export function parseInput(text: string): Input | null {
  const fields = text.split("|").map((f) => f.trim());
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
  const fields = text.split("|").map((f) => f.trim());
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
  if (!y) plot.y = autoRange(plot, startValues(inputs));
  return plot;
}

/** The inputs' first values, by name. */
function startValues(inputs: Input[]): Record<string, number> {
  const values: Record<string, number> = Object.create(null);
  for (const i of inputs) values[i.name] = i.value;
  return values;
}

/**
 * What the curves span over x, padded a tenth on each side. A curve that
 * shoots off (tan near its poles) would flatten the rest to a line: past
 * the hundredth at each end the far values are left out when they are far.
 */
export function autoRange(plot: Pick<Plot, "curves" | "x">, values: Record<string, number>): [number, number] {
  const seen: number[] = [];
  const scope: Record<string, number> = { ...values, x: 0 };
  const n = 240;
  for (const curve of plot.curves) {
    for (let i = 0; i <= n; i++) {
      scope.x = plot.x[0] + ((plot.x[1] - plot.x[0]) * i) / n;
      const v = safe(curve.expr, scope);
      if (Number.isFinite(v)) seen.push(v);
    }
  }
  if (!seen.length) return [-1, 1];
  seen.sort((a, b) => a - b);
  let lo = seen[0];
  let hi = seen[seen.length - 1];
  const qlo = seen[Math.floor(seen.length * 0.01)];
  const qhi = seen[Math.ceil(seen.length * 0.99) - 1];
  if (hi - lo > 10 * (qhi - qlo) && qhi > qlo) [lo, hi] = [qlo, qhi];
  if (hi - lo < 1e-9 * Math.max(1, Math.abs(hi))) {
    const pad = Math.abs(hi) / 2 || 1;
    return [lo - pad, hi + pad];
  }
  const pad = (hi - lo) / 10;
  return [lo - pad, hi + pad];
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

function format(options: Intl.NumberFormatOptions, n: number): string {
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
  return f.format(n);
}

/** A result in the app's language: three or four significant digits; "—" when it is no number. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return format({ maximumFractionDigits: 0 }, 0);
  const a = Math.abs(n);
  if (a >= 1e6 || a < 1e-3) return format({ notation: "scientific", maximumSignificantDigits: 3 }, n);
  if (a >= 1000) return format({ maximumFractionDigits: 0 }, n);
  return format({ minimumSignificantDigits: 3, maximumSignificantDigits: 4 }, n);
}

/**
 * A slider's value, with as many decimals as its step has, or as the value
 * itself has when it starts off the step's grid (9.81 on a step of 0.2).
 */
export function formatValue(n: number, step: number): string {
  const decimals = Math.min(6, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
  const own = /\.(\d{1,4})$/.exec(String(n))?.[1].length ?? 0;
  const shown = Math.max(decimals, own);
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
  const range = h("input", {
    class: "rc-range",
    type: "range",
    // The track fills from the left, in Arabic too, as a scale of numbers does.
    dir: "ltr",
    min: input.min,
    max: input.max,
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
    values[input.name] = v;
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
    if (o.unit) row.append(h("span", { class: "rc-out-unit", text: o.unit }));
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
    head("calc", calc.title, headFormula(calc.formula, ctx)),
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
  const raw = (hi - lo) / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  const step = (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9 && out.length < 50; v += step) out.push(v);
  return out;
}

/** Draws the chart on `canvas`, `width` CSS pixels wide. */
function drawPlot(canvas: HTMLCanvasElement, plot: Plot, values: Record<string, number>, width: number) {
  const g = canvas.getContext?.("2d");
  if (!g || width <= 0) return;
  const H = PLOT_HEIGHT;
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

  // A light grid, and the axes where they fall in the frame.
  g.lineWidth = 1;
  g.strokeStyle = "rgba(255, 255, 255, 0.05)";
  g.beginPath();
  for (const t of ticks(x0, x1, 10)) {
    g.moveTo(crisp(X(t)), 0);
    g.lineTo(crisp(X(t)), H);
  }
  for (const t of ticks(y0, y1, 3)) {
    g.moveTo(0, crisp(Y(t)));
    g.lineTo(width, crisp(Y(t)));
  }
  g.stroke();
  g.strokeStyle = "rgba(255, 255, 255, 0.16)";
  g.beginPath();
  if (y0 <= 0 && y1 >= 0) {
    g.moveTo(0, crisp(Y(0)));
    g.lineTo(width, crisp(Y(0)));
  }
  if (x0 <= 0 && x1 >= 0) {
    g.moveTo(crisp(X(0)), 0);
    g.lineTo(crisp(X(0)), H);
  }
  g.stroke();

  const traces = tracePlot(plot, values, width, H);

  // A faint area between the first curve and the x axis (or the frame's edge).
  const base = Y(Math.min(y1, Math.max(y0, 0)));
  const fade = g.createLinearGradient(0, 0, 0, H);
  fade.addColorStop(0, "rgba(143, 199, 255, 0.18)");
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

  // The frame's ends, small and dim in its corners.
  g.fillStyle = "rgba(255, 255, 255, 0.32)";
  g.font = "500 9px system-ui, 'Segoe UI', sans-serif";
  g.textBaseline = "top";
  g.textAlign = "left";
  g.fillText(formatNumber(y1), 3, 2);
  g.textBaseline = "bottom";
  g.fillText(formatNumber(y0), 3, H - 2);
  g.textAlign = "right";
  g.fillText(formatNumber(x1), width - 3, H - 2);
}

/**
 * The chart, sliders in a row under it. It is drawn when its width is known
 * or changes (a ResizeObserver, quiet while nothing moves) and when a slider
 * moves; nothing runs in between.
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
  const draw = () => drawPlot(canvas, plot, values, width);
  const sliders = plot.inputs.map((i) => slider(i, values, ctx, draw));
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver((entries) => {
      const w = Math.floor(entries[entries.length - 1].contentRect.width);
      if (w === width) return;
      width = w;
      draw();
    }).observe(frame);
  }
  const el = h("div", { class: "rc-card rc-plot" }, head("plot", plot.title, headFormula(plot.formula, ctx)), frame);
  if (sliders.length) el.append(h("div", { class: "rc-plot-in" + (sliders.length > 2 ? " many" : "") }, ...sliders));
  return el;
}
