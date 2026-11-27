// Who plays a project's two roles: any provider for the threads, the CLIs too
// (they get the orchestra's tools from lumo-hook); for the coordinator an API
// provider, a local model or Claude Code, the one CLI whose own tools Lumo can
// take away (orchestra.rs claude_code_args). Settings.orchestraCoordinator and
// orchestraThread keep the last project's, for the next one. Pure helpers for
// the project's form (views/projects.ts) and the project view (views/orchestra.ts).

import { isCliProvider, modelFor, providerDef, visibleProviders, type ProviderDef } from "./providers";
import { prettyModel } from "./model-names";
import type { OrchestraPick, Settings } from "./state";

export type OrchestraRole = "coordinator" | "thread";

/** The projects' colour: their card's icon, the coordinator's mark (the concept's gold). */
export const ORCHESTRA_ACCENT = "#F2D38E";

/** Whether provider `id` may take `role`: any for a thread; for the coordinator no CLI but Claude Code. */
export function orchestraAllowed(id: string, role: OrchestraRole = "coordinator"): boolean {
  if (providerDef(id).id !== id) return false;
  return role === "thread" || !isCliProvider(id) || id === "claude-code";
}

/** The providers the form offers for `role`: those set up that may take it. */
export function orchestraProviders(settings: Settings, ready: ReadonlySet<string> | null, role: OrchestraRole = "coordinator"): ProviderDef[] {
  return visibleProviders(settings, ready).filter((p) => orchestraAllowed(p.id, role));
}

/**
 * `pick` with its blanks filled as orchestra.rs fills them: the chat's own
 * provider, its model and effort. A chat on a CLI lends nothing: the first
 * provider the form offers instead (Anthropic when none is known).
 */
export function resolvePick(pick: OrchestraPick | undefined, settings: Settings, ready: ReadonlySet<string> | null = null, role: OrchestraRole = "coordinator"): OrchestraPick {
  const own = pick?.provider && orchestraAllowed(pick.provider, role) ? pick.provider : "";
  const chat = orchestraAllowed(settings.chatProvider, role) ? settings.chatProvider : "";
  const provider = own || chat || orchestraProviders(settings, ready, role)[0]?.id || "anthropic";
  const model = (own && pick?.model) || modelFor(settings, provider);
  const effort = own ? pick?.effort ?? "" : pick?.effort || (provider === settings.chatProvider ? settings.chatEffort : "");
  return { provider, model, effort };
}

/** A model's short name, as the rail and the buttons say it: "Opus 5.5", "gemma-4-26b". */
export function shortModel(provider: string, model: string): string {
  if (!model) return "";
  const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return provider === "anthropic" ? prettyModel(bare, true) : bare;
}
