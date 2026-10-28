// Gemini Live's lumo_status (src/live/lumo.ts): what Lumo knows, read when the
// model asks: the agents, the cards waiting, the plans' limits, GitHub, the
// email, the calendar, the other services, timers and music, the chat and
// the week. Small for a look at everything, whole for one section.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, internals, sent } from "./tauri.mjs";

installFakeDom();

const L = await import("../src/live/lumo.ts");
const P = await import("../src/live/protocol.ts");
const { runTool } = await import("../src/live/tools.ts");
const { State } = await import("../src/core/state.ts");
const { Feed } = await import("../src/core/compact.ts");

const NOW = Date.UTC(2026, 9, 14, 12, 0);
const MIN = 60_000;

function facts(over = {}) {
  return {
    now: NOW,
    tasks: [],
    sessions: {},
    diffs: new Map(),
    approval: null,
    queue: [],
    plans: { claude: null, codex: null, antigravity: null },
    integrations: {},
    events: [],
    timers: [],
    media: null,
    listening: [],
    chat: { provider: "Anthropic", model: "claude-opus-5-5", messages: [] },
    week: null,
    ...over,
  };
}

const vscode = {
  id: "integration_claude", name: "VS Code", color: "#fff", state: "working", stepIndex: 1,
  steps: ["Reading main.ts", "Editing island.ts"], source: "claudeCode", isIntegration: true,
  sessionCwd: "C:\\code\\lumo", finalLine: null,
};

test("the tool is offered with its sections, and the model is told when to use it", () => {
  const decl = P.toolDeclarations({ screen: true, helper: "Claude Code" }).find((d) => d.name === "lumo_status");
  assert.equal(decl.behavior, "NON_BLOCKING");
  assert.deepEqual(decl.parameters.required, undefined, "about is optional");
  for (const topic of ["agents", "approvals", "limits", "github", "email", "calendar", "services", "timers", "chat", "week"]) {
    assert.match(decl.parameters.properties.about.description, new RegExp(`"${topic}"`));
  }
  const text = P.systemInstruction({
    model: P.LIVE_MODEL, thinking: "medium", voice: "", helper: "Claude Code", screen: true, search: true,
    languageName: "Italian", now: "now",
  });
  assert.match(text, /lumo_status tells you everything Lumo knows/);
  assert.match(text, /before ask_helper/);
  assert.match(text, /never say you approved or denied one/);
});

test("an unknown section is a look at everything", () => {
  assert.equal(L.parseTopic("GitHub"), "github");
  assert.equal(L.parseTopic("weather"), "all");
  assert.equal(L.parseTopic(undefined), "all");
});

test("the agents: what each pill is doing, its sessions and the files it changed", () => {
  const diffs = new Map([["integration_claude", [
    { id: 0, path: "C:\\code\\lumo\\src\\a.ts", added: 3, removed: 1, hunks: [], tooLarge: false, isNewFile: false },
    { id: 1, path: "C:\\code\\lumo\\src\\a.ts", added: 2, removed: 0, hunks: [], tooLarge: false, isNewFile: false },
    { id: 2, path: "C:\\code\\lumo\\src\\b.ts", added: 9, removed: 0, hunks: [], tooLarge: false, isNewFile: true },
  ]]]);
  const sessions = { integration_claude: [
    { id: "s1", cwd: "C:\\code\\lumo", project: "lumo", started: NOW - 30 * MIN, seen: NOW - 2 * MIN, midTurn: true },
  ] };
  const github = { id: "integration_github", name: "GitHub", source: "n8n", isIntegration: true, state: "idle", steps: [] };
  const out = L.lumoStatus(facts({ tasks: [vscode, github], diffs, sessions }), "agents");
  assert.equal(out.agents.length, 1, "only the agents' and editors' pills");
  const a = out.agents[0];
  assert.equal(a.app, "VS Code");
  assert.equal(a.state, "working");
  assert.equal(a.project, "lumo");
  assert.deepEqual(a.recentSteps, ["Reading main.ts", "Editing island.ts"]);
  assert.equal(a.sessions[0].working, true);
  assert.equal(a.sessions[0].lastHeard, "2 min ago");
  assert.deepEqual(a.filesChanged, [
    { file: "C:\\code\\lumo\\src\\a.ts", added: 5, removed: 1 },
    { file: "C:\\code\\lumo\\src\\b.ts", added: 9, removed: 0, newFile: true },
  ]);
  // The short look names the files only.
  const short = L.lumoStatus(facts({ tasks: [vscode], diffs }), "all").agents[0];
  assert.deepEqual(short.filesChanged.map((f) => f.file), ["a.ts", "b.ts"]);
  assert.deepEqual(short.lastSteps, ["Reading main.ts", "Editing island.ts"]);
});

