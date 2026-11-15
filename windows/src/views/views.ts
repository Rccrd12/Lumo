// Island views: the header, the overview and the cards, built in the DOM.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { StepsCard } from "./steps";
import { State, keepPillPlaces, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../character/minibots";
import { planAskSteps } from "./plan-ask";
import { buildPrompt } from "./chat";
import { buildUpload, buildUploading } from "./upload";
import { idleCardKey, renderIntegrationCard, type IntegrationCardHooks } from "./integrations";
import { pillDefinition, sessionSubtitle } from "../core/pills";
import {
  PlanCard, buildPlanPill, openPlanCard, claudePillVisible, codexPillVisible, antigravityPillVisible, planCardOpen, refreshCodexPlanUsage,
  refreshAntigravityPlanUsage,
} from "./usage";
import { buildDiffCard } from "./diff";
import { lastTextStep, toOneLine } from "../core/diff";
import { approvalKey, approvalKeysArmed, approvalOffer, armApprovalKeys } from "../core/approvals";
import { formatSize } from "../core/screen";
import { Bridge, type Decision } from "../core/bridge";
import { buildRecap } from "./recap";
import { buildWardrobe } from "./wardrobe";
import { buildSettingsFrame } from "./settings-frame";
import { buildLive, openVoiceSettings } from "./live";
import { buildTools } from "./tools";
import { buildMailView } from "./mail-view";
import { isWorkshopChat } from "../core/tools";
import { Live } from "../live/session";
import { buildHome } from "./home";
import { buildBackgroundDetail } from "./background";
import { showGitHubSection } from "./github";
import type { ActivitiesAction, ActivitiesData } from "./activities-view";
import type { ComputerCursor } from "../character/wardrobe";
import { N_, language, t, tl, type Msg } from "../i18n/i18n";
import { mailEditor, type MailEditor } from "./mail-editor";
import type { MailRevision } from "../core/mail-edit";
import { isComputerTool } from "../core/computer";
import { stepPlace } from "../core/computer-plan";
import { computerTargetBox } from "./computer-card";
import { buildComputerView } from "./computer-plan";

export interface ViewActions {
  setView(v: IslandViewName): void;
  /** "Cancel" on a dropped file: forgets it and goes back home. */
  collapse(): void;
  /** Escape in Settings: the island closes and next opens where it usually does, not on Settings. */
  closeSettings(): void;
  /** Folds a waiting card to the compact island without answering it. */
  foldApproval(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  /** Answers `requestId` only if it is still the one waiting. */
  decide(d: Decision, requestId: string): void;
  /** Send on an email's card the user changed: the email as it is on the card, only if `requestId` still waits. */
  sendMail(revised: MailRevision, requestId: string): void;
  /** The island takes the keyboard, so Y and N answer the card on screen. */
  takeKeyboard(): void;
  /** Answers the question Claude Code asked: question text → chosen label. */
  /** Answers the question `requestId` asked, only if it is still the one waiting. */
  answer(answers: Record<string, string | string[]>, requestId: string): void;
  /** Hands the pending request back to the terminal. */
  answerInTerminal(): void;
  setVolume(v: number): void;
  openSettingsWindow(): void;
  blip(): void;
  /** Wardrobe click on Claude's mouse (computer use): keeps it. */
  chooseComputerCursor(cursor: ComputerCursor): void;
  /** Wardrobe click on Aim: the corners before a click, on or off. */
  setComputerAim(on: boolean): void;
  /** The folded Plan island's icon: it comes back. */
  showPlan(): void;
  /** A chat deleted from Past chats: its plans go too. */
  forgetChatPlan(chatId: string): void;
  /** A question of the chat edited: the plan its dropped answers made goes. */
  restartChatPlan(chatId: string): void;
  /** The new look's "⋯" (off with Settings → Island → Previous look): settings, sound, hide and quit in one menu, at (x, y). */
  moreMenu(x: number, y: number): void;
  /** The live activities as they stand, for the new look's home tiles. */
  activityData(): ActivitiesData;
  /** A click on a home tile: as on the live activities' own card. */
  activity(a: ActivitiesAction): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. True = needs another frame. */
  tick?(nowMs: number): boolean | void;
  /**
   * The island's height the view needs to show all it holds at the island
   * width `width`, given the island's size now (`nowW` × `nowH`); null when
   * it can't say. Only views whose content can outgrow their usual height.
   */
  fitHeight?(width: number, nowW: number, nowH: number): number | null;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string | Msg,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** A hook for the new look's stylesheet (look-new.css), which only it reads. */
function withClass<T extends HTMLElement>(el: T, cls: string): T {
  el.classList.add(cls);
  return el;
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: Pick<AgentTask, "color" | "name"> | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

/**
 * Who is asking, on the permission and question cards: the project of the
 * session that asks, on a pill two sessions can share, and "1/N" while other
 * requests wait in line behind this one.
 */
function requestWho(label: string, asker?: Pick<AgentTask, "color" | "name">): HTMLElement {
  const task = State.focusTask;
  const project = State.pendingApproval?.project;
  const waiting = State.approvalQueue.length;
  return agentWho(asker ?? (task && project ? { ...task, name: project } : task), waiting ? `${label} · 1/${waiting + 1}` : label);
}

/** A computer use action's card while a plan runs (computer.rs): who uses it, and at which step. */
const COMPUTER_WHO_TEXT = {
  wants: N_("wants to use the computer"),
  wantsStep: N_("wants to use the computer · step {step} of {total}"),
};

/** Who asks for a computer use action, in the provider's name and colour, or null for the usual who. */
function computerWho(tool: string | undefined): HTMLElement | null {
  const c = State.computer;
  if (!c || !tool || !isComputerTool(tool)) return null;
  const { step, total } = stepPlace(c.steps);
  const label = total ? t(COMPUTER_WHO_TEXT.wantsStep, { step, total }) : t(COMPUTER_WHO_TEXT.wants);
  return requestWho(label, { name: c.agent, color: c.color });
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  // Settings, the sound, Hide and Quit are in the "⋯" menu, as the views are
  // on the home: away from it, the arrow goes back to it.
  const moreBtn = h("button", {
    class: "more-btn", title: tl("More"),
    onclick: (e: Event) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      actions.moreMenu(r.right, r.bottom + 4);
    },
  }, svg(ICONS.ellipsis, 16));
  const backBtn = h("button", { class: "tab back-btn", title: tl("Back"), onclick: () => go(State.agentsView()) },
    svg(ICONS.chevronLeft, 14, { stroke: 2 }));
  // Plan usage pills (off by default): before the "⋯", Claude first.
  const claudePill = buildPlanPill("claude");
  const codexPill = buildPlanPill("codex");
  const antigravityPill = buildPlanPill("antigravity");
  const planPills = h("div", { class: "plan-pills" }, claudePill.el, codexPill.el, antigravityPill.el);
  let codexShown = false;
  let antigravityShown = false;

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, backBtn),
    h("div", { class: "header-actions" }, planPills, moreBtn),
  );
  const headerActions = el.lastElementChild as HTMLElement;

  return {
    el,
    sync() {
      backBtn.classList.toggle("away", State.view !== "home");
      syncPlanPills();
    },
  };

  function syncPlanPills() {
    const claudeOn = claudePillVisible();
    const codexOn = codexPillVisible();
    const antigravityOn = antigravityPillVisible();
    claudePill.el.style.display = claudeOn ? "" : "none";
    codexPill.el.style.display = codexOn ? "" : "none";
    antigravityPill.el.style.display = antigravityOn ? "" : "none";
    // The new look's home has them beside the services (views/home.ts), not up here.
    const onHome = State.view === "home";
    planPills.classList.toggle("on", (claudeOn || codexOn || antigravityOn) && !onHome);
    // Two pills or more: the right side tightens so it still clears the screen edge.
    headerActions.classList.toggle("both-plans", Number(claudeOn) + Number(codexOn) + Number(antigravityOn) >= 2);
    if (claudeOn) claudePill.sync();
    if (codexOn) codexPill.sync();
    if (antigravityOn) antigravityPill.sync();
    // Codex and agy are asked when their pill comes into view (stale answers only).
    const expanded = State.mode === "expanded";
    const shown = codexOn && expanded;
    if (shown && !codexShown) refreshCodexPlanUsage();
    codexShown = shown;
    const agyShown = antigravityOn && expanded;
    if (agyShown && !antigravityShown) refreshAntigravityPlanUsage();
    antigravityShown = agyShown;
  }
}

// ── Overview ──────────────────────────────────────────────────────────────────

/** A pill whose card opens on its detail once it is in front (the home's row of open PRs). */
let detailOnFocus: string | null = null;
/** The pill whose card shows its detail on the overview. */
let detailShownFor: string | null = null;

/** The pill whose card shows its detail, or is about to: the new look's island grows for GitHub's lists (island.ts). */
export function overviewDetailFor(): string | null {
  return detailOnFocus ?? detailShownFor;
}

function buildOverview(actions: ViewActions): ViewHost {
  /** The diff open in the left card (a FileDiff id). */
  let activeDiffId: number | null = null;
  const closeDiff = () => {
    if (activeDiffId == null) return;
    activeDiffId = null;
    State.notify();
  };
  /** The list of the session's steps stands in for the ticker. */
  let stepsOpen = false;
  const closeSteps = () => {
    if (!stepsOpen) return;
    stepsOpen = false;
    State.notify();
  };
  const steps = new StepsCard({
    dismiss: () => {
      actions.blip();
      closeSteps();
    },
    openDiff: (diffId) => {
      actions.blip();
      activeDiffId = diffId;
      State.notify();
    },
  });
  const ticker = new Ticker(({ seq, diffId }) => {
    actions.blip();
    if (diffId != null) {
      activeDiffId = diffId;
    } else {
      const task = State.focusTask;
      if (!task) return;
      stepsOpen = true;
      steps.show(task, seq);
    }
    State.notify();
  });
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: tl("Open"), onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  const pills = h("div", { class: "pills" });
  const right = card(null, pills);
  // Opened from a plan pill in the header: stands in for the left card.
  const plan = new PlanCard();
  let planTimer: number | null = null;

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let pillIds = "";
  /** The pills beside the card, as last laid out. */
  let pillOrder: string[] = [];
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "steps" | "card" | "plan" | "diff" | "background" | null = null;
  let cardKey = "";

  // Leaving the overview or folding the island closes the diff.
  State.subscribe(() => {
    if (State.view !== "overview" || State.mode !== "expanded") {
      activeDiffId = null;
      stepsOpen = false;
    }
  });
  // Escape steps back out of the diff, then the list of steps, before it closes the island.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || (activeDiffId == null && !stepsOpen) || State.view !== "overview") return;
      e.stopImmediatePropagation();
      if (activeDiffId != null) closeDiff();
      else closeSteps();
    },
    true,
  );

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      detailShownFor = State.focusTask?.id ?? null;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      detailShownFor = null;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
    openChat: () => actions.setView("prompt"),
  };

  /** The countdowns move every 30 s while a card is open, and only then. */
  function syncPlanTimer(open: boolean) {
    const stop = () => {
      if (planTimer != null) window.clearInterval(planTimer);
      planTimer = null;
    };
    if (!open) return stop();
    if (planTimer != null) return;
    planTimer = window.setInterval(() => {
      if (planCardOpen() && State.mode === "expanded") State.notify();
      else stop();
    }, 30_000);
  }

  return {
    el,
    tick(nowMs: number) {
      if (mode !== "ticker") return false;
      ticker.tick(nowMs);
      return ticker.animating;
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        detailShownFor = null;
        activeDiffId = null;
        stepsOpen = false;
        cardKey = "";
        mode = null;
      }
      if (detailOnFocus != null && task?.id === detailOnFocus) {
        detailOnFocus = null;
        detailOpen = true;
        detailShownFor = task.id;
        cardKey = "";
      }

      // A workspace or agent pill with a live session keeps the ticker; every
      // other pill shows its own card, exactly like IntegrationCardView.
      const sessionActive = task != null && hasSessionTicker(task);

      const planOpen = planCardOpen();
      if (mode === "plan" && !planOpen) {
        mode = null;
        cardKey = "";
      }
      syncPlanTimer(planOpen);

      // A diff that has since been dropped (cap, expiry, session end) just closes.
      const diff = task && activeDiffId != null ? State.findDiff(task.id, activeDiffId) : null;
      if (!diff) activeDiffId = null;

      if (planOpen) {
        if (mode !== "plan") {
          clear(leftBody);
          leftBody.append(plan.el);
          mode = "plan";
        }
        plan.sync();
      } else if (task && diff) {
        const key = `diff~${task.id}~${diff.id}`;
        if (key !== cardKey) {
          cardKey = key;
          mode = "diff";
          clear(leftBody);
          leftBody.append(buildDiffCard(diff, {
            dismiss: () => {
              actions.blip();
              closeDiff();
            },
            open: (path) => void Bridge.openFileInVSCode(path),
          }));
        }
      } else if (task?.background && !stepsOpen) {
        // A program's sessions in the background: what runs, the last answer, the errors.
        const info = task.background;
        const key = `bg~${language()}~${task.id}~${task.name}~${task.state}~${JSON.stringify(info)}`;
        if (key !== cardKey || mode !== "background") {
          cardKey = key;
          mode = "background";
          clear(leftBody);
          leftBody.append(buildBackgroundDetail(task, info, () => {
            actions.blip();
            stepsOpen = true;
            steps.show(task, task.stepSeq ?? task.steps.length - 1);
            State.notify();
          }));
        }
      } else if (task && sessionActive && stepsOpen && task.steps.length > 0) {
        if (mode !== "steps") {
          clear(leftBody);
          leftBody.append(steps.el);
          mode = "steps";
          cardKey = "";
        }
        steps.sync(task);
      } else if (task && sessionActive) {
        stepsOpen = false;
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        // The agent's name is already the pill's: the label says what kind of
        // pill it is (the catalog's sessionSubtitle).
        who.append(
          dot(task.color, 7),
          // A titled session goes by its title, with the pill's name (its folder) beside it.
          h("span", { class: "name", text: task.sessionTitle || task.name }),
          h("span", { class: "tool", text: task.sessionTitle ? task.name : t(sessionSubtitle(task.id)) }),
        );
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          language(), task.id, task.color, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}), idleCardKey(task.id),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen || mode === "plan" || mode === "diff" || mode === "background" ? "none" : "";

      // Each pill stays in its place when another goes to the card.
      const others = keepPillPlaces(pillOrder, State.otherTasks);
      pillOrder = others.map((t) => t.id);
      const pillKey = others.map((t) => `${t.id}:${t.color}:${t.pillBadge ?? ""}`).join("|");
      if (pillKey !== pillIds) {
        pillIds = pillKey;
        clear(pills);
        for (const t of others) pills.append(buildPill(t, actions));
        pruneMiniBots();
      }
    },
  };
}

