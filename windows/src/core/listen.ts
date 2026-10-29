// Listening: Claude waits for something without holding the chat open. An answer
// writes `[[listen owner/repo#12 ready: merge it]]` (chat.rs
// listen_tool_note); the chat takes those lines out and hands them to Rust
// (listen.rs), which asks GitHub now and then and says `listen-fired` once the
// pull request got there. `[[listen owner/repo#12 every checks: …]]` listens
// every time: once for each new commit, until the pull request is merged or
// closed. The chat's Listening panel (views/listening.ts) shows them all, and
// starts one by hand. Besides GitHub, a watch can listen on this PC (listen_local.rs):
// `[[listen fs "C:\Users\me\Downloads" every download: sort it]]`,
// `[[listen process "node.exe" exited]]`, `[[listen web "https://…" contains "In stock"]]`.
// Pure helpers, so they can be tested without a webview.

import { N_, t } from "../i18n/i18n";
import { pillDefinition } from "./pills";

/** GitHub's colour (its pill's), for what the island says about listening. */
export const LISTEN_COLOR = pillDefinition("integration_github")?.color ?? "#F4505E";

/** What a watch on a pull request waits for (listen.rs UNTILS). */
export type PrUntil = "checks" | "green" | "approved" | "ready" | "merged" | "closed";
export const LISTEN_UNTILS: PrUntil[] = ["checks", "green", "approved", "ready", "merged", "closed"];

/** Where a watch listens (listen.rs SOURCES): GitHub, or on this PC. */
export type ListenSource = "github.pr" | "fs" | "process" | "web";
export type LocalSource = Exclude<ListenSource, "github.pr">;
export const LOCAL_SOURCES: LocalSource[] = ["fs", "process", "web"];

/** What a watch on this PC waits for, by source (listen_local.rs). */
export const LOCAL_UNTILS = {
  fs: ["created", "changed", "deleted", "download"],
  process: ["started", "exited", "port_open", "port_closed"],
  web: ["changed", "up", "down", "contains"],
} as const;
export type LocalUntil = (typeof LOCAL_UNTILS)[LocalSource][number];
export type ListenUntil = PrUntil | LocalUntil;

/** Each source's colour, for its tile and what the island says. */
export const SOURCE_COLOR: Record<LocalSource, string> = { fs: "#F5A524", process: "#2DD4A7", web: "#60A5FA" };

/** Once: it ends when it fires. Every: once for each new commit (listen.rs MODES). */
export type ListenMode = "once" | "every";
/** What can listen every time (listen.rs EVERY_UNTILS). */
export const EVERY_UNTILS: PrUntil[] = ["checks", "green"];

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
  /** Where it listens (older files: none, GitHub). */
  source?: ListenSource;
  /** What a watch on this PC names: a path, a program, a port, a link. */
  target?: string;
  /** The words a page is waited to show (web, contains). */
  text?: string;
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

/** A watch an answer asked for: on a pull request (`repo`, `number`), or on this PC (`source`, `target`). */
export interface ListenAsk {
  source: ListenSource;
  repo: string;
  number: number;
  target: string;
  text: string;
  until: ListenUntil;
  mode: ListenMode;
  task: string;
}

export interface ListenStop {
  source: ListenSource;
  repo: string;
  number: number;
  target: string;
}

export const LISTEN_TEXT = {
  checks: N_("Waiting for the checks on {pr}"),
  green: N_("Waiting for {pr} to pass its checks"),
  approved: N_("Waiting for {pr} to be approved"),
  ready: N_("Waiting for {pr} to be ready to merge"),
  merged: N_("Waiting for {pr} to be merged"),
  closed: N_("Waiting for {pr} to be closed"),
  many: N_("Listening to {count} pull requests"),
  manyThings: N_("Listening to {count} things"),
};

