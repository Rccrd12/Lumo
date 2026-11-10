// When a card fits itself to its size again. The island opening or closing
// changes the chat's width (and height) at every frame; a card that drew its
// chart again at each of them made the island stutter, more so on a laptop on
// battery. A card is fitted at once the first time it has a size, then only
// once the size has held for SETTLE_MS, and not at all while the island is not
// open (closing, its chat out of sight). While the user drags the island's
// edge, the cards follow it at each frame: they grow and shrink with it.

import { State } from "../../core/state";

/** How long a size must hold before the card fits itself to it. */
export const SETTLE_MS = 140;

/** The user is dragging the island's edge (island.ts). */
let dragging = false;
/** When the drag last moved anything; a release the page never heard of ends it after DRAG_LAPSE_MS. */
let draggedAt = 0;
const DRAG_LAPSE_MS = 3000;

/** Says the user started or stopped dragging the island's edge: while they do, the cards follow at once. */
export function cardsFollowDrag(on: boolean): void {
  dragging = on;
  draggedAt = performance.now();
}

function followingDrag(): boolean {
  if (!dragging) return false;
  const now = performance.now();
  if (now - draggedAt > DRAG_LAPSE_MS) return (dragging = false);
  draggedAt = now;
  return true;
}

/**
 * Calls `fit` with `el`'s content box when it changes size, as above. `fit` compares the size with
 * the one it last fitted, so the island opening back to the same size costs
 * nothing. The ResizeObserver is returned, to watch more elements with it.
 */
export function onResize(el: Element, fit: (box: DOMRectReadOnly) => void): ResizeObserver | null {
  if (typeof ResizeObserver === "undefined") return null;
  let sized = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** `el`'s content box as last seen (another element watched with it doesn't change it). */
  let box: DOMRectReadOnly | null = null;
  const settled = () => {
    timer = undefined;
    if (box && State.mode === "expanded") fit(box);
  };
  const watch = new ResizeObserver((entries) => {
    for (const entry of entries) if (entry.target === el) box = entry.contentRect;
    if (!box) return;
    if (!sized) {
      // The first time it has a size: drawn at once, so it never shows empty.
      if (box.width <= 0) return;
      sized = true;
      fit(box);
      return;
    }
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (followingDrag()) {
      fit(box);
      return;
    }
    timer = setTimeout(settled, SETTLE_MS);
  });
  watch.observe(el);
  return watch;
}
