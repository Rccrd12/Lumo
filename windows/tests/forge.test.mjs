// The Tools tab (views/tools.ts) and the tool workshop (views/chat.ts in its
// workshop mode, views/forge.ts) on a fake DOM, through the real bridge: the
// workshop is a chat of its own, the AI's draft shows beside it, and nothing
// is tried or saved without a click.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, emit, internals, sent } from "./tauri.mjs";

installFakeDom();
const mem = new Map();
globalThis.localStorage ??= {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const { buildPrompt } = await import("../src/views/chat.ts");
const { buildTools } = await import("../src/views/tools.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { isWorkshopChat } = await import("../src/core/tools.ts");

let answers;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : answers[cmd];
  return result;
};
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const FENCE = "```";

const TOOL = {
  id: "bench", name: "Bench", description: "Measures the PC.", entry: "bench.py", args: [], params: [],
  permissions: ["read"], enabled: true, timeout: 0, created: 1, updated: 1, dir: "C:\\t\\bench", files: ["bench.py"], missing: false,
};

let chat;
let tools;
let shown;
const actions = {
  blip() {},
  setView(v) {
    shown = v;
    State.view = v;
  },
};

beforeEach(() => {
  calls.length = 0;
  answers = { tools_list: [] };
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {} };
  State.useSlot("chat");
  State.chatHistory = [];
  State.view = "prompt";
  State.mode = "expanded";
  State.tools = [];
  shown = null;
  chat = buildPrompt(() => {}, undefined, undefined, undefined, undefined, () => actions.setView("tools"));
  tools = buildTools(actions);
  chat.sync();
});

const inChat = (cls) => chat.el.querySelector(cls);
const button = (root, text) => root.find("BUTTON").find((b) => b.textContent === text);

test("the Tools tab lists the tools with their switch, and Add a tool opens the workshop", async () => {
  State.tools = [TOOL, { ...TOOL, id: "off_one", name: "Old", enabled: false }];
  tools.sync();
  const rows = tools.el.find(".tool-row");
  assert.equal(rows.length, 2);
  assert.ok(rows[1].classList.contains("off"));
  assert.match(tools.el.querySelector(".tools-count").textContent, /1 on of 2/);

  answers.tools_set_enabled = null;
  rows[0].find(".switch")[0].fire("click", { stopPropagation() {} });
  await flush();
  assert.deepEqual(sent("tools_set_enabled"), [{ id: "bench", enabled: false }]);
  assert.equal(State.tools[0].enabled, false, "shown at once");

  tools.el.querySelector(".tools-add").fire("click");
  assert.equal(shown, "prompt");
  assert.equal(State.chatSlot, "forge");
  chat.sync();
  assert.ok(chat.el.querySelector(".chat-card").classList.contains("forge"));
  assert.ok(isWorkshopChat(State.chatId));
  const card = chat.el.querySelector(".chat-card");
  assert.ok(card.classList.contains("guiding"), "how it works over the workshop at first");
  assert.ok(!card.classList.contains("forge-draft"), "no tool beside the conversation yet");
  chat.el.querySelector(".forge-guide-hide").fire("click");
  assert.ok(!card.classList.contains("guiding"), "the dash puts it away");
  chat.el.querySelector(".forge-help").fire("click");
  assert.ok(card.classList.contains("guiding"), "the ? brings it back");
});

test("Delete asks a second click", async () => {
  State.view = "tools";
  State.tools = [TOOL];
  tools.sync();
  tools.el.querySelector(".tool-row-head").fire("click");
  tools.sync();
  const del = () => tools.el.find(".tools-act").find((b) => b.classList.contains("danger"));
  del().fire("click", { stopPropagation() {} });
  tools.sync();
  assert.equal(sent("tools_delete").length, 0);
  assert.ok(del().classList.contains("confirm"));
  del().fire("click", { stopPropagation() {} });
  await flush();
  assert.deepEqual(sent("tools_delete"), [{ id: "bench" }]);
  assert.equal(State.tools.length, 0);
});

