// The chat view (src/views/chat.ts) on a fake DOM, through the real bridge:
// the model switcher asks for a provider's models only once it is picked and
// has a key, picking saves the settings, and a streamed answer grows in place.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, emit, internals, sent } from "./tauri.mjs";

installFakeDom();
const { buildPrompt, conversationTurn } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { setLocalCaps } = await import("../src/core/providers.ts");

/** What the mocked Rust side answers, by command. */
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
  calls.length = 0;
  answers = {};
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {} };
  State.chatHistory = [];
  State.stateOverride = null;
  State.view = "prompt";
  State.droppedFile = null;
  State.chatSession = null;
  view = buildPrompt(() => {});
  view.sync();
});

const $ = (cls) => view.el.querySelector(cls);
const chips = () => view.el.find(".picker-chip").map((c) => c.textContent);
const models = () => view.el.find(".picker-model").map((m) => m.textContent);

test("the model button shows the active provider's model", () => {
  assert.equal($(".model-name").textContent, "claude-opus-5-5");
  State.settings = { ...State.settings, chatProvider: "google" };
  view.sync();
  assert.equal($(".model-name").textContent, "gemini-2.0-flash");
  State.settings = { ...State.settings, chatProvider: "ollama" };
  view.sync();
  assert.equal($(".model-name").textContent, "Choose a model");
});

test("Antigravity CLI needs no key, and a model with one level only keeps its name, with no slider", async () => {
  State.settings = { ...State.settings, chatProvider: "antigravity-cli", chatEffort: "high" };
  view.sync();
  assert.equal($(".model-name").textContent, "Default", "a saved effort never reaches agy");

  answers.chat_models = [{ id: "default", label: "Default" }, { id: "gemini-3.8-flash-low", label: "gemini-3.8-flash-low" }];
  $(".model-btn").fire("click");
  await flush();
  assert.deepEqual(sent("chat_models"), [{ provider: "antigravity-cli" }]);
  assert.deepEqual(models(), ["Default", "Gemini 3.8 Flash Low"], "agy's models by their names, not their ids");
  assert.equal($(".picker-efforts").hidden, true);
  assert.equal($(".effort-slider"), null);
});

test("Antigravity CLI's variants by effort are one model, with Claude Code's slider and no Auto", async () => {
  State.settings = { ...State.settings, chatProvider: "antigravity-cli", chatModels: { "antigravity-cli": "gemini-4-hydrogen-medium" } };
  view.sync();
  // Before agy is asked for its list, the name says the level.
  assert.equal($(".model-name").textContent, "Gemini 4 Hydrogen · Medium");

  answers.chat_models = [
    "default", "gemini-4-argon-medium", "gemini-4-argon-high", "gemini-4-argon-low",
    "gemini-4-hydrogen-high", "gemini-4-hydrogen-xhigh", "gemini-4-hydrogen-medium", "gemini-4-hydrogen-low",
    "gemini-pro-orchestrator-g1-pro", "gemini-3.8-flash-high", "gemini-3.8-flash-medium",
  ].map((id) => ({ id, label: id === "default" ? "Default" : id }));
  $(".model-btn").fire("click");
  await flush();
  assert.deepEqual(models(), ["Default", "Gemini 4 Argon", "Gemini 4 Hydrogen", "Gemini Pro Orchestrator G1 Pro", "Gemini 3.8 Flash"]);
  assert.equal($(".picker-model.on").textContent, "Gemini 4 Hydrogen");
  assert.equal($(".picker-model.on").getAttribute("title"), "gemini-4-hydrogen-medium", "the id shows on hover");

  // The slider has the model's own levels, and no Auto.
  assert.equal($(".picker-efforts").hidden, false);
  assert.equal($(".effort-auto"), null);
  assert.deepEqual($(".effort-row").children.map((c) => c.className.split(" ")[0]), ["effort-track", "effort-value"]);
  assert.equal($(".effort-slider").getAttribute("aria-valuemax"), "3", "low, medium, high, extra high");
  assert.equal($(".effort-value").textContent, "Medium");

  // A level is that variant of the model: the effort Claude Code keeps is left alone.
  const before = State.settings.chatEffort;
  $(".effort-slider").fire("keydown", { key: "End" });
  assert.equal(State.settings.chatModels["antigravity-cli"], "gemini-4-hydrogen-xhigh");
  assert.equal(sent("save_settings").at(-1).settings.chatModels["antigravity-cli"], "gemini-4-hydrogen-xhigh");
  assert.equal(State.settings.chatEffort, before);
  assert.equal($(".effort-value").textContent, "Extra high");
  view.sync();
  assert.equal($(".model-name").textContent, "Gemini 4 Hydrogen · Extra high");

  // Another model keeps the level when it has it, else takes medium.
  $(".effort-slider").fire("keydown", { key: "ArrowLeft" });
  view.el.find(".picker-model").find((m) => m.textContent === "Gemini 3.8 Flash").fire("click");
  assert.equal(State.settings.chatModels["antigravity-cli"], "gemini-3.8-flash-high");
  $(".model-btn").fire("click");
  await flush();
  view.el.find(".picker-model").find((m) => m.textContent === "Gemini 4 Argon").fire("click");
  assert.equal(State.settings.chatModels["antigravity-cli"], "gemini-4-argon-high");
  $(".model-btn").fire("click");
  await flush();
  $(".effort-slider").fire("keydown", { key: "End" });
  assert.equal(State.settings.chatModels["antigravity-cli"], "gemini-4-argon-high", "argon's highest is high");

  // A model with no levels: its name as it is, and no slider.
  view.el.find(".picker-model").find((m) => m.textContent === "Gemini Pro Orchestrator G1 Pro").fire("click");
  assert.equal(State.settings.chatModels["antigravity-cli"], "gemini-pro-orchestrator-g1-pro");
  view.sync();
  assert.equal($(".model-name").textContent, "Gemini Pro Orchestrator G1 Pro");
  $(".model-btn").fire("click");
  await flush();
  assert.equal($(".picker-efforts").hidden, true);
});

test("Claude Code's effort is one row: a filled slider, its level, and Auto at the end", async () => {
  State.settings = { ...State.settings, chatProvider: "claude-code" };
  view.sync();
  $(".model-btn").fire("click");
  await flush();
  assert.equal($(".picker-efforts").hidden, false);
  assert.equal($(".effort-value").textContent, "Auto");
  assert.ok($(".effort-auto").classList.contains("on"));
  assert.ok($(".effort-track").classList.contains("auto"), "no knob while Auto");
  assert.equal($(".effort-slider").getAttribute("aria-valuemax"), "4", "low, medium, high, extra high, max");
  assert.equal($(".effort-ticks").children.length, 5);
  // One row: no "Effort" label above, no Faster or Smarter; Auto at the end.
  assert.deepEqual($(".effort-row").children.map((c) => c.className.split(" ")[0]), ["effort-track", "effort-value", "effort-auto"]);
  assert.doesNotMatch($(".picker-efforts").textContent, /Faster|Smarter|Effort/);
  assert.equal($(".picker-efforts").children.length, 1);

  // From the keyboard: End is the highest level, the knob goes to the end.
  const slider = $(".effort-slider");
  slider.fire("keydown", { key: "End" });
  assert.equal(State.settings.chatEffort, "max");
  assert.equal(sent("save_settings").at(-1).settings.chatEffort, "max");
  assert.equal($(".effort-value").textContent, "Max");
  assert.ok(!$(".effort-track").classList.contains("auto"));
  assert.equal(slider.style["--at"], "1");
  slider.fire("keydown", { key: "ArrowLeft" });
  assert.equal(State.settings.chatEffort, "xhigh");
  assert.equal(slider.style["--at"], "0.75");

  $(".effort-auto").fire("click");
  assert.equal(State.settings.chatEffort, "");
  $(".model-btn").fire("click");
  State.settings = { ...State.settings, chatEffort: "xhigh" };
  view.sync();
  assert.equal($(".model-name").textContent, "Default · Extra high");
});

test("the shield picks what Claude Code and Antigravity CLI may do without asking", () => {
  // An API provider runs Lumo's tools on this computer: the local models' shield, sandbox and all.
  assert.equal($(".perm-btn").hidden, false);
  $(".perm-btn").fire("click");
  assert.deepEqual(view.el.find(".perm-row").map((r) => r.querySelector(".picker-model-name").textContent), ["Ask for approval", "Approve for me", "Run automatically", "Plan only"]);
  assert.ok($(".sandbox-chip"), "the sandbox's level beside the title");
  $(".perm-btn").fire("click");
  assert.ok(!$(".chat-body").classList.contains("authorizing"));
  State.settings = { ...State.settings, chatProvider: "claude-code" };
  view.sync();
  const shield = $(".perm-btn");
  assert.equal(shield.hidden, false);
  assert.match(shield.title, /Ask every time/);
  assert.ok(!shield.classList.contains("lit"));

  shield.fire("click");
  assert.ok($(".chat-body").classList.contains("authorizing"));
  const rows = () => view.el.find(".perm-row");
  assert.deepEqual(rows().map((r) => r.querySelector(".picker-model-name").textContent), ["Ask every time", "Auto", "Plan only"]);
  assert.ok(rows()[0].classList.contains("on"));

  const saves = sent("save_settings").length;
  rows()[1].fire("click");
  // This chat's alone: the default in the settings, which a new chat starts with, stays.
  assert.equal(State.settings.chatPermissionMode, "default");
  assert.equal(sent("save_settings").length, saves);
  assert.deepEqual(sent("chat_permissions").at(-1), { chatId: State.chatId, permissionMode: "auto", permissionModeAgy: "" });
  assert.ok(!$(".chat-body").classList.contains("authorizing"), "picking closes the list");
  view.sync();
  assert.ok($(".perm-btn").classList.contains("lit"), "lit while it may do more than ask");

  // Opening another list closes this one.
  $(".perm-btn").fire("click");
  $(".model-btn").fire("click");
  assert.ok(!$(".chat-body").classList.contains("authorizing"));
});

