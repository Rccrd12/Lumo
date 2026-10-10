// What the closed island says next to Lumo, like Apple's Dynamic Island: what
// the AI is doing right now, a note when something happened ("Haiku
// answered"), an email that just came in, and the everyday live activities (a
// timer, the music playing). Nothing at all while nothing is going on.
//
// Pure: the inputs come from the chat, the Gemini Live call, the agents and the
// pollers; island/compact.ts draws what `shown` picks.

import { N_, t } from "../i18n/i18n";
import { eventSoon, type CalEvent } from "./calendar";

/** One line of text, in a colour. */
export interface CompactLine {
  text: string;
  color: string;
}

/** An email that came in (mail.rs). */
export interface MailPeek {
  /** Stable for the message (the server's UID and folder), to show it once. */
  id: string;
  from: string;
  address: string;
  subject: string;
  preview: string;
  /** Where to read it in the browser, when the server is a known webmail. */
  link?: string;
}

export interface TimerActivity {
  id: number;
  label: string;
  /** Date.now() at which it rings. */
  endsAt: number;
  /** Its length, ms: the ring round Lumo fills with it. */
  total: number;
}

/** What a media player says it plays (media.rs). */
export interface MediaActivity {
  title: string;
  artist: string;
  app: string;
  playing: boolean;
}

/** One live activity on the closed island. */
export type CompactItem =
  | { kind: "line"; line: CompactLine; notice: boolean }
  | { kind: "timer"; timer: TimerActivity }
  | { kind: "media"; media: MediaActivity };

/** A simple request waiting for Deny or Allow (core/approvals.ts). */
export interface ApprovalPeek {
  requestId: string;
  /** Who asks, in its colour. */
  who: string;
  color: string;
  /** What it wants to run or read. */
  command: string;
}

/**
 * A simple request takes the closed island, then a new email; otherwise the
 * live activities share it.
 */
export type CompactShown =
  | { kind: "approval"; approval: ApprovalPeek }
  | { kind: "mail"; mail: MailPeek }
  | { kind: "items"; items: CompactItem[] }
  | null;

/** At most this many live activities at once on the closed island. */
export const MAX_COMPACT_ITEMS = 4;

/** Gemini Live's colour on the closed island. */
export const LIVE_COLOR = "#4285F4";

/** How long a note stays. */
export const NOTICE_MS = 4500;
/** How long a new email shows unless the mouse rests on it. */
export const MAIL_PEEK_MS = 14_000;
/** At most this many notes wait their turn: a burst keeps the newest. */
const MAX_NOTICES = 4;
/** A timer between a few seconds and a day. */
export const MIN_TIMER_MS = 5_000;
export const MAX_TIMER_MS = 24 * 3_600_000;

export const COMPACT_TEXT = {
  thinking: N_("Thinking…"),
  writing: N_("Writing…"),
  speaking: N_("Speaking"),
  listening: N_("Listening"),
  connecting: N_("Connecting…"),
  working: N_("Working…"),
  waiting: N_("Waiting for your OK"),
  question: N_("Has a question for you"),
  // The same words as under a Gemini Live call (live/strings.ts).
  answered: N_("{helper} answered"),
  failed: N_("{helper} ran into a problem"),
  finished: N_("{helper} finished"),
  timerDone: N_("Time's up"),
  inMinutes: N_("in {n} min"),
  now: N_("now"),
  timer: N_("Timer"),
};

// ── What the AI is doing ──────────────────────────────────────────────────────

export interface ChatActivityInput {
  /** Who answers: "Haiku", "Claude Code"… */
  who: string;
  /** What it is doing, already in words ("Reading main.ts"); null once text streams. */
  label: string | null;
  color: string;
}

export interface LiveActivityInput {
  phase: "off" | "connecting" | "listening" | "thinking" | "speaking" | "reconnecting";
  /** What a tool or the helper is doing, if anything; done lines are notes, not activity. */
  doing: string | null;
  color: string;
}

export interface AgentActivityInput {
  name: string;
  state: string;
  /** Its newest step, if it said one. */
  step: string | null;
  color: string;
}

/** The line for what is going on, the chat first, then the call, then the agents. */
export function activityLine(
  chat: ChatActivityInput | null,
  live: LiveActivityInput | null,
  agent: AgentActivityInput | null,
): CompactLine | null {
  if (chat) {
    return { text: `${chat.who} · ${chat.label ?? t(COMPACT_TEXT.writing)}`, color: chat.color };
  }
  if (live && live.phase !== "off") {
    const what = live.doing ?? liveWords(live.phase);
    return { text: `Gemini Live · ${what}`, color: live.color };
  }
  if (agent) {
    const what = agentWords(agent);
    if (what) return { text: `${agent.name} · ${what}`, color: agent.color };
  }
  return null;
}

function liveWords(phase: LiveActivityInput["phase"]): string {
  switch (phase) {
    case "connecting":
    case "reconnecting":
      return t(COMPACT_TEXT.connecting);
    case "thinking":
      return t(COMPACT_TEXT.thinking);
    case "speaking":
      return t(COMPACT_TEXT.speaking);
    default:
      return t(COMPACT_TEXT.listening);
  }
}

