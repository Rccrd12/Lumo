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
// What the user opened or folded is kept per card.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import type { ChatActivity } from "../core/bridge";
import {
  AGENT_TEXT, agentStall, askable, computerOf, batchEntries, countAgents, durationText, isFinal, lookOf, looksOf, snooze, talkWaits, worstStall,
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
  seeRequest: N_("See request"),
  ended: N_("{name} ended: {count} agents stopped halfway"),
  /** What Rust says of an agent whose CLI ended under it (chat_agents.rs end_open). */
  cliEnded: N_("{agent} ended"),
  resume: N_("Resume"),
  resumeAsk: N_("{name} ended while these agents were still working. Please resume their tasks where they stopped:"),
  finished: N_("{count} agents finished"),
  inTime: N_("in {time}"),
  lastSignal: N_("last signal {time} ago"),
  noSign: N_("{count} agents have given no sign for {time}"),
  others: N_("the others are working"),
  steps: N_("{count} steps"),
  tokens: N_("{tokens} tokens"),
  stopThis: N_("Stop this agent"),
  close: N_("Close"),
  show: N_("Show the agents"),
  hide: N_("Hide the agents"),
  ask: N_("agents|Ask"),
  inConversation: N_("in conversation"),
  talking: N_("Talking to {name}"),
  waitingReply: N_("waiting for the reply… {time}"),
  notReached: N_("The message did not reach {name}"),
  noReply: N_("No reply came"),
  usesComputer: N_("uses the computer"),
  waitingComputer: N_("Waiting for the computer · {place} of {total} · {time}"),
  inLineComputer: N_("Waiting for the computer"),
  giveTurn: N_("Give it the turn"),
};

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
function segments(looks: AgentLook[]): HTMLElement {
  return h("span", { class: "agents-segs" }, ...looks.map((l) => h("i", { class: l })));
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

function chevron(down: boolean, title: string): HTMLElement {
  return h("span", { class: down ? "agents-chev down" : "agents-chev", title, "aria-label": title }, svg(ICONS.chevronUp, 12, { stroke: 1.8 }));
}

/** Whether an agent failed because its CLI ended under it: Rust says "{agent} ended", in the user's language or in English. */
function cliEnded(e: AgentEntry): boolean {
  if (e.row.state !== "failed" || !e.row.error || !e.row.source) return false;
  const agent = providerDef(e.row.source).name;
  return e.row.error === t(AGENTS_CARD_TEXT.cliEnded, { agent }) || e.row.error === `${agent} ended`;
}

/** The agents their CLI ended under ("Claude Code ended"), with that CLI's name. */
function endedByCli(entries: AgentEntry[]): { name: string; entries: AgentEntry[] } | null {
  const ended = entries.filter(cliEnded);
  if (!ended.length) return null;
  return { name: t(providerDef(ended[0].row.source).name), entries: ended };
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
  drawCard(fresh, el, input, host);
  if (sameShape(el, fresh)) {
    copyWords(el, fresh);
    return;
  }
  clear(el);
  el.append(...Array.from(fresh.childNodes));
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
    if (ex.tagName !== ey.tagName || classOf(ex) !== classOf(ey) || !sameShape(ex, ey)) return false;
  }
  return true;
}

