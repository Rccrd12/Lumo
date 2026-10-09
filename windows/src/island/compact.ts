// The closed island's content next to Lumo (core/compact.ts picks it): one
// line saying what the AI is doing or what just happened, a timer, the music
// playing with its buttons, or a new email with what to do with it.
//
// It costs nothing while there is nothing to say: no timer runs unless a note
// is due to go, a timer counts down, or the music is asked about — and the
// music only while the closed island is on screen.

import {
  COMPACT_TEXT, Feed, LIVE_COLOR, activityLine, compactNotice, speakerName, timerLeft,
  type AgentActivityInput, type CompactItem, type CompactShown, type MailPeek, type MediaActivity,
} from "../core/compact";
import { Bridge, type MailMessage } from "../core/bridge";
import { activeModel, providerDef } from "../core/providers";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { CompactSizeKind } from "../core/layout";
import { Live } from "../live/session";
import { clear, h, svg } from "../views/dom";
import { ICONS } from "../views/icons";
import { N_, t } from "../i18n/i18n";

const MEDIA_TEXT = {
  previous: N_("Previous"),
  next: N_("Next"),
  play: N_("Play"),
  pause: N_("Pause"),
};

const MAIL_TEXT = {
  summarize: N_("Summarize"),
  reply: N_("Draft a reply"),
  open: N_("Open"),
  dismiss: N_("Dismiss"),
  more: N_("+{count} more"),
  askSummary: N_("Summarize this email in a few lines, and say if it needs an answer or anything from me."),
  askReply: N_("Write a reply to this email, ready to paste. Only the draft: I will read it and send it myself."),
  from: N_("From: {from}"),
  subject: N_("Subject: {subject}"),
  email: N_("Email"),
  noSubject: N_("(no subject)"),
};

const MAIL_COLOR = "#EA4335";
const TIMER_COLOR = "#F5A524";
const MEDIA_COLOR = "#1DB954";
/** How often the music is asked about while the closed island shows. */
const MEDIA_EVERY_MS = 4000;

export interface CompactHost {
  /** The island comes out of its edge, as for any news (fsm.reveal). */
  reveal(): void;
  /** Opens the island on the chat, which asks what an email button said. */
  openChat(): void;
  /** Redraw: the size may change with what is shown. */
  changed(): void;
}

/** What the agents are doing: the card waiting first, then the busiest session. */
function agentInput(): AgentActivityInput | null {
  const sessions = State.tasks.filter((x) => !x.isIntegration);
  const waiting = sessions.find((x) => x.state === "approval" || x.state === "question");
  const focus = State.focusTask && !State.focusTask.isIntegration ? State.focusTask : null;
  const busy = (s: string) => s === "working" || s === "thinking" || s === "searching";
  const task = waiting ?? (focus && busy(focus.state) ? focus : sessions.find((x) => busy(x.state)));
  if (!task) return null;
  const step = task.steps.length ? task.steps[task.steps.length - 1] : null;
  return { name: task.name, state: task.state, step, color: task.color };
}

export class CompactStrip {
  readonly el = h("div", { id: "compact" });
  private shown: CompactShown = null;
  private key = "";
  private expiry: number | null = null;
  private ticker: number | null = null;
  private mediaTimer: number | null = null;
  private mediaAsking = false;
  /** More emails came with the one shown. */
  private extraMail = 0;
  /** The closed island is on screen: only then does a timer tick every second. */
  private visible = false;

  constructor(private host: CompactHost) {
    // The email stays while the mouse is on it, and a little after.
    this.el.addEventListener("mouseenter", () => {
      if (this.shown?.kind === "mail") Feed.holdMail(Infinity);
    });
    this.el.addEventListener("mouseleave", () => {
      if (this.shown?.kind !== "mail") return;
      Feed.holdMail(Date.now() + 3000);
      this.schedule();
    });
  }

