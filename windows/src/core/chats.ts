// Past chats — the island's chat history. Kept in this webview's own storage,
// on this computer only, like the weekly recap's history: nothing is sent
// anywhere. Pure helpers around one list, newest first, so they can be tested
// without a webview.

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
}

const KEY = "coucou.chats.v1";
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

/** Saves `chat` (new, or replacing the one with its id) at the top of the list. */
export function saveChat(chat: SavedChat): SavedChat[] {
  const list = [chat, ...loadChats().filter((c) => c.id !== chat.id)].slice(0, MAX_CHATS);
  store(list);
  return list;
}

export function deleteChat(id: string): SavedChat[] {
  const list = loadChats().filter((c) => c.id !== id);
  store(list);
  return list;
}

export function newChatId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
