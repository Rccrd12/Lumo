// The plan an agent follows, step by step — what the Plan island shows
// (island/plan.ts, plan.html). No DOM, so it can be tested on its own.
//
// Nothing is asked of the agents: the plan is read off the tool calls they
// already send through the hooks. Claude Code's TodoWrite (and its newer
// TaskCreate / TaskUpdate), the plan it leaves Plan Mode with (ExitPlanMode),
// Codex's update_plan, Gemini CLI's write_todos, OpenCode's todowrite: each
// is a list of steps with where each one stands.

/** Where a step stands. */
export type PlanStepStatus = "pending" | "active" | "done" | "skipped";

export interface PlanStep {
  text: string;
  status: PlanStepStatus;
}

/** One session's plan. */
export interface AgentPlan {
  /** The pill and the session it belongs to (`planKey`). */
  key: string;
  pillId: string;
  /** Who follows it: the pill's name (Claude Code, Codex…). */
  agent: string;
  color: string;
  /** The session's folder name. */
  project: string;
  steps: PlanStep[];
  /** What the agent said about it last (Codex's `explanation`). */
  note?: string;
  createdAt: number;
  updatedAt: number;
}

/** Steps kept of one plan: the rest would not fit anyway. */
export const MAX_STEPS = 40;
/** Longest step text kept. */
const MAX_TEXT = 200;

export function planKey(pillId: string, sessionId: string): string {
  return `${pillId}|${sessionId}`;
}

/** Every agent's word for where a step stands, in Lumo's. */
export function stepStatus(raw: unknown): PlanStepStatus {
  const s = typeof raw === "string" ? raw.toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (["completed", "complete", "done", "finished", "success"].includes(s)) return "done";
  if (["in_progress", "inprogress", "active", "running", "doing", "current"].includes(s)) return "active";
  if (["cancelled", "canceled", "skipped", "deleted", "removed", "abandoned"].includes(s)) return "skipped";
  return "pending";
}

/** A step's words, without Markdown's marks, on one line. */
export function cleanStep(raw: string): string {
  const text = raw
    .replace(/\[[ xX]\]\s*/, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/** The first string among these keys of an item. */
function textOf(item: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = item[k];
    if (typeof v === "string" && v.trim()) return cleanStep(v);
  }
  return "";
}

const STEP_KEYS = ["content", "step", "description", "title", "subject", "text", "task", "name"];

function stepsOf(items: unknown[]): PlanStep[] {
  const out: PlanStep[] = [];
  for (const raw of items) {
    if (out.length >= MAX_STEPS) break;
    if (typeof raw === "string") {
      const text = cleanStep(raw);
      if (text) out.push({ text, status: "pending" });
      continue;
    }
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const text = textOf(item, STEP_KEYS);
    if (text) out.push({ text, status: stepStatus(item.status ?? item.state) });
  }
  return out;
}

/**
 * The steps of a plan written in Markdown (Claude Code's ExitPlanMode): its
 * top-level list items, numbered or not. Nested items are details of the step
 * above them. A plan with no list has its sections' headings as steps.
 */
export function stepsFromMarkdown(md: string): PlanStep[] {
  const items: PlanStep[] = [];
  const headings: PlanStep[] = [];
  let fence = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const item = /^ ?(?:\d+[.)]|[-*+])\s+(.+)$/.exec(line);
    if (item) {
      const text = cleanStep(item[1]);
      const done = /^\[[xX]\]/.test(item[1].trim());
      if (text && items.length < MAX_STEPS) items.push({ text, status: done ? "done" : "pending" });
      continue;
    }
    const heading = /^#{2,4}\s+(.+)$/.exec(line);
    if (heading) {
      const text = cleanStep(heading[1]);
      if (text && headings.length < MAX_STEPS) headings.push({ text, status: "pending" });
    }
  }
  return items.length ? items : headings;
}

/** What one tool call says of the plan. */
export type PlanUpdate =
  /** The whole list, as it now stands. */
  | { kind: "list"; steps: PlanStep[]; note?: string; fresh?: boolean }
  /** One step added at the end (Claude Code's TaskCreate). */
  | { kind: "add"; step: PlanStep }
  /** One step changed, by its id (Claude Code's TaskUpdate: ids count from 1). */
  | { kind: "set"; id: string; status?: PlanStepStatus; text?: string };

/** The plan in a tool call, if it carries one. */
export function readPlanUpdate(tool: string, input: Record<string, unknown> | undefined): PlanUpdate | null {
  if (!input || typeof input !== "object") return null;
  const name = tool.toLowerCase();
  // Claude Code leaving Plan Mode: the plan it was given the go for.
  if (name === "exitplanmode" || name === "exit_plan_mode") {
    const steps = typeof input.plan === "string" ? stepsFromMarkdown(input.plan) : [];
    return steps.length ? { kind: "list", steps, fresh: true } : null;
  }
  if (name === "taskcreate") {
    const text = textOf(input, ["subject", "content", "description", "title"]);
    return text ? { kind: "add", step: { text, status: "pending" } } : null;
  }
  if (name === "taskupdate") {
    const id = input.taskId ?? input.task_id ?? input.id;
    if (typeof id !== "string" && typeof id !== "number") return null;
    const text = textOf(input, ["subject"]);
    return {
      kind: "set", id: String(id),
      ...(input.status != null ? { status: stepStatus(input.status) } : {}),
      ...(text ? { text } : {}),
    };
  }
  // A whole to-do list: TodoWrite, write_todos, todowrite, todo_write…
  if (Array.isArray(input.todos)) {
    const steps = stepsOf(input.todos);
    return steps.length ? { kind: "list", steps } : null;
  }
  // Codex's update_plan, and anything with a plan given as a list.
  if (Array.isArray(input.plan) || Array.isArray(input.steps)) {
    const steps = stepsOf((Array.isArray(input.plan) ? input.plan : input.steps) as unknown[]);
    if (!steps.length) return null;
    const note = typeof input.explanation === "string" ? cleanStep(input.explanation) : "";
    return { kind: "list", steps, ...(note ? { note } : {}) };
  }
  return null;
}

