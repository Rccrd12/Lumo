// The answer as it is written ("ink"). Instead of each piece showing the
// moment it arrives, in bursts, the text comes at a steady pace and is
// uncovered letter by letter behind a soft edge that moves along it.
//
// The pace: what is shown chases what arrived, never ahead of it, at least
// MIN_PACE characters a second and fast enough to be at most about LAG
// seconds behind. The text is drawn only where Markdown can be cut cleanly
// (cutPoints): after whole words, with a list marker and its word together,
// and never inside a formula, inline code, a link or bold text still open, so
// nothing shows half-written and then changes. A formula waits until it is
// complete (half a formula is broken TeX), then the edge sweeps across it;
// a code block flows like the text.
//
// The edge: the letters ahead of it are laid out but clear, so nothing moves
// when they appear. Only the letters near the edge are wrapped in spans; the
// rest of the answer stays plain text. When everything that arrived is
// uncovered the frames stop (no work while the answer waits or is hidden),
// and once the answer is complete it is drawn once more, plainly.

/** Characters a second, at the least. */
const MIN_PACE = 70;
/** How far behind what arrived the pace stays, in seconds. */
const LAG = 0.32;
/** Laid out ahead of the pace, still clear, so the edge never waits on a word. */
const AHEAD = 40;
/** The soft edge, in letters. */
const EDGE = 26;
/** The edge's own pace, letters a second at the least; it catches up in about EDGE_LAG seconds. */
const EDGE_PACE = 60;
const EDGE_LAG = 0.35;
/** How many letters a formula counts for, as the edge sweeps across it. */
const DISPLAY_WEIGHT = 34;
const INLINE_WEIGHT = 8;

const MARKER = /^\s*(?:[-*+]|\d+[.)]|#{1,6}|>+)$/;

/**
 * Where `text`, as it is so far, may be cut to be drawn: positions right after
 * a word. `complete`: the text is all there, so its end is a cut too.
 */
export function cutPoints(text: string, complete = false): number[] {
  const n = text.length;
  // Where no cut may go: [from, to), `to` = n when still open.
  const closed: [number, number][] = [];
  const lines = text.split("\n");
  let at = 0;
  let fence: string | null = null;
  const fenceStarts: number[] = []; // a fence's first word comes with its line
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const start = at;
    const end = at + line.length; // the newline, or n
    const lineDone = li < lines.length - 1;
    at = end + 1;
    const fenceMark = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      if (fenceMark && fenceMark[1][0] === fence[0] && fenceMark[1].length >= fence.length && line.trim() === fenceMark[1]) fence = null;
      continue;
    }
    if (fenceMark) {
      fence = fenceMark[1];
      // The fence line and the code's first word come together.
      fenceStarts.push(start);
      continue;
    }
    // A table row comes whole.
    if (/^\s*\|/.test(line) && !lineDone) closed.push([start, n]);
    holds(text, start, end, lineDone, closed);
  }
  // A display formula ($$ … $$, \[ … \]) may span lines.
  for (const [open, close] of [["$$", "$$"], ["\\[", "\\]"]] as const) {
    for (let i = text.indexOf(open); i >= 0; ) {
      if (inFence(text, i)) {
        i = text.indexOf(open, i + open.length);
        continue;
      }
      const j = text.indexOf(close, i + open.length);
      closed.push([i, j < 0 ? n : j + close.length]);
      if (j < 0) break;
      i = text.indexOf(open, j + close.length);
    }
  }
  // Each range blocks the cuts strictly inside it (and its end while still open).
  for (const f of fenceStarts) closed.push([f, firstWordAfterFence(text, f)]);
  const blocked = new Int32Array(n + 2);
  for (const [a, b] of closed) {
    blocked[a + 1]++;
    blocked[b === n && !complete ? n + 1 : b]--;
  }
  const cuts: number[] = [];
  let inside = 0;
  for (let i = 1; i <= n; i++) {
    inside += blocked[i];
    if (i === n ? !complete : !(/\S/.test(text[i - 1]) && /\s/.test(text[i]))) continue;
    if (inside > 0) continue;
    const lineStart = text.lastIndexOf("\n", i - 1) + 1;
    if (MARKER.test(text.slice(lineStart, i))) continue;
    cuts.push(i);
  }
  return cuts;
}

