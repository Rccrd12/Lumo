// Where a chat is being read: the element at the top of its log and how far
// into it, so the place can be found again once the log was laid out at
// another size. The island closing narrows the chat to its small size, where
// every line wraps again, and opening widens it back: the browser's scroll
// anchoring alone can lose the place on the way (views/chat.ts keeps it).

export interface ReadPlace {
  /** The child indexes from the log down to the element at its top. */
  path: number[];
  /** The top of the log inside that element, as a share of its height (0 when the element starts below it). */
  share: number;
  /** How far below the top of the log the element starts (0 when the top is inside it). */
  gap: number;
}

/** Not looked into: a card, a block of code or a formula keeps one shape however wide the chat. */
const WHOLE = ".rc-card, .rc-callout, pre, .md-pre, .katex-display, table, svg, canvas, img";
/** How deep the place is looked for: a message, its paragraph, a line of a list. */
const MAX_DEPTH = 6;

/** Laid out with the text around it (not a button floating over a message). */
function inFlow(el: Element): boolean {
  if (typeof getComputedStyle !== "function") return true;
  const position = getComputedStyle(el).position;
  return position !== "absolute" && position !== "fixed";
}

/** The place read at the top of `log`, or null when nothing is shown there. */
export function readPlace(log: HTMLElement): ReadPlace | null {
  if (log.clientHeight <= 0) return null;
  const top = log.getBoundingClientRect().top;
  const path: number[] = [];
  let parent: Element = log;
  let found: Element | null = null;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const kids = parent.children;
    let next = -1;
    for (let i = 0; i < kids.length; i++) {
      const r = kids[i].getBoundingClientRect();
      if (r.height > 0 && r.bottom > top && inFlow(kids[i])) {
        next = i;
        break;
      }
    }
    if (next < 0) break;
    path.push(next);
    found = kids[next];
    if (found.getBoundingClientRect().top >= top || found.matches(WHOLE)) break;
    parent = found;
  }
  if (!found) return null;
  const r = found.getBoundingClientRect();
  return r.top >= top ? { path, share: 0, gap: r.top - top } : { path, share: (top - r.top) / r.height, gap: 0 };
}

/** The element a place names, if the log still has it. */
function placed(log: HTMLElement, place: ReadPlace): Element | null {
  let el: Element = log;
  for (const i of place.path) {
    const next = el.children[i];
    if (!next) return null;
    el = next;
  }
  return el === log ? null : el;
}

/** Scrolls `log` so `place` is at its top again (as near as it can go); false when its element is gone. */
export function putPlace(log: HTMLElement, place: ReadPlace): boolean {
  const el = placed(log, place);
  if (!el) return false;
  const top = log.getBoundingClientRect().top;
  const r = el.getBoundingClientRect();
  const want = place.share > 0 ? top - place.share * r.height : top + place.gap;
  const by = r.top - want;
  if (Math.abs(by) >= 0.5) log.scrollTop += by;
  return true;
}
