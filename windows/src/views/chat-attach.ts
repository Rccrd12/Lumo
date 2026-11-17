// The chat's attachments (views/chat.ts): one row for each thing that goes
// with the next question, the chat's files by kind, and the folders they
// sit in.

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import type { MenuEntry as MenuItem } from "./context-menu";
import { ownMenu } from "./own-menu";
import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import { aiKind, type ChatFile, type ChatFileKind } from "../core/chat-files";
import { ITEM_STRINGS, SCREEN_STRINGS, formatSize, type ItemKind } from "../core/screen";
import { N_, t } from "../i18n/i18n";
import { STRINGS } from "./chat-strings";

// ── Attachments ───────────────────────────────────────────────────────────────

/** A dropped, pasted or picked file, or one of what the screen button and the shortcuts added. */
type AttachKind = ItemKind | "file";

interface AttachInfo {
  kind: AttachKind;
  label: string;
  /** Under the name: what it is, and where it comes from. */
  detail: string;
  title: string;
  /** A picture of it, when there is one. */
  thumb?: string;
}

/** Each kind's icon, on the tile of a row with no picture of its own. */
const ATTACH_ICONS: Record<AttachKind, { path: string; stroke?: number }> = {
  file: { path: ICONS.doc },
  shot: { path: ICONS.display, stroke: 1.8 },
  window: { path: ICONS.window, stroke: 1.8 },
  tab: { path: ICONS.globe, stroke: 1.6 },
  selection: { path: ICONS.textLines, stroke: 1.8 },
  folder: { path: ICONS.folder, stroke: 1.8 },
};

/** The files whose picture the attachments show small. */
export const PICTURE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** "File · PDF · 2.0 KB": what a file is, under its name. */
export function fileDetail(file: { name: string; size?: number }): string {
  const dot = file.name.lastIndexOf(".");
  const ext = dot > 0 && dot < file.name.length - 1 ? file.name.slice(dot + 1).toUpperCase() : "";
  return [t(ITEM_STRINGS.file), ext, file.size == null ? "" : formatSize(file.size)].filter(Boolean).join(" · ");
}

/**
 * One row of the attachments: its picture or its kind's icon, its name with
 * what it is under it, and a × that takes back this one only. A click, or
 * Enter, shows what it sends; Delete takes it back.
 */
export function attachRow(item: AttachInfo, onRemove: () => void, onOpen: () => void): HTMLElement {
  const icon = ATTACH_ICONS[item.kind];
  const tile = h("span", { class: `attach-tile attach-${item.kind}` },
    item.thumb
      ? h("img", { class: "attach-thumb", src: item.thumb, alt: "", draggable: "false" })
      : svg(icon.path, 15, icon.stroke ? { stroke: icon.stroke } : {}));
  const remove = h("button", { class: "attach-remove", title: t(SCREEN_STRINGS.remove), "aria-label": t(SCREEN_STRINGS.remove) },
    svg(ICONS.xmark, 9));
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    onRemove();
  });
  const row = h(
    "div",
    { class: "attach-row", title: item.title, role: "button", tabindex: "0" },
    tile,
    h("span", { class: "attach-text" },
      h("span", { class: "attach-name", text: item.label }),
      item.detail ? h("span", { class: "attach-detail", text: item.detail }) : null),
    remove,
  );
  row.addEventListener("click", () => onOpen());
  row.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter" || key === " ") {
      e.preventDefault();
      onOpen();
    } else if (key === "Delete" || key === "Backspace") {
      e.preventDefault();
      onRemove();
    }
  });
  return row;
}

/** Where a chat's file comes from, under its name, with its icon and colour. */
export const CHAT_FILE_KINDS: Record<ChatFileKind, { label: string; path: string; stroke?: number }> = {
  attached: { label: N_("Attached"), path: ICONS.paperclip, stroke: 1.8 },
  read: { label: N_("Read by the AI"), path: ICONS.doc },
  edited: { label: N_("Edited by the AI"), path: ICONS.pencil, stroke: 1.8 },
  created: { label: N_("Created by the AI"), path: ICONS.plus },
};

/** The folder a file is in, as written in its path. */
function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/**
 * One row of the chat's files: like an attachment's. A click, or Enter, opens
 * it; the right click has what else can be done with it; its ×, or Delete,
 * takes it out of the chat's context.
 */
