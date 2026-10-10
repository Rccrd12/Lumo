// What the chat's provider has left, for the ring next to the model picker
// (Settings → Chat → "Show remaining usage in the chat") and the menu it
// opens. No DOM, so it can be tested on its own; views/chat.ts draws it.
//
// - Claude Code: the Claude plan's 5-hour and weekly limits, from the status
//   line relay (core/plan.ts), with the same labels and colours as the plan card.
// - Anthropic and OpenAI: the rate limits read off the chat's own answers
//   (src-tauri/src/chat_usage.rs, the `chat-usage` event). No call of their own.
// - OpenRouter: the key's credits, from its key endpoint (Bridge.chatUsage).
// - Google, the model servers and the custom one: nothing.

import { PLAN_TEXT, ageLabel, dominantPct, effectivePct, planColor, resetLabel, type PlanUsage, type PlanWindow } from "./plan";
import { providerDef } from "./providers";
import type { Settings } from "./state";
import { language, t } from "../i18n/i18n";

/** A rate limit bucket, as chat_usage.rs sends it. */
export interface Quota {
  remaining: number;
  limit?: number | null;
  /** Epoch ms. */
  resetsAt?: number | null;
}

/** An OpenRouter key's credits, in US dollars; no `limit` means no cap on the key. */
export interface Credits {
  remaining?: number | null;
  limit?: number | null;
  used?: number | null;
}

export interface ChatUsage {
  provider: string;
  tokens?: Quota;
  requests?: Quota;
  credits?: Credits;
}

/** A usage and when it arrived (epoch ms). */
export interface SeenUsage extends ChatUsage {
  at: number;
}

export const USAGE_TEXT = {
  pctLeft: (label: string, pct: number) => t("{label}: {pct}% left", { label, pct }),
  plenty: (label: string) => t("{label}: plenty left", { label }),
  tokens: (n: string) => t("Tokens left: {n}", { n }),
  requests: (n: string) => t("Requests left: {n}", { n }),
  creditsLeft: (n: string) => t("Credits left: {n}", { n }),
  creditsUsed: (n: string) => t("Credits used: {n}", { n }),
  resetsAt: (time: string) => t("Resets at {time}", { time }),
  get notYet() { return t("Plan usage: not reported yet"); },
  get notYetTitle() {
    return t("Claude Code reports your plan usage in its terminal sessions; its answers in the chat report it only now and then.");
  },
  usedPct: (pct: number) => t("{pct}% used", { pct }),
  resets: (when: string) => t("Resets {when}", { when }),
  get title() { return t("Usage"); },
  get setup() {
    const path = [t("Settings"), t("Agents"), t("Plan usage")].join(" → ");
    return t("Plan usage: install the relay in {path}", { path });
  },
};

/** One limit in the menu: what it is, how much of it is used, when it resets. */
export interface UsageRow {
  label: string;
  /** "42% used", "plenty left", "27.5K / 30K". */
  value: string;
  /** Used, 0–100, for the bar; null when not known. */
  pct: number | null;
  /** "Resets in 3 h 31", or null. */
  reset: string | null;
}

