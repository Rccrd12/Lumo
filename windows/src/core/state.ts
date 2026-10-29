// App state: what the island shows and remembers.

import type { ListenWatch } from "./listen";
import { newChatId } from "./chats";
import type { BotEmoteName, BotStateName, IslandMode, IslandViewName } from "./layout";
import type { EyeShape } from "../character/engine";
import {
  DEFAULT_MAIN_PILL, availablePills, orderPills, pillDefinition, sanitizeDeclared,
  toggleDeclared, type PillDefinition,
} from "./pills";
import type { AntigravityPlanUsage, CodexPlanUsage, PlanKind, PlanUsage } from "./plan";
import type { ProviderId } from "./providers";
import type { FileDiff } from "./diff";
import type { Bindings } from "./shortcuts";
import type { SharedContext } from "./bridge";
import { DEFAULT_COMPUTER_CURSOR, DEFAULT_LOOK, DEFAULT_OUTFIT, type LumoLook, type Outfit } from "../character/wardrobe";
import { pillColor } from "./pill-colors";
import { effectiveEffort, type Effort } from "./energy";
import { WORKSHOP_PREFIX, type ToolInfo } from "./tools";

export type AgentSource = "claudeCode" | "n8n" | "agent";
export type PillBadge = "approval" | "finished" | "error";

export interface AgentTask {
  id: string;
  name: string;
  color: string;
  state: BotStateName;
  stepIndex: number;
  steps: string[];
  /**
   * Position of the newest step in the whole session. `steps` is capped, so
   * `stepIndex` stops moving once it is full; this keeps counting.
   */
  stepSeq?: number;
  /**
   * What each step can show once opened (views/steps.ts), aligned with
   * `steps`. Only trusted while both have the same length: a place that
   * resets `steps` on its own simply leaves no detail.
   */
  stepDetails?: (StepDetail | null)[];
  source: AgentSource;
  isIntegration: boolean;
  emote?: BotEmoteName | null;
  miniEye?: EyeShape | null;
  pillBadge?: PillBadge | null;
  sessionCwd?: string | null;
  /** Claude Code's session, so "Open terminal" can find the window it runs in. */
  sessionId?: string | null;
  /** Claude's final message after Stop, one line; cleared when a new turn starts. */
  finalLine?: string | null;
}

/**
 * The whole of what a step's one line cuts short: the command, the path, the
 * prompt, the error. Kept only when the event carried it.
 */
export interface StepDetail {
  /** Plain text: the tool's description, a whole prompt or answer, an error. */
  text?: string;
  /** Monospace: a command, a path, a URL, a pattern. */
  code?: string;
}

/** The detail of `task.steps[index]`, when one was kept. */
export function stepDetailAt(task: AgentTask, index: number): StepDetail | null {
  const details = task.stepDetails;
  if (!details || details.length !== task.steps.length) return null;
  return details[index] ?? null;
}

export interface ApprovalInfo {
  requestId: string;
  sessionId: string;
  /** The pill the request belongs to: VS Code's or Cursor's (Claude Code), or an agent's (Codex…). */
  pillId: string;
  tool: string;
  command: string;
  /** What the agent says the request is for, in its own words (core/approvals.ts requestReason). */
  reason?: string;
  /** What the request does, when the agent did not say (core/approvals.ts requestKind): English, through t(). */
  kind?: { text: string; vars?: Record<string, string> };
  /** Set when Claude Code is asking a question rather than for a permission. */
  questions?: AskedQuestion[];
  /** Asked by the island's own chat (Claude Code provider): no session pill, and the chat comes back after. */
  fromChat?: boolean;
  /** "Allow for this session" can be offered: the same request is then allowed without a card until the session ends (session_rules.rs). */
  sessionAllow?: boolean;
  /** Simple (a read, a command that only looks): answered on the closed island (core/approvals.ts). */
  quick?: boolean;
  /** Simple enough for the closed island, for a request waiting in line: whether it goes there is decided when it comes up. */
  simple?: boolean;
  /** The project of the session asking, when the pill is named after one (two sessions can share a pill). */
  project?: string;
}

/** One question of an AskUserQuestion call. */
export interface AskedQuestion {
  question: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** An answer cut short by the Stop button. */
  stopped?: boolean;
  /** Its place in Rust's conversation (chat.rs), once recorded there; editing cuts it there. */
  turn?: number;
}

