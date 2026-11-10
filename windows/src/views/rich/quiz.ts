// The ```lumo-quiz card: multiple-choice questions to go over a subject, one
// at a time, marked by Lumo with no other turn of the AI.
//
//   ```lumo-quiz Op-amp
//   ? An inverting amplifier has $R_1 = 1\,\text{k}\Omega$
//     and $R_2 = 10\,\text{k}\Omega$. What is its gain?
//   - $+10$
//   + $-10$
//   - $+11$
//   > In the inverting amplifier $G = -R_2/R_1$: the minus says the output is inverted.
//   = Inverting gain: $-R_2/R_1$
//
//   ? (the next question)
//   ```
//
// `?` starts a question, `-` is a wrong answer and `+` the right one (exactly
// one, two to six answers), `>` the explanation shown once it is answered,
// `=` a few words that name the question in the score's list of the ones
// missed (the question itself, cut to a line, when there are none). A
// question, an answer or an explanation goes on over the indented lines under
// it. All of it is inline Markdown, formulas included. The answers stay hidden
// until one is picked: the AI writes them all, the card uncovers them. A click
// or the keys 1 to 6 answer; the right one turns green, a wrong pick red, and
// the explanation comes under them with the button to go on (Enter or → on
// the card goes on too). At the end, the
// score and the questions missed, a button that asks the missed ones again
// and, when the chat lets a card write to the AI, one that asks for more. The questions are laid out in the same place, one over the other, so
// the card keeps one height from one question to the next.

import { h, svg } from "../dom";
import { ICONS } from "../icons";
import { N_, t } from "../../i18n/i18n";
import { head, remember, RICH_STRINGS, type RichContext } from "./index";
import "./quiz.css";

export const QUIZ_STRINGS = {
  hint: N_("Pick an answer · keys 1–{n}"),
  answer: N_("Answer {letter}"),
  right: N_("Right."),
  wrong: N_("Not {letter}."),
  wrongIs: N_("Not {letter}: it's {right}."),
  next: N_("Next"),
  result: N_("See the result"),
  finished: N_("Finished"),
  perfect: N_("Perfect: all right."),
  oneWrong: N_("Good: just one wrong."),
  score: N_("Right answers: {score} of {total}."),
  andMore: N_("and {n} more"),
  retryOne: N_("Retry the wrong one"),
  retryAll: N_("Retry the wrong ones"),
  restart: N_("Start over"),
  more: N_("{n} more questions"),
  moreAsk: N_("Quiz me with {n} more questions on the same subject."),
};

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
export const MAX_QUESTIONS = 10;
/** The questions missed listed by name at the end; the rest are counted. */
const MISSED_SHOWN = 3;
const LETTERS = "ABCDEF";

export interface QuizQuestion {
  /** The question, as inline Markdown. */
  text: string;
  /** The answers, as inline Markdown, in the order written. */
  options: string[];
  /** Which answer is right. */
  right: number;
  /** Why, as inline Markdown; "" when the block gives none. */
  why: string;
  /** A few words that name it among the ones missed, as inline Markdown; "" when the block gives none. */
  short: string;
}

export interface Quiz {
  title: string;
  questions: QuizQuestion[];
}

/** A question as it is read, before it is checked. */
interface Draft {
  text: string[];
  options: { text: string[]; right: boolean }[];
  why: string[];
  short: string[];
}

const QUESTION = /^\?\s*(.*)$/;
const OPTION = /^([-+*])\s+(.*)$/;
/** A right answer written as a ticked task, `- [x]`, the way some models mark one. */
const TICKED = /^[-*+]\s+\[([ xX])\]\s+(.*)$/;
const WHY = /^>\s?(.*)$/;
const SHORT = /^=\s+(.*)$/;
/** A question's number written before it ("1. ", "Q2) "), which the bar shows already. */
const NUMBERED = /^(?:Q\s*)?\d+[.):]\s+(?=\S)/i;
/** A letter or number written before an answer ("A) ", "b. ", "1) "), which the card shows already. */
const LETTERED = /^(?:[A-Fa-f]|[1-6])[.)]\s+(?=\S)/;

