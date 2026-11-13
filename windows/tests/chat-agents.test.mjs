// The agents a chat's CLI started, and the sign of life (src/core/chat-agents.ts,
// src/views/agents-card.ts, concept: concepts/sotto-agenti): the store kept from
// the `chat-agent` and `chat-signal` events, when an answer or an agent is said
// to give no sign, what is saved with the chat, and the card drawn from it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const {
  AGENT_STALL_S, CLI_STALL_S, CLI_TOOL_STALL_S, CLOUD_STALL_S, LOCAL_START_STALL_S, LOCAL_STREAM_STALL_S, MAX_AGENT_STEPS, MAX_SAVED_AGENTS,
  addUpdate, applyAgent, applySignal, batchEntries, countAgents, durationText, foldsOwnAnswer, islandAgentsLine, lookOf, newAgentStore,
  openCount, permissionMatch, restoreAgents, rewindAgents, savedAgents, snooze, stallOf, withAgents,
} = await import("../src/core/chat-agents.ts");
const { foldOwnAnswer, joinOwnAnswer } = await import("../src/core/chats.ts");
const { conversationTurn } = await import("../src/views/chat.ts");
const { agentsCard, fillAgentsCard } = await import("../src/views/agents-card.ts");

const T0 = 1_700_000_000_000;
const S = 1000;

/** An agent as Rust sends it, whole. */
function agent(id, extra = {}) {
  return {
    id, source: "claude-code", title: `Transcribe ${id}`, state: "working", steps: 0,
    startedAt: T0, lastSignalAt: T0, background: true, canStop: true, ...extra,
  };
}

const send = (store, chat, a, anchor = 0) => applyAgent(store, { chat, agent: a }, anchor);

// ── The store ─────────────────────────────────────────────────────────────────

test("each event is the agent's whole state; one that ended never comes back", () => {
  const store = newAgentStore();
  assert.equal(send(store, "c1", agent("a1")), true);
  assert.equal(send(store, "c1", agent("a1", { steps: 3, now: { kind: "read", detail: "pag-036.png" }, lastSignalAt: T0 + 5 * S })), true);
  const c = store.get("c1");
  assert.equal(c.rows.get("a1").row.steps, 3);
  assert.equal(c.lastSignalAt, T0 + 5 * S, "an agent heard of is a sign of life of its chat");
  assert.equal(openCount(c), 1);

  send(store, "c1", agent("a1", { state: "done", summary: "40 pages", endedAt: T0 + 60 * S }));
  // A late event from before the end changes nothing.
  assert.equal(send(store, "c1", agent("a1", { state: "working", steps: 9 })), false);
  assert.equal(c.rows.get("a1").row.state, "done");
  assert.equal(openCount(c), 0);
  // Nothing without a chat or an id.
  assert.equal(applyAgent(store, { chat: "", agent: agent("x") }, 0), false);
  assert.equal(applyAgent(store, { chat: "c1", agent: { ...agent("x"), id: "" } }, 0), false);
});

test("an agent keeps its last steps, newest first, each once", () => {
  const store = newAgentStore();
  for (let i = 0; i < 8; i++) {
    const now = { kind: "read", detail: `pag-0${i}.png` };
    send(store, "c", agent("a", { now, lastSignalAt: T0 + i * S }));
    send(store, "c", agent("a", { now, lastSignalAt: T0 + i * S + 100 })); // the same step again
  }
  const steps = store.get("c").rows.get("a").steps;
  assert.equal(steps.length, MAX_AGENT_STEPS);
  assert.equal(steps[0].now.detail, "pag-07.png");
  assert.equal(steps[0].at, T0 + 7 * S, "when it began");
});

test("agents started together share a card; a new batch goes under the answer then", () => {
  const store = newAgentStore();
  send(store, "c", agent("a1"), 1);
  send(store, "c", agent("a2"), 1);
  // Still at work: a third joins them, whatever the anchor asked.
  send(store, "c", agent("a3"), 2);
  const c = store.get("c");
  assert.deepEqual(c.batches.map((b) => [b.anchor, b.ids]), [[1, ["a1", "a2", "a3"]]]);
  for (const id of ["a1", "a2", "a3"]) send(store, "c", agent(id, { state: "done" }));
  // All over: the next one starts a batch under the answer given…
  send(store, "c", agent("b1"), 3);
  // …asked only for a new agent.
  let asked = 0;
  applyAgent(store, { chat: "c", agent: agent("b1", { steps: 1 }) }, () => ++asked);
  assert.equal(asked, 0);
  assert.deepEqual(c.batches.map((b) => [b.anchor, b.ids]), [[1, ["a1", "a2", "a3"]], [3, ["b1"]]]);
});

