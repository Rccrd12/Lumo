// The rich cards in the chat's answers (Windows only). markdown.ts finds them
// and hands them over here:
// - GitHub's alerts, `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`
//   and `> [!CAUTION]`, an optional title after the kind (callout.ts);
// - the ```lumo-… blocks Lumo's system prompt teaches (chat.rs rich_note):
//   lumo-steps (steps.ts), lumo-cards (cards.ts), lumo-calc and lumo-plot
//   (calc.ts, their formulas read by core/expr.ts, never run as code);
// - a line that is only an image (image.ts), fetched by Rust once the user
//   lets its site in.
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
import "./rich.css";

export { renderCallout } from "./callout";
export { renderImage } from "./image";
export { renderDiffCard } from "./diff-card";

export const CALLOUT_TYPES = ["note", "tip", "important", "warning", "caution"] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

/** The ```lumo-<kind> blocks with a card of their own. */
export const RICH_KINDS = ["steps", "cards", "calc", "plot", "quiz", "chart", "timeline"] as const;
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
  writing: N_("Writing it…"),
};

/** The card for a ```lumo-… block, a placeholder while it streams, or null when it can't be read. */
export function renderRich(block: RichBlock, ctx: RichContext): HTMLElement | null {
  const kind = block.type as RichKind;
  if (!RICH_KINDS.includes(kind)) return null;
  if (block.open) return pending(kind, block.title);
  try {
    switch (kind) {
      case "steps": {
        const steps = parseSteps(block.title, block.body);
        return steps && renderSteps(steps, ctx, keyOf(block));
      }
      case "cards": {
        const cards = parseCards(block.title, block.body);
        return cards && renderCards(cards, ctx, keyOf(block));
      }
      case "calc": {
        const calc = parseCalc(block.title, block.body);
        return calc && renderCalc(calc, ctx, keyOf(block));
      }
      case "plot": {
        const plot = parsePlot(block.title, block.body);
        return plot && renderPlot(plot, ctx, keyOf(block));
      }
      case "quiz": {
        const quiz = parseQuiz(block.title, block.body);
        return quiz && renderQuiz(quiz, ctx, keyOf(block));
      }
      case "chart": {
        const chart = parseChart(block.title, block.body);
        return chart && renderChart(chart, ctx, keyOf(block));
      }
      case "timeline": {
        const timeline = parseTimeline(block.title, block.body);
        return timeline && renderTimeline(timeline, ctx, keyOf(block));
      }
    }
  } catch {
    return null;
  }
}

/** While the block is being written: its kind and title, and a line saying so. */
function pending(kind: RichKind, title: string): HTMLElement {
  return h(
    "div",
    { class: "rc-card rc-pending" },
    head(kind, title),
    h("div", { class: "rc-pending-line" }, h("i"), h("i"), h("i"), h("span", { text: t(RICH_STRINGS.writing) })),
  );
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

/** A card's top line: its kind as a small label, its title, then `right` (counters, buttons). */
export function head(kind: RichKind, title: string, ...right: (Node | null | false | undefined)[]): HTMLElement {
  const el = h("div", { class: "rc-head" }, h("span", { class: "rc-kind", text: t(RICH_STRINGS[kind]) }));
  if (title) el.append(h("span", { class: "rc-title", text: title, title }));
  el.append(h("span", { class: "rc-sp" }));
  for (const r of right) if (r) el.append(r);
  return el;
}

// ── What a card remembers ─────────────────────────────────────────────────────
//
// The chat redraws its answers often (each streamed word, the finished answer
// replacing the streamed one, coming back to a chat): a card keeps the step it
// is on or where its sliders are by its block's text, not by its nodes.

const MEMORY_LIMIT = 300;
const memory = new Map<string, unknown>();

/** The block's identity across redraws: its kind, title and lines. */
export function keyOf(block: Pick<RichBlock, "type" | "title" | "body">): string {
  return `${block.type}\u0000${block.title}\u0000${block.body}`;
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
