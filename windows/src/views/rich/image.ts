// An image in an answer: a line that is only `![alt](https://…)`, as
// markdown.ts finds it. Lumo talks only to the services the user set up, so
// a site the model links to is not reached until the user says so: first the
// card asks ("This answer has an image from upload.wikimedia.org"), with Show
// for this image and "Always from …" for every image of that site, the site
// then kept in the settings (webImageSites, Settings → Security → Images from
// the web, where it can be forgotten).
//
// The island never fetches the image itself (its CSP lets images in only from
// the app, data: and blob:): Rust downloads it with its own checks
// (web_image.rs: https only, public addresses only, raster types only, 8 MB
// at most) and hands the bytes over, shown here through a blob: URL.
//
// The chat redraws its answers often, so what a card shows comes from what
// this module remembers for the session, by URL: the images loaded (their
// blob: URLs, the 40 most recent), the ones that could not be, the ones
// shown once, and the downloads under way. A card drawn again while its image
// downloads waits for the same download. The frame keeps one height whatever
// it shows, so nothing in the chat jumps when the image comes.

import { h, svg } from "../dom";
import { ICONS } from "../icons";
import { N_, t } from "../../i18n/i18n";
import { Bridge } from "../../core/bridge";
import { State } from "../../core/state";
import "./image.css";

export const IMAGE_STRINGS = {
  ask: N_("This answer has an image from {site}"),
  askHint: N_("Lumo downloads it only if you want: the site will know you opened it."),
  show: N_("Show"),
  showTip: N_("Show this image only"),
  always: N_("Always from {site}"),
  alwaysTip: N_("Show the images from {site} without asking. You can change this in Settings → Security."),
  loading: N_("Loading the image…"),
  failed: N_("Couldn't load the image"),
  retry: N_("Try again"),
  open: N_("Open in the browser"),
  alt: N_("Image from {site}"),
};

/** The blob: URLs kept at most; the least recently shown goes first. */
const CACHE_LIMIT = 40;

/** Image URL → blob: URL of its bytes, the most recently shown last. */
const loaded = new Map<string, string>();
/** Downloads under way, by image URL: every card of that image waits for the same one. */
const pending = new Map<string, Promise<void>>();
/** Images that could not be loaded this session (Try again clears it). */
const failed = new Set<string>();
/** Images the user let in with Show, this session only. */
const shownOnce = new Set<string>();

/** The cards on screen and how to draw each again (when a site is let in, or an image comes). */
interface Live {
  url: string;
  site: string;
  draw: () => void;
}
const cards = new Set<WeakRef<HTMLElement>>();
const liveOf = new WeakMap<HTMLElement, Live>();

/** The site an image comes from: its exact host name, lowercase, as Settings keeps it. */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** The sites whose images are shown without asking. */
function allowedSites(): string[] {
  const sites = State.settings.webImageSites;
  return Array.isArray(sites) ? sites : [];
}

/** Whether the image may be downloaded: its site is let in, or the user asked for this one. */
export function imageAllowed(url: string): boolean {
  return shownOnce.has(url) || allowedSites().includes(siteOf(url));
}

/**
 * The image type the bytes' first bytes say (the same signatures as Rust's
 * web_image.rs sniff), for the Blob; null for anything else.
 */
export function imageType(bytes: Uint8Array): string | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  const ascii = (text: string, at = 0) => starts([...text].map((c) => c.charCodeAt(0)), at);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii("GIF87a") || ascii("GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii("RIFF") && ascii("WEBP", 8)) return "image/webp";
  if (bytes.length >= 12 && ascii("ftyp", 4)) {
    // An ISO box: avif or avis as its brand, or among the compatible ones.
    const size = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
    const end = Math.min(Math.max(size, 12), bytes.length, 256);
    const avif = (at: number) => ascii("avif", at) || ascii("avis", at);
    if (avif(8)) return "image/avif";
    for (let at = 16; at + 4 <= end; at += 4) if (avif(at)) return "image/avif";
  }
  return null;
}

/** Keeps `blob` for `url`, letting the least recently shown go past the limit. */
function keep(url: string, blob: string) {
  loaded.set(url, blob);
  while (loaded.size > CACHE_LIMIT) {
    const [oldest, old] = loaded.entries().next().value as [string, string];
    loaded.delete(oldest);
    // A card still showing it notices (its <img> fails) and downloads it again.
    URL.revokeObjectURL(old);
  }
}

/** The blob: URL of a loaded image, marked as the most recently shown. */
function cached(url: string): string | undefined {
  const blob = loaded.get(url);
  if (blob !== undefined) {
    loaded.delete(url);
    loaded.set(url, blob);
  }
  return blob;
}

/** Downloads the image through Rust once, however many cards wait for it. */
function load(url: string): Promise<void> {
  let job = pending.get(url);
  if (job) return job;
  job = (async () => {
    try {
      const data = await Bridge.webImage(url);
      const bytes = data ? new Uint8Array(data) : null;
      const type = bytes && imageType(bytes);
      if (!bytes || !type) {
        failed.add(url);
        return;
      }
      keep(url, URL.createObjectURL(new Blob([bytes], { type })));
    } catch {
      failed.add(url);
    } finally {
      pending.delete(url);
    }
  })();
  pending.set(url, job);
  return job;
}

