// Watch: the hidden browser tab an agent browses in (src-tauri/src/browser.rs),
// shown inside the island. Concept: concepts/browser-agenti-guarda.
//
// On the Agents card, Watch opens a live picture of the agent's tab under its
// row (Hide closes it): the tab's address, the page, a ring where the agent
// last clicked or typed and what it did. Its ⤢ opens the agents' browser, the
// island's "browser" view: one tab large, or all of the chat's side by side.
// The tab is never a window on screen, and the page can only be watched.
//
// Pictures are asked of Rust (`chat_browser_frame`) one after the other, and
// only while one is on screen in the open island: none while the island is
// closed or hidden, the view is another one, or the picture is scrolled out
// of sight.

import { Bridge, type AgentWebTab, type BrowserAct, type BrowserFrame } from "../core/bridge";
import { browserAgentsOf, browserOf } from "../core/chat-agents";
import { State } from "../core/state";
import { N_, t, tl } from "../i18n/i18n";
import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";
import type { ViewActions, ViewHost } from "./views";

export const WATCH_TEXT = {
  /** Watch pressed: the picture under the row; this closes it. */
  hide: N_("agents|Hide"),
  /** The picture is of the page as it is now. */
  live: N_("browser|live"),
  enlarge: N_("Enlarge"),
  close: N_("Close"),
  onlyWatch: N_("Only to watch: the tab is the agent's, with none of your accounts."),
  allNote: N_("Only to watch: each agent has its own tab, with none of your accounts. Click one to enlarge it."),
  title: N_("Agents' browser"),
  /** The tab of the Browser view showing every agent's page side by side. */
  all: N_("browser|All"),
  opens: N_("Opens {host}"),
  clicks: N_("Clicks “{what}”"),
  clicksHere: N_("Clicks here"),
  types: N_("Types “{what}”"),
  scrollsDown: N_("Scrolls down"),
  scrollsUp: N_("Scrolls up"),
  waiting: N_("Waiting for the page…"),
  closed: N_("The tab has closed."),
  none: N_("No agent of this chat is browsing now."),
  conversation: N_("The conversation"),
  ask: N_("agents|Ask"),
  stop: N_("agents|Stop"),
};

/** A key with its context ("agents|Hide"): its translation, else its English after the "|". */
function tc(key: string): string {
  const text = t(key);
  return text === key ? key.slice(key.indexOf("|") + 1) : text;
}

/** How often a picture on screen is asked again: the large one, and each of a row. */
const FRAME_MS = 450;
const SMALL_FRAME_MS = 1000;
/** After a picture that failed while the tab is still open (a page changing, a busy page): asked again this much later. */
const RETRY_MS = 1500;
/** Rust's answer for an agent with no tab (browser.rs NO_TAB): the picture stops asking. */
const NO_TAB = "This agent has no browser tab open.";
/** The ring stays on what the agent did this long after it did it. */
export const RING_MS = 8000;

/** What the agent did, in words: "Clicks “Search”". */
export function actText(act: BrowserAct | null | undefined): string {
  if (!act) return "";
  const what = act.what.trim();
  switch (act.kind) {
    case "open":
      return what ? t(WATCH_TEXT.opens, { host: what }) : "";
    case "click":
      return what ? t(WATCH_TEXT.clicks, { what }) : t(WATCH_TEXT.clicksHere);
    case "type":
      return what ? t(WATCH_TEXT.types, { what }) : "";
    case "scroll":
      return t(what === "up" ? WATCH_TEXT.scrollsUp : WATCH_TEXT.scrollsDown);
    default:
      return "";
  }
}

/**
 * Where the ring goes on the picture, in % of it: the action's box moved by
 * the scroll since. Null when the action has no place, is old, or is out of
 * the picture now.
 */
export function ringBox(f: Pick<BrowserFrame, "width" | "height" | "scrollY" | "action">): { left: number; top: number; width: number; height: number } | null {
  const a = f.action;
  if (!a?.rect || a.ago > RING_MS || !(f.width > 0) || !(f.height > 0)) return null;
  const y = a.rect.y + (a.scrollY - f.scrollY);
  if (y + a.rect.h <= 0 || y >= f.height || a.rect.x + a.rect.w <= 0 || a.rect.x >= f.width) return null;
  const pct = (v: number, of: number) => Math.round((v / of) * 10000) / 100;
  return { left: pct(a.rect.x, f.width), top: pct(y, f.height), width: pct(a.rect.w, f.width), height: pct(a.rect.h, f.height) };
}

