// The files an answer names, and the files it made or changed
// (concepts/file-cliccabili-in-chat): pure helpers for views/file-links.ts,
// so they can be tested without a webview.
//
// An answer names a file by its whole path (`C:\…\report.pdf`), by its name
// (`pasted-2026-11-24-152045-line.png`) or by a short path (`figure\dipolo.png`),
// in its text or as inline code; a link to a path (markdown.ts localTarget)
// names one too. Only what Rust finds among the chat's files and beside them
// (chat_files.rs chat_file_find) becomes a button: these are only the names
// worth asking about.

/** What an answer did to a file it lists under it. */
export type ReplyFileKind = "edited" | "created";

/** A file an answer made or changed, listed under it (ChatMessage.files). */
export interface ReplyFile {
  path: string;
  kind: ReplyFileKind;
}

/** A path in a chat's folder of copies (workspace.rs): a local model's copy. */
export function inWorkspace(path: string): boolean {
  return /[\\/]com\.rccrd12\.lumo[\\/]workspaces[\\/]/i.test(path);
}

/** A copy of a file of the computer that the model changed: what changed can be seen, and written over the original. */
export function changedCopy(file: ReplyFile): boolean {
  return file.kind === "edited" && inWorkspace(file.path);
}

/** Up to this many files show as cards of their own; more are one line that opens into a list. */
export const MAX_CARDS = 3;
/** At most this many names of one answer are asked about. */
export const MAX_NAMES = 60;

/**
 * A drive's path (spaces end it: one with spaces is written as a link), or a
 * name, perhaps under a folder or two, with an extension that starts with a
 * letter (so `1.5` and `v2.0` are not files).
 */
const NAME = /[A-Za-z]:[\\/][^\s<>"|?*]*[^\s<>"|?*.,;:!)\]'’]|(?:[\w~-][\w.~()-]*[\\/]){0,3}[\w~-][\w.~-]*\.[A-Za-z][A-Za-z0-9]{0,7}(?![\w-])/g;

export interface NameAt {
  name: string;
  start: number;
  end: number;
}

/**
 * The names in `text` that may be files, where they are. Not inside a web
 * address or an email (`example.com/a.png`, `me@mail.com`), nor a number.
 */
export function namesIn(text: string): NameAt[] {
  const out: NameAt[] = [];
  NAME.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAME.exec(text))) {
    let name = m[0];
    const start = m.index;
    // A sentence's full stop or closing bracket is not part of the name.
    name = name.replace(/[.,;:!?)\]'’]+$/, "");
    const before = text.slice(Math.max(0, start - 3), start);
    if (/[@/\\:.\w]$/.test(before) && !/^[A-Za-z]:[\\/]/.test(name)) continue;
    if (/:\/\/$/.test(before) || /^www\./i.test(name)) continue;
    // A word right before a drive letter ("abcC:\…") is not a path.
    if (/^[A-Za-z]:/.test(name) && /\w$/.test(before)) continue;
    if (!name || !/\.[A-Za-z][A-Za-z0-9]{0,7}$|^[A-Za-z]:[\\/]/.test(name)) continue;
    out.push({ name, start, end: start + name.length });
  }
  return out;
}

/** The whole of `text` when it is one name that may be a file (inline code such as `report.pdf`). */
export function wholeName(text: string): string | null {
  const t = text.trim();
  const found = namesIn(t);
  return found.length === 1 && found[0].start === 0 && found[0].end === t.length ? t : null;
}

/** The last part of a path. */
export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}

/** The folder a path is in, as written in it. */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/** `files` with `path` in it as `kind`: once, a file made by the answer staying made. */
export function withReplyFile(files: readonly ReplyFile[], path: string, kind: ReplyFileKind): ReplyFile[] {
  const norm = (p: string) => p.trim().replace(/\//g, "\\").toLowerCase();
  const before = files.find((f) => norm(f.path) === norm(path));
  if (!before) return [...files, { path, kind }];
  if (before.kind === "created" || kind === before.kind) return [...files];
  return files.map((f) => (f === before ? { path: f.path, kind: "edited" as const } : f));
}

/** A saved answer's files, checked: storage holds anything. */
export function readReplyFiles(raw: unknown): ReplyFile[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((f): f is ReplyFile =>
    !!f && typeof f.path === "string" && f.path.trim() !== "" && (f.kind === "edited" || f.kind === "created"))
    .map((f) => ({ path: f.path, kind: f.kind }));
  return out.length ? out : undefined;
}

/** How many of each, for the line that sums many files up. */
export function replyCounts(files: readonly ReplyFile[]): { created: number; edited: number; folders: number } {
  const folders = new Set(files.map((f) => folderOf(f.path).toLowerCase()));
  return {
    created: files.filter((f) => f.kind === "created").length,
    edited: files.filter((f) => f.kind === "edited").length,
    folders: folders.size,
  };
}

/** The folder most of them are in: the one "Open the folder" shows. */
export function mainFolder(files: readonly ReplyFile[]): string | null {
  const count = new Map<string, { folder: string; n: number }>();
  for (const f of files) {
    const folder = folderOf(f.path);
    const k = folder.toLowerCase();
    const c = count.get(k) ?? { folder, n: 0 };
    c.n++;
    count.set(k, c);
  }
  let best: { folder: string; n: number } | null = null;
  for (const c of count.values()) if (!best || c.n > best.n) best = c;
  return best?.folder ?? null;
}
