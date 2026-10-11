// Chat view — DOM port of PromptView / ChatBubble / TypingDotsView /
// ModelPickerView from IslandViewContent.swift.
//
// Answers are rendered as Markdown (markdown.ts). A local model streams its
// answer: Rust sends `chat-delta` events with the text visible so far. The
// model name above the text field opens the picker: provider chips, then the
// models of the chosen provider, asked for only once it is picked.
//
// Until the text shows, a quiet line next to the typing dots says what the
// answer is doing: Claude Code's tool calls as it makes them (`chat-activity`
// events, claude_code.rs), and comes back when it returns to its tools after
// some text; for the other providers, the screenshots or the file that ride
// along for a moment, then Thinking….
//
// While an answer is written the send button is a Stop button (Escape in the
// field too): what was written stays, marked stopped. The field stays open
// meanwhile; Enter sends once the answer is done. Each message has Copy under
// the mouse, each question Edit: sending the edited text replaces it and drops
// what followed, here and in Rust (chat.rs rewind).
//
// The screen button next to the paperclip adds what is on the user's screen,
// only when they ask: "Open windows" or "Browser tabs" (Edge, Chrome), which
// list them to pick one or all, each going with what it shows (share.rs); a
// screenshot of one display or all of them, shown first with Send / Cancel
// (core/screen.ts); or the folder open in File Explorer: its listing goes with
// the question, and a file of it the question names is attached as if picked
// with the paperclip.
//
// With Settings → Chat → "Show remaining usage in the chat" on, a small ring
// next to the model button fills with what the provider has used — the most
// used of its limits, in the plan's colours — and opens a menu with each limit,
// its bar and when it resets (core/chat-usage.ts).
//
// With "Always share the folder open in File Explorer" on (Settings → Chat),
// that folder goes with every message by itself; its chip's × leaves it out
// of one.
//
// Ctrl+V in the text field attaches an image or a file copied in File
// Explorer the same way as the paperclip; text pastes as usual (core/paste.ts).

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { copyButton, renderMarkdown } from "./markdown";
import {
  Bridge, onEvent, type BrowserTab, type ChatActivity, type ChatContext, type ExplorerFolder, type ModelInfo,
  type OpenWindow, type ScreenContext, type ScreenDisplay, type ScreenShot,
} from "../core/bridge";
import {
  PERMISSION_MODES, activeModel, effortFor, effortsFor, isCliProvider, parsePermissionMode, pickModel, providerDef,
  anyProviderReady, visibleProviders, withModel, type PermissionMode, type ProviderDef,
} from "../core/providers";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import { chatTitle, deleteChat, loadChats, saveChat, searchChats, type ChatHit, type SavedChat } from "../core/chats";
import { planColor } from "../core/plan";
import { refreshClaudePlanOnline } from "./usage";
import { OPENROUTER_STALE_MS, USAGE_TEXT, usageLine, type ChatUsage, type SeenUsage, type UsageLine } from "../core/chat-usage";
import {
  SCREEN_STRINGS, emptyScreen, entryLabel, keepShots, menuEntries, nextScreen, screenChips, screenLabel,
  screenPayload, seesImages, sharesFolderByItself, short, shotPaths, tabPicks, windowPicks, withTabs, withWindows,
  withoutFolder, type ChipKind, type ExplorerPeek, type MenuEntry, type PickEntry,
} from "../core/screen";
import { MAX_PASTE_BYTES, PASTE_STRINGS, pasteAction, pastedFiles, pastedName } from "../core/paste";
import { COMPUTER_TEXT } from "../core/computer";
import type { ViewHost } from "./views";
import { N_, t, tl } from "../i18n/i18n";
import { LIVE_STRINGS } from "../live/strings";
import { COMPACT_TEXT, compactNotice, compactTimer, parseDuration, speakerName, takeTimers } from "../core/compact";

const STRINGS = {
  placeholderFirst: N_("Ask me anything…"),
  placeholderNext: N_("Continue…"),
  send: N_("Send"),
  switchModel: N_("Switch provider or model"),
  noModel: N_("Choose a model"),
  loading: N_("Loading models…"),
  noKey: N_("No API key — add it in Settings."),
  noProvider: N_("No provider is set up yet: add a key, or install Claude Code's or Antigravity's hooks, in Settings."),
  openSettings: N_("Open Settings"),
  newChat: N_("New chat"),
  pastChats: N_("Past chats"),
  noPastChats: N_("No past chats yet."),
  searchChats: N_("Search the past chats"),
  noMatch: N_("No chat says that."),
  deleteChat: N_("Delete this chat"),
  attach: N_("Attach a file"),
  cancel: N_("Cancel"),
  effort: N_("Effort"),
  effortAuto: N_("Auto"),
  recommended: N_("Recommended"),
  autoHint: N_("Auto: Claude Code picks the effort its model is made for."),
  permissions: N_("Permissions"),
  welcome: N_("What can I do for you?"),
  askFile: N_("Ask about a file"),
  lookScreen: N_("Look at my screen"),
  writeMessage: N_("Write a message"),
  writeMessageStart: N_("Help me write a message to "),
  stop: N_("Stop"),
  stopped: N_("Stopped"),
  edit: N_("Edit"),
  editing: N_("Editing a message"),
  editingHint: N_("Sending replaces this message and everything after it."),
};

/** The effort levels by name, "Auto" for the CLI's own default. */
const EFFORT_NAMES: Record<string, string> = {
  low: N_("Low"),
  medium: N_("Medium"),
  high: N_("High"),
  xhigh: N_("Extra high"),
  max: N_("Max"),
};

/** Each permission mode: its name and what it lets through. */
const PERMISSION_TEXT: Record<PermissionMode, { name: string; note: string }> = {
  default: { name: N_("Ask every time"), note: N_("Asks before each action that needs a permission.") },
  auto: { name: N_("Auto"), note: N_("The AI decides what is safe to do without asking, and asks for the rest.") },
  plan: { name: N_("Plan only"), note: N_("Reads and plans, and changes nothing.") },
};

/** What the effort says, in the interface language. */
function effortLabel(effort: string): string {
  return effort ? t(EFFORT_NAMES[effort] ?? effort) : t(STRINGS.effortAuto);
}

let nextId = 1;

/** The folder open in File Explorer is asked again at most this often while the field takes focus. */
const PEEK_EVERY_MS = 1500;
/**
 * The screen menu waits at most this long for the browsers' tabs (read from
 * their windows on Windows); a slow browser adds its entry when it answers.
 */
const TABS_WAIT_MS = 1200;

/** How a message is drawn: `onEdit` puts a question back in the text field. */
interface BubbleOptions {
  onEdit?: (message: ChatMessage) => void;
  /** The question being edited, and what sending it would drop. */
  editing?: boolean;
  dropped?: boolean;
}

/**
 * One message. Its Copy (and, on a question, Edit) buttons show under the
 * mouse; Copy takes the text as it was written, Markdown included.
 */
function bubble(message: ChatMessage, opts: BubbleOptions = {}): HTMLElement {
  const actions = h("div", { class: "msg-actions" }, copyButton(message.content, "msg-action"));
  const state = opts.editing ? " editing" : opts.dropped ? " dropped" : "";
  if (message.role === "user") {
    if (opts.onEdit) {
      const onEdit = opts.onEdit;
      const edit = h("button", { class: "msg-action", title: tl(STRINGS.edit), "aria-label": tl(STRINGS.edit) }, svg(ICONS.pencil, 11, { stroke: 1.8 }));
      edit.addEventListener("click", (e) => {
        e.stopPropagation();
        onEdit(message);
      });
      actions.append(edit);
    }
    return h(
      "div",
      { class: `chat-row user with-actions${state}` },
      actions,
      h("div", { class: "bubble", text: message.content }),
    );
  }
  const reply = h("div", { class: "reply" });
  renderMarkdown(reply, message.content);
  // A stopped answer says so on a line of its own, Copy beside it; otherwise
  // Copy floats over the answer's bottom right corner and takes no room.
  const foot = message.stopped
    ? h("div", { class: "reply-foot" }, h("span", { class: "msg-stopped", text: tl(STRINGS.stopped) }), actions)
    : h("div", { class: "reply-foot floating" }, actions);
  return h("div", { class: `chat-row${state}` }, h("div", { class: "reply-wrap" }, reply, foot));
}

/** What the line next to the typing dots says (claude_code.rs Activity). */
const ACTIVITY_STRINGS = {
  thinking: N_("Thinking…"),
  reading: N_("Reading {name}"),
  readingFile: N_("Reading a file"),
  searchingFor: N_("Searching for {pattern}"),
  searchingFolder: N_("Searching the folder"),
  command: N_("Running a command"),
  editing: N_("Editing {name}"),
  editingFile: N_("Editing a file"),
  web: N_("Searching the web"),
  subtask: N_("Working on a sub-task"),
  plan: N_("Planning"),
  screen: N_("Looking at the screen"),
  computer: COMPUTER_TEXT.using,
  tool: N_("Using {tool}"),
};

