// The live activities: a second island with what goes on and what can be
// started — timers, the music playing, the calendar's next events, the newest
// emails. Beside the open island (left or right) it is drawn in the island's
// page; dragged by its top bar it comes off into a window of its own
// (activities.html, activities.rs), put wherever it is left, and joins the
// island again when dropped against its side. Its grips resize it. Its "–"
// folds it into an icon right of the "+" in the island's top bar, which brings
// it back.
//
// `ActivitiesView` only draws, from an `ActivitiesData`, and says what was
// clicked (`ActivitiesAction`); `IslandActivities` holds the data, in the
// island's page, and does what is asked — for the view beside the island and
// for the one in its own window alike.
//
// It costs nothing while the island is shut: only drawn, and only asking for
// the music, while on screen. The calendar is fetched every 15 minutes from
// the address in Settings → Island, and when it shows if older than 5.

import { Bridge, IS_TAURI, emitToWindow, onEvent } from "../core/bridge";
import { parseIcs, type CalEvent } from "../core/calendar";
import { Feed, compactTimer } from "../core/compact";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { askAboutMail } from "./compact";
import {
  ACTIVITIES_W, ActivitiesView, type ActivitiesAction, type ActivitiesData, type MailRow,
} from "../views/activities-view";
import { language } from "../i18n/i18n";

export { ACTIVITIES_GAP, ACTIVITIES_TALL, ACTIVITIES_W } from "../views/activities-view";

const CALENDAR_EVERY_MS = 15 * 60_000;
const CALENDAR_STALE_MS = 5 * 60_000;
const DAY = 86_400_000;


// ── The calendar ─────────────────────────────────────────────────────────────

