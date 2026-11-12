// The calendar for the live activities: an iCal file (Google Calendar's
// "secret address in iCal format", Outlook's published calendar, iCloud's
// public link…) read into the events of the next days. Pure: calendar.rs
// fetches the file, island/activities.ts shows it.
//
// Times with a Z are UTC; those with a TZID are that zone's (an IANA name,
// or one of Windows's that Outlook writes); the others, and a zone not
// known, are read as the computer's local time, which is what a calendar in
// the user's own time zone means. Repeating events
// (RRULE: daily, weekly on given days, monthly on a date or the nth weekday,
// yearly, with INTERVAL, COUNT, UNTIL and EXDATE) are expanded; a moved
// occurrence (RECURRENCE-ID) replaces the one it moves.

export interface CalEvent {
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location: string;
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Folded lines unfolded, each split into name, parameters and value. */
function props(text: string): Prop[] {
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
  const out: Prop[] = [];
  for (const line of lines) {
    const colon = findColon(line);
    if (colon < 0) continue;
    const [name, ...rest] = line.slice(0, colon).split(";");
    const params: Record<string, string> = {};
    for (const p of rest) {
      const eq = p.indexOf("=");
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
    }
    out.push({ name: name.toUpperCase(), params, value: line.slice(colon + 1) });
  }
  return out;
}

/** The colon after the parameters (a quoted parameter may hold one). */
function findColon(line: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ":" && !quoted) return i;
  }
  return -1;
}

function unescape(v: string): string {
  return v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}

/** Windows's names for the zones met most, as Outlook writes them in TZID. */
const WINDOWS_ZONES: Record<string, string> = {
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  "Central European Standard Time": "Europe/Warsaw",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "Russian Standard Time": "Europe/Moscow",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Tokyo Standard Time": "Asia/Tokyo",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "UTC": "UTC",
};

/** Formatters by zone: making one is slow, and a calendar asks again and again. */
const zoneFormats = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormat(tzid: string): Intl.DateTimeFormat | null {
  const zone = WINDOWS_ZONES[tzid] ?? tzid.replace(/^\/+/, "");
  if (!zoneFormats.has(zone)) {
    let format: Intl.DateTimeFormat | null = null;
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
    } catch {
      // Not a zone this computer knows: local time, as before.
    }
    zoneFormats.set(zone, format);
  }
  return zoneFormats.get(zone) ?? null;
}

/** The wall time `y-mo-da h:mi:s` in zone `tzid`, as a time; null for a zone not known. */
export function zonedTime(y: number, mo: number, da: number, h: number, mi: number, s: number, tzid: string): number | null {
  const format = zoneFormat(tzid);
  if (!format) return null;
  const wall = Date.UTC(y, mo, da, h, mi, s);
  // How far the zone is from UTC at `at`: its wall time there, less `at`.
  const offset = (at: number) => {
    const parts: Record<string, number> = {};
    for (const p of format.formatToParts(new Date(at))) if (p.type !== "literal") parts[p.type] = +p.value;
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - at;
  };
  // The zone's offsets half a day either side: a time each, kept if the zone
  // reads it as that wall time. When the clocks go back the hour comes twice:
  // the first, as RFC 5545 says.
  const hours12 = 12 * 3_600_000;
  const times = [...new Set([offset(wall - hours12), offset(wall + hours12)])]
    .map((o) => wall - o)
    .filter((at) => at + offset(at) === wall);
  if (times.length) return Math.min(...times);
  // A wall time the zone skips (clocks going forward): twice, the first guess
  // may fall on the other side of the change.
  const first = wall - offset(wall);
  return wall - offset(first);
}

/** Turns a wall time (month from 0; days past the month's end roll over) into a time. */
type Clock = (y: number, mo: number, da: number, h: number, mi: number, s: number) => number;

const localClock: Clock = (y, mo, da, h, mi, s) => new Date(y, mo, da, h, mi, s).getTime();
const utcClock: Clock = (y, mo, da, h, mi, s) => Date.UTC(y, mo, da, h, mi, s);

