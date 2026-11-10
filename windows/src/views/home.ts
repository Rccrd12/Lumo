// The home: one list, as on the
// concept's board, laid out wide rather than tall. On the left what waits for
// you and the sessions at work; on the right the live activities as small
// tiles and the other pills as a row of names; the field to the chat under
// it all. A session or a pill opens its card (the overview); a waiting
// request is answered here only by a click on N or Y, as on its own card.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { State, type ActiveChatRun, type AgentTask } from "../core/state";
import { sessionSubtitle } from "../core/pills";
import { lastTextStep } from "../core/diff";
import { BACKGROUND_TEXT, backgroundLine, type BackgroundCounts } from "../core/background";
import { lanes, progressBar } from "./background";
import { ACTIVITIES_TEXT, eventWhen, type ActivitiesAction, type ActivitiesData } from "./activities-view";
import { N_, language, t, tl } from "../i18n/i18n";
import { Bridge, type Decision } from "../core/bridge";
import { parseDuration, type TimerActivity } from "../core/compact";
import type { PlanKind } from "../core/plan";
import { planPillParts, visiblePlanKinds } from "./usage";
import { TOOLS_STRINGS } from "./tools";
import { planFinished, planKey, planProgress, type AgentPlan } from "../core/agent-plan";
import { stripStep } from "./plan-strip";
import {
  CI_COLORS, GH_STRINGS, actionsUrl, ciWord, readPulse, safeGitHubUrl, shortRepo, type GitHubPR,
} from "../core/github";
import {
  activeWatches, firedTitle, onGitHub, untilText, watchColor, type ListenWatch,
} from "../core/listen";

export const HOME_TEXT = {
  needsYou: N_("Needs you"),
  paused: N_("Paused"),
  stop: N_("Stop the timer"),
};

/** The timer ring's radius, and its length. */
/** The line round a running timer's tile (timerEdge). */
interface TimerEdge {
  el: SVGSVGElement;
  track: SVGPathElement;
  fill: SVGPathElement;
  /** The size its path was drawn for. */
  size: string;
}

/** The timer tile's corner (look-new.css .home-tile), and how far in its edge line runs. */
const EDGE_R = 14;
const EDGE_IN = 1.5;

/**
 * The tile's outline as one path from the middle of its top edge, clockwise
 * round its corners and back: the timer's line runs out along it.
 */
export function edgePath(w: number, h: number): string {
  const i = EDGE_IN;
  const r = Math.max(0, Math.min(EDGE_R - i, (w - 2 * i) / 2, (h - 2 * i) / 2));
  const L = i, T = i, R = w - i, B = h - i;
  return [
    `M${w / 2} ${T}`, `H${R - r}`, `A${r} ${r} 0 0 1 ${R} ${T + r}`,
    `V${B - r}`, `A${r} ${r} 0 0 1 ${R - r} ${B}`,
    `H${L + r}`, `A${r} ${r} 0 0 1 ${L} ${B - r}`,
    `V${T + r}`, `A${r} ${r} 0 0 1 ${L + r} ${T}`, `Z`,
  ].join(" ");
}

/** What the home needs from the island. */
export interface HomeActions {
  openSession(id: string): void;
  openRequest(): void;
  decide(d: Decision, requestId: string): void;
  openChat(): void;
  openPlan(kind: PlanKind): void;
  /** A chat's row on the home: opens that chat on screen. */
  openChatPlan(chatId: string): void;
  openUrl?(url: string): void;
  /** The open PRs that wait, in one row: opens the GitHub card on its list of my PRs. */
  openGitHubPRs?(): void;
  makeTool(): void;
  activityData(): ActivitiesData;
  activity(a: ActivitiesAction): void;
  blip(): void;
}

/** One GitHub item (running/failing CI, review request, open PR, or the open PRs that wait) shown on the home. */
export interface HomeGitHubItem {
  key: string;
  color: string;
  sub: string;
  line: string;
  failed: boolean;
  badge: string;
  url: string | null;
  /** The row of the open PRs that wait: a click opens the GitHub card's list of them. */
  list?: true;
}

/** How long a request that just came up ignores clicks on N and Y (views.ts CLICK_GUARD_MS). */
const CLICK_GUARD_MS = 600;
/** Rows shown before the list scrolls. */
const MAX_SESSIONS = 3;

// The home's measures, for its height (homeHeight) and look-new.css.
const TOP = 44;
const LABEL_H = 24;
const ROW_H = 54;
const ROW_GAP = 6;
const TILE_H = 82;
const CHIPS_H = 34;
const FIELD_H = 40;
const GAP = 12;
const BOTTOM = 12;