/** The address as the bar shows it: the site in full, then the rest dimmed. */
export function addressParts(url: string): { host: string; rest: string } {
  try {
    const u = new URL(url);
    const rest = `${u.pathname === "/" ? "" : u.pathname}${u.search}${u.hash}`;
    return { host: u.host, rest };
  } catch {
    return { host: url, rest: "" };
  }
}

// ── One picture, kept fresh while on screen ─────────────────────────────────

interface LiveOptions {
  /** One of a row of pictures: asked less often, no buttons on its bar. */
  small?: boolean;
  /** ⤢ on its bar. */
  enlarge?: () => void;
  /** × on its bar. */
  close?: () => void;
  /** A new picture came: what the agent did, for words beside it. */
  onFrame?: (f: BrowserFrame) => void;
}

const lives = new Set<LivePicture>();

/** The picture of one agent's tab: its bar, the page, the ring. */
export class LivePicture {
  readonly el: HTMLElement;
  private readonly url = h("span", { class: "bw-url" });
  private readonly liveMark = h("span", { class: "bw-live" }, h("i"), tc(WATCH_TEXT.live));
  private readonly page = h("div", { class: "bw-page" });
  private readonly shot = h("div", { class: "bw-shot" });
  private readonly img = h("img", { alt: "" }) as HTMLImageElement;
  private readonly ring = h("div", { class: "bw-ring" });
  private readonly tag = h("span", { class: "bw-tag" });
  private readonly note = h("div", { class: "bw-wait", text: t(WATCH_TEXT.waiting) });
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private gone = false;
  /** In sight on the screen (an IntersectionObserver says): not scrolled away in the chat, nor faded out. */
  private inSight = true;
  private readonly sight: IntersectionObserver | null = null;
  last: BrowserFrame | null = null;

  readonly chatId: string;
  readonly agentId: string;
  private readonly opts: LiveOptions;

  constructor(chatId: string, agentId: string, opts: LiveOptions = {}) {
    this.chatId = chatId;
    this.agentId = agentId;
    this.opts = opts;
    const buttons: HTMLElement[] = [];
    if (opts.enlarge) buttons.push(iconButton(ICONS.expand, t(WATCH_TEXT.enlarge), opts.enlarge));
    if (opts.close) buttons.push(iconButton(ICONS.xmark, t(WATCH_TEXT.close), opts.close, true));
    this.liveMark.hidden = true;
    this.ring.hidden = true;
    this.tag.hidden = true;
    this.img.hidden = true;
    this.shot.append(this.img, this.ring, this.tag);
    this.page.append(this.shot, this.note);
    this.el = h("div", { class: opts.small ? "bw-frame small" : "bw-frame" },
      h("div", { class: "bw-bar" }, svg(ICONS.lock, 11, { stroke: 1.8 }), this.url, this.liveMark, ...buttons),
      this.page);
    const tab = browserOf(chatId, agentId);
    if (tab) this.drawAddress(tab.host ? `https://${tab.host}/` : "");
    if (typeof IntersectionObserver !== "undefined") {
      this.inSight = false;
      this.sight = new IntersectionObserver((seen) => {
        const last = seen[seen.length - 1];
        this.inSight = !!last?.isIntersecting;
        if (this.inSight) this.ensure();
      });
      this.sight.observe(this.el);
    }
    lives.add(this);
  }

  /** On screen in the open island: pictures are asked. */
  private shown(): boolean {
    return this.el.isConnected && this.inSight && State.mode === "expanded" && !document.hidden
      && !!this.el.closest(".view.on") && !this.el.closest(".hidden-by-upload");
  }

  /** Asks for pictures again if it is on screen and isn't already. */
  ensure() {
    if (this.gone) {
      // Its agent may have a tab again (another page opened).
      if (!browserOf(this.chatId, this.agentId)) return;
      this.gone = false;
    }
    if (this.timer != null || this.busy || !this.shown()) return;
    void this.pull();
  }

  /** Done with: it asks for nothing more. */
  drop() {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
    this.sight?.disconnect();
    lives.delete(this);
  }

