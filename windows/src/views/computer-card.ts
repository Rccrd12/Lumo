// The permission card's middle for a computer use action (views.ts buildApproval):
// what will be done, on what, where.
//
// An action on a point (a click, a move, a scroll, a drag's end) shows the
// screen around that point, the point marked ("Click · at the marked point"),
// a click away from its whole size, and, apart, what the app says the thing
// there is ("The app calls it «Save as…»", "Menu item · Notepad"): the app
// chooses that name (a web page writes what it likes in it), so it is never
// what the card says will be done. The coordinates stay under it, small.
// Typing and keys show, whole, the text and the keys: that is what Allow
// allows, so it is never shortened.

import "./computer-card.css";
import { Bridge } from "../core/bridge";
import { computerToolName, peekPlacement, splitComputerLine } from "../core/computer";
import type { ComputerPeek } from "../core/computer-use";
import { State, type ApprovalInfo } from "../core/state";
import { N_, t } from "../i18n/i18n";
import { h } from "./dom";

/** The thumbnail's size, CSS pixels (computer-card.css .cu-target-thumb). */
export const THUMB_W = 150;
export const THUMB_H = 94;
/** Enlarged: the crop at its own size (computer.rs PEEK_SIZE), CSS pixels (.cu-target-point.big). */
export const BIG_W = 360;
export const BIG_H = 200;

export const COMPUTER_CARD_TEXT = {
  atPoint: N_("at the marked point"),
  toPoint: N_("to the marked point"),
  calls: N_("The app calls it «{name}»"),
  enlarge: N_("Enlarge"),
  smaller: N_("Smaller"),
  paused: N_("Paused: this action won't be done. After Resume, {agent} looks at the screen again and asks again."),
};

/** The screen around the point of the request on screen: asked once per request. */
let peekFor: { requestId: string; peek: Promise<ComputerPeek | null> } | null = null;

function peekOnce(info: ApprovalInfo, at: [number, number]): Promise<ComputerPeek | null> {
  if (peekFor?.requestId !== info.requestId || !info.requestId) {
    peekFor = { requestId: info.requestId, peek: Bridge.computerPeek(at[0], at[1]).catch(() => null) };
  }
  return peekFor.peek;
}

