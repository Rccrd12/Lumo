// The chat's screen button — the island's side of screen.rs. Pure helpers, so
// they can be tested without a webview: the menu's entries, what is waiting to
// go with the next question, and the payload chat_send takes.
//
// Nothing is listed or captured until the user clicks an entry; a screenshot
// is shown first and only joins the chat on "Send". What was added goes with
// one question, then the chat forgets it.
//
// "Folder open in File Explorer" shares that folder's listing (explorer.rs);
// the menu only asks its name. A file the question names is then attached
// from it, as with the paperclip (views/chat.ts).

import type { ExplorerFolder, OpenWindow, ScreenContext, ScreenDisplay, ScreenShot, SelectedText } from "./bridge";
import type { ProviderDef } from "./providers";
import { N_, t } from "../i18n/i18n";

export const SCREEN_STRINGS = {
  button: N_("Share your screen or open windows"),
  title: N_("Share with the chat"),
  windows: N_("Open windows"),
  windowsCount: N_("Open windows ({count})"),
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

/** What the menu learned about File Explorer: the folder's name, or why there is none. */
export interface ExplorerPeek {
  folder: ExplorerFolder | null;
  /** The error, on Linux for one; "" otherwise. */
  problem: string;
}

export type MenuEntry =
  | { kind: "windows" }
  | { kind: "display"; index: number; width: number; height: number }
  | { kind: "all" }
  | { kind: "explorer"; folder: ExplorerFolder | null; reason: string };

/**
 * "Open windows", one entry per display, "All screens" when there are several,
 * then the folder open in File Explorer when the menu asked for it.
 */
export function menuEntries(displays: ScreenDisplay[], explorer?: ExplorerPeek): MenuEntry[] {
  const out: MenuEntry[] = [{ kind: "windows" }];
  for (const d of displays) out.push({ kind: "display", index: d.index, width: d.width, height: d.height });
  if (displays.length > 1) out.push({ kind: "all" });
  if (explorer) {
    const folder = explorer.problem ? null : explorer.folder;
    out.push({ kind: "explorer", folder, reason: explorer.problem || (folder ? "" : t(SCREEN_STRINGS.noExplorer)) });
  }
  return out;
}

/** "Screen 1", "Screen 2"… for the display at `index` (from 0). */
export function screenLabel(index: number): string {
  return t(SCREEN_STRINGS.screen, { number: index + 1 });
}

export function entryLabel(entry: MenuEntry): string {
  switch (entry.kind) {
    case "windows":
      return t(SCREEN_STRINGS.windows);
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
  windows: OpenWindow[] | null;
  shots: KeptShot[];
  /** Text selected in another app ("Ask about the selected text"). */
  selection?: SelectedText | null;
  /** The folder open in File Explorer, with what is in it. */
  folder?: ExplorerFolder | null;
}

export function emptyScreen(): PendingScreen {
  return { windows: null, shots: [], selection: null, folder: null };
}

export function hasScreen(p: PendingScreen): boolean {
  return p.windows !== null || p.shots.length > 0 || !!p.selection || !!p.folder;
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
    windows: p.windows ?? [],
    shots: p.shots.map((s) => ({ name: s.name, path: s.path })),
  };
  if (p.selection) out.selection = p.selection;
  if (p.folder) out.folder = p.folder;
  return out;
}

export type ChipKind = "windows" | "shots" | "selection" | "folder";

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
  if (p.windows !== null) {
    out.push({
      kind: "windows",
      label: t(SCREEN_STRINGS.windowsCount, { count: p.windows.length }),
      title: windowsTooltip(p.windows),
    });
  }
  if (p.shots.length > 0) {
    const names = p.shots.map((s) => s.name).join(", ");
    out.push({ kind: "shots", label: names, title: names, thumbs: p.shots.map((s) => s.preview) });
  }
  if (p.folder) out.push({ kind: "folder", label: p.folder.name, title: p.folder.path });
  return out;
}

/** The list on the chip's tooltip, so the user sees exactly what will be sent. */
export function windowsTooltip(list: OpenWindow[]): string {
  return list.map((w) => (w.app ? `${w.title} — ${w.app}` : w.title)).join("\n");
}

/** The paths of the screenshots waiting, for deleting the ones never sent. */
export function shotPaths(p: PendingScreen): string[] {
  return p.shots.map((s) => s.path);
}
