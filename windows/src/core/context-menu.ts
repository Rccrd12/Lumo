// The right-click menu's own items (src/views/context-menu.ts draws it, the
// island and its live activities window open it). Refresh and the text
// actions are always there when they apply; the rest is picked in Settings →
// General → Right-click menu, kept in `contextMenu` (settings.rs).
//
// Pure: which items, in which order, and the words for them.

import { N_ } from "../i18n/i18n";

/** One of the items that can be picked for the menu. */
export interface MenuItemDef {
  id: string;
  label: string;
  /** A switch (Sounds, Keep the island open): shown with a tick when on. */
  toggle?: boolean;
}

/** Every item that can be picked, in the order the menu shows them. */
export const MENU_ITEMS: readonly MenuItemDef[] = [
  { id: "newChat", label: N_("New chat") },
  { id: "chat", label: N_("Open the chat") },
  { id: "timer", label: N_("Timer: 5 minutes") },
  { id: "pin", label: N_("Keep the island open"), toggle: true },
  { id: "sound", label: N_("Sounds"), toggle: true },
  { id: "activities", label: N_("Live Activities"), toggle: true },
  { id: "center", label: N_("Put the island back in the middle") },
  { id: "wardrobe", label: N_("Wardrobe") },
  { id: "settings", label: N_("Settings") },
  { id: "quit", label: N_("Quit Lumo") },
];

/** Picked out of the box (settings.rs DEFAULT_CONTEXT_MENU says the same). */
export const DEFAULT_MENU = ["newChat", "pin", "sound", "activities", "center", "settings"];

export const MENU_TEXT = {
  refresh: N_("Refresh"),
  refreshHint: N_("Calendar, emails, integrations, plan usage and agents, all asked again"),
  refreshed: N_("Everything is up to date"),
  cut: N_("Cut"),
  copy: N_("Copy"),
  paste: N_("Paste"),
  selectAll: N_("Select all"),
  customize: N_("Customize this menu…"),
};

/** The picked items, known ones only, each once, in the menu's order. */
export function pickedItems(ids: unknown): MenuItemDef[] {
  const list = Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : DEFAULT_MENU;
  const wanted = new Set(list);
  return MENU_ITEMS.filter((item) => wanted.has(item.id));
}

/** `ids` with `id` turned on or off, in the menu's order. */
export function withItem(ids: unknown, id: string, on: boolean): string[] {
  const now = new Set(pickedItems(ids).map((i) => i.id));
  if (on) now.add(id);
  else now.delete(id);
  return MENU_ITEMS.filter((i) => now.has(i.id)).map((i) => i.id);
}

/** What the text actions can do where the right click landed. */
export interface TextContext {
  /** In a field that can be typed in. */
  editable: boolean;
  /** Some text is selected (in the field, or on the page). */
  selected: boolean;
  /** The field has text to select. */
  hasText: boolean;
}

/** The text actions that apply, in order: Cut, Copy, Paste, Select all. */
export function textActions(c: TextContext): ("cut" | "copy" | "paste" | "selectAll")[] {
  const out: ("cut" | "copy" | "paste" | "selectAll")[] = [];
  if (c.editable && c.selected) out.push("cut");
  if (c.selected) out.push("copy");
  if (c.editable) out.push("paste");
  if (c.editable && c.hasText) out.push("selectAll");
  return out;
}
