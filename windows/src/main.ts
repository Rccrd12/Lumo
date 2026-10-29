// Entry point: boot the bridge, wire the island, start the greeting.

import "./core/legacy";
import "./style.css";
import { Bridge, IS_TAURI, lendTauri, onEvent, type IslandShift, type MailMessage } from "./core/bridge";
import { Sound } from "./core/sound";
import { State, type Settings } from "./core/state";
import { Island } from "./island/island";
import { registerHookHandlers } from "./island/hooks";
import { registerIntegrationHandlers, refreshConfigured } from "./island/integrations";
import { startCalendarListening } from "./island/listen-calendar";
import { registerShortcutHandlers } from "./island/shortcuts";
import { Recap } from "./recap/recap";
import { onLanguageChange, resolveLanguage, setLanguage, systemLanguages, t } from "./i18n/i18n";
import { COMPUTER_TEXT } from "./core/computer";
import { compactNotice } from "./core/compact";
import { CHECK_DELAY_MS, NOTICE_MS as UPDATE_NOTICE_MS, checkOnOpen } from "./core/update-check";

/** Shows the language Settings asks for ("" = the system's, when Lumo has it). */
function applyLanguage() {
  setLanguage(resolveLanguage(State.settings.language, systemLanguages()));
}

async function main() {
  const root = document.getElementById("root");
  if (!root) return;

  void Sound.preload();
  // The Settings view is settings.html in a frame: it reaches Rust through us.
  if (IS_TAURI) lendTauri();

  const island = new Island(root);

  const boot = await Bridge.boot();
  if (boot) {
    State.settings = { ...State.settings, ...boot.settings };
    State.onBattery = boot.onBattery === true;
  }
  // A language change redraws the island in place: the texts given as tl(…)
  // relabel themselves (views/dom.ts) and the views redraw the rest on this
  // sync. Nothing is rebuilt, so tasks, steps and the chat stay as they are.
  onLanguageChange(() => State.notify());
  applyLanguage();
  // Rust shows the tray and its errors in the same language as the webview.
  void Bridge.setSystemLanguages(systemLanguages());
  island.applySettings();
  State.loadIntegrationTasks();
  if (boot?.shift) island.onShift(boot.shift);

  await onEvent<{ x: number; y: number; panel?: boolean; plan?: boolean }>("cursor", ({ x, y, panel, plan }) => island.onCursor(x, y, panel === true || plan === true));
  // A press elsewhere on the screen: folds the open island when set to (Settings → Island).
  await onEvent<null>("outside-press", () => island.onOutsidePress());
  // The left button let go anywhere on the screen: ends a file drag the page never saw end.
  await onEvent<null>("left-up", () => island.onLeftUp());
  // Esc stopped the chat's computer use (computer.rs).
  await onEvent<null>("computer-stopped", () => compactNotice(t(COMPUTER_TEXT.stopped), "#F5A524"));
  // Claude starts or stops using the computer (computer.rs): the island closes to Lumo's ring.
  await onEvent<boolean>("computer-engaged", (on) => island.onComputer(on === true));
  await onEvent<MailMessage[]>("mail-new", (messages) => island.newMail(messages));
  // Unplugged or plugged in: Settings → General → Energy on "Automatic" follows.
  await onEvent<boolean>("energy-power", (onBattery) => {
    State.onBattery = onBattery === true;
    State.notify();
  });

  /** Pause has to reach Rust too, or the pollers keep calling out. */
  const setPaused = (on: boolean) => {
    if (State.paused === on) return;
    State.paused = on;
    void Bridge.setPaused(on);
  };

  await onEvent<string>("tray", (what) => {
    switch (what) {
      case "settings":
        setPaused(false);
        island.alert("settings");
        island.takeKeyboard();
        break;
      case "open":
        setPaused(false);
        island.takeKeyboard();
        island.alert(State.defaultView());
        break;
      case "recap":
        setPaused(false);
        void Recap.open(island);
        break;
      case "wardrobe":
        setPaused(false);
        island.alert("wardrobe");
        break;
      // A left click on the tray icon: the island into its edge, or back.
      case "toggle":
        if (State.paused || State.mode === "hidden") {
          setPaused(false);
          island.reveal();
        } else {
          island.hideInEdge();
        }
        break;
      case "pause":
        setPaused(!State.paused);
        if (State.paused) island.fsm.forceHidden();
        else island.reveal();
        break;
    }
  });

  await onEvent<null>("screen-changed", () => void Bridge.reposition());
  // An edge of the island being dragged: island.rs sends each new size.
  await onEvent<{ width: number; height: number }>("island-resize", (size) => island.onResize(size));
  // A moved island was let go: island.rs says which edge it is heading for.
  await onEvent<{ dock: string; offset: number; float: number; shiftX: number; shiftY: number }>(
    "island-dock", (place) => island.onDock(place));
  await onEvent<IslandShift>("island-shift", (shift) => island.onShift(shift));

  // The settings window writes preferences; apply them here without a restart.
  await onEvent<Settings>("settings-changed", (s) => {
    const previousMain = State.mainPillId;
    State.settings = { ...State.settings, ...s };
    applyLanguage();
    island.applySettings();
    State.loadIntegrationTasks();
    // A new main tool comes to the front.
    if (State.mainPillId !== previousMain) State.setFocus(State.mainPillId);
    void refreshConfigured();
  });

  registerHookHandlers(island);
  registerIntegrationHandlers(island);
  startCalendarListening();
  registerShortcutHandlers(island, () => setPaused(false));

  // Monday recap: app start (greeting over), an agent starting work, waking up.
  const checkRecap = () => void Recap.check(island);
  island.onGreetingDone = checkRecap;
  island.onWake = checkRecap;
  await onEvent<null>("recap-check", checkRecap);

  island.launch();

  // A newer Lumo on GitHub: said on the island once it is up (Settings →
  // Updates → Check when Lumo opens). Only Update now, there, installs it.
  if (IS_TAURI) {
    window.setTimeout(() => {
      void checkOnOpen({
        enabled: State.settings.updateCheckOnOpen !== false,
        check: Bridge.updateCheck,
        notify: (latest) => compactNotice(t("Lumo {version} is available: Settings → Updates", { version: latest }), "#22c55e", UPDATE_NOTICE_MS),
        log: (line) => void Bridge.log(line),
      });
    }, CHECK_DELAY_MS);
  }

  // In a plain browser there is no wake strip behind the cursor: make the whole
  // page wake the island so the visuals can be checked with `npm run dev`.
  if (!IS_TAURI) {
    document.addEventListener("click", () => Sound.resume(), { once: true });
  }
}

void main();