export type PromptContext =
  | { kind: "window"; appName: string; title: string; url?: string }
  | { kind: "file"; name: string; path?: string };

/** A fresh, idle task for a catalog pill, in the colour the user gave it if any. */
function taskFor(def: PillDefinition, colors: unknown, name = def.name): AgentTask {
  return {
    id: def.id, name, color: pillColor(def.id, def.color, colors), state: "idle", stepIndex: 0, steps: [],
    source: def.source, isIntegration: true,
  };
}

/**
 * A pill whose sessions arrive as hook events: an agent's, or a workspace
 * tool's (VS Code, Cursor…), which is a catalog pill too. Not a service's.
 */
export function isSessionTask(task: AgentTask): boolean {
  return task.source === "claudeCode" || task.source === "agent";
}

/** What an integration poller last reported. */
export interface IntegrationInfo {
  data: Record<string, unknown>;
  error: string | null;
  loaded: boolean;
  configured: boolean;
}

/**
 * When the open island closes on its own: some seconds after the mouse
 * leaves ("timer"), as soon as it leaves, on a click
 * elsewhere, or never (Esc, a shortcut or the tray).
 */
export type IslandCloseMode = "timer" | "leave" | "click" | "never";

export function parseCloseMode(v: unknown): IslandCloseMode {
  return v === "leave" || v === "click" || v === "never" ? v : "timer";
}

/**
 * How much Lumo moves on his own: "still" (only when something happens, as
 * before 0.3.1), "calm" (he hovers, breathes and looks around) or "lively".
 */
export type LumoMotion = "still" | "calm" | "lively";

export function parseMotion(v: unknown): LumoMotion {
  return v === "still" || v === "lively" ? v : "calm";
}

/** The engine's ambient amount for a motion setting. */
export function motionAmount(v: unknown): number {
  const m = parseMotion(v);
  return m === "still" ? 0 : m === "lively" ? 1.8 : 1;
}

