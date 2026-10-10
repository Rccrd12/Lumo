// The island: DOM shell, sizing animation, Mochi placement, mouse handling.
// Mirrors IslandRootView.swift + IslandWindowController.swift.

import { Tracked, Spring, clamp } from "../core/anim";
import { Bridge, IS_TAURI, isDialogOpen, onDragDrop } from "../core/bridge";
import {
  CHAT_PANEL_OPEN, EXPANDED_CORNER, edgeGap, EXPANDED_W, NOTCH_W,
  ROUNDED_CORNER, VIEW_LAYOUTS, botGlowColor, botGlowOpacity, botPosition, chatHeight,
  GRIPS, gripFactors, isUpright, islandSize, parseDock, type Dock, type Grip, type IslandShape,
  QUESTION_PICKER_H,
  type BotEmoteName, type IslandMode, type IslandViewName,
  zoomStep,
} from "../core/layout";
import { Sound } from "../core/sound";
import { NEUTRAL_PILL } from "../core/pill-colors";
import { State, motionAmount, parseCloseMode } from "../core/state";
import { BotEngine, hexToRGB } from "../mochi/engine";
import { Greeting } from "../mochi/greeting";
import { syncMiniBotStates, tickMiniBots } from "../mochi/minibots";
import { SeasonCache, parseLook, parseOutfit, type LumoLook } from "../mochi/wardrobe";
import { UploadCanvas } from "../upload/canvas";
import { USC, UploadSeq } from "../upload/sequence";
import { closePlanCard, openPlanColor, planCardOpen } from "../views/usage";
import { buildHeader, buildViews, type ViewActions, type ViewHost } from "../views/views";
import { h } from "../views/dom";
import { IslandStateMachine } from "./fsm";
import { CompactStrip } from "./compact";
import { ACTIVITIES_GAP, IslandActivities } from "./activities";
import type { MailMessage } from "../core/bridge";
import { refreshConfigured, refreshHookPills } from "./integrations";
import { ContextMenu, textEntries, type MenuEntry } from "../views/context-menu";
import { MENU_TEXT, pickedItems } from "../core/context-menu";
import { compactNotice, compactTimer, setCompactNewsHandler } from "../core/compact";
import { refreshClaudePlanOnline, refreshCodexPlanUsage } from "../views/usage";
import { reloadRecap } from "../views/integrations";
import { isHookPill, pillDefinition } from "../core/pills";
import { isComputerTool } from "../core/computer";
import { t } from "../i18n/i18n";
import { Calendar } from "./activities";
import { DesktopLink } from "./desktop";
import { DRAG_THRESHOLD } from "../mochi/desktop-logic";

/** A view change this soon after a click or shortcut counts as asked for (ms). */
const GESTURE_WINDOW = 1500;
/** How far a press on the island's top travels before it moves the island. */
const MOVE_THRESHOLD = 4;
/** The open island's top bar (8 pt inset + 34 pt header): pressing there can move it. */
const TOP_BAR_H = 42;
/** "Close when the mouse leaves": a short grace, so brushing past the edge doesn't fold it (s). */
const LEAVE_CLOSE_DELAY = 0.6;
/**
 * After a shortcut opened the island (open the island, open the chat, a
 * sharing one…), how long it stays open with the mouse elsewhere (s); each
 * key typed in it gives it this long again.
 */
const SHARE_GRACE = 10;
/** "Open on hover": how long the mouse rests on the closed island before it opens (ms). */
const HOVER_OPEN_DELAY = 350;

/** Buttons, fields and links keep their own press: they never start a move. */
function isControl(target: EventTarget | null): boolean {
  return target instanceof Element &&
    target.closest("button, input, textarea, select, a, [contenteditable], .edge, .picker") != null;
}

const BOT_OVERHANG = 40;
const CLAUDE_DESKTOP_ID = "agent_claude-desktop";
/** Extra canvas on each side of Mochi, for the witch hat's brim and the Santa hat's tip. */
const BOT_SIDE = 24;
/** Same margin as the Rust hit test (src-tauri/src/island.rs). */
const HIT_MARGIN = 14;

/** The three views the drop sequence owns; leaving them stops the engine. */
const UPLOAD_VIEWS: ReadonlySet<IslandViewName> = new Set(["upload", "uploading", "choose"]);

/** Seconds between the drop and the moment the progress bar starts filling. */
const PRE_PROGRESS = USC.T_PROG_START - USC.T_DROP;

/** Views the live activities stay away from: the greeting, Settings, the wardrobe, a drop. */
const NO_ACTIVITIES: ReadonlySet<IslandViewName> = new Set(["greeting", "settings", "wardrobe", "upload", "uploading", "choose"]);

const modeOrder = (m: IslandMode) => (m === "hidden" ? 0 : m === "compact" ? 1 : 2);

export class Island {
  readonly fsm = new IslandStateMachine();
  /** Mochi on the desktop: his life cycle and the drag out of the island. */
  readonly desktop: DesktopLink;

  private root: HTMLElement;
  private islandEl!: HTMLElement;
  private clipEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private viewsEl!: HTMLElement;
  private botCanvas!: HTMLCanvasElement;
  private botGlow!: HTMLElement;
  private greetingCanvas!: HTMLCanvasElement;
  private countdown!: HTMLElement;
  /** What the closed island says next to Lumo (island/compact.ts). */
  private compact!: CompactStrip;
  /** Lumo's own right-click menu (views/context-menu.ts). */
  private menu!: ContextMenu;
  /** The live activities beside the open island (island/activities.ts). */
  private activities!: IslandActivities;
  /** The island's height when the live activities first showed: theirs since. */
  private activitiesStartH: number | null = null;
  private wakeStrip!: HTMLElement;
  /** Grips on the island's free edges and corners: dragging them resizes it. */
  private grips: { el: HTMLElement; grip: Grip }[] = [];
  private resizing = false;
  /** Moving and resizing follow the global cursor, which Wayland does not give. */
  private canResize = true;
  private lastShape = "";
  /** A press on the island's top that becomes a move once the mouse travels. */
  private pendingMove: { x: number; y: number; click: boolean } | null = null;
  /** Between picking the island up and it settling on an edge. */
  private moving = false;
  /** When the user last pressed on the island or used a shortcut: what lets the chat take the keyboard. */
  private lastGesture = 0;
  /** Lifted while carried: a little bigger, springing back when put down. */
  private lift = new Tracked(1);
  /** Between the island and its edge of the screen, eased when Settings changes it. */
  private gap = new Tracked(edgeGap(undefined));
  /** The gap Settings asked for last; null before the first settings arrived. */
  private gapTarget: number | null = null;
  /** Puts a moved island down should Rust never say where it went. */
  private settleTimer: number | null = null;
  /** Opens the closed island once the mouse has rested on it (Settings → Island). */
  private hoverOpenTimer: number | null = null;
  /** The mouse is on the closed island's own buttons. */
  private onControls = false;
  /** Page pixels the island is drawn off its usual place (a floating island, island.rs shift). */
  private shift = { x: 0, y: 0 };
  /** The edge last drawn, to notice when Settings or the tray move it. */
  private lastDock: Dock | null = null;

  private header!: ViewHost;
  private views!: Map<IslandViewName, ViewHost>;
  private uploadCanvas!: UploadCanvas;

  private width = new Tracked(NOTCH_W);
  private height = new Tracked(0);
  private radius = new Tracked(ROUNDED_CORNER);
  private botCx = new Spring(46);
  private botCy = new Spring(16);
  private botSize = new Spring(10);

  private engine = new BotEngine();
  private greeting = new Greeting();
  private greetingShown = false;
  private seasons = new SeasonCache();

  private running = false;
  private lastFrame = 0;
  private dirty = true;
  private canvasPx = 0;
  /** The display scale the bot and greeting canvases were sized for. */
  private canvasDpr = 0;
  private greetingDpr = 0;

  // Rust starts the window at full size so the launch greeting has room.
  private collapsed = false;
  private collapseTimer: number | null = null;
  private wasInIsland = false;
  /** Last shape handed to Rust for the click-through test. */
  private pushedRect = { x: -1, y: -1, w: -1, h: -1 };

  // Bot hover → love (IslandWindowController.botHoverIn)
  private botHovering = false;
  private botHoverTimer: number | null = null;
  private lastLoveTime = 0;
  private botHoverStart = { x: 0, y: 0 };

  private lastSyncedView: IslandViewName | null = null;

  /** The launch greeting ended, or the island came out of hidden — two of the
   *  moments the Monday recap may open (see src/recap/recap.ts). */
  onGreetingDone: (() => void) | null = null;
  onWake: (() => void) | null = null;

  /** Where a press on Mochi started: moving past DRAG_THRESHOLD drags him out. */
  private botPress: { x: number; y: number } | null = null;

