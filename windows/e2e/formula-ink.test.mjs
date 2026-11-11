// The formulas of an answer drawn whole by the real WebView: no subscript,
// fraction or last letter cut by the box that holds it, in the chat, in the
// steps card (its step, the step before in small, its list) and on the
// calculator's top line. Each fix of a cut formula so far was found by eye
// after a release; this keeps them fixed.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before } from "node:test";

import { Lumo, OUT } from "./lib/app.mjs";
import { sleep } from "./lib/driver.mjs";
import { flow, step } from "./lib/flow.mjs";
import { cutBoxes } from "./lib/ink.mjs";

const G = "Formulas";
const app = new Lumo("formula-ink");
const d = app.d;

before(() => app.launch());
after(() => app.close());

// The formulas that were cut once (an italic V, W or f at the end, \underbrace,
// subscripts, fractions), and their kin.
const FORMULAS = [
  "U = qV = -eV",
  "\\int_0^1 f_{k}(x)\\,dx = W",
  "\\underbrace{a+b}_{n} + \\overbrace{c}^{m}",
  "\\frac{a_{i_j}}{b^{2^k}} = f",
  "x_{j}^{2} + y_{q}",
  "\\sqrt{\\frac{1}{y_g}} = \\mathcal{F}",
  "\\sum_{i=1}^{n} \\frac{1}{i^2} = Y",
  "\\left(\\frac{a}{b}\\right)^{2} = V",
  "e^{-x^2} + A^{T}_{j} = f",
  "\\int f\\,dW",
  "\\vec{v}_{\\perp} = \\hat{P}",
  "g_{\\mu\\nu}^{(k)} = \\mathbb{R}^{n}_{y}",
];

const ANSWER = [
  ...FORMULAS.map((f) => `$$${f}$$`),
  "```lumo-steps\n" + FORMULAS.map((f, i) => `## Step ${i + 1}\n$$${f}$$`).join("\n") + "\n```",
  ...FORMULAS.map((f) => "```lumo-calc\nformula: " + f + "\ninput: V | voltage | 0..24 | 12 | V\noutput: I | current | V / 2 | A\n```"),
].join("\n\n");

const CHAT = {
  id: "e2e-formula-ink",
  title: "Formulas",
  updatedAt: Date.now(),
  provider: "claude-code",
  session: null,
  turns: [
    { role: "user", content: "Formulas" },
    { role: "assistant", content: ANSWER },
  ],
};

const said = (cut) => cut.map((c) => `${c.sel} #${c.k} (${c.tex}): ${c.changed} px`).join("; ");

flow(G, "No box cuts a formula's ink: chat, steps card and calculator", app, async () => {
  await app.open();
  step("opens the chat from the home's field");
  await app.click(await d.visible(".home-field", 8_000, "the home's Ask me anything field"));
  await d.visible(".chat-input", 5_000, "the chat's field");

  step("an answer with 12 formulas, a steps card and 12 calculators, opened from the past chats");
  await d.js("localStorage.setItem('lumo.chats.v1', JSON.stringify([arguments[0]]))", CHAT);
  const tools = await d.all(".chat-tools .tool-btn");
  await app.click(tools[1]);
  await app.click(await d.visible(".history-row", 5_000, "the saved chat in the past chats"));
  await d.until(
    `return document.querySelectorAll('.chat-log .md-math-scroll').length >= ${FORMULAS.length}
      && document.querySelectorAll('.chat-log .rc-head-tex').length >= ${FORMULAS.length}
      && !!document.querySelector('.chat-log .rc-steps')`,
    10_000,
    "the answer's formulas and cards",
  );
  // The cursor off the answer, so nothing changes under it as it scrolls.
  await app.aim(await d.visible(".chat-input"));
  await sleep(500);

  const cut = [];
  let checked = 0;
  const check = async (what, selectors) => {
    const r = await cutBoxes(d, selectors);
    step(`${what}: ${r.checked} boxes, ${r.cut.length} cut${r.cut.length ? ` (${said(r.cut)})` : ""}`);
    checked += r.checked;
    // The two photos of a box that cuts, for the run's e2e artifact.
    for (const c of r.cut) {
      const base = join(OUT, "shots", `formula-cut-${cut.length + 1}-${c.sel.slice(1)}-${c.k}`);
      mkdirSync(join(OUT, "shots"), { recursive: true });
      writeFileSync(`${base}-as-shown.png`, c.pngs.shown);
      writeFileSync(`${base}-uncut.png`, c.pngs.uncut);
      cut.push(c);
    }
    return r.checked;
  };

  const first = await check("the chat's formulas, the first step, the calculators' top lines", undefined);
  assert.ok(first >= 2 * FORMULAS.length + 1, `every formula of the answer is on the page (${first} boxes)`);

  const segments = await d.all(".chat-log .rc-steps .rc-seg");
  assert.equal(segments.length, FORMULAS.length, "the steps card has a step for each formula");
  for (let i = 1; i < segments.length; i++) {
    await d.click(segments[i]);
    await sleep(250);
    await check(`step ${i + 1} and the one before`, [".rc-steps-formula", ".rc-steps-prev-tex"]);
  }

  const toggle = await d.all(".chat-log .rc-steps button[aria-pressed]");
  assert.equal(toggle.length, 1, "the steps card's All steps button");
  await d.click(toggle[0]);
  await d.until("return document.querySelectorAll('.chat-log .rc-steps-row-what').length > 0", 5_000, "the list of steps");
  await sleep(250);
  const rows = await check("the list of steps", [".rc-steps-row-what"]);
  assert.equal(rows, FORMULAS.length, "every step's formula shows in the list");

  step(`${checked} boxes checked`);
  assert.deepEqual(cut.map((c) => `${c.sel} #${c.k} (${c.tex})`), [], `formulas cut by their box: ${said(cut)}`);
});
