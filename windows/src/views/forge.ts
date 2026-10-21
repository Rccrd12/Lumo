// The tool workshop: the chat in its workshop mode (views/chat.ts), opened
// by the Tools tab's Add a tool or Change with Lumo. Everything of the chat
// is there (the attachments, the usage, the Plan island, the model picker,
// the paperclip, the screen button, the permissions), with a look of its own
// and, beside the conversation once the AI wrote one, the tool as it stands:
// what it does, its parameters, what it needs, its files, Try and Save.
// How it works covers the workshop at first; its dash puts it away into a
// "?" at the top right, which brings it back.
//
// The AI hands the tool over in its answers (core/tools.ts parseDraft). Try
// runs the draft once on the user's click, with the values typed above it,
// and Tell Lumo puts how it went in the field; Save makes it a tool, on, in
// the Tools tab. Nothing is saved or run otherwise. A chat that saved a tool
// remembers it, so its next Save updates that tool instead of adding one.
// Once saved, the supervisor reads it (tool_review.rs): its badge and words
// show here too.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import {
  draftKey, isAbsolutePath, textBytes, toolId, tryInput, type ToolDraft, type ToolRun,
} from "../core/tools";
import { formatSize } from "../core/screen";
import { NEED_TEXT, TOOLS_STRINGS, reviewBadge, reviewKey, toolTile } from "./tools";
import { N_, t, tl } from "../i18n/i18n";

export const FORGE_STRINGS = {
  title: N_("Tool workshop"),
  newTool: N_("New tool"),
  back: N_("Back to your tools"),
  how: N_("How it works"),
  hideHow: N_("Hide how it works"),
  showHow: N_("How it works"),
  step1: N_("Tell Lumo what the tool should do, or give it your script"),
  step2: N_("Lumo writes it and shows it here"),
  step3: N_("Try it on your PC"),
  step4: N_("Save it: once Lumo's supervisor has read it, your agents can use it"),
  draft: N_("Draft"),
  saved: N_("Saved"),
  changed: N_("Changed"),
  needs: N_("What it needs"),
  files: N_("Files"),
  runs: N_("Runs"),
  yourScript: N_("Your script, where it is"),
  tryIt: N_("Try"),
  trying: N_("Trying…"),
  worked: N_("It works · {time}"),
  failed: N_("It failed · {time}"),
  tell: N_("Tell Lumo"),
  toldOk: N_("I tried the tool and it worked. It printed:\n\n{output}"),
  toldFail: N_("I tried the tool and it failed:\n\n{output}\n\nPlease fix it."),
  save: N_("Save tool"),
  update: N_("Update tool"),
  ready: N_("On, ready for your agents"),
  writing: N_("Lumo is writing the tool…"),
  chip: N_("Tool draft · {name}"),
  welcome: N_("What tool shall we make?"),
  welcomeSub: N_("Describe what it should do, or give me a script you already have."),
  startNew: N_("Make a new tool"),
  startNewText: N_("Make a tool that "),
  startScript: N_("Bring in my script"),
  startScriptText: N_("Turn this script into a tool: "),
  startApp: N_("Connect an app"),
  startAppText: N_("Make a tool that connects Lumo to "),
  placeholder: N_("Describe the tool…"),
  editAsk: N_("I want to change my tool {name}."),
  editHere: N_("Here is {name} as it is now. What should change?"),
  noOutput: N_("(nothing)"),
};

// ── Which tool a workshop chat saved ─────────────────────────────────────────

const SAVED_KEY = "lumo.forge.saved.v1";

