// Hook events from Claude Code and every other agent → island state.
// There is no terminal filter: the hook fires from any terminal (Windows
// Terminal, VS Code, PowerShell…) and all of them are handled.
// The relay has already mapped every agent's events and fields onto Claude
// Code's (hook/src/normalize.rs), so one handler serves them all.

import { computerPoint, computerToolName, describeComputerAction, scrollDirection } from "../core/computer";
import { currentStep } from "../core/computer-use";
import { userToolTarget } from "../core/tools";
import { clipUnits } from "../core/clip";
import { COMPACT_TEXT, compactNotice } from "../core/compact";
import { Bridge, onEvent } from "../core/bridge";
import { buildFileDiff, fileName, makeDiffStep, toOneLine } from "../core/diff";
import { failureDetail, fullTextDetail, toolStepDetail } from "../core/step-detail";
import { Sound } from "../core/sound";
import { PillSessions } from "../core/pill-sessions";
import { State, type ApprovalInfo, type AskedQuestion, type OutgoingEmail } from "../core/state";
import type { MailLimits } from "../core/mail-edit";
import { stepsFromMarkdown } from "../core/agent-plan";
import { pillDefinition } from "../core/pills";
import { APPROVAL_AGENTS, agentColor, agentName, validateAgent } from "./agents";
import type { Island } from "./island";
import { restorePlanUsage } from "../core/plan";
import { editStat, isSimpleRequest, requestKind, requestReason } from "../core/approvals";
import { parsePermissionMode, storedPermissionMode } from "../core/providers";
import { rememberFolder } from "../core/sessions";
import {
  BACKGROUND_COLOR, BACKGROUND_TEXT, BackgroundRuns, QUIET_MS, STALE_MS, answerLine, answerText, backgroundGroupId, batchTotal, backgroundLine,
  launcherName, parseBackgroundMode, subjectOf, type BackgroundEvent,
} from "../core/background";
import { keepPlanUsage, startPlanUsagePolling, storedClaudePlanUsage } from "../views/usage";
import { N_, t } from "../i18n/i18n";

const CLAUDE_ID = "integration_claude";
const CURSOR_ID = "agent_cursor";

/** What still reaches the pills while Lumo is paused: the end of a turn or of a session. */
const SETTLES_WHILE_PAUSED = new Set(["Stop", "StopFailure", "Interrupt", "SessionEnd"]);

/**
 * Per request, on screen or in line: takes it away if no decision was made
 * before the hook gave up.
 */
const cardTimers = new Map<string, number>();

/** How many requests can wait behind the card; past that the newest goes back to its terminal. */
export const MAX_WAITING = 4;

/** The sessions behind each pill: two of them can share one (core/pill-sessions.ts). */
export const liveSessions = new PillSessions();

function clearCardTimer(requestId: string): void {
  const timer = cardTimers.get(requestId);
  if (timer == null) return;
  window.clearTimeout(timer);
  cardTimers.delete(requestId);
}

/**
 * How long a card of the chat's Antigravity CLI run stays: a little less than
 * the relay waits for it (`lumo_card_secs`, 8 s when it does not say), after
 * which Antigravity goes on without the command.
 */
export function agyCardMs(secs: unknown): number {
  const wait = typeof secs === "number" && Number.isFinite(secs) ? Math.min(110, Math.max(1, secs)) : 8;
  return Math.max(500, wait * 1000 - 1000);
}

/** Takes the approval or question card down and gives the island back, or to the next request in line. */
function dropPendingCard(island: Island): void {
  if (!State.pendingApproval) return;
  State.endApproval();
  island.dropPin();
  if (State.view === "approval" || State.view === "question") {
    // A card folded away goes without opening the island: setView on a closed
    // island opens it, on the home and with its sound, for nothing to read.
    if (State.mode === "expanded") island.setView(State.agentsView());
    else State.view = State.agentsView();
  }
  presentApproval(island);
  // Computer use paused meanwhile: back to its plan, where Stop, Ask and Resume are.
  if (State.computerActive && State.computer?.paused) island.reopenPausedPlan();
  State.notify();
}

/**
 * The request that just took the card, from the line, comes up the way a new
 * one does: a simple one on the closed island if it can show it, else the
 * full card. Nothing is answered here.
 */
export function presentApproval(island: Pick<Island, "alert" | "quickApproval">): void {
  const req = State.pendingApproval;
  if (!req) return;
  const simple = req.simple === true && State.settings.quickApprovals !== false && State.mode !== "expanded";
  if (simple && island.quickApproval()) {
    req.quick = true;
    return;
  }
  if (req.quick) req.quick = false;
  island.alert(State.requestView(req));
}

/**
 * Requests in line that no longer stand (their turn is over): out of the line,
 * and the relay released without a decision, so the terminal has them.
 */
function withdrawQueued(drop: (q: ApprovalInfo) => boolean): void {
  const gone = State.approvalQueue.filter(drop);
  if (!gone.length) return;
  State.approvalQueue = State.approvalQueue.filter((q) => !drop(q));
  for (const q of gone) {
    clearCardTimer(q.requestId);
    void Bridge.approvalDecline(q.requestId);
  }
}

/**
 * Lumo is paused: every request waiting, on the card or in line, goes back
 * to its terminal at once. Kept, it would hold the agent until the relay's
 * time ran out, nearly two minutes, behind an island nobody can see.
 */
export function releaseAllApprovals(island: Island): void {
  withdrawQueued(() => true);
  const pending = State.pendingApproval;
  if (!pending) return;
  clearCardTimer(pending.requestId);
  if (pending.requestId) void Bridge.approvalDecline(pending.requestId);
  dropPendingCard(island);
}

/** A request in line whose time ran out: the terminal took it over. */
function expireQueued(requestId: string): void {
  const req = State.approvalQueue.find((q) => q.requestId === requestId);
  if (!req) return;
  State.approvalQueue = State.approvalQueue.filter((q) => q !== req);
  const stillAsking = State.pendingApproval?.pillId === req.pillId || State.approvalQueue.some((q) => q.pillId === req.pillId);
  if (!req.fromChat && !stillAsking) State.updateTask(req.pillId, "working");
  State.notify();
}

/**
 * Lumo answers within 108 s or not at all; after that the terminal has taken
 * over and the card would be lying. The time counts from when the request
 * came, whether its card is up or it waits in line.
 */
function armCardTimer(island: Island, requestId: string, ms: number): void {
  clearCardTimer(requestId);
  cardTimers.set(requestId, window.setTimeout(() => {
    cardTimers.delete(requestId);
    if (State.pendingApproval?.requestId === requestId) dropPendingCard(island);
    else expireQueued(requestId);
  }, ms));
}

/** The return to idle that Stop arms, per pill, so the next turn can cancel it. */
const stopTimers = new Map<string, number>();

function cancelStopTimer(id: string): boolean {
  const timer = stopTimers.get(id);
  if (timer == null) return false;
  window.clearTimeout(timer);
  stopTimers.delete(id);
  return true;
}

