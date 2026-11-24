// The files of an answer (src/core/file-names.ts, src/views/markdown.ts,
// concepts/file-cliccabili-in-chat): the names in its text worth asking Rust
// about, its links to files, and the files it made or changed, kept with it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { namesIn, wholeName, withReplyFile, readReplyFiles, replyCounts, mainFolder, MAX_CARDS } = await import("../src/core/file-names.ts");
const { parseInline, localTarget } = await import("../src/views/markdown.ts");
const { toSavedTurn, fromSavedTurn } = await import("../src/core/chats.ts");

const names = (text) => namesIn(text).map((n) => n.name);

test("a file's name, a short path or a drive's path in the text is worth asking about", () => {
  assert.deepEqual(names("Puoi aprire la nuova immagine qui: pasted-2026-11-24-152045-line.png"), ["pasted-2026-11-24-152045-line.png"]);
  assert.deepEqual(names("vedi C:\\Users\\me\\a.png."), ["C:\\Users\\me\\a.png"], "the full stop is the sentence's");
  assert.deepEqual(names("in figure\\dipolo.png e (Fisica2.tex), poi"), ["figure\\dipolo.png", "Fisica2.tex"]);
  // Where it is in the text, for the button that takes its place.
  const [at] = namesIn("qui: a.pdf!");
  assert.deepEqual([at.start, at.end], [5, 10]);
});

test("numbers, web addresses and emails are not files", () => {
  assert.deepEqual(names("version 1.5, v2.0 and 3.14"), []);
  assert.deepEqual(names("https://example.com/a.png and www.example.com"), []);
  assert.deepEqual(names("write to me@mail.com"), []);
});

test("inline code is a file only when all of it is one name", () => {
  assert.equal(wholeName("report.pdf"), "report.pdf");
  assert.equal(wholeName(" C:\\dev\\lumo\\main.rs "), "C:\\dev\\lumo\\main.rs");
  assert.equal(wholeName("npm test"), null);
  assert.equal(wholeName("open report.pdf"), null);
});

test("a link to a path is a file link; one to another computer or a scheme is not", () => {
  assert.equal(localTarget("C:\\Users\\me\\My Documents\\a.pdf"), "C:\\Users\\me\\My Documents\\a.pdf");
  assert.equal(localTarget("file:///C:/Users/me/My%20Documents/a.pdf"), "C:/Users/me/My Documents/a.pdf");
  assert.equal(localTarget("figure/dipolo.png"), "figure/dipolo.png");
  for (const no of ["\\\\server\\share\\a.pdf", "//server/a.pdf", "javascript:alert(1)", "mailto:me@x.com", "#top", "/etc/passwd", " "]) {
    assert.equal(localTarget(no), null, no);
  }
});

test("a link's path may hold spaces; a web link stays a web link", () => {
  const [link] = parseInline("[Le mie dispense](C:\\Users\\me\\Le mie dispense)").filter((n) => n.kind === "link");
  assert.equal(link.url, null);
  assert.equal(link.file, "C:\\Users\\me\\Le mie dispense");
  const [web] = parseInline("[page](https://example.com/a)").filter((n) => n.kind === "link");
  assert.equal(web.url, "https://example.com/a");
  assert.equal(web.file, undefined);
});

test("an answer's files: once each, a file it made staying made", () => {
  let files = withReplyFile([], "C:\\a\\x.tex", "edited");
  files = withReplyFile(files, "c:/a/X.tex", "edited");
  files = withReplyFile(files, "C:\\a\\y.png", "created");
  files = withReplyFile(files, "C:\\a\\y.png", "edited");
  assert.deepEqual(files, [{ path: "C:\\a\\x.tex", kind: "edited" }, { path: "C:\\a\\y.png", kind: "created" }]);
});

test("many files are summed up by kind and folder; the folder most are in opens", () => {
  const files = [
    { path: "C:\\d\\a.tex", kind: "edited" }, { path: "C:\\d\\b.tex", kind: "edited" },
    { path: "C:\\d\\fig\\c.png", kind: "created" }, { path: "C:\\d\\e.pdf", kind: "created" },
  ];
  assert.ok(files.length > MAX_CARDS, "more than the cards");
  assert.deepEqual(replyCounts(files), { created: 2, edited: 2, folders: 2 });
  assert.equal(mainFolder(files), "C:\\d");
  assert.equal(mainFolder([]), null);
});

test("an answer's files are saved with it and checked when they come back", () => {
  const files = [{ path: "C:\\a\\x.png", kind: "created" }];
  const saved = toSavedTurn({ role: "assistant", content: "ok", files });
  assert.deepEqual(saved.files, files);
  assert.deepEqual(fromSavedTurn(saved).files, files);
  assert.equal(toSavedTurn({ role: "user", content: "q", files }).files, undefined, "a question has none");
  assert.deepEqual(readReplyFiles([{ path: "C:\\a", kind: "read" }, { path: 3 }, null, { path: "C:\\b.txt", kind: "edited" }]), [{ path: "C:\\b.txt", kind: "edited" }]);
  assert.equal(readReplyFiles("nope"), undefined);
});
