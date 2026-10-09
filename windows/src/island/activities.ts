// The live activities: a second island beside the open one, with what goes on
// and what can be started — timers, the music playing, the calendar's next
// events, the newest emails. Its "–" folds it, with a flight, into an icon in
// the open island's top bar, to the right of the "+"; that icon brings it back.
//
// It costs nothing while the island is shut: it is only drawn, and only asks
// for the music, while it is on screen. The calendar is fetched every 15
// minutes from the address in Settings → Island, and when it opens if older
// than 5.

import { Bridge, onEvent } from "../core/bridge";
import { parseIcs, type CalEvent } from "../core/calendar";
import { Feed, compactTimer, parseDuration, timerLeft, type MailPeek } from "../core/compact";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { askAboutMail } from "./compact";
import { clear, h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { N_, language, t } from "../i18n/i18n";

export const ACTIVITIES_TEXT = {
  title: N_("Live Activities"),
  fold: N_("Minimize"),
  show: N_("Live Activities"),
  timer: N_("Timer"),
  start: N_("Start"),
  timerHint: N_("15m pasta"),
  cancel: N_("Dismiss"),
  music: N_("Music"),
  nothingPlaying: N_("Nothing playing"),
  calendar: N_("Calendar"),
  nothingSoon: N_("Nothing in the next days"),
  noCalendar: N_("Paste your calendar's iCal address in Settings → Island to see what's next."),
  email: N_("Email"),
  noUnread: N_("No unread email"),
  noEmail: N_("Turn on the Email pill in Settings to see new emails here."),
  summarize: N_("Summarize"),
  reply: N_("Draft a reply"),
  today: N_("Today"),
  tomorrow: N_("Tomorrow"),
  allDay: N_("All day"),
  openSettings: N_("Settings"),
  previous: N_("Previous"),
  next: N_("Next"),
  play: N_("Play"),
  pause: N_("Pause"),
};

/** The panel's width and its gap from the island (island.rs ACTIVITIES_ROOM). */
export const ACTIVITIES_W = 264;
export const ACTIVITIES_GAP = 12;
/** Minutes offered as one-click timers. */
const QUICK_TIMERS = [1, 5, 10, 25];
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

/** "14:00", "Tomorrow 9:30", "Mon 12 Oct", or the day for a whole-day event. */
export function eventWhen(e: CalEvent, now: number, lang = language()): string {
  const d = new Date(e.start);
  const today = new Date(now);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / DAY);
  const time = d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  const day = days <= 0 ? t(ACTIVITIES_TEXT.today) : days === 1 ? t(ACTIVITIES_TEXT.tomorrow)
    : d.toLocaleDateString(lang, { weekday: "short", day: "numeric", month: "short" });
  if (e.allDay) return days <= 0 ? t(ACTIVITIES_TEXT.today) : day;
  return days <= 0 ? time : `${day} ${time}`;
}

// ── The panel ────────────────────────────────────────────────────────────────

export interface ActivitiesHost {
  /** The chat, where an email's question was just put. */
  openChat(): void;
  /** Settings, for the calendar's address or the Email pill. */
  openSettings(): void;
  /** Where the folded icon goes: its centre, in page pixels. */
  iconPoint(): { x: number; y: number } | null;
  /** The panel folded or came back: Settings keeps it, the window resizes. */
  setOpen(open: boolean): void;
  changed(): void;
}