  /** The size the closed island takes for what it shows, or null for the plain one. */
  get size(): CompactSizeKind | null {
    const s = this.shown;
    if (!s) return null;
    if (s.kind === "mail") return "mail";
    return s.items.length === 1 ? "one" : s.items.length === 2 ? "two" : "many";
  }

  /** The current email, for its buttons and the island's own mail list. */
  get mail(): MailPeek | null {
    return this.shown?.kind === "mail" ? this.shown.mail : null;
  }

  /**
   * Whether (x, y), in page pixels, is over one of the closed island's own
   * buttons: resting there must not open the island (Open on hover).
   */
  overControls(x: number, y: number): boolean {
    if (!this.visible) return false;
    for (const el of this.el.querySelectorAll(".cp-controls, .cp-close, .cp-mail-actions")) {
      const r = el.getBoundingClientRect();
      if (x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4) return true;
    }
    return false;
  }

  /** Works out what to show; true when the island's size has to change. */
  sync(visible: boolean, mediaWanted = visible): boolean {
    this.visible = visible;
    this.el.classList.toggle("shown", visible);
    const now = Date.now();
    for (const timer of Feed.takeRung(now)) {
      Sound.play("finish");
      compactNotice(timer.label ? `${t(COMPACT_TEXT.timerDone)} · ${timer.label}` : t(COMPACT_TEXT.timerDone), TIMER_COLOR, 8000);
    }
    const before = this.size;
    const show = { notes: State.settings.compactActivity !== false, media: State.settings.compactMedia !== false };
    this.shown = Feed.shown(show.notes ? this.activity() : null, now, show);
    this.draw(now);
    this.schedule();
    this.pollMedia(mediaWanted && (show.media || !visible));
    return this.size !== before;
  }

  private activity() {
    const chat = State.chatActivity;
    const p = providerDef(State.settings.chatProvider);
    const chatInput = chat
      ? { who: speakerName(p.id, t(p.name), activeModel(State.settings)), label: chat.label, color: p.accent }
      : null;
    const liveInput = Live.active
      ? { phase: Live.phase, doing: Live.doingDone ? null : Live.doing, color: LIVE_COLOR }
      : null;
    return activityLine(chatInput, liveInput, agentInput());
  }

  private draw(now: number) {
    const s = this.shown;
    const key = s == null ? "" : s.kind === "mail" ? `mail|${s.mail.id}|${this.extraMail}`
      : `items|${s.items.map((i) => itemKey(i, now)).join("|")}`;
    if (key === this.key) return;
    this.key = key;
    clear(this.el);
    const many = s?.kind === "items" && s.items.length > 1;
    this.el.className = [s ? `on ${s.kind}` : "", many ? "many" : "", this.visible ? "shown" : ""].filter(Boolean).join(" ");
    if (!s) return;
    if (s.kind === "mail") {
      this.el.append(this.mailCard(s.mail));
      return;
    }
    // One alone takes the whole width, centred; more share it, each smaller.
    for (const item of s.items) this.el.append(h("div", { class: "cp-item" }, ...this.itemContent(item, now, many)));
  }

  private itemContent(item: CompactItem, now: number, compact: boolean): Node[] {
    switch (item.kind) {
      case "line":
        return [
          h("i", { class: item.notice ? "cp-dot notice" : "cp-dot", style: `background:${item.line.color}` }),
          h("span", { class: "cp-text", text: item.line.text, title: item.line.text }),
        ];
      case "timer": {
        const cancel = this.button(ICONS.xmark, t(MAIL_TEXT.dismiss), () => {
          Feed.cancelTimer(item.timer.id);
          this.host.changed();
        });
        return [
          h("span", { class: "cp-icon", style: `color:${TIMER_COLOR}` }, svg(ICONS.timer, 13)),
          compact ? null : h("span", { class: "cp-text", text: item.timer.label || t(COMPACT_TEXT.timer) }),
          h("span", { class: "cp-time", text: timerLeft(item.timer.endsAt - now), title: item.timer.label }),
          h("span", { class: "cp-controls" }, cancel),
        ].filter((n): n is HTMLElement => n != null);
      }
      case "media":
        return this.mediaRow(item.media, compact);
    }
  }

