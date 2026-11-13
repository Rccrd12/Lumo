// An email as its sender drew it, in the Email view (views/mail-view.ts): the
// rules that need no page, so tests/mail-html.test.mjs runs them as they are.
// The HTML comes from mail.rs (mail_html); the view shows it in a frame with
// no scripts, its links opened in the browser by a click, the images it links
// to hidden until Load images (the island's CSP keeps them out anyway).

/** The images an email may load after Load images; the ones after stay hidden. */
export const MAX_EMAIL_IMAGES = 60;

/** How wide an HTML email is drawn for (most are made 600 px wide). */
export const EMAIL_WIDTH = 600;

/** The smallest an email is drawn to fit: below it, it scrolls sideways. */
const MIN_ZOOM = 0.5;

/** Elements an email can't keep: they run, load or go somewhere. */
export const DROPPED_TAGS = ["script", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "link", "meta", "form", "portal", "template"];

/** Whether `url` is an image on the web, which waits for Load images (https only: web_image.rs). */
export function webImageUrl(url: string): boolean {
  return /^https:\/\//i.test(url.trim());
}

/** Whether a link of the email opens in the browser on a click: http and https only. */
export function opensInBrowser(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}

/**
 * What the corner says while the pointer is on a link: where it really goes,
 * its site always whole at its end (a long name keeps its last part, the
 * domain that owns it: "paypal.com.login-renewal.evil.example" is evil's),
 * then the path, without the query that tracks the click. null for a link
 * that goes nowhere a click takes.
 */
export function linkParts(href: string): { host: string; path: string } | null {
  if (!opensInBrowser(href)) return null;
  try {
    const u = new URL(href.trim());
    if (!u.hostname) return null;
    const host = u.hostname.length > 60 ? `…${u.hostname.slice(-59)}` : u.hostname;
    let path = u.pathname === "/" ? "" : safeDecode(u.pathname).replace(/\/$/, "");
    if (path.length > 60) path = `${path.slice(0, 59)}…`;
    return { host, path };
  } catch {
    return null;
  }
}

