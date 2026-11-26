// What went with a question: the files, screenshots, windows, tabs, folders
// and selected text it took. Kept with the question (ChatMessage.sent, saved
// with the chat) so its bubble shows them as small icons, and so that editing
// it, or retrying it, sends them again (views/chat.ts). Pure helpers, so they
// can be tested without a webview.
//
// A question's bubble shows one icon for each kind of thing it took, a count
// beside it for more than one, and a picture's own small picture. A click
// lists them, each opening what it was.
//
// Editing a question puts back in the attachments what went with it, as it
// went: in this run of Lumo, from what was kept in memory (`resend`); in a
// chat opened again, from what the chat kept — the files and screenshots
// still on disk, and the selected text. A window, a tab or a folder showed
// what it showed at the time, which is kept only in memory: in a chat opened
// again it can't come back. What can't come back, and what went with the
// questions after it, leaves the chat's context: the chat says so first.

import { allSelections, emptyScreen, screenItems, type ItemKind, type KeptShot, type PendingScreen } from "./screen";
import type { SelectedText } from "./bridge";

export type SentKind = ItemKind | "file";

/** One thing that went with a question, as its bubble and the list under it show it. */
export interface SentItem {
  kind: SentKind;
  /** Its name ("plan.pdf", "Screen 1", "Text from Code"). */
  label: string;
  /** Under the name: what it is, and where it comes from. */
  detail: string;
  /** The tooltip: the whole title, the path. */
  title: string;
  /** Which one of its kind (screen.ts ScreenItem key; a file's path). */
  key: string;
  /** A file or a screenshot: where it is (opened from the list, sent again on Edit). */
  path?: string;
  /** Selected text: the text, the app and its window, to send again on Edit. */
  text?: string;
  app?: string;
  window?: string;
  /** A small picture of it (a data URL), for a screenshot or a picture file. */
  thumb?: string;
}

/** What went with a question, as it went: in memory only, so Edit sends exactly that again. */
export interface SentAgain {
  screen: PendingScreen;
  files: { name: string; path: string }[];
}

/** The files a picture shows for. */
export const PICTURE_NAME = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** How big the small picture kept with a question is, on its long edge (page px). */
export const THUMB_EDGE = 64;
/** A small picture longer than this (a data URL) is not kept with the chat. */
export const MAX_THUMB = 16_000;
/** Selected text longer than this is not kept with the chat (it still goes again while Lumo runs). */
export const MAX_KEPT_TEXT = 20_000;

/**
 * What went with a question: its files (`fileDetail` says what each is), then
 * what came from the computer, one each, as the attachments listed them.
 */
export function sentItems(
  screen: PendingScreen,
  files: readonly { name: string; path: string }[],
  fileDetail: (f: { name: string }) => string,
): SentItem[] {
  // Only what went: what rides along by itself and was left out is not in `screen` any more.
  const went: PendingScreen = { ...screen, autoFolders: [], autoTabs: [], autoSkip: [] };
  const out: SentItem[] = files.map((f) => ({ kind: "file", label: f.name, detail: fileDetail(f), title: f.path, key: f.path, path: f.path }));
  const selections = allSelections(went);
  for (const item of screenItems(went)) {
    const one: SentItem = { kind: item.kind, label: item.label, detail: item.detail, title: item.title, key: item.key };
    if (item.kind === "shot") one.path = item.key;
    if (item.kind === "selection") {
      const sel = selections.find((s) => s.text === item.key);
      if (sel) {
        one.text = sel.text;
        if (sel.app) one.app = sel.app;
        if (sel.title) one.window = sel.title;
      }
    }
    out.push(one);
  }
  return out;
}

/** What went, as it went, to send again (only what the user shared: what rides along by itself is read again). */
/**
 * What went with a question, its files and screenshots moved (old path →
 * new, files.rs adopt): null when none of them did.
 */