export interface Settings {
  soundEnabled: boolean;
  soundVolume: number;
  autoCloseInterval: number;
  /** Declared pills next to the main one (at most 4), in the order they were added. */
  activeIntegrations: string[];
  /** The always-on workspace pill: VS Code, Cursor, Codex or Antigravity. */
  mainPill: string;
  /** "primary", "cursor", or `at:<x>,<y>` for one display (logical origin). */
  screen: string;
  /** How big the island is drawn (1 = its usual size). */
  islandZoom: number;
  /** How far the island sits from its edge of the screen: "none", "light", "medium" or "wide". */
  islandEdgeGap: string;
  /** The edge the island hangs from, and how far from its middle (owned by Rust). */
  islandDock: string;
  islandOffset: number;
  /** Floating: how far from the top or bottom edge it grows from (island.rs owns it). */
  islandFloat: number;
  /** Width of the open island and its height (0 = each view's own); owned by Rust. */
  islandWidth: number;
  islandHeight: number;
  /** How big the icons are drawn (1 = their usual size). */
  iconScale: number;
  /** When the open island closes on its own (settings.rs island_close). */
  islandClose: IslandCloseMode;
  /** The closed island opens when the mouse rests on it. */
  islandHoverOpen: boolean;
  /** The closed island goes away a minute after the mouse left it. */
  islandAutoHide: boolean;
  /** The closed island says what the AI is doing and what just happened (core/compact.ts). */
  compactActivity: boolean;
  /** The closed island shows the music playing (media.rs). */
  compactMedia: boolean;
  /** The live activities (island/activities.ts) are on. */
  activitiesPanel: boolean;
  /** Folded into their icon in the open island's top bar. */
  activitiesFolded: boolean;
  /** Beside the island: "left" or "right". */
  activitiesSide: string;
  /** Their size; a height of 0 follows the island. */
  activitiesWidth: number;
  activitiesHeight: number;
  /** In a window of their own (Windows), at this physical position. */
  activitiesDetached: boolean;
  activitiesX: number;
  activitiesY: number;
  /** The Plan island's window (plan_island.rs): moved by hand to this physical position, and its size (0 = default). Rust's. */
  agentPlanMoved: boolean;
  agentPlanX: number;
  agentPlanY: number;
  agentPlanWidth: number;
  agentPlanHeight: number;
  autostart: boolean;
  hooksInstalled: boolean;
  /** Claude model used by the chat. */
  model: string;
  /** Show the Claude plan pill (5 h and weekly limits) in the island's header. */
  showPlanInNotch: boolean;
  /** Lumo's status line relay is installed in Claude Code's settings. */
  planRelayInstalled: boolean;
  /** Show the Codex plan pill in the island's header. */
  showCodexPlanInNotch: boolean;
  /** Show the Antigravity CLI pill in the island's header. */
  showAntigravityPlanInNotch: boolean;
  /**
   * The plan pills turned off in Settings ("codex", "antigravity"): an added
   * agent's pill shows on its own otherwise.
   */
  hiddenPlanPills: string[];
  /** Ask Anthropic for the Claude plan's usage with Claude Code's sign-in (plan_usage.rs). */
  planUsageOnline: boolean;
  /** Simple permission requests are answered on the closed island (core/approvals.ts). */
  quickApprovals: boolean;
  /** The live activities beside the island are as tall as it, and follow its resizes. */
  activitiesFollowIsland: boolean;
  /** The Email pill leaves out the promotional emails (mail.rs). */
  mailHidePromotions: boolean;
  /** Settings → General → Energy (core/energy.ts): "none", "light", "auto" or "saver". */
  energyMode: string;
  /** With "auto" on mains power: "none" or "light". */
  energyOnPower: string;
  /** The right-click menu's own items, in order (core/context-menu.ts). */
  contextMenu: string[];
  /** Who the chat talks to (see core/providers.ts); picked in the chat view. */
  chatProvider: ProviderId;
  /** The model picked for each provider other than Anthropic, by provider id. */
  chatModels: Record<string, string>;
  /** Claude Code's effort for the chat ("low" … "max"); "" = Claude Code's default. */
  chatEffort: string;
  /** What the chat's CLIs may do without asking (core/providers.ts PERMISSION_MODES). */
  chatPermissionMode: string;
  /** A quiet line next to the chat's model picker with what the provider has left (core/chat-usage.ts). */
  chatShowUsage: boolean;
  /**
   * Every chat message carries the folder open in File Explorer, as if picked
   * from the screen button. Off until the user turns it on in Settings → Chat.
   */
  chatShareExplorer: boolean;
  /** Every message carries the open windows and their documents (desk.rs). */
  chatShareOpen: boolean;
  /** The chat's Claude Code may see the screen, click and type (Windows; computer.rs). Off by default. */
  chatComputerUse: boolean;
  /** Model server addresses once connected; empty means not connected. */
  ollamaUrl: string;
  lmstudioUrl: string;
  customUrl: string;
  /** Global shortcuts the user changed, by action id (see core/shortcuts.ts). */
  shortcuts: Bindings;
  /**
   * Lumo's outfit: "auto" (dresses for the season), "none" or an outfit id.
   * Read it through parseOutfit.
   */
  lumoOutfit: string;
  /** How much Lumo moves on his own; read it through parseMotion. */
  lumoMotion: string;
  /**
   * Lumo's look, picked in the wardrobe or Settings → Island: "filo" (a ring
   * of light), "punto", "goccia" or "lucciola" (the firefly). Read it through
   * parseLook (character/wardrobe.ts).
   */
  lumoCharacter: string;
  /**
   * The mouse Claude wears while it uses the computer, picked in the wardrobe:
   * "direct" (a dark arrow) or "lucciola" (a butter one). Read it through
   * parseComputerCursor (character/wardrobe.ts).
   */
  computerCursor: string;
  /** Corners close in on where Claude is about to click (the wardrobe's Aim). */
  computerAim: boolean;
  /**
   * A colour of the user's own for a pill's Lumo, by pill ID ("#RRGGBB").
   * Empty means the catalog's colours; read it through core/pill-colors.ts.
   */
  pillColors: Record<string, string>;
  /**
   * Interface language: "" follows the system (when Lumo has its language,
   * else English), or one of src/i18n's ten codes ("fr", "pt-BR", "zh-Hans"…).
   */
  language: string;
  /** When Lumo opens, one look at GitHub for a newer release (Settings → Updates). */
  updateCheckOnOpen: boolean;
  /** Gemini Live (Settings → Voice): "gemini-3.8-live" or its Extended Thinking. */
  liveModel: string;
  /** Extended Thinking's level: "low", "medium" or "high". */
  liveThinking: string;
  /** One of Google's voices; "" lets Gemini pick. */
  liveVoice: string;
  /** Who takes what Gemini can't do: "claude-code" or "antigravity-cli". */
  liveHelper: string;
  /** The helper's model: "default" (its own choice), else one the chat's picker offers for it. */
  liveHelperModel: string;
  /** Claude Code's effort for the helper ("low" … "max"); "" = its own default. */
  liveHelperEffort: string;
  /** Gemini may take a screenshot when it decides it needs one, during a call. */
  liveScreen: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  soundEnabled: true,
  soundVolume: 0.12,
  autoCloseInterval: 15,
  activeIntegrations: [
    "integration_resend", "integration_n8n", "integration_vercel", "integration_github",
  ],
  mainPill: DEFAULT_MAIN_PILL,
  screen: "primary",
  islandZoom: 1.15,
  islandEdgeGap: "light",
  islandDock: "top",
  islandOffset: 0,
  islandFloat: 0,
  islandWidth: 640,
  islandHeight: 0,
  iconScale: 1.25,
  islandClose: "timer",
  islandHoverOpen: false,
  islandAutoHide: false,
  compactActivity: true,
  compactMedia: true,
  activitiesPanel: true,
  activitiesFolded: false,
  activitiesSide: "left",
  activitiesWidth: 264,
  activitiesHeight: 0,
  activitiesDetached: false,
  activitiesX: 0,
  activitiesY: 0,
  agentPlanMoved: false,
  agentPlanX: 0,
  agentPlanY: 0,
  agentPlanWidth: 0,
  agentPlanHeight: 0,
  autostart: false,
  hooksInstalled: false,
  model: "claude-opus-5-5",
  showPlanInNotch: false,
  planRelayInstalled: false,
  showCodexPlanInNotch: false,
  showAntigravityPlanInNotch: false,
  hiddenPlanPills: [],
  planUsageOnline: false,
  quickApprovals: true,
  activitiesFollowIsland: true,
  mailHidePromotions: false,
  energyMode: "auto",
  energyOnPower: "light",
  contextMenu: ["newChat", "pin", "sound", "activities", "center", "settings"],
  chatProvider: "anthropic",
  chatModels: {},
  chatEffort: "",
  chatPermissionMode: "default",
  chatShowUsage: false,
  chatShareExplorer: false,
  chatShareOpen: true,
  chatComputerUse: false,
  ollamaUrl: "",
  lmstudioUrl: "",
  customUrl: "",
  shortcuts: {},
  lumoOutfit: DEFAULT_OUTFIT,
  lumoMotion: "calm",
  lumoCharacter: DEFAULT_LOOK,
  computerCursor: DEFAULT_COMPUTER_CURSOR,
  computerAim: true,
  pillColors: {},
  language: "",
  updateCheckOnOpen: true,
  liveModel: "gemini-3.8-live",
  liveThinking: "medium",
  liveVoice: "",
  liveHelper: "claude-code",
  liveHelperModel: "default",
  liveHelperEffort: "",
  liveScreen: true,
};

