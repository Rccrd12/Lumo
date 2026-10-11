// Listening: Claude waits for GitHub without holding the chat open. An answer
// writes `[[listen owner/repo#12 ready: merge it]]` (claude_code.rs
// listen_note); the chat takes those lines out and hands them to Rust
// (listen.rs), which asks GitHub now and then and says `listen-fired` once the
// pull request got there. Pure helpers, so they can be tested without a webview.

import { N_, t } from "../i18n/i18n";
import { pillDefinition } from "./pills";

/** GitHub's colour (its pill's), for what the island says about listening. */
export const LISTEN_COLOR = pillDefinition("integration_github")?.color ?? "#F4505E";

/** What a watch waits for (listen.rs UNTILS). */
export type ListenUntil = "checks" | "green" | "approved" | "ready" | "merged" | "closed";

export const LISTEN_UNTILS: ListenUntil[] = ["checks", "green", "approved", "ready", "merged", "closed"];

/** A watch as Rust keeps it. */
export interface ListenWatch {
  id: number;
  /** "owner/repo" */
  repo: string;
  number: number;
  until: ListenUntil;
  /** What Claude meant to do then; empty: only tell the user. */
  task: string;
  chatId: string;
  startedAt: number;
}

/** A watch that ended: what it waited for happened (`met`), or no longer can. */
export interface ListenFired {
  watch: ListenWatch;
  met: boolean;
  /** What happened, in the user's language. */
  summary: string;
}

export interface ListenAsk {
  repo: string;
  number: number;
  until: ListenUntil;
  task: string;
}

export interface ListenStop {
  repo: string;
  number: number;
}

export const LISTEN_TEXT = {
  checks: N_("Waiting for the checks on {pr}"),
  green: N_("Waiting for {pr} to pass its checks"),
  approved: N_("Waiting for {pr} to be approved"),
  ready: N_("Waiting for {pr} to be ready to merge"),
  merged: N_("Waiting for {pr} to be merged"),
  closed: N_("Waiting for {pr} to be closed"),
  many: N_("Listening to {count} pull requests"),
};

const REPO = "([A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+)#(\\d+)";
const LISTEN_RE = new RegExp(`[ \\t]*\\[\\[\\s*listen\\s+${REPO}\\s+([a-z]+)\\s*(?::((?:(?!\\]\\]).)*))?\\]\\][ \\t]*\\n?`, "gi");
const UNLISTEN_RE = new RegExp(`[ \\t]*\\[\\[\\s*unlisten\\s+${REPO}\\s*\\]\\][ \\t]*\\n?`, "gi");

/**
 * The watches an answer asked for and the ones it stopped, and the answer
 * without those lines. A marker still being written (`[[lis…`) is hidden too,
 * so it never flashes up while streaming.
 */
export function takeListens(text: string): { text: string; listens: ListenAsk[]; stops: ListenStop[] } {
  const listens: ListenAsk[] = [];
  const stops: ListenStop[] = [];
  let out = text.replace(LISTEN_RE, (_all, repo: string, number: string, until: string, task?: string) => {
    const u = until.toLowerCase() as ListenUntil;
    const n = parseInt(number, 10);
    if (LISTEN_UNTILS.includes(u) && n > 0) listens.push({ repo, number: n, until: u, task: (task ?? "").trim() });
    return "";
  });
  out = out.replace(UNLISTEN_RE, (_all, repo: string, number: string) => {
    stops.push({ repo, number: parseInt(number, 10) });
    return "";
  });
  out = out.replace(/\[\[[^\]]*$/, "");
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), listens, stops };
}

/** What the chat sends Claude once a watch with something to do ends. */
export function listenMessage(fired: ListenFired): string {
  return `GitHub: ${fired.summary}\n${fired.watch.task}`;
}

/** The closed island's line while Lumo listens, or null while it does not. */
export function listeningLine(watches: ListenWatch[]): string | null {
  if (watches.length === 0) return null;
  if (watches.length > 1) return t(LISTEN_TEXT.many, { count: watches.length });
  const w = watches[0];
  return t(LISTEN_TEXT[w.until] ?? LISTEN_TEXT.merged, { pr: `#${w.number}` });
}
