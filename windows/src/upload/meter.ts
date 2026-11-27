// The upload bar follows the real copy into the inbox: the bytes files.rs
// says have landed (`ingest-progress`), every file's and all of them
// together. It never runs ahead of them, nor ahead of a short minimum fill,
// so a small file's bar does not just flash; the ✓ comes once every copy has
// landed.

import { uploadProgressCurve } from "./sequence";

/** Seconds the bar takes at the least, for a file copied at once. */
export const MIN_FILL = 0.8;
/** Seconds: how softly the bar catches up with the bytes, which come in steps. */
const EASE = 0.12;

/** One file of the drop, as far as its copy is. */
export interface CopyPart {
  /** The path it was dropped from: the copy's progress names it. */
  source: string;
  name: string;
  done: number;
  /** Its size, once the copy said it. */
  total: number | null;
  /** In the inbox: its copy finished. */
  landed: boolean;
}

/** How far one copy is: 1 only once it landed. */
export function partFraction(part: CopyPart): number {
  if (part.landed) return 1;
  if (!part.total) return 0;
  return Math.max(0, Math.min(0.99, part.done / part.total));
}

/** How far the drop is, by bytes: a big file counts for more than a small one. */
export function totalFraction(parts: readonly CopyPart[]): number {
  if (parts.length === 0) return 0;
  if (parts.every((p) => p.landed)) return 1;
  let done = 0;
  let all = 0;
  for (const part of parts) {
    const size = Math.max(1, part.total ?? 0);
    all += size;
    done += size * partFraction(part);
  }
  return Math.min(0.99, done / all);
}

/** Where the bar may be at most `since` seconds after it starts. */
export function fillFloor(since: number): number {
  return since <= 0 ? 0 : uploadProgressCurve(Math.min(1, since / MIN_FILL));
}

/** One step of an eased value toward `target`; it reaches 1 only when the target is 1. */
export function ease(value: number, target: number, dt: number): number {
  const next = value + (target - value) * (1 - Math.exp(-Math.max(0, dt) / EASE));
  return target >= 1 && next > 0.995 ? 1 : next;
}

/** The files of one drop and what their bars show. */
export class UploadMeter {
  parts: CopyPart[];
  private easedAll = 0;
  private eased: number[];
  private shownAll = 0;
  private shown: number[];

  constructor(files: readonly { name: string; source: string }[]) {
    this.parts = files.map((f) => ({ source: f.source, name: f.name, done: 0, total: null, landed: false }));
    this.eased = this.parts.map(() => 0);
    this.shown = this.parts.map(() => 0);
  }

  get names(): string[] {
    return this.parts.map((p) => p.name);
  }

  /** A copy said how far it is. */
  progress(source: string, done: number, total: number) {
    for (const part of this.parts) {
      if (part.source !== source || part.landed) continue;
      part.total = total;
      part.done = Math.max(part.done, done);
    }
  }

  /** A copy is in the inbox. */
  land(source: string) {
    for (const part of this.parts) if (part.source === source) part.landed = true;
  }

  /** A copy failed: its file leaves the bar, the others carry on. */
  remove(source: string) {
    const keep = this.parts.map((p) => p.source !== source);
    this.parts = this.parts.filter((_, i) => keep[i]);
    this.eased = this.eased.filter((_, i) => keep[i]);
    this.shown = this.shown.filter((_, i) => keep[i]);
  }

  /**
   * The bars `since` seconds after they started (negative before), `dt`
   * seconds after the last step: the whole drop's and each file's. Never
   * back, never ahead of the bytes or of the minimum fill.
   */
  step(since: number, dt: number): { total: number; each: number[] } {
    const floor = fillFloor(since);
    this.easedAll = ease(this.easedAll, totalFraction(this.parts), dt);
    this.shownAll = Math.max(this.shownAll, Math.min(floor, this.easedAll));
    this.parts.forEach((part, i) => {
      this.eased[i] = ease(this.eased[i], partFraction(part), dt);
      this.shown[i] = Math.max(this.shown[i], Math.min(floor, this.eased[i]));
    });
    return { total: this.shownAll, each: [...this.shown] };
  }
}
