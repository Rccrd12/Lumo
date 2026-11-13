// The agents of a model called by its API, or of a model server
// (src-tauri/src/api_agents.rs): rows like Claude Code's, "no signal" past
// their chat's own threshold, and a local model's waiting their turn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { AGENT_STALL_S, CLOUD_STALL_S, LOCAL_START_STALL_S, applyAgent, lookOf, newAgentStore, snooze } = await import("../src/core/chat-agents.ts");
const { agentsCard } = await import("../src/views/agents-card.ts");

const T0 = 1_700_000_000_000;
const S = 1000;
const agent = (id, extra = {}) => ({
  id, source: "anthropic", title: `Read ${id}`, state: "working", steps: 0,
  startedAt: T0, lastSignalAt: T0, background: false, canStop: true, ...extra,
});
const host = { label: (a) => `${a.kind} ${a.detail}`.trim(), stop() {}, send: () => true, requestOnTop: null, seeRequest() {}, changed() {} };

test("an API model's agent gives no signal past 45 s, a local model's past 90 s, a CLI's past 5 min", () => {
  const store = newAgentStore();
  applyAgent(store, { chat: "c", agent: agent("api") }, 0);
  applyAgent(store, { chat: "c", agent: agent("local", { source: "ollama" }) }, 0);
  applyAgent(store, { chat: "c", agent: agent("cli", { source: "claude-code" }) }, 0);
  const c = store.get("c");
  const look = (id, s) => lookOf(c.rows.get(id), T0 + s * S);
  assert.equal(look("api", CLOUD_STALL_S - 1), "working");
  assert.equal(look("api", CLOUD_STALL_S), "stalled");
  assert.equal(look("local", CLOUD_STALL_S), "working");
  assert.equal(look("local", LOCAL_START_STALL_S), "stalled");
  assert.equal(look("cli", LOCAL_START_STALL_S), "working");
  assert.equal(look("cli", AGENT_STALL_S), "stalled");
  // Wait puts it off for its own threshold.
  snooze(c.rows.get("api"), T0 + CLOUD_STALL_S * S);
  assert.equal(look("api", CLOUD_STALL_S + CLOUD_STALL_S - 1), "working");
});

test("a local model's agents wait their turn, with their place, and are never said to give no signal", () => {
  const store = newAgentStore();
  applyAgent(store, { chat: "k", agent: agent("a", { source: "ollama" }) }, 0);
  applyAgent(store, { chat: "k", agent: agent("b", { source: "ollama", state: "waiting", waitingFor: "queue", queue: 1 }) }, 0);
  applyAgent(store, { chat: "k", agent: agent("c", { source: "ollama", state: "waiting", waitingFor: "queue", queue: 2 }) }, 0);
  const c = store.get("k");
  const el = agentsCard({ chatId: "k", chat: c, batch: c.batches[0], now: T0 + 600 * S }, host);
  const lines = el.find(".agents-line").map((l) => l.textContent);
  assert.deepEqual(lines.slice(1), ["Waiting its turn · 1 in line", "Waiting its turn · 2 in line"]);
  assert.equal(lookOf(c.rows.get("b"), T0 + 600 * S), "waiting");
});
