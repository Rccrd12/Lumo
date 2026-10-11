// Thin wrapper over the Tauri commands/events. Every call is a no-op when the
// page is opened in a plain browser, so the island can be iterated on with
// `npm run dev` alone.

import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Settings } from "./state";
import type { MailPeek, MediaActivity } from "./compact";
import type { ChatUsage } from "./chat-usage";
import type { RecapHistory, RecapPrefs } from "../recap/summary";

/**
 * Settings open inside the island (an iframe of settings.html, see
 * views/settings-frame.ts) talk to Rust through the island page: a frame has
 * no Tauri connection of its own on Linux, and on Windows Rust's events never
 * reach one.
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

/** The island page lends its connection to Rust to the Settings inside it. */
export function lendTauri() {
  (window as unknown as { __LUMO_HOST__?: TauriHost }).__LUMO_HOST__ = { invoke, listen };
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

/** Settings → Updates: what a check found (updater.rs). */
export interface UpdateInfo {
  current: string;
  latest: string;
  newer: boolean;
  notes: string;
  /** Lumo-Windows-<latest>-setup.exe of that release, when it has one. */
  assetUrl: string | null;
}

/** Page pixels the island is drawn off its usual place: a floating island kept on its display. */
export interface IslandShift {
  x: number;
  y: number;
}

export interface BootInfo {
  settings: Settings;
  /** Logical screen rect of the monitor the island lives on. */
  screen: { x: number; y: number; width: number; height: number; scale: number };
  version: string;
  hookPath: string;
  /** False where the OS has no global cursor (Wayland): see Island.followPageCursor. */
  cursorPoll: boolean;
  /** Where the island is drawn in its window, off its usual place (island.rs shift). */
  shift: IslandShift;
}

/** System dialogs of ours open right now (the file picker): a click in them is not "elsewhere". */
let dialogs = 0;
export const isDialogOpen = () => dialogs > 0;

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
  /** Pill ID → whether that agent's hooks reach Lumo (read-only, Mac #183). */
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
  /** The Claude plan's usage from Anthropic, as the status line's `rate_limits` (plan_usage.rs). Throws why it could not. */
  planUsageFetch: () => callOrThrow<unknown>("plan_usage_fetch"),

  approvalDecision: (requestId: string, decision: "allow" | "deny") =>
    call<void>("approval_decision", { requestId, decision }),
  /** "The card is up" — until this lands the relay only waits a moment. */
  approvalAck: (requestId: string) => call<void>("approval_ack", { requestId }),
  /** Answers a question Claude Code asked: question text → chosen label. */
  approvalAnswer: (requestId: string, answers: Record<string, string | string[]>) =>
    call<void>("approval_answer", { requestId, answers }),

  /** "Nobody can act on this" — Claude Code asks in the terminal right away. */
  approvalDecline: (requestId: string) => call<void>("approval_decline", { requestId }),

  // ── Chat, files, secrets ──────────────────────────────────────────────────
  /**
   * One chat turn. The API key and any file bytes never leave Rust. `screen`
   * is what the user added from the screen button, sent with this turn only.
   */
  chatSend: (query: string, context: ChatContext | null, screen?: ScreenContext | null) =>
    callOrThrow<ChatReply>("chat_send", screen ? { query, context, screen } : { query, context }),
  chatReset: () => call<void>("chat_reset"),
  /** The Stop button: `chatSend` then returns what was written so far, `stopped`. */
  chatStop: () => call<void>("chat_stop"),
  /** An edited message: the conversation goes back to its first `keep` turns (`ChatReply.turns`). */
  chatRewind: (keep: number) => call<void>("chat_rewind", { keep }),
  /** Alt + drag: Rust moves the island with the mouse until the button is let go. */
  /** `island`: the island as drawn (x, y, width, height, page pixels), without what sits beside it. */
  islandDrag: (island?: [number, number, number, number]) => call<void>("island_drag", { island: island ?? null }),
  /** Puts the island back at the top centre of its display. */
  islandRecenter: () => call<void>("island_recenter"),
  /** Drag on a grip of the island (see layout.gripFactors); Rust follows the mouse until it is let go. */
  islandResize: (fx: number, fy: number, height: number) => call<void>("island_resize", { fx, fy, height }),
  /** Double click on a grip: the usual width, height, or both. */
  islandResetSize: (width: boolean, height: boolean) => call<void>("island_reset_size", { width, height }),
  /** Reopens a chat from the history, and the Claude Code session that answered it. */
  chatRestore: (turns: { role: string; content: string }[], session: string | null) =>
    call<void>("chat_restore", { turns, session }),
  /** The system's file picker; the picked file is copied into the inbox like a drop. */
  pickFile: async () => {
    dialogs++;
    try {
      return await callOrThrow<DroppedFile | null>("pick_file");
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
  /** The folder open in File Explorer, its name only, for the menu. Lists nothing. */
  screenExplorerPeek: () => callOrThrow<ExplorerFolder | null>("screen_explorer_peek"),
  /** That folder and what is in it, shared with the chat (explorer.rs). */
  screenExplorer: () => callOrThrow<ExplorerFolder | null>("screen_explorer"),
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
  localSetKey: (url: string, key: string) => call<void>("local_set_key", { url, key }),

  localConnect: (provider: "ollama" | "lmstudio" | "custom", url: string) =>
    callOrThrow<LocalServer>("local_connect", { provider, url }),
  /** Copies a dropped file into the inbox. */
  ingestFile: (path: string) => callOrThrow<DroppedFile>("ingest_file", { path }),
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
  /** The page asks for the microphone now (true), or has its answer (false). */
  liveMicrophone: (on: boolean) => call<void>("live_microphone", { on }),

  // ── The closed island's music line (src-tauri/src/media.rs) ──────────────
  /** What the system's media controls say is playing; null when nothing is. */
  mediaNow: () => call<MediaActivity | null>("media_now"),
  /** Play/pause, next or previous on that player. */
  mediaControl: (action: "toggle" | "next" | "previous") => call<boolean>("media_control", { action }),
  // ── The live activities (src-tauri/src/activities.rs) ───────────────────
  /** A grip beside the island: the size follows the mouse (`activities-resize`). */
  activitiesResize: (fx: number, fy: number, height: number) => call<void>("activities_resize", { fx, fy, height }),
  /** Their own window, shown or hidden. */
  activitiesShow: (show: boolean) => call<void>("activities_show", { show }),
  /** Makes their own window ahead, hidden, so it is ready when they are taken off the island. */
  activitiesPrepare: () => call<void>("activities_prepare"),
  /** Picked up by their top bar: from beside the island (x, y, w, h in page pixels) or from their window. */
  activitiesDrag: (from: [number, number, number, number] | null) => call<void>("activities_drag", { from }),
  /** A grip of their own window. */
  activitiesWindowResize: (fx: number, fy: number) => call<void>("activities_window_resize", { fx, fy }),
  /** Their own window takes the keyboard, or gives it back. */
  activitiesFocus: (focused: boolean) => call<void>("activities_focus", { focused }),
  /** The live activities' calendar file (calendar.rs), or null when no address is set. */
  calendarFetch: () => callOrThrow<string | null>("calendar_fetch"),

  // ── Updates (src-tauri/src/updater.rs), only ever on a click in Settings ──
  /** Asks GitHub for the newest Windows release and compares it with this build. */
  updateCheck: () => callOrThrow<UpdateInfo>("update_check"),
  /** Downloads that release's installer, starts it and quits Lumo. */
  updateInstall: (url: string) => callOrThrow<void>("update_install", { url }),

  // ── Mochi on the desktop (src-tauri/src/desktop.rs) ───────────────────────
  desktopInfo: () => call<DesktopInfo>("desktop_mochi_info"),
  /** Dragged out of the island: (x, y) is the pointer in island-window coordinates. */
  desktopPickUp: (x: number, y: number) => call<boolean>("desktop_mochi_pick_up", { x, y }),
  /** Linux: the pointer moved during that drag (Windows carries him from Rust). */
  desktopCarry: (x: number, y: number) => call<void>("desktop_mochi_carry", { x, y }),
  desktopCarryEnd: (x: number, y: number) => call<void>("desktop_mochi_carry_end", { x, y }),
  /** A drag started on the desktop Mochi; resolves to his top-left corner. */
  desktopDragBegin: () => call<[number, number] | null>("desktop_mochi_drag_begin"),
  /** X11: top-left corner, physical pixels. */
  desktopDragMove: (x: number, y: number) => call<void>("desktop_mochi_drag_move", { x, y }),
  desktopDragEnd: (x: number, y: number) => call<void>("desktop_mochi_drag_end", { x, y }),
  /** From the island to his spot. False: no spot on any connected display. */
  desktopFlyOut: () => call<boolean>("desktop_mochi_fly_out"),
  /** To the island, then hidden. `forget`: he lives in the island again. */
  desktopFlyHome: (forget: boolean) => call<boolean>("desktop_mochi_fly_home", { forget }),
  /** Asleep, the cursor poll stops. */
  desktopSetAsleep: (asleep: boolean) => call<void>("desktop_mochi_set_asleep", { asleep }),
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
  | "typesCharacter" | "unsupported" | "notPorted";

export interface ShortcutsReport {
  actions: { id: string; status: ShortcutStatus; typed?: string }[];
  /** "wayland" or "no-display" when no global shortcut can be registered. */
  blocked: string | null;
  /** `<executable> --shortcut`: append an action id for a desktop shortcut. */
  command: string;
}

/** How the desktop Mochi's window works here (platform::DesktopMode). */
export type DesktopMode = "poll" | "window" | "layer" | "off";

export interface DesktopInfo {
  mode: DesktopMode;
  /** He was on the desktop when the app last quit. */
  onDesktop: boolean;
}

/** An event for one window only (island ⇄ desktop Mochi). Never throws. */
export async function emitToWindow(label: string, event: string, payload?: unknown) {
  if (!IS_TAURI) return;
  try {
    await emitTo(label, event, payload);
  } catch (err) {
    console.error(`[lumo] emit ${event} failed`, err);
  }
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

/** One answered chat turn (chat.rs ChatReply). */
export interface ChatReply {
  text: string;
  /** The Claude Code session that answered. */
  session?: string;
  /** The user pressed Stop: `text` is what was written until then, maybe nothing. */
  stopped?: boolean;
  /** How many turns Rust's conversation holds after this one (`chatRewind`). */
  turns?: number;
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
  folder?: ExplorerFolder;
  /** Windows picked in the menu, with what they show. */
  sharedWindows?: SharedWindow[];
  /** Browser tabs picked in the menu, with their pages' text. */
  tabs?: BrowserTab[];
}

/**
 * The `ask-context` event: what "Ask about my screen" or "Ask about the
 * selected text" took on the key press, or why it couldn't (shortcuts.rs).
 */
/** A new email from the Email pill's poller (mail.rs Message). */
export interface MailMessage extends MailPeek {
  body: string;
  date: string;
}

export type SharedContext =
  | { kind: "screen"; shots: ScreenShot[] }
  | { kind: "selection"; selection: SelectedText }
  | { kind: "problem"; message: string };

export interface ModelInfo {
  id: string;
  label: string;
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

export type BridgeEvent =
  | { name: "cursor"; payload: { x: number; y: number } }
  | { name: "tray"; payload: string }
  | { name: "hook"; payload: Record<string, unknown> }
  | { name: "screen-changed"; payload: null };

export interface DragDropPayload {
  type: "enter" | "over" | "drop" | "leave";
  paths?: string[];
}

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
 * as a `file-drag` event. Elsewhere (Linux) Tauri's own drag events still do it.
 */
export async function onDragDrop(handler: (e: DragDropPayload) => void) {
  if (!IS_TAURI) return () => {};
  const webview = (window as unknown as { chrome?: { webview?: WebView2Bridge } }).chrome?.webview;
  if (!webview) {
    return getCurrentWebview().onDragDropEvent((event) => {
      handler(event.payload as DragDropPayload);
    });
  }
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
  // dragenter/dragleave fire for every element crossed; only the outermost pair counts.
  let depth = 0;

  const onEnter = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (depth++ === 0) handler({ type: "enter" });
  };
  const onOver = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    // Without this WebView2 refuses the drop — or navigates to the file.
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    handler({ type: "over" });
  };
  const onLeave = (e: DragEvent) => {
    if (!hasFiles(e) || depth === 0) return;
    if (--depth === 0) handler({ type: "leave" });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth = 0;
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) {
      handler({ type: "drop", paths: [] });
      return;
    }
    webview.postMessageWithAdditionalObjects("lumo-file-drop", files);
  };

  window.addEventListener("dragenter", onEnter);
  window.addEventListener("dragover", onOver);
  window.addEventListener("dragleave", onLeave);
  window.addEventListener("drop", onDrop);
  const unlisten = await tauriListen<DragDropPayload>("file-drag", (e) => handler(e.payload));
  return () => {
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
