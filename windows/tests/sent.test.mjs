// What went with a question (src/core/sent.ts and the chat view): its bubble
// shows an icon for each kind of thing, a click lists them, and Edit (or
// Retry) puts them back in the attachments so they go again, saying first
// what comes back and what leaves the chat's context.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, internals, sent } from "./tauri.mjs";

installFakeDom();
const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { emptyScreen } = await import("../src/core/screen.ts");
const {
  comingBack, joinScreen, keptItems, leaveScreen, readSent, restored, sentAgain, sentGroups, sentItems, MAX_KEPT_TEXT, MAX_THUMB,
} = await import("../src/core/sent.ts");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const SHOT = { name: "Screen 1", path: "C:\\Lumo\\inbox\\screenshot-1.png", preview: "data:image/png;base64,iVBORw0KGgo=" };
const SELECTION = { text: "const x = [1 2]", app: "Code", title: "main.ts" };
const WINDOW = { title: "main.rs — lumo", app: "Code", text: "fn main() {}", cut: false, document: "" };
const FOLDER = { path: "C:\\Users\\me\\PDFs", name: "PDFs", entries: [{ name: "a.pdf", dir: false, size: 10, modified: "" }], omitted: 0 };
const PDF = { name: "contract.pdf", path: "C:\\Lumo\\inbox\\contract.pdf" };
const PHOTO = { name: "plan.jpg", path: "C:\\Lumo\\inbox\\plan.jpg" };
const detail = (f) => `File · ${f.name.split(".").pop().toUpperCase()}`;

// ── Pure parts ────────────────────────────────────────────────────────────────

test("what went: the files first, then each thing from the computer, as the attachments listed them", () => {
  const screen = { ...emptyScreen(), shots: [SHOT], selection: SELECTION, windows: [WINDOW], folders: [FOLDER], autoFolders: [FOLDER] };
  const items = sentItems(screen, [PDF, PHOTO], detail);
  assert.deepEqual(items.map((i) => [i.kind, i.label]), [
    ["file", "contract.pdf"], ["file", "plan.jpg"], ["selection", "Text from Code"], ["window", "main.rs — lumo"], ["shot", "Screen 1"], ["folder", "PDFs"],
  ], "what rode along by itself and went is listed once");
  assert.equal(items[0].path, PDF.path);
  assert.equal(items[0].detail, "File · PDF");
  assert.equal(items[4].path, SHOT.path, "a screenshot keeps where it is");
  assert.deepEqual([items[2].text, items[2].app, items[2].window], [SELECTION.text, "Code", "main.ts"], "selected text keeps its text");

  // The bubble: one icon per kind, pictures apart from the other files, with how many.
  const two = sentItems({ ...emptyScreen(), shots: [SHOT, { ...SHOT, name: "Screen 2", path: "C:\\Lumo\\inbox\\s2.png" }] }, [PDF, { ...PDF, name: "b.pdf", path: "C:\\b.pdf" }, PHOTO], detail);
  assert.deepEqual(sentGroups(two).map((g) => [g.key, g.count, g.first.label]), [["file", 2, "contract.pdf"], ["picture", 1, "plan.jpg"], ["shot", 2, "Screen 1"]]);
});

test("what comes back on Edit: all of it from memory; in a chat opened again, the files still there and the text", () => {
  const screen = { ...emptyScreen(), shots: [SHOT], selection: SELECTION, windows: [WINDOW], folders: [FOLDER] };
  const items = sentItems(screen, [PDF], detail);
  const again = sentAgain(screen, [PDF]);

  const live = comingBack(items, again, () => true);
  assert.equal(live.back.length, 5);
  assert.deepEqual(live.lost, []);
  const all = restored(live.back, again);
  assert.deepEqual(all.files, [PDF]);
  assert.deepEqual(all.screen.shots, [SHOT]);
  assert.deepEqual(all.screen.windows, [WINDOW], "the window as it was read then");
  assert.deepEqual(all.screen.folders, [FOLDER]);
  assert.deepEqual(all.screen.selection, SELECTION);

  // Kept with the chat only: a deleted file can't come back, nor what a window showed.
  const kept = readSent(JSON.parse(JSON.stringify(keptItems(items))));
  const later = comingBack(kept, undefined, (path) => path !== PDF.path);
  assert.deepEqual(later.back.map((i) => i.kind), ["selection", "shot"]);
  assert.deepEqual(later.lost.map((i) => i.kind), ["file", "window", "folder"]);
  const some = restored(later.back, undefined);
  assert.deepEqual(some.files, []);
  assert.deepEqual(some.screen.shots, [{ name: "Screen 1", path: SHOT.path, preview: "" }]);
  assert.deepEqual(some.screen.selection, SELECTION);
});