test("the sign of life moves forward only, and says when the answer waits for the user", () => {
  const store = newAgentStore();
  assert.equal(applySignal(store, { chat: "c", at: T0 }), true);
  assert.equal(applySignal(store, { chat: "c", at: T0 - S }), false, "an older one changes nothing");
  assert.equal(applySignal(store, { chat: "c", at: T0, waiting: "permission" }), true);
  assert.equal(store.get("c").waiting, "permission");
  assert.equal(applySignal(store, { chat: "c", at: T0 + S }), true);
  assert.equal(store.get("c").waiting, "permission", "a plain signal leaves the waiting as it is");
  applySignal(store, { chat: "c", at: T0 + 2 * S, waiting: null });
  assert.equal(store.get("c").waiting, null);
});

// ── Liveness ──────────────────────────────────────────────────────────────────

test("no sign of life is said past each provider's threshold", () => {
  const stalled = (l, seconds) => stallOf({ lastSignalAt: T0, ...l }, T0 + seconds * S);
  const turn = (provider, kind = "thinking") => ({ kind: "turn", provider, activity: { kind, detail: "" } });
  assert.equal(stalled({ kind: "agent" }, AGENT_STALL_S - 1), null);
  assert.deepEqual(stalled({ kind: "agent" }, AGENT_STALL_S), { seconds: AGENT_STALL_S });
  assert.equal(AGENT_STALL_S, 300);
  // The cloud APIs stream all along.
  for (const p of ["anthropic", "openai", "google", "openrouter"]) {
    assert.equal(stalled(turn(p), CLOUD_STALL_S - 1), null, p);
    assert.ok(stalled(turn(p), CLOUD_STALL_S), p);
  }
  assert.equal(CLOUD_STALL_S, 45);
  // A local model: quick while it writes, slow while it loads or reads the prompt.
  for (const p of ["ollama", "lmstudio", "unsloth", "custom"]) {
    assert.ok(stalled(turn(p), LOCAL_STREAM_STALL_S), p);
    assert.equal(stalled(turn(p, "prompt"), LOCAL_STREAM_STALL_S), null, p);
    assert.ok(stalled(turn(p, "loading"), LOCAL_START_STALL_S), p);
  }
  assert.deepEqual([LOCAL_STREAM_STALL_S, LOCAL_START_STALL_S], [20, 90]);
  // A CLI: two minutes thinking, five running a command, a sub-task or a tool.
  assert.ok(stalled(turn("claude-code"), CLI_STALL_S));
  assert.equal(stalled(turn("claude-code", "command"), CLI_STALL_S), null);
  assert.ok(stalled(turn("codex", "subtask"), CLI_TOOL_STALL_S));
  assert.deepEqual([CLI_STALL_S, CLI_TOOL_STALL_S], [120, 300]);
  // Waiting for the user is never stuck; nothing heard yet is not either.
  assert.equal(stalled({ ...turn("anthropic"), waiting: true }, 600), null);
  assert.equal(stallOf({ kind: "agent", lastSignalAt: 0 }, T0), null);
});

test("an agent's look: done, at work, no sign, waiting, failed; Wait puts the warning off", () => {
  const store = newAgentStore();
  send(store, "c", agent("done", { state: "done" }));
  send(store, "c", agent("work", { lastSignalAt: T0 + 400 * S }));
  send(store, "c", agent("quiet"));
  send(store, "c", agent("asks"));
  send(store, "c", agent("limit", { state: "waiting", waitingFor: "rate_limit" }));
  send(store, "c", agent("gone", { state: "failed", error: "Claude Code ended" }));
  send(store, "c", agent("halted", { state: "stopped" }));
  const c = store.get("c");
  const now = T0 + 401 * S;
  const permission = new Set(["asks"]);
  const look = (id) => lookOf(c.rows.get(id), now, permission);
  assert.deepEqual(["done", "work", "quiet", "asks", "limit", "gone", "halted"].map(look),
    ["done", "working", "stalled", "waiting", "waiting", "failed", "failed"]);
  assert.deepEqual(countAgents([...c.rows.values()], now, permission),
    { total: 7, done: 1, working: 1, stalled: 1, waiting: 2, failed: 2, open: 4 });
  snooze(c.rows.get("quiet"), now);
  assert.equal(look("quiet"), "working");
  assert.equal(lookOf(c.rows.get("quiet"), now + AGENT_STALL_S * S + S), "stalled", "and comes back after another threshold");
});

