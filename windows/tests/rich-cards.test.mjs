// The ```lumo-cards block (src/views/rich/cards.ts): cards side by side, read
// forgivingly from what a model writes, their icon colours checked strictly,
// the row's scroll kept across the chat's redraws.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { parseCards, parseIcon, cardColor, renderCards } = await import("../src/views/rich/cards.ts");
const { renderMarkdown } = await import("../src/views/markdown.ts");

/** What markdown.ts hands over, in plain text: enough to see what went where. */
const ctx = {
  markdown: (into, text) => into.append(text),
  inline: (into, text) => into.append(text),
  math: (tex) => document.createTextNode(tex),
  copyButton: () => document.createElement("button"),
};

const PLANETS = [
  "## Mercury",
  "sub: Closest to the Sun",
  "icon: planet #c9c2b8",
  "- Distance: 58 million km",
  "- Day: 176 Earth days",
  "Hot by day, **430 °C**.",
  "## Saturn",
  "Subtitle: The ringed one",
  "Icon: planet amber ring",
  "* Moons: 146",
  "**Day:** 10.7 hours",
].join("\n");

// ── Reading the block ─────────────────────────────────────────────────────────

test("each heading starts a card, with its subtitle, icon, rows and text", () => {
  assert.deepEqual(parseCards(" Planets ", PLANETS), {
    title: "Planets",
    cards: [
      {
        title: "Mercury",
        sub: "Closest to the Sun",
        icon: { kind: "planet", color: "#c9c2b8", ring: false },
        fields: [
          ["Distance", "58 million km"],
          ["Day", "176 Earth days"],
        ],
        text: ["Hot by day, **430 °C**."],
      },
      {
        title: "Saturn",
        sub: "The ringed one",
        icon: { kind: "planet", color: "var(--amber)", ring: true },
        fields: [
          ["Moons", "146"],
          ["Day", "10.7 hours"],
        ],
        text: [],
      },
    ],
  });
});

test("two to eight cards, or the block stays code", () => {
  const block = (n) => Array.from({ length: n }, (_, i) => `## Card ${i + 1}\n- Value: ${i}`).join("\n");
  assert.equal(parseCards("", block(1)), null);
  assert.equal(parseCards("", block(9)), null);
  assert.equal(parseCards("", "just some text\n- a: b"), null);
  assert.equal(parseCards("", ""), null);
  assert.equal(parseCards("", block(2)).cards.length, 2);
  assert.equal(parseCards("", block(8)).cards.length, 8);
  // An empty heading with nothing under it is not a card.
  assert.equal(parseCards("", `${block(1)}\n##\n`), null);
});

test("what models write a little wrong still reads", () => {
  const cards = parseCards(
    "",
    [
      "Intro line before any card",
      "### **Inverting**",
      "**Sub:** Opposite phase",
      "- **Gain**: $-\\frac{R_2}{R_1}$",
      "- Time: 10:30",
      "- Moons:",
      "- just a point",
      "Note: a sentence with a colon stays text.",
      "",
      "# Follower ##",
      "- icon: 1 green",
      "+ Gain: 1",
    ].join("\r\n"),
  );
  assert.deepEqual(cards.cards[0], {
    title: "Inverting",
    sub: "Opposite phase",
    icon: null,
    fields: [
      ["Gain", "$-\\frac{R_2}{R_1}$"],
      ["Time", "10:30"],
      ["Moons", ""],
    ],
    text: ["• just a point", "Note: a sentence with a colon stays text."],
  });
  assert.deepEqual(cards.cards[1], {
    title: "Follower",
    sub: "",
    icon: { kind: "glyph", text: "1", color: "var(--green-2)" },
    fields: [["Gain", "1"]],
    text: [],
  });
});

test("a heading's own hashes are part of its title, closing ones are not", () => {
  const cards = parseCards("", "## C#\n## F# ##\n##\n- a: b");
  assert.deepEqual(
    cards.cards.map((c) => c.title),
    ["C#", "F#", ""],
  );
});

test("a link or a long sentence in a bullet is not a row", () => {
  const cards = parseCards("", "## A\n- https://example.com/x\n- [Docs](https://a.b): read them\n## B");
  assert.deepEqual(cards.cards[0].fields, []);
  assert.equal(cards.cards[0].text.length, 2);
});

