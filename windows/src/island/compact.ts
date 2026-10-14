// The closed island's content next to Lumo (core/compact.ts picks it): one
// line saying what the AI is doing or what just happened, a timer, the music
// playing with its buttons, or a new email with what to do with it.
//
// It costs nothing while there is nothing to say: no timer runs unless a note
// is due to go, a timer counts down, or the music is asked about — and the
// music only while the closed island is on screen.

import {
  COMPACT_TEXT, Feed, LIVE_COLOR, activityLines, compactNotice, speakerName, timerLeft,
  type AgentActivityInput, type ApprovalPeek, type CompactItem, type CompactLine, type CompactShown, type MailPeek,
  type MediaActivity,
} from "../core/compact";
import { gitHubRunning, readPulse } from "../core/github";
import { LISTEN_COLOR, listeningLine } from "../core/listen";
import { byEffort } from "../core/energy";
import { Bridge, onEvent, type MailMessage, type ReminderDue } from "../core/bridge";
import { activeModel, providerDef } from "../core/providers";
import { Sound } from "../core/sound";
import { State, isSessionTask, type AgentTask } from "../core/state";
import { COMPACT_SIZES } from "../core/layout";
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

const REMINDER_TEXT = {
  reminder: N_("Reminder"),
  missed: N_("Missed reminder"),
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

const APPROVAL_TEXT = {
  needs: N_("needs permission"),
  allow: N_("Allow"),
  deny: N_("Deny"),
  open: N_("Click to see the whole request"),
};

/** Clicks this soon after a request shows are ignored: one meant for something else must not land on Allow. */
const CLICK_GUARD_MS = 600;

const MAIL_COLOR = "#EA4335";
const TIMER_COLOR = "#F5A524";
const MEDIA_COLOR = "#1DB954";
const UPLOAD_COLOR = "#34D399";
/** How often the music is asked about while the closed island shows: Settings → General → Energy sets it. */
const mediaEvery = () => byEffort(State.effort, 1000, 4000, 8000);

export interface CompactHost {
  /** The island comes out of its edge, as for any news (fsm.reveal). */
  reveal(): void;
  /** Opens the island on the chat, which asks what an email button said. */
  openChat(): void;
  /** Redraw: the size may change with what is shown. */
  changed(): void;
  /** Deny or Allow, clicked on a simple request. */
  decide(d: "allow" | "deny", requestId: string): void;
}

/** The request waiting, when it is simple enough for the closed island. */
function approvalInput(): ApprovalPeek | null {
  const req = State.pendingApproval;
  if (!req?.quick || req.questions) return null;
  const task = State.tasks.find((x) => x.id === req.pillId);
  const waiting = State.approvalQueue.length;
  const who = req.project ?? task?.name ?? req.tool;
  return { requestId: req.requestId, who: waiting ? `${who} · 1/${waiting + 1}` : who, color: task?.color ?? "#F5A524", command: req.command || req.tool };
}

/**
 * What each agent is doing: the ones waiting on the user first, then the one
 * in front, then the others at work. The pills fed by hook events count, the
 * workspace ones (VS Code, Cursor, Codex, Antigravity) as much as the agents.
 */
function agentInputs(): AgentActivityInput[] {
  const sessions = State.tasks.filter(isSessionTask);
  const waiting = (s: string) => s === "approval" || s === "question";
  const busy = (s: string) => s === "working" || s === "thinking" || s === "searching";
  const focusId = State.focusTask?.id;
  const rank = (x: AgentTask) => (waiting(x.state) ? 0 : x.id === focusId ? 1 : 2);
  return sessions
    .filter((x) => waiting(x.state) || busy(x.state))
    .map((x, i) => ({ x, i }))
    .sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i)
    .map(({ x }) => ({ name: x.name, state: x.state, step: x.steps.length ? x.steps[x.steps.length - 1] : null, color: x.color }));
}

/**
 * What the services are doing: GitHub's CI running on a PR or a default
 * branch, and the pull requests the chat listens to (core/listen.ts).
 */
function serviceLines(): CompactLine[] {
  const gitHub = State.tasks.find((x) => x.id === "integration_github");
  const info = State.integrations["integration_github"];
  const running = gitHub && info ? gitHubRunning(readPulse(info.data)) : null;
  const lines: CompactLine[] = running ? [{ text: `${gitHub!.name} · ${running}`, color: gitHub!.color }] : [];
  const listening = listeningLine(State.listening);
  if (listening) lines.push({ text: `GitHub · ${listening}`, color: gitHub?.color ?? LISTEN_COLOR });
  return lines;
}

