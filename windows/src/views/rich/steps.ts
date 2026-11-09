// The ```lumo-steps card: a derivation or a procedure one step at a time.
//
//   ```lumo-steps Integration by parts
//   ## Product rule
//   $$d(uv) = u\,dv + v\,du$$
//   ## Move v du to the other side
//   $$u\,dv = d(uv) - v\,du$$
//   A short sentence under the formula, if it needs one.
//   ```
//
// Each heading starts a step and names it; the lines under it are its
// Markdown, its first display formula drawn large in the middle of the card.
// A block with no heading at all is read line by line, each line a step. The
// card keeps one height as it steps: the formula it comes from small and dim
// above, the current one large, its number and name under it, and a bar of
// segments at the bottom, one per step. The list button shows every step at
// once; a row of the list goes back to that step.

import { h, svg } from "../dom";
import { ICONS } from "../icons";
import { N_, t } from "../../i18n/i18n";
import { head, remember, RICH_STRINGS, type RichContext } from "./index";
import "./steps.css";

export const STEPS_STRINGS = {
  previous: N_("Previous step"),
  next: N_("Next step"),
  all: N_("All steps"),
  step: N_("Step {n}"),
  start: N_("Where it starts"),
};

/** Fewer steps than this is no walk-through; more is no longer one. */
export const MIN_STEPS = 2;
export const MAX_STEPS = 20;

export interface Step {
  /** Its heading, as inline Markdown; "" when it has none. */
  label: string;
  /** Its first display formula's TeX, drawn large; null for a step in words. */
  tex: string | null;
  /** The rest of its Markdown, that formula taken out. */
  text: string;
}

export interface Steps {
  title: string;
  steps: Step[];
}

/** `## Product rule`, and the other heading levels models reach for. */
const HEADING = /^ {0,3}#{1,6}(?!#)[ \t]*(.*)$/;
/** A display formula: `$$…$$` or `\[…\]`, on one line or several. */
const DISPLAY = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/;
/** A line that is only an inline formula, `$…$`, written where a display one was meant. */
const LONE_INLINE = /^[ \t]*\$([^$\n]+)\$[ \t]*$/m;
/** A step's number written into its name ("2. ", "2) ", "Step 2: "), which the card shows already. */
const NUMBERED = /^(?:\p{L}+[ \t]+)?\d+[ \t]*[.):\-–—][ \t]+(?=\S)/u;
/** A list marker before a line, in a block written without headings. */
const MARKER = /^(?:[-*+•]|\d+[.)])[ \t]+/;

/**
 * Reads a lumo-steps block's lines into its steps. Forgiving: any heading
 * level, numbers written into the names, `$…$` alone on a line, no heading at
 * all (a step per line). Null when it isn't a walk-through: fewer than two
 * steps or more than twenty, and markdown.ts shows the block as code.
 */
export function parseSteps(title: string, body: string): Steps | null {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const steps = lines.some((l) => HEADING.test(l)) ? byHeadings(lines) : byLines(lines);
  if (steps.length < MIN_STEPS || steps.length > MAX_STEPS) return null;
  return { title: title.trim(), steps };
}

/** A step per heading, its lines under it; what comes before the first heading is left out. */
function byHeadings(lines: string[]): Step[] {
  const steps: Step[] = [];
  let label: string | null = null;
  let under: string[] = [];
  const flush = () => {
    if (label === null) return;
    const step = stepOf(label, under.join("\n"));
    if (step) steps.push(step);
  };
  for (const line of lines) {
    const m = HEADING.exec(line);
    if (m) {
      flush();
      label = cleanLabel(m[1]);
      under = [];
    } else {
      under.push(line);
    }
  }
  flush();
  return steps;
}

/**
 * No heading: each line that isn't blank is a step, a formula on several
 * lines (`$$` alone, then its lines, then `$$`) counting as one. A line with a
 * formula and words, "Product rule: $$…$$", keeps the words as its name.
 */
