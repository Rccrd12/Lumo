// Ctrl+V in the chat's text field. Text pastes as always. An image on the
// clipboard (a Win+Shift+S screenshot) or a file copied in File Explorer is
// attached instead, as if picked with the paperclip (views/chat.ts useFile):
//
// - a file copied in File Explorer comes from Rust, which reads the
//   clipboard's file list (clipboard.rs) — WebView2 may not hand it to the page;
// - otherwise what the page got (an image) is sent as bytes into the inbox
//   (files.rs write_in).
//
// Pure helpers, so they can be tested without a webview.

import { N_ } from "../i18n/i18n";

export const PASTE_STRINGS = {
  tooBig: N_("This file is too big to paste. Attach it with the paperclip instead."),
};

/** What one paste can hand over as bytes: files.rs MAX_PASTE. */
export const MAX_PASTE_BYTES = 32 * 1024 * 1024;

/** The parts of a paste event's DataTransfer we read. */
export interface PastedData {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<{ kind: string; getAsFile(): File | null }> | null;
  getData(type: string): string;
}

/** The files the page got with the paste: `files`, else the items that are files. */
export function pastedFiles(data: PastedData | null | undefined): File[] {
  if (!data) return [];
  const files = data.files ? Array.from(data.files) : [];
  if (files.length > 0) return files;
  const out: File[] = [];
  for (const item of data.items ? Array.from(data.items) : []) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
}

/**
 * "text": the field pastes it as usual (text wins: Excel puts a picture of the
 * cells next to them). "attach": no text, so a file or an image is looked for.
 */
export function pasteAction(data: PastedData | null | undefined): "text" | "attach" {
  if (!data) return "text";
  return data.getData("text/plain") !== "" ? "text" : "attach";
}

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/webp": "webp",
  "image/tiff": "tif",
};

/**
 * The inbox name of what was pasted: a file keeps its own; the clipboard's
 * image, which the webview names "image.png", gets the time it was pasted.
 */
export function pastedName(file: { name: string; type: string }, now: Date): string {
  const generic = file.name === "" || /^image\.(png|jpe?g|gif|bmp|webp|tiff?)$/i.test(file.name);
  if (!generic) return file.name;
  const ext = IMAGE_EXT[file.type] ?? (file.name.split(".").pop() || "png").toLowerCase();
  const two = (n: number) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const time = `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `pasted-${day}-${time}.${ext}`;
}
