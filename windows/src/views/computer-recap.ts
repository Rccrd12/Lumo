// What a chat answer that used the computer leaves under it (ChatMessage.computer,
// from computer.rs through ChatReply.computer, saved with the chat): one line,
// "Used the computer · 5 steps · 41 s", that opens on the plan's steps as they
// ended, each with a small picture of the screen taken when it was done. A
// turn stopped before the end says where, in amber, and what was done last.

import "./computer-recap.css";
import type { ComputerRecap } from "../core/computer-use";
import { N_, t, tn } from "../i18n/i18n";
import { ICONS } from "./icons";
import { dot, h, svg } from "./dom";

const RECAP_TEXT = {
  used: N_("Used the computer"),
  seconds: N_("{seconds} s"),
  minutes: N_("{minutes} min {seconds} s"),
  stoppedAt: N_("Stopped at step {step} of {total}"),
  stoppedAfter: N_("Stopped at step {step} of {total} · last done: {text}"),
};

/** How long it took, short: "41 s", "2 min 05 s". */
export function recapDuration(ms: number): string {
  const all = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  if (all < 60) return t(RECAP_TEXT.seconds, { seconds: all });
  return t(RECAP_TEXT.minutes, { minutes: Math.floor(all / 60), seconds: String(all % 60).padStart(2, "0") });
}

/**
 * Where a stopped turn ended: the step it was at (the first not done; the
 * last when all were), how many, and the last step done before it, if any.
 */
export function stoppedPlace(recap: Pick<ComputerRecap, "steps">): { step: number; total: number; last: string | null } {
  const total = recap.steps.length;
  const at = recap.steps.findIndex((s) => s.status !== "done");
  const step = at < 0 ? total : at + 1;
  let last: string | null = null;
  for (let i = (at < 0 ? total : at) - 1; i >= 0; i--) {
    if (recap.steps[i].status === "done") {
      last = recap.steps[i].text;
      break;
    }
  }
  return { step, total, last };
}

/** The one-line words of a stopped turn. */
export function stoppedLine(recap: Pick<ComputerRecap, "steps">): string {
  const { step, total, last } = stoppedPlace(recap);
  const text = last?.replace(/\s+/g, " ").trim();
  return text ? t(RECAP_TEXT.stoppedAfter, { step, total, text }) : t(RECAP_TEXT.stoppedAt, { step, total });
}

/** The recaps opened by a click, by message: drawn again (a new answer, a scroll), they stay open. */
const opened = new Set<number>();

/** A base64 PNG for an <img>, nothing else. */
const PICTURE = /^[A-Za-z0-9+/]+=*$/;

/**
 * The recap's box under an answer: closed on its one line, a click opens the
 * steps. `id` is the message's, to keep it open when the chat is drawn again.
 */
export function computerRecapBox(recap: ComputerRecap, id?: number): HTMLElement {
  const steps = recap.steps ?? [];
  const open = id != null && opened.has(id);
  const meta = [tn("{count} step", "{count} steps", steps.length), recapDuration(recap.ms)].join(" · ");
  const chevron = svg(ICONS.chevronRight, 11, { stroke: 2 });
  chevron.classList.add("cu-recap-chevron");
  const head = h("button", { class: "cu-recap-head", type: "button", "aria-expanded": open ? "true" : "false" },
    h("span", { class: "cu-recap-title", text: t(RECAP_TEXT.used) }),
    h("span", { class: "cu-recap-meta", text: ` · ${meta}` }),
    recap.agent ? h("span", { class: "cu-recap-agent", title: recap.agent }, dot(recap.color || "#9398a1", 7), h("span", { text: recap.agent })) : null,
    chevron,
  );
  const list = h("div", { class: "cu-recap-steps" });
  for (const step of steps) {
    const picture = step.image && PICTURE.test(step.image)
      ? h("img", { class: "cu-recap-shot", alt: "", draggable: "false", src: `data:image/png;base64,${step.image}` })
      : h("span", { class: "cu-recap-shot none", "aria-hidden": "true" });
    const done = step.status === "done";
    list.append(h("div", { class: `cu-recap-step ${step.status}` },
      picture,
      h("span", { class: "cu-recap-text", text: step.text, title: step.text }),
      done ? h("span", { class: "cu-recap-mark", "aria-hidden": "true" }, svg(ICONS.check, 12, { stroke: 2.2 })) : null,
    ));
  }
  list.hidden = !open;
  const stopped = recap.stopped ? h("div", { class: "cu-recap-stopped", text: stoppedLine(recap) }) : null;
  const box = h("div", { class: `cu-recap${open ? " open" : ""}${recap.stopped ? " stopped" : ""}` }, head, stopped, list);
  head.addEventListener("click", (e) => {
    e.stopPropagation();
    const now = !box.classList.contains("open");
    box.classList.toggle("open", now);
    list.hidden = !now;
    head.setAttribute("aria-expanded", now ? "true" : "false");
    if (id != null) {
      if (now) opened.add(id);
      else opened.delete(id);
    }
  });
  return box;
}
