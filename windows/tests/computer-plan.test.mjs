// Computer use with a plan, as the island says it (src/core/computer-plan.ts):
// the clock, which step it is at, what changed since the plan was last shown,
// the countdowns, the footer, the closed island's line, and what each
// computer-state does to the island (open, close, let go).

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  clockText, computerFooter, computerPillKey, computerPillParts, countdownShare, planMarks, secondsLeft, stepNowText, stepPlace,
} = await import("../src/core/computer-plan.ts");
const { COMPUTER_MAX_STEPS, COMPUTER_STEP_H, computerViewHeight } = await import("../src/core/layout.ts");

const step = (text, status = "pending") => ({ text, status });
const state = (extra = {}) => ({
  engaged: true, paused: false, stopped: false, agent: "Claude Code", color: "#D97757",
  steps: [step("Click in Notepad", "done"), step("Open the File menu", "active"), step("Choose Save as")], since: 0, ...extra,
});

test("the plan's clock reads minutes and seconds, hours past an hour", () => {
  assert.equal(clockText(0), "0:00");
  assert.equal(clockText(24_900), "0:24");
  assert.equal(clockText(12 * 60_000 + 5_000), "12:05");
  assert.equal(clockText(3_729_000), "1:02:09");
  assert.equal(clockText(-5000), "0:00", "a clock a little ahead of the other never goes below 0");
  assert.equal(clockText(Number.NaN), "0:00");
});

test("the step it is at: the one under way, else the first not done, else the last", () => {
  assert.deepEqual(stepPlace([]), { step: 0, total: 0 });
  assert.deepEqual(stepPlace(state().steps), { step: 2, total: 3 });
  assert.deepEqual(stepPlace([step("a", "done"), step("b"), step("c")]), { step: 2, total: 3 });
  assert.deepEqual(stepPlace([step("a", "done"), step("b", "done")]), { step: 2, total: 2 });
  assert.equal(stepNowText(state().steps), "Open the File menu");
  assert.equal(stepNowText([step("a", "done"), step("Check it is there", "done")]), "Check it is there");
  assert.equal(stepNowText([]), null);
});

test("the countdown says whole seconds left, and its bar how much is left", () => {
  assert.equal(secondsLeft(3000, 0), 3);
  assert.equal(secondsLeft(3000, 1), 3);
  assert.equal(secondsLeft(3000, 2001), 1);
  assert.equal(secondsLeft(3000, 3000), 0);
  assert.equal(secondsLeft(3000, 9000), 0);
  assert.equal(countdownShare(3000, 3000, 0), 1);
  assert.equal(countdownShare(3000, 3000, 1500), 0.5);
  assert.equal(countdownShare(3000, 3000, 4000), 0);
  assert.equal(countdownShare(3000, 0, 0), 0);
});

test("what changed since the plan was last shown: a new step, one reworded, nothing the first time", () => {
  const before = [step("Open the File menu", "done"), step("Choose Save as"), step("Check it is on the Desktop")];
  assert.deepEqual(planMarks(null, before), [null, null, null], "the first showing marks nothing");
  assert.deepEqual(planMarks(before, before), [null, null, null]);
  // Done since, or under way now: the same step.
  assert.deepEqual(planMarks(before, [step("Open the File menu", "done"), step("Choose Save as", "active"), step("Check it is on the Desktop")]),
    [null, null, null]);
  // A step put in: new, the ones after it only moved.
  assert.deepEqual(planMarks(before, [before[0], before[1], step("If it asks to replace, say Yes"), before[2]]),
    [null, null, "new", null]);
  // A step reworded in its place: changed.
  assert.deepEqual(planMarks(before, [before[0], before[1], step("Check it is in Documents")]), [null, null, "changed"]);
  // One gone and another added at the end: new.
  assert.deepEqual(planMarks(before, [before[0], before[2], step("Close Notepad")]), [null, null, "new"]);
  // A step put in and the next one reworded: each said for what it is.
  assert.deepEqual(planMarks(before, [before[0], before[1], step("If it asks to replace, say Yes"), step("Check it is in Documents")]),
    [null, null, "new", "changed"]);
  assert.deepEqual(planMarks(before, [before[0], step("Choose Save as in Documents"), step("Open the Documents folder"), before[2]]),
    [null, "changed", "new", null]);
  // A step put in at the top: the others only moved.
  assert.deepEqual(planMarks(before, [step("Look at the screen"), ...before]), ["new", null, null, null]);
  // Spaces around the words do not make it another step.
  assert.deepEqual(planMarks(before, [step(" Open the File menu "), before[1], before[2]]), [null, null, null]);
});

test("the footer: a countdown as it starts and at a step done, the buttons while paused, none once stopped", () => {
  assert.equal(computerFooter(null, "start"), null);
  assert.equal(computerFooter(state(), "start"), "start");
  assert.equal(computerFooter(state(), "step"), "step");
  assert.equal(computerFooter(state(), null), null);
  assert.equal(computerFooter(state({ paused: true }), "step"), "paused", "paused wins over the moment");
  assert.equal(computerFooter(state({ stopped: true, paused: true }), null), null);
  assert.equal(computerFooter(state({ engaged: false }), "start"), null);
});