/**
 * Reads a lumo-quiz block into its questions. Forgiving: a question written
 * without its `?` (a plain line once the one before has answers), `* ` for a
 * wrong answer, `- [x]` for the right one, a letter before each answer, an
 * explanation over several `>` lines. A question that can't be marked (no
 * right answer or more than one, fewer than two answers or more than six) is
 * left out. Null when no question is left or there are more than ten, and
 * markdown.ts shows the block as code.
 */
export function parseQuiz(title: string, body: string): Quiz | null {
  const drafts: Draft[] = [];
  let cur: Draft | null = null;
  /** What an indented line goes on: the question, the last answer or the explanation. */
  let last: string[] | null = null;
  const start = (text: string): Draft => {
    const draft: Draft = { text: text ? [text] : [], options: [], why: [], short: [] };
    drafts.push(draft);
    last = draft.text;
    return draft;
  };
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const indented = /^[ \t]/.test(raw);
    const ticked = TICKED.exec(line);
    const option = ticked ? null : OPTION.exec(line);
    const question = QUESTION.exec(line);
    const why = WHY.exec(line);
    const short = SHORT.exec(line);
    if (question) {
      cur = start(question[1].trim().replace(NUMBERED, ""));
    } else if (ticked || option) {
      cur ??= start("");
      const text = [(ticked ?? option)![2].trim()];
      cur.options.push({ text, right: ticked ? ticked[1] !== " " : option![1] === "+" });
      last = text;
    } else if (why) {
      if (!cur) continue;
      cur.why.push(why[1].trim());
      last = cur.why;
    } else if (short) {
      if (!cur) continue;
      cur.short.push(short[1].trim());
      last = cur.short;
    } else if (indented && last) {
      last.push(line);
    } else if (cur && cur.options.length === 0) {
      // The question going on, on a line of its own.
      cur.text.push(line);
    } else {
      // A question without its `?`.
      cur = start(line.replace(NUMBERED, ""));
    }
  }
  const questions: QuizQuestion[] = [];
  for (const d of drafts) {
    unletter(d);
    const q = questionOf(d);
    if (q) questions.push(q);
  }
  if (questions.length === 0 || questions.length > MAX_QUESTIONS) return null;
  return { title: title.trim(), questions };
}

/**
 * Takes the letters or numbers off a question's answers, only when every one
 * has one and they run in order (A, B, C… in either case, or 1, 2, 3…): an
 * answer that starts with an initial, "E. coli" or "F. Scott Fitzgerald",
 * keeps it.
 */
function unletter(d: Draft): void {
  const marks = d.options.map((o) => LETTERED.exec(o.text[0])?.[0].trim()[0].toUpperCase());
  const inOrder = (first: string) => marks.every((m, i) => m === String.fromCharCode(first.charCodeAt(0) + i));
  if (marks.length === 0 || !(inOrder("A") || inOrder("1"))) return;
  for (const o of d.options) o.text[0] = o.text[0].replace(LETTERED, "").trim();
}

/** A draft as a question the card can mark, or null. */
function questionOf(d: Draft): QuizQuestion | null {
  const options = d.options.map((o) => ({ text: joinLines(o.text), right: o.right })).filter((o) => o.text);
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) return null;
  const right = options.filter((o) => o.right);
  if (right.length !== 1) return null;
  const text = joinLines(d.text);
  if (!text) return null;
  return { text, options: options.map((o) => o.text), right: options.findIndex((o) => o.right), why: joinLines(d.why), short: joinLines(d.short) };
}

/** Lines that go on one another, as one line of inline Markdown. */
function joinLines(lines: string[]): string {
  return lines.map((l) => l.trim()).filter(Boolean).join(" ");
}

