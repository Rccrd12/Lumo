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

import { h, svg } from "../dom";
import { ICONS } from "../icons";
import { compile as compilePlain, fromTeX, normalizeName, GREEK, type Expr } from "../../core/expr";

/** Reads a formula as core/expr does, the TeX a model slips into turned to plain first. */
function compile(source: string): Expr {
  return compilePlain(fromTeX(source));
}
import { language, N_, t } from "../../i18n/i18n";
import { head, remember, type RichContext } from "./index";
import "./calc.css";
import { onResize } from "./resize";

export const MAX_CALC_INPUTS = 6;
export const MAX_CALC_OUTPUTS = 6;
export const MAX_PLOT_INPUTS = 4;
export const MAX_CURVES = 6;
/** Shaded regions a chart may have. */
export const MAX_REGIONS = 3;
/** The chart's height, in CSS pixels, at the least: the island is low. */
export const PLOT_HEIGHT = 92;
/** The least a chart asks for when there is room: enough for its grid and the numbers on its axes. */
export const PLOT_WANT_HEIGHT = 150;
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
 * line spreads evenly over its own height and reads at PLOT_HEIGHT; an
 * exponential or a parabola spends most of its length in a band of it (along
 * the bottom, near its vertex) and asks for more, the narrower that band the
 * more. The band is the middle half of where the curve's points fall, as a
 * share of the curve's own span, so a wave stays a wave however wide the
 * frame. A curve that fills only part of the frame (its sliders can take it
 * further: A·sin x with A at 1 of 3) asks for a little more, up to
 * MAX_ROOM_GROWTH times PLOT_WANT_HEIGHT, so it isn't drawn tiny. A wave
 * or a line asks for PLOT_WANT_HEIGHT, room enough for its grid and numbers. The curve that wants the
 * most decides; a flat line asks for nothing. Read at the inputs' first
 * values, so the card keeps its height while the sliders move.
 */
export function idealHeight(plot: Plot): number {
  const [x0, x1] = plot.x;
  const [y0, y1] = plot.y;
  const scope: Record<string, number> = Object.create(null);
  for (const i of plot.inputs) scope[i.name] = i.value;
  const n = 240;
  let want = PLOT_WANT_HEIGHT;
  for (const curve of plot.curves) {
    const at: number[] = [];
    for (let i = 0; i <= n; i++) {
      scope.x = x0 + ((x1 - x0) * i) / n;
      const v = safe(curve.expr, scope);
      if (Number.isFinite(v) && v >= y0 && v <= y1) at.push(v);
    }
    if (at.length < 12) continue;
    at.sort((a, b) => a - b);
    const span = at[at.length - 1] - at[0];
    if (!(span > 1e-9 * Math.max(1, Math.abs(at[0])))) continue;
    const band = Math.max(0.02, (at[Math.floor(at.length * 0.75)] - at[Math.floor(at.length * 0.25)]) / span);
    const share = span / (y1 - y0);
    const shape = PLOT_HEIGHT * Math.max(1, (0.5 / band) ** 2);
    // Only so far as a small curve isn't drawn tiny: a tall one (an
    // exponential whose slider can take it ten times higher) keeps its own.
    const room = Math.min(MAX_ROOM_GROWTH, Math.max(1, FULL_SHARE / share));
    want = Math.max(want, shape, Math.min(shape * room, MAX_ROOM_GROWTH * PLOT_WANT_HEIGHT));
  }
  return want;
}
/** A curve filling at least this share of the frame is drawn at its own need. */
const FULL_SHARE = 0.75;
/** How much more a curve filling little of the frame may ask for, as a multiple of PLOT_WANT_HEIGHT. */
const MAX_ROOM_GROWTH = 1.75;
/** The curves' colours, in order: the cards' accent, then green, amber, pink, indigo and red. */
export const CURVE_COLORS = ["#8fc7ff", "#34d399", "#f5a524", "#f472b6", "#a5b4fc", "#f87171"];

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
  /** The shaded regions, each where all its conditions in x and y hold. */
  regions: Region[];
  /** One unit as long on both axes, so a circle is round: asked for, or a chart with regions. */
  equal: boolean;
}

/** `a ≤ b ≤ c`: the expressions, and between each two whether the first is at most (le) or at least (ge) the next. */
export interface Condition {
  parts: Expr[];
  ops: ("le" | "ge")[];
}

export interface Region {
  conditions: Condition[];
  source: string;
}

// ── Reading ───────────────────────────────────────────────────────────────────

/** `input: …`, `- Output = …`: a line's key and the rest (up to its last
 * non-blank, found once: a lazy `.*?` before the blanks is quadratic on a line of spaces). */
const LINE = /^[ \t]*(?:[-*+•][ \t]+)?([A-Za-z]+)[ \t]*[:=][ \t]*(.*\S)?[ \t]*$/;
const FORMULA_KEYS = new Set(["formula", "tex", "equation", "latex"]);
const INPUT_KEYS = new Set(["input", "in", "slider", "param", "parameter", "var", "variable"]);
const OUTPUT_KEYS = new Set(["output", "out", "result"]);
const CURVE_KEYS = new Set(["y", "f", "curve", "plot"]);
const X_KEYS = new Set(["x", "xrange", "domain"]);
const Y_KEYS = new Set(["yrange", "range"]);
const REGION_KEYS = new Set(["region", "area", "fill", "shade"]);
const SCALE_KEYS = new Set(["scale", "aspect", "axes"]);
/** A comparison sign, as typed or as printed. */
const COMPARE = /(<=|>=|=<|=>|≤|≥|⩽|⩾|<|>)/;

