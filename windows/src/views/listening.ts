// The chat's Listening panel: everything Lumo is listening to (listen.rs),
// opened by the waves beside the folder (views/chat.ts), which stay grey
// while nothing listens and light up, with how many, while something does.
//
// Two lists, like the folder's: what listens now, each with Pause and Stop,
// and the history of what fired. "Listen for something" starts a watch by
// hand, for the chat on screen, as the chat's `[[listen …]]` line would: a
// pull request, the event, once or every time, and what Lumo should do then.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { Bridge } from "../core/bridge";
import { State } from "../core/state";
import {
  EVERY_UNTILS, LISTEN_UNTILS, UNTIL_TEXT, activeWatches, readPullRequest,
  type ListenMode, type ListenPast, type ListenUntil, type ListenWatch,
} from "../core/listen";
import { timeAgo } from "./integrations";
import { N_, t, tl } from "../i18n/i18n";

export const LISTENING_STRINGS = {
  title: N_("Listening"),
  active: N_("Active"),
  history: N_("History"),
  add: N_("Listen for something"),
  pauseAll: N_("Pause all"),
  resumeAll: N_("Resume all"),
  pause: N_("Pause"),
  resume: N_("Resume"),
  stop: N_("Stop listening"),
  clear: N_("Clear history"),
  once: N_("Once"),
  every: N_("Every time"),
  everyHint: N_("Again for each new commit, until the pull request is merged or closed"),
  paused: N_("Paused"),
  fired: N_("Times so far: {count}"),
  then: N_("Then:"),
  onlyTell: N_("Only tell me"),
  otherChat: N_("Another chat"),
  thisChat: N_("This chat"),
  since: N_("For {time}"),
  met: N_("Happened"),
  notMet: N_("Didn't happen"),
  emptyTitle: N_("Lumo isn't listening to anything"),
  emptyHint: N_("Ask in the chat, e.g. “tell me when pull request #12 is ready and merge it”, or start here."),
  noHistory: N_("Nothing has happened yet"),
  noHistoryHint: N_("What Lumo heard shows here, with what it did then."),
  target: N_("Pull request"),
  targetHint: N_("owner/repository#12 or its link"),
  when: N_("When"),
  how: N_("How often"),
  task: N_("What should Lumo do then?"),
  taskHint: N_("e.g. merge it. Leave it empty to only be told."),
  start: N_("Start listening"),
  cancel: N_("Cancel"),
  close: N_("Close"),
  notPr: N_("That isn't a pull request on GitHub: write owner/repository#number or paste its link."),
  failed: N_("Lumo couldn't start listening to it."),
  button: N_("Listening · {count}"),
  pick: N_("What should Lumo listen to?"),
  soon: N_("Coming soon"),
  edit: N_("Edit"),
  goToChat: N_("Go to the chat"),
  save: N_("Save"),
};

/** A source in the "Listen for something" menu: what it is and what it hears. */
interface Source {
  id: string;
  name: string;
  hint: string;
  icon: string;
  color: string;
  /** Lumo can listen to it already; the others say "Coming soon". */
  ready: boolean;
}

/** Every source the concept names, in its order: GitHub works, the rest come with the next versions. */
const SOURCES: Source[] = [
  { id: "github", name: N_("GitHub"), hint: N_("Pull requests: checks, approval, ready, merged"), icon: ICONS.pull, color: "#F4505E", ready: true },
  { id: "fs", name: N_("Files and folders"), hint: N_("New, changed or deleted files, downloads done"), icon: ICONS.folder, color: "#F5A524", ready: false },
  { id: "programs", name: N_("Programs and commands"), hint: N_("A program that ends, a command, a port that opens"), icon: ICONS.terminal, color: "#2DD4A7", ready: false },
  { id: "web", name: N_("Web pages"), hint: N_("A page or an API that changes, a site that goes down"), icon: ICONS.globe, color: "#60A5FA", ready: false },
  { id: "email", name: N_("Email"), hint: N_("Email from someone, with a subject, with attachments"), icon: ICONS.envelope, color: "#EA4335", ready: false },
  { id: "services", name: N_("Calendar and services"), hint: N_("Vercel, Stripe, n8n, Notion, Cal.com, events coming up"), icon: ICONS.calendar, color: "#C9956A", ready: false },
  { id: "windows", name: N_("Windows"), hint: N_("An app's notifications, battery, network, USB, when you're back"), icon: ICONS.display, color: "#F5F6F8", ready: false },
  { id: "agents", name: N_("Agents"), hint: N_("Claude Code or Codex finish, ask for a permission, fail"), icon: ICONS.code, color: "#D97757", ready: false },
  { id: "webhook", name: N_("Webhook"), hint: N_("A local address other programs can write to"), icon: ICONS.waves, color: "#7DD3FC", ready: false },
  { id: "custom", name: N_("Make a source"), hint: N_("In the tool workshop, for a listening of your own"), icon: ICONS.wrench, color: "#A78BFA", ready: false },
];

