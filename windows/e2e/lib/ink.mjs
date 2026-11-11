// Whether a box that holds a formula cuts its ink: a subscript, a fraction's
// bottom, the last letter's lean. The box is photographed as it shows, then
// with nothing cut (overflow visible); a box that hides some of the formula
// looks different the second time. Its fade at a wide formula's edge is
// taken off both times: it is meant to hide, a cut is not.
//
// Only the WebDriver's js() and shot() are used, so the same check runs
// against the page in a browser when the WebView is not at hand.

import { decodePng, pixelsChanged } from "./png.mjs";
import { sleep } from "./driver.mjs";

/** The boxes that hold a formula and hide what goes past them. */
export const FORMULA_BOXES = [".md-math-scroll", ".rc-steps-formula", ".rc-steps-prev-tex", ".rc-steps-row-what", ".rc-head-tex"];

/** Room around the box that the photo takes in, in CSS pixels: where a cut letter would go on. */
const AROUND = 12;

// Nothing moves between the two photos, and the copy button that shows on
// hover stays out of them.
const STILL = `.chat-log *, .chat-log *::before, .chat-log *::after { transition: none !important; animation: none !important; }
.chat-log .md-copy { visibility: hidden !important; }
[data-e2e-ink] { -webkit-mask-image: none !important; mask-image: none !important; }`;
const UNCUT = `${STILL}
[data-e2e-ink] { overflow: visible !important; text-overflow: clip !important; }`;

const STYLE = `
let s = document.getElementById('e2e-ink');
if (!s) { s = document.createElement('style'); s.id = 'e2e-ink'; document.head.append(s); }
s.textContent = arguments[0];`;

/** How many of each box are on screen (shown, not in a hidden step). */
export async function boxesShown(d, selectors = FORMULA_BOXES) {
  return d.js(
    `return arguments[0].map((sel) => [...document.querySelectorAll(sel)].map((el, k) => {
      const r = el.getBoundingClientRect();
      const hidden = el.closest('[inert], [hidden], [aria-hidden="true"]') || r.width < 2 || r.height < 2;
      return hidden ? -1 : k;
    }).filter((k) => k >= 0).map((k) => ({ sel, k }))).flat();`,
    selectors,
  );
}

/**
 * The pixels around the `k`-th box for `sel` that change once nothing of it
 * is cut: 0 when it shows all of its formula. `pngs`: the two photos.
 */
export async function inkCut(d, sel, k) {
  const place = await d.js(
    `${STYLE}
    for (const e of document.querySelectorAll('[data-e2e-ink]')) e.removeAttribute('data-e2e-ink');
    const el = document.querySelectorAll(arguments[1])[arguments[2]];
    if (!el) return null;
    el.setAttribute('data-e2e-ink', '');
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect(), z = devicePixelRatio, a = arguments[3];
    const x = Math.max(0, r.left - a), y = Math.max(0, r.top - a);
    const w = Math.min(innerWidth, r.right + a) - x, h = Math.min(innerHeight, r.bottom + a) - y;
    return { box: { x: x * z, y: y * z, w: w * z, h: h * z }, tex: el.textContent.trim().slice(0, 60) };`,
    STILL,
    sel,
    k,
    AROUND,
  );
  if (!place) throw new Error(`no ${sel} #${k} on the page`);
  await sleep(120);
  const shown = await d.shot();
  await d.js(STYLE, UNCUT);
  await sleep(120);
  const uncut = await d.shot();
  await d.js(STYLE, "");
  const changed = pixelsChanged(decodePng(shown), decodePng(uncut), place.box);
  return { sel, k, tex: place.tex, changed, pngs: { shown, uncut } };
}

/** Every box on screen checked: the ones that cut, with their pixels. */
export async function cutBoxes(d, selectors = FORMULA_BOXES) {
  const cut = [];
  const boxes = await boxesShown(d, selectors);
  for (const { sel, k } of boxes) {
    const r = await inkCut(d, sel, k);
    if (r.changed > 0) cut.push(r);
  }
  return { checked: boxes.length, cut };
}
