// Claude Code's /context answer drawn as a small card (core/context-usage.ts
// reads it): how full the context is, a bar of what fills it with a short
// legend, and the MCP servers, skills, memory files and the tools loaded only
// when needed folded under Details.
// Copy still copies the answer as Claude Code wrote it.

import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { renderMarkdown } from "./markdown";
import {
  BUFFER, CONTEXT_CATEGORIES, CONTEXT_STRINGS, formatTokens, isDeferred, parseContextReport, serverName, usedPercent,
  type ContextCategory, type ContextReport,
} from "../core/context-usage";
import { t, tn } from "../i18n/i18n";

/** An answer: the card for a /context report, Markdown for anything else. */
export function renderAnswer(into: HTMLElement, text: string) {
  const report = parseContextReport(text);
  if (report) into.append(contextCard(report));
  else renderMarkdown(into, text);
}

const OTHER = "#6b7079";

/** Rows shown per group of the details; the rest as one "+N more" row. */
const SHOWN = 6;

function category(name: string) {
  return CONTEXT_CATEGORIES[name] ?? { label: "", color: OTHER };
}

export function contextCard(report: ContextReport): HTMLElement {
  const used = report.categories.filter((c) => !isDeferred(c.name) && c.name !== BUFFER);
  const buffer = report.categories.find((c) => c.name === BUFFER);
  const width = (tokens: number) => `${Math.max(0, Math.min(100, (tokens / report.total) * 100)).toFixed(2)}%`;
  // What is taken from the left, the room kept for compacting at the right end.
  const bar = h("div", { class: "ctx-bar" });
  for (const c of used) bar.append(h("i", { style: `width:${width(c.tokens)};background:${category(c.name).color}` }));
  bar.append(h("b"));
  if (buffer) bar.append(h("i", { class: "ctx-buffer", style: `width:${width(buffer.tokens)}` }));
  const legend = h("div", { class: "ctx-legend" });
  for (const c of [...used].sort((a, b) => b.tokens - a.tokens)) legend.append(key(c.name, c.tokens));
  if (buffer) legend.append(key(buffer.name, buffer.tokens));
  const card = h(
    "div",
    { class: "ctx-card" },
    h(
      "div",
      { class: "ctx-head" },
      h("span", { class: "ctx-title", text: t(CONTEXT_STRINGS.title) }),
      report.model ? h("span", { class: "ctx-model", text: report.model }) : null,
    ),
    h(
      "div",
      { class: "ctx-numbers" },
      h("span", { class: "ctx-used", text: t(CONTEXT_STRINGS.used, { used: formatTokens(report.used), total: formatTokens(report.total) }) }),
      h("span", { class: "ctx-percent", text: `${usedPercent(report)}%` }),
    ),
    bar,
    h("div", { class: "ctx-free", text: t(CONTEXT_STRINGS.free, { free: formatTokens(report.free) }) }),
    legend,
  );
  const deferred = report.categories.filter((c) => isDeferred(c.name));
  if (report.groups.length || deferred.length) card.append(details(report, deferred));
  return card;
}

function key(name: string, tokens: number): HTMLElement {
  const { label, color } = category(name);
  return h(
    "span",
    { class: "ctx-key" },
    name === BUFFER ? h("i", { class: "ctx-buffer" }) : h("i", { style: `background:${color}` }),
    h("span", { class: "ctx-key-name", text: label ? t(label) : name }),
    h("span", { class: "ctx-key-tokens", text: formatTokens(tokens) }),
  );
}

/** MCP servers, skills and memory files, folded until asked for. */
function details(report: ContextReport, deferred: readonly ContextCategory[]): HTMLElement {
  const body = h("div", { class: "ctx-details" });
  const heading = (title: string, tokens: number | null) =>
    h("div", { class: "ctx-group" }, h("span", { text: title }), tokens == null ? null : h("span", { class: "ctx-key-tokens", text: formatTokens(tokens) }));
  const row = (name: string, tokens: number, title = name, count?: string) =>
    h(
      "div",
      { class: "ctx-item" },
      h("span", { class: "ctx-item-name", text: name, title }),
      count ? h("span", { class: "ctx-item-count", text: count }) : null,
      h("span", { class: "ctx-key-tokens", text: formatTokens(tokens) }),
    );
  for (const group of report.groups) {
    const title = group.kind === "mcp" ? CONTEXT_STRINGS.mcp : group.kind === "skills" ? CONTEXT_STRINGS.skills : CONTEXT_STRINGS.memory;
    // The MCP table lists the deferred tools too: a total would not match the bar.
    body.append(heading(t(title), group.kind === "mcp" ? null : group.items.reduce((n, g) => n + g.tokens, 0)));
    for (const item of group.items.slice(0, SHOWN)) {
      if (group.kind === "mcp") body.append(row(serverName(item.name), item.tokens, item.name, tn("{count} tool", "{count} tools", item.count)));
      else body.append(row(item.name, item.tokens));
    }
    const rest = group.items.slice(SHOWN);
    if (rest.length) {
      body.append(
        row(
          t(CONTEXT_STRINGS.more, { count: rest.length }),
          rest.reduce((n, g) => n + g.tokens, 0),
          rest.map((g) => g.name).join(", "),
        ),
      );
      body.lastElementChild?.classList.add("ctx-rest");
    }
  }
  // Named to the model, read in only when a turn needs them: not in the bar.
  if (deferred.length) {
    body.append(heading(t(CONTEXT_STRINGS.deferred), deferred.reduce((n, c) => n + c.tokens, 0)));
    for (const c of deferred) body.append(row(t(category(c.name).label || c.name), c.tokens));
  }
  const toggle = h(
    "button",
    { class: "ctx-toggle", "aria-expanded": "false" },
    h("span", { text: t(CONTEXT_STRINGS.details) }),
    svg(ICONS.chevronRight, 9, { stroke: 2 }),
  );
  const wrap = h("div", { class: "ctx-more" }, toggle, body);
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = !wrap.classList.contains("open");
    wrap.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
  });
  return wrap;
}
