// The closed island's content (src/core/compact.ts): what the AI is doing,
// the notes, the email, the timers and the music, and what wins when.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CompactFeed, MAIL_OPEN_MAX_H, MAIL_PEEK_MS, NOTICE_MS, activityLine, mailOpenHeight, mailPieces, mailReadable, mailTime, activityLines, parseDuration, speakerName, takeTimers, timerLeft,
} from "../src/core/compact.ts";
import { COMPACT_BOT_X, COMPACT_SIZES, COMPACT_W, COMPUTER_COMPACT_W, NOTCH_H, computerCompact, islandSize } from "../src/core/layout.ts";

const first = (shown) => shown.items[0];
const kinds = (shown) => (shown?.kind === "items" ? shown.items.map((i) => i.kind) : []);
const mail = (id, extra = {}) => ({ id, from: "Ada", address: "ada@example.com", subject: "Lunch", preview: "Hey!", ...extra });

test("nothing going on, nothing said", () => {
  assert.equal(activityLine(null, null, null), null);
  assert.equal(activityLine(null, { phase: "off", doing: null, color: "#4285F4" }, null), null);
  assert.equal(activityLine(null, null, { name: "Claude Code", state: "idle", step: "old", color: "#fff" }), null);
  assert.equal(activityLine(null, null, { name: "Claude Code", state: "finished", step: "done", color: "#fff" }), null);
});

test("the chat comes first, then the call, then the agents", () => {
  const chat = { who: "Haiku", label: "Reading main.ts", color: "#E07950" };
  const live = { phase: "speaking", doing: null, color: "#4285F4" };
  const agent = { name: "Claude Code", state: "working", step: "Editing app.ts", color: "#D97757" };
  assert.deepEqual(activityLine(chat, live, agent), { text: "Haiku · Reading main.ts", color: "#E07950", lead: "Haiku" });
  assert.deepEqual(activityLine(null, live, agent), { text: "Gemini Live · Speaking", color: "#4285F4" });
  assert.deepEqual(activityLine(null, null, agent), { text: "Claude Code · Editing app.ts", color: "#D97757", lead: "Claude Code" });
  // Once the answer streams in, it is writing.
  assert.equal(activityLine({ ...chat, label: null }, null, null).text, "Haiku · Writes…");
  // What a tool does says more than the phase.
  assert.equal(activityLine(null, { ...live, phase: "thinking", doing: "Looking at the screen" }, null).text,
    "Gemini Live · Looking at the screen");
  // A paused call (the shortcut) says its microphone is off.
  assert.equal(activityLine(null, { ...live, phase: "listening", muted: true }, null).text, "Gemini Live · Microphone off");
  assert.equal(activityLine(null, { ...live, phase: "listening", muted: false }, null).text, "Gemini Live · Listening");
  assert.equal(activityLine(null, null, { ...agent, state: "approval" }).text, "Claude Code · Waits for your OK");
  assert.equal(activityLine(null, null, { ...agent, state: "thinking", step: null }).text, "Claude Code · Thinks…");
});

test("who answers is said by the model's family when there is one", () => {
  assert.equal(speakerName("anthropic", "Anthropic", "claude-haiku-4-5"), "Haiku");
  assert.equal(speakerName("claude-code", "Claude Code", "opus"), "Opus");
  assert.equal(speakerName("claude-code", "Claude Code", "default"), "Claude Code");
  assert.equal(speakerName("antigravity-cli", "Antigravity CLI", ""), "Antigravity CLI");
  assert.equal(speakerName("openai", "OpenAI", "gpt-4o"), "gpt-4o");
  assert.equal(speakerName("openrouter", "OpenRouter", "anthropic/claude-sonnet-4.5"), "Sonnet");
  assert.equal(speakerName("openrouter", "OpenRouter", "meta-llama/llama-3.1-8b"), "llama-3.1-8b");
});

test("notes take turns, and the same note twice is once", () => {
  const feed = new CompactFeed();
  feed.notice("Haiku answered", "#E07950", 0);
  feed.notice("Haiku answered", "#E07950", 10);
  feed.notice("Vercel · Deployed", "#7C5CFF", 20);
  assert.equal(first(feed.shown(null, 100)).line.text, "Haiku answered");
  assert.equal(first(feed.shown(null, NOTICE_MS + 50)).line.text, "Vercel · Deployed");
  assert.equal(feed.shown(null, NOTICE_MS * 3), null);
  // A note goes before what the AI is doing, which shows once it has gone.
  feed.notice("Done", "#fff", 0);
  const activity = { text: "Haiku · Thinking…", color: "#E07950" };
  assert.equal(first(feed.shown(activity, 10)).notice, true);
  assert.deepEqual(feed.shown(activity, NOTICE_MS + 10), { kind: "items", items: [{ kind: "line", line: activity, notice: false }] });
});

