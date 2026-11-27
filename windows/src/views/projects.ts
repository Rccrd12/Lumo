// The projects' own pages (concept progetti v2), drawn by views/orchestra.ts
// in the chat's place: the card that leads to them from the empty chat, the
// list of projects, and the form that makes one or changes it (New project,
// and the gear of a project open). The form: a name and its icon (a picker
// with a search, simple line icons, a colour and a reset), what to work on, a
// folder, the coordinator's and the threads' models (a menu with a search,
// the models grouped by provider, the effort under them), and whether the
// threads go on by themselves once the usage limits reset.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge, type ModelInfo } from "../core/bridge";
import { GOAL_MAX, Orchestra, type OrchestraMemoryNote, type OrchestraSummary, type ProjectFields } from "../core/orchestra-bridge";
import { ORCHESTRA_ACCENT, orchestraProviders, shortModel, type OrchestraRole } from "../core/orchestra-picks";
import { apiCaps, effortsFor, isCliProvider, providerDef } from "../core/providers";
import { cliModelName } from "../core/model-names";
import { isOrchestratorRow } from "../core/orchestrator";
import { Sound } from "../core/sound";
import { State, type OrchestraPick } from "../core/state";
import { t, tn } from "../i18n/i18n";
import { sentAgo } from "./chat-messages";
import { STRINGS, effortLabel } from "./chat-strings";
import { readyProviders } from "./chat-models";
import { DEFAULT_ICON, GEAR_LINE, NONE_LINE, PROJECT_COLORS, REPO_LINE, SEARCH_LINE, findIcons, iconSvg, projectMark } from "./project-icons";
import { ORCHESTRA_STRINGS as S } from "./orchestra-strings";

export { GEAR_LINE };

// ── The empty chat's card ────────────────────────────────────────────────────

/** "3 projects · 1 waiting for you": what the empty chat's card says of them. */
export function projectsCount(list: readonly OrchestraSummary[]): string {
  if (list.length === 0) return "";
  const waiting = list.filter((p) => p.state === "waiting").length;
  const all = tn("{count} project", S.projectCount, list.length);
  return waiting > 0 ? `${all} · ${tn("{count} waiting for you", S.waitingCount, waiting)}` : all;
}

/** The card under the empty chat's three ways to start: a click opens the projects. */
export function projectsCard(list: readonly OrchestraSummary[] | null, open: () => void): HTMLElement {
  const count = list ? projectsCount(list) : "";
  const waiting = list?.some((p) => p.state === "waiting") ?? false;
  const mark = projectMark("box", ORCHESTRA_ACCENT, 30, 15);
  const el = h("button", { class: "pj-start" },
    mark,
    h("span", { class: "pj-start-text" },
      h("b", { text: t(S.projects) }),
      h("small", { text: t(S.projectsSub) })),
    count ? h("span", { class: waiting ? "pj-start-count asking" : "pj-start-count", text: count }) : null,
    svg(ICONS.chevronRight, 10, { stroke: 2.2 }));
  el.addEventListener("click", () => open());
  return el;
}

// ── The list ─────────────────────────────────────────────────────────────────

/** Where a project stands, as its pill says it, and its colour. */
export function stateOf(p: OrchestraSummary): { text: string; color: string } {
  switch (p.state) {
    case "waiting":
      return { text: t(S.waiting), color: "#f5c542" };
    case "working": {
      const plan = p.planTotal > 0 ? ` · ${t(S.planPill, { done: p.planDone, total: p.planTotal })}` : "";
      return { text: `${tn("{count} at work", S.atWork, p.working)}${plan}`, color: "#7cb4ff" };
    }
    case "paused":
      return { text: t(S.paused), color: "#fb923c" };
    case "done":
      return { text: t(S.done), color: "#4ade80" };
    case "stopped":
      return { text: t(S.stopped), color: "#9aa0a8" };
    default:
      return { text: t(S.ready), color: "#9aa0a8" };
  }
}

