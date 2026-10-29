// Gemini Live — what Lumo knows, for the model (protocol.ts TOOL.lumo).
//
// Everything the island shows, read when the model asks and never before: the
// agents' sessions and what they are doing (VS Code, Cursor, Codex…), the
// permission cards waiting, the plans' usage limits, GitHub, the email, the
// calendar, the other services, timers, the music, the pull requests Lumo
// listens to, the chat and the week's recap. Nothing is fetched for it: it is
// what Lumo already has, so it costs nothing and touches no new service.
//
// `gatherLumo` collects it (the only part that reads the app); `lumoStatus`
// turns it into the answer, as plain data the model reads best.

import { Bridge } from "../core/bridge";
import type { CalEvent } from "../core/calendar";
import { Feed, timerLeft, type MediaActivity, type TimerActivity } from "../core/compact";
import type { FileDiff } from "../core/diff";
import { readActivity, readPulse, readStats } from "../core/github";
import type { ListenWatch } from "../core/listen";
import type { LiveSession } from "../core/pill-sessions";
import { pillDefinition } from "../core/pills";
import {
  effectivePct, type AntigravityPlanUsage, type CodexPlanUsage, type PlanUsage, type PlanWindow,
} from "../core/plan";
import { activeModel, providerDef } from "../core/providers";
import { State, aiReads, isSessionTask, type AgentTask, type ApprovalInfo, type ChatMessage, type IntegrationInfo } from "../core/state";
import { mondayOf, summarize, type WeeklySummary } from "../recap/summary";
import { LUMO_TOPICS, type LumoTopic } from "./protocol";


export function parseTopic(v: unknown): LumoTopic {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return (LUMO_TOPICS as readonly string[]).includes(s) ? (s as LumoTopic) : "all";
}

/** Everything `lumoStatus` reads, collected at one moment. */
export interface LumoFacts {
  now: number;
  /** Settings → General → Security keeps the email, or the calendar, from the AI. */
  mailOff?: boolean;
  calendarOff?: boolean;
  tasks: AgentTask[];
  /** The sessions behind each pill (island/hooks.ts liveSessions), by pill id. */
  sessions: Record<string, LiveSession[]>;
  diffs: Map<string, FileDiff[]>;
  approval: ApprovalInfo | null;
  queue: ApprovalInfo[];
  plans: { claude: PlanUsage | null; codex: CodexPlanUsage | null; antigravity: AntigravityPlanUsage | null };
  integrations: Record<string, IntegrationInfo>;
  events: CalEvent[];
  timers: TimerActivity[];
  media: MediaActivity | null;
  listening: ListenWatch[];
  chat: { provider: string; model: string; messages: ChatMessage[] };
  week: WeeklySummary | null;
}

