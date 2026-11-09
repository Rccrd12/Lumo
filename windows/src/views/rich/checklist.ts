// The checklist card: GitHub's task lists, which models write without being
// told, and the same lines in a block that gives them a title.
//
//   - [ ] Section `0.21.0` in `CHANGELOG.md`
//   - [x] Version in `tauri.conf.json`
//
//   ```lumo-checklist Release 0.21.0
//   - [ ] Section `0.21.0` in `CHANGELOG.md`
//   ```
//
// Each line has its box; a click ticks it or takes the tick off. The count
// and a bar under the list say how far it is, the next line to do is lit,
// and a finished list folds into one green line (a click opens it again).
// The ticks are saved with the chat (core/chats.ts), by the line's text. When
// a later answer writes the same list again (its title, or most of its lines),
// that one is the list to tick: it takes over the user's ticks and the lines
// the AI marked [x], and this one shows as one line saying it was updated
// below. core/checklists.ts holds the logic, chat.ts tells the AI what was
// ticked with the next question.

import { h, svg } from "../dom";
import { ICONS } from "../icons";
import { N_, t } from "../../i18n/i18n";
import { head, keyOf, remember, RICH_STRINGS, type RichContext } from "./index";
import { chatChecklists, setChatChecklists } from "../../core/chats";
import { itemsDone, scopeMessage, slotOf, withTick, type Checklist } from "../../core/checklists";
import "./checklist.css";

export const CHECKLIST_STRINGS = {
  done: N_("Completed · {done}/{total}"),
  moved: N_("Updated below"),
  tick: N_("Mark as done"),
  untick: N_("Mark as not done"),
  open: N_("Show the list"),
  close: N_("Hide the list"),
};

/** chevron.down */
const CHEVRON_DOWN = "M5.5 9 12 15.5 18.5 9";
/** arrow.down */
const ARROW_DOWN = "M12 5v14M6.5 13.5 12 19l5.5-5.5";

/** Where a card keeps its ticks: the chat's saved ones, or, outside a chat, its own. */
interface Ticks {
  done(): boolean[];
  set(i: number, done: boolean): void;
}

/** Whether a finished list is shown open; null until the user picks, folded when finished. */
interface Fold {
  open: boolean | null;
}

