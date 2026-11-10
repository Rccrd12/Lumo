// An image in an answer: a line that is only `![alt](https://…)`, as
// markdown.ts finds it. The image is downloaded and shown at once (the user's
// choice: asking site by site was too much), from a frame of one height
// whatever it shows, so nothing in the chat jumps when the image comes: the
// download, the image, or the failure with Try again. Settings → Security →
// Images from the web turns it off: the card is then one row, the site, the
// alt text and the way to the browser, and nothing is downloaded.
//
// The island never fetches the image itself (its CSP lets images in only from
// the app, data: and blob:): Rust downloads it with its own checks
// (web_image.rs: https only, public addresses only, raster types only, 8 MB
// at most) and hands the bytes over, shown here through a blob: URL.
//
// The chat redraws its answers often, so what a card shows comes from what
// this module remembers for the session, by URL: the images loaded (their
// blob: URLs, the most recently shown up to 64 MB in all), the ones that could
// not be, and the downloads under way. A card drawn again while its image
// downloads waits for the same download. At most 4 images download at once,
// the others wait their turn, and an answer shows its first 12 images: the
// ones after are the one row of images turned off, with nothing downloaded.

import { h, svg } from "../dom";
import { ICONS } from "../icons";
import { N_, t } from "../../i18n/i18n";
import { Bridge } from "../../core/bridge";
import { State } from "../../core/state";
import "./image.css";

export const IMAGE_STRINGS = {
  loading: N_("Loading the image…"),
  failed: N_("Couldn't load the image"),
  retry: N_("Try again"),
  open: N_("Open in the browser"),
  alt: N_("Image from {site}"),
  /** The row's caption when images are off and the line gives no alt text. */
  image: N_("Image"),
};

/**
 * The bytes kept at most, all images together; the least recently shown goes
 * first. Bounded by bytes, not by count, so a long chat of small images is
 * drawn again from memory, not downloaded again at each redraw.
 */
const CACHE_BYTES = 64 * 1024 * 1024;
/** The downloads run at once; the others wait their turn. */
const MAX_DOWNLOADS = 4;
/** The images an answer shows; the ones after it are drawn as images turned off. */
export const MAX_PER_ANSWER = 12;

/** An image loaded: its blob: URL and its size. */
interface Loaded {
  blob: string;
  size: number;
}
/** Image URL → its image loaded, the most recently shown last. */
const loaded = new Map<string, Loaded>();
/** The bytes of every image in `loaded`. */
let loadedBytes = 0;
/** Downloads under way, by image URL: every card of that image waits for the same one. */
const pending = new Map<string, Promise<void>>();
/** The images that have faded in once already. */
const faded = new Set<string>();

/** Whether each image shown has a see-through ground (a diagram), read once it is drawn. */
const clear = new Map<string, boolean>();

/**
 * Whether `img`'s corners are see-through: a diagram drawn on nothing, shown
 * on white as meant. A photo shows on dark, so its edges don't sit on a
 * white box.
 */
function seeThrough(img: HTMLImageElement): boolean {
  try {
    const c = document.createElement("canvas");
    c.width = 8;
    c.height = 8;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) return false;
    g.drawImage(img, 0, 0, 8, 8);
    const d = g.getImageData(0, 0, 8, 8).data;
    return [0, 7, 56, 63].some((i) => d[i * 4 + 3] < 250);
  } catch {
    return false;
  }
}

/** Images that could not be loaded this session, and why (Try again clears it). */
const failed = new Map<string, string>();

/** The cards on screen and how to draw each again (Try again reaches every card of that image). */
interface Live {
  url: string;
  draw: () => void;
}
const cards = new Set<WeakRef<HTMLElement>>();
const liveOf = new WeakMap<HTMLElement, Live>();

