// The ```diff card (src/views/rich/diff-card.ts): a unified diff read with or
// without its headers, numbered from the @@ lines or the fence, its counts,
// the two views, the new version it copies, and a block that is no change
// left as code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { parseDiff, parseInfo, newVersion, renderDiffCard } = await import("../src/views/rich/diff-card.ts");
const { renderMarkdown } = await import("../src/views/markdown.ts");

const copied = [];
const ctx = {
  markdown: (into, text) => into.append(text),
  inline: (into, text) => into.append(text),
  math: (tex) => document.createTextNode(tex),
  copyButton: (text) => {
    copied.push(text);
    const b = document.createElement("button");
    b.className = "md-copy";
    return b;
  },
};

const DEBOUNCE = [
  " export function debounce(fn: () => void, ms: number) {",
  "-  let t: number;",
  "+  let t: number | undefined;",
  "   return () => {",
  "-    clearTimeout(t);",
  "+    if (t !== undefined) clearTimeout(t);",
  "     t = setTimeout(fn, ms);",
  "   };",
  " }",
].join("\n");

const rows = (diff) => diff.hunks.flatMap((x) => x.lines.map((l) => `${l.old ?? "_"} ${l.new ?? "_"} ${l.kind}${l.text}`));

// ── Reading the block ─────────────────────────────────────────────────────────

test("the fence names the file and the first line", () => {
  assert.deepEqual(parseInfo("src/core/timing.ts:12"), { path: "src/core/timing.ts", line: 12 });
  assert.deepEqual(parseInfo(" src/a.ts "), { path: "src/a.ts", line: null });
  assert.deepEqual(parseInfo(":40"), { path: "", line: 40 });
  assert.deepEqual(parseInfo(""), { path: "", line: null });
  assert.deepEqual(parseInfo("C:/x/a.ts:0"), { path: "C:/x/a.ts", line: null }, "line 0 isn't a line");
});

test("a bare diff is numbered from the fence's line, old and new apart", () => {
  const diff = parseDiff(DEBOUNCE, "src/core/timing.ts:12");
  assert.equal(diff.path, "src/core/timing.ts");
  assert.equal(diff.added, 2);
  assert.equal(diff.removed, 2);
  assert.deepEqual(rows(diff), [
    "12 12  export function debounce(fn: () => void, ms: number) {",
    "13 _ -  let t: number;",
    "_ 13 +  let t: number | undefined;",
    "14 14    return () => {",
    "15 _ -    clearTimeout(t);",
    "_ 15 +    if (t !== undefined) clearTimeout(t);",
    "16 16      t = setTimeout(fn, ms);",
    "17 17    };",
    "18 18  }",
  ]);
});

test("without a line it counts from 1; a line without its space is kept as it is", () => {
  const diff = parseDiff("const a = 1;\n-const b = 2;\n+const b = 3;\n\nend();\n\n");
  assert.equal(diff.path, "");
  assert.deepEqual(rows(diff), ["1 1  const a = 1;", "2 _ -const b = 2;", "_ 2 +const b = 3;", "3 3  ", "4 4  end();"]);
});

