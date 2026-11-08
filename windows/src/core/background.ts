// Sessions another program starts on its own (the relay's `lumo_background`,
// hook/src/background.rs): a tool asking `claude -p` about a hundred files,
// eight at a time, an app built on the Agent SDK. Shown one by one, each would
// make its sounds and open the island on its answer, a hundred times over.
// Grouped (the default), each program gets one pill: how many are running and
// how many have answered, one sound when a batch starts and one when it ends.
//
// This file keeps the counts; island/hooks.ts shows them.

import { N_, tn } from "../i18n/i18n";

/** Settings → Agents → Background sessions. */
export type BackgroundMode = "grouped" | "single" | "hidden";

export function parseBackgroundMode(raw: unknown): BackgroundMode {
  return raw === "single" || raw === "hidden" ? raw : "grouped";
}

/** The pills of the groups: `bg_` and the program's name, made an id. */
export const BACKGROUND_PREFIX = "bg_";

/** A blue of its own, the same for every program: the sessions are not the user's. */
export const BACKGROUND_COLOR = "#60A5FA";

/** A session silent for this long is taken for gone (killed before it could say so). */
export const STALE_MS = 10 * 60_000;

/** Nothing running for this long and the batch is over: a lane picks up its next question in far less. */
export const QUIET_MS = 4_000;

/** How many questions in all the relay passed on, if a count. */
export function batchTotal(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

/** The program's name the relay gave, if it is one to show. */
export function launcherName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return name || null;
}