interface SavedLink {
  /** The tool's id (tools.rs). */
  tool: string;
  /** The draft as it was saved (draftKey). */
  key: string;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function links(): Record<string, SavedLink> {
  try {
    const raw = storage()?.getItem(SAVED_KEY);
    const v = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/** The tool a workshop chat saved (or opened on), and the draft it was. */
export function savedLink(chatId: string): SavedLink | null {
  return links()[chatId] ?? null;
}

/** Remembers that `chatId` saved (or opened on) `tool`, as `key`. */
export function linkSaved(chatId: string, tool: string, key: string) {
  const all = links();
  all[chatId] = { tool, key };
  // Only the newest few: a link is a convenience.
  const kept = Object.fromEntries(Object.entries(all).slice(-60));
  try {
    storage()?.setItem(SAVED_KEY, JSON.stringify(kept));
  } catch {
    // Storage full or unavailable: Save then adds a new tool, nothing worse.
  }
}

// ── The panel ────────────────────────────────────────────────────────────────

export interface ForgeHooks {
  /** Puts `text` in the chat's field, for the user to send. */
  tell(text: string): void;
  /** Back to the Tools tab. */
  back(): void;
}

export interface ForgePanel {
  /** The title row, at the top of the conversation. */
  head: HTMLElement;
  /** The tool as it stands, beside the conversation (only while there is a draft). */
  el: HTMLElement;
  /** How it works, over the whole workshop until it is put away with its dash. */
  guide: HTMLElement;
  /** The "?" at the top right that brings How it works back. */
  help: HTMLElement;
  /** Draws the newest draft of the workshop chat on screen. */
  sync(chatId: string, draft: ToolDraft | null): void;
}

type Status = "draft" | "saved" | "changed";

/** Whether How it works is put away (localStorage): open the first time. */
const GUIDE_KEY = "lumo.forge.guide.v1";

function readGuideOpen(): boolean {
  try {
    return localStorage.getItem(GUIDE_KEY) !== "closed";
  } catch {
    return true;
  }
}

export function buildForgePanel(hooks: ForgeHooks): ForgePanel {
  const headName = h("span", { class: "forge-head-name" });
  const backBtn = h("button", { class: "forge-back", title: tl(FORGE_STRINGS.back), "aria-label": tl(FORGE_STRINGS.back) },
    svg(ICONS.chevronLeft, 9, { stroke: 2.2 }), h("span", { text: tl(TOOLS_STRINGS.tab) }));
  backBtn.addEventListener("click", () => hooks.back());
  const head = h("div", { class: "forge-head" },
    h("span", { class: "forge-head-mark" }, svg(ICONS.wrench, 11, { stroke: 2 })),
    h("span", { class: "forge-head-title", text: tl(FORGE_STRINGS.title) }),
    headName,
    backBtn);

  const el = h("div", { class: "forge-panel" });

  // How it works: open over the workshop (the field, the usage and the rest
  // hidden under it) until its dash puts it away into the "?", remembered.
  let guideOpen = readGuideOpen();
  const hideBtn = h("button", { class: "forge-guide-hide", title: tl(FORGE_STRINGS.hideHow), "aria-label": tl(FORGE_STRINGS.hideHow) },
    svg(ICONS.minus, 12, { stroke: 2.2 }));
  hideBtn.addEventListener("click", () => setGuide(false));
  const step = (n: number, text: string) =>
    h("div", { class: "forge-step" }, h("span", { class: "forge-step-n", text: String(n) }), h("span", { class: "forge-step-text", text: tl(text) }));
  const guide = h("div", { class: "forge-guide", role: "dialog", "aria-label": tl(FORGE_STRINGS.how) },
    h("div", { class: "forge-guide-head" },
      h("span", { class: "forge-head-mark" }, svg(ICONS.wrench, 11, { stroke: 2 })),
      h("span", { class: "forge-guide-title", text: tl(FORGE_STRINGS.how) }),
      hideBtn),
    h("div", { class: "forge-steps" },
      step(1, FORGE_STRINGS.step1),
      step(2, FORGE_STRINGS.step2),
      step(3, FORGE_STRINGS.step3),
      step(4, FORGE_STRINGS.step4)),
    h("div", { class: "forge-note", text: tl(TOOLS_STRINGS.asks) }));
  const help = h("button", { class: "forge-help", title: tl(FORGE_STRINGS.showHow), "aria-label": tl(FORGE_STRINGS.showHow), text: "?" });
  help.addEventListener("click", () => setGuide(true));

  function setGuide(open: boolean) {
    guideOpen = open;
    try {
      localStorage.setItem(GUIDE_KEY, open ? "open" : "closed");
    } catch {
      // Only remembered when it can be.
    }
    Sound.play(open ? "blip" : "pop");
    layout();
  }

  /** The workshop's card: How it works over it, or the tool beside the conversation. */
  function layout() {
    const card = el.parentElement;
    if (!card) return;
    card.classList.toggle("guiding", guideOpen);
    card.classList.toggle("forge-draft", current != null);
  }

  let chatId = "";
  let current: ToolDraft | null = null;
  let drawn = "";
  /** The values typed in the try fields, by parameter name. */
  const typed: Record<string, string | boolean> = {};
  /** The last try of this draft. */
  let tried: { key: string; running: boolean; run: ToolRun | null } | null = null;
  let saving = false;
  let saveError = "";
  /** The file shown open, by name. */
  let openFile: string | null = null;
  /** The try fields as last drawn, by parameter name, to keep the one typed in focused across a redraw. */
  const fields = new Map<string, HTMLInputElement>();

  function status(d: ToolDraft): Status {
    const link = savedLink(chatId);
    if (!link) return "draft";
    return link.key === draftKey(d) ? "saved" : "changed";
  }

  /** The draft as it goes to Rust: it changes the tool this chat saved, if any. */
  function outgoing(d: ToolDraft): ToolDraft {
    return { ...d, replaces: savedLink(chatId)?.tool ?? d.replaces ?? null };
  }

  async function tryIt() {
    const d = current;
    if (!d || tried?.running) return;
    const key = draftKey(d);
    tried = { key, running: true, run: null };
    Sound.play("work");
    redraw();
    let run: ToolRun;
    try {
      run = await Bridge.toolsTry(outgoing(d), tryInput(d.params, typed));
    } catch (err) {
      run = { ok: false, output: String(err).replace(/^Error:\s*/, ""), ms: 0 };
    }
    if (tried?.key !== key) return;
    tried = { key, running: false, run };
    Sound.play(run.ok ? "finish" : "error");
    redraw();
  }

  async function save() {
    const d = current;
    if (!d || saving) return;
    saving = true;
    saveError = "";
    redraw();
    try {
      const info = await Bridge.toolsSave(outgoing(d));
      linkSaved(chatId, info.id, draftKey(d));
      Sound.play("proud");
    } catch (err) {
      saveError = String(err).replace(/^Error:\s*/, "");
      Sound.play("error");
    } finally {
      saving = false;
      redraw();
    }
  }

  function tellLumo(run: ToolRun) {
    const output = run.output.trim() || t(FORGE_STRINGS.noOutput);
    hooks.tell(t(run.ok ? FORGE_STRINGS.toldOk : FORGE_STRINGS.toldFail, { output }));
  }

  function redraw() {
    drawn = "";
    sync(chatId, current);
  }

  function seconds(ms: number): string {
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  }

  function section(title: string, ...children: (Node | null)[]): HTMLElement {
    return h("div", { class: "forge-section" }, h("div", { class: "forge-section-title", text: t(title) }), ...children);
  }

  function paramField(p: ToolDraft["params"][number]): HTMLElement {
    if (p.type === "boolean") {
      const on = typed[p.name] === true;
      const box = h("button", { class: on ? "switch on" : "switch", role: "switch", "aria-checked": on ? "true" : "false", "aria-label": p.name });
      box.addEventListener("click", () => {
        typed[p.name] = !on;
        redraw();
      });
      return h("label", { class: "forge-field bool", title: p.description }, h("span", { class: "forge-field-name", text: p.name }), box);
    }
    const input = h("input", {
      class: "forge-input",
      type: "text",
      spellcheck: "false",
      placeholder: p.type,
      value: typeof typed[p.name] === "string" ? (typed[p.name] as string) : "",
      "aria-label": p.name,
    }) as HTMLInputElement;
    input.addEventListener("input", () => {
      typed[p.name] = input.value;
    });
    fields.set(p.name, input);
    // The island's keys (Esc closes it) stay out of a field being typed in.
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if ((e as KeyboardEvent).key === "Enter") void tryIt();
    });
    return h("label", { class: p.required ? "forge-field required" : "forge-field", title: p.description },
      h("span", { class: "forge-field-name", text: p.name }), input);
  }

  function draw(d: ToolDraft) {
    const st = status(d);
    const statusText = { draft: FORGE_STRINGS.draft, saved: FORGE_STRINGS.saved, changed: FORGE_STRINGS.changed }[st];
    const saved = st === "saved" ? State.tools.find((x) => x.id === savedLink(chatId)?.tool) : undefined;
    const top = h("div", { class: "forge-tool" },
      toolTile(savedLink(chatId)?.tool ?? toolId(d.name), 32),
      h("div", { class: "forge-tool-text" },
        h("div", { class: "forge-tool-name", text: d.name }),
        h("span", { class: "forge-tool-badges" },
          h("span", { class: `forge-status ${st}`, text: t(statusText) }),
          saved ? reviewBadge(saved) : null)));
    const desc = d.description ? h("div", { class: "forge-desc", text: d.description, title: d.description }) : null;
    // The supervisor's words, once it read the tool as saved.
    const verdict = saved?.reviewed && saved.review
      ? h("div", { class: `forge-review ${saved.review.verdict}` },
        h("span", { class: "forge-section-title", text: t(TOOLS_STRINGS.supervisor) }),
        h("div", { class: "forge-review-text", text: saved.review.summary }))
      : null;

    const params = d.params.length
      ? h("div", { class: "forge-params" }, ...d.params.map((p) =>
        h("span", { class: p.required ? "param-chip required" : "param-chip", title: p.description },
          h("span", { text: p.name }), h("i", { text: p.type }))))
      : h("div", { class: "need-none", text: t(TOOLS_STRINGS.noParams) });

    const needs = h("div", { class: "tool-needs words" });
    for (const p of d.permissions) {
      const need = NEED_TEXT[p];
      if (need) needs.append(h("span", { class: `need-chip need-${p}` }, svg(need.icon, 10, { stroke: 1.8 }), h("span", { text: t(need.label) })));
    }
    if (!needs.children.length) needs.append(h("span", { class: "need-none", text: t(TOOLS_STRINGS.noNeeds) }));

    const files = h("div", { class: "forge-files" });
    if (isAbsolutePath(d.entry)) {
      files.append(h("div", { class: "forge-file external", title: d.entry },
        svg(ICONS.doc, 11, { stroke: 1.7 }),
        h("span", { class: "forge-file-name", text: d.entry.replace(/^.*[\\/]/, "") }),
        h("span", { class: "forge-file-badge", text: t(FORGE_STRINGS.runs) })),
      h("div", { class: "forge-note", text: t(FORGE_STRINGS.yourScript) }));
    }
    for (const f of d.files) {
      const isEntry = f.name.toLowerCase() === d.entry.toLowerCase();
      const row = h("button", { class: openFile === f.name ? "forge-file open" : "forge-file", title: f.name },
        svg(ICONS.doc, 11, { stroke: 1.7 }),
        h("span", { class: "forge-file-name", text: f.name }),
        isEntry ? h("span", { class: "forge-file-badge", text: t(FORGE_STRINGS.runs) }) : null,
        h("span", { class: "forge-file-size", text: formatSize(textBytes(f.content)) }));
      row.addEventListener("click", () => {
        openFile = openFile === f.name ? null : f.name;
        redraw();
      });
      files.append(row);
      if (openFile === f.name) {
        const code = h("pre", { class: "forge-code" }, h("code", { text: f.content }));
        code.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
        files.append(code);
      }
    }

    // Try: the values, the button, and how it went.
    const key = draftKey(d);
    const mine = tried?.key === key ? tried : null;
    const tryBtn = h("button", { class: "forge-btn" },
      svg(mine?.running ? ICONS.clock : ICONS.play, 10, mine?.running ? { stroke: 2 } : {}),
      h("span", { text: t(mine?.running ? FORGE_STRINGS.trying : FORGE_STRINGS.tryIt) }));
    (tryBtn as HTMLButtonElement).disabled = mine?.running ?? false;
    tryBtn.addEventListener("click", () => void tryIt());
    const saveBtn = h("button", { class: st === "saved" ? "forge-btn primary done" : "forge-btn primary" },
      st === "saved" ? svg(ICONS.check, 10, { stroke: 2.4 }) : null,
      h("span", { text: t(st === "saved" ? FORGE_STRINGS.saved : st === "changed" ? FORGE_STRINGS.update : FORGE_STRINGS.save) }));
    (saveBtn as HTMLButtonElement).disabled = saving || st === "saved";
    saveBtn.addEventListener("click", () => void save());

    let result: HTMLElement | null = null;
    const run = mine?.run;
    if (run) {
      const tell = h("button", { class: "forge-link" }, svg(ICONS.bubble, 10), h("span", { text: t(FORGE_STRINGS.tell) }));
      tell.addEventListener("click", () => tellLumo(run));
      const out = h("pre", { class: "forge-output" }, h("code", { text: run.output.trim() || t(FORGE_STRINGS.noOutput) }));
      out.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });
      result = h("div", { class: run.ok ? "forge-result ok" : "forge-result fail" },
        h("div", { class: "forge-result-head" },
          h("span", { class: "forge-result-dot" }),
          h("span", { text: t(run.ok ? FORGE_STRINGS.worked : FORGE_STRINGS.failed, { time: seconds(run.ms) }) }),
          tell),
        out);
    }