/** Every step done or put aside. */
export function planFinished(steps: readonly PlanStep[]): boolean {
  return steps.length > 0 && steps.every((s) => s.status === "done" || s.status === "skipped");
}

/** How far along: the steps done (or put aside) out of all of them. */
export function planProgress(steps: readonly PlanStep[]): { done: number; total: number } {
  return { done: steps.filter((s) => s.status === "done" || s.status === "skipped").length, total: steps.length };
}

/**
 * A list that is a new plan rather than the next state of `before`: there was
 * none, it was finished, or the two share no step.
 */
export function isNewPlan(before: readonly PlanStep[] | null, after: readonly PlanStep[]): boolean {
  if (!before || before.length === 0 || planFinished(before)) return true;
  const known = new Set(before.map((s) => s.text.toLowerCase()));
  return !after.some((s) => known.has(s.text.toLowerCase()));
}

/** Who a plan belongs to, as the hooks know it. */
export interface PlanOwner {
  pillId: string;
  sessionId: string;
  agent: string;
  color: string;
  project: string;
}

/**
 * Every session's plan, and which one is on screen. `apply` takes a tool
 * call and says whether a plan was made (the island opens) or only moved on.
 */
export class PlanBook {
  private plans = new Map<string, AgentPlan>();

  get size(): number {
    return this.plans.size;
  }

  get(key: string): AgentPlan | undefined {
    return this.plans.get(key);
  }

  /** The tool call's plan, kept: "new" for a plan just made, "changed", or null when nothing changed. */
  apply(owner: PlanOwner, update: PlanUpdate, now = Date.now()): "new" | "changed" | null {
    const key = planKey(owner.pillId, owner.sessionId);
    const before = this.plans.get(key) ?? null;
    let steps: PlanStep[];
    let note = before?.note;
    let fresh: boolean;
    switch (update.kind) {
      case "list":
        steps = update.steps.slice(0, MAX_STEPS);
        // The same list again (PostToolUse repeats PreToolUse's input): nothing new.
        if (before && JSON.stringify(before.steps) === JSON.stringify(steps) && (update.note === undefined || update.note === before.note)) return null;
        fresh = update.fresh === true || isNewPlan(before?.steps ?? null, steps);
        if (update.note !== undefined) note = update.note;
        else if (fresh) note = undefined;
        break;
      case "add": {
        fresh = !before || planFinished(before.steps);
        const kept = fresh ? [] : before!.steps;
        if (kept.length >= MAX_STEPS) return null;
        steps = [...kept, update.step];
        if (fresh) note = undefined;
        break;
      }
      case "set": {
        if (!before) return null;
        const i = Number(update.id) - 1;
        if (!Number.isInteger(i) || i < 0 || i >= before.steps.length) return null;
        steps = before.steps.map((s, j) => (j === i ? { text: update.text ?? s.text, status: update.status ?? s.status } : s));
        fresh = false;
        break;
      }
    }
    if (!steps.length) return null;
    if (!fresh && before && JSON.stringify(before.steps) === JSON.stringify(steps) && before.note === note) return null;
    this.plans.set(key, {
      key, pillId: owner.pillId, agent: owner.agent, color: owner.color, project: owner.project,
      steps, ...(note ? { note } : {}),
      createdAt: fresh || !before ? now : before.createdAt,
      updatedAt: now,
    });
    return fresh ? "new" : "changed";
  }

  /** The session is over: its plan goes. */
  drop(key: string): boolean {
    return this.plans.delete(key);
  }

  /** Every plan of a pill (its sessions all ended). */
  dropPill(pillId: string): boolean {
    let any = false;
    for (const [key, p] of this.plans) {
      if (p.pillId === pillId) {
        this.plans.delete(key);
        any = true;
      }
    }
    return any;
  }

  /**
   * The plan to show: the one moved on last among those still under way,
   * else the one finished last (it stays a moment, then goes).
   */
  current(): AgentPlan | null {
    let best: AgentPlan | null = null;
    let bestDone: AgentPlan | null = null;
    for (const p of this.plans.values()) {
      if (planFinished(p.steps)) {
        if (!bestDone || p.updatedAt >= bestDone.updatedAt) bestDone = p;
      } else if (!best || p.updatedAt >= best.updatedAt) {
        best = p;
      }
    }
    return best ?? bestDone;
  }
}
