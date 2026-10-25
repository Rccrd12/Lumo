// Overview task ticker.
//
// The session's steps, one a line, the newest at the bottom: as many lines as
// the card has room for, the older ones dimmer. While they fit, a new step
// takes the next line; once the card is full, every line scrolls up by one.
// Every row position is recomputed from a single clock in `tick()`, driven by
// the island's frame loop — no CSS transitions and no timers. Chaining CSS
// transitions with a reset timer let two rows land on the same line when steps
// arrived in bursts, and any step that arrived mid-animation was dropped
// outright. Steps are queued instead, so a burst scrolls past rather than
// vanishing.
//
// Diff steps (see core/diff.ts) render as the file name followed by +N −M, and
// a click on one opens its diff; a click on any other step opens the list of
// steps (views/steps.ts). After Stop the card holds Claude's final message: no
// shimmer, no chevron, the ✓ on every row.

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { cubicBezier, clamp, lerp } from "../core/anim";
import { parseDiffStep, type DiffStep } from "../core/diff";
import type { AgentTask } from "../core/state";

const ROW_H = 22;
/** One step transition, milliseconds. */
const DURATION = 380;
/** Beyond this many queued steps we stop trying to show them all. */
const MAX_QUEUE = 4;
/** The lines a card shows at the least (the ticker it always had) and at the most. */
const MIN_LINES = 2;
const MAX_LINES = 20; // every step the session keeps (core/state.ts)
const COMPLETED_SCALE = 11.5 / 13; // 0.885 — the completed font size
const EASE = cubicBezier(0.4, 0, 0.2, 1);

/** The current row's text once the turn is over (TickerRowView staticColor). */
const STILL_CURRENT = "#c9cdd4";
const DIM = "#80858e";

/** What a click on a row hands over: the step's place in the session, and its diff. */
export interface TickerTap {
  seq: number;
  diffId: number | null;
}

interface Entry {
  text: string;
  /** Position of the step in the whole session (AgentTask.stepSeq). */
  seq: number;
}

interface Row {
  el: HTMLElement;
  chevron: SVGElement;
  check: SVGElement;
  body: HTMLElement;
  shimmer: HTMLElement;
  dim: HTMLElement;
  /** +N −M, attached to the row only while it shows a diff. */
  counts: HTMLElement;
  plus: HTMLElement;
  minus: HTMLElement;
  text: string;
  seq: number;
  /** Set when the row shows a file diff. */
  diff: DiffStep | null;
}

function makeRow(): Row {
  const chevron = svg(ICONS.chevronRight, 9, { stroke: 2.4 });
  const check = svg(ICONS.check, 8, { stroke: 2.2 });
  check.style.color = "#454850"; // the completed tick is dimmer than the chevron
  check.style.position = "absolute";
  chevron.style.position = "absolute";
  const shimmer = h("span", { class: "tick-text shimmer" });
  const dim = h("span", {
    class: "tick-text",
    // top:0 is where a one-line row already put it; it also keeps a text wider
    // than the row on that line instead of dropping it below the row.
    style: `position:absolute;top:0;left:0;right:0;color:${DIM}`,
  });
  const body = h("span", { style: "position:relative;flex:1 1 auto;min-width:0" }, shimmer, dim);
  const plus = h("span", { class: "plus" });
  const minus = h("span", { class: "minus" });
  const counts = h("span", { class: "tick-count" }, plus, minus);
  const el = h(
    "div",
    { class: "ticker-row" },
    h("span", { class: "tick-icon", style: "position:relative" }, chevron, check),
    body,
  );
  return { el, chevron, check, body, shimmer, dim, counts, plus, minus, text: "", seq: -1, diff: null };
}

function setEntry(row: Row, entry: Entry | null) {
  row.seq = entry?.seq ?? -1;
  row.el.classList.toggle("empty", entry == null);
  const text = entry?.text ?? "";
  if (row.text === text) return;
  row.text = text;
  const diff = parseDiffStep(text);
  row.diff = diff;
  const shown = diff ? diff.filename : text;
  row.shimmer.textContent = shown;
  row.dim.textContent = shown;
  if (diff) {
    // Filename, then the counts right after it; the name truncates first.
    row.body.style.flex = "0 1 auto";
    row.plus.textContent = diff.added > 0 ? ` +${diff.added}` : "";
    row.minus.textContent = diff.removed > 0 ? ` −${diff.removed}` : "";
    if (row.counts.parentNode !== row.el) row.el.append(row.counts);
    row.el.classList.add("diff");
  } else if (row.el.classList.contains("diff")) {
    // Back to an ordinary step: exactly the row it always was.
    row.body.style.flex = "1 1 auto";
    row.counts.remove();
    row.el.classList.remove("diff");
  }
}

