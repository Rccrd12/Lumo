// Plan usage in the island: the Claude and Codex pills in the header and the
// card behind each. Same behaviour as ClaudePlanHeaderPill, ClaudePlanCardView
// and CodexPlanCardView on the Mac; the numbers and labels come from
// core/plan.ts.
//
// The pills sit in the header's right side, before the gear, on the overview
// only, Claude first. Clicking one puts its card in place of the overview's
// left card (clicking it again, or the other pill, closes or swaps it), and
// Mochi wears the plan's colour while it is open. It closes when the view, the
// mode or the focused pill changes.

import { Bridge } from "../core/bridge";
import {
  mergeWindow, parseClaudePlan, PLAN_TEXT, claudeSubtitle, codexIsStale, codexResetsLabel, codexSubtitle, dominantPct,
  effectivePct, parseCodexPlan, pillLabel, planColor, resetLabel,
  type CodexPlanUsage, type PlanUsage, type PlanWindow,
} from "../core/plan";
import { State } from "../core/state";
import { USAGE_TEXT } from "../core/chat-usage";
import { clear, dot, h, svg } from "./dom";
import { ICONS } from "./icons";
import { language, t, tl } from "../i18n/i18n";

/** The Claude pill is in the header: overview, turned on, relay in. */
export function claudePillVisible(): boolean {
  const s = State.settings;
  return State.view === "overview" && s.showPlanInNotch && s.planRelayInstalled;
}

/** The Codex pill is in the header: overview, turned on (nothing to install). */
export function codexPillVisible(): boolean {
  return State.view === "overview" && State.settings.showCodexPlanInNotch;
}

/** A plan card is open and its pill is still there. */
export function planCardOpen(): boolean {
  if (!State.showingPlanDetail) return false;
  return State.planDetailIsCodex ? codexPillVisible() : claudePillVisible();
}

const claudeColor = (now = Date.now()) => planColor(dominantPct(State.planUsage, now));
const codexColor = (now = Date.now()) => planColor(dominantPct(State.codexPlanUsage, now));

/** The colour of the open card's plan, which Mochi wears while it is open. */
export function openPlanColor(): string {
  return State.planDetailIsCodex ? codexColor() : claudeColor();
}

/** Closes the plan card (view, mode or focus changed). */
export function closePlanCard(): void {
  State.showingPlanDetail = false;
}

// ── Claude numbers ────────────────────────────────────────────────────────────

const STORE_KEY = "lumo.claudePlanUsage";

/** New numbers from the status line; kept so they survive a restart, as on the Mac. */
export function setClaudePlanUsage(usage: PlanUsage): void {
  const prev = State.planUsage;
  const same = JSON.stringify([prev?.fiveHour, prev?.sevenDay]) === JSON.stringify([usage.fiveHour, usage.sevenDay]);
  State.planUsage = usage;
  if (!same) {
    try {
      window.localStorage?.setItem(STORE_KEY, JSON.stringify(usage));
    } catch {
      // Storage off or full: the numbers just will not outlive this run.
    }
  }
  // The relay calls in with every Claude Code update: a hidden island is only
  // woken when the numbers actually moved.
  if (!same || State.mode === "expanded") State.notify();
}

/**
 * New plan numbers: from the status line relay, a chat answer, or Anthropic.
 * Any of them may report one window only (Claude Code leaves the 5-hour one
 * out while it is far from its limit): the window left out is kept from
 * before, never dropped.
 */
export function keepPlanUsage(rateLimits: unknown) {
  const usage = parseClaudePlan(rateLimits);
  if (!usage) return;
  const prev = State.planUsage;
  const merged: PlanUsage = { updatedAt: usage.updatedAt };
  const fiveHour = mergeWindow(usage.fiveHour, prev?.fiveHour);
  const sevenDay = mergeWindow(usage.sevenDay, prev?.sevenDay);
  if (fiveHour) merged.fiveHour = fiveHour;
  if (sevenDay) merged.sevenDay = sevenDay;
  setClaudePlanUsage(merged);
}

// ── From Anthropic (Settings → Agents → Plan usage → Ask Anthropic) ─────────

/** How often the numbers are asked again while the island is open. */
const ONLINE_EVERY_MS = 3 * 60_000;
let onlineAt = 0;
let onlineInFlight = false;
/** The Claude card's Refresh: at work, or why the last ask failed. */
let claudeRefresh: { busy: boolean; error: string | null } = { busy: false, error: null };

/**
 * Asks Anthropic, with Claude Code's sign-in, for the plan's usage: only when
 * turned on, never while paused, at most every 3 minutes unless `force` (the
 * card's Refresh).
 */
