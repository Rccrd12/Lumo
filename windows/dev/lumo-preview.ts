// Dev harness: Lumo in every state, a few emotes and every outfit, big enough
// to judge the drawing. `npm run dev`, then open /dev/lumo-preview.html.
// `?size=40` draws them small, as in the island. Not shipped in the app.

import { BotEngine } from "../src/mochi/engine";
import { OUTFIT_SELECTIONS, type Outfit } from "../src/mochi/wardrobe";
const OUTFITS = OUTFIT_SELECTIONS.filter((o): o is Outfit => o !== "auto" && o !== "none");
import type { BotEmoteName, BotStateName } from "../src/core/layout";

const size = Number(new URLSearchParams(location.search).get("size") ?? 150);
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
  e.particleOverhang = size * 0.3;
  setup(e);
  const f = document.createElement("figure");
  f.append(c, document.createElement("br"), label);
  grid.append(f);
  engines.push({ e, c });
}

const states: BotStateName[] = ["idle", "working", "thinking", "approval", "question", "error", "finished", "sleeping"];
for (const s of states) add(s, (e) => e.setState(s, true));
const emotes: BotEmoteName[] = ["love", "happy", "wink", "surprised"];
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
