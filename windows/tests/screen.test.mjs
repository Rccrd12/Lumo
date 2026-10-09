// The chat's screen button (src/core/screen.ts and the chat view): nothing is
// listed or captured before a click, a screenshot is previewed and joins the
// chat only on Send (Cancel deletes it), the window list rides as text, the
// folder open in File Explorer is listed only on a click and attaches the file
// the question names, and what was added goes with one question only.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, internals, sent } from "./tauri.mjs";

installFakeDom();
const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { providerDef } = await import("../src/core/providers.ts");
const {
  emptyScreen, entryLabel, hasScreen, keepShots, menuEntries, nextScreen, screenChips, screenPayload, seesImages,
  sharesFolderByItself, shotPaths, withoutFolder,
} = await import("../src/core/screen.ts");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const DISPLAYS = [
  { index: 0, width: 2560, height: 1440, primary: true },
  { index: 1, width: 1920, height: 1080, primary: false },
];
const WINDOWS = [
  { title: "main.rs — lumo", app: "Code", active: true, minimized: false },
  { title: "Inbox", app: "outlook", active: false, minimized: true },
];
const FOLDER = {
  path: "C:\\Users\\me\\Documents\\PDFs",
  name: "PDFs",
  entries: [
    { name: "Old", dir: true, size: 0, modified: "2026-10-01 14:02" },
    { name: "file.pdf", dir: false, size: 1536, modified: "2026-10-08 09:05" },
  ],
  omitted: 0,
};
const PEEKED = { ...FOLDER, entries: [] };
const COPIED = { name: "file.pdf", path: "C:\\Lumo\\inbox\\file.pdf", size: 1536 };
const shot = (display) => ({
  display,
  name: `screenshot-2026-10-08-090503-screen${display + 1}.png`,
  path: `C:\\Lumo\\inbox\\screenshot-2026-10-08-090503-screen${display + 1}.png`,
  width: 1568,
  height: 882,
  preview: "data:image/png;base64,iVBORw0KGgo=",
});

// ── Pure parts ────────────────────────────────────────────────────────────────

test("the menu: open windows, one entry per screen, all screens only when there are several", () => {
  assert.deepEqual(menuEntries([]).map(entryLabel), ["Open windows"]);
  assert.deepEqual(menuEntries(DISPLAYS.slice(0, 1)).map(entryLabel), ["Open windows", "Screen 1"]);
  assert.deepEqual(menuEntries(DISPLAYS).map(entryLabel), ["Open windows", "Screen 1", "Screen 2", "All screens"]);
});

test("the File Explorer entry comes last, with its folder or the reason there is none", () => {
  const [, found] = menuEntries([], { folder: PEEKED, problem: "" });
  assert.deepEqual(found, { kind: "explorer", folder: PEEKED, reason: "" });
  assert.equal(entryLabel(found), "Folder open in File Explorer");
  const [, none] = menuEntries([], { folder: null, problem: "" });
  assert.equal(none.reason, "No folder is open in File Explorer.");
  const [, linux] = menuEntries([], { folder: PEEKED, problem: "Not available on Linux yet." });
  assert.deepEqual(linux, { kind: "explorer", folder: null, reason: "Not available on Linux yet." });
});

test("a shared folder is something to send, with a chip naming it", () => {
  const p = { ...emptyScreen(), folder: FOLDER };
  assert.ok(hasScreen(p));
  assert.deepEqual(screenPayload(p), { windows: [], shots: [], folder: FOLDER });
  assert.deepEqual(screenChips(p), [{ kind: "folder", label: "PDFs", title: FOLDER.path }]);
  assert.ok(!("folder" in screenPayload({ ...p, folder: null, windows: [] })));
});

test("only the local model servers can't look at a screenshot", () => {
  for (const id of ["anthropic", "claude-code", "openai", "google", "openrouter"]) assert.ok(seesImages(providerDef(id)), id);
  for (const id of ["ollama", "lmstudio", "custom"]) assert.ok(!seesImages(providerDef(id)), id);
});