function tilesOf(data: ActivitiesData): ("timer" | "music" | "calendar" | "mail")[] {
  const tiles: ("timer" | "music" | "calendar" | "mail")[] = [];
  // Put away with the "⋯" menu's Live Activities (on the home they are
  // shown by default).
  if (State.settings.homeActivities === false) return tiles;
  // The timer and the music always (a timer to start, what plays); the
  // calendar and the email once they are set up, empty or not.
  tiles.push("timer", "music");
  if (data.calendar.configured) tiles.push("calendar");
  if (data.mail.on) tiles.push("mail");
  return tiles;
}

/** Three tiles side by side in one row (look-new.css .three): the home needs more width for them (layout.ts homeWidth). */
export function homeTilesInARow(data: ActivitiesData): boolean {
  return tilesOf(data).length === 3;
}

/** The sessions the home lists, and the other pills it names (the email's is its tile, when shown). */
export function homeLists(active: (t: AgentTask) => boolean, data: ActivitiesData): { sessions: AgentTask[]; others: AgentTask[] } {
  const mailTile = tilesOf(data).includes("mail");
  return {
    sessions: State.tasks.filter(active),
    others: State.tasks.filter((x) => !active(x) && !(mailTile && x.id === "integration_mail")),
  };
}

/**
 * The island chats' plans still under way (island/plan.ts, State.plans), one
 * per chat: the home lists them with the sessions, as they run nowhere else.
 */
export function homeChatPlans(): AgentPlan[] {
  const seen = new Set<string>();
  return State.plans.filter((p) => {
    if (p.pillId !== "chat" || seen.has(p.key)) return false;
    seen.add(p.key);
    return p.steps.length > 0 && !planFinished(p.steps);
  });
}

/** Chats currently writing, thinking or calling tools without an active plan row of their own. */
export function homeActiveChats(chatPlans: AgentPlan[] = homeChatPlans()): ActiveChatRun[] {
  return State.activeChats.filter((c) => !chatPlans.some((p) => p.key === planKey("chat", c.chatId)));
}

/** Active GitHub CI runs/failures, review requests and open PRs from the GitHub pulse (the waiting ones in one row). */
export function homeGitHubItems(): HomeGitHubItem[] {
  const info = State.integrations["integration_github"];
  if (!info || (State.tasks.length > 0 && !State.tasks.some((x) => x.id === "integration_github"))) return [];
  const pulse = readPulse(info.data ?? {});
  if (!pulse) return [];
  const items: HomeGitHubItem[] = [];
  const ciOrder = { failure: 0, pending: 1, success: 2, unknown: 3 } as const;
  const activeCI = pulse.mainCI
    .filter((r) => r.ci === "pending" || r.ci === "failure")
    .slice()
    .sort((a, b) => ciOrder[a.ci] - ciOrder[b.ci]);
  for (const repo of activeCI) {
    const word = ciWord(repo.ci) ?? "";
    items.push({
      key: `ci:${repo.repo}:${repo.branch}:${repo.ci}`,
      color: CI_COLORS[repo.ci],
      sub: `${shortRepo(repo.repo)} (${repo.branch})`,
      line: word ? `${GH_STRINGS.mainCI} · ${word}` : GH_STRINGS.mainCI,
      failed: repo.ci === "failure",
      badge: word,
      url: safeGitHubUrl(actionsUrl(repo.url)),
    });
  }
  const seenPRs = new Set<string>();
  for (const pr of pulse.toReview) {
    seenPRs.add(pr.id);
    items.push({
      key: `rev:${pr.id}:${pr.ci}:${pr.title}`,
      color: pr.ci === "failure" || pr.ci === "pending" ? CI_COLORS[pr.ci] : "#8AB4F8",
      sub: `${shortRepo(pr.repo)}#${pr.number}`,
      line: pr.title,
      failed: pr.ci === "failure",
      badge: GH_STRINGS.toReview,
      url: safeGitHubUrl(pr.url),
    });
  }
  // My PRs whose checks run or fail have a row each; the others (checks
  // passed, no checks) only wait for a merge or a close: two or more of them
  // share one row, which opens the GitHub card.
  const myPRs = pulse.myPRs
    .filter((pr) => !seenPRs.has(pr.id))
    .slice()
    .sort((a, b) => ciOrder[a.ci] - ciOrder[b.ci]);
  const moving = (pr: GitHubPR) => pr.ci === "pending" || pr.ci === "failure";
  const still = myPRs.filter((pr) => !moving(pr));
  const gathered = still.length >= 2;
  for (const pr of gathered ? myPRs.filter(moving) : myPRs) {
    items.push({
      key: `pr:${pr.id}:${pr.ci}:${pr.isDraft}:${pr.title}`,
      color: CI_COLORS[pr.ci],
      sub: `${shortRepo(pr.repo)}#${pr.number}`,
      line: pr.title,
      failed: pr.ci === "failure",
      badge: pr.isDraft ? GH_STRINGS.draft : (ciWord(pr.ci) ?? GH_STRINGS.myPRs),
      url: safeGitHubUrl(pr.url),
    });
  }
  if (gathered) {
    items.push({
      key: `prs:${still.map((pr) => `${pr.id}:${pr.ci}:${pr.isDraft}`).join(",")}`,
      color: CI_COLORS.unknown,
      sub: GH_STRINGS.openPRs(still.length),
      line: still.map((pr) => `${shortRepo(pr.repo)}#${pr.number}`).join(" · "),
      failed: false,
      badge: GH_STRINGS.myPRs,
      url: null,
      list: true,
    });
  }
  return items;
}

