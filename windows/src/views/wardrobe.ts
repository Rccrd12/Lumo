// Wardrobe view, opened with a right-click on Lumo or from the tray menu. Resting the pointer on a button
// tries the outfit on Lumo; a click keeps it. Two parts side by side, each
// with its title: the outfits, and Lumo's style — his look, picked the same
// way: Filo, Punto, Goccia or Lucciola (Windows only). Under them, on a line of
// its own, computer use: the mouse Claude wears (the dark arrow or Lucciola's)
// and the Aim switch.

import { h } from "./dom";
import { State } from "../core/state";
import { drawLookIcon, drawWardrobeIcon } from "../character/outfits";
import {
  AIM_KEY, COMPUTER_CURSORS, COMPUTER_CURSOR_KEYS, LOOK_KEYS, LUMO_LOOKS, OUTFIT_KEYS, OUTFIT_SELECTIONS,
  WARDROBE_STRINGS, parseComputerCursor, parseLook, parseOutfit, resolveOutfit, seasonalOutfit, wardrobeHeader,
  type ComputerCursor, type CursorHover, type LookHover, type LumoLook, type Outfit, type OutfitSelection,
} from "../character/wardrobe";
import type { ViewActions, ViewHost } from "./views";
import { language, tl, type Msg } from "../i18n/i18n";

const ICON = 28;

/** Claude's arrow, a rounded kite (computer.rs arrow_pixels, on its 32-pixel grid). */
const KITE: [number, number][] = [[4.2, 4.2], [22.6, 11.4], [15.05, 15.05], [11.4, 22.6]];

function kite(ctx: CanvasRenderingContext2D, fill: string | CanvasGradient, width: number) {
  ctx.beginPath();
  KITE.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.strokeStyle = fill;
  ctx.lineWidth = width;
  ctx.lineJoin = "round";
  ctx.fill();
  ctx.stroke();
}

/** A wardrobe button's picture of Claude's mouse, as computer.rs draws it. */
function drawCursorIcon(ctx: CanvasRenderingContext2D, size: number, cursor: ComputerCursor) {
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  // The kite's 32-pixel grid, its middle on the button's.
  const k = (size / 32) * 0.95;
  ctx.translate(size / 2 - 13.4 * k, size / 2 - 13.4 * k);
  ctx.scale(k, k);
  if (cursor === "lucciola") {
    const glow = ctx.createRadialGradient(17, 17, 0, 17, 17, 6);
    glow.addColorStop(0, "rgba(255,224,158,0.8)");
    glow.addColorStop(1, "rgba(255,224,158,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(10, 10, 14, 14);
    kite(ctx, "#1a1412", 4.66);
    const body = ctx.createLinearGradient(4, 4, 18, 18);
    body.addColorStop(0, "#fff6d8");
    body.addColorStop(1, "#f3d98a");
    kite(ctx, body, 1.64);
  } else {
    kite(ctx, "#ffffff", 5.36);
    kite(ctx, "#1a1412", 2.56);
  }
  ctx.restore();
}

/** The Aim button's picture: four corners around a point. */
function drawAimIcon(ctx: CanvasRenderingContext2D, size: number) {
  ctx.clearRect(0, 0, size, size);
  const c = size / 2;
  const r = size * 0.3;
  const arm = size * 0.13;
  ctx.strokeStyle = "#ffe09e";
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    ctx.beginPath();
    ctx.moveTo(c + sx * r, c + sy * (r - arm));
    ctx.lineTo(c + sx * r, c + sy * r);
    ctx.lineTo(c + sx * (r - arm), c + sy * r);
    ctx.stroke();
  }
  ctx.fillStyle = "#ffe09e";
  ctx.beginPath();
  ctx.arc(c, c, 1.6, 0, Math.PI * 2);
  ctx.fill();
}

