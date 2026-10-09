// The chat view (src/views/chat.ts) on a fake DOM, through the real bridge:
// the model switcher asks for a provider's models only once it is picked and
// has a key, picking saves the settings, and a streamed answer grows in place.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, emit, internals, sent } from "./tauri.mjs";

installFakeDom();
const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");

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

test("Antigravity CLI needs no key, and has no effort to pick: its model's name carries it", async () => {
  State.settings = { ...State.settings, chatProvider: "antigravity-cli", chatEffort: "high" };
  view.sync();
  assert.equal($(".model-name").textContent, "default", "a saved effort never reaches agy");

  answers.chat_models = [{ id: "default", label: "Default" }, { id: "gemini-3.8-flash-low", label: "gemini-3.8-flash-low" }];
  $(".model-btn").fire("click");
  await flush();
  assert.deepEqual(sent("chat_models"), [{ provider: "antigravity-cli" }]);
  assert.deepEqual(models(), ["Default", "gemini-3.8-flash-low"]);
  assert.equal($(".picker-efforts").hidden, true);
  assert.equal($(".effort-slider"), null);
});

test("Claude Code's effort is a slider from faster to smarter, with Auto beside it", async () => {
  State.settings = { ...State.settings, chatProvider: "claude-code" };
  view.sync();
  $(".model-btn").fire("click");
  await flush();
  assert.equal($(".picker-efforts").hidden, false);
  assert.equal($(".effort-value").textContent, "Auto");
  assert.ok($(".effort-auto").classList.contains("on"));
  assert.ok($(".effort-track").classList.contains("auto"), "no knob while Auto");
  assert.equal($(".effort-slider").getAttribute("max"), "4", "low, medium, high, extra high, max");
  assert.equal($(".effort-ticks").children.length, 5);
  assert.deepEqual($(".effort-ends").children.map((c) => c.textContent), ["Faster", "Smarter"]);

  const slider = $(".effort-slider");
  slider.value = "4";
  slider.fire("change");
  assert.equal(State.settings.chatEffort, "max");
  assert.equal(sent("save_settings").at(-1).settings.chatEffort, "max");
  assert.equal($(".effort-value").textContent, "Max");
  assert.ok(!$(".effort-track").classList.contains("auto"));
  assert.equal($(".effort-slider").value, "4");

  $(".effort-auto").fire("click");
  assert.equal(State.settings.chatEffort, "");
  $(".model-btn").fire("click");
  State.settings = { ...State.settings, chatEffort: "xhigh" };
  view.sync();
  assert.equal($(".model-name").textContent, "default · Extra high");
});

