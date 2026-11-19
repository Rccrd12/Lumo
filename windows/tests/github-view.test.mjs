// The GitHub card's activity grid (src/views/github.ts) on a fake DOM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { githubDetail, showGitHubSection } = await import("../src/views/github.ts");

const day = (date, count, level, weekday) => ({ date, count, level, weekday });
const activity = { total: 42, fetchedAt: 0, weeks: [[day("2026-01-12", 5, 2, 0), day("2026-01-13", 10, 3, 1)]] };

test("a day clicked in the grid stays in the header; hovering another shows it meanwhile", () => {
  showGitHubSection("activity");
  const card = githubDetail({ login: "me", prs: [], repos: [] }, null, activity, () => {});
  const header = card.find("BUTTON").find((b) => b.className.includes("gh-head-right"));
  const [monday, tuesday] = card.find("I").filter((c) => c.className === "gh-cell");
  assert.equal(header.textContent, "42 past year");

  monday.fire("mouseenter");
  monday.fire("click");
  assert.match(header.textContent, /Jan 12/, "the click keeps the day the mouse is on");
  monday.fire("mouseleave");
  assert.match(header.textContent, /Jan 12/, "pinned");

  tuesday.fire("mouseenter");
  assert.match(header.textContent, /Jan 13/);
  tuesday.fire("mouseleave");
  assert.match(header.textContent, /Jan 12/, "back to the pinned day");

  monday.fire("mouseenter");
  monday.fire("click");
  monday.fire("mouseleave");
  assert.equal(header.textContent, "42 past year", "a second click lets it go");
});