test("what is waiting becomes one payload, chips and a list of files to delete", () => {
  let p = emptyScreen();
  assert.equal(hasScreen(p), false);
  assert.equal(screenPayload(p), null);
  assert.deepEqual(screenChips(p), []);

  p = { ...p, windows: WINDOWS };
  p = keepShots(p, [shot(0), shot(1)]);
  assert.ok(hasScreen(p));
  assert.deepEqual(screenPayload(p), {
    windows: WINDOWS,
    shots: [
      { name: "Screen 1", path: shot(0).path },
      { name: "Screen 2", path: shot(1).path },
    ],
  });
  const chips = screenChips(p);
  assert.deepEqual(chips.map((c) => c.label), ["Open windows (2)", "Screen 1, Screen 2"]);
  assert.equal(chips[0].title, "main.rs — lumo — Code\nInbox — outlook");
  assert.deepEqual(shotPaths(p), [shot(0).path, shot(1).path]);
  // A window list on its own is still something to send.
  assert.deepEqual(screenPayload({ windows: [], shots: [] }), { windows: [], shots: [] });
});

test("selected text is something to send, with a chip naming the app and showing the text", () => {
  const selection = { text: "Le contrat est conclu pour un an.", app: "Acrobat", title: "bail.pdf" };
  const p = { ...emptyScreen(), selection };
  assert.ok(hasScreen(p));
  assert.deepEqual(screenPayload(p), { windows: [], shots: [], selection });
  assert.deepEqual(screenChips(p), [{ kind: "selection", label: "Text from Acrobat", title: selection.text }]);
  const long = { ...p, selection: { text: "x".repeat(1000), app: "", title: "" } };
  const [chip] = screenChips(long);
  assert.equal(chip.label, "Selected text");
  assert.equal(chip.title, `${"x".repeat(400)}…`);
  assert.ok(!("selection" in screenPayload({ ...p, selection: null, windows: [] })));
});

// ── The chat view ────────────────────────────────────────────────────────────

let answers;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : answers[cmd];
  return result;
};

let view;
beforeEach(() => {
  calls.length = 0;
  answers = {
    screen_displays: DISPLAYS,
    screen_windows: WINDOWS,
    screen_capture: (args) => (args.display === null ? [shot(0), shot(1)] : [shot(args.display)]),
    chat_send: { text: "I see VS Code." },
    screen_explorer_peek: PEEKED,
    screen_explorer: FOLDER,
    explorer_attach: (args) => (/file\.pdf/i.test(args.query) ? COPIED : null),
  };
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {}, chatProvider: "claude-code" };
  State.chatHistory = [];
  State.stateOverride = null;
  State.view = "prompt";
  State.droppedFile = null;
  view = buildPrompt(() => {});
  view.el.querySelector(".chat-input").value = ""; // what a real <input> starts with
  view.sync();
});

const $ = (cls) => view.el.querySelector(cls);
const entries = () => view.el.find(".screen-entry");
const nothingCaptured = () =>
  sent("screen_capture").length === 0 && sent("screen_windows").length === 0 && sent("screen_explorer").length === 0;
const explorerEntry = () => entries().find((e) => e.find(".picker-model-name")[0].textContent === "Folder open in File Explorer");

async function openMenu() {
  $(".screen-btn").fire("click");
  await flush();
}

test("opening the menu only asks which screens there are", async () => {
  await openMenu();
  assert.ok($(".chat-body").classList.contains("screening"));
  assert.deepEqual(
    entries().map((e) => e.find(".picker-model-name")[0].textContent),
    ["Open windows", "Screen 1", "Screen 2", "All screens", "Folder open in File Explorer"],
  );
  assert.equal(sent("screen_displays").length, 1);
  assert.equal(sent("screen_explorer_peek").length, 1, "the folder's name, for the label");
  assert.ok(nothingCaptured(), "nothing until an entry is clicked");
  $(".screen-btn").fire("click");
  assert.ok(!$(".chat-body").classList.contains("screening"));
  assert.ok(nothingCaptured());
});