function agentWords(a: AgentActivityInput): string | null {
  switch (a.state) {
    case "working":
    case "searching":
      return a.step?.trim() || t(COMPACT_TEXT.working);
    case "thinking":
      return a.step?.trim() || t(COMPACT_TEXT.thinking);
    case "approval":
      return t(COMPACT_TEXT.waiting);
    case "question":
      return t(COMPACT_TEXT.question);
    default:
      return null;
  }
}

/** A short name for who answers: the model's family ("Haiku"), else the provider. */
export function speakerName(provider: string, providerName: string, model: string): string {
  const m = model.trim();
  if (!m || m === "default") return providerName;
  const family = /\b(opus|sonnet|haiku|fable)\b/i.exec(m.replace(/[-_.]/g, " "));
  if (family && (provider === "anthropic" || provider === "claude-code" || /claude/i.test(m))) {
    return family[1][0].toUpperCase() + family[1].slice(1).toLowerCase();
  }
  // "openai/gpt-4o" → "gpt-4o", "qwen2.5:7b" stays.
  const last = m.split("/").pop() || m;
  return last.length > 28 ? providerName : last;
}

// ── Notes, the email, the live activities ─────────────────────────────────────

interface Notice extends CompactLine {
  until: number;
}

export class CompactFeed {
  private notices: Notice[] = [];
  private mail: { mail: MailPeek; until: number } | null = null;
  private seenMail = new Set<string>();
  timers: TimerActivity[] = [];
  media: MediaActivity | null = null;
  /** The calendar's coming events (island/activities.ts), for "in 5 min". */
  events: CalEvent[] = [];
  private nextTimer = 1;

  /** A note for a few seconds, after the ones already waiting. */
  notice(text: string, color: string, now: number, ms = NOTICE_MS) {
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return;
    this.drop(now);
    // The same note twice in a row is once.
    const last = this.notices[this.notices.length - 1];
    if (last && last.text === clean) {
      last.until = Math.max(last.until, now + ms);
      return;
    }
    const start = this.notices.length ? this.notices[this.notices.length - 1].until : now;
    this.notices.push({ text: clean, color, until: Math.max(start, now) + ms });
    while (this.notices.length > MAX_NOTICES) this.notices.shift();
  }

  /** A new email: shown once, for a while. False when it was already shown. */
  showMail(mail: MailPeek, now: number, ms = MAIL_PEEK_MS): boolean {
    if (this.seenMail.has(mail.id)) return false;
    this.seenMail.add(mail.id);
    if (this.seenMail.size > 500) this.seenMail = new Set([...this.seenMail].slice(-250));
    this.mail = { mail, until: now + ms };
    return true;
  }

  /** The email stays until `until` (Infinity while the mouse rests on it). */
  holdMail(until: number) {
    if (this.mail) this.mail.until = until;
  }

  dismissMail() {
    this.mail = null;
  }

  get currentMail(): MailPeek | null {
    return this.mail?.mail ?? null;
  }

  /** A timer of `ms`, clamped to a sensible length; returns it. */
  startTimer(ms: number, label: string, now: number): TimerActivity {
    const total = Math.min(MAX_TIMER_MS, Math.max(MIN_TIMER_MS, Math.round(ms)));
    const timer = { id: this.nextTimer++, label: label.trim(), endsAt: now + total, total };
    this.timers.push(timer);
    this.timers.sort((a, b) => a.endsAt - b.endsAt);
    return timer;
  }

  cancelTimer(id: number): boolean {
    const before = this.timers.length;
    this.timers = this.timers.filter((x) => x.id !== id);
    return this.timers.length !== before;
  }

  /** The timers that rang by `now`, taken off the list. */
  takeRung(now: number): TimerActivity[] {
    const rung = this.timers.filter((x) => x.endsAt <= now);
    if (rung.length) this.timers = this.timers.filter((x) => x.endsAt > now);
    return rung;
  }

  /** Forgets what is over. */
  private drop(now: number) {
    this.notices = this.notices.filter((n) => n.until > now);
    if (this.mail && this.mail.until <= now) this.mail = null;
  }

  /**
   * What the closed island shows now: the email, else the live activities
   * side by side — a note (each in its turn) or what the AI is doing, the
   * event about to start, the two soonest timers, the music.
   * `show` leaves out the notes and the activity, or the music (Settings → Island).
   */
  shown(activity: CompactLine | null, now: number, show = { notes: true, media: true }): CompactShown {
    this.drop(now);
    if (this.mail) return { kind: "mail", mail: this.mail.mail };
    const items: CompactItem[] = [];
    // A note stands in for what the AI is doing while it shows.
    const notice = show.notes ? this.currentNotice(now) : null;
    if (notice) items.push({ kind: "line", line: { text: notice.text, color: notice.color }, notice: true });
    else if (activity && show.notes) items.push({ kind: "line", line: activity, notice: false });
    const soon = show.notes ? eventSoon(this.events, now) : null;
    if (soon) items.push({ kind: "line", line: { text: `${soon.title} · ${soonWords(soon.start, now)}`, color: CALENDAR_COLOR }, notice: false });
    for (const timer of this.timers.filter((x) => x.endsAt > now).slice(0, 2)) items.push({ kind: "timer", timer });
    if (show.media && this.media && (this.media.title || this.media.artist)) items.push({ kind: "media", media: this.media });
    return items.length ? { kind: "items", items: items.slice(0, MAX_COMPACT_ITEMS) } : null;
  }

