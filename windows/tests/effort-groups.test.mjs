// Antigravity CLI's models by effort (src/core/effort-groups.ts): the variants
// of one model are one row of the picker, read off their names alone.

import { test } from "node:test";
import assert from "node:assert/strict";

const { groupByEffort, groupOf, levelOf, splitEffort, variantFor } = await import("../src/core/effort-groups.ts");

/** agy's list as it was in November 2026, in its own order. */
const AGY = [
  "default",
  "gemini-4-argon-medium", "gemini-4-argon-high", "gemini-4-argon-low",
  "gemini-4-hydrogen-high", "gemini-4-hydrogen-xhigh", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-low",
  "gemini-pro-orchestrator-g1-pro",
  "gemini-3.8-flash-high", "gemini-3.8-flash-medium",
];

const rows = (ids) => groupByEffort(ids).map((g) => [g.name, g.levels]);

test("the variants of one model are one row, its levels from the least to the most", () => {
  assert.deepEqual(rows(AGY), [
    ["default", []],
    ["gemini-4-argon", ["low", "medium", "high"]],
    ["gemini-4-hydrogen", ["low", "medium", "high", "xhigh"]],
    ["gemini-pro-orchestrator-g1-pro", []],
    ["gemini-3.8-flash", ["medium", "high"]],
  ]);
  const argon = groupByEffort(AGY)[1];
  assert.equal(argon.ids.get("high"), "gemini-4-argon-high", "each level is still the model agy is sent");
});

test("only an effort word at the end, and only with another level of it, makes a group", () => {
  assert.equal(splitEffort("gemini-pro-orchestrator-g1-pro"), null, "pro is no level");
  assert.equal(splitEffort("gemini-low-latency"), null, "a level in the middle is part of the name");
  assert.deepEqual(splitEffort("gemini-4-argon-xhigh"), { base: "gemini-4-argon", level: "xhigh" });
  assert.deepEqual(rows(["gemini-x-high", "other-low"]), [["gemini-x-high", []], ["other-low", []]], "a level alone stays as it is");
  // A model named as the group would be stays beside its variants, all on their own.
  assert.deepEqual(rows(["gemini-x", "gemini-x-low", "gemini-x-high"]).map(([name]) => name), ["gemini-x", "gemini-x-low", "gemini-x-high"]);
  // Any new model agy lists is grouped the same way, with no list of names.
  assert.deepEqual(rows(["nova-9-max", "nova-9-minimal"]), [["nova-9", ["minimal", "max"]]]);
});

test("a click on a group keeps the level in use, else medium, else the one in the middle", () => {
  const groups = groupByEffort(AGY);
  const [, argon, hydrogen, , flash] = groups;
  assert.equal(levelOf(groups, "gemini-4-hydrogen-xhigh"), "xhigh");
  assert.equal(levelOf(groups, "gemini-pro-orchestrator-g1-pro"), "");
  assert.equal(groupOf(groups, "gemini-3.8-flash-high"), flash);
  assert.equal(variantFor(flash, "high"), "gemini-3.8-flash-high");
  assert.equal(variantFor(argon, "xhigh"), "gemini-4-argon-medium", "argon has no xhigh: medium");
  assert.equal(variantFor(hydrogen, ""), "gemini-4-hydrogen-medium");
  const noMedium = groupByEffort(["m-low", "m-high", "m-max"])[0];
  assert.equal(variantFor(noMedium, ""), "m-high", "no medium: the level in the middle");
  assert.equal(variantFor(groups[0], "high"), "default", "a model alone is itself");
});