export const Calendar = {
  events: [] as CalEvent[],
  configured: false,
  error: null as string | null,
  fetchedAt: 0,
  busy: false,
  timer: null as number | null,

  /** Starts the 15-minute refresh, and refreshes when Settings changes the address. */
  start() {
    void this.refresh();
    if (this.timer == null) this.timer = window.setInterval(() => void this.refresh(), CALENDAR_EVERY_MS);
    void onEvent<null>("calendar-changed", () => void this.refresh());
  },

  async refresh() {
    if (this.busy || State.paused) return;
    this.busy = true;
    try {
      const text = await Bridge.calendarFetch();
      const now = Date.now();
      this.configured = text != null;
      this.events = text ? parseIcs(text, now - DAY, now + 8 * DAY) : [];
      this.error = null;
      this.fetchedAt = now;
    } catch (err) {
      this.error = String(err).replace(/^Error:\s*/, "");
      this.fetchedAt = Date.now();
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

/** The emails the eye put away: they no longer show in the live activities. */
const ignored = new Set(loadIgnored());

function ignoreMail(id: string) {
  ignored.add(id);
  const list = [...ignored].slice(-300);
  try {
    window.localStorage?.setItem(IGNORED_KEY, JSON.stringify(list));
  } catch {
    // Storage off: ignored for this run only.
  }
}

/** The unread emails worth showing, newest first, without the ignored ones. */
export function visibleMail(messages: MailRow[], skip: ReadonlySet<string> = ignored): MailRow[] {
  return messages.filter((m) => m.id && !skip.has(m.id));
}

// ── In the island's page ─────────────────────────────────────────────────────

export interface IslandActivitiesHost {
  /** The chat, where an email's question was just put. */
  openChat(): void;
  openSettings(): void;
  /** Where the folded icon sits (or will), in page pixels. */
  iconPoint(): { x: number; y: number } | null;
  /** The panel can be moved and resized (the cursor poll). */
  movable: boolean;
  changed(): void;
}

/** Holds the live activities' data and draws them, beside the island or in their own window. */
export class IslandActivities {
  readonly view: ActivitiesView;
  private visible = false;
  private windowShown = false;
  private sentKey = "";
  private unfolding = false;

  constructor(private host: IslandActivitiesHost) {
    this.view = new ActivitiesView({
      act: (a) => this.act(a),
      drag: () => {
        const r = this.view.el.getBoundingClientRect();
        void Bridge.activitiesDrag([parseFloat(this.view.el.style.left) || r.left, parseFloat(this.view.el.style.top) || r.top, r.width, r.height]);
      },
      resize: (fx, fy) => void Bridge.activitiesResize(fx, fy, this.view.el.getBoundingClientRect().height),
      focus: () => void Bridge.focusWindow(true),
      iconPoint: () => host.iconPoint(),
      movable: host.movable,
    }, () => (State.settings.activitiesSide === "right" ? "right" : "left"));
    this.view.el.id = "activities";
    void onEvent<ActivitiesAction>("activities-action", (a) => this.act(a));
    void onEvent<null>("activities-hello", () => {
      this.sentKey = "";
      this.sendToWindow();
    });
    // Live sizes while a grip is dragged beside the island.
    void onEvent<{ width: number; height: number }>("activities-resize", (size) => {
      State.settings = { ...State.settings, activitiesWidth: size.width, activitiesHeight: size.height };
      host.changed();
    });
    void onEvent<string>("activities-joined", () => {
      Sound.play("pop");
      this.unfolding = true;
    });
    Calendar.start();
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** The panel in its own window instead of beside the island. */
  get detached(): boolean {
    return this.host.movable && State.settings.activitiesDetached === true;
  }

  get width(): number {
    const w = State.settings.activitiesWidth;
    return Number.isFinite(w) && w > 0 ? Math.min(480, Math.max(220, w)) : ACTIVITIES_W;
  }

  get pickedHeight(): number {
    const v = State.settings.activitiesHeight;
    return Number.isFinite(v) && v > 0 ? Math.min(640, Math.max(200, v)) : 0;
  }

  /** What the views draw. */
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
      calendar: { configured: Calendar.configured, error: Calendar.error, events: Calendar.events },
      mail: { on, error: info?.error ?? null, messages: visibleMail(messages) },
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
      case "media":
        void Bridge.mediaControl(a.action);
        if (a.action === "toggle" && Feed.media) Feed.media = { ...Feed.media, playing: !Feed.media.playing };
        break;
      case "mail": {
        const m = this.data().mail.messages.find((x) => x.id === a.id);
        if (a.what === "ignore") {
          ignoreMail(a.id);
          Sound.play("pop");
        } else if (a.what === "open") {
          if (m?.link) void Bridge.openUrl(m.link);
        } else if (m) {
          askAboutMail(m, a.what);
          this.host.openChat();
        }
        break;
      }
      case "settings":
        this.host.openSettings();
        break;
      case "fold":
        State.settings = { ...State.settings, activitiesFolded: true };
        void Bridge.saveSettings(State.settings);
        break;
    }
    this.host.changed();
  }

  /** The folded icon was clicked: back they come. */
  unfold() {
    Sound.play("open");
    this.unfolding = true;
    State.settings = { ...State.settings, activitiesFolded: false };
    void Bridge.saveSettings(State.settings);
    this.host.changed();
  }

  /**
   * Beside the island at (x, y), `height` tall, or hidden; in their own
   * window, shown or hidden. Called every frame the island moves.
   */
  place(show: boolean, x: number, y: number, height: number) {
    const el = this.view.el;
    const besideIsland = show && !this.detached;
    if (besideIsland) {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = `${this.width}px`;
      el.style.height = `${height}px`;
    }
    if (besideIsland !== this.visible) {
      this.visible = besideIsland;
      el.classList.toggle("shown", besideIsland);
      if (besideIsland) {
        Calendar.refreshIfStale();
        if (this.unfolding) this.view.flyIn();
        else this.view.reveal();
        this.host.changed();
      } else {
        this.view.stop();
      }
    }
    const inWindow = show && this.detached;
    if (inWindow !== this.windowShown) {
      this.windowShown = inWindow;
      void Bridge.activitiesShow(inWindow);
      if (inWindow) {
        Calendar.refreshIfStale();
        this.sentKey = "";
        this.sendToWindow();
        void emitToWindow("activities", "activities-appear", this.unfolding);
      }
    }
    if (show) this.unfolding = false;
  }

  /** Redraws beside the island, or sends their window what changed. */
  sync() {
    if (this.visible) this.view.render(this.data());
    if (this.windowShown) this.sendToWindow();
  }

  private sendToWindow() {
    if (!IS_TAURI) return;
    const data = this.data();
    const key = JSON.stringify(data);
    if (key === this.sentKey) return;
    this.sentKey = key;
    void emitToWindow("activities", "activities-state", data);
  }
}
