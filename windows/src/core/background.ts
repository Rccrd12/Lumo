// Sessions another program starts on its own (the relay's `lumo_background`,
// hook/src/background.rs): a tool asking `claude -p` about a hundred files,
// eight at a time, an app built on the Agent SDK. Shown one by one, each would
// make its sounds and open the island on its answer, a hundred times over.
// Grouped (the default), each program gets one pill: how many are running and
// how many have answered, one sound when a batch starts and one when it ends.
//
// This file keeps the counts; island/hooks.ts shows them.

import { N_, t } from "../i18n/i18n";

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
}

/** What an event is for the group's count. */
export type BackgroundEvent = "busy" | "done" | "failed" | "end";

interface Group {
  /** Running sessions and when each was last heard from. */
  running: Map<string, number>;
  done: number;
  failed: number;
}

export class BackgroundRuns {
  private groups = new Map<string, Group>();

  /**
   * One event of a session of `id`'s. True when it starts a batch: the group
   * was not there, or had finished.
   */
  event(id: string, session: string, kind: BackgroundEvent, now: number): boolean {
    let g = this.groups.get(id);
    const started = !g;
    if (!g) this.groups.set(id, (g = { running: new Map(), done: 0, failed: 0 }));
    switch (kind) {
      case "busy":
        g.running.set(session, now);
        break;
      case "done":
        g.running.delete(session);
        g.done++;
        break;
      case "failed":
        g.running.delete(session);
        g.failed++;
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

  /** Forgets the sessions silent for STALE_MS; the groups that lost one. */
  sweep(now: number): string[] {
    const changed: string[] = [];
    for (const [id, g] of this.groups) {
      let lost = false;
      for (const [session, at] of g.running) {
        if (now - at >= STALE_MS) {
          g.running.delete(session);
          lost = true;
        }
      }
      if (lost) changed.push(id);
    }
    return changed;
  }

  /** The batch is over: its counts (nothing running any more), and the group starts afresh next time. */
  close(id: string): BackgroundCounts | null {
    const counts = this.counts(id);
    this.groups.delete(id);
    return counts && { ...counts, running: 0 };
  }

  /** Forgets every group (tests). */
  clear(): void {
    this.groups.clear();
  }
}

export const BACKGROUND_TEXT = {
  /** The pill of sessions whose program the relay could not name. */
  unnamed: N_("In background"),
  /** Beside the program's name on the home. */
  inBackground: N_("in background"),
  running: N_("Running: {count}"),
  done: N_("Done: {count}"),
  failed: N_("Failed: {count}"),
};

/** "Running: 8 · Done: 37 · Failed: 2", leaving out what is nothing. */
export function backgroundLine(c: BackgroundCounts): string {
  const parts: string[] = [];
  if (c.running > 0) parts.push(t(BACKGROUND_TEXT.running, { count: c.running }));
  parts.push(t(BACKGROUND_TEXT.done, { count: c.done }));
  if (c.failed > 0) parts.push(t(BACKGROUND_TEXT.failed, { count: c.failed }));
  return parts.join(" · ");
}
