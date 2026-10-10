// Small pieces every settings section draws with: a setting (its row and
// the hint under it), a section's head, a group heading, the status dot and
// the diff.

import { h } from "../views/dom";

export function statusDot(ok: boolean): HTMLElement {
  return h("i", { class: "dot", style: `background:${ok ? "#22c55e" : "#f4505e"}` });
}

export function renderDiff(text: string): HTMLElement {
  const box = h("div", { class: "diff" });
  for (const line of text.split("\n")) {
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "ctx";
    box.append(h("div", { class: cls, text: line }));
  }
  return box;
}

type Child = Node | string | null | undefined | false;

/**
 * One setting, drawn like every other row of these pages: its name and its
 * switch, list or buttons on one line, and what it does under it.
 */
export function setting(label: string | Node, hint: string | Node | null, ...controls: Child[]): HTMLElement {
  return h("div", { class: "setting" },
    h("div", { class: "row" },
      typeof label === "string" ? h("label", { text: label }) : h("label", {}, label),
      ...controls.filter((c): c is Node | string => !!c),
    ),
    hint == null ? null : typeof hint === "string" ? h("div", { class: "hint", text: hint }) : h("div", { class: "hint" }, hint),
  );
}

/** A setting whose field takes the rest of its row (a key, an address). */
export function wideSetting(label: string | Node, hint: string | Node | null, ...controls: Child[]): HTMLElement {
  const el = setting(label, hint, ...controls);
  el.classList.add("wide");
  return el;
}

/** A section's title (with a dot or an icon before it) and the sentence that says what it is for. */
export function sectionHead(title: string | Node, intro?: string | null, before?: Node | null): HTMLElement[] {
  const head: HTMLElement[] = [h("h2", {}, before ?? null, typeof title === "string" ? h("span", { text: title }) : title)];
  if (intro) head.push(h("p", { class: "section-intro", text: intro }));
  return head;
}

/** A small heading that groups the settings of a long section. */
export function group(title: string): HTMLElement {
  return h("h3", { class: "setting-group", text: title });
}

/** An accent dot before a provider's or a service's name. */
export function accentDot(color: string): HTMLElement {
  return h("i", { class: "dot", style: `background:${color}` });
}