/** Active watches Lumo is currently listening to (GitHub PRs or local triggers). */
export function homeWatches(): ListenWatch[] {
  return activeWatches(State.listening);
}

/** Total rows shown under "In progress" on the left side of the home. */
export function homeInProgressCount(sessionsCount: number): number {
  const chatPlans = homeChatPlans();
  return sessionsCount
    + chatPlans.length
    + homeActiveChats(chatPlans).length
    + homeGitHubItems().length
    + homeWatches().length;
}

/** A session's plan under way, if it follows one. */
function sessionPlan(task: AgentTask): AgentPlan | null {
  return State.plans.find((p) => p.pillId === task.id && p.steps.length > 0 && !planFinished(p.steps)) ?? null;
}

/** A plan's segments and how many steps are done, as its chip in the chat shows them (plan-strip.ts). */
function planEnds(plan: AgentPlan): HTMLElement[] {
  const { done, total } = planProgress(plan.steps);
  const segs = h("span", { class: "plan-chip-segs home-plan-segs" });
  if (total <= 10) for (const s of plan.steps) segs.append(h("i", { class: s.status }));
  return [segs, h("span", { class: "home-count", text: `${done}/${total}` })];
}

/** The home's height for what it shows now: rows on the left, tiles on the right, the field under them. */
export function homeHeight(sessions: number, waiting: boolean, data: ActivitiesData, chips: number): number {
  const shown = Math.min(sessions, MAX_SESSIONS);
  let left = 0;
  if (waiting) left += LABEL_H + ROW_H;
  if (shown) left += (waiting ? GAP : 0) + LABEL_H + shown * ROW_H + (shown - 1) * ROW_GAP;
  if (!left) left = ROW_H;
  const tiles = tilesOf(data).length;
  // Three side by side in one row (look-new.css .three), else two to a row.
  const rows = tiles === 3 ? 1 : Math.ceil(tiles / 2);
  const right = tiles ? rows * TILE_H + (rows - 1) * 8 : 0;
  return TOP + Math.max(left, right) + (chips ? GAP + CHIPS_H : 0) + GAP + FIELD_H + BOTTOM;
}