test("the supervisor's words, Always ask or Trust, and a dangerous tool turned on with a second click", async () => {
  State.view = "tools";
  const review = { fingerprint: "f", verdict: "ok", summary: "Times your CPU and prints a score.", points: ["Takes 30 s"], undeclared: [], model: "claude-opus-5-5", at: 1 };
  State.tools = [{ ...TOOL, reviewed: true, review, mayTrust: true, unguarded: [], trust: false }];
  tools.sync();
  assert.match(tools.el.querySelector(".review-badge").className, /\bok\b/);
  tools.el.querySelector(".tool-row-head").fire("click");
  tools.sync();
  assert.equal(tools.el.querySelector(".supervisor-summary").textContent, review.summary);
  assert.equal(tools.el.querySelector(".supervisor-points").find("LI")[0].textContent, "Takes 30 s");

  answers.tools_set_trust = null;
  const opts = () => tools.el.find(".trust-opt");
  assert.ok(opts()[0].classList.contains("on"), "asks every time until the user says otherwise");
  opts()[1].fire("click", { stopPropagation() {} });
  await flush();
  assert.deepEqual(sent("tools_set_trust"), [{ id: "bench", trust: true }]);

  // A script Lumo can't hold to what it declared: no Trust to pick.
  State.tools = [{ ...TOOL, reviewed: true, review, mayTrust: false, unguarded: ["network", "write"] }];
  tools.sync();
  assert.ok(opts()[1].getAttribute("disabled") != null);

  answers.tools_review = null;
  button(tools.el, "Review again").fire("click", { stopPropagation() {} });
  await flush();
  assert.deepEqual(sent("tools_review"), [{ id: "bench" }]);
  tools.sync();
  assert.match(tools.el.querySelector(".review-badge").className, /reviewing/);
  emit("tool-review", { id: "bench", state: "failed", error: "No API key" });
  tools.sync();
  assert.match(tools.el.querySelector(".supervisor").textContent, /No API key/);

  // Found dangerous (and so turned off): on again only with a second click.
  answers.tools_set_enabled = null;
  State.tools = [{ ...TOOL, enabled: false, reviewed: true, review: { ...review, verdict: "danger" } }];
  tools.sync();
  const sw = () => tools.el.querySelector(".switch");
  sw().fire("click", { stopPropagation() {} });
  await flush();
  assert.equal(sent("tools_set_enabled").length, 0);
  tools.sync();
  assert.match(tools.el.querySelector(".tool-desc").textContent, /Turn on anyway/);
  sw().fire("click", { stopPropagation() {} });
  await flush();
  assert.deepEqual(sent("tools_set_enabled"), [{ id: "bench", enabled: true }]);
});

test("Claude Code in the terminal gets the tools on a second click", async () => {
  answers.tools_terminal_has = false;
  answers.tools_terminal_set = true;
  State.view = "tools";
  State.notify();
  await flush();
  tools.sync();
  const term = () => tools.el.querySelector(".tools-term");
  term().fire("click");
  tools.sync();
  assert.equal(sent("tools_terminal_set").length, 0);
  assert.match(term().textContent, /Add to Claude Code/);
  term().fire("click");
  await flush();
  assert.deepEqual(sent("tools_terminal_set"), [{ on: true }]);
  tools.sync();
  assert.ok(term().classList.contains("open"));
});