/** Who plays the two roles, short: "Opus 5.5 → gemma-4-26b". */
export function modelsLine(coordinator: OrchestraPick, thread: OrchestraPick): string {
  const c = shortModel(coordinator.provider, coordinator.model);
  const x = shortModel(thread.provider, thread.model);
  return c && x ? `${c} → ${x}` : c || x;
}

/** The projects, newest first, under "Projects", the way back to the chat and New project. */
export function buildProjectList(list: readonly OrchestraSummary[] | null, on: { open(id: string): void; create(): void; back(): void }): HTMLElement {
  const fresh = h("button", { class: "pj-new" }, svg(ICONS.plus, 9), h("span", { text: t(S.newProject) }));
  fresh.addEventListener("click", () => on.create());
  // The way back to the chat, first in the row.
  const back = h("button", { class: "pj-back", title: t(S.backToChats), "aria-label": t(S.backToChats) },
    svg(ICONS.chevronLeft, 10, { stroke: 2.2 }), h("span", { text: t(S.chat) }));
  back.addEventListener("click", () => on.back());
  const page = h("div", { class: "pj-panel" }, h("div", { class: "pj-head" }, back, h("span", { class: "pj-title", text: t(S.projects) }), fresh));
  if (list == null) {
    page.append(h("div", { class: "pj-none", text: t(STRINGS.loading) }));
    return page;
  }
  if (list.length === 0) page.append(h("div", { class: "pj-none", text: t(S.noProjects) }));
  for (const p of [...list].sort((a, b) => b.updated - a.updated)) {
    const state = stateOf(p);
    const card = h("button", { class: "pj-card", "data-project": p.id },
      projectMark(p.icon, p.color),
      h("span", { class: "pj-main" },
        h("span", { class: "pj-name", text: p.title || t(S.untitled) }),
        p.goal ? h("span", { class: "pj-goal", text: p.goal.split("\n")[0] }) : null,
        h("span", { class: "pj-meta" },
          h("span", { class: "pj-state", style: `color:${state.color};background:${state.color}1f` }, h("i", { class: "pj-dot", style: `background:${state.color}` }), h("span", { text: state.text })),
          h("span", { class: "pj-models", text: modelsLine(p.coordinator, p.thread) }))),
      h("span", { class: "pj-side", text: sentAgo(p.updated) }));
    card.addEventListener("click", () => on.open(p.id));
    page.append(card);
  }
  return page;
}

// ── The form ─────────────────────────────────────────────────────────────────

export interface ProjectForm {
  el: HTMLElement;
  /** What the form says now. */
  fields(): ProjectFields;
  /** Closes what is open over it (a menu): true when something was. */
  dismiss(): boolean;
}

/** A repository of the user's, for a project's environment. */
interface RepoName {
  name: string;
  private: boolean;
  description: string;
}

/** The user's GitHub repositories, asked once while the island is open (a failure is asked again). */
let reposListed: Promise<RepoName[]> | null = null;

function reposOf(): Promise<RepoName[]> {
  if (!reposListed) {
    const got = Orchestra.repoNames().then((list) => (Array.isArray(list) ? list : []));
    got.catch(() => {
      reposListed = null;
    });
    reposListed = got;
  }
  return reposListed;
}

/** The models each provider lists, asked once while the island is open. */
const listed = new Map<string, Promise<ModelInfo[]>>();
/** The efforts each model takes, by "provider|model". */
const levelsKnown = new Map<string, string[]>();

function modelsOf(provider: string): Promise<ModelInfo[]> {
  let got = listed.get(provider);
  if (!got) {
    const p = providerDef(provider);
    got = (async () => {
      // Nothing is asked of a provider that has no key yet.
      if (p.key && !(await Bridge.secretPresent(p.key))) return [];
      const models = await Bridge.chatModels(provider);
      return Array.isArray(models) ? models.filter((m) => !isOrchestratorRow(m.id)) : [];
    })();
    // A failure is asked again the next time.
    got.catch(() => listed.delete(provider));
    listed.set(provider, got);
  }
  return got;
}