test("the shield picks what Claude Code and Antigravity CLI may do without asking", () => {
  // The API providers run no tools: no shield.
  assert.equal($(".perm-btn").hidden, true);
  State.settings = { ...State.settings, chatProvider: "claude-code" };
  view.sync();
  const shield = $(".perm-btn");
  assert.equal(shield.hidden, false);
  assert.match(shield.title, /Ask every time/);
  assert.ok(!shield.classList.contains("lit"));

  shield.fire("click");
  assert.ok($(".chat-body").classList.contains("authorizing"));
  const rows = () => view.el.find(".perm-row");
  assert.deepEqual(rows().map((r) => r.querySelector(".picker-model-name").textContent), ["Ask every time", "Accept edits", "Plan only"]);
  assert.ok(rows()[0].classList.contains("on"));

  rows()[1].fire("click");
  assert.equal(State.settings.chatPermissionMode, "acceptEdits");
  assert.equal(sent("save_settings").at(-1).settings.chatPermissionMode, "acceptEdits");
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
  assert.deepEqual(chips(), ["Anthropic", "Claude Code", "Antigravity CLI", "Google", "OpenAI", "OpenRouter"]);
  assert.deepEqual(sent("secret_present"), [{ key: "anthropic-api-key" }]);
  assert.deepEqual(sent("chat_models"), []);
  assert.match($(".picker-status").textContent, /No API key/);
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
  view.el.find(".picker-chip")[3].fire("click");
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
  assert.ok($(".model-btn").disabled, "no switching mid-answer");
  assert.ok($(".typing"), "dots until the first visible text");

  emit("chat-delta", ""); // still thinking
  assert.ok($(".typing"));
  emit("chat-delta", "Hel");
  emit("chat-delta", "Hello **there**");
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

// ── Stop, copy, edit ──────────────────────────────────────────────────────────

/** A key typed in the chat field. */
function type(key) {
  const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
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

const rows = () => view.el.find(".chat-row");
const editOf = (i) => rows()[i].find(".msg-action")[1];

test("while an answer is written, the field stays open and send is a Stop button", async () => {
  const pending = heldAnswers();
  await ask("tell me a story");
  const input = $(".chat-input");
  assert.ok(!input.disabled, "the next question can be typed meanwhile");
  assert.ok($(".send-btn").classList.contains("stop"));
  assert.equal($(".send-btn").title, "Stop");

  // Enter waits for the answer: nothing is sent, the text stays.
  input.value = "and another";
  type("Enter");
  await flush();
  assert.equal(sent("chat_send").length, 1);
  assert.equal(input.value, "and another");

  emit("chat-delta", "Once upon");
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
  assert.equal(input.value, "and another", "the typed question is still there, ready to go");
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
    const questionActions = rows()[0].find(".msg-action");
    assert.equal(questionActions.length, 2, "Copy and Edit on a question");
    questionActions[0].fire("click");
    const answerActions = rows()[1].find(".msg-action");
    assert.equal(answerActions.length, 1, "Copy only on an answer");
    answerActions[0].fire("click");
    await flush();
    assert.deepEqual(copied, ["how?", "Use **bold** and `code`."]);
  } finally {
    delete globalThis.navigator.clipboard;
  }
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
  assert.deepEqual(sent("chat_rewind"), [{ keep: 2 }]);
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
  assert.deepEqual(sent("chat_rewind").at(-1), { keep: 0 });
  assert.equal(sent("chat_send").at(-1).query, "one");
  assert.equal(sent("chat_send").at(-1).context?.name, "a.pdf");
  assert.deepEqual(State.chatHistory.map((m) => m.content), ["one", "answer 1"]);
});

test("Escape or the chip's × leaves an edit, and nothing is edited mid-answer", async () => {
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

  heldAnswers();
  await ask("more");
  assert.equal(rows()[0].find(".msg-action").length, 1, "Copy only while an answer is written");
});

// ── What the answer is doing ──────────────────────────────────────────────────

const { activityLabel, firstActivity } = await import("../src/views/chat.ts");
const label = () => $(".typing-label")?.textContent ?? null;

test("while Claude Code works, the dots say what it does, and come back after some text", async () => {
  State.settings = { ...State.settings, chatProvider: "claude-code" };
  State.droppedFile = { name: "report.pdf", path: "/inbox/report.pdf" };
  const pending = heldAnswers();
  await ask("what does it say?");
  assert.ok($(".typing"), "the dots stay");
  assert.equal(label(), "Thinking…", "Claude Code says for itself what it reads");

  emit("chat-activity", { kind: "read", detail: "report.pdf" });
  assert.equal(label(), "Reading report.pdf");
  view.sync(); // an update mid-answer keeps the line
  assert.equal(label(), "Reading report.pdf");

  emit("chat-delta", "Let me check one thing.");
  assert.equal($(".typing"), null, "the text shows instead");
  assert.equal(label(), null);

  emit("chat-activity", { kind: "command", detail: "" });
  assert.equal(label(), "Running a command", "back to its tools: the dots come back");
  assert.ok(rows().at(-1).querySelector(".typing"), "under what was written");
  assert.equal(view.el.find(".reply").length, 1);
  emit("chat-activity", { kind: "edit", detail: "main.rs" });
  assert.equal(view.el.find(".typing").length, 1, "one line, updated in place");
  assert.equal(label(), "Editing main.rs");

  emit("chat-delta", "Done: main.rs is fixed.");
  assert.equal(label(), null);
  assert.equal(view.el.find(".reply")[0].textContent, "Done: main.rs is fixed.");

  pending[0]({ text: "Done: main.rs is fixed.", turns: 2 });
  await flush();
  view.sync();
  assert.equal(label(), null);
  emit("chat-activity", { kind: "read", detail: "late.txt" });
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
    [{ kind: "something new", detail: "x" }, "Thinking…"],
    [null, "Thinking…"],
  ];
  for (const [activity, words] of cases) assert.equal(activityLabel(activity), words, JSON.stringify(activity));

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
