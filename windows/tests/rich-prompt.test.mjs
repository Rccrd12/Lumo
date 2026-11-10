// Every syntax the system prompt teaches (chat.rs rich_note!), written the way
// the note says it, run through the real parsers: a parser change that would
// break what the models are told to write fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
installFakeDom();
const W = "../src";
const { parseMarkdown, checklistsIn } = await import(`${W}/views/markdown.ts`);
const { parseSteps } = await import(`${W}/views/rich/steps.ts`);
const { parseCards } = await import(`${W}/views/rich/cards.ts`);
const { parseCalc, parsePlot, inRegion } = await import(`${W}/views/rich/calc.ts`);
const { parseQuiz } = await import(`${W}/views/rich/quiz.ts`);
const { parseChart } = await import(`${W}/views/rich/chart.ts`);
const { parseTimeline } = await import(`${W}/views/rich/timeline.ts`);
const { parseDiff } = await import(`${W}/views/rich/diff-card.ts`);
const { parseChecklist, stateLine } = await import(`${W}/core/checklists.ts`);
const F = "```";
const one = (md) => { const b = parseMarkdown(md); return b.find((x) => x.kind !== "paragraph") ?? b[0]; };
const rich = (md) => { const b = one(md); assert.equal(b.kind, "rich", JSON.stringify(b)); assert.equal(b.open, false); return b; };