test("a screenshot is previewed, kept on Send and goes with the next question once", async () => {
  await openMenu();
  entries()[1].fire("click"); // Screen 1
  await flush();
  assert.deepEqual(sent("screen_capture"), [{ display: 0 }]);
  const img = view.el.find("IMG")[0];
  assert.equal(img.getAttribute("src"), shot(0).preview);
  assert.equal(view.el.find(".chip").length, 0, "not chat context before Send");

  view.el.find(".btn").find((b) => b.textContent === "Send").fire("click");
  view.sync();
  assert.ok(!$(".chat-body").classList.contains("screening"));
  assert.deepEqual(view.el.find(".chip").map((c) => c.find("SPAN")[0].textContent), ["Screen 1"]);
  assert.deepEqual(sent("screen_discard"), [], "kept, not deleted");

  $(".chat-input").value = "what's wrong here?";
  $(".send-btn").fire("click");
  await flush();
  view.sync();
  assert.deepEqual(sent("chat_send")[0].screen, { windows: [], shots: [{ name: "Screen 1", path: shot(0).path }] });
  assert.equal(view.el.find(".chip").length, 0, "sent once, then forgotten");

  $(".chat-input").value = "and now?";
  $(".send-btn").fire("click");
  await flush();
  assert.equal(sent("chat_send")[1].screen, undefined);
});

test("Cancel deletes the screenshots and adds nothing", async () => {
  await openMenu();
  entries()[3].fire("click"); // All screens
  await flush();
  assert.deepEqual(sent("screen_capture"), [{ display: null }]);
  assert.equal(view.el.find("IMG").length, 2);
  view.el.find(".btn").find((b) => b.textContent === "Cancel").fire("click");
  view.sync();
  assert.deepEqual(sent("screen_discard"), [{ paths: [shot(0).path, shot(1).path] }]);
  assert.equal(view.el.find(".chip").length, 0);
  $(".chat-input").value = "hi";
  $(".send-btn").fire("click");
  await flush();
  assert.equal(sent("chat_send")[0].screen, undefined);
});

test("closing the panel during a preview deletes it too", async () => {
  await openMenu();
  entries()[2].fire("click");
  await flush();
  $(".screen-btn").fire("click");
  assert.deepEqual(sent("screen_discard"), [{ paths: [shot(1).path] }]);
});

test("a question typed before Send goes right away with the screenshots", async () => {
  $(".chat-input").value = "explain this error";
  await openMenu();
  entries()[3].fire("click");
  await flush();
  view.el.find(".btn").find((b) => b.textContent === "Send").fire("click");
  await flush();
  const turn = sent("chat_send")[0];
  assert.equal(turn.query, "explain this error");
  assert.deepEqual(turn.screen.shots.map((s) => s.name), ["Screen 1", "Screen 2"]);
});

test("the open windows become a chip, can be removed, and are sent as a list", async () => {
  await openMenu();
  entries()[0].fire("click");
  await flush();
  view.sync();
  assert.equal(sent("screen_windows").length, 1);
  assert.equal(sent("screen_capture").length, 0, "no screenshot for a window list");
  const chip = view.el.find(".chip")[0];
  assert.equal(chip.find("SPAN")[0].textContent, "Open windows (2)");

  chip.find(".chip-remove")[0].fire("click");
  view.sync();
  assert.equal(view.el.find(".chip").length, 0);

  await openMenu();
  entries()[0].fire("click");
  await flush();
  $(".chat-input").value = "which one is my editor?";
  $(".send-btn").fire("click");
  await flush();
  assert.deepEqual(sent("chat_send")[0].screen, { windows: WINDOWS, shots: [] });
});

test("a local model can't take a screenshot: the screens are greyed out and say why", async () => {
  State.settings = { ...State.settings, chatProvider: "ollama", ollamaUrl: "http://localhost:11434" };
  await openMenu();
  const rows = entries();
  assert.equal(rows[0].getAttribute("disabled"), null, "the window list is text: fine");
  assert.equal(rows[1].getAttribute("disabled"), "");
  rows[1].fire("click");
  await flush();
  assert.equal(sent("screen_capture").length, 0);
  assert.ok(view.el.find(".picker-status").some((s) => s.textContent === "Screenshots need the Claude Code or Anthropic provider."));
});

test("on Linux the menu says it isn't available, and nothing else happens", async () => {
  answers.screen_displays = () => Promise.reject(new Error("Not available on Linux yet."));
  answers.screen_windows = () => Promise.reject(new Error("Not available on Linux yet."));
  await openMenu();
  assert.ok(view.el.find(".picker-status").some((s) => s.textContent === "Not available on Linux yet."));
  entries()[0].fire("click");
  await flush();
  assert.ok(view.el.find(".picker-status").some((s) => s.textContent === "Not available on Linux yet."));
  assert.equal(view.el.find(".chip").length, 0);
});