/**
 * IntegrationCardView.agentSessionActive: a workspace tool or an agent — or
 * any other tagged agent — with something going on.
 */
export function hasSessionTicker(task: AgentTask): boolean {
  // A pill made for an agent's session (Gemini CLI, Codex… not declared) only
  // exists while that session does: it keeps the ticker from the first event.
  if (task.source === "agent" && !task.isIntegration) return true;
  const category = pillDefinition(task.id)?.category;
  const isSession = category === "workspace" || category === "agent" ||
    (category == null && task.id.startsWith("agent_"));
  return isSession && (task.state !== "idle" || task.steps.length > 0);
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  const label = task.id === "integration_claude" ? "VS Code" : task.name;
  const canvas = createMiniBot(task, 24);
  const pill = h(
    "div",
    { class: "pill", onclick: () => actions.setFocus(task.id) },
    canvas,
    h("span", { class: "lbl", text: label }),
    h("span", { class: "pill-end" }),
  );
  pill.style.borderColor = `${task.color}24`;
  pill.style.setProperty("--pill-color", task.color);
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
    (pill.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Approval ──────────────────────────────────────────────────────────────────

/** How long a fresh permission card ignores clicks on its buttons. */
const CLICK_GUARD_MS = 600;
/**
 * Y or N answers only as a key of its own: pressed this long after any other
 * key. A card that pops up while the chat is being typed in must not take the
 * next letter of a word as an answer.
 */
const KEY_QUIET_MS = 800;

/**
 * The ⌃ in the corner of a waiting card: folds the island to its compact size
 * and leaves the request waiting — nothing is answered. Opening the
 * island again brings the card back.
 */
function foldButton(actions: ViewActions): HTMLElement {
  return h(
    "button",
    { class: "icon-btn fold", title: tl("Later — keep it waiting"), "aria-label": tl("Later — keep it waiting"), onclick: () => actions.foldApproval() },
    svg(ICONS.chevronUp, 10, { stroke: 2.4 }),
  );
}

/** The card of an email the AI wants to send (mail.rs send): the email itself is views/mail-editor.ts. */
const EMAIL_TEXT = {
  wants: N_("wants to send an email"),
  send: N_("Send"),
  discard: N_("Discard"),
};

/** The new look's card for a plan Claude Code asks to start (concept C2). */
const PLAN_ASK_TEXT = {
  wants: N_("wants to start the plan"),
  keepPlanning: N_("No, keep planning"),
  approve: N_("Approve"),
  approveEdits: N_("Approve and let it edit files without asking"),
};

/**
 * A button's words for a plan asking to start, next to its usual ones: the
 * stylesheet shows one or the other (look-new.css, .plan-ask-on), so the
 * button is never rebuilt under the cursor.
 */
function planWords(button: HTMLElement, words: string): HTMLElement {
  button.firstElementChild?.classList.add("words-usual");
  button.insertBefore(h("span", { class: "words-plan", text: tl(words) }), button.children[1] ?? null);
  return button;
}

/** Under the buttons of a card whose Allow is kept for the rest of the chat. */
const REMEMBERED_TEXT = N_("In Auto, Allow counts for the rest of the chat");

/** A request too long to reach the island whole (`cut`): the card shows its beginning, and says so. */
const CUT_TEXT = {
  note: N_("Too long to show here whole: this is its beginning."),
  noteSize: N_("Too long to show here whole: this is its beginning ({size} in all)."),
};

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const about = h("div", { class: "approval-about" });
  const planSlot = h("div", { class: "plan-ask-slot" });
  // The whole command, wrapped, scrolling past a few lines: Allow allows all of it.
  const code = h("div", { class: "code approval-code" });
  code.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
  // A computer use action: what it acts on (views/computer-card.ts), in the command's place.
  const targetSlot = h("div", { class: "computer-target-slot" });
  let targetFor: string | null = null;
  let targetBox: HTMLElement | null = null;
  const cutNote = h("div", { class: "approval-cut" });
  // A file to write: its lines added and removed, and a new text's size (the text is not shown).
  const stat = h("div", { class: "approval-stat" });
  const mail = h("div", { class: "mail-slot" });
  const row = h("div", { class: "actions approval-actions" });
  // An email's card has its own buttons, Send and Discard, and no keys: only a
  // click sends. Beside them what the email's editor says, and its Attach.
  const mailRow = h("div", { class: "actions mail-actions" });
  const mailNote = h("div", { class: "mail-note-slot" });
  const mailAttach = h("div", { class: "mail-attach-slot" });
  let editor: MailEditor | null = null;
  const sendBtn = btn(tl(EMAIL_TEXT.send), "primary", () => {
    if (!editor) return guarded("allow")();
    const out = editor.send();
    if (out.kind === "same") guarded("allow")();
    else if (out.kind === "changed" && performance.now() - shownAt >= CLICK_GUARD_MS && shownFor != null) actions.sendMail(out.revised, shownFor);
  });
  const sessionAllow = btn(tl("Allow for this session"), "secondary", () => guarded("always")());
  // A plan Claude Code asks to start: approved, and then it edits files without asking (its acceptEdits, for the session).
  const planEdits = btn(tl(PLAN_ASK_TEXT.approveEdits), "secondary", () => guarded("edits")());
  // An agent that can ask in its own window (Antigravity): the request goes back there, unanswered.
  const answerThere = btn("", "secondary", () => {
    if (performance.now() - shownAt >= CLICK_GUARD_MS) actions.answerInTerminal();
  });
  // Copilot CLI and Cursor CLI in Auto: Allow stands for the rest of the chat, and the card says so (new look only).
  const rememberedNote = h("div", { class: "session-allow session-note", text: tl(REMEMBERED_TEXT) });
  const allowBtn = withClass(planWords(btn(tl("Allow"), "primary", () => guarded("allow")(), "Y"), PLAN_ASK_TEXT.approve), "allow-btn");
  const body = stack(116, 16, who, about, planSlot, code, targetSlot, stat, cutNote, mail, row, mailRow);
  let planFor: string | null = null;
  const el = h("div", { class: "view" }, card("amber", body, foldButton(actions)));
  let mailFor: string | null = null;
  let rowKey = "";
  // The card pops up under a cursor that was busy with something else: a click
  // meant for the window underneath must not land on Allow. Clicks in the first
  // moments after a new request appears are ignored.
  let shownFor: string | null = null;
  let shownAt = 0;
  /** The island around the card, for fitHeight. */
  let fitChrome: { w: number; h: number } | null = null;
  const guarded = (d: Decision) => () => {
    if (performance.now() - shownAt < CLICK_GUARD_MS) return;
    // The request on screen: one that just took its place from the line is not drawn yet.
    if (shownFor != null) actions.decide(d, shownFor);
  };
  // The island never takes the keyboard by itself (typing in another app is
  // never cut off): a click on the card gives it, as the shortcut to the
  // waiting card does.
  el.addEventListener("mousedown", () => {
    if (State.pendingApproval && !State.pendingApproval.questions) {
      armApprovalKeys(State.pendingApproval.requestId);
      actions.takeKeyboard();
    }
  });
  // Then Y and N answer, as the buttons say, even with the chat field holding
  // the keyboard. Only while the island has it: in another app they are just
  // letters, never an answer. And only once the user turned to this card (a
  // click on it, its shortcut): before that they are the chat's letters.
  let lastKeyAt = -Infinity;
  const cardOnScreen = () => {
    const req = State.pendingApproval;
    return State.mode === "expanded" && State.view === "approval" && req != null && !req.questions && !req.email;
  };
  const answerKey = (d: "allow" | "deny") => {
    const previous = lastKeyAt;
    lastKeyAt = performance.now();
    if (lastKeyAt - previous < KEY_QUIET_MS) return;
    guarded(d)();
  };
  window.addEventListener(
    "keydown",
    (e) => {
      if (!cardOnScreen()) {
        lastKeyAt = performance.now();
        return;
      }
      const d = approvalKey(e);
      if (!d || !approvalKeysArmed(State.pendingApproval?.requestId)) {
        lastKeyAt = performance.now();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      answerKey(d);
    },
    true,
  );
  return {
    el,
    // The card's usual height holds a command on one line. A longer one (a
    // commit message, a script: up to six lines before it scrolls), the line
    // that says why there is no Allow, a reason on two lines: the island grows
    // so that who asks and the buttons stay on it. Measured on a copy laid out
    // at the width the island is going to, not the one it is passing through.
    fitHeight(width, nowW, nowH) {
      if (body.classList.contains("mail-on")) return null;
      // What the island has around the card (its header, its edges) is the
      // same at any size: read whenever the card has room, as on an open
      // island, and kept for the closed one opening onto it.
      if (body.offsetWidth > 40 && body.offsetHeight > 40) fitChrome = { w: nowW - body.offsetWidth, h: nowH - body.offsetHeight };
      if (!fitChrome) return null;
      const copy = body.cloneNode(true) as HTMLElement;
      copy.setAttribute("aria-hidden", "true");
      Object.assign(copy.style, {
        position: "absolute", left: "0", top: "0", visibility: "hidden", pointerEvents: "none",
        height: "auto", width: `${Math.max(0, width - fitChrome.w)}px`,
      });
      body.after(copy);
      const need = copy.offsetHeight;
      copy.remove();
      return Math.ceil(need + fitChrome.h);
    },
    sync() {
      const req = State.pendingApproval?.requestId ?? null;
      if (req !== shownFor) {
        shownFor = req;
        shownAt = performance.now();
      }
      const pending = State.pendingApproval;
      const email = pending?.email ?? null;
      // A plan asking to start shows as its steps, with its own words on the buttons.
      const plan = !email && pending?.plan?.length ? pending.plan : null;
      clear(who);
      who.append(computerWho(!email && !plan ? pending?.tool : undefined)
        ?? requestWho(email ? t(EMAIL_TEXT.wants) : plan ? t(PLAN_ASK_TEXT.wants) : t("needs permission")));
      if ((plan ? req : null) !== planFor) {
        planFor = plan ? req : null;
        clear(planSlot);
        if (plan) planSlot.append(planAskSteps(plan));
      }
      planSlot.hidden = !plan;
      body.classList.toggle("plan-ask-on", !!plan);
      // An email to send: the whole email, and Send or Discard.
      if ((email ? req : null) !== mailFor) {
        mailFor = email ? req : null;
        clear(mail);
        clear(mailNote);
        clear(mailAttach);
        editor = email ? mailEditor(email, (blocked) => sendBtn.classList.toggle("off", blocked)) : null;
        if (editor) {
          mail.append(editor.el);
          mailNote.append(editor.note);
          mailAttach.append(editor.attach);
        }
      }
      mail.hidden = !email;
      // The email fills the card from the top, clear of the fold button and of its edges.
      body.classList.toggle("mail-on", !!email);
      // Asked again for each new request: the box fills itself in when it can.
      const targetReq = pending && !email && !plan ? req : null;
      if (targetReq !== targetFor) {
        targetFor = targetReq;
        clear(targetSlot);
        targetBox = pending && targetReq ? computerTargetBox(pending) : null;
        if (targetBox) targetSlot.append(targetBox);
      }
      targetSlot.hidden = !targetBox;
      code.hidden = !!email || !!plan || !!targetBox;
      row.hidden = !!email;
      mailRow.hidden = !email;
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      const target = pending?.command || pending?.tool || "…";
      const tool = pending?.tool ?? "";
      // The tool's name stands apart, in Lumo's amber, from what it runs on.
      if (tool && target.startsWith(`${tool} · `)) {
        clear(code);
        code.append(h("span", { class: "code-tool", text: tool }), target.slice(tool.length + 3));
      } else {
        code.textContent = target;
      }
      code.title = target;
      // Which of the card's buttons and lines it offers (core/approvals.ts).
      const offer = approvalOffer(pending);
      cutNote.hidden = !offer.cutNote;
      const cutText = pending?.cutBytes ? t(CUT_TEXT.noteSize, { size: formatSize(pending.cutBytes) }) : t(CUT_TEXT.note);
      if (cutNote.textContent !== cutText) cutNote.textContent = cutText;
      allowBtn.style.display = offer.allow ? "" : "none";
      const edit = !email && !plan ? pending?.edit ?? null : null;
      clear(stat);
      if (edit) {
        if (edit.added > 0) stat.append(h("span", { class: "plus", text: `+${edit.added}` }));
        if (edit.removed > 0) stat.append(h("span", { class: "minus", text: `−${edit.removed}` }));
        if (edit.bytes != null) stat.append(h("span", { class: "size", text: formatSize(edit.bytes) }));
      }
      stat.hidden = !stat.childElementCount;
      // What it is for: the agent's own words, else what the request does.
      const text = email ? "" : pending?.reason ?? (pending?.kind ? t(pending.kind.text, pending.kind.vars) : "");
      about.textContent = text;
      about.title = text;
      about.hidden = !text || !!plan;
      // "Allow for this session" only where the request has a session to be
      // kept for (session_rules.rs): shown or hidden, never rebuilt.
      sessionAllow.style.display = offer.sessionAllow ? "" : "none";
      // In its place on a plan asking to start, from a session (the island's chat has its own way).
      planEdits.style.display = offer.planEdits ? "" : "none";
      answerThere.style.display = offer.answerThere ? "" : "none";
      rememberedNote.style.display = pending?.remembered === true && !plan ? "" : "none";
      const answerWords = offer.answerThere === "agent" && pending?.answerIn ? t("Reply in {agent}", { agent: pending.answerIn }) : "";
      if (answerThere.firstElementChild && answerThere.firstElementChild.textContent !== answerWords) answerThere.firstElementChild.textContent = answerWords;

      sessionAllow.title = t("Allowed again without asking until this session ends");
      // The buttons are built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        withClass(planWords(btn(tl("Deny"), "secondary", guarded("deny"), "N"), PLAN_ASK_TEXT.keepPlanning), "deny-btn"),
        withClass(sessionAllow, "session-allow"),
        withClass(planEdits, "session-allow"),
        withClass(answerThere, "session-allow"),
        rememberedNote,
        allowBtn,
      );
      clear(mailRow);
      mailRow.append(btn(tl(EMAIL_TEXT.discard), "secondary", guarded("deny")), sendBtn, mailNote, mailAttach);
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title question-text" });
  const row = h("div", { class: "actions options question-options" });
  const fold = foldButton(actions);
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row), fold));

  // Where we are in the request on screen: which question, what is answered so
  // far, and what is ticked in a pick-several question.
  let requestId = "";
  let index = 0;
  let answers: Record<string, string | string[]> = {};
  let picked = new Set<string>();
  // The buttons are only rebuilt when what they show changes: rebuilding them
  // between a mouse-down and a mouse-up would swallow the click.
  let rowKey = "";
  // Like the permission card: a question (or the next one of a request) pops up
  // under a cursor that was busy with something else, so a click in its first
  // moments is not taken as an answer.
  let shownKey = "";
  let shownAt = 0;
  const settled = () => performance.now() - shownAt >= CLICK_GUARD_MS;

  const next = (question: string, answer: string | string[], total: number) => {
    answers[question] = answer;
    picked = new Set();
    index += 1;
    if (index >= total) actions.answer(answers, requestId);
    else State.notify();
  };

  return {
    el,
    sync() {
      const questions = State.pendingApproval?.questions;
      clear(who);
      // Only a request that is waiting can be folded away and come back.
      fold.style.display = State.pendingApproval ? "" : "none";

      // A question that arrived as a notification has nothing to pick from.
      if (!questions) {
        who.append(agentWho(State.focusTask, t("is asking a question")));
        const task = State.focusTask;
        title.textContent = (task && lastTextStep(task.steps)) ?? t("Claude needs an answer.");
        if (rowKey !== "terminal") {
          rowKey = "terminal";
          clear(row);
          row.append(h("div", { class: "sub", text: tl("Answer it in your terminal.") }));
        }
        return;
      }

      if (State.pendingApproval!.requestId !== requestId) {
        requestId = State.pendingApproval!.requestId;
        index = 0;
        answers = {};
        picked = new Set();
      }
      const q = questions[Math.min(index, questions.length - 1)];
      if (`${requestId}:${index}` !== shownKey) {
        shownKey = `${requestId}:${index}`;
        shownAt = performance.now();
      }
      const asking = questions.length > 1
        ? t("is asking ({index} of {total})", { index: index + 1, total: questions.length })
        : t("is asking");
      who.append(requestWho(asking));
      title.textContent = q.question;
      title.title = q.question;

      const key = `${requestId}:${index}:${[...picked].join("|")}`;
      if (rowKey === key) return;
      rowKey = key;
      clear(row);
      for (const option of q.options) {
        const on = picked.has(option.label);
        const button = btn(option.label, on ? "primary" : "secondary", () => {
          if (!settled()) return;
          if (!q.multiSelect) {
            next(q.question, option.label, questions.length);
            return;
          }
          if (on) picked.delete(option.label);
          else picked.add(option.label);
          State.notify();
        });
        if (option.description) {
          button.title = option.description;
          // Under the label in the new look (look-new.css); the usual one keeps it in the tooltip.
          button.append(h("span", { class: "q-desc", text: option.description }));
        }
        button.classList.add("q-option");
        row.append(button);
      }
      if (q.multiSelect) {
        const done = btn(tl("Done"), "primary", () => {
          if (settled() && picked.size > 0) next(q.question, [...picked], questions.length);
        });
        if (picked.size === 0) done.classList.add("off");
        row.append(done);
      }
      row.append(
        h("button", {
          class: "link-btn",
          style: "color:#8e939c",
          text: tl("Answer in terminal"),
          onclick: () => {
            if (settled()) actions.answerInTerminal();
          },
        }),
      );
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

/** Claude Code's StopFailure `error`, said plainly (code.claude.com/docs/en/hooks). */
const FAILURE_TEXT: Record<string, string> = {
  rate_limit: N_("Usage limit reached"),
  overloaded: N_("Claude's servers are overloaded"),
  authentication_failed: N_("Sign-in failed"),
  oauth_org_not_allowed: N_("Sign-in failed"),
  cloud_credential_error: N_("Sign-in failed"),
  account_on_hold: N_("The account is on hold"),
  billing_error: N_("A billing problem on the account"),
  invalid_request: N_("The request was refused"),
  model_not_found: N_("Model not found"),
  server_error: N_("Server error"),
  max_output_tokens: N_("The answer hit its length limit"),
};

const ERROR_TEXT = {
  lastStep: N_("Last step: {step}"),
};

/**
 * Why a turn stopped, for the error card: Claude Code's reason in words, with
 * its code beside it; else what it said about it; else what the agent sent.
 */
export function failureWords(failure: { code: string; details: string } | null | undefined): { text: string; code: string } | null {
  if (!failure) return null;
  const known = FAILURE_TEXT[failure.code];
  if (known) return { text: t(known), code: failure.code };
  const text = failure.details || toOneLine(failure.code);
  return text ? { text, code: "" } : null;
}

/** The error card has a second line, the last step in grey, under the reason (layout.ts errorCardHeight). */
export function errorHasLastStep(task: AgentTask | null): boolean {
  return failureWords(task?.failure) != null && task != null && lastTextStep(task.steps) != null;
}

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const reason = h("span");
  const code = h("span", { class: "err-code" });
  const detail = h("div", { class: "detail" }, reason, code);
  const last = h("div", { class: "detail-last" });
  // Where the session can really go on: its terminal (Claude, for the desktop app's).
  const open = btn(tl("Open terminal"), "primary", () => actions.openTerminal());
  const openN8n = btn(tl("Open in n8n"), "primary", () => void Bridge.openN8n());
  const row = h("div", { class: "actions" },
    open,
    openN8n,
    // Closes the card at once, even with the mouse still on the island.
    btn(tl("Close"), "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, last, row)));
  return {
    el,
    sync() {
      const task = State.focusTask;
      clear(who);
      // agentWho already shows an agent's name: its label is just the kind.
      const whoLabel = task?.source === "n8n" ? "n8n" : task?.source === "agent" ? t("Agent") : "Claude Code";
      who.append(agentWho(task, whoLabel));
      title.textContent = task?.source === "n8n" ? t("Workflow stopped.") : t("Session stopped on an error.");
      // In red what went wrong; the last step, often the request it was working on, in grey under it.
      const step = task ? lastTextStep(task.steps) : null;
      const why = failureWords(task?.failure);
      reason.textContent = why?.text ?? step ?? t("No detail available.");
      code.textContent = why?.code ? ` (${why.code})` : "";
      last.textContent = why && step ? t(ERROR_TEXT.lastStep, { step }) : "";
      last.hidden = !last.textContent;
      // Only an n8n workflow has somewhere in n8n to open; anything else, a terminal.
      const n8n = task?.source === "n8n";
      openN8n.style.display = n8n ? "" : "none";
      open.style.display = n8n ? "none" : "";
      const label = task?.id === "agent_claude-desktop" ? t("Open Claude") : t("Open terminal");
      const span = open.firstElementChild as HTMLElement;
      if (span.textContent !== label) span.textContent = label;
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  // Claude's final message, up to three lines (look-new.css .title.final).
  const title = h("div", { class: "title final" });
  const open = btn(tl("Open terminal"), "primary", () => actions.openTerminal());
  const row = h("div", { class: "actions" },
    open,
    btn(tl("OK"), "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      const agent = State.focusTask?.source === "agent";
      who.append(agentWho(State.focusTask, agent ? t("finished") : t("Claude Code finished")));
      // The final message, else the last step that is not a diff (FinishedView).
      const task = State.focusTask;
      const text = finishedText(task);
      title.textContent = text;
      title.title = text;
      // Sessions from the Claude desktop app live there, not in a terminal.
      const label = task?.id === "agent_claude-desktop" ? t("Open Claude") : t("Open terminal");
      const span = open.firstElementChild as HTMLElement;
      if (span.textContent !== label) span.textContent = label;
    },
  };
}

/** What the finished card says: Claude's final message, else the last step, else that it is done. */
export function finishedText(task: AgentTask | null): string {
  return task?.finalLine || (task && lastTextStep(task.steps)) || t("Session finished");
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(actions: ViewActions): ViewHost {
  const title = h("div", { class: "title" });
  // Closes the note at once, even with the mouse still on the island.
  const row = h("div", { class: "actions" }, btn(tl("Close"), "secondary", () => actions.collapse()));
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px;gap:12px" }, title, row)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────

/** The new look's home (views/home.ts), on the island's actions. */
function buildHomeView(actions: ViewActions): ViewHost {
  const openChat = () => {
    State.useSlot("chat");
    actions.setView("prompt");
  };
  const home = buildHome({
    openSession: (id) => {
      actions.blip();
      actions.setFocus(id);
      actions.setView("overview");
    },
    // The Email tile: the Email view, every address's emails.
    openMail: () => {
      actions.blip();
      actions.setView("mail");
    },
    openGitHubPRs: () => {
      showGitHubSection("myPRs");
      detailOnFocus = "integration_github";
      actions.blip();
      actions.setFocus("integration_github");
      actions.setView("overview");
    },
    openRequest: () => {
      const req = State.pendingApproval;
      if (req) actions.setView(State.requestView(req));
    },
    decide: (d, requestId) => actions.decide(d, requestId),
    openChat,
    // The tool workshop, as Tools' "Add a tool" opens it (views/tools.ts openWorkshop).
    makeTool: () => {
      actions.blip();
      State.forgeAsk = { edit: null };
      State.useSlot("forge");
      actions.setView("prompt");
    },
    // A chat's row on the home: that chat (or workshop chat) open on screen.
    openChatPlan: (chatId) => {
      actions.blip();
      State.useSlot(isWorkshopChat(chatId) ? "forge" : "chat");
      State.chatToOpen = chatId;
      actions.setView("prompt");
    },
    openUrl: (url) => actions.openUrl(url),
    // A plan's usage on the home opens its card, as its pill does on the overview.
    openPlan: (kind) => {
      actions.blip();
      openPlanCard(kind);
      actions.setView("overview");
    },
    activityData: () => actions.activityData(),
    activity: (a) => actions.activity(a),
    blip: () => actions.blip(),
  }, hasSessionTicker);
  return { el: home.el, sync: () => home.sync(), tick: () => home.tick() };
}

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion(actions));
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("note", buildNote(actions));
  map.set("settings", buildSettingsFrame(actions));
  map.set("prompt", buildPrompt(onChatHeightChange, () => actions.setView("settings"), () => {
    actions.setView("live");
    void Live.start();
  }, () => {
    actions.blip();
    actions.showPlan();
  }, (chatId) => actions.forgetChatPlan(chatId), () => {
    actions.blip();
    actions.setView("tools");
  }, (d, requestId) => actions.decide(d, requestId), (chatId) => actions.restartChatPlan(chatId)));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("recap", buildRecap(actions));
  map.set("wardrobe", buildWardrobe(actions));
  map.set("live", buildLive(() => openVoiceSettings(actions.setView)));
  map.set("tools", buildTools(actions));
  map.set("mail", buildMailView(actions));
  map.set("home", buildHomeView(actions));
  map.set("computer", buildComputerView({ takeKeyboard: () => actions.takeKeyboard() }));
  return map;
}
