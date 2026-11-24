// The Agents card: under the answer that started them, one row per agent a
// chat's CLI runs (concept: concepts/sotto-agenti, images 1 to 4).
//
// The header says how many are done, with one segment per agent in its
// colour (green done, blue at work, amber with no sign of life, purple
// waiting for the user, red failed or stopped), how long they have been at
// it, and a chevron that folds the rows. Each row says what its agent does
// now and when it was last heard of; a click opens it on the CLI's summary,
// its last steps and its numbers, with Stop this agent. An agent with no sign
// for minutes asks Wait or Stop; one waiting for a permission offers See
// request. An agent the chat's CLI can pass a message to offers Ask (in its
// opened row, and next to Wait); while a message waits for its answer, its
// row says it is in conversation, and the message and the answer show in a
// "Talking to …" box (talkBox). While any agent works a line of dots says
// how many and when the last sign came. Once all are over the card folds into one line that
// stays in the chat, and opens again with a click; if the CLI ended under
// them, a red line says so and offers Resume, which sends a message only on
// that click.
//
// Drawn from the store (core/chat-agents.ts) every time something changes:
// only the card is drawn again, never the chat around it. When only its words
// changed (the times, each second), they are written into the card as it is,
// so a button pressed or a summary being selected stays under the mouse.
// What the user opened or folded is kept per card; one agent is open at a time
// (its details or its picture), opening another folds it.

import { h, svg, clear } from "./dom";
import { agentSegments } from "./agent-segments";
import { ICONS } from "./icons";
import { MAX_SEGMENTS, planMarker, STRIP_TEXT } from "./plan-strip";
import { planFinished, planProgress, type PlanStep } from "../core/agent-plan";
import { isWatching, mountInline, toggleWatch, unwatchOthers, WATCH_TEXT, type InlineActions } from "./browser-watch";
import type { ChatActivity, ChatAgentRetry } from "../core/bridge";
import {
  AGENT_TEXT, agentStall, agentWriting, askable, browserOf, COMMAND_LIMIT_MIN, computerOf, batchEntries, countAgents, durationText, isFinal, lookOf, looksOf, runningCommand, snooze, talkWaits, toCheck,
  type AgentBatch, type AgentEntry, type AgentLook, type ChatAgents, type TalkEntry,
} from "../core/chat-agents";
import type { AskQuote } from "../core/chats";
import { providerDef } from "../core/providers";
import { N_, t, tn } from "../i18n/i18n";

export const AGENTS_CARD_TEXT = {
  title: N_("Agents"),
  doneOf: N_("{done} of {total} done"),
  noSignalCount: N_("{count} with no signal"),
  doneSummary: N_("Done: {summary}"),
  noSignal: N_("No signal for {time}"),
  noSignalStep: N_("No signal for {time} · last step: {step}"),
  permission: N_("Waiting for your permission"),
  rateLimit: N_("Waiting for the rate limit"),
  working: N_("Working…"),
  failed: N_("Failed"),
  stopped: N_("Stopped"),
  doneIn: N_("done in {time}"),
  ago: N_("{time} ago"),
  wait: N_("agents|Wait"),
  stop: N_("agents|Stop"),
  stopAll: N_("agents|Stop all"),
  answerStopped: N_("You stopped the answer: the agents in the background go on"),
  stopThem: N_("Stop them too"),
  seeRequest: N_("See request"),
  ended: N_("{name} ended: {count} agents stopped halfway"),
  /** What Rust says of an agent whose CLI ended under it (chat_agents.rs end_open). */
  cliEnded: N_("{agent} ended"),
  resume: N_("Resume"),
  finished: N_("{count} agents finished"),
  inTime: N_("in {time}"),
  lastSignal: N_("last signal {time} ago"),
  noSign: N_("{count} agents have given no sign for {time}"),
  others: N_("the others are working"),
  steps: N_("{count} steps"),
  tokens: N_("{tokens} tokens"),
  stopThis: N_("Stop this agent"),
  close: N_("Close"),
  /** Over an opened agent's last steps, under its plan. */
  latest: N_("Latest actions"),
  show: N_("Show the agents"),
  hide: N_("Hide the agents"),
  ask: N_("agents|Ask"),
  inConversation: N_("in conversation"),
  talking: N_("Talking to {name}"),
  waitingReply: N_("waiting for the reply… {time}"),
  notReached: N_("The message did not reach {name}"),
  noReply: N_("No reply came"),
  stoppedFirst: N_("Stopped before it answered"),
  stoppedAfter: N_("Stopped after {time}"),
  noReport: N_("Finished without a report"),
  inLine: N_("Waiting their turn"),
  noReportLast: N_("Finished without a report · «{text}»"),
  itsAgents: N_("Its agents: {done} of {count} finished"),
  inBackground: N_("In the background"),
  runningFor: N_("for {time}"),
  paused: N_("Paused"),
  queued: N_("Waiting its turn · {place} in line"),
  usesComputer: N_("uses the computer"),
  waitingComputer: N_("Waiting for the computer · {place} of {total} · {time}"),
  inLineComputer: N_("Waiting for the computer"),
  giveTurn: N_("Give it the turn"),
  /** The site the agent's hidden browser tab is on (browser.rs). */
  onSite: N_("on {host}"),
  /** Opens a live picture of the agent's browser tab under its row (views/browser-watch.ts). */
  watch: N_("agents|Watch"),
  /** Stop clicked: it goes after STOP_UNDO_MS, unless Undo takes it back. */
  stopping: N_("Stopping in {time}…"),
  undo: N_("agents|Undo"),
  /** Its CLI was asked to stop it and has not said it did yet. */
  halting: N_("Stopping it…"),
  /** Why an agent is quiet (concepts/segnale-agenti): a command of its at work, its writing, its request tried again. */
  runningCommand: N_("Running {command} · for {time}"),
  writing: N_("Writing its answer or a long file · for {time}"),
  retryOverloaded: N_("API overloaded: retrying in {time} (attempt {attempt} of {max})"),
  retryRateLimit: N_("Rate limit reached: retrying in {time} (attempt {attempt} of {max})"),
  retryFailed: N_("The request failed: retrying in {time} (attempt {attempt} of {max})"),
  retryNow: N_("Retrying the request (attempt {attempt} of {max})"),
  /** …and why it needs a look: its command past the limit, its silence with none, its CLI gone quiet. */
  overlong: N_("Command running for {time}, past the {limit} min limit"),
  silent: N_("No sign for {time}, no command running"),
  lost: N_("{agent} has not answered for {time}"),
  atWork: N_("{count} at work"),
  toCheck: N_("{count} to check"),
  agentsToCheck: N_("{count} agents to check"),
};

