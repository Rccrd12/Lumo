// Settings → the search above the list of sections (src/settings/search.ts):
// what is typed shows the matching settings of every section, accents and
// case aside; a matching section or group heading shows all it holds; what a
// section hides by itself stays hidden; clearing brings everything back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";

installFakeDom();
const { h } = await import("../src/views/dom.ts");
const { group, sectionHead, setting } = await import("../src/settings/parts.ts");
const { applySearch, matches, normalize } = await import("../src/settings/search.ts");

test("a query matches whatever the case, the accents and the order of its words", () => {
  assert.equal(normalize("  Língua   ITALIANA "), "lingua italiana");
  assert.ok(matches("Avvia all'accensione", "AVVIA"));
  assert.ok(matches("Volume dei suoni", "suoni volume"));
  assert.ok(matches("Perché", "perche"));
  assert.ok(!matches("Lingua", "lingua inglese"));
  assert.ok(matches("anything", "   "), "an empty query matches all");
  assert.ok(matches("Scorciatoie", "scorciatoia"), "the singular finds the plural");
  assert.ok(matches("Suoni dell'isola", "suono"));
  assert.ok(!matches("Sun", "suono"));
});

function page() {
  const select = h("select", {}, h("option", { text: "Italiano" }));
  const hiddenRow = setting("Nascosto suono", null);
  hiddenRow.hidden = true;
  const general = h("section", {},
    ...sectionHead("Generale"),
    setting("Suono", "Il volume dei suoni"),
    setting("Lingua", null, select),
    hiddenRow,
    group("Menu del tasto destro"),
    h("div", { class: "hint", text: "Un clic destro apre il menu" }),
    h("div", { class: "setting-list" }, setting("Nuova chat", null), setting("Timer", null)),
  );
  const chat = h("section", {}, ...sectionHead("Chat"), setting("Modello", null),
    h("div", { class: "shortcut-list" },
      h("div", { class: "row shortcut" }, h("span", { class: "shortcut-name", text: "Apri la chat" }), h("button", { class: "keycap", text: "Ctrl+Alt+Space" })),
      h("div", { class: "row shortcut" }, h("span", { class: "shortcut-name", text: "Muta Lumo" }), h("button", { class: "keycap", text: "Ctrl+Alt+S" }))));
  const content = h("main", { class: "content" }, h("div", { class: "page" }, general), h("div", { class: "page" }, chat));
  return { content, general, chat };
}

const shown = (root) => root.find(".setting").filter((r) => !r.classList.contains("search-miss") && !r.hidden)
  .map((r) => r.find(".setting-label")[0].textContent);

test("only the matching rows show, with their section's heading", () => {
  const { content, general, chat } = page();
  assert.equal(applySearch(content, "suono"), true);
  assert.deepEqual(shown(content), ["Suono"], "the hidden row never shows, a drop-down's choices never match");
  assert.ok(chat.classList.contains("search-miss"), "a section with nothing left out");
  assert.deepEqual(content.find(".page").map((p) => p.classList.contains("search-miss")), [false, true], "and its page takes no room");
  assert.ok(!general.classList.contains("search-miss"));
  assert.ok(general.find(".setting-group")[0].classList.contains("search-miss"));

  assert.equal(applySearch(content, "italiano"), false, "the language list's choices are not words of a setting");
});

test("a group heading that matches shows its group; a section heading shows the whole section", () => {
  const { content, chat } = page();
  applySearch(content, "tasto destro");
  assert.deepEqual(shown(content), ["Nuova chat", "Timer"]);
  assert.ok(!content.find(".hint")[0].classList.contains("search-miss"));

  applySearch(content, "timer");
  assert.deepEqual(shown(content), ["Timer"]);
  assert.ok(!content.find(".setting-group")[0].classList.contains("search-miss"), "its group's heading, for context");
  assert.ok(content.find(".hint")[0].classList.contains("search-miss"));

  applySearch(content, "chat");
  assert.ok(!chat.classList.contains("search-miss"));
  assert.deepEqual(shown(chat), ["Modello"], "the whole section");
});

test("a shortcut is a row of its own, found by its name or its keys", () => {
  const { content } = page();
  applySearch(content, "muta");
  const rows = content.find(".shortcut");
  assert.deepEqual(rows.map((r) => r.classList.contains("search-miss")), [true, false]);
  applySearch(content, "ctrl+alt+space");
  assert.deepEqual(rows.map((r) => r.classList.contains("search-miss")), [false, true]);
});

test("an empty query brings everything back, and a row the section hid stays hidden", () => {
  const { content } = page();
  applySearch(content, "suono");
  assert.equal(applySearch(content, ""), true);
  assert.equal(content.find(".search-miss").length, 0);
  assert.deepEqual(shown(content), ["Suono", "Lingua", "Nuova chat", "Timer", "Modello"]);
});