test("a new chat deletes screenshots that were never sent", async () => {
  await openMenu();
  entries()[1].fire("click");
  await flush();
  view.el.find(".btn").find((b) => b.textContent === "Send").fire("click");
  view.el.find(".tool-btn")[0].fire("click"); // New chat
  assert.deepEqual(sent("screen_discard"), [{ paths: [shot(0).path] }]);
  view.sync();
  assert.equal(view.el.find(".chip").length, 0);
});

// ── The sharing shortcuts (island/shortcuts.ts runShared hands them over) ─────

test("a screenshot from the shortcut waits as a chip with its picture, and a new one replaces it", () => {
  State.incomingShare = { kind: "screen", shots: [shot(0)] };
  view.sync();
  assert.equal(State.incomingShare, null, "taken");
  const chip = view.el.find(".chip")[0];
  assert.equal(chip.find("SPAN")[0].textContent, "Screen 1");
  assert.equal(chip.find("IMG")[0].getAttribute("src"), shot(0).preview);
  assert.equal(sent("screen_capture").length, 0, "Rust took it on the key press");

  State.incomingShare = { kind: "screen", shots: [shot(1)] };
  view.sync();
  assert.deepEqual(sent("screen_discard"), [{ paths: [shot(0).path] }]);
  assert.deepEqual(view.el.find(".chip").map((c) => c.find("SPAN")[0].textContent), ["Screen 2"]);
});

test("selected text from the shortcut goes with the next question once, and × takes it back", async () => {
  const selection = { text: "def f(): pass", app: "Code", title: "main.py" };
  State.incomingShare = { kind: "selection", selection };
  view.sync();
  const chip = view.el.find(".chip")[0];
  assert.equal(chip.find("SPAN")[0].textContent, "Text from Code");
  assert.equal(chip.getAttribute("title"), "def f(): pass");
  chip.find(".chip-remove")[0].fire("click");
  view.sync();
  assert.equal(view.el.find(".chip").length, 0);

  State.incomingShare = { kind: "selection", selection };
  view.sync();
  $(".chat-input").value = "what does it do?";
  $(".send-btn").fire("click");
  await flush();
  view.sync();
  const turn = sent("chat_send")[0];
  assert.equal(turn.query, "what does it do?");
  assert.deepEqual(turn.screen, { windows: [], shots: [], selection });
  assert.equal(view.el.find(".chip").length, 0, "sent once, then forgotten");
});

// ── The folder open in File Explorer ─────────────────────────────────────────

test("the File Explorer entry names the folder, and only a click lists it", async () => {
  await openMenu();
  const row = explorerEntry();
  assert.equal(row.getAttribute("disabled"), null);
  assert.equal(row.find(".history-date")[0].textContent, "PDFs");
  assert.equal(sent("screen_explorer").length, 0, "nothing listed yet");

  row.fire("click");
  await flush();
  view.sync();
  assert.equal(sent("screen_explorer").length, 1);
  assert.ok(!$(".chat-body").classList.contains("screening"));
  const chip = view.el.find(".chip")[0];
  assert.equal(chip.find("SPAN")[0].textContent, "PDFs");
  assert.equal(chip.getAttribute("title"), FOLDER.path);

  chip.find(".chip-remove")[0].fire("click");
  view.sync();
  assert.equal(view.el.find(".chip").length, 0);
  $(".chat-input").value = "hi";
  $(".send-btn").fire("click");
  await flush();
  assert.equal(sent("chat_send")[0].screen, undefined, "taken back: nothing goes");
  assert.equal(sent("explorer_attach").length, 0);
});

test("no File Explorer window, or Linux: the entry is greyed out and says why", async () => {
  answers.screen_explorer_peek = null;
  await openMenu();
  assert.equal(explorerEntry().getAttribute("disabled"), "");
  explorerEntry().fire("click");
  await flush();
  assert.equal(sent("screen_explorer").length, 0);
  assert.ok(view.el.find(".picker-status").some((s) => s.textContent === "No folder is open in File Explorer."));

  $(".screen-btn").fire("click");
  answers.screen_explorer_peek = () => Promise.reject(new Error("Not available on Linux yet."));
  await openMenu();
  assert.equal(explorerEntry().getAttribute("disabled"), "");
  assert.ok(view.el.find(".picker-status").some((s) => s.textContent === "Not available on Linux yet."));
});

async function shareFolder() {
  await openMenu();
  explorerEntry().fire("click");
  await flush();
}

