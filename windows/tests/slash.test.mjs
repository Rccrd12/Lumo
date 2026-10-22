// The chat's commands (src/core/slash.ts): what the "/" menu offers with each
// provider, how it filters, and what Lumo runs itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_CODE_DEFAULT, lumoCommand, slashCommands, slashMatches, slashQuery } from "../src/core/slash.ts";

const names = (list) => list.map((c) => c.name);

test("the menu only has business with a slash first and no space yet", () => {
  assert.equal(slashQuery("/"), "");
  assert.equal(slashQuery("/Co"), "co");
  assert.equal(slashQuery(" /co"), null);
  assert.equal(slashQuery("hello /co"), null);
  assert.equal(slashQuery("/timer 10m"), null);
  assert.equal(slashQuery("/timer\n"), null);
  assert.equal(slashQuery(""), null);
});

test("Lumo's commands are there with every provider, the shield only with the CLIs", () => {
  for (const provider of ["anthropic", "openai", "ollama", "antigravity-cli", "claude-code"]) {
    const list = names(slashCommands(provider, null));
    for (const name of ["new", "history", "model", "attach", "screen", "timer"]) assert.ok(list.includes(name), `${provider}: ${name}`);
    assert.equal(list.includes("permissions"), provider === "claude-code" || provider === "antigravity-cli", provider);
  }
});

test("without Claude Code, /compact shows greyed and says why", () => {
  for (const provider of ["anthropic", "ollama", "antigravity-cli"]) {
    const compact = slashCommands(provider, ["compact", "review"]).filter((c) => c.name === "compact");
    assert.equal(compact.length, 1);
    assert.ok(compact[0].off, provider);
    assert.ok(!names(slashCommands(provider, ["review"])).includes("review"), "Claude Code's own stay Claude Code's");
  }
});

test("Claude Code's commands are the ones its last turn listed, else the usual few", () => {
  const cli = (reported) => slashCommands("claude-code", reported).filter((c) => c.kind === "cli");
  assert.deepEqual(names(cli(null)), CLAUDE_CODE_DEFAULT);
  assert.deepEqual(names(cli([])), CLAUDE_CODE_DEFAULT);
  // /clear is Lumo's /new; a name Lumo has is Lumo's; odd names and repeats are dropped.
  assert.deepEqual(names(cli(["compact", "clear", "model", "review", "review", "my-plugin:go", "../x", "a b"])), ["compact", "review", "my-plugin:go"]);
  assert.ok(cli(["compact"]).every((c) => !c.off));
});

test("typing filters: names starting with it first, then those containing it", () => {
  const list = slashCommands("claude-code", ["compact", "context", "pr-comments"]);
  assert.deepEqual(names(slashMatches(list, "co")), ["compact", "context", "pr-comments"]);
  assert.deepEqual(names(slashMatches(list, "COM")), ["compact", "pr-comments"]);
  assert.deepEqual(names(slashMatches(list, "zzz")), []);
  assert.equal(slashMatches(list, "").length, list.length);
});

test("Lumo's own commands typed in full run in Lumo; the rest goes to the AI", () => {
  assert.equal(lumoCommand("/new", "anthropic"), "new");
  assert.equal(lumoCommand(" /Model ", "ollama"), "model");
  assert.equal(lumoCommand("/permissions", "anthropic"), null, "no shield without a CLI");
  assert.equal(lumoCommand("/permissions", "claude-code"), "permissions");
  assert.equal(lumoCommand("/timer", "anthropic"), null, "the timer waits for its duration");
  assert.equal(lumoCommand("/new chat please", "anthropic"), null);
  assert.equal(lumoCommand("/compact", "claude-code"), null);
  assert.equal(lumoCommand("new", "anthropic"), null);
});
