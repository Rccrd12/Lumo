// Antigravity CLI's Orchestrator (src/core/orchestrator.ts, the picker in
// src/views/chat-models.ts): agy's Orchestrator rows are one row, with a
// planner and an executor under the list, each with its own effort.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { internals, sent } from "./tauri.mjs";

installFakeDom();
const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { groupByEffort } = await import("../src/core/effort-groups.ts");
const O = await import("../src/core/orchestrator.ts");

/** `agy models` as agy 1.5.16 lists them, in its own order. */
const AGY = [
  "default",
  "gemini-4-neon-high", "gemini-4-neon-xhigh", "gemini-4-neon-medium", "gemini-4-neon-low",
  "gemini-4-carbon-medium", "gemini-4-carbon-high", "gemini-4-carbon-low",
  "gemini-4-argon-medium", "gemini-4-argon-high", "gemini-4-argon-low",
  "gemini-4-hydrogen-high", "gemini-4-hydrogen-xhigh", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-low",
  "gemini-pro-orchestrator-neon", "gemini-pro-orchestrator", "gemini-pro-orchestrator-argon",
  "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
  "claude-opus-5-5-low", "claude-opus-5-5-medium", "claude-opus-5-5-high",
  "claude-sonnet-5-5-low", "claude-sonnet-5-5-medium", "claude-sonnet-5-5-high",
  "gpt-oss-120b-medium",
];
const groups = groupByEffort(AGY);

test("a pick is its planner and its executor, by the ids agy gives them", () => {
  const model = O.orchestratorModel({ planner: "gemini-4-neon-high", executor: "gemini-4-hydrogen-low" });
  assert.equal(model, "orchestrator:gemini-4-neon-high:gemini-4-hydrogen-low");
  assert.deepEqual(O.parseOrchestrator(model), { planner: "gemini-4-neon-high", executor: "gemini-4-hydrogen-low" });
  assert.equal(O.parseOrchestrator("gemini-4-neon-high"), null);
  assert.equal(O.parseOrchestrator("orchestrator:gemini-4-neon-high"), null);
  assert.equal(O.parseOrchestrator("orchestrator:a:b:c"), null);
});

test("agy's rows are Orchestrator's, not the single model it once was", () => {
  assert.ok(O.isOrchestratorRow("gemini-pro-orchestrator"));
  assert.ok(O.isOrchestratorRow("gemini-pro-orchestrator-neon"));
  assert.ok(!O.isOrchestratorRow("gemini-pro-orchestrator-g1-pro"));
  assert.ok(!O.isOrchestratorRow("gemini-4-neon-high"));
  assert.ok(O.offersOrchestrator(AGY, groups));
  assert.ok(!O.offersOrchestrator(AGY.filter((id) => !O.isOrchestratorRow(id)), groups), "no row of agy's: no Orchestrator");
});

test("Gemini 4 models plan; Hydrogen and Sonnet 5.5 execute, Neon never", () => {
  const { planners, executors } = O.orchestratorRoles(groups);
  assert.deepEqual(planners.map((g) => g.name), ["gemini-4-neon", "gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"]);
  assert.deepEqual(executors.map((g) => g.name), ["gemini-4-hydrogen", "claude-sonnet-5-5"]);
  assert.deepEqual(O.defaultOrchestrator(groups), { planner: "gemini-4-neon-high", executor: "gemini-4-hydrogen-high" }, "agy's first of each, at high");
});

test("‹ › go round a role's models, keeping the level where the next has it", () => {
  const o = { planner: "gemini-4-neon-xhigh", executor: "gemini-4-hydrogen-low" };
  assert.deepEqual(O.stepRole(groups, o, "planner", 1), { ...o, planner: "gemini-4-carbon-high" }, "Carbon has no xhigh: high");
  assert.deepEqual(O.stepRole(groups, o, "planner", -1), { ...o, planner: "gemini-4-hydrogen-xhigh" }, "round the list");
  assert.deepEqual(O.stepRole(groups, o, "executor", 1), { ...o, executor: "claude-sonnet-5-5-low" });
  assert.deepEqual(O.withRoleLevel(groups, o, "executor", "medium"), { ...o, executor: "gemini-4-hydrogen-medium" });
  assert.deepEqual(O.withRoleLevel(groups, o, "executor", "max"), o, "a level the model hasn't: as it was");
});

test("the names said: Gemini 4's by their own, the others without whose they are", () => {
  assert.equal(O.roleName("gemini-4-neon-high"), "Neon");
  assert.equal(O.roleName("claude-sonnet-5-5-medium"), "Sonnet 5.5");
  assert.equal(O.orchestratorName({ planner: "gemini-4-carbon-low", executor: "gemini-4-hydrogen-high" }), "Orchestrator · Carbon → Hydrogen");
});

