// The agents a chat's answer started, and the chat's sign of life (concept:
// concepts/sotto-agenti). Pure, so it can be tested without a webview: the
// chat (views/chat.ts) feeds it the `chat-agent` and `chat-signal` events
// (chat_agents.rs) and draws what it holds (views/agents-card.ts).
//
// A CLI that answers in the chat (Claude Code above all) can start agents of
// its own, often in the background: its turn ends, the dots go, and the chat
// looked finished while eight agents worked. Each one is now a row, kept per
// chat, in the batch of the answer that started it. And for every provider,
// the time of the last sign of life tells "working" from "stuck": past a
// threshold that depends on who answers and what it is doing, the row or the
// typing line says "no signal for 6 min" (`stallOf`). Waiting for the user's
// permission is never stuck: it says so instead.

import type { ChatActivity, ChatAgent, ChatAgentEvent, ChatSignalEvent } from "./bridge";
import type { AskQuote, SavedAgent, SavedTalk, SavedTurn } from "./chats";
import type { AgentsPeek } from "./compact";
import { isApiProvider, isCliProvider } from "./providers";
import { N_, t, tn } from "../i18n/i18n";

// ── Thresholds ────────────────────────────────────────────────────────────────

/** A CLI's agent with no news for this long (s) is said to give no sign. */
export const AGENT_STALL_S = 300;
/** A provider called by its API (Anthropic, OpenAI, Google, OpenRouter) streams all along. */
export const CLOUD_STALL_S = 45;
/** A local model writing or calling its tools sends something every moment… */
export const LOCAL_STREAM_STALL_S = 20;
/** …but starting its server, loading the model or reading a long prompt takes its time. */
export const LOCAL_START_STALL_S = 90;
/** A CLI thinking between its tools. */
export const CLI_STALL_S = 120;
/** A CLI running a command, a sub-task or a tool: slow ones are common. */
export const CLI_TOOL_STALL_S = 300;

/** The steps kept per agent, newest first, for its open row. */
export const MAX_AGENT_STEPS = 5;
/** The agents kept with a saved answer. */
export const MAX_SAVED_AGENTS = 24;

/** What a local model does before its first word: slow, but alive (a retry reads the prompt again). */
const LOCAL_STARTING = new Set(["starting", "loading", "prompt", "retry"]);
/** What a CLI does that can rightly last minutes without a word. */
const CLI_LONG = new Set(["command", "subtask", "tool", "calling"]);

// ── The store ─────────────────────────────────────────────────────────────────

/** One thing an agent did, as its `now` said, and when. */
export interface AgentStep {
  now: ChatActivity;
  at: number;
}

/** One agent as the island keeps it: its last whole state, what it did lately. */
export interface AgentEntry {
  row: ChatAgent;
  /** Newest first, at most MAX_AGENT_STEPS. */
  steps: AgentStep[];
  /** The user said Wait: no warning about it before then (epoch ms). */
  snoozedUntil?: number;
}

/**
 * The agents one answer started, shown together under it. `anchor` is that
 * answer's place among the chat's answers (failed ones not counted), 0 first:
 * the answer being written when it is past the last one.
 */
export interface AgentBatch {
  anchor: number;
  ids: string[];
  /** Resume was sent for its agents that stopped halfway. */
  resumed?: boolean;
}

/** Everything known of one chat's agents and sign of life. */
export interface ChatAgents {
  rows: Map<string, AgentEntry>;
  batches: AgentBatch[];
  /** The last sign of life of the chat's answer, or of any of its agents (epoch ms); 0 for none. */
  lastSignalAt: number;
  /** The answer waits for the user: a permission card is up. */
  waiting: "permission" | null;
  /** Agents of answers the user took back (an edited question, `rewindAgents`): their late news is ignored. */
  dropped?: Set<string>;
  /** The messages the chat's CLI sent its agents, oldest first: a "Talking to …" box each, under its answer. */
  talks: TalkEntry[];
}

