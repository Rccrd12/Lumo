// A local model's terminal (src-tauri/src/terminal.rs): the card's words
// checked (src/core/terminal.ts), the commands an answer ran kept with the
// chat (src/core/chats.ts) and drawn above the answer (src/views/chat-messages.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import "./tauri.mjs";

installFakeDom();

const { terminalAskOf, ranCommandOf, cleanCommands, commandEnd, MAX_COMMANDS } = await import("../src/core/terminal.ts");
const { fromSavedTurn, toSavedTurn } = await import("../src/core/chats.ts");
const { bubble } = await import("../src/views/chat-messages.ts");

test("a card's terminal is read as far as it can be shown", () => {
  assert.equal(terminalAskOf(null), null);
  assert.equal(terminalAskOf("x"), null);
  assert.equal(terminalAskOf([]), null);
  assert.deepEqual(terminalAskOf({ agent: "Ollama", color: "#FACC15", internet: true, seconds: 30 }), { agent: "Ollama", color: "#FACC15", internet: true, seconds: 30 });
  // Anything odd falls back: never a colour that is CSS of its own, never no limit.
  assert.deepEqual(terminalAskOf({ agent: "", color: "red; background:url(x)", internet: "yes", seconds: -1 }), { agent: "Lumo", color: "#F5F6F8", internet: false, seconds: 120 });
});

test("a command that ran is kept as far as it can be shown, its output's end only", () => {
  assert.equal(ranCommandOf(null), null);
  assert.equal(ranCommandOf({ command: "  " }), null);
  const c = ranCommandOf({ chat: "c1", command: "python a.py", code: 0, ok: true, ms: 412.4, output: "x".repeat(5000), stopped: "no", internet: true });
  assert.equal(c.command, "python a.py");
  assert.equal(c.code, 0);
  assert.equal(c.ms, 412);
  assert.equal(c.stopped, undefined);
  assert.equal(c.internet, true);
  assert.ok(c.output.startsWith("…\n"));
  assert.ok(c.output.length < 2100);
  assert.equal("chat" in c, false, "only what the line shows");
  assert.equal(ranCommandOf({ command: "x", code: 1.5, ms: -3 }).code, undefined);
  assert.equal(ranCommandOf({ command: "x", code: 1.5, ms: -3 }).ms, 0);
  const many = Array.from({ length: MAX_COMMANDS + 5 }, (_, i) => ({ command: `echo ${i}`, ok: true, ms: 1, output: "" }));
  const kept = cleanCommands([...many, "junk", { command: 3 }]);
  assert.equal(kept.length, MAX_COMMANDS);
  assert.equal(kept.at(-1).command, `echo ${MAX_COMMANDS + 4}`, "the newest kept");
  assert.equal(cleanCommands([]), undefined);
  assert.equal(cleanCommands("x"), undefined);
});

test("how a command ended: done, refused by the sandbox, stopped, failed", () => {
  assert.equal(commandEnd({ command: "a", ok: true, ms: 1, output: "" }), "ok");
  assert.equal(commandEnd({ command: "a", ok: false, code: 1, denied: true, ms: 1, output: "" }), "denied");
  assert.equal(commandEnd({ command: "a", ok: false, stopped: true, ms: 1, output: "" }), "stopped");
  assert.equal(commandEnd({ command: "a", ok: false, code: 2, ms: 1, output: "" }), "failed");
});

test("an answer's commands are saved with the chat and come back with it", () => {
  const commands = [{ command: "python totali.py vendite.csv", code: 0, ok: true, ms: 400, output: "2026-10 15120.00" }];
  const saved = toSavedTurn({ role: "assistant", content: "Fatto.", commands });
  assert.deepEqual(saved.commands, commands);
  assert.deepEqual(fromSavedTurn(JSON.parse(JSON.stringify(saved))).commands, commands);
  // A question never carries any.
  assert.equal(toSavedTurn({ role: "user", content: "x", commands }).commands, undefined);
  assert.equal(fromSavedTurn({ role: "user", content: "x", commands }).commands, undefined);
  // None: nothing saved.
  assert.equal("commands" in toSavedTurn({ role: "assistant", content: "x", commands: [] }), false);
});

test("the commands show above the answer, each with how it ended and what it printed", () => {
  const row = bubble({
    id: 1, role: "assistant", content: "Ottobre è il mese migliore.",
    commands: [
      { command: "python totali.py vendite.csv", code: 0, ok: true, ms: 400, output: "2026-10 15120.00" },
      { command: "type C:\\Users\\me\\a.txt", code: 1, ok: false, denied: true, ms: 30, output: "Access is denied." },
      { command: "python lungo.py", ok: false, stopped: true, ms: 120_000, output: "" },
      { command: "pip install x", code: 2, ok: false, internet: true, ms: 900, output: "error" },
    ],
  });
  const wrap = row.querySelector(".reply-wrap");
  assert.equal(wrap.firstChild.className, "reply-commands", "above the answer");
  const items = row.querySelectorAll(".reply-command");
  assert.equal(items.length, 4);
  const line = (i) => items[i].querySelector(".reply-command-line").textContent;
  const state = (i) => items[i].querySelector(".reply-command-state");
  assert.equal(line(0), "python totali.py vendite.csv");
  assert.match(state(0).className, /\bok\b/);
  assert.match(state(0).textContent, /^✓ 0[.,]4 s$/);
  assert.match(state(1).className, /\bdenied\b/);
  assert.equal(state(1).textContent, "✕ Access denied");
  assert.match(state(2).className, /\bstopped\b/);
  assert.match(state(2).textContent, /Stopped after/);
  assert.equal(state(3).textContent, "✕ Exit code 2");
  assert.ok(items[3].querySelector(".reply-command-net"), "it had the internet");
  assert.equal(items[0].querySelector(".reply-command-net"), null);
  // What it printed, open; a click on the line folds it away.
  const out = items[0].querySelector(".reply-command-out");
  assert.equal(out.textContent, "2026-10 15120.00");
  assert.equal(out.hidden, false);
  items[0].querySelector(".reply-command-head").fire("click");
  assert.equal(out.hidden, true);
  // Nothing printed: no box, nothing to fold.
  assert.equal(items[2].querySelector(".reply-command-out"), null);
  assert.equal(items[2].querySelector(".reply-command-head").getAttribute("role"), null);
});
