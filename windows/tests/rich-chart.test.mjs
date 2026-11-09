// The ```lumo-chart card (src/views/rich/chart.ts): how a block is read into
// labels and series, forgiving the ways models write numbers, how the
// numbers are shown in the app's language, and the card itself: bars or
// lines, the table, the switch remembered across the chat's redraws.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { parseChart, parseNumber, valueAxis, formatValue, monthNames, chartCsv, renderChart, MAX_LABELS } = await import("../src/views/rich/chart.ts");
const { renderMarkdown } = await import("../src/views/markdown.ts");
const { setLanguage, t } = await import("../src/i18n/i18n.ts");

const ctx = {
  markdown: (into, text) => into.append(text),
  inline: (into, text) => into.append(text),
  math: (tex) => document.createTextNode(tex),
  copyButton: (text) => {
    const b = document.createElement("button");
    b.dataset.copy = text;
    b.className = "md-copy";
    return b;
  },
};

const RHO = "unità: 10⁻⁸ Ω·m\nArgento: 1.59\nRame: 1.68\nOro: 2.44\nAlluminio: 2.65\nTungsteno: 5.6\nFerro: 9.71";
const TEMPS = "x: G F M A M G L A S O N D\nMassima: 6 9 14 18 23 27 30 29 24 18 11 7\nMinima: -1 0 4 8 12 16 19 18 14 10 4 0";

// ── Reading ───────────────────────────────────────────────────────────────────

test("bars: a label and a value per row, the unit, the decimals they were written with", () => {
  const chart = parseChart("barre Resistività a 20 °C", RHO);
  assert.equal(chart.kind, "bar");
  assert.equal(chart.title, "Resistività a 20 °C");
  assert.equal(chart.unit, "10⁻⁸ Ω·m");
  assert.deepEqual(chart.labels, ["Argento", "Rame", "Oro", "Alluminio", "Tungsteno", "Ferro"]);
  assert.deepEqual(chart.series, [{ name: "", values: [1.59, 1.68, 2.44, 2.65, 5.6, 9.71] }]);
  assert.equal(chart.digits, 2);
});

test("the kind is the title's first word in lowercase, English or Italian; bar without one", () => {
  assert.equal(parseChart("line Temps", "a: 1\nb: 2").kind, "line");
  assert.equal(parseChart("lines Temps", "a: 1\nb: 2").kind, "line");
  assert.equal(parseChart("linee Temperature", "a: 1\nb: 2").kind, "line");
  assert.equal(parseChart("bars Sales", "a: 1\nb: 2").kind, "bar");
  const plain = parseChart("Line count by file", "a: 1\nb: 2");
  assert.equal(plain.kind, "bar", "a capitalised first word is the title's");
  assert.equal(plain.title, "Line count by file");
  const none = parseChart("Sales by region", "a: 1\nb: 2");
  assert.equal(none.kind, "bar");
  assert.equal(none.title, "Sales by region");
  assert.equal(parseChart("Sales", "type: line\na: 1\nb: 2").kind, "line");
});

test("several series: a series line, then a value per series on each row", () => {
  const chart = parseChart("line Temperatures", "unit: °C\nseries: High, Low\nJan: 6, -1\nFeb: 9; 0\nMar: 14 | 4");
  assert.deepEqual(chart.labels, ["Jan", "Feb", "Mar"]);
  assert.deepEqual(chart.series, [
    { name: "High", values: [6, 9, 14] },
    { name: "Low", values: [-1, 0, 4] },
  ]);
  assert.equal(chart.unit, "°C");
});

