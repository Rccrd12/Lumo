// The computer, one agent at a time (src-tauri/src/computer_turns.rs keeps the
// line; src/core/chat-agents.ts and src/views/agents-card.ts show it): the
// agent that has it says "uses the computer", the others wait in line with
// their place and since when, never "no signal", and "Give it the turn" puts
// one first.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { AGENT_STALL_S, applyAgent, applyComputerTurns, computerBusy, computerOf, lookOf, newAgentStore } = await import("../src/core/chat-agents.ts");
const { agentsCard } = await import("../src/views/agents-card.ts");

const T0 = 1_700_000_000_000;
const S = 1000;

function agent(id, extra = {}) {
  return {
    id, source: "claude-code", title: `Transcribe ${id}`, state: "working", steps: 0,
    startedAt: T0, lastSignalAt: T0, background: true, canStop: true, ...extra,
  };
}

const send = (store, chat, a) => applyAgent(store, { chat, agent: a }, 0);

function host(extra = {}) {
  const log = { first: [] };
  return {
    log,
    host: {
      label: (a) => `${a.kind} ${a.detail}`.trim(),
      stop: () => {},
      send: () => true,
      requestOnTop: null,
      seeRequest: () => {},
      changed: () => {},
      computerFirst: (id) => log.first.push(id),
      ...extra,
    },
  };
}

test("the line as Rust sends it: who holds the computer, who waits where; a repeat changes nothing", () => {
  const line = {
    holder: { chat: "c", agent: "a1", sinceMs: T0 },
    waiting: [{ chat: "c", agent: "a2", sinceMs: T0 + 2 * S, place: 1 }, { chat: "d", agent: "b1", sinceMs: T0 + 5 * S, place: 2 }],
  };
  assert.equal(applyComputerTurns(line), true);
  assert.equal(applyComputerTurns(structuredClone(line)), false);
  assert.deepEqual(computerOf("a1"), { holds: true });
  assert.deepEqual(computerOf("b1"), { waits: true, place: 2, of: 2, since: T0 + 5 * S }, "places count the whole line, every chat");
  assert.equal(computerOf("zz"), null);
  assert.equal(computerBusy(), true);
  // Nonsense is left out.
  assert.equal(applyComputerTurns({ holder: { chat: 1 }, waiting: [null, { place: 1 }] }), true);
  assert.equal(computerBusy(), false);
  applyComputerTurns(null);
});

test("an agent in line for the computer waits, and is never said to give no signal", () => {
  const store = newAgentStore();
  send(store, "c", agent("a2"));
  const e = store.get("c").rows.get("a2");
  const late = T0 + (AGENT_STALL_S + 60) * S;
  assert.equal(lookOf(e, late), "stalled");
  applyComputerTurns({ holder: { chat: "c", agent: "a1", sinceMs: T0 }, waiting: [{ chat: "c", agent: "a2", sinceMs: T0, place: 1 }] });
  assert.equal(lookOf(e, late), "waiting");
  applyComputerTurns({ holder: null, waiting: [] });
});

test("the card: the badge on the one that has it, the place and the wait on the others, Give it the turn behind the first", () => {
  const store = newAgentStore();
  for (const id of ["a1", "a2", "a3"]) send(store, "k", agent(id, { lastSignalAt: T0 + 30 * S }));
  const c = store.get("k");
  applyComputerTurns({
    holder: { chat: "k", agent: "a1", sinceMs: T0 },
    waiting: [{ chat: "k", agent: "a2", sinceMs: T0 + 10 * S, place: 1 }, { chat: "k", agent: "a3", sinceMs: T0 + 18 * S, place: 2 }],
  });
  const { host: h, log } = host();
  const el = agentsCard({ chatId: "k", chat: c, batch: c.batches[0], now: T0 + 30 * S }, h);
  const rows = el.find(".agents-row");
  assert.deepEqual(rows[0].find(".agents-badge").map((b) => [b.className, b.textContent]), [["agents-badge computer", "uses the computer"]]);
  assert.ok(rows[1].className.includes("waiting"));
  assert.equal(rows[1].querySelector(".agents-line").textContent, "Waiting for the computer · 1 of 2 · 20 s");
  assert.equal(rows[1].querySelector(".agents-btn.first"), null, "first in line already");
  assert.equal(rows[2].querySelector(".agents-line").textContent, "Waiting for the computer · 2 of 2 · 12 s");
  rows[2].querySelector(".agents-btn.first").fire("click");
  assert.deepEqual(log.first, ["a3"]);
  assert.equal(el.querySelector(".agents-segs").children.map((i) => i.className).join(" "), "working waiting waiting");
  // Without the host's action (nowhere to send it): no button.
  const { host: none } = host({ computerFirst: undefined });
  assert.equal(agentsCard({ chatId: "k", chat: c, batch: c.batches[0], now: T0 + 30 * S }, none).querySelector(".agents-btn.first"), null);
  // Nobody in line: the rows are as they always were.
  applyComputerTurns({ holder: null, waiting: [] });
  const plain = agentsCard({ chatId: "k", chat: c, batch: c.batches[0], now: T0 + 30 * S }, h);
  assert.equal(plain.querySelector(".agents-badge"), null);
  assert.deepEqual(plain.find(".agents-line").map((l) => l.textContent), ["Working…", "Working…", "Working…"]);
});

test("in the chat: the line comes as an event, and Give it the turn asks Rust", async () => {
  const { emit, internals, sent } = await import("./tauri.mjs");
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const { buildPrompt } = await import("../src/views/chat.ts");
  const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {}, chatProvider: "claude-code" };
  State.view = "prompt";
  State.startChat();
  const view = buildPrompt(() => {});
  view.sync();
  let finish;
  const plain = internals.invoke;
  internals.invoke = async (cmd, args) => (cmd === "chat_send" ? new Promise((r) => (finish = r)) : plain(cmd, args));
  view.el.querySelector(".chat-input").value = "go";
  view.el.querySelector(".send-btn").fire("click");
  await new Promise((r) => setTimeout(r, 0));
  const chat = State.chatId;
  const now = Date.now();
  for (const id of ["x1", "x2", "x3"]) emit("chat-agent", { chat, agent: agent(id, { startedAt: now, lastSignalAt: now }) });
  finish({ text: "Launched.", turns: 2 });
  await new Promise((r) => setTimeout(r, 0));
  view.sync();
  emit("computer-turns", {
    holder: { chat, agent: "x1", sinceMs: now },
    waiting: [{ chat, agent: "x2", sinceMs: now, place: 1 }, { chat, agent: "x3", sinceMs: now, place: 2 }],
  });
  const $ = (cls) => view.el.querySelector(cls);
  assert.equal($(".agents-badge.computer").textContent, "uses the computer");
  $(".agents-btn.first").fire("click");
  assert.deepEqual(sent("chat_computer_first"), [{ chatId: chat, agentId: "x3" }]);
  emit("computer-turns", { holder: null, waiting: [] });
  assert.equal($(".agents-badge.computer"), null);
  internals.invoke = plain;
});
