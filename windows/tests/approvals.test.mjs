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

test("the closed island takes only what its two lines show whole", () => {
  // It shows two lines of the command: Allow there must never allow a third.
  assert.equal(isSimpleRequest("Bash", { command: "ls\npwd\ngit status\ncat C:/Users/me/.ssh/id_rsa" }), false);
  assert.equal(isSimpleRequest("Bash", { command: "ls\r\npwd" }), false);
  assert.equal(isSimpleRequest("Bash", { command: `git log --oneline ${"src/".repeat(20)}` }), false);
  assert.equal(isSimpleRequest("Read", { file_path: `C:\\${"cartella\\".repeat(10)}a.txt` }), false);
  // A trailing newline is not a line of its own.
  assert.ok(isSimpleRequest("Bash", { command: "git status\n" }));
  assert.ok(isSimpleRequest("Read", { file_path: "C:\\repo\\README.md", limit: 40 }));
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

test("a change of any size shows the relay's numbers, never the size of what is left of it", async () => {
  const { editStat } = await import("../src/core/approvals.ts");
  // What the relay forwards of a 400 KB rewrite: 256 KB and an ellipsis,
  // with the numbers it read from the whole text against the file on disk.
  const left = "x".repeat(256 * 1024) + "…";
  const input = { file_path: "C:/p/big.txt", content: left };
  assert.deepEqual(editStat("Write", input, { cut: true, added: 1_249, removed: 0, bytes: 400 * 1024 }), { added: 1_249, removed: 0, bytes: 400 * 1024 });
  // Any agent's file tool: Antigravity CLI's edit_file has no count of its own here.
  assert.deepEqual(editStat("edit_file", { Path: "C:/p/a.tex", Target: "a", Replacement: "a\nb" }, { added: 1, removed: 0 }), { added: 1, removed: 0 });
  // A rewrite that drops lines says so.
  assert.deepEqual(editStat("write_to_file", { TargetFile: "C:/p/a.tex" }, { added: 0, removed: 500, bytes: 10 }), { added: 0, removed: 500, bytes: 10 });
  // Without them (a relay from before), no numbers rather than the cut's ones.
  assert.equal(editStat("Write", input, { cut: true }), null);
  assert.equal(editStat("Write", input, { cut: true, added: "4", removed: 0 }), null);
  assert.equal(editStat("Write", input, { cut: true, added: -1, removed: 0 }), null);
  // An edit cut short has no count to trust either: the lines left are not the edit's.
  assert.equal(editStat("Edit", { file_path: "C:/p/a.ts", old_string: "a", new_string: left }, { cut: true }), null);
  assert.equal(editStat("NotebookEdit", { notebook_path: "C:/p/a.ipynb", new_source: left }, { cut: true }), null);
  // Nothing changed: no line.
  assert.equal(editStat("Edit", { file_path: "C:/p/a.ts" }, { added: 0, removed: 0 }), null);
  // No numbers from the relay: a whole request is counted from its text.
  assert.deepEqual(editStat("Write", { file_path: "C:/p/a.txt", content: "a\nb\n" }), { added: 2, removed: 0, bytes: 4 });
});

test("a request cut short is allowed by holding Allow; arguments Lumo can't read never are", async () => {
  const { approvalOffer } = await import("../src/core/approvals.ts");
  const plan = [{ text: "Read the settings page" }, { text: "Add the toggle" }];
  const offer = (o) => ({ allow: true, holdToAllow: false, cutNote: false, unreadNote: false, sessionAllow: false, planEdits: false, answerThere: null, ...o });
  // Whole: Allow, and what the request can have besides.
  assert.deepEqual(approvalOffer({ sessionAllow: true }), offer({ sessionAllow: true }));
  assert.deepEqual(approvalOffer({ plan }), offer({ planEdits: true }));
  assert.deepEqual(approvalOffer({ plan, fromChat: true }), offer({}));
  // Cut: Allow is held down, the note says what is shown, its own window takes it whole; never kept for the session.
  assert.deepEqual(approvalOffer({ cut: true, sessionAllow: true }), offer({ holdToAllow: true, cutNote: true, answerThere: "elsewhere" }));
  // The chat's own run has no window of its own.
  assert.deepEqual(approvalOffer({ cut: true, fromChat: true }), offer({ holdToAllow: true, cutNote: true }));
  // A plan cut short: approved by holding, never "and let it edit files" on a plan seen in part.
  assert.deepEqual(approvalOffer({ plan, cut: true }), offer({ holdToAllow: true, cutNote: true, answerThere: "elsewhere" }));
  // Arguments the relay couldn't read: no Allow at all, only Deny and the agent's own window.
  assert.deepEqual(approvalOffer({ unread: true, sessionAllow: true }), offer({ allow: false, unreadNote: true, answerThere: "elsewhere" }));
  assert.deepEqual(approvalOffer({ unread: true, cut: true }), offer({ allow: false, unreadNote: true, answerThere: "elsewhere" }));
  assert.deepEqual(approvalOffer({ unread: true, fromChat: true }), offer({ allow: false, unreadNote: true }));
  // An agent that answers in its own window says so by name, on any card but a plan's.
  assert.equal(approvalOffer({ answerIn: "Antigravity" }).answerThere, "agent");
  assert.equal(approvalOffer({ answerIn: "Antigravity", cut: true }).answerThere, "agent");
  assert.equal(approvalOffer({ answerIn: "Antigravity", plan }).answerThere, null);
  // An email is never "cut": its card has its own buttons.
  assert.equal(approvalOffer({ email: { to: ["a@b.c"] }, cut: true }).allow, true);
  assert.equal(approvalOffer({ email: { to: ["a@b.c"] }, cut: true }).holdToAllow, false);
  assert.equal(approvalOffer({ email: { to: ["a@b.c"] }, unread: true }).allow, true);
});

test("a lone carriage return ends a command: what comes after it is looked at too", () => {
  assert.equal(isLookingCommand("Get-ChildItem\rRemove-Item C:\\x -Recurse"), false);
  assert.equal(isLookingCommand("Get-ChildItem\r\nGet-Location"), true);
  assert.equal(isLookingCommand("Get-ChildItem\rGet-Location"), true);
});
