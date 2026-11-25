// The files of an answer, to open (concepts/file-cliccabili-in-chat):
//
// - in its text, the names and paths of files and the links to them become a
//   small button with the file's icon (once Rust found them among the chat's
//   files and beside them, chat_files.rs chat_file_find);
// - under it, a card for each file it made or changed, up to MAX_CARDS; more
//   are one line that opens into a list, with Created and Edited apart.
//
// A click opens the file on the computer (a folder in File Explorer; a program
// or a script is only shown there, chat_files.rs); the right click has Open,
// Open file location, Open with, Copy file, Copy path and the chat's files.
// A file gone since says so and opens nothing.

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import type { MenuEntry } from "./context-menu";
import { ownMenu } from "./own-menu";
import { writeClipboard } from "./markdown";
import { Bridge } from "../core/bridge";
import { N_, t } from "../i18n/i18n";
import { STRINGS } from "./chat-strings";
import { CHAT_FILE_KINDS, PICTURE_FILE } from "./chat-attach";
import {
  MAX_CARDS, MAX_NAMES, baseName, folderOf, mainFolder, namesIn, replyCounts, wholeName,
  type ReplyFile, type ReplyFileKind,
} from "../core/file-names";

export const FILE_LINK_STRINGS = {
  openWith: N_("Open with…"),
  copyFile: N_("Copy file"),
  inChatFiles: N_("Show in the chat's files"),
  many: N_("{count} files from the AI"),
  created: N_("{count} created"),
  edited: N_("{count} edited"),
  folders: N_("in {count} folders"),
  all: N_("All"),
  createdChip: N_("Created"),
  editedChip: N_("Edited"),
  openFolder: N_("Open the folder"),
  hint: N_("Click to open · right click for more"),
};

/** What the chat lends: its files, and its panel of them. */
interface Host {
  /** The paths of the chat on screen's files (core/chat-files.ts). */
  known(): string[];
  /** The chat's files panel, open on its own list. */
  showChatFiles(): void;
}

let host: Host = { known: () => [], showChatFiles: () => {} };

export function setFileLinkHost(next: Host) {
  host = next;
}

/** A picture's small version, asked once per path. */
const pictures = new Map<string, Promise<string | null>>();

function picture(path: string): Promise<string | null> {
  let asked = pictures.get(path);
  if (!asked) {
    asked = Bridge.chatFilePreview(path).catch(() => null);
    pictures.set(path, asked);
  }
  return asked;
}

function fileIcon(path: string, folder: boolean, size: number): SVGSVGElement {
  if (folder) return svg(ICONS.folder, size, { stroke: 1.8 });
  if (PICTURE_FILE.test(path)) return svg(ICONS.photo, size, { stroke: 1.8 });
  return svg(ICONS.doc, size);
}

/** Its type, as the attachments say it: "PNG". */
function typeOf(path: string): string {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : "";
}

/** A file found gone: its button or card says so, and opens nothing more. */
function markGone(el: HTMLElement) {
  el.classList.add("missing");
  const detail = el.querySelector(".attach-detail");
  if (detail) detail.textContent = t(STRINGS.fileMissing);
}

async function openPath(path: string, el: HTMLElement) {
  if (el.classList.contains("missing")) return;
  const done = await Bridge.chatFileOpen(path).catch(() => "missing");
  if (done === "missing") markGone(el);
}

/** The right click on a file: what can be done with it. */
export function fileMenu(path: string, folder: boolean, el: HTMLElement): MenuEntry[] {
  const gone = el.classList.contains("missing");
  const entries: MenuEntry[] = [];
  if (!gone) {
    entries.push({ kind: "item", label: t(STRINGS.openFile), run: () => void openPath(path, el) });
    if (!folder) entries.push({ kind: "item", label: t(STRINGS.openLocation), run: () => void Bridge.chatFileReveal(path) });
    if (!folder) entries.push({ kind: "item", label: t(FILE_LINK_STRINGS.openWith), run: () => void Bridge.chatFileOpenWith(path) });
    entries.push({ kind: "sep" });
    entries.push({ kind: "item", label: t(FILE_LINK_STRINGS.copyFile), run: () => void Bridge.chatFileCopy(path) });
  } else {
    // Gone: where it was still shows.
    entries.push({ kind: "item", label: t(STRINGS.openLocation), run: () => void Bridge.chatFileReveal(path) });
    entries.push({ kind: "sep" });
  }
  entries.push({ kind: "item", label: t(STRINGS.copyPath), run: () => void writeClipboard(path) });
  entries.push({ kind: "sep" });
  entries.push({ kind: "item", label: t(FILE_LINK_STRINGS.inChatFiles), run: () => host.showChatFiles() });
  return entries;
}

/** Click, Enter and the right click on a file's element. */
function wire(el: HTMLElement, path: string, folder: boolean) {
  el.setAttribute("role", "button");
  el.tabIndex = 0;
  el.title = path;
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    void openPath(path, el);
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void openPath(path, el);
    }
  });
  ownMenu(el, () => fileMenu(path, folder, el));
}

// ── In the text ─────────────────────────────────────────────────────────────