/** A message the CLI sent one of its agents (`ChatAgent.talk`), under the answer `anchor`. */
export interface TalkEntry {
  call: string;
  agentId: string;
  /** The agent's title when it was sent. */
  title: string;
  anchor: number;
  message: string;
  sentAt: number;
  reply?: string;
  repliedAt?: number;
  failed?: string;
  /** From a chat saved before it was answered: its answer will never come. */
  stale?: boolean;
}

/** The talks kept per chat. */
export const MAX_TALKS = 40;

/** Every chat's, by chat id. */
export type AgentStore = Map<string, ChatAgents>;

/** The chats the user deleted, by store (`forgetChat`): late news of theirs is ignored, never a chat again. */
const deletedChats = new WeakMap<AgentStore, Set<string>>();

/** The chat `chat` was deleted. */
function isDeleted(store: AgentStore, chat: string): boolean {
  return deletedChats.get(store)?.has(chat) ?? false;
}

export function newAgentStore(): AgentStore {
  return new Map();
}

/** The chat's agents, made the first time. */
export function chatAgentsOf(store: AgentStore, chat: string): ChatAgents {
  let c = store.get(chat);
  if (!c) {
    c = { rows: new Map(), batches: [], lastSignalAt: 0, waiting: null, talks: [] };
    store.set(chat, c);
  }
  return c;
}

/** Done, failed and stopped never change again. */
export function isFinal(state: ChatAgent["state"]): boolean {
  return state === "done" || state === "failed" || state === "stopped";
}

/** The agents of a chat still at work (or waiting). */
export function openCount(c: ChatAgents | undefined): number {
  if (!c) return 0;
  let n = 0;
  for (const e of c.rows.values()) if (!isFinal(e.row.state)) n++;
  return n;
}

function sameActivity(a: ChatActivity | undefined, b: ChatActivity | undefined): boolean {
  return !!a && !!b && a.kind === b.kind && a.detail === b.detail;
}

/**
 * A `chat-agent` event: the agent's whole state, which replaces what was
 * known. One that already ended keeps its end (a late event never brings it
 * back), unless a message took it up again (a higher `round`); an event of
 * an earlier round is late. A new one joins the batch still at work, or the
 * one of the same answer; otherwise it starts a batch under the answer
 * `anchor` (asked only then, when a function). Its talk (a message its CLI
 * sent it) joins the chat's talks. True when something changed.
 */
export function applyAgent(store: AgentStore, ev: ChatAgentEvent, anchor: number | (() => number)): boolean {
  const agent = ev?.agent;
  if (!ev?.chat || !agent?.id || isDeleted(store, ev.chat)) return false;
  const c = chatAgentsOf(store, ev.chat);
  if (c.dropped?.has(agent.id)) return false;
  const known = c.rows.get(agent.id);
  const round = agent.round ?? 0;
  const knownRound = known?.row.round ?? 0;
  if (known && (round < knownRound || (round === knownRound && isFinal(known.row.state) && !isFinal(agent.state)))) return false;
  const entry: AgentEntry = known ?? { row: agent, steps: [] };
  // Worked out only when needed: the chat may have to be read from Past chats.
  const at = () => (typeof anchor === "function" ? (anchor = anchor()) : anchor);
  if (agent.talk) noteTalk(c, agent, at);
  if (!known) {
    const anchor = at();
    const last = c.batches.at(-1);
    const lastOpen = last ? last.ids.some((id) => { const r = c.rows.get(id); return r && !isFinal(r.row.state); }) : false;
    if (last && (lastOpen || last.anchor === anchor)) last.ids.push(agent.id);
    else c.batches.push({ anchor, ids: [agent.id] });
    c.rows.set(agent.id, entry);
  }
  entry.row = agent;
  if (agent.now && !sameActivity(entry.steps[0]?.now, agent.now)) {
    entry.steps = [{ now: agent.now, at: agent.lastSignalAt || Date.now() }, ...entry.steps].slice(0, MAX_AGENT_STEPS);
  }
  c.lastSignalAt = Math.max(c.lastSignalAt, agent.lastSignalAt || 0);
  return true;
}

