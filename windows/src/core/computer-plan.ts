// What the island shows of computer use with a plan (views/computer-plan.ts):
// the plan's clock, how far it is, what changed since it was last shown, and
// the closed island's line. Pure: the plan in, words and numbers out, no DOM.

import { currentStep, type ComputerState, type ComputerStep } from "./computer-use";

/** A step new since the plan was last shown, or one whose words changed. */
export type StepMark = "new" | "changed" | null;

/** The plan's clock: "0:24", "12:05", "1:02:09" past an hour. */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/**
 * Which step the plan is at, counted from 1, and how many there are: the step
 * under way (else the first not done), or the last one once all are done.
 * {0, 0} without a plan.
 */
export function stepPlace(steps: readonly ComputerStep[]): { step: number; total: number } {
  const total = steps.length;
  if (!total) return { step: 0, total: 0 };
  const now = currentStep(steps as ComputerStep[]);
  return { step: now ? now.index + 1 : total, total };
}

/** The words of the step under way, or of the last one once all are done; null without a plan. */
export function stepNowText(steps: readonly ComputerStep[]): string | null {
  if (!steps.length) return null;
  const now = currentStep(steps as ComputerStep[]);
  return (now ? now.step.text : steps[steps.length - 1].text).trim() || null;
}

/** Whole seconds left until `until` (ms, any clock), never below 0: "Starts in 3 s", then 2, then 1. */
export function secondsLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/** How much of a countdown of `span` ms ending at `until` is left, 1 to 0 (the thin bar under it). */
export function countdownShare(until: number, span: number, now: number): number {
  if (!(span > 0)) return 0;
  return Math.max(0, Math.min(1, (until - now) / span));
}

/**
 * What changed in the plan since it was last shown (`before`; null the first
 * time, which marks nothing). The steps whose words are the same, in the
 * same order, are the same steps (done since, or moved by a step put in
 * before them). Between two of those, the steps that are not there any more
 * were changed into the ones that came: one for one when as many went as
 * came, else each into the one most like it; the others that came are new.
 */
export function planMarks(before: readonly ComputerStep[] | null, now: readonly ComputerStep[]): StepMark[] {
  const marks: StepMark[] = now.map(() => null);
  if (!before) return marks;
  const a = before.map((s) => s.text.trim());
  const b = now.map((s) => s.text.trim());
  // The longest run of the same words in the same order (a plan is short: the plain table).
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const gaps: { gone: number[]; came: number[] }[] = [{ gone: [], came: [] }];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const gap = gaps[gaps.length - 1];
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
      gaps.push({ gone: [], came: [] });
    } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      gap.came.push(j++);
    } else {
      gap.gone.push(i++);
    }
  }
  for (const { gone, came } of gaps) {
    if (!came.length) continue;
    for (const k of came) marks[k] = "new";
    if (!gone.length) continue;
    if (gone.length === came.length) {
      for (const k of came) marks[k] = "changed";
      continue;
    }
    const free = new Set(came);
    for (const g of gone) {
      let best = -1;
      let bestScore = 0;
      for (const k of free) {
        const score = likeness(a[g], b[k]);
        if (score > bestScore) {
          best = k;
          bestScore = score;
        }
      }
      if (best >= 0 && bestScore >= 0.25) {
        marks[best] = "changed";
        free.delete(best);
      }
    }
  }
  return marks;
}

/** How alike two steps' words are, 0 to 1: the words they share, of all their words. */
function likeness(x: string, y: string): number {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const wx = words(x);
  const wy = words(y);
  if (!wx.size || !wy.size) return 0;
  let shared = 0;
  for (const w of wx) if (wy.has(w)) shared++;
  return shared / (wx.size + wy.size - shared);
}

/**
 * Which footer the plan has: the moment before the first action ("start"),
 * a step just done ("step"), paused with Esc, or none.
 */
export type ComputerFooter = "start" | "step" | "paused" | null;

export function computerFooter(state: ComputerState | null, reveal: "start" | "step" | null): ComputerFooter {
  if (!state?.engaged || state.stopped) return null;
  if (state.paused) return "paused";
  return reveal;
}