/**
 * What goes to the CLI for Resume: in English, as Ask's words (core/chat-agents.ts
 * agentAsk), since it is for the AI, which answers in the user's language.
 */
export function resumeAsk(name: string, titles: string[]): string {
  return `${name} ended while these agents were still working. Please resume their tasks where they stopped:\n${titles.map((x) => `- ${x}`).join("\n")}`;
}

// ── Stop, with Undo ───────────────────────────────────────────────────────────

/** How long a Stop waits before it goes: the row says so and offers Undo meanwhile. */
export const STOP_UNDO_MS = 4000;

/** The Stops clicked and not gone yet, by chat and agent: when each goes, and its timer. */
const stopping = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();

function stopKey(chatId: string, agentId: string): string {
  return `${chatId}\n${agentId}`;
}

/** The time left before a Stop clicked on the agent goes; null for none. */
export function stopPending(chatId: string, agentId: string, now = Date.now()): number | null {
  const s = stopping.get(stopKey(chatId, agentId));
  return s ? Math.max(0, s.at - now) : null;
}

/** Stop clicked: the agent stops in STOP_UNDO_MS, unless Undo comes first (its row offers it; the agents' browser view sends here too). */
export function stopLater(chatId: string, agentId: string, host: AgentsCardHost, redraw: () => void) {
  const key = stopKey(chatId, agentId);
  if (stopping.has(key)) return;
  const timer = setTimeout(() => {
    stopping.delete(key);
    host.stop(agentId);
    redraw();
  }, STOP_UNDO_MS);
  (timer as { unref?: () => void }).unref?.();
  stopping.set(key, { at: Date.now() + STOP_UNDO_MS, timer });
  redraw();
}

/** Undo: the Stop clicked on the agent never goes. */
function undoStop(chatId: string, agentId: string, redraw: () => void) {
  const key = stopKey(chatId, agentId);
  const s = stopping.get(key);
  if (!s) return;
  clearTimeout(s.timer);
  stopping.delete(key);
  redraw();
}

/** A key with its context ("agents|Wait"): its translation, else its English after the "|". */
function tc(key: string): string {
  const text = t(key);
  return text === key ? key.slice(key.indexOf("|") + 1) : text;
}

/** What the card needs from the chat around it. */
export interface AgentsCardHost {
  /** The words for what an agent is doing, as the typing line says them (chat.ts activityLabel). */
  label(activity: ChatActivity): string;
  /** Stops one agent alone (`chat_stop_agent`). */
  stop(agentId: string): void;
  /** Sends a message to the chat, as if typed: Resume. False when it could not go (a question being edited). */
  send(text: string): boolean;
  /** The agent the permission card on top asks for: its row offers See request. Null for none. */
  requestOnTop: string | null;
  /** Brings up the permission card the agent asks on. */
  seeRequest(agentId: string): void;
  /** Ask: puts the agent over the field as a quote; nothing is sent. None where the chat cannot ask (an edit under way). */
  ask?(quote: AskQuote): void;
  /** Give it the turn: the agent waiting for the computer goes first in line (`chat_computer_first`). */
  computerFirst?(agentId: string): void;
  /** Watch on the card can show the agents' browser tabs (views/browser-watch.ts): the chat on screen. */
  watchBrowser?: boolean;
  /** The card changed: its height, or its state worth saving. */
  changed(): void;
}

/** What one card draws. */
export interface AgentsCardInput {
  chatId: string;
  chat: ChatAgents;
  batch: AgentBatch;
  /** The agents a permission card waits on (core/chat-agents.ts permissionMatch). */
  permission?: ReadonlySet<string>;
  /** The user stopped the chat's answer while these agents worked on: the live line says they go on. */
  answerStopped?: boolean;
  now?: number;
}

/** What the user opened or folded in one card, kept across its redraws. */
interface CardUi {
  /** Rows folded away (the chevron), while agents work. */
  collapsed: boolean;
  /** Opened again after it folded into one line. */
  unfolded: boolean;
  /** The rows opened on their details. */
  open: Set<string>;
  /** This drawing's watched rows and what their picture can do (fillAgentsCard mounts it). */
  watched?: Map<string, InlineActions>;
}

const uis = new Map<string, CardUi>();

/** What each card was last drawn from: its buttons act on the newest, not on what was known when they were made. */
const latest = new WeakMap<HTMLElement, { input: AgentsCardInput; host: AgentsCardHost }>();

function uiOf(key: string): CardUi {
  let ui = uis.get(key);
  if (!ui) {
    ui = { collapsed: false, unfolded: false, open: new Set() };
    uis.set(key, ui);
    // The island lives for days: the oldest cards' state goes.
    if (uis.size > 200) uis.delete(uis.keys().next().value!);
  }
  return ui;
}

/** The card's key: its chat and the answer it is under. */
export function agentsCardKey(chatId: string, batch: AgentBatch): string {
  return `${chatId}:${batch.anchor}`;
}

/** A new card, drawn. Draw it again with `fillAgentsCard` when its agents change. */
export function agentsCard(input: AgentsCardInput, host: AgentsCardHost): HTMLElement {
  const el = h("div", { class: "agents" });
  fillAgentsCard(el, input, host);
  return el;
}

/** One segment per agent, in its colour. */
function segments(looks: string[]): HTMLElement {
  return agentSegments(looks);
}

/** One line of the tree, at `level` (a row's own: to its starter, its tick, ending at it when it is the last). */
function guide(level: number, cls: string): HTMLElement {
  const el = h("i", { class: `agents-guide${cls}` });
  el.style.setProperty("--level", String(level));
  return el;
}

/** A small button of the card; its click goes no further (the row would open). */
function cardButton(cls: string, text: string, run: () => void): HTMLElement {
  return h("button", {
    class: `agents-btn ${cls}`,
    text,
    onclick: (e: Event) => {
      e.stopPropagation();
      run();
    },
  });
}

/**
 * The conversation's own browser tab (agent "main", browser.rs), next to the
 * typing dots, as an agent's is on its row: the site it is on, and Watch.
 * The conversation has no row of its own. Null when it has no tab.
 */
export function mainBrowser(chatId: string, watch: () => void): HTMLElement | null {
  // Watch: the agents' browser, on the conversation's tab (it has no row to open under).
  const tab = browserOf(chatId, "main");
  if (!tab) return null;
  const site = tab.host ? h("span", { class: "agents-badge browser", text: t(AGENTS_CARD_TEXT.onSite, { host: tab.host }), title: tab.title || tab.host }) : null;
  return h("span", { class: "typing-browser" }, ...(site ? [site] : []), cardButton("watch", tc(AGENTS_CARD_TEXT.watch), watch));
}

