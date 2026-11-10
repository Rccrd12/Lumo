// Who the chat can talk to — the island's side of chat.rs, OpenRouter and any
// OpenAI-compatible server included. Pure data and helpers, so they can be
// tested without a webview.

import type { Settings } from "./state";
import { N_ } from "../i18n/i18n";

export type ProviderId =
  | "anthropic" | "claude-code" | "antigravity-cli" | "codex" | "copilot-cli" | "cursor-cli" | "openai" | "google" | "openrouter"
  | "ollama" | "lmstudio" | "unsloth" | "custom";

export interface ProviderDef {
  id: ProviderId;
  /** Shown on the chip in the chat's model picker. */
  name: string;
  accent: string;
  /** Credential store entry of its key; null for the model servers. */
  key: string | null;
  /** Settings field holding a model server's address. */
  urlField: "ollamaUrl" | "lmstudioUrl" | "unslothUrl" | "customUrl" | null;
  defaultModel: string;
  /** When the saved model is not offered, the first one containing this is picked. */
  prefer: string | null;
}

export const PROVIDERS: readonly ProviderDef[] = [
  { id: "anthropic", name: "Anthropic", accent: "#E07950", key: "anthropic-api-key", urlField: null, defaultModel: "claude-opus-5-5", prefer: "opus" },
  // Claude Code itself, signed in with the user's Claude plan: no key (claude_code.rs).
  { id: "claude-code", name: "Claude Code", accent: "#D97757", key: null, urlField: null, defaultModel: "default", prefer: null },
  // Antigravity CLI (`agy`), signed in with the user's Google account: no key
  // (antigravity_cli.rs). The Antigravity pill's colour.
  { id: "antigravity-cli", name: "Antigravity CLI", accent: "#E879F9", key: null, urlField: null, defaultModel: "default", prefer: null },
  // Codex (`codex app-server`), signed in with the user's ChatGPT account: no
  // key (codex_chat.rs). The Codex pill's colour.
  { id: "codex", name: "Codex", accent: "#2DD4BF", key: null, urlField: null, defaultModel: "default", prefer: null },
  // GitHub Copilot CLI and Cursor's CLI, signed in with the user's own
  // accounts, over their Agent Client Protocol servers: no key (acp_chat.rs).
  // Their pills' colours.
  { id: "copilot-cli", name: "Copilot CLI", accent: "#818CF8", key: null, urlField: null, defaultModel: "default", prefer: null },
  { id: "cursor-cli", name: "Cursor CLI", accent: "#C0C4CC", key: null, urlField: null, defaultModel: "default", prefer: null },
  { id: "google", name: "Google", accent: "#4285F4", key: "google-api-key", urlField: null, defaultModel: "gemini-2.0-flash", prefer: "flash" },
  { id: "openai", name: "OpenAI", accent: "#10A37F", key: "openai-api-key", urlField: null, defaultModel: "gpt-4o", prefer: "mini" },
  { id: "openrouter", name: "OpenRouter", accent: "#6467F2", key: "openrouter-api-key", urlField: null, defaultModel: "openrouter/auto", prefer: null },
  { id: "ollama", name: "Ollama", accent: "#FACC15", key: null, urlField: "ollamaUrl", defaultModel: "", prefer: null },
  { id: "lmstudio", name: "LM Studio", accent: "#A3E635", key: null, urlField: "lmstudioUrl", defaultModel: "", prefer: null },
  // Unsloth Studio's server (llama-server underneath), with its sk-unsloth key (local_chat.rs).
  { id: "unsloth", name: "Unsloth Studio", accent: "#34D399", key: null, urlField: "unslothUrl", defaultModel: "", prefer: null },
  { id: "custom", name: N_("Custom server"), accent: "#C0C4CC", key: null, urlField: "customUrl", defaultModel: "", prefer: null },
];

/** Claude Code's effort levels (claude --effort), "" for its own default. */
export const EFFORTS = ["", "low", "medium", "high", "xhigh", "max"] as const;

