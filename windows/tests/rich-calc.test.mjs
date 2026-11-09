// The ```lumo-calc and ```lumo-plot cards (src/views/rich/calc.ts): how a
// block is read, forgiving the ways models get it slightly wrong but never a
// formula it can't read; the results following the sliders, kept across the
// chat's redraws; and the chart's curves, broken where they are no number.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const calcModule = await import("../src/views/rich/calc.ts");
const { parseCalc, parsePlot, renderCalc, renderPlot, parseInput, parseRange, niceStep, formatNumber, formatValue, texName, tracePlot, autoRange, evaluateCalc } = calcModule;
const { renderMarkdown } = await import("../src/views/markdown.ts");
const { keyOf } = await import("../src/views/rich/index.ts");

const OHM = [
  "formula: I = \\frac{V}{R}",
  "input: V | voltage | 0..24 | 12 | V",
  "input: R | resistance | 1..100 | 10 | Ω",
  "output: I | current | V / R | A",
  "output: P | power | V * I | W",
].join("\n");

const SINE = [
  "formula: y = A\\sin(\\omega x)",
  "y: A * sin(omega * x)",
  "x: 0..12",
  "input: A | amplitude | 0..2 | 1.4",
  "input: omega | angular frequency | 0.5..4 | 1.6 | rad/s",
].join("\n");

const ctx = {
  markdown: () => {},
  inline: (into, text) => into.append(text),
  math: (tex) => {
    const el = document.createElement("math");
    el.append(document.createTextNode(tex));
    return el;
  },
  copyButton: () => document.createElement("button"),
};

const strip = (input) => {
  const { expr, ...rest } = input;
  return rest;
};

// ── Reading ───────────────────────────────────────────────────────────────────

test("a calculator: its formula, inputs and outputs", () => {
  const calc = parseCalc(" Ohm's law ", OHM);
  assert.equal(calc.title, "Ohm's law");
  assert.equal(calc.formula, "I = \\frac{V}{R}");
  assert.deepEqual(calc.inputs, [
    { name: "V", label: "voltage", min: 0, max: 24, step: 0.1, value: 12, unit: "V" },
    { name: "R", label: "resistance", min: 1, max: 100, step: 1, value: 10, unit: "Ω" },
  ]);
  assert.deepEqual(calc.outputs.map(strip), [
    { name: "I", label: "current", unit: "A" },
    { name: "P", label: "power", unit: "W" },
  ]);
  assert.deepEqual(evaluateCalc(calc, { V: 12, R: 10 }), Object.assign(Object.create(null), { I: 1.2, P: 14.399999999999999 }));
});

test("ranges as models write them", () => {
  assert.deepEqual(parseRange("0..24"), { min: 0, max: 24, step: null });
  assert.deepEqual(parseRange("-10..10"), { min: -10, max: 10, step: null });
  assert.deepEqual(parseRange("0.5..4"), { min: 0.5, max: 4, step: null });
  assert.deepEqual(parseRange("0 … 1"), { min: 0, max: 1, step: null });
  assert.deepEqual(parseRange("1 to 100"), { min: 1, max: 100, step: null });
  assert.deepEqual(parseRange("1–100"), { min: 1, max: 100, step: null });
  assert.deepEqual(parseRange("[0..10]"), { min: 0, max: 10, step: null });
  assert.deepEqual(parseRange("10..0"), { min: 0, max: 10, step: null });
  assert.deepEqual(parseRange("0..10 step 0.5"), { min: 0, max: 10, step: 0.5 });
  const twoPi = parseRange("0..2pi");
  assert.equal(twoPi.max, 2 * Math.PI);
  assert.equal(parseRange("1..1"), null);
  assert.equal(parseRange("a..b"), null);
  assert.equal(parseRange("12"), null);
});

