// The heights a few views take for what they show (src/core/layout.ts): a long
// chat answer, the finished and error cards, the Tools tab's list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAT_AUTO_MAX_H, chatAutoHeight, errorCardHeight, finishedCardHeight, toolsViewHeight } from "../src/core/layout.ts";

test("a short chat keeps the island's own height, a long answer grows it up to the most", () => {
  const short = [{ content: "Hi" }, { content: "Hello! How can I help?" }];
  assert.ok(chatAutoHeight(short, 640) <= 300);
  const long = [{ content: "Compare them" }, { content: "word ".repeat(400) }];
  assert.equal(chatAutoHeight(long, 640), CHAT_AUTO_MAX_H);
  const table = [{ content: "Plans?" }, { content: "| A | B |\n|---|---|\n" + "| x | y |\n".repeat(6) }];
  assert.ok(chatAutoHeight(table, 640) > 300);
  // A wider island fits more on a line: never taller.
  const mid = [{ content: "q" }, { content: "word ".repeat(60) }];
  assert.ok(chatAutoHeight(mid, 1000) <= chatAutoHeight(mid, 640));
});

test("the finished card grows a line at a time, up to three", () => {
  assert.equal(finishedCardHeight("Done.", 640), 160);
  assert.equal(finishedCardHeight("x".repeat(120), 640), 181);
  assert.equal(finishedCardHeight("x".repeat(1000), 640), 202);
});

test("the error card has one more line with the last step under the reason", () => {
  assert.equal(errorCardHeight(false), 160);
  assert.equal(errorCardHeight(true), 178);
});

test("the Tools tab is as tall as its list, up to its full height", () => {
  assert.equal(toolsViewHeight(null), 372);
  assert.equal(toolsViewHeight(3), 326);
  assert.equal(toolsViewHeight(1), 216);
  assert.equal(toolsViewHeight(12), 372);
});