test("the workshop is a chat of its own: the AI's draft shows beside it, Try and Save only on a click", async () => {
  State.chatHistory.push({ id: 900, role: "user", content: "the chat's own question" });
  const chatId = State.chatId;
  State.useSlot("forge");
  chat.sync();
  const forgeId = State.chatId;
  assert.notEqual(forgeId, chatId);
  assert.equal(chat.el.find(".bubble").length, 0, "the chat's messages stay in the chat");

  answers.chat_send = {
    text: [
      "Here it is.",
      `${FENCE}lumo-tool`,
      JSON.stringify({ name: "Bench", description: "Measures the PC.", entry: "bench.py", params: [{ name: "quick", type: "boolean" }], permissions: ["read"] }),
      FENCE,
      `${FENCE}lumo-file bench.py`,
      "print(42)",
      FENCE,
    ].join("\n"),
    turns: 2,
  };
  inChat(".chat-input").value = "make a benchmark";
  inChat(".send-btn").fire("click");
  await flush();
  await flush();
  chat.sync();
  assert.deepEqual(sent("chat_send").map((a) => a.chatId), [forgeId]);
  assert.equal(chat.el.find(".reply")[0].textContent.includes("lumo-tool"), false, "the blocks are not shown as code");
  assert.ok(chat.el.querySelector(".forge-chip"), "a line names the draft");
  assert.equal(chat.el.querySelector(".forge-tool-name").textContent, "Bench");
  assert.equal(chat.el.querySelector(".forge-status").textContent, "Draft");
  assert.equal(sent("tools_try").length + sent("tools_save").length, 0, "nothing runs or saves by itself");

  answers.tools_try = { ok: true, output: "42", ms: 120 };
  button(chat.el, "Try").fire("click");
  await flush();
  chat.sync();
  assert.equal(sent("tools_try")[0].draft.entry, "bench.py");
  assert.deepEqual(sent("tools_try")[0].input, {});
  assert.match(chat.el.querySelector(".forge-result").textContent, /It works/);
  button(chat.el, "Tell Lumo").fire("click");
  assert.match(inChat(".chat-input").value, /worked[\s\S]*42/);

  answers.tools_save = { ...TOOL };
  button(chat.el, "Save tool").fire("click");
  await flush();
  chat.sync();
  assert.equal(sent("tools_save").length, 1);
  assert.equal(sent("tools_save")[0].draft.replaces, null, "a new tool");
  assert.equal(chat.el.querySelector(".forge-status").textContent, "Saved");

  // Back to the chat: its question is there again, and the workshop waits.
  State.useSlot("chat");
  chat.sync();
  assert.equal(State.chatId, chatId);
  assert.equal(chat.el.find(".bubble")[0].textContent, "the chat's own question");
  assert.ok(!chat.el.querySelector(".chat-card").classList.contains("forge"));

  // Add a tool again: the saved one is done, a new workshop chat starts.
  State.forgeAsk = { edit: null };
  State.useSlot("forge");
  chat.sync();
  assert.notEqual(State.chatId, forgeId);
  assert.ok(isWorkshopChat(State.chatId));
});

test("Change with Lumo opens the workshop on the tool, and Save updates it", async () => {
  answers.tools_files = [["bench.py", "print(1)\n"]];
  State.forgeAsk = { edit: TOOL };
  State.useSlot("forge");
  chat.sync();
  await flush();
  chat.sync();
  assert.equal(State.chatHistory.length, 2, "the tool as it is, as the AI's own answer");
  assert.deepEqual(sent("chat_restore").at(-1).turns.map((t) => t.role), ["user", "assistant"]);
  assert.equal(chat.el.querySelector(".forge-status").textContent, "Saved");

  answers.chat_send = {
    text: `${FENCE}lumo-tool\n${JSON.stringify({ name: "Bench", description: "Faster.", entry: "bench.py" })}\n${FENCE}`,
    turns: 4,
  };
  inChat(".chat-input").value = "make it faster";
  inChat(".send-btn").fire("click");
  await flush();
  await flush();
  chat.sync();
  assert.equal(chat.el.querySelector(".forge-status").textContent, "Changed");
  answers.tools_save = { ...TOOL };
  button(chat.el, "Update tool").fire("click");
  await flush();
  const saved = sent("tools_save")[0].draft;
  assert.equal(saved.replaces, "bench");
  assert.equal(saved.files[0].content, "print(1)\n", "the file it left out comes from before");
});
