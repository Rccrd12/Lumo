// Lumo's own right-click menu, instead of the webview's: Refresh, the text
// actions where they apply (Cut, Copy, Paste, Select all), and the items
// picked in Settings (core/context-menu.ts). The island, its live activities
// window and the Settings window each open it with what they offer.
//
// A plain list of buttons in the page, kept inside the window. Clicking an
// item never takes the focus from the field it acts on (mousedown is held
// back), so Cut and Paste land where the right click was.

import { Bridge } from "../core/bridge";
import { textActions, MENU_TEXT, type TextContext } from "../core/context-menu";
import { t } from "../i18n/i18n";
import { h, svg } from "./dom";
import { ICONS } from "./icons";
import "./context-menu.css";

export type MenuEntry =
  | {
    kind: "item";
    label: string;
    run: () => void;
    /** A switch: a tick when on. */
    checked?: boolean;
    /** The key that does the same, shown on the right. */
    shortcut?: string;
    title?: string;
  }
  | { kind: "sep" };

/** Keeps a little room from the window's edges. */
const EDGE = 6;

export class ContextMenu {
  readonly el = h("div", { class: "ctx-menu", role: "menu" });
  private entries: MenuEntry[] = [];
  private active = -1;
  private open_ = false;
  /** Opened or closed: the island takes the menu into the part that gets the mouse. */
  onChange: (() => void) | null = null;