test("a permission card is the chat's answer's, or the agent's that asked", () => {
  const cards = [
    { sessionId: "s1", fromChat: true },
    { sessionId: "s1", agentId: "a2", fromChat: true },
    { sessionId: "s9", agentId: "a3", fromChat: true },
    { sessionId: "s1" }, // a terminal's, not the chat's
  ];
  const got = permissionMatch(cards, "s1", false, ["a1", "a2", "a3"]);
  assert.equal(got.main, true);
  assert.deepEqual([...got.agents].sort(), ["a2", "a3"]);
  assert.equal(permissionMatch([cards[0]], "s2", true, []).main, false, "another session's");
  assert.equal(permissionMatch([cards[0]], null, true, []).main, true, "the first question: the chat on screen's");
  assert.equal(permissionMatch([cards[0]], null, false, []).main, false);
});

// ── Progress updates, and what is saved ───────────────────────────────────────

test("an answer of its own while agents work is folded under them; with none at work it joins", () => {
  const store = newAgentStore();
  assert.equal(foldsOwnAnswer(store.get("c")), false);
  send(store, "c", agent("a1"));
  send(store, "c", agent("a2", { state: "done" }));
  const c = store.get("c");
  assert.equal(foldsOwnAnswer(c), true);
  assert.equal(addUpdate(c, "L15 is ready, 7 to go."), true);
  assert.deepEqual(c.batches[0].updates, ["L15 is ready, 7 to go."]);
  send(store, "c", agent("a1", { state: "done" }));
  assert.equal(foldsOwnAnswer(c), false);

  // Rust's conversation has it all the same: what goes back to it holds it.
  const turns = [{ role: "user", content: "go" }, { role: "assistant", content: "Launched 8 agents." }];
  assert.equal(foldOwnAnswer(turns, "L15 is ready."), true);
  assert.equal(turns[1].content, "Launched 8 agents.");
  assert.equal(turns[1].kept, "Launched 8 agents.\n\nL15 is ready.");
  foldOwnAnswer(turns, "L16 too.");
  assert.equal(turns[1].kept, "Launched 8 agents.\n\nL15 is ready.\n\nL16 too.");
  assert.equal(foldOwnAnswer([{ role: "user", content: "a" }], "x"), false);

  // The last agent done, the final report joins the answer's text, and what goes back to Rust too.
  assert.equal(joinOwnAnswer(turns, "All merged, compiled OK."), true);
  assert.equal(turns[1].content, "Launched 8 agents.\n\nAll merged, compiled OK.");
  assert.equal(conversationTurn(turns[1]).content, "Launched 8 agents.\n\nL15 is ready.\n\nL16 too.\n\nAll merged, compiled OK.");
  // An answer with no updates keeps no `kept`.
  const plain = [{ role: "assistant", content: "Hi." }];
  joinOwnAnswer(plain, "More.");
  assert.deepEqual(plain, [{ role: "assistant", content: "Hi.\n\nMore." }]);
});

test("an edited question takes the agents of the answers it drops with it", () => {
  const store = newAgentStore();
  send(store, "c", agent("old1", { state: "done" }), 0);
  send(store, "c", agent("old2"), 1);
  addUpdate(store.get("c"), "half way");
  const c = store.get("c");
  assert.deepEqual(c.batches.map((b) => b.anchor), [0, 1]);
  // The second question is edited: one answer stays.
  rewindAgents(store, "c", 1);
  assert.deepEqual(c.batches.map((b) => [b.anchor, b.ids]), [[0, ["old1"]]]);
  assert.equal(c.rows.has("old2"), false);
  assert.equal(openCount(c), 0);
  // Its end, sent when the next question starts a new session, makes no card.
  assert.equal(send(store, "c", agent("old2", { state: "failed", error: "Claude Code ended" }), 1), false);
  assert.equal(c.batches.length, 1);
  // The new answer's agents start a batch of their own.
  send(store, "c", agent("new1"), 1);
  assert.deepEqual(c.batches.map((b) => [b.anchor, b.ids, b.updates]), [[0, ["old1"], []], [1, ["new1"], []]]);
  // Nothing to drop: nothing changes.
  rewindAgents(store, "c", 5);
  rewindAgents(store, "none", 0);
  assert.equal(c.batches.length, 2);
});

