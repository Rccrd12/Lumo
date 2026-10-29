// Listening: Claude waits for GitHub without holding the chat open. An answer
// writes `[[listen owner/repo#12 ready: merge it]]` (chat.rs
// listen_tool_note); the chat takes those lines out and hands them to Rust
// (listen.rs), which asks GitHub now and then and says `listen-fired` once the
// pull request got there. `[[listen owner/repo#12 every checks: …]]` listens
// every time: once for each new commit, until the pull request is merged or
// closed. The chat's Listening panel (views/listening.ts) shows them all, and
// starts one by hand. Pure helpers, so they can be tested without a webview.

import { N_, t } from "../i18n/i18n";
import { pillDefinition } from "./pills";

/** GitHub's colour (its pill's), for what the island says about listening. */
export const LISTEN_COLOR = pillDefinition("integration_github")?.color ?? "#F4505E";

/** What a watch waits for (listen.rs UNTILS). */
export type ListenUntil = "checks" | "green" | "approved" | "ready" | "merged" | "closed";
export const LISTEN_UNTILS: ListenUntil[] = ["checks", "green", "approved", "ready", "merged", "closed"];

/** Once: it ends when it fires. Every: once for each new commit (listen.rs MODES). */
export type ListenMode = "once" | "every";
/** What can listen every time (listen.rs EVERY_UNTILS). */
export const EVERY_UNTILS: ListenUntil[] = ["checks", "green"];

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
  /** Where it listens: "github.pr" for now. */
  source?: string;
  mode?: ListenMode;
  /** Paused from the Listening panel. */
  paused?: boolean;
  /** How many times it fired (listening every time). */
  fired?: number;
}

/** A watch that ended: what it waited for happened (`met`), or no longer can. */
export interface ListenFired {
  watch: ListenWatch;
  met: boolean;
  /** What happened, in the user's language. */
  summary: string;
  /** Over (false: it listens every time and goes on). */
  ended?: boolean;
}

/** What fired, for the Listening panel's history (listen.rs Past). */
export interface ListenPast {
  watch: ListenWatch;
  met: boolean;
  summary: string;
  at: number;
}

export interface ListenAsk {
  repo: string;
  number: number;
  until: ListenUntil;
  mode: ListenMode;
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
  unread: N_("Lumo couldn't start listening to: {what}"),
};

/** What each event is called in the Listening panel, as "when …". */
export const UNTIL_TEXT: Record<ListenUntil, string> = {
  checks: N_("Its checks finish"),
  green: N_("Its checks pass"),
  approved: N_("It is approved"),
  ready: N_("It is ready to merge"),
  merged: N_("It is merged"),
  closed: N_("It is closed"),
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

/** Words before the event that mean listening every time. */
const EVERY_WORDS = new Set(["every", "each", "always", "everytime"]);

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
function readUntil(rest: string): { until: ListenUntil; mode: ListenMode; task: string } | null {
  const colon = rest.indexOf(":");
  const head = (colon < 0 ? rest : rest.slice(0, colon)).trim().replace(/^[-–—,]\s*/, "");
  const task = colon < 0 ? "" : rest.slice(colon + 1).trim();
  const words = head ? head.split(/\s+/) : [];
  // `every checks`: once for each new commit.
  let mode: ListenMode = "once";
  if (words.length > 0 && EVERY_WORDS.has(words[0].toLowerCase())) {
    words.shift();
    mode = "every";
  }
  if (words.length === 0) return { until: LISTEN_DEFAULT, mode, task };
  const first = words[0].toLowerCase();
  // `merge` alone means merged; `merge it` is what to do, with no event.
  const until = UNTIL_WORDS[first] ?? (words.length === 1 ? ALONE_WORDS[first] : undefined);
  if (!until) return null;
  // What can't happen again listens once.
  if (!EVERY_UNTILS.includes(until)) mode = "once";
  // `[[listen o/r#3 ready merge it]]`: what follows the event, without a colon.
  const more = words.slice(1).join(" ");
  return { until, mode, task: task || more };
}

/** The pull request a person typed (`owner/repo#12`, a link…), for the Listening panel. */
export function readPullRequest(text: string): { repo: string; number: number } | null {
  const ref = readRef(text);
  return ref && !ref.rest.trim() ? { repo: ref.repo, number: ref.number } : null;
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
    if (ref && asked) listens.push({ repo: ref.repo, number: ref.number, until: asked.until, mode: asked.mode, task: asked.task });
    else unread.push(all.replace(/`/g, "").trim());
    return GONE;
  });
  // The line's own row, and a code block that only held it.
  out = out.replace(/^[ \t]*(?:\u0000[ \t]*)+(?:\n|$)/gm, "").replaceAll(GONE, "");
  // (Not a block closing right before another opens: "```" then "```lumo-file x".)
  out = out.replace(/```[A-Za-z]*[ \t]*\n?\s*```(?![\w-])[ \t]*\n?/g, "");
  out = out.replace(/`{0,3}\[\[(?:(?!\]\]).)*$/, "");
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), listens, stops, unread };
}

/** What the chat sends Claude once a watch with something to do ends. */
export function listenMessage(fired: ListenFired): string {
  return `GitHub: ${fired.summary}\n${fired.watch.task}`;
}

/** The watches that are on: not paused. */
export function activeWatches(watches: ListenWatch[]): ListenWatch[] {
  return watches.filter((w) => !w.paused);
}

/** The closed island's line while Lumo listens, or null while it does not. */
export function listeningLine(all: ListenWatch[]): string | null {
  const watches = activeWatches(all);
  if (watches.length === 0) return null;
  if (watches.length > 1) return t(LISTEN_TEXT.many, { count: watches.length });
  const w = watches[0];
  return t(LISTEN_TEXT[w.until] ?? LISTEN_TEXT.merged, { pr: `#${w.number}` });
}
