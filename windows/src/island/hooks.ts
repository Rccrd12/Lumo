// Hook events from Claude Code and every other agent → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.
// The relay has already mapped every agent's events and fields onto Claude
// Code's (hook/src/normalize.rs), so one handler serves them all.

import { describeComputerAction } from "../core/computer";
import { userToolTarget } from "../core/tools";
import { COMPACT_TEXT, compactNotice } from "../core/compact";
import { Bridge, onEvent } from "../core/bridge";
import { buildFileDiff, fileName, makeDiffStep, toOneLine } from "../core/diff";
import { Sound } from "../core/sound";
import { PillSessions } from "../core/pill-sessions";
import { State, type ApprovalInfo, type AskedQuestion } from "../core/state";
import { pillDefinition } from "../core/pills";
import { APPROVAL_AGENTS, agentColor, agentName, validateAgent } from "./agents";
import type { Island } from "./island";
import { restorePlanUsage } from "../core/plan";
import { autoAllows, isSimpleRequest, requestKind, requestReason } from "../core/approvals";
import { parsePermissionMode } from "../core/providers";
import { rememberFolder } from "../core/sessions";
import { keepPlanUsage, startPlanUsagePolling, storedClaudePlanUsage } from "../views/usage";
import { N_, t } from "../i18n/i18n";

const CLAUDE_ID = "integration_claude";
const CURSOR_ID = "agent_cursor";

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
    island.setView(State.agentsView());
  }
  presentApproval(island);
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
  island.alert(req.questions ? "question" : "approval");
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

/** Events after which a pending permission request of the same session is moot. */
const TURN_OVER = new Set(["Stop", "StopFailure", "UserPromptSubmit", "SessionEnd", "Interrupt"]);

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  /** Stop: the turn's final answer (Markdown) — Claude Code's, Hermes's, Codex's. */
  last_assistant_message?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
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
  /** The chat's Antigravity CLI run in Auto: its commands run in agy's sandbox. */
  lumo_sandbox?: boolean;
  /** A card of the chat's Antigravity CLI run: how long the relay waits for a click, in seconds. */
  lumo_card_secs?: number;
  /** StatusLine (the plan usage relay): Claude Code's 5-hour and weekly limits. */
  rate_limits?: unknown;
  /** PostToolUse of TaskCreate: the id of the task made (the relay keeps it of the result). */
  lumo_task_id?: string;
  /** A call of one of the user's tools, asked for by Lumo itself (tools.rs approve). */
  lumo_user_tool?: { name?: string; summary?: string };
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/**
 * localizedStep() — same labels as the macOS app, in English and shown in the
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
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
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
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  // The chat's computer use: what the click or the keys will do.
  const action = describeComputerAction(tool, input);
  if (action) return action;
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

/**
 * The line under the who-row that says what the request is for: the agent's
 * own words when it gave some, else what the request does, read off it.
 * Nothing for the chat's computer use, whose target already says it.
 */
function approvalAbout(tool: string, input: Record<string, unknown>): { reason?: string; kind?: { text: string; vars?: Record<string, string> } } {
  if (describeComputerAction(tool, input)) return {};
  const reason = requestReason(input);
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
  t.finalLine = null;
}