/**
 * 5.2 s after a Stop, the pill comes to rest: back to idle, or, for an
 * agent's pill (`removes`), off the island.
 */
function armStopTimer(id: string, removes: boolean): void {
  cancelStopTimer(id);
  stopTimers.set(id, window.setTimeout(() => {
    stopTimers.delete(id);
    if (removes) {
      State.removeTask(id);
    } else {
      State.updateTask(id, "idle");
      State.setPillBadge(id, null);
    }
  }, 5200));
}

/**
 * Antigravity can end a run without its Stop: run headless, a call it refused
 * on its own closes the run with no word after the PreToolUse, and the pill
 * would say "working" for good. Heard from by none of its sessions for this
 * long, mid-turn, the pill goes. Re-armed on every event, per pill.
 */
export const AGY_SILENT_MS = 10 * 60_000;
const silenceTimers = new Map<string, number>();

function cancelSilenceTimer(id: string): void {
  const timer = silenceTimers.get(id);
  if (timer == null) return;
  window.clearTimeout(timer);
  silenceTimers.delete(id);
}

/** Events after which the pill is no longer mid-turn: nothing to watch. */
const TURN_DONE = new Set(["Stop", "StopFailure", "Interrupt", "SessionEnd"]);

function watchSilence(island: Island, id: string, event: string): void {
  cancelSilenceTimer(id);
  if (TURN_DONE.has(event)) return;
  silenceTimers.set(id, window.setTimeout(() => {
    silenceTimers.delete(id);
    const t = State.tasks.find((x) => x.id === id);
    if (!t) return;
    // A card still up for it has its own timer: wait for that one to go.
    if (State.pendingApproval?.pillId === id || State.approvalQueue.some((q) => q.pillId === id)) {
      watchSilence(island, id, "");
      return;
    }
    if (t.state !== "working" && t.state !== "thinking") return;
    liveSessions.end(id, "");
    island.plan?.endSession(id, t.sessionId ?? "");
    cancelStopTimer(id);
    State.clearSessionDiffs(id);
    State.removeTask(id);
    State.notify();
  }, AGY_SILENT_MS));
}

/** Events after which a pending permission request of the same session is moot. */
const TURN_OVER = new Set(["Stop", "StopFailure", "UserPromptSubmit", "SessionEnd", "Interrupt"]);

/** Notifications that mean the agent waits for you (Claude Code's `notification_type`). */
const NEEDS_YOU = new Set(["agent_needs_input", "elicitation_dialog", "elicitation_url_dialog"]);

/**
 * True when `name` (from `agentId`'s session `sessionId`) shows the request
 * `q` was settled somewhere else: the turn is over (interrupted, a new prompt,
 * the session ended), or the very tool call it asked about has run or failed,
 * so it was answered in the terminal or the Claude app. Another call's result
 * (a subagent working alongside) does not count. The relay hanging up is the
 * fastest sign of all; it comes as `hook-settled`.
 */
export function settledElsewhere(
  q: Pick<ApprovalInfo, "pillId" | "sessionId" | "tool" | "command">,
  name: string,
  agentId: string,
  sessionId: string,
  tool: string | undefined,
  input: Record<string, unknown> | undefined,
): boolean {
  if (q.pillId !== agentId || q.sessionId !== sessionId) return false;
  if (TURN_OVER.has(name)) return true;
  if (name !== "PostToolUse" && name !== "PostToolUseFailure") return false;
  const t = tool ?? "Tool";
  if (t !== q.tool) return false;
  const target = approvalTarget(t, input ?? {});
  // A call with nothing that names it shows all it was given, which its
  // PostToolUse may carry cut: the same tool in the same session is it.
  return q.command === target || (target === t && q.command.startsWith(`${t} · {`));
}

/**
 * The relay of request `requestId` hung up without a decision: Claude Code
 * ended it because the prompt was answered in the terminal (or the Claude
 * app). Its card goes at once, or it leaves the line. Nobody is left to
 * release, so nothing is declined.
 */
export function settleRequest(island: Island, requestId: string): void {
  clearCardTimer(requestId);
  const card = State.pendingApproval;
  if (card?.requestId === requestId) {
    const stillAsking = State.approvalQueue.some((q) => q.pillId === card.pillId);
    if (!card.fromChat && !stillAsking) State.updateTask(card.pillId, "working");
    dropPendingCard(island);
    return;
  }
  expireQueued(requestId);
}

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** Notification: what it is about (Claude Code: idle_prompt, agent_needs_input, elicitation_dialog…). */
  notification_type?: string;
  /** PermissionDenied: why auto mode refused the call. */
  reason?: string;
  /** PreCompact / PostCompact: `auto` when the context filled up, `manual` for /compact. */
  trigger?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  /** Stop: the turn's final answer (Markdown) — Claude Code's, Hermes's, Codex's. */
  last_assistant_message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** PostToolUseFailure: what went wrong. StopFailure: the kind of API error (`rate_limit`, `overloaded`…). */
  error?: string;
  /** StopFailure: more about the error, as Claude Code words it. */
  error_details?: string;
  /** Set by the relay when an edit was too big to forward whole (> 256 KB). */
  lumo_diff_truncated?: boolean;
  /** Optional agent tag: lowercase, digits and hyphens, ≤ 24 chars. */
  lumo_agent?: string;
  /** Hermes: where the session runs (telegram, discord…; "cli" in a terminal). */
  platform?: string;
  /** "cursor" when Claude Code runs in Cursor's terminal (set by the relay). */
  term_editor?: string;
  /** The island's own chat started this Claude Code run (only its permission requests arrive). */
  lumo_island?: boolean;
  /** PermissionRequest from inside an agent Claude Code started: that agent's id (the chat's Agents card matches it). */
  agent_id?: string;
  /** A card of the chat's Antigravity CLI run: how long the relay waits for a click, in seconds. */
  lumo_card_secs?: number;
  /** StatusLine (the plan usage relay): Claude Code's 5-hour and weekly limits. */
  rate_limits?: unknown;
  /** PostToolUse of TaskCreate: the id of the task made (the relay keeps it of the result). */
  lumo_task_id?: string;
  /** The card may offer "Allow for this session" (session_rules.rs): the request has a session to keep it for. */
  lumo_session_allow?: boolean;
  /** A card of the chat's Copilot CLI or Cursor CLI in Auto: Allow is answered with the CLI's "always allow" (acp_chat.rs card). */
  lumo_remembered?: boolean;
  /** The first computer action of the chat's Antigravity CLI in Auto: Allow lets it act without cards for the rest of the chat (computer.rs serve), so it is always a click. */
  lumo_computer_consent?: boolean;
  /** The relay had to cut what the card shows of the request (lumo-hook's truncate_payload): it says it shows the beginning. */
  lumo_input_cut?: boolean;
  /** With lumo_input_cut: the size of the whole input, before the cut. */
  lumo_input_bytes?: number;
  /** The relay cut only the text a file tool writes, which the card never shows: its numbers below are the whole text's. */
  lumo_text_cut?: boolean;
  /** What a file tool changes, counted by the relay before any cut (hook/src/write_stat.rs): lines added and removed, a whole-file write's size. */
  lumo_write_added?: number;
  lumo_write_removed?: number;
  lumo_write_bytes?: number;
  /** The Claude Code session's title (/rename, else Claude Code's own), read from its transcript by the relay (hook/src/title.rs). */
  lumo_title?: string;
  /** A command of an Antigravity session that none of its rules covers (hook/src/main.rs): a card, else Antigravity asks. */
  lumo_agy_gate?: boolean;
  /** A call of one of the user's tools, asked for by Lumo itself (tools.rs approve). */
  lumo_user_tool?: { name?: string; summary?: string };
  /** An email the AI wants to send, on a card of its own (mail.rs send). */
  lumo_mail_send?: { from?: unknown; to?: unknown; cc?: unknown; subject?: unknown; body?: unknown; attachments?: unknown; accounts?: unknown; limits?: unknown };
  /** A change the AI wants to make to one email (read, star, move, archive, trash), on a card of its own (mail.rs manage). */
  lumo_mail_action?: { actions?: unknown; folder?: unknown; from?: unknown; subject?: unknown; date?: unknown };
  /** Gemini Live wants to read or open a file the user didn't give it (live.rs may_use). */
  lumo_live_file?: { action?: unknown };
  /** Another program started this session on its own (hook/src/background.rs). */
  lumo_background?: boolean;
  /** That program's name, when the relay could tell. */
  lumo_launcher?: string;
  /** How many questions the program asks in all (LUMO_BATCH_TOTAL), when it says. */
  lumo_batch_total?: number;
}

