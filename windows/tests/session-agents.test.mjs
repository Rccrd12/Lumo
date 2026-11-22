// A terminal session's agents as rows of the Agents card (src/core/session-agents.ts,
// concept: concepts/sessioni-terminale): named after the Agent call that started
// them, what they do from their own tools, their report from SubagentStop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const S = await import("../src/core/session-agents.ts");
const { batchEntries } = await import("../src/core/chat-agents.ts");

const T0 = 1_700_000_000_000;
const rows = (session) => {
  const shown = S.sessionCard(session);
  return shown ? batchEntries(shown.chat, shown.batch).map((e) => e.row) : [];
};

test("each agent is named after the Agent call of its kind, does what its tools say, and reports what it said last", () => {
  S.sessionPrompt("s1");
  S.sessionAgentCall("s1", { description: "Profile the orders API", subagent_type: "Explore", prompt: "…" });
  S.sessionAgentCall("s1", { description: "Fix the search", subagent_type: "general-purpose" });
  S.sessionAgentCall("s1", { prompt: "Profile   the users\nAPI", subagent_type: "Explore" });
  // Started out of order: each takes its kind's call, oldest first.
  assert.ok(S.sessionAgentStarted("s1", "g1", "general-purpose", T0));
  assert.ok(S.sessionAgentStarted("s1", "e1", "Explore", T0));
  assert.ok(S.sessionAgentStarted("s1", "e2", "Explore", T0));
  assert.deepEqual(rows("s1").map((r) => [r.id, r.title, r.state, r.canStop, r.canAsk ?? false]), [
    ["g1", "Fix the search", "working", false, false],
    ["e1", "Profile the orders API", "working", false, false],
    ["e2", "Profile the users API", "working", false, false],
  ]);

  assert.ok(S.sessionAgentTool("s1", "e1", { kind: "step", detail: "Legge · orders.ts" }, T0 + 5000));
  const e1 = rows("s1")[1];
  assert.deepEqual([e1.now, e1.steps, e1.lastSignalAt], [{ kind: "step", detail: "Legge · orders.ts" }, 1, T0 + 5000]);
  // One Lumo never saw start (Lumo opened meanwhile): the session's steps keep it.
  assert.equal(S.sessionAgentTool("s1", "ghost", { kind: "step", detail: "x" }), false);

  assert.ok(S.sessionAgentStopped("s1", "e1", "  orders API: 310 ms\nmedian ", T0 + 9000));
  assert.ok(S.sessionAgentStopped("s1", "e2", "", T0 + 9000));
  const [, done, quiet] = rows("s1");
  assert.deepEqual([done.state, done.summary, done.endedAt], ["done", "orders API: 310 ms median", T0 + 9000]);
  assert.deepEqual([quiet.state, quiet.noReport], ["done", true]);
  assert.equal(S.sessionAgentTool("s1", "e1", { kind: "step", detail: "late" }), false, "an ended row never changes");

  // The session ends: those still at work end with it.
  S.sessionEnded("s1", T0 + 10_000);
  assert.equal(rows("s1")[0].state, "stopped");
});

test("each prompt's agents get a card of their own, and a session forgotten starts again with none", () => {
  S.sessionPrompt("s2");
  S.sessionAgentStarted("s2", "a", "Explore", T0);
  S.sessionPrompt("s2");
  assert.deepEqual(rows("s2").map((r) => r.id), ["a"], "until the new prompt starts one, the last card stays");
  S.sessionAgentStarted("s2", "b", "", T0);
  assert.deepEqual(rows("s2").map((r) => [r.id, r.title]), [["b", "Agent"]]);
  S.forgetSession("s2");
  assert.equal(S.sessionCard("s2"), null);
  S.sessionPrompt("s2");
  assert.ok(S.sessionAgentStarted("s2", "c", "Plan", T0), "resumed later: its agents show again");
  assert.deepEqual(rows("s2").map((r) => r.title), ["Plan"]);
  assert.equal(S.sessionCard(""), null);
  assert.ok(S.startsAgent("Agent") && S.startsAgent("Task") && !S.startsAgent("Bash"));
});
