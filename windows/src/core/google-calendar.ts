// Google Calendar read with the user's Google account (Settings → Island →
// Google Calendar), for the live activities: the calendars of the account the
// user keeps on, and their events of the next days. Rust signs in and adds the
// token (google_calendar.rs); this asks through it, and works out what to ask.
//
// Every minute or so each calendar is asked which of its events were changed
// in the last minutes (`updatedMin`, deleted ones included): the answer is
// nearly always empty, and small. Only when one was (or every half hour, or on
// a new day) are the events of the next days read again. Nothing is ever read
// whole: a calendar of many years costs what a new one does. Pure but for
// `get`, so the tests run it against a fake Google.

import type { CalEvent } from "./calendar";

/** A GET to the Calendar API under /calendar/v3; null when not signed in. */
export type GoogleGet = (path: string, query: [string, string][]) => Promise<{ status: number; body: unknown } | null>;

export interface GoogleCalendarInfo {
  id: string;
  /** The user's own name for it, else the calendar's. */
  name: string;
  /** Its colour in Google Calendar ("#RRGGBB"). */
  color: string;
  primary: boolean;
  /** Whether Google Calendar itself shows it: an island without a choice of its own follows it. */
  shownInGoogle: boolean;
  /** owner, writer, reader or freeBusyReader. */
  role: string;
}

const DAY = 86_400_000;
/** The events of the next days are read again this often even when nothing changed (they move with time). */
const WINDOW_EVERY_MS = 30 * 60_000;
/** The list of calendars is read again this often (one added or removed in Google Calendar). */
const LIST_EVERY_MS = 30 * 60_000;
/** Calendars read at most: each is a request every minute. */
export const MAX_GOOGLE_CALENDARS = 20;
const MAX_PAGES = 50;
/** How far back "what changed?" looks before the last look: the computer's clock may be off Google's by that much. */
const CLOCK_MARGIN_MS = 5 * 60_000;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The calendar list's items, primary first then by name, without the deleted. */
export function readCalendarList(items: unknown[]): GoogleCalendarInfo[] {
  const out: GoogleCalendarInfo[] = [];
  for (const raw of items) {
    const c = obj(raw);
    const id = str(c.id);
    if (!id || c.deleted === true) continue;
    out.push({
      id,
      name: str(c.summaryOverride) || str(c.summary) || id,
      color: /^#[0-9a-f]{6}$/i.test(str(c.backgroundColor)) ? str(c.backgroundColor) : "#7986cb",
      primary: c.primary === true,
      shownInGoogle: c.selected === true && c.hidden !== true,
      role: str(c.accessRole),
    });
  }
  return out.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}

/** Whether the island shows `cal`: the user's choice in Lumo, else Google Calendar's. */
export function isShown(cal: GoogleCalendarInfo, picks: Record<string, boolean> | undefined): boolean {
  const pick = picks?.[cal.id];
  return typeof pick === "boolean" ? pick : cal.shownInGoogle;
}

/** "2026-11-12": that day's midnight, here. */
function localDay(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : null;
}

function when(v: unknown): { time: number; allDay: boolean } | null {
  const o = obj(v);
  if (str(o.dateTime)) {
    const time = Date.parse(str(o.dateTime));
    return Number.isNaN(time) ? null : { time, allDay: false };
  }
  const day = localDay(str(o.date));
  return day == null ? null : { time: day, allDay: true };
}

/** One event of the API (singleEvents: an occurrence of a repeating one), as the island's; null for a cancelled one. */
export function googleEvent(raw: unknown): CalEvent | null {
  const e = obj(raw);
  if (e.status === "cancelled") return null;
  const start = when(e.start);
  if (!start) return null;
  const end = when(e.end)?.time ?? start.time + (start.allDay ? DAY : 0);
  return {
    title: str(e.summary).trim() || "—",
    start: start.time,
    end: Math.max(end, start.time),
    allDay: start.allDay,
    location: str(e.location).trim(),
  };
}

