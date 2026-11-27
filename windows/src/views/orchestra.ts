// The projects (concepts modalita-orchestratore v2 and progetti v2): in the
// chat, in place of its conversation while Settings.orchestraMode is on, from
// the Projects card of the empty chat. In a project a coordinator plans and
// delegates; its threads, each a chat with its own model and the chat's tools,
// do the work and write to each other (orchestra.rs). The user talks to the
// coordinator and to any thread.
//
// Its pages: the list of projects and the form of a new one (views/projects.ts)
// take the whole chat; a project open has its rail and its conversation, and
// its gear opens its settings in the conversation's place.
//
// On the left, the rail: the project's icon and name (a click lists the others,
// New project, its settings and all the projects), the coordinator, then the threads, each with a mark for
// where it stands (at work, waiting for you, done, waiting, failed, stopped)
// and its last step. On the right, the member picked: its header (its state,
// its model, its plan's progress, Stop) and its conversation. Messages from the
// other members carry a grey "From …›" (a click opens that member), those it
// sent "To …›"; a question it puts to the user is a card whose options answer
// it; the files a thread hands over are cards, and a Markdown one opens in a
// reader beside the chat, in the rail's place. The chat's own field writes to
// the member on screen (views/chat.ts submit); a message waiting for that
// member's next step shows above the field. The answer being written streams
// in from chat-delta and chat-activity under the member's own chat id.

import { h, svg, clear, gentleWheel } from "./dom";
import { ICONS } from "./icons";
import { renderMarkdown } from "./markdown";
import { Bridge, type ChatActivity } from "../core/bridge";
import {
  COORDINATOR, Orchestra, fieldsOf, memberByChat, memberOf, membersOf, planProgress,
  type OrchestraAnswer, type OrchestraAttached, type OrchestraFile, type ProjectFields, type OrchestraMember, type OrchestraMessage, type OrchestraSnapshot, type OrchestraStep, type OrchestraSummary,
} from "../core/orchestra-bridge";
import { isCliProvider, providerDef } from "../core/providers";
import { ORCHESTRA_ACCENT, resolvePick } from "../core/orchestra-picks";
import { saveSettings } from "./chat-attach";
import { buildModelMenu, buildProjectForm, buildProjectList, modelName, projectsCard, type ProjectForm } from "./projects";
import { DEFAULT_ICON, GEAR_LINE, projectMark } from "./project-icons";
import { durationText } from "../core/chat-agents";
import { Sound } from "../core/sound";
import { State, type OrchestraPick } from "../core/state";
import { language, t, tn } from "../i18n/i18n";
import { activityLabel, bubble, compactMark, sentAgo, speedLine, speedText, typingDots } from "./chat-messages";
import type { ChatMessage, TokenSpeed } from "../core/state";
import { withReplyFile, type ReplyFile, type ReplyFileKind } from "../core/file-names";
import { MAX_COMMANDS, type RanCommand } from "../core/terminal";
import { splitFix } from "./chat-fix";
import type { SentItem } from "../core/sent";
import { AUTO_COMPACT_PCT, COMPACT_STRINGS, STRINGS as CHAT_S, effortLabel } from "./chat-strings";
import { readyProviders } from "./chat-models";
import { ORCHESTRA_STRINGS as S } from "./orchestra-strings";
import { dropChatFiles } from "../core/chat-files";

/** Where the project last on screen is kept, to come back to it (a per-viewer convenience). */
const LAST_KEY = "lumo.orchestra.last";
/** Narrower than this (page px), the chat's body gives the rail less room. */
const NARROW_PX = 600;
/** Within this of its end, the conversation follows what is written there. */
const STUCK_PX = 4;

export interface OrchestraView {
  /** The rail of members, and the reader that takes its place: both laid over the chat's left side. */
  rail: HTMLElement;
  doc: HTMLElement;
  /** Over the conversation: the member on screen. */
  head: HTMLElement;
  /** The member's conversation (a chat-log, so it reads as the chat does). */
  log: HTMLElement;
  /** Above the field: the messages waiting for the member's next step. */
  queue: HTMLElement;
  /** The list of projects, a project's form: in the chat's place (or the conversation's, for a project's settings). */
  page: HTMLElement;
  /** The projects are what the chat shows now (a page of them, or one open). */
  on(): boolean;
  /** A project is open on its conversation: the field writes to it. */
  inProject(): boolean;
  /** The empty chat's Projects card. */
  welcomeCard(): HTMLElement;
  /** Into the projects, on their list (the empty chat's card). */
  enter(): void;
  /** Out of the projects, back to the chat. */
  leave(): void;
  /** The project's settings, in place of its conversation (the gear). */
  openSettings(): void;
  /**
   * The model button in a project: the models' menu of the member on screen,
   * over `anchor` in `host`, or closed when open. A thread's model is its
   * own; the coordinator's is the project's.
   */
  toggleModelMenu(anchor: HTMLElement, host: HTMLElement): void;
  /** Closes the models' menu unless `target` is in it or its button: true when it was open. */
  closeModelMenu(target?: Node | null): boolean;
  /** Called from the chat's own sync: shows or hides the orchestra in `body`. */
  sync(body: HTMLElement): void;
  /** Sends what was typed to the member on screen (the coordinator first), starting an orchestra if none is open. */
  /** `asked`: what the member reads, when not what the chat shows (a "/tool" command). */
  send(text: string, attached?: OrchestraAttached, asked?: string): Promise<void>;
  /** The chat of the member on screen, whose folder what is attached goes to; none before the project has one. */
  memberChat(): string | null;
  /** The files of the member on screen's answers, which its words may name (views/file-links.ts). */
  knownFiles(): string[];
  /** The chat's streams: true when `chat` is a member's, so the chat itself has nothing to do. */
  delta(chat: string, text: string): boolean;
  activity(chat: string, activity: ChatActivity): boolean;
  /** What a member's turn did besides its words (a file, a command, its speed): kept with its answer. True when `chat` is a member's. */
  turnFile(chat: string, kind: ReplyFileKind | "read", path: string): boolean;
  turnCommand(chat: string, ran: RanCommand): boolean;
  turnSpeed(chat: string, speed: TokenSpeed): boolean;
  /** How full a member's context is: a local model's nearly full is compacted, as a chat is. */
  contextSeen(chat: string, used: number, total: number, estimate?: boolean): void;
  /** "/compact" for the member on screen: true when it was its to do (not a CLI's, which compacts itself). */
  compactMember(): boolean;
  /** A member's chat: the answer its agents belong to (the one being written while it works); null for any other chat. */
  anchorOf(chat: string): number | null;
  /** Its conversation drawn again (an agent came). */
  redraw(): void;
  /** A message being edited: `text` replaces it and it goes again. True when it was one. */
  editSend(text: string): boolean;
  /** Escape while editing: the edit is dropped. True when there was one. */
  cancelEdit(): boolean;
  /** The field's placeholder: who it writes to. */
  placeholder(): string;
  /** The model button's words and dot. */
  button(): { name: string; dot: string };
  /** New project: its form. */
  startNew(): void;
  /** The other projects, in the rail. */
  toggleMenu(): void;
  /** The orchestra on screen, if one is. */
  readonly snapshot: OrchestraSnapshot | null;
  /** The member on screen. */
  readonly selected: string;
  /**
   * What the closed island says of the orchestra while no chat answers: how
   * many work and how far the plan is, who waits for the user, or that it is
   * finished and the coordinator's first line (concept 7). Null: nothing.
   */
  islandLine(): { who: string; color: string; label: string } | null;
  /** Whose usage the ring by the model button shows: the member on screen, its chat and who plays it. */
  usageOf(): { chat: string; provider: string; model: string; effort: string } | null;
}

/** The closed island's colours: a thread waiting for the user, and an orchestra finished. */
const WAITING_COLOR = "#f5c542";
const DONE_COLOR = "#4ade80";

/** The cards still waiting for the user that member `id` of `snap` put, wherever they show. */
/** A return arrow: the option under the mouse is the one a click picks. */
const RETURN_LINE = "M19 6v5a3 3 0 0 1-3 3H6M10 10l-4 4 4 4";

/** What the coordinator answers when a thread's answer needs nothing from it (orchestra.rs QUIET): never shown. */
const QUIET = "[quiet]";

/** The coordinator's answer is, or begins to be, its word for nothing to say. */
function quietText(m: OrchestraMember, text: string): boolean {
  if (m.id !== COORDINATOR) return false;
  const said = text.trim();
  return said.startsWith(QUIET) || (said.length > 0 && QUIET.startsWith(said));
}

function waitingCardsIn(snap: OrchestraSnapshot, id: string): number {
  return waitingCardIds(snap, id).size;
}

/** The ids of the cards `id` put that still wait for the user. */
function waitingCardIds(snap: OrchestraSnapshot, id: string): Set<string> {
  const ids = new Set<string>();
  for (const m of membersOf(snap)) {
    for (const msg of m.messages) if (msg.kind === "card" && msg.from === id && msg.card && msg.card.chose == null) ids.add(msg.id);
  }
  return ids;
}