/**
 * An iCal date or date-time as it is written: its wall time, and the clock
 * that reads it (UTC, its TZID's zone, or the computer's). A repeating event
 * keeps its wall time on that clock, so 14:00 UTC stays 14:00 UTC after the
 * computer's clock changes.
 */
interface IcsWall {
  y: number;
  mo: number;
  da: number;
  h: number;
  mi: number;
  s: number;
  allDay: boolean;
  clock: Clock;
}

function readIcsDate(value: string, params: Record<string, string>): IcsWall | null {
  const v = value.trim();
  const d = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!d) return null;
  const [y, mo, da] = [+d[1], +d[2] - 1, +d[3]];
  if (d[4] == null || params.VALUE === "DATE") return { y, mo, da, h: 0, mi: 0, s: 0, allDay: true, clock: localClock };
  const [h, mi, s] = [+d[4], +d[5], +(d[6] ?? 0)];
  let clock = localClock;
  if (d[7]) clock = utcClock;
  else if (params.TZID && zoneFormat(params.TZID)) {
    const tzid = params.TZID;
    clock = (y, mo, da, h, mi, s) => zonedTime(y, mo, da, h, mi, s, tzid) ?? localClock(y, mo, da, h, mi, s);
  }
  return { y, mo, da, h, mi, s, allDay: false, clock };
}

/** An iCal date or date-time: its time, and whether it is a whole day. */
export function parseIcsDate(value: string, params: Record<string, string> = {}): { time: number; allDay: boolean } | null {
  const w = readIcsDate(value, params);
  return w ? { time: w.clock(w.y, w.mo, w.da, w.h, w.mi, w.s), allDay: w.allDay } : null;
}

/** "PT1H30M", "P1D": an iCal duration in ms. */
function parseDurationIcs(v: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return 0;
  const [w, d, h, mi, s] = [m[2], m[3], m[4], m[5], m[6]].map((x) => +(x ?? 0));
  return ((((w * 7 + d) * 24 + h) * 60 + mi) * 60 + s) * 1000 * (m[1] === "-" ? -1 : 1);
}

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

interface Rule {
  freq: string;
  interval: number;
  count: number | null;
  until: number | null;
  byDay: { n: number; day: number }[];
  /** BYMONTH, 0 for January. */
  byMonth: number[];
  /** BYMONTHDAY, -1 for the last day. */
  byMonthDay: number[];
  /** BYSETPOS: which of each month's (or year's) days, -1 the last ("the last weekday of the month"). */
  bySetPos: number[];
}

/** The parts of a rule read here. One with any other (BYWEEKNO, BYYEARDAY, BYHOUR…) shows its first time only, never wrong days. */
const RULE_PARTS = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTH", "BYMONTHDAY", "BYSETPOS", "WKST"]);

const numbers = (v: string | undefined, ok: (n: number) => boolean): number[] =>
  (v ?? "").split(",").map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && ok(n));

function parseRule(v: string): Rule | null {
  const parts: Record<string, string> = {};
  for (const p of v.split(";")) {
    const [k, val] = p.split("=");
    if (k && val) parts[k.toUpperCase()] = val.toUpperCase();
  }
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(parts.FREQ)) return null;
  if (Object.keys(parts).some((k) => !RULE_PARTS.has(k))) return null;
  const byDay = (parts.BYDAY ?? "")
    .split(",")
    .map((x) => /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x))
    .filter((m): m is RegExpExecArray => m != null)
    .map((m) => ({ n: m[1] ? parseInt(m[1], 10) : 0, day: WEEKDAYS.indexOf(m[2]) }));
  return {
    freq: parts.FREQ,
    interval: Math.max(1, parseInt(parts.INTERVAL ?? "1", 10) || 1),
    count: parts.COUNT ? parseInt(parts.COUNT, 10) : null,
    until: parts.UNTIL ? parseIcsDate(parts.UNTIL)?.time ?? null : null,
    byDay,
    byMonth: numbers(parts.BYMONTH, (n) => n >= 1 && n <= 12).map((n) => n - 1),
    byMonthDay: numbers(parts.BYMONTHDAY, (n) => n !== 0 && n >= -31 && n <= 31),
    bySetPos: numbers(parts.BYSETPOS, (n) => n !== 0 && n >= -366 && n <= 366),
  };
}