export function buildHome(actions: HomeActions, active: (t: AgentTask) => boolean) {
  const left = h("div", { class: "home-left" });
  const right = h("div", { class: "home-right" });
  const tilesEl = h("div", { class: "home-tiles" });
  const chipsEl = h("div", { class: "home-chips" });
  // The plans' usage, at the end of the services' line: written out when it
  // fits, only the numbers when that fits, else not at all (fitUsage).
  const usageEl = h("div", { class: "home-usage" });
  right.append(tilesEl);
  const field = h("button", { class: "ask-field home-field", onclick: () => actions.openChat() },
    h("span", { class: "ph", text: tl("Ask me anything…") }));
  // Beside the field: straight into the tool workshop (views/forge.ts), as Tools' "Add a tool" does.
  const makeTool = h("button", { class: "home-make-tool", title: tl(TOOLS_STRINGS.addHint), onclick: () => actions.makeTool() },
    svg(ICONS.wrench, 13, { stroke: 1.8 }), h("span", { text: tl(TOOLS_STRINGS.add) }));
  const el = h("div", { class: "view home" }, h("div", { class: "home-cols" }, left, right), chipsEl,
    h("div", { class: "home-ask" }, field, makeTool));

  // The timer's field outlives the tiles' rebuilds, so what is typed in it stays.
  const timerInput = h("input", {
    class: "tile-input", type: "text", spellcheck: "false", autocomplete: "off",
    placeholder: tl(ACTIVITIES_TEXT.timerHint), "aria-label": tl(ACTIVITIES_TEXT.timer),
  }) as HTMLInputElement;
  // The island only gets the keyboard once asked (as the chat's field does).
  timerInput.addEventListener("mousedown", () => {
    if (document.hasFocus()) return;
    void Bridge.focusWindow(true);
    window.setTimeout(() => timerInput.focus(), 60);
  });
  timerInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const m = /^(\S+)\s*(.*)$/.exec(timerInput.value.trim());
    const ms = m ? parseDuration(m[1]) : null;
    if (!m || ms == null) {
      timerInput.classList.add("bad");
      window.setTimeout(() => timerInput.classList.remove("bad"), 600);
      return;
    }
    timerInput.value = "";
    timerInput.blur();
    actions.activity({ kind: "timer", ms, label: m[2] });
  });

  let leftKey = "";
  let rightKey = "";
  let usageKey = "";
  /** The room the usage was last fitted to: the line's width, what the services take. */
  let fitKey = "";

  /** Full names, numbers only, or nothing: the most of it that fits after the services. */
  function fitUsage() {
    if (!usageEl.childElementCount || State.view !== "home") return;
    const width = chipsEl.clientWidth;
    const row = chipsEl.querySelector<HTMLElement>(".home-chip-row");
    const name = chipsEl.querySelector<HTMLElement>(".home-chips-name");
    // What the services need, whole, and the 10px gaps between the line's parts.
    // (The line's own width says nothing: it stretches into what is free.)
    const first = row?.firstElementChild as HTMLElement | null;
    const last = row?.lastElementChild as HTMLElement | null;
    const services = first && last ? last.offsetLeft + last.offsetWidth - first.offsetLeft : 0;
    const used = (name ? name.offsetWidth + 10 : 0) + (services ? services + 10 : 0) + 4;
    const key = `${width}:${used}`;
    if (key === fitKey) return;
    fitKey = key;
    for (const mode of ["full", "short", "none"] as const) {
      usageEl.className = `home-usage ${mode}`;
      if (mode === "none" || usageEl.scrollWidth <= width - used) break;
    }
  }
  let shownFor: string | null = null;
  let shownAt = 0;
  /** The running timer's countdown and ring, moved on by tick(). */
  const timerEls: { el: HTMLElement; edge: TimerEdge; timer: TimerActivity }[] = [];

  const guarded = (d: Decision) => () => {
    if (performance.now() - shownAt < CLICK_GUARD_MS || shownFor == null) return;
    actions.decide(d, shownFor);
  };

  function waitingCard(): HTMLElement | null {
    const req = State.pendingApproval;
    if (!req) return null;
    const task = State.tasks.find((x) => x.id === req.pillId) ?? null;
    const name = req.project ?? task?.name ?? "";
    const who = h("div", { class: "home-who" },
      task ? dot(task.color, 8) : null,
      h("span", { class: "n", text: name }),
      h("span", { class: "s", text: req.email ? t("wants to send an email") : req.questions ? t("is asking a question") : `· ${t(sessionSubtitle(req.pillId))}` }));
    const what = req.questions
      ? h("div", { class: "home-line", text: req.questions[0]?.question ?? "" })
      : h("div", { class: "home-line" }, h("code", { text: req.email ? req.email.subject : req.command || req.tool }));
    const ends: HTMLElement[] = [];
    // An email is read whole before it goes, and a question has options: their card opens.
    if (req.email || req.questions) {
      ends.push(h("button", { class: "home-btn acc", text: tl("Open"), onclick: () => actions.openRequest() }));
    } else {
      ends.push(
        h("button", { class: "home-btn", title: tl("Deny"), text: "N", onclick: guarded("deny") }),
        h("button", { class: "home-btn acc", title: tl("Allow"), text: "Y", onclick: guarded("allow") }),
      );
    }
    const row = h("div", { class: "home-row hot" }, h("div", { class: "home-text" }, who, what), ...ends);
    // A click on the words opens the whole card, with what it is for.
    row.addEventListener("click", (e) => {
      if (!(e.target as Element).closest("button")) actions.openRequest();
    });
    return row;
  }

  /** A chat's plan under way: whose, its step now, its segments; a click opens that chat. */
  function chatPlanRow(plan: AgentPlan): HTMLElement {
    const chatId = plan.key.slice(plan.key.indexOf("|") + 1);
    const liveRun = State.activeChats.find((c) => c.chatId === chatId);
    const stepText = stripStep(plan.steps)?.text || liveRun?.line || "";
    return h("button", { class: "home-row", onclick: () => actions.openChatPlan(chatId) },
      h("div", { class: "home-text" },
        h("div", { class: "home-who" },
          dot(plan.color, 8),
          h("span", { class: "n", text: plan.agent }),
          h("span", { class: "s", text: `· ${plan.project}` })),
        h("div", { class: "home-line", text: stepText })),
      ...planEnds(plan));
  }

  /** An island chat currently writing, thinking, calling tools, compacting, or just finished; a click opens it. */
  function activeChatRow(c: ActiveChatRun): HTMLElement {
    const cls = c.done ? " ok" : c.failed ? " err" : "";
    return h("button", { class: "home-row", onclick: () => actions.openChatPlan(c.chatId) },
      h("div", { class: "home-text" },
        h("div", { class: "home-who" },
          dot(c.color, 8),
          h("span", { class: "n", text: c.who }),
          c.title && c.title !== c.who ? h("span", { class: "s", text: `· ${c.title}` }) : null),
        h("div", { class: `home-line${cls}`, text: c.line })));
  }

  /** A GitHub CI run/failure, review request or open PR; a click opens it on GitHub (or the GitHub card). */
  function gitHubRow(item: HomeGitHubItem): HTMLElement {
    const open = () => {
      if (item.list && actions.openGitHubPRs) {
        actions.openGitHubPRs();
      } else if (item.url) {
        actions.blip();
        if (actions.openUrl) actions.openUrl(item.url);
        else void Bridge.openUrl(item.url);
      } else {
        actions.openSession("integration_github");
      }
    };
    return h("button", { class: "home-row", onclick: open },
      h("div", { class: "home-text" },
        h("div", { class: "home-who" },
          dot(item.color, 8),
          h("span", { class: "n", text: GH_STRINGS.title }),
          item.sub ? h("span", { class: "s", text: `· ${item.sub}` }) : null),
        h("div", { class: `home-line${item.failed ? " err" : ""}`, text: item.line })),
      item.badge ? h("span", { class: "home-count", text: item.badge }) : null);
  }

  /** An active watch Lumo is listening to; a click opens its chat or its GitHub PR. */
  function watchRow(w: ListenWatch): HTMLElement {
    const gh = onGitHub(w);
    const open = () => {
      if (w.chatId) {
        actions.openChatPlan(w.chatId);
        return;
      }
      const url = gh ? safeGitHubUrl(`https://github.com/${w.repo}/pull/${w.number}`) : null;
      if (url) {
        actions.blip();
        if (actions.openUrl) actions.openUrl(url);
        else void Bridge.openUrl(url);
      }
    };
    const sub = gh ? `${shortRepo(w.repo)}#${w.number}` : "";
    const when = untilText(w);
    const line = w.task ? `${when} · ${w.task}` : when;
    return h("button", { class: "home-row", onclick: open },
      h("div", { class: "home-text" },
        h("div", { class: "home-who" },
          dot(watchColor(w), 8),
          h("span", { class: "n", text: firedTitle(w) }),
          sub ? h("span", { class: "s", text: `· ${sub}` }) : null),
        h("div", { class: "home-line", text: line })),
      h("span", { class: "home-count", text: t("Listening") }));
  }

  function sessionRow(task: AgentTask): HTMLElement {
    if (task.background) return backgroundRow(task, task.background);
    const done = task.state === "finished";
    const failed = task.state === "error";
    const step = done ? task.finalLine || lastTextStep(task.steps) : lastTextStep(task.steps);
    const line = done ? `${t("Done")}${step ? ` · ${step}` : ""}` : failed ? `${t("Error")}${step ? ` · ${step}` : ""}` : step ?? "";
    const count = task.steps.length > 1 && !done ? `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}` : "";
    // Following a plan: its segments and steps done, as in the chat (concept D).
    const plan = done || failed ? null : sessionPlan(task);
    return h("button", { class: "home-row", onclick: () => actions.openSession(task.id) },
      h("div", { class: "home-text" },
        h("div", { class: "home-who" },
          dot(task.color, 8),
          // A titled session goes by its title, with the pill's name (its folder) beside it.
          h("span", { class: "n", text: task.sessionTitle || task.name }),
          task.sessionTitle ? h("span", { class: "s", text: `· ${task.name}` })
            // An agent's pill is named after it: no need to say it twice.
            : t(sessionSubtitle(task.id)) !== task.name ? h("span", { class: "s", text: `· ${t(sessionSubtitle(task.id))}` }) : null),
        h("div", { class: `home-line${done ? " ok" : failed ? " err" : ""}`, text: line })),
      ...(plan ? planEnds(plan) : [count ? h("span", { class: "home-count", text: count }) : null]));
  }

  /**
   * A program's sessions in the background, on one row: how many run (a dot
   * each, up to eight), have answered and failed; a click opens their answers.
   */
  function backgroundRow(task: AgentTask, c: BackgroundCounts): HTMLElement {
    const done = task.state === "finished";
    const failed = task.state === "error";
    const counts = backgroundLine(c);
    const line = done ? `${t("Done")} · ${counts}` : failed ? `${t("Error")} · ${counts}` : counts;
    return h("button", { class: "home-row", onclick: () => actions.openSession(task.id) },
      h("div", { class: "home-text" },
        h("div", { class: "home-who" },
          dot(task.color, 8),
          h("span", { class: "n", text: task.name }),
          h("span", { class: "s", text: `· ${t(BACKGROUND_TEXT.inBackground)}` })),
        h("div", { class: `home-line${done ? " ok" : failed ? " err" : ""}`, text: line })),
      lanes(c.running),
      done || failed ? null : progressBar(c));
  }

  function label(text: string, n?: number): HTMLElement {
    return h("div", { class: "home-label" }, h("span", { text }), n != null ? h("span", { class: "c", text: String(n) }) : null);
  }

  function remaining(endsAt: number): string {
    const s = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    const m = Math.floor(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
  }

  /** The ring round what is left of a timer (52 px, its fill set by tick()). */
  /** The line round a running timer's tile, and the track it runs on (edgePath, drawn as the tile is sized). */
  function timerEdge(): TimerEdge {
    const NS = "http://www.w3.org/2000/svg";
    const el = document.createElementNS(NS, "svg") as SVGSVGElement;
    el.setAttribute("class", "tile-edge");
    el.setAttribute("aria-hidden", "true");
    const path = (cls: string) => {
      const p = document.createElementNS(NS, "path") as SVGPathElement;
      p.setAttribute("class", cls);
      p.setAttribute("pathLength", "100");
      el.append(p);
      return p;
    };
    const track = path("tile-edge-track");
    const fill = path("tile-edge-fill");
    return { el, track, fill, size: "" };
  }

  function tile(kind: "timer" | "music" | "calendar" | "mail", data: ActivitiesData): HTMLElement {
    switch (kind) {
      case "timer": {
        const timer = data.timers[0];
        // None running: one to type ("15m pasta", Enter), or three to start with a click.
        if (!timer) {
          const start = (minutes: number) => h("button", {
            class: "tile-chip", text: `${minutes}m`,
            onclick: () => actions.activity({ kind: "timer", ms: minutes * 60_000, label: "" }),
          });
          return h("div", { class: "home-tile" },
            h("label", { class: "tile-field" }, svg(ICONS.clock, 12, { stroke: 1.8 }), timerInput),
            h("div", { class: "tile-chips" }, start(5), start(10), start(25)));
        }
        // Running: the time on the left, what is left as a line round the
        // tile's edge (the island's own light, in small), and on the right
        // two round buttons, pause (or go on) and ×.
        const paused = timer.pausedLeft != null;
        const big = h("div", { class: "tile-big", text: remaining(timer.endsAt) });
        const edge = timerEdge();
        timerEls.push({ el: big, edge, timer });
        const ctl = (cls: string, icon: string, size: number, title: string, run: () => void) =>
          h("button", { class: `tile-timer-btn ${cls}`, title: t(title), "aria-label": t(title), onclick: run }, svg(icon, size));
        return h("div", { class: `home-tile tile-timer${paused ? " paused" : ""}` },
          edge.el,
          h("div", { class: "tile-timer-text" },
            h("div", { class: "tile-kick" }, svg(ICONS.clock, 12, { stroke: 1.8 }),
              h("span", { text: paused ? t(HOME_TEXT.paused) : timer.label || t(ACTIVITIES_TEXT.timer) })),
            big),
          h("div", { class: "tile-timer-ctls" },
            ctl("pause", paused ? ICONS.play : ICONS.pause, 13, paused ? ACTIVITIES_TEXT.play : ACTIVITIES_TEXT.pause,
              () => actions.activity({ kind: "pauseTimer", id: timer.id })),
            ctl("stop", ICONS.xmark, 11, HOME_TEXT.stop, () => actions.activity({ kind: "cancelTimer", id: timer.id }))));
      }
      case "music": {
        const media = data.media;
        // The whole tile plays or pauses (with nothing playing, it asks the
        // last player to go on); its own buttons do only what they say.
        const playPause = (tileEl: HTMLElement) => {
          tileEl.addEventListener("click", (e) => {
            if (!(e.target as Element).closest("button")) actions.activity({ kind: "media", action: "toggle" });
          });
          return tileEl;
        };
        if (!media) {
          return playPause(h("div", { class: "home-tile link", title: t(ACTIVITIES_TEXT.play) },
            h("div", { class: "tile-kick" }, svg(ICONS.play, 10), h("span", { text: t(ACTIVITIES_TEXT.music) })),
            h("div", { class: "tile-sub", text: t(ACTIVITIES_TEXT.nothingPlaying) })));
        }
        const ctl = (icon: string, title: string, action: "toggle" | "next") =>
          h("button", { class: "tile-ctl", title: t(title), onclick: () => actions.activity({ kind: "media", action }) }, svg(icon, 11));
        return playPause(h("div", { class: "home-tile link", title: t(media.playing ? ACTIVITIES_TEXT.pause : ACTIVITIES_TEXT.play) },
          h("div", { class: "tile-kick" }, dot("#22c55e", 6), h("span", { text: media.app || t(ACTIVITIES_TEXT.music) })),
          h("div", { class: "tile-title", text: media.title }),
          h("div", { class: "tile-ctls" },
            ctl(media.playing ? ICONS.pause : ICONS.play, media.playing ? ACTIVITIES_TEXT.pause : ACTIVITIES_TEXT.play, "toggle"),
            ctl(ICONS.forward, ACTIVITIES_TEXT.next, "next"),
            h("span", { class: "tile-sub", text: media.artist }))));
      }
      case "calendar": {
        const [first, second] = data.calendar.events;
        const now = Date.now();
        // Opens the calendar on the web, or its Settings when it has no site.
        const opens = (tileEl: HTMLElement) => {
          tileEl.addEventListener("click", () => actions.activity(data.calendar.link ? { kind: "calendarWeb" } : { kind: "settings" }));
          return tileEl;
        };
        if (!first) {
          return opens(h("div", { class: "home-tile link" },
            h("div", { class: "tile-kick" }, svg(ICONS.calendar, 12, { stroke: 1.8 }), h("span", { text: t(ACTIVITIES_TEXT.calendar) })),
            h("div", { class: "tile-sub", text: t(ACTIVITIES_TEXT.nothingSoon) })));
        }
        const tileEl = h("div", { class: "home-tile link" },
          h("div", { class: "tile-kick" }, svg(ICONS.calendar, 12, { stroke: 1.8 }),
            h("span", { text: first.allDay ? t(ACTIVITIES_TEXT.allDay) : eventWhen(first, now, language()) })),
          h("div", { class: "tile-title", text: first.title }),
          second ? h("div", { class: "tile-sub", text: `${second.title} · ${second.allDay ? t(ACTIVITIES_TEXT.allDay) : eventWhen(second, now, language())}` }) : null);
        return opens(tileEl);
      }
      case "mail": {
        const mail = data.mail.messages;
        if (!mail.length) {
          const quiet = h("div", { class: "home-tile link" },
            h("div", { class: "tile-kick" }, svg(ICONS.envelope, 12, { stroke: 1.8 }), h("span", { text: t(ACTIVITIES_TEXT.email) })),
            h("div", { class: "tile-sub", text: t(ACTIVITIES_TEXT.noUnread) }));
          quiet.addEventListener("click", () => actions.activity({ kind: "inbox" }));
          return quiet;
        }
        const tileEl = h("div", { class: "home-tile link" },
          h("div", { class: "tile-kick" }, dot("#f4505e", 6), h("span", { text: `${t(ACTIVITIES_TEXT.email)} · ${mail.length}` })),
          h("div", { class: "tile-title", text: mail[0].from }),
          h("div", { class: "tile-sub", text: mail[0].subject }));
        tileEl.addEventListener("click", () => actions.activity({ kind: "inbox" }));
        return tileEl;
      }
    }
  }

  // Shown, or the island resized without anything else changing: fitted again.
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => fitUsage()).observe(chipsEl);

  return {
    el,
    tick(): boolean {
      for (const { el: big, edge, timer } of timerEls) {
        const text = remaining(timer.endsAt);
        if (big.textContent !== text) big.textContent = text;
        // The outline, drawn again only when the tile changed size.
        const w = edge.el.clientWidth;
        const hh = edge.el.clientHeight;
        const size = `${w}x${hh}`;
        if (w > 0 && hh > 0 && size !== edge.size) {
          edge.size = size;
          const d = edgePath(w, hh);
          edge.track.setAttribute("d", d);
          edge.fill.setAttribute("d", d);
        }
        // From the top middle, clockwise as far as there is time left: it
        // runs back anticlockwise as the time goes, as the ring did.
        const left = Math.max(0, Math.min(1, (timer.endsAt - Date.now()) / timer.total));
        const dash = `${(left * 100).toFixed(2)} 100`;
        if (edge.fill.getAttribute("stroke-dasharray") !== dash) edge.fill.setAttribute("stroke-dasharray", dash);
      }
      return false;
    },
    sync() {
      const req = State.pendingApproval;
      const id = req?.requestId ?? null;
      if (id !== shownFor) {
        shownFor = id;
        shownAt = performance.now();
      }
      const data = actions.activityData();
      const { sessions, others } = homeLists(active, data);
      const chatPlans = homeChatPlans();
      const chatRuns = homeActiveChats(chatPlans);
      const ghItems = homeGitHubItems();
      const watches = homeWatches();

      // Rebuilt only when what they show changes: a rebuild between a mouse-down
      // and its mouse-up would swallow the click.
      const lk = [
        language(), id, req?.command, req?.questions?.[0]?.question, req?.email?.subject, State.approvalQueue.length,
        ...sessions.map((x) => `${x.id}:${x.name}:${x.color}:${x.state}:${x.stepIndex}:${x.steps.length}:${lastTextStep(x.steps)}:${x.finalLine ?? ""}:${x.background ? `${x.background.running}/${x.background.done}/${x.background.failed}/${x.background.total ?? ""}` : ""}`),
        ...State.plans.map((p) => `${p.key}:${p.updatedAt}:${p.steps.map((s) => s.status).join(",")}`),
        ...State.activeChats.map((c) => `${c.chatId}:${c.who}:${c.color}:${c.title}:${c.line}:${c.done ? 1 : 0}:${c.failed ? 1 : 0}`),
        ...ghItems.map((g) => g.key),
        ...watches.map((w) => `${w.id}:${w.source ?? ""}:${w.repo}:${w.number}:${w.target ?? ""}:${w.until}:${w.task}`),
      ].join("~");
      if (lk !== leftKey) {
        leftKey = lk;
        clear(left);
        const waiting = waitingCard();
        if (waiting) left.append(label(t(HOME_TEXT.needsYou), 1 + State.approvalQueue.length), waiting);
        const runningCount = sessions.length + chatPlans.length + chatRuns.length + ghItems.length + watches.length;
        if (runningCount > 0) {
          left.append(label(t("In progress"), runningCount),
            h("div", { class: "home-rows" },
              ...sessions.map(sessionRow),
              ...chatPlans.map(chatPlanRow),
              ...chatRuns.map(activeChatRow),
              ...ghItems.map(gitHubRow),
              ...watches.map(watchRow)));
        }
        if (!waiting && runningCount === 0) {
          left.append(h("div", { class: "home-empty" },
            h("div", { class: "n", text: t("Nothing running right now.") }),
            h("div", { class: "s", text: t("Drop a file or window, or ask me anything.") })));
        }
      }

      const tiles = tilesOf(data);
      const kinds = visiblePlanKinds();
      const rk = [
        language(), ...tiles,
        // (A paused timer's endsAt moves with the clock: what is left says it.)
        ...data.timers.map((x) => `${x.id}:${x.label}:${x.pausedLeft != null ? `p${x.pausedLeft}` : x.endsAt}`),
        data.media ? `${data.media.app}:${data.media.title}:${data.media.artist}:${data.media.playing}` : "",
        ...data.calendar.events.slice(0, 2).map((e) => `${e.title}:${e.start}`),
        ...data.mail.messages.slice(0, 1).map((m) => `${m.id}:${m.from}:${m.subject}`), data.mail.messages.length,
        ...others.map((x) => `${x.id}:${x.name}:${x.color}:${x.pillBadge ?? ""}`),
      ].join("~");
      if (rk !== rightKey) {
        rightKey = rk;
        const typing = document.activeElement === timerInput;
        clear(tilesEl);
        timerEls.length = 0;
        for (const kind of tiles) tilesEl.append(tile(kind, data));
        if (typing && timerInput.isConnected) timerInput.focus();
        tilesEl.hidden = tiles.length === 0;
        right.classList.toggle("three", tiles.length === 3);
        clear(chipsEl);
        usageKey = "";
        if (others.length) {
          // One line across the island, its name first, as on the board.
          chipsEl.append(h("span", { class: "home-chips-name", text: t("Services") }),
            h("div", { class: "home-chip-row" }, ...others.map((x) => {
              const chip = h("button", { class: "home-chip", onclick: () => actions.openSession(x.id) },
                dot(x.color, 7), h("span", { text: x.id === "integration_claude" ? "VS Code" : x.name }));
              if (x.pillBadge) chip.classList.add(`badge-${x.pillBadge}`);
              return chip;
            })));
        }
        chipsEl.hidden = others.length === 0 && kinds.length === 0;
        right.hidden = tiles.length === 0;
      }
      const uk = kinds.map((kind) => {
        const p = planPillParts(kind);
        return `${kind}:${p.value}:${p.color}`;
      }).join("~");
      if (uk !== usageKey) {
        usageKey = uk;
        clear(usageEl);
        usageEl.append(...kinds.map((kind) => {
          const p = planPillParts(kind);
          return h("button", { class: "home-plan", title: `${p.name} ${p.value}`, onclick: () => actions.openPlan(kind) },
            dot(p.color, 7), h("span", { class: "home-plan-name", text: p.name }), h("span", { class: "home-plan-pct", text: p.value }));
        }));
        if (usageEl.parentElement !== chipsEl || chipsEl.lastElementChild !== usageEl) chipsEl.append(usageEl);
        fitKey = "";
      }
      fitUsage();
    },
  };
}