test("the agents that ended are saved with their answer, in short, and come back", () => {
  const store = newAgentStore();
  for (let i = 0; i < MAX_SAVED_AGENTS + 3; i++) {
    send(store, "c", agent(`a${i}`, { state: "done", summary: "ok", steps: 4, tokens: 1200, endedAt: T0 + S, now: { kind: "read", detail: "x" } }), 1);
  }
  send(store, "c", agent("open"), 1);
  addUpdate(store.get("c"), "half way");
  const c = store.get("c");
  const kept = savedAgents(batchEntries(c, c.batches[0]));
  assert.equal(kept.length, MAX_SAVED_AGENTS, "at most this many, the open one left out");
  assert.deepEqual(Object.keys(kept[0]).sort(), ["endedAt", "id", "startedAt", "state", "steps", "summary", "title", "tokens"]);

  const turns = [
    { role: "user", content: "q1" }, { role: "assistant", content: "r1" },
    { role: "user", content: "q2" }, { role: "assistant", content: "r2" },
  ];
  const saved = withAgents(c, turns);
  assert.equal(saved[1].agents, undefined);
  assert.equal(saved[3].agents.length, MAX_SAVED_AGENTS);
  assert.deepEqual(saved[3].updates, ["half way"]);
  assert.equal(turns[3].agents, undefined, "the turns given are left as they were");

  const back = newAgentStore();
  restoreAgents(back, "c", saved);
  const again = back.get("c");
  assert.deepEqual(again.batches.map((b) => [b.anchor, b.ids.length, b.updates]), [[1, MAX_SAVED_AGENTS, ["half way"]]]);
  assert.equal(again.rows.get(kept[0].id).row.state, "done");
  // The island's own, still at work, win over what was saved.
  restoreAgents(store, "c", [{ role: "assistant", content: "x", agents: [] }]);
  assert.equal(store.get("c").batches.length, 1);
  // Nonsense is left out.
  restoreAgents(back, "d", [{ role: "assistant", agents: [{ id: 1 }, { id: "w", title: "t", state: "working" }], updates: [3] }]);
  assert.equal(back.get("d").batches.length, 0);
});

test("the closed island's line: how many work and how far, or one with no sign", () => {
  assert.deepEqual([durationText(45 * S), durationText(14 * 60 * S), durationText(80 * 60 * S), durationText(120 * 60 * S)],
    ["45 s", "14 min", "1 h 20 min", "2 h"]);
  const store = newAgentStore();
  for (const id of ["a", "b", "c"]) send(store, "x", agent(id, { state: "done" }));
  for (const id of ["d", "e"]) send(store, "x", agent(id, { lastSignalAt: T0 + 400 * S }));
  const entries = [...store.get("x").rows.values()];
  // How far they are ("3/5") is drawn apart: after the segments, or after the words in the home's list.
  assert.deepEqual(islandAgentsLine(entries, T0 + 401 * S), { text: "2 agents working", stalled: false });
  send(store, "x", agent("f"));
  const more = [...store.get("x").rows.values()];
  assert.deepEqual(islandAgentsLine(more, T0 + 360 * S), { text: "1 agent with no signal for 6 min", stalled: true });
  for (const id of ["d", "e", "f"]) send(store, "x", agent(id, { state: "done" }));
  assert.equal(islandAgentsLine([...store.get("x").rows.values()], T0), null);
});

// ── The card ──────────────────────────────────────────────────────────────────

function host(extra = {}) {
  const log = { stopped: [], sent: [], seen: [], changed: 0 };
  return {
    log,
    host: {
      label: (a) => `${a.kind} ${a.detail}`.trim(),
      stop: (id) => log.stopped.push(id),
      send: (text) => {
        log.sent.push(text);
        return true;
      },
      requestOnTop: null,
      seeRequest: (id) => log.seen.push(id),
      changed: () => log.changed++,
      ...extra,
    },
  };
}

const texts = (el, cls) => el.find(cls).map((e) => e.textContent);