/** The talk an agent's row carries, added to the chat's talks or brought up to date. */
function noteTalk(c: ChatAgents, agent: ChatAgent, anchor: () => number) {
  const talk = agent.talk!;
  const known = c.talks.find((x) => x.call === talk.call);
  if (known) {
    known.reply = talk.reply;
    known.repliedAt = talk.repliedAt;
    known.failed = talk.failed;
    return;
  }
  c.talks.push({
    call: talk.call, agentId: agent.id, title: agent.title, anchor: anchor(), message: talk.message, sentAt: talk.sentAt,
    reply: talk.reply, repliedAt: talk.repliedAt, failed: talk.failed,
  });
  if (c.talks.length > MAX_TALKS) c.talks.splice(0, c.talks.length - MAX_TALKS);
}

/** A talk still waiting for its agent's answer. */
export function talkWaits(talk: { reply?: string; failed?: string; stale?: boolean }): boolean {
  return !talk.reply && !talk.failed && !talk.stale;
}

/** The newest talk of the chat still waiting for its answer, if any. */
export function waitingTalk(c: ChatAgents | undefined): TalkEntry | undefined {
  for (let i = (c?.talks.length ?? 0) - 1; i >= 0; i--) if (talkWaits(c!.talks[i])) return c!.talks[i];
  return undefined;
}

// ── Ask ───────────────────────────────────────────────────────────────────────
//
// Ask on an agent's row puts it over the field, as a quote (WhatsApp's
// Reply); what is typed then goes to the chat's CLI with what it takes to
// pass it on to that agent (Claude Code's SendMessage), and the CLI's
// message and the agent's answer show in a "Talking to …" box.

/** Whether the chat can pass this agent a message: its CLI said so (Claude Code with SendMessage, still running). */
export function askable(e: AgentEntry | undefined): boolean {
  return !!e?.row.canAsk;
}

/**
 * What goes to the CLI for a question asked of one agent: pass it on with
 * SendMessage, and say what came back. English, as toolAsk: it is for the AI,
 * which answers in the user's language. Of an agent with no sign of life, or
 * one that ended, the CLI is told to look at what it did when no answer comes.
 */
export function agentAsk(q: AskQuote, question: string): string {
  const to = JSON.stringify(q.agentId);
  let ask = `My question below is for your agent "${q.title}" (agentId: ${q.agentId}). Send it to that agent with SendMessage (to: ${to}), then tell me its answer.`;
  if (q.look === "stalled") ask += " It has given no sign of life for a while: if it does not answer, look at what it did last and tell me why it is stuck.";
  else if (q.look === "done" || q.look === "failed") ask += " It had ended: the message takes it up again.";
  return `${ask}\n\n${question}`;
}

/** A `chat-signal` event: the answer moved, and maybe started or stopped waiting. True when that changes what shows. */
export function applySignal(store: AgentStore, ev: ChatSignalEvent): boolean {
  if (!ev?.chat || isDeleted(store, ev.chat)) return false;
  const c = chatAgentsOf(store, ev.chat);
  let changed = false;
  if (typeof ev.at === "number" && ev.at > c.lastSignalAt) {
    c.lastSignalAt = ev.at;
    changed = true;
  }
  if ("waiting" in ev) {
    const waiting = ev.waiting === "permission" ? "permission" : null;
    if (waiting !== c.waiting) {
      c.waiting = waiting;
      changed = true;
    }
  }
  return changed;
}

/** The answer of `chat` moved at `at` (a piece of text, a tool call shown): a sign of life too. */
export function noteSignal(store: AgentStore, chat: string, at = Date.now()) {
  if (isDeleted(store, chat)) return;
  const c = chatAgentsOf(store, chat);
  if (at > c.lastSignalAt) c.lastSignalAt = at;
}