/** The days of month `m` a monthly or yearly rule falls on: its BYMONTHDAY, its BYDAY (nth or every), else `fallback`'s day. */
function daysOf(rule: Rule, y: number, m: number, fallback: number): number[] {
  const length = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const days: number[] = [];
  if (rule.byMonthDay.length) {
    for (const d of rule.byMonthDay) {
      const day = d > 0 ? d : length + 1 + d;
      if (day >= 1 && day <= length) days.push(day);
    }
  }
  if (rule.byDay.length) {
    const weekdays: number[] = [];
    for (const b of rule.byDay) {
      // "BYDAY=MO" with no number: every Monday of the month.
      for (const n of b.n ? [b.n] : [1, 2, 3, 4, 5]) {
        const d = nthWeekday(y, m, b.day, n);
        if (d != null) weekdays.push(d);
      }
    }
    // Both: the days that are both (BYMONTHDAY=13;BYDAY=FR, Friday the 13th).
    if (rule.byMonthDay.length) return days.filter((d) => weekdays.includes(d)).sort((a, b) => a - b);
    days.push(...weekdays);
  }
  // The 31st in a month without one is skipped, as calendars do.
  if (!rule.byMonthDay.length && !rule.byDay.length && fallback <= length) days.push(fallback);
  return [...new Set(days)].sort((a, b) => a - b);
}

/** BYSETPOS: of a month's or a year's days in order, only the ones at those places (1 the first, -1 the last). */
function setPositions(rule: Rule, days: number[]): number[] {
  if (!rule.bySetPos.length) return days;
  const picked = rule.bySetPos.map((p) => days[p > 0 ? p - 1 : days.length + p]).filter((t): t is number => t != null);
  return [...new Set(picked)].sort((a, b) => a - b);
}

/** The day of the month of the nth (1…5, or -1 for the last) `weekday`, or null. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number | null {
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  if (n > 0) {
    const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    return day <= days ? day : null;
  }
  const last = new Date(Date.UTC(year, month, days)).getUTCDay();
  const day = days - ((last - weekday + 7) % 7) + (n + 1) * 7;
  return day >= 1 ? day : null;
}

/** The longest one step of each frequency can be (a day with a clock change, a 31-day month, a leap year). */
const LONGEST_STEP: Record<string, number> = {
  DAILY: 25 * 3_600_000,
  WEEKLY: 7 * 24 * 3_600_000 + 3_600_000,
  MONTHLY: 31 * 24 * 3_600_000 + 3_600_000,
  YEARLY: 366 * 24 * 3_600_000 + 3_600_000,
};

/** How many steps looked at past the first one that may reach `from`. */
const STEPS = 2000;

/**
 * The starts of a repeating event, in order, up to `to` (STEPS looked at). A
 * rule with no COUNT starts near `from`, so a daily event set up years ago
 * still shows; one with a COUNT is counted from its start. The days are
 * counted on the event's own clock (its zone, UTC or the computer's), so an
 * occurrence keeps the hour it was written with when a clock changes.
 */