  constructor() {
    this.el.addEventListener("contextmenu", (e) => e.preventDefault());
    document.body.append(this.el);
    // Anywhere else: the menu goes. In the capture phase, before what was
    // clicked reacts, and without stopping it.
    window.addEventListener("mousedown", (e) => {
      if (this.open_ && !this.el.contains(e.target as Node)) this.close();
    }, true);
    window.addEventListener("blur", () => this.close());
    window.addEventListener("resize", () => this.close());
    window.addEventListener("keydown", (e) => {
      if (!this.open_) return;
      if (e.key === "Escape") this.close();
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") this.move(e.key === "ArrowDown" ? 1 : -1);
      else if (e.key === "Enter" && this.active >= 0) this.runAt(this.active);
      else return;
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }

  get isOpen(): boolean {
    return this.open_;
  }

  /** Where it is on the page, while open. */
  rect(): { x: number; y: number; w: number; h: number } | null {
    if (!this.open_) return null;
    const r = this.el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  /** Opens at (x, y), page pixels, inside `bounds` (the window by default). */
  open(x: number, y: number, entries: MenuEntry[], bounds?: { x: number; y: number; w: number; h: number }) {
    // No separator first, last or twice.
    this.entries = entries.filter((e, i, all) => e.kind !== "sep" || (i > 0 && i < all.length - 1 && all[i - 1].kind !== "sep"));
    if (!this.entries.length) return this.close();
    this.active = -1;
    this.el.replaceChildren(...this.entries.map((e, i) => this.draw(e, i)));
    this.el.classList.add("open");
    this.open_ = true;
    const box = bounds ?? { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
    const r = this.el.getBoundingClientRect();
    // Below and right of the pointer; flipped where there is no room.
    let left = x + r.width > box.x + box.w - EDGE ? x - r.width : x;
    let top = y + r.height > box.y + box.h - EDGE ? y - r.height : y;
    left = Math.max(box.x + EDGE, Math.min(left, box.x + box.w - r.width - EDGE));
    top = Math.max(box.y + EDGE, Math.min(top, box.y + box.h - r.height - EDGE));
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
    this.onChange?.();
  }

  close() {
    if (!this.open_) return;
    this.open_ = false;
    this.el.classList.remove("open");
    this.onChange?.();
  }

  private draw(e: MenuEntry, i: number): HTMLElement {
    if (e.kind === "sep") return h("div", { class: "ctx-sep", role: "separator" });
    const item = h("button", { class: "ctx-item", role: e.checked == null ? "menuitem" : "menuitemcheckbox", title: e.title ?? "" },
      h("span", { class: "ctx-check" }, e.checked ? svg(ICONS.check, 11, { stroke: 2.2 }) : null),
      h("span", { class: "ctx-label", text: e.label }),
      e.shortcut ? h("span", { class: "ctx-key", text: e.shortcut }) : null,
    );
    if (e.checked != null) item.setAttribute("aria-checked", String(e.checked));
    // The field keeps the focus (and its selection) for Cut, Copy and Paste.
    item.addEventListener("mousedown", (ev) => ev.preventDefault());
    item.addEventListener("mouseenter", () => this.highlight(i));
    item.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.runAt(i);
    });
    return item;
  }

  private runAt(i: number) {
    const e = this.entries[i];
    if (!e || e.kind !== "item") return;
    this.close();
    e.run();
  }

  private highlight(i: number) {
    this.active = i;
    this.el.querySelectorAll(".ctx-item, .ctx-sep").forEach((n, k) => n.classList.toggle("active", k === i));
  }

  private move(step: number) {
    const n = this.entries.length;
    let i = this.active;
    for (let k = 0; k < n; k++) {
      i = (i + step + n) % n;
      if (this.entries[i].kind === "item") break;
    }
    this.highlight(i);
  }
}

// ── Text actions ──────────────────────────────────────────────────────────────

type Field = HTMLInputElement | HTMLTextAreaElement;

const TYPED = new Set(["text", "search", "url", "email", "password", "tel", "number", ""]);

/** The field the right click landed in, if it can be typed in. */
function fieldOf(target: EventTarget | null): Field | HTMLElement | null {
  const el = target instanceof Element ? target.closest("input, textarea, [contenteditable='true'], [contenteditable='']") : null;
  if (!el) return null;
  if (el instanceof HTMLInputElement) return TYPED.has(el.type) && !el.readOnly && !el.disabled ? el : null;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled ? el : null;
  return el as HTMLElement;
}

function isField(el: Field | HTMLElement): el is Field {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/** What Cut, Copy, Paste and Select all can do for a right click on `target`. */
export function textContextOf(target: EventTarget | null): { context: TextContext; field: Field | HTMLElement | null } {
  const field = fieldOf(target);
  let selected = (window.getSelection()?.toString() ?? "") !== "";
  let hasText = false;
  if (field && isField(field)) {
    // Passwords are typed, never copied out.
    const start = field.selectionStart ?? 0;
    const end = field.selectionEnd ?? 0;
    selected = end > start && !(field instanceof HTMLInputElement && field.type === "password");
    hasText = field.value !== "";
  } else if (field) {
    hasText = (field.textContent ?? "") !== "";
  }
  return { context: { editable: field != null, selected, hasText }, field };
}

/** The text actions for a right click on `target`, ready for the menu. */
export function textEntries(target: EventTarget | null): MenuEntry[] {
  const { context, field } = textContextOf(target);
  return textActions(context).map((action): MenuEntry => {
    switch (action) {
      case "cut":
        return { kind: "item", label: t(MENU_TEXT.cut), shortcut: "Ctrl+X", run: () => void copySelection(field, true) };
      case "copy":
        return { kind: "item", label: t(MENU_TEXT.copy), shortcut: "Ctrl+C", run: () => void copySelection(field, false) };
      case "paste":
        return { kind: "item", label: t(MENU_TEXT.paste), shortcut: "Ctrl+V", run: () => void pasteInto(field!) };
      case "selectAll":
        return { kind: "item", label: t(MENU_TEXT.selectAll), shortcut: "Ctrl+A", run: () => selectAll(field!) };
    }
  });
}

async function copySelection(field: Field | HTMLElement | null, cut: boolean) {
  let text: string;
  if (field && isField(field)) {
    field.focus();
    text = field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0);
  } else {
    text = window.getSelection()?.toString() ?? "";
  }
  if (!text) return;
  // The page's own command keeps the field's undo; the clipboard API when it is refused.
  if (!document.execCommand(cut ? "cut" : "copy")) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    if (cut && field && isField(field)) replaceSelection(field, "");
  }
}

async function pasteInto(field: Field | HTMLElement) {
  let text: string | null = null;
  try {
    text = await navigator.clipboard.readText();
  } catch {
    // The webview may not let the page read it: Lumo reads it (clipboard.rs).
  }
  if (!text) text = (await Bridge.clipboardText()) ?? null;
  if (!text) return;
  field.focus();
  if (isField(field)) replaceSelection(field, text);
  else document.execCommand("insertText", false, text);
}

/** Puts `text` where the selection is, as typing would (the field hears an input). */
function replaceSelection(field: Field, text: string) {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  if (document.execCommand("insertText", false, text)) return;
  field.setRangeText(text, start, end, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function selectAll(field: Field | HTMLElement) {
  field.focus();
  if (isField(field)) field.select();
  else document.execCommand("selectAll");
}

/**
 * A page with nothing but text to offer (Settings): the text actions where
 * they apply, and no menu at all elsewhere — never the webview's.
 */
export function installTextMenu(): ContextMenu {
  const menu = new ContextMenu();
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    menu.open(e.clientX, e.clientY, textEntries(e.target));
  });
  return menu;
}