/** Copilot CLI's efforts (acp_chat.rs COPILOT_EFFORTS, `--effort`), "" for its own default. */
export const COPILOT_EFFORTS = ["", "low", "medium", "high", "xhigh", "max"] as const;

/** Codex's reasoning efforts (codex_chat.rs EFFORTS), "" for its own default. */
export const CODEX_EFFORTS = ["", "low", "medium", "high", "xhigh"] as const;


/**
 * The providers that run a signed-in CLI on this computer (claude_code.rs,
 * antigravity_cli.rs, codex_chat.rs, acp_chat.rs): they say what they are doing as they go, and read a
 * file added mid-conversation from its path.
 */
export function isCliProvider(id: string): boolean {
  return id === "claude-code" || id === "antigravity-cli" || id === "codex" || id === "copilot-cli" || id === "cursor-cli";
}

/**
 * The providers the chat calls by their API with the user's key (claude.rs,
 * openai_compat.rs): Anthropic, Google AI, OpenAI and OpenRouter.
 */
export function isApiProvider(id: string): boolean {
  return PROVIDERS.some((p) => p.id === id && p.key !== null);
}

/**
 * The providers whose actions are Lumo's own tools, run on this computer as
 * the chat's turn goes (tools.rs call_for_chat): the model servers, and the
 * providers called by their API. Their shield has the same four modes and the
 * sandbox behind them; the CLIs' have their own.
 */
export function usesLumoTools(id: string): boolean {
  return isApiProvider(id) || PROVIDERS.some((p) => p.id === id && p.urlField !== null);
}

/**
 * Whether the chat's shield is offered with `id`: the CLIs, and the model
 * servers and the providers called by their API, whose tools the modes hold too (local_chat.rs: Ask for approval
 * asks for every call of the user's tools and every web search or page read,
 * Approve for me asks for a trusted tool only when it is risky, Run
 * automatically never asks for a trusted tool that can run in the Windows
 * sandbox and otherwise asks as Approve for me does, Plan only gives none; a
 * tool on Ask every time always asks; see permissionModesFor).
 */
export function hasPermissions(id: string): boolean {
  return isCliProvider(id) || usesLumoTools(id);
}

/**
 * What the chat's CLIs and model servers may do without asking
 * (Settings.chatPermissionMode, claude_code::permission_mode): ask for
 * everything, let the AI decide what is safe to do without asking (Claude
 * Code's auto mode), or only plan. With Antigravity CLI, Auto is Antigravity's
 * own Turbo preset: everything runs without asking (antigravity_cli.rs).
 * Claude Code never gets a mode that lets every action through. "off" is for
 * the model servers and the providers called by their API only (local_chat.rs,
 * tools.rs Asking): it never asks for what can run in the Windows sandbox
 * (Settings.localSandbox "high"), and otherwise asks as Auto does.
 */