test("git's headers: the path from +++, the numbers from each @@, the noise skipped", () => {
  const diff = parseDiff(
    [
      "diff --git a/src/x.ts b/src/x.ts",
      "index 1a2b3c4..5d6e7f8 100644",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -10,3 +10,3 @@ function f() {",
      " a",
      "-b",
      "+B",
      "@@ -40 +40,2 @@",
      " c",
      "+d",
      "\\ No newline at end of file",
    ].join("\r\n"),
  );
  assert.equal(diff.path, "src/x.ts");
  assert.equal(diff.hunks.length, 2);
  assert.deepEqual(rows(diff), ["10 10  a", "11 _ -b", "_ 11 +B", "40 40  c", "_ 41 +d"]);
});

test("the fence's path wins over +++, and a new file takes its name from +++", () => {
  assert.equal(parseDiff("--- a/old.ts\n+++ b/new.ts\n+x", "mine.ts").path, "mine.ts");
  assert.equal(parseDiff("--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+x").path, "new.ts");
  assert.equal(parseDiff("--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x").path, "gone.ts");
});

test("a removed line that starts with -- is a line, not a header", () => {
  const diff = parseDiff("--- a comment in SQL\n+-- another comment");
  assert.deepEqual(rows(diff), ["1 _ --- a comment in SQL", "_ 1 +-- another comment"]);
});

test("a patch of several files names each file's first run, one file names none", () => {
  const diff = parseDiff("--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-e\n+f\n--- a/two.ts\n+++ b/two.ts\n@@ -5 +5 @@\n-c\n+d");
  assert.equal(diff.path, "one.ts");
  assert.equal(diff.files, 2);
  assert.deepEqual(diff.hunks.map((x) => x.file), ["one.ts", undefined, "two.ts"]);
  const one = parseDiff("--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-e\n+f");
  assert.equal(one.files, 1);
  assert.deepEqual(one.hunks.map((x) => x.file), [undefined, undefined]);
});

test("a block with nothing added or removed is no change", () => {
  assert.equal(parseDiff(" a\n b\n"), null);
  assert.equal(parseDiff(""), null);
  assert.equal(parseDiff("--- a/x\n+++ b/x\n@@ -1 +1 @@\n same"), null);
});

test("the new version: no removed line, no signs", () => {
  assert.equal(
    newVersion(parseDiff(DEBOUNCE)),
    "export function debounce(fn: () => void, ms: number) {\n  let t: number | undefined;\n  return () => {\n    if (t !== undefined) clearTimeout(t);\n    t = setTimeout(fn, ms);\n  };\n}\n",
  );
});

test("the new version keeps runs apart: ⋯ between two of a file, the name before each file", () => {
  assert.equal(newVersion(parseDiff("@@ -3 +3 @@\n-x\n+y\n z\n@@ -40 +40 @@\n-p\n+q")), "y\nz\n⋯\nq\n");
  assert.equal(
    newVersion(parseDiff("--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-x\n+y\n z\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -10,2 +10,2 @@\n-p\n+q\n r")),
    "==> src/a.ts <==\ny\nz\n\n==> src/b.ts <==\nq\nr\n",
  );
});

// ── The card ──────────────────────────────────────────────────────────────────

test("the card: path, counts, one column with both numbers, copy gives the new version", () => {
  copied.length = 0;
  const card = renderDiffCard(DEBOUNCE, "src/core/timing.ts:12", { ...ctx, scope: "unified" });
  assert.ok(card.classList.contains("rc-diff"));
  assert.equal(card.querySelector("rc-diff-path").textContent, "src/core/timing.ts");
  assert.equal(card.querySelector("dir").textContent, "src/core/");
  assert.equal(card.querySelector("rc-diff-plus").textContent, "+2");
  assert.equal(card.querySelector("rc-diff-minus").textContent, "−2");
  assert.equal(copied[0], newVersion(parseDiff(DEBOUNCE)));
  const lines = card.find(".rc-dl");
  assert.equal(lines.length, 9);
  assert.equal(card.find(".add").length, 2);
  assert.equal(card.find(".del").length, 2);
  assert.deepEqual(
    lines[1].children.map((c) => c.textContent),
    ["13", "", "−", "  let t: number;"],
  );
  for (const b of card.find("BUTTON").filter((b) => !b.classList.contains("md-copy"))) assert.ok(b.getAttribute("title"), "every button says what it does");
});

test("side by side: before and after aligned, the shorter side padded, kept across redraws", () => {
  const code = " a\n-b\n-c\n+B\n d";
  const scoped = { ...ctx, scope: "split" };
  const card = renderDiffCard(code, "", scoped);
  const [unified, split] = card.querySelector("rc-diff-view").children;
  assert.ok(unified.classList.contains("on"));
  split.fire("click");
  assert.ok(split.classList.contains("on"));
  assert.equal(split.getAttribute("aria-pressed"), "true");
  const body = card.querySelector("rc-diff-body");
  assert.ok(body.classList.contains("rc-diff-split"));
  const [left, right] = body.children;
  const side = (col) => col.find(".rc-dl").map((r) => (r.classList.contains("void") ? "·" : r.children.map((c) => c.textContent).join(" ")));
  assert.deepEqual(side(left), ["1 a", "2 b", "3 c", "4 d"]);
  assert.deepEqual(side(right), ["1 a", "2 B", "·", "3 d"]);

  // The chat draws the answer again: the card comes back side by side.
  const again = renderDiffCard(code, "", scoped);
  assert.ok(again.querySelector("rc-diff-body").classList.contains("rc-diff-split"));
  // The same block in another message starts in one column.
  assert.ok(!renderDiffCard(code, "", { ...ctx, scope: "other" }).querySelector("rc-diff-body").classList.contains("rc-diff-split"));
});

test("several files: the header counts them, each file's lines start with its name", () => {
  const card = renderDiffCard("--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-p\n+q", "", { ...ctx, scope: "files" });
  const label = card.querySelector("rc-diff-path");
  assert.equal(label.textContent, "2 files");
  assert.equal(label.getAttribute("title"), "src/a.ts\nsrc/b.ts");
  assert.deepEqual(card.find(".gap").map((g) => g.textContent), ["src/a.ts", "src/b.ts"]);
});

test("the path: its folder and its name apart, so that a long folder can give way", () => {
  const card = renderDiffCard("-a\n+b", "src/views/rich/diff-card.ts:4", ctx);
  assert.equal(card.querySelector("dir").textContent, "src/views/rich/");
  assert.equal(card.querySelector("name").textContent, "diff-card.ts");
  assert.equal(card.querySelector("rc-diff-path").getAttribute("title"), "src/views/rich/diff-card.ts");
  assert.equal(renderDiffCard("-a\n+b", "Makefile", ctx).querySelector("dir"), null);
});

test("long line numbers widen their column", () => {
  assert.ok(renderDiffCard("-a\n+b", ":1200", ctx).classList.contains("rc-diff-w4"));
  assert.ok(!renderDiffCard("-a\n+b", ":12", ctx).className.includes("rc-diff-w"));
});

test("in an answer, a diff block becomes the card, any other stays code", () => {
  const into = document.createElement("div");
  renderMarkdown(into, "Like this:\n\n```diff src/a.ts:3\n-old\n+new\n```\n");
  assert.ok(into.querySelector("rc-diff"));
  assert.equal(into.querySelector("rc-diff-path").textContent, "src/a.ts");

  const plain = document.createElement("div");
  renderMarkdown(plain, "```diff\n just context\n```\n");
  assert.equal(plain.querySelector("rc-diff"), null);
  assert.match(plain.textContent, /just context/);

  const other = document.createElement("div");
  renderMarkdown(other, "```ts\n-a\n+b\n```\n");
  assert.equal(other.querySelector("rc-diff"), null);
  const differ = document.createElement("div");
  renderMarkdown(differ, "```diffx\n-a\n+b\n```\n");
  assert.equal(differ.querySelector("rc-diff"), null);
});
