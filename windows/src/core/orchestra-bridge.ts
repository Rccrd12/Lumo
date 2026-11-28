// The island's side of the projects (orchestra.rs): in each, a coordinator that
// plans and its threads, each a chat with its own model, that talk to the user and
// to each other. Typed wrappers over the orchestra_* commands and the
// `orchestra-update` event (views/orchestra.ts draws them). As the rest of
// core/bridge.ts, every call is a no-op in a plain browser.

import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI, onEvent, type ChatActivity, type ChatContext, type ScreenContext } from "./bridge";
import type { SentItem } from "./sent";
import type { OrchestraPick } from "./state";

export type { OrchestraPick } from "./state";

/** Where a project stands, as the list of projects says it. */
export type ProjectState = "waiting" | "working" | "paused" | "done" | "stopped" | "idle";

/** A project, as orchestra_list gives it. */
export interface OrchestraSummary {
  id: string;
  title: string;
  /** Its icon's name (core/project-icons.ts), "" for the default one. */
  icon: string;
  /** "#rrggbb", or "" for none. */
  color: string;
  goal: string;
  /** Last change, ms since the epoch. */
  updated: number;
  state: ProjectState;
  /** How many of its members are at work. */
  working: number;
  /** The member that asks the user, when one does. */
  asking: string;
  planDone: number;
  planTotal: number;
  coordinator: OrchestraPick;
  thread: OrchestraPick;
}

/** What New project and a project's settings set (orchestra.rs Project). */
export interface ProjectFields {
  title: string;
  icon: string;
  color: string;
  /** What the user wants to work on, up to GOAL_MAX characters. */
  goal: string;
  /** A full path, or "" for the project's own folder. */
  folder: string;
  /** Its environment: the user's GitHub repositories ("owner/name"), cloned for it. */
  repos: string[];
  coordinator: OrchestraPick;
  thread: OrchestraPick;
  /** Its threads go on by themselves once the usage limits reset. */
  resume: boolean;
}

/** The most a project's goal holds (orchestra.rs GOAL_MAX). */
export const GOAL_MAX = 8000;

export type OrchestraStepStatus = "pending" | "in_progress" | "completed";

export interface OrchestraStep {
  step: string;
  status: OrchestraStepStatus;
}

/** "paused": stopped by a usage limit, it goes on at `resumeAt` when its project says so. */
export type OrchestraMemberState = "idle" | "working" | "waiting" | "done" | "failed" | "stopped" | "paused";

/** A decision card a member puts to the user (kind "card"). */
export interface OrchestraCard {
  question: string;
  options: { label: string; consequence: string }[];
  recommended: number;
  /** The option picked, once answered. */
  chose?: number;
  /** The user wrote to the member instead of choosing: closed. */
  words?: boolean;
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
   * change file `text`, which `holder` is changing), "stopped", "error" (`text` the error), "limit" (a usage
   * limit stopped it, `text` the provider's words; it goes on at `until` when the project says so). A user
   * line with "answer" is the user's answer to a card, which the card itself shows. "cloned" (`text` a
   * repository of the environment, `holder` its folder) and "clone-failed" (`text` "owner/name: why"). A
   * relay with "reply" is a thread's answer sent on to the coordinator.
   */
  note?: "lock" | "started" | "stopped" | "error" | "answer" | "limit" | "cloned" | "clone-failed" | "reply" | "compacted" | "compact-nothing" | "compact-failed";
  /** A "limit" note: when the member goes on, seconds since the epoch. */
  until?: number;
  /** A "lock" note: the member changing the file. */
  holder?: string;
  /** A message to a member: waiting for its next step, read while it worked, or woke it. */
  delivered?: "queued" | "mid-turn" | "woke";
  /** A relay this member sent: who to ("coordinator", "t2"…). */
  to?: string;
  /** The user's message: what went with it, shown on its bubble as in a chat. */
  sent?: SentItem[];
  /** An answer: what its turn did besides its words, drawn under it as a chat's (orchestra.rs Message::answer). */
  answer?: OrchestraAnswer;
}

/** What a member's turn did besides its words, as a chat's answer keeps it (core/state.ts ChatMessage). */
export interface OrchestraAnswer {
  files?: import("./file-names").ReplyFile[];
  commands?: import("./terminal").RanCommand[];
  speed?: import("./state").TokenSpeed;
  computer?: import("./computer-use").ComputerRecap;
  warning?: import("./chats").AnswerWarning;
  fix?: import("./bridge").ChatFix;
}

/** What the user attached to a message to a member, as a chat's question takes it (views/chat.ts). */
export interface OrchestraAttached {
  context: ChatContext | null;
  screen: ScreenContext | null;
  sent: SentItem[];
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
  /** Paused by a usage limit: when it goes on, seconds since the epoch. */
  resumeAt?: number | null;
  /** When Lumo wakes it, as it asked (wake_me_later), ms since the epoch. */
  wakeAt?: number | null;
  /** How full its context was at its last answer: the usage menu's after Lumo starts again. */
  context?: { used: number; total: number } | null;
}

