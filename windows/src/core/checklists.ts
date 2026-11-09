// The checklists in a chat's answers (views/rich/checklist.ts draws them):
// GitHub's task lists, `- [ ] text` and `- [x] text`, or the same lines in a
// ```lumo-checklist block that gives them a title. Pure helpers, so they can
// be tested without a webview:
// - reading a list's lines;
// - telling which lists of a chat are one list written again: the same
//   title, or, untitled, most of the same lines. The newest is the live one,
//   the older ones show as "Updated below";
// - what is ticked: the user's ticks (saved with the chat, core/chats.ts) by
//   the item's text, and the items the AI marked [x];
// - the line that tells the AI what the user ticked, sent with the next
//   question when it differs from what the AI last wrote.

export interface ChecklistItem {
  /** Its inline Markdown, as written. */
  text: string;
  /** Marked [x] where it was written. */
  done: boolean;
  /** Its nesting, from 0. */
  indent: number;
}

export interface Checklist {
  /** The title after ```lumo-checklist; "" for a task list in the text. */
  title: string;
  items: ChecklistItem[];
}

/** `- [ ] text`, `* [x] text`, `+ [X] text`: one item of a task list. */
const TASK = /^([ \t]*)[-*+][ \t]+\[([ xX])\][ \t]+(\S.*)$/;

/** More items than this and the rest are left out. */
export const MAX_ITEMS = 60;

/** The item on `line`, or null when it is not a task list item. */
export function taskItem(line: string): ChecklistItem | null {
  const m = TASK.exec(line.replace(/\s+$/, ""));
  if (!m) return null;
  const spaces = m[1].replace(/\t/g, "  ").length;
  return { text: m[3].trim(), done: m[2] !== " ", indent: Math.min(Math.floor(spaces / 2), 4) };
}

/**
 * A ```lumo-checklist block: its task list lines, a plain list item or a
 * line of text counting as an item not done yet. Null when there is no item.
 */
