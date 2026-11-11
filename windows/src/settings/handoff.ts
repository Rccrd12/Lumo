// Settings inside the island can look at a change to another program's
// settings (Claude Code's settings.json, an agent's hooks, the status line)
// but never write it: confirmed.rs takes the write only from the Settings
// window, after a preview shown there, since the island's page also shows what
// the AI writes. So a click on Install… or Uninstall… inside the island opens
// the Settings window with that same change on screen, to confirm there.
//
// The two pages share their storage (same origin, same WebView2): the island's
// writes what to show, the window takes it once when it comes to the front.

import { Bridge, EMBEDDED } from "../core/bridge";
import { clear, h } from "../views/dom";
import { t } from "../i18n/i18n";

/** Where the island's Settings leave the change for the window (read once, then removed). */
export const HANDOFF_KEY = "lumo.settings.handoff";

/** A hand-off older than this is not shown: the click it came from is long gone. */
export const HANDOFF_FRESH_MS = 30_000;

/** Which change: "hooks", "statusline", "plan" (the plan switch) or "agent:<id>". */
export interface Handoff {
  what: string;
  install: boolean;
  at: number;
}

/** These Settings are the ones inside the island, not the window. */
export const IN_ISLAND = EMBEDDED || (typeof location !== "undefined" && new URLSearchParams(location.search).has("embedded"));

const WHAT = /^(?:hooks|statusline|plan|agent:[a-z0-9][a-z0-9_-]{0,63})$/;

/** What the island's Settings store for `what`. */
export function handoffText(what: string, install: boolean, now: number): string {
  return JSON.stringify({ what, install, at: now });
}

/** The hand-off in `raw`, if it is one, of a known change, and recent. */
export function parseHandoff(raw: string | null | undefined, now: number): Handoff | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const { what, install, at } = v as Record<string, unknown>;
  if (typeof what !== "string" || !WHAT.test(what) || typeof install !== "boolean" || typeof at !== "number") return null;
  // From the future (a clock moved) or from long ago: not this click's.
  if (at > now + 5_000 || now - at > HANDOFF_FRESH_MS) return null;
  return { what, install, at };
}

/** Each section's way to show its change's preview, by `what` (the window's); it returns where it shows it. */
type Review = (install: boolean) => HTMLElement | void;
const reviewers = new Map<string, Review>();

/** The section drawn last for `what` shows its preview when the window is handed one. */
export function onHandoff(what: string, review: Review) {
  reviewers.set(what, review);
}

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Inside the island: leaves the change for the window and opens it. False
 * when it can't be left (no storage): the caller says so.
 */
export function handOff(what: string, install: boolean, open: () => unknown, now = Date.now()): boolean {
  const store = storage();
  if (!store) return false;
  try {
    store.setItem(HANDOFF_KEY, handoffText(what, install, now));
  } catch {
    return false;
  }
  void open();
  return true;
}

/**
 * In the window: takes the change left by the island, once, and has its
 * section show the preview. `show` brings the section's page on screen first.
 * Returns what it showed, or null.
 */
export function takeHandoff(show: (h: Handoff) => void, now = Date.now()): Handoff | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null = null;
  try {
    raw = store.getItem(HANDOFF_KEY);
    if (raw !== null) store.removeItem(HANDOFF_KEY);
  } catch {
    return null;
  }
  const handoff = parseHandoff(raw, now);
  if (!handoff) return null;
  const review = reviewers.get(handoff.what);
  if (!review) return null;
  show(handoff);
  const where = review(handoff.install);
  // The agent's block may be far down the page.
  if (where && typeof where.scrollIntoView === "function") where.scrollIntoView({ block: "nearest" });
  return handoff;
}

/**
 * Inside the island, in place of the preview: the Settings window opens with
 * the change on screen, and `body` says so. `back` redraws the section.
 */
export function reviewInWindow(body: HTMLElement, what: string, install: boolean, back: () => void) {
  handOff(what, install, Bridge.openSettingsWindow);
  clear(body);
  body.append(
    h("div", { class: "hint", text: t("Lumo's Settings window shows the changes: look at them and confirm there.") }),
    h("div", { class: "row" },
      h("button", { class: "primary", text: t("Open in a window"), onclick: () => void handOff(what, install, Bridge.openSettingsWindow) }),
      h("button", { text: t("Back"), onclick: back }),
    ),
  );
}
