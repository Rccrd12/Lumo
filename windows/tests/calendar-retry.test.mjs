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
