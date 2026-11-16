// Watch: the hidden browser tab an agent browses in (src-tauri/src/browser.rs),
// shown inside the island. Concept: concepts/browser-agenti-guarda.
//
// On the Agents card, Watch opens a live picture of the agent's tab under its
// row (Hide closes it): the tab's address, the page with the agent's pointer
// gliding to where it clicks or types and the box of what it hit, and under
// it what the agent does now and the steps before (concepts/guarda-piu-chiaro).
// A page loading keeps the last picture, dimmed, with what is opening. Its ⤢ opens the agents' browser, the
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
  reads: N_("Reads the page"),
  /** Over the last picture while a new page of the site loads. */
  loading: N_("Loading {host}…"),
  /** The picture failed several times in a row: why, as Rust said it. */
  noPicture: N_("No picture: {error}"),
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
/** The box stays on what the agent clicked or typed in this long after. */
export const RING_MS = 8000;
/** Failed pictures in a row before the picture says why. */
const FAILS_SHOWN = 3;
/** The steps done, under what the agent does now. */
const TRAIL_STEPS = 3;

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
    case "read":
      return t(WATCH_TEXT.reads);
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

/**
 * Where the agent's pointer is on the picture, in % of it, and its shape:
 * the point of its last click or typing since it last opened a page, moved
 * by the scroll since. Null without one, or out of the picture now.
 */
export function pointerAt(f: Pick<BrowserFrame, "width" | "height" | "scrollY" | "steps">): { left: number; top: number; text: boolean } | null {
  if (!(f.width > 0) || !(f.height > 0)) return null;
  const steps = f.steps ?? [];
  for (let i = steps.length - 1; i >= 0; i--) {
    const a = steps[i];
    if (a.kind === "open") return null;
    if (!a.point) continue;
    const y = a.point.y + (a.scrollY - f.scrollY);
    if (y < 0 || y > f.height || a.point.x < 0 || a.point.x > f.width) return null;
    const pct = (v: number, of: number) => Math.round((v / of) * 10000) / 100;
    return { left: pct(a.point.x, f.width), top: pct(y, f.height), text: a.kind === "type" };
  }
  return null;
}

/** What the agent does now, and the steps it did before (newest last, at most TRAIL_STEPS), in words. */
export function stepsText(f: Pick<BrowserFrame, "action" | "steps">): { now: string; kind: string; done: string[] } {
  const steps = f.steps?.length ? f.steps : f.action ? [f.action] : [];
  const last = steps[steps.length - 1];
  const done: string[] = [];
  for (const a of steps.slice(0, -1)) {
    const words = actText(a);
    if (words && done[done.length - 1] !== words) done.push(words);
  }
  return { now: actText(last), kind: last?.kind ?? "", done: done.slice(-TRAIL_STEPS) };
}

