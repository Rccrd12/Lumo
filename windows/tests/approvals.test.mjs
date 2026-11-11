// Which permission requests the closed island can answer (src/core/approvals.ts):
// only reads and commands that only look; everything else opens the full card.

import { test } from "node:test";
import assert from "node:assert/strict";
import { approvalKey, isLookingCommand, isSimpleRequest, requestKind, requestReason } from "../src/core/approvals.ts";

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
    // Options before the subcommand that can run a program or point git elsewhere.
    "git -c core.pager=evil log", "git -ccore.pager=evil log", "git --config-env=core.pager=X log",
    "git --exec-path=/tmp status", "git --git-dir=/x log", "git -C dir remote add x y", "git -C",
  ]) assert.equal(isLookingCommand(c), false, c);
  for (const c of [
    "git branch -a", "git branch --show-current", "git reflog", "git grep -n TODO", "hostname", "date +%F",
    "git --no-pager log -3", "git -C ../other status", "git -P diff", "git -C x remote -v",
  ]) {
    assert.ok(isLookingCommand(c), c);
  }
  assert.equal(isSimpleRequest("Bash", {}), false);
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
  // Copilot CLI's and Cursor CLI's cards name a deletion and a move as such (acp_chat.rs).
  assert.equal(requestKind("Delete", { file_path: "C:\\p\\old.ts" })?.text, "Deletes a file.");
  assert.equal(requestKind("Move", { file_path: "a → b" })?.text, "Moves or renames a file.");
  assert.equal(isSimpleRequest("Delete", { file_path: "a" }), false, "a deletion never only looks");
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

test("a file to write is counted for its card: lines added and removed, and a new text's size", async () => {
  const { editStat } = await import("../src/core/approvals.ts");
  const file = "export const x = 1;\n".repeat(700); // 14 000 bytes
  assert.deepEqual(editStat("Write", { file_path: "C:/p/page.ts", content: file }), { added: 700, removed: 0, bytes: 14_000 });
  // Bytes, not characters: what the file will weigh.
  assert.equal(editStat("Write", { file_path: "C:/p/a.txt", content: "è\n" }).bytes, 3);
  assert.deepEqual(editStat("Edit", { file_path: "C:/p/a.ts", old_string: "a\nb\n", new_string: "a\nc\nd\n" }), { added: 2, removed: 1 });
  assert.deepEqual(editStat("MultiEdit", { file_path: "C:/p/a.ts", edits: [{ old_string: "x", new_string: "y" }, { old_string: "", new_string: "z\nw" }] }),
    { added: 3, removed: 1 });
  assert.deepEqual(editStat("NotebookEdit", { notebook_path: "C:/p/a.ipynb", new_source: "import x\nx()\n" }), { added: 2, removed: 0 });
  // Nothing to count: no line under the file.
  assert.equal(editStat("NotebookEdit", { notebook_path: "C:/p/a.ipynb", new_source: "x", edit_mode: "delete" }), null);
  assert.equal(editStat("Edit", { file_path: "C:/p/a.ts", old_string: "same", new_string: "same" }), null);
  assert.equal(editStat("Write", { file_path: "C:/p/a.ts", content: "" }), null);
  assert.equal(editStat("Bash", { command: "ls" }), null);
  assert.equal(editStat("write_file", { file_path: "C:/p/a.ts", content: "x" }), null);
});

test("a request cut short offers no button that does nothing: Allow and a plan's Approve both go", async () => {
  const { approvalOffer } = await import("../src/core/approvals.ts");
  const plan = [{ text: "Read the settings page" }, { text: "Add the toggle" }];
  // Whole: Allow, and what the request can have besides.
  assert.deepEqual(approvalOffer({ sessionAllow: true }), { allow: true, cutNote: false, sessionAllow: true, planEdits: false, answerThere: null });
  assert.deepEqual(approvalOffer({ plan }), { allow: true, cutNote: false, sessionAllow: false, planEdits: true, answerThere: null });
  assert.deepEqual(approvalOffer({ plan, fromChat: true }), { allow: true, cutNote: false, sessionAllow: false, planEdits: false, answerThere: null });
  // Cut: no Allow, no session, back to the agent's own window (not from the chat: it has none).
  assert.deepEqual(approvalOffer({ cut: true, sessionAllow: true }), { allow: false, cutNote: true, sessionAllow: false, planEdits: false, answerThere: "elsewhere" });
  assert.deepEqual(approvalOffer({ cut: true, fromChat: true }), { allow: false, cutNote: true, sessionAllow: false, planEdits: false, answerThere: null });
  // A plan cut short: its Approve is gone too (pipe.rs would refuse it), and says why.
  assert.deepEqual(approvalOffer({ plan, cut: true }), { allow: false, cutNote: true, sessionAllow: false, planEdits: false, answerThere: "elsewhere" });
  // An agent that answers in its own window says so by name, on any card but a plan's.
  assert.equal(approvalOffer({ answerIn: "Antigravity" }).answerThere, "agent");
  assert.equal(approvalOffer({ answerIn: "Antigravity", plan }).answerThere, null);
  // An email is never "cut": its card has its own buttons.
  assert.equal(approvalOffer({ email: { to: ["a@b.c"] }, cut: true }).allow, true);
});

test("a lone carriage return ends a command: what comes after it is looked at too", () => {
  assert.equal(isLookingCommand("Get-ChildItem\rRemove-Item C:\\x -Recurse"), false);
  assert.equal(isLookingCommand("Get-ChildItem\r\nGet-Location"), true);
  assert.equal(isLookingCommand("Get-ChildItem\rGet-Location"), true);
});
