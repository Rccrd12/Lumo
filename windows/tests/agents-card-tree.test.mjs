// The Agents card for every provider (src/views/agents-card.ts, concept:
// concepts/sotto-agenti-completo): the tree's lines, the finished branches
// folded, the greys of agents nothing is asked of the user for, done without
// a report, the commands an agent left running, a starter's own agents, and
// what is saved of them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { applyAgent, batchEntries, newAgentStore, restoreAgents, savedAgents, sealAgents, withAgents } = await import("../src/core/chat-agents.ts");
const { agentsCard, folded, nested, treeGuides } = await import("../src/views/agents-card.ts");

const T0 = 1_700_000_000_000;
const S = 1000;

function agent(id, extra = {}) {
  return {
    id, source: "claude-code", title: id, state: "working", steps: 0,
    startedAt: T0, lastSignalAt: T0, background: true, canStop: true, ...extra,
  };
}

const send = (store, chat, a, anchor = 0) => applyAgent(store, { chat, agent: a }, anchor);

const host = {
  label: (a) => `${a.kind} ${a.detail}`.trim(),
  stop: () => {},
  send: () => true,
  requestOnTop: null,
  seeRequest: () => {},
  changed: () => {},
};

/** The card of the chat's first batch, now or at `now`. */
function card(store, chat, extra = {}) {
  const c = store.get(chat);
  return agentsCard({ chatId: chat, chat: c, batch: c.batches[0], now: T0 + 60 * S, ...extra }, host);
}

const texts = (el, cls) => el.find(cls).map((e) => e.textContent);

test("the tree's lines run from each starter down to its last agent, through the agents those start", () => {
  // coord ─┬ a ── a1
  //        ├ b
  //        └ c ── c1
  // solo
  const depths = [0, 1, 2, 1, 1, 2, 0];
  assert.deepEqual(treeGuides(depths), [
    { through: [], last: false },
    { through: [], last: false },
    { through: [1], last: true },
    { through: [], last: false },
    { through: [], last: true },
    { through: [], last: true },
    { through: [], last: false },
  ]);
  // Deeper: the lines of the levels above that go on cross the row.
  assert.deepEqual(treeGuides([0, 1, 2, 3, 2, 1]).map((g) => g.through), [[], [], [1], [1, 2], [1], []]);
});

test("a finished branch folds under its starter, until its row is opened, and says how many it holds", () => {
  const store = newAgentStore();
  send(store, "c", agent("coord", { state: "done", summary: "All three checked", endedAt: T0 + 30 * S }));
  for (const id of ["k1", "k2"]) send(store, "c", agent(id, { parent: "coord", state: "done", endedAt: T0 + 20 * S }));
  send(store, "c", agent("open"));
  send(store, "c", agent("w1", { parent: "open" }));
  send(store, "c", agent("w2", { parent: "open", state: "done", endedAt: T0 + 9 * S }));

  const c = store.get("c");
  const list = nested(batchEntries(c, c.batches[0]));
  assert.deepEqual(folded(list, new Set()).map(([e]) => e.row.id), ["coord", "open", "w1", "w2"]);
  assert.deepEqual(folded(list, new Set(["coord"])).map(([e]) => e.row.id), ["coord", "k1", "k2", "open", "w1", "w2"]);

  const el = card(store, "c");
  assert.deepEqual(texts(el, ".agents-name"), ["coord", "open", "w1", "w2"]);
  assert.equal(el.find(".agents-line")[0].textContent, "2 agents finished · Done: All three checked");
  // A starter whose agents still work says how far along they are.
  assert.equal(el.find(".agents-line")[1].textContent, "Its agents: 1 of 2 finished");
  // Opened, the branch shows.
  el.find(".agents-row-head")[0].fire("click");
  const again = card(store, "c");
  assert.deepEqual(texts(again, ".agents-name"), ["coord", "k1", "k2", "open", "w1", "w2"]);
  assert.equal(again.find(".agents-line")[0].textContent, "Done: All three checked");
});

