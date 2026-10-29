// Listening to GitHub (src/core/listen.ts): the lines an answer writes for
// Lumo, the message Claude gets back, and what the closed island says.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeWatches, amountOf, calendarDue, firedTitle, listenMessage, listeningLine, readPullRequest, takeListens, untilText, watchColor, watchLabel,
} from "../src/core/listen.ts";

test("a listen line is taken out of the answer, with what to do then", () => {
  const got = takeListens("PR opened.\n[[listen Rccrd12/Lumo#18 ready: merge it with gh pr merge --squash]]\nI'm listening.");
  assert.equal(got.text, "PR opened.\nI'm listening.");
  assert.deepEqual(got.listens, [{ source: "github.pr", repo: "Rccrd12/Lumo", number: 18, target: "", text: "", amount: 0, until: "ready", mode: "once", task: "merge it with gh pr merge --squash" }]);
  assert.deepEqual(got.stops, []);
});

test("without a colon it only tells the user; the event is read in any case", () => {
  const got = takeListens("[[listen o/r#3 MERGED]]");
  assert.deepEqual(got.listens, [{ source: "github.pr", repo: "o/r", number: 3, target: "", text: "", amount: 0, until: "merged", mode: "once", task: "" }]);
  assert.equal(got.text, "");
});

test("an event Lumo cannot watch, or no pull request, is taken out and said", () => {
  const got = takeListens("ok [[listen o/r#3 deployed: x]] [[listen o#3 merged]] [[listen o/r merged]]");
  assert.deepEqual(got.listens, []);
  assert.equal(got.text, "ok");
  assert.deepEqual(got.unread, ["[[listen o/r#3 deployed: x]]", "[[listen o#3 merged]]", "[[listen o/r merged]]"]);
});

test("without an event it waits for the checks, as a small model writes it", () => {
  const got = takeListens("[[listen Rccrd12/Lumo#30]]\nSto aspettando che i check finiscano.");
  assert.deepEqual(got.listens, [{ source: "github.pr", repo: "Rccrd12/Lumo", number: 30, target: "", text: "", amount: 0, until: "checks", mode: "once", task: "" }]);
  assert.equal(got.text, "Sto aspettando che i check finiscano.");
  assert.deepEqual(takeListens("[[listen o/r#3: merge it]]").listens, [{ source: "github.pr", repo: "o/r", number: 3, target: "", text: "", amount: 0, until: "checks", mode: "once", task: "merge it" }]);
});

test("backticks, a code block, a sentence, spaces, a link or another word for the event", () => {
  const one = (s) => takeListens(s);
  assert.deepEqual(one("Ok `[[listen o/r#3 ready: merge it]]` fatto").listens, [{ source: "github.pr", repo: "o/r", number: 3, target: "", text: "", amount: 0, until: "ready", mode: "once", task: "merge it" }]);
  assert.equal(one("Ok `[[listen o/r#3 ready: merge it]]` fatto").text, "Ok fatto");
  assert.equal(one("```\n[[listen o/r #3 merged]]\n```\nAscolto.").text, "Ascolto.");
  assert.equal(one("[[ Listen  o/r # 3  Merge ]]").listens[0].until, "merged");
  assert.deepEqual(one("[[listen https://github.com/o/r/pull/3/checks: tell me]]").listens, [{ source: "github.pr", repo: "o/r", number: 3, target: "", text: "", amount: 0, until: "checks", mode: "once", task: "tell me" }]);
  assert.equal(one("[[listen o/r/pull/3 passed]]").listens[0].until, "green");
  assert.equal(one("[[listen o/r#3 ready merge it]]").listens[0].task, "merge it");
});

test("unlisten stops it, and a line still being written never shows", () => {
  const got = takeListens("Done.\n[[unlisten o/r#7]]");
  assert.deepEqual(got.stops, [{ source: "github.pr", repo: "o/r", number: 7, target: "" }]);
  assert.equal(got.text, "Done.");
  assert.equal(takeListens("Listening now.\n[[listen o/r#7 rea").text, "Listening now.");
});

test("Claude is told what happened and what it meant to do", () => {
  const fired = { watch: { id: 1, repo: "o/r", number: 7, until: "ready", mode: "once", task: "merge it", chatId: "c", startedAt: 0 }, met: true, summary: "o/r#7 is ready to merge" };
  assert.equal(listenMessage(fired), "GitHub: o/r#7 is ready to merge\nmerge it");
});

test("the closed island says what it waits for, or how many", () => {
  const w = (number, until) => ({ id: number, repo: "o/r", number, until, task: "", chatId: "c", startedAt: 0 });
  assert.equal(listeningLine([]), null);
  assert.equal(listeningLine([w(7, "merged")]), "Waiting for #7 to be merged");
  assert.equal(listeningLine([w(7, "checks")]), "Waiting for the checks on #7");
  assert.equal(listeningLine([w(7, "merged"), w(8, "ready")]), "Listening to 2 pull requests");
});

