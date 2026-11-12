// The live activities: what goes on and what can be started — timers, the
// music playing, the calendar's next events, the newest emails. The home
// draws them as tiles (views/home.ts); `IslandActivities` holds the data, in
// the island's page, and does what the tiles ask (`ActivitiesAction`).
// (They used to be a panel beside the open island that could be
// taken off into a window of its own. Both are gone.)
//
// The calendar is fetched every 15 minutes from the address in Settings →
// Island, and when the home shows if not asked for 5. A failed fetch (the
// network not back yet after sleep, a dropped connection) is tried again
// within the minute, and the events already read stay on screen: the error
// shows only when nothing was ever read, or after a few failures in a row
// (src/core/calendar.ts). After a 429 (too many requests) calendar.rs asks
// nothing for half an hour or what the server says.
//
// Google Calendar signed in with the user's account (Settings → Island →
// Google Calendar) is asked every minute what changed (core/google-calendar.ts),
// and when the home shows if not asked for a minute: its events join the iCal
// address's, each once.

import { Bridge, onEvent } from "../core/bridge";
import { calendarRetryIn, calendarWebLink, parseIcs, showsCalendarError, type CalEvent } from "../core/calendar";
import { GoogleSync, mergeEvents } from "../core/google-calendar";
import { Feed, compactTimer } from "../core/compact";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { ActivitiesAction, ActivitiesData, MailRow } from "../views/activities-view";
import { language } from "../i18n/i18n";
import { byEffort } from "../core/energy";

/**
 * How often the calendar is asked: Settings → General → Energy sets it. Never
 * under 5 minutes: Google answers 429 (too many requests) to an iCal address
 * read every minute, and its file changes far less often anyway.
 */
const calendarEvery = () => byEffort(State.effort, 5 * 60_000, 15 * 60_000, 30 * 60_000);
const CALENDAR_STALE_MS = 5 * 60_000;
const DAY = 86_400_000;
/**
 * How often Google Calendar is asked what changed: every minute, as its
 * answer is nearly always empty; every 15 while saving energy.
 */
const googleEvery = () => byEffort(State.effort, 60_000, 60_000, 15 * 60_000);
const GOOGLE_STALE_MS = 60_000;
const GOOGLE_CALENDAR_WEB = "https://calendar.google.com/calendar/r";


// ── The calendar ─────────────────────────────────────────────────────────────

export const Calendar = {
  /** What the home shows: the iCal address's events and Google's, each once. */
  events: [] as CalEvent[],
  configured: false,
  /** The calendar's web page (Google Calendar, Outlook, iCloud), when Lumo knows it. */
  link: null as string | null,
  error: null as string | null,
  /** The iCal address's own (calendar.rs). */
  icsEvents: [] as CalEvent[],
  icsConfigured: false,
  icsLink: null as string | null,
  icsError: null as string | null,
  fetchedAt: 0,
  /** When it was last asked, read or not: the island showing waits on it too. */
  triedAt: 0,
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
    GoogleFeed.start();
    void onEvent<null>("calendar-changed", () => {
      void this.refresh();
      GoogleFeed.sync.reset();
      void GoogleFeed.refresh();
    });
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
    this.triedAt = Date.now();
    try {
      const text = await Bridge.calendarFetch();
      const now = Date.now();
      this.icsConfigured = text != null;
      this.icsEvents = text ? parseIcs(text, now - DAY, now + 8 * DAY) : [];
      this.icsLink = text ? calendarWebLink(text) : null;
      this.icsError = null;
      this.fetchedAt = now;
      this.hasRead = text != null;
      if (this.failures > 0) this.schedule();
      this.failures = 0;
    } catch (err) {
      // fetchedAt stays (the events read are that old); triedAt keeps the
      // island showing from asking again at each open (refreshIfStale).
      // calendar.rs fails only once it has an address: the calendar is set up,
      // and its tile stays on the home with the error instead of going away.
      this.icsConfigured = true;
      this.failures++;
      if (showsCalendarError(this.failures, this.hasRead)) this.icsError = String(err).replace(/^Error:\s*/, "");
      this.schedule(calendarRetryIn(this.failures, calendarEvery()));
    } finally {
      this.busy = false;
      this.publish();
    }
  },

  /** Both sources into what the home and the closed island read. */
  publish() {
    const google = GoogleFeed;
    this.events = mergeEvents(this.icsEvents, google.events);
    this.configured = this.icsConfigured || google.on;
    this.error = this.icsError ?? google.error;
    this.link = this.icsLink ?? (google.on ? GOOGLE_CALENDAR_WEB : null);
    Feed.events = this.events;
    State.notify();
  },

  refreshIfStale() {
    if (Date.now() - Math.max(this.fetchedAt, this.triedAt) > CALENDAR_STALE_MS) void this.refresh();
    GoogleFeed.refreshIfStale();
  },
};

/** Google Calendar with the user's account (google_calendar.rs, core/google-calendar.ts). */
export const GoogleFeed = {
  sync: new GoogleSync((path, query) => Bridge.googleCalendarGet(path, query)),
  /** Signed in: the calendar has a tile even before its first answer. */
  on: false,
  events: [] as CalEvent[],
  error: null as string | null,
  fetchedAt: 0,
  triedAt: 0,
  failures: 0,
  hasRead: false,
  busy: false,
  timer: null as number | null,
  effort: "" as string,
  /** The calendars picked in Settings, as last read: a new pick reads at once. */
  picks: "",

  start() {
    this.picks = JSON.stringify(State.settings.googleCalendars ?? {});
    void this.refresh();
    this.schedule();
    State.subscribe(() => {
      const picks = JSON.stringify(State.settings.googleCalendars ?? {});
      if (picks !== this.picks) {
        this.picks = picks;
        void this.refresh();
      }
      if (State.effort !== this.effort) this.schedule();
    });
  },

  schedule(wait = googleEvery()) {
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
    this.triedAt = Date.now();
    try {
      const status = await Bridge.googleCalendarStatus();
      const events = status?.signedIn ? await this.sync.refresh(State.settings.googleCalendars) : null;
      if (events == null) this.sync.reset();
      this.on = events != null;
      this.events = events ?? [];
      this.error = null;
      this.fetchedAt = Date.now();
      this.hasRead = events != null;
      if (this.failures > 0) this.schedule();
      this.failures = 0;
    } catch (err) {
      // Signed in (Rust answered): the tile stays, with why.
      this.on = true;
      this.failures++;
      if (showsCalendarError(this.failures, this.hasRead)) this.error = String(err).replace(/^Error:\s*/, "");
      this.schedule(calendarRetryIn(this.failures, googleEvery()));
    } finally {
      this.busy = false;
      Calendar.publish();
    }
  },

  refreshIfStale() {
    if (Date.now() - Math.max(this.fetchedAt, this.triedAt) > GOOGLE_STALE_MS) void this.refresh();
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