test("a nice step, about a hundredth of the range, tenths for a few units to a few tens", () => {
  assert.equal(niceStep(24), 0.1);
  assert.equal(niceStep(99), 1);
  assert.equal(niceStep(2), 0.1);
  assert.equal(niceStep(3.5), 0.1);
  assert.equal(niceStep(49), 0.1);
  assert.equal(niceStep(1), 0.01);
  assert.equal(niceStep(0.5), 0.005);
  assert.equal(niceStep(1000), 10);
  // The card's design: 12.0 V, 10 Ω, 1.4 and 1.6 rad/s, with no step written.
  assert.equal(formatValue(12, parseInput("V | 0..24 | 12").step), "12.0");
  assert.equal(formatValue(10, parseInput("R | 1..100 | 10").step), "10");
  assert.equal(formatValue(1.4, parseInput("A | 0..2 | 1.4").step), "1.4");
  assert.equal(formatValue(1.6, parseInput("omega | 0.5..4 | 1.6").step), "1.6");
});

test("an input forgives: a unit with its value, no value, a step, Greek and TeX names", () => {
  assert.deepEqual(parseInput("V | voltage | 0..24 | 12 V"), { name: "V", label: "voltage", min: 0, max: 24, step: 0.1, value: 12, unit: "V" });
  assert.deepEqual(parseInput("R | 1..100"), { name: "R", label: "", min: 1, max: 100, step: 1, value: 50.5, unit: "" });
  assert.deepEqual(parseInput("R | resistance | 1..100 | Ω"), { name: "R", label: "resistance", min: 1, max: 100, step: 1, value: 50.5, unit: "Ω" });
  assert.equal(parseInput("n | count | 0..10 step 1 | 3").step, 1);
  assert.equal(parseInput("n | count | 0..10 | 3 | | 0.5").step, 0.5);
  assert.equal(parseInput("n | count | 0..10 | 30").value, 10, "kept within the range");
  assert.equal(parseInput("ω | angular frequency | 0.5..4 | 1.6 | rad/s").name, "omega");
  assert.equal(parseInput("$\\omega$ | angular frequency | 0.5..4 | 1.6").name, "omega");
  assert.equal(parseInput("$V_{out}$ | output | 0..5").name, "V_out");
  assert.equal(parseInput("2x | no | 0..1"), null);
  assert.equal(parseInput("V | voltage | lots"), null);
});

test("keys in any case, list markers, and outputs written as `I = V / R`", () => {
  const calc = parseCalc("", ["- Input: V | voltage | 0..24 | 12 | V", "INPUT: R | 1..100 | 10", "Output: I = V / R | current | A", "result: P | V * I"].join("\n"));
  assert.deepEqual(calc.inputs.map((i) => i.name), ["V", "R"]);
  assert.deepEqual(calc.outputs.map(strip), [
    { name: "I", label: "current", unit: "A" },
    { name: "P", label: "", unit: "" },
  ]);
  assert.equal(calc.formula, "");
  // Lines that are not key: value are left out.
  assert.ok(parseCalc("", `Here is the calculator.\n${OHM}\n\nTry it!`));
  // A formula between dollars.
  assert.equal(parseCalc("", OHM.replace("formula: I = \\frac{V}{R}", "formula: $I = \\frac{V}{R}$")).formula, "I = \\frac{V}{R}");
});

test("fields separated by commas, as the system prompt spells the template", () => {
  const commas = OHM.replaceAll(" | ", ", ");
  const calc = parseCalc("Ohm's law", commas);
  const bars = parseCalc("Ohm's law", OHM);
  assert.deepEqual(calc.inputs, bars.inputs);
  assert.deepEqual(calc.outputs.map(strip), bars.outputs.map(strip));
  assert.equal(calc.outputs[0].expr.evaluate({ V: 12, R: 10 }), 1.2);
  assert.deepEqual(parsePlot("", SINE.replaceAll(" | ", ", ")).inputs, parsePlot("", SINE).inputs);
  // A comma inside parentheses is the formula's, not a field's.
  const max = parseCalc("", "input: a, 0..10, 2\ninput: b, 0..10, 7\noutput: m, larger, max(a, b), cm").outputs[0];
  assert.deepEqual(strip(max), { name: "m", label: "larger", unit: "cm" });
  assert.equal(max.expr.evaluate({ a: 2, b: 7 }), 7);
  // A line with a bar splits on bars only: its commas are words.
  assert.equal(parseInput("V | voltage, in volts | 0..24 | 12 | V").label, "voltage, in volts");
});

