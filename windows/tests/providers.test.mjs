// The island's provider table (src/core/providers.ts): which model the chat
// uses, which chips the picker shows, and what a server address exposes.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PERMISSION_MODES, PROVIDERS, activeModel, effortFor, effortsFor, isCliProvider, parsePermissionMode, parseSandboxLevel, permissionModesFor, isLoopbackHost, pickModel, providerDef, urlExposure,
  visibleProviders, withModel, anyProviderReady, capsContext, capsWords, contextSize, localCapsOf, setLocalCaps,
  apiCaps, hasPermissions, isApiProvider, usesLumoTools,
} from "../src/core/providers.ts";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";

const settings = (over = {}) => ({ ...DEFAULT_SETTINGS, ...over });

test("the ids and key names match the Rust side", () => {
  assert.deepEqual(PROVIDERS.map((p) => p.id), ["anthropic", "claude-code", "antigravity-cli", "codex", "copilot-cli", "cursor-cli", "google", "openai", "openrouter", "ollama", "lmstudio", "unsloth", "custom"]);
  assert.equal(providerDef("google").key, "google-api-key");
  assert.equal(providerDef("openai").key, "openai-api-key");
  assert.equal(providerDef("openrouter").key, "openrouter-api-key");
  assert.equal(providerDef("ollama").key, null);
  assert.equal(providerDef("claude-code").key, null);
  assert.equal(providerDef("codex").key, null);
  assert.equal(providerDef("copilot-cli").key, null);
  assert.equal(providerDef("cursor-cli").key, null);
  // An unknown id (an older or newer settings.json) falls back to Claude.
  assert.equal(providerDef("nope").id, "anthropic");
});

test("Claude's model is the existing setting; the others are kept per provider", () => {
  assert.equal(activeModel(settings()), "claude-opus-5-5");
  assert.equal(activeModel(settings({ chatProvider: "google" })), "gemini-2.0-flash");
  assert.equal(activeModel(settings({ chatProvider: "ollama" })), "");
  let s = withModel(settings({ chatProvider: "openai" }), "openai", "gpt-5-mini");
  assert.equal(activeModel(s), "gpt-5-mini");
  assert.equal(s.model, "claude-opus-5-5");
  s = withModel(s, "anthropic", "claude-haiku-4-5");
  assert.equal(s.model, "claude-haiku-4-5");
  assert.equal(s.chatModels.openai, "gpt-5-mini");
  // withModel never changes the object it was given.
  assert.deepEqual(DEFAULT_SETTINGS.chatModels, {});
});

test("model servers show in the picker once connected, or while in use", () => {
  const ids = (s) => visibleProviders(s).map((p) => p.id);
  assert.deepEqual(ids(settings()), ["anthropic", "claude-code", "antigravity-cli", "codex", "copilot-cli", "cursor-cli", "google", "openai", "openrouter"]);
  assert.deepEqual(ids(settings({ ollamaUrl: "http://127.0.0.1:11434" })), ["anthropic", "claude-code", "antigravity-cli", "codex", "copilot-cli", "cursor-cli", "google", "openai", "openrouter", "ollama"]);
  assert.deepEqual(ids(settings({ chatProvider: "custom" })), ["anthropic", "claude-code", "antigravity-cli", "codex", "copilot-cli", "cursor-cli", "google", "openai", "openrouter", "custom"]);
});

