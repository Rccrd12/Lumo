// The Plan island: a third island with the plan an agent follows step by
// step, and the live activities' twin. Shut and out of reach until an agent
// makes a plan (core/agent-plan.ts reads it off the hooks): then it opens
// with it, and its steps move on as the agent works. Its icon in the chat,
// left of the usage ring, shows while there are plans: it opens the island,
// and folds it when it is open.
//
// It behaves as the live activities (island/activities.ts) do. Beside the
// open island, on the side they leave free, it is drawn in the island's page
// and comes and goes with the island. Dragged by its top bar it comes off
// into a window of its own (plan.html, plan_island.rs), put wherever it is
// left, and joins the island again when dropped against its side. There it
// stays on screen when the island closes, until its "–" puts it away. Its
// grips resize it. Coming off and joining again, one is drawn before the
// other goes, so it never blinks.
//
// A plan done stays a moment, then the island folds into its icon. The plans
// done are kept (the newest few): the icon opens the island again on the
// newest, and its arrows go back through the older ones.
//
// The island chat's Claude Code runs send their plan through the chat
// (`chat-plan`), the agents in a terminal through their hooks.
//
// This page holds the plans: it draws them beside the island, and sends its
// own window the one to show and hears its clicks. Nothing runs while there
// is no plan, and nothing ticks while there is one.

import { Bridge, IS_TAURI, emitToWindow, onEvent } from "../core/bridge";
import { PlanBook, planFinished, planId, planKey, readPlanUpdate, type AgentPlan, type PlanOwner } from "../core/agent-plan";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { language, t } from "../i18n/i18n";
import type { PagePoint } from "../views/dom";
import type { PlanAction, PlanData, PlanViewHooks } from "../views/plan-view";

/** How long a plan done stays on screen before the island folds. */
const DONE_LINGER_MS = 8_000;
/** Plans done kept to go back to. */
const KEPT_PLANS = 20;
/** Its width by default (views/plan-view.ts PLAN_W, plan_island.rs). */
const PLAN_W = 280;
/** The longest its own window may take to say it has drawn it. */
const HAND_OFF_MS = 400;

/** What the island's page draws the plan with (views/plan-view.ts PlanView). */
export interface PlanPanel {
  readonly el: HTMLElement;
  render(data: PlanData): void;
  reveal(): void;
  flyIn(): Promise<void>;
  fold(): Promise<void>;
}

export interface IslandPlanHost {
  openSettings(): void;
  refreshAll(): void;
  /** The view beside the island; `side` and `follows` say which grips it shows. */
  makeView(hooks: PlanViewHooks, side: () => "left" | "right" | "free", follows: () => boolean): PlanPanel;
  /** Where its icon in the chat sits, in page pixels. */
  iconPoint(): PagePoint | null;
  /** It can be moved and resized (the cursor poll). */
  movable: boolean;
  /** The side of the island it is drawn on. */
  side(): "left" | "right";
  changed(): void;
}

/** After the next frame has been put on screen. */
function afterPaint(fn: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(() => fn()));
}

export class IslandPlan {
  readonly book = new PlanBook();
  readonly view: PlanPanel;
  /** The plans done or whose session ended, the newest first. */
  private past: AgentPlan[] = [];
  /** The plan looked at (`planId`), or null for the newest. */
  private viewing: string | null = null;
  /** Folded into its icon with the "–", or once its plan was done. */
  private folded = false;
  /** Shown beside the island. */
  private visible = false;
  /** Its own window is shown. */
  private windowShown = false;
  /** The next showing comes out of its icon (a plan just made, the icon clicked). */
  private unfolding = false;
  /** Off to its own window: drawn here until that window says it has drawn it. */
  private handingOff: number | null = null;
  /** Its own window was asked for ahead (plan_prepare). */
  private prepared = false;
  private sentKey = "";
  private doneTimer: number | null = null;
  private host: IslandPlanHost;