test("turned around: a row of labels, then each row a series (the concept's way)", () => {
  const chart = parseChart("linee Temperature", TEMPS);
  assert.equal(chart.labels.length, 12);
  assert.deepEqual(chart.series.map((s) => s.name), ["Massima", "Minima"]);
  assert.equal(chart.series[1].values[0], -1);
  assert.equal(chart.digits, 0);
  const commas = parseChart("", "labels: Q1, Q2, Q3\nNorth: 1,5, 2,5, 3\nSouth: 2; 3; n/a");
  assert.deepEqual(commas.series[0].values, [1.5, 2.5, 3]);
  assert.ok(Number.isNaN(commas.series[1].values[2]), "a missing value is a gap");
  const short = parseChart("", "x: a b c\ns: 1 2");
  assert.ok(Number.isNaN(short.series[0].values[2]), "a short row leaves gaps");
});

test("forgiving: list markers, `=`, bold labels, a unit after every value, a colon in a label", () => {
  const chart = parseChart("", "- **Rome** = 12 %\n* Milan: 9,5 %\n1. Turin: 7 %\n10:30: 4 %");
  assert.deepEqual(chart.labels, ["Rome", "Milan", "Turin", "10:30"]);
  assert.deepEqual(chart.series[0].values, [12, 9.5, 7, 4]);
  assert.equal(chart.unit, "%");
  assert.equal(chart.digits, 1);
  // Units that differ say nothing about the chart.
  assert.equal(parseChart("", "a: 1 kg\nb: 2 g").unit, "");
  // Rows that aren't data are left out.
  assert.deepEqual(parseChart("", "Here they are\na: 1\nnot a number: x\nb: 2\n…").labels, ["a", "b"]);
});

test("several values on a row without a series line are numbered series; space-grouped thousands are one", () => {
  const chart = parseChart("", "A: 1, 2\nB: 3, 4");
  assert.deepEqual(chart.series.map((s) => s.name), ["1", "2"]);
  const big = parseChart("", "Rome: 2 873 000\nMilan: 1 371 000");
  assert.equal(big.series.length, 1);
  assert.deepEqual(big.series[0].values, [2873000, 1371000]);
});

test("a row of gaps keeps its label, so the labels stay evenly spaced", () => {
  const one = parseChart("line Pioggia", "Gen: 3\nFeb: 4\nMar: -\nApr: 6\nMag: 2");
  assert.deepEqual(one.labels, ["Gen", "Feb", "Mar", "Apr", "Mag"]);
  assert.ok(Number.isNaN(one.series[0].values[2]));
  const two = parseChart("line Pioggia", "series: A, B\nGen: 3, 1\nMar: -, n/a\nApr: 6, 2");
  assert.deepEqual(two.labels, ["Gen", "Mar", "Apr"]);
  assert.ok(two.series.every((s) => Number.isNaN(s.values[1])));
  assert.equal(parseChart("line Pioggia", "Gen: -\nFeb: n/a"), null, "no number at all is no chart");
});

test("unusable blocks are null: too few or too many labels or series, no numbers", () => {
  assert.equal(parseChart("bar Alone", "a: 1"), null);
  assert.equal(parseChart("bar Words", "a: one\nb: two"), null);
  assert.equal(parseChart("bar", ""), null);
  const many = Array.from({ length: MAX_LABELS + 1 }, (_, i) => `r${i}: ${i}`).join("\n");
  assert.equal(parseChart("bar Many", many), null);
  assert.ok(parseChart("bar Enough", many.split("\n").slice(0, MAX_LABELS).join("\n")));
  assert.equal(parseChart("", "series: a, b, c, d, e\nr1: 1, 2, 3, 4, 5\nr2: 1, 2, 3, 4, 5"), null);
  assert.equal(parseChart("", "x: a b\nS1: 1 2\nS2: 1 2\nS3: 1 2\nS4: 1 2\nS5: 1 2"), null);
  assert.equal(parseChart("", "series: a, b\nr1: -, -\nr2: 1, -\nr3: 2, -"), null, "a series with no value at all");
});

