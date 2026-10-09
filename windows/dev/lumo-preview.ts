// Dev harness: Lumo in every state, a few emotes and every outfit, big enough
// to judge the drawing. `npm run dev`, then open /dev/lumo-preview.html.
// `?size=40` draws them small, as in the island; `?look=punto` (goccia,
// lucciola) another of his looks than Filo. Not shipped in the app.

import { BotEngine } from "../src/mochi/engine";
import { OUTFIT_SELECTIONS, parseLook, type Outfit } from "../src/mochi/wardrobe";
const OUTFITS = OUTFIT_SELECTIONS.filter((o): o is Outfit => o !== "auto" && o !== "none");
import type { BotEmoteName, BotStateName } from "../src/core/layout";

const params = new URLSearchParams(location.search);
const size = Number(params.get("size") ?? 150);
const look = parseLook(params.get("look"));
const grid = document.getElementById("grid")!;
const engines: { e: BotEngine; c: HTMLCanvasElement }[] = [];

function add(label: string, setup: (e: BotEngine) => void) {
  const c = document.createElement("canvas");
  const dpr = window.devicePixelRatio || 1;
  c.width = size * dpr;
  c.height = size * 1.3 * dpr;
  c.style.width = `${size}px`;
  c.style.height = `${size * 1.3}px`;
  const e = new BotEngine();
  e.look = look;
  e.particleOverhang = size * 0.3;
  setup(e);
  const f = document.createElement("figure");
  f.append(c, document.createElement("br"), label);
  grid.append(f);
  engines.push({ e, c });
}

const states: BotStateName[] = [
  "idle", "working", "thinking", "searching", "approval", "question", "error", "finished", "ratelimit", "sleeping", "dizzy",
];
for (const s of states) add(s, (e) => e.setState(s, true));
const emotes: BotEmoteName[] = ["love", "happy", "wink", "surprised", "proud", "yawn", "annoyed"];
for (const m of emotes) add(m, (e) => e.setPermanentEmote(m));
for (const o of OUTFITS) add(`outfit ${o}`, (e) => e.setOutfit(o, false));

function loop() {
  for (const { e, c } of engines) {
    e.update(1 / 60);
    const x = c.getContext("2d")!;
    const dpr = window.devicePixelRatio || 1;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.clearRect(0, 0, c.width, c.height);
    e.draw(x, size, size * 1.3);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