function chevron(down: boolean, title: string): HTMLElement {
  return h("span", { class: down ? "agents-chev down" : "agents-chev", title, "aria-label": title }, svg(ICONS.chevronUp, 12, { stroke: 1.8 }));
}

/** Whether an agent failed because what ran it ended under it: its CLI (Rust says so), or Lumo closing. */
function cliEnded(e: AgentEntry): boolean {
  return e.row.state === "failed" && (e.row.endedBy === "cli" || e.row.endedBy === "lumo");
}

/** The agents ended under their work, with what ended: their CLI ("Claude Code ended"), else Lumo. */
function endedByCli(entries: AgentEntry[]): { name: string; entries: AgentEntry[] } | null {
  const ended = entries.filter(cliEnded);
  if (!ended.length) return null;
  const cli = ended.find((e) => e.row.endedBy === "cli" && e.row.source);
  return { name: cli ? t(providerDef(cli.row.source).name) : "Lumo", entries: ended };
}

/**
 * Draws the card in `el`, from what the store holds now. Drawn the same but
 * for its words (the times, as each second goes), the card stays as it is and
 * only its words change: a click whose press and release fall either side of
 * a redraw still lands, and a selection in an opened row stays.
 */
export function fillAgentsCard(el: HTMLElement, input: AgentsCardInput, host: AgentsCardHost) {
  latest.set(el, { input, host });
  const fresh = h("div");
  const watched = new Map<string, InlineActions>();
  drawCard(fresh, el, input, host, watched);
  if (sameShape(el, fresh)) {
    copyWords(el, fresh);
  } else {
    clear(el);
    el.append(...Array.from(fresh.childNodes));
  }
  // The picture under a watched row: the same one, wherever the row is drawn.
  if (!watched.size) return;
  for (const slot of Array.from(el.querySelectorAll<HTMLElement>(".bw-slot"))) {
    const agentId = slot.getAttribute("data-agent") ?? "";
    const acts = watched.get(agentId);
    if (acts) mountInline(slot, input.chatId, agentId, acts);
  }
}

/** The class of an element, as a string also for an SVG one. */
function classOf(e: Element): string {
  return typeof e.className === "string" ? e.className : e.getAttribute("class") ?? "";
}

/** Whether `a` and `b` hold the same elements, with the same classes, in the same places: only their words may differ. */
function sameShape(a: Element, b: Element): boolean {
  if (a.childNodes.length !== b.childNodes.length) return false;
  for (let i = 0; i < a.childNodes.length; i++) {
    const x = a.childNodes[i];
    const y = b.childNodes[i];
    if (x.nodeType !== y.nodeType) return false;
    if (x.nodeType !== 1) continue;
    const ex = x as Element;
    const ey = y as Element;
    if (ex.tagName !== ey.tagName || classOf(ex) !== classOf(ey)) return false;
    // A watched agent's picture (views/browser-watch.ts) is its own: only its place counts.
    if (classOf(ex) === "bw-slot" ? ex.getAttribute("data-agent") !== ey.getAttribute("data-agent") : !sameShape(ex, ey)) return false;
  }
  return true;
}

/** Writes the words of `from` (its texts, tooltips and inline values such as a plan's fill) into `to`, of the same shape. */
function copyWords(to: Element, from: Element) {
  for (const attr of ["title", "aria-label", "style"]) {
    const v = from.getAttribute(attr);
    if (v == null) to.removeAttribute(attr);
    else if (to.getAttribute(attr) !== v) to.setAttribute(attr, v);
  }
  if (classOf(to) === "bw-slot") return;
  for (let i = 0; i < to.childNodes.length; i++) {
    const x = to.childNodes[i];
    const y = from.childNodes[i];
    if (x.nodeType === 3) {
      const text = (y as Text).data;
      if ((x as Text).data !== text) (x as Text).data = text;
    } else if (x.nodeType === 1) copyWords(x as Element, y as Element);
  }
}

/** Draws the card into `into`; `el` is the card itself, which its buttons draw again. */
function drawCard(into: HTMLElement, el: HTMLElement, input: AgentsCardInput, given: AgentsCardHost, watched: Map<string, InlineActions>) {
  const now = input.now ?? Date.now();
  // From the newest input and host: a button drawn a while ago acts on what is known now.
  const current = () => latest.get(el) ?? { input, host: given };
  const host: AgentsCardHost = {
    label: given.label,
    requestOnTop: given.requestOnTop,
    stop: (id) => current().host.stop(id),
    send: (text) => current().host.send(text),
    seeRequest: (id) => current().host.seeRequest(id),
    ask: given.ask ? (quote) => current().host.ask?.(quote) : undefined,
    computerFirst: given.computerFirst ? (id) => current().host.computerFirst?.(id) : undefined,
    watchBrowser: given.watchBrowser,
    changed: () => current().host.changed(),
  };
  const key = agentsCardKey(input.chatId, input.batch);
  const ui = uiOf(key);
  const entries = batchEntries(input.chat, input.batch);
  const counts = countAgents(entries, now, input.permission);
  const allOver = counts.open === 0;
  const redraw = () => {
    const last = current();
    fillAgentsCard(el, last.input, last.host);
    last.host.changed();
  };
  if (entries.length === 0) return;
  ui.watched = watched;

  const ended = allOver ? endedByCli(entries) : null;
  if (ended && !input.batch.resumed) {
    into.append(endedBanner(ended, () => current().input, host, ui, redraw));
    if (ui.unfolded) into.append(h("div", { class: "agents-card" }, rows(entries, input, host, ui, now, redraw)));
  } else if (allOver && !ui.unfolded) {
    into.append(foldedLine(entries, now, input.permission, () => {
      ui.unfolded = true;
      redraw();
    }));
  } else {
    into.append(fullCard(entries, input, host, ui, now, redraw));
  }
  if (!allOver) {
    const stoppable = stoppableOf(entries, input.chatId, now);
    const stopThem = input.answerStopped && stoppable.length ? () => stopEach(stoppable, input.chatId, host, redraw) : null;
    into.append(liveLine(entries, now, input.permission, stopThem));
  }
}

/** The agents at work the user can still stop (no Stop under way on them). */
function stoppableOf(entries: AgentEntry[], chatId: string, now: number): AgentEntry[] {
  return entries.filter((e) => !isFinal(e.row.state) && e.row.canStop && !e.row.stopping && stopPending(chatId, e.row.id, now) == null);
}