export function refreshClaudePlanOnline(force = false): void {
  if (!State.settings.planUsageOnline || State.paused || onlineInFlight) return;
  if (!force && Date.now() - onlineAt < ONLINE_EVERY_MS) return;
  onlineInFlight = true;
  onlineAt = Date.now();
  const started = Date.now();
  if (force) {
    claudeRefresh = { busy: true, error: null };
    State.notify();
  }
  let error: string | null = null;
  void Bridge.planUsageFetch()
    .then((limits) => keepPlanUsage(limits))
    .catch((err) => {
      error = String(err).replace(/^Error:\s*/, "");
    })
    .finally(() => {
      window.setTimeout(() => {
        onlineInFlight = false;
        claudeRefresh = { busy: false, error };
        State.notify();
      }, force ? Math.max(0, 500 - (Date.now() - started)) : 0);
    });
}

let pollTimer: number | null = null;

/** While the island is open, the numbers are asked again every 3 minutes; never while it is shut. */
export function startPlanUsagePolling(): void {
  State.subscribe(() => {
    const want = State.mode === "expanded" && State.settings.planUsageOnline && !State.paused;
    if (want && pollTimer == null) {
      refreshClaudePlanOnline();
      pollTimer = window.setInterval(() => refreshClaudePlanOnline(), ONLINE_EVERY_MS);
    } else if (!want && pollTimer != null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  });
}

/** The last numbers seen, if any were kept. */
export function storedClaudePlanUsage(): string | null {
  try {
    return window.localStorage?.getItem(STORE_KEY) ?? null;
  } catch {
    return null;
  }
}

// ── Codex numbers ─────────────────────────────────────────────────────────────

let codexInFlight = false;
/** The Codex card's Refresh: whether it is at work, and whether its last answer brought nothing. */
let codexRefresh: { busy: boolean; failed: boolean } = { busy: false, failed: false };

/**
 * Asks Codex again when the numbers are missing or older than a minute (or
 * at once: the card's Refresh). Only from the pill (shown or clicked) and its
 * card, never on a timer, and never while paused: `codex app-server` talks to
 * Codex's own service.
 */
export function refreshCodexPlanUsage(force = false): void {
  if (codexInFlight || State.paused || (!force && !codexIsStale(State.codexPlanUsage))) return;
  codexInFlight = true;
  const started = Date.now();
  if (force) {
    codexRefresh = { busy: true, failed: false };
    State.notify();
  }
  void Bridge.codexPlanUsage()
    .then((result) => {
      const usage = parseCodexPlan(result);
      if (usage) State.codexPlanUsage = usage;
      if (force) codexRefresh = { busy: true, failed: !usage };
    })
    .finally(() => {
      // The turning stays long enough to be seen.
      window.setTimeout(() => {
        codexInFlight = false;
        if (force) codexRefresh = { ...codexRefresh, busy: false };
        State.notify();
      }, Math.max(0, 500 - (Date.now() - started)));
    });
}

// ── Pill ──────────────────────────────────────────────────────────────────────

export interface PlanPill {
  el: HTMLElement;
  sync(): void;
}

/** One pill: colour dot and label, lit while hovered or while its card is open. */
export function buildPlanPill(codex: boolean): PlanPill {
  const label = h("span", { class: "plan-pill-label" });
  const dotEl = h("i", { class: "plan-pill-dot" });
  const isOpen = () => State.showingPlanDetail && State.planDetailIsCodex === codex;
  const el = h("button", {
    class: "plan-pill",
    title: codex ? tl("Codex plan usage") : tl("Claude plan usage"),
    onclick: () => {
      const open = isOpen();
      State.planDetailIsCodex = codex;
      State.showingPlanDetail = !open;
      if (codex) refreshCodexPlanUsage();
      State.notify();
    },
  }, dotEl, label);
  return {
    el,
    sync() {
      const color = codex ? codexColor() : claudeColor();
      el.style.setProperty("--plan", color);
      el.classList.toggle("active", isOpen());
      dotEl.style.background = color;
      label.textContent = codex
        ? pillLabel("Codex", State.codexPlanUsage)
        : pillLabel("Claude", State.planUsage);
    },
  };
}

// ── Card ──────────────────────────────────────────────────────────────────────

/**
 * One limit, on three lines so nothing is cut: its name and how much is used,
 * a bar across the card, and when it resets, in words ("Resets in 3 h 31").
 */
function gaugeRow(label: string, w: PlanWindow | undefined, weekly: boolean, now: number, quietWhenMissing = false): HTMLElement {
  const top = h("div", { class: "plan-gauge-head" }, h("span", { class: "plan-label", text: label }));
  const block = h("div", { class: "plan-gauge" }, top);
  if (!w && quietWhenMissing) {
    // Claude Code leaves the 5-hour window out while it is far from its limit.
    top.append(h("span", { class: "plan-pct", text: PLAN_TEXT.plentyLeft }));
    block.append(
      h("span", { class: "plan-bar" }, h("i", { class: "plan-fill" })),
      h("span", { class: "plan-reset" }, svg(ICONS.clock, 10, { stroke: 2 }), h("span", { text: PLAN_TEXT.onlyNearLimit })),
    );
    return block;
  }
  if (!w) {
    top.append(h("span", { class: "plan-none", text: PLAN_TEXT.none }));
    return block;
  }
  const pct = effectivePct(w, now);
  const fill = h("i", { class: "plan-fill" });
  fill.style.width = `${pct}%`;
  fill.style.background = planColor(pct);
  const low = w.low && w.resetsAt > now;
  top.append(h("span", { class: "plan-pct", text: low ? PLAN_TEXT.plentyLeft : `${Math.round(pct)}%` }));
  block.append(
    h("span", { class: "plan-bar" }, fill),
    h("span", { class: "plan-reset" },
      svg(ICONS.clock, 10, { stroke: 2 }),
      h("span", { text: w.resetsAt > now ? USAGE_TEXT.resets(resetLabel(w, weekly, now)) : PLAN_TEXT.resetting })),
  );
  return block;
}

function head(color: string, title: string, subtitle: string): HTMLElement {
  return h("div", { class: "plan-head" },
    dot(color, 7),
    h("span", { class: "plan-title", text: title }),
    h("span", { class: "plan-sub", text: subtitle }),
  );
}

/** The card that stands in for the overview's left card while a pill is open. */
export class PlanCard {
  readonly el = h("div", { class: "plan-card" });
  private key = "";

  /** Re-renders when the numbers change, or every 30 s for the countdowns. */
  sync(now = Date.now()) {
    const codex = State.planDetailIsCodex;
    const u = codex ? State.codexPlanUsage : State.planUsage;
    const key = `${language()}|${codex}|${JSON.stringify(u)}|${JSON.stringify(codexRefresh)}|${JSON.stringify(claudeRefresh)}|${State.settings.planUsageOnline}|${Math.floor(now / 30_000)}`;
    if (key === this.key) return;
    this.key = key;
    clear(this.el);
    if (codex) this.drawCodex(State.codexPlanUsage, now);
    else this.drawClaude(State.planUsage, now);
  }

  private drawClaude(u: PlanUsage | null, now: number) {
    this.el.append(
      head(claudeColor(now), PLAN_TEXT.claudeTitle, claudeSubtitle(u, now)),
      h("div", { class: "plan-rows" },
        gaugeRow(PLAN_TEXT.fiveHours, u?.fiveHour, false, now, u?.sevenDay != null),
        gaugeRow(PLAN_TEXT.week, u?.sevenDay, true, now),
      ),
    );
    // Asked of Anthropic when turned on in Settings: Refresh asks at once.
    if (State.settings.planUsageOnline) {
      const busy = claudeRefresh.busy;
      const refresh = h("button", {
        class: busy ? "tool-action busy" : "tool-action",
        onclick: () => refreshClaudePlanOnline(true),
      },
      busy ? h("i", { class: "tool-spin" }) : svg(ICONS.arrowClockwise, 10, { stroke: 2.4 }),
      h("span", { text: busy ? tl("Refreshing…") : tl("Refresh") }));
      refresh.toggleAttribute("disabled", busy);
      const foot = h("div", { class: "plan-foot" }, refresh);
      if (!busy && claudeRefresh.error) foot.append(h("span", { class: "tool-note bad", text: claudeRefresh.error, title: claudeRefresh.error }));
      this.el.append(foot);
    }
  }

  private drawCodex(u: CodexPlanUsage | null, now: number) {
    const rows = h("div", { class: "plan-rows" });
    // Codex plans without a 5-hour window show the week alone, as on the Mac.
    if (u?.fiveHour) rows.append(gaugeRow(PLAN_TEXT.fiveHours, u.fiveHour, false, now));
    rows.append(
      gaugeRow(PLAN_TEXT.week, u?.sevenDay, true, now),
      h("div", { class: "plan-row" },
        h("span", { class: "plan-label", text: PLAN_TEXT.resets }),
        h("span", { class: "plan-credits", text: codexResetsLabel(u) }),
      ),
    );
    // Codex can be asked again at once (codex app-server): Refresh, which turns while it does.
    const busy = codexRefresh.busy;
    const refresh = h("button", {
      class: busy ? "tool-action busy" : "tool-action",
      onclick: () => refreshCodexPlanUsage(true),
    },
    busy ? h("i", { class: "tool-spin" }) : svg(ICONS.arrowClockwise, 10, { stroke: 2.4 }),
    h("span", { text: busy ? tl("Refreshing…") : tl("Refresh") }));
    refresh.toggleAttribute("disabled", busy);
    const foot = h("div", { class: "plan-foot" }, refresh);
    if (!busy && codexRefresh.failed) foot.append(h("span", { class: "tool-note bad", text: t("Codex did not answer") }));
    this.el.append(head(codexColor(now), PLAN_TEXT.codexTitle, codexSubtitle(u, now)), rows, foot);
  }
}
