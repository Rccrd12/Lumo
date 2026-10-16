// The Plan island: a third island, right of the main one, with the plan an
// agent follows step by step. Shut and out of reach until an agent makes a
// plan (core/agent-plan.ts reads it off the hooks): then it opens with it,
// and its steps move on as the agent works. Like the live activities it can
// be moved (by its top bar), let go near its place beside the island it joins
// it again, and resized (its grips); its "–" folds it into an icon in the
// chat, left of the usage ring, which brings it back.
//
// A plan done stays a moment, then the island folds into its icon. The plans
// done are kept (the newest few): the icon opens the island again on the
// newest, and its arrows go back through the older ones.
//
// The island chat's Claude Code runs send their plan through the chat
// (`chat-plan`), the agents in a terminal through their hooks.
//
// It lives in a window of its own (plan.html, plan_island.rs), shown on its
// own whether the island is open or not, which only draws: this page holds
// the plans, sends the window the one to show and hears its clicks. Nothing
// runs while there is no plan, and nothing ticks while there is one.

import { Bridge, IS_TAURI, emitToWindow, onEvent } from "../core/bridge";
import { PlanBook, planFinished, planId, planKey, readPlanUpdate, type AgentPlan, type PlanOwner } from "../core/agent-plan";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { language, t } from "../i18n/i18n";
import type { PlanAction, PlanData } from "../views/plan-view";

/** How long a plan done stays on screen before the island folds. */
const DONE_LINGER_MS = 8_000;
/** Plans done kept to go back to. */
const KEPT_PLANS = 20;

export interface IslandPlanHost {
  openSettings(): void;
  refreshAll(): void;
}

export class IslandPlan {
  readonly book = new PlanBook();
  /** The plans done or whose session ended, the newest first. */
  private past: AgentPlan[] = [];
  /** The plan looked at (`planId`), or null for the newest. */
  private viewing: string | null = null;
  /** Folded into its icon with the "–", or once its plan was done. */
  private folded = false;
  /** Its window is shown. */
  private shown = false;
  /** The next showing comes out of its corner (a plan just made, the icon clicked). */
  private fly = false;
  private sentKey = "";
  private doneTimer: number | null = null;
  /** The open island's height last told to its window (`fitIsland`). */
  private islandH = 0;
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

  /** A tool call of an agent's session: its plan, if it carries one, moves on. */
  onTool(owner: PlanOwner, tool: string, input: Record<string, unknown> | undefined) {
    const update = readPlanUpdate(tool, input);
    if (!update) return;
    const result = this.book.apply(owner, update);
    if (!result) return;
    if (result === "new" && this.book.current()?.key === planKey(owner.pillId, owner.sessionId)) {
      // A plan just made: the island opens with it, even folded before.
      this.viewing = null;
      this.folded = false;
      if (!this.shown) {
        this.fly = true;
        Sound.play("open");
      }
    }
    this.armDone();
    this.sync();
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

  /**
   * The open island's height (page pixels): beside it, with no height picked
   * with a grip, the window is as tall (plan_island.rs).
   */
  fitIsland(h: number) {
    if (!IS_TAURI || !(h > 0) || Math.abs(h - this.islandH) < 0.5) return;
    this.islandH = h;
    void Bridge.planFit(h);
  }

  /** The icon in the chat was clicked: back it comes, on the newest plan. */
  unfold() {
    if (!this.folded || !this.plans().length) return;
    this.folded = false;
    this.viewing = null;
    this.fly = true;
    Sound.play("open");
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
    State.notify();
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

  /** Its window shown or hidden as it should be, with the plan it shows. */
  sync() {
    const any = this.plans().length > 0;
    if (!any) {
      this.folded = false;
      this.viewing = null;
    }
    const icon = any && this.folded;
    if (State.planIcon !== icon) {
      State.planIcon = icon;
      // The chat draws the icon on the next notify (this may be one).
      queueMicrotask(() => State.notify());
    }
    const want = any && !this.folded && !State.paused;
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
    const all = this.plans();
    const plan = this.current;
    const index = plan ? all.findIndex((p) => planId(p) === planId(plan)) : -1;
    const data: PlanData = {
      lang: language(),
      plan,
      index: Math.max(0, index),
      count: all.length,
      live: plan != null && this.book.get(plan.key) === plan,
    };
    const key = JSON.stringify(data);
    if (key === this.sentKey) return;
    this.sentKey = key;
    void emitToWindow("plan", "plan-state", data);
  }
}
