// The projects (src/views/orchestra.ts, src/views/projects.ts) in the chat, on
// a fake DOM, through the real bridge: a project open with its coordinator and
// threads in the rail, the member on screen with the messages between members,
// a decision card answered by a click, what is typed going to the member on
// screen, the answer streaming in under the member's chat id, a member paused
// by a usage limit; the empty chat's Projects card, the list, New project's
// form (its icon, its models with no CLI but Claude Code to coordinate, its
// folder) and the gear that opens a project's settings.

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
  id: "o1", title: "Leases", created: 1, updated: 2, icon: "house", color: "#f5b942", goal: "Compare the three leases.", folder: "", resume: true, threadPick: LM,
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
    orchestra_list: [{ id: "o1", title: "Leases", icon: "house", color: "#f5b942", goal: "Compare the three leases.", updated: 2, state: "waiting", working: 2, asking: "t3", planDone: 1, planTotal: 2, coordinator: OPUS, thread: LM }],
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

test("the projects take the chat's place: the last one opens on its coordinator", async () => {
  await flush();
  view.sync();
  assert.ok($(".chat-body").classList.contains("orc"));
  assert.ok(!$(".chat-body").classList.contains("orc-full"));
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
  assert.ok($(".pj-gear"), "the project's settings, beside Stop all");
  assert.equal($(".orc-top-name").textContent, "Leases");
  assert.ok($(".orc-top").querySelector(".pj-ic"), "its icon before its name");
  assert.equal($(".chat-input").placeholder, "Write to the coordinator…");
  // The model button: only the model of the chat on screen.
  assert.equal($(".model-name").textContent, "Opus 5.5 · High");
  item("t1").fire("click");
  view.sync();
  assert.equal($(".model-name").textContent, "gemma-4-26b-a4b · Medium");
});

