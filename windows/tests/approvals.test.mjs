// Which permission requests the closed island can answer (src/core/approvals.ts):
// only reads and commands that only look; everything else opens the full card.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isLookingCommand, isSimpleRequest } from "../src/core/approvals.ts";

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
  ]) assert.equal(isLookingCommand(c), false, c);
  assert.equal(isSimpleRequest("Bash", {}), false);
});