type Listener = () => void;

/** Live diffs kept per pill (oldest dropped first). */
export const MAX_DIFFS_PER_PILL = 50;
/** A pill's diffs are forgotten after an hour without a new one. */
export const DIFF_TTL_MS = 3_600_000;

/** A chat put aside while the other slot is on screen (AppState.useSlot). */
interface ParkedChat {
  chatId: string;
  chatHistory: ChatMessage[];
  chatSession: string | null;
  droppedFile: AppState["droppedFile"];
  moreFiles: AppState["moreFiles"];
  promptContext: PromptContext | null;
}

class AppState {
  mode: IslandMode = "hidden";
  view: IslandViewName = "overview";

  tasks: AgentTask[] = [];
  focusId: string | null = null;

  stateOverride: BotStateName | null = null;
  /** How Lumo looks during a Gemini Live call (src/live/session.ts); null otherwise. */
  liveState: BotStateName | null = null;
  /** A Gemini Live call is on: the island opens on it, and the compact island stays. */
  liveActive = false;
  /** Claude is using the computer for the chat: the island stays compact and on screen. */
  computerActive = false;
  /**
   * The chat is answering: what it is doing, in words ("Reading main.ts"), or
   * null once the answer is being written. For the closed island (core/compact.ts).
   */
  chatActivity: { label: string | null } | null = null;
  /** A question the chat asks as soon as it is on screen (an email's buttons). */
  chatAsk: string | null = null;
  /** The pull requests Lumo listens to for the chat (core/listen.ts, listen.rs). */
  listening: ListenWatch[] = [];
  /** The live activities can show beside the open island (an edge with room for them). */
  activitiesRoom = false;
  /** The Plan island's icon shows in the chat: there are plans to look at (island/plan.ts). */
  planIcon = false;
  /** The Plan island is open (its icon in the chat looks pressed). */
  planOpen = false;