/** Stop all, Stop them too: each agent as its own Stop does, Undo on each row. */
function stopEach(entries: AgentEntry[], chatId: string, host: AgentsCardHost, redraw: () => void) {
  for (const e of entries) stopLater(chatId, e.row.id, host, redraw);
}

/** The header and the rows. */
function fullCard(entries: AgentEntry[], input: AgentsCardInput, host: AgentsCardHost, ui: CardUi, now: number, redraw: () => void): HTMLElement {
  const counts = countAgents(entries, now, input.permission);
  const allOver = counts.open === 0;
  const started = Math.min(...entries.map((e) => e.row.startedAt || now));
  const ended = allOver ? Math.max(...entries.map((e) => e.row.endedAt ?? e.row.lastSignalAt ?? now)) : now;
  // Some need a look: how many work, and how many of them to check (concepts/segnale-agenti).
  const status = counts.stalled
    ? `${tn("{count} at work", AGENTS_CARD_TEXT.atWork, counts.open)} · ${tn("{count} to check", AGENTS_CARD_TEXT.toCheck, counts.stalled)}`
    : t(AGENTS_CARD_TEXT.doneOf, { done: counts.done, total: counts.total });
  // Folded rows show again with the chevron; once all are over it folds the card into one line.
  const folded = !allOver && ui.collapsed;
  // Two or more at work: Stop all, each with its Undo.
  const stoppable = stoppableOf(entries, input.chatId, now);
  const stopAll = stoppable.length >= 2 ? cardButton("stop", tc(AGENTS_CARD_TEXT.stopAll), () => stopEach(stoppable, input.chatId, host, redraw)) : null;
  const head = h("div", { class: "agents-head" },
    h("span", { class: "agents-title", text: t(AGENTS_CARD_TEXT.title) }),
    h("span", { class: "agents-status", text: status }),
    segments(segmentLooks(entries, now, input.permission)),
    h("span", { class: "agents-gap" }),
    stopAll,
    h("span", { class: "agents-time", text: durationText(ended - started) }),
    chevron(folded, t(folded ? AGENTS_CARD_TEXT.show : AGENTS_CARD_TEXT.hide)));
  head.addEventListener("click", () => {
    if (allOver) ui.unfolded = false;
    else ui.collapsed = !ui.collapsed;
    redraw();
  });
  const card = h("div", { class: "agents-card" }, head);
  if (!folded) card.append(rows(entries, input, host, ui, now, redraw));
  return card;
}

function rows(entries: AgentEntry[], input: AgentsCardInput, host: AgentsCardHost, ui: CardUi, now: number, redraw: () => void): HTMLElement {
  const all = nested(entries);
  const list = folded(all, ui.open);
  const guides = treeGuides(list.map(([, depth]) => depth));
  const kids = childCounts(all);
  // A starter whose agents are out of sight says how many.
  const shown = new Set(list.map(([e]) => e.row.id));
  for (const [e] of all) {
    const c = e.row.parent ? kids.get(e.row.parent) : undefined;
    if (c && !shown.has(e.row.id)) c.folded = true;
  }
  return h("div", { class: "agents-rows" }, ...list.map(([e, depth], i) => row(e, input, host, ui, now, redraw, depth, guides[i], kids.get(e.row.id))));
}

/** How many agents an agent started, and how many of them finished. */
export interface ChildCount {
  done: number;
  count: number;
  /** They are folded under it. */
  folded?: boolean;
}

/** Each starter's own agents (those right under it), by its id. */
function childCounts(list: [AgentEntry, number][]): Map<string, ChildCount> {
  const out = new Map<string, ChildCount>();
  const ids = new Set(list.map(([e]) => e.row.id));
  for (const [e] of list) {
    const parent = e.row.parent;
    if (!parent || parent === e.row.id || !ids.has(parent)) continue;
    const c = out.get(parent) ?? { done: 0, count: 0 };
    c.count++;
    if (isFinal(e.row.state)) c.done++;
    out.set(parent, c);
  }
  return out;
}

/**
 * The tree with the finished branches folded: an agent that ended with all
 * the agents under it ended keeps them out of sight, until its row is opened.
 */
export function folded(list: [AgentEntry, number][], open: ReadonlySet<string>): [AgentEntry, number][] {
  const out: [AgentEntry, number][] = [];
  for (let i = 0; i < list.length; i++) {
    const [e, depth] = list[i];
    out.push(list[i]);
    let end = i + 1;
    while (end < list.length && list[end][1] > depth) end++;
    const under = list.slice(i + 1, end);
    // An agent opened inside the branch keeps it unfolded, so its row and its details show.
    if (under.length && !open.has(e.row.id) && !under.some(([u]) => open.has(u.row.id)) && isFinal(e.row.state) && under.every(([u]) => isFinal(u.row.state))) i = end - 1;
  }
  return out;
}

/** The lines of the tree on one row: the levels whose line goes on through it, and whether it is its starter's last. */
export interface TreeGuides {
  through: number[];
  last: boolean;
}

/**
 * The tree's lines, from each row's depth in the order they show: a line
 * runs from a starter down to its last agent, through the rows of the
 * agents those start in turn.
 */
export function treeGuides(depths: number[]): TreeGuides[] {
  const goesOn: boolean[] = [];
  return depths.map((d, i) => {
    let last = true;
    for (let j = i + 1; j < depths.length; j++) {
      if (depths[j] < d) break;
      if (depths[j] === d) {
        last = false;
        break;
      }
    }
    const through: number[] = [];
    for (let k = 1; k < d; k++) if (goesOn[k]) through.push(k);
    goesOn.length = d + 1;
    goesOn[d] = !last;
    return { through, last: d > 0 && last };
  });
}

/**
 * A quieter look within an agent's own: grey for one nothing is asked of the
 * user for (in line for the rate limit or its turn, paused, stopped), dimmed
 * for one done without a report of its own.
 */
export function shadeOf(e: AgentEntry, look: AgentLook, permission?: ReadonlySet<string>, now = Date.now()): "queued" | "paused" | "stopped" | "noreport" | "lost" | null {
  const r = e.row;
  if (look === "waiting" && !permission?.has(r.id) && !computerOf(r.id)?.waits) {
    if (r.waitingFor === "paused") return "paused";
    if (r.waitingFor === "rate_limit" || r.waitingFor === "queue" || r.waitingFor === "retry") return "queued";
  }
  // Its CLI no longer answers: in red, not amber.
  if (look === "stalled" && agentStall(e, now)?.why === "lost") return "lost";
  if (r.state === "stopped") return "stopped";
  if (r.state === "done" && r.noReport) return "noreport";
  return null;
}

