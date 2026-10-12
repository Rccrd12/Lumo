// Listening: Claude waits for GitHub without holding the chat open. An answer
// writes `[[listen owner/repo#12 ready: merge it]]` (chat.rs
// listen_note); the chat takes those lines out and hands them to Rust
// (listen.rs), which asks GitHub now and then and says `listen-fired` once the
// pull request got there. Pure helpers, so they can be tested without a webview.

import { N_, t } from "../i18n/i18n";
import { pillDefinition } from "./pills";

/** GitHub's colour (its pill's), for what the island says about listening. */
export const LISTEN_COLOR = pillDefinition("integration_github")?.color ?? "#F4505E";

/** What a watch waits for (listen.rs UNTILS). */
export type ListenUntil = "checks" | "green" | "approved" | "ready" | "merged" | "closed";

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

export const LISTEN_STRINGS = {
  hint: N_("Lumo is listening to GitHub and will tell you. × stops listening."),
  unread: N_("Lumo couldn't start listening to: {what}"),
};

/** What a model may write for each event (listen.rs UNTILS), small models included. */
const UNTIL_WORDS: Record<string, ListenUntil> = {
  checks: "checks", check: "checks", ci: "checks", tests: "checks", done: "checks", finished: "checks", finish: "checks", completed: "checks", complete: "checks",
  green: "green", pass: "green", passed: "green", passing: "green", success: "green", succeeded: "green",
  approved: "approved", approve: "approved", approval: "approved", reviewed: "approved",
  ready: "ready", mergeable: "ready",
  merged: "merged",
  closed: "closed",
};

/** Verbs that are an event only on their own. */
const ALONE_WORDS: Record<string, ListenUntil> = { merge: "merged", close: "closed" };

/** Without an event, Lumo waits for the checks to finish: what one waits for most. */
export const LISTEN_DEFAULT: ListenUntil = "checks";

const NAME = "[A-Za-z0-9_.-]+";
/** `owner/repo#12`, `owner/repo #12`, `owner/repo/pull/12` or a link to the pull request. */
const PR_REFS = [
  new RegExp(`^(?:https?:\\/\\/)?(?:www\\.)?github\\.com\\/(${NAME}\\/${NAME})\\/pulls?\\/(\\d+)(?:\\/[\\w-]*)*`, "i"),
  new RegExp(`^(${NAME}\\/${NAME})\\/pulls?\\/(\\d+)`, "i"),
  new RegExp(`^(${NAME}\\/${NAME})\\s*#\\s*(\\d+)`, "i"),
];

/**
 * A line for Lumo, however it was written: in backticks, in the middle of a
 * sentence, with spaces. The text after the word is read by `readRef`.
 */
const MARKER_RE = /(`{0,3})[ \t]*\[\[\s*(un)?listen\b((?:(?!\]\]).)*)\]\][ \t]*\1[ \t]*/gi;

/** Where a line for Lumo was, until its row is taken out. */
const GONE = "\u0000";

function readRef(body: string): { repo: string; number: number; rest: string } | null {
  const text = body.trim().replace(/^[<(]/, "");
  for (const re of PR_REFS) {
    const m = re.exec(text);
    if (!m) continue;
    const repo = m[1].replace(/\.git$/i, "");
    const number = parseInt(m[2], 10);
    if (number > 0) return { repo, number, rest: text.slice(m[0].length).replace(/^[>)]/, "") };
  }
  return null;
}

/**
 * The event and what to do then, from what follows the pull request:
 * ` ready: merge it`, ` merged`, `: merge it` or nothing (the checks). An
 * event Lumo cannot watch is null, so the user is told instead of nothing
 * happening.
 */
function readUntil(rest: string): { until: ListenUntil; task: string } | null {
  const colon = rest.indexOf(":");
  const head = (colon < 0 ? rest : rest.slice(0, colon)).trim().replace(/^[-–—,]\s*/, "");
  const task = colon < 0 ? "" : rest.slice(colon + 1).trim();
  if (!head) return { until: LISTEN_DEFAULT, task };
  const words = head.split(/\s+/);
  const first = words[0].toLowerCase();
  // `merge` alone means merged; `merge it` is what to do, with no event.
  const until = UNTIL_WORDS[first] ?? (words.length === 1 ? ALONE_WORDS[first] : undefined);
  if (!until) return null;
  // `[[listen o/r#3 ready merge it]]`: what follows the event, without a colon.
  const more = words.slice(1).join(" ");
  return { until, task: task || more };
}

/**
 * The watches an answer asked for and the ones it stopped, and the answer
 * without those lines. A line Lumo cannot read is taken out too, and listed in
 * `unread`, so the chat can say so. A marker still being written (`[[lis…`)
 * is hidden, so it never flashes up while streaming.
 */
export function takeListens(text: string): { text: string; listens: ListenAsk[]; stops: ListenStop[]; unread: string[] } {
  const listens: ListenAsk[] = [];
  const stops: ListenStop[] = [];
  const unread: string[] = [];
  let out = text.replace(MARKER_RE, (all: string, _ticks: string, un: string | undefined, body: string) => {
    const ref = readRef(body);
    if (un) {
      if (ref) stops.push({ repo: ref.repo, number: ref.number });
      else unread.push(all.replace(/`/g, "").trim());
      return GONE;
    }
    const asked = ref ? readUntil(ref.rest) : null;
    if (ref && asked) listens.push({ repo: ref.repo, number: ref.number, until: asked.until, task: asked.task });
    else unread.push(all.replace(/`/g, "").trim());
    return GONE;
  });
  // The line's own row, and a code block that only held it.
  out = out.replace(/^[ \t]*(?:\u0000[ \t]*)+(?:\n|$)/gm, "").replaceAll(GONE, "");
  out = out.replace(/```[A-Za-z]*[ \t]*\n?\s*```[ \t]*\n?/g, "");
  out = out.replace(/`{0,3}\[\[(?:(?!\]\]).)*$/, "");
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), listens, stops, unread };
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