export class CompactStrip {
  readonly el = h("div", { id: "compact" });
  private shown: CompactShown = null;
  private key = "";
  private expiry: number | null = null;
  private ticker: number | null = null;
  private mediaTimer: number | null = null;
  private mediaAsking = false;
  private mediaEvery = 0;
  /** More emails came with the one shown. */
  private extraMail = 0;
  /** The island's size for what is drawn (measure), and the one it was given. */
  private measured: { w: number; h: number } | null = null;
  private fit: { w: number; h: number } | null = null;
  /** The closed island is on screen: only then does a timer tick every second. */
  private visible = false;
  /** When the request on show came up, against clicks meant for something else. */
  private approvalAt = 0;
  /** The upload's bar and percentage, moved each frame without a redraw. */
  private uploadFill: HTMLElement | null = null;
  private uploadPct: HTMLElement | null = null;
  private uploadAt = 0;

  private host: CompactHost;

  constructor(host: CompactHost) {
    this.host = host;
    // A reminder at a time (reminders.rs) rings like a timer, and stays longer.
    void onEvent<ReminderDue>("reminder-due", (due) => {
      if (!due?.reminder) return;
      Sound.play("finish");
      compactNotice(`${t(due.missed ? REMINDER_TEXT.missed : REMINDER_TEXT.reminder)} · ${due.reminder.text}`, TIMER_COLOR, 30_000);
    });
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
  get size(): { w: number; h: number } | null {
    return this.fit;
  }

  /**
   * As wide as what it says, with Lumo's room on both sides so it stays in
   * the middle, and no wider than its kind allows.
   */
  private measure(): { w: number; h: number } | null {
    const s = this.shown;
    if (!s) return null;
    if (s.kind === "mail") return { ...COMPACT_SIZES.mail };
    if (s.kind === "approval") return { ...COMPACT_SIZES.approval };
    const most = COMPACT_SIZES[s.items.length === 1 ? "one" : s.items.length === 2 ? "two" : "many"];
    this.el.classList.add("measure");
    const natural = this.el.scrollWidth;
    this.el.classList.remove("measure");
    return { w: Math.round(Math.min(most.w, natural + 2 * SIDE_ROOM + 4)), h: most.h };
  }

  /** The simple request on show, if any. */
  get approval(): ApprovalPeek | null {
    return this.shown?.kind === "approval" ? this.shown.approval : null;
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
    for (const el of this.el.querySelectorAll(".cp-controls, .cp-close, .cp-mail-actions, .cp-approval-actions")) {
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
    const before = this.fit;
    const show = { notes: State.settings.compactActivity !== false, media: State.settings.compactMedia !== false };
    const approval = approvalInput();
    this.shown = approval ? { kind: "approval", approval } : Feed.shown(show.notes ? this.activity() : null, now, show);
    this.draw(now);
    this.fit = this.measured;
    this.schedule();
    this.pollMedia(mediaWanted && (show.media || !visible));
    return !sameSize(this.fit, before);
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
    return activityLines(chatInput, liveInput, agentInputs(), serviceLines());
  }

  private draw(now: number) {
    const s = this.shown;
    const key = s == null ? "" : s.kind === "mail" ? `mail|${s.mail.id}|${this.extraMail}`
      : s.kind === "approval" ? `approval|${s.approval.requestId}|${s.approval.command}`
      : `items|${s.items.map((i) => itemKey(i, now)).join("|")}`;
    if (key === this.key) return;
    this.key = key;
    clear(this.el);
    this.uploadFill = null;
    this.uploadPct = null;
    this.measured = null;
    const many = s?.kind === "items" && s.items.length > 1;
    this.el.className = [s ? `on ${s.kind}` : "", many ? "many" : "", this.visible ? "shown" : ""].filter(Boolean).join(" ");
    if (!s) return;
    if (s.kind === "mail") {
      this.el.append(this.mailCard(s.mail));
    } else if (s.kind === "approval") {
      this.el.append(this.approvalCard(s.approval));
    } else {
      // One alone in the middle; more side by side, each smaller.
      for (const item of s.items) this.el.append(h("div", { class: "cp-item" }, ...this.itemContent(item, now, many)));
    }
    this.measured = this.measure();
  }

  /** How far the upload on show has gone, 0 to 1 (island.ts, each frame of it). */
  progress(p: number) {
    this.uploadAt = Math.max(0, Math.min(1, p));
    if (this.uploadFill) this.uploadFill.style.width = `${this.uploadAt * 100}%`;
    if (this.uploadPct) this.uploadPct.textContent = `${Math.round(this.uploadAt * 100)} %`;
  }

  private itemContent(item: CompactItem, now: number, compact: boolean): Node[] {
    switch (item.kind) {
      case "upload": {
        const label = t("Uploading {name}", { name: item.upload.name });
        this.uploadFill = h("i", { class: "cp-upload-fill", style: `width:${this.uploadAt * 100}%` });
        this.uploadPct = h("span", { class: "cp-time cp-upload-pct", text: `${Math.round(this.uploadAt * 100)} %` });
        return [
          h("span", { class: "cp-icon", style: `color:${UPLOAD_COLOR}` }, svg(ICONS.doc, 12, { stroke: 1.8 })),
          compact ? null : h("span", { class: "cp-text", text: label, title: label }),
          h("span", { class: "cp-upload" }, this.uploadFill),
          this.uploadPct,
        ].filter((n): n is HTMLElement => n != null);
      }
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

  /**
   * A simple request: who asks and what, with Deny and Allow. Only a click on
   * one of them answers; a click anywhere else opens the full card.
   */
  private approvalCard(a: ApprovalPeek): HTMLElement {
    this.approvalAt = performance.now();
    const decide = (d: "allow" | "deny") => (e: Event) => {
      e.stopPropagation();
      if (performance.now() - this.approvalAt < CLICK_GUARD_MS) return;
      // The request this card shows, never the next one in line that took its place.
      this.host.decide(d, a.requestId);
    };
    return h("div", { class: "cp-mail cp-approval", title: t(APPROVAL_TEXT.open) },
      h("div", { class: "cp-mail-head" },
        h("i", { class: "cp-dot", style: `background:${a.color}` }),
        h("b", { class: "cp-approval-who", text: a.who }),
        h("span", { class: "cp-approval-needs", text: t(APPROVAL_TEXT.needs) }),
      ),
      h("div", { class: "cp-approval-code", text: a.command, title: a.command }),
      h("div", { class: "cp-mail-actions cp-approval-actions" },
        h("button", { class: "cp-action", onclick: decide("deny") }, t(APPROVAL_TEXT.deny)),
        h("button", { class: "cp-action allow", onclick: decide("allow") }, t(APPROVAL_TEXT.allow)),
      ),
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
    const every = mediaEvery();
    if (this.mediaTimer != null && every === this.mediaEvery) return;
    if (this.mediaTimer != null) window.clearInterval(this.mediaTimer);
    else this.askMedia();
    this.mediaEvery = every;
    this.mediaTimer = window.setInterval(() => this.askMedia(), every);
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
  // An answer still being written goes on in its own chat.
  State.startChat();
  State.droppedFile = null;
  State.promptContext = null;
  void Bridge.chatReset(State.chatId);
  State.incomingShare = { kind: "selection", selection: { text, app: t(MAIL_TEXT.email), title: m.subject } };
  State.chatAsk = question;
}

/** What an item looks like now, to redraw only when it changes. */
function itemKey(item: CompactItem, now: number): string {
  switch (item.kind) {
    case "upload":
      return `upload:${item.upload.name}`;
    case "line":
      return `line:${item.line.text}:${item.line.color}:${item.notice}`;
    case "timer":
      return `timer:${item.timer.id}:${timerLeft(item.timer.endsAt - now)}:${item.timer.label}`;
    case "media":
      return `media:${item.media.title}:${item.media.artist}:${item.media.playing}`;
  }
}

/** Lumo's room on each side of what the closed island says (#compact left and right). */
const SIDE_ROOM = 36;

/** Sizes within a pixel are the same: a timer's digits do not resize the island. */
function sameSize(a: { w: number; h: number } | null, b: { w: number; h: number } | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.w - b.w) < 2 && Math.abs(a.h - b.h) < 2;
}
