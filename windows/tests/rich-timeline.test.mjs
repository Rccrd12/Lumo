// The ```lumo-timeline card (src/views/rich/timeline.ts): how a block's dates
// are read (years, months, days, eras, ranges, days without their year), how
// events open and step, and how a plan reads against today.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

const dom = installFakeDom();
const { parseTimeline, renderTimeline, dateText } = await import("../src/views/rich/timeline.ts");
const { renderMarkdown } = await import("../src/views/markdown.ts");
const { setLanguage } = await import("../src/i18n/i18n.ts");

/** 9 November 2026, a Monday: the PC's today in these tests. */
const NOW = new Date(2026, 10, 9, 15, 30);

const ctx = {
  markdown: (into, text) => into.replaceChildren(text),
  inline: (into, text) => into.append(text),
  math: () => document.createElement("span"),
  copyButton: () => document.createElement("button"),
};

const CHIPS = [
  "1947 Transistor",
  "  Bardeen, Brattain and Shockley at Bell Labs.",
  "1958 Integrated circuit",
  "  Kilby puts several components on one piece of germanium.",
  "1965 Moore's law",
  "1971 Intel 4004 — The first microprocessor on a single chip: **2300 transistors**.",
  "1978 Intel 8086: x86 is born.",
  "1985 ARM1",
].join("\n");

const PLAN = ["1/11–7/11 Limits", "8/11–16/11 Multiple integrals", "17/11–26/11 Differential equations", "27/11–6/12 Exam exercises", "9/12 ◆ Exam"].join("\n");

