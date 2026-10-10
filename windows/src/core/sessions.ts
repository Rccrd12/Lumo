// The Code section's session history: the weekly recap's turns (recap.rs),
// put together into sessions, and where each project lives on disk so a
// click can open it again. No DOM, so it can be tested on its own;
// views/integrations.ts draws it.
//
// The recap keeps only the project folder's name. Its full path is remembered
// here, on this computer only, from the hook events that carry it (cwd), for
// the projects worked on since; a project never seen with its path simply has
// nothing to open.

import type { RecapTurn } from "../recap/summary";

/** One session: an agent's turns on one project with no long pause between them. */
export interface CodeSession {
  project: string;
  /** Unix seconds. */
  start: number;
  end: number;
  /** Time actually worked (overlapping turns counted once), in minutes. */
  minutes: number;
  turns: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  commandsRun: number;
}

/** A pause longer than this between two turns starts a new session (seconds). */
export const SESSION_GAP_S = 30 * 60;

/** `agent`'s sessions, newest first, at most `max`. */
export function groupSessions(turns: RecapTurn[], agent: string, max = 12): CodeSession[] {
  const mine = turns.filter((t) => t.agent === agent && t.end >= t.start).sort((a, b) => a.start - b.start);
  const sessions: (CodeSession & { spans: [number, number][] })[] = [];
  for (const t of mine) {
    const last = sessions[sessions.length - 1];
    if (last && last.project === t.project && t.start - last.end <= SESSION_GAP_S) {
      last.end = Math.max(last.end, t.end);
      last.turns++;
      last.filesChanged += t.filesChanged;
      last.linesAdded += t.linesAdded;
      last.linesRemoved += t.linesRemoved;
      last.commandsRun += t.commandsRun;
      last.spans.push([t.start, t.end]);
    } else {
      sessions.push({
        project: t.project, start: t.start, end: t.end, minutes: 0, turns: 1,
        filesChanged: t.filesChanged, linesAdded: t.linesAdded, linesRemoved: t.linesRemoved,
        commandsRun: t.commandsRun, spans: [[t.start, t.end]],
      });
    }
  }
  return sessions
    .map(({ spans, ...s }) => ({ ...s, minutes: Math.max(1, Math.round(merged(spans) / 60)) }))
    .reverse()
    .slice(0, max);
}

/** Seconds covered by the spans, overlaps counted once. */
function merged(spans: [number, number][]): number {
  let total = 0;
  let from = -Infinity;
  let to = -Infinity;
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (a > to) {
      if (to > from) total += to - from;
      from = a;
      to = b;
    } else to = Math.max(to, b);
  }
  if (to > from) total += to - from;
  return total;
}

// ── Where each project is ─────────────────────────────────────────────────────

const KEY = "lumo.projectFolders.v1";
const MAX_FOLDERS = 80;

/** A folder's name, as recap.rs project_name gives it. */
export function projectName(cwd: string): string {
  return cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

function load(): Record<string, string> {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Remembers where a project is (a hook event's cwd). The newest ones are kept. */
export function rememberFolder(cwd: string | null | undefined): void {
  if (!cwd || cwd.length > 1024) return;
  const name = projectName(cwd);
  if (!name) return;
  const all = load();
  if (all[name] === cwd) return;
  delete all[name];
  all[name] = cwd;
  const entries = Object.entries(all).slice(-MAX_FOLDERS);
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Not remembered: the session just has nothing to open.
  }
}

/** Where `project` was last seen, if it was. */
export function folderOf(project: string): string | null {
  return load()[project] ?? null;
}
