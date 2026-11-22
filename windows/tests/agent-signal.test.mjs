// Why an agent is quiet, said for what it is (concepts/segnale-agenti): the
// command it waits on, its writing, its request tried again; and only then,
// in amber or red, what needs a look. And its segments, however many.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const {
  AGENT_STALL_S, CLI_LOST_S, COMMAND_STALL_S, WRITING_AFTER_S, agentStall, applyAgent, applySignal, countAgents, islandAgentsLine, lookOf, newAgentStore,
} = await import("../src/core/chat-agents.ts");
const { agentsCard } = await import("../src/views/agents-card.ts");
const { agentSegments, MAX_AGENT_SEGMENTS } = await import("../src/views/agent-segments.ts");

const T0 = 1_700_000_000_000;
const S = 1000;
const MIN = 60 * S;

function agent(id, extra = {}) {
  return {
    id, source: "claude-code", title: id, state: "working", steps: 3,
    startedAt: T0, lastSignalAt: T0, background: true, canStop: true, canAsk: true, inCall: false, heartbeat: true, ...extra,
  };
}

function cardOf(rows, now, signalAt = now) {
  const store = newAgentStore();
  for (const r of rows) applyAgent(store, { chat: "c", agent: r }, 0);
  applySignal(store, { chat: "c", at: signalAt });
  const c = store.get("c");
  const host = { label: (a) => `${a.kind} ${a.detail}`.trim(), stop: () => {}, send: () => true, ask: () => {}, requestOnTop: null, seeRequest: () => {}, changed: () => {} };
  return { store, c, el: agentsCard({ chatId: "c", chat: c, batch: c.batches[0], now }, host) };
}

const texts = (el, sel) => el.find(sel).map((n) => n.textContent);

test("a command at work, its writing, its retry: blue or grey, never a warning", () => {
  const now = T0 + 14 * MIN;
  const { c, el } = cardOf([
    agent("build", { running: { id: "b1", text: "npm run build", since: now - 6 * MIN }, inCall: true, lastSignalAt: now - 6 * MIN }),
    agent("file", { lastSignalAt: now - 3 * MIN }),
    agent("retry", { state: "waiting", waitingFor: "retry", retry: { attempt: 3, max: 10, delayMs: 30 * S, at: now, status: 529, category: "overloaded" } }),
    agent("rate", { state: "waiting", waitingFor: "retry", retry: { attempt: 1, max: 10, delayMs: 20 * S, at: now, status: 429 } }),
    agent("late", { state: "waiting", waitingFor: "retry", retry: { attempt: 2, max: 10, delayMs: 5 * S, at: now - 20 * S } }),
  ], now);
  assert.deepEqual(texts(el, ".agents-line"), [
    "Running npm run build · for 6 min",
    "Writing its answer or a long file · for 3 min",
    "API overloaded: retrying in 30 s (attempt 3 of 10)",
    "Rate limit reached: retrying in 20 s (attempt 1 of 10)",
    "Retrying the request (attempt 2 of 10)",
  ]);
  const rows = el.find(".agents-row");
  assert.deepEqual(rows.map((r) => r.className.split(" ").slice(1, 3).join(" ")), ["working", "working", "waiting queued", "waiting queued", "waiting queued"]);
  // Quiet for what it is: how long it has worked, not how long since its last word.
  assert.equal(rows[0].querySelector(".agents-time").textContent, "14 min");
  assert.equal(el.querySelector(".agents-status").textContent, "0 of 5 done");
  assert.equal(countAgents([...c.rows.values()], now).stalled, 0);
});

test("writing only past a minute of silence, and only when no call of its waits", () => {
  const now = T0 + 10 * MIN;
  const at = (s, extra = {}) => cardOf([agent("a", { lastSignalAt: now - s * S, now: { kind: "read", detail: "x.md" }, ...extra })], now).el.querySelector(".agents-line").textContent;
  assert.equal(at(WRITING_AFTER_S - 1), "read x.md");
  assert.equal(at(WRITING_AFTER_S), "Writing its answer or a long file · for 1 min");
  assert.equal(at(5 * 60, { inCall: true }), "read x.md", "a tool it waits on");
  // A terminal session's row (its CLI tells no calls): its last step, as before.
  assert.equal(at(5 * 60, { inCall: undefined, heartbeat: undefined }), "read x.md");
});