export function buildWardrobe(actions: ViewActions): ViewHost {
  const note = h("span", { class: "wardrobe-note" });
  const grid = h("div", { class: "wardrobe-grid" });
  const looks = h("div", { class: "wardrobe-grid" });
  const mice = h("div", { class: "wardrobe-grid" });
  /** One part of the wardrobe: its title over its buttons. */
  const part = (title: Msg, buttons: HTMLElement, kind: string) =>
    h(
      "div",
      { class: `wardrobe-part wardrobe-${kind}`, role: "group", "aria-label": title },
      h("span", { class: "wardrobe-label", text: title }),
      buttons,
    );
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
        h(
          "div",
          { class: "wardrobe-parts" },
          part(tl("Outfits"), grid, "outfits"),
          h("div", { class: "wardrobe-divider", "aria-hidden": "true" }),
          part(tl("Lumo's style"), looks, "looks"),
        ),
        // Claude's mouse on a line of its own, under the two: they keep their room.
        h("div", { class: "wardrobe-extra" }, part(tl("Computer use"), mice, "computer")),
      ),
    ),
  );

  let hovered: OutfitSelection | LookHover | CursorHover | null = null;
  let drawnSeason: Outfit | null = null;
  let drawnLanguage = language();
  let drawnLook: LumoLook | null = null;
  /** The screen's scale the icons were drawn for: another display needs them again. */
  let drawnDpr = 0;
  const items = new Map<OutfitSelection, { button: HTMLButtonElement; canvas: HTMLCanvasElement }>();

  const updateNote = () => {
    note.textContent = wardrobeHeader(hovered, parseOutfit(State.settings.lumoOutfit), new Date());
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
  const lookCanvases = new Map<LumoLook, HTMLCanvasElement>();
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
      if (!hovered || typeof hovered !== "object" || !("look" in hovered) || hovered.look !== look) return;
      hovered = null;
      actions.previewLook(null);
      updateNote();
    });
    button.addEventListener("click", () => actions.chooseLook(look));
    lookCanvases.set(look, canvas);
    lookItems.set(look, button);
    looks.append(button);
  }

  /** Claude's mice and the Aim switch: a click keeps, the pointer only names them in the header. */
  const mouseItems = new Map<ComputerCursor | "aim", { button: HTMLButtonElement; canvas: HTMLCanvasElement }>();
  for (const cursor of [...COMPUTER_CURSORS, "aim"] as const) {
    const name = cursor === "aim" ? tl(AIM_KEY) : tl(COMPUTER_CURSOR_KEYS[cursor]);
    const canvas = h("canvas");
    const button = h("button", { class: "wardrobe-item", title: name, "aria-label": name }, canvas);
    if (cursor === "aim") button.setAttribute("aria-pressed", "true");
    button.addEventListener("mouseenter", () => {
      hovered = { cursor };
      updateNote();
    });
    button.addEventListener("mouseleave", () => {
      if (!hovered || typeof hovered !== "object" || !("cursor" in hovered) || hovered.cursor !== cursor) return;
      hovered = null;
      updateNote();
    });
    button.addEventListener("click", () =>
      cursor === "aim" ? actions.setComputerAim(State.settings.computerAim === false) : actions.chooseComputerCursor(cursor),
    );
    mouseItems.set(cursor, { button, canvas });
    mice.append(button);
  }

  /**
   * Icons are drawn again only when they change: "auto" with the season and its
   * badge's language, all of them with the look they are worn on, and with the
   * scale of the display the island moved to.
   */
  const drawIcons = () => {
    const season = seasonalOutfit(new Date());
    const look = parseLook(State.settings.lumoCharacter);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rescaled = dpr !== drawnDpr;
    if (season === drawnSeason && drawnLanguage === language() && look === drawnLook && !rescaled) return;
    const first = drawnSeason == null || look !== drawnLook || rescaled;
    drawnSeason = season;
    drawnLanguage = language();
    drawnLook = look;
    drawnDpr = dpr;
    if (rescaled) {
      for (const [l, canvas] of lookCanvases) {
        canvas.width = Math.round(ICON * dpr);
        canvas.height = Math.round(ICON * dpr);
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawLookIcon(ctx, ICON, l);
      }
      for (const [cursor, { canvas }] of mouseItems) {
        canvas.width = Math.round(ICON * dpr);
        canvas.height = Math.round(ICON * dpr);
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        if (cursor === "aim") drawAimIcon(ctx, ICON);
        else drawCursorIcon(ctx, ICON, cursor);
      }
    }
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
      const current = parseOutfit(State.settings.lumoOutfit);
      for (const [sel, { button }] of items) button.classList.toggle("on", sel === current);
      const look = parseLook(State.settings.lumoCharacter);
      for (const [l, button] of lookItems) button.classList.toggle("on", l === look);
      const mouse = parseComputerCursor(State.settings.computerCursor);
      const aim = State.settings.computerAim !== false;
      for (const [cursor, { button }] of mouseItems) {
        if (cursor === "aim") {
          button.classList.toggle("on", aim);
          button.setAttribute("aria-pressed", String(aim));
        } else {
          button.classList.toggle("on", cursor === mouse);
        }
      }
      updateNote();
    },
  };
}
