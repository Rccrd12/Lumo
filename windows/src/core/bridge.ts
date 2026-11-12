import type { CopyDiff } from "./copy-diff";
import type { ChatCompact } from "./chats";
import type { MailRevision } from "./mail-edit";
// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Settings } from "./state";
import type { MailPeek, MediaActivity } from "./compact";
import type { ChatUsage } from "./chat-usage";
import type { ListenPast, ListenWatch } from "./listen";
import { readMailHtml } from "./mail-html";
import type { RecapHistory, RecapPrefs } from "../recap/summary";
import type { ToolDraft, ToolInfo, ToolRun } from "./tools";
import type { LocalCaps } from "./providers";

/** An answer to a permission card: `always` allows it for the rest of the session. */
/** `edits`: a plan approved with "let it edit files without asking" (Claude Code's acceptEdits, for the session). */
export type Decision = "allow" | "deny" | "always" | "edits";

/**
 * Settings open inside the island (an iframe of settings.html, see
 * views/settings-frame.ts) talk to Rust through the island page: Rust's
 * events never reach a frame.
 */
export interface TauriHost {
  invoke: typeof invoke;
  listen: typeof listen;
}

const HOST: TauriHost | null = (() => {
  if (typeof window === "undefined" || window.parent === window) return null;
  try {
    return (window.parent as unknown as { __LUMO_HOST__?: TauriHost }).__LUMO_HOST__ ?? null;
  } catch {
    return null;
  }
})();

/** This page is the Settings inside the island, not the Settings window. */
export const EMBEDDED = HOST != null;

/**
 * The writes that Settings inside the island confirm in Windows' own box
 * (confirmed.rs by_hand): while it is up, a click on it is no click elsewhere.
 */
const ASKS_WINDOWS = new Set(["hooks_apply", "agent_hooks_apply", "status_line_apply"]);

/** The island page lends its connection to Rust to the Settings inside it. */
export function lendTauri() {
  const lent: typeof invoke = async (cmd, args, options) => {
    if (!ASKS_WINDOWS.has(cmd)) return invoke(cmd, args, options);
    dialogs++;
    dialogsChanged?.();
    try {
      return await invoke(cmd, args, options);
    } finally {
      dialogs--;
      dialogsChanged?.();
    }
  };
  (window as unknown as { __LUMO_HOST__?: TauriHost }).__LUMO_HOST__ = { invoke: lent, listen };
}

export const IS_TAURI =
  typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || HOST != null);

const tauriInvoke: typeof invoke = (cmd, args, options) => (HOST?.invoke ?? invoke)(cmd, args, options);
const tauriListen: typeof listen = (event, handler, options) => (HOST?.listen ?? listen)(event, handler, options);

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!IS_TAURI) return null;
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (err) {
    console.error(`[lumo] ${cmd} failed`, err);
    return null;
  }
}

/** Settings → Pills → Email: the classic Outlook on this PC (outlook.rs). */
/** One IMAP account of the Email pill as Settings lists it (mail.rs): never its password. */
export interface MailAccount {
  slot: number;
  address: string;
  /** The server it reads, typed or found from the address. */
  host: string;
  state: "ok" | "error" | "paused" | "connecting";
  error?: string;
}

export interface OutlookStatus {
  installed: boolean;
  running: boolean;
  /** Its accounts' addresses. */
  accounts: string[];
}

/** Settings → Updates: what a check found (updater.rs). */
export interface UpdateInfo {
  current: string;
  latest: string;
  newer: boolean;
  notes: string;
  /** Lumo-Windows-<latest>-setup.exe of that release, when it has one. */
  assetUrl: string | null;
  /** This build is a beta (its version has a pre-release part, 0.18.1-312). */
  currentBeta?: boolean;
  /** The beta channel's build, when it was asked for and one is published. */
  beta?: BetaInfo | null;
}

/** The beta channel's build: main with every open pull request (updater.rs BetaInfo). */
export interface BetaInfo {
  version: string;
  newer: boolean;
  publishedAt: string;
  assetUrl: string | null;
  included: BetaPull[];
  excluded: BetaPull[];
}

/** A pull request in the beta, or left out of it: why, and what it conflicts with ("main" or a number). */
export interface BetaPull {
  number: number;
  title: string;
  updatedAt: string;
  with?: string;
  /** "conflict", "checks" (its Windows CI failed) or "pending" (still running). */
  reason?: string;
}

/** Page pixels the island is drawn off its usual place: a floating island kept on its display. */
export interface IslandShift {
  x: number;
  y: number;
}

export interface BootInfo {
  settings: Settings;
  version: string;
  /** Where the island is drawn in its window, off its usual place (island.rs shift). */
  shift: IslandShift;
  /** The computer runs on its battery (energy.rs). */
  onBattery?: boolean;
}

/** System dialogs of ours open right now (the file picker): a click in them is not "elsewhere". */
let dialogs = 0;
export const isDialogOpen = () => dialogs > 0;
/** Told when one of those dialogs opens or closes (the island's leave countdown waits on it). */
let dialogsChanged: (() => void) | null = null;
export function onDialogsChanged(fn: () => void) {
  dialogsChanged = fn;
}

