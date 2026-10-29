// The pills beside the overview's card (keepPillPlaces, src/core/state.ts):
// clicking one never moves the others under the mouse.

import { test } from "node:test";
import assert from "node:assert/strict";

const { keepPillPlaces } = await import("../src/core/state.ts");

const tasks = (...ids) => ids.map((id) => ({ id }));
const ids = (list) => list.map((t) => t.id);

test("the first layout follows the tasks' order, at most four", () => {
  assert.deepEqual(ids(keepPillPlaces([], tasks("a", "b", "c", "d", "e"))), ["a", "b", "c", "d"]);
});

test("the pill clicked leaves its place to the one that leaves the card", () => {
  // lumo on the card; GitHub (third) clicked: lumo takes GitHub's place.
  const before = ["vscode", "resend", "github", "vercel"];
  const after = keepPillPlaces(before, tasks("lumo", "vscode", "resend", "vercel"));
  assert.deepEqual(ids(after), ["vscode", "resend", "lumo", "vercel"]);
});

test("a pill that goes away leaves a gap the next one fills", () => {
  assert.deepEqual(ids(keepPillPlaces(["a", "b", "c", "d"], tasks("a", "c", "d", "e"))), ["a", "e", "c", "d"]);
});

test("a gap nothing fills closes up", () => {
  assert.deepEqual(ids(keepPillPlaces(["a", "b", "c"], tasks("a", "c"))), ["a", "c"]);
});

test("a new pill goes in the first free place", () => {
  assert.deepEqual(ids(keepPillPlaces(["a", "b"], tasks("x", "a", "b"))), ["a", "b", "x"]);
});
