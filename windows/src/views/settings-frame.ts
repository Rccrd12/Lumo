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

/** The frame, once Settings were opened in the island (there is one). */
let shownFrame: HTMLIFrameElement | null = null;
/** Told when the cursor goes in or out of a field in the frame, or a key is typed there. */
let fieldChanged: (() => void) | null = null;

/** The island's leave countdown follows the fields of Settings, as it does the chat's (island.ts). */
export function onSettingsFieldChanged(fn: () => void) {
  fieldChanged = fn;
}

/** Fields that are written in, as opposed to ticked or pressed. */
const WRITTEN = new Set(["", "text", "password", "search", "url", "email", "number", "tel"]);

/**
 * What a mouse leave waits for with the cursor in this field of Settings, as
 * with the chat's (island.ts leaveHold): something written in it keeps the
 * island open (a key half pasted), an empty one or a list gives it a while.
 */
export function fieldHold(field: Element | null | undefined): "keep" | "linger" | "none" {
  if (!field) return "none";
  const tag = field.tagName.toUpperCase();
  const typed = tag === "TEXTAREA" || (tag === "INPUT" && WRITTEN.has(((field as HTMLInputElement).type ?? "").toLowerCase()));
  if (typed) return ((field as HTMLInputElement).value ?? "").trim() !== "" ? "keep" : "linger";
  return tag === "SELECT" ? "linger" : "none";
}

/** The same for the field the cursor is in now, in Settings inside the island while it has the keyboard. */
export function settingsHold(): "keep" | "linger" | "none" {
  const frame = shownFrame;
  if (!frame || document.activeElement !== frame || !document.hasFocus()) return "none";
  try {
    return fieldHold(frame.contentDocument?.activeElement);
  } catch {
    return "none";
  }
}

/** The page in the frame tells the island when the cursor moves between its fields, and when it is typed in. */
function watchFields(frame: HTMLIFrameElement) {
  const page = frame.contentDocument;
  const inner = frame.contentWindow;
  if (!page || !inner) return;
  const changed = () => fieldChanged?.();
  for (const type of ["input", "change", "focusin", "focusout"]) page.addEventListener(type, changed, true);
  // The island losing the keyboard to another app while the cursor is in the frame.
  inner.addEventListener("focus", changed);
  inner.addEventListener("blur", changed);
}

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
      actions.closeSettings();
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
      const made = h("iframe", { src: "settings.html?embedded", title: tl("Settings") }) as HTMLIFrameElement;
      made.addEventListener("load", () => watchFields(made));
      frame = made;
      shownFrame = made;
      shell.append(made);
    },
    focus() {
      frame?.focus();
    },
  };
}
