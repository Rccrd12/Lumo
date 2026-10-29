// Listening to the calendar (listen.rs keeps the watch, listen_events.rs fires
// it): the island reads the calendar anyway (activities.ts), so it looks here
// for an event coming up, every half a minute while a watch on the calendar
// is on, and not at all otherwise.

import { Bridge } from "../core/bridge";
import { calendarDue } from "../core/listen";
import { State } from "../core/state";
import { N_, t } from "../i18n/i18n";
import { Calendar } from "./activities";

export const LISTEN_CALENDAR_STRINGS = {
  soon: N_("{title} starts in {minutes} min"),
  now: N_("{title} is starting"),
};

const EVERY_MS = 30_000;
let timer: number | null = null;
/** What was said already, by watch and event, while Rust has not answered yet. */
const said = new Set<string>();

function look() {
  if (State.paused) return;
  const now = Date.now();
  for (const w of State.listening) {
    const event = calendarDue(w, Calendar.events, now);
    if (!event) continue;
    const key = `${w.id}:${event.start}`;
    if (said.has(key)) continue;
    said.add(key);
    const minutes = Math.round((event.start - now) / 60_000);
    const summary = minutes > 0
      ? t(LISTEN_CALENDAR_STRINGS.soon, { title: event.title, minutes })
      : t(LISTEN_CALENDAR_STRINGS.now, { title: event.title });
    void Bridge.listenFire(w.id, summary, event.start);
  }
}

/** Looks while a watch on the calendar is on. */
export function startCalendarListening() {
  State.subscribe(() => {
    const on = State.listening.some((w) => w.source === "service" && w.target === "calendar" && !w.paused);
    if (on && timer == null) {
      timer = window.setInterval(look, EVERY_MS);
      look();
    } else if (!on && timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
  });
}
