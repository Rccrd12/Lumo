// The chat's screen button (src/core/screen.ts and the chat view): nothing is
// captured before a click, a screenshot is previewed and joins the chat only
// on Send (Cancel deletes it), a window or a browser tab is picked from a
// second list and goes with what it shows, the folder open in File Explorer
// is offered only when there is one, listed only on a click, and attaches the
// file the question names, and what was added goes with one question only.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, internals, sent } from "./tauri.mjs";

installFakeDom();
const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
const { providerDef } = await import("../src/core/providers.ts");
const {
  emptyScreen, entryLabel, hasScreen, hostOf, itemPreview, keepShots, menuEntries, nextScreen, screenItems, screenPayload,
  seesImages, sharesFolderByItself, short, shotPaths, tabPicks, windowPicks, withTabs, withWindows, withoutFolder, withoutItem,
} = await import("../src/core/screen.ts");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const DISPLAYS = [
  { index: 0, width: 2560, height: 1440, primary: true },
  { index: 1, width: 1920, height: 1080, primary: false },
];
const WINDOWS = [
  { id: 101, title: "main.rs — lumo", app: "Code", active: true, minimized: false },
  { id: 202, title: "Inbox", app: "outlook", active: false, minimized: true },
];
/** What screen_window_share gives for them. */
const SHARED = [
  { title: "main.rs — lumo", app: "Code", text: "fn main() {}", cut: false, document: "C:\\code\\main.rs" },
  { title: "Inbox", app: "outlook", text: "3 unread", cut: false, document: "" },
];
const TABS = [
  { id: "Edge|Default|1", browser: "Edge", title: "Rccrd12/Lumo", url: "https://github.com/Rccrd12/Lumo", active: true, text: "", cut: false, source: "" },
  { id: "Edge|Default|2", browser: "Edge", title: "Luce – Wikipedia", url: "https://it.wikipedia.org/wiki/Luce", active: false, text: "", cut: false, source: "" },
];
const read = (tab, text, source) => ({ ...tab, text, source });
const WINDOW_SHOT = {
  display: 0,
  name: "window-2026-10-08-090503.png",
  path: "C:\\Lumo\\inbox\\window-2026-10-08-090503.png",
  width: 1200,
  height: 800,
  preview: "data:image/png;base64,iVBORw0KGgo=",
};
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

test("the File Explorer entry comes last, and only when a folder is open", () => {
  const [, found] = menuEntries([], { folder: PEEKED, problem: "" });
  assert.deepEqual(found, { kind: "explorer", folder: PEEKED });
  assert.equal(entryLabel(found), "Folder open in File Explorer");
  assert.deepEqual(menuEntries([], { folder: null, problem: "" }).map(entryLabel), ["Open windows"], "none open: no entry");
  assert.deepEqual(menuEntries([], { folder: PEEKED, problem: "Not available on Linux yet." }).map(entryLabel), ["Open windows"]);
});

test("the browser tabs come after the windows, only when a browser has some open", () => {
  assert.deepEqual(menuEntries(DISPLAYS, undefined, TABS).map(entryLabel), ["Open windows", "Browser tabs", "Screen 1", "Screen 2", "All screens"]);
  assert.deepEqual(menuEntries(DISPLAYS, undefined, TABS)[1], { kind: "tabs", count: 2 });
  assert.deepEqual(menuEntries([], undefined, []).map(entryLabel), ["Open windows"]);
});

test("the second list: all of them first, then each window or tab", () => {
  const windows = windowPicks(WINDOWS);
  assert.deepEqual(windows.map((p) => [p.id, p.label, p.detail]), [
    [null, "All windows", "2"],
    [101, "main.rs — lumo", "Code"],
    [202, "Inbox", "outlook · minimized"],
  ]);
  assert.equal(windows[1].title, "main.rs — lumo — Code");
  assert.deepEqual(windowPicks([]), []);
  const tabs = tabPicks(TABS);
  assert.deepEqual(tabs.map((p) => [p.id, p.label, p.detail]), [
    [null, "All tabs", "2"],
    ["Edge|Default|1", "Rccrd12/Lumo", "github.com"],
    ["Edge|Default|2", "Luce – Wikipedia", "it.wikipedia.org"],
  ]);
  const both = tabPicks([...TABS, { ...TABS[0], id: "Chrome|Default|9", browser: "Chrome", url: "https://www.example.com/a" }]);
  assert.equal(both[3].detail, "example.com · Chrome", "the browser, when both have tabs");
  assert.equal(hostOf("not an address"), "not an address");
});