/** The final message stays on the card until the next turn starts. */
function clearFinalLine(id: string) {
  const t = State.tasks.find((x) => x.id === id);
  if (t) t.finalLine = null;
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
  // The last plan numbers seen survive a restart, as on the Mac.
  State.planUsage ??= restorePlanUsage(storedClaudePlanUsage());
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
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

  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  // The island's own chat is not a session: the relay only lets its permission
  // requests through, and anything else that slips by is ignored here too.
  if (payload.lumo_island === true && name !== "PermissionRequest") return;
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");

  // Route to the right pill. Valid lumo_agent → dynamic "agent_<name>" pill.
  // "claude" is reserved; absent or invalid → Claude Code's own pill: Cursor's
  // when it runs in Cursor's terminal (Mac #120), VS Code's otherwise.
  const validAgent = validateAgent(payload.lumo_agent);
  const workspaceId = payload.term_editor === "cursor" ? CURSOR_ID : CLAUDE_ID;
  const agentId = validAgent ? `agent_${validAgent}` : workspaceId;
  const isExternalAgent = validAgent !== null;
  const sessionId = payload.session_id ?? "";

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  // Every session behind the pill is known, so that one of them stopping or
  // ending leaves the others' work alone. The chat's own runs are not sessions.
  if (name && name !== "SessionEnd" && payload.lumo_island !== true) {
    liveSessions.touch(agentId, sessionId, cwd, projectName, name);
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

  // The turn that asked for a permission is over — answered in the terminal,
  // interrupted, or a new prompt — so the card would be lying. It goes, and the
  // relay is released without a decision. Same rule as the Mac.
  // Requests of that turn waiting in line go first, so none of them takes the card.
  if (TURN_OVER.has(name)) withdrawQueued((q) => q.pillId === agentId && q.sessionId === sessionId);
  const pending = State.pendingApproval;
  if (
    pending &&
    TURN_OVER.has(name) &&
    pending.pillId === agentId &&
    pending.sessionId === sessionId
  ) {
    clearCardTimer(pending.requestId);
    if (pending.requestId) void Bridge.approvalDecline(pending.requestId);
    dropPendingCard(island);
  }

  // Read after the card above is dropped: its pill may have handed the front
  // back to the pill you were on.
  const focused = State.focusId === agentId;

  /** The plan this tool call carries, if any, to the Plan island (island/plan.ts). */
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
      if (asked) State.appendStep(agentId, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      ensurePill();
      supersedeStop();
      clearFinalLine(agentId);
      State.updateTask(agentId, "working");
      const tool = payload.tool_name ?? "Tool";
      State.appendStep(agentId, stepLabel(tool, payload.tool_input ?? {}));
      followPlan(false);
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      supersedeStop();
      // The question was answered in the terminal: the card would be lying.
      if (payload.tool_name === "AskUserQuestion") {
        withdrawQueued((q) => q.questions != null && q.sessionId === sessionId);
        if (State.pendingApproval?.questions && State.pendingApproval.sessionId === sessionId) {
          clearCardTimer(State.pendingApproval.requestId);
          dropPendingCard(island);
        }
      }
      State.updateTask(agentId, "working");
      recordDiff(agentId, payload);
      followPlan(true);
      break;

    case "PostToolUseFailure":
      supersedeStop();
      State.updateTask(agentId, "working");
      State.appendStep(agentId, t("⚠ failed"));
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        supersedeStop();
        State.updateTask(agentId, "ratelimit");
        Sound.play("rate");
      } else if (message.endsWith("?")) {
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
        const finalText = toOneLine(payload.last_assistant_message ?? payload.message ?? "");
        if (finalText) State.appendStep(agentId, finalText);
        Sound.play("finish");
        break;
      }
      State.updateTask(agentId, "finished");
      // Claude Code puts the turn's answer in the Stop payload itself, so there is
      // no transcript to read (the relay does not even forward its path). Other
      // agents report their last words the same way (Hermes, Codex) or as
      // `message`.
      const finalText = toOneLine(payload.last_assistant_message ?? payload.message ?? "");
      if (finalText) {
        State.appendStep(agentId, finalText);
        const t = State.tasks.find((x) => x.id === agentId);
        if (t) t.finalLine = finalText;
      }
      Sound.play("finish");
      // A card waiting for an answer is never covered by another alert.
      if (focused && !State.pendingApproval) surface("finished", true);
      else {
        State.setPillBadge(agentId, "finished");
        // Said on the closed island too, as it is not the one in front.
        const done = State.tasks.find((x) => x.id === agentId);
        if (done && State.mode !== "expanded") compactNotice(t(COMPACT_TEXT.finished, { helper: done.name }), done.color);
      }
      cancelStopTimer(agentId);
      stopTimers.set(
        agentId,
        window.setTimeout(() => {
          stopTimers.delete(agentId);
          if (isExternalAgent) {
            State.removeTask(agentId);
          } else {
            State.updateTask(agentId, "idle");
            State.setPillBadge(agentId, null);
          }
        }, 5200),
      );
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

    case "StopFailure":
      supersedeStop();
      State.updateTask(agentId, "error");
      Sound.play("error");
      if (focused && !State.pendingApproval) surface("error", true);
      else State.setPillBadge(agentId, "error");
      break;

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

    case "SubagentStop":
      State.appendStep(agentId, t("• subagent done"));
      break;

    case "PermissionRequest": {
      // Only Claude Code and the agents the relay can answer for (Codex, Copilot
      // CLI, Muse Code — same as the Mac) get a card. Anyone else's request is
      // declined at once, so the agent asks in its own terminal. And a shell
      // command of the chat's own Antigravity CLI run (antigravity_cli.rs), which
      // the relay turns into a request: headless agy has no terminal to ask in.
      const chatAgy = payload.lumo_island === true && validAgent === "antigravity";
      if (isExternalAgent && !APPROVAL_AGENTS.has(validAgent!) && !chatAgy) {
        if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
        break;
      }

      const requestId = payload.request_id ?? "";
      // The chat's Antigravity CLI run in Auto: agy's own Proceed in Sandbox.
      // A command that stays in its sandbox, or only looks (core/approvals.ts),
      // runs without a card; anything else, and anything uncertain, is the
      // usual card.
      if (
        chatAgy && requestId && parsePermissionMode(State.settings.chatPermissionMode) === "auto"
        && autoAllows(payload.tool_name ?? "", payload.tool_input ?? {}, payload.lumo_sandbox === true)
      ) {
        void Bridge.log(`permission ${payload.tool_name} req=${requestId} (chat, allowed by Auto)`);
        void Bridge.approvalAutoAllow(requestId);
        break;
      }
      // One card, one request. A second one never replaces the first — that
      // would leave a human staring at request B while request A waits for a
      // decision nobody can give. It waits in line (the Mac's ApprovalQueue),
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
      // Code asks questions this way.
      const questions = isExternalAgent ? null : askedQuestions(tool, input);
      const view = questions ? "question" : "approval";
      const info: ApprovalInfo = {
        requestId,
        sessionId,
        pillId: fromChat ? (State.focusId ?? agentId) : agentId,
        tool,
        // One of the user's tools: its name and what it is given, and the
        // supervisor's words for what it does.
        command: userTool ? userToolTarget(userTool.name ?? tool, input) : approvalTarget(tool, input),
        ...(userTool ? (userTool.summary ? { reason: userTool.summary } : {}) : approvalAbout(tool, input)),
        ...(questions ? { questions } : {}),
        ...(fromChat ? { fromChat } : {}),
        // A pill named after a project can carry two sessions: the card says whose request it is.
        ...(!fromChat && !isExternalAgent ? { project: projectName } : {}),
      };
      // Lumo answers within 108 s (DECISION_TIMEOUT in pipe.rs) or not at all.
      // For the chat's Antigravity CLI and Claude Code runs, the relay says how
      // long it waits. Either way the card goes just before.
      const cardMs = chatAgy || typeof payload.lumo_card_secs === "number" ? agyCardMs(payload.lumo_card_secs) : 107_000;
      if (inLine) {
        State.approvalQueue.push({ ...info, ...(!questions && isSimpleRequest(tool, input) ? { simple: true } : {}) });
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
      // Still a click, never automatic; anything else opens the full card.
      const quick = !questions && State.settings.quickApprovals !== false
        && State.mode !== "expanded" && isSimpleRequest(tool, input);
      void Bridge.log(`permission ${tool} req=${requestId || "none"}${fromChat ? " (chat)" : ""}${quick ? " (closed island)" : ""}`);
      // The card always comes up, even over another pill or an island that is
      // already open: its pill comes to the front, and the one you were on
      // comes back once you answer (Mac #117, #120).
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
        island.alert(view);
      }
      armCardTimer(island, requestId, cardMs);
      break;
    }

    default:
      break;
  }
  State.notify();
}