export const Bridge = {
  boot: () => call<BootInfo>("boot"),
  /** The system's languages as the webview sees them, for Rust's own texts (i18n.rs). */
  setSystemLanguages: (languages: string[]) => call<void>("set_system_languages", { languages }),

  saveSettings: (settings: Settings) => call<void>("save_settings", { settings }),

  /** Shrink the window down to the invisible wake strip (hidden) or back to full. */
  setCollapsed: (collapsed: boolean) => call<void>("set_collapsed", { collapsed }),

  /**
   * Pushes the island shape in window coordinates. Rust flips click-through from
   * its own cursor poll, so the flag is never a frame behind a click.
   */
  setIslandRect: (x: number, y: number, width: number, height: number) =>
    call<void>("set_island_rect", { x, y, width, height }),

  /** Give the window keyboard focus (chat field) and take it away again. */
  focusWindow: (focused: boolean) => call<void>("focus_window", { focused }),


  reposition: () => call<void>("reposition"),

  /** Displays the island can be pinned to: `key` is what `settings.screen` stores. */
  listMonitors: () => call<{ key: string; label: string }[]>("list_monitors"),

  openUrl: (url: string) => call<void>("open_url", { url }),

  /**
   * An image of a chat answer, downloaded by Rust unless Settings → Security
   * → Images from the web is off (web_image.rs: https and public addresses
   * only, PNG, JPEG, GIF, WebP or AVIF, 8 MB at most): its bytes as they
   * came; it throws what went wrong when it could not be.
   */
  /** `asked`: the user clicked Load image for it (any other site than web_image.rs AUTO_HOSTS needs that). */
  webImage: (url: string, asked = false) => callOrThrow<ArrayBuffer>("web_image", asked ? { url, asked } : { url }),

  /** "Open terminal" → opens the folder in VS Code when `code` is on PATH. */
  openInVSCode: (path: string | null) => call<boolean>("open_in_vscode", { path }),

  /**
   * "Open terminal": the window the session runs in when Rust found it
   * (Windows), else the folder in VS Code.
   */
  openSession: (sessionId: string | null, path: string | null) =>
    call<boolean>("open_session", { sessionId, path }),

  /** The Claude desktop app, for the Claude Desktop pill (Windows only). */
  openClaudeDesktop: () => call<boolean>("open_claude_desktop"),

  /** The diff card's ↗: an existing file, in VS Code; never launched by its type. */
  openFileInVSCode: (path: string) => call<boolean>("open_file_in_vscode", { path }),

  quit: () => call<void>("quit_app"),

  openSettingsWindow: () => call<void>("open_settings_window"),

  /** Writes to %LOCALAPPDATA%\com.rccrd12.lumo\lumo.log, next to the Rust lines. */
  log: (message: string) => call<void>("log_line", { message }),

  // ── Claude Code hooks ─────────────────────────────────────────────────────
  hooksStatus: () => call<HookStatus>("hooks_status"),
  /** Pill ID → whether that agent's hooks reach Lumo (read-only). */
  agentHooksStatus: () => call<Record<string, boolean>>("agent_hooks_status"),
  /** Diff to show before anything is written. `install: false` previews removal. */
  hooksPreview: (install: boolean) => callOrThrow<HookPreview>("hooks_preview", { install }),
  /**
   * Writes ~/.claude/settings.json — only ever after an explicit click, and only
   * when the file still matches the preview the user looked at.
   */
  hooksApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("hooks_apply", { install, fingerprint }),

  // ── Other agents (Gemini CLI, Codex, Cursor…) ─────────────────────────────
  agentHooksList: () => call<AgentHookStatus[]>("agent_hooks_list"),
  /** Diff to show before anything is written. `install: false` previews removal. */
  agentHooksPreview: (agent: string, install: boolean) =>
    callOrThrow<AgentHookPlan>("agent_hooks_preview", { agent, install }),
  /**
   * Writes the agent's config — only ever after an explicit click, and only when
   * it still matches the preview the user looked at. Returns the backups taken.
   */
  agentHooksApply: (agent: string, install: boolean, fingerprint: string) =>
    callOrThrow<string>("agent_hooks_apply", { agent, install, fingerprint }),
  // ── Plan usage: the status line relay, installed apart from the hooks ──────
  /** Diff of the status line change. `install: false` previews taking the relay out. */
  statusLinePreview: (install: boolean) => callOrThrow<HookPreview>("status_line_preview", { install }),
  /** Same rules as hooksApply: an explicit click, and only for the diff that was shown. */
  statusLineApply: (install: boolean, fingerprint: string) =>
    callOrThrow<string>("status_line_apply", { install, fingerprint }),
  /**
   * Asks the Codex CLI (`codex app-server`) for its plan limits, as Codex's
   * /status does. The raw `account/rateLimits/read` result, or null when Codex
   * is missing, not signed in or slow (15 s).
   */
  codexPlanUsage: () => call<unknown>("codex_plan_usage"),
  /**
   * Asks Antigravity CLI (`agy -p /usage`) for its quotas, as its /usage does.
   * Its groups and buckets (antigravity_plan.rs), or null when agy is missing,
   * not signed in or slow (20 s).
   */
  antigravityPlanUsage: () => call<unknown>("antigravity_plan_usage"),
  /** The Claude plan's usage from Anthropic, as the status line's `rate_limits` (plan_usage.rs). Throws why it could not. */
  planUsageFetch: () => callOrThrow<unknown>("plan_usage_fetch"),

  /** `always`: allowed, and allowed again without a card for the rest of the session (session_rules.rs). */
  approvalDecision: (requestId: string, decision: Decision) =>
    call<void>("approval_decision", { requestId, decision }),
  /** "The card is up" — until this lands the relay only waits a moment. */
  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),
  /** The chat's Antigravity CLI run in Auto lets a command that only looks through, with no card. */
  approvalAutoAllow: (requestId: string) => call<void>("approval_auto_allow", { requestId }),
  /** Answers a question Claude Code asked: question text → chosen label. */
  approvalAnswer: (requestId: string, answers: Record<string, string | string[]>) =>
    call<void>("approval_answer", { requestId, answers }),

  /** Send on an email's card the user changed: the email as it is on the card (pipe.rs answer_mail). */
  approvalMailSend: (requestId: string, revised: MailRevision) =>
    call<void>("approval_mail_send", { requestId, revised }),
  /** Attach on an email's card: the system's picker; each file picked, by name, size and path (mail.rs). */
  pickAttachments: async (): Promise<{ name: string; size: number; path: string }[]> => {
    const picked = await call<unknown>("pick_attachments");
    if (!Array.isArray(picked)) return [];
    return picked
      .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
      .map((f) => ({ name: typeof f.name === "string" ? f.name : "", size: typeof f.size === "number" ? f.size : 0, path: typeof f.path === "string" ? f.path : "" }))
      .filter((f) => f.name && f.path);
  },

  /** "Nobody can act on this" — Claude Code asks in the terminal right away. */
  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),

  // ── Chat, files, secrets ──────────────────────────────────────────────────
  /**
   * One chat turn. The API key and any file bytes never leave Rust. `screen`
   * is what the user added from the screen button, sent with this turn only.
   */
  chatSend: (chatId: string, query: string, context: ChatContext | null, screen?: ScreenContext | null) =>
    callOrThrow<ChatReply>("chat_send", screen ? { chatId, query, context, screen } : { chatId, query, context }),
  /** A new chat on screen; an answer still written in another one goes on. */
  chatReset: (chatId: string) => call<void>("chat_reset", { chatId }),
  /** Listens to a pull request for the chat `chatId` (listen.rs); `mode` "every": once for each new commit. */
  listenAdd: (repo: string, number: number, until: string, task: string, chatId: string, mode = "once") =>
    call<ListenWatch>("listen_add", { repo, number, until, mode, task, chatId }),
  /** Stops listening to a pull request (`until` null: to everything on it). */
  listenCancel: (repo: string, number: number, until: string | null = null) =>
    call<number>("listen_cancel", { repo, number, until }),
  /** Listens on this PC (listen_local.rs): a file or a folder, a program or a port, a web page; or to what Lumo hears. */
  listenAddLocal: async (source: string, target: string, until: string, text: string, task: string, chatId: string, mode = "once", amount = 0) =>
    (await Bridge.listenTryLocal(source, target, until, text, task, chatId, mode, amount)).watch ?? null,
  /** The same, with why it could not: `needs:…` names what to turn on first (listen_events.rs available). */
  listenTryLocal: async (source: string, target: string, until: string, text: string, task: string, chatId: string, mode = "once", amount = 0): Promise<{ watch?: ListenWatch; error?: string }> => {
    if (!IS_TAURI) return {};
    try {
      return { watch: await tauriInvoke<ListenWatch>("listen_add_local", { source, target, until, mode, text, amount, task, chatId }) };
    } catch (err) {
      console.error("[lumo] listen_add_local failed", err);
      return { error: String(err) };
    }
  },
  /** An event on the calendar coming up, for a watch on it (`at`: its start). */
  listenFire: (id: number, summary: string, at: number) => call<boolean>("listen_fire", { id, summary, at }),
  /** A webhook's address, on this PC. */
  listenWebhookUrl: (id: number) => call<string | null>("listen_webhook_url", { id }),
  /** Stops listening to a target on this PC, for every event. */
  listenCancelLocal: (source: string, target: string) => call<number>("listen_cancel_local", { source, target }),
  listenList: () => call<ListenWatch[]>("listen_list"),
  /** Stops one watch, by its id. */
  listenStop: (id: number) => call<boolean>("listen_stop", { id }),
  /** Pauses or resumes one watch (`id` null: every one). */
  listenPause: (id: number | null, paused: boolean) => call<number>("listen_pause", { id, paused }),
  /** What fired, oldest first. */
  listenHistory: () => call<ListenPast[]>("listen_history"),
  listenHistoryClear: () => call<void>("listen_history_clear"),
  // The user's own tools (the Tools tab, tools.rs).
  toolsList: () => call<ToolInfo[]>("tools_list"),
  /** The user's click on Save in the workshop: the draft becomes a tool, on. */
  toolsSave: (draft: ToolDraft) => callOrThrow<ToolInfo>("tools_save", { draft }),
  toolsSetEnabled: (id: string, enabled: boolean) => callOrThrow<void>("tools_set_enabled", { id, enabled }),
  toolsDelete: (id: string) => callOrThrow<void>("tools_delete", { id }),
  /** The user's click on Try in the workshop: runs the draft once with `input`. */
  toolsTry: (draft: ToolDraft, input: Record<string, unknown>) => callOrThrow<ToolRun>("tools_try", { draft, input }),
  /** A tool's files and what they hold, for the workshop to change it. */
  toolsFiles: (id: string) => call<[string, string][]>("tools_files", { id }),
  /** Opens a tool's folder in File Explorer, or the folder of them all. */
  toolsReveal: (id: string | null) => call<void>("tools_reveal", { id }),
  /** "Always ask" or "Trust" for one tool; refused for one Lumo can't hold to what it declared. */
  toolsSetTrust: (id: string, trust: boolean) => callOrThrow<void>("tools_set_trust", { id, trust }),
  /** A tool's command in the chat's "/" menu ("" takes it away): the name as saved, or why not. */
  toolsSetCommand: (id: string, command: string) => callOrThrow<string>("tools_set_command", { id, command }),
  /** Has the supervisor review a tool again (tool_review.rs); the answer comes as `tool-review`. */
  toolsReview: (id: string) => call<void>("tools_review", { id }),
  /** The tools being reviewed now. */
  toolsReviewing: () => call<string[]>("tools_reviewing"),
  /** Whether Claude Code in the terminal has the tools' MCP server. */
  toolsTerminalHas: () => call<boolean>("tools_terminal_has"),
  /** Adds the tools' server to Claude Code in the terminal (`claude mcp add`), or takes it away. */
  toolsTerminalSet: (on: boolean) => callOrThrow<boolean>("tools_terminal_set", { on }),
  /** The Stop button of one chat: its `chatSend` then returns what was written so far, `stopped`. */
  chatStop: (chatId: string) => call<void>("chat_stop", { chatId }),
  /** The commands Claude Code's last chat turn said it has (claude_code.rs); null before one. */
  chatCommands: () => call<string[] | null>("chat_commands"),
  /** An edited message: the conversation goes back to its first `keep` turns (`ChatReply.turns`). */
  chatRewind: (chatId: string, keep: number) => call<void>("chat_rewind", { chatId, keep }),
  /** One of the chat's files taken out of its context (its ×): the AI is told with the next question. */
  chatForgetFile: (chatId: string, name: string, path: string) => call<void>("chat_forget_file", { chatId, name, path }),
  /** Alt + drag: Rust moves the island with the mouse until the button is let go. */
  /** `island`: the island as drawn (x, y, width, height, page pixels), without what sits beside it. */
  islandDrag: (island?: [number, number, number, number]) => call<void>("island_drag", { island: island ?? null }),
  /** Puts the island back at the top centre of its display. */
  islandRecenter: () => call<void>("island_recenter"),
  /** Drag on a grip of the island (see layout.gripFactors); Rust follows the mouse until it is let go. */
  /** `minWidth`: a view that goes narrower than the others (the new look's home), else none. */
  /** `view`: the slot of the view being resized (layout.ts sizeSlot), whose size alone changes. */
  islandResize: (fx: number, fy: number, height: number, minWidth: number | null = null, view: string | null = null) =>
    call<void>("island_resize", { fx, fy, height, minWidth, view }),
  /** Double click on a grip: the usual width, height, or both, for that view's slot. */
  islandResetSize: (width: boolean, height: boolean, view: string | null = null) =>
    call<void>("island_reset_size", { width, height, view }),
  /** Reopens a chat from the history, and the Claude Code session that answered it. */
  chatRestore: (chatId: string, turns: { role: string; content: string }[], session: string | null, compact: ChatCompact | null = null) =>
    call<void>("chat_restore", { chatId, turns, session, compact }),
  /** /compact with a provider called by its API: the summary that now stands for the chat's turns; null with nothing new. */
  /** The summary, and the history sent to the model before and after it (characters). */
  chatCompact: (chatId: string) => callOrThrow<(ChatCompact & { before: number; after: number }) | null>("chat_compact", { chatId }),
  /** The system's file picker; the picked file is copied into the inbox like a drop. */
  pickFile: async () => {
    dialogs++;
    try {
      return await callOrThrow<DroppedFile | null>("pick_file");
    } finally {
      dialogs--;
    }
  },
  /** The system's folder picker, for the Listening panel: the path, or null. */
  pickFolder: async () => {
    dialogs++;
    try {
      return await call<string | null>("pick_folder");
    } finally {
      dialogs--;
    }
  },
  // The chat's screen button (screen.rs). Each runs on the user's click only.
  /** The displays, for the menu. Captures nothing. */
  screenDisplays: () => callOrThrow<ScreenDisplay[]>("screen_displays"),
  /** Titles and app names of the open windows, front to back. */
  screenWindows: () => callOrThrow<OpenWindow[]>("screen_windows"),
  /** The listed windows picked by id (all of them for `[]`), with what each one shows (share.rs). */
  screenWindowShare: (ids: number[]) => callOrThrow<SharedWindow[]>("screen_window_share", { ids }),
  /** A screenshot of one listed window, saved in the inbox, with a preview. */
  screenWindowShot: (id: number) => callOrThrow<ScreenShot>("screen_window_shot", { id }),
  /** The tabs open in Edge and Chrome: titles (and addresses, where known) only. */
  screenTabs: () => callOrThrow<BrowserTab[]>("screen_tabs"),
  /** The listed tabs picked by id (all of them for `[]`), with their pages' text. */
  screenTabShare: (ids: string[]) => callOrThrow<BrowserTab[]>("screen_tab_share", { ids }),
  /** Screenshots of one display (from 0) or all (null), saved in the inbox, with a preview. */
  screenCapture: (display: number | null) => callOrThrow<ScreenShot[]>("screen_capture", { display }),
  /** Deletes screenshots the user did not keep. */
  screenDiscard: (paths: string[]) => call<void>("screen_discard", { paths }),
  /** The folder open in File Explorer and what is in it, shared with the chat (explorer.rs). */
  screenExplorer: () => callOrThrow<ExplorerFolder | null>("screen_explorer"),
  /** Every folder open in File Explorer, names only, the front window's first. Lists nothing. */
  screenExplorerPeekAll: () => callOrThrow<ExplorerFolder[]>("screen_explorer_peek_all"),
  /** The open folders picked by path (every open one for `[]`), with what is in them, shared with the chat. */
  screenExplorerShare: (paths: string[]) => callOrThrow<ExplorerFolder[]>("screen_explorer_share", { paths }),
  /**
   * The file of a shared folder that `query` names, copied into the inbox
   * like a picked one; null when it names none.
   */
  explorerAttach: (folder: string, query: string) =>
    callOrThrow<DroppedFile | null>("explorer_attach", { folder, query }),
  /**
   * The models a provider offers, for the picker in the chat view. Rust asks
   * the provider only when it has a key (or a server address).
   */
  chatModels: (provider: string) => callOrThrow<ModelInfo[]>("chat_models", { provider }),
  /**
   * The OpenRouter key's credits, for the chat's usage line. Rust asks
   * OpenRouter only while the option is on, OpenRouter is the chat's provider
   * and it has a key; null otherwise or on any failure.
   */
  chatUsage: () => call<ChatUsage | null>("chat_usage"),
  /** Settings → Local models → Connect: does the server answer, and with which models? */
  /** The custom server's key, bound to the address it is entered for. */
  localSetKey: (url: string, key: string, provider: "custom" | "unsloth" = "custom") => callOrThrow<void>("local_set_key", { url, key, provider }),

  localConnect: (provider: "ollama" | "lmstudio" | "unsloth" | "custom", url: string) =>
    callOrThrow<LocalServer>("local_connect", { provider, url }),
  /** Settings → Local models: the models Ollama, LM Studio or Unsloth Studio holds in memory now. */
  localLoaded: (provider: "ollama" | "lmstudio" | "unsloth") => callOrThrow<LocalLoaded[]>("local_loaded", { provider }),
  /** What a local model can do (pictures, tools, reasoning, its context), as its server says. */
  localCaps: (provider: string, model: string) => callOrThrow<LocalCaps>("local_caps", { provider, model }),
  /** The chat picker: which of `models` the server holds in memory now. */
  localLoadedOf: (provider: string, models: string[]) => callOrThrow<string[]>("local_loaded_of", { provider, models }),
  /** The chat picker's +: resolves once the model is in memory (progress: `local-load` events). */
  localLoad: (provider: string, model: string) => callOrThrow<void>("local_load", { provider, model }),
  /** The chat picker's −: the model leaves the server's memory. */
  localUnloadModel: (provider: string, model: string) => callOrThrow<void>("local_unload_model", { provider, model }),
  /** Settings → Local models → Free memory: unloads every model the server holds; how many were. */
  localUnload: (provider: "ollama" | "lmstudio" | "unsloth") => callOrThrow<number>("local_unload", { provider }),
  /** Settings → Local models → Unsloth Studio: installed, off, starting or on, and whether Lumo started it. */
  unslothStudioStatus: () => call<UnslothStudio>("unsloth_studio_status"),
  /** Settings → Local models → Start now: resolves once Unsloth Studio answers (progress: `unsloth-studio` events). */
  unslothStudioStart: () => callOrThrow<void>("unsloth_studio_start"),
  /** Settings → Local models → Stop now: the Unsloth Studio Lumo started stops; whether there was one. */
  unslothStudioStop: () => callOrThrow<boolean>("unsloth_studio_stop"),
  /** Settings → Local models → Download: resolves once the model is there (progress: `local-pull` events). */
  localPull: (provider: "ollama" | "lmstudio", model: string) => callOrThrow<void>("local_pull", { provider, model }),
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
  /** An attached picture in the inbox as a data URL, for the chat's preview; null for any other file. */
  filePreview: (path: string) => call<string | null>("file_preview", { path }),
  /**
   * A chat's file (core/chat-files.ts) opened by its type, or shown in File
   * Explorer when it would run something: "opened", "shown", "missing" or
   * "refused" (chat_files.rs).
   */
  chatFileOpen: (path: string) => call<string>("chat_file_open", { path }),
  /** The chat's folder of copies (workspace.rs): a copy and its original, line by line. */
  workspaceDiff: (chat: string, path: string) => callOrThrow<CopyDiff>("workspace_diff", { chat, path }),
  /** The copy written over its original, after a click. */
  workspacePutBack: (chat: string, path: string) => callOrThrow<void>("workspace_put_back", { chat, path }),
  workspaceDelete: (chat: string) => call<void>("workspace_delete", { chat }),
  /** File Explorer on a chat's file, selected: "shown", "missing" or "refused". */
  chatFileReveal: (path: string) => call<string>("chat_file_reveal", { path }),
  /** A chat's picture as a data URL, for its preview; null for any other file. */
  chatFilePreview: (path: string) => call<string | null>("chat_file_preview", { path }),
  /** A deleted chat's copies in the inbox go, but for those `keep` names; how many went. */
  inboxRelease: (paths: string[], keep: string[]) => call<number>("inbox_release", { paths, keep }),
  /** The inbox's files no chat names in `keep`, a day old or more, go; how many went. */
  inboxTidy: (keep: string[]) => call<number>("inbox_tidy", { keep }),
  /** Which of a chat's files are still where they were. */
  chatFilesPresent: (paths: string[]) => call<boolean[]>("chat_files_present", { paths }),
  /**
   * Ctrl+V in the chat: what the page got from the clipboard (an image, a
   * file), sent raw and written into the inbox like a drop.
   */
  pasteFile: (name: string, bytes: Uint8Array) => {
    if (!IS_TAURI) return Promise.reject(new Error("not running inside Lumo"));
    return tauriInvoke<DroppedFile>("paste_file", bytes, { headers: { "x-lumo-name": encodeURIComponent(name) } });
  },
  /** Ctrl+V in the chat with no text and no image: the file copied in File Explorer, copied into the inbox. */
  pasteCopiedFile: () => callOrThrow<DroppedFile | null>("paste_copied_file"),
  /** The text on the clipboard (the right-click menu's Paste), read by Lumo. */
  clipboardText: () => call<string | null>("clipboard_text"),
  /** Whether Outlook runs and its accounts: asked only if it runs, never started (outlook.rs). */
  outlookStatus: () => call<OutlookStatus>("outlook_status"),
  /** The Email pill's IMAP accounts, the first (the default) first (mail.rs). */
  mailAccounts: () => call<MailAccount[]>("mail_accounts"),
  /** The island's Email view: each account and its newest emails, only the unread ones or all the recent ones (mail.rs mail_view). */
  mailView: (unreadOnly: boolean) => call<unknown>("mail_view", { unreadOnly }),
  /** The HTML of an email of the Email view: "" when it has none, null when it couldn't be asked (asked again next time). */
  mailHtml: async (id: string): Promise<string | null> => {
    const got = await call<unknown>("mail_html", { id });
    return got == null ? null : readMailHtml(got);
  },
  /** The IMAP server an address is read from when none is typed. */
  mailServerFor: (address: string) => call<string>("mail_server_for", { address }),
  /** Signs in with what was typed and stores the account only if the server took it: the server read, or why not. */
  mailAccountAdd: (address: string, password: string, server: string) => callOrThrow<string>("mail_account_add", { address, password, server }),
  mailAccountRemove: (address: string) => callOrThrow<void>("mail_account_remove", { address }),
  /** Only ever tells you whether a key exists — never its value. */
  secretPresent: (key: string) => call<boolean>("secret_present", { key }),
  /** The chat providers that are set up: a key stored, or the CLI installed with Lumo's hooks (lib.rs). */
  chatProviders: () => call<string[]>("chat_providers"),
  secretSet: (key: string, value: string) => callOrThrow<void>("secret_set", { key, value }),
  secretClear: (key: string) => callOrThrow<void>("secret_clear", { key }),

  // ── Integrations ──────────────────────────────────────────────────────────
  refreshIntegration: (id: string) => call<void>("refresh_integration", { id }),
  /** The GitHub card is on screen: refetch that part if it is stale. */
  githubRefresh: (section: "pulse" | "activity") => call<void>("github_refresh", { section }),
  /** Opens the configured n8n instance in the browser. */
  openN8n: () => call<void>("open_n8n"),

  /** Tray → Pause. Stops the integration pollers, not just the island. */
  setPaused: (paused: boolean) => call<void>("set_paused", { paused }),

  // ── Global shortcuts ──────────────────────────────────────────────────────
  /** How each global shortcut went when Rust last registered them. */
  shortcutsStatus: () => call<ShortcutsReport>("shortcuts_status"),
  /** Lets go of every global shortcut while Settings records a new one. */
  shortcutsSuspend: (suspended: boolean) => call<void>("shortcuts_suspend", { suspended }),

  // ── Weekly recap ──────────────────────────────────────────────────────────
  /** Turns and decisions from `since` (Unix seconds) on, plus the recap prefs. */
  recapHistory: (since: number) => call<RecapHistory>("recap_history", { since: Math.floor(since) }),
  recapPrefs: () => call<RecapPrefs>("recap_prefs"),
  recapSetEnabled: (enabled: boolean) => call<void>("recap_set_enabled", { enabled }),
  recapSetHideProjects: (hide: boolean) => call<void>("recap_set_hide_projects", { hide }),
  /** `week` is the Monday (YYYY-MM-DD) the recap opened on its own for. */
  recapMarkShown: (week: string) => call<void>("recap_mark_shown", { week }),
  recapClear: () => call<void>("recap_clear"),
  /** Writes the PNG (a data URL) into Pictures or Downloads; returns its path. */
  recapSavePng: (data: string, week: string) => callOrThrow<string>("recap_save_png", { data, week }),
  /** Opens the folder of the image saved last. */
  recapRevealSaved: () => call<void>("recap_reveal_saved"),

  // ── Gemini Live (src-tauri/src/live.rs, src/live) ─────────────────────────
  /** A short-lived token that opens one connection: the Google AI key stays in Rust. */
  liveToken: () => callOrThrow<LiveToken>("live_token"),
  /** A file's text, an image, a folder's listing, or what kind of document it is. */
  liveRead: (path: string) => callOrThrow<LiveReading>("live_read", { path }),
  /** Files and folders whose names match, in the user's folders or `within`. */
  liveFind: (query: string, within: string | null) => callOrThrow<LiveFound[]>("live_find", { query, within }),
  /** A PDF, an Office file or an image read by Gemini, with the answer to `question`. */
  liveDocument: (path: string, question: string) => callOrThrow<string>("live_document", { path, question }),
  /** Opens a document, a folder or a web page; never a program. Returns what was opened. */
  liveOpen: (target: string) => callOrThrow<string>("live_open", { target }),
  /** Starts an app the Start menu (or the app menu) lists. Returns its name. */
  liveOpenApp: (name: string) => callOrThrow<string>("live_open_app", { name }),
  /** Hands a task to the helper of Settings → Voice; its answer. Cards ask for what it may not do alone. */
  liveHelp: (task: string, folder: string | null) => callOrThrow<string>("live_help", { task, folder }),
  liveHelpStop: () => call<void>("live_help_stop"),
  /** Something to do on the screen, for Claude Code with Lumo's computer tools (live.rs use_computer). */
  liveComputer: (task: string) => callOrThrow<string>("live_computer", { task }),
  /** Computer use is on and Claude Code is set up for Lumo: Gemini may hand screen work over. */
  liveComputerReady: () => call<boolean>("live_computer_ready"),
  /** Types `text` into the window in front, as the keyboard would; never Enter. */
  liveType: (text: string) => callOrThrow<LiveTyped>("live_type", { text }),
  // ── Gemini Live's tools for the computer itself (src/live/pc-tools.ts) ────
  /** Volume, brightness, power plan or lock (system_control.rs); the state after. */
  pcControl: (action: string, value: number | null, plan: string | null) =>
    callOrThrow<Record<string, unknown>>("pc_control", { action, value, plan }),
  /** Front, left/right half, maximise, minimise, restore or close a window (window_control.rs). */
  pcWindow: (window: string, action: string) => callOrThrow<{ title: string; app: string }>("pc_window", { window, action }),
  /** Processor, memory, disks, battery and the busiest programs (pc_status.rs). */
  pcStatus: () => callOrThrow<PcStatus>("pc_status"),
  /** A plan of moves, checked, nothing done (file_moves.rs). */
  pcFilesPlan: (moves: { from: string; to: string }[], folders: string[]) => callOrThrow<PcFilePlan>("pc_files_plan", { moves, folders }),
  /** The plan the user agreed to. */
  pcFilesApply: (id: number) => callOrThrow<PcFilesDone>("pc_files_apply", { id }),
  /** The last plan applied, put back. */
  pcFilesUndo: () => callOrThrow<PcFilesDone>("pc_files_undo"),
  /** Windows' notification centre (notifications.rs). */
  pcNotifications: () => callOrThrow<{ app: string; text: string; at: number }[]>("pc_notifications"),
  /** Reminders at a time, kept across restarts (reminders.rs); `reminder-due` when one rings. */
  remindersAdd: (at: number, text: string) => callOrThrow<Reminder>("reminders_add", { at, text }),
  remindersList: () => call<Reminder[]>("reminders_list"),
  remindersCancel: (id: number) => call<boolean>("reminders_cancel", { id }),
  /** The page asks for the microphone now (true), or has its answer (false). */
  liveMicrophone: (on: boolean) => call<void>("live_microphone", { on }),

  // ── The closed island's music line (src-tauri/src/media.rs) ──────────────
  /** What the system's media controls say is playing; null when nothing is. */
  mediaNow: () => call<MediaActivity | null>("media_now"),
  /** Play/pause, next or previous on that player. */
  mediaControl: (action: "toggle" | "next" | "previous") => call<boolean>("media_control", { action }),
  /** The live activities' calendar file (calendar.rs), or null when no address is set. */
  calendarFetch: () => callOrThrow<string | null>("calendar_fetch"),
  /** The Google calendar the iCal address reads, when it is one of Google Calendar's (never the address). */
  calendarGoogleId: () => call<string | null>("calendar_google_id"),
  /** Google Calendar with the user's account (google_calendar.rs): what is stored, and whether a sign-in waits. */
  googleCalendarStatus: () => call<GoogleCalendarStatus>("google_calendar_status"),
  /** Opens Google's sign-in in the browser; resolves once Google gave its permission. */
  googleCalendarSignIn: () => callOrThrow<void>("google_calendar_sign_in"),
  /** Ends a sign-in still waiting for the browser. */
  googleCalendarCancel: () => call<void>("google_calendar_cancel"),
  /** Forgets the account: Google is told, the client and the permission leave the credential store. */
  googleCalendarSignOut: () => callOrThrow<void>("google_calendar_sign_out"),
  /** A GET to the Calendar API (the calendar list or a calendar's events); null when not signed in; throws "paused" while Lumo is paused. */
  googleCalendarGet: (path: string, query: [string, string][] = []) =>
    callOrThrow<{ status: number; body: unknown } | null>("google_calendar_get", { path, query }),

  // ── Updates (src-tauri/src/updater.rs), only ever on a click in Settings ──
  /** Asks GitHub for the newest Windows release (and, with `beta`, the beta build) and compares it with this build. */
  updateCheck: (beta = false) => callOrThrow<UpdateInfo>("update_check", { beta }),
  /** Downloads that release's installer, starts it and quits Lumo. */
  updateInstall: (url: string) => callOrThrow<void>("update_install", { url }),
};