const THINKING: ChatActivity = { kind: "thinking", detail: "" };

/** A provider that streams no tools shows the screenshots or the file this long, then Thinking…. */
const FIRST_ACTIVITY_MS = 1200;

/** How long Lumo shows that an answer came (his hop) or went wrong (his shake). */
export const SETTLE_MS = 2000;

/**
 * The answer is over: Lumo shows how it went for a moment, then goes back to
 * what he showed before. A newer answer or anything else that took over is
 * left alone.
 */
let settled = 0;
export function settle(state: "finished" | "error" | null) {
  State.stateOverride = state;
  const mine = ++settled;
  if (state == null) return;
  setTimeout(() => {
    if (mine !== settled || State.stateOverride !== state) return;
    State.stateOverride = null;
    State.notify();
  }, SETTLE_MS);
}

/** Who answers in the chat, short ("Haiku", "Claude Code", "gpt-4o"), in its colour. */
export function chatSpeaker(): { who: string; color: string } {
  const p = providerDef(State.settings.chatProvider);
  return { who: speakerName(p.id, t(p.name), activeModel(State.settings)), color: p.accent };
}

/** Says on the closed island how the answer went, unless the chat is on screen. */
function noticeAway(text: string) {
  if (State.mode === "expanded" && State.view === "prompt") return;
  const { who, color } = chatSpeaker();
  compactNotice(t(text, { helper: who }), color);
}

/** The words for what the answer is doing; anything unknown is Thinking…. */
export function activityLabel(activity: ChatActivity | null): string {
  const detail = (activity?.detail ?? "").trim();
  switch (activity?.kind) {
    case "read":
      return detail ? t(ACTIVITY_STRINGS.reading, { name: detail }) : t(ACTIVITY_STRINGS.readingFile);
    case "search":
      return detail ? t(ACTIVITY_STRINGS.searchingFor, { pattern: detail }) : t(ACTIVITY_STRINGS.searchingFolder);
    case "command":
      return t(ACTIVITY_STRINGS.command);
    case "edit":
      return detail ? t(ACTIVITY_STRINGS.editing, { name: detail }) : t(ACTIVITY_STRINGS.editingFile);
    case "web":
      return t(ACTIVITY_STRINGS.web);
    case "subtask":
      return t(ACTIVITY_STRINGS.subtask);
    case "plan":
      return t(ACTIVITY_STRINGS.plan);
    case "screen":
      return t(ACTIVITY_STRINGS.screen);
    case "computer":
      return t(ACTIVITY_STRINGS.computer);
    case "tool":
      return detail ? t(ACTIVITY_STRINGS.tool, { tool: detail }) : t(ACTIVITY_STRINGS.thinking);
    default:
      return t(ACTIVITY_STRINGS.thinking);
  }
}

/**
 * What the answer is shown doing first. The CLIs (Claude Code, Antigravity
 * CLI) say for themselves as they go (`chat-activity`); the other providers stream no tools, so the
 * screenshots or the file that ride along show first, then Thinking….
 */
export function firstActivity(provider: string, context: ChatContext | null, screen: ScreenContext | null): ChatActivity {
  if (!isCliProvider(provider)) {
    if (screen?.shots.length) return { kind: "screen", detail: "" };
    if (context?.kind === "file") return { kind: "read", detail: context.name };
  }
  return THINKING;
}

/** The dots while an answer is written, and what it is doing next to them. */
function typingDots(label: string): HTMLElement {
  return h(
    "div",
    { class: "chat-row" },
    h("div", { class: "typing" }, h("i"), h("i"), h("i")),
    h("span", { class: "typing-label", text: label }),
  );
}

/**
 * A chip for what goes with the question (a dropped or pasted file, what the
 * screen button added), with a way to take it back before it is sent.
 */
function screenChip(label: string, title: string, onRemove: () => void, thumbs?: string[]): HTMLElement {
  const remove = h("button", { class: "chip-remove", title: tl(SCREEN_STRINGS.remove) }, svg(ICONS.xmark, 8));
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    onRemove();
  });
  // Screenshots show themselves, small, so it is clear what goes with the question.
  const strip = thumbs && thumbs.length > 0
    ? h("span", { class: "chip-thumbs" }, ...thumbs.map((src) => h("img", { class: "chip-thumb", src, alt: "" })))
    : null;
  const chip = h(
    "div",
    { class: "chip screen-chip", title },
    h("i", { class: "chip-dot" }),
    h("span", { text: label }),
    strip,
    remove,
  );
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

function saveSettings() {
  void Bridge.saveSettings(State.settings);
}

// ── Model picker ──────────────────────────────────────────────────────────────

