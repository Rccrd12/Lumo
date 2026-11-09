// GitHub's alerts in the answers: `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`,
// `> [!WARNING]` and `> [!CAUTION]`, each with its colour and icon, the
// standard title or the one written after the kind (`> [!IMPORTANT] First rule`).
// Models write them without being told, Claude Code and Codex included.

import { h, svg } from "../dom";
import { ICONS } from "../icons";
import { N_, t } from "../../i18n/i18n";
import type { CalloutType } from "./index";

export const CALLOUT_STRINGS = {
  note: N_("Note"),
  tip: N_("Tip"),
  important: N_("Important"),
  warning: N_("Warning"),
  caution: N_("Caution"),
};

/** info.circle.fill: a dot and a bar cut out of a disc. */
const INFO = "M12 2.5a9.5 9.5 0 1 0 0 19 9.5 9.5 0 0 0 0-19zM11 7h2v2.2h-2zm0 4h2v6h-2z";

function icon(type: CalloutType): SVGSVGElement {
  switch (type) {
    case "note":
      return svg(INFO, 12, { evenOdd: true });
    case "tip":
      return svg(ICONS.lightbulb, 12, { stroke: 1.9 });
    case "important":
      return svg(ICONS.star, 12);
    case "warning":
      return svg(ICONS.bang, 12);
    case "caution":
      return svg(ICONS.octagonX, 12, { evenOdd: true });
  }
}

/** The alert around `body`, already rendered as Markdown by markdown.ts. */
export function renderCallout(type: CalloutType, title: string, body: HTMLElement): HTMLElement {
  body.classList.add("rc-callout-body");
  return h(
    "div",
    { class: `rc-callout rc-${type}` },
    h("div", { class: "rc-callout-head" }, icon(type), h("span", { text: title || t(CALLOUT_STRINGS[type]) })),
    body.childNodes.length ? body : null,
  );
}
