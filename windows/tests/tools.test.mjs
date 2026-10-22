// The user's own tools and the tool workshop's drafts (src/core/tools.ts):
// the AI hands a tool over as a lumo-tool block and lumo-file blocks, which
// the workshop reads back, shows as one line, and writes again to change it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WORKSHOP_PREFIX, blocksOf, commandName, draftIn, draftKey, draftOf, isAbsolutePath, isWorkshopChat, latestDraft, reviewState, stripDraft,
  toolId, tryInput, userToolTarget, workshopTool,
} from "../src/core/tools.ts";
import { State } from "../src/core/state.ts";

const FENCE = "```";

const answer = [
  "Here is the benchmark tool: it times your CPU.",
  "",
  `${FENCE}lumo-tool`,
  JSON.stringify({
    name: "Benchmark del PC",
    description: "Measures the PC.",
    entry: "bench.py",
    params: [{ name: "quick", type: "boolean", description: "Short run", required: false }, { name: "bad name", type: "string" }],
    permissions: ["read", "everything", "Network"],
    timeout: 9000,
  }),
  FENCE,
  "",
  `${FENCE}lumo-file bench.py`,
  "import time",
  "print('score', 42)",
  FENCE,
  "",
  "Try it, then save it.",
].join("\n");

test("a workshop answer hands over a tool: its manifest and its files", () => {
  const d = draftIn(answer);
  assert.equal(d.name, "Benchmark del PC");
  assert.equal(d.entry, "bench.py");
  assert.deepEqual(d.params.map((p) => [p.name, p.type, p.required]), [["quick", "boolean", false]]);
  assert.deepEqual(d.permissions, ["network", "read"], "known ones only, in order");
  assert.equal(d.timeout, 600);
  assert.deepEqual(d.files, [{ name: "bench.py", content: "import time\nprint('score', 42)\n" }]);
  assert.equal(draftIn("just words"), null);
  assert.equal(draftIn(`${FENCE}lumo-tool\nnot json\n${FENCE}`), null);
});

test("the chat shows the words, the blocks as one line, and a block being written as nothing yet", () => {
  const shown = stripDraft(answer);
  assert.equal(shown.text, "Here is the benchmark tool: it times your CPU.\n\nTry it, then save it.");
  assert.ok(shown.draft && !shown.writing);
  const half = stripDraft(`Making it.\n\n${FENCE}lumo-tool\n{"name": "Ben`);
  assert.deepEqual(half, { text: "Making it.", draft: false, writing: true });
  assert.deepEqual(stripDraft("Plain answer with ```js\ncode\n```"), { text: "Plain answer with ```js\ncode\n```", draft: false, writing: false });
});

test("the newest draft wins; a file it leaves out comes from the answer that last gave it", () => {
  const second = [
    `${FENCE}lumo-tool`,
    JSON.stringify({ name: "Benchmark", description: "Faster.", entry: "bench.py", params: [], permissions: [] }),
    FENCE,
  ].join("\n");
  const d = latestDraft([
    { role: "user", content: "make a benchmark" },
    { role: "assistant", content: answer },
    { role: "user", content: "rename it" },
    { role: "assistant", content: second },
    { role: "user", content: "thanks" },
  ]);
  assert.equal(d.name, "Benchmark");
  assert.equal(d.files.length, 1);
  assert.match(d.files[0].content, /score/);
  assert.equal(latestDraft([{ role: "user", content: answer }]), null, "only the AI's answers hand tools over");
});

test("a script already on the computer runs where it is, with no file of its own", () => {
  const d = draftIn(`${FENCE}lumo-tool\n${JSON.stringify({ name: "Backup", entry: "C:\\Scripts\\backup.ps1" })}\n${FENCE}`);
  assert.equal(d.entry, "C:\\Scripts\\backup.ps1");
  assert.ok(isAbsolutePath(d.entry));
  assert.ok(!isAbsolutePath("bench.py"));
});

test("a saved tool written back as blocks reads as the same draft, a file with fences of its own included", () => {
  const tool = {
    id: "notes", name: "Notes", description: "Writes notes.", entry: "notes.py", args: ["--title", "{title}"],
    params: [{ name: "title", type: "string", description: "", required: true }], permissions: ["write"],
    enabled: true, timeout: 30, created: 1, updated: 2, dir: "C:\\x", files: ["notes.py", "README.md"], missing: false,
  };
  const files = [
    { name: "notes.py", content: "print('ok')\n" },
    { name: "README.md", content: "Use it:\n```\nnotes.py --title x\n```\n" },
  ];
  const seed = draftOf(tool, files);
  assert.equal(seed.replaces, "notes");
  const back = draftIn(`Here it is.\n\n${blocksOf(seed)}`);
  assert.equal(draftKey(back), draftKey({ ...seed, replaces: undefined }));
});

test("the try fields become the tool's input: numbers as numbers, empty ones left out", () => {
  const params = [
    { name: "count", type: "integer", description: "", required: true },
    { name: "ratio", type: "number", description: "", required: false },
    { name: "quick", type: "boolean", description: "", required: false },
    { name: "name", type: "string", description: "", required: false },
  ];
  assert.deepEqual(tryInput(params, { count: "3.6", ratio: "0,5", quick: true, name: "  " }), { count: 4, ratio: 0.5, quick: true });
  assert.equal(toolId("Più veloce!"), "piu_veloce");
});