/** The site an image comes from, as its card shows it: its host name, lowercase. */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** Whether images from the web are on (Settings → Security; on unless turned off). */
export function webImagesOn(): boolean {
  return State.settings.webImages !== false;
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

/** Forgets the image loaded for `url` and lets its blob: URL go. */
function drop(url: string) {
  const entry = loaded.get(url);
  if (!entry) return;
  loaded.delete(url);
  loadedBytes -= entry.size;
  URL.revokeObjectURL(entry.blob);
}

/** Keeps `blob` for `url`, letting the least recently shown go past the limit. */
function keep(url: string, blob: string, size: number) {
  drop(url);
  loaded.set(url, { blob, size });
  loadedBytes += size;
  // The image just kept stays, whatever its size.
  while (loadedBytes > CACHE_BYTES && loaded.size > 1) {
    // A card still showing the one that goes notices (its <img> fails) and downloads it again.
    drop(loaded.keys().next().value as string);
  }
}

/** The blob: URL of a loaded image, marked as the most recently shown. */
function cached(url: string): string | undefined {
  const entry = loaded.get(url);
  if (entry !== undefined) {
    loaded.delete(url);
    loaded.set(url, entry);
  }
  return entry?.blob;
}

/** The downloads running, and the ones waiting for a turn, first come first. */
let running = 0;
const waiting: (() => void)[] = [];

/**
 * Takes a turn to download: none to wait for while fewer than MAX_DOWNLOADS
 * run (the download starts at once), otherwise the moment a turn comes.
 */
function turn(): Promise<void> | null {
  if (running < MAX_DOWNLOADS) {
    running++;
    return null;
  }
  return new Promise((go) => waiting.push(go));
}

/** Hands the turn of a download done to the next one waiting. */
function done() {
  const next = waiting.shift();
  if (next) next();
  else running = Math.max(0, running - 1);
}

/** Downloads the image through Rust once, however many cards wait for it. */
function load(url: string): Promise<void> {
  let job = pending.get(url);
  if (job) return job;
  job = (async () => {
    const wait = turn();
    if (wait) await wait;
    try {
      const data = await Bridge.webImage(url);
      const bytes = data ? new Uint8Array(data) : null;
      const type = bytes && imageType(bytes);
      if (!bytes || !type) {
        failed.set(url, "");
        return;
      }
      keep(url, URL.createObjectURL(new Blob([bytes], { type })), bytes.byteLength);
    } catch (err) {
      // What went wrong, as web_image.rs says it (the site's answer, a timeout…).
      failed.set(url, String(err).replace(/^Error:\s*/, ""));
    } finally {
      pending.delete(url);
      done();
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

/** Remembers a card drawn, so Try again on another card of its image reaches it too. */
function track(card: HTMLElement, live: Live) {
  liveOf.set(card, live);
  cards.add(new WeakRef(card));
  // The chat drops its old nodes at each redraw: sweep now and then.
  if (cards.size > 200) redraw(() => false);
}

/**
 * The card for an image line: the image with its source, or, images off, the
 * source alone. `nth` is the image's place among its answer's images, from 0:
 * past MAX_PER_ANSWER, the card is drawn as if images were off.
 */
export function renderImage(alt: string, url: string, nth = 0): HTMLElement {
  const off = !webImagesOn() || nth >= MAX_PER_ANSWER;
  const site = siteOf(url);
  // Off, past the answer's images (or an address with no host to show): one
  // row, nothing downloaded.
  if (off || site === "") {
    const openBtn = h("button", { class: "rc-nav", type: "button", title: t(IMAGE_STRINGS.open), "aria-label": t(IMAGE_STRINGS.open) }, svg(ICONS.arrowUpRight, 12));
    openBtn.addEventListener("click", () => void Bridge.openUrl(url));
    const caption = alt || t(IMAGE_STRINGS.image);
    const foot = h(
      "div",
      { class: "rc-image-foot" },
      h("span", { class: "rc-image-src", title: url }, svg(ICONS.globe, 10, { stroke: 1.8 }), h("span", { text: site })),
      h("span", { class: "rc-image-cap", text: caption, title: caption }),
      h("span", { class: "rc-sp" }),
      openBtn,
    );
    return h("div", { class: "rc-card rc-image off" }, foot);
  }

  // Shown, the picture itself, its corners rounded, with no box around it;
  // under it what it shows and where it comes from, which opens it in the
  // browser.
  const src = h(
    "button",
    { class: "rc-image-src", type: "button", title: `${t(IMAGE_STRINGS.open)}\n${url}`, "aria-label": t(IMAGE_STRINGS.open) },
    h("span", { text: site }),
    svg(ICONS.arrowUpRight, 9, { stroke: 2 }),
  );
  src.addEventListener("click", () => void Bridge.openUrl(url));
  const under = h("div", { class: "rc-image-under" }, alt ? h("span", { class: "rc-image-cap", text: alt, title: alt }) : null, src);
  const frame = h("div", { class: "rc-image-frame" });
  const card = h("div", { class: "rc-card rc-image" }, frame, under);

  const show = (state: string, ...children: Node[]) => {
    frame.className = `rc-image-frame ${state}`;
    frame.replaceChildren(...children);
  };

  const draw = () => {
    const blob = cached(url);
    if (blob !== undefined) {
      const img = h("img", { src: blob, alt: alt || t(IMAGE_STRINGS.alt, { site }), title: alt || site, draggable: "false" });
      // The first time, it fades in once it is decoded rather than appearing
      // in one jump; drawn again (the chat redrawn), it is simply there.
      if (faded.has(url)) img.classList.add("in");
      else {
        img.addEventListener("load", () => {
          img.classList.add("in");
          faded.add(url);
          if (faded.size > 400) faded.delete(faded.keys().next().value as string);
        });
      }
      img.addEventListener("click", () => void Bridge.openUrl(url));
      // Its blob: URL went with the oldest of the cache: drawn again, the card
      // downloads it again. Still in the cache, the bytes themselves don't draw.
      img.addEventListener("error", () => {
        if (loaded.get(url)?.blob === blob) {
          drop(url);
          failed.set(url, "");
        }
        draw();
      });
      const ground = () => (clear.get(url) ? "shown clear" : "shown");
      if (!clear.has(url)) {
        img.addEventListener("load", () => {
          clear.set(url, seeThrough(img));
          if (clear.size > 400) clear.delete(clear.keys().next().value as string);
          if (img.isConnected) frame.className = `rc-image-frame ${ground()}`;
        });
      }
      show(ground(), img);
    } else if (failed.has(url)) {
      const retry = h("button", { class: "rc-image-btn", type: "button", text: t(IMAGE_STRINGS.retry), title: t(IMAGE_STRINGS.retry), "aria-label": t(IMAGE_STRINGS.retry) });
      retry.addEventListener("click", (e) => {
        e.stopPropagation();
        failed.delete(url);
        redraw((live) => live.url === url);
      });
      show(
        "error",
        h(
          "div",
          { class: "rc-image-msg", title: failed.get(url) || undefined },
          h("span", { class: "rc-image-title", text: t(IMAGE_STRINGS.failed) }),
          h("span", { class: "rc-image-hint", text: site }),
          h("div", { class: "rc-image-btns" }, retry),
        ),
      );
    } else {
      show("loading", h("div", { class: "rc-pending-line" }, h("i"), h("i"), h("i"), h("span", { text: t(IMAGE_STRINGS.loading) })));
      void load(url).then(draw);
    }
  };

  track(card, { url, draw });
  draw();
  return card;
}

/** Forgets what the session remembers (tests). */
export function resetImages() {
  for (const { blob } of loaded.values()) URL.revokeObjectURL(blob);
  loaded.clear();
  loadedBytes = 0;
  pending.clear();
  running = 0;
  waiting.length = 0;
  failed.clear();
  clear.clear();
  faded.clear();
  cards.clear();
}