function entryOf(row: Row): Entry | null {
  return row.seq < 0 ? null : { text: row.text, seq: row.seq };
}

/** How far an older step fades: the one just done stays clear, the oldest are faint. */
function ageOpacity(age: number): number {
  return age <= 1 ? 1 : clamp(1 - (age - 1) * 0.09, 0.35, 1);
}

/**
 * Places a row. `phase` 0 = current (shimmering, full size), 1 = completed
 * (dim, shifted left and scaled down), with a crossfade between the two.
 * `still` is the finished look: static text, ✓ only, nothing animating.
 */
function place(row: Row, y: number, phase: number, opacity: number, still: boolean) {
  const scale = 1 - phase * (1 - COMPLETED_SCALE);
  row.el.style.transform = `translate(${-phase * 10}px, ${y}px) scale(${scale})`;
  // Scaled down, a row still reaches the right edge: its text is not cut sooner.
  row.el.style.width = `${100 / scale}%`;
  row.el.style.opacity = String(opacity);
  if (still) {
    row.chevron.style.opacity = "0";
    row.check.style.opacity = "1";
    row.shimmer.style.opacity = "0";
    row.dim.style.opacity = "1";
    row.dim.style.color = phase < 0.5 ? STILL_CURRENT : DIM;
  } else {
    row.chevron.style.opacity = String(clamp(1 - phase * 2, 0, 1));
    row.check.style.opacity = String(clamp(phase * 2 - 1, 0, 1));
    row.shimmer.style.opacity = String(clamp(1 - phase * 1.6, 0, 1));
    row.dim.style.opacity = String(clamp(phase * 2 - 0.4, 0, 1));
    row.dim.style.color = DIM;
  }
  // An invisible shimmer must not keep the webview repainting.
  row.shimmer.style.animationPlayState = still || phase >= 1 ? "paused" : "";
}

export class Ticker {
  readonly el: HTMLElement;
  /** One row a line, top to bottom, and one more for the step coming in. */
  private rows: Row[] = [];
  /** How many lines the card has room for. */
  private lines = MIN_LINES;
  /** How many of them hold a step; the last of those is the current one. */
  private shown = 0;
  private queue: Entry[] = [];
  private startMs: number | null = null;
  private displayIndex = -1;
  /** The steps last synced, to lay them out again when the room changes. */
  private recent: Entry[] = [];
  /** True once Claude has finished: the final message holds still. */
  private still = false;

