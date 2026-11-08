// Settings → Updates: the changelog built into the app (src/settings/changelog.ts)
// and the look at GitHub when Lumo opens (src/core/update-check.ts).

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const { changelogList, inlineParts, parseChangelog } = await import("../src/settings/changelog.ts");
const { FOUND_KEY, checkOnOpen, foundFor, rememberFound } = await import("../src/core/update-check.ts");

beforeEach(() => store.clear());

// ── Changelog ─────────────────────────────────────────────────────────────────

const SAMPLE = `# Changelog

## Windows 0.8.1 — October 16, 2026

- **Changelog**: in Settings → Updates
- A \`code\` mark
  carried on

## 0.2.2 — October 8, 2026

The Windows app catches up.

- One
`;

test("one entry per version heading, with its version, date, bullets and paragraphs", () => {
  const entries = parseChangelog(SAMPLE.replace(/\n/g, "\r\n"));
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    title: "Windows 0.8.1 — October 16, 2026",
    version: "0.8.1",
    date: "October 16, 2026",
    lines: [
      { kind: "item", text: "**Changelog**: in Settings → Updates" },
      { kind: "item", text: "A `code` mark carried on" },
    ],
  });
  assert.equal(entries[1].version, "0.2.2");
  assert.deepEqual(entries[1].lines.map((l) => l.kind), ["text", "item"]);
  assert.deepEqual(parseChangelog(""), []);
});

test("bold and code are marked, everything else stays text", () => {
  assert.deepEqual(inlineParts("**Bold**: a `x` and <b>y</b>"), [
    { kind: "strong", text: "Bold" },
    { kind: "text", text: ": a " },
    { kind: "code", text: "x" },
    { kind: "text", text: " and <b>y</b>" },
  ]);
});

test("the newest entry and the installed one start open, the installed one marked", () => {
  const list = changelogList(parseChangelog(SAMPLE), "0.2.2", "Installed");
  const entries = list.children;
  assert.equal(entries.length, 2);
  assert.equal(entries[0].open, true);
  assert.equal(entries[1].open, true);
  assert.ok(!entries[0].textContent.includes("Installed"));
  assert.ok(entries[1].textContent.includes("Installed"));
  const closed = changelogList(parseChangelog(SAMPLE), "0.9.0", "Installed").children;
  assert.equal(closed[1].open, false);
});

test("the repository's CHANGELOG.md reads with a version for every entry and the app's version first", () => {
  const text = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
  const entries = parseChangelog(text);
  assert.ok(entries.length > 10);
  for (const e of entries) {
    assert.ok(e.version, e.title);
    assert.ok(e.lines.length, e.title);
  }
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(entries[0].version, version, "every release adds its CHANGELOG.md section");
});

// ── The check when Lumo opens ─────────────────────────────────────────────────

const info = (newer, current = "0.8.0") => ({
  current, latest: newer ? "0.9.0" : current, newer, notes: "n", assetUrl: newer ? "https://github.com/x" : null,
  currentBeta: false, beta: null,
});

const betaBuild = (newer = true) => ({
  version: "0.8.1-312",
  newer,
  publishedAt: "2026-11-08T11:00:00Z",
  assetUrl: "https://github.com/b",
  included: [{ number: 146, title: "Web search", updatedAt: "2026-11-08T10:00:00Z" }],
  excluded: [{ number: 148, title: "Models", updatedAt: "2026-11-08T09:00:00Z", with: "146" }],
});

function run(over = {}) {
  const said = [];
  const logged = [];
  return {
    said,
    logged,
    enabled: true,
    check: async () => info(true),
    notify: (v, beta) => said.push(beta ? `beta ${v}` : v),
    log: (l) => logged.push(l),
    ...over,
  };
}