/** The closed island's line for a watch on this PC. */
const LOCAL_LISTEN_TEXT: Record<LocalSource, Record<string, string>> = {
  fs: {
    created: N_("Waiting for new files in {what}"),
    changed: N_("Waiting for changes in {what}"),
    deleted: N_("Waiting for files to go from {what}"),
    download: N_("Waiting for a download in {what}"),
  },
  process: {
    started: N_("Waiting for {what} to start"),
    exited: N_("Waiting for {what} to exit"),
    port_open: N_("Waiting for port {what} to open"),
    port_closed: N_("Waiting for port {what} to close"),
  },
  web: {
    changed: N_("Waiting for {what} to change"),
    up: N_("Waiting for {what} to be up"),
    down: N_("Waiting for {what} to go down"),
    contains: N_("Waiting for {what} to show “{text}”"),
  },
};

export const LISTEN_STRINGS = {
  unread: N_("Lumo couldn't start listening to: {what}"),
};

/** What each event is called in the Listening panel, as "when …". */
export const UNTIL_TEXT: Record<PrUntil, string> = {
  checks: N_("Its checks finish"),
  green: N_("Its checks pass"),
  approved: N_("It is approved"),
  ready: N_("It is ready to merge"),
  merged: N_("It is merged"),
  closed: N_("It is closed"),
};

/** The same, for a watch on this PC. */
export const LOCAL_UNTIL_TEXT: Record<LocalSource, Record<string, string>> = {
  fs: {
    created: N_("A new file appears"),
    changed: N_("Something changes"),
    deleted: N_("A file is deleted"),
    download: N_("A download finishes"),
  },
  process: {
    started: N_("It starts"),
    exited: N_("It exits"),
    port_open: N_("The port opens"),
    port_closed: N_("The port closes"),
  },
  web: {
    changed: N_("The page changes"),
    up: N_("It is back up"),
    down: N_("It goes down"),
    contains: N_("It shows a text"),
  },
};

/** Whether the watch listens on GitHub (older files say no source). */
export function onGitHub(w: { source?: ListenSource }): boolean {
  return !w.source || w.source === "github.pr";
}

/** What the event is called, as "when …", whatever the source. */
export function untilText(w: { source?: ListenSource; until: ListenUntil }): string {
  if (onGitHub(w)) return t(UNTIL_TEXT[w.until as PrUntil] ?? UNTIL_TEXT.merged);
  const text = LOCAL_UNTIL_TEXT[w.source as LocalSource]?.[w.until];
  return text ? t(text) : w.until;
}

/** A path's last name (`C:\Users\me\Downloads`: Downloads); a drive stays itself. */
function lastPart(path: string): string {
  const name = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return name && !name.endsWith(":") ? name : path;
}

/** How a watch is called (listen.rs label): owner/repo#12, a folder, a program, ":3000", a page. */
export function watchLabel(w: ListenWatch): string {
  if (onGitHub(w)) return `${w.repo}#${w.number}`;
  const target = w.target ?? "";
  if (w.source === "fs") return lastPart(target);
  if (w.source === "process") return w.until.startsWith("port_") ? `:${target}` : target;
  const rest = target.replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  return rest.length > 40 ? `${rest.slice(0, 39)}…` : rest;
}

