// An email the AI wants to send, changed on its card before Send
// (src/core/mail-edit.ts): what counts as a change, what keeps it from going,
// and what Send carries back to mail.rs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAIL_LIMITS, draftChanged, draftOf, draftProblems, parseAddresses, revisionOf, validAddress, withAddresses, withFiles,
} from "../src/core/mail-edit.ts";
import { mailCardMs, outgoingEmail } from "../src/island/hooks.ts";

const email = {
  from: "me@example.com", to: ["ada@example.com"], cc: [], subject: "Lunch", body: "See you at 1.",
  attachments: [{ name: "menu.pdf", size: 1200, path: "C:\\menu.pdf" }, { name: "map.png", size: 800, path: "" }],
};

test("the addresses Lumo sends to are those smtp.rs takes", () => {
  for (const ok of ["ada@example.com", "a.b+c@mail.example.it", "x@y.co"]) assert.ok(validAddress(ok), ok);
  for (const bad of ["ada", "ada@example", "@example.com", "ada@.com", "ada@example.", "a@b@c.com", "a b@c.com", "<a@b.com>", "a;b@c.com", "àda@example.com"]) {
    assert.ok(!validAddress(bad), bad);
  }
});

test("addresses typed or pasted come apart at commas, semicolons and spaces, a name's address alone", () => {
  assert.deepEqual(parseAddresses("ada@example.com, grace@example.com;bob@example.com  eve@example.com"),
    ["ada@example.com", "grace@example.com", "bob@example.com", "eve@example.com"]);
  assert.deepEqual(parseAddresses('Ada Lovelace <ada@example.com>, "Grace" <grace@example.com>, bob@example.com'),
    ["ada@example.com", "grace@example.com", "bob@example.com"]);
  assert.deepEqual(parseAddresses("  "), []);
  // Something that is no address is kept, to be shown in red, never dropped silently.
  assert.deepEqual(parseAddresses("grace.hopper@example"), ["grace.hopper@example"]);
});

test("an address is there once, whatever its case", () => {
  assert.deepEqual(withAddresses(["ada@example.com"], ["ADA@example.com", "bob@example.com", "bob@example.com"]), ["ada@example.com", "bob@example.com"]);
});

test("left as it came, the email is unchanged and Send is the plain Allow", () => {
  const d = draftOf(email);
  assert.equal(draftChanged(email, d), false);
  assert.deepEqual(draftProblems(d), []);
  assert.equal(draftChanged(email, { ...d, to: ["ADA@example.com"] }), false, "only the case of an address");
});

test("any field changed counts", () => {
  const d = draftOf(email);
  assert.ok(draftChanged(email, { ...d, to: [...d.to, "grace@example.com"] }));
  assert.ok(draftChanged(email, { ...d, cc: ["bob@example.com"] }));
  assert.ok(draftChanged(email, { ...d, subject: "Lunch tomorrow" }));
  assert.ok(draftChanged(email, { ...d, body: "See you at 2." }));
  assert.ok(draftChanged(email, { ...d, from: "work@example.com" }));
  assert.ok(draftChanged(email, { ...d, files: d.files.slice(1) }), "a file removed");
  assert.ok(draftChanged(email, withFiles(d, [{ name: "a.txt", size: 3, path: "C:\\a.txt" }])), "a file added");
});

test("Send carries the AI's files kept by their place, the ones added by path", () => {
  let d = draftOf(email);
  d = { ...d, files: d.files.filter((f) => f.name !== "menu.pdf") };
  d = withFiles(d, [{ name: "notes.txt", size: 5, path: "C:\\notes.txt" }, { name: "notes.txt", size: 5, path: "c:\\NOTES.txt" }]);
  d = { ...d, to: ["ada@example.com", "grace@example.com"], subject: "Lunch tomorrow" };
  assert.deepEqual(revisionOf(d), {
    from: "me@example.com", to: ["ada@example.com", "grace@example.com"], cc: [], subject: "Lunch tomorrow", body: "See you at 1.",
    keep: [1], add: ["C:\\notes.txt"],
  });
});

test("what keeps the email from going, first the address to fix", () => {
  const d = draftOf(email);
  assert.deepEqual(draftProblems({ ...d, to: ["ada@example.com", "grace@example"] }), [{ kind: "address", address: "grace@example" }]);
  assert.deepEqual(draftProblems({ ...d, to: [] }), [{ kind: "nobody" }]);
  assert.deepEqual(draftProblems({ ...d, body: " \n " }), [{ kind: "noText" }]);
  assert.deepEqual(draftProblems({ ...d, subject: "x".repeat(301) }), [{ kind: "tooLong" }]);
  const limits = { ...DEFAULT_MAIL_LIMITS, recipients: 2, files: 1, bytes: 1000 };
  assert.deepEqual(draftProblems({ ...d, cc: ["b@example.com", "c@example.com"] }, limits).map((p) => p.kind), ["people", "fileCount", "bytes"]);
  assert.deepEqual(draftProblems({ ...d, files: [] }, limits), []);
});

test("the card gets mail.rs's limits and the accounts, only when there is a choice", () => {
  const limits = { recipients: 20, subject: 300, body: 100000, files: 10, bytes: 18874368 };
  const shown = outgoingEmail({ ...email, accounts: ["me@example.com", "work@example.com"], limits });
  assert.deepEqual(shown.accounts, ["me@example.com", "work@example.com"]);
  assert.deepEqual(shown.limits, limits);
  const one = outgoingEmail({ ...email, accounts: ["me@example.com"], limits: { ...limits, files: "ten" } });
  assert.equal(one.accounts, undefined);
  assert.equal(one.limits, undefined, "limits only when they are all numbers");
});

test("an email's card stays as long as Lumo waits for it, a second less", () => {
  assert.equal(mailCardMs(300), 299_000);
  assert.equal(mailCardMs(9999), 299_000, "never past 300 s");
  assert.equal(mailCardMs(undefined), 107_000);
  assert.equal(mailCardMs(0), 500);
});