export interface ListeningPanel {
  el: HTMLElement;
  /** Draws what listens now (and the history, when on show). */
  draw(): void;
  /** Opening: the list of what listens now, the history asked again. */
  opened(): void;
}

/** GitHub's colour, for a pull request's tile. */
const PR_TILE = "#F4505E";

/** How long a watch has listened: "For 42m", or "just now". */
function listenedFor(at: number): string {
  return Date.now() - at < 60_000 ? t("just now") : t(LISTENING_STRINGS.since, { time: timeAgo(at) });
}

/** The source's tile: a pull request on GitHub, for now. */
function tile(): HTMLElement {
  const el = h("span", { class: "listen-tile" }, svg(ICONS.pull, 14, { stroke: 1.8 }));
  el.style.setProperty("--tile", PR_TILE);
  return el;
}

/** "Once" or "Every time", "Happened"…: a small label on the row's right. */
function pill(text: string, kind = ""): HTMLElement {
  return h("span", { class: kind ? `listen-pill ${kind}` : "listen-pill", text });
}

function empty(title: string, hint: string): HTMLElement {
  return h("div", { class: "files-empty" },
    h("span", { class: "files-empty-icon" }, svg(ICONS.waves, 16, { stroke: 1.6 })),
    h("div", { class: "files-empty-title", text: title }),
    h("div", { class: "files-empty-hint", text: hint }));
}