test("the cards waiting are described, and only the user answers them", () => {
  const card = {
    requestId: "r", sessionId: "s", pillId: "agent_codex", tool: "Bash", command: "npm publish", reason: "Release",
    project: "lumo",
  };
  const question = {
    requestId: "q", sessionId: "s", pillId: "integration_claude", tool: "AskUserQuestion", command: "",
    questions: [{ question: "Which name?", options: [{ label: "A", description: "" }, { label: "B", description: "" }], multiSelect: false }],
  };
  const out = L.lumoStatus(facts({ approval: card, queue: [question] }), "approvals").approvals;
  assert.deepEqual(out.showing, { agent: "Codex", tool: "Bash", project: "lumo", request: "npm publish", reason: "Release" });
  assert.deepEqual(out.waitingAfterIt[0].questions, [{ question: "Which name?", options: ["A", "B"] }]);
  assert.match(out.note, /can't approve or deny/);
  assert.ok(L.lumoStatus(facts(), "approvals").approvals.none);
});

test("the plans' limits, with when they reset", () => {
  const plans = {
    claude: { fiveHour: { usedPct: 42.4, resetsAt: NOW + 90 * MIN }, sevenDay: { usedPct: 0, resetsAt: NOW + 3 * 86_400_000, low: true }, updatedAt: NOW - 5 * MIN },
    codex: { fiveHour: { usedPct: 80, resetsAt: NOW - MIN }, updatedAt: NOW, planType: "plus", resetCredits: 1 },
    antigravity: { updatedAt: NOW, buckets: [{ group: "Gemini Models", window: "5h", w: { usedPct: 10, resetsAt: NOW + MIN } }] },
  };
  const out = L.lumoStatus(facts({ plans }), "limits").limits;
  assert.equal(out["Claude (Claude Code)"].fiveHours.used, "42%");
  assert.equal(out["Claude (Claude Code)"].week.used, "low");
  assert.equal(out["Claude (Claude Code)"].updated, "5 min ago");
  assert.deepEqual(out.Codex.fiveHours, { used: "0%", note: "It has just reset." });
  assert.equal(out.Codex.plan, "plus");
  assert.equal(out["Antigravity CLI"].quotas[0].used, "10%");
  assert.ok(L.lumoStatus(facts(), "limits").limits.none);
});

test("GitHub: pull requests, reviews, CI, contributions and what Lumo watches", () => {
  const pr = (n, ci) => ({ id: `o/r#${n}`, title: `PR ${n}`, url: "u", repo: "o/r", number: n, isDraft: n === 2, ci, review: "pending", headSha: "abc" });
  const data = {
    totalRepos: 12, totalStars: 40,
    pulse: { login: "me", myPRs: [pr(1, "failure"), pr(2, "pending")], toReview: [pr(3, "success")], mainCI: [{ repo: "o/r", url: "u", branch: "main", ci: "success", headSha: "x" }], fetchedAt: NOW },
    activity: { total: 300, fetchedAt: NOW, weeks: [[{ date: "d", count: 2, level: 1, weekday: 0 }], Array.from({ length: 7 }, () => ({ date: "d", count: 1, level: 1, weekday: 0 }))] },
  };
  const integrations = { integration_github: { data, error: null, loaded: true, configured: true } };
  const listening = [{ id: 1, repo: "o/r", number: 1, until: "green", task: "", chatId: "c", startedAt: NOW }];
  const out = L.lumoStatus(facts({ integrations, listening }), "github").github;
  assert.deepEqual(out.account, { repositories: 12, stars: 40 });
  assert.deepEqual(out.myPullRequests[0], { pr: "o/r#1", title: "PR 1", ci: "failure", review: "pending" });
  assert.equal(out.myPullRequests[1].draft, true);
  assert.equal(out.waitingForMyReview[0].pr, "o/r#3");
  assert.deepEqual(out.defaultBranchCI, [{ repo: "o/r", branch: "main", ci: "success" }]);
  assert.deepEqual(out.contributions, { pastYear: 300, last7Days: 7 });
  assert.deepEqual(out.lumoIsWatching, [{ pr: "o/r#1", until: "green" }]);
  // Not connected, or failing: said so.
  assert.match(L.lumoStatus(facts(), "github").github.none, /isn't connected/);
  const failing = { integration_github: { data: {}, error: "Bad token", loaded: true, configured: true } };
  assert.equal(L.lumoStatus(facts({ integrations: failing }), "github").github.error, "Bad token");
});

test("the email: the text in full only when asked for it", () => {
  const messages = [{ id: "1", from: "Marco", address: "m@x.it", subject: "Cena", preview: "Ci vediamo?", body: "Ci vediamo alle 8 da me.", date: "Wed" }];
  const integrations = { integration_mail: { data: { messages, unread: 3 }, error: null, loaded: true, configured: true } };
  const full = L.lumoStatus(facts({ integrations }), "email").email;
  assert.equal(full.unread, 3);
  assert.deepEqual(full.newestUnread[0], { from: "Marco", subject: "Cena", date: "Wed", text: "Ci vediamo alle 8 da me." });
  const short = L.lumoStatus(facts({ integrations }), "all").email;
  assert.equal(short.unread, 3);
  assert.equal(short.newestUnread, undefined, "the short look only counts them");
  assert.doesNotMatch(JSON.stringify(short), /Marco|Cena|vediamo/);
});

test("the calendar: what is on now and what comes, never what is over", () => {
  const events = [
    { title: "Past", start: NOW - 120 * MIN, end: NOW - 60 * MIN, allDay: false, location: "" },
    { title: "Standup", start: NOW - 5 * MIN, end: NOW + 10 * MIN, allDay: false, location: "Meet" },
    { title: "Holiday", start: NOW + 86_400_000, end: NOW + 2 * 86_400_000, allDay: true, location: "" },
  ];
  const out = L.lumoStatus(facts({ events }), "calendar").calendar.events;
  assert.deepEqual(out.map((e) => e.title), ["Standup", "Holiday"]);
  assert.equal(out[0].now, true);
  assert.equal(out[0].where, "Meet");
  assert.equal(out[1].allDay, true);
  assert.doesNotMatch(out[1].day, /\d{2}:\d{2}/);
  assert.ok(L.lumoStatus(facts(), "calendar").calendar.none);
});

test("the other services: their own data, kept small", () => {
  const deployments = Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, name: "site", state: "READY", url: "x".repeat(500) }));
  const integrations = {
    integration_vercel: { data: { deployments }, error: null, loaded: true, configured: true },
    integration_stripe: { data: {}, error: "Invalid key", loaded: true, configured: true },
    integration_notion: { data: {}, error: null, loaded: false, configured: false },
  };
  const out = L.lumoStatus(facts({ integrations }), "services").services;
  assert.equal(out.Vercel.deployments.length, 11, "ten and a note");
  assert.equal(out.Vercel.deployments.at(-1), "and 10 more");
  assert.equal(out.Vercel.deployments[0].id, undefined, "no ids");
  assert.ok(out.Vercel.deployments[0].url.length <= 240);
  assert.deepEqual(out.Stripe, { error: "Invalid key" });
  assert.equal(out.Notion, undefined, "not connected: left out");
  const short = L.lumoStatus(facts({ integrations }), "all").services;
  assert.deepEqual(short, { Vercel: "connected", Stripe: { error: "Invalid key" } }, "the short look: which are connected, no data");
});

