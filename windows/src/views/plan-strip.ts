// The new look's plan, in the chat: a thin strip above the field instead of a
// column beside the chat (concepts/redesign, "piano-e-apertura"). Folded it is
// one row: where the plan is, the step under way and a segment for each step,
// the done ones green. A click opens it upwards over the chat with all the
// steps; typing or a click elsewhere folds it again. The usual look keeps the
// Plan island beside the island (island/plan.ts), so this stays hidden there.

import { planFinished, planProgress, type AgentPlan, type PlanStep } from "../core/agent-plan";
import { N_, t, tl } from "../i18n/i18n";
import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";

// The Plan island's own words (plan-view.ts PLAN_TEXT), which this cannot
// import: that view brings its stylesheet, and the chat is tested without one.
const STRIP_TEXT = {
  title: N_("Plan"),
  done: N_("Done"),
  stepOf: N_("{done} of {total}"),
};

const SVG_NS = "http://www.w3.org/2000/svg";

/** A step's marker, as the Plan island draws it (plan-view.ts): a ring, a lit ring, a check or a dash. */
function planMarker(step: PlanStep): HTMLElement {
  const el = h("span", { class: `plan-mark ${step.status}` });
  if (step.status === "done") el.append(svg(ICONS.check, 10, { stroke: 2.6 }));
  else if (step.status === "skipped") el.append(h("i"));
  else if (step.status === "active") {
    const ring = document.createElementNS(SVG_NS, "svg");
    ring.setAttribute("viewBox", "0 0 14 14");
    ring.classList.add("plan-lit");
    for (const [r, cls] of [[6.25, "plan-lit-ring"], [3, "plan-lit-dot"]] as const) {
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", "7");
      c.setAttribute("cy", "7");
      c.setAttribute("r", String(r));
      c.classList.add(cls);
      ring.append(c);
    }
    el.append(ring);
  }
  return el;
}

/** More steps than this and the segments become one bar that fills. */
const MAX_SEGMENTS = 14;

export interface PlanStrip {
  readonly el: HTMLElement;
  /** The plan to show, or null for none (the strip goes away). */
  sync(plan: AgentPlan | null): void;
  /** Folds the list of steps, if it is open. */
  fold(): void;
}

/** The step to name on the folded row: the one under way, else the next one, else the last. */
export function stripStep(steps: readonly PlanStep[]): PlanStep | null {
  return steps.find((s) => s.status === "active") ?? steps.find((s) => s.status === "pending") ?? steps[steps.length - 1] ?? null;
}

export function buildPlanStrip(): PlanStrip {
  const mark = h("span", { class: "agent-plan plan-strip-mark" });
  const title = h("span", { class: "plan-strip-title" });
  const step = h("span", { class: "plan-strip-step" });
  const segs = h("span", { class: "plan-strip-segs", "aria-hidden": "true" });
  const chevron = h("span", { class: "plan-strip-chevron" }, svg(ICONS.chevronUp, 10, { stroke: 2 }));
  const row = h("button", { class: "plan-strip-row", type: "button" }, mark, title, step, segs, chevron);
  const head = h("div", { class: "plan-strip-head" });
  const list = h("div", { class: "agent-plan plan-strip-steps" });
  const panel = h("div", { class: "plan-strip-list", role: "list" }, head, list);
  const el = h("div", { class: "plan-strip" }, panel, row);
  el.hidden = true;

  let open = false;
  let shownKey = "";

  function setOpen(on: boolean) {
    if (open === on) return;
    open = on;
    el.classList.toggle("open", on);
    row.setAttribute("aria-expanded", String(on));
    if (on) {
      // As tall as the chat above it allows, never over the top bar.
      const body = el.closest(".chat-body");
      const top = body ? body.getBoundingClientRect().top : 0;
      const room = row.getBoundingClientRect().top - top - 6;
      panel.style.maxHeight = `${Math.max(80, Math.min(210, room))}px`;
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", typing, true);
    } else {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", typing, true);
    }
  }

  // A click anywhere else, or typing in the chat, folds it.
  function outside(e: Event) {
    if (!el.contains(e.target as Node)) setOpen(false);
  }
  function typing(e: KeyboardEvent) {
    if (e.key === "Escape" || (e.target as HTMLElement | null)?.closest?.(".chat-input")) setOpen(false);
  }

  row.addEventListener("click", () => setOpen(!open));
  row.setAttribute("aria-expanded", "false");

  function draw(plan: AgentPlan) {
    const steps = plan.steps;
    const { done, total } = planProgress(steps);
    const finished = planFinished(steps);
    const now = stripStep(steps);
    el.style.setProperty("--agent", plan.color || "");
    el.classList.toggle("finished", finished);

    clear(mark);
    if (now) mark.append(planMarker(finished ? { text: "", status: "done" } : now));
    const status = finished ? t(STRIP_TEXT.done) : t(STRIP_TEXT.stepOf, { done, total });
    title.textContent = `${tl(STRIP_TEXT.title)} · ${status}`;
    step.textContent = finished ? "" : now?.text ?? "";
    step.title = now?.text ?? "";
    row.title = plan.note || "";

    clear(segs);
    if (total <= MAX_SEGMENTS) {
      for (const s of steps) segs.append(h("i", { class: s.status }));
    } else {
      const bar = h("i", { class: "fill" });
      bar.style.setProperty("--k", String(total ? done / total : 0));
      segs.append(bar);
      segs.classList.add("bar");
    }
    segs.classList.toggle("bar", total > MAX_SEGMENTS);

    clear(head);
    head.append(
      h("span", { class: "plan-strip-head-title", text: `${tl(STRIP_TEXT.title)} · ${plan.agent}${plan.project ? ` · ${plan.project}` : ""}` }),
      h("span", { class: "plan-strip-head-count", text: status }),
    );
    clear(list);
    for (const s of steps) {
      list.append(h("div", { class: `plan-step plan-strip-item ${s.status}`, role: "listitem" },
        planMarker(s), h("span", { class: "plan-text", text: s.text })));
    }
  }

  return {
    el,
    sync(plan) {
      if (!plan || plan.steps.length === 0) {
        el.hidden = true;
        setOpen(false);
        shownKey = "";
        return;
      }
      el.hidden = false;
      const key = JSON.stringify([plan.key, plan.createdAt, plan.color, plan.note, plan.steps]);
      if (key === shownKey) return;
      shownKey = key;
      draw(plan);
    },
    fold() {
      setOpen(false);
    },
  };
}
