// The Gemini Live call (src/live): what is said, written as it is said, what
// Gemini is doing, the microphone, a field to type to it, and End. Before a
// call, a few words on what it can do and the button that starts it; after
// one that went wrong, why. Built from the chat's own pieces (bubbles, the
// typing dots, the bar), so it reads as the chat does.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { State } from "../core/state";
import { HOST_OS } from "../core/pills";
import { Live, helperName } from "../live/session";
import { liveModelName, parseLiveModel } from "../live/protocol";
import { LIVE_STRINGS as S } from "../live/strings";
import type { LiveLine } from "../live/transcript";
import { t, tl } from "../i18n/i18n";
import type { ViewHost } from "./views";

export { liveModelName };

function lineRow(line: LiveLine): { el: HTMLElement; text: HTMLElement } {
  if (line.role === "user") {
    const text = h("div", { class: "bubble" });
    return { el: h("div", { class: "chat-row user" }, text), text };
  }
  const text = h("div", { class: "md-p" });
  return { el: h("div", { class: "chat-row" }, h("div", { class: "reply" }, text)), text };
}

export function buildLive(openSettings: () => void): ViewHost {
  const title = h("span", { class: "live-title" });
  const status = h("span", { class: "live-status" });
  const bars = [0, 1, 2, 3, 4].map(() => h("i"));
  const meter = h("span", { class: "live-meter" }, ...bars);
  const head = h("div", { class: "live-head" }, h("i", { class: "model-dot live-dot" }), title, h("span", { class: "live-gap" }), meter, status);

  const log = h("div", { class: "chat-log live-log" });
  const intro = h("div", { class: "live-intro" });
  const problem = h("div", { class: "live-problem" });
  const doingLabel = h("span", { class: "typing-label" });
  const doing = h("div", { class: "typing live-doing" }, h("i"), h("i"), h("i"), doingLabel);

  const startBtn = h("button", { class: "btn primary" }, svg(ICONS.mic, 12, { stroke: 2 }), h("span", { text: tl(S.start) }));
  const settingsBtn = h("button", { class: "btn secondary" }, h("span", { text: tl(S.openSettings) }));
  const startRow = h("div", { class: "actions live-start" }, startBtn, settingsBtn);

  const muteBtn = h("button", { class: "tool-btn live-mute" });
  const input = h("input", { type: "text", class: "chat-input", placeholder: tl(S.typeHere), spellcheck: "false" }) as HTMLInputElement;
  const send = h("button", { class: "send-btn", title: tl(S.send), "aria-label": tl(S.send) }, svg(ICONS.arrowUp, 11));
  const endBtn = h("button", { class: "tool-btn live-end", title: tl(S.end), "aria-label": tl(S.end) }, svg(ICONS.phoneDown, 14));
  const bar = h("div", { class: "chat-bar live-bar" }, muteBtn, input, send, endBtn);

  const body = h("div", { class: "chat-body live-body" }, head, log, doing, startRow, bar);
  const el = h("div", { class: "view" }, h("div", { class: "card wash chat-card live-card" }, body));
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(34,211,238,0.38)");

  startBtn.addEventListener("click", () => void Live.start());
  settingsBtn.addEventListener("click", () => openSettings());
  muteBtn.addEventListener("click", () => Live.toggleMute());
  endBtn.addEventListener("click", () => Live.end());
  const sendTyped = () => {
    const text = input.value.trim();
    if (!text || !Live.active) return;
    Live.sendText(text);
    input.value = "";
  };
  send.addEventListener("click", sendTyped);
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      sendTyped();
    }
  });

  /** The rows on screen, one per line of the transcript. */
  let rows: { line: LiveLine; text: HTMLElement; shown: string }[] = [];

  function drawLog() {
    const lines = Live.transcript.lines;
    if (lines.length === 0) {
      if (rows.length || log.firstChild !== intro) {
        rows = [];
        clear(log);
        log.append(intro, problem);
      }
      return;
    }
    // The transcript only grows at its end (its oldest lines may go): rows
    // are added and the last ones refreshed, never all rebuilt.
    if (rows.length && rows[0].line !== lines[0]) rows = [];
    if (!rows.length) clear(log);
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    for (let i = 0; i < lines.length; i++) {
      let row = rows[i];
      if (!row || row.line !== lines[i]) {
        const made = lineRow(lines[i]);
        log.insertBefore(made.el, problem.parentNode === log ? problem : null);
        row = { line: lines[i], text: made.text, shown: "" };
        rows[i] = row;
      }
      const text = row.line.text.trim();
      if (row.shown !== text) {
        row.text.textContent = text;
        row.shown = text;
      }
    }
    // Why the call ended, under what was said.
    if (!Live.active && Live.problem) log.append(problem);
    else problem.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  function statusText(): string {
    switch (Live.phase) {
      case "connecting":
        return t(S.connecting);
      case "reconnecting":
        return t(S.reconnecting);
      case "speaking":
        return t(S.speaking);
      case "thinking":
        return t(S.thinking);
      case "listening":
        return Live.muted ? t(S.muted) : t(S.listening);
      default:
        return "";
    }
  }

  return {
    el,
    sync() {
      const model = Live.active ? Live.model : parseLiveModel(State.settings.liveModel);
      const name = liveModelName(model);
      if (title.textContent !== name) title.textContent = name;
      const helper = helperName(State.settings.liveHelper);
      const screen = State.settings.liveScreen && HOST_OS === "windows";
      intro.textContent = t(screen ? S.intro : S.introNoScreen, { helper });
      problem.textContent = Live.problem ?? "";
      problem.hidden = !Live.problem;

      const on = Live.active;
      body.classList.toggle("calling", on);
      status.textContent = statusText();
      meter.hidden = !(on && (Live.phase === "speaking" || (Live.phase === "listening" && !Live.muted)));
      startRow.hidden = on;
      settingsBtn.hidden = !Live.problemIsKey;
      bar.hidden = !on;
      muteBtn.classList.toggle("lit", Live.muted);
      clear(muteBtn);
      muteBtn.append(svg(Live.muted ? ICONS.micOff : ICONS.mic, 13, { stroke: 1.8 }));
      muteBtn.title = t(Live.muted ? S.unmute : S.mute);
      muteBtn.setAttribute("aria-label", muteBtn.title);
      input.disabled = !(on && Live.phase !== "connecting" && Live.phase !== "reconnecting");
      send.disabled = input.disabled;

      const label = Live.doing ?? (Live.phase === "thinking" ? t(S.thinking) : "");
      doing.hidden = !on || !label;
      // A line that says something is over has no dots going.
      doing.classList.toggle("done", Live.doingDone && label === Live.doing);
      if (doingLabel.textContent !== label) doingLabel.textContent = label;
      drawLog();
    },
    focus() {
      if (Live.active) input.focus();
      else startBtn.focus();
    },
    tick() {
      if (!Live.active || meter.hidden) return false;
      const level = Live.level;
      bars.forEach((b, i) => {
        // The middle bar moves most, the outer ones follow it.
        const shape = [0.55, 0.8, 1, 0.8, 0.55][i];
        b.style.transform = `scaleY(${(0.25 + Math.min(1, level * 1.6) * 0.75 * shape).toFixed(3)})`;
      });
      return true;
    },
  };
}

/** The settings button inside the island opens Settings on the Voice page. */
export function openVoiceSettings(setView: (v: "settings") => void) {
  try {
    window.localStorage.setItem("lumo.settings.page", "voice");
  } catch {
    // Settings open on the page they were on.
  }
  setView("settings");
}