/** What the closed island says while the agent uses the computer: the step, the plan's segments, k/n. Null without a plan. */
export interface ComputerPillParts {
  color: string;
  agent: string;
  text: string;
  segments: ComputerStep["status"][];
  place: string;
  /** Paused: Esc does nothing then (only the island's Resume goes on), so no Esc keycap. */
  paused: boolean;
}

export function computerPillParts(state: ComputerState | null): ComputerPillParts | null {
  if (!state?.engaged || !state.steps.length) return null;
  const text = stepNowText(state.steps) ?? "";
  const { step, total } = stepPlace(state.steps);
  return {
    color: state.color, agent: state.agent, text, segments: state.steps.map((s) => s.status), place: `${step}/${total}`, paused: state.paused,
  };
}

/** A key for what the closed island draws, to redraw only when it changes. */
export function computerPillKey(parts: ComputerPillParts | null): string {
  return parts ? JSON.stringify([parts.color, parts.text, parts.segments, parts.place, parts.paused]) : "";
}

// ── What the island does with it ───────────────────────────────────────────

/**
 * The plan is paused with Esc and waits for the user (Stop, Ask, Resume):
 * the island opens on it, and goes back to it when a card leaves.
 */
export function pausedPlanWaits(active: boolean, state: ComputerState | null): boolean {
  return active && !!state?.engaged && state.paused && !state.stopped;
}

/** Where the island is when a computer-state comes or the plan leaves. */
export interface PlanSpot {
  mode: "hidden" | "compact" | "expanded";
  view: string;
  /** A permission card or a question waits for an answer. */
  card: boolean;
  /** Lumo is paused (the tray's Pause): nothing opens. */
  appPaused?: boolean;
}

/**
 * What a new computer-state does to the island (island.ts onComputerState):
 * the plan leaves (over, stopped), opens and stays (paused), leaves after a
 * resume, opens a moment (a reveal), or nothing. A card waiting wins over a
 * reveal, and a step done does not take over a view the user opened
 * meanwhile (a chat, Settings): the closed island's line and the chat's plan
 * strip say it. The start still folds what is open, as computer use always did.
 */
export type PlanMove = "leave" | "pause" | "resume" | "reveal" | null;

export function planMove(was: ComputerState | null, state: ComputerState, spot: PlanSpot): PlanMove {
  if (!state.engaged || state.stopped) return "leave";
  if (state.paused) return "pause";
  if (was?.paused) return "resume";
  if (!state.reveal || spot.card || spot.appPaused) return null;
  if (state.reveal === "step" && spot.mode === "expanded" && spot.view !== "computer") return null;
  return "reveal";
}

/**
 * Where the island goes once a card is answered and none waits, unless the
 * plan is paused (island.ts closeApproval): out of the agent's way while it
 * uses the computer, whoever asked (a step done no longer takes over an open
 * view, so nothing else would fold it); otherwise back to who asked: the
 * chat, Gemini's call for its helper, or the agents for a terminal session.
 */
export function afterCard(fromChat: boolean, computer: boolean, live: boolean): "collapse" | "live" | "prompt" | "agents" {
  if (computer) return "collapse";
  return fromChat ? (live ? "live" : "prompt") : "agents";
}

/**
 * How the island lets the plan go (island.ts leaveComputerPlan): it closes if
 * it is on the plan; after a resume it closes on any view, the agent has the
 * mouse again (a chat closed so comes back when computer use is over);
 * otherwise its hold goes and it closes as it would have ("release"). A card
 * waiting keeps it as it is.
 */
export type PlanLeave = "collapse" | "fold-chat" | "release" | "keep";

export function planLeave(resumed: boolean, spot: PlanSpot): PlanLeave {
  if (spot.mode === "expanded" && spot.view === "computer") return "collapse";
  if (spot.card) return "keep";
  if (resumed && spot.mode === "expanded") return spot.view === "prompt" ? "fold-chat" : "collapse";
  return "release";
}