test("a provider without a key is never asked for its models", async () => {
  answers.secret_present = false;
  $(".model-btn").fire("click");
  await flush();
  assert.ok($(".chat-body").classList.contains("picking"));
  assert.deepEqual(chips(), ["Anthropic", "Claude Code", "Antigravity CLI", "Codex", "Copilot CLI", "Cursor CLI", "Google", "OpenAI", "OpenRouter"]);
  assert.deepEqual(sent("secret_present"), [{ key: "anthropic-api-key" }]);
  assert.deepEqual(sent("chat_models"), []);
  assert.match($(".picker-status").textContent, /No API key/);
});

test("only the providers set up show: no Anthropic without its key", async (t) => {
  const mem = new Map([["lumo.settings.page", "island"]]);
  const before = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  t.after(() => {
    globalThis.localStorage = before;
  });
  answers.chat_providers = ["claude-code", "antigravity-cli"];
  State.settings = { ...State.settings, chatProvider: "claude-code" };
  answers.chat_models = [{ id: "default", label: "Default" }];
  view.sync();
  $(".model-btn").fire("click");
  await flush();
  assert.deepEqual(chips(), ["Claude Code", "Antigravity CLI"]);
  // Nothing set up: a pointer to Settings instead of chips and models.
  $(".model-btn").fire("click");
  answers.chat_providers = [];
  $(".model-btn").fire("click");
  await flush();
  assert.match($(".picker-status").textContent, /No provider is set up yet/);
  assert.ok($(".picker.models").classList.contains("empty"));
  $(".picker-link").fire("click");
  assert.equal(mem.get("lumo.settings.page"), "chat");
  answers.chat_providers = null;
  $(".model-btn").fire("click");
  await flush();
});

test("with a key, the models are listed and picking one saves it", async () => {
  answers.secret_present = true;
  answers.chat_models = [
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  ];
  $(".model-btn").fire("click");
  await flush();
  assert.deepEqual(sent("chat_models"), [{ provider: "anthropic" }]);
  assert.deepEqual(models(), ["Claude Opus 5", "Claude Sonnet 5"]);
  view.el.find(".picker-model")[1].fire("click");
  assert.equal(State.settings.model, "claude-sonnet-5");
  assert.equal(sent("save_settings").at(-1).settings.model, "claude-sonnet-5");
  assert.ok(!$(".chat-body").classList.contains("picking"));
  assert.equal($(".model-name").textContent, "claude-sonnet-5");
});

test("switching provider saves it and asks the new provider only", async () => {
  answers.secret_present = (args) => args.key === "google-api-key";
  answers.chat_models = (args) => (args.provider === "google" ? [{ id: "gemini-2.5-flash", label: "gemini-2.5-flash" }] : []);
  $(".model-btn").fire("click");
  await flush();
  assert.deepEqual(sent("chat_models"), []);
  view.el.find(".picker-chip")[6].fire("click");
  await flush();
  assert.equal(State.settings.chatProvider, "google");
  assert.deepEqual(sent("chat_models"), [{ provider: "google" }]);
  // The saved model was not offered: the flash one is kept instead, and saved.
  assert.equal(State.settings.chatModels.google, "gemini-2.5-flash");
  assert.equal(sent("save_settings").at(-1).settings.chatModels.google, "gemini-2.5-flash");
  assert.deepEqual(models(), ["gemini-2.5-flash"]);
});

test("a local answer streams into one reply, then the finished text replaces it", async () => {
  let finish;
  answers.chat_send = () => new Promise((resolve) => (finish = resolve));
  const input = $(".chat-input");
  input.value = "hello";
  $(".send-btn").fire("click");
  await flush();
  view.sync(); // what State.notify() does in the island
  assert.ok(!$(".model-btn").disabled, "the model can be changed mid-answer, for the next message");
  assert.ok($(".typing"), "dots until the first visible text");

  emit("chat-delta", { chat: State.chatId, text: "" }); // still thinking
  assert.ok($(".typing"));
  emit("chat-delta", { chat: State.chatId, text: "Hel" });
  emit("chat-delta", { chat: State.chatId, text: "Hello **there**" });
  view.sync(); // another view update mid-stream must not wipe the live answer
  assert.equal($(".typing"), null);
  const replies = view.el.find(".reply");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].find("STRONG")[0].textContent, "there");

  finish({ text: "Hello **there**!" });
  await flush();
  view.sync();
  assert.equal(view.el.find(".reply").length, 1);
  assert.equal(view.el.find(".reply")[0].textContent, "Hello there!");
  assert.deepEqual(State.chatHistory.map((m) => m.role), ["user", "assistant"]);
  assert.ok(!$(".model-btn").disabled);
});

test("away from its end, sending and the answer being written never scroll the chat", async () => {
  let finish;
  answers.chat_send = () => new Promise((resolve) => (finish = resolve));
  const log = $(".chat-log");
  log.clientHeight = 100;
  log.scrollHeight = 600;
  log.scrollTop = 250; // where the user is reading
  log.fire("scroll");
  $(".chat-input").value = "tell me a story";
  $(".send-btn").fire("click");
  await flush();
  view.sync();
  assert.equal(log.scrollTop, 250, "sending leaves the chat where it was");

  log.scrollHeight = 1000;
  emit("chat-delta", { chat: State.chatId, text: "Once upon" });
  assert.equal(log.scrollTop, 250, "the answer being written does not pull it down");

  log.scrollTop = 300;
  log.fire("scroll");
  finish({ text: "Once upon a time." });
  await flush();
  view.sync();
  assert.equal(log.scrollTop, 300, "the finished answer replaces the streamed one where it was read");

  answers.chat_send = { text: "The end." };
  $(".chat-input").value = "and then?";
  $(".send-btn").fire("click");
  await flush();
  view.sync();
  assert.equal(log.scrollTop, 300, "the next question does not scroll it either");
});

test("the finished answer drawn again keeps the place it was read while its cards fit themselves", async () => {
  let finish;
  answers.chat_send = () => new Promise((resolve) => (finish = resolve));
  const log = $(".chat-log");
  log.clientHeight = 100;
  log.scrollHeight = 600;
  log.scrollTop = 250;
  log.fire("scroll");
  $(".chat-input").value = "plot it";
  $(".send-btn").fire("click");
  await flush();
  view.sync();
  log.scrollHeight = 1000;
  emit("chat-delta", { chat: State.chatId, text: "Here it is" });
  const frames = [];
  const now = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (fn) => frames.push(fn);
  try {
    finish({ text: "Here it is." });
    await flush();
    view.sync();
    assert.equal(log.scrollTop, 250, "put back where it was read");
    assert.equal(log.style.overflowAnchor, "none", "no scroll anchoring on the cards' first size");
    for (let i = 0; i < 2; i++) frames.splice(0).forEach((fn) => fn());
    assert.equal(log.style.overflowAnchor, "", "then anchoring again, for what loads later");
  } finally {
    globalThis.requestAnimationFrame = now;
  }
});

test("scrolled to its end, the chat follows the answer until the slightest scroll up", async () => {
  let finish;
  answers.chat_send = () => new Promise((resolve) => (finish = resolve));
  const log = $(".chat-log");
  const arrow = $(".chat-to-end");
  log.clientHeight = 100;
  log.scrollHeight = 600;
  log.scrollTop = 500; // all the way down
  log.fire("scroll");
  assert.ok(arrow.hidden, "no arrow at the end");
  $(".chat-input").value = "tell me a story";
  $(".send-btn").fire("click");
  await flush();
  view.sync();

  log.scrollHeight = 1000;
  emit("chat-delta", { chat: State.chatId, text: "Once upon" });
  assert.equal(log.scrollTop, 1000, "stuck to the end, it follows the text");
  log.scrollTop = 900; // where a real log stops
  log.fire("scroll");
  assert.ok(arrow.hidden);

  log.fire("wheel", { deltaY: -10 }); // a turn of the wheel up lets go at once
  log.scrollHeight = 1400;
  emit("chat-delta", { chat: State.chatId, text: "Once upon a time" });
  assert.equal(log.scrollTop, 900, "let go, it stays where it is read");
  log.scrollTop = 1250; // still in sight of the end: no arrow yet
  log.fire("scroll");
  assert.ok(arrow.hidden, "just above the end, no arrow");
  log.scrollTop = 900; // more than a screenful up
  log.fire("scroll");
  assert.ok(!arrow.hidden, "a screenful up, the arrow shows");

  arrow.fire("click");
  assert.equal(log.scrollTop, 1400, "the arrow brings it to the end");
  log.scrollTop = 1300;
  log.fire("scroll");
  assert.ok(arrow.hidden);
  log.scrollHeight = 1600;
  emit("chat-delta", { chat: State.chatId, text: "Once upon a time, there" });
  assert.equal(log.scrollTop, 1600, "and stuck there again");

  log.scrollTop = 1450; // the scrollbar dragged up
  log.fire("scroll");
  log.scrollHeight = 1800;
  finish({ text: "Once upon a time, there was." });
  await flush();
  view.sync();
  assert.equal(log.scrollTop, 1450, "the finished answer leaves it where it was read");
});

// ── Stop, copy, edit ──────────────────────────────────────────────────────────

/** A key typed in the chat field (`extra`: shiftKey…). */
function type(key, extra = {}) {
  const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
  for (const fn of $(".chat-input").listeners.get("keydown")) fn(event);
  return event;
}

/** chat_send answers when the test says so: each call's resolver, in order. */
function heldAnswers() {
  const pending = [];
  answers.chat_send = () => new Promise((resolve) => pending.push(resolve));
  return pending;
}

async function ask(text) {
  $(".chat-input").value = text;
  type("Enter");
  await flush();
  await flush();
  view.sync();
}