export const PERMISSION_MODES = ["default", "auto", "off", "plan"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * The modes the chat offers with `provider`: the same three with every CLI,
 * and with a model server or a provider called by its API Run automatically
 * ("off") too.
 */
export function permissionModesFor(provider: string): PermissionMode[] {
  return usesLumoTools(provider) ? [...PERMISSION_MODES] : ["default", "auto", "plan"];
}

/**
 * The mode `v` is with `provider`. "acceptEdits", picked before Auto took its
 * place, reads as Auto; so does "turbo", picked before Auto took its place with
 * Antigravity CLI, which with any other provider asks every time. A mode the
 * provider does not offer ("off" with a CLI) asks every time.
 */
export function parsePermissionMode(v: unknown, provider: string): PermissionMode {
  if (v === "acceptEdits") return "auto";
  if (v === "turbo") return provider === "antigravity-cli" ? "auto" : "default";
  const mode = PERMISSION_MODES.includes(v as PermissionMode) ? (v as PermissionMode) : "default";
  return permissionModesFor(provider).includes(mode) ? mode : "default";
}

/**
 * How far a model server's tools are kept from the computer
 * (Settings.localSandbox, local_chat.rs): "low" is only Lumo's own guards
 * (tools.rs: Python's audit hook, Node's permission flags, no network
 * without a proxy), "high" runs them in a Windows AppContainer as well.
 */
export const SANDBOX_LEVELS = ["low", "high"] as const;
export type SandboxLevel = (typeof SANDBOX_LEVELS)[number];

/** The level `v` is: anything but "low" is "high". */
export function parseSandboxLevel(v: unknown): SandboxLevel {
  return v === "low" ? "low" : "high";
}

/**
 * What a local model can do, as its server says (local_models.rs Caps): null
 * or empty where it says nothing (an OpenAI-compatible server of another kind).
 * A provider called by its API has the same, from its model list
 * (`apiCaps`): the reasoning levels and the context only.
 */
export interface LocalCaps {
  vision: boolean | null;
  tools: boolean | null;
  /** The reasoning levels it takes ("off", "on", "low", "medium", "high"). */
  reasoning: string[];
  /** Tokens: the longest context it was made for, and the one it is loaded with (0: not said). */
  maxContext: number;
  loadedContext: number;
}

/** The caps of the model picked on each model server or API provider, once known (views/chat.ts). */
const localCaps = new Map<string, LocalCaps>();

/** Keeps what `provider`'s server said about its model picked; null forgets it. */
export function setLocalCaps(provider: string, caps: LocalCaps | null): void {
  if (caps) localCaps.set(provider, caps);
  else localCaps.delete(provider);
}

/** What the model picked on `provider` can do, when its server said. */
export function localCapsOf(provider: string): LocalCaps | undefined {
  return localCaps.get(provider);
}

/**
 * A model of an API provider's list as caps (chat.rs ModelInfo): the
 * reasoning levels it takes and its context, nothing of the rest.
 */
export function apiCaps(model: { reasoning?: string[]; context?: number } | undefined): LocalCaps | null {
  if (!model) return null;
  const reasoning = Array.isArray(model.reasoning) ? model.reasoning.filter((r) => typeof r === "string") : [];
  const context = typeof model.context === "number" && model.context > 0 ? model.context : 0;
  return { vision: null, tools: null, reasoning, maxContext: context, loadedContext: 0 };
}

/** "64k", "256k", "1M": a context size, short. */
export function contextSize(tokens: number): string {
  if (tokens >= 1024 * 1024) return `${Math.round(tokens / (1024 * 1024))}M`;
  if (tokens >= 1024) return `${Math.round(tokens / 1024)}k`;
  return String(tokens);
}

/**
 * The words next to a local model in the picker: what it can do, and its
 * context (loaded with / longest). Empty when its server said nothing.
 */
export function capsWords(caps: LocalCaps | undefined): string[] {
  if (!caps) return [];
  const words: string[] = [];
  if (caps.vision) words.push(N_("Images"));
  if (caps.tools) words.push(N_("Tools"));
  if (caps.reasoning.length > 0) words.push(N_("Thinking"));
  return words;
}

/** The context part of that line: "64k / 256k", "256k", or "" when unknown. */
export function capsContext(caps: LocalCaps | undefined): string {
  if (!caps || (!caps.loadedContext && !caps.maxContext)) return "";
  if (caps.loadedContext && caps.maxContext) return `${contextSize(caps.loadedContext)} / ${contextSize(caps.maxContext)}`;
  return contextSize(caps.loadedContext || caps.maxContext);
}

/**
 * The effort levels the picker offers for `id`; none for a provider without
 * any. Antigravity CLI has none to pick: each of its models carries its effort
 * in its name (`gemini-3.8-flash-low`), so the model is the choice. A local
 * model offers the reasoning levels its server says it takes; a provider
 * called by its API, those its model list says (apiCaps).
 */
export function effortsFor(id: string): readonly string[] {
  if (id === "claude-code") return EFFORTS;
  if (id === "codex") return CODEX_EFFORTS;
  if (id === "copilot-cli") return COPILOT_EFFORTS;
  const local = localCaps.get(id);
  if (local && local.reasoning.length > 0) return ["", ...local.reasoning];
  return [];
}

/** The effort the chat sends `id`: the saved one if that provider takes it, else its default (""). */
export function effortFor(id: string, saved: string | undefined): string {
  const effort = saved ?? "";
  return effortsFor(id).includes(effort) ? effort : "";
}

/** Credential store entry of the custom server's optional key. */
export const CUSTOM_SERVER_KEY = "openai-compatible-key";
/** Credential store entry of Unsloth Studio's key (local_chat.rs UNSLOTH_KEY). */
export const UNSLOTH_SERVER_KEY = "unsloth-studio-key";

export function providerDef(id: string): ProviderDef {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

/** The model the chat uses for the active provider. */
export function activeModel(settings: Settings): string {
  const p = providerDef(settings.chatProvider);
  if (p.id === "anthropic") return settings.model || p.defaultModel;
  return settings.chatModels[p.id] || p.defaultModel;
}

/** `settings` with `model` picked for `provider`. */
export function withModel(settings: Settings, provider: ProviderId, model: string): Settings {
  if (provider === "anthropic") return { ...settings, model };
  return { ...settings, chatModels: { ...settings.chatModels, [provider]: model } };
}

/**
 * The chips of the picker. With `ready` (chat.rs chat_providers: the providers
 * with a key in the credential store, and the CLIs installed with Lumo's hooks
 * in place) only those, and a model server once its address is set; the active
 * provider stays too, so the picker never hides where the chat goes. Without
 * it (not known yet, or no Rust to ask) every cloud provider shows, as before.
 */
export function visibleProviders(settings: Settings, ready: ReadonlySet<string> | null = null): ProviderDef[] {
  return PROVIDERS.filter((p) => {
    if (p.urlField) return settings[p.urlField] !== "" || settings.chatProvider === p.id;
    // A CLI the user took out of the chat (Settings → Chat → Show in the chat) stays out, unless in use.
    if (isHidden(settings, p.id) && settings.chatProvider !== p.id) return false;
    return ready == null || ready.has(p.id) || settings.chatProvider === p.id;
  });
}

/** Settings → Chat → "Show in the chat" turned off for this provider. */
export function isHidden(settings: Settings, id: string): boolean {
  return Array.isArray(settings.hiddenChatProviders) && settings.hiddenChatProviders.includes(id);
}

/** Whether any provider at all is set up, by the same rules (the active one aside). */
export function anyProviderReady(settings: Settings, ready: ReadonlySet<string>): boolean {
  return PROVIDERS.some((p) => (p.urlField ? settings[p.urlField] !== "" : ready.has(p.id) && !isHidden(settings, p.id)));
}

/** The model to keep once the list arrives: the saved one if offered, else a sensible one. */
export function pickModel(provider: ProviderDef, offered: string[], current: string): string | null {
  if (offered.length === 0) return null;
  if (offered.includes(current)) return current;
  // A bare alias saved before ("haiku") becomes the model it named.
  const named = /^[a-z]+$/.test(current) ? offered.find((id) => id.includes(`-${current}-`)) : undefined;
  if (named) return named;
  const preferred = provider.prefer ? offered.find((id) => id.includes(provider.prefer!)) : undefined;
  if (preferred) return preferred;
  return offered.includes(provider.defaultModel) ? provider.defaultModel : offered[0];
}

// ── Where an address points ───────────────────────────────────────────────────

/** Mirrors net.rs: this machine, by name or address. */
export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return h === "0.0.0.0" || h === "::1" || h === "::" || h === "::ffff:127.0.0.1" || h === "::ffff:7f00:1";
}

/**
 * Where a server address sends what you type: this machine, another one over
 * https, another one in clear text (http), or nowhere valid. An empty field
 * means the usual address on this machine.
 */
export type Exposure = "local" | "remote" | "remote-http" | "invalid";

export function urlExposure(raw: string): Exposure {
  const text = raw.trim();
  if (!text) return "local";
  let url: URL;
  try {
    url = new URL(text.includes("://") ? text : `http://${text}`);
  } catch {
    return "invalid";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "invalid";
  if (!url.hostname || url.username || url.password) return "invalid";
  if (isLoopbackHost(url.hostname)) return "local";
  return url.protocol === "https:" ? "remote" : "remote-http";
}
