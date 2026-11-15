// Ask an agent, and "Talking to …" (src/core/chat-agents.ts, src/views/agents-card.ts,
// src/views/chat.ts; concept: concepts/sotto-agenti-2): Ask on an agent's row
// puts it over the field as a quote, the question goes to the chat's CLI with
// what it takes to pass it on (Claude Code's SendMessage), the question keeps
// the quote, and the CLI's message to the agent and its answer show in a box.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { emit, internals, sent } from "./tauri.mjs";

installFakeDom();
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { askQuoteOf, loadChats } = await import("../src/core/chats.ts");
const {
  agentAsk, applyAgent, askable, newAgentStore, restoreAgents, rewindAgents, talkWaits, waitingTalk, withAgents, MAX_TALKS,
} = await import("../src/core/chat-agents.ts");
const { agentsCard, talkBox, fillTalkBox } = await import("../src/views/agents-card.ts");

const T0 = 1_700_000_000_000;
const S = 1000;

function agent(id, extra = {}) {
  return {
    id, source: "claude-code", title: `Transcribe ${id}`, state: "working", steps: 0,
    startedAt: T0, lastSignalAt: T0, background: true, canStop: true, canAsk: true, ...extra,
  };
}

const send = (store, chat, a, anchor = 0) => applyAgent(store, { chat, agent: a }, anchor);
const talk = (call, extra = {}) => ({ call, message: "What step are you on?", sentAt: T0 + 10 * S, ...extra });

// ── The store ─────────────────────────────────────────────────────────────────

test("an agent taken up again comes back at work; what an older round says is dropped", () => {
  const store = newAgentStore();
  send(store, "c", agent("a", { state: "done", endedAt: T0 + S, summary: "counted" }));
  const c = store.get("c");
  // Its end, sent again late: nothing changes.
  assert.equal(send(store, "c", agent("a")), false, "an ended agent does not come back at work in the same round");
  // A message takes it up again: a new round.
  assert.equal(send(store, "c", agent("a", { round: 1, talk: talk("t1") })), true);
  assert.equal(c.rows.get("a").row.state, "working");
  assert.equal(c.batches.length, 1, "still in its card");
  // Something of the first round, late: dropped.
  assert.equal(send(store, "c", agent("a", { state: "done", round: 0 })), false);
  assert.equal(c.rows.get("a").row.state, "working");
});

test("a message to an agent is a talk of the answer that sent it, until its answer comes", () => {
  const store = newAgentStore();
  send(store, "c", agent("a"), 0);
  send(store, "c", agent("a", { talk: talk("t1") }), 1);
  const c = store.get("c");
  assert.deepEqual(c.talks.map((x) => [x.call, x.agentId, x.title, x.anchor]), [["t1", "a", "Transcribe a", 1]]);
  assert.equal(talkWaits(c.talks[0]), true);
  assert.equal(waitingTalk(c), c.talks[0]);
  // The same message again (each event is the agent's whole state): one talk.
  send(store, "c", agent("a", { steps: 2, talk: talk("t1") }), 2);
  assert.equal(c.talks.length, 1);
  assert.equal(c.talks[0].anchor, 1, "it stays where it was sent");
  send(store, "c", agent("a", { talk: talk("t1", { reply: "Step 2 of 3", repliedAt: T0 + 14 * S }) }), 2);
  assert.equal(c.talks[0].reply, "Step 2 of 3");
  assert.equal(waitingTalk(c), undefined);
  // At most so many are kept.
  for (let i = 0; i < MAX_TALKS + 5; i++) send(store, "c", agent("a", { talk: talk(`m${i}`) }), 3);
  assert.equal(c.talks.length, MAX_TALKS);
  assert.equal(c.talks.at(-1).call, `m${MAX_TALKS + 4}`);
});

