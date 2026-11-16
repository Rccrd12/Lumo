// Watch (src/views/browser-watch.ts): a live picture of an agent's hidden
// browser tab inside the island, under its row or in the agents' browser
// view. What the agent did is said in words and ringed on the picture, the
// ring following the page's scroll; pictures are asked of Rust only while
// one is on screen in the open island.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { calls, internals, sent } = await import("./tauri.mjs");
const { applyBrowserTabs, browserAgentsOf } = await import("../src/core/chat-agents.ts");
const { LivePicture, RING_MS, actText, addressParts, buildBrowserView, openBrowserView, ringBox, setBrowserViewHost } = await import("../src/views/browser-watch.ts");
const { State } = await import("../src/core/state.ts");

const tab = (chat, agent, n, host) => ({ chat, agent, tab: n, host, title: `${host} page` });

test("what the agent did, in words", () => {
  const act = (kind, what) => ({ kind, what, rect: null, scrollY: 0, ago: 0 });
  assert.equal(actText(act("open", "example.com")), "Opens example.com");
  assert.equal(actText(act("click", "Search")), "Clicks “Search”");
  assert.equal(actText(act("click", " ")), "Clicks here", "a click by x, y names nothing");
  assert.equal(actText(act("type", "Rome")), "Types “Rome”");
  assert.equal(actText(act("type", "•••")), "Types “•••”", "Rust never gives a password's text");
  assert.equal(actText(act("scroll", "down")), "Scrolls down");
  assert.equal(actText(act("scroll", "up")), "Scrolls up");
  assert.equal(actText(act("read", "")), "");
  assert.equal(actText(null), "");
});

test("the ring: the action's box in % of the picture, moved by the scroll since, gone when old or out of sight", () => {
  const frame = (action, scrollY = 0) => ({ width: 1280, height: 800, scrollY, action });
  const click = (extra = {}) => ({ kind: "click", what: "Go", rect: { x: 128, y: 200, w: 256, h: 80 }, scrollY: 0, ago: 500, ...extra });
  assert.deepEqual(ringBox(frame(click())), { left: 10, top: 25, width: 20, height: 10 });
  // The page scrolled 100 px down since: the box is 100 px higher.
  assert.deepEqual(ringBox(frame(click(), 100)), { left: 10, top: 12.5, width: 20, height: 10 });
  assert.equal(ringBox(frame(click(), 400)), null, "scrolled out of sight");
  assert.equal(ringBox(frame(click({ ago: RING_MS + 1 }))), null, "an old action has no ring");
  assert.equal(ringBox(frame(click({ rect: null }))), null);
  assert.equal(ringBox(frame(null)), null);
  assert.equal(ringBox({ width: 0, height: 0, scrollY: 0, action: click() }), null, "a page that couldn't say its size");
});

test("the address bar: the site, then the rest", () => {
  assert.deepEqual(addressParts("https://www.example.com/s/Rome?adults=2#map"), { host: "www.example.com", rest: "/s/Rome?adults=2#map" });
  assert.deepEqual(addressParts("https://example.com/"), { host: "example.com", rest: "" });
  assert.deepEqual(addressParts("not an address"), { host: "not an address", rest: "" });
});

test("a picture is asked only while it is on screen in the open island, one after the other", async () => {
  applyBrowserTabs({ tabs: [tab("c", "a1", 1, "example.com")] });
  const before = calls.length;
  const plain = internals.invoke;
  const frames = [];
  internals.invoke = async (cmd, args) => {
    if (cmd !== "chat_browser_frame") return plain(cmd, args);
    calls.push([cmd, args]);
    frames.push(args);
    return {
      tab: 1, image: "AAAA", width: 1280, height: 800, scrollY: 0, title: "Example", url: "https://example.com/rome", host: "example.com",
      action: { kind: "click", what: "Rome", rect: { x: 128, y: 200, w: 256, h: 80 }, scrollY: 0, ago: 100 },
    };
  };
  const live = new LivePicture("c", "a1");
  live.ensure();
  assert.equal(calls.length, before, "not on screen: nothing asked");
  // On screen: in the page, in the view on screen, the island open.
  live.el.isConnected = true;
  live.el.closest = () => ({});
  State.mode = "compact";
  live.ensure();
  assert.equal(frames.length, 0, "the island closed: nothing asked");
  State.mode = "expanded";
  live.ensure();
  live.ensure();
  assert.deepEqual(frames, [{ chatId: "c", agentId: "a1" }], "one at a time");
  await new Promise((r) => setTimeout(r, 0));
  const img = live.el.find("IMG")[0];
  assert.equal(img.src, "data:image/jpeg;base64,AAAA");
  assert.equal(live.el.querySelector(".bw-url").textContent, "example.com/rome");
  assert.equal(live.el.querySelector(".bw-ring").hidden, false);
  assert.equal(live.el.querySelector(".bw-ring").style.left, "10%");
  assert.ok(live.el.querySelector(".bw-tag").textContent.includes("Clicks “Rome”"));
  // The island closes: the next one isn't asked.
  State.mode = "compact";
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(frames.length, 1);
  live.drop();
  // A tab that closed: said so, and nothing more asked.
  internals.invoke = async (cmd, args) => {
    if (cmd !== "chat_browser_frame") return plain(cmd, args);
    frames.push(args);
    throw new Error("This agent's tab has closed.");
  };
  const gone = new LivePicture("c", "a1");
  gone.el.isConnected = true;
  gone.el.closest = () => ({});
  State.mode = "expanded";
  gone.ensure();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gone.el.querySelector(".bw-wait").textContent, "The tab has closed.");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(frames.length, 2);
  gone.drop();
  internals.invoke = plain;
  State.mode = "compact";
  applyBrowserTabs({ tabs: [] });
});