/** What a model may write for each event (listen.rs UNTILS), small models included. */
const UNTIL_WORDS: Record<string, PrUntil> = {
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
const ALONE_WORDS: Record<string, PrUntil> = { merge: "merged", close: "closed" };

/** Without an event, Lumo waits for the checks to finish: what one waits for most. */
export const LISTEN_DEFAULT: PrUntil = "checks";

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
function readUntil(rest: string): { until: PrUntil; mode: ListenMode; task: string } | null {
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

/** Words a model may write for the sources on this PC. */
const SOURCE_WORDS: Record<string, LocalSource> = {
  fs: "fs", file: "fs", files: "fs", folder: "fs",
  process: "process", program: "process", port: "process", app: "process",
  web: "web", page: "web", url: "web", site: "web",
};

/**
 * A watch on this PC: `fs "C:\path" every download: task`,
 * `web "https://…" contains "In stock": task`. Null when it isn't one, or
 * names an event its source hasn't.
 */
function readLocal(body: string): { source: LocalSource; target: string; text: string; until: LocalUntil; mode: ListenMode; task: string } | null {
  const m = /^\s*([a-z]+)\s+["“]([^"”]+)["”]\s*(.*)$/is.exec(body);
  const source = m ? SOURCE_WORDS[m[1].toLowerCase()] : undefined;
  if (!m || !source) return null;
  let rest = m[3];
  // The text a page is waited to show, in quotes: before the colon, which it may hold.
  let text = "";
  const quoted = /["“]([^"”]*)["”]/.exec(rest);
  if (quoted && (rest.indexOf(":") < 0 || quoted.index < rest.indexOf(":"))) {
    text = quoted[1].trim();
    rest = rest.slice(0, quoted.index) + rest.slice(quoted.index + quoted[0].length);
  }
  const colon = rest.indexOf(":");
  const words = (colon < 0 ? rest : rest.slice(0, colon)).trim().split(/\s+/).filter(Boolean);
  const task = colon < 0 ? "" : rest.slice(colon + 1).trim();
  let mode: ListenMode = "once";
  if (words.length > 0 && EVERY_WORDS.has(words[0].toLowerCase())) {
    words.shift();
    mode = "every";
  }
  const until = (words[0] ?? "").toLowerCase() as LocalUntil;
  if (!(LOCAL_UNTILS[source] as readonly string[]).includes(until)) return null;
  if (until === "contains" && !text) return null;
  const more = words.slice(1).join(" ");
  return { source, target: m[2].trim(), text, until, mode, task: task || more };
}

/** `fs "C:\path"`: what `[[unlisten …]]` stops on this PC. */
function readLocalTarget(body: string): { source: LocalSource; target: string } | null {
  const m = /^\s*([a-z]+)\s+["“]([^"”]+)["”]/i.exec(body);
  const source = m ? SOURCE_WORDS[m[1].toLowerCase()] : undefined;
  return m && source ? { source, target: m[2].trim() } : null;
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
    const local = readLocalTarget(body);
    const ref = local ? null : readRef(body);
    if (un) {
      if (local) stops.push({ source: local.source, repo: "", number: 0, target: local.target });
      else if (ref) stops.push({ source: "github.pr", repo: ref.repo, number: ref.number, target: "" });
      else unread.push(all.replace(/`/g, "").trim());
      return GONE;
    }
    const here = local ? readLocal(body) : null;
    const asked = ref ? readUntil(ref.rest) : null;
    if (here) listens.push({ ...here, repo: "", number: 0 });
    else if (ref && asked) listens.push({ source: "github.pr", repo: ref.repo, number: ref.number, target: "", text: "", ...asked });
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
  return `${onGitHub(fired.watch) ? "GitHub" : "Lumo"}: ${fired.summary}\n${fired.watch.task}`;
}

/** What the island says before an event's summary: "GitHub", or the watch's own name. */
export function firedTitle(w: ListenWatch): string {
  return onGitHub(w) ? "GitHub" : watchLabel(w);
}

/** The colour of what the island says about a watch. */
export function watchColor(w: ListenWatch): string {
  return onGitHub(w) ? LISTEN_COLOR : SOURCE_COLOR[w.source as LocalSource] ?? LISTEN_COLOR;
}

/** The watches that are on: not paused. */
export function activeWatches(watches: ListenWatch[]): ListenWatch[] {
  return watches.filter((w) => !w.paused);
}

/** The closed island's line while Lumo listens, or null while it does not. */
export function listeningLine(all: ListenWatch[]): string | null {
  const watches = activeWatches(all);
  if (watches.length === 0) return null;
  if (watches.length > 1) return t(watches.every(onGitHub) ? LISTEN_TEXT.many : LISTEN_TEXT.manyThings, { count: watches.length });
  const w = watches[0];
  if (onGitHub(w)) return t(LISTEN_TEXT[w.until as PrUntil] ?? LISTEN_TEXT.merged, { pr: `#${w.number}` });
  const text = LOCAL_LISTEN_TEXT[w.source as LocalSource]?.[w.until];
  const what = w.source === "process" && w.until.startsWith("port_") ? (w.target ?? "") : watchLabel(w);
  return text ? t(text, { what, text: w.text ?? "" }) : watchLabel(w);
}