test("talks are saved with their answer, and an unanswered one comes back as such", () => {
  const store = newAgentStore();
  send(store, "c", agent("a", { state: "done", endedAt: T0 + S }), 0);
  send(store, "c", agent("a", { round: 1, talk: talk("t1", { reply: "fine" }) }), 1);
  send(store, "c", agent("a", { round: 1, talk: talk("t2") }), 1);
  const turns = [
    { role: "user", content: "q1" }, { role: "assistant", content: "r1" },
    { role: "user", content: "q2" }, { role: "assistant", content: "r2" },
  ];
  const saved = withAgents(store.get("c"), turns);
  assert.equal(saved[1].talks, undefined);
  assert.deepEqual(saved[3].talks.map((x) => [x.call, x.reply]), [["t1", "fine"], ["t2", undefined]]);
  assert.equal("anchor" in saved[3].talks[0], false, "its place is its turn");

  const back = newAgentStore();
  restoreAgents(back, "c", saved);
  const c = back.get("c");
  assert.deepEqual(c.talks.map((x) => [x.call, x.anchor, !!x.stale]), [["t1", 1, false], ["t2", 1, true]]);
  assert.equal(waitingTalk(c), undefined, "no answer will come any more");
  // Nonsense is left out.
  restoreAgents(back, "d", [{ role: "assistant", talks: [{ call: 1 }, null] }]);
  assert.equal(back.get("d").talks.length, 0);
  // An edited question takes the talks of the answers it drops.
  rewindAgents(back, "c", 1);
  assert.equal(c.talks.length, 0);
});

test("what goes to the CLI says which agent, how to pass it on, and what to do when it may not answer", () => {
  const q = { agentId: "a593b8fb9d51326c3", title: "counter", line: "sleep 25", look: "working" };
  const text = agentAsk(q, "Che passo stai facendo?");
  assert.match(text, /^My question below is for your agent "counter" \(agentId: a593b8fb9d51326c3\)\. Send it to that agent with SendMessage \(to: "a593b8fb9d51326c3"\), then tell me its answer\.\n\nChe passo stai facendo\?$/);
  assert.match(agentAsk({ ...q, look: "stalled" }, "?"), /no sign of life for a while.*why it is stuck\./);
  assert.match(agentAsk({ ...q, look: "done" }, "?"), /It had ended: the message takes it up again\./);
  assert.deepEqual(askQuoteOf(q), q);
  assert.equal(askQuoteOf({ agentId: "a" }), undefined);
});

// ── The card ──────────────────────────────────────────────────────────────────

function host(extra = {}) {
  const log = { asked: [] };
  return {
    log,
    host: {
      label: (a) => `${a.kind} ${a.detail}`.trim(),
      stop: () => {},
      send: () => true,
      requestOnTop: null,
      seeRequest: () => {},
      changed: () => {},
      ask: (q) => log.asked.push(q),
      ...extra,
    },
  };
}

test("Ask on a row its CLI can pass a message to; a row whose message waits says it is in conversation", () => {
  const store = newAgentStore();
  send(store, "k", agent("a", { now: { kind: "read", detail: "L03.tex" }, lastSignalAt: T0 + 360 * S }));
  send(store, "k", agent("b", { lastSignalAt: T0 }));
  send(store, "k", agent("c", { canAsk: false, lastSignalAt: T0 + 360 * S }));
  send(store, "k", agent("d", { lastSignalAt: T0 + 360 * S, talk: talk("t1") }));
  const c = store.get("k");
  assert.equal(askable(c.rows.get("a")), true);
  assert.equal(askable(c.rows.get("c")), false);
  const { host: h, log } = host();
  const now = T0 + 361 * S;
  const el = agentsCard({ chatId: "k", chat: c, batch: c.batches[0], now }, h);
  const rows = el.find(".agents-row");
  // No sign of life: Ask first, then Wait and Stop.
  assert.deepEqual(rows[1].querySelector(".agents-side").find(".agents-btn").map((b) => b.textContent), ["Ask", "Wait", "Stop"]);
  rows[1].querySelector(".agents-btn.ask").fire("click");
  assert.deepEqual(log.asked, [{ agentId: "b", title: "Transcribe b", line: "No signal for 6 min", look: "stalled" }]);
  // At work: Ask is in the opened row, before Stop.
  rows[0].querySelector(".agents-row-head").fire("click");
  assert.deepEqual(el.querySelector(".agents-detail").find(".agents-btn").map((b) => b.textContent), ["Ask", "Stop this agent", "Close"]);
  el.querySelector(".agents-detail").querySelector(".agents-btn.ask").fire("click");
  assert.equal(log.asked[1].agentId, "a");
  assert.equal(log.asked[1].line, "read L03.tex");
  // Its CLI cannot pass it a message: no Ask.
  el.find(".agents-row")[2].querySelector(".agents-row-head").fire("click");
  assert.ok(el.find(".agents-row")[2].querySelector(".agents-detail"));
  assert.equal(el.find(".agents-row")[2].querySelector(".agents-btn.ask"), null);
  // A message waits for its answer: the badge.
  assert.deepEqual(el.find(".agents-badge").map((b) => [b.className, b.textContent]), [["agents-badge talk", "in conversation"]]);
  // No host for Ask (a question being edited): no button.
  const { host: none } = host({ ask: undefined });
  const plain = agentsCard({ chatId: "k", chat: c, batch: c.batches[0], now }, none);
  assert.equal(plain.querySelector(".agents-btn.ask"), null);
});

