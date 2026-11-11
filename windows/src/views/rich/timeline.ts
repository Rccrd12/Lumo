// The ```lumo-timeline card: dates laid out from left to right, the island's
// own shape. Two kinds, picked from the dates themselves:
//
//   ```lumo-timeline From the transistor to the microprocessor
//   1947 Transistor — Bardeen, Brattain and Shockley at Bell Labs.
//   1958 Integrated circuit
//     Kilby puts several components on one piece of germanium.
//   1971-11 Intel 4004: the first microprocessor on a single chip.
//   ```
//
//   ```lumo-timeline Calculus 2
//   2026-11-01..2026-11-07 Limits
//   8/11–16/11 Multiple integrals
//   2026-12-09 ◆ Exam
//   ```
//
// Each line starts with a date, then the event's name, then optionally its
// detail after " — ", " – ", " - " or ": ", or on the indented lines under
// it. A date is a year (1947, -500, 500 BC), a month (1971-11) or a day
// (2026-11-08, 8/11/2026, 8/11); a day without its year is the one nearest
// today, or nearest the date before it. Day and month order in 8/11 comes
// from the block (a 13 or more on either side settles it), else from the
// app's language.
//
// Only single dates: events, spaced by their real dates and set above and
// below the line in turn so their names don't run into each other. A click
// on a point (or the arrow keys) opens its detail under the line.
//
// A date range anywhere, `from–to`, `from..to`, `from - to`: a plan, a bar
// per phase. Measured in days, the phases read against today, from the PC's
// calendar, never from the model: done, current, to do, and a dashed line
// on today; a single date in it is a deadline (◆), and the top line counts
// the days left to the last one.
//
// From 2 to 20 dates. A block without them is no card: null, and
// markdown.ts shows it as the code it was written as.

import { h, svg } from "../dom";
import { ICONS } from "../icons";
import { N_, dayMonth, language, t, tn } from "../../i18n/i18n";
import { head, remember, RICH_STRINGS, type RichContext } from "./index";
import "./timeline.css";
import { onResize } from "./resize";

export const TIMELINE_STRINGS = {
  hint: N_("Click a point to read what happened · ← → to move"),
  previous: N_("Previous event"),
  next: N_("Next event"),
  phase: N_("phase {n} of {total}"),
  today: N_("today"),
  bc: N_("{year} BC"),
};

export const MIN_DATES = 2;
export const MAX_DATES = 20;

export type Unit = "year" | "month" | "day";

/** A date as written: its first day and the day after its last, counted from 1 January 1970. */
export interface When {
  unit: Unit;
  year: number;
  /** 0–11; 0 for a year. */
  month: number;
  /** 1–31; 1 for a year or a month. */
  day: number;
  start: number;
  end: number;
}

export interface TimelineItem {
  from: When;
  /** The last date of a phase (its whole unit included); null for an event or a deadline. */
  to: When | null;
  /** Its name, plain text. */
  label: string;
  /** What happened, inline Markdown; "" when the block says nothing more. */
  detail: string;
  /** A deadline: a single date marked ◆, or any single date in a plan. */
  milestone: boolean;
}

export interface Timeline {
  title: string;
  /** "events" for single dates; "plan" when at least one line is a range. */
  kind: "events" | "plan";
  /** In date order. */
  items: TimelineItem[];
}

// ── Reading ───────────────────────────────────────────────────────────────────

const ISO_DAY = /^(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/;
const ISO_MONTH = /^(\d{4})-(\d{1,2})(?![\d/.])/;
const SLASHED = /^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{4}|\d{2}))?(?![\d/])/;
/** A year, with its era if it has one: 1947, -500, 500 BC, 500 a.C., 1066 AD. */
const YEAR = /^(-?\d{1,6})(?:\s?(B\.?\s?C\.?(?:E\.?)?|a\.?\s?C\.?|av\.\s?J\.?-?C\.?|v\.\s?Chr\.?|A\.?D\.?|C\.?E\.?|d\.\s?C\.?))?(?![\d\p{L}])/iu;
/** Between the two dates of a range. */
const RANGE = /^(?:\s*(?:–|—|\.\.\.?|…|→|->|\bto\b)\s*|\s+-\s+|-(?=\d))/;
/** The deadline mark, before or after the date. */
const MILESTONE = /^[◆♦⬥◇]\s*/;
/** A list marker before a line. */
const MARKER = /^(?:[-*+•]|\d+[.)])\s+(?=\S)/;
/** Between a name and its detail. */
const DETAIL = /\s+[—–-]\s+|:\s+/;

