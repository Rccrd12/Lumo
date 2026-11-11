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
// card keeps one height as it steps, its tallest step's (every step is laid
// out in the same place, only the current one shown, a shorter one in the
// middle of that height): the formula it comes from small and dim above, the current one large, its number and name under
// it, and a bar of segments at the bottom, one per step. The list button shows
// every step at once; a row of the list goes back to that step. The copy
// button, after the title, shows when the pointer is over the card, as a
// formula's does, so it covers nothing of the steps.

import { h, svg } from "../dom";
import { ICONS } from "../icons";
import { N_, t } from "../../i18n/i18n";
import { head, remember, RICH_STRINGS, type RichContext } from "./index";
import "./steps.css";
import { onResize } from "./resize";

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
/** A code fence line, ``` or ~~~: its marker. */
const FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
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
  const code = inCode(lines);
  const steps = lines.some((l, i) => !code[i] && HEADING.test(l)) ? byHeadings(lines, code) : byLines(lines);
  if (steps.length < MIN_STEPS || steps.length > MAX_STEPS) return null;
  return { title: title.trim(), steps };
}

/**
 * Which lines are a code block's, its fences included: a `# comment` in a
 * step's bash or Python is no heading. A fence is closed by a bare one of the
 * same character, at least as long, as markdown.ts reads them.
 */
function inCode(lines: string[]): boolean[] {
  let open = "";
  return lines.map((line) => {
    const m = FENCE.exec(line);
    if (!m) return open !== "";
    if (!open) open = m[1];
    else if (m[2].trim() === "" && m[1][0] === open[0] && m[1].length >= open.length) open = "";
    return true;
  });
}