test("a tab in the background on Windows has no address yet: its title alone, the browser when both have tabs", () => {
  const unread = { ...TABS[1], id: "Edge|101|1", url: "" };
  const [, one] = tabPicks([unread]);
  assert.deepEqual([one.label, one.detail, one.title], ["Luce – Wikipedia", "", "Luce – Wikipedia"]);
  const both = tabPicks([unread, { ...TABS[0], id: "Chrome|202|0", browser: "Chrome" }]);
  assert.equal(both[1].detail, "Edge", "no stray separator");
  assert.equal(both[2].detail, "github.com · Chrome");
  const items = screenItems({ ...emptyScreen(), tabs: [unread, TABS[0]] });
  assert.deepEqual(items.map((i) => [i.label, i.detail, i.title]), [
    ["Luce – Wikipedia", "Web page · Edge", "Luce – Wikipedia"],
    ["Rccrd12/Lumo", "Web page · github.com", "Rccrd12/Lumo — https://github.com/Rccrd12/Lumo"],
  ]);
});

test("picking again adds to what is waiting, the same window or tab replaced", () => {
  assert.deepEqual(withWindows([SHARED[0]], [{ ...SHARED[0], text: "new" }, SHARED[1]]).map((w) => w.text), ["new", "3 unread"]);
  assert.deepEqual(withTabs([read(TABS[0], "a", "page")], [read(TABS[1], "b", "web")]).map((t) => t.id), [TABS[0].id, TABS[1].id]);
  assert.deepEqual(withTabs([read(TABS[0], "a", "page")], [read(TABS[0], "b", "page")]).map((t) => t.text), ["b"]);
  assert.equal(short("short"), "short");
  assert.equal(short("x".repeat(40)), `${"x".repeat(31)}…`);
});

test("a shared folder is something to send, with an attachment naming it", () => {
  const p = { ...emptyScreen(), folder: FOLDER };
  assert.ok(hasScreen(p));
  assert.deepEqual(screenPayload(p), { windows: [], shots: [], folder: FOLDER });
  assert.deepEqual(screenItems(p), [{ kind: "folder", key: FOLDER.path, label: "PDFs", detail: `Folder · ${FOLDER.path}`, title: FOLDER.path }]);
  assert.equal(screenPayload({ ...p, folder: null }), null);
});

test("only the local model servers can't look at a screenshot", () => {
  for (const id of ["anthropic", "claude-code", "openai", "google", "openrouter"]) assert.ok(seesImages(providerDef(id)), id);
  for (const id of ["ollama", "lmstudio", "custom"]) assert.ok(!seesImages(providerDef(id)), id);
});

test("what is waiting becomes one payload, one attachment each and a list of files to delete", () => {
  let p = emptyScreen();
  assert.equal(hasScreen(p), false);
  assert.equal(screenPayload(p), null);
  assert.deepEqual(screenItems(p), []);

  p = { ...p, windows: SHARED, tabs: [read(TABS[0], "README", "page")] };
  p = keepShots(p, [shot(0), shot(1)]);
  assert.ok(hasScreen(p));
  assert.deepEqual(screenPayload(p), {
    windows: [],
    shots: [
      { name: "Screen 1", path: shot(0).path },
      { name: "Screen 2", path: shot(1).path },
    ],
    sharedWindows: SHARED,
    tabs: [read(TABS[0], "README", "page")],
  });
  const items = screenItems(p);
  assert.deepEqual(items.map((i) => [i.kind, i.label, i.detail]), [
    ["window", "main.rs — lumo", "Window · Code"],
    ["window", "Inbox", "Window · outlook"],
    ["tab", "Rccrd12/Lumo", "Web page · github.com"],
    ["shot", "Screen 1", "Screenshot"],
    ["shot", "Screen 2", "Screenshot"],
  ]);
  assert.equal(items[0].title, "main.rs — lumo — Code");
  assert.equal(items[2].title, "Rccrd12/Lumo — https://github.com/Rccrd12/Lumo");
  assert.equal(items[3].thumb, shot(0).preview);
  assert.deepEqual(shotPaths(p), [shot(0).path, shot(1).path]);
  // Each one is taken back on its own: the others of its kind stay.
  assert.deepEqual(withoutItem(p, items[3]).shots.map((s) => s.name), ["Screen 2"]);
  assert.deepEqual(withoutItem(p, items[1]).windows, [SHARED[0]]);
  assert.deepEqual(withoutItem(p, items[2]).tabs, []);
  assert.equal(withoutItem(p, items[2]).shots.length, 2, "nothing else goes");
  // One window, or tabs on their own, are something to send too.
  assert.deepEqual(screenItems({ ...emptyScreen(), windows: [SHARED[1]] }).map((c) => c.label), ["Inbox"]);
  assert.deepEqual(screenItems({ ...emptyScreen(), tabs: TABS }).map((c) => c.label), ["Rccrd12/Lumo", "Luce – Wikipedia"]);
  assert.ok(hasScreen({ ...emptyScreen(), tabs: TABS }));
});

