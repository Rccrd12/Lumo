// Wardrobe view — port of WardrobeView (IslandViewContent.swift). Opened with a
// right-click on Mochi or from the tray menu. Resting the pointer on a button
// tries the outfit on Mochi; a click keeps it. A second row, the same way,
// picks his look: Filo, Punto, Goccia or Lucciola (Windows and Linux only).

import { h } from "./dom";
import { State } from "../core/state";
import { drawLookIcon, drawWardrobeIcon } from "../mochi/outfits";
import {
  LOOK_KEYS, LUMO_LOOKS, OUTFIT_KEYS, OUTFIT_SELECTIONS, WARDROBE_STRINGS, parseLook, parseOutfit,
  resolveOutfit, seasonalOutfit, wardrobeHeader, type LookHover, type LumoLook, type Outfit,
  type OutfitSelection,
} from "../mochi/wardrobe";
import type { ViewActions, ViewHost } from "./views";
import { language, tl } from "../i18n/i18n";

const ICON = 28;

export function buildWardrobe(actions: ViewActions): ViewHost {
  const note = h("span", { class: "wardrobe-note" });
  const grid = h("div", { class: "wardrobe-grid" });
  const looks = h("div", { class: "wardrobe-grid" });
  const el = h(
    "div",
    { class: "view wardrobe" },
    h(
      "div",
      { class: "card" },
      h(
        "div",
        { class: "stack wardrobe-stack" },
        h("div", { class: "wardrobe-head" }, h("span", { class: "wardrobe-title", text: tl("Wardrobe") }), note),
        grid,
        looks,
      ),
    ),
  );

  let hovered: OutfitSelection | LookHover | null = null;
  let drawnSeason: Outfit | null = null;
  let drawnLanguage = language();
  let drawnLook: LumoLook | null = null;
  const items = new Map<OutfitSelection, { button: HTMLButtonElement; canvas: HTMLCanvasElement }>();

  const updateNote = () => {
    note.textContent = wardrobeHeader(hovered, parseOutfit(State.settings.mochiOutfit), new Date());
  };

  for (const sel of OUTFIT_SELECTIONS) {
    const canvas = h("canvas");
    const button = h(
      "button",
      { class: "wardrobe-item", title: tl(OUTFIT_KEYS[sel]), "aria-label": tl(OUTFIT_KEYS[sel]) },
      canvas,
    );
    button.addEventListener("mouseenter", () => {
      hovered = sel;
      actions.previewOutfit(resolveOutfit(sel, new Date()));
      updateNote();
    });
    button.addEventListener("mouseleave", () => {
      if (hovered !== sel) return;
      hovered = null;
      actions.previewOutfit(null);
      updateNote();
    });
    button.addEventListener("click", () => actions.chooseOutfit(sel));
    items.set(sel, { button, canvas });
    grid.append(button);
  }

  const lookItems = new Map<LumoLook, HTMLButtonElement>();
  for (const look of LUMO_LOOKS) {
    const canvas = h("canvas");
    const button = h(
      "button",
      { class: "wardrobe-item", title: tl(LOOK_KEYS[look]), "aria-label": tl(LOOK_KEYS[look]) },
      canvas,
    );
    button.addEventListener("mouseenter", () => {
      hovered = { look };
      actions.previewLook(look);
      updateNote();
    });
    button.addEventListener("mouseleave", () => {
      if (!hovered || typeof hovered !== "object" || hovered.look !== look) return;
      hovered = null;
      actions.previewLook(null);
      updateNote();
    });
    button.addEventListener("click", () => actions.chooseLook(look));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(ICON * dpr);
    canvas.height = Math.round(ICON * dpr);
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawLookIcon(ctx, ICON, look);
    }
    lookItems.set(look, button);
    looks.append(button);
  }

  /**
   * Icons are drawn again only when they change: "auto" with the season and its
   * badge's language, all of them with the look they are worn on.
   */
  const drawIcons = () => {
    const season = seasonalOutfit(new Date());
    const look = parseLook(State.settings.lumoCharacter);
    if (season === drawnSeason && drawnLanguage === language() && look === drawnLook) return;
    const first = drawnSeason == null || look !== drawnLook;
    drawnSeason = season;
    drawnLanguage = language();
    drawnLook = look;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const [sel, { canvas }] of items) {
      if (!first && sel !== "auto") continue;
      canvas.width = Math.round(ICON * dpr);
      canvas.height = Math.round(ICON * dpr);
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawWardrobeIcon(ctx, ICON, sel, season, WARDROBE_STRINGS.autoBadge, look);
    }
  };

  return {
    el,
    sync() {
      drawIcons();
      // The island drops the preview when the view closes: so does the hover.
      if (State.wardrobePreview == null && State.lookPreview == null) hovered = null;
      const current = parseOutfit(State.settings.mochiOutfit);
      for (const [sel, { button }] of items) button.classList.toggle("on", sel === current);
      const look = parseLook(State.settings.lumoCharacter);
      for (const [l, button] of lookItems) button.classList.toggle("on", l === look);
      updateNote();
    },
  };
}