/** HookPayload's fields that are text, yes-or-no, a number or an object. */
const TEXT_FIELDS = [
  "hook_event_name", "request_id", "session_id", "cwd", "message", "notification_type", "reason", "trigger",
  "prompt", "last_assistant_message", "tool_name", "error", "lumo_agent", "platform", "term_editor",
  "lumo_task_id", "lumo_title", "lumo_launcher",
] as const;
const FLAG_FIELDS = [
  "lumo_diff_truncated", "lumo_island", "lumo_session_allow", "lumo_remembered", "lumo_agy_gate", "lumo_background",
  "lumo_computer_consent",
] as const;
const NUMBER_FIELDS = ["lumo_card_secs", "lumo_batch_total"] as const;
const OBJECT_FIELDS = ["tool_input", "lumo_user_tool", "lumo_mail_send", "lumo_mail_action", "lumo_live_file"] as const;

/**
 * A hook event as the island reads it: an object, and each field it knows of
 * the type it expects, or gone. The relay forwards what an agent wrote, and a
 * number where text belongs (`"message": 3`) threw in the middle of an
 * event, leaving a card or a pill half made.
 */
export function cleanPayload(raw: unknown): HookPayload | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = { ...(raw as Record<string, unknown>) };
  // Input that is not an object of fields (text, a list): what the agent runs
  // is in it, so it stays on the card as it came, and it is cut, never allowed
  // from here. Dropped, the card would show only the tool's name.
  const input = p.tool_input;
  if (input != null && (typeof input !== "object" || Array.isArray(input))) {
    p.tool_input = { arguments: typeof input === "string" ? input : JSON.stringify(input) };
    p.lumo_input_cut = true;
  }
  const drop = (fields: readonly string[], ok: (v: unknown) => boolean) => {
    for (const f of fields) if (f in p && p[f] != null && !ok(p[f])) delete p[f];
  };
  drop(TEXT_FIELDS, (v) => typeof v === "string");
  drop(FLAG_FIELDS, (v) => typeof v === "boolean");
  drop(NUMBER_FIELDS, (v) => typeof v === "number" && Number.isFinite(v));
  drop(OBJECT_FIELDS, (v) => typeof v === "object" && !Array.isArray(v));
  return p as HookPayload;
}

const LIVE_FILE = {
  read: N_("Read a file you didn't give it"),
  open: N_("Open a file you didn't give it"),
  page: N_("Open this page in the browser"),
};

/**
 * Gemini Live's card for a file or a web page: the file's full path or the
 * page's whole address, and what it wants to do; null when it is no such card.
 */
export function liveFileChange(raw: HookPayload["lumo_live_file"], input: Record<string, unknown>): { command: string; reason: string } | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.action === "page") {
    const url = typeof input.url === "string" ? input.url : "";
    return url ? { command: url, reason: t(LIVE_FILE.page) } : null;
  }
  const path = typeof input.path === "string" ? input.path : "";
  if (!path) return null;
  return { command: path, reason: t(raw.action === "open" ? LIVE_FILE.open : LIVE_FILE.read) };
}

/** What each change of mail.rs manage does, as its card says it. */
const MAIL_ACTIONS: Record<string, string> = {
  read: N_("Mark as read"),
  unread: N_("Mark as unread"),
  star: N_("Add a star"),
  unstar: N_("Remove the star"),
  move: N_("Move to {folder}"),
  archive: N_("Archive the email"),
  trash: N_("Move to the trash"),
};

/** A change to one email, as its card shows it: what it does, and to which email; null when there is none to show. */
export function mailChange(raw: HookPayload["lumo_mail_action"]): { command: string; reason: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const words = Array.isArray(raw.actions) ? raw.actions.filter((a): a is string => typeof a === "string" && a in MAIL_ACTIONS) : [];
  if (!words.length) return null;
  const folder = text(raw.folder);
  const command = words.map((w) => t(MAIL_ACTIONS[w], { folder })).join(" · ");
  const subject = text(raw.subject) || t("(no subject)");
  const from = text(raw.from);
  return { command, reason: from ? `${from}: ${subject}` : subject };
}

/** The email of a `mail_send` card, as the island shows it; null when there is none to show. */
export function outgoingEmail(raw: HookPayload["lumo_mail_send"]): OutgoingEmail | null {
  if (!raw || typeof raw !== "object") return null;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const to = list(raw.to);
  if (!to.length) return null;
  const files = Array.isArray(raw.attachments) ? raw.attachments : [];
  const attachments = files
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => ({ name: text(f.name), size: typeof f.size === "number" ? f.size : 0, path: text(f.path) }))
    .filter((f) => f.name);
  const accounts = list(raw.accounts);
  const limits = mailLimits(raw.limits);
  return {
    from: text(raw.from), to, cc: list(raw.cc), subject: text(raw.subject), body: text(raw.body), attachments,
    ...(accounts.length > 1 ? { accounts } : {}),
    ...(limits ? { limits } : {}),
  };
}

