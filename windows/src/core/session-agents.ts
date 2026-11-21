// The agents a Claude Code session in a terminal starts, as rows of the
// Agents card in its session card (views/views.ts; concept:
// concepts/sessioni-terminale). Lumo only hears of them through the hooks:
// SubagentStart (its id and kind), the tools it calls (PreToolUse with its
// `agent_id`) and SubagentStop (its last message, its report). Its task is
// the description of the Agent call that started it, matched by kind. Lumo
// can't stop or ask an agent of a session it doesn't run: no Stop, no Ask.
//
// One store for every session, by Claude Code's session id; each prompt's
// agents get a card of their own (the card shows the latest).

import type { ChatActivity, ChatAgent } from "./bridge";
import { applyAgent, chatAgentsOf, isFinal, newAgentStore, sealAgents, type AgentBatch, type ChatAgents } from "./chat-agents";

export const sessionAgents = newAgentStore();

/** The Agent calls of a session not matched to an agent yet, oldest first: each one's kind and task. */
const calls = new Map<string, { kind: string; task: string }[]>();

/** How many prompts each session has had: the anchor of its agents' card. */
const prompts = new Map<string, number>();

/** The tool that starts an agent (Claude Code's Agent, Task before 2.1). */
export function startsAgent(tool: string): boolean {
  return tool === "Agent" || tool === "Task";
}

function update(session: string, agentId: string, change: (row: ChatAgent) => void): boolean {
  const row = sessionAgents.get(session)?.rows.get(agentId)?.row;
  if (!row || isFinal(row.state)) return false;
  const next = { ...row };
  change(next);
  return applyAgent(sessionAgents, { chat: session, agent: next }, prompts.get(session) ?? 0);
}

/** A new prompt of the session: the agents it starts get a card of their own. */
export function sessionPrompt(session: string) {
  if (!session) return;
  prompts.set(session, (prompts.get(session) ?? 0) + 1);
  sealAgents(sessionAgents, session);
  calls.delete(session);
}

/** The session's own Agent call: the task of the agent of that kind it starts next. */
export function sessionAgentCall(session: string, input: Record<string, unknown>) {
  if (!session) return;
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string).replace(/\s+/g, " ").trim() : "");
  const task = text("description") || text("prompt").slice(0, 80);
  const list = calls.get(session) ?? [];
  list.push({ kind: text("subagent_type") || "general-purpose", task });
  // An Agent call refused never starts its agent: never more than a few waiting.
  calls.set(session, list.slice(-8));
}

/** SubagentStart: a row, named after the call that started it (its kind's, else the first waiting). */
export function sessionAgentStarted(session: string, agentId: string, kind: string, now = Date.now()): boolean {
  if (!session || !agentId) return false;
  const list = calls.get(session) ?? [];
  const at = Math.max(0, list.findIndex((c) => c.kind === kind));
  const call = list.splice(at, 1)[0];
  const row: ChatAgent = {
    id: agentId, source: "claude-code", title: call?.task || kind || "Agent", state: "working", steps: 0,
    startedAt: now, lastSignalAt: now, background: false, canStop: false,
  };
  return applyAgent(sessionAgents, { chat: session, agent: row }, prompts.get(session) ?? 0);
}

/** One of its tools (PreToolUse with its `agent_id`): what it does now. False when Lumo never saw it start. */
export function sessionAgentTool(session: string, agentId: string, now: ChatActivity, at = Date.now()): boolean {
  return update(session, agentId, (row) => {
    row.now = now;
    row.steps += 1;
    row.lastSignalAt = at;
  });
}

/** SubagentStop: done, its last message the report. */
export function sessionAgentStopped(session: string, agentId: string, said: string, at = Date.now()): boolean {
  const report = said.replace(/\s+/g, " ").trim();
  return update(session, agentId, (row) => {
    row.state = "done";
    row.endedAt = at;
    row.lastSignalAt = at;
    if (report) row.summary = report;
    else row.noReport = true;
  });
}

/** The session ended: its agents still open ended with it. */
export function sessionEnded(session: string, at = Date.now()) {
  const c = sessionAgents.get(session);
  for (const e of c?.rows.values() ?? []) {
    if (!isFinal(e.row.state)) applyAgent(sessionAgents, { chat: session, agent: { ...e.row, state: "stopped", endedAt: at } }, 0);
  }
  calls.delete(session);
}

/** The session is gone from its pill: its agents too (a session resumed later starts with none). */
export function forgetSession(session: string) {
  sessionAgents.delete(session);
  calls.delete(session);
  prompts.delete(session);
}

/** The card the session card shows: its latest prompt's agents. Null with none. */
export function sessionCard(session: string | null | undefined): { chat: ChatAgents; batch: AgentBatch } | null {
  if (!session || !sessionAgents.has(session)) return null;
  const chat = chatAgentsOf(sessionAgents, session);
  const batch = chat.batches[chat.batches.length - 1];
  return batch ? { chat, batch } : null;
}
