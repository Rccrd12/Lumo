// What the chat's provider has left (src/core/chat-usage.ts, and its line in
// src/views/chat.ts): Claude Code's plan from the relay, the rate limits
// Anthropic and OpenAI answer with, OpenRouter's key credits, nothing for the
// others, and nothing at all while the option is off.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, emit, internals, sent } from "./tauri.mjs";

installFakeDom();
const { compact, dollars, usageLine } = await import("../src/core/chat-usage.ts");
const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const on = (extra = {}) => ({ ...DEFAULT_SETTINGS, chatModels: {}, chatShowUsage: true, ...extra });
const plan = {
  fiveHour: { usedPct: 38, resetsAt: NOW + 80 * 60_000 },
  sevenDay: { usedPct: 20, resetsAt: NOW + 3 * 86_400_000 },
  updatedAt: NOW - 30_000,
};

// ── The line ──────────────────────────────────────────────────────────────────

test("the option is off by default, and off shows nothing for any provider", () => {
  assert.equal(DEFAULT_SETTINGS.chatShowUsage, false);
  const s = { ...DEFAULT_SETTINGS, planRelayInstalled: true };
  for (const chatProvider of ["claude-code", "anthropic", "openai", "openrouter"]) {
    const seen = { provider: chatProvider, tokens: { remaining: 1, limit: 2 }, credits: { used: 1 }, at: NOW };
    assert.equal(usageLine({ ...s, chatProvider }, plan, seen, NOW), null, chatProvider);
  }
});

test("Claude Code: what is left of the plan, with the resets, in the plan's colours", () => {
  const line = usageLine(on({ chatProvider: "claude-code", planRelayInstalled: true }), plan, undefined, NOW);
  assert.ok(line.text.startsWith("5 hours: 62% left (in 1 h 20) · Week: 80% left ("), line.text);
  assert.equal(line.color, "#22C55E");
  assert.equal(line.setup, undefined);
  assert.equal(line.title, "Claude plan · just now");
  // Over the orange line: the dot says so. A window past its reset is full again.
  const busy = { ...plan, fiveHour: { usedPct: 85, resetsAt: NOW + 60_000 }, sevenDay: { usedPct: 50, resetsAt: NOW - 1 } };
  const l2 = usageLine(on({ chatProvider: "claude-code", planRelayInstalled: true }), busy, undefined, NOW);
  assert.match(l2.text, /^5 hours: 15% left \(in 1 min\) · Week: 100% left \(Resetting…\)$/);
  assert.equal(l2.color, "#F4505E");
});

test("Claude Code without the relay points to Settings rather than showing numbers", () => {
  const line = usageLine(on({ chatProvider: "claude-code", planRelayInstalled: false }), plan, undefined, NOW);
  assert.equal(line.text, "Plan usage: install the relay in Settings → Agents → Plan usage");
  assert.equal(line.setup, true);
  assert.equal(line.color, null);
  // Relay in, no numbers yet: it says it is waiting.
  const waiting = usageLine(on({ chatProvider: "claude-code", planRelayInstalled: true }), null, undefined, NOW);
  assert.equal(waiting.text, "Waiting for a response from Claude Code");
});

test("Anthropic and OpenAI: the rate limits of the last answer", () => {
  const seen = {
    provider: "anthropic",
    tokens: { remaining: 27_500, limit: 30_000, resetsAt: NOW + 20_000 },
    requests: { remaining: 49, limit: 50, resetsAt: NOW + 1_000 },
    at: NOW - 5_000,
  };
  const line = usageLine(on(), seen, seen, NOW);
  assert.equal(line.text, "Tokens left: 27.5K / 30K · Requests left: 49 / 50");
  assert.equal(line.color, "#22C55E");
  assert.match(line.title, /^Tokens left: 27\.5K \/ 30K — Resets at .+\nRequests left: 49 \/ 50 — Resets at .+\njust now$/);
  const low = { provider: "openai", tokens: { remaining: 1_000, limit: 10_000 }, at: NOW };
  const l2 = usageLine(on({ chatProvider: "openai" }), null, low, NOW);
  assert.equal(l2.text, "Tokens left: 1K / 10K");
  assert.equal(l2.color, "#F4505E");
  const noLimit = { provider: "openai", requests: { remaining: 12 }, at: NOW };
  const l3 = usageLine(on({ chatProvider: "openai" }), null, noLimit, NOW);
  assert.equal(l3.text, "Requests left: 12");
  assert.equal(l3.color, null);
  // Nothing back yet, or numbers that belong to another provider: no line.
  assert.equal(usageLine(on(), null, undefined, NOW), null);
  assert.equal(usageLine(on({ chatProvider: "openai" }), null, seen, NOW), null);
});

