// What Claude Code writes in a session in the user's place (src/core/injected.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readPrompt } from "../src/core/injected.ts";

const NOTE = `<task-notification>
<task-id>bf705pz2t</task-id>
<tool-use-id>toolu_01ABC</tool-use-id>
<output-file>C:\\Users\\me\\AppData\\Local\\Temp\\claude\\tasks\\bf705pz2t.output</output-file>
<status>completed</status>
<summary>Background command "npm test" completed (exit code 0)</summary>
</task-notification>
Read the output file to retrieve the result: C:\\Users\\me\\AppData\\Local\\Temp\\claude\\tasks\\bf705pz2t.output`;

test("a background task's note is no prompt: how it ended and what it was", () => {
  assert.deepEqual(readPrompt(NOTE), {
    kind: "task",
    note: { status: "completed", name: "npm test", text: 'Background command "npm test" completed (exit code 0)' },
  });
  const agent = readPrompt(`<task-notification>\n<task-id>a1</task-id>\n<status>failed</status>\n<summary>Agent "Explore the repo" failed</summary>\n<result>No access</result>\n</task-notification>`);
  assert.equal(agent.note.status, "failed");
  assert.equal(agent.note.name, "Explore the repo");
  assert.equal(agent.note.text, 'Agent "Explore the repo" failed\n\nNo access');
});

test("a note cut by the relay before its closing tags is still a note", () => {
  const read = readPrompt("<task-notification>\n<task-id>bf705pz2t</task-id>\n<tool-use-i");
  assert.equal(read.kind, "task");
  assert.deepEqual(read.note, { status: "", name: "", text: "" });
});

test("reminders and command output for the model are taken out, the user's words stay", () => {
  assert.deepEqual(readPrompt("fix the build\n<system-reminder>\nThe date changed.\n</system-reminder>"), { kind: "user", text: "fix the build" });
  assert.deepEqual(readPrompt("<system-reminder>only for the model</system-reminder>"), { kind: "hidden" });
  assert.deepEqual(readPrompt("<local-command-stdout>Compacted</local-command-stdout>"), { kind: "hidden" });
  assert.deepEqual(readPrompt("<local-command-caveat>Caveat: …</local-command-caveat>"), { kind: "hidden" });
  assert.deepEqual(readPrompt("<system-reminder>cut before its end"), { kind: "hidden" });
});

test("a slash command and a ! command show as typed", () => {
  assert.deepEqual(readPrompt("<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>12</command-args>"),
    { kind: "user", text: "/review 12" });
  assert.deepEqual(readPrompt("<command-name>clear</command-name><command-args></command-args>"), { kind: "user", text: "/clear" });
  assert.deepEqual(readPrompt("<bash-input>git status</bash-input>"), { kind: "user", text: "! git status" });
  assert.deepEqual(readPrompt("<bash-stdout>On branch main</bash-stdout><bash-stderr></bash-stderr>"), { kind: "hidden" });
});

test("another tag of Claude Code's own at the start is not the user's; HTML and tags in the middle are", () => {
  assert.deepEqual(readPrompt("<some-new-notice>\n<id>1</id>\n</some-new-notice>"), { kind: "hidden" });
  assert.deepEqual(readPrompt("<div>why is this centered?</div>"), { kind: "user", text: "<div>why is this centered?</div>" });
  assert.deepEqual(readPrompt("what does <task-notification> mean?"), { kind: "user", text: "what does <task-notification> mean?" });
  assert.deepEqual(readPrompt("plain words"), { kind: "user", text: "plain words" });
});
