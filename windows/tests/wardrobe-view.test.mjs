// The wardrobe view (src/views/wardrobe.ts): the island's edge light, and under
// it computer use (Claude's mouse and the Aim switch), each with its title.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
// The buttons' pictures are not drawn here (no 2D context): only the view is.
const createElement = document.createElement;
document.createElement = (tag) => {
  const el = createElement(tag);
  if (tag === "canvas") el.getContext = () => null;
  return el;
};
const { buildWardrobe } = await import("../src/views/wardrobe.ts");
const { State } = await import("../src/core/state.ts");
const { COMPUTER_CURSORS } = await import("../src/character/wardrobe.ts");

function build() {
  const log = [];
  const actions = {
    chooseComputerCursor: (c) => log.push(["chooseComputerCursor", c]),
    setComputerAim: (on) => log.push(["setComputerAim", on]),
  };
  const host = buildWardrobe(actions);
  host.sync();
  const parts = host.el.find(".wardrobe-part");
  return { host, log, parts };
}

const buttons = (part) => part.find(".wardrobe-item");
const label = (part) => part.find(".wardrobe-label")[0].textContent;

test("the edge lights and computer use, each under its own title, and no outfit nor look to pick", () => {
  const { host, parts } = build();
  assert.equal(parts.length, 1);
  const [computer] = parts;
  assert.ok(computer.classList.contains("wardrobe-computer"));
  assert.equal(label(computer), "Computer use");
  assert.equal(computer.getAttribute("role"), "group");
  // Claude's two mice, then Aim: the only buttons with a picture.
  assert.equal(buttons(computer).length, COMPUTER_CURSORS.length + 1);
  assert.equal(host.el.find(".wardrobe-item").length, COMPUTER_CURSORS.length + 1);
  assert.equal(host.el.find(".wardrobe-extra").length, 1);
  const edges = host.el.find(".wardrobe-edges")[0];
  assert.equal(edges.getAttribute("aria-label"), "Island edge");
  assert.equal(edges.find(".wardrobe-label")[0].textContent, "Island edge");
  assert.equal(host.el.find(".wardrobe-parts").length, 0);
  assert.equal(host.el.find(".wardrobe-divider").length, 0);
});

test("Claude's mouse is kept with a click, Aim turns on and off, and the header names them", () => {
  const { host, log, parts } = build();
  const [computer] = parts;
  const [direct, lucciola, aim] = buttons(computer);
  State.settings.computerCursor = "direct";
  State.settings.computerAim = true;
  host.sync();
  assert.ok(direct.classList.contains("on") && !lucciola.classList.contains("on"));
  assert.ok(aim.classList.contains("on"));
  assert.equal(aim.getAttribute("aria-pressed"), "true");

  lucciola.fire("mouseenter");
  assert.equal(host.el.find(".wardrobe-note")[0].textContent, "Lucciola · the butter arrow");
  lucciola.fire("mouseleave");
  lucciola.fire("click");
  assert.deepEqual(log.at(-1), ["chooseComputerCursor", "lucciola"]);

  aim.fire("mouseenter");
  assert.equal(host.el.find(".wardrobe-note")[0].textContent, "Aim · corners close in before a click");
  aim.fire("click");
  assert.deepEqual(log.at(-1), ["setComputerAim", false], "on → off");
  State.settings.computerAim = false;
  State.settings.computerCursor = "lucciola";
  host.sync();
  assert.ok(!aim.classList.contains("on"));
  assert.equal(aim.getAttribute("aria-pressed"), "false");
  assert.ok(lucciola.classList.contains("on") && !direct.classList.contains("on"));
  aim.fire("click");
  assert.deepEqual(log.at(-1), ["setComputerAim", true], "off → on");
});

test("the edge lights: one tried on under the pointer, kept with a click, named in the header", () => {
  const { host } = build();
  const saved = { ...State.settings };
  State.settings = { ...State.settings, islandEdgeLight: "full" };
  host.sync();
  const edges = host.el.find(".edge-item");
  assert.equal(edges.length, 4);
  const [full, soft] = edges;
  assert.ok(full.classList.contains("on") && !soft.classList.contains("on"));
  assert.equal(host.el.find(".wardrobe-note")[0].textContent, "Full light");

  soft.fire("mouseenter");
  assert.equal(State.edgePreview, "soft");
  assert.equal(host.el.find(".wardrobe-note")[0].textContent, "Soft light");
  soft.fire("mouseleave");
  assert.equal(State.edgePreview, null);
  soft.fire("click");
  assert.equal(State.settings.islandEdgeLight, "soft");
  host.sync();
  assert.ok(soft.classList.contains("on") && !full.classList.contains("on"));
  State.settings = saved;
});
