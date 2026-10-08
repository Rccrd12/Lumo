// Ctrl + / Ctrl − / Ctrl 0 in the island (src/core/layout.ts zoomStep).

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ISLAND_ZOOM, MAX_ISLAND_ZOOM, MIN_ISLAND_ZOOM, zoomStep } from "../src/core/layout.ts";

test("plus and minus step by 10 %, within the range; 0 is the usual size", () => {
  assert.equal(zoomStep("+", 1.15), 1.25);
  assert.equal(zoomStep("=", 1), 1.1);
  assert.equal(zoomStep("-", 1.15), 1.05);
  assert.equal(zoomStep("+", MAX_ISLAND_ZOOM), MAX_ISLAND_ZOOM);
  assert.equal(zoomStep("-", MIN_ISLAND_ZOOM), MIN_ISLAND_ZOOM);
  assert.equal(zoomStep("0", 1.5), DEFAULT_ISLAND_ZOOM);
  assert.equal(zoomStep("+", Number.NaN), 1.25);
  assert.equal(zoomStep("a", 1), null);
});