    el.append(top);
    if (desc) el.append(desc);
    if (verdict) el.append(verdict);
    el.append(
      section(TOOLS_STRINGS.params, params),
      section(FORGE_STRINGS.needs, needs),
      section(FORGE_STRINGS.files, files),
      h("div", { class: "forge-try" },
        d.params.length ? h("div", { class: "forge-fields" }, ...d.params.map(paramField)) : null,
        h("div", { class: "forge-buttons" }, tryBtn, saveBtn),
        saveError ? h("div", { class: "forge-error", text: saveError }) : null,
        st === "saved" && saved?.reviewed && saved.enabled ? h("div", { class: "forge-ready" }, svg(ICONS.check, 9, { stroke: 2.4 }), h("span", { text: t(FORGE_STRINGS.ready) })) : null,
        result),
    );
  }

  function sync(id: string, draft: ToolDraft | null) {
    if (id !== chatId) {
      chatId = id;
      tried = null;
      openFile = null;
      saveError = "";
      for (const k of Object.keys(typed)) delete typed[k];
    }
    current = draft;
    layout();
    headName.textContent = draft ? `· ${draft.name}` : `· ${t(FORGE_STRINGS.newTool)}`;
    const key = JSON.stringify([
      id, draft ? draftKey(draft) : null, draft ? status(draft) : null, tried, saving, saveError, openFile, t(FORGE_STRINGS.draft),
      reviewKey(savedLink(id)?.tool ?? ""), State.tools.find((x) => x.id === savedLink(id)?.tool)?.review?.summary ?? "",
    ]);
    if (key === drawn) return;
    drawn = key;
    // A field being typed in keeps its focus across a redraw.
    const focused = [...fields].find(([, input]) => input === document.activeElement)?.[0] ?? null;
    fields.clear();
    const kept = el.scrollTop;
    clear(el);
    if (draft) draw(draft);

    el.scrollTop = kept;
    if (focused) fields.get(focused)?.focus();
  }

  // The panel scrolls by itself, never the chat under it.
  el.addEventListener("wheel", (e) => e.stopPropagation(), { passive: true });

  // Tools saved elsewhere (or deleted): Saved may no longer hold.
  State.subscribe(() => {
    const link = savedLink(chatId);
    if (link && State.tools.length && !State.tools.some((x) => x.id === link.tool)) drawn = "";
  });

  return { head, el, guide, help, sync };
}

/** What a workshop answer shows in place of the draft's blocks: a line naming it. */
export function draftChip(name: string): HTMLElement {
  return h("div", { class: "forge-chip" },
    h("span", { class: "forge-chip-mark" }, svg(ICONS.wrench, 9, { stroke: 2 })),
    h("span", { text: t(FORGE_STRINGS.chip, { name }) }));
}
