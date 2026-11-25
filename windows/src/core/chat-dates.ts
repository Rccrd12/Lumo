// When a past chat was last used, as Past chats say it (concept:
// chat-precedenti-rinnovo, A): the chats grouped by day (Today, Yesterday,
// This week, Earlier), and on each row how long ago, at the right ("3 min
// ago", "yesterday", "Wed", "Nov 16"). Days are the computer's own.

import { N_, dayMonth, language, t, weekdayShort } from "../i18n/i18n";
import { ageLabel } from "./plan";

export type ChatGroup = "today" | "yesterday" | "week" | "earlier";

export const GROUP_WORDS: Record<ChatGroup, string> = {
  today: N_("Today"),
  yesterday: N_("Yesterday"),
  week: N_("This week"),
  earlier: N_("Earlier"),
};

/** Midnight of `at`'s day, on this computer. */
function dayStart(at: number): number {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Whole days between `at`'s day and `now`'s (0 today, 1 yesterday). */
export function daysAgo(at: number, now = Date.now()): number {
  // Rounded: a day with a clock change is 23 or 25 hours long.
  return Math.round((dayStart(now) - dayStart(at)) / 86_400_000);
}

/** The group a chat last used at `at` goes in: within the last 7 days by its day, else Earlier. */
export function chatGroup(at: number, now = Date.now()): ChatGroup {
  const days = daysAgo(at, now);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return days < 7 ? "week" : "earlier";
}

/** How long ago, short: "3 min ago" or "2 h ago" today, "yesterday", a weekday this week, else the date (with its year if another). */
export function chatWhen(at: number, now = Date.now()): string {
  const days = daysAgo(at, now);
  if (days <= 0) return ageLabel(Math.min(at, now), now);
  if (days === 1) return t("Yesterday").toLocaleLowerCase(language());
  const d = new Date(at);
  if (days < 7) return weekdayShort(d.getDay());
  const date = dayMonth(d.getMonth(), d.getDate());
  return d.getFullYear() === new Date(now).getFullYear() ? date : `${date} ${d.getFullYear()}`;
}
