// What a local model changed in a copy (workspace.rs `workspace_diff`), and
// how it is best shown under the answer: the new text when the copy is
// rewritten, before and after side by side when a few lines of a long file
// changed, the changed lines with their neighbours otherwise.

export interface CopyDiff {
  original: string;
  /** " line", "-line", "+line", or "…" where unchanged lines are left out. */
  lines: string[];
  /** Each line's number: in the original for "-", in the copy otherwise (0 for "…"). */
  numbers: number[];
  beforeLines: number;
  afterLines: number;
  /** The copy's text and the original's, cut at 20 000 characters. */
  text: string;
  before: string;
}

export type CopyView = "text" | "pairs" | "byLine";

/** A block of changed lines: what was there, what is there now. */
export interface Pair {
  /** The line it is at in the copy. */
  at: number;
  before: string[];
  after: string[];
}

/** A piece of a line, changed or not. */
export interface Segment {
  text: string;
  changed: boolean;
}

export function counts(diff: CopyDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diff.lines) {
    if (l.startsWith("+")) added++;
    else if (l.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** The blocks of changed lines, in order. */
export function pairs(diff: CopyDiff): Pair[] {
  const out: Pair[] = [];
  let open: Pair | null = null;
  diff.lines.forEach((l, i) => {
    const sign = l[0];
    if (sign !== "+" && sign !== "-") {
      open = null;
      return;
    }
    if (!open) {
      // Where it is in the copy: a removed line sits before the copy's next one.
      open = { at: sign === "+" ? diff.numbers[i] : copyLineAfter(diff, i), before: [], after: [] };
      out.push(open);
    }
    if (sign === "+") open.after.push(l.slice(1));
    else open.before.push(l.slice(1));
  });
  return out;
}

function copyLineAfter(diff: CopyDiff, i: number): number {
  for (let k = i; k < diff.lines.length; k++) {
    if (diff.lines[k][0] === "+" || diff.lines[k][0] === " ") return diff.numbers[k];
  }
  return Math.max(1, diff.afterLines);
}

/** Few enough changes for before and after side by side. */
const FEW_LINES = 12;
const FEW_PAIRS = 3;
/** The most lines on either side of a block shown side by side. */
const PAIR_LINES = 3;
/** A file this long is worth showing only where it changed. */
const LONG_FILE = 20;
/** At most this share of the copy left as it was: it is rewritten. */
const REWRITTEN = 0.3;

/** The view that shows best what changed. */
export function copyView(diff: CopyDiff): CopyView {
  const { added, removed } = counts(diff);
  const kept = Math.max(0, diff.afterLines - added);
  if (diff.afterLines > 0 && kept <= REWRITTEN * Math.max(diff.beforeLines, diff.afterLines)) return "text";
  // Lines reworded, not added or taken away: what was there beside what is there now.
  const found = pairs(diff);
  const reworded = found.every((p) => p.before.length > 0 && p.after.length > 0 && p.before.length <= PAIR_LINES && p.after.length <= PAIR_LINES);
  if (diff.beforeLines >= LONG_FILE && added + removed <= FEW_LINES && found.length <= FEW_PAIRS && reworded) return "pairs";
  return "byLine";
}

/** Words, and the spaces between them, each a token of its own. */
function tokens(s: string): string[] {
  return s.split(/(\s+)/).filter((x) => x !== "");
}

/** The most token pairs compared word by word; past it, everything is changed. */
const MAX_CELLS = 40_000;

/** Before and after cut into what stayed and what changed, word by word. */
export function wordMarks(before: string, after: string): { before: Segment[]; after: Segment[] } {
  const a = tokens(before);
  const b = tokens(after);
  if (a.length * b.length > MAX_CELLS) {
    return { before: [{ text: before, changed: true }], after: [{ text: after, changed: true }] };
  }
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const left: Segment[] = [];
  const right: Segment[] = [];
  const push = (into: Segment[], text: string, changed: boolean) => {
    const last = into[into.length - 1];
    if (last && last.changed === changed) last.text += text;
    else into.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push(left, a[i], false);
      push(right, b[j], false);
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) {
      push(left, a[i++], true);
    } else {
      push(right, b[j++], true);
    }
  }
  return { before: left, after: right };
}
