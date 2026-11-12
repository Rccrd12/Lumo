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
// address's, each once. When the iCal address is one of the calendars Google
// sign-in reads, its copy (hours behind) is left out. Once a source keeps
// failing, its old events give way to its error.

import { Bridge, onEvent } from "../core/bridge";
import { calendarRetryIn, calendarWebLink, parseIcs, showsCalendarError, type CalEvent } from "../core/calendar";
import { GoogleSync, mergeEvents } from "../core/google-calendar";
import { Feed, compactTimer } from "../core/compact";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { ActivitiesAction, ActivitiesData, MailRow } from "../views/activities-view";
import { language, t } from "../i18n/i18n";
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
  /** The Google calendar the iCal address reads, when it is one of Google Calendar's. */
  icsGoogleId: null as string | null,
  /** Asked while a fetch was on its way: fetched again once it ends. */
  pending: false,
  /** Bumped by a new address: a fetch of the old one, still on its way, is not kept. */
  generation: 0,
  /** What was last published, so the island redraws only when it changes. */
  shown: "",
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
    // A new iCal address (calendar.rs), or a Google sign-in, sign-out or new client (google_calendar.rs):
    // each source starts over on its own, the other keeps what it read.
    void onEvent<null>("calendar-changed", () => this.changed());
    void onEvent<null>("google-calendar-changed", () => GoogleFeed.changed());
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

  /** A new address (or none) in Settings: nothing of the old one stays. */
  changed() {
    this.generation++;
    this.icsEvents = [];
    this.icsConfigured = false;
    this.icsLink = null;
    this.icsError = null;
    this.icsGoogleId = null;
    this.hasRead = false;
    this.failures = 0;
    this.fetchedAt = 0;
    this.publish();
    void this.refresh();
  },

  async refresh() {
    if (State.paused) return;
    if (this.busy) {
      this.pending = true;
      return;
    }
    this.busy = true;
    this.pending = false;
    this.triedAt = Date.now();
    const generation = this.generation;
    try {
      const text = await Bridge.calendarFetch();
      const googleId = text != null ? await Bridge.calendarGoogleId() : null;
      if (generation !== this.generation) return;
      const now = Date.now();
      this.icsConfigured = text != null;
      this.icsEvents = text ? parseIcs(text, now - DAY, now + 8 * DAY) : [];
      this.icsLink = text ? calendarWebLink(text) : null;
      this.icsGoogleId = googleId;
      this.icsError = null;
      this.fetchedAt = now;
      this.hasRead = text != null;
      if (this.failures > 0) this.schedule();
      this.failures = 0;
    } catch (err) {
      if (generation !== this.generation) return;
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
      if (this.pending) void this.refresh();
    }
  },

  /** Both sources into what the home and the closed island read. */
  publish() {
    const google = GoogleFeed;
    // The iCal copy of a calendar Google sign-in reads is hours behind: Google's wins.
    const icsShadowed = this.icsGoogleId != null && google.on && google.error == null
      && google.sync.readIds.includes(this.icsGoogleId);
    // A source shown failing has its old events give way to its error.
    const ics = icsShadowed || this.icsError != null ? [] : this.icsEvents;
    const fromGoogle = google.error != null ? [] : google.events;
    this.events = mergeEvents(ics, fromGoogle);
    this.configured = this.icsConfigured || google.on;
    this.error = (icsShadowed ? null : this.icsError) ?? google.error;
    this.link = this.icsLink ?? (google.on ? GOOGLE_CALENDAR_WEB : null);
    Feed.events = this.events;
    const shown = JSON.stringify([this.events, this.configured, this.error, this.link]);
    if (shown !== this.shown) {
      this.shown = shown;
      State.notify();
    }
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
  /** Asked while a refresh was on its way (a new pick, a sign-in): refreshed again once it ends. */
  pending: false,
  /** Bumped by a sign-in, a sign-out or a new client: a refresh begun before is not kept. */
  generation: 0,
  /** Only while signed in and Google still accepts the permission: otherwise nothing is asked. */
  timer: null as number | null,
  effort: "" as string,
  /** The calendars picked in Settings, as last read: a new pick reads at once. */
  picks: "",
  paused: false,

  start() {
    this.picks = JSON.stringify(State.settings.googleCalendars ?? {});
    this.paused = State.paused;
    void this.refresh();
    State.subscribe(() => {
      const picks = JSON.stringify(State.settings.googleCalendars ?? {});
      if (picks !== this.picks) {
        this.picks = picks;
        void this.refresh();
      }
      // Back from a pause: what changed meanwhile, at once.
      if (State.paused !== this.paused) {
        this.paused = State.paused;
        if (!State.paused) void this.refresh();
      }
      if (State.effort !== this.effort && this.timer != null) this.schedule();
    });
  },

  /** Signed in, out, or a new client (google_calendar.rs says so): read from scratch. */
  changed() {
    this.generation++;
    this.sync.reset();
    this.events = [];
    this.error = null;
    this.failures = 0;
    this.hasRead = false;
    this.fetchedAt = 0;
    Calendar.publish();
    void this.refresh();
  },

  schedule(wait = googleEvery()) {
    this.stop();
    this.effort = State.effort;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, wait);
  },

  stop() {
    if (this.timer != null) window.clearTimeout(this.timer);
    this.timer = null;
  },

  async refresh() {
    if (State.paused) return;
    if (this.busy) {
      this.pending = true;
      return;
    }
    this.busy = true;
    this.pending = false;
    this.triedAt = Date.now();
    const generation = this.generation;
    // The next ask: none while signed out or refused (a sign-in says when).
    let next: number | null = null;
    try {
      const status = await Bridge.googleCalendarStatus();
      if (generation !== this.generation) return;
      if (!status?.signedIn) {
        this.sync.reset();
        this.on = false;
        this.events = [];
        this.error = null;
        this.hasRead = false;
        this.failures = 0;
        return;
      }
      this.on = true;
      if (status.needsSignIn) {
        this.refused();
        return;
      }
      const events = await this.sync.refresh(State.settings.googleCalendars);
      if (generation !== this.generation) return;
      if (events == null) {
        // Signed out meanwhile: the next status says so.
        next = 0;
        return;
      }
      this.events = events;
      this.error = null;
      this.fetchedAt = Date.now();
      this.hasRead = true;
      this.failures = 0;
      next = googleEvery();
    } catch (err) {
      if (generation !== this.generation) return;
      const message = String(err).replace(/^Error:\s*/, "");
      // Paused meanwhile: nothing failed, and the resume reads again.
      if (State.paused || message === "paused") return;
      // This very ask may have been the one Google refused.
      if ((await Bridge.googleCalendarStatus())?.needsSignIn) {
        if (generation === this.generation) this.refused();
        return;
      }
      this.failures++;
      if (showsCalendarError(this.failures, this.hasRead)) this.error = message;
      next = calendarRetryIn(this.failures, googleEvery());
    } finally {
      this.busy = false;
      if (generation === this.generation) {
        if (next == null) this.stop();
        else this.schedule(next);
        Calendar.publish();
      }
      if (this.pending) void this.refresh();
    }
  },

  /** Google refused the permission: its old events give way to "sign in again", and nothing is asked until a sign-in. */
  refused() {
    this.sync.reset();
    this.events = [];
    this.error = t("Google closed Lumo's access: sign in again in Settings → Island.");
  },

  refreshIfStale() {
    if (!this.on || (this.error != null && this.timer == null)) return;
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
