// The chat's commands (src/core/slash.ts): what the "/" menu offers with each
// provider, how it filters, and what Lumo runs itself.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_CODE_DEFAULT, lumoCommand, slashCommands, slashMatches, slashQuery, toolAsk, toolCommand } from "../src/core/slash.ts";

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

test("only what the provider can use is listed: Claude Code's own only with Claude Code", () => {
  for (const provider of ["anthropic", "ollama", "antigravity-cli"]) {
    const list = names(slashCommands(provider, ["compact", "review"]));
    assert.ok(!list.includes("compact"), provider);
    assert.ok(!list.includes("review"), provider);
  }
});

const pdf = { id: "pdfcraft_mcp", name: "pdfcraft_mcp", command: "pdfcraft", enabled: true, reviewed: true, params: [{ name: "path" }] };

test("a tool's command is listed with the providers that can use the user's tools", () => {
  for (const provider of ["anthropic", "openai", "google", "openrouter", "claude-code"]) {
    const c = slashCommands(provider, null, [pdf]).find((c) => c.name === "pdfcraft");
    assert.ok(c, provider);
    assert.equal(c.kind, "tool");
    assert.equal(c.text, "pdfcraft_mcp");
    assert.ok(c.args, "a tool with parameters waits for what to do");
  }
  for (const provider of ["ollama", "lmstudio", "custom", "antigravity-cli"]) {
    assert.ok(!names(slashCommands(provider, null, [pdf])).includes("pdfcraft"), provider);
  }
});

test("a tool that is off, unreviewed, missing or without a command has none in the menu", () => {
  const listed = (tool) => names(slashCommands("anthropic", null, [tool])).includes("pdfcraft");
  assert.ok(listed(pdf));
  assert.ok(!listed({ ...pdf, enabled: false }));
  assert.ok(!listed({ ...pdf, reviewed: false }));
  assert.ok(!listed({ ...pdf, missing: true }));
  assert.ok(!names(slashCommands("anthropic", null, [{ ...pdf, command: "" }])).some((n) => n === ""));
  // Lumo's own names are never a tool's; a tool's beats Claude Code's.
  assert.equal(slashCommands("anthropic", null, [{ ...pdf, command: "new" }]).filter((c) => c.name === "new").length, 1);
  const cc = slashCommands("claude-code", ["review"], [{ ...pdf, command: "review" }]).filter((c) => c.name === "review");
  assert.deepEqual(cc.map((c) => c.kind), ["tool"]);
});

test("/pdfcraft and what follows asks the AI to use that tool for it", () => {
  const called = toolCommand("/pdfcraft merge the PDF in the open folder with the one in X", "anthropic", [pdf]);
  assert.deepEqual(called, { tool: { id: "pdfcraft_mcp", name: "pdfcraft_mcp" }, rest: "merge the PDF in the open folder with the one in X" });
  const ask = toolAsk(called.tool, called.rest);
  assert.match(ask, /^Use my Lumo tool "pdfcraft_mcp" \(tool id: pdfcraft_mcp\) for this\.\n\nmerge the PDF/);
  assert.equal(toolAsk(called.tool, ""), 'Use my Lumo tool "pdfcraft_mcp" (tool id: pdfcraft_mcp) for this.');
  assert.equal(toolCommand("/pdfcraft x", "ollama", [pdf]), null, "a provider without the tools gets the text as typed");
  assert.equal(toolCommand("use /pdfcraft", "anthropic", [pdf]), null);
});

test("Claude Code's commands are the ones its last turn listed, else the usual few", () => {
  const cli = (reported) => slashCommands("claude-code", reported).filter((c) => c.kind === "cli");
  assert.deepEqual(names(cli(null)), CLAUDE_CODE_DEFAULT);
  assert.deepEqual(names(cli([])), CLAUDE_CODE_DEFAULT);
  // /clear is Lumo's /new; a name Lumo has is Lumo's; odd names and repeats are dropped.
  assert.deepEqual(names(cli(["compact", "clear", "model", "review", "review", "my-plugin:go", "../x", "a b"])), ["compact", "review", "my-plugin:go"]);
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

test("/effort opens Lumo's picker where there is an effort, in place of Claude Code's", () => {
  for (const provider of ["claude-code", "codex"]) {
    const c = slashCommands(provider, ["effort", "compact"]).filter((c) => c.name === "effort");
    assert.equal(c.length, 1, provider);
    assert.equal(c[0].kind, "lumo");
    assert.equal(lumoCommand("/effort", provider), "effort");
  }
  assert.ok(!names(slashCommands("anthropic", null)).includes("effort"));
});

test("Claude Code's commands that do nothing in the chat are left out", () => {
  const list = names(slashCommands("claude-code", ["design", "design-sync", "design-consent", "color", "heapdump", "doctor", "recap", "usage"]));
  for (const gone of ["design", "design-sync", "color", "heapdump", "usage"]) assert.ok(!list.includes(gone), gone);
  for (const kept of ["design-consent", "doctor", "recap"]) assert.ok(list.includes(kept), kept);
});
