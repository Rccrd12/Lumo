// The computer use plan on the island (src/views/computer-plan.ts): what it
// says as computer use starts, what it marks at a step done, what paused
// offers (Stop, Ask, Resume) and what Ask sends; and the closed island's line.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { sent } from "./tauri.mjs";

installFakeDom();

const { State } = await import("../src/core/state.ts");
const { ComputerPill, buildComputerView, clearComputerReveal, computerShowing, setComputerReveal } = await import("../src/views/computer-plan.ts");

const step = (text, status = "pending") => ({ text, status });
const state = (extra = {}) => ({
  engaged: true, paused: false, stopped: false, agent: "Codex", color: "#10A37F",
  steps: [step("Click in Notepad", "active"), step("Open the File menu"), step("Choose Save as")], since: 1000, ...extra,
});

const shown = (el) => el != null && el.getAttribute("hidden") == null && el.hidden !== true;
const one = (root, cls) => root.querySelector(cls);

/** The island open on the plan, or closed (sync() runs on the closed island too). */
function open(on = true) {
  State.mode = on ? "expanded" : "compact";
  State.view = "computer";
}

// The view's clock ticks only while it is on screen: closed after each test, it stops.
afterEach(() => open(false));

function view() {
  let keyboard = 0;
  const host = buildComputerView({ takeKeyboard: () => keyboard++ });
  return { host, el: host.el, keyboard: () => keyboard };
}

test("as computer use starts: who, how far, the steps, Esc and the countdown, no buttons", () => {
  State.mode = "compact";
  State.computer = state({ reveal: "start", revealMs: 3000 });
  setComputerReveal("start", 3000);
  computerShowing();
  const { host, el } = view();
  host.sync();
  assert.match(one(el, ".cu-who").textContent, /Codex/);
  assert.match(one(el, ".cu-place").textContent, /^1 of 3 · \d+:\d\d/);
  assert.deepEqual(el.querySelectorAll(".cu-step").map((s) => s.textContent), ["Click in Notepad", "Open the File menu", "Choose Save as"]);
  assert.ok(one(el, ".cu-step.active"), "the step under way is marked");
  assert.equal(el.querySelectorAll(".cu-badge").length, 0, "nothing new the first time");
  const foot = one(el, ".cu-foot");
  assert.ok(shown(foot));
  assert.match(foot.textContent, /Esc/);
  assert.match(foot.textContent, /Starts in 3 s/);
  assert.ok(!shown(one(el, ".buttons")), "no buttons while it runs");
  assert.ok(!shown(one(el, ".cu-banner")));
  assert.ok(host.fitHeight(640, 640, 300) > 160);
  clearComputerReveal();
});

test("a step done: the plan again, what is new or reworded since marked, and the agent keeps working", () => {
  open();
  State.computer = state();
  computerShowing();
  const { host, el } = view();
  host.sync();
  State.computer = state({
    reveal: "step",
    steps: [step("Click in Notepad", "done"), step("Open the File menu", "active"), step("If it asks to replace, say Yes"), step("Choose Save as in Documents")],
  });
  setComputerReveal("step", 3000);
  computerShowing();
  host.sync();
  assert.deepEqual(el.querySelectorAll(".cu-badge").map((b) => b.className), ["cu-badge new", "cu-badge changed"]);
  assert.match(one(el, ".cu-foot").textContent, /Codex keeps working/);
  assert.match(one(el, ".cu-foot").textContent, /Closes in 3 s/);
  assert.match(one(el, ".cu-place").textContent, /^2 of 4/);
  clearComputerReveal();
});

test("paused: the banner, Stop, Ask and Resume; Ask opens a field and Enter sends it to the agent", () => {
  State.computer = state({ paused: true });
  computerShowing();
  const { host, el, keyboard } = view();
  host.sync();
  assert.match(one(el, ".cu-banner").textContent, /Paused/);
  assert.match(one(el, ".cu-banner").textContent, /the mouse is yours, Codex is waiting/);
  const buttons = one(el, ".buttons");
  assert.ok(shown(buttons));
  assert.ok(!shown(one(el, ".cu-field")), "the field waits for Ask");
  assert.equal(one(el, ".cu-ask").textContent, "Ask Codex");
  const closed = host.fitHeight(640, 640, 300);

  one(el, ".cu-ask").fire("click");
  assert.equal(keyboard(), 1, "Ask takes the keyboard, nothing else does");
  host.sync();
  assert.ok(shown(one(el, ".cu-field")));
  assert.ok(!shown(one(el, ".cu-resume")) && shown(one(el, ".cu-cancel")));
  assert.equal(one(el, ".cu-resume").textContent, "Resume", "Resume has no Esc keycap: Esc only pauses");
  assert.ok(host.fitHeight(640, 640, 300) > closed, "the island grows for the field");

  const input = one(el, ".cu-input");
  input.value = "Save it in Documents, not on the Desktop";
  input.fire("keydown", { key: "Enter" });
  assert.deepEqual(sent("computer_ask").at(-1), { text: "Save it in Documents, not on the Desktop" });
  assert.equal(sent("focus_window").at(-1)?.focused, false, "the keyboard goes back once it is sent");

  // Rust says it is with the agent, then the agent answers with its plan.
  State.computer = state({ paused: true, asked: "Save it in Documents, not on the Desktop" });
  host.sync();
  assert.match(one(el, ".cu-note").textContent, /Codex is reading your message/);
  State.computer = state({ paused: true, explanation: "Fine, I will save it in Documents." });
  host.sync();
  assert.equal(one(el, ".cu-note").textContent, "Codex: Fine, I will save it in Documents.");

  one(el, ".cu-resume").fire("click");
  assert.equal(sent("computer_resume").length, 1);
  one(el, ".cu-stop").fire("click");
  assert.equal(sent("computer_stop").length, 1);
});

