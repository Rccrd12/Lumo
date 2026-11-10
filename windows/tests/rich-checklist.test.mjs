// The checklist card (src/views/rich/checklist.ts) and its logic
// (src/core/checklists.ts): GitHub's task lists and ```lumo-checklist blocks
// become a list to tick, its ticks saved with the chat (core/chats.ts); a list
// the AI writes again further down takes over, and what the user ticked goes
// to the AI with the next question.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const dom = installFakeDom();
const {
  parseChecklist, taskItem, itemKey, resolveChecklists, itemsDone, withTick, checklistNote, stateLine, listsInChat, nextMessage,
  withTold, tickKey, cleanChecklists, noteChatChecklists, messageScope, scopeMessage,
} = await import("../src/core/checklists.ts");
const { chatChecklists, setChatChecklists, saveChat, loadChats, deleteChat } = await import("../src/core/chats.ts");
const { checklistsIn, renderMarkdown } = await import("../src/views/markdown.ts");
const { listMarkdown } = await import("../src/views/rich/checklist.ts");

beforeEach(() => mem.clear());

const items = (...texts) => texts.map((t) => (typeof t === "string" ? { text: t, done: false, indent: 0 } : t));
const done = (text) => ({ text, done: true, indent: 0 });

// ── Reading ───────────────────────────────────────────────────────────────────

test("a task item: -, * or +, a box with a space or an x (any case), then its text", () => {
  assert.deepEqual(taskItem("- [ ] Section `0.21.0`"), { text: "Section `0.21.0`", done: false, indent: 0 });
  assert.deepEqual(taskItem("* [x] Two"), { text: "Two", done: true, indent: 0 });
  assert.deepEqual(taskItem("  + [X] Nested  "), { text: "Nested", done: true, indent: 1 });
  for (const line of ["- [ ]", "- [x]done", "-[ ] a", "1. [ ] a", "- [y] a", "[ ] a", "- plain"]) assert.equal(taskItem(line), null, line);
});

test("a ```lumo-checklist block: task lines, plain items and lines all count; none at all is null", () => {
  assert.deepEqual(parseChecklist(" Release ", "- [ ] a\n- [x] b\n\n- c\n3. d\ne\n```"), {
    title: "Release",
    items: items("a", done("b"), "c", "d", "e"),
  });
  assert.equal(parseChecklist("T", ""), null);
  assert.equal(parseChecklist("T", "\n  \n"), null);
});

test("an item's text is compared without its Markdown marks, spaces or case", () => {
  assert.equal(itemKey("Run `npm  test` **now**"), itemKey("run npm test now"));
  assert.notEqual(itemKey("a"), itemKey("b"));
});

test("checklistsIn finds an answer's lists in the order they are drawn, a block being written left out", () => {
  const text = "- [ ] a\n- [x] b\n\nText\n\n```lumo-checklist R\n- [ ] c\n```\n\n```lumo-checklist Empty\n```\n\n```lumo-checklist Open\n- [ ] d";
  assert.deepEqual(checklistsIn(text), [
    { title: "", items: items("a", done("b")) },
    { title: "R", items: items("c") },
    { title: "Open", items: items("d") },
  ]);
  assert.deepEqual(checklistsIn(text, true).map((l) => l.title), ["", "R"]);
  assert.deepEqual(checklistsIn("No lists here.\n- plain"), []);
});

// ── One list written again ────────────────────────────────────────────────────

