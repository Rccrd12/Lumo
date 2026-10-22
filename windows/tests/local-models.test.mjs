// Settings → Local models under a connected Ollama or LM Studio
// (src/settings/local-models.ts), on a fake DOM through the real bridge: what
// is in memory, Free memory, and a download with its progress.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { emit, internals, sent } from "./tauri.mjs";

installFakeDom();
const { localModelsBlock, loadedText, pullPercent } = await import("../src/settings/local-models.ts");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** What the mocked Rust side answers, by command. */
const answers = {};
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : answers[cmd];
  return result;
};

test("what is in memory reads as names and sizes", () => {
  assert.equal(loadedText([]), "No model in memory.");
  assert.equal(loadedText([{ name: "llama3.2:3b", size: 3.2 * 1024 ** 3, vram: 0 }]), "llama3.2:3b · 3.2 GB");
  assert.equal(loadedText([{ name: "a", size: 0, vram: 0 }, { name: "b", size: 0, vram: 0 }]), "a, b");
  assert.equal(pullPercent({ completed: 0, total: 0 }), null);
  assert.equal(pullPercent({ completed: 50, total: 200 }), 25);
  assert.equal(pullPercent({ completed: 300, total: 200 }), 100);
});

test("Free memory unloads what the server holds, then asks again", async () => {
  let inMemory = [{ name: "qwen3:8b", size: 5 * 1024 ** 3, vram: 0 }];
  answers.local_loaded = () => inMemory;
  answers.local_unload = () => {
    inMemory = [];
    return 1;
  };
  const block = localModelsBlock("ollama");
  await flush();
  assert.deepEqual(sent("local_loaded"), [{ provider: "ollama" }]);
  assert.equal(block.querySelector(".setting-hint").textContent, "qwen3:8b · 5.0 GB");
  const free = block.find("BUTTON")[0];
  assert.equal(free.disabled, false);
  free.fire("click");
  await flush();
  await flush();
  assert.deepEqual(sent("local_unload"), [{ provider: "ollama" }]);
  assert.equal(block.querySelector(".setting-hint").textContent, "No model in memory.");
  assert.equal(free.disabled, true, "nothing left to free");
});

test("a download shows its progress, then how it ended", async () => {
  answers.local_loaded = [];
  let finish;
  answers.local_pull = () => new Promise((resolve) => (finish = resolve));
  const block = localModelsBlock("lmstudio");
  await flush();
  const input = block.find("INPUT")[0];
  input.value = "openai/gpt-oss-20b";
  const start = block.find("BUTTON")[1];
  start.fire("click");
  await flush();
  assert.deepEqual(sent("local_pull").at(-1), { provider: "lmstudio", model: "openai/gpt-oss-20b" });
  assert.equal(start.disabled, true, "one download at a time");
  assert.ok(block.querySelector(".progress.busy"), "size not known yet");
  emit("local-pull", { provider: "lmstudio", model: "openai/gpt-oss-20b", completed: 512, total: 1024 });
  assert.ok(!block.querySelector(".progress.busy"));
  assert.equal(block.querySelector(".progress").find("I")[0].getAttribute("style"), "width:50%");
  finish();
  await flush();
  await flush();
  assert.equal(block.querySelector(".progress"), null);
  assert.equal(block.querySelector(".notice.ok").textContent, "openai/gpt-oss-20b is downloaded.");
  assert.equal(start.disabled, false);
});