test("numbers as models write them", () => {
  const v = (s) => parseNumber(s)?.value ?? null;
  assert.equal(v("1.59"), 1.59);
  assert.equal(v("1,59"), 1.59);
  assert.equal(v("−1"), -1);
  assert.equal(v("-0.5"), -0.5);
  assert.equal(v("1,234"), 1234);
  assert.equal(v("1,234.5"), 1234.5);
  assert.equal(v("1.234,5"), 1234.5);
  assert.equal(v("1.234.567"), 1234567);
  assert.equal(v("1 234"), 1234);
  assert.equal(v("1'234"), 1234);
  assert.equal(v("1.2e-3"), 0.0012);
  assert.equal(v("$40"), 40);
  assert.equal(v(".5"), 0.5);
  assert.equal(v("6 9"), null);
  assert.equal(v("abc"), null);
  assert.equal(v("about 5"), null);
  assert.deepEqual(parseNumber("12 %"), { value: 12, decimals: 0, unit: "%" });
  assert.deepEqual(parseNumber("6,5 °C"), { value: 6.5, decimals: 1, unit: "°C" });
  assert.equal(parseNumber("1.2e-3").decimals, 4);
});

test("a decimal comma after a leading zero is a decimal, never a thousands group", () => {
  const v = (s) => parseNumber(s)?.value ?? null;
  assert.equal(v("0,001"), 0.001);
  assert.equal(v("0,250"), 0.25);
  assert.equal(v("-0,500"), -0.5);
  assert.equal(v("1,250"), 1250);
  const chart = parseChart("bar Concentrazione", "unit: mol/L\nA: 0,001\nB: 0,005\nC: 0,010");
  assert.deepEqual(chart.series[0].values, [0.001, 0.005, 0.01]);
  assert.equal(chart.digits, 3);
});

test("a data row named like a key stays data when its value doesn't fit the key", () => {
  const social = parseChart("bar Monthly active users", "unit: million\nFacebook: 3070\nInstagram: 2000\nX: 550\nThreads: 275");
  assert.deepEqual(social.labels, ["Facebook", "Instagram", "X", "Threads"]);
  assert.deepEqual(social.series[0].values, [3070, 2000, 550, 275]);
  assert.equal(social.unit, "million");
  const scores = parseChart("bar Scores", "A: 1\nB: 2\nLabel: 3\nC: 4");
  assert.deepEqual(scores.labels, ["A", "B", "Label", "C"]);
  const first = parseChart("bar Counts", "Unit: 5\nSeries: 3\nOther: 2");
  assert.deepEqual(first.labels, ["Unit", "Series", "Other"]);
  assert.equal(first.unit, "");
  // Keys that fit still work: a unit with a number in it, numeric labels, numeric series names.
  assert.equal(parseChart("bar R", RHO).unit, "10⁻⁸ Ω·m");
  const years = parseChart("line Sales", "x: 2021 2022 2023\nA: 1 2 3");
  assert.deepEqual(years.labels, ["2021", "2022", "2023"]);
  const named = parseChart("bar Sales", "series: 2023, 2024\nA: 1, 2\nB: 3, 4");
  assert.deepEqual(named.series.map((s) => s.name), ["2023", "2024"]);
});

// ── Numbers shown ─────────────────────────────────────────────────────────────

test("the value axis: round steps, room beyond the values, a line at each round number", () => {
  assert.deepEqual(valueAxis(-1, 30), { min: -5, max: 35, ticks: [0, 10, 20, 30], step: 10 });
  const flat = valueAxis(5, 5);
  assert.ok(flat.min < 5 && flat.max > 5 && flat.ticks.length >= 1);
  const small = valueAxis(0.1, 0.4);
  assert.ok(small.ticks.every((t) => t >= small.min && t <= small.max));
});

