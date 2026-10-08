// The chat's screen button (src/core/screen.ts and the chat view): nothing is
// listed or captured before a click, a screenshot is previewed and joins the
// chat only on Send (Cancel deletes it), the window list rides as text, and
// what was added goes with one question only.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, internals, sent } from "./tauri.mjs";

installFakeDom();
const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { providerDef } = await import("../src/core/providers.ts");
const {
  emptyScreen, entryLabel, hasScreen, keepShots, menuEntries, screenChips, screenPayload, seesImages, shotPaths,
} = await import("../src/core/screen.ts");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const DISPLAYS = [
  { index: 0, width: 2560, height: 1440, primary: true },
  { index: 1, width: 1920, height: 1080, primary: false },
];
const WINDOWS = [
  { title: "main.rs — coucou", app: "Code", active: true, minimized: false },
  { title: "Inbox", app: "outlook", active: false, minimized: true },
];
const shot = (display) => ({
  display,
  name: `screenshot-2026-10-08-090503-screen${display + 1}.png`,
  path: `C:\\Coucou\\inbox\\screenshot-2026-10-08-090503-screen${display + 1}.png`,
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
  assert.equal(chips[0].title, "main.rs — coucou — Code\nInbox — outlook");
  assert.deepEqual(shotPaths(p), [shot(0).path, shot(1).path]);
  // A window list on its own is still something to send.
  assert.deepEqual(screenPayload({ windows: [], shots: [] }), { windows: [], shots: [] });
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
const nothingCaptured = () => sent("screen_capture").length === 0 && sent("screen_windows").length === 0;

async function openMenu() {
  $(".screen-btn").fire("click");
  await flush();
}

test("opening the menu only asks which screens there are", async () => {
  await openMenu();
  assert.ok($(".chat-body").classList.contains("screening"));
  assert.deepEqual(entries().map((e) => e.find(".picker-model-name")[0].textContent), ["Open windows", "Screen 1", "Screen 2", "All screens"]);
  assert.equal(sent("screen_displays").length, 1);
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