test("an email shows once, stays while the mouse is on it, and goes", () => {
  const feed = new CompactFeed();
  assert.equal(feed.showMail(mail("imap.gmail.com:4"), 0), true);
  assert.equal(feed.showMail(mail("imap.gmail.com:4"), 10), false);
  feed.notice("Haiku answered", "#fff", 0);
  assert.equal(feed.shown(null, 100).kind, "mail");
  feed.holdMail(Infinity);
  assert.equal(feed.shown(null, MAIL_PEEK_MS * 10).kind, "mail");
  feed.holdMail(MAIL_PEEK_MS * 10 + 3000);
  assert.equal(feed.shown(null, MAIL_PEEK_MS * 10 + 3001), null);
  feed.showMail(mail("imap.gmail.com:5"), 0);
  feed.dismissMail();
  assert.equal(feed.currentMail, null);
});

test("the soonest timer counts down, rings once, and the music waits its turn", () => {
  const feed = new CompactFeed();
  feed.media = { title: "Song", artist: "Band", app: "Spotify", playing: true };
  assert.deepEqual(kinds(feed.shown(null, 0)), ["media"]);
  assert.equal(feed.shown(null, 0, { notes: true, media: false }), null);
  const long = feed.startTimer(600_000, "pasta", 0);
  const short = feed.startTimer(60_000, "", 0);
  // Side by side: the two timers, soonest first, then the music.
  assert.deepEqual(kinds(feed.shown(null, 0)), ["timer", "timer", "media"]);
  assert.equal(first(feed.shown(null, 0)).timer.id, short.id);
  assert.equal(feed.nextChange(0), 60_000);
  assert.deepEqual(feed.takeRung(59_999), []);
  assert.deepEqual(feed.takeRung(60_000).map((x) => x.id), [short.id]);
  assert.deepEqual(feed.takeRung(60_001), []);
  assert.equal(first(feed.shown(null, 60_001)).timer.id, long.id);
  assert.equal(feed.cancelTimer(long.id), true);
  assert.deepEqual(kinds(feed.shown(null, 60_001)), ["media"]);
  // What the AI does comes first, with the rest beside it.
  const doing = { text: "Haiku · Thinking…", color: "#fff" };
  assert.deepEqual(kinds(feed.shown(doing, 60_001)), ["line", "media"]);
  // Lengths are kept sensible.
  assert.equal(feed.startTimer(10, "", 0).total, 5_000);
});

test("timers read what people say", () => {
  assert.equal(parseDuration("10m"), 600_000);
  assert.equal(parseDuration("10"), 600_000);
  assert.equal(parseDuration("90s"), 90_000);
  assert.equal(parseDuration("1h30"), 5_400_000);
  assert.equal(parseDuration("1h 30m"), 5_400_000);
  assert.equal(parseDuration("2 min"), 120_000);
  assert.equal(parseDuration("0:45"), 45_000);
  assert.equal(parseDuration("1:00:05"), 3_605_000);
  assert.equal(parseDuration("soon"), null);
  assert.equal(parseDuration(""), null);
  assert.equal(timerLeft(65_000), "1:05");
  assert.equal(timerLeft(3_605_000), "1:00:05");
  assert.equal(timerLeft(-5), "0:00");
});

test("the closed island grows for what it says, only on the top and bottom", () => {
  // As wide as what it says, never under the plain closed island.
  assert.deepEqual(islandSize("compact", "overview", 0, undefined, "top", { w: 340, h: 32 }), { w: 340, h: 32 });
  assert.deepEqual(islandSize("compact", "overview", 0, undefined, "top", { w: 120, h: 32 }), { w: 288, h: 32 });
  assert.ok(COMPACT_SIZES.one.w < COMPACT_SIZES.two.w && COMPACT_SIZES.two.w < COMPACT_SIZES.many.w);
  assert.deepEqual(islandSize("compact", "overview", 0, undefined, "bottom", COMPACT_SIZES.mail), COMPACT_SIZES.mail);
  assert.deepEqual(islandSize("compact", "overview", 0, undefined, "top", null), { w: 288, h: 32 });
  assert.deepEqual(islandSize("compact", "overview", 0, undefined, "left", COMPACT_SIZES.mail), { w: 32, h: 288 });
  // The open island is not touched by it.
  assert.deepEqual(islandSize("expanded", "overview", 0, undefined, "top", COMPACT_SIZES.mail), islandSize("expanded", "overview"));
});

