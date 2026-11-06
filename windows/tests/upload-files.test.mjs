// Several files dropped on the island together: a bar each while they fit,
// "+X" for the rest (src/upload/files.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { FILE_CELLS, dropName, fileCells, fileProgress, uploadingLabel } from "../src/upload/files.ts";

test("one file has no small bars, only the main one", () => {
  assert.deepEqual(fileCells(["a.pdf"]), []);
  assert.equal(uploadingLabel(["a.pdf"]), "Uploading a.pdf");
  assert.equal(dropName(["a.pdf"]), "a.pdf");
});

test("every file gets a bar while they fit", () => {
  const cells = fileCells(["a", "b", "c", "d"]);
  assert.equal(cells.length, FILE_CELLS);
  assert.ok(cells.every((c) => c.kind === "file"));
  assert.equal(uploadingLabel(["a", "b", "c"]), "Uploading 3 files");
  assert.equal(dropName(["a", "b", "c"]), "a +2");
});

test("the files that do not fit become +X in the last cell", () => {
  const cells = fileCells(["a", "b", "c", "d", "e", "f"]);
  assert.equal(cells.length, FILE_CELLS);
  assert.deepEqual(cells.at(-1), { kind: "more", count: 3 });
  assert.deepEqual(cells.slice(0, 3).map((c) => c.name), ["a", "b", "c"]);
});

test("each file starts a little later and all are full with the main bar", () => {
  assert.equal(fileProgress(0.2, 0, 3), 0.2);
  assert.ok(fileProgress(0.5, 2, 3) < fileProgress(0.5, 1, 3));
  assert.equal(fileProgress(0.3, 2, 3), 0);
  for (let i = 0; i < 3; i++) assert.equal(fileProgress(1, i, 3), 1);
});