/** A note of the project's memory (save_memory): one per subject. */
export interface OrchestraMemoryNote {
  subject: string;
  text: string;
  /** The member who wrote it last ("user" for the user). */
  by: string;
  at: number;
}

/** The whole state of one orchestra, as orchestra-update sends it after every change. */
export interface OrchestraSnapshot {
  id: string;
  title: string;
  created: number;
  updated: number;
  icon: string;
  color: string;
  goal: string;
  folder: string;
  repos?: string[];
  resume: boolean;
  /** Who plays the threads, those to come too. */
  threadPick: OrchestraPick;
  coordinator: OrchestraMember;
  threads: OrchestraMember[];
  /** The coordinator's plan. */
  plan: OrchestraStep[];
  /** Files being edited now, and by which member. */
  locks: { path: string; member: string }[];
  /** What its members keep for later, which each reads at the start of its turns. */
  memory?: OrchestraMemoryNote[];
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
  /** A new project, empty until the user's first message. */
  create: (project: ProjectFields) => ask<OrchestraSnapshot>("orchestra_create", { project }),
  /** A project's settings saved. */
  update: (id: string, project: ProjectFields) => ask<OrchestraSnapshot>("orchestra_update", { id, project }),
  /** The user's GitHub repositories a project's environment may hold: the newest pushed first. */
  repoNames: () => ask<{ name: string; private: boolean; description: string }[]>("github_repo_names", {}),
  /** One member's model and effort, from its chat's model button: a thread's only, the coordinator's the project's. */
  setPick: (id: string, member: string, pick: OrchestraPick) => ask<OrchestraSnapshot>("orchestra_set_pick", { id, member, pick }),
  open: (id: string) => ask<OrchestraSnapshot>("orchestra_open", { id }),
  /** `to`: "coordinator" or a thread id. */
  compact: (id: string, member: string) => ask<void>("orchestra_compact", { id, member }),
  /** Retry (no text) or Edit of a member's last message: it and what came after go, and it goes again. */
  retry: (id: string, member: string, message: string, text?: string) => ask<void>("orchestra_retry", { id, member, message, text: text ?? null }),
  /** What Lumo heard for a member's chat (a watch it asked for): to that member, which it wakes. False: no member's chat. */
  heard: (chat: string, text: string) => ask<boolean>("orchestra_heard", { chat, text }),
  /** The user forgets a note of the project's memory. */
  forget: (id: string, subject: string) => ask<OrchestraSnapshot>("orchestra_forget", { id, subject }),
  /** Cancel or Edit of the user's message still waiting for its member: its text and what went with it, null once read. */
  unqueue: (id: string, member: string, message: string) =>
    ask<{ text: string; sent: SentItem[] } | null>("orchestra_unqueue", { id, member, message }),
  keepAnswer: (id: string, member: string, message: string, answer: OrchestraAnswer) => ask<void>("orchestra_keep_answer", { id, member, message, answer }),
  keepContext: (id: string, member: string, used: number, total: number) => ask<void>("orchestra_keep_context", { id, member, used, total }),
  send: (id: string, to: string, text: string, attached?: OrchestraAttached, asked?: string) =>
    ask<void>("orchestra_send", {
      id, to, text,
      ...(attached ? { context: attached.context, screen: attached.screen, sent: attached.sent } : {}),
      ...(asked ? { asked } : {}),
    }),
  /** Answers card `message` of `member` (who asked) with option `choice`. */
  answer: (id: string, member: string, message: string, choice: number) => ask<void>("orchestra_answer", { id, member, message, choice }),
  /** Stops `member`, or everyone without it. */
  stop: (id: string, member?: string) => tell("orchestra_stop", member ? { id, member } : { id }),
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
  return member.messages.filter((m) => m.kind === "card" && m.card && m.card.chose == null && !m.card.words && m.from === member.id);
}

/** How far a plan has gone: the steps completed, and all of them. */
export function planProgress(plan: readonly OrchestraStep[] | undefined): { done: number; total: number } {
  const steps = plan ?? [];
  return { done: steps.filter((s) => s.status === "completed").length, total: steps.length };
}

/** What a project's form starts from: what `snap` keeps. */
export function fieldsOf(snap: OrchestraSnapshot): ProjectFields {
  return {
    title: snap.title, icon: snap.icon ?? "", color: snap.color ?? "", goal: snap.goal ?? "", folder: snap.folder ?? "", repos: snap.repos ?? [],
    coordinator: snap.coordinator.pick, thread: snap.threadPick ?? snap.threads[0]?.pick ?? { provider: "", model: "", effort: "" },
    resume: Boolean(snap.resume),
  };
}
