// The orchestra (src/views/orchestra.ts) in the chat, on a fake DOM, through
// the real bridge: a coordinator and its threads in the rail, the member on
// screen with the messages between members, a decision card answered by a
// click, what is typed going to the member on screen (and starting an
// orchestra when none is open), the answer streaming in under the member's
// chat id; and its entry in the model picker (src/views/chat-models.ts), with
// a row for each role and no CLI to pick for them.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, emit, internals, sent } from "./tauri.mjs";

installFakeDom();
const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { resolvePick, orchestraAllowed } = await import("../src/core/orchestra-picks.ts");

/** What the mocked Rust side answers, by command. */
let answers;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : structuredClone(answers[cmd]);
  return result;
};
const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

const LM = { provider: "lmstudio", model: "gemma-4-26b-a4b", effort: "medium" };
const OPUS = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
const card = {
  question: "Flag clause 9 as unusual?",
  options: [{ label: "Yes, flag it", consequence: "It goes in the report." }, { label: "No", consequence: "Reported as is." }],
  recommended: 0,
};
const member = (id, title, state, messages, extra = {}) => ({
  id, chat: `orc-o1-${id}`, title, task: "", pick: id === "coordinator" ? OPUS : LM, state, activity: null, plan: [], queued: 0, messages, ...extra,
});
const SNAP = {
  id: "o1", title: "Leases", created: 1, updated: 2,
  plan: [{ step: "Read the leases", status: "completed" }, { step: "Compare them", status: "in_progress" }],
  locks: [{ path: "Leases/summary.csv", member: "t1" }],
  coordinator: member("coordinator", "Coordinatore", "working", [
    { id: "c1", at: 1, kind: "user", from: "user", text: "Compare the leases" },
    { id: "c2", at: 2, kind: "assistant", from: "coordinator", text: "Here is the plan." },
    { id: "c3", at: 3, kind: "note", from: "t1", text: "Main St", note: "started" },
    { id: "c4", at: 4, kind: "relay", from: "t2", text: "4+4 years, 950 a month." },
    { id: "c5", at: 5, kind: "relay", from: "coordinator", to: "t1", text: "You keep the summary." },
    { id: "c6", at: 6, kind: "note", from: "t3", text: "Leases/summary.csv", note: "lock", holder: "t1" },
    { id: "c7", at: 7, kind: "card", from: "t3", text: "", card },
    { id: "c8", at: 8, kind: "file", from: "t2", text: "", file: { path: "Leases/report.md", name: "report.md", markdown: true } },
    { id: "c9", at: 9, kind: "user", from: "user", text: "Look at the fees too", delivered: "queued" },
  ], { activity: { kind: "talk", detail: "Main St" }, queued: 1 }),
  threads: [
    member("t1", "Main St", "working", [{ id: "a1", at: 1, kind: "relay", from: "coordinator", text: "Read main-st.pdf." }], { activity: { kind: "read", detail: "main-st.pdf" } }),
    member("t2", "Elm St", "done", [{ id: "b1", at: 1, kind: "relay", from: "coordinator", text: "Read elm-st.pdf." }, { id: "b2", at: 120_001, kind: "assistant", from: "t2", text: "Done." }]),
    member("t3", "Oak St", "waiting", [
      { id: "v1", at: 1, kind: "relay", from: "coordinator", text: "Read oak-st.pdf." },
      { id: "v2", at: 2, kind: "note", from: "t3", text: "Leases/summary.csv", note: "lock", holder: "t1" },
      { id: "v3", at: 3, kind: "relay", from: "t3", to: "t1", text: "My row for the summary." },
      { id: "v4", at: 4, kind: "user", from: "user", text: "Check the deposit too", delivered: "mid-turn" },
      { id: "c7", at: 7, kind: "card", from: "t3", text: "", card },
      { id: "v5", at: 8, kind: "user", from: "user", text: "1", note: "answer" },
    ]),
  ],
};

let view;
beforeEach(() => {
  calls.length = 0;
  answers = {
    orchestra_list: [{ id: "o1", title: "Leases", updated: 2, working: true }],
    orchestra_open: SNAP,
  };
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {}, lmstudioUrl: "http://127.0.0.1:1234", orchestraMode: true, orchestraCoordinator: OPUS, orchestraThread: LM };
  State.chatHistory = [];
  State.view = "prompt";
  State.chatSlot = "chat";
  view = buildPrompt(() => {});
  view.sync();
});

