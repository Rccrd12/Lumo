// The closed island's content (src/core/compact.ts): what the AI is doing,
// the notes, the email, the timers and the music, and what wins when.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CompactFeed, MAIL_PEEK_MS, NOTICE_MS, activityLine, parseDuration, speakerName, takeTimers, timerLeft,
} from "../src/core/compact.ts";
import { COMPACT_SIZES, islandSize } from "../src/core/layout.ts";

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
  assert.deepEqual(activityLine(chat, live, agent), { text: "Haiku · Reading main.ts", color: "#E07950" });
  assert.deepEqual(activityLine(null, live, agent), { text: "Gemini Live · Speaking", color: "#4285F4" });
  assert.deepEqual(activityLine(null, null, agent), { text: "Claude Code · Editing app.ts", color: "#D97757" });
  // Once the answer streams in, it is writing.
  assert.equal(activityLine({ ...chat, label: null }, null, null).text, "Haiku · Writing…");
  // What a tool does says more than the phase.
  assert.equal(activityLine(null, { ...live, phase: "thinking", doing: "Looking at the screen" }, null).text,
    "Gemini Live · Looking at the screen");
  assert.equal(activityLine(null, null, { ...agent, state: "approval" }).text, "Claude Code · Waiting for your OK");
  assert.equal(activityLine(null, null, { ...agent, state: "thinking", step: null }).text, "Claude Code · Thinking…");
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
  assert.deepEqual(islandSize("compact", "overview", 0, undefined, "top", "one"), COMPACT_SIZES.one);
  assert.ok(COMPACT_SIZES.one.w < COMPACT_SIZES.two.w && COMPACT_SIZES.two.w < COMPACT_SIZES.many.w);
  assert.deepEqual(islandSize("compact", "overview", 0, undefined, "bottom", "mail"), COMPACT_SIZES.mail);
  assert.deepEqual(islandSize("compact", "overview", 0, undefined, "top", null), { w: 288, h: 32 });
  assert.deepEqual(islandSize("compact", "overview", 0, undefined, "left", "mail"), { w: 32, h: 288 });
  // The open island is not touched by it.
  assert.deepEqual(islandSize("expanded", "overview", 0, undefined, "top", "mail"), islandSize("expanded", "overview"));
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