test("icons: a character or two, an emoji, or a planet", () => {
  assert.deepEqual(parseIcon("A"), { kind: "glyph", text: "A", color: "#8fc7ff" });
  assert.deepEqual(parseIcon("Hg #F5A524"), { kind: "glyph", text: "Hg", color: "#f5a524" });
  assert.deepEqual(parseIcon("#fff +"), { kind: "glyph", text: "+", color: "#fff" });
  assert.deepEqual(parseIcon("🪐"), { kind: "glyph", text: "🪐", color: "#8fc7ff" });
  // An emoji made of several code points is still one character.
  assert.deepEqual(parseIcon("👩‍🚀 pink"), { kind: "glyph", text: "👩‍🚀", color: "var(--pink)" });
  assert.deepEqual(parseIcon("planet"), { kind: "planet", color: "#c9c2b8", ring: false });
  assert.deepEqual(parseIcon("Planet ring #8fd0ff"), { kind: "planet", color: "#8fd0ff", ring: true });
  assert.equal(parseIcon("rocket"), null);
  assert.equal(parseIcon(""), null);
});

test("a colour is a palette name or a #hex, nothing else reaches a style", () => {
  assert.equal(cardColor("#abc"), "#abc");
  assert.equal(cardColor("#A1B2C3"), "#a1b2c3");
  assert.equal(cardColor("Gray"), "var(--dim)");
  for (const bad of ["#abcd", "#ggg", "red;background:url(x)", "var(--x)", "rgb(1,2,3)", "url(https://x)", "constructor", "toString"]) {
    assert.equal(cardColor(bad), null, bad);
  }
  // An unknown colour leaves the default in place.
  assert.deepEqual(parseIcon("planet red;x:y"), { kind: "planet", color: "#c9c2b8", ring: false });
});

// ── The card ──────────────────────────────────────────────────────────────────

test("the card: its kind, title, count, and a card per heading", () => {
  const el = renderCards(parseCards("Rocky planets", PLANETS), ctx, "k-render");
  assert.ok(el.classList.contains("rc-card") && el.classList.contains("rc-cards"));
  assert.equal(el.querySelector(".rc-kind").textContent, "Comparison");
  assert.equal(el.querySelector(".rc-title").textContent, "Rocky planets");
  assert.equal(el.querySelector(".rc-cards-count").textContent, "2 cards");
  const minis = el.find(".rc-mini");
  assert.equal(minis.length, 2);
  assert.equal(minis[0].querySelector(".rc-mini-title").textContent, "Mercury");
  assert.equal(minis[0].querySelector(".rc-mini-sub").textContent, "Closest to the Sun");
  assert.deepEqual(
    minis[0].find(".rc-field").map((f) => [f.querySelector(".rc-field-key").textContent, f.querySelector(".rc-field-val").textContent]),
    [
      ["Distance", "58 million km"],
      ["Day", "176 Earth days"],
    ],
  );
  assert.equal(minis[0].querySelector(".rc-mini-text").textContent, "Hot by day, **430 °C**.");
  const planet = minis[1].querySelector(".rc-planet");
  assert.ok(planet.classList.contains("ring"));
  assert.equal(planet.style["--c"], "var(--amber)");
  // No subtitle, no icon: nothing empty left behind.
  const bare = renderCards(parseCards("", "## A\n## B"), ctx, "k-bare");
  assert.equal(bare.querySelector(".rc-mini-sub"), null);
  assert.equal(bare.querySelector(".rc-mono"), null);
  assert.equal(bare.querySelector(".rc-mini-text"), null);
});

test("a glyph icon is text, and an emoji gets its own look", () => {
  const el = renderCards(parseCards("", "## A\nicon: − #34d399\n## B\nicon: 🌍"), ctx, "k-glyph");
  const [minus, earth] = el.find(".rc-mono");
  assert.equal(minus.textContent, "−");
  assert.equal(minus.style["--c"], "#34d399");
  assert.ok(!minus.classList.contains("emoji"));
  assert.ok(earth.classList.contains("emoji"));
});