test("the same title, or most of the same lines untitled, is one list: its newest version is live", () => {
  const found = [
    { message: 1, lists: [{ title: "Release 0.21.0", items: items("a", "b") }, { title: "", items: items("x", "y", "z") }] },
    { message: 3, lists: [{ title: "release  0.21.0", items: items("a", "b", "c") }] },
    { message: 5, lists: [{ title: "", items: items("x", "y", "w") }, { title: "", items: items("p", "q") }] },
  ];
  const { slots, lineages } = resolveChecklists(found);
  assert.deepEqual(slots.get("1:0"), { id: "t:release 0.21.0", live: false, message: 1 });
  assert.deepEqual(slots.get("3:0"), { id: "t:release 0.21.0", live: true, message: 3 });
  assert.deepEqual(slots.get("1:1"), { id: "u:0", live: false, message: 1 });
  assert.deepEqual(slots.get("5:0"), { id: "u:0", live: true, message: 5 });
  // Too little in common: another list.
  assert.deepEqual(slots.get("5:1"), { id: "u:1", live: true, message: 5 });
  assert.deepEqual(lineages.map((l) => [l.id, l.message]), [["t:release 0.21.0", 3], ["u:0", 5], ["u:1", 5]]);
});

test("two lists in one answer are never one list, even with one title", () => {
  const { slots } = resolveChecklists([
    { message: 1, lists: [{ title: "T", items: items("a") }, { title: "T", items: items("b") }, { title: "", items: items("a") }, { title: "", items: items("a") }] },
    { message: 3, lists: [{ title: "T", items: items("a") }] },
  ]);
  assert.equal(slots.get("1:0").id, "t:t");
  assert.equal(slots.get("1:1").id, "t:t\u00002");
  assert.equal(slots.get("1:1").live, true);
  assert.equal(slots.get("1:0").live, false);
  assert.notEqual(slots.get("1:2").id, slots.get("1:3").id);
});

// ── What is ticked ────────────────────────────────────────────────────────────

test("ticks: the AI's [x], the user's ticks by text, a tick on this version over the AI's mark", () => {
  const v1 = { title: "R", items: items("a", "b", "c") };
  let memory = withTick(undefined, "a", true, 1);
  memory = withTick(memory, "`b`", true, 1);
  assert.deepEqual(itemsDone(v1, 1, memory), [true, true, false]);
  // Written again: the user's ticks carry over by text, the AI's [x] ticks c.
  const v2 = { title: "R", items: items("A", "b", done("c"), "d") };
  assert.deepEqual(itemsDone(v2, 3, memory), [true, true, true, false]);
  // Taken off on the new version: it stays off, even where the AI wrote [x].
  memory = withTick(memory, "c", false, 3);
  assert.deepEqual(itemsDone(v2, 3, memory), [true, true, false, false]);
  // The AI writes [x] again in a newer version: ticked.
  const v3 = { title: "R", items: items("a", "b", done("c"), "d") };
  assert.deepEqual(itemsDone(v3, 5, memory), [true, true, true, false]);
  // An earlier untick doesn't hide the AI's newer [x], but a newer one does.
  assert.deepEqual(itemsDone({ title: "", items: [done("z")] }, 2, withTick(undefined, "z", false, 1)), [true]);
});

test("the ticks are saved with the chat, kept when the chat is saved again, gone with it", () => {
  const chat = { id: "c1", title: "t", updatedAt: 1, provider: "claude-code", session: null, turns: [{ role: "user", content: "q" }] };
  // Ticked before the chat is saved: kept until it is.
  setChatChecklists("c1", { "t:r": withTick(undefined, "a", true, 1) });
  assert.equal(chatChecklists("c1")["t:r"].ticks.a.done, true);
  saveChat(chat);
  assert.equal(loadChats()[0].checklists["t:r"].ticks.a.done, true);
  setChatChecklists("c1", { "t:r": withTick(chatChecklists("c1")["t:r"], "b", true, 1) });
  // chat.ts saves the chat after each answer with its turns only: the ticks stay.
  saveChat({ ...chat, updatedAt: 2 });
  assert.deepEqual(Object.keys(chatChecklists("c1")["t:r"].ticks).sort(), ["a", "b"]);
  deleteChat("c1");
  assert.deepEqual(chatChecklists("c1"), {});
  // What storage gives back is checked.
  assert.deepEqual(cleanChecklists({ x: { ticks: { a: { done: "yes", at: 1 }, b: { done: true, at: 2 } } }, y: 3, z: null }), {
    x: { ticks: { b: { done: true, at: 2 } } },
  });
  assert.deepEqual(cleanChecklists([1]), {});
});

