// A local model's tokens and how fast (lumo-local Seen::Made → `chat-tokens`):
// said as "698 tokens · 32 tok/sec", kept with the answer, drawn on its bar
// beside Copy and Retry with its details.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import "./tauri.mjs";

installFakeDom();

const { fromSavedTurn, toSavedTurn, cleanSpeed } = await import("../src/core/chats.ts");
const { bubble, speedText, speedDetails } = await import("../src/views/chat-messages.ts");
const { State } = await import("../src/core/state.ts");
const { setLanguage } = await import("../src/i18n/i18n.ts");

const rows = (el) => el.find(".speed-row").map((r) => r.children.map((c) => c.textContent));

test("the tokens first, then the speed once there is half a second of them", () => {
  setLanguage("en");
  assert.equal(speedText({ tokens: 698, secs: 21.8 }), "698 tokens · 32 tok/sec");
  // Slow models keep a decimal.
  assert.equal(speedText({ tokens: 30, secs: 4 }), "30 tokens · 7.5 tok/sec");
  // The first tokens: only how many.
  assert.equal(speedText({ tokens: 3, secs: 0.1 }), "3 tokens");
  setLanguage("it");
  assert.equal(speedText({ tokens: 18400, secs: 400 }), "18.400 token · 46 tok/sec");
  setLanguage("en");
});

test("the details say only what is known", () => {
  setLanguage("it");
  const full = speedDetails({ tokens: 870, secs: 20, reasoning: 412, promptTokens: 18400, promptSecs: 1.2, totalSecs: 21.4 });
  assert.deepEqual(rows(full), [
    ["Ragionamento", "412 token"],
    ["Risposta", "458 token"],
    ["Velocità", "44 tok/sec"],
    ["Lettura della domanda", "18.400 token · 1,2 s"],
    ["Tempo totale", "21,4 s"],
  ]);
  assert.equal(full.find(".speed-rule").length, 1);
  // A model that doesn't reason, a server that gave no prompt count, a saved answer from before.
  assert.deepEqual(rows(speedDetails({ tokens: 120, secs: 3, reasoning: 0, promptSecs: 0.4 })), [
    ["Risposta", "120 token"],
    ["Velocità", "40 tok/sec"],
    ["Lettura della domanda", "0,4 s"],
  ]);
  const bare = speedDetails({ tokens: 120, secs: 3 });
  assert.deepEqual(rows(bare), [["Risposta", "120 token"], ["Velocità", "40 tok/sec"]]);
  assert.equal(bare.find(".speed-rule").length, 0);
  setLanguage("en");
});

test("it is kept with the answer, checked when read back", () => {
  const speed = { tokens: 120, secs: 3, reasoning: 20, promptTokens: 900, promptSecs: 0.5, totalSecs: 4 };
  const saved = toSavedTurn({ role: "assistant", content: "Fa 4.", speed });
  assert.deepEqual(saved.speed, speed);
  assert.deepEqual(fromSavedTurn(saved).speed, speed);
  // Never on a question, never what storage made up.
  assert.equal(toSavedTurn({ role: "user", content: "2+2?", speed: { tokens: 1, secs: 1 } }).speed, undefined);
  for (const bad of [null, "12", { tokens: "12", secs: 1 }, { tokens: 0, secs: 1 }, { tokens: 5, secs: -1 }, { tokens: Infinity, secs: 1 }]) {
    assert.equal(cleanSpeed(bad), undefined, JSON.stringify(bad));
  }
  // The details that don't hold are left out; reasoning never more than the tokens.
  assert.deepEqual(cleanSpeed({ tokens: 10, secs: 1, reasoning: 50, promptTokens: null, promptSecs: "1", totalSecs: -2 }), { tokens: 10, secs: 1, reasoning: 10 });
  assert.equal(fromSavedTurn({ role: "assistant", content: "x", speed: { tokens: "x" } }).speed, undefined);
});

test("on the bar beside Copy and Retry, after the time, unless Settings turned it off", () => {
  setLanguage("en");
  const message = { id: 1, role: "assistant", content: "Fa 4.", at: Date.now(), speed: { tokens: 698, secs: 21.8, reasoning: 100 } };
  const row = bubble(message, { onRetry: () => {} });
  const bar = row.querySelector(".msg-actions");
  const speed = bar.querySelector(".msg-speed");
  assert.ok(speed, "on the bar: it shows and hides with Copy and Retry");
  assert.equal(bar.children.at(-1), speed, "after the time");
  assert.equal(speed.querySelector(".msg-speed-text").textContent, "698 tokens · 32 tok/sec");
  assert.ok(speed.querySelector(".speed-details"), "its details, opened on hover");
  assert.equal(row.querySelector(".reply-speed"), null, "no line under the text once done");
  State.settings = { ...State.settings, chatTokenSpeed: false };
  assert.equal(bubble(message).querySelector(".msg-speed"), null);
  State.settings = { ...State.settings, chatTokenSpeed: true };
  // An answer from before, or a cloud model's: nothing.
  assert.equal(bubble({ id: 2, role: "assistant", content: "Ciao." }).querySelector(".msg-speed"), null);
});
