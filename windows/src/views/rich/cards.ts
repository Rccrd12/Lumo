// The ```lumo-cards block: two to eight things side by side, a comparison
// laid out sideways because the island is wide and low. Each card has a
// title, an optional subtitle and icon, a few "key: value" rows and a line or
// two of text:
//
//   ```lumo-cards Rocky planets
//   ## Mercury
//   sub: Closest to the Sun
//   icon: planet #c9c2b8
//   - Distance: 58 million km
//   - Day: 176 Earth days
//   Hot by day, **430 °C**.
//   ## Venus
//   …
//   ```
//
// The icon is drawn in code: a letter or an emoji in a small tinted square,
// or a planet (a lit sphere, with a ring if asked). Its colour is one of a
// few names or a #hex, checked strictly since it ends up in a style. The
// cards share the width when they fit; when they don't, the row scrolls
// sideways, with a fade and round buttons at its edges.

import { h, svg } from "../dom";
import { ICONS } from "../icons";
import { N_, t } from "../../i18n/i18n";
import { head, remember, type RichContext } from "./index";
import "./cards.css";

export const CARDS_STRINGS = {
  count: N_("{count} cards"),
  next: N_("Next card"),
  previous: N_("Previous card"),
};

export type CardIcon =
  /** One or two characters (a letter, a sign, an emoji) in a small tinted square. */
  | { kind: "glyph"; text: string; color: string }
  /** A sphere lit from the top left, `ring` for one like Saturn's. */
  | { kind: "planet"; color: string; ring: boolean };

export interface Card {
  title: string;
  sub: string;
  icon: CardIcon | null;
  /** The "- key: value" rows; the value is inline Markdown. */
  fields: [string, string][];
  /** The other lines, each inline Markdown. */
  text: string[];
}

export interface Cards {
  title: string;
  cards: Card[];
}

const MIN_CARDS = 2;
const MAX_CARDS = 8;

/** The colour names a model may write, in the app's palette. */
const COLORS: Record<string, string> = {
  blue: "#8fc7ff",
  green: "var(--green-2)",
  amber: "var(--amber)",
  yellow: "var(--amber)",
  orange: "#ff8a5b",
  red: "var(--red-text)",
  pink: "var(--pink)",
  indigo: "#a5b4fc",
  purple: "#a5b4fc",
  violet: "#a5b4fc",
  cyan: "var(--cyan)",
  gray: "var(--dim)",
  grey: "var(--dim)",
};

const DEFAULT_GLYPH_COLOR = COLORS.blue;
const DEFAULT_PLANET_COLOR = "#c9c2b8";

/** `#rgb`, `#rrggbb` or a palette name; anything else is not a colour (it goes into a style). */
export function cardColor(word: string): string | null {
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(word)) return word.toLowerCase();
  const name = word.toLowerCase();
  return Object.hasOwn(COLORS, name) ? COLORS[name] : null;
}

/** How many characters a reader sees in `text` (an emoji with its joiners counts as one). */
function graphemes(text: string): number {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
  }
  return Array.from(text).length;
}

/** The icon written after "icon:", or null when it isn't one. */
export function parseIcon(spec: string): CardIcon | null {
  const words = spec.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  if (/^planets?$/i.test(words[0])) {
    let color = DEFAULT_PLANET_COLOR;
    let ring = false;
    for (const w of words.slice(1)) {
      if (/^(?:ring|rings|ringed)$/i.test(w)) ring = true;
      else color = cardColor(w) ?? color;
    }
    return { kind: "planet", color, ring };
  }
  // The character first, then a colour, in either order when a model swaps them.
  let color = DEFAULT_GLYPH_COLOR;
  let text = "";
  for (const w of words) {
    const c = cardColor(w);
    if (c && w.startsWith("#")) color = c;
    else if (!text) text = w;
    else if (c) color = c;
  }
  if (!text || graphemes(text) > 2) return null;
  return { kind: "glyph", text, color };
}

