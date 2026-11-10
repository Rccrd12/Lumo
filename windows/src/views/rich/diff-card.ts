// The diff card: a ```diff block in an answer, the change a model proposes
// to a file, drawn like the diffs Lumo shows for the agents' sessions.
//
//   ```diff src/core/timing.ts:12
//    export function debounce(fn: () => void, ms: number) {
//   -  let t: number;
//   +  let t: number | undefined;
//   ```
//
// What follows "diff" on the fence line is the file's path, and after a colon
// the number of the block's first line; both are optional. A unified diff
// with its ---/+++ and @@ lines works as well: the path then comes from the
// +++ line when the fence names none, and the numbers from each @@ line. The
// card counts the lines added and removed, shows them in one column or before
// and after side by side, and copies the new version (the lines without the
// "-" ones, their signs taken off; a "⋯" line between two runs, and each
// file's name before its lines when the block changes several). Lumo never
// writes the file: whoever works
// on the project applies the change. A block with no "+" or "-" line isn't a
// change, and markdown.ts shows it as the code it is.

import { h } from "../dom";
import { N_, t, tn } from "../../i18n/i18n";
import { keyOf, remember, type RichContext } from "./index";
import "./diff-card.css";

export const DIFF_STRINGS = {
  kind: N_("Code change"),
  unified: N_("Unified"),
  split: N_("Side by side"),
  showUnified: N_("Show the change in one column"),
  showSplit: N_("Show before and after side by side"),
  before: N_("Before"),
  after: N_("After"),
};

/** A line of the change: kept (" "), added ("+") or removed ("-"), with its numbers in the old and new file. */
export interface DiffLine {
  kind: " " | "+" | "-";
  text: string;
  /** Its number in the old file; null for an added line. */
  old: number | null;
  /** Its number in the new file; null for a removed line. */
  new: number | null;
}

/** A run of lines; the card marks the gap between two of them. */
export interface DiffHunk {
  lines: DiffLine[];
  /** The file it is in, on the first run of each file when the block changes several. */
  file?: string;
}