/** A long path by its end, where its name is: "…\\Documenti\\Contratti". */
export function shortPath(path: string, max = 28): string {
  if (path.length <= max) return path;
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(sep).filter(Boolean);
  let out = parts.pop() ?? path;
  while (parts.length > 0 && out.length + parts[parts.length - 1].length + 1 <= max - 2) out = `${parts.pop()}${sep}${out}`;
  return `…${sep}${out}`;
}

/** A model's name as the menus say it (and a project's model button). */
export function modelName(provider: string, model: string, label?: string): string {
  if (!model) return t(STRINGS.noModel);
  if (label) return label;
  return isCliProvider(provider) ? cliModelName(provider, model) : shortModel(provider, model);
}

/** The efforts `pick`'s model takes: a CLI's own, an API model's list, a local model's server's word. */
async function levelsOf(pick: OrchestraPick): Promise<string[]> {
  if (!pick.model) return [];
  const key = `${pick.provider}|${pick.model}`;
  const known = levelsKnown.get(key);
  if (known) return known;
  const p = providerDef(pick.provider);
  let levels: string[] = [];
  try {
    if (isCliProvider(p.id)) levels = effortsFor(p.id).filter(Boolean);
    else if (p.urlField) levels = (await Bridge.localCaps(p.id, pick.model))?.reasoning ?? [];
    else levels = apiCaps((await modelsOf(p.id)).find((m) => m.id === pick.model))?.reasoning ?? [];
  } catch {
    levels = [];
  }
  levelsKnown.set(key, levels);
  return levels;
}

/**
 * The form of a new project (`mode` "new") or of one open ("edit": its
 * settings, with Delete). `save` answers what went wrong, or null.
 */
