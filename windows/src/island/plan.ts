// The plans agents follow step by step. Shut until an agent makes a plan
// (core/agent-plan.ts reads it off the hooks): then it opens, and its steps
// move on as the agent works. The island draws them: each chat's own plan in
// a strip over that chat's field (views/plan-strip.ts), those under way on
// the home. The plan icon in the chat, left of the usage ring, shows while
// there are plans: it folds the strip, and opens it again.
//
// A plan done stays a moment, then folds into its icon. The plans done are
// kept (the newest few), so the icon can open them again.
//
// The island chat's Claude Code runs send their plan through the chat
// (`chat-plan`), the agents in a terminal through their hooks.
//
// Nothing runs while there is no plan, and nothing ticks while there is one.
// (It used to be a panel beside the open island that could be
// taken off into a window of its own, the Plan island. Both are gone.)

import { onEvent } from "../core/bridge";
import { PlanBook, planFinished, planId, planKey, readPlanUpdate, type AgentPlan, type PlanOwner } from "../core/agent-plan";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { t } from "../i18n/i18n";

/** How long a plan done stays open before it folds. */
const DONE_LINGER_MS = 8_000;
/** Plans done kept to go back to. */
const KEPT_PLANS = 20;

export interface IslandPlanHost {
  changed(): void;
}

export class IslandPlan {
  readonly book = new PlanBook();
  /** What State.plans was last set to (sync). */
  private nowKey = "";
  /** The plans done or whose session ended, the newest first. */
  private past: AgentPlan[] = [];
  /** Folded into its icon, or once its plan was done. */
  private folded = false;
  private doneTimer: number | null = null;
  private host: IslandPlanHost;

  constructor(host: IslandPlanHost) {
    this.host = host;
    // Claude Code in the island's own chat (claude_code.rs): its runs send no
    // session hooks, so its plan comes straight from the chat's stream.
    // Antigravity CLI's runs send the checklist it writes as its plan.
    void onEvent<{ tool: string; input: Record<string, unknown>; agent?: string; color?: string; chat?: string }>("chat-plan", ({ tool, input, agent, color, chat }) => {
      this.onTool({
        pillId: "chat", sessionId: chat || String(State.chatId ?? ""),
        agent: agent ?? "Claude Code", color: color ?? "#F5F6F8", project: t("Chat"),
      }, tool, input);
    });
    State.subscribe(() => this.sync());
  }

  /** Every plan, the newest first: those under way, then those done. */
  plans(): AgentPlan[] {
    return [...this.book.list(), ...this.past];
  }

  /** The newest plan: the one the icon brings back. */
  get current(): AgentPlan | null {
    return this.plans()[0] ?? null;
  }

  /** There is a plan to show, and it is not folded. */
  get wanted(): boolean {
    return this.plans().length > 0 && !this.folded && !State.paused;
  }

  /** A tool call of an agent's session: its plan, if it carries one, moves on. */
  onTool(owner: PlanOwner, tool: string, input: Record<string, unknown> | undefined) {
    const update = readPlanUpdate(tool, input);
    if (!update) return;
    const result = this.book.apply(owner, update);
    if (!result) return;
    if (result === "new" && this.book.current()?.key === planKey(owner.pillId, owner.sessionId)) {
      // A plan just made: it opens, even folded before, with a sound when
      // the island is open to show it.
      this.folded = false;
      if (State.mode === "expanded") Sound.play("open");
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

  /**
   * The island chat was deleted: its plans go with it, under way or done,
   * and are not kept to go back to.
   */
  forgetChat(chatId: string) {
    const key = planKey("chat", chatId);
    const had = this.book.drop(key);
    const kept = this.past.filter((p) => p.key !== key);
    if (!had && kept.length === this.past.length) return;
    this.past = kept;
    this.changed();
  }

  /**
   * A question of the island chat was edited: its answers from there on are
   * gone, and the next one starts a new session that knows nothing of the
   * plan they made. That plan goes, unkept, so the next plan starts on its
   * own instead of adding its steps to it. Plans done before stay in the past.
   */
  restartChat(chatId: string) {
    const key = planKey("chat", chatId);
    const plan = this.book.get(key);
    const followed = plan != null && this.current != null && planId(this.current) === planId(plan);
    if (!this.book.restart(key)) return;
    if (followed && !this.book.list().some((p) => !planFinished(p.steps))) this.folded = true;
    this.changed();
  }

  /** The icon in the chat was clicked: open, it folds; folded, it comes back. */
  toggle() {
    if (this.folded) {
      this.unfold();
      return;
    }
    this.folded = true;
    this.changed();
  }

  /** Back it comes, on the newest plan. */
  unfold() {
    if (!this.folded || !this.plans().length) return;
    Sound.play("open");
    this.folded = false;
    this.changed();
  }

  /**
   * A plan out of the book, kept with those done. It folds when it was the
   * one followed and no other is under way.
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

  private changed() {
    this.armDone();
    this.sync();
    this.host.changed();
  }

  /** A plan done: after a moment it goes with those done, and it folds. */
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

  /** What the island draws: the plans, and whether the icon shows and reads open. */
  sync() {
    const any = this.plans().length > 0;
    if (!any) this.folded = false;
    const open = this.wanted;
    // Each chat draws its own plan, and the home those under way.
    const all = this.plans();
    const nowKey = JSON.stringify(all.map((p) => [planId(p), p.updatedAt, p.steps]));
    if (nowKey !== this.nowKey) {
      this.nowKey = nowKey;
      State.plans = all;
      queueMicrotask(() => State.notify());
    }
    if (State.planIcon !== any || State.planOpen !== open) {
      State.planIcon = any;
      State.planOpen = open;
      // The chat draws the icon on the next notify (this may be one).
      queueMicrotask(() => State.notify());
    }
  }
}
