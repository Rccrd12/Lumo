// The computer use test (/test in the chat, src-tauri/src/computer_test.rs):
// a window over the whole screen with nine numbered circles, a cross in each
// centre, at the same fractions of the screen Rust measures the clicks against
// (TARGETS there). Each click that reaches this window gets a small dot and
// its number: where the click really landed, for the user to see. No IPC:
// Rust knows the targets and records the clicks itself.

/** Each circle's centre, as fractions of the window (computer_test.rs TARGETS, same order). */
export const TARGETS: ReadonlyArray<readonly [number, number]> = [
  [0.08, 0.12], [0.5, 0.18], [0.92, 0.1],
  [0.18, 0.5], [0.63, 0.42], [0.87, 0.6],
  [0.07, 0.86], [0.41, 0.8], [0.94, 0.88],
];

/** A circle's radius, as a fraction of the window's shorter side (computer_test.rs RADIUS). */
export const RADIUS = 0.018;

const SVG = "http://www.w3.org/2000/svg";
const svg = document.createElementNS(SVG, "svg");
svg.setAttribute("width", "100%");
svg.setAttribute("height", "100%");
svg.style.position = "fixed";
svg.style.inset = "0";
document.body.append(svg);

function el(name: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text != null) e.textContent = text;
  svg.append(e);
  return e;
}

let clicks = 0;

function draw(): void {
  svg.replaceChildren();
  clicks = 0;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const r = Math.max(8, RADIUS * Math.min(w, h));
  el("text", { x: w / 2, y: h * 0.97, "text-anchor": "middle", fill: "#9aa0a6", "font-size": 15 },
    "Test di Lumo: cliccare il centro dei cerchi da 1 a 9 · Esc per fermare");
  TARGETS.forEach(([fx, fy], i) => {
    const x = fx * w;
    const y = fy * h;
    el("circle", { cx: x, cy: y, r, fill: "#ff453a", stroke: "#ffffff", "stroke-width": 2 });
    el("line", { x1: x - r * 0.6, y1: y, x2: x + r * 0.6, y2: y, stroke: "#ffffff", "stroke-width": 1.5 });
    el("line", { x1: x, y1: y - r * 0.6, x2: x, y2: y + r * 0.6, stroke: "#ffffff", "stroke-width": 1.5 });
    // The number beside the circle, toward the screen's middle, so it never leaves the screen.
    const lx = fx < 0.5 ? x + r * 1.5 : x - r * 1.5;
    el("text", {
      x: lx, y: y + 9, "text-anchor": fx < 0.5 ? "start" : "end",
      fill: "#ffffff", "font-size": 26, "font-weight": 700,
    }, String(i + 1));
  });
}

draw();
window.addEventListener("resize", draw);
window.addEventListener("mousedown", (e) => {
  clicks += 1;
  el("circle", { cx: e.clientX, cy: e.clientY, r: 4, fill: "#32d7ff" });
  el("text", { x: e.clientX + 7, y: e.clientY - 7, fill: "#32d7ff", "font-size": 13, "font-weight": 600 }, `#${clicks}`);
});
window.addEventListener("contextmenu", (e) => e.preventDefault());
