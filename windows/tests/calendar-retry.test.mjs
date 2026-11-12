// A failed calendar fetch (src/core/calendar.ts, used by src/island/activities.ts): tried again soon, and
// the events already read kept on screen until it keeps failing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CALENDAR_FAILURES_SHOWN, calendarRetryIn, showsCalendarError } from "../src/core/calendar.ts";

test("a failed fetch is tried again within the minute, then less often", () => {
  const every = 15 * 60_000;
  assert.equal(calendarRetryIn(1, every), 30_000);
  assert.equal(calendarRetryIn(2, every), 60_000);
  assert.equal(calendarRetryIn(3, every), 120_000);
  assert.equal(calendarRetryIn(10, every), every);
  assert.equal(calendarRetryIn(1, 20_000), 20_000);
});

test("the error shows only when nothing was read, or after several failures", () => {
  assert.equal(showsCalendarError(1, false), true);
  assert.equal(showsCalendarError(1, true), false);
  assert.equal(showsCalendarError(CALENDAR_FAILURES_SHOWN - 1, true), false);
  assert.equal(showsCalendarError(CALENDAR_FAILURES_SHOWN, true), true);
});

test("a calendar whose address is set but never read stays set up, with its error (the home keeps its tile)", async () => {
  const { internals } = await import("./tauri.mjs");
  const { Calendar } = await import("../src/island/activities.ts");
  const before = internals.invoke;
  let answer = () => { throw "The calendar address answered 404."; };
  internals.invoke = async (cmd, args) => (cmd === "calendar_fetch" ? answer() : before(cmd, args));
  try {
    await Calendar.refresh();
    assert.equal(Calendar.configured, true);
    assert.match(Calendar.error ?? "", /404/);
    // The address removed in Settings: Rust answers null, and the tile goes.
    answer = () => null;
    await Calendar.refresh();
    assert.equal(Calendar.configured, false);
  } finally {
    internals.invoke = before;
    if (Calendar.timer != null) clearTimeout(Calendar.timer);
  }
});

test("after a failed fetch, opening the island does not ask the calendar again for 5 minutes", async () => {
  const { internals } = await import("./tauri.mjs");
  const { Calendar } = await import("../src/island/activities.ts");
  const before = internals.invoke;
  let asked = 0;
  internals.invoke = async (cmd, args) => {
    if (cmd !== "calendar_fetch") return before(cmd, args);
    asked++;
    throw "Too many requests";
  };
  try {
    Calendar.fetchedAt = 0;
    await Calendar.refresh();
    assert.equal(asked, 1);
    Calendar.refreshIfStale();
    Calendar.refreshIfStale();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(asked, 1);
    Calendar.triedAt -= 6 * 60_000;
    Calendar.refreshIfStale();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(asked, 2);
  } finally {
    internals.invoke = before;
    if (Calendar.timer != null) clearTimeout(Calendar.timer);
  }
});
