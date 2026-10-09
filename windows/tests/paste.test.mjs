// Ctrl+V in the chat (src/core/paste.ts and the chat view): text pastes as
// usual, a file copied in File Explorer comes from Rust (the clipboard's file
// list), and an image the page got (a Win+Shift+S screenshot) goes to the
// inbox as bytes — either way attached as with the paperclip.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, internals, sent } from "./tauri.mjs";

installFakeDom();
const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { MAX_PASTE_BYTES, pasteAction, pastedFiles, pastedName } = await import("../src/core/paste.ts");

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** A paste event's clipboardData. */
function clipboard({ text = "", files = [], items = null } = {}) {
  return {
    files,
    items: items ?? files.map((f) => ({ kind: "file", getAsFile: () => f })),
    getData: (type) => (type === "text/plain" ? text : ""),
  };
}

const screenshot = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", { type: "image/png" });

// ── Pure parts ────────────────────────────────────────────────────────────────

test("text pastes as text, even with a picture of it next to it", () => {
  assert.equal(pasteAction(clipboard({ text: "hello" })), "text");
  assert.equal(pasteAction(clipboard({ text: "A1\tB1", files: [screenshot()] })), "text", "Excel cells");
  assert.equal(pasteAction(clipboard({ files: [screenshot()] })), "attach");
  assert.equal(pasteAction(clipboard()), "attach", "nothing the page can read: maybe files copied in File Explorer");
  assert.equal(pasteAction(null), "text");
});

test("the pasted files come from files, else from the items that are files", () => {
  const shot = screenshot();
  assert.deepEqual(pastedFiles(clipboard({ files: [shot] })), [shot]);
  const items = [{ kind: "string", getAsFile: () => null }, { kind: "file", getAsFile: () => shot }];
  assert.deepEqual(pastedFiles(clipboard({ items })), [shot]);
  assert.deepEqual(pastedFiles(null), []);
});

test("a clipboard image is named after when it was pasted, a file keeps its name", () => {
  const at = new Date(2026, 9, 8, 9, 5, 3);
  assert.equal(pastedName({ name: "image.png", type: "image/png" }, at), "pasted-2026-10-08-090503.png");
  assert.equal(pastedName({ name: "", type: "image/jpeg" }, at), "pasted-2026-10-08-090503.jpg");
  assert.equal(pastedName({ name: "image.JPG", type: "" }, at), "pasted-2026-10-08-090503.jpg");
  assert.equal(pastedName({ name: "Bilancio 2025.xlsx", type: "" }, at), "Bilancio 2025.xlsx");
  assert.equal(pastedName({ name: "image-of-cat.png", type: "image/png" }, at), "image-of-cat.png");
});

// ── The chat view ────────────────────────────────────────────────────────────

const SAVED = { name: "pasted-2026-10-08-090503.png", path: "C:\\Lumo\\inbox\\pasted-2026-10-08-090503.png", size: 4 };
const COPIED = { name: "contract.pdf", path: "C:\\Lumo\\inbox\\contract.pdf", size: 2048 };

let answers;
/** The raw invoke options (headers) of each paste_file. */
let pasteOptions;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args, options) => {
  const result = await plainInvoke(cmd, args);
  if (cmd === "paste_file") pasteOptions.push(options);
  if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : answers[cmd];
  return result;
};

let view;
beforeEach(() => {
  calls.length = 0;
  pasteOptions = [];
  answers = { paste_copied_file: null, paste_file: SAVED, chat_send: { text: "A screenshot of an error." } };
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {}, chatProvider: "claude-code" };
  State.chatHistory = [];
  State.stateOverride = null;
  State.view = "prompt";
  State.droppedFile = null;
  State.promptContext = null;
  view = buildPrompt(() => {});
  view.el.querySelector(".chat-input").value = "";
  view.sync();
});

const input = () => view.el.querySelector(".chat-input");
const chips = () => view.el.find(".chip").map((c) => c.find("SPAN")[0].textContent);