/** What opens one Gemini Live connection (live.rs Token). */
export interface LiveToken {
  token: string;
  url: string;
}

/** live.rs Reading. */
export type LiveReading =
  | { kind: "text"; name: string; text: string; cut: boolean }
  | { kind: "image"; name: string; mime: string; data: string }
  | { kind: "folder"; path: string; entries: FolderEntry[]; omitted: number }
  | { kind: "document"; name: string; size: number };

/** live.rs Found. */
export interface LiveFound {
  path: string;
  dir: boolean;
  size: number;
  modified: string;
}

/** What live_type typed, and where (live.rs Typed). */
export interface PcStatus {
  cpuPercent: number;
  memoryUsedGb: number;
  memoryTotalGb: number;
  disks: { drive: string; freeGb: number; totalGb: number }[];
  battery?: { percent: number; charging: boolean; minutesLeft?: number };
  uptimeHours: number;
  busiest: { name: string; cpuPercent: number; memoryMb: number }[];
  biggest: { name: string; cpuPercent: number; memoryMb: number }[];
}

export interface PcFilePlan {
  id: number;
  moves: { from: string; to: string }[];
  newFolders: string[];
  skipped: string[];
}

export interface PcFilesDone {
  moved: number;
  newFolders: number;
  failed: string[];
}

