// Google Calendar read with the user's account (src/core/google-calendar.ts),
// against a fake Calendar API: which calendars, what changed, the next days.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GoogleSync, googleEvent, isShown, mergeEvents, readCalendarList } from "../src/core/google-calendar.ts";

const NOW = new Date(2026, 10, 12, 10, 51).getTime();
const at = (h, m = 0, day = 12) => new Date(2026, 10, day, h, m).getTime();
const iso = (t) => new Date(t).toISOString();

/** A Calendar API with two calendars; `asked` logs each request as "path ?keys". */
function fakeGoogle() {
  const g = {
    asked: [],
    signedIn: true,
    calendars: [
      { id: "me@gmail.com", summary: "me@gmail.com", backgroundColor: "#7986cb", primary: true, selected: true, accessRole: "owner" },
      { id: "uni@group.calendar.google.com", summary: "Università", backgroundColor: "#33b679", selected: true, accessRole: "reader" },
      { id: "it.italian#holiday@group.v.calendar.google.com", summary: "Festività in Italia", backgroundColor: "#0b8043", selected: false, accessRole: "reader" },
    ],
    events: {
      "me@gmail.com": [{ status: "confirmed", summary: "Lezione Sistemi Operativi", start: { dateTime: iso(at(14)) }, end: { dateTime: iso(at(16)) } }],
      "uni@group.calendar.google.com": [{ status: "confirmed", summary: "Esame", start: { date: "2026-11-13" }, end: { date: "2026-11-14" } }],
    },
    /** Each calendar's changes, with Google's time of each (deleted events too). */
    changed: {},
    /** Calendars that answer "what changed?" with 410 (updatedMin too long ago). */
    gone: new Set(),
  };
  g.get = async (path, query) => {
    if (!g.signedIn) return null;
    const q = Object.fromEntries(query);
    g.asked.push(`${path} ?${Object.keys(q).filter((k) => k !== "fields").sort().join(",")}`);
    if (path === "/users/me/calendarList") return { status: 200, body: { items: g.calendars } };
    const id = decodeURIComponent(path.slice("/calendars/".length, -"/events".length));
    if (q.updatedMin) {
      assert.equal(q.showDeleted, "true");
      if (g.gone.has(id)) {
        g.gone.delete(id);
        return { status: 410, body: {} };
      }
      return { status: 200, body: { items: (g.changed[id] ?? []).filter((c) => c.updated >= q.updatedMin) } };
    }
    if (q.singleEvents) return { status: 200, body: { items: g.events[id] ?? [] } };
    throw new Error(`unexpected request ${path}`);
  };
  return g;
}

test("the calendar list: primary first, the user's name for each, Google's own choice kept", () => {
  const list = readCalendarList([
    { id: "b", summary: "B", summaryOverride: "Mine", selected: true, backgroundColor: "#123456" },
    { id: "a", summary: "A", primary: true, selected: true, backgroundColor: "nope" },
    { id: "gone", deleted: true },
    { id: "hid", summary: "Hidden", selected: true, hidden: true },
  ]);
  assert.deepEqual(list.map((c) => [c.id, c.name, c.shownInGoogle]), [["a", "A", true], ["hid", "Hidden", false], ["b", "Mine", true]]);
  assert.equal(list[0].color, "#7986cb");
  assert.equal(list[2].color, "#123456");
  assert.equal(isShown(list[2], {}), true);
  assert.equal(isShown(list[2], { b: false }), false);
  assert.equal(isShown(list[1], { hid: true }), true);
});

test("an event: times with their offset, whole days at local midnight, cancelled ones left out", () => {
  assert.deepEqual(googleEvent({ summary: " Call ", start: { dateTime: "2026-11-12T11:15:00+01:00" }, end: { dateTime: "2026-11-12T11:45:00+01:00" }, location: "Meet" }),
    { title: "Call", start: Date.parse("2026-11-12T10:15:00Z"), end: Date.parse("2026-11-12T10:45:00Z"), allDay: false, location: "Meet" });
  const day = googleEvent({ start: { date: "2026-11-13" }, end: { date: "2026-11-14" } });
  assert.equal(day.allDay, true);
  assert.equal(day.start, new Date(2026, 10, 13).getTime());
  assert.equal(day.end, new Date(2026, 10, 14).getTime());
  assert.equal(day.title, "—");
  assert.equal(googleEvent({ status: "cancelled", start: { date: "2026-11-13" } }), null);
  assert.equal(googleEvent({ start: {} }), null);
});

test("the same event from Google and from the iCal address shows once", () => {
  const e = { title: "Call", start: 1, end: 2, allDay: false, location: "" };
  const other = { title: "Lunch", start: 0, end: 1, allDay: false, location: "" };
  assert.deepEqual(mergeEvents([e], [{ ...e, location: "x" }, other]), [other, e]);
});