test("pasting text is left to the field: nothing is attached", async () => {
  const event = input().fire("paste", { clipboardData: clipboard({ text: "some text" }) });
  await flush();
  assert.equal(event.defaultPrevented, false);
  assert.equal(sent("paste_copied_file").length, 0);
  assert.equal(sent("paste_file").length, 0);
  assert.equal(State.droppedFile, null);
});

test("a pasted screenshot lands in the inbox and is attached like a picked file", async () => {
  input().value = "what's this error?";
  const event = input().fire("paste", { clipboardData: clipboard({ files: [screenshot()] }) });
  assert.equal(event.defaultPrevented, true);
  await flush();
  view.sync();
  assert.equal(sent("paste_copied_file").length, 1, "File Explorer's files first");
  const [bytes] = sent("paste_file");
  assert.deepEqual([...bytes], [0x89, 0x50, 0x4e, 0x47]);
  assert.match(decodeURIComponent(pasteOptions[0].headers["x-lumo-name"]), /^pasted-\d{4}-\d\d-\d\d-\d{6}\.png$/);
  assert.deepEqual(State.droppedFile, { name: SAVED.name, path: SAVED.path });
  assert.deepEqual(chips(), [SAVED.name]);
  assert.equal(input().value, "what's this error?", "the question typed so far stays");

  input().value = "what's this error?";
  view.el.querySelector(".send-btn").fire("click");
  await flush();
  assert.deepEqual(sent("chat_send")[0].context, { kind: "file", name: SAVED.name, path: SAVED.path });
});

test("a file copied in File Explorer comes from Rust, whatever the page saw", async () => {
  answers.paste_copied_file = COPIED;
  input().fire("paste", { clipboardData: clipboard() });
  await flush();
  view.sync();
  assert.equal(sent("paste_file").length, 0, "no bytes through the page");
  assert.deepEqual(State.droppedFile, { name: COPIED.name, path: COPIED.path });
  assert.deepEqual(chips(), ["contract.pdf"]);

  // WebView2 handing the page the file too changes nothing.
  State.droppedFile = null;
  input().fire("paste", { clipboardData: clipboard({ files: [new File(["x"], "contract.pdf")] }) });
  await flush();
  assert.equal(sent("paste_file").length, 0);
  assert.equal(State.droppedFile.path, COPIED.path);
});

test("another provider takes the pasted file in a new chat, as with the paperclip", async () => {
  State.settings = { ...State.settings, chatProvider: "anthropic" };
  State.chatHistory = [{ id: 1, role: "user", content: "hi" }];
  input().fire("paste", { clipboardData: clipboard({ files: [screenshot()] }) });
  await flush();
  assert.equal(sent("chat_reset").length, 1);
  assert.deepEqual(State.chatHistory, []);
  assert.equal(State.droppedFile.path, SAVED.path);
});

test("nothing on the clipboard to attach: nothing happens", async () => {
  input().fire("paste", { clipboardData: clipboard() });
  await flush();
  assert.equal(sent("paste_copied_file").length, 1);
  assert.equal(sent("paste_file").length, 0);
  assert.equal(State.droppedFile, null);
  assert.notEqual(State.view, "note");
});

test("too big to paste: the note says to use the paperclip, nothing is sent", async () => {
  const big = { name: "image.png", type: "image/png", size: MAX_PASTE_BYTES + 1, arrayBuffer: () => assert.fail("never read") };
  input().fire("paste", { clipboardData: clipboard({ files: [big] }) });
  await flush();
  assert.equal(sent("paste_file").length, 0);
  assert.equal(State.view, "note");
  assert.equal(State.noteMessage, "This file is too big to paste. Attach it with the paperclip instead.");
});

test("an error from Rust is shown as a note", async () => {
  answers.paste_file = () => Promise.reject(new Error("Cannot copy: disk full"));
  input().fire("paste", { clipboardData: clipboard({ files: [screenshot()] }) });
  await flush();
  assert.equal(State.view, "note");
  assert.equal(State.noteMessage, "Cannot copy: disk full");
  assert.equal(State.droppedFile, null);
});
