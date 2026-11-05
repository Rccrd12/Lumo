// What a local model changed in a copy (src/core/copy-diff.ts): the view that
// shows it best, the blocks of changed lines and the changed words in them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyView, counts, pairs, wordMarks } from "../src/core/copy-diff.ts";

const diff = (lines, numbers, beforeLines, afterLines) => ({ original: "C:\\f.txt", lines, numbers, beforeLines, afterLines, text: "", before: "" });

test("a file written anew is shown as its new text", () => {
  const d = diff(["-Ciao", "+Uno", "+", "+Due"], [1, 1, 2, 3], 1, 3);
  assert.deepEqual(counts(d), { added: 3, removed: 1 });
  assert.equal(copyView(d), "text");
});

test("a few lines of a long file are shown before and after", () => {
  const d = diff(["…", " a", " b", " c", "-La consegna è il 12 marzo.", "+La consegna è il 19 marzo.", " d", "…"], [0, 39, 40, 41, 42, 42, 43, 0], 184, 184);
  assert.equal(copyView(d), "pairs");
  assert.deepEqual(pairs(d), [{ at: 42, before: ["La consegna è il 12 marzo."], after: ["La consegna è il 19 marzo."] }]);
});

test("anything else is shown line by line", () => {
  const lines = [" a", ...Array.from({ length: 8 }, (_, i) => `+new ${i}`), " b", " c"];
  const d = diff(lines, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 12, 20);
  assert.equal(copyView(d), "byLine");
});

test("lines added to a long file are shown line by line, not side by side", () => {
  const d = diff(["…", " def main():", "-    run(args)", "+    try:", "+        run(args)", "+    except KeyboardInterrupt:", "+        return 1", "     return 0", "…"], [0, 10, 11, 11, 12, 13, 14, 15, 0], 22, 25);
  assert.equal(copyView(d), "byLine");
});

test("a removed block is placed before the copy's next line", () => {
  const d = diff([" a", "-b", " c"], [1, 2, 2], 3, 2);
  assert.deepEqual(pairs(d), [{ at: 2, before: ["b"], after: [] }]);
});

test("only the changed words are lit", () => {
  const { before, after } = wordMarks("il 12 marzo, salvo", "il 19 marzo, salvo");
  assert.deepEqual(before, [{ text: "il ", changed: false }, { text: "12", changed: true }, { text: " marzo, salvo", changed: false }]);
  assert.deepEqual(after, [{ text: "il ", changed: false }, { text: "19", changed: true }, { text: " marzo, salvo", changed: false }]);
});
