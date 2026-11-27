// The island's side of the orchestra (orchestra.rs): a coordinator that plans
// and its threads, each a chat with its own model, that talk to the user and
// to each other. Typed wrappers over the orchestra_* commands and the
// `orchestra-update` event (views/orchestra.ts draws them). As the rest of
// core/bridge.ts, every call is a no-op in a plain browser.

import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI, onEvent, type ChatActivity } from "./bridge";
import type { OrchestraPick } from "./state";

export type { OrchestraPick } from "./state";

/** A past orchestra, as orchestra_list gives it. */
export interface OrchestraSummary {
  id: string;
  title: string;
  /** Last change, ms since the epoch. */
  updated: number;
  /** A member of it is at work now. */
  working: boolean;
}

export type OrchestraStepStatus = "pending" | "in_progress" | "completed";

export interface OrchestraStep {
  step: string;
  status: OrchestraStepStatus;
}

export type OrchestraMemberState = "idle" | "working" | "waiting" | "done" | "failed" | "stopped";

/** A decision card a member puts to the user (kind "card"). */
export interface OrchestraCard {
  question: string;
  options: { label: string; consequence: string }[];
  recommended: number;
  /** The option picked, once answered. */
  chose?: number;
}

export interface OrchestraMessage {
  id: string;
  at: number;
  kind: "user" | "assistant" | "relay" | "card" | "file" | "note";
  /** "user", "coordinator", a thread id, or "lumo" for Lumo's notes. */
  from: string;
  /** Markdown for user, assistant and relay messages; a note's words. */
  text: string;
  card?: OrchestraCard;
  /** A file a thread delivered, in the orchestra's shared folder. */
  file?: { path: string; name: string; markdown: boolean };
  /**
   * A note's kind (kind "note"): "started" (`from` the new thread, `text` its title), "lock" (`from` tried to
   * change file `text`, which `holder` is changing), "stopped", "error" (`text` the error). A user line with
   * "answer" is the user's answer to a card, which the card itself shows.
   */
  note?: "lock" | "started" | "stopped" | "error" | "answer";
  /** A "lock" note: the member changing the file. */
  holder?: string;
  /** A message to a member: waiting for its next step, read while it worked, or woke it. */
  delivered?: "queued" | "mid-turn" | "woke";
  /** A relay this member sent: who to ("coordinator", "t2"…). */
  to?: string;
}

export interface OrchestraMember {
  /** "coordinator", or "t1", "t2"… in creation order. */
  id: string;
  /** The chat id its answers stream under (chat-delta, chat-activity). */
  chat: string;
  title: string;
  /** Its task, as the coordinator wrote it ("" for the coordinator). */
  task: string;
  pick: OrchestraPick;
  state: OrchestraMemberState;
  /** Its last step, as chat-activity says one; null when idle. */
  activity: ChatActivity | null;
  /** Its own plan, if it keeps one. */
  plan?: OrchestraStep[];
  /** Messages waiting for its next step. */
  queued: number;
  messages: OrchestraMessage[];
}

/** The whole state of one orchestra, as orchestra-update sends it after every change. */
export interface OrchestraSnapshot {
  id: string;
  title: string;
  created: number;
  updated: number;
  coordinator: OrchestraMember;
  threads: OrchestraMember[];
  /** The coordinator's plan. */
  plan: OrchestraStep[];
  /** Files being edited now, and by which member. */
  locks: { path: string; member: string }[];
}

/** A Markdown file of the shared folder, for the reader beside the chat. */
export interface OrchestraFile {
  name: string;
  path: string;
  text: string;
}

/** The member id of the coordinator, to whom orchestra_send speaks by default. */
export const COORDINATOR = "coordinator";

/** A command that answers; its error comes back as a rejection, so the view can say it. */
async function ask<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  return invoke<T>(cmd, args);
}

/** A command whose failure is only logged: nothing to say to the user. */
async function tell(cmd: string, args?: Record<string, unknown>): Promise<void> {
  if (!IS_TAURI) return;
  try {
    await invoke(cmd, args);
  } catch (err) {
    console.error(`[lumo] ${cmd} failed`, err);
  }
}

export const Orchestra = {
  async list(): Promise<OrchestraSummary[]> {
    try {
      const listed = await ask<OrchestraSummary[]>("orchestra_list");
      return Array.isArray(listed) ? listed : [];
    } catch (err) {
      console.error("[lumo] orchestra_list failed", err);
      return [];
    }
  },
  /** A new, empty orchestra with the picks in the settings. */
  create: () => ask<OrchestraSnapshot>("orchestra_create"),
  open: (id: string) => ask<OrchestraSnapshot>("orchestra_open", { id }),
  /** `to`: "coordinator" or a thread id. */
  send: (id: string, to: string, text: string) => ask<void>("orchestra_send", { id, to, text }),
  /** Answers card `message` of `member` (who asked) with option `choice`. */
  answer: (id: string, member: string, message: string, choice: number) => ask<void>("orchestra_answer", { id, member, message, choice }),
  /** Stops `member`, or everyone without it. */
  stop: (id: string, member?: string) => tell("orchestra_stop", member ? { id, member } : { id }),
  setPicks: (id: string, coordinator?: OrchestraPick, thread?: OrchestraPick) =>
    ask<OrchestraSnapshot>("orchestra_set_picks", { id, ...(coordinator ? { coordinator } : {}), ...(thread ? { thread } : {}) }),
  remove: (id: string) => tell("orchestra_delete", { id }),
  readFile: (id: string, path: string) => ask<OrchestraFile>("orchestra_read_file", { id, path }),
  /** Every change of any orchestra, whole. */
  onUpdate: (handler: (snap: OrchestraSnapshot) => void) => onEvent<OrchestraSnapshot>("orchestra-update", handler),
};

/** Every member of `snap`, the coordinator first. */
export function membersOf(snap: OrchestraSnapshot): OrchestraMember[] {
  return [snap.coordinator, ...snap.threads];
}

/** The member of `snap` with id `id`. */
export function memberOf(snap: OrchestraSnapshot, id: string): OrchestraMember | undefined {
  return membersOf(snap).find((m) => m.id === id);
}

/** The member whose answers stream under chat id `chat`. */
export function memberByChat(snap: OrchestraSnapshot, chat: string): OrchestraMember | undefined {
  return membersOf(snap).find((m) => m.chat === chat);
}

/** The decision cards of `member` still waiting for the user. */
export function openCards(member: OrchestraMember): OrchestraMessage[] {
  return member.messages.filter((m) => m.kind === "card" && m.card && m.card.chose == null && m.from === member.id);
}

/** How far a plan has gone: the steps completed, and all of them. */
export function planProgress(plan: readonly OrchestraStep[] | undefined): { done: number; total: number } {
  const steps = plan ?? [];
  return { done: steps.filter((s) => s.status === "completed").length, total: steps.length };
}
