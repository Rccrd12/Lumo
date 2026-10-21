// The Tools tab: the user's own tools (src-tauri/src/tools.rs), each with
// its switch (a new one is on), and "Add a tool" at the bottom, which opens
// the tool workshop (views/forge.ts) to make one or bring in a script the
// user already has. A click on a tool shows what it does and what it needs,
// with Change with Lumo (the workshop, on that tool), its folder and Delete
// (a second click confirms it).
//
// The tools that are on go to the agents through Lumo's MCP server
// (lumo-hook --mcp --tools=user) and to the chat's API providers, once Lumo's
// supervisor reviewed them (tool_review.rs): its words are in each tool's
// detail, with Always ask / Trust. Each call asks the user on the island,
// unless they trust that tool and Lumo can hold it to what it declared.
// The terminal button adds the tools to Claude Code in the terminal.

import { h, svg, clear, gentleWheel } from "./dom";
import { ICONS } from "./icons";
import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { compactNotice } from "../core/compact";
import { State } from "../core/state";
import { reviewState, type ReviewState, type ToolInfo } from "../core/tools";
import type { ViewActions, ViewHost } from "./views";
import { N_, t, tl } from "../i18n/i18n";

export const TOOLS_STRINGS = {
  tab: N_("Tools"),
  title: N_("Your tools"),
  count: N_("{on} on of {all}"),
  add: N_("Add a tool"),
  addHint: N_("Make one with Lumo, or bring in a script you already have"),
  emptyTitle: N_("No tools yet"),
  empty: N_("A tool is a small program Lumo and its agents can use for you: a benchmark of your PC, a report from your app, anything you have a script for."),
  folder: N_("Open the tools folder"),
  change: N_("Change with Lumo"),
  reveal: N_("Open its folder"),
  remove: N_("Delete tool"),
  confirm: N_("Delete it?"),
  missing: N_("Its file isn't there any more"),
  external: N_("Runs your script where it is: {path}"),
  noNeeds: N_("Needs nothing special"),
  params: N_("Parameters"),
  noParams: N_("No parameters"),
  asks: N_("Each time an agent uses it, Lumo asks you first."),
  trusted: N_("Agents use it without asking. Lumo still holds it to what it says it needs."),
  askEvery: N_("Ask every time"),
  trust: N_("Trust it"),
  trustNo: N_("Only a reviewed tool that Lumo can hold to what it says it needs can run without asking."),
  supervisor: N_("Lumo's supervisor"),
  reviewing: N_("Reviewing…"),
  needsReview: N_("Needs a review"),
  verdictOk: N_("Looks safe"),
  verdictCaution: N_("Read this first"),
  verdictDanger: N_("Dangerous"),
  review: N_("Review it"),
  reviewAgain: N_("Review again"),
  reviewFailed: N_("The review didn't work: {error}"),
  notReviewed: N_("Agents can't use it until the supervisor has read it as it is now."),
  reviewedBy: N_("Read by {model}"),
  undeclared: N_("Does without saying so: {list}"),
  unguarded: N_("Lumo can't stop this kind of script from doing more than it says ({list}), so it always asks."),
  onAnyway: N_("Turn on anyway?"),
  terminalAdd: N_("Let Claude Code in the terminal use your tools"),
  terminalHas: N_("Claude Code in the terminal can use your tools. Click to take them away."),
  terminalAddConfirm: N_("Add to Claude Code?"),
  terminalRemoveConfirm: N_("Take away?"),
  terminalAdded: N_("Claude Code in the terminal can use your tools"),
  on: N_("On"),
  off: N_("Off"),
  ran: N_("{name} ran"),
  ranFailed: N_("{name} failed"),
};

/** What a tool says it needs, in words, with its icon. */
export const NEED_TEXT: Record<string, { label: string; icon: string }> = {
  network: { label: N_("Internet"), icon: ICONS.globe },
  read: { label: N_("Reads files"), icon: ICONS.doc },
  write: { label: N_("Changes files"), icon: ICONS.pencil },
  system: { label: N_("System"), icon: ICONS.gear },
};

/** Each review state's badge: its words and colour class. */
const REVIEW_BADGE: Record<ReviewState, string> = {
  reviewing: TOOLS_STRINGS.reviewing,
  none: TOOLS_STRINGS.needsReview,
  ok: TOOLS_STRINGS.verdictOk,
  caution: TOOLS_STRINGS.verdictCaution,
  danger: TOOLS_STRINGS.verdictDanger,
};

