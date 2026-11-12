// What Lumo heard for a chat (core/listen.ts, listen.rs `listen-fired`): one
// quiet line in the chat that asked, between its messages, by time. A watch
// with nothing to do then ("Only tell me") never wakes the AI: its line is
// all there is. A line the user has not seen yet waits on the closed island,
// on the waves and in Past chats until that chat is opened, or its bar in
// another chat is closed (views/chat.ts).
//
// Kept in this webview's own storage, like the chats themselves (chats.ts):
// on this computer only, a few per chat. What still waits to be seen is not
// kept: a restart starts with nothing waiting. Pure helpers around one map,
// so they can be tested without a webview.

import type { ListenFired, ListenWatch } from "./listen";
import { firedTitle, watchColor } from "./listen";

/** One event heard for a chat. */
export interface HeardLine {
  /** Unique for the line (its watch, its time). */
  id: string;
  chatId: string;
  /** The chat's name when it was heard (the closed island and the bar say it). */
  chatTitle: string;
  /** Epoch ms. */
  at: number;
  /** What happened, in the user's language (listen.rs). */
  summary: string;
  /** "GitHub", or the watch's own name (firedTitle). */
  title: string;
  color: string;
  /** What it waited for happened (false: it no longer can). */
  met: boolean;
  /** The watch as it fired: its task, its source, whether it goes on. */
  watch: ListenWatch;
  /** The watch is over (false: it listens every time and goes on). */
  ended: boolean;
  /** The user asked the AI about it already (its button goes). */
  asked?: boolean;
}

const KEY = "lumo.listen.heard.v1";
/** The newest lines a chat keeps. */
export const MAX_LINES_PER_CHAT = 40;
/** A line's summary is cut here. */
const SUMMARY_CHARS = 400;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isLine(x: unknown): x is HeardLine {
  const l = x as HeardLine;
  return !!l && typeof l.id === "string" && typeof l.chatId === "string" && typeof l.at === "number" && typeof l.summary === "string" && !!l.watch && typeof l.watch === "object";
}

function loadAll(): Record<string, HeardLine[]> {
  try {
    const raw = storage()?.getItem(KEY);
    const map = raw ? JSON.parse(raw) : {};
    if (!map || typeof map !== "object") return {};
    const out: Record<string, HeardLine[]> = {};
    for (const [chat, lines] of Object.entries(map)) {
      if (Array.isArray(lines)) out[chat] = lines.filter(isLine);
    }
    return out;
  } catch {
    return {};
  }
}

function storeAll(map: Record<string, HeardLine[]>) {
  try {
    storage()?.setItem(KEY, JSON.stringify(map));
  } catch {
    // Storage full: the lines are a convenience, the chat goes on.
  }
}

/** The line for an event a watch heard, in the chat called `chatTitle`. */
export function heardLine(fired: ListenFired, chatTitle: string, at = Date.now()): HeardLine {
  const summary = fired.summary.replace(/\s+/g, " ").trim();
  return {
    id: `${fired.watch.id}:${at}`,
    chatId: fired.watch.chatId,
    chatTitle,
    at,
    summary: summary.length > SUMMARY_CHARS ? `${summary.slice(0, SUMMARY_CHARS - 1)}…` : summary,
    title: firedTitle(fired.watch),
    color: watchColor(fired.watch),
    met: fired.met,
    watch: fired.watch,
    ended: fired.ended !== false,
  };
}

/** A chat's lines, oldest first. */
export function heardIn(chatId: string): HeardLine[] {
  if (!chatId) return [];
  return [...(loadAll()[chatId] ?? [])].sort((a, b) => a.at - b.at);
}

/**
 * Keeps a line with its chat, the oldest going past MAX_LINES_PER_CHAT.
 * `chats`: the chats still in the history, when known; the lines of the
 * others (gone past the history's last) go then.
 */
export function addHeard(line: HeardLine, chats?: ReadonlySet<string>) {
  if (!line.chatId) return;
  const map = loadAll();
  if (chats) for (const id of Object.keys(map)) if (id !== line.chatId && !chats.has(id)) delete map[id];
  const lines = [...(map[line.chatId] ?? []).filter((l) => l.id !== line.id), line].sort((a, b) => a.at - b.at);
  map[line.chatId] = lines.slice(-MAX_LINES_PER_CHAT);
  storeAll(map);
}

/** The user asked the AI about a line: its button goes. */
export function markAsked(chatId: string, id: string) {
  const map = loadAll();
  const line = map[chatId]?.find((l) => l.id === id);
  if (!line) return;
  line.asked = true;
  storeAll(map);
}

/** A chat deleted: its lines go with it. */
export function dropHeard(chatId: string) {
  const map = loadAll();
  if (!(chatId in map)) return;
  delete map[chatId];
  storeAll(map);
}

/**
 * Where a chat's lines go among its messages: before the first message
 * written after them (by `at`), the rest after the last. A message without
 * a time (chats saved before it was kept) takes none before it.
 */
export function placeHeard(messages: { at?: number }[], lines: HeardLine[]): { before: HeardLine[][]; after: HeardLine[] } {
  const before: HeardLine[][] = messages.map(() => []);
  let i = 0;
  const sorted = [...lines].sort((a, b) => a.at - b.at);
  for (const line of sorted) {
    while (i < messages.length && (messages[i].at == null || (messages[i].at as number) <= line.at)) i++;
    if (i < messages.length) before[i].push(line);
    else return { before, after: sorted.slice(sorted.indexOf(line)) };
  }
  return { before, after: [] };
}

// ── What waits to be seen ─────────────────────────────────────────────────────

/**
 * The lines not seen yet, newest last, one per chat: a chat's newest line
 * stands for it (how many more of it came does not matter to the island,
 * which chat they are in does).
 */
export function addPending(pending: HeardLine[], line: HeardLine): HeardLine[] {
  if (!line.chatId) return pending;
  return [...pending.filter((p) => p.chatId !== line.chatId), line];
}

/** The chat was seen (opened, or its bar closed): it no longer waits. */
export function seenChat(pending: HeardLine[], chatId: string): HeardLine[] {
  return pending.some((p) => p.chatId === chatId) ? pending.filter((p) => p.chatId !== chatId) : pending;
}

/** The newest line waiting from a chat other than `chatId`, and how many other chats wait besides it. */
export function waitingElsewhere(pending: HeardLine[], chatId: string): { line: HeardLine; more: number } | null {
  const others = pending.filter((p) => p.chatId !== chatId);
  const line = others.at(-1);
  return line ? { line, more: others.length - 1 } : null;
}

/**
 * Whether the waves light up (and ring): something listens for the chat on
 * screen, or an event for another chat waits to be seen.
 */
export function wavesLit(watches: ListenWatch[], pending: HeardLine[], chatId: string): boolean {
  return watches.some((w) => !w.paused && w.chatId === chatId) || pending.some((p) => p.chatId !== chatId);
}