test("once Rust says which are set up, only those show (and the active one)", () => {
  const ready = new Set(["claude-code", "antigravity-cli"]);
  const ids = (s) => visibleProviders(s, ready).map((p) => p.id);
  // Claude Code and Antigravity set up, no key: no Anthropic, Google, OpenAI or OpenRouter.
  assert.deepEqual(ids(settings({ chatProvider: "claude-code" })), ["claude-code", "antigravity-cli"]);
  assert.deepEqual(ids(settings({ chatProvider: "claude-code", lmstudioUrl: "http://127.0.0.1:1234" })), ["claude-code", "antigravity-cli", "lmstudio"]);
  // The chat still going to a provider without its key: it shows, so the picker says where the chat goes.
  assert.deepEqual(ids(settings({ chatProvider: "anthropic" })), ["anthropic", "claude-code", "antigravity-cli"]);
  assert.equal(anyProviderReady(settings(), ready), true);
  assert.equal(anyProviderReady(settings(), new Set()), false);
  assert.equal(anyProviderReady(settings({ ollamaUrl: "http://127.0.0.1:11434" }), new Set()), true);
});

test("a CLI taken out with Show in the chat leaves the picker, unless the chat is on it", () => {
  const ready = new Set(["claude-code", "copilot-cli", "cursor-cli"]);
  const ids = (s) => visibleProviders(s, ready).map((p) => p.id);
  assert.deepEqual(ids(settings({ chatProvider: "claude-code", hiddenChatProviders: ["copilot-cli"] })), ["claude-code", "cursor-cli"]);
  assert.deepEqual(ids(settings({ chatProvider: "copilot-cli", hiddenChatProviders: ["copilot-cli"] })), ["claude-code", "copilot-cli", "cursor-cli"]);
  assert.equal(anyProviderReady(settings({ hiddenChatProviders: ["copilot-cli"] }), new Set(["copilot-cli"])), false);
});