function occurrences(first: IcsWall, rule: Rule, from: number, to: number): number[] {
  const out: number[] = [];
  const { y: fy, mo: fm, da: fd } = first;
  const at = (y: number, mo: number, da: number) => first.clock(y, mo, da, first.h, first.mi, first.s);
  const start = at(fy, fm, fd);
  const limit = Math.min(to, rule.until ?? Infinity);
  let produced = 0;
  const take = (t: number): boolean => {
    if (t < start) return true;
    if (t > limit || (rule.count != null && produced >= rule.count)) return false;
    produced++;
    out.push(t);
    return true;
  };
  // Steps that surely end before `from`: never more than really passed, since
  // each is counted at its longest.
  const skip = rule.count == null && from > start
    ? Math.max(0, Math.floor((from - start) / (LONGEST_STEP[rule.freq] * rule.interval)) - 1)
    : 0;
  const steps = rule.count == null ? STEPS : Math.max(STEPS, Math.min(rule.count, 100_000));
  // Weekdays and month lengths from a calendar with no clock changes.
  const firstDay = new Date(Date.UTC(fy, fm, fd)).getUTCDay();
  for (let step = skip; step < skip + steps; step++) {
    const batch: number[] = [];
    // A day kept by BYMONTH, when the rule has one (a day of the calendar with no clock changes).
    const inMonths = (y: number, mo: number, da: number) => !rule.byMonth.length || rule.byMonth.includes(new Date(Date.UTC(y, mo, da)).getUTCMonth());
    if (rule.freq === "DAILY") {
      const da = fd + step * rule.interval;
      // "Every weekday": BYDAY keeps only those days of the week.
      const weekday = new Date(Date.UTC(fy, fm, da)).getUTCDay();
      if ((!rule.byDay.length || rule.byDay.some((b) => b.day === weekday)) && inMonths(fy, fm, da)) batch.push(at(fy, fm, da));
    } else if (rule.freq === "WEEKLY") {
      const weekStart = fd - firstDay + step * 7 * rule.interval;
      const days = rule.byDay.length ? rule.byDay.map((b) => b.day) : [firstDay];
      for (const day of [...days].sort((a, b) => a - b)) if (inMonths(fy, fm, weekStart + day)) batch.push(at(fy, fm, weekStart + day));
    } else if (rule.freq === "MONTHLY") {
      // Year and month counted on.
      const month = new Date(Date.UTC(fy, fm + step * rule.interval, 1));
      const y = month.getUTCFullYear();
      const m = month.getUTCMonth();
      if (!rule.byMonth.length || rule.byMonth.includes(m)) {
        for (const d of setPositions(rule, daysOf(rule, y, m, fd))) batch.push(at(y, m, d));
      }
    } else {
      const y = fy + step * rule.interval;
      // "The second Sunday of March": the days in each month of BYMONTH (the
      // event's own month without one), then BYSETPOS over the whole year.
      const days: [number, number][] = [];
      for (const m of rule.byMonth.length ? [...rule.byMonth].sort((a, b) => a - b) : [fm]) {
        if (!rule.byDay.length && !rule.byMonthDay.length) {
          // The 29th of February only in a leap year.
          if (new Date(Date.UTC(y, m, fd)).getUTCMonth() === m) days.push([m, fd]);
        } else {
          for (const d of daysOf(rule, y, m, fd)) days.push([m, d]);
        }
      }
      const order = days.map((_, i) => i);
      for (const i of setPositions(rule, order)) batch.push(at(y, days[i][0], days[i][1]));
    }
    for (const t of batch) if (!take(t)) return out;
    if (batch.length && Math.min(...batch) > limit) return out;
  }
  return out;
}

