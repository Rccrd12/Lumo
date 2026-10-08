// Lumo's wardrobe — the pure logic. What Lumo wears is picked in the wardrobe
// view (right-click on Lumo, or the tray menu) and stored in the preferences as
// `mochiOutfit` (the key keeps its old name so saved settings carry over). The
// drawing lives in ./outfits.ts.

import { N_, labels, t } from "../i18n/i18n";

/** Every outfit, plus "auto" (dress for the season) and "none". Order of the wardrobe. */
export const OUTFIT_SELECTIONS = [
  "auto", "none", "leaf", "roundGlasses", "bowTie", "headphones", "scarf",
] as const;

/** What can be stored in the preferences. Keep the raw values stable once shipped. */
export type OutfitSelection = (typeof OUTFIT_SELECTIONS)[number];

/** What Lumo actually wears: a selection with "auto" resolved. */
export type Outfit = Exclude<OutfitSelection, "auto">;

export const DEFAULT_OUTFIT: OutfitSelection = "auto";

// ── User-visible strings ──────────────────────────────────────────────────────

/** The English names, the keys of their translations (src/i18n). */
export const OUTFIT_KEYS: Record<OutfitSelection, string> = {
  auto: N_("Auto (seasons)"),
  none: N_("None"),
  leaf: N_("Leaf"),
  roundGlasses: N_("Round glasses"),
  bowTie: N_("Bow tie"),
  headphones: N_("Headphones"),
  scarf: N_("Scarf"),
};

/** In the current language: every read goes through `t()`. */
export const OUTFIT_LABELS: Record<OutfitSelection, string> = labels(OUTFIT_KEYS);

export const WARDROBE_STRINGS = {
  get title() { return t("Wardrobe"); },
  get autoBadge() { return t("AUTO"); },
  autoNow: (current: string) => t("Auto · {outfit}", { outfit: current }),
  autoHover: (current: string) => t("Auto · follows the seasons (now: {outfit})", { outfit: current }),
};

// ── Logic ─────────────────────────────────────────────────────────────────────

const SELECTION_SET: ReadonlySet<string> = new Set(OUTFIT_SELECTIONS);

/**
 * A stored preference → a selection. Anything unknown (a value from a newer or
 * older build, such as Mochi's old "witchHat", or garbage) means "auto".
 */
export function parseOutfit(raw: unknown): OutfitSelection {
  return typeof raw === "string" && SELECTION_SET.has(raw) ? (raw as OutfitSelection) : DEFAULT_OUTFIT;
}

/**
 * The seasonal outfit for `date`, read in the user's local calendar: the scarf
 * in winter (December to February), the leaf in spring (March 20 to May 31).
 */
export function seasonalOutfit(date: Date): Outfit {
  const day = date.getDate();
  const month = date.getMonth() + 1;
  if (month === 12 || month <= 2) return "scarf";
  if ((month === 3 && day >= 20) || month === 4 || month === 5) return "leaf";
  return "none";
}

/** "auto" → the season's outfit; anything else is worn as chosen. */
export function resolveOutfit(selection: OutfitSelection, date: Date): Outfit {
  return selection === "auto" ? seasonalOutfit(date) : selection;
}

/**
 * The grey text at the right of the wardrobe header: the hovered outfit,
 * otherwise the current choice — WardrobeView.headerRight on macOS.
 */
export function wardrobeHeader(
  hovered: OutfitSelection | null,
  selection: OutfitSelection,
  date: Date,
): string {
  const season = OUTFIT_LABELS[seasonalOutfit(date)];
  if (hovered) return hovered === "auto" ? WARDROBE_STRINGS.autoHover(season) : OUTFIT_LABELS[hovered];
  return selection === "auto" ? WARDROBE_STRINGS.autoNow(season) : OUTFIT_LABELS[selection];
}

/** Same as resolveOutfit, remembered for the day — it is asked every frame. */
export class SeasonCache {
  private key = "";
  private value: Outfit = "none";

  get(selection: OutfitSelection, date = new Date()): Outfit {
    if (selection !== "auto") return selection;
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (key !== this.key) {
      this.key = key;
      this.value = seasonalOutfit(date);
    }
    return this.value;
  }
}