/** Each agent's segment in the header: grey for those nothing is asked of the user for. */
function segmentLooks(entries: AgentEntry[], now: number, permission?: ReadonlySet<string>): string[] {
  return entries.map((e) => {
    const look = lookOf(e, now, permission);
    const shade = shadeOf(e, look, permission, now);
    return shade === "lost" ? "failed" : shade && shade !== "noreport" ? "queued" : look;
  });
}

/** Deepest an agent started by another one is set in under it. */
const MAX_DEPTH = 3;

/**
 * The rows in the order they show: each agent an agent started right under
 * it, after its brothers started before (concepts/agy-sotto-agenti-annidati),
 * with how deep it is; one whose starter isn't on the card stays in its place.
 */
export function nested(entries: AgentEntry[]): [AgentEntry, number][] {
  const ids = new Set(entries.map((e) => e.row.id));
  const kids = new Map<string, AgentEntry[]>();
  for (const e of entries) {
    const parent = e.row.parent;
    if (parent && parent !== e.row.id && ids.has(parent)) kids.set(parent, [...(kids.get(parent) ?? []), e]);
  }
  const out: [AgentEntry, number][] = [];
  const seen = new Set<string>();
  const add = (e: AgentEntry, depth: number) => {
    if (seen.has(e.row.id)) return;
    seen.add(e.row.id);
    out.push([e, Math.min(depth, MAX_DEPTH)]);
    for (const k of kids.get(e.row.id) ?? []) add(k, depth + 1);
  };
  for (const e of entries) {
    const parent = e.row.parent;
    if (!parent || parent === e.row.id || !ids.has(parent)) add(e, 0);
  }
  // A loop of starters (never sent, but never lost either).
  for (const e of entries) add(e, 0);
  return out;
}

/** An agent's plan on its row: the chat's plan chip, a segment per step and how many are done. */
function planChip(plan: PlanStep[]): HTMLElement {
  const { done, total } = planProgress(plan);
  const segs = h("span", { class: "plan-chip-segs", "aria-hidden": "true" });
  if (total <= MAX_SEGMENTS) for (const s of plan) segs.append(h("i", { class: s.status }));
  else {
    segs.classList.add("bar");
    const bar = h("i", { class: "fill" });
    bar.style.setProperty("--k", String(total ? done / total : 0));
    segs.append(bar);
  }
  const status = planFinished(plan) ? t(STRIP_TEXT.done) : t(STRIP_TEXT.stepOf, { done, total });
  const chip = h("span", { class: `plan-chip agents-plan-chip${planFinished(plan) ? " finished" : ""}`, title: `${t(STRIP_TEXT.title)} · ${status}` },
    segs, h("span", { class: "plan-chip-count", text: `${done}/${total}` }));
  return chip;
}

/** An opened agent's plan: its steps, as the chat's plan lists them. */
function planList(plan: PlanStep[]): HTMLElement {
  const { done, total } = planProgress(plan);
  return h("div", { class: "agents-plan" },
    h("div", { class: "plan-strip-head" },
      h("span", { class: "plan-strip-head-title", text: t(STRIP_TEXT.title) }),
      h("span", { class: "plan-strip-head-count", text: planFinished(plan) ? t(STRIP_TEXT.done) : t(STRIP_TEXT.stepOf, { done, total }) })),
    h("div", { class: "agent-plan" }, ...plan.map((s) =>
      h("div", { class: `plan-step plan-strip-item ${s.status}` }, planMarker(s), h("span", { class: "plan-text", text: s.text })))));
}

/** What a row says next to its title. */
function rowLine(e: AgentEntry, look: AgentLook, host: AgentsCardHost, now: number, kids?: ChildCount): string {
  const r = e.row;
  switch (look) {
    case "done":
      // Its last words when they were no report: said as such.
      if (r.noReport) return r.summary ? t(AGENTS_CARD_TEXT.noReportLast, { text: r.summary }) : t(AGENTS_CARD_TEXT.noReport);
      return r.summary ? t(AGENTS_CARD_TEXT.doneSummary, { summary: r.summary }) : t("Done");
    case "failed":
      if (r.error) return r.error;
      if (r.state === "stopped") return r.endedAt && r.startedAt ? t(AGENTS_CARD_TEXT.stoppedAfter, { time: durationText(r.endedAt - r.startedAt) }) : t(AGENTS_CARD_TEXT.stopped);
      return t(AGENTS_CARD_TEXT.failed);
    case "waiting": {
      if (r.waitingFor === "queue") return t(AGENTS_CARD_TEXT.queued, { place: r.queue ?? 1 });
      if (r.waitingFor === "retry" && r.retry) return retryLine(r.retry, now);
      if (r.waitingFor === "paused") return t(AGENTS_CARD_TEXT.paused);
      const pc = computerOf(r.id);
      if (pc?.waits && r.state !== "waiting") {
        return t(AGENTS_CARD_TEXT.waitingComputer, { place: pc.place, total: pc.of, time: durationText(now - pc.since) });
      }
      return t(r.waitingFor === "rate_limit" ? AGENTS_CARD_TEXT.rateLimit : AGENTS_CARD_TEXT.permission);
    }
    case "stalled": {
      const stall = agentStall(e, now);
      const time = durationText((stall?.seconds ?? 0) * 1000);
      if (stall?.why === "lost") return t(AGENTS_CARD_TEXT.lost, { agent: providerDef(r.source)?.name ?? r.source, time });
      if (stall?.why === "overlong") return t(AGENTS_CARD_TEXT.overlong, { time, limit: COMMAND_LIMIT_MIN });
      const last = e.steps[0]?.now ?? r.now;
      // A call of its waits for its result (not a command): which one, said.
      if (r.inCall && last) return t(AGENTS_CARD_TEXT.noSignalStep, { time, step: host.label(last) });
      return t(AGENTS_CARD_TEXT.silent, { time });
    }
    default: {
      // A starter whose agents work: how far along they are, more than its own waiting on them.
      if (kids && kids.done < kids.count) return t(AGENTS_CARD_TEXT.itsAgents, { done: kids.done, count: kids.count });
      const quiet = quietLine(e, now);
      if (quiet) return quiet;
      return r.now ? host.label(r.now) : r.summary || t(AGENTS_CARD_TEXT.working);
    }
  }
}

/** A working agent's silence said for what it is: the command it waits on, or its writing (concepts/segnale-agenti). */
function quietLine(e: AgentEntry, now: number): string | null {
  const command = runningCommand(e);
  // Its own command, worded by its CLI: said at once, with how long it has run.
  if (command && e.row.running) return t(AGENTS_CARD_TEXT.runningCommand, { command: command.text, time: durationText(now - command.since) });
  const writing = agentWriting(e, now);
  return writing != null ? t(AGENTS_CARD_TEXT.writing, { time: durationText(writing * 1000) }) : null;
}