/** What shows over the last picture while a page loads: what opens, or the site loading. */
export function loadingText(f: Pick<BrowserFrame, "action" | "host" | "url">): string {
  if (f.action?.kind === "open" && f.action.what.trim()) return `${actText(f.action)}…`;
  const host = f.host || addressParts(f.url).host;
  return host ? t(WATCH_TEXT.loading, { host }) : "";
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

/** The picture of one agent's tab: its bar, the page, the agent's pointer. */
export class LivePicture {
  readonly el: HTMLElement;
  private readonly url = h("span", { class: "bw-url" });
  private readonly liveMark = h("span", { class: "bw-live" }, h("i"), tc(WATCH_TEXT.live));
  private readonly page = h("div", { class: "bw-page" });
  private readonly shot = h("div", { class: "bw-shot" });
  private readonly img = h("img", { alt: "" }) as HTMLImageElement;
  /** The box of what the agent clicked or typed in. */
  private readonly ring = h("div", { class: "bw-ring" });
  /** The agent's pointer, and the ripple of its click. */
  private readonly cursor = h("div", { class: "bw-cursor" }, pointerArt(false), pointerArt(true));
  private readonly ripple = h("div", { class: "bw-ripple" });
  /** A page loading: the bar along the top of the picture. */
  private readonly bar = h("div", { class: "bw-load" }, h("i"));
  /** Over the picture: what is opening, the tab gone, or why there is no picture. */
  private readonly note = h("div", { class: "bw-wait" });
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  private gone = false;
  /** Pictures that failed in a row. */
  private fails = 0;
  /** The click whose ripple was drawn. */
  private rippled = 0;
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
    this.cursor.hidden = true;
    this.ripple.hidden = true;
    this.bar.hidden = true;
    this.img.hidden = true;
    this.shot.append(this.img, this.ring, this.ripple, this.cursor);
    this.page.append(this.shot, this.bar, this.note);
    this.el = h("div", { class: opts.small ? "bw-frame small" : "bw-frame" },
      h("div", { class: "bw-bar" }, svg(ICONS.lock, 11, { stroke: 1.8 }), this.url, this.liveMark, ...buttons),
      this.page);
    const tab = browserOf(chatId, agentId);
    if (tab) this.drawAddress(tab.host ? `https://${tab.host}/` : "");
    this.say(tab?.host ? t(WATCH_TEXT.loading, { host: tab.host }) : "", true);
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
      this.fails = 0;
      if (f?.opening) this.opening(f);
      else if (f) await this.draw(f);
    } catch (err) {
      // Only a tab that is gone stops the pictures: a page changing, or one
      // too busy to answer, keeps the last picture and is asked again; after
      // a few in a row the picture says why.
      if (String(err).includes(NO_TAB) || !browserOf(this.chatId, this.agentId)) {
        this.gone = true;
        this.liveMark.hidden = true;
        this.ring.hidden = true;
        this.cursor.hidden = true;
        this.bar.hidden = true;
        this.say(t(WATCH_TEXT.closed), !this.last);
      } else {
        wait = RETRY_MS;
        if (++this.fails >= FAILS_SHOWN) {
          const error = String(err).replace(/^Error:\s*/, "").trim();
          this.say(t(WATCH_TEXT.noPicture, { error }), !this.last);
        }
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

  /**
   * A note over the picture (`plain`: on the dark page, no picture under
   * it), or none.
   */
  private say(text: string, plain = false) {
    this.note.textContent = text;
    this.note.hidden = !text;
    this.note.classList.toggle("plain", plain);
  }

  /** A tab still opening: its address and what opens, over the last picture, dimmed, if there is one. */
  private opening(f: BrowserFrame) {
    if (f.url) this.drawAddress(f.url);
    const steps = f.steps ?? [];
    const action = steps[steps.length - 1] ?? null;
    const shown: BrowserFrame = { ...f, image: "", width: 0, height: 0, scrollY: 0, action, steps };
    this.loading(true, loadingText(shown));
    this.liveMark.hidden = true;
    this.ring.hidden = true;
    this.cursor.hidden = true;
    if (!this.last) this.say(loadingText(shown), true);
    this.opts.onFrame?.(shown);
  }

  /** The page loading, or not: the last picture dimmed, the bar along its top, and what opens. */
  private loading(on: boolean, text: string) {
    this.el.classList.toggle("loading", on);
    this.bar.hidden = !on;
    if (on) this.say(text, !this.last);
    else this.say("");
  }

  private drawAddress(url: string) {
    const { host, rest } = addressParts(url);
    clear(this.url);
    this.url.append(h("b", { text: host }), h("span", { text: rest }));
    this.url.title = url;
  }

  private async draw(f: BrowserFrame) {
    // A page not drawn yet (browser.rs not_drawn): the last picture stays, dimmed.
    if (!f.image) {
      if (f.url) this.drawAddress(f.url);
      this.loading(true, loadingText(f));
      this.liveMark.hidden = !this.last;
      this.opts.onFrame?.(f);
      return;
    }
    // The new picture decoded before it takes the old one's place: never a blank in between.
    const src = `data:image/jpeg;base64,${f.image}`;
    if (typeof Image === "function") {
      const next = new Image();
      next.src = src;
      await next.decode().catch(() => {});
    }
    if (!lives.has(this)) return;
    this.last = f;
    this.drawAddress(f.url);
    if (f.width > 0 && f.height > 0) this.shot.style.aspectRatio = `${f.width} / ${f.height}`;
    this.img.src = src;
    this.img.hidden = false;
    this.liveMark.hidden = false;
    this.loading(!!f.loading, f.loading ? loadingText(f) : "");
    // The box of what it clicked or typed in, while it is recent.
    const hit = f.action && (f.action.kind === "click" || f.action.kind === "type") ? ringBox(f) : null;
    this.ring.hidden = !hit;
    this.ring.classList.toggle("typing", f.action?.kind === "type");
    if (hit) Object.assign(this.ring.style, { left: `${hit.left}%`, top: `${hit.top}%`, width: `${hit.width}%`, height: `${hit.height}%` });
    // Its pointer, gliding there (style.css), an I-beam while it types.
    const at = pointerAt(f);
    this.cursor.hidden = !at;
    if (at) {
      this.cursor.classList.toggle("text", at.text);
      Object.assign(this.cursor.style, { left: `${at.left}%`, top: `${at.top}%` });
    }
    // A new click: its ripple, once.
    const click = f.action?.kind === "click" && f.action.ago < 2000 ? f.action.seq ?? 0 : 0;
    if (click && click !== this.rippled && at) {
      this.rippled = click;
      Object.assign(this.ripple.style, { left: `${at.left}%`, top: `${at.top}%` });
      this.ripple.hidden = false;
      // Again from the start: the animation runs when the class comes back.
      this.ripple.classList.remove("on");
      void this.ripple.offsetWidth;
      this.ripple.classList.add("on");
    } else if (!at) {
      this.ripple.hidden = true;
    }
    this.follow(hit ?? (at ? { top: at.top, height: 0 } : null));
    this.opts.onFrame?.(f);
  }

  /** A picture cut by its frame (the one under a row) moves so the pointer shows. */
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

const SVG_NS = "http://www.w3.org/2000/svg";

/** The agent's pointer: an arrow, or the I-beam of typing, white edged in black as on any screen. */
function pointerArt(text: boolean): SVGSVGElement {
  const el = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("class", text ? "bw-ibeam" : "bw-arrow");
  const shape = (d: string, attrs: Record<string, string>) => {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
    el.append(p);
  };
  if (text) {
    const d = "M8 3h3l1 1 1-1h3M8 21h3l1-1 1 1h3M12 4v16";
    shape(d, { fill: "none", stroke: "#111", "stroke-width": "3.2", "stroke-linecap": "round" });
    shape(d, { fill: "none", stroke: "#fff", "stroke-width": "1.5", "stroke-linecap": "round" });
  } else {
    shape("M4 2.5v17.2l4.6-4.3 2.9 6.6 3.1-1.4-2.9-6.5H18z", { fill: "#fff", stroke: "#111", "stroke-width": "1.4", "stroke-linejoin": "round" });
  }
  return el;
}

/** What the agent does now, with its icon, and in small the steps before: under a picture. */
export class StepsLine {
  readonly el: HTMLElement;
  private readonly icon = h("span", { class: "bw-now-ico" });
  private readonly now = h("span", { class: "bw-now-text" });
  private readonly done = h("span", { class: "bw-done" });
  private drawn = "";
  private readonly withDone: boolean;

  constructor(withDone = true) {
    this.withDone = withDone;
    this.el = h("span", { class: "bw-steps" }, h("span", { class: "bw-now" }, this.icon, this.now), this.done);
    this.el.hidden = true;
  }

  update(f: BrowserFrame) {
    const words = stepsText(f);
    const busy = !!f.opening || !!f.loading;
    const key = `${words.kind}|${words.now}|${busy}|${f.action?.what ?? ""}|${this.withDone ? words.done.join("|") : ""}`;
    if (key === this.drawn) return;
    this.drawn = key;
    this.el.hidden = !words.now;
    this.now.textContent = busy && words.kind === "open" ? `${words.now}…` : words.now;
    clear(this.icon);
    const up = words.kind === "scroll" && (f.steps?.[f.steps.length - 1] ?? f.action)?.what === "up";
    this.icon.className = `bw-now-ico ${busy ? "busy" : words.kind}${up ? " up" : ""}`;
    const path = STEP_ICONS[words.kind];
    if (!busy && path) this.icon.append(svg(path, 12, { stroke: 1.8 }));
    clear(this.done);
    this.done.hidden = !this.withDone || !words.done.length;
    if (!this.withDone) return;
    words.done.forEach((w, i) => {
      if (i) this.done.append(h("em", { text: "›" }));
      this.done.append(h("span", {}, svg(ICONS.check, 9, { stroke: 2 }), w));
    });
  }
}

/** Each kind of step's icon (stroked); "open" turns while the page loads. */
const STEP_ICONS: Record<string, string> = {
  click: ICONS.pointer,
  type: ICONS.keyboard,
  read: ICONS.eye,
  scroll: ICONS.scrollDown,
  open: ICONS.globe,
};

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
let inline: { chatId: string; agentId: string; el: HTMLElement; live: LivePicture; acts: InlineActions; foot: HTMLElement; steps: StepsLine } | null = null;

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
    const steps = new StepsLine();
    const live = new LivePicture(chatId, agentId, { enlarge: () => openBrowserView(chatId, agentId), onFrame: (f) => steps.update(f) });
    const foot = h("div", { class: "bw-foot" });
    inline = { chatId, agentId, live, acts, foot, steps, el: h("div", { class: "bw-inline" }, live.el, foot) };
  }
  inline.acts = acts;
  drawFoot(inline.foot, acts, inline.steps);
  if (inline.el.parentElement !== slot) slot.append(inline.el);
  inline.live.ensure();
}

function drawFoot(foot: HTMLElement, acts: InlineActions, steps: StepsLine) {
  const key = `${!!acts.ask}|${!!acts.stop}`;
  if (foot.dataset.key === key) return;
  foot.dataset.key = key;
  clear(foot);
  // What the agent does; before the first picture, what the picture is.
  foot.append(steps.el, h("span", { class: "bw-note", text: t(WATCH_TEXT.onlyWatch) }));
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
    const key = `${chatId}|${focus?.agentId}|${list.map((x) => `${x.agent}:${x.tab}:${x.host}:${nameOf(x)}`).join(",")}`;
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
      const steps = new StepsLine();
      const words = h("span", { class: "bw-note now" }, steps.el);
      const live = new LivePicture(chatId, one.agent, {
        close: () => actions.setView("prompt"),
        onFrame: (f) => steps.update(f),
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
      const steps = new StepsLine(false);
      const words = h("span", { class: "bw-cap-now" }, steps.el);
      const live = new LivePicture(chatId, x.agent, {
        small: true,
        onFrame: (f) => steps.update(f),
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