/** A reminder at a time (reminders.rs); `at` is Unix ms. */
export interface Reminder {
  id: number;
  at: number;
  text: string;
}

/** The `reminder-due` event. */
export interface ReminderDue {
  reminder: Reminder;
  /** It came due while Lumo wasn't running. */
  missed: boolean;
}

export interface LiveTyped {
  chars: number;
  app: string;
  title: string;
  /** Line breaks went as spaces: the window in front is a terminal. */
  flattened: boolean;
}

/** The `live-helper-activity` event: what the helper is doing (claude_code.rs Activity). */
export interface LiveHelperActivity {
  helper: string;
  kind: string;
  detail: string;
}

export type ShortcutStatus =
  | "active" | "off" | "inUse" | "duplicate" | "invalid"
  | "typesCharacter" | "unsupported";

export interface ShortcutsReport {
  actions: { id: string; status: ShortcutStatus; typed?: string }[];
}

export interface IntegrationUpdate {
  id: string;
  data: Record<string, unknown>;
  error: string | null;
  event: { success: boolean; label: string; detail: string | null } | null;
}

export type ChatContext =
  | { kind: "file"; name: string; path: string }
  | { kind: "window"; appName: string; title: string; url?: string };

/** A file an answer read, edited or created (`chat-file`, claude_code.rs FileTouch). */
export interface ChatFileEvent {
  chat: string;
  kind: "read" | "edited" | "created";
  path: string;
}

