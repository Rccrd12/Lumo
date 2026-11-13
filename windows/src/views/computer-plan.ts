// The plan of an agent using the computer (computer.rs, `computer-state`):
// on the open island a moment as computer use starts and each time a step is
// done, and for as long as the user paused it with Esc, with Stop, "Ask" and
// Resume; and, while the agent works, the closed island's line (ComputerPill):
// the step under way, the plan's segments, how far it is and Esc.
//
// It shows only the plan Rust sent: no steps, nothing but its head.

import "./computer-plan.css";
import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import type { ComputerReveal, ComputerState, ComputerStep } from "../core/computer-use";
import {
  clockText, computerFooter, computerPillKey, computerPillParts, countdownShare, planMarks, secondsLeft, stepPlace,
  type StepMark,
} from "../core/computer-plan";
import { computerViewHeight } from "../core/layout";
import { N_, t, tl } from "../i18n/i18n";
import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";
import type { ViewHost } from "./views";

export const COMPUTER_PLAN_TEXT = {
  using: N_("{agent} is using the computer"),
  stepOf: N_("{done} of {total}"),
  escPauses: N_("pauses at any time"),
  startsIn: N_("Starts in {seconds} s"),
  keepsWorking: N_("{agent} keeps working"),
  closesIn: N_("Closes in {seconds} s"),
  paused: N_("Paused"),
  mouseYours: N_("the mouse is yours, {agent} is waiting"),
  stop: N_("Stop"),
  ask: N_("Ask {agent}"),
  resume: N_("Resume"),
  cancel: N_("Cancel"),
  send: N_("Send"),
  write: N_("Tell {agent} what to do differently…"),
  reading: N_("{agent} is reading your message…"),
  new: N_("new step"),
  changed: N_("step changed"),
  pillTitle: N_("{agent} is using the computer · Esc pauses"),
};

/** More steps than this and the closed island's segments become one bar that fills (as the chat's plan chip). */
const MAX_SEGMENTS = 10;
/** The closed island's room left of what it says (Lumo's eyes, #computer-pill left) and right of it. */
const PILL_LEFT = 41;
const PILL_RIGHT = 14;

// ── What the island tells the view ─────────────────────────────────────────

/** The moment the plan is open for (island.ts owns its timer): which, until when, how long (performance.now() ms). */
let reveal: { kind: ComputerReveal; until: number; span: number } | null = null;
/** The island opened the view afresh: what changed is counted from the plan shown last time. */
let freshShowing = true;

/** The plan opens for `ms` (computer use starting, a step done): the footer counts it down. */
export function setComputerReveal(kind: ComputerReveal, ms: number) {
  reveal = { kind, until: performance.now() + ms, span: ms };
}

/** The moment is over, or the plan is paused: no countdown. */
export function clearComputerReveal() {
  reveal = null;
}

/** The island opens the plan (it was not on screen): a new showing. */
export function computerShowing() {
  freshShowing = true;
}

// ── The open island ────────────────────────────────────────────────────────

/** `key`'s words with the agent's name in bold where its language puts {agent}. */
function withAgent(key: string, agent: string): (Node | string)[] {
  const mark = "\u0000";
  const [lead, ...rest] = t(key, { agent: mark }).split(mark);
  return rest.length ? [lead, h("b", { text: agent }), rest.join(agent)] : [lead];
}

/** A step's marker: a check done, a warm dot under way, a ring to do. */
function marker(step: ComputerStep): HTMLElement {
  const el = h("span", { class: `cu-mark ${step.status}` });
  if (step.status === "done") el.append(svg(ICONS.check, 12, { stroke: 2.6 }));
  else el.append(h("i"));
  return el;
}

export interface ComputerViewActions {
  /** The island takes the keyboard (a click in the field, Ask): island.ts takeKeyboard. */
  takeKeyboard(): void;
}

