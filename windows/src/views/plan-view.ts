// The Plan island, drawn: the plan an agent follows, step by step
// (core/agent-plan.ts reads it, island/plan.ts holds it). It lives in a window
// of its own (plan.html, plan_island.rs), right of the island at first, then
// wherever it is moved. Its "–" folds it into an icon in the chat, left of
// the usage ring; its arrows go back through the plans done.
//
// Every animation runs once (a step done, a plan coming in): nothing loops,
// so it costs nothing while it sits still.

import "./plan.css";
import { planFinished, planId, planProgress, type AgentPlan, type PlanStep } from "../core/agent-plan";
import { Sound } from "../core/sound";
import { clear, dot, h, shrinkOffset, svg, type PagePoint } from "./dom";
import { ICONS } from "./icons";
import { N_, t, tl } from "../i18n/i18n";

export const PLAN_TEXT = {
  title: N_("Plan"),
  fold: N_("Minimize"),
  done: N_("Done"),
  stepOf: N_("{done} of {total}"),
  older: N_("Previous"),
  newer: N_("Next"),
};

/** How far a press on the top bar travels before it picks the panel up. */
const DRAG_THRESHOLD = 4;
/** The progress ring: its size and its radius, in page pixels. */
const RING = 34;
const RING_R = 14;

/** What the window draws: the plan looked at, which of how many (0 the newest), and whether it is under way. */
export interface PlanData {
  lang: string;
  plan: AgentPlan | null;
  index?: number;
  count?: number;
  live?: boolean;
}

export type PlanAction =
  | { kind: "fold" }
  | { kind: "older" }
  | { kind: "newer" }
  | { kind: "settings" }
  | { kind: "refresh" };

export interface PlanViewHooks {
  act(a: PlanAction): void;
  /** The top bar was pressed and the mouse moved: pick it up. */
  drag(): void;
  /** A grip was pressed: `fx` / `fy` how width and height follow the mouse. */
  resize(fx: number, fy: number): void;
  /** Where the island is, in this page's pixels: it folds toward it and comes out of it. */
  toward(): Promise<PagePoint | null>;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The step marker: an empty ring, a lit one, a check, or a dash. */
function marker(step: PlanStep): HTMLElement {
  const el = h("span", { class: `plan-mark ${step.status}` });
  if (step.status === "done") el.append(svg(ICONS.check, 10, { stroke: 2.6 }));
  else if (step.status === "skipped") el.append(h("i"));
  else if (step.status === "active") el.append(h("b"));
  return el;
}

/** The ring that fills as the steps are done. */
function progressRing() {
  const el = document.createElementNS(SVG_NS, "svg");
  el.setAttribute("viewBox", `0 0 ${RING} ${RING}`);
  el.setAttribute("width", String(RING));
  el.setAttribute("height", String(RING));
  el.classList.add("plan-ring");
  const circle = (cls: string) => {
    const c = document.createElementNS(SVG_NS, "circle");
    c.setAttribute("cx", String(RING / 2));
    c.setAttribute("cy", String(RING / 2));
    c.setAttribute("r", String(RING_R));
    c.setAttribute("class", cls);
    el.append(c);
    return c;
  };
  circle("plan-ring-track");
  const arc = circle("plan-ring-arc");
  const length = 2 * Math.PI * RING_R;
  arc.style.strokeDasharray = `${length}`;
  arc.style.strokeDashoffset = `${length}`;
  return {
    el,
    set(part: number, color: string) {
      arc.style.strokeDashoffset = `${length * (1 - Math.min(1, Math.max(0, part)))}`;
      arc.style.stroke = color;
    },
  };
}

export class PlanView {
  readonly el: HTMLElement;
  private ring = progressRing();
  private ringText = h("span", { class: "plan-ring-text" });
  private agent = h("div", { class: "plan-agent" });
  private status = h("div", { class: "plan-status" });
  private list = h("ol", { class: "plan-steps" });
  private note = h("div", { class: "plan-note" });
  private nav = h("div", { class: "plan-nav" });
  private olderBtn: HTMLButtonElement;
  private newerBtn: HTMLButtonElement;
  private place = h("span", { class: "plan-place" });
  private body: HTMLElement;
  private key = "";
  /** The plan drawn (`planId`) and where its steps stood, to see what moved on. */
  private drawn = "";
  private index = 0;
  private stood = new Map<string, PlanStep["status"]>();
  private folding = false;
  private hooks: PlanViewHooks;