test("a newer release is said on the island and waits in Settings → Updates", async () => {
  const r = run();
  await checkOnOpen(r);
  assert.deepEqual(r.said, ["0.9.0"]);
  assert.equal(store.get("lumo.settings.page"), "updates");
  assert.deepEqual(foundFor("0.8.0"), info(true));
  // Once Lumo is updated, what was found before is stale.
  assert.equal(foundFor("0.9.0"), null);
});

test("nothing is said when up to date, off, or GitHub cannot be reached", async () => {
  store.set(FOUND_KEY, JSON.stringify(info(true)));
  const upToDate = run({ check: async () => info(false) });
  await checkOnOpen(upToDate);
  assert.deepEqual(upToDate.said, []);
  assert.equal(foundFor("0.8.0"), null, "an older finding is forgotten");

  let asked = false;
  const off = run({ enabled: false, check: async () => { asked = true; return info(true); } });
  assert.equal(await checkOnOpen(off), null);
  assert.equal(asked, false, "no request at all when turned off");

  const failing = run({ check: async () => { throw new Error("offline"); } });
  assert.equal(await checkOnOpen(failing), null);
  assert.deepEqual(failing.said, []);
  assert.equal(failing.logged.length, 1);
  assert.equal(store.has("lumo.settings.page"), false);
});

test("what is kept for Settings is checked before it is shown", () => {
  rememberFound(info(true));
  assert.ok(foundFor("0.8.0"));
  store.set(FOUND_KEY, "{not json");
  assert.equal(foundFor("0.8.0"), null);
  store.set(FOUND_KEY, JSON.stringify({ ...info(true), newer: false }));
  assert.equal(foundFor("0.8.0"), null);
  rememberFound(null);
  assert.equal(store.has(FOUND_KEY), false);
});

test("with Beta versions on, a newer beta is said and kept when no release is newer", async () => {
  const withBeta = { ...info(false), beta: betaBuild() };
  const r = run({ check: async () => withBeta });
  await checkOnOpen(r);
  assert.deepEqual(r.said, ["beta 0.8.1-312"]);
  assert.equal(store.get("lumo.settings.page"), "updates");
  assert.deepEqual(foundFor("0.8.0"), withBeta);

  // A newer release is said rather than the beta.
  const both = run({ check: async () => ({ ...info(true), beta: betaBuild() }) });
  await checkOnOpen(both);
  assert.deepEqual(both.said, ["0.9.0"]);

  // A beta that is not newer says nothing and is not kept.
  const old = run({ check: async () => ({ ...info(false), beta: betaBuild(false) }) });
  await checkOnOpen(old);
  assert.deepEqual(old.said, []);
  assert.equal(foundFor("0.8.0"), null);
});

test("a kept beta is read back field by field", () => {
  store.set(FOUND_KEY, JSON.stringify({
    ...info(false),
    beta: { ...betaBuild(), included: [{ number: 146, title: "Web search", updatedAt: "x", evil: 1 }, { title: "no number" }], excluded: "nope" },
  }));
  const found = foundFor("0.8.0");
  assert.deepEqual(found.beta.included, [{ number: 146, title: "Web search", updatedAt: "x" }]);
  assert.deepEqual(found.beta.excluded, []);
  store.set(FOUND_KEY, JSON.stringify({ ...info(false), beta: { newer: true } }));
  assert.equal(foundFor("0.8.0"), null, "a beta without its version is no beta");
});

// ── The beta's list in Settings ───────────────────────────────────────────────

const { isBetaVersion, pullRow } = await import("../src/settings/beta.ts");

test("a version with a pre-release part is a beta", () => {
  assert.equal(isBetaVersion("0.18.1-312"), true);
  assert.equal(isBetaVersion("0.18.1"), false);
  assert.equal(isBetaVersion(""), false);
});

