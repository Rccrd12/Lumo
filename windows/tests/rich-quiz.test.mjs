// The ```lumo-quiz card (src/views/rich/quiz.ts): how a block is read into
// questions, forgiving the ways models get it slightly wrong, and how the card
// asks, marks, scores, asks the missed ones again and remembers where it is
// across the chat's redraws.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

const dom = installFakeDom();
const { parseQuiz } = await import("../src/views/rich/quiz.ts");
const { renderMarkdown } = await import("../src/views/markdown.ts");

const OPAMP = [
  "? An inverting amplifier has $R_1 = 1\\,\\text{k}\\Omega$",
  "  and $R_2 = 10\\,\\text{k}\\Omega$. What is its gain?",
  "- $+10$",
  "+ $-10$",
  "- $+11$",
  "- $-1/10$",
  "> In the inverting amplifier $G = -R_2/R_1$:",
  "> the minus says the output is inverted.",
  "",
  "? A buffer's gain?",
  "- $0$",
  "+ $1$",
  "- $-1$",
].join("\n");

// ── Reading ───────────────────────────────────────────────────────────────────

test("? a question, - wrong, + right, > why; indented lines go on", () => {
  assert.deepEqual(parseQuiz(" Op-amp ", OPAMP), {
    title: "Op-amp",
    questions: [
      {
        text: "An inverting amplifier has $R_1 = 1\\,\\text{k}\\Omega$ and $R_2 = 10\\,\\text{k}\\Omega$. What is its gain?",
        options: ["$+10$", "$-10$", "$+11$", "$-1/10$"],
        right: 1,
        why: "In the inverting amplifier $G = -R_2/R_1$: the minus says the output is inverted.",
        short: "",
      },
      { text: "A buffer's gain?", options: ["$0$", "$1$", "$-1$"], right: 1, why: "", short: "" },
    ],
  });
});

test("forgiving: no ?, numbers and letters written in, * for wrong, - [x] for right, CRLF", () => {
  const body = [
    "1. Which is a prime?",
    "- A) 4",
    "* B) 6",
    "+ C) 7",
    "Q2: Is the Earth flat?",
    "- [ ] Yes",
    "- [x] No",
    "  not at all",
    "> It is round,",
    "  roughly.",
  ].join("\r\n");
  const quiz = parseQuiz("", body);
  assert.deepEqual(quiz.questions, [
    { text: "Which is a prime?", options: ["4", "6", "7"], right: 2, why: "", short: "" },
    { text: "Is the Earth flat?", options: ["Yes", "No not at all"], right: 1, why: "It is round, roughly.", short: "" },
  ]);
  // A question that goes on, unindented, before its answers.
  assert.equal(parseQuiz("", "? What is\nthe gain?\n- 1\n+ 2").questions[0].text, "What is the gain?");
  // `? 1. …` loses its number too.
  assert.equal(parseQuiz("", "? 1. First?\n- a\n+ b").questions[0].text, "First?");
});

test("questions that can't be marked are left out; null when none is left or too many", () => {
  const good = "? Good?\n- a\n+ b";
  const quiz = parseQuiz("", [
    good,
    "? No right answer?\n- a\n- b",
    "? Two right answers?\n+ a\n+ b",
    "? One answer?\n+ a",
    "? Seven answers?\n+ 1\n- 2\n- 3\n- 4\n- 5\n- 6\n- 7",
    "? Six answers?\n+ 1\n- 2\n- 3\n- 4\n- 5\n- 6",
  ].join("\n\n"));
  assert.deepEqual(quiz.questions.map((q) => q.text), ["Good?", "Six answers?"]);
  assert.equal(parseQuiz("", ""), null);
  assert.equal(parseQuiz("", "Just some words.\nAnd more."), null);
  assert.equal(parseQuiz("", "? No right?\n- a\n- b"), null);
  assert.equal(parseQuiz("", Array.from({ length: 10 }, () => good).join("\n")).questions.length, 10);
  assert.equal(parseQuiz("", Array.from({ length: 11 }, () => good).join("\n")), null);
  // Answers before any question: the question is missing, so it can't be asked.
  assert.equal(parseQuiz("", "- a\n+ b"), null);
});