test("the box: Talking to, what the CLI said, then the dots and how long until the answer", () => {
  const x = { call: "t", agentId: "a", title: "counter", anchor: 0, message: "What step are you on?", sentAt: T0 };
  const el = talkBox(x, "Claude Code", T0 + 4 * S);
  assert.equal(el.querySelector(".agents-talk-title").textContent, "Talking to counter");
  assert.deepEqual(el.find(".agents-talk-who").map((w) => w.textContent), ["Claude Code", "counter"]);
  assert.equal(el.find(".agents-talk-text")[0].textContent, "What step are you on?");
  assert.ok(el.querySelector(".typing"), "the dots while it waits");
  assert.match(el.find(".agents-talk-msg")[1].textContent, /waiting for the reply… 4 s/);
  const dots = el.querySelector(".typing");
  fillTalkBox(el, x, "Claude Code", T0 + 9 * S);
  assert.equal(el.querySelector(".typing"), dots, "only the words change as each second goes");
  assert.match(el.find(".agents-talk-msg")[1].textContent, /9 s/);
  fillTalkBox(el, { ...x, reply: "Step 2 of 3", repliedAt: T0 + 12 * S }, "Claude Code", T0 + 20 * S);
  assert.equal(el.querySelector(".typing"), null);
  assert.equal(el.find(".agents-talk-text")[1].textContent, "Step 2 of 3");
  assert.equal(el.querySelector(".agents-time").textContent, "12 s");
  const failed = talkBox({ ...x, failed: "Claude Code ended" }, "Claude Code", T0);
  assert.equal(failed.querySelector(".agents-talk-text.failed").textContent, "The message did not reach counter");
  assert.equal(talkBox({ ...x, stale: true }, "Claude Code", T0).querySelector(".agents-talk-text.dim").textContent, "No reply came");
});

// ── The chat ──────────────────────────────────────────────────────────────────

let answers;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (answers && cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : answers[cmd];
  return result;
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let view;
beforeEach(() => {
  mem.clear();
  answers = {};
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {}, chatProvider: "claude-code" };
  State.chatHistory = [];
  State.chatSession = null;
  State.stateOverride = null;
  State.view = "prompt";
  State.droppedFile = null;
  State.pendingApproval = null;
  State.approvalQueue = [];
  State.startChat();
  view = buildPrompt(() => {});
  view.sync();
});

const $ = (cls) => view.el.querySelector(cls);
const now = Date.now();
const live = (id, extra = {}) => agent(id, { startedAt: now, lastSignalAt: now, ...extra });

async function ask(text) {
  let finish;
  answers.chat_send = () => new Promise((resolve) => (finish = resolve));
  $(".chat-input").value = text;
  $(".send-btn").fire("click");
  await flush();
  view.sync();
  return async (reply) => {
    finish(reply);
    await flush();
    view.sync();
  };
}