  private button(icon: string, title: string, onclick: () => void, cls = "cp-btn"): HTMLElement {
    return h("button", {
      class: cls,
      title,
      "aria-label": title,
      onclick: (e: Event) => {
        e.stopPropagation();
        onclick();
      },
    }, svg(icon, 11));
  }

  private mediaRow(m: MediaActivity, compact: boolean): Node[] {
    const words = compact ? m.title || m.artist : [m.title, m.artist].filter((x) => x.trim()).join(" — ");
    const control = (action: "toggle" | "next" | "previous") => {
      void Bridge.mediaControl(action).then(() => window.setTimeout(() => this.askMedia(), 350));
      if (action === "toggle" && Feed.media) {
        Feed.media = { ...Feed.media, playing: !Feed.media.playing };
        this.host.changed();
      }
    };
    const full = [m.title, m.artist].filter((x) => x.trim()).join(" — ");
    return [
      h("i", { class: m.playing ? "cp-eq playing" : "cp-eq", style: `color:${MEDIA_COLOR}` }, h("b"), h("b"), h("b")),
      h("span", { class: "cp-text", text: words, title: m.app ? `${full} · ${m.app}` : full }),
      h("span", { class: "cp-controls" },
        compact ? null : this.button(ICONS.backward, t(MEDIA_TEXT.previous), () => control("previous")),
        this.button(m.playing ? ICONS.pause : ICONS.play, t(m.playing ? MEDIA_TEXT.pause : MEDIA_TEXT.play), () => control("toggle")),
        this.button(ICONS.forward, t(MEDIA_TEXT.next), () => control("next")),
      ),
    ];
  }

  private mailCard(m: MailPeek): HTMLElement {
    const head = h("div", { class: "cp-mail-head" },
      h("span", { class: "cp-icon", style: `color:${MAIL_COLOR}` }, svg(ICONS.envelope, 12, { stroke: 1.8 })),
      h("b", { class: "cp-mail-from", text: m.from || m.address, title: m.address }),
      this.extraMail > 0 ? h("span", { class: "cp-mail-more", text: t(MAIL_TEXT.more, { count: this.extraMail }) }) : null,
      this.button(ICONS.xmark, t(MAIL_TEXT.dismiss), () => {
        Feed.dismissMail();
        this.extraMail = 0;
        this.host.changed();
      }, "cp-close"),
    );
    const actions = h("div", { class: "cp-mail-actions" },
      h("button", { class: "cp-action", onclick: (e: Event) => this.ask(e, m, MAIL_TEXT.askSummary) }, t(MAIL_TEXT.summarize)),
      h("button", { class: "cp-action", onclick: (e: Event) => this.ask(e, m, MAIL_TEXT.askReply) }, t(MAIL_TEXT.reply)),
      m.link
        ? h("button", {
          class: "cp-action quiet",
          onclick: (e: Event) => {
            e.stopPropagation();
            void Bridge.openUrl(m.link!);
            Feed.dismissMail();
            this.host.changed();
          },
        }, t(MAIL_TEXT.open), svg(ICONS.arrowUpRight, 10))
        : null,
    );
    return h("div", { class: "cp-mail" },
      head,
      h("div", { class: "cp-mail-subject", text: m.subject || t(MAIL_TEXT.noSubject) }),
      h("div", { class: "cp-mail-preview", text: m.preview }),
      actions,
    );
  }

  /** An email's button: the chat opens with the email attached and asks. */
  private ask(e: Event, m: MailPeek, question: string) {
    e.stopPropagation();
    openMailInChat(m, t(question));
    Feed.dismissMail();
    this.extraMail = 0;
    this.host.openChat();
  }

