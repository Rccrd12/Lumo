// Past chats — the island's chat history. Kept in this webview's own storage,
// on this computer only, like the weekly recap's history: nothing is sent
// anywhere. Pure helpers around one list, newest first, so they can be tested
// without a webview.

import { cleanChecklists, type ChatChecklists } from "./checklists";

export interface SavedTurn {
  role: "user" | "assistant";
  content: string;
  /** When it was sent or answered (epoch ms); none in chats saved before it was kept. */
  at?: number;
  /** What the conversation holds for it, when not `content` (ChatMessage.kept). */
  kept?: string;
  /** An answer's: the agents it started that ended, in short (core/chat-agents.ts savedAgents). */
  agents?: SavedAgent[];
  /** An answer's: the messages its CLI sent its agents, and their answers ("Talking to …"). */
  talks?: SavedTalk[];
  /** A question's: the agent it was asked of (Ask, the quote above the field). */
  ask?: AskQuote;
}

/** A question asked of one agent: who, and what it was doing then (the quote over the question). */
export interface AskQuote {
  agentId: string;
  title: string;
  /** What its row said when Ask was clicked. */
  line: string;
  /** Its look then (working, stalled, done…): the quote's colour. */
  look: string;
}

/** A saved quote, checked: a chat saved by hand or by an older Lumo may hold anything. */
export function askQuoteOf(x: unknown): AskQuote | undefined {
  const q = x as AskQuote;
  return q && typeof q.agentId === "string" && typeof q.title === "string" && typeof q.line === "string" && typeof q.look === "string"
    ? { agentId: q.agentId, title: q.title, line: q.line, look: q.look }
    : undefined;
}

/** A message sent to an agent, as the chat keeps it with its answer. */
export interface SavedTalk {
  call: string;
  agentId: string;
  title: string;
  message: string;
  sentAt: number;
  reply?: string;
  failed?: string;
}

/** One agent an answer started, as the chat keeps it once it ended (bridge.ts ChatAgent, in short). */
export interface SavedAgent {
  id: string;
  title: string;
  state: "done" | "failed" | "stopped";
  summary?: string;
  error?: string;
  steps: number;
  tokens?: number;
  startedAt: number;
  endedAt?: number;
}

export interface SavedChat {
  id: string;
  /** The first question, shortened. */
  title: string;
  /** Epoch milliseconds of the last answer. */
  updatedAt: number;
  /**
   * The provider the chat is on (a providers.ts id): the last one picked in
   * it, else the one that answered last. Reopened, the picker shows it again.
   */
  provider: string;
  /** Its model, with `provider`; none in chats saved before each chat kept its own. */
  model?: string;
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
    return Array.isArray(list) ? list.filter(isChat).map(unfoldUpdates) : [];
  } catch {
    return [];
  }
}

/**
 * The 0.22.2 betas folded what Claude Code wrote by itself while agents worked
 * into one line under them (`updates`), out of the answer's text but in what
 * the conversation holds (`kept`). It shows as the answer's text again.
 */
function unfoldUpdates(chat: SavedChat): SavedChat {
  if (!chat.turns.some((turn) => "updates" in turn)) return chat;
  const turns = chat.turns.map((turn) => {
    if (!("updates" in turn)) return turn;
    const { updates, ...rest } = turn as SavedTurn & { updates?: unknown };
    const folded = Array.isArray(updates) && updates.length > 0 && rest.role === "assistant" && typeof rest.kept === "string";
    return folded ? { ...rest, content: rest.kept! } : rest;
  });
  return { ...chat, turns };
}

function isChat(c: unknown): c is SavedChat {
  const x = c as SavedChat;
  return !!x && typeof x.id === "string" && typeof x.title === "string" && Array.isArray(x.turns);
}

/**
 * Writes the list, newest first, and returns what was kept. Storage full: the
 * oldest chats go until it fits. Kept whole, the list never fit again, and
 * nothing more was saved from then on, the newest chat included.
 */
