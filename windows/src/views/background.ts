// The card of a program's sessions in the background (core/background.ts),
// in the overview when its pill has the front: how many run and on what, the
// last answer (a click lists them all), the errors, and that a permission
// request still comes up as a card.

import { h, dot } from "./dom";
import type { AgentTask } from "../core/state";
import {
  BACKGROUND_TEXT, answerText, backgroundLine, done, failed, progress, running,
  type BackgroundAnswer, type BackgroundCounts, type BackgroundInfo,
} from "../core/background";
import { t } from "../i18n/i18n";

/** The most sessions shown as dots on a row. */
export const MAX_LANES = 8;

/** A dot for each session running, up to MAX_LANES, four to a row. */
export function lanes(count: number): HTMLElement | null {
  if (count <= 0) return null;
  const el = h("span", { class: "bg-lanes", "aria-hidden": "true" });
  for (let i = 0; i < Math.min(count, MAX_LANES); i++) el.append(h("i", {}));
  return el;
}

/**
 * The line along a row's foot: how far along the batch is when the program
 * said how many questions in all, else a light running along it while any
 * session is at work.
 */
export function progressBar(c: BackgroundCounts): HTMLElement | null {
  const p = progress(c);
  if (p == null && c.running <= 0) return null;
  return h("span", { class: `bg-bar${p == null ? " flow" : ""}`, "aria-hidden": "true" },
    h("i", p == null ? {} : { style: `width:${(p * 100).toFixed(1)}%` }));
}

/** The rows the card shows, for the island's height. */
export function backgroundRows(info: BackgroundInfo): number {
  return 1 + (info.last ? 1 : 0) + (info.failed > 0 ? 1 : 0);
}

function row(
  color: string, name: string, sub: string, line: string, tone: "" | "ok" | "err", end: HTMLElement | null,
  onclick?: () => void, bar: HTMLElement | null = null,
): HTMLElement {
  return h(onclick ? "button" : "div", { class: "bg-row", ...(onclick ? { onclick } : {}) },
    h("div", { class: "bg-text" },
      h("div", { class: "bg-who" },
        dot(color, 8),
        h("span", { class: "n", text: name }),
        sub ? h("span", { class: "s", text: `· ${sub}` }) : null),
      h("div", { class: `bg-line${tone ? ` ${tone}` : ""}`, text: line })),
    end,
    bar);
}

/** "Done · cache: safe to delete": the subject is already on the row. */
function said(prefix: string, answer: BackgroundAnswer): string {
  const text = answerText(answer);
  return text ? `${prefix} · ${text}` : prefix;
}

export function buildBackgroundDetail(task: AgentTask, info: BackgroundInfo, openAnswers: () => void): HTMLElement {
  const over = task.state === "finished" || task.state === "error";
  const top = info.running > 0
    ? row(task.color, running(info.running), info.agent,
      info.subjects.filter(Boolean).join(" · ") || backgroundLine(info), "", lanes(info.running), undefined, progressBar(info))
    : row(over && info.done === 0 ? "var(--red)" : "var(--green)", over ? t("Done") : done(info.done), info.agent, backgroundLine(info), "", null,
      undefined, progressBar(info));
  const last = info.last
    ? row("var(--green)", t(BACKGROUND_TEXT.lastAnswer), info.last.subject, said(t("Done"), info.last), "ok", null, openAnswers)
    : null;
  const errors = info.failed > 0
    ? row("var(--red)", failed(info.failed), info.lastFailed?.subject ?? "", info.lastFailed ? said(t("Error"), info.lastFailed) : t("Error"), "err", null)
    : null;
  return h("div", { class: "bg-detail" },
    h("div", { class: "bg-label" },
      h("span", { text: `${task.name} · ${t(BACKGROUND_TEXT.inBackground)}` }),
      h("span", { class: "c", text: info.total ? `${info.done}/${info.total}` : String(info.done) })),
    h("div", { class: "bg-rows" }, top, last, errors),
    h("p", { class: "bg-note", text: t(BACKGROUND_TEXT.stillAsks) }));
}