test("selected text is something to send, with an attachment naming the app and showing the text", () => {
  const selection = { text: "Le contrat est conclu pour un an.", app: "Acrobat", title: "bail.pdf" };
  const p = { ...emptyScreen(), selection };
  assert.ok(hasScreen(p));
  assert.deepEqual(screenPayload(p), { windows: [], shots: [], selection });
  assert.deepEqual(screenItems(p), [{ kind: "selection", key: selection.text, label: "Text from Acrobat", detail: selection.text, title: selection.text }]);
  const long = { ...p, selection: { text: "x".repeat(1000), app: "", title: "" } };
  const [item] = screenItems(long);
  assert.equal(item.label, "Selected text");
  assert.equal(item.title, `${"x".repeat(400)}…`);
  assert.equal(item.detail, `${"x".repeat(119)}…`, "on one line under its name");
  assert.equal(screenItems({ ...p, selection: { ...selection, text: "two\n\n  lines" } })[0].detail, "two lines");
  assert.equal(screenPayload({ ...p, selection: null }), null);
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
  State.moreFiles = [];
  answers = {
    screen_displays: DISPLAYS,
    screen_windows: WINDOWS,
    screen_window_share: (args) => (args.ids.length === 0 ? SHARED : SHARED.filter((_, i) => WINDOWS[i].id === args.ids[0])),
    screen_window_shot: WINDOW_SHOT,
    screen_tabs: TABS,
    screen_tab_share: (args) => (args.ids.length === 0
      ? [read(TABS[0], "README", "page"), read(TABS[1], "La luce", "web")]
      : [read(TABS.find((t) => t.id === args.ids[0]), "README", "page")]),
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
/** The attachments' rows, and their names. */
const rows = () => view.el.find(".attach-row");
const names = () => rows().map((r) => r.find(".attach-name")[0].textContent);
const entries = () => view.el.find(".screen-entry");
const nothingCaptured = () =>
  sent("screen_capture").length === 0 && sent("screen_windows").length === 0 && sent("screen_explorer").length === 0 &&
  sent("screen_window_share").length === 0 && sent("screen_tab_share").length === 0;
const label = (row) => row.find(".picker-model-name")[0].textContent;
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
    ["Open windows", "Browser tabs", "Screen 1", "Screen 2", "All screens", "Folder open in File Explorer"],
  );
  assert.equal(sent("screen_displays").length, 1);
  assert.equal(sent("screen_explorer_peek").length, 1, "the folder's name, for the label");
  assert.equal(sent("screen_tabs").length, 1, "the tabs' titles, for the entry");
  assert.ok(nothingCaptured(), "nothing until an entry is clicked");
  $(".screen-btn").fire("click");
  assert.ok(!$(".chat-body").classList.contains("screening"));
  assert.ok(nothingCaptured());
});

test("a screenshot is previewed, kept on Attach and goes with the next question once", async () => {
  await openMenu();
  entries()[2].fire("click"); // Screen 1
  await flush();
  assert.deepEqual(sent("screen_capture"), [{ display: 0 }]);
  const img = view.el.find("IMG")[0];
  assert.equal(img.getAttribute("src"), shot(0).preview);
  assert.equal(rows().length, 0, "not chat context before Attach");

  view.el.find(".btn").find((b) => b.textContent === "Attach").fire("click");
  view.sync();
  assert.ok(!$(".chat-body").classList.contains("screening"));
  assert.deepEqual(names(), ["Screen 1"]);
  assert.deepEqual(sent("screen_discard"), [], "kept, not deleted");

  $(".chat-input").value = "what's wrong here?";
  $(".send-btn").fire("click");
  await flush();
  view.sync();
  assert.deepEqual(sent("chat_send")[0].screen, { windows: [], shots: [{ name: "Screen 1", path: shot(0).path }] });
  assert.equal(rows().length, 0, "sent once, then forgotten");

  $(".chat-input").value = "and now?";
  $(".send-btn").fire("click");
  await flush();
  assert.equal(sent("chat_send")[1].screen, undefined);
});