test("callout", () => {
  for (const k of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) {
    const b = one(`> [!${k}] Ohm's law\n> Current is $V/R$.`);
    assert.match(b.kind, /callout|alert/);
  }
});
test("task list and lumo-checklist", () => {
  const b = one("- [ ] Install Node\n- [x] Clone the repo\n- [ ] Run npm test");
  assert.equal(checklistsIn("- [ ] Install Node\n- [x] Clone the repo").length, 1);
  const r = rich(`${F}lumo-checklist Release 0.5\n- [ ] Bump the version\n- [x] Write the changelog\n${F}`);
  const c = parseChecklist(r.title, r.body);
  assert.equal(c.title, "Release 0.5"); assert.equal(c.items.length, 2);
});
test("diff", () => {
  const b = one(`${F}diff src/core/timing.ts\n export function f() {\n-  let t: number;\n+  let t: number | undefined;\n${F}`);
  assert.equal(b.kind, "code");
  const d = parseDiff(b.code, b.lang.slice(4).trim());
  assert.ok(d); assert.equal(d.path, "src/core/timing.ts"); assert.equal(d.added, 1);
});
test("steps", () => {
  const r = rich(`${F}lumo-steps Integration by parts\n## Product rule\n$$d(uv) = u\\,dv + v\\,du$$\n## Integrate\n$$uv = \\int u\\,dv + \\int v\\,du$$\nThen rearrange.\n${F}`);
  const s = parseSteps(r.title, r.body); assert.ok(s); assert.equal(s.steps.length, 2);
});
test("cards", () => {
  const r = rich(`${F}lumo-cards Rocky planets\n## Mercury\nsub: Closest to the Sun\nicon: planet gray\n- Distance: 58 million km\n- Day: 176 Earth days\nHot by day.\n## Saturn\nicon: planet amber ring\n- Moons: 146\nRings of ice.\n## Python\nicon: Py blue\n- Typing: dynamic\nEasy.\n## Rust\nicon: 🦀 #ff8a5b\n- Typing: static\nFast.\n${F}`);
  const c = parseCards(r.title, r.body); assert.ok(c); assert.equal(c.cards.length, 4);
  assert.equal(c.cards[1].icon.ring, true);
  assert.equal(c.cards[3].icon.text, "🦀");
});
test("calc", () => {
  const r = rich(`${F}lumo-calc Ohm's law\nformula: I = \\frac{V}{R}\ninput: V | voltage | 0..24 | 12 | V\ninput: R | resistance | 1..100 step 1 | 10 | Ω\noutput: I | current | V/R | A\noutput: P | power | V*I | W\noutput: Q | test | sqrt(V**2)*exp(0)*ln(e)+0*pi | W\n${F}`);
  const c = parseCalc(r.title, r.body); assert.ok(c); assert.equal(c.outputs.length, 3); assert.equal(c.inputs[1].step, 1);
  assert.equal(c.outputs[2].expr.evaluate({ V: 12, I: 1.2 }), 12);
});
test("plot", () => {
  const r = rich(`${F}lumo-plot Sine wave\nformula: y = A\\sin(\\omega x)\ny: A*sin(w*x)\ny: x**2/10\nx: 0..12\nyrange: -2..2\ninput: A | amplitude | 0..2 | 1.4\ninput: w | angular frequency | 0.5..4 | 1.6 | rad/s\n${F}`);
  const p = parsePlot(r.title, r.body); assert.ok(p); assert.equal(p.curves.length, 2); assert.deepEqual(p.y, [-2, 2]);
});
test("plot region, the points where its conditions hold, a curve and an input among them", () => {
  // The note's two examples: the area under a curve and a disc.
  const r = rich(`${F}lumo-plot Area under the sine\ny: sin(x)\nx: 0..3.14\nregion: 0 ≤ y ≤ sin(x)\n${F}`);
  const p = parsePlot(r.title, r.body); assert.ok(p); assert.equal(p.regions.length, 1);
  const under = (x, y) => inRegion(p.regions[0], { x, y });
  assert.ok(under(1.5, 0.5)); assert.ok(!under(1.5, 1.2), "above the curve"); assert.ok(!under(1.5, -0.1), "below the axis");
  const disc = parsePlot("", "y: x\nx: -1..1\nregion: x*x+y*y ≤ 1");
  assert.ok(inRegion(disc.regions[0], { x: 0.5, y: 0.5 })); assert.ok(!inRegion(disc.regions[0], { x: 0.9, y: 0.9 }));
  // Spelled with and, and with a slider in it: the shading follows the slider.
  const a = parsePlot("", "y: A*sin(x)\nx: 0..3.14\ninput: A, amplitude, 0..3, 1\nregion: y ≥ 0 and y ≤ A*sin(x)");
  assert.ok(a);
  assert.ok(!inRegion(a.regions[0], { x: 1.5, y: 2, A: 1 })); assert.ok(inRegion(a.regions[0], { x: 1.5, y: 2, A: 3 }));
});
test("calc and plot, fields separated by commas as the note's template spells them", () => {
  const c = parseCalc("Ohm", "formula: I = V/R\ninput: V, voltage, 0..24, 12, V\ninput: R, resistance, 1..100, 10, Ω\noutput: I, current, V/R, A");
  assert.ok(c); assert.equal(c.inputs.length, 2); assert.equal(c.inputs[1].unit, "Ω");
  assert.equal(c.outputs[0].label, "current"); assert.equal(c.outputs[0].unit, "A");
  const p = parsePlot("Sine", "formula: y = A\\sin(x)\ny: A*sin(x)\nx: 0..12\ninput: A, amplitude, 0..2, 1.4");
  assert.ok(p); assert.equal(p.inputs[0].value, 1.4);
});
test("quiz", () => {
  const r = rich(`${F}lumo-quiz Op-amp\n? What is the gain of an inverting amplifier?\n- $R_2/R_1$\n+ $-R_2/R_1$\n- $1 + R_2/R_1$\n> The minus sign means the output is inverted.\n= Inverting gain\n? Ideal input current?\n+ Zero\n- Infinite\n${F}`);
  const q = parseQuiz(r.title, r.body); assert.ok(q); assert.equal(q.questions.length, 2);
  assert.equal(q.questions[0].right, 1); assert.equal(q.questions[0].short, "Inverting gain"); assert.match(q.questions[0].why, /minus/);
});
test("chart", () => {
  let r = rich(`${F}lumo-chart bar Resistivity at 20 °C\nunit: nΩ·m\nSilver: 15.9\nCopper: 16.8\nGold: 24.4\n${F}`);
  let c = parseChart(r.title, r.body); assert.ok(c); assert.equal(c.kind, "bar"); assert.equal(c.title, "Resistivity at 20 °C"); assert.equal(c.unit, "nΩ·m");
  r = rich(`${F}lumo-chart line Milan\nunit: °C\nseries: High, Low\nJan: 6, -1\nFeb: 9, 0\nMar: 14, 4\n${F}`);
  c = parseChart(r.title, r.body); assert.ok(c); assert.equal(c.kind, "line"); assert.equal(c.series.length, 2); assert.deepEqual(c.series[1].values, [-1, 0, 4]);
});
test("timeline", () => {
  let r = rich(`${F}lumo-timeline Microprocessors\n1947 Transistor: at Bell Labs.\n1958 Integrated circuit\n1971-11 Intel 4004: the first microprocessor.\n2026-11-08 Today\n${F}`);
  let t = parseTimeline(r.title, r.body); assert.ok(t); assert.equal(t.kind, "events"); assert.equal(t.items.length, 4);
  assert.equal(t.items[0].label, "Transistor"); assert.equal(t.items[0].detail, "at Bell Labs.");
  r = rich(`${F}lumo-timeline Calculus\n2026-11-01..2026-11-07 Limits\n2026-11-08..2026-11-16 Integrals: multiple ones.\n2026-12-09 Exam\n${F}`);
  t = parseTimeline(r.title, r.body); assert.ok(t); assert.equal(t.kind, "plan"); assert.equal(t.items.at(-1).milestone, true);
});
test("image", () => {
  const b = one("![Saturn seen by Cassini](https://upload.wikimedia.org/wikipedia/commons/c/c7/Saturn_during_Equinox.jpg)");
  assert.equal(b.kind, "image");
});

