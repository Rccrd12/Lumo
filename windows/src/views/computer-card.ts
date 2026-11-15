// The permission card's middle for a computer use action (views.ts buildApproval):
// what will be done, on what, where.
//
// An action on a point (a click, a move, a scroll, a drag's end) shows the
// screen around that point, the point marked, and what Windows calls the thing
// there ("Click on «Save as…»", "Menu item · Notepad"), the coordinates still
// under it, small. Typing and keys show, whole, the text and the keys: that is
// what Allow allows, so it is never shortened.

import "./computer-card.css";
import { Bridge } from "../core/bridge";
import { computerActionOn, computerToolName, peekPlacement, splitComputerLine } from "../core/computer";
import type { ComputerPeek } from "../core/computer-use";
import type { ApprovalInfo } from "../core/state";
import { h } from "./dom";

/** The thumbnail's size, CSS pixels (computer-card.css .cu-target-thumb). */
export const THUMB_W = 112;
export const THUMB_H = 72;

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
    const place = peekPlacement(peek, THUMB_W, THUMB_H);
    const img = h("img", { class: "cu-target-shot", alt: "", draggable: "false", src: `data:image/png;base64,${peek.image}` });
    img.style.width = `${peek.width * place.scale}px`;
    img.style.height = `${peek.height * place.scale}px`;
    img.style.left = `${place.left}px`;
    img.style.top = `${place.top}px`;
    const mark = h("i", { class: "cu-target-mark" });
    mark.style.left = `${place.x}px`;
    mark.style.top = `${place.y}px`;
    thumb.replaceChildren(img, mark);
    thumb.classList.add("loaded");
    // What Windows calls the thing there: the action said on it, the numbers small under it.
    const name = text(peek.name);
    // A scroll's way comes with the request (hooks.ts, scrollDirection), never
    // read back off the translated line: without it, the plain line stays.
    const on = name ? computerActionOn(info.tool, { scroll_direction: info.computerScroll }, name) : null;
    if (!on) return;
    const { detail } = splitComputerLine(line);
    const said = `${on.before}${on.name}${on.after}`;
    const where = [text(peek.role), text(peek.app)].filter(Boolean).join(" · ");
    what.replaceChildren(...[
      h("div", { class: "cu-target-what", title: said },
        on.before ? h("span", { class: "cu-target-verb", text: on.before }) : null,
        h("span", { class: "cu-target-name", text: on.name }),
        on.after ? h("span", { class: "cu-target-verb", text: on.after }) : null),
      where ? h("div", { class: "cu-target-where", text: where, title: where }) : null,
      detail ? h("div", { class: "cu-target-at", text: detail, title: line }) : null,
    ].filter((x): x is HTMLDivElement => x != null));
  });
  return box;
}