test("Cancel deletes the screenshots and adds nothing", async () => {
  await openMenu();
  entries()[4].fire("click"); // All screens
  await flush();
  assert.deepEqual(sent("screen_capture"), [{ display: null }]);
  assert.equal(view.el.find("IMG").length, 2);
  view.el.find(".btn").find((b) => b.textContent === "Cancel").fire("click");
  view.sync();
  assert.deepEqual(sent("screen_discard"), [{ paths: [shot(0).path, shot(1).path] }]);
  assert.equal(rows().length, 0);
  $(".chat-input").value = "hi";
  $(".send-btn").fire("click");
  await flush();
  assert.equal(sent("chat_send")[0].screen, undefined);
});

test("closing the panel during a preview deletes it too", async () => {
  await openMenu();
  entries()[3].fire("click"); // Screen 2
  await flush();
  $(".screen-btn").fire("click");
  assert.deepEqual(sent("screen_discard"), [{ paths: [shot(1).path] }]);
});

test("Attach never sends: a question typed before stays, and goes with the screenshots on Enter", async () => {
  $(".chat-input").value = "explain this error";
  await openMenu();
  entries()[4].fire("click");
  await flush();
  view.el.find(".btn").find((b) => b.textContent === "Attach").fire("click");
  await flush();
  view.sync();
  assert.equal(sent("chat_send").length, 0, "attached only");
  assert.equal($(".chat-input").value, "explain this error");
  assert.deepEqual(names(), ["Screen 1", "Screen 2"], "one row each");

  $(".send-btn").fire("click");
  await flush();
  const turn = sent("chat_send")[0];
  assert.equal(turn.query, "explain this error");
  assert.deepEqual(turn.screen.shots.map((s) => s.name), ["Screen 1", "Screen 2"]);
});

test("open windows: a second list, one window goes with its text and its picture", async () => {
  await openMenu();
  entries()[0].fire("click");
  await flush();
  assert.equal(sent("screen_windows").length, 1);
  assert.equal(sent("screen_window_share").length, 0, "nothing read before a pick");
  assert.deepEqual(entries().map(label), ["Back", "All windows", "main.rs — lumo", "Inbox"]);

  entries()[2].fire("click"); // main.rs — lumo
  await flush();
  await flush();
  view.sync();
  assert.deepEqual(sent("screen_window_share"), [{ ids: [101] }]);
  assert.deepEqual(sent("screen_window_shot"), [{ id: 101 }]);
  assert.ok(!$(".chat-body").classList.contains("screening"));
  assert.deepEqual(names(), ["main.rs — lumo", "main.rs — lumo"]);

  $(".chat-input").value = "what does this function do?";
  $(".send-btn").fire("click");
  await flush();
  assert.deepEqual(sent("chat_send")[0].screen, {
    windows: [],
    shots: [{ name: "main.rs — lumo", path: WINDOW_SHOT.path }],
    sharedWindows: [SHARED[0]],
  });
});

test("all windows go with their text, without pictures; a minimized one has no picture", async () => {
  await openMenu();
  entries()[0].fire("click");
  await flush();
  entries()[1].fire("click"); // All windows
  await flush();
  view.sync();
  assert.deepEqual(sent("screen_window_share"), [{ ids: [] }]);
  assert.equal(sent("screen_window_shot").length, 0);
  assert.deepEqual(names(), ["main.rs — lumo", "Inbox"], "one row each");
  rows()[0].find(".attach-remove")[0].fire("click");
  view.sync();
  assert.deepEqual(names(), ["Inbox"], "the × takes back that one only");
  rows()[0].find(".attach-remove")[0].fire("click");
  view.sync();
  assert.equal(rows().length, 0);

  await openMenu();
  entries()[0].fire("click");
  await flush();
  entries()[3].fire("click"); // Inbox, minimized
  await flush();
  assert.deepEqual(sent("screen_window_share")[1], { ids: [202] });
  assert.equal(sent("screen_window_shot").length, 0, "nothing to see of a minimized window");
});