export function movedSent(items: readonly SentItem[], moved: ReadonlyMap<string, string>): SentItem[] | null {
  let changed = false;
  const out = items.map((i) => {
    const to = i.path != null ? moved.get(i.path) : undefined;
    if (to == null || i.path == null) return i;
    changed = true;
    return { ...i, path: to, key: i.key === i.path ? to : i.key, title: i.title === i.path ? to : i.title };
  });
  return changed ? out : null;
}

export function sentAgain(screen: PendingScreen, files: readonly { name: string; path: string }[]): SentAgain {
  return {
    screen: { ...emptyScreen(), windows: screen.windows, tabs: screen.tabs, shots: screen.shots, selection: screen.selection ?? null, selections: screen.selections ?? [], folders: screen.folders ?? [] },
    files: files.map((f) => ({ name: f.name, path: f.path })),
  };
}

/** One icon of a bubble: a kind, the first of it, and how many went. */
export interface SentGroup {
  /** "picture" for picture files, else the kind. */
  key: SentKind | "picture";
  first: SentItem;
  count: number;
}

/** A picture file shows as a picture, apart from the other files. */
export function groupKey(item: SentItem): SentKind | "picture" {
  return item.kind === "file" && PICTURE_NAME.test(item.label) ? "picture" : item.kind;
}

/** The bubble's icons: one per kind, in the order they went, each with how many. */
export function sentGroups(items: readonly SentItem[]): SentGroup[] {
  const out: SentGroup[] = [];
  for (const item of items) {
    const key = groupKey(item);
    const group = out.find((g) => g.key === key);
    if (group) group.count++;
    else out.push({ key, first: item, count: 1 });
  }
  return out;
}

/**
 * What can come back on Edit: everything while Lumo kept it in memory; else
 * the files and screenshots still there (`present`, by path) and the
 * selected text the chat kept. `lost`: what can't.
 */
export function comingBack(
  items: readonly SentItem[],
  again: SentAgain | undefined,
  present: (path: string) => boolean,
): { back: SentItem[]; lost: SentItem[] } {
  const back: SentItem[] = [];
  const lost: SentItem[] = [];
  for (const item of items) {
    const can = item.path ? present(item.path)
      : again ? true
      : item.kind === "selection" && !!item.text;
    (can ? back : lost).push(item);
  }
  return { back, lost };
}

/**
 * What goes back in the attachments for `back`: the files, and the rest as
 * the screen button had added it, from `again` when Lumo still has it.
 */
export function restored(back: readonly SentItem[], again: SentAgain | undefined): { screen: PendingScreen; files: { name: string; path: string }[] } {
  const keys = new Set(back.map((i) => `${i.kind}\u0000${i.key}`));
  const has = (kind: SentKind, key: string) => keys.has(`${kind}\u0000${key}`);
  const files = back.filter((i) => i.kind === "file" && i.path).map((i) => ({ name: i.label, path: i.path ?? "" }));
  if (again) {
    const s = again.screen;
    const selections = allSelections(s).filter((sel) => has("selection", sel.text));
    return {
      files,
      screen: {
        ...emptyScreen(),
        shots: s.shots.filter((x) => has("shot", x.path)),
        windows: s.windows.filter((w) => has("window", `${w.app}\u0000${w.title}`)),
        tabs: s.tabs.filter((tab) => has("tab", tab.id)),
        folders: (s.folders ?? []).filter((f) => has("folder", f.path)),
        selection: selections[0] ?? null,
        selections: selections.slice(1),
      },
    };
  }
  const shots: KeptShot[] = back.filter((i) => i.kind === "shot" && i.path).map((i) => ({ name: i.label, path: i.path ?? "", preview: i.thumb ?? "" }));
  const selections: SelectedText[] = back.filter((i) => i.kind === "selection" && i.text).map((i) => ({ text: i.text ?? "", app: i.app ?? "", title: i.window ?? "" }));
  return { files, screen: { ...emptyScreen(), shots, selection: selections[0] ?? null, selections: selections.slice(1) } };
}

