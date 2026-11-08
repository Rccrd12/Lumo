// Tests for the new look's Home left-hand "In progress" list: active chats,
// GitHub CI / PRs / review requests, and active watches.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();

const { State, DEFAULT_SETTINGS } = await import("../src/core/state.ts");
const {
  buildHome, homeActiveChats, homeGitHubItems, homeInProgressCount,
} = await import("../src/views/home.ts");

function emptyActivities() {
  return {
    timers: [],
    media: null,
    calendar: { configured: false, events: [], link: "" },
    mail: { on: false, messages: [] },
  };
}

function resetState() {
  State.settings = { ...DEFAULT_SETTINGS, islandNewLook: true };
  State.tasks = [
    {
      id: "integration_claude",
      name: "VS Code",
      color: "#F5F6F8",
      state: "idle",
      stepIndex: 0,
      steps: [],
      source: "claudeCode",
      isIntegration: true,
    },
    {
      id: "integration_github",
      name: "GitHub",
      color: "#F4505E",
      state: "idle",
      stepIndex: 0,
      steps: [],
      source: "n8n",
      isIntegration: true,
    },
  ];
  State.pendingApproval = null;
  State.approvalQueue = [];
  State.plans = [];
  State.activeChats = [];
  State.integrations = {};
  State.listening = [];
}

function makeHome() {
  const openedChats = [];
  const openedUrls = [];
  const openedSessions = [];
  const home = buildHome({
    openSession: (id) => openedSessions.push(id),
    openRequest: () => {},
    decide: () => {},
    openChat: () => {},
    openPlan: () => {},
    openChatPlan: (chatId) => openedChats.push(chatId),
    openUrl: (url) => openedUrls.push(url),
    makeTool: () => {},
    activityData: emptyActivities,
    activity: () => {},
    blip: () => {},
  }, (task) => task.state === "working" || task.state === "thinking");
  return { home, openedChats, openedUrls, openedSessions };
}

beforeEach(resetState);

test("home shows the empty box only when no session, chat, GitHub item or watch is active", () => {
  const { home } = makeHome();
  home.sync();
  assert.equal(homeInProgressCount(0), 0);
  const empty = home.el.querySelector(".home-empty");
  assert.ok(empty, "expected .home-empty when nothing is running");
  assert.match(empty.textContent, /Nothing running right now/);
});

test("active chats writing or thinking appear in Home In progress and open on click, deduplicated against plans", () => {
  const { home, openedChats } = makeHome();
  State.activeChats = [
    {
      chatId: "chat-1",
      who: "Unsloth Studio",
      color: "#34D399",
      title: "Spiegami le PR aperte",
      line: "Writes…",
    },
    {
      chatId: "chat-2",
      who: "Claude Code",
      color: "#E07950",
      title: "Refactor home view",
      line: "Reading home.ts",
    },
  ];
  // chat-2 also has an active AgentPlan: it should appear once (as its plan row), not twice.
  State.plans = [
    {
      key: "chat|chat-2",
      pillId: "chat",
      agent: "Claude Code",
      color: "#E07950",
      project: "Refactor home view",
      updatedAt: 100,
      steps: [
        { text: "Inspect home.ts", status: "done" },
        { text: "Wire active chats", status: "active" },
      ],
    },
  ];

  assert.equal(homeActiveChats().length, 1);
  assert.equal(homeActiveChats()[0].chatId, "chat-1");
  assert.equal(homeInProgressCount(0), 2);

  home.sync();
  assert.equal(home.el.querySelector(".home-empty"), null);
  const rows = home.el.find(".home-row");
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Claude Code/);
  assert.match(rows[0].textContent, /Wire active chats/);
  assert.match(rows[1].textContent, /Unsloth Studio/);
  assert.match(rows[1].textContent, /Spiegami le PR aperte/);
  assert.match(rows[1].textContent, /Writes…/);

  rows[1].fire("click");
  assert.deepEqual(openedChats, ["chat-1"]);
});

test("GitHub CI runs, review requests, open PRs and watches populate Home In progress and open their links", () => {
  const { home, openedUrls, openedChats } = makeHome();
  State.integrations["integration_github"] = {
    configured: true,
    loaded: true,
    error: null,
    data: {
      pulse: {
        login: "Rccrd12",
        fetchedAt: Date.now(),
        mainCI: [
          { repo: "Rccrd12/Lumo", url: "https://github.com/Rccrd12/Lumo", branch: "main", ci: "pending", headSha: "abc" },
          { repo: "Rccrd12/GreenRepo", url: "https://github.com/Rccrd12/GreenRepo", branch: "main", ci: "success", headSha: "def" },
        ],
        toReview: [
          {
            id: "Rccrd12/Lumo#18",
            title: "Add Unsloth tools",
            url: "https://github.com/Rccrd12/Lumo/pull/18",
            repo: "Rccrd12/Lumo",
            number: 18,
            isDraft: false,
            ci: "success",
            review: "pending",
            headSha: "111",
          },
        ],
        myPRs: [
          {
            id: "Rccrd12/Lumo#21",
            title: "Improve Home box",
            url: "https://github.com/Rccrd12/Lumo/pull/21",
            repo: "Rccrd12/Lumo",
            number: 21,
            isDraft: false,
            ci: "failure",
            review: "pending",
            headSha: "222",
          },
        ],
      },
    },
  };
  State.listening = [
    {
      id: 1,
      source: "github.pr",
      repo: "Rccrd12/Lumo",
      number: 21,
      until: "green",
      task: "avvisami",
      chatId: "chat-watch",
      startedAt: Date.now(),
    },
  ];

  const ghItems = homeGitHubItems();
  // Green default-branch CI stays quiet; pending CI + 1 review PR + 1 open PR = 3 GitHub rows, plus 1 active watch = 4 rows.
  assert.equal(ghItems.length, 3);
  assert.equal(homeInProgressCount(0), 4);

  home.sync();
  assert.equal(home.el.querySelector(".home-empty"), null);
  const rows = home.el.find(".home-row");
  assert.equal(rows.length, 4);
  assert.match(rows[0].textContent, /Lumo \(main\)/);
  assert.match(rows[0].textContent, /Default branch CI · running/);
  assert.match(rows[1].textContent, /Lumo#18/);
  assert.match(rows[1].textContent, /To review/);
  assert.match(rows[2].textContent, /Lumo#21/);
  assert.match(rows[2].textContent, /Improve Home box/);
  assert.match(rows[3].textContent, /Listening/);

  rows[0].fire("click");
  rows[2].fire("click");
  rows[3].fire("click");
  assert.deepEqual(openedUrls, [
    "https://github.com/Rccrd12/Lumo/actions",
    "https://github.com/Rccrd12/Lumo/pull/21",
  ]);
  assert.deepEqual(openedChats, ["chat-watch"]);
});