const $ = (cls) => view.el.querySelector(cls);
const texts = (cls) => view.el.find(cls).map((e) => e.textContent);
const item = (id) => view.el.find(".orc-item").find((e) => e.dataset?.member === id || e.getAttribute("data-member") === id);
async function typeAndSend(text) {
  const input = $(".chat-input");
  input.value = text;
  input.fire("keydown", { key: "Enter" });
  await flush();
}

test("the orchestra takes the chat's place: the last one opens on its coordinator", async () => {
  await flush();
  assert.ok($(".chat-body").classList.contains("orc"));
  assert.deepEqual(sent("orchestra_open"), [{ id: "o1" }]);
  assert.deepEqual(texts(".orc-item-title"), ["Coordinator", "Main St", "Elm St", "Oak St"]);
  assert.ok(item("coordinator").classList.contains("on"));
  // Where each stands: at work with its step, done with its time, waiting for you with its card.
  assert.match(item("t1").querySelector(".orc-item-step").textContent, /^gemma-4-26b-a4b · .*main-st\.pdf/);
  assert.equal(item("t2").querySelector(".orc-item-step").textContent, "Finished in 2 min");
  assert.equal(item("t3").querySelector(".orc-item-step").textContent, "Waiting for you");
  assert.equal(item("t3").querySelector(".orc-badge").textContent, "1");
  // The header: its model, at work, its plan, Stop all.
  assert.equal($(".orc-head-title").textContent, "Coordinator");
  assert.equal($(".orc-plan-btn").textContent, "Plan 1/2");
  assert.equal($(".orc-stop").textContent, "Stop all");
  assert.equal($(".chat-input").placeholder, "Write to the coordinator…");
  assert.match($(".model-name").textContent, /^Coordinator · Opus 5\.5 → gemma-4-26b-a4b$/);
});

test("messages between members say who from and who to, grey; Lumo's notes say what happened", async () => {
  await flush();
  assert.deepEqual(texts(".orc-from"), ["From Elm St · finished", "To Main St"]);
  assert.deepEqual(texts(".orc-act"), ["Opened the thread Main St"]);
  assert.match($(".orc-lock").textContent, /Oak St wanted to change .*Leases\/summary\.csv.*Main St is working on it/);
  assert.match($(".orc-locks").textContent, /Leases\/summary\.csv.*Main St/);
  // The queued message waits above the field, not in the conversation.
  assert.equal($(".orc-queued").querySelector(".queue-text").textContent, "Look at the fees too");
  assert.ok(!texts(".bubble").some((t) => t.includes("fees")));
  // A click on "From Elm St" opens that thread.
  view.el.find(".orc-from")[0].fire("click");
  assert.equal($(".orc-head-title").textContent, "Elm St");
});

test("a card's option answers the member that asked, at once", async () => {
  await flush();
  const options = $(".orc-card").find(".orc-opt");
  assert.deepEqual(options.map((o) => o.querySelector(".orc-opt-label").textContent), ["Yes, flag itRecommended", "No"]);
  options[1].fire("click");
  await flush();
  assert.deepEqual(sent("orchestra_answer"), [{ id: "o1", member: "t3", message: "c7", choice: 1 }]);
  assert.ok($(".orc-card").classList.contains("answered"));
  assert.ok($(".orc-card").find(".orc-opt")[1].classList.contains("chosen"));
  // A second click answers nothing more.
  $(".orc-card").find(".orc-opt")[0].fire("click");
  assert.equal(sent("orchestra_answer").length, 1);
});