test("the card: how many are done, a segment each, a row each with what it does", () => {
  const store = newAgentStore();
  send(store, "card1", agent("L15", { title: "Transcribe L15", state: "done", summary: "21 pages, L15.tex", endedAt: T0 + 6 * 60 * S }));
  send(store, "card1", agent("L03", { title: "Transcribe L03", now: { kind: "read", detail: "pag-037.png" }, lastSignalAt: T0 + 14 * 60 * S - 2 * S }));
  send(store, "card1", agent("L05", { title: "Transcribe L05", lastSignalAt: T0 }));
  send(store, "card1", agent("L10", { title: "Transcribe L10", lastSignalAt: T0 + 14 * 60 * S }));
  const c = store.get("card1");
  const { host: h, log } = host({ requestOnTop: "L10" });
  const now = T0 + 14 * 60 * S;
  const el = agentsCard({ chatId: "card1", chat: c, batch: c.batches[0], who: "Claude Code", permission: new Set(["L10"]), now }, h);
  assert.equal(el.querySelector(".agents-title").textContent, "Agents");
  assert.equal(el.querySelector(".agents-status").textContent, "1 of 4 done · 1 with no signal");
  assert.deepEqual(el.querySelector(".agents-segs").children.map((i) => i.className), ["done", "working", "stalled", "waiting"]);
  assert.deepEqual(texts(el, ".agents-name"), ["Transcribe L15", "Transcribe L03", "Transcribe L05", "Transcribe L10"]);
  assert.deepEqual(texts(el, ".agents-line"), [
    "Done: 21 pages, L15.tex", "read pag-037.png", "No signal for 14 min", "Waiting for your permission",
  ]);
  const rows = el.find(".agents-row");
  assert.equal(rows[0].querySelector(".agents-time").textContent, "done in 6 min");
  assert.equal(rows[1].querySelector(".agents-time").textContent, "14 min · 2 s ago");
  // No sign: Wait and Stop; waiting: See request.
  assert.deepEqual(texts(rows[2], ".agents-btn"), ["Wait", "Stop"]);
  rows[2].querySelector(".agents-btn.stop").fire("click");
  assert.deepEqual(log.stopped, ["L05"]);
  rows[3].querySelector(".agents-btn.see").fire("click");
  assert.deepEqual(log.seen, ["L10"]);
  rows[2].querySelector(".agents-btn.wait").fire("click");
  assert.equal(el.find(".agents-row")[2].className.includes("stalled"), false, "Wait: no warning for now");
  // Under the card: the dots, how many work, the last sign.
  assert.equal(el.querySelector(".agents-live-text").textContent, "3 agents working · last signal 0 s ago");

  // The card up is another's (the answer's own, another chat's), or there is none (Claude Code checking a call): no See request.
  const other = agentsCard({ chatId: "card1", chat: c, batch: c.batches[0], who: "Claude Code", permission: new Set(["L10"]), now }, host().host);
  assert.equal(other.find(".agents-row")[3].querySelector(".agents-btn.see"), null);
  assert.equal(other.find(".agents-row")[3].className.includes("waiting"), true, "the row still says it waits");
});

test("as each second goes only the card's words change: its buttons stay under the mouse", () => {
  const store = newAgentStore();
  send(store, "card5", agent("a", { lastSignalAt: T0 }));
  send(store, "card5", agent("b", { lastSignalAt: T0 }));
  const c = store.get("card5");
  const { host: h } = host();
  const input = { chatId: "card5", chat: c, batch: c.batches[0], who: "Claude Code", now: T0 + 400 * S };
  const el = agentsCard(input, h);
  const wait = el.find(".agents-row")[0].querySelector(".agents-btn.wait");
  const line = el.find(".agents-line")[0];
  assert.equal(line.textContent, "No signal for 6 min");
  fillAgentsCard(el, { ...input, now: T0 + 430 * S }, h);
  assert.equal(el.find(".agents-row")[0].querySelector(".agents-btn.wait"), wait, "the same button");
  assert.equal(el.find(".agents-line")[0], line);
  assert.equal(line.textContent, "No signal for 7 min");
  assert.equal(line.getAttribute("title"), "No signal for 7 min");
  // Something else than words changed (an agent done): drawn anew.
  send(store, "card5", agent("a", { state: "done", endedAt: T0 + 431 * S }));
  fillAgentsCard(el, { ...input, now: T0 + 431 * S }, h);
  assert.notEqual(el.find(".agents-row")[0].querySelector(".agents-btn.wait"), wait);
  assert.ok(el.find(".agents-row")[0].className.includes("done"));
});