test("timers, music, the chat and the week", () => {
  const out = L.lumoStatus(facts({
    timers: [{ id: 1, label: "Pasta", endsAt: NOW + 5 * MIN, total: 10 * MIN }, { id: 2, label: "", endsAt: NOW - MIN, total: MIN }],
    media: { title: "Song", artist: "Band", app: "Spotify", playing: true },
    chat: { provider: "Anthropic", model: "m", messages: [{ id: 1, role: "user", content: "Ciao" }, { id: 2, role: "assistant", content: "Ciao!" }] },
    week: { sessionCount: 4, totalMinutes: 95, filesChanged: 7, linesAdded: 100, linesRemoved: 20, commandsRun: 3, permissionsAllowed: 2, permissionsDenied: 0, topAgent: "Codex", topProject: "lumo" },
  }), "all");
  assert.equal(out.timers.timers.length, 1);
  assert.equal(out.timers.timers[0].label, "Pasta");
  assert.equal(out.timers.music.app, "Spotify");
  assert.equal(out.chat.messages, 2, "the short look only counts them");
  assert.equal(out.week.mostUsedAgent, "Codex");
  assert.match(out.more, /about/);
});

test("lumo_status reads the island's state, and asks Rust only for the music and the week", async () => {
  const before = internals.invoke;
  internals.invoke = async (cmd, args) => {
    if (cmd === "plugin:event|listen") return before(cmd, args);
    calls.push([cmd, args]);
    if (cmd === "media_now") return { title: "Song", artist: "Band", app: "Spotify", playing: false };
    if (cmd === "recap_history") return { turns: [], decisions: [], prefs: {} };
    return null;
  };
  const doing = [];
  const h = { screen: true, helper: "Claude Code", showPictures: async () => {}, doing: (l) => doing.push(l), end: () => {} };
  const tasks = State.tasks;
  State.tasks = [vscode];
  Feed.timers = [];
  try {
    const all = await runTool({ id: "l1", name: "lumo_status", args: {} }, h);
    assert.equal(all.result.agents[0].app, "VS Code");
    assert.equal(all.result.timers.music.title, "Song");
    assert.ok(all.result.week.none);
    assert.equal(sent("media_now").length, 1);
    assert.equal(sent("recap_history").length, 1);
    assert.equal(doing.at(-1), null);
    // One section asks Rust only for what it needs.
    const github = await runTool({ id: "l2", name: "lumo_status", args: { about: "github" } }, h);
    assert.deepEqual(Object.keys(github.result), ["github"]);
    assert.equal(sent("media_now").length, 1);
    assert.equal(sent("recap_history").length, 1);
  } finally {
    State.tasks = tasks;
    internals.invoke = before;
  }
});

test("Settings → Security keeps the email and the calendar from Gemini when the user says so", () => {
  const mail = { configured: true, loaded: true, error: null, data: { unread: 2, messages: [{ from: "Ada", subject: "Invoice", body: "Pay me" }] } };
  const events = [{ title: "Dentist", start: NOW + 60 * MIN, end: NOW + 90 * MIN, allDay: false }];
  const open = L.lumoStatus(facts({ integrations: { integration_mail: mail }, events }), "all");
  assert.equal(open.email.unread, 2);
  assert.equal(open.calendar.events[0].title, "Dentist");
  const shut = facts({ integrations: { integration_mail: mail }, events, mailOff: true, calendarOff: true });
  for (const topic of ["all", "email", "calendar"]) {
    const out = JSON.stringify(L.lumoStatus(shut, topic));
    assert.doesNotMatch(out, /Invoice|Dentist|Ada/, topic);
    assert.match(out, /Settings → General → Security/, topic);
  }
});