test("a calculator that can't be read is no card", () => {
  // No input, no output.
  assert.equal(parseCalc("", "output: I | current | 1 / 2 | A"), null);
  assert.equal(parseCalc("", "input: V | voltage | 0..24 | 12"), null);
  // A formula that can't be read, or that names something never declared.
  assert.equal(parseCalc("", OHM.replace("V / R", "V / (R")), null);
  assert.equal(parseCalc("", OHM.replace("V / R", "V / Q")), null);
  assert.equal(parseCalc("", OHM.replace("V / R", "eval(V)")), null);
  // An output using one declared after it.
  assert.equal(parseCalc("", OHM.replace("V / R", "P / V")), null);
  // Two of one name.
  assert.equal(parseCalc("", `${OHM}\ninput: V | again | 0..1`), null);
  assert.equal(parseCalc("", `${OHM}\noutput: V | again | R`), null);
  // An input without a range.
  assert.equal(parseCalc("", OHM.replace("0..24", "big")), null);
  // Too many.
  const many = (kind, n) => Array.from({ length: n }, (_, i) => (kind === "in" ? `input: a${i} | 0..1` : `output: b${i} | a0`)).join("\n");
  assert.ok(parseCalc("", `${many("in", 6)}\n${many("out", 6)}`));
  assert.equal(parseCalc("", `${many("in", 7)}\n${many("out", 1)}`), null);
  assert.equal(parseCalc("", `${many("in", 1)}\n${many("out", 7)}`), null);
});

test("a chart: its curves, ranges and inputs", () => {
  const plot = parsePlot("Sine wave", SINE);
  assert.equal(plot.title, "Sine wave");
  assert.equal(plot.formula, "y = A\\sin(\\omega x)");
  assert.deepEqual(plot.x, [0, 12]);
  assert.deepEqual(plot.curves.map((c) => c.source), ["A * sin(omega * x)"]);
  assert.deepEqual(plot.inputs.map((i) => [i.name, i.value, i.unit]), [["A", 1.4, ""], ["omega", 1.6, "rad/s"]]);
  // Auto range: what the curve spans wherever the sliders go (±2, A at its
  // most), padded a twentieth: the curve never leaves the frame.
  assert.ok(Math.abs(plot.y[0] + 2.2) < 0.01 && Math.abs(plot.y[1] - 2.2) < 0.01, String(plot.y));
});

test("a chart forgives: no x range, `y = …`, `y: a..b` as the range, no inputs", () => {
  const plot = parsePlot("", "y = x^2\ny: -1..5");
  assert.deepEqual(plot.x, [-10, 10]);
  assert.deepEqual(plot.y, [-1, 5]);
  assert.deepEqual(plot.inputs, []);
  assert.deepEqual(parsePlot("", "y: x\nyrange: 0..1").y, [0, 1]);
  const three = parsePlot("", "y: sin(x)\ny: cos(x)\ny: x/10");
  assert.equal(three.curves.length, 3);
});

test("a chart that can't be read is no card", () => {
  assert.equal(parsePlot("", "x: 0..1"), null);
  assert.equal(parsePlot("", "y: sin(x\nx: 0..1"), null);
  assert.equal(parsePlot("", "y: k * x"), null, "k is never declared");
  assert.equal(parsePlot("", "y: x\nx: wide"), null);
  assert.equal(parsePlot("", "y: x\ny: x\ny: x\ny: x"), null);
  assert.equal(parsePlot("", "y: x\ninput: x | 0..1"), null, "x is the chart's own");
  const inputs = Array.from({ length: 5 }, (_, i) => `input: a${i} | 0..1`).join("\n");
  assert.equal(parsePlot("", `y: x\n${inputs}`), null);
});

