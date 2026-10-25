// Steps card: every step of the session the ticker scrolls through, whole.
// Opens in the overview's left card when a step of the ticker is clicked. A
// step whose event said more than its line (the whole command, the full path,
// the error, the whole answer) opens in place; a diff step opens its diff.

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { parseDiffStep } from "../core/diff";
import { stepDetailAt, type AgentTask, type StepDetail } from "../core/state";
import { openedRow } from "../core/step-detail";
import { N_, tl } from "../i18n/i18n";

const STRINGS = {
  back: N_("Back"),
};

export interface StepsCardHooks {
  dismiss(): void;
  openDiff(diffId: number): void;
}

export class StepsCard {
  readonly el: HTMLElement;
  private readonly name = h("b");
  private readonly list = h("div", { class: "steps-list" });
  /** The steps opened, by their place in the session. */
  private open = new Set<number>();
  private key = "";
  /** The task drawn last, for a step opened or closed by a click. */
  private task: AgentTask | null = null;
  /** Brought into view on the next draw. */
  private reveal: number | null = null;

  constructor(private readonly hooks: StepsCardHooks) {
    const head = h(
      "div",
      { class: "diff-head" },
      h(
        "button",
        { class: "diff-back", title: tl(STRINGS.back), onclick: () => hooks.dismiss() },
        svg(ICONS.chevronLeft, 9, { stroke: 2.4 }),
        this.name,
      ),
    );
    this.el = h("div", { class: "steps-card" }, head, this.list);
  }

  /** Shown afresh, with `seq` opened (when it has more to show) and in view. */
  show(task: AgentTask, seq: number) {
    this.open.clear();
    const index = indexOf(task, seq);
    if (index >= 0 && openedRow(task.steps[index], stepDetailAt(task, index)).detail) this.open.add(seq);
    this.reveal = seq;
    this.key = "";
    this.list.scrollTop = 0;
    this.sync(task);
  }

  /** `stay`: the list keeps its scroll whatever happens (a step opened or closed). */
  sync(task: AgentTask, stay = false) {
    this.task = task;
    const newest = task.steps.length === 0 ? -1 : (task.stepSeq ?? task.steps.length - 1);
    const key = [task.name, newest, task.steps.length, !!task.finalLine, [...this.open].join(",")].join("~");
    if (key === this.key) return;
    this.key = key;
    this.name.textContent = task.name;

    // A new step keeps the list at its end only if it was already there.
    const atEnd = this.list.scrollTop + this.list.clientHeight >= this.list.scrollHeight - 4;
    const top = this.list.scrollTop;
    this.list.replaceChildren();
    const first = newest - (task.steps.length - 1);
    let revealed: HTMLElement | null = null;
    task.steps.forEach((text, i) => {
      const seq = first + i;
      const current = i === task.steps.length - 1 && !task.finalLine;
      const row = this.row(text, seq, stepDetailAt(task, i), current);
      if (seq === this.reveal) revealed = row;
      this.list.append(row);
    });

    if (this.reveal != null) {
      this.reveal = null;
      (revealed as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
    } else if (atEnd && !stay) {
      this.list.scrollTop = this.list.scrollHeight;
    } else {
      this.list.scrollTop = top;
    }
  }

  private row(step: string, seq: number, kept: StepDetail | null, current: boolean): HTMLElement {
    const diff = parseDiffStep(step);
    const { text, detail } = diff ? { text: diff.filename, detail: null } : openedRow(step, kept);
    const more = detail != null;
    const opened = more && this.open.has(seq);
    // A chevron where there is more to open (it turns down once open) and on
    // the step under way; the ✓ on the others, as in the ticker.
    const icon = more || current ? svg(ICONS.chevronRight, 9, { stroke: 2.4 }) : svg(ICONS.check, 8, { stroke: 2.2 });
    const line = h(
      "div",
      { class: "step-line" },
      h("span", { class: "step-icon" }, icon),
      h("span", { class: "step-text", text }),
      diff && diff.added > 0 ? h("span", { class: "tick-count plus", text: ` +${diff.added}` }) : null,
      diff && diff.removed > 0 ? h("span", { class: "tick-count minus", text: ` −${diff.removed}` }) : null,
    );
    const classes = ["step"];
    if (current) classes.push("current");
    if (more) classes.push("more");
    if (opened) classes.push("open");
    if (diff) classes.push("diff");
    const row = h("div", { class: classes.join(" ") }, line);
    if (diff) {
      line.addEventListener("click", () => this.hooks.openDiff(diff.diffId));
    } else if (more) {
      line.addEventListener("click", () => {
        if (this.open.has(seq)) this.open.delete(seq);
        else this.open.add(seq);
        this.key = "";
        if (this.task) this.sync(this.task, true);
      });
    }
    if (opened && detail) {
      row.append(
        h(
          "div",
          { class: "step-detail" },
          detail.text ? h("div", { class: "step-detail-text", text: detail.text }) : null,
          detail.code ? h("div", { class: "step-detail-code", text: detail.code }) : null,
        ),
      );
    }
    return row;
  }
}

/** Where step `seq` of the session sits in `task.steps`, or -1 once dropped. */
function indexOf(task: AgentTask, seq: number): number {
  const newest = task.stepSeq ?? task.steps.length - 1;
  const index = task.steps.length - 1 - (newest - seq);
  return index >= 0 && index < task.steps.length ? index : -1;
}
