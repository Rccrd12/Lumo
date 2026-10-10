// The right-click menu's items and text actions (src/core/context-menu.ts).

import { test } from "node:test";
import assert from "node:assert/strict";

const { DEFAULT_MENU, MENU_ITEMS, pickedItems, textActions, withItem } = await import("../src/core/context-menu.ts");

test("the picked items come in the menu's order, known ones only, each once", () => {
  assert.deepEqual(pickedItems(["settings", "pin", "nonsense", "pin"]).map((i) => i.id), ["pin", "settings"]);
  assert.deepEqual(pickedItems(undefined).map((i) => i.id), DEFAULT_MENU, "settings written before it");
  assert.deepEqual(pickedItems([]), [], "all turned off stays off");
  for (const id of DEFAULT_MENU) assert.ok(MENU_ITEMS.some((i) => i.id === id), id);
});

test("a switch in Settings adds or takes out one item, keeping the order", () => {
  assert.deepEqual(withItem(["settings"], "newChat", true), ["newChat", "settings"]);
  assert.deepEqual(withItem(["newChat", "settings"], "newChat", false), ["settings"]);
  assert.deepEqual(withItem(["settings"], "settings", true), ["settings"]);
});

test("the text actions are only those that apply", () => {
  assert.deepEqual(textActions({ editable: true, selected: true, hasText: true }), ["cut", "copy", "paste", "selectAll"]);
  assert.deepEqual(textActions({ editable: true, selected: false, hasText: false }), ["paste"]);
  assert.deepEqual(textActions({ editable: false, selected: true, hasText: false }), ["copy"]);
  assert.deepEqual(textActions({ editable: false, selected: false, hasText: false }), []);
});