test("a pick stays while agy still lists its two models in their roles", () => {
  const model = "orchestrator:gemini-4-argon-low:claude-sonnet-5-5-medium";
  assert.ok(O.orchestratorListed(AGY, groups, model));
  assert.ok(!O.orchestratorListed(AGY, groups, "orchestrator:gemini-4-argon-low:gemini-4-neon-high"), "Neon never executes");
  const gone = AGY.filter((id) => !id.startsWith("claude-sonnet"));
  assert.ok(!O.orchestratorListed(gone, groupByEffort(gone), model));
});

// ── The picker ────────────────────────────────────────────────────────────────

let answers;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (answers && cmd in answers) return answers[cmd];
  return result;
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let view;
beforeEach(() => {
  answers = { chat_models: AGY.map((id) => ({ id, label: id === "default" ? "Default" : id })) };
  State.settings = { ...DEFAULT_SETTINGS, chatProvider: "antigravity-cli", chatModels: { "antigravity-cli": "gemini-4-hydrogen-high" } };
  State.chatHistory = [];
  view = buildPrompt(() => {});
  view.sync();
});
const $ = (cls) => view.el.querySelector(cls);
const names = () => view.el.find(".picker-model-name").map((m) => m.textContent);
const orchestratorRow = () => view.el.find(".picker-model").find((m) => m.querySelector(".picker-model-name").textContent === "Orchestrator");
const saved = () => State.settings.chatModels["antigravity-cli"];

test("the picker: agy's three rows are one Orchestrator, where the first of them was", async () => {
  $(".model-btn").fire("click");
  await flush();
  assert.deepEqual(names(), [
    "Default", "Gemini 4 Neon", "Gemini 4 Carbon", "Gemini 4 Argon", "Gemini 4 Hydrogen", "Orchestrator",
    "Gemini 3.8 Flash", "Claude Opus 5.5", "Claude Sonnet 5.5", "GPT OSS 120b Medium",
  ]);
  assert.equal(orchestratorRow().querySelector(".picker-model-sub").textContent, "Neon → Hydrogen");
});

test("the picker: Orchestrator picked, its planner and executor each with ‹ › and their effort", async () => {
  $(".model-btn").fire("click");
  await flush();
  orchestratorRow().fire("click");
  assert.equal(saved(), "orchestrator:gemini-4-neon-high:gemini-4-hydrogen-high");
  assert.equal(sent("save_settings").at(-1).settings.chatModels["antigravity-cli"], saved());
  assert.ok(view.el.querySelector(".picker").classList.contains("on"), "the picker stays open to set them");
  const rows = view.el.find(".orch-row");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.querySelector(".orch-role").textContent), ["Planner", "Executor"]);
  assert.deepEqual(rows.map((r) => r.querySelector(".orch-model").textContent), ["Neon", "Hydrogen"]);
  assert.deepEqual(rows.map((r) => r.querySelector(".effort-value").textContent), ["High", "High"]);

  // The next planner, then the executor's effort.
  rows[0].find(".orch-step")[1].fire("click");
  assert.equal(saved(), "orchestrator:gemini-4-carbon-high:gemini-4-hydrogen-high");
  view.el.find(".orch-row")[1].querySelector(".effort-slider").fire("keydown", { key: "Home" });
  assert.equal(saved(), "orchestrator:gemini-4-carbon-high:gemini-4-hydrogen-low");
  view.el.find(".orch-row")[1].find(".orch-step")[0].fire("click");
  assert.equal(saved(), "orchestrator:gemini-4-carbon-high:claude-sonnet-5-5-low");

  view.sync();
  assert.equal($(".model-name").textContent, "Orchestrator · Carbon → Sonnet 5.5");

  // Another model and back: the pick comes back as it was.
  view.el.find(".picker-model").find((m) => m.textContent === "Gemini 4 Argon").fire("click");
  assert.equal(saved(), "gemini-4-argon-medium", "from Orchestrator, a model starts at medium");
  $(".model-btn").fire("click");
  await flush();
  assert.equal(view.el.find(".orch-row").length, 0, "Argon alone: its one slider");
  orchestratorRow().fire("click");
  assert.equal(saved(), "orchestrator:gemini-4-carbon-high:claude-sonnet-5-5-low");
});

test("the picker: a saved pick is kept when the list is asked again", async () => {
  State.settings = { ...State.settings, chatModels: { "antigravity-cli": "orchestrator:gemini-4-argon-low:claude-sonnet-5-5-medium" } };
  view.sync();
  assert.equal($(".model-name").textContent, "Orchestrator · Argon → Sonnet 5.5", "before agy is asked, too");
  $(".model-btn").fire("click");
  await flush();
  assert.equal(saved(), "orchestrator:gemini-4-argon-low:claude-sonnet-5-5-medium");
  assert.ok(orchestratorRow().classList.contains("on"));
  assert.deepEqual(view.el.find(".orch-model").map((m) => m.textContent), ["Argon", "Sonnet 5.5"]);
});
