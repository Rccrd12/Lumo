// The big picture (src/views/picture.ts): a preview's picture, clicked in the
// chat, fills the whole open island until a click, its × or Esc closes it,
// and closes by itself anywhere but the open chat.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import "./tauri.mjs";

installFakeDom();
// What the page listens to, so Esc can be pressed.
const pageListeners = [];
document.addEventListener = (type, fn, capture) => pageListeners.push({ type, fn, capture });
const press = (key) => {
  const event = { key, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
  for (const l of pageListeners.filter((l) => l.type === "keydown")) l.fn(event);
  return event;
};

const { buildPicture, closePicture } = await import("../src/views/picture.ts");
const { buildPrompt } = await import("../src/views/chat.ts");
const { DEFAULT_SETTINGS, State } = await import("../src/core/state.ts");

const SRC = "data:image/png;base64,iVBORw0KGgo=";

test("it shows the picture with its caption, and a click on it closes it", () => {
  const picture = buildPicture();
  picture.sync(true);
  assert.ok(!picture.el.classList.contains("open"), "nothing asked: nothing shown");
  assert.equal(picture.el.find("IMG").length, 0, "a closed one holds no image");

  State.picture = { src: SRC, caption: "Screen 1" };
  picture.sync(true);
  assert.ok(picture.el.classList.contains("open"));
  assert.equal(picture.el.find("IMG")[0].getAttribute("src"), SRC);
  assert.equal(picture.el.querySelector(".zoom-caption").textContent, "Screen 1");

  picture.el.fire("click");
  assert.equal(State.picture, null);
  picture.sync(true);
  assert.ok(!picture.el.classList.contains("open"));
  assert.equal(picture.el.find("IMG").length, 0);
});

test("Esc closes the picture only, before the chat or the island see it", () => {
  const picture = buildPicture();
  State.picture = { src: SRC, caption: "Screen 1" };
  picture.sync(true);
  const esc = press("Escape");
  assert.equal(State.picture, null);
  assert.ok(esc.defaultPrevented && esc.stopped, "the island stays open");
  const again = press("Escape");
  assert.ok(!again.stopped, "with no picture up, Esc is left alone");
});

test("anywhere but the open chat, it closes by itself", () => {
  const picture = buildPicture();
  State.picture = { src: SRC, caption: "Screen 1" };
  picture.sync(true);
  picture.sync(false);
  assert.equal(State.picture, null);
  assert.ok(!picture.el.classList.contains("open"));
  closePicture(); // nothing up: nothing to do
  assert.equal(State.picture, null);
});

test("a picture of the chat's preview, clicked, goes big; leaving the preview closes it", () => {
  State.settings = { ...DEFAULT_SETTINGS, chatModels: {}, chatProvider: "claude-code" };
  State.chatHistory = [];
  State.view = "prompt";
  State.droppedFile = null;
  State.moreFiles = [];
  State.picture = null;
  const view = buildPrompt(() => {});
  view.el.querySelector(".chat-input").value = "";
  State.incomingShare = { kind: "screen", shots: [{ display: 0, name: "s.png", path: "C:\\in\\s.png", width: 10, height: 10, preview: SRC }] };
  view.sync();
  view.el.find(".attach-row")[0].fire("click");
  const img = view.el.find(".screen-preview-img")[0];
  assert.ok(img.classList.contains("zoomable"));
  img.fire("click");
  assert.deepEqual(State.picture, { src: SRC, caption: "Screen 1" });
  view.el.find(".btn").find((b) => b.textContent === "Close").fire("click");
  assert.equal(State.picture, null, "the preview it came from closed");
});
