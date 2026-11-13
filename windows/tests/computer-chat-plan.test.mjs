// A plan sent through the chat for no chat of its own (Gemini Live's computer
// use helper, `chat: ""`) is not given to the chat on screen
// (src/island/plan.ts); one naming no chat at all still is.

import { test } from "node:test";
import assert from "node:assert/strict";
import { emit } from "./tauri.mjs";
import { IslandPlan } from "../src/island/plan.ts";
import { State } from "../src/core/state.ts";

const plan = new IslandPlan({ changed() {} });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const todos = (...items) => ({ todos: items.map((content) => ({ content, status: "in_progress", activeForm: content })) });

test("a plan whose chat is there but empty lands in no chat; one naming none goes to the chat on screen", async () => {
  await flush(); // the event's listener is in place
  State.chatId = "on-screen";
  emit("chat-plan", { chat: "", tool: "update_plan", input: { plan: [{ step: "Open Settings", status: "in_progress" }] } });
  assert.equal(plan.book.get("chat|on-screen"), undefined, "the chat on screen keeps its own");
  assert.equal(plan.plans().length, 0);
  // An older sender with no chat key at all still falls back to the chat on screen.
  emit("chat-plan", { tool: "TodoWrite", input: todos("Answer") });
  assert.ok(plan.book.get("chat|on-screen"));
  plan.forgetChat("on-screen");
});
