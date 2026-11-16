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
const { LivePicture, RING_MS, StepsLine, actText, addressParts, browserTabsChanged, buildBrowserView, loadingText, openBrowserView, pointerAt, ringBox, setBrowserViewHost, stepsText } = await import("../src/views/browser-watch.ts");
const { State } = await import("../src/core/state.ts");

const tab = (chat, agent, n, host) => ({ chat, agent, tab: n, host, title: `${host} page` });
/** On screen: in the view shown, not faded out by a drop. */
const onScreen = (sel) => (sel === ".view.on" ? {} : null);

test("what the agent did, in words", () => {
  const act = (kind, what) => ({ kind, what, rect: null, scrollY: 0, ago: 0 });
  assert.equal(actText(act("open", "example.com")), "Opens example.com");
  assert.equal(actText(act("click", "Search")), "Clicks “Search”");
  assert.equal(actText(act("click", " ")), "Clicks here", "a click by x, y names nothing");
  assert.equal(actText(act("type", "Rome")), "Types “Rome”");
  assert.equal(actText(act("type", "•••")), "Types “•••”", "Rust never gives a password's text");
  assert.equal(actText(act("scroll", "down")), "Scrolls down");
  assert.equal(actText(act("scroll", "up")), "Scrolls up");
  assert.equal(actText(act("read", "")), "Reads the page");
  assert.equal(actText(act("look", "")), "", "a kind it doesn't know says nothing");
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

test("the pointer: at the last click or typing since a page opened, moved by the scroll, an I-beam while typing", () => {
  const step = (kind, point, scrollY = 0) => ({ seq: 1, kind, what: "", rect: null, point, scrollY, ago: 0 });
  const frame = (steps, scrollY = 0) => ({ width: 1280, height: 800, scrollY, steps });
  assert.deepEqual(pointerAt(frame([step("open", null), step("click", { x: 128, y: 200 })])), { left: 10, top: 25, text: false });
  assert.deepEqual(pointerAt(frame([step("click", { x: 128, y: 200 }), step("read", null), step("scroll", null)], 100)), { left: 10, top: 12.5, text: false }, "a read or a scroll leaves it where it was, the page moved under it");
  assert.deepEqual(pointerAt(frame([step("type", { x: 640, y: 400 })])), { left: 50, top: 50, text: true });
  assert.equal(pointerAt(frame([step("click", { x: 128, y: 200 }), step("open", null)])), null, "a new page: no pointer from the last one");
  assert.equal(pointerAt(frame([step("click", { x: 128, y: 200 })], 400)), null, "scrolled out of sight");
  assert.equal(pointerAt(frame([])), null);
  assert.equal(pointerAt({ width: 0, height: 0, scrollY: 0, steps: [step("click", { x: 1, y: 1 })] }), null);
});

test("what it does now, the steps before, and what is loading, in words", () => {
  const step = (kind, what) => ({ seq: 1, kind, what, rect: null, point: null, scrollY: 0, ago: 0 });
  const steps = [step("open", "example.com"), step("type", "Rome"), step("read", ""), step("read", ""), step("scroll", "down"), step("click", "Search")];
  assert.deepEqual(stepsText({ action: steps[5], steps }), { now: "Clicks “Search”", kind: "click", done: ["Types “Rome”", "Reads the page", "Scrolls down"] }, "the last three, a step said twice once");
  assert.deepEqual(stepsText({ action: steps[0], steps: undefined }), { now: "Opens example.com", kind: "open", done: [] });
  assert.deepEqual(stepsText({ action: null, steps: [] }), { now: "", kind: "", done: [] });
  assert.equal(loadingText({ action: steps[0], host: "example.com", url: "" }), "Opens example.com…");
  assert.equal(loadingText({ action: steps[5], host: "example.com", url: "" }), "Loading example.com…");
  assert.equal(loadingText({ action: null, host: "", url: "https://example.org/x" }), "Loading example.org…");
  // Under the picture: the line, its icon, the steps done; the tiles' without them.
  const line = new StepsLine();
  assert.equal(line.el.hidden, true, "nothing done yet: nothing said");
  line.update({ action: steps[5], steps, loading: false });
  assert.equal(line.el.hidden, false);
  assert.equal(line.el.querySelector(".bw-now-text").textContent, "Clicks “Search”");
  assert.equal(line.el.querySelector(".bw-now-ico").className, "bw-now-ico click");
  assert.deepEqual(line.el.querySelector(".bw-done").find("SPAN").map((x) => x.textContent), ["Types “Rome”", "Reads the page", "Scrolls down"]);
  line.update({ action: steps[0], steps: [steps[0]], loading: true });
  assert.equal(line.el.querySelector(".bw-now-text").textContent, "Opens example.com…", "opening: with the dots");
  assert.equal(line.el.querySelector(".bw-now-ico").className, "bw-now-ico busy");
  const small = new StepsLine(false);
  small.update({ action: steps[5], steps, loading: false });
  assert.equal(small.el.querySelector(".bw-done").hidden, true);
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
    const click = { seq: 5, kind: "click", what: "Rome", rect: { x: 128, y: 200, w: 256, h: 80 }, point: { x: 256, y: 240 }, scrollY: 0, ago: 100 };
    return {
      tab: 1, image: "AAAA", width: 1280, height: 800, scrollY: 0, title: "Example", url: "https://example.com/rome", host: "example.com",
      loading: false, action: click, steps: [{ seq: 4, kind: "open", what: "example.com", rect: null, point: null, scrollY: 0, ago: 900 }, click],
    };
  };
  const said = [];
  const live = new LivePicture("c", "a1", { onFrame: (f) => said.push(stepsText(f).now) });
  live.ensure();
  assert.equal(calls.length, before, "not on screen: nothing asked");
  // On screen: in the page, in the view on screen, the island open.
  live.el.isConnected = true;
  live.el.closest = onScreen;
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
  assert.equal(live.el.querySelector(".bw-ring").hidden, false, "the box of what it clicked");
  assert.equal(live.el.querySelector(".bw-ring").style.left, "10%");
  const cursor = live.el.querySelector(".bw-cursor");
  assert.equal(cursor.hidden, false, "its pointer");
  assert.deepEqual([cursor.style.left, cursor.style.top, cursor.classList.contains("text")], ["20%", "30%", false]);
  assert.equal(live.el.querySelector(".bw-ripple").classList.contains("on"), true, "the click's ripple");
  assert.equal(live.el.querySelector(".bw-wait").hidden, true, "nothing over the picture");
  assert.equal(live.el.classList.contains("loading"), false);
  assert.deepEqual(said, ["Clicks “Rome”"], "what it does, for the line under it");
  // The island closes: the next one isn't asked.
  State.mode = "compact";
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(frames.length, 1);
  live.drop();
  // Faded out while a file is dropped: nothing asked.
  const faded = new LivePicture("c", "a1");
  faded.el.isConnected = true;
  faded.el.closest = (sel) => (sel === ".view.on" || sel === ".hidden-by-upload" ? {} : null);
  State.mode = "expanded";
  faded.ensure();
  assert.equal(frames.length, 1, "faded out: nothing asked");
  faded.drop();
  // A picture that fails while the tab is open (a page changing): the last
  // one stays, nothing says closed, and it is asked again.
  let fail = true;
  internals.invoke = async (cmd, args) => {
    if (cmd !== "chat_browser_frame") return plain(cmd, args);
    frames.push(args);
    if (fail) throw new Error("The page refused: Execution context was destroyed.");
    return { tab: 1, image: "BBBB", width: 1280, height: 800, scrollY: 0, title: "Example", url: "https://example.com/next", host: "example.com", action: null };
  };
  const busy = new LivePicture("c", "a1");
  busy.el.isConnected = true;
  busy.el.closest = onScreen;
  busy.ensure();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(busy.el.querySelector(".bw-wait").textContent, "Loading example.com…", "before the first picture: the site loading");
  fail = false;
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal(busy.el.find("IMG")[0].src, "data:image/jpeg;base64,BBBB", "asked again after a while");
  // It fails again with a picture shown: that picture stays.
  fail = true;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(busy.el.find("IMG")[0].src, "data:image/jpeg;base64,BBBB");
  assert.equal(busy.el.find("IMG")[0].hidden, false, "the last picture stays");
  assert.equal(busy.el.querySelector(".bw-wait").hidden, true, "one failure says nothing");
  // Failing again and again: it says why, over the last picture.
  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(busy.el.querySelector(".bw-wait").hidden, false);
  assert.equal(busy.el.querySelector(".bw-wait").textContent, "No picture: The page refused: Execution context was destroyed.");
  assert.equal(busy.el.find("IMG")[0].hidden, false, "the last picture still under it");
  busy.drop();
  // The agent opens another tab, still being built: its address and what
  // opens, over the last picture, dimmed; no pointer from the last page.
  internals.invoke = async (cmd, args) => {
    if (cmd !== "chat_browser_frame") return plain(cmd, args);
    frames.push(args);
    return { tab: 2, opening: true, url: "https://example.com/new", host: "example.com", title: "", steps: [{ seq: 9, kind: "open", what: "example.com", rect: null, point: null, scrollY: 0, ago: 10 }] };
  };
  busy.ensure();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(busy.el.querySelector(".bw-wait").textContent, "Opens example.com…");
  assert.equal(busy.el.querySelector(".bw-url").textContent, "example.com/new");
  assert.equal(busy.el.find("IMG")[0].hidden, false, "the last picture, dimmed, rather than a black box");
  assert.equal(busy.el.classList.contains("loading"), true);
  assert.equal(busy.el.querySelector(".bw-load").hidden, false, "the bar along its top");
  assert.equal(busy.el.querySelector(".bw-cursor").hidden, true);
  busy.drop();
  // A tab that closed: said so, and nothing more asked.
  const askedBefore = frames.length;
  internals.invoke = async (cmd, args) => {
    if (cmd !== "chat_browser_frame") return plain(cmd, args);
    frames.push(args);
    throw new Error("This agent has no browser tab open.");
  };
  const gone = new LivePicture("c", "a1");
  gone.el.isConnected = true;
  gone.el.closest = onScreen;
  State.mode = "expanded";
  gone.ensure();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(gone.el.querySelector(".bw-wait").textContent, "The tab has closed.");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(frames.length, askedBefore + 1);
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
  // Back on the view: the tabs follow the agents' browser-tabs as they change.
  State.view = "browser";
  applyBrowserTabs({ tabs: [tab("c", "a2", 3, "booking.example"), tab("c", "a1", 4, "rooms.example"), tab("c", "a3", 6, "trips.example")] });
  browserTabsChanged();
  assert.deepEqual(view.el.querySelector(".bw-seg").find(".mv-seg-btn").map((b) => b.textContent), ["booking.example", "rooms.example", "trips.example", "All"]);
  applyBrowserTabs({ tabs: [tab("c", "a2", 3, "booking.example"), tab("c", "a1", 4, "rooms.example")] });
  browserTabsChanged();
  applyBrowserTabs({ tabs: [tab("c", "a2", 3, "booking.example"), tab("c", "a1", 4, "flats.example")] });
  browserTabsChanged();
  assert.deepEqual(view.el.querySelector(".bw-seg").find(".mv-seg-btn").map((b) => b.textContent), ["booking.example", "flats.example", "All"], "a tab on another site: its new name");
  applyBrowserTabs({ tabs: [tab("c", "a2", 3, "booking.example"), tab("c", "a1", 4, "rooms.example")] });
  browserTabsChanged();
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
  // All with one tab left: that tab, large.
  view.el.querySelector(".bw-seg").find(".mv-seg-btn")[2].fire("click");
  assert.equal($(".bw-body").className, "bw-body all");
  applyBrowserTabs({ tabs: [tab("c", "a1", 4, "rooms.example")] });
  browserTabsChanged();
  assert.equal($(".bw-body").className, "bw-body one");
  assert.equal($(".bw-foot").querySelector(".bw-agent").textContent, "Look on Rooms");
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