/** Reads what Lumo has now; the music and the week are asked of Rust, the rest is in memory. */
export async function gatherLumo(topic: LumoTopic): Promise<LumoFacts> {
  const now = Date.now();
  const s = State.settings;
  const sessions: Record<string, LiveSession[]> = {};
  try {
    // Loaded by the island long before a call: no cycle at start-up.
    const { liveSessions } = await import("../island/hooks");
    for (const task of State.tasks) {
      const list = liveSessions.live(task.id);
      if (list.length) sessions[task.id] = list;
    }
  } catch {
    // The pills' own state is still there.
  }
  const wants = (t: LumoTopic) => topic === "all" || topic === t;
  const [media, week] = await Promise.all([
    // `call` answers null rather than throwing, so a failed ask reads as
    // nothing playing; the feed's own track is what the island is showing.
    wants("timers") ? Bridge.mediaNow().then((m) => m ?? Feed.media) : Promise.resolve(Feed.media),
    wants("week")
      ? Bridge.recapHistory(mondayOf(new Date(now)).getTime() / 1000)
        .then((h) => (h && Array.isArray(h.turns) ? summarize(h, mondayOf(new Date(now))) : null))
        .catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    now,
    mailOff: !aiReads(s.aiMailAccess),
    calendarOff: !aiReads(s.aiCalendarAccess),
    tasks: State.tasks,
    sessions,
    diffs: State.sessionDiffs,
    approval: State.pendingApproval,
    queue: State.approvalQueue,
    plans: { claude: State.planUsage, codex: State.codexPlanUsage, antigravity: State.antigravityPlanUsage },
    integrations: State.integrations,
    events: Feed.events,
    timers: Feed.timers,
    media: media ?? null,
    listening: State.listening,
    chat: { provider: providerDef(s.chatProvider).name, model: activeModel(s), messages: State.chatHistory },
    week,
  };
}

// ── The answer ────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

/** Local date and time, as the model is told the time (session.ts localNow). */
export function when(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

/** "12 min ago", "3 h ago": how long since `ms`. */
export function ago(ms: number, now: number): string {
  const min = Math.max(0, Math.round((now - ms) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** At most `max` characters, on one line. */
export function cut(text: unknown, max: number): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const baseName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
const pillName = (id: string) => pillDefinition(id)?.name ?? id;

/** A service's own data, kept small: short strings, a few items, not too deep. */
export function trimData(v: unknown, items = 8, text = 240, depth = 4): unknown {
  if (typeof v === "string") return cut(v, text);
  if (v == null || typeof v !== "object") return v;
  if (depth <= 0) return Array.isArray(v) ? `${v.length} items` : "…";
  if (Array.isArray(v)) {
    const out: unknown[] = v.slice(0, items).map((x) => trimData(x, items, text, depth - 1));
    if (v.length > items) out.push(`and ${v.length - items} more`);
    return out;
  }
  const out: Json = {};
  for (const [k, x] of Object.entries(v)) {
    // Ids, hashes and avatars say nothing to the model.
    if (/^(id|uid|sha|headSha|avatar|avatarUrl|icon|color)$/i.test(k)) continue;
    out[k] = trimData(x, items, text, depth - 1);
  }
  return out;
}

function agents(f: LumoFacts, full: boolean): Json[] {
  return f.tasks.filter(isSessionTask).map((task) => {
    const app = pillName(task.id);
    const sessions = f.sessions[task.id] ?? [];
    const steps = task.steps.slice(-(full ? 8 : 3)).map((s) => cut(s, 160));
    const diffs = f.diffs.get(task.id) ?? [];
    const files = new Map<string, { added: number; removed: number; created: boolean }>();
    for (const d of diffs) {
      const was = files.get(d.path) ?? { added: 0, removed: 0, created: false };
      files.set(d.path, { added: was.added + d.added, removed: was.removed + d.removed, created: was.created || d.isNewFile });
    }
    const out: Json = { app, state: task.state };
    if (task.name !== app) out.shownAs = task.name;
    const project = task.sessionCwd ? baseName(task.sessionCwd) : null;
    if (project) out.project = project;
    if (task.pillBadge) out.badge = task.pillBadge;
    if (steps.length) out[full ? "recentSteps" : "lastSteps"] = steps;
    if (task.finalLine) out.lastMessage = cut(task.finalLine, 300);
    if (sessions.length) {
      out.sessions = sessions.map((s) => ({
        project: s.project || baseName(s.cwd),
        ...(full && s.cwd ? { folder: s.cwd } : {}),
        working: s.midTurn,
        started: when(s.started),
        lastHeard: ago(s.seen, f.now),
      }));
    }
    if (files.size) {
      const list = [...files].slice(-(full ? 20 : 5)).map(([path, c]) => ({
        file: full ? path : baseName(path), added: c.added, removed: c.removed, ...(c.created ? { newFile: true } : {}),
      }));
      out.filesChanged = files.size > list.length ? [...list, `and ${files.size - list.length} more`] : list;
    }
    return out;
  });
}

function approvalOf(a: ApprovalInfo): Json {
  const out: Json = { agent: pillName(a.pillId), tool: a.tool };
  if (a.project) out.project = a.project;
  if (a.command) out.request = cut(a.command, 400);
  if (a.reason) out.reason = cut(a.reason, 300);
  if (a.questions?.length) {
    out.questions = a.questions.map((q) => ({
      question: cut(q.question, 300),
      options: q.options.map((o) => cut(o.label, 80)),
      ...(q.multiSelect ? { severalAllowed: true } : {}),
    }));
  }
  if (a.fromChat) out.fromLumoChat = true;
  return out;
}

function approvals(f: LumoFacts): Json {
  if (!f.approval) return { none: "Nothing is waiting for the user's answer." };
  return {
    showing: approvalOf(f.approval),
    ...(f.queue.length ? { waitingAfterIt: f.queue.map(approvalOf) } : {}),
    note: "Only the user answers these, on Lumo's card (a click, or Y and N). You can't approve or deny them.",
  };
}

function windowOf(w: PlanWindow | undefined, now: number): Json | null {
  if (!w) return null;
  if (w.resetsAt <= now) return { used: "0%", note: "It has just reset." };
  return { used: w.low ? "low" : `${Math.round(effectivePct(w, now))}%`, resets: when(w.resetsAt) };
}

function limits(f: LumoFacts): Json {
  const out: Json = {};
  const plan = (u: PlanUsage | null): Json | null => {
    if (!u) return null;
    const p: Json = { updated: ago(u.updatedAt, f.now) };
    const five = windowOf(u.fiveHour, f.now);
    const week = windowOf(u.sevenDay, f.now);
    if (five) p.fiveHours = five;
    if (week) p.week = week;
    return p;
  };
  const claude = plan(f.plans.claude);
  if (claude) out["Claude (Claude Code)"] = claude;
  const codex = plan(f.plans.codex);
  if (codex && f.plans.codex) {
    if (f.plans.codex.planType) codex.plan = f.plans.codex.planType;
    if (f.plans.codex.resetCredits) codex.freeResets = f.plans.codex.resetCredits;
    out.Codex = codex;
  }
  const agy = f.plans.antigravity;
  if (agy) {
    out["Antigravity CLI"] = {
      updated: ago(agy.updatedAt, f.now),
      quotas: agy.buckets.map((b) => ({ group: b.group, window: b.window, ...windowOf(b.w, f.now) })),
    };
  }
  if (!Object.keys(out).length) return { none: "Lumo has no usage figures yet: they arrive once Claude Code, Codex or Antigravity CLI has run with their pills on." };
  return out;
}

function info(f: LumoFacts, id: string): IntegrationInfo | null {
  return f.integrations[id] ?? null;
}

function notReady(i: IntegrationInfo | null, name: string): Json | null {
  if (!i || (!i.configured && !i.error)) return { none: `${name} isn't connected in Lumo (Settings → Pills).` };
  if (i.error) return { error: i.error };
  if (!i.loaded) return { none: `${name} is still loading.` };
  return null;
}

function github(f: LumoFacts, full: boolean): Json {
  const i = info(f, "integration_github");
  const missing = notReady(i, "GitHub");
  const out: Json = missing ?? {};
  if (!missing && i) {
    const stats = readStats(i.data);
    if (stats) out.account = { repositories: stats.totalRepos, stars: stats.totalStars };
    const pulse = readPulse(i.data);
    if (pulse) {
      const pr = (p: (typeof pulse.myPRs)[number]) => ({
        pr: `${p.repo}#${p.number}`, title: cut(p.title, 140), ci: p.ci, review: p.review, ...(p.isDraft ? { draft: true } : {}),
      });
      out.login = pulse.login;
      out.myPullRequests = pulse.myPRs.slice(0, full ? 20 : 6).map(pr);
      out.waitingForMyReview = pulse.toReview.slice(0, full ? 20 : 6).map(pr);
      out.defaultBranchCI = pulse.mainCI.slice(0, full ? 20 : 6).map((r) => ({ repo: r.repo, branch: r.branch, ci: r.ci }));
    }
    const activity = readActivity(i.data);
    if (activity) {
      const days = activity.weeks.flat();
      const last7 = days.slice(-7).reduce((n, d) => n + d.count, 0);
      out.contributions = { pastYear: activity.total, last7Days: last7 };
    }
  }
  if (f.listening.length) {
    out.lumoIsWatching = f.listening.map((w) => ({
      pr: `${w.repo}#${w.number}`, until: w.until, ...(w.task ? { then: cut(w.task, 200) } : {}),
    }));
  }
  return out;
}

/** What a section says when the user keeps it from the AI. */
const KEPT_FROM_AI = "The user doesn't let the AI read this in Lumo (Settings → General → Security). Say so if asked.";

function email(f: LumoFacts, full: boolean): Json {
  if (f.mailOff) return { off: KEPT_FROM_AI };
  const i = info(f, "integration_mail");
  const missing = notReady(i, "Email");
  if (missing || !i) return missing ?? {};
  const list = Array.isArray(i.data.messages) ? (i.data.messages as Json[]) : [];
  const out: Json = { unread: typeof i.data.unread === "number" ? i.data.unread : list.length };
  // The short look counts them: who wrote and what goes to Google only when
  // the user asks about the email itself.
  if (!full) return { ...out, more: "Ask with `about` \"email\" for the senders, subjects and text." };
  out.newestUnread = list.slice(0, 10).map((m) => ({
    from: cut(m.from || m.address, 80),
    subject: cut(m.subject, 160),
    ...(m.date ? { date: cut(m.date, 60) } : {}),
    text: cut(m.body || m.preview, 1500),
  }));
  return out;
}

function calendar(f: LumoFacts, full: boolean): Json {
  if (f.calendarOff) return { off: KEPT_FROM_AI };
  const coming = f.events.filter((e) => e.end > f.now).slice(0, full ? 25 : 6);
  if (!coming.length) return { none: "No event in the next days, or no calendar is set in Lumo (Settings → Island)." };
  return {
    events: coming.map((e) => ({
      title: cut(e.title, 140),
      ...(e.allDay ? { day: when(e.start).replace(/,?\s*\d{2}:\d{2}$/, ""), allDay: true } : { starts: when(e.start), ends: when(e.end) }),
      ...(e.start <= f.now ? { now: true } : {}),
      ...(e.location ? { where: cut(e.location, 120) } : {}),
    })),
  };
}

/** The services with a card of their own data (Vercel, Stripe, Resend, n8n, Notion, Cal.com…). */
function services(f: LumoFacts, full: boolean): Json {
  const out: Json = {};
  for (const [id, i] of Object.entries(f.integrations)) {
    const def = pillDefinition(id);
    if (!def || def.category !== "service" || id === "integration_github" || id === "integration_mail") continue;
    if (!i.configured && !i.error) continue;
    // The short look says only which are connected: their data (who booked,
    // what was paid, to whom an email went) is other people's too.
    out[def.name] = notReady(i, def.name) ?? (full ? trimData(i.data, 10, 240) : "connected");
  }
  return Object.keys(out).length ? out : { none: "No other service is connected in Lumo." };
}

function timers(f: LumoFacts): Json {
  const out: Json = {};
  const running = f.timers.filter((x) => x.endsAt > f.now);
  out.timers = running.length
    ? running.map((x) => ({ ...(x.label ? { label: x.label } : {}), ringsIn: timerLeft(x.endsAt - f.now) }))
    : "none";
  out.music = f.media ? { title: f.media.title, artist: f.media.artist, app: f.media.app, playing: f.media.playing } : "nothing playing";
  return out;
}

function chat(f: LumoFacts, full: boolean): Json {
  const out: Json = { provider: f.chat.provider, model: f.chat.model };
  if (!f.chat.messages.length) return { ...out, messages: "The chat is empty." };
  // The short look counts the messages; their text only when asked about the chat.
  if (!full) return { ...out, messages: f.chat.messages.length };
  return {
    ...out,
    messages: f.chat.messages.slice(-10).map((m) => ({ from: m.role === "user" ? "user" : f.chat.provider, text: cut(m.content, 1200) })),
  };
}

function week(f: LumoFacts): Json {
  const w = f.week;
  if (!w) return { none: "No coding session recorded this week (the weekly recap keeps them, Settings → General)." };
  return {
    sessions: w.sessionCount,
    minutesWorked: w.totalMinutes,
    filesChanged: w.filesChanged,
    linesAdded: w.linesAdded,
    linesRemoved: w.linesRemoved,
    commandsRun: w.commandsRun,
    permissionsAllowed: w.permissionsAllowed,
    permissionsDenied: w.permissionsDenied,
    ...(w.topAgent ? { mostUsedAgent: w.topAgent } : {}),
    ...(w.topProject ? { mostWorkedProject: w.topProject } : {}),
  };
}

/** What the model hears for `topic`: one section, in full, or a short look at all of them. */
export function lumoStatus(f: LumoFacts, topic: LumoTopic): Json {
  const full = topic !== "all";
  const sections: Record<Exclude<LumoTopic, "all">, () => unknown> = {
    agents: () => {
      const list = agents(f, full);
      return list.length ? list : { none: "No agent or editor pill is on in Lumo." };
    },
    approvals: () => approvals(f),
    limits: () => limits(f),
    github: () => github(f, full),
    email: () => email(f, full),
    calendar: () => calendar(f, full),
    services: () => services(f, full),
    timers: () => timers(f),
    chat: () => chat(f, full),
    week: () => week(f),
  };
  if (topic !== "all") return { [topic]: sections[topic]() };
  const out: Json = {};
  for (const [name, read] of Object.entries(sections)) out[name] = read();
  out.more = "Ask again with `about` set to one section for all of it (the emails, the chat's messages, the services' data, every step, every event…).";
  return out;
}
