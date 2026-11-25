// Past chats by day, and how long ago each was used (src/core/chat-dates.ts,
// concept chat-precedenti-rinnovo A).

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { chatGroup, chatWhen, daysAgo } from "../src/core/chat-dates.ts";
import { setLanguage } from "../src/i18n/i18n.ts";

afterEach(() => setLanguage("en"));

// Wednesday 25 November 2026, 18:00 on this computer.
const now = new Date(2026, 10, 25, 18, 0).getTime();
const at = (day, hour = 12, month = 10, year = 2026) => new Date(year, month, day, hour, 0).getTime();

test("the groups go by the computer's days, not by 24 hours", () => {
  assert.equal(chatGroup(at(25, 0), now), "today");
  assert.equal(chatGroup(at(24, 23), now), "yesterday");
  assert.equal(chatGroup(at(24, 0), now), "yesterday");
  assert.equal(chatGroup(at(23), now), "week");
  assert.equal(chatGroup(at(19), now), "week");
  assert.equal(chatGroup(at(18), now), "earlier");
  assert.equal(daysAgo(at(1, 12, 0, 2026), now), 328);
});

test("how long ago: minutes and hours today, yesterday, the weekday, then the date", () => {
  assert.equal(chatWhen(now - 20_000, now), "just now");
  assert.equal(chatWhen(now - 3 * 60_000, now), "3 min ago");
  assert.equal(chatWhen(now - 5 * 3_600_000, now), "5 h ago");
  assert.equal(chatWhen(at(24), now), "yesterday");
  assert.equal(chatWhen(at(23), now), "Mon");
  assert.equal(chatWhen(at(16), now), "Nov 16");
  assert.equal(chatWhen(at(3, 12, 11, 2025), now), "Dec 3 2025");
});

test("a time a little ahead of this clock is just now", () => {
  assert.equal(chatWhen(now + 5_000, now), "just now");
});

test("in Italian", () => {
  setLanguage("it");
  assert.equal(chatWhen(now - 60_000, now), "1 min fa");
  assert.equal(chatWhen(at(24), now), "ieri");
  assert.equal(chatWhen(at(22), now), "dom");
});
