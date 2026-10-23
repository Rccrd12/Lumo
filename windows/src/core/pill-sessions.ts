// The sessions behind each pill.
//
// Two Claude Code sessions under the same editor (two VS Code projects, two
// terminals) share one pill. Without this, one session's SessionEnd took down
// the other's card and diffs, its Stop put the pill to finished then idle while
// the other was still working, and the project name flipped between the two.
//
// What the pill shows belongs to its owner: the oldest session in the middle of
// a turn, else the one heard from last. A session that never said goodbye (a
// terminal closed by its cross) is forgotten after a while: 30 minutes silent
// mid-turn, 12 hours in any case.
//
// An event with no session id cannot say whose it is: it is not counted, its
// Stop finishes the pill and its SessionEnd ends them all, as before.

/** Events that start or carry on a turn. */
const MID_TURN = new Set([
  "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest",
  "SubagentStart", "SubagentStop", "Notification",
]);
/** Events that end a turn: the session stays, waiting for the next prompt. */
const TURN_ENDS = new Set(["Stop", "StopFailure", "Interrupt"]);

export const SILENT_MID_TURN_MS = 30 * 60_000;
export const SILENT_MS = 12 * 3_600_000;

export interface LiveSession {
  id: string;
  cwd: string;
  project: string;
  /** When it was first heard from, then last heard from (ms). */
  started: number;
  seen: number;
  midTurn: boolean;
}

export class PillSessions {
  private pills = new Map<string, LiveSession[]>();
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** An event of `session` on `pill`. SessionEnd is `end`, not this. */
  touch(pill: string, session: string, cwd: string, project: string, event: string): void {
    if (!session) return;
    const list = this.live(pill);
    let s = list.find((x) => x.id === session);
    const at = this.now();
    if (!s) {
      s = { id: session, cwd, project, started: at, seen: at, midTurn: false };
      list.push(s);
      this.pills.set(pill, list);
    }
    s.seen = at;
    s.project = project;
    if (cwd) s.cwd = cwd;
    if (MID_TURN.has(event)) s.midTurn = true;
    else if (TURN_ENDS.has(event)) s.midTurn = false;
  }

  /** The session is over; with no id, all of the pill's. */
  end(pill: string, session: string): void {
    const list = session ? this.live(pill).filter((x) => x.id !== session) : [];
    if (list.length) this.pills.set(pill, list);
    else this.pills.delete(pill);
  }

  /** The sessions still there, oldest first. */
  live(pill: string): LiveSession[] {
    const at = this.now();
    const list = (this.pills.get(pill) ?? []).filter(
      (s) => at - s.seen < SILENT_MS && !(s.midTurn && at - s.seen >= SILENT_MID_TURN_MS),
    );
    if (list.length) this.pills.set(pill, list);
    else this.pills.delete(pill);
    return list;
  }

  /** Whose name, folder and session the pill shows. */
  owner(pill: string): LiveSession | null {
    const list = this.live(pill);
    const busy = list.find((s) => s.midTurn);
    if (busy) return busy;
    return list.reduce<LiveSession | null>((last, s) => (!last || s.seen >= last.seen ? s : last), null);
  }

  /** Another session of the pill is in the middle of a turn. */
  othersBusy(pill: string, session: string): boolean {
    if (!session) return false;
    return this.live(pill).some((s) => s.id !== session && s.midTurn);
  }

  clear(): void {
    this.pills.clear();
  }
}
