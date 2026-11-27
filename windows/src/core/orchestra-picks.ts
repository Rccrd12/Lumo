// Who plays the orchestra's two roles (Settings.orchestraCoordinator and
// orchestraThread): an API provider or a local model, never a CLI, which
// runs its own loop (orchestra.rs). Pure helpers for the model picker
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

/** Whether provider `id` may take a role: the providers called by their API and the model servers. */
export function orchestraAllowed(id: string): boolean {
  return !isCliProvider(id) && providerDef(id).id === id;
}

/** The providers the picker offers for a role: those set up, without the CLIs. */
export function orchestraProviders(settings: Settings, ready: ReadonlySet<string> | null): ProviderDef[] {
  return visibleProviders(settings, ready).filter((p) => orchestraAllowed(p.id));
}

/**
 * `pick` with its blanks filled as orchestra.rs fills them: the chat's own
 * provider, its model and effort. A chat on a CLI lends nothing: the first
 * provider the picker offers instead (Anthropic when none is known).
 */
export function resolvePick(pick: OrchestraPick | undefined, settings: Settings, ready: ReadonlySet<string> | null = null): OrchestraPick {
  const own = pick?.provider && orchestraAllowed(pick.provider) ? pick.provider : "";
  const chat = orchestraAllowed(settings.chatProvider) ? settings.chatProvider : "";
  const provider = own || chat || orchestraProviders(settings, ready)[0]?.id || "anthropic";
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
  const x = resolvePick(settings.orchestraThread, settings, ready);
  return `${shortModel(c.provider, c.model)} → ${shortModel(x.provider, x.model)}`;
}

/** The model button's dot in orchestra mode: half each role's colour. */
export function picksDot(settings: Settings, ready: ReadonlySet<string> | null = null): string {
  const c = providerDef(resolvePick(settings.orchestraCoordinator, settings, ready).provider).accent;
  const x = providerDef(resolvePick(settings.orchestraThread, settings, ready).provider).accent;
  return `linear-gradient(90deg, ${c} 50%, ${x} 50%)`;
}