/**
 * A region's conditions: comparisons joined by "and", "&&", ";" or the
 * commas outside parentheses, each two or more expressions with ≤ or ≥
 * (< and > read the same: a boundary is too thin to see) between them.
 * Null when one isn't a comparison, can't be read or names something
 * unknown.
 */
export function parseRegion(text: string, known: Set<string>): Region | null {
  const pieces = fromTeX(text)
    .split(/\s+and\s+|&&|∧|;/i)
    .flatMap((p) => fieldsOf(p))
    .map((p) => p.trim())
    .filter(Boolean);
  if (!pieces.length) return null;
  const conditions: Condition[] = [];
  for (const piece of pieces) {
    const bits = piece.split(COMPARE);
    if (bits.length < 3) return null;
    const parts: Expr[] = [];
    const ops: Condition["ops"] = [];
    for (let i = 0; i < bits.length; i += 2) {
      let expr: Expr;
      try {
        expr = compile(bits[i]);
      } catch {
        return null;
      }
      if (!expr.vars.every((v) => known.has(v))) return null;
      parts.push(expr);
      if (i + 1 < bits.length) ops.push(/[<≤⩽]/.test(bits[i + 1]) ? "le" : "ge");
    }
    conditions.push({ parts, ops });
  }
  return { conditions, source: text.trim() };
}

/** Whether every condition of `region` holds in `scope` (x and y set in it). */
export function inRegion(region: Region, scope: Record<string, number>): boolean {
  for (const c of region.conditions) {
    let a = safe(c.parts[0], scope);
    for (let i = 0; i < c.ops.length; i++) {
      const b = safe(c.parts[i + 1], scope);
      if (!(c.ops[i] === "le" ? a <= b : a >= b)) return false;
      a = b;
    }
  }
  return true;
}

interface Line {
  key: string;
  value: string;
}

/** The keys of an input or output written a field a line (`symbol: r`, `min: 1`…). */
const FIELD_KEYS = new Set(["symbol", "sym", "id", "name", "label", "min", "max", "range", "value", "default", "initial", "unit", "units", "step", "expression", "expr"]);
const GROUP_KEYS = new Set(["inputs", "sliders", "params", "parameters", "variables", "outputs", "results"]);

/**
 * An input or output written a field a line, as small local models write
 * them (`inputs:`, then `symbol: r`, `name: Raggio`, `min: 1`, `max: 100`,
 * `value: 5`, `unit: cm`; `outputs:`, then `symbol: A`, `expression:
 * pi*r**2`): each group, from its symbol, as the one line the note teaches.
 */