test("the first read lists the calendars and reads the next days of each shown one, never a calendar whole", async () => {
  const g = fakeGoogle();
  const sync = new GoogleSync(g.get);
  const events = await sync.refresh({}, NOW);
  assert.deepEqual(events.map((e) => e.title), ["Lezione Sistemi Operativi", "Esame"]);
  // The holidays are off in Google Calendar, so off on the island too.
  assert.ok(!g.asked.some((a) => a.includes("holiday")));
  assert.deepEqual(g.asked, [
    "/users/me/calendarList ?maxResults",
    "/calendars/me%40gmail.com/events ?maxResults,showDeleted,updatedMin",
    "/calendars/me%40gmail.com/events ?maxResults,orderBy,singleEvents,timeMax,timeMin",
    "/calendars/uni%40group.calendar.google.com/events ?maxResults,showDeleted,updatedMin",
    "/calendars/uni%40group.calendar.google.com/events ?maxResults,orderBy,singleEvents,timeMax,timeMin",
  ]);
});

test("then each minute asks only what changed, and reads the next days again only when something did", async () => {
  const g = fakeGoogle();
  const sync = new GoogleSync(g.get);
  await sync.refresh({}, NOW);
  g.asked = [];
  let events = await sync.refresh({}, NOW + 60_000);
  assert.deepEqual(g.asked, [
    "/calendars/me%40gmail.com/events ?maxResults,showDeleted,updatedMin",
    "/calendars/uni%40group.calendar.google.com/events ?maxResults,showDeleted,updatedMin",
  ]);
  assert.equal(events.length, 2);

  // "Call con Marco" added on the phone.
  g.events["me@gmail.com"].unshift({ status: "confirmed", summary: "Call con Marco", start: { dateTime: iso(at(11, 15)) }, end: { dateTime: iso(at(11, 45)) } });
  g.changed["me@gmail.com"] = [{ updated: iso(NOW + 100_000) }];
  g.asked = [];
  events = await sync.refresh({}, NOW + 120_000);
  assert.deepEqual(events.map((e) => e.title), ["Call con Marco", "Lezione Sistemi Operativi", "Esame"]);
  assert.deepEqual(g.asked, [
    "/calendars/me%40gmail.com/events ?maxResults,showDeleted,updatedMin",
    "/calendars/me%40gmail.com/events ?maxResults,orderBy,singleEvents,timeMax,timeMin",
    "/calendars/uni%40group.calendar.google.com/events ?maxResults,showDeleted,updatedMin",
  ]);

  // The same change, told again in the next minutes (the margin for the clock), is not read twice.
  g.asked = [];
  await sync.refresh({}, NOW + 180_000);
  assert.equal(g.asked.filter((a) => a.includes("singleEvents")).length, 0);

  // A deleted event counts too (Google tells of it with showDeleted).
  g.changed["uni@group.calendar.google.com"] = [{ status: "cancelled", updated: iso(NOW + 200_000) }];
  g.events["uni@group.calendar.google.com"] = [];
  g.asked = [];
  events = await sync.refresh({}, NOW + 240_000);
  assert.deepEqual(events.map((e) => e.title), ["Call con Marco", "Lezione Sistemi Operativi"]);
});

test("each minute looks back from the last look, with a margin for the computer's clock", async () => {
  const g = fakeGoogle();
  const seen = [];
  const get = g.get;
  g.get = async (path, query) => {
    const q = Object.fromEntries(query);
    if (q.updatedMin) seen.push(q.updatedMin);
    return get(path, query);
  };
  const sync = new GoogleSync(g.get);
  await sync.refresh({}, NOW);
  await sync.refresh({}, NOW + 60_000);
  await sync.refresh({}, NOW + 120_000);
  // Two calendars: each look twice, from the look before less five minutes.
  assert.deepEqual(seen, [NOW, NOW, NOW, NOW, NOW + 60_000, NOW + 60_000].map((t) => iso(t - 300_000)));
});

test("a last look too long ago for Google (410) reads that calendar's next days again", async () => {
  const g = fakeGoogle();
  const sync = new GoogleSync(g.get);
  await sync.refresh({}, NOW);
  g.gone.add("uni@group.calendar.google.com");
  g.asked = [];
  await sync.refresh({}, NOW + 60_000);
  assert.deepEqual(g.asked.slice(1), [
    "/calendars/uni%40group.calendar.google.com/events ?maxResults,showDeleted,updatedMin",
    "/calendars/uni%40group.calendar.google.com/events ?maxResults,orderBy,singleEvents,timeMax,timeMin",
  ]);
  // And then looks from now on.
  g.asked = [];
  await sync.refresh({}, NOW + 120_000);
  assert.equal(g.asked.filter((a) => a.includes("singleEvents")).length, 0);
});

test("the next days are read again after half an hour, or on a new day, even with nothing changed", async () => {
  const g = fakeGoogle();
  const sync = new GoogleSync(g.get);
  await sync.refresh({}, NOW);
  g.asked = [];
  await sync.refresh({}, NOW + 31 * 60_000);
  assert.equal(g.asked.filter((a) => a.includes("singleEvents")).length, 2);
  // The list too, every half hour.
  assert.ok(g.asked.includes("/users/me/calendarList ?maxResults"));
});

