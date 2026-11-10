// The chat view (src/views/chat.ts) and the cards in its answers, on a fake
// DOM through the real bridge: what the user ticked in a checklist goes to
// the AI with the next real question once it went, never with a command the
// CLI runs; the quiz's "more questions" waits its turn like a question typed;
// and the user's own question shows no cards, as before them.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, internals, sent } from "./tauri.mjs";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

installFakeDom();
const { buildPrompt, plainQuestion } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { WORKSHOP_PREFIX } = await import("../src/core/tools.ts");

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
let chats = 0;
beforeEach(() => {
  calls.length = 0;
  answers = {};
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {} };
  State.chatId = `cards-${++chats}`;
  State.chatHistory = [];
  State.stateOverride = null;
  State.view = "prompt";
  State.droppedFile = null;
  State.chatSession = null;
  State.chatSlot = "chat";
  view = buildPrompt(() => {});
  view.sync();
});

const $ = (cls) => view.el.querySelector(cls);
const rows = () => view.el.find(".chat-row");

function type(key) {
  const event = { key, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
  for (const fn of $(".chat-input").listeners.get("keydown")) fn(event);
  return event;
}

async function ask(text) {
  $(".chat-input").value = text;
  type("Enter");
  await flush();
  await flush();
  view.sync();
}

/** The questions as they went to Rust. */
const queries = () => sent("chat_send").map((s) => s.query);

/** An answer with a list to tick, then a tick on its first line. */
async function tickedList() {
  answers.chat_send = { text: "Two steps:\n\n- [ ] a\n- [ ] b", turns: 2 };
  await ask("how?");
  const row = view.el.find(".rc-check-row")[0];
  row.fire("click", { target: row });
}

const NOTE = "Checklist: done: a. To do: b.";

test("a CLI command goes as typed; the ticks go with the next question instead", async () => {
  State.settings = { ...State.settings, chatProvider: "antigravity-cli" };
  view.sync();
  await tickedList();
  answers.chat_send = { text: "Usage: 12%", turns: 4 };
  await ask("/usage");
  assert.equal(queries().at(-1), "/usage", "agy still knows it as its command");
  answers.chat_send = { text: "ok", turns: 6 };
  await ask("next?");
  assert.equal(queries().at(-1), `next?\n\n${NOTE}`);
});

test("Claude Code's /compact gets no ticks for its instructions", async () => {
  State.settings = { ...State.settings, chatProvider: "claude-code" };
  view.sync();
  await tickedList();
  answers.chat_send = { text: "Compacted.", turns: 4 };
  await ask("/compact");
  assert.equal(queries().at(-1), "/compact");
});

test("the ticks are told once the question went: a failed or stopped one leaves them to tell", async () => {
  await tickedList();
  answers.chat_send = () => Promise.reject(new Error("offline"));
  await ask("next?");
  assert.equal(queries().at(-1), `next?\n\n${NOTE}`);
  answers.chat_send = { text: "", stopped: true, turns: 2 };
  await ask("again?");
  assert.equal(queries().at(-1), `again?\n\n${NOTE}`, "the failed one never reached the AI");
  answers.chat_send = { text: "ok", turns: 4 };
  await ask("once more?");
  assert.equal(queries().at(-1), `once more?\n\n${NOTE}`, "nor the one stopped before any text");
  await ask("and now?");
  assert.equal(queries().at(-1), "and now?", "told: not again");
});

test("in the tool workshop, the list ticked is the one drawn, not one in the tool's files", async () => {
  State.chatSlot = "forge";
  State.chatId = `${WORKSHOP_PREFIX}cards`;
  view.sync();
  answers.chat_send = {
    text: "Here it is.\n\n~~~lumo-file README.md\n- [ ] Install\n- [ ] Run\n~~~\n\nNext:\n\n- [ ] Save the tool\n- [ ] Try it",
    turns: 2,
  };
  await ask("make a tool");
  const shown = view.el.find(".rc-check-row");
  assert.equal(shown.length, 2);
  shown[0].fire("click", { target: shown[0] });
  answers.chat_send = { text: "ok", turns: 4 };
  await ask("next?");
  assert.equal(queries().at(-1), "next?\n\nChecklist: done: Save the tool. To do: Try it.");
});

/** Plays a one-question quiz to its end, then presses its "more questions". */
function moreQuestions(answer) {
  const card = answer.find(".rc-quiz")[0];
  card.find(".rc-quiz-stage").find((s) => s.classList.contains("on")).find(".rc-opt")[1].fire("click");
  card.find(".rc-quiz-why")[0].find("BUTTON")[0].fire("click");
  const more = card.find(".rc-quiz-btn").find((b) => /more questions/.test(b.textContent));
  assert.ok(more);
  more.fire("click");
}

test("the quiz's more questions wait above the field while an answer is written, what is typed left alone", async () => {
  answers.chat_send = { text: "```lumo-quiz Gain\n? Gain?\n- 1\n+ 2\n```", turns: 2 };
  await ask("quiz me");
  const pending = [];
  answers.chat_send = () => new Promise((resolve) => pending.push(resolve));
  await ask("and then?");
  $(".chat-input").value = "still typing";
  moreQuestions(rows()[1]);
  await flush();
  assert.equal(queries().length, 2, "it waits");
  assert.ok(!$(".chat-queue").hidden);
  assert.match($(".queue-text").textContent, /^Quiz me with 3 more questions/);
  assert.equal($(".chat-input").value, "still typing");
  pending[0]({ text: "Then this.", turns: 4 });
  await flush();
  await flush();
  assert.equal(queries().length, 3, "then it goes");
  assert.match(queries()[2], /^Quiz me with 3 more questions/);
});

test("while a question is edited, the quiz's more questions go nowhere", async () => {
  answers.chat_send = { text: "```lumo-quiz Gain\n? Gain?\n- 1\n+ 2\n```", turns: 2 };
  await ask("quiz me");
  rows()[0].find(".msg-action")[1].fire("click");
  view.sync();
  moreQuestions(rows()[1]);
  await flush();
  await flush();
  assert.equal(queries().length, 1);
  assert.equal(State.chatHistory.length, 2);
});

test("the user's own question shows no cards: a task list, an image, an alert and a diff stay as they were", async () => {
  answers.chat_send = { text: "ok", turns: 2 };
  const question = "Bug report:\n\n- [ ] step one\n- [x] step two\n\n![x](https://example.com/a.png)\n\n> [!WARNING]\n> hi\n\n```diff\n-a\n+b\n```";
  await ask(question);
  const bubble = rows()[0].querySelector(".bubble");
  assert.equal(bubble.find(".rc-card").length, 0);
  assert.equal(bubble.find(".rc-callout").length, 0);
  assert.equal(bubble.find(".rc-box").length, 0);
  assert.deepEqual(sent("web_image"), [], "an image in a question is never fetched");
  assert.deepEqual(bubble.find(".md-bullet").map((b) => b.textContent), ["•", "•"]);
  assert.equal(bubble.find(".md-quote").length, 1);
  assert.equal(bubble.find(".md-pre").length, 1);
  assert.equal(bubble.textContent.includes("[ ] step one"), true);
  assert.equal(bubble.textContent.includes("\u2060"), false, "the marks are taken back out of the drawn text");
  // What was written goes to the AI, and Copy and Edit take it, as it was.
  assert.equal(queries().at(-1), question);
  // The same lines in an answer are cards; in a code block they stay as written.
  assert.equal(plainQuestion("```md\n- [ ] a\n![x](https://e.com/a.png)\n```"), "```⁠md\n- [ ] a\n![x](https://e.com/a.png)\n```");
});