/** What a name in the text is, until Rust says whether it is a file. */
type Spot =
  | { kind: "link"; el: HTMLElement; name: string }
  | { kind: "code"; el: HTMLElement; name: string }
  | { kind: "text"; node: Text; start: number; end: number; name: string };

/** Where names are never looked for: code blocks, links, formulas, the rich blocks. */
const SKIP = "pre, a, button, .md-pre, .md-file, .file-link, .katex, .md-math, [class^='rich'], [class*=' rich']";

function spotsIn(reply: HTMLElement): Spot[] {
  const spots: Spot[] = [];
  reply.querySelectorAll<HTMLElement>(".md-file").forEach((el) => {
    const name = el.dataset.file;
    if (name) spots.push({ kind: "link", el, name });
  });
  reply.querySelectorAll<HTMLElement>("code.md-code").forEach((el) => {
    if (el.parentElement?.closest(SKIP)) return;
    const name = wholeName(el.textContent ?? "");
    if (name) spots.push({ kind: "code", el, name });
  });
  const walk = (el: Element) => {
    if (el.matches(SKIP) || el.tagName === "CODE") return;
    for (const n of [...el.childNodes]) {
      if (n.nodeType === 3) {
        const node = n as Text;
        for (const at of namesIn(node.data)) spots.push({ kind: "text", node, start: at.start, end: at.end, name: at.name });
      } else if (n.nodeType === 1) {
        walk(n as Element);
      }
    }
  };
  walk(reply);
  return spots;
}

function linkButton(path: string, folder: boolean, label: Node[]): HTMLElement {
  const el = h("span", { class: "file-link" }, fileIcon(path, folder, 12), h("span", { class: "file-link-name" }, ...label));
  wire(el, path, folder);
  return el;
}

/** Which answer is being linked: a redraw started since wins. */
const linking = new WeakMap<HTMLElement, number>();
let linkRun = 0;

/**
 * The names of files in an answer's text, its links to them and its inline
 * code naming one, made buttons once Rust found them. Nothing waits on it:
 * the text shows at once, the buttons a moment later.
 */
export async function linkFiles(reply: HTMLElement): Promise<void> {
  try {
    await linkIn(reply);
  } catch {
    // A page that can't (an odd node): the text stays as it is.
  }
}

async function linkIn(reply: HTMLElement): Promise<void> {
  const spots = spotsIn(reply);
  if (!spots.length) return;
  const run = ++linkRun;
  linking.set(reply, run);
  const names = [...new Set(spots.map((s) => s.name))].slice(0, MAX_NAMES);
  let found: (FoundFileLike | null)[];
  try {
    found = (await Bridge.chatFileFind(names, host.known())) ?? [];
  } catch {
    return;
  }
  if (linking.get(reply) !== run || !reply.isConnected) return;
  const byName = new Map<string, FoundFileLike>();
  names.forEach((name, i) => {
    const f = found[i];
    if (f) byName.set(name, f);
  });
  // The text nodes last to first, so the places of the earlier ones still hold.
  const texts = spots.filter((s): s is Extract<Spot, { kind: "text" }> => s.kind === "text").reverse();
  for (const s of spots) {
    if (s.kind === "text") continue;
    const f = byName.get(s.name);
    if (!f) continue;
    const label = s.kind === "link" ? [...s.el.childNodes] : [document.createTextNode(s.el.textContent ?? "")];
    s.el.replaceWith(linkButton(f.path, f.folder, label));
  }
  for (const s of texts) {
    const f = byName.get(s.name);
    if (!f || !s.node.isConnected) continue;
    const after = s.node.splitText(s.end);
    const middle = s.node.splitText(s.start);
    middle.replaceWith(linkButton(f.path, f.folder, [document.createTextNode(s.name)]));
    if (!after.data) after.remove();
  }
}

type FoundFileLike = { path: string; folder: boolean };

// ── Under the answer ────────────────────────────────────────────────────────

function kindLabel(kind: ReplyFileKind): string {
  return t(CHAT_FILE_KINDS[kind].label);
}

function card(file: ReplyFile): HTMLElement {
  const tile = h("span", { class: `attach-tile chat-file-${file.kind}` }, fileIcon(file.path, false, 16));
  const el = h("div", { class: "reply-file" },
    tile,
    h("span", { class: "attach-text" },
      h("span", { class: "attach-name", text: baseName(file.path) }),
      h("span", { class: "attach-detail", text: [kindLabel(file.kind), typeOf(file.path)].filter(Boolean).join(" · ") }),
      h("span", { class: "attach-detail attach-path", text: folderOf(file.path) })),
    h("span", { class: "reply-file-open" }, svg(ICONS.arrowUpRight, 13)));
  wire(el, file.path, false);
  if (PICTURE_FILE.test(file.path)) {
    void picture(file.path).then((src) => {
      if (!src || el.classList.contains("missing")) return;
      tile.replaceChildren(h("img", { class: "attach-thumb", src, alt: "", draggable: "false" }));
    });
  }
  return el;
}