test("the agents' browser: a tab per agent and All; one large with its name, or all side by side", () => {
  applyBrowserTabs({ tabs: [tab("c", "a2", 3, "booking.example"), tab("c", "a1", 1, "rooms.example"), tab("c", "a1", 4, "rooms.example"), tab("d", "a9", 2, "other.example")] });
  assert.deepEqual(browserAgentsOf("c").map((x) => [x.agent, x.tab]), [["a2", 3], ["a1", 4]], "each agent's newest, as they opened");
  const prior = sent("chat_browser_frame").length;
  const views = [];
  const view = buildBrowserView({ setView: (v) => views.push(v), blip: () => {} });
  const asked = [];
  setBrowserViewHost({ title: (chat, agent) => ({ a1: "Look on Rooms", a2: "Look on Booking" })[agent] ?? "", ask: (c, a) => asked.push(["ask", a]), stop: (c, a) => asked.push(["stop", a]) });
  openBrowserView("c", "a1");
  assert.deepEqual(views, ["browser"]);
  State.view = "browser";
  view.sync();
  const $ = (cls) => view.el.querySelector(cls);
  assert.deepEqual(view.el.querySelector(".bw-seg").find(".mv-seg-btn").map((b) => [b.textContent, b.className]),
    [["booking.example", "mv-seg-btn"], ["rooms.example", "mv-seg-btn on"], ["All", "mv-seg-btn"]]);
  assert.equal($(".bw-body").className, "bw-body one");
  assert.equal($(".bw-foot").querySelector(".bw-agent").textContent, "Look on Rooms");
  $(".bw-foot").querySelector(".agents-btn.ask").fire("click");
  $(".bw-foot").querySelector(".agents-btn.stop").fire("click");
  assert.deepEqual(asked, [["ask", "a1"], ["stop", "a1"]]);
  // × goes back to the chat.
  $(".bw-bar").querySelector(".bw-ico").fire("click", { stopPropagation() {} });
  assert.deepEqual(views, ["browser", "prompt"]);
  // All: side by side, a click on one makes it large.
  view.el.querySelector(".bw-seg").find(".mv-seg-btn")[2].fire("click");
  assert.equal($(".bw-body").className, "bw-body all");
  const tiles = view.el.find(".bw-tile");
  assert.deepEqual(tiles.map((x) => x.querySelector(".bw-agent").textContent), ["Look on Booking", "Look on Rooms"]);
  tiles[0].fire("click");
  assert.equal($(".bw-foot").querySelector(".bw-agent").textContent, "Look on Booking");
  // The conversation's own tab: named so, without Ask or Stop.
  applyBrowserTabs({ tabs: [tab("c", "main", 5, "example.com")] });
  openBrowserView("c", "main");
  assert.equal($(".bw-foot").querySelector(".bw-agent").textContent, "The conversation");
  assert.equal($(".bw-foot").querySelector(".agents-btn"), null);
  assert.equal(view.el.querySelector(".bw-seg").hidden, true, "one tab: no tabs to pick");
  // Every tab closed: said so.
  applyBrowserTabs({ tabs: [] });
  view.sync();
  assert.equal($(".bw-empty").textContent, "No agent of this chat is browsing now.");
  assert.equal(sent("chat_browser_frame").length, prior, "never on screen here: nothing asked");
  State.view = "home";
});