function safeDecode(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** How much an email `width` wide is shrunk to fit `room`: 1 when it fits. */
export function fitZoom(width: number, room: number): number {
  if (!(width > 0) || !(room > 0) || width <= room + 1) return 1;
  return Math.max(MIN_ZOOM, room / width);
}

/** The web images to load for Load images: each address once, in order, MAX_EMAIL_IMAGES at most. */
export function imagesToLoad(urls: string[]): string[] {
  return [...new Set(urls.map((u) => u.trim()).filter(webImageUrl))].slice(0, MAX_EMAIL_IMAGES);
}

/**
 * The box a hidden image keeps (its stand-in is a 1×1 pixel): its own size
 * when the email gives its height; with only a width, "h" (48 px tall rather
 * than a square); with neither, "wh" (48 × 48). "auto" is no size.
 */
export function hiddenBox(width: string | null, height: string | null, style: string): "" | "h" | "wh" {
  const has = (attr: string | null, prop: string) =>
    /^\s*\d/.test(attr ?? "") || new RegExp(`(^|;)\\s*${prop}\\s*:\\s*\\d`, "i").test(style);
  if (has(height, "height")) return "";
  return has(width, "width") ? "h" : "wh";
}

/**
 * The services that count an email's opening with a picture of their own,
 * and the paths those pictures go by: never loaded, even after Load images.
 */
const TRACKER_HOSTS = /(^|\.)(list-manage\.com|mailtrack\.io|mailstat\.us|sidekickopen\d*\.com|getnotify\.com|bananatag\.com|yesware\.com|mixmax\.com|mailfoogae\.appspot\.com)$/i;
const TRACKER_PATHS = /\/(track\/open(\.php)?|wf\/open|e\/o\/[^/]+|tr\/op\/[^/]+|trk\/open|open\.php|o\.gif|open\.gif|open\.png|pixel(\.gif|\.png)?|beacon(\.gif|\.png)?)\/?$/i;

/**
 * The address an image of an email shows: its src, or with none (a picture
 * given only by srcset), the first of its srcset, as a browser would read it.
 * The frame takes srcset out (views/mail-view.ts), so without this such an
 * image would never load, not even after Load images.
 */
export function imageSource(src: string, srcset: string): string {
  const own = src.trim();
  if (own) return own;
  return (srcset.trim().split(/\s+/)[0] ?? "").replace(/,+$/, "");
}

/**
 * Whether an image of an email is there to tell its sender it was opened:
 * a picture of 2 × 2 px or less (or 0 wide or tall by its attributes), or
 * one from a service or a path made for that (TRACKER_HOSTS, TRACKER_PATHS).
 * Never loaded. One only hidden by its style is not one: newsletters hide
 * their phone pictures that way and show them from their own CSS. An image
 * like any other can still carry who it was sent to in its address: only not
 * loading it keeps the opening quiet.
 */
export function trackingPixel(src: string, width: string | null, height: string | null, style: string): boolean {
  const tiny = (attr: string | null, prop: string) =>
    /^\s*[0-2](\.\d+)?\s*(px)?\s*$/i.test(attr ?? "") || new RegExp(`(^|;)\\s*${prop}\\s*:\\s*[0-2](\\.\\d+)?(px)?\\s*(!important)?\\s*(;|$)`, "i").test(style);
  const zero = (attr: string | null) => /^\s*0+(\.0+)?\s*(px)?\s*$/i.test(attr ?? "");
  if ((tiny(width, "width") && tiny(height, "height")) || zero(width) || zero(height)) return true;
  try {
    const u = new URL(src.trim());
    return TRACKER_HOSTS.test(u.hostname) || TRACKER_PATHS.test(u.pathname);
  } catch {
    return false;
  }
}

/** What an email's HTML from Rust (mail.rs MailHtml) reads as: its own text, or its bytes in their charset; "" for none. */
export function readMailHtml(raw: unknown): string {
  const got = (raw ?? {}) as { html?: unknown; bytes?: unknown; charset?: unknown };
  if (typeof got.html === "string" && got.html) return got.html;
  if (typeof got.bytes !== "string" || !got.bytes) return "";
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(got.bytes), (c) => c.charCodeAt(0));
  } catch {
    return "";
  }
  const label = typeof got.charset === "string" ? got.charset.trim() : "";
  try {
    return new TextDecoder(label || "utf-8").decode(bytes);
  } catch {
    // A charset no browser knows: read as UTF-8, what most mail is.
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** Whether an attribute of an email's element is dropped: event handlers, links to scripts, and the ones below. */
export function droppedAttribute(name: string, value: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith("on")) return true;
  // A shadow root declared in the HTML would hold a page this cleaning never sees;
  // a name would stand for the frame's own methods (document.addEventListener…).
  if (n === "shadowrootmode" || n === "shadowroot" || n === "name") return true;
  // Lumo's own marks (data-lumo-src: an image to load): never the email's.
  if (n.startsWith("data-lumo-")) return true;
  if (n === "href" || n === "src" || n === "action" || n === "formaction" || n === "xlink:href") {
    return /^\s*(javascript|vbscript|data:text\/html)/i.test(value.replace(/[\u0000-\u001f]/g, ""));
  }
  return false;
}

/** The style the frame adds: a white page, the hidden images as a grey box with an image's sign. */
export const EMAIL_FRAME_STYLE = `
html { background: #fff; overflow-y: hidden; }
body { margin: 0; padding: 12px 14px; background: #fff; color: #1f2329; font: 14px/1.5 -apple-system, "Segoe UI", system-ui, sans-serif; overflow-wrap: break-word; }
img[data-lumo-src] { background: #eef0f3 url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 24 24' fill='none' stroke='%23a3a9b3' stroke-width='1.6'%3E%3Crect x='3' y='5' width='18' height='14' rx='2'/%3E%3Ccircle cx='9' cy='10' r='1.6'/%3E%3Cpath d='M4 17l5-5 4 4 3-3 4 4'/%3E%3C/svg%3E") center / 22px no-repeat; border-radius: 6px; }
img[data-lumo-src][width="1"], img[data-lumo-src][height="1"] { background: none; }
img[data-lumo-src][data-lumo-box="h"] { height: 48px !important; }
img[data-lumo-src][data-lumo-box="wh"] { width: 48px !important; height: 48px !important; }
a { cursor: pointer; }
`;
