// The live activities: what goes on and what can be started — timers, the
// music playing, the calendar's next events, the newest emails. The home
// draws them as tiles (views/home.ts); `IslandActivities` holds the data, in
// the island's page, and does what the tiles ask (`ActivitiesAction`).
// (They used to be a panel beside the open island that could be
// taken off into a window of its own. Both are gone.)
//
// The calendar is fetched every 15 minutes from the address in Settings →
// Island, and when the home shows if older than 5. A failed fetch (the
// network not back yet after sleep, a dropped connection) is tried again
// within the minute, and the events already read stay on screen: the error
// shows only when nothing was ever read, or after a few failures in a row
// (src/core/calendar.ts).

import { Bridge, onEvent } from "../core/bridge";
import { calendarRetryIn, calendarWebLink, parseIcs, showsCalendarError, type CalEvent } from "../core/calendar";
import { Feed, compactTimer } from "../core/compact";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { ActivitiesAction, ActivitiesData, MailRow } from "../views/activities-view";
import { language } from "../i18n/i18n";
import { byEffort } from "../core/energy";

/** How often the calendar is asked: Settings → General → Energy sets it. */
const calendarEvery = () => byEffort(State.effort, 60_000, 15 * 60_000, 30 * 60_000);
const CALENDAR_STALE_MS = 5 * 60_000;
const DAY = 86_400_000;


// ── The calendar ─────────────────────────────────────────────────────────────

export const Calendar = {
  events: [] as CalEvent[],
  configured: false,
  /** The calendar's web page (Google Calendar, Outlook, iCloud), when Lumo knows it. */
  link: null as string | null,
  error: null as string | null,
  fetchedAt: 0,
  /** Failed fetches in a row; a good one sets it back to 0. */
  failures: 0,
  /** The file was read at least once since Lumo started. */
  hasRead: false,
  busy: false,
  timer: null as number | null,
  effort: "" as string,

  /**
   * Starts the refresh (every 15 minutes, or as Settings → General → Energy
   * says), and refreshes when Settings changes the address.
   */
  start() {
    void this.refresh();
    this.schedule();
    void onEvent<null>("calendar-changed", () => void this.refresh());
    // A new effort takes effect at once, not after the wait it replaced.
    State.subscribe(() => {
      if (State.effort !== this.effort) this.schedule();
    });
  },

  /** The next fetch in `wait` (the usual wait, or sooner after a failure). */
  schedule(wait = calendarEvery()) {
    if (this.timer != null) window.clearTimeout(this.timer);
    this.effort = State.effort;
    this.timer = window.setTimeout(() => {
      this.schedule();
      void this.refresh();
    }, wait);
  },

  async refresh() {
    if (this.busy || State.paused) return;
    this.busy = true;
    try {
      const text = await Bridge.calendarFetch();
      const now = Date.now();
      this.configured = text != null;
      this.events = text ? parseIcs(text, now - DAY, now + 8 * DAY) : [];
      this.link = text ? calendarWebLink(text) : null;
      this.error = null;
      this.fetchedAt = now;
      this.hasRead = text != null;
      if (this.failures > 0) this.schedule();
      this.failures = 0;
    } catch (err) {
      // fetchedAt stays: the island showing asks again (refreshIfStale).
      this.failures++;
      if (showsCalendarError(this.failures, this.hasRead)) this.error = String(err).replace(/^Error:\s*/, "");
      this.schedule(calendarRetryIn(this.failures, calendarEvery()));
    } finally {
      this.busy = false;
      Feed.events = this.events;
      State.notify();
    }
  },

  refreshIfStale() {
    if (Date.now() - this.fetchedAt > CALENDAR_STALE_MS) void this.refresh();
  },
};

// ── Ignored emails ───────────────────────────────────────────────────────────

const IGNORED_KEY = "lumo.mailIgnored";

function loadIgnored(): string[] {
  try {
    const v = JSON.parse(window.localStorage?.getItem(IGNORED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The emails the eye of the live activities' old panel put away:
 * they still do not show in the home's tile.
 */
const ignored = new Set(loadIgnored());

/** The unread emails worth showing, newest first, without the ignored ones. */
export function visibleMail(messages: MailRow[], skip: ReadonlySet<string> = ignored): MailRow[] {
  return messages.filter((m) => m.id && !skip.has(m.id));
}

// ── In the island's page ─────────────────────────────────────────────────────

export interface IslandActivitiesHost {
  openSettings(): void;
  changed(): void;
}

/** Holds the live activities' data, for the home's tiles, and does what they ask. */
export class IslandActivities {
  private host: IslandActivitiesHost;

  constructor(host: IslandActivitiesHost) {
    this.host = host;
    Calendar.start();
  }

  /** What the home's tiles draw. */
  data(): ActivitiesData {
    const info = State.integrations.integration_mail;
    const on = State.settings.activeIntegrations.includes("integration_mail") && (info?.configured ?? false);
    const raw = Array.isArray(info?.data?.messages) ? (info!.data.messages as Record<string, unknown>[]) : [];
    const messages: MailRow[] = raw.map((m) => ({
      id: String(m.id ?? ""), from: String(m.from ?? ""), address: String(m.address ?? ""),
      subject: String(m.subject ?? ""), preview: String(m.preview ?? ""), body: String(m.body ?? ""),
      link: typeof m.link === "string" ? m.link : undefined,
    }));
    return {
      lang: language(),
      timers: Feed.timers,
      media: Feed.media,
      calendar: { configured: Calendar.configured, error: Calendar.error, events: Calendar.events, link: Calendar.link ?? undefined },
      mail: {
        on, error: info?.error ?? null, messages: visibleMail(messages),
        inbox: typeof info?.data?.inbox === "string" ? info.data.inbox : undefined,
      },
    };
  }

  act(a: ActivitiesAction) {
    switch (a.kind) {
      case "timer":
        compactTimer(a.ms, a.label);
        Sound.play("blip");
        break;
      case "cancelTimer":
        Feed.cancelTimer(a.id);
        break;
      case "pauseTimer":
        Feed.toggleTimerPause(a.id, Date.now());
        break;
      case "media":
        void Bridge.mediaControl(a.action);
        if (a.action === "toggle" && Feed.media) Feed.media = { ...Feed.media, playing: !Feed.media.playing };
        break;
      case "inbox": {
        const inbox = this.data().mail.inbox;
        if (inbox) void Bridge.openUrl(inbox);
        break;
      }
      case "calendarWeb":
        if (Calendar.link) void Bridge.openUrl(Calendar.link);
        break;
      case "settings":
        this.host.openSettings();
        break;
    }
    this.host.changed();
  }
}
