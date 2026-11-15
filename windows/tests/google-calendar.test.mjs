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
    /** Calendars whose next-days read fails. */
    failing: new Set(),
    pageSize: 250,
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
    if (q.singleEvents) {
      if (g.failing.has(id)) throw "Google Calendar answered 500.";
      const items = g.events[id] ?? [];
      // Pages of `g.pageSize` (Google may answer fewer than asked).
      const from = q.pageToken ? +q.pageToken : 0;
      const next = from + g.pageSize < items.length ? String(from + g.pageSize) : undefined;
      return { status: 200, body: { items: items.slice(from, from + g.pageSize), nextPageToken: next } };
    }
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

test("the same event in two sources shows once; two events that only share a title and start both show", () => {
  const e = { title: "Call", start: 1, end: 2, allDay: false, location: "" };
  const other = { title: "Lunch", start: 0, end: 1, allDay: false, location: "" };
  assert.deepEqual(mergeEvents([e], [{ ...e }, other]), [other, e]);
  const longer = { ...e, end: 3 };
  const elsewhere = { ...e, location: "Aula 29" };
  assert.equal(mergeEvents([e, longer, elsewhere]).length, 3);
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
    "/calendars/me%40gmail.com/events ?maxAttendees,maxResults,orderBy,singleEvents,timeMax,timeMin",
    "/calendars/uni%40group.calendar.google.com/events ?maxResults,showDeleted,updatedMin",
    "/calendars/uni%40group.calendar.google.com/events ?maxAttendees,maxResults,orderBy,singleEvents,timeMax,timeMin",
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
    "/calendars/me%40gmail.com/events ?maxAttendees,maxResults,orderBy,singleEvents,timeMax,timeMin",
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
    "/calendars/uni%40group.calendar.google.com/events ?maxAttendees,maxResults,orderBy,singleEvents,timeMax,timeMin",
  ]);
  // And then looks from now on.
  g.asked = [];
  await sync.refresh({}, NOW + 120_000);
  assert.equal(g.asked.filter((a) => a.includes("singleEvents")).length, 0);
});

test("the next days are read page after page: Google may answer fewer than asked", async () => {
  const g = fakeGoogle();
  g.pageSize = 1;
  g.events["me@gmail.com"].push(
    { summary: "Pranzo", start: { dateTime: iso(at(17)) }, end: { dateTime: iso(at(18)) } },
    { summary: "Cena", start: { dateTime: iso(at(20)) }, end: { dateTime: iso(at(21)) } });
  const events = await new GoogleSync(g.get).refresh({}, NOW);
  assert.deepEqual(events.map((e) => e.title), ["Lezione Sistemi Operativi", "Pranzo", "Cena", "Esame"]);
});

test("where the user works today is not an event", () => {
  assert.equal(googleEvent({ eventType: "workingLocation", summary: "Home", start: { date: "2026-11-12" } }), null);
  assert.equal(googleEvent({ eventType: "outOfOffice", summary: "Ferie", start: { date: "2026-11-12" } }).title, "Ferie");
});

test("an invitation the user declined is left out, one they accepted or not answered yet stays", () => {
  const start = { dateTime: "2026-11-12T14:00:00+01:00" };
  const end = { dateTime: "2026-11-12T15:00:00+01:00" };
  const answer = (responseStatus) => googleEvent({ summary: "Budget", start, end, attendees: [{ self: true, responseStatus }] });
  assert.equal(answer("declined"), null);
  assert.equal(answer("accepted").title, "Budget");
  assert.equal(answer("needsAction").title, "Budget");
  assert.equal(answer("tentative").title, "Budget");
  // Someone else declining is not the user's answer.
  assert.equal(googleEvent({ summary: "Budget", start, end, attendees: [{ responseStatus: "declined" }] }).title, "Budget");
  // The user's own event, without guests.
  assert.equal(googleEvent({ summary: "Budget", start, end }).title, "Budget");
});

test("the next days ask only for the user's own answer to an invitation", async () => {
  const g = fakeGoogle();
  const queries = [];
  const get = g.get;
  g.get = (path, query) => {
    queries.push(Object.fromEntries(query));
    return get(path, query);
  };
  await new GoogleSync(g.get).refresh({}, NOW);
  const window = queries.find((q) => q.singleEvents === "true");
  assert.equal(window.maxAttendees, "1");
  assert.match(window.fields, /attendees\(self,responseStatus\)/);
});

test("one calendar that fails keeps its last events and lets the others go on; all failing throws", async () => {
  const g = fakeGoogle();
  const sync = new GoogleSync(g.get);
  await sync.refresh({}, NOW);
  g.failing.add("uni@group.calendar.google.com");
  // The lesson moves on the primary calendar while the other fails.
  g.events["me@gmail.com"][0].summary = "Lezione spostata";
  g.changed["me@gmail.com"] = [{ updated: iso(NOW + 30_000) }];
  g.changed["uni@group.calendar.google.com"] = [{ updated: iso(NOW + 30_000) }];
  const events = await sync.refresh({}, NOW + 60_000);
  assert.deepEqual(events.map((e) => e.title), ["Lezione spostata", "Esame"]);
  assert.match(sync.partialError, /500/);
  assert.ok(sync.readIds.includes("uni@group.calendar.google.com"));
  // Once it answers again, the change it missed is read then.
  g.failing.clear();
  g.asked = [];
  await sync.refresh({}, NOW + 120_000);
  assert.ok(g.asked.includes("/calendars/uni%40group.calendar.google.com/events ?maxAttendees,maxResults,orderBy,singleEvents,timeMax,timeMin"));
  assert.equal(sync.partialError, null);
  // Both failing: the refresh fails.
  g.failing.add("uni@group.calendar.google.com").add("me@gmail.com");
  g.changed["me@gmail.com"].push({ updated: iso(NOW + 150_000) });
  g.changed["uni@group.calendar.google.com"].push({ updated: iso(NOW + 150_000) });
  await assert.rejects(sync.refresh({}, NOW + 180_000), /500/);
});