  private async pull() {
    this.busy = true;
    let wait = this.opts.small ? SMALL_FRAME_MS : FRAME_MS;
    try {
      const f = await Bridge.browserFrame(this.chatId, this.agentId);
      if (f?.opening) this.waiting(f.url);
      else if (f) this.draw(f);
    } catch (err) {
      // Only a tab that is gone stops the pictures: a page changing, or one
      // too busy to answer, keeps the last picture and is asked again.
      if (String(err).includes(NO_TAB) || !browserOf(this.chatId, this.agentId)) {
        this.gone = true;
        this.liveMark.hidden = true;
        this.ring.hidden = true;
        this.tag.hidden = true;
        this.note.textContent = t(WATCH_TEXT.closed);
        this.note.hidden = false;
      } else {
        wait = RETRY_MS;
      }
    } finally {
      this.busy = false;
    }
    if (!this.gone && lives.has(this) && this.shown()) {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.shown()) void this.pull();
      }, wait);
    }
  }

  /** A tab still opening: its address, no picture yet. */
  private waiting(url: string) {
    if (url) this.drawAddress(url);
    if (this.last) return;
    this.liveMark.hidden = true;
    this.note.textContent = t(WATCH_TEXT.waiting);
    this.note.hidden = false;
  }

  private drawAddress(url: string) {
    const { host, rest } = addressParts(url);
    clear(this.url);
    this.url.append(h("b", { text: host }), h("span", { text: rest }));
    this.url.title = url;
  }

  private draw(f: BrowserFrame) {
    this.last = f;
    this.drawAddress(f.url);
    if (f.width > 0 && f.height > 0) this.shot.style.aspectRatio = `${f.width} / ${f.height}`;
    this.img.src = `data:image/jpeg;base64,${f.image}`;
    this.img.hidden = false;
    this.note.hidden = true;
    this.liveMark.hidden = false;
    const box = ringBox(f);
    this.ring.hidden = !box;
    if (box) Object.assign(this.ring.style, { left: `${box.left}%`, top: `${box.top}%`, width: `${box.width}%`, height: `${box.height}%` });
    const said = f.action && f.action.ago <= RING_MS ? actText(f.action) : "";
    this.tag.hidden = !said || this.opts.small === true;
    if (said) {
      this.tag.lastChild?.remove();
      if (!this.tag.firstChild) this.tag.append(h("i"));
      this.tag.append(said);
      // Over the ring, or under it when it is at the top; at the top left without one.
      const top = box ? (box.top > 8 ? box.top : Math.min(box.top + box.height, 92)) : 2;
      Object.assign(this.tag.style, { left: `${box ? Math.max(box.left, 1) : 1.5}%`, top: `${top}%` });
      this.tag.classList.toggle("over", !!box && box.top > 8);
    }
    this.follow(box);
    this.opts.onFrame?.(f);
  }

  /** A picture cut by its frame (the one under a row) moves so the ring shows. */
  private follow(box: { top: number; height: number } | null) {
    const shotH = this.shot.offsetHeight;
    const pageH = this.page.offsetHeight;
    if (!(shotH > pageH)) {
      this.shot.style.transform = "";
      return;
    }
    const center = box ? ((box.top + box.height / 2) / 100) * shotH : 0;
    const offset = Math.max(0, Math.min(center - pageH / 2, shotH - pageH));
    this.shot.style.transform = offset ? `translateY(${-Math.round(offset)}px)` : "";
  }
}

function iconButton(path: string, title: string, run: () => void, filled = false): HTMLElement {
  return h("button", {
    class: "bw-ico", title, "aria-label": title,
    onclick: (e: Event) => {
      e.stopPropagation();
      run();
    },
  }, filled ? svg(path, 10) : svg(path, 11, { stroke: 1.8 }));
}

// The island opening (State changes) asks the pictures on screen again,
// once the island has drawn the change (its own subscriber draws in the next
// animation frame, after this one's).
let ensuring = false;
State.subscribe(() => {
  if (ensuring) return;
  ensuring = true;
  const later = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (run: () => void) => setTimeout(run, 16);
  later(() => later(() => {
    ensuring = false;
    for (const live of lives) live.ensure();
  }));
});
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    for (const live of lives) live.ensure();
  });
}

// ── Under an agent's row on the Agents card ─────────────────────────────────

/** What the picture under a row can do: the row's own Ask and Stop. */
export interface InlineActions {
  ask?: (() => void) | null;
  stop?: (() => void) | null;
}

