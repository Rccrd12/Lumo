// The new look's home (Settings → Island → New look): one list, as on the
// concept's board, laid out wide rather than tall. On the left what waits for
// you and the sessions at work; on the right the live activities as small
// tiles and the other pills as a row of names; the field to the chat under
// it all. A session or a pill opens its card (the overview); a waiting
// request is answered here only by a click on N or Y, as on its own card.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { State, type AgentTask } from "../core/state";
import { sessionSubtitle } from "../core/pills";
import { lastTextStep } from "../core/diff";
import { ACTIVITIES_TEXT, eventWhen, type ActivitiesAction, type ActivitiesData } from "./activities-view";
import { N_, language, t, tl } from "../i18n/i18n";
import type { Decision } from "../core/bridge";

export const HOME_TEXT = {
  needsYou: N_("Needs you"),
};

/** What the home needs from the island. */
export interface HomeActions {
  openSession(id: string): void;
  openRequest(): void;
  decide(d: Decision, requestId: string): void;
  openChat(): void;
  openChatMenu(): void;
  activityData(): ActivitiesData;
  activity(a: ActivitiesAction): void;
  blip(): void;
}

/** How long a request that just came up ignores clicks on N and Y (views.ts CLICK_GUARD_MS). */
const CLICK_GUARD_MS = 600;
/** Rows shown before the list scrolls. */
const MAX_SESSIONS = 3;

// The home's measures, for its height (homeHeight) and look-new.css.
const TOP = 44;
const LABEL_H = 24;
const ROW_H = 54;
const ROW_GAP = 6;
const TILE_H = 82;
const CHIPS_H = 34;
const FIELD_H = 40;
const GAP = 12;
const BOTTOM = 12;

function tilesOf(data: ActivitiesData): ("timer" | "music" | "calendar" | "mail")[] {
  const tiles: ("timer" | "music" | "calendar" | "mail")[] = [];
  // Off in Settings, or put away with the "⋯" menu's Live Activities.
  if (State.settings.activitiesPanel === false || State.settings.activitiesFolded === true) return tiles;
  // The timer and the music always (a timer to start, what plays); the
  // calendar and the email once they are set up, empty or not.
  tiles.push("timer", "music");
  if (data.calendar.configured) tiles.push("calendar");
  if (data.mail.on) tiles.push("mail");
  return tiles;
}

/** The sessions the home lists, and the other pills it names (the email's is its tile, when shown). */
export function homeLists(active: (t: AgentTask) => boolean, data: ActivitiesData): { sessions: AgentTask[]; others: AgentTask[] } {
  const mailTile = tilesOf(data).includes("mail");
  return {
    sessions: State.tasks.filter(active),
    others: State.tasks.filter((x) => !active(x) && !(mailTile && x.id === "integration_mail")),
  };
}

/** The home's height for what it shows now: rows on the left, tiles on the right, the field under them. */
export function homeHeight(sessions: number, waiting: boolean, data: ActivitiesData, chips: number): number {
  const shown = Math.min(sessions, MAX_SESSIONS);
  let left = 0;
  if (waiting) left += LABEL_H + ROW_H;
  if (shown) left += (waiting ? GAP : 0) + LABEL_H + shown * ROW_H + (shown - 1) * ROW_GAP;
  if (!left) left = ROW_H;
  const tiles = tilesOf(data).length;
  // Three side by side in one row (look-new.css .three), else two to a row.
  const rows = tiles === 3 ? 1 : Math.ceil(tiles / 2);
  const right = tiles ? rows * TILE_H + (rows - 1) * 8 : 0;
  return TOP + Math.max(left, right) + (chips ? GAP + CHIPS_H : 0) + GAP + FIELD_H + BOTTOM;
}