test("= names a question in the list of the missed ones", () => {
  const quiz = parseQuiz("", "? An inverting amplifier has these resistors. What is its gain?\n- $+10$\n+ $-10$\n> Because.\n= Inverting gain:\n  $-R_2/R_1$\n\n? Next?\n- a\n+ b");
  assert.equal(quiz.questions[0].short, "Inverting gain: $-R_2/R_1$");
  assert.equal(quiz.questions[0].why, "Because.");
  assert.equal(quiz.questions[1].short, "");
  // `=` with no space after it is part of the text it is in.
  assert.equal(parseQuiz("", "? x\n=y\n- a\n+ b").questions[0].text, "x =y");
});

// ── The card ──────────────────────────────────────────────────────────────────

const fence = (title, body) => `Here it is:\n\n\`\`\`lumo-quiz ${title}\n${body}\n\`\`\``;
const count = (card) => card.find(".rc-count")[0].textContent;
const shown = (card) => card.find(".rc-quiz-stage").find((s) => s.classList.contains("on"));
const options = (card) => shown(card).find(".rc-opt");
const bar = (card) => card.find(".rc-quiz-bar")[0].find("I").map((i) => i.className);
const nextButton = (card) => card.find(".rc-quiz-why")[0].find("BUTTON")[0];

test("a question at a time: a click marks it, the explanation and the next button come under it", () => {
  const root = dom.root();
  renderMarkdown(root, fence("Op-amp", OPAMP), { scope: "click" }); // fakedom throws on innerHTML
  const card = root.find(".rc-quiz")[0];
  assert.ok(card);
  assert.equal(card.getAttribute("tabindex"), "0");
  assert.equal(card.find(".rc-kind")[0].textContent, "Quiz");
  assert.equal(card.find(".rc-title")[0].textContent, "Op-amp");
  assert.equal(count(card), "1 / 2");
  // Every question laid out at once, one over the other; the hidden ones out of reach.
  const stages = card.find(".rc-quiz-stage");
  assert.equal(stages.length, 2);
  assert.deepEqual(stages.map((s) => s.inert), [false, true]);
  assert.deepEqual(stages.map((s) => s.getAttribute("aria-hidden")), [null, "true"]);
  assert.equal(shown(card).find(".rc-quiz-q")[0].find("MATH").length, 2);
  const opts = options(card);
  assert.equal(opts.length, 4);
  assert.equal(opts[0].tagName, "BUTTON");
  assert.equal(opts[0].getAttribute("title"), "Answer A");
  assert.deepEqual(opts.map((o) => o.find(".rc-opt-key")[0].textContent), ["A", "B", "C", "D"]);
  assert.equal(card.find(".rc-quiz-hint")[0].textContent, "Pick an answer · keys 1–4");
  assert.equal(card.find(".rc-quiz-why").length, 0);
  assert.deepEqual(bar(card), ["cur", ""]);

  opts[0].fire("click");
  assert.deepEqual(opts.map((o) => o.className), ["rc-opt wrong", "rc-opt right", "rc-opt dim", "rc-opt dim"]);
  assert.ok(opts.every((o) => o.disabled));
  // The right one and the pick lose their letters for a tick and a cross.
  assert.equal(opts[0].find(".rc-opt-key")[0].find("svg").length, 1);
  assert.equal(opts[1].find(".rc-opt-key")[0].find("svg").length, 1);
  assert.equal(opts[2].find(".rc-opt-key")[0].textContent, "C");
  const why = card.find(".rc-quiz-why")[0];
  assert.equal(why.className, "rc-quiz-why");
  assert.equal(why.find("B")[0].textContent, "Not A. ");
  assert.match(why.textContent, /the minus says the output is inverted/);
  assert.equal(card.find(".rc-quiz-hint").length, 0);
  assert.deepEqual(bar(card), ["ko", ""]);
  // A second click changes nothing.
  opts[1].fire("click");
  assert.equal(opts[0].className, "rc-opt wrong");

  assert.equal(nextButton(card).textContent, "Next");
  nextButton(card).fire("click");
  assert.equal(count(card), "2 / 2");
  assert.equal(shown(card), stages[1]);
  assert.deepEqual(bar(card), ["ko", "cur"]);
  assert.equal(card.find(".rc-quiz-hint")[0].textContent, "Pick an answer · keys 1–3");
  options(card)[1].fire("click");
  const right = card.find(".rc-quiz-why")[0];
  assert.equal(right.className, "rc-quiz-why ok");
  assert.equal(right.find("B")[0].textContent, "Right.");
  assert.equal(nextButton(card).textContent, "See the result");
});