test("a local model gets a window's text but no picture of it", async () => {
  State.settings = { ...State.settings, chatProvider: "ollama", ollamaUrl: "http://localhost:11434" };
  await openMenu();
  entries()[0].fire("click");
  await flush();
  entries()[2].fire("click");
  await flush();
  assert.deepEqual(sent("screen_window_share"), [{ ids: [101] }]);
  assert.equal(sent("screen_window_shot").length, 0);
});

test("Back returns to the first list", async () => {
  await openMenu();
  entries()[0].fire("click");
  await flush();
  entries()[0].fire("click"); // Back
  await flush();
  assert.equal(entries().map(label)[0], "Open windows");
  assert.ok(nothingCaptured() || sent("screen_window_share").length === 0);
});

test("browser tabs: one tab or all of them go with their pages' text", async () => {
  await openMenu();
  entries()[1].fire("click"); // Browser tabs
  await flush();
  assert.deepEqual(entries().map(label), ["Back", "All tabs", "Rccrd12/Lumo", "Luce – Wikipedia"]);
  assert.equal(sent("screen_tab_share").length, 0, "nothing read before a pick");
  entries()[2].fire("click");
  await flush();
  view.sync();
  assert.deepEqual(sent("screen_tab_share"), [{ ids: ["Edge|Default|1"] }]);
  assert.deepEqual(names(), ["Rccrd12/Lumo"]);

  await openMenu();
  entries()[1].fire("click");
  await flush();
  entries()[1].fire("click"); // All tabs
  await flush();
  view.sync();
  assert.deepEqual(sent("screen_tab_share")[1], { ids: [] });
  assert.deepEqual(names(), ["Rccrd12/Lumo", "Luce – Wikipedia"], "the same tab once, one row each");

  $(".chat-input").value = "summarise these";
  $(".send-btn").fire("click");
  await flush();
  assert.deepEqual(sent("chat_send")[0].screen.tabs.map((t) => [t.id, t.text, t.source]), [
    ["Edge|Default|1", "README", "page"],
    ["Edge|Default|2", "La luce", "web"],
  ]);
});

test("browsers slow to list their tabs never hold the menu: the entry joins it when they answer", async () => {
  let answer;
  answers.screen_tabs = () => new Promise((resolve) => { answer = resolve; });
  const realTimeout = globalThis.setTimeout;
  // The wait for the tabs runs out at once.
  globalThis.setTimeout = (fn, ms, ...rest) => realTimeout(fn, ms > 1000 ? 0 : ms, ...rest);
  try {
    $(".screen-btn").fire("click");
    await new Promise((resolve) => realTimeout(resolve, 5));
  } finally {
    globalThis.setTimeout = realTimeout;
  }
  assert.ok(!entries().map(label).includes("Browser tabs"), "drawn without them");
  assert.equal(entries().map(label)[0], "Open windows");
  answer(TABS);
  await flush();
  assert.deepEqual(entries().map(label).slice(0, 2), ["Open windows", "Browser tabs"]);
});

test("tabs that answer after the menu moved on don't redraw it", async () => {
  let answer;
  answers.screen_tabs = () => new Promise((resolve) => { answer = resolve; });
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => realTimeout(fn, ms > 1000 ? 0 : ms, ...rest);
  try {
    $(".screen-btn").fire("click");
    await new Promise((resolve) => realTimeout(resolve, 5));
  } finally {
    globalThis.setTimeout = realTimeout;
  }
  entries()[0].fire("click"); // Open windows
  await flush();
  answer(TABS);
  await flush();
  assert.equal(entries().map(label)[0], "Back", "still the window list");
});

test("no browser open: no tabs entry", async () => {
  answers.screen_tabs = [];
  await openMenu();
  assert.ok(!entries().map(label).includes("Browser tabs"));
  answers.screen_tabs = () => Promise.reject(new Error("Not available."));
  $(".screen-btn").fire("click");
  await openMenu();
  assert.ok(!entries().map(label).includes("Browser tabs"));
});

test("a local model can't take a screenshot: the screens are greyed out and say why", async () => {
  State.settings = { ...State.settings, chatProvider: "ollama", ollamaUrl: "http://localhost:11434" };
  await openMenu();
  const rows = entries();
  assert.equal(rows[0].getAttribute("disabled"), null, "the window list is text: fine");
  assert.equal(rows[2].getAttribute("disabled"), "");
  rows[2].fire("click");
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
  assert.equal(rows().length, 0);
});

