// The chat's files: what was attached in a chat once it went, and the files
// Claude Code or Antigravity CLI read, edited or created while answering it
// (`chat-file` events, claude_code.rs FileTouch). Listed beside the
// attachments, to open again; nothing here is sent to the AI.
//
// Kept in this webview's own storage by chat id, like the past chats
// (core/chats.ts), and dropped with the chat. Pure helpers, so they can be
// tested without a webview.

import { loadChats } from "./chats";

export type ChatFileKind = "attached" | "read" | "edited" | "created";

export interface ChatFile {
  path: string;
  name: string;
  kind: ChatFileKind;
  /** Epoch milliseconds of the last time it was used. */
  at: number;
}

const KEY = "lumo.chatFiles.v1";
/** A chat keeps its newest files past this many. */
export const MAX_FILES = 200;

/**
 * One row per file: what says most about it stays (made by the AI, then
 * changed, then attached, then only read).
 */
const RANK: Record<ChatFileKind, number> = { read: 0, attached: 1, edited: 2, created: 3 };

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isKind(k: unknown): k is ChatFileKind {
  return typeof k === "string" && k in RANK;
}

function isFile(f: unknown): f is ChatFile {
  const x = f as ChatFile;
  return !!x && typeof x.path === "string" && typeof x.name === "string" && isKind(x.kind) && typeof x.at === "number";
}

function loadAll(): Record<string, ChatFile[]> {
  try {
    const raw = storage()?.getItem(KEY);
    const all = raw ? JSON.parse(raw) : {};
    if (!all || typeof all !== "object" || Array.isArray(all)) return {};
    const out: Record<string, ChatFile[]> = {};
    for (const [id, list] of Object.entries(all)) if (Array.isArray(list)) out[id] = list.filter(isFile);
    return out;
  } catch {
    return {};
  }
}

function store(all: Record<string, ChatFile[]>) {
  try {
    storage()?.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage full or unavailable: the list is a convenience, the chat goes on.
  }
}

/** The last part of a path, Windows or Unix. */
export function fileName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;
}

/** The same file whatever its case or slashes (Windows paths). */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.trim().replace(/\//g, "\\").toLowerCase();
  return norm(a) === norm(b);
}

/** `list` with `file` in it, newest first: once, keeping its weightiest kind. */
export function withFile(list: readonly ChatFile[], file: ChatFile): ChatFile[] {
  const before = list.find((f) => samePath(f.path, file.path));
  const kind = before && RANK[before.kind] > RANK[file.kind] ? before.kind : file.kind;
  const rest = list.filter((f) => f !== before);
  return [{ ...file, kind }, ...rest].slice(0, MAX_FILES);
}

/** The files of chat `id`, newest first. */
export function chatFiles(id: string): ChatFile[] {
  return loadAll()[id] ?? [];
}

/**
 * Notes a file of chat `id`, and returns that chat's files. The files of
 * chats no longer in the past chats go at the same time.
 */
export function addChatFile(id: string, kind: ChatFileKind, path: string, name = fileName(path), at = Date.now()): ChatFile[] {
  if (!path.trim() || !isKind(kind)) return chatFiles(id);
  const all = loadAll();
  const kept = new Set(loadChats().map((c) => c.id));
  kept.add(id);
  for (const other of Object.keys(all)) if (!kept.has(other)) delete all[other];
  all[id] = withFile(all[id] ?? [], { path, name, kind, at });
  store(all);
  return all[id];
}

/** A deleted chat's files are forgotten with it (the files themselves stay where they are). */
export function dropChatFiles(id: string) {
  const all = loadAll();
  if (!(id in all)) return;
  delete all[id];
  store(all);
}
