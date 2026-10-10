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
// default) does the same for every message: the folder's name shows as a chip
// while the user types, its listing is taken when the message goes, and the
// chip's × leaves it out of that one message.

import type {
  BrowserTab, ExplorerFolder, OpenWindow, ScreenContext, ScreenDisplay, ScreenShot, SelectedText, SharedWindow,
} from "./bridge";
import type { ProviderDef } from "./providers";
import { N_, t } from "../i18n/i18n";

export const SCREEN_STRINGS = {
  button: N_("Share your screen or open windows"),
  title: N_("Share with the chat"),
  windows: N_("Open windows"),
  windowsCount: N_("Open windows ({count})"),
  allWindows: N_("All windows"),
  tabs: N_("Browser tabs"),
  tabsCount: N_("Browser tabs ({count})"),
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

/** How much of the selected text the chip's tooltip shows. */
const SELECTION_PREVIEW = 400;
/** A window's or a tab's title on a chip, at most (the tooltip has it whole). */
const CHIP_TITLE = 32;

/** `text` cut to `max` characters, with "…" when it was longer. */
export function short(text: string, max = CHIP_TITLE): string {
  const chars = [...text.trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** What the menu learned about File Explorer: the folder's name, or why there is none. */
export interface ExplorerPeek {
  folder: ExplorerFolder | null;
  /** The error, on Linux for one; "" otherwise. */
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
      // The browser too, when both have tabs open.
      detail: browsers.size > 1 ? `${host} · ${tab.browser}` : host,
      title: `${tab.title}\n${tab.url}`,
    };
  })];
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
  const key = (w: SharedWindow) => `${w.app}\u0000${w.title}`;
  const fresh = new Set(next.map(key));
  return [...list.filter((w) => !fresh.has(key(w))), ...next];
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
  /** The folder open in File Explorer, with what is in it. */
  folder?: ExplorerFolder | null;
  /**
   * "Always share the folder open in File Explorer": the folder found there
   * (its name only), shown as a chip until the message goes with its listing.
   */
  autoFolder?: ExplorerFolder | null;
  /** That chip was taken off: this message goes without the folder. */
  autoOff?: boolean;
}

export function emptyScreen(): PendingScreen {
  return { windows: [], tabs: [], shots: [], selection: null, folder: null, autoFolder: null, autoOff: false };
}

/** After a message (or a new chat): nothing waits, the folder that rides along by itself stays. */
export function nextScreen(p: PendingScreen): PendingScreen {
  return { ...emptyScreen(), autoFolder: p.autoFolder ?? null };
}

/** The folder chip's ×: the shared folder goes, and so does the automatic one, for this message. */
export function withoutFolder(p: PendingScreen): PendingScreen {
  return { ...p, folder: null, autoOff: true };
}

/**
 * True when this message should take the folder open in File Explorer by
 * itself: the setting is on, the menu did not already share one, and its chip
 * was not taken off.
 */
export function sharesFolderByItself(p: PendingScreen, settingOn: boolean): boolean {
  return settingOn && !p.folder && !p.autoOff;
}

export function hasScreen(p: PendingScreen): boolean {
  return p.windows.length > 0 || p.tabs.length > 0 || p.shots.length > 0 || !!p.selection || !!p.folder;
}

/** The previewed screenshots join what is waiting, named after their screen. */
export function keepShots(p: PendingScreen, shots: ScreenShot[]): PendingScreen {
  const kept = shots.map((s) => ({ name: screenLabel(s.display), path: s.path, preview: s.preview }));
  return { ...p, shots: [...p.shots, ...kept] };
}

/** What chat_send takes, or null when nothing is waiting. */
export function screenPayload(p: PendingScreen): ScreenContext | null {
  if (!hasScreen(p)) return null;
  const out: ScreenContext = {
    windows: [],
    shots: p.shots.map((s) => ({ name: s.name, path: s.path })),
  };
  if (p.selection) out.selection = p.selection;
  if (p.folder) out.folder = p.folder;
  if (p.windows.length > 0) out.sharedWindows = p.windows;
  if (p.tabs.length > 0) out.tabs = p.tabs;
  return out;
}

export type ChipKind = "windows" | "tabs" | "shots" | "selection" | "folder";

export interface ScreenChipInfo {
  kind: ChipKind;
  label: string;
  title: string;
  /** The screenshots' previews, shown small on the chip. */
  thumbs?: string[];
}

/** The chips above the chat: the window list, and the screenshots together. */
export function screenChips(p: PendingScreen): ScreenChipInfo[] {
  const out: ScreenChipInfo[] = [];
  if (p.selection) {
    const { text, app } = p.selection;
    out.push({
      kind: "selection",
      label: app ? t(SCREEN_STRINGS.selectedIn, { app }) : t(SCREEN_STRINGS.selected),
      title: text.length > SELECTION_PREVIEW ? `${text.slice(0, SELECTION_PREVIEW)}…` : text,
    });
  }
  if (p.windows.length > 0) {
    out.push({
      kind: "windows",
      label: p.windows.length === 1 ? short(p.windows[0].title) : t(SCREEN_STRINGS.windowsCount, { count: p.windows.length }),
      title: windowsTooltip(p.windows),
    });
  }
  if (p.tabs.length > 0) {
    out.push({
      kind: "tabs",
      label: p.tabs.length === 1 ? short(p.tabs[0].title || hostOf(p.tabs[0].url)) : t(SCREEN_STRINGS.tabsCount, { count: p.tabs.length }),
      title: p.tabs.map((tab) => `${tab.title} — ${tab.url}`).join("\n"),
    });
  }
  if (p.shots.length > 0) {
    const names = p.shots.map((s) => s.name).join(", ");
    out.push({ kind: "shots", label: names, title: names, thumbs: p.shots.map((s) => s.preview) });
  }
  const folder = p.folder ?? (p.autoOff ? null : p.autoFolder);
  if (folder) out.push({ kind: "folder", label: folder.name, title: folder.path });
  return out;
}

/** The list on the chip's tooltip, so the user sees exactly what will be sent. */
export function windowsTooltip(list: { title: string; app: string }[]): string {
  return list.map((w) => (w.app ? `${w.title} — ${w.app}` : w.title)).join("\n");
}

/** The paths of the screenshots waiting, for deleting the ones never sent. */
export function shotPaths(p: PendingScreen): string[] {
  return p.shots.map((s) => s.path);
}
