// Lumo's wardrobe — the pure logic. What Lumo wears is picked in the wardrobe
// view (right-click on Lumo, or the tray menu) and stored in the preferences as
// `mochiOutfit` (the key keeps its old name so saved settings carry over); his
// look is picked there too and stored as `lumoCharacter`. The drawing lives in
// ./outfits.ts and ./looks.ts.

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

/**
 * Lumo's look, also picked in the wardrobe and stored as `lumoCharacter`: a
 * ring of light (Filo, the default), a dot of light (Punto), a soft drop
 * (Goccia) or the firefly he was in 0.3.1's first builds (Lucciola). Order of
 * the wardrobe; keep the raw values stable once shipped.
 */
export const LUMO_LOOKS = ["filo", "punto", "goccia", "lucciola"] as const;

export type LumoLook = (typeof LUMO_LOOKS)[number];

export const DEFAULT_LOOK: LumoLook = "filo";

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

/** The looks' names, the keys of their translations. */
export const LOOK_KEYS: Record<LumoLook, string> = {
  filo: N_("Filo · a ring of light"),
  punto: N_("Punto · a dot of light"),
  goccia: N_("Goccia · a soft drop"),
  lucciola: N_("Lucciola · the firefly"),
};

export const LOOK_LABELS: Record<LumoLook, string> = labels(LOOK_KEYS);

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

const LOOK_SET: ReadonlySet<string> = new Set(LUMO_LOOKS);

/** A stored look → a look. Anything unknown (a newer build's, garbage) is Filo. */
export function parseLook(raw: unknown): LumoLook {
  return typeof raw === "string" && LOOK_SET.has(raw) ? (raw as LumoLook) : DEFAULT_LOOK;
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

/** A look button under the pointer, told apart from an outfit's. */
export interface LookHover {
  look: LumoLook;
}

/**
 * The grey text at the right of the wardrobe header: the hovered outfit,
 * otherwise the current choice — WardrobeView.headerRight on macOS.
 */
export function wardrobeHeader(
  hovered: OutfitSelection | LookHover | null,
  selection: OutfitSelection,
  date: Date,
): string {
  if (hovered && typeof hovered === "object") return LOOK_LABELS[hovered.look];
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