interface Picker {
  el: HTMLElement;
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

/**
 * The providers set up on this computer (lib.rs chat_providers), asked each
 * time the picker opens; null until the first answer, or with no Rust to ask.
 */
let readyProviders: ReadonlySet<string> | null = null;

/** Provider chips, then the chosen provider's models — ModelPickerView. */
function buildPicker(onChange: () => void, openSettings: () => void): Picker {
  const chips = h("div", { class: "picker-chips" });
  const list = h("div", { class: "picker-list" });
  // Claude Code only: how hard it thinks (claude --effort), on a short slider
  // with the level it is on beside it, and Auto (its model's own level) above.
  const efforts = h("div", { class: "picker-efforts" });
  const el = h("div", { class: "picker models" }, chips, h("div", { class: "picker-rule" }), list, efforts);
  // Asked once ahead, so the first opening already shows the right chips.
  void Bridge.chatProviders().then((ids) => {
    if (Array.isArray(ids)) readyProviders = new Set(ids);
  });

  function drawEfforts() {
    clear(efforts);
    const p = providerDef(State.settings.chatProvider);
    const levels = effortsFor(p.id).filter((e) => e !== "");
    efforts.hidden = levels.length === 0;
    if (efforts.hidden) return;
    const last = levels.length - 1;

    const auto = h(
      "button",
      { class: "effort-auto", title: t(STRINGS.autoHint), style: `--accent:${p.accent}` },
      h("span", { text: t(STRINGS.effortAuto) }),
      h("span", { class: "effort-auto-note", text: t(STRINGS.recommended) }),
    );
    const value = h("span", { class: "effort-value" });
    // A track that fills up to the knob, with a mark for each level. Dragged,
    // the knob goes to the nearest level as soon as the pointer is past half
    // the way to it, with an ease; let go, that level is picked. On Auto there
    // is no knob: a click picks a level.
    const fill = h("i", { class: "effort-fill" });
    const knob = h("i", { class: "effort-knob" });
    const ticks = h("div", { class: "effort-ticks" }, ...levels.map(() => h("i")));
    const track = h("div", {
      class: "effort-track effort-slider",
      role: "slider",
      tabindex: "0",
      "aria-label": t(STRINGS.effort),
      "aria-valuemin": "0",
      "aria-valuemax": String(last),
      style: `--accent:${p.accent}`,
    }, ticks, fill, knob);

    /** Where the knob is, 0–1 along the track. */
    const place = (frac: number) => {
      const f = Math.max(0, Math.min(1, frac));
      track.style.setProperty("--at", String(f));
    };
    /** Draws the saved level (or Auto) without saving anything. */
    const show = () => {
      const current = effortFor(p.id, State.settings.chatEffort);
      const index = levels.indexOf(current);
      auto.classList.toggle("on", !current);
      track.classList.toggle("auto", !current);
      track.setAttribute("aria-valuenow", String(Math.max(0, index)));
      track.setAttribute("aria-valuetext", effortLabel(current));
      value.textContent = effortLabel(current);
      place(index < 0 ? 0 : index / last);
    };
    const pick = (e: string) => {
      show();
      if (e === effortFor(p.id, State.settings.chatEffort)) return;
      State.settings = { ...State.settings, chatEffort: e };
      saveSettings();
      Sound.play("blip");
      show();
      onChange();
    };
    auto.addEventListener("click", () => pick(""));

    const fracAt = (clientX: number) => {
      const r = track.getBoundingClientRect();
      // The knob's centre stays inside the track by half its width.
      const inset = 11;
      return r.width > 2 * inset ? (clientX - r.left - inset) / (r.width - 2 * inset) : 0;
    };
    track.addEventListener("pointerdown", (e) => {
      const pe = e as PointerEvent;
      if (pe.button !== 0) return;
      pe.preventDefault();
      track.focus();
      track.setPointerCapture?.(pe.pointerId);
      track.classList.add("dragging");
      track.classList.remove("auto");
      // Past half the way to the next level, the knob is on it already: it
      // moves from level to level as it is dragged, each step eased.
      let shown = -1;
      const follow = (x: number) => {
        const index = Math.round(Math.max(0, Math.min(1, fracAt(x))) * last);
        if (index === shown) return;
        shown = index;
        place(index / last);
        value.textContent = effortLabel(levels[index]);
      };
      follow(pe.clientX);
      const move = (m: Event) => follow((m as PointerEvent).clientX);
      const up = (u: Event) => {
        track.removeEventListener("pointermove", move);
        track.removeEventListener("pointerup", up);
        track.removeEventListener("pointercancel", up);
        track.classList.remove("dragging");
        // Settles on the nearest level, with the ease of the knob's transition.
        const index = Math.round(Math.max(0, Math.min(1, fracAt((u as PointerEvent).clientX))) * last);
        pick(levels[index]);
      };
      track.addEventListener("pointermove", move);
      track.addEventListener("pointerup", up);
      track.addEventListener("pointercancel", up);
    });
    track.addEventListener("keydown", (e) => {
      const key = (e as KeyboardEvent).key;
      const current = levels.indexOf(effortFor(p.id, State.settings.chatEffort));
      const to = key === "ArrowRight" || key === "ArrowUp" ? Math.min(last, current + 1)
        : key === "ArrowLeft" || key === "ArrowDown" ? Math.max(0, current < 0 ? 0 : current - 1)
        : key === "Home" ? 0 : key === "End" ? last : null;
      if (to == null) return;
      e.preventDefault();
      e.stopPropagation();
      pick(levels[to]);
    });

    // One short row, so the model list keeps its room: the slider, the level
    // it is on, and Auto at the end.
    efforts.append(h("div", { class: "effort-row" }, track, value, auto));
    show();
  }

  /** Models already asked for, by provider; a model server is asked again each time. */
  const cache = new Map<string, ModelInfo[]>();
  let isOpen = false;
  let request = 0;

  function drawChips() {
    clear(chips);
    for (const p of visibleProviders(State.settings, readyProviders)) {
      const on = p.id === State.settings.chatProvider;
      const chip = h(
        "button",
        { class: on ? "picker-chip on" : "picker-chip", style: `--accent:${p.accent}` },
        h("i", { class: "picker-dot" }),
        h("span", { text: t(p.name) }),
      );
      chip.addEventListener("click", () => {
        if (p.id === State.settings.chatProvider) return;
        State.settings = { ...State.settings, chatProvider: p.id };
        saveSettings();
        Sound.play("pop");
        drawChips();
        drawEfforts();
        void loadModels();
        onChange();
      });
      chips.append(chip);
    }
  }

  function status(text: string, withSettings = false) {
    clear(list);
    const line = h("div", { class: "picker-status", text });
    if (withSettings) {
      line.append(
        h("button", {
          class: "picker-link",
          text: tl(STRINGS.openSettings),
          onclick: () => openSettings(),
        }),
      );
    }
    list.append(line);
  }

  function drawModels(p: ProviderDef, models: ModelInfo[]) {
    clear(list);
    const current = activeModel(State.settings);
    for (const m of models) {
      const on = m.id === current;
      const row = h(
        "button",
        { class: on ? "picker-model on" : "picker-model", style: `--accent:${p.accent}`, title: m.id },
        h("span", { class: "picker-model-name", text: m.label }),
        on ? svg(ICONS.check, 11, { stroke: 2.2 }) : null,
      );
      row.addEventListener("click", () => {
        State.settings = withModel(State.settings, p.id, m.id);
        saveSettings();
        Sound.play("blip");
        close();
      });
      list.append(row);
    }
    list.querySelector(".picker-model.on")?.scrollIntoView({ block: "nearest" });
  }

  async function loadModels() {
    const p = providerDef(State.settings.chatProvider);
    const ticket = ++request;
    const cached = p.urlField ? undefined : cache.get(p.id);
    if (cached) {
      drawModels(p, cached);
      return;
    }
    // Nothing is asked of a provider that has no key yet.
    if (p.key && !(await Bridge.secretPresent(p.key))) {
      if (ticket === request) status(t(STRINGS.noKey), true);
      return;
    }
    if (ticket !== request) return;
    status(t(STRINGS.loading));
    try {
      const models = await Bridge.chatModels(p.id);
      if (ticket !== request) return;
      if (!p.urlField) cache.set(p.id, models);
      const keep = pickModel(p, models.map((m) => m.id), activeModel(State.settings));
      if (keep && keep !== activeModel(State.settings)) {
        State.settings = withModel(State.settings, p.id, keep);
        saveSettings();
        onChange();
      }
      drawModels(p, models);
    } catch (err) {
      if (ticket === request) status(String(err).replace(/^Error:\s*/, ""), Boolean(p.key));
    }
  }

  /** Nothing set up at all: a pointer to Settings in place of chips and models. */
  function drawNothingReady(): boolean {
    const none = readyProviders != null && !anyProviderReady(State.settings, readyProviders);
    el.classList.toggle("empty", none);
    if (none) {
      clear(chips);
      status(t(STRINGS.noProvider), true);
      efforts.hidden = true;
    }
    return none;
  }

  function open() {
    isOpen = true;
    el.classList.add("on");
    drawChips();
    drawEfforts();
    onChange();
    if (!drawNothingReady()) void loadModels();
    // Which are set up may have changed in Settings since: asked again each time.
    void Bridge.chatProviders().then((ids) => {
      const key = (set: ReadonlySet<string> | null) => (set ? [...set].sort().join() : null);
      const before = key(readyProviders);
      // No answer (no Rust to ask): every provider shows, as before.
      readyProviders = Array.isArray(ids) ? new Set(ids) : null;
      if (!isOpen || before === key(readyProviders)) return;
      drawChips();
      if (!drawNothingReady()) {
        drawEfforts();
        void loadModels();
      }
    });
  }

  function close() {
    isOpen = false;
    request++;
    el.classList.remove("on");
    onChange();
  }

  return {
    el,
    open,
    close,
    get isOpen() {
      return isOpen;
    },
  };
}

// ── Usage ring ────────────────────────────────────────────────────────────────

/**
 * A ring that fills clockwise from the top as a limit is used, in its colour,
 * like a spinner standing still. It moves to a new value in a short ease.
 */
function usageRingSvg(): { el: SVGSVGElement; set(pct: number | null, color: string | null): void } {
  const NS = "http://www.w3.org/2000/svg";
  const R = 5.25;
  const LEN = 2 * Math.PI * R;
  const el = document.createElementNS(NS, "svg");
  el.setAttribute("viewBox", "0 0 14 14");
  el.setAttribute("width", "14");
  el.setAttribute("height", "14");
  el.setAttribute("aria-hidden", "true");
  el.classList.add("usage-ring");
  const circle = (cls: string) => {
    const c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", "7");
    c.setAttribute("cy", "7");
    c.setAttribute("r", String(R));
    c.classList.add(cls);
    return c;
  };
  const track = circle("usage-ring-track");
  const arc = circle("usage-ring-arc");
  arc.setAttribute("stroke-dasharray", `${LEN} ${LEN}`);
  arc.setAttribute("stroke-dashoffset", String(LEN));
  el.append(track, arc);
  return {
    el,
    set(pct, color) {
      const used = pct == null ? 0 : Math.max(0, Math.min(100, pct));
      // A sliver even at 0 %, so a known plan never looks like an empty ring.
      const shown = pct == null ? 0 : Math.max(used, 4);
      arc.setAttribute("stroke-dashoffset", String(LEN * (1 - shown / 100)));
      arc.style.stroke = color ?? "";
      el.classList.toggle("unknown", pct == null);
    },
  };
}

// ── View ──────────────────────────────────────────────────────────────────────

/** `openSettings`: the island's Settings view (the window where there is no island, as in tests). */
export function buildPrompt(
  onHeightChange: () => void,
  openSettings: () => void = () => void Bridge.openSettingsWindow(),
  talk: () => void = () => {},
): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  // A text area of one line that grows with what is typed (up to a few lines,
  // then it scrolls): Enter sends, Shift+Enter starts a new line.
  const input = h("textarea", {
    class: "chat-input",
    rows: "1",
    placeholder: t(STRINGS.placeholderFirst),
    spellcheck: "false",
  }) as HTMLTextAreaElement;
  /** As tall as its lines, up to the CSS max-height. */
  function fitInput() {
    input.style.height = "auto";
    if (input.scrollHeight > 0) input.style.height = `${input.scrollHeight}px`;
  }
  function setInput(text: string) {
    input.value = text;
    fitInput();
  }
  input.addEventListener("input", fitInput);
  const send = h("button", { class: "send-btn", title: tl(STRINGS.send) }, svg(ICONS.arrowUp, 11));
  const attachBtn = h("button", { class: "tool-btn", title: tl(STRINGS.attach) }, svg(ICONS.paperclip, 13, { stroke: 1.8 }));
  const screenBtn = h("button", { class: "tool-btn screen-btn", title: tl(SCREEN_STRINGS.button) }, svg(ICONS.display, 13, { stroke: 1.8 }));
  // Claude Code and Antigravity CLI only: what they may do without asking.
  const permBtn = h("button", { class: "tool-btn perm-btn" }, svg(ICONS.shield, 13, { stroke: 1.8 }));
  // Gemini Live: a spoken call instead of a typed chat (views/live.ts); lit while one is on.
  const micBtn = h("button", { class: "tool-btn mic-btn", title: tl(LIVE_STRINGS.talk), "aria-label": tl(LIVE_STRINGS.talk) }, svg(ICONS.mic, 13, { stroke: 1.8 }));
  micBtn.addEventListener("click", () => talk());
  const bar = h("div", { class: "chat-bar" }, attachBtn, screenBtn, permBtn, input, micBtn, send);

