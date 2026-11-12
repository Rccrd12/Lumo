// The new look's home and the Email view: a click on the Email tile opens the
// Email view (views/mail-view.ts), or the inbox where the island has none.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();

const { State, DEFAULT_SETTINGS } = await import("../src/core/state.ts");
const { buildHome } = await import("../src/views/home.ts");

function emptyActivities() {
  return {
    timers: [],
    media: null,
    calendar: { configured: false, events: [], link: "" },
    mail: { on: false, messages: [] },
  };
}

test("the Email tile opens the Email view, or the inbox where the island has none", () => {
  State.settings = { ...DEFAULT_SETTINGS };
  State.tasks = [];
  State.pendingApproval = null;
  State.approvalQueue = [];
  State.plans = [];
  State.activeChats = [];
  State.integrations = {};
  State.listening = [];
  const withMail = () => ({
    ...emptyActivities(),
    mail: { on: true, error: null, messages: [{ id: "m1", from: "Ada Lovelace", address: "ada@example.com", subject: "Lunch?", preview: "", body: "" }], inbox: "https://mail.google.com/mail/u/0/#inbox" },
  });
  const opened = [];
  const asked = [];
  const base = {
    openSession: () => {}, openGitHubPRs: () => {}, openRequest: () => {}, decide: () => {}, openChat: () => {},
    openPlan: () => {}, openChatPlan: () => {}, openUrl: () => {}, makeTool: () => {},
    activityData: withMail, activity: (a) => asked.push(a.kind), blip: () => {},
  };
  const mailTile = (home) => home.el.querySelectorAll(".home-tile").find((el) => /Ada Lovelace/.test(el.textContent));

  const home = buildHome({ ...base, openMail: () => opened.push("mail") }, () => false);
  home.sync();
  mailTile(home).fire("click");
  assert.deepEqual(opened, ["mail"]);
  assert.deepEqual(asked, []);

  const old = buildHome(base, () => false);
  old.sync();
  mailTile(old).fire("click");
  assert.deepEqual(asked, ["inbox"]);
});