test("the folder goes with the question, and the file it names is attached like a picked one", async () => {
  await shareFolder();
  $(".chat-input").value = "mi leggi il file 'file.pdf'?";
  $(".send-btn").fire("click");
  await flush();
  await flush();
  view.sync();
  assert.deepEqual(sent("explorer_attach"), [{ folder: FOLDER.path, query: "mi leggi il file 'file.pdf'?" }]);
  const turn = sent("chat_send")[0];
  assert.deepEqual(turn.context, { kind: "file", name: "file.pdf", path: COPIED.path });
  assert.deepEqual(turn.screen, { windows: [], shots: [], folder: FOLDER });
  assert.deepEqual(view.el.find(".chip").map((c) => c.find("SPAN")[0].textContent), ["file.pdf"], "the file's chip, as with the paperclip");
  assert.equal(sent("chat_reset").length, 0, "Claude Code reads it mid-conversation too");

  $(".chat-input").value = "and the next page?";
  $(".send-btn").fire("click");
  await flush();
  assert.equal(sent("chat_send")[1].screen, undefined, "the folder went once");
  assert.equal(sent("chat_send")[1].context, null, "so did the file");
  assert.equal(sent("explorer_attach").length, 1);
});

test("a question naming no file sends the folder alone", async () => {
  await shareFolder();
  $(".chat-input").value = "what's in here?";
  $(".send-btn").fire("click");
  await flush();
  await flush();
  const turn = sent("chat_send")[0];
  assert.equal(turn.context, null);
  assert.deepEqual(turn.screen.folder, FOLDER);
});

test("a file the user added and hasn't sent yet is never replaced", async () => {
  State.droppedFile = { name: "contract.docx", path: "C:\\Lumo\\inbox\\contract.docx" };
  await shareFolder();
  $(".chat-input").value = "compare with file.pdf";
  $(".send-btn").fire("click");
  await flush();
  await flush();
  assert.equal(sent("explorer_attach").length, 0);
  assert.equal(sent("chat_send")[0].context.name, "contract.docx");
});

test("another provider takes the named file in a new chat, as with the paperclip", async () => {
  State.settings = { ...State.settings, chatProvider: "anthropic" };
  State.chatHistory = [{ id: 1, role: "user", content: "hi" }, { id: 2, role: "assistant", content: "hello" }];
  await shareFolder();
  $(".chat-input").value = "read file.pdf";
  $(".send-btn").fire("click");
  await flush();
  await flush();
  const order = calls.map(([cmd]) => cmd).filter((cmd) => cmd === "chat_reset" || cmd === "chat_send");
  assert.deepEqual(order, ["chat_reset", "chat_send"]);
  assert.deepEqual(sent("chat_send")[0].context, { kind: "file", name: "file.pdf", path: COPIED.path });
  assert.deepEqual(State.chatHistory.map((m) => m.content), ["read file.pdf", "I see VS Code."]);
});

// ── "Always share the folder open in File Explorer" (Settings → Chat) ─────────

test("the folder that goes by itself shows as a chip, but is nothing to send until the message goes", () => {
  const p = { ...emptyScreen(), autoFolder: PEEKED };
  assert.equal(hasScreen(p), false, "its listing is taken when the message goes");
  assert.equal(screenPayload(p), null);
  assert.deepEqual(screenChips(p), [{ kind: "folder", label: "PDFs", title: FOLDER.path }]);
  assert.ok(sharesFolderByItself(p, true));
  assert.ok(!sharesFolderByItself(p, false), "the setting is off");

  const off = withoutFolder(p);
  assert.deepEqual(screenChips(off), [], "its × leaves it out");
  assert.ok(!sharesFolderByItself(off, true));
  assert.deepEqual(nextScreen(off), { ...emptyScreen(), autoFolder: PEEKED }, "back for the next message");

  const picked = { ...p, folder: FOLDER };
  assert.deepEqual(screenChips(picked).length, 1, "one chip, the shared folder's");
  assert.ok(!sharesFolderByItself(picked, true), "the menu already shared one");
  assert.deepEqual(screenChips(withoutFolder(picked)), []);
});

const folderChips = () => view.el.find(".chip").filter((c) => c.getAttribute("title") === FOLDER.path);

async function turnOnSharing() {
  State.settings = { ...State.settings, chatShareExplorer: true };
  view.sync();
  await flush();
  view.sync();
}