  /** Drop sequence bookkeeping: last tick played, and whether the ✓ has fired. */
  private uploadTens = 0;
  private uploadDone = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.desktop = new DesktopLink({
      reveal: () => this.reveal(),
      wardrobeFromDesktop: () => this.wardrobeFromDesktop(),
    });
    this.build();
    this.wireFsm();
    this.wireInput();
    this.greeting.onComplete = () => {
      this.fsm.greetComplete();
      this.onGreetingDone?.();
    };
    // News for the closed island (a note, an email): out it comes.
    setCompactNewsHandler(() => {
      if (State.mode === "hidden" && !State.paused) this.reveal();
      State.notify();
    });
    State.subscribe(() => {
      this.fsm.held = State.liveActive;
      this.dirty = true;
      this.ensureRunning();
    });
  }

  /** The request has its answer: the card goes and the session carries on. */
  private closeApproval() {
    const fromChat = State.pendingApproval?.fromChat ?? false;
    State.endApproval();
    this.fsm.pinned = false;
    // The chat asked: back to the chat, where the answer is still coming.
    // Gemini's helper asked: back to the call.
    this.setView(fromChat ? (State.liveActive ? "live" : "prompt") : State.agentsView());
  }

  /**
   * Folds a card that is waiting for an answer down to the compact island,
   * without answering it (Mac #290). Nothing is decided: the request keeps
   * waiting, the island stays on screen, and opening it shows the card again.
   */
  foldApproval() {
    if (!State.pendingApproval || State.mode !== "expanded") return;
    State.isPinned = true;
    this.fsm.pinned = true;
    this.fsm.forcePetit();
  }

  /**
   * A simple request (core/approvals.ts) is answered on the closed island: it
   * comes out of its edge and stays, with Deny and Allow next to Lumo. False
   * when the closed island cannot show it (open, greeting, upright on a side,
   * paused): the full card comes up instead.
   */
  quickApproval(): boolean {
    const state = this.fsm.state;
    if ((state !== "hidden" && state !== "petit") || isUpright(this.dock) || State.paused) return false;
    this.fsm.pinned = true;
    if (state === "hidden") this.fsm.reveal();
    State.notify();
    return true;
  }

  /** Deny or Allow clicked on the closed island: answered, and it stays closed. */
  private decideClosed(d: "allow" | "deny") {
    const req = State.pendingApproval;
    void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"} (closed island)`);
    if (!req) return;
    Sound.play(d === "deny" ? "blip" : "approve");
    void Bridge.approvalDecision(req.requestId, d);
    State.endApproval();
    if (State.mode === "expanded") {
      this.closeApproval();
      return;
    }
    this.dropPin();
    State.notify();
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  private build() {
    const actions: ViewActions = {
      setView: (v) => this.setView(v),
      cancelDrop: () => this.discardDrop(),
      collapse: () => this.collapse(),
      foldApproval: () => this.foldApproval(),
      setFocus: (id) => {
        State.setFocus(id);
        Sound.play("blip");
        // A pill with a waiting request opens on its card: going back to it
        // after looking at another pill brings the card up again.
        const req = State.pendingApproval;
        if (req?.pillId === id) this.setView(req.questions ? "question" : "approval");
      },
      openTerminal: () => {
        const task = State.focusTask;
        // Sessions from the Claude desktop app live there, not in a terminal.
        if (task?.id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
        else void Bridge.openSession(task?.sessionId ?? null, task?.sessionCwd ?? null);
      },
      // The ↗ button — same targets as openAgentTarget() on macOS.
      openTarget: () => {
        const task = State.focusTask;
        if (!task) return;
        const urls: Record<string, string> = {
          integration_resend: "https://resend.com/emails",
          integration_vercel: "https://vercel.com/dashboard",
          integration_github: "https://github.com/pulls",
          integration_stripe: "https://dashboard.stripe.com/payments",
          integration_notion: "https://notion.so",
          integration_calcom: "https://app.cal.com/bookings",
        };
        if (task.id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
        else if (task.id === "integration_claude" || task.sessionId) {
          void Bridge.openSession(task.sessionId ?? null, task.sessionCwd ?? null);
        } else if (task.id === "integration_n8n") void Bridge.openN8n();
        else if (urls[task.id]) void Bridge.openUrl(urls[task.id]);
      },
      openUrl: (url) => {
        if (url) void Bridge.openUrl(url);
      },
      decide: (d) => {
        const req = State.pendingApproval;
        void Bridge.log(`decide ${d} req=${req?.requestId ?? "none"}`);
        if (!req) return;
        Sound.play(d === "deny" ? "blip" : "approve");
        void Bridge.approvalDecision(req.requestId, d);
        // A click or a key Claude is about to do on another window: the chat
        // must not take the keyboard back when the card goes (computer.rs).
        if (isComputerTool(req.tool)) this.lastGesture = 0;
        this.closeApproval();
      },
      answer: (answers) => {
        const req = State.pendingApproval;
        if (!req) return;
        Sound.play("approve");
        void Bridge.approvalAnswer(req.requestId, answers);
        this.closeApproval();
      },
      answerInTerminal: () => {
        const req = State.pendingApproval;
        if (!req) return;
        Sound.play("blip");
        void Bridge.approvalDecline(req.requestId);
        this.closeApproval();
      },
      toggleSound: () => {
        State.settings.soundEnabled = !State.settings.soundEnabled;
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      setVolume: (v) => {
        State.settings.soundVolume = v;
        Sound.setVolume(v);
        void Bridge.saveSettings(State.settings);
        State.notify();
      },
      openSettingsWindow: () => void Bridge.openSettingsWindow(),
      blip: () => Sound.play("blip"),
      chooseOutfit: (selection) => {
        if (parseOutfit(State.settings.mochiOutfit) === selection) return;
        State.settings.mochiOutfit = selection;
        void Bridge.saveSettings(State.settings);
        Sound.play("pop");
        this.engine.triggerEmote("proud");
        State.notify();
      },
      previewOutfit: (outfit) => {
        State.wardrobePreview = outfit;
        State.notify();
      },
      chooseLook: (look) => {
        if (parseLook(State.settings.lumoCharacter) === look) return;
        State.settings.lumoCharacter = look;
        void Bridge.saveSettings(State.settings);
        Sound.play("pop");
        this.engine.triggerEmote("happy");
        State.notify();
      },
      showActivities: () => this.activities.unfold(),
      previewLook: (look) => {
        State.lookPreview = look;
        State.notify();
      },
    };

    this.wakeStrip = h("div", { id: "wake-strip" });
    this.botGlow = h("div", { id: "bot-glow" });
    this.botCanvas = h("canvas", { id: "bot-canvas" });
    this.greetingCanvas = h("canvas", { id: "greeting-canvas" });
    this.countdown = h("div", { id: "countdown" });
    this.compact = new CompactStrip({
      reveal: () => this.reveal(),
      openChat: () => {
        this.alert("prompt");
        this.takeKeyboard();
      },
      changed: () => State.notify(),
      decide: (d) => this.decideClosed(d),
    });

    this.header = buildHeader(actions);
    this.views = buildViews(actions, () => this.animateGeometry(false));
    this.viewsEl = h("div", { id: "views" });
    for (const v of this.views.values()) this.viewsEl.append(v.el);
    this.contentEl = h("div", { id: "content" }, this.header.el, this.viewsEl);

    // The drop sequence draws the card, the bar and its own Mochi. It sits under
    // the header, which stays visible on top of it exactly as on macOS.
    this.uploadCanvas = new UploadCanvas({
      ask: () => {
        State.promptContext = State.droppedFile
          ? { kind: "file", name: State.droppedFile.name, path: State.droppedFile.path }
          : null;
        this.setView("prompt");
      },
      cancel: () => this.discardDrop(),
    });

    this.clipEl = h(
      "div",
      { id: "island-clip" },
      this.greetingCanvas,
      this.uploadCanvas.el,
      this.contentEl,
      this.compact.el,
    );
    this.grips = GRIPS.map((grip) => ({ el: h("div", { class: `edge edge-${grip}` }), grip }));
    this.islandEl = h(
      "div",
      { id: "island" },
      this.clipEl,
      this.botGlow,
      this.botCanvas,
      this.countdown,
      ...this.grips.map((g) => g.el),
    );

    // Its pixels are sized as it is drawn (frame), for the display it is on.
    this.greetingCanvas.style.width = `${EXPANDED_W}px`;
    this.greetingCanvas.style.height = "150px";

    this.activities = new IslandActivities({
      openChat: () => {
        this.setView("prompt");
        this.takeKeyboard();
      },
      openSettings: () => this.openSettingsAt(null),
      refreshAll: () => void this.refreshAll(),
      iconPoint: () => {
        // Left of the "+": where the folded icon sits (or will).
        const icon = this.header.el.querySelector(".tab-activities") as HTMLElement | null;
        if (icon && icon.style.display !== "none") {
          const r = icon.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
        const plus = this.header.el.querySelector(".tab-drop");
        if (!plus) return null;
        const r = plus.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      },
      movable: this.canResize && IS_TAURI,
      changed: () => State.notify(),
    });

    this.root.append(this.wakeStrip, this.activities.view.el, this.islandEl);
    this.applyGeometry();
  }

  // ── FSM ─────────────────────────────────────────────────────────────────────

  private wireFsm() {
    this.applyBehaviour();
    this.fsm.onTransition = (from, to) => {
      // The greeting is over, however it ended: back to his desktop spot.
      if (from === "greeting" && to !== "greeting") this.desktop.launch();
      switch (to) {
        case "hidden":
          this.setMode("hidden");
          break;
        case "petit":
          if (from === "greeting") this.greeting.interrupt();
          else if (from === "hidden") Sound.play("peek");
          this.setMode("compact");
          if (from === "greeting") State.view = State.defaultView();
          if (!this.wasInIsland) this.fsm.mouseLeft();
          break;
        case "home":
          this.expand(State.defaultView());
          if (!this.wasInIsland) this.fsm.mouseLeft();
          // Hooks may have been installed in a terminal since: the idle cards
          // say so on the next open, without polling while the island is shut.
          void refreshHookPills();
          break;
        case "greeting":
          this.expand("greeting");
          this.greeting.start();
          break;
      }
      State.notify();
      if (from === "hidden") this.onWake?.();
    };
  }

  launch() {
    this.fsm.launch();
  }

  // ── Mode / view ─────────────────────────────────────────────────────────────

  private setMode(mode: IslandMode) {
    const prev = State.mode;
    if (mode === prev) return;
    this.menu?.close();
    State.mode = mode;
    if (mode === "expanded") Sound.play("open");
    if (prev === "expanded") {
      Sound.play("close");
      // A folded card is still waiting: it keeps the island pinned.
      if (!State.pendingApproval) State.isPinned = false;
      void Bridge.focusWindow(false);
    }
    if (mode !== "expanded") {
      closePlanCard();
      this.engine.resetMorph();
      // Nothing can be seen of the sequence once the island is shut, and leaving
      // it running would keep the frame loop awake — the island must cost
      // nothing while hidden.
      UploadSeq.deactivate();
    }
    this.updateWindowCollapsed();
    this.animateGeometry(modeOrder(mode) < modeOrder(prev));
    State.notify();
  }

  /** True while the drop sequence owns the island body. */
  private get uploadActive(): boolean {
    return State.mode === "expanded" && UploadSeq.isActive && UPLOAD_VIEWS.has(State.view);
  }

  /** Navigating out of the drop flow ends the sequence, as on macOS. */
  private stopSequenceIfLeaving(view: IslandViewName) {
    if (UploadSeq.isActive && !UPLOAD_VIEWS.has(view)) UploadSeq.deactivate();
  }

  expand(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (view !== "overview") closePlanCard();
    State.view = view;
    if (State.mode !== "expanded") this.setMode("expanded");
    else this.animateGeometry(false);
    State.lastActivity = performance.now();
    State.notify();
  }

  setView(view: IslandViewName) {
    this.stopSequenceIfLeaving(view);
    if (view !== "overview") closePlanCard();
    if (State.mode !== "expanded") {
      this.fsm.forceHome();
      State.view = view;
      this.animateGeometry(false);
      State.notify();
      return;
    }
    const grew = VIEW_LAYOUTS[view].height >= VIEW_LAYOUTS[State.view].height;
    State.view = view;
    State.lastActivity = performance.now();
    this.animateGeometry(!grew);
    State.notify();
  }

  collapse() {
    // A waiting card is only ever folded, never dropped by a close.
    if (State.pendingApproval) {
      this.foldApproval();
      return;
    }
    State.isPinned = false;
    this.fsm.pinned = false;
    // Drive the state machine rather than the mode: setting the mode behind its
    // back left it thinking the island was still open, and a click on the compact
    // island then did nothing — the island could never be reopened.
    this.fsm.forcePetit();
  }

  /** Alert from the hook server: open on this view. Pinned alerts never auto-close. */
  alert(view: IslandViewName) {
    this.fsm.pinned = State.isPinned;
    this.fsm.forceHome();
    this.expand(view);
  }

  reveal() {
    this.fsm.reveal();
  }

  // ── The right-click menu ────────────────────────────────────────────────────

  /** Opens Lumo's menu at (x, y): the text actions, Refresh, the items picked in Settings. */
  openMenu(x: number, y: number, target: EventTarget | null) {
    const entries: MenuEntry[] = [...textEntries(target), { kind: "sep" }];
    entries.push({ kind: "item", label: t(MENU_TEXT.refresh), title: t(MENU_TEXT.refreshHint), shortcut: "Ctrl+R", run: () => void this.refreshAll() });
    entries.push({ kind: "sep" });
    for (const item of pickedItems(State.settings.contextMenu)) {
      entries.push({ kind: "item", label: t(item.label), checked: item.toggle ? this.menuChecked(item.id) : undefined, run: () => this.menuAction(item.id) });
    }
    entries.push({ kind: "sep" }, { kind: "item", label: t(MENU_TEXT.customize), run: () => this.openSettingsAt("general") });
    this.menu.open(x, y, entries);
  }

  private menuChecked(id: string): boolean {
    switch (id) {
      case "pin": return State.isPinned;
      case "sound": return State.settings.soundEnabled !== false;
      case "activities": return State.settings.activitiesPanel !== false && State.settings.activitiesFolded !== true;
      default: return false;
    }
  }

  private menuAction(id: string) {
    switch (id) {
      case "newChat":
        if (State.chatActivity == null) {
          State.startChat();
          State.droppedFile = null;
          State.promptContext = null;
          void Bridge.chatReset();
        }
        this.setView("prompt");
        this.takeKeyboard();
        break;
      case "timer":
        compactTimer(5 * 60_000, "");
        Sound.play("blip");
        break;
      case "pin":
        this.setPinned(!State.isPinned);
        break;
      case "sound":
        State.settings = { ...State.settings, soundEnabled: State.settings.soundEnabled === false };
        Sound.setEnabled(State.settings.soundEnabled);
        void Bridge.saveSettings(State.settings);
        break;
      case "activities":
        if (State.settings.activitiesPanel === false) {
          State.settings = { ...State.settings, activitiesPanel: true, activitiesFolded: false };
          void Bridge.saveSettings(State.settings);
        } else if (State.settings.activitiesFolded === true) {
          this.activities.unfold();
        } else {
          this.activities.act({ kind: "fold" });
        }
        break;
      case "center":
        void Bridge.islandRecenter();
        break;
      case "wardrobe":
        this.toggleWardrobe();
        break;
      case "settings":
        this.openSettingsAt(null);
        break;
      case "quit":
        void Bridge.quit();
        break;
    }
    State.notify();
  }

  /**
   * Settings inside the island, as the gear in its top right opens them, on
   * one of its pages (null: the one it was left on). The page in the frame
   * hears the change of page (a storage event, settings/main.ts).
   */
  private openSettingsAt(page: string | null) {
    if (page) {
      try {
        window.localStorage.setItem("lumo.settings.page", page);
      } catch {
        // No storage: it opens on the page it was on.
      }
    }
    Sound.play("blip");
    this.setView("settings");
  }

  private refreshing = false;

  /**
   * Refresh: everything that can be shown asked again at once — the agents'
   * hooks and sessions, each service's server (email included), the
   * calendar, the plan usage (when Lumo asks Anthropic, and Codex's when its
   * pill shows) and the weekly recap. Never while paused.
   */
  async refreshAll() {
    if (this.refreshing || State.paused) return;
    this.refreshing = true;
    Sound.play("blip");
    const services = State.settings.activeIntegrations.filter((id) => {
      const def = pillDefinition(id);
      return def && !isHookPill(id) && def.category !== "ai" && (State.integrations[id]?.configured ?? false);
    });
    refreshClaudePlanOnline(true);
    if (State.settings.showCodexPlanInNotch) refreshCodexPlanUsage(true);
    await Promise.allSettled([
      refreshConfigured(),
      refreshHookPills(),
      reloadRecap(),
      Calendar.refresh(),
      ...services.map((id) => Bridge.refreshIntegration(id)),
    ]);
    this.refreshing = false;
    compactNotice(t(MENU_TEXT.refreshed), "#22c55e");
    State.notify();
  }

  /** Right-click on Mochi: wardrobe open ↔ back to the usual view. */
  toggleWardrobe() {
    if (State.paused || State.mode === "hidden") return;
    // The greeting and the drop sequence draw a Mochi of their own.
    if (State.mode === "expanded" && (State.view === "greeting" || this.uploadActive)) return;
    if (State.mode === "expanded" && State.view === "wardrobe") this.setView(State.defaultView());
    else this.setView("wardrobe");
  }

  /**
   * Right-click on the desktop Mochi (macOS openWardrobeFromDesktop): opens the
   * wardrobe from any state, or goes back if it is already open.
   */
  wardrobeFromDesktop() {
    this.wardrobeAnywhere();
  }

  /**
   * The wardrobe from any state — compact or hidden island included — or back
   * to the usual view if it is already open. The desktop Mochi's right-click
   * and the wardrobe shortcut (`open-wardrobe`) both land here.
   */
  wardrobeAnywhere() {
    if (State.mode === "expanded" && State.view === "wardrobe") {
      this.setView(State.defaultView());
      return;
    }
    if (State.paused) return;
    this.alert("wardrobe");
  }

  // ── How the island opens and closes on its own (Settings → Island) ─────────

  /** The close mode, the auto-close delay and auto-hide, into the state machine. */
  private applyBehaviour() {
    const s = State.settings;
    const mode = parseCloseMode(s.islandClose);
    // Settings stay open while you look something up elsewhere: they close on
    // Escape, a click on a tab, or a click outside when set to.
    const holding = State.view === "settings";
    this.fsm.closeOnLeave = !holding && (mode === "timer" || mode === "leave");
    this.fsm.homeToPetitDelay = mode === "leave" ? LEAVE_CLOSE_DELAY : s.autoCloseInterval;
    this.fsm.autoHide = s.islandAutoHide === true;
  }

  /** The mouse came to rest on the closed island: open it, when that is asked for. */
  private scheduleHoverOpen() {
    this.cancelHoverOpen();
    if (!State.settings.islandHoverOpen || this.fsm.state !== "petit" || State.paused) return;
    // An email or a request is showing: the mouse goes to its buttons, not to open the island.
    if (this.compact.mail || this.compact.approval) return;
    this.hoverOpenTimer = window.setTimeout(() => {
      this.hoverOpenTimer = null;
      // Still there, not on one of its own buttons, and not picking the island up to move it.
      if (this.compact.overControls(State.mouse.x, State.mouse.y)) return;
      if (this.wasInIsland && this.fsm.state === "petit" && !this.moving && !this.pendingMove) this.fsm.click();
    }, HOVER_OPEN_DELAY);
  }

  private cancelHoverOpen() {
    if (this.hoverOpenTimer != null) window.clearTimeout(this.hoverOpenTimer);
    this.hoverOpenTimer = null;
  }

  /**
   * A press somewhere else on the screen (island.rs), or the island losing the
   * keyboard where there is no cursor poll: closes the open island when it is
   * set to close on a click elsewhere. Never while a card waits for an answer,
   * the island is pinned, a file picker of ours is open, or it is being moved.
   */
  onOutsidePress() {
    // While a sharing shortcut holds it open, a click elsewhere closes it in
    // any mode: that is how the user says they are done.
    if (parseCloseMode(State.settings.islandClose) !== "click" && !this.fsm.inGrace) return;
    if (State.mode !== "expanded" || this.fsm.state !== "home") return;
    if (this.fsm.pinned || State.isPinned || State.pendingApproval || isDialogOpen()) return;
    if (this.moving || this.resizing || this.uploadActive) return;
    this.collapse();
  }

  /** An alert stopped waiting for an answer: let the island auto-close again. */
  dropPin() {
    this.fsm.pinned = false;
    // The countdown the pin held back starts now, if the mouse is elsewhere.
    if (!this.wasInIsland) this.fsm.mouseLeft();
  }

  /** New emails from the Email pill (mail.rs): the closed island shows the newest. */
  newMail(messages: MailMessage[]) {
    this.compact.newMail(messages);
  }

  // ── Keyboard shortcuts (island/shortcuts.ts) ────────────────────────────────

  emote(name: BotEmoteName) {
    this.engine.triggerEmote(name);
    this.ensureRunning();
  }

  /** Ctrl+P: keep the open island from folding away, or let it fold again. */
  setPinned(on: boolean) {
    State.isPinned = on;
    this.fsm.pinned = on;
    if (on) {
      // The countdown bar reads the state machine's deadline, cleared with it.
      this.fsm.cancelTimers();
    } else if (!this.wasInIsland && this.fsm.state === "home") {
      this.fsm.mouseLeft();
    }
    State.notify();
  }

  /** The island takes the keyboard, so its own shortcuts work (Mac: makeKey).
   *  It gives it back when it closes, or when the chat is left. */
  /** A shortcut opened the island: it waits for the user, the mouse being elsewhere (SHARE_GRACE). */
  holdOpen() {
    this.fsm.holdOpen(SHARE_GRACE);
  }

  takeKeyboard() {
    this.lastGesture = performance.now();
    void Bridge.focusWindow(true);
  }

  /** The keyboard to the island and the cursor in the chat's field. */
  private focusChat() {
    void Bridge.focusWindow(true);
    window.setTimeout(() => this.views.get("prompt")?.focus?.(), 120);
  }

  // ── File drop ───────────────────────────────────────────────────────────────

  private onDragDrop(e: { type: string; paths?: string[] }) {
    if (e.type !== "over") void Bridge.log(`drag ${e.type} ${e.paths?.length ?? 0} file(s)`);
    if (State.paused) return;
    switch (e.type) {
      case "enter":
      case "over": {
        if (State.fileDragOver) return;
        State.fileDragOver = true;
        this.engine.animateMorph(1);
        // enterZone must run before the island expands, so the sequence is
        // already active by the time the view becomes `upload`.
        UploadSeq.enterZone(State.mouseInIsland.x, State.mouseInIsland.y);
        this.alert("upload");
        break;
      }
      case "leave": {
        if (!State.fileDragOver) return;
        State.fileDragOver = false;
        this.engine.animateMorph(0);
        // The island deliberately stays open: the drag session is still alive.
        UploadSeq.exitZone();
        State.notify();
        break;
      }
      case "drop": {
        State.fileDragOver = false;
        const path = e.paths?.[0];
        if (!path) {
          this.engine.animateMorph(0);
          this.setView(State.defaultView());
          return;
        }
        this.swallow(path);
        break;
      }
    }
  }

  /**
   * Mochi eats the file. Nothing here waits on the file system: the copy into
   * the inbox runs in the background and swaps the path in when it lands, so a
   * slow disk can never stall the animation — same as FileDropHandler on macOS.
   */
  private swallow(path: string) {
    const name = path.split(/[\\/]/).pop() || "file";
    State.droppedFile = { name, path };
    State.promptContext = { kind: "file", name, path };
    State.startChat();
    void Bridge.chatReset();

    UploadSeq.performDrop(State.uploadDuration);
    this.uploadTens = 0;
    this.uploadDone = false;

    this.engine.gulp();
    Sound.play("approve");
    this.engine.triggerEmote("happy");
    this.engine.animateMorph(0);

    State.uploadProgress = 0;
    this.setView("uploading");
    this.ensureRunning();

    void Bridge.ingestFile(path)
      .then((file) => {
        // Cancelled (or replaced by another drop) while the copy was running.
        if (State.droppedFile?.path !== path) return;
        State.droppedFile = { name: file.name, path: file.path };
        State.promptContext = { kind: "file", name: file.name, path: file.path };
        State.notify();
      })
      .catch((err) => {
        if (State.droppedFile?.path !== path) return;
        UploadSeq.deactivate();
        State.noteMessage = String(err).replace(/^Error:\s*/, "");
        this.engine.animateMorph(0);
        this.setView("note");
        Sound.play("error");
        window.setTimeout(() => this.setView(State.defaultView()), 2400);
      });
  }

  /** "Cancel" on the dropped file: forget it, so the chat does not pick it up. */
  private discardDrop() {
    State.droppedFile = null;
    State.promptContext = null;
    this.setView(State.defaultView());
  }

  /**
   * Sounds and view changes hung off the canvas timeline: a `tick` every 10 %,
   * the ✓ chime when the bar completes, then `choose` once Mochi has grown back.
   */
  private stepSequence() {
    const since = UploadSeq.sinceDrop();
    if (since == null) return;
    const dur = State.uploadDuration;
    const p = Math.max(0, Math.min(1, (since - PRE_PROGRESS) / dur));

    const tens = Math.floor(p * 10);
    if (tens > this.uploadTens && tens < 10) {
      this.uploadTens = tens;
      Sound.play("tick");
    }

    if (!this.uploadDone && since >= PRE_PROGRESS + dur) {
      this.uploadDone = true;
      Sound.play("approve");
      this.engine.triggerEmote("happy");
    }
    // The extra second is the grow-back, after which the choose card is up.
    if (since >= PRE_PROGRESS + dur + 1 && State.view === "uploading") {
      this.setView("choose");
    }
  }

  // ── Geometry ────────────────────────────────────────────────────────────────

  private targetSize(): { w: number; h: number; r: number } {
    let { w, h } = islandSize(State.mode, State.view, this.chatCount, this.shape, this.dock, this.compact.size);
    if (State.mode === "expanded" && State.view === "question" && State.pendingApproval?.questions) {
      h = QUESTION_PICKER_H;
    }
    const r = State.mode === "expanded" ? EXPANDED_CORNER : ROUNDED_CORNER;
    return { w, h, r };
  }

  private animateGeometry(shrinking: boolean) {
    const { w, h, r } = this.targetSize();
    if (shrinking) {
      this.width.curveTowards(w);
      this.height.curveTowards(h);
      this.radius.curveTowards(r);
    } else {
      this.width.springTo(w);
      this.height.springTo(h);
      this.radius.springTo(r);
    }
    this.ensureRunning();
  }

  private applyGeometry() {
    const w = this.width.value;
    const hh = this.height.value;
    const r = this.radius.value;
    this.islandEl.style.width = `${w}px`;
    this.islandEl.style.height = `${hh}px`;
    // Rounded all round, a little off the edge of the screen.
    this.islandEl.style.borderRadius = `${r}px`;
    const at = this.islandRect();
    this.islandEl.style.left = `${at.x}px`;
    this.islandEl.style.top = `${at.y}px`;
    const lift = this.lift.value;
    this.islandEl.style.transform = Math.abs(lift - 1) > 0.001 ? `scale(${lift})` : "";
    // These follow the island as it resizes, so they belong here rather than in
    // the state-driven DOM sync.
    const beside = this.activitiesPlace();
    this.activities.place(beside.show, beside.x, beside.y, beside.h);
    this.greetingCanvas.style.left = `${(w - EXPANDED_W) / 2}px`;
    this.uploadCanvas.el.style.left = `${(w - EXPANDED_W) / 2}px`;

    const rect = this.hitRect();
    const p = this.pushedRect;
    if (
      Math.abs(p.x - rect.x) > 0.5 || Math.abs(p.y - rect.y) > 0.5 ||
      Math.abs(p.w - rect.w) > 0.5 || Math.abs(p.h - rect.h) > 0.5
    ) {
      this.pushedRect = rect;
      void Bridge.setIslandRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  /** Whether the live activities show beside the open island, and where. */
  private activitiesPlace(): { show: boolean; x: number; y: number; h: number } {
    const at = this.islandRect();
    const w = this.activities.width;
    const right = State.settings.activitiesSide === "right";
    const x = right ? at.x + at.w + ACTIVITIES_GAP : at.x - ACTIVITIES_GAP - w;
    const s = State.settings;
    const fits = this.activities.detached || (x >= 0 && x + w <= window.innerWidth);
    const show = State.mode === "expanded" && !isUpright(this.dock) && s.activitiesPanel !== false &&
      s.activitiesFolded !== true && !NO_ACTIVITIES.has(State.view) && fits && at.h >= 120;
    // The height picked with its grip, else as tall as the island or taller
    // when the window has the room: its cards need more than a short view gives.
    const bottom = this.dock === "bottom";
    const room = bottom ? at.y + at.h - 10 : window.innerHeight - at.y - 14;
    // Following the island (Settings → Island, on by default): as tall as it,
    // growing and shrinking with it. Otherwise the height picked with its
    // grip, else the island's height when the panel first showed.
    const picked = this.activities.pickedHeight;
    if (show && this.activitiesStartH == null) this.activitiesStartH = this.targetSize().h;
    const start = this.activitiesStartH ?? at.h;
    const h = Math.min(room, this.activities.followsIsland ? at.h : picked > 0 ? picked : start);
    return { show, x, y: bottom ? at.y + at.h - h : at.y, h };
  }

  /** What takes the mouse: the island, the live activities beside it, and the right-click menu. */
  private hitRect(): { x: number; y: number; w: number; h: number } {
    let rect = this.islandRect();
    if (this.activities?.isVisible) {
      const beside = this.activitiesPlace();
      rect = union(rect, { x: beside.x, y: beside.y, w: this.activities.width, h: beside.h });
    }
    const menu = this.menu?.rect();
    return menu ? union(rect, menu) : rect;
  }

  /**
   * Island rect in window coordinates: a gap off its edge of the window,
   * centred along it, moved by the shift of a floating island — and kept
   * inside the window, so an island floating low still opens whole.
   */
  private islandRect(): { x: number; y: number; w: number; h: number } {
    const w = this.width.value;
    const hh = this.height.value;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const { x: sx, y: sy } = this.shift;
    const gap = this.gap.value;
    let x: number;
    let y: number;
    switch (this.dock) {
      case "bottom": x = (vw - w) / 2 + sx; y = vh - gap - hh + sy; break;
      case "left": x = gap; y = (vh - hh) / 2 + sy; break;
      case "right": x = vw - gap - w; y = (vh - hh) / 2 + sy; break;
      default: x = (vw - w) / 2 + sx; y = gap + sy;
    }
    x = Math.min(Math.max(x, 0), Math.max(vw - w, 0));
    y = Math.min(Math.max(y, 0), Math.max(vh - hh, 0));
    return { x, y, w, h: hh };
  }

  /** The edge the island hangs from: always the top where it cannot be moved. */
  private get dock(): Dock {
    return this.canResize ? parseDock(State.settings.islandDock) : "top";
  }

  // ── Window collapse (hidden → tiny wake strip, zero polling) ────────────────

  private updateWindowCollapsed() {
    if (this.collapseTimer != null) {
      window.clearTimeout(this.collapseTimer);
      this.collapseTimer = null;
    }
    if (State.mode === "hidden") {
      // Let the island finish retracting, then drop the window to the wake strip:
      // from there the OS delivers no cursor events, so nothing polls at all.
      this.collapseTimer = window.setTimeout(() => {
        this.collapseTimer = null;
        if (State.mode !== "hidden") return;
        this.collapsed = true;
        void Bridge.setCollapsed(true);
      }, 420);
    } else if (this.collapsed) {
      // Grow the window back before the island animates open.
      this.collapsed = false;
      void Bridge.setCollapsed(false);
    }
  }

  /**
   * Moved to a display with another scale (or zoomed), the page may keep its
   * size and get no resize: a frame still has to run, so the canvases are
   * sized again for the new scale (drawBot, the greeting, the mini Lumos).
   */
  private watchScale() {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    query.addEventListener(
      "change",
      () => {
        this.dirty = true;
        this.ensureRunning();
        this.watchScale();
      },
      { once: true },
    );
  }

  // ── Input ───────────────────────────────────────────────────────────────────

  private wireInput() {
    // The wake strip is the only thing the OS can hit while the island is hidden.
    this.wakeStrip.addEventListener("mouseenter", () => {
      Sound.resume();
      if (State.mode === "hidden") this.fsm.mouseEntered();
    });

    // The grips resize the island; Rust follows the mouse.
    for (const { el, grip } of this.grips) {
      el.addEventListener("mousedown", (e) => {
        e.stopPropagation();
        const f = gripFactors(grip, this.dock);
        if (e.button !== 0 || e.altKey || !f) return;
        e.preventDefault();
        this.resizing = true;
        void Bridge.islandResize(f.fx, f.fy, this.height.value);
      });
      el.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const f = gripFactors(grip, this.dock);
        if (f) void Bridge.islandResetSize(f.fx !== 0, f.fy !== 0);
      });
    }
    window.addEventListener("mouseup", () => {
      this.resizing = false;
      // Rust says where a moved island went; should it never say, put it down anyway.
      if (this.moving) {
        this.clearSettleTimer();
        this.settleTimer = window.setTimeout(() => this.settleMove(), 2500);
      }
      // A press on the closed island that never moved is a click.
      const press = this.pendingMove;
      this.pendingMove = null;
      if (press?.click) this.fsm.click();
    });
    window.addEventListener("mousemove", (e) => {
      if (!(e.buttons & 1)) {
        this.resizing = false;
        this.pendingMove = null;
        return;
      }
      const press = this.pendingMove;
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_THRESHOLD) {
        this.pendingMove = null;
        this.startMove();
      }
    });
    // The window grows and shrinks around the island: its rect moves with it.
    window.addEventListener("resize", () => this.ensureRunning());
    this.watchScale();

    this.islandEl.addEventListener("mousedown", (e) => {
      Sound.resume();
      State.lastActivity = performance.now();
      this.lastGesture = performance.now();
      // The chat came up on its own: the first click in it brings the keyboard.
      if (State.mode === "expanded" && (State.view === "prompt" || State.view === "live") && e.button === 0 && !document.hasFocus()) {
        void Bridge.focusWindow(true);
        const target = e.target as Element | null;
        if (target?.closest(".chat-input")) window.setTimeout(() => (target as HTMLElement).focus(), 60);
      }
      // Alt + drag moves the island; Rust follows the mouse until it is let go.
      if (e.button === 0 && e.altKey) {
        e.preventDefault();
        this.startMove();
        return;
      }
      // So does a drag from its top (or anywhere on the closed island), once
      // the mouse has moved a little: a plain click stays a click.
      const movable = e.button === 0 && this.canResize && !this.isBotHit(e.clientX, e.clientY) &&
        !isControl(e.target) && (State.mode !== "expanded" || this.onTopBar(e.clientY));
      if (movable && State.mode !== "expanded") {
        this.pendingMove = { x: e.clientX, y: e.clientY, click: true };
        return;
      }
      if (movable) this.pendingMove = { x: e.clientX, y: e.clientY, click: false };
      // A press on Mochi may become a drag out to the desktop.
      if (e.button === 0 && this.isBotHit(e.clientX, e.clientY)) {
        this.botPress = { x: e.clientX, y: e.clientY };
      }
      // Right-click on Mochi opens the wardrobe, and closes it again.
      if (e.button === 2 && this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.toggleWardrobe();
        return;
      }
      if (State.mode !== "expanded") {
        // The closed island's own buttons (an email's, the music's) keep their click.
        if (!isControl(e.target)) this.fsm.click();
        return;
      }
      if (this.isBotHit(e.clientX, e.clientY)) {
        this.cancelBotHover();
        this.engine.slap();
      }
    });

    // Never the webview's menu: Lumo's own (Refresh, the text actions, the
    // items picked in Settings). Over Mochi the right click is the wardrobe.
    this.menu = new ContextMenu();
    this.menu.onChange = () => {
      this.dirty = true;
      this.ensureRunning();
    };
    document.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      if (State.mode === "hidden" || this.isBotHit(e.clientX, e.clientY)) return;
      this.openMenu(e.clientX, e.clientY, e.target);
    });

    // Dragging Mochi out of the island puts him on the desktop.
    window.addEventListener("mousemove", (e) => {
      if (this.desktop.carrying) {
        this.desktop.carry(e.clientX, e.clientY);
        return;
      }
      const press = this.botPress;
      if (!press) return;
      if (!(e.buttons & 1)) {
        this.botPress = null;
        return;
      }
      if (Math.hypot(e.clientX - press.x, e.clientY - press.y) <= DRAG_THRESHOLD) return;
      this.botPress = null;
      if (!this.canDragOut()) return;
      this.cancelBotHover();
      this.desktop.pickUp(e.clientX, e.clientY);
    });
    window.addEventListener("mouseup", (e) => {
      this.botPress = null;
      if (this.desktop.carrying) this.desktop.carryEnd(e.clientX, e.clientY);
    });

    // Typing the question keeps a shortcut's grace going (capture phase: the
    // chat field stops its own keys from bubbling).
    window.addEventListener("keydown", () => {
      if (this.fsm.inGrace) this.fsm.holdOpen(SHARE_GRACE);
    }, true);

    // Only keys typed into the island itself land here, never Escape typed in
    // a terminal — so it may fold a waiting card away, as Escape in the notch
    // does on macOS.
    window.addEventListener("keydown", (e) => {
      // Ctrl + / Ctrl − / Ctrl 0: a bigger or smaller island, or the usual size.
      const zoom = e.ctrlKey && !e.altKey ? zoomStep(e.key, State.settings.islandZoom) : null;
      if (zoom != null) {
        e.preventDefault();
        State.settings = { ...State.settings, islandZoom: zoom };
        void Bridge.saveSettings(State.settings);
        return;
      }
      // Ctrl+R and F5 ask everything again, rather than reloading the page.
      if ((e.ctrlKey && !e.altKey && e.key.toLowerCase() === "r") || e.key === "F5") {
        e.preventDefault();
        void this.refreshAll();
        return;
      }
      if (e.key === "Escape" && State.mode === "expanded") {
        if (State.pendingApproval) this.foldApproval();
        else if (!State.isPinned) this.collapse();
      }
      State.lastActivity = performance.now();
    });

    void onDragDrop((e) => this.onDragDrop(e));

    // Outside Tauri (plain browser) drive the cursor from DOM events so the
    // island can be inspected with `npm run dev`.
    if (!IS_TAURI) this.followPageCursor();
  }

  /**
   * Takes the cursor from the page's own mouse events instead of Rust's poll.
   * Used where the OS has no global cursor position (Wayland): the events only
   * fire while the pointer is over the island, so leaving the window is
   * reported as a cursor far away, which is what the poll would have said.
   */
  followPageCursor() {
    this.canResize = false;
    // No global mouse here: a click elsewhere shows as the island losing the
    // keyboard (not to the settings frame inside it, which keeps it ours).
    window.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (document.activeElement?.tagName !== "IFRAME") this.onOutsidePress();
      }, 0);
    });
    this.applyDock();
    window.addEventListener("mousemove", (e) => this.onCursor(e.clientX, e.clientY));
    window.addEventListener("mouseout", (e) => {
      if (e.relatedTarget == null) this.onCursor(-10_000, -10_000);
    });
  }

  /**
   * Pointer on/off the island as the compositor sees it (Linux only). Null
   * until the first report, so a platform that never sends it is not gated.
   */
  private pointerInside: boolean | null = null;

  setPointerInside(inside: boolean) {
    this.pointerInside = inside;
  }

  /** Cursor in window-logical coordinates. */
  onCursor(x: number, y: number, overPanel = false) {
    // WebKitGTK can deliver a mousemove after the pointer has left the layer
    // surface; trusting it re-enters the island and the auto-close never runs.
    if (this.pointerInside === false) {
      x = -10_000;
      y = -10_000;
    }
    State.mouse = { x, y };
    const rect = this.islandRect();
    State.mouseInIsland = { x: x - rect.x, y: y - rect.y };

    // Windows sends no cursor position with an OLE drag, so the drop sequence is
    // fed from the Win32 cursor poll instead — it runs throughout the drag.
    if (UploadSeq.isActive && !UploadSeq.dropped) {
      UploadSeq.updateCursor(State.mouseInIsland.x, State.mouseInIsland.y);
    }

    // The live activities in their own window count as the island.
    const hit = this.hitRect();
    const inIsland = overPanel || (
      x >= hit.x - HIT_MARGIN && x <= hit.x + hit.w + HIT_MARGIN &&
      y >= hit.y - HIT_MARGIN && y <= hit.y + hit.h + HIT_MARGIN);

    // Mid-resize the cursor rides the edge, a little in or out: not a leave.
    if (!this.resizing && !this.moving) {
      if (inIsland && !this.wasInIsland) {
        this.fsm.mouseEntered();
        this.scheduleHoverOpen();
      }
      if (!inIsland && this.wasInIsland) {
        this.cancelHoverOpen();
        this.fsm.mouseLeft();
      }
      // The closed island's own buttons (the music, a timer) are for clicking:
      // resting on them never opens it; leaving them for the rest of it does.
      if (inIsland && this.fsm.state === "petit") {
        const onControls = this.compact.overControls(x, y);
        if (onControls) this.cancelHoverOpen();
        else if (this.onControls) this.scheduleHoverOpen();
        this.onControls = onControls;
      } else {
        this.onControls = false;
      }
      this.wasInIsland = inIsland;
    }

    // Bot hover → love
    const overBot = State.mode === "expanded" && State.stateOverride == null && this.isBotHit(x, y);
    if (overBot && !this.botHovering) this.botHoverIn(x, y);
    if (!overBot && this.botHovering) this.cancelBotHover();
    this.botHovering = overBot;
    if (this.botHovering) {
      const d = Math.hypot(x - this.botHoverStart.x, y - this.botHoverStart.y);
      if (d > 40) {
        this.botHoverStart = { x, y };
        this.scheduleLove();
      }
    }

    this.ensureRunning();
  }

  /** The greeting and the drop sequence draw a Mochi of their own: not that one. */
  private canDragOut(): boolean {
    if (State.mode === "hidden" || !this.desktop.canPickUp()) return false;
    return !(State.mode === "expanded" && (State.view === "greeting" || this.uploadActive));
  }

  private isBotHit(x: number, y: number): boolean {
    // Out on the desktop, the island's Mochi is invisible: nothing to hit.
    if (State.mochiOnDesktop) return false;
    const rect = this.islandRect();
    const cx = rect.x + this.botCx.value;
    const cy = rect.y + this.botCy.value;
    const radius = this.botSize.value / 2;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  }

  private botHoverIn(x: number, y: number) {
    if (performance.now() / 1000 - this.lastLoveTime < 6) return;
    this.botHoverStart = { x, y };
    this.engine.blink();
    this.engine.tgEs = 1.08;
    Sound.play("hover");
    this.scheduleLove();
  }

  private scheduleLove() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = window.setTimeout(() => {
      this.botHoverTimer = null;
      if (!this.botHovering || State.stateOverride != null) return;
      if (performance.now() / 1000 - this.lastLoveTime < 6) return;
      this.lastLoveTime = performance.now() / 1000;
      this.engine.triggerEmote("love");
      Sound.play("love");
    }, 1900);
  }

  private cancelBotHover() {
    if (this.botHoverTimer != null) window.clearTimeout(this.botHoverTimer);
    this.botHoverTimer = null;
    this.engine.tgEs = 1;
  }

  // ── Frame loop ──────────────────────────────────────────────────────────────

  ensureRunning() {
    if (this.running) return;
    this.running = true;
    this.lastFrame = performance.now();
    requestAnimationFrame(this.frame);
  }

  private frame = (nowMs: number) => {
    const dt = Math.min(0.05, (nowMs - this.lastFrame) / 1000);
    this.lastFrame = nowMs;

    this.width.step(dt, nowMs);
    this.height.step(dt, nowMs);
    this.radius.step(dt, nowMs);
    this.lift.step(dt, nowMs);
    this.gap.step(dt, nowMs);
    this.applyGeometry();

    if (this.dirty) {
      this.dirty = false;
      this.syncDom();
    }

    this.updateBotTargets();
    this.botCx.step(dt);
    this.botCy.step(dt);
    this.botSize.step(dt);

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    if (greetingActive) {
      // Sized for the scale it is drawn at, which changes with the island's
      // zoom and the display it is on: a canvas sized once, before the zoom
      // was applied, drew the greeting too big and cut off on the right.
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (this.greetingDpr !== dpr) {
        this.greetingDpr = dpr;
        this.greetingCanvas.width = Math.round(EXPANDED_W * dpr);
        this.greetingCanvas.height = Math.round(150 * dpr);
      }
      const gctx = this.greetingCanvas.getContext("2d");
      if (gctx) {
        gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this.greeting.look = this.look();
        this.greeting.draw(gctx);
      }
    } else {
      // Kept running even while the drop canvas is up, so the island's own Mochi
      // is already in the right place the moment the canvas fades out.
      this.drawBot(dt);
    }

    const uploadActive = this.uploadActive;
    if (uploadActive) this.uploadCanvas.draw(UploadSeq.frame(), nowMs / 1000);
    this.uploadCanvas.el.classList.toggle("on", uploadActive);
    this.viewsEl.classList.toggle("hidden-by-upload", uploadActive);
    const resizable = this.canResize && State.mode === "expanded" && !uploadActive && State.view !== "greeting";
    for (const { el, grip } of this.grips) {
      el.classList.toggle("on", resizable && gripFactors(grip, this.dock) != null);
    }

    tickMiniBots(dt);
    // A ticker scroll that loses its frames freezes mid-way, rows overlapping.
    const viewAnimating = this.views.get(State.view)?.tick?.(nowMs) === true;
    if (UploadSeq.isActive) this.stepSequence();
    this.updateCountdown(nowMs);

    // Nothing is drawn while the island is hidden, so nothing may keep the loop
    // alive either. This used to read `... || this.engine.busy || State.mode !==
    // "hidden"`, and engine.busy is permanently true for any state with a
    // looping animation — breathing, ratelimit sweat, sleeping z's, the search
    // sweep — so a hidden island went on burning frames in exactly the states it
    // spends most of its life in. Geometry still has to finish retracting.
    const settling =
      this.width.animating || this.height.animating || this.radius.animating || this.gap.animating;
    const busy = State.mode === "hidden"
      ? settling
      : settling ||
        !this.botCx.settled || !this.botCy.settled || !this.botSize.settled ||
        greetingActive || this.engine.busy || UploadSeq.isActive || viewAnimating;

    if (busy) {
      requestAnimationFrame(this.frame);
    } else if (State.mode !== "hidden" && this.engine.ambientActive) {
      // Only Lumo's own motion is left: about 30 frames a second is plenty, and
      // it stops with everything else once the island hides.
      window.setTimeout(() => requestAnimationFrame(this.frame), 22);
      Sound.idle();
    } else {
      this.running = false;
      Sound.idle();
    }
  };

  private updateBotTargets() {
    const p = botPosition(State.mode, State.view, this.height.value, State.uploadProgress);
    // Upright on a side, the closed island has Mochi at its top end.
    const turned = isUpright(this.dock) && State.mode !== "expanded";
    this.botCx.target = turned ? p.cy : p.cx;
    this.botCy.target = turned ? p.cx : p.cy;
    this.botSize.target = p.diameter / 0.6;

    const greetingActive = State.mode === "expanded" && State.view === "greeting";
    // The drop canvas draws its own Mochi; two of them would overlap. Out on the
    // desktop, he isn't here at all.
    const away = State.mochiOnDesktop;
    const visible = p.opacity > 0 && !greetingActive && !this.uploadActive && !away;
    this.botCanvas.style.opacity = visible ? "1" : "0";

    if (State.mode === "expanded" && State.view !== "uploading" && !greetingActive && !this.uploadActive && !away) {
      const d = p.diameter;
      const color = botGlowColor(State.shownState);
      this.botGlow.style.display = "block";
      this.botGlow.style.width = `${d * 2.2}px`;
      this.botGlow.style.height = `${d * 2.2}px`;
      this.botGlow.style.left = `${this.botCx.value - d * 1.1}px`;
      this.botGlow.style.top = `${this.botCy.value - d * 1.1}px`;
      this.botGlow.style.background = `radial-gradient(circle, ${color} 0%, transparent 62%)`;
      this.botGlow.style.opacity = String(botGlowOpacity(State.shownState));
    } else {
      this.botGlow.style.display = "none";
    }
  }

  private drawBot(dt: number) {
    const size = this.botSize.value;
    const w = Math.max(1, Math.round(size));
    const hCss = w + BOT_OVERHANG;
    const wCss = w + BOT_SIDE * 2;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.canvasPx !== w || this.canvasDpr !== dpr) {
      this.canvasPx = w;
      this.canvasDpr = dpr;
      this.botCanvas.width = Math.round(wCss * dpr);
      this.botCanvas.height = Math.round(hCss * dpr);
      this.botCanvas.style.width = `${wCss}px`;
      this.botCanvas.style.height = `${hCss}px`;
    }
    this.botCanvas.style.left = `${this.botCx.value - wCss / 2}px`;
    this.botCanvas.style.top = `${this.botCy.value - BOT_OVERHANG / 2 - hCss / 2}px`;

    const ctx = this.botCanvas.getContext("2d");
    if (!ctx) return;

    const focus = State.focusTask;
    // While a plan card is open Lumo wears the plan's colour, like its pill. A
    // white pill leaves him in his own butter yellow.
    const wear = planCardOpen() ? openPlanColor() : focus?.isIntegration ? focus.color : null;
    this.engine.bodyColor = wear && wear.toUpperCase() !== NEUTRAL_PILL ? hexToRGB(wear) : null;
    this.engine.particleOverhang = BOT_OVERHANG;
    this.engine.lookX = this.lookX();
    this.engine.lookY = this.lookY();
    if (this.engine.morph > 0.3) {
      this.engine.slotHTarget = State.fileDragOver ? 0.2 : 0;
    } else {
      this.engine.slotHTarget = 0;
      if (this.engine.morph < 0.05) {
        this.engine.slotH = 0;
        this.engine.slotHVel = 0;
      }
    }
    // Only the main Mochi is dressed — the one of the main tool's pill (Settings →
    // Active pills): a focused integration pill shows its own colours, unless
    // the wardrobe is open (BotCanvasView.showOutfit, macOS).
    // In the wardrobe the hovered outfit swaps in at once, without the drop-in.
    const inWardrobe = State.mode === "expanded" && State.view === "wardrobe";
    const mainFocused = State.focusId == null || State.focusId === State.mainPillId;
    const showOutfit = mainFocused || State.mode !== "expanded" || inWardrobe;
    const outfit = State.wardrobePreview ?? this.seasons.get(parseOutfit(State.settings.mochiOutfit));
    this.engine.setOutfit(showOutfit ? outfit : "none", !inWardrobe);
    this.engine.look = this.look();

    this.engine.update(dt);
    ctx.setTransform(dpr, 0, 0, dpr, BOT_SIDE * dpr, 0);
    ctx.clearRect(-BOT_SIDE, 0, wCss, hCss);
    this.engine.draw(ctx, w, hCss);
  }

  /** Lumo's look: the one tried on in the wardrobe, else the chosen one. */
  private look(): LumoLook {
    return State.lookPreview ?? parseLook(State.settings.lumoCharacter);
  }

  /** BotCanvasView.lookX / lookY — tanh of the distance to the bot. */
  private lookX(): number {
    const rect = this.islandRect();
    const botScreenX = rect.x + this.botCx.value;
    return Math.tanh((State.mouse.x - botScreenX) / 260);
  }

  private lookY(): number {
    return -Math.tanh((State.mouse.y - this.botCy.value) / 200);
  }

  private updateCountdown(nowMs: number) {
    // The state machine's own deadline, so the bar follows an auto-close delay
    // edited while the countdown runs.
    const dueAt = this.fsm.homeCollapseDueAt;
    if (State.mode !== "expanded" || State.isPinned || dueAt == null) {
      this.countdown.style.width = "0px";
      return;
    }
    const autoClose = this.fsm.homeToPetitDelay;
    const windowS = Math.min(10, autoClose * 0.6);
    const remaining = (dueAt - nowMs) / 1000;
    this.countdown.style.width =
      remaining < windowS ? `${Math.max(0, clamp(remaining / windowS, 0, 1) * 160)}px` : "0px";
  }

  // ── DOM sync ────────────────────────────────────────────────────────────────

  private syncDom() {
    const expanded = State.mode === "expanded";
    const greetingActive = expanded && State.view === "greeting";

    const live = expanded && !greetingActive;
    this.contentEl.style.opacity = live ? "1" : "0";
    // While the drop sequence owns the body its buttons are painted on the canvas
    // underneath, so only the header may keep taking clicks up here.
    this.contentEl.style.pointerEvents = live && !this.uploadActive ? "auto" : "none";
    this.header.el.style.pointerEvents = live ? "auto" : "none";
    this.greetingCanvas.style.display = greetingActive ? "block" : "none";

    // Leaving the greeting, however it ends, lets its sound fade out.
    if (this.greetingShown && !greetingActive) this.greeting.leave();
    this.greetingShown = greetingActive;
    // A wardrobe try-on never outlives the wardrobe.
    if (State.wardrobePreview && !(expanded && State.view === "wardrobe")) State.wardrobePreview = null;
    if (State.lookPreview && !(expanded && State.view === "wardrobe")) State.lookPreview = null;

    this.header.sync();
    for (const [name, view] of this.views) {
      const on = name === State.view;
      view.el.classList.toggle("on", on);
      if (on) view.sync();
    }

    // The chat is the only view with a text field, so it is the only time the
    // island is allowed to take keyboard focus — and, now that it is home, only
    // when you just asked for it (a click, a shortcut). Opened by anything else
    // (a card going away, a session ending) it waits for a click, so typing in
    // another app is never cut off.
    // Settings have fields too, and are only ever opened on purpose.
    if (this.lastSyncedView !== State.view) {
      const wasTyping = this.lastSyncedView === "prompt" || this.lastSyncedView === "settings" || this.lastSyncedView === "live";
      this.lastSyncedView = State.view;
      this.applyBehaviour();
      if (State.view === "prompt" && performance.now() - this.lastGesture < GESTURE_WINDOW) {
        this.focusChat();
      } else if (State.view === "settings" && expanded) {
        void Bridge.focusWindow(true);
      } else if (wasTyping) {
        void Bridge.focusWindow(false);
      }
    }

    // What the closed island says next to Lumo. Standing upright on a side
    // there is no room for it. A change of what it shows resizes the island.
    const compactOn = State.mode === "compact" && !isUpright(this.dock);
    State.activitiesRoom = !isUpright(this.dock);
    if (this.compact.sync(compactOn, compactOn || this.activities.isVisible) && State.mode === "compact") {
      this.animateGeometry(this.compact.size == null);
    }
    this.activities.sync();

    // The compact island shows Lumo alone: the other pills' mini Lumos are
    // only in the open island.
    syncMiniBotStates(State.tasks);
    this.engine.setState(State.shownState);
  }

  /** Applies settings coming from Rust at boot. */
  applySettings() {
    // A new distance from the edge eases in; the first one is simply taken.
    const gap = edgeGap(State.settings.islandEdgeGap);
    if (this.gapTarget == null) this.gap.jump(gap);
    else if (gap !== this.gapTarget) this.gap.springTo(gap, 0.55, 1);
    this.gapTarget = gap;
    this.engine.ambient = motionAmount(State.settings.lumoMotion);
    this.ensureRunning();
    Sound.setEnabled(State.settings.soundEnabled);
    Sound.setVolume(State.settings.soundVolume);
    this.applyBehaviour();
    document.documentElement.style.setProperty("--icon-scale", String(State.settings.iconScale || 1));
    this.applyDock();
    // A resize saved or undone with a double click, or the island sent back to
    // the top (Settings, tray): grow, shrink or turn to it.
    const shape = JSON.stringify(this.shape);
    if (shape !== this.lastShape || this.dock !== this.lastDock) {
      this.lastShape = shape;
      this.lastDock = this.dock;
      this.animateGeometry(false);
    }
    State.notify();
  }

  /** A new size while a grip is dragged: followed closely, on a stiff spring. */
  onResize(size: { width: number; height: number }) {
    State.settings = { ...State.settings, islandWidth: size.width, islandHeight: size.height };
    this.lastShape = JSON.stringify(this.shape);
    const { w, h } = this.targetSize();
    this.width.springTo(w, 0.22, 0.9);
    this.height.springTo(h, 0.22, 0.9);
    this.ensureRunning();
  }

  /** Picked up: Rust carries the window; the island lifts and Mochi notices. */
  private startMove() {
    if (this.moving || !this.canResize) return;
    this.clearSettleTimer();
    this.moving = true;
    this.cancelBotHover();
    this.lift.springTo(1.04, 0.3, 0.6);
    this.engine.triggerEmote("surprised");
    Sound.play("blip");
    this.ensureRunning();
    const at = this.islandRect();
    void Bridge.islandDrag([at.x, at.y, at.w, at.h]);
  }

  /**
   * Let go: Rust says which edge it is going to before the window bounces
   * there. The island re-anchors, turns upright on a side, and settles with a
   * bounce of its own.
   */
  onDock(place: { dock: string; offset: number; float?: number; shiftX?: number; shiftY?: number }) {
    State.settings = {
      ...State.settings, islandDock: place.dock, islandOffset: place.offset, islandFloat: place.float ?? 0,
    };
    this.shift = { x: place.shiftX ?? 0, y: place.shiftY ?? 0 };
    this.lastDock = this.dock;
    this.clearSettleTimer();
    this.applyDock();
    // Turned upright (or back), the closed island morphs into its new shape.
    const { w, h, r } = this.targetSize();
    this.width.springTo(w, 0.45, 0.6);
    this.height.springTo(h, 0.45, 0.6);
    this.radius.springTo(r);
    this.lift.springTo(1, 0.45, 0.45);
    this.moving = false;
    this.engine.triggerEmote("happy");
    Sound.play("pop");
    this.ensureRunning();
  }

  /** Where Rust put the window: the island is drawn this far off its usual place. */
  onShift(shift: { x: number; y: number }) {
    if (!Number.isFinite(shift.x) || !Number.isFinite(shift.y)) return;
    if (shift.x === this.shift.x && shift.y === this.shift.y) return;
    this.shift = { x: shift.x, y: shift.y };
    this.ensureRunning();
  }

  private clearSettleTimer() {
    if (this.settleTimer != null) window.clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  /** Ends a move that never reported where it went. */
  private settleMove() {
    this.settleTimer = null;
    if (!this.moving) return;
    this.moving = false;
    this.lift.springTo(1, 0.45, 0.45);
    this.ensureRunning();
  }

  /** The dock as classes, for the CSS that anchors the island and the wake strip. */
  private applyDock() {
    const dock = this.dock;
    for (const d of ["top", "bottom", "left", "right"] as const) {
      this.root.classList.toggle(`dock-${d}`, d === dock);
    }
    this.root.classList.toggle("movable", this.canResize);
    this.ensureRunning();
  }

  /** What the grips were dragged to. */
  private get shape(): IslandShape {
    return { width: State.settings.islandWidth, height: State.settings.islandHeight };
  }

  /** The bar at the top of the open island: tabs, settings, sound. */
  private onTopBar(clientY: number): boolean {
    return clientY - this.islandRect().y < TOP_BAR_H;
  }

  get chatHeight() {
    return chatHeight(this.shape, this.chatCount);
  }

  /** What the chat's height follows: its messages, or the most room while a list is open. */
  private get chatCount(): number {
    return State.chatPanelOpen ? CHAT_PANEL_OPEN : State.chatHistory.length;
  }
}

/** The smallest rectangle holding both. */
function union(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
