// The chat's Share menu in the new look (concepts/redesign, Share A): the
// kinds of things to share as pills with how many there are, the things of
// the kind picked as tiles, and Send to the chat. Nothing is captured or read
// until Send: a tile is only its icon and its name. The usual look keeps its
// menu and second lists (views/chat.ts drawScreenEntries).

import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";
import { N_, t } from "../i18n/i18n";

export const SHARE_PANEL_TEXT = {
  windows: N_("Open windows"),
  screens: N_("Screens"),
  tabs: N_("Tabs"),
  folders: N_("Folders"),
  send: N_("Send to the chat"),
};

export type ShareKindId = "windows" | "screens" | "tabs" | "folders";

/** One thing to share: a window, a screen, a tab, a folder, or all of a kind. */
export interface ShareItem {
  key: string;
  label: string;
  /** Small, in the tile's picture: the app, the site, the size. */
  detail?: string;
  title: string;
  /** "All windows" and the like. */
  all?: boolean;
  disabled?: boolean;
  /** Shares it (captures, reads): only on Send. */
  go: () => void;
}

export interface ShareKind {
  id: ShareKindId;
  /** How many there are (the "All" tile left out). */
  count: number;
  items: ShareItem[];
  /** What the kind's tiles say when there are none. */
  empty?: string;
}

const KIND_ICON: Record<ShareKindId, string> = {
  windows: ICONS.window,
  screens: ICONS.display,
  tabs: ICONS.globe,
  folders: ICONS.folder,
};

const KIND_LABEL: Record<ShareKindId, string> = {
  windows: SHARE_PANEL_TEXT.windows,
  screens: SHARE_PANEL_TEXT.screens,
  tabs: SHARE_PANEL_TEXT.tabs,
  folders: SHARE_PANEL_TEXT.folders,
};

/**
 * Draws the menu into `list`: pills, tiles, the line saying nothing is
 * captured yet, and Send. `kindNow` is the kind open; `onKind` remembers a
 * new one. `notes` are lines under the tiles (why screens are off…).
 */
export function drawShareGrid(
  list: HTMLElement,
  kinds: ShareKind[],
  kindNow: ShareKindId,
  onKind: (id: ShareKindId) => void,
  notes: string[],
  nothingYet: string,
): void {
  clear(list);
  const shown = kinds.find((k) => k.id === kindNow) ?? kinds[0];
  if (!shown) return;
  let picked: ShareItem | null = null;
  const send = h("button", { class: "share-send", type: "button", text: t(SHARE_PANEL_TEXT.send), disabled: true });
  send.addEventListener("click", () => picked?.go());

  const pills = h("div", { class: "share-kinds", role: "tablist" });
  for (const k of kinds) {
    const pill = h("button", {
      class: `share-kind${k.id === shown.id ? " on" : ""}`, type: "button", role: "tab", "aria-selected": String(k.id === shown.id),
      text: k.count > 0 ? `${t(KIND_LABEL[k.id])} · ${k.count}` : t(KIND_LABEL[k.id]),
    });
    pill.addEventListener("click", () => {
      if (k.id === shown.id) return;
      onKind(k.id);
      drawShareGrid(list, kinds, k.id, onKind, notes, nothingYet);
    });
    pills.append(pill);
  }

  const tiles = h("div", { class: "share-tiles" });
  for (const item of shown.items) {
    const icon = KIND_ICON[shown.id];
    const tile = h("button", {
      class: `share-tile${item.all ? " all" : ""}`, type: "button", title: item.title || item.label, disabled: item.disabled === true,
    },
    h("span", { class: "share-thumb" }, svg(icon, item.all ? 18 : 20, { stroke: 1.5 }),
      item.detail ? h("span", { class: "share-detail", text: item.detail }) : null),
    h("span", { class: "share-label" }, svg(icon, 10, { stroke: 1.8 }), h("span", { class: "share-name", text: item.label })));
    tile.addEventListener("click", () => {
      for (const other of tiles.querySelectorAll(".share-tile.on")) other.classList.remove("on");
      tile.classList.add("on");
      picked = item;
      send.disabled = false;
    });
    // A double click sends at once.
    tile.addEventListener("dblclick", () => item.go());
    tiles.append(tile);
  }
  if (shown.items.length === 0 && shown.empty) tiles.append(h("div", { class: "picker-status share-empty", text: shown.empty }));

  list.append(pills, tiles);
  for (const note of notes) list.append(h("div", { class: "picker-status", text: note }));
  list.append(h("div", { class: "share-foot" }, h("span", { class: "share-hint", text: nothingYet }), send));
}