/** The agent whose picture is open under its row: one at a time. */
let watching: { chatId: string; agentId: string } | null = null;
let inline: { chatId: string; agentId: string; el: HTMLElement; live: LivePicture; acts: InlineActions; foot: HTMLElement } | null = null;

export function isWatching(chatId: string, agentId: string): boolean {
  return watching?.chatId === chatId && watching.agentId === agentId;
}

/** Watch, or Hide: the picture under the agent's row opens, or closes. */
export function toggleWatch(chatId: string, agentId: string) {
  watching = isWatching(chatId, agentId) ? null : { chatId, agentId };
  if (!watching && inline) {
    inline.live.drop();
    inline = null;
  }
}

/** Puts the picture of the watched agent in `slot`, under its row; the same one each time the card is drawn. */
export function mountInline(slot: HTMLElement, chatId: string, agentId: string, acts: InlineActions) {
  if (!isWatching(chatId, agentId)) return;
  if (!inline || inline.chatId !== chatId || inline.agentId !== agentId) {
    inline?.live.drop();
    const live = new LivePicture(chatId, agentId, { enlarge: () => openBrowserView(chatId, agentId) });
    const foot = h("div", { class: "bw-foot" });
    inline = { chatId, agentId, live, acts, foot, el: h("div", { class: "bw-inline" }, live.el, foot) };
  }
  inline.acts = acts;
  drawFoot(inline.foot, acts);
  if (inline.el.parentElement !== slot) slot.append(inline.el);
  inline.live.ensure();
}

function drawFoot(foot: HTMLElement, acts: InlineActions) {
  const key = `${!!acts.ask}|${!!acts.stop}`;
  if (foot.dataset.key === key) return;
  foot.dataset.key = key;
  clear(foot);
  foot.append(h("span", { class: "bw-note", text: t(WATCH_TEXT.onlyWatch) }));
  if (acts.ask) foot.append(smallButton("ask", tc(WATCH_TEXT.ask), () => inline?.acts.ask?.()));
  if (acts.stop) foot.append(smallButton("stop", tc(WATCH_TEXT.stop), () => inline?.acts.stop?.()));
}

function smallButton(cls: string, text: string, run: () => void): HTMLElement {
  return h("button", {
    class: `agents-btn ${cls}`, text,
    onclick: (e: Event) => {
      e.stopPropagation();
      run();
    },
  });
}

// ── The agents' browser: the island's "browser" view ────────────────────────

/** What the view needs from the chat (chat.ts): each agent's name, Ask and Stop. */
export interface BrowserViewHost {
  title(chatId: string, agentId: string): string;
  ask?(chatId: string, agentId: string): void;
  stop?(chatId: string, agentId: string): void;
}

let viewHost: BrowserViewHost | null = null;
let viewActions: ViewActions | null = null;
/** The chat the view shows the tabs of, and the one large ("all": side by side). */
let focus: { chatId: string; agentId: string } | null = null;
let redrawView: (() => void) | null = null;
let tabsChanged: (() => void) | null = null;

/** The agents' tabs changed (chat.ts, on browser-tabs): the view on screen follows them. */
export function browserTabsChanged() {
  tabsChanged?.();
}

export function setBrowserViewHost(host: BrowserViewHost) {
  viewHost = host;
}

/** ⤢, or Watch on the conversation's own tab: the agents' browser, on that agent's tab. */
export function openBrowserView(chatId: string, agentId: string) {
  focus = { chatId, agentId };
  viewActions?.blip();
  viewActions?.setView("browser");
  redrawView?.();
}

/** An agent's name in the view: its task, or "The conversation" for the chat's own tab. */
function nameOf(tab: AgentWebTab): string {
  if (tab.agent === "main") return t(WATCH_TEXT.conversation);
  return viewHost?.title(tab.chat, tab.agent) || tab.host;
}

