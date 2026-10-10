// Small pieces every settings section draws with: a setting (its name and
// what it does on the left, its control on the right), a section's head, a
// group heading, the status dot and the diff.

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
 * One setting: its name, and under it in smaller grey what it does, on the
 * left; its switch, list or buttons on the right. Settings in a section are
 * divided by a thin line, so it is always clear which explanation belongs to
 * which setting.
 */
export function setting(label: string | Node, hint: string | Node | null, ...controls: Child[]): HTMLElement {
  return h("div", { class: "setting" },
    h("div", { class: "setting-text" },
      typeof label === "string" ? h("span", { class: "setting-label", text: label }) : h("span", { class: "setting-label" }, label),
      hint == null ? null : typeof hint === "string" ? h("span", { class: "setting-hint", text: hint }) : h("span", { class: "setting-hint" }, hint),
    ),
    h("div", { class: "setting-control" }, ...controls.filter((c): c is Node | string => !!c)),
  );
}

/** A setting whose control needs the width (a key, an address): name and hint above, the field below. */
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
