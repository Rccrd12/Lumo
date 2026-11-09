// The ```lumo-steps card (src/views/rich/steps.ts): how a block is read into
// steps, forgiving the ways models get it slightly wrong, and how the card
// steps, lists and remembers where it is across the chat's redraws.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

const dom = installFakeDom();
const { parseSteps, renderSteps, stepsMarkdown } = await import("../src/views/rich/steps.ts");
const { renderMarkdown } = await import("../src/views/markdown.ts");

const PARTS = [
  "## Product rule",
  "$$d(uv) = u\\,dv + v\\,du$$",
  "## Move v du to the other side",
  "$$u\\,dv = d(uv) - v\\,du$$",
  "Subtract $v\\,du$ from both sides.",
  "## Integrate",
  "$$\\int u\\,dv = uv - \\int v\\,du$$",
].join("\n");

// ── Reading ───────────────────────────────────────────────────────────────────

test("each heading is a step: its name, its first formula, the words under it", () => {
  assert.deepEqual(parseSteps(" Integration by parts ", PARTS), {
    title: "Integration by parts",
    steps: [
      { label: "Product rule", tex: "d(uv) = u\\,dv + v\\,du", text: "" },
      { label: "Move v du to the other side", tex: "u\\,dv = d(uv) - v\\,du", text: "Subtract $v\\,du$ from both sides." },
      { label: "Integrate", tex: "\\int u\\,dv = uv - \\int v\\,du", text: "" },
    ],
  });
});

test("what comes before the first heading is left out; steps in words are fine", () => {
  const steps = parseSteps("", "Here is how:\n\n## Preheat the oven\nTo **180 °C**.\n## Bake\n### Let it cool ###\n");
  assert.deepEqual(steps.steps, [
    { label: "Preheat the oven", tex: null, text: "To **180 °C**." },
    { label: "Bake", tex: null, text: "" },
    { label: "Let it cool", tex: null, text: "" },
  ]);
});

test("forgiving: numbers in the names, formulas over several lines, \\[…\\] and a lone $…$", () => {
  const body = [
    "## 1. Start",
    "$$",
    "a = b",
    "$$",
    "## Step 2: Square",
    "\\[a^2 = ab\\]",
    "##3) Subtract",
    "$a^2 - b^2 = ab - b^2$",
    "## 2.5 kg of flour",
    "Weigh it.",
  ].join("\n");
  const steps = parseSteps("Proof", body).steps;
  assert.deepEqual(steps.map((s) => s.label), ["Start", "Square", "Subtract", "2.5 kg of flour"]);
  assert.deepEqual(steps.map((s) => s.tex), ["a = b", "a^2 = ab", "a^2 - b^2 = ab - b^2", null]);
  assert.equal(steps[3].text, "Weigh it.");
});

test("no heading at all: a step per line, a formula line without a name", () => {
  const steps = parseSteps("Solve", "$$2x + 3 = 7$$\n\n- Subtract 3: $$2x = 4$$\n2. $$x = 2$$\nCheck it in the first line.").steps;
  assert.deepEqual(steps, [
    { label: "", tex: "2x + 3 = 7", text: "" },
    { label: "Subtract 3", tex: "2x = 4", text: "" },
    { label: "", tex: "x = 2", text: "" },
    { label: "", tex: null, text: "Check it in the first line." },
  ]);
  // A formula over several lines is one step.
  assert.deepEqual(parseSteps("", "$$\na\n= b\n$$\n$$c$$").steps.map((s) => s.tex), ["a\n= b", "c"]);
});

test("one step, none, or more than twenty is no walk-through: null, shown as code", () => {
  assert.equal(parseSteps("t", ""), null);
  assert.equal(parseSteps("t", "## Only\n$$x$$"), null);
  assert.equal(parseSteps("t", "just one line"), null);
  assert.equal(parseSteps("t", "##\n\n##\n"), null);
  const many = (n) => Array.from({ length: n }, (_, i) => `## S${i}\n$$x_${i}$$`).join("\n");
  assert.equal(parseSteps("t", many(20)).steps.length, 20);
  assert.equal(parseSteps("t", many(21)), null);
  assert.equal(parseSteps("t", "a\r\nb").steps.length, 2);
});

test("the copy is plain Markdown: numbered names, the TeX as written", () => {
  const text = stepsMarkdown(parseSteps("Integration by parts", PARTS));
  assert.equal(
    text,
    [
      "**Integration by parts**",
      "**1. Product rule**\n\n$$d(uv) = u\\,dv + v\\,du$$",
      "**2. Move v du to the other side**\n\n$$u\\,dv = d(uv) - v\\,du$$\n\nSubtract $v\\,du$ from both sides.",
      "**3. Integrate**\n\n$$\\int u\\,dv = uv - \\int v\\,du$$",
    ].join("\n\n"),
  );
  assert.equal(stepsMarkdown({ title: "", steps: [{ label: "", tex: "x", text: "" }] }), "**1.**\n\n$$x$$");
});

// ── The card ──────────────────────────────────────────────────────────────────

const fence = (title, body) => `Here it is:\n\n\`\`\`lumo-steps ${title}\n${body}\n\`\`\``;
const count = (card) => card.find(".rc-count")[0].textContent;
const navs = (card) => card.find(".rc-nav");