/** The limits an email's card checks its fields against, when mail.rs gave them all. */
function mailLimits(raw: unknown): MailLimits | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<Record<keyof MailLimits, unknown>>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const limits = { recipients: n(r.recipients), subject: n(r.subject), body: n(r.body), files: n(r.files), bytes: n(r.bytes) };
  return Object.values(limits).every((v) => v != null) ? (limits as MailLimits) : null;
}

/**
 * How long an email's card stays: as long as Lumo waits for it (mail.rs, up
 * to 300 s, room to change it), a second less. 107 s when it does not say.
 */
export function mailCardMs(secs: unknown): number {
  if (typeof secs !== "number" || !Number.isFinite(secs)) return 107_000;
  return Math.max(500, Math.min(300, Math.max(1, secs)) * 1000 - 1000);
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * The step each tool shows in the ticker, in English and shown in the
 * interface language (src/i18n) when the step is recorded.
 */
const TOOL_LABELS: Record<string, string> = {
  Bash: N_("Runs"),
  Read: N_("Reads"),
  Write: N_("Writes"),
  Edit: N_("Edits"),
  Glob: N_("Searches"),
  Grep: N_("Searches"),
  WebSearch: N_("Searches the web"),
  WebFetch: N_("Fetches"),
  TodoWrite: N_("Tasks"),
  Task: N_("Agent"),
  LS: N_("Lists"),
  MultiEdit: N_("Edits"),
  NotebookEdit: N_("Notebook"),
  PowerShell: N_("Runs"),
  // Antigravity's tools (#298).
  run_command: N_("Runs"),
  view_file: N_("Reads"),
  write_to_file: N_("Writes"),
  replace_file_content: N_("Edits"),
  read_url_content: N_("Fetches"),
  search_web: N_("Searches the web"),
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ? t(TOOL_LABELS[tool]) : tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${clipUnits(cmd, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${clipUnits(query, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "TargetFile", // Antigravity's write_to_file, replace_file_content
  "Path", // Antigravity CLI's edit_file
  "AbsolutePath", // Antigravity's view_file
  "filePath", // OpenCode
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  // The chat's computer use: what the click or the keys will do.
  const action = describeComputerAction(tool, input);
  if (action) return action;
  // An MCP server's tool: what its fields mean is its own. Its `path` or
  // `command` may come with a script, a body or a host that Allow allows
  // too: with anything besides the one field, the card shows it all. Its
  // `description` too: there it is an argument (an issue's body, a file's
  // text), not the agent's words, so it stays in what is shown.
  const mcp = MCP_TOOL.test(tool);
  const given = mcp ? input : Object.fromEntries(Object.entries(input).filter(([k]) => !REASON_KEYS.has(k)));
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      if (mcp && Object.keys(given).some((k) => k !== field)) break;
      return `${tool} · ${value.trim()}`;
    }
  }
  // Nothing that names it alone (an MCP tool's call): all it is given, since
  // Allow allows exactly that. The agent's own explanation is the line above it.
  return Object.keys(given).length ? `${tool} · ${JSON.stringify(given)}` : tool;
}

/** An MCP server's tool, as Claude Code ("mcp__github__create_issue") and others ("mcp_github_create_issue") name it. */
const MCP_TOOL = /^mcp_/i;

/** What the agent says of a call (core/approvals.ts REASON_FIELDS): shown as the line above, not as what it is given. */
const REASON_KEYS = new Set(["description", "Description", "justification", "explanation", "Explanation", "toolSummary"]);

/**
 * The line under the who-row that says what the request is for: the agent's
 * own words when it gave some, else what the request does, read off it.
 * For computer use, the step of its plan under way (computer-state), which
 * is why it acts; nothing without a plan, the target says the rest.
 */
function approvalAbout(tool: string, input: Record<string, unknown>): { reason?: string; kind?: { text: string; vars?: Record<string, string> } } {
  if (describeComputerAction(tool, input)) {
    const step = State.computer ? currentStep(State.computer.steps) : null;
    const why = step?.step.text.trim();
    return why ? { reason: why } : {};
  }
  // An MCP tool's `description` is one of its arguments, shown whole below: the line says what kind of call it is.
  const reason = MCP_TOOL.test(tool) ? null : requestReason(input);
  if (reason) return { reason };
  const kind = requestKind(tool, input);
  return kind ? { kind } : {};
}

/**
 * The questions of an AskUserQuestion call, if the island can show all of them
 * as options to pick from. Anything it cannot is left to the terminal.
 */
function askedQuestions(tool: string, input: Record<string, unknown>): AskedQuestion[] | null {
  if (tool !== "AskUserQuestion" || !Array.isArray(input.questions)) return null;
  const out: AskedQuestion[] = [];
  for (const raw of input.questions as Record<string, unknown>[]) {
    const question = typeof raw?.question === "string" ? raw.question : "";
    const options = (Array.isArray(raw?.options) ? (raw.options as Record<string, unknown>[]) : [])
      .filter((o) => typeof o?.label === "string" && o.label)
      .map((o) => ({
        label: o.label as string,
        description: typeof o.description === "string" ? o.description : "",
      }));
    // A question cut short by the relay would be answered under the wrong text.
    if (!question || question.endsWith("…") || options.length < 2) return null;
    out.push({ question, options, multiSelect: raw.multiSelect === true });
  }
  return out.length > 0 ? out : null;
}

/** The Claude Code session's pill, named after its project for the session. */
function upsert(id: string, projectName: string, cwd: string, sessionId: string) {
  const t = State.upsertWorkspacePill(id, projectName, cwd);
  if (t && sessionId) t.sessionId = sessionId;
}

/** The session is over: the pill goes back as it was, or away if it was only there for it. */
function clearSession(id: string) {
  const t = State.tasks.find((x) => x.id === id);
  if (!t) return;
  if (!State.isKept(id)) {
    State.removeTask(id);
    return;
  }
  t.state = "idle";
  t.steps = [];
  t.stepIndex = 0;
  delete t.stepSeq;
  t.name = pillDefinition(id)?.name ?? t.name;
  t.pillBadge = null;
  t.sessionId = null;
  t.sessionTitle = null;
  t.finalLine = null;
  t.failure = null;
}

/** The final message, and the error a turn stopped on, stay on the card until the next turn starts. */
function clearFinalLine(id: string) {
  const t = State.tasks.find((x) => x.id === id);
  if (!t) return;
  t.finalLine = null;
  t.failure = null;
}

/**
 * PostToolUse of Edit / MultiEdit / Write → a diff stored for the pill and a
 * ticker step with its +N −M counts. Nothing is kept for a pill that does not
 * exist, so a stray event cannot grow memory. An edit the relay had to cut
 * would give wrong counts: the PreToolUse step ("Edits · file") stands alone.
 */
function recordDiff(agentId: string, payload: HookPayload) {
  if (payload.lumo_diff_truncated) return;
  if (!State.tasks.some((t) => t.id === agentId)) return;
  const diff = buildFileDiff(payload.tool_name ?? "", payload.tool_input ?? {});
  if (!diff) return;
  const id = State.appendSessionDiff(agentId, diff);
  State.appendStep(agentId, makeDiffStep(fileName(diff.path), diff.added, diff.removed, id));
}

export function registerHookHandlers(island: Island) {
  // The last plan numbers seen survive a restart.
  State.planUsage ??= restorePlanUsage(storedClaudePlanUsage());
  void onEvent<unknown>("hook", (raw) => {
    const payload = cleanPayload(raw);
    if (payload) handleHook(island, payload);
  });
  // A request answered in the terminal instead: the relay hung up (pipe.rs).
  void onEvent<string>("hook-settled", (requestId) => settleRequest(island, requestId));
  // The same numbers from a chat answer of Claude Code (claude_code.rs), which
  // may report one window only: the other one is kept.
  void onEvent<unknown>("chat-plan-usage", (rateLimits) => keepPlanUsage(rateLimits));
  // Or, turned on in Settings, from Anthropic while the island is open.
  startPlanUsagePolling();
}


function handleHook(island: Island, payload: HookPayload) {
  // Account-wide numbers from the status line relay, not part of any session:
  // keep the latest, nothing else (no reveal, no sound), paused or not.
  if (payload.hook_event_name === "StatusLine") {
    keepPlanUsage(payload.rate_limits);
    return;
  }

  // Paused, Lumo shows and says nothing. A turn that ends or a session that
  // closes meanwhile still settles its pill, quietly: dropped, it left the
  // pill at work or waiting for ever once Lumo was back.
  const quiet = State.paused;
  if (quiet) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    if (!SETTLES_WHILE_PAUSED.has(payload.hook_event_name ?? "")) return;
  }

  const name = payload.hook_event_name ?? "";
  // The island's own chat is not a session: the relay only lets its permission
  // requests through, and anything else that slips by is ignored here too.
  if (payload.lumo_island === true && name !== "PermissionRequest") return;
  // A session another program started on its own: on that program's pill with
  // the others (core/background.ts), not at all, or — "single" — as any
  // session. A permission request always comes up as its card.
  if (payload.lumo_background === true && name !== "PermissionRequest") {
    const mode = parseBackgroundMode(State.settings.backgroundSessions);
    if (mode === "hidden") return;
    if (mode === "grouped") {
      // Its runs settle on their own (STALE_MS): nothing of them while paused.
      if (!quiet) handleBackground(island, payload, name);
      return;
    }
  }
  const cwd = payload.cwd ?? "";
  const projectName = lastPathComponent(cwd) || "Session";

  // Route to the right pill. Valid lumo_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved; absent or invalid → Claude Code's own pill: Cursor's
  // when it runs in Cursor's terminal, VS Code's otherwise.
  const validAgent = validateAgent(payload.lumo_agent);
  const workspaceId = payload.term_editor === "cursor" ? CURSOR_ID : CLAUDE_ID;
  const agentId = validAgent ? `agent_${validAgent}` : workspaceId;
  const isExternalAgent = validAgent !== null;
  /** Claude Code, in a terminal or in the Claude app: it asks questions and titles its sessions. */
  const isClaude = !isExternalAgent || validAgent === "claude-desktop";
  const sessionId = payload.session_id ?? "";

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    // The launch greeting is open too, but it folds by itself 0.6 s after it
    // ends: an alert then opens the island for real, as from closed.
    if (State.mode === "expanded" && State.view !== "greeting") {
      if (isAlert) {
        island.setView(view);
        // Already open with the mouse elsewhere: its countdown waits for this to be read.
        island.giveReadingTime();
      }
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  // Every session behind the pill is known, so that one of them stopping or
  // ending leaves the others' work alone. The chat's own runs are not sessions.
  if (name && name !== "SessionEnd" && payload.lumo_island !== true) {
    const title = isClaude && typeof payload.lumo_title === "string" ? payload.lumo_title.trim() : "";
    liveSessions.touch(agentId, sessionId, cwd, projectName, name, title || undefined);
  }

  /**
   * Ensure the pill exists, showing its owner session: the oldest one mid-turn,
   * else the one heard from last, so two sessions at work never take turns at
   * its name, folder and terminal.
   */
  const ensurePill = () => {
    // Where the project is, for the Code section's session history.
    rememberFolder(cwd);
    const owner = liveSessions.owner(agentId);
    const ownCwd = owner ? owner.cwd : cwd;
    const ownSession = owner ? owner.id : sessionId;
    if (isExternalAgent) {
      State.upsertExternalAgent(agentId, agentName(validAgent!), agentColor(validAgent!));
      const t = State.tasks.find((x) => x.id === agentId);
      if (t && ownCwd) t.sessionCwd = ownCwd;
      if (t && ownSession) t.sessionId = ownSession;
    } else {
      upsert(agentId, owner ? owner.project : projectName, ownCwd, ownSession);
    }
  };

  /**
   * Called where a handler is about to replace `finished` with a newer state:
   * the timer Stop armed would otherwise put the pill back to idle over it. The
   * badge that timer was going to clear goes now.
   */
  const supersedeStop = () => {
    if (cancelStopTimer(agentId)) State.setPillBadge(agentId, null);
  };

  // The request was settled somewhere else — the turn is over (interrupted, a
  // new prompt) or the very call it asked about ran, so it was answered in the
  // terminal — and the card would be lying. It goes, and the relay is released
  // without a decision.
  // Requests waiting in line go first, so none of them takes the card.
  const settled = (q: ApprovalInfo) => settledElsewhere(q, name, agentId, sessionId, payload.tool_name, payload.tool_input);
  withdrawQueued(settled);
  const pending = State.pendingApproval;
  if (pending && settled(pending)) {
    clearCardTimer(pending.requestId);
    if (pending.requestId) void Bridge.approvalDecline(pending.requestId);
    dropPendingCard(island);
  }

  // Read after the card above is dropped: its pill may have handed the front
  // back to the pill you were on.
  const focused = State.focusId === agentId;

  /**
   * The plan the tool call carries. Claude Code's TaskCreate only counts once
   * done (`post`): its result says the task's id, which TaskUpdate then names.
   */
  const followPlan = (post: boolean) => {
    let input = payload.tool_input;
    if (payload.tool_name === "TaskCreate") {
      if (!post) return;
      if (payload.lumo_task_id) input = { ...input, taskId: payload.lumo_task_id };
    }
    const task = State.tasks.find((x) => x.id === agentId);
    island.plan?.onTool({
      pillId: agentId,
      sessionId,
      agent: isExternalAgent ? agentName(validAgent!) : "Claude Code",
      color: task?.color ?? (isExternalAgent ? agentColor(validAgent!) : pillDefinition(agentId)?.color ?? "#f5f6f8"),
      project: projectName,
    }, payload.tool_name ?? "", input);
  };

  switch (name) {
    case "SessionStart":
      ensurePill();
      // An agent's new session within 5.2 s of the last one's Stop: that
      // Stop's timer still brings the pill to rest, but no longer takes it
      // away from under the new session.
      if (isExternalAgent && cancelStopTimer(agentId)) armStopTimer(agentId, false);
      clearFinalLine(agentId);
      // Hermes through its gateway says where the session comes from.
      if (validAgent === "hermes" && payload.platform && payload.platform !== "cli") {
        State.appendStep(agentId, payload.platform.charAt(0).toUpperCase() + payload.platform.slice(1));
      }
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      ensurePill();
      supersedeStop();
      clearFinalLine(agentId);
      State.updateTask(agentId, "thinking");
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(agentId, clipUnits(asked, 60), fullTextDetail(asked, clipUnits(asked, 60)));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      ensurePill();
      supersedeStop();
      clearFinalLine(agentId);
      State.updateTask(agentId, "working");
      const tool = payload.tool_name ?? "Tool";
      State.appendStep(agentId, stepLabel(tool, payload.tool_input ?? {}), toolStepDetail(tool, payload.tool_input ?? {}));
      followPlan(false);
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      supersedeStop();
      // A question answered in the terminal already took its card down above
      // (settledElsewhere).
      State.updateTask(agentId, "working");
      recordDiff(agentId, payload);
      followPlan(true);
      break;

    case "PostToolUseFailure":
      supersedeStop();
      State.updateTask(agentId, "working");
      State.appendStep(
        agentId,
        t("⚠ failed"),
        failureDetail(payload.tool_name ?? "", payload.tool_input ?? {}, payload.error),
      );
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        supersedeStop();
        State.updateTask(agentId, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?") || NEEDS_YOU.has(payload.notification_type ?? "")) {
        supersedeStop();
        State.updateTask(agentId, "question");
        State.appendStep(agentId, message);
      }
      break;
    }

    case "Stop": {
      // Another session of the pill is still at work: this one's last words
      // and its sound, but the pill goes on working for the other.
      if (liveSessions.othersBusy(agentId, sessionId)) {
        const said = payload.last_assistant_message ?? payload.message ?? "";
        const finalText = toOneLine(said);
        if (finalText) State.appendStep(agentId, finalText, fullTextDetail(said, finalText));
        if (!quiet) Sound.play("finish");
        break;
      }
      State.updateTask(agentId, "finished");
      // Claude Code puts the turn's answer in the Stop payload itself, so there is
      // no transcript to read (the relay does not even forward its path). Other
      // agents report their last words the same way (Hermes, Codex) or as
      // `message`.
      const said = payload.last_assistant_message ?? payload.message ?? "";
      // Up to three lines on the finished card (views.ts buildFinished).
      const finalText = toOneLine(said, 300);
      if (finalText) {
        State.appendStep(agentId, finalText, fullTextDetail(said, finalText));
        const t = State.tasks.find((x) => x.id === agentId);
        if (t) t.finalLine = finalText;
      }
      if (quiet) {
        // Nothing to see while paused: the timer below brings the pill back to rest.
      } else if (focused && !State.pendingApproval) {
        Sound.play("finish");
        // A card waiting for an answer is never covered by another alert.
        surface("finished", true);
      } else {
        Sound.play("finish");
        State.setPillBadge(agentId, "finished");
        // Said on the closed island too, as it is not the one in front.
        const done = State.tasks.find((x) => x.id === agentId);
        if (done && State.mode !== "expanded") compactNotice(t(COMPACT_TEXT.finished, { helper: done.name }), done.color);
      }
      armStopTimer(agentId, isExternalAgent);
      break;
    }

    case "Interrupt":
      // Codex: the user stopped the turn. Back to idle, nothing to celebrate,
      // unless another session of the pill is still at work.
      if (liveSessions.othersBusy(agentId, sessionId)) break;
      supersedeStop();
      State.updateTask(agentId, "idle");
      State.setPillBadge(agentId, null);
      break;

    case "StopFailure": {
      supersedeStop();
      // Why, as Claude Code says it: the error card shows it, not the last step.
      const failed = State.tasks.find((x) => x.id === agentId);
      const code = typeof payload.error === "string" ? payload.error.trim() : "";
      const details = typeof payload.error_details === "string" ? toOneLine(payload.error_details) : "";
      if (failed) failed.failure = code || details ? { code, details } : null;
      State.updateTask(agentId, "error");
      if (quiet) break;
      Sound.play("error");
      if (focused && !State.pendingApproval) surface("error", true);
      else State.setPillBadge(agentId, "error");
      break;
    }

    case "SessionEnd":
      liveSessions.end(agentId, sessionId);
      island.plan?.endSession(agentId, sessionId);
      // Other sessions are still behind the pill: its card, diffs and state are
      // theirs; it only shows the one that owns it now.
      if (liveSessions.live(agentId).length) {
        if (State.tasks.some((x) => x.id === agentId)) ensurePill();
        break;
      }
      // Nothing left for the timer to do, and it must not outlive the session: a
      // pill recreated within 5.2 s would be removed by it.
      cancelStopTimer(agentId);
      State.clearSessionDiffs(agentId);
      if (isExternalAgent) {
        State.removeTask(agentId);
      } else {
        State.updateTask(agentId, "idle");
        clearSession(agentId);
      }
      break;

    case "SubagentStart":
      State.appendStep(agentId, t("+ subagent"));
      break;

    // The context filled up (or /compact): the agent is summing up the
    // conversation so far, which takes a while with nothing else to show.
    case "PreCompact":
      if (!State.tasks.some((x) => x.id === agentId)) break;
      State.appendStep(agentId, t("Compacting the conversation…"));
      break;

    case "PostCompact":
      if (!State.tasks.some((x) => x.id === agentId)) break;
      State.appendStep(agentId, t("Conversation compacted"));
      break;

    // Auto mode said no to a call, on its own: nothing to answer, but the
    // session's steps say what was not done.
    case "PermissionDenied": {
      ensurePill();
      const tool = payload.tool_name ?? "Tool";
      State.appendStep(
        agentId,
        t("Denied by auto mode: {action}", { action: stepLabel(tool, payload.tool_input ?? {}) }),
        toolStepDetail(tool, payload.tool_input ?? {}),
      );
      break;
    }

    case "SubagentStop":
      State.appendStep(agentId, t("• subagent done"));
      break;

    case "PermissionRequest": {
      // Only Claude Code (in a terminal or in the Claude app), the agents the
      // relay can answer for (Codex, Copilot CLI, Muse Code, OpenCode) and an
      // Antigravity command no rule of its own covers get a card. Anyone else's request is
      // declined at once, so the agent asks in its own terminal. And a shell
      // command of the chat's own Antigravity CLI run (antigravity_cli.rs), which
      // the relay turns into a request: headless agy has no terminal to ask in.
      const chatAgy = payload.lumo_island === true && validAgent === "antigravity";
      // A command of your own Antigravity session none of its rules covers:
      // Allow, Deny, or back to Antigravity's own prompt.
      const agyGate = payload.lumo_island !== true && validAgent === "antigravity" && payload.lumo_agy_gate === true;
      // A request of the chat's own Cursor CLI, which Lumo answers over ACP
      // (acp_chat.rs): Cursor's hooks stay out of the chat's runs.
      const chatCursor = payload.lumo_island === true && validAgent === "cursor";
      if (isExternalAgent && !APPROVAL_AGENTS.has(validAgent!) && !chatAgy && !agyGate && !chatCursor) {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        break;
      }

      const requestId = payload.request_id ?? "";
      // An email the AI wants to send: always its own card, always a click.
      const email = outgoingEmail(payload.lumo_mail_send);
      // A change to an email the AI wants to make: always a card too, never the closed island's.
      const liveFile = email ? null : liveFileChange(payload.lumo_live_file, payload.tool_input ?? {});
      const change = email ? null : mailChange(payload.lumo_mail_action) ?? liveFile;
      // The chat's Antigravity CLI run in Auto, agy's own Turbo preset: everything runs.
      // But the first computer action of the chat: the user says yes to the rest of them.
      const agyMode = chatAgy ? parsePermissionMode(storedPermissionMode(State.settings, "antigravity-cli"), "antigravity-cli") : "default";
      const consent = payload.lumo_computer_consent === true;
      if (chatAgy && requestId && !email && !change && !consent && agyMode === "auto") {
        void Bridge.log(`permission ${payload.tool_name} req=${requestId} (chat, allowed by ${agyMode})`);
        void Bridge.approvalAutoAllow(requestId);
        break;
      }
      // One card, one request. A second one never replaces the first — that
      // would leave a human staring at request B while request A waits for a
      // decision nobody can give. It waits in line (State.approvalQueue),
      // and comes up once the one before is answered.
      const inLine = State.pendingApproval != null && State.pendingApproval.requestId !== requestId;
      if (inLine) {
        // The same request again: still in line, acknowledged again.
        if (requestId && State.approvalQueue.some((q) => q.requestId === requestId)) {
          void Bridge.approvalAck(requestId);
          break;
        }
        // With no id there is nothing to answer later; with a full line the
        // newest goes back to its terminal.
        if (!requestId || State.approvalQueue.length >= MAX_WAITING) {
          if (requestId) void Bridge.approvalDecline(requestId);
          break;
        }
      }
      // The island's own chat asked: no session pill, the card stays over the chat.
      const fromChat = payload.lumo_island === true;
      if (!fromChat) {
        ensurePill();
        supersedeStop();
      }
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      const userTool = payload.lumo_user_tool ?? null;
      // Claude Code asking a question is not a permission to grant: the island
      // shows the options and sends back the one that was picked. Only Claude
      // Code asks questions this way, in a terminal or in the Claude app.
      const questions = isClaude ? askedQuestions(tool, input) : null;
      const view = questions ? "question" : "approval";
      const planSteps = !questions && !email && !change && /^exit_?plan_?mode$/i.test(tool) && typeof input.plan === "string"
        ? stepsFromMarkdown(input.plan) : [];
      // A file to write: how many lines, under its name (the text itself is not on the card).
      const edit = !questions && !email && !change && !userTool
        ? editStat(tool, input, {
          cut: payload.lumo_input_cut === true || payload.lumo_text_cut === true,
          added: payload.lumo_write_added, removed: payload.lumo_write_removed, bytes: payload.lumo_write_bytes,
        })
        : null;
      const computerAt = !questions && !email && !change && !userTool ? computerPoint(tool, input) : null;
      const computerScroll = computerAt && computerToolName(tool) === "scroll" ? scrollDirection(input) : null;
      const info: ApprovalInfo = {
        requestId,
        sessionId,
        pillId: fromChat ? (State.focusId ?? agentId) : agentId,
        tool,
        // One of the user's tools: its name and what it is given, and the
        // supervisor's words for what it does.
        command: email ? email.to.join(", ") : change ? change.command : userTool ? userToolTarget(userTool.name ?? tool, input) : approvalTarget(tool, input),
        ...(email ? { email } : change ? { reason: change.reason } : userTool ? (userTool.summary ? { reason: userTool.summary } : {}) : approvalAbout(tool, input)),
        ...(questions ? { questions } : {}),
        ...(fromChat ? { fromChat } : {}),
        // Asked inside one of the chat's agents: its row in the Agents card says so.
        ...(fromChat && typeof payload.agent_id === "string" && payload.agent_id ? { subagentId: payload.agent_id } : {}),
        ...(payload.lumo_session_allow === true && payload.lumo_input_cut !== true && !questions && !agyGate ? { sessionAllow: true } : {}),
        ...(payload.lumo_remembered === true && !questions ? { remembered: true } : {}),
        ...(payload.lumo_input_cut === true && !questions && !email && !change && !userTool
          ? { cut: true, ...(typeof payload.lumo_input_bytes === "number" ? { cutBytes: payload.lumo_input_bytes } : {}) } : {}),
        ...(agyGate ? { answerIn: agentName("antigravity") } : {}),
        // A pill named after a project can carry two sessions: the card says whose request it is.
        ...(liveFile ? { project: "Gemini Live" } : !fromChat && !isExternalAgent ? { project: projectName } : {}),
        // The plan Claude Code asks to start, step by step, for the new look's card and chat.
        ...(planSteps.length ? { plan: planSteps } : {}),
        ...(edit ? { edit } : {}),
        // A computer use action: the point it acts on, for the screen around it on the card.
        ...(computerAt ? { computerAt } : {}),
        ...(computerScroll ? { computerScroll } : {}),
      };
      // Lumo answers within 108 s (DECISION_TIMEOUT in pipe.rs) or not at all.
      // For the chat's Antigravity CLI and Claude Code runs, the relay says how
      // long it waits. Either way the card goes just before.
      const cardMs = email ? mailCardMs(payload.lumo_card_secs)
        : chatAgy || typeof payload.lumo_card_secs === "number" ? agyCardMs(payload.lumo_card_secs) : 107_000;
      if (inLine) {
        State.approvalQueue.push({ ...info, ...(!questions && !email && !change && !info.cut && isSimpleRequest(tool, input) ? { simple: true } : {}) });
        void Bridge.log(`permission ${tool} req=${requestId}${fromChat ? " (chat)" : ""} (waiting, ${State.approvalQueue.length + 1} in line)`);
        // A human will see it: the relay waits for the decision.
        void Bridge.approvalAck(requestId);
        if (!fromChat) State.updateTask(agentId, view);
        Sound.play(view);
        armCardTimer(island, requestId, cardMs);
        break;
      }
      // A request that only reads or looks, while the island is closed, is
      // answered right there: Deny and Allow next to Lumo (Settings → Island).
      // Still a click, never automatic; anything else opens the full card,
      // a request the relay had to cut too (its card has no Allow).
      const quick = !questions && !email && !change && !info.cut && State.settings.quickApprovals !== false
        && State.mode !== "expanded" && isSimpleRequest(tool, input);
      void Bridge.log(`permission ${tool} req=${requestId || "none"}${fromChat ? " (chat)" : ""}${quick ? " (closed island)" : ""}`);
      // The card always comes up, even over another pill or an island that is
      // already open: its pill comes to the front, and the one you were on
      // comes back once you answer.
      State.beginApproval({ ...info, ...(quick ? { quick } : {}) });
      // The relay's short ack window closes in 800 ms; everything below this
      // line is synchronous, so the card really is up by the time it lands.
      if (requestId) void Bridge.approvalAck(requestId);
      if (!fromChat) State.updateTask(agentId, view);
      Sound.play(view);
      // Any agent's card (Claude Code, Codex, Copilot CLI, Muse Code) comes up
      // the same way: beginApproval brought its pill to the front. A simple
      // one stays on the closed island, if it can show it.
      if (!quick || !island.quickApproval()) {
        if (State.pendingApproval?.quick) State.pendingApproval.quick = false;
        island.alert(State.pendingApproval ? State.requestView(State.pendingApproval) : view);
      }
      armCardTimer(island, requestId, cardMs);
      break;
    }

    default:
      break;
  }
  if (validAgent === "antigravity" && payload.lumo_island !== true && name) watchSilence(island, agentId, name);
  // The pill's session goes by its title, when Claude Code has given it one.
  const pill = isClaude && payload.lumo_island !== true ? State.tasks.find((x) => x.id === agentId) : undefined;
  if (pill) pill.sessionTitle = liveSessions.owner(agentId)?.title ?? null;
  State.notify();
}

// ── Sessions in the background ────────────────────────────────────────────────

/** The background sessions of every program, counted (core/background.ts). */
export const backgroundRuns = new BackgroundRuns();
/** Per group: the wait for a quiet moment, then the one that takes the finished pill away. */
const backgroundTimers = new Map<string, number>();
/**
 * Per group: a batch nothing was heard from for STALE_MS is over, its
 * sessions killed before they could say so (a tool's own timeout).
 */
const backgroundWatchdogs = new Map<string, number>();

/** Forgets every group and its timers, as at start (tests: a new clock reuses timer ids). */
export function resetBackground(): void {
  backgroundRuns.clear();
  backgroundTimers.clear();
  backgroundWatchdogs.clear();
}

/** What ends a session's turn, or the session; anything else is work. */
const BACKGROUND_EVENTS: Record<string, BackgroundEvent> = {
  Stop: "done",
  StopFailure: "failed",
  Interrupt: "end",
  SessionEnd: "end",
};

function clearTimer(timers: Map<string, number>, id: string): void {
  const timer = timers.get(id);
  if (timer == null) return;
  window.clearTimeout(timer);
  timers.delete(id);
}

/**
 * One event of a background session: the program's pill counts it. One sound
 * when a batch starts and one when it is over; no alert, no folder remembered,
 * no plan followed, whatever the number of sessions.
 */
export function handleBackground(island: Pick<Island, "reveal">, payload: HookPayload, name: string, now = Date.now()): void {
  const launcher = launcherName(payload.lumo_launcher);
  const id = backgroundGroupId(launcher);
  const kind: BackgroundEvent = BACKGROUND_EVENTS[name] ?? "busy";
  // The end of a session nobody saw at work is nothing to show.
  if (kind === "end" && !backgroundRuns.counts(id)) return;
  clearTimer(backgroundTimers, id);
  const said = kind === "failed" ? payload.error ?? "" : payload.last_assistant_message ?? payload.message ?? "";
  const validAgent = validateAgent(payload.lumo_agent);
  const started = backgroundRuns.event(id, payload.session_id ?? "", kind, now, {
    subject: name === "UserPromptSubmit" ? subjectOf(payload.prompt) : undefined,
    text: kind === "done" ? answerLine(said) : kind === "failed" ? toOneLine(said) : undefined,
    agent: validAgent ? agentName(validAgent) : "Claude Code",
    total: batchTotal(payload.lumo_batch_total),
  });
  // Sessions of any program gone silent for too long were killed: not running any more.
  for (const gid of backgroundRuns.sweep(now)) {
    const pill = State.tasks.find((x) => x.id === gid);
    if (pill) pill.background = backgroundRuns.info(gid);
    if (gid !== id && backgroundRuns.counts(gid)?.running === 0) waitForQuiet(gid);
  }
  State.upsertExternalAgent(id, launcher ?? t(BACKGROUND_TEXT.unnamed), BACKGROUND_COLOR);
  const task = State.tasks.find((x) => x.id === id);
  if (!task) return;
  task.background = backgroundRuns.info(id);
  task.finalLine = null;
  task.pillBadge = null;
  // Every answer, by what it was about, for the list of them (the detail's last answer opens it).
  const answer = kind === "done" ? task.background?.last : kind === "failed" ? task.background?.lastFailed : null;
  if (answer) {
    const text = answerText(answer);
    const what = kind === "done" ? text : `${t("⚠ failed")}${text ? ` · ${text}` : ""}`;
    const line = answer.subject ? `${answer.subject}: ${what}` : what;
    if (line) State.appendStep(id, line, said ? fullTextDetail(said, line) : null);
  }
  State.updateTask(id, "working");
  if (started) {
    Sound.play("work");
    if (State.mode === "hidden" && !State.paused) island.reveal();
  }
  if (task.background?.running === 0) waitForQuiet(id);
  clearTimer(backgroundWatchdogs, id);
  backgroundWatchdogs.set(id, window.setTimeout(() => {
    backgroundWatchdogs.delete(id);
    finishBackground(id);
  }, STALE_MS));
}

/** Nothing running: if nothing starts again soon, the batch is over. */
function waitForQuiet(id: string): void {
  clearTimer(backgroundTimers, id);
  backgroundTimers.set(id, window.setTimeout(() => {
    backgroundTimers.delete(id);
    if (backgroundRuns.counts(id)?.running === 0) finishBackground(id);
  }, QUIET_MS));
}

/** The batch is over: said once, on the pill and on the closed island, then the pill goes. */
export function finishBackground(id: string): void {
  clearTimer(backgroundTimers, id);
  clearTimer(backgroundWatchdogs, id);
  const counts = backgroundRuns.close(id);
  const task = State.tasks.find((x) => x.id === id);
  if (!counts || !task) return;
  task.background = counts;
  const failedOnly = counts.done === 0 && counts.failed > 0;
  const summary = backgroundLine(counts);
  task.finalLine = summary;
  State.updateTask(id, failedOnly ? "error" : "finished");
  Sound.play(failedOnly ? "error" : "finish");
  if (State.mode !== "expanded") compactNotice(`${t(COMPACT_TEXT.finished, { helper: task.name })} · ${summary}`, task.color);
  backgroundTimers.set(id, window.setTimeout(() => {
    backgroundTimers.delete(id);
    if (!backgroundRuns.counts(id)) State.removeTask(id);
  }, 5200));
}
