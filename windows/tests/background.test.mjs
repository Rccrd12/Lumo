// Sessions another program starts on its own (relay: lumo_background), grouped
// on one pill per program (src/core/background.ts, src/island/hooks.ts): a
// tool asking `claude -p` about many files, eight at a time, must not make
// two sounds and open the island for every one of them.

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { calls, emit } from "./tauri.mjs";
import { liveSessions, registerHookHandlers, resetBackground } from "../src/island/hooks.ts";
import {
  BackgroundRuns, QUIET_MS, STALE_MS, answerLine, progress, answerText, backgroundGroupId, backgroundLine, launcherName,
  parseBackgroundMode, subjectOf,
} from "../src/core/background.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { SPACING_MS, Sound } from "../src/core/sound.ts";

const GROUP = "bg_easy-uninstaller";
const CLAUDE = "integration_claude";

let asked;
const island = {
  alert: (view) => asked.push(`alert:${view}`),
  setView: (view) => asked.push(`setView:${view}`),
  reveal: () => asked.push("reveal"),
  dropPin: () => asked.push("dropPin"),
  quickApproval: () => true,
};
registerHookHandlers(island);

let played;
const hook = (payload) => emit("hook", payload);
const bg = (event, session, extra = {}) =>
  hook({ hook_event_name: event, session_id: session, cwd: `C:\\Temp\\easy-uninstaller-ai\\4242-${session}`, lumo_background: true, lumo_launcher: "Easy Uninstaller", ...extra });
const task = (id = GROUP) => State.tasks.find((t) => t.id === id);
const ms = (n) => mock.timers.tick(n);
const counts = (id = GROUP) => {
  const b = task(id).background;
  return { running: b.running, done: b.done, failed: b.failed };
};

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  asked = [];
  played = [];
  mock.method(Sound, "play", (name) => played.push(name));
  calls.length = 0;
  State.tasks = [];
  State.focusId = null;
  State.mode = "hidden";
  State.view = "overview";
  State.paused = false;
  State.pendingApproval = null;
  State.approvalQueue = [];
  liveSessions.clear();
  resetBackground();
  State.settings = { ...DEFAULT_SETTINGS };
  State.loadIntegrationTasks();
});

afterEach(() => {
  mock.timers.runAll();
  mock.timers.reset();
  mock.restoreAll();
});

// ── The counts ────────────────────────────────────────────────────────────────

test("a group counts its sessions at work, its answers and its failures", () => {
  const runs = new BackgroundRuns();
  assert.equal(runs.event("bg_x", "a", "busy", 0), true, "the first event starts a batch");
  assert.equal(runs.event("bg_x", "b", "busy", 0), false);
  runs.event("bg_x", "a", "done", 1);
  runs.event("bg_x", "b", "failed", 1);
  runs.event("bg_x", "c", "busy", 2);
  assert.deepEqual(runs.counts("bg_x"), { running: 1, done: 1, failed: 1 });
  // A session killed before it could say so is forgotten once silent long enough.
  assert.deepEqual(runs.sweep(2 + STALE_MS - 1), []);
  assert.deepEqual(runs.sweep(2 + STALE_MS), ["bg_x"]);
  assert.equal(runs.counts("bg_x").running, 0);
  const closed = runs.close("bg_x");
  assert.deepEqual([closed.running, closed.done, closed.failed], [0, 1, 1]);
  assert.equal(runs.counts("bg_x"), null);
  assert.equal(runs.event("bg_x", "d", "busy", 3), true, "after the end, a new batch");
});

test("the program's name makes the pill's id, and a nameless one has its own", () => {
  assert.equal(backgroundGroupId("Easy Uninstaller"), GROUP);
  assert.equal(backgroundGroupId(null), "bg_");
  assert.equal(launcherName("  My\ntool "), "My tool");
  assert.equal(launcherName(""), null);
  assert.equal(launcherName(42), null);
  assert.equal(parseBackgroundMode(undefined), "grouped");
  assert.equal(parseBackgroundMode("hidden"), "hidden");
  assert.equal(parseBackgroundMode("single"), "single");
  assert.equal(parseBackgroundMode("nonsense"), "grouped");
  assert.equal(backgroundLine({ running: 8, done: 37, failed: 0 }), "37 done · 8 running");
  assert.equal(backgroundLine({ running: 0, done: 118, failed: 2 }), "118 done · 2 failed");
});

test("what each session is about, and its answer in words", () => {
  assert.equal(subjectOf("Folder: %LOCALAPPDATA%\\Discord\nSize: 1.2 GB\nWhat is it?"), "Discord");
  assert.equal(subjectOf("Is C:\\Users\\me\\notes.txt safe to delete?"), "notes.txt");
  assert.equal(subjectOf("Look at /var/log/nginx and tell me."), "nginx");
  assert.equal(subjectOf("Write me a poem."), "");
  assert.equal(answerLine('```json\n{"safe": true, "what": "Zoom: **cache**"}\n```'), "Zoom: cache");
  assert.equal(answerLine('{"verdict": "keep"}'), "keep");
  assert.equal(answerLine("{not json"), "{not json");
  assert.equal(answerText({ subject: "Zoom", text: "Zoom: cache, safe to delete" }), "cache, safe to delete");
  assert.equal(answerText({ subject: "Zoom", text: "Zoomify is a viewer" }), "Zoomify is a viewer");
  assert.equal(answerText({ subject: "", text: "Done" }), "Done");
});

