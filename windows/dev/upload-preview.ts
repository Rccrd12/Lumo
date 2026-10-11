// Dev harness: plays the whole drop sequence in a plain browser so the
// choreography can be watched without an OLE drag. Not part of the app bundle.
// `?t=2.5` stops the clock there, for a screenshot.

import { UploadCanvas } from "../src/upload/canvas";
import { UploadSeq } from "../src/upload/sequence";
import { State } from "../src/core/state";

State.droppedFile = { name: "rapport-q3.pdf", path: "C:/tmp/rapport-q3.pdf" };

const stage = document.getElementById("stage")!;
const clock = document.getElementById("clock")!;

// `?w=560&h=160` plays it on an island of that size (the smallest one).
const params = new URLSearchParams(location.search);
const islandW = Number(params.get("w") ?? 640);
const islandH = Number(params.get("h") ?? 176);
stage.style.width = `${islandW}px`;
stage.style.height = `${islandH}px`;

const canvas = new UploadCanvas();
canvas.el.classList.add("on");
canvas.el.style.position = "absolute";
const placed = canvas.place(islandW, islandH);
UploadSeq.reachX = placed.reachX;
UploadSeq.reachY = placed.reachY;
stage.append(canvas.el);

// The cursor walks in from the right, settles over the box, then drops.
// The whole thing restarts every 12 s so it can be watched (and screenshotted)
// without reloading the page.
const CYCLE = 12;
let start = performance.now();
let dropped = false;
UploadSeq.enterZone(520, 96);

const frozen = params.has("t") ? Number(params.get("t")) : null;

function loop(now: number) {
  let t = (now - start) / 1000;
  if (frozen != null && t >= frozen) {
    clock.textContent = `t = ${frozen.toFixed(2)} s`;
    return;
  }
  if (t >= CYCLE) {
    start = now;
    t = 0;
    dropped = false;
    UploadSeq.enterZone(520, 96);
  }
  if (!dropped) {
    const x = 520 - Math.min(1, t / 0.9) * 260;
    UploadSeq.updateCursor(x, 96);
    if (t >= 1.2) {
      dropped = true;
      UploadSeq.performDrop(2.4);
    }
  }
  canvas.draw(UploadSeq.frame(), now / 1000);
  clock.textContent = `t = ${t.toFixed(2)} s${dropped ? "  (dropped)" : "  (dragging)"}`;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