test("a chat answer sets timers with a line Lumo hides", () => {
  assert.deepEqual(takeTimers("Done, 10 minutes for the pasta!\n[[timer 10m: pasta]]"), {
    text: "Done, 10 minutes for the pasta!",
    timers: [{ ms: 600_000, label: "pasta" }],
  });
  assert.deepEqual(takeTimers("[[timer 1h30m]]\nSet.").timers, [{ ms: 5_400_000, label: "" }]);
  assert.equal(takeTimers("[[timer soon: x]] ok").timers.length, 0);
  // Still being written: hidden, not started.
  assert.deepEqual(takeTimers("Setting it\n[[tim"), { text: "Setting it", timers: [] });
  assert.equal(takeTimers("No timer [here] at all").text, "No timer [here] at all");
});

test("every agent at work has its line, the chat first, then the services, two at most", () => {
  const agent = (name, state, step = null) => ({ name, state, step, color: "#fff" });
  const chat = { who: "Haiku", label: "Reading main.ts", color: "#E07950" };
  const ci = { text: "GitHub · CI running on b#1", color: "#F4505E" };
  const texts = (lines) => lines.map((l) => l.text);
  assert.deepEqual(activityLines(null, null, [], []), []);
  assert.deepEqual(texts(activityLines(null, null, [agent("VS Code", "working", "Editing app.ts"), agent("Codex", "idle")], [ci])),
    ["VS Code · Editing app.ts", "GitHub · CI running on b#1"]);
  assert.deepEqual(texts(activityLines(chat, null, [agent("VS Code", "approval"), agent("Codex", "thinking")], [ci])),
    ["Haiku · Reading main.ts", "VS Code · Waits for your OK"]);
  assert.deepEqual(texts(activityLines(null, null, [], [ci])), ["GitHub · CI running on b#1"]);
});

test("a note stands in for the first line only; the others stay", () => {
  const feed = new CompactFeed();
  const a = { text: "VS Code · Working…", color: "#fff" };
  const b = { text: "Codex · Thinking…", color: "#2DD4BF" };
  assert.deepEqual(feed.shown([a, b], 0).items.map((i) => i.line.text), [a.text, b.text]);
  feed.notice("Cursor finished", "#ccc", 0);
  const items = feed.shown([a, b], 10).items;
  assert.deepEqual(items.map((i) => [i.line.text, i.notice]), [["Cursor finished", true], [b.text, false]]);
  assert.equal(feed.shown([a, b], 0, { notes: false, media: true }), null, "no activity when notes are off");
});

test("while Claude uses the computer the closed island is a short pill with Lumo in its middle", () => {
  const top = computerCompact("top");
  assert.ok(top.w < COMPACT_W, `${top.w} is narrower than the usual closed island`);
  assert.equal(top.h, NOTCH_H);
  assert.equal(top.bot.cx, top.w / 2, "Lumo in the middle");
  assert.equal(top.bot.cy, NOTCH_H / 2);
  const side = computerCompact("left");
  assert.deepEqual([side.w, side.h], [top.h, top.w], "upright on a side, turned");
  assert.deepEqual(computerCompact("top", 0), top, "nothing to say: the short pill");
});

test("with a plan the closed island says the step beside Lumo, as wide as that and no wider than two activities", () => {
  const plan = computerCompact("top", 312);
  assert.equal(plan.w, 312, "as wide as what it says");
  assert.equal(plan.h, NOTCH_H);
  assert.equal(plan.bot.cx, COMPACT_BOT_X + 4, "Lumo at its left end, as on any closed island that says something");
  assert.equal(computerCompact("bottom", 312).w, 312, "the same on the bottom edge");
  assert.equal(computerCompact("top", 2000).w, COMPACT_SIZES.two.w, "a long step is cut, not the island widened");
  assert.equal(computerCompact("top", 60).w, COMPUTER_COMPACT_W, "never narrower than the short pill");
  const side = computerCompact("right", 312);
  assert.deepEqual([side.w, side.h], [NOTCH_H, COMPUTER_COMPACT_W], "upright on a side: no room for words, the short pill");
  assert.equal(side.bot.cx, COMPUTER_COMPACT_W / 2);
});

