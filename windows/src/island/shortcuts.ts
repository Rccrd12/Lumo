// Keyboard shortcuts → island. Port of IslandWindowController.handleHotKey and
// handleIslandKey from the macOS app.
//
// Global shortcuts are caught by Rust and arrive as a `shortcut` event with
// the action id (the wardrobe goes out as `open-wardrobe` instead, for the
// wardrobe view to pick up). The in-island keys are read here, while the
// island has the keyboard: it takes it for the chat, and when a global
// shortcut opens it.

import { Bridge, onEvent, type SharedContext } from "../core/bridge";
import type { BotEmoteName, IslandViewName } from "../core/layout";
import { providerDef } from "../core/providers";
import { SCREEN_STRINGS, seesImages } from "../core/screen";
import { t } from "../i18n/i18n";
import { cyclePill, islandKeyAction, pillByNumber, type IslandKeyAction } from "../core/shortcuts";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { Live } from "../live/session";

const CLAUDE_DESKTOP_ID = "agent_claude-desktop";

/** What the shortcuts need from the island. */
export interface ShortcutHost {
  alert(view: IslandViewName): void;
  setView(view: IslandViewName): void;
  collapse(): void;
  emote(name: BotEmoteName): void;
  setPinned(on: boolean): void;
  /** Gives the island the keyboard, so the in-island keys work (Mac: makeKey). */
  takeKeyboard(): void;
  /** The wardrobe from any state, or back if it is open (Island.wardrobeAnywhere). */
  wardrobeAnywhere(): void;
}

function focusPill(host: ShortcutHost, id: string | null, open: boolean) {
  if (!id) return;
  State.setFocus(id);
  Sound.play("blip");
  if (open) host.alert("overview");
  else host.setView("overview");
}

/** A global shortcut was pressed. `resume` lifts Pause, as the tray's Open does. */
export function runGlobalShortcut(host: ShortcutHost, action: string, resume: () => void) {
  switch (action) {
    case "toggleIsland":
      if (State.mode === "expanded") {
        host.collapse();
      } else {
        resume();
        // A waiting card is what the island opens on (State.defaultView).
        host.alert(State.defaultView());
        host.takeKeyboard();
      }
      break;

    case "openChat":
      resume();
      host.alert("prompt");
      host.takeKeyboard();
      break;

    case "goToAlert": {
      const asking = State.tasks.find((t) => t.state === "question");
      const pending = State.pendingApproval;
      if (pending) {
        // The one card every agent's request uses: its own pill to the front,
        // its card (permission or question) up. Nothing is answered from here.
        resume();
        State.setFocus(pending.pillId);
        host.alert(pending.questions ? "question" : "approval");
        host.takeKeyboard();
      } else if (asking) {
        resume();
        State.setFocus(asking.id);
        host.alert("question");
        host.takeKeyboard();
      } else {
        // Nothing is waiting: Mochi says so.
        host.emote("annoyed");
        Sound.play("error");
      }
      break;
    }

    // The Mac brings the terminal app forward; here it is the existing "Open
    // terminal": the session's own window when it was found, else its folder
    // in VS Code; the Claude app for a Claude Desktop session.
    case "jumpToTerminal": {
      const task = State.focusTask;
      if (task?.id === CLAUDE_DESKTOP_ID) void Bridge.openClaudeDesktop();
      else void Bridge.openSession(task?.sessionId ?? null, task?.sessionCwd ?? null);
      if (State.mode === "expanded") host.collapse();
      break;
    }

    case "nextPill":
    case "prevPill":
      resume();
      focusPill(
        host,
        cyclePill(State.tasks.map((t) => t.id), State.focusTask?.id ?? null, action === "nextPill" ? 1 : -1),
        true,
      );
      break;

    case "muteToggle": {
      const on = !State.settings.soundEnabled;
      State.settings.soundEnabled = on;
      Sound.setEnabled(on);
      void Bridge.saveSettings(State.settings);
      if (on) Sound.play("tick");
      host.emote(on ? "happy" : "annoyed");
      State.notify();
      break;
    }

    // Gemini Live: starts a call, or ends the one on screen. A call going on
    // behind another view comes back first, so one press never ends it unseen.
    case "talkToGemini":
      resume();
      if (!Live.active) {
        host.alert("live");
        void Live.start();
      } else if (State.mode === "expanded" && State.view === "live") {
        Live.end();
      } else {
        host.alert("live");
      }
      break;

    // wardrobeToggle never comes this way (Rust sends `open-wardrobe`), nor do
    // askScreen / askSelection (`ask-context`, runShared), and
    // attachFrontWindow / desktopToggle aren't in this version.
    default:
      break;
  }
}

/**
 * "Ask about my screen" or "Ask about the selected text": Rust took the
 * screenshot or read the selection on the key press (shortcuts.rs). The chat
 * opens with it waiting as a chip, for the user to type a question and press
 * Enter; nothing is sent before that, and the chip's × takes it back.
 */
export function runShared(host: ShortcutHost, shared: SharedContext, resume: () => void) {
  resume();
  let problem = shared.kind === "problem" ? shared.message : null;
  if (shared.kind === "screen" && !seesImages(providerDef(State.settings.chatProvider))) {
    void Bridge.screenDiscard(shared.shots.map((s) => s.path));
    problem = t(SCREEN_STRINGS.needsImages);
  }
  if (problem !== null) {
    State.noteMessage = problem;
    host.alert("note");
    host.emote("annoyed");
    Sound.play("error");
    return;
  }
  State.incomingShare = shared;
  Sound.play("attach");
  host.alert("prompt");
  host.takeKeyboard();
}

/** A key the island acts on while it has the keyboard. */
export function runIslandKey(host: ShortcutHost, action: IslandKeyAction) {
  const ids = State.tasks.map((t) => t.id);
  switch (action.kind) {
    case "cycle":
      focusPill(host, cyclePill(ids, State.focusTask?.id ?? null, action.delta), false);
      break;
    case "pill":
      focusPill(host, pillByNumber(ids, action.number), false);
      break;
    case "newChat":
      // Not while an answer is on its way: it would land in the new chat.
      if (State.stateOverride === "thinking") return;
      State.startChat();
      State.droppedFile = null;
      State.promptContext = null;
      void Bridge.chatReset();
      Sound.play("blip");
      host.setView("prompt");
      break;
    case "settings":
      host.alert("settings");
      host.takeKeyboard();
      break;
    case "pin":
      // A permission card keeps the island pinned until it is answered.
      if (State.pendingApproval) return;
      host.setPinned(!State.isPinned);
      break;
  }
}

function inTextField(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  return el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable === true;
}

export function registerShortcutHandlers(host: ShortcutHost, resume: () => void) {
  void onEvent<string>("shortcut", (action) => runGlobalShortcut(host, action, resume));
  void onEvent<SharedContext>("ask-context", (shared) => runShared(host, shared, resume));
  // The wardrobe shortcut comes as its own event (shortcuts.rs): it opens the
  // wardrobe (mochi/wardrobe.ts, views/wardrobe.ts), or closes it again.
  void onEvent<null>("open-wardrobe", () => {
    resume();
    host.wardrobeAnywhere();
  });

  // Capture phase: the chat field stops its own key events from bubbling.
  window.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      if (State.mode !== "expanded") return;
      const action = islandKeyAction(e, { view: State.view, inTextField: inTextField(e.target) });
      if (!action) return;
      e.preventDefault();
      e.stopPropagation();
      runIslandKey(host, action);
    },
    true,
  );
}