// ── Telling the AI ────────────────────────────────────────────────────────────

test("the line for the AI says what is done and what is left", () => {
  const list = { title: "Release 0.21.0", items: items("Section `0.21.0`", "Tag  and\npush", "c") };
  assert.equal(stateLine(list, [true, false, true]), 'Checklist "Release 0.21.0": done: Section `0.21.0`; c. To do: Tag and push.');
  assert.equal(stateLine({ title: "", items: items("a") }, [false]), "Checklist: done: none. To do: a.");
  assert.equal(stateLine({ title: "", items: items("a") }, [true]), "Checklist: done: a. To do: none.");
});

test("the AI is told only what differs from what it last wrote, and only once", () => {
  const history = [
    { role: "user", content: "How do I release?" },
    { role: "assistant", content: "Six steps:\n\n```lumo-checklist Release\n- [ ] a\n- [x] b\n- [ ] c\n```" },
    { role: "assistant", content: "failed", failed: true },
    { role: "user", content: "And the other list?" },
    { role: "assistant", content: "- [ ] x\n- [ ] y" },
  ];
  const found = listsInChat(history, (t) => checklistsIn(t));
  assert.deepEqual(found.map((f) => f.message), [1, 3]);
  assert.equal(nextMessage(history), 4);
  const { lineages } = resolveChecklists(found);
  // Nothing ticked by the user: nothing to tell.
  assert.deepEqual(checklistNote(lineages, {}), { text: "", told: {} });
  let memory = { "t:release": withTick(undefined, "a", true, 1), "u:0": withTick(undefined, "y", true, 3) };
  const note = checklistNote(lineages, memory);
  assert.equal(note.text, 'Checklist "Release": done: a; b. To do: c.\nChecklist: done: y. To do: x.');
  // Told once: not again, until a tick changes.
  memory = withTold(memory, note.told);
  assert.equal(checklistNote(lineages, memory).text, "");
  memory["t:release"] = withTick(memory["t:release"], "c", true, 1);
  assert.equal(checklistNote(lineages, memory).text, 'Checklist "Release": done: a; b; c. To do: none.');
  // The AI wrote it again with the same ticks: nothing to tell.
  const again = resolveChecklists([...found, { message: 6, lists: [{ title: "Release", items: items(done("a"), done("b"), done("c")) }] }]);
  assert.equal(checklistNote(again.lineages, memory).text, "");
  // A message being written counts as the next one.
  assert.deepEqual(listsInChat(history, (t) => checklistsIn(t), [{ title: "", items: items("q") }]).at(-1).message, 4);
});

test("a tick taken back off after the AI was told of it is told too, then not again", () => {
  const found = [{ message: 1, lists: [{ title: "Release", items: items("a", "b") }] }];
  const { lineages } = resolveChecklists(found);
  let memory = { "t:release": withTick(undefined, "a", true, 1) };
  let note = checklistNote(lineages, memory);
  assert.equal(note.text, 'Checklist "Release": done: a. To do: b.');
  memory = withTold(memory, note.told);
  // Back as the AI wrote it: the AI still thinks a is done, so it is told.
  memory["t:release"] = withTick(memory["t:release"], "a", false, 1);
  note = checklistNote(lineages, memory);
  assert.equal(note.text, 'Checklist "Release": done: none. To do: a; b.');
  memory = withTold(memory, note.told);
  assert.equal(checklistNote(lineages, memory).text, "");
  // Told of an older version: the AI's own marks on the new one need no line.
  const again = resolveChecklists([...found, { message: 3, lists: [{ title: "Release", items: items("a", done("b")) }] }]);
  assert.equal(checklistNote(again.lineages, withTold(memory, { "t:release": "1|10" })).text, "");
});