test("Shift+Enter starts a new line instead of sending; Enter sends it all", async () => {
  answers.chat_send = { text: "ok", turns: 2 };
  const input = $(".chat-input");
  assert.equal(input.tagName, "TEXTAREA");
  input.value = "first line";
  const shifted = type("Enter", { shiftKey: true });
  assert.equal(shifted.defaultPrevented, false, "the field adds the new line itself");
  await flush();
  assert.deepEqual(sent("chat_send"), []);
  input.value = "first line\nsecond line";
  type("Enter");
  await flush();
  assert.equal(sent("chat_send").length, 1);
  assert.equal(sent("chat_send")[0].query, "first line\nsecond line");
  // While an IME composes, Enter is the IME's.
  input.value = "かな";
  const composing = type("Enter", { isComposing: true });
  assert.equal(composing.defaultPrevented, false);
});

const rows = () => view.el.find(".chat-row");
const editOf = (i) => rows()[i].find(".msg-edit")[0];

test("a message sent while the answer is written waits above the field, then goes as soon as it ends", async () => {
  const pending = heldAnswers();
  await ask("tell me a story");
  const input = $(".chat-input");
  input.value = "and another";
  type("Enter");
  await flush();
  assert.equal(sent("chat_send").length, 1, "it waits");
  assert.equal(input.value, "", "it leaves the field");
  assert.ok(!$(".chat-queue").hidden, "and waits above it");
  assert.equal($(".queue-text").textContent, "and another");
  // A second one joins it.
  input.value = "and a third";
  type("Enter");
  await flush();
  assert.equal($(".queue-text").textContent, "and another\nand a third");
  input.value = "still typing";
  pending[0]({ text: "Once upon a time.", turns: 2 });
  await flush();
  await flush();
  assert.equal(sent("chat_send").length, 2, "then it goes");
  assert.equal(sent("chat_send")[1].query, "and another\nand a third");
  assert.equal(input.value, "still typing", "what is typed meanwhile stays");
  view.sync();
  assert.ok($(".chat-queue").hidden);
});

test("a queued message can be edited or cancelled", async () => {
  const pending = heldAnswers();
  await ask("tell me a story");
  const input = $(".chat-input");
  input.value = "and another";
  type("Enter");
  await flush();
  $(".chat-queue").find(".queue-btn")[0].fire("click");
  assert.equal(input.value, "and another", "Edit puts it back in the field");
  assert.ok($(".chat-queue").hidden);
  type("Enter");
  await flush();
  $(".chat-queue").find(".queue-btn")[1].fire("click");
  assert.ok($(".chat-queue").hidden, "Cancel drops it");
  assert.equal(input.value, "");
  pending[0]({ text: "Once upon a time.", turns: 2 });
  await flush();
  await flush();
  assert.equal(sent("chat_send").length, 1, "nothing else goes");
});

test("while an answer is written, send is a Stop button, and the arrow again once something is typed", async () => {
  const pending = heldAnswers();
  await ask("tell me a story");
  const input = $(".chat-input");
  assert.ok(!input.disabled, "the next question can be typed meanwhile");
  assert.ok($(".send-btn").classList.contains("stop"));
  assert.equal($(".send-btn").title, "Stop");
  input.value = "and another";
  input.fire("input");
  assert.ok(!$(".send-btn").classList.contains("stop"), "something typed: the arrow");
  $(".send-btn").fire("click");
  await flush();
  assert.equal(sent("chat_send").length, 1, "the arrow queues it");
  assert.equal(sent("chat_stop").length, 0);
  assert.equal(input.value, "");
  assert.ok($(".send-btn").classList.contains("stop"), "the field empty again: Stop");

  emit("chat-delta", { chat: State.chatId, text: "Once upon" });
  $(".send-btn").fire("click");
  assert.equal(sent("chat_stop").length, 1);
  assert.ok($(".send-btn").disabled, "pressed once");
  $(".send-btn").fire("click");
  assert.equal(sent("chat_stop").length, 1);

  pending[0]({ text: "Once upon", stopped: true, turns: 2 });
  await flush();
  view.sync();
  assert.deepEqual(
    State.chatHistory.map((m) => [m.role, m.content, m.stopped ?? false, m.turn]),
    [["user", "tell me a story", false, 0], ["assistant", "Once upon", true, 1]],
  );
  assert.equal(view.el.find(".reply").length, 1, "what was written stays");
  assert.equal($(".msg-stopped").textContent, "Stopped");
  assert.ok(!$(".send-btn").classList.contains("stop"));
  assert.ok(!$(".send-btn").disabled);
  assert.equal($(".send-btn").title, "Send");
  assert.equal(sent("chat_send").length, 1, "after Stop the queued question does not go");
  assert.equal(input.value, "and another", "it comes back to the field, ready to go");
  assert.ok($(".chat-queue").hidden);
});

test("Escape stops an answer; stopped before any text, the question stays unanswered", async () => {
  const pending = heldAnswers();
  State.droppedFile = { name: "a.pdf", path: "/inbox/a.pdf" };
  await ask("summary?");
  assert.ok(type("Escape").defaultPrevented);
  assert.equal(sent("chat_stop").length, 1);
  pending[0]({ text: "", stopped: true, turns: 0 });
  await flush();
  view.sync();
  assert.deepEqual(State.chatHistory.map((m) => m.role), ["user"]);
  assert.equal(State.chatHistory[0].turn, undefined, "Rust kept nothing of it");
  assert.ok(!State.droppedFile.sent, "the file goes with the next question");
  assert.equal(view.el.find(".reply").length, 0);
  // With nothing being written, Escape stops nothing.
  type("Escape");
  assert.equal(sent("chat_stop").length, 1);
});

test("Copy takes a question or an answer as written, Markdown included", async () => {
  const copied = [];
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText: async (text) => copied.push(text) },
    configurable: true,
  });
  try {
    answers.chat_send = { text: "Use **bold** and `code`.", turns: 2 };
    await ask("how?");
    // Under the question, as in Claude's app: when, Retry, Edit, Copy.
    const questionActions = rows()[0].find(".msg-action");
    assert.deepEqual(questionActions.map((b) => b.classList.contains("msg-retry") ? "retry" : b.classList.contains("msg-edit") ? "edit" : "copy"),
      ["retry", "edit", "copy"]);
    rows()[0].find(".msg-copy")[0].fire("click");
    // Under the answer: Copy, Retry, when.
    const answerActions = rows()[1].find(".msg-action");
    assert.deepEqual(answerActions.map((b) => b.classList.contains("msg-retry") ? "retry" : "copy"), ["copy", "retry"]);
    answerActions[0].fire("click");
    await flush();
    assert.deepEqual(copied, ["how?", "Use **bold** and `code`."]);
  } finally {
    delete globalThis.navigator.clipboard;
  }
});

test("a question, once sent, is Markdown and TeX like the answers; Copy and Edit take it as written", async () => {
  const copied = [];
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText: async (text) => copied.push(text) },
    configurable: true,
  });
  try {
    const question = "Why is $\\int_0^1 x^2\\,dx$ **a third**?\n\n$$\\frac{1}{3}$$";
    answers.chat_send = { text: "Because of $x^3/3$.", turns: 2 };
    await ask(question);
    const bubble = rows()[0].querySelector(".bubble");
    assert.ok(bubble.classList.contains("md"));
    assert.equal(bubble.find("strong")[0].textContent, "a third");
    assert.equal(bubble.find("math").length, 2, "the formula in the line and the one on its own");
    assert.ok(bubble.querySelector(".md-math"));
    assert.doesNotMatch(bubble.textContent, /\$|\\int|\*\*/, "no TeX or Markdown left as text");

    rows()[0].find(".msg-copy")[0].fire("click");
    await flush();
    assert.deepEqual(copied, [question]);
    editOf(0).fire("click");
    view.sync();
    assert.equal($(".chat-input").value, question);
  } finally {
    delete globalThis.navigator.clipboard;
  }
});

test("plain words in a question are one paragraph, as they were written", async () => {
  answers.chat_send = { text: "ok", turns: 2 };
  await ask("fix the export button\non Safari");
  const bubble = rows()[0].querySelector(".bubble");
  assert.equal(bubble.find(".md-p").length, 1);
  assert.equal(bubble.textContent, "fix the export button\non Safari");
});

/** The chat's one ResizeObserver (made once, with the first long question): the tests call its measures. */
let foldMeasure = null;

/** A ResizeObserver whose measures the test calls, while `run` lasts; without one, questions are never folded. */
async function withMeasure(run) {
  globalThis.ResizeObserver = class {
    constructor(cb) { foldMeasure ??= cb; }
    observe() {}
  };
  try {
    await run((...targets) => foldMeasure(targets.map((target) => ({ target }))));
  } finally {
    delete globalThis.ResizeObserver;
  }
}

test("a long question folds to its first lines, with Show more and Show less in its bubble", async () => {
  await withMeasure(async (measureOf) => {
    const measure = (entries) => measureOf(...entries.map((e) => e.target));
    answers.chat_send = { text: "ok", turns: 2 };
    await ask("a short one");
    await ask("a long one\n".repeat(40));
    const [short, long] = rows().filter((r) => r.classList.contains("user"));
    const bubbleOf = (row) => row.querySelector(".bubble");
    const fold = (row) => row.querySelector(".msg-fold");
    bubbleOf(short).scrollHeight = 30;
    bubbleOf(long).scrollHeight = 600;
    measure([{ target: bubbleOf(short) }, { target: bubbleOf(long) }]);

    assert.equal(fold(short), null, "a short question is left as it is");
    assert.equal(bubbleOf(short).textContent, "a short one");
    assert.equal(fold(long).parentNode, bubbleOf(long), "the button is in the bubble");
    const body = long.querySelector(".bubble-body");
    assert.ok(body.classList.contains("folded"));
    assert.equal(fold(long).textContent, "Show more");

    body.scrollHeight = 600;
    fold(long).fire("click");
    assert.ok(!body.classList.contains("folded"));
    assert.equal(fold(long).textContent, "Show less");

    // Drawn again with the next question, it stays open.
    await ask("one more");
    const again = rows().filter((r) => r.classList.contains("user"))[1];
    bubbleOf(again).scrollHeight = 600;
    measure([{ target: bubbleOf(again) }]);
    assert.equal(fold(again).textContent, "Show less");

    again.querySelector(".bubble-body").scrollHeight = 600;
    fold(again).fire("click");
    assert.ok(again.querySelector(".bubble-body").classList.contains("folded"));
    assert.equal(fold(again).textContent, "Show more");
  });
});

