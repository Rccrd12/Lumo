// The Plan island: a third island, right of the main one, with the plan an
// agent follows step by step. Shut and out of reach until an agent makes a
// plan (core/agent-plan.ts reads it off the hooks): then it opens with it,
// and its steps move on as the agent works. Like the live activities it can
// be moved (by its top bar) and resized (its grips), and its "–" folds it
// into an icon in the island's top bar, left of the plan usage pills, which
// brings it back. A plan done stays a moment, then the island shuts again.
//
// It lives in a window of its own (plan.html, plan_island.rs), shown on its
// own whether the island is open or not, which only draws: this page holds
// the plans, sends the window the one to show and hears its clicks. Nothing
// runs while there is no plan, and nothing ticks while there is one.

import { Bridge, IS_TAURI, emitToWindow, onEvent } from "../core/bridge";
import { PlanBook, planFinished, planKey, readPlanUpdate, type AgentPlan, type PlanOwner } from "../core/agent-plan";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { language } from "../i18n/i18n";
import type { PlanAction, PlanData } from "../views/plan-view";

/** How long a plan done stays on screen before the island shuts. */
const DONE_LINGER_MS = 8_000;

export interface IslandPlanHost {
  openSettings(): void;
  refreshAll(): void;
}

export class IslandPlan {
  readonly book = new PlanBook();
  /** Folded into its icon with the "–". */
  private folded = false;
  /** Its window is shown. */
  private shown = false;
  /** The next showing comes out of its corner (a plan just made, the icon clicked). */
  private fly = false;
  private sentKey = "";
  private doneTimer: number | null = null;
  private host: IslandPlanHost;

  constructor(host: IslandPlanHost) {
    this.host = host;
    void onEvent<PlanAction>("plan-action", (a) => this.act(a));
    // Its page (re)loaded: everything again.
    void onEvent<null>("plan-hello", () => {
      this.sentKey = "";
      this.send();
      if (this.shown) void emitToWindow("plan", "plan-appear", { fly: false });
    });
    State.subscribe(() => this.sync());
  }

  /** The plan on screen, or the one folded into the icon. */
  get current(): AgentPlan | null {
    return this.book.current();
  }

  /** A tool call of an agent's session: its plan, if it carries one, moves on. */
  onTool(owner: PlanOwner, tool: string, input: Record<string, unknown> | undefined) {
    const update = readPlanUpdate(tool, input);
    if (!update) return;
    const result = this.book.apply(owner, update);
    if (!result) return;
    if (result === "new" && this.book.current()?.key === planKey(owner.pillId, owner.sessionId)) {
      // A plan just made: the island opens with it, even folded before.
      this.folded = false;
      if (!this.shown) {
        this.fly = true;
        Sound.play("open");
      }
    }
    this.armDone();
    this.sync();
  }

  /** The session ended: its plan goes. */
  endSession(pillId: string, sessionId: string) {
    if (this.book.drop(planKey(pillId, sessionId))) this.changed();
  }

  /** Every session of the pill ended. */
  endPill(pillId: string) {
    if (this.book.dropPill(pillId)) this.changed();
  }

  /** The icon in the top bar was clicked: back it comes. */
  unfold() {
    if (!this.folded) return;
    this.folded = false;
    this.fly = true;
    Sound.play("open");
    this.changed();
  }

  private act(a: PlanAction) {
    switch (a.kind) {
      case "fold":
        this.folded = true;
        break;
      case "settings":
        this.host.openSettings();
        break;
      case "refresh":
        this.host.refreshAll();
        break;
    }
    this.changed();
  }

  private changed() {
    this.armDone();
    this.sync();
    State.notify();
  }

  /** A plan done on screen: it goes after a moment, and the next one under way shows. */
  private armDone() {
    if (this.doneTimer != null) window.clearTimeout(this.doneTimer);
    this.doneTimer = null;
    const plan = this.book.current();
    if (!plan || !planFinished(plan.steps)) return;
    this.doneTimer = window.setTimeout(() => {
      this.doneTimer = null;
      const now = this.book.get(plan.key);
      if (now && planFinished(now.steps) && now.updatedAt === plan.updatedAt) {
        this.book.drop(plan.key);
        this.changed();
      }
    }, DONE_LINGER_MS);
  }

  /** Its window shown or hidden as it should be, with the plan it shows. */
  sync() {
    const plan = this.book.current();
    const icon = plan != null && this.folded;
    if (State.planIcon !== icon) {
      State.planIcon = icon;
      // The top bar draws the icon on the next notify (this may be one).
      queueMicrotask(() => State.notify());
    }
    if (!plan) this.folded = false;
    const want = plan != null && !this.folded && !State.paused;
    this.send();
    if (want === this.shown) return;
    this.shown = want;
    if (!want) {
      void Bridge.planShow(false);
      return;
    }
    const fly = this.fly;
    this.fly = false;
    void Bridge.planShow(true).then(() => {
      if (!this.shown) return;
      this.sentKey = "";
      this.send();
      void emitToWindow("plan", "plan-appear", { fly });
    });
  }

  private send() {
    if (!IS_TAURI) return;
    const data: PlanData = { lang: language(), plan: this.book.current() };
    const key = JSON.stringify(data);
    if (key === this.sentKey) return;
    this.sentKey = key;
    void emitToWindow("plan", "plan-state", data);
  }
}
