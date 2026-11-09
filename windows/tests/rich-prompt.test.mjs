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
const { parseCalc, parsePlot } = await import(`${W}/views/rich/calc.ts`);
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
