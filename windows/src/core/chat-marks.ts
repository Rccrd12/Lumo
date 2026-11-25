// What a chat not on screen has for the user, in Past chats (concept:
// puntini-chat, B with C): a dot after its name and a line under it, in the
// state's colour. At work (green), waiting for the user's permission or plan
// (amber), an answer that failed (red), a new answer not read yet (blue);
// nothing when there is nothing to know. The clock's badge counts the chats
// that need the user (all but those at work).
//
// An answer not read yet, or one that failed, is kept in this webview's own
// storage, like the chats (chats.ts), so it is still there when Lumo opens
// again; it goes when the chat is opened or deleted. At work and waiting are
// what the island knows now and are never kept. Pure helpers around one map,
// so they can be tested without a webview.

/** Kept for a chat until it is opened: its answer came, or failed, while it was not on screen. */
export interface ChatMark {
  kind: "unread" | "error";
  /** The answer's start, or what went wrong, on one line. */
  text: string;
  /** Epoch ms. */
  at: number;
}

export type ChatMarks = Record<string, ChatMark>;

/** What the dot says, the most pressing first. */
export type ChatDotKind = "waiting" | "working" | "error" | "unread";

export interface ChatDot {
  kind: ChatDotKind;
  /** What is happening, after the state's own words ("Writing", the answer's start…). */
  detail: string;
}

export const DOT_COLORS: Record<ChatDotKind, string> = {
  working: "#34d399",
  waiting: "#f5a524",
  error: "#f4505e",
  unread: "#7dd3fc",
};

const KEY = "lumo.chatMarks.v1";
/** The characters of an answer kept for its line (the row cuts it to its width). */
const TEXT_CHARS = 160;

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isMark(m: unknown): m is ChatMark {
  if (!m || typeof m !== "object") return false;
  const x = m as Partial<ChatMark>;
  return (x.kind === "unread" || x.kind === "error") && typeof x.text === "string" && typeof x.at === "number";
}

export function loadMarks(): ChatMarks {
  try {
    const raw = storage()?.getItem(KEY);
    const map = raw ? JSON.parse(raw) : {};
    if (!map || typeof map !== "object" || Array.isArray(map)) return {};
    const out: ChatMarks = {};
    for (const [id, m] of Object.entries(map)) if (isMark(m)) out[id] = m;
    return out;
  } catch {
    return {};
  }
}

function saveMarks(marks: ChatMarks) {
  try {
    const s = storage();
    if (!s) return;
    if (Object.keys(marks).length === 0) s.removeItem(KEY);
    else s.setItem(KEY, JSON.stringify(marks));
  } catch {
    // Storage full or refused: the dots last until Lumo closes.
  }
}

/** An answer's text on one line: Markdown's marks and the spaces of its lines go. */
export function oneLine(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/[#>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TEXT_CHARS);
}

/** `chatId`'s answer came (or failed) while it was not on screen: it is kept until it is opened. */
export function markChat(marks: ChatMarks, chatId: string, kind: ChatMark["kind"], text: string, at = Date.now()): ChatMarks {
  const next = { ...marks, [chatId]: { kind, text: oneLine(text), at } };
  saveMarks(next);
  return next;
}

/** `chatId` was opened, or deleted: its mark goes. The same map when it had none. */
export function clearMark(marks: ChatMarks, chatId: string): ChatMarks {
  if (!(chatId in marks)) return marks;
  const next = { ...marks };
  delete next[chatId];
  saveMarks(next);
  return next;
}

/** Marks of chats that no longer exist go (deleted elsewhere, storage left behind). */
export function pruneMarks(marks: ChatMarks, ids: Iterable<string>): ChatMarks {
  const keep = new Set(ids);
  const gone = Object.keys(marks).filter((id) => !keep.has(id));
  if (gone.length === 0) return marks;
  const next = { ...marks };
  for (const id of gone) delete next[id];
  saveMarks(next);
  return next;
}

/**
 * The dot of a chat: waiting for the user first, then at work, then what is
 * kept for it (failed, then a new answer). Null when there is nothing to know,
 * and always for the chat on screen.
 */
export function chatDot(
  now: { onScreen: boolean; waiting: boolean; working: string | null },
  mark: ChatMark | undefined,
): ChatDot | null {
  if (now.onScreen) return null;
  if (now.waiting) return { kind: "waiting", detail: "" };
  if (now.working != null) return { kind: "working", detail: now.working };
  if (mark) return { kind: mark.kind, detail: mark.text };
  return null;
}

/** The chats that need the user, for the clock's badge: everything but at work. */
export function needsUser(dot: ChatDot | null): boolean {
  return dot != null && dot.kind !== "working";
}