test("the value axis ends when the values are a hair apart (adjacent doubles)", () => {
  for (const [lo, hi] of [[1, 1.0000000000000002], [1e20, 1e20 + 16384], [123456789.123, 123456789.12300001], [-1e-300, -1e-300 * (1 - 2 ** -52)]]) {
    const started = Date.now();
    const axis = valueAxis(lo, hi);
    assert.ok(Date.now() - started < 200, `${lo} ${hi}`);
    assert.ok(axis.ticks.length >= 1 && axis.ticks.length < 50, `${lo} ${hi}`);
    assert.ok(axis.min <= lo && axis.max >= hi && axis.step > 0, `${lo} ${hi}`);
  }
  const into = document.createElement("div");
  renderMarkdown(into, "```lumo-chart line Big\na: 100000000000000000000\nb: 100000000000000016384\n```\n");
  assert.ok(into.querySelector(".rc-lines"));
});

test("values in the app's language, with the chart's decimals", () => {
  setLanguage("it");
  assert.equal(formatValue(5.6, 2), "5,60");
  assert.equal(formatValue(-1, 0), "\u22121", "a minus sign, not a hyphen");
  setLanguage("en");
  assert.equal(formatValue(5.6, 2), "5.60");
  assert.equal(formatValue(1234567, 0), "1,234,567");
  assert.equal(formatValue(NaN, 2), "–");
});

