// Antigravity CLI's Orchestrator: one model plans, another carries the plan
// out, each at its own effort. `agy models` lists it once per planner
// (`gemini-pro-orchestrator`, `gemini-pro-orchestrator-neon`…), never the
// executor; agy takes both from the "orchestrator" key of its settings, which
// `--settings` sets for one run without saving it (antigravity_cli.rs).
//
// The picker shows those rows as one, "Orchestrator", with a Planner and an
// Executor under the list, each with its own effort slider. What is saved is
// one model as any other: `orchestrator:<planner>:<executor>`, the two ids
// `agy models` gives them (`orchestrator:gemini-4-neon-high:gemini-4-hydrogen-high`).

import { groupOf, levelOf, splitEffort, type ModelGroup } from "./effort-groups";
import { prettyModel } from "./model-names";

/** What an Orchestrator pick starts with, in front of its two ids. */
export const ORCHESTRATOR_PREFIX = "orchestrator:";

/**
 * The executors agy offers (Neon never is), in its order. A planner can be any
 * Gemini 4 model: agy's /model offers each of them it lists.
 */
const EXECUTORS = ["gemini-4-hydrogen", "claude-sonnet-5-5"];
const PLANNER = /^gemini-4-[a-z]+$/;

/**
 * One of agy's Orchestrator rows (`gemini-pro-orchestrator-neon`): no digit
 * in it. The single model it once was (`gemini-pro-orchestrator-g1-pro`)
 * stays a model of its own.
 */
export function isOrchestratorRow(id: string): boolean {
  return /(^|-)orchestrator(-|$)/.test(id) && !/\d/.test(id);
}

/** A planner and an executor, by the ids `agy models` gives them. */
export interface Orchestration {
  planner: string;
  executor: string;
}

/** The planner and the executor `model` names, or null for any other model. */
export function parseOrchestrator(model: string): Orchestration | null {
  if (!model.startsWith(ORCHESTRATOR_PREFIX)) return null;
  const [planner, executor, ...rest] = model.slice(ORCHESTRATOR_PREFIX.length).split(":");
  return planner && executor && rest.length === 0 ? { planner, executor } : null;
}

export function orchestratorModel(o: Orchestration): string {
  return `${ORCHESTRATOR_PREFIX}${o.planner}:${o.executor}`;
}

/** The models agy lets plan, and those it lets execute, among `groups`. */
export function orchestratorRoles(groups: readonly ModelGroup[]): { planners: ModelGroup[]; executors: ModelGroup[] } {
  const planners = groups.filter((g) => PLANNER.test(g.name) && g.levels.length > 0);
  const executors = EXECUTORS.map((name) => groups.find((g) => g.name === name && g.levels.length > 0)).filter((g): g is ModelGroup => g != null);
  return { planners, executors };
}

/** Whether agy's list offers Orchestrator: one of its rows, a planner and an executor. */
export function offersOrchestrator(ids: readonly string[], groups: readonly ModelGroup[]): boolean {
  const { planners, executors } = orchestratorRoles(groups);
  return ids.some(isOrchestratorRow) && planners.length > 0 && executors.length > 0;
}

/**
 * A model's level when it is picked for a role: the one it was at, if it has
 * it, else high (agy's own start), else its highest.
 */
function variantAt(g: ModelGroup, level: string): string {
  const at = g.levels.includes(level) ? level : g.levels.includes("high") ? "high" : g.levels[g.levels.length - 1];
  return g.ids.get(at)!;
}

/** What a click on Orchestrator picks when it is not in use: agy's first planner and executor, each at high. */
export function defaultOrchestrator(groups: readonly ModelGroup[]): Orchestration | null {
  const { planners, executors } = orchestratorRoles(groups);
  if (!planners.length || !executors.length) return null;
  return { planner: variantAt(planners[0], "high"), executor: variantAt(executors[0], "high") };
}

/**
 * `o` with its `role` on the next model of that role (`step` 1 or -1, round
 * the list), at the level it was at if the new one has it.
 */
export function stepRole(groups: readonly ModelGroup[], o: Orchestration, role: keyof Orchestration, step: number): Orchestration {
  const choices = orchestratorRoles(groups)[role === "planner" ? "planners" : "executors"];
  if (!choices.length) return o;
  const now = groupOf(choices, o[role]);
  const index = now ? choices.indexOf(now) : -1;
  const next = choices[(index + step + choices.length) % choices.length];
  return { ...o, [role]: variantAt(next, levelOf(groups, o[role])) };
}

/** `o` with its `role` at `level`, when that model has it. */
export function withRoleLevel(groups: readonly ModelGroup[], o: Orchestration, role: keyof Orchestration, level: string): Orchestration {
  const g = groupOf(groups, o[role]);
  return g?.ids.has(level) ? { ...o, [role]: g.ids.get(level)! } : o;
}

/** Whether `model` is an Orchestrator pick agy's list still allows (both its models listed in their role). */
export function orchestratorListed(ids: readonly string[], groups: readonly ModelGroup[], model: string): boolean {
  const o = parseOrchestrator(model);
  if (!o || !offersOrchestrator(ids, groups)) return false;
  const { planners, executors } = orchestratorRoles(groups);
  return groupOf(planners, o.planner) != null && groupOf(executors, o.executor) != null;
}

/**
 * A role's model as said beside the other's: Gemini 4's by their own names
 * ("Neon"), the others whole without whose they are ("Sonnet 5.5").
 */
export function roleName(id: string): string {
  const base = splitEffort(id)?.base ?? id;
  return prettyModel(base, true).replace(/^Gemini 4 /, "");
}

/** The model button's name for an Orchestrator pick: "Orchestrator · Neon → Hydrogen". */
export function orchestratorName(o: Orchestration): string {
  return `Orchestrator · ${roleName(o.planner)} → ${roleName(o.executor)}`;
}