/** What the ring and its menu show. `setup`: a pointer to Settings rather than numbers. */
export interface UsageLine {
  /** Everything on one line: the ring's label, and the menu's when it has no rows. */
  text: string;
  title: string;
  /** The ring's colour; null for none. */
  color: string | null;
  /** How full the ring is: the most used of the limits, 0–100; null when not known. */
  pct: number | null;
  rows: UsageRow[];
  setup?: boolean;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 27500 → "27.5K" in the interface language. */
export function compact(n: number): string {
  try {
    return new Intl.NumberFormat(language(), { notation: "compact", maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(n);
  }
}

/** 8.5 → "$8.50". */
export function dollars(n: number): string {
  try {
    return new Intl.NumberFormat(language(), { style: "currency", currency: "USD" }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

function quotaText(q: Quota): string {
  return isNum(q.limit) ? `${compact(q.remaining)} / ${compact(q.limit)}` : compact(q.remaining);
}

/** How much of a bucket is used, 0–100, when its size is known. */
function usedPct(q: Quota | undefined): number | null {
  if (!q || !isNum(q.limit) || q.limit <= 0) return null;
  return Math.min(100, Math.max(0, 100 - (q.remaining / q.limit) * 100));
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(language(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function planLine(settings: Settings, plan: PlanUsage | null, now: number): UsageLine {
  if (!settings.planRelayInstalled) {
    return { text: USAGE_TEXT.setup, title: PLAN_TEXT.claudePillTitle, color: null, pct: null, rows: [], setup: true };
  }
  if (!plan || (!plan.fiveHour && !plan.sevenDay)) {
    return { text: USAGE_TEXT.notYet, title: USAGE_TEXT.notYetTitle, color: planColor(null), pct: null, rows: [] };
  }
  const parts: string[] = [];
  const rows: UsageRow[] = [];
  const add = (label: string, w: PlanWindow, weekly: boolean) => {
    const plenty = w.low && w.resetsAt > now;
    const used = effectivePct(w, now);
    const left = plenty ? USAGE_TEXT.plenty(label) : USAGE_TEXT.pctLeft(label, Math.round(100 - used));
    parts.push(`${left} (${resetLabel(w, weekly, now)})`);
    rows.push({
      label,
      value: plenty ? PLAN_TEXT.plentyLeft : USAGE_TEXT.usedPct(Math.round(used)),
      pct: used,
      reset: w.resetsAt > now ? USAGE_TEXT.resets(resetLabel(w, weekly, now)) : PLAN_TEXT.resetting,
    });
  };
  if (plan.fiveHour) add(PLAN_TEXT.fiveHours, plan.fiveHour, false);
  if (plan.sevenDay) add(PLAN_TEXT.week, plan.sevenDay, true);
  const pct = dominantPct(plan, now);
  return {
    text: parts.join(" · "),
    title: `${PLAN_TEXT.claudeTitle} · ${ageLabel(plan.updatedAt, now)}`,
    color: planColor(pct),
    pct,
    rows,
  };
}

function rateLine(seen: SeenUsage, now: number): UsageLine | null {
  const parts: string[] = [];
  const resets: string[] = [];
  const rows: UsageRow[] = [];
  for (const [q, label] of [[seen.tokens, USAGE_TEXT.tokens], [seen.requests, USAGE_TEXT.requests]] as const) {
    if (!q || !isNum(q.remaining)) continue;
    parts.push(label(quotaText(q)));
    const reset = isNum(q.resetsAt) && q.resetsAt > now ? USAGE_TEXT.resetsAt(clock(q.resetsAt)) : null;
    if (reset) resets.push(`${label(quotaText(q))} — ${reset}`);
    const pct = usedPct(q);
    rows.push({ label: label(quotaText(q)), value: pct == null ? "" : USAGE_TEXT.usedPct(Math.round(pct)), pct, reset });
  }
  if (parts.length === 0) return null;
  const pcts = [usedPct(seen.tokens), usedPct(seen.requests)].filter(isNum);
  const pct = pcts.length ? Math.max(...pcts) : null;
  return {
    text: parts.join(" · "),
    title: [...resets, ageLabel(seen.at, now)].join("\n"),
    color: pct == null ? null : planColor(pct),
    pct,
    rows,
  };
}

function creditsLine(seen: SeenUsage, now: number): UsageLine | null {
  const c = seen.credits;
  if (!c) return null;
  const title = ageLabel(seen.at, now);
  if (isNum(c.limit)) {
    const left = isNum(c.remaining) ? c.remaining : Math.max(0, c.limit - (c.used ?? 0));
    const pct = c.limit > 0 ? Math.min(100, Math.max(0, 100 - (left / c.limit) * 100)) : 100;
    const text = USAGE_TEXT.creditsLeft(`${dollars(left)} / ${dollars(c.limit)}`);
    return { text, title, color: planColor(pct), pct, rows: [{ label: text, value: USAGE_TEXT.usedPct(Math.round(pct)), pct, reset: null }] };
  }
  if (isNum(c.used)) {
    const text = USAGE_TEXT.creditsUsed(dollars(c.used));
    return { text, title, color: null, pct: null, rows: [{ label: text, value: "", pct: null, reset: null }] };
  }
  return null;
}

/**
 * The line for the chat's provider, or null when there is nothing to show:
 * the option is off, the provider tells nothing, or nothing has come back yet.
 */
export function usageLine(
  settings: Settings,
  plan: PlanUsage | null,
  seen: SeenUsage | undefined,
  now = Date.now(),
): UsageLine | null {
  if (!settings.chatShowUsage) return null;
  const provider = providerDef(settings.chatProvider).id;
  if (provider === "claude-code") return planLine(settings, plan, now);
  if (!seen || seen.provider !== provider) return null;
  if (provider === "anthropic" || provider === "openai") return rateLine(seen, now);
  if (provider === "openrouter") return creditsLine(seen, now);
  return null;
}

/** How long OpenRouter's numbers stay good when the chat opens again. */
export const OPENROUTER_STALE_MS = 60_000;
