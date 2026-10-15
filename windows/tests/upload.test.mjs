// The drop sequence on any island size (src/upload/canvas.ts uploadStage),
// and its bar carried on by the closed island (src/core/compact.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadCard, uploadStage } from "../src/upload/canvas.ts";
import { USC, UploadSeq } from "../src/upload/sequence.ts";
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

test("Lumo waits in the card's top-left corner, whatever the island's size", () => {
  for (const [w, h] of [[640, 176], [1040, 300]]) {
    const st = uploadStage(w, h);
    UploadSeq.reachX = st.reachX;
    UploadSeq.reachY = st.reachY;
    UploadSeq.deactivate();
    UploadSeq.enterZone(500, 120);
    const f = UploadSeq.frame();
    // In island pixels: the same corner of the card on both islands.
    assert.ok(Math.abs(st.ox + f.x * st.s - USC.REST_X) < 0.5);
    assert.ok(Math.abs(st.oy + f.y * st.s - USC.REST_Y) < 0.5);
  }
  UploadSeq.deactivate();
  UploadSeq.reachX = 0;
  UploadSeq.reachY = 0;
});

test("a drag that goes off the island and back carries on instead of starting over", () => {
  // The clock is ours: Lumo has to have had time to turn into a box, since
  // carrying on and starting over differ by where his springs are.
  const realNow = performance.now.bind(performance);
  let clock = 1000;
  performance.now = () => clock;
  try {
    UploadSeq.deactivate();
    UploadSeq.enterZone(500, 120);
    clock += 400;
    const boxed = UploadSeq.frame().morph;
    assert.ok(boxed > 0.9, `Lumo is a box over the island (${boxed})`);
    UploadSeq.setOver(false);
    clock += 60;
    assert.equal(UploadSeq.frame().fileVisible, false);
    assert.equal(UploadSeq.frame().zoneOver, false);
    const left = UploadSeq.frame().morph;

    UploadSeq.enterZone(480, 110);
    assert.ok(UploadSeq.isActive);
    const f = UploadSeq.frame();
    assert.equal(f.fileVisible, true);
    assert.equal(f.zoneOver, true);
    assert.equal(f.cursorX, 480);
    // Eased on from where he was, not back to himself and in again from 0.
    assert.equal(f.morph, left);
    assert.ok(f.morph > 0.2, `carried on (${f.morph})`);
  } finally {
    performance.now = realNow;
    UploadSeq.deactivate();
  }
});
