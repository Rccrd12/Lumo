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
export const DROPPED_TAGS = ["script", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "link", "meta", "form", "portal"];

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
 * the site and the path, without the query that tracks the click. "" for a
 * link that goes nowhere a click takes.
 */
export function linkLabel(href: string): string {
  if (!opensInBrowser(href)) return "";
  try {
    const u = new URL(href.trim());
    const path = u.pathname === "/" ? "" : decodeURI(u.pathname).replace(/\/$/, "");
    const label = `${u.hostname}${path}`;
    return label.length > 80 ? `${label.slice(0, 79)}…` : label;
  } catch {
    return "";
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
 * when the email gives both; with only a width, "h" (48 px tall rather than a
 * square); with neither, "wh" (48 × 48).
 */
export function hiddenBox(width: string | null, height: string | null, style: string): "" | "h" | "wh" {
  const has = (attr: string | null, prop: string) => (attr != null && attr.trim() !== "") || new RegExp(`(^|;)\\s*${prop}\\s*:`, "i").test(style);
  const w = has(width, "width");
  const hh = has(height, "height");
  if (hh) return "";
  return w ? "h" : "wh";
}

/** Whether an attribute of an email's element is dropped: event handlers, and links to scripts. */
export function droppedAttribute(name: string, value: string): boolean {
  const n = name.toLowerCase();
  if (n.startsWith("on")) return true;
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