export function parseChecklist(title: string, body: string): Checklist | null {
  const items: ChecklistItem[] = [];
  for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
    if (!raw.trim()) continue;
    const task = taskItem(raw);
    if (task) {
      items.push(task);
    } else {
      const plain = /^([ \t]*)(?:[-*+]|\d+[.)])[ \t]+(.*)$/.exec(raw);
      const text = (plain ? plain[2] : raw).trim();
      if (!text || /^`{3,}/.test(text)) continue;
      const spaces = plain ? plain[1].replace(/\t/g, "  ").length : 0;
      items.push({ text, done: false, indent: Math.min(Math.floor(spaces / 2), 4) });
    }
    if (items.length >= MAX_ITEMS) break;
  }
  return items.length ? { title: title.trim(), items } : null;
}

/**
 * An item's text as compared between versions of a list: no Markdown marks,
 * spaces folded, lower case. "Run `npm test`" and "run npm  test" are one item.
 */
export function itemKey(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ── One list written again ────────────────────────────────────────────────────

/** The checklists found in one answer: its place in the chat's messages, and its lists in order. */
export interface FoundLists {
  message: number;
  lists: Checklist[];
}

/** Which list a checklist is, and whether it is the newest version of it. */
export interface Slot {
  /** The list's identity in the chat: "t:" and its title, or "u:" and its number among the untitled ones. */
  id: string;
  /** The newest version: the one the user ticks. */
  live: boolean;
  /** The message this version is in. */
  message: number;
}

/** A list across the chat: its identity and its newest version. */
export interface Lineage {
  id: string;
  title: string;
  message: number;
  list: Checklist;
}

/** Where a checklist is: the message, then its place among that message's lists. */
export const placeKey = (message: number, ordinal: number) => `${message}:${ordinal}`;

/**
 * Tells which checklists of a chat are one list: the same title, or, for
 * untitled ones, an earlier untitled list sharing more than half of the
 * newer one's items. Each list's newest version is the live one.
 */
export function resolveChecklists(found: FoundLists[]): { slots: Map<string, Slot>; lineages: Lineage[] } {
  const ordered = [...found].sort((a, b) => a.message - b.message);
  const lineages: (Lineage & { keys: Set<string> })[] = [];
  const places: { key: string; lineage: Lineage & { keys: Set<string> }; message: number }[] = [];
  let untitled = 0;
  for (const { message, lists } of ordered) {
    lists.forEach((list, ordinal) => {
      const keys = new Set(list.items.map((i) => itemKey(i.text)));
      // A list already given a version in this message is not given a second one.
      const free = (l: Lineage) => l.message !== message;
      let lineage: (Lineage & { keys: Set<string> }) | undefined;
      if (list.title) {
        // The same title twice in one answer is two lists: the second gets a number.
        const base = `t:${itemKey(list.title)}`;
        for (let n = 1; !lineage; n++) {
          const id = n === 1 ? base : `${base}\u0000${n}`;
          const same = lineages.find((l) => l.id === id);
          if (!same) {
            lineage = { id, title: list.title, message, list, keys };
            lineages.push(lineage);
          } else if (free(same)) {
            lineage = same;
          }
        }
      } else {
        let best = 0;
        for (const l of lineages) {
          if (l.title || !free(l)) continue;
          let common = 0;
          for (const k of keys) if (l.keys.has(k)) common++;
          if (common * 2 > keys.size && common >= best) {
            best = common;
            lineage = l;
          }
        }
        if (!lineage) {
          lineage = { id: `u:${untitled++}`, title: "", message, list, keys };
          lineages.push(lineage);
        }
      }
      lineage.message = message;
      lineage.list = list;
      lineage.keys = keys;
      places.push({ key: placeKey(message, ordinal), lineage, message });
    });
  }
  const slots = new Map<string, Slot>();
  for (const p of places) slots.set(p.key, { id: p.lineage.id, live: p.lineage.message === p.message, message: p.message });
  return { slots, lineages: lineages.map(({ keys: _, ...l }) => l) };
}

// ── What is ticked ────────────────────────────────────────────────────────────

/** A tick the user gave or took off, and the message whose list it was given on. */
export interface Tick {
  done: boolean;
  at: number;
}

/** What a chat keeps of one list: the user's ticks by item text, and what the AI was last told. */
export interface ChecklistMemory {
  ticks: Record<string, Tick>;
  told?: string;
}

/** A chat's lists, by their identity (Slot.id). */
export type ChatChecklists = Record<string, ChecklistMemory>;

/**
 * Each item of the version in message `at`, ticked or not. A tick given on
 * this version stands; otherwise an item the AI marked [x] is ticked, and
 * the user's tick from an earlier version carries over to the same text.
 */
export function itemsDone(list: Checklist, at: number, memory?: ChecklistMemory | null): boolean[] {
  return list.items.map((item) => {
    const tick = memory?.ticks[itemKey(item.text)];
    if (tick && tick.at >= at) return tick.done;
    if (item.done) return true;
    return tick?.done ?? false;
  });
}

/** `memory` with the item `text` ticked (or not) on the version in message `at`. */
export function withTick(memory: ChecklistMemory | undefined, text: string, done: boolean, at: number): ChecklistMemory {
  return { ...memory, ticks: { ...memory?.ticks, [itemKey(text)]: { done, at } } };
}

/** Keeps only well-formed lists from what storage gave back. */
export function cleanChecklists(raw: unknown): ChatChecklists {
  const out: ChatChecklists = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const v = value as ChecklistMemory;
    if (!v || typeof v !== "object" || !v.ticks || typeof v.ticks !== "object") continue;
    const ticks: Record<string, Tick> = {};
    for (const [k, tick] of Object.entries(v.ticks)) {
      if (tick && typeof tick.done === "boolean" && typeof tick.at === "number") ticks[k] = { done: tick.done, at: tick.at };
    }
    out[id] = typeof v.told === "string" ? { ticks, told: v.told } : { ticks };
  }
  return out;
}

// ── Telling the AI ────────────────────────────────────────────────────────────

/** An item's text on one line, for the AI. */
const plain = (text: string) => text.replace(/\s+/g, " ").trim();

/** `Checklist "Release": done: a; b. To do: c.` */
export function stateLine(list: Checklist, done: boolean[]): string {
  const name = list.title ? `Checklist "${plain(list.title)}"` : "Checklist";
  const did = list.items.filter((_, i) => done[i]).map((i) => plain(i.text));
  const todo = list.items.filter((_, i) => !done[i]).map((i) => plain(i.text));
  return `${name}: done: ${did.length ? did.join("; ") : "none"}. To do: ${todo.length ? todo.join("; ") : "none"}.`;
}

/**
 * What to tell the AI with the next question: a line for each live list
 * whose ticks differ from what the AI last wrote, unless it was told that
 * already. `told` is what to remember as told, by list.
 */
export function checklistNote(lineages: Lineage[], memory: ChatChecklists): { text: string; told: Record<string, string> } {
  const lines: string[] = [];
  const told: Record<string, string> = {};
  for (const l of lineages) {
    const done = itemsDone(l.list, l.message, memory[l.id]);
    if (done.every((d, i) => d === l.list.items[i].done)) continue;
    const said = `${l.message}|${done.map((d) => (d ? 1 : 0)).join("")}`;
    if (memory[l.id]?.told === said) continue;
    lines.push(stateLine(l.list, done));
    told[l.id] = said;
  }
  return { text: lines.join("\n"), told };
}

// ── The chat on screen ────────────────────────────────────────────────────────
//
// chat.ts says which lists each answer of a chat holds before it draws them;
// a card then finds its own slot by its message and its place in it.

const known = new Map<string, { found: FoundLists[]; slots: Map<string, Slot>; lineages: Lineage[] }>();
/** At most this many chats are known at once (the ones drawn lately). */
const KNOWN_LIMIT = 20;

/** Goes up each time a list's slot changes in any chat: a card drawn before is drawn again. */
let epoch = 0;

/** What changes when the slots do. */
const slotsSignature = (slots: Map<string, Slot>) => [...slots].map(([k, s]) => `${k}=${s.id}:${s.live ? 1 : 0}`).join("\n");

/** The lists in `chatId`'s answers, by message. */
export function noteChatChecklists(chatId: string, found: FoundLists[]) {
  const resolved = resolveChecklists(found);
  const before = known.get(chatId);
  if (before && slotsSignature(before.slots) !== slotsSignature(resolved.slots)) epoch++;
  known.delete(chatId);
  known.set(chatId, { found, ...resolved });
  if (known.size > KNOWN_LIMIT) known.delete(known.keys().next().value as string);
}

/** The slot of the `ordinal`-th list of message `message` in `chatId`, if chat.ts noted it. */
export function slotOf(chatId: string, message: number, ordinal: number): Slot | null {
  return known.get(chatId)?.slots.get(placeKey(message, ordinal)) ?? null;
}

/** markdown.ts keeps a checklist card's node across redraws only while this stays the same. */
export function checklistsEpoch(): number {
  return epoch;
}

/** The live version of each of `chatId`'s lists. */
export function lineagesOf(chatId: string): Lineage[] {
  return known.get(chatId)?.lineages ?? [];
}

/** A message's scope for renderMarkdown: its chat and its place in it. */
export function messageScope(chatId: string, message: number): string {
  return `${chatId}#${message}`;
}

/** The chat and message of a scope made by messageScope; null for any other. */
export function scopeMessage(scope: string): { chatId: string; message: number } | null {
  const m = /^(.*)#(\d+)$/.exec(scope);
  return m ? { chatId: m[1], message: Number(m[2]) } : null;
}

/** A chat message as far as the checklists go. */
interface MessageLike {
  role: "user" | "assistant";
  content: string;
  failed?: boolean;
}

/**
 * The lists in a chat's answers, each answer placed by its number among the
 * messages kept with the chat (a failed answer is never kept), then those of
 * the answer being written, if any. `listsOf` reads one answer.
 */
export function listsInChat(history: MessageLike[], listsOf: (text: string) => Checklist[], writing?: Checklist[]): FoundLists[] {
  const found: FoundLists[] = [];
  let at = 0;
  for (const m of history) {
    if (m.failed) continue;
    if (m.role === "assistant") {
      const lists = listsOf(m.content);
      if (lists.length) found.push({ message: at, lists });
    }
    at++;
  }
  if (writing?.length) found.push({ message: at, lists: writing });
  return found;
}

/** The number of the next message kept with the chat: the answer being written. */
export function nextMessage(history: MessageLike[]): number {
  return history.filter((m) => !m.failed).length;
}

/** `memory` remembering what the AI was just told (checklistNote's `told`). */
export function withTold(memory: ChatChecklists, told: Record<string, string>): ChatChecklists {
  const out = { ...memory };
  for (const [id, said] of Object.entries(told)) out[id] = { ...out[id], ticks: out[id]?.ticks ?? {}, told: said };
  return out;
}