/** Draws again every card on screen that `match` picks; forgets the cards gone. */
function redraw(match: (live: Live) => boolean) {
  for (const ref of cards) {
    const card = ref.deref();
    const live = card && liveOf.get(card);
    if (!card || !live || card.isConnected === false) {
      cards.delete(ref);
      continue;
    }
    if (match(live)) live.draw();
  }
}

/** Remembers a card drawn, so letting its site in reaches it too. */
function track(card: HTMLElement, live: Live) {
  liveOf.set(card, live);
  cards.add(new WeakRef(card));
  // The chat drops its old nodes at each redraw: sweep now and then.
  if (cards.size > 200) redraw(() => false);
}

/** "Always from …": the site goes into the settings, and every card of it loads. */
function allowSite(site: string) {
  if (!site || allowedSites().includes(site)) return;
  State.settings = { ...State.settings, webImageSites: [...allowedSites(), site] };
  void Bridge.saveSettings(State.settings);
  redraw((live) => live.site === site);
}

function button(label: string, tip: string, primary: boolean, onClick: () => void): HTMLButtonElement {
  const el = h("button", { class: primary ? "rc-image-btn primary" : "rc-image-btn", type: "button", text: label, title: tip, "aria-label": tip });
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return el;
}

/** The card for an image line: it asks first, then shows the image with its source. */
export function renderImage(alt: string, url: string): HTMLElement {
  const site = siteOf(url);
  const frame = h("div", { class: "rc-image-frame" });
  const openBtn = h("button", { class: "rc-nav", type: "button", title: t(IMAGE_STRINGS.open), "aria-label": t(IMAGE_STRINGS.open) }, svg(ICONS.arrowUpRight, 12));
  openBtn.addEventListener("click", () => void Bridge.openUrl(url));
  const foot = h(
    "div",
    { class: "rc-image-foot" },
    h("span", { class: "rc-image-src", title: url }, svg(ICONS.globe, 10, { stroke: 1.8 }), h("span", { text: site })),
    alt ? h("span", { class: "rc-image-cap", text: alt, title: alt }) : null,
    h("span", { class: "rc-sp" }),
    openBtn,
  );
  const card = h("div", { class: "rc-card rc-image" }, frame, foot);

  const show = (state: string, ...children: Node[]) => {
    frame.className = `rc-image-frame ${state}`;
    frame.replaceChildren(...children);
  };

  const draw = () => {
    // A site forgotten in Settings asks again, even for an image already here.
    const allowed = imageAllowed(url) && site !== "";
    const blob = allowed ? cached(url) : undefined;
    if (blob !== undefined) {
      const img = h("img", { src: blob, alt: alt || t(IMAGE_STRINGS.alt, { site }), title: alt || site, draggable: "false" });
      img.addEventListener("click", () => void Bridge.openUrl(url));
      // Its blob: URL went with the oldest of the cache: download it again.
      // Otherwise the bytes themselves would not draw.
      img.addEventListener("error", () => {
        if (loaded.get(url) === blob) {
          loaded.delete(url);
          URL.revokeObjectURL(blob);
          failed.add(url);
        }
        draw();
      });
      show("shown", img);
    } else if (allowed && failed.has(url)) {
      show(
        "error",
        h(
          "div",
          { class: "rc-image-msg" },
          h("span", { class: "rc-image-title", text: t(IMAGE_STRINGS.failed) }),
          h("span", { class: "rc-image-hint", text: site }),
          h("div", { class: "rc-image-btns" }, button(t(IMAGE_STRINGS.retry), t(IMAGE_STRINGS.retry), false, () => {
            failed.delete(url);
            redraw((live) => live.url === url);
          })),
        ),
      );
    } else if (allowed) {
      show("loading", h("div", { class: "rc-pending-line" }, h("i"), h("i"), h("i"), h("span", { text: t(IMAGE_STRINGS.loading) })));
      void load(url).then(draw);
    } else {
      show(
        "ask",
        h(
          "div",
          { class: "rc-image-msg" },
          svg(ICONS.globe, 18, { stroke: 1.6 }),
          h("span", { class: "rc-image-title", text: t(IMAGE_STRINGS.ask, { site }) }),
          h("span", { class: "rc-image-hint", text: t(IMAGE_STRINGS.askHint) }),
          site
            ? h(
                "div",
                { class: "rc-image-btns" },
                button(t(IMAGE_STRINGS.show), t(IMAGE_STRINGS.showTip), true, () => {
                  shownOnce.add(url);
                  redraw((live) => live.url === url);
                }),
                button(t(IMAGE_STRINGS.always, { site }), t(IMAGE_STRINGS.alwaysTip, { site }), false, () => allowSite(site)),
              )
            : null,
        ),
      );
    }
  };

  track(card, { url, site, draw });
  draw();
  return card;
}

/** Forgets what the session remembers (tests). */
export function resetImages() {
  for (const blob of loaded.values()) URL.revokeObjectURL(blob);
  loaded.clear();
  pending.clear();
  failed.clear();
  shownOnce.clear();
  cards.clear();
}