/** A batch's agents, in the order they started. */
export function batchEntries(c: ChatAgents, batch: AgentBatch): AgentEntry[] {
  return batch.ids.map((id) => c.rows.get(id)).filter((e): e is AgentEntry => !!e);
}

// ── Liveness ──────────────────────────────────────────────────────────────────

/** What is checked for a sign of life: one agent, or the answer being written. */
export type Liveness =
  | { kind: "agent"; lastSignalAt: number; snoozedUntil?: number; waiting?: boolean }
  | { kind: "turn"; provider: string; activity: ChatActivity | null; lastSignalAt: number; waiting?: boolean };

/** How long (s) `l` may go without a sign of life before it is said. */
export function stallAfter(l: Liveness): number {
  if (l.kind === "agent") return AGENT_STALL_S;
  const kind = l.activity?.kind ?? "";
  if (isCliProvider(l.provider)) return CLI_LONG.has(kind) ? CLI_TOOL_STALL_S : CLI_STALL_S;
  if (isApiProvider(l.provider)) return CLOUD_STALL_S;
  // The model servers: Ollama, LM Studio, Unsloth Studio, a custom one.
  return LOCAL_STARTING.has(kind) ? LOCAL_START_STALL_S : LOCAL_STREAM_STALL_S;
}

/**
 * Whether `l` has given no sign of life for too long: null while it is fine
 * (or waiting for the user, which is never stuck), else for how many seconds.
 */
export function stallOf(l: Liveness, now = Date.now()): { seconds: number } | null {
  if (l.waiting || !l.lastSignalAt) return null;
  if (l.kind === "agent" && l.snoozedUntil && now < l.snoozedUntil) return null;
  const seconds = Math.floor((now - l.lastSignalAt) / 1000);
  return seconds >= stallAfter(l) ? { seconds } : null;
}

/** How an agent shows: its colour and its marker (concept 3). */
export type AgentLook = "done" | "working" | "stalled" | "waiting" | "failed";

/** An agent's look now. `permission`: the agents a card waits on (`permissionMatch`). */
export function lookOf(e: AgentEntry, now = Date.now(), permission?: ReadonlySet<string>): AgentLook {
  const s = e.row.state;
  if (s === "done") return "done";
  if (s === "failed" || s === "stopped") return "failed";
  if (s === "waiting" || permission?.has(e.row.id) || computerOf(e.row.id)?.waits) return "waiting";
  return agentStall(e, now) ? "stalled" : "working";
}

/** An agent at work with no sign of life for too long (not one waiting in line for the computer). */
export function agentStall(e: AgentEntry, now = Date.now()): { seconds: number } | null {
  if (isFinal(e.row.state) || e.row.state === "waiting" || computerOf(e.row.id)?.waits) return null;
  return stallOf({ kind: "agent", lastSignalAt: e.row.lastSignalAt, snoozedUntil: e.snoozedUntil }, now);
}

/** The user said Wait on an agent with no sign: no warning for another threshold. */
export function snooze(e: AgentEntry, now = Date.now()) {
  e.snoozedUntil = now + AGENT_STALL_S * 1000;
}

export interface AgentCounts {
  total: number;
  done: number;
  working: number;
  stalled: number;
  waiting: number;
  failed: number;
  /** Still going: working, stalled or waiting. */
  open: number;
}

/** How many agents show each way, for the card's header and the closed island. */
export function countAgents(entries: AgentEntry[], now = Date.now(), permission?: ReadonlySet<string>): AgentCounts {
  const n: AgentCounts = { total: entries.length, done: 0, working: 0, stalled: 0, waiting: 0, failed: 0, open: 0 };
  for (const e of entries) n[lookOf(e, now, permission)]++;
  n.open = n.working + n.stalled + n.waiting;
  return n;
}

