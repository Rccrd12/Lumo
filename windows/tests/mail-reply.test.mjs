// The reply button of an email (src/island/compact.ts replyQuestion): with the
// AI allowed to send and a CLI in the chat, the reply goes in the email's own
// conversation, of its own account.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { replyQuestion } = await import("../src/island/compact.ts");
const { State } = await import("../src/core/state.ts");

const mail = (id) => ({ id, from: "Ada", address: "ada@example.com", subject: "Lunch", preview: "Hey!" });

test("a reply names the email's own account, so it never answers another email", () => {
  State.settings.aiMailAccess = "send";
  State.settings.chatProvider = "claude-code";
  // The first account's email: "server:uid", or the Email view's "imap:1/inbox:uid".
  assert.match(replyQuestion(mail("imap.gmail.com:42")), /its id is inbox:42\)/);
  assert.match(replyQuestion(mail("imap:1/inbox:42")), /its id is inbox:42\)/);
  // A second account's: with its address, which mail_reply reads the account from.
  assert.match(replyQuestion(mail("work@x.it/imap.gmail.com:42")), /its id is work@x\.it:inbox:42\)/);
  // A second account the id can't name (the Email view's "imap:2"): a new email to the sender.
  const other = replyQuestion(mail("imap:2/inbox:42"));
  assert.doesNotMatch(other, /inbox:42/);
  assert.match(other, /ada@example\.com with mail_send/);
});
