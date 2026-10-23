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
  /** Brings the island out of its edge, to the closed island. */
  reveal(): void;
  setView(view: IslandViewName): void;
  collapse(): void;
  emote(name: BotEmoteName): void;
  setPinned(on: boolean): void;
  /** Gives the island the keyboard, so the in-island keys work (Mac: makeKey). */
  takeKeyboard(): void;
  /** The wardrobe from any state, or back if it is open (Island.wardrobeAnywhere). */
  wardrobeAnywhere(): void;
  /** Keeps the open island open while the mouse is elsewhere, for a while (Island.holdOpen). */
  holdOpen(): void;
}

function focusPill(host: ShortcutHost, id: string | null, open: boolean) {
  if (!id) return;
  State.setFocus(id);
  Sound.play("blip");
  if (open) {
    host.alert("overview");
    host.holdOpen();
  } else host.setView("overview");
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
        // Opened from the keyboard, the mouse is elsewhere: it stays open a
        // while, even set to close as soon as the mouse leaves.
        host.holdOpen();
      }
      break;

    case "openChat":
      resume();
      State.useSlot("chat");
      host.alert("prompt");
      host.takeKeyboard();
      host.holdOpen();
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
        host.holdOpen();
      } else if (asking) {
        resume();
        State.setFocus(asking.id);
        host.alert("question");
        host.takeKeyboard();
        host.holdOpen();
      } else {
        // Nothing is waiting: Lumo says so.
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

    // Gemini Live: starts a call where the island is, closed or open, and
    // then pauses it (the microphone goes off) or picks it up again. A call
    // going on behind another open view comes back first. End is in the call view.
    case "talkToGemini":
      resume();
      if (!Live.active) {
        if (State.mode === "expanded") host.alert("live");
        // Tucked into the edge, it comes out: the closed island shows the
        // call, and a hidden one would leave the microphone on with nothing
        // on screen to end it.
        else if (State.mode === "hidden") host.reveal();
        void Live.start();
      } else if (State.mode === "expanded" && State.view !== "live") {
        host.alert("live");
      } else {
        Live.toggleMute();
        Sound.play("tick");
      }
      break;

    // wardrobeToggle never comes this way (Rust sends `open-wardrobe`), nor do
    // askScreen / askSelection / askPage (`ask-context`, runShared).
    default:
      break;
  }
}

/**
 * "Ask about my screen", "Ask about the selected text" or "Ask about the page
 * in the browser": Rust took the screenshot, read the selection or the page on
 * screen in the browser on the key press (shortcuts.rs). The chat
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
  // The mouse is still on what was selected, away from the island: it must
  // not fold before the question is typed.
  host.holdOpen();
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
      // An answer still being written goes on in its own chat.
      State.startChat();
      State.droppedFile = null;
      State.promptContext = null;
      void Bridge.chatReset(State.chatId);
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
  // wardrobe (character/wardrobe.ts, views/wardrobe.ts), or closes it again.
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
