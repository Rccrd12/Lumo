// The Plan island, drawn: the plan an agent follows, step by step
// (core/agent-plan.ts reads it, island/plan.ts holds it). It lives in a window
// of its own (plan.html, plan_island.rs), right of the island at first, then
// wherever it is moved. Its "–" folds it into an icon in the island's top
// bar, left of the plan usage pills.

import "./plan.css";
import { planFinished, planProgress, type AgentPlan, type PlanStep } from "../core/agent-plan";
import { Sound } from "../core/sound";
import { clear, dot, h, svg } from "./dom";
import { ICONS } from "./icons";
import { N_, t, tl } from "../i18n/i18n";

export const PLAN_TEXT = {
  title: N_("Plan"),
  fold: N_("Minimize"),
  done: N_("Done"),
  stepOf: N_("{done} of {total}"),
};

/** How far a press on the top bar travels before it picks the panel up. */
const DRAG_THRESHOLD = 4;

/** What the window draws. */
export interface PlanData {
  lang: string;
  plan: AgentPlan | null;
}

export type PlanAction = { kind: "fold" } | { kind: "settings" } | { kind: "refresh" };

export interface PlanViewHooks {
  act(a: PlanAction): void;
  /** The top bar was pressed and the mouse moved: pick it up. */
  drag(): void;
  /** A grip was pressed: `fx` / `fy` how width and height follow the mouse. */
  resize(fx: number, fy: number): void;
}

/** The step marker: an empty ring, a lit one, a check, or a dash. */
function marker(step: PlanStep): HTMLElement {
  const el = h("span", { class: `plan-mark ${step.status}` });
  if (step.status === "done") el.append(svg(ICONS.check, 10, { stroke: 2.6 }));
  else if (step.status === "skipped") el.append(h("i"));
  return el;
}

export class PlanView {
  readonly el: HTMLElement;
  private who = h("div", { class: "plan-who" });
  private count = h("span", { class: "plan-count" });
  private bar = h("i");
  private list = h("ol", { class: "plan-steps" });
  private note = h("div", { class: "plan-note" });
  private body: HTMLElement;
  private key = "";
  private folding = false;
  private hooks: PlanViewHooks;

  constructor(hooks: PlanViewHooks) {
    this.hooks = hooks;
    const fold = h("button", {
      class: "act-fold", title: tl(PLAN_TEXT.fold), "aria-label": tl(PLAN_TEXT.fold),
      onclick: () => this.fold(),
    }, h("i"));
    const head = h("div", { class: "plan-head" },
      h("span", { class: "plan-title" }, svg(ICONS.plan, 12, { stroke: 1.8 }), h("span", { text: tl(PLAN_TEXT.title) })),
      this.count, fold);
    this.body = h("div", { class: "plan-body" }, this.who, h("div", { class: "plan-bar" }, this.bar), this.list, this.note);
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

  /** Draws what changed; nothing when nothing did. */
  render(data: PlanData) {
    const plan = data.plan;
    const key = JSON.stringify([data.lang, plan?.key, plan?.agent, plan?.project, plan?.steps, plan?.note]);
    if (key === this.key) return;
    this.key = key;
    clear(this.who);
    clear(this.list);
    if (!plan) {
      this.count.textContent = "";
      this.bar.style.width = "0";
      this.note.textContent = "";
      return;
    }
    this.who.append(dot(plan.color, 7), h("span", { class: "n", text: plan.agent }));
    if (plan.project) this.who.append(h("span", { class: "p", text: plan.project }));
    const { done, total } = planProgress(plan.steps);
    const finished = planFinished(plan.steps);
    this.el.classList.toggle("finished", finished);
    this.count.textContent = finished ? t(PLAN_TEXT.done) : t(PLAN_TEXT.stepOf, { done, total });
    this.bar.style.width = `${total ? (done / total) * 100 : 0}%`;
    this.bar.style.background = plan.color;
    let active: HTMLElement | null = null;
    for (const step of plan.steps) {
      const row = h("li", { class: `plan-step ${step.status}` }, marker(step), h("span", { class: "plan-text", text: step.text, title: step.text }));
      if (step.status === "active") {
        row.style.setProperty("--agent", plan.color);
        active ??= row;
      }
      this.list.append(row);
    }
    this.note.textContent = plan.note ?? "";
    // The step under way stays in sight.
    if (active) {
      const row = active;
      requestAnimationFrame(() => row.scrollIntoView({ block: "nearest" }));
    }
  }

  /** "–": it shrinks into its top corner, then says so (the window hides). */
  private fold() {
    if (this.folding) return;
    this.folding = true;
    Sound.play("close");
    const r = this.el.getBoundingClientRect();
    this.el.classList.add("folding");
    requestAnimationFrame(() => {
      this.el.style.transform = `translate3d(${r.width / 2 - 20}px, ${-r.height / 2 + 20}px, 0) scale(0.06)`;
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

  /** Comes out of its corner to its place; at once with `instant`. */
  appear(instant: boolean) {
    this.el.classList.remove("gone");
    if (instant) return;
    const r = this.el.getBoundingClientRect();
    this.el.classList.add("instant");
    this.el.style.transform = `translate3d(${r.width / 2 - 20}px, ${-r.height / 2 + 20}px, 0) scale(0.06)`;
    this.el.style.opacity = "0";
    void this.el.offsetWidth;
    this.el.classList.remove("instant");
    requestAnimationFrame(() => {
      this.el.style.transform = "";
      this.el.style.opacity = "";
    });
  }
}
