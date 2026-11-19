// Past chats — the island's chat history. Kept in this webview's own storage,
// on this computer only, like the weekly recap's history: nothing is sent
// anywhere. Pure helpers around one list, newest first, so they can be tested
// without a webview.

import { cleanChecklists, type ChatChecklists } from "./checklists";
import type { ComputerRecap, ComputerRecapStep } from "./computer-use";
import type { SentItem } from "./sent";

export interface SavedTurn {
  role: "user" | "assistant";
  content: string;
  /** When it was sent or answered (epoch ms); none in chats saved before it was kept. */
  at?: number;
  /** What the conversation holds for it, when not `content` (ChatMessage.kept). */
  kept?: string;
  /** A question: what went with it (core/sent.ts ChatMessage.sent). */
  sent?: SentItem[];
  /** The answer's turn used the computer: its plan as it ended (ChatMessage.computer), with the steps' small pictures. */
  computer?: ComputerRecap;
  /** The problem said under an answer (ChatMessage.warning). */
  warning?: AnswerWarning;
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
  /** Ended under its work: its CLI ended ("cli"), or Lumo closed while it worked ("lumo"). */
  endedBy?: "cli" | "lumo";
  /** Resume was sent for it: the card no longer offers it. */
  resumed?: boolean;
}

const STATUSES = new Set(["pending", "active", "done"]);
/** A small picture's base64, nothing else: it goes into an <img>'s data: address. */
const BASE64 = /^[A-Za-z0-9+/]+=*$/;

/**
 * A computer use recap as far as it can be shown (Rust's ChatReply.computer,
 * or one read back from storage): undefined when it is not one.
 */
export function cleanRecap(raw: unknown): ComputerRecap | undefined {
  const r = raw as Partial<ComputerRecap> | null;
  if (!r || typeof r !== "object" || !Array.isArray(r.steps)) return undefined;
  const steps: ComputerRecapStep[] = [];
  for (const s of r.steps as unknown[]) {
    const step = s as Partial<ComputerRecapStep> | null;
    if (!step || typeof step.text !== "string" || !STATUSES.has(step.status as string)) continue;
    steps.push({
      text: step.text,
      status: step.status as ComputerRecapStep["status"],
      ...(typeof step.image === "string" && step.image && BASE64.test(step.image) ? { image: step.image } : {}),
    });
  }
  const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : 0);
  return {
    agent: typeof r.agent === "string" ? r.agent : "",
    color: typeof r.color === "string" && /^#[0-9a-f]{3,8}$/i.test(r.color) ? r.color : "",
    steps,
    actions: count(r.actions),
    ms: count(r.ms),
    ...(r.stopped === true ? { stopped: true } : {}),
  };
}

/**
 * A message of the chat as it is saved (chat.ts remember): what it said, when,
 * what it kept, its recap, the problem said under it and the agent it was asked of.
 */
export function toSavedTurn(m: {
  role: "user" | "assistant"; content: string; at?: number; kept?: string; computer?: ComputerRecap;
  warning?: AnswerWarning; ask?: AskQuote;
}): SavedTurn {
  return {
    role: m.role,
    content: m.content,
    ...(m.at != null ? { at: m.at } : {}),
    ...(m.kept ? { kept: m.kept } : {}),
    ...(m.role === "assistant" && m.computer ? { computer: m.computer } : {}),
    ...(m.warning ? { warning: m.warning } : {}),
    ...(m.ask ? { ask: m.ask } : {}),
  };
}

/** What a saved turn gives back to the chat's message (chat.ts openChat), checked: storage holds anything. */
export function fromSavedTurn(turn: SavedTurn): {
  at?: number; kept?: string; computer?: ComputerRecap; warning?: AnswerWarning; ask?: AskQuote;
} {
  const computer = turn.role === "assistant" ? cleanRecap(turn.computer) : undefined;
  const warning = savedWarning(turn.warning);
  const ask = askQuoteOf(turn.ask);
  return {
    at: typeof turn.at === "number" ? turn.at : undefined,
    kept: typeof turn.kept === "string" ? turn.kept : undefined,
    ...(computer ? { computer } : {}),
    ...(warning ? { warning } : {}),
    ...(ask ? { ask } : {}),
  };
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
  /**
   * A voice call's transcript (live/session.ts): `provider` names the call's,
   * not one picked in the chat, so reopening it leaves the picker as it is,
   * until a question asked in it in writing is answered (it has a `model` then).
   */
  call?: boolean;
  /** The CLI session that answered (Claude Code, Antigravity CLI), so reopening continues it. */
  session: string | null;
  turns: SavedTurn[];
  /** What the user ticked in the chat's checklists (core/checklists.ts), by list. */
  checklists?: ChatChecklists;
  /**
   * What the chat's AI may do without asking, picked with the shield in this
   * chat (chatPermissionsOf); none in a chat where it never was: it goes by
   * Settings → Security → Default permissions.
   */
  permissions?: ChatPermissions;
  /**
   * Who gave the chat its `title`: its AI, once its first answer was in
   * (Settings → Chat → Chat names, chat_title.rs), or the user, with the
   * pencil in Past chats. None: the start of its first question.
   */
  named?: ChatNamedBy;
}