/** `extra` joins what waits: what is already there (same path, same text, same window) only once. */
export function joinScreen(now: PendingScreen, extra: PendingScreen): PendingScreen {
  const shots = new Set(now.shots.map((s) => s.path));
  const windows = new Set(now.windows.map((w) => `${w.app}\u0000${w.title}`));
  const tabs = new Set(now.tabs.map((tab) => tab.id));
  const folders = new Set((now.folders ?? []).map((f) => f.path));
  const texts = new Set(allSelections(now).map((s) => s.text));
  const selections = [...allSelections(now), ...allSelections(extra).filter((s) => !texts.has(s.text))];
  return {
    ...now,
    shots: [...now.shots, ...extra.shots.filter((s) => !shots.has(s.path))],
    windows: [...now.windows, ...extra.windows.filter((w) => !windows.has(`${w.app}\u0000${w.title}`))],
    tabs: [...now.tabs, ...extra.tabs.filter((tab) => !tabs.has(tab.id))],
    folders: [...(now.folders ?? []), ...(extra.folders ?? []).filter((f) => !folders.has(f.path))],
    selection: selections[0] ?? null,
    selections: selections.slice(1),
  };
}

/** `extra` taken back out of what waits (Edit given up): whatever else was added stays. */
export function leaveScreen(now: PendingScreen, extra: PendingScreen): PendingScreen {
  const shots = new Set(extra.shots.map((s) => s.path));
  const windows = new Set(extra.windows.map((w) => `${w.app}\u0000${w.title}`));
  const tabs = new Set(extra.tabs.map((tab) => tab.id));
  const folders = new Set((extra.folders ?? []).map((f) => f.path));
  const texts = new Set(allSelections(extra).map((s) => s.text));
  const selections = allSelections(now).filter((s) => !texts.has(s.text));
  return {
    ...now,
    shots: now.shots.filter((s) => !shots.has(s.path)),
    windows: now.windows.filter((w) => !windows.has(`${w.app}\u0000${w.title}`)),
    tabs: now.tabs.filter((tab) => !tabs.has(tab.id)),
    folders: (now.folders ?? []).filter((f) => !folders.has(f.path)),
    selection: selections[0] ?? null,
    selections: selections.slice(1),
  };
}

/** What the chat keeps of them: no text past MAX_KEPT_TEXT, no picture past MAX_THUMB. */
export function keptItems(items: readonly SentItem[]): SentItem[] {
  return items.map((i) => {
    const out: SentItem = { ...i };
    if (out.text != null && out.text.length > MAX_KEPT_TEXT) delete out.text;
    // A selection's key is its whole text: past the limit it goes with it.
    if (out.kind === "selection" && out.key.length > MAX_KEPT_TEXT) out.key = "";
    if (out.thumb != null && out.thumb.length > MAX_THUMB) delete out.thumb;
    return out;
  });
}

const KINDS: readonly SentKind[] = ["file", "shot", "window", "tab", "selection", "folder"];

/** What a saved chat says went with a question, or undefined for nothing (or nothing readable). */
export function readSent(raw: unknown): SentItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const out: SentItem[] = [];
  for (const x of raw as Record<string, unknown>[]) {
    if (!x || typeof x !== "object" || !KINDS.includes(x.kind as SentKind)) continue;
    const label = str(x.label);
    if (label == null) continue;
    const item: SentItem = { kind: x.kind as SentKind, label, detail: str(x.detail) ?? "", title: str(x.title) ?? "", key: str(x.key) ?? "" };
    for (const k of ["path", "text", "app", "window"] as const) {
      const v = str(x[k]);
      if (v != null) item[k] = v;
    }
    const thumb = str(x.thumb);
    if (thumb && thumb.startsWith("data:image/")) item.thumb = thumb;
    out.push(item);
  }
  return out.length ? out : undefined;
}