/** The end of the first word after the fence line at `start`. */
function firstWordAfterFence(text: string, start: number): number {
  const nl = text.indexOf("\n", start);
  if (nl < 0) return text.length;
  const m = /\S+/.exec(text.slice(nl + 1));
  return m ? nl + 1 + m.index + m[0].length : text.length;
}

/** Whether `i` is inside a fenced code block. */
function inFence(text: string, i: number): boolean {
  let fence: string | null = null;
  for (const line of text.slice(0, i).split("\n").slice(0, -1)) {
    const m = /^\s*(```+|~~~+)/.exec(line);
    if (!m) continue;
    if (!fence) fence = m[1];
    else if (m[1][0] === fence[0] && line.trim() === m[1]) fence = null;
  }
  return fence != null;
}

/** Inline code, inline formulas, links and bold text still open on one line hold the cuts after them. */
function holds(text: string, start: number, end: number, lineDone: boolean, closed: [number, number][]) {
  const n = text.length;
  const hold = (from: number, to: number) => closed.push([from, to]);
  let i = start;
  while (i < end) {
    const c = text[i];
    if (c === "\\") {
      // \( … \) and an escaped character.
      if (text[i + 1] === "(") {
        const j = text.indexOf("\\)", i + 2);
        if (j >= 0 && j < end) hold(i, j + 2), (i = j + 2);
        else {
          if (!lineDone) hold(i, n);
          i = end;
        }
        continue;
      }
      i += 2;
      continue;
    }
    if (c === "`") {
      let k = i;
      while (text[k] === "`") k++;
      const ticks = text.slice(i, k);
      const j = text.indexOf(ticks, k);
      if (j >= 0 && j < end) hold(i, j + ticks.length), (i = j + ticks.length);
      else {
        if (!lineDone) hold(i, n);
        i = k;
      }
      continue;
    }
    if (c === "$") {
      if (text[i + 1] === "$") {
        // A display formula: handled across lines.
        const j = text.indexOf("$$", i + 2);
        i = j >= 0 ? j + 2 : end;
        continue;
      }
      // "$5" or "$ 5": a price, not a formula (markdown.ts reads them so too).
      if (i + 1 < n && /[\s\d]/.test(text[i + 1])) {
        i++;
        continue;
      }
      const j = text.indexOf("$", i + 1);
      if (j >= 0 && j < end) hold(i, j + 1), (i = j + 1);
      else {
        // A lone $ on a finished line is a dollar, not a formula.
        if (!lineDone) hold(i, n);
        i++;
      }
      continue;
    }
    if (c === "[") {
      const close = text.indexOf("]", i + 1);
      if (close >= 0 && close < end) {
        if (text[close + 1] === "(") {
          const paren = text.indexOf(")", close + 2);
          if (paren >= 0 && paren < end) hold(i, paren + 1), (i = paren + 1);
          else {
            if (!lineDone) hold(i, n);
            i = end;
          }
          continue;
        }
        // [text] then possibly ( still to come.
        if (close + 1 === n) hold(i, n);
        i = close + 1;
        continue;
      }
      if (!lineDone) hold(i, n);
      i++;
      continue;
    }
    if ((c === "*" || c === "~" || c === "_") && text[i + 1] === c) {
      const pair = c + c;
      const j = text.indexOf(pair, i + 2);
      if (j >= 0 && j < end) hold(i, j + 2), (i = j + 2);
      else {
        if (!lineDone) hold(i, n);
        i += 2;
      }
      continue;
    }
    i++;
  }
}