const userRows = () => rows().filter((r) => r.classList.contains("user"));

test("a question opened with Show more stays open when its chat comes back with new ids", async () => {
  await withMeasure(async (measure) => {
    answers.chat_send = { text: "ok", turns: 2 };
    const text = "a question opened, then its chat left\n".repeat(40);
    await ask(text);
    const bubble = userRows()[0].querySelector(".bubble");
    bubble.scrollHeight = 600;
    measure(bubble);
    userRows()[0].querySelector(".bubble-body").scrollHeight = 600;
    userRows()[0].querySelector(".msg-fold").fire("click");
    assert.equal(userRows()[0].querySelector(".msg-fold").textContent, "Show less");

    // Opened again, a saved chat's messages are given new ids (openChat).
    State.chatHistory = State.chatHistory.map((m, i) => ({ ...m, id: 10_000 + i }));
    await ask("and now");
    const again = userRows()[0].querySelector(".bubble");
    again.scrollHeight = 600;
    measure(again);
    assert.equal(userRows()[0].querySelector(".msg-fold").textContent, "Show less");
  });
});

test("measured again at the same size, Show more's label is left as it is", async () => {
  await withMeasure(async (measure) => {
    answers.chat_send = { text: "ok", turns: 2 };
    await ask("a question measured at each frame\n".repeat(40));
    const bubble = userRows()[0].querySelector(".bubble");
    bubble.scrollHeight = 600;
    measure(bubble);
    const btn = userRows()[0].querySelector(".msg-fold");
    const label = btn.firstChild;
    userRows()[0].querySelector(".bubble-body").scrollHeight = 600;
    measure(bubble);
    measure(bubble);
    assert.equal(btn.firstChild, label, "the same text, not written again");
  });
});

test("the keyboard reaching a folded question's hidden lines opens it", async () => {
  await withMeasure(async (measure) => {
    answers.chat_send = { text: "ok", turns: 2 };
    await ask("a question with a link further down\n".repeat(40));
    const bubble = userRows()[0].querySelector(".bubble");
    bubble.scrollHeight = 600;
    measure(bubble);
    const body = userRows()[0].querySelector(".bubble-body");
    body.scrollHeight = 600;
    assert.ok(body.classList.contains("folded"));
    body.fire("focusin");
    assert.ok(!body.classList.contains("folded"));
    assert.equal(userRows()[0].querySelector(".msg-fold").textContent, "Show less");
  });
});

test("Edit puts a question back; sending it replaces it and drops what followed", async () => {
  let n = 0;
  answers.chat_send = () => {
    n += 1;
    return { text: `answer ${n}`, session: "s", turns: 2 * n };
  };
  for (const q of ["one", "two", "three"]) await ask(q);
  assert.equal(State.chatHistory.length, 6);
  assert.equal(State.chatSession, "s");

  editOf(2).fire("click");
  view.sync();
  assert.equal($(".chat-input").value, "two");
  assert.match($(".chip-row").textContent, /Editing a message/);
  assert.ok(rows()[2].classList.contains("editing"));
  assert.equal(view.el.find(".dropped").length, 3, "what sending would drop shows faded");

  n = 1; // Rust keeps the first turn: the new answer is its second
  answers.chat_send = (args) => {
    assert.equal(State.chatSession, null, "the old Claude Code session is left behind");
    n += 1;
    return { text: `answer ${n}`, turns: 2 * n, query: args.query };
  };
  await ask("two, but better");
  assert.deepEqual(sent("chat_rewind"), [{ chatId: State.chatId, keep: 2 }]);
  assert.equal(sent("chat_send").at(-1).query, "two, but better");
  assert.deepEqual(State.chatHistory.map((m) => m.content), ["one", "answer 1", "two, but better", "answer 2"]);
  assert.equal(view.el.find(".dropped").length, 0);
  assert.doesNotMatch($(".chip-row").textContent, /Editing/);

  // The first question: nothing is kept, and the file it carried goes again.
  State.droppedFile = { name: "a.pdf", path: "/inbox/a.pdf", sent: true, sentWith: State.chatHistory[0].id };
  editOf(0).fire("click");
  view.sync();
  n = 0;
  await ask("one");
  assert.deepEqual(sent("chat_rewind").at(-1), { chatId: State.chatId, keep: 0 });
  assert.equal(sent("chat_send").at(-1).query, "one");
  assert.equal(sent("chat_send").at(-1).context?.name, "a.pdf");
  assert.deepEqual(State.chatHistory.map((m) => m.content), ["one", "answer 1"]);
});

test("Retry is on the last question and its answer only, and sends the question again in place of its answer", async () => {
  let n = 0;
  answers.chat_send = () => {
    n += 1;
    return { text: `answer ${n}`, turns: 2 * n };
  };
  await ask("one");
  await ask("two");
  assert.deepEqual(rows().map((r) => r.find(".msg-retry").length), [0, 0, 1, 1], "only the last question and its answer");
  // The last answer's actions stay in sight; the others show under the mouse.
  assert.deepEqual(rows().map((r) => r.find(".msg-actions")[0].classList.contains("shown")), [false, false, false, true]);

  // What is typed meanwhile stays in the field.
  $(".chat-input").value = "a draft";
  n = 1;
  rows()[3].find(".msg-retry")[0].fire("click");
  await flush();
  await flush();
  view.sync();
  assert.deepEqual(sent("chat_rewind").at(-1), { chatId: State.chatId, keep: 2 });
  assert.equal(sent("chat_send").at(-1).query, "two");
  assert.deepEqual(State.chatHistory.map((m) => m.content), ["one", "answer 1", "two", "answer 2"]);
  assert.equal($(".chat-input").value, "a draft");

  // From the question too.
  n = 1;
  rows()[2].find(".msg-retry")[0].fire("click");
  await flush();
  await flush();
  assert.equal(sent("chat_send").length, 4);
  assert.equal(sent("chat_send").at(-1).query, "two");
});

test("a question whose answer failed keeps its Retry in sight", async () => {
  answers.chat_send = () => Promise.reject(new Error("offline"));
  await ask("hello");
  assert.equal(State.chatHistory.at(-1).failed, true);
  assert.equal(rows()[1].find(".msg-actions").length, 0, "the failure has no actions");
  assert.ok(rows()[0].find(".msg-actions")[0].classList.contains("shown"));
  answers.chat_send = { text: "hi", turns: 2 };
  rows()[0].find(".msg-retry")[0].fire("click");
  await flush();
  await flush();
  assert.deepEqual(State.chatHistory.map((m) => m.content), ["hello", "hi"]);
});

test("an answer agy ended with an error keeps its warning in sight on its Copy/Retry bar, its detail on a click", async () => {
  const words = "Malformed function call: Function call is empty - no input to parse.";
  answers.chat_send = { text: "Ecco gli appunti.", turns: 2, warning: { kind: "malformed", message: words } };
  await ask("appunti in LaTeX");
  answers.chat_send = { text: "Fatto.", turns: 4 };
  await ask("e l'indice?");
  const answer = rows()[1];
  const line = answer.find(".msg-warning")[0];
  assert.equal(line.textContent, "Antigravity CLI reported a problem at the end");
  // On the actions' bar, which stays in sight under a past answer with a warning.
  assert.equal(answer.find(".msg-actions")[0].find(".msg-warning").length, 1);
  assert.ok(answer.find(".msg-actions")[0].classList.contains("shown"), "in sight without the mouse");
  const detail = answer.find(".msg-warning-detail")[0];
  assert.equal(detail.hidden, true);
  line.fire("click");
  assert.equal(detail.hidden, false);
  assert.match(detail.textContent, /empty tool call/);
  assert.ok(detail.textContent.endsWith(`Antigravity CLI's message: ${words}`));
  assert.equal(rows()[3].find(".msg-warning").length, 0, "an answer without one has none");
  // A past answer without one hides its bar until hovered, as always.
  answers.chat_send = { text: "Ok.", turns: 6 };
  await ask("grazie");
  assert.ok(!rows()[3].find(".msg-actions")[0].classList.contains("shown"));
});

test("away from the chat, an answer with a warning is noted in amber, with a problem", async () => {
  const { Feed } = await import("../src/core/compact.ts");
  const pending = heldAnswers();
  await ask("appunti");
  const before = { mode: State.mode, view: State.view };
  State.view = "home";
  try {
    pending[0]({ text: "Ecco.", turns: 2, warning: { kind: "error", message: "boom" } });
    await flush();
    await flush();
    const note = Feed.notices.at(-1);
    assert.match(note.text, /answered, with a problem$/);
    assert.equal(note.color, "#f5a524");
  } finally {
    Object.assign(State, before);
  }
});

test("a warning is said in the island's language when shown; one saved by a beta keeps its words", async () => {
  const { warningWords, failedParts } = await import("../src/views/chat.ts");
  const { savedWarning } = await import("../src/core/chats.ts");
  const { setLanguage } = await import("../src/i18n/i18n.ts");
  const saved = savedWarning({ kind: "error", message: "quota exceeded" });
  assert.deepEqual(saved, { kind: "error", message: "quota exceeded" });
  setLanguage("it");
  try {
    const w = warningWords(saved);
    assert.equal(w.line, "Antigravity CLI ha segnalato un problema alla fine");
    assert.match(w.detail, /ha chiuso questo turno con un errore/);
    assert.ok(w.detail.endsWith("Messaggio di Antigravity CLI: quota exceeded"));
  } finally {
    setLanguage("en");
  }
  // Saved by the 0.22.2 betas: the words as they were.
  const beta = savedWarning({ line: "L", detail: "D" });
  assert.deepEqual(warningWords(beta), { line: "L", detail: "D" });
  // Anything else is no warning.
  assert.equal(savedWarning({ kind: "other", message: "x" }), undefined);
  assert.equal(savedWarning("x"), undefined);
  assert.equal(savedWarning(null), undefined);
  // A failed answer's words: Lumo's, then the CLI's after U+2063.
  assert.deepEqual(failedParts("Stopped.\n\u2063Antigravity CLI's message: x"), ["Stopped.", "Antigravity CLI's message: x"]);
  assert.deepEqual(failedParts("offline"), ["offline", ""]);
});