/** A segment per agent, in their order: what the header's bar draws. */
export function looksOf(entries: AgentEntry[], now = Date.now(), permission?: ReadonlySet<string>): AgentLook[] {
  return entries.map((e) => lookOf(e, now, permission));
}

/** The longest an agent of `entries` has gone without a sign, among those said to give none. */
export function worstStall(entries: AgentEntry[], now = Date.now()): { seconds: number } | null {
  let worst: { seconds: number } | null = null;
  for (const e of entries) {
    const s = agentStall(e, now);
    if (s && (!worst || s.seconds > worst.seconds)) worst = s;
  }
  return worst;
}

// ── The computer, one agent at a time ─────────────────────────────────────────
//
// Rust keeps the line for the one screen (computer_turns.rs) and sends it
// whole as `computer-turns` when it changes: who holds the computer, and who
// waits for it, in order, since when. One line for every chat.

/** The line for the computer, as Rust sends it. */
export interface ComputerTurns {
  holder: { chat: string; agent: string; sinceMs: number } | null;
  waiting: { chat: string; agent: string; sinceMs: number; place: number }[];
}

let computerTurns: ComputerTurns = { holder: null, waiting: [] };

/** A `computer-turns` event: true when the line changed. */
export function applyComputerTurns(ev: ComputerTurns | null | undefined): boolean {
  const next: ComputerTurns = {
    holder: ev?.holder && typeof ev.holder.agent === "string" ? ev.holder : null,
    waiting: Array.isArray(ev?.waiting) ? ev!.waiting.filter((w) => typeof w?.agent === "string") : [],
  };
  if (JSON.stringify(next) === JSON.stringify(computerTurns)) return false;
  computerTurns = next;
  return true;
}

/** Where agent `agentId` stands for the computer: it holds it, or waits at `place` of `of` since `since`; null if neither. */
export function computerOf(agentId: string): { holds: true; waits?: undefined } | { holds?: undefined; waits: true; place: number; of: number; since: number } | null {
  if (computerTurns.holder?.agent === agentId) return { holds: true };
  const w = computerTurns.waiting.find((x) => x.agent === agentId);
  return w ? { waits: true, place: w.place, of: computerTurns.waiting.length, since: w.sinceMs } : null;
}

/** Whether anyone holds or waits for the computer: the card's seconds then count. */
export function computerBusy(): boolean {
  return computerTurns.holder != null || computerTurns.waiting.length > 0;
}

// ── Permission cards ──────────────────────────────────────────────────────────

/** A permission card waiting for the user (state.ts ApprovalInfo, with the agent that asked when the hook said). */
export interface PendingCard {
  sessionId: string;
  agentId?: string;
  fromChat?: boolean;
}

/**
 * Which of a chat's agents, or its answer itself, a waiting card is for. A
 * card from inside an agent carries its id (Claude Code's `agent_id`); one
 * of the chat's session without it is the answer's own. `session` null (the
 * first question, not answered yet): the chat's cards are those of the chat on screen.
 */
export function permissionMatch(
  cards: readonly (PendingCard | null | undefined)[], session: string | null, onScreen: boolean, ids: Iterable<string>,
): { main: boolean; agents: Set<string> } {
  const known = new Set(ids);
  const agents = new Set<string>();
  let main = false;
  for (const card of cards) {
    if (!card?.fromChat) continue;
    if (card.agentId && known.has(card.agentId)) {
      agents.add(card.agentId);
      continue;
    }
    const ours = session ? card.sessionId === session : onScreen;
    if (ours) main = true;
  }
  return { main, agents };
}

// ── Saved with the chat ───────────────────────────────────────────────────────

