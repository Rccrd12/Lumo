// An agent Claude Code stopped is never taken up again (its SendMessage
// answers success:false): its row offers no Ask, whatever the row says.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { applyAgent, newAgentStore } = await import("../src/core/chat-agents.ts");
const { agentsCard } = await import("../src/views/agents-card.ts");

const T0 = 1_700_000_000_000;
const S = 1000;
const agent = (id, extra = {}) => ({
  id, source: "claude-code", title: `Task ${id}`, state: "working", steps: 0,
  startedAt: T0, lastSignalAt: T0, background: true, canStop: true, ...extra,
});
const host = () => ({
  label: (a) => `${a.kind} ${a.detail}`.trim(), stop: () => {}, send: () => true,
  requestOnTop: null, seeRequest: () => {}, ask: () => {}, changed: () => {},
});

function asks(source) {
  const store = newAgentStore();
  applyAgent(store, { chat: source, agent: agent("st", { source, state: "stopped", endedAt: T0 + S, canAsk: true }) }, 0);
  const c = store.get(source);
  const el = agentsCard({ chatId: source, chat: c, batch: c.batches[0], now: T0 + 5 * S }, host());
  el.querySelector(".agents-folded")?.fire("click");
  el.find(".agents-row-head")[0]?.fire("click");
  return el.find(".agents-btn").filter((b) => b.textContent === "Ask").length;
}

test("no Ask on an agent Claude Code stopped, even from a row saved before it said so", () => {
  assert.equal(asks("claude-code"), 0);
});

test("another CLI's stopped agent that can be asked keeps its Ask", () => {
  assert.equal(asks("codex"), 1);
});