test("the user's picks win over Google Calendar's; a calendar turned off is no longer asked", async () => {
  const g = fakeGoogle();
  const sync = new GoogleSync(g.get);
  const picks = { "uni@group.calendar.google.com": false, "it.italian#holiday@group.v.calendar.google.com": true };
  const events = await sync.refresh(picks, NOW);
  assert.deepEqual(events.map((e) => e.title), ["Lezione Sistemi Operativi"]);
  assert.ok(g.asked.some((a) => a.startsWith("/calendars/it.italian%23holiday%40group.v.calendar.google.com/events")));
  assert.ok(!g.asked.some((a) => a.includes("uni%40")));
});

test("signed out: null, and everything is read again after the next sign-in", async () => {
  const g = fakeGoogle();
  const sync = new GoogleSync(g.get);
  await sync.refresh({}, NOW);
  g.signedIn = false;
  assert.equal(await sync.refresh({}, NOW + 60_000), null);
  g.signedIn = true;
  g.asked = [];
  await sync.refresh({}, NOW + 120_000);
  assert.equal(g.asked[0], "/users/me/calendarList ?maxResults");
});

test("a failure is thrown, and the list is read again next time (a calendar may be gone)", async () => {
  const g = fakeGoogle();
  const sync = new GoogleSync(g.get);
  await sync.refresh({}, NOW);
  const get = g.get;
  g.get = async () => { throw "Google Calendar answered 404."; };
  sync["get"] = g.get;
  await assert.rejects(sync.refresh({}, NOW + 60_000), /404/);
  sync["get"] = get;
  g.asked = [];
  await sync.refresh({}, NOW + 120_000);
  assert.equal(g.asked[0], "/users/me/calendarList ?maxResults");
});

test("on the island: Google's events join the iCal address's, and its tile stays while Google fails", async () => {
  const { internals } = await import("./tauri.mjs");
  const { Calendar, GoogleFeed } = await import("../src/island/activities.ts");
  const g = fakeGoogle();
  // The island reads around the real now.
  const hour = 3_600_000;
  const start = Math.floor(Date.now() / hour) * hour + 3 * hour;
  g.events["me@gmail.com"][0].start = { dateTime: iso(start) };
  g.events["me@gmail.com"][0].end = { dateTime: iso(start + 2 * hour) };
  g.events["uni@group.calendar.google.com"][0] = { summary: "Esame", start: { dateTime: iso(start + 24 * hour) }, end: { dateTime: iso(start + 26 * hour) } };
  const ics = (t) => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const before = internals.invoke;
  let google = (path, query) => g.get(path, query);
  internals.invoke = async (cmd, args) => {
    if (cmd === "calendar_fetch") return "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nSUMMARY:Lezione Sistemi Operativi\n"
      + `DTSTART:${ics(start)}\nDTEND:${ics(start + 2 * hour)}\nEND:VEVENT\nEND:VCALENDAR\n`;
    if (cmd === "google_calendar_status") return { client: true, signedIn: true, needsSignIn: false, signingIn: false };
    if (cmd === "google_calendar_get") return google(args.path, args.query);
    return before(cmd, args);
  };
  try {
    GoogleFeed.sync.reset();
    await Calendar.refresh();
    await GoogleFeed.refresh();
    // The lesson is in both: once.
    assert.equal(Calendar.events.filter((e) => e.title === "Lezione Sistemi Operativi").length, 1);
    assert.ok(Calendar.events.some((e) => e.title === "Esame"));
    assert.equal(Calendar.configured, true);
    // The iCal file names no app: the tile opens Google Calendar.
    assert.equal(Calendar.link, "https://calendar.google.com/calendar/r");

    // Google fails from the start: the tile stays, and says why once nothing else is read.
    google = async () => { throw "Google closed Lumo's access: sign in again in Settings → Island."; };
    GoogleFeed.sync.reset();
    GoogleFeed.hasRead = false;
    GoogleFeed.events = [];
    internals.invoke = async (cmd, args) => {
      if (cmd === "google_calendar_status") return { client: true, signedIn: true, needsSignIn: true, signingIn: false };
      if (cmd === "google_calendar_get") return google(args.path, args.query);
      return before(cmd, args); // no iCal address
    };
    await Calendar.refresh();
    await GoogleFeed.refresh();
    assert.equal(Calendar.configured, true);
    assert.deepEqual(Calendar.events, []);
    assert.match(Calendar.error ?? "", /sign in again/);

    // Signed out: no tile.
    internals.invoke = async (cmd, args) => (cmd === "google_calendar_status"
      ? { client: false, signedIn: false, needsSignIn: false, signingIn: false } : before(cmd, args));
    await GoogleFeed.refresh();
    assert.equal(Calendar.configured, false);
    assert.equal(Calendar.error, null);
  } finally {
    internals.invoke = before;
    for (const x of [Calendar, GoogleFeed]) if (x.timer != null) clearTimeout(x.timer);
    GoogleFeed.failures = 0;
  }
});
