// Gemini Live's pointer (pointer.html, pointer.rs): an arrow that glides to
// the spot the model picked, presses once, and rings around it, with a few
// words beside it. Drawn with CSS only; it plays when Rust says to and fades
// when Rust says so, and nothing moves in between.

import "./pointer.css";
import { Bridge, onEvent, type Pointing } from "../core/bridge";
import { h } from "../views/dom";

const root = document.getElementById("pointer")!;

/** The classic arrow, its tip at (2, 2). */
const ARROW =
  '<svg class="arrow" viewBox="0 0 30 38" aria-hidden="true">' +
  '<path d="M2 2 L2 30 L9.5 23.2 L14.6 35 L19.4 32.9 L14.4 21.4 L24.6 21.4 Z" ' +
  'fill="#ffffff" stroke="#0b1f26" stroke-width="2" stroke-linejoin="round"/></svg>';

const text = h("span");
const label = h("div", { class: "label" }, h("i"), text);
root.append(h("div", { class: "halo" }), h("div", { class: "ring r1" }), h("div", { class: "ring r2" }), h("div", { class: "ring r3" }));
root.insertAdjacentHTML("beforeend", ARROW);
root.append(label);

let shown = 0;
let fading: ReturnType<typeof setTimeout> | undefined;

function show(p: Pointing) {
  if (p.seq === shown) return;
  shown = p.seq;
  clearTimeout(fading);
  text.textContent = p.label;
  label.hidden = !p.label;
  root.classList.toggle("flip-x", p.flipX);
  root.classList.toggle("flip-y", p.flipY);
  // Played from the start each time, even over one still showing.
  root.classList.remove("on", "out");
  void root.offsetWidth;
  root.classList.add("on");
}

function hide() {
  root.classList.add("out");
  clearTimeout(fading);
  fading = setTimeout(() => root.classList.remove("on", "out"), 450);
}

void onEvent<Pointing>("pointer-show", show);
void onEvent("pointer-hide", hide);
// Made for a pointing that was asked for before this page could hear it.
void Bridge.livePointerCurrent().then((p) => {
  if (p) show(p);
});