  constructor(host: IslandPlanHost) {
    this.host = host;
    this.view = host.makeView({
      act: (a) => this.act(a),
      drag: () => {
        const r = this.view.el.getBoundingClientRect();
        void Bridge.planDrag([parseFloat(this.view.el.style.left) || r.left, parseFloat(this.view.el.style.top) || r.top, r.width, r.height]);
      },
      resize: (fx, fy) => void Bridge.planResize(fx, fy, this.view.el.getBoundingClientRect().height),
      iconPoint: () => host.iconPoint(),
      movable: host.movable,
    }, () => host.side(), () => this.followsIsland);
    this.view.el.id = "plan";
    void onEvent<PlanAction>("plan-action", (a) => this.act(a));
    // Its page (re)loaded: everything again.
    void onEvent<null>("plan-hello", () => {
      this.sentKey = "";
      this.sendToWindow();
      if (this.windowShown) void emitToWindow("plan", "plan-appear", { fly: false, painted: false });
    });
    // Live sizes while a grip is dragged beside the island.
    void onEvent<{ width: number; height: number }>("plan-resize", (size) => {
      State.settings = { ...State.settings, agentPlanWidth: size.width, agentPlanHeight: size.height };
      host.changed();
    });
    // Joined the island again: drawn here at once, where its window slid to.
    void onEvent<null>("plan-joined", () => Sound.play("pop"));
    // Its own window has drawn it: this page lets go of it.
    void onEvent<null>("plan-painted", () => this.handedOff());
    // Claude Code in the island's own chat (claude_code.rs): its runs send no
    // session hooks, so its plan comes straight from the chat's stream.
    // Antigravity CLI's runs send the checklist it writes as its plan.
    void onEvent<{ tool: string; input: Record<string, unknown>; agent?: string; color?: string }>("chat-plan", ({ tool, input, agent, color }) => {
      this.onTool({
        pillId: "chat", sessionId: String(State.chatId ?? ""),
        agent: agent ?? "Claude Code", color: color ?? "#F5F6F8", project: t("Chat"),
      }, tool, input);
    });
    State.subscribe(() => this.sync());
  }

  /** Every plan, the newest first: those under way, then those done. */
  plans(): AgentPlan[] {
    return [...this.book.list(), ...this.past];
  }

  /** The plan on screen, or the one the icon brings back. */
  get current(): AgentPlan | null {
    const all = this.plans();
    return (this.viewing && all.find((p) => planId(p) === this.viewing)) || all[0] || null;
  }

