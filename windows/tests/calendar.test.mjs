// The live activities' calendar (src/core/calendar.ts): an iCal file read
// into the coming events, repeating ones expanded.

import { test } from "node:test";
import assert from "node:assert/strict";
import { calendarWebLink, eventSoon, parseIcs, parseIcsDate } from "../src/core/calendar.ts";

const local = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();
const ics = (...events) => ["BEGIN:VCALENDAR", ...events.flatMap((e) => ["BEGIN:VEVENT", ...e, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");

test("dates: UTC, local and whole days", () => {
  assert.deepEqual(parseIcsDate("20261009T140000Z"), { time: Date.UTC(2026, 9, 9, 14), allDay: false });
  // A zone of its own: that zone's 14:00, whatever this computer's zone is.
  assert.deepEqual(parseIcsDate("20261009T140000", { TZID: "Europe/Rome" }), { time: Date.UTC(2026, 9, 9, 12), allDay: false });
  assert.deepEqual(parseIcsDate("20260115T090000", { TZID: "America/New_York" }), { time: Date.UTC(2026, 0, 15, 14), allDay: false });
  // As Outlook writes it, Windows's name.
  assert.deepEqual(parseIcsDate("20260115T090000", { TZID: "W. Europe Standard Time" }), { time: Date.UTC(2026, 0, 15, 8), allDay: false });
  // A zone nobody knows: local time.
  assert.deepEqual(parseIcsDate("20261009T140000", { TZID: "Mars/Olympus" }), { time: local(2026, 10, 9, 14), allDay: false });
  // Around a change of time: 2026-03-29 in Rome, 01:30 before it, 03:30 after.
  assert.equal(parseIcsDate("20260329T013000", { TZID: "Europe/Rome" }).time, Date.UTC(2026, 2, 29, 0, 30));
  assert.equal(parseIcsDate("20260329T033000", { TZID: "Europe/Rome" }).time, Date.UTC(2026, 2, 29, 1, 30));
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
    ["UID:i", "DTSTART:20261001T070000", "RRULE:FREQ=DAILY;INTERVAL=2;UNTIL=20261011T000000", "SUMMARY:Run"],
  );
  const events = parseIcs(text, local(2026, 10, 9), local(2026, 10, 16));
  const by = (t) => events.filter((e) => e.title === t).map((e) => new Date(e.start).getDate());
  assert.deepEqual(by("Pills"), [9, 10]);
  // The second Thursday of October 2026 is the 8th: before the window.
  assert.deepEqual(by("Board"), []);
  assert.deepEqual(parseIcs(text, local(2026, 11, 1), local(2026, 11, 30)).filter((e) => e.title === "Board").map((e) => new Date(e.start).getDate()), [12]);
  assert.deepEqual(by("Birthday"), [12]);
  assert.deepEqual(by("Run"), [9]);
  // Into the next year: the second Thursday of January 2027 is the 14th.
  assert.deepEqual(parseIcs(text, local(2027, 1, 1), local(2027, 1, 31)).filter((e) => e.title === "Board").map((e) => new Date(e.start).getDate()), [14]);
});

test("the rules Google and Outlook write: a month's nth weekday each year, the last weekday, weekdays only", () => {
  const text = ics(
    // The second Sunday of March (as a calendar writes daylight saving or a holiday).
    ["UID:a", "DTSTART;VALUE=DATE:20260308", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "SUMMARY:Second Sunday"],
    // Outlook's "the last weekday of the month".
    ["UID:b", "DTSTART:20260130T090000", "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "SUMMARY:Report"],
    // "Every weekday".
    ["UID:c", "DTSTART:20260105T080000", "RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR", "SUMMARY:Commute"],
    // The 15th and the last day of each month.
    ["UID:d", "DTSTART:20260115T090000", "RRULE:FREQ=MONTHLY;BYMONTHDAY=15,-1", "SUMMARY:Pay"],
    // A part not read here: its first time only, never wrong days.
    ["UID:e", "DTSTART:20260105T090000", "RRULE:FREQ=YEARLY;BYWEEKNO=20", "SUMMARY:Odd"],
  );
  const days = (from, to, title) => parseIcs(text, from, to).filter((e) => e.title === title).map((e) => new Date(e.start).getDate());
  assert.deepEqual(days(local(2027, 3, 1), local(2027, 3, 31), "Second Sunday"), [14]);
  assert.deepEqual(days(local(2027, 1, 1), local(2027, 12, 31), "Second Sunday"), [14]);
  // October 2026 ends on a Saturday: its last weekday is Friday the 30th; November's is Monday the 30th.
  assert.deepEqual(days(local(2026, 10, 1), local(2026, 11, 30, 23), "Report"), [30, 30]);
  // 9–15 October 2026: Friday the 9th to Thursday the 15th, no weekend.
  assert.deepEqual(days(local(2026, 10, 9), local(2026, 10, 16), "Commute"), [9, 12, 13, 14, 15]);
  assert.deepEqual(days(local(2027, 2, 1), local(2027, 2, 28, 23), "Pay"), [15, 28]);
  assert.deepEqual(days(local(2026, 1, 1), local(2027, 12, 31), "Odd"), [5]);
});

test("a repeating event set up years ago still shows", () => {
  const text = ics(
    ["UID:d", "DTSTART:20150105T080000", "RRULE:FREQ=DAILY", "SUMMARY:Standup"],
    ["UID:w", "DTSTART:19900102T090000", "RRULE:FREQ=WEEKLY;BYDAY=MO,FR", "SUMMARY:Gym"],
    ["UID:m", "DTSTART:19800115T090000", "RRULE:FREQ=MONTHLY", "SUMMARY:Rent"],
  );
  const events = parseIcs(text, local(2026, 10, 9), local(2026, 10, 16));
  const by = (t) => events.filter((e) => e.title === t).map((e) => new Date(e.start).getDate());
  assert.deepEqual(by("Standup"), [9, 10, 11, 12, 13, 14, 15]);
  assert.deepEqual(by("Gym"), [9, 12]);
  assert.equal(new Date(events.find((e) => e.title === "Standup").start).getHours(), 8);
  assert.deepEqual(parseIcs(text, local(2026, 11, 1), local(2026, 11, 30)).filter((e) => e.title === "Rent").map((e) => new Date(e.start).getDate()), [15]);
});

test("monthly on a weekday with no number is every one of them", () => {
  const text = ics(["UID:w", "DTSTART:20261005T090000", "RRULE:FREQ=MONTHLY;BYDAY=MO", "SUMMARY:Standup"]);
  assert.deepEqual(parseIcs(text, local(2026, 10, 1), local(2026, 10, 31)).map((e) => new Date(e.start).getDate()), [5, 12, 19, 26]);
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

test("the calendar's web page, from the app that wrote the file", () => {
  const head = (prodid) => ["BEGIN:VCALENDAR", `PRODID:${prodid}`, "VERSION:2.0", "END:VCALENDAR"].join("\r\n");
  assert.equal(calendarWebLink(head("-//Google Inc//Google Calendar 70.9054//EN")), "https://calendar.google.com/calendar/r");
  assert.equal(calendarWebLink(head("-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN")), "https://outlook.live.com/calendar/0/view/day");
  assert.equal(calendarWebLink(head("-//Apple Inc.//iCloud//EN")), "https://www.icloud.com/calendar/");
  assert.equal(calendarWebLink(head("-//Someone//Their Calendar//EN")), null);
  assert.equal(calendarWebLink("BEGIN:VCALENDAR\r\nEND:VCALENDAR"), null);
});

test("a repeating event keeps its own clock's hour across a change of time, and its exceptions", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT", "UID:utc", "DTSTART:20260105T140000Z", "DTEND:20260105T150000Z", "RRULE:FREQ=WEEKLY", "SUMMARY:UTC", "END:VEVENT",
    "BEGIN:VEVENT", "UID:ny",
    "DTSTART;TZID=America/New_York:20260105T090000", "DTEND;TZID=America/New_York:20260105T100000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE;TZID=America/New_York:20260713T090000", "SUMMARY:NY", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const at = (title) => parseIcs(ics, Date.UTC(2026, 6, 1), Date.UTC(2026, 6, 21)).filter((e) => e.title === title).map((e) => new Date(e.start).toISOString());
  // 14:00 UTC stays 14:00 UTC, whatever the computer's clock did in March.
  assert.deepEqual(at("UTC"), ["2026-07-06T14:00:00.000Z", "2026-07-13T14:00:00.000Z", "2026-07-20T14:00:00.000Z"]);
  // 9:00 in New York is 13:00 UTC in summer, and the 13th is left out.
  assert.deepEqual(at("NY"), ["2026-07-06T13:00:00.000Z", "2026-07-20T13:00:00.000Z"]);
  // And 14:00 UTC in winter.
  const winter = parseIcs(ics, Date.UTC(2026, 0, 12), Date.UTC(2026, 0, 13)).filter((e) => e.title === "NY");
  assert.deepEqual(winter.map((e) => new Date(e.start).toISOString()), ["2026-01-12T14:00:00.000Z"]);
});

test("a monthly event on the last Friday and a yearly one on 29 February land on their days", () => {
  const ics = [
    "BEGIN:VEVENT", "UID:m", "DTSTART:20260130T100000Z", "RRULE:FREQ=MONTHLY;BYDAY=-1FR", "SUMMARY:M", "END:VEVENT",
    "BEGIN:VEVENT", "UID:y", "DTSTART;VALUE=DATE:20240229", "RRULE:FREQ=YEARLY", "SUMMARY:Y", "END:VEVENT",
  ].join("\n");
  const m = parseIcs(ics, Date.UTC(2026, 2, 1), Date.UTC(2026, 4, 1)).filter((e) => e.title === "M");
  assert.deepEqual(m.map((e) => new Date(e.start).toISOString()), ["2026-03-27T10:00:00.000Z", "2026-04-24T10:00:00.000Z"]);
  const y = parseIcs(ics, Date.UTC(2025, 0, 1), Date.UTC(2029, 0, 1)).filter((e) => e.title === "Y");
  assert.deepEqual(y.map((e) => new Date(e.start).getFullYear()), [2028]);
});

test("when the clocks go back, an hour that comes twice is the first one", () => {
  const ics = [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT", "UID:a", "DTSTART;TZID=Europe/Rome:20261025T023000", "DTEND;TZID=Europe/Rome:20261025T033000", "SUMMARY:Twice", "END:VEVENT",
    "BEGIN:VEVENT", "UID:b", "DTSTART;TZID=Europe/Rome:20260329T023000", "DTEND;TZID=Europe/Rome:20260329T040000", "SUMMARY:Skipped", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const [twice] = parseIcs(ics, Date.UTC(2026, 9, 24), Date.UTC(2026, 9, 26));
  // 02:30 CEST (UTC+2), not 02:30 CET an hour later.
  assert.equal(new Date(twice.start).toISOString(), "2026-10-25T00:30:00.000Z");
  assert.equal(new Date(twice.end).toISOString(), "2026-10-25T02:30:00.000Z");
  // Also in a zone more than 12 hours ahead of UTC.
  const nz = parseIcs(ics.replace("UID:a", "UID:nz").replace(/Europe\/Rome:20261025T023000/, "Pacific/Auckland:20260405T023000")
    .replace(/Europe\/Rome:20261025T033000/, "Pacific/Auckland:20260405T033000"), Date.UTC(2026, 3, 3), Date.UTC(2026, 3, 6));
  assert.equal(new Date(nz.find((e) => e.title === "Twice").start).toISOString(), "2026-04-04T13:30:00.000Z");
  // An hour the clocks skip still lands on that night.
  const [skipped] = parseIcs(ics, Date.UTC(2026, 2, 28), Date.UTC(2026, 2, 30));
  assert.ok(skipped.start >= Date.UTC(2026, 2, 29, 0) && skipped.start <= Date.UTC(2026, 2, 29, 2), new Date(skipped.start).toISOString());
});

test("a whole-day event ends at local midnight, also on the days the clocks change", () => {
  const tz = process.env.TZ;
  process.env.TZ = "Europe/Rome";
  try {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT", "UID:d", "DTSTART;VALUE=DATE:20260329", "SUMMARY:Spring", "END:VEVENT",
      "BEGIN:VEVENT", "UID:w", "DTSTART;VALUE=DATE:20261024", "DTEND;VALUE=DATE:20261026", "SUMMARY:Weekend", "END:VEVENT",
      "BEGIN:VEVENT", "UID:r", "DTSTART;VALUE=DATE:20261018", "DTEND;VALUE=DATE:20261019", "RRULE:FREQ=WEEKLY", "SUMMARY:Sundays", "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const events = parseIcs(ics, new Date(2026, 2, 1).getTime(), new Date(2026, 9, 31).getTime());
    const end = (title) => events.filter((e) => e.title === title).map((e) => e.end);
    assert.deepEqual(end("Spring"), [new Date(2026, 2, 30).getTime()]);
    assert.deepEqual(end("Weekend"), [new Date(2026, 9, 26).getTime()]);
    assert.deepEqual(end("Sundays"), [new Date(2026, 9, 19).getTime(), new Date(2026, 9, 26).getTime()]);
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});