/**
 * The `chat-activity` event: what an answer is doing while no text shows
 * (claude_code.rs Activity). `kind`: thinking, read, search, command, edit,
 * web, subtask, plan, screen or tool; `detail`: a file name, a host, a search
 * pattern or a tool's name, maybe empty.
 */
export interface ChatActivity {
  kind: string;
  detail: string;
}

/**
 * Unsloth Studio as Lumo starts and stops it (unsloth_studio.rs Status), also
 * the payload of the `unsloth-studio` event.
 */
export interface UnslothStudio {
  /** Its own Python was found on this computer. */
  installed: boolean;
  state: "off" | "starting" | "on";
  /** Lumo started it, so Lumo stops it. */
  owned: boolean;
  /** How long the start has taken so far. */
  seconds: number;
}

/** The event that follows Unsloth Studio's state while Lumo starts or stops it. */
export const UNSLOTH_STUDIO_EVENT = "unsloth-studio";

/** One answered chat turn (chat.rs ChatReply). */
export interface ChatReply {
  text: string;
  /** The Claude Code session that answered. */
  session?: string;
  /** The user pressed Stop: `text` is what was written until then, maybe nothing. */
  stopped?: boolean;
  /** How many turns Rust's conversation holds after this one (`chatRewind`). */
  turns?: number;
  /** What Rust's conversation kept for it, when not `text` ("(No answer.)"): given back as that by `chatRestore`. */
  kept?: string;
}