/** A date as it was read, before the block settles day and month order and the missing years. */
interface Raw {
  unit: Unit;
  /** NaN when the date was written without one (8/11). */
  year: number;
  /** For a slashed date: its two numbers as written. */
  slashed?: [number, number];
  month: number;
  day: number;
  /** A bare number of one or two digits, which may be a day in a range ("8–16/11"). */
  short?: boolean;
}

interface RawLine {
  from: Raw;
  to: Raw | null;
  label: string;
  detail: string[];
  milestone: boolean;
}

/**
 * Reads a lumo-timeline block. Forgiving: list markers, `**` around a date,
 * a colon after it, eras, ranges written several ways, details on the next
 * lines. `now` stands for today, which fixes a day written without its year.
 * Null when it has fewer than 2 dates or more than 20.
 */
export function parseTimeline(title: string, body: string, now: Date = new Date()): Timeline | null {
  const lines: RawLine[] = [];
  let indent = 0;
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw.trim()) continue;
    const depth = raw.length - raw.trimStart().length;
    // A line set in under the date before it is its detail, even one that starts with a number.
    const line = lines.length && depth > indent ? null : readLine(raw);
    if (line) {
      lines.push(line);
      indent = depth;
    } else if (lines.length) {
      lines[lines.length - 1].detail.push(raw.trim());
    }
    if (lines.length > MAX_DATES) return null;
  }
  if (lines.length < MIN_DATES) return null;

  const order = slashOrder(lines);
  const items: TimelineItem[] = [];
  let near = localDay(now);
  for (const l of lines) {
    let from: When | null;
    let to: When | null = null;
    if (l.to && l.from.short && l.to.unit === "day") {
      // "8–16/11": the short start is a day of its end's month.
      to = settle(l.to, order, near);
      from = to && dayOf(to, l.from.year);
    } else {
      from = settle(l.from, order, near);
      // "2026-11-08..16": the short end is a day of its start's month.
      // "1939-45": the short end is a year of its start's century.
      if (l.to && from) {
        if (l.to.short && from.unit === "day") to = dayOf(from, l.to.year);
        else if (l.to.short && from.unit === "year" && from.year >= 100) to = when("year", centuryOf(from.year, l.to.year), 0, 1);
        else to = settle(l.to, order, from.start);
      }
    }
    if (!from || (l.to && !to)) continue;
    near = from.start;
    items.push({ from, to, label: l.label, detail: l.detail.join(" ").trim(), milestone: l.milestone });
  }
  if (items.length < MIN_DATES) return null;
  // A range written backwards runs forwards.
  for (const it of items) if (it.to && it.to.start < it.from.start) [it.from, it.to] = [it.to, it.from];
  items.sort((a, b) => a.from.start - b.from.start);
  const kind = items.some((i) => i.to) ? "plan" : "events";
  if (kind === "plan") for (const i of items) if (!i.to) i.milestone = true;
  return { title: title.trim(), kind, items };
}