test("a batch remembers what runs and the last answer", () => {
  bg("UserPromptSubmit", "a", { prompt: "Folder: %APPDATA%\\Zoom" });
  bg("UserPromptSubmit", "b", { prompt: "Folder: %APPDATA%\\Steam" });
  bg("Stop", "a", { last_assistant_message: '{"what": "Zoom: cache, safe to delete"}' });
  bg("UserPromptSubmit", "c", { prompt: "Folder: %APPDATA%\\Adobe" });
  const info = task().background;
  assert.deepEqual(info.subjects, ["Steam", "Adobe"]);
  assert.deepEqual(info.last, { subject: "Zoom", text: "Zoom: cache, safe to delete" });
  assert.equal(info.agent, "Claude Code");
  assert.equal(task().steps.at(-1), "Zoom: cache, safe to delete", "the subject once");
});

test("a program that says how many questions in all shows how far along it is", () => {
  assert.equal(progress({ running: 8, done: 37, failed: 0 }), null, "no total, no share");
  assert.equal(progress({ running: 8, done: 36, failed: 1, total: 74 }), 0.5);
  assert.equal(progress({ running: 0, done: 130, failed: 0, total: 120 }), 1);
  assert.equal(backgroundLine({ running: 8, done: 37, failed: 0, total: 120 }), "37 of 120 done · 8 running");
  bg("UserPromptSubmit", "a", { lumo_batch_total: 120 });
  bg("UserPromptSubmit", "b", { lumo_batch_total: "lots" });
  assert.equal(task().background.total, 120, "a total once said stays");
});

// ── On the island ─────────────────────────────────────────────────────────────

test("eight sessions at once are one pill, one sound, and no alert", () => {
  for (let i = 0; i < 8; i++) {
    bg("SessionStart", `s${i}`);
    bg("UserPromptSubmit", `s${i}`, { prompt: `What is folder ${i}?` });
  }
  assert.equal(State.tasks.filter((t) => t.id.startsWith("bg_")).length, 1);
  assert.equal(task().name, "Easy Uninstaller");
  assert.deepEqual(counts(), { running: 8, done: 0, failed: 0 });
  assert.equal(task().state, "working");
  assert.deepEqual(played, ["work"]);
  assert.deepEqual(asked, ["reveal"], "the closed island comes out once, never opens");
  // Nothing of them on Claude Code's own pill, nor among its sessions.
  assert.equal(task(CLAUDE).state, "idle");
  assert.deepEqual(liveSessions.live(CLAUDE), []);

  for (let i = 0; i < 8; i++) bg("Stop", `s${i}`, { last_assistant_message: `Folder ${i}: **safe** to delete.` });
  assert.deepEqual(counts(), { running: 0, done: 8, failed: 0 });
  assert.equal(task().steps.at(-1), "Folder 7: safe to delete.");
  assert.deepEqual(played, ["work"], "no sound for every answer");
  assert.ok(!asked.some((a) => a.startsWith("alert")));
});

test("the next question of a lane keeps the batch going; the end is said once", () => {
  bg("UserPromptSubmit", "a");
  bg("Stop", "a");
  ms(QUIET_MS - 1);
  bg("UserPromptSubmit", "b");
  ms(QUIET_MS);
  assert.equal(task().state, "working");
  bg("StopFailure", "b", { error: "timeout" });
  ms(QUIET_MS);
  assert.equal(task().state, "finished");
  assert.equal(task().finalLine, "1 done · 1 failed");
  assert.deepEqual(played, ["work", "finish"]);
  ms(5200);
  assert.equal(task(), undefined, "the pill goes");
});

test("a batch whose sessions were all killed ends on its own", () => {
  bg("UserPromptSubmit", "a");
  ms(STALE_MS);
  assert.equal(task().state, "finished");
  assert.deepEqual(counts(), { running: 0, done: 0, failed: 0 });
});

test("a program with no name to give is In background", () => {
  hook({ hook_event_name: "UserPromptSubmit", session_id: "x", lumo_background: true });
  assert.equal(task("bg_").name, "In background");
});

test("hidden, they are not shown at all", () => {
  State.settings.backgroundSessions = "hidden";
  bg("SessionStart", "a");
  bg("Stop", "a");
  assert.equal(task(), undefined);
  assert.deepEqual(played, []);
  assert.deepEqual(asked, []);
});

test("one by one, they are sessions like any other", () => {
  State.settings.backgroundSessions = "single";
  bg("SessionStart", "a");
  assert.equal(task(), undefined);
  assert.equal(task(CLAUDE).name, "4242-a");
});

test("a background session's permission request still comes up as its card", () => {
  bg("PermissionRequest", "a", { request_id: "r1", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.equal(State.pendingApproval?.requestId, "r1");
});

test("an end nobody saw start shows nothing", () => {
  bg("SessionEnd", "a");
  assert.equal(task(), undefined);
});

// ── The sounds ────────────────────────────────────────────────────────────────

test("an agent's sound plays at most once in a moment; a click's always plays", () => {
  mock.restoreAll();
  assert.equal(Sound.spaced("finish", 10_000), true);
  assert.equal(Sound.spaced("finish", 10_000 + SPACING_MS - 1), false);
  assert.equal(Sound.spaced("finish", 10_000 + SPACING_MS), true);
  assert.equal(Sound.spaced("blip", 10_000), true);
  assert.equal(Sound.spaced("blip", 10_000), true);
});