/** How the list of projects shows `s`, as orchestra.rs Orchestra::summary says it. */
export function summaryOf(s: OrchestraSnapshot, asks: (m: OrchestraMember) => boolean = () => false): OrchestraSummary {
  const members = membersOf(s);
  const working = members.filter((m) => m.state === "working").length;
  const asking = members.find((m) => m.state === "waiting" || asks(m))?.id ?? "";
  const state: OrchestraSummary["state"] = asking ? "waiting"
    : working > 0 ? "working"
    : members.some((m) => m.state === "paused") ? "paused"
    : s.threads.length > 0 && s.threads.every((m) => m.state === "done") ? "done"
    : members.some((m) => m.state === "stopped" || m.state === "failed") ? "stopped"
    : "idle";
  const { done, total } = planProgress(s.plan);
  return {
    id: s.id, title: s.title, icon: s.icon ?? "", color: s.color ?? "", goal: s.goal ?? "", updated: s.updated,
    state, working, asking, planDone: done, planTotal: total,
    coordinator: s.coordinator.pick, thread: s.threadPick ?? s.threads[0]?.pick ?? { provider: "", model: "", effort: "" },
  };
}

/** `changed`: the orchestra on screen changed (the closed island's line may say something else). */
/** What the chat lends the projects: a click on what went with a message opens it as in a chat. */
export interface OrchestraHooks {
  openSent?: (message: ChatMessage, item: SentItem) => void;
  /** Settings → Agents, for a card that puts a CLI right (views/chat-fix.ts). */
  openAgents?: () => void;
  /** The agents a member's answer `answer` started (cards) and its messages to them (boxes), as a chat draws them; past the last with `after`. */
  agentsReset?: () => void;
  talksUnder?: (chat: string, answer: number, after?: boolean) => HTMLElement[];
  agentsUnder?: (chat: string, answer: number, after?: boolean) => HTMLElement[];
  /** The answer being written, in ink as a chat's (views/ink.ts); `fresh`: its first words. */
  writeLive?: (chat: string, into: HTMLElement, text: string, fresh: boolean, scope: string) => void;
  /** Its answer come whole: the ink goes on in its bubble until all is uncovered. */
  inkInto?: (chat: string, into: HTMLElement, text: string, scope: string) => void;
  /** Edit: the message's text in the field, to be changed and sent again. */
  startEdit?: (text: string) => void;
  /** A queued message taken back to be edited: its text in the field, before what is typed there. */
  unqueued?: (text: string) => void;
}

/** A member's message as a chat's: drawn by the same bubble, with its actions, its time and what went with it. */
function asChatMessage(msg: OrchestraMessage, role: "user" | "assistant"): ChatMessage {
  let id = 0;
  for (const c of msg.id) id = (Math.imul(id, 31) + c.charCodeAt(0)) | 0;
  return { id, role, content: msg.text, ...(msg.at ? { at: msg.at } : {}), ...(msg.sent?.length ? { sent: msg.sent } : {}), ...(msg.answer ?? {}) };
}

