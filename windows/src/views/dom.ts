// Minimal DOM helpers — no framework, as specified.

import { Msg, onLanguageChange } from "../i18n/i18n";

type Attrs = Record<string, string | number | boolean | EventListener | Msg | undefined>;
type Child = Node | string | Msg | null | undefined | false;

// ── Text that follows the language ────────────────────────────────────────────
//
// A `tl(…)` string given to h() — as `text`, an attribute (title, placeholder,
// aria-label…) or a child — is remembered with the node it went to. When the
// language changes, every such node still showing what it was given is
// redrawn in place: nothing is rebuilt, so no view loses its state. A node
// whose text some code has replaced since is left alone (and forgotten).

interface Binding {
  node: WeakRef<Node>;
  /** "text" (an element's text or a text node's data) or an attribute name. */
  attr: string;
  msg: Msg;
  /** What was last written, to notice when other code has written over it. */
  shown: string;
}

const bindings = new Set<Binding>();
let sincePrune = 0;

function read(node: Node, attr: string): string | null {
  if (attr === "text") return node.nodeType === 3 ? (node as Text).data : node.textContent;
  return (node as Element).getAttribute(attr);
}

function write(node: Node, attr: string, value: string) {
  if (attr === "text") {
    if (node.nodeType === 3) (node as Text).data = value;
    else node.textContent = value;
  } else {
    (node as Element).setAttribute(attr, value);
  }
}

function bind(node: Node, attr: string, msg: Msg, shown: string) {
  bindings.add({ node: new WeakRef(node), attr, msg, shown });
  // Views rebuild rows all the time: drop what has been collected now and then.
  if (++sincePrune >= 500) {
    sincePrune = 0;
    for (const b of bindings) if (!b.node.deref()) bindings.delete(b);
  }
}

/** Redraws every live `tl(…)` text in the current language. */
export function relabel() {
  for (const b of bindings) {
    const node = b.node.deref();
    if (!node || read(node, b.attr) !== b.shown) {
      bindings.delete(b);
      continue;
    }
    const next = String(b.msg);
    if (next !== b.shown) {
      write(node, b.attr, next);
      b.shown = next;
    }
  }
}

/** How many texts follow the language (tests). */
export function liveTextCount(): number {
  return bindings.size;
}

onLanguageChange(() => relabel());

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (v instanceof Msg) {
      const text = String(v);
      write(el, k, text);
      bind(el, k, v, text);
      continue;
    }
    if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "style") el.setAttribute("style", String(v));
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    if (c instanceof Msg) {
      const node = document.createTextNode(String(c));
      bind(node, "text", c, String(c));
      el.append(node);
      continue;
    }
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

export function svg(
  path: string,
  size = 14,
  opts: { fill?: string; stroke?: number; evenOdd?: boolean } = {},
): SVGSVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 24 24");
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  // Settings › Icon size scales the icons; the tiny marks inside badges and
  // text rows stay as they are, or they would outgrow what holds them.
  if (size >= 10) {
    el.style.width = el.style.height = `calc(${size}px * var(--icon-scale, 1))`;
    el.style.flex = "none";
  }
  el.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", path);
  if (opts.stroke) {
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", "currentColor");
    p.setAttribute("stroke-width", String(opts.stroke));
    p.setAttribute("stroke-linecap", "round");
    p.setAttribute("stroke-linejoin", "round");
  } else {
    p.setAttribute("fill", opts.fill ?? "currentColor");
    // Lets a filled glyph carry a cut-out (checkmark.seal.fill, xmark.octagon.fill).
    if (opts.evenOdd) p.setAttribute("fill-rule", "evenodd");
  }
  el.append(p);
  return el;
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Card dot used in every "who" row. */
export function dot(color: string, size = 7): HTMLElement {
  return h("i", {
    class: "dot",
    style: `width:${size}px;height:${size}px;background:${color}`,
  });
}

/** A mouse wheel notch scrolls this share of what the webview would (about 100 px on Windows). */
const WHEEL_SHARE = 0.4;
/** Deltas this small come from a touchpad, already fine-grained: left to the webview. */
const FINE_DELTA_PX = 40;

/** Whether something inside `root`, under the pointer, scrolls by itself that way (a code block). */
function innerScroller(target: EventTarget | null, root: HTMLElement, down: boolean): boolean {
  for (let n = target instanceof Element ? target : null; n && n !== root; n = n.parentElement) {
    if (n.scrollHeight <= n.clientHeight + 1) continue;
    const overflow = getComputedStyle(n).overflowY;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    if (down ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0) return true;
  }
  return false;
}

/**
 * A mouse wheel that scrolls `el` in smaller steps, gliding to each: a notch
 * of the wheel went most of the way down a short chat. A touchpad's fine
 * deltas, Ctrl (zoom) and Shift (sideways) are left as they were.
 */
export function gentleWheel(el: HTMLElement) {
  let target = 0;
  let pos = 0;
  let frame = 0;
  const stop = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  };
  const step = () => {
    frame = 0;
    // Moved by something else meanwhile (a chat opening at its end): that wins.
    if (Math.abs(el.scrollTop - Math.round(pos)) > 2) return;
    const max = Math.max(0, el.scrollHeight - el.clientHeight);
    target = Math.min(Math.max(target, 0), max);
    const left = target - pos;
    pos = Math.abs(left) < 0.5 ? target : pos + left * 0.35;
    el.scrollTop = pos;
    if (pos !== target) frame = requestAnimationFrame(step);
  };
  el.addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.shiftKey || e.deltaY === 0) return;
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * el.clientHeight : e.deltaY;
    if (Math.abs(dy) < FINE_DELTA_PX || innerScroller(e.target, el, dy > 0)) {
      stop();
      return;
    }
    e.preventDefault();
    if (!frame) {
      pos = el.scrollTop;
      target = pos;
    }
    target += dy * WHEEL_SHARE;
    if (!frame) frame = requestAnimationFrame(step);
  }, { passive: false });
}
