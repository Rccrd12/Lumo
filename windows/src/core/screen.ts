// The chat's screen button — the island's side of screen.rs. Pure helpers, so
// they can be tested without a webview: the menu's entries, what is waiting to
// go with the next question, and the payload chat_send takes.
//
// Nothing is captured until the user clicks an entry; a screenshot is shown
// first and only joins the chat on "Send". What was added goes with one
// question, then the chat forgets it.
//
// "Open windows" and "Browser tabs" (Edge, Chrome) open a second list: one
// window or tab, or all of them. Each goes with what it shows — a window's
// text, a tab's page (share.rs) — and a single window also with a picture of
// it, for the providers that see images. "Browser tabs" shows only when a
// browser has tabs open.
//
// "Folder open in File Explorer" shares that folder's listing (explorer.rs);
// the menu only asks its name, and shows it only when a folder is open. A file the question names is then attached
// from it, as with the paperclip (views/chat.ts).
//
// "Always share the folder open in File Explorer" (Settings → Chat, off by
// default) does the same for every message: the folder's name shows in the
// attachments while the user types, its listing is taken when the message
// goes, and its × leaves it out of that one message.
//
// What waits is listed one item each (screenItems): two screenshots of the
// same screen, two windows or two selections are two rows, each with its own
// × and its own preview.

import type {
  BrowserTab, DroppedFile, ExplorerFolder, OpenWindow, ScreenContext, ScreenDisplay, ScreenShot, SelectedText,
  SharedWindow,
} from "./bridge";
import type { ProviderDef } from "./providers";
import { N_, t } from "../i18n/i18n";

export const SCREEN_STRINGS = {
  button: N_("Share your screen or open windows"),
  title: N_("Share with the chat"),
  windows: N_("Open windows"),
  allWindows: N_("All windows"),
  tabs: N_("Browser tabs"),
  allTabs: N_("All tabs"),
  back: N_("Back"),
  reading: N_("Reading what it shows…"),
  noWindows: N_("No window is open."),
  minimized: N_("minimized"),
  screen: N_("Screen {number}"),
  allScreens: N_("All screens"),
  nothingYet: N_("Nothing is captured until you pick one."),
  capturing: N_("Taking the screenshot…"),
  confirm: N_("Send this to the chat?"),
  needsImages: N_("Screenshots need the Claude Code or Anthropic provider."),
  remove: N_("Remove"),
  selected: N_("Selected text"),
  selectedIn: N_("Text from {app}"),
  explorer: N_("Folder open in File Explorer"),
  noExplorer: N_("No folder is open in File Explorer."),
};

/** How much of the selected text the item's tooltip shows. */
const SELECTION_PREVIEW = 400;
/** How much of it shows under its name, on one line. */
const SELECTION_LINE = 120;
/** A window's title as a screenshot's name, at most. */
const CHIP_TITLE = 32;