/** Its request tried again: why, in how long, which try. */
function retryLine(r: ChatAgentRetry, now: number): string {
  const vars = { attempt: r.attempt, max: r.max || r.attempt };
  const left = r.at + r.delayMs - now;
  if (left <= 0) return t(AGENTS_CARD_TEXT.retryNow, vars);
  const time = durationText(left + 999);
  const category = (r.category ?? "").toLowerCase();
  if (r.status === 529 || category.includes("overload")) return t(AGENTS_CARD_TEXT.retryOverloaded, { ...vars, time });
  if (r.status === 429 || category.includes("rate")) return t(AGENTS_CARD_TEXT.retryRateLimit, { ...vars, time });
  return t(AGENTS_CARD_TEXT.retryFailed, { ...vars, time });
}

/** One agent: its marker, its task, what it does, and its time or what can be done about it. */
function row(e: AgentEntry, input: AgentsCardInput, host: AgentsCardHost, ui: CardUi, now: number, redraw: () => void, depth = 0, guides?: TreeGuides, kids?: ChildCount): HTMLElement {
  const r = e.row;
  // Its CLI was asked to stop it: until it says it did, the row says so and offers no Stop.
  const halting = !isFinal(r.state) && !!r.stopping;
  const look = lookOf(e, now, input.permission);
  const shade = halting ? null : shadeOf(e, look, input.permission, now);
  const marker = look === "done"
    ? h("span", { class: "agents-mark done" }, svg(ICONS.check, 12, { stroke: 2.2 }))
    : h("span", { class: `agents-mark ${halting ? "stopping" : shade && shade !== "noreport" ? shade : look}` }, h("i"));
  const left = isFinal(r.state) || halting ? null : stopPending(input.chatId, r.id, now);
  const line = halting ? t(AGENTS_CARD_TEXT.halting)
    : left != null ? t(AGENTS_CARD_TEXT.stopping, { time: durationText(left + 999) }) : rowLine(e, look, host, now, kids);
  // Its finished agents folded under it: how many, until it is opened.
  const fold = kids?.folded ? tn("{count} agent finished", AGENTS_CARD_TEXT.finished, kids.count) : "";
  const side = h("span", { class: "agents-side" });
  // Its own plan, when it wrote one: how far along it is, before its time.
  if (r.plan?.length && left == null) side.append(planChip(r.plan));
  const ask = canAsk(e, host) && left == null ? () => host.ask!({ agentId: r.id, title: r.title, line, look }) : null;
  const stop = halting ? null : () => stopLater(input.chatId, r.id, host, redraw);
  // A tab it browses in, while it is at work: Watch shows it under the row, Hide closes it.
  const tab = isFinal(r.state) ? undefined : browserOf(input.chatId, r.id);
  const watch = tab && host.watchBrowser && left == null ? () => {
    toggleWatch(input.chatId, r.id);
    // One agent open at a time: its picture folds the others' rows.
    if (isWatching(input.chatId, r.id)) onlyOpen(ui, input.chatId, r.id);
    redraw();
  } : null;
  const watching = !!watch && isWatching(input.chatId, r.id);
  const watchButton = () => cardButton(watching ? "watch on" : "watch", tc(watching ? WATCH_TEXT.hide : AGENTS_CARD_TEXT.watch), watch!);
  if (left != null) {
    // Stop clicked: Undo until it goes.
    side.append(cardButton("undo", tc(AGENTS_CARD_TEXT.undo), () => undoStop(input.chatId, r.id, redraw)));
  } else if (look === "stalled" && shade === "lost") {
    // Its CLI no longer answers: nothing to ask, nothing to wait for.
    if (r.canStop && stop) side.append(cardButton("stop", tc(AGENTS_CARD_TEXT.stop), stop));
  } else if (look === "stalled") {
    if (ask) side.append(cardButton("ask", tc(AGENTS_CARD_TEXT.ask), ask));
    side.append(cardButton("wait", tc(AGENTS_CARD_TEXT.wait), () => {
      // From the click: the button may have been drawn a while before.
      snooze(e);
      redraw();
    }));
    if (r.canStop && stop) side.append(cardButton("stop", tc(AGENTS_CARD_TEXT.stop), stop));
  } else if (look === "waiting") {
    // Only on the row whose card is the one up: not while Claude Code checks a call itself (no card), nor for another's card.
    if (r.waitingFor !== "rate_limit" && input.permission?.has(r.id) && host.requestOnTop === r.id) {
      side.append(cardButton("see", t(AGENTS_CARD_TEXT.seeRequest), () => host.seeRequest(r.id)));
    }
    // In line for the computer, behind another: Give it the turn.
    const pc = computerOf(r.id);
    if (pc?.waits && pc.place > 1 && host.computerFirst) {
      side.append(cardButton("first", t(AGENTS_CARD_TEXT.giveTurn), () => host.computerFirst!(r.id)));
    }
    if (watch) side.append(watchButton());
  } else if (look === "done") {
    side.append(h("span", { class: "agents-time", text: t(AGENTS_CARD_TEXT.doneIn, { time: durationText((r.endedAt ?? now) - r.startedAt) }) }));
  } else if (look === "failed") {
    if (r.endedAt) side.append(h("span", { class: "agents-time", text: durationText(r.endedAt - r.startedAt) }));
  } else {
    if (watch) side.append(watchButton());
    // Its line says already since when it is quiet, and why: only how long it has worked.
    const quiet = look === "working" && quietLine(e, now) != null;
    side.append(h("span", { class: "agents-time", text: quiet ? durationText(now - r.startedAt) : `${durationText(now - r.startedAt)} · ${t(AGENTS_CARD_TEXT.ago, { time: durationText(now - r.lastSignalAt) })}` }));
  }
  const open = ui.open.has(r.id);
  const talking = r.talk && talkWaits(r.talk)
    ? h("span", { class: "agents-badge talk", text: t(AGENTS_CARD_TEXT.inConversation) })
    : null;
  const computer = !isFinal(r.state) && computerOf(r.id)?.holds
    ? h("span", { class: "agents-badge computer", text: t(AGENTS_CARD_TEXT.usesComputer) })
    : null;
  const site = tab?.host ? h("span", { class: "agents-badge browser", text: t(AGENTS_CARD_TEXT.onSite, { host: tab.host }), title: tab.title || tab.host }) : null;
  const head = h("div", { class: "agents-row-head" },
    marker,
    h("span", { class: "agents-name", text: r.title, title: r.title }),
    ...(talking ? [talking] : []),
    ...(computer ? [computer] : []),
    ...(site ? [site] : []),
    h("span", { class: "agents-line", text: fold ? `${fold} · ${line}` : line, title: line }),
    side);
  const el = h("div", { class: `agents-row ${look}${shade ? ` ${shade}` : ""}${halting ? " stopping" : ""}${open ? " open" : ""}${watching ? " watching" : ""}${depth ? " child" : ""}` }, head);
  if (depth) {
    el.style.setProperty("--depth", String(depth));
    // The tree's lines: those of the starters above that go on, and its own to its starter.
    for (const level of guides?.through ?? []) el.append(guide(level, ""));
    el.append(guide(depth, guides?.last ? " own last" : " own"));
  }
  head.addEventListener("click", () => {
    if (open) ui.open.delete(r.id);
    else {
      // One agent open at a time: the others fold, and another's picture closes.
      onlyOpen(ui, input.chatId, r.id);
      ui.open.add(r.id);
    }
    redraw();
  });
  if (watching) {
    // The live picture of its tab (views/browser-watch.ts), put in after the card is drawn.
    el.append(h("div", { class: "bw-slot", "data-agent": r.id }));
    ui.watched?.set(r.id, { ask, stop: r.canStop && left == null ? stop : null });
  }
  if (open) el.append(rowDetail(e, host, ui, now, redraw, ask, left == null ? stop : null, watch ? watchButton : null));
  return el;
}