/** Bold or code around a whole key or title, which the card already sets apart. */
function bare(text: string): string {
  return text
    .trim()
    .replace(/^(\*\*|__|`)(.+)\1$/, "$2")
    .trim();
}

/**
 * A "- key: value" line (or "* key: value", "**Key:** value", "**Key**: value"),
 * or null. A key is short and plain: a sentence with a colon in it stays text.
 */
function field(line: string): [string, string] | null {
  const m =
    /^\*\*([^*]+?):\*\*\s*(.*)$/.exec(line) ??
    /^\*\*([^*]+?)\*\*\s*:\s*(.*)$/.exec(line) ??
    /^([^:]+?)\s*:(?:\s+(.*)|)$/.exec(line);
  if (!m) return null;
  const key = bare(m[1]);
  if (!key || key.length > 40 || /[$`[\]]/.test(key) || /^https?$/i.test(key)) return null;
  return [key, (m[2] ?? "").trim()];
}

/** A card's title from its heading: `## Mercury`, `### **Mercury**`. */
const HEADING = /^#{1,4}(?:\s+(.*?)(?:\s+#+)?)?\s*$/;
/** "sub:", "Subtitle:", "icon:" at the start of a line, bulleted or not. */
const META = /^(?:[-*+•]\s+)?\**(sub|subtitle|icon)\**\s*:\**\s*(.*)$/i;
const BULLET = /^[-*+•]\s+(.*)$/;

/** The cards of a lumo-cards block, or null when there are fewer than two or more than eight. */
export function parseCards(title: string, body: string): Cards | null {
  const cards: Card[] = [];
  let card: Card | null = null;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const heading = HEADING.exec(line);
    if (heading) {
      card = { title: bare(heading[1] ?? ""), sub: "", icon: null, fields: [], text: [] };
      cards.push(card);
      continue;
    }
    // Before the first heading: an introduction the card has no place for.
    if (!card) continue;
    const meta = META.exec(line);
    if (meta) {
      const value = meta[2].trim();
      if (meta[1].toLowerCase() === "icon") card.icon = parseIcon(value) ?? card.icon;
      else if (!card.sub) card.sub = bare(value);
      else card.text.push(value);
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      const f = field(bullet[1]);
      if (f) card.fields.push(f);
      else card.text.push(`• ${bullet[1]}`);
      continue;
    }
    // "**Key:** value" without a bullet is a row too; "Note: …" stays a sentence.
    const strong = line.startsWith("**") ? field(line) : null;
    if (strong) card.fields.push(strong);
    else card.text.push(line);
  }
  const kept = cards.filter((c) => c.title || c.sub || c.fields.length || c.text.length);
  if (kept.length < MIN_CARDS || kept.length > MAX_CARDS) return null;
  return { title: title.trim(), cards: kept };
}

// ── The card ──────────────────────────────────────────────────────────────────

/** Where the row was scrolled to, kept across the chat's redraws. */
interface CardsState {
  left: number;
}

/** A mouse wheel notch is about 100 px; a touchpad sends smaller, finer deltas. */
const FINE_DELTA_PX = 40;
/** The gap between two cards, in cards.css. */
const GAP_PX = 8;
const CARD_PX = 176;

function iconNode(icon: CardIcon): HTMLElement {
  const el =
    icon.kind === "planet"
      ? h("span", { class: icon.ring ? "rc-planet ring" : "rc-planet", "aria-hidden": "true" })
      : h("span", {
          class: /\p{Extended_Pictographic}/u.test(icon.text) ? "rc-mono emoji" : "rc-mono",
          "aria-hidden": "true",
          text: icon.text,
        });
  el.style.setProperty("--c", icon.color);
  return el;
}

function miniCard(card: Card, ctx: RichContext): HTMLElement {
  const title = h("span", { class: "rc-mini-title" });
  ctx.inline(title, card.title);
  let sub: HTMLElement | null = null;
  if (card.sub) {
    sub = h("span", { class: "rc-mini-sub" });
    ctx.inline(sub, card.sub);
  }
  const el = h(
    "div",
    { class: "rc-mini", role: "listitem" },
    h("div", { class: "rc-mini-top" }, card.icon && iconNode(card.icon), h("div", { class: "rc-mini-titles" }, title, sub)),
  );
  for (const [key, value] of card.fields) {
    const val = h("span", { class: "rc-field-val" });
    ctx.inline(val, value);
    el.append(h("div", { class: "rc-field" }, h("span", { class: "rc-field-key", text: key }), val));
  }
  if (card.text.length) {
    const text = h("div", { class: "rc-mini-text" });
    for (const line of card.text) {
      const p = h("span", { class: "rc-mini-line" });
      ctx.inline(p, line);
      text.append(p);
    }
    el.append(text);
  }
  return el;
}