/** The pill of `launcher`'s sessions; the one for sessions with no name to give. */
export function backgroundGroupId(launcher: string | null): string {
  const slug = (launcher ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return BACKGROUND_PREFIX + slug;
}

export function isBackgroundGroup(id: string): boolean {
  return id.startsWith(BACKGROUND_PREFIX);
}

export interface BackgroundCounts {
  /** Sessions at work now. */
  running: number;
  /** Answers given (Stop) since the batch started. */
  done: number;
  /** Turns that ended on an error (StopFailure). */
  failed: number;
  /** How many questions the program said it asks in all (LUMO_BATCH_TOTAL), if it did. */
  total?: number | null;
}

/** One session's answer, or its error, and what it was about. */
export interface BackgroundAnswer {
  subject: string;
  text: string;
}

/** A batch as the island shows it: its counts and what goes on in it. */
export interface BackgroundInfo extends BackgroundCounts {
  /** What the running sessions are about (subjectOf their prompt), oldest first; "" where nothing could be told. */
  subjects: string[];
  /** The most sessions running at once in this batch. */
  peak: number;
  /** The agent they run: "Claude Code", "Codex"… */
  agent: string;
  last: BackgroundAnswer | null;
  lastFailed: BackgroundAnswer | null;
}

/** What an event is for the group's count. */
export type BackgroundEvent = "busy" | "done" | "failed" | "end";

/** What an event says besides its kind. */
export interface BackgroundDetail {
  /** What the session is about, from its prompt. */
  subject?: string;
  /** The answer, or the error. */
  text?: string;
  agent?: string;
  /** How many questions in all, as the program said. */
  total?: number;
}

interface Group {
  /** Running sessions: when each was last heard from, and what it is about. */
  running: Map<string, { at: number; subject: string }>;
  done: number;
  failed: number;
  peak: number;
  agent: string;
  total: number | null;
  last: BackgroundAnswer | null;
  lastFailed: BackgroundAnswer | null;
}

export class BackgroundRuns {
  private groups = new Map<string, Group>();

  /**
   * One event of a session of `id`'s. True when it starts a batch: the group
   * was not there, or had finished.
   */
  event(id: string, session: string, kind: BackgroundEvent, now: number, detail: BackgroundDetail = {}): boolean {
    let g = this.groups.get(id);
    const started = !g;
    if (!g) {
      g = { running: new Map(), done: 0, failed: 0, peak: 0, agent: "", total: null, last: null, lastFailed: null };
      this.groups.set(id, g);
    }
    if (detail.agent) g.agent = detail.agent;
    if (detail.total) g.total = detail.total;
    const subject = detail.subject || g.running.get(session)?.subject || "";
    switch (kind) {
      case "busy":
        g.running.set(session, { at: now, subject });
        g.peak = Math.max(g.peak, g.running.size);
        break;
      case "done":
        g.running.delete(session);
        g.done++;
        g.last = { subject, text: detail.text ?? "" };
        break;
      case "failed":
        g.running.delete(session);
        g.failed++;
        g.lastFailed = { subject, text: detail.text ?? "" };
        break;
      case "end":
        g.running.delete(session);
        break;
    }
    return started;
  }

  counts(id: string): BackgroundCounts | null {
    const g = this.groups.get(id);
    return g ? { running: g.running.size, done: g.done, failed: g.failed } : null;
  }

  info(id: string): BackgroundInfo | null {
    const g = this.groups.get(id);
    if (!g) return null;
    return {
      running: g.running.size, done: g.done, failed: g.failed, total: g.total, peak: g.peak, agent: g.agent,
      subjects: [...g.running.values()].map((r) => r.subject),
      last: g.last, lastFailed: g.lastFailed,
    };
  }

  /** Forgets the sessions silent for STALE_MS; the groups that lost one. */
  sweep(now: number): string[] {
    const changed: string[] = [];
    for (const [id, g] of this.groups) {
      let lost = false;
      for (const [session, r] of g.running) {
        if (now - r.at >= STALE_MS) {
          g.running.delete(session);
          lost = true;
        }
      }
      if (lost) changed.push(id);
    }
    return changed;
  }

  /** The batch is over: how it went (nothing running any more), and the group starts afresh next time. */
  close(id: string): BackgroundInfo | null {
    const info = this.info(id);
    this.groups.delete(id);
    return info && { ...info, running: 0, subjects: [] };
  }

  /** Forgets every group (tests). */
  clear(): void {
    this.groups.clear();
  }
}

/**
 * What a prompt is about, in a word or two: the last part of the first path in
 * it (`Folder: %LOCALAPPDATA%\Discord` → "Discord", `C:\x\notes.txt` →
 * "notes.txt"), else "" — a long prompt has no title to give.
 */
export function subjectOf(prompt: unknown): string {
  if (typeof prompt !== "string") return "";
  const path = prompt.match(/(?:%[A-Za-z_]+%|[A-Za-z]:|\\\\[^\s\\]+)(?:\\[^\\\r\n"'`,;<>|]+)+|(?:^|\s)(?:\/[\w.@-]+){2,}/);
  if (!path) return "";
  const parts = path[0].trim().split(/[\\/]/).filter(Boolean);
  // Folders may have spaces ("NVIDIA Corporation"); a file's name ends at its extension.
  const last = (parts.at(-1) ?? "").trim().replace(/^(\S+\.[A-Za-z0-9]{1,8})\s.*$/, "$1");
  return last.replace(/[.:?!]+$/, "").slice(0, 40);
}

/** Fields a JSON answer most likely says itself in, best first. */
const ANSWER_FIELDS = ["summary", "what", "answer", "result", "message", "text", "label", "title"];

/**
 * An answer as one line. A program that asks for JSON gets JSON: the line is
 * what it says in words (its summary, "what", answer…), not its braces.
 */
export function answerLine(text: unknown): string {
  if (typeof text !== "string") return "";
  const body = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (body.startsWith("{")) {
    try {
      const v = JSON.parse(body) as Record<string, unknown>;
      const field = ANSWER_FIELDS.find((k) => typeof v[k] === "string" && (v[k] as string).trim());
      const said = field ? v[field] : Object.values(v).find((x) => typeof x === "string" && x.trim());
      if (typeof said === "string") return oneLine(said);
    } catch {
      // Not JSON after all: the text as it is.
    }
  }
  return oneLine(text);
}

/** An answer without its subject in front ("Zoom: cache: safe to delete" about Zoom → "cache: safe to delete"). */
/** How far along the batch is, 0 to 1 (answers and errors of the total); null when the program did not say. */
export function progress(c: BackgroundCounts): number | null {
  if (!c.total) return null;
  return Math.min(1, (c.done + c.failed) / c.total);
}

export function answerText(answer: BackgroundAnswer): string {
  const { subject, text } = answer;
  if (!subject || text.slice(0, subject.length).toLowerCase() !== subject.toLowerCase()) return text;
  const rest = text.slice(subject.length);
  const cut = rest.replace(/^\s*[:\-–—·]\s*/, "");
  return cut && cut !== rest ? cut : text;
}

function oneLine(text: string): string {
  return text.replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

export const BACKGROUND_TEXT = {
  /** The pill of sessions whose program the relay could not name. */
  unnamed: N_("In background"),
  /** Beside the program's name on the home. */
  inBackground: N_("in background"),
  atATime: N_("up to {count} at a time"),
  lastAnswer: N_("Last answer"),
  stillAsks: N_("A permission request still comes up as a card, always with your click."),
};

export const running = (n: number) => tn("{count} running", "{count} running", n);
export const done = (n: number) => tn("{count} done", "{count} done", n);
export const failed = (n: number) => tn("{count} failed", "{count} failed", n);

export const doneOf = (n: number, total: number) => tn("{count} of {total} done", "{count} of {total} done", n, { total });

/** "37 done · 8 running · 2 failed" ("37 of 120 done…" when the program said how many), leaving out what is nothing. */
export function backgroundLine(c: BackgroundCounts): string {
  const parts = [c.total ? doneOf(c.done, c.total) : done(c.done)];
  if (c.running > 0) parts.push(running(c.running));
  if (c.failed > 0) parts.push(failed(c.failed));
  return parts.join(" · ");
}