test("a failed answer shows the CLI's own words apart, the note only Lumo's", async () => {
  answers.chat_send = () => Promise.reject(new Error("Antigravity CLI stopped.\n\u2063Antigravity CLI's message: Malformed function call"));
  await ask("hello");
  const failed = rows()[1];
  assert.equal(failed.find(".msg-failed")[0].textContent, "Antigravity CLI stopped.");
  assert.equal(failed.find(".msg-warning-detail")[0].textContent, "Antigravity CLI's message: Malformed function call");
});

test("signed out or not installed: a card that puts it right, in place of the error", async () => {
  answers.chat_send = () => Promise.reject(new Error("Claude Code isn't signed in to your Claude plan, or its sign-in has run out.\n\u2063Not logged in · Please run /login\u2064claude-sign-in"));
  await ask("hello");
  const card = rows()[1].find(".chat-fix")[0];
  assert.equal(card.getAttribute("data-fix"), "claude-sign-in");
  assert.equal(card.find(".chat-fix-title")[0].textContent, "Claude Code isn't signed in to your Claude plan");
  assert.equal(card.find(".chat-fix-detail")[0].textContent, "Not logged in · Please run /login", "Claude Code's own words, small under it");
  assert.equal(rows()[1].find(".msg-failed").length, 0);
  // Sign in opens Claude Code's own window; Retry sends the question again.
  card.find(".chat-fix-btn").find((b) => b.classList.contains("primary")).fire("click");
  assert.deepEqual(sent("cli_sign_in"), [{ provider: "claude-code" }]);
  answers.chat_send = { text: "Hi!" };
  card.find(".chat-fix-btn").find((b) => b.textContent === "Retry").fire("click");
  await flush();
  await flush();
  view.sync();
  assert.equal(sent("chat_send").length, 2);
  assert.equal(rows().at(-1).find(".chat-fix").length, 0);

  // Not installed: the command, to copy.
  answers.chat_send = () => Promise.reject(new Error("Antigravity CLI isn't installed.\u2064agy-install"));
  await ask("again");
  const install = rows().at(-1).find(".chat-fix")[0];
  assert.equal(install.find("code")[0].textContent, "irm https://antigravity.google/cli/install.ps1 | iex");
});

test("agy skipped commands: under its answer, a card that leads to Settings → Agents", async (t) => {
  const mem = new Map();
  const before = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  t.after(() => {
    globalThis.localStorage = before;
  });
  let opened = 0;
  view = buildPrompt(() => {}, () => opened++);
  view.sync();
  answers.chat_send = { text: "I couldn't create the folders: the command wasn't allowed.", fix: "agy-hooks" };
  await ask("make the folders");
  const answer = rows()[1];
  assert.match(answer.find(".reply")[0].textContent, /couldn't create/);
  const card = answer.find(".chat-fix")[0];
  assert.equal(card.getAttribute("data-fix"), "agy-hooks");
  card.find(".chat-fix-btn").find((b) => b.classList.contains("primary")).fire("click");
  assert.equal(mem.get("lumo.settings.page"), "agents");
  assert.equal(opened, 1);
});

test("Past chats keep an answer's warning, also when Claude Code adds to the chat by itself", async (t) => {
  if (!globalThis.localStorage) {
    t.after(() => delete globalThis.localStorage);
    const mem = new Map();
    globalThis.localStorage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };
  }
  const { loadChats } = await import("../src/core/chats.ts");
  const warning = { kind: "malformed", message: "Malformed function call" };
  answers.chat_send = { text: "Ecco.", turns: 2, session: "s1", warning };
  await ask("appunti");
  const saved = () => loadChats().find((c) => c.id === State.chatId);
  assert.deepEqual(saved().turns[1].warning, warning);
  // Claude Code writes by itself into the chat on screen: the chat is saved again, its warning with it.
  emit("chat-own-answer", { chat: State.chatId, text: "E poi.", session: "s1" });
  await flush();
  await flush();
  assert.deepEqual(saved().turns[1].warning, warning);
});

test("each message says when it was sent or answered", async () => {
  const { sentAgo } = await import("../src/views/chat.ts");
  answers.chat_send = { text: "ok", turns: 2 };
  const before = Date.now();
  await ask("hello");
  assert.ok(State.chatHistory.every((m) => m.at >= before && m.at <= Date.now()));
  assert.deepEqual(view.el.find(".msg-time").map((e) => e.textContent), ["just now", "just now"]);
  const now = Date.UTC(2026, 10, 10, 16, 0);
  assert.equal(sentAgo(now - 5 * 60_000, now), "5 min ago");
  assert.equal(sentAgo(now - 3 * 3_600_000, now), "3 h ago");
  assert.equal(sentAgo(Date.UTC(2026, 10, 2, 12, 0), now), "Nov 2");
});

test("editing a message takes the files of the questions after it out of the chat's files, and a × takes one out of the context", async (t) => {
  const { chatFiles } = await import("../src/core/chat-files.ts");
  const mem = new Map();
  const before = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  t.after(() => {
    globalThis.localStorage = before;
  });
  let n = 0;
  answers.chat_send = () => {
    n += 1;
    // The AI reads a file while answering the second question.
    if (n === 2) emit("chat-file", { chat: State.chatId, kind: "read", path: String.raw`C:\Docs\later.md` });
    return { text: `answer ${n}`, turns: 2 * n };
  };
  State.droppedFile = { name: "first.pdf", path: String.raw`C:\inbox\first.pdf` };
  view.sync();
  await ask("one");
  State.droppedFile = { name: "second.pdf", path: String.raw`C:\inbox\second.pdf` };
  view.sync();
  await ask("two");
  assert.deepEqual(chatFiles(State.chatId).map((f) => f.name).sort(), ["first.pdf", "later.md", "second.pdf"]);

  // The chat's files: a folder per kind, each with how many it holds.
  $(".files-btn").fire("click");
  view.el.find(".files-tab")[1].fire("click");
  const groups = () => view.el.find(".chat-files-list")[0].find(".attach-group");
  assert.deepEqual(groups().map((g) => [g.find(".attach-name")[0].textContent, g.find(".attach-group-count")[0].textContent]),
    [["Attached", "2"], ["Read by the AI", "1"]]);

  // Editing the first question: the second question's file and what the AI read for it go too.
  editOf(0).fire("click");
  view.sync();
  answers.chat_send = () => {
    emit("chat-file", { chat: State.chatId, kind: "read", path: String.raw`C:\Docs\new.md` });
    return { text: "answer 1", turns: 2 };
  };
  await ask("one, again");
  assert.deepEqual(sent("chat_rewind").at(-1), { chatId: State.chatId, keep: 0 });
  // Its own file goes again with it (core/sent.ts); the later question's doesn't.
  assert.equal(sent("chat_send").at(-1).context?.name, "first.pdf");
  assert.equal(sent("chat_send").at(-1).screen, undefined, "the later question's file doesn't go again");
  assert.deepEqual(chatFiles(State.chatId).map((f) => f.name).sort(), ["first.pdf", "new.md"]);

  // Its ×: out of the list, and Rust tells the AI with the next question.
  const row = view.el.find(".chat-files-list")[0].find(".attach-row").find((r) => r.find(".attach-name")[0].textContent === "new.md");
  row.find(".attach-remove")[0].fire("click");
  assert.deepEqual(sent("chat_forget_file").at(-1), { chatId: State.chatId, name: "new.md", path: String.raw`C:\Docs\new.md` });
  assert.deepEqual(chatFiles(State.chatId).map((f) => f.name), ["first.pdf"]);
  assert.deepEqual(view.el.find(".chat-files-list")[0].find(".attach-group").map((g) => g.find(".attach-name")[0].textContent), ["Attached"],
    "an empty kind shows no folder");
});

test("Escape or the chip's × leaves an edit", async () => {
  answers.chat_send = { text: "hi", turns: 2 };
  await ask("hello");
  assert.ok(!$(".chat-body").classList.contains("has-context"));
  editOf(0).fire("click");
  view.sync();
  assert.equal($(".chat-input").value, "hello");
  type("Escape");
  view.sync();
  assert.equal($(".chat-input").value, "");
  assert.equal(view.el.find(".editing").length, 0);
  assert.ok(!$(".chat-body").classList.contains("has-context"), "nothing attached once the edit is left");

  editOf(0).fire("click");
  view.sync();
  $(".chip-row").querySelector(".chip-remove").fire("click");
  view.sync();
  assert.equal(view.el.find(".editing").length, 0);
});

test("an edit sent mid-answer stops that answer, then replaces the question", async () => {
  const pending = heldAnswers();
  await ask("hello");
  assert.equal(rows()[0].find(".msg-edit").length, 1, "Edit stays while the answer is written");
  assert.equal(rows()[0].find(".msg-retry").length, 0, "Retry waits for the answer to end");
  editOf(0).fire("click");
  view.sync();
  assert.ok(!$(".send-btn").classList.contains("stop"), "the button sends the edit");
  $(".chat-input").value = "hello again";
  $(".send-btn").fire("click");
  await flush();
  assert.equal(sent("chat_stop").length, 1, "the answer is stopped first");
  assert.equal(sent("chat_send").length, 1);
  pending[0]({ text: "", stopped: true, turns: 0 });
  await flush();
  await flush();
  await flush();
  assert.deepEqual(sent("chat_send").map((a) => a.query), ["hello", "hello again"]);
  assert.deepEqual(State.chatHistory.map((m) => m.content), ["hello again"]);
  pending[1]({ text: "hi", turns: 2 });
  await flush();
  assert.deepEqual(State.chatHistory.map((m) => m.content), ["hello again", "hi"]);
});

