// The wardrobe view (src/views/wardrobe.ts): three parts, each with its title —
// the outfits and Lumo's style (his look) side by side, computer use (Claude's
// mouse and the Aim switch) under them — with the same click-to-keep in all.

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
const { COMPUTER_CURSORS, LUMO_LOOKS, OUTFIT_SELECTIONS } = await import("../src/character/wardrobe.ts");

function build() {
  const log = [];
  const actions = {
    previewOutfit: (o) => log.push(["previewOutfit", o]),
    chooseOutfit: (o) => log.push(["chooseOutfit", o]),
    previewLook: (l) => log.push(["previewLook", l]),
    chooseLook: (l) => log.push(["chooseLook", l]),
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

test("the outfits, Lumo's style and computer use are three parts, each under its own title", () => {
  const { host, parts } = build();
  assert.equal(parts.length, 3);
  const [outfits, looks, computer] = parts;
  assert.ok(outfits.classList.contains("wardrobe-outfits"));
  assert.ok(looks.classList.contains("wardrobe-looks"));
  assert.equal(label(outfits), "Outfits");
  assert.equal(label(looks), "Lumo's style");
  assert.equal(outfits.getAttribute("role"), "group");
  assert.equal(looks.getAttribute("aria-label"), "Lumo's style");
  assert.equal(buttons(outfits).length, OUTFIT_SELECTIONS.length);
  assert.equal(buttons(looks).length, LUMO_LOOKS.length);
  assert.ok(computer.classList.contains("wardrobe-computer"));
  assert.equal(label(computer), "Computer use");
  // Claude's two mice, then Aim.
  assert.equal(buttons(computer).length, COMPUTER_CURSORS.length + 1);
  // A line between the two parts side by side, computer use on a line under them,
  // and every button in one of them.
  assert.equal(host.el.find(".wardrobe-divider").length, 1);
  assert.equal(host.el.find(".wardrobe-extra").length, 1);
  assert.equal(
    host.el.find(".wardrobe-item").length,
    OUTFIT_SELECTIONS.length + LUMO_LOOKS.length + COMPUTER_CURSORS.length + 1,
  );
});

test("Claude's mouse is kept with a click, Aim turns on and off, and the header names them", () => {
  const { host, log, parts } = build();
  const computer = parts[2];
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

test("a look is tried on under the pointer and kept with a click, as an outfit is", () => {
  const { host, log, parts } = build();
  const [outfits, looks] = parts;
  const goccia = buttons(looks)[LUMO_LOOKS.indexOf("goccia")];
  goccia.fire("mouseenter");
  assert.deepEqual(log.at(-1), ["previewLook", "goccia"]);
  assert.equal(host.el.find(".wardrobe-note")[0].textContent, "Goccia · a soft drop");
  goccia.fire("mouseleave");
  assert.deepEqual(log.at(-1), ["previewLook", null]);
  goccia.fire("click");
  assert.deepEqual(log.at(-1), ["chooseLook", "goccia"]);

  const scarf = buttons(outfits)[OUTFIT_SELECTIONS.indexOf("scarf")];
  scarf.fire("mouseenter");
  assert.deepEqual(log.at(-1), ["previewOutfit", "scarf"]);
  scarf.fire("click");
  assert.deepEqual(log.at(-1), ["chooseOutfit", "scarf"]);
});

test("the chosen outfit and the chosen look are highlighted, one in each part", () => {
  const { host, parts } = build();
  const [outfits, looks] = parts;
  State.settings.lumoOutfit = "bowTie";
  State.settings.lumoCharacter = "lucciola";
  host.sync();
  const on = (part) => buttons(part).filter((b) => b.classList.contains("on"));
  assert.equal(on(outfits).length, 1);
  assert.equal(on(outfits)[0], buttons(outfits)[OUTFIT_SELECTIONS.indexOf("bowTie")]);
  assert.equal(on(looks).length, 1);
  assert.equal(on(looks)[0], buttons(looks)[LUMO_LOOKS.indexOf("lucciola")]);
});