/** A display the screen button can capture; `index` is its place in the menu. */
export interface ScreenDisplay {
  index: number;
  width: number;
  height: number;
  primary: boolean;
}

/** One open window: its title and the app it belongs to. */
export interface OpenWindow {
  /** Its handle, for picking it (share.rs); 0 when not known. */
  id?: number;
  title: string;
  app: string;
  /** The window the user was in. */
  active: boolean;
  minimized: boolean;
}

/** A window the user shared, with what it shows (share.rs SharedWindow). */
export interface SharedWindow {
  title: string;
  app: string;
  /** Its text, read from the screen; "" when it gives none. */
  text: string;
  /** The text was cut to fit. */
  cut: boolean;
  /** The document it shows, found on disk; "" if none. */
  document: string;
}

/** A tab open in Edge or Chrome (share.rs BrowserTab). */
export interface BrowserTab {
  id: string;
  browser: string;
  title: string;
  /** "" while not known: on Windows, a tab in the background gives its address once read. */
  url: string;
  /** The tab on screen in its window. */
  active: boolean;
  /** Its page's text, once shared; "" in the list. */
  text: string;
  cut: boolean;
  /** "page" (read in the browser), "web" (downloaded), "" (none). */
  source: string;
}

/** A screenshot in the inbox; `preview` is a data URL of it. */
export interface ScreenShot {
  display: number;
  name: string;
  path: string;
  width: number;
  height: number;
  preview: string;
}

