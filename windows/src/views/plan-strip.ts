// The new look's plan, in the chat (concepts/redesign, "piano-da-chiuso" 1).
// Folded it takes no room of its own: the plan's icon beside the model turns
// into a chip with a segment for each step, the done ones green, and how many
// are done. A click on it opens the steps upwards over the chat; typing or a
// click elsewhere folds them again, and their "–" puts the plan away into its
// icon. The usual look keeps the Plan island beside the island
// (island/plan.ts), so none of this shows there.

import { planFinished, planProgress, type AgentPlan, type PlanStep } from "../core/agent-plan";
import { N_, t, tl } from "../i18n/i18n";
import { clear, h, svg } from "./dom";
import { ICONS } from "./icons";

/** More steps than this and the segments become one bar that fills. */
const MAX_SEGMENTS = 10;

// The Plan island's own words (plan-view.ts PLAN_TEXT), which this cannot
// import: that view brings its stylesheet, and the chat is tested without one.
const STRIP_TEXT = {
  title: N_("Plan"),
  done: N_("Done"),
  stepOf: N_("{done} of {total}"),
  fold: N_("Minimize"),
  waiting: N_("waiting for you"),
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


export interface PlanStrip {
  /** The steps, opened over the chat (it goes in the model row, which it rises from). */
  readonly el: HTMLElement;
  /** The chip beside the model that opens them. */
  readonly chip: HTMLElement;
  /** The plan to show, or null for none (the chip goes away). */
  sync(plan: AgentPlan | null): void;
  /** Folds the list of steps, if it is open. */
  fold(): void;
  /**
   * A plan asking to start (concept C1): the chip in Lumo's amber, pulsing,
   * with a segment for each step and "waiting for you", until the plan is
   * answered (null). Its own steps are over the field, not in the list.
   */
  ask(steps: readonly PlanStep[] | null): void;
}

/** The step to name: the one under way, else the next one, else the last. */
export function stripStep(steps: readonly PlanStep[]): PlanStep | null {
  return steps.find((s) => s.status === "active") ?? steps.find((s) => s.status === "pending") ?? steps[steps.length - 1] ?? null;
}

/** `putAway` folds the plan into its icon (the Plan island's "–"). */
export function buildPlanStrip(putAway: () => void): PlanStrip {
  const segs = h("span", { class: "plan-chip-segs", "aria-hidden": "true" });
  const count = h("span", { class: "plan-chip-count" });
  const chip = h("button", { class: "tool-btn plan-chip", type: "button" }, segs, count);
  chip.hidden = true;
  const headTitle = h("span", { class: "plan-strip-head-title" });
  const headCount = h("span", { class: "plan-strip-head-count" });
  const foldBtn = h("button", {
    class: "plan-strip-fold", type: "button", title: tl(STRIP_TEXT.fold), "aria-label": tl(STRIP_TEXT.fold),
    onclick: () => {
      setOpen(false);
      putAway();
    },
  }, svg(ICONS.minus, 11, { stroke: 2 }));
  const head = h("div", { class: "plan-strip-head" }, headTitle, headCount, foldBtn);
  const list = h("div", { class: "agent-plan plan-strip-steps" });
  const el = h("div", { class: "plan-strip-list", role: "list" }, head, list);

  let open = false;
  let shownKey = "";
  let asking: readonly PlanStep[] | null = null;

  function setOpen(on: boolean) {
    if (open === on) return;
    open = on;
    el.classList.toggle("open", on);
    chip.classList.toggle("open", on);
    chip.setAttribute("aria-expanded", String(on));
    if (on) {
      // As tall as the chat above it allows, never over the top bar.
      const body = el.closest(".chat-body");
      const top = body ? body.getBoundingClientRect().top : 0;
      const room = chip.getBoundingClientRect().top - top - 10;
      el.style.maxHeight = `${Math.max(80, Math.min(220, room))}px`;
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("keydown", typing, true);
    } else {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", typing, true);
    }
  }

  // A click anywhere else, or typing in the chat, folds it.
  function outside(e: Event) {
    const at = e.target as Node;
    if (!el.contains(at) && !chip.contains(at)) setOpen(false);
  }
  function typing(e: KeyboardEvent) {
    if (e.key === "Escape" || (e.target as HTMLElement | null)?.closest?.(".chat-input")) setOpen(false);
  }

  // While a plan asks to start, its steps are already open over the field.
  chip.addEventListener("click", () => {
    if (!asking) setOpen(!open);
  });
  chip.setAttribute("aria-expanded", "false");

  function draw(plan: AgentPlan) {
    const steps = plan.steps;
    const { done, total } = planProgress(steps);
    const finished = planFinished(steps);
    const now = stripStep(steps);
    for (const node of [chip, el]) node.style.setProperty("--agent", plan.color || "");
    chip.classList.toggle("finished", finished);

    const status = finished ? t(STRIP_TEXT.done) : t(STRIP_TEXT.stepOf, { done, total });
    count.textContent = `${done}/${total}`;
    chip.title = `${tl(STRIP_TEXT.title)} · ${status}${!finished && now ? ` · ${now.text}` : ""}`;
    chip.setAttribute("aria-label", chip.title);

    clear(segs);
    segs.classList.toggle("bar", total > MAX_SEGMENTS);
    if (total <= MAX_SEGMENTS) {
      for (const s of steps) segs.append(h("i", { class: s.status }));
    } else {
      const bar = h("i", { class: "fill" });
      bar.style.setProperty("--k", String(total ? done / total : 0));
      segs.append(bar);
    }

    headTitle.textContent = `${tl(STRIP_TEXT.title)} · ${plan.agent}${plan.project ? ` · ${plan.project}` : ""}`;
    headCount.textContent = status;
    clear(list);
    for (const s of steps) {
      list.append(h("div", { class: `plan-step plan-strip-item ${s.status}`, role: "listitem" },
        planMarker(s), h("span", { class: "plan-text", text: s.text })));
    }
  }

  return {
    el,
    chip,
    sync(plan) {
      if (asking) {
        const key = JSON.stringify(["ask", asking]);
        chip.hidden = false;
        setOpen(false);
        if (key === shownKey) return;
        shownKey = key;
        chip.classList.add("asking");
        chip.classList.remove("finished");
        chip.style.removeProperty("--agent");
        count.textContent = t(STRIP_TEXT.waiting);
        chip.title = `${tl(STRIP_TEXT.title)} · ${t(STRIP_TEXT.waiting)}`;
        chip.setAttribute("aria-label", chip.title);
        clear(segs);
        segs.classList.toggle("bar", asking.length > MAX_SEGMENTS);
        if (asking.length <= MAX_SEGMENTS) for (const _ of asking) segs.append(h("i", { class: "pending" }));
        else segs.append(h("i", { class: "fill" }));
        return;
      }
      chip.classList.remove("asking");
      if (!plan || plan.steps.length === 0) {
        chip.hidden = true;
        setOpen(false);
        shownKey = "";
        return;
      }
      chip.hidden = false;
      const key = JSON.stringify([plan.key, plan.createdAt, plan.color, plan.steps]);
      if (key === shownKey) return;
      shownKey = key;
      draw(plan);
    },
    fold() {
      setOpen(false);
    },
    ask(steps) {
      const next = steps && steps.length ? steps : null;
      if (next === asking) return;
      asking = next;
      shownKey = "";
    },
  };
}
