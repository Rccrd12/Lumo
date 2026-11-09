// Island open/close FSM.
// No DOM, no Tauri: it only reports transitions.

export type FsmState = "hidden" | "petit" | "home" | "greeting";

/**
 * What the open island is doing that a mouse leave should respect: nothing,
 * something it may wait for (`linger`: the chat's field has the cursor, the
 * drop menu is open), or something it waits for however long it takes (`keep`:
 * a message is being written).
 */
export type LeaveHold = "none" | "linger" | "keep";

export class IslandStateMachine {
  state: FsmState = "hidden";

  onTransition: ((from: FsmState, to: FsmState) => void) | null = null;

  /**
   * home → petit delay, seconds: the auto-close preference. Changing it while a
   * countdown runs starts that countdown again with the new delay, so an edit in
   * Settings applies at once.
   */
  get homeToPetitDelay(): number {
    return this.homeDelay;
  }
  set homeToPetitDelay(seconds: number) {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds === this.homeDelay) return;
    this.homeDelay = seconds;
    if (this.state === "home" && this.homeCollapse != null) this.scheduleHomeCollapse();
  }
  /** petit → hidden delay, seconds. */
  petitToHiddenDelay = 60;

  /**
   * The open island folds once the mouse has left it (after `homeToPetitDelay`).
   * Off when it only closes on a click elsewhere or never (Settings → Island).
   */
  get closeOnLeave(): boolean {
    return this.leaveCloses;
  }
  set closeOnLeave(on: boolean) {
    this.leaveCloses = on;
    if (!on) this.clear("homeCollapse");
  }

  /** The closed island goes away `petitToHiddenDelay` after the mouse left it. */
  get autoHide(): boolean {
    return this.hides;
  }
  set autoHide(on: boolean) {
    this.hides = on;
    if (!on) this.clear("petitHide");
  }
  /**
   * greeting → petit once the greeting animation ends. The mouse resting on the
   * island does not hold it open: the greeting always finishes on its own.
   */
  greetAutoCollapseDelay = 0.6;
  /** An alert waiting for an answer stays open, even when the mouse leaves. */
  pinned = false;

  /** With a `linger` hold, the mouse-leave countdown lasts at least this long (s). */
  lingerDelay = 10;
  /** Asked each time a mouse-leave countdown starts or ends (see LeaveHold). */
  leaveHold: (() => LeaveHold) | null = null;
  /** The hold the running (or held back) countdown was started with. */
  private lastHold: LeaveHold = "none";

  /**
   * A Gemini Live call is on: the compact island stays on screen (it does
   * not go away after a minute) until the call ends.
   */
  get held(): boolean {
    return this.holding;
  }
  set held(on: boolean) {
    if (on === this.holding) return;
    this.holding = on;
    if (on) this.clear("petitHide");
    else if (this.state === "petit" && !this.mouseInside) this.schedulePetitHide();
  }
  /**
   * Until when (performance.now() ms) the open island does not fold because
   * the mouse is elsewhere: a sharing shortcut opened it while the mouse is on
   * the text just selected, or an alert opened it on its own while the mouse
   * was somewhere else. The mouse coming onto the island ends it.
   */
  private graceUntil = 0;
  /** How long the running grace was given for (s), for the countdown bar. */
  private graceSpan = 0;
  /** A click elsewhere ends the running grace (a shortcut's, not an alert's). */
  private graceClick = true;

  /**
   * The open island stays open `seconds` with the mouse elsewhere (see
   * graceUntil). `clickCloses`: a click elsewhere closes it meanwhile, in any
   * close mode — how the user says they are done with what a shortcut opened.
   * An alert that opened on its own is not closed by a click meant for
   * something else.
   */
  holdOpen(seconds: number, clickCloses = true) {
    this.graceUntil = performance.now() + seconds * 1000;
    this.graceSpan = seconds;
    this.graceClick = clickCloses;
    if (this.homeCollapse != null) this.scheduleHomeCollapse();
  }

  /** The grace of holdOpen is still running. */
  get inGrace(): boolean {
    return performance.now() < this.graceUntil;
  }

  /** The running grace is one a click elsewhere ends. */
  get clickEndsGrace(): boolean {
    return this.inGrace && this.graceClick;
  }

  /** The mouse is on the island, as the last enter/leave said. */
  private mouseInside = false;
  private holding = false;

  /**
   * When the open island will fold, on the performance.now() clock, while the
   * mouse-leave countdown runs; null otherwise. The island draws its countdown
   * bar from it.
   */
  homeCollapseDueAt: number | null = null;
  /**
   * How long the running countdown lasts (s) when a grace made it longer than
   * the auto-close delay; null otherwise. The countdown bar is drawn over it.
   */
  homeCollapseSpan: number | null = null;

  private homeDelay = 15;
  private leaveCloses = true;
  private hides = true;
  private petitHide: number | null = null;
  private homeCollapse: number | null = null;
  private greetCollapse: number | null = null;

  // ── Inputs ──────────────────────────────────────────────────────────────────

  launch() {
    this.cancelTimers();
    this.transition("greeting");
  }

  mouseEntered() {
    this.mouseInside = true;
    this.graceUntil = 0;
    switch (this.state) {
      case "hidden":
        this.cancelTimers();
        this.transition("petit");
        break;
      case "petit":
        this.clear("petitHide");
        break;
      case "home":
        this.clear("homeCollapse");
        break;
      case "greeting":
        break;
    }
  }

  mouseLeft() {
    this.mouseInside = false;
    switch (this.state) {
      case "hidden":
        break;
      case "petit":
        this.schedulePetitHide();
        break;
      case "home":
        this.scheduleHomeCollapse();
        break;
      case "greeting":
        this.clear("greetCollapse");
        this.transition("petit");
        break;
    }
  }

  /**
   * The hold may have changed (a key typed, the field left, a menu opened or
   * closed): the countdown of an island the mouse has left starts again with
   * it. Typing keeps the hold as it is, so a keystroke never restarts it.
   */
  holdChanged() {
    if (this.state !== "home" || this.mouseInside) return;
    if (this.currentHold() === this.lastHold) return;
    this.scheduleHomeCollapse();
  }

  click() {
    if (this.state !== "petit") return;
    this.cancelTimers();
    this.transition("home");
  }

  /** Greeting animation finished (T.end). */
  greetComplete() {
    if (this.state !== "greeting") return;
    if (this.greetCollapse == null) this.scheduleGreetCollapse(this.greetAutoCollapseDelay);
  }

  /** Non-alert work event: show compact from hidden. */
  reveal() {
    if (this.state !== "hidden") return;
    this.cancelTimers();
    this.transition("petit");
    this.schedulePetitHide();
  }

  /** Alert or explicit request: open straight to expanded. */
  forceHome() {
    this.cancelTimers();
    this.transition("home");
  }

  /// Explicit close (OK button, Escape, an alert being answered).
  forcePetit() {
    this.cancelTimers();
    this.transition("petit");
  }

  forceHidden() {
    this.cancelTimers();
    this.transition("hidden");
  }

  // ── Timers ──────────────────────────────────────────────────────────────────

  private schedulePetitHide() {
    this.clear("petitHide");
    // A card folded away while it waits for an answer keeps the compact island
    // on screen, so it can be reopened.
    if (this.pinned || !this.hides || this.holding) return;
    this.petitHide = window.setTimeout(() => {
      this.petitHide = null;
      if (this.state === "petit" && !this.pinned) this.transition("hidden");
    }, this.petitToHiddenDelay * 1000);
  }

  private scheduleHomeCollapse() {
    this.clear("homeCollapse");
    const hold = this.currentHold();
    this.lastHold = hold;
    if (this.pinned || !this.leaveCloses || hold === "keep") return;
    const floor = hold === "linger" ? this.lingerDelay : 0;
    const base = Math.max(this.homeDelay * 1000, floor * 1000);
    const graceLeft = this.graceUntil - performance.now();
    const ms = Math.max(base, graceLeft);
    this.homeCollapseDueAt = performance.now() + ms;
    this.homeCollapseSpan = graceLeft > base ? this.graceSpan : null;
    this.homeCollapse = window.setTimeout(() => {
      this.homeCollapse = null;
      this.homeCollapseDueAt = null;
      this.homeCollapseSpan = null;
      // An alert pinned while the countdown ran keeps the island open, and so
      // does a message being written that no event told us about.
      if (this.state !== "home" || this.pinned) return;
      if (this.currentHold() === "keep") {
        this.lastHold = "keep";
        return;
      }
      this.transition("petit");
    }, ms);
  }

  private currentHold(): LeaveHold {
    return this.leaveHold?.() ?? "none";
  }

  private scheduleGreetCollapse(delay: number) {
    this.clear("greetCollapse");
    this.greetCollapse = window.setTimeout(() => {
      this.greetCollapse = null;
      if (this.state === "greeting") this.transition("petit");
    }, delay * 1000);
  }

  private clear(which: "petitHide" | "homeCollapse" | "greetCollapse") {
    const id = this[which];
    if (id != null) window.clearTimeout(id);
    this[which] = null;
    if (which === "homeCollapse") {
      this.homeCollapseDueAt = null;
      this.homeCollapseSpan = null;
    }
  }

  cancelTimers() {
    this.clear("petitHide");
    this.clear("homeCollapse");
    this.clear("greetCollapse");
  }

  private transition(next: FsmState) {
    if (next === this.state) return;
    const from = this.state;
    this.state = next;
    this.onTransition?.(from, next);
  }
}
