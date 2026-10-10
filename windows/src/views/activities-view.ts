// The live activities' panel, drawn (island/activities.ts holds what it
// shows). The same view is beside the island in its page and alone in the
// live activities' own window (activities.html): it draws an
// `ActivitiesData` and says what was clicked with an `ActivitiesAction`.

import "./activities.css";
import type { CalEvent } from "../core/calendar";
import { parseDuration, timerLeft, type MailPeek, type MediaActivity, type TimerActivity } from "../core/compact";
import { Sound } from "../core/sound";
import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";
import { N_, language, t, tl } from "../i18n/i18n";

export const ACTIVITIES_TEXT = {
  title: N_("Live Activities"),
  fold: N_("Minimize"),
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
  ignore: N_("Ignore"),
  openMail: N_("Open this email"),
  today: N_("Today"),
  tomorrow: N_("Tomorrow"),
  allDay: N_("All day"),
  previous: N_("Previous"),
  next: N_("Next"),
  play: N_("Play"),
  pause: N_("Pause"),
};

/** The panel's width by default and its gap from the island (activities.rs). */
export const ACTIVITIES_W = 264;
export const ACTIVITIES_GAP = 12;
/** Its height beside the island when none was picked, if the window has room. */
export const ACTIVITIES_TALL = 400;
/** Minutes offered as one-click timers. */
const QUICK_TIMERS = [1, 5, 10, 25];
/** Emails shown at once; ignoring one brings the next up. */
const MAIL_ROWS = 3;
const DAY = 86_400_000;
/** How far a press on the top bar travels before it picks the panel up. */
const DRAG_THRESHOLD = 4;

// ── What the view shows, and what it asks for ────────────────────────────────

export interface MailRow extends MailPeek {
  body: string;
}

export interface ActivitiesData {
  lang: string;
  timers: TimerActivity[];
  media: MediaActivity | null;
  calendar: { configured: boolean; error: string | null; events: CalEvent[] };
  mail: { on: boolean; error: string | null; messages: MailRow[] };
}

export type ActivitiesAction =
  | { kind: "timer"; ms: number; label: string }
  | { kind: "cancelTimer"; id: number }
  | { kind: "media"; action: "toggle" | "next" | "previous" }
  | { kind: "mail"; id: string; what: "summary" | "reply" | "ignore" | "open" }
  | { kind: "settings" }
  | { kind: "fold" };

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

// ── The view ─────────────────────────────────────────────────────────────────

export interface ViewHooks {
  act(a: ActivitiesAction): void;
  /** The top bar was pressed and the mouse moved: pick it up. */
  drag(): void;
  /** A grip was pressed: `fx` / `fy` how width and height follow the mouse. */
  resize(fx: number, fy: number): void;
  /** The field wants the keyboard. */
  focus(): void;
  /** Where the folded icon is, in page pixels, if on this page. */
  iconPoint(): { x: number; y: number } | null;
  /** It can be moved and resized (the cursor poll, Windows). */
  movable: boolean;
}

/** The panel's DOM: draws an `ActivitiesData`, and says what was clicked. */
export class ActivitiesView {
  readonly el: HTMLElement;
  private timerList = h("div", { class: "act-rows" });
  private musicBox = h("div", { class: "act-rows" });
  private calendarBox = h("div", { class: "act-rows" });
  private mailBox = h("div", { class: "act-rows" });
  private timerInput: HTMLInputElement;
  private keys = { timer: "", music: "", calendar: "", mail: "" };
  private data: ActivitiesData | null = null;
  private tick: number | null = null;
  private folding = false;
  private grips: HTMLElement[] = [];

  private hooks: ViewHooks;
  private side: () => "left" | "right" | "free";

