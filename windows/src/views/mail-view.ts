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
//
// An email with HTML is shown as its sender drew it (Original), or as its
// text (Text only), the choice kept while Lumo runs. The HTML (mail.rs
// mail_html) is asked when the email opens, and shown in a frame with no
// scripts, forms or plug-ins, on a white page shrunk to fit; its links open in
// the browser by a click, the corner saying where each goes. The images it
// links to are hidden (the island's CSP would keep them out anyway): Load
// images downloads them through web_image.rs, as the chat's Load image does,
// and Settings → Security → Images from the web off leaves them hidden. The
// rules are core/mail-html.ts.

import { h, svg, dot, clear, gentleWheel } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { askAboutMail } from "../island/compact";
import { loadClickedImage, webImagesOn } from "./rich/image";
import {
  DROPPED_TAGS, EMAIL_FRAME_STYLE, droppedAttribute, fitZoom, hiddenBox, imagesToLoad, linkParts, opensInBrowser, webImageUrl,
} from "../core/mail-html";
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
  original: N_("Original"),
  textOnly: N_("Text only"),
  imagesHidden: N_("Images hidden: the sender can't tell you opened it"),
  imagesOff: N_("Images from the web are off in Settings"),
  loadImages: N_("Load images"),
};

/** The HTML of the emails read lately, by id ("" for one with none); the oldest goes past MAX_HTML. */
const htmlOf = new Map<string, string>();
const MAX_HTML = 12;
/** The emails whose HTML is being asked for. */
const htmlAsked = new Set<string>();
/** Text only (true) or Original, as last picked, while Lumo runs. */
let textOnly = false;
/** The emails whose images the user loaded, this session. */
const imagesLoaded = new Set<string>();
/** A 1×1 transparent GIF: what a hidden image shows in place of its own. */
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/**
 * The email's HTML as the frame shows it: what runs, loads or goes somewhere
 * taken out, its web images hidden (their address kept in data-lumo-src),
 * the frame's own style first. The web images' addresses, in order.
 */
