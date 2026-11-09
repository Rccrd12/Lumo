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
/** The step the card shows: every step is built, one over the other, only this one visible. */
const shown = (card) => card.find(".rc-steps-stage").find((s) => s.classList.contains("on"));

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
  // The copy button sits right after the title, before the room that pushes the
  // buttons to the right: hidden at rest, it moves none of them, and it covers
  // nothing of the steps.
  assert.equal(card.find(".md-copy").length, 1);
  const top = card.find(".rc-head")[0].children.map((c) => c.className.split(" ")[0]);
  assert.deepEqual(top, ["rc-kind", "rc-title", "md-copy", "rc-sp", "rc-count", "rc-nav", "rc-nav", "rc-nav"]);
  assert.ok(card.find(".md-copy")[0].classList.contains("rc-steps-copy"));
  // Every step is laid out at once, so the card keeps the tallest one's height;
  // the hidden ones are out of reach.
  const stages = card.find(".rc-steps-stage");
  assert.equal(stages.length, 3);
  assert.deepEqual(stages.map((s) => s.getAttribute("aria-hidden")), [null, "true", "true"]);
  assert.deepEqual(stages.map((s) => s.inert), [false, true, true]);
  // Step one: where it starts, its formula large, its number and name.
  assert.equal(shown(card).find(".rc-steps-start").length, 1);
  assert.equal(shown(card).find(".rc-steps-formula")[0].find("MATH").length, 1);
  assert.equal(shown(card).find(".rc-steps-name")[0].textContent, "Product rule");
  const segs = card.find(".rc-seg");
  assert.equal(segs.length, 3);
  assert.equal(segs[0].className, "rc-seg cur");

  next.fire("click");
  assert.equal(count(card), "2 / 3");
  assert.equal(prev.disabled, false);
  // The step before, small above; the words under the formula. The same nodes, shown in turn.
  assert.equal(shown(card), stages[1]);
  assert.equal(card.find(".rc-steps-stage").length, 3);
  assert.equal(shown(card).find(".rc-steps-start").length, 0);
  assert.equal(shown(card).find(".rc-steps-prev")[0].find("MATH").length, 1);
  assert.match(shown(card).find(".rc-steps-text")[0].textContent, /Subtract/);
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
  // A formula's row says so: it is drawn a size up.
  assert.equal(rows[0].find(".rc-steps-row-what")[0].className, "rc-steps-row-what tex");
  rows[1].fire("click");
  assert.equal(count(card), "2 / 3");
  assert.equal(card.find(".rc-steps-list").length, 0);
  assert.equal(card.find(".rc-steps-stage").length, 3);
  assert.equal(shown(card).find(".rc-steps-name")[0].textContent, "Move v du to the other side");
  assert.equal(card.find(".rc-bar")[0].hidden, false);
});

test("in the list, the arrow keys keep the focus on the current row", () => {
  const root = dom.root();
  renderMarkdown(root, fence("Focus", PARTS));
  const card = root.find(".rc-steps")[0];
  navs(card)[2].fire("click");
  // A focus that, as in a page, falls back to nothing when its element leaves the card.
  let focused = null;
  const proto = Object.getPrototypeOf(card);
  const focus = proto.focus;
  proto.focus = function () {
    focused = this;
  };
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => (focused === card || [...card.walk()].includes(focused) ? focused : null),
  });
  try {
    focused = card.find(".rc-steps-row")[0];
    card.fire("keydown", { key: "ArrowRight" });
    assert.equal(count(card), "2 / 3");
    // The list was drawn anew: the focus is on the new current row, not lost.
    assert.equal(focused, card.find(".rc-steps-row")[1]);
    assert.equal(focused.className, "rc-steps-row cur");
    card.fire("keydown", { key: "End" });
    assert.equal(focused, card.find(".rc-steps-row")[2]);
    // From a row the focus is on, not the current one: the arrows go from that row,
    // up and down as well as left and right.
    focused = card.find(".rc-steps-row")[0];
    card.fire("keydown", { key: "ArrowRight" });
    assert.equal(count(card), "2 / 3");
    assert.equal(focused, card.find(".rc-steps-row")[1]);
    focused = card.find(".rc-steps-row")[2];
    card.fire("keydown", { key: "ArrowUp" });
    assert.equal(count(card), "2 / 3");
    // The step didn't change, but the focus comes back to its row.
    assert.equal(focused, card.find(".rc-steps-row")[1]);
    card.fire("keydown", { key: "ArrowDown" });
    assert.equal(count(card), "3 / 3");
    assert.equal(focused, card.find(".rc-steps-row")[2]);
    // A focus outside the steps stays where it is.
    const toggle = navs(card)[2];
    focused = toggle;
    card.fire("keydown", { key: "Home" });
    assert.equal(focused, toggle);
  } finally {
    proto.focus = focus;
    delete document.activeElement;
  }
});

test("up and down are left to the chat outside the list", () => {
  const root = dom.root();
  renderMarkdown(root, fence("Updown", PARTS));
  const card = root.find(".rc-steps")[0];
  assert.equal(card.fire("keydown", { key: "ArrowDown" }).defaultPrevented, false);
  assert.equal(count(card), "1 / 3");
});

test("a formula wider than the card fades at the edge it goes on past", () => {
  const root = dom.root();
  renderMarkdown(root, fence("Wide", PARTS));
  const card = root.find(".rc-steps")[0];
  const formula = card.find(".rc-steps-formula")[0];
  Object.assign(formula, { scrollWidth: 500, clientWidth: 200, scrollLeft: 0 });
  formula.fire("scroll");
  assert.equal(formula.className, "rc-steps-formula fade-end");
  formula.scrollLeft = 150;
  formula.fire("scroll");
  assert.ok(formula.classList.contains("fade-start") && formula.classList.contains("fade-end"));
  formula.scrollLeft = 300;
  formula.fire("scroll");
  assert.equal(formula.className, "rc-steps-formula fade-start");
  // One that fits doesn't fade.
  Object.assign(formula, { scrollWidth: 200, scrollLeft: 0 });
  formula.fire("scroll");
  assert.equal(formula.className, "rc-steps-formula");
  // The step before's formula, small above, is cut short the same way.
  const prev = card.find(".rc-steps-prev-tex")[0];
  Object.assign(prev, { scrollWidth: 400, clientWidth: 200, scrollLeft: 0 });
  prev.fire("scroll");
  assert.ok(prev.classList.contains("fade-end"));
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
  assert.equal(shown(card).find(".rc-steps-text")[0].textContent, "Preheat");
  assert.equal(card.find(".rc-steps-name").length, 0);
  assert.equal(shown(card).find(".rc-steps-prev")[0].textContent, "Where it starts");
  navs(card)[1].fire("click");
  assert.equal(shown(card).find(".rc-steps-prev")[0].textContent, "Preheat");

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
  assert.equal(shown(card).find(".rc-steps-formula")[0].textContent, "x");
  // Steps with no name: the number alone under the formula.
  assert.equal(shown(card).find(".rc-steps-label")[0].textContent, "1");
});