  constructor(hooks: ViewHooks, side: () => "left" | "right" | "free") {
    this.hooks = hooks;
    this.side = side;
    this.timerInput = h("input", {
      class: "act-input", type: "text", spellcheck: "false", autocomplete: "off",
      placeholder: tl(ACTIVITIES_TEXT.timerHint),
    }) as HTMLInputElement;
    this.timerInput.addEventListener("mousedown", () => this.hooks.focus());
    this.timerInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.startTyped();
      }
    });
    const quick = h("div", { class: "act-chips" },
      ...QUICK_TIMERS.map((m) => h("button", { class: "act-chip", onclick: () => this.act({ kind: "timer", ms: m * 60_000, label: "" }) }, `${m}m`)),
    );
    const form = h("div", { class: "act-form" }, this.timerInput,
      h("button", { class: "act-chip go", onclick: () => this.startTyped() }, tl(ACTIVITIES_TEXT.start)));
    const body = h("div", { class: "act-body" },
      this.section(ICONS.timer, ACTIVITIES_TEXT.timer, "#F5A524", undefined, this.timerList, quick, form),
      this.section(ICONS.play, ACTIVITIES_TEXT.music, "#1DB954", undefined, this.musicBox),
      this.section(ICONS.clock, ACTIVITIES_TEXT.calendar, "#4285F4", 1.8, this.calendarBox),
      this.section(ICONS.envelope, ACTIVITIES_TEXT.email, "#EA4335", 1.8, this.mailBox),
    );
    const fold = h("button", {
      class: "act-fold", title: tl(ACTIVITIES_TEXT.fold), "aria-label": tl(ACTIVITIES_TEXT.fold),
      onclick: () => this.fold(),
    }, h("i"));
    // Their name, the same in every language (the island page builds this
    // before it knows the language: tl() relabels the rest when it does).
    const head = h("div", { class: "act-head" }, h("span", { class: "act-title", text: ACTIVITIES_TEXT.title }), fold);
    this.el = h("div", { class: "activities" }, head, body);
    this.wireDrag(head);
    if (hooks.movable) {
      for (const [cls, fx, fy] of [["e-left", -1, 0], ["e-right", 1, 0], ["e-bottom", 0, 1], ["c-bl", -1, 1], ["c-br", 1, 1]] as const) {
        const grip = h("div", { class: `act-grip ${cls}` });
        grip.dataset.fx = String(fx);
        grip.addEventListener("mousedown", (e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.stopPropagation();
          this.hooks.resize(fx, fy);
        });
        this.grips.push(grip);
        this.el.append(grip);
      }
    }
  }

  private section(icon: string, title: string, color: string, stroke: number | undefined, ...content: HTMLElement[]): HTMLElement {
    return h("section", { class: "act-card" },
      h("div", { class: "act-card-head" },
        h("span", { class: "act-icon", style: `color:${color}` }, svg(icon, 12, stroke ? { stroke } : {})),
        h("span", { text: tl(title) })),
      ...content,
    );
  }

  private act(a: ActivitiesAction) {
    this.hooks.act(a);
  }

  /** The top bar, pressed and moved past a few pixels, picks the panel up. */
  private wireDrag(head: HTMLElement) {
    if (!this.hooks.movable) return;
    head.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || (e.target as Element).closest("button")) return;
      const start = { x: e.screenX, y: e.screenY };
      const move = (m: MouseEvent) => {
        if (Math.hypot(m.screenX - start.x, m.screenY - start.y) <= DRAG_THRESHOLD) return;
        stop();
        this.hooks.drag();
      };
      const stop = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", stop);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", stop);
    });
  }

  /** Draws what changed; cheap when nothing did. */
  render(data: ActivitiesData, now = Date.now()) {
    this.data = data;
    // Only the grips on its free sides: beside the island, not the one facing it.
    const side = this.side();
    for (const g of this.grips) {
      const fx = Number(g.dataset.fx);
      g.style.display = (side === "left" && fx > 0) || (side === "right" && fx < 0) ? "none" : "";
    }
    this.drawTimers(data.timers, now);
    this.drawMusic(data.media);
    this.drawCalendar(data.calendar, now);
    this.drawMail(data.mail);
    this.syncTick();
  }

  /** Stops its second-by-second redraw (hidden). */
  stop() {
    if (this.tick != null) window.clearInterval(this.tick);
    this.tick = null;
  }

  // ── Folding ─────────────────────────────────────────────────────────────────

  /**
   * "–": it flies into its icon next to the "+" (or, in its own window,
   * shrinks into its top corner), then says so. Only transform and opacity
   * move, on a layer of its own, so it stays smooth.
   */
  private fold() {
    if (this.folding) return;
    this.folding = true;
    Sound.play("close");
    const target = this.hooks.iconPoint();
    const r = this.el.getBoundingClientRect();
    const dx = target ? target.x - (r.left + r.width / 2) : r.width / 2 - 20;
    const dy = target ? target.y - (r.top + r.height / 2) : -r.height / 2 + 20;
    this.el.classList.add("folding");
    requestAnimationFrame(() => {
      this.el.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(0.06)`;
      this.el.style.opacity = "0";
    });
    window.setTimeout(() => {
      // Stays out of sight until it is shown again (reveal, flyIn).
      this.el.classList.add("gone");
      this.act({ kind: "fold" });
      this.unfoldInstantly();
      this.folding = false;
    }, 440);
  }

  /** Back to its place with no animation (it is hidden by now). */
  private unfoldInstantly() {
    this.el.classList.add("instant");
    this.el.classList.remove("folding");
    this.el.style.transform = "";
    this.el.style.opacity = "";
    void this.el.offsetWidth;
    this.el.classList.remove("instant");
  }

  /** Shown again without a flight. */
  reveal() {
    this.el.classList.remove("gone");
  }

  /** Comes out of the icon (or its corner) to its place. */
  flyIn() {
    this.el.classList.remove("gone");
    const target = this.hooks.iconPoint();
    const r = this.el.getBoundingClientRect();
    const dx = target ? target.x - (r.left + r.width / 2) : r.width / 2 - 20;
    const dy = target ? target.y - (r.top + r.height / 2) : -r.height / 2 + 20;
    this.el.classList.add("instant");
    this.el.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(0.06)`;
    this.el.style.opacity = "0";
    void this.el.offsetWidth;
    this.el.classList.remove("instant");
    requestAnimationFrame(() => {
      this.el.style.transform = "";
      this.el.style.opacity = "";
    });
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
    this.act({ kind: "timer", ms, label: m[2] });
  }

  private drawTimers(timers: TimerActivity[], now: number) {
    const key = timers.map((x) => `${x.id}:${timerLeft(x.endsAt - now)}:${x.label}`).join("|");
    if (key === this.keys.timer) return;
    this.keys.timer = key;
    clear(this.timerList);
    for (const timer of timers) {
      const left = Math.max(0, timer.endsAt - now);
      const bar = h("i", { class: "act-progress" });
      bar.style.width = `${Math.min(100, (1 - left / timer.total) * 100)}%`;
      this.timerList.append(h("div", { class: "act-row timer" },
        h("span", { class: "act-time", text: timerLeft(left) }),
        h("span", { class: "act-text", text: timer.label || t(ACTIVITIES_TEXT.timer) }),
        h("button", {
          class: "act-x", title: t(ACTIVITIES_TEXT.cancel), "aria-label": t(ACTIVITIES_TEXT.cancel),
          onclick: () => this.act({ kind: "cancelTimer", id: timer.id }),
        }, svg(ICONS.xmark, 10)),
        bar,
      ));
    }
  }

  /** Every second while a timer runs; never otherwise. */
  private syncTick() {
    const want = (this.data?.timers.length ?? 0) > 0;
    if (want && this.tick == null) {
      this.tick = window.setInterval(() => {
        if (this.data) this.drawTimers(this.data.timers, Date.now());
      }, 1000);
    }
    if (!want) this.stop();
  }

  // ── Music ───────────────────────────────────────────────────────────────────

  private drawMusic(m: MediaActivity | null) {
    const key = m ? `${m.title}|${m.artist}|${m.app}|${m.playing}` : "none";
    if (key === this.keys.music) return;
    this.keys.music = key;
    clear(this.musicBox);
    if (!m) {
      this.musicBox.append(h("div", { class: "act-empty", text: t(ACTIVITIES_TEXT.nothingPlaying) }));
      return;
    }
    const button = (icon: string, title: string, action: "toggle" | "next" | "previous", big = false) =>
      h("button", {
        class: big ? "act-media-btn big" : "act-media-btn", title: t(title), "aria-label": t(title),
        onclick: () => this.act({ kind: "media", action }),
      }, svg(icon, big ? 14 : 12));
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

  private drawCalendar(cal: ActivitiesData["calendar"], now: number) {
    const coming = cal.events.filter((e) => e.end > now).slice(0, 4);
    const key = `${language()}|${cal.configured}|${cal.error}|${Math.floor(now / 60_000)}|${coming.map((e) => `${e.start}${e.title}`).join("|")}`;
    if (key === this.keys.calendar) return;
    this.keys.calendar = key;
    clear(this.calendarBox);
    if (cal.error) {
      this.calendarBox.append(h("div", { class: "act-empty bad", text: cal.error }));
      return;
    }
    if (!cal.configured) {
      this.calendarBox.append(h("button", { class: "act-empty link", onclick: () => this.act({ kind: "settings" }) }, t(ACTIVITIES_TEXT.noCalendar)));
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

  private drawMail(mail: ActivitiesData["mail"]) {
    const rows = mail.messages.slice(0, MAIL_ROWS);
    const key = `${language()}|${mail.on}|${mail.error}|${rows.map((m) => m.id).join(",")}`;
    if (key === this.keys.mail) return;
    this.keys.mail = key;
    clear(this.mailBox);
    if (!mail.on) {
      this.mailBox.append(h("button", { class: "act-empty link", onclick: () => this.act({ kind: "settings" }) }, t(ACTIVITIES_TEXT.noEmail)));
      return;
    }
    if (mail.error) {
      this.mailBox.append(h("div", { class: "act-empty bad", text: mail.error }));
      return;
    }
    if (!rows.length) {
      this.mailBox.append(h("div", { class: "act-empty", text: t(ACTIVITIES_TEXT.noUnread) }));
      return;
    }
    for (const m of rows) {
      const ask = (what: "summary" | "reply" | "ignore") => (e: Event) => {
        e.stopPropagation();
        this.act({ kind: "mail", id: m.id, what });
      };
      // A click on the email itself (not a button) opens it.
      const box = h("div", {
        class: m.link ? "act-mail link" : "act-mail",
        title: m.link ? t(ACTIVITIES_TEXT.openMail) : m.preview,
        onclick: () => {
          if (m.link) this.act({ kind: "mail", id: m.id, what: "open" });
        },
      },
        // The eye sits by the sender, so the two buttons below have the row to themselves.
        h("div", { class: "act-mail-head" },
          h("b", { class: "act-text", text: m.from || m.address, title: m.address }),
          h("button", {
            class: "act-chip quiet eye", title: t(ACTIVITIES_TEXT.ignore), "aria-label": t(ACTIVITIES_TEXT.ignore),
            onclick: ask("ignore"),
          }, svg(ICONS.eye, 12, { stroke: 1.8 })),
        ),
        h("span", { class: "act-sub", text: m.subject }),
        h("div", { class: "act-mail-actions" },
          h("button", { class: "act-chip", title: t(ACTIVITIES_TEXT.summarize), onclick: ask("summary") }, t(ACTIVITIES_TEXT.summarize)),
          h("button", { class: "act-chip", title: t(ACTIVITIES_TEXT.reply), onclick: ask("reply") }, t(ACTIVITIES_TEXT.reply)),
        ),
      );
      this.mailBox.append(box);
    }
  }
}