test("every listens again for each new commit, only on the checks", () => {
  assert.deepEqual(takeListens("[[listen o/r#3 every checks: fix what failed]]").listens,
    [{ source: "github.pr", repo: "o/r", number: 3, target: "", text: "", amount: 0, until: "checks", mode: "every", task: "fix what failed" }]);
  assert.equal(takeListens("[[listen o/r#3 each green]]").listens[0].mode, "every");
  assert.equal(takeListens("[[listen o/r#3 every: tell me]]").listens[0].until, "checks");
  // What happens once listens once.
  assert.equal(takeListens("[[listen o/r#3 every merged]]").listens[0].mode, "once");
});

test("the Listening panel reads a pull request however it is typed", () => {
  assert.deepEqual(readPullRequest("Rccrd12/Lumo#12"), { repo: "Rccrd12/Lumo", number: 12 });
  assert.deepEqual(readPullRequest(" https://github.com/Rccrd12/Lumo/pull/12/files "), { repo: "Rccrd12/Lumo", number: 12 });
  assert.deepEqual(readPullRequest("o/r/pull/3"), { repo: "o/r", number: 3 });
  assert.equal(readPullRequest("o/r"), null);
  assert.equal(readPullRequest("o/r#3 ready"), null);
});

test("a paused watch is not said on the closed island", () => {
  const w = (number, paused) => ({ id: number, repo: "o/r", number, until: "merged", task: "", chatId: "c", startedAt: 0, paused });
  assert.equal(listeningLine([w(1, true)]), null);
  assert.deepEqual(activeWatches([w(1, true), w(2, false)]).map((x) => x.number), [2]);
  assert.equal(listeningLine([w(1, true), w(2, false)]), "Waiting for #2 to be merged");
});

test("a line can listen on this PC: a folder, a program, a port, a page", () => {
  const got = takeListens('Fatto.\n[[listen fs "C:\\Users\\me\\Downloads" every download: sort it]]\n[[listen process "node.exe" exited]]');
  assert.equal(got.text, "Fatto.");
  assert.deepEqual(got.listens, [
    { source: "fs", repo: "", number: 0, target: "C:\\Users\\me\\Downloads", text: "", amount: 0, until: "download", mode: "every", task: "sort it" },
    { source: "process", repo: "", number: 0, target: "node.exe", text: "", amount: 0, until: "exited", mode: "once", task: "" },
  ]);
  // The text a page shows may hold a colon; the link always does.
  const page = takeListens('[[listen web "https://shop.example/p?a=1" contains "Price: 10": buy it]]');
  assert.deepEqual(page.listens, [{ source: "web", repo: "", number: 0, target: "https://shop.example/p?a=1", text: "Price: 10", amount: 0, until: "contains", mode: "once", task: "buy it" }]);
  assert.deepEqual(takeListens('[[listen program "3000" port_open]]').listens[0].source, "process");
  // Without quotes, a target without spaces (as the prompt on the command line writes it).
  assert.deepEqual(takeListens("[[listen process node.exe exited: tell me]]").listens,
    [{ source: "process", repo: "", number: 0, target: "node.exe", text: "", amount: 0, until: "exited", mode: "once", task: "tell me" }]);
  assert.equal(takeListens("[[listen web https://x.y/a:b every changed]]").listens[0].target, "https://x.y/a:b");
  assert.deepEqual(takeListens("[[unlisten web https://x.y]]").stops, [{ source: "web", repo: "", number: 0, target: "https://x.y" }]);
  // An event its source hasn't, or contains without the text, is said.
  assert.equal(takeListens('[[listen fs "C:\\x" merged]]').unread.length, 1);
  assert.equal(takeListens('[[listen web "https://x.y" contains]]').unread.length, 1);
  assert.deepEqual(takeListens('[[unlisten web "https://x.y"]]').stops, [{ source: "web", repo: "", number: 0, target: "https://x.y" }]);
});