export interface Diff {
  /** The file's path, "" when nothing names it (the first file's when there are several). */
  path: string;
  /** How many files the block changes: more than one only for a patch with several ---/+++ headers. */
  files: number;
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

/** Line numbers past this are not believed: the block is drawn from 1. */
const MAX_LINE = 9_999_999;

const HUNK = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
/** The lines `git diff` writes before a file's changes, which say nothing the card shows. */
const GIT_HEADER = /^(?:diff --git |index [0-9a-f]+\.\.[0-9a-f]+|(?:new|deleted) file mode |old mode |new mode |similarity index |dissimilarity index |rename (?:from|to) |copy (?:from|to) |Binary files )/;

/** "a/src/x.ts" → "src/x.ts", the date `diff -u` adds after a tab taken off; "" for /dev/null. */
function headerPath(rest: string): string {
  const p = rest.split("\t")[0].trim().replace(/^"(.*)"$/, "$1");
  if (!p || p === "/dev/null") return "";
  return p.replace(/^[ab]\//, "");
}

/** The fence's info after "diff": `path`, `path:12`, `:12` or nothing. */
export function parseInfo(info: string): { path: string; line: number | null } {
  const m = /^(.*?)(?::(\d+))?$/.exec(info.trim())!;
  const n = m[2] ? Number(m[2]) : NaN;
  return { path: m[1].trim(), line: n >= 1 && n <= MAX_LINE ? n : null };
}

/**
 * Reads a unified diff, whole or only its "+", "-" and " " lines. A line
 * without a sign is taken as kept (models often drop the space), an empty
 * one as a kept empty line. Null when no line is added or removed.
 */
export function parseDiff(code: string, info = ""): Diff | null {
  const fence = parseInfo(info);
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  let path = fence.path;
  const hunks: DiffHunk[] = [];
  let hunk: DiffHunk | null = null;
  let oldN = fence.line ?? 1;
  let newN = fence.line ?? 1;
  let added = 0;
  let removed = 0;
  // A file named by ---/+++ that has no lines yet: it goes on the next hunk.
  let file: string | undefined;
  const start = () => {
    hunk = { lines: [] };
    if (file) hunk.file = file;
    file = undefined;
    hunks.push(hunk);
    return hunk;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A file's header: "--- old" followed by "+++ new" (a removed line that
    // starts with "-- " is not one, as no "+++" follows it).
    if (line.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const name = headerPath(lines[i + 1].slice(4)) || headerPath(line.slice(4));
      if (!path) path = name;
      file = name;
      hunk = null;
      oldN = newN = 1;
      i++;
      continue;
    }
    if (GIT_HEADER.test(line) || line.startsWith("\\")) continue;
    const at = HUNK.exec(line);
    if (at) {
      const a = Number(at[1]);
      const b = Number(at[2]);
      oldN = a >= 1 && a <= MAX_LINE ? a : 1;
      newN = b >= 1 && b <= MAX_LINE ? b : oldN;
      start();
      continue;
    }
    const cur: DiffHunk = hunk ?? start();
    const sign = line[0];
    if (sign === "+") {
      cur.lines.push({ kind: "+", text: line.slice(1), old: null, new: newN++ });
      added++;
    } else if (sign === "-") {
      cur.lines.push({ kind: "-", text: line.slice(1), old: oldN++, new: null });
      removed++;
    } else {
      cur.lines.push({ kind: " ", text: sign === " " ? line.slice(1) : line, old: oldN++, new: newN++ });
    }
  }
  if (added + removed === 0) return null;
  // Only the files with lines count; a single one is the header's path, not a run's name.
  const kept = hunks.filter((x) => x.lines.length > 0);
  const files = new Set(kept.flatMap((x) => (x.file !== undefined ? [x.file] : []))).size;
  if (files < 2) for (const x of kept) delete x.file;
  return { path, files: Math.max(files, 1), hunks: kept, added, removed };
}

/**
 * The new version: every line but the removed ones, without its sign. Two
 * runs of the same file are parted by a "⋯" line, as the lines between them
 * are not in the block; with several files, each starts with its name the
 * way `head` writes it ("==> src/b.ts <=="), after an empty line.
 */
export function newVersion(diff: Diff): string {
  const out: string[] = [];
  diff.hunks.forEach((x, n) => {
    if (x.file !== undefined) {
      if (n > 0) out.push("");
      out.push(`==> ${x.file} <==`);
    } else if (n > 0) out.push("⋯");
    for (const l of x.lines) if (l.kind !== "-") out.push(l.text);
  });
  return out.join("\n") + "\n";
}

// ── The card ──────────────────────────────────────────────────────────────────

interface View {
  split: boolean;
}

/**
 * The card for a ```diff block, null when it is no change. `info` is what
 * followed "diff" on the fence line.
 */
export function renderDiffCard(code: string, info: string, ctx: RichContext): HTMLElement | null {
  let parsed: Diff | null;
  try {
    parsed = parseDiff(code, info);
  } catch {
    return null;
  }
  if (!parsed) return null;
  const diff = parsed;
  const view = remember<View>(keyOf({ type: "diff", title: info, body: code }, ctx), () => ({ split: false }));

  const unifiedBtn = h("button", { type: "button", text: t(DIFF_STRINGS.unified), title: t(DIFF_STRINGS.showUnified) });
  const splitBtn = h("button", { type: "button", text: t(DIFF_STRINGS.split), title: t(DIFF_STRINGS.showSplit) });
  const head = h(
    "div",
    { class: "rc-head" },
    h("span", { class: "rc-kind", text: t(DIFF_STRINGS.kind) }),
    diff.files > 1 ? filesLabel(diff) : diff.path ? pathLabel(diff.path) : null,
    h("span", { class: "rc-sp" }),
    h("span", { class: "rc-diff-plus", text: `+${diff.added}` }),
    h("span", { class: "rc-diff-minus", text: `−${diff.removed}` }),
    h("span", { class: "rc-diff-view", role: "group" }, unifiedBtn, splitBtn),
    ctx.copyButton(newVersion(diff)),
  );
  // Line numbers of more than three digits need a wider column.
  let widest = 0;
  for (const x of diff.hunks) for (const l of x.lines) widest = Math.max(widest, l.old ?? 0, l.new ?? 0);
  const digits = String(widest).length;
  // Code reads left to right, in Arabic too.
  const body = h("div", { class: "rc-diff-body", dir: "ltr" });
  // A line cut short side by side says all of itself when the pointer rests
  // on it; the title is set then, as only the layout knows what was cut.
  body.addEventListener("pointerover", (e) => {
    const dt = (e.target as Element | null)?.closest?.(".rc-diff-split .dt") as HTMLElement | null;
    if (dt && !dt.title && dt.scrollWidth > dt.clientWidth) dt.title = dt.textContent ?? "";
  });
  const card = h("div", { class: `rc-card rc-diff${digits > 3 ? ` rc-diff-w${Math.min(digits, 7)}` : ""}` }, head, body);
  // Each view is built the first time it is shown, then kept.
  const built: { unified: HTMLElement[] | null; split: HTMLElement[] | null } = { unified: null, split: null };
  const show = () => {
    unifiedBtn.classList.toggle("on", !view.split);
    splitBtn.classList.toggle("on", view.split);
    unifiedBtn.setAttribute("aria-pressed", String(!view.split));
    splitBtn.setAttribute("aria-pressed", String(view.split));
    body.className = view.split ? "rc-diff-body rc-diff-split" : "rc-diff-body";
    body.replaceChildren(...(view.split ? (built.split ??= renderSplit(diff)) : (built.unified ??= renderUnified(diff))));
  };
  unifiedBtn.addEventListener("click", () => {
    view.split = false;
    show();
  });
  splitBtn.addEventListener("click", () => {
    view.split = true;
    show();
  });
  show();
  return card;
}

/** The path, its folder dimmed and its file name bright; a long folder gives way first. */
function pathLabel(path: string): HTMLElement {
  const cut = path.lastIndexOf("/") + 1;
  return h("span", { class: "rc-diff-path", dir: "ltr", title: path }, cut ? h("span", { class: "dir" }, h("bdi", { dir: "ltr", text: path.slice(0, cut) })) : null, h("span", { class: "name", text: path.slice(cut) }));
}

/** A patch of several files: how many, their names in the title; each run of lines names its own. */
function filesLabel(diff: Diff): HTMLElement {
  const names = new Set(diff.hunks.flatMap((x) => (x.file !== undefined ? [x.file] : [])));
  return h("span", { class: "rc-diff-path", title: [...names].join("\n") }, h("span", { class: "name", text: tn("{count} file", "{count} files", diff.files) }));
}

const SIGN = { " ": " ", "+": "+", "-": "−" } as const;
const CLASS = { " ": "rc-dl", "+": "rc-dl add", "-": "rc-dl del" } as const;
const num = (n: number | null) => h("span", { class: "dn", text: n == null ? "" : String(n) });

/** Where one run of lines ends and the next begins, with the next file's name when it changes. */
function gap(file?: string): HTMLElement {
  return h("div", { class: "rc-dl gap" }, h("span", { class: "dt", text: file ?? "⋯" }));
}

/**
 * One column: both numbers, the sign, the line. The rows sit in a block as
 * wide as the longest, so that a long line scrolls sideways whole rather than
 * being cut, and every row's colour reaches the end.
 */
function renderUnified(diff: Diff): HTMLElement[] {
  const rows: HTMLElement[] = [];
  diff.hunks.forEach((x, n) => {
    if (n > 0 || x.file) rows.push(gap(x.file));
    for (const l of x.lines) rows.push(h("div", { class: CLASS[l.kind] }, num(l.old), num(l.new), h("span", { class: "ds", text: SIGN[l.kind] }), h("span", { class: "dt", text: l.text })));
  });
  return [h("div", { class: "rc-diff-rows" }, ...rows)];
}

/**
 * Before on the left, after on the right: kept lines face each other, and
 * each run of removed lines faces the added ones that follow it, the shorter
 * side filled with empty rows so that the two columns stay aligned.
 */
function renderSplit(diff: Diff): HTMLElement[] {
  const left: HTMLElement[] = [h("span", { class: "rc-diff-cap", text: t(DIFF_STRINGS.before) })];
  const right: HTMLElement[] = [h("span", { class: "rc-diff-cap", text: t(DIFF_STRINGS.after) })];
  const half = (l: DiffLine | null, side: "old" | "new") =>
    l ? h("div", { class: CLASS[l.kind] }, num(l[side]), h("span", { class: "dt", text: l.text })) : h("div", { class: "rc-dl void" }, h("span", { class: "dt" }));
  diff.hunks.forEach((x, n) => {
    if (n > 0 || x.file) {
      left.push(gap(x.file));
      right.push(gap(x.file));
    }
    const ls = x.lines;
    let i = 0;
    while (i < ls.length) {
      if (ls[i].kind === " ") {
        left.push(half(ls[i], "old"));
        right.push(half(ls[i], "new"));
        i++;
        continue;
      }
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < ls.length && ls[i].kind === "-") dels.push(ls[i++]);
      while (i < ls.length && ls[i].kind === "+") adds.push(ls[i++]);
      for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
        left.push(half(dels[j] ?? null, "old"));
        right.push(half(adds[j] ?? null, "new"));
      }
    }
  });
  return [h("div", { class: "rc-diff-col" }, ...left), h("div", { class: "rc-diff-col" }, ...right)];
}
