// A right-click menu of its own for an element (a chat's file, views/chat.ts):
// the island opens it instead of the usual one (island.ts openMenu). Apart
// from views/context-menu.ts, so a view can offer one without its stylesheet.

import type { MenuEntry } from "./context-menu";

/** What a right click on an element offers instead of the usual menu. */
const OWN_MENUS = new WeakMap<Element, () => MenuEntry[]>();

/** A right click on `el` (or inside it) opens `entries` alone. */
export function ownMenu(el: Element, entries: () => MenuEntry[]) {
  OWN_MENUS.set(el, entries);
}

/** The menu of its own the right click on `target` landed in, if any. */
export function ownEntries(target: EventTarget | null): MenuEntry[] | null {
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    const entries = OWN_MENUS.get(el);
    if (entries) return entries();
  }
  return null;
}