test("two items with the same text are ticked one at a time", () => {
  const list = parseChecklist("Release", "- [ ] Frontend\n  - [ ] Run the tests\n- [ ] Backend\n  - [ ] Run the `tests`");
  assert.equal(tickKey(list, 1), "run the tests");
  assert.notEqual(tickKey(list, 3), tickKey(list, 1));
  let memory = withTick(undefined, tickKey(list, 1), true, 3);
  assert.deepEqual(itemsDone(list, 3, memory), [false, true, false, false]);
  memory = withTick(memory, tickKey(list, 3), true, 3);
  assert.deepEqual(itemsDone(list, 3, memory), [false, true, false, true]);
  memory = withTick(memory, tickKey(list, 1), false, 3);
  assert.deepEqual(itemsDone(list, 3, memory), [false, false, false, true]);
  // A tick saved by the text alone is the first one's.
  assert.deepEqual(itemsDone(list, 3, withTick(undefined, "Run the tests", true, 3)), [false, true, false, false]);
});

// ── The card ──────────────────────────────────────────────────────────────────

const rows = (card) => card.find(".rc-check-row");
const box = (card, i) => rows(card)[i].find(".rc-box")[0];

test("the card ticks a line on a click, counts, lights the next line and fills its bar", () => {
  const root = dom.root();
  renderMarkdown(root, "Six steps:\n- [ ] Section `0.21.0` in `CHANGELOG.md`\n- [ ] Two\n- [ ] Three");
  const card = root.querySelector(".rc-check");
  assert.ok(card.classList.contains("rc-card"));
  assert.equal(card.find(".rc-kind")[0].textContent, "Checklist");
  assert.equal(card.find(".rc-count")[0].textContent, "0 / 3");
  assert.equal(rows(card)[0].find(".md-code").length, 2);
  assert.equal(box(card, 0).tagName, "BUTTON");
  assert.equal(box(card, 0).getAttribute("aria-checked"), "false");
  assert.equal(box(card, 0).title, "Mark as done");
  assert.equal(card.find(".rc-check-prog")[0].find("I")[0].style.width, "0%");
  // No line is lit before the first tick.
  assert.equal(card.find(".next").length, 0);

  rows(card)[0].fire("click", { target: rows(card)[0] });
  assert.equal(card.find(".rc-count")[0].textContent, "1 / 3");
  assert.equal(rows(card)[0].className, "rc-check-row on");
  assert.equal(rows(card)[1].className, "rc-check-row next");
  assert.equal(box(card, 0).getAttribute("aria-checked"), "true");
  assert.equal(box(card, 0).find("SVG").length, 1);
  assert.equal(card.find(".rc-check-prog")[0].find("I")[0].style.width, `${(1 / 3) * 100}%`);
  // The same nodes: a box keeps the focus.
  const first = rows(card)[0];
  rows(card)[0].fire("click", { target: first });
  assert.equal(rows(card)[0], first);
  assert.equal(rows(card)[0].className, "rc-check-row");
  // Drawn again (the chat redraws often): the ticks are where they were.
  rows(card)[2].fire("click", { target: rows(card)[2] });
  renderMarkdown(root, "Six steps:\n- [ ] Section `0.21.0` in `CHANGELOG.md`\n- [ ] Two\n- [ ] Three");
  assert.equal(root.querySelector(".rc-check").find(".rc-count")[0].textContent, "1 / 3");
});

test("a finished list folds into one green line; a click opens it again", () => {
  const root = dom.root();
  renderMarkdown(root, "```lumo-checklist Release 0.21.0\n- [x] a\n- [ ] b\n```");
  const card = root.querySelector(".rc-check");
  assert.equal(card.find(".rc-title")[0].textContent, "Release 0.21.0");
  rows(card)[1].fire("click", { target: rows(card)[1] });
  assert.ok(card.classList.contains("folded"));
  assert.equal(card.find(".rc-check-list").length, 0);
  assert.equal(card.find(".rc-check-ok")[0].textContent, "Completed · 2/2");
  const open = card.find(".rc-check-fold")[0];
  assert.equal(open.getAttribute("aria-expanded"), "false");
  open.fire("click");
  assert.ok(!card.classList.contains("folded"));
  assert.equal(rows(card).length, 2);
  assert.equal(card.find(".rc-count")[0].textContent, "2 / 2");
  card.find(".rc-check-fold")[0].fire("click");
  assert.ok(card.classList.contains("folded"));
  // A list the AI wrote all done shows folded at once.
  renderMarkdown(root, "- [x] p\n- [x] q");
  assert.ok(root.querySelector(".rc-check").classList.contains("folded"));
});