test("a new chat deletes screenshots that were never sent", async () => {
  await openMenu();
  entries()[2].fire("click");
  await flush();
  view.el.find(".btn").find((b) => b.textContent === "Attach").fire("click");
  view.el.find(".tool-btn")[0].fire("click"); // New chat
  assert.deepEqual(sent("screen_discard"), [{ paths: [shot(0).path] }]);
  view.sync();
  assert.equal(rows().length, 0);
});

// ── The sharing shortcuts (island/shortcuts.ts runShared hands them over) ─────

test("a screenshot from the shortcut waits with its picture, and each new one is a row of its own", () => {
  State.incomingShare = { kind: "screen", shots: [shot(0)] };
  view.sync();
  assert.equal(State.incomingShare, null, "taken");
  const chip = rows()[0];
  assert.equal(chip.find(".attach-name")[0].textContent, "Screen 1");
  assert.equal(chip.find("IMG")[0].getAttribute("src"), shot(0).preview);
  assert.equal(sent("screen_capture").length, 0, "Rust took it on the key press");

  State.incomingShare = { kind: "screen", shots: [shot(1)] };
  view.sync();
  // The inbox never overwrites a file: the second shot of the same second is "… (2).png".
  const again = { ...shot(1), path: shot(1).path.replace(".png", " (2).png") };
  State.incomingShare = { kind: "screen", shots: [again] };
  view.sync();
  assert.deepEqual(sent("screen_discard"), [], "none is thrown away");
  assert.deepEqual(names(), ["Screen 1", "Screen 2", "Screen 2 (2)"]);
  assert.equal($(".tool-badge").textContent, "3");
  assert.equal($(".files-count").textContent, "3");

  // Its × takes back that screenshot only, and deletes its file.
  rows()[1].find(".attach-remove")[0].fire("click");
  view.sync();
  assert.deepEqual(names(), ["Screen 1", "Screen 2 (2)"]);
  assert.deepEqual(sent("screen_discard"), [{ paths: [shot(1).path] }]);
  assert.equal($(".tool-badge").textContent, "2");
});

test("two selections from the shortcut both go, the same text only once", async () => {
  const a = { text: "first bit", app: "Word", title: "a.docx" };
  const b = { text: "second bit", app: "Edge", title: "News" };
  for (const selection of [a, b, a]) {
    State.incomingShare = { kind: "selection", selection };
    view.sync();
  }
  assert.deepEqual(names(), ["Text from Word", "Text from Edge"]);
  assert.deepEqual(rows().map((r) => r.find(".attach-detail")[0].textContent), ["first bit", "second bit"]);
  $(".chat-input").value = "compare";
  $(".send-btn").fire("click");
  await flush();
  const turn = sent("chat_send")[0];
  assert.deepEqual(turn.screen.selection, a);
  assert.deepEqual(turn.screen.selections, [b]);
});

test("a second file joins the first and both go with the question", async () => {
  State.droppedFile = { name: "a.pdf", path: "C:\\Lumo\\inbox\\a.pdf" };
  State.moreFiles = [{ name: "b.pdf", path: "C:\\Lumo\\inbox\\b.pdf" }];
  view.sync();
  assert.deepEqual(names(), ["a.pdf", "b.pdf"]);
  assert.equal($(".tool-badge").textContent, "2");
  $(".chat-input").value = "compare";
  $(".send-btn").fire("click");
  await flush();
  const turn = sent("chat_send")[0];
  assert.equal(turn.context.path, "C:\\Lumo\\inbox\\a.pdf");
  assert.deepEqual(turn.screen.files, [{ name: "b.pdf", path: "C:\\Lumo\\inbox\\b.pdf" }]);
  assert.deepEqual(State.moreFiles, [], "sent once");
});

test("selected text from the shortcut goes with the next question once, and × takes it back", async () => {
  const selection = { text: "def f(): pass", app: "Code", title: "main.py" };
  State.incomingShare = { kind: "selection", selection };
  view.sync();
  const chip = rows()[0];
  assert.equal(chip.find(".attach-name")[0].textContent, "Text from Code");
  assert.equal(chip.getAttribute("title"), "def f(): pass");
  chip.find(".attach-remove")[0].fire("click");
  view.sync();
  assert.equal(rows().length, 0);

  State.incomingShare = { kind: "selection", selection };
  view.sync();
  $(".chat-input").value = "what does it do?";
  $(".send-btn").fire("click");
  await flush();
  view.sync();
  const turn = sent("chat_send")[0];
  assert.equal(turn.query, "what does it do?");
  assert.deepEqual(turn.screen, { windows: [], shots: [], selection });
  assert.equal(rows().length, 0, "sent once, then forgotten");
});