/** The agents kept with an answer: those that ended, in short, at most MAX_SAVED_AGENTS. */
export function savedAgents(entries: AgentEntry[]): SavedAgent[] {
  return entries
    .filter((e) => isFinal(e.row.state))
    .slice(-MAX_SAVED_AGENTS)
    .map(({ row }) => ({
      id: row.id,
      title: row.title,
      state: row.state as SavedAgent["state"],
      ...(row.summary ? { summary: row.summary } : {}),
      ...(row.error ? { error: row.error } : {}),
      steps: row.steps,
      ...(row.tokens != null ? { tokens: row.tokens } : {}),
      startedAt: row.startedAt,
      ...(row.endedAt != null ? { endedAt: row.endedAt } : {}),
    }));
}

/**
 * The turns to save, each answer with its agents and the messages sent to
 * them: an answer's place among the answers is their anchor.
 */
export function withAgents<T extends { role: string }>(c: ChatAgents | undefined, turns: T[]): (T & Pick<SavedTurn, "agents" | "talks">)[] {
  if (!c || (c.batches.length === 0 && c.talks.length === 0)) return turns;
  let answer = -1;
  const answers = turns.filter((x) => x.role === "assistant").length;
  // Anchored past the last answer (its answer was stopped or failed): with
  // the question still unanswered after it, else with that answer.
  const unanswered = turns.length > 0 && turns[turns.length - 1].role === "user";
  return turns.map((turn, i) => {
    let mine: (anchor: number) => boolean;
    if (turn.role === "assistant") {
      const at = ++answer;
      mine = (a) => a === at || (!unanswered && at === answers - 1 && a > at);
    } else if (unanswered && i === turns.length - 1) {
      mine = (a) => a >= answers;
    } else {
      return turn;
    }
    const agents = savedAgents(c.batches.filter((b) => mine(b.anchor)).flatMap((b) => batchEntries(c, b)));
    const talks = c.talks.filter((x) => mine(x.anchor)).map(savedTalk);
    if (!agents.length && !talks.length) return turn;
    return { ...turn, ...(agents.length ? { agents } : {}), ...(talks.length ? { talks } : {}) };
  });
}

function savedTalk(x: TalkEntry): SavedTalk {
  return {
    call: x.call, agentId: x.agentId, title: x.title, message: x.message, sentAt: x.sentAt,
    ...(x.reply ? { reply: x.reply } : {}), ...(x.failed ? { failed: x.failed } : {}),
  };
}

function isSavedTalk(x: unknown): x is SavedTalk {
  const v = x as SavedTalk;
  return !!v && typeof v.call === "string" && typeof v.agentId === "string" && typeof v.title === "string"
    && typeof v.message === "string" && typeof v.sentAt === "number";
}

function isSavedAgent(a: unknown): a is SavedAgent {
  const x = a as SavedAgent;
  return !!x && typeof x.id === "string" && typeof x.title === "string" && typeof x.state === "string" && isFinal(x.state);
}

/**
 * A chat opened from Past chats: its answers' agents come back,
 * unless the island still holds them (agents still at work there).
 */
export function restoreAgents(store: AgentStore, chat: string, turns: readonly Pick<SavedTurn, "role" | "agents" | "talks">[], source = "") {
  const known = store.get(chat);
  if (known && (known.batches.length > 0 || known.talks.length > 0)) return;
  const c = chatAgentsOf(store, chat);
  let answer = -1;
  for (const turn of turns) {
    // A question's: the agents of its answer that never came, past the last answer.
    const anchor = turn.role === "assistant" ? ++answer : answer + 1;
    const talks = Array.isArray(turn.talks) ? turn.talks.filter(isSavedTalk) : [];
    // Not answered when it was saved: its answer will not come any more.
    for (const x of talks) c.talks.push({ ...x, anchor, ...(x.reply || x.failed ? {} : { stale: true }) });
    const agents = Array.isArray(turn.agents) ? turn.agents.filter(isSavedAgent) : [];
    if (!agents.length) continue;
    for (const a of agents) {
      c.rows.set(a.id, {
        row: {
          id: a.id, source, title: a.title, state: a.state, summary: a.summary, error: a.error,
          steps: typeof a.steps === "number" ? a.steps : 0, tokens: a.tokens, startedAt: a.startedAt || 0,
          lastSignalAt: a.endedAt || a.startedAt || 0, endedAt: a.endedAt, background: false, canStop: false,
        },
        steps: [],
      });
    }
    c.batches.push({ anchor, ids: agents.map((a) => a.id), resumed: true });
  }
}