test("what comes back joins what waits once, and leaves it again without taking anything else", () => {
  const waiting = { ...emptyScreen(), shots: [{ ...SHOT, path: "C:\\other.png" }], selection: SELECTION };
  const back = { ...emptyScreen(), shots: [SHOT], selection: SELECTION, windows: [WINDOW] };
  const joined = joinScreen(waiting, back);
  assert.deepEqual(joined.shots.map((s) => s.path), ["C:\\other.png", SHOT.path]);
  assert.deepEqual(joined.windows, [WINDOW]);
  assert.equal(joined.selections.length, 0, "the same text once");
  const left = leaveScreen(joined, { ...emptyScreen(), shots: [SHOT], windows: [WINDOW] });
  assert.deepEqual(left.shots.map((s) => s.path), ["C:\\other.png"]);
  assert.deepEqual(left.windows, []);
  assert.deepEqual(left.selection, SELECTION);
});

test("the chat keeps them small, and reads back only what it can use", () => {
  const big = [{ kind: "selection", label: "Selected text", detail: "", title: "", key: "x", text: "x".repeat(MAX_KEPT_TEXT + 1), thumb: `data:image/jpeg;base64,${"A".repeat(MAX_THUMB)}` }];
  assert.deepEqual(keptItems(big)[0].text, undefined);
  assert.deepEqual(keptItems(big)[0].thumb, undefined);
  assert.equal(big[0].text.length, MAX_KEPT_TEXT + 1, "what is on screen keeps it");
  // Bug 18: a selection's key is its whole text, so it is not kept past the limit either.
  const long = "y".repeat(50_000);
  const kept = keptItems([{ kind: "selection", label: "Selected text", detail: "", title: "", key: long, text: long }]);
  assert.ok(JSON.stringify(kept).length < 1000, "the long selection is not saved");
  assert.equal(keptItems([{ kind: "selection", label: "Selected text", detail: "", title: "", key: "short", text: "short" }])[0].key, "short");
  assert.equal(readSent(undefined), undefined);
  assert.equal(readSent([]), undefined);
  assert.deepEqual(readSent([{ kind: "nope", label: "x" }, { kind: "file", label: "a.pdf", path: "C:\\a.pdf", thumb: "javascript:alert(1)" }, 3]),
    [{ kind: "file", label: "a.pdf", detail: "", title: "", key: "", path: "C:\\a.pdf" }]);
});

// ── The chat view ────────────────────────────────────────────────────────────

let answers;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : answers[cmd];
  return result;
};

const mem = new Map();
if (!globalThis.localStorage) {
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
}
const { loadChats } = await import("../src/core/chats.ts");
const { chatCopies } = await import("../src/core/chat-files.ts");

let view;
let turns;
beforeEach(() => {
  calls.length = 0;
  turns = 0;
  answers = {
    chat_send: () => {
      turns += 2;
      return { text: `answer ${turns / 2}`, turns };
    },
    chat_files_present: (args) => args.paths.map(() => true),
  };
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {}, chatProvider: "claude-code" };
  State.chatHistory = [];
  State.stateOverride = null;
  State.view = "prompt";
  State.droppedFile = null;
  State.moreFiles = [];
  State.chatSession = null;
  view = buildPrompt(() => {});
  view.el.querySelector(".chat-input").value = "";
  view.sync();
});

const $ = (cls) => view.el.querySelector(cls);
const rows = () => view.el.find(".chat-row");
const waiting = () => view.el.find(".files-list")[0].find(".attach-row").map((r) => r.find(".attach-name")[0].textContent);
const icons = (row) => row.find(".sent-item").map((i) => i.className.split(" ")[1] + (i.find(".sent-count")[0] ? `×${i.find(".sent-count")[0].textContent}` : ""));
const strip = () => view.el.find(".edit-strip")[0];

async function ask(text) {
  $(".chat-input").value = text;
  $(".send-btn").fire("click");
  await flush();
  await flush();
  view.sync();
}