/** The events of every source, soonest first, each once (the same calendar may come both from Google and from its iCal address). */
export function mergeEvents(...lists: CalEvent[][]): CalEvent[] {
  const seen = new Set<string>();
  const out: CalEvent[] = [];
  for (const e of lists.flat()) {
    const key = `${e.start}\u0000${e.allDay}\u0000${e.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
}

const dayKey = (t: number) => new Date(t).toDateString();

interface CalendarState {
  /** When it was last asked what changed (this computer's clock). */
  askedAt: number;
  /** The latest change Google told of (its own clock, RFC 3339 in UTC). */
  newest: string;
  events: CalEvent[];
  windowAt: number;
  windowDay: string;
}

/** Signed out, or Google answered null: nothing to read. */
class NotSignedIn extends Error {}

export class GoogleSync {
  calendars: GoogleCalendarInfo[] = [];
  private listedAt = 0;
  private state = new Map<string, CalendarState>();
  private readonly get: GoogleGet;

  constructor(get: GoogleGet) {
    this.get = get;
  }

  /** A new account, or signed out: everything is read again. */
  reset() {
    this.calendars = [];
    this.listedAt = 0;
    this.state.clear();
  }

  /** The shown calendars' events from a day ago to 8 days ahead; null when not signed in. */
  async refresh(picks: Record<string, boolean> | undefined, now = Date.now()): Promise<CalEvent[] | null> {
    try {
      if (!this.calendars.length || now - this.listedAt > LIST_EVERY_MS) {
        this.calendars = await this.list();
        this.listedAt = now;
      }
      const shown = this.calendars.filter((c) => isShown(c, picks)).slice(0, MAX_GOOGLE_CALENDARS);
      for (const id of [...this.state.keys()]) if (!shown.some((c) => c.id === id)) this.state.delete(id);
      const all: CalEvent[][] = [];
      for (const cal of shown) all.push(await this.events(cal.id, now));
      return mergeEvents(...all);
    } catch (err) {
      if (err instanceof NotSignedIn) {
        this.reset();
        return null;
      }
      // A calendar removed meanwhile answers 404: the list is read again next time.
      this.listedAt = 0;
      throw err;
    }
  }

  /** The account's calendars (Settings lists them to pick from). */
  async list(): Promise<GoogleCalendarInfo[]> {
    const items: unknown[] = [];
    let page = "";
    for (let i = 0; i < MAX_PAGES; i++) {
      const query: [string, string][] = [
        ["maxResults", "250"],
        ["fields", "items(id,summary,summaryOverride,backgroundColor,primary,selected,hidden,deleted,accessRole),nextPageToken"],
      ];
      if (page) query.push(["pageToken", page]);
      const body = await this.ask("/users/me/calendarList", query);
      items.push(...(Array.isArray(body.items) ? body.items : []));
      page = str(body.nextPageToken);
      if (!page) break;
    }
    return readCalendarList(items);
  }

  private async ask(path: string, query: [string, string][], allowGone = false): Promise<Json & { gone?: true }> {
    const answer = await this.get(path, query);
    if (answer == null) throw new NotSignedIn();
    if (answer.status === 410) {
      if (allowGone) return { gone: true };
      throw new Error("Google Calendar answered 410.");
    }
    return obj(answer.body);
  }

  private async events(id: string, now: number): Promise<CalEvent[]> {
    const path = `/calendars/${encodeURIComponent(id)}/events`;
    const known = this.state.get(id);
    const s: CalendarState = known ?? { askedAt: now, newest: "", events: [], windowAt: 0, windowDay: "" };
    // A calendar new to Lumo is read at once; its first look only learns how recent its last change is.
    const changed = await this.changedSince(path, s, now);
    if (!known || changed || now - s.windowAt > WINDOW_EVERY_MS || dayKey(now) !== s.windowDay) {
      const body = await this.ask(path, [
        ["singleEvents", "true"],
        ["orderBy", "startTime"],
        ["timeMin", new Date(now - DAY).toISOString()],
        ["timeMax", new Date(now + 8 * DAY).toISOString()],
        ["maxResults", "250"],
        ["fields", "items(status,summary,location,start,end)"],
      ]);
      const items = Array.isArray(body.items) ? body.items : [];
      s.events = items.map(googleEvent).filter((e): e is CalEvent => e != null && e.end > now - DAY);
      s.windowAt = now;
      s.windowDay = dayKey(now);
    }
    this.state.set(id, s);
    return s.events;
  }

  /**
   * Whether an event of the calendar was added, changed or deleted since the
   * last look: the changes of the last minutes (and a margin for this
   * computer's clock), compared by Google's own time with the latest seen.
   */
  private async changedSince(path: string, s: CalendarState, now: number): Promise<boolean> {
    let newest = s.newest;
    let page = "";
    let gone = false;
    for (let i = 0; i < MAX_PAGES; i++) {
      const query: [string, string][] = [
        ["updatedMin", new Date(s.askedAt - CLOCK_MARGIN_MS).toISOString()],
        ["showDeleted", "true"],
        ["maxResults", "250"],
        ["fields", "items(updated),nextPageToken"],
      ];
      if (page) query.push(["pageToken", page]);
      const body = await this.ask(path, query, true);
      // updatedMin too long ago (the computer slept for weeks): read it again.
      if (body.gone) {
        gone = true;
        break;
      }
      for (const item of Array.isArray(body.items) ? body.items : []) {
        const updated = str(obj(item).updated);
        if (updated > newest) newest = updated;
      }
      page = str(body.nextPageToken);
      if (!page) break;
    }
    const changed = gone || newest > s.newest;
    s.newest = newest;
    s.askedAt = now;
    return changed;
  }
}