/** A crop Rust sent, as far as the card can use it: a PNG in base64, a size and a point. */
function usablePeek(p: ComputerPeek | null): ComputerPeek | null {
  if (!p || typeof p !== "object" || typeof p.image !== "string" || !p.image) return null;
  if (!/^[A-Za-z0-9+/]+=*$/.test(p.image)) return null;
  if (!(p.width > 0 && p.height > 0)) return null;
  if (!Array.isArray(p.at) || p.at.length !== 2 || !p.at.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return p;
}

const text = (v: unknown): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");

/** The words with `{name}` in them, the name drawn apart (its own span). */
function withName(words: string, name: string): (Node | string)[] {
  const at = words.indexOf("{name}");
  if (at < 0) return [words];
  return [words.slice(0, at), h("span", { class: "cu-target-name", text: name }), words.slice(at + 6)];
}

/**
 * While computer use is paused, the line under a computer action's card: it
 * won't be done, whatever the answer (the agent looks again and asks again
 * once resumed). Null otherwise. views.ts shows it under the box.
 */
export function pausedCardLine(): string | null {
  const c = State.computer;
  return c?.engaged && c.paused && !c.stopped ? t(COMPUTER_CARD_TEXT.paused, { agent: c.agent }) : null;
}

/** The action in words, as describeComputerAction says it: what is done in Lumo's amber, then on what. */
function plainLine(line: string): HTMLElement {
  const { label, detail } = splitComputerLine(line);
  return h("div", { class: "cu-target-what", title: line },
    h("span", { class: "cu-target-verb", text: label }), detail ? ` ${detail}` : null);
}

/**
 * The card's box for a computer action, or null to keep the usual command
 * line (any other tool). Built once per request; the screen's crop comes in
 * when Rust has it.
 */
export function computerTargetBox(info: ApprovalInfo): HTMLElement | null {
  const tool = computerToolName(info.tool);
  if (tool == null) return null;
  const line = info.command || info.tool;
  // No point: the text to type or the keys, whole, as the card's command
  // line shows them (⏎ and ⇥ where they fall, scrolling past six lines).
  const at = info.computerAt;
  if (!at) {
    const { label, detail } = splitComputerLine(line);
    const box = h("div", { class: "cu-target cu-target-typed", title: line },
      h("span", { class: "cu-target-verb", text: label }), detail ? h("span", { class: "cu-target-text", text: detail }) : null);
    box.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
    return box;
  }
  const what = h("div", { class: "cu-target-words" }, plainLine(line));
  const thumb = h("div", { class: "cu-target-thumb", "aria-hidden": "true" });
  const box = h("div", { class: "cu-target cu-target-point" }, thumb, what);
  void peekOnce(info, at).then((raw) => {
    const peek = usablePeek(raw);
    if (!peek) {
      // Nothing to show of the screen: the words alone.
      thumb.remove();
      return;
    }
    const img = h("img", { class: "cu-target-shot", alt: "", draggable: "false", src: `data:image/png;base64,${peek.image}` });
    const mark = h("i", { class: "cu-target-mark" });
    /** The crop and its point in the box, small or at its own size. */
    const placeIn = (big: boolean) => {
      const place = peekPlacement(peek, big ? BIG_W : THUMB_W, big ? BIG_H : THUMB_H);
      img.style.width = `${peek.width * place.scale}px`;
      img.style.height = `${peek.height * place.scale}px`;
      img.style.left = `${place.left}px`;
      img.style.top = `${place.top}px`;
      mark.style.left = `${place.x}px`;
      mark.style.top = `${place.y}px`;
    };
    placeIn(false);
    thumb.replaceChildren(img, mark);
    thumb.classList.add("loaded");
    // What will be done is what the picture shows: the action, on the point
    // marked in it. What the app calls the thing there comes apart, as the
    // app's words: never the card's own.
    const { label, detail } = splitComputerLine(line);
    const drag = computerToolName(info.tool) === "left_click_drag";
    const zoom = h("button", { class: "cu-target-zoom", type: "button", text: t(COMPUTER_CARD_TEXT.enlarge) });
    const toggle = () => {
      const big = !box.classList.contains("big");
      box.classList.toggle("big", big);
      placeIn(big);
      zoom.textContent = t(big ? COMPUTER_CARD_TEXT.smaller : COMPUTER_CARD_TEXT.enlarge);
      // The card grows or shrinks with it (views.ts fitHeight).
      State.notify();
    };
    zoom.addEventListener("click", toggle);
    thumb.addEventListener("click", toggle);
    thumb.removeAttribute("aria-hidden");
    thumb.title = t(COMPUTER_CARD_TEXT.enlarge);
    const name = text(peek.name);
    const where = [text(peek.role), text(peek.app)].filter(Boolean).join(" · ");
    const on = t(drag ? COMPUTER_CARD_TEXT.toPoint : COMPUTER_CARD_TEXT.atPoint);
    what.replaceChildren(...[
      h("div", { class: "cu-target-what", title: `${label} · ${on}` },
        h("span", { class: "cu-target-verb", text: label }), h("span", { class: "cu-target-on", text: ` · ${on}` })),
      name ? h("div", { class: "cu-target-called", title: t(COMPUTER_CARD_TEXT.calls, { name }) }, ...withName(t(COMPUTER_CARD_TEXT.calls), name)) : null,
      where ? h("div", { class: "cu-target-where", text: where, title: where }) : null,
      h("div", { class: "cu-target-at", title: line }, detail ? `${detail} · ` : "", zoom),
    ].filter((x): x is HTMLDivElement => x != null));
  });
  return box;
}
