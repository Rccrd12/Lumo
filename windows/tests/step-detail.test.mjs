// What a step shows once opened in the steps card: the whole command, path,
// prompt, error or answer its one line cuts short, kept beside the step and
// dropped with it.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "./tauri.mjs";
import { registerHookHandlers } from "../src/island/hooks.ts";
import { DEFAULT_SETTINGS, State, stepDetailAt } from "../src/core/state.ts";
import { MAX_DETAIL, addsToRow, failureDetail, fullTextDetail, openedRow, toolStepDetail } from "../src/core/step-detail.ts";

const CLAUDE = "integration_claude";

const island = { alert() {}, setView() {}, reveal() {}, dropPin() {} };
registerHookHandlers(island);

const hook = (payload) => emit("hook", payload);
const task = () => State.tasks.find((t) => t.id === CLAUDE);
const lastDetail = () => stepDetailAt(task(), task().steps.length - 1);

beforeEach(() => {
  State.tasks = [];
  State.focusId = null;
  State.mode = "hidden";
  State.view = "overview";
  State.pendingApproval = null;
  State.settings = { ...DEFAULT_SETTINGS };
  State.loadIntegrationTasks();
});

test("a command keeps its whole text and what it is for", () => {
  const command = `Set-Location "$env:TEMP\\agent"; Get-ChildItem -Recurse | Where-Object { $_.Length -gt 1MB }`;
  const detail = toolStepDetail("PowerShell", { command, description: "Find the large files" });
  assert.deepEqual(detail, { text: "Find the large files", code: command });
  assert.ok(addsToRow(detail, `Runs · ${command.slice(0, 40)}`));
});

test("a short command with nothing else has nothing more to show", () => {
  const detail = toolStepDetail("Bash", { command: "ls" });
  assert.equal(addsToRow(detail, "Runs · ls"), false);
});

test("a search keeps its pattern and its folder; a tool with neither shows its input", () => {
  assert.deepEqual(toolStepDetail("Grep", { pattern: "TODO", path: "/p/src" }), { code: "TODO\n/p/src" });
  assert.deepEqual(toolStepDetail("mcp__db__query", { table: "users", limit: 5 }), {
    code: JSON.stringify({ table: "users", limit: 5 }, null, 2),
  });
  assert.equal(toolStepDetail("Tool", {}), null);
});

test("a task list shows each task with where it stands", () => {
  const detail = toolStepDetail("TodoWrite", {
    todos: [
      { content: "Read the code", status: "completed" },
      { content: "Fix the bug", status: "in_progress" },
      { content: "Open the PR", status: "pending" },
    ],
  });
  assert.equal(detail.text, "✓ Read the code\n› Fix the bug\n○ Open the PR");
});

test("a whole text is kept only when the row cut it, and never past the cap", () => {
  assert.equal(fullTextDetail("short", "short"), null);
  assert.equal(fullTextDetail("", "x"), null);
  assert.equal(fullTextDetail("x".repeat(MAX_DETAIL + 50), "xxx").text.length, MAX_DETAIL + 1);
});

test("a failure says the error, then what was called", () => {
  assert.deepEqual(failureDetail("Bash", { command: "npm test" }, "Exit code 1"), { text: "Exit code 1", code: "npm test" });
  assert.deepEqual(failureDetail("Bash", { command: "npm test" }, undefined), { code: "npm test" });
});

test("hook events keep their detail beside the step", () => {
  const command = "Get-ChildItem -Path C:\\Users\\someone\\AppData\\Local\\Temp -Recurse -Filter *.log";
  hook({ hook_event_name: "PreToolUse", tool_name: "PowerShell", tool_input: { command } });
  assert.equal(lastDetail().code, command);

  hook({ hook_event_name: "PostToolUseFailure", tool_name: "PowerShell", tool_input: { command }, error: "Access denied" });
  assert.deepEqual(lastDetail(), { text: "Access denied", code: command });

  const answer = "Done.\n\nI changed **three** files:\n- a.ts\n- b.ts\n- c.ts";
  hook({ hook_event_name: "Stop", last_assistant_message: answer });
  assert.equal(lastDetail().text, answer);
});

test("details stay aligned with the steps past the cap, and a reset leaves none", () => {
  for (let i = 0; i < 25; i++) State.appendStep(CLAUDE, `step ${i}`, { code: `code ${i}` });
  const t = task();
  assert.equal(t.steps.length, 20);
  assert.equal(t.stepDetails.length, 20);
  assert.equal(stepDetailAt(t, 0).code, "code 5");
  assert.equal(stepDetailAt(t, 19).code, "code 24");

  t.steps = []; // as a session's end does, without the details
  State.appendStep(CLAUDE, "fresh");
  assert.equal(stepDetailAt(task(), 0), null);
  assert.equal(task().stepDetails.length, 1);
});

test("the steps card shows a cut prompt whole, and marks a cut command", () => {
  const prompt = "Clean up the temp folder of the agent and tell me how much space we saved";
  assert.deepEqual(openedRow(prompt.slice(0, 60), { text: prompt }), { text: prompt, detail: null });

  const command = 'Set-Location "$env:TEMP\\agent"; Get-ChildItem -Recurse';
  const row = `Runs · ${command.slice(0, 40)}`;
  const opened = openedRow(row, { code: command });
  assert.equal(opened.text, `${row}…`);
  assert.deepEqual(opened.detail, { code: command });

  assert.deepEqual(openedRow("Runs · ls", { code: "ls" }), { text: "Runs · ls", detail: null });
  assert.equal(openedRow("Reads · a.ts", { code: "C:\\p\\a.ts" }).text, "Reads · a.ts");
});