export function chatFileRow(
  file: ChatFile, missing: boolean, thumb: string | undefined, onOpen: () => void, menu: () => MenuItem[], onRemove: () => void,
): HTMLElement {
  // Attached and what the AI did, on one line: "Attached · Read by the AI".
  const ai = aiKind(file);
  const attached = file.kinds.includes("attached");
  const kind = CHAT_FILE_KINDS[attached ? "attached" : ai ?? "read"];
  const tile = h("span", { class: `attach-tile chat-file-${attached ? "attached" : ai}` },
    thumb
      ? h("img", { class: "attach-thumb", src: thumb, alt: "", draggable: "false" })
      : svg(kind.path, 15, kind.stroke ? { stroke: kind.stroke } : {}));
  const what = [attached ? t(CHAT_FILE_KINDS.attached.label) : "", ai ? t(CHAT_FILE_KINDS[ai].label) : ""];
  const detail = [...what, missing ? t(STRINGS.fileMissing) : fileDetail({ name: file.name }).split(" · ").slice(1).join(" · ")]
    .filter(Boolean).join(" · ");
  const row = h(
    "div",
    { class: missing ? "attach-row chat-file-row missing" : "attach-row chat-file-row", title: file.path, role: "button", tabindex: "0" },
    tile,
    h("span", { class: "attach-text" },
      h("span", { class: "attach-name", text: file.name }),
      h("span", { class: "attach-detail", text: detail }),
      // Where it is: its folder (the whole path is the row's tooltip).
      h("span", { class: "attach-detail attach-path", text: folderOf(file.path) })),
    removeButton(t(STRINGS.removeFromContext), onRemove),
  );
  row.addEventListener("click", () => onOpen());
  row.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter" || key === " ") {
      e.preventDefault();
      onOpen();
    } else if (key === "Delete" || key === "Backspace") {
      e.preventDefault();
      onRemove();
    }
  });
  ownMenu(row, menu);
  return row;
}

/** A row's ×. */
function removeButton(label: string, onRemove: () => void): HTMLElement {
  const remove = h("button", { class: "attach-remove", title: label, "aria-label": label }, svg(ICONS.xmark, 9));
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    onRemove();
  });
  return remove;
}

/**
 * A folder of the attachments ("Computer") or of the chat's files (one per
 * kind): its icon, its name, how many it holds on the right and a chevron. A
 * click, or Enter, opens or closes it; its rows stay in the list, hidden
 * while it is closed.
 */
export function attachGroup(
  group: { label: string; detail: string; tile: string; icon: { path: string; stroke?: number }; rows: HTMLElement[] },
  open: boolean,
  onToggle: (open: boolean) => void,
): HTMLElement {
  const head = h(
    "div",
    { class: "attach-group-head", title: group.detail, role: "button", tabindex: "0", "aria-expanded": String(open) },
    h("span", { class: `attach-tile ${group.tile}` }, svg(group.icon.path, 15, group.icon.stroke ? { stroke: group.icon.stroke } : {})),
    h("span", { class: "attach-text" },
      h("span", { class: "attach-name", text: group.label }),
      group.detail ? h("span", { class: "attach-detail", text: group.detail }) : null),
    h("span", { class: "files-count attach-group-count", text: String(group.rows.length) }),
    h("span", { class: "attach-group-chevron" }, svg(ICONS.chevronRight, 9, { stroke: 2 })),
  );
  const el = h("div", { class: open ? "attach-group open" : "attach-group" }, head, h("div", { class: "attach-group-items" }, ...group.rows));
  const toggle = () => {
    const now = !el.classList.contains("open");
    el.classList.toggle("open", now);
    head.setAttribute("aria-expanded", String(now));
    onToggle(now);
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter" || key === " ") {
      e.preventDefault();
      toggle();
    }
  });
  return el;
}

/** The icon of the attachments' "Computer" folder. */
export const COMPUTER_ICON = { path: ICONS.display, stroke: 1.8 };

export function saveSettings() {
  void Bridge.saveSettings(State.settings);
}

/** Antigravity CLI: its models' variants by effort are one row in the picker. */
export const AGY = "antigravity-cli";