// ── Mid-answer ────────────────────────────────────────────────────────────────

test("mid-answer every control stays usable", async () => {
  State.settings = { ...State.settings, chatProvider: "claude-code" };
  view.sync();
  heldAnswers();
  await ask("a long task");
  for (const b of view.el.find(".tool-btn")) assert.ok(!b.disabled, `${b.getAttribute("title") ?? b.className} works`);
  assert.ok(!$(".model-btn").disabled);
  assert.ok(!$(".perm-btn").disabled);

  // The shield changes the mode for the next message.
  $(".perm-btn").fire("click");
  assert.ok($(".chat-body").classList.contains("authorizing"));
  view.el.find(".perm-row")[1].fire("click");
  assert.equal(sent("chat_permissions").at(-1).permissionMode, "auto");

  // Past chats and the attachments open.
  view.el.find(".tool-btn").find((b) => b.getAttribute("title") === "Past chats").fire("click");
  assert.ok($(".chat-body").classList.contains("browsing"));
  $(".files-btn").fire("click");
  assert.ok($(".chat-body").classList.contains("filing"));

  // A file added now waits for the next question; its × takes it back.
  State.droppedFile = { name: "next.pdf", path: "/inbox/next.pdf" };
  view.sync();
  assert.equal($(".tool-badge").textContent, "1");
  $(".files-list").find(".attach-remove")[0].fire("click");
  view.sync();
  assert.equal(State.droppedFile, null);
});

test("moving to another chat mid-answer leaves it answering; it lands in its own chat", async (t) => {
  if (!globalThis.localStorage) {
    t.after(() => delete globalThis.localStorage);
    const mem = new Map();
    globalThis.localStorage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };
  }
  const { deleteChat, loadChats } = await import("../src/core/chats.ts");
  const pending = heldAnswers();
  await ask("write a poem");
  const first = State.chatId;
  assert.ok(loadChats().some((c) => c.id === first), "found in Past chats while it is answered");
  emit("chat-delta", { chat: first, text: "Roses" });

  // New chat: nothing is stopped, the new one is empty and can ask at once.
  view.el.find(".tool-btn").find((b) => b.getAttribute("title") === "New chat").fire("click");
  view.sync();
  assert.notEqual(State.chatId, first);
  assert.deepEqual(sent("chat_reset"), [{ chatId: State.chatId }]);
  assert.equal(sent("chat_stop").length, 0);
  assert.equal(State.chatHistory.length, 0);
  assert.equal($(".typing"), null);
  assert.equal(view.el.find(".reply").length, 0);
  assert.ok(!$(".send-btn").classList.contains("stop"), "this chat is not answering");
  emit("chat-delta", { chat: first, text: "Roses are red" });
  assert.equal(view.el.find(".reply").length, 0, "the other chat's text stays in it");

  // Asked here, while the first one is still written.
  await ask("what time is it?");
  const second = State.chatId;
  assert.deepEqual(sent("chat_send").map((a) => [a.chatId, a.query]), [[first, "write a poem"], [second, "what time is it?"]]);

  // Back to the first: its text so far, still coming.
  const historyBtn = view.el.find(".tool-btn").find((b) => b.getAttribute("title") === "Past chats");
  historyBtn.fire("click");
  view.el.find(".history-row").find((r) => r.getAttribute("title") === "write a poem").fire("click");
  view.sync();
  assert.equal(State.chatId, first);
  assert.equal(sent("chat_restore").length, 0, "Rust still has it");
  assert.equal(view.el.find(".reply")[0].textContent, "Roses are red");
  assert.ok($(".send-btn").classList.contains("stop"));

  // The second answer lands in its own chat, off screen.
  pending[1]({ text: "Noon.", turns: 2 });
  await flush();
  view.sync();
  assert.deepEqual(State.chatHistory.map((m) => m.content), ["write a poem"]);
  assert.deepEqual(loadChats().find((c) => c.id === second).turns.map((t) => t.content), ["what time is it?", "Noon."]);
  assert.equal(State.stateOverride, "thinking", "the first one is still being written");

  pending[0]({ text: "Roses are red, violets are blue.", turns: 2 });
  await flush();
  view.sync();
  assert.deepEqual(State.chatHistory.map((m) => m.content), ["write a poem", "Roses are red, violets are blue."]);
  assert.equal(loadChats().find((c) => c.id === first).turns.length, 2);
  assert.ok(!$(".send-btn").classList.contains("stop"));
  for (const id of [first, second]) deleteChat(id);
});

// ── What the answer is doing ──────────────────────────────────────────────────

const { activityLabel, firstActivity, timedLabel } = await import("../src/views/chat.ts");
const label = () => $(".typing-label")?.textContent ?? null;

test("while Claude Code works, the dots say what it does, and come back after some text", async () => {
  State.settings = { ...State.settings, chatProvider: "claude-code" };
  State.droppedFile = { name: "report.pdf", path: "/inbox/report.pdf" };
  const pending = heldAnswers();
  await ask("what does it say?");
  assert.ok($(".typing"), "the dots stay");
  assert.equal(label(), "Thinking…", "Claude Code says for itself what it reads");

  emit("chat-activity", { chat: State.chatId, activity: { kind: "read", detail: "report.pdf" } });
  assert.equal(label(), "Reading report.pdf");
  view.sync(); // an update mid-answer keeps the line
  assert.equal(label(), "Reading report.pdf");

  emit("chat-delta", { chat: State.chatId, text: "Let me check one thing." });
  assert.equal($(".typing"), null, "the text shows instead");
  assert.equal(label(), null);

  emit("chat-activity", { chat: State.chatId, activity: { kind: "command", detail: "" } });
  assert.equal(label(), "Running a command", "back to its tools: the dots come back");
  assert.ok(rows().at(-1).querySelector(".typing"), "under what was written");
  assert.equal(view.el.find(".reply").length, 1);
  emit("chat-activity", { chat: State.chatId, activity: { kind: "edit", detail: "main.rs" } });
  assert.equal(view.el.find(".typing").length, 1, "one line, updated in place");
  assert.equal(label(), "Editing main.rs");

  emit("chat-delta", { chat: State.chatId, text: "Done: main.rs is fixed." });
  assert.equal(label(), null);
  assert.equal(view.el.find(".reply")[0].textContent, "Done: main.rs is fixed.");

  pending[0]({ text: "Done: main.rs is fixed.", turns: 2 });
  await flush();
  view.sync();
  assert.equal(label(), null);
  emit("chat-activity", { chat: State.chatId, activity: { kind: "read", detail: "late.txt" } });
  assert.equal(label(), null, "nothing after the answer");
});

test("the other providers show the file first, then Thinking…", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  State.settings = { ...State.settings, chatProvider: "openai" };
  State.droppedFile = { name: "report.pdf", path: "/inbox/report.pdf" };
  const pending = heldAnswers();
  $(".chat-input").value = "summary?";
  type("Enter");
  await tick();
  await tick();
  view.sync();
  assert.equal(label(), "Reading report.pdf");
  t.mock.timers.tick(1200);
  assert.equal(label(), "Thinking…");

  pending[0]({ text: "It is a report.", turns: 2 });
  await tick();
  view.sync();
  assert.equal(label(), null);

  // The next question has no file: Thinking… from the start.
  heldAnswers();
  $(".chat-input").value = "more?";
  type("Enter");
  await tick();
  await tick();
  view.sync();
  assert.equal(label(), "Thinking…");
});

test("Unsloth Studio still starting: the chat says so with the picker's seconds, not Thinking…", async () => {
  State.settings = { ...State.settings, chatProvider: "unsloth" };
  const pending = heldAnswers();
  await ask("Ciao");
  // The model picker started it 15 s ago: the question waits for that start.
  emit("chat-activity", { chat: State.chatId, activity: { kind: "starting", detail: "15" } });
  assert.equal(label(), "Starting Unsloth Studio… 15 s");
  emit("chat-activity", { chat: State.chatId, activity: { kind: "starting", detail: "16" } });
  assert.match(label(), /^Starting Unsloth Studio… 1[56] s$/, "one line, its seconds going on");
  assert.equal(view.el.find(".typing").length, 1);
  // Ready: what the model does next, from 0.
  emit("chat-activity", { chat: State.chatId, activity: { kind: "prompt", detail: "" } });
  assert.equal(label(), "Processing the prompt…");
  pending[0]({ text: "Ciao!", turns: 2 });
  await flush();
  view.sync();
});

test("a CLI that thinks without a word: the seconds move on the closed island from the question on, and rest while it hides", async (t) => {
  // agy sends no activity while it thinks: nothing but the question starts the seconds.
  State.settings = { ...State.settings, chatProvider: "antigravity-cli" };
  State.mode = "compact";
  const pending = heldAnswers();
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
  try {
    await ask("think hard");
    const island = () => State.chatActivity?.label ?? null;
    assert.equal(island(), "Thinks…");
    t.mock.timers.tick(5000);
    assert.equal(island(), "Thinks… 5 s", "no chat-activity came, the seconds still go on");
    assert.equal(label(), "Thinking… 5 s");
    t.mock.timers.tick(115_000);
    assert.equal(island(), "Thinks… 120 s");
    t.mock.timers.tick(30_000);
    assert.equal(island(), "Thinks… 150 s", "past 120 s too");

    // Hidden: nothing ticks (0 % CPU); shown again, the seconds are where they are at once.
    State.mode = "hidden";
    State.notify();
    t.mock.timers.tick(10_000);
    assert.equal(island(), "Thinks… 150 s", "nothing redrawn while hidden");
    State.mode = "compact";
    State.notify();
    await Promise.resolve();
    assert.equal(island(), "Thinks… 160 s");
    t.mock.timers.tick(1000);
    assert.equal(island(), "Thinks… 161 s");
  } finally {
    t.mock.timers.reset();
    pending[0]({ text: "Done.", turns: 2 });
    await flush();
    State.mode = "hidden";
    view.sync();
  }
  assert.equal(State.chatActivity, null, "the answer came: nothing on the closed island");
});