  const modelDot = h("i", { class: "model-dot" });
  const modelName = h("span", { class: "model-name" });
  const modelBtn = h(
    "button",
    { class: "model-btn", title: tl(STRINGS.switchModel) },
    modelDot,
    modelName,
    svg(ICONS.chevronUpDown, 9, { stroke: 2 }),
  );
  const newBtn = h("button", { class: "tool-btn", title: tl(STRINGS.newChat) }, svg(ICONS.plus, 12));
  const historyBtn = h("button", { class: "tool-btn", title: tl(STRINGS.pastChats) }, svg(ICONS.clock, 13, { stroke: 1.8 }));
  // What the provider has used, when the option is on and it is known: a ring
  // that fills, and its menu.
  const usageRing = usageRingSvg();
  const usageEl = h("button", { class: "tool-btn chat-usage" }, usageRing.el);
  usageEl.style.display = "none";
  const modelRow = h("div", { class: "model-row" }, h("div", { class: "chat-tools" }, newBtn, historyBtn, usageEl), modelBtn);

  const body = h("div", { class: "chat-body" });
  const picker = buildPicker(() => {
    body.classList.toggle("picking", picker.isOpen);
    if (picker.isOpen) {
      closeHistory();
      closeScreen();
      closePermissions();
      closeUsage();
    }
    panelChanged();
    drawModelButton();
    drawUsage();
  }, openSettings);

  /** An open list gets the chat's full height; closing it gives the room back. */
  function panelChanged() {
    const open = picker.isOpen || ["browsing", "screening", "authorizing", "metering"].some((c) => body.classList.contains(c));
    if (open === State.chatPanelOpen) return;
    State.chatPanelOpen = open;
    onHeightChange();
  }
  const historyList = h("div", { class: "picker-list" });
  // A search over every past chat, questions and answers alike.
  const historySearch = h("input", {
    type: "search",
    class: "history-search",
    placeholder: tl(STRINGS.searchChats),
    spellcheck: "false",
    "aria-label": tl(STRINGS.searchChats),
  }) as HTMLInputElement;
  const historyEl = h("div", { class: "picker history" },
    h("div", { class: "history-head" }, h("div", { class: "picker-title", text: tl(STRINGS.pastChats) }), historySearch),
    historyList);
  // The screen button's menu, then the preview of a screenshot.
  const screenTitle = h("div", { class: "picker-title" });
  const screenList = h("div", { class: "picker-list" });
  const screenEl = h("div", { class: "picker screen-panel" }, screenTitle, screenList);
  const permList = h("div", { class: "picker-list" });
  const permEl = h("div", { class: "picker permissions" }, h("div", { class: "picker-title", text: t(STRINGS.permissions) }), permList);
  const usageTitle = h("div", { class: "picker-title" });
  const usageList = h("div", { class: "picker-list usage-list" });
  const usagePanel = h("div", { class: "picker usage-panel" }, usageTitle, usageList);
  body.append(chipRow, log, picker.el, historyEl, screenEl, permEl, usagePanel, modelRow, bar);

  // A click anywhere else — in the island or, through Rust's outside-press,
  // anywhere on the screen — closes the list that is open: the models, the
  // past chats, the screen menu, the permissions.
  function closeListsBut(target: Node | null) {
    const inside = (...els: Element[]) => target != null && els.some((el) => el.contains(target));
    if (picker.isOpen && !inside(picker.el, modelBtn)) picker.close();
    if (body.classList.contains("browsing") && !inside(historyEl, historyBtn)) closeHistory();
    if (body.classList.contains("screening") && !inside(screenEl, screenBtn)) closeScreen();
    if (body.classList.contains("authorizing") && !inside(permEl, permBtn)) closePermissions();
    if (body.classList.contains("metering") && !inside(usagePanel, usageEl)) closeUsage();
  }
  document.addEventListener("mousedown", (e) => closeListsBut(e.target as Node | null), true);
  void onEvent<null>("outside-press", () => closeListsBut(null));

  const el = h("div", { class: "view" }, h("div", { class: "card wash chat-card" }, body));
  (el.querySelector(".card") as HTMLElement).style.setProperty("--wash", "rgba(99,102,241,0.5)");

  let sending = false;
  let renderedCount = -1;
  /** What the screen button added, waiting for the next question. */
  let screen = emptyScreen();
  /** Screenshots taken and shown, not yet kept or cancelled. */
  let preview: ScreenShot[] | null = null;
  /** Bumped when the panel closes, so a late answer is dropped (and its screenshots deleted). */
  let screenTicket = 0;
  // A local model answers token by token: where its text so far is shown.
  let live: HTMLElement | null = null;
  /** What the answer is doing, shown next to the dots until its text does. */
  let activity: ChatActivity = THINKING;
  /** Turns the first activity of a provider that streams no tools into Thinking…. */
  let activityTimer: ReturnType<typeof setTimeout> | undefined;
  /** Stop was pressed: the answer is being ended. */
  let stopping = false;
  /** The question being edited (its id): sending replaces it and drops what follows. */
  let editing: number | null = null;
  /** What the send button shows now: "send" or "stop". */
  let sendShows = "send";

  // ── Remaining usage ───────────────────────────────────────────────────────

  /** The last numbers each provider came back with (Anthropic, OpenAI, OpenRouter). */
  const seenUsage = new Map<string, SeenUsage>();
  let usageKey = "";
  let usageSetup = false;
  /** The chat was on screen with OpenRouter and the option on, at the last sync. */
  let openRouterShown = false;
  let openRouterAsking = false;

  let usageLineShown: UsageLine | null = null;

  function drawUsage(now = Date.now()) {
    const line = usageLine(State.settings, State.planUsage, seenUsage.get(State.settings.chatProvider), now);
    // The countdowns move once a minute: the ring and its menu are redrawn when they do.
    const key = line ? `${JSON.stringify(line)}\t${Math.floor(now / 60_000)}` : "";
    if (key === usageKey) return;
    usageKey = key;
    usageLineShown = line;
    usageEl.style.display = line ? "" : "none";
    if (!line) closeUsage();
    usageSetup = Boolean(line?.setup);
    usageEl.classList.toggle("setup", usageSetup);
    usageEl.title = line ? [line.text, line.title].filter(Boolean).join("\n") : "";
    usageEl.setAttribute("aria-label", line?.text ?? "");
    usageRing.set(line?.pct ?? null, line?.color ?? null);
    if (body.classList.contains("metering")) drawUsageMenu();
  }

  /** The menu: each limit with how much is used, its bar and when it resets. */
  function drawUsageMenu() {
    const line = usageLineShown;
    usageTitle.textContent = line ? `${USAGE_TEXT.title} · ${line.title.split("\n").pop() ?? ""}` : USAGE_TEXT.title;
    clear(usageList);
    if (!line) return;
    if (line.rows.length === 0) {
      usageList.append(h("div", { class: "picker-status", text: line.text }));
      return;
    }
    for (const [i, row] of line.rows.entries()) {
      const fill = h("i", { class: "usage-fill" });
      fill.style.width = `${Math.max(0, Math.min(100, row.pct ?? 0))}%`;
      fill.style.background = row.pct == null ? "" : planColor(row.pct);
      usageList.append(h("div", { class: "usage-row" },
        h("div", { class: "usage-row-head" },
          h("span", { class: "usage-label", text: row.label }),
          h("span", { class: "usage-value", text: row.value })),
        h("span", { class: "usage-bar" }, fill),
        row.reset ? h("span", { class: "usage-reset", text: row.reset }) : null,
        // How to get the 5 hours up to date: under them, where it is seen.
        i === 0 && line.note ? h("span", { class: "usage-note", text: line.note }) : null,
      ));
    }
  }

  function openUsage() {
    // Asked of Anthropic when turned on (at most every 3 minutes).
    if (State.settings.chatProvider === "claude-code") refreshClaudePlanOnline();
    if (picker.isOpen) picker.close();
    closeHistory();
    closeScreen();
    closePermissions();
    drawUsageMenu();
    body.classList.add("metering");
    usageEl.classList.add("open");
    panelChanged();
  }

  function closeUsage() {
    if (!body.classList.contains("metering")) return;
    body.classList.remove("metering");
    usageEl.classList.remove("open");
    panelChanged();
  }

  usageEl.addEventListener("click", () => {
    if (sending) return;
    // Without the relay there is nothing to show yet: the ring leads to Settings.
    if (usageSetup) {
      openSettings();
      return;
    }
    if (body.classList.contains("metering")) closeUsage();
    else openUsage();
  });

  function keepUsage(u: ChatUsage | null | undefined) {
    if (!u || typeof u.provider !== "string") return;
    seenUsage.set(u.provider, { ...u, at: Date.now() });
    State.notify();
  }