  /** `onTap` receives the step of a clicked row. */
  constructor(private readonly onTap?: (tap: TickerTap) => void) {
    this.el = h("div", { class: "ticker" });
    this.build();
    // The room only changes when the island does: nothing runs in between.
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => this.fit()).observe(this.el);
    }
  }

  private build() {
    for (const row of this.rows) row.el.remove();
    this.rows = Array.from({ length: this.lines + 1 }, () => makeRow());
    this.rows.forEach((row, i) => {
      this.el.append(row.el);
      // The row coming in is only ever seen mid-slide.
      if (i === this.lines) return;
      row.el.addEventListener("click", () => {
        if (row.seq < 0 || !this.onTap) return;
        this.onTap({ seq: row.seq, diffId: row.diff?.diffId ?? null });
      });
    });
  }

  /** Lays the card's room out again: as many lines as its height holds. */
  private fit() {
    const height = this.el.clientHeight;
    if (height <= 0) return;
    const lines = clamp(Math.floor(height / ROW_H), MIN_LINES, MAX_LINES);
    if (lines === this.lines) return;
    this.lines = lines;
    this.build();
    this.layout(this.recent);
  }

  /** Puts the newest steps straight into place, no scrolling. */
  private layout(entries: Entry[]) {
    this.queue = [];
    this.startMs = null;
    const visible = entries.slice(-this.lines);
    this.shown = visible.length;
    this.rows.forEach((row, i) => setEntry(row, visible[i] ?? null));
    if (this.shown === 0) {
      // Nothing yet: the current line waits with an ellipsis.
      setEntry(this.rows[0], { text: "…", seq: -1 });
      this.shown = 1;
    }
    this.rest();
  }

  /** The state between transitions: the steps one a line, the newest last. */
  private rest() {
    const current = this.shown - 1;
    this.rows.forEach((row, i) => {
      if (i > current) {
        place(row, i * ROW_H, 0, 0, this.still);
        return;
      }
      const age = current - i;
      place(row, i * ROW_H, age === 0 ? 0 : 1, ageOpacity(age), this.still);
    });
  }

  get animating(): boolean {
    return this.startMs != null || this.queue.length > 0;
  }

  sync(task: AgentTask | null) {
    const steps = task?.steps ?? [];
    // Where the newest step sits in the whole session, not in `steps`: that
    // list is capped at 20, and counting inside it made the ticker stop for
    // good at the twentieth step of a session.
    const newest = steps.length === 0 ? -1 : (task?.stepSeq ?? steps.length - 1);
    const entries = steps.map((text, i) => ({ text, seq: newest - (steps.length - 1 - i) }));
    this.recent = entries;

    const still = !!task?.finalLine;
    if (still !== this.still) {
      this.still = still;
      // Mid-slide, the next frame places every row with the new look anyway.
      if (this.startMs == null) this.rest();
    }

    // First render, or the session restarted (steps were cleared): drop
    // straight into place rather than scroll.
    if (this.displayIndex < 0 || newest < this.displayIndex) {
      this.displayIndex = newest;
      this.layout(entries);
      return;
    }

    const fresh = Math.min(newest - this.displayIndex, entries.length);
    if (fresh > 0) this.queue.push(...entries.slice(-fresh));
    this.displayIndex = newest;
    if (this.queue.length > MAX_QUEUE) {
      this.queue = this.queue.slice(-MAX_QUEUE);
    }
  }

  /** Called every frame by the island while the overview is on screen. */
  tick(nowMs: number) {
    // The waiting ellipsis is replaced, not scrolled past.
    if (this.startMs == null && this.queue.length > 0 && this.shown === 1 && this.rows[0].seq < 0) {
      setEntry(this.rows[0], this.queue.shift()!);
      this.rest();
    }
    const full = this.shown >= this.lines;
    const incoming = this.rows[full ? this.lines : this.shown];
    if (this.startMs == null) {
      if (this.queue.length === 0) return;
      setEntry(incoming, this.queue[0]);
      this.startMs = nowMs;
    }

    const p = clamp((nowMs - this.startMs) / DURATION, 0, 1);
    const e = EASE(p);
    const current = this.shown - 1;

    if (full) {
      // Every line moves up by one; the top one leaves, fading a little faster than it moves.
      for (let i = 0; i <= current; i++) {
        const age = current - i;
        const opacity = i === 0 ? clamp(1 - p * 1.35, 0, 1) * ageOpacity(age) : ageOpacity(age + e);
        place(this.rows[i], lerp(i, i - 1, e) * ROW_H, age === 0 ? e : 1, opacity, this.still);
      }
      place(incoming, lerp(this.lines, this.lines - 1, e) * ROW_H, 0, e, this.still);
    } else {
      // There is room: the new step takes the next line.
      for (let i = 0; i <= current; i++) {
        const age = current - i;
        place(this.rows[i], i * ROW_H, age === 0 ? e : 1, ageOpacity(age + e), this.still);
      }
      place(incoming, lerp(this.shown + 0.4, this.shown, e) * ROW_H, 0, e, this.still);
    }

    if (p < 1) return;

    // Commit. Texts move, elements stay put — no reordering, no overlap.
    if (full) {
      for (let i = 0; i < this.lines; i++) setEntry(this.rows[i], entryOf(this.rows[i + 1]));
      setEntry(this.rows[this.lines], null);
    } else {
      this.shown++;
    }
    this.queue.shift();
    this.startMs = null;
    this.rest();
  }
}
