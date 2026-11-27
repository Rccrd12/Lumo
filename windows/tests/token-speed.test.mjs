// A local model's tokens and how fast (lumo-local Seen::Made → `chat-tokens`):
// said as "32 tok/s · 698 tokens", kept with the answer, drawn under it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import "./tauri.mjs";

installFakeDom();

const { fromSavedTurn, toSavedTurn, cleanSpeed } = await import("../src/core/chats.ts");
const { bubble, speedText } = await import("../src/views/chat-messages.ts");
const { State } = await import("../src/core/state.ts");
const { setLanguage } = await import("../src/i18n/i18n.ts");

test("the speed is the tokens over the seconds, once there is half a second of them", () => {
  setLanguage("en");
  assert.equal(speedText({ tokens: 698, secs: 21.8 }), "32 tok/s · 698 tokens");
  // Slow models keep a decimal.
  assert.equal(speedText({ tokens: 30, secs: 4 }), "7.5 tok/s · 30 tokens");
  // The first tokens: only how many.
  assert.equal(speedText({ tokens: 3, secs: 0.1 }), "3 tokens");
  assert.equal(speedText({ tokens: 1, secs: 2 }), "1 tokens");
  setLanguage("it");
  assert.equal(speedText({ tokens: 18400, secs: 400 }), "46 tok/s · 18.400 token");
  setLanguage("en");
});

test("it is kept with the answer, checked when read back", () => {
  const saved = toSavedTurn({ role: "assistant", content: "Fa 4.", speed: { tokens: 120, secs: 3 } });
  assert.deepEqual(saved.speed, { tokens: 120, secs: 3 });
  assert.deepEqual(fromSavedTurn(saved).speed, { tokens: 120, secs: 3 });
  // Never on a question, never what storage made up.
  assert.equal(toSavedTurn({ role: "user", content: "2+2?", speed: { tokens: 1, secs: 1 } }).speed, undefined);
  for (const bad of [null, "12", { tokens: "12", secs: 1 }, { tokens: 0, secs: 1 }, { tokens: 5, secs: -1 }, { tokens: Infinity, secs: 1 }]) {
    assert.equal(cleanSpeed(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(fromSavedTurn({ role: "assistant", content: "x", speed: { tokens: "x" } }).speed, undefined);
});

test("the line is under the answer's text, unless Settings turned it off", () => {
  setLanguage("en");
  const message = { id: 1, role: "assistant", content: "Fa 4.", speed: { tokens: 698, secs: 21.8 } };
  const row = bubble(message);
  const line = row.querySelector(".reply-speed");
  assert.ok(line, "a line");
  assert.equal(line.textContent, "32 tok/s · 698 tokens");
  const wrap = row.querySelector(".reply-wrap");
  const kids = [...wrap.children];
  assert.equal(kids.indexOf(line), kids.indexOf(row.querySelector(".reply")) + 1, "right under the text");
  State.settings = { ...State.settings, chatTokenSpeed: false };
  assert.equal(bubble(message).querySelector(".reply-speed"), null);
  State.settings = { ...State.settings, chatTokenSpeed: true };
  // An answer from before, or a cloud model's: no line.
  assert.equal(bubble({ id: 2, role: "assistant", content: "Ciao." }).querySelector(".reply-speed"), null);
});