/**
 * The user edited a question: the answers from it on leave the chat
 * (chat.ts rewindTo), and so do the agents they started. `answers` is how
 * many answers stay (failed ones not counted). The ids of the agents that
 * go are kept aside, so the end Rust still sends for those at work ("Claude
 * Code ended" once the next question starts a new session) makes no batch
 * of its own; the next agent starts a batch of its own under the new answer.
 */
export function rewindAgents(store: AgentStore, chat: string, answers: number) {
  const c = store.get(chat);
  if (!c) return;
  c.talks = c.talks.filter((x) => x.anchor < answers);
  const going = c.batches.filter((b) => b.anchor >= answers);
  if (!going.length) return;
  c.batches = c.batches.filter((b) => b.anchor < answers);
  const dropped = c.dropped ?? new Set<string>();
  for (const b of going) {
    for (const id of b.ids) {
      c.rows.delete(id);
      dropped.add(id);
    }
  }
  c.dropped = dropped;
}

/**
 * The chat was deleted: its agents are forgotten, and what its CLI still says
 * of them (it ends as the chat closes it, or a minute later) never makes the
 * chat show again, on the closed island or the home.
 */
export function forgetChat(store: AgentStore, chat: string) {
  store.delete(chat);
  let deleted = deletedChats.get(store);
  if (!deleted) deletedChats.set(store, (deleted = new Set()));
  deleted.add(chat);
}

// ── The closed island ─────────────────────────────────────────────────────────

/** The agents the closed island's chat line shows (set by views/chat.ts, read by island/compact.ts). */
let islandPeek: AgentsPeek | null = null;

/** What the closed island's chat line shows of the chat's agents now; null for none. */
export function islandAgents(): AgentsPeek | null {
  return islandPeek;
}

export function setIslandAgents(peek: AgentsPeek | null) {
  islandPeek = peek;
}

// ── Words ─────────────────────────────────────────────────────────────────────

export const AGENT_TEXT = {
  seconds: N_("{seconds} s"),
  minutes: N_("{minutes} min"),
  hours: N_("{hours} h"),
  hoursMinutes: N_("{hours} h {minutes} min"),
  /** The closed island and the home: a chat whose agents work after its answer. */
  islandWorking: N_("{count} agents working"),
  islandStalled: N_("{count} agents with no signal for {time}"),
};

/** A length of time in a few words: "45 s", "14 min", "1 h 20 min". */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return t(AGENT_TEXT.seconds, { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t(AGENT_TEXT.minutes, { minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? t(AGENT_TEXT.hoursMinutes, { hours, minutes: rest }) : t(AGENT_TEXT.hours, { hours });
}

/**
 * What the closed island and the home say of a chat whose agents work with
 * no answer being written (concept 5): how many work, or, in amber, that one
 * gives no sign. How far they are ("3/8") is said apart: after the segments
 * on the closed island, after the words in the home's list.
 */
export function islandAgentsLine(entries: AgentEntry[], now = Date.now(), permission?: ReadonlySet<string>): { text: string; stalled: boolean } | null {
  const n = countAgents(entries, now, permission);
  if (n.open === 0) return null;
  const worst = n.stalled ? worstStall(entries, now) : null;
  if (worst) {
    return { text: tn("{count} agent with no signal for {time}", AGENT_TEXT.islandStalled, n.stalled, { time: durationText(worst.seconds * 1000) }), stalled: true };
  }
  return { text: tn("{count} agent working", AGENT_TEXT.islandWorking, n.open), stalled: false };
}
