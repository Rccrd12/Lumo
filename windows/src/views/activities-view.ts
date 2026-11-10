// The live activities' words, what they show and what they ask for: the
// home draws them as tiles (views/home.ts), and island/activities.ts holds
// what they show and does what they ask.

import type { CalEvent } from "../core/calendar";
import type { MailPeek, MediaActivity, TimerActivity } from "../core/compact";
import { N_, language, t } from "../i18n/i18n";

export const ACTIVITIES_TEXT = {
  timer: N_("Timer"),
  timerHint: N_("15m pasta"),
  music: N_("Music"),
  nothingPlaying: N_("Nothing playing"),
  calendar: N_("Calendar"),
  nothingSoon: N_("Nothing in the next days"),
  email: N_("Email"),
  noUnread: N_("No unread email"),
  today: N_("Today"),
  tomorrow: N_("Tomorrow"),
  allDay: N_("All day"),
  previous: N_("Previous"),
  next: N_("Next"),
  play: N_("Play"),
  pause: N_("Pause"),
};

const DAY = 86_400_000;

// ── What the tiles show, and what they ask for ───────────────────────────────

export interface MailRow extends MailPeek {
  body: string;
}

export interface ActivitiesData {
  lang: string;
  timers: TimerActivity[];
  media: MediaActivity | null;
  calendar: { configured: boolean; error: string | null; events: CalEvent[]; link?: string };
  mail: { on: boolean; error: string | null; messages: MailRow[]; inbox?: string };
}

export type ActivitiesAction =
  | { kind: "timer"; ms: number; label: string }
  | { kind: "cancelTimer"; id: number }
  | { kind: "pauseTimer"; id: number }
  | { kind: "media"; action: "toggle" | "next" | "previous" }
  | { kind: "inbox" }
  | { kind: "calendarWeb" }
  | { kind: "settings" };

/** "14:00", "Tomorrow 9:30", "Mon 12 Oct" (a whole-day event says "All day" instead). */
export function eventWhen(e: CalEvent, now: number, lang = language()): string {
  const d = new Date(e.start);
  const today = new Date(now);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / DAY);
  const time = d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  const day = days <= 0 ? t(ACTIVITIES_TEXT.today) : days === 1 ? t(ACTIVITIES_TEXT.tomorrow)
    : d.toLocaleDateString(lang, { weekday: "short", day: "numeric", month: "short" });
  return days <= 0 ? time : `${day} ${time}`;
}
