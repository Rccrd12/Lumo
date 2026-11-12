// The Email view: what a click on the home's Email tile opens. One button
// per address at the top (All, then each IMAP account, then Outlook on this
// PC), each with how many are unread or a "!" when it can't be read; Unread
// or Recent; the emails of the button picked, newest first. A click on one
// reads it here, with Summarize and Draft a reply as on the email's card and
// a button that opens it where it lives (its webmail, Outlook). Under the list
// of one address, a button opens its inbox.
//
// What it lists comes from mail.rs (mail_view): each account asked on a short
// connection of its own, never marking anything read. Asked when the view
// opens, when Unread/Recent changes, and again when the island's own watch
// sees the inbox change while it is open; nothing while it is closed.
// The sorting, labels and colours are core/mail-view.ts.

import { h, svg, dot, clear, gentleWheel } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { askAboutMail } from "../island/compact";
import {
  ALL, accountColor, accountLabel, avatarColor, initials, keptFilter, mailWhen, neighbours, readMailView,
  totalUnread, visibleMessages, type MailFilter, type MailViewData, type MailViewMessage,
} from "../core/mail-view";
import type { ViewActions, ViewHost } from "./views";
import { N_, language, t, tl } from "../i18n/i18n";

export const MAIL_VIEW_TEXT = {
  title: N_("Email"),
  unreadCount: N_("{n} unread"),
  all: N_("All"),
  unread: N_("Unread"),
  recent: N_("Recent"),
  loading: N_("Loading…"),
  noUnread: N_("No unread email"),
  nothing: N_("Nothing here"),
  cantRead: N_("{address} can't be read"),
  settings: N_("Settings"),
  back: N_("Back"),
  newer: N_("Previous"),
  older: N_("Next"),
  to: N_("to {address}"),
  yesterday: N_("Yesterday"),
  summarize: N_("Summarize"),
  reply: N_("Draft a reply"),
  openBrowser: N_("Open in the browser"),
  openOutlook: N_("Open in Outlook"),
  openInbox: N_("Open the inbox"),
  noSubject: N_("(no subject)"),
};

/** How long what was listed stands before opening the view asks again. */
const FRESH_MS = 60_000;

/** "Open in Outlook" for Outlook's own links, "Open in the browser" for a webmail's. */
function openWord(link: string): string {
  return link.startsWith("lumo-outlook:") ? t(MAIL_VIEW_TEXT.openOutlook) : t(MAIL_VIEW_TEXT.openBrowser);
}