test("each activity has its words, with a file name, a host or a tool", () => {
  const cases = [
    [{ kind: "thinking", detail: "" }, "Thinking…"],
    [{ kind: "read", detail: "report.pdf" }, "Reading report.pdf"],
    [{ kind: "read", detail: "example.com" }, "Reading example.com"],
    [{ kind: "read", detail: "" }, "Reading a file"],
    [{ kind: "search", detail: "**/*.pdf" }, "Searching for **/*.pdf"],
    [{ kind: "search", detail: "" }, "Searching the folder"],
    [{ kind: "command", detail: "" }, "Running a command"],
    [{ kind: "edit", detail: "main.rs" }, "Editing main.rs"],
    [{ kind: "edit", detail: "" }, "Editing a file"],
    [{ kind: "web", detail: "" }, "Searching the web"],
    [{ kind: "subtask", detail: "" }, "Working on a sub-task"],
    [{ kind: "plan", detail: "" }, "Planning"],
    [{ kind: "screen", detail: "" }, "Looking at the screen"],
    [{ kind: "tool", detail: "create issue (github)" }, "Using create issue (github)"],
    [{ kind: "tool", detail: "" }, "Thinking…"],
    // A local model: its server started by Lumo (Unsloth Studio), loading it
    // (with how far, when the server tells), then reading the prompt.
    [{ kind: "starting", detail: "3" }, "Starting Unsloth Studio…"],
    [{ kind: "loading", detail: "" }, "Loading the model…"],
    [{ kind: "loading", detail: "42" }, "Loading the model: 42%"],
    [{ kind: "loading", detail: "<b>" }, "Loading the model…"],
    [{ kind: "prompt", detail: "" }, "Processing the prompt…"],
    // What a local model is doing (lumo-local's Doing), in every provider's words.
    [{ kind: "reasoning", detail: "" }, "Thinking…"],
    [{ kind: "calling", detail: "workspace edit" }, "Using workspace edit"],
    [{ kind: "calling", detail: "" }, "Thinking…"],
    [{ kind: "retry", detail: "2/3" }, "Anthropic stopped the answer: trying again (2 of 3)…"],
    [{ kind: "retry", detail: "" }, "Thinking…"],
    [{ kind: "correcting", detail: "written" }, "It wrote the tool instead of using it: asking again…"],
    [{ kind: "correcting", detail: "done" }, "It said it was done without doing it: asking again…"],
    [{ kind: "correcting", detail: "stopped" }, "It stopped halfway: asking again…"],
    [{ kind: "something new", detail: "x" }, "Thinking…"],
    [null, "Thinking…"],
  ];
  for (const [activity, words] of cases) assert.equal(activityLabel(activity), words, JSON.stringify(activity));

  // The seconds it has been at it, from 2 s on, the same for every provider; tools aren't timed.
  const prompt = { kind: "prompt", detail: "" };
  assert.equal(timedLabel("Processing the prompt…", "lmstudio", prompt, 0, 14_500), "Processing the prompt… 14 s");
  assert.equal(timedLabel("Processing the prompt…", "lmstudio", prompt, 0, 1_500), "Processing the prompt…");
  assert.equal(timedLabel("Thinking…", "anthropic", { kind: "thinking", detail: "" }, 0, 9_000), "Thinking… 9 s");
  assert.equal(timedLabel("Starting Unsloth Studio…", "unsloth", { kind: "starting", detail: "6" }, 0, 6_200), "Starting Unsloth Studio… 6 s");
  assert.equal(timedLabel("Thinking…", "claude-code", { kind: "thinking", detail: "" }, 0, 9_000), "Thinking… 9 s");
  assert.equal(timedLabel("Using x", "ollama", { kind: "calling", detail: "x" }, 0, 9_000), "Using x");

  const file = { kind: "file", name: "a.pdf", path: "/inbox/a.pdf" };
  const shots = { windows: [], shots: [{ name: "Screen 1", path: "/inbox/s.png" }] };
  assert.deepEqual(firstActivity("anthropic", file, shots), { kind: "screen", detail: "" }, "the screen first");
  assert.deepEqual(firstActivity("ollama", file, null), { kind: "read", detail: "a.pdf" });
  assert.deepEqual(firstActivity("google", null, { windows: [], shots: [] }), { kind: "thinking", detail: "" });
  assert.deepEqual(firstActivity("claude-code", file, shots), { kind: "thinking", detail: "" }, "Claude Code says for itself");
  assert.deepEqual(firstActivity("antigravity-cli", file, shots), { kind: "thinking", detail: "" }, "so does Antigravity CLI");
});

test("Lumo shows the chat's answer: working while it is written, then done or wrong for a moment", async (t) => {
  const { settle, SETTLE_MS } = await import("../src/views/chat.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    State.stateOverride = "thinking";
    assert.equal(State.shownState, "thinking");
    settle("finished");
    assert.equal(State.shownState, "finished");
    t.mock.timers.tick(SETTLE_MS - 1);
    assert.equal(State.stateOverride, "finished");
    t.mock.timers.tick(1);
    assert.equal(State.stateOverride, null);
    // A newer answer is not cut short by the older one's timer.
    settle("error");
    t.mock.timers.tick(SETTLE_MS / 2);
    settle("error");
    t.mock.timers.tick(SETTLE_MS / 2);
    assert.equal(State.stateOverride, "error");
    t.mock.timers.tick(SETTLE_MS / 2);
    assert.equal(State.stateOverride, null);
    // A stopped answer just goes back.
    State.stateOverride = "thinking";
    settle(null);
    assert.equal(State.stateOverride, null);
  } finally {
    State.stateOverride = null;
    t.mock.timers.reset();
  }
});

test("deleting the chat on screen closes it: an empty chat takes its place", async () => {
  const { loadChats, saveChat } = await import("../src/core/chats.ts");
  const deleted = [];
  view = buildPrompt(() => {}, undefined, undefined, undefined, (id) => deleted.push(id));
  if (!globalThis.localStorage) {
    const mem = new Map();
    globalThis.localStorage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
    };
  }
  const turns = [{ role: "user", content: "hi" }];
  saveChat({ id: "other", title: "Other", updatedAt: 1, provider: "claude-code", session: null, turns });
  saveChat({ id: "open", title: "Open", updatedAt: 2, provider: "claude-code", session: null, turns });
  State.chatId = "open";
  State.chatHistory = [{ id: 1, role: "user", content: "hi" }];
  view.sync();
  const historyBtn = view.el.find(".tool-btn").find((b) => b.getAttribute("title") === "Past chats");
  historyBtn.fire("click");
  const rows = () => view.el.find(".history-row");
  const deleteOf = (title) => rows().find((r) => r.getAttribute("title") === title).find(".history-delete")[0];

  deleteOf("Other").fire("click");
  assert.equal(State.chatId, "open", "another chat: the one on screen stays");
  assert.ok($(".chat-body").classList.contains("browsing"));

  deleteOf("Open").fire("click");
  assert.notEqual(State.chatId, "open");
  assert.equal(State.chatHistory.length, 0);
  assert.ok(!$(".chat-body").classList.contains("browsing"), "the list closes on the new chat");
  assert.deepEqual(loadChats().map((c) => c.id), []);
  assert.deepEqual(deleted, ["other", "open"], "each deleted chat's plans go too");
});

test("the folder beside the past chats holds what is attached, its badge says how many", () => {
  const badge = $(".tool-badge");
  const names = () => $(".files-list").find(".attach-row").map((r) => r.find(".attach-name")[0].textContent);
  assert.equal(badge.textContent, "", "nothing attached: no number");
  assert.equal($(".files-list").find(".files-empty").length, 1, "says what it is for");
  State.droppedFile = { name: "notes.pdf", path: "C:\\Lumo\\inbox\\notes.pdf" };
  view.sync();
  assert.equal(badge.textContent, "1");
  assert.equal($(".chip-row").find(".chip").length, 0, "no longer above the chat");
  assert.deepEqual(names(), ["notes.pdf"]);
  assert.equal($(".files-list").find(".attach-detail")[0].textContent, "File · PDF");
  assert.equal($(".files-clear").hidden, true, "Remove all only for several");
  $(".files-btn").fire("click");
  assert.ok($(".chat-body").classList.contains("filing"));
  $(".files-list").find(".attach-remove")[0].fire("click");
  view.sync();
  assert.equal(badge.textContent, "");
  assert.deepEqual(names(), []);
});

test("Remove all empties the attachments, and a file that already went is not listed", async () => {
  const badge = $(".tool-badge");
  State.droppedFile = { name: "a.pdf", path: "C:\\Lumo\\inbox\\a.pdf" };
  State.moreFiles = [{ name: "b.txt", path: "C:\\Lumo\\inbox\\b.txt" }];
  view.sync();
  assert.equal(badge.textContent, "2");
  assert.equal($(".files-count").textContent, "2");
  assert.equal($(".files-clear").hidden, false);
  $(".files-clear").fire("click");
  view.sync();
  assert.equal(State.droppedFile, null);
  assert.deepEqual(State.moreFiles, []);
  assert.equal(badge.textContent, "");
  assert.equal($(".files-list").find(".attach-row").length, 0);

  // Sent with a question, the file is the chat's: nothing waits any more.
  State.droppedFile = { name: "a.pdf", path: "C:\\Lumo\\inbox\\a.pdf", sent: true };
  view.sync();
  assert.equal(badge.textContent, "");
  assert.equal($(".files-list").find(".attach-row").length, 0);
  State.droppedFile = null;
});

// ── The commands' menu ("/") ──────────────────────────────────────────────────

const commanding = () => $(".chat-body").classList.contains("commanding");
const slashNames = () => view.el.find(".slash-name").map((n) => n.textContent);

/** Text typed in the field, as the browser tells the view. */
function typeText(value) {
  const input = $(".chat-input");
  input.value = value;
  input.fire("input");
}

