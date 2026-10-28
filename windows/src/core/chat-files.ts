// The chat's files: what was attached in a chat once it went, and the files
// Claude Code or Antigravity CLI read, edited or created while answering it
// (`chat-file` events, claude_code.rs FileTouch). Listed beside the
// attachments, to open again, in a folder for each of what happened to them
// (a file attached and read is in both). Its × takes it out of the chat's
// context; an edited message takes out the files of the turns it drops.
//
// Kept in this webview's own storage by chat id, like the past chats
// (core/chats.ts), and dropped with the chat. Pure helpers, so they can be
// tested without a webview.

import { loadChats } from "./chats";

export type ChatFileKind = "attached" | "read" | "edited" | "created";

export interface ChatFile {
  path: string;
  name: string;
  /** Everything that happened to it, in RANK order: attached, then what the AI did. */
  kinds: ChatFileKind[];
  /** Epoch milliseconds of the last time it was used. */
  at: number;
  /**
   * The turn (chat.rs plain turns, the user message's index) each kind first
   * happened in; editing a message before it takes that kind back. A kind
   * without one stays.
   */
  turns?: Partial<Record<ChatFileKind, number>>;
}

const KEY = "lumo.chatFiles.v1";
/** A chat keeps its newest files past this many. */
export const MAX_FILES = 200;

/** The order a file's kinds are told in: attached first, then what the AI did. */
const RANK: Record<ChatFileKind, number> = { attached: 0, read: 1, edited: 2, created: 3 };

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

/** A stored file, or null; one saved by 0.13.0 has a single `kind`. */
function readFile(f: unknown): ChatFile | null {
  const x = f as ChatFile & { kind?: unknown };
  if (!x || typeof x.path !== "string" || typeof x.name !== "string" || typeof x.at !== "number") return null;
  const kinds = (Array.isArray(x.kinds) ? x.kinds : [x.kind]).filter(isKind);
  if (!kinds.length) return null;
  const turns = readTurns(x.turns);
  return turns ? { path: x.path, name: x.name, kinds: sorted(kinds), at: x.at, turns } : { path: x.path, name: x.name, kinds: sorted(kinds), at: x.at };
}

function readTurns(raw: unknown): ChatFile["turns"] | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Partial<Record<ChatFileKind, number>> = {};
  for (const [k, v] of Object.entries(raw)) if (isKind(k) && typeof v === "number" && v >= 0) out[k] = v;
  return Object.keys(out).length ? out : null;
}

/** Both files' turns, the earliest of each kind. */
function joinTurns(a: ChatFile["turns"], b: ChatFile["turns"]): ChatFile["turns"] | null {
  const out: Partial<Record<ChatFileKind, number>> = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b ?? {}) as [ChatFileKind, number][]) out[k] = out[k] == null ? v : Math.min(out[k]!, v);
  return Object.keys(out).length ? out : null;
}

function sorted(kinds: Iterable<ChatFileKind>): ChatFileKind[] {
  return [...new Set(kinds)].sort((a, b) => RANK[a] - RANK[b]);
}