/** The card for `list`; ctx.message and ctx.list place it in its chat, when it is in one. */
export function renderChecklist(list: Checklist, ctx: RichContext): HTMLElement {
  const where = ctx.message ? scopeMessage(ctx.message) : null;
  const slot = where && ctx.list != null ? slotOf(where.chatId, where.message, ctx.list) : null;
  const key = keyOf({ type: "checklist", title: list.title, body: list.items.map((i) => `${i.done ? "x" : " "}${i.text}`).join("\n") }, ctx);
  const name = list.title || t(RICH_STRINGS.checklist);

  // An older version of a list written again further down: one line.
  if (slot && !slot.live) {
    return h(
      "div",
      { class: "rc-card rc-check folded moved", role: "group", "aria-label": name },
      head("checklist", list.title, h("span", { class: "rc-check-moved" }, svg(ARROW_DOWN, 11, { stroke: 2 }), h("span", { text: t(CHECKLIST_STRINGS.moved) }))),
    );
  }

  let ticks: Ticks;
  if (slot && where) {
    const { chatId } = where;
    ticks = {
      done: () => itemsDone(list, slot.message, chatChecklists(chatId)[slot.id]),
      set: (i, done) => {
        const all = chatChecklists(chatId);
        all[slot.id] = withTick(all[slot.id], list.items[i].text, done, slot.message);
        setChatChecklists(chatId, all);
      },
    };
  } else {
    const own = remember(key, () => list.items.map((i) => i.done));
    ticks = { done: () => [...own], set: (i, done) => (own[i] = done) };
  }
  const fold = remember<Fold>(slot && where ? `checklist\u0000${where.chatId}\u0000${slot.id}` : `${key}\u0000fold`, () => ({ open: null }));

  const card = h("div", { class: "rc-card rc-check", role: "group", "aria-label": name });
  const count = h("span", { class: "rc-count", "aria-live": "polite" });
  // The top line's right end, redrawn as the ticks change; the line itself stays.
  const tools = h("span", { class: "rc-check-tools" });
  const top = head("checklist", list.title, tools);
  const bar = h("i");
  const boxes: HTMLButtonElement[] = [];
  const rows = list.items.map((item, i) => {
    const box = h("button", { class: "rc-box", role: "checkbox" }) as HTMLButtonElement;
    boxes.push(box);
    const text = h("span", { class: "rc-check-text" });
    ctx.inline(text, item.text);
    const row = h("div", { class: "rc-check-row" }, box, text);
    if (item.indent) row.style.paddingLeft = `${8 + item.indent * 16}px`;
    // The whole line ticks, but a link in it still opens, and a drag across
    // its text (trying to select it) leaves the tick as it was.
    let down: { x: number; y: number } | null = null;
    row.addEventListener("pointerdown", (e) => {
      down = { x: e.clientX, y: e.clientY };
    });
    row.addEventListener("click", (e) => {
      const target = e.target as Element | null;
      if (target?.closest?.("a")) return;
      const from = down;
      down = null;
      if (from && e.detail > 0 && Math.hypot(e.clientX - from.x, e.clientY - from.y) > 4) return;
      toggle(i);
    });
    return row;
  });
  const listEl = h("div", { class: "rc-check-list" }, ...rows);
  const progress = h("div", { class: "rc-check-prog" }, bar);

  /** Whether the keyboard is on one of the card's buttons (a click leaves no ring to keep). */
  function keyboardInside(): boolean {
    const focused = typeof document !== "undefined" ? (document.activeElement as Element | null) : null;
    try {
      return !!focused && card.contains(focused) && focused.matches(":focus-visible");
    } catch {
      return false;
    }
  }

  function toggle(i: number) {
    const keyboard = keyboardInside();
    const done = ticks.done();
    ticks.set(i, !done[i]);
    show();
    // Ticked to the end from the keyboard: the list folds, the button that opens it takes the focus.
    if (keyboard && card.classList.contains("folded")) card.querySelector<HTMLElement>(".rc-check-fold")?.focus();
  }

  function toggleFold(open: boolean) {
    const keyboard = keyboardInside();
    fold.open = open;
    show();
    if (keyboard) card.querySelector<HTMLElement>(".rc-check-fold")?.focus();
  }

  function foldButton(open: boolean): HTMLElement {
    const label = t(open ? CHECKLIST_STRINGS.close : CHECKLIST_STRINGS.open);
    const icon = svg(CHEVRON_DOWN, 12, { stroke: 2 });
    const btn = h("button", { class: open ? "rc-nav rc-check-fold up" : "rc-nav rc-check-fold", title: label, "aria-label": label, "aria-expanded": String(open) }, icon);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleFold(!open);
    });
    return btn;
  }

  /** Brings the card to its ticks; the rows stay the same nodes, so a box keeps the focus. */
  function show() {
    const done = ticks.done();
    const total = list.items.length;
    const n = done.filter(Boolean).length;
    const finished = n === total;
    const open = fold.open ?? !finished;
    if (finished && !open) {
      card.className = "rc-card rc-check folded";
      const ok = h("span", { class: "rc-check-ok" }, svg(ICONS.check, 11, { stroke: 2.6 }), h("span", { text: t(CHECKLIST_STRINGS.done, { done: n, total }) }));
      tools.replaceChildren(ok, foldButton(false));
      if (card.childNodes.length !== 1) card.replaceChildren(top);
      return;
    }
    card.className = "rc-card rc-check";
    count.textContent = `${n} / ${total}`;
    const next = n > 0 ? done.indexOf(false) : -1;
    rows.forEach((row, i) => {
      row.className = done[i] ? "rc-check-row on" : i === next ? "rc-check-row next" : "rc-check-row";
      const box = boxes[i];
      box.setAttribute("aria-checked", String(done[i]));
      const label = t(done[i] ? CHECKLIST_STRINGS.untick : CHECKLIST_STRINGS.tick);
      box.title = label;
      box.setAttribute("aria-label", label);
      box.replaceChildren(...(done[i] ? [svg(ICONS.check, 10, { stroke: 2.8 })] : []));
    });
    bar.style.width = `${(n / total) * 100}%`;
    const copy = ctx.copyButton(listMarkdown(list, done));
    tools.replaceChildren(count, copy, ...(finished ? [foldButton(true)] : []));
    if (card.childNodes.length !== 3) card.replaceChildren(top, listEl, progress);
  }

  show();
  return card;
}

/** The list as GitHub writes it, ticks as they are now, its title first. */
export function listMarkdown(list: Checklist, done: boolean[]): string {
  const lines = list.items.map((item, i) => `${"  ".repeat(item.indent)}- [${done[i] ? "x" : " "}] ${item.text}`);
  return (list.title ? [list.title, ...lines] : lines).join("\n");
}
