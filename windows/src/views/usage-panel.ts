// The chat's usage menu (concepts/redesign, Usage A): the context as one bar
// split by what fills it, with its legend, then each limit of the plan as a
// bar with when it resets (views/chat.ts drawUsageMenu).

import { h } from "./dom";
import { contextBar, contextLegend } from "./context-card";
import { CONTEXT_STRINGS, formatTokens, parseContextReport, type ContextReport } from "../core/context-usage";
import type { UsageLine, UsageRow } from "../core/chat-usage";
import { planColor } from "../core/plan";
import { N_, t } from "../i18n/i18n";

const USAGE_PANEL_TEXT = {
  askContext: N_("See what fills the context"),
  lastContext: N_("As of the last /context in this chat"),
  about: N_("about {used} of {total}"),
};

/**
 * The context window of a model Antigravity CLI runs, by its name: agy does
 * not say it in the chat. Its own choice ("default") is a Gemini model. Null
 * for a model the island does not know.
 */
export function agyContextWindow(model: string): number | null {
  const m = model.trim().toLowerCase();
  if (!m || m === "default" || m.includes("gemini")) return 1_000_000;
  if (m.includes("claude")) return 200_000;
  return null;
}

/**
 * The last /context answer in the chat, and whether nothing was answered
 * after it (it still tells how the context stands); null when there is none.
 */
export function lastContextReport(messages: readonly { role: string; content: string }[]): { report: ContextReport; fresh: boolean } | null {
  let answersAfter = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const report = m.content.includes("Context Usage") ? parseContextReport(m.content) : null;
    if (report) return { report, fresh: answersAfter === 0 };
    answersAfter++;
  }
  return null;
}

/** A limit: its name, how much is used and when it resets, its bar. */
function limitRow(row: UsageRow, note?: string): HTMLElement {
  const fill = h("i", { class: "usage-limit-fill" });
  fill.style.width = `${Math.max(0, Math.min(100, row.pct ?? 0))}%`;
  if (row.pct != null) fill.style.background = planColor(row.pct);
  return h("div", { class: "usage-limit" },
    h("div", { class: "usage-limit-head" },
      h("span", { class: "usage-limit-label", text: row.label }),
      h("span", { class: "usage-limit-value", text: [row.value, row.reset].filter(Boolean).join(" · ") })),
    h("span", { class: "usage-limit-bar" }, fill),
    note ? h("span", { class: "usage-note", text: note }) : null);
}

export interface NewUsageInput {
  line: UsageLine;
  /** A local model: its one row is its context. */
  local: boolean;
  /** What fills the context, from the last /context; null when not asked yet. */
  report: { report: ContextReport; fresh: boolean } | null;
  /** How full the context is, as the chat's last answer said (Claude Code's stream); null when not known. */
  fill: { used: number; total: number; estimate?: boolean } | null;
  /** Asks Claude Code for /context; null where there is no such thing. */
  askContext: (() => void) | null;
}

/** The menu's sections, into `list` (emptied by the caller). */
export function drawNewUsage(list: HTMLElement, { line, local, report: last, fill, askContext }: NewUsageInput): void {
  // The context: split by what fills it when /context said so and nothing was
  // answered since; otherwise how full it is, as the last answer said.
  const report = last && (last.fresh || !fill) ? last.report : null;
  if (!report && fill && fill.total > 0) {
    const used = Math.max(0, Math.min(fill.used, fill.total));
    const bar = h("i", { class: "usage-limit-fill" });
    bar.style.width = `${(used / fill.total) * 100}%`;
    bar.style.background = "#3b9eff";
    list.append(h("div", { class: "usage-ctx" },
      h("div", { class: "usage-ctx-head" },
        h("span", { class: "usage-ctx-title", text: t(CONTEXT_STRINGS.title) }),
        h("span", { class: "usage-ctx-numbers", text: `${t(fill.estimate ? USAGE_PANEL_TEXT.about : CONTEXT_STRINGS.used, { used: formatTokens(used), total: formatTokens(fill.total) })} · ${t(CONTEXT_STRINGS.free, { free: formatTokens(fill.total - used) })}` })),
      h("span", { class: "usage-limit-bar" }, bar),
      askContext ? h("button", { class: "usage-ask-context small", type: "button", text: t(USAGE_PANEL_TEXT.askContext), onclick: askContext }) : null));
  } else if (report) {
    list.append(h("div", { class: "usage-ctx", title: t(USAGE_PANEL_TEXT.lastContext) },
      h("div", { class: "usage-ctx-head" },
        h("span", { class: "usage-ctx-title", text: t(CONTEXT_STRINGS.title) }),
        h("span", { class: "usage-ctx-numbers", text: `${t(CONTEXT_STRINGS.used, { used: formatTokens(report.used), total: formatTokens(report.total) })} · ${t(CONTEXT_STRINGS.free, { free: formatTokens(report.free) })}` })),
      contextBar(report),
      contextLegend(report)));
  } else if (askContext) {
    list.append(h("button", { class: "usage-ask-context", type: "button", text: t(USAGE_PANEL_TEXT.askContext), onclick: askContext }));
  }
  if (line.rows.length === 0) {
    list.append(h("div", { class: "picker-status", text: line.text }));
    return;
  }
  // A local model's one row is its context; anything else, the plan's limits under its name.
  const plan = line.title.split("\n").pop() ?? "";
  if (!local && plan) list.append(h("div", { class: "usage-kick", text: plan }));
  for (const [i, row] of line.rows.entries()) list.append(limitRow(row, i === 0 ? line.note : undefined));
}