/** Whether `target`, inside a card of the row, scrolls that card itself that way. */
function cardScrolls(target: EventTarget | null, row: HTMLElement, down: boolean): boolean {
  for (let n = (target as Node | null)?.nodeType === 1 ? (target as Element) : null; n && n !== row; n = n.parentElement) {
    if (!n.classList.contains("rc-mini")) continue;
    if (n.scrollHeight <= n.clientHeight + 1) return false;
    return down ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0;
  }
  return false;
}

/**
 * The cards side by side. The row learns whether it overflows from a
 * ResizeObserver (when it is laid out, and when the island is resized) and
 * from its own scroll events: nothing runs while it is left alone.
 */
export function renderCards(cards: Cards, ctx: RichContext, key: string): HTMLElement {
  const state = remember<CardsState>(key, () => ({ left: 0 }));
  const row = h("div", { class: "rc-cards-row", role: "list" }, ...cards.cards.map((c) => miniCard(c, ctx)));
  const step = () => ((row.firstChild as HTMLElement | null)?.offsetWidth || CARD_PX) + GAP_PX;
  const scrollBy = (left: number) => row.scrollBy({ left, behavior: "smooth" });
  const prev = h(
    "button",
    { class: "rc-cards-btn prev", type: "button", title: t(CARDS_STRINGS.previous), "aria-label": t(CARDS_STRINGS.previous), onclick: () => scrollBy(-step()) },
    svg(ICONS.chevronLeft, 12, { stroke: 2.2 }),
  );
  const next = h(
    "button",
    { class: "rc-cards-btn next", type: "button", title: t(CARDS_STRINGS.next), "aria-label": t(CARDS_STRINGS.next), onclick: () => scrollBy(step()) },
    svg(ICONS.chevronRight, 12, { stroke: 2.2 }),
  );
  const clip = h("div", { class: "rc-cards-clip" }, row, prev, next);
  const count = h("span", { class: "rc-count rc-cards-count", text: t(CARDS_STRINGS.count, { count: cards.cards.length }) });
  const el = h("div", { class: "rc-card rc-cards" }, head("cards", cards.title, count), clip);

  // Puts the row back where it was the first time it has a width (a redraw
  // builds it anew), then shows the fades and buttons its scroll calls for.
  let restored = false;
  const sync = () => {
    const width = row.clientWidth;
    if (!width) return;
    if (!restored) {
      restored = true;
      if (state.left) row.scrollLeft = state.left;
    }
    const max = row.scrollWidth - width;
    el.classList.toggle("more", max > 1);
    clip.classList.toggle("at-start", row.scrollLeft <= 1);
    clip.classList.toggle("at-end", row.scrollLeft >= max - 1);
  };
  row.addEventListener("scroll", () => {
    sync();
    state.left = row.scrollLeft;
  });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(sync).observe(row);

  // A mouse wheel turned over the row moves it sideways while it can go that
  // way; at its ends, and when every card fits, the chat scrolls as usual.
  row.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey || e.shiftKey || !e.deltaY || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const max = row.scrollWidth - row.clientWidth;
      if (max <= 1) return;
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * row.clientWidth : e.deltaY;
      if (dy > 0 ? row.scrollLeft >= max - 1 : row.scrollLeft <= 1) return;
      if (cardScrolls(e.target, row, dy > 0)) return;
      e.preventDefault();
      // The chat's own wheel handler (gentleWheel) would scroll it down as well.
      e.stopPropagation();
      if (Math.abs(dy) < FINE_DELTA_PX) row.scrollLeft += dy;
      else row.scrollBy({ left: dy, behavior: "smooth" });
    },
    { passive: false },
  );
  return el;
}