  /**
   * OpenRouter's key credits: asked when the chat opens on OpenRouter (unless
   * asked less than a minute ago) and after each of its answers. Never on a timer.
   */
  function askOpenRouter(force: boolean) {
    if (openRouterAsking || State.paused) return;
    if (!State.settings.chatShowUsage || State.settings.chatProvider !== "openrouter") return;
    const seen = seenUsage.get("openrouter");
    if (!force && seen && Date.now() - seen.at < OPENROUTER_STALE_MS) return;
    openRouterAsking = true;
    void Bridge.chatUsage()
      .then(keepUsage)
      .finally(() => {
        openRouterAsking = false;
      });
  }

  // Anthropic and OpenAI: read off each answer by Rust, only while the option is on.
  void onEvent<ChatUsage>("chat-usage", keepUsage);
  // sync() only runs while the chat is on screen: leaving it is seen here, so
  // coming back counts as opening the chat again.
  State.subscribe(() => {
    if (State.view !== "prompt" || State.mode !== "expanded") openRouterShown = false;
  });

  function drawModelButton() {
    const p = providerDef(State.settings.chatProvider);
    modelDot.style.background = p.accent;
    const model = activeModel(State.settings) || t(STRINGS.noModel);
    const effort = effortFor(p.id, State.settings.chatEffort);
    modelName.textContent = effort ? `${model} · ${effortLabel(effort)}` : model;
    modelBtn.classList.toggle("open", picker.isOpen);
    modelBtn.disabled = sending;
    drawSend();
    drawPermButton();
  }

  /** While an answer is written, the send button is its Stop button. */
  function drawSend() {
    const shows = sending ? "stop" : "send";
    if (shows !== sendShows) {
      sendShows = shows;
      send.replaceChildren(svg(sending ? ICONS.stop : ICONS.arrowUp, 11));
      send.classList.toggle("stop", sending);
    }
    send.title = t(sending ? STRINGS.stop : STRINGS.send);
    send.setAttribute("aria-label", send.title);
    send.disabled = stopping;
  }

  /** The Stop button (or Escape in the text field): what was written so far stays. */
  function stop() {
    if (!sending || stopping) return;
    stopping = true;
    drawSend();
    void Bridge.chatStop();
  }

  // ── Copy and edit ─────────────────────────────────────────────────────────

