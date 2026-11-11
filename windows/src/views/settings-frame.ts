// Settings inside the island: the Settings page (settings.html) in a frame. It
// loads the first time the gear is pressed and then stays, so it opens at once
// afterwards and keeps the section and the scroll it was left on. Its calls to
// Rust go through this page (core/bridge.ts, lendTauri).

import { State } from "../core/state";
import { tl } from "../i18n/i18n";
import { h } from "./dom";
import type { ViewActions, ViewHost } from "./views";

/** What the page in the frame tells the island (src/settings/main.ts). */
export const FRAME_READY = "lumo-settings:ready";
export const FRAME_CLOSE = "lumo-settings:close";
/** What the island tells the page: Settings are on screen again. */
export const FRAME_SHOWN = "lumo-settings:shown";

export function buildSettingsFrame(actions: ViewActions): ViewHost {
  let frame: HTMLIFrameElement | null = null;
  /** Settings were on screen at the last sync. */
  let onScreen = false;

  // Until the page says it is up; should it never, the window still opens.
  const waiting = h("div", { class: "settings-frame-wait" },
    h("span", { text: tl("Opening Settings…") }),
    h("button", { class: "link-btn", text: tl("Open in a window"), onclick: () => actions.openSettingsWindow() }),
  );
  const shell = h("div", { class: "card settings-frame" }, waiting);

  window.addEventListener("message", (e) => {
    if (frame == null || e.source !== frame.contentWindow) return;
    if (e.data === FRAME_READY) {
      waiting.hidden = true;
      frame.classList.add("ready");
    } else if (e.data === FRAME_CLOSE) {
      actions.collapse();
    }
  });

  return {
    el: h("div", { class: "view" }, shell),
    sync() {
      const shown = State.mode === "expanded" && State.view === "settings";
      const back = shown && !onScreen;
      onScreen = shown;
      // The page stays loaded between two openings: it is told, so what
      // changed meanwhile elsewhere (the island, the other window) shows.
      if (back && frame) frame.contentWindow?.postMessage(FRAME_SHOWN, location.origin);
      if (frame != null || !shown) return;
      frame = h("iframe", { src: "settings.html?embedded", title: tl("Settings") }) as HTMLIFrameElement;
      shell.append(frame);
    },
    focus() {
      frame?.focus();
    },
  };
}