/** The tools the supervisor is reading now, and why the last try failed, by id. */
const reviewing = new Set<string>();
const reviewErrors = new Map<string, string>();

/** Where a saved tool stands with the supervisor, for a view to know when to redraw. */
export function reviewKey(id: string): string {
  const tool = State.tools.find((x) => x.id === id);
  return tool ? reviewState(tool, reviewing.has(id)) : "";
}

/** A tool's badge: where it stands with the supervisor. */
export function reviewBadge(tool: ToolInfo): HTMLElement {
  const state = reviewState(tool, reviewing.has(tool.id));
  return h("span", { class: `review-badge ${state}` }, h("i"), h("span", { text: t(REVIEW_BADGE[state]) }));
}

/** Each tool's tile gets one of these, always the same for the same tool. */
const TILE_COLORS = ["#6366f1", "#22d3ee", "#f5a524", "#f472b6", "#34d399", "#a78bfa", "#fb7185", "#38bdf8"];

export function tileColor(id: string): string {
  let hash = 0;
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return TILE_COLORS[hash % TILE_COLORS.length];
}

/** A tool's tile: the wrench on its colour. */
export function toolTile(id: string, size = 28): HTMLElement {
  const tile = h("span", { class: "tool-tile" }, svg(ICONS.wrench, Math.round(size * 0.5), { stroke: 1.9 }));
  tile.style.setProperty("--tile", tileColor(id));
  tile.style.width = tile.style.height = `${size}px`;
  return tile;
}

/** Asks Rust for the tools again (at launch and when the tab opens). */
export function refreshTools() {
  void Bridge.toolsList().then((list) => {
    if (!list) return;
    State.tools = list;
    State.notify();
  });
}