  /** Edit on a question: its text goes back in the field; sending replaces it. */
  function startEdit(message: ChatMessage) {
    if (sending) return;
    if (picker.isOpen) picker.close();
    closeHistory();
    closeScreen();
    editing = message.id;
    setInput(message.content);
    Sound.play("blip");
    renderedCount = -1;
    State.notify();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function cancelEdit() {
    if (editing == null) return;
    editing = null;
    setInput("");
    Sound.play("pop");
    renderedCount = -1;
    State.notify();
    input.focus();
  }

  /**
   * Sending an edited question: it and everything after it leave the chat,
   * here and in Rust (chat.rs rewind), before the new text is sent. The Claude
   * Code session is left behind too: the next turn starts a fresh one with the
   * kept turns carried as text, so the dropped ones are gone for it as well.
   */
  async function rewindTo(id: number) {
    const at = State.chatHistory.findIndex((m) => m.id === id);
    if (at < 0) return;
    const kept = State.chatHistory.slice(0, at);
    const keep = kept.reduce((n, m) => (m.turn != null ? Math.max(n, m.turn + 1) : n), 0);
    const file = State.droppedFile;
    // The file went with a question that is dropped now: it goes again.
    if (file?.sent && file.sentWith != null && file.sentWith >= id) file.sent = false;
    State.chatHistory = kept;
    State.chatSession = null;
    renderedCount = -1;
    await Bridge.chatRewind(keep);
  }

  // ── Permissions ───────────────────────────────────────────────────────────
  //
  // What Claude Code or Antigravity CLI may do without a card, from the next
  // message on: each turn starts the CLI again with that mode.

  function drawPermissions() {
    clear(permList);
    const p = providerDef(State.settings.chatProvider);
    const current = parsePermissionMode(State.settings.chatPermissionMode);
    for (const mode of PERMISSION_MODES) {
      const on = mode === current;
      const row = h(
        "button",
        { class: on ? "picker-model perm-row on" : "picker-model perm-row", style: `--accent:${p.accent}` },
        h(
          "span",
          { class: "perm-text" },
          h("span", { class: "picker-model-name", text: t(PERMISSION_TEXT[mode].name) }),
          h("span", { class: "perm-note", text: t(PERMISSION_TEXT[mode].note) }),
        ),
        on ? svg(ICONS.check, 11, { stroke: 2.2 }) : null,
      );
      row.addEventListener("click", () => {
        if (mode !== current) {
          State.settings = { ...State.settings, chatPermissionMode: mode };
          saveSettings();
          Sound.play("blip");
        }
        closePermissions();
        State.notify();
      });
      permList.append(row);
    }
  }

  function closePermissions() {
    if (!body.classList.contains("authorizing")) return;
    body.classList.remove("authorizing");
    permBtn.classList.remove("open");
    panelChanged();
  }

  /** The shield: shown for the CLIs only, lit when they may do more than ask. */
  function drawPermButton() {
    const cli = isCliProvider(State.settings.chatProvider);
    permBtn.hidden = !cli;
    if (!cli) closePermissions();
    const mode = parsePermissionMode(State.settings.chatPermissionMode);
    permBtn.classList.toggle("lit", mode !== "default");
    permBtn.title = `${t(STRINGS.permissions)} · ${t(PERMISSION_TEXT[mode].name)}`;
    permBtn.setAttribute("aria-label", permBtn.title);
    permBtn.disabled = sending;
  }

  permBtn.addEventListener("click", () => {
    if (sending) return;
    if (body.classList.contains("authorizing")) {
      closePermissions();
      return;
    }
    if (picker.isOpen) picker.close();
    closeHistory();
    closeScreen();
    closeUsage();
    drawPermissions();
    body.classList.add("authorizing");
    permBtn.classList.add("open");
    panelChanged();
  });

  // ── New chat, past chats, attach ──────────────────────────────────────────

  function closeHistory() {
    body.classList.remove("browsing");
    historyBtn.classList.remove("open");
    panelChanged();
  }

  // ── Screen button ─────────────────────────────────────────────────────────
  //
  // Opening the menu only asks which displays there are. A window list or a
  // screenshot is made when its entry is clicked, never before; a screenshot
  // is previewed and joins the chat only on Send. Cancel deletes it.

  /** Forgets the screenshots that were not sent, and deletes them. */
  function dropShots(paths: string[]) {
    if (paths.length > 0) void Bridge.screenDiscard(paths);
  }

  function closeScreen() {
    if (!body.classList.contains("screening")) return;
    screenTicket++;
    if (preview) dropShots(preview.map((s) => s.path));
    preview = null;
    body.classList.remove("screening");
    screenBtn.classList.remove("open");
    panelChanged();
  }

  /** Forgets what the screen button or a shortcut added and was not sent yet (a new chat, the chip's ×). */
  function clearScreen(kind?: ChipKind) {
    if (!kind || kind === "shots") {
      dropShots(shotPaths(screen));
      screen = { ...screen, shots: [] };
    }
    if (!kind) screen = nextScreen(screen);
    if (kind === "windows") screen = { ...screen, windows: [] };
    if (kind === "tabs") screen = { ...screen, tabs: [] };
    if (kind === "selection") screen = { ...screen, selection: null };
    if (kind === "folder") screen = withoutFolder(screen);
  }

  // ── The folder that goes with every message (Settings → Chat) ─────────────
  //
  // Only while the setting is on, and only when the text field takes focus or
  // a message went: the folder's name, for the chip. Its listing is taken when
  // the message goes. Linux (nothing found) or an error: no chip, nothing sent.

  let peeking = false;
  let peekedAt = -Infinity;
  /** The setting as the view last saw it, to notice it being turned on or off. */
  let sharesExplorer = false;

  async function peekExplorer(force: boolean) {
    if (!State.settings.chatShareExplorer) return;
    const now = performance.now();
    if (peeking || (!force && now - peekedAt < PEEK_EVERY_MS)) return;
    peeking = true;
    peekedAt = now;
    let folder: ExplorerFolder | null = null;
    try {
      folder = await Bridge.screenExplorerPeek();
    } catch {
      folder = null;
    } finally {
      peeking = false;
    }
    if (!State.settings.chatShareExplorer) return;
    const before = screen.autoFolder?.path ?? "";
    screen = { ...screen, autoFolder: folder };
    if ((folder?.path ?? "") !== before) State.notify();
  }

  /** The folder open in File Explorer with its listing, as the menu's entry shares it; null if none. */
  async function explorerNow(): Promise<ExplorerFolder | null> {
    try {
      return await Bridge.screenExplorer();
    } catch (err) {
      void Bridge.log(`[explorer] ${String(err)}`);
      return null;
    }
  }

  /** What a sharing shortcut just took (island/shortcuts.ts runShared). */
  function takeShare() {
    const share = State.incomingShare;
    if (!share) return;
    State.incomingShare = null;
    if (share.kind === "screen") {
      // A new "Ask about my screen" replaces the screenshots still waiting.
      clearScreen("shots");
      screen = keepShots(screen, share.shots);
    } else if (share.kind === "selection") {
      screen = { ...screen, selection: share.selection };
    }
  }

  function screenStatus(text: string) {
    screenList.append(h("div", { class: "picker-status", text }));
  }

  function openScreen() {
    if (picker.isOpen) picker.close();
    closeHistory();
    closePermissions();
    closeUsage();
    body.classList.add("screening");
    screenBtn.classList.add("open");
    panelChanged();
    void drawScreenMenu();
  }

  async function drawScreenMenu() {
    const ticket = ++screenTicket;
    screenTitle.textContent = t(SCREEN_STRINGS.title);
    clear(screenList);
    let displays: ScreenDisplay[] = [];
    let problem = "";
    // Only the folder's name, for the label: nothing is listed before a click.
    const peek: Promise<ExplorerPeek> = Bridge.screenExplorerPeek().then(
      (folder) => ({ folder, problem: "" }),
      (err) => ({ folder: null, problem: String(err).replace(/^Error:\s*/, "") }),
    );
    // The browsers' tabs, titles only: the entry shows when there are some.
    const tabs: Promise<BrowserTab[]> = Bridge.screenTabs().catch(() => []);
    try {
      displays = await Bridge.screenDisplays();
    } catch (err) {
      problem = String(err).replace(/^Error:\s*/, "");
    }
    const explorer = await peek;
    let timer = 0;
    const late = new Promise<null>((resolve) => { timer = window.setTimeout(() => resolve(null), TABS_WAIT_MS); });
    const tabList = await Promise.race([tabs, late]);
    window.clearTimeout(timer);
    if (ticket !== screenTicket) return;
    drawScreenEntries(displays, explorer, tabList ?? [], problem);
    // Drawn without them: they join the menu once they come, if it is still there.
    if (tabList === null) {
      void tabs.then((list) => {
        if (ticket === screenTicket && list.length > 0) drawScreenEntries(displays, explorer, list, problem);
      });
    }
  }

  function drawScreenEntries(displays: ScreenDisplay[], explorer: ExplorerPeek, tabList: BrowserTab[], problem: string) {
    clear(screenList);
    const images = seesImages(providerDef(State.settings.chatProvider));
    for (const entry of menuEntries(displays, explorer, tabList)) {
      const shot = entry.kind === "display" || entry.kind === "all";
      const off = shot && !images;
      const detail =
        entry.kind === "display" ? `${entry.width} × ${entry.height}`
        : entry.kind === "explorer" ? entry.folder.name
        : entry.kind === "tabs" ? String(entry.count)
        : "";
      const opens = entry.kind === "windows" || entry.kind === "tabs";
      const row = h(
        "button",
        { class: "picker-model screen-entry", disabled: off },
        h("span", { class: "picker-model-name", text: entryLabel(entry) }),
        detail ? h("span", { class: "history-date", text: detail }) : null,
        // A second list opens from it.
        opens ? svg(ICONS.chevronRight, 9, { stroke: 2 }) : null,
      );
      if (entry.kind === "explorer") row.title = entry.folder.path;
      if (!off) row.addEventListener("click", () => void pickEntry(entry));
      screenList.append(row);
    }
    if (problem) screenStatus(problem);
    else if (displays.length > 0 && !images) screenStatus(t(SCREEN_STRINGS.needsImages));
    screenStatus(t(SCREEN_STRINGS.nothingYet));
  }

  /** The second list: "All …", then each window or tab, under a way back. */
  function drawPicks(title: string, picks: PickEntry[], onPick: (pick: PickEntry) => void) {
    screenTitle.textContent = title;
    clear(screenList);
    const back = h("button", { class: "picker-model screen-entry screen-back" },
      svg(ICONS.chevronLeft, 9, { stroke: 2 }),
      h("span", { class: "picker-model-name", text: t(SCREEN_STRINGS.back) }));
    back.addEventListener("click", () => void drawScreenMenu());
    screenList.append(back);
    for (const pick of picks) {
      const row = h(
        "button",
        { class: `picker-model screen-entry screen-pick${pick.id == null ? " screen-pick-all" : ""}` },
        h("span", { class: "picker-model-name", text: pick.label }),
        pick.detail ? h("span", { class: "history-date", text: pick.detail }) : null,
      );
      if (pick.title) row.title = pick.title;
      row.addEventListener("click", () => onPick(pick));
      screenList.append(row);
    }
  }

  /** Something was added from the menu: the panel goes, the chip shows. */
  function added() {
    closeScreen();
    Sound.play("attach");
    State.notify();
    input.focus();
  }

  async function openWindows() {
    const ticket = ++screenTicket;
    clear(screenList);
    let list: OpenWindow[];
    try {
      list = await Bridge.screenWindows();
    } catch (err) {
      if (ticket === screenTicket) screenStatus(String(err).replace(/^Error:\s*/, ""));
      return;
    }
    if (ticket !== screenTicket) return;
    const picks = windowPicks(list);
    drawPicks(t(SCREEN_STRINGS.windows), picks, (pick) => void shareWindows(pick, list));
    if (picks.length === 0) screenStatus(t(SCREEN_STRINGS.noWindows));
  }

  /** One window (with a picture of it, for who sees images) or all of them, with what they show. */
  async function shareWindows(pick: PickEntry, list: OpenWindow[]) {
    if (sending) return;
    const ticket = ++screenTicket;
    clear(screenList);
    screenStatus(t(SCREEN_STRINGS.reading));
    const id = typeof pick.id === "number" ? pick.id : null;
    try {
      const shared = await Bridge.screenWindowShare(id == null ? [] : [id]);
      if (ticket !== screenTicket) return;
      screen = { ...screen, windows: withWindows(screen.windows, shared) };
      const one = list.find((w) => w.id === id);
      if (id != null && one && !one.minimized && seesImages(providerDef(State.settings.chatProvider))) {
        try {
          const shot = await Bridge.screenWindowShot(id);
          if (ticket !== screenTicket) {
            dropShots([shot.path]);
          } else {
            screen = { ...screen, shots: [...screen.shots, { name: short(one.title), path: shot.path, preview: shot.preview }] };
          }
        } catch (err) {
          void Bridge.log(`[share] window picture: ${String(err)}`);
        }
      }
      if (ticket === screenTicket) added();
    } catch (err) {
      if (ticket === screenTicket) {
        clear(screenList);
        screenStatus(String(err).replace(/^Error:\s*/, ""));
      }
    }
  }

  async function openTabs() {
    const ticket = ++screenTicket;
    clear(screenList);
    let list: BrowserTab[];
    try {
      list = await Bridge.screenTabs();
    } catch (err) {
      if (ticket === screenTicket) screenStatus(String(err).replace(/^Error:\s*/, ""));
      return;
    }
    if (ticket !== screenTicket) return;
    drawPicks(t(SCREEN_STRINGS.tabs), tabPicks(list), (pick) => void shareTabs(pick));
  }

  /** One tab or all of them, each with its page's text. */
  async function shareTabs(pick: PickEntry) {
    if (sending) return;
    const ticket = ++screenTicket;
    clear(screenList);
    screenStatus(t(SCREEN_STRINGS.reading));
    try {
      const shared = await Bridge.screenTabShare(typeof pick.id === "string" ? [pick.id] : []);
      if (ticket !== screenTicket) return;
      screen = { ...screen, tabs: withTabs(screen.tabs, shared) };
      added();
    } catch (err) {
      if (ticket === screenTicket) {
        clear(screenList);
        screenStatus(String(err).replace(/^Error:\s*/, ""));
      }
    }
  }

  async function pickEntry(entry: MenuEntry) {
    if (sending) return;
    if (entry.kind === "windows") return openWindows();
    if (entry.kind === "tabs") return openTabs();
    const ticket = ++screenTicket;
    clear(screenList);
    if (entry.kind === "explorer") {
      try {
        const folder = await Bridge.screenExplorer();
        if (ticket !== screenTicket) return;
        if (!folder) {
          screenStatus(t(SCREEN_STRINGS.noExplorer));
          return;
        }
        screen = { ...screen, folder };
        added();
      } catch (err) {
        if (ticket === screenTicket) screenStatus(String(err).replace(/^Error:\s*/, ""));
      }
      return;
    }
    screenStatus(t(SCREEN_STRINGS.capturing));
    let shots: ScreenShot[];
    try {
      shots = await Bridge.screenCapture(entry.kind === "display" ? entry.index : null);
    } catch (err) {
      if (ticket !== screenTicket) return;
      clear(screenList);
      screenStatus(String(err).replace(/^Error:\s*/, ""));
      return;
    }
    if (ticket !== screenTicket) {
      dropShots(shots.map((s) => s.path)); // the panel was closed meanwhile
      return;
    }
    preview = shots;
    drawPreview(shots);
  }

  function drawPreview(shots: ScreenShot[]) {
    screenTitle.textContent = t(SCREEN_STRINGS.confirm);
    clear(screenList);
    const row = h("div", { class: "screen-shots" });
    for (const s of shots) {
      row.append(
        h(
          "figure",
          { class: "screen-shot" },
          h("img", { src: s.preview, alt: screenLabel(s.display) }),
          h("figcaption", { text: screenLabel(s.display) }),
        ),
      );
    }
    const keep = h("button", { class: "btn primary", text: t(STRINGS.send) });
    const cancel = h("button", { class: "btn secondary", text: t(STRINGS.cancel) });
    keep.addEventListener("click", () => {
      if (!preview) return;
      screen = keepShots(screen, preview);
      preview = null; // kept: closing must not delete them
      closeScreen();
      Sound.play("attach");
      State.notify();
      // A question already typed goes with it right away.
      if (input.value.trim()) void submit();
      else input.focus();
    });
    cancel.addEventListener("click", () => {
      closeScreen(); // deletes the previewed screenshots
      Sound.play("pop");
      input.focus();
    });
    screenList.append(row, h("div", { class: "screen-actions" }, cancel, keep));
  }

  function drawHistory() {
    clear(historyList);
    const chats = loadChats();
    if (chats.length === 0) {
      historyList.append(h("div", { class: "picker-status", text: t(STRINGS.noPastChats) }));
      return;
    }
    const query = historySearch.value.trim();
    const rows: { chat: SavedChat; snippet?: HTMLElement }[] = query
      ? searchChats(chats, query).map((hit) => ({ chat: hit.chat, snippet: snippetOf(hit) }))
      : chats.map((chat) => ({ chat }));
    if (query && rows.length === 0) {
      historyList.append(h("div", { class: "picker-status", text: t(STRINGS.noMatch) }));
      return;
    }
    for (const { chat: c, snippet } of rows) {
      const remove = h("button", { class: "history-delete", title: tl(STRINGS.deleteChat) }, svg(ICONS.trash, 12, { stroke: 1.6 }));
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteChat(c.id);
        Sound.play("pop");
        drawHistory();
      });
      const name = h("span", { class: "picker-model-name", text: c.title || "…" });
      const row = h(
        "div",
        { class: c.id === State.chatId ? "picker-model history-row on" : "picker-model history-row", title: c.title },
        snippet ? h("span", { class: "history-text" }, name, snippet) : name,
        h("span", { class: "history-date", text: new Date(c.updatedAt).toLocaleDateString() }),
        remove,
      );
      row.addEventListener("click", () => openChat(c));
      historyList.append(row);
    }
  }

  /** The passage that matched, with the match lit (text nodes only, never markup). */
  function snippetOf(hit: ChatHit): HTMLElement {
    const [a, b] = hit.match;
    return h("span", { class: "history-snippet" },
      hit.snippet.slice(0, a),
      h("mark", { text: hit.snippet.slice(a, b) }),
      hit.snippet.slice(b));
  }

  historySearch.addEventListener("input", () => drawHistory());
  historySearch.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    e.stopPropagation(); // Escape here clears the search, not the island
    if (key === "Escape") {
      e.preventDefault();
      if (historySearch.value) {
        historySearch.value = "";
        drawHistory();
      } else closeHistory();
    } else if (key === "Enter") {
      e.preventDefault();
      // Enter opens the first chat found.
      const query = historySearch.value.trim();
      const first = query ? searchChats(loadChats(), query)[0]?.chat : loadChats()[0];
      if (first) openChat(first);
    }
  });

  function openChat(c: SavedChat) {
    if (sending) return;
    editing = null;
    // Rust takes every turn back as it is (chat_restore): each one's place there is its place here.
    State.chatHistory = c.turns.map((turn, i) => ({ id: nextId++, role: turn.role, content: turn.content, turn: i }));
    State.chatId = c.id;
    State.chatSession = c.session;
    State.droppedFile = null;
    State.promptContext = null;
    closeScreen();
    clearScreen();
    void Bridge.chatRestore(c.turns, c.session);
    closeHistory();
    Sound.play("blip");
    renderedCount = -1;
    State.notify();
    onHeightChange();
    input.focus();
  }

  function newChat() {
    if (sending) return;
    if (editing != null) setInput("");
    editing = null;
    State.startChat();
    State.droppedFile = null;
    State.promptContext = null;
    closeScreen();
    clearScreen();
    void Bridge.chatReset();
    if (picker.isOpen) picker.close();
    closeHistory();
    Sound.play("blip");
    renderedCount = -1;
    State.notify();
    onHeightChange();
    input.focus();
  }

  /** The empty chat: a question, and three ways to start. */
  function welcome(): HTMLElement {
    const start = (label: string, run: () => void) =>
      h("button", { class: "welcome-chip", onclick: () => { if (!sending) run(); } }, h("span", { text: t(label) }));
    return h(
      "div",
      { class: "chat-welcome" },
      h("div", { class: "welcome-title", text: t(STRINGS.welcome) }),
      h(
        "div",
        { class: "welcome-chips" },
        start(STRINGS.askFile, () => void attach()),
        start(STRINGS.lookScreen, () => openScreen()),
        start(STRINGS.writeMessage, () => {
          setInput(t(STRINGS.writeMessageStart));
          void Bridge.focusWindow(true);
          window.setTimeout(() => {
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          }, 60);
        }),
      ),
    );
  }

  /** Saves the chat on screen in the history, after each answer. */
  function remember() {
    const turns = State.chatHistory.map((m) => ({ role: m.role, content: m.content }));
    if (turns.length === 0) return;
    saveChat({
      id: State.chatId,
      title: chatTitle(turns),
      updatedAt: Date.now(),
      provider: State.settings.chatProvider,
      session: State.chatSession,
      turns,
    });
  }

  async function attach() {
    if (sending) return;
    let file;
    try {
      file = await Bridge.pickFile();
    } catch (err) {
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
      State.notify();
      return;
    }
    if (!file) return;
    void useFile(file);
    input.focus();
  }

  /** A file joins the chat: picked with the paperclip, or named from a shared folder. */
  async function useFile(file: { name: string; path: string }) {
    let reset: Promise<unknown> = Promise.resolve();
    // The CLIs read the file from its path, mid-conversation too. The other
    // providers take a file with the first question only: a new chat, as a drop.
    if (!isCliProvider(State.settings.chatProvider)) {
      State.startChat();
      reset = Bridge.chatReset();
      renderedCount = -1;
    }
    State.droppedFile = { name: file.name, path: file.path };
    State.promptContext = { kind: "file", name: file.name, path: file.path };
    Sound.play("attach");
    State.notify();
    await reset;
  }

  /**
   * A question sent with a shared folder: the file of it the question names
   * goes with it, unless a file the user added is still waiting.
   */
  async function attachNamed(folder: ExplorerFolder, query: string) {
    if (State.droppedFile && !State.droppedFile.sent) return;
    try {
      const file = await Bridge.explorerAttach(folder.path, query);
      if (file) await useFile(file);
    } catch (err) {
      void Bridge.log(`[explorer] ${String(err)}`);
    }
  }

  newBtn.addEventListener("click", newChat);
  attachBtn.addEventListener("click", () => void attach());
  screenBtn.addEventListener("click", () => {
    if (sending) return;
    if (body.classList.contains("screening")) closeScreen();
    else openScreen();
  });
  historyBtn.addEventListener("click", () => {
    if (sending) return;
    if (body.classList.contains("browsing")) {
      closeHistory();
      return;
    }
    if (picker.isOpen) picker.close();
    closeScreen();
    closePermissions();
    closeUsage();
    historySearch.value = "";
    drawHistory();
    body.classList.add("browsing");
    historyBtn.classList.add("open");
    panelChanged();
    historySearch.focus();
  });

  modelBtn.addEventListener("click", () => {
    if (sending) return;
    if (picker.isOpen) picker.close();
    else picker.open();
  });

  void onEvent<string>("chat-delta", (text) => {
    if (!sending || !text) return; // nothing visible yet: the dots stay
    // The closed island says it is writing now.
    if (State.chatActivity?.label != null) {
      State.chatActivity = { label: null };
      State.notify();
    }
    // The text shows: the dots and what the answer was doing go.
    log.querySelector(".typing")?.parentElement?.remove();
    if (!live) {
      live = h("div", { class: "reply" });
      log.append(h("div", { class: "chat-row" }, live));
    }
    renderMarkdown(live, takeTimers(text).text);
    log.scrollTop = log.scrollHeight;
  });

  /**
   * The line next to the dots says what the answer is doing now. `again`:
   * Claude Code went back to its tools after some text, so the dots come
   * back under it.
   */
  function showActivity(next: ChatActivity, again = false) {
    activity = next;
    if (sending) {
      State.chatActivity = { label: activityLabel(activity) };
      State.notify();
    }
    const label = log.querySelector(".typing-label");
    if (label) label.textContent = activityLabel(activity);
    else if (again && live) log.append(typingDots(activityLabel(activity)));
    log.scrollTop = log.scrollHeight;
  }

  void onEvent<ChatActivity>("chat-activity", (next) => {
    if (!sending || !next) return;
    clearTimeout(activityTimer);
    showActivity(next, true);
  });

  async function submit() {
    const query = input.value.trim();
    if (!query || sending) return;
    // "/timer 10m pasta": a timer on the closed island, nothing sent to the AI.
    const timer = /^\/timer\s+(\S+)\s*(.*)$/i.exec(query);
    const timerMs = timer ? parseDuration(timer[1]) : null;
    if (timer && timerMs != null) {
      setInput("");
      compactTimer(timerMs, timer[2]);
      Sound.play("blip");
      return;
    }
    if (picker.isOpen) picker.close();
    closeHistory();
    closeScreen();
    setInput("");
    sending = true;
    stopping = false;
    drawModelButton();
    Sound.play("send");

    // An edited question replaces the one it came from, and what followed it.
    const edited = editing;
    editing = null;
    if (edited != null) await rewindTo(edited);

    // What the screen button added goes once, then the chip goes.
    const waiting = screen;
    let shared = waiting;
    if (sharesFolderByItself(waiting, State.settings.chatShareExplorer)) {
      const folder = await explorerNow();
      if (folder) shared = { ...waiting, folder };
    }
    if (shared.folder) await attachNamed(shared.folder, query);

    // The file goes with the first question asked after it was added, once.
    const file = State.droppedFile;
    const context: ChatContext | null = file && !file.sent ? { kind: "file", name: file.name, path: file.path } : null;
    const screenContext = screenPayload(shared);

    activity = firstActivity(State.settings.chatProvider, context, screenContext);
    if (activity !== THINKING) activityTimer = setTimeout(() => showActivity(THINKING), FIRST_ACTIVITY_MS);

    const question: ChatMessage = { id: nextId++, role: "user", content: query };
    State.chatHistory.push(question);
    State.stateOverride = "thinking";
    State.chatActivity = { label: activityLabel(activity) };
    State.notify();
    onHeightChange();

    try {
      const reply = await Bridge.chatSend(query, context, screenContext);
      // Stopped before anything was written: the question stays, unanswered,
      // and Rust kept nothing of it (the file goes with the next one).
      const recorded = !reply.stopped || reply.text !== "";
      if (recorded && reply.turns != null) question.turn = reply.turns - 2;
      // A timer the answer asked for starts now; its line is not shown.
      const answered = takeTimers(reply.text);
      for (const timer of answered.timers) compactTimer(timer.ms, timer.label);
      if (recorded) {
        State.chatHistory.push({
          id: nextId++,
          role: "assistant",
          content: answered.text,
          stopped: reply.stopped || undefined,
          turn: reply.turns != null ? reply.turns - 1 : undefined,
        });
      }
      if (file && context && recorded) {
        file.sent = true;
        file.sentWith = question.id;
      }
      // Rust deleted the screenshots once the turn went, stopped or not.
      if (screen === waiting) screen = nextScreen(screen);
      void peekExplorer(true);
      if (reply.session) State.chatSession = reply.session;
      remember();
      askOpenRouter(true);
      settle(reply.stopped ? null : "finished");
      Sound.play(reply.stopped ? "pop" : "finish");
      if (!reply.stopped) noticeAway(COMPACT_TEXT.answered);
    } catch (err) {
      settle("error");
      noticeAway(COMPACT_TEXT.failed);
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      sending = false;
      stopping = false;
      State.chatActivity = null;
      live = null;
      clearTimeout(activityTimer);
      activity = THINKING;
      renderedCount = -1; // the finished answer replaces the streamed one
      drawModelButton();
      State.notify();
      onHeightChange();
      input.focus();
    }
  }

  // ── Ctrl+V ────────────────────────────────────────────────────────────────

  /** No text was pasted: the file copied in File Explorer, else the image the page got. */
  async function pasteAttach(files: File[]) {
    try {
      const copied = await Bridge.pasteCopiedFile();
      if (copied) {
        await useFile(copied);
        return;
      }
      const file = files[0];
      if (!file) return;
      if (file.size > MAX_PASTE_BYTES) throw new Error(t(PASTE_STRINGS.tooBig));
      const bytes = new Uint8Array(await file.arrayBuffer());
      await useFile(await Bridge.pasteFile(pastedName(file, new Date()), bytes));
    } catch (err) {
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
      State.notify();
    }
  }

  input.addEventListener("paste", (e) => {
    const data = (e as ClipboardEvent).clipboardData;
    if (sending || pasteAction(data) === "text") return;
    e.preventDefault();
    void pasteAttach(pastedFiles(data));
  });
  input.addEventListener("focus", () => void peekExplorer(false));

  send.addEventListener("click", () => {
    if (sending) stop();
    else void submit();
  });
  // The field stays open while an answer is written: the next question can be
  // typed, and goes with Enter once the answer is done (or stopped).
  input.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    const key = ke.key;
    // Shift+Enter is a new line; Enter while an IME composes is the IME's.
    if (key === "Enter" && !ke.shiftKey && !ke.isComposing) {
      e.preventDefault();
      void submit();
    } else if (key === "Escape" && picker.isOpen) {
      e.preventDefault();
      picker.close();
    } else if (key === "Escape" && body.classList.contains("screening")) {
      e.preventDefault();
      closeScreen();
    } else if (key === "Escape" && sending) {
      e.preventDefault();
      stop();
    } else if (key === "Escape" && editing != null) {
      e.preventDefault();
      cancelEdit();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
      takeShare();
      // An email's button asked something: it goes at once (after this draw).
      const ask = State.chatAsk;
      if (ask && !sending) {
        State.chatAsk = null;
        setInput(ask);
        window.setTimeout(() => void submit(), 0);
      }
      if (State.settings.chatShareExplorer !== sharesExplorer) {
        sharesExplorer = State.settings.chatShareExplorer;
        if (sharesExplorer) void peekExplorer(true);
        else screen = { ...screen, autoFolder: null, autoOff: false };
      }
      // The edited question left the chat another way (a new chat, a file): nothing to replace.
      if (editing != null && !State.chatHistory.some((m) => m.id === editing)) editing = null;
      const file = State.droppedFile;
      const wantChip = file?.name ?? "";
      const extra = screenChips(screen);
      const editKey = editing != null ? [`edit\t${editing}`] : [];
      const chipKey = [wantChip, ...extra.map((c) => `${c.label}\t${c.title}`), ...shotPaths(screen), ...editKey].join("\n");
      if (chipRow.dataset.label !== chipKey) {
        chipRow.dataset.label = chipKey;
        // Something is already attached: the ways to start make room for it.
        body.classList.toggle("has-context", chipKey !== "");
        clear(chipRow);
        // A dropped or pasted file: its × takes it out before it is sent.
        if (wantChip) {
          chipRow.append(screenChip(wantChip, file?.path ?? wantChip, () => {
            if (sending) return;
            State.droppedFile = null;
            if (State.promptContext?.kind === "file") State.promptContext = null;
            Sound.play("pop");
            State.notify();
          }));
        }
        for (const c of extra) {
          chipRow.append(
            screenChip(
              c.label,
              c.title,
              () => {
                if (sending) return;
                clearScreen(c.kind);
                Sound.play("pop");
                State.notify();
              },
              c.thumbs,
            ),
          );
        }
        if (editing != null) chipRow.append(screenChip(t(STRINGS.editing), t(STRINGS.editingHint), cancelEdit));
      }

      const thinking = State.stateOverride === "thinking";
      const count = State.chatHistory.length + (thinking ? 0.5 : 0);
      if (count !== renderedCount && !live) {
        renderedCount = count;
        clear(log);
        // A new chat opens on a few ways to start, now that it is home.
        if (count === 0) log.append(welcome());
        // Nothing is edited while an answer is written; what an edit would drop shows faded.
        const at = editing == null ? -1 : State.chatHistory.findIndex((m) => m.id === editing);
        State.chatHistory.forEach((m, i) => {
          log.append(bubble(m, { onEdit: sending ? undefined : startEdit, editing: i === at, dropped: at >= 0 && i > at }));
        });
        if (thinking) log.append(typingDots(activityLabel(activity)));
        log.scrollTop = log.scrollHeight;
      }

      // Leaving the chat folds the picker away.
      if (State.view !== "prompt" && picker.isOpen) picker.close();
      if (State.view !== "prompt") {
        closeHistory();
        closeScreen();
        closePermissions();
      }
      newBtn.disabled = sending;
      historyBtn.disabled = sending;
      attachBtn.disabled = sending;
      screenBtn.disabled = sending;
      micBtn.classList.toggle("lit", State.liveActive);
      drawModelButton();
      const openRouter = State.mode === "expanded" && State.view === "prompt"
        && State.settings.chatShowUsage && State.settings.chatProvider === "openrouter";
      if (openRouter && !openRouterShown) askOpenRouter(false);
      openRouterShown = openRouter;
      drawUsage();

      input.placeholder = t(State.chatHistory.length === 0 ? STRINGS.placeholderFirst : STRINGS.placeholderNext);
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