/** The last actions an opened agent with a plan shows under it. */
const PLANNED_STEPS = 3;

/** Opening `agentId` folds every other agent of the card: their details and their picture. */
function onlyOpen(ui: CardUi, chatId: string, agentId: string) {
  for (const id of [...ui.open]) if (id !== agentId) ui.open.delete(id);
  unwatchOthers(chatId, agentId);
}

/** Whether Ask shows on an agent: its CLI can pass it a message, and the chat can ask now. */
function canAsk(e: AgentEntry, host: AgentsCardHost): boolean {
  return !!host.ask && askable(e) && !cliEnded(e);
}

/** An opened row: the CLI's summary, the last steps, the numbers, Watch for its browser tab, and Stop this agent. */
function rowDetail(
  e: AgentEntry, host: AgentsCardHost, ui: CardUi, now: number, redraw: () => void, ask: (() => void) | null, stop: (() => void) | null, watch: (() => HTMLElement) | null,
): HTMLElement {
  const r = e.row;
  const box = h("div", { class: "agents-detail" });
  if (r.summary) box.append(h("div", { class: "agents-summary", text: r.summary }));
  if (r.error && r.error !== r.summary) box.append(h("div", { class: "agents-summary failed", text: r.error }));
  // Its plan, then its last few actions under it.
  const plan = r.plan?.length ? r.plan : null;
  if (plan) box.append(planList(plan));
  // The commands it left running, each since when.
  const commands = r.commands ?? [];
  if (commands.length) {
    box.append(h("div", { class: "agents-numbers", text: t(AGENTS_CARD_TEXT.inBackground) }));
    box.append(h("div", { class: "agents-steps agents-commands" }, ...commands.map((c) =>
      h("div", { class: "agents-step" },
        h("span", { class: "agents-step-what" }, h("code", { class: "agents-command", text: c.text, title: c.text })),
        h("span", { class: "agents-time", text: t(AGENTS_CARD_TEXT.runningFor, { time: durationText(now - c.since) }) })))));
  }
  const steps = plan ? e.steps.slice(0, PLANNED_STEPS) : e.steps;
  if (steps.length) {
    if (plan || commands.length) box.append(h("div", { class: "agents-numbers", text: t(AGENTS_CARD_TEXT.latest) }));
    box.append(h("div", { class: "agents-steps" }, ...steps.map((s) =>
      h("div", { class: "agents-step" },
        h("span", { class: "agents-step-what", text: host.label(s.now) }),
        h("span", { class: "agents-time", text: t(AGENTS_CARD_TEXT.ago, { time: durationText(now - s.at) }) })))));
  }
  const numbers = [
    tn("{count} step", AGENTS_CARD_TEXT.steps, r.steps),
    r.tokens != null ? t(AGENTS_CARD_TEXT.tokens, { tokens: compactNumber(r.tokens) }) : null,
    durationText((isFinal(r.state) ? r.endedAt ?? now : now) - r.startedAt),
  ].filter((x): x is string => !!x);
  box.append(h("div", { class: "agents-numbers", text: numbers.join(" · ") }));
  const actions = h("div", { class: "agents-actions" });
  if (ask) actions.append(cardButton("ask", tc(AGENTS_CARD_TEXT.ask), ask));
  if (watch) actions.append(watch());
  if (r.canStop && !isFinal(r.state) && stop) actions.append(cardButton("stop", t(AGENTS_CARD_TEXT.stopThis), stop));
  actions.append(cardButton("close", t(AGENTS_CARD_TEXT.close), () => {
    ui.open.delete(r.id);
    redraw();
  }));
  box.append(actions);
  return box;
}