/** One line of the block as a date and its words; null when it doesn't start with a date. */
function readLine(raw: string): RawLine | null {
  let s = raw.trim().replace(MARKER, "");
  let milestone = false;
  const mark = () => {
    const m = MILESTONE.exec(s);
    if (m) {
      milestone = true;
      s = s.slice(m[0].length);
    }
  };
  mark();
  // **1947** Transistor
  s = s.replace(/^\*\*([^*]+)\*\*/, "$1");
  const first = readDate(s);
  if (!first) return null;
  s = s.slice(first.length);
  let to: Raw | null = null;
  const sep = RANGE.exec(s);
  if (sep) {
    const second = readDate(s.slice(sep[0].length));
    if (second) {
      to = second.raw;
      s = s.slice(sep[0].length + second.length);
    }
  }
  // The date must stand apart from the words: "1947s" or "3D" isn't one.
  if (s && !/^(?:[\s:,·*◆♦⬥◇)\]]|\.(?:\s|$))/.test(s)) return null;
  s = s.replace(/^\*\*/, "").replace(/^[\s:,.·)\]]+/, "");
  mark();
  s = s.replace(/^[-–—]\s+/, "");
  let label = s.trim();
  let detail = "";
  const split = DETAIL.exec(label);
  if (split && split.index > 0) {
    detail = label.slice(split.index + split[0].length).trim();
    label = label.slice(0, split.index).trim();
  }
  label = label.replace(/\*\*|__|`/g, "").trim();
  return { from: first.raw, to, label, detail: detail ? [detail] : [], milestone };
}

/** The date at the start of `s` and how many characters it takes. */
function readDate(s: string): { raw: Raw; length: number } | null {
  let m = ISO_DAY.exec(s);
  if (m) {
    const raw: Raw = { unit: "day", year: +m[1], month: +m[2] - 1, day: +m[3] };
    return valid(raw) ? { raw, length: m[0].length } : null;
  }
  m = ISO_MONTH.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12) return { raw: { unit: "month", year: +m[1], month: +m[2] - 1, day: 1 }, length: m[0].length };
  m = SLASHED.exec(s);
  if (m) {
    let year = NaN;
    if (m[3]) year = m[3].length === 2 ? (+m[3] < 70 ? 2000 : 1900) + +m[3] : +m[3];
    return { raw: { unit: "day", year, month: 0, day: 1, slashed: [+m[1], +m[2]] }, length: m[0].length };
  }
  m = YEAR.exec(s);
  if (m) {
    let year = +m[1];
    if (m[2] && !/^(?:A\.?D|C\.?E|d\.)/i.test(m[2])) year = -Math.abs(year);
    return { raw: { unit: "year", year, month: 0, day: 1, short: /^\d{1,2}$/.test(m[1]) && !m[2] }, length: m[0].length };
  }
  return null;
}

/** Day first (8/11 is 8 November) or month first (11/8), for the whole block. */
function slashOrder(lines: RawLine[]): "dm" | "md" {
  const pairs = lines.flatMap((l) => [l.from.slashed, l.to?.slashed]).filter((p): p is [number, number] => !!p);
  if (pairs.some(([a]) => a > 12)) return "dm";
  if (pairs.some(([, b]) => b > 12)) return "md";
  return language() === "en" ? "md" : "dm";
}

/** A date with its order and year settled; a missing year is the one nearest `near` (a day number). */
function settle(raw: Raw, order: "dm" | "md", near: number): When | null {
  let { year, month, day } = raw;
  if (raw.slashed) {
    const [a, b] = raw.slashed;
    [day, month] = order === "dm" ? [a, b - 1] : [b, a - 1];
  }
  if (Number.isNaN(year)) {
    const around = new Date(near * DAY).getUTCFullYear();
    let best = around;
    for (const y of [around - 1, around + 1]) {
      if (Math.abs(dayNumber(y, month, day) - near) < Math.abs(dayNumber(best, month, day) - near)) best = y;
    }
    year = best;
  }
  const r: Raw = { unit: raw.unit, year, month, day };
  return valid(r) ? when(r.unit, year, month, day) : null;
}

/** The year ending in `yy` (0–99) on or after `year`: 45 after 1939 is 1945, 3 after 1998 is 2003. */
function centuryOf(year: number, yy: number): number {
  const y = year - (year % 100) + yy;
  return y < year ? y + 100 : y;
}

/** Day `day` of `w`'s month, or null when it has no such day. */
function dayOf(w: When, day: number): When | null {
  return valid({ unit: "day", year: w.year, month: w.month, day }) ? when("day", w.year, w.month, day) : null;
}

function valid(r: Raw): boolean {
  // Past about 271,000 years either way a Date has no day for it (NaN on the card).
  if (!Number.isFinite(r.year) || Math.abs(r.year) > MAX_YEAR) return false;
  if (r.unit === "year") return true;
  if (r.month < 0 || r.month > 11) return false;
  if (r.unit === "month") return true;
  return r.day >= 1 && r.day <= new Date(dayNumber(r.year, r.month + 1, 1) * DAY - DAY).getUTCDate();
}

const DAY = 86_400_000;

/** The furthest year either way a Date can count the days of (±271,821 at most). */
const MAX_YEAR = 270_000;

/** Days from 1 January 1970 to the date, any year (Date.UTC would read 0–99 as 1900–1999). */
function dayNumber(year: number, month: number, day: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month, day);
  return Math.round(d.getTime() / DAY);
}

function when(unit: Unit, year: number, month: number, day: number): When {
  const start = dayNumber(year, month, day);
  const end = unit === "year" ? dayNumber(year + 1, 0, 1) : unit === "month" ? dayNumber(year, month + 1, 1) : start + 1;
  return { unit, year, month, day, start, end };
}

/** Today in the PC's own calendar, as a day number. */
function localDay(now: Date): number {
  return dayNumber(now.getFullYear(), now.getMonth(), now.getDate());
}

// ── Words for dates ───────────────────────────────────────────────────────────

function yearText(year: number): string {
  return year < 0 ? t(TIMELINE_STRINGS.bc, { year: -year }) : String(year);
}

function intl(options: Intl.DateTimeFormatOptions, w: When): string | null {
  if (w.year < 1) return null;
  try {
    return new Intl.DateTimeFormat(language(), { ...options, timeZone: "UTC" }).format(new Date(w.start * DAY));
  } catch {
    return null;
  }
}

/** A date as the card shows it: 1947, Nov 1971, Nov 8 (with its year when the card spans several). */
export function dateText(w: When, withYear = true): string {
  if (w.unit === "year" || w.year < 1) return yearText(w.year);
  if (w.unit === "month") return intl({ month: "short", year: "numeric" }, w) ?? `${w.year}-${String(w.month + 1).padStart(2, "0")}`;
  if (!withYear) return dayMonth(w.month, w.day);
  return intl({ day: "numeric", month: "short", year: "numeric" }, w) ?? `${w.year}-${String(w.month + 1).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

// ── The card ──────────────────────────────────────────────────────────────────

/** What a card remembers across the chat's redraws: the event open below the line (-1 for none). */
interface Place {
  at: number;
}

/** The card for `tl`; `key` keeps the open event. `now` stands for today (tests). */
export function renderTimeline(tl: Timeline, ctx: RichContext, key: string, now: Date = new Date()): HTMLElement {
  return tl.kind === "plan" ? renderPlan(tl, now, ctx) : renderEvents(tl, ctx, key);
}

/** Where a position from 0 to 1 lies in a box `left` pixels in from its left side and `right` from its right. */
function at(f: number, left: number, right = left): string {
  return `calc(${left}px + ${round(f)} * (100% - ${left + right}px))`;
}

/**
 * The room kept free on each side of the dates, in pixels, as the approved
 * design has it: more on the left, where the first name is centred on its
 * point; on the right the line fades out past the last one.
 */
const EVENTS_LEFT = 22;
const EVENTS_RIGHT = 10;
const PLAN_LEFT = 12;

/** An event's dot, the least room between two dots' centres, and between a name and the card's edge. */
const DOT = 10;
const DOT_GAP = 14;
const EDGE = 8;

/** About the narrowest a plan's dates get, in pixels, for guessing where a deadline's name fits. */
const NARROW = 480;

function round(f: number): number {
  return Math.round(Math.min(Math.max(f, 0), 1) * 1e5) / 1e5;
}

/** The finest unit among the dates. */
function finest(items: TimelineItem[]): Unit {
  const units = items.flatMap((i) => [i.from.unit, i.to?.unit]);
  return units.includes("day") ? "day" : units.includes("month") ? "month" : "year";
}

/** Day `day` moved by `n` whole `unit`s, back when `n` is negative. */
function shift(day: number, unit: Unit, n: number): number {
  if (unit === "day" || n === 0) return day + n;
  const d = new Date(day * DAY);
  if (unit === "month") d.setUTCMonth(d.getUTCMonth() + n);
  else d.setUTCFullYear(d.getUTCFullYear() + n);
  return Math.round(d.getTime() / DAY);
}

/** How many `unit`s from day `a` to day `b`. */
function units(a: number, b: number, unit: Unit): number {
  if (unit === "day") return b - a;
  const x = new Date(a * DAY);
  const y = new Date(b * DAY);
  const months = (y.getUTCFullYear() - x.getUTCFullYear()) * 12 + y.getUTCMonth() - x.getUTCMonth();
  return unit === "month" ? months : months / 12;
}

// ── Events ────────────────────────────────────────────────────────────────────

function renderEvents(tl: Timeline, ctx: RichContext, key: string): HTMLElement {
  const items = tl.items;
  const last = items.length - 1;
  const place = remember<Place>(key, () => ({ at: -1 }));
  if (place.at > last) place.at = -1;

  // From the first date's start to the last one's end, a twentieth more on
  // each side in whole units: 1947 to 1985 is drawn from 1945 to 1988.
  const unit = finest(items);
  const first = items[0].from.start;
  const end = Math.max(...items.map((i) => i.from.end));
  const pad = Math.round(units(first, end, unit) * 0.05);
  const lo = shift(first, unit, -pad);
  const hi = shift(end, unit, pad);
  const span = Math.max(hi - lo, 1);
  const sameYear = items.every((i) => i.from.year === items[0].from.year);
  const dates = items.map((i) => dateText(i.from, !sameYear));
  const range =
    unit === "year"
      ? `${yearText(new Date(lo * DAY).getUTCFullYear())} – ${yearText(new Date(hi * DAY).getUTCFullYear())}`
      : `${dates[0]} – ${dates[last]}`;

  const line = h("div", { class: "rc-tl-line" });
  const points = items.map((it, i) => {
    const point = h(
      "button",
      {
        class: `rc-tl-ev ${i % 2 === 0 ? "up" : "down"}`,
        style: `left:${at((it.from.start - lo) / span, EVENTS_LEFT, EVENTS_RIGHT)}`,
        "aria-label": it.label ? `${dates[i]} ${it.label}` : dates[i],
        onclick: () => open(place.at === i ? -1 : i),
      },
      h("span", { class: "rc-tl-dot" }),
      h("span", { class: "rc-tl-lab" }, h("b", { text: dates[i] }), h("span", { text: it.label })),
    );
    return point;
  });
  const track = h("div", { class: "rc-tl-track", dir: "ltr" }, line, ...points);
  const prev = navButton(ICONS.chevronLeft, t(TIMELINE_STRINGS.previous), () => open(place.at <= 0 ? 0 : place.at - 1));
  const next = navButton(ICONS.chevronRight, t(TIMELINE_STRINGS.next), () => open(place.at < 0 ? 0 : Math.min(place.at + 1, last)));
  // The line under the track keeps its nodes, so a button keeps the focus as it steps.
  const hint = h("span", { text: t(TIMELINE_STRINGS.hint) });
  const stamp = h("span", { class: "rc-tl-year" });
  const text = h("div", { class: "rc-tl-text" });
  const detail = h("div", { class: "rc-tl-detail", "aria-live": "polite" }, hint, stamp, text, prev, next);
  const card = h(
    "div",
    { class: "rc-card rc-tl", tabindex: 0, role: "group", "aria-label": tl.title || t(RICH_STRINGS.timeline) },
    head("timeline", tl.title, ctx, h("span", { class: "rc-count", text: range })),
    track,
    detail,
  );

  card.addEventListener("keydown", (e) => {
    const k = e as KeyboardEvent;
    if (k.ctrlKey || k.altKey || k.metaKey || k.shiftKey) return;
    const cur = place.at;
    const to =
      k.key === "ArrowLeft" ? (cur < 0 ? last : Math.max(cur - 1, 0))
      : k.key === "ArrowRight" ? (cur < 0 ? 0 : Math.min(cur + 1, last))
      : k.key === "Home" ? 0
      : k.key === "End" ? last
      : k.key === "Escape" && cur >= 0 ? -1
      : null;
    if (to == null) return;
    k.preventDefault();
    k.stopPropagation();
    open(to);
  });

  function open(i: number) {
    // A point that has the focus hands it to the one opened, the only one left in the tab order.
    const focused = typeof document !== "undefined" ? document.activeElement : null;
    place.at = i;
    show();
    if (i >= 0 && focused && focused !== points[i] && points.includes(focused as HTMLButtonElement)) points[i].focus();
  }

  /** Marks the open event and fills the line under the track; the points stay, so the focus does. */
  function show() {
    const sel = place.at;
    points.forEach((p, i) => {
      p.classList.toggle("sel", i === sel);
      p.classList.toggle("dim", sel >= 0 && i !== sel);
      p.setAttribute("aria-pressed", String(i === sel));
      // One stop for the points in the tab order, the open one (or the first): the arrows move between them.
      p.tabIndex = i === Math.max(sel, 0) ? 0 : -1;
    });
    const it = items[sel];
    detail.classList.toggle("hint", !it);
    hint.hidden = !!it;
    for (const el of [stamp, text, prev, next]) el.hidden = !it;
    if (it) {
      stamp.textContent = dates[sel];
      text.replaceChildren();
      if (it.label) text.append(h("b", { text: it.label }), " ");
      if (it.detail) ctx.inline(text, it.detail);
    }
    prev.disabled = !it || sel === 0;
    next.disabled = !it || sel === last;
    // A button that just turned off or went away would drop the focus to the page: the card keeps it.
    const focused = typeof document !== "undefined" ? document.activeElement : null;
    if (focused && (focused === prev || focused === next) && (focused as HTMLButtonElement).disabled) card.focus();
    fit();
  }

  /**
   * Keeps the points and names from running into each other. Dates closer
   * than a dot and a little are pushed apart, so each dot can still be told
   * from the next and clicked. Then, on each side of the line, from the open
   * event then left to right, a label that would touch the one before shows
   * only its date, or nothing; one near the card's edge is moved in. Measured
   * when the card is laid out and when its width changes.
   */
  function fit() {
    const width = track.clientWidth;
    if (!width) return;
    // A point's box is its dot, centred on the date.
    const xs = points.map((p) => p.offsetLeft + DOT / 2);
    const nx = [...xs];
    for (let i = 1; i < nx.length; i++) nx[i] = Math.max(nx[i], nx[i - 1] + DOT_GAP);
    nx[last] = Math.min(nx[last], Math.max(xs[last], width - DOT));
    for (let i = last - 1; i >= 0; i--) nx[i] = Math.min(nx[i], nx[i + 1] - DOT_GAP);
    points.forEach((p, i) => {
      const moved = nx[i] - xs[i];
      if (Math.abs(moved) > 0.25) p.style.setProperty("transform", `translateX(${moved.toFixed(2)}px)`);
      else p.style.removeProperty("transform");
    });
    const placed: Record<"up" | "down", [number, number][]> = { up: [], down: [] };
    const order = [...points.keys()].sort((a, b) => (a === place.at ? -1 : b === place.at ? 1 : a - b));
    for (const i of order) {
      const p = points[i];
      const lab = p.lastElementChild as HTMLElement;
      p.classList.remove("short", "bare");
      lab.style.removeProperty("--dx");
      const side = i % 2 === 0 ? "up" : "down";
      const x = nx[i];
      const year = (lab.firstElementChild as HTMLElement).offsetWidth;
      const full = lab.offsetWidth;
      const free = (w: number): number | null => {
        let a = x - w / 2;
        a = Math.max(Math.min(a, width - w - EDGE), EDGE);
        const dx = a - (x - w / 2);
        return placed[side].every(([l, r]) => a + w + 6 <= l || a >= r + 6) ? dx : null;
      };
      let dx = free(full);
      let w = full;
      if (dx == null && i !== place.at) {
        w = year;
        dx = free(year);
        p.classList.add(dx == null ? "bare" : "short");
      }
      if (dx == null) continue;
      if (Math.abs(dx) > 0.5) lab.style.setProperty("--dx", `${Math.round(dx)}px`);
      const a = x - w / 2 + dx;
      placed[side].push([a, a + w]);
    }
  }

  let width = 0;
  onResize(track, () => {
    if (track.clientWidth === width) return;
    width = track.clientWidth;
    fit();
  });

  show();
  return card;
}

/** A small square button of the detail line. */
function navButton(path: string, label: string, onClick: () => void): HTMLButtonElement {
  return h("button", { class: "rc-nav", title: label, "aria-label": label, onclick: onClick }, svg(path, 12, { stroke: 2 }));
}

// ── Plan ──────────────────────────────────────────────────────────────────────

/** Row height and the space above the first row, for the ticks' dates. */
const ROW = 22;
const TOP = 22;

function renderPlan(tl: Timeline, now: Date, ctx: RichContext): HTMLElement {
  const items = tl.items;
  const unit = finest(items);
  const phases = items.filter((i) => i.to);
  const deadlines = items.filter((i) => !i.to);
  const first = Math.min(...items.map((i) => i.from.start));
  const lastEnd = Math.max(...items.map((i) => (i.to ?? i.from).end));
  // A deadline at the very end gets a day more, for its diamond.
  const endsOnDeadline = deadlines.some((d) => d.from.end === lastEnd) && !phases.some((p) => p.to!.end === lastEnd);
  const lo = first;
  const hi = lastEnd + (endsOnDeadline ? Math.max(1, Math.round((lastEnd - first) / 40)) : 0);
  const span = Math.max(hi - lo, 1);
  const X = (day: number) => (day - lo) / span;
  // A plan that ends on a deadline runs to the card's edge, the day kept for its diamond being room enough.
  const right = endsOnDeadline ? 0 : PLAN_LEFT;
  const pos = (f: number) => at(f, PLAN_LEFT, right);
  const scale = `(100% - ${PLAN_LEFT + right}px)`;
  const today = localDay(now);
  // Done, current and to do, and today's line, only for a plan in days that today falls in.
  const live = unit === "day" && today >= lo && today < hi;

  // A row per phase, as a staircase; past six, a phase goes up to the first row it fits in.
  const rows: number[] = [];
  const rowEnds: number[] = [];
  for (const p of phases) {
    let r = phases.length > 6 ? rowEnds.findIndex((e) => e <= p.from.start) : -1;
    if (r < 0) r = rowEnds.push(0) - 1;
    rowEnds[r] = p.to!.end;
    rows.push(r);
  }
  // A deadline's name goes to its left, unless the card's left edge is too
  // close for it even on a narrow card; then to its right, where there's more
  // room. It goes in the first row with room for the diamond and its name.
  const need = deadlines.map((d) => d.label.length * 6.5 + 26);
  const leftwards = deadlines.map((d, i) => {
    const f = X(d.from.start);
    return f * NARROW >= need[i] || (f > 0.5 && (1 - f) * NARROW < need[i]);
  });
  // What the deadlines already placed take, by row: a second one close by
  // goes to another row rather than over the first one's name.
  const marks: { r: number; a: number; b: number }[] = [];
  const deadlineRows = deadlines.map((d, i) => {
    const room = (need[i] / NARROW) * span;
    const leftward = leftwards[i];
    const a = leftward ? d.from.start - room : d.from.start;
    const b = leftward ? d.from.end : d.from.start + room;
    let r = 0;
    for (; r < rowEnds.length; r++) {
      if (phases.every((p, i) => rows[i] !== r || p.to!.end <= a || p.from.start >= b)
        && marks.every((m) => m.r !== r || m.b <= a || m.a >= b)) break;
    }
    if (r === rowEnds.length) rowEnds.push(0);
    marks.push({ r, a, b });
    return r;
  });

  const height = TOP + rowEnds.length * ROW + 8;
  const area = h("div", { class: "rc-tl-plan", dir: "ltr", style: `height:${height}px` });
  for (const [day, label] of ticks(lo, hi, unit)) {
    area.append(h("span", { class: "rc-tl-tick", style: `left:${pos(X(day))}`, text: label }));
  }
  let current = -1;
  phases.forEach((p, i) => {
    const from = p.from.start;
    const end = p.to!.end;
    const state = !live ? "todo" : end <= today ? "done" : from <= today ? "cur" : "todo";
    if (state === "cur" && current < 0) current = i;
    const bar = h(
      "div",
      {
        class: `rc-tl-bar ${state}`,
        style: `left:${pos(X(from))};width:calc(${round(X(end) - X(from))} * ${scale} - 3px);top:${TOP + rows[i] * ROW}px`,
        title: [p.label, `${dateText(p.from)} – ${dateText(p.to!)}`, p.detail].filter(Boolean).join("\n"),
      },
      state === "done" ? svg(ICONS.check, 10, { stroke: 2.6 }) : null,
      h("span", { text: p.label }),
    );
    area.append(bar);
  });
  deadlines.forEach((d, i) => {
    const f = X(d.from.start);
    const leftward = leftwards[i];
    // The diamond ends 6px before its day begins, due by then; where its name
    // goes to its right, it starts 6px before. A name longer than the room
    // left to the card's edge ends in an ellipsis.
    const edge = leftward ? `${round(1 - f)} * ${scale} + ${right + 6}px` : `${pos(f)} - 6px`;
    const side = `${leftward ? "right" : "left"}:calc(${edge});max-width:calc(100% - (${edge}) - 4px)`;
    area.append(
      h(
        "div",
        {
          class: leftward ? "rc-tl-mile" : "rc-tl-mile right",
          style: `${side};top:${TOP + deadlineRows[i] * ROW}px`,
          title: [d.label, dateText(d.from), d.detail].filter(Boolean).join("\n"),
        },
        h("i"),
        h("span", { text: d.label }),
      ),
    );
  });
  if (live) {
    area.append(h("div", { class: "rc-tl-today", style: `left:${pos(X(today + 0.5))}` }, h("span", { text: t(TIMELINE_STRINGS.today) })));
  }

  // The top line: the phase today is in, and the days left to the last deadline (or the plan's end).
  const parts: string[] = [];
  if (live && current >= 0) parts.push(t(TIMELINE_STRINGS.phase, { n: current + 1, total: phases.length }));
  const due = deadlines.length ? deadlines[deadlines.length - 1].from.start : lastEnd - 1;
  if (live && due > today) parts.push(tn("{count} day left", "{count} days left", due - today));
  if (!parts.length) {
    const sameYear = items.every((i) => i.from.year === items[0].from.year && (i.to?.year ?? i.from.year) === items[0].from.year);
    const lastItem = items.reduce((a, b) => ((b.to ?? b.from).end > (a.to ?? a.from).end ? b : a));
    parts.push(`${dateText(items[0].from, !sameYear)} – ${dateText(lastItem.to ?? lastItem.from, !sameYear)}`);
  }

  return h(
    "div",
    { class: "rc-card rc-tl", role: "group", "aria-label": tl.title || t(RICH_STRINGS.timeline) },
    head("timeline", tl.title, ctx, h("span", { class: "rc-count", text: parts.join(" · ") })),
    area,
  );
}

/** The dates along the top of a plan: about six of them, a week apart for a month or so. */
function ticks(lo: number, hi: number, unit: Unit): [number, string][] {
  const span = hi - lo;
  const out: [number, string][] = [];
  const keep = (day: number) => (day - lo) / span <= 0.93;
  if (unit === "day" && span <= 7 * 7 * 2) {
    const step = [1, 2, 7, 14].find((s) => span / s <= 7) ?? 14;
    for (let d = lo; d < hi && keep(d); d += step) {
      const date = new Date(d * DAY);
      out.push([d, dayMonth(date.getUTCMonth(), date.getUTCDate())]);
    }
    return out;
  }
  const months = span / 30.44;
  if (months <= 6 * 12) {
    const step = [1, 2, 3, 6, 12].find((s) => months / s <= 7) ?? 12;
    const start = new Date(lo * DAY);
    let y = start.getUTCFullYear();
    let m = start.getUTCMonth() + (start.getUTCDate() > 1 ? 1 : 0);
    for (let i = 0; i < 40; i++, m += step) {
      const d = dayNumber(y, m, 1);
      if (d >= hi || !keep(d)) break;
      const date = new Date(d * DAY);
      const label = intl({ month: "short", ...(date.getUTCMonth() === 0 || i === 0 ? { year: "numeric" } : {}) }, when("month", date.getUTCFullYear(), date.getUTCMonth(), 1));
      out.push([d, label ?? String(date.getUTCFullYear())]);
    }
    return out;
  }
  const a = new Date(lo * DAY).getUTCFullYear();
  const b = new Date(hi * DAY).getUTCFullYear();
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000].find((s) => (b - a) / s <= 6) ?? 10000;
  for (let y = Math.ceil(a / step) * step; y < b; y += step) {
    const d = dayNumber(y, 0, 1);
    if (d < lo || !keep(d)) continue;
    out.push([d, yearText(y)]);
  }
  return out;
}