test("OpenRouter: the key's credits, or what was spent when the key has no cap", () => {
  const s = on({ chatProvider: "openrouter" });
  const capped = { provider: "openrouter", credits: { remaining: 8.5, limit: 10, used: 1.5 }, at: NOW };
  assert.equal(usageLine(s, null, capped, NOW).text, "Credits left: $8.50 / $10.00");
  assert.equal(usageLine(s, null, capped, NOW).color, "#22C55E");
  const open = { provider: "openrouter", credits: { remaining: null, limit: null, used: 4.2 }, at: NOW };
  assert.equal(usageLine(s, null, open, NOW).text, "Credits used: $4.20");
  assert.equal(usageLine(s, null, { provider: "openrouter", at: NOW }, NOW), null);
});

test("Google, the model servers and the custom one show nothing", () => {
  for (const chatProvider of ["google", "ollama", "lmstudio", "custom"]) {
    const seen = { provider: chatProvider, tokens: { remaining: 5, limit: 10 }, at: NOW };
    assert.equal(usageLine(on({ chatProvider }), plan, seen, NOW), null, chatProvider);
  }
});

test("numbers read short in the interface language", () => {
  assert.equal(compact(27_500), "27.5K");
  assert.equal(compact(2_000_000), "2M");
  assert.equal(compact(49), "49");
  assert.equal(dollars(8.5), "$8.50");
});

// ── In the chat view ──────────────────────────────────────────────────────────

let answers;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : answers[cmd];
  return result;
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let view;
let settingsOpened;
beforeEach(() => {
  calls.length = 0;
  answers = {};
  settingsOpened = 0;
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {} };
  State.chatHistory = [];
  State.stateOverride = null;
  State.planUsage = null;
  State.view = "prompt";
  State.mode = "expanded";
  State.paused = false;
  view = buildPrompt(() => {}, () => settingsOpened++);
  view.sync();
});

const line = () => view.el.querySelector(".chat-usage");

test("off: the line is not there, whatever comes back", () => {
  assert.equal(line().style.display, "none");
  emit("chat-usage", { provider: "anthropic", tokens: { remaining: 10, limit: 20 } });
  view.sync();
  assert.equal(line().style.display, "none");
  assert.deepEqual(sent("chat_usage"), [], "nothing is asked");
});

test("on: Anthropic's numbers show next to the model button once an answer brings them", () => {
  State.settings = { ...State.settings, chatShowUsage: true };
  view.sync();
  assert.equal(line().style.display, "none", "nothing known yet");
  emit("chat-usage", { provider: "anthropic", tokens: { remaining: 27_500, limit: 30_000 } });
  view.sync();
  assert.equal(line().style.display, "");
  assert.equal(line().textContent, "Tokens left: 27.5K / 30K");
  // Another provider's numbers are not shown for this one.
  State.settings = { ...State.settings, chatProvider: "google" };
  view.sync();
  assert.equal(line().style.display, "none");
  assert.deepEqual(sent("chat_usage"), [], "Anthropic and OpenAI need no call");
});

test("Claude Code without the relay: the hint opens Settings", () => {
  State.settings = { ...State.settings, chatShowUsage: true, chatProvider: "claude-code" };
  view.sync();
  assert.match(line().textContent, /install the relay/);
  line().fire("click");
  assert.equal(settingsOpened, 1);
  State.settings = { ...State.settings, planRelayInstalled: true };
  State.planUsage = plan;
  view.sync();
  assert.match(line().textContent, /^5 hours: \d+% left/);
  line().fire("click");
  assert.equal(settingsOpened, 1, "numbers are not a link");
});

test("OpenRouter is asked when the chat opens on it and after an answer, not on every sync", async () => {
  answers.chat_usage = { provider: "openrouter", credits: { remaining: 8.5, limit: 10, used: 1.5 } };
  State.settings = { ...State.settings, chatProvider: "openrouter" };
  view.sync();
  assert.deepEqual(sent("chat_usage"), [], "the option is off");
  State.settings = { ...State.settings, chatShowUsage: true };
  view.sync();
  await flush();
  view.sync();
  assert.equal(sent("chat_usage").length, 1);
  assert.equal(line().textContent, "Credits left: $8.50 / $10.00");
  view.sync();
  view.sync();
  assert.equal(sent("chat_usage").length, 1, "once per opening");
  // Closed and opened again within a minute: the numbers are still fresh.
  State.mode = "hidden";
  view.sync();
  State.mode = "expanded";
  view.sync();
  await flush();
  assert.equal(sent("chat_usage").length, 1);
  // Away to another view (the chat does not sync there) and back after a minute: asked again.
  State.view = "overview";
  State.notify();
  State.view = "prompt";
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    view.sync();
  } finally {
    Date.now = realNow;
  }
  await flush();
  assert.equal(sent("chat_usage").length, 2);
  // An answer asks again.
  answers.chat_send = { text: "Hi" };
  const input = view.el.querySelector(".chat-input");
  input.value = "hello";
  view.el.querySelector(".send-btn").fire("click");
  await flush();
  await flush();
  assert.equal(sent("chat_usage").length, 3);
});