const KEY = "lumo.chats.v1";
/** The oldest chats go past this many. */
export const MAX_CHATS = 40;
/**
 * The newest computer use recaps that keep their steps' small pictures in
 * the history; older ones keep their text (steps, actions, time). Storage is
 * shared with the chats and Lumo's other saved data, which come first.
 */
export const RECAP_PICTURES = 5;
/** The pictures kept in the history, all together, in characters of base64 at most. */
export const PICTURE_CHARS = 800_000;
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

/** How many characters a saved recap's pictures take (storage holds anything: 0 for what is not one). */
function pictureChars(recap: unknown): number {
  const steps = (recap as { steps?: unknown } | null)?.steps;
  if (!Array.isArray(steps)) return 0;
  let chars = 0;
  for (const step of steps) {
    const image = (step as { image?: unknown } | null)?.image;
    if (typeof image === "string") chars += image.length;
  }
  return chars;
}

/** A saved recap without its pictures: its text stays. */
function withoutPictures(recap: ComputerRecap): ComputerRecap {
  return {
    ...recap,
    steps: recap.steps.map((step) => {
      if (!step || typeof step !== "object") return step;
      const { image: _, ...rest } = step;
      return rest;
    }),
  };
}

/**
 * The list with the steps' pictures of its newest `recaps` computer use
 * recaps only, `chars` of base64 at most in all; the others keep their text.
 * The newest come first: the chats newest first, in each its last answers.
 */
export function boundPictures(list: SavedChat[], recaps = RECAP_PICTURES, chars = PICTURE_CHARS): SavedChat[] {
  let kept = 0;
  let used = 0;
  return list.map((chat) => {
    let turns: SavedTurn[] | null = null;
    for (let i = chat.turns.length - 1; i >= 0; i--) {
      const recap = chat.turns[i]?.computer;
      const size = pictureChars(recap);
      if (size === 0) continue;
      if (kept < recaps && used + size <= chars) {
        kept++;
        used += size;
        continue;
      }
      turns ??= chat.turns.slice();
      turns[i] = { ...turns[i], computer: withoutPictures(recap as ComputerRecap) };
    }
    return turns ? { ...chat, turns } : chat;
  });
}

/** How many recaps of the list still have pictures. */
function picturedRecaps(list: SavedChat[]): number {
  return list.reduce((n, chat) => n + chat.turns.filter((turn) => pictureChars(turn?.computer) > 0).length, 0);
}

/**
 * Writes the list, newest first, and returns what was kept. The recaps'
 * pictures are bounded first (boundPictures). Storage full: the pictures go,
 * the oldest recap's first, and only once none is left the oldest chats go
 * until it fits: a chat's text always wins over a picture. Kept whole, the
 * list never fit again, and nothing more was saved from then on, the newest
 * chat included.
 */