test("in a chat: ticks are saved by the line's text, a list written again takes over, the older one says so", () => {
  const chat = { id: "chat-9", title: "t", updatedAt: 1, provider: "claude-code", session: null, turns: [] };
  saveChat(chat);
  const first = "```lumo-checklist Release\n- [ ] a\n- [ ] b\n- [ ] c\n```";
  const history = [{ role: "user", content: "q" }, { role: "assistant", content: first }];
  noteChatChecklists("chat-9", listsInChat(history, (t) => checklistsIn(t)));
  const one = dom.root();
  renderMarkdown(one, first, { scope: messageScope("chat-9", 1) });
  rows(one.querySelector(".rc-check"))[0].fire("click", { target: null });
  assert.equal(chatChecklists("chat-9")["t:release"].ticks.a.done, true);
  assert.equal(chatChecklists("chat-9")["t:release"].ticks.a.at, 1);

  // The AI writes the list again, b marked done, a line added.
  const second = "Updated:\n```lumo-checklist Release\n- [ ] a\n- [x] b\n- [ ] c\n- [ ] d\n```";
  history.push({ role: "user", content: "next" }, { role: "assistant", content: second });
  noteChatChecklists("chat-9", listsInChat(history, (t) => checklistsIn(t)));
  renderMarkdown(one, first, { scope: messageScope("chat-9", 1) });
  const old = one.querySelector(".rc-check");
  assert.ok(old.classList.contains("moved"));
  assert.equal(old.find(".rc-check-row").length, 0);
  assert.equal(old.find(".rc-check-moved")[0].textContent, "Updated below");
  const two = dom.root();
  renderMarkdown(two, second, { scope: messageScope("chat-9", 3) });
  const live = two.querySelector(".rc-check");
  assert.equal(live.find(".rc-count")[0].textContent, "2 / 4");
  assert.deepEqual(rows(live).map((r) => r.classList.contains("on")), [true, true, false, false]);
  // A scope that is not a chat message's: the card keeps its ticks to itself.
  assert.equal(scopeMessage("chat-9#-1"), null);
  assert.deepEqual(scopeMessage("a#b#12"), { chatId: "a#b", message: 12 });
});

test("Copy takes the list as GitHub writes it, with the ticks as they are", () => {
  const list = { title: "R", items: [{ text: "a", done: false, indent: 0 }, { text: "b", done: false, indent: 1 }] };
  assert.equal(listMarkdown(list, [true, false]), "R\n- [x] a\n  - [ ] b");
  assert.equal(listMarkdown({ ...list, title: "" }, [false, false]), "- [ ] a\n  - [ ] b");
});

test("in a chat, a click on the second of two same lines ticks that one only", () => {
  saveChat({ id: "chat-dup", title: "t", updatedAt: 1, provider: "claude-code", session: null, turns: [] });
  const text = "- [ ] Frontend\n  - [ ] Run the tests\n- [ ] Backend\n  - [ ] Run the tests";
  noteChatChecklists("chat-dup", listsInChat([{ role: "user", content: "q" }, { role: "assistant", content: text }], (t) => checklistsIn(t)));
  const root = dom.root();
  renderMarkdown(root, text, { scope: messageScope("chat-dup", 1) });
  const card = root.querySelector(".rc-check");
  rows(card)[3].fire("click", { target: null });
  assert.deepEqual(rows(card).map((r) => r.classList.contains("on")), [false, false, false, true]);
  assert.equal(card.find(".rc-count")[0].textContent, "1 / 4");
});