  /** Notes take turns: each one's window ends at its `until`. */
  private currentNotice(now: number): Notice | null {
    return this.notices.find((n) => n.until > now) ?? null;
  }

  /** When what is shown changes on its own (a note or the email going), if ever. */
  nextChange(now: number): number | null {
    const times: number[] = [];
    if (this.mail) times.push(this.mail.until);
    const notice = this.currentNotice(now);
    if (notice) times.push(notice.until);
    const timer = this.timers[0];
    if (timer) times.push(timer.endsAt);
    // An event about to start: its minutes count down; a later one comes in 15 minutes before.
    if (eventSoon(this.events, now)) times.push(now + 60_000 - (now % 60_000));
    const upcoming = this.events.find((e) => !e.allDay && e.start - 15 * 60_000 > now);
    if (upcoming) times.push(upcoming.start - 15 * 60_000);
    const next = times.filter((x) => x > now);
    return next.length ? Math.min(...next) : null;
  }
}

const CALENDAR_COLOR = "#4285F4";

/** "in 5 min", or "now" once it has started. */
function soonWords(start: number, now: number): string {
  const min = Math.ceil((start - now) / 60_000);
  return min <= 0 ? t(COMPACT_TEXT.now) : t(COMPACT_TEXT.inMinutes, { n: min });
}

/** "4:05" or "1:02:05" for what is left of a timer. */
export function timerLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hh > 0 ? `${hh}:${pad(mm)}:${pad(ss)}` : `${mm}:${pad(ss)}`;
}

/** Reads what a person (or Gemini) typed for a timer: "5m", "1h30", "90s", "10". */
export function parseDuration(raw: string): number | null {
  const s = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 60_000);
  const clock = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(s);
  if (clock) {
    const [a, b, c] = [clock[1], clock[2], clock[3]].map((x) => (x == null ? null : parseInt(x, 10)));
    return c == null ? ((a ?? 0) * 60 + (b ?? 0)) * 1000 : ((a ?? 0) * 3600 + (b ?? 0) * 60 + c) * 1000;
  }
  const re = /(\d+(?:\.\d+)?)(hours?|hrs|hr|h|ore|ora|minutes?|minuti|mins|min|m|seconds?|secondi|secs|sec|s)?/g;
  let total = 0;
  let matched = "";
  let unitless: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (!m[0]) break;
    matched += m[0];
    const n = parseFloat(m[1]);
    const unit = m[2] ?? "";
    if (unit.startsWith("h") || unit.startsWith("or")) total += n * 3_600_000;
    else if (unit.startsWith("s")) total += n * 1000;
    else if (unit) total += n * 60_000;
    // "1h30": what follows the hours is minutes.
    else unitless = n;
  }
  if (matched !== s) return null;
  if (unitless != null) total += unitless * (total >= 3_600_000 ? 60_000 : total > 0 ? 1000 : 60_000);
  return total > 0 ? Math.round(total) : null;
}

// ── The island's feed ─────────────────────────────────────────────────────────

/** What the closed island draws from (island/compact.ts). */
export const Feed = new CompactFeed();

let onNews: (() => void) | null = null;

/** The island: something new to show, so the closed island comes out for it. */
export function setCompactNewsHandler(fn: (() => void) | null) {
  onNews = fn;
}

/** A note on the closed island ("Haiku answered"). */
export function compactNotice(text: string, color: string, ms = NOTICE_MS) {
  Feed.notice(text, color, Date.now(), ms);
  onNews?.();
}

/** A new email on the closed island; false when it was already shown. */
export function compactMail(mail: MailPeek): boolean {
  const shown = Feed.showMail(mail, Date.now());
  if (shown) onNews?.();
  return shown;
}

/** A timer on the closed island (Gemini Live, the chat's /timer). */
export function compactTimer(ms: number, label: string): TimerActivity {
  const timer = Feed.startTimer(ms, label, Date.now());
  onNews?.();
  return timer;
}

/**
 * The timers a chat answer asked for (`[[timer 10m: pasta]]`, chat.rs
 * timer_note), and the answer without those lines. A marker still being
 * written (`[[tim…`) is hidden too, so it never flashes up while streaming.
 */
export function takeTimers(text: string): { text: string; timers: { ms: number; label: string }[] } {
  const timers: { ms: number; label: string }[] = [];
  let out = text.replace(/[ \t]*\[\[\s*timer\s+([^\]:]+?)\s*(?::\s*([^\]]*?))?\s*\]\][ \t]*\n?/gi, (_all, length: string, label?: string) => {
    const ms = parseDuration(length);
    if (ms != null) timers.push({ ms, label: (label ?? "").trim() });
    return "";
  });
  out = out.replace(/\[\[[^\]]*$/, "");
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), timers };
}
