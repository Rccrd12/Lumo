// The Tools tab: the user's own tools (src-tauri/src/tools.rs), each with
// its switch (a new one is on), and "Add a tool" at the bottom, which opens
// the tool workshop (views/forge.ts) to make one or bring in a script the
// user already has. A click on a tool shows what it does and what it needs,
// with Change with Lumo (the workshop, on that tool), its folder and Delete
// (a second click confirms it).
//
// The tools that are on go to the agents through Lumo's MCP server
// (lumo-hook --mcp --tools=user); each call asks the user on the island.

import { h, svg, clear, gentleWheel } from "./dom";
import { ICONS } from "./icons";
import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { compactNotice } from "../core/compact";
import { State } from "../core/state";
import { type ToolInfo } from "../core/tools";
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
      h("div", { class: "tools-title", text: tl(TOOLS_STRINGS.title) }), count, h("span", { class: "tools-head-space" }), folderBtn),
    list,
    add);
  const cardEl = h("div", { class: "card wash tools-card" }, body);
  cardEl.style.setProperty("--wash", "rgba(245,165,36,0.32)");
  const el = h("div", { class: "view tools-view" }, cardEl);

  /** The tool shown open, and the one whose Delete waits for its second click. */
  let open: string | null = null;
  let confirming: string | null = null;
  let drawn = "";

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

  function detail(tool: ToolInfo): HTMLElement {
    const params = tool.params.length
      ? h("span", { class: "tool-params" }, ...tool.params.map((p) =>
        h("span", { class: p.required ? "param-chip required" : "param-chip", title: p.description },
          h("span", { text: p.name }), h("i", { text: p.type }))))
      : h("span", { class: "need-none", text: t(TOOLS_STRINGS.noParams) });
    const abs = /^[A-Za-z]:[\\/]|^\\\\|^\//.test(tool.entry);
    const deleteBtn = h("button", { class: confirming === tool.id ? "tool-action danger confirm" : "tool-action danger" },
      svg(ICONS.trash, 11, { stroke: 1.7 }), h("span", { text: t(confirming === tool.id ? TOOLS_STRINGS.confirm : TOOLS_STRINGS.remove) }));
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void remove(tool);
    });
    const changeBtn = h("button", { class: "tool-action primary" }, svg(ICONS.pencil, 11, { stroke: 1.8 }), h("span", { text: t(TOOLS_STRINGS.change) }));
    changeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openWorkshop(tool);
    });
    const revealBtn = h("button", { class: "tool-action" }, svg(ICONS.folder, 11, { stroke: 1.8 }), h("span", { text: t(TOOLS_STRINGS.reveal) }));
    revealBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void Bridge.toolsReveal(tool.id);
    });
    return h("div", { class: "tool-detail" },
      tool.description ? h("div", { class: "tool-detail-text", text: tool.description }) : null,
      h("div", { class: "tool-detail-row" }, h("span", { class: "tool-detail-label", text: t(TOOLS_STRINGS.params) }), params),
      h("div", { class: "tool-detail-row" }, needs(tool, true)),
      abs ? h("div", { class: "tool-detail-note", text: t(TOOLS_STRINGS.external, { path: tool.entry }) }) : null,
      h("div", { class: "tool-detail-note", text: t(TOOLS_STRINGS.asks) }),
      h("div", { class: "tool-actions" }, changeBtn, revealBtn, deleteBtn));
  }

  function row(tool: ToolInfo): HTMLElement {
    const sw = h("button", {
      class: tool.enabled ? "switch on" : "switch",
      title: t(tool.enabled ? TOOLS_STRINGS.on : TOOLS_STRINGS.off),
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
      : h("span", { class: "tool-desc", text: tool.description.split("\n")[0] });
    const isOpen = open === tool.id;
    const head = h("div", { class: "tool-row-head", role: "button", tabindex: "0" },
      toolTile(tool.id),
      h("span", { class: "tool-text" }, h("span", { class: "tool-name", text: tool.name }), sub),
      needs(tool, false),
      sw);
    const toggleOpen = () => {
      open = isOpen ? null : tool.id;
      confirming = null;
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
    const key = JSON.stringify([tools, open, confirming, t(TOOLS_STRINGS.on)]);
    if (key === drawn) return;
    drawn = key;
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
  refreshTools();

  // Coming on screen: asked again, for a tool changed by hand in its folder.
  let shown = false;
  State.subscribe(() => {
    const here = State.view === "tools" && State.mode === "expanded";
    if (here && !shown) refreshTools();
    if (!here && confirming) confirming = null;
    shown = here;
  });
  return {
    el,
    sync() {
      draw();
    },
  };
}
