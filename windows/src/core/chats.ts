// Past chats — the island's chat history. Kept in this webview's own storage,
// on this computer only, like the weekly recap's history: nothing is sent
// anywhere. Pure helpers around one list, newest first, so they can be tested
// without a webview.

import { cleanChecklists, type ChatChecklists } from "./checklists";

export interface SavedTurn {
  role: "user" | "assistant";
  content: string;
}

export interface SavedChat {
  id: string;
  /** The first question, shortened. */
  title: string;
  /** Epoch milliseconds of the last answer. */
  updatedAt: number;
  /** Who answered last (a providers.ts id). */
  provider: string;
  /** The CLI session that answered (Claude Code, Antigravity CLI), so reopening continues it. */
  session: string | null;
  turns: SavedTurn[];
  /** What the user ticked in the chat's checklists (core/checklists.ts), by list. */
  checklists?: ChatChecklists;
}

const KEY = "lumo.chats.v1";
/** The oldest chats go past this many. */
export const MAX_CHATS = 40;
const TITLE_CHARS = 60;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadChats(): SavedChat[] {
  try {
    const raw = storage()?.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter(isChat) : [];
  } catch {
    return [];
  }
}

function isChat(c: unknown): c is SavedChat {
  const x = c as SavedChat;
  return !!x && typeof x.id === "string" && typeof x.title === "string" && Array.isArray(x.turns);
}

function store(list: SavedChat[]) {
  try {
    storage()?.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage full or unavailable: the history is a convenience, the chat goes on.
  }
}

/** The first question, on one line and shortened. */
export function chatTitle(turns: SavedTurn[]): string {
  const first = turns.find((t) => t.role === "user")?.content ?? "";
  const line = first.replace(/\s+/g, " ").trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

/** Ticks given in a chat not saved yet (its first answer still being written), until it is. */
const unsaved = new Map<string, ChatChecklists>();

/**
 * Saves `chat` (new, or replacing the one with its id) at the top of the
 * list. Its checklists' ticks stay as they were when `chat` brings none.
 */
export function saveChat(chat: SavedChat): SavedChat[] {
  const chats = loadChats();
  const ticks = chat.checklists ?? chats.find((c) => c.id === chat.id)?.checklists ?? unsaved.get(chat.id);
  unsaved.delete(chat.id);
  const saved = ticks && Object.keys(ticks).length ? { ...chat, checklists: ticks } : chat;
  const list = [saved, ...chats.filter((c) => c.id !== chat.id)].slice(0, MAX_CHATS);
  store(list);
  return list;
}

/** What the user ticked in a chat's checklists. */
export function chatChecklists(id: string): ChatChecklists {
  const chat = loadChats().find((c) => c.id === id);
  return cleanChecklists(chat ? chat.checklists : unsaved.get(id));
}

/** Keeps a chat's ticks with it, where it is saved; its place in the history does not change. */
export function setChatChecklists(id: string, checklists: ChatChecklists) {
  const list = loadChats();
  const chat = list.find((c) => c.id === id);
  if (!chat) {
    unsaved.set(id, checklists);
    return;
  }
  chat.checklists = checklists;
  store(list);
}

export function deleteChat(id: string): SavedChat[] {
  unsaved.delete(id);
  const list = loadChats().filter((c) => c.id !== id);
  store(list);
  setCompact(id, null);
  return list;
}

/** A chat's /compact: the summary the model is sent in place of its first `upto` turns (chat.rs). */
export interface ChatCompact {
  upto: number;
  summary: string;
}

const COMPACT_KEY = "lumo.chats.compact.v1";

function compacts(): Record<string, ChatCompact> {
  try {
    const raw = storage()?.getItem(COMPACT_KEY);
    const all = raw ? JSON.parse(raw) : {};
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
}

/** The summary a chat was compacted to, if it was. */
export function compactOf(id: string): ChatCompact | null {
  const c = compacts()[id];
  return c && typeof c.upto === "number" && typeof c.summary === "string" ? c : null;
}

/** Keeps (or with null forgets) a chat's summary; only chats still in the history keep one. */
export function setCompact(id: string, compact: ChatCompact | null) {
  const all = compacts();
  if (compact) all[id] = compact;
  else delete all[id];
  const kept = new Set(loadChats().map((c) => c.id));
  kept.add(compact ? id : "");
  for (const key of Object.keys(all)) if (!kept.has(key)) delete all[key];
  try {
    storage()?.setItem(COMPACT_KEY, JSON.stringify(all));
  } catch {
    // Storage full: the summary lasts while the app is open.
  }
}

export function newChatId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Search ────────────────────────────────────────────────────────────────────

/** Folded for matching: lower case, accents off ("Perché" finds "perche"). */
function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** A found chat, with the line around the first match and where the match is in it. */
export interface ChatHit {
  chat: SavedChat;
  /** "…the words around the match…", on one line. */
  snippet: string;
  /** The match inside `snippet`: [start, end). */
  match: [number, number];
}

const SNIPPET_BEFORE = 28;
const SNIPPET_AFTER = 60;

/**
 * The chats where every word of `query` is found, in the questions or the
 * answers, newest first; each with the passage of the first word found. An
 * empty query finds nothing.
 */
export function searchChats(chats: SavedChat[], query: string): ChatHit[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: ChatHit[] = [];
  for (const chat of chats) {
    const texts = [chat.title, ...chat.turns.map((t) => t.content)].map((t) => t.replace(/\s+/g, " ").trim());
    const all = fold(texts.join("\n"));
    if (!words.every((w) => all.includes(w))) continue;
    // The passage: the first text holding the first word.
    const text = texts.find((t) => fold(t).includes(words[0])) ?? texts[0];
    // An accented letter folds to its one base letter: a position in the
    // folded text is the same position in the composed one.
    const composed = text.normalize("NFC");
    const index = Math.max(0, fold(composed).indexOf(words[0]));
    const start = Math.max(0, index - SNIPPET_BEFORE);
    const end = Math.min(composed.length, index + words[0].length + SNIPPET_AFTER);
    const head = start > 0 ? "…" : "";
    const snippet = `${head}${composed.slice(start, end)}${end < composed.length ? "…" : ""}`;
    const from = head.length + (index - start);
    hits.push({ chat, snippet, match: [from, Math.min(snippet.length, from + words[0].length)] });
  }
  return hits;
}
