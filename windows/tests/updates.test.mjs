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
});

function run(over = {}) {
  const said = [];
  const logged = [];
  return {
    said,
    logged,
    enabled: true,
    check: async () => info(true),
    notify: (v) => said.push(v),
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