export function buildBrowserView(actions: ViewActions): ViewHost {
  viewActions = actions;
  const seg = h("div", { class: "mv-seg bw-seg" });
  const body = h("div", { class: "bw-body" });
  const foot = h("div", { class: "bw-foot" });
  const head = h("div", { class: "mv-head" },
    h("span", { class: "mv-icon" }, svg(ICONS.globe, 15, { stroke: 1.6 })),
    h("span", { class: "mv-title", text: tl(WATCH_TEXT.title) }),
    h("span", { class: "bw-gap" }),
    seg);
  const el = h("div", { class: "view browser-view" }, h("div", { class: "card bw-view" }, head, body, foot));
  /** The pictures on screen, by agent: kept while the same tabs show. */
  let shown = new Map<string, LivePicture>();
  let drawn = "";

  function tabs(): AgentWebTab[] {
    return focus ? browserAgentsOf(focus.chatId) : [];
  }

  function draw() {
    const list = tabs();
    const chatId = focus?.chatId ?? "";
    // The agent shown has no tab now, or All has one tab left: the tab there is.
    if (focus && list.length && (focus.agentId === "all" ? list.length < 2 : !list.some((x) => x.agent === focus!.agentId))) {
      focus = { chatId, agentId: list[0].agent };
    }
    const one = focus?.agentId !== "all" ? list.find((x) => x.agent === focus?.agentId) : undefined;
    const key = `${chatId}|${focus?.agentId}|${list.map((x) => `${x.agent}:${x.tab}:${nameOf(x)}`).join(",")}`;
    if (key === drawn) {
      for (const live of shown.values()) live.ensure();
      return;
    }
    drawn = key;
    for (const live of shown.values()) live.drop();
    shown = new Map();
    clear(seg);
    clear(body);
    clear(foot);
    seg.hidden = list.length < 2;
    for (const x of list) {
      seg.append(segButton(x.host || nameOf(x), focus?.agentId === x.agent, () => {
        focus = { chatId, agentId: x.agent };
        draw();
      }));
    }
    if (list.length > 1) {
      seg.append(segButton(tc(WATCH_TEXT.all), focus?.agentId === "all", () => {
        focus = { chatId, agentId: "all" };
        draw();
      }, false));
    }
    if (!list.length) {
      body.append(h("div", { class: "bw-empty", text: t(WATCH_TEXT.none) }));
      return;
    }
    if (one) {
      const words = h("span", { class: "bw-note now" });
      const live = new LivePicture(chatId, one.agent, {
        close: () => actions.setView("prompt"),
        onFrame: (f) => {
          words.textContent = actText(f.action);
        },
      });
      shown.set(one.agent, live);
      body.className = "bw-body one";
      body.append(live.el);
      foot.append(h("span", { class: "bw-agent" }, h("span", { class: "agents-mark working" }, h("i")), nameOf(one)), words);
      if (viewHost?.ask && one.agent !== "main") foot.append(smallButton("ask", tc(WATCH_TEXT.ask), () => viewHost?.ask?.(chatId, one.agent)));
      if (viewHost?.stop && one.agent !== "main") foot.append(smallButton("stop", tc(WATCH_TEXT.stop), () => viewHost?.stop?.(chatId, one.agent)));
      live.ensure();
      return;
    }
    body.className = "bw-body all";
    body.style.setProperty("--bw-cols", String(Math.min(list.length, 3)));
    for (const x of list) {
      const words = h("span", { class: "bw-cap-now" });
      const live = new LivePicture(chatId, x.agent, {
        small: true,
        onFrame: (f) => {
          words.textContent = actText(f.action);
        },
      });
      shown.set(x.agent, live);
      const tile = h("div", { class: "bw-tile", onclick: () => {
        focus = { chatId, agentId: x.agent };
        draw();
      } }, live.el, h("div", { class: "bw-cap" },
        h("span", { class: "bw-agent" }, h("span", { class: "agents-mark working" }, h("i")), nameOf(x)), words));
      body.append(tile);
      live.ensure();
    }
    foot.append(h("span", { class: "bw-note", text: t(WATCH_TEXT.allNote) }));
  }
  redrawView = () => {
    drawn = "";
    draw();
  };
  tabsChanged = () => {
    if (State.view === "browser") draw();
  };

  return {
    el,
    sync() {
      if (State.view !== "browser") return;
      if (!focus && State.chatId) focus = { chatId: State.chatId, agentId: "all" };
      draw();
    },
  };
}

function segButton(label: string, on: boolean, run: () => void, dot = true): HTMLElement {
  return h("button", { class: on ? "mv-seg-btn on" : "mv-seg-btn", onclick: run },
    h("span", { class: "bw-tab" }, ...(dot ? [h("i")] : []), label));
}