export function buildListeningPanel(opts: { goToChat: (chatId: string) => void; close: () => void }): ListeningPanel {
  let tab: "active" | "history" = "active";
  /** The lists, the sources' menu, or the form for a pull request. */
  let view: "list" | "catalog" | "form" = "list";
  /** The watch the form changes; null: a new one. */
  let editing: ListenWatch | null = null;
  /** The row whose Pause, Edit, Go to the chat and Stop are open. */
  let openRow: number | null = null;
  let past: ListenPast[] = [];

  const count = h("span", { class: "files-count" });
  const activeTab = h("button", { class: "listen-seg-btn on", text: tl(LISTENING_STRINGS.active) });
  const historyTab = h("button", { class: "listen-seg-btn", text: tl(LISTENING_STRINGS.history) });
  const pauseAllBtn = h("button", { class: "listen-head-btn" });
  const clearBtn = h("button", { class: "listen-head-btn", text: tl(LISTENING_STRINGS.clear) });
  const addBtn = h("button", { class: "listen-head-btn listen-add" },
    svg(ICONS.plus, 10), h("span", { text: tl(LISTENING_STRINGS.add) }));
  const activeList = h("div", { class: "picker-list listen-list" });
  const historyList = h("div", { class: "picker-list listen-list" });

  // ── Listen for something: the form ──────────────────────────────────────
  const targetInput = h("input", {
    type: "text", class: "history-search listen-input", spellcheck: "false",
    placeholder: tl(LISTENING_STRINGS.targetHint), "aria-label": tl(LISTENING_STRINGS.target),
  }) as HTMLInputElement;
  const taskInput = h("input", {
    type: "text", class: "history-search listen-input", spellcheck: "false",
    placeholder: tl(LISTENING_STRINGS.taskHint), "aria-label": tl(LISTENING_STRINGS.task), maxlength: "500",
  }) as HTMLInputElement;
  const untilChips = h("div", { class: "listen-chips" });
  const modeChips = h("div", { class: "listen-chips" });
  const formError = h("div", { class: "listen-error" });
  let until: ListenUntil = "ready";
  let mode: ListenMode = "once";
  const startBtn = h("button", { class: "listen-head-btn listen-add" });
  const cancelBtn = h("button", { class: "listen-head-btn", text: tl(LISTENING_STRINGS.cancel) });
  const form = h("div", { class: "listen-form" },
    h("label", { class: "listen-label", text: tl(LISTENING_STRINGS.target) }), targetInput,
    h("label", { class: "listen-label", text: tl(LISTENING_STRINGS.when) }), untilChips,
    h("label", { class: "listen-label", text: tl(LISTENING_STRINGS.how) }), modeChips,
    h("label", { class: "listen-label", text: tl(LISTENING_STRINGS.task) }), taskInput,
    formError,
    h("div", { class: "listen-form-buttons" }, cancelBtn, startBtn));

  function chip(label: string, on: boolean, onClick: () => void, title?: string): HTMLElement {
    return h("button", { class: on ? "picker-chip on" : "picker-chip", title, onclick: onClick }, label);
  }

  function drawChoices() {
    clear(untilChips);
    for (const u of LISTEN_UNTILS) untilChips.append(chip(t(UNTIL_TEXT[u]), u === until, () => {
      until = u;
      if (!EVERY_UNTILS.includes(u)) mode = "once";
      drawChoices();
    }));
    clear(modeChips);
    modeChips.append(chip(t(LISTENING_STRINGS.once), mode === "once", () => {
      mode = "once";
      drawChoices();
    }));
    // Every time only for what happens again with each push.
    if (EVERY_UNTILS.includes(until)) {
      modeChips.append(chip(t(LISTENING_STRINGS.every), mode === "every", () => {
        mode = "every";
        drawChoices();
      }, t(LISTENING_STRINGS.everyHint)));
    }
  }

  // ── Listen for something: the sources' menu ────────────────────────────
  const catalogGrid = h("div", { class: "listen-catalog-grid" });
  const catalogCancel = h("button", { class: "listen-head-btn", text: tl(LISTENING_STRINGS.cancel) });
  const catalog = h("div", { class: "listen-catalog" },
    h("div", { class: "listen-label listen-catalog-title", text: tl(LISTENING_STRINGS.pick) }),
    catalogGrid,
    h("div", { class: "listen-form-buttons" }, catalogCancel));

  function drawCatalog() {
    clear(catalogGrid);
    for (const source of SOURCES) {
      const icon = h("span", { class: "listen-tile" }, svg(source.icon, 14, { stroke: 1.8 }));
      icon.style.setProperty("--tile", source.color);
      const tileEl = h("button", { class: source.ready ? "listen-source" : "listen-source soon", disabled: !source.ready },
        h("span", { class: "listen-source-top" }, icon, source.ready ? null : h("span", { class: "listen-soon", text: t(LISTENING_STRINGS.soon) })),
        h("span", { class: "listen-source-name", text: t(source.name) }),
        h("span", { class: "listen-source-hint", text: t(source.hint) }));
      if (source.ready) tileEl.addEventListener("click", () => showForm(null));
      catalogGrid.append(tileEl);
    }
  }

  function showCatalog() {
    view = "catalog";
    tab = "active";
    openRow = null;
    drawCatalog();
    draw();
  }

  function showList() {
    view = "list";
    editing = null;
    draw();
  }

  /** The form, empty or with the watch it changes. */
  function showForm(watch: ListenWatch | null) {
    view = "form";
    editing = watch;
    tab = "active";
    formError.textContent = "";
    targetInput.value = watch ? `${watch.repo}#${watch.number}` : "";
    taskInput.value = watch?.task ?? "";
    until = watch?.until ?? "ready";
    mode = watch?.mode ?? "once";
    startBtn.textContent = t(watch ? LISTENING_STRINGS.save : LISTENING_STRINGS.start);
    drawChoices();
    draw();
    targetInput.focus();
  }

  async function start() {
    const pr = readPullRequest(targetInput.value);
    if (!pr) {
      formError.textContent = t(LISTENING_STRINGS.notPr);
      targetInput.focus();
      return;
    }
    // A change keeps the chat the watch answers to, and takes the old one's place.
    const chatId = editing?.chatId ?? State.chatId;
    const watch = await Bridge.listenAdd(pr.repo, pr.number, until, taskInput.value.trim(), chatId, mode);
    if (!watch) {
      formError.textContent = t(LISTENING_STRINGS.failed);
      return;
    }
    if (editing && editing.id !== watch.id) void Bridge.listenStop(editing.id);
    showList();
  }

  addBtn.addEventListener("click", () => showCatalog());
  catalogCancel.addEventListener("click", () => showList());
  cancelBtn.addEventListener("click", () => showList());
  startBtn.addEventListener("click", () => void start());
  for (const input of [targetInput, taskInput]) {
    input.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") void start();
      if ((e as KeyboardEvent).key === "Escape") showList();
    });
  }
  activeTab.addEventListener("click", () => {
    tab = "active";
    view = "list";
    draw();
  });
  historyTab.addEventListener("click", () => {
    tab = "history";
    view = "list";
    void loadHistory();
    draw();
  });
  pauseAllBtn.addEventListener("click", () => {
    const anyOn = activeWatches(State.listening).length > 0;
    void Bridge.listenPause(null, anyOn);
  });
  clearBtn.addEventListener("click", () => {
    past = [];
    void Bridge.listenHistoryClear();
    draw();
  });

  async function loadHistory() {
    const got = await Bridge.listenHistory();
    if (!got) return;
    past = got;
    if (tab === "history") draw();
  }

  // ── The rows ────────────────────────────────────────────────────────────

  /** A click, or Enter, on the row. */
  function onPress(row: HTMLElement, run: () => void) {
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.addEventListener("click", run);
    row.addEventListener("keydown", (e) => {
      const key = (e as KeyboardEvent).key;
      if (key === "Enter" || key === " ") {
        e.preventDefault();
        run();
      }
    });
  }

  /** A row: the source's tile, what it waits for and what then, its labels on the right. */
  function row(cls: string, title: string, name: string, detail: Node[], meta: Node[]): HTMLElement {
    return h("div", { class: `listen-row ${cls}`.trim(), title },
      tile(),
      h("span", { class: "listen-text" },
        h("span", { class: "listen-name", text: name }),
        h("span", { class: "listen-detail" }, ...detail)),
      h("span", { class: "listen-meta" }, ...meta));
  }

  /** Under an open row: Pause, Edit, Go to the chat, Stop. */
  function rowActions(w: ListenWatch): HTMLElement {
    // Pause, play, the bubble and × are filled; the pencil is a stroke.
    const act = (label: string, icon: SVGSVGElement, run: () => void, kind = "") =>
      h("button", { class: kind ? `listen-act-btn ${kind}` : "listen-act-btn", onclick: (e: Event) => {
        e.stopPropagation();
        run();
      } }, icon, h("span", { text: label }));
    return h("div", { class: "listen-row-acts" },
      w.paused
        ? act(t(LISTENING_STRINGS.resume), svg(ICONS.play, 9), () => void Bridge.listenPause(w.id, false))
        : act(t(LISTENING_STRINGS.pause), svg(ICONS.pause, 9), () => void Bridge.listenPause(w.id, true)),
      act(t(LISTENING_STRINGS.edit), svg(ICONS.pencil, 10, { stroke: 1.8 }), () => showForm(w)),
      w.chatId === State.chatId ? null : act(t(LISTENING_STRINGS.goToChat), svg(ICONS.bubble, 10), () => opts.goToChat(w.chatId)),
      act(t(LISTENING_STRINGS.stop), svg(ICONS.xmark, 9), () => {
        openRow = null;
        void Bridge.listenStop(w.id);
      }, "stop"));
  }

  /** "Then: merge it · This chat": what Lumo does then, in which chat. */
  function thenAndChat(task: string, chatId: string): Node[] {
    const then = task
      ? [document.createTextNode(`${t(LISTENING_STRINGS.then)} `), h("span", { class: "listen-task", text: task })]
      : [document.createTextNode(t(LISTENING_STRINGS.onlyTell))];
    const chat = chatId === State.chatId ? t(LISTENING_STRINGS.thisChat) : t(LISTENING_STRINGS.otherChat);
    return [...then, document.createTextNode(` · ${chat}`)];
  }

  function watchRow(w: ListenWatch): HTMLElement {
    const event = t(UNTIL_TEXT[w.until] ?? UNTIL_TEXT.merged);
    const every = w.mode === "every";
    const status = w.paused
      ? t(LISTENING_STRINGS.paused)
      : every && (w.fired ?? 0) > 0 ? t(LISTENING_STRINGS.fired, { count: w.fired ?? 0 }) : listenedFor(w.startedAt);
    const open = openRow === w.id;
    const el = row(`${w.paused ? "paused" : ""}${open ? " open" : ""}`, `${w.repo}#${w.number}`, `${w.repo}#${w.number} · ${event}`,
      thenAndChat(w.task, w.chatId),
      [pill(t(every ? LISTENING_STRINGS.every : LISTENING_STRINGS.once), every ? "every" : ""), h("span", { class: "listen-status", text: status })]);
    onPress(el, () => {
      openRow = open ? null : w.id;
      draw();
    });
    // The row and its buttons stay one block.
    return open ? h("div", { class: "listen-row-wrap open" }, el, rowActions(w)) : el;
  }

  function pastRow(p: ListenPast): HTMLElement {
    const w = p.watch;
    const el = row("past", p.summary, p.summary, thenAndChat(w.task, w.chatId),
      [pill(t(p.met ? LISTENING_STRINGS.met : LISTENING_STRINGS.notMet), p.met ? "met" : "not-met"),
        h("span", { class: "listen-status", text: Date.now() - p.at < 60_000 ? t("just now") : t("{time} ago", { time: timeAgo(p.at) }) })]);
    if (w.chatId !== State.chatId) onPress(el, () => opts.goToChat(w.chatId));
    return el;
  }

  function draw() {
    const watches = State.listening;
    const on = activeWatches(watches).length;
    count.textContent = watches.length > 0 ? String(watches.length) : "";
    activeTab.classList.toggle("on", tab === "active");
    historyTab.classList.toggle("on", tab === "history");
    pauseAllBtn.textContent = t(on > 0 ? LISTENING_STRINGS.pauseAll : LISTENING_STRINGS.resumeAll);
    const adding = view !== "list";
    pauseAllBtn.hidden = tab !== "active" || adding || watches.length === 0;
    clearBtn.hidden = tab !== "history" || past.length === 0;
    addBtn.hidden = tab !== "active" || adding;
    foot.hidden = adding || (tab === "history" && past.length === 0);
    form.hidden = view !== "form";
    catalog.hidden = view !== "catalog";
    activeList.hidden = tab !== "active" || adding;
    historyList.hidden = tab !== "history";

    if (tab === "active" && !adding) {
      clear(activeList);
      if (openRow != null && !watches.some((w) => w.id === openRow)) openRow = null;
      for (const w of watches) activeList.append(watchRow(w));
      if (watches.length === 0) activeList.append(empty(t(LISTENING_STRINGS.emptyTitle), t(LISTENING_STRINGS.emptyHint)));
    }
    if (tab === "history") {
      clear(historyList);
      // Newest first.
      for (const p of [...past].reverse()) historyList.append(pastRow(p));
      if (past.length === 0) historyList.append(empty(t(LISTENING_STRINGS.noHistory), t(LISTENING_STRINGS.noHistoryHint)));
    }
  }

  const foot = h("div", { class: "listen-foot" }, addBtn, pauseAllBtn, clearBtn);
  // The panel covers the whole chat, its waves too: × closes it.
  const closeBtn = h("button", { class: "listen-close", title: tl(LISTENING_STRINGS.close), "aria-label": tl(LISTENING_STRINGS.close) },
    svg(ICONS.xmark, 10));
  closeBtn.addEventListener("click", () => opts.close());
  const el = h("div", { class: "picker listen-panel" },
    h("div", { class: "listen-head" },
      h("span", { class: "listen-title", text: tl(LISTENING_STRINGS.title) }), count,
      h("span", { class: "listen-seg" }, activeTab, historyTab),
      closeBtn),
    activeList, historyList, catalog, form, foot);

  return {
    el,
    draw,
    opened() {
      void loadHistory();
      draw();
    },
  };
}

/** The waves' title: what they open, and how many listen. */
export function listeningButtonTitle(watches: ListenWatch[]): string {
  const on = activeWatches(watches).length;
  return on > 0 ? t(LISTENING_STRINGS.button, { count: on }) : t(LISTENING_STRINGS.title);
}