test("the model button changes the model of the chat on screen: a thread's its own, the coordinator's the project's", async () => {
  answers.chat_providers = ["anthropic", "lmstudio"];
  answers.secret_present = true;
  answers.chat_models = ({ provider }) => provider === "anthropic"
    ? [{ id: "claude-opus-5-5", label: "Claude Opus 5.5", reasoning: ["low", "medium", "high"] }, { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", reasoning: ["low", "high"] }]
    : [{ id: "gemma-4-26b-a4b", label: "gemma-4-26b-a4b" }];
  answers.local_caps = { vision: false, tools: true, reasoning: [], maxContext: 0, loadedContext: 0 };
  answers.orchestra_set_pick = ({ member, pick }) => {
    const next = structuredClone(SNAP);
    const m = member === "coordinator" ? next.coordinator : next.threads.find((x) => x.id === member);
    m.pick = pick;
    return next;
  };
  view = buildPrompt(() => {});
  view.sync();
  await flush();
  view.sync();
  item("t1").fire("click");
  $(".model-btn").fire("click");
  await flush();
  assert.ok($(".orc-model-pop"), "its menu, not the project's settings");
  assert.ok(!$(".chat-body").classList.contains("orc-settings"));
  assert.deepEqual(texts(".pj-grp"), ["Anthropic", "LM Studio"]);
  view.el.find(".pj-opt").find((o) => o.textContent === "Claude Sonnet 5.5").fire("click");
  await flush();
  assert.deepEqual(sent("orchestra_set_pick").at(-1), { id: "o1", member: "t1", pick: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "" } });
  view.sync();
  assert.equal($(".model-name").textContent, "Sonnet 5.5");
  // Its effort, under it.
  view.el.find(".pj-seg")[0].children[1].fire("click");
  await flush();
  assert.equal(sent("orchestra_set_pick").at(-1).pick.effort, "high");
  // Escape-like: a press away closes it; the coordinator's is its own menu.
  $(".model-btn").fire("click");
  assert.equal($(".orc-model-pop"), null);
  item("coordinator").fire("click");
  $(".model-btn").fire("click");
  await flush();
  view.el.find(".pj-opt").find((o) => o.textContent === "Claude Sonnet 5.5").fire("click");
  await flush();
  assert.equal(sent("orchestra_set_pick").at(-1).member, "coordinator");
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
  // In the coordinator's chat only who it is from: a click opens that thread.
  assert.equal($(".orc-relay-body"), null);
  view.el.find(".orc-from")[0].fire("click");
  assert.equal($(".orc-head-title").textContent, "Elm St");
  // In a thread, folded: a click shows what the coordinator said, another hides it, and it stays as left.
  const relay = $(".orc-relay");
  assert.equal(texts(".orc-from")[0], "From the coordinator");
  assert.ok(!relay.classList.contains("open"));
  view.el.find(".orc-from")[0].fire("click");
  assert.ok(relay.classList.contains("open"));
  assert.equal($(".orc-head-title").textContent, "Elm St", "the conversation stays where it is");
  view.sync();
  assert.ok($(".orc-relay").classList.contains("open"));
  view.el.find(".orc-from")[0].fire("click");
  assert.ok(!$(".orc-relay").classList.contains("open"));
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
  // Lumo's own commands run as in a chat, never sent: "/model" opens the member's model menu.
  const before = sent("orchestra_send").length;
  await typeAndSend("/model");
  assert.equal(sent("orchestra_send").length, before);
  assert.ok($(".orc-model-pop"), "the model menu of the member on screen");
  $(".chat-input").fire("keydown", { key: "Escape" });

  $(".orc-stop").fire("click");
  await flush();
  assert.deepEqual(sent("orchestra_stop"), [{ id: "o1", member: "t3" }]);
});

test("what is attached goes with the message, into the member's chat's files, and leaves the field", async () => {
  await flush();
  // Elm St, its work done: the message shows in its chat at once.
  item("t2").fire("click");
  view.sync();
  State.moreFiles = [{ name: "lease.pdf", path: "C:\\inbox\\lease.pdf" }];
  await typeAndSend("Read this one");
  const [call] = sent("orchestra_send");
  assert.equal(call.to, "t2");
  assert.equal(call.text, "Read this one");
  assert.deepEqual(call.screen.files, [{ name: "lease.pdf", path: "C:\\inbox\\lease.pdf" }]);
  assert.deepEqual(call.sent.map((i) => [i.kind, i.label]), [["file", "lease.pdf"]]);
  assert.deepEqual(sent("chat_files_adopt").at(-1)?.items?.map((i) => i.chat), ["orc-o1-t2"], "moved into the member's chat's folder");
  assert.deepEqual(State.moreFiles, [], "the next message starts with nothing attached");
  // Its bubble says what went, as a chat's question does.
  assert.ok(view.el.find(".sent-badges").length > 0);
  // Only a file, nothing written: it goes too.
  State.moreFiles = [{ name: "deposit.pdf", path: "C:\\inbox\\deposit.pdf" }];
  await typeAndSend("");
  assert.equal(sent("orchestra_send").at(-1).text, "");
  assert.deepEqual(sent("orchestra_send").at(-1).sent.map((i) => i.label), ["deposit.pdf"]);
});

test("a local model member nearly full is compacted once, as a chat; /compact compacts the member on screen", async () => {
  await flush();
  emit("chat-usage", { provider: "lmstudio", context: { chat: "orc-o1-t1", used: 28_000, total: 32_768 } });
  emit("chat-usage", { provider: "lmstudio", context: { chat: "orc-o1-t1", used: 29_000, total: 32_768 } });
  assert.deepEqual(sent("orchestra_compact"), [{ id: "o1", member: "t1" }], "asked once while it stays that full");
  // An API model's is not compacted by itself, as in a chat.
  emit("chat-usage", { provider: "anthropic", context: { chat: SNAP.coordinator.chat, used: 190_000, total: 200_000 } });
  assert.equal(sent("orchestra_compact").length, 1);
  // Asked with /compact: the member on screen's, never words sent to it.
  await typeAndSend("/compact");
  assert.deepEqual(sent("orchestra_compact").at(-1), { id: "o1", member: "coordinator" });
  assert.deepEqual(sent("orchestra_send"), []);
});

test("with no project, the list shows; New project's form makes one with what it says", async () => {
  await flush();
  calls.length = 0;
  answers.orchestra_list = [];
  answers.orchestra_create = { ...SNAP, id: "o2", title: "Trip", goal: "Plan my trip", plan: [], locks: [], coordinator: member("coordinator", "Coordinatore", "idle", []), threads: [] };
  answers.chat_providers = ["anthropic", "claude-code", "codex", "lmstudio"];
  answers.secret_present = true;
  answers.pick_folder = "C:\\Trips";
  view = buildPrompt(() => {});
  view.sync();
  await flush();
  view.sync();
  assert.deepEqual(sent("orchestra_open"), []);
  assert.ok($(".chat-body").classList.contains("orc-full"), "the list in the chat's place");
  assert.equal($(".pj-title").textContent, "Projects");
  assert.match($(".pj-none").textContent, /^No projects yet/);
  // Nothing typed reaches a project that does not exist.
  await typeAndSend("Plan my trip");
  assert.deepEqual(sent("orchestra_send"), []);

  $(".pj-new").fire("click");
  view.sync();
  assert.equal($(".pj-h").textContent, "New project");
  const create = view.el.find(".pj-b").find((b) => b.textContent === "Create project");
  assert.equal(create.disabled, true, "a name first");
  const name = $(".pj-name-input");
  name.value = "Trip";
  name.fire("input");
  assert.equal(create.disabled, false);
  const goal = $(".pj-area");
  goal.value = "Plan my trip";
  goal.fire("input");
  assert.equal($(".pj-count").textContent, "12 / 8000");
  // The icon: a picker with a search, the icons and the colours.
  $(".pj-mark-btn").fire("click");
  assert.ok($(".pj-pop-icons"));
  assert.equal(view.el.find(".pj-icon").length, 48);
  const search = $(".pj-search-input");
  search.value = "rocket";
  search.fire("input");
  assert.deepEqual(view.el.find(".pj-icon").map((b) => b.getAttribute("data-icon")), ["rocket"]);
  $(".pj-icon").fire("click");
  view.el.find(".pj-color").find((c) => c.getAttribute("data-color") === "#60a5fa").fire("click");
  // The folder, from the system's dialog.
  $(".pj-folder").fire("click");
  await flush();
  assert.equal($(".pj-folder-text").textContent, "C:\\Trips");
  create.fire("click");
  await flush();
  const made = sent("orchestra_create")[0].project;
  assert.deepEqual({ ...made, coordinator: undefined, thread: undefined }, { title: "Trip", icon: "rocket", color: "#60a5fa", goal: "Plan my trip", folder: "C:\\Trips", repos: [], resume: true, coordinator: undefined, thread: undefined });
  assert.deepEqual(made.coordinator, OPUS, "New project starts from the last project's models");
  view.sync();
  assert.ok($(".chat-body").classList.contains("orc"), "the new project, open");
  await typeAndSend("Plan my trip");
  assert.deepEqual(sent("orchestra_send"), [{ id: "o2", to: "coordinator", text: "Plan my trip" }]);
  assert.ok(texts(".bubble").some((t) => t.includes("Plan my trip")), "shown at once");
});

test("the models' menus: grouped by provider, no CLI but Claude Code to coordinate, the effort under them", async () => {
  State.settings = { ...State.settings, orchestraCoordinator: { provider: "", model: "", effort: "" }, chatProvider: "anthropic" };
  answers.orchestra_list = [];
  answers.chat_providers = ["anthropic", "claude-code", "codex", "lmstudio"];
  answers.secret_present = true;
  answers.chat_models = ({ provider }) => provider === "anthropic"
    ? [{ id: "claude-opus-5-5", label: "Claude Opus 5.5", reasoning: ["low", "medium", "high"] }, { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" }]
    : provider === "lmstudio" ? [{ id: "gemma-4-26b-a4b", label: "gemma-4-26b-a4b" }] : [{ id: "default", label: "Default" }];
  answers.local_caps = { vision: false, tools: true, reasoning: [], maxContext: 0, loadedContext: 0 };
  view = buildPrompt(() => {});
  view.sync();
  $(".model-btn").fire("click");
  await flush();
  // The picker has only providers now.
  assert.ok(!view.el.find(".picker-chip").some((c) => c.textContent === "Orchestra"));
  $(".model-btn").fire("click");
  await flush();
  $(".pj-new").fire("click");
  view.sync();
  $(".pj-coord").fire("click");
  await flush();
  assert.deepEqual(texts(".pj-grp"), ["Anthropic", "Claude Code", "LM Studio"]);
  assert.ok($(".pj-coord").classList.contains("open"));
  // Its effort: the levels its model takes.
  assert.deepEqual(view.el.find(".pj-seg")[0].children.map((b) => b.textContent), ["Low", "Medium", "High"]);
  view.el.find(".pj-seg")[0].children[2].fire("click");
  assert.match($(".pj-coord").textContent, /^Opus 5\.5Anthropic · High$/);
  // A search narrows the list.
  const search = $(".pj-search-input");
  search.value = "sonnet";
  search.fire("input");
  assert.deepEqual(view.el.find(".pj-opt").map((o) => o.textContent), ["Claude Sonnet 5.5"]);
  // The threads': every provider, the CLIs too.
  $(".pj-thread").fire("click");
  await flush();
  assert.deepEqual(texts(".pj-grp"), ["Anthropic", "Claude Code", "Codex", "LM Studio"]);
  view.el.find(".pj-opt").find((o) => o.textContent.includes("gemma")).fire("click");
  assert.match($(".pj-thread").textContent, /gemma-4-26b-a4b.*LM Studio/);
  // The pure rules.
  assert.ok(orchestraAllowed("claude-code") && !orchestraAllowed("copilot-cli") && !orchestraAllowed("codex") && orchestraAllowed("ollama"));
  assert.ok(orchestraAllowed("codex", "thread") && orchestraAllowed("antigravity-cli", "thread") && orchestraAllowed("cursor-cli", "thread"));
  const chat = { ...State.settings, chatProvider: "anthropic" };
  assert.equal(resolvePick({ provider: "codex", model: "x", effort: "" }, chat).provider, "anthropic", "a CLI that can't coordinate is never the coordinator");
  assert.deepEqual(resolvePick({ provider: "codex", model: "x", effort: "high" }, chat, null, "thread"), { provider: "codex", model: "x", effort: "high" });
});

test("a member's answer streams in under its chat id; the next update has it whole", async () => {
  await flush();
  item("t1").fire("click");
  emit("chat-delta", { chat: "orc-o1-t1", text: "The deposit is **three** months" });
  emit("chat-activity", { chat: "orc-o1-t1", activity: { kind: "edit", detail: "summary.csv" } });
  // A local model's speed, under the text being written, as in a chat.
  emit("chat-tokens", { chat: "orc-o1-t1", tokens: 120, secs: 3 });
  assert.equal($(".orc-log").querySelector(".reply-speed-text")?.textContent, "120 tokens · 40 tok/sec");
  // A file it changed meanwhile: under its answer when it comes, as in a chat.
  emit("chat-file", { chat: "orc-o1-t1", kind: "edited", path: "C:\\Leases\\summary.csv" });
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
  assert.deepEqual(sent("orchestra_keep_answer"), [{ id: "o1", member: "t1", message: "a2", answer: { speed: { tokens: 120, secs: 3 }, files: [{ path: "C:\\Leases\\summary.csv", kind: "edited" }] } }]);
  assert.equal($(".orc-log").querySelector(".reply-speed-row"), null, "the live line gives way to the answer's bar");
  // Its actions as a chat answer's: Copy, and when it came.
  assert.ok($(".orc-log").querySelector(".msg-copy"));
  // A turn that failed for something Lumo can put right: the chat's card for it.
  const failed = structuredClone(next);
  failed.threads[0].messages.push({ id: "a3", at: 10, kind: "note", from: "lumo", note: "error", text: "Claude Code isn't installed.\u2064claude-install" });
  emit("orchestra-update", failed);
  assert.ok($(".orc-log").querySelector(".chat-fix"), "said as a chat's failed answer, with its card");
  // The coordinator saying nothing to a thread's answer ([quiet]): never shown, even as it comes.
  item("coordinator").fire("click");
  const before = $(".orc-log").find(".reply").length;
  emit("chat-delta", { chat: SNAP.coordinator.chat, text: "[qui" });
  emit("chat-delta", { chat: SNAP.coordinator.chat, text: "[quiet]" });
  assert.equal($(".orc-log").find(".reply").length, before);
});

test("Retry and Edit work on a member's last message while nothing came of its answer", async () => {
  await flush();
  const next = structuredClone(SNAP);
  next.threads[1].messages.splice(1, 0, { id: "u1", at: 2, kind: "user", from: "user", text: "How much is it?" });
  emit("orchestra-update", next);
  item("t2").fire("click");
  view.sync();
  // Retry, on the question and on its answer.
  assert.equal($(".orc-log").find(".msg-retry").length, 2);
  $(".orc-log").querySelector(".msg-retry").fire("click");
  await flush();
  assert.deepEqual(sent("orchestra_retry"), [{ id: "o1", member: "t2", message: "u1", text: null }]);
  // Edit: its words in the field, sent again changed.
  $(".orc-log").querySelector(".msg-edit").fire("click");
  assert.equal($(".chat-input").value, "How much is it?");
  await typeAndSend("How much is it a month?");
  assert.deepEqual(sent("orchestra_retry").at(-1), { id: "o1", member: "t2", message: "u1", text: "How much is it a month?" });
  assert.deepEqual(sent("orchestra_send"), [], "never a new message");
  // A member whose answer went on (Oak St wrote to Main St): none.
  item("t3").fire("click");
  view.sync();
  assert.equal($(".orc-log").find(".msg-retry").length, 0);
  assert.equal($(".orc-log").find(".msg-edit").length, 0);
});

test("the agents a member starts show under its answer, as in a chat", async () => {
  await flush();
  item("t1").fire("click");
  view.sync();
  const now = Date.now();
  emit("chat-agent", { chat: "orc-o1-t1", agent: { id: "a1", source: "claude-code", title: "Read page 3", state: "working", steps: 0, startedAt: now, lastSignalAt: now, background: true, canStop: true, canAsk: true } });
  await flush();
  assert.ok($(".orc-log").querySelector(".agents"), "its Agents card, in the member's chat");
  // Another member's chat on screen: not there.
  item("t2").fire("click");
  view.sync();
  assert.equal($(".orc-log").querySelector(".agents"), null);
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

test("the rail's title lists the projects, New project, the settings, all of them and the way back to the chats", async () => {
  await flush();
  $(".orc-top").fire("click");
  await flush();
  assert.deepEqual(texts(".orc-menu-name"), ["Leases", "Settings", "All projects", "Back to the chats"]);
  view.el.find(".orc-menu-foot").find((r) => r.textContent === "All projects").fire("click");
  await flush();
  view.sync();
  assert.ok($(".chat-body").classList.contains("orc-full"));
  const card = $(".pj-card");
  assert.equal(card.querySelector(".pj-name").textContent, "Leases");
  assert.equal(card.querySelector(".pj-goal").textContent, "Compare the three leases.");
  assert.equal(card.querySelector(".pj-state").textContent, "Waiting for you");
  assert.equal(card.querySelector(".pj-models").textContent, "Opus 5.5 → gemma-4-26b-a4b");
  card.fire("click");
  await flush();
  view.sync();
  assert.ok($(".chat-body").classList.contains("orc"));
  $(".orc-top").fire("click");
  $(".orc-menu-new").fire("click");
  view.sync();
  assert.equal($(".pj-h").textContent, "New project");
  view.el.find(".pj-b").find((b) => b.textContent === "Cancel").fire("click");
  view.sync();
  assert.equal($(".orc-head-title").textContent, "Coordinator", "back to the project it came from");
});

test("the gear opens the project's settings in the conversation's place: saved, or deleted with two clicks", async () => {
  answers.secret_present = true;
  answers.github_repo_names = [{ name: "Rccrd12/Lumo", private: false, description: "The island" }, { name: "Rccrd12/leases", private: true, description: "" }];
  answers.orchestra_update = ({ project }) => ({ ...structuredClone(SNAP), title: project.title, goal: project.goal, resume: project.resume, threadPick: project.thread });
  await flush();
  $(".pj-gear").fire("click");
  view.sync();
  assert.ok($(".chat-body").classList.contains("orc-settings"));
  assert.ok($(".pj-gear").classList.contains("on"));
  assert.equal($(".pj-h").textContent, "Project settings");
  assert.equal($(".pj-name-input").value, "Leases");
  assert.equal($(".pj-area").value, "Compare the three leases.");
  assert.ok(!$(".chat-body").classList.contains("orc-full"), "the rail stays");
  const name = $(".pj-name-input");
  name.value = "Leases 2026";
  name.fire("input");
  $(".pj-switch").fire("click");
  // Its environment: the user's repositories, from a search; one added, then another taken off.
  assert.equal($(".pj-repo-add").textContent, "Add a repository");
  $(".pj-repo-add").fire("click");
  await flush();
  assert.deepEqual(view.el.find(".pj-repo-opt").map((o) => o.dataset.repo ?? o.getAttribute("data-repo")), ["Rccrd12/Lumo", "Rccrd12/leases"]);
  assert.equal(view.el.find(".pj-repo-opt")[1].querySelector(".pj-opt-tag").textContent, "Private");
  const search = $(".pj-search-input");
  search.value = "lease";
  search.fire("input");
  assert.equal(view.el.find(".pj-repo-opt").length, 1);
  view.el.find(".pj-repo-opt")[0].fire("click");
  $(".pj-repo-add").fire("click");
  await flush();
  view.el.find(".pj-repo-opt")[0].fire("click");
  assert.deepEqual(texts(".pj-repo-name"), ["Rccrd12/leases", "Rccrd12/Lumo"]);
  view.el.find(".pj-repo-x")[1].fire("click");
  assert.deepEqual(texts(".pj-repo-name"), ["Rccrd12/leases"]);
  view.el.find(".pj-b").find((b) => b.textContent === "Save").fire("click");
  await flush();
  const saved = sent("orchestra_update")[0];
  assert.equal(saved.id, "o1");
  assert.deepEqual(saved.project.repos, ["Rccrd12/leases"]);
  assert.equal(saved.project.title, "Leases 2026");
  assert.equal(saved.project.resume, false);
  assert.deepEqual(saved.project.thread, LM);
  view.sync();
  assert.ok(!$(".chat-body").classList.contains("orc-settings"), "back to the conversation");
  assert.equal($(".orc-top-name").textContent, "Leases 2026");

  // Delete asks a second click.
  $(".pj-gear").fire("click");
  view.sync();
  assert.ok($(".chat-body").classList.contains("orc-settings"));
  const del = view.el.find(".pj-b").find((b) => b.textContent === "Delete project");
  del.fire("click");
  assert.deepEqual(sent("orchestra_delete"), []);
  assert.equal(del.textContent, "Click again to delete it");
  del.fire("click");
  await flush();
  assert.deepEqual(sent("orchestra_delete"), [{ id: "o1" }]);
  view.sync();
  assert.ok($(".chat-body").classList.contains("orc-full"), "the list, after");
});

test("a member stopped by a usage limit says when it goes on", async () => {
  await flush();
  const next = structuredClone(SNAP);
  const until = Math.floor(new Date(2026, 10, 27, 18, 30).getTime() / 1000);
  next.threads[0].state = "paused";
  next.threads[0].resumeAt = until;
  next.threads[0].messages.push({ id: "a9", at: 9, kind: "note", from: "t1", text: "You've hit your limit · resets 6:30pm", note: "limit", until });
  emit("orchestra-update", next);
  assert.ok(item("t1").querySelector(".orc-mk").classList.contains("paused"));
  assert.match(item("t1").querySelector(".orc-item-step").textContent, /^Goes on at 18.30$|^Goes on at 06:30 PM$/);
  item("t1").fire("click");
  assert.match($(".orc-note.limit").textContent, /^Usage limit reached: it goes on by itself at .*\.You've hit your limit/);
  assert.equal($(".orc-stop").textContent, "Stop thread", "a paused member can be stopped");
});

test("the normal chat is untouched with the projects off; its empty chat leads to them", async () => {
  await flush();
  calls.length = 0;
  State.settings = { ...State.settings, orchestraMode: false };
  view = buildPrompt(() => {});
  view.sync();
  await flush();
  assert.ok(!$(".chat-body").classList.contains("orc"));
  assert.deepEqual(sent("orchestra_open"), []);
  // The empty chat's card: how many there are and who waits.
  assert.equal($(".pj-start").querySelector(".pj-start-count").textContent, "1 project · 1 waiting for you");
  $(".pj-start").fire("click");
  await flush();
  view.sync();
  assert.equal(State.settings.orchestraMode, true);
  assert.equal(sent("save_settings").at(-1).settings.orchestraMode, true);
  assert.ok($(".chat-body").classList.contains("orc-full"));
  assert.equal(view.el.find(".pj-card").length, 1);
  // + leaves them for a new chat.
  view.el.find(".tool-btn")[0].fire("click");
  view.sync();
  assert.equal(State.settings.orchestraMode, false);
  assert.ok(!$(".chat-body").classList.contains("orc-full"));
  // The list's "‹ Chat" and the rail's ‹ go back to the chats too.
  $(".pj-start").fire("click");
  await flush();
  view.sync();
  assert.equal($(".pj-back").textContent, "Chat");
  $(".pj-back").fire("click");
  view.sync();
  assert.equal(State.settings.orchestraMode, false);
  assert.ok(!$(".chat-body").classList.contains("orc-full"));
  $(".pj-start").fire("click");
  await flush();
  view.sync();
  $(".pj-card").fire("click");
  await flush();
  view.sync();
  assert.ok($(".chat-body").classList.contains("orc"));
  $(".orc-back").fire("click");
  view.sync();
  assert.equal(State.settings.orchestraMode, false);
  assert.ok(!$(".chat-body").classList.contains("orc"));
  // A chat-delta of another chat is the chat's, as before.
  assert.doesNotThrow(() => emit("chat-delta", { chat: "nobody", text: "x" }));
});

test("the usage ring shows the context of the member on screen, by its own chat", async () => {
  State.settings = { ...State.settings, chatShowUsage: true };
  view.sync();
  await flush();
  emit("chat-usage", { provider: "lmstudio", context: { chat: "orc-o1-t1", used: 16_384, total: 32_768 } });
  await flush();
  view.sync();
  // The coordinator (Anthropic) has told nothing yet.
  assert.equal($(".chat-usage").style.display, "none");
  item("t1").fire("click");
  view.sync();
  assert.notEqual($(".chat-usage").style.display, "none");
  assert.match($(".chat-usage").title, /16(\.|,)4K/);
});

test("the closed island says how many work and the plan, who waits for you, and that it finished", async () => {
  await flush();
  view.sync();
  // A card waits (Oak St's): that first.
  assert.equal(State.chatActivity?.label, "Oak St asks you");
  assert.equal(State.chatActivity?.who, "«Leases»");
  // Seen on the open island, its card still waiting: no longer said, as a chat's answer once read.
  State.mode = "expanded";
  item("t3").fire("click");
  await flush();
  assert.equal(State.chatActivity?.label, "2 at work · Plan 1/2");
  State.mode = "compact";
  view.sync();
  await flush();
  assert.equal(State.chatActivity?.label, "2 at work · Plan 1/2", "closed again, it does not come back");
  item("coordinator").fire("click");
  // Answered: how many work, and how far the plan is.
  const busy = structuredClone(SNAP);
  for (const m of [busy.coordinator, ...busy.threads]) for (const x of m.messages) if (x.card) x.card.chose = 0;
  emit("orchestra-update", busy);
  await flush();
  assert.equal(State.chatActivity?.label, "2 at work · Plan 1/2");
  // All done while the island was closed: it says so, with the coordinator's first line.
  State.mode = "compact";
  const done = structuredClone(busy);
  for (const m of [done.coordinator, ...done.threads]) m.state = "idle";
  done.coordinator.messages.push({ id: "z", at: 10, kind: "assistant", from: "coordinator", text: "**Main St** is the better deal.\n\nDetails below." });
  emit("orchestra-update", done);
  await flush();
  assert.equal(State.chatActivity?.label, "finished · Main St is the better deal.");
  // Opened: said, no longer.
  State.mode = "expanded";
  view.sync();
  await flush();
  assert.equal(State.chatActivity, null);
});