/** Text selected in another app, read by the "Ask about the selected text" shortcut. */
export interface SelectedText {
  text: string;
  /** The app it was selected in, when known ("chrome"). */
  app: string;
  /** That app's window title, when known. */
  title: string;
}

/** One file or subfolder of the folder open in File Explorer. */
export interface FolderEntry {
  name: string;
  dir: boolean;
  size: number;
  /** Local time, "2026-10-08 09:05"; "" when unknown. */
  modified: string;
}

/** The folder open in File Explorer; `entries` stays empty until it is shared. */
export interface ExplorerFolder {
  path: string;
  name: string;
  entries: FolderEntry[];
  /** Entries left out of the listing. */
  omitted: number;
}

/** What the screen button or the shortcuts add to the next question. */
export interface ScreenContext {
  windows: OpenWindow[];
  shots: { name: string; path: string }[];
  selection?: SelectedText;
  /** More selected text, shared after `selection`. */
  selections?: SelectedText[];
  /** More files added after the first (the chat's file context), in the inbox. */
  files?: { name: string; path: string }[];
  folder?: ExplorerFolder;
  /** More folders, shared with `folder`. */
  folders?: ExplorerFolder[];
  /** Windows picked in the menu, with what they show. */
  sharedWindows?: SharedWindow[];
  /** Browser tabs picked in the menu, with their pages' text. */
  tabs?: BrowserTab[];
}

/**
 * The `ask-context` event: what "Ask about my screen", "Ask about the
 * selected text" or "Ask about the page in the browser" took on the key press, or why it couldn't (shortcuts.rs).
 */
/** A new email from the Email pill's poller (mail.rs Message). */
export interface MailMessage extends MailPeek {
  body: string;
  date: string;
}

export type SharedContext =
  | { kind: "screen"; shots: ScreenShot[] }
  | { kind: "selection"; selection: SelectedText }
  /** "Ask about the page in the browser": the tab on screen, with its page's text. */
  | { kind: "page"; tab: BrowserTab }
  /** The same, when the tab shows a file (a PDF): that file, already in the inbox. */
  | { kind: "file"; file: DroppedFile }
  | { kind: "problem"; message: string };

export interface ModelInfo {
  id: string;
  label: string;
  /** A provider called by its API: the reasoning levels the model takes, where its list says. */
  reasoning?: string[];
  /** The same: its context, in tokens. */
  context?: number;
}

/** A model a local server holds in memory (local_models.rs). */
export interface LocalLoaded {
  name: string;
  /** Bytes, 0 when the server does not say. */
  size: number;
  /** Bytes in the graphics card's memory (Ollama), else 0. */
  vram: number;
}

/** How far loading a model from the chat picker is (`local-load`): LM Studio's percent. */
export interface LocalLoad {
  provider: string;
  model: string;
  percent: number;
}

/** How far a download to a local server is (`local-pull`): bytes so far and in all, 0 while unknown. */
export interface LocalPull {
  provider: string;
  model: string;
  completed: number;
  total: number;
}

export interface LocalServer {
  /** The address as it is stored. */
  url: string;
  models: string[];
  /** The address is this machine. */
  loopback: boolean;
}

export interface DroppedFile {
  name: string;
  path: string;
  size: number;
}

export interface HookStatus {
  installed: boolean;
  /** Installed as this version writes them; false when an older Lumo did (Settings offers to reinstall). */
  current: boolean;
  /** Lumo's status line relay (plan usage) is the status line in settings.json. */
  planRelayInstalled: boolean;
  settingsPath: string;
  hookPath: string;
  hookReady: boolean;
}

/** One agent other than Claude Code, as agents.rs reports it. */
export interface AgentHookStatus {
  /** The `--agent` name; its pill is `agent_<id>`. */
  id: string;
  name: string;
  installed: boolean;
  /** The file (or files, one per line) Lumo writes. */
  path: string;
  hookReady: boolean;
  /** The island can allow or deny this agent's permission requests. */
  approvals: boolean;
  /** What to do once it is written. */
  note: string;
  /** No longer offered (Gemini CLI): listed only to remove the hooks left behind. */
  retired?: boolean;
}

export interface AgentHookPlan {
  diff: string;
  /** Where each existing file is copied first, one per line; "" when none. */
  backup: string;
  path: string;
  fingerprint: string;
}

export interface HookPreview {
  diff: string;
  backup: string;
  settingsPath: string;
  /** Hand back to hooksApply so only the reviewed diff is ever written. */
  fingerprint: string;
}