test("an explanation the user did not ask for is not shown as an answer", () => {
  State.computer = state({ paused: true, explanation: "Starting with Notepad." });
  computerShowing();
  const { host, el } = view();
  host.sync();
  assert.ok(!shown(one(el, ".cu-note")));
});

test("no plan: the head alone, no steps", () => {
  State.computer = state({ steps: [] });
  computerShowing();
  const { host, el } = view();
  host.sync();
  assert.ok(!shown(one(el, ".cu-steps")));
  assert.equal(el.querySelectorAll(".cu-step").length, 0);
});

test("the closed island's line: the step, a segment each, k/n and Esc; nothing without a plan", () => {
  const pill = new ComputerPill();
  pill.sync(state({ steps: [step("Click in Notepad", "done"), step("Open the File menu", "active"), step("Choose Save as")] }));
  assert.match(pill.el.textContent, /Open the File menu/);
  assert.match(pill.el.textContent, /2\/3/);
  assert.match(pill.el.textContent, /Esc/);
  // Paused, Esc does nothing (only Resume goes on): the line never says it does.
  pill.sync(state({ paused: true, steps: [step("Click in Notepad", "done"), step("Open the File menu", "active"), step("Choose Save as")] }));
  assert.doesNotMatch(pill.el.textContent, /Esc/);
  assert.doesNotMatch(pill.el.title, /Esc/);
  assert.match(pill.el.textContent, /2\/3/);
  pill.sync(state({ steps: [step("Click in Notepad", "done"), step("Open the File menu", "active"), step("Choose Save as")] }));
  assert.match(pill.el.textContent, /Esc/, "and back once resumed");
  assert.deepEqual(pill.el.querySelectorAll(".cu-segs")[0].children.map((i) => i.className), ["done", "active", "pending"]);
  assert.ok(pill.el.classList.contains("shown"));
  pill.sync(state({ steps: [] }));
  assert.equal(pill.width, 0);
  assert.ok(!pill.el.classList.contains("shown"));
  pill.sync(null);
  assert.equal(pill.el.textContent, "");
});

test("what changed while the island was closed is still marked at the next showing", () => {
  open();
  State.computer = state({ since: 2000 });
  computerShowing();
  const { host, el } = view();
  host.sync();
  // The plan folds away; the agent adds a step, with nothing done (no reveal).
  open(false);
  State.computer = state({ since: 2000, steps: [...state().steps, step("Close Notepad")] });
  host.sync();
  // A step is done: the plan opens again, and the step added meanwhile is new.
  State.computer = state({
    since: 2000, reveal: "step",
    steps: [step("Click in Notepad", "done"), step("Open the File menu", "active"), step("Choose Save as"), step("Close Notepad")],
  });
  setComputerReveal("step", 3000);
  computerShowing();
  open();
  host.sync();
  assert.deepEqual(el.querySelectorAll(".cu-step").map((s) => s.querySelector(".cu-badge")?.className ?? null),
    [null, null, null, "cu-badge new"]);
  clearComputerReveal();
});

test("Esc in the field cancels it: nothing sent, the keyboard back, the agent still paused", () => {
  open();
  State.computer = state({ paused: true, since: 3000 });
  computerShowing();
  const { host, el } = view();
  host.sync();
  const asks = sent("computer_ask").length;
  const resumes = sent("computer_resume").length;
  one(el, ".cu-ask").fire("click");
  host.sync();
  const input = one(el, ".cu-input");
  input.value = "Not that file";
  // An IME composing keeps its own Esc.
  one(el, ".cu-field").fire("keydown", { key: "Escape", isComposing: true });
  host.sync();
  assert.ok(shown(one(el, ".cu-field")));
  const esc = one(el, ".cu-field").fire("keydown", { key: "Escape" });
  host.sync();
  assert.ok(esc.defaultPrevented);
  assert.ok(!shown(one(el, ".cu-field")));
  assert.equal(input.value, "");
  assert.ok(shown(one(el, ".cu-resume")) && !shown(one(el, ".cu-cancel")));
  assert.equal(sent("focus_window").at(-1)?.focused, false, "the keyboard goes back");
  assert.equal(sent("computer_ask").length, asks, "nothing sent");
  assert.equal(sent("computer_resume").length, resumes, "Esc never resumes");
});

test("paused: the banner says when a pause left on stops by itself; nothing while it runs", () => {
  open();
  const awayAt = Date.now() + 9 * 60_000 + 12_500;
  State.computer = state({ paused: true, awayAt });
  const { host, el } = view();
  host.sync();
  const away = one(el, ".cu-banner-away");
  assert.ok(shown(away));
  assert.match(away.textContent, /^stops by itself in 9:1[23]$/);
  // Resumed: no countdown.
  State.computer = state({ paused: false, awayAt });
  host.sync();
  assert.ok(!shown(one(el, ".cu-banner-away")));
  // Paused without a time (an older Lumo): nothing made up.
  State.computer = state({ paused: true });
  host.sync();
  assert.ok(!shown(one(el, ".cu-banner-away")));
  State.computer = null;
});