test("the card steps with its buttons, its bar and the arrow keys", () => {
  const root = dom.root();
  renderMarkdown(root, fence("Integration by parts walk", PARTS)); // fakedom throws on innerHTML
  const card = root.find(".rc-steps")[0];
  assert.ok(card);
  assert.equal(card.getAttribute("tabindex"), "0");
  assert.equal(card.find(".rc-title")[0].textContent, "Integration by parts walk");
  assert.equal(count(card), "1 / 3");
  const [prev, next, all] = navs(card);
  assert.equal(prev.tagName, "BUTTON");
  assert.equal(prev.disabled, true);
  assert.equal(next.disabled, false);
  assert.equal(prev.getAttribute("aria-label"), "Previous step");
  assert.equal(card.find(".md-copy").length, 1);
  // Step one: where it starts, its formula large, its number and name.
  assert.equal(card.find(".rc-steps-start").length, 1);
  assert.equal(card.find(".rc-steps-formula")[0].find("MATH").length, 1);
  assert.equal(card.find(".rc-steps-name")[0].textContent, "Product rule");
  const segs = card.find(".rc-seg");
  assert.equal(segs.length, 3);
  assert.equal(segs[0].className, "rc-seg cur");

  next.fire("click");
  assert.equal(count(card), "2 / 3");
  assert.equal(prev.disabled, false);
  // The step before, small above; the words under the formula.
  assert.equal(card.find(".rc-steps-start").length, 0);
  assert.equal(card.find(".rc-steps-prev")[0].find("MATH").length, 1);
  assert.match(card.find(".rc-steps-text")[0].textContent, /Subtract/);
  assert.deepEqual(segs.map((s) => s.className), ["rc-seg done", "rc-seg cur", "rc-seg"]);

  const key = card.fire("keydown", { key: "ArrowRight" });
  assert.equal(key.defaultPrevented, true);
  assert.equal(count(card), "3 / 3");
  assert.equal(next.disabled, true);
  card.fire("keydown", { key: "ArrowRight" });
  assert.equal(count(card), "3 / 3");
  assert.equal(card.fire("keydown", { key: "ArrowLeft", ctrlKey: true }).defaultPrevented, false);
  card.fire("keydown", { key: "Home" });
  assert.equal(count(card), "1 / 3");
  segs[2].fire("click");
  assert.equal(count(card), "3 / 3");
  assert.equal(all.getAttribute("aria-pressed"), "false");
});

test("the list shows every step; a row goes back to it", () => {
  const root = dom.root();
  renderMarkdown(root, fence("List", PARTS));
  const card = root.find(".rc-steps")[0];
  const all = navs(card)[2];
  all.fire("click");
  assert.equal(all.classList.contains("on"), true);
  assert.equal(card.find(".rc-steps-stage").length, 0);
  assert.equal(card.find(".rc-bar")[0].hidden, true);
  const rows = card.find(".rc-steps-row");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].tagName, "BUTTON");
  assert.equal(rows[0].className, "rc-steps-row cur");
  assert.deepEqual(rows.map((r) => r.find(".rc-steps-row-label")[0].textContent), ["Product rule", "Move v du to the other side", "Integrate"]);
  rows[1].fire("click");
  assert.equal(count(card), "2 / 3");
  assert.equal(card.find(".rc-steps-list").length, 0);
  assert.equal(card.find(".rc-steps-stage").length, 1);
  assert.equal(card.find(".rc-bar")[0].hidden, false);
});

test("the card keeps its step across the chat's redraws", () => {
  const body = "## A\n$$a$$\n## B\n$$b$$\n## C\n$$c$$";
  const root = dom.root();
  renderMarkdown(root, fence("Kept", body));
  navs(root.find(".rc-steps")[0])[1].fire("click");
  renderMarkdown(root, fence("Kept", body));
  assert.equal(count(root.find(".rc-steps")[0]), "2 / 3");
  // Another block starts at its first step.
  renderMarkdown(root, fence("Other", body));
  assert.equal(count(root.find(".rc-steps")[0]), "1 / 3");
});

test("a step that is only a name says it large, once; a block it can't read stays code", () => {
  const root = dom.root();
  renderMarkdown(root, fence("Recipe", "## Preheat\n## Bake"));
  const card = root.find(".rc-steps")[0];
  assert.equal(card.find(".rc-steps-text")[0].textContent, "Preheat");
  assert.equal(card.find(".rc-steps-name").length, 0);
  assert.equal(card.find(".rc-steps-prev")[0].textContent, "Where it starts");
  navs(card)[1].fire("click");
  assert.equal(card.find(".rc-steps-prev")[0].textContent, "Preheat");

  renderMarkdown(root, fence("Broken", "## Only one\n$$x$$"));
  assert.equal(root.find(".rc-steps").length, 0);
  assert.match(root.find("PRE")[0].textContent, /Only one/);
});

test("renderSteps on its own, with a context of its own", () => {
  const ctx = {
    markdown: (into, text) => into.replaceChildren(text),
    inline: (into, text) => into.append(text),
    math: (tex) => {
      const el = document.createElement("math");
      el.append(tex);
      return el;
    },
    copyButton: () => document.createElement("button"),
  };
  const card = renderSteps(parseSteps("", "$$x$$\n$$y$$"), ctx, "steps\u0000own");
  assert.equal(count(card), "1 / 2");
  assert.equal(card.find(".rc-title").length, 0);
  assert.equal(card.getAttribute("aria-label"), "Steps");
  assert.equal(card.find(".rc-steps-formula")[0].textContent, "x");
  // Steps with no name: the number alone under the formula.
  assert.equal(card.find(".rc-steps-label")[0].textContent, "1");
});