test("the edge buttons are real buttons that scroll by one card", () => {
  const el = renderCards(parseCards("", PLANETS), ctx, "k-buttons");
  const buttons = el.find("BUTTON");
  assert.equal(buttons.length, 2);
  assert.deepEqual(
    buttons.map((b) => b.getAttribute("aria-label")),
    ["Previous card", "Next card"],
  );
  const row = el.querySelector(".rc-cards-row");
  const moves = [];
  row.scrollBy = (o) => moves.push(o);
  row.children[0].offsetWidth = 180;
  buttons[1].fire("click");
  buttons[0].fire("click");
  assert.deepEqual(moves, [
    { left: 188, behavior: "smooth" },
    { left: -188, behavior: "smooth" },
  ]);
});

/** A row laid out `width` wide with `content` worth of cards, scrolled to `left`. */
function layout(row, width, content, left) {
  row.clientWidth = width;
  row.scrollWidth = content;
  row.scrollLeft = left;
}

test("the scroll shows the fades and buttons it calls for, and is remembered", () => {
  const block = parseCards("", PLANETS);
  const first = renderCards(block, ctx, "k-scroll");
  const row = first.querySelector(".rc-cards-row");
  const clip = first.querySelector(".rc-cards-clip");

  layout(row, 400, 400, 0);
  row.fire("scroll");
  assert.ok(!first.classList.contains("more"), "everything fits");

  layout(row, 400, 800, 0);
  row.fire("scroll");
  assert.ok(first.classList.contains("more"));
  assert.ok(clip.classList.contains("at-start") && !clip.classList.contains("at-end"));

  row.scrollLeft = 400;
  row.fire("scroll");
  assert.ok(!clip.classList.contains("at-start") && clip.classList.contains("at-end"));

  row.scrollLeft = 150;
  row.fire("scroll");
  assert.ok(!clip.classList.contains("at-start") && !clip.classList.contains("at-end"));

  // The chat redraws: the new row goes back to where the old one was.
  const again = renderCards(block, ctx, "k-scroll");
  const row2 = again.querySelector(".rc-cards-row");
  layout(row2, 400, 800, 0);
  row2.fire("scroll");
  assert.equal(row2.scrollLeft, 150);
});

test("the wheel moves the row sideways only while it can go that way", () => {
  const el = renderCards(parseCards("", PLANETS), ctx, "k-wheel");
  const row = el.querySelector(".rc-cards-row");
  const moves = [];
  row.scrollBy = (o) => moves.push(o);
  const wheel = (deltaY, extra = {}) => row.fire("wheel", { deltaY, deltaX: 0, deltaMode: 0, target: row, ...extra });

  layout(row, 400, 400, 0);
  assert.ok(!wheel(100).defaultPrevented, "nothing to scroll: the chat scrolls");

  layout(row, 400, 800, 0);
  assert.ok(!wheel(-100).defaultPrevented, "at the start, up scrolls the chat");
  assert.ok(wheel(100).defaultPrevented);
  assert.deepEqual(moves, [{ left: 100, behavior: "smooth" }]);
  assert.ok(wheel(10).defaultPrevented);
  assert.equal(row.scrollLeft, 10, "a touchpad's fine steps go straight");

  row.scrollLeft = 400;
  assert.ok(!wheel(100).defaultPrevented, "at the end, down scrolls the chat");
  assert.ok(!wheel(-100, { ctrlKey: true }).defaultPrevented, "Ctrl zooms");
  assert.ok(!wheel(-5, { deltaX: 40 }).defaultPrevented, "a sideways swipe is the webview's");
});

test("in an answer, a lumo-cards block becomes the card, a broken one stays code", () => {
  const into = document.createElement("div");
  renderMarkdown(into, "Two of them:\n\n```lumo-cards Rocky planets\n" + PLANETS + "\n```\n");
  assert.ok(into.querySelector(".rc-cards"));
  assert.equal(into.find(".rc-mini").length, 2);

  const broken = document.createElement("div");
  renderMarkdown(broken, "```lumo-cards Alone\n## Only one\n- a: b\n```\n");
  assert.equal(broken.querySelector(".rc-cards"), null);
  assert.match(broken.textContent, /Only one/);
});