test("the local models' examples, one of each block, are all drawn as written", async () => {
  const { readFileSync } = await import("node:fs");
  const rust = readFileSync(new URL("../src-tauri/src/local_profile.rs", import.meta.url), "utf8");
  const m = /const LOCAL_RICH_EXAMPLE: &str = r#"([\s\S]*?)"#;/.exec(rust);
  assert.ok(m, "the example is a raw string in local_profile.rs");
  const parsers = { steps: parseSteps, cards: parseCards, calc: parseCalc, plot: parsePlot, quiz: parseQuiz, chart: parseChart, timeline: parseTimeline, checklist: parseChecklist };
  const blocks = parseMarkdown(m[1]);
  const kinds = new Set();
  for (const b of blocks) {
    if (b.kind === "code") assert.fail(`shown as code: ${b.lang}\n${b.code}`);
    if (b.kind === "callout") kinds.add("callout");
    if (b.kind !== "rich") continue;
    assert.ok(parsers[b.type](b.title, b.body), `${b.type} ${b.title}`);
    kinds.add(b.type);
  }
  assert.deepEqual([...kinds].sort(), ["calc", "callout", "cards", "chart", "checklist", "plot", "quiz", "steps", "timeline"]);
});

test("what a local model wrote when only told the syntax is drawn all the same", () => {
  // A callout without its >, its text on the line or under it.
  const one = parseMarkdown("[!NOTE] Move the slider to see the area change.");
  assert.equal(one[0].kind, "callout"); assert.equal(one[0].type, "note"); assert.equal(one[0].body, "Move the slider to see the area change.");
  const two = parseMarkdown("[!NOTE]\nThese blocks combine.\nAsk for more.\n\nAfter.");
  assert.equal(two[0].kind, "callout"); assert.equal(two[0].body, "These blocks combine.\nAsk for more."); assert.equal(two[1].kind, "paragraph");
  // A chart row as label: name | values, and a stray label line per series.
  const sales = parseChart("Sales", "unit: €\nseries: 2024, 2025\nlabel: Q1 | 1200, 1450\nlabel: Q2 | 1350, 1600\nlabel: Q3 | 1100, 1280");
  assert.deepEqual(sales.labels, ["Q1", "Q2", "Q3"]); assert.deepEqual(sales.series[1].values, [1450, 1600, 1280]);
  const months = parseChart("", "series: A, B\nlabel: Value for A\nlabel: Value for B\nGen: 20, 15\nFeb: 25, 18\nMar: 30, 22");
  assert.deepEqual(months.labels, ["Gen", "Feb", "Mar"]); assert.deepEqual(months.series.map((s) => s.name), ["A", "B"]);
  // A calculator a field a line.
  const calc = parseCalc("Area", "formula: A = π * r^2\ninputs: |\nsymbol: r\nname: Raggio\nmin: 1\nmax: 100\nvalue: 5\nunit: cm\noutputs: |\nsymbol: A\nname: Area\nexpression: pi*r**2\nunit: cm²");
  assert.ok(calc);
  assert.deepEqual([calc.inputs[0].name, calc.inputs[0].label, calc.inputs[0].min, calc.inputs[0].max, calc.inputs[0].value, calc.inputs[0].unit], ["r", "Raggio", 1, 100, 5, "cm"]);
  assert.deepEqual([calc.outputs[0].name, calc.outputs[0].label, calc.outputs[0].unit], ["A", "Area", "cm²"]);
  // Two answers marked right: either counts.
  const quiz = parseQuiz("Geometry", "? The area of a square?\n- L * 4\n+ L * L\n- L + L\n+ L ** 2\n= Square");
  assert.ok(quiz); assert.deepEqual(quiz.questions[0].rights, [1, 3]);
});

