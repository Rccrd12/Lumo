// Lumo's wardrobe: season → outfit, stored preference → outfit (src/mochi/wardrobe.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OUTFIT_SELECTIONS, OUTFIT_LABELS, SeasonCache, parseOutfit, resolveOutfit,
  seasonalOutfit, wardrobeHeader,
} from "../src/mochi/wardrobe.ts";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";

/** A local calendar day, at noon so no time zone can push it into the next one. */
const day = (y, m, d) => new Date(y, m - 1, d, 12);
const season = (y, m, d) => seasonalOutfit(day(y, m, d));

test("the scarf from December 1 to the end of February", () => {
  assert.equal(season(2026, 11, 30), "none");
  assert.equal(season(2026, 12, 1), "scarf");
  assert.equal(season(2027, 1, 15), "scarf");
  assert.equal(season(2028, 2, 29), "scarf");
  assert.equal(season(2027, 3, 1), "none");
});

test("the leaf from March 20 to May 31", () => {
  assert.equal(season(2027, 3, 19), "none");
  assert.equal(season(2027, 3, 20), "leaf");
  assert.equal(season(2027, 4, 30), "leaf");
  assert.equal(season(2027, 5, 31), "leaf");
  assert.equal(season(2027, 6, 1), "none");
});

test("nothing in summer and autumn", () => {
  for (const [m, d] of [[6, 21], [8, 15], [10, 31], [11, 1]]) assert.equal(season(2026, m, d), "none");
});

test("midnight and late evening count as the same calendar day", () => {
  assert.equal(seasonalOutfit(new Date(2027, 2, 20, 0, 0)), "leaf");
  assert.equal(seasonalOutfit(new Date(2027, 2, 19, 23, 59)), "none");
});

test("auto dresses for the season, any other choice is worn as is", () => {
  const d = day(2027, 1, 15);
  assert.equal(resolveOutfit("auto", d), "scarf");
  assert.equal(resolveOutfit("none", d), "none");
  assert.equal(resolveOutfit("headphones", d), "headphones");
});

test("the stored values, in the wardrobe's order", () => {
  assert.deepEqual([...OUTFIT_SELECTIONS], [
    "auto", "none", "leaf", "roundGlasses", "bowTie", "headphones", "scarf",
  ]);
  for (const sel of OUTFIT_SELECTIONS) assert.ok(OUTFIT_LABELS[sel], `${sel} has a label`);
});

test("a stored preference is read back as it was saved", () => {
  for (const sel of OUTFIT_SELECTIONS) assert.equal(parseOutfit(sel), sel);
});

test("Mochi's old outfits, unknown or missing preferences mean auto", () => {
  for (const raw of ["partyHat", "beanie", "crown", "sunglasses", "bow", "witchHat", "pumpkin", "santaHat",
    "bunnyEars", "topHat", "totallyUnknown", "", "Scarf"]) {
    assert.equal(parseOutfit(raw), "auto", JSON.stringify(raw));
  }
  for (const raw of [undefined, null, 42, true, {}, ["scarf"]]) {
    assert.equal(parseOutfit(raw), "auto", String(raw));
  }
});

test("preferences from before the wardrobe start on auto", () => {
  assert.equal(DEFAULT_SETTINGS.mochiOutfit, "auto");
  // What main.ts does with a settings.json that has no mochiOutfit key.
  const old = { soundEnabled: false, model: "x" };
  const merged = { ...DEFAULT_SETTINGS, ...old };
  assert.equal(parseOutfit(merged.mochiOutfit), "auto");
});

test("the wardrobe header names the hovered outfit, else the current choice", () => {
  const d = day(2027, 1, 15);
  assert.equal(wardrobeHeader(null, "auto", d), "Auto · Scarf");
  assert.equal(wardrobeHeader(null, "leaf", d), "Leaf");
  assert.equal(wardrobeHeader("auto", "leaf", d), "Auto · follows the seasons (now: Scarf)");
  assert.equal(wardrobeHeader("bowTie", "auto", d), "Bow tie");
  assert.equal(wardrobeHeader(null, "auto", day(2026, 7, 1)), "Auto · None");
});

test("the per-frame season lookup follows the calendar day", () => {
  const cache = new SeasonCache();
  assert.equal(cache.get("auto", day(2026, 11, 30)), "none");
  assert.equal(cache.get("auto", new Date(2026, 11, 1, 0, 0, 1)), "scarf");
  assert.equal(cache.get("headphones", day(2026, 12, 1)), "headphones");
  assert.equal(cache.get("auto", day(2027, 4, 2)), "leaf");
});
