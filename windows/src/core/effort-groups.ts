// Antigravity CLI lists one model per effort (`gemini-4-argon-low`,
// `gemini-4-argon-medium`, `gemini-4-argon-high`): the picker shows them as
// one model, `gemini-4-argon`, with an effort slider under the list. Nothing
// is written down per model: any name ending in an effort word is grouped
// with the others that end the same way before it. The model sent to the CLI
// is still the whole name of the variant picked.

/** The effort words a model's name can end in, from the least to the most. */
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** The level a model's name ends in (`-high`), and the name before it; null without one. */
export function splitEffort(id: string): { base: string; level: string } | null {
  const m = /^(.+)-([a-z]+)$/.exec(id);
  if (!m || !(LEVELS as readonly string[]).includes(m[2])) return null;
  return { base: m[1], level: m[2] };
}

/** One row of the picker: a model alone, or the variants of one model by effort. */
export interface ModelGroup {
  /** What the row says: the model's name, without its effort when grouped. */
  name: string;
  /** Its levels from the least to the most, empty for a model alone. */
  levels: string[];
  /** The model's id for each of its levels; for a model alone, `"" → id`. */
  ids: Map<string, string>;
}

/**
 * `ids` as the picker's rows, in the order the list gives them (a group where
 * its first variant is). A name ending in an effort word is grouped only with
 * at least one other variant of it: alone, it stays as it is.
 */
export function groupByEffort(ids: readonly string[]): ModelGroup[] {
  const variants = new Map<string, Map<string, string>>();
  for (const id of ids) {
    const split = splitEffort(id);
    if (!split) continue;
    const of = variants.get(split.base) ?? new Map<string, string>();
    if (!of.has(split.level)) of.set(split.level, id);
    variants.set(split.base, of);
  }
  const rows: ModelGroup[] = [];
  const placed = new Set<string>();
  for (const id of ids) {
    const split = splitEffort(id);
    const of = split ? variants.get(split.base) : undefined;
    // A model whose name is also a group's (`gemini-x` beside `gemini-x-low`) stays alone.
    if (!split || !of || of.size < 2 || ids.includes(split.base)) {
      rows.push({ name: id, levels: [], ids: new Map([["", id]]) });
      continue;
    }
    if (placed.has(split.base)) continue;
    placed.add(split.base);
    const levels = LEVELS.filter((l) => of.has(l));
    rows.push({ name: split.base, levels, ids: new Map(levels.map((l) => [l, of.get(l)!])) });
  }
  return rows;
}

/** The row `id` is in, if any. */
export function groupOf(groups: readonly ModelGroup[], id: string): ModelGroup | undefined {
  return groups.find((g) => [...g.ids.values()].includes(id));
}

/** The level `id` is at in its group ("" for a model alone or not listed). */
export function levelOf(groups: readonly ModelGroup[], id: string): string {
  const g = groupOf(groups, id);
  if (!g) return "";
  for (const [level, of] of g.ids) if (of === id) return level;
  return "";
}

/**
 * The variant a click on `group` picks: the level the model in use is at, if
 * the group has it (from `-high` to `-high`), else medium, else the one in the middle.
 */
export function variantFor(group: ModelGroup, level: string): string {
  if (group.levels.length === 0) return group.ids.get("")!;
  const at = group.levels.includes(level) ? level
    : group.levels.includes("medium") ? "medium"
    : group.levels[Math.floor((group.levels.length - 1) / 2)];
  return group.ids.get(at)!;
}