export function buildTools(actions: ViewActions): ViewHost {
  const count = h("span", { class: "tools-count" });
  const folderBtn = h("button", { class: "tool-btn", title: tl(TOOLS_STRINGS.folder), "aria-label": tl(TOOLS_STRINGS.folder) },
    svg(ICONS.folder, 13, { stroke: 1.8 }));
  folderBtn.addEventListener("click", () => void Bridge.toolsReveal(null));
  // Claude Code in the terminal: lit while it has the tools; a second click confirms.
  let terminalHas = false;
  let terminalConfirm = false;
  const terminalLabel = h("span", { class: "tools-term-label" });
  const terminalBtn = h("button", { class: "tool-btn tools-term" }, svg(ICONS.terminal, 13, { stroke: 1.9 }), terminalLabel);
  terminalBtn.addEventListener("click", () => void terminal());
  const list = h("div", { class: "tools-list" });
  gentleWheel(list);
  const add = h("button", { class: "tools-add" },
    h("span", { class: "tools-add-plus" }, svg(ICONS.plus, 12, { stroke: 2.2 })),
    h("span", { class: "tools-add-text" },
      h("span", { class: "tools-add-title", text: tl(TOOLS_STRINGS.add) }),
      h("span", { class: "tools-add-hint", text: tl(TOOLS_STRINGS.addHint) })),
    svg(ICONS.chevronRight, 10, { stroke: 2 }));
  add.addEventListener("click", () => openWorkshop(null));

  const body = h("div", { class: "tools-body" },
    h("div", { class: "tools-head" },
      h("div", { class: "tools-title", text: tl(TOOLS_STRINGS.title) }), count, h("span", { class: "tools-head-space" }), terminalBtn, folderBtn),
    list,
    add);
  const cardEl = h("div", { class: "card wash tools-card" }, body);
  cardEl.style.setProperty("--wash", "rgba(245,165,36,0.32)");
  const el = h("div", { class: "view tools-view" }, cardEl);

  /** The tool shown open, the one whose Delete waits for its second click, and the dangerous one waiting to be turned on. */
  let open: string | null = null;
  let confirming: string | null = null;
  let confirmingOn: string | null = null;
  let drawn = "";

  async function terminal() {
    if (!terminalConfirm) {
      terminalConfirm = true;
      drawn = "";
      actions.blip();
      State.notify();
      return;
    }
    terminalConfirm = false;
    try {
      terminalHas = await Bridge.toolsTerminalSet(!terminalHas);
      Sound.play(terminalHas ? "blip" : "pop");
      if (terminalHas) compactNotice(t(TOOLS_STRINGS.terminalAdded), "#f5a524");
    } catch (err) {
      failed(err);
    }
    drawn = "";
    State.notify();
  }

  function startReview(tool: ToolInfo) {
    reviewing.add(tool.id);
    reviewErrors.delete(tool.id);
    drawn = "";
    actions.blip();
    State.notify();
    void Bridge.toolsReview(tool.id);
  }

  async function setTrust(tool: ToolInfo, trust: boolean) {
    State.tools = State.tools.map((x) => (x.id === tool.id ? { ...x, trust } : x));
    Sound.play("blip");
    State.notify();
    try {
      await Bridge.toolsSetTrust(tool.id, trust);
    } catch (err) {
      failed(err);
    }
  }

  function openWorkshop(tool: ToolInfo | null) {
    actions.blip();
    State.forgeAsk = { edit: tool };
    State.useSlot("forge");
    actions.setView("prompt");
  }

  /** Rust said no: the list as it really is, and why. */
  function failed(err: unknown) {
    refreshTools();
    State.noteMessage = String(err).replace(/^Error:\s*/, "");
    State.view = "note";
    Sound.play("error");
    State.notify();
  }

  async function toggle(tool: ToolInfo, on: boolean) {
    // A tool the supervisor found dangerous: turned on only with a second click.
    const danger = tool.reviewed && tool.review?.verdict === "danger";
    if (on && danger && confirmingOn !== tool.id) {
      confirmingOn = tool.id;
      drawn = "";
      Sound.play("error");
      State.notify();
      return;
    }
    confirmingOn = null;
    // Shown at once; put back if Rust says no.
    State.tools = State.tools.map((x) => (x.id === tool.id ? { ...x, enabled: on } : x));
    Sound.play(on ? "blip" : "pop");
    State.notify();
    try {
      await Bridge.toolsSetEnabled(tool.id, on);
    } catch (err) {
      failed(err);
    }
  }

  async function remove(tool: ToolInfo) {
    if (confirming !== tool.id) {
      confirming = tool.id;
      drawn = "";
      State.notify();
      return;
    }
    confirming = null;
    open = null;
    State.tools = State.tools.filter((x) => x.id !== tool.id);
    Sound.play("pop");
    State.notify();
    try {
      await Bridge.toolsDelete(tool.id);
    } catch (err) {
      failed(err);
    }
  }

  function needs(tool: ToolInfo, withWords: boolean): HTMLElement {
    const row = h("span", { class: withWords ? "tool-needs words" : "tool-needs" });
    for (const p of tool.permissions) {
      const need = NEED_TEXT[p];
      if (!need) continue;
      row.append(withWords
        ? h("span", { class: "need-chip" }, svg(need.icon, 10, { stroke: 1.8 }), h("span", { text: t(need.label) }))
        : h("span", { class: "need-dot", title: t(need.label) }, svg(need.icon, 10, { stroke: 1.8 })));
    }
    if (withWords && !row.children.length) row.append(h("span", { class: "need-none", text: t(TOOLS_STRINGS.noNeeds) }));
    return row;
  }

  /** What the supervisor said, in its own words, or that it hasn't yet. */
  function supervisor(tool: ToolInfo): HTMLElement {
    const busy = reviewing.has(tool.id);
    const state = reviewState(tool, busy);
    const review = tool.reviewed ? tool.review : undefined;
    const again = h("button", { class: "tools-act", disabled: busy || undefined },
      svg(ICONS.arrowClockwise, 11, { stroke: 1.8 }), h("span", { text: t(review ? TOOLS_STRINGS.reviewAgain : TOOLS_STRINGS.review) }));
    again.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!reviewing.has(tool.id)) startReview(tool);
    });
    const error = reviewErrors.get(tool.id);
    const undeclared = (review?.undeclared ?? []).map((p) => t(NEED_TEXT[p]?.label ?? p));
    return h("div", { class: `supervisor ${state}` },
      h("div", { class: "supervisor-head" },
        svg(ICONS.seal, 12, { stroke: 1.8 }),
        h("span", { class: "tool-detail-label", text: t(TOOLS_STRINGS.supervisor) }),
        reviewBadge(tool),
        h("span", { class: "tools-head-space" }),
        busy ? null : again),
      review ? h("div", { class: "supervisor-summary", text: review.summary }) : null,
      review?.points.length ? h("ul", { class: "supervisor-points" }, ...review.points.map((p) => h("li", { text: p }))) : null,
      undeclared.length ? h("div", { class: "supervisor-warn", text: t(TOOLS_STRINGS.undeclared, { list: undeclared.join(", ") }) }) : null,
      !review && !busy ? h("div", { class: "tool-detail-note", text: t(TOOLS_STRINGS.notReviewed) }) : null,
      error ? h("div", { class: "supervisor-warn", text: t(TOOLS_STRINGS.reviewFailed, { error }) }) : null,
      review?.model ? h("div", { class: "tool-detail-note", text: t(TOOLS_STRINGS.reviewedBy, { model: review.model }) }) : null);
  }

  /** Ask every time, or trust: only offered when Lumo can hold the tool to what it declared. */
  function trustChoice(tool: ToolInfo): HTMLElement {
    const trusted = !!tool.trust && !!tool.mayTrust;
    const choice = (on: boolean, label: string) => {
      const b = h("button", { class: trusted === on ? "trust-opt on" : "trust-opt", disabled: on && !tool.mayTrust ? true : undefined }, h("span", { text: t(label) }));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (trusted !== on) void setTrust(tool, on);
      });
      return b;
    };
    const unguarded = (tool.unguarded ?? []).map((p) => t(NEED_TEXT[p]?.label ?? p));
    const note = trusted ? TOOLS_STRINGS.trusted : tool.mayTrust ? TOOLS_STRINGS.asks : null;
    return h("div", { class: "trust" },
      h("div", { class: "trust-opts" }, choice(false, TOOLS_STRINGS.askEvery), choice(true, TOOLS_STRINGS.trust)),
      note ? h("div", { class: "tool-detail-note", text: t(note) }) : null,
      !tool.mayTrust && unguarded.length ? h("div", { class: "tool-detail-note", text: t(TOOLS_STRINGS.unguarded, { list: unguarded.join(", ") }) }) : null,
      !tool.mayTrust && !unguarded.length ? h("div", { class: "tool-detail-note", text: t(TOOLS_STRINGS.trustNo) }) : null);
  }

  function detail(tool: ToolInfo): HTMLElement {
    const params = tool.params.length
      ? h("span", { class: "tool-params" }, ...tool.params.map((p) =>
        h("span", { class: p.required ? "param-chip required" : "param-chip", title: p.description },
          h("span", { text: p.name }), h("i", { text: p.type }))))
      : h("span", { class: "need-none", text: t(TOOLS_STRINGS.noParams) });
    const abs = /^[A-Za-z]:[\\/]|^\\\\|^\//.test(tool.entry);
    const deleteBtn = h("button", { class: confirming === tool.id ? "tools-act danger confirm" : "tools-act danger" },
      svg(ICONS.trash, 11, { stroke: 1.7 }), h("span", { text: t(confirming === tool.id ? TOOLS_STRINGS.confirm : TOOLS_STRINGS.remove) }));
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void remove(tool);
    });
    const changeBtn = h("button", { class: "tools-act primary" }, svg(ICONS.pencil, 11, { stroke: 1.8 }), h("span", { text: t(TOOLS_STRINGS.change) }));
    changeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openWorkshop(tool);
    });
    const revealBtn = h("button", { class: "tools-act" }, svg(ICONS.folder, 11, { stroke: 1.8 }), h("span", { text: t(TOOLS_STRINGS.reveal) }));
    revealBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void Bridge.toolsReveal(tool.id);
    });
    return h("div", { class: "tool-detail" },
      supervisor(tool),
      tool.description ? h("div", { class: "tool-detail-text", text: tool.description }) : null,
      h("div", { class: "tool-detail-row" }, h("span", { class: "tool-detail-label", text: t(TOOLS_STRINGS.params) }), params),
      h("div", { class: "tool-detail-row" }, needs(tool, true)),
      abs ? h("div", { class: "tool-detail-note", text: t(TOOLS_STRINGS.external, { path: tool.entry }) }) : null,
      trustChoice(tool),
      h("div", { class: "tools-acts" }, changeBtn, revealBtn, deleteBtn));
  }

  function row(tool: ToolInfo): HTMLElement {
    const sw = h("button", {
      class: tool.enabled ? "switch on" : "switch",
      title: t(confirmingOn === tool.id ? TOOLS_STRINGS.onAnyway : tool.enabled ? TOOLS_STRINGS.on : TOOLS_STRINGS.off),
      "aria-label": tool.name,
      role: "switch",
      "aria-checked": tool.enabled ? "true" : "false",
    });
    sw.addEventListener("click", (e) => {
      e.stopPropagation();
      void toggle(tool, !tool.enabled);
    });
    const sub = tool.missing
      ? h("span", { class: "tool-desc missing", text: t(TOOLS_STRINGS.missing) })
      : confirmingOn === tool.id
        ? h("span", { class: "tool-desc missing", text: t(TOOLS_STRINGS.onAnyway) })
        : h("span", { class: "tool-desc", text: tool.description.split("\n")[0] });
    const isOpen = open === tool.id;
    const head = h("div", { class: "tool-row-head", role: "button", tabindex: "0" },
      toolTile(tool.id),
      h("span", { class: "tool-text" }, h("span", { class: "tool-name", text: tool.name }), sub),
      reviewBadge(tool),
      needs(tool, false),
      sw);
    const toggleOpen = () => {
      open = isOpen ? null : tool.id;
      confirming = null;
      confirmingOn = null;
      drawn = "";
      actions.blip();
      State.notify();
    };
    head.addEventListener("click", toggleOpen);
    head.addEventListener("keydown", (e) => {
      const key = (e as KeyboardEvent).key;
      if (key === "Enter" || key === " ") {
        e.preventDefault();
        toggleOpen();
      }
    });
    return h("div", { class: `tool-row${tool.enabled ? "" : " off"}${isOpen ? " open" : ""}` }, head, isOpen ? detail(tool) : null);
  }

  function draw() {
    const tools = State.tools;
    const key = JSON.stringify([tools, open, confirming, confirmingOn, [...reviewing], [...reviewErrors], terminalHas, terminalConfirm, t(TOOLS_STRINGS.on)]);
    if (key === drawn) return;
    drawn = key;
    terminalBtn.classList.toggle("open", terminalHas);
    terminalBtn.classList.toggle("confirm", terminalConfirm);
    terminalLabel.textContent = terminalConfirm ? t(terminalHas ? TOOLS_STRINGS.terminalRemoveConfirm : TOOLS_STRINGS.terminalAddConfirm) : "";
    const termTitle = t(terminalHas ? TOOLS_STRINGS.terminalHas : TOOLS_STRINGS.terminalAdd);
    terminalBtn.setAttribute("title", termTitle);
    terminalBtn.setAttribute("aria-label", termTitle);
    const kept = list.scrollTop;
    clear(list);
    const on = tools.filter((x) => x.enabled).length;
    count.textContent = tools.length ? t(TOOLS_STRINGS.count, { on, all: tools.length }) : "";
    if (!tools.length) {
      list.append(h("div", { class: "tools-empty" },
        h("div", { class: "tools-empty-art" }, toolTile("lumo", 34)),
        h("div", { class: "tools-empty-title", text: t(TOOLS_STRINGS.emptyTitle) }),
        h("div", { class: "tools-empty-text", text: t(TOOLS_STRINGS.empty) })));
    } else {
      for (const tool of tools) list.append(row(tool));
    }
    list.scrollTop = kept;
  }

  void onEvent<ToolInfo[]>("tools-changed", (tools) => {
    if (!Array.isArray(tools)) return;
    State.tools = tools;
    State.notify();
  });
  // An agent used a tool: the closed island says so for a moment.
  void onEvent<{ name: string; ok: boolean }>("tool-ran", (ran) => {
    if (!ran?.name) return;
    compactNotice(t(ran.ok ? TOOLS_STRINGS.ran : TOOLS_STRINGS.ranFailed, { name: ran.name }), ran.ok ? "#f5a524" : "#f4505e");
  });
  // The supervisor at work (tool_review.rs): its badge, then its words.
  void onEvent<{ id: string; state: string; error?: string }>("tool-review", (r) => {
    if (!r?.id) return;
    if (r.state === "reviewing") reviewing.add(r.id);
    else reviewing.delete(r.id);
    if (r.state === "failed") reviewErrors.set(r.id, String(r.error ?? ""));
    State.notify();
  });
  refreshTools();
  void Bridge.toolsReviewing().then((ids) => {
    for (const id of ids ?? []) reviewing.add(id);
    State.notify();
  });

  // Coming on screen: asked again, for a tool changed by hand in its folder,
  // and whether Claude Code in the terminal has the tools.
  let shown = false;
  State.subscribe(() => {
    const here = State.view === "tools" && State.mode === "expanded";
    if (here && !shown) {
      refreshTools();
      void Bridge.toolsTerminalHas().then((has) => {
        if (typeof has !== "boolean" || has === terminalHas) return;
        terminalHas = has;
        State.notify();
      });
    }
    if (!here) {
      confirming = null;
      confirmingOn = null;
      terminalConfirm = false;
    }
    shown = here;
  });
  return {
    el,
    sync() {
      draw();
    },
  };
}