test("the auto range leaves out a curve shooting off at its poles", () => {
  const plot = parsePlot("", "y: tan(x)\nx: -1.5..1.5");
  const [lo, hi] = plot.y;
  assert.ok(hi < 60 && lo > -60, String(plot.y));
  // Across several poles, the frame is the curve's middle, not its spikes.
  for (const body of ["y: tan(x)\nx: -6..6", "y: tan(x)\nx: -3..3", "y: 1/x\nx: -5..5"]) {
    const [a, b] = parsePlot("", body).y;
    assert.ok(a > -10 && b < 10 && b - a > 2, `${body}: ${a}, ${b}`);
  }
  // A sharp peak is no pole: a resonance keeps its top.
  assert.ok(parsePlot("", "y: 1 / sqrt((1 - x^2)^2 + (0.02 * x)^2)\nx: 0..3").y[1] > 50);
  assert.ok(parsePlot("", "y: exp(-50 * x^2)\nx: -10..10").y[1] > 1);
  // Curves that only grow keep their whole span.
  assert.ok(parsePlot("", "y: exp(x)\nx: 0..10").y[1] > 22000);
  assert.ok(parsePlot("", "y: x^2\nx: -10..10").y[1] > 100);
  // A slider that would make the frame far wider than the curve at its start
  // (exp(k·x) up to k = 3) leaves the frame to the start.
  const grow = parsePlot("", "y: exp(k * x)\nx: 0..5\ninput: k | 0.1..3 | 1");
  assert.ok(grow.y[1] > 148 && grow.y[1] < 170, String(grow.y));
  // A curve flat at the start takes the frame its sliders give it.
  const still = parsePlot("", "y: A * sin(x)\nx: 0..12\ninput: A | 0..2 | 0");
  assert.ok(Math.abs(still.y[0] + 2.2) < 0.01 && Math.abs(still.y[1] - 2.2) < 0.01, String(still.y));
  const line = parsePlot("", "y: k * x\nx: 0..2\ninput: k | 0..5 | 0");
  assert.ok(line.y[1] >= 10 && line.y[1] < 11, String(line.y));
  // A pole next to curves the sliders stretch: the pole is cut, the curves'
  // reach kept (A·sin x with A at 3 stays inside the frame).
  const mixed = parsePlot("", "y: A*sin(x)\ny: A*cos(x)\ny: 1/x\nx: -5..5\ninput: A | 0..3 | 1");
  assert.ok(mixed.y[1] >= 3 && mixed.y[1] < 6 && mixed.y[0] <= -3 && mixed.y[0] > -6, String(mixed.y));
  // A flat curve still gets a frame.
  assert.deepEqual(autoRange({ curves: parsePlot("", "y: 0").curves, x: [0, 1] }, {}), [-1, 1]);
  assert.deepEqual(autoRange({ curves: parsePlot("", "y: 4").curves, x: [0, 1] }, {}), [2, 6]);
  // Nothing but NaN: a default frame.
  assert.deepEqual(autoRange({ curves: parsePlot("", "y: sqrt(-1 - x^2)").curves, x: [0, 1] }, {}), [-1, 1]);
});

test("a curve breaks where it is no number, and across a pole", () => {
  const sqrt = parsePlot("", "y: sqrt(x)\nx: -1..1\nyrange: 0..1");
  const [pieces] = tracePlot(sqrt, {}, 100, 50);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0][0][0], 50, "starts at x = 0, the middle");
  assert.equal(pieces[0][0][1], 50, "y = 0 at the bottom");
  assert.equal(pieces[0].at(-1)[1], 0, "y = 1 at the top");

  const inverse = parsePlot("", "y: 1/x\nx: -1..1\nyrange: -5..5");
  const [parts] = tracePlot(inverse, {}, 101, 50);
  assert.equal(parts.length, 2, "no line from -∞ to +∞");
  for (const piece of parts) for (const [, y] of piece) assert.ok(y >= -50 && y <= 100);
});

test("the curves follow the inputs' values", () => {
  const plot = parsePlot("", "y: a * x\nx: 0..1\nyrange: 0..2\ninput: a | 0..2 | 1");
  const at = (a) => tracePlot(plot, { a }, 10, 100)[0][0].at(-1)[1];
  assert.equal(at(1), 50);
  assert.equal(at(2), 0);
});

// ── Numbers and names ─────────────────────────────────────────────────────────