export function buildHome(actions: HomeActions, active: (t: AgentTask) => boolean) {
  const left = h("div", { class: "home-left" });
  const right = h("div", { class: "home-right" });
  const tilesEl = h("div", { class: "home-tiles" });
  const chipsEl = h("div", { class: "home-chips" });
  right.append(tilesEl);
  const plus = h("span", {
    class: "ask-plus", role: "button", title: tl("Attach a file"),
    onclick: (e: Event) => {
      e.stopPropagation();
      actions.openChatMenu();
    },
  }, svg(ICONS.plus, 13, { stroke: 1.6 }));
  const field = h("button", { class: "ask-field home-field", onclick: () => actions.openChat() },
    plus, h("span", { class: "ph", text: tl("Ask me anything…") }));
  const el = h("div", { class: "view home" }, h("div", { class: "home-cols" }, left, right), chipsEl, field);

  let leftKey = "";
  let rightKey = "";
  let shownFor: string | null = null;
  let shownAt = 0;
  const timerEls: { el: HTMLElement; endsAt: number }[] = [];

  const guarded = (d: Decision) => () => {
    if (performance.now() - shownAt < CLICK_GUARD_MS || shownFor == null) return;
    actions.decide(d, shownFor);
  };

  function waitingCard(): HTMLElement | null {
    const req = State.pendingApproval;
    if (!req) return null;
    const task = State.tasks.find((x) => x.id === req.pillId) ?? null;
    const name = req.project ?? task?.name ?? "";
    const who = h("div", { class: "home-who" },
      task ? dot(task.color, 8) : null,
      h("span", { class: "n", text: name }),
      h("span", { class: "s", text: req.email ? t("wants to send an email") : req.questions ? t("is asking a question") : `· ${t(sessionSubtitle(req.pillId))}` }));
    const what = req.questions
      ? h("div", { class: "home-line", text: req.questions[0]?.question ?? "" })
      : h("div", { class: "home-line" }, h("code", { text: req.email ? req.email.subject : req.command || req.tool }));
    const ends: HTMLElement[] = [];
    // An email is read whole before it goes, and a question has options: their card opens.
    if (req.email || req.questions) {
      ends.push(h("button", { class: "home-btn acc", text: tl("Open"), onclick: () => actions.openRequest() }));
    } else {
      ends.push(
        h("button", { class: "home-btn", title: tl("Deny"), text: "N", onclick: guarded("deny") }),
        h("button", { class: "home-btn acc", title: tl("Allow"), text: "Y", onclick: guarded("allow") }),
      );
    }
    const row = h("div", { class: "home-row hot" }, h("div", { class: "home-text" }, who, what), ...ends);
    // A click on the words opens the whole card, with what it is for.
    row.addEventListener("click", (e) => {
      if (!(e.target as Element).closest("button")) actions.openRequest();
    });
    return row;
  }

  function sessionRow(task: AgentTask): HTMLElement {
    const done = task.state === "finished";
    const failed = task.state === "error";
    const step = done ? task.finalLine || lastTextStep(task.steps) : lastTextStep(task.steps);
    const line = done ? `${t("Done")}${step ? ` · ${step}` : ""}` : failed ? `${t("Error")}${step ? ` · ${step}` : ""}` : step ?? "";
    const count = task.steps.length > 1 && !done ? `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}` : "";
    return h("button", { class: "home-row", onclick: () => actions.openSession(task.id) },
      h("div", { class: "home-text" },
        h("div", { class: "home-who" },
          dot(task.color, 8),
          h("span", { class: "n", text: task.name }),
          // An agent's pill is named after it: no need to say it twice.
          t(sessionSubtitle(task.id)) !== task.name ? h("span", { class: "s", text: `· ${t(sessionSubtitle(task.id))}` }) : null),
        h("div", { class: `home-line${done ? " ok" : failed ? " err" : ""}`, text: line })),
      count ? h("span", { class: "home-count", text: count }) : null);
  }

  function label(text: string, n?: number): HTMLElement {
    return h("div", { class: "home-label" }, h("span", { text }), n != null ? h("span", { class: "c", text: String(n) }) : null);
  }

  function remaining(endsAt: number): string {
    const s = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
    const m = Math.floor(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`;
  }

  function tile(kind: "timer" | "music" | "calendar" | "mail", data: ActivitiesData): HTMLElement {
    switch (kind) {
      case "timer": {
        const timer = data.timers[0];
        // None running: three to start with a click.
        if (!timer) {
          const start = (minutes: number) => h("button", {
            class: "tile-chip", text: `${minutes}m`,
            onclick: () => actions.activity({ kind: "timer", ms: minutes * 60_000, label: "" }),
          });
          return h("div", { class: "home-tile" },
            h("div", { class: "tile-kick" }, svg(ICONS.clock, 12, { stroke: 1.8 }), h("span", { text: t(ACTIVITIES_TEXT.timer) })),
            h("div", { class: "tile-chips" }, start(5), start(10), start(25)));
        }
        const big = h("div", { class: "tile-big", text: remaining(timer.endsAt) });
        timerEls.push({ el: big, endsAt: timer.endsAt });
        return h("div", { class: "home-tile" },
          h("div", { class: "tile-kick" }, svg(ICONS.clock, 12, { stroke: 1.8 }), h("span", { text: timer.label || t(ACTIVITIES_TEXT.timer) })),
          big);
      }
      case "music": {
        const media = data.media;
        if (!media) {
          return h("div", { class: "home-tile" },
            h("div", { class: "tile-kick" }, svg(ICONS.play, 10), h("span", { text: t(ACTIVITIES_TEXT.music) })),
            h("div", { class: "tile-sub", text: t(ACTIVITIES_TEXT.nothingPlaying) }));
        }
        const ctl = (icon: string, title: string, action: "toggle" | "next") =>
          h("button", { class: "tile-ctl", title: t(title), onclick: () => actions.activity({ kind: "media", action }) }, svg(icon, 11));
        return h("div", { class: "home-tile" },
          h("div", { class: "tile-kick" }, dot("#22c55e", 6), h("span", { text: media.app || t(ACTIVITIES_TEXT.music) })),
          h("div", { class: "tile-title", text: media.title }),
          h("div", { class: "tile-ctls" },
            ctl(media.playing ? ICONS.pause : ICONS.play, media.playing ? ACTIVITIES_TEXT.pause : ACTIVITIES_TEXT.play, "toggle"),
            ctl(ICONS.forward, ACTIVITIES_TEXT.next, "next"),
            h("span", { class: "tile-sub", text: media.artist })));
      }
      case "calendar": {
        const [first, second] = data.calendar.events;
        const now = Date.now();
        if (!first) {
          return h("div", { class: "home-tile" },
            h("div", { class: "tile-kick" }, svg(ICONS.calendar, 12, { stroke: 1.8 }), h("span", { text: t(ACTIVITIES_TEXT.calendar) })),
            h("div", { class: "tile-sub", text: t(ACTIVITIES_TEXT.nothingSoon) }));
        }
        const tileEl = h("div", { class: "home-tile link" },
          h("div", { class: "tile-kick" }, svg(ICONS.calendar, 12, { stroke: 1.8 }),
            h("span", { text: first.allDay ? t(ACTIVITIES_TEXT.allDay) : eventWhen(first, now, language()) })),
          h("div", { class: "tile-title", text: first.title }),
          second ? h("div", { class: "tile-sub", text: `${second.title} · ${second.allDay ? t(ACTIVITIES_TEXT.allDay) : eventWhen(second, now, language())}` }) : null);
        if (data.calendar.link) tileEl.addEventListener("click", () => actions.activity({ kind: "calendarWeb" }));
        return tileEl;
      }
      case "mail": {
        const mail = data.mail.messages;
        if (!mail.length) {
          const quiet = h("div", { class: "home-tile link" },
            h("div", { class: "tile-kick" }, svg(ICONS.envelope, 12, { stroke: 1.8 }), h("span", { text: t(ACTIVITIES_TEXT.email) })),
            h("div", { class: "tile-sub", text: t(ACTIVITIES_TEXT.noUnread) }));
          quiet.addEventListener("click", () => actions.activity({ kind: "inbox" }));
          return quiet;
        }
        const tileEl = h("div", { class: "home-tile link" },
          h("div", { class: "tile-kick" }, dot("#f4505e", 6), h("span", { text: `${t(ACTIVITIES_TEXT.email)} · ${mail.length}` })),
          h("div", { class: "tile-title", text: mail[0].from }),
          h("div", { class: "tile-sub", text: mail[0].subject }));
        tileEl.addEventListener("click", () => actions.activity({ kind: "inbox" }));
        return tileEl;
      }
    }
  }

  return {
    el,
    tick(): boolean {
      for (const timer of timerEls) {
        const text = remaining(timer.endsAt);
        if (timer.el.textContent !== text) timer.el.textContent = text;
      }
      return false;
    },
    sync() {
      const req = State.pendingApproval;
      const id = req?.requestId ?? null;
      if (id !== shownFor) {
        shownFor = id;
        shownAt = performance.now();
      }
      const data = actions.activityData();
      const { sessions, others } = homeLists(active, data);

      // Rebuilt only when what they show changes: a rebuild between a mouse-down
      // and its mouse-up would swallow the click.
      const lk = [
        language(), id, req?.command, req?.questions?.[0]?.question, req?.email?.subject, State.approvalQueue.length,
        ...sessions.map((x) => `${x.id}:${x.name}:${x.color}:${x.state}:${x.stepIndex}:${x.steps.length}:${lastTextStep(x.steps)}:${x.finalLine ?? ""}`),
      ].join("~");
      if (lk !== leftKey) {
        leftKey = lk;
        clear(left);
        const waiting = waitingCard();
        if (waiting) left.append(label(t(HOME_TEXT.needsYou), 1 + State.approvalQueue.length), waiting);
        if (sessions.length) {
          left.append(label(t("In progress"), sessions.length),
            h("div", { class: "home-rows" }, ...sessions.map(sessionRow)));
        }
        if (!waiting && !sessions.length) {
          left.append(h("div", { class: "home-empty" },
            h("div", { class: "n", text: t("Nothing running right now.") }),
            h("div", { class: "s", text: t("Drop a file or window, or ask me anything.") })));
        }
      }

      const tiles = tilesOf(data);
      const rk = [
        language(), ...tiles,
        ...data.timers.map((x) => `${x.id}:${x.label}:${x.endsAt}`),
        data.media ? `${data.media.app}:${data.media.title}:${data.media.artist}:${data.media.playing}` : "",
        ...data.calendar.events.slice(0, 2).map((e) => `${e.title}:${e.start}`),
        ...data.mail.messages.slice(0, 1).map((m) => `${m.id}:${m.from}:${m.subject}`), data.mail.messages.length,
        ...others.map((x) => `${x.id}:${x.name}:${x.color}:${x.pillBadge ?? ""}`),
      ].join("~");
      if (rk !== rightKey) {
        rightKey = rk;
        clear(tilesEl);
        timerEls.length = 0;
        for (const kind of tiles) tilesEl.append(tile(kind, data));
        tilesEl.hidden = tiles.length === 0;
        right.classList.toggle("three", tiles.length === 3);
        clear(chipsEl);
        if (others.length) {
          // One line across the island, its name first, as on the board.
          chipsEl.append(h("span", { class: "home-chips-name", text: t("Services") }),
            h("div", { class: "home-chip-row" }, ...others.map((x) => {
              const chip = h("button", { class: "home-chip", onclick: () => actions.openSession(x.id) },
                dot(x.color, 7), h("span", { text: x.id === "integration_claude" ? "VS Code" : x.name }));
              if (x.pillBadge) chip.classList.add(`badge-${x.pillBadge}`);
              return chip;
            })));
        }
        chipsEl.hidden = others.length === 0;
        right.hidden = tiles.length === 0;
      }
    },
  };
}