  /** Cursor in logical screen pixels, origin top-left (like AppState.mousePosition). */
  mouse = { x: 0, y: 0 };
  /** Cursor relative to the island's top-left corner. */
  mouseInIsland = { x: 0, y: 0 };

  isPinned = false;
  paused = false;
  /** The computer runs on its battery (energy.rs), for Settings → General → Energy. */
  onBattery = false;

  /** How hard Lumo works now (core/energy.ts). */
  get effort(): Effort {
    return effectiveEffort(this.settings.energyMode, this.settings.energyOnPower, this.onBattery);
  }

  uploadProgress = 0;
  uploadDuration = 2.4;
  /** A dropped file just landed in the chat: it says so until `until` (Date.now()). */
  uploadedNote: { name: string; until: number } | null = null;
  fileDragOver = false;

  promptContext: PromptContext | null = null;
  /**
   * The file added to the chat; `sent` once it went with a question, and
   * `sentWith` that question's id, so editing it sends the file again (views/chat.ts).
   */
  droppedFile: { name: string; path: string; sent?: boolean; sentWith?: number } | null = null;
  /** More files added while `droppedFile` still waited: they go with the same question. */
  moreFiles: { name: string; path: string }[] = [];
  noteMessage: string | null = null;
  /** What a sharing shortcut just took, for the chat to pick up (island/shortcuts.ts). */
  incomingShare: SharedContext | null = null;
  chatHistory: ChatMessage[] = [];
  /** The model picker or the past chats are open: the chat takes its full height. */
  chatPanelOpen = false;
  /**
   * A picture of the chat's previews, opened big: it fills the whole open
   * island, and Lumo steps out of its way (views/picture.ts, island.ts).
   */
  picture: { src: string; caption: string } | null = null;
  /** The id of the current chat in the history (chats.ts). */
  chatId = newChatId();
  /**
   * What the chat view shows: the chat, or the tool workshop (views/forge.ts),
   * a chat of its own with its own history, opened from the Tools tab.
   */
  chatSlot: "chat" | "forge" = "chat";
  /** The other slot's chat, put aside while this one is on screen (useSlot). */
  private parkedChats: Partial<Record<"chat" | "forge", ParkedChat>> = {};
  /** The user's tools (tools.rs), as the Tools tab lists them. */
  tools: ToolInfo[] = [];
  /**
   * The Tools tab opened the workshop: Add a tool (`edit` null), or Change
   * with Lumo on a tool. The chat view takes it on its next draw.
   */
  forgeAsk: { edit: ToolInfo | null } | null = null;
  /** The Claude Code session the current chat continues, if Claude Code answered it. */
  chatSession: string | null = null;
  pendingApproval: ApprovalInfo | null = null;
  /**
   * Requests that came while the card was up, oldest first: each comes up
   * in turn once the one before is answered.
   */
  approvalQueue: ApprovalInfo[] = [];
  /** The pill that was in front when the card came up; it comes back after. */
  focusBeforeApproval: string | null = null;
  /** Whether the island was pinned (Ctrl+P) when the card came up; it is again after. */
  pinnedBeforeApproval: boolean | null = null;

  integrations: Record<string, IntegrationInfo> = {};

  /** Claude's 5 h / weekly limits, from the status line (null until the first call). */
  planUsage: PlanUsage | null = null;
  /** Codex's limits, from `codex app-server` (null until it has answered). */
  codexPlanUsage: CodexPlanUsage | null = null;
  /** Antigravity CLI's quotas, from `agy -p /usage` (null until it has answered). */
  antigravityPlanUsage: AntigravityPlanUsage | null = null;
  /** A plan card is open in place of the overview's left card. */
  showingPlanDetail = false;
  /** Which one. */
  planDetail: PlanKind = "claude";
  /** Per-pill file diffs, in order of reception. Steps carry their ids. */
  sessionDiffs = new Map<string, FileDiff[]>();
  private sessionDiffTimers = new Map<string, number>();
  /** Never reset, so an id can never point at a newer diff than the one tapped. */
  private nextDiffId = 0;

