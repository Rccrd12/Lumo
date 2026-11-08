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

test("Unsloth Studio shows what is in memory and Free memory, with no download row", async () => {
  let inMemory = [{ name: "unsloth/Qwen3-8B-GGUF", size: 0, vram: 0 }];
  answers.local_loaded = () => inMemory;
  answers.local_unload = () => {
    inMemory = [];
    return 1;
  };
  const block = localModelsBlock("unsloth");
  await flush();
  assert.equal(sent("local_loaded").at(-1)?.provider, "unsloth");
  assert.equal(block.querySelector(".setting-hint").textContent, "unsloth/Qwen3-8B-GGUF");
  assert.equal(block.find("INPUT").length, 0, "no download input for Unsloth Studio");
  const buttons = block.find("BUTTON");
  assert.equal(buttons.length, 1, "only Free memory button");
  buttons[0].fire("click");
  await flush();
  await flush();
  assert.equal(sent("local_unload").at(-1)?.provider, "unsloth");
  assert.equal(block.querySelector(".setting-hint").textContent, "No model in memory.");
  assert.equal(buttons[0].disabled, true);
});

/** Unsloth Studio as Lumo starts and stops it (settings/main.ts), with what each button did. */
function fakeStudio(row) {
  const studio = {
    row,
    started: 0,
    stopped: 0,
    refresh: () => {},
    describe: async (reachable, live) => (live?.state === "starting" ? { starting: "Starting Unsloth Studio…", seconds: `${live.seconds} s` } : studio.row(reachable)),
    start: async () => { studio.started += 1; },
    stop: async () => { studio.stopped += 1; },
  };
  return studio;
}

test("Unsloth Studio off and startable: Off with Start now, not the error", async () => {
  answers.local_loaded = () => Promise.reject("Cannot reach http://127.0.0.1:8888. Is the server running?");
  const studio = fakeStudio((reachable) => (reachable ? null : { off: "Off: it starts when you use it in the chat.", start: "Start now" }));
  const block = localModelsBlock("unsloth", studio);
  await flush();
  await flush();
  assert.equal(block.querySelector(".notice.err"), null, "no red box while Lumo can start it");
  assert.equal(block.querySelector(".setting-hint").textContent, "Off: it starts when you use it in the chat.");
  const [start, free, stop] = block.find("BUTTON");
  assert.equal(start.hidden, false);
  assert.equal(start.textContent, "Start now");
  assert.equal(free.disabled, true);
  assert.equal(stop.hidden, true);
  start.fire("click");
  await flush();
  assert.equal(studio.started, 1);
});

test("Unsloth Studio starting shows the seconds and a bar, then what is in memory once on", async () => {
  let up = false;
  answers.local_loaded = () => (up ? [{ name: "unsloth/gemma-4-26b-GGUF", size: 0, vram: 0 }] : Promise.reject("Cannot reach it."));
  const studio = fakeStudio((reachable) => (reachable ? { line: "Started by Lumo: it stops after 15 minutes with no question.", stop: "Stop now" } : { off: "Off.", start: "Start now" }));
  const block = localModelsBlock("unsloth", studio);
  await flush();
  await flush();
  emit("unsloth-studio", { installed: true, state: "starting", owned: true, seconds: 4 });
  await flush();
  assert.ok(block.querySelector(".progress.busy"));
  assert.ok(block.find("SPAN").some((s) => s.textContent === "4 s"));
  up = true;
  emit("unsloth-studio", { installed: true, state: "on", owned: true, seconds: 0 });
  await flush();
  await flush();
  assert.equal(block.querySelector(".progress"), null);
  assert.equal(block.querySelector(".setting-hint").textContent, "unsloth/gemma-4-26b-GGUF");
  assert.equal(block.querySelector(".hint").textContent, "Started by Lumo: it stops after 15 minutes with no question.");
  const [start, , stop] = block.find("BUTTON");
  assert.equal(start.hidden, true);
  assert.equal(stop.hidden, false);
  stop.fire("click");
  await flush();
  assert.equal(studio.stopped, 1);
});

test("Unsloth Studio Lumo can't start keeps the error as before", async () => {
  answers.local_loaded = () => Promise.reject("Cannot reach http://127.0.0.1:8888. Is the server running?");
  const block = localModelsBlock("unsloth", fakeStudio(() => null));
  await flush();
  await flush();
  assert.equal(block.querySelector(".notice.err").textContent, "Cannot reach http://127.0.0.1:8888. Is the server running?");
});
