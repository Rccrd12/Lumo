// Computer use with a plan (computer.rs): what Rust tells the island about the
// turn that uses the computer, and what a finished turn leaves in the chat.
//
// The agent gives a plan before it may use the computer (Lumo's update_plan);
// the island shows it when computer use starts and each time a step is done,
// and keeps it open while the user has paused it with Esc. Pure: shapes and
// the little that is worked out from them, no DOM.

/** One step of the plan, as Rust sends it. Cancelled or skipped steps come as `done`. */
export interface ComputerStep {
  text: string;
  status: "pending" | "active" | "done";
}

/**
 * Why the island opens on the plan for a moment: computer use starts (the
 * first action waits `revealMs` for it), or the agent marked a step done.
 */
export type ComputerReveal = "start" | "step";

/**
 * The `computer-state` event (computer.rs emit_state): sent when computer use
 * starts or ends, when the plan changes while it runs, on pause, on resume,
 * when the user's question is sent and when it is stopped.
 */
export interface ComputerState {
  /** Computer use is under way in this turn (the glow is on). False: it is over, the island goes back to normal. */
  engaged: boolean;
  /** Esc paused it: the mouse is the user's, the agent waits at its next action. */
  paused: boolean;
  /** Stopped for good (Ferma, or the chat's Stop): nothing more is done in this turn. */
  stopped: boolean;
  /** Who uses the computer: the provider's name ("Claude Code") and colour. */
  agent: string;
  color: string;
  /** The plan, whole. Empty only before the agent gave one. */
  steps: ComputerStep[];
  /** The agent's own words with its last plan (update_plan's `explanation`): its answer to the user's question. */
  explanation?: string;
  /** The user's question sent while paused, until the agent answers it with a new plan. */
  asked?: string;
  /** Set on the event that should open the island on the plan; absent otherwise. */
  reveal?: ComputerReveal;
  /** How long that opening lasts, ms (the first action waits as long on "start"). */
  revealMs?: number;
  /** When computer use started in this turn, epoch ms (the plan's clock). */
  since: number;
}

/** A step of the recap: the plan's step, how it ended, and a small picture of the screen when it was done. */
export interface ComputerRecapStep {
  text: string;
  status: "pending" | "active" | "done";
  /** A small PNG of the screen taken when the step was marked done (base64, no data: prefix). */
  image?: string;
}

/**
 * What a turn that used the computer leaves under its answer (ChatReply.computer,
 * saved with the chat): the plan as it ended, how many actions, how long, and
 * whether it was stopped.
 */
export interface ComputerRecap {
  agent: string;
  color: string;
  steps: ComputerRecapStep[];
  /** Actions that did something (clicks, keys, typing, scrolls, drags, moves). */
  actions: number;
  /** From the first to the last computer call, ms. */
  ms: number;
  /** Stopped before the end (Ferma, the chat's Stop): the steps left are as they were. */
  stopped?: boolean;
}

/** What `computer_peek` says of a point of the screen the agent wants to act on, for the permission card. */
export interface ComputerPeek {
  /** A crop of the screen around the point (PNG, base64), the point at `at` within it. */
  image: string;
  width: number;
  height: number;
  /** Where the point is in the crop, in its pixels. */
  at: [number, number];
  /** What Windows says is there (UI Automation), when it says: its name, its kind, the app. */
  name?: string;
  role?: string;
  app?: string;
}

/** The step under way: the active one, else the first not done. Null when every step is done or there is none. */
export function currentStep(steps: ComputerStep[]): { index: number; step: ComputerStep } | null {
  let i = steps.findIndex((s) => s.status === "active");
  if (i < 0) i = steps.findIndex((s) => s.status !== "done");
  return i < 0 ? null : { index: i, step: steps[i] };
}

/** How far the plan is: steps done, and all of them. */
export function stepsDone(steps: ComputerStep[]): { done: number; total: number } {
  return { done: steps.filter((s) => s.status === "done").length, total: steps.length };
}
