// Settings → the search field above the list of sections: what is typed
// shows, from every section at once, the settings whose name or description
// says it ("lingua", "scorciatoia", "volume"…) — the shortcuts and the pills
// one by one too — with their section's heading;
// clearing it brings back the section that was open.
//
// A section whose heading matches shows whole. Otherwise only its matching
// rows show (a list of rows keeps the ones that match), and a section with
// none is left out. Nothing is rebuilt: the rows are only hidden, with a
// class of their own, so what a section hides by itself stays hidden.

import { N_ } from "../i18n/i18n";

export const SEARCH_STRINGS = {
  placeholder: N_("Search settings"),
  none: N_("No setting matches “{query}”."),
};

/** Hidden by the search (settings.css), never by anything else. */
const MISS = "search-miss";

/** Lower case, without accents or extra spaces: "Lingua", "lingua " and "língua" read alike. */
export function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * A word as it is looked for: a long one without its last letter, so the
 * singular finds the plural and back ("scorciatoia", "scorciatoie"; "suono",
 * "suoni"; "shortcut", "shortcuts").
 */
function stem(word: string): string {
  return word.length >= 5 ? word.slice(0, -1) : word;
}

/** Every word of the query is somewhere in the text, in any order. */
export function matches(text: string, query: string): boolean {
  const words = normalize(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  const hay = normalize(text);
  return words.every((w) => hay.includes(stem(w)));
}

/** What a search shows or hides one by one: a setting, a shortcut, a pill. */
const ROW_CLASSES = ["setting", "shortcut", "pill-row"];
const isRow = (el: Element) => ROW_CLASSES.some((c) => el.classList.contains(c));

/** Every element under `el`, depth first (plain child walks, nothing more). */
function descendants(el: Element): Element[] {
  const out: Element[] = [];
  for (const child of Array.from(el.children)) out.push(child, ...descendants(child));
  return out;
}

const rowsIn = (el: Element) => descendants(el).filter(isRow);

/** The words an element shows to read, without the choices of its drop-down lists. */
function readable(el: Element): string {
  const own = el.classList.contains("setting-text") ? el : descendants(el).find((d) => d.classList.contains("setting-text"));
  if (own) return own.textContent ?? "";
  let text = "";
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) text += ` ${child.textContent ?? ""}`;
      else if (child.nodeType === 1 && !["SELECT", "OPTION"].includes((child as Element).tagName)) walk(child);
    }
  };
  walk(el);
  return text;
}

/** A section's own parts that a search shows or hides one by one. */
function rowsOf(section: Element): Element[] {
  const out: Element[] = [];
  for (const child of Array.from(section.children)) {
    if (child.tagName === "H2") continue;
    // A list of settings: its rows, each on its own.
    const rows = rowsIn(child);
    if (!isRow(child) && rows.length > 0) out.push(...rows);
    else out.push(child);
  }
  return out;
}

/**
 * Shows only what matches `query` in `content` (every page's sections), or
 * everything again for an empty query. True when something matches.
 */
export function applySearch(content: Element, query: string): boolean {
  const all = descendants(content);
  for (const el of all) el.classList.remove(MISS);
  if (!normalize(query)) return true;
  let any = false;
  for (const section of all.filter((el) => el.tagName === "SECTION")) {
    const head = Array.from(section.children).find((el) => el.tagName === "H2");
    if (head && matches(head.textContent ?? "", query)) {
      any = true;
      continue;
    }
    let found = false;
    // A group heading that matches shows its whole group; a row that matches
    // shows its group's heading, for context.
    let heading: Element | null = null;
    let groupMatches = false;
    for (const row of rowsOf(section)) {
      // Hidden by its section (a setting that doesn't apply here): never a match.
      if ((row as HTMLElement).hidden) continue;
      if (row.classList.contains("setting-group")) {
        heading = row;
        groupMatches = matches(readable(row), query);
        if (groupMatches) found = true;
        else row.classList.add(MISS);
        continue;
      }
      if (groupMatches || matches(readable(row), query)) {
        found = true;
        heading?.classList.remove(MISS);
      } else {
        row.classList.add(MISS);
      }
    }
    // A list whose rows all missed goes too, so no empty frame stays.
    for (const child of Array.from(section.children)) {
      const rows = rowsIn(child);
      if (!isRow(child) && rows.length > 0 && rows.every((r) => r.classList.contains(MISS) || (r as HTMLElement).hidden)) {
        child.classList.add(MISS);
      }
    }
    if (found) any = true;
    else section.classList.add(MISS);
  }
  // A page none of whose sections is left takes no room either.
  for (const page of all.filter((el) => el.classList.contains("page"))) {
    const sections = descendants(page).filter((el) => el.tagName === "SECTION");
    if (sections.length > 0 && sections.every((el) => el.classList.contains(MISS))) page.classList.add(MISS);
  }
  return any;
}