test("needs a look: a command past the limit, ten minutes of silence with none, its CLI quiet", () => {
  const now = T0 + 20 * MIN;
  const { c, el } = cardOf([
    agent("long", { running: { id: "b1", text: "python3 gen.py", since: now - COMMAND_STALL_S * S - MIN }, inCall: true, lastSignalAt: now - 13 * MIN }),
    agent("quiet", { lastSignalAt: now - AGENT_STALL_S * S - 2 * MIN }),
    agent("ok", { lastSignalAt: now - S, now: { kind: "edit", detail: "a.py" } }),
  ], now);
  assert.deepEqual(texts(el, ".agents-line"), [
    "Command running for 13 min, past the 10 min limit",
    "No sign for 12 min, no command running",
    "edit a.py",
  ]);
  const rows = el.find(".agents-row");
  assert.deepEqual(texts(rows[0], ".agents-btn"), ["Ask", "Wait", "Stop"]);
  assert.equal(el.querySelector(".agents-status").textContent, "3 at work · 2 to check");
  assert.equal(el.querySelector(".agents-live-text").textContent, "2 agents to check · the others are working");
  assert.deepEqual(islandAgentsLine([...c.rows.values()], now), { text: "2 agents to check", stalled: true });
  // A command under the limit is no warning, however quiet the agent.
  assert.equal(agentStall(c.rows.get("long"), now - 2 * MIN), null);
});

test("Claude Code no longer answering: red, Stop only, and only for a CLI that beats", () => {
  const now = T0 + 20 * MIN;
  const lastWord = now - CLI_LOST_S * S - MIN;
  const { store: card, c, el } = cardOf([agent("gone", { lastSignalAt: lastWord })], now, lastWord);
  assert.equal(el.querySelector(".agents-line").textContent, "Claude Code has not answered for 4 min");
  const row = el.querySelector(".agents-row");
  assert.ok(row.className.includes("stalled") && row.className.includes("lost"));
  assert.deepEqual(texts(row, ".agents-btn"), ["Stop"]);
  assert.deepEqual(el.querySelector(".agents-segs").children.map((i) => i.className), ["failed"]);
  // A word from Claude Code (its beat): the agent is quiet a few minutes, nothing more.
  applySignal(card, { chat: "c", at: now - S });
  assert.equal(agentStall(c.rows.get("gone"), now), null);
  assert.equal(lookOf(c.rows.get("gone"), now), "working");
  // A session in a terminal: no beat, never "not answering".
  const store = newAgentStore();
  applyAgent(store, { chat: "s", agent: agent("t", { heartbeat: undefined, inCall: undefined, lastSignalAt: lastWord }) }, 0);
  assert.equal(agentStall(store.get("s").rows.get("t"), now), null);
  assert.equal(agentStall(store.get("s").rows.get("t"), lastWord + AGENT_STALL_S * S)?.why, "silent");
  // Waiting for the user's permission: Claude Code may well be silent.
  applyAgent(store, { chat: "s", agent: agent("p", { state: "waiting", waitingFor: "permission", lastSignalAt: lastWord }) }, 0);
  assert.equal(lookOf(store.get("s").rows.get("p"), now), "waiting");
});

test("segments: all up to eight, then those at work, then how many", () => {
  const segs = (looks) => {
    const el = agentSegments(looks);
    return el.className === "agents-segs" ? el.children.map((i) => i.className) : el.find(".agents-count").map((n) => `${n.className.split(" ")[1]} ${n.textContent}`);
  };
  assert.equal(MAX_AGENT_SEGMENTS, 8);
  const six = ["done", "done", "working", "working", "stalled", "working"];
  assert.deepEqual(segs(six), six, "six agents, two done: all six");
  const ten = ["done", "done", ...Array(8).fill("working")];
  assert.deepEqual(segs(ten), Array(8).fill("working"), "ten, two done: the eight at work");
  const fifty = [...Array(23).fill("done"), ...Array(24).fill("working"), "queued", "stalled", "stalled"];
  assert.deepEqual(segs(fifty), ["working 25", "stalled 2"], "past eight at work: how many");
  assert.deepEqual(segs([...Array(9).fill("working"), "waiting"]), ["working 9", "waiting 1"]);
});