test("the page from the shortcut waits as a tab chip and goes with the next question", async () => {
  const tab = read(TABS[0], "README", "page");
  State.incomingShare = { kind: "page", tab };
  view.sync();
  assert.deepEqual(names(), ["Rccrd12/Lumo"]);
  $(".chat-input").value = "summarise it";
  $(".send-btn").fire("click");
  await flush();
  assert.deepEqual(sent("chat_send")[0].screen, { windows: [], shots: [], tabs: [tab] });
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
  const chip = rows()[0];
  assert.equal(chip.find(".attach-name")[0].textContent, "PDFs");
  assert.equal(chip.getAttribute("title"), FOLDER.path);

  chip.find(".attach-remove")[0].fire("click");
  view.sync();
  assert.equal(rows().length, 0);
  $(".chat-input").value = "hi";
  $(".send-btn").fire("click");
  await flush();
  assert.equal(sent("chat_send")[0].screen, undefined, "taken back: nothing goes");
  assert.equal(sent("explorer_attach").length, 0);
});

test("no File Explorer window, or Linux: no entry for it", async () => {
  answers.screen_explorer_peek = null;
  await openMenu();
  assert.equal(explorerEntry(), undefined);
  assert.equal(sent("screen_explorer").length, 0);

  $(".screen-btn").fire("click");
  answers.screen_explorer_peek = () => Promise.reject(new Error("Not available on Linux yet."));
  await openMenu();
  assert.equal(explorerEntry(), undefined);
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
  assert.equal(State.droppedFile.name, "file.pdf", "attached as with the paperclip");
  assert.deepEqual(names(), [], "it went with the question: nothing waits for the next one");
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
  assert.deepEqual(screenItems(p).map((i) => [i.kind, i.label, i.title]), [["folder", "PDFs", FOLDER.path]]);
  assert.ok(sharesFolderByItself(p, true));
  assert.ok(!sharesFolderByItself(p, false), "the setting is off");

  const off = withoutFolder(p);
  assert.deepEqual(screenItems(off), [], "its × leaves it out");
  assert.ok(!sharesFolderByItself(off, true));
  assert.deepEqual(nextScreen(off), { ...emptyScreen(), autoFolder: PEEKED }, "back for the next message");

  const picked = { ...p, folder: FOLDER };
  assert.deepEqual(screenItems(picked).length, 1, "one row, the shared folder's");
  assert.ok(!sharesFolderByItself(picked, true), "the menu already shared one");
  assert.deepEqual(screenItems(withoutFolder(picked)), []);
  assert.deepEqual(screenItems(withoutItem(picked, screenItems(picked)[0])), [], "its × as an item, the same");
});

const folderChips = () => rows().filter((c) => c.getAttribute("title") === FOLDER.path);

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
  assert.equal(folderChips()[0].find(".attach-name")[0].textContent, "PDFs");

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
  folderChips()[0].find(".attach-remove")[0].fire("click");
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
  assert.deepEqual(names(), ["Music"]);
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

// ── What an attachment sends, before it is sent ──────────────────────────────

const { filePreview, formatSize } = await import("../src/core/screen.ts");