test("Ask puts the agent over the field; the question goes with it, keeps it, and × takes it away", async () => {
  const answer = await ask("transcribe the lessons");
  const chat = State.chatId;
  emit("chat-agent", { chat, agent: live("a1", { now: { kind: "read", detail: "pag-3.png" } }) });
  await answer({ text: "Launched.", turns: 2 });
  assert.equal($(".chat-ask").hidden, true);

  // Ask, from the opened row.
  $(".agents-row-head").fire("click");
  $(".agents-detail").querySelector(".agents-btn.ask").fire("click");
  view.sync();
  assert.equal($(".chat-ask").hidden, false);
  assert.equal($(".ask-who").textContent, "Asking Transcribe a1");
  assert.equal($(".chat-ask").dataset.look, "working");
  assert.equal($(".chat-input").placeholder, "Ask Transcribe a1…");
  // × takes it away, and Ask again puts it back.
  $(".ask-close").fire("click");
  view.sync();
  assert.equal($(".chat-ask").hidden, true);
  $(".agents-detail").querySelector(".agents-btn.ask").fire("click");
  view.sync();

  const next = await ask("che passo stai facendo?");
  const query = sent("chat_send").at(-1).query;
  assert.match(query, /^My question below is for your agent "Transcribe a1" \(agentId: a1\)\. Send it to that agent with SendMessage/);
  assert.match(query, /\n\nche passo stai facendo\?$/);
  // On screen, the question as typed, the agent quoted on top; the field is free again.
  const question = State.chatHistory.find((m) => m.role === "user" && m.ask);
  assert.equal(question.content, "che passo stai facendo?");
  assert.equal($(".chat-ask").hidden, true);
  const quote = $(".chat-log").find(".bubble-quote").at(-1);
  assert.equal(quote.find("b")[0].textContent, "Asking Transcribe a1");
  assert.equal(quote.find("span")[0].textContent, "Reading pag-3.png");

  // Claude Code passes it on: "Talking to …" before the answer, until its answer comes.
  emit("chat-agent", { chat, agent: live("a1", { talk: { call: "s1", message: "What step are you on? Reply to main.", sentAt: now } }) });
  view.sync();
  const box = $(".agents-talk");
  assert.equal(box.querySelector(".agents-talk-title").textContent, "Talking to Transcribe a1");
  assert.ok(box.querySelector(".typing"));
  emit("chat-agent", { chat, agent: live("a1", { talk: { call: "s1", message: "What step are you on? Reply to main.", sentAt: now, reply: "Page 3 of 21", repliedAt: now + 3000 } }) });
  view.sync();
  assert.equal($(".agents-talk").find(".agents-talk-text")[1].textContent, "Page 3 of 21");
  await next({ text: "It is on page 3 of 21.", turns: 4 });
  const log = $(".chat-log").children;
  const at = log.findIndex((r) => r.classList.contains("agents-talk"));
  assert.ok(log[at - 1].classList.contains("user") && log[at + 1].querySelector(".reply"), "between the question and its answer");

  // Saved: the quote with the question, the talk with its answer; they come back.
  const saved = loadChats().find((c) => c.id === chat);
  assert.deepEqual(saved.turns[2].ask, { agentId: "a1", title: "Transcribe a1", line: "Reading pag-3.png", look: "working" });
  assert.equal(saved.turns[2].content, "che passo stai facendo?");
  assert.equal(saved.turns[3].talks[0].reply, "Page 3 of 21");
});

test("a slash command is never quoted, and a quoted question never joins what waits in the queue", async () => {
  const answer = await ask("go");
  const chat = State.chatId;
  emit("chat-agent", { chat, agent: live("a1") });
  await answer({ text: "Launched.", turns: 2 });
  $(".agents-row-head").fire("click");
  $(".agents-detail").querySelector(".agents-btn.ask").fire("click");
  view.sync();
  await ask("/compact");
  assert.equal(sent("chat_send").at(-1).query.startsWith("/compact"), true, "the command goes as it is");
  assert.equal(State.chatHistory.find((m) => m.content === "/compact").ask, undefined);
  assert.equal($(".chat-ask").hidden, false, "the quote waits for a question");

  // While an answer is written: the quoted question waits above the field, with its agent.
  const input = $(".chat-input");
  input.value = "a che punto sei?";
  type("Enter");
  await flush();
  view.sync();
  assert.equal($(".queue-text").textContent, "Asking Transcribe a1 · a che punto sei?");
  assert.equal($(".chat-ask").hidden, true, "the quote went with it");
  // Something else typed does not join it: it stays in the field.
  input.value = "e poi?";
  type("Enter");
  await flush();
  assert.equal(input.value, "e poi?");
  assert.equal($(".queue-text").textContent, "Asking Transcribe a1 · a che punto sei?");
});

function type(key) {
  const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
  for (const fn of $(".chat-input").listeners.get("keydown")) fn(event);
  return event;
}
