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
  notPr: N_("That isn't a pull request on GitHub: write owner/repository#number or paste its link."),
  failed: N_("Lumo couldn't start listening to it."),
  button: N_("Listening · {count}"),
};

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

export function buildListeningPanel(opts: { goToChat: (chatId: string) => void }): ListeningPanel {
  let tab: "active" | "history" = "active";
  let adding = false;
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
  const startBtn = h("button", { class: "listen-head-btn listen-add", text: tl(LISTENING_STRINGS.start) });
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

  function showForm(on: boolean) {
    adding = on;
    formError.textContent = "";
    if (on) {
      targetInput.value = "";
      taskInput.value = "";
      until = "ready";
      mode = "once";
      drawChoices();
      tab = "active";
    }
    draw();
    if (on) targetInput.focus();
  }

  async function start() {
    const pr = readPullRequest(targetInput.value);
    if (!pr) {
      formError.textContent = t(LISTENING_STRINGS.notPr);
      targetInput.focus();
      return;
    }
    const watch = await Bridge.listenAdd(pr.repo, pr.number, until, taskInput.value.trim(), State.chatId, mode);
    if (!watch) {
      formError.textContent = t(LISTENING_STRINGS.failed);
      return;
    }
    showForm(false);
  }

  addBtn.addEventListener("click", () => showForm(!adding));
  cancelBtn.addEventListener("click", () => showForm(false));
  startBtn.addEventListener("click", () => void start());
  for (const input of [targetInput, taskInput]) {
    input.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") void start();
      if ((e as KeyboardEvent).key === "Escape") showForm(false);
    });
  }
  activeTab.addEventListener("click", () => {
    tab = "active";
    draw();
  });
  historyTab.addEventListener("click", () => {
    tab = "history";
    adding = false;
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

  function rowButton(icon: string, size: number, title: string, onClick: () => void): HTMLElement {
    const b = h("button", { class: "attach-remove listen-act", title, "aria-label": title }, svg(icon, size));
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  function opensChat(row: HTMLElement, chatId: string) {
    if (chatId === State.chatId) return;
    row.classList.add("elsewhere");
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.addEventListener("click", () => opts.goToChat(chatId));
    row.addEventListener("keydown", (e) => {
      const key = (e as KeyboardEvent).key;
      if (key === "Enter" || key === " ") {
        e.preventDefault();
        opts.goToChat(chatId);
      }
    });
  }

  /** A row: the source's tile, what it waits for and what then, its labels on the right. */
  function row(cls: string, title: string, name: string, detail: Node[], meta: Node[], acts: Node[] = []): HTMLElement {
    return h("div", { class: `listen-row ${cls}`.trim(), title },
      tile(),
      h("span", { class: "listen-text" },
        h("span", { class: "listen-name", text: name }),
        h("span", { class: "listen-detail" }, ...detail)),
      h("span", { class: "listen-meta" }, ...meta),
      acts.length ? h("span", { class: "listen-acts" }, ...acts) : null);
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
    const el = row(w.paused ? "paused" : "", `${w.repo}#${w.number}`, `${w.repo}#${w.number} · ${event}`,
      thenAndChat(w.task, w.chatId),
      [pill(t(every ? LISTENING_STRINGS.every : LISTENING_STRINGS.once), every ? "every" : ""), h("span", { class: "listen-status", text: status })],
      [
        w.paused
          ? rowButton(ICONS.play, 10, t(LISTENING_STRINGS.resume), () => void Bridge.listenPause(w.id, false))
          : rowButton(ICONS.pause, 10, t(LISTENING_STRINGS.pause), () => void Bridge.listenPause(w.id, true)),
        rowButton(ICONS.xmark, 10, t(LISTENING_STRINGS.stop), () => void Bridge.listenStop(w.id)),
      ]);
    opensChat(el, w.chatId);
    return el;
  }

  function pastRow(p: ListenPast): HTMLElement {
    const w = p.watch;
    const el = row("past", p.summary, p.summary, thenAndChat(w.task, w.chatId),
      [pill(t(p.met ? LISTENING_STRINGS.met : LISTENING_STRINGS.notMet), p.met ? "met" : "not-met"),
        h("span", { class: "listen-status", text: Date.now() - p.at < 60_000 ? t("just now") : t("{time} ago", { time: timeAgo(p.at) }) })]);
    opensChat(el, w.chatId);
    return el;
  }

  function draw() {
    const watches = State.listening;
    const on = activeWatches(watches).length;
    count.textContent = watches.length > 0 ? String(watches.length) : "";
    activeTab.classList.toggle("on", tab === "active");
    historyTab.classList.toggle("on", tab === "history");
    pauseAllBtn.textContent = t(on > 0 ? LISTENING_STRINGS.pauseAll : LISTENING_STRINGS.resumeAll);
    pauseAllBtn.hidden = tab !== "active" || adding || watches.length === 0;
    clearBtn.hidden = tab !== "history" || past.length === 0;
    addBtn.hidden = tab !== "active" || adding;
    foot.hidden = adding || (tab === "history" && past.length === 0);
    form.hidden = !adding;
    activeList.hidden = tab !== "active" || adding;
    historyList.hidden = tab !== "history";

    if (tab === "active" && !adding) {
      clear(activeList);
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
  const el = h("div", { class: "picker listen-panel" },
    h("div", { class: "listen-head" },
      h("span", { class: "listen-title", text: tl(LISTENING_STRINGS.title) }), count,
      h("span", { class: "listen-seg" }, activeTab, historyTab)),
    activeList, historyList, form, foot);

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
