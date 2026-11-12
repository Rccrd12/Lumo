// The island's Email view (src/core/mail-view.ts): what Rust lists (mail.rs
// mail_view, tested there), and how the view sorts, labels and colours it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACCOUNT_COLORS, ALL, accountColor, accountLabel, avatarColor, initials, keptFilter, mailWhen, neighbours,
  readMailView, totalUnread, visibleMessages,
} from "../src/core/mail-view.ts";

const RAW = {
  accounts: [
    { key: "imap:1", label: "personale@gmail.com", state: "ok", unread: 3, inbox: "https://mail.google.com/mail/u/0/#inbox" },
    { key: "imap:2", label: "lavoro@studio.it", state: "error", error: "The server refused the app password.", unread: 0 },
    { key: "outlook", label: "Outlook", state: "ok", unread: 2, inbox: "lumo-outlook:inbox" },
  ],
  messages: [
    { id: "imap:1/inbox:9", account: "imap:1", from: "Ada Lovelace", address: "ada@example.com", subject: "Lunch?", preview: "", body: "Hi", date: "Thu, 12 Nov 2026 10:42:00 +0100", unread: true },
    { id: "outlook/outlook-1", account: "outlook", from: "Giulia Rossi", address: "giulia@example.com", subject: "Thursday", preview: "", body: "", date: "Thu, 12 Nov 2026 09:58:00 +0100", unread: true },
    { id: "imap:1/inbox:8", account: "imap:1", from: "Spotify", address: "no-reply@spotify.com", subject: "Your playlist", preview: "", body: "", date: "Mon, 9 Nov 2026 08:00:00 +0100", unread: false },
    // An email of an account that is no longer listed: dropped.
    { id: "imap:3/inbox:1", account: "imap:3", from: "Old", address: "", subject: "", preview: "", body: "", date: "", unread: true },
    // No id: dropped.
    { account: "imap:1", from: "Nobody" },
  ],
};

test("what Rust sent is read safely: strings, known accounts, emails with an id", () => {
  const data = readMailView(RAW);
  assert.deepEqual(data.accounts.map((a) => a.key), ["imap:1", "imap:2", "outlook"]);
  assert.equal(data.accounts[1].state, "error");
  assert.equal(data.accounts[1].error, "The server refused the app password.");
  assert.equal(data.accounts[0].inbox, "https://mail.google.com/mail/u/0/#inbox");
  assert.deepEqual(data.messages.map((m) => m.id), ["imap:1/inbox:9", "outlook/outlook-1", "imap:1/inbox:8"]);
  assert.equal(data.messages[2].unread, false);
  // Outside Lumo there is no answer: an empty view.
  assert.deepEqual(readMailView(null), { accounts: [], messages: [] });
  assert.deepEqual(readMailView({ accounts: "x", messages: 3 }), { accounts: [], messages: [] });
});

test("All shows every account's emails, a button only its own", () => {
  const data = readMailView(RAW);
  assert.equal(visibleMessages(data, ALL).length, 3);
  assert.deepEqual(visibleMessages(data, "imap:1").map((m) => m.from), ["Ada Lovelace", "Spotify"]);
  assert.deepEqual(visibleMessages(data, "imap:2"), []);
  // All's unread leave out the account that can't be read.
  assert.equal(totalUnread(data), 5);
});

test("a button that went away (account removed or paused) falls back to All", () => {
  const data = readMailView(RAW);
  assert.equal(keptFilter(data, "outlook"), "outlook");
  assert.equal(keptFilter(data, "imap:4"), ALL);
  assert.equal(keptFilter(data, ALL), ALL);
});

test("each address keeps its colour, in the order Settings lists them", () => {
  const data = readMailView(RAW);
  assert.equal(accountColor(data, "imap:1"), ACCOUNT_COLORS[0]);
  assert.equal(accountColor(data, "outlook"), ACCOUNT_COLORS[2]);
});

test("the buttons say the address, only the part before @ once there are four or more", () => {
  const data = readMailView(RAW);
  assert.equal(accountLabel(data, data.accounts[0]), "personale@gmail.com");
  const four = readMailView({ accounts: [...RAW.accounts, { key: "imap:3", label: "uni@studenti.it", state: "ok", unread: 0 }], messages: [] });
  assert.equal(accountLabel(four, four.accounts[0]), "personale");
  assert.equal(accountLabel(four, four.accounts[2]), "Outlook");
});

test("the avatar: one or two letters, the same colour for the same sender", () => {
  assert.equal(initials("Ada Lovelace"), "AL");
  assert.equal(initials("GitHub"), "G");
  assert.equal(initials("", "ada@example.com"), "A");
  assert.equal(initials("\"Marco Bianchi\" <m@x.it>"), "MB");
  assert.equal(initials(""), "?");
  assert.equal(avatarColor("ada@example.com"), avatarColor("ADA@example.com"));
  assert.match(avatarColor("x"), /^#[0-9a-f]{6}$/);
});

test("when: the time today, Yesterday, the weekday this week, the date before", () => {
  const now = new Date(2026, 10, 12, 15, 0).getTime();
  const at = (y, mo, d, h) => new Date(y, mo, d, h, 30).toString();
  assert.match(mailWhen(at(2026, 10, 12, 10), now, "en", "Yesterday"), /10:30/);
  assert.equal(mailWhen(at(2026, 10, 11, 10), now, "en", "Yesterday"), "Yesterday");
  assert.equal(mailWhen(at(2026, 10, 9, 10), now, "en", "Yesterday"), "Mon");
  assert.equal(mailWhen(at(2026, 9, 2, 10), now, "en", "Yesterday"), "Oct 2");
  assert.equal(mailWhen("", now, "en", "Yesterday"), "");
  assert.equal(mailWhen("not a date", now, "en", "Yesterday"), "");
});

test("‹ and › go to the newer and the older email of the list shown", () => {
  const data = readMailView(RAW);
  const list = visibleMessages(data, ALL);
  assert.deepEqual(neighbours(list, "outlook/outlook-1"), { newer: "imap:1/inbox:9", older: "imap:1/inbox:8" });
  assert.deepEqual(neighbours(list, "imap:1/inbox:9"), { newer: null, older: "outlook/outlook-1" });
  assert.deepEqual(neighbours(list, "gone"), { newer: null, older: null });
});