/** A question sent with a file, a screenshot and selected text, then one with a window. */
async function twoQuestions() {
  State.droppedFile = { ...PDF };
  State.incomingShare = { kind: "screen", shots: [{ display: 0, name: "s.png", path: SHOT.path, width: 10, height: 10, preview: SHOT.preview }] };
  view.sync();
  State.incomingShare = { kind: "selection", selection: SELECTION };
  view.sync();
  await ask("why this error?");
  State.incomingShare = { kind: "selection", selection: { text: "second", app: "", title: "" } };
  view.sync();
  await ask("and this?");
}

test("a question shows what went with it on its bubble; a click lists each one under it", async () => {
  await twoQuestions();
  assert.equal(waiting().length, 0, "nothing waits after sending");
  const [first, , second] = rows();
  assert.deepEqual(icons(first), ["attach-file", "attach-selection", "attach-shot"]);
  assert.deepEqual(icons(second), ["attach-selection"]);
  assert.equal(rows()[1].find(".sent-badges").length, 0, "an answer has none");
  assert.ok(first.find(".bubble")[0].classList.contains("has-sent"));

  const list = first.find(".sent-list")[0];
  assert.equal(list.hidden, true);
  first.find(".sent-badges")[0].fire("click");
  assert.equal(list.hidden, false);
  assert.deepEqual(list.find(".attach-name").map((n) => n.textContent), ["contract.pdf", "Text from Code", "Screen 1"]);

  // The selected text shows what went; Close goes back to the chat.
  list.find(".sent-row")[1].fire("click");
  await flush();
  assert.ok($(".chat-body").classList.contains("screening"));
  assert.equal(view.el.find(".screen-preview-text")[0].textContent, SELECTION.text);
  view.el.find(".btn").find((b) => b.textContent === "Close").fire("click");
  assert.ok(!$(".chat-body").classList.contains("filing"), "not the attachments");

  // A file opens in its app.
  list.find(".sent-row")[0].fire("click");
  await flush();
  assert.deepEqual(sent("chat_file_open").at(-1), { path: PDF.path });
});

test("the screenshots that went are the chat's: kept on disk, and saved with what went", async () => {
  await twoQuestions();
  assert.equal(sent("screen_discard").length, 0);
  assert.ok(chatCopies(State.chatId).includes(SHOT.path), "deleted with the chat");
  const saved = loadChats().find((c) => c.id === State.chatId);
  assert.deepEqual(saved.turns[0].sent.map((i) => i.kind), ["file", "selection", "shot"]);
  assert.equal(saved.turns[0].again, undefined, "what a window showed stays in memory");
  assert.equal(saved.turns[1].sent, undefined);
});

test("Edit puts back what went with the question, says what leaves the context, and it goes again", async () => {
  await twoQuestions();
  rows()[0].find(".msg-edit")[0].fire("click");
  await flush();
  view.sync();
  assert.deepEqual(waiting(), ["Text from Code", "Screen 1", "contract.pdf"]);
  assert.equal(strip().hidden, false);
  const lines = strip().find(".edit-strip-line");
  assert.deepEqual(lines.map((l) => l.find(".edit-strip-label")[0].textContent), ["Come back with the message", "Leave the context"]);
  assert.deepEqual(icons(lines[0]), ["attach-file", "attach-selection", "attach-shot"]);
  assert.deepEqual(icons(lines[1]), ["attach-selection"], "the later question's text");

  // Its × takes one out; the chat's screenshot is never deleted.
  const shotRow = view.el.find(".files-list")[0].find(".attach-row").find((r) => r.find(".attach-name")[0].textContent === "Screen 1");
  shotRow.find(".attach-remove")[0].fire("click");
  view.sync();
  assert.equal(sent("screen_discard").length, 0);

  await ask("why this error, again?");
  const turn = sent("chat_send").at(-1);
  assert.equal(turn.query, "why this error, again?");
  assert.equal(turn.context?.path, PDF.path);
  assert.deepEqual(turn.screen, { windows: [], shots: [], selection: SELECTION });
  assert.equal(strip().hidden, true);
  assert.deepEqual(icons(rows()[0]), ["attach-file", "attach-selection"]);
});

test("an edit given up takes back out only what it put back", async () => {
  await twoQuestions();
  State.incomingShare = { kind: "selection", selection: { text: "typed meanwhile", app: "", title: "" } };
  view.sync();
  rows()[2].find(".msg-edit")[0].fire("click");
  await flush();
  view.sync();
  assert.deepEqual(waiting(), ["Selected text", "Selected text"]);
  view.el.find(".chip-remove")[0].fire("click");
  view.sync();
  assert.deepEqual(waiting(), ["Selected text"]);
  assert.equal(strip().hidden, true);
  await ask("next");
  assert.equal(sent("chat_send").at(-1).screen.selection.text, "typed meanwhile");
});

