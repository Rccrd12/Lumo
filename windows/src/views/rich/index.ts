// The rich cards in the chat's answers (Windows only). markdown.ts finds them
// and hands them over here:
// - GitHub's alerts, `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`
//   and `> [!CAUTION]`, an optional title after the kind (callout.ts);
// - the ```lumo-… blocks Lumo's system prompt teaches (chat.rs rich_note):
//   lumo-steps (steps.ts), lumo-cards (cards.ts), lumo-calc and lumo-plot
//   (calc.ts, their formulas read by core/expr.ts, never run as code),
//   lumo-quiz (quiz.ts), lumo-chart (chart.ts), lumo-timeline (timeline.ts)
//   and lumo-checklist (checklist.ts);
// - GitHub's task lists, `- [ ] text`, as a checklist (checklist.ts);
// - a ```diff block (diff-card.ts);
// - a line that is only an image (image.ts).
//
// Each card is built from DOM nodes and text only, never HTML. A block a card
// can't read comes back as null, and markdown.ts shows it as the code it was
// written as: nothing a model writes is lost. The island is wide and low, so
// the cards lie sideways or keep one height.

import { h } from "../dom";
import { N_, t } from "../../i18n/i18n";
import { parseSteps, renderSteps } from "./steps";
import { parseCards, renderCards } from "./cards";
import { parseCalc, parsePlot, renderCalc, renderPlot } from "./calc";
import { parseQuiz, renderQuiz } from "./quiz";
import { parseChart, renderChart } from "./chart";
import { parseTimeline, renderTimeline } from "./timeline";
import { renderChecklist } from "./checklist";
import { parseChecklist } from "../../core/checklists";
import "./rich.css";

export { renderCallout } from "./callout";
export { renderImage } from "./image";
export { renderDiffCard } from "./diff-card";
export { renderChecklist } from "./checklist";

export const CALLOUT_TYPES = ["note", "tip", "important", "warning", "caution"] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

/** The ```lumo-<kind> blocks with a card of their own. */
export const RICH_KINDS = ["steps", "cards", "calc", "plot", "quiz", "chart", "timeline", "checklist"] as const;
export type RichKind = (typeof RICH_KINDS)[number];

/** What the cards borrow from markdown.ts, which hands it over (no import back). */
export interface RichContext {
  /** Renders Markdown blocks into `into`, replacing what it shows. */
  markdown(into: HTMLElement, text: string): void;
  /** Appends a line of inline Markdown (bold, `code`, $math$, links) to `into`. */
  inline(into: HTMLElement, text: string): void;
  /** A TeX formula, inline or on a line of its own. */
  math(tex: string, display?: boolean): Element;
  /** Markdown's copy button, for `text`. */
  copyButton(text: string): HTMLElement;
  /**
   * The block's identity beyond its text: the message it is in and its place
   * there. keyOf(block, ctx) puts it in the key, so the same block in two
   * messages keeps two states.
   */
  scope?: string;
  /** The message's own scope, as chat.ts gave it to renderMarkdown ("" when none). */
  message?: string;
  /** A checklist's place among its message's checklists, from 0. */
  list?: number;
  /** Sends a message in the chat as if typed (markdown.ts MarkdownOptions.send); absent while streaming. */
  send?(text: string): void;
}

export interface RichBlock {
  type: string;
  title: string;
  body: string;
  /** Its closing fence has not come yet: the answer is still being written. */
  open: boolean;
}

export const RICH_STRINGS = {
  steps: N_("Steps"),
  cards: N_("Comparison"),
  calc: N_("Calculator"),
  plot: N_("Chart"),
  quiz: N_("Quiz"),
  chart: N_("Chart"),
  timeline: N_("Timeline"),
  checklist: N_("Checklist"),
  writing: N_("Writing it…"),
};

/**
 * The card for a ```lumo-… block, a placeholder while it streams, or null
 * when it can't be read. markdown.ts hands an unclosed block of a finished
 * answer over as closed: only the answer being written shows the placeholder.
 */
