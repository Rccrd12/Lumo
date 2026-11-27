// Who plays the orchestra's two roles (Settings.orchestraCoordinator and
// orchestraThread): any provider for the threads, the CLIs too (they get the
// orchestra's tools from lumo-hook); for the coordinator an API provider, a
// local model or Claude Code, the one CLI whose own tools Lumo can take away
// (orchestra.rs claude_code_args). Pure helpers for the model picker
// (views/chat-models.ts) and the orchestra view (views/orchestra.ts).

import { isCliProvider, modelFor, providerDef, visibleProviders, type ProviderDef } from "./providers";
import { prettyModel } from "./model-names";
import type { OrchestraPick, Settings } from "./state";

export type OrchestraRole = "coordinator" | "thread";

/** The orchestra's colour: its chip's ring, the coordinator's mark (the concept's gold). */
export const ORCHESTRA_ACCENT = "#F2D38E";

/** The settings field that keeps `role`'s pick. */
export function roleField(role: OrchestraRole): "orchestraCoordinator" | "orchestraThread" {
  return role === "coordinator" ? "orchestraCoordinator" : "orchestraThread";
}

/** Whether provider `id` may take `role`: any for a thread; for the coordinator no CLI but Claude Code. */
export function orchestraAllowed(id: string, role: OrchestraRole = "coordinator"): boolean {
  if (providerDef(id).id !== id) return false;
  return role === "thread" || !isCliProvider(id) || id === "claude-code";
}

/** The providers the picker offers for `role`: those set up that may take it. */
export function orchestraProviders(settings: Settings, ready: ReadonlySet<string> | null, role: OrchestraRole = "coordinator"): ProviderDef[] {
  return visibleProviders(settings, ready).filter((p) => orchestraAllowed(p.id, role));
}

/**
 * `pick` with its blanks filled as orchestra.rs fills them: the chat's own
 * provider, its model and effort. A chat on a CLI lends nothing: the first
 * provider the picker offers instead (Anthropic when none is known).
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

/** The model button's words in orchestra mode: who coordinates, then who works ("Opus 5.5 → gemma-4-26b"). */
export function picksName(settings: Settings, ready: ReadonlySet<string> | null = null): string {
  const c = resolvePick(settings.orchestraCoordinator, settings, ready);
  const x = resolvePick(settings.orchestraThread, settings, ready, "thread");
  return `${shortModel(c.provider, c.model)} → ${shortModel(x.provider, x.model)}`;
}

/** The model button's dot in orchestra mode: half each role's colour. */
export function picksDot(settings: Settings, ready: ReadonlySet<string> | null = null): string {
  const c = providerDef(resolvePick(settings.orchestraCoordinator, settings, ready).provider).accent;
  const x = providerDef(resolvePick(settings.orchestraThread, settings, ready, "thread").provider).accent;
  return `linear-gradient(90deg, ${c} 50%, ${x} 50%)`;
}