/** Writes the words of `from` (its texts and tooltips) into `to`, of the same shape. */
function copyWords(to: Element, from: Element) {
  for (const attr of ["title", "aria-label"]) {
    const v = from.getAttribute(attr);
    if (v == null) to.removeAttribute(attr);
    else if (to.getAttribute(attr) !== v) to.setAttribute(attr, v);
  }
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
function drawCard(into: HTMLElement, el: HTMLElement, input: AgentsCardInput, given: AgentsCardHost) {
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
  if (!allOver) into.append(liveLine(entries, now, input.permission));
}

/** The header and the rows. */
function fullCard(entries: AgentEntry[], input: AgentsCardInput, host: AgentsCardHost, ui: CardUi, now: number, redraw: () => void): HTMLElement {
  const counts = countAgents(entries, now, input.permission);
  const allOver = counts.open === 0;
  const started = Math.min(...entries.map((e) => e.row.startedAt || now));
  const ended = allOver ? Math.max(...entries.map((e) => e.row.endedAt ?? e.row.lastSignalAt ?? now)) : now;
  const status = counts.stalled
    ? `${t(AGENTS_CARD_TEXT.doneOf, { done: counts.done, total: counts.total })} · ${tn("{count} with no signal", AGENTS_CARD_TEXT.noSignalCount, counts.stalled)}`
    : t(AGENTS_CARD_TEXT.doneOf, { done: counts.done, total: counts.total });
  // Folded rows show again with the chevron; once all are over it folds the card into one line.
  const folded = !allOver && ui.collapsed;
  const head = h("div", { class: "agents-head" },
    h("span", { class: "agents-title", text: t(AGENTS_CARD_TEXT.title) }),
    h("span", { class: "agents-status", text: status }),
    segments(looksOf(entries, now, input.permission)),
    h("span", { class: "agents-gap" }),
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
  return h("div", { class: "agents-rows" }, ...entries.map((e) => row(e, input, host, ui, now, redraw)));
}

/** What a row says next to its title. */
function rowLine(e: AgentEntry, look: AgentLook, host: AgentsCardHost, now: number): string {
  const r = e.row;
  switch (look) {
    case "done":
      return r.summary ? t(AGENTS_CARD_TEXT.doneSummary, { summary: r.summary }) : t("Done");
    case "failed":
      return r.error || t(r.state === "stopped" ? AGENTS_CARD_TEXT.stopped : AGENTS_CARD_TEXT.failed);
    case "waiting": {
      const pc = computerOf(r.id);
      if (pc?.waits && r.state !== "waiting") {
        return t(AGENTS_CARD_TEXT.waitingComputer, { place: pc.place, total: pc.of, time: durationText(now - pc.since) });
      }
      return t(r.waitingFor === "rate_limit" ? AGENTS_CARD_TEXT.rateLimit : AGENTS_CARD_TEXT.permission);
    }
    case "stalled": {
      const time = durationText((agentStall(e, now)?.seconds ?? 0) * 1000);
      const last = e.steps[0]?.now ?? r.now;
      return last ? t(AGENTS_CARD_TEXT.noSignalStep, { time, step: host.label(last) }) : t(AGENTS_CARD_TEXT.noSignal, { time });
    }
    default:
      return r.now ? host.label(r.now) : r.summary || t(AGENTS_CARD_TEXT.working);
  }
}

/** One agent: its marker, its task, what it does, and its time or what can be done about it. */
function row(e: AgentEntry, input: AgentsCardInput, host: AgentsCardHost, ui: CardUi, now: number, redraw: () => void): HTMLElement {
  const r = e.row;
  const look = lookOf(e, now, input.permission);
  const marker = look === "done"
    ? h("span", { class: "agents-mark done" }, svg(ICONS.check, 12, { stroke: 2.2 }))
    : h("span", { class: `agents-mark ${look}` }, h("i"));
  const line = rowLine(e, look, host, now);
  const side = h("span", { class: "agents-side" });
  const ask = canAsk(e, host) ? () => host.ask!({ agentId: r.id, title: r.title, line, look }) : null;
  if (look === "stalled") {
    if (ask) side.append(cardButton("ask", tc(AGENTS_CARD_TEXT.ask), ask));
    side.append(cardButton("wait", tc(AGENTS_CARD_TEXT.wait), () => {
      // From the click: the button may have been drawn a while before.
      snooze(e);
      redraw();
    }));
    if (r.canStop) side.append(cardButton("stop", tc(AGENTS_CARD_TEXT.stop), () => host.stop(r.id)));
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
  } else if (look === "done") {
    side.append(h("span", { class: "agents-time", text: t(AGENTS_CARD_TEXT.doneIn, { time: durationText((r.endedAt ?? now) - r.startedAt) }) }));
  } else if (look === "failed") {
    if (r.endedAt) side.append(h("span", { class: "agents-time", text: durationText(r.endedAt - r.startedAt) }));
  } else {
    side.append(h("span", { class: "agents-time", text: `${durationText(now - r.startedAt)} · ${t(AGENTS_CARD_TEXT.ago, { time: durationText(now - r.lastSignalAt) })}` }));
  }
  const open = ui.open.has(r.id);
  const talking = r.talk && talkWaits(r.talk)
    ? h("span", { class: "agents-badge talk", text: t(AGENTS_CARD_TEXT.inConversation) })
    : null;
  const computer = !isFinal(r.state) && computerOf(r.id)?.holds
    ? h("span", { class: "agents-badge computer", text: t(AGENTS_CARD_TEXT.usesComputer) })
    : null;
  const head = h("div", { class: "agents-row-head" },
    marker,
    h("span", { class: "agents-name", text: r.title, title: r.title }),
    ...(talking ? [talking] : []),
    ...(computer ? [computer] : []),
    h("span", { class: "agents-line", text: line, title: line }),
    side);
  const el = h("div", { class: `agents-row ${look}${open ? " open" : ""}` }, head);
  head.addEventListener("click", () => {
    if (open) ui.open.delete(r.id);
    else ui.open.add(r.id);
    redraw();
  });
  if (open) el.append(rowDetail(e, host, ui, now, redraw, ask));
  return el;
}

/** Whether Ask shows on an agent: its CLI can pass it a message, and the chat can ask now. */
function canAsk(e: AgentEntry, host: AgentsCardHost): boolean {
  return !!host.ask && askable(e) && !cliEnded(e);
}

/** An opened row: the CLI's summary, the last steps, the numbers, and Stop this agent. */
function rowDetail(e: AgentEntry, host: AgentsCardHost, ui: CardUi, now: number, redraw: () => void, ask: (() => void) | null): HTMLElement {
  const r = e.row;
  const box = h("div", { class: "agents-detail" });
  if (r.summary) box.append(h("div", { class: "agents-summary", text: r.summary }));
  if (r.error && r.error !== r.summary) box.append(h("div", { class: "agents-summary failed", text: r.error }));
  if (e.steps.length) {
    box.append(h("div", { class: "agents-steps" }, ...e.steps.map((s) =>
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
  if (r.canStop && !isFinal(r.state)) actions.append(cardButton("stop", t(AGENTS_CARD_TEXT.stopThis), () => host.stop(r.id)));
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
    const tasks = halfway.entries.map((e) => `- ${e.row.title}`).join("\n");
    // Not sent (a question being edited, one being prepared): the line stays, Resume with it.
    if (!host.send(`${t(AGENTS_CARD_TEXT.resumeAsk, { name: halfway.name })}\n${tasks}`)) return;
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
function liveLine(entries: AgentEntry[], now: number, permission?: ReadonlySet<string>): HTMLElement {
  const counts = countAgents(entries, now, permission);
  const worst = counts.stalled ? worstStall(entries, now) : null;
  let tone: string;
  let text: string;
  if (worst) {
    tone = "stalled";
    text = tn("{count} agent has given no sign for {time}", AGENTS_CARD_TEXT.noSign, counts.stalled, { time: durationText(worst.seconds * 1000) });
    if (counts.working + counts.waiting > 0) text += ` · ${t(AGENTS_CARD_TEXT.others)}`;
  } else if (counts.waiting && !counts.working) {
    tone = "waiting";
    // Those waiting only in line for the computer have no card for the user.
    const onUser = entries.some((e) => !isFinal(e.row.state) && (e.row.state === "waiting" || permission?.has(e.row.id)));
    text = t(onUser ? AGENTS_CARD_TEXT.permission : AGENTS_CARD_TEXT.inLineComputer);
  } else {
    tone = counts.waiting ? "waiting" : "working";
    const last = Math.max(...entries.filter((e) => !isFinal(e.row.state)).map((e) => e.row.lastSignalAt || 0));
    text = `${tn("{count} agent working", AGENT_TEXT.islandWorking, counts.open)} · ${t(AGENTS_CARD_TEXT.lastSignal, { time: durationText(now - last) })}`;
  }
  return h("div", { class: `agents-live ${tone}` },
    h("span", { class: "agents-dots" }, h("i"), h("i"), h("i")),
    h("span", { class: "agents-live-text", text }));
}
