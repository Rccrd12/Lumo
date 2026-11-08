// Settings → Updates → Beta versions: the rows of the beta's list (./updates.ts).

import type { BetaPull } from "../core/bridge";
import { h } from "../views/dom";
import { t } from "../i18n/i18n";

/** "just now", "5m", "3h", "2d". */
function ago(date: string): string {
  const diff = (Date.now() - new Date(date).getTime()) / 1000;
  if (!Number.isFinite(diff)) return "";
  if (diff < 60) return t("just now");
  if (diff < 3600) return t("{n}m", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("{n}h", { n: Math.floor(diff / 3600) });
  return t("{n}d", { n: Math.floor(diff / 86400) });
}

/** A version with a pre-release part, 0.18.1-312: a beta build. */
export function isBetaVersion(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version.trim());
}

/** One pull request of the beta's list; one left out says what it conflicts with. */
export function pullRow(pr: BetaPull, left: boolean): HTMLElement {
  let state = ago(pr.updatedAt);
  if (left && pr.reason === "checks") state = t("left out: its checks fail");
  else if (left && pr.reason === "pending") state = t("left out: its checks are still running");
  else if (left && pr.with === "main") state = t("left out: conflicts with main");
  else if (left && pr.with) state = t("left out: conflicts with #{number}", { number: pr.with });
  else if (left) state = t("left out: conflicts with the other changes");
  return h("div", { class: left ? "pill-row full" : "pill-row" },
    h("span", { class: left ? "tag warn" : "tag", text: `#${pr.number}` }),
    h("span", { class: "name", text: pr.title }),
    h("span", { class: "state", style: left ? "color:var(--amber)" : "", text: state }),
  );
}
