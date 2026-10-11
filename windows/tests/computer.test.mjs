// The chat's computer use, as the Allow / Deny card says it (src/core/computer.ts).

import { test } from "node:test";
import assert from "node:assert/strict";

const { describeComputerAction, isComputerTool } = await import("../src/core/computer.ts");
const { setLanguage } = await import("../src/i18n/i18n.ts");

const say = (name, input = {}) => describeComputerAction(`mcp__lumo__${name}`, input);

test("only Lumo's own tools are described", () => {
  assert.ok(isComputerTool("mcp__lumo__left_click"));
  assert.ok(!isComputerTool("mcp__github__create_issue"));
  assert.ok(!isComputerTool("Bash"));
  assert.equal(describeComputerAction("mcp__github__create_issue", {}), null);
  assert.equal(say("format_disk"), null);
  // Antigravity CLI's own way of naming them.
  assert.equal(describeComputerAction("mcp_lumo_left_click", { coordinate: [3, 4] }), "Click · 3, 4");
  assert.equal(describeComputerAction("lumo/type", { text: "hi" }), "Type · hi");
  assert.equal(describeComputerAction("mcp__lumo2__type", { text: "hi" }), null);
});

test("clicks say where, and the keys held", () => {
  assert.equal(say("left_click", { coordinate: [640, 320] }), "Click · 640, 320");
  assert.equal(say("double_click", { coordinate: [1, 2], text: "shift" }), "Double click · 1, 2 (shift)");
  assert.equal(say("right_click"), "Right click · where the mouse is");
  assert.equal(say("left_click_drag", { start_coordinate: [10, 10], coordinate: [200, 50] }), "Drag · 10, 10 → 200, 50");
  assert.equal(say("scroll", { scroll_direction: "down", scroll_amount: 5, coordinate: [300, 400] }), "Scroll down · 300, 400 ×5");
  assert.equal(say("mouse_move", { coordinate: [5, 6] }), "Move the mouse · 5, 6");
});

test("typed text and keys are shown, long text cut on one line", () => {
  assert.equal(say("type", { text: "Hello\n  world" }), "Type · Hello world");
  const long = say("type", { text: "x".repeat(500) });
  assert.ok(long.endsWith("…") && long.length < 140, long);
  assert.equal(say("key", { text: "ctrl+s" }), "Press · ctrl+s");
  assert.equal(say("key", { text: "Tab", repeat: 3 }), "Press · Tab ×3");
});

test("looking needs no detail", () => {
  assert.equal(say("screenshot"), "Look at the screen");
  assert.equal(say("zoom", { region: [0, 0, 10, 10] }), "Look closer at the screen");
  assert.equal(say("wait", { duration: 2 }), "Wait");
});

test("the card speaks the interface language", () => {
  setLanguage("it");
  try {
    assert.equal(say("left_click", { coordinate: [1, 2] }), "Clic · 1, 2");
    assert.equal(say("scroll", { scroll_direction: "up" }), "Scorri su · dove si trova il mouse");
  } finally {
    setLanguage("en");
  }
});