/** 212000 → "212K" in English, as the language writes it. */
function compactNumber(n: number): string {
  try {
    return new Intl.NumberFormat(document.documentElement?.lang || undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
  } catch {
    return String(n);
  }
}

/** All over: one line that stays in the chat (concept 4); a click opens the card again. */
function foldedLine(entries: AgentEntry[], now: number, permission: ReadonlySet<string> | undefined, open: () => void): HTMLElement {
  const started = Math.min(...entries.map((e) => e.row.startedAt || now));
  const ended = Math.max(...entries.map((e) => e.row.endedAt ?? e.row.lastSignalAt ?? now));
  const done = entries.every((e) => e.row.state === "done");
  const el = h("div", { class: "agents-card agents-folded" },
    done ? h("span", { class: "agents-mark done" }, svg(ICONS.check, 12, { stroke: 2.2 })) : h("span", { class: "agents-mark failed" }, h("i")),
    h("span", { class: "agents-title", text: tn("{count} agent finished", AGENTS_CARD_TEXT.finished, entries.length) }),
    h("span", { class: "agents-status", text: t(AGENTS_CARD_TEXT.inTime, { time: durationText(ended - started) }) }),
    h("span", { class: "agents-gap" }),
    segments(looksOf(entries, now, permission)),
    chevron(true, t(AGENTS_CARD_TEXT.show)));
  el.addEventListener("click", open);
  return el;
}

/** The CLI ended under its agents: a red line, and Resume. */
function endedBanner(ended: { name: string; entries: AgentEntry[] }, current: () => AgentsCardInput, host: AgentsCardHost, ui: CardUi, redraw: () => void): HTMLElement {
  const resume = cardButton("resume", t(AGENTS_CARD_TEXT.resume), () => {
    // The agents that ended halfway as the store has them now (the line may have been drawn before one more did).
    const input = current();
    const halfway = endedByCli(batchEntries(input.chat, input.batch)) ?? ended;
    // Not sent (a question being edited, one being prepared): the line stays, Resume with it.
    if (!host.send(resumeAsk(halfway.name, halfway.entries.map((e) => e.row.title)))) return;
    input.batch.resumed = true;
    redraw();
  });
  const el = h("div", { class: "agents-card agents-ended" },
    h("span", { class: "agents-title", text: t(AGENTS_CARD_TEXT.title) }),
    h("span", { class: "agents-ended-text", text: tn("{name} ended: {count} agent stopped halfway", AGENTS_CARD_TEXT.ended, ended.entries.length, { name: ended.name }) }),
    h("span", { class: "agents-gap" }),
    resume);
  el.addEventListener("click", () => {
    ui.unfolded = !ui.unfolded;
    redraw();
  });
  return el;
}

/**
 * A message the chat's CLI sent one of its agents (`x`), and its answer:
 * "Talking to …", what `who` (the CLI) said, then the agent's answer, or
 * the dots and how long it has been waiting. Drawn again each second while
 * it waits: `fillTalkBox`, which only writes the words when nothing else changed.
 */
export function talkBox(x: TalkEntry, who: string, now = Date.now()): HTMLElement {
  // In `.agents`, for its colours and its place in the log.
  const el = h("div", { class: "agents agents-talk" });
  fillTalkBox(el, x, who, now);
  return el;
}

export function fillTalkBox(el: HTMLElement, x: TalkEntry, who: string, now = Date.now()) {
  const fresh = h("div");
  drawTalk(fresh, x, who, now);
  if (sameShape(el, fresh)) {
    copyWords(el, fresh);
    return;
  }
  clear(el);
  el.append(...Array.from(fresh.childNodes));
}

function drawTalk(into: HTMLElement, x: TalkEntry, who: string, now: number) {
  const waits = talkWaits(x);
  const took = (x.repliedAt ?? (waits ? now : x.sentAt)) - x.sentAt;
  into.append(h("div", { class: "agents-talk-head" },
    h("span", { class: "agents-talk-icon" }, svg(ICONS.bubble, 12, { stroke: 1.6 })),
    h("span", { class: "agents-talk-title", text: t(AGENTS_CARD_TEXT.talking, { name: x.title }), title: x.title }),
    h("span", { class: "agents-gap" }),
    h("span", { class: "agents-time", text: durationText(took) })));
  into.append(h("div", { class: "agents-talk-msg" },
    h("span", { class: "agents-talk-who", text: who }),
    h("span", { class: "agents-talk-text", text: x.message })));
  let answer: HTMLElement;
  if (x.reply) answer = h("span", { class: "agents-talk-text", text: x.reply });
  else if (x.stopped) answer = h("span", { class: "agents-talk-text dim", text: t(AGENTS_CARD_TEXT.stoppedFirst) });
  else if (x.failed != null) answer = h("span", { class: "agents-talk-text failed", text: t(AGENTS_CARD_TEXT.notReached, { name: x.title }), title: x.failed });
  else if (x.stale) answer = h("span", { class: "agents-talk-text dim", text: t(AGENTS_CARD_TEXT.noReply) });
  else {
    answer = h("span", { class: "agents-talk-text dim" },
      h("span", { class: "typing" }, h("i"), h("i"), h("i")),
      h("span", { text: t(AGENTS_CARD_TEXT.waitingReply, { time: durationText(now - x.sentAt) }) }));
  }
  into.append(h("div", { class: "agents-talk-msg agent" }, h("span", { class: "agents-talk-who", text: x.title, title: x.title }), answer));
}

/**
 * Under the card while agents work: the dots, how many work, and when the last
 * sign came, so a number that stays small says they are alive (concept 1).
 * The dots take the colour of the worst case (concept 3).
 */
function liveLine(entries: AgentEntry[], now: number, permission?: ReadonlySet<string>, stopThem?: (() => void) | null): HTMLElement {
  const counts = countAgents(entries, now, permission);
  const worst = counts.stalled ? toCheck(entries, now) : null;
  // Waiting on the user: in purple. In line or paused asks nothing of them.
  const asking = entries.some((e) => !isFinal(e.row.state) && lookOf(e, now, permission) === "waiting" && !shadeOf(e, "waiting", permission));
  let tone: string;
  let text: string;
  if (worst) {
    tone = "stalled";
    text = tn("{count} agent to check", AGENTS_CARD_TEXT.agentsToCheck, worst.count);
    if (counts.working + counts.waiting > 0) text += ` · ${t(AGENTS_CARD_TEXT.others)}`;
  } else if (counts.waiting && !counts.working) {
    tone = "waiting";
    // Those waiting only in line for the computer have no card for the user.
    const waits = entries.filter((e) => !isFinal(e.row.state) && (e.row.state === "waiting" || permission?.has(e.row.id)));
    // In line for the rate limit or paused by their CLI: nothing is asked of the user, and it is said in grey.
    const shades = waits.map((e) => shadeOf(e, "waiting", permission));
    if (waits.length && shades.every((s) => s === "paused" || s === "queued")) {
      tone = "queued";
      text = t(shades.every((s) => s === "paused") ? AGENTS_CARD_TEXT.paused
        : waits.some((e) => e.row.waitingFor === "rate_limit") ? AGENTS_CARD_TEXT.rateLimit : AGENTS_CARD_TEXT.inLine);
    } else {
      text = t(waits.length ? AGENTS_CARD_TEXT.permission : AGENTS_CARD_TEXT.inLineComputer);
    }
  } else if (stopThem) {
    // The answer stopped, its agents in the background on.
    tone = asking ? "waiting" : "working";
    text = t(AGENTS_CARD_TEXT.answerStopped);
  } else {
    tone = asking ? "waiting" : "working";
    const last = Math.max(...entries.filter((e) => !isFinal(e.row.state)).map((e) => e.row.lastSignalAt || 0));
    text = `${tn("{count} agent working", AGENT_TEXT.islandWorking, counts.open)} · ${t(AGENTS_CARD_TEXT.lastSignal, { time: durationText(now - last) })}`;
  }
  return h("div", { class: `agents-live ${tone}` },
    h("span", { class: "agents-dots" }, h("i"), h("i"), h("i")),
    h("span", { class: "agents-live-text", text }),
    stopThem && !worst ? cardButton("stop", tc(AGENTS_CARD_TEXT.stopThem), stopThem) : null);
}