export function buildComputerView(actions: ComputerViewActions): ViewHost {
  const dotEl = h("i", { class: "dot", style: "width:8px;height:8px" });
  const who = h("span", { class: "cu-who" });
  const place = h("span", { class: "cu-place" });
  const head = h("div", { class: "cu-head" }, dotEl, who, place);
  const list = h("div", { class: "cu-steps", role: "list" });
  const plan = h("div", { class: "cu-plan" }, head, list);

  const bannerRest = h("span", { class: "cu-banner-rest" });
  const banner = h("div", { class: "cu-banner" }, svg(ICONS.pause, 12), h("b", { text: tl(COMPUTER_PLAN_TEXT.paused) }), bannerRest);
  const note = h("div", { class: "cu-note" });

  // Writing to the agent: only a click on Ask or in the field gives the island the keyboard.
  const input = h("input", { class: "cu-input", type: "text", maxlength: "2000", spellcheck: "true" });
  input.value = "";
  const sendBtn = h("button", { class: "cu-send", type: "button", title: tl(COMPUTER_PLAN_TEXT.send), "aria-label": tl(COMPUTER_PLAN_TEXT.send) },
    svg(ICONS.arrowUp, 14));
  const field = h("div", { class: "cu-field" }, input, sendBtn);

  // The footers: the start's, a step's (both a countdown), the paused one's buttons.
  const countText = h("span", { class: "cu-count" });
  const barFill = h("i");
  const bar = h("span", { class: "cu-bar" }, barFill);
  const footLead = h("span", { class: "cu-lead" });
  const escKey = h("span", { class: "cu-kbd", text: "Esc" });
  const countdown = h("div", { class: "cu-foot" }, escKey, footLead, h("span", { class: "cu-gap" }), countText, bar);

  const stopBtn = h("button", { class: "btn cu-stop", type: "button" }, svg(ICONS.stop, 12), h("span", { text: tl(COMPUTER_PLAN_TEXT.stop) }));
  const askLabel = h("span");
  const askBtn = h("button", { class: "btn secondary cu-ask", type: "button" }, askLabel);
  const resumeBtn = h("button", { class: "btn cu-resume", type: "button" },
    svg(ICONS.play, 11), h("span", { text: tl(COMPUTER_PLAN_TEXT.resume) }), h("span", { class: "kbd", text: "Esc" }));
  const cancelBtn = h("button", { class: "btn secondary cu-cancel", type: "button" }, h("span", { text: tl(COMPUTER_PLAN_TEXT.cancel) }));
  const buttons = h("div", { class: "cu-foot buttons" }, stopBtn, h("span", { class: "cu-gap" }), askBtn, cancelBtn, resumeBtn);

  const body = h("div", { class: "cu-body" }, banner, note, plan, field, countdown, buttons);
  const el = h("div", { class: "view computer-view" }, h("div", { class: "card" }, body));

  /** The field to write to the agent is open. */
  let asking = false;
  /** A question went to the agent in this pause: its answer (the plan's explanation) is shown. */
  let askedInPause = false;
  /** The plan as it was shown last, and the one this showing counts changes from. */
  let lastShown: ComputerStep[] | null = null;
  let before: ComputerStep[] | null = null;
  /** The turn the plans above belong to (ComputerState.since). */
  let turn: number | null = null;
  let stepsKey = "";
  let timer: number | null = null;

  const current = () => State.computer;
  const onScreen = () => State.mode === "expanded" && State.view === "computer";

  function closeField(giveBack: boolean) {
    if (!asking) return;
    asking = false;
    input.value = "";
    if (giveBack) void Bridge.focusWindow(false);
    State.notify();
  }

  function send() {
    const text = input.value.trim();
    if (!text || !current()?.paused) return;
    void Bridge.computerAsk(text);
    askedInPause = true;
    closeField(true);
  }

  stopBtn.addEventListener("click", () => {
    closeField(false);
    void Bridge.focusWindow(false);
    void Bridge.computerStop();
  });
  resumeBtn.addEventListener("click", () => {
    closeField(false);
    void Bridge.focusWindow(false);
    void Bridge.computerResume();
  });
  askBtn.addEventListener("click", () => {
    if (!current()?.paused) return;
    asking = true;
    actions.takeKeyboard();
    State.notify();
    window.setTimeout(() => input.focus(), 120);
  });
  cancelBtn.addEventListener("click", () => closeField(true));
  sendBtn.addEventListener("click", send);
  input.addEventListener("mousedown", () => actions.takeKeyboard());
  input.addEventListener("input", () => {
    sendBtn.disabled = !input.value.trim();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  /** The clock and the countdown, each second (each quarter while counting down), only while on screen. */
  function tickLater() {
    if (timer != null) return;
    timer = window.setTimeout(() => {
      timer = null;
      if (!onScreen() || !current()) return;
      paintTime();
      tickLater();
    }, reveal ? 250 : 1000);
  }

  function paintTime() {
    const c = current();
    if (!c) return;
    const { step, total } = stepPlace(c.steps);
    const clock = clockText(Date.now() - c.since);
    const text = total ? `${t(COMPUTER_PLAN_TEXT.stepOf, { done: step, total })} · ${clock}` : clock;
    if (place.textContent !== text) place.textContent = text;
    if (reveal) {
      const now = performance.now();
      const words = t(reveal.kind === "start" ? COMPUTER_PLAN_TEXT.startsIn : COMPUTER_PLAN_TEXT.closesIn, { seconds: secondsLeft(reveal.until, now) });
      if (countText.textContent !== words) countText.textContent = words;
      barFill.style.width = `${countdownShare(reveal.until, reveal.span, now) * 100}%`;
    }
  }

  function drawSteps(c: ComputerState, marks: StepMark[]) {
    const key = JSON.stringify([c.steps, marks]);
    if (key === stepsKey) return;
    stepsKey = key;
    clear(list);
    c.steps.forEach((s, i) => {
      const mark = marks[i];
      list.append(h("div", { class: `cu-step ${s.status}`, role: "listitem" },
        marker(s),
        h("span", { class: "cu-text", text: s.text, title: s.text }),
        mark ? h("span", { class: `cu-badge ${mark}`, text: t(mark === "new" ? COMPUTER_PLAN_TEXT.new : COMPUTER_PLAN_TEXT.changed) }) : null));
    });
    // The step under way in sight, in a plan longer than the box.
    const active = list.querySelector<HTMLElement>(".cu-step.active");
    if (active && list.scrollHeight > list.clientHeight) active.scrollIntoView?.({ block: "nearest" });
  }

  /** What the view holds now, for its height. */
  function parts(c: ComputerState | null) {
    const footer = computerFooter(c, reveal?.kind ?? null);
    const reading = !!c?.paused && !!c.asked;
    const answer = !!c?.paused && askedInPause && !c.asked && !!c.explanation?.trim();
    return { footer, note: reading || answer, reading, answer };
  }

  return {
    el,
    fitHeight() {
      const c = current();
      if (!c) return null;
      const p = parts(c);
      const paused = p.footer === "paused";
      return computerViewHeight(c.steps.length, {
        banner: paused, note: p.note, field: paused && asking, buttons: paused, footer: p.footer != null,
      });
    },
    sync() {
      const c = current();
      if (!c) return;
      // A new turn starts its plans afresh.
      if (turn !== c.since) {
        turn = c.since;
        lastShown = null;
        freshShowing = true;
      }
      if (freshShowing) {
        freshShowing = false;
        before = lastShown;
        // A field left open when the plan last closed (stopped from elsewhere) starts closed.
        asking = false;
        input.value = "";
      }
      lastShown = c.steps.map((s) => ({ ...s }));
      if (!c.paused) {
        askedInPause = false;
        if (asking) closeField(true);
      }
      const p = parts(c);
      el.classList.toggle("cu-paused", c.paused);
      el.style.setProperty("--agent", c.color);

      dotEl.style.background = c.color;
      clear(who);
      who.append(...withAgent(COMPUTER_PLAN_TEXT.using, c.agent));
      who.title = t(COMPUTER_PLAN_TEXT.using, { agent: c.agent });

      list.hidden = c.steps.length === 0;
      drawSteps(c, planMarks(before, c.steps));

      banner.hidden = !c.paused;
      bannerRest.textContent = `· ${t(COMPUTER_PLAN_TEXT.mouseYours, { agent: c.agent })}`;

      note.hidden = !p.note;
      note.classList.toggle("reading", p.reading);
      clear(note);
      if (p.reading) note.textContent = t(COMPUTER_PLAN_TEXT.reading, { agent: c.agent });
      else if (p.answer) note.append(h("b", { text: `${c.agent}:` }), ` ${c.explanation!.trim()}`);
      note.title = note.textContent ?? "";

      field.hidden = !(c.paused && asking);
      input.placeholder = t(COMPUTER_PLAN_TEXT.write, { agent: c.agent });
      sendBtn.disabled = !input.value.trim();

      const counting = p.footer === "start" || p.footer === "step";
      countdown.hidden = !counting;
      escKey.hidden = p.footer !== "start";
      footLead.textContent = p.footer === "start" ? t(COMPUTER_PLAN_TEXT.escPauses)
        : p.footer === "step" ? t(COMPUTER_PLAN_TEXT.keepsWorking, { agent: c.agent }) : "";

      buttons.hidden = p.footer !== "paused";
      askLabel.textContent = t(COMPUTER_PLAN_TEXT.ask, { agent: c.agent });
      stopBtn.hidden = asking;
      askBtn.hidden = asking;
      resumeBtn.hidden = asking;
      cancelBtn.hidden = !asking;

      paintTime();
      tickLater();
    },
  };
}

// ── The closed island ──────────────────────────────────────────────────────

/**
 * What the closed island says while the agent works with a plan, after
 * Lumo's eyes: the provider's dot, the step under way, the plan's segments
 * (done in green, under way in blue, as the chat's plan chip), k/n and Esc.
 * island.ts sizes the island from `width` (layout.ts computerCompact).
 */
export class ComputerPill {
  readonly el = h("div", { id: "computer-pill", "aria-hidden": "true" });
  private key = "";
  private measured = 0;
  private visible = false;

  /** The closed island's width for what it says; 0 when it says nothing. */
  get width(): number {
    return this.visible ? this.measured : 0;
  }

  /** Shows `state`'s plan, or nothing (null); true when the island's width has to change. */
  sync(state: ComputerState | null): boolean {
    const before = this.width;
    const p = computerPillParts(state);
    this.visible = p != null;
    this.el.classList.toggle("shown", this.visible);
    const key = computerPillKey(p);
    if (key !== this.key) {
      this.key = key;
      clear(this.el);
      this.measured = 0;
      if (p) {
        const segs = h("span", { class: "cu-segs" });
        if (p.segments.length <= MAX_SEGMENTS) {
          for (const s of p.segments) segs.append(h("i", { class: s }));
        } else {
          segs.classList.add("bar");
          const fill = h("i");
          fill.style.setProperty("--k", String(p.segments.filter((s) => s === "done").length / p.segments.length));
          segs.append(fill);
        }
        this.el.append(
          h("i", { class: "cu-dot", style: `background:${p.color}` }),
          h("span", { class: "cu-pill-text", text: p.text }),
          segs,
          h("span", { class: "cu-pill-place", text: p.place }),
          h("span", { class: "cu-kbd", text: "Esc" }),
        );
        this.el.title = t(COMPUTER_PLAN_TEXT.pillTitle, { agent: p.agent });
        this.measured = this.measure();
      }
    }
    return Math.abs(this.width - before) >= 1;
  }

  /** As wide as what it says (its step cut at its own most), Lumo's room on its left. */
  private measure(): number {
    this.el.classList.add("measure");
    const natural = this.el.scrollWidth;
    this.el.classList.remove("measure");
    return Math.ceil(PILL_LEFT + natural + PILL_RIGHT);
  }
}
