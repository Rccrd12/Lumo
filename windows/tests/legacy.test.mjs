// The pages' storage under the app's old name (src/core/legacy.ts) moves to Lumo's keys once.

import { test } from "node:test";
import assert from "node:assert/strict";

const { moveOldStorage, OLD_PREFIX: OLD } = await import("../src/core/legacy.ts");

function storage(entries) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  };
}

test("old keys move, and never over what Lumo already has", () => {
  const s = storage({ [`${OLD}chats.v1`]: "[old]", [`${OLD}settings.page`]: "voice", "lumo.settings.page": "chat", other: "x" });
  moveOldStorage(s);
  assert.deepEqual(Object.fromEntries(s.map), { "lumo.chats.v1": "[old]", "lumo.settings.page": "chat", other: "x" });
  moveOldStorage(s);
  assert.equal(s.map.size, 3, "a second run changes nothing");
  moveOldStorage(null);
});