test("numbers in three or four significant digits, — for no number", () => {
  assert.equal(formatNumber(1.2), "1.20");
  assert.equal(formatNumber(14.4), "14.4");
  assert.equal(formatNumber(1.23456), "1.235");
  assert.equal(formatNumber(123.456), "123.5");
  assert.equal(formatNumber(12345.6), "12,346");
  assert.equal(formatNumber(0), "0");
  assert.equal(formatNumber(-2.5), "-2.50");
  assert.equal(formatNumber(2.5e7), "2.50\u202f×\u202f10⁷");
  assert.equal(formatNumber(0.00001234), "1.23\u202f×\u202f10⁻⁵");
  // Down to a ten-thousandth as plain decimals, as its neighbours read.
  assert.equal(formatNumber(0.00012), "0.000120");
  assert.equal(formatNumber(0.00144), "0.00144");
  assert.equal(formatNumber(NaN), "—");
  assert.equal(formatNumber(Infinity), "—");
  assert.equal(formatValue(12, 0.2), "12.0");
  assert.equal(formatValue(10, 1), "10");
  assert.equal(formatValue(1.6, 0.05), "1.60");
  assert.equal(formatValue(100, 10), "100");
  assert.equal(formatValue(9.81, 0.2), "9.81", "a first value off the step's grid keeps its decimals");
  assert.equal(formatValue(0.1 + 0.2, 0.1), "0.3", "not a float's long tail");
  // A step finer than a millionth: scientific notation, never 0.000000.
  assert.equal(formatValue(1e-7, parseInput("q | charge | 1e-9..1e-6 | 1e-7 | C").step), "1.0\u202f×\u202f10⁻⁷");
  assert.equal(formatValue(1.5e-7, 1e-8), "1.5\u202f×\u202f10⁻⁷");
  assert.equal(formatValue(550e-9, parseInput("l | wavelength | 380e-9..750e-9 | 550e-9 | m").step), "5.50\u202f×\u202f10⁻⁷");
  assert.equal(formatValue(0, 1e-8), "0");
});

test("names as TeX", () => {
  assert.equal(texName("V"), "V");
  assert.equal(texName("omega"), "\\omega");
  assert.equal(texName("Delta"), "\\Delta");
  assert.equal(texName("V_out"), "V_{out}");
  assert.equal(texName("omega_0"), "\\omega_{0}");
  assert.equal(texName("x_alpha"), "x_{\\alpha}");
  assert.equal(texName("speed"), "\\mathit{speed}");
});

// ── The cards ─────────────────────────────────────────────────────────────────

const ranges = (el) => el.find("INPUT").filter((i) => i.getAttribute("type") === "range");
const results = (el) => el.find(".rc-out-num").map((n) => n.textContent);

test("the calculator: sliders, results, and both following each other", () => {
  const key = keyOf({ type: "calc", title: "Ohm's law", body: OHM });
  const el = renderCalc(parseCalc("Ohm's law", OHM), ctx, key);
  assert.ok(el.classList.contains("rc-card") && el.classList.contains("rc-calc"));
  assert.equal(el.querySelector(".rc-kind").textContent, "Calculator");
  assert.equal(el.querySelector(".rc-title").textContent, "Ohm's law");
  assert.equal(el.querySelector(".rc-head-tex").textContent, "I = \\frac{V}{R}");
  const [v, r] = ranges(el);
  assert.deepEqual([v.getAttribute("min"), v.getAttribute("max"), v.getAttribute("step"), v.getAttribute("value")], ["0", "24", "0.1", "12"]);
  assert.equal(v.getAttribute("aria-label"), "voltage");
  assert.equal(v.style["--p"], "50%");
  assert.deepEqual(results(el), ["1.20", "14.4"]);
  assert.deepEqual(el.find(".rc-out-unit").map((u) => u.textContent), ["A", "W"]);
  assert.deepEqual(el.find(".rc-out-unit").map((u) => u.getAttribute("title")), ["A", "W"], "a unit cut short reads whole on hover");
  assert.deepEqual(el.find(".rc-slider-val").map((c) => c.textContent), ["12.0 V", "10 Ω"]);

  v.value = "24";
  v.fire("input");
  assert.deepEqual(results(el), ["2.40", "57.6"]);
  assert.equal(el.find(".rc-slider-val")[0].textContent, "24.0 V");
  assert.equal(v.getAttribute("aria-valuetext"), "24.0 V");
  assert.equal(v.style["--p"], "100%");

  // A redraw of the chat builds the card anew where its sliders were.
  const again = renderCalc(parseCalc("Ohm's law", OHM), ctx, key);
  assert.deepEqual(results(again), ["2.40", "57.6"]);
  assert.equal(ranges(again)[0].getAttribute("value"), "24");

  r.value = "0";
  r.fire("input");
  assert.equal(results(el)[0], "—", "dividing by zero shows no number");
});