function store(list: SavedChat[]): SavedChat[] {
  const s = storage();
  if (!s) return list;
  // An empty list is written too (the last chat deleted); a list that is not
  // keeps one chat at least.
  for (let keep = list.length; keep >= Math.min(1, list.length); keep--) {
    const kept = list.slice(0, keep);
    try {
      s.setItem(KEY, JSON.stringify(kept));
      return kept;
    } catch {
      // Full: one chat fewer.
    }
  }
  // Not even the newest fits, or storage is unavailable: the history is a
  // convenience, the chat goes on.
  return list;
}

/** The first question, on one line and shortened. */
export function chatTitle(turns: SavedTurn[]): string {
  const first = turns.find((t) => t.role === "user")?.content ?? "";
  const line = first.replace(/\s+/g, " ").trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

/**
 * Claude Code answered by itself between two questions (a command it left
 * running in the background ended): `text` joins the chat's last answer, so
 * the chat still goes question, answer, as Rust's conversation does (chat.rs
 * `add_own`). A question still waiting for its answer stays after it. False
 * with no answer to join.
 */
export function joinOwnAnswer(turns: { role: string; content: string; kept?: string; failed?: boolean }[], text: string): boolean {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role !== "assistant" || turn.failed) continue;
    turn.content = turn.content.trim() ? `${turn.content}\n\n${text}` : text;
    // An answer whose conversation is not its text gives Rust its `kept` (chat_restore):
    // the text joins it too, or Claude would not see this answer when the chat comes back.
    if (typeof turn.kept === "string") turn.kept = turn.kept.trim() ? `${turn.kept}\n\n${text}` : text;
    return true;
  }
  return false;
}

/** Ticks given in a chat not saved yet (its first answer still being written), until it is. */
const unsaved = new Map<string, ChatChecklists>();

/** A chat's provider and model, as the picker shows them while it is on screen. */
export interface ChatModel {
  provider: string;
  /** None for a chat saved before each chat kept its own: its provider's model then. */
  model?: string;
}

/**
 * What was picked in a chat while it was on screen, by chat: it wins over the
 * provider and model of an answer asked before (still written meanwhile, it
 * saves the chat again), and keeps a chat not saved yet's choice until it is.
 */
const picks = new Map<string, ChatModel>();

/**
 * The provider and model picked in chat `id`; a saved chat keeps them where it
 * is, its place in the history does not change.
 */
export function setChatModel(id: string, provider: string, model: string) {
  picks.set(id, { provider, model });
  const list = loadChats();
  const chat = list.find((c) => c.id === id);
  if (!chat || (chat.provider === provider && chat.model === model)) return;
  chat.provider = provider;
  chat.model = model;
  store(list);
}

/** The provider and model chat `id` is on, if it has any yet. */
export function chatModelOf(id: string): ChatModel | null {
  const picked = picks.get(id);
  if (picked) return picked;
  const chat = loadChats().find((c) => c.id === id);
  if (!chat || typeof chat.provider !== "string" || !chat.provider) return null;
  return typeof chat.model === "string" && chat.model ? { provider: chat.provider, model: chat.model } : { provider: chat.provider };
}

/**
 * Saves `chat` (new, or replacing the one with its id) at the top of the
 * list. Its checklists' ticks stay as they were when `chat` brings none, and
 * a provider and model picked in it since win over the ones it brings.
 */
export function saveChat(chat: SavedChat): SavedChat[] {
  const picked = picks.get(chat.id);
  if (picked) chat = { ...chat, provider: picked.provider, model: picked.model };
  const chats = loadChats();
  const ticks = chat.checklists ?? chats.find((c) => c.id === chat.id)?.checklists ?? unsaved.get(chat.id);
  unsaved.delete(chat.id);
  const saved = ticks && Object.keys(ticks).length ? { ...chat, checklists: ticks } : chat;
  const list = [saved, ...chats.filter((c) => c.id !== chat.id)].slice(0, MAX_CHATS);
  return store(list);
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

/**
 * Changes a saved chat's turns where it is (its agents ended, an update came
 * in): its place in the history does not change. False when it is not saved.
 */
export function updateChatTurns(id: string, change: (turns: SavedTurn[]) => SavedTurn[]): boolean {
  const list = loadChats();
  const chat = list.find((c) => c.id === id);
  if (!chat) return false;
  chat.turns = change(chat.turns);
  store(list);
  return true;
}

export function deleteChat(id: string): SavedChat[] {
  unsaved.delete(id);
  picks.delete(id);
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