  constructor(hooks: PlanViewHooks) {
    this.hooks = hooks;
    const fold = h("button", {
      class: "act-fold", title: tl(PLAN_TEXT.fold), "aria-label": tl(PLAN_TEXT.fold),
      onclick: () => this.fold(),
    }, h("i"));
    this.olderBtn = h("button", {
      class: "plan-arrow", title: tl(PLAN_TEXT.older), "aria-label": tl(PLAN_TEXT.older),
      onclick: () => this.hooks.act({ kind: "older" }),
    }, svg(ICONS.chevronLeft, 11, { stroke: 2.2 })) as HTMLButtonElement;
    this.newerBtn = h("button", {
      class: "plan-arrow", title: tl(PLAN_TEXT.newer), "aria-label": tl(PLAN_TEXT.newer),
      onclick: () => this.hooks.act({ kind: "newer" }),
    }, svg(ICONS.chevronRight, 11, { stroke: 2.2 })) as HTMLButtonElement;
    this.nav.append(this.olderBtn, this.place, this.newerBtn);
    const head = h("div", { class: "plan-head" },
      h("span", { class: "plan-title" }, svg(ICONS.plan, 12, { stroke: 1.8 }), h("span", { text: tl(PLAN_TEXT.title) })),
      this.nav, fold);
    const summary = h("div", { class: "plan-summary" },
      h("div", { class: "plan-ring-box" }, this.ring.el, this.ringText),
      h("div", { class: "plan-meta" }, this.agent, this.status));
    this.body = h("div", { class: "plan-body" }, summary, this.list, this.note);
    this.el = h("div", { class: "agent-plan" }, head, this.body);
    this.wireDrag(head);
    for (const [cls, fx, fy] of [["e-left", -1, 0], ["e-right", 1, 0], ["e-bottom", 0, 1], ["c-bl", -1, 1], ["c-br", 1, 1]] as const) {
      const grip = h("div", { class: `plan-grip ${cls}` });
      grip.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this.hooks.resize(fx, fy);
      });
      this.el.append(grip);
    }
  }

  /** The top bar, pressed and moved past a few pixels, picks the panel up. */
  private wireDrag(head: HTMLElement) {
    head.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || (e.target as Element).closest("button")) return;
      const start = { x: e.screenX, y: e.screenY };
      const move = (m: MouseEvent) => {
        if (Math.hypot(m.screenX - start.x, m.screenY - start.y) <= DRAG_THRESHOLD) return;
        stop();
        this.hooks.drag();
      };
      const stop = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", stop);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", stop);
    });
  }

  /** An animation class put on again, so it plays once more. */
  private static replay(el: Element, cls: string) {
    el.classList.remove(cls);
    void (el as HTMLElement).offsetWidth;
    el.classList.add(cls);
  }

  /** Draws what changed; nothing when nothing did. */
  render(data: PlanData) {
    const plan = data.plan;
    const index = data.index ?? 0;
    const count = data.count ?? (plan ? 1 : 0);
    const key = JSON.stringify([data.lang, plan, index, count, data.live]);
    if (key === this.key) return;
    this.key = key;

    // The arrows, only with more than one plan.
    this.nav.classList.toggle("on", count > 1);
    this.olderBtn.disabled = index >= count - 1;
    this.newerBtn.disabled = index <= 0;
    this.place.textContent = `${count - index}/${count}`;

    clear(this.agent);
    clear(this.list);
    if (!plan) {
      this.drawn = "";
      this.stood.clear();
      this.ring.set(0, "transparent");
      this.ringText.textContent = "";
      this.status.textContent = "";
      this.note.textContent = "";
      return;
    }
    const id = planId(plan);
    const another = id !== this.drawn;
    if (another && this.drawn) {
      // Another plan: it slides in from the side it comes from.
      PlanView.replay(this.body, index > this.index ? "from-left" : index < this.index ? "from-right" : "fresh");
    }
    this.drawn = id;
    this.index = index;

    this.agent.append(dot(plan.color, 7), h("span", { class: "n", text: plan.agent }));
    if (plan.project) this.agent.append(h("span", { class: "p", text: plan.project }));
    const { done, total } = planProgress(plan.steps);
    const finished = planFinished(plan.steps);
    const wasFinished = this.el.classList.contains("finished");
    this.el.classList.toggle("finished", finished);
    this.el.classList.toggle("past", data.live === false);
    this.el.style.setProperty("--agent", plan.color);
    this.status.textContent = finished ? t(PLAN_TEXT.done) : t(PLAN_TEXT.stepOf, { done, total });
    this.ring.set(total ? done / total : 0, finished ? "var(--green)" : plan.color);
    clear(this.ringText);
    if (finished) this.ringText.append(svg(ICONS.check, 13, { stroke: 2.6 }));
    else this.ringText.textContent = String(done);
    if (finished && !wasFinished && !another) PlanView.replay(this.ringText.parentElement!, "celebrate");

    let active: HTMLElement | null = null;
    const stood = new Map<string, PlanStep["status"]>();
    for (const [i, step] of plan.steps.entries()) {
      const row = h("li", { class: `plan-step ${step.status}` }, marker(step), h("span", { class: "plan-text", text: step.text, title: step.text }));
      const before = this.stood.get(step.text);
      if (another) {
        // A plan coming in: its steps one after the other.
        row.classList.add("enter");
        row.style.animationDelay = `${Math.min(i, 12) * 28}ms`;
      } else if (before !== step.status) {
        row.classList.add(before === undefined ? "enter" : `now-${step.status}`);
      }
      if (step.status === "active") active ??= row;
      stood.set(step.text, step.status);
      this.list.append(row);
    }
    this.stood = stood;
    this.note.textContent = plan.note ?? "";
    // The step under way stays in sight.
    if (active) {
      const row = active;
      requestAnimationFrame(() => row.scrollIntoView({ block: "nearest", behavior: another ? "auto" : "smooth" }));
    } else if (another) {
      this.list.scrollTop = 0;
    }
  }

  /** "–" (or its icon in the chat): it shrinks toward the island, then says so (the window hides). */
  async fold() {
    if (this.folding) return;
    this.folding = true;
    Sound.play("close");
    const { dx, dy } = shrinkOffset(this.el.getBoundingClientRect(), await this.hooks.toward().catch(() => null));
    this.el.classList.add("folding");
    requestAnimationFrame(() => {
      this.el.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(0.06)`;
      this.el.style.opacity = "0";
    });
    window.setTimeout(() => {
      this.el.classList.add("gone");
      this.hooks.act({ kind: "fold" });
      this.el.classList.add("instant");
      this.el.classList.remove("folding");
      this.el.style.transform = "";
      this.el.style.opacity = "";
      void this.el.offsetWidth;
      this.el.classList.remove("instant");
      this.folding = false;
    }, 440);
  }

  /** Comes out of the island's side to its place; at once with `instant`. */
  async appear(instant: boolean) {
    if (instant) {
      this.el.classList.remove("gone");
      return;
    }
    const target = await this.hooks.toward().catch(() => null);
    this.el.classList.remove("gone");
    const { dx, dy } = shrinkOffset(this.el.getBoundingClientRect(), target);
    this.el.classList.add("instant");
    this.el.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(0.06)`;
    this.el.style.opacity = "0";
    void this.el.offsetWidth;
    this.el.classList.remove("instant");
    requestAnimationFrame(() => {
      this.el.style.transform = "";
      this.el.style.opacity = "";
    });
  }
}