/** Same as `call`, but surfaces the error so the UI can show what went wrong. */
async function callOrThrow<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!IS_TAURI) throw new Error("not running inside Lumo");
  return tauriInvoke<T>(cmd, args);
}

export interface GoogleCalendarStatus {
  /** The OAuth client's ID and secret are stored. */
  client: boolean;
  /** Google gave its lasting permission. */
  signedIn: boolean;
  /** Google refused that permission since: sign in again. */
  needsSignIn: boolean;
  /** A sign-in waits for the browser. */
  signingIn: boolean;
}

export interface DragDropPayload {
  /** `dropping`: the files were let go on the island; their paths follow as a `drop`. */
  type: "enter" | "over" | "dropping" | "drop" | "leave";
  paths?: string[];
  /** Where the cursor is, page pixels (WebView2 only: its drag events say so). */
  client?: { x: number; y: number };
}

/** A drop handed to Rust that never came back as paths (nothing it could read) ends the drag after this. */
const DROP_ANSWER_MS = 1500;

interface WebView2Bridge {
  postMessageWithAdditionalObjects(message: unknown, objects: ArrayLike<unknown>): void;
}

/**
 * Files dragged onto the island. Only reaches us when the window takes the mouse.
 *
 * On Windows WebView2 takes the drop itself, as in Edge — Tauri's drop handling
 * never sees drags from the classic Explorer folder view (see
 * src-tauri/src/webview_drop.rs). Enter/over/leave come straight from the page;
 * the drop hands the File objects to Rust, which answers with their real paths
 * as a `file-drag` event.
 *
 * During a drag the whole window takes the mouse (island.rs), not just the
 * island: `near` says whether a page point is close enough to the island for
 * the drag to open it (`enter`/`over`, and a `leave` once it is carried away),
 * and `accepts` whether it is on the island itself, the only place the file
 * is taken. Elsewhere the cursor shows "no drop".
 */
export async function onDragDrop(
  handler: (e: DragDropPayload) => void,
  accepts: (x: number, y: number) => boolean = () => true,
  near: (x: number, y: number) => boolean = accepts,
) {
  if (!IS_TAURI) return () => {};
  const webview = (window as unknown as { chrome?: { webview?: WebView2Bridge } }).chrome?.webview;
  if (!webview) {
    return getCurrentWebview().onDragDropEvent((event) => {
      handler(event.payload as DragDropPayload);
    });
  }
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
  const carriesLink = (e: DragEvent) => e.dataTransfer?.types.includes("text/uri-list") ?? false;
  const editable = (target: EventTarget | null) =>
    target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea") != null);
  // dragenter/dragleave fire for every element crossed; only the outermost pair counts.
  let depth = 0;
  // The cursor is near the island (`near`), not just in the window.
  let over = false;
  // The cursor is on the island itself (`accepts`), where the file is taken.
  let onIsland = false;
  // A picture dragged from the island itself (a screenshot's preview) says it
  // carries a file too: it is not one coming in, so it never opens the drop.
  let inside = false;
  let answer: number | null = null;
  const at = (e: DragEvent) => ({ x: e.clientX, y: e.clientY });

  const onStart = () => {
    inside = true;
  };
  const onEnd = () => {
    inside = false;
    depth = 0;
    over = false;
    onIsland = false;
  };
  const onEnter = (e: DragEvent) => {
    if (inside || !hasFiles(e)) return;
    e.preventDefault();
    depth++;
    track(e);
  };
  /** Enter and leave follow the zone around the island, not the window's edge. */
  const track = (e: DragEvent) => {
    onIsland = accepts(e.clientX, e.clientY);
    const on = onIsland || near(e.clientX, e.clientY);
    if (on && !over) {
      over = true;
      handler({ type: "enter", client: at(e) });
    } else if (!on && over) {
      over = false;
      handler({ type: "leave" });
    }
    return on;
  };
  const onOver = (e: DragEvent) => {
    // A link (from a browser, or one of the island's own) let go on the
    // island: WebView2 would open it in place of the island. Refused, but
    // over a text field, which takes it as text.
    if (!hasFiles(e) && carriesLink(e) && !editable(e.target)) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
      return;
    }
    if (inside || !hasFiles(e)) return;
    // Without this WebView2 refuses the drop — or navigates to the file.
    // Off the island it is refused: "none" shows the no-drop cursor.
    e.preventDefault();
    const on = track(e);
    if (e.dataTransfer) e.dataTransfer.dropEffect = onIsland ? "copy" : "none";
    if (on) handler({ type: "over", client: at(e) });
  };
  const onLeave = (e: DragEvent) => {
    if (inside || !hasFiles(e) || depth === 0) return;
    if (--depth === 0 && over) {
      over = false;
      onIsland = false;
      handler({ type: "leave" });
    }
  };
  const onDrop = (e: DragEvent) => {
    // Never a navigation to what was dropped, ours or not.
    e.preventDefault();
    if (inside) return;
    depth = 0;
    // Let go beside the island: not ours (the drop zone closes on the release).
    const on = onIsland || accepts(e.clientX, e.clientY);
    over = false;
    onIsland = false;
    if (!on) {
      handler({ type: "leave" });
      return;
    }
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) {
      handler({ type: "drop", paths: [] });
      return;
    }
    handler({ type: "dropping" });
    webview.postMessageWithAdditionalObjects("lumo-file-drop", files);
    // Files with no path on disk (a picture dragged out of a browser) give
    // Rust nothing to send back: the drag still has to end.
    if (answer != null) window.clearTimeout(answer);
    answer = window.setTimeout(() => {
      answer = null;
      handler({ type: "drop", paths: [] });
    }, DROP_ANSWER_MS);
  };

  window.addEventListener("dragstart", onStart);
  window.addEventListener("dragend", onEnd);
  window.addEventListener("dragenter", onEnter);
  window.addEventListener("dragover", onOver);
  window.addEventListener("dragleave", onLeave);
  window.addEventListener("drop", onDrop);
  const unlisten = await tauriListen<DragDropPayload>("file-drag", (e) => {
    if (answer != null) window.clearTimeout(answer);
    answer = null;
    handler(e.payload);
  });
  return () => {
    window.removeEventListener("dragstart", onStart);
    window.removeEventListener("dragend", onEnd);
    window.removeEventListener("dragenter", onEnter);
    window.removeEventListener("dragover", onOver);
    window.removeEventListener("dragleave", onLeave);
    window.removeEventListener("drop", onDrop);
    unlisten();
  };
}

export async function onEvent<T>(name: string, handler: (payload: T) => void) {
  if (!IS_TAURI) return () => {};
  return tauriListen<T>(name, (e) => handler(e.payload));
}