export function buildProjectForm(opts: {
  mode: "new" | "edit";
  fields: ProjectFields;
  save(fields: ProjectFields): Promise<string | null>;
  cancel(): void;
  remove?(): void;
  /** A project open: what its members keep for later, and how the user forgets a note (its memory after). */
  memory?: readonly OrchestraMemoryNote[];
  forget?(subject: string): Promise<readonly OrchestraMemoryNote[] | null>;
}): ProjectForm {
  const f: ProjectFields = structuredClone(opts.fields);
  f.repos = f.repos ?? [];
  const editing = opts.mode === "edit";
  /** The menu open over the form, and the field it belongs to. */
  let pop: HTMLElement | null = null;
  let popFor: HTMLElement | null = null;
  let saving = false;
  let deleteArmed: ReturnType<typeof setTimeout> | null = null;

  const page = h("div", { class: "pj-page" });
  const form = h("div", { class: "pj-form" });
  page.append(form);
  form.addEventListener("scroll", () => closePop());

  // ── Name and icon
  const markBtn = h("button", { class: "pj-mark-btn", title: t(S.nameAndIcon), "aria-label": t(S.nameAndIcon) });
  const drawMark = () => {
    clear(markBtn);
    markBtn.append(projectMark(f.icon || DEFAULT_ICON, f.color, 24, 13));
  };
  drawMark();
  const name = h("input", { class: "pj-name-input", type: "text", maxlength: "60", placeholder: t(S.namePlaceholder), spellcheck: "false" }) as HTMLInputElement;
  name.value = f.title;
  const nameField = h("span", { class: "pj-field pj-namefield" }, markBtn, name);
  markBtn.addEventListener("click", () => togglePop(nameField, iconPicker));

  // ── What to work on
  const goal = h("textarea", { class: "pj-area", rows: "3", maxlength: String(GOAL_MAX), placeholder: t(S.goalPlaceholder) }) as HTMLTextAreaElement;
  goal.value = f.goal;
  const count = h("div", { class: "pj-count" });
  const drawCount = () => {
    count.textContent = `${goal.value.length} / ${GOAL_MAX}`;
  };
  drawCount();

  // ── The folder
  const folderText = h("span", { class: "pj-folder-text" });
  const folderClear = h("button", { class: "pj-folder-x", title: t(S.clearFolder), "aria-label": t(S.clearFolder) }, svg(ICONS.xmark, 8));
  const folderBtn = h("button", { class: "pj-field sel pj-folder" },
    h("span", { class: "pj-sel-main" }, iconSvg("folder", 13), folderText),
    svg(ICONS.chevronDown, 10, { stroke: 2 }));
  const drawFolder = () => {
    folderText.textContent = f.folder ? shortPath(f.folder) : t(S.pickFolder);
    folderText.classList.toggle("empty", !f.folder);
    folderBtn.title = f.folder;
    folderClear.hidden = !f.folder;
  };
  drawFolder();
  folderBtn.addEventListener("click", () => {
    closePop();
    void Bridge.pickFolder().then((path) => {
      if (!path) return;
      f.folder = path;
      drawFolder();
    });
  });
  folderClear.addEventListener("click", () => {
    f.folder = "";
    drawFolder();
  });

  // ── Its environment: the user's GitHub repositories, cloned for it (orchestra.rs ensure_repos)
  const env = h("div", { class: "pj-env" });
  const addRepo = h("button", { class: "pj-repo-add" }, svg(ICONS.plus, 10, { stroke: 2.2 }), h("span", { text: t(S.addRepo) }));
  /** GitHub's token saved in Lumo: null until known. */
  let github: boolean | null = null;
  const drawEnv = () => {
    clear(env);
    for (const r of f.repos) {
      const x = h("button", { class: "pj-repo-x", title: t(S.removeRepo), "aria-label": `${t(S.removeRepo)} ${r}` }, svg(ICONS.xmark, 7));
      x.addEventListener("click", () => {
        f.repos = f.repos.filter((y) => y !== r);
        drawEnv();
      });
      env.append(h("span", { class: "pj-repo", title: r }, svg(REPO_LINE, 12, { stroke: 1.8 }), h("span", { class: "pj-repo-name", text: r }), x));
    }
    if (github === false) env.append(h("div", { class: "pj-env-note", text: t(S.connectGithub) }));
    else if (f.repos.length < 8) env.append(addRepo);
  };
  drawEnv();
  void Bridge.secretPresent("github-token").then(
    (yes) => {
      github = !!yes;
      drawEnv();
    },
    () => {
      github = false;
      drawEnv();
    },
  );
  addRepo.addEventListener("click", () => togglePop(env, repoPicker));

  // ── The models
  const coordBtn = h("button", { class: "pj-field sel pj-coord" });
  const threadBtn = h("button", { class: "pj-field sel pj-thread" });
  const drawPick = (btn: HTMLElement, pick: OrchestraPick) => {
    clear(btn);
    const p = providerDef(pick.provider);
    btn.title = pick.model;
    btn.append(
      h("span", { class: "pj-sel-main" },
        h("i", { class: "pj-pdot", style: `background:${p.accent}` }),
        h("b", { text: modelName(pick.provider, pick.model) }),
        h("i", { class: "pj-sel-sub", text: pick.effort ? `${t(p.name)} · ${effortLabel(pick.effort)}` : t(p.name) })),
      svg(ICONS.chevronDown, 10, { stroke: 2 }));
    btn.classList.toggle("open", popFor === btn);
  };
  const drawPicks = () => {
    drawPick(coordBtn, f.coordinator);
    drawPick(threadBtn, f.thread);
  };
  drawPicks();
  coordBtn.addEventListener("click", () => togglePop(coordBtn, () => modelMenu("coordinator")));
  threadBtn.addEventListener("click", () => togglePop(threadBtn, () => modelMenu("thread")));

  // ── Resume
  const resume = h("button", { class: "pj-switch", role: "switch", "aria-label": t(S.resumeLabel) });
  const drawResume = () => {
    resume.classList.toggle("on", f.resume);
    resume.setAttribute("aria-checked", String(f.resume));
  };
  drawResume();
  resume.addEventListener("click", () => {
    f.resume = !f.resume;
    Sound.play("pop");
    drawResume();
  });

  // ── Cancel, Create or Save, Delete
  const error = h("div", { class: "pj-error" });
  error.hidden = true;
  const saveBtn = h("button", { class: "pj-b primary", text: t(editing ? S.save : S.create) });
  const cancelBtn = h("button", { class: "pj-b", text: t(S.cancel) });
  const drawSave = () => {
    (saveBtn as HTMLButtonElement).disabled = saving || !name.value.trim();
  };
  drawSave();
  name.addEventListener("input", () => {
    f.title = name.value;
    drawSave();
  });
  goal.addEventListener("input", () => {
    f.goal = goal.value;
    drawCount();
  });
  cancelBtn.addEventListener("click", () => opts.cancel());
  saveBtn.addEventListener("click", () => void submit());
  let deleteBtn: HTMLElement | null = null;
  if (editing && opts.remove) {
    const remove = opts.remove;
    const del = h("button", { class: "pj-b danger", text: t(S.deleteProject) });
    del.addEventListener("click", () => {
      // A second click within a few seconds: the project and its chats go for good.
      if (deleteArmed) {
        clearTimeout(deleteArmed);
        deleteArmed = null;
        remove();
        return;
      }
      del.textContent = t(S.deleteSure);
      del.classList.add("armed");
      deleteArmed = setTimeout(() => {
        deleteArmed = null;
        del.textContent = t(S.deleteProject);
        del.classList.remove("armed");
      }, 4000);
    });
    deleteBtn = del;
  }

  async function submit() {
    if (saving || !name.value.trim()) return;
    saving = true;
    drawSave();
    closePop();
    f.title = name.value.trim();
    f.goal = goal.value;
    const failed = await opts.save(structuredClone(f));
    saving = false;
    drawSave();
    error.textContent = failed ?? "";
    error.hidden = !failed;
  }

  let close: HTMLElement | null = null;
  if (editing) {
    close = h("button", { class: "pj-x", title: t(S.close), "aria-label": t(S.close) }, svg(ICONS.xmark, 9));
    close.addEventListener("click", () => opts.cancel());
  }
  const row = (label: HTMLElement | string, field: HTMLElement, cls = "") =>
    h("div", { class: `pj-row ${cls}`.trim() }, typeof label === "string" ? h("span", { class: "pj-lbl", text: label }) : label, field);
  form.append(
    h("h3", { class: "pj-h" }, h("span", { text: t(editing ? S.projectSettings : S.newProject) }), close),
    row(t(S.nameAndIcon), nameField),
    h("div", { class: "pj-q", text: t(S.goalQuestion) }),
    goal,
    count,
    row(h("span", { class: "pj-lbl" }, h("span", { text: t(S.folder) }), h("small", { text: t(S.folderNote) })),
      h("span", { class: "pj-folder-wrap" }, folderBtn, folderClear)),
    row(h("span", { class: "pj-lbl" }, h("span", { text: t(S.environment) }), h("small", { text: t(S.environmentNote) })), env, "pj-env-row"),
    h("div", { class: "pj-sep" }),
    h("h3", { class: "pj-h", text: t(S.models) }),
    row(t(S.coordinator), coordBtn),
    row(t(S.thread), threadBtn),
    h("div", { class: "pj-sep" }),
    row(t(S.resumeLabel), resume, "pj-resume"),
    ...(editing && opts.forget ? [h("div", { class: "pj-sep" }), memoryBox()] : []),
    error,
    h("div", { class: "pj-actions" }, deleteBtn, cancelBtn, saveBtn));

  // ── The project's memory (save_memory), in its settings

  /** Its notes, each with who kept it and Forget; the user reads what every member reads. */
  function memoryBox(): HTMLElement {
    const list = h("div", { class: "pj-memory" });
    const drawNotes = (notes: readonly OrchestraMemoryNote[]) => {
      clear(list);
      if (notes.length === 0) list.append(h("div", { class: "pj-memory-none", text: t(S.memoryEmpty) }));
      for (const n of notes) {
        const forget = h("button", { class: "pj-memory-x", title: t(S.forget), "aria-label": t(S.forget) }, svg(ICONS.xmark, 8));
        forget.addEventListener("click", () => {
          forget.disabled = true;
          void opts.forget?.(n.subject).then((after) => {
            if (after) {
              Sound.play("pop");
              drawNotes(after);
            } else forget.disabled = false;
          });
        });
        list.append(h("div", { class: "pj-memory-note" },
          h("div", { class: "pj-memory-head" }, h("span", { class: "pj-memory-subject", text: n.subject }), forget),
          h("div", { class: "pj-memory-text", text: n.text })));
      }
    };
    drawNotes(opts.memory ?? []);
    return h("div", { class: "pj-memory-box" },
      h("h3", { class: "pj-h" }, h("span", { text: t(S.memory) })),
      h("div", { class: "pj-memory-about", text: t(S.memoryNote) }),
      list);
  }

  // ── The menus over the form

  function closePop() {
    if (!pop) return;
    pop.remove();
    const was = popFor;
    pop = null;
    popFor = null;
    if (was === coordBtn || was === threadBtn) drawPicks();
  }

  function togglePop(field: HTMLElement, make: () => HTMLElement) {
    const same = popFor === field;
    closePop();
    if (same) return;
    popFor = field;
    pop = make();
    pop.style.width = `${field.getBoundingClientRect().width || 300}px`;
    page.append(pop);
    if (field === coordBtn || field === threadBtn) drawPicks();
    place();
  }

  /** Under its field when it fits there, else over it, its list shortened to fit. */
  function place() {
    if (!pop || !popFor) return;
    const f0 = popFor.getBoundingClientRect();
    const b = page.getBoundingClientRect();
    pop.style.left = `${Math.max(0, f0.left - b.left)}px`;
    const below = b.bottom - f0.bottom - 10;
    if (below >= pop.offsetHeight) {
      pop.style.top = `${f0.bottom - b.top + 6}px`;
      return;
    }
    const above = f0.top - b.top - 4;
    const list = pop.querySelector<HTMLElement>(".pj-list");
    if (list && pop.offsetHeight > above && above > 0) list.style.maxHeight = `${Math.max(80, list.offsetHeight - (pop.offsetHeight - above))}px`;
    pop.style.top = `${Math.max(0, f0.top - b.top - pop.offsetHeight - 6)}px`;
  }

  /** Search, the icons, the colours, and Reset. */
  function iconPicker(): HTMLElement {
    const grid = h("div", { class: "pj-grid" });
    const drawGrid = (q = "") => {
      clear(grid);
      const names = findIcons(q);
      if (names.length === 0) grid.append(h("div", { class: "pj-none small", text: t(S.noIcons) }));
      for (const n of names) {
        const on = (f.icon || DEFAULT_ICON) === n;
        const b = h("button", { class: on ? "pj-icon on" : "pj-icon", title: n, "data-icon": n, style: on && f.color ? `color:${f.color}` : "" }, iconSvg(n, 17, 1.6));
        b.addEventListener("click", () => {
          f.icon = n;
          drawMark();
          drawGrid(q);
        });
        grid.append(b);
      }
    };
    drawGrid();
    const colors = h("div", { class: "pj-colors" });
    const drawColors = () => {
      clear(colors);
      for (const c of PROJECT_COLORS) {
        const b = h("button", { class: `pj-color${c ? "" : " none"}${f.color === c ? " on" : ""}`, style: c ? `background:${c}` : "", "data-color": c, "aria-label": c || t(S.noColor) });
        b.addEventListener("click", () => {
          f.color = c;
          drawMark();
          drawColors();
          drawGrid(query.value);
        });
        colors.append(b);
      }
    };
    drawColors();
    const query = searchBox(t(S.searchIcons), (q) => drawGrid(q));
    const reset = h("button", { class: "pj-reset" }, svg(NONE_LINE, 14, { stroke: 1.8 }), h("span", { text: t(S.resetIcon) }));
    reset.addEventListener("click", () => {
      f.icon = "";
      f.color = "";
      drawMark();
      drawColors();
      drawGrid(query.value);
    });
    return h("div", { class: "pj-pop pj-pop-icons" },
      h("label", { class: "pj-search" }, svg(SEARCH_LINE, 13, { stroke: 1.8 }), query),
      grid, colors, reset);
  }

  /** Search and the user's repositories not in the environment yet: a click adds one. */
  function repoPicker(): HTMLElement {
    const list = h("div", { class: "pj-list" });
    let q = "";
    let got: RepoName[] | string | null = null;
    const draw = () => {
      clear(list);
      if (got == null) {
        list.append(h("div", { class: "pj-opt-note", text: t(STRINGS.loading) }));
        return;
      }
      if (typeof got === "string") {
        list.append(h("div", { class: "pj-opt-note", text: got }));
        return;
      }
      const words = q.trim().toLowerCase();
      const rows = got.filter((r) => !f.repos.includes(r.name) && (!words || `${r.name} ${r.description}`.toLowerCase().includes(words)));
      if (rows.length === 0) {
        list.append(h("div", { class: "pj-none small", text: t(S.noRepos) }));
        return;
      }
      for (const r of rows.slice(0, 100)) {
        const b = h("button", { class: "pj-opt pj-repo-opt", title: r.description || r.name, "data-repo": r.name },
          svg(REPO_LINE, 12, { stroke: 1.8 }),
          h("span", { class: "pj-opt-name", text: r.name }),
          r.private ? h("span", { class: "pj-opt-tag", text: t(S.privateRepo) }) : null);
        b.addEventListener("click", () => {
          f.repos = [...f.repos, r.name];
          Sound.play("blip");
          closePop();
          drawEnv();
        });
        list.append(b);
      }
    };
    const search = searchBox(t(S.searchRepos), (v) => {
      q = v;
      draw();
    });
    const menu = h("div", { class: "pj-pop pj-pop-repos" }, h("label", { class: "pj-search" }, svg(SEARCH_LINE, 13, { stroke: 1.8 }), search), list);
    draw();
    void reposOf().then(
      (repos) => {
        got = repos;
      },
      (err) => {
        got = String(err).replace(/^Error:\s*/, "");
      },
    ).then(() => {
      if (pop !== menu) return;
      draw();
      place();
    });
    return menu;
  }

  /** The models' menu of a role's field. */
  function modelMenu(role: OrchestraRole): HTMLElement {
    const key = role === "coordinator" ? "coordinator" : "thread";
    return buildModelMenu({
      role,
      get: () => f[key],
      set: (pick) => {
        f[key] = pick;
        drawPicks();
      },
      placed: place,
      open: (menu) => pop === menu,
    });
  }

  // A click away from the menu closes it.
  page.addEventListener("pointerdown", (e) => {
    const target = e.target as Node | null;
    if (!pop || !target) return;
    if (pop.contains(target) || popFor?.contains(target)) return;
    closePop();
  });

  return {
    el: page,
    fields: () => ({ ...structuredClone(f), title: name.value, goal: goal.value }),
    dismiss() {
      if (!pop) return false;
      closePop();
      return true;
    },
  };
}

