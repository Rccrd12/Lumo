// The computer use overlay: a window over the screen Claude works on
// (computer.rs), click-through and left out of every screenshot. It draws a
// glow around the screen while Claude uses the computer, a halo that follows
// Claude's mouse as it glides, and what each action does: rings for clicks, a
// trail for drags, chevrons for scrolling, a bubble for typed text and keys.
//
// Rust moves the real mouse on the same curve and over the same time as the
// halo here (fx.ts ease), so the two land together.

import "./computer.css";
import { onEvent } from "../core/bridge";
import { along, keyCaps, toCss, typedTail, type Fx } from "./fx";

const root = document.createElement("div");
root.id = "fx";
const glow = document.createElement("div");
glow.className = "glow";
const halo = document.createElement("div");
halo.className = "halo";
root.append(glow, halo);
document.body.append(root);
// The window is only shown while Claude uses the computer: on at once.
root.className = "on";

const SVG = "http://www.w3.org/2000/svg";

/** Where Claude's mouse is, in CSS pixels; null before its first move. */
let at: { x: number; y: number } | null = null;
let glide: number | null = null;
let bubble: HTMLElement | null = null;
let bubbleText = "";
let bubbleTimer: number | null = null;

const css = (p: [number, number]) => toCss(p, window.devicePixelRatio || 1);

function place(el: HTMLElement | SVGElement, p: { x: number; y: number }) {
  el.style.left = `${p.x}px`;
  el.style.top = `${p.y}px`;
}

function setHalo(p: { x: number; y: number }, moving: boolean) {
  at = p;
  halo.style.transform = `translate(${p.x}px, ${p.y}px)`;
  halo.classList.add("on");
  halo.classList.toggle("idle", !moving);
}

/** Adds `el`, and takes it away after `ms`. */
function flash(el: Element, ms: number) {
  root.append(el);
  window.setTimeout(() => el.remove(), ms);
}

function glideTo(from: { x: number; y: number }, to: { x: number; y: number }, ms: number, onEnd?: () => void) {
  if (glide != null) cancelAnimationFrame(glide);
  const start = performance.now();
  const step = (now: number) => {
    const elapsed = now - start;
    setHalo(along(from, to, elapsed, ms), elapsed < ms);
    if (elapsed < ms) {
      glide = requestAnimationFrame(step);
    } else {
      glide = null;
      onEnd?.();
    }
  };
  glide = requestAnimationFrame(step);
}

function rings(p: { x: number; y: number }, button: string, count: number) {
  for (let i = 0; i < Math.max(1, count); i++) {
    window.setTimeout(() => {
      const ring = document.createElement("div");
      ring.className = `ring ${button}`;
      place(ring, p);
      flash(ring, 600);
    }, i * 110);
  }
  const dot = document.createElement("div");
  dot.className = "dot";
  place(dot, p);
  flash(dot, 500);
}

function trail(from: { x: number; y: number }, to: { x: number; y: number }, ms: number) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "trail");
  const line = document.createElementNS(SVG, "line");
  line.setAttribute("x1", String(from.x));
  line.setAttribute("y1", String(from.y));
  line.setAttribute("x2", String(to.x));
  line.setAttribute("y2", String(to.y));
  svg.append(line);
  flash(svg, ms + 900);
}

function scrollMark(p: { x: number; y: number }, dx: number, dy: number) {
  const el = document.createElement("div");
  const vertical = dy !== 0;
  el.className = vertical ? "scroll" : "scroll h";
  const glyph = vertical ? (dy > 0 ? "︿" : "﹀") : dx > 0 ? "›" : "‹";
  for (let i = 0; i < 3; i++) {
    const s = document.createElement("span");
    s.textContent = glyph;
    el.append(s);
  }
  place(el, p);
  flash(el, 900);
}

/** The bubble beside the mouse: what is typed, or the keys pressed. */
function showBubble(p: { x: number; y: number }, fill: (el: HTMLElement) => void) {
  if (!bubble) {
    bubble = document.createElement("div");
    bubble.className = "bubble";
    root.append(bubble);
  }
  bubble.classList.remove("out");
  place(bubble, p);
  bubble.replaceChildren();
  fill(bubble);
  if (bubbleTimer != null) window.clearTimeout(bubbleTimer);
  bubbleTimer = window.setTimeout(() => {
    bubble?.classList.add("out");
    bubbleTimer = window.setTimeout(() => {
      bubble?.remove();
      bubble = null;
      bubbleText = "";
    }, 400);
  }, 1400);
}