test("a slider reaches its max when the span is no multiple of its step", () => {
  const body = "input: R | resistance | 1..100000 | 10 | Ω\noutput: I | current | 12 / R | A";
  const el = renderCalc(parseCalc("", body), ctx, keyOf({ type: "calc", title: "", body }));
  const [r] = ranges(el);
  // Stops at 1, 1001, …, 99001: the end goes one stop further, read as the max.
  assert.equal(r.getAttribute("step"), "1000");
  assert.equal(r.getAttribute("max"), "100001");
  r.value = "100001";
  r.fire("input");
  assert.equal(el.find(".rc-slider-val")[0].textContent, "100,000 Ω");
  assert.equal(r.style["--p"], "100%");
  assert.equal(results(el)[0], "0.000120");
  // A span the step divides keeps its own max.
  const ohm = renderCalc(parseCalc("", OHM), ctx, "ohm-max");
  assert.equal(ranges(ohm)[0].getAttribute("max"), "24");
  assert.equal(ranges(ohm)[1].getAttribute("max"), "100");
  const turn = renderCalc(parseCalc("", "input: t | 0..2pi | 1\noutput: s | sin(t)"), ctx, "turn");
  assert.equal(ranges(turn)[0].getAttribute("max"), "6.3");
});

test("many results lie in two columns, so the card stays low", () => {
  const body = "input: a | 0..1 | 0.5\n" + ["b", "c", "d", "f"].map((n) => `output: ${n} | a`).join("\n");
  const el = renderCalc(parseCalc("", body), ctx, keyOf({ type: "calc", title: "", body }));
  assert.ok(el.querySelector(".rc-calc-out.two"));
  assert.equal(el.querySelector(".rc-head-tex"), null, "no formula, nothing on the right");
});

test("the chart: a canvas over its sliders, quiet without a 2D context", () => {
  const key = keyOf({ type: "plot", title: "Sine wave", body: SINE });
  const el = renderPlot(parsePlot("Sine wave", SINE), ctx, key);
  assert.equal(el.querySelector(".rc-kind").textContent, "Chart");
  const canvas = el.find("CANVAS")[0];
  assert.equal(canvas.getAttribute("role"), "img");
  assert.equal(canvas.getAttribute("aria-label"), "y = A * sin(omega * x)");
  const [a] = ranges(el);
  a.value = "2";
  a.fire("input");
  assert.equal(el.find(".rc-slider-val")[0].textContent, "2.0");
  const again = renderPlot(parsePlot("Sine wave", SINE), ctx, key);
  assert.equal(ranges(again)[0].getAttribute("value"), "2");
});

test("through the Markdown: a card, or the block as code when it can't be read", () => {
  const good = document.createElement("div");
  renderMarkdown(good, "Try it:\n\n```lumo-calc Ohm's law\n" + OHM + "\n```\n");
  assert.equal(good.find(".rc-calc").length, 1);
  const plot = document.createElement("div");
  renderMarkdown(plot, "```lumo-plot Sine\n" + SINE + "\n```");
  assert.equal(plot.find(".rc-plot").length, 1);
  const bad = document.createElement("div");
  renderMarkdown(bad, "```lumo-calc Broken\ninput: V | 0..1\noutput: I | V / Q\n```");
  assert.equal(bad.find(".rc-calc").length, 0);
  assert.ok(bad.textContent.includes("output: I | V / Q"));
});