test("twelve month initials are named in full in the values under the pointer", () => {
  setLanguage("it");
  assert.equal(monthNames("G F M A M G L A S O N D".split(" "))[6], "Luglio");
  setLanguage("en");
  assert.equal(monthNames("J F M A M J J A S O N D".split(" "))[0], "January");
  assert.equal(monthNames("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" "))[11], "December");
  assert.equal(monthNames("a b c d e f g h i j k l".split(" ")), null);
  assert.equal(monthNames(["J", "F"]), null);
});

test("CSV: a label column, a column per series, numbers with a dot, fields quoted when needed", () => {
  const chart = parseChart("line Temps", 'series: High, Low\nJan: 6, -1\nFeb, "early": 9,5, -');
  assert.equal(chartCsv(chart), ',High,Low\nJan,6,-1\n"Feb, ""early""",9.5,\n');
  assert.equal(chartCsv(parseChart("bar Rho", RHO)).split("\n")[0], ",10⁻⁸ Ω·m");
});

// ── The card ──────────────────────────────────────────────────────────────────

test("bars: a row per label with its bar and value, the unit in the top line, real buttons", () => {
  setLanguage("en");
  const el = renderChart(parseChart("barre Resistività", RHO), ctx, "k-bars");
  assert.ok(el.classList.contains("rc-chart"));
  const rows = el.find(".rc-brow");
  assert.equal(rows.length, 6);
  assert.equal(rows[5].querySelector(".rc-brow-k").textContent, "Ferro");
  assert.equal(rows[5].querySelector(".rc-brow-v").textContent, "9.71");
  assert.equal(rows[4].querySelector(".rc-brow-v").textContent, "5.60");
  const bar = rows[5].find("I")[0];
  assert.match(bar.getAttribute("style"), /width:100\.000%/);
  assert.equal(el.querySelector(".rc-chart-unit").textContent, "10⁻⁸ Ω·m");
  const buttons = el.querySelector(".rc-chart-view").find("BUTTON");
  assert.deepEqual(buttons.map((b) => b.textContent), ["Bars", "Table"]);
  assert.ok(buttons.every((b) => b.getAttribute("title")));
  assert.equal(el.querySelector(".md-copy").dataset.copy.split("\n")[1], "Argento,1.59");
});

test("the table switch shows the numbers and is remembered across redraws", () => {
  const chart = parseChart("bar Rho", RHO);
  const el = renderChart(chart, ctx, "k-switch");
  const [, table] = el.querySelector(".rc-chart-view").find("BUTTON");
  table.fire("click");
  assert.ok(el.querySelector(".rc-chart-table"));
  assert.equal(el.querySelector(".rc-bars"), null);
  assert.equal(table.getAttribute("aria-pressed"), "true");
  const again = renderChart(chart, ctx, "k-switch");
  assert.ok(again.querySelector(".rc-chart-table"), "the redrawn card still shows the table");
  assert.equal(again.find("TR").length, 6);
  const other = renderChart(chart, ctx, "k-other");
  assert.ok(other.querySelector(".rc-bars"), "another block starts on the chart");
  const [bars] = again.querySelector(".rc-chart-view").find("BUTTON");
  bars.fire("click");
  assert.ok(again.querySelector(".rc-bars"));
});

test("lines: SVG nodes, a line per series, a legend, the values beside the point picked with the arrows", () => {
  setLanguage("it");
  const el = renderChart(parseChart("linee Temperature medie a Milano", "unit: °C\n" + TEMPS), ctx, "k-lines");
  const frame = el.querySelector(".rc-lines");
  assert.equal(frame.find("PATH").length, 2);
  assert.ok(frame.find("SVG")[0].namespaceURI.endsWith("/svg"));
  const texts = frame.find("TEXT").map((t) => t.textContent);
  for (const tick of ["0", "10", "20", "30"]) assert.ok(texts.includes(tick), tick);
  assert.ok(texts.includes("L"));
  assert.deepEqual(el.querySelector(".rc-chart-legend").textContent, "MassimaMinima");
  assert.deepEqual(el.querySelector(".rc-chart-view").find("BUTTON")[0].textContent, t("Lines"));
  for (let i = 0; i <= 6; i++) frame.fire("keydown", { key: "ArrowRight" });
  const tip = frame.querySelector(".rc-chart-tip");
  assert.ok(tip);
  assert.equal(tip.find("B")[0].textContent, "Luglio");
  assert.deepEqual(tip.find("EM").map((e) => e.textContent), ["30 °C", "19 °C"]);
  assert.equal(frame.find("CIRCLE").length, 2);
  frame.fire("pointerleave");
  assert.equal(frame.querySelector(".rc-chart-tip"), null);
  assert.equal(frame.find("CIRCLE").length, 0);
  setLanguage("en");
});

test("lines: Escape clears the picked point, and with none picked it reaches the island", () => {
  const el = renderChart(parseChart("line T", "x: a b c\nS: 1 2 3"), ctx, "k-esc");
  const frame = el.querySelector(".rc-lines");
  let stopped = false;
  const free = frame.fire("keydown", { key: "Escape", stopPropagation() { stopped = true; } });
  assert.equal(free.defaultPrevented, false);
  assert.equal(stopped, false);
  frame.fire("keydown", { key: "ArrowRight" });
  assert.ok(frame.querySelector(".rc-chart-tip"));
  const taken = frame.fire("keydown", { key: "Escape", stopPropagation() { stopped = true; } });
  assert.equal(taken.defaultPrevented, true);
  assert.equal(stopped, true);
  assert.equal(frame.querySelector(".rc-chart-tip"), null);
});

test("a model's labels reach the page as text only", () => {
  const el = renderChart(parseChart("line <img src=x onerror=alert(1)>", "x: <b>a</b> b\n<script>: 1 2"), ctx, "k-text");
  const texts = el.querySelector(".rc-lines").find("TEXT").map((t) => t.textContent);
  assert.ok(texts.includes("<b>a</b>"));
  assert.equal(el.querySelector(".rc-title").textContent, "<img src=x onerror=alert(1)>");
  // innerHTML throws in the fake DOM: getting here means it was never used.
});

test("in an answer, a lumo-chart block becomes the card, a broken one stays code", () => {
  const into = document.createElement("div");
  renderMarkdown(into, "The resistivity:\n\n```lumo-chart bar Resistivity\n" + RHO + "\n```\n");
  assert.ok(into.querySelector(".rc-chart"));
  const broken = document.createElement("div");
  renderMarkdown(broken, "```lumo-chart bar Alone\nOnly: 1\n```\n");
  assert.equal(broken.querySelector(".rc-chart"), null);
  assert.match(broken.textContent, /Only: 1/);
});