let typing: number | null = null;

/** The text appears in the bubble a little at a time, as it is typed. */
function typed(p: { x: number; y: number }, text: string) {
  if (typing != null) window.clearInterval(typing);
  const chars = [...text];
  const per = Math.max(1, Math.ceil(chars.length / 40));
  let shown = 0;
  const draw = () => {
    showBubble(p, (el) => {
      const glyph = document.createElement("span");
      glyph.textContent = "⌨";
      const words = document.createElement("span");
      words.textContent = typedTail(bubbleText);
      const caret = document.createElement("i");
      caret.className = "caret";
      el.append(glyph, words, caret);
    });
  };
  typing = window.setInterval(() => {
    const next = chars.slice(shown, shown + per).join("");
    shown += per;
    bubbleText += next;
    draw();
    if (shown >= chars.length && typing != null) {
      window.clearInterval(typing);
      typing = null;
    }
  }, 28);
}

function keys(p: { x: number; y: number }, combo: string) {
  bubbleText = "";
  showBubble(p, (el) => {
    keyCaps(combo).forEach((cap, i) => {
      if (i > 0) {
        const plus = document.createElement("span");
        plus.className = "plus";
        plus.textContent = "+";
        el.append(plus);
      }
      const kbd = document.createElement("kbd");
      kbd.textContent = cap;
      el.append(kbd);
    });
  });
}

function waitRing(p: { x: number; y: number }, ms: number) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "wait");
  svg.setAttribute("viewBox", "0 0 40 40");
  const circle = document.createElementNS(SVG, "circle");
  circle.setAttribute("cx", "20");
  circle.setAttribute("cy", "20");
  circle.setAttribute("r", "16");
  const length = 2 * Math.PI * 16;
  circle.setAttribute("stroke-dasharray", String(length));
  circle.setAttribute("stroke-dashoffset", String(length));
  svg.append(circle);
  place(svg, p);
  root.append(svg);
  circle.animate([{ strokeDashoffset: length }, { strokeDashoffset: 0 }], { duration: ms, easing: "linear", fill: "forwards" });
  window.setTimeout(() => svg.remove(), ms + 200);
}

function handle(fx: Fx) {
  switch (fx.kind) {
    case "show":
      root.style.display = "";
      root.className = "on";
      break;
    case "resume":
      root.classList.remove("paused");
      break;
    case "pause":
      root.classList.add("paused");
      break;
    case "hide":
      root.className = "";
      halo.classList.remove("on", "idle");
      at = null;
      // Faded out: nothing left to animate while the window is hidden.
      window.setTimeout(() => {
        if (!root.classList.contains("on")) root.style.display = "none";
      }, 500);
      break;
    case "stopped":
      root.classList.add("stopped");
      break;
    case "look":
      glow.classList.remove("flash");
      void glow.offsetWidth;
      glow.classList.add("flash");
      break;
    case "move":
      glideTo(at ?? css(fx.from), css(fx.to), fx.ms);
      break;
    case "drag": {
      const from = css(fx.from);
      const to = css(fx.to);
      setHalo(from, true);
      trail(from, to, fx.ms);
      rings(from, "left", 1);
      glideTo(from, to, fx.ms, () => rings(to, "left", 1));
      break;
    }
    case "click": {
      const p = css(fx.at);
      setHalo(p, false);
      rings(p, fx.button, fx.count);
      break;
    }
    case "scroll":
      scrollMark(css(fx.at), fx.dx, fx.dy);
      break;
    case "type":
      typed(css(fx.at), fx.text);
      break;
    case "key":
      keys(css(fx.at), fx.keys);
      break;
    case "wait":
      waitRing(css(fx.at), fx.ms);
      break;
  }
}

void onEvent<Fx>("computer-fx", handle);
// `npm run dev` in a browser: the effects can be tried by hand.
if (import.meta.env.DEV) (window as unknown as { lumoFx: typeof handle }).lumoFx = handle;