test("a row opens on its summary, its last steps and its numbers, with Stop this agent and Close", () => {
  const store = newAgentStore();
  send(store, "card2", agent("a", { now: { kind: "read", detail: "pag-036.png" }, lastSignalAt: T0 + 30 * S }));
  send(store, "card2", agent("a", { now: { kind: "edit", detail: "L04.tex" }, summary: "L03 done, on L04", steps: 87, tokens: 212_000, lastSignalAt: T0 + 60 * S }));
  const c = store.get("card2");
  const { host: h, log } = host();
  const el = agentsCard({ chatId: "card2", chat: c, batch: c.batches[0], who: "Claude Code", now: T0 + 62 * S }, h);
  el.querySelector(".agents-row-head").fire("click");
  assert.equal(el.querySelector(".agents-summary").textContent, "L03 done, on L04");
  assert.deepEqual(texts(el, ".agents-step-what"), ["edit L04.tex", "read pag-036.png"]);
  assert.match(el.querySelector(".agents-numbers").textContent, /^87 steps · 212K tokens · 1 min$/);
  assert.ok(log.changed > 0, "the chat hears the card grew");
  el.querySelector(".agents-btn.stop").fire("click");
  assert.deepEqual(log.stopped, ["a"]);
  el.querySelector(".agents-btn.close").fire("click");
  assert.equal(el.querySelector(".agents-detail"), null);
});

test("all over, the card folds into one line that opens again; updates fold into one line too", () => {
  const store = newAgentStore();
  for (const id of ["a", "b"]) send(store, "card3", agent(id, { state: "done", endedAt: T0 + 31 * 60 * S }));
  const c = store.get("card3");
  addUpdate(c, "first");
  c.batches[0].updates.push("L03 and L04 are ready: 19 lessons of 19.");
  const { host: h } = host();
  const el = agentsCard({ chatId: "card3", chat: c, batch: c.batches[0], who: "Claude", now: T0 + 32 * 60 * S }, h);
  const folded = el.querySelector(".agents-folded");
  assert.equal(folded.querySelector(".agents-title").textContent, "2 agents finished");
  assert.equal(folded.querySelector(".agents-status").textContent, "in 31 min");
  assert.equal(el.querySelector(".agents-live"), null, "no dots once all are over");
  assert.equal(el.querySelector(".agents-updates-text").textContent, "2 updates from Claude · latest: «L03 and L04 are ready: 19 lessons of 19.»");
  el.querySelector(".agents-updates-head").fire("click");
  assert.deepEqual(texts(el, ".agents-update"), ["first", "L03 and L04 are ready: 19 lessons of 19."]);
  el.querySelector(".agents-folded").fire("click");
  assert.equal(el.find(".agents-row").length, 2, "opened again");
});

test("the CLI ended under its agents: a red line, and Resume sends a message only on its click", () => {
  const store = newAgentStore();
  send(store, "card4", agent("a", { state: "done" }));
  send(store, "card4", agent("b", { title: "Transcribe L10", state: "failed", error: "Claude Code ended" }));
  send(store, "card4", agent("c", { title: "Transcribe L16", state: "failed", error: "Claude Code ended" }));
  const c = store.get("card4");
  const { host: h, log } = host();
  const el = agentsCard({ chatId: "card4", chat: c, batch: c.batches[0], who: "Claude Code", now: T0 }, h);
  assert.equal(el.querySelector(".agents-ended-text").textContent, "Claude Code ended: 2 agents stopped halfway");
  assert.deepEqual(log.sent, []);
  el.querySelector(".agents-btn.resume").fire("click");
  assert.equal(log.sent.length, 1);
  assert.match(log.sent[0], /Claude Code ended while these agents were still working/);
  assert.match(log.sent[0], /- Transcribe L10\n- Transcribe L16$/);
  assert.equal(el.querySelector(".agents-ended"), null, "once resumed, the card folds as any other");

  // Not sent (a question being edited): the red line stays, Resume with it.
  const store2 = newAgentStore();
  send(store2, "card6", agent("b", { state: "failed", error: "Claude Code ended" }));
  const c2 = store2.get("card6");
  const refused = agentsCard({ chatId: "card6", chat: c2, batch: c2.batches[0], who: "Claude Code", now: T0 }, host({ send: () => false }).host);
  refused.querySelector(".agents-btn.resume").fire("click");
  assert.equal(c2.batches[0].resumed, undefined);
  assert.ok(refused.querySelector(".agents-ended"));
});
