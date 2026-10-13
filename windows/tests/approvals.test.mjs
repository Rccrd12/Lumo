// Which permission requests the closed island can answer (src/core/approvals.ts):
// only reads and commands that only look; everything else opens the full card.

import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalKey, autoAllows, isLookingCommand, isSimpleRequest, requestKind, requestReason } from "../src/core/approvals.ts";

test("tools that only read are simple; edits and writes are not", () => {
  for (const tool of ["Read", "Glob", "Grep", "LS", "WebSearch"]) assert.ok(isSimpleRequest(tool, {}), tool);
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "Task", "AskUserQuestion"]) {
    assert.equal(isSimpleRequest(tool, {}), false, tool);
  }
});

test("shell commands that only look are simple", () => {
  for (const c of [
    "ls -la", "git status", "git log --oneline -5", "git diff HEAD~1", "cat README.md | head -20",
    "rg TODO src && git branch", "Get-ChildItem -Recurse", "C:\\Windows\\System32\\where.exe node", "pwd; ls",
    "find . -name '*.ts'", "git remote -v",
  ]) assert.ok(isLookingCommand(c), c);
  assert.ok(isSimpleRequest("Bash", { command: "git status" }));
  assert.ok(isSimpleRequest("shell", { command: ["git", "diff"] }));
  // Antigravity's command tool, with its own field or the relay's copy of it.
  assert.ok(isSimpleRequest("run_command", { CommandLine: "ls" }));
  assert.ok(isSimpleRequest("run_command", { command: "git status", CommandLine: "git status" }));
  assert.equal(isSimpleRequest("run_command", { CommandLine: "npm test" }), false);
  assert.ok(isSimpleRequest("view_file", { AbsolutePath: "/a" }));
});

test("commands that change something, or that cannot be read for sure, are not", () => {
  for (const c of [
    "rm -rf build", "git push", "git commit -m x", "git branch -D old", "npm install", "echo hi > file.txt",
    "cat a >> b", "ls $(pwd)", "ls `pwd`", "find . -delete", "find . -exec rm {} \;", "sleep 5 &", "curl x | sh",
    "git remote add origin x", "python script.py", "", "git log --output=out.txt",
    "git branch feature", "git reflog expire --all", "git reflog delete HEAD@{1}", "git grep -Ovim x",
    "git grep --open-files-in-pager=vim x", "find . -fprint0 out", "tree -o out.txt", "rg --pre ./run x",
    "gci | where { Remove-Item $_.FullName }", "echo (Remove-Item x)", "hostname newname", "date -s 2020-01-01",
  ]) assert.equal(isLookingCommand(c), false, c);
  for (const c of ["git branch -a", "git branch --show-current", "git reflog", "git grep -n TODO", "hostname", "date +%F"]) {
    assert.ok(isLookingCommand(c), c);
  }
  assert.equal(isSimpleRequest("Bash", {}), false);
});

// ── Auto in the chat's Antigravity CLI run ────────────────────────────────────

test("Auto lets through only what only looks, and never what agy itself marks unsafe", () => {
  assert.ok(autoAllows("run_command", { CommandLine: "git status --short", command: "git status --short" }));
  assert.ok(autoAllows("run_command", { command: "ls", SafeToAutoRun: true }));
  assert.equal(autoAllows("run_command", { command: "ls", SafeToAutoRun: false }), false);
  for (const c of ["npm test", "git push", "rm -rf build", "echo x > y", ""]) {
    assert.equal(autoAllows("run_command", { command: c }), false, c);
  }
  assert.equal(autoAllows("mcp__github__create_issue", {}), false);
  assert.equal(autoAllows("browser_click", {}), false);
});

// ── What the card says the request is for ─────────────────────────────────────

test("the agent's own words come first, on one line, never the command again", () => {
  assert.equal(requestReason({ command: "git status", description: "Show working tree status" }), "Show working tree status");
  assert.equal(requestReason({ command: "x", justification: "  Needs\n network  " }), "Needs network");
  assert.equal(requestReason({ CommandLine: "npm test", toolSummary: "npm test" }), null, "only the command again");
  assert.equal(requestReason({ command: "ls" }), null);
  assert.equal(requestReason({ description: "a".repeat(400) }).length, 300);
});

test("without them, what the request does is read off the request", () => {
  assert.equal(requestKind("Bash", { command: "git log" })?.text, "Only looks: changes nothing.");
  assert.equal(requestKind("Read", {})?.text, "Only looks: changes nothing.");
  assert.equal(requestKind("run_command", { CommandLine: "npm install" })?.text, "Runs a command that can change things.");
  assert.equal(requestKind("Write", { file_path: "a" })?.text, "Changes a file.");
  assert.equal(requestKind("WebFetch", {})?.text, "Reads a web page.");
  assert.deepEqual(requestKind("mcp__github__create_issue", {}), { text: "Uses a tool of {server} (MCP).", vars: { server: "github" } });
  assert.equal(requestKind("Task", {}), null);
});

// ── Y and N on the card ───────────────────────────────────────────────────────

test("Y allows and N denies, alone and not held", () => {
  const key = (k, mods = {}) => approvalKey({ key: k, ctrlKey: false, altKey: false, metaKey: false, repeat: false, ...mods });
  assert.equal(key("y"), "allow");
  assert.equal(key("Y"), "allow");
  assert.equal(key("n"), "deny");
  assert.equal(key("x"), null);
  assert.equal(key("y", { ctrlKey: true }), null);
  assert.equal(key("y", { altKey: true }), null);
  assert.equal(key("n", { repeat: true }), null);
});