  /** New emails from the poller: the newest one shows, with how many came with it. */
  newMail(messages: MailMessage[]) {
    if (State.paused || !messages.length) return;
    if (!Feed.showMail(messages[0], Date.now())) return;
    this.extraMail = messages.length - 1;
    Sound.play("pop");
    this.host.reveal();
    this.host.changed();
  }

  /** Wakes the island when a note or the email is due to go, or a timer to tick. */
  private schedule() {
    const now = Date.now();
    const next = Feed.nextChange(now);
    const ticking = this.visible && this.shown?.kind === "items" && this.shown.items.some((i) => i.kind === "timer");
    const due = ticking ? Math.min(next ?? Infinity, now + 1000 - (now % 1000) + 5) : next;
    if (due == null || !Number.isFinite(due)) {
      if (this.expiry != null) window.clearTimeout(this.expiry);
      this.expiry = null;
      this.ticker = null;
      return;
    }
    if (this.expiry != null && this.ticker === due) return;
    if (this.expiry != null) window.clearTimeout(this.expiry);
    this.ticker = due;
    this.expiry = window.setTimeout(() => {
      this.expiry = null;
      this.ticker = null;
      this.host.changed();
    }, Math.max(16, due - now));
  }

  /** Asks what is playing every few seconds, only while the closed island is on screen. */
  private pollMedia(visible: boolean) {
    if (!visible || State.paused) {
      if (this.mediaTimer != null) window.clearInterval(this.mediaTimer);
      this.mediaTimer = null;
      if (!visible && Feed.media && State.paused) Feed.media = null;
      return;
    }
    if (this.mediaTimer != null) return;
    this.askMedia();
    this.mediaTimer = window.setInterval(() => this.askMedia(), MEDIA_EVERY_MS);
  }

  private askMedia() {
    if (this.mediaAsking) return;
    this.mediaAsking = true;
    void Bridge.mediaNow()
      .then((now) => {
        const next = now && (now.title || now.artist) ? now : null;
        if (JSON.stringify(next) === JSON.stringify(Feed.media)) return;
        Feed.media = next;
        this.host.changed();
      })
      .finally(() => {
        this.mediaAsking = false;
      });
  }
}

/** The chat summarizes the email, or drafts a reply to it (the pill's card, the closed island). */
export function askAboutMail(m: MailPeek & { body?: string }, what: "summary" | "reply") {
  openMailInChat(m, t(what === "summary" ? MAIL_TEXT.askSummary : MAIL_TEXT.askReply));
}

/** The chat, with the email attached as text, asks `question` at once. */
export function openMailInChat(m: MailPeek & { body?: string }, question: string) {
  const text = [
    t(MAIL_TEXT.from, { from: m.address && m.address !== m.from ? `${m.from} <${m.address}>` : m.from }),
    t(MAIL_TEXT.subject, { subject: m.subject || t(MAIL_TEXT.noSubject) }),
    "",
    m.body || m.preview,
  ].join("\n");
  // Not while an answer is on its way: it would land in the new chat.
  if (State.chatActivity == null) {
    State.startChat();
    State.droppedFile = null;
    State.promptContext = null;
    void Bridge.chatReset();
  }
  State.incomingShare = { kind: "selection", selection: { text, app: t(MAIL_TEXT.email), title: m.subject } };
  State.chatAsk = question;
}

/** What an item looks like now, to redraw only when it changes. */
function itemKey(item: CompactItem, now: number): string {
  switch (item.kind) {
    case "line":
      return `line:${item.line.text}:${item.line.color}:${item.notice}`;
    case "timer":
      return `timer:${item.timer.id}:${timerLeft(item.timer.endsAt - now)}:${item.timer.label}`;
    case "media":
      return `media:${item.media.title}:${item.media.artist}:${item.media.playing}`;
  }
}