function loadAll(): Record<string, ChatFile[]> {
  try {
    const raw = storage()?.getItem(KEY);
    const all = raw ? JSON.parse(raw) : {};
    if (!all || typeof all !== "object" || Array.isArray(all)) return {};
    const out: Record<string, ChatFile[]> = {};
    for (const [id, list] of Object.entries(all)) {
      if (Array.isArray(list)) out[id] = list.map(readFile).filter((f): f is ChatFile => f != null);
    }
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

/**
 * The same file: the same path, or an attachment and a file of the same name
 * (an attachment is the inbox's copy of a file the AI may read where it is).
 */
function sameFile(a: ChatFile, b: ChatFile): boolean {
  if (samePath(a.path, b.path)) return true;
  const attached = a.kinds.includes("attached") || b.kinds.includes("attached");
  return attached && a.name.toLowerCase() === b.name.toLowerCase();
}

/**
 * `list` with `file` in it, newest first: once, with every kind it had. Its
 * path is the file's own rather than the inbox's copy.
 */
export function withFile(list: readonly ChatFile[], file: ChatFile): ChatFile[] {
  const before = list.find((f) => sameFile(f, file));
  if (!before) return [file, ...list].slice(0, MAX_FILES);
  const kinds = sorted([...before.kinds, ...file.kinds]);
  const onlyCopy = (f: ChatFile) => f.kinds.length === 1 && f.kinds[0] === "attached";
  const path = onlyCopy(file) && !onlyCopy(before) ? before.path : file.path;
  const name = path === before.path ? before.name : file.name;
  const turns = joinTurns(before.turns, file.turns);
  const joined: ChatFile = { path, name, kinds, at: Math.max(file.at, before.at), ...(turns ? { turns } : {}) };
  return [joined, ...list.filter((f) => f !== before)].slice(0, MAX_FILES);
}

/** What the AI did to it, the most telling only (a file it edited was read first); null when nothing. */
export function aiKind(file: ChatFile): Exclude<ChatFileKind, "attached"> | null {
  const ai = file.kinds.filter((k): k is Exclude<ChatFileKind, "attached"> => k !== "attached");
  return ai.length ? ai[ai.length - 1] : null;
}

/**
 * The files of chat `id`, newest first, each once (rows kept apart before,
 * an attachment and the file the AI read, come together).
 */
export function chatFiles(id: string, all = loadAll()): ChatFile[] {
  return [...(all[id] ?? [])].reverse().reduce<ChatFile[]>((list, f) => withFile(list, f), []);
}

/**
 * Notes a file of chat `id`, and returns that chat's files. The files of
 * chats no longer in the past chats go at the same time.
 */
export function addChatFile(
  id: string, kind: ChatFileKind, path: string, name = fileName(path), at = Date.now(), turn?: number,
): ChatFile[] {
  if (!path.trim() || !isKind(kind)) return chatFiles(id);
  const all = loadAll();
  const kept = new Set(loadChats().map((c) => c.id));
  kept.add(id);
  for (const other of Object.keys(all)) if (!kept.has(other)) delete all[other];
  const file: ChatFile = { path, name, kinds: [kind], at };
  if (turn != null && turn >= 0) file.turns = { [kind]: turn };
  all[id] = withFile(all[id] ?? [], file);
  store(all);
  return all[id];
}

/** `file` without what happened from turn `keep` on; null when nothing is left of it. */
export function rewoundFile(file: ChatFile, keep: number): ChatFile | null {
  const turns = file.turns ?? {};
  const kinds = file.kinds.filter((k) => turns[k] == null || turns[k]! < keep);
  if (kinds.length === 0) return null;
  const left = Object.fromEntries(Object.entries(turns).filter(([k]) => kinds.includes(k as ChatFileKind)));
  const { turns: _, ...rest } = file;
  return Object.keys(left).length ? { ...rest, kinds, turns: left } : { ...rest, kinds };
}

/**
 * An edited message: chat `id` keeps its first `keep` turns, and its files
 * lose what happened in the others (a file attached in a dropped turn goes;
 * one attached before and read after stays, attached only).
 */
export function rewindChatFiles(id: string, keep: number): ChatFile[] {
  const all = loadAll();
  if (!(id in all)) return [];
  all[id] = chatFiles(id, all).map((f) => rewoundFile(f, keep)).filter((f): f is ChatFile => f != null);
  store(all);
  return all[id];
}

/** The ×: one of chat `id`'s files leaves its list (the file itself stays where it is). */
export function removeChatFile(id: string, file: Pick<ChatFile, "path" | "name">): ChatFile[] {
  const all = loadAll();
  if (!(id in all)) return [];
  const gone: ChatFile = { path: file.path, name: file.name, kinds: ["attached"], at: 0 };
  all[id] = chatFiles(id, all).filter((f) => !sameFile(f, gone));
  store(all);
  return all[id];
}

/** The folders the chat's files are shown in: one per kind with something in it, a file in each of its kinds. */
export function filesByKind(files: readonly ChatFile[]): { kind: ChatFileKind; files: ChatFile[] }[] {
  return (Object.keys(RANK) as ChatFileKind[])
    .map((kind) => ({ kind, files: files.filter((f) => f.kinds.includes(kind)) }))
    .filter((g) => g.files.length > 0);
}

/** A deleted chat's files are forgotten with it (the files themselves stay where they are). */
export function dropChatFiles(id: string) {
  const all = loadAll();
  if (!(id in all)) return;
  delete all[id];
  store(all);
}