/** `text` cut to `max` characters, with "…" when it was longer. */
export function short(text: string, max = CHIP_TITLE): string {
  const chars = [...text.trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** What the menu learned about File Explorer: the folder's name, or why there is none. */
export interface ExplorerPeek {
  folder: ExplorerFolder | null;
  /** The error, if any; "" otherwise. */
  problem: string;
}

export type MenuEntry =
  | { kind: "windows" }
  | { kind: "tabs"; count: number }
  | { kind: "display"; index: number; width: number; height: number }
  | { kind: "all" }
  | { kind: "explorer"; folder: ExplorerFolder };

/**
 * "Open windows", "Browser tabs" when a browser has some open, one entry per
 * display, "All screens" when there are several, then the folder open in File
 * Explorer — only when one is.
 */
export function menuEntries(displays: ScreenDisplay[], explorer?: ExplorerPeek, tabs?: BrowserTab[]): MenuEntry[] {
  const out: MenuEntry[] = [{ kind: "windows" }];
  if (tabs && tabs.length > 0) out.push({ kind: "tabs", count: tabs.length });
  for (const d of displays) out.push({ kind: "display", index: d.index, width: d.width, height: d.height });
  if (displays.length > 1) out.push({ kind: "all" });
  if (explorer && !explorer.problem && explorer.folder) out.push({ kind: "explorer", folder: explorer.folder });
  return out;
}

/** One row of the second list: everything, or one window or tab. */
export interface PickEntry {
  /** null: all of them. */
  id: number | string | null;
  label: string;
  detail: string;
  title: string;
}

/** "All windows", then each window, front to back. */
export function windowPicks(list: OpenWindow[]): PickEntry[] {
  if (list.length === 0) return [];
  const all: PickEntry = { id: null, label: t(SCREEN_STRINGS.allWindows), detail: String(list.length), title: "" };
  return [all, ...list.map((w) => ({
    id: w.id ?? 0,
    label: w.title,
    detail: w.minimized ? `${w.app} · ${t(SCREEN_STRINGS.minimized)}` : w.app,
    title: w.app ? `${w.title} — ${w.app}` : w.title,
  }))];
}

/** "All tabs", then each tab, browser by browser. */
export function tabPicks(list: BrowserTab[]): PickEntry[] {
  if (list.length === 0) return [];
  const browsers = new Set(list.map((tab) => tab.browser));
  const all: PickEntry = { id: null, label: t(SCREEN_STRINGS.allTabs), detail: String(list.length), title: "" };
  return [all, ...list.map((tab) => {
    const host = hostOf(tab.url);
    return {
      id: tab.id,
      label: tab.title || tab.url,
      // The browser too, when both have tabs open (alone, when the address isn't known yet).
      detail: browsers.size > 1 ? [host, tab.browser].filter(Boolean).join(" · ") : host,
      title: tabTooltip(tab, "\n"),
    };
  })];
}

/** A tab's title and, when known, its address. */
function tabTooltip(tab: BrowserTab, between: string): string {
  return tab.url ? `${tab.title}${between}${tab.url}` : tab.title;
}

/** "github.com" for an address; the address itself when it has no host. */
export function hostOf(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host || url;
  } catch {
    return url;
  }
}

/** `next` added to `list`: one already there (same title and app) is replaced. */
export function withWindows(list: SharedWindow[], next: SharedWindow[]): SharedWindow[] {
  const fresh = new Set(next.map(windowKey));
  return [...list.filter((w) => !fresh.has(windowKey(w))), ...next];
}

/** `next` added to `list`: the same tab is replaced. */
export function withTabs(list: BrowserTab[], next: BrowserTab[]): BrowserTab[] {
  const fresh = new Set(next.map((tab) => tab.id));
  return [...list.filter((tab) => !fresh.has(tab.id)), ...next];
}

/** "Screen 1", "Screen 2"… for the display at `index` (from 0). */
export function screenLabel(index: number): string {
  return t(SCREEN_STRINGS.screen, { number: index + 1 });
}

export function entryLabel(entry: MenuEntry): string {
  switch (entry.kind) {
    case "windows":
      return t(SCREEN_STRINGS.windows);
    case "tabs":
      return t(SCREEN_STRINGS.tabs);
    case "display":
      return screenLabel(entry.index);
    case "all":
      return t(SCREEN_STRINGS.allScreens);
    case "explorer":
      return t(SCREEN_STRINGS.explorer);
  }
}

/**
 * Who can look at a screenshot: Claude Code reads it from the inbox, the
 * Anthropic API and the cloud providers take it as an image. The local model
 * servers get text only (chat.rs says the same).
 */
export function seesImages(provider: ProviderDef): boolean {
  return provider.urlField === null;
}

/** A screenshot the user kept, waiting for the next question. */
export interface KeptShot {
  name: string;
  path: string;
  preview: string;
}

/** What the screen button or the shortcuts added, sent with the next question only. */
export interface PendingScreen {
  /** Windows picked in the menu, with what they show. */
  windows: SharedWindow[];
  /** Browser tabs picked in the menu, with their pages' text. */
  tabs: BrowserTab[];
  shots: KeptShot[];
  /** Text selected in another app ("Ask about the selected text"). */
  selection?: SelectedText | null;
  /** More text selected and shared after `selection`, in order. */
  selections?: SelectedText[];
  /** The folder open in File Explorer, with what is in it. */
  folder?: ExplorerFolder | null;
  /**
   * "Always share the folder open in File Explorer": the folder found there
   * (its name only), shown in the attachments until the message goes with its listing.
   */
  autoFolder?: ExplorerFolder | null;
  /** Its × was pressed: this message goes without the folder. */
  autoOff?: boolean;
}

export function emptyScreen(): PendingScreen {
  return { windows: [], tabs: [], shots: [], selection: null, selections: [], folder: null, autoFolder: null, autoOff: false };
}

/** After a message (or a new chat): nothing waits, the folder that rides along by itself stays. */
export function nextScreen(p: PendingScreen): PendingScreen {
  return { ...emptyScreen(), autoFolder: p.autoFolder ?? null };
}

/**
 * After a message went with `sent`: what waits now in `now`. The same, the
 * next message starts empty; changed meanwhile (the folder in File Explorer
 * asked again while the answer was coming, a screenshot added), only what
 * went is taken out. Rust deletes the screenshots that went, so one left
 * waiting would make the next message fail.
 */
export function afterSent(now: PendingScreen, sent: PendingScreen): PendingScreen {
  if (now === sent) return nextScreen(now);
  let rest: PendingScreen = { ...now, autoOff: false };
  for (const item of screenItems(sent)) if (item.kind !== "folder") rest = withoutItem(rest, item);
  if (sent.folder && rest.folder?.path === sent.folder.path) rest = { ...rest, folder: null };
  return rest;
}

/** The folder's ×: the shared folder goes, and so does the automatic one, for this message. */
export function withoutFolder(p: PendingScreen): PendingScreen {
  return { ...p, folder: null, autoOff: true };
}

/**
 * True when this message should take the folder open in File Explorer by
 * itself: the setting is on, the menu did not already share one, and its ×
 * was not pressed.
 */
export function sharesFolderByItself(p: PendingScreen, settingOn: boolean): boolean {
  return settingOn && !p.folder && !p.autoOff;
}

export function hasScreen(p: PendingScreen, files: readonly { name: string; path: string }[] = []): boolean {
  return p.windows.length > 0 || p.tabs.length > 0 || p.shots.length > 0 || !!p.selection || !!p.folder ||
    (p.selections?.length ?? 0) > 0 || files.length > 0;
}

/** Every selected text waiting, the first one first. */
export function allSelections(p: PendingScreen): SelectedText[] {
  return [...(p.selection ? [p.selection] : []), ...(p.selections ?? [])];
}

/** A selection joins the ones waiting (the same text twice only once). */
export function withSelection(p: PendingScreen, sel: SelectedText): PendingScreen {
  if (!p.selection) return { ...p, selection: sel };
  if (allSelections(p).some((s) => s.text === sel.text)) return p;
  return { ...p, selections: [...(p.selections ?? []), sel] };
}

/**
 * The previewed screenshots join what is waiting, named after their screen;
 * a second shot of the same screen is "Screen 1 (2)".
 */
export function keepShots(p: PendingScreen, shots: ScreenShot[]): PendingScreen {
  const taken = new Set(p.shots.map((s) => s.name));
  const kept = shots.map((s) => {
    const base = screenLabel(s.display);
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base} (${i})`;
    taken.add(name);
    return { name, path: s.path, preview: s.preview };
  });
  return { ...p, shots: [...p.shots, ...kept] };
}

/** What chat_send takes, or null when nothing is waiting. `files`: the files added after the first. */
export function screenPayload(p: PendingScreen, files: readonly { name: string; path: string }[] = []): ScreenContext | null {
  if (!hasScreen(p, files)) return null;
  const out: ScreenContext = {
    windows: [],
    shots: p.shots.map((s) => ({ name: s.name, path: s.path })),
  };
  if (p.selection) out.selection = p.selection;
  if (p.selections?.length) out.selections = p.selections;
  if (files.length) out.files = files.map((f) => ({ name: f.name, path: f.path }));
  if (p.folder) out.folder = p.folder;
  if (p.windows.length > 0) out.sharedWindows = p.windows;
  if (p.tabs.length > 0) out.tabs = p.tabs;
  return out;
}

/** What kind of thing waits for the next question: each one is a row of its own in the attachments. */
export type ItemKind = "shot" | "window" | "tab" | "selection" | "folder";

/** One thing the screen button or a shortcut added, as the attachments list it. */
export interface ScreenItem {
  kind: ItemKind;
  /** Which one of its kind: a screenshot's path, a window's app and title, a tab's id, a selection's text, the folder's path. */
  key: string;
  label: string;
  /** Under the name: what it is, and where it comes from. */
  detail: string;
  /** The tooltip: the whole title, the text, the path. */
  title: string;
  /** A screenshot's preview, shown small. */
  thumb?: string;
}

export const ITEM_STRINGS = {
  file: N_("File"),
  shot: N_("Screenshot"),
  window: N_("Window"),
  tab: N_("Web page"),
  folder: N_("Folder"),
};

/** Same app and title: the same window (picking it again replaces it). */
function windowKey(w: { app: string; title: string }): string {
  return `${w.app}\u0000${w.title}`;
}

/** "Window · Code": the kind, then where it comes from when it is known. */
function kindLine(kind: string, from = ""): string {
  return [t(kind), from.trim()].filter(Boolean).join(" · ");
}

/** The text on one line, as the attachments show it under its name. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Everything waiting, one item each — every screenshot, window, tab and
 * selection on its own, so its × takes back that one only — then the folder.
 */
export function screenItems(p: PendingScreen): ScreenItem[] {
  const out: ScreenItem[] = [];
  for (const sel of allSelections(p)) {
    out.push({
      kind: "selection",
      key: sel.text,
      label: sel.app ? t(SCREEN_STRINGS.selectedIn, { app: sel.app }) : t(SCREEN_STRINGS.selected),
      detail: short(oneLine(sel.text), SELECTION_LINE),
      title: sel.text.length > SELECTION_PREVIEW ? `${sel.text.slice(0, SELECTION_PREVIEW)}…` : sel.text,
    });
  }
  for (const w of p.windows) {
    out.push({
      kind: "window",
      key: windowKey(w),
      label: w.title.trim() || w.app,
      detail: kindLine(ITEM_STRINGS.window, w.app),
      title: windowTooltip(w),
    });
  }
  for (const tab of p.tabs) {
    out.push({
      kind: "tab",
      key: tab.id,
      label: tab.title.trim() || hostOf(tab.url) || tab.browser,
      detail: kindLine(ITEM_STRINGS.tab, tab.url ? hostOf(tab.url) : tab.browser),
      title: tabTooltip(tab, " — "),
    });
  }
  for (const s of p.shots) {
    out.push({ kind: "shot", key: s.path, label: s.name, detail: t(ITEM_STRINGS.shot), title: s.name, thumb: s.preview });
  }
  const folder = p.folder ?? (p.autoOff ? null : p.autoFolder);
  if (folder) out.push({ kind: "folder", key: folder.path, label: folder.name, detail: kindLine(ITEM_STRINGS.folder, folder.path), title: folder.path });
  return out;
}

/**
 * `item` taken back, the rest still waiting. A screenshot's file is the
 * caller's to delete (its path is the item's key).
 */
export function withoutItem(p: PendingScreen, item: Pick<ScreenItem, "kind" | "key">): PendingScreen {
  switch (item.kind) {
    case "shot":
      return { ...p, shots: p.shots.filter((s) => s.path !== item.key) };
    case "window":
      return { ...p, windows: p.windows.filter((w) => windowKey(w) !== item.key) };
    case "tab":
      return { ...p, tabs: p.tabs.filter((tab) => tab.id !== item.key) };
    case "selection": {
      const rest = allSelections(p).filter((sel) => sel.text !== item.key);
      return { ...p, selection: rest[0] ?? null, selections: rest.slice(1) };
    }
    case "folder":
      return withoutFolder(p);
  }
}

/** A window's tooltip: its title and its app. */
function windowTooltip(w: { title: string; app: string }): string {
  return w.app ? `${w.title} — ${w.app}` : w.title;
}

// ── What an attachment sends, before it is sent ──────────────────────────────
//
// A click on an attachment shows exactly what goes with the question: the
// picture, the text read from a window or a tab, the selected text, the
// folder's listing, a file's name (and the picture, when it is one).

export const PREVIEW_STRINGS = {
  title: N_("What goes with your question"),
  close: N_("Close"),
  readInBrowser: N_("Read in the browser, with your login."),
  downloaded: N_("Downloaded from its address, without your login."),
  tabUnread: N_("Nothing could be read from this page: only its title goes."),
  windowUnread: N_("No text could be read from this window: only its title goes."),
  cut: N_("Cut to fit: it shows more than this."),
  document: N_("Document on disk: {path}"),
  folderLater: N_("Its listing is read when you send."),
  omitted: N_("Items not listed: {count}"),
};

/** One thing that goes with the question, as the preview shows it. */
export interface PreviewBlock {
  heading: string;
  /** Where it comes from: an app, an address, a path; "" for none. */
  detail: string;
  /** How it was read, or what is missing; "" for none. */
  note: string;
  /** The text that goes; "" for none. */
  text: string;
  /** A picture (data URL); "" for none. */
  image: string;
}

const block = (over: Partial<PreviewBlock>): PreviewBlock => ({ heading: "", detail: "", note: "", text: "", image: "", ...over });

/** "1.5 KB", "3.2 MB": a file's size, short. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** What `item` sends, as it will go; nothing once it is no longer waiting. */
export function itemPreview(p: PendingScreen, item: Pick<ScreenItem, "kind" | "key">): PreviewBlock[] {
  switch (item.kind) {
    case "shot":
      return p.shots.filter((s) => s.path === item.key).map((s) => block({ heading: s.name, image: s.preview }));
    case "selection":
      return allSelections(p).filter((sel) => sel.text === item.key).map((sel) => block({
        heading: sel.app ? t(SCREEN_STRINGS.selectedIn, { app: sel.app }) : t(SCREEN_STRINGS.selected),
        detail: sel.title,
        text: sel.text,
      }));
    case "window":
      return p.windows.filter((w) => windowKey(w) === item.key).map((w) => block({
        heading: w.title,
        detail: [w.app, w.document ? t(PREVIEW_STRINGS.document, { path: w.document }) : ""].filter(Boolean).join(" · "),
        note: !w.text.trim() ? t(PREVIEW_STRINGS.windowUnread) : w.cut ? t(PREVIEW_STRINGS.cut) : "",
        text: w.text,
      }));
    case "tab":
      return p.tabs.filter((tab) => tab.id === item.key).map((tab) => {
        const how = !tab.text.trim() ? t(PREVIEW_STRINGS.tabUnread)
          : tab.source === "web" ? t(PREVIEW_STRINGS.downloaded)
          : t(PREVIEW_STRINGS.readInBrowser);
        return block({
          heading: tab.title || tab.url,
          detail: [tab.url, tab.browser].filter(Boolean).join(" · "),
          note: tab.text.trim() && tab.cut ? `${how} ${t(PREVIEW_STRINGS.cut)}` : how,
          text: tab.text,
        });
      });
    case "folder": {
      const folder = p.folder ?? (p.autoOff ? null : p.autoFolder);
      if (!folder) return [];
      // The folder that rides along by itself is listed only when the message goes.
      if (!p.folder) return [block({ heading: folder.name, detail: folder.path, note: t(PREVIEW_STRINGS.folderLater) })];
      const lines = folder.entries.map((e) => (e.dir ? `${e.name}/` : `${e.name} — ${formatSize(e.size)}`));
      return [block({
        heading: folder.name,
        detail: folder.path,
        note: folder.omitted > 0 ? t(PREVIEW_STRINGS.omitted, { count: folder.omitted }) : "",
        text: lines.join("\n"),
      })];
    }
  }
}

/** A file dropped, pasted or picked: its name, where it is, and its picture when it is one. */
export function filePreview(file: Pick<DroppedFile, "name" | "path"> & { size?: number }, image = ""): PreviewBlock[] {
  return [block({ heading: file.name, detail: file.path, note: file.size == null ? "" : formatSize(file.size), image })];
}

/** The paths of the screenshots waiting, for deleting the ones never sent. */
export function shotPaths(p: PendingScreen): string[] {
  return p.shots.map((s) => s.path);
}