function store(list: SavedChat[]): SavedChat[] {
  const s = storage();
  if (!s) return list;
  let bounded = boundPictures(list);
  for (let pictured = picturedRecaps(bounded); ; pictured--) {
    try {
      s.setItem(KEY, JSON.stringify(bounded));
      return bounded;
    } catch {
      // Full: one recap's pictures fewer, the oldest.
    }
    if (pictured <= 0) break;
    bounded = boundPictures(bounded, pictured - 1, Infinity);
  }
  // An empty list is written too (the last chat deleted); a list that is not
  // keeps one chat at least.
  for (let keep = bounded.length - 1; keep >= Math.min(1, bounded.length); keep--) {
    const kept = bounded.slice(0, keep);
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

/**
 * The problem said under an answer: its kind and the CLI's words (Rust's
 * ChatWarning), said in the island's language when shown; or, saved by the
 * 0.22.2 betas, the words already written.
 */
export type AnswerWarning = { kind: "malformed" | "error"; message: string } | { line: string; detail: string };

/** A saved answer's warning (SavedTurn.warning), when it is one. */
export function savedWarning(w: unknown): AnswerWarning | undefined {
  const o = w as { kind?: unknown; message?: unknown; line?: unknown; detail?: unknown } | null | undefined;
  if (!o) return undefined;
  if ((o.kind === "malformed" || o.kind === "error") && typeof o.message === "string") return { kind: o.kind, message: o.message };
  return typeof o.line === "string" && typeof o.detail === "string" ? { line: o.line, detail: o.detail } : undefined;
}

/** The first question, on one line and shortened. */
export function chatTitle(turns: SavedTurn[]): string {
  const first = turns.find((t) => t.role === "user")?.content ?? "";
  const line = first.replace(/\s+/g, " ").trim();
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS - 1)}…` : line;
}

/** Who named a chat: its AI, or the user. */
export type ChatNamedBy = "ai" | "user";

/** The longest name the user may give a chat, in characters. */
export const NAME_CHARS = 80;

/**
 * The chats named so far, by id: read once from Past chats, then kept here,
 * so a chat named while it is still answered keeps its name when it is saved.
 */
const names = new Map<string, { title: string; by: ChatNamedBy }>();
let namesRead = false;

function namedOf(id: string, chats?: SavedChat[]): { title: string; by: ChatNamedBy } | null {
  if (!namesRead) {
    namesRead = true;
    for (const c of chats ?? loadChats()) {
      if ((c.named === "ai" || c.named === "user") && c.title.trim() && !names.has(c.id)) names.set(c.id, { title: c.title, by: c.named });
    }
  }
  return names.get(id) ?? null;
}

/** A chat's name: the one its AI or the user gave it, else the start of its first question. */
export function chatName(id: string, turns: SavedTurn[]): string {
  return namedOf(id)?.title ?? chatTitle(turns);
}

/** Who named the chat `id`, or null when nobody did. */
export function chatNamedBy(id: string): ChatNamedBy | null {
  return namedOf(id)?.by ?? null;
}

/**
 * Names the chat `id`: on one line, at most NAME_CHARS characters (never
 * half of one); saved at once when it is in Past chats, where it keeps its
 * place. False when nothing is left of the name.
 */
export function nameChat(id: string, title: string, by: ChatNamedBy): boolean {
  const name = [...title.replace(/\s+/g, " ").trim()].slice(0, NAME_CHARS).join("").trim();
  if (!name) return false;
  namedOf(id);
  names.set(id, { title: name, by });
  const list = loadChats();
  const chat = list.find((c) => c.id === id);
  if (chat) {
    chat.title = name;
    chat.named = by;
    store(list);
  }
  return true;
}

/** A first question with fewer words than this ("ciao", "ok") says too little: the name waits for the second answer. */
const FEW_WORDS = 3;
/** The exchanges a name is asked from, at most. */
const NAMING_EXCHANGES = 2;

/**
 * What the AI names a chat from (chat_title.rs): its first two questions with
 * their answers, leaving out commands ("/compact") and answers that failed or
 * said nothing. Null while there is too little to go on: no answer yet, or
 * one answer to a question of a word or two.
 */
export function namingExchanges(turns: { role: string; content: string; failed?: boolean }[]): [string, string][] | null {
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < turns.length && out.length < NAMING_EXCHANGES; i++) {
    const question = turns[i];
    const answer = turns[i + 1];
    if (question.role !== "user" || answer.role !== "assistant" || answer.failed) continue;
    if (question.content.trim().startsWith("/") || !answer.content.trim()) continue;
    out.push([question.content, answer.content]);
  }
  if (out.length === 0) return null;
  const words = out[0][0].trim().split(/\s+/).filter(Boolean).length;
  return out.length === 1 && words < FEW_WORDS ? null : out;
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

/** The provider and model chat `id` is on, if it has any yet (a voice call's has none). */
export function chatModelOf(id: string): ChatModel | null {
  const picked = picks.get(id);
  if (picked) return picked;
  const chat = loadChats().find((c) => c.id === id);
  if (!chat || typeof chat.provider !== "string" || !chat.provider) return null;
  if (chat.call === true && !chat.model) return null;
  return typeof chat.model === "string" && chat.model ? { provider: chat.provider, model: chat.model } : { provider: chat.provider };
}

/**
 * A chat's own permissions (the shield, views/chat.ts): the mode every
 * provider runs with but Antigravity CLI, and Antigravity CLI's own, as the
 * settings keep them (providers.ts storedPermissionMode, withPermissionMode).
 */
export interface ChatPermissions {
  chatPermissionMode: string;
  chatPermissionModeAgy: string;
}

/** Permissions picked in a chat not saved yet (its first answer still being written), until it is. */
const ownModes = new Map<string, ChatPermissions>();

function permissionsFrom(v: unknown): ChatPermissions | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  if (typeof p.chatPermissionMode !== "string") return null;
  return { chatPermissionMode: p.chatPermissionMode, chatPermissionModeAgy: typeof p.chatPermissionModeAgy === "string" ? p.chatPermissionModeAgy : "" };
}

/**
 * The permissions picked with the shield in chat `id`; a saved chat keeps
 * them where it is, its place in the history does not change.
 */
export function setChatPermissions(id: string, permissions: ChatPermissions) {
  const own = { chatPermissionMode: permissions.chatPermissionMode, chatPermissionModeAgy: permissions.chatPermissionModeAgy ?? "" };
  ownModes.set(id, own);
  const list = loadChats();
  const chat = list.find((c) => c.id === id);
  if (!chat) return;
  chat.permissions = own;
  store(list);
}

/** The permissions picked in chat `id`, null where none were (it goes by the default). */
export function chatPermissionsOf(id: string): ChatPermissions | null {
  const own = ownModes.get(id);
  if (own) return own;
  return permissionsFrom(loadChats().find((c) => c.id === id)?.permissions);
}

/**
 * What chat `id` may do without asking: its own permissions, else the
 * default ones of `settings` (Settings → Security → Default permissions),
 * which a new chat starts with.
 */
export function permissionsFor(id: string, settings: ChatPermissions): ChatPermissions {
  return chatPermissionsOf(id) ?? { chatPermissionMode: settings.chatPermissionMode, chatPermissionModeAgy: settings.chatPermissionModeAgy ?? "" };
}

/**
 * Saves `chat` (new, or replacing the one with its id) at the top of the
 * list. Its checklists' ticks stay as they were when `chat` brings none, and
 * a provider and model picked in it since win over the ones it brings; so do
 * its own permissions.
 */
export function saveChat(chat: SavedChat): SavedChat[] {
  const picked = picks.get(chat.id);
  if (picked) chat = { ...chat, provider: picked.provider, model: picked.model };
  const chats = loadChats();
  const permissions = ownModes.get(chat.id) ?? permissionsFrom(chat.permissions) ?? permissionsFrom(chats.find((c) => c.id === chat.id)?.permissions);
  ownModes.delete(chat.id);
  if (permissions) chat = { ...chat, permissions };
  const ticks = chat.checklists ?? chats.find((c) => c.id === chat.id)?.checklists ?? unsaved.get(chat.id);
  unsaved.delete(chat.id);
  // A name given to it, by its AI or the user, stays whatever the turns say.
  const name = namedOf(chat.id, chats);
  if (name) chat = { ...chat, title: name.title, named: name.by };
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
  names.delete(id);
  picks.delete(id);
  ownModes.delete(id);
  const list = loadChats().filter((c) => c.id !== id);
  store(list);
  setCompact(id, null);
  setChatCli(id, null);
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

const CLI_KEY = "lumo.chats.cli.v1";

function clis(): Record<string, string> {
  try {
    const raw = storage()?.getItem(CLI_KEY);
    const all = raw ? JSON.parse(raw) : {};
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
}

/**
 * A chat's CLI sessions (Claude Code's, Codex's…) and how much of the chat
 * each has seen, as Rust gave them last (chat.rs `Chat::cli_state`, opaque
 * here): given back when the chat is opened again, so a session still gets
 * the turns another provider answered meanwhile.
 */
export function cliOf(id: string): string | null {
  const c = clis()[id];
  return typeof c === "string" && c ? c : null;
}

/** Keeps (or with null forgets) a chat's CLI sessions; only chats still in the history keep them. */
export function setChatCli(id: string, cli: string | null) {
  const all = clis();
  if (all[id] === (cli ?? undefined)) return;
  if (cli) all[id] = cli;
  else delete all[id];
  const kept = new Set(loadChats().map((c) => c.id));
  kept.add(cli ? id : "");
  for (const key of Object.keys(all)) if (!kept.has(key)) delete all[key];
  try {
    storage()?.setItem(CLI_KEY, JSON.stringify(all));
  } catch {
    // Storage full: the sessions are taken as having seen every turn, as before.
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