test("the commands' menu opens as soon as / is typed first, and filters", () => {
  typeText("hello /");
  assert.ok(!commanding(), "only with / first");
  typeText("/");
  assert.ok(commanding());
  assert.ok(slashNames().includes("new"));
  typeText("/ti");
  assert.deepEqual(slashNames(), ["timer"]);
  typeText("/timer ");
  assert.ok(!commanding(), "a space: what follows is the command's");
  typeText("/zzz");
  assert.ok(!commanding(), "nothing matches");
});

test("a press on the field reopens the menu only once the field had lost the focus", () => {
  const input = $(".chat-input");
  input.fire("focus");
  typeText("/");
  assert.ok(commanding());
  input.fire("blur"); // a press elsewhere
  assert.ok(!commanding());
  input.fire("mousedown");
  input.fire("focus");
  input.fire("click");
  assert.ok(commanding(), "back in the field: it reopens");
  // Closed by a press on the field itself (the document's press), it stays closed.
  view.el.find(".slash-row"); // still drawn
  $(".chat-body").classList.remove("commanding");
  input.fire("mousedown");
  input.fire("click");
  assert.ok(!commanding(), "the field still had the focus");
});

test("Enter runs the highlighted command: Lumo's here, Claude Code's sent as typed", async () => {
  typeText("/new");
  const before = State.chatId;
  const enter = type("Enter");
  assert.ok(enter.defaultPrevented);
  assert.ok(!commanding());
  assert.equal($(".chat-input").value, "");
  assert.notEqual(State.chatId, before, "a new chat");
  assert.deepEqual(sent("chat_send"), [], "nothing went to the AI");

  State.settings = { ...State.settings, chatProvider: "claude-code" };
  answers.chat_send = { text: "Context: 12%", turns: 2 };
  typeText("/cont");
  assert.deepEqual(slashNames(), ["context"]);
  type("Enter");
  await flush();
  await flush();
  assert.equal(sent("chat_send").at(-1).query, "/context");
});

test("Tab writes the command's name for what follows; arrows move; Escape closes", () => {
  State.settings = { ...State.settings, chatProvider: "claude-code" };
  emit("chat-commands", ["compact", "review"]);
  typeText("/rev");
  assert.deepEqual(slashNames(), ["review"]);
  type("Tab");
  assert.equal($(".chat-input").value, "/review ");
  assert.ok(!commanding());

  typeText("/");
  const on = () => view.el.find(".slash-row").findIndex((r) => r.classList.contains("on"));
  assert.equal(on(), 0);
  type("ArrowDown");
  assert.equal(on(), 1);
  type("ArrowUp");
  type("ArrowUp");
  assert.equal(on(), slashNames().length - 1, "it goes round");
  const esc = type("Escape");
  assert.ok(esc.defaultPrevented);
  assert.ok(!commanding());
});

test("/new typed in full and sent is Lumo's too", async () => {
  $(".chat-input").value = "/new";
  type("Enter");
  await flush();
  assert.deepEqual(sent("chat_send"), []);
});

test("a tool's command is in the menu, and what follows it goes to the AI as a request to use that tool", async () => {
  State.tools = [{ id: "pdfcraft_mcp", name: "pdfcraft_mcp", command: "pdfcraft", enabled: true, reviewed: true, params: [{ name: "path" }] }];
  answers.chat_send = { text: "Done.", turns: 2 };
  typeText("/pdf");
  assert.deepEqual(slashNames(), ["pdfcraft"]);
  type("Enter");
  assert.equal($(".chat-input").value, "/pdfcraft ", "a tool with parameters waits for what to do");
  $(".chat-input").value = "/pdfcraft merge the two PDFs";
  type("Enter");
  await flush();
  await flush();
  const sentQuery = sent("chat_send").at(-1).query;
  assert.match(sentQuery, /^Use my Lumo tool "pdfcraft_mcp" \(tool id: pdfcraft_mcp\) for this\.\n\nmerge the two PDFs$/);
  assert.equal(State.chatHistory[0].content, "/pdfcraft merge the two PDFs", "the chat shows what was typed");

  // A local model its server says takes no tools.
  answers.local_caps = { vision: false, tools: false, reasoning: [], maxContext: 0, loadedContext: 0 };
  State.settings = { ...State.settings, chatProvider: "ollama", chatModels: { ...State.settings.chatModels, ollama: "m" } };
  State.notify();
  await flush();
  await flush();
  setLocalCaps("ollama", answers.local_caps);
  typeText("/pdf");
  assert.ok(!commanding(), "a model that can't use the tools doesn't list them");
  delete answers.local_caps;
  setLocalCaps("ollama", null);
  State.tools = [];
});

test("State.activeChats tracks live chat turns from Thinking through Writes and holds Done briefly", async () => {
  State.settings = { ...State.settings, chatProvider: "unsloth", chatModels: { ...State.settings.chatModels, unsloth: "qwen3-8b" } };
  const pending = heldAnswers();
  await ask("Check my GitHub PRs");
  assert.equal(State.activeChats.length, 1);
  assert.equal(State.activeChats[0].chatId, State.chatId);
  assert.equal(State.activeChats[0].title, "Check my GitHub PRs");
  assert.equal(State.activeChats[0].line, "Thinking…");

  emit("chat-activity", { chat: State.chatId, activity: { kind: "tool", detail: "GitHub" } });
  assert.equal(State.activeChats[0].line, "Using GitHub");

  emit("chat-delta", { chat: State.chatId, text: "Here are your open PRs:" });
  assert.equal(State.activeChats[0].line, "Writes…");

  pending[0]({ text: "Here are your open PRs: #21.", turns: 2 });
  await flush();
  view.sync();
  assert.equal(State.activeChats.length, 1);
  assert.equal(State.activeChats[0].line, "Done");
  assert.equal(State.activeChats[0].done, true);
});



test("an agent that answered nothing goes back to Rust as no answer, not as Lumo's words", () => {
  const shown = { role: "assistant", content: "Codex gave no answer.", kept: "(No answer.)" };
  assert.deepEqual(conversationTurn(shown), { role: "assistant", content: "(No answer.)" });
  assert.deepEqual(conversationTurn({ role: "user", content: "Ciao", at: 1 }), { role: "user", content: "Ciao" });
});

// ── Chat names (chat_title.rs) ────────────────────────────────────────────────

/** A storage of its own for Past chats, as the webview has. */
function freshStorage() {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}

async function askNamed(text) {
  $(".chat-input").value = text;
  $(".send-btn").fire("click");
  await flush();
  await flush();
  view.sync();
}

test("once the first answer is in, the chat's AI names it, and the pencil renames it for good", async () => {
  freshStorage();
  const { loadChats } = await import("../src/core/chats.ts");
  State.chatId = "named-chat";
  answers.chat_send = { text: "Set the toolchain first." };
  answers.chat_title = "Lumo's build on Windows";
  await askNamed("how do I set up the build of Lumo on Windows?");
  assert.deepEqual(sent("chat_title"), [{
    provider: "anthropic",
    model: "claude-opus-5-5",
    exchanges: [["how do I set up the build of Lumo on Windows?", "Set the toolchain first."]],
    light: true,
  }]);
  assert.equal(loadChats().find((c) => c.id === "named-chat").title, "Lumo's build on Windows");

  // Named once: the next answer asks nothing.
  await askNamed("and the hook?");
  assert.equal(sent("chat_title").length, 1);
  assert.equal(loadChats().find((c) => c.id === "named-chat").title, "Lumo's build on Windows", "saved again, the name stays");

  // The pencil: the name in a field, Enter keeps what is typed.
  view.el.find(".tool-btn").find((b) => b.getAttribute("title") === "Past chats").fire("click");
  const row = () => view.el.find(".history-row").find((r) => r.getAttribute("title") === "Lumo's build on Windows");
  row().find(".history-rename")[0].fire("click");
  const field = $(".history-rename-input");
  assert.equal(field.value, "Lumo's build on Windows");
  field.value = "My build notes";
  field.fire("keydown", { key: "Escape" });
  assert.equal($(".history-rename-input"), null, "Esc: back to the row");
  assert.equal(loadChats().find((c) => c.id === "named-chat").title, "Lumo's build on Windows", "Esc keeps the name");
  row().find(".history-rename")[0].fire("click");
  $(".history-rename-input").value = "My build notes";
  $(".history-rename-input").fire("keydown", { key: "Enter" });
  const saved = loadChats().find((c) => c.id === "named-chat");
  assert.equal(saved.title, "My build notes");
  assert.equal(saved.named, "user");
  assert.ok(view.el.find(".history-row").some((r) => r.getAttribute("title") === "My build notes"));
});

test("a question of a word waits for the second answer; off in Settings, nothing is asked", async () => {
  freshStorage();
  State.chatId = "short-chat";
  answers.chat_send = { text: "Hi! How can I help?" };
  await askNamed("hi");
  assert.deepEqual(sent("chat_title"), [], "too little to go on");
  answers.chat_send = { text: "Three ideas." };
  await askNamed("ideas for Marta's birthday");
  assert.deepEqual(sent("chat_title").map((a) => a.exchanges), [[["hi", "Hi! How can I help?"], ["ideas for Marta's birthday", "Three ideas."]]]);

  calls.length = 0;
  State.chatId = "off-chat";
  State.settings = { ...State.settings, chatAiTitles: false };
  await askNamed("how do I set up the build of Lumo on Windows?");
  assert.deepEqual(sent("chat_title"), []);
});

test("the model for names: the chat's own when Settings says so; a name that doesn't come is asked once more", async () => {
  freshStorage();
  const { loadChats } = await import("../src/core/chats.ts");
  State.chatId = "retry-chat";
  State.settings = { ...State.settings, chatTitleModel: "chat" };
  answers.chat_send = { text: "Here it is." };
  answers.chat_title = null;
  await askNamed("summarise the March invoice for me");
  await askNamed("and the April one?");
  await askNamed("thanks a lot");
  assert.deepEqual(sent("chat_title").map((a) => a.light), [false, false], "twice at most");
  assert.equal(loadChats().find((c) => c.id === "retry-chat").title, "summarise the March invoice for me", "no name: the first question");
});