test("an attachment's preview is exactly what goes: the picture, text read, the selection, the listing", () => {
  const p = {
    ...emptyScreen(),
    shots: [{ name: "Screen 1", path: "C:\\s.png", preview: "data:image/png;base64,AAA" }],
    selection: { text: "hello world", app: "chrome", title: "News" },
    windows: [SHARED[0], { ...SHARED[1], text: "" }],
    tabs: [read(TABS[0], "README", "page"), { ...read(TABS[1], "La luce", "web"), cut: true }, { ...TABS[1], id: "x", url: "", text: "" }],
    folder: { ...FOLDER, omitted: 3 },
  };
  const items = screenItems(p);
  const preview = (kind, i = 0) => itemPreview(p, items.filter((it) => it.kind === kind)[i]);
  assert.deepEqual(preview("shot"), [{ heading: "Screen 1", detail: "", note: "", text: "", image: "data:image/png;base64,AAA" }]);
  assert.deepEqual(preview("selection").map((b) => [b.heading, b.detail, b.text]), [["Text from chrome", "News", "hello world"]]);
  // Each window and tab shows itself only.
  const [code] = preview("window", 0);
  const [inbox] = preview("window", 1);
  assert.equal(preview("window", 0).length, 1);
  assert.equal(code.detail, "Code · Document on disk: C:\\code\\main.rs");
  assert.equal(code.text, "fn main() {}");
  assert.equal(inbox.note, "No text could be read from this window: only its title goes.");
  const [[page], [web], [unread]] = [0, 1, 2].map((i) => preview("tab", i));
  assert.deepEqual([page.detail, page.note, page.text], ["https://github.com/Rccrd12/Lumo · Edge", "Read in the browser, with your login.", "README"]);
  assert.equal(web.note, "Downloaded from its address, without your login. Cut to fit: it shows more than this.");
  assert.deepEqual([unread.detail, unread.note], ["Edge", "Nothing could be read from this page: only its title goes."]);
  const [folder] = preview("folder");
  assert.equal(folder.text, "Old/\nfile.pdf — 1.5 KB");
  assert.equal(folder.note, "Items not listed: 3");
  // The folder that rides along by itself is listed only when the message goes.
  const auto = itemPreview({ ...emptyScreen(), autoFolder: PEEKED }, { kind: "folder", key: PEEKED.path });
  assert.deepEqual(auto.map((b) => [b.heading, b.note, b.text]), [["PDFs", "Its listing is read when you send.", ""]]);
  assert.deepEqual(itemPreview({ ...emptyScreen(), autoFolder: PEEKED, autoOff: true }, { kind: "folder", key: PEEKED.path }), []);
  assert.deepEqual(itemPreview(withoutItem(p, items[0]), items[0]), [], "taken back: nothing to show");
  assert.deepEqual(filePreview({ name: "a.png", path: "C:\\in\\a.png", size: 2048 }, "data:x")[0], {
    heading: "a.png", detail: "C:\\in\\a.png", note: "2.0 KB", text: "", image: "data:x",
  });
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatSize(300 * 1024 * 1024), "300 MB");
});

test("a click on an attachment shows what it sends; Close keeps it, Remove takes it back, both back to the attachments", async () => {
  await openMenu();
  entries()[1].fire("click"); // Browser tabs
  await flush();
  entries()[2].fire("click"); // Rccrd12/Lumo
  await flush();
  view.sync();
  const chip = () => rows()[0];
  $(".files-btn").fire("click");
  assert.ok($(".chat-body").classList.contains("filing"));
  chip().fire("click");
  assert.ok(!$(".chat-body").classList.contains("filing"), "the preview takes the panel's place");
  assert.ok($(".chat-body").classList.contains("screening"));
  assert.equal($(".picker-title.screen-title")?.textContent ?? view.el.find(".picker-title").map((e) => e.textContent).includes("What goes with your question"), true);
  assert.deepEqual(view.el.find(".screen-preview-text").map((e) => e.textContent), ["README"]);
  const button = (label) => view.el.find(".btn").find((b) => b.textContent === label);
  button("Close").fire("click");
  view.sync();
  assert.ok(!$(".chat-body").classList.contains("screening"));
  assert.ok($(".chat-body").classList.contains("filing"), "back to the attachments");
  assert.equal(rows().length, 1, "kept");

  chip().fire("click");
  button("Remove").fire("click");
  view.sync();
  assert.equal(rows().length, 0, "taken back");
  assert.equal(sent("chat_send").length, 0, "nothing sent");
});

test("an attached picture shows itself in the preview", async () => {
  answers.file_preview = (args) => (args.path.endsWith(".png") ? "data:image/png;base64,QQ==" : null);
  State.droppedFile = { name: "photo.png", path: "C:\\Lumo\\inbox\\photo.png", size: 4096 };
  view.sync();
  assert.equal(rows()[0].find(".attach-detail")[0].textContent, "File · PNG · 4.0 KB");
  await flush();
  view.sync();
  assert.deepEqual(rows()[0].find("IMG").map((i) => i.getAttribute("src")), ["data:image/png;base64,QQ=="], "small on its row");
  rows()[0].fire("click");
  await flush();
  assert.deepEqual(sent("file_preview"), [{ path: "C:\\Lumo\\inbox\\photo.png" }], "asked once for both");
  assert.deepEqual(view.el.find(".screen-preview-img").map((i) => i.getAttribute("src")), ["data:image/png;base64,QQ=="]);
  assert.deepEqual(view.el.find(".screen-preview-detail").map((e) => e.textContent), ["C:\\Lumo\\inbox\\photo.png"]);
  State.droppedFile = null;
});