/** A step per heading, its lines under it; what comes before the first heading is left out. */
function byHeadings(lines: string[], code: boolean[]): Step[] {
  const steps: Step[] = [];
  let label: string | null = null;
  let under: string[] = [];
  const flush = () => {
    if (label === null) return;
    const step = stepOf(label, under.join("\n"));
    if (step) steps.push(step);
  };
  for (const [i, line] of lines.entries()) {
    const m = code[i] ? null : HEADING.exec(line);
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
  copy.classList.add("rc-steps-copy");
  const top = head("steps", steps.title, ctx, count, prev, next, toggle);
  // After the title: hidden at rest, it takes the title's room, not the buttons'.
  const parts = [...top.childNodes];
  parts.splice(parts.findIndex((n) => (n as Element).classList?.contains("rc-sp")), 0, copy);
  top.replaceChildren(...parts);
  const body = h("div", { class: "rc-steps-body" });
  /** The list's rows while it shows. */
  let listed: HTMLElement[] = [];
  // Every step built once, one over the other: the card is as tall as the tallest.
  const stages = list.map((_, i) => stage(i));
  const deck = h("div", { class: "rc-steps-deck" }, ...stages);
  const segments = list.map((_, i) => {
    const label = t(STEPS_STRINGS.step, { n: i + 1 });
    // Out of the Tab order: the arrows and the buttons above already move.
    return h("button", { class: "rc-seg", tabindex: -1, title: label, "aria-label": label, onclick: () => go(i) });
  });
  const bar = h("div", { class: "rc-bar" }, ...segments);
  const card = h(
    "div",
    { class: "rc-card rc-steps", tabindex: 0, role: "group", "aria-label": steps.title || t(RICH_STRINGS.steps) },
    top,
    body,
    bar,
  );

  card.addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    if (k.ctrlKey || k.altKey || k.metaKey || k.shiftKey) return;
    // In the list, the arrows go from the row the focus is on, up and down as well.
    const row = place.all ? listed.indexOf(document.activeElement as HTMLElement) : -1;
    const from = row >= 0 ? row : place.at;
    const back = k.key === "ArrowLeft" || (place.all && k.key === "ArrowUp");
    const ahead = k.key === "ArrowRight" || (place.all && k.key === "ArrowDown");
    const to = back ? from - 1 : ahead ? from + 1 : k.key === "Home" ? 0 : k.key === "End" ? last : null;
    if (to == null) return;
    k.preventDefault();
    k.stopPropagation();
    go(to);
  });

  function go(i: number) {
    const to = Math.min(Math.max(i, 0), last);
    if (to === place.at) {
      // The focus on another row of the list still comes to the current one.
      if (place.all && holdsFocus(body)) listed[to]?.focus();
      return;
    }
    place.at = to;
    show();
  }

  /** Brings the card to where it is; only what changes is redrawn, so the buttons keep the focus. */
  function show() {
    const { at, all } = place;
    const hadFocus = holdsFocus(body);
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
    stages.forEach((s, i) => {
      s.classList.toggle("on", i === at);
      if (i === at) s.removeAttribute("aria-hidden");
      else s.setAttribute("aria-hidden", "true");
      s.inert = i !== at;
    });
    if (all) {
      const box = rows();
      body.replaceChildren(box);
      // The current step in sight, in the middle when it can be: only the list scrolls, never the chat.
      const row = listed[at];
      if (row && box.scrollHeight > box.clientHeight) {
        const offset = row.getBoundingClientRect().top - box.getBoundingClientRect().top;
        box.scrollTop = Math.max(0, offset - (box.clientHeight - row.offsetHeight) / 2);
      }
    } else if (body.firstChild !== deck) {
      listed = [];
      body.replaceChildren(deck);
    }
    // The focus was on a row of the list, or a link of a step, that has just
    // gone: it moves to the current row, or to the card, so the arrow keys go on.
    if (hadFocus && !holdsFocus(body)) {
      (all ? listed[at] : card).focus();
    }
    // A button that just turned off would drop the focus to the page: the card keeps it.
    const focused = typeof document !== "undefined" ? document.activeElement : null;
    if ((focused === prev && prev.disabled) || (focused === next && next.disabled)) card.focus();
  }

  /** Step `at`: the formula it comes from, its own large, its number and name. */
  function stage(at: number): HTMLElement {
    const cur = list[at];
    const before = list[at - 1];
    const from = h("div", { class: "rc-steps-prev" });
    if (!before) from.append(h("span", { class: "rc-steps-start", text: t(STEPS_STRINGS.start) }));
    else if (before.tex) from.append(fadeWhenWide(h("span", { class: "rc-steps-prev-tex" }, ctx.math(before.tex))));
    else from.append(oneLine(before.label || before.text));

    const main = h("div", { class: "rc-steps-cur" });
    if (cur.tex) main.append(fadeWhenWide(h("div", { class: "rc-steps-formula" }, ctx.math(cur.tex, true))));
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

    const name = h("div", { class: "rc-steps-label" }, h("span", { class: "rc-num", text: String(at + 1) }));
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
    listed = list.map((s, i) => {
      const row = h(
        "button",
        { class: i === place.at ? "rc-steps-row cur" : "rc-steps-row" },
        h("span", { class: "rc-num", text: String(i + 1) }),
      );
      // The name and the formula share a baseline, the formula a size up.
      const line = h("span", { class: "rc-steps-row-body" });
      if (named) {
        const label = h("span", { class: "rc-steps-row-label" });
        ctx.inline(label, s.label);
        line.append(label);
      }
      const what = h("span", { class: s.tex ? "rc-steps-row-what tex" : "rc-steps-row-what" });
      if (s.tex) what.append(ctx.math(s.tex));
      else if (s.text) what.append(oneLine(s.text));
      line.append(what);
      row.append(line);
      row.addEventListener("click", () => {
        place.at = i;
        place.all = false;
        show();
        card.focus();
      });
      return row;
    });
    return h("div", { class: "rc-steps-list" }, ...listed);
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

/**
 * Fades `el`, a formula wider than the card, at the edge it goes on past, so a
 * cut one shows there is more. Checked when it is laid out or resized and
 * when it is scrolled: nothing runs while it is left alone.
 */
function fadeWhenWide(el: HTMLElement): HTMLElement {
  const sync = () => {
    const max = el.scrollWidth - el.clientWidth;
    el.classList.toggle("fade-start", max > 1 && el.scrollLeft > 1);
    el.classList.toggle("fade-end", max > 1 && el.scrollLeft < max - 1);
  };
  el.addEventListener("scroll", sync, { passive: true });
  onResize(el, sync);
  return el;
}

/** Whether the focus is on `el` or inside it. */
function holdsFocus(el: HTMLElement): boolean {
  if (typeof document === "undefined") return false;
  for (let n: Element | null = document.activeElement ?? null; n; n = n.parentElement) if (n === el) return true;
  return false;
}

/** A small square button of the card's top line. */
function navButton(icon: SVGSVGElement, label: string, onClick: () => void): HTMLButtonElement {
  return h("button", { class: "rc-nav", title: label, "aria-label": label, onclick: onClick }, icon);
}