function byLines(lines: string[]): Step[] {
  const steps: Step[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;
    const close = line === "$$" ? "$$" : line === "\\[" ? "\\]" : null;
    if (close) {
      const tex: string[] = [];
      for (i++; i < lines.length && lines[i].trim() !== close; i++) tex.push(lines[i]);
      line = `$$${tex.join("\n")}$$`;
    }
    const step = stepOf("", line.replace(MARKER, ""));
    if (!step) continue;
    if (step.tex && step.text && !/\n|\$\$|\\\[/.test(step.text)) {
      steps.push({ label: step.text.replace(/[ \t]*[:：=]$/, ""), tex: step.tex, text: "" });
    } else {
      steps.push(step);
    }
  }
  return steps;
}

/** A step from its name and Markdown, its first display formula set apart; null when both are empty. */
function stepOf(label: string, markdown: string): Step | null {
  let text = markdown.trim();
  let tex: string | null = null;
  const m = DISPLAY.exec(text) ?? LONE_INLINE.exec(text);
  if (m) {
    const found = (m[1] ?? m[2] ?? "").trim();
    if (found) {
      tex = found;
      text = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim().replace(/\n{3,}/g, "\n\n");
    }
  }
  if (!label && !tex && !text) return null;
  return { label, tex, text };
}

/** A heading's text as a step's name: without a closing `##` or a number the card already shows. */
function cleanLabel(raw: string): string {
  const label = raw.replace(/[ \t]+#+[ \t]*$/, "").trim();
  return label.replace(NUMBERED, "") || label;
}

/**
 * What the copy button copies: the steps as ordinary Markdown, a numbered
 * bold name then the step's formula and words, so it pastes anywhere (a
 * document, another chat) with its TeX as written, not as a lumo-steps block
 * only Lumo draws.
 */
export function stepsMarkdown(steps: Steps): string {
  const parts: string[] = [];
  if (steps.title) parts.push(`**${steps.title}**`);
  steps.steps.forEach((s, i) => {
    const lines = [s.label ? `**${i + 1}. ${s.label}**` : `**${i + 1}.**`];
    if (s.tex) lines.push(`$$${s.tex}$$`);
    if (s.text) lines.push(s.text);
    parts.push(lines.join("\n\n"));
  });
  return parts.join("\n\n");
}

/** list.bullet: three dots and three lines. */
const LIST = "M8 6.5h12M8 12h12M8 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01";

/** Where a card is, kept across the chat's redraws. */
interface Place {
  at: number;
  all: boolean;
}

/** The card for `steps`; `key` is its block's, which keeps the step it is on. */
export function renderSteps(steps: Steps, ctx: RichContext, key: string): HTMLElement {
  const list = steps.steps;
  const last = list.length - 1;
  const place = remember<Place>(key, () => ({ at: 0, all: false }));
  place.at = Math.min(Math.max(place.at, 0), last);

  const count = h("span", { class: "rc-count", "aria-live": "polite" });
  const prev = navButton(svg(ICONS.chevronLeft, 12, { stroke: 2 }), t(STEPS_STRINGS.previous), () => go(place.at - 1));
  const next = navButton(svg(ICONS.chevronRight, 12, { stroke: 2 }), t(STEPS_STRINGS.next), () => go(place.at + 1));
  const toggle = navButton(svg(LIST, 12, { stroke: 1.8 }), t(STEPS_STRINGS.all), () => {
    place.all = !place.all;
    show();
  });
  const copy = ctx.copyButton(stepsMarkdown(steps));
  const body = h("div", { class: "rc-steps-body" });
  const segments = list.map((_, i) => {
    const label = t(STEPS_STRINGS.step, { n: i + 1 });
    // Out of the Tab order: the arrows and the buttons above already move.
    return h("button", { class: "rc-seg", tabindex: -1, title: label, "aria-label": label, onclick: () => go(i) });
  });
  const bar = h("div", { class: "rc-bar" }, ...segments);
  const card = h(
    "div",
    { class: "rc-card rc-steps", tabindex: 0, role: "group", "aria-label": steps.title || t(RICH_STRINGS.steps) },
    head("steps", steps.title, count, prev, next, toggle, copy),
    body,
    bar,
  );

  card.addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    if (k.ctrlKey || k.altKey || k.metaKey || k.shiftKey) return;
    const to = k.key === "ArrowLeft" ? place.at - 1 : k.key === "ArrowRight" ? place.at + 1 : k.key === "Home" ? 0 : k.key === "End" ? last : null;
    if (to == null) return;
    k.preventDefault();
    k.stopPropagation();
    go(to);
  });

  function go(i: number) {
    const to = Math.min(Math.max(i, 0), last);
    if (to === place.at) return;
    place.at = to;
    show();
  }

  /** Brings the card to where it is; only what changes is redrawn, so the buttons keep the focus. */
  function show() {
    const { at, all } = place;
    count.textContent = `${at + 1} / ${list.length}`;
    prev.disabled = at === 0;
    next.disabled = at === last;
    toggle.classList.toggle("on", all);
    toggle.setAttribute("aria-pressed", String(all));
    segments.forEach((s, i) => {
      s.className = i < at ? "rc-seg done" : i === at ? "rc-seg cur" : "rc-seg";
      if (i === at) s.setAttribute("aria-current", "step");
      else s.removeAttribute("aria-current");
    });
    bar.hidden = all;
    body.replaceChildren(all ? rows() : stage());
    // A button that just turned off would drop the focus to the page: the card keeps it.
    const focused = typeof document !== "undefined" ? document.activeElement : null;
    if ((focused === prev && prev.disabled) || (focused === next && next.disabled)) card.focus();
  }

  /** One step: the formula it comes from, its own large, its number and name. */
  function stage(): HTMLElement {
    const cur = list[place.at];
    const before = list[place.at - 1];
    const from = h("div", { class: "rc-steps-prev" });
    if (!before) from.append(h("span", { class: "rc-steps-start", text: t(STEPS_STRINGS.start) }));
    else if (before.tex) from.append(ctx.math(before.tex));
    else from.append(oneLine(before.label || before.text));

    const main = h("div", { class: "rc-steps-cur" });
    if (cur.tex) main.append(h("div", { class: "rc-steps-formula" }, ctx.math(cur.tex, true)));
    // A step that is only a name says it here, large, and not again under it.
    const nameOnly = !cur.tex && !cur.text;
    if (cur.text) {
      const text = h("div", { class: cur.tex ? "rc-steps-text" : "rc-steps-text only" });
      ctx.markdown(text, cur.text);
      main.append(text);
    } else if (nameOnly) {
      const text = h("div", { class: "rc-steps-text only" });
      ctx.inline(text, cur.label);
      main.append(text);
    }

    const name = h("div", { class: "rc-steps-label" }, h("span", { class: "rc-num", text: String(place.at + 1) }));
    if (cur.label && !nameOnly) {
      const span = h("span", { class: "rc-steps-name" });
      ctx.inline(span, cur.label);
      name.append(span);
    }
    return h("div", { class: "rc-steps-stage" }, from, main, name);
  }

  /** Every step at once, a row each; a row goes back to that step. */
  function rows(): HTMLElement {
    const named = list.some((s) => s.label);
    return h(
      "div",
      { class: "rc-steps-list" },
      ...list.map((s, i) => {
        const row = h(
          "button",
          { class: i === place.at ? "rc-steps-row cur" : "rc-steps-row" },
          h("span", { class: "rc-num", text: String(i + 1) }),
        );
        if (named) {
          const label = h("span", { class: "rc-steps-row-label" });
          ctx.inline(label, s.label);
          row.append(label);
        }
        const what = h("span", { class: "rc-steps-row-what" });
        if (s.tex) what.append(ctx.math(s.tex));
        else if (s.text) what.append(oneLine(s.text));
        row.append(what);
        row.addEventListener("click", () => {
          place.at = i;
          place.all = false;
          show();
          card.focus();
        });
        return row;
      }),
    );
  }

  /** The first line of some Markdown, inline, cut short by the stylesheet. */
  function oneLine(markdown: string): HTMLElement {
    const el = h("span", { class: "rc-steps-line" });
    ctx.inline(el, markdown.split("\n").find((l) => l.trim()) ?? "");
    return el;
  }

  show();
  return card;
}

/** A small square button of the card's top line. */
function navButton(icon: SVGSVGElement, label: string, onClick: () => void): HTMLButtonElement {
  return h("button", { class: "rc-nav", title: label, "aria-label": label, onclick: onClick }, icon);
}