  /** There is a plan to show, and it is not folded: it shows wherever it may. */
  get wanted(): boolean {
    return this.plans().length > 0 && !this.folded && !State.paused;
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** On screen, beside the island or in its own window. */
  get onScreen(): boolean {
    return this.visible || this.windowShown;
  }

  /** In its own window instead of beside the island. */
  get detached(): boolean {
    return this.host.movable && State.settings.agentPlanMoved === true;
  }

  get width(): number {
    const w = State.settings.agentPlanWidth;
    return Number.isFinite(w) && w > 0 ? Math.min(480, Math.max(220, w)) : PLAN_W;
  }

  /** As tall as the island beside it, following its resizes, as the live activities (not in its own window). */
  get followsIsland(): boolean {
    return State.settings.activitiesFollowIsland !== false && !this.detached;
  }

  get pickedHeight(): number {
    const v = State.settings.agentPlanHeight;
    return Number.isFinite(v) && v > 0 ? Math.min(720, Math.max(180, v)) : 0;
  }

  /** A tool call of an agent's session: its plan, if it carries one, moves on. */
  onTool(owner: PlanOwner, tool: string, input: Record<string, unknown> | undefined) {
    const update = readPlanUpdate(tool, input);
    if (!update) return;
    const result = this.book.apply(owner, update);
    if (!result) return;
    if (result === "new" && this.book.current()?.key === planKey(owner.pillId, owner.sessionId)) {
      // A plan just made: the island opens with it, even folded before; out
      // of its icon when it can be seen at once, else with the island.
      this.viewing = null;
      this.folded = false;
      if (!this.onScreen && (this.detached || State.mode === "expanded")) {
        this.unfolding = true;
        Sound.play("open");
      }
    }
    this.changed();
  }

  /** The session ended: its plan is put with those done. */
  endSession(pillId: string, sessionId: string) {
    if (this.retire(planKey(pillId, sessionId))) this.changed();
  }

  /** Every session of the pill ended. */
  endPill(pillId: string) {
    let any = false;
    for (const p of this.book.list()) if (p.pillId === pillId) any = this.retire(p.key) || any;
    if (any) this.changed();
  }

  /** The icon in the chat was clicked: open, the island folds; folded, it comes back. */
  toggle() {
    if (this.folded) {
      this.unfold();
      return;
    }
    // It folds with its own animation, then says so (plan-action fold).
    if (this.visible) {
      void this.view.fold();
      return;
    }
    if (this.windowShown) {
      void emitToWindow("plan", "plan-fold");
      return;
    }
    this.folded = true;
    this.changed();
  }

  /** Back it comes, out of its icon, on the newest plan. */
  unfold() {
    if (!this.folded || !this.plans().length) return;
    Sound.play("open");
    this.folded = false;
    this.viewing = null;
    this.unfolding = true;
    this.changed();
  }

  /**
   * A plan out of the book, kept with those done. The island folds when it
   * was the one followed and no other is under way.
   */
  private retire(key: string): boolean {
    const plan = this.book.get(key);
    if (!plan) return false;
    const id = planId(plan);
    const followed = this.current != null && planId(this.current) === id;
    this.book.drop(key);
    this.past = [plan, ...this.past.filter((p) => planId(p) !== id)].slice(0, KEPT_PLANS);
    if (followed && !this.book.list().some((p) => !planFinished(p.steps))) this.folded = true;
    return true;
  }

  private act(a: PlanAction) {
    switch (a.kind) {
      case "fold":
        this.folded = true;
        break;
      case "older":
      case "newer": {
        const all = this.plans();
        const at = Math.max(0, all.findIndex((p) => this.current != null && planId(p) === planId(this.current)));
        const next = Math.min(all.length - 1, Math.max(0, at + (a.kind === "older" ? 1 : -1)));
        // Back on the newest, it follows the plans as they come again.
        this.viewing = next === 0 ? null : planId(all[next]);
        break;
      }
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
    this.host.changed();
  }

  /** A plan done on screen: after a moment it goes with those done, and the island folds. */
  private armDone() {
    if (this.doneTimer != null) window.clearTimeout(this.doneTimer);
    this.doneTimer = null;
    const plan = this.book.current();
    if (!plan || !planFinished(plan.steps)) return;
    this.doneTimer = window.setTimeout(() => {
      this.doneTimer = null;
      const now = this.book.get(plan.key);
      if (now && planFinished(now.steps) && now.updatedAt === plan.updatedAt) {
        this.retire(plan.key);
        this.changed();
      }
    }, DONE_LINGER_MS);
  }

  /**
   * Beside the island at (x, y), `height` tall, or hidden; in its own window,
   * shown or hidden. Called every frame the island moves.
   */
  place(show: boolean, x: number, y: number, height: number) {
    const el = this.view.el;
    const besideIsland = show && !this.detached;
    if (besideIsland) {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${this.width}px`;
      el.style.height = `${height}px`;
    }
    const inWindow = show && this.detached;
    // From beside the island to its own window, or back, while the island
    // stays open: one is shown before the other goes, with no fade, so there
    // is never a frame without it.
    const swap = show && this.windowShown !== inWindow && besideIsland !== this.visible;
    if (besideIsland !== this.visible) {
      this.visible = besideIsland;
      if (besideIsland) {
        this.cancelHandOff();
        this.view.render(this.data());
        this.setShown(true, swap);
        if (this.host.movable && !this.prepared && IS_TAURI) {
          this.prepared = true;
          void Bridge.planPrepare();
        }
        if (swap) this.view.reveal();
        else if (this.unfolding) void this.view.flyIn();
        else this.view.reveal();
        this.host.changed();
      } else if (swap) {
        // Still drawn here until its window has drawn it.
        this.handingOff = window.setTimeout(() => this.handedOff(), HAND_OFF_MS);
      } else {
        this.cancelHandOff();
        this.setShown(false, false);
      }
    }
    if (inWindow !== this.windowShown) {
      this.windowShown = inWindow;
      if (inWindow) {
        void Bridge.planShow(true);
        this.sentKey = "";
        this.sendToWindow();
        void emitToWindow("plan", "plan-appear", { fly: this.unfolding, painted: swap });
      } else if (swap) {
        // Back beside the island: its window goes once this page has drawn it.
        afterPaint(() => {
          if (!this.windowShown) void Bridge.planShow(false);
        });
      } else {
        void Bridge.planShow(false);
      }
    }
    if (show) this.unfolding = false;
  }

  /** Shown or hidden beside the island; `instant` without the fade. */
  private setShown(on: boolean, instant: boolean) {
    const el = this.view.el;
    if (instant) el.classList.add("instant");
    el.classList.toggle("shown", on);
    if (instant) {
      void el.offsetWidth;
      el.classList.remove("instant");
    }
  }

  /** Its own window has drawn it (or took too long to say): gone from here, at once. */
  private handedOff() {
    if (this.handingOff == null) return;
    this.cancelHandOff();
    if (!this.visible) this.setShown(false, true);
  }

  private cancelHandOff() {
    if (this.handingOff != null) window.clearTimeout(this.handingOff);
    this.handingOff = null;
  }

  /** The icon in the chat, and what is drawn beside the island and in its window. */
  sync() {
    const any = this.plans().length > 0;
    if (!any) {
      this.folded = false;
      this.viewing = null;
    }
    const open = this.wanted;
    if (State.planIcon !== any || State.planOpen !== open) {
      State.planIcon = any;
      State.planOpen = open;
      // The chat draws the icon on the next notify (this may be one).
      queueMicrotask(() => State.notify());
    }
    if (this.visible) this.view.render(this.data());
    if (this.windowShown) this.sendToWindow();
  }

  /** What the views draw. */
  data(): PlanData {
    const all = this.plans();
    const plan = this.current;
    const index = plan ? all.findIndex((p) => planId(p) === planId(plan)) : -1;
    return {
      lang: language(),
      plan,
      index: Math.max(0, index),
      count: all.length,
      live: plan != null && this.book.get(plan.key) === plan,
    };
  }

  private sendToWindow() {
    if (!IS_TAURI) return;
    const data = this.data();
    const key = JSON.stringify(data);
    if (key === this.sentKey) return;
    this.sentKey = key;
    void emitToWindow("plan", "plan-state", data);
  }
}