test("a watch on this PC is named by its target, and tells Claude as Lumo", () => {
  const w = (source, until, target, extra = {}) => ({ id: 1, repo: "", number: 0, source, until, target, task: "", chatId: "c", startedAt: 0, ...extra });
  assert.equal(watchLabel(w("fs", "created", "C:\\Users\\me\\Downloads\\")), "Downloads");
  assert.equal(watchLabel(w("fs", "changed", "D:\\")), "D:\\");
  assert.equal(watchLabel(w("process", "port_open", "3000")), ":3000");
  assert.equal(watchLabel(w("web", "up", "https://www.example.com/")), "example.com");
  assert.equal(listeningLine([w("fs", "download", "C:\\Users\\me\\Downloads")]), "Waiting for a download in Downloads");
  assert.equal(listeningLine([w("process", "port_open", "3000")]), "Waiting for port 3000 to open");
  assert.equal(listeningLine([w("web", "contains", "https://x.y", { text: "In stock" })]), "Waiting for x.y to show “In stock”");
  assert.equal(listeningLine([w("fs", "created", "C:\\a"), { id: 2, repo: "o/r", number: 3, until: "merged", task: "", chatId: "c", startedAt: 0 }]), "Listening to 2 things");
  assert.equal(untilText(w("process", "exited", "node.exe")), "It exits");
  assert.equal(untilText({ until: "merged" }), "It is merged");
  const fired = { watch: w("fs", "download", "C:\\Users\\me\\Downloads", { task: "sort it" }), met: true, summary: "Downloaded in Downloads: a.pdf" };
  assert.equal(listenMessage(fired), "Lumo: Downloaded in Downloads: a.pdf\nsort it");
  assert.equal(firedTitle(fired.watch), "Downloads");
});

test("a line can listen to what Lumo hears: an email, an agent, a service, Windows, a webhook, a tool", () => {
  const one = (line) => takeListens(line).listens[0];
  assert.deepEqual(one('[[listen email "Marco" from: draft a reply]]'),
    { source: "email", repo: "", number: 0, target: "Marco", text: "", amount: 0, until: "from", mode: "once", task: "draft a reply" });
  assert.equal(one('[[listen agent "claude" every finished]]').mode, "every");
  const soon = one('[[listen service "calendar" soon 15: remind me]]');
  assert.equal(soon.amount, 15);
  assert.equal(soon.task, "remind me");
  assert.equal(one('[[listen windows pc battery_low 30]]').amount, 30);
  // A number only counts for an event that takes one.
  assert.equal(one("[[listen webhook deploys called 3 times]]").amount, 0);
  assert.equal(one("[[listen webhook deploys called 3 times]]").task, "3 times");
  assert.equal(one('[[listen tool "prices_check" contains "sold out"]]').text, "sold out");
  assert.equal(takeListens('[[listen agent "claude" merged]]').unread.length, 1);
});

test("what Lumo hears is named in words", () => {
  const w = (source, until, target, extra = {}) => ({ id: 1, repo: "", number: 0, source, until, target, task: "", chatId: "c", startedAt: 0, ...extra });
  assert.equal(watchLabel(w("service", "event", "calcom")), "Cal.com");
  assert.equal(watchLabel(w("service", "soon", "calendar")), "Calendar");
  assert.equal(watchLabel(w("agent", "finished", "any")), "Any agent");
  assert.equal(watchLabel(w("agent", "finished", "gemini")), "Gemini CLI");
  assert.equal(watchLabel(w("windows", "usb", "pc")), "Windows");
  assert.equal(watchLabel(w("email", "new", "inbox")), "Email");
  assert.equal(listeningLine([w("agent", "permission", "codex")]), "Waiting for Codex to ask you");
  assert.equal(listeningLine([w("email", "from", "Marco")]), "Waiting for an email from Marco");
  assert.equal(listeningLine([w("windows", "back", "pc")]), "Waiting for you to be back");
  assert.equal(untilText(w("service", "failed", "vercel")), "Something fails");
  assert.equal(watchColor(w("agent", "finished", "any")), "#D97757");
  assert.deepEqual(amountOf("windows", "battery_low"), { default: 20, max: 99 });
  assert.equal(amountOf("email", "new"), null);
});

test("the calendar fires for the next event within its minutes, once each", () => {
  const now = Date.UTC(2026, 9, 29, 10, 0);
  const min = 60_000;
  const w = { id: 1, repo: "", number: 0, source: "service", target: "calendar", until: "soon", task: "", chatId: "c", startedAt: now - min, amount: 10 };
  const events = [
    { title: "Lunch", start: now + 120 * min, allDay: false },
    { title: "Standup", start: now + 8 * min, allDay: false },
    { title: "Holiday", start: now + 5 * min, allDay: true },
    { title: "Old", start: now - 5 * min, allDay: false },
  ];
  assert.equal(calendarDue(w, events, now)?.title, "Standup");
  assert.equal(calendarDue({ ...w, lastSha: String(now + 8 * min) }, events, now), null, "fired for it already");
  assert.equal(calendarDue({ ...w, amount: 5 }, events, now), null);
  assert.equal(calendarDue({ ...w, text: "lunch" , amount: 180 }, events, now)?.title, "Lunch");
  assert.equal(calendarDue({ ...w, paused: true }, events, now), null);
  assert.equal(calendarDue({ ...w, target: "vercel" }, events, now), null);
});
