// The plan an agent follows, read off its tool calls (src/core/agent-plan.ts),
// and what opens with it in the chat and on the home (src/island/plan.ts),
// driven through the real hooks.

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { calls, emit, sent } from "./tauri.mjs";
import {
  PlanBook, isNewPlan, planFinished, planProgress, readPlanUpdate, stepStatus, stepsFromMarkdown,
} from "../src/core/agent-plan.ts";
import { IslandPlan } from "../src/island/plan.ts";
import { homeChatPlans } from "../src/views/home.ts";
import { liveSessions, registerHookHandlers } from "../src/island/hooks.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { Sound } from "../src/core/sound.ts";

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

test("a checklist written as the plan: ticked steps done, the first left under way", () => {
  const u = readPlanUpdate("Checklist", { text: "- [x] Create the folder\n- [ ] Write game.py\n- [ ] Write main.py" });
  assert.deepEqual(u, {
    kind: "list",
    steps: [
      { text: "Create the folder", status: "done" },
      { text: "Write game.py", status: "active" },
      { text: "Write main.py", status: "pending" },
    ],
  });
  assert.equal(readPlanUpdate("Checklist", { text: "- [ ] One" }), null);
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

test("TaskCreate with the id its result gave: TaskUpdate finds the step by it", () => {
  const book = new PlanBook();
  assert.equal(book.apply(owner("x"), readPlanUpdate("TaskCreate", { subject: "Game", taskId: "4" }), 1), "new");
  assert.equal(book.apply(owner("x"), readPlanUpdate("TaskCreate", { subject: "UI", taskId: "5" }), 2), "changed");
  assert.equal(book.apply(owner("x"), readPlanUpdate("TaskUpdate", { taskId: "5", status: "in_progress" }), 3), "changed");
  assert.deepEqual(book.current().steps, [{ text: "Game", status: "pending" }, { text: "UI", status: "active" }]);
  // An id from before (task #1 of another plan) changes nothing here.
  assert.equal(book.apply(owner("x"), readPlanUpdate("TaskUpdate", { taskId: "1", status: "completed" }), 4), null);
});

test("a TaskCreate id the plan already has starts a new plan: the session counts from 1 again", () => {
  const book = new PlanBook();
  const chat = { ...owner("c1"), pillId: "chat" };
  book.apply(chat, readPlanUpdate("TaskCreate", { subject: "Take a screenshot", taskId: "1" }), 1);
  book.apply(chat, readPlanUpdate("TaskCreate", { subject: "Search for Chrome", taskId: "2" }), 2);
  book.apply(chat, readPlanUpdate("TaskUpdate", { taskId: "1", status: "completed" }), 3);
  // The chat went on in a new Claude Code session: its task #1 is not a third step.
  assert.equal(book.apply(chat, readPlanUpdate("TaskCreate", { subject: "Open Chrome", taskId: "1" }), 4), "new");
  assert.equal(book.apply(chat, readPlanUpdate("TaskCreate", { subject: "Check it opened", taskId: "2" }), 5), "changed");
  assert.equal(book.apply(chat, readPlanUpdate("TaskUpdate", { taskId: "1", status: "in_progress" }), 6), "changed");
  assert.deepEqual(book.current().steps, [{ text: "Open Chrome", status: "active" }, { text: "Check it opened", status: "pending" }]);
});

test("a session starting over: its plan goes and its task ids count from 1 again", () => {
  const book = new PlanBook();
  book.apply(owner(), readPlanUpdate("TaskCreate", { subject: "First" }), 1);
  book.apply(owner(), readPlanUpdate("TaskCreate", { subject: "Second" }), 2);
  assert.equal(book.restart(book.current().key), true);
  assert.equal(book.size, 0);
  assert.equal(book.apply(owner(), readPlanUpdate("TaskCreate", { subject: "Again" }), 3), "new");
  assert.equal(book.apply(owner(), readPlanUpdate("TaskUpdate", { taskId: "1", status: "in_progress" }), 4), "changed");
  assert.deepEqual(book.current().steps, [{ text: "Again", status: "active" }]);
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

const played = [];
mock.method(Sound, "play", (name) => played.push(name));

const island = { alert() {}, setView() {}, reveal() {}, dropPin() {}, quickApproval: () => false };
island.plan = new IslandPlan({ changed() {} });
registerHookHandlers(island);

const hook = (payload) => emit("hook", payload);
const tool = (tool_name, tool_input, session_id = "s1") =>
  hook({ hook_event_name: "PreToolUse", session_id, cwd: "C:\\code\\Lumo", tool_name, tool_input });
/** Open: the chat's strip and the home show it, and its icon reads pressed (State.planOpen). */
const open = () => State.planOpen;

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  calls.length = 0;
  played.length = 0;
  State.tasks = [];
  State.mode = "expanded";
  State.paused = false;
  State.settings = { ...DEFAULT_SETTINGS };
  liveSessions.clear();
});

afterEach(() => {
  hook({ hook_event_name: "SessionEnd", session_id: "s1", cwd: "C:\\code\\Lumo" });
  hook({ hook_event_name: "SessionEnd", session_id: "s2", cwd: "C:\\code\\Lumo" });
  // Plans done are kept: each test starts with them folded.
  if (State.planOpen) island.plan.toggle();
  State.settings = { ...DEFAULT_SETTINGS };
  mock.timers.runAll();
  mock.timers.reset();
});

test("shut until an agent makes a plan; then it opens, with a sound while the island is open", () => {
  tool("Bash", { command: "ls" });
  assert.equal(open(), false);
  assert.equal(State.planIcon, false);
  tool("TodoWrite", todos(["Read", "in_progress"], ["Fix", "pending"]));
  assert.equal(open(), true);
  assert.equal(State.planIcon, true);
  assert.deepEqual(played, ["open"]);
  assert.equal(island.plan.current.agent, "Claude Code");
  assert.equal(island.plan.current.project, "Lumo");
  assert.deepEqual(island.plan.current.steps.map((s) => s.status), ["active", "pending"]);
  assert.equal(State.plans[0].key, island.plan.current.key, "the chat and the home are given it");
  // It moves on with the agent, without opening again.
  tool("TodoWrite", todos(["Read", "completed"], ["Fix", "in_progress"]));
  assert.equal(open(), true);
  assert.deepEqual(played, ["open"]);
  assert.deepEqual(island.plan.current.steps.map((s) => s.status), ["done", "active"]);
});

test("its icon folds it, and brings it back; a new plan opens it again", () => {
  tool("TodoWrite", todos(["Read", "in_progress"]));
  assert.equal(open(), true);
  island.plan.toggle();
  assert.equal(open(), false);
  assert.equal(State.planIcon, true, "the icon stays while there are plans");
  // Folded, it stays folded while the plan moves on…
  tool("TodoWrite", todos(["Read", "completed"], ["Fix", "in_progress"]));
  assert.equal(open(), false);
  island.plan.toggle();
  assert.equal(open(), true);
  // …and a new plan opens it again.
  island.plan.toggle();
  assert.equal(open(), false);
  tool("TodoWrite", todos(["Something else", "pending"]), "s2");
  assert.equal(open(), true);
});

test("a plan done stays a moment, then folds into its icon, which opens it again", () => {
  tool("TodoWrite", todos(["Read", "in_progress"]));
  tool("TodoWrite", todos(["Read", "completed"]));
  assert.equal(open(), true);
  mock.timers.tick(8_000);
  assert.equal(open(), false);
  assert.equal(State.planIcon, true);
  assert.deepEqual(island.plan.current.steps, [{ text: "Read", status: "done" }]);
  island.plan.unfold();
  assert.equal(open(), true);
  assert.equal(island.plan.book.get(island.plan.current.key), undefined, "with those done, no longer under way");
});

test("the session ending puts its plan with those done", () => {
  tool("TodoWrite", todos(["Read", "in_progress"]));
  assert.equal(open(), true);
  hook({ hook_event_name: "SessionEnd", session_id: "s1", cwd: "C:\\code\\Lumo" });
  assert.equal(open(), false);
  assert.equal(State.planIcon, true);
  assert.equal(island.plan.current.steps[0].text, "Read");
});

test("plans done are kept, and a new plan comes first", () => {
  tool("TodoWrite", todos(["First", "completed"]), "s1");
  mock.timers.tick(8_000);
  tool("TodoWrite", todos(["Second", "completed"]), "s2");
  mock.timers.tick(8_000);
  island.plan.unfold();
  assert.equal(island.plan.current.steps[0].text, "Second");
  assert.ok(island.plan.plans().length >= 2);
  tool("TodoWrite", todos(["Third", "in_progress"]), "s1");
  assert.equal(island.plan.current.steps[0].text, "Third");
  assert.equal(State.plans[0].steps[0].text, "Third");
});

test("a terminal's TaskCreate counts once done, with the id the relay kept", () => {
  const post = (tool_name, tool_input, extra = {}) =>
    hook({ hook_event_name: "PostToolUse", session_id: "s1", cwd: "C:\\code\\Lumo", tool_name, tool_input, ...extra });
  tool("TaskCreate", { subject: "Game" });
  assert.equal(island.plan.book.size, 0, "not before it is made");
  post("TaskCreate", { subject: "Game" }, { lumo_task_id: "12" });
  post("TaskCreate", { subject: "UI" }, { lumo_task_id: "13" });
  tool("TaskUpdate", { taskId: "13", status: "in_progress" });
  post("TaskUpdate", { taskId: "13", status: "in_progress" });
  assert.deepEqual(island.plan.current.steps, [{ text: "Game", status: "pending" }, { text: "UI", status: "active" }]);
});

test("made while the island is closed, it opens without a sound, ready for when the island does", () => {
  State.mode = "hidden";
  tool("TodoWrite", todos(["Read", "in_progress"]));
  assert.equal(open(), true);
  assert.equal(State.planIcon, true);
  assert.deepEqual(played, []);
});

test("no window of its own: nothing asks Rust for one, whatever an old settings.json said", () => {
  // agentPlanMoved, from a settings.json of before, is no longer read.
  State.settings = { ...State.settings, agentPlanMoved: true };
  tool("TodoWrite", todos(["Read", "in_progress"]));
  assert.equal(open(), true);
  assert.deepEqual(sent("plan_show"), []);
  assert.deepEqual(sent("plan_prepare"), []);
  assert.equal(calls.some(([cmd]) => /^(plan|activities)_/.test(cmd)), false);
});

test("paused, it stays shut", () => {
  State.paused = true;
  tool("TodoWrite", todos(["Read", "in_progress"]));
  assert.equal(open(), false);
});

test("the island chat's Claude Code sends its plan through the chat, and it opens", () => {
  emit("chat-plan", { tool: "TodoWrite", input: todos(["Create the Snake folder", "in_progress"], ["Write game.py", "pending"]) });
  assert.equal(open(), true);
  assert.equal(island.plan.current.pillId, "chat");
  assert.equal(island.plan.current.agent, "Claude Code");
  emit("chat-plan", { tool: "TodoWrite", input: todos(["Create the Snake folder", "completed"], ["Write game.py", "completed"]) });
  mock.timers.tick(8_000);
  assert.equal(open(), false);
});

test("a question of the chat edited: the plan its answer made goes, and the next one starts alone", () => {
  const send = (tool, input) => emit("chat-plan", { chat: "edited-chat", tool, input });
  send("TaskCreate", { subject: "Take a screenshot of the desktop", taskId: "1" });
  send("TaskCreate", { subject: "Open Chrome", taskId: "2" });
  send("TaskUpdate", { taskId: "1", status: "in_progress" });
  assert.equal(open(), true);
  island.plan.restartChat("edited-chat");
  assert.equal(island.plan.book.get("chat|edited-chat"), undefined);
  assert.equal(open(), false);
  // Not kept with those done: the answer that made it is gone.
  assert.equal(island.plan.plans().some((p) => p.key === "chat|edited-chat"), false);
  // The new answer's plan opens on its own.
  send("TaskCreate", { subject: "Open Chrome and check it", taskId: "1" });
  send("TaskUpdate", { taskId: "1", status: "in_progress" });
  assert.equal(open(), true);
  assert.deepEqual(island.plan.current.steps, [{ text: "Open Chrome and check it", status: "active" }]);
  island.plan.forgetChat("edited-chat");
});

test("a chat at work while another is on screen keeps its own plan: one row on the home, its agent's name", () => {
  // Antigravity works in chat A; the user opens chat B and writes to Claude Code there.
  const agy = (statuses) => emit("chat-plan", {
    chat: "agy-chat", tool: "update_plan", agent: "Antigravity CLI", color: "#E879F9",
    input: { plan: ["Check Downloads", "Read the file", "Fix the formula", "Save and check LaTeX"].map((step, i) => ({ step, status: statuses[i] })) },
  });
  State.chatId = "agy-chat";
  agy(["completed", "in_progress", "pending", "pending"]);
  State.chatId = "opus-chat";
  agy(["completed", "completed", "completed", "in_progress"]);
  assert.equal(island.plan.book.get("chat|opus-chat"), undefined, "nothing lands in the chat on screen");
  const rows = homeChatPlans();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "chat|agy-chat");
  assert.equal(rows[0].agent, "Antigravity CLI");
  assert.deepEqual(rows[0].steps.map((s) => s.status), ["done", "done", "done", "active"]);
  // Claude Code's own plan in chat B is a row of its own, in its name.
  emit("chat-plan", { chat: "opus-chat", tool: "TodoWrite", input: todos(["Answer", "in_progress"]) });
  assert.deepEqual(homeChatPlans().map((p) => [p.key, p.agent]).sort(), [["chat|agy-chat", "Antigravity CLI"], ["chat|opus-chat", "Claude Code"]]);
  island.plan.forgetChat("agy-chat");
  island.plan.forgetChat("opus-chat");
});

test("a local or API model's update_plan carries its own chat id and speaker", () => {
  State.chatId = "foreground-chat";
  emit("chat-plan", {
    chat: "bg-chat-99",
    tool: "update_plan",
    input: {
      plan: [
        { step: "Read open PRs", status: "in_progress" },
        { step: "Check Actions CI", status: "pending" },
      ],
    },
    agent: "Unsloth Studio",
    color: "#34D399",
  });
  assert.equal(open(), true);
  assert.equal(island.plan.current.key, "chat|bg-chat-99");
  assert.equal(island.plan.current.agent, "Unsloth Studio");
  assert.equal(island.plan.current.color, "#34D399");
  assert.deepEqual(island.plan.current.steps, [
    { text: "Read open PRs", status: "active" },
    { text: "Check Actions CI", status: "pending" },
  ]);
});