function searchBox(placeholder: string, run: (q: string) => void): HTMLInputElement {
  const input = h("input", { class: "pj-search-input", type: "text", placeholder, spellcheck: "false" }) as HTMLInputElement;
  input.addEventListener("input", () => run(input.value));
  queueMicrotask(() => input.focus?.());
  return input;
}

/**
 * The models' menu: a search, the models grouped by provider (the CLIs other
 * than Claude Code left out for the coordinator), the effort under them.
 * `get` and `set` the pick it shows; `placed` once its height changed;
 * `open` whether it is still on screen.
 */
export function buildModelMenu(o: {
  role: OrchestraRole;
  get(): OrchestraPick;
  set(pick: OrchestraPick): void;
  placed(): void;
  open(menu: HTMLElement): boolean;
}): HTMLElement {
  const role = o.role;
  const list = h("div", { class: "pj-list" });
  const effort = h("div", { class: "pj-effort" });
  const providers = orchestraProviders(State.settings, readyProviders, role);
  const got = new Map<string, ModelInfo[] | string>();
  let q = "";
  const drawList = () => {
    // Drawn again as providers answer: where the list was scrolled stays.
    const top = list.scrollTop;
    clear(list);
    const words = q.trim().toLowerCase();
    let any = false;
    for (const p of providers) {
      const models = got.get(p.id);
      const rows: HTMLElement[] = [];
      if (models == null) rows.push(h("div", { class: "pj-opt-note", text: t(STRINGS.loading) }));
      else if (typeof models === "string") rows.push(h("div", { class: "pj-opt-note", text: models }));
      else {
        for (const m of models) {
          const label = modelName(p.id, m.id, m.label);
          if (words && !`${label} ${m.id} ${t(p.name)}`.toLowerCase().includes(words)) continue;
          const on = o.get().provider === p.id && o.get().model === m.id;
          const b = h("button", { class: on ? "pj-opt on" : "pj-opt", title: m.id, "data-model": m.id },
            h("i", { class: "pj-pdot", style: `background:${p.accent}` }),
            h("span", { class: "pj-opt-name", text: label }),
            on ? svg(ICONS.check, 10, { stroke: 2.4 }) : null);
          b.addEventListener("click", () => {
            const now = o.get();
            o.set({ provider: p.id, model: m.id, effort: now.provider === p.id && now.model === m.id ? now.effort : "" });
            Sound.play("blip");
            drawList();
            void drawEffort();
          });
          rows.push(b);
        }
      }
      if (words && rows.every((r) => !r.classList.contains("pj-opt"))) continue;
      any = true;
      list.append(h("div", { class: "pj-grp", text: t(p.name) }), ...rows);
    }
    if (!any) list.append(h("div", { class: "pj-none small", text: t(S.noModels) }));
    list.scrollTop = top;
  };
  let drawn = 0;
  let shown = false;
  const drawEffort = async () => {
    const ticket = ++drawn;
    const pick = o.get();
    const levels = await levelsOf(pick);
    if (ticket !== drawn) return;
    clear(effort);
    effort.hidden = levels.length === 0;
    if (effort.hidden) return;
    const seg = h("div", { class: "pj-seg" });
    for (const e of levels) {
      const b = h("button", { class: pick.effort === e ? "on" : "", "data-effort": e, text: effortLabel(e) });
      b.addEventListener("click", () => {
        // A second click on the level on: back to the model's own.
        const now = o.get();
        o.set({ ...now, effort: now.effort === e ? "" : e });
        Sound.play("pop");
        void drawEffort();
      });
      seg.append(b);
    }
    effort.append(h("div", { class: "pj-effort-l" }, h("span", { text: t(S.effort) }), h("b", { text: effortLabel(o.get().effort) })), seg);
    o.placed();
  };
  effort.hidden = true;
  drawList();
  void drawEffort();
  for (const p of providers) {
    void modelsOf(p.id).then(
      (models) => got.set(p.id, models.length ? models : t(S.noModels)),
      (err) => got.set(p.id, String(err).replace(/^Error:\s*/, "")),
    ).then(() => {
      // Still open: the provider's models join the list, the model picked in sight.
      if (!o.open(menu)) return;
      drawList();
      if (!shown) {
        const on = list.querySelector<HTMLElement>(".pj-opt.on");
        if (on) {
          shown = true;
          // Where it sits in the list (the list is the menu's own scroller).
          const at = on.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
          list.scrollTop = Math.max(0, at - list.clientHeight / 2 + on.offsetHeight / 2);
        }
      }
    });
  }
  const search = searchBox(t(S.searchModels), (v) => {
    q = v;
    drawList();
  });
  const menu = h("div", { class: "pj-pop pj-pop-models" },
    h("label", { class: "pj-search" }, svg(SEARCH_LINE, 13, { stroke: 1.8 }), search),
    list, effort);
  return menu;
}
