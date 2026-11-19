// Claude Code's and the Antigravity CLI's models by the names people say
// (src/core/model-names.ts).

import { test } from "node:test";
import assert from "node:assert/strict";

const { cliModelName, prettyModel } = await import("../src/core/model-names.ts");

test("a model's id reads as its name", () => {
  assert.equal(prettyModel("claude-opus-5-5", true), "Opus 5.5");
  assert.equal(prettyModel("claude-sonnet-4-5-20250929", true), "Sonnet 4.5", "the date at its end is left out");
  assert.equal(prettyModel("claude-opus-5-5[1m]", true), "Opus 5.5 1M");
  assert.equal(prettyModel("opus", true), "Opus");
  assert.equal(prettyModel("gemini-4-hydrogen"), "Gemini 4 Hydrogen");
  assert.equal(prettyModel("gemini-3.8-flash"), "Gemini 3.8 Flash");
  assert.equal(prettyModel("gemini-pro-orchestrator-g1-pro"), "Gemini Pro Orchestrator G1 Pro");
  assert.equal(prettyModel("gpt-oss-120b"), "GPT OSS 120b");
  assert.equal(prettyModel("claude-sonnet-4-5"), "Claude Sonnet 4.5", "agy keeps whose model it is");
  assert.equal(prettyModel("Already Named"), "Already Named");
});

test("the button takes the CLI's own name for a model, and leaves other providers alone", () => {
  assert.equal(cliModelName("claude-code", "default", "Default (Opus 5.5)"), "Default (Opus 5.5)");
  assert.equal(cliModelName("claude-code", "default"), "Default");
  assert.equal(cliModelName("claude-code", "claude-haiku-5-5"), "Haiku 5.5");
  assert.equal(cliModelName("antigravity-cli", "gemini-4-argon", "gemini-4-argon"), "Gemini 4 Argon", "agy lists its ids as names");
  assert.equal(cliModelName("anthropic", "claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(cliModelName("ollama", "llama3.2:3b"), "llama3.2:3b");
});
