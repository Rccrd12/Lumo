// The Code section's session history (src/core/sessions.ts): the recap's
// turns put together into sessions, and where each project lives.

import { test } from "node:test";
import assert from "node:assert/strict";
import { folderOf, groupSessions, projectName, rememberFolder } from "../src/core/sessions.ts";

const turn = (agent, project, start, end, files = 1) => ({
  agent, project, start, end, filesChanged: files, linesAdded: 10, linesRemoved: 2, commandsRun: 1, questions: 0,
});

test("turns close together on one project are one session; a long pause or another project starts the next", () => {
  const h = 3600;
  const turns = [
    turn("integration_claude", "Lumo", 0, 600),
    turn("integration_claude", "Lumo", 900, 1500, 2), // 5 minutes later: same session
    turn("integration_claude", "sito", 1600, 2000), // another project
    turn("integration_claude", "Lumo", 2000 + h, 2600 + h), // an hour later: a new one
    turn("agent_codex", "Lumo", 100, 200), // another agent: not here
  ];
  const s = groupSessions(turns, "integration_claude");
  assert.deepEqual(s.map((x) => x.project), ["Lumo", "sito", "Lumo"], "newest first");
  const first = s[2];
  assert.equal(first.turns, 2);
  assert.equal(first.filesChanged, 3);
  assert.equal(first.linesAdded, 20);
  assert.equal(first.minutes, 20, "the pause between the turns is not counted");
  assert.equal(first.start, 0);
  assert.equal(first.end, 1500);
  assert.equal(groupSessions(turns, "integration_claude", 1).length, 1);
});

test("where a project is: remembered from a hook's cwd, by its folder's name", () => {
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.equal(projectName("C:\\Users\\me\\Lumo\\"), "Lumo");
  assert.equal(projectName("/home/me/sito"), "sito");
  assert.equal(folderOf("Lumo"), null);
  rememberFolder("C:\\Users\\me\\Lumo");
  assert.equal(folderOf("Lumo"), "C:\\Users\\me\\Lumo");
  rememberFolder("D:\\work\\Lumo");
  assert.equal(folderOf("Lumo"), "D:\\work\\Lumo", "the newest place wins");
  rememberFolder(null);
  delete globalThis.localStorage;
});