/** How far the quiz is, kept across the chat's redraws. */
interface Play {
  /** The answer picked for each question; null before one is. */
  picks: (number | null)[];
  /** The questions of this round: every one, then the missed ones when asked again. */
  round: number[];
  /** The place in the round. */
  at: number;
  /** The round is over: the score shows. */
  done: boolean;
}

/** The card for `quiz`; `key` is its block's, which keeps the answers given. */
export function renderQuiz(quiz: Quiz, ctx: RichContext, key: string): HTMLElement {
  const list = quiz.questions;
  const play = remember<Play>(key, () => fresh(list.length));
  // A memory from another shape of the block (it can't be, the key holds its text) starts over.
  if (play.picks.length !== list.length || play.round.some((i) => i >= list.length) || play.round.length === 0) {
    Object.assign(play, fresh(list.length));
  }
  play.at = Math.min(Math.max(play.at, 0), play.round.length - 1);

  const count = h("span", { class: "rc-count", "aria-live": "polite" });
  // Every question built once, one over the other: the card is as tall as the tallest.
  const stages = list.map((q) => stage(q));
  const deck = h("div", { class: "rc-quiz-deck" }, ...stages.map((s) => s.el));
  // How to answer, or why: under the current question's answers, in its stage,
  // so a question shorter than the tallest leaves its room at the bottom.
  const foot = h("div", { class: "rc-quiz-foot", "aria-live": "polite" });
  const end = h("div", { class: "rc-quiz-end" });
  const segments = list.map(() => h("i"));
  const bar = h("div", { class: "rc-quiz-bar", "aria-hidden": "true" }, ...segments);
  const card = h(
    "div",
    { class: "rc-card rc-quiz", tabindex: 0, role: "group", "aria-label": quiz.title || t(RICH_STRINGS.quiz) },
    head("quiz", quiz.title, count),
    deck,
    end,
    bar,
  );

  card.addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    if (k.ctrlKey || k.altKey || k.metaKey) return;
    if (play.done) return;
    const q = play.round[play.at];
    const n = Number(k.key);
    if (play.picks[q] == null && Number.isInteger(n) && n >= 1 && n <= list[q].options.length) {
      k.preventDefault();
      k.stopPropagation();
      pick(n - 1);
      return;
    }
    // Enter on a button presses it already; on the card it goes on.
    if (play.picks[q] != null && (k.key === "ArrowRight" || (k.key === "Enter" && k.target === card))) {
      k.preventDefault();
      k.stopPropagation();
      next();
    }
  });

  function pick(option: number) {
    const q = play.round[play.at];
    if (play.done || play.picks[q] != null) return;
    play.picks[q] = option;
    show();
    // The answers have just turned off: the focus goes to the button that goes on.
    if (holdsFocus(card)) (foot.querySelector("button") as HTMLElement | null)?.focus();
  }

  function next() {
    if (play.at < play.round.length - 1) play.at++;
    else play.done = true;
    const had = holdsFocus(card);
    show();
    if (had) (play.done ? ((end.querySelector("button") as HTMLElement | null) ?? card) : card).focus();
  }

  /** Asks `round` again from its first question, their answers forgotten. */
  function again(round: number[]) {
    for (const i of round) play.picks[i] = null;
    play.round = round;
    play.at = 0;
    play.done = false;
    const had = holdsFocus(card);
    show();
    if (had) card.focus();
  }

  /** Brings the card to where the quiz is. */
  function show() {
    const q = play.round[play.at];
    const picked = play.picks[q];
    // Where the question is in the whole quiz, as the bar shows it, also when only the missed ones are asked again.
    count.textContent = play.done ? t(QUIZ_STRINGS.finished) : `${q + 1} / ${list.length}`;
    card.classList.toggle("done", play.done);
    stages.forEach((s, i) => {
      const on = !play.done && i === q;
      s.el.classList.toggle("on", on);
      if (on) s.el.removeAttribute("aria-hidden");
      else s.el.setAttribute("aria-hidden", "true");
      s.el.inert = !on;
      s.mark(play.picks[i]);
    });
    deck.hidden = play.done;
    end.hidden = !play.done;
    segments.forEach((seg, i) => {
      const p = play.picks[i];
      seg.className = p != null ? (p === list[i].right ? "ok" : "ko") : !play.done && i === q ? "cur" : "";
    });
    if (play.done) {
      foot.replaceChildren();
      end.replaceChildren(...result());
    } else {
      end.replaceChildren();
      foot.replaceChildren(picked == null ? hint(list[q]) : why(list[q], picked));
      if (foot.parentElement !== stages[q].el) stages[q].el.append(foot);
    }
  }

  /** A question: its words and its answers, and how to mark them once one is picked. */
  function stage(q: QuizQuestion): { el: HTMLElement; mark: (picked: number | null) => void } {
    const text = h("div", { class: "rc-quiz-q" });
    ctx.inline(text, q.text);
    const keys: HTMLElement[] = [];
    const buttons = q.options.map((o, i) => {
      const label = t(QUIZ_STRINGS.answer, { letter: LETTERS[i] });
      const keyEl = h("span", { class: "rc-opt-key" });
      keys.push(keyEl);
      const words = h("span", { class: "rc-opt-text" });
      ctx.inline(words, o);
      return h("button", { class: "rc-opt", type: "button", title: label, onclick: () => pick(i) }, keyEl, words);
    });
    const el = h("div", { class: "rc-quiz-stage" }, text, h("div", { class: "rc-quiz-opts" }, ...buttons));
    return {
      el,
      mark(picked) {
        buttons.forEach((b, i) => {
          const state = picked == null ? "" : i === q.right ? " right" : i === picked ? " wrong" : " dim";
          b.className = "rc-opt" + state;
          b.disabled = picked != null;
          const icon = picked == null ? null : i === q.right ? svg(ICONS.check, 11, { stroke: 2.6 }) : i === picked ? svg(ICONS.xmark, 11) : null;
          keys[i].replaceChildren(icon ?? LETTERS[i]);
        });
      },
    };
  }

  /** Under a question not answered yet: how to answer. */
  function hint(q: QuizQuestion): HTMLElement {
    return h("div", { class: "rc-quiz-hint", text: t(QUIZ_STRINGS.hint, { n: q.options.length }) });
  }

  /** Under an answered question: right or not, why, and the button that goes on. */
  function why(q: QuizQuestion, picked: number): HTMLElement {
    const ok = picked === q.right;
    const text = h("div", { class: "rc-quiz-why-text" });
    const verdict = ok
      ? t(QUIZ_STRINGS.right)
      : q.why
        ? t(QUIZ_STRINGS.wrong, { letter: LETTERS[picked] })
        : t(QUIZ_STRINGS.wrongIs, { letter: LETTERS[picked], right: LETTERS[q.right] });
    text.append(h("b", { text: verdict + (q.why ? " " : "") }));
    if (q.why) ctx.inline(text, q.why);
    const last = play.at === play.round.length - 1;
    const label = t(last ? QUIZ_STRINGS.result : QUIZ_STRINGS.next);
    const go = h("button", { class: "rc-quiz-btn primary", type: "button", text: label, title: label, onclick: () => next() });
    return h("div", { class: ok ? "rc-quiz-why ok" : "rc-quiz-why" }, text, go);
  }

  /** The end of a round: the score in a ring, a line on it, the questions missed and what to do next. */
  function result(): HTMLElement[] {
    const total = list.length;
    const missed = list.map((_, i) => i).filter((i) => play.picks[i] !== list[i].right);
    const score = total - missed.length;
    const title = missed.length === 0
      ? t(QUIZ_STRINGS.perfect)
      : missed.length === 1 && total > 2
        ? t(QUIZ_STRINGS.oneWrong)
        : t(QUIZ_STRINGS.score, { score, total });
    const body = h("div", { class: "rc-quiz-end-body" }, h("span", { class: "rc-quiz-end-title", text: title }));
    for (const i of missed.slice(0, MISSED_SHOWN)) {
      const words = h("span", { class: "rc-quiz-miss-text" });
      ctx.inline(words, list[i].short || list[i].text);
      body.append(h("span", { class: "rc-quiz-miss" }, svg(ICONS.xmark, 10), words));
    }
    if (missed.length > MISSED_SHOWN) {
      body.append(h("span", { class: "rc-quiz-miss more", text: t(QUIZ_STRINGS.andMore, { n: missed.length - MISSED_SHOWN }) }));
    }
    const buttons = h("div", { class: "rc-quiz-btns" });
    if (missed.length) {
      const label = t(missed.length === 1 ? QUIZ_STRINGS.retryOne : QUIZ_STRINGS.retryAll);
      buttons.append(h("button", { class: "rc-quiz-btn primary", type: "button", text: label, title: label, onclick: () => again(missed) }));
    }
    const restart = t(QUIZ_STRINGS.restart);
    const restartButton = (primary: boolean) =>
      h("button", { class: primary ? "rc-quiz-btn primary" : "rc-quiz-btn", type: "button", text: restart, title: restart, onclick: () => again(list.map((_, i) => i)) });
    // The chat gives a finished answer a way to write to the AI: the card then
    // offers more questions. Without it, the card starts over instead.
    const send = ctx.send;
    if (send) {
      // As many new questions as this quiz had, three at least so the words stay plural.
      const n = Math.max(3, total);
      const label = t(QUIZ_STRINGS.more, { n });
      buttons.append(h("button", { class: missed.length ? "rc-quiz-btn" : "rc-quiz-btn primary", type: "button", text: label, title: label, onclick: () => send(t(QUIZ_STRINGS.moreAsk, { n })) }));
      if (!missed.length) buttons.append(restartButton(false));
    } else {
      buttons.append(restartButton(!missed.length));
    }
    body.append(buttons);
    return [ring(score, total), body];
  }

  show();
  return card;
}