test("what is typed goes to the member on screen", async () => {
  await flush();
  await typeAndSend("How is it going?");
  assert.deepEqual(sent("orchestra_send"), [{ id: "o1", to: "coordinator", text: "How is it going?" }]);
  assert.equal($(".chat-input").value, "");
  assert.deepEqual(sent("chat_send"), [], "never the chat's own provider");

  item("t3").fire("click");
  view.sync();
  assert.equal($(".chat-input").placeholder, "Write to Oak St…");
  assert.equal($(".orc-stop").textContent, "Stop thread");
  // Its own chat: the coordinator's task, the lock in its words, what it sent, the user's line read mid-turn, the card.
  assert.deepEqual(texts(".orc-from"), ["From the coordinator", "To Main St"]);
  assert.match($(".orc-lock").textContent, /Main St.*is changing .*Leases\/summary\.csv.*your change was not made/);
  assert.match($(".orc-seen").textContent, /^Read while it worked · /);
  assert.equal($(".orc-card-foot").textContent, "Or write your answer below");
  assert.ok(!texts(".bubble").includes("1"), "the line answering a card is the card's");
  await typeAndSend("Yes, flag it");
  assert.deepEqual(sent("orchestra_send").at(-1), { id: "o1", to: "t3", text: "Yes, flag it" });

  $(".orc-stop").fire("click");
  await flush();
  assert.deepEqual(sent("orchestra_stop"), [{ id: "o1", member: "t3" }]);
});

test("with no orchestra open, the first message starts one", async () => {
  await flush();
  calls.length = 0;
  answers.orchestra_list = [];
  answers.orchestra_create = { ...SNAP, id: "o2", title: "", plan: [], locks: [], coordinator: member("coordinator", "Coordinatore", "idle", []), threads: [] };
  view = buildPrompt(() => {});
  view.sync();
  await flush();
  assert.deepEqual(sent("orchestra_open"), []);
  await typeAndSend("Plan my trip");
  assert.equal(sent("orchestra_create").length, 1);
  assert.deepEqual(sent("orchestra_send"), [{ id: "o2", to: "coordinator", text: "Plan my trip" }]);
  assert.ok(texts(".bubble").some((t) => t.includes("Plan my trip")), "shown at once");
});

test("a member's answer streams in under its chat id; the next update has it whole", async () => {
  await flush();
  item("t1").fire("click");
  emit("chat-delta", { chat: "orc-o1-t1", text: "The deposit is **three** months" });
  emit("chat-activity", { chat: "orc-o1-t1", activity: { kind: "edit", detail: "summary.csv" } });
  assert.match($(".orc-log").querySelector(".reply").textContent, /The deposit is three months/);
  assert.match($(".orc-now").textContent, /summary\.csv/);
  assert.match(item("t1").querySelector(".orc-item-step").textContent, /summary\.csv/);

  const next = structuredClone(SNAP);
  next.threads[0].state = "idle";
  next.threads[0].messages.push({ id: "a2", at: 9, kind: "assistant", from: "t1", text: "The deposit is three months." });
  emit("orchestra-update", next);
  const replies = $(".orc-log").find(".reply").map((r) => r.textContent);
  assert.deepEqual(replies, ["The deposit is three months."]);
  assert.equal($(".orc-now"), null);
});

test("a Markdown file opens in the reader beside the chat", async () => {
  answers.orchestra_read_file = { name: "report.md", path: "Leases/report.md", text: "# Report\n\nElm St wins." };
  await flush();
  $(".orc-fcard").fire("click");
  await flush();
  assert.deepEqual(sent("orchestra_read_file"), [{ id: "o1", path: "Leases/report.md" }]);
  assert.ok($(".chat-body").classList.contains("orc-reading"));
  assert.match($(".orc-doc-body").textContent, /Elm St wins/);
  $(".orc-doc-x").fire("click");
  assert.ok(!$(".chat-body").classList.contains("orc-reading"));
});

test("the rail's title lists the past orchestras and starts a new one", async () => {
  await flush();
  $(".orc-top").fire("click");
  await flush();
  assert.deepEqual(texts(".orc-menu-name"), ["Leases"]);
  $(".orc-menu-new").fire("click");
  assert.equal($(".orc-head-title").textContent, "Coordinator");
  assert.equal(view.el.find(".orc-item").length, 1, "an empty orchestra: its coordinator only");
});

test("the normal chat is untouched with the orchestra off", async () => {
  await flush();
  calls.length = 0;
  State.settings = { ...State.settings, orchestraMode: false };
  view = buildPrompt(() => {});
  view.sync();
  await flush();
  assert.ok(!$(".chat-body").classList.contains("orc"));
  assert.deepEqual(sent("orchestra_list"), []);
  // A chat-delta of another chat is the chat's, as before.
  assert.doesNotThrow(() => emit("chat-delta", { chat: "nobody", text: "x" }));
});

