/**
 * A window moved or sized under the island (island.rs `window_moving`): the
 * cursor riding over the island is carrying that window, not coming to rest
 * on the island, so it never counts as on it. Let go with the cursor still on
 * the island, it keeps not counting until the cursor leaves it: the window was
 * put there, the island was not asked for. From the next entry on it is a
 * hover again.
 *
 * `held` is the previous answer, `moving` what the cursor poll says now, and
 * `over` whether the cursor is on the island (its hit margin included).
 */
export function heldByWindowMove(held: boolean, moving: boolean, over: boolean): boolean {
  return moving || (held && over);
}