test("the saved model is kept when offered, else a sensible one is picked", () => {
  const google = providerDef("google");
  assert.equal(pickModel(google, ["gemini-2.5-pro", "gemini-2.0-flash"], "gemini-2.5-pro"), "gemini-2.5-pro");
  assert.equal(pickModel(google, ["gemini-2.5-pro", "gemini-2.5-flash"], "gone"), "gemini-2.5-flash");
  assert.equal(pickModel(providerDef("openai"), ["gpt-4o", "gpt-5-mini"], "gone"), "gpt-5-mini");
  assert.equal(pickModel(providerDef("ollama"), ["llama3.2", "qwen"], ""), "llama3.2");
  assert.equal(pickModel(providerDef("openrouter"), ["a/b", "openrouter/auto"], "gone"), "openrouter/auto");
  assert.equal(pickModel(google, [], "x"), null);
  // An alias saved by an older version becomes the current model it named.
  const cc = providerDef("claude-code");
  const offered = ["default", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
  assert.equal(pickModel(cc, offered, "haiku"), "claude-haiku-5-5");
  assert.equal(pickModel(cc, offered, "opus"), "claude-opus-5-5");
  // Antigravity CLI: "Default" (agy's own choice) when the saved one is gone.
  const agy = providerDef("antigravity-cli");
  assert.equal(pickModel(agy, ["default", "gemini-3-pro", "gemini-3-flash"], "gemini-3-flash"), "gemini-3-flash");
  assert.equal(pickModel(agy, ["default", "gemini-3-pro"], "gone"), "default");
  assert.equal(activeModel(settings({ chatProvider: "antigravity-cli" })), "default");
});

test("Antigravity CLI is a keyless CLI whose models carry their effort", () => {
  const agy = providerDef("antigravity-cli");
  assert.equal(agy.name, "Antigravity CLI");
  assert.equal(agy.key, null);
  assert.equal(agy.urlField, null);
  assert.equal(agy.accent, "#E879F9", "the Antigravity pill's colour");
  for (const id of ["claude-code", "antigravity-cli"]) assert.ok(isCliProvider(id), id);
  for (const id of ["anthropic", "google", "openai", "openrouter", "ollama", "custom"]) assert.ok(!isCliProvider(id), id);
  assert.deepEqual(effortsFor("antigravity-cli"), [], "agy's model names carry the effort");
  assert.deepEqual(effortsFor("claude-code"), ["", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(effortsFor("openai"), []);
  assert.equal(effortFor("antigravity-cli", "high"), "");
  assert.equal(effortFor("claude-code", "max"), "max");
  assert.equal(effortFor("openai", "high"), "");
  assert.equal(effortFor("claude-code", undefined), "");
});

test("Codex is a keyless CLI with its own efforts, and never Turbo", () => {
  const codex = providerDef("codex");
  assert.equal(codex.name, "Codex");
  assert.equal(codex.key, null);
  assert.equal(codex.accent, "#2DD4BF", "the Codex pill's colour");
  assert.ok(isCliProvider("codex"));
  assert.deepEqual(effortsFor("codex"), ["", "low", "medium", "high", "xhigh"]);
  // Copilot CLI and Cursor CLI are CLIs too: Copilot takes --effort, Cursor's models carry theirs.
  assert.ok(isCliProvider("copilot-cli") && isCliProvider("cursor-cli"));
  assert.deepEqual(effortsFor("copilot-cli"), ["", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(effortsFor("cursor-cli"), []);
  assert.equal(effortFor("codex", "max"), "", "Claude Code's Max is no Codex effort");
  assert.equal(effortFor("codex", "xhigh"), "xhigh");
  assert.deepEqual(permissionModesFor("codex"), ["default", "auto", "plan"]);
  assert.equal(parsePermissionMode("turbo", "codex"), "default");
});

test("every CLI has the same three modes; Turbo, picked before, is Auto with Antigravity CLI only", () => {
  assert.deepEqual(permissionModesFor("claude-code"), ["default", "auto", "plan"]);
  assert.deepEqual(permissionModesFor("antigravity-cli"), ["default", "auto", "plan"]);
  for (const m of ["default", "auto", "plan"]) assert.equal(parsePermissionMode(m, "claude-code"), m);
  for (const m of ["default", "auto", "plan"]) assert.equal(parsePermissionMode(m, "antigravity-cli"), m);
  assert.equal(parsePermissionMode("turbo", "antigravity-cli"), "auto", "Turbo became Auto");
  assert.equal(parsePermissionMode("turbo", "claude-code"), "default", "Turbo asks with Claude Code");
  assert.equal(parsePermissionMode("turbo", "openai"), "default");
  assert.equal(parsePermissionMode("acceptEdits", "claude-code"), "auto", "picked before Auto replaced it");
  for (const m of ["bypassPermissions", "dontAsk", "", undefined, 3]) {
    assert.equal(parsePermissionMode(m, "antigravity-cli"), "default", String(m));
  }
});

test("an API provider's model offers the reasoning levels its list says", () => {
  assert.ok(isApiProvider("google") && isApiProvider("anthropic") && !isApiProvider("claude-code") && !isApiProvider("ollama"));
  assert.equal(apiCaps(undefined), null);
  setLocalCaps("google", apiCaps({ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", reasoning: ["low", "medium", "high"], context: 1_048_576 }));
  assert.deepEqual(effortsFor("google"), ["", "low", "medium", "high"]);
  assert.equal(localCapsOf("google").maxContext, 1_048_576);
  assert.equal(effortFor("google", "high"), "high");
  assert.equal(effortFor("google", "max"), "", "Claude Code's max is not Gemini's: Auto");
  setLocalCaps("google", apiCaps({ id: "gemini-2.0-flash", label: "Gemini 2.0 Flash" }));
  assert.deepEqual(effortsFor("google"), [], "a model that doesn't reason: no slider");
  setLocalCaps("google", null);
});

test("the model servers and the API providers add Run automatically; with a CLI it asks every time", () => {
  assert.deepEqual(PERMISSION_MODES, ["default", "auto", "off", "plan"]);
  for (const p of PROVIDERS) {
    const want = p.urlField !== null || p.key !== null ? ["default", "auto", "off", "plan"] : ["default", "auto", "plan"];
    assert.deepEqual(permissionModesFor(p.id), want, p.id);
  }
  for (const id of ["ollama", "lmstudio", "unsloth", "custom", "anthropic", "google", "openai", "openrouter"]) {
    for (const m of PERMISSION_MODES) assert.equal(parsePermissionMode(m, id), m, `${m} with ${id}`);
    assert.ok(hasPermissions(id) && usesLumoTools(id), id);
  }
  for (const id of ["claude-code", "antigravity-cli", "codex", "copilot-cli", "cursor-cli"]) {
    assert.equal(parsePermissionMode("off", id), "default", id);
    assert.ok(hasPermissions(id) && !usesLumoTools(id), id);
  }
  assert.equal(parsePermissionMode("turbo", "ollama"), "default");
  assert.equal(parsePermissionMode("acceptEdits", "ollama"), "auto");
});

test("the local sandbox is High unless Low was picked", () => {
  assert.equal(DEFAULT_SETTINGS.localSandbox, "high");
  assert.equal(parseSandboxLevel("low"), "low");
  assert.equal(parseSandboxLevel("high"), "high");
  for (const v of ["", "Low", "off", undefined, null, 0]) assert.equal(parseSandboxLevel(v), "high", String(v));
});

test("loopback hosts match net.rs", () => {
  for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.9.9.9", "[::1]", "::1", "0.0.0.0", "[::]"]) {
    assert.ok(isLoopbackHost(host), host);
  }
  for (const host of ["example.com", "192.168.1.2", "localhost.example.com", "128.0.0.1", "[2001:db8::1]"]) {
    assert.ok(!isLoopbackHost(host), host);
  }
});

test("an address says whether what you type leaves this computer", () => {
  assert.equal(urlExposure(""), "local");
  assert.equal(urlExposure("http://localhost:11434"), "local");
  assert.equal(urlExposure("127.0.0.1:1234/v1"), "local");
  assert.equal(urlExposure("http://[::1]:8000"), "local");
  assert.equal(urlExposure("https://llm.example.com"), "remote");
  assert.equal(urlExposure("http://gpu-box.lan:8000"), "remote-http");
  assert.equal(urlExposure("192.168.1.20:8000"), "remote-http");
  assert.equal(urlExposure("ftp://example.com"), "invalid");
  assert.equal(urlExposure("http://user:pw@example.com"), "invalid");
  assert.equal(urlExposure("http://"), "invalid");
});

test("a local model's caps: the reasoning levels it takes become its efforts, and its line says what it can do", () => {
  const caps = { vision: true, tools: true, reasoning: ["off", "on"], maxContext: 262144, loadedContext: 65536 };
  assert.deepEqual(effortsFor("lmstudio"), []);
  setLocalCaps("lmstudio", caps);
  assert.equal(localCapsOf("lmstudio"), caps);
  assert.deepEqual(effortsFor("lmstudio"), ["", "off", "on"]);
  assert.equal(effortFor("lmstudio", "on"), "on");
  assert.equal(effortFor("lmstudio", "max"), "", "a level the model doesn't take is its own default");
  assert.deepEqual(effortsFor("ollama"), [], "each server its own");
  assert.deepEqual(capsWords(caps), ["Images", "Tools", "Thinking"]);
  assert.equal(capsContext(caps), "64k / 256k");
  setLocalCaps("lmstudio", null);
  assert.deepEqual(effortsFor("lmstudio"), []);

  // A server that says nothing: no words, no levels.
  const none = { vision: null, tools: null, reasoning: [], maxContext: 0, loadedContext: 0 };
  assert.deepEqual(capsWords(none), []);
  assert.equal(capsContext(none), "");
  assert.deepEqual(capsWords(undefined), []);
  assert.equal(capsContext({ ...none, maxContext: 131072 }), "128k");
  assert.equal(contextSize(4096), "4k");
  assert.equal(contextSize(1048576), "1M");
  assert.equal(contextSize(512), "512");
});