test("a wrong pick with no explanation says which one was right", () => {
  const root = dom.root();
  renderMarkdown(root, fence("Short", "? Gain?\n- 1\n+ 2"), { scope: "nowhy" });
  const card = root.find(".rc-quiz")[0];
  options(card)[0].fire("click");
  assert.equal(card.find(".rc-quiz-why-text")[0].textContent, "Not A: it's B.");
});

test("keys 1 to n answer when the card has the focus; Enter and → go on", () => {
  const root = dom.root();
  renderMarkdown(root, fence("Keys", OPAMP), { scope: "keys" });
  const card = root.find(".rc-quiz")[0];
  // A key past the answers, or with Ctrl, does nothing.
  assert.equal(card.fire("keydown", { key: "5" }).defaultPrevented, false);
  assert.equal(card.fire("keydown", { key: "2", ctrlKey: true }).defaultPrevented, false);
  assert.equal(card.find(".rc-quiz-why").length, 0);
  // → before answering doesn't skip the question.
  card.fire("keydown", { key: "ArrowRight" });
  assert.equal(count(card), "1 / 2");
  assert.equal(card.fire("keydown", { key: "2" }).defaultPrevented, true);
  assert.equal(options(card)[1].className, "rc-opt right");
  // Another number after answering changes nothing.
  card.fire("keydown", { key: "1" });
  assert.equal(options(card)[0].className, "rc-opt dim");
  // Enter on a button is the button's; on the card it goes on.
  // (fakedom doesn't bubble: the card's listener is handed the event's target.)
  const button = nextButton(card);
  assert.equal(card.fire("keydown", { key: "Enter", target: button }).defaultPrevented, false);
  assert.equal(count(card), "1 / 2");
  card.fire("keydown", { key: "Enter", target: card });
  assert.equal(count(card), "2 / 2");
  card.fire("keydown", { key: "1" });
  card.fire("keydown", { key: "ArrowRight" });
  assert.equal(count(card), "Finished");
});

test("the result: the score in a ring, the missed questions, and asking them again", () => {
  const body = ["? One?\n- a\n+ b", "? Two?\n+ a\n- b", "? Three?\n- a\n+ b\n> Because.", "? Four?\n+ a\n- b"].join("\n");
  const root = dom.root();
  renderMarkdown(root, fence("Score", body), { scope: "score" });
  const card = root.find(".rc-quiz")[0];
  for (const pick of [1, 0, 0, 0]) {
    options(card)[pick].fire("click");
    nextButton(card).fire("click");
  }
  assert.equal(count(card), "Finished");
  assert.equal(card.find(".rc-quiz-deck")[0].hidden, true);
  assert.equal(card.find(".rc-quiz-end")[0].hidden, false);
  const ring = card.find(".rc-quiz-ring")[0];
  assert.equal(ring.find("B")[0].textContent, "3");
  assert.equal(ring.find("I")[0].textContent, "/4");
  assert.equal(ring.find("circle").length, 2);
  assert.equal(card.find(".rc-quiz-end-title")[0].textContent, "Good: just one wrong.");
  const missed = card.find(".rc-quiz-miss");
  assert.equal(missed.length, 1);
  assert.equal(missed[0].textContent, "Three?");
  assert.deepEqual(bar(card), ["ok", "ok", "ko", "ok"]);
  const [retry, restart] = card.find(".rc-quiz-btns")[0].find("BUTTON");
  assert.equal(retry.textContent, "Retry the wrong one");
  assert.equal(retry.className, "rc-quiz-btn primary");
  assert.equal(restart.textContent, "Start over");

  // Again: only the missed one, its answer forgotten; the others keep theirs.
  retry.fire("click");
  // The count says where the question is in the whole quiz, as the bar does.
  assert.equal(count(card), "3 / 4");
  assert.equal(shown(card).find(".rc-quiz-q")[0].textContent, "Three?");
  assert.deepEqual(bar(card), ["ok", "ok", "cur", "ok"]);
  assert.ok(options(card).every((o) => !o.disabled));
  options(card)[1].fire("click");
  assert.equal(nextButton(card).textContent, "See the result");
  nextButton(card).fire("click");
  assert.equal(card.find(".rc-quiz-end-title")[0].textContent, "Perfect: all right.");
  assert.equal(card.find(".rc-quiz-miss").length, 0);
  const only = card.find(".rc-quiz-btns")[0].find("BUTTON");
  assert.deepEqual(only.map((b) => b.textContent), ["Start over"]);
  assert.equal(only[0].className, "rc-quiz-btn primary");
  only[0].fire("click");
  assert.equal(count(card), "1 / 4");
  assert.deepEqual(bar(card), ["cur", "", "", ""]);
});