test("the chat and the tool workshop keep their own chats, files and all", () => {
  State.useSlot("chat");
  State.startChat();
  const chat = State.chatId;
  State.chatHistory.push({ id: 1, role: "user", content: "hi" });
  State.droppedFile = { name: "a.txt", path: "C:\\a.txt" };

  State.useSlot("forge");
  assert.ok(isWorkshopChat(State.chatId) && State.chatId.startsWith(WORKSHOP_PREFIX));
  assert.equal(State.chatHistory.length, 0);
  assert.equal(State.droppedFile, null);
  const forge = State.chatId;
  State.startChat();
  assert.ok(isWorkshopChat(State.chatId), "a new chat in the workshop is a workshop chat");
  assert.notEqual(State.chatId, forge);

  State.useSlot("chat");
  assert.equal(State.chatId, chat);
  assert.equal(State.chatHistory[0].content, "hi");
  assert.equal(State.droppedFile.name, "a.txt");
  assert.ok(!isWorkshopChat(State.chatId));

  // The Tools tab is where the island reopens after the Tools tab or the workshop.
  State.noteTab("tools");
  assert.equal(State.defaultView(), "tools");
  State.useSlot("forge");
  State.noteTab("prompt");
  assert.equal(State.lastTab, "tools");
  assert.equal(State.defaultView(), "prompt");
  // Back from the workshop to the list: the island reopens on the list.
  State.noteTab("tools");
  assert.equal(State.chatSlot, "forge", "the workshop's chat stays put aside");
  assert.equal(State.defaultView(), "tools");
  State.useSlot("chat");
  State.noteTab("prompt");
  assert.equal(State.lastTab, "chat");
  State.droppedFile = null;
});

test("a tool's badge: reviewing, needing a review (none, or of an older version), or the supervisor's verdict", () => {
  const review = { fingerprint: "f", verdict: "caution", summary: "Sends a report.", points: [], undeclared: [], model: "m", at: 1 };
  const tool = { id: "t", reviewed: true, review };
  assert.equal(reviewState(tool, false), "caution");
  assert.equal(reviewState(tool, true), "reviewing");
  assert.equal(reviewState({ ...tool, reviewed: false }, false), "none", "the review is of an older version");
  assert.equal(reviewState({ id: "t" }, false), "none");
});

test("the approval card names one of the user's tools and what it is given, cut when long", () => {
  assert.equal(userToolTarget("Benchmark", {}), "Benchmark");
  assert.equal(userToolTarget("Benchmark", { quick: true, rounds: 3, note: "", gone: null }), "Benchmark · quick: true, rounds: 3");
  assert.equal(userToolTarget("Report", { day: "ieri" }), "Report · day: ieri");
  const long = userToolTarget("X", { text: "a".repeat(500) });
  assert.equal(long.length, 160);
  assert.ok(long.endsWith("…"));
});

test("the tool the workshop is making: none asked, asked with no draft yet, a draft not saved, saved, asked for more", () => {
  const ask = { role: "user", content: "make a benchmark" };
  const reply = { role: "assistant", content: answer };
  assert.equal(workshopTool([], null), null);
  assert.deepEqual(workshopTool([ask], null), { draft: null });
  assert.equal(workshopTool([ask, reply], null).draft.name, "Benchmark del PC");
  const key = draftKey(latestDraft([reply]));
  assert.equal(workshopTool([ask, reply], key), null, "saved as it is");
  assert.equal(workshopTool([ask, reply, { role: "user", content: "make it faster" }], key).draft.name, "Benchmark del PC");
});

// ── A tool's command in the chat ──────────────────────────────────────────────

test("a command is a plain lower case word, as tools.rs makes it", () => {
  assert.equal(commandName("pdfcraft"), "pdfcraft");
  assert.equal(commandName(" /PDF Craft! "), "pdf-craft");
  assert.equal(commandName("bench_pc"), "bench_pc");
  assert.equal(commandName("--x--"), "x");
  assert.equal(commandName("/"), "");
  assert.equal(commandName("a".repeat(80)).length, 32);
});

test("the workshop's draft carries its command: given, emptied, or left to the tool", () => {
  const block = (extra) => `${FENCE}lumo-tool\n${JSON.stringify({ name: "PDF", entry: "C:\\x.py", ...extra })}\n${FENCE}`;
  assert.equal(draftIn(block({ command: "/PdfCraft" })).command, "pdfcraft");
  assert.equal(draftIn(block({ command: "" })).command, "");
  assert.equal("command" in draftIn(block({})), false, "left out: a changed tool keeps its own");
  const tool = { id: "pdf", name: "PDF", description: "", entry: "x.py", args: [], params: [], permissions: [], timeout: 0, command: "pdfcraft" };
  const d = draftOf(tool, [{ name: "x.py", content: "print(1)\n" }]);
  assert.equal(d.command, "pdfcraft");
  assert.equal(draftIn(blocksOf(d)).command, "pdfcraft", "written back for the AI as it is");
  assert.notEqual(draftKey(d), draftKey({ ...d, command: "pdf" }));
  const { command: _, ...without } = d;
  assert.equal(draftKey(without), draftKey({ ...without }), "an older draft keeps its key");
});