/** The events between `from` and `to`, soonest first. */
export function parseIcs(text: string, from: number, to: number): CalEvent[] {
  type Raw = { props: Prop[] };
  const events: Raw[] = [];
  let current: Raw | null = null;
  for (const p of props(text)) {
    if (p.name === "BEGIN" && p.value.toUpperCase() === "VEVENT") current = { props: [] };
    else if (p.name === "END" && p.value.toUpperCase() === "VEVENT") {
      if (current) events.push(current);
      current = null;
    } else if (current) current.props.push(p);
  }
  const moved = new Map<string, Set<number>>();
  for (const e of events) {
    const rid = e.props.find((p) => p.name === "RECURRENCE-ID");
    const uid = e.props.find((p) => p.name === "UID")?.value ?? "";
    const t = rid ? parseIcsDate(rid.value, rid.params)?.time : null;
    if (t != null) {
      if (!moved.has(uid)) moved.set(uid, new Set());
      moved.get(uid)!.add(t);
    }
  }
  const out: CalEvent[] = [];
  for (const e of events) {
    const get = (n: string) => e.props.find((p) => p.name === n);
    if ((get("STATUS")?.value ?? "").toUpperCase() === "CANCELLED") continue;
    const dtStart = get("DTSTART");
    const wall = dtStart ? readIcsDate(dtStart.value, dtStart.params) : null;
    if (!wall) continue;
    const start = { time: wall.clock(wall.y, wall.mo, wall.da, wall.h, wall.mi, wall.s), allDay: wall.allDay };
    const dtEnd = get("DTEND");
    const end = dtEnd ? parseIcsDate(dtEnd.value, dtEnd.params)?.time : null;
    const duration = end != null ? end - start.time
      : get("DURATION") ? parseDurationIcs(get("DURATION")!.value)
      : start.allDay ? 86_400_000 : 0;
    const title = unescape(get("SUMMARY")?.value ?? "") || "—";
    const location = unescape(get("LOCATION")?.value ?? "");
    const rruleProp = get("RRULE");
    const rule = rruleProp && !get("RECURRENCE-ID") ? parseRule(rruleProp.value) : null;
    let starts = rule ? occurrences(wall, rule, from, to) : [start.time];
    if (rule) {
      const skip = new Set<number>();
      for (const ex of e.props.filter((p) => p.name === "EXDATE")) {
        for (const v of ex.value.split(",")) {
          const t = parseIcsDate(v, ex.params)?.time;
          if (t != null) skip.add(t);
        }
      }
      for (const t of moved.get(get("UID")?.value ?? "") ?? []) skip.add(t);
      starts = starts.filter((t) => !skip.has(t));
    }
    // A whole-day event lasts whole days, ending at local midnight even on the
    // day the clocks change (23 or 25 hours long).
    const days = Math.max(1, Math.round(duration / 86_400_000));
    for (const t of starts) {
      const d = new Date(t);
      const endT = start.allDay ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + days).getTime() : t + Math.max(0, duration);
      if (endT <= from && !(duration === 0 && t >= from)) continue;
      if (t > to) continue;
      out.push({ title, start: t, end: endT, allDay: start.allDay, location });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
}

/** The event about to start (within `soonMs`) or under way, for the closed island. */
export function eventSoon(events: CalEvent[], now: number, soonMs = 15 * 60_000): CalEvent | null {
  return events.find((e) => !e.allDay && e.start - now <= soonMs && e.start - now > -5 * 60_000 && e.end > now) ?? null;
}

// ── A failed fetch ───────────────────────────────────────────────────────────

const CALENDAR_RETRY_MS = 30_000;
/** Failed fetches in a row before the error replaces the events already read. */
export const CALENDAR_FAILURES_SHOWN = 3;

/** After `failures` failed fetches in a row, the wait before the next: 30 s, then doubled, never past `every`. */
export function calendarRetryIn(failures: number, every: number): number {
  return Math.min(every, CALENDAR_RETRY_MS * 2 ** Math.max(0, failures - 1));
}

/** Whether a failed fetch is shown, or the events already read are kept. */
export function showsCalendarError(failures: number, hasRead: boolean): boolean {
  return !hasRead || failures >= CALENDAR_FAILURES_SHOWN;
}

/**
 * The calendar's own web page, told by the app that wrote the file (its
 * PRODID), so the address itself never leaves calendar.rs. Null when the
 * calendar has no page Lumo knows.
 */
export function calendarWebLink(text: string): string | null {
  const prodid = /^PRODID:(.*)$/im.exec(text)?.[1]?.toLowerCase() ?? "";
  if (prodid.includes("google")) return "https://calendar.google.com/calendar/r";
  if (prodid.includes("microsoft")) return "https://outlook.live.com/calendar/0/view/day";
  if (prodid.includes("apple")) return "https://www.icloud.com/calendar/";
  return null;
}
