// Settings inside the island confirm a write in Windows' own Yes / No box
// (confirmed.rs by_hand): turned down there, Rust answers "cancelled", and the
// preview stays as it was, with no error under it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { cancelledByHand, errorText } = await import("../src/settings/parts.ts");

test("Cancel in Windows' box is not an error; anything else still is", () => {
  assert.equal(cancelledByHand("cancelled"), true);
  assert.equal(cancelledByHand(new Error("cancelled")), true);
  for (const err of ["Show the changes again in Settings before applying them.", "Only Lumo's Settings can change this, after you look at the changes.", "", "cancelled by the user", null]) {
    assert.equal(cancelledByHand(err), false, String(err));
  }
  assert.equal(errorText(new Error("boom")), "boom");
});
