// The chat view with the agents its CLI starts (src/views/chat.ts, concept:
// concepts/sotto-agenti): the card goes under the answer that started them, an
// answer the CLI writes by itself while they work folds under it, they are
// saved with the chat, the closed island keeps saying they work, and the
// typing line says when an answer gives no sign or waits for the user.

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
const { loadChats } = await import("../src/core/chats.ts");
const { islandAgents } = await import("../src/core/chat-agents.ts");
const { activityLine } = await import("../src/core/compact.ts");

let answers;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : answers[cmd];
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
const agent = (id, extra = {}) => ({
  id, source: "claude-code", title: `Transcribe ${id}`, state: "working", steps: 0,
  startedAt: now, lastSignalAt: now, background: true, canStop: true, ...extra,
});

/** Asks `text`; the answer waits until the returned function gives it. */
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

/** The log's rows, by what they are. */
function rows() {
  return $(".chat-log").children.map((r) => r.classList.contains("agents") ? "agents"
    : r.classList.contains("user") ? "question"
    : r.querySelector(".typing") ? "dots"
    : r.querySelector(".reply") ? "answer" : r.className);
}

test("the agents' card goes under the answer that started them, and stays there once it is written", async () => {
  const answer = await ask("transcribe the lessons");
  const chat = State.chatId;
  emit("chat-delta", { chat, text: "I launched 2 agents." });
  emit("chat-agent", { chat, agent: agent("a1") });
  emit("chat-agent", { chat, agent: agent("a2") });
  view.sync();
  assert.deepEqual(rows(), ["question", "answer", "agents"]);
  assert.equal($(".agents-status").textContent, "0 of 2 done");

  // Only the card is drawn again when an agent changes.
  const card = $(".agents");
  emit("chat-agent", { chat, agent: agent("a1", { state: "done", summary: "L01 ready", endedAt: now + 1000 }) });
  assert.equal($(".agents"), card);
  assert.equal($(".agents-status").textContent, "1 of 2 done");

  await answer({ text: "I launched 2 agents.", turns: 2 });
  assert.deepEqual(rows(), ["question", "answer", "agents"]);
  assert.equal($(".agents-live-text").textContent.startsWith("1 agent working"), true);
  // The agent that ended is saved with its answer.
  const saved = loadChats().find((c) => c.id === chat);
  assert.deepEqual(saved.turns[1].agents.map((a) => [a.id, a.state, a.summary]), [["a1", "done", "L01 ready"]]);

  // Its answer is done, its agents still work: the closed island and the home say so.
  assert.equal(State.chatActivity?.label, "1 agent working · 1/2");
  assert.deepEqual(State.activeChats.map((c) => [c.chatId, c.line]), [[chat, "1 agent working · 1/2"]]);
  // The closed island draws a segment each after the words.
  assert.deepEqual(islandAgents(), { looks: ["done", "working"], done: 1, total: 2, stalled: false });
  const island = activityLine({ ...State.chatActivity, agents: islandAgents() }, null, null);
  assert.equal(island.text, "Claude Code · 1 agent working · 1/2");
  assert.deepEqual(island.agents.looks, ["done", "working"]);

  // Stop this one agent: Rust is asked, by chat and agent.
  $(".chat-log").find(".agents-row-head")[1].fire("click");
  $(".agents-detail").querySelector(".agents-btn.stop").fire("click");
  assert.deepEqual(sent("chat_stop_agent"), [{ chatId: chat, agentId: "a2" }]);
});

test("what the CLI writes by itself while agents work folds under them; once they are done it joins the answer", async () => {
  const answer = await ask("go");
  const chat = State.chatId;
  emit("chat-agent", { chat, agent: agent("b1") });
  await answer({ text: "Launched.", turns: 2 });
  assert.deepEqual(rows(), ["question", "answer", "agents"]);

  emit("chat-own-answer", { chat, text: "L15 is ready, 7 to go.", session: null });
  await flush();
  assert.equal(State.chatHistory.at(-1).content, "Launched.");
  assert.equal(State.chatHistory.at(-1).kept, "Launched.\n\nL15 is ready, 7 to go.", "Rust's conversation has it all the same");
  assert.equal($(".agents-updates-text").textContent, "1 update from Claude Code · latest: «L15 is ready, 7 to go.»");
  assert.deepEqual(loadChats().find((c) => c.id === chat).turns[1].updates, ["L15 is ready, 7 to go."]);

  emit("chat-agent", { chat, agent: agent("b1", { state: "done", endedAt: now + 5000 }) });
  emit("chat-own-answer", { chat, text: "All done.", session: null });
  await flush();
  view.sync();
  assert.equal(State.chatHistory.at(-1).content, "Launched.\n\nAll done.");
  assert.equal(State.chatActivity, null, "nothing at work any more");
  assert.equal(islandAgents(), null);
  assert.equal($(".agents-folded").querySelector(".agents-title").textContent, "1 agent finished");
});

test("the typing line says when the answer gives no sign, or waits for the user", async (t) => {
  State.settings = { ...State.settings, chatProvider: "anthropic" };
  view.sync();
  const answer = await ask("hello");
  const chat = State.chatId;
  assert.equal($(".typing-stall"), null);
  const real = Date.now;
  t.after(() => (Date.now = real));
  Date.now = () => real() + 3 * 60_000;
  emit("chat-signal", { chat, at: now - 1 });
  assert.equal($(".typing-stall").textContent, " · no signal for 3 min");
  assert.ok($(".typing-stall").classList.contains("stalled"));
  assert.equal($(".typing-label").textContent, "Thinking…", "the dots' words stay as they are");

  emit("chat-signal", { chat, at: Date.now(), waiting: "permission" });
  assert.equal($(".typing-stall").textContent, " · waiting for your permission");
  emit("chat-signal", { chat, at: Date.now(), waiting: null });
  assert.equal($(".typing-stall"), null, "a sign just came");
  Date.now = real;
  await answer({ text: "Hi!", turns: 2 });
});
