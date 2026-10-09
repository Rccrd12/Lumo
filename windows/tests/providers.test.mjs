// The island's provider table (src/core/providers.ts): which model the chat
// uses, which chips the picker shows, and what a server address exposes.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PERMISSION_MODES, PROVIDERS, activeModel, effortFor, effortsFor, isCliProvider, parsePermissionMode, isLoopbackHost, pickModel, providerDef, urlExposure,
  visibleProviders, withModel,
} from "../src/core/providers.ts";
import { DEFAULT_SETTINGS } from "../src/core/state.ts";

const settings = (over = {}) => ({ ...DEFAULT_SETTINGS, ...over });

test("the ids and key names match the Rust side and the Mac", () => {
  assert.deepEqual(PROVIDERS.map((p) => p.id), ["anthropic", "claude-code", "antigravity-cli", "google", "openai", "openrouter", "ollama", "lmstudio", "custom"]);
  assert.equal(providerDef("google").key, "google-api-key");
  assert.equal(providerDef("openai").key, "openai-api-key");
  assert.equal(providerDef("openrouter").key, "openrouter-api-key");
  assert.equal(providerDef("ollama").key, null);
  assert.equal(providerDef("claude-code").key, null);
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
  assert.deepEqual(ids(settings()), ["anthropic", "claude-code", "antigravity-cli", "google", "openai", "openrouter"]);
  assert.deepEqual(ids(settings({ ollamaUrl: "http://127.0.0.1:11434" })), ["anthropic", "claude-code", "antigravity-cli", "google", "openai", "openrouter", "ollama"]);
  assert.deepEqual(ids(settings({ chatProvider: "custom" })), ["anthropic", "claude-code", "antigravity-cli", "google", "openai", "openrouter", "custom"]);
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

test("the permission modes never include one that lets everything through", () => {
  assert.deepEqual([...PERMISSION_MODES], ["default", "acceptEdits", "plan"]);
  for (const m of PERMISSION_MODES) assert.equal(parsePermissionMode(m), m);
  for (const m of ["bypassPermissions", "auto", "dontAsk", "", undefined, 3]) assert.equal(parsePermissionMode(m), "default", String(m));
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