  /** Outfit shown on Lumo while the pointer rests on a wardrobe button. */
  wardrobePreview: Outfit | null = null;
  /** A look tried on in the wardrobe (the pointer rests on it); null = the chosen one. */
  lookPreview: LumoLook | null = null;

  settings: Settings = { ...DEFAULT_SETTINGS };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Marks the UI dirty; the island re-renders on the next frame. */
  notify() {
    for (const fn of this.listeners) fn();
  }

  get focusTask(): AgentTask | null {
    return this.tasks.find((t) => t.id === this.focusId) ?? this.tasks[0] ?? null;
  }

  get effectiveState(): BotStateName {
    // A card waiting for an answer shows over the call.
    const live = this.pendingApproval ? null : this.liveState;
    return this.stateOverride ?? live ?? this.focusTask?.state ?? "idle";
  }

  /** What Lumo looks like: the effective state, the chat's answer included. */
  get shownState(): BotStateName {
    return this.effectiveState;
  }

  get otherTasks(): AgentTask[] {
    return this.tasks.filter((t) => t.id !== this.focusId);
  }

  setFocus(id: string) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    this.focusId = id;
    this.showingPlanDetail = false;
    t.pillBadge = null;
    this.notify();
  }

  /**
   * A permission card or a question comes up: its pill comes to the front, and
   * the pill that was there is remembered (HookServer.focusBeforeApproval).
   */
  /**
   * The chat view shows `slot`: the chat or the tool workshop. Each keeps its
   * own chat, files and all, while the other is on screen; an answer still
   * being written goes on in its own chat.
   */
  useSlot(slot: "chat" | "forge") {
    if (slot === this.chatSlot) return;
    this.parkedChats[this.chatSlot] = {
      chatId: this.chatId,
      chatHistory: this.chatHistory,
      chatSession: this.chatSession,
      droppedFile: this.droppedFile,
      moreFiles: this.moreFiles,
      promptContext: this.promptContext,
    };
    this.chatSlot = slot;
    const back = this.parkedChats[slot];
    delete this.parkedChats[slot];
    if (back) {
      Object.assign(this, back);
      return;
    }
    this.startChat();
    this.droppedFile = null;
    this.promptContext = null;
  }

  /** The workshop's chat, on screen or put aside; null before it was ever opened. */
  workshopChat(): { chatId: string; chatHistory: ChatMessage[] } | null {
    if (this.chatSlot === "forge") return { chatId: this.chatId, chatHistory: this.chatHistory };
    return this.parkedChats.forge ?? null;
  }

  /** A fresh chat: what was said goes, the history keeps the old one. */
  startChat() {
    this.moreFiles = [];
    this.chatHistory = [];
    this.chatId = this.chatSlot === "forge" ? `${WORKSHOP_PREFIX}${newChatId()}` : newChatId();
    this.chatSession = null;
  }

  beginApproval(info: ApprovalInfo) {
    this.pendingApproval = info;
    if (this.pinnedBeforeApproval == null) this.pinnedBeforeApproval = this.isPinned;
    this.isPinned = true;
    if (this.focusBeforeApproval == null) this.focusBeforeApproval = this.focusId;
    this.setFocus(info.pillId);
  }

  /**
   * The card has its answer, or is withdrawn: the session carries on, and the
   * pill you were on comes back — unless you moved to another one meanwhile.
   */
  endApproval() {
    const req = this.pendingApproval;
    if (!req) return;
    this.pendingApproval = null;
    // A pin the user had set stays, as long as the island is still open.
    this.isPinned = this.pinnedBeforeApproval === true && this.mode === "expanded";
    this.pinnedBeforeApproval = null;
    if (!req.fromChat) this.updateTask(req.pillId, "working");
    this.setPillBadge(req.pillId, null);
    const previous = this.focusBeforeApproval;
    this.focusBeforeApproval = null;
    if (previous && this.focusId === req.pillId && this.tasks.some((t) => t.id === previous)) {
      this.focusId = previous;
    }
    // The next request in line takes the card; whoever ended this one shows it.
    const next = this.approvalQueue.shift();
    if (next) {
      this.beginApproval(next);
      if (!next.fromChat) this.updateTask(next.pillId, next.questions ? "question" : "approval");
    }
    this.notify();
  }

  updateTask(id: string, state: BotStateName) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.state = state;
    this.notify();
  }

  appendStep(id: string, step: string, detail: StepDetail | null = null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    const newest = t.stepSeq ?? t.steps.length - 1;
    const details = t.stepDetails?.length === t.steps.length ? t.stepDetails : t.steps.map(() => null);
    t.steps.push(step);
    details.push(detail);
    if (t.steps.length > 20) {
      t.steps.shift();
      details.shift();
    }
    t.stepDetails = details;
    t.stepIndex = t.steps.length - 1;
    t.stepSeq = newest + 1;
    this.notify();
  }

  setPillBadge(id: string, badge: PillBadge | null) {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    t.pillBadge = badge;
    this.notify();
  }

  /** Stores a diff for a pill and returns its id (for the ticker step). */
  appendSessionDiff(pillId: string, diff: FileDiff): number {
    const id = this.nextDiffId++;
    const list = this.sessionDiffs.get(pillId) ?? [];
    list.push({ ...diff, id });
    while (list.length > MAX_DIFFS_PER_PILL) list.shift();
    this.sessionDiffs.set(pillId, list);
    // One timer per pill, re-armed on every diff — nothing polls.
    const prev = this.sessionDiffTimers.get(pillId);
    if (prev != null) window.clearTimeout(prev);
    this.sessionDiffTimers.set(
      pillId,
      window.setTimeout(() => this.clearSessionDiffs(pillId), DIFF_TTL_MS),
    );
    return id;
  }

  findDiff(pillId: string, id: number): FileDiff | null {
    return this.sessionDiffs.get(pillId)?.find((d) => d.id === id) ?? null;
  }

  clearSessionDiffs(pillId: string) {
    const timer = this.sessionDiffTimers.get(pillId);
    if (timer != null) window.clearTimeout(timer);
    this.sessionDiffTimers.delete(pillId);
    this.sessionDiffs.delete(pillId);
  }

  /** The always-on workspace pill, once the setting has been checked. */
  get mainPillId(): string {
    return sanitizeDeclared(this.settings).mainPill;
  }

  /**
   * True for a pill that stays when its session ends: the main pill and the
   * declared ones go back to idle instead of going away.
   */
  isKept(id: string): boolean {
    const d = sanitizeDeclared(this.settings);
    return id === d.mainPill || d.activeIntegrations.includes(id);
  }

  /**
   * Loads the catalog pills: the main pill always, the declared ones, and none
   * of the others — a pill that is mid-session stays until its session ends.
   * Safe to call any number of times.
   */
  loadIntegrationTasks() {
    const d = sanitizeDeclared(this.settings);
    this.settings.mainPill = d.mainPill;
    this.settings.activeIntegrations = d.activeIntegrations;
    for (const def of availablePills()) {
      const shouldLoad = def.id === d.mainPill || d.activeIntegrations.includes(def.id);
      const idx = this.tasks.findIndex((t) => t.id === def.id);
      if (shouldLoad && idx < 0) this.tasks.push(taskFor(def, this.settings.pillColors));
      const busy = idx >= 0 && (this.tasks[idx].state !== "idle" || this.tasks[idx].steps.length > 0);
      if (!shouldLoad && idx >= 0 && !busy) this.tasks.splice(idx, 1);
    }
    // A colour picked in Settings reaches the pills that are already up.
    for (const t of this.tasks) {
      const def = pillDefinition(t.id);
      if (def) t.color = pillColor(def.id, def.color, this.settings.pillColors);
    }
    this.tasks = orderPills(this.tasks, d.mainPill);
    if (!this.focusId || !this.tasks.some((t) => t.id === this.focusId)) this.focusId = d.mainPill;
    this.notify();
  }

  /**
   * A session is over. The main and declared pills are put back as they were;
   * any other pill goes away.
   */
  removeTask(id: string) {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return;
    if (this.isKept(id)) {
      const t = this.tasks[idx];
      t.state = "idle";
      t.steps = [];
      t.stepIndex = 0;
      delete t.stepSeq;
      t.pillBadge = null;
      t.finalLine = null;
      const def = pillDefinition(id);
      if (def) t.name = def.name;
      this.clearSessionDiffs(id);
      this.notify();
      return;
    }
    this.tasks.splice(idx, 1);
    this.clearSessionDiffs(id);
    if (this.focusId === id) this.focusId = this.tasks[0]?.id ?? this.mainPillId;
    this.notify();
  }

  /**
   * Creates the pill of a tagged agent on its first event; no-op if it exists.
   * Inserted right after the main pill so it is in the visible slice(0,4). A
   * catalog agent wears its catalog colour.
   */
  upsertExternalAgent(id: string, name: string, color: string) {
    if (this.tasks.some((t) => t.id === id)) return;
    const def = pillDefinition(id);
    this.insertAfterMain({
      id, name, color: def ? pillColor(def.id, def.color, this.settings.pillColors) : color,
      state: "idle", stepIndex: 0, steps: [],
      source: "agent", isIntegration: false,
    });
  }

  /**
   * The pill a Claude Code session belongs to (VS Code or Cursor). It is made
   * for the session when it is neither the main pill nor declared.
   */
  upsertWorkspacePill(id: string, name: string, cwd: string): AgentTask | null {
    let t = this.tasks.find((x) => x.id === id);
    if (!t) {
      const def = pillDefinition(id);
      if (!def) return null;
      t = taskFor(def, this.settings.pillColors, name);
      this.insertAfterMain(t);
    }
    t.name = name;
    if (cwd) t.sessionCwd = cwd;
    return t;
  }

  private insertAfterMain(t: AgentTask) {
    const at = this.tasks.findIndex((x) => x.id === this.mainPillId) + 1;
    this.tasks.splice(at, 0, t);
    if (!this.focusId) this.focusId = t.id;
    this.notify();
  }

  /** Declares or undeclares a pill (max 4 next to the main one). */
  toggleIntegration(id: string) {
    const next = toggleDeclared(sanitizeDeclared(this.settings), id);
    if (!next) return;
    this.settings.activeIntegrations = next;
    if (!next.includes(id) && this.focusId === id) this.focusId = this.mainPillId;
    this.loadIntegrationTasks();
  }

  /**
   * The tab last open, Chat or Agents: closing and reopening the island
   * brings it back (island.ts records it as the view changes).
   */
  lastTab: "chat" | "agents" | "tools" = "chat";
  /**
   * On the Tools tab, whether the workshop was on screen rather than the list:
   * back to the list, the workshop's chat stays parked, but the island reopens
   * on the list.
   */
  private toolsInWorkshop = false;

  /** Remembers the tab `view` belongs to; any other view leaves it as it was. */
  noteTab(view: IslandViewName) {
    if (view === "tools" || (view === "prompt" && this.chatSlot === "forge")) {
      this.lastTab = "tools";
      this.toolsInWorkshop = view === "prompt";
    }
    else if (view === "prompt" || view === "live") this.lastTab = "chat";
    else if (view === "overview" || view === "empty") this.lastTab = "agents";
  }

  /**
   * What the island opens on. A card waiting for an answer comes first, so
   * reopening a folded island shows it again; otherwise the
   * tab it was left on, Chat or Agents.
   */
  defaultView(): IslandViewName {
    if (this.pendingApproval) return this.pendingApproval.questions ? "question" : "approval";
    if (this.lastTab === "agents") return this.agentsView();
    if (this.lastTab === "tools") return this.toolsInWorkshop && this.chatSlot === "forge" ? "prompt" : "tools";
    return this.liveActive ? "live" : "prompt";
  }

  /** The Agents tab: the coding sessions and pills, or the empty card. */
  agentsView(): IslandViewName {
    return this.tasks.length === 0 ? "empty" : "overview";
  }

  /** What the Agents tab shows on its badge: a session waiting on you, or one at work. */
  get agentsActivity(): "waiting" | "working" | null {
    const sessions = this.tasks.filter(isSessionTask);
    if (this.pendingApproval || sessions.some((t) => t.state === "approval" || t.state === "question")) return "waiting";
    if (sessions.some((t) => t.state === "working" || t.state === "thinking" || t.state === "searching")) return "working";
    return null;
  }
}

export const State = new AppState();
