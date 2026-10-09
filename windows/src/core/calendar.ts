// The calendar for the live activities: an iCal file (Google Calendar's
// "secret address in iCal format", Outlook's published calendar, iCloud's
// public link…) read into the events of the next days. Pure: calendar.rs
// fetches the file, island/activities.ts shows it.
//
// Times with a Z are UTC; the others are read as the computer's local time,
// which is what a calendar in the user's own time zone means. Repeating events
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

/** An iCal date or date-time: its time, and whether it is a whole day. */
export function parseIcsDate(value: string, params: Record<string, string> = {}): { time: number; allDay: boolean } | null {
  const v = value.trim();
  const d = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!d) return null;
  const [y, mo, da] = [+d[1], +d[2] - 1, +d[3]];
  if (d[4] == null || params.VALUE === "DATE") return { time: new Date(y, mo, da).getTime(), allDay: true };
  const [h, mi, s] = [+d[4], +d[5], +(d[6] ?? 0)];
  const time = d[7] ? Date.UTC(y, mo, da, h, mi, s) : new Date(y, mo, da, h, mi, s).getTime();
  return { time, allDay: false };
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
}

function parseRule(v: string): Rule | null {
  const parts: Record<string, string> = {};
  for (const p of v.split(";")) {
    const [k, val] = p.split("=");
    if (k && val) parts[k.toUpperCase()] = val.toUpperCase();
  }
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(parts.FREQ)) return null;
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
  };
}

/** The nth (1…5, or -1 for the last) `weekday` of a month, or null. */
function nthWeekday(year: number, month: number, weekday: number, n: number, h: number, mi: number, s: number): Date | null {
  if (n > 0) {
    const first = new Date(year, month, 1).getDay();
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    const d = new Date(year, month, day, h, mi, s);
    return d.getMonth() === month ? d : null;
  }
  const lastDay = new Date(year, month + 1, 0);
  const day = lastDay.getDate() - ((lastDay.getDay() - weekday + 7) % 7) + (n + 1) * 7;
  const d = new Date(year, month, day, h, mi, s);
  return d.getMonth() === month ? d : null;
}

/** The starts of a repeating event, in order, up to `to` (at most 2000 looked at). */
function occurrences(start: number, rule: Rule, to: number): number[] {
  const out: number[] = [];
  const first = new Date(start);
  const [h, mi, s] = [first.getHours(), first.getMinutes(), first.getSeconds()];
  const limit = Math.min(to, rule.until ?? Infinity);
  let produced = 0;
  const take = (t: number): boolean => {
    if (t < start) return true;
    if (t > limit || (rule.count != null && produced >= rule.count)) return false;
    produced++;
    out.push(t);
    return true;
  };
  for (let step = 0; step < 2000; step++) {
    const batch: number[] = [];
    if (rule.freq === "DAILY") {
      batch.push(new Date(first.getFullYear(), first.getMonth(), first.getDate() + step * rule.interval, h, mi, s).getTime());
    } else if (rule.freq === "WEEKLY") {
      const weekStart = new Date(first.getFullYear(), first.getMonth(), first.getDate() - first.getDay() + step * 7 * rule.interval);
      const days = rule.byDay.length ? rule.byDay.map((b) => b.day) : [first.getDay()];
      for (const day of [...days].sort((a, b) => a - b)) {
        batch.push(new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + day, h, mi, s).getTime());
      }
    } else if (rule.freq === "MONTHLY") {
      const y = first.getFullYear();
      const m = first.getMonth() + step * rule.interval;
      if (rule.byDay.length) {
        for (const b of rule.byDay) {
          const d = nthWeekday(y, m, b.day, b.n || 1, h, mi, s);
          if (d) batch.push(d.getTime());
        }
        batch.sort((a, b) => a - b);
      } else {
        const d = new Date(y, m, first.getDate(), h, mi, s);
        // The 31st in a month without one is skipped, as calendars do.
        if (d.getDate() === first.getDate()) batch.push(d.getTime());
      }
    } else {
      const d = new Date(first.getFullYear() + step * rule.interval, first.getMonth(), first.getDate(), h, mi, s);
      if (d.getMonth() === first.getMonth()) batch.push(d.getTime());
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
    const start = dtStart ? parseIcsDate(dtStart.value, dtStart.params) : null;
    if (!start) continue;
    const dtEnd = get("DTEND");
    const end = dtEnd ? parseIcsDate(dtEnd.value, dtEnd.params)?.time : null;
    const duration = end != null ? end - start.time
      : get("DURATION") ? parseDurationIcs(get("DURATION")!.value)
      : start.allDay ? 86_400_000 : 0;
    const title = unescape(get("SUMMARY")?.value ?? "") || "—";
    const location = unescape(get("LOCATION")?.value ?? "");
    const rruleProp = get("RRULE");
    const rule = rruleProp && !get("RECURRENCE-ID") ? parseRule(rruleProp.value) : null;
    let starts = rule ? occurrences(start.time, rule, to) : [start.time];
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
    for (const t of starts) {
      const endT = t + Math.max(0, duration);
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
