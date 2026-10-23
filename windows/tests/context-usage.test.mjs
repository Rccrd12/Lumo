// Claude Code's /context answer (src/core/context-usage.ts) and the card the
// chat draws for it (src/views/context-card.ts) instead of rows of pipes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { formatTokens, parseContextReport, parseTokens, serverName, usedPercent } = await import("../src/core/context-usage.ts");
const { renderAnswer } = await import("../src/views/context-card.ts");

// As Claude Code 2.1 answers /context, cut down.
const REPORT = `## Context Usage

**Model:** claude-haiku-5-5  
**Tokens:** 29.6k / 1m (3%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 3.7k | 0.4% |
| System tools | 8k | 0.8% |
| MCP tools | 633 | 0.1% |
| MCP server instructions | 987 | 0.1% |
| MCP tools (deferred) | 41.3k | 4.1% |
| System tools (deferred) | 15.7k | 1.6% |
| Memory files | 1.4k | 0.1% |
| Skills | 5.3k | 0.5% |
| Custom agents | 0 | 0.0% |
| Messages | 9.7k | 1.0% |
| Free space | 937.4k | 93.7% |
| Autocompact buffer | 33k | 3.3% |

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__claude_ai_Gmail__create_draft | claude_ai_Gmail | 1.8k |
| mcp__claude_ai_Gmail__reply | claude_ai_Gmail | 2k |
| mcp__claude_ai_Google_Calendar__create_event | claude_ai_Google_Calendar | 3.6k |
| mcp__lumo__screenshot | lumo | 173 |

### Memory Files

| Type | Path | Tokens |
|------|------|--------|
| Project | C:\\Users\\me\\Lumo\\CLAUDE.md | 1.4k |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| dataviz | Built-in | ~480 |
| pdf | claude.ai sync | ~150 |
| docs | claude.ai sync | ~340 |
`;

test("token counts read and written as Claude Code writes them", () => {
  assert.equal(parseTokens("29.6k"), 29600);
  assert.equal(parseTokens("1m"), 1e6);
  assert.equal(parseTokens("~480"), 480);
  assert.equal(parseTokens("1,234"), 1234);
  assert.ok(Number.isNaN(parseTokens("Tokens")));
  assert.equal(formatTokens(937400), "937.4k");
  assert.equal(formatTokens(1e6), "1m");
  assert.equal(formatTokens(633), "633");
});

test("the report: totals, the categories that take room, details by group", () => {
  const r = parseContextReport(REPORT);
  assert.equal(r.model, "claude-haiku-5-5");
  assert.equal(r.used, 29600);
  assert.equal(r.total, 1e6);
  assert.equal(r.free, 937400);
  assert.equal(usedPercent(r), "3");
  const names = r.categories.map((c) => c.name);
  assert.ok(!names.includes("Free space") && !names.includes("Custom agents"));
  assert.ok(names.includes("MCP tools (deferred)") && names.includes("Autocompact buffer"));
  const [mcp, skills, memory] = r.groups;
  assert.equal(mcp.kind, "mcp");
  assert.deepEqual(mcp.items.map((g) => [g.name, g.count, g.tokens]), [
    ["claude_ai_Gmail", 2, 3800],
    ["claude_ai_Google_Calendar", 1, 3600],
    ["lumo", 1, 173],
  ]);
  assert.deepEqual(skills.items.map((g) => g.name), ["dataviz", "docs", "pdf"]);
  assert.deepEqual(memory.items.map((g) => g.name), ["CLAUDE.md"]);
  assert.equal(serverName("claude_ai_Google_Calendar"), "Google Calendar");
  assert.equal(serverName("lumo"), "lumo");
});

test("any other answer is not a report", () => {
  assert.equal(parseContextReport("## Context Usage\n\nNo numbers here."), null);
  assert.equal(parseContextReport("The **Tokens:** 3k / 10k of my answer"), null);
  assert.equal(parseContextReport(""), null);
  assert.equal(usedPercent({ used: 4000, total: 1e6 }), "<1");
});

test("a /context answer is drawn as a card, not tables; anything else stays Markdown", () => {
  const root = document.createElement("div");
  renderAnswer(root, REPORT);
  const card = root.querySelector(".ctx-card");
  assert.ok(card);
  assert.equal(root.find(".md-p").length, 0);
  assert.equal(card.querySelector(".ctx-used").textContent, "29.6k of 1m");
  assert.equal(card.querySelector(".ctx-free").textContent, "937.4k free");
  // The bar: what is taken (deferred tools are not), a gap, the buffer at the end.
  const bar = card.querySelector(".ctx-bar");
  assert.equal(bar.find("I").length, 8);
  assert.ok(bar.children.at(-1).classList.contains("ctx-buffer"));
  // The legend, biggest first, the buffer last.
  const keys = card.find(".ctx-key-name").map((e) => e.textContent);
  assert.equal(keys[0], "Messages");
  assert.equal(keys.at(-1), "Kept free for compacting");
  assert.equal(keys.filter((k) => k === "MCP tools").length, 1);
  assert.equal(keys.length, 8);
  // Details stay folded until asked for.
  const more = card.querySelector(".ctx-more");
  const toggle = more.querySelector(".ctx-toggle");
  assert.equal(more.classList.contains("open"), false);
  toggle.fire("click");
  assert.equal(more.classList.contains("open"), true);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  const items = more.find(".ctx-item-name").map((e) => e.textContent);
  assert.ok(items.includes("Gmail") && items.includes("CLAUDE.md") && items.includes("dataviz"));
  assert.ok(more.find(".ctx-item-count").some((e) => e.textContent === "2 tools"));

  const plain = document.createElement("div");
  renderAnswer(plain, "| a | b |\n|---|---|\n| 1 | 2 |");
  assert.equal(plain.querySelector(".ctx-card"), null);
  assert.ok(plain.querySelector(".md-table"));
});