export class ActivitiesPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private timerList = h("div", { class: "act-rows" });
  private musicBox = h("div", { class: "act-rows" });
  private calendarBox = h("div", { class: "act-rows" });
  private mailBox = h("div", { class: "act-rows" });
  private timerInput: HTMLInputElement;
  private keys = { timer: "", music: "", calendar: "", mail: "" };
  private tick: number | null = null;
  private visible = false;
  private folding = false;
  /** Comes back with a flight from the icon on its next showing. */
  private unfolding = false;

  constructor(private host: ActivitiesHost) {
    this.timerInput = h("input", {
      class: "act-input",
      type: "text",
      spellcheck: "false",
      autocomplete: "off",
      placeholder: t(ACTIVITIES_TEXT.timerHint),
    }) as HTMLInputElement;
    // The island takes no keys until asked: a click in the field asks.
    this.timerInput.addEventListener("mousedown", () => void Bridge.focusWindow(true));
    this.timerInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.startTyped();
      }
    });
    const quick = h("div", { class: "act-chips" },
      ...QUICK_TIMERS.map((m) => h("button", { class: "act-chip", onclick: () => this.startTimer(m * 60_000, "") }, `${m}m`)),
    );
    const form = h("div", { class: "act-form" }, this.timerInput,
      h("button", { class: "act-chip go", onclick: () => this.startTyped() }, t(ACTIVITIES_TEXT.start)));
    this.body = h("div", { class: "act-body" },
      this.section(ICONS.timer, ACTIVITIES_TEXT.timer, "#F5A524", this.timerList, quick, form),
      this.section(ICONS.play, ACTIVITIES_TEXT.music, "#1DB954", this.musicBox),
      this.section(ICONS.clock, ACTIVITIES_TEXT.calendar, "#4285F4", this.calendarBox),
      this.section(ICONS.envelope, ACTIVITIES_TEXT.email, "#EA4335", this.mailBox),
    );
    const fold = h("button", { class: "act-fold", title: t(ACTIVITIES_TEXT.fold), "aria-label": t(ACTIVITIES_TEXT.fold), onclick: () => this.fold() },
      h("i"));
    this.el = h("div", { id: "activities" },
      h("div", { class: "act-head" }, fold, h("span", { class: "act-title", text: t(ACTIVITIES_TEXT.title) })),
      this.body,
    );
    this.el.addEventListener("transitionend", (e) => {
      if (e.target === this.el && e.propertyName === "transform" && this.folding) this.folded();
    });
  }

  private section(icon: string, title: string, color: string, ...content: HTMLElement[]): HTMLElement {
    return h("section", { class: "act-card" },
      h("div", { class: "act-card-head" },
        h("span", { class: "act-icon", style: `color:${color}` }, svg(icon, 12, { stroke: icon === ICONS.envelope || icon === ICONS.clock ? 1.8 : undefined })),
        h("span", { text: t(title) })),
      ...content,
    );
  }

  get isVisible(): boolean {
    return this.visible;
  }

  /** Placed beside the island (page pixels); `show` false hides it. */
  place(show: boolean, x: number, y: number, height: number) {
    if (show) {
      this.el.style.left = `${x}px`;
      this.el.style.top = `${y}px`;
      this.el.style.height = `${height}px`;
    }
    if (show === this.visible) return;
    this.visible = show;
    if (show && this.unfolding) {
      this.unfolding = false;
      this.flyFromIcon();
    } else {
      this.el.classList.toggle("shown", show);
    }
    if (show) Calendar.refreshIfStale();
    this.syncTick();
    if (show) this.host.changed();
  }

  /** Redraws what changed; cheap when nothing did. */
  sync(now = Date.now()) {
    if (!this.visible) return;
    this.drawTimers(now);
    this.drawMusic();
    this.drawCalendar(now);
    this.drawMail();
    this.syncTick();
  }

  // ── Folding ─────────────────────────────────────────────────────────────────

  /** "–": it flies into its icon next to the "+", then the window shrinks. */
  private fold() {
    if (this.folding) return;
    const target = this.host.iconPoint();
    Sound.play("close");
    if (!target) {
      this.folded();
      return;
    }
    const r = this.el.getBoundingClientRect();
    const dx = target.x - (r.left + r.width / 2);
    const dy = target.y - (r.top + r.height / 2);
    this.folding = true;
    this.el.classList.add("folding");
    this.el.style.transform = `translate(${dx}px, ${dy}px) scale(0.06)`;
    // Should the transition never end (reduced motion), fold anyway.
    window.setTimeout(() => {
      if (this.folding) this.folded();
    }, 600);
  }

  private folded() {
    this.folding = false;
    this.visible = false;
    this.el.classList.remove("shown", "folding");
    this.el.style.transform = "";
    this.syncTick();
    this.host.setOpen(false);
  }

  /** The icon was clicked: back it comes, flying out of the icon. */
  unfold() {
    this.unfolding = true;
    Sound.play("open");
    this.host.setOpen(true);
  }

  private flyFromIcon() {
    const target = this.host.iconPoint();
    if (!target) {
      this.el.classList.add("shown");
      return;
    }
    const r = this.el.getBoundingClientRect();
    const left = parseFloat(this.el.style.left) || r.left;
    const top = parseFloat(this.el.style.top) || r.top;
    const height = parseFloat(this.el.style.height) || r.height;
    const dx = target.x - (left + ACTIVITIES_W / 2);
    const dy = target.y - (top + height / 2);
    this.el.classList.add("instant", "shown");
    this.el.style.transform = `translate(${dx}px, ${dy}px) scale(0.06)`;
    this.el.style.opacity = "0";
    // Next frame: let it fly back to its place.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this.el.classList.remove("instant");
      this.el.style.transform = "";
      this.el.style.opacity = "";
    }));
  }

  // ── Timers ──────────────────────────────────────────────────────────────────

  private startTyped() {
    const raw = this.timerInput.value.trim();
    const m = /^(\S+)\s*(.*)$/.exec(raw);
    const ms = m ? parseDuration(m[1]) : null;
    if (!m || ms == null) {
      this.timerInput.classList.add("bad");
      window.setTimeout(() => this.timerInput.classList.remove("bad"), 600);
      return;
    }
    this.timerInput.value = "";
    this.startTimer(ms, m[2]);
  }

  private startTimer(ms: number, label: string) {
    compactTimer(ms, label);
    Sound.play("blip");
    this.host.changed();
  }

  private drawTimers(now: number) {
    const key = Feed.timers.map((x) => `${x.id}:${timerLeft(x.endsAt - now)}:${x.label}`).join("|");
    if (key === this.keys.timer) return;
    this.keys.timer = key;
    clear(this.timerList);
    for (const timer of Feed.timers) {
      const left = Math.max(0, timer.endsAt - now);
      const bar = h("i", { class: "act-progress" });
      bar.style.width = `${Math.min(100, (1 - left / timer.total) * 100)}%`;
      this.timerList.append(h("div", { class: "act-row timer" },
        h("span", { class: "act-time", text: timerLeft(left) }),
        h("span", { class: "act-text", text: timer.label || t(ACTIVITIES_TEXT.timer) }),
        h("button", {
          class: "act-x", title: t(ACTIVITIES_TEXT.cancel), "aria-label": t(ACTIVITIES_TEXT.cancel),
          onclick: () => {
            Feed.cancelTimer(timer.id);
            this.host.changed();
          },
        }, svg(ICONS.xmark, 10)),
        bar,
      ));
    }
  }

  /** Every second while a timer runs and the panel shows; never otherwise. */
  private syncTick() {
    const want = this.visible && Feed.timers.length > 0;
    if (want && this.tick == null) this.tick = window.setInterval(() => this.host.changed(), 1000);
    if (!want && this.tick != null) {
      window.clearInterval(this.tick);
      this.tick = null;
    }
  }

  // ── Music ───────────────────────────────────────────────────────────────────

  private drawMusic() {
    const m = Feed.media;
    const key = m ? `${m.title}|${m.artist}|${m.app}|${m.playing}` : "";
    if (key === this.keys.music && this.musicBox.childElementCount) return;
    this.keys.music = key;
    clear(this.musicBox);
    if (!m) {
      this.musicBox.append(h("div", { class: "act-empty", text: t(ACTIVITIES_TEXT.nothingPlaying) }));
      return;
    }
    const control = (action: "toggle" | "next" | "previous") => () => {
      void Bridge.mediaControl(action);
      if (action === "toggle" && Feed.media) Feed.media = { ...Feed.media, playing: !Feed.media.playing };
      this.host.changed();
    };
    const button = (icon: string, title: string, action: "toggle" | "next" | "previous", big = false) =>
      h("button", { class: big ? "act-media-btn big" : "act-media-btn", title: t(title), "aria-label": t(title), onclick: control(action) },
        svg(icon, big ? 14 : 12));
    this.musicBox.append(
      h("div", { class: "act-song" },
        h("b", { class: "act-text", text: m.title || m.artist }),
        h("span", { class: "act-sub", text: [m.title ? m.artist : "", m.app].filter(Boolean).join(" · ") }),
      ),
      h("div", { class: "act-media" },
        button(ICONS.backward, ACTIVITIES_TEXT.previous, "previous"),
        button(m.playing ? ICONS.pause : ICONS.play, m.playing ? ACTIVITIES_TEXT.pause : ACTIVITIES_TEXT.play, "toggle", true),
        button(ICONS.forward, ACTIVITIES_TEXT.next, "next"),
      ),
    );
  }

  // ── Calendar ────────────────────────────────────────────────────────────────

  private drawCalendar(now: number) {
    const coming = Calendar.events.filter((e) => e.end > now).slice(0, 4);
    const key = `${language()}|${Calendar.configured}|${Calendar.error}|${Math.floor(now / 60_000)}|${coming.map((e) => `${e.start}${e.title}`).join("|")}`;
    if (key === this.keys.calendar) return;
    this.keys.calendar = key;
    clear(this.calendarBox);
    if (Calendar.error) {
      this.calendarBox.append(h("div", { class: "act-empty bad", text: Calendar.error }));
      return;
    }
    if (!Calendar.configured) {
      this.calendarBox.append(h("button", { class: "act-empty link", onclick: () => this.host.openSettings() }, t(ACTIVITIES_TEXT.noCalendar)));
      return;
    }
    if (!coming.length) {
      this.calendarBox.append(h("div", { class: "act-empty", text: t(ACTIVITIES_TEXT.nothingSoon) }));
      return;
    }
    for (const e of coming) {
      const on = !e.allDay && e.start <= now;
      this.calendarBox.append(h("div", { class: on ? "act-row event now" : "act-row event", title: e.location || e.title },
        h("span", { class: "act-when", text: e.allDay ? t(ACTIVITIES_TEXT.allDay) : eventWhen(e, now) }),
        h("span", { class: "act-text", text: e.title }),
      ));
    }
  }

  // ── Email ───────────────────────────────────────────────────────────────────

  private drawMail() {
    const info = State.integrations.integration_mail;
    const on = State.settings.activeIntegrations.includes("integration_mail") && (info?.configured ?? false);
    const list = Array.isArray(info?.data?.messages) ? (info!.data.messages as Record<string, unknown>[]) : [];
    const key = `${language()}|${on}|${info?.error}|${list.slice(0, 3).map((m) => m.id).join(",")}`;
    if (key === this.keys.mail) return;
    this.keys.mail = key;
    clear(this.mailBox);
    if (!on) {
      this.mailBox.append(h("button", { class: "act-empty link", onclick: () => this.host.openSettings() }, t(ACTIVITIES_TEXT.noEmail)));
      return;
    }
    if (info?.error) {
      this.mailBox.append(h("div", { class: "act-empty bad", text: info.error }));
      return;
    }
    if (!list.length) {
      this.mailBox.append(h("div", { class: "act-empty", text: t(ACTIVITIES_TEXT.noUnread) }));
      return;
    }
    for (const raw of list.slice(0, 3)) {
      const m: MailPeek & { body: string } = {
        id: String(raw.id ?? ""), from: String(raw.from ?? ""), address: String(raw.address ?? ""),
        subject: String(raw.subject ?? ""), preview: String(raw.preview ?? ""), body: String(raw.body ?? ""),
        link: typeof raw.link === "string" ? raw.link : undefined,
      };
      const ask = (what: "summary" | "reply") => () => {
        askAboutMail(m, what);
        this.host.openChat();
      };
      this.mailBox.append(h("div", { class: "act-mail", title: m.preview },
        h("b", { class: "act-text", text: m.from || m.address }),
        h("span", { class: "act-sub", text: m.subject }),
        h("div", { class: "act-mail-actions" },
          h("button", { class: "act-chip", onclick: ask("summary") }, t(ACTIVITIES_TEXT.summarize)),
          h("button", { class: "act-chip", onclick: ask("reply") }, t(ACTIVITIES_TEXT.reply)),
          m.link ? h("button", { class: "act-chip quiet", title: m.link, onclick: () => void Bridge.openUrl(m.link!) }, svg(ICONS.arrowUpRight, 9)) : null,
        ),
      ));
    }
  }
}
