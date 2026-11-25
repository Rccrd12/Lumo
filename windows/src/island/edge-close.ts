// The island going into the edge of the screen nearest to it (island.rs
// hide_edge), and coming back out of it. Its two ends close toward each other
// and toward that edge together: each goes in a straight line to one point
// just past the edge, both at once, so they meet as they reach it and the
// island is gone the moment it is one. Coming back, they open from that point
// to where the island is. Nothing is left on the edge. The window reaches that
// edge (island.rs frame), so the page draws all of it.

import { clamp, lerp } from "../core/anim";
import { NOTCH_H, type Dock } from "../core/layout";

type Rect = { x: number; y: number; w: number; h: number };

/** Smooth at both ends: no jolt as it starts, none as it arrives (smootherstep). */
export function smoother(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/** The shortest and the longest close (or opening), in seconds: longer the farther the edge. */
export const CLOSE_MIN_S = 0.5;
export const CLOSE_MAX_S = 0.85;
/** Page pixels the close goes a second faster for, past the shortest. */
const CLOSE_PX_PER_S = 2400;

/** Where the ends meet: the island's middle carried straight onto `edge` of a `vw` × `vh` window. */
export function meetPoint(r: Rect, edge: Dock, vw: number, vh: number): { x: number; y: number } {
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  switch (edge) {
    case "top": return { x: cx, y: 0 };
    case "bottom": return { x: cx, y: vh };
    case "left": return { x: 0, y: cy };
    case "right": return { x: vw, y: cy };
  }
}

/** How long the island takes to close into `edge` (or to open from it), in seconds. */
export function closeDuration(r: Rect, edge: Dock, vw: number, vh: number): number {
  const m = meetPoint(r, edge, vw, vh);
  const far = Math.hypot(r.x + r.w / 2 - m.x, r.y + r.h / 2 - m.y);
  return clamp(CLOSE_MIN_S + (Number.isFinite(far) ? far : 0) / CLOSE_PX_PER_S, CLOSE_MIN_S, CLOSE_MAX_S);
}

/**
 * The island `s` of the way closed into `edge` (0: as it is, 1: its ends met
 * just past the edge), with its corner radius. Each side of it goes in a
 * straight line to a little round, as thick as the closed island at most,
 * standing just past the edge at the meeting point.
 */
export function closingRect(r: Rect, radius: number, edge: Dock, vw: number, vh: number, s: number): { rect: Rect; radius: number } {
  const k = clamp(s, 0, 1);
  const d = Math.max(0, Math.min(r.w, r.h, NOTCH_H));
  const m = meetPoint(r, edge, vw, vh);
  const end: Rect =
    edge === "top" ? { x: m.x - d / 2, y: -d, w: d, h: d }
    : edge === "bottom" ? { x: m.x - d / 2, y: vh, w: d, h: d }
    : edge === "left" ? { x: -d, y: m.y - d / 2, w: d, h: d }
    : { x: vw, y: m.y - d / 2, w: d, h: d };
  const left = lerp(r.x, end.x, k);
  const top = lerp(r.y, end.y, k);
  const right = lerp(r.x + r.w, end.x + end.w, k);
  const bottom = lerp(r.y + r.h, end.y + end.h, k);
  return { rect: { x: left, y: top, w: right - left, h: bottom - top }, radius: lerp(radius, d / 2, k) };
}

/** What is inside the island (Lumo's eyes, what it says) fades out over the last part of the close. */
export function closingFade(s: number): number {
  return clamp((1 - s) / 0.35, 0, 1);
}

/** How far closed the island is, eased over time: 0 open, 1 gone into its edge. */
export class EdgeClose {
  private v = 0;
  private from = 0;
  private to = 0;
  private start = 0;
  private ms = 0;

  get value(): number {
    return this.v;
  }

  /** Closing or opening. */
  get active(): boolean {
    return this.v !== this.to;
  }

  /** Closes over `seconds` from `now` (performance.now() ms), from wherever it is. */
  close(now: number, seconds: number) {
    this.go(1, now, seconds);
  }

  /** Opens over `seconds` from `now`, from wherever it is. */
  open(now: number, seconds: number) {
    this.go(0, now, seconds);
  }

  /** The value at `now` (performance.now() ms). */
  tick(now: number) {
    if (!this.active) return;
    const t = this.ms > 0 ? (now - this.start) / this.ms : 1;
    this.v = t >= 1 ? this.to : lerp(this.from, this.to, smoother(t));
  }

  private go(to: number, now: number, seconds: number) {
    this.from = this.v;
    this.to = to;
    this.start = now;
    // Turned back half-way, only the way left to go.
    this.ms = Math.max(0, seconds) * 1000 * Math.abs(to - this.v);
    if (this.ms === 0) this.v = to;
  }
}
