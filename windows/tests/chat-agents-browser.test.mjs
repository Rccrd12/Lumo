// The agents' hidden browser tabs (src-tauri/src/browser.rs keeps them;
// src/core/chat-agents.ts and src/views/agents-card.ts show them): the row of
// an agent with a tab says which site it is on and offers Watch, which asks
// Rust to show that tab. A tab is its agent's in its chat: "main" in two
// chats are two owners. The permission card says what a browser action does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { applyAgent, applyBrowserTabs, browserChats, browserOf, newAgentStore } = await import("../src/core/chat-agents.ts");
const { agentsCard, mainBrowser } = await import("../src/views/agents-card.ts");
const { describeBrowserAction, isBrowserTool } = await import("../src/core/agent-browser.ts");
const { isComputerTool } = await import("../src/core/computer.ts");

const T0 = 1_700_000_000_000;
const S = 1000;

function agent(id, extra = {}) {
  return {
    id, source: "claude-code", title: `Look up ${id}`, state: "working", steps: 0,
    startedAt: T0, lastSignalAt: T0 + 30 * S, background: true, canStop: true, ...extra,
  };
}

const send = (store, chat, a) => applyAgent(store, { chat, agent: a }, 0);

const tab = (chat, agent, n, host, extra = {}) => ({ chat, agent, tab: n, host, title: `${host} page`, visible: false, ...extra });

function host(extra = {}) {
  const log = { watch: [] };
  return {
    log,
    host: {
      label: (a) => `${a.kind} ${a.detail}`.trim(),
      stop: () => {},
      send: () => true,
      requestOnTop: null,
      seeRequest: () => {},
      changed: () => {},
      watchBrowser: (id) => log.watch.push(id),
      ...extra,
    },
  };
}

test("the tabs as Rust sends them: a repeat changes nothing, nonsense is left out", () => {
  const ev = { tabs: [tab("c", "a1", 1, "example.com"), tab("c", "a2", 2, "wikipedia.org")] };
  assert.equal(applyBrowserTabs(ev), true);
  assert.equal(applyBrowserTabs(structuredClone(ev)), false);
  assert.equal(browserOf("c", "a1").host, "example.com");
  assert.equal(browserOf("c", "zz"), undefined);
  assert.deepEqual([...browserChats()], ["c"]);
  // Shown or hidden is a change too.
  assert.equal(applyBrowserTabs({ tabs: [tab("c", "a1", 1, "example.com", { visible: true }), tab("c", "a2", 2, "wikipedia.org")] }), true);
  assert.equal(browserOf("c", "a1").visible, true);
  assert.equal(applyBrowserTabs({ tabs: [null, { chat: "c" }, { agent: "x", tab: "1" }, tab("c", "a1", 1, "example.com")] }), true);
  assert.deepEqual(browserOf("c", "a1"), tab("c", "a1", 1, "example.com"));
  assert.equal(browserOf("c", "a2"), undefined);
  assert.equal(applyBrowserTabs(null), true);
  assert.equal(browserOf("c", "a1"), undefined);
  assert.equal(applyBrowserTabs(undefined), false);
});

test("a tab is its agent's in its chat, and the newest is the one shown", () => {
  applyBrowserTabs({ tabs: [tab("c", "main", 1, "one.example"), tab("d", "main", 2, "two.example"), tab("c", "main", 3, "three.example")] });
  assert.equal(browserOf("c", "main").host, "three.example");
  assert.equal(browserOf("d", "main").host, "two.example");
  assert.equal(browserOf("e", "main"), undefined);
  applyBrowserTabs({ tabs: [] });
});

test("the card: the site on the row, Watch next to its time and in the opened row; nothing once it ended", () => {
  const store = newAgentStore();
  for (const id of ["b1", "b2"]) send(store, "k", agent(id));
  const c = store.get("k");
  applyBrowserTabs({ tabs: [tab("k", "b1", 4, "example.com"), tab("other", "b2", 5, "elsewhere.org")] });
  const { host: h, log } = host();
  const draw = (hh = h) => agentsCard({ chatId: "k", chat: c, batch: c.batches[0], now: T0 + 30 * S }, hh);
  const el = draw();
  const rows = el.find(".agents-row");
  assert.deepEqual(rows[0].find(".agents-badge").map((b) => [b.className, b.textContent]), [["agents-badge browser", "on example.com"]]);
  assert.equal(rows[1].querySelector(".agents-badge"), null, "the other chat's tab is not this agent's");
  assert.equal(rows[1].querySelector(".agents-btn.watch"), null);
  const watch = rows[0].querySelector(".agents-btn.watch");
  assert.equal(watch.textContent, "Watch");
  watch.fire("click");
  assert.deepEqual(log.watch, ["b1"]);
  // The opened row has it too.
  rows[0].querySelector(".agents-row-head").fire("click");
  assert.deepEqual(el.querySelector(".agents-detail").find(".agents-btn").map((b) => b.textContent), ["Watch", "Stop this agent", "Close"]);
  el.querySelector(".agents-detail").querySelector(".agents-btn.watch").fire("click");
  assert.deepEqual(log.watch, ["b1", "b1"]);
  // Without the host's action (nowhere to send it): the site, no button.
  const { host: none } = host({ watchBrowser: undefined });
  const bare = draw(none);
  assert.equal(bare.querySelector(".agents-btn.watch"), null);
  assert.equal(bare.querySelector(".agents-badge.browser").textContent, "on example.com");
  // Waiting for a permission: Watch still shows what it is on.
  send(store, "k", agent("b1", { state: "waiting", waitingFor: "permission" }));
  const waiting = draw().find(".agents-row")[0];
  assert.ok(waiting.className.includes("waiting"));
  assert.deepEqual(waiting.querySelector(".agents-side").find(".agents-btn").map((b) => b.textContent), ["Watch"]);
  // Done: neither, even before Rust closes its tab.
  send(store, "k", agent("b1", { state: "done", endedAt: T0 + 20 * S, summary: "Found it" }));
  const done = draw();
  assert.equal(done.querySelector(".agents-badge.browser"), null);
  assert.equal(done.querySelector(".agents-btn.watch"), null);
  applyBrowserTabs({ tabs: [] });
});

