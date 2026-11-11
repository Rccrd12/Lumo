// The island let go after a move (island.rs drag): Rust springs the window to
// its place on the edge, and the page re-anchors the island in its new panel
// (another edge, another shift). Re-anchored at once, the island would jump
// inside a window that has not moved yet, then jump back once it has: what
// made every drop go by a jerk. So the island is drawn, at first, exactly
// where it was, and eased to its new anchor with the same spring as the
// window (island.rs BOUNCE_RESPONSE, BOUNCE_DAMPING), started at the same
// moment (island.rs DOCK_LEAD): window and island together move it as one
// spring would, from where it was let go to its place.

import { Spring } from "../core/anim";

/** The window's spring in island.rs: its period (s) and damping ratio. */
export const DOCK_RESPONSE = 0.36;
export const DOCK_DAMPING = 0.75;

type Point = { x: number; y: number };

/** How far (page pixels) the island is drawn off its anchor while it settles. */
export class DockEase {
  private x = new Spring(0, DOCK_RESPONSE, DOCK_DAMPING);
  private y = new Spring(0, DOCK_RESPONSE, DOCK_DAMPING);
  private on = false;
  /** When the spring starts, and the time it was last moved to (performance.now() ms). */
  private startAt = 0;
  private last = 0;

  /** Added to the island's anchored place. */
  get offset(): Point {
    return { x: this.x.value, y: this.y.value };
  }

  /** Still easing (or about to): the frame loop keeps running. */
  get active(): boolean {
    return this.on;
  }

  /**
   * Re-anchored: `drawn` is where the island was drawn the frame before
   * (offset included), `anchored` its new place. It stays where it was drawn
   * until `startAt` (performance.now() ms; the window's spring starts then
   * too), and eases from there. Heard later than that (`now`), it eases from
   * now: a little out of step with the window, but never a jump.
   */
  start(drawn: Point, anchored: Point, startAt: number, now: number) {
    this.x.velocity = 0;
    this.y.velocity = 0;
    this.startAt = Math.max(Number.isFinite(startAt) ? startAt : 0, Number.isFinite(now) ? now : 0);
    this.last = this.startAt;
    this.from(drawn.x - anchored.x, drawn.y - anchored.y);
  }

  /**
   * The anchor moved by itself (the window was resized from its top-left
   * corner: a bottom or side anchor goes with the size): the offset takes the
   * move back, so the island stays where it is on screen. Not easing yet,
   * it eases from `now` (performance.now() ms).
   */
  keepPlace(before: Point, after: Point, now: number) {
    this.wake(now);
    this.from(this.x.value + before.x - after.x, this.y.value + before.y - after.y);
  }

  /** Picked up again: it stays where it is drawn, the window carries it. */
  hold() {
    this.x.target = this.x.value;
    this.y.target = this.y.value;
    this.x.velocity = 0;
    this.y.velocity = 0;
    this.on = false;
  }

  /** A move that never said where it went (island.ts settleMove): back to its anchor. */
  resume(now: number) {
    this.wake(now);
    this.from(this.x.value, this.y.value);
  }

  /** The frame at `now` (performance.now() ms): the spring as far as that moment. */
  tick(now: number) {
    if (!this.on || now <= this.startAt) return;
    const dt = Math.min(1, Math.max(0, (now - Math.max(this.last, this.startAt)) / 1000));
    this.last = now;
    this.x.step(dt);
    this.y.step(dt);
    if (this.x.settled && this.y.settled) {
      this.x.set(0);
      this.y.set(0);
      this.on = false;
    }
  }

  /** Not easing: the spring starts at `now`, not at the last start. */
  private wake(now: number) {
    if (this.on || !Number.isFinite(now)) return;
    this.startAt = now;
    this.last = now;
  }

  private from(x: number, y: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.x.value = x;
    this.y.value = y;
    this.x.target = 0;
    this.y.target = 0;
    this.on = Math.abs(x) > 0.01 || Math.abs(y) > 0.01 || !this.x.settled || !this.y.settled;
    if (!this.on) {
      this.x.set(0);
      this.y.set(0);
    }
  }
}
