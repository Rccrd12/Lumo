// The Plan island: the plan an agent follows, read off its tool calls
// (src/core/agent-plan.ts), and the island that opens with it (src/island/plan.ts),
// driven through the real hooks.

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { calls, emit, sent } from "./tauri.mjs";
import {
  PlanBook, isNewPlan, planFinished, planProgress, readPlanUpdate, stepStatus, stepsFromMarkdown,
} from "../src/core/agent-plan.ts";
import { IslandPlan } from "../src/island/plan.ts";
import { liveSessions, registerHookHandlers } from "../src/island/hooks.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";

const todos = (...items) => ({ todos: items.map(([content, status]) => ({ content, status, activeForm: content })) });
const owner = (sessionId = "s1") => ({ pillId: "integration_claude", sessionId, agent: "Claude Code", color: "#fff", project: "Lumo" });

// ── Reading a plan ───────────────────────────────────────────────────────────

test("every agent's word for a step's state", () => {
  assert.equal(stepStatus("completed"), "done");
  assert.equal(stepStatus("in_progress"), "active");
  assert.equal(stepStatus("in-progress"), "active");
  assert.equal(stepStatus("cancelled"), "skipped");
  assert.equal(stepStatus("pending"), "pending");
  assert.equal(stepStatus(undefined), "pending");
});

test("Claude Code's TodoWrite, Gemini's write_todos, OpenCode's todowrite", () => {
  const claude = readPlanUpdate("TodoWrite", todos(["Read the code", "completed"], ["Write the fix", "in_progress"], ["Run tests", "pending"]));
  assert.deepEqual(claude, {
    kind: "list",
    steps: [
      { text: "Read the code", status: "done" },
      { text: "Write the fix", status: "active" },
      { text: "Run tests", status: "pending" },
    ],
  });
  const gemini = readPlanUpdate("write_todos", { todos: [{ description: "Plan", status: "cancelled" }] });
  assert.deepEqual(gemini.steps, [{ text: "Plan", status: "skipped" }]);
  const opencode = readPlanUpdate("todowrite", { todos: [{ id: "1", content: "Step", status: "completed", priority: "high" }] });
  assert.deepEqual(opencode.steps, [{ text: "Step", status: "done" }]);
  // An empty list, or another tool, is no plan.
  assert.equal(readPlanUpdate("TodoWrite", { todos: [] }), null);
  assert.equal(readPlanUpdate("Bash", { command: "ls" }), null);
  assert.equal(readPlanUpdate("TodoWrite", undefined), null);
});

test("Codex's update_plan, with its explanation", () => {
  const u = readPlanUpdate("update_plan", {
    explanation: "Starting with the parser",
    plan: [{ step: "Parse", status: "in_progress" }, { step: "Render", status: "pending" }],
  });
  assert.equal(u.kind, "list");
  assert.equal(u.note, "Starting with the parser");
  assert.deepEqual(u.steps.map((s) => s.status), ["active", "pending"]);
});

test("the plan Claude Code leaves Plan Mode with: its top-level list items", () => {
  const md = [
    "# Fix the login",
    "",
    "## Steps",
    "1. **Read** `auth.ts`",
    "   - details that are not a step",
    "2. Change the [token check](http://x)",
    "",
    "```",
    "- not a step either",
    "```",
    "- [x] Already done",
  ].join("\n");
  assert.deepEqual(stepsFromMarkdown(md), [
    { text: "Read auth.ts", status: "pending" },
    { text: "Change the token check", status: "pending" },
    { text: "Already done", status: "done" },
  ]);
  // No list: its sections.
  assert.deepEqual(stepsFromMarkdown("## One\ntext\n## Two").map((s) => s.text), ["One", "Two"]);
  const u = readPlanUpdate("ExitPlanMode", { plan: md });
  assert.equal(u.fresh, true);
});

test("Claude Code's TaskCreate and TaskUpdate, one step at a time", () => {
  const book = new PlanBook();
  assert.equal(book.apply(owner(), readPlanUpdate("TaskCreate", { subject: "First", description: "…" }), 1), "new");
  assert.equal(book.apply(owner(), readPlanUpdate("TaskCreate", { subject: "Second" }), 2), "changed");
  assert.equal(book.apply(owner(), readPlanUpdate("TaskUpdate", { taskId: "1", status: "in_progress" }), 3), "changed");
  assert.deepEqual(book.current().steps, [{ text: "First", status: "active" }, { text: "Second", status: "pending" }]);
  // An id it never saw changes nothing.
  assert.equal(book.apply(owner(), readPlanUpdate("TaskUpdate", { taskId: "9", status: "completed" }), 4), null);
  // The ids go on over the session: the next plan's first task is #3.
  book.apply(owner(), readPlanUpdate("TaskUpdate", { taskId: "1", status: "completed" }), 5);
  book.apply(owner(), readPlanUpdate("TaskUpdate", { taskId: "2", status: "completed" }), 6);
  book.drop(book.current().key);
  assert.equal(book.apply(owner(), readPlanUpdate("TaskCreate", { subject: "Third" }), 7), "new");
  assert.equal(book.apply(owner(), readPlanUpdate("TaskUpdate", { taskId: "3", status: "in_progress" }), 8), "changed");
  assert.deepEqual(book.current().steps, [{ text: "Third", status: "active" }]);
});