export function buildOrchestra(changed: () => void = () => {}, hooks: OrchestraHooks = {}): OrchestraView {
  let snap: OrchestraSnapshot | null = null;
  let selected = COORDINATOR;
  /** The orchestra finished its work with the island closed, and it was not opened since. */
  let finishedUnseen = false;
  /** The member whose question the closed island said: shown when the island opens. */
  let askedOnIsland = "";
  /** The cards the user has seen on the open island: the closed island no longer says they ask. */
  const seenCards = new Set<string>();
  /** What each member's turn did so far besides its words, by its chat: kept with its answer when it comes. */
  const turnExtras = new Map<string, OrchestraAnswer>();
  /** The answer being written, as a chat writes it (in ink when the chat lends it). */
  function writeLive(m: OrchestraMember, into: HTMLElement, text: string, fresh: boolean) {
    if (hooks.writeLive) hooks.writeLive(m.chat, into, text, fresh, scope(m, "live"));
    else renderMarkdown(into, text, { streaming: true, scope: scope(m, "live") });
  }

  /**
   * "698 tokens · 44 tok/sec" for a local model member's answer being
   * written, as a chat says it: under its text, or next to the dots while it
   * only reasons. Drawn only when tokens come.
   */
  function drawLiveSpeed(m: OrchestraMember) {
    if (m.id !== selected || !on() || page !== "project") return;
    const speed = State.settings.chatTokenSpeed === false || m.state !== "working" ? undefined : turnExtras.get(m.chat)?.speed;
    const row = log.querySelector<HTMLElement>(".reply-speed-row");
    if (!speed || !liveEl) row?.remove();
    else if (row) {
      const text = row.querySelector(".reply-speed-text");
      const said = speedText(speed);
      if (text && text.textContent !== said) text.textContent = said;
    } else {
      const line = speedLine(speed);
      if (line) {
        line.style.setProperty("--speed-accent", providerDef(pickOf(m).provider).accent);
        liveEl.parentElement?.after(h("div", { class: "chat-row reply-speed-row" }, line));
      }
    }
    const label = nowEl?.querySelector(".typing-label");
    let span = nowEl?.querySelector(".typing-tokens") ?? null;
    if (!speed || !label || liveEl) {
      span?.remove();
      return;
    }
    if (!span) {
      span = h("span", { class: "typing-tokens" });
      label.after(span);
    }
    const said = speedText(speed);
    if (span.textContent !== said) span.textContent = said;
  }

  /** The members' chats a compaction was asked for, while their context stays that full. */
  const compactAsked = new Set<string>();
  /** The message being edited, in the field: which member's, which. */
  let editing: { member: string; message: string } | null = null;

  /**
   * The member's message Retry and Edit work on: its last from the user,
   * while only its answers and Lumo's lines came after (orchestra.rs rewind
   * says the rest: the coordinator already reading its answer).
   */
  function retryable(m: OrchestraMember): string | null {
    if (m.state === "working") return null;
    const at = m.messages.map((x) => x.kind === "user" && x.note !== "answer" && x.delivered !== "queued").lastIndexOf(true);
    if (at < 0) return null;
    const after = m.messages.slice(at + 1);
    return after.every((x) => x.kind === "assistant" || (x.kind === "note" && x.from === "lumo")) ? m.messages[at].id : null;
  }

  function retry(m: OrchestraMember, message: string, text?: string) {
    if (!snap) return;
    error = "";
    editing = null;
    Sound.play("send");
    void Orchestra.retry(snap.id, m.id, message, text).catch((err) => {
      error = t(S.notSent, { error: String(err).replace(/^Error:\s*/, "") });
      drawLog(true);
    });
  }

  function startEdit(m: OrchestraMember, msg: OrchestraMessage) {
    editing = { member: m.id, message: msg.id };
    hooks.startEdit?.(msg.text);
    drawLog();
  }
  const extrasOf = (chat: string): OrchestraAnswer => {
    let x = turnExtras.get(chat);
    if (!x) turnExtras.set(chat, (x = {}));
    return x;
  };
  let summaries: OrchestraSummary[] = [];
  /** The list was asked once: its count can be said. */
  let listed = false;
  let booted = false;
  /** What shows: the list of projects, a new project's form, a project open, its settings. */
  let page: "list" | "form" | "project" | "settings" = "project";
  /** Where the new project's form goes back to. */
  let formBack: "list" | "project" = "list";
  /** The form on screen (New project, a project's settings). */
  let form: ProjectForm | null = null;
  let menuOpen = false;
  let planOpen = true;
  /** The file in the reader, and whether its text came. */
  let reading: (OrchestraFile & { loading?: boolean }) | null = null;
  /** What went wrong sending the last message, said under the conversation. */
  let error = "";
  let host: HTMLElement | null = null;
  /** Each member's answer as far as it is written, and what it is doing, by its chat id. */
  const live = new Map<string, string>();
  const acts = new Map<string, ChatActivity>();
  /** The messages between members opened by a click: they show only who from (or to) until then. */
  const openRelays = new Set<string>();
  /** The threads already looked at (or there when the orchestra opened): the others say "new". */
  const seen = new Set<string>();
  /** The streamed answer on screen, and the line of what the member does. */
  let liveEl: HTMLElement | null = null;
  let nowEl: HTMLElement | null = null;

  const rail = h("div", { class: "orc-rail orc-part" });
  const doc = h("div", { class: "orc-doc orc-part" });
  const head = h("div", { class: "orc-head orc-part" });
  const log = h("div", { class: "chat-log orc-log orc-part" });
  gentleWheel(log);
  const queue = h("div", { class: "orc-queue orc-part" });
  const pageEl = h("div", { class: "orc-page" });
  // Esc closes the form's menu before it closes the island.
  pageEl.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Escape" && form?.dismiss()) e.stopPropagation();
  });

  const on = () => State.settings.orchestraMode && State.chatSlot !== "forge";
  const inProject = () => on() && page === "project" && snap != null;

  // ── Who is who ──────────────────────────────────────────────────────────────

  const current = (): OrchestraMember | undefined => (snap ? memberOf(snap, selected) : undefined);
  const titleOf = (id: string): string => id === COORDINATOR ? t(S.coordinator) : (snap && memberOf(snap, id)?.title) || id;
  const nameOf = (m: OrchestraMember): string => (m.id === COORDINATOR ? t(S.coordinator) : m.title);

  /** Who plays `m`, its blanks filled as orchestra.rs fills them. */
  function pickOf(m: OrchestraMember | null): OrchestraPick {
    const coord = m == null || m.id === COORDINATOR;
    const fallback = coord ? snap?.coordinator.pick ?? State.settings.orchestraCoordinator : snap?.threadPick ?? State.settings.orchestraThread;
    const own = m?.pick?.provider ? m.pick : fallback;
    return resolvePick(own, State.settings, readyProviders, coord ? "coordinator" : "thread");
  }

  /** A time of day, as the user's language says it: when a member stopped by a usage limit goes on. */
  function clock(seconds: number): string {
    return new Date(seconds * 1000).toLocaleTimeString(language(), { hour: "2-digit", minute: "2-digit" });
  }

  /** The cards still waiting for the user that `id` put, wherever they show. */
  function waitingCards(id: string): number {
    return snap ? waitingCardsIn(snap, id) : 0;
  }

  /** Those of them the user has not seen yet on the open island. */
  function unseenCards(id: string): number {
    return snap ? [...waitingCardIds(snap, id)].filter((c) => !seenCards.has(`${snap?.id}/${c}`)).length : 0;
  }

  /** The cards of the member on screen, the island open on it: seen. True when one was not yet. */
  function markCardsSeen(): boolean {
    if (!snap || !on() || State.mode !== "expanded" || State.view !== "prompt") return false;
    let fresh = false;
    for (const c of waitingCardIds(snap, selected)) {
      const key = `${snap.id}/${c}`;
      if (!seenCards.has(key)) {
        seenCards.add(key);
        fresh = true;
      }
    }
    return fresh;
  }

  function stepText(m: OrchestraMember): string {
    const a = acts.get(m.chat) ?? m.activity;
    return a ? activityLabel(a) : t(S.thinking);
  }

  /** How long a thread took: from its first message to its last. */
  function took(m: OrchestraMember): string {
    const at = m.messages.map((x) => x.at).filter((x) => Number.isFinite(x));
    return at.length > 1 ? durationText(Math.max(...at) - Math.min(...at)) : "";
  }

  /** The line under a member's name in the rail: its model and step, or where it stands. */
  function statusOf(m: OrchestraMember): { text: string; cls: string; dot: boolean } {
    const pick = pickOf(m);
    const model = modelName(pick.provider, pick.model);
    const withModel = (word: string) => (model ? `${model} · ${word}` : word);
    if (m.state === "waiting") return { text: t(S.waiting), cls: "ask", dot: false };
    if (m.state === "working") return { text: withModel(m.id === COORDINATOR && !acts.get(m.chat) && !m.activity ? t(S.planning) : stepText(m)), cls: "", dot: true };
    if (m.state === "failed") return { text: t(S.failed), cls: "bad", dot: false };
    if (m.state === "paused") return { text: m.resumeAt ? t(S.resumesAt, { time: clock(m.resumeAt) }) : t(S.paused), cls: "paused", dot: false };
    if (m.state === "stopped") return { text: t(S.stopped), cls: "", dot: false };
    if (m.id === COORDINATOR) {
      const allDone = snap != null && snap.threads.length > 0 && snap.threads.every((x) => x.state === "done");
      return { text: allDone ? withModel(t(S.finished)) : model, cls: "", dot: true };
    }
    if (m.state === "done") {
      const time = took(m);
      return { text: time ? t(S.finishedIn, { time }) : t(S.done), cls: "done", dot: true };
    }
    return { text: m.queued > 0 ? t(S.queued) : t(S.idle), cls: "", dot: true };
  }

  /** A member's mark: the coordinator's ring, a thread's state. */
  function mark(m: OrchestraMember | null): HTMLElement {
    if (!m || m.id === COORDINATOR) return h("span", { class: `orc-mk coord${m?.state === "working" ? " working" : ""}` });
    const cls = { working: "work", waiting: "ask", done: "done", idle: "idle", failed: "failed", stopped: "stopped", paused: "paused" }[m.state] ?? "idle";
    const el = h("span", { class: `orc-mk ${cls}` });
    if (m.state === "done") el.append(svg(ICONS.check, 9, { stroke: 3 }));
    else if (m.state === "failed") el.append(svg(ICONS.xmark, 8));
    return el;
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  function draw(toEnd = false) {
    drawRail();
    drawHead();
    drawLog(toEnd);
    drawQueue();
    drawDoc();
    drawPage();
    placeClasses();
  }

  function placeClasses() {
    if (!host) return;
    const shown = on();
    const full = shown && (page === "list" || page === "form" || snap == null);
    // A project open (its conversation or its settings): the rail on the left.
    host.classList.toggle("orc", shown && !full);
    host.classList.toggle("orc-full", full);
    host.classList.toggle("orc-settings", shown && !full && page === "settings");
    host.classList.toggle("orc-reading", shown && !full && reading != null);
    const width = host.clientWidth;
    host.classList.toggle("orc-narrow", shown && width > 0 && width < NARROW_PX);
  }

  function drawRail() {
    clear(rail);
    // Back to the chat: a chevron before the project's name.
    const back = h("button", { class: "orc-back", title: t(S.backToChats), "aria-label": t(S.backToChats) }, svg(ICONS.chevronLeft, 10, { stroke: 2.2 }));
    back.addEventListener("click", () => toChats());
    const title = snap?.title || t(S.untitled);
    const top = h("button", { class: menuOpen ? "orc-top open" : "orc-top", title: t(S.projects), "aria-expanded": String(menuOpen) },
      projectMark(snap?.icon || DEFAULT_ICON, snap?.color ?? "", 18, 11),
      h("span", { class: "orc-top-name", text: title }),
      svg(ICONS.chevronDown, 9, { stroke: 2.2 }));
    top.addEventListener("click", () => toggleMenu());
    rail.append(h("div", { class: "orc-top-row" }, back, top));
    if (menuOpen) {
      rail.append(drawMenu());
      return;
    }
    const list = h("div", { class: "orc-items" });
    list.append(item(snap?.coordinator ?? null));
    const threads = snap?.threads ?? [];
    list.append(h("div", { class: "orc-sec" }, h("span", { text: t(S.threads) }), h("span", { class: "orc-sec-n", text: threads.length ? String(threads.length) : "" })));
    for (const m of threads) list.append(item(m));
    rail.append(list);
  }

  /** New project, the projects newest first, then this one's settings and all the projects. */
  function drawMenu(): HTMLElement {
    const menu = h("div", { class: "orc-menu" });
    const fresh = h("button", { class: "orc-menu-row orc-menu-new" }, svg(ICONS.plus, 10), h("span", { text: t(S.newProject) }));
    fresh.addEventListener("click", () => startNew());
    menu.append(fresh);
    for (const s of [...summaries].sort((a, b) => b.updated - a.updated)) {
      const row = h("button", { class: snap?.id === s.id ? "orc-menu-row on" : "orc-menu-row", title: s.title, "data-project": s.id },
        projectMark(s.icon, s.color, 16, 10),
        h("span", { class: "orc-menu-name", text: s.title || t(S.untitled) }),
        h("span", { class: "orc-menu-when", text: sentAgo(s.updated) }));
      row.addEventListener("click", () => void openOrchestra(s.id));
      menu.append(row);
    }
    const settings = h("button", { class: "orc-menu-row orc-menu-foot first" }, svg(GEAR_LINE, 12, { stroke: 1.8 }), h("span", { class: "orc-menu-name", text: t(S.settings) }));
    settings.addEventListener("click", () => openSettings());
    const all = h("button", { class: "orc-menu-row orc-menu-foot" }, svg(ICONS.activities, 11, { stroke: 1.8 }), h("span", { class: "orc-menu-name", text: t(S.allProjects) }));
    all.addEventListener("click", () => showList());
    const chats = h("button", { class: "orc-menu-row orc-menu-foot" }, svg(ICONS.chevronLeft, 11, { stroke: 2 }), h("span", { class: "orc-menu-name", text: t(S.backToChats) }));
    chats.addEventListener("click", () => toChats());
    if (snap) menu.append(settings);
    menu.append(all, chats);
    return menu;
  }

  function item(m: OrchestraMember | null): HTMLElement {
    const id = m?.id ?? COORDINATOR;
    const pick = pickOf(m);
    const accent = providerDef(pick.provider).accent;
    const status: { text: string; cls: string; dot: boolean } = m ? statusOf(m) : { text: modelName(pick.provider, pick.model), cls: "", dot: true };
    const cards = waitingCards(id);
    const fresh = m != null && id !== COORDINATOR && !seen.has(id);
    const el = h("button", { class: selected === id ? "orc-item on" : "orc-item", title: m?.task || undefined, "data-member": id },
      mark(m),
      h("span", { class: "orc-item-text" },
        h("span", { class: "orc-item-name" },
          h("span", { class: "orc-item-title", text: m ? nameOf(m) : t(S.coordinator) }),
          fresh ? h("span", { class: "orc-fresh", text: t(S.fresh) }) : null),
        h("span", { class: `orc-item-status ${status.cls}`.trim() },
          status.dot ? h("i", { class: "orc-dot", style: `background:${accent}` }) : null,
          h("span", { class: "orc-item-step", text: status.text }))),
      cards > 0 ? h("span", { class: "orc-badge", text: String(cards) }) : null);
    el.addEventListener("click", () => select(id));
    return el;
  }

  function pill(text: string, cls = ""): HTMLElement {
    return h("span", { class: `orc-pill ${cls}`.trim(), text });
  }

  function statePill(m: OrchestraMember): HTMLElement | null {
    switch (m.state) {
      case "working":
        return pill(t(S.working), "blue");
      case "waiting":
        return pill(t(S.waiting), "amber");
      case "done":
        return m.id === COORDINATOR ? null : pill(t(S.done), "green");
      case "failed":
        return pill(t(S.failed), "red");
      case "paused":
        return pill(m.resumeAt ? t(S.resumesAt, { time: clock(m.resumeAt) }) : t(S.paused), "amber");
      case "stopped":
        return pill(t(S.stopped));
      default:
        return null;
    }
  }

  function drawHead() {
    clear(head);
    const m = current() ?? null;
    const coord = selected === COORDINATOR;
    const pick = pickOf(m);
    const p = providerDef(pick.provider);
    const model = modelName(pick.provider, pick.model);
    const modelPill = h("span", { class: "orc-pill orc-model-pill", title: `${t(p.name)} · ${pick.model}` },
      h("i", { class: "orc-dot", style: `background:${p.accent}` }),
      h("span", { text: pick.effort ? `${model} · ${effortLabel(pick.effort)}` : model }));
    const state = m ? statePill(m) : null;
    head.append(mark(m), h("span", { class: "orc-head-title", text: m ? nameOf(m) : t(S.coordinator) }));
    // The coordinator says its model first; a thread, where it stands.
    if (coord) head.append(modelPill, state ?? "");
    else head.append(state ?? "", modelPill);
    head.append(h("span", { class: "orc-head-gap" }));
    const plan = coord ? snap?.plan : m?.plan;
    const { done, total } = planProgress(plan);
    if (total > 0) {
      const planBtn = h("button", {
        class: `orc-pill orc-plan-btn${done === total ? " green" : ""}${planOpen ? " open" : ""}`,
        text: t(coord ? S.planPill : S.listPill, { done, total }),
        "aria-expanded": String(planOpen),
      });
      planBtn.addEventListener("click", () => {
        planOpen = !planOpen;
        drawHead();
        drawLog();
      });
      head.append(planBtn);
    }
    if (snap && m) {
      const going = (x: OrchestraMember) => x.state === "working" || x.state === "waiting" || x.state === "paused";
      const busy = coord ? membersOf(snap).some(going) : going(m);
      if (busy) {
        const stop = h("button", { class: "orc-stop", text: t(coord ? S.stopAll : S.stopOne) });
        stop.addEventListener("click", () => {
          if (!snap) return;
          Sound.play("pop");
          void Orchestra.stop(snap.id, coord ? undefined : m.id);
        });
        head.append(stop);
      }
    }
    if (snap) {
      const settings = page === "settings";
      const gear = h("button", { class: settings ? "pj-gear on" : "pj-gear", title: t(S.projectSettings), "aria-label": t(S.projectSettings), "aria-pressed": String(settings) },
        svg(GEAR_LINE, 14, { stroke: 1.8 }));
      gear.addEventListener("click", () => (page === "settings" ? closeSettings() : openSettings()));
      head.append(gear);
    }
  }

  const stuck = () => log.scrollHeight - log.clientHeight - log.scrollTop <= STUCK_PX;
  const scope = (m: OrchestraMember, id: string) => `orc:${snap?.id ?? ""}:${m.id}:${id}`;

  function drawLog(toEnd = false) {
    const atEnd = toEnd || stuck();
    const kept = log.scrollTop;
    clear(log);
    liveEl = null;
    nowEl = null;
    const m = current();
    if (!snap || !m) {
      log.append(h("div", { class: "orc-empty", text: t(S.pickerNote) }));
      return;
    }
    const coord = m.id === COORDINATOR;
    const plan = coord ? snap.plan : m.plan ?? [];
    if (planOpen && plan.length > 0) log.append(planCard(plan));
    if (coord && snap.locks.length > 0) log.append(locksCard(snap));
    let files: HTMLElement | null = null;
    const under = sharedUnder(m);
    // The agents its answers started, as a chat draws them: its messages to them before each answer, their card after it.
    hooks.agentsReset?.();
    let answer = 0;
    for (const raw of m.messages) {
      // The user's message waiting for the member's next step is over the field.
      if (raw.kind === "user" && raw.delivered === "queued") continue;
      // A file it shared goes under the answer that followed, as a chat's answer shows the files it made.
      if (raw.kind === "file" && under.skip.has(raw.id)) continue;
      const more = under.files.get(raw.id);
      const msg = more ? { ...raw, answer: { ...raw.answer, files: more } } : raw;
      if (msg.kind === "file" && msg.file) {
        if (!files) {
          files = h("div", { class: "orc-files" });
          log.append(files);
        }
        files.append(fileCard(msg));
        continue;
      }
      files = null;
      const isAnswer = msg.kind === "assistant";
      if (isAnswer) log.append(...(hooks.talksUnder?.(m.chat, answer) ?? []));
      log.append(...message(m, msg));
      if (isAnswer) log.append(...(hooks.agentsUnder?.(m.chat, answer++) ?? []));
    }
    // Those of the answer being written, or of one that never came.
    log.append(...(hooks.talksUnder?.(m.chat, answer, true) ?? []), ...(hooks.agentsUnder?.(m.chat, answer, true) ?? []));
    if (m.state === "working") {
      const text = live.get(m.chat);
      if (text && !quietText(m, text)) {
        liveEl = h("div", { class: "reply" });
        log.append(h("div", { class: "chat-row" }, liveEl));
        writeLive(m, liveEl, text, false);
      }
      // The chat's dots and its light crossing the words, as in any chat.
      nowEl = typingDots(stepText(m));
      nowEl.classList.add("orc-now");
      log.append(nowEl);
      drawLiveSpeed(m);
    } else {
      // Its answer just came whole: the ink goes on in its bubble, as in a chat.
      const lastAnswer = m.messages.filter((x) => x.kind === "assistant").at(-1);
      const replies = log.querySelectorAll<HTMLElement>(".reply");
      const reply = replies[replies.length - 1];
      if (lastAnswer && reply) hooks.inkInto?.(m.chat, reply, lastAnswer.text, scope(m, lastAnswer.id));
    }
    if (error) log.append(h("div", { class: "orc-error", text: error }));
    log.scrollTop = atEnd ? log.scrollHeight : kept;
  }

  /**
   * The files `m` shared itself (share_file) in its own chat: under the
   * answer that came after, with those that answer made or changed, as a
   * chat's answer shows its files. One shared while it still works keeps
   * its card until that answer comes. In the coordinator's chat they stay
   * cards: the threads' files, given to the user.
   */
  function sharedUnder(m: OrchestraMember): { skip: Set<string>; files: Map<string, ReplyFile[]> } {
    const skip = new Set<string>();
    const files = new Map<string, ReplyFile[]>();
    if (m.id === COORDINATOR) return { skip, files };
    let pending: OrchestraMessage[] = [];
    for (const msg of m.messages) {
      if (msg.kind === "file" && msg.file && msg.from === m.id) pending.push(msg);
      else if (msg.kind === "assistant" && pending.length > 0) {
        let list: ReplyFile[] = [...(msg.answer?.files ?? [])];
        for (const f of pending) {
          skip.add(f.id);
          list = withReplyFile(list, f.file!.path, "created");
        }
        files.set(msg.id, list);
        pending = [];
      }
    }
    return { skip, files };
  }

  function planCard(plan: readonly OrchestraStep[]): HTMLElement {
    const { done, total } = planProgress(plan);
    return h("div", { class: "orc-plan" },
      h("div", { class: "orc-box-head" }, h("span", { text: t(S.planTitle) }), h("span", { class: "orc-box-aside", text: t(S.planDone, { done, total }) })),
      ...plan.map((s) => h("div", { class: `orc-step ${s.status}` },
        h("span", { class: "orc-step-mk" }, s.status === "completed" ? svg(ICONS.check, 8, { stroke: 3.2 }) : null),
        h("span", { class: "orc-step-text", text: s.step }))));
  }

  function locksCard(s: OrchestraSnapshot): HTMLElement {
    return h("div", { class: "orc-plan orc-locks" },
      h("div", { class: "orc-box-head" }, h("span", { text: t(S.locksTitle) }), h("span", { class: "orc-box-aside", text: t(S.locksBy) })),
      ...s.locks.map((l) => {
        const who = memberOf(s, l.member);
        const accent = providerDef(pickOf(who ?? null).provider).accent;
        return h("div", { class: "orc-step in_progress" },
          h("span", { class: "orc-step-mk" }),
          h("code", { class: "orc-step-text orc-path", text: l.path }),
          h("span", { class: "orc-who" }, h("i", { class: "orc-dot", style: `background:${accent}` }), h("span", { text: titleOf(l.member) })));
      }));
  }

  function message(m: OrchestraMember, msg: OrchestraMessage): HTMLElement[] {
    switch (msg.kind) {
      case "user": {
        // The answer to a card: the card shows it.
        if (msg.note === "answer") return [];
        // Its last message: Retry and Edit, as on a chat's question.
        const again = retryable(m) === msg.id;
        const out: HTMLElement[] = [bubble(asChatMessage(msg, "user"), {
          scope: scope(m, msg.id), onOpenSent: hooks.openSent, chat: m.chat,
          onRetry: again ? () => retry(m, msg.id) : undefined,
          onEdit: again ? () => startEdit(m, msg) : undefined,
          editing: editing?.message === msg.id,
          shown: again && !m.messages.slice(m.messages.indexOf(msg) + 1).some((x) => x.kind === "assistant"),
        })];
        if (msg.delivered === "mid-turn") out.push(h("div", { class: "orc-seen", text: `${t(S.readMidTurn)} · ${sentAgo(msg.at)}` }));
        return out;
      }
      case "assistant": {
        // The last answer keeps its actions in sight, as a chat's does.
        const last = m.messages.filter((x) => x.kind === "assistant").at(-1)?.id === msg.id && m.state !== "working";
        // The answer to its last message: Retry too, as a chat's last answer.
        const asked = retryable(m);
        const again = asked != null && m.messages.findIndex((x) => x.id === asked) < m.messages.indexOf(msg);
        const dropped = editing != null && editing.member === m.id && again;
        return [bubble(asChatMessage(msg, "assistant"), {
          scope: scope(m, msg.id), shown: last, chat: m.chat, onOpenAgents: hooks.openAgents,
          onRetry: again && asked ? () => retry(m, asked) : undefined, dropped,
        })];
      }
      case "relay":
        // Lumo's own (an email), never a member's message.
        if (msg.from === "lumo") return msg.text ? [h("div", { class: "orc-note", text: msg.text })] : [];
        return [relay(m, msg)];
      case "card":
        return msg.card ? [card(m, msg)] : [];
      case "note": {
        const el = note(m, msg);
        return el ? [el] : [];
      }
      default:
        return [];
    }
  }

  /**
   * A message between members: who from (or to), grey. In a thread, folded
   * as Claude Code shows its agents' messages; in the coordinator's chat, a
   * way to the thread, as the thread's answers reach the coordinator by
   * themselves (orchestra.rs `forward_reply`).
   */
  function relay(m: OrchestraMember, msg: OrchestraMessage): HTMLElement {
    const mine = msg.from === m.id;
    const other = mine ? msg.to ?? "" : msg.from;
    let label: string;
    if (mine) label = other === COORDINATOR ? t(S.toCoordinator) : t(S.to, { name: titleOf(other) });
    else if (other === COORDINATOR) label = t(S.fromCoordinator);
    else {
      label = t(S.from, { name: titleOf(other) });
      if (snap && memberOf(snap, other)?.state === "done") label += ` · ${t(S.finished)}`;
    }
    // In the coordinator's chat: only who it is from (or to), a way to that thread; what was said is the thread's to show.
    if (m.id === COORDINATOR) {
      const link = h("button", { class: "orc-from link" }, h("span", { text: label }), svg(ICONS.chevronRight, 8, { stroke: 2.4 }));
      link.addEventListener("click", () => {
        if (snap && memberOf(snap, other)) select(other);
      });
      return h("div", { class: mine ? "orc-relay out" : "orc-relay" }, link);
    }
    const key = `${m.id}:${msg.id}`;
    const open = openRelays.has(key);
    const from = h("button", { class: "orc-from", "aria-expanded": String(open) }, h("span", { text: label }), svg(ICONS.chevronRight, 8, { stroke: 2.4 }));
    const body = h("div", { class: "orc-relay-body" });
    renderMarkdown(body, msg.text, { scope: scope(m, msg.id) });
    const foot = msg.delivered === "queued" ? t(S.queuedLine)
      : msg.delivered === "mid-turn" ? `${t(S.readMidTurn)} · ${sentAgo(msg.at)}`
      : !mine && Number.isFinite(msg.at) && msg.at > 0 ? sentAgo(msg.at) : "";
    const el = h("div", { class: `orc-relay${mine ? " out" : ""}${open ? " open" : ""}` }, from, body, foot ? h("div", { class: "orc-when", text: foot }) : null);
    // Folded like an agent's message in Claude Code: a click shows what was said, another hides it.
    from.addEventListener("click", () => {
      const now = !openRelays.has(key);
      if (now) openRelays.add(key);
      else openRelays.delete(key);
      el.classList.toggle("open", now);
      from.setAttribute("aria-expanded", String(now));
    });
    return el;
  }

  /** A question a member puts to the user: its options answer it (orchestra_answer). */
  function card(m: OrchestraMember, msg: OrchestraMessage): HTMLElement {
    const c = msg.card!;
    const answered = c.chose != null;
    const q = h("div", { class: "orc-card-q" });
    renderMarkdown(q, c.question, { scope: scope(m, `${msg.id}:q`) });
    const options = c.options.map((o, i) => {
      const b = h("button", { class: answered && c.chose === i ? "orc-opt chosen" : "orc-opt", disabled: answered, "data-choice": String(i) },
        h("span", { class: "orc-opt-key", text: String.fromCharCode(65 + i) }),
        h("span", { class: "orc-opt-text" },
          h("span", { class: "orc-opt-label" }, h("span", { text: o.label }), i === c.recommended ? h("span", { class: "orc-rec", text: t(S.recommended) }) : null),
          o.consequence ? h("span", { class: "orc-opt-cons", text: o.consequence }) : null),
        // On hover, as Claude's own cards: the return arrow, what a click does.
        answered ? null : h("span", { class: "orc-opt-go" }, svg(RETURN_LINE, 14, { stroke: 1.8 })));
      b.addEventListener("click", () => answer(msg, i));
      return b;
    });
    let foot: HTMLElement | null = null;
    if (!answered) {
      const there = msg.from !== m.id && snap != null && memberOf(snap, msg.from) != null;
      foot = there
        ? h("button", { class: "orc-card-foot link", text: t(S.answerThere), onclick: () => select(msg.from) })
        : h("div", { class: "orc-card-foot", text: t(S.answerBelow) });
    }
    return h("div", { class: answered ? "orc-card answered" : "orc-card" },
      h("div", { class: "orc-card-ctx", text: t(S.asks, { name: titleOf(msg.from) }) }),
      q,
      h("div", { class: "orc-opts" }, ...options),
      foot);
  }

  /** Lumo's lines: a thread opened, a file kept from a second writer, a turn stopped, an error. */
  function note(m: OrchestraMember, msg: OrchestraMessage): HTMLElement | null {
    switch (msg.note) {
      case "lock": {
        // The path as code, who holds it in bold: Markdown, so the words stay one sentence in every language.
        const path = `\`${msg.text.replace(/`/g, "")}\``;
        const holder = `**${titleOf(msg.holder ?? "").replace(/[*_`]/g, "")}**`;
        const words = msg.from === m.id
          ? t(S.lockMine, { holder, path })
          : t(S.lockOther, { name: titleOf(msg.from), holder, path });
        const body = h("div", { class: "orc-lock-body" });
        renderMarkdown(body, words, { scope: scope(m, msg.id) });
        return h("div", { class: "orc-lock" }, svg(ICONS.lock, 12, { stroke: 1.8 }),
          h("div", { class: "orc-lock-text" }, h("span", { class: "orc-lock-label", text: t(S.lockLabel) }), body));
      }
      case "started": {
        const name = (snap && memberOf(snap, msg.from)?.title) || msg.text;
        const line = h("button", { class: "orc-act" }, h("span", { text: t(S.started, { name }) }));
        line.addEventListener("click", () => select(msg.from));
        return line;
      }
      case "stopped":
        return h("div", { class: "orc-note", text: t(S.stopped) });
      // Its conversation compacted (orchestra.rs compact_member): the chat's own line, its summary on a click.
      case "compacted":
        return compactMark(m.chat, msg.at, msg.text);
      case "compact-nothing":
        return h("div", { class: "orc-note", text: t(COMPACT_STRINGS.nothing) });
      case "compact-failed":
        return h("div", { class: "orc-note limit" }, h("span", { class: "orc-note-main", text: msg.text }));
      case "error": {
        // As a chat's failed answer: what went wrong, and the card that puts it right when Lumo can (signed out, not installed).
        const [problem, fix] = splitFix(msg.text);
        return bubble({ ...asChatMessage({ ...msg, text: problem }, "assistant"), failed: true, ...(fix ? { fix } : {}) }, { onOpenAgents: hooks.openAgents, chat: m.chat });
      }
      // A repository of the project's environment, cloned before the first turn (orchestra.rs ensure_repos).
      case "cloned":
        return h("div", { class: "orc-act cloned", title: msg.holder ?? "" }, h("span", { text: t(S.cloned, { repo: msg.text }) }));
      case "clone-failed": {
        const [repo, ...why] = msg.text.split(": ");
        return h("div", { class: "orc-note limit" }, h("span", { class: "orc-note-main", text: t(S.cloneFailed, { repo }) }), why.length ? h("span", { class: "orc-note-sub", text: why.join(": ") }) : null);
      }
      case "limit": {
        const then = msg.until ? t(S.limitResumes, { time: clock(msg.until) }) : t(S.limitStops);
        return h("div", { class: "orc-note limit" }, h("span", { class: "orc-note-main", text: then }), msg.text ? h("span", { class: "orc-note-sub", text: msg.text }) : null);
      }
      default:
        return msg.text ? h("div", { class: "orc-note", text: msg.text }) : null;
    }
  }

  /** A file a thread handed over: its kind, a glimpse, its name. */
  function fileCard(msg: OrchestraMessage): HTMLElement {
    const f = msg.file!;
    const ext = (/\.([^.\\/]+)$/.exec(f.name)?.[1] ?? "").toUpperCase();
    const glimpse = f.markdown
      ? h("span", { class: "orc-fglimpse doc" },
        h("span", { class: "orc-fg-title", text: f.name.replace(/\.(md|markdown)$/i, "") }),
        h("span", { class: "orc-fg-line" }), h("span", { class: "orc-fg-line" }), h("span", { class: "orc-fg-line short" }))
      : h("span", { class: "orc-fglimpse" }, svg(ICONS.doc, 18, { fill: "currentColor" }));
    const el = h("button", { class: reading?.path === f.path ? "orc-fcard sel" : "orc-fcard", title: f.path },
      f.markdown ? h("span", { class: "orc-ftype icon" }, svg(ICONS.docLine, 10, { stroke: 1.8 })) : h("span", { class: "orc-ftype", text: ext || "·" }),
      glimpse,
      h("span", { class: "orc-fname", text: f.name }));
    el.addEventListener("click", () => {
      if (f.markdown) void openDoc(f);
      else void Bridge.chatFileOpen(f.path);
    });
    return el;
  }

  function drawQueue() {
    clear(queue);
    const m = current();
    const waiting = m?.messages.filter((x) => x.kind === "user" && x.delivered === "queued" && x.note !== "answer") ?? [];
    queue.hidden = waiting.length === 0;
    for (const msg of waiting) {
      // Edit and Cancel, as a chat's queued question has: until the member reads it.
      const edit = h("button", { class: "queue-btn", title: t(CHAT_S.edit), "aria-label": t(CHAT_S.edit) }, svg(ICONS.pencil, 11, { stroke: 1.8 }));
      const cancel = h("button", { class: "queue-btn", title: t(CHAT_S.cancel), "aria-label": t(CHAT_S.cancel) }, svg(ICONS.xmark, 9));
      const text = h("div", { class: "queue-text", text: msg.text, title: msg.text });
      edit.addEventListener("click", (e) => {
        e.stopPropagation();
        void unqueue(m!, msg.id, true);
      });
      text.addEventListener("click", () => edit.click());
      cancel.addEventListener("click", (e) => {
        e.stopPropagation();
        void unqueue(m!, msg.id, false);
      });
      queue.append(h("div", { class: "chat-queue orc-queued", title: t(S.nextStep) },
        h("span", { class: "queue-label" }, svg(ICONS.clock, 10, { stroke: 2 }), h("span", { text: t(S.nextStep) })),
        text, edit, cancel));
    }
  }

  /** The queued message `message` of `m` taken back: gone (Cancel), or back in the field (Edit). Read meanwhile, it stays. */
  async function unqueue(m: OrchestraMember, message: string, toField: boolean) {
    if (!snap) return;
    const id = snap.id;
    let taken: { text: string; sent: SentItem[] } | null = null;
    try {
      taken = await Orchestra.unqueue(id, m.id, message);
    } catch (err) {
      console.error("[lumo] orchestra_unqueue failed", err);
    }
    if (!taken) return;
    Sound.play(toField ? "blip" : "pop");
    if (toField) hooks.unqueued?.(taken.text);
  }

  function drawDoc() {
    clear(doc);
    if (!reading) return;
    const file = reading;
    const close = h("button", { class: "orc-doc-x", title: t(S.close), "aria-label": t(S.close) }, svg(ICONS.xmark, 9));
    close.addEventListener("click", () => {
      reading = null;
      drawDoc();
      drawLog();
      placeClasses();
    });
    const reveal = h("button", { class: "orc-doc-btn", text: t(S.showInFolder) });
    reveal.addEventListener("click", () => void Bridge.chatFileReveal(file.path));
    const body = h("div", { class: "orc-doc-body" });
    gentleWheel(body);
    if (!file.loading) renderMarkdown(body, file.text, { scope: `orc-doc:${file.path}` });
    doc.append(
      h("div", { class: "orc-doc-bar" }, svg(ICONS.docLine, 12, { stroke: 1.8 }), h("span", { class: "orc-doc-name", text: file.name }), h("span", { class: "orc-head-gap" }), reveal, close),
      body);
  }

  // ── What the user does ─────────────────────────────────────────────────────

  function select(id: string) {
    if (!snap || !memberOf(snap, id)) return;
    selected = id;
    seen.add(id);
    menuOpen = false;
    draw(true);
    if (markCardsSeen()) changed();
    // The field and the model button say who it writes to now.
    State.notify();
  }

  function toggleMenu() {
    menuOpen = !menuOpen;
    drawRail();
    if (menuOpen) void refreshList();
  }

  async function refreshList() {
    summaries = await Orchestra.list();
    listed = true;
    if (menuOpen) drawRail();
    if (page === "list") drawPage();
  }

  /** The page in the chat's place (the list, a form), or the settings in the conversation's. */
  function drawPage() {
    const kept = page === "form" || page === "settings" ? form : null;
    if (kept && pageEl.contains(kept.el)) return;
    clear(pageEl);
    if (page === "list") {
      form = null;
      pageEl.append(buildProjectList(listed ? summaries : null, { open: (id) => void openOrchestra(id), create: () => startNew(), back: () => toChats() }));
    } else if (page === "form") {
      form = buildProjectForm({ mode: "new", fields: newFields(), save: create, cancel: () => go(formBack === "project" && snap ? "project" : "list") });
      pageEl.append(form.el);
    } else if (page === "settings" && snap) {
      const id = snap.id;
      form = buildProjectForm({ mode: "edit", fields: fieldsOf(snap), save: (f) => saveProject(id, f), cancel: () => closeSettings(), remove: () => void removeProject(id) });
      pageEl.append(form.el);
    } else form = null;
  }

  /** What New project starts from: the models of the last project made. */
  function newFields(): ProjectFields {
    const s = State.settings;
    return {
      title: "", icon: "", color: "", goal: "", folder: "", repos: [],
      coordinator: resolvePick(s.orchestraCoordinator, s, readyProviders, "coordinator"),
      thread: resolvePick(s.orchestraThread, s, readyProviders, "thread"),
      resume: true,
    };
  }

  /** Another page: what shows, and the chat around it. */
  function go(next: typeof page) {
    page = next;
    menuOpen = false;
    form = null;
    draw(true);
    State.notify();
  }

  function showList() {
    go("list");
    void refreshList();
  }

  function startNew() {
    formBack = page === "list" || !snap ? "list" : "project";
    Sound.play("blip");
    go("form");
  }

  // ── The model button's menu: the member on screen's model and effort

  let modelPop: HTMLElement | null = null;
  let modelAnchor: HTMLElement | null = null;
  let modelHost: HTMLElement | null = null;

  function closeModelMenu(target?: Node | null): boolean {
    if (!modelPop) return false;
    if (target != null && (modelPop.contains(target) || modelAnchor?.contains(target))) return false;
    modelPop.remove();
    modelAnchor?.classList.remove("open");
    modelPop = modelAnchor = modelHost = null;
    return true;
  }

  function toggleModelMenu(anchor: HTMLElement, host: HTMLElement) {
    if (closeModelMenu()) return;
    const m = current() ?? snap?.coordinator;
    if (!snap || !m) return;
    const member = m.id;
    let pick = pickOf(m);
    const menu = buildModelMenu({
      role: member === COORDINATOR ? "coordinator" : "thread",
      get: () => pick,
      set: (next) => {
        pick = next;
        void choose(member, next);
      },
      placed: placeModelMenu,
      open: (el) => modelPop === el,
    });
    menu.classList.add("orc-model-pop");
    modelPop = menu;
    modelAnchor = anchor;
    modelHost = host;
    anchor.classList.add("open");
    host.append(menu);
    placeModelMenu();
  }

  /** Over the button, at its right edge; its list at most as tall as the room above. */
  function placeModelMenu() {
    if (!modelPop || !modelAnchor || !modelHost) return;
    const a = modelAnchor.getBoundingClientRect();
    const b = modelHost.getBoundingClientRect();
    modelPop.style.right = `${Math.max(0, b.right - a.right)}px`;
    modelPop.style.bottom = `${Math.max(0, b.bottom - a.top + 6)}px`;
    const list = modelPop.querySelector<HTMLElement>(".pj-list");
    if (list) list.style.maxHeight = `${Math.max(120, Math.min(320, a.top - b.top - 140))}px`;
  }

  /** A member's model picked: shown at once, kept by the project (orchestra_set_pick). */
  async function choose(member: string, pick: OrchestraPick) {
    if (!snap) return;
    const id = snap.id;
    const m = memberOf(snap, member);
    if (m) m.pick = pick;
    State.notify();
    try {
      const next = await Orchestra.setPick(id, member, pick);
      if (snap?.id === id) {
        snap = next;
        drawRail();
        drawHead();
        State.notify();
      }
    } catch (err) {
      error = String(err).replace(/^Error:\s*/, "");
      draw();
    }
  }

  function openSettings() {
    if (!snap) return;
    Sound.play("pop");
    go("settings");
  }

  function closeSettings() {
    go(snap ? "project" : "list");
  }

  async function create(fields: ProjectFields): Promise<string | null> {
    let s: OrchestraSnapshot | null;
    try {
      s = await Orchestra.create(fields);
    } catch (err) {
      return String(err).replace(/^Error:\s*/, "");
    }
    if (!s) return null;
    // The next project starts from these models.
    State.settings = { ...State.settings, orchestraCoordinator: fields.coordinator, orchestraThread: fields.thread };
    saveSettings();
    page = "project";
    form = null;
    Sound.play("blip");
    show(s);
    State.notify();
    return null;
  }

  async function saveProject(id: string, fields: ProjectFields): Promise<string | null> {
    let s: OrchestraSnapshot | null;
    try {
      s = await Orchestra.update(id, fields);
    } catch (err) {
      return String(err).replace(/^Error:\s*/, "");
    }
    if (!s) return null;
    page = "project";
    form = null;
    Sound.play("blip");
    show(s);
    draw();
    State.notify();
    return null;
  }

  async function removeProject(id: string) {
    await Orchestra.remove(id);
    // Its members' files go from the list with it, as a deleted chat's (the files stay where they are).
    if (snap?.id === id) for (const m of membersOf(snap)) dropChatFiles(m.chat);
    summaries = summaries.filter((x) => x.id !== id);
    if (snap?.id === id) {
      snap = null;
      selected = COORDINATOR;
      reading = null;
      live.clear();
      acts.clear();
      remember("");
    }
    Sound.play("pop");
    showList();
    changed();
  }

  async function openOrchestra(id: string) {
    menuOpen = false;
    page = "project";
    form = null;
    drawRail();
    let s: OrchestraSnapshot | null = null;
    try {
      s = await Orchestra.open(id);
    } catch (err) {
      console.error("[lumo] orchestra_open failed", err);
    }
    if (s) {
      show(s);
      // The rail, the field and the model button follow it.
      draw(true);
      State.notify();
    }
  }

  async function send(text: string, attached?: OrchestraAttached, asked?: string) {
    const s = snap;
    error = "";
    if (!s || page !== "project") return;
    const to = selected;
    const m = memberOf(s, to);
    // Shown at once; the orchestra's next word has it as Rust keeps it.
    if (m) {
      m.messages = [...m.messages, {
        id: `local-${Date.now()}`, at: Date.now(), kind: "user", from: "user", text,
        ...(m.state === "working" ? { delivered: "queued" as const } : {}),
        ...(attached?.sent.length ? { sent: attached.sent } : {}),
      }];
      drawLog(true);
      drawQueue();
    }
    try {
      await Orchestra.send(s.id, to, text, attached, asked);
    } catch (err) {
      error = t(S.notSent, { error: String(err).replace(/^Error:\s*/, "") });
      drawLog(true);
    }
  }

  function answer(msg: OrchestraMessage, choice: number) {
    if (!snap || !msg.card || msg.card.chose != null) return;
    // Every copy of the card (the asker's chat, the coordinator's) shows the answer at once.
    for (const m of membersOf(snap)) {
      for (const x of m.messages) if (x.id === msg.id && x.card) x.card = { ...x.card, chose: choice };
    }
    Sound.play("blip");
    draw();
    void Orchestra.answer(snap.id, msg.from, msg.id, choice).catch((err) => {
      error = t(S.notSent, { error: String(err).replace(/^Error:\s*/, "") });
      drawLog(true);
    });
  }

  async function openDoc(f: { path: string; name: string }) {
    if (!snap) return;
    const id = snap.id;
    reading = { name: f.name, path: f.path, text: "", loading: true };
    draw();
    let got: OrchestraFile | null = null;
    try {
      got = await Orchestra.readFile(id, f.path);
    } catch (err) {
      got = { name: f.name, path: f.path, text: String(err).replace(/^Error:\s*/, "") };
    }
    if (reading?.path !== f.path) return;
    reading = { name: got?.name || f.name, path: f.path, text: got?.text ?? "" };
    drawDoc();
    drawLog();
  }

  // ── What Rust says ─────────────────────────────────────────────────────────

  function remember(id: string) {
    try {
      if (id) window.localStorage.setItem(LAST_KEY, id);
      else window.localStorage.removeItem(LAST_KEY);
    } catch {
      // Next time, the newest one opens.
    }
  }

  function lastOpened(): string | null {
    try {
      return window.localStorage.getItem(LAST_KEY);
    } catch {
      return null;
    }
  }

  function noteSummary(s: OrchestraSnapshot) {
    const row = summaryOf(s, (m) => waitingCardsIn(s, m.id) > 0);
    const at = summaries.findIndex((x) => x.id === s.id);
    if (at >= 0) summaries[at] = row;
    else summaries.push(row);
  }

  /** `s` on screen: a new orchestra opens on its coordinator; the same one keeps the member and the place. */
  function show(s: OrchestraSnapshot) {
    noteSummary(s);
    const other = !snap || snap.id !== s.id;
    if (other) {
      selected = COORDINATOR;
      live.clear();
      acts.clear();
      reading = null;
      error = "";
      seen.clear();
      for (const m of s.threads) seen.add(m.id);
      remember(s.id);
    } else if (snap) {
      for (const m of membersOf(s)) {
        const before = memberOf(snap, m.id);
        const answers = (x: OrchestraMember | undefined) => x?.messages.filter((y) => y.kind === "assistant").length ?? 0;
        // Its turn ended, or its answer came whole: the streamed text gives way.
        if (m.state !== "working" || answers(m) > answers(before)) live.delete(m.chat);
        // Its answer came: what the turn did goes with it, as with a chat's answer, kept by Rust.
        const extras = turnExtras.get(m.chat);
        if (extras && answers(m) > answers(before)) {
          const last = m.messages.filter((x) => x.kind === "assistant").at(-1);
          if (last && Object.keys(extras).length > 0) {
            last.answer = { ...(last.answer ?? {}), ...extras };
            void Orchestra.keepAnswer(s.id, m.id, last.id, extras).catch(() => {});
          }
          turnExtras.delete(m.chat);
        } else if (extras && m.state !== "working") turnExtras.delete(m.chat);
        if (m.state !== "working") acts.delete(m.chat);
      }
    }
    // Its work ended while the island was closed: the closed island says it is finished until it is opened.
    const busy = (x: OrchestraSnapshot | null) => Boolean(x && membersOf(x).some((m) => m.state === "working"));
    if (!other && busy(snap) && !busy(s) && !(State.mode === "expanded" && State.view === "prompt")) finishedUnseen = true;
    if (busy(s)) finishedUnseen = false;
    snap = s;
    if (!memberOf(s, selected)) selected = COORDINATOR;
    draw(other);
    // A card that comes while the island is open on its member is seen at once.
    markCardsSeen();
    changed();
    // The model button and the field follow the member on screen.
    if (other) State.notify();
  }

  void Orchestra.onUpdate((s) => {
    if (!s || typeof s.id !== "string") return;
    if (snap && s.id === snap.id) show(s);
    else {
      noteSummary(s);
      if (menuOpen) drawRail();
      if (page === "list" && on()) drawPage();
    }
  });

  /** The first time the projects show: the one last on screen (or the newest) comes back, else their list. */
  async function boot() {
    summaries = await Orchestra.list();
    listed = true;
    if (snap) {
      drawRail();
      return;
    }
    const last = summaries.find((s) => s.id === lastOpened()) ?? [...summaries].sort((a, b) => b.updated - a.updated)[0];
    if (last) await openOrchestra(last.id);
    else showList();
  }

  function enter() {
    if (!State.settings.orchestraMode) {
      State.settings = { ...State.settings, orchestraMode: true };
      saveSettings();
    }
    booted = true;
    Sound.play("pop");
    showList();
  }

  /** Out of the projects, on the chat that was on screen. */
  function toChats() {
    leave();
    Sound.play("pop");
    draw();
    State.notify();
  }

  function leave() {
    menuOpen = false;
    form = null;
    if (!State.settings.orchestraMode) return;
    State.settings = { ...State.settings, orchestraMode: false };
    saveSettings();
  }

  draw();

  return {
    rail,
    doc,
    head,
    log,
    queue,
    page: pageEl,
    on,
    inProject,
    welcomeCard() {
      const holder = h("div", { class: "pj-start-row" });
      const fill = () => {
        clear(holder);
        holder.append(projectsCard(listed ? summaries : null, enter));
      };
      fill();
      void Orchestra.list().then((list) => {
        summaries = list;
        listed = true;
        fill();
      });
      return holder;
    },
    enter,
    leave,
    openSettings,
    toggleModelMenu,
    closeModelMenu,
    sync(body: HTMLElement) {
      host = body;
      placeClasses();
      if (!on()) return;
      if (askedOnIsland && State.mode === "expanded" && State.view === "prompt") {
        const id = askedOnIsland;
        askedOnIsland = "";
        if (snap && memberOf(snap, id) && waitingCards(id) > 0 && id !== selected) {
          selected = id;
          seen.add(id);
          draw(false);
          queueMicrotask(() => State.notify());
        }
      }
      // Seen: the closed island no longer says it finished.
      if (finishedUnseen && State.mode === "expanded" && State.view === "prompt") {
        finishedUnseen = false;
        changed();
      }
      // Seen: the closed island no longer says the member on screen asks, as a chat's answer once read.
      if (markCardsSeen()) changed();
      if (!booted) {
        booted = true;
        void boot();
      }
    },
    send,
    memberChat() {
      return page === "project" ? current()?.chat ?? null : null;
    },
    knownFiles() {
      const m = page === "project" ? current() : undefined;
      if (!m) return [];
      return m.messages.flatMap((x) => [...(x.file ? [x.file.path] : []), ...(x.answer?.files ?? []).map((f) => f.path)]);
    },
    delta(chat, text) {
      const m = snap ? memberByChat(snap, chat) : undefined;
      if (!m) return false;
      if (!text) return true;
      const fresh = !live.has(chat);
      live.set(chat, text);
      if (m.id !== selected || !on() || quietText(m, text)) return true;
      const atEnd = stuck();
      if (!liveEl) {
        liveEl = h("div", { class: "reply" });
        const row = h("div", { class: "chat-row" }, liveEl);
        if (nowEl) log.insertBefore(row, nowEl);
        else log.append(row);
      }
      writeLive(m, liveEl, text, fresh);
      drawLiveSpeed(m);
      if (atEnd) log.scrollTop = log.scrollHeight;
      return true;
    },
    contextSeen(chat, used, total, estimate) {
      const m = snap ? memberByChat(snap, chat) : undefined;
      if (!snap || !m || estimate || !(total > 0)) return;
      const pct = Math.round((used / total) * 100);
      // Asked once while it stays this full; a local model only, as a chat's auto-compaction.
      if (pct < AUTO_COMPACT_PCT) compactAsked.delete(chat);
      if (pct < AUTO_COMPACT_PCT || compactAsked.has(chat) || State.settings.chatAutoCompact === false) return;
      if (!providerDef(pickOf(m).provider).urlField) return;
      compactAsked.add(chat);
      void Orchestra.compact(snap.id, m.id).catch(() => compactAsked.delete(chat));
    },
    editSend(text) {
      const m = current();
      if (!editing || !m || editing.member !== m.id) return false;
      retry(m, editing.message, text);
      return true;
    },
    cancelEdit() {
      if (!editing) return false;
      editing = null;
      drawLog();
      return true;
    },
    anchorOf(chat) {
      const m = snap ? memberByChat(snap, chat) : undefined;
      if (!m) return null;
      const answers = m.messages.filter((x) => x.kind === "assistant").length;
      return m.state === "working" ? answers : Math.max(0, answers - 1);
    },
    redraw() {
      if (on() && page === "project") drawLog();
    },
    compactMember() {
      const m = current();
      if (!snap || !m || page !== "project" || isCliProvider(pickOf(m).provider)) return false;
      void Orchestra.compact(snap.id, m.id).catch((err) => {
        error = t(S.notSent, { error: String(err).replace(/^Error:\s*/, "") });
        drawLog(true);
      });
      return true;
    },
    turnFile(chat, kind, path) {
      if (!snap || !memberByChat(snap, chat)) return false;
      // A file it only read is in the chat's files, not under its answer.
      if (kind !== "read") {
        const x = extrasOf(chat);
        x.files = withReplyFile(x.files ?? [], path, kind);
      }
      return true;
    },
    turnCommand(chat, ran) {
      if (!snap || !memberByChat(snap, chat)) return false;
      const x = extrasOf(chat);
      x.commands = [...(x.commands ?? []), ran].slice(-MAX_COMMANDS);
      return true;
    },
    turnSpeed(chat, speed) {
      const m = snap ? memberByChat(snap, chat) : undefined;
      if (!m) return false;
      extrasOf(chat).speed = speed;
      drawLiveSpeed(m);
      return true;
    },
    activity(chat, activity) {
      const m = snap ? memberByChat(snap, chat) : undefined;
      if (!m) return false;
      if (activity) acts.set(chat, activity);
      if (!on()) return true;
      drawRail();
      const label = nowEl?.querySelector(".typing-label");
      if (label && m.id === selected) label.textContent = stepText(m);
      return true;
    },
    placeholder() {
      const m = current();
      return m && m.id !== COORDINATOR ? t(S.writeTo, { name: m.title }) : t(S.writeCoordinator);
    },
    button() {
      // Only the model of the chat on screen: the coordinator's, or the thread's.
      const pick = pickOf(current() ?? null);
      const name = modelName(pick.provider, pick.model);
      return { name: pick.effort ? `${name} · ${effortLabel(pick.effort)}` : name, dot: providerDef(pick.provider).accent };
    },
    startNew,
    toggleMenu,
    get snapshot() {
      return snap;
    },
    get selected() {
      return selected;
    },
    islandLine() {
      if (!State.settings.orchestraMode || !snap) return null;
      const who = `«${snap.title || t(S.untitled)}»`;
      const members = membersOf(snap);
      // A card waiting for the user comes first: a click opens the island on it.
      const asking = members.find((m) => unseenCards(m.id) > 0);
      if (asking) {
        // Said on the closed island: opening it shows that member's question.
        if (State.mode !== "expanded") askedOnIsland = asking.id;
        return { who, color: WAITING_COLOR, label: t(S.asks, { name: nameOf(asking) }) };
      }
      const working = members.filter((m) => m.state === "working").length;
      if (working > 0) {
        const plan = snap.plan.length ? ` · ${t(S.planPill, { done: snap.plan.filter((p) => p.status === "completed").length, total: snap.plan.length })}` : "";
        return { who, color: ORCHESTRA_ACCENT, label: `${tn("{count} at work", S.atWork, working)}${plan}` };
      }
      if (!finishedUnseen) return null;
      const last = snap.coordinator.messages.filter((m) => m.kind === "assistant").at(-1);
      const first = last?.text.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").replace(/\*\*/g, "").trim()).find(Boolean) ?? "";
      return { who, color: DONE_COLOR, label: first ? `${t(S.finished)} · ${first}` : t(S.finished) };
    },
    usageOf() {
      if (!inProject()) return null;
      const m = current() ?? null;
      const pick = pickOf(m);
      // No orchestra yet: the coordinator's to be, on a chat of its own none has written to.
      return { chat: m?.chat ?? "", ...pick };
    },
  };
}