test("a pull request left out of the beta says what it conflicts with", () => {
  const pr = { number: 148, title: "<b>Models</b>", updatedAt: "2026-11-08T09:00:00Z" };
  assert.match(pullRow({ ...pr, with: "146" }, true).textContent, /#148.*<b>Models<\/b>.*#146/);
  assert.match(pullRow({ ...pr, with: "main" }, true).textContent, /conflicts with main/);
  assert.match(pullRow(pr, true).textContent, /the other changes/);
  assert.match(pullRow({ ...pr, reason: "checks" }, true).textContent, /checks fail/);
  assert.match(pullRow({ ...pr, reason: "pending" }, true).textContent, /still running/);
  const kept = pullRow(pr, false);
  assert.ok(!kept.textContent.includes("conflicts"));
  assert.equal(kept.className, "pill-row");
});

// ── scripts/beta.mjs, the workflow's steps ────────────────────────────────────

const { BETA_MARK, betaVersion, ciState, cleanTitle, renderNotes } = await import("../scripts/beta.mjs");

test("only a pull request whose Windows CI passed goes in", () => {
  const run = (status, conclusion, workflowName = "Windows CI") => ({ __typename: "CheckRun", name: "test", workflowName, status, conclusion });
  assert.equal(ciState([run("COMPLETED", "SUCCESS")]), "pass");
  assert.equal(ciState([]), "pass", "no Windows CI on it: nothing of the app changed");
  assert.equal(ciState(null), "pass");
  assert.equal(ciState([run("COMPLETED", "SUCCESS", "Windows beta"), run("COMPLETED", "FAILURE", "Other")]), "pass");
  assert.equal(ciState([run("COMPLETED", "FAILURE")]), "fail");
  assert.equal(ciState([run("COMPLETED", "CANCELLED")]), "fail");
  assert.equal(ciState([run("IN_PROGRESS", "")]), "pending");
  assert.equal(ciState([run("QUEUED", ""), run("COMPLETED", "FAILURE")]), "pending");
});

test("the beta's version is the next patch with the run as its pre-release", () => {
  assert.equal(betaVersion("0.18.0", 312), "0.18.1-312");
  assert.equal(betaVersion("0.18.1-40", "7"), "0.18.2-7");
  assert.throws(() => betaVersion("0.18.0", 70000), /range/, "the .msi takes up to 65535");
  assert.throws(() => betaVersion("latest", 1));
});

test("the notes carry the list for Lumo, which no title can break out of", () => {
  const state = {
    main: "abc",
    included: [{ number: 146, title: "Web  search -->\n<script>", updatedAt: "t1", head: "h" }],
    excluded: [
      { number: 148, title: "Models", updatedAt: "t2", head: "h2", reason: "conflict", with: 146 },
      { number: 149, title: "X", updatedAt: "t3", reason: "conflict", with: null },
      { number: 150, title: "Red", updatedAt: "t4", reason: "checks" },
      { number: 151, title: "Busy", updatedAt: "t5", reason: "pending" },
    ],
  };
  const notes = renderNotes(state, "0.18.1-312");
  assert.match(notes, /- #146 Web search -->/);
  assert.match(notes, /#148 Models \(conflicts with #146\)/);
  assert.match(notes, /#149 X \(conflicts with the other changes\)/);
  const start = notes.indexOf(BETA_MARK) + BETA_MARK.length;
  const end = notes.indexOf("-->", start);
  assert.equal(notes.slice(end), "-->", "the comment ends only where it should");
  const list = JSON.parse(notes.slice(start, end));
  assert.equal(list.version, "0.18.1-312");
  assert.deepEqual(list.included, [{ number: 146, title: "Web search --> <script>", updatedAt: "t1" }]);
  assert.equal(list.excluded[0].with, "146");
  assert.equal("with" in list.excluded[1], false);
  assert.match(notes, /#150 Red \(its checks fail\)/);
  assert.match(notes, /#151 Busy \(its checks are still running\)/);
  assert.equal(list.excluded[2].reason, "checks");
  assert.equal(cleanTitle("x".repeat(500)).length, 200);
});
