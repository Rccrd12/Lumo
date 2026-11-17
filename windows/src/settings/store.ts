// What every section of Settings shares: the settings on screen and their
// saving, the switch and the list every row draws with, and what one section
// asks of the others (the pills shown elsewhere, a redraw of them all).

import { Bridge } from "../core/bridge";
import { DEFAULT_SETTINGS, type Settings } from "../core/state";
import { h } from "../views/dom";
import { resolveLanguage, setLanguage, systemLanguages } from "../i18n/i18n";

/** Where secrets.rs keeps the keys. */
export const KEY_STORE = "Windows Credential Manager";

export let settings: Settings = { ...DEFAULT_SETTINGS };
export let version = "";
/** The computer runs on its battery (energy.rs), for General → Energy. */
export let onBattery = false;

/** The settings as main.ts read them, from Lumo and from each change. */
export function setSettings(next: Settings) {
  settings = next;
}

export function setVersion(next: string) {
  version = next;
}

export function setOnBattery(next: boolean) {
  onBattery = next;
}

export async function save() {
  await Bridge.saveSettings(settings);
}

/** A colour was picked for a pill's Lumo (see ./colors.ts): the island follows. */
export function pickColor(next: Record<string, string>) {
  settings.pillColors = next;
  void save();
}

export function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const el = h("button", { class: on ? "switch on" : "switch", "aria-pressed": on });
  el.addEventListener("click", () => {
    const next = !el.classList.contains("on");
    el.classList.toggle("on", next);
    onChange(next);
  });
  return el;
}

export function select(options: [string, string][], value: string, onChange: (v: string) => void): HTMLSelectElement {
  const el = h("select", {}) as HTMLSelectElement;
  for (const [id, label] of options) el.append(h("option", { value: id, text: label }));
  el.value = value;
  el.addEventListener("change", () => onChange(el.value));
  return el;
}

/** Everything that shows the declared pills, redrawn when any of them changes. */
export const declaredViews: (() => void)[] = [];

/**
 * `listener` on the window's `type` events while `el` is on the page: each
 * redraw of Settings builds its rows again, and a listener of the rows it
 * replaced goes at its next event instead of piling up (one more Outlook and
 * account check per focus at every redraw).
 */
export function whileShown(el: HTMLElement, type: "focus", listener: () => void) {
  const once = () => {
    if (!el.isConnected) {
      window.removeEventListener(type, once);
      return;
    }
    listener();
  };
  window.addEventListener(type, once);
}

/**
 * Shows the language Settings asks for. A change redraws the window in place,
 * where it was scrolled to: nothing reloads, nothing is written.
 */
export function applyLanguage() {
  setLanguage(resolveLanguage(settings.language, systemLanguages()));
}

/** Redraws every section (main.ts rerender), for a change that touches them all. */
let rerenderAll: () => Promise<void> = async () => {};

export function rerender(): Promise<void> {
  return rerenderAll();
}

export function onRerender(redraw: () => Promise<void>) {
  rerenderAll = redraw;
}