async function ask(text) {
  $(".chat-input").value = text;
  $(".send-btn").fire("click");
  for (let i = 0; i < 4; i++) await flush();
  view.sync();
}

test("off (the default), nothing is asked of File Explorer and nothing rides along", async () => {
  assert.equal(DEFAULT_SETTINGS.chatShareExplorer, false);
  $(".chat-input").fire("focus");
  await flush();
  await ask("hi");
  assert.equal(sent("screen_explorer_peek").length, 0);
  assert.equal(sent("screen_explorer").length, 0);
  assert.equal(sent("chat_send")[0].screen, undefined);
});

test("on, every message carries the folder open in File Explorer, its chip showing first", async () => {
  await turnOnSharing();
  assert.equal(sent("screen_explorer_peek").length, 1, "its name, for the chip");
  assert.equal(sent("screen_explorer").length, 0, "nothing listed before the message goes");
  assert.equal(folderChips().length, 1);
  assert.equal(folderChips()[0].find("SPAN")[0].textContent, "PDFs");

  await ask("what's in here?");
  assert.equal(sent("screen_explorer").length, 1);
  assert.deepEqual(sent("chat_send")[0].screen, { windows: [], shots: [], folder: FOLDER });
  assert.equal(folderChips().length, 1, "still there for the next message");

  await ask("mi leggi il file 'file.pdf'?");
  assert.equal(sent("screen_explorer").length, 2, "listed again: the folder may have changed");
  assert.deepEqual(sent("chat_send")[1].screen.folder, FOLDER);
  assert.deepEqual(sent("chat_send")[1].context, { kind: "file", name: "file.pdf", path: COPIED.path }, "a named file is attached as from the menu");
});

test("its chip's × leaves the folder out of that message only", async () => {
  await turnOnSharing();
  folderChips()[0].find(".chip-remove")[0].fire("click");
  view.sync();
  assert.equal(folderChips().length, 0);
  await ask("hi");
  assert.equal(sent("screen_explorer").length, 0);
  assert.equal(sent("chat_send")[0].screen, undefined);
  assert.equal(folderChips().length, 1, "back for the next one");
  await ask("and now?");
  assert.deepEqual(sent("chat_send")[1].screen.folder, FOLDER);
});

test("a folder picked from the menu is sent once, not twice", async () => {
  await turnOnSharing();
  await shareFolder();
  view.sync();
  assert.equal(folderChips().length, 1);
  await ask("hi");
  assert.equal(sent("screen_explorer").length, 1, "the menu's click only");
  assert.deepEqual(sent("chat_send")[0].screen.folder, FOLDER);
});

test("no File Explorer window, or Linux: no chip, nothing sent, no error", async () => {
  answers.screen_explorer_peek = () => Promise.reject(new Error("Not available on Linux yet."));
  answers.screen_explorer = () => Promise.reject(new Error("Not available on Linux yet."));
  await turnOnSharing();
  assert.equal(folderChips().length, 0);
  await ask("hi");
  assert.equal(sent("chat_send")[0].screen, undefined);
  assert.notEqual(State.view, "note");

  answers.screen_explorer = null;
  await ask("again");
  assert.equal(sent("chat_send")[1].screen, undefined);
});

test("the field taking focus asks for the folder again, not more than once in a while", async () => {
  await turnOnSharing();
  answers.screen_explorer_peek = { ...PEEKED, path: "C:\\Users\\me\\Music", name: "Music" };
  $(".chat-input").fire("focus");
  await flush();
  assert.equal(sent("screen_explorer_peek").length, 1, "just asked");
  await new Promise((resolve) => setTimeout(resolve, 1600));
  $(".chat-input").fire("focus");
  await flush();
  view.sync();
  assert.equal(sent("screen_explorer_peek").length, 2);
  assert.deepEqual(view.el.find(".chip").map((c) => c.find("SPAN")[0].textContent), ["Music"]);
});

test("turned off, the chip goes and nothing more is sent", async () => {
  await turnOnSharing();
  State.settings = { ...State.settings, chatShareExplorer: false };
  view.sync();
  assert.equal(folderChips().length, 0);
  await ask("hi");
  assert.equal(sent("screen_explorer").length, 0);
  assert.equal(sent("chat_send")[0].screen, undefined);
});