test("those nothing is asked of the user for are grey: in line, paused, stopped; done without a report is said so", () => {
  const store = newAgentStore();
  send(store, "g", agent("rate", { state: "waiting", waitingFor: "rate_limit" }));
  send(store, "g", agent("pause", { state: "waiting", waitingFor: "paused" }));
  send(store, "g", agent("stop", { state: "stopped", startedAt: T0, endedAt: T0 + 4 * 60 * S }));
  send(store, "g", agent("plain", { state: "done", noReport: true, endedAt: T0 + 5 * S }));
  send(store, "g", agent("last", { state: "done", noReport: true, summary: "Checking the tests again", endedAt: T0 + 5 * S }));
  send(store, "g", agent("perm", { state: "waiting", waitingFor: "permission" }));

  const el = card(store, "g");
  const rows = el.find(".agents-row");
  const shade = (r) => ["queued", "paused", "stopped", "noreport"].find((s) => r.className.split(" ").includes(s)) ?? null;
  assert.deepEqual(rows.map(shade), ["queued", "paused", "stopped", "noreport", "noreport", null]);
  assert.deepEqual(rows.map((r) => r.querySelector(".agents-mark").className), [
    "agents-mark queued", "agents-mark paused", "agents-mark stopped", "agents-mark done", "agents-mark done", "agents-mark waiting",
  ]);
  assert.deepEqual(texts(el, ".agents-line"), [
    "Waiting for the rate limit", "Paused", "Stopped after 4 min", "Finished without a report",
    "Finished without a report · «Checking the tests again»", "Waiting for your permission",
  ]);
  // The header's segments: grey for the three, the agent's own colour for the rest.
  assert.deepEqual(el.querySelector(".agents-segs").children.map((i) => i.className), ["queued", "queued", "queued", "done", "done", "waiting"]);
});

test("the live line says the rate limit in grey when that is all the agents wait for", () => {
  const store = newAgentStore();
  send(store, "r", agent("a", { state: "waiting", waitingFor: "rate_limit" }));
  send(store, "r", agent("b", { state: "waiting", waitingFor: "paused" }));
  let el = card(store, "r");
  assert.ok(el.querySelector(".agents-live").className.includes("queued"));
  assert.equal(el.querySelector(".agents-live-text").textContent, "Waiting for the rate limit");

  // One waits for the user: that is what the line says.
  send(store, "r", agent("c", { state: "waiting", waitingFor: "permission" }));
  el = card(store, "r");
  assert.ok(!el.querySelector(".agents-live").className.includes("queued"));
  assert.equal(el.querySelector(".agents-live-text").textContent, "Waiting for your permission");
});

test("an opened row lists the commands its agent left running, each since when", () => {
  const store = newAgentStore();
  send(store, "b", agent("tests", { commands: [
    { id: "b1", text: "cargo test --workspace", since: T0 + 50 * S },
    { id: "b2", text: "npm run dev -- --port 1420", since: T0 },
  ], now: { kind: "command", detail: "cargo test" } }));
  const el = card(store, "b");
  assert.equal(el.querySelector(".agents-commands"), null, "closed, none shown");
  el.find(".agents-row-head")[0].fire("click");
  const open = card(store, "b");
  assert.deepEqual(texts(open, ".agents-command"), ["cargo test --workspace", "npm run dev -- --port 1420"]);
  assert.deepEqual(open.querySelector(".agents-commands").find(".agents-time").map((x) => x.textContent), ["for 10 s", "for 1 min"]);
  const labels = open.querySelector(".agents-detail").find(".agents-numbers").map((x) => x.textContent);
  assert.deepEqual(labels.slice(0, 2), ["In the background", "Latest actions"]);
});

test("a new answer's agents get a card of their own, but an agent started by one of an earlier card goes under it", () => {
  const store = newAgentStore();
  send(store, "s", agent("first"), 1);
  sealAgents(store, "s");
  send(store, "s", agent("second"), 1);
  send(store, "s", agent("child", { parent: "first" }), 1);
  const c = store.get("s");
  assert.deepEqual(c.batches.map((b) => b.ids), [["first", "child"], ["second"]]);
});

test("a saved chat keeps its tree and which agents finished without a report", () => {
  const store = newAgentStore();
  send(store, "t", agent("coord", { state: "done", endedAt: T0 + S }), 1);
  send(store, "t", agent("kid", { parent: "coord", state: "done", noReport: true, summary: "Read 3 files", endedAt: T0 + S }), 1);
  send(store, "t", agent("busy", { parent: "coord", noReport: true }), 1);
  const c = store.get("t");
  const kept = savedAgents(batchEntries(c, c.batches[0]));
  assert.deepEqual(kept.map((a) => [a.id, a.parent ?? null, a.noReport ?? false]), [
    ["coord", null, false], ["kid", "coord", true], ["busy", "coord", false],
  ]);
  const turns = withAgents(c, [{ role: "user", content: "q" }, { role: "assistant", content: "r" }]);
  const back = newAgentStore();
  restoreAgents(back, "t", turns, "claude-code");
  const rows = back.get("t").rows;
  assert.equal(rows.get("kid").row.parent, "coord");
  assert.equal(rows.get("kid").row.noReport, true);
  assert.equal(rows.get("busy").row.noReport, undefined);
});