test("the conversation's own tab, next to the dots: its site and Watch", () => {
  applyBrowserTabs({ tabs: [tab("m", "main", 2, "example.com"), tab("m", "a1", 3, "agent.example"), tab("n", "main", 4, "")] });
  const watched = [];
  const el = mainBrowser("m", () => watched.push("main"));
  assert.equal(el.className, "typing-browser");
  assert.equal(el.querySelector(".agents-badge.browser").textContent, "on example.com");
  el.querySelector(".agents-btn.watch").fire("click");
  assert.deepEqual(watched, ["main"]);
  // A blank tab: no site to say, Watch still.
  const blank = mainBrowser("n", () => {});
  assert.equal(blank.querySelector(".agents-badge"), null);
  assert.ok(blank.querySelector(".agents-btn.watch"));
  assert.equal(mainBrowser("x", () => {}), null, "no tab, nothing");
  applyBrowserTabs({ tabs: [] });
});

test("the permission card says what a browser action does and where", () => {
  const say = (name, input = {}) => describeBrowserAction(`mcp__lumo__${name}`, input);
  assert.equal(say("browser_open", { url: " https://example.com/a?b=1 " }), "Open in a new browser tab · https://example.com/a?b=1");
  assert.equal(say("browser_open", { url: "example.com", tab: 2 }), "Open in browser tab 2 · example.com");
  assert.equal(say("browser_click", { tab: 2, ref: 12 }), "Click in browser tab 2 · [12]");
  assert.equal(say("browser_click", { tab: 2, x: 640, y: 320 }), "Click in browser tab 2 · 640, 320");
  assert.equal(say("browser_type", { tab: 2, ref: 5, text: "lumo\nring", submit: true }), "Type in browser tab 2 · [5] lumo⏎\nring⏎");
  assert.equal(say("browser_type", { tab: 1, text: "hi" }), "Type in browser tab 1 · hi");
  assert.equal(say("browser_scroll", { tab: 3, direction: "up" }), "Scroll up in browser tab 3");
  assert.equal(say("browser_scroll", { tab: 3, direction: "down", pages: 2 }), "Scroll down in browser tab 3 · ×2");
  assert.equal(say("browser_read", { tab: 1 }), "Read browser tab 1");
  assert.equal(say("browser_screenshot", { tab: 1 }), "Look at browser tab 1");
  assert.equal(say("browser_close", { tab: 7 }), "Close browser tab 7");
  assert.equal(say("browser_close", {}), "Close browser tab ?");
  // A tab given as text loads nowhere new (browser.rs refuses it): never "a new tab".
  assert.equal(say("browser_open", { url: "example.com", tab: "3" }), "Open in browser tab ? · example.com");
  assert.equal(say("browser_click", { tab: "2", x: "640", y: "400" }), "Click in browser tab ?");
  // Not the browser: other tools, another server, the computer's own.
  assert.equal(describeBrowserAction("mcp__github__browser_open", {}), null);
  assert.equal(describeBrowserAction("mcp__lumo__left_click", {}), null);
  assert.equal(isBrowserTool("mcp__lumo__browser_type"), true);
  assert.equal(isComputerTool("mcp__lumo__browser_type"), false, "the computer's card and its hold on clicks are not for a tab");
});

test("in the chat: the tabs come as an event, and Watch asks Rust", async () => {
  const { emit, internals, sent } = await import("./tauri.mjs");
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const { buildPrompt } = await import("../src/views/chat.ts");
  const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");
  assert.equal(DEFAULT_SETTINGS.chatBrowser, false, "off until the user turns it on");
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {}, chatProvider: "claude-code" };
  State.view = "prompt";
  State.startChat();
  const view = buildPrompt(() => {});
  view.sync();
  let finish;
  const plain = internals.invoke;
  internals.invoke = async (cmd, args) => (cmd === "chat_send" ? new Promise((r) => (finish = r)) : plain(cmd, args));
  view.el.querySelector(".chat-input").value = "go";
  view.el.querySelector(".send-btn").fire("click");
  await new Promise((r) => setTimeout(r, 0));
  const chat = State.chatId;
  const now = Date.now();
  for (const id of ["w1", "w2"]) emit("chat-agent", { chat, agent: agent(id, { startedAt: now, lastSignalAt: now }) });
  finish({ text: "Launched.", turns: 2 });
  await new Promise((r) => setTimeout(r, 0));
  view.sync();
  const $ = (cls) => view.el.querySelector(cls);
  assert.equal($(".agents-badge.browser"), null);
  emit("browser-tabs", { tabs: [{ chat, agent: "w2", tab: 1, host: "example.com", title: "Example", visible: false }] });
  assert.equal($(".agents-badge.browser").textContent, "on example.com");
  $(".agents-btn.watch").fire("click");
  assert.deepEqual(sent("chat_browser_watch"), [{ chatId: chat, agentId: "w2" }]);
  emit("browser-tabs", { tabs: [] });
  assert.equal($(".agents-badge.browser"), null);
  assert.equal($(".agents-btn.watch"), null);
  internals.invoke = plain;
});