test("an edit given up leaves what was already waiting, even the same thing it put back", async () => {
  // Bug 129: the edit took back out everything it had brought, also what the user had attached before.
  await twoQuestions();
  State.incomingShare = { kind: "selection", selection: { text: "second", app: "", title: "" } };
  view.sync();
  assert.deepEqual(waiting(), ["Selected text"]);
  rows()[2].find(".msg-edit")[0].fire("click");
  await flush();
  view.sync();
  assert.deepEqual(waiting(), ["Selected text"], "the same text once");
  view.el.find(".chip-remove")[0].fire("click");
  view.sync();
  assert.deepEqual(waiting(), ["Selected text"], "still waiting");
  await ask("next");
  assert.equal(sent("chat_send").at(-1).screen.selection.text, "second");
});

test("Retry sends the question again with what went with it", async () => {
  await twoQuestions();
  rows()[3].find(".msg-retry")[0].fire("click");
  await flush();
  await flush();
  await flush();
  view.sync();
  const turn = sent("chat_send").at(-1);
  assert.equal(turn.query, "and this?");
  assert.equal(turn.screen.selection.text, "second");
});

test("in a chat opened again, the screenshot comes back if it is still there; a window can't", async () => {
  State.incomingShare = { kind: "screen", shots: [{ display: 0, name: "s.png", path: SHOT.path, width: 10, height: 10, preview: SHOT.preview }] };
  view.sync();
  await ask("look");
  const id = State.chatId;
  // As a window would have gone: kept with the chat, its text in memory only.
  const saved = loadChats().find((c) => c.id === id);
  saved.turns[0].sent.push({ kind: "window", label: "main.rs — lumo", detail: "Window · Code", title: "", key: "Code\u0000main.rs — lumo" });
  const { saveChat } = await import("../src/core/chats.ts");
  saveChat(saved);

  view.el.find(".tool-btn").find((b) => b.getAttribute("title") === "New chat").fire("click");
  view.sync();
  State.chatToOpen = id;
  view.sync();
  await flush();
  view.sync();
  assert.equal(State.chatId, id);
  assert.deepEqual(icons(rows()[0]), ["attach-shot", "attach-window"]);

  rows()[0].find(".msg-edit")[0].fire("click");
  await flush();
  view.sync();
  assert.deepEqual(sent("chat_files_present").at(-1), { paths: [SHOT.path] });
  assert.deepEqual(waiting(), ["Screen 1"]);
  const lines = strip().find(".edit-strip-line");
  assert.deepEqual(icons(lines[0]), ["attach-shot"]);
  assert.deepEqual(icons(lines[1]), ["attach-window"]);
  await ask("look again");
  assert.deepEqual(sent("chat_send").at(-1).screen.shots, [{ name: "Screen 1", path: SHOT.path }]);
});

// ── Each chat's folder ───────────────────────────────────────────────────────

/** As files.rs adopt answers: each file waiting in the inbox, moved into its chat's folder under its own name. */
const inChat = (args) => args.items.map((i) => {
  const name = i.name ?? i.path.split("\\").pop();
  return i.path.startsWith("C:\\Lumo\\inbox\\chats\\") ? i.path : `C:\\Lumo\\inbox\\chats\\${i.chat}\\${name}`;
});

test("what a question takes moves into its chat's folder, and goes and stays there by that path", async () => {
  answers.chat_files_adopt = inChat;
  State.droppedFile = { name: "contract.pdf", path: "C:\\Lumo\\inbox\\contract (2).pdf" };
  State.incomingShare = { kind: "screen", shots: [{ display: 0, name: "s.png", path: SHOT.path, width: 10, height: 10, preview: SHOT.preview }] };
  view.sync();
  await ask("why?");
  const id = State.chatId;
  const pdf = `C:\\Lumo\\inbox\\chats\\${id}\\contract.pdf`;
  const shot = `C:\\Lumo\\inbox\\chats\\${id}\\screenshot-1.png`;
  assert.deepEqual(sent("chat_files_adopt").at(-1).items, [
    { chat: id, path: "C:\\Lumo\\inbox\\contract (2).pdf", name: "contract.pdf" },
    { chat: id, path: SHOT.path },
  ], "the file under the name it had, the screenshot under its file's");
  const turn = sent("chat_send").at(-1);
  assert.equal(turn.context?.path, pdf);
  assert.deepEqual(turn.screen.shots, [{ name: "Screen 1", path: shot }]);
  const saved = loadChats().find((c) => c.id === id);
  assert.deepEqual(saved.turns[0].sent.filter((i) => i.path).map((i) => i.path), [pdf, shot], "the bubble opens them there");
  assert.ok(chatCopies(id).includes(pdf) && chatCopies(id).includes(shot));
  assert.equal(sent("inbox_release").length, 0);
});