test("a new plan, or the same one moving on", () => {
  const a = [{ text: "One", status: "pending" }, { text: "Two", status: "pending" }];
  const aMoved = [{ text: "One", status: "done" }, { text: "Two", status: "active" }];
  assert.equal(isNewPlan(null, a), true);
  assert.equal(isNewPlan(a, aMoved), false);
  assert.equal(isNewPlan(a, [{ text: "Other", status: "pending" }]), true);
  // Once finished, the next list is a new plan, even with the same steps.
  assert.equal(isNewPlan([{ text: "One", status: "done" }], [{ text: "One", status: "pending" }]), true);
  assert.equal(planFinished([{ text: "x", status: "done" }, { text: "y", status: "skipped" }]), true);
  assert.equal(planFinished([]), false);
  assert.deepEqual(planProgress(aMoved), { done: 1, total: 2 });
});

test("the plan shown: the one under way moved on last, else the one just finished", () => {
  const book = new PlanBook();
  book.apply(owner("a"), readPlanUpdate("TodoWrite", todos(["A1", "in_progress"])), 1);
  book.apply(owner("b"), readPlanUpdate("TodoWrite", todos(["B1", "pending"])), 2);
  assert.equal(book.current().key, "integration_claude|b");
  book.apply(owner("b"), readPlanUpdate("TodoWrite", todos(["B1", "completed"])), 3);
  assert.equal(book.current().key, "integration_claude|a");
  book.drop("integration_claude|a");
  assert.equal(book.current().key, "integration_claude|b");
  // The same list again changes nothing.
  assert.equal(book.apply(owner("b"), readPlanUpdate("TodoWrite", todos(["B1", "completed"])), 4), null);
});

// ── The island, through the hooks ─────────────────────────────────────────────

const island = { alert() {}, setView() {}, reveal() {}, dropPin() {}, quickApproval: () => false };
island.plan = new IslandPlan({ openSettings() {}, refreshAll() {} });
registerHookHandlers(island);

const hook = (payload) => emit("hook", payload);
const shows = () => sent("plan_show").map((a) => a.show);
const tool = (tool_name, tool_input, session_id = "s1") =>
  hook({ hook_event_name: "PreToolUse", session_id, cwd: "C:\\code\\Lumo", tool_name, tool_input });
const lastState = () => calls.filter(([c, a]) => c === "plugin:event|emit_to" && a.event === "plan-state").at(-1)?.[1].payload;

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  calls.length = 0;
  State.tasks = [];
  State.mode = "hidden";
  State.paused = false;
  State.settings = { ...DEFAULT_SETTINGS };
  liveSessions.clear();
});

afterEach(() => {
  hook({ hook_event_name: "SessionEnd", session_id: "s1", cwd: "C:\\code\\Lumo" });
  hook({ hook_event_name: "SessionEnd", session_id: "s2", cwd: "C:\\code\\Lumo" });
  mock.timers.runAll();
  mock.timers.reset();
});

test("shut until an agent makes a plan; then it opens with it", async () => {
  tool("Bash", { command: "ls" });
  assert.deepEqual(shows(), []);
  tool("TodoWrite", todos(["Read", "in_progress"], ["Fix", "pending"]));
  assert.deepEqual(shows(), [true]);
  await Promise.resolve();
  const data = lastState();
  assert.equal(data.plan.agent, "Claude Code");
  assert.equal(data.plan.project, "Lumo");
  assert.deepEqual(data.plan.steps.map((s) => s.status), ["active", "pending"]);
  // It moves on with the agent, without opening again.
  tool("TodoWrite", todos(["Read", "completed"], ["Fix", "in_progress"]));
  assert.deepEqual(shows(), [true]);
  assert.deepEqual(lastState().plan.steps.map((s) => s.status), ["done", "active"]);
});

test("the \"–\" folds it into its icon, which brings it back", () => {
  tool("TodoWrite", todos(["Read", "in_progress"]));
  emit("plan-action", { kind: "fold" });
  assert.deepEqual(shows(), [true, false]);
  assert.equal(State.planIcon, true);
  // Folded, it stays folded while the plan moves on…
  tool("TodoWrite", todos(["Read", "completed"], ["Fix", "in_progress"]));
  assert.deepEqual(shows(), [true, false]);
  island.plan.unfold();
  assert.deepEqual(shows(), [true, false, true]);
  assert.equal(State.planIcon, false);
  // …and a new plan opens it again.
  emit("plan-action", { kind: "fold" });
  tool("TodoWrite", todos(["Something else", "pending"]), "s2");
  assert.deepEqual(shows(), [true, false, true, false, true]);
});

test("a plan done stays a moment, then the island shuts", () => {
  tool("TodoWrite", todos(["Read", "in_progress"]));
  tool("TodoWrite", todos(["Read", "completed"]));
  assert.deepEqual(shows(), [true]);
  mock.timers.tick(8_000);
  assert.deepEqual(shows(), [true, false]);
  assert.equal(island.plan.current, null);
});

test("the session ending takes its plan away", () => {
  tool("TodoWrite", todos(["Read", "in_progress"]));
  hook({ hook_event_name: "SessionEnd", session_id: "s1", cwd: "C:\\code\\Lumo" });
  assert.deepEqual(shows(), [true, false]);
  assert.equal(State.planIcon, false);
});

test("paused, it stays shut", () => {
  State.paused = true;
  tool("TodoWrite", todos(["Read", "in_progress"]));
  assert.deepEqual(shows(), []);
});

test("the island chat's Claude Code sends its plan through the chat, and it opens", () => {
  emit("chat-plan", { tool: "TodoWrite", input: todos(["Create the Snake folder", "in_progress"], ["Write game.py", "pending"]) });
  assert.deepEqual(shows(), [true]);
  assert.equal(island.plan.current.pillId, "chat");
  assert.equal(island.plan.current.agent, "Claude Code");
  emit("chat-plan", { tool: "TodoWrite", input: todos(["Create the Snake folder", "completed"], ["Write game.py", "completed"]) });
  mock.timers.tick(8_000);
  assert.deepEqual(shows(), [true, false]);
});
