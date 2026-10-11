// The drop sequence on any island size (src/upload/canvas.ts uploadStage),
// and its bar carried on by the closed island (src/core/compact.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadCard, uploadStage } from "../src/upload/canvas.ts";
import { USC } from "../src/upload/sequence.ts";
import { CompactFeed } from "../src/core/compact.ts";
import { MIN_ISLAND_H, MIN_ISLAND_W, botPosition } from "../src/core/layout.ts";

/** The scene's card, where the stage puts it in the island. */
function sceneCard(st) {
  return {
    left: st.ox + USC.CARD_X * st.s,
    right: st.ox + (USC.CARD_X + USC.CARD_W) * st.s,
    top: st.oy + USC.CARD_Y * st.s,
    bottom: st.oy + (USC.CARD_Y + USC.CARD_H) * st.s,
  };
}

test("the scene keeps its size on the usual island and a bigger one", () => {
  assert.deepEqual(uploadStage(640, 176), { w: 640, h: 176, s: 1, ox: 0, oy: 0, reachX: 0, reachY: 0 });
  const big = uploadStage(1040, 300);
  assert.equal(big.s, 1);
  assert.equal(big.ox, 200);
  assert.equal(big.oy, 62);
  assert.equal(big.reachX, 200);
  assert.equal(big.reachY, 62);
});

test("the smallest island: the card, its dashes and the bar stay inside it", () => {
  const st = uploadStage(MIN_ISLAND_W, MIN_ISLAND_H);
  assert.equal(st.w, MIN_ISLAND_W);
  assert.equal(st.h, MIN_ISLAND_H);
  assert.ok(st.s < 1);
  const card = uploadCard(st.w, st.h);
  // The dashed frame is the island's card, inset from every edge.
  assert.ok(card.x > 0 && card.x + card.w < st.w);
  assert.ok(card.y > 0 && card.y + card.h < st.h);
  // The scene (the text, the bar, Mochi) fits in that card.
  const sc = sceneCard(st);
  assert.ok(sc.left >= card.x - 0.01 && sc.right <= card.x + card.w + 0.01);
  assert.ok(sc.top >= card.y - 0.01 && sc.bottom <= card.y + card.h + 0.01);
  const barLeft = st.ox + USC.BAR_X0 * st.s;
  const barRight = st.ox + USC.BAR_X1 * st.s;
  assert.ok(barLeft > card.x + 20 && barRight < card.x + card.w - 20);
});

test("an island still opening never flips the scene", () => {
  const st = uploadStage(288, 32);
  assert.ok(st.s > 0);
  assert.equal(uploadCard(288, 32).h, 0);
});

test("the dot of the plain uploading view rides a track as long as the island", () => {
  const end = botPosition("expanded", "uploading", 176, 1, MIN_ISLAND_W);
  assert.equal(end.cx, MIN_ISLAND_W - 36);
  assert.equal(botPosition("expanded", "uploading", 176, 1).cx, 640 - 36);
});

test("the closed island shows the upload first, and nothing once it is done", () => {
  const feed = new CompactFeed();
  feed.notice("Haiku answered", "#fff", 0);
  feed.upload = { name: "notes.pdf" };
  const shown = feed.shown(null, 1);
  assert.equal(shown.items[0].kind, "upload");
  assert.equal(shown.items[0].upload.name, "notes.pdf");
  // A live activity: it shows with the notes and the music left out too.
  assert.equal(feed.shown(null, 1, { notes: false, media: false }).items[0].kind, "upload");
  feed.upload = null;
  assert.equal(feed.shown(null, 1).items[0].kind, "line");
});