// ── The model picker ─────────────────────────────────────────────────────────

test("the picker: Orchestra first, then a row for the coordinator and one for the threads", async () => {
  State.settings = { ...State.settings, orchestraMode: false, chatProvider: "anthropic", orchestraCoordinator: { provider: "", model: "", effort: "" }, orchestraThread: { provider: "", model: "", effort: "" } };
  answers.chat_providers = ["anthropic", "claude-code", "codex", "lmstudio"];
  answers.secret_present = true;
  answers.chat_models = ({ provider }) => provider === "anthropic"
    ? [{ id: "claude-opus-5-5", label: "Claude Opus 5.5", reasoning: ["low", "medium", "high"] }, { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }]
    : [{ id: "gemma-4-26b-a4b", label: "gemma-4-26b-a4b" }];
  answers.local_caps = { vision: false, tools: true, reasoning: [], maxContext: 0, loadedContext: 0 };
  view = buildPrompt(() => {});
  view.sync();
  $(".model-btn").fire("click");
  await flush();
  const chips = () => view.el.find(".picker-chip").map((c) => c.textContent);
  assert.equal(chips()[0], "Orchestra");

  view.el.find(".picker-chip")[0].fire("click");
  await flush();
  assert.equal(State.settings.orchestraMode, true);
  // The blanks are written out: the chat's own provider and model.
  assert.deepEqual(State.settings.orchestraCoordinator, { provider: "anthropic", model: "claude-opus-5-5", effort: "" });
  assert.equal(sent("save_settings").at(-1).settings.orchestraMode, true);
  const rows = view.el.find(".orch-line");
  assert.deepEqual(rows.map((r) => r.querySelector(".orch-line-role").textContent), ["Coordinator", "Thread"]);
  assert.equal(rows[0].querySelector(".orch-pick-name").textContent, "Claude Opus 5.5");
  // Its effort: the levels its model takes.
  assert.ok(rows[0].querySelector(".effort-slider"));
  rows[0].querySelector(".effort-slider").fire("keydown", { key: "End" });
  assert.equal(State.settings.orchestraCoordinator.effort, "high");

  // The threads' model: only the providers that may take a role, no CLI.
  view.el.find(".orch-pick")[1].fire("click");
  await flush();
  assert.deepEqual(chips(), ["Anthropic", "LM Studio"]);
  view.el.find(".picker-chip")[1].fire("click");
  await flush();
  view.el.find(".picker-model").find((m) => m.textContent.includes("gemma")).fire("click");
  assert.deepEqual(State.settings.orchestraThread, { provider: "lmstudio", model: "gemma-4-26b-a4b", effort: "" });
  assert.equal(view.el.find(".orch-line").length, 2, "back on the two rows");
  view.sync();
  assert.equal($(".model-name").textContent, "Coordinator · Opus 5.5 → gemma-4-26b-a4b");

  // A provider picked: the orchestra steps aside.
  view.el.find(".picker-chip").find((c) => c.textContent === "Anthropic").fire("click");
  await flush();
  assert.equal(State.settings.orchestraMode, false);
});

test("the picker offers no Orchestra when only CLIs are set up", async () => {
  State.settings = { ...State.settings, orchestraMode: false, chatProvider: "claude-code", lmstudioUrl: "" };
  answers.chat_providers = ["claude-code", "codex"];
  answers.chat_models = [{ id: "default", label: "Default" }];
  view = buildPrompt(() => {});
  view.sync();
  await flush();
  $(".model-btn").fire("click");
  await flush();
  assert.ok(!view.el.find(".picker-chip").some((c) => c.textContent === "Orchestra"));
  assert.ok(!orchestraAllowed("claude-code") && !orchestraAllowed("copilot-cli") && orchestraAllowed("ollama"));
  assert.equal(resolvePick({ provider: "codex", model: "x", effort: "" }, { ...State.settings, chatProvider: "anthropic" }).provider, "anthropic", "a CLI saved for a role is never used");
});