export function renderRich(block: RichBlock, ctx: RichContext): HTMLElement | null {
  const kind = block.type as RichKind;
  if (!RICH_KINDS.includes(kind)) return null;
  if (block.open) return pending(kind, block.title, ctx);
  const key = keyOf(block, ctx);
  try {
    switch (kind) {
      case "steps": {
        const steps = parseSteps(block.title, block.body);
        return steps && renderSteps(steps, ctx, key);
      }
      case "cards": {
        const cards = parseCards(block.title, block.body);
        return cards && renderCards(cards, ctx, key);
      }
      case "calc": {
        const calc = parseCalc(block.title, block.body);
        return calc && renderCalc(calc, ctx, key);
      }
      case "plot": {
        const plot = parsePlot(block.title, block.body);
        return plot && renderPlot(plot, ctx, key);
      }
      case "quiz": {
        const quiz = parseQuiz(block.title, block.body);
        return quiz && renderQuiz(quiz, ctx, key);
      }
      case "chart": {
        const chart = parseChart(block.title, block.body);
        return chart && renderChart(chart, ctx, key);
      }
      case "timeline": {
        const timeline = parseTimeline(block.title, block.body);
        return timeline && renderTimeline(timeline, ctx, key);
      }
      case "checklist": {
        const list = parseChecklist(block.title, block.body);
        return list && renderChecklist(list, ctx);
      }
    }
  } catch {
    return null;
  }
}

/** While the block is being written: its kind and title, and a line saying so. */
function pending(kind: RichKind, title: string, ctx: RichContext): HTMLElement {
  return h(
    "div",
    { class: "rc-card rc-pending" },
    head(kind, title, ctx),
    h("div", { class: "rc-pending-line" }, h("i"), h("i"), h("i"), h("span", { text: t(RICH_STRINGS.writing) })),
  );
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

/**
 * A card's top line: its kind as a small label, its title (its inline
 * Markdown, **bold** or $math$, read through `ctx`), then `right` (counters,
 * buttons).
 */
export function head(kind: RichKind, title: string, ctx: RichContext | null, ...right: (Node | null | false | undefined)[]): HTMLElement {
  const el = h("div", { class: "rc-head" }, h("span", { class: "rc-kind", text: t(RICH_STRINGS[kind]) }));
  if (title) {
    const name = h("span", { class: "rc-title" });
    if (ctx) ctx.inline(name, title);
    else name.textContent = title;
    name.setAttribute("title", name.textContent || title);
    el.append(name);
  }
  el.append(h("span", { class: "rc-sp" }));
  for (const r of right) if (r) el.append(r);
  return el;
}

// ── What a card remembers ─────────────────────────────────────────────────────
//
// The chat redraws its answers often (each streamed word, the finished answer
// replacing the streamed one, coming back to a chat): a card keeps the step it
// is on or where its sliders are by its block's text and its place (the
// message, and the block's place in it), not by its nodes.

const MEMORY_LIMIT = 300;
const memory = new Map<string, unknown>();

/** The block's identity across redraws: its place (ctx.scope), kind, title and lines. */
export function keyOf(block: Pick<RichBlock, "type" | "title" | "body">, ctx?: Pick<RichContext, "scope">): string {
  return `${ctx?.scope ?? ""}\u0000${block.type}\u0000${block.title}\u0000${block.body}`;
}

/**
 * Forgets the state of the cards in `chatId`'s messages from place `message`
 * on (core/checklists.ts messageScope): those messages left the chat (an
 * edit, a Retry), and the answer that takes their place starts afresh, even
 * with the same quiz in it.
 */
export function forgetCardsFrom(chatId: string, message: number): void {
  const prefix = `${chatId}#`;
  for (const key of [...memory.keys()]) {
    if (!key.startsWith(prefix)) continue;
    const place = /^(\d+)[\u0000>]/.exec(key.slice(prefix.length));
    if (place && Number(place[1]) >= message) memory.delete(key);
  }
}

/** The state kept for `key`, made by `init` the first time. */
export function remember<T>(key: string, init: () => T): T {
  if (memory.has(key)) {
    const value = memory.get(key) as T;
    // The newest last, so the oldest goes first when there are too many.
    memory.delete(key);
    memory.set(key, value);
    return value;
  }
  const value = init();
  memory.set(key, value);
  if (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value as string);
  return value;
}