test("the closed island's line: who, the step under way, the segments and k/n; nothing without a plan", () => {
  const parts = computerPillParts(state());
  assert.deepEqual(parts, {
    color: "#D97757", agent: "Claude Code", text: "Open the File menu", segments: ["done", "active", "pending"], place: "2/3", paused: false,
  });
  assert.equal(computerPillParts(state({ steps: [] })), null, "no plan, nothing said");
  assert.equal(computerPillParts(state({ engaged: false })), null);
  assert.equal(computerPillParts(null), null);
  assert.equal(computerPillKey(null), "");
  assert.notEqual(computerPillKey(parts), computerPillKey(computerPillParts(state({ steps: [step("a", "done"), step("b", "done"), step("c", "active")] }))));
  assert.equal(computerPillKey(parts), computerPillKey(computerPillParts(state({ since: 99, explanation: "ok" }))),
    "what the line does not show does not redraw it");
  assert.notEqual(computerPillKey(parts), computerPillKey(computerPillParts(state({ paused: true }))), "a pause redraws it (no Esc then)");
});

test("the plan's height grows with its steps up to a scroll, and with what paused adds", () => {
  const three = computerViewHeight(3, { footer: true });
  assert.equal(computerViewHeight(4, { footer: true }) - three, COMPUTER_STEP_H);
  assert.equal(computerViewHeight(COMPUTER_MAX_STEPS + 5, { footer: true }), computerViewHeight(COMPUTER_MAX_STEPS, { footer: true }),
    "a long plan scrolls inside its box");
  const paused = computerViewHeight(3, { banner: true, buttons: true });
  assert.ok(paused > three, "the banner and the buttons take more room than a countdown");
  assert.ok(computerViewHeight(3, { banner: true, buttons: true, field: true }) > paused, "the field to write in");
  assert.ok(computerViewHeight(3, { banner: true, buttons: true, note: true }) > paused, "the agent's answer");
  assert.ok(computerViewHeight(0, {}) < three, "no plan: its head alone");
});

const { afterCard, pausedPlanWaits, planLeave, planMove } = await import("../src/core/computer-plan.ts");
const { State } = await import("../src/core/state.ts");

const spot = (mode, view, extra = {}) => ({ mode, view, card: false, ...extra });

test("what a computer-state does to the island: leave, pause, resume, a reveal, or nothing", () => {
  const running = state();
  assert.equal(planMove(running, state({ engaged: false }), spot("compact", "home")), "leave");
  assert.equal(planMove(running, state({ stopped: true }), spot("expanded", "computer")), "leave");
  assert.equal(planMove(running, state({ paused: true }), spot("expanded", "prompt")), "pause");
  assert.equal(planMove(state({ paused: true }), running, spot("expanded", "settings")), "resume");
  assert.equal(planMove(null, state({ reveal: "start" }), spot("expanded", "prompt")), "reveal", "the start folds what is open");
  assert.equal(planMove(running, state({ reveal: "step" }), spot("compact", "prompt")), "reveal");
  assert.equal(planMove(running, state({ reveal: "step" }), spot("expanded", "computer")), "reveal");
  // A step done never takes over a chat (or Settings) the user opened meanwhile.
  assert.equal(planMove(running, state({ reveal: "step" }), spot("expanded", "prompt")), null);
  assert.equal(planMove(running, state({ reveal: "step" }), spot("expanded", "settings")), null);
  // A card waiting, or Lumo paused: no reveal.
  assert.equal(planMove(running, state({ reveal: "start" }), spot("compact", "home", { card: true })), null);
  assert.equal(planMove(running, state({ reveal: "start" }), spot("hidden", "home", { appPaused: true })), null);
  assert.equal(planMove(running, running, spot("compact", "home")), null);
});

test("a card answered during computer use closes the island, whoever asked: no step done would fold it", () => {
  assert.equal(afterCard(false, true, false), "collapse", "a terminal session's card: not left open on Agents");
  assert.equal(afterCard(true, true, false), "collapse");
  assert.equal(afterCard(true, true, true), "collapse");
  // Without computer use: back to who asked.
  assert.equal(afterCard(true, false, false), "prompt");
  assert.equal(afterCard(true, false, true), "live");
  assert.equal(afterCard(false, false, false), "agents");
  // Then a step done still does not take over the Agents view, were it open.
  assert.equal(planMove(state(), state({ reveal: "step" }), spot("expanded", "agents")), null);
});

test("resumed, the island closes on any view; stopped or over, it lets go and closes as it would", () => {
  assert.equal(planLeave(true, spot("expanded", "computer")), "collapse");
  assert.equal(planLeave(true, spot("expanded", "settings")), "collapse", "the user moved to Settings while paused");
  assert.equal(planLeave(true, spot("expanded", "prompt")), "fold-chat", "the chat comes back when computer use is over");
  assert.equal(planLeave(true, spot("compact", "computer")), "release");
  assert.equal(planLeave(true, spot("expanded", "approval", { card: true })), "keep");
  assert.equal(planLeave(false, spot("expanded", "computer")), "collapse");
  assert.equal(planLeave(false, spot("expanded", "prompt")), "release");
});

test("paused, the island opens on the plan, after a card and before Settings left open", () => {
  const paused = state({ paused: true });
  assert.equal(pausedPlanWaits(true, paused), true);
  assert.equal(pausedPlanWaits(false, paused), false);
  assert.equal(pausedPlanWaits(true, state()), false);
  assert.equal(pausedPlanWaits(true, state({ paused: true, stopped: true })), false);
  assert.equal(pausedPlanWaits(true, null), false);
  try {
    State.computerActive = true;
    State.computer = paused;
    State.settingsLeftOpen = true;
    assert.equal(State.defaultView(), "computer");
    assert.equal(State.openingView(), "computer");
    assert.equal(State.settingsLeftOpen, true, "Settings wait for the next opening");
    State.computer = state();
    assert.notEqual(State.defaultView(), "computer", "the agent at work: the island opens as always");
    assert.equal(State.openingView(), "settings");
  } finally {
    State.computerActive = false;
    State.computer = null;
    State.settingsLeftOpen = false;
  }
});