function fieldwise(found: Line[]): Line[] {
  // Only a block with no input or output on a line of its own: a stray
  // `symbol:` beside them is no field.
  if (!found.some((l) => l.key === "symbol" || l.key === "sym")) return found;
  if (found.some((l) => (INPUT_KEYS.has(l.key) || OUTPUT_KEYS.has(l.key)) && l.value.trim())) return found;
  const out: Line[] = [];
  let group: Map<string, string> | null = null;
  let outputs = false;
  const flush = () => {
    if (!group) return;
    const f = (...keys: string[]) => keys.map((k) => group!.get(k)).find((v) => v !== undefined && v !== "") ?? "";
    const symbol = f("symbol", "sym", "id") || f("name");
    const label = f("symbol", "sym", "id") ? f("name", "label") : f("label");
    const expression = f("expression", "expr");
    const range = f("range") || (f("min") && f("max") ? `${f("min")}..${f("max")}` : "");
    if (expression || (outputs && !range)) out.push({ key: "output", value: [symbol, label, expression || f("value"), f("unit", "units")].join(" | ") });
    else {
      const step = f("step");
      out.push({ key: "input", value: [symbol, label, range + (step ? ` step ${step}` : ""), f("value", "default", "initial"), f("unit", "units")].join(" | ") });
    }
    group = null;
  };
  for (const line of found) {
    if (GROUP_KEYS.has(line.key) && /^[|>-]?$/.test(line.value.trim())) {
      flush();
      outputs = line.key === "outputs" || line.key === "results";
    } else if (line.key === "symbol" || line.key === "sym" || line.key === "id") {
      flush();
      group = new Map([[line.key, line.value]]);
    } else if (group && FIELD_KEYS.has(line.key) && !group.has(line.key)) group.set(line.key, line.value);
    else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out;
}

function lines(body: string): Line[] {
  const out: Line[] = [];
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    const m = LINE.exec(raw);
    if (m) out.push({ key: m[1].toLowerCase(), value: m[2] ?? "" });
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

/** The longest text read as a range. */
const MAX_RANGE = 200;

/** `0..24`, `-1 … 1`, `0 to 2pi`, `1–100`, with `step 0.5` after it or not. */
export function parseRange(text: string): { min: number; max: number; step: number | null } | null {
  // A range is a few words. Longer, or with runs of spaces, the pattern below
  // tries its ways of splitting it for seconds (600 spaces: about 5 s).
  if (text.length > MAX_RANGE) return null;
  text = text.replace(/\s+/g, " ").trim();
  const m = /^\[?\s*(.+?)\s*(?:\.\.\.?|…|\bto\b|–|—)\s*(.+?)\s*\]?\s*(?:\bstep\s*[:=]?\s*(.+?))?\s*$/i.exec(text);
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
  const found = fieldwise(lines(body));
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
  const found = fieldwise(lines(body));
  const inputs = inputsOf(found, MAX_PLOT_INPUTS);
  if (!inputs || inputs.some((i) => i.name === "x")) return null;
  const known = new Set(["x", ...inputs.map((i) => i.name)]);
  const curves: Plot["curves"] = [];
  const regions: Region[] = [];
  let equal = false;
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
    } else if (REGION_KEYS.has(line.key)) {
      // y is the plane's here, so no input may be called so.
      if (inputs.some((i) => i.name === "y")) return null;
      const region = parseRegion(line.value, new Set([...known, "y"]));
      if (!region) return null;
      regions.push(region);
    } else if (SCALE_KEYS.has(line.key)) {
      equal = /equal|same|1\s*:\s*1/i.test(line.value);
    }
  }
  if ((!curves.length && !regions.length) || curves.length > MAX_CURVES || regions.length > MAX_REGIONS) return null;
  const plot: Plot = { title: title.trim(), formula, curves, x, y: y ?? [-1, 1], inputs, regions, equal: equal || regions.length > 0 };
  // Regions alone have no curve to frame: the plane as wide as it is long.
  if (!y && !curves.length) plot.y = [...x];
  else if (!y) {
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

// ── The chart ─────────────────────────────────────────────────────────────────
//
// Drawn as a plane, the way a graphing app shows one: a squared grid, the
// axes with their numbers, the curves, and their notable points (zeros,
// highs and lows, where two curves cross). The plane moves under a drag and
// zooms with the buttons in its corner or Ctrl and the wheel (a touchpad's
// pinch); the wheel alone stays the chat's. Where it was moved to is kept
// across the chat's redraws, and one button brings back the frame it opened
// on.

export const PLOT_STRINGS = {
  zoomIn: N_("Zoom in"),
  zoomOut: N_("Zoom out"),
  reset: N_("Reset view"),
  zero: N_("Zero"),
  max: N_("Maximum"),
  min: N_("Minimum"),
  cross: N_("Intersection"),
};

/** The part of the plane the chart shows. */
export interface View {
  x: [number, number];
  y: [number, number];
}

/** The scope the curves are worked out in: the sliders' values, x to be set. */
function scopeOf(plot: Plot, values: Record<string, number>): Record<string, number> {
  const scope: Record<string, number> = Object.create(null);
  for (const i of plot.inputs) scope[i.name] = values[i.name] ?? i.value;
  return scope;
}

/**
 * The curves as lines in a `width` × `height` box showing `view`, each a
 * list of pieces: a curve breaks where it is no number, and where it jumps
 * from beyond one edge to beyond the other (tan at its poles), instead of a
 * line across.
 */
export function tracePlot(plot: Plot, values: Record<string, number>, width: number, height: number, view: View = plot): [number, number][][][] {
  const [x0, x1] = view.x;
  const [y0, y1] = view.y;
  const scope = scopeOf(plot, values);
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

export type PointKind = "zero" | "max" | "min" | "cross";

export interface NotablePoint {
  kind: PointKind;
  x: number;
  y: number;
  /** The curve it is on (the first of the two, where two cross). */
  curve: number;
}

/**
 * More of one kind than this on one curve (sin 20x has dozens of zeros) and
 * that kind is left out for it: a row of dots would hide the curve.
 */
const MAX_POINTS = 8;

/**
 * The notable points of the curves inside `view`: where each crosses the x
 * axis, its highs and lows, and where two curves cross. Found on a fine
 * sampling of the view, then pinned down (by halving for a crossing, by a
 * golden-section search for a high or a low). A jump across a pole (tan,
 * 1/x) changes sign without crossing: it is told apart by the value there,
 * which is no zero.
 */
export function notablePoints(plot: Plot, values: Record<string, number>, view: View, n = 400): NotablePoint[] {
  const [x0, x1] = view.x;
  const [y0, y1] = view.y;
  const span = y1 - y0;
  if (!(x1 > x0) || !(span > 0)) return [];
  const scope = scopeOf(plot, values);
  const at = (c: number, x: number) => {
    scope.x = x;
    return safe(plot.curves[c].expr, scope);
  };
  const xs = Array.from({ length: n + 1 }, (_, i) => x0 + ((x1 - x0) * i) / n);
  const samples = plot.curves.map((_, c) => xs.map((x) => at(c, x)));
  const inside = (y: number) => Number.isFinite(y) && y >= y0 && y <= y1;
  const near = span * 1e-3;

  /** Where `g` changes sign between a and b (g(a) = ga), or null where it stops being a number. */
  const crossing = (g: (x: number) => number, a: number, ga: number, b: number): number | null => {
    for (let k = 0; k < 60; k++) {
      const m = (a + b) / 2;
      const gm = g(m);
      if (!Number.isFinite(gm)) return null;
      if (gm === 0) return m;
      if (Math.sign(gm) === Math.sign(ga)) {
        a = m;
        ga = gm;
      } else b = m;
    }
    return (a + b) / 2;
  };
  /** Where `g` is highest between a and b. */
  const peak = (g: (x: number) => number, a: number, b: number): number => {
    const r = (Math.sqrt(5) - 1) / 2;
    for (let k = 0; k < 60; k++) {
      const m1 = b - (b - a) * r;
      const m2 = a + (b - a) * r;
      if (g(m1) > g(m2)) b = m2;
      else a = m1;
    }
    return (a + b) / 2;
  };
  /** The sign changes of `v` over the samples, as crossings of `g`. */
  const signChanges = (v: number[], g: (x: number) => number): number[] => {
    const out: number[] = [];
    for (let i = 1; i <= n; i++) {
      const a = v[i - 1];
      const b = v[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (b === 0) {
        // On a sample: once, not again from the next one.
        if (a !== 0) out.push(xs[i]);
        continue;
      }
      if (a === 0 || Math.sign(a) === Math.sign(b)) continue;
      const x = crossing(g, xs[i - 1], a, xs[i]);
      if (x !== null && Math.abs(g(x)) <= near) out.push(x);
    }
    return out;
  };

  const points: NotablePoint[] = [];
  plot.curves.forEach((_, c) => {
    const v = samples[c];
    const f = (x: number) => at(c, x);
    const zeros = signChanges(v, f)
      .map((x) => ({ kind: "zero" as const, x, y: 0, curve: c }))
      .filter((p) => inside(p.y));
    if (zeros.length <= MAX_POINTS) points.push(...zeros);

    const turns: NotablePoint[] = [];
    const flat = span * 1e-9;
    for (let i = 1; i < n; i++) {
      const a = v[i - 1];
      const b = v[i];
      const d = v[i + 1];
      if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(d)) continue;
      const up = b - a;
      const down = d - b;
      if (Math.abs(up) < flat || Math.abs(down) < flat) continue;
      const kind = up > 0 && down < 0 ? "max" : up < 0 && down > 0 ? "min" : null;
      if (!kind) continue;
      const sign = kind === "max" ? 1 : -1;
      const x = peak((t) => sign * f(t), xs[i - 1], xs[i + 1]);
      const y = f(x);
      // A pole between two samples is no high or low.
      if (inside(y) && Math.abs(y - b) <= span) turns.push({ kind, x, y, curve: c });
    }
    if (turns.length <= MAX_POINTS) points.push(...turns);

    for (let d = c + 1; d < plot.curves.length; d++) {
      const g = (x: number) => at(c, x) - at(d, x);
      const diff = v.map((y, i) => y - samples[d][i]);
      const crosses = signChanges(diff, g)
        .map((x) => ({ kind: "cross" as const, x, y: at(c, x), curve: c }))
        .filter((p) => inside(p.y));
      if (crosses.length <= MAX_POINTS) points.push(...crosses);
    }
  });
  return points;
}

/** Grid lines at a round step, about one every `px` pixels over `size`. */
function gridStep(lo: number, hi: number, size: number, px: number): number {
  return roundStep((hi - lo) / Math.max(1, size / px));
}

/** The multiples of `step` between lo and hi. */
function multiples(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  for (let k = Math.ceil(lo / step - 1e-9); k * step <= hi + step * 1e-9 && out.length < 400; k++) out.push(k * step);
  return out;
}

/** A number on an axis or at a point: no more decimals than `step` needs, none it doesn't. */
function axisNumber(v: number, step: number): string {
  const need = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
  const rounded = Math.round(v / step) * step || 0;
  const a = Math.abs(rounded);
  if (a !== 0 && (a >= 1e6 || a < 1e-4)) return scientific({ maximumSignificantDigits: 3 }, rounded);
  return format({ maximumFractionDigits: need }, rounded);
}

/** "(1.57, 1)", or "(1,57; 1)" where the comma is the decimal mark. */
function pairText(x: number, y: number, view: View, width: number, H: number): string {
  // A tenth of a pixel's worth of decimals, so a point reads as exact.
  const xs = roundStep((view.x[1] - view.x[0]) / width / 10);
  const ys = roundStep((view.y[1] - view.y[0]) / H / 10);
  const comma = formatter({ minimumFractionDigits: 1 }).format(1.5).includes(",");
  return `(${axisNumber(x, xs)}${comma ? "; " : ", "}${axisNumber(y, ys)})`;
}

const LABEL_COLOR = "rgba(255, 255, 255, 0.45)";
const HALO = "rgba(14, 15, 17, 0.9)";

function fontFamily(g: CanvasRenderingContext2D): string {
  try {
    return getComputedStyle(g.canvas).fontFamily || "system-ui, 'Segoe UI', sans-serif";
  } catch {
    // No styles to read (a canvas outside the page): the fallback.
    return "system-ui, 'Segoe UI', sans-serif";
  }
}

/** Text with a dark rim, so it reads over a grid line or a curve. */
function haloText(g: CanvasRenderingContext2D, text: string, x: number, y: number, color: string) {
  g.lineWidth = 3;
  g.strokeStyle = HALO;
  g.lineJoin = "round";
  g.strokeText(text, x, y);
  g.fillStyle = color;
  g.fillText(text, x, y);
}

/**
 * The squared grid (a fainter line between the round ones when there is
 * room), the axes, and their numbers: along the x axis under it and the
 * y axis left of it, or along the edge the axis has gone past, so the
 * numbers stay in sight wherever the plane is moved.
 */
function drawGrid(g: CanvasRenderingContext2D, view: View, width: number, H: number) {
  const [x0, x1] = view.x;
  const [y0, y1] = view.y;
  const X = (x: number) => ((x - x0) / (x1 - x0)) * width;
  const Y = (y: number) => H - ((y - y0) / (y1 - y0)) * H;
  const crisp = (v: number) => Math.round(v) + 0.5;
  const xStep = gridStep(x0, x1, width, 80);
  const yStep = gridStep(y0, y1, H, 46);

  const lines = (stepX: number, stepY: number, style: string) => {
    g.strokeStyle = style;
    g.beginPath();
    for (const t of multiples(x0, x1, stepX)) {
      g.moveTo(crisp(X(t)), 0);
      g.lineTo(crisp(X(t)), H);
    }
    for (const t of multiples(y0, y1, stepY)) {
      g.moveTo(0, crisp(Y(t)));
      g.lineTo(width, crisp(Y(t)));
    }
    g.stroke();
  };
  g.lineWidth = 1;
  // 1, 5 and 10 split in five, 2 in four.
  const minor = (step: number) => step / (Math.round(step / 10 ** Math.floor(Math.log10(step) + 1e-9)) === 2 ? 4 : 5);
  const mx = minor(xStep);
  const my = minor(yStep);
  if ((mx / (x1 - x0)) * width >= 9 && (my / (y1 - y0)) * H >= 9) lines(mx, my, "rgba(255, 255, 255, 0.03)");
  lines(xStep, yStep, "rgba(255, 255, 255, 0.075)");

  // The axes, where they fall inside the view.
  const ax = X(0);
  const ay = Y(0);
  g.strokeStyle = "rgba(255, 255, 255, 0.32)";
  g.beginPath();
  if (ay >= 0 && ay <= H) {
    g.moveTo(0, crisp(ay));
    g.lineTo(width, crisp(ay));
  }
  if (ax >= 0 && ax <= width) {
    g.moveTo(crisp(ax), 0);
    g.lineTo(crisp(ax), H);
  }
  g.stroke();

  g.font = `500 9.5px ${fontFamily(g)}`;
  // x's numbers under its axis, kept inside when the axis is off the view.
  g.textAlign = "center";
  g.textBaseline = "top";
  const ly = Math.min(H - 13, Math.max(2, ay + 4));
  let right = -Infinity;
  for (const t of multiples(x0, x1, xStep)) {
    if (Math.abs(t) < xStep / 2) continue;
    const text = axisNumber(t, xStep);
    const w = g.measureText(text).width;
    const at = X(t);
    if (at - w / 2 < 2 || at + w / 2 > width - 2 || at - w / 2 < right + 6) continue;
    haloText(g, text, at, ly, LABEL_COLOR);
    right = at + w / 2;
  }
  // y's left of its axis, or along the edge it has gone past.
  g.textAlign = "right";
  g.textBaseline = "middle";
  for (const t of multiples(y0, y1, yStep)) {
    if (Math.abs(t) < yStep / 2) continue;
    const at = Y(t);
    // Clear of the x axis and the numbers under it.
    if (at < 7 || at > H - 7 || (at > ay - 9 && at < ly + 20)) continue;
    const text = axisNumber(t, yStep);
    const w = g.measureText(text).width;
    const lx = Math.min(width - 2, Math.max(w + 2, ax - 5));
    haloText(g, text, lx, at, LABEL_COLOR);
  }
  // The origin, once.
  if (ax >= 0 && ax <= width && ay >= 0 && ay <= H) {
    g.textAlign = "right";
    g.textBaseline = "top";
    haloText(g, axisNumber(0, xStep), Math.max(8, ax - 4), Math.min(H - 13, ay + 4), LABEL_COLOR);
  }
}

/** One cell of a region's shading, in CSS pixels: fine enough for its edge, cheap enough to redraw under a drag. */
const REGION_CELL = 3;

/** Each canvas's shaded regions as last drawn, by what they were drawn for. */
const regionLayers = new WeakMap<HTMLCanvasElement, { id: string; layers: HTMLCanvasElement[] }>();

/**
 * The regions, tinted in their colours: each worked out on a grid of
 * REGION_CELL pixels into a small image of its own, which the chart draws
 * stretched and smoothed, so its edge stays soft. Worked out again only when
 * the view, the sliders or the size change, not as the pointer moves.
 */
function drawRegions(g: CanvasRenderingContext2D, canvas: HTMLCanvasElement, plot: Plot, values: Record<string, number>, view: View, width: number, H: number) {
  if (!plot.regions.length) return;
  const cols = Math.max(1, Math.ceil(width / REGION_CELL));
  const rows = Math.max(1, Math.ceil(H / REGION_CELL));
  const id = `${view.x}|${view.y}|${cols}x${rows}|${plot.inputs.map((i) => values[i.name]).join(",")}`;
  let kept = regionLayers.get(canvas);
  if (kept?.id !== id) {
    const scope = scopeOf(plot, values);
    const layers = plot.regions.map((region, r) => {
      const layer = document.createElement("canvas");
      layer.width = cols;
      layer.height = rows;
      const lg = layer.getContext("2d");
      if (!lg) return layer;
      const image = lg.createImageData(cols, rows);
      const hex = CURVE_COLORS[r % CURVE_COLORS.length];
      const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      for (let j = 0; j < rows; j++) {
        scope.y = view.y[1] - ((j + 0.5) / rows) * (view.y[1] - view.y[0]);
        for (let i = 0; i < cols; i++) {
          scope.x = view.x[0] + ((i + 0.5) / cols) * (view.x[1] - view.x[0]);
          if (!inRegion(region, scope)) continue;
          const at = (j * cols + i) * 4;
          image.data[at] = rgb[0];
          image.data[at + 1] = rgb[1];
          image.data[at + 2] = rgb[2];
          image.data[at + 3] = 255;
        }
      }
      lg.putImageData(image, 0, 0);
      return layer;
    });
    kept = { id, layers };
    regionLayers.set(canvas, kept);
  }
  g.save();
  g.globalAlpha = 0.22;
  g.imageSmoothingEnabled = true;
  for (const layer of kept.layers) g.drawImage(layer, 0, 0, cols * REGION_CELL, rows * REGION_CELL);
  g.restore();
}

/**
 * `frame` widened along one axis so a unit is as long on both in a `width`
 * × `height` chart, around the same middle: all of it still in sight.
 */
export function equalView(frame: View, width: number, height: number): View {
  if (!(width > 0) || !(height > 0)) return frame;
  const per = Math.max((frame.x[1] - frame.x[0]) / width, (frame.y[1] - frame.y[0]) / height);
  const cx = (frame.x[0] + frame.x[1]) / 2;
  const cy = (frame.y[0] + frame.y[1]) / 2;
  return { x: [cx - (per * width) / 2, cx + (per * width) / 2], y: [cy - (per * height) / 2, cy + (per * height) / 2] };
}

/** Where the pointer is over the chart, in CSS pixels from its top left. */
interface Pointer {
  x: number;
  y: number;
}

/** A notable point within this many pixels of the pointer is the one read. */
const SNAP_PX = 9;

/**
 * Draws the chart on `canvas`, `width` × `H` CSS pixels showing `view`,
 * with what is under `hover` while the pointer is on it: a notable point
 * close by, or else the curves' values at its x.
 */
function drawPlot(canvas: HTMLCanvasElement, plot: Plot, values: Record<string, number>, view: View, width: number, H: number, hover: Pointer | null, points: NotablePoint[]) {
  const g = canvas.getContext?.("2d");
  if (!g || width <= 0) return;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const pw = Math.round(width * dpr);
  const ph = Math.round(H * dpr);
  if (canvas.width !== pw) canvas.width = pw;
  if (canvas.height !== ph) canvas.height = ph;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, H);
  drawGrid(g, view, width, H);
  drawRegions(g, canvas, plot, values, view, width, H);

  const traces = tracePlot(plot, values, width, H, view);
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

  // The notable points: a small ring in the curve's colour.
  const X = (x: number) => ((x - view.x[0]) / (view.x[1] - view.x[0])) * width;
  const Y = (y: number) => H - ((y - view.y[0]) / (view.y[1] - view.y[0])) * H;
  let snapped: NotablePoint | null = null;
  let best = SNAP_PX;
  for (const p of points) {
    const px = X(p.x);
    const py = Y(p.y);
    if (hover) {
      const d = Math.hypot(px - hover.x, py - hover.y);
      if (d <= best) {
        best = d;
        snapped = p;
      }
    }
    g.beginPath();
    g.arc(px, py, 3, 0, 2 * Math.PI);
    g.fillStyle = "#0e0f11";
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = CURVE_COLORS[p.curve % CURVE_COLORS.length];
    g.stroke();
  }

  if (snapped) drawPoint(g, snapped, view, width, H);
  else if (hover !== null) drawReading(g, plot, values, view, traces, width, H, Math.min(width, Math.max(0, hover.x)));
}

/** A label in a small dark box, its parts in their colours, at (left, top). */
function drawLabel(g: CanvasRenderingContext2D, parts: { text: string; color: string }[], left: number, top: number, widths: number[], w: number) {
  const gap = 8;
  g.fillStyle = "#0e0f11";
  g.strokeStyle = "rgba(255, 255, 255, 0.08)";
  g.lineWidth = 1;
  g.beginPath();
  if (g.roundRect) g.roundRect(Math.round(left) + 0.5, top + 0.5, w, 16, 5);
  else g.rect(Math.round(left) + 0.5, top + 0.5, w, 16);
  g.fill();
  g.stroke();
  g.textBaseline = "middle";
  g.textAlign = "left";
  let at = Math.round(left) + 6.5;
  parts.forEach((p, i) => {
    g.fillStyle = p.color;
    g.fillText(p.text, at, top + 8.5);
    at += widths[i] + gap;
  });
}

function measure(g: CanvasRenderingContext2D, parts: { text: string }[]): { widths: number[]; w: number } {
  const widths = parts.map((p) => g.measureText(p.text).width);
  return { widths, w: Math.ceil(widths.reduce((a, b) => a + b, 0) + 8 * (parts.length - 1) + 12) };
}

/** A notable point under the pointer: a larger ring, and what it is with its coordinates. */
function drawPoint(g: CanvasRenderingContext2D, p: NotablePoint, view: View, width: number, H: number) {
  const px = ((p.x - view.x[0]) / (view.x[1] - view.x[0])) * width;
  const py = H - ((p.y - view.y[0]) / (view.y[1] - view.y[0])) * H;
  const color = CURVE_COLORS[p.curve % CURVE_COLORS.length];
  g.beginPath();
  g.arc(px, py, 5, 0, 2 * Math.PI);
  g.fillStyle = color;
  g.fill();
  g.lineWidth = 1.5;
  g.strokeStyle = "#0e0f11";
  g.stroke();
  g.font = `500 10px ${fontFamily(g)}`;
  const parts = [
    { text: t(PLOT_STRINGS[p.kind]), color },
    { text: pairText(p.x, p.y, view, width, H), color: "#e8e9ec" },
  ];
  const { widths, w } = measure(g, parts);
  const left = px + 10 + w <= width ? px + 10 : Math.max(0, px - 10 - w);
  const top = py - 26 >= 0 ? py - 26 : Math.min(H - 17, py + 10);
  drawLabel(g, parts, left, top, widths, w);
}

/**
 * Under the pointer: a thin line, a dot where each curve crosses it, and
 * the values there in a small label beside it (x, then each curve's y in
 * its colour). x has the decimals one pixel tells apart, and every y the
 * same ones as each other, so the numbers keep their shape as the pointer
 * moves. The label sits at the top, or at the bottom when the curves run
 * more through the top there.
 */
function drawReading(g: CanvasRenderingContext2D, plot: Plot, values: Record<string, number>, view: View, traces: [number, number][][][], width: number, H: number, px: number) {
  const [x0, x1] = view.x;
  const [y0, y1] = view.y;
  const x = x0 + ((x1 - x0) * px) / width;
  const scope = scopeOf(plot, values);
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
  g.font = `500 10px ${fontFamily(g)}`;
  const { widths, w } = measure(g, parts);
  const left = px + 8 + w <= width ? px + 8 : Math.max(0, px - 8 - w);
  let crossing = 0;
  for (const pieces of traces)
    for (const piece of pieces)
      for (const [qx, qy] of piece) if (qx >= left - 2 && qx <= left + w + 2) crossing += qy <= 23 ? 1 : qy >= H - 23 ? -1 : 0;
  const top = crossing > 0 ? H - 20 : 4;
  drawLabel(g, parts, left, top, widths, w);
}

/** How far in or out the plane may go from the frame it opened on. */
const ZOOM_LIMIT = 1e4;
/** One press of + or −. */
const ZOOM_STEP = 1.5;

/** `view` zoomed by `factor` (under 1: in) around the point at (fx, fy) of it, from its top left. */
export function zoomView(view: View, factor: number, fx = 0.5, fy = 0.5, frame: View = view): View {
  const sx = view.x[1] - view.x[0];
  const fsx = frame.x[1] - frame.x[0];
  // Held within ZOOM_LIMIT of the frame's own span, either way.
  const k = Math.min(fsx * ZOOM_LIMIT, Math.max(fsx / ZOOM_LIMIT, sx * factor)) / sx;
  const cx = view.x[0] + sx * fx;
  const cy = view.y[1] - (view.y[1] - view.y[0]) * fy;
  return {
    x: [cx - (cx - view.x[0]) * k, cx + (view.x[1] - cx) * k],
    y: [cy - (cy - view.y[0]) * k, cy + (view.y[1] - cy) * k],
  };
}

/** `view` moved by (dx, dy) CSS pixels of a `width` × `height` chart, the way a drag moves the plane. */
export function panView(view: View, dx: number, dy: number, width: number, height: number): View {
  const sx = ((view.x[1] - view.x[0]) / width) * dx;
  const sy = ((view.y[1] - view.y[0]) / height) * dy;
  return { x: [view.x[0] - sx, view.x[1] - sx], y: [view.y[0] + sy, view.y[1] + sy] };
}

function zoomButton(label: string, icon: string, onClick: () => void): HTMLButtonElement {
  const b = h("button", { class: "rc-plot-btn", type: "button", title: label, "aria-label": label }, svg(icon, 12, { stroke: 2 })) as HTMLButtonElement;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

/**
 * The chart, sliders in a row under it. It is drawn when its size is known
 * or changes (a ResizeObserver, quiet while nothing moves), when a slider
 * moves, and when the pointer moves over it or drags it; nothing runs in
 * between.
 */
export function renderPlot(plot: Plot, ctx: RichContext, key: string): HTMLElement {
  const values = valuesFor(key, plot.inputs);
  // Where the plane was moved to, kept by the block across redraws; null: its frame.
  const kept = remember<{ view: View | null }>(`${key}#view`, () => ({ view: null }));
  const view = (): View => kept.view ?? (plot.equal ? equalView(plot, width, height) : plot);
  const canvas = h("canvas", {
    class: "rc-plot-canvas",
    role: "img",
    tabindex: 0,
    "aria-label": plot.curves.map((c) => `y = ${c.source}`).join("; "),
    height: PLOT_HEIGHT,
  }) as HTMLCanvasElement;
  let width = 0;
  let height = PLOT_HEIGHT;
  let hover: Pointer | null = null;
  // The notable points for the view and values they were found for.
  let found: { id: string; points: NotablePoint[] } | null = null;
  const pointsNow = () => {
    const v = view();
    const id = `${v.x}|${v.y}|${plot.inputs.map((i) => values[i.name]).join(",")}`;
    if (found?.id !== id) found = { id, points: notablePoints(plot, values, v) };
    return found.points;
  };
  const draw = () => {
    if (width > 0) drawPlot(canvas, plot, values, view(), width, height, hover, pointsNow());
  };

  const reset = zoomButton(t(PLOT_STRINGS.reset), ICONS.arrowClockwise, () => setView(null));
  reset.hidden = kept.view === null;
  const setView = (v: View | null) => {
    kept.view = v;
    reset.hidden = v === null;
    draw();
  };
  const zoom = (factor: number, fx = 0.5, fy = 0.5) => setView(zoomView(view(), factor, fx, fy, plot));
  const tools = h(
    "div",
    { class: "rc-plot-tools" },
    reset,
    zoomButton(t(PLOT_STRINGS.zoomIn), ICONS.plus, () => zoom(1 / ZOOM_STEP)),
    zoomButton(t(PLOT_STRINGS.zoomOut), ICONS.minus, () => zoom(ZOOM_STEP)),
  );
  const frame = h("div", { class: "rc-plot-frame" }, canvas, tools);
  const sliders = plot.inputs.map((i) => slider(i, values, ctx, draw));

  // The pointer: read the chart where it rests, move the plane where it drags.
  const local = (e: { clientX: number; clientY: number }): Pointer => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  let drag: { from: Pointer; view: View; moved: boolean } | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { from: local(e), view: view(), moved: false };
    canvas.setPointerCapture?.(e.pointerId);
    hover = local(e);
    draw();
  });
  canvas.addEventListener("pointermove", (e) => {
    const at = local(e);
    if (drag) {
      const dx = at.x - drag.from.x;
      const dy = at.y - drag.from.y;
      // A click that wobbles a pixel or two still reads the chart.
      if (drag.moved || Math.hypot(dx, dy) >= 3) {
        drag.moved = true;
        frame.classList.add("dragging");
        hover = null;
        setView(panView(drag.view, dx, dy, width, height));
        return;
      }
    }
    hover = at;
    draw();
  });
  const release = (e: PointerEvent) => {
    if (!drag) return;
    drag = null;
    frame.classList.remove("dragging");
    canvas.releasePointerCapture?.(e.pointerId);
    hover = e.type === "pointerup" ? local(e) : null;
    draw();
  };
  canvas.addEventListener("pointerup", release);
  canvas.addEventListener("pointercancel", release);
  canvas.addEventListener("lostpointercapture", release);
  canvas.addEventListener("pointerleave", () => {
    if (drag) return;
    hover = null;
    draw();
  });
  // Ctrl and the wheel (a touchpad's pinch) zoom around the pointer; the
  // wheel alone scrolls the chat, as everywhere else in it.
  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey || !width) return;
      e.preventDefault();
      e.stopPropagation();
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * height : e.deltaY;
      const at = local(e);
      zoom(Math.exp(Math.max(-1, Math.min(1, dy * 0.0025))), at.x / width, at.y / height);
    },
    { passive: false },
  );
  // From the keyboard: the arrows move the plane, + and − zoom, 0 brings back its frame.
  canvas.addEventListener("keydown", (e) => {
    const step = 40;
    const moves: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) setView(panView(view(), moves[e.key][0], moves[e.key][1], width || 1, height));
    else if (e.key === "+" || e.key === "=") zoom(1 / ZOOM_STEP);
    else if (e.key === "-" || e.key === "_") zoom(ZOOM_STEP);
    else if (e.key === "0") setView(null);
    else return;
    e.preventDefault();
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
    // On equal axes, the height that shows its frame at one scale.
    const want = plot.equal ? Math.max(idealHeight(plot), (w * (plot.y[1] - plot.y[0])) / (plot.x[1] - plot.x[0])) : idealHeight(plot);
    const ht = log ? plotHeight(log.clientHeight, chrome, want) : PLOT_HEIGHT;
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
