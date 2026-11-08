// A plan Claude Code asks to start (ExitPlanMode), as the new look draws it:
// its steps numbered, one per line (concepts/redesign C1 in the chat, C2 on
// the permission card). No stylesheet of its own: look-new.css styles it.

import { h } from "./dom";

/** A plan's steps, numbered. */
export function planAskSteps(steps: readonly { text: string }[]): HTMLElement {
  return h("div", { class: "plan-ask-steps", role: "list" },
    ...steps.map((s, i) => h("div", { class: "plan-ask-step", role: "listitem" },
      h("span", { class: "plan-ask-n", text: String(i + 1) }), h("span", { class: "plan-ask-text", text: s.text, title: s.text }))));
}