const iso = (w) => `${w.year}-${String(w.month + 1).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;

// ── Reading ───────────────────────────────────────────────────────────────────

test("events: a year, a name, and a detail after a dash, a colon or on the lines under it", () => {
  const tl = parseTimeline(" From the transistor to the microprocessor ", CHIPS, NOW);
  assert.equal(tl.title, "From the transistor to the microprocessor");
  assert.equal(tl.kind, "events");
  assert.deepEqual(
    tl.items.map((i) => [i.from.unit, i.from.year, i.label, i.detail]),
    [
      ["year", 1947, "Transistor", "Bardeen, Brattain and Shockley at Bell Labs."],
      ["year", 1958, "Integrated circuit", "Kilby puts several components on one piece of germanium."],
      ["year", 1965, "Moore's law", ""],
      ["year", 1971, "Intel 4004", "The first microprocessor on a single chip: **2300 transistors**."],
      ["year", 1978, "Intel 8086", "x86 is born."],
      ["year", 1985, "ARM1", ""],
    ],
  );
  assert.ok(tl.items.every((i) => i.to === null && !i.milestone));
});

test("forgiving: list markers, bold dates, a colon after the date, months, days, eras, any order", () => {
  const tl = parseTimeline(
    "",
    ["Some words before the first date are left out.", "- **1971-11** Intel 4004", "* 2026-11-08: Lumo 1.0", "500 BC Something", "-753 Rome", "1066 AD Hastings", "3. 1989 Berlin."].join("\n"),
    NOW,
  );
  assert.deepEqual(
    tl.items.map((i) => [i.from.unit, i.from.year, i.label]),
    [
      ["year", -753, "Rome"],
      ["year", -500, "Something"],
      ["year", 1066, "Hastings"],
      ["month", 1971, "Intel 4004"],
      ["year", 1989, "Berlin."],
      ["day", 2026, "Lumo 1.0"],
    ],
  );
  assert.equal(tl.items.find((i) => i.from.unit === "month").from.month, 10);
});

test("a number that runs into words is no date, and a line set in is a detail: both go with the date before", () => {
  const tl = parseTimeline("", "1947 Transistor\n3D printing came much later\n  2300 of them fit on a chip by 1971.\n1958 Integrated circuit", NOW);
  assert.equal(tl.items.length, 2);
  assert.equal(tl.items[0].detail, "3D printing came much later 2300 of them fit on a chip by 1971.");
});

test("a range anywhere makes a plan; its single dates are deadlines", () => {
  const tl = parseTimeline("Calculus 2", PLAN, NOW);
  assert.equal(tl.kind, "plan");
  assert.deepEqual(
    tl.items.map((i) => [iso(i.from), i.to && iso(i.to), i.label, i.milestone]),
    [
      ["2026-11-01", "2026-11-07", "Limits", false],
      ["2026-11-08", "2026-11-16", "Multiple integrals", false],
      ["2026-11-17", "2026-11-26", "Differential equations", false],
      ["2026-11-27", "2026-12-06", "Exam exercises", false],
      ["2026-12-09", null, "Exam", true],
    ],
  );
});

test("ranges written several ways, short ends included", () => {
  const cases = {
    "2026-11-08..2026-11-16 A": ["2026-11-08", "2026-11-16"],
    "2026-11-08 – 2026-11-16 A": ["2026-11-08", "2026-11-16"],
    "2026-11-08 - 2026-11-16 A": ["2026-11-08", "2026-11-16"],
    "2026-11-08→2026-11-16 A": ["2026-11-08", "2026-11-16"],
    "8/11/2026-16/11/2026 A": ["2026-11-08", "2026-11-16"],
    "8–16/11 A": ["2026-11-08", "2026-11-16"],
    "2026-11-08..16 A": ["2026-11-08", "2026-11-16"],
    "1939-1945 A": ["1939-01-01", "1945-01-01"],
    "1939–45 A": ["1939-01-01", "1945-01-01"],
  };
  for (const [line, [from, to]] of Object.entries(cases)) {
    const tl = parseTimeline("", `${line}\n2026-12-25 B`, NOW);
    assert.ok(tl, line);
    const a = tl.items.find((i) => i.label === "A");
    assert.deepEqual([iso(a.from), iso(a.to)], [from, to], line);
  }
});

test("a day without its year is the nearest to today, then to the date before it", () => {
  // Across New Year: 20/12 is this December, 10/1 the January after it.
  const tl = parseTimeline("", "20/12–31/12 Revise\n1/1–10/1 Practice\n12/1 Exam", NOW);
  assert.deepEqual(tl.items.map((i) => iso(i.from)), ["2026-12-20", "2027-01-01", "2027-01-12"]);
  // A date long before today stays in its own year, the one nearest.
  const back = parseTimeline("", "3/3 A\n4/3 B", NOW);
  assert.deepEqual(back.items.map((i) => iso(i.from)), ["2027-03-03", "2027-04-03"]);
});

test("day and month order: settled by a number over 12, else by the language", () => {
  assert.equal(iso(parseTimeline("", "11/20 A\n11/25 B", NOW).items[0].from), "2026-11-20");
  assert.equal(iso(parseTimeline("", "20/11 A\n25/11 B", NOW).items[0].from), "2026-11-20");
  assert.equal(iso(parseTimeline("", "3/4 A\n5/4 B", NOW).items[0].from), "2027-03-04");
  setLanguage("it");
  try {
    assert.equal(iso(parseTimeline("", "3/4 A\n5/4 B", NOW).items[0].from), "2027-04-03");
  } finally {
    setLanguage("en");
  }
});

test("not a timeline: fewer than two dates, more than twenty, impossible dates", () => {
  assert.equal(parseTimeline("", "", NOW), null);
  assert.equal(parseTimeline("", "1947 Transistor", NOW), null);
  assert.equal(parseTimeline("", "Just some words\nand more words", NOW), null);
  assert.equal(parseTimeline("", "2026-02-30 A\n2026-13-01 B", NOW), null);
  const many = Array.from({ length: 21 }, (_, i) => `${1900 + i} Year ${i}`).join("\n");
  assert.equal(parseTimeline("", many, NOW), null);
  assert.equal(parseTimeline("", many.split("\n").slice(0, 20).join("\n"), NOW).items.length, 20);
});

test("dates as the card shows them", () => {
  const [a, b, c] = parseTimeline("", "1947 A\n1971-11 B\n2026-11-08 C\n500 BC D", NOW).items.slice(1);
  assert.equal(dateText(a.from), "1947");
  assert.equal(dateText(b.from), "Nov 1971");
  assert.equal(dateText(c.from, false), "Nov 8");
  assert.equal(dateText(parseTimeline("", "500 BC A\n1 AD B", NOW).items[0].from), "500 BC");
});

// ── Events ────────────────────────────────────────────────────────────────────

test("events: points spaced by their dates, above and below in turn, the range in the top line", () => {
  const card = renderTimeline(parseTimeline("Chips", CHIPS, NOW), ctx, "ev-1", NOW);
  assert.ok(card.classList.contains("rc-tl"));
  assert.equal(card.querySelector(".rc-count").textContent, "1945 – 1988");
  const points = card.find(".rc-tl-ev");
  assert.equal(points.length, 6);
  assert.deepEqual(points.map((p) => p.className.split(" ")[1]), ["up", "down", "up", "down", "up", "down"]);
  // Named for screen readers; no tooltip over the line, the panel below says it.
  assert.ok(points.every((p) => p.tagName === "BUTTON" && p.getAttribute("aria-label") && !p.getAttribute("title")));
  // 1947 sits 2 years into the 43 the line shows.
  assert.match(points[0].getAttribute("style"), /^left:calc\(22px \+ 0\.046\d* \* \(100% - 32px\)\)$/);
  const detail = card.querySelector(".rc-tl-detail");
  assert.ok(detail.classList.contains("hint"));
  assert.equal(detail.children[0].textContent, "Click a point to read what happened · ← → to move");
  assert.ok(detail.children.slice(1).every((el) => el.hidden));
});

test("a click opens a point's detail; the buttons step, and a second click closes it", () => {
  const tl = parseTimeline("Chips", CHIPS, NOW);
  const card = renderTimeline(tl, ctx, "ev-2", NOW);
  const points = card.find(".rc-tl-ev");
  points[3].fire("click");
  assert.ok(points[3].classList.contains("sel"));
  assert.ok(points[0].classList.contains("dim") && !points[3].classList.contains("dim"));
  const detail = card.querySelector(".rc-tl-detail");
  assert.ok(!detail.classList.contains("hint"));
  assert.equal(detail.querySelector(".rc-tl-year").textContent, "1971");
  assert.equal(detail.querySelector(".rc-tl-text").textContent, "Intel 4004 The first microprocessor on a single chip: **2300 transistors**.");
  const [prev, next] = detail.find(".rc-nav");
  assert.equal(prev.getAttribute("title"), "Previous event");
  next.fire("click");
  next.fire("click");
  assert.ok(points[5].classList.contains("sel"));
  assert.equal(next.disabled, true);
  points[5].fire("click");
  assert.ok(card.querySelector(".rc-tl-detail").classList.contains("hint"));
  assert.ok(points.every((p) => !p.classList.contains("dim")));
});

test("the arrow keys, Home, End and Escape move through the events", () => {
  const card = renderTimeline(parseTimeline("Chips", CHIPS, NOW), ctx, "ev-3", NOW);
  const points = card.find(".rc-tl-ev");
  const key = (k) => card.fire("keydown", { key: k });
  const sel = () => points.findIndex((p) => p.classList.contains("sel"));
  key("ArrowRight");
  assert.equal(sel(), 0);
  key("ArrowRight");
  assert.equal(sel(), 1);
  key("End");
  assert.equal(sel(), 5);
  key("ArrowRight");
  assert.equal(sel(), 5);
  key("Home");
  assert.equal(sel(), 0);
  key("Escape");
  assert.equal(sel(), -1);
  key("ArrowLeft");
  assert.equal(sel(), 5);
  assert.equal(card.fire("keydown", { key: "ArrowLeft", ctrlKey: true }).defaultPrevented, false);
});

test("only one point is in the tab order: the open one, or the first", () => {
  const card = renderTimeline(parseTimeline("Chips", CHIPS, NOW), ctx, "ev-tab", NOW);
  const points = card.find(".rc-tl-ev");
  assert.deepEqual(points.map((p) => p.tabIndex), [0, -1, -1, -1, -1, -1]);
  points[3].fire("click");
  assert.deepEqual(points.map((p) => p.tabIndex), [-1, -1, -1, 0, -1, -1]);
  card.fire("keydown", { key: "Escape" });
  assert.equal(points[0].tabIndex, 0);
});

test("the open event survives the chat's redraws", () => {
  const tl = parseTimeline("Chips", CHIPS, NOW);
  renderTimeline(tl, ctx, "ev-4", NOW).find(".rc-tl-ev")[2].fire("click");
  const again = renderTimeline(tl, ctx, "ev-4", NOW);
  assert.ok(again.find(".rc-tl-ev")[2].classList.contains("sel"));
  assert.equal(again.querySelector(".rc-tl-year").textContent, "1965");
});

test("events in one year show their days without it; across years, with it", () => {
  const one = renderTimeline(parseTimeline("", "2026-11-08 A\n2026-11-16 B", NOW), ctx, "ev-5", NOW);
  assert.deepEqual(one.find(".rc-tl-lab").map((l) => l.childNodes[0].textContent), ["Nov 8", "Nov 16"]);
  assert.equal(one.querySelector(".rc-count").textContent, "Nov 8 – Nov 16");
  const two = renderTimeline(parseTimeline("", "2025-11-08 A\n2026-11-16 B", NOW), ctx, "ev-6", NOW);
  assert.equal(two.find(".rc-tl-lab")[0].childNodes[0].textContent, "Nov 8, 2025");
});

// ── Plan ──────────────────────────────────────────────────────────────────────

test("a plan reads against today: done, current, to do, today's line and the days left", () => {
  const card = renderTimeline(parseTimeline("Calculus 2", PLAN, NOW), ctx, "plan-1", NOW);
  assert.equal(card.querySelector(".rc-count").textContent, "phase 2 of 4 · 30 days left");
  const bars = card.find(".rc-tl-bar");
  assert.deepEqual(bars.map((b) => b.className), ["rc-tl-bar done", "rc-tl-bar cur", "rc-tl-bar todo", "rc-tl-bar todo"]);
  assert.equal(bars[0].find("svg").length, 1);
  assert.deepEqual(bars.map((b) => b.getAttribute("style").match(/top:(\d+)px/)[1]), ["22", "44", "66", "88"]);
  assert.equal(card.querySelector(".rc-tl-plan").getAttribute("style"), "height:118px");
  assert.deepEqual(card.find(".rc-tl-tick").map((t) => t.textContent), ["Nov 1", "Nov 8", "Nov 15", "Nov 22", "Nov 29", "Dec 6"]);
  const mile = card.querySelector(".rc-tl-mile");
  assert.equal(mile.textContent, "Exam");
  assert.match(mile.getAttribute("style"), /top:22px$/);
  // Today is the 9th day of 40: its line sits in the middle of it.
  assert.match(card.querySelector(".rc-tl-today").getAttribute("style"), /^left:calc\(12px \+ 0\.2125 \* \(100% - 12px\)\)$/);
  assert.equal(card.querySelector(".rc-tl-today").textContent, "today");
});

test("a deadline's name goes to the side with room for it, and never past the card's edge", () => {
  // 1 December is two fifths into the plan: too little room on the left for this name.
  const body = "2026-11-01..2026-11-20 A\n2026-11-21..2026-12-20 B\n2026-12-21..2027-01-15 C\n2026-12-01 ◆ Interim delivery with a long name";
  const card = renderTimeline(parseTimeline("", body, NOW), ctx, "plan-side", NOW);
  const mile = card.querySelector(".rc-tl-mile");
  assert.equal(mile.className, "rc-tl-mile right");
  assert.match(mile.getAttribute("style"), /^left:calc\(calc\(12px \+ [\d.]+ \* \(100% - 24px\)\) - 6px\);max-width:calc\(100% - \(.+\) - 4px\);top:\d+px$/);
  // A short one there still goes left.
  const short = renderTimeline(parseTimeline("", body.replace("Interim delivery with a long name", "Demo"), NOW), ctx, "plan-side2", NOW);
  assert.equal(short.querySelector(".rc-tl-mile").className, "rc-tl-mile");
});

test("a plan before it starts, after it ends, or in years has no today", () => {
  const before = renderTimeline(parseTimeline("", "2027-03-01..2027-03-10 A\n2027-03-11..2027-03-20 B", NOW), ctx, "plan-2", NOW);
  assert.equal(before.querySelector(".rc-tl-today"), null);
  assert.equal(before.querySelector(".rc-count").textContent, "Mar 1 – Mar 20");
  assert.ok(before.find(".rc-tl-bar").every((b) => b.classList.contains("todo")));
  const history = renderTimeline(parseTimeline("Rome", "509 BC–27 BC Republic\n27 BC–476 Empire\n44 BC ◆ Caesar dies", NOW), ctx, "plan-3", NOW);
  assert.equal(history.querySelector(".rc-count").textContent, "509 BC – 476");
  assert.equal(history.querySelector(".rc-tl-today"), null);
  assert.ok(history.find(".rc-tl-tick").some((t) => t.textContent.endsWith("BC")));
});

test("many phases share rows when they don't overlap", () => {
  const body = Array.from({ length: 8 }, (_, i) => `2026-11-${String(i * 3 + 1).padStart(2, "0")}..2026-11-${String(i * 3 + 2).padStart(2, "0")} P${i}`).join("\n");
  const card = renderTimeline(parseTimeline("", body, NOW), ctx, "plan-4", NOW);
  assert.ok(card.find(".rc-tl-bar").every((b) => /top:22px/.test(b.getAttribute("style"))));
});

// ── In an answer ──────────────────────────────────────────────────────────────

test("in an answer, a block becomes the card, and one it can't read stays code", () => {
  const root = dom.root();
  renderMarkdown(root, "Here:\n\n```lumo-timeline Chips\n" + CHIPS + "\n```\n", { scope: "tl" }); // fakedom throws on innerHTML
  const card = root.querySelector(".rc-tl");
  assert.ok(card);
  assert.equal(card.querySelector(".rc-title").textContent, "Chips");
  const bad = dom.root();
  renderMarkdown(bad, "```lumo-timeline Nothing\nno dates here\n```\n", { scope: "tl2" });
  assert.equal(bad.querySelector(".rc-tl"), null);
  assert.match(bad.textContent, /no dates here/);
});

test("model text never reaches a style: positions are numbers the card computed", () => {
  const card = renderTimeline(parseTimeline("x", '1947 a";color:red\n1958 b', NOW), ctx, "safe", NOW);
  for (const el of [card, ...card.walk()]) {
    const style = el.getAttribute?.("style");
    if (style) assert.match(style, /^(?:left|right|height):[\w.() %+*-]+(?:;[\w.() %+*:-]+)*$/);
  }
});

test("a year past what a date can count is no date: never NaN on the card", () => {
  const tl = parseTimeline("", "300000 BC Something\n1947 Transistor\n2000 Y2K", NOW);
  assert.deepEqual(tl.items.map((i) => i.label), ["Transistor", "Y2K"]);
  assert.ok(tl.items.every((i) => Number.isFinite(i.from.start) && Number.isFinite(i.from.end)));
});

test("two deadlines a day apart go on two rows, not one over the other", () => {
  const tl = parseTimeline("", "2026-11-01 – 2026-11-20 Build\n2026-11-21 – 2026-12-10 Test\n◆ 2026-11-14 Review one\n◆ 2026-11-15 Review two", NOW);
  const card = renderTimeline(tl, ctx, "deadline-rows", NOW);
  const tops = card.find(".rc-tl-mile").map((m) => /top:(\d+)px/.exec(m.getAttribute("style"))[1]);
  assert.equal(tops.length, 2);
  assert.notEqual(tops[0], tops[1]);
});