test("the forgiving readings leave what read right before as it was", () => {
  // A loose callout ends where another block starts: a task list stays a checklist, a heading a heading.
  assert.deepEqual(parseMarkdown("[!TIP] Before you start:\n- [ ] Install Node").map((b) => b.kind), ["callout", "checklist"]);
  assert.equal(checklistsIn("[!TIP] Before you start:\n- [ ] Install Node").length, 1);
  assert.deepEqual(parseMarkdown("[!WARNING] Back up first.\n## Next\nText").map((b) => b.kind), ["callout", "heading", "paragraph"]);
  assert.equal(parseMarkdown("**[!NOTE] Remember this**")[0].body, "Remember this");
  assert.deepEqual(parseMarkdown("[!TIP]\n- [ ] x").map((b) => b.kind), ["paragraph", "checklist"], "no text: no callout");
  // A series called X, a bar called X, labels that are years.
  assert.deepEqual(parseChart("", "x: Q1, Q2, Q3\nFacebook: 10, 20, 30\nX: 5, 6, 7").series.map((s) => s.name), ["Facebook", "X"]);
  assert.deepEqual(parseChart("", "Chrome: 65%\nSafari: 18%\nX: 2%").labels, ["Chrome", "Safari", "X"]);
  assert.deepEqual(parseChart("", "label: 2021 | 2022 | 2023\nNorth: 1 | 2 | 3\nSouth: 4 | 5 | 6").labels, ["2021", "2022", "2023"]);
  assert.deepEqual(parseChart("", "x: 2023,2024\nNorth: 5, 7\nSouth: 3, 4").labels, ["2023", "2024"]);
  assert.deepEqual(parseChart("", "labels: Q1 | Q2 | Q3\nvalue: 10 | 20 | 30").series[0].values, [10, 20, 30]);
  // A stray symbol: line beside one-line inputs is no field.
  assert.ok(parseCalc("Ohm", "input: V | voltage | 0..24 | 12 | V\ninput: I | current | 0.1..5 | 1 | A\noutput: R | resistance | V / I | Ω\nsymbol: Ω = ohm"));
});
