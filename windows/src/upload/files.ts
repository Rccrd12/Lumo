// Several files dropped together: one small bar each under the main bar, as
// many as the card has room for, and "+X" for the rest. The main bar (the one
// Lumo rides) is the whole drop by bytes, each file's bar its own copy
// (upload/meter.ts).

import { t, tn } from "../i18n/i18n";

/** How many file bars the card has room for (two rows of two). */
export const FILE_CELLS = 4;

/** One cell under the main bar: a file and its bar, or how many more files there are. */
export type FileCell = { kind: "file"; name: string; index: number } | { kind: "more"; count: number };

/** The cells for `names`: all of them when they fit, else the first ones and "+X" in the last cell. */
export function fileCells(names: readonly string[]): FileCell[] {
  if (names.length < 2) return [];
  const shown = names.length <= FILE_CELLS ? names.length : FILE_CELLS - 1;
  const cells: FileCell[] = names.slice(0, shown).map((name, index) => ({ kind: "file", name, index }));
  if (shown < names.length) cells.push({ kind: "more", count: names.length - shown });
  return cells;
}

/** "Uploading relazione.pdf", or "Uploading 3 files" for several. */
export function uploadingLabel(names: readonly string[]): string {
  const name = names.length > 1 ? tn("{count} file", "{count} files", names.length) : names[0] ?? t("file");
  return t("Uploading {name}", { name });
}

/** The drop in a few words: "relazione.pdf", or "relazione.pdf +2" for several. */
export function dropName(names: readonly string[]): string {
  if (names.length === 0) return t("file");
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
}