test("an agent's step is said in fewer words: a file's name stays, a command or a search goes", async () => {
  const { shortStep } = await import("../src/core/compact.ts");
  assert.equal(shortStep("Runs · npm run build && npm test -- --watch"), "Runs a command");
  assert.equal(shortStep("Searches · listeningLine("), "Searches the files");
  assert.equal(shortStep("Edits · island.ts"), "Edits island.ts");
  assert.equal(shortStep("Reads · main.ts"), "Reads main.ts");
  assert.equal(shortStep("Searches the web · tauri zoom"), "Searches the web");
  assert.equal(shortStep("mcp__github__create_pr · Lumo"), "mcp__github__create_pr");
  assert.equal(shortStep("Tasks"), "Tasks");
  assert.equal(activityLine(null, null, { name: "Claude Code", state: "working", step: "Runs · npm test", color: "#fff" }).text,
    "Claude Code · Runs a command");
});

test("a timer started again after a pause is woken for in its turn", () => {
  const feed = new CompactFeed();
  const now = Date.now();
  const min = 60_000;
  const a = feed.startTimer(10 * min, "a", now);
  const b = feed.startTimer(30 * min, "b", now);
  // Paused, the soonest running one is the next change.
  feed.toggleTimerPause(a.id, now);
  assert.equal(feed.nextChange(now), b.endsAt);
  // Started again 25 minutes on, it rings after b: b is the next change, and shown first.
  feed.toggleTimerPause(a.id, now + 25 * min);
  assert.equal(feed.nextChange(now + 25 * min), now + 30 * min);
  const shownTimers = feed.shown(null, now + 25 * min).items.filter((i) => i.kind === "timer").map((i) => i.timer.label);
  assert.deepEqual(shownTimers, ["b", "a"]);
});

// ── An email on the closed island, read there (island/compact.ts mailCard) ────

test("an email's text keeps its lines, without runs of blank ones", () => {
  assert.equal(mailReadable({ body: "Ciao,\r\n\r\n\r\n\r\nA domani   \n", preview: "x" }), "Ciao,\n\nA domani");
  assert.equal(mailReadable({ body: "  ", preview: "Only the preview" }), "Only the preview", "no text: the preview");
  assert.equal(mailReadable({ preview: "Hey!" }), "Hey!");
});

test("an address on the web in the text is a link with its site's name", () => {
  assert.deepEqual(mailPieces("View results: https://github.com/a/b/runs/1.\nBye"), [
    { kind: "text", text: "View results: " },
    { kind: "link", url: "https://github.com/a/b/runs/1", label: "github.com" },
    { kind: "text", text: ".\nBye" },
  ]);
  assert.deepEqual(mailPieces("Manage <https://www.example.com/settings>"), [
    { kind: "text", text: "Manage " },
    { kind: "link", url: "https://www.example.com/settings", label: "example.com" },
  ]);
  assert.deepEqual(mailPieces("No link, ftp://x.it or javascript:alert(1)"), [{ kind: "text", text: "No link, ftp://x.it or javascript:alert(1)" }]);
  // A ")" the address opened is its own; one the sentence opened is not.
  assert.deepEqual(mailPieces("Read https://it.wikipedia.org/wiki/Roma_(città)."), [
    { kind: "text", text: "Read " },
    { kind: "link", url: "https://it.wikipedia.org/wiki/Roma_(città)", label: "it.wikipedia.org" },
    { kind: "text", text: "." },
  ]);
  assert.deepEqual(mailPieces("(see https://example.com/a)"), [
    { kind: "text", text: "(see " },
    { kind: "link", url: "https://example.com/a", label: "example.com" },
    { kind: "text", text: ")" },
  ]);
  assert.deepEqual(mailPieces("(https://en.wikipedia.org/wiki/Pi_(letter))!"), [
    { kind: "text", text: "(" },
    { kind: "link", url: "https://en.wikipedia.org/wiki/Pi_(letter)", label: "en.wikipedia.org" },
    { kind: "text", text: ")!" },
  ]);
});

test("an email's time: the hour today, the day before, nothing when unreadable", () => {
  const now = new Date(2026, 10, 11, 19, 0);
  assert.match(mailTime(new Date(2026, 10, 11, 18, 18).toString(), now, "it"), /^18[:.]18$/);
  assert.match(mailTime(new Date(2026, 10, 9, 10, 0).toString(), now, "it"), /^9 nov/);
  assert.equal(mailTime("", now, "it"), "");
  assert.equal(mailTime("not a date", now, "it"), "");
});

test("an open email is as tall as its text, between its height at rest and the most", () => {
  assert.equal(mailOpenHeight(90, 120), 120);
  assert.equal(mailOpenHeight(250.4, 120), 250);
  assert.equal(mailOpenHeight(2000, 120), MAIL_OPEN_MAX_H);
});
