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
  assert.deepEqual(rows().map((r) => r.querySelector(".picker-model-name").textContent), ["Ask every time", "Auto", "Plan only"]);
  assert.ok(rows()[0].classList.contains("on"));

  rows()[1].fire("click");
  assert.equal(State.settings.chatPermissionMode, "auto");
  assert.equal(sent("save_settings").at(-1).settings.chatPermissionMode, "auto");
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
  assert.deepEqual(chips(), ["Anthropic", "Claude Code", "Antigravity CLI", "Codex", "Google", "OpenAI", "OpenRouter"]);
  assert.deepEqual(sent("secret_present"), [{ key: "anthropic-api-key" }]);
  assert.deepEqual(sent("chat_models"), []);
  assert.match($(".picker-status").textContent, /No API key/);
});

test("only the providers set up show: no Anthropic without its key", async () => {
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
  view.el.find(".picker-chip")[4].fire("click");
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

test("sending and the answer being written never scroll the chat", async () => {
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

  log.scrollTop = 900; // read at its end
  log.fire("scroll");
  log.scrollHeight = 1400;
  emit("chat-delta", { chat: State.chatId, text: "Once upon a time" });
  assert.equal(log.scrollTop, 900, "not even from the end of the chat");

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
const editOf = (i) => rows()[i].find(".msg-action")[1];

test("a message typed while the answer is written goes as soon as it ends", async () => {
  const pending = heldAnswers();
  await ask("tell me a story");
  const input = $(".chat-input");
  input.value = "and another";
  type("Enter");
  await flush();
  assert.equal(sent("chat_send").length, 1, "it waits");
  assert.equal(input.title, "Sent as soon as this answer ends");
  pending[0]({ text: "Once upon a time.", turns: 2 });
  await flush();
  await flush();
  assert.equal(sent("chat_send").length, 2, "then it goes");
  assert.equal(input.value, "");
  assert.equal(input.title, "");
});

test("while an answer is written, the field stays open and send is a Stop button", async () => {
  const pending = heldAnswers();
  await ask("tell me a story");
  const input = $(".chat-input");
  assert.ok(!input.disabled, "the next question can be typed meanwhile");
  assert.ok($(".send-btn").classList.contains("stop"));
  assert.equal($(".send-btn").title, "Stop");

  // Enter waits for the answer: nothing is sent yet, the text stays (and Stop keeps it there).
  input.value = "and another";
  type("Enter");
  await flush();
  assert.equal(sent("chat_send").length, 1);
  assert.equal(input.value, "and another");

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
  assert.equal(sent("chat_send").at(-1).context, null, "the later question's file doesn't go again");
  assert.deepEqual(chatFiles(State.chatId).map((f) => f.name), ["new.md"]);

  // Its ×: out of the list, and Rust tells the AI with the next question.
  const row = view.el.find(".chat-files-list")[0].find(".attach-row")[0];
  row.find(".attach-remove")[0].fire("click");
  assert.deepEqual(sent("chat_forget_file").at(-1), { chatId: State.chatId, name: "new.md", path: String.raw`C:\Docs\new.md` });
  assert.deepEqual(chatFiles(State.chatId), []);
  assert.equal(view.el.find(".chat-files-list")[0].find(".attach-group").length, 0, "an empty kind shows no folder");
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
  assert.equal(rows()[0].find(".msg-action").length, 2, "Edit stays while the answer is written");
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
  assert.equal(State.settings.chatPermissionMode, "auto");

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

const { activityLabel, firstActivity } = await import("../src/views/chat.ts");
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

  State.settings = { ...State.settings, chatProvider: "ollama" };
  typeText("/pdf");
  assert.ok(!commanding(), "a provider that can't use the tools doesn't list them");
  State.tools = [];
});
