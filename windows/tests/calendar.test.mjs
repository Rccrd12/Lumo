// The live activities' calendar (src/core/calendar.ts): an iCal file read
// into the coming events, repeating ones expanded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { eventSoon, parseIcs, parseIcsDate } from "../src/core/calendar.ts";

const local = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const ics = (...events) => ["BEGIN:VCALENDAR", ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");

test("dates: UTC, local and whole days", () => {
  assert.deepEqual(parseIcsDate("20261009T140000Z"), { time: Date.UTC(2026, 9, 9, 14), allDay: false });
  assert.deepEqual(parseIcsDate("20261009T140000", { TZID: "Europe/Rome" }), { time: local(2026, 10, 9, 14), allDay: false });
  assert.deepEqual(parseIcsDate("20261009", { VALUE: "DATE" }), { time: local(2026, 10, 9), allDay: true });
  assert.equal(parseIcsDate("tomorrow"), null);
});

test("single events in the window, soonest first, cancelled ones left out", () => {
  const text = ics(
    ["UID:a", "DTSTART:20261010T090000", "DTEND:20261010T100000", "SUMMARY:Stand-up\\, team", "LOCATION:Room 1"],
    ["UID:b", "DTSTART;VALUE=DATE:20261009", "DTEND;VALUE=DATE:20261010", "SUMMARY:Holiday"],
    ["UID:c", "DTSTART:20261009T150000", "DURATION:PT30M", "SUMMARY:Call", "STATUS:CANCELLED"],
    ["UID:d", "DTSTART:20261020T090000", "SUMMARY:Too far"],
  );
  const from = local(2026, 10, 9, 8);
  const events = parseIcs(text, from, from + 7 * 86_400_000);
  assert.deepEqual(events.map((e) => e.title), ["Holiday", "Stand-up, team"]);
  assert.equal(events[1].location, "Room 1");
  assert.equal(events[1].end - events[1].start, 3_600_000);
  assert.equal(events[0].allDay, true);
});

test("a long line folded over two is one", () => {
  const text = "BEGIN:VEVENT\r\nDTSTART:20261010T090000\r\nSUMMARY:A very long \r\n title\r\nEND:VEVENT";
  assert.equal(parseIcs(text, local(2026, 10, 9), local(2026, 10, 12))[0].title, "A very long title");
});

test("weekly on given days, with an exception and a moved one", () => {
  const text = ics(
    ["UID:w", "DTSTART:20261005T100000", "DTEND:20261005T103000", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE", "EXDATE:20261012T100000", "SUMMARY:Gym"],
    ["UID:w", "RECURRENCE-ID:20261014T100000", "DTSTART:20261014T180000", "DTEND:20261014T183000", "SUMMARY:Gym (late)"],
  );
  const from = local(2026, 10, 9);
  const events = parseIcs(text, from, local(2026, 10, 17));
  assert.deepEqual(events.map((e) => [e.title, new Date(e.start).getDate(), new Date(e.start).getHours()]), [
    ["Gym (late)", 14, 18],
  ]);
  const later = parseIcs(text, local(2026, 10, 18), local(2026, 10, 23));
  assert.deepEqual(later.map((e) => new Date(e.start).getDate()), [19, 21]);
});

test("daily with a count, monthly on the nth weekday, yearly", () => {
  const text = ics(
    ["UID:d", "DTSTART:20261008T080000", "RRULE:FREQ=DAILY;COUNT=3", "SUMMARY:Pills"],
    ["UID:m", "DTSTART:20260908T090000", "RRULE:FREQ=MONTHLY;BYDAY=2TH", "SUMMARY:Board"],
    ["UID:y", "DTSTART;VALUE=DATE:20001012", "RRULE:FREQ=YEARLY", "SUMMARY:Birthday"],
    ["UID:i", "DTSTART:20261001T070000", "RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261011T000000Z", "SUMMARY:Run"],
  );
  const events = parseIcs(text, local(2026, 10, 9), local(2026, 10, 16));
  const by = (t) => events.filter((e) => e.title === t).map((e) => new Date(e.start).getDate());
  assert.deepEqual(by("Pills"), [9, 10]);
  // The second Thursday of October 2026 is the 8th: before the window.
  assert.deepEqual(by("Board"), []);
  assert.deepEqual(parseIcs(text, local(2026, 11, 1), local(2026, 11, 30)).filter((e) => e.title === "Board").map((e) => new Date(e.start).getDate()), [12]);
  assert.deepEqual(by("Birthday"), [12]);
  assert.deepEqual(by("Run"), [9]);
});

test("the event about to start", () => {
  const now = local(2026, 10, 9, 13, 50);
  const events = [
    { title: "All day", start: local(2026, 10, 9), end: local(2026, 10, 10), allDay: true, location: "" },
    { title: "Call", start: local(2026, 10, 9, 14), end: local(2026, 10, 9, 14, 30), allDay: false, location: "" },
  ];
  assert.equal(eventSoon(events, now)?.title, "Call");
  assert.equal(eventSoon(events, local(2026, 10, 9, 13)), null);
  assert.equal(eventSoon(events, local(2026, 10, 9, 14, 3))?.title, "Call");
  assert.equal(eventSoon(events, local(2026, 10, 9, 14, 10)), null);
});