/** The last cut at or before `limit` (0 when none). */
export function lastCut(cuts: number[], limit: number): number {
  let lo = 0;
  let hi = cuts.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cuts[mid] <= limit) {
      best = cuts[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

/** Ink needs a real page: frames, a tree walker, and motion the user did not turn off. */
export function inkWorks(): boolean {
  if (typeof document === "undefined" || typeof document.createTreeWalker !== "function") return false;
  if (typeof requestAnimationFrame !== "function" || typeof matchMedia !== "function") return false;
  return !matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type Draw = (into: HTMLElement, text: string) => void;

interface Piece {
  el: HTMLElement | SVGElement | Element;
  /** Its first letter, counted from the answer's start. */
  at: number;
  kind: "letter" | "sweep" | "box";
  weight: number;
}

const clamp = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * The letters' spans laid so far. A card, image or callout stays the same
 * node from one draw to the next (markdown.ts), so its letters may already be
 * in spans: they are counted again as they are, never wrapped a second time.
 */
const laid = new WeakSet<Element>();

/** One answer being written, drawn into one element at a time. */
export class Ink {
  private into: HTMLElement | null = null;
  private text = "";
  private complete = false;
  private cuts: number[] = [];
  private paced = 0;
  private drawn = -1;
  private edge = 0;
  private letters = 0;
  private pieces: Piece[] = [];
  private frame = 0;
  private last = 0;
  /** The edge starts after what is drawn next (skip). */
  private skipping = false;

  private draw: Draw;

  constructor(draw: Draw) {
    this.draw = draw;
  }

  /** The text so far; `complete` once the answer is done. */
  update(text: string, complete = false) {
    if (text === this.text && complete === this.complete) return;
    this.text = text;
    this.complete = complete;
    this.cuts = cutPoints(text, complete);
    if (this.paced > text.length) this.paced = text.length;
    this.wake();
  }

  /** Shows what arrived so far at once (an answer found already under way). */
  skip() {
    this.paced = this.text.length;
    this.edge = Number.POSITIVE_INFINITY;
    this.skipping = true;
    this.drawn = -1;
    this.wake();
  }

  /** Draws into `into` from now on (the log was drawn again), as far as it got. */
  mount(into: HTMLElement, draw?: Draw) {
    this.into = into;
    if (draw) this.draw = draw;
    this.drawn = -1;
    this.step(0);
    this.wake();
  }

  /** Something that arrived is not uncovered yet (a formula still waiting counts). */
  get behind(): boolean {
    return this.frame !== 0 || this.drawn < this.text.length || this.edge < this.letters + EDGE;
  }

  /** The element it draws into. */
  get target(): HTMLElement | null {
    return this.into;
  }

  /** Stops where it is (the chat left the screen). */
  stop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.into = null;
  }

  private wake() {
    if (this.frame || !this.into) return;
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.frame = 0;
    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (!this.into || !this.into.isConnected) return;
    if (this.step(dt)) this.frame = requestAnimationFrame(this.tick);
  };

  /** Moves on by `dt` seconds; false once there is nothing left to uncover. */
  private step(dt: number): boolean {
    const into = this.into!;
    const arrived = this.text.length;
    this.paced = Math.min(arrived, this.paced + Math.max(MIN_PACE, (arrived - this.paced) / LAG) * dt);
    const end = lastCut(this.cuts, Math.min(arrived, this.paced + AHEAD));
    if (end !== this.drawn) {
      this.drawn = end;
      // Drawn over what it shows, not into an emptied box: a node the draw
      // keeps stays where it is, its CSS animations running on (the dots of
      // a card still being written).
      this.draw(into, this.text.slice(0, end));
      this.lay(into);
      if (this.skipping) {
        this.skipping = false;
        this.edge = this.letters + EDGE;
      }
    }
    const target = this.letters;
    if (this.edge < target + EDGE) {
      this.edge = Math.min(target + EDGE, this.edge + Math.max(EDGE_PACE, (target - this.edge) / EDGE_LAG) * dt);
    }
    this.paint();
    const caughtUp = this.paced >= arrived && end === lastCut(this.cuts, arrived) && this.edge >= target + EDGE;
    if (!caughtUp) return true;
    // Done: drawn once more, plainly, without the spans.
    if (this.complete && end === arrived) {
      this.draw(into, this.text);
      this.pieces = [];
    }
    return false;
  }

  /** Counts the letters, and wraps those the edge has not passed yet. */
  private lay(into: HTMLElement) {
    const from = Math.floor(this.edge) - EDGE;
    const pieces: Piece[] = [];
    let count = 0;
    const walk = (node: Node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) {
          const data = (child as Text).data;
          // Counted by character, as the loop below counts them: an emoji is
          // two UTF-16 units but one letter, and the edge must not skip.
          const letters = [...data.replace(/\s+/g, "")].length;
          if (count + letters <= from || letters === 0) {
            count += letters;
            continue;
          }
          const frag = document.createDocumentFragment();
          for (const part of data.split(/(\s+)/)) {
            if (!part) continue;
            if (/^\s+$/.test(part)) {
              frag.append(part);
              continue;
            }
            for (const ch of part) {
              if (count < from) {
                frag.append(ch);
              } else {
                const s = document.createElement("span");
                s.textContent = ch;
                s.style.opacity = "0";
                laid.add(s);
                frag.append(s);
                pieces.push({ el: s, at: count, kind: "letter", weight: 1 });
              }
              count++;
            }
          }
          child.replaceWith(frag);
          continue;
        }
        if (child.nodeType !== 1) continue;
        const el = child as Element;
        if (laid.has(el)) {
          // A letter laid in an earlier draw: past the edge it shows, otherwise the edge paints it again.
          if (count < from) (el as HTMLElement).style.opacity = "";
          else pieces.push({ el, at: count, kind: "letter", weight: 1 });
          count++;
          continue;
        }
        const tag = el.tagName.toLowerCase();
        if (tag === "button" || tag === "svg") continue;
        if (tag === "math" || el.classList.contains("md-math") || el.classList.contains("md-code")) {
          const display = el.classList.contains("md-math");
          const weight = el.classList.contains("md-code") ? Math.max(1, (el.textContent ?? "").length) : display ? DISPLAY_WEIGHT : INLINE_WEIGHT;
          const swept = display ? el.querySelector("math") ?? el : el;
          if (count + weight > from) pieces.push({ el: swept, at: count, kind: "sweep", weight });
          else Ink.clear(swept);
          count += weight;
          continue;
        }
        if (el.classList.contains("md-pre")) {
          if (count + 6 > from) pieces.push({ el, at: count, kind: "box", weight: 6 });
          else (el as HTMLElement).style.opacity = "";
        }
        walk(el);
      }
    };
    walk(into);
    this.letters = count;
    this.pieces = pieces;
  }

  /** What paint left on a node the edge is now past (a node kept from an earlier draw). */
  private static clear(el: Element) {
    const style = (el as HTMLElement).style;
    style.removeProperty("-webkit-mask-image");
    style.removeProperty("mask-image");
  }

  private paint() {
    const edge = this.edge;
    let gone = 0;
    for (const p of this.pieces) {
      const style = (p.el as HTMLElement).style;
      if (p.kind === "letter") {
        const k = clamp((edge - p.at) / EDGE);
        style.opacity = k >= 1 ? "" : String(k);
        if (k >= 1) gone++;
      } else if (p.kind === "box") {
        const k = clamp((edge - p.at) / p.weight);
        style.opacity = k >= 1 ? "" : String(k);
      } else {
        // The edge sweeps across a formula or a code chip, left to right.
        const k = clamp((edge - p.at) / p.weight);
        const e = k * 140 - 40;
        const mask = k >= 1 ? "" : `linear-gradient(90deg, #000 ${e}%, transparent ${e + 40}%)`;
        style.setProperty("-webkit-mask-image", mask);
        style.setProperty("mask-image", mask);
      }
    }
    // The letters already uncovered need no more care.
    if (gone > 64) this.pieces = this.pieces.filter((p) => p.kind !== "letter" || (p.el as HTMLElement).style.opacity !== "");
  }
}