function frameDocument(html: string): { doc: string; images: string[] } {
  const page = new DOMParser().parseFromString(html, "text/html");
  for (const tag of DROPPED_TAGS) for (const el of Array.from(page.getElementsByTagName(tag))) el.remove();
  const images: string[] = [];
  for (const el of Array.from(page.querySelectorAll("*"))) {
    for (const a of Array.from(el.attributes)) if (droppedAttribute(a.name, a.value)) el.removeAttribute(a.name);
    // Backgrounds from the web: never loaded (the CSP would refuse them too).
    const bg = el.getAttribute("background");
    if (bg && !bg.trim().startsWith("data:")) el.removeAttribute("background");
    if (el.localName === "source") el.removeAttribute("srcset");
  }
  for (const img of Array.from(page.images)) {
    const src = (img.getAttribute("src") ?? "").trim();
    img.removeAttribute("srcset");
    img.removeAttribute("loading");
    if (src.startsWith("data:")) continue;
    if (webImageUrl(src)) images.push(src);
    img.setAttribute("data-lumo-src", src);
    img.setAttribute("src", PIXEL);
    const box = hiddenBox(img.getAttribute("width"), img.getAttribute("height"), img.getAttribute("style") ?? "");
    if (box) img.setAttribute("data-lumo-box", box);
  }
  const style = page.createElement("style");
  style.textContent = EMAIL_FRAME_STYLE;
  page.head.prepend(style);
  return { doc: `<!doctype html>${page.documentElement.outerHTML}`, images };
}

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
  /** What the reader shows: drawn again only when it changes, so the email's frame isn't loaded again. */
  let readerDrawn = "";
  /** The email's body in the reader (its frame, or its text) and what it shows: kept while that stays, so the frame isn't loaded again. */
  let shownBody: HTMLElement | null = null;
  let shownBodyKey = "";
  /** Where the link under the pointer goes, at the bottom of the reader. */
  const tipHost = h("b");
  const tipPath = h("span");
  const tip = h("div", { class: "mv-link-tip" }, svg(ICONS.arrowUpRight, 11), tipHost, tipPath);
  const showTip = (href: string | null) => {
    const parts = href ? linkParts(href) : null;
    tipHost.textContent = parts?.host ?? "";
    tipPath.textContent = parts?.path ?? "";
    tip.classList.toggle("on", parts != null);
    reader.classList.toggle("link-tip", parts != null);
  };

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
  // Addresses that don't all fit: ‹ and › on the row's ends, shown while the
  // pointer is over it and only where some are hidden (.can-left, .can-right).
  const slide = (dir: -1 | 1) => () => chips.scrollBy({ left: dir * Math.max(120, chips.clientWidth * 0.6), behavior: "smooth" });
  const leftArrow = h("button", { class: "mv-chips-arrow left", title: tl(MAIL_VIEW_TEXT.newer), "aria-label": tl(MAIL_VIEW_TEXT.newer), onclick: slide(-1) },
    svg(ICONS.chevronLeft, 10, { stroke: 2.4 }));
  const rightArrow = h("button", { class: "mv-chips-arrow right", title: tl(MAIL_VIEW_TEXT.older), "aria-label": tl(MAIL_VIEW_TEXT.older), onclick: slide(1) },
    svg(ICONS.chevronRight, 10, { stroke: 2.4 }));
  const chipRow = h("div", { class: "mv-chip-row" }, chips, leftArrow, rightArrow);
  const chipEnds = () => {
    chipRow.classList.toggle("can-left", chips.scrollLeft > 1);
    chipRow.classList.toggle("can-right", chips.scrollLeft + chips.clientWidth < chips.scrollWidth - 1);
  };
  chips.addEventListener("scroll", chipEnds, { passive: true });
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
  // More below than shows: the list's bottom edge fades out (.more-below).
  const fadeIf = (box: HTMLElement) => box.classList.toggle("more-below", box.scrollTop + box.clientHeight < box.scrollHeight - 2);
  const fades = () => {
    fadeIf(list);
    fadeIf(reader);
    chipEnds();
  };
  for (const box of [list, reader]) box.addEventListener("scroll", () => fadeIf(box), { passive: true });
  if (typeof ResizeObserver !== "undefined") {
    const resized = new ResizeObserver(fades);
    resized.observe(list);
    resized.observe(reader);
    resized.observe(chips);
  }
  const foot = h("div", { class: "mv-foot" });
  const body = h("div", { class: "mv-body" }, head, chipRow, list, reader, foot);
  const el = h("div", { class: "view mail-view" }, h("div", { class: "card mail-card" }, body));

  // Its sync runs only while it is on screen: leaving is seen here.
  State.subscribe(() => {
    if (State.view === "mail" && State.mode === "expanded") return;
    wasShown = false;
    // The email's frame goes while the view isn't on screen: nothing of it
    // (its animations, its GIFs) runs then. It comes back when the view does.
    if (shownBody) {
      clear(reader);
      shownBody = null;
      shownBodyKey = "";
      readerDrawn = "";
      drawn = "";
    }
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
    // The keys go to the island again, not to the email's frame going away.
    if (document.activeElement instanceof HTMLIFrameElement) {
      document.activeElement.blur();
      window.focus();
    }
    openId = null;
    drawn = "";
    State.notify();
  }

  /** The email's HTML, asked once (again next time when it couldn't be); the reader is drawn again when it comes. */
  function askHtml(id: string) {
    if (htmlOf.has(id) || htmlAsked.has(id)) return;
    htmlAsked.add(id);
    void Bridge.mailHtml(id)
      .then((html) => {
        if (html == null) return;
        htmlOf.set(id, html);
        while (htmlOf.size > MAX_HTML) htmlOf.delete(htmlOf.keys().next().value as string);
        if (openId === id && html) {
          readerDrawn = "";
          drawn = "";
          State.notify();
        }
      })
      .finally(() => htmlAsked.delete(id));
  }

  /** The email's HTML in its frame, the bar about its images above it. */
  function htmlCard(m: MailViewMessage, html: string): HTMLElement {
    const { doc, images } = frameDocument(html);
    const frame = h("iframe", { class: "mv-html-frame", sandbox: "allow-same-origin", title: m.subject || t(MAIL_VIEW_TEXT.noSubject) }) as HTMLIFrameElement;
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.srcdoc = doc;
    // The frame's document is the email's: its own names can't stand for these.
    const on = (target: EventTarget, type: string, fn: (e: Event) => void, capture = false) =>
      EventTarget.prototype.addEventListener.call(target, type, fn as EventListener, capture);
    let fitWidth = 0;
    const fit = () => {
      const page = frame.contentDocument;
      const body = page?.body;
      if (!page || !body || !frame.isConnected || frame.clientWidth === 0) return;
      fitWidth = frame.clientWidth;
      body.style.zoom = "";
      body.style.padding = "";
      // An email drawn to its own width (most are) has its own margins: no frame's padding then.
      if (page.documentElement.scrollWidth > frame.clientWidth + 1) body.style.padding = "0";
      const zoom = fitZoom(page.documentElement.scrollWidth, frame.clientWidth);
      if (zoom !== 1) body.style.zoom = String(zoom);
      // Its height as its content says, measured with the frame let down to nothing
      // (else it never shrinks), the reader kept where it was.
      const keep = reader.scrollTop;
      frame.style.height = "0px";
      const height = Math.ceil(page.documentElement.scrollHeight);
      frame.style.height = `${Math.max(height, 40)}px`;
      reader.scrollTop = keep;
      fadeIf(reader);
    };
    if (typeof ResizeObserver !== "undefined") {
      // Narrower (the reader's scrollbar came) or wider: fitted again.
      new ResizeObserver(() => {
        if (frame.clientWidth !== fitWidth) fit();
      }).observe(frame);
    }
    on(frame, "load", () => {
      const page = frame.contentDocument;
      if (!page) return;
      fit();
      // An image that comes (or fails) changes the height.
      on(page, "load", fit, true);
      on(page, "error", fit, true);
      // A link opens in the browser, only on a click, and never in the frame.
      on(page, "click", (e) => {
        e.preventDefault();
        const a = (e.target as Element | null)?.closest?.("a[href]");
        const href = a?.getAttribute("href") ?? "";
        if (opensInBrowser(href)) {
          actions.blip();
          void Bridge.openUrl(href.trim());
        }
      }, true);
      on(page, "auxclick", (e) => e.preventDefault(), true);
      on(page, "submit", (e) => e.preventDefault(), true);
      on(page, "dragstart", (e) => e.preventDefault(), true);
      on(page, "mouseover", (e) => {
        const a = (e.target as Element | null)?.closest?.("a[href]");
        showTip(a ? a.getAttribute("href") : null);
      });
      on(page, "mouseleave", () => showTip(null), true);
      on(page, "keydown", (e) => {
        if ((e as KeyboardEvent).key === "Escape") back();
      });
      if (imagesLoaded.has(m.id) && webImagesOn()) void showImages(frame, m.id);
    });
    let bar: HTMLElement | null = null;
    if (images.length && (!webImagesOn() || !imagesLoaded.has(m.id))) {
      if (webImagesOn()) {
        const load = h("button", { class: "mv-btn small" }, t(MAIL_VIEW_TEXT.loadImages));
        load.addEventListener("click", () => {
          actions.blip();
          if (!webImagesOn()) return;
          imagesLoaded.add(m.id);
          bar?.remove();
          void showImages(frame, m.id);
        });
        bar = h("div", { class: "mv-img-bar" },
          svg(ICONS.shield, 13, { stroke: 1.8 }),
          h("span", { class: "mv-img-text", text: t(MAIL_VIEW_TEXT.imagesHidden) }),
          h("span", { class: "mv-space" }),
          load);
      } else {
        bar = h("div", { class: "mv-img-bar" },
          svg(ICONS.shield, 13, { stroke: 1.8 }),
          h("span", { class: "mv-img-text", text: t(MAIL_VIEW_TEXT.imagesOff) }));
      }
    }
    return h("div", { class: "mv-html-wrap" }, bar, h("div", { class: "mv-html" }, frame));
  }

  /** Load images: each web image of the email downloaded (web_image.rs) and shown in its place. */
  async function showImages(frame: HTMLIFrameElement, id: string) {
    const page = frame.contentDocument;
    if (!page) return;
    const hidden = Array.from(Document.prototype.querySelectorAll.call(page, "img[data-lumo-src]") as NodeListOf<HTMLImageElement>);
    const urls = imagesToLoad(hidden.map((img) => img.getAttribute("data-lumo-src") ?? ""));
    await Promise.all(urls.map(async (url) => {
      const blob = await loadClickedImage(url);
      if (!blob || openId !== id || !frame.isConnected) return;
      for (const img of hidden) {
        if (img.getAttribute("data-lumo-src")?.trim() !== url) continue;
        img.removeAttribute("data-lumo-src");
        img.removeAttribute("data-lumo-box");
        img.src = blob;
      }
    }));
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
    const near = neighbours(visibleMessages(d, filter), m.id);
    askHtml(m.id);
    const html = htmlOf.get(m.id) ?? "";
    const showHtml = html !== "" && !textOnly;
    const key = JSON.stringify([m.id, near, html.length, showHtml, d.accounts.length, language(), m.unread, webImagesOn(), m.from, m.address, m.subject, m.date, m.link, m.body]);
    if (key === readerDrawn) return;
    readerDrawn = key;
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
    // Original, or Text only: kept for the next emails.
    const kindSwitch = () => {
      const pickKind = (text: boolean) => () => {
        if (textOnly === text) return;
        actions.blip();
        textOnly = text;
        readerDrawn = "";
        showTip(null);
        drawReader(d, m);
      };
      return h("span", { class: "mv-seg mv-kind" },
        h("button", { class: textOnly ? "mv-seg-btn" : "mv-seg-btn on", onclick: pickKind(false) }, t(MAIL_VIEW_TEXT.original)),
        h("button", { class: textOnly ? "mv-seg-btn on" : "mv-seg-btn", onclick: pickKind(true) }, t(MAIL_VIEW_TEXT.textOnly)));
    };
    // The body stays as it is (its frame not loaded again) while it shows the same.
    const bodyKey = JSON.stringify([m.id, showHtml, showHtml ? html.length : m.body || m.preview, language(), webImagesOn()]);
    if (bodyKey !== shownBodyKey || !shownBody || shownBody.parentElement !== reader) {
      showTip(null);
      shownBody = showHtml ? htmlCard(m, html) : h("div", { class: "mv-read-body", text: (m.body || m.preview).trim() });
      shownBodyKey = bodyKey;
      clear(reader);
      reader.append(shownBody);
    }
    for (const child of Array.from(reader.children)) if (child !== shownBody) child.remove();
    shownBody.before(
      h("div", { class: "mv-read-top" },
        h("button", { class: "mv-back", onclick: back }, svg(ICONS.chevronLeft, 9, { stroke: 2.6 }), h("span", { text: t(MAIL_VIEW_TEXT.back) })),
        h("span", { class: "mv-space" }),
        html ? kindSwitch() : null,
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
      h("div", { class: "mv-read-subject", text: m.subject || t(MAIL_VIEW_TEXT.noSubject) }));
    shownBody.after(
      tip,
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
    chipRow.style.display = d && d.accounts.length > 1 ? "" : "none";

    const m = d && openId ? d.messages.find((x) => x.id === openId) ?? null : null;
    body.classList.toggle("reading", m != null);
    if (!d) {
      clear(list);
      list.append(h("div", { class: "mv-empty" }, h("span", { text: t(MAIL_VIEW_TEXT.loading) })));
      clear(foot);
      return;
    }
    if (m) drawReader(d, m);
    else {
      readerDrawn = "";
      shownBody = null;
      shownBodyKey = "";
      showTip(null);
      clear(reader);
      drawList(d);
    }
    drawFoot(d);
    // Once laid out: whether there is more below.
    requestAnimationFrame(fades);
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
      const now = [language(), filter, unreadOnly, openId, loading, loadedAt, data?.messages.length ?? -1, webImagesOn()].join("~");
      if (now === drawn) return;
      drawn = now;
      draw();
    },
  };
}
