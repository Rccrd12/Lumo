// The plan an agent follows on the closed island (src/core/compact.ts
// planPeek): a segment a step, as its agents are (concepts/piano-isola-chiusa).

import { test } from "node:test";
import assert from "node:assert/strict";
import { activityLine, planPeek } from "../src/core/compact.ts";

const steps = (...s) => s.map((status, i) => ({ text: `Step ${i + 1}`, status }));

test("a plan under way: a segment a step, and how many are done", () => {
  assert.deepEqual(planPeek(steps("done", "active", "pending", "pending")), {
    looks: ["done", "working", "queued", "queued"], done: 1, total: 4, stalled: false,
  });
  // A step put aside counts as done.
  assert.deepEqual(planPeek(steps("skipped", "done", "active")).looks, ["done", "done", "working"]);
});

test("no plan, or one done, shows nothing", () => {
  assert.equal(planPeek(null), null);
  assert.equal(planPeek([]), null);
  assert.equal(planPeek(steps("done", "skipped")), null);
});

test("the chat's line carries its plan after the words", () => {
  const plan = planPeek(steps("done", "active", "pending", "pending"));
  const line = activityLine({ who: "Opus", label: "Esegue un comando", color: "#D97757", plan }, null, null);
  assert.equal(line.text, "Opus · Esegue un comando");
  assert.deepEqual(line.agents, plan);
});

test("its agents at work come before its plan", () => {
  const agents = { looks: ["working", "working"], done: 0, total: 2, stalled: false };
  const plan = planPeek(steps("active", "pending"));
  const line = activityLine({ who: "Opus", label: null, color: "#D97757", agents, plan }, null, null);
  assert.deepEqual(line.agents, agents);
});

test("an agent in a terminal shows its plan too", () => {
  const plan = planPeek(steps("done", "done", "active"));
  const line = activityLine(null, null, { name: "Claude Code", state: "working", step: "Runs · npm test", color: "#D97757", plan });
  assert.deepEqual(line.agents, plan);
  assert.equal(activityLine(null, null, { name: "Claude Code", state: "working", step: null, color: "#fff" }).agents, undefined);
});