test("a calendar that keeps failing drops its stale events, and no longer counts as read", async () => {
  const g = fakeGoogle();
  const sync = new GoogleSync(g.get);
  await sync.refresh({}, NOW);
  g.failing.add("uni@group.calendar.google.com");
  for (let i = 1; i <= 3; i++) {
    g.changed["uni@group.calendar.google.com"] = [{ updated: iso(NOW + i * 60_000 - 1_000) }];
    const events = await sync.refresh({}, NOW + i * 60_000);
    assert.equal(events.some((e) => e.title === "Esame"), i < 3, `refresh ${i}`);
  }
  assert.deepEqual(sync.readIds, ["me@gmail.com"]);
});

test("a change whose next-days read failed is read at the next look, not half an hour later", async () => {
  const g = fakeGoogle();
  const sync = new GoogleSync(g.get);
  await sync.refresh({ "uni@group.calendar.google.com": false }, NOW);
  g.events["me@gmail.com"][0].summary = "Spostata";
  g.changed["me@gmail.com"] = [{ updated: iso(NOW + 30_000) }];
  g.failing.add("me@gmail.com");
  await assert.rejects(sync.refresh({ "uni@group.calendar.google.com": false }, NOW + 60_000));
  g.failing.clear();
  const events = await sync.refresh({ "uni@group.calendar.google.com": false }, NOW + 120_000);
  assert.deepEqual(events.map((e) => e.title), ["Spostata"]);
});

test("a sign-out or a new account during a refresh: what it read is not kept", async () => {
  const g = fakeGoogle();
  const sync = new GoogleSync(async (path, query) => {
    const answer = await g.get(path, query);
    if (path.includes("uni%40")) sync.reset();
    return answer;
  });
  assert.equal(await sync.refresh({}, NOW), null);
  assert.deepEqual(sync.readIds, []);
  assert.deepEqual(sync.calendars, []);
});

test("the calendars read are told, for the island to leave out their iCal copy", async () => {
  const sync = new GoogleSync(fakeGoogle().get);
  await sync.refresh({}, NOW);
  assert.deepEqual(sync.readIds, ["me@gmail.com", "uni@group.calendar.google.com"]);
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

test("on the island: the iCal copy of a calendar Google reads is left out, a pause forgets nothing, a refused access drops the old events", async () => {
  const { internals } = await import("./tauri.mjs");
  const { Calendar, GoogleFeed } = await import("../src/island/activities.ts");
  const { State } = await import("../src/core/state.ts");
  const g = fakeGoogle();
  const hour = 3_600_000;
  const start = Math.floor(Date.now() / hour) * hour + 3 * hour;
  g.events["me@gmail.com"][0].start = { dateTime: iso(start) };
  g.events["me@gmail.com"][0].end = { dateTime: iso(start + 2 * hour) };
  g.events["uni@group.calendar.google.com"] = [];
  const ics = (t) => new Date(t).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const before = internals.invoke;
  let status = { client: true, signedIn: true, needsSignIn: false, signingIn: false };
  let paused = false;
  internals.invoke = async (cmd, args) => {
    // The iCal copy, hours behind: the lesson at its old time, and one deleted since.
    if (cmd === "calendar_fetch") return "BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:1\nSUMMARY:Lezione Sistemi Operativi\n"
      + `DTSTART:${ics(start - hour)}\nDTEND:${ics(start + hour)}\nEND:VEVENT\n`
      + `BEGIN:VEVENT\nUID:2\nSUMMARY:Cancellato\nDTSTART:${ics(start)}\nDTEND:${ics(start + hour)}\nEND:VEVENT\nEND:VCALENDAR\n`;
    if (cmd === "calendar_google_id") return "me@gmail.com";
    if (cmd === "google_calendar_status") return status;
    if (cmd === "google_calendar_get") {
      if (paused) throw "paused";
      return g.get(args.path, args.query);
    }
    return before(cmd, args);
  };
  // Each refresh asked while one runs comes after it: wait for all of them.
  const settle = async () => {
    for (let i = 0; i < 200 && (Calendar.busy || GoogleFeed.busy || Calendar.pending || GoogleFeed.pending); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  try {
    GoogleFeed.changed();
    Calendar.changed();
    await settle();
    assert.deepEqual(Calendar.events.map((e) => [e.title, e.start]), [["Lezione Sistemi Operativi", start]]);

    // Paused while asking: nothing is forgotten, nothing shows as failed.
    paused = true;
    State.paused = false;
    GoogleFeed.sync["listedAt"] = 0;
    await GoogleFeed.refresh();
    assert.equal(GoogleFeed.error, null);
    assert.equal(GoogleFeed.failures, 0);
    assert.equal(Calendar.events.length, 1);
    paused = false;

    // Google refuses the permission: "sign in again" instead of old events, and nothing more is asked.
    status = { ...status, needsSignIn: true };
    g.asked = [];
    await GoogleFeed.refresh();
    assert.match(Calendar.error ?? "", /sign in again/);
    assert.deepEqual(GoogleFeed.events, []);
    assert.equal(GoogleFeed.timer, null);
    assert.deepEqual(g.asked, []);
    // The iCal copy is no longer left out once Google's events are gone.
    assert.ok(Calendar.events.some((e) => e.title === "Cancellato"));
  } finally {
    internals.invoke = before;
    for (const x of [Calendar, GoogleFeed]) if (x.timer != null) clearTimeout(x.timer);
    GoogleFeed.timer = null;
    GoogleFeed.failures = 0;
  }
});