export function buildMailView(actions: ViewActions): ViewHost {
  let data: MailViewData | null = null;
  let unreadOnly = true;
  let filter: MailFilter = ALL;
  /** The email read, by its id; null on the list. */
  let openId: string | null = null;
  let loading = false;
  let loadedAt = 0;
  /** Bumped by each ask: an older answer that comes late is dropped. */
  let asked = 0;
  /** What the island's watch said last (the inbox's unread), to ask again when it changes. */
  let watchKey = "";
  /** The view was on screen at the last sync: opening it again may ask again. */
  let wasShown = false;
  let drawn = "";

  const count = h("span", { class: "mv-count" });
  const segUnread = h("button", { class: "mv-seg-btn", onclick: () => setUnreadOnly(true) });
  const segRecent = h("button", { class: "mv-seg-btn", onclick: () => setUnreadOnly(false) });
  const head = h("div", { class: "mv-head" },
    h("span", { class: "mv-icon" }, svg(ICONS.envelope, 14, { stroke: 1.8 })),
    h("span", { class: "mv-title", text: tl(MAIL_VIEW_TEXT.title) }),
    count,
    h("span", { class: "mv-space" }),
    h("span", { class: "mv-seg" }, segUnread, segRecent));
  const chips = h("div", { class: "mv-chips" });
  // A wheel over the buttons moves them sideways.
  chips.addEventListener("wheel", (e) => {
    if (chips.scrollWidth <= chips.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    chips.scrollLeft += e.deltaY;
  }, { passive: false });
  const list = h("div", { class: "mv-list" });
  gentleWheel(list);
  const reader = h("div", { class: "mv-reader" });
  gentleWheel(reader);
  const foot = h("div", { class: "mv-foot" });
  const body = h("div", { class: "mv-body" }, head, chips, list, reader, foot);
  const el = h("div", { class: "view mail-view" }, h("div", { class: "card mail-card" }, body));

  // Its sync runs only while it is on screen: leaving is seen here.
  State.subscribe(() => {
    if (State.view !== "mail" || State.mode !== "expanded") wasShown = false;
  });

  // Escape goes back from an email to the list before it closes the island.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || openId == null || State.view !== "mail" || State.mode !== "expanded") return;
    e.stopImmediatePropagation();
    back();
  }, true);

  async function load() {
    const ticket = ++asked;
    loading = true;
    drawn = "";
    State.notify();
    const raw = await Bridge.mailView(unreadOnly);
    if (ticket !== asked) return;
    loading = false;
    loadedAt = Date.now();
    // Outside Lumo (a plain browser) there is no answer: an empty view, not a spinner forever.
    data = readMailView(raw);
    filter = keptFilter(data, filter);
    if (openId && !data.messages.some((m) => m.id === openId)) openId = null;
    drawn = "";
    State.notify();
  }

  function setUnreadOnly(on: boolean) {
    if (on === unreadOnly) return;
    actions.blip();
    unreadOnly = on;
    openId = null;
    void load();
  }

  function pick(key: MailFilter) {
    if (key === filter) return;
    actions.blip();
    filter = key;
    openId = null;
    list.scrollTop = 0;
    drawn = "";
    State.notify();
  }

  function open(id: string) {
    actions.blip();
    openId = id;
    reader.scrollTop = 0;
    drawn = "";
    State.notify();
  }

  function back() {
    actions.blip();
    openId = null;
    drawn = "";
    State.notify();
  }

  function chip(key: MailFilter, label: string, color: string | null, tail: Node | string, title?: string): HTMLElement {
    const btn = h("button", { class: key === filter ? "mv-chip on" : "mv-chip", onclick: () => pick(key) },
      color ? dot(color, 7) : null,
      h("span", { class: "mv-chip-label", text: label }),
      typeof tail === "string" ? h("b", { text: tail }) : tail);
    if (title) btn.title = title;
    return btn;
  }

  function avatar(m: MailViewMessage, withAccount: boolean): HTMLElement {
    const el = h("span", { class: "mv-avatar", text: initials(m.from, m.address) });
    el.style.background = avatarColor(m.address || m.from);
    if (withAccount && data) el.append(h("i", { class: "mv-avatar-acc", style: `background:${accountColor(data, m.account)}` }));
    return el;
  }

  function row(m: MailViewMessage, withAccount: boolean): HTMLElement {
    const subject = m.subject || t(MAIL_VIEW_TEXT.noSubject);
    return h("button", { class: m.unread ? "mv-row unread" : "mv-row", onclick: () => open(m.id) },
      h("i", { class: "mv-unread" }),
      avatar(m, withAccount),
      h("span", { class: "mv-row-text" },
        h("span", { class: "mv-row-top" },
          h("span", { class: "mv-from", text: m.from || m.address }),
          h("span", { class: "mv-when", text: mailWhen(m.date, Date.now(), language(), t(MAIL_VIEW_TEXT.yesterday)) })),
        h("span", { class: "mv-row-sub" },
          h("span", { class: "mv-subject", text: subject }),
          m.preview ? h("span", { class: "mv-preview", text: ` · ${m.preview}` }) : null)));
  }

  function drawList(d: MailViewData) {
    clear(list);
    const failing = d.accounts.filter((a) => a.state === "error" && (filter === ALL || a.key === filter));
    for (const a of failing) {
      list.append(h("div", { class: "mv-banner" },
        h("span", { class: "mv-banner-text" },
          h("b", { text: t(MAIL_VIEW_TEXT.cantRead, { address: a.label }) }),
          h("span", { text: a.error ?? "" })),
        h("button", { class: "mv-btn", onclick: () => actions.openSettingsWindow() }, t(MAIL_VIEW_TEXT.settings))));
    }
    const shown = visibleMessages(d, filter);
    if (!shown.length && !failing.length) {
      list.append(h("div", { class: "mv-empty" },
        h("span", { class: "mv-empty-eyes" }, h("i"), h("i")),
        h("span", { text: unreadOnly ? t(MAIL_VIEW_TEXT.noUnread) : t(MAIL_VIEW_TEXT.nothing) })));
    }
    for (const m of shown) list.append(row(m, filter === ALL && d.accounts.length > 1));
  }

  function drawReader(d: MailViewData, m: MailViewMessage) {
    clear(reader);
    const near = neighbours(visibleMessages(d, filter), m.id);
    const account = d.accounts.find((a) => a.key === m.account);
    const step = (id: string | null, icon: string, label: string) => {
      const b = h("button", { class: "mv-step", title: t(label), "aria-label": t(label) }, svg(icon, 10, { stroke: 2.4 }));
      if (id) b.addEventListener("click", () => open(id));
      else b.disabled = true;
      return b;
    };
    const ask = (what: "summary" | "reply") => () => {
      actions.blip();
      askAboutMail({ id: m.id, from: m.from, address: m.address, subject: m.subject, preview: m.preview, body: m.body }, what);
      actions.setView("prompt");
    };
    const when = mailWhen(m.date, Date.now(), language(), t(MAIL_VIEW_TEXT.yesterday));
    reader.append(
      h("div", { class: "mv-read-top" },
        h("button", { class: "mv-back", onclick: back }, svg(ICONS.chevronLeft, 9, { stroke: 2.6 }), h("span", { text: t(MAIL_VIEW_TEXT.back) })),
        h("span", { class: "mv-space" }),
        step(near.newer, ICONS.chevronLeft, MAIL_VIEW_TEXT.newer),
        step(near.older, ICONS.chevronRight, MAIL_VIEW_TEXT.older)),
      h("div", { class: "mv-read-head" },
        avatar(m, false),
        h("span", { class: "mv-read-who" },
          h("span", { class: "mv-read-from", text: m.from || m.address }),
          h("span", { class: "mv-read-meta" },
            m.address && m.address !== m.from ? h("span", { text: m.address }) : null,
            account && d.accounts.length > 1
              ? h("span", { class: "mv-read-acc" }, dot(accountColor(d, account.key), 6), h("span", { text: t(MAIL_VIEW_TEXT.to, { address: account.label }) }))
              : null,
            when ? h("span", { text: when }) : null))),
      h("div", { class: "mv-read-subject", text: m.subject || t(MAIL_VIEW_TEXT.noSubject) }),
      h("div", { class: "mv-read-body", text: (m.body || m.preview).trim() }),
      h("div", { class: "mv-read-actions" },
        h("button", { class: "mv-btn", onclick: ask("summary") }, t(MAIL_VIEW_TEXT.summarize)),
        h("button", { class: "mv-btn", onclick: ask("reply") }, t(MAIL_VIEW_TEXT.reply)),
        h("span", { class: "mv-space" }),
        m.link
          ? h("button", { class: "mv-btn ghost", onclick: () => void Bridge.openUrl(m.link!) }, h("span", { text: openWord(m.link) }), svg(ICONS.arrowUpRight, 12))
          : null));
  }

  function drawFoot(d: MailViewData) {
    clear(foot);
    // One address alone has no buttons: its inbox is always the one.
    const account = filter === ALL ? (d.accounts.length === 1 ? d.accounts[0] : null) : d.accounts.find((a) => a.key === filter);
    if (!account?.inbox || openId) return;
    const inbox = account.inbox;
    foot.append(
      h("span", { class: "mv-foot-label", text: account.label }),
      h("span", { class: "mv-space" }),
      h("button", { class: "mv-btn", onclick: () => void Bridge.openUrl(inbox) },
        h("span", { text: inbox.startsWith("lumo-outlook:") ? t(MAIL_VIEW_TEXT.openOutlook) : t(MAIL_VIEW_TEXT.openInbox) }),
        svg(ICONS.arrowUpRight, 12)));
  }

  function draw() {
    const d = data;
    // The count says the button picked: All's, or its address's.
    const unread = !d ? 0 : filter === ALL ? totalUnread(d) : (d.accounts.find((a) => a.key === filter)?.unread ?? 0);
    count.textContent = d ? t(MAIL_VIEW_TEXT.unreadCount, { n: unread }) : "";
    segUnread.textContent = t(MAIL_VIEW_TEXT.unread);
    segRecent.textContent = t(MAIL_VIEW_TEXT.recent);
    segUnread.classList.toggle("on", unreadOnly);
    segRecent.classList.toggle("on", !unreadOnly);

    clear(chips);
    if (d && d.accounts.length > 1) {
      chips.append(chip(ALL, t(MAIL_VIEW_TEXT.all), null, String(totalUnread(d))));
      for (const a of d.accounts) {
        const tail = a.state === "error" ? h("b", { class: "mv-warn", text: "!" }) : String(a.unread);
        chips.append(chip(a.key, accountLabel(d, a), accountColor(d, a.key), tail, a.label));
      }
    }
    chips.style.display = d && d.accounts.length > 1 ? "" : "none";

    const m = d && openId ? d.messages.find((x) => x.id === openId) ?? null : null;
    body.classList.toggle("reading", m != null);
    if (!d) {
      clear(list);
      list.append(h("div", { class: "mv-empty" }, h("span", { text: t(MAIL_VIEW_TEXT.loading) })));
      clear(foot);
      return;
    }
    if (m) drawReader(d, m);
    else drawList(d);
    drawFoot(d);
  }

  return {
    el,
    sync() {
      const shown = State.view === "mail" && State.mode === "expanded";
      const opening = shown && !wasShown;
      wasShown = shown;
      if (!shown) return;
      // Opened after a while, or the island's watch saw the inbox change
      // meanwhile (an email came, one was read): asked again.
      const info = State.integrations.integration_mail;
      const key = JSON.stringify([info?.data?.unread ?? null, Array.isArray(info?.data?.messages) ? (info!.data.messages as { id?: unknown }[]).map((x) => x.id) : null]);
      const stale = opening && Date.now() - loadedAt > FRESH_MS;
      if (!loading && (data == null || stale || key !== watchKey)) {
        watchKey = key;
        void load();
      }
      const now = [language(), filter, unreadOnly, openId, loading, loadedAt, data?.messages.length ?? -1].join("~");
      if (now === drawn) return;
      drawn = now;
      draw();
    },
  };
}