function row(file: ReplyFile): HTMLElement {
  const el = h("div", { class: "reply-files-row" },
    h("span", { class: `attach-tile chat-file-${file.kind}` }, fileIcon(file.path, false, 12)),
    h("span", { class: "reply-files-name", text: baseName(file.path) }),
    h("span", { class: "reply-files-folder", text: baseName(folderOf(file.path)) }));
  wire(el, file.path, false);
  return el;
}

/** The answers' lists opened, by their first file, kept open across redraws. */
const openLists = new Set<string>();

function many(files: readonly ReplyFile[]): HTMLElement {
  const key = files.map((f) => f.path).join("\n");
  const counts = replyCounts(files);
  const detail = [
    counts.created ? t(FILE_LINK_STRINGS.created, { count: counts.created }) : "",
    counts.edited ? t(FILE_LINK_STRINGS.edited, { count: counts.edited }) : "",
    counts.folders > 1 ? t(FILE_LINK_STRINGS.folders, { count: counts.folders }) : baseName(folderOf(files[0].path)),
  ].filter(Boolean).join(" · ");
  const kinds: ReplyFileKind[] = ["created", "edited", "created"];
  const stack = h("span", { class: "reply-files-stack" },
    ...kinds.filter((_, i) => i < 2 || files.length > 2).map((k) =>
      h("span", { class: `attach-tile chat-file-${k}` }, svg(CHAT_FILE_KINDS[k].path, 12, CHAT_FILE_KINDS[k].stroke ? { stroke: CHAT_FILE_KINDS[k].stroke } : {}))));
  const chev = h("span", { class: "reply-files-chev" }, svg(ICONS.chevronRight, 13, { stroke: 1.8 }));
  const head = h("div", { class: "reply-files-head", role: "button", tabindex: "0", "aria-expanded": "false" },
    stack,
    h("span", { class: "attach-text" },
      h("span", { class: "attach-name", text: t(FILE_LINK_STRINGS.many, { count: files.length }) }),
      h("span", { class: "attach-detail", text: detail })),
    chev);
  const rows = h("div", { class: "reply-files-rows" });
  let filter: ReplyFileKind | null = null;
  const chips = h("div", { class: "reply-files-chips" });
  const drawRows = () => {
    rows.replaceChildren(...files.filter((f) => !filter || f.kind === filter).map(row));
    void markMissing(rows, files.filter((f) => !filter || f.kind === filter));
  };
  const chip = (label: string, count: number, kind: ReplyFileKind | null) => {
    const el = h("button", { class: kind === filter ? "reply-files-chip on" : "reply-files-chip" },
      label, h("b", { text: String(count) }));
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      filter = kind;
      chips.querySelectorAll(".reply-files-chip").forEach((c) => c.classList.toggle("on", c === el));
      drawRows();
    });
    return el;
  };
  chips.append(chip(t(FILE_LINK_STRINGS.all), files.length, null));
  if (counts.created && counts.edited) {
    chips.append(chip(t(FILE_LINK_STRINGS.createdChip), counts.created, "created"),
      chip(t(FILE_LINK_STRINGS.editedChip), counts.edited, "edited"));
  }
  const folder = mainFolder(files);
  const openFolder = h("button", { class: "reply-files-folder-btn", text: t(FILE_LINK_STRINGS.openFolder) });
  openFolder.addEventListener("click", (e) => {
    e.stopPropagation();
    // The folder most of them are in, its first file selected.
    const first = files.find((f) => folderOf(f.path) === folder) ?? files[0];
    void Bridge.chatFileReveal(first.path);
  });
  const list = h("div", { class: "reply-files-list" },
    chips, rows,
    h("div", { class: "reply-files-foot" }, h("span", { text: t(FILE_LINK_STRINGS.hint) }), openFolder));
  const box = h("div", { class: "reply-files many" }, head, list);
  const show = (open: boolean) => {
    box.classList.toggle("open", open);
    head.setAttribute("aria-expanded", String(open));
    if (open) {
      openLists.add(key);
      if (!rows.childElementCount) drawRows();
    } else {
      openLists.delete(key);
    }
  };
  head.addEventListener("click", (e) => {
    e.stopPropagation();
    show(!box.classList.contains("open"));
    if (box.classList.contains("open")) list.scrollIntoView?.({ block: "nearest" });
  });
  head.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      show(!box.classList.contains("open"));
    }
  });
  show(openLists.has(key));
  return box;
}

/** Each card or row whose file is gone, marked so. */
async function markMissing(box: HTMLElement, files: readonly ReplyFile[]) {
  const present = await Bridge.chatFilesPresent(files.map((f) => f.path)).catch(() => null);
  if (!present) return;
  const els = box.querySelectorAll<HTMLElement>(".reply-file, .reply-files-row");
  present.forEach((here, i) => {
    if (!here && els[i]) markGone(els[i]);
  });
}

/** The files an answer made or changed, under it: cards, or one line for many. */
export function replyFilesBox(files: readonly ReplyFile[]): HTMLElement | null {
  if (!files.length) return null;
  if (files.length > MAX_CARDS) return many(files);
  const box = h("div", { class: "reply-files" }, ...files.map(card));
  void markMissing(box, files);
  return box;
}