/** A quiz not started: every question, from the first. */
function fresh(n: number): Play {
  return { picks: Array.from({ length: n }, () => null), round: Array.from({ length: n }, (_, i) => i), at: 0, done: false };
}

const SVG_NS = "http://www.w3.org/2000/svg";
const RING_R = 24;

/** The score: a ring lit for the share right, the number in the middle. */
function ring(score: number, total: number): HTMLElement {
  const box = document.createElementNS(SVG_NS, "svg");
  box.setAttribute("width", "60");
  box.setAttribute("height", "60");
  box.setAttribute("viewBox", "0 0 60 60");
  box.setAttribute("aria-hidden", "true");
  const circle = (cls: string) => {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("class", cls);
    c.setAttribute("cx", "30");
    c.setAttribute("cy", "30");
    c.setAttribute("r", String(RING_R));
    c.setAttribute("fill", "none");
    c.setAttribute("stroke-width", "5");
    return c;
  };
  box.append(circle("rc-quiz-ring-track"));
  if (score > 0) {
    const around = 2 * Math.PI * RING_R;
    // The round caps reach past the arc's ends: it is drawn a little shorter.
    const lit = score === total ? around : Math.max(0.5, (around * score) / total - 2);
    const arc = circle("rc-quiz-ring-lit");
    arc.setAttribute("stroke-linecap", "round");
    arc.setAttribute("stroke-dasharray", `${lit.toFixed(2)} ${around.toFixed(2)}`);
    arc.setAttribute("transform", "rotate(-90 30 30)");
    box.append(arc);
  }
  return h(
    "div",
    { class: "rc-quiz-ring", role: "img", "aria-label": `${score}/${total}` },
    box,
    h("span", {}, h("b", { text: String(score) }), h("i", { text: `/${total}` })),
  );
}

/** Whether the focus is on `el` or inside it. */
function holdsFocus(el: HTMLElement): boolean {
  if (typeof document === "undefined") return false;
  for (let n: Element | null = document.activeElement ?? null; n; n = n.parentElement) if (n === el) return true;
  return false;
}