test("the × of a file waiting deletes it from the inbox; one back from an edit leaves the chat's folder once the edit goes", async () => {
  answers.chat_files_adopt = inChat;
  // Waiting, never sent: its × deletes it at once.
  State.droppedFile = { ...PHOTO };
  view.sync();
  $(".attach-btn")?.fire("click");
  view.sync();
  const row = () => view.el.find(".files-list")[0].find(".attach-row").find((r) => r.find(".attach-name")[0].textContent === "plan.jpg");
  row().find(".attach-remove")[0].fire("click");
  view.sync();
  assert.deepEqual(sent("inbox_release").at(-1)?.paths, [PHOTO.path]);
  assert.equal(State.droppedFile, null);

  // Sent with a screenshot: both in the chat's folder.
  State.droppedFile = { ...PDF };
  State.incomingShare = { kind: "screen", shots: [{ display: 0, name: "s.png", path: SHOT.path, width: 10, height: 10, preview: SHOT.preview }] };
  view.sync();
  await ask("why this error?");
  const id = State.chatId;
  const pdf = `C:\\Lumo\\inbox\\chats\\${id}\\contract.pdf`;
  const shot = `C:\\Lumo\\inbox\\chats\\${id}\\screenshot-1.png`;

  // Edit: both come back; the screenshot's × takes it out of the question.
  rows()[0].find(".msg-edit")[0].fire("click");
  await flush();
  view.sync();
  const released = sent("inbox_release").length;
  const shotRow = view.el.find(".files-list")[0].find(".attach-row").find((r) => r.find(".attach-name")[0].textContent === "Screen 1");
  shotRow.find(".attach-remove")[0].fire("click");
  view.sync();
  assert.equal(sent("chat_files_forget").length, 0, "nothing goes before the edit does");
  await ask("why this error, again?");
  assert.equal(sent("chat_send").at(-1).context?.path, pdf, "the file goes again from the chat's folder");
  assert.deepEqual(sent("chat_files_forget").at(-1), { chat: id, paths: [shot] }, "what the edit no longer sends leaves the folder");
  assert.equal(sent("inbox_release").length, released, "the inbox has nothing of it");
});

test("when Lumo starts, an older Lumo's copies in the inbox move into their chats' folders, then the inbox is tidied", async () => {
  const { saveChat } = await import("../src/core/chats.ts");
  const { noteSentCopies } = await import("../src/core/chat-files.ts");
  const old = "C:\\Lumo\\inbox\\old (2).pdf";
  const item = { kind: "file", label: "old.pdf", detail: "File · PDF", title: old, key: old, path: old };
  saveChat({ id: "older", title: "older", updatedAt: 1, provider: "claude-code", session: null, turns: [{ role: "user", content: "q", sent: [item] }, { role: "assistant", content: "a" }] });
  noteSentCopies("older", [old]);
  answers.chat_files_adopt = inChat;
  calls.length = 0;
  buildPrompt(() => {});
  for (let i = 0; i < 4; i++) await flush();
  const moved = "C:\\Lumo\\inbox\\chats\\older\\old (2).pdf";
  assert.deepEqual(sent("chat_files_adopt")[0].items.filter((i) => i.chat === "older"), [{ chat: "older", path: old }], "under the inbox's name, the one its AI may know");
  assert.deepEqual(loadChats().find((c) => c.id === "older").turns[0].sent[0].path, moved);
  assert.ok(chatCopies("older").includes(moved) && !chatCopies("older").includes(old));
  const order = calls.map(([cmd]) => cmd);
  assert.ok(order.indexOf("chat_files_adopt") < order.indexOf("inbox_tidy"), "moved first, tidied after");
  assert.ok(sent("inbox_tidy")[0].keep.includes(moved));
});