test("many missed: the score in numbers, three named, the rest counted, no arc for 0", () => {
  const body = Array.from({ length: 5 }, (_, i) => `? Q${i + 1} here?\n+ a\n- b`).join("\n");
  const root = dom.root();
  renderMarkdown(root, fence("Many", body), { scope: "many" });
  const card = root.find(".rc-quiz")[0];
  for (let i = 0; i < 5; i++) {
    options(card)[1].fire("click");
    nextButton(card).fire("click");
  }
  assert.equal(card.find(".rc-quiz-end-title")[0].textContent, "Right answers: 0 of 5.");
  assert.equal(card.find(".rc-quiz-ring")[0].find("circle").length, 1);
  const missed = card.find(".rc-quiz-miss");
  assert.deepEqual(missed.map((m) => m.textContent), ["Q1 here?", "Q2 here?", "Q3 here?", "and 2 more"]);
  assert.equal(card.find(".rc-quiz-btns")[0].find("BUTTON")[0].textContent, "Retry the wrong ones");
});

test("the answers given survive the chat's redraws, each message keeping its own", () => {
  const text = fence("Kept", OPAMP);
  const first = dom.root();
  renderMarkdown(first, text, { scope: "chat-1" });
  let card = first.find(".rc-quiz")[0];
  options(card)[1].fire("click");
  nextButton(card).fire("click");
  options(card)[0].fire("click");

  // Drawn anew (coming back to the chat): the same place, the same answers.
  const again = dom.root();
  renderMarkdown(again, text, { scope: "chat-1" });
  card = again.find(".rc-quiz")[0];
  assert.equal(count(card), "2 / 2");
  assert.deepEqual(bar(card), ["ok", "ko"]);
  assert.equal(options(card)[0].className, "rc-opt wrong");
  assert.equal(card.find(".rc-quiz-why").length, 1);

  // The same quiz in another message starts from the beginning.
  const other = dom.root();
  renderMarkdown(other, text, { scope: "chat-2" });
  assert.equal(count(other.find(".rc-quiz")[0]), "1 / 2");
});

test("a block that isn't a quiz is shown as the code it was written as", () => {
  const root = dom.root();
  renderMarkdown(root, fence("Broken", "? No right answer?\n- a\n- b"));
  assert.equal(root.find(".rc-quiz").length, 0);
  assert.match(root.textContent, /No right answer\?/);
});

test("the missed ones by their = line; more questions asked of the AI when the chat lets the card", async () => {
  const { renderQuiz } = await import("../src/views/rich/quiz.ts");
  const sent = [];
  const ctx = {
    markdown: () => {},
    inline: (into, text) => into.append(text),
    math: () => document.createElement("span"),
    copyButton: () => document.createElement("button"),
    send: (text) => sent.push(text),
  };
  const quiz = parseQuiz("Sent", "? A long question about the gain?\n- a\n+ b\n= Gain\n? Two?\n+ a\n- b");
  const card = renderQuiz(quiz, ctx, "quiz-send");
  dom.root().append(card);
  options(card)[0].fire("click");
  nextButton(card).fire("click");
  options(card)[0].fire("click");
  nextButton(card).fire("click");
  assert.deepEqual(card.find(".rc-quiz-miss").map((m) => m.textContent), ["Gain"]);
  const buttons = card.find(".rc-quiz-btns")[0].find("BUTTON");
  assert.deepEqual(buttons.map((b) => b.textContent), ["Retry the wrong one", "3 more questions"]);
  assert.equal(buttons[1].className, "rc-quiz-btn");
  buttons[1].fire("click");
  assert.deepEqual(sent, ["Quiz me with 3 more questions on the same subject."]);

  // All right: asking for more comes first, starting over after it.
  const perfect = renderQuiz(parseQuiz("", "? One?\n- a\n+ b"), ctx, "quiz-send-perfect");
  options(perfect)[1].fire("click");
  nextButton(perfect).fire("click");
  const two = perfect.find(".rc-quiz-btns")[0].find("BUTTON");
  assert.deepEqual(two.map((b) => [b.textContent, b.className]), [
    ["3 more questions", "rc-quiz-btn primary"],
    ["Start over", "rc-quiz-btn"],
  ]);
});
