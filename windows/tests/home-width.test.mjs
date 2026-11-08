// The new look's home goes narrower than the other views (src/core/layout.ts
// homeWidth): its grips take the shared width below the others' narrowest,
// down to NEW_LOOK_HOME_MIN_W, unless three tiles sit side by side.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPANDED_W, MIN_ISLAND_W, NEW_LOOK_HOME_MIN_SHARED, NEW_LOOK_HOME_MIN_W, NEW_LOOK_HOME_THREE_MIN_W, NEW_LOOK_HOME_W, homeWidth, islandWidth } from "../src/core/layout.ts";

test("at the usual width the home is as wide as before", () => {
  assert.equal(homeWidth({ width: EXPANDED_W, height: 0 }, false), NEW_LOOK_HOME_W);
  assert.equal(homeWidth({ width: EXPANDED_W, height: 0 }, true), NEW_LOOK_HOME_W);
  assert.equal(homeWidth({ width: Number.NaN, height: 0 }, false), NEW_LOOK_HOME_W);
});

test("the home goes narrower than the other views, the others stay as they were", () => {
  assert.ok(NEW_LOOK_HOME_MIN_SHARED < MIN_ISLAND_W);
  assert.equal(homeWidth({ width: NEW_LOOK_HOME_MIN_SHARED, height: 0 }, false), NEW_LOOK_HOME_MIN_W);
  assert.equal(homeWidth({ width: 100, height: 0 }, false), NEW_LOOK_HOME_MIN_W);
  // A width kept that narrow leaves the other views at their narrowest.
  assert.equal(islandWidth({ width: NEW_LOOK_HOME_MIN_SHARED, height: 0 }), MIN_ISLAND_W);
});

test("three tiles in a row keep the home wide enough for them", () => {
  assert.equal(homeWidth({ width: NEW_LOOK_HOME_MIN_SHARED, height: 0 }, true), NEW_LOOK_HOME_THREE_MIN_W);
  assert.equal(homeWidth({ width: 1000, height: 0 }, true), 1000 + NEW_LOOK_HOME_W - EXPANDED_W);
});
