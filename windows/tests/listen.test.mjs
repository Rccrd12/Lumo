// Listening to GitHub (src/core/listen.ts): the lines an answer writes for
// Lumo, the message Claude gets back, and what the closed island says.

import { test } from "node:test";
import assert from "node:assert/strict";
import { activeWatches, listenMessage, listeningLine, readPullRequest, takeListens } from "../src/core/listen.ts";

test("a listen line is taken out of the answer, with what to do then", () => {
  const got = takeListens("PR opened.\n[[listen Rccrd12/Lumo#18 ready: merge it with gh pr merge --squash]]\nI'm listening.");
  assert.equal(got.text, "PR opened.\nI'm listening.");
  assert.deepEqual(got.listens, [{ repo: "Rccrd12/Lumo", number: 18, until: "ready", mode: "once", task: "merge it with gh pr merge --squash" }]);
  assert.deepEqual(got.stops, []);
});

test("without a colon it only tells the user; the event is read in any case", () => {
  const got = takeListens("[[listen o/r#3 MERGED]]");
  assert.deepEqual(got.listens, [{ repo: "o/r", number: 3, until: "merged", mode: "once", task: "" }]);
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
  assert.deepEqual(got.listens, [{ repo: "Rccrd12/Lumo", number: 30, until: "checks", mode: "once", task: "" }]);
  assert.equal(got.text, "Sto aspettando che i check finiscano.");
  assert.deepEqual(takeListens("[[listen o/r#3: merge it]]").listens, [{ repo: "o/r", number: 3, until: "checks", mode: "once", task: "merge it" }]);
});

test("backticks, a code block, a sentence, spaces, a link or another word for the event", () => {
  const one = (s) => takeListens(s);
  assert.deepEqual(one("Ok `[[listen o/r#3 ready: merge it]]` fatto").listens, [{ repo: "o/r", number: 3, until: "ready", mode: "once", task: "merge it" }]);
  assert.equal(one("Ok `[[listen o/r#3 ready: merge it]]` fatto").text, "Ok fatto");
  assert.equal(one("```\n[[listen o/r #3 merged]]\n```\nAscolto.").text, "Ascolto.");
  assert.equal(one("[[ Listen  o/r # 3  Merge ]]").listens[0].until, "merged");
  assert.deepEqual(one("[[listen https://github.com/o/r/pull/3/checks: tell me]]").listens, [{ repo: "o/r", number: 3, until: "checks", mode: "once", task: "tell me" }]);
  assert.equal(one("[[listen o/r/pull/3 passed]]").listens[0].until, "green");
  assert.equal(one("[[listen o/r#3 ready merge it]]").listens[0].task, "merge it");
});

test("unlisten stops it, and a line still being written never shows", () => {
  const got = takeListens("Done.\n[[unlisten o/r#7]]");
  assert.deepEqual(got.stops, [{ repo: "o/r", number: 7 }]);
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
    [{ repo: "o/r", number: 3, until: "checks", mode: "every", task: "fix what failed" }]);
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
