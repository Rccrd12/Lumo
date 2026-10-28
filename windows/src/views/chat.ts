// Chat view: the prompt box, the bubbles, the typing dots and the model picker.
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
// field too): what was written stays, marked stopped. Everything else stays
// usable meanwhile: the attachments, the past chats, a new chat, the shield,
// the model and its effort (a change goes with the next message), the usage.
// Moving to another chat leaves the answer going in the background, in its
// own chat (chat.rs Chats): it lands there when done, and coming back shows it
// as far as it got. Enter sends once the chat's answer is done. Each message
// has Copy under the mouse, each question Edit: sending the edited text
// replaces it and drops what followed, here and in Rust (chat.rs rewind); sent
// mid-answer, it stops that answer first.
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
// just left of the model button fills with what the provider has used — the most
// used of its limits, in the plan's colours — and opens a menu with each limit,
// its bar and when it resets (core/chat-usage.ts).
//
// With "Always share the folder open in File Explorer" on (Settings → Chat),
// that folder goes with every message by itself; its × in the attachments
// leaves it out of one.
//
// Everything that goes with the next question waits in the attachments, the
// folder beside the past chats: one row each (two screenshots of the same
// screen are two rows), with its picture or its kind's icon, what it is, and
// a × that takes back that one only. A click shows what it sends.
//
// "/" as the field's first character opens the commands' menu above it
// (core/slash.ts): Lumo's own (a new chat, the past chats, the model, a
// timer…), the user's tools that have a command (`/pdfcraft merge them` asks
// the AI to use that tool for what follows) and, with Claude Code, its own
// commands, sent as typed; only what the provider can use. It filters
// as the name is typed; arrows move, Enter runs, Tab writes the name for
// what follows. A press anywhere, the field included, closes it; a press on
// the field brings it back only once the field had lost the focus.
//
// Beside the attachments' title, "Chat files": the files that went with a
// question of this chat, and those Claude Code or Antigravity CLI read, edited
// or created while answering it (core/chat-files.ts), kept with the chat. They
// cannot be taken back: a click opens one (a picture in its preview), a right
// click offers Open, Open file location and Copy path.
//
// Ctrl+V in the text field attaches an image or a file copied in File
// Explorer the same way as the paperclip; text pastes as usual (core/paste.ts).
//
// The same view is the tool workshop (views/forge.ts) while State.chatSlot is
// "forge": a chat of its own (its own past chats, attachments and field, kept
// while the chat is on screen), a look of its own, and the tool the AI is
// writing beside the conversation.

import { h, svg, clear, gentleWheel } from "./dom";
import { ICONS } from "./icons";
import { copyButton, renderMarkdown, writeClipboard } from "./markdown";
import type { MenuEntry as MenuItem } from "./context-menu";
import { ownMenu } from "./own-menu";
import { renderAnswer } from "./context-card";
import {
  Bridge, onEvent, type BrowserTab, type ChatActivity, type ChatContext, type ChatFileEvent, type ExplorerFolder, type ModelInfo,
  type OpenWindow, type ScreenContext, type ScreenDisplay, type ScreenShot,
} from "../core/bridge";
import {
  activeModel, effortFor, effortsFor, isCliProvider, parsePermissionMode, permissionModesFor, pickModel, providerDef,
  anyProviderReady, visibleProviders, withModel, type PermissionMode, type ProviderDef,
} from "../core/providers";
import { Sound } from "../core/sound";
import { State, type ChatMessage } from "../core/state";
import { chatTitle, deleteChat, loadChats, saveChat, searchChats, type ChatHit, type SavedChat } from "../core/chats";
import {
  addChatFile, aiKind, chatFiles, dropChatFiles, filesByKind, removeChatFile, rewindChatFiles, type ChatFile, type ChatFileKind,
} from "../core/chat-files";
import { planColor } from "../core/plan";
import { refreshAntigravityPlanUsage, refreshClaudePlanOnline } from "./usage";
import { OPENROUTER_STALE_MS, USAGE_TEXT, usageLine, type ChatUsage, type SeenUsage, type UsageLine } from "../core/chat-usage";
import {
  ITEM_STRINGS, PREVIEW_STRINGS, SCREEN_STRINGS, withSelection, emptyScreen, filePreview, formatSize, entryLabel, itemPreview, keepShots,
  afterSent, autoShare, folderPicks, foldersByThemselves, menuEntries, nextScreen, screenItems, screenLabel, screenPayload, seesImages, short,
  shotPaths, tabPicks, tabsByThemselves, windowPicks, withFolders, withTabs, withWindows, withoutItem, type ExplorerPeek, type ItemKind, type MenuEntry, type PickEntry,
  type PendingScreen, type PreviewBlock, type ScreenItem,
} from "../core/screen";
import { MAX_PASTE_BYTES, PASTE_STRINGS, pasteAction, pastedFiles, pastedName } from "../core/paste";
import { COMPUTER_TEXT } from "../core/computer";
import { closePicture } from "./picture";
import type { ViewHost } from "./views";
import { N_, t, tl } from "../i18n/i18n";
import { LIVE_STRINGS } from "../live/strings";
import { COMPACT_TEXT, UPLOADED_TEXT, compactNotice, compactTimer, parseDuration, speakerName, takeTimers } from "../core/compact";
import { LISTEN_COLOR, LISTEN_STRINGS, listenMessage, listeningLine, takeListens, type ListenFired, type ListenWatch } from "../core/listen";
import { blocksOf, draftIn, draftKey, draftOf, isWorkshopChat, latestDraft, stripDraft, type ToolDraft, type ToolInfo } from "../core/tools";
import { FORGE_STRINGS, buildForgePanel, draftChip, linkSaved, savedLink } from "./forge";
import {
  lumoCommand, slashCommands, slashMatches, slashQuery, toolAsk, toolCommand, type SlashAction, type SlashCommand,
} from "../core/slash";

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
  attachments: N_("Attachments"),
  noAttachments: N_("Nothing is attached yet."),
  attachHint: N_("Files, screenshots, windows, pages and selected text wait here for your next question."),
  removeAll: N_("Remove all"),
  chatFiles: N_("Chat files"),
  noChatFiles: N_("No files in this chat yet."),
  chatFilesHint: N_("The files attached here, and the ones the AI reads, edits or creates, stay here to open again."),
  computer: N_("Computer"),
  computerHint: N_("Folders, windows, pages, screenshots and text from your computer"),
  removeFromContext: N_("Remove from the chat's context"),
  fileMissing: N_("No longer found"),
  openFile: N_("Open"),
  openLocation: N_("Open file location"),
  copyPath: N_("Copy path"),
  noPastChats: N_("No past chats yet."),
  searchChats: N_("Search the past chats"),
  noMatch: N_("No chat says that."),
  deleteChat: N_("Delete this chat"),
  attach: N_("Attach a file"),
  attachShots: N_("Attach"),
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

/** The commands' icons drawn filled (core/slash.ts); the others are strokes. */
const FILLED_ICONS = new Set(["plus", "gear", "timer"]);

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
  turbo: { name: N_("Turbo"), note: N_("Runs every command and changes any file without asking.") },
};

/**
 * Auto with Antigravity CLI: agy's own Proceed in Sandbox (antigravity_cli.rs,
 * core/approvals.ts autoAllows).
 */
const AGY_AUTO_NOTE = N_("Commands run in Antigravity's sandbox without asking; Lumo asks for the rest.");

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
  /** A tool workshop's answer: the draft's blocks show as one line naming it. */
  workshop?: boolean;
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
  if (opts.workshop) {
    const shown = stripDraft(message.content);
    renderMarkdown(reply, shown.text);
    const draft = shown.draft ? draftIn(message.content) : null;
    if (draft) reply.append(draftChip(draft.name));
  } else {
    renderAnswer(reply, message.content);
  }
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
  commandFor: N_("Running a command: {what}"),
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

/**
 * An answer being written. It belongs to its chat: moving to another chat
 * leaves it going in the background, and it lands in its own chat when done.
 */
interface Run {
  chatId: string;
  /** The chat's messages: State.chatHistory itself while the chat is on screen. */
  history: ChatMessage[];
  /** The CLI session the chat continues (State.chatSession while on screen). */
  session: string | null;
  provider: string;
  /** The turn the question is in Rust's conversation (chat.rs), for the files it uses. */
  turn: number;
  /** The answer's text so far: "" until it shows. */
  text: string;
  /** What the answer is doing, shown next to the dots until its text does. */
  activity: ChatActivity;
  /** The dots are back under the text: the CLI went back to its tools. */
  dots: boolean;
  /** Turns the first activity of a provider that streams no tools into Thinking…. */
  timer?: ReturnType<typeof setTimeout>;
  /** Stop was pressed: the answer is being ended. */
  stopping: boolean;
  /** Deleted from Past chats meanwhile: its answer is stopped, and the chat is not saved again. */
  forgotten?: boolean;
  /** Settles once the answer is over (answered, stopped or failed). */
  done: Promise<void>;
}

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
      return detail ? t(ACTIVITY_STRINGS.commandFor, { what: detail }) : t(ACTIVITY_STRINGS.command);
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
 * An answer as far as it is written, without Lumo's lines; in the tool
 * workshop, the tool's blocks give way to a line saying it is being written.
 */
function drawAnswer(into: HTMLElement, text: string, workshop: boolean) {
  const shown = takeListens(takeTimers(text).text).text;
  if (!workshop) {
    renderAnswer(into, shown);
    return;
  }
  const words = stripDraft(shown);
  renderMarkdown(into, words.text);
  if (words.writing || words.draft) {
    into.append(h("div", { class: "forge-writing" }, h("i"), h("span", { text: t(FORGE_STRINGS.writing) })));
  }
}

/** A chip above the chat (the message being edited), with a way to leave it. */
function noteChip(label: string, title: string, onRemove: () => void): HTMLElement {
  const remove = h("button", { class: "chip-remove", title: tl(SCREEN_STRINGS.remove) }, svg(ICONS.xmark, 8));
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    onRemove();
  });
  const chip = h("div", { class: "chip", title }, h("i", { class: "chip-dot" }), h("span", { text: label }), remove);
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

/** "✓ File uploaded · name", a moment after a drop: no ×, it goes on its own. */
function uploadedChip(name: string): HTMLElement {
  const label = `${t(UPLOADED_TEXT)} · ${name}`;
  const chip = h("div", { class: "chip uploaded", title: label },
    h("span", { class: "chip-check" }, svg(ICONS.check, 9, { stroke: 2.2 })), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}

// ── Attachments ───────────────────────────────────────────────────────────────

/** A dropped, pasted or picked file, or one of what the screen button and the shortcuts added. */
type AttachKind = ItemKind | "file";

interface AttachInfo {
  kind: AttachKind;
  label: string;
  /** Under the name: what it is, and where it comes from. */
  detail: string;
  title: string;
  /** A picture of it, when there is one. */
  thumb?: string;
}

/** Each kind's icon, on the tile of a row with no picture of its own. */
const ATTACH_ICONS: Record<AttachKind, { path: string; stroke?: number }> = {
  file: { path: ICONS.doc },
  shot: { path: ICONS.display, stroke: 1.8 },
  window: { path: ICONS.window, stroke: 1.8 },
  tab: { path: ICONS.globe, stroke: 1.6 },
  selection: { path: ICONS.textLines, stroke: 1.8 },
  folder: { path: ICONS.folder, stroke: 1.8 },
};

/** The files whose picture the attachments show small. */
const PICTURE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** "File · PDF · 2.0 KB": what a file is, under its name. */
export function fileDetail(file: { name: string; size?: number }): string {
  const dot = file.name.lastIndexOf(".");
  const ext = dot > 0 && dot < file.name.length - 1 ? file.name.slice(dot + 1).toUpperCase() : "";
  return [t(ITEM_STRINGS.file), ext, file.size == null ? "" : formatSize(file.size)].filter(Boolean).join(" · ");
}

/**
 * One row of the attachments: its picture or its kind's icon, its name with
 * what it is under it, and a × that takes back this one only. A click, or
 * Enter, shows what it sends; Delete takes it back.
 */
function attachRow(item: AttachInfo, onRemove: () => void, onOpen: () => void): HTMLElement {
  const icon = ATTACH_ICONS[item.kind];
  const tile = h("span", { class: `attach-tile attach-${item.kind}` },
    item.thumb
      ? h("img", { class: "attach-thumb", src: item.thumb, alt: "", draggable: "false" })
      : svg(icon.path, 15, icon.stroke ? { stroke: icon.stroke } : {}));
  const remove = h("button", { class: "attach-remove", title: t(SCREEN_STRINGS.remove), "aria-label": t(SCREEN_STRINGS.remove) },
    svg(ICONS.xmark, 9));
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    onRemove();
  });
  const row = h(
    "div",
    { class: "attach-row", title: item.title, role: "button", tabindex: "0" },
    tile,
    h("span", { class: "attach-text" },
      h("span", { class: "attach-name", text: item.label }),
      item.detail ? h("span", { class: "attach-detail", text: item.detail }) : null),
    remove,
  );
  row.addEventListener("click", () => onOpen());
  row.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter" || key === " ") {
      e.preventDefault();
      onOpen();
    } else if (key === "Delete" || key === "Backspace") {
      e.preventDefault();
      onRemove();
    }
  });
  return row;
}

/** Where a chat's file comes from, under its name, with its icon and colour. */
const CHAT_FILE_KINDS: Record<ChatFileKind, { label: string; path: string; stroke?: number }> = {
  attached: { label: N_("Attached"), path: ICONS.paperclip, stroke: 1.8 },
  read: { label: N_("Read by the AI"), path: ICONS.doc },
  edited: { label: N_("Edited by the AI"), path: ICONS.pencil, stroke: 1.8 },
  created: { label: N_("Created by the AI"), path: ICONS.plus },
};

/** The folder a file is in, as written in its path. */
function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/**
 * One row of the chat's files: like an attachment's. A click, or Enter, opens
 * it; the right click has what else can be done with it; its ×, or Delete,
 * takes it out of the chat's context.
 */
function chatFileRow(
  file: ChatFile, missing: boolean, thumb: string | undefined, onOpen: () => void, menu: () => MenuItem[], onRemove: () => void,
): HTMLElement {
  // Attached and what the AI did, on one line: "Attached · Read by the AI".
  const ai = aiKind(file);
  const attached = file.kinds.includes("attached");
  const kind = CHAT_FILE_KINDS[attached ? "attached" : ai ?? "read"];
  const tile = h("span", { class: `attach-tile chat-file-${attached ? "attached" : ai}` },
    thumb
      ? h("img", { class: "attach-thumb", src: thumb, alt: "", draggable: "false" })
      : svg(kind.path, 15, kind.stroke ? { stroke: kind.stroke } : {}));
  const what = [attached ? t(CHAT_FILE_KINDS.attached.label) : "", ai ? t(CHAT_FILE_KINDS[ai].label) : ""];
  const detail = [...what, missing ? t(STRINGS.fileMissing) : fileDetail({ name: file.name }).split(" · ").slice(1).join(" · ")]
    .filter(Boolean).join(" · ");
  const row = h(
    "div",
    { class: missing ? "attach-row chat-file-row missing" : "attach-row chat-file-row", title: file.path, role: "button", tabindex: "0" },
    tile,
    h("span", { class: "attach-text" },
      h("span", { class: "attach-name", text: file.name }),
      h("span", { class: "attach-detail", text: detail }),
      // Where it is: its folder (the whole path is the row's tooltip).
      h("span", { class: "attach-detail attach-path", text: folderOf(file.path) })),
    removeButton(t(STRINGS.removeFromContext), onRemove),
  );
  row.addEventListener("click", () => onOpen());
  row.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter" || key === " ") {
      e.preventDefault();
      onOpen();
    } else if (key === "Delete" || key === "Backspace") {
      e.preventDefault();
      onRemove();
    }
  });
  ownMenu(row, menu);
  return row;
}

/** A row's ×. */
function removeButton(label: string, onRemove: () => void): HTMLElement {
  const remove = h("button", { class: "attach-remove", title: label, "aria-label": label }, svg(ICONS.xmark, 9));
  remove.addEventListener("click", (e) => {
    e.stopPropagation();
    onRemove();
  });
  return remove;
}

/**
 * A folder of the attachments ("Computer") or of the chat's files (one per
 * kind): its icon, its name, how many it holds on the right and a chevron. A
 * click, or Enter, opens or closes it; its rows stay in the list, hidden
 * while it is closed.
 */
function attachGroup(
  group: { label: string; detail: string; tile: string; icon: { path: string; stroke?: number }; rows: HTMLElement[] },
  open: boolean,
  onToggle: (open: boolean) => void,
): HTMLElement {
  const head = h(
    "div",
    { class: "attach-group-head", title: group.detail, role: "button", tabindex: "0", "aria-expanded": String(open) },
    h("span", { class: `attach-tile ${group.tile}` }, svg(group.icon.path, 15, group.icon.stroke ? { stroke: group.icon.stroke } : {})),
    h("span", { class: "attach-text" },
      h("span", { class: "attach-name", text: group.label }),
      group.detail ? h("span", { class: "attach-detail", text: group.detail }) : null),
    h("span", { class: "files-count attach-group-count", text: String(group.rows.length) }),
    h("span", { class: "attach-group-chevron" }, svg(ICONS.chevronRight, 9, { stroke: 2 })),
  );
  const el = h("div", { class: open ? "attach-group open" : "attach-group" }, head, h("div", { class: "attach-group-items" }, ...group.rows));
  const toggle = () => {
    const now = !el.classList.contains("open");
    el.classList.toggle("open", now);
    head.setAttribute("aria-expanded", String(now));
    onToggle(now);
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (e) => {
    const key = (e as KeyboardEvent).key;
    if (key === "Enter" || key === " ") {
      e.preventDefault();
      toggle();
    }
  });
  return el;
}

/** The icon of the attachments' "Computer" folder. */
const COMPUTER_ICON = { path: ICONS.display, stroke: 1.8 };

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
    fitEfforts();
  }

  /**
   * In a narrow picker Auto first comes up to the slider (its margin), then
   * loses "Recommended", then goes: the slider and its level never give way.
   */
  function fitEfforts() {
    const row = efforts.firstElementChild as HTMLElement | null;
    const auto = row?.querySelector<HTMLElement>(".effort-auto");
    if (!row || !auto) return;
    auto.classList.remove("no-note", "no-room");
    const over = () => row.scrollWidth > row.clientWidth;
    if (over()) auto.classList.add("no-note");
    if (over()) auto.classList.add("no-room");
  }
  // Only when the picker's width changes (opened, or the island resized).
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => fitEfforts()).observe(efforts);

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
  showPlan: () => void = () => {},
  chatDeleted: (chatId: string) => void = () => {},
  openTools: () => void = () => {},
): ViewHost {
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  // The log stays where it is read: sending a question and the answer being
  // written never scroll it. Only a chat coming on screen opens at its end.
  gentleWheel(log);
  let openedChat = true;
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
  // Everything attached to the next question, in a list of its own, so the
  // chat keeps its whole height; the badge says how many.
  const filesBadge = h("span", { class: "tool-badge" });
  const filesBtn = h("button", { class: "tool-btn files-btn", title: tl(STRINGS.attachments), "aria-label": tl(STRINGS.attachments) },
    svg(ICONS.folder, 13, { stroke: 1.8 }), filesBadge);
  // What the provider has used, when the option is on and it is known: a ring
  // that fills, and its menu.
  const usageRing = usageRingSvg();
  const usageEl = h("button", { class: "tool-btn chat-usage" }, usageRing.el);
  usageEl.style.display = "none";
  // The Plan island (island/plan.ts): its icon, left of the ring, opens and folds it.
  const planBtn = h("button", {
    class: "tool-btn plan-btn", title: tl("Plan"), "aria-label": tl("Plan"),
    onclick: () => showPlan(),
  }, svg(ICONS.plan, 13, { stroke: 1.8 }));
  planBtn.style.display = "none";
  // The ring sits right before the model it measures.
  const modelRow = h("div", { class: "model-row" },
    h("div", { class: "chat-tools" }, newBtn, historyBtn, filesBtn),
    h("div", { class: "model-side" }, planBtn, usageEl, modelBtn));

  const body = h("div", { class: "chat-body" });
  const picker = buildPicker(() => {
    body.classList.toggle("picking", picker.isOpen);
    if (picker.isOpen) {
      closeFiles();
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
    const open = picker.isOpen || ["browsing", "filing", "screening", "authorizing", "metering", "commanding"].some((c) => body.classList.contains(c));
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
  // The attachments: what goes with the next question, one row each. Their
  // title and "Chat files" beside it switch between the two lists.
  const filesCount = h("span", { class: "files-count" });
  const removeAllBtn = h("button", { class: "files-clear", text: tl(STRINGS.removeAll) });
  const filesList = h("div", { class: "picker-list files-list" });
  // How many wait shows inside the attachments' own button.
  const attachTab = h("button", { class: "picker-title files-tab on" }, h("span", { text: tl(STRINGS.attachments) }), filesCount);
  const chatFilesTab = h("button", { class: "picker-title files-tab", text: tl(STRINGS.chatFiles) });
  const chatFilesList = h("div", { class: "picker-list files-list chat-files-list" });
  chatFilesList.style.display = "none";
  const filesEl = h("div", { class: "picker files-panel" },
    h("div", { class: "files-head" }, attachTab, chatFilesTab, removeAllBtn),
    filesList, chatFilesList);
  // The screen button's menu, then the preview of a screenshot.
  const screenTitle = h("div", { class: "picker-title" });
  const screenList = h("div", { class: "picker-list" });
  const screenEl = h("div", { class: "picker screen-panel" }, screenTitle, screenList);
  const permList = h("div", { class: "picker-list" });
  const permEl = h("div", { class: "picker permissions" }, h("div", { class: "picker-title", text: t(STRINGS.permissions) }), permList);
  const usageTitle = h("div", { class: "picker-title" });
  const usageList = h("div", { class: "picker-list usage-list" });
  const usagePanel = h("div", { class: "picker usage-panel" }, usageTitle, usageList);
  // The commands' menu, over the log just above the field.
  const slashList = h("div", { class: "slash-list", role: "listbox" });
  const slashEl = h("div", { class: "slash-menu" }, slashList);
  // The tool workshop's title row and, beside the conversation, its tool.
  const forge = buildForgePanel({
    tell: (text) => {
      setInput(text);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
    back: () => openTools(),
  });
  body.append(forge.head, chipRow, log, picker.el, historyEl, filesEl, screenEl, permEl, usagePanel, slashEl, modelRow, bar);

  // A picture in a preview, clicked: it fills the whole open island, with
  // Lumo out of its way, until a click or Esc (views/picture.ts, island.ts).
  function openZoom(src: string, caption: string) {
    State.picture = { src, caption };
    State.notify();
  }
  function closeZoom() {
    closePicture();
  }
  /** A preview's picture that opens big on a click. */
  function zoomable(img: HTMLImageElement, caption: string): HTMLImageElement {
    img.classList.add("zoomable");
    img.draggable = false;
    img.addEventListener("click", (e) => {
      e.stopPropagation();
      openZoom(img.getAttribute("src") ?? img.src, caption);
    });
    return img;
  }

  // A click anywhere else — in the island or, through Rust's outside-press,
  // anywhere on the screen — closes the list that is open: the models, the
  // past chats, the screen menu, the permissions.
  function closeListsBut(target: Node | null) {
    // The big picture covers the island, over the preview it came from: a
    // press on it closes the picture only, and the preview stays open.
    if (State.picture && target != null) return;
    // The right-click menu of a row: what it does may keep the list open.
    if (target instanceof Element && target.closest(".ctx-menu")) return;
    const inside = (...els: Element[]) => target != null && els.some((el) => el.contains(target));
    if (picker.isOpen && !inside(picker.el, modelBtn)) picker.close();
    if (body.classList.contains("browsing") && !inside(historyEl, historyBtn)) closeHistory();
    if (body.classList.contains("filing") && !inside(filesEl, filesBtn)) closeFiles();
    if (body.classList.contains("screening") && !inside(screenEl, screenBtn)) closeScreen();
    if (body.classList.contains("authorizing") && !inside(permEl, permBtn)) closePermissions();
    if (body.classList.contains("metering") && !inside(usagePanel, usageEl)) closeUsage();
    // The field too: a press on it closes the commands (see the field's mousedown).
    if (slashOpen() && !inside(slashEl)) closeSlash();
  }
  document.addEventListener("mousedown", (e) => closeListsBut(e.target as Node | null), true);
  void onEvent<null>("outside-press", () => closeListsBut(null));

  const cardEl = h("div", { class: "card wash chat-card" }, body, forge.el, forge.guide, forge.help);
  const el = h("div", { class: "view" }, cardEl);
  cardEl.style.setProperty("--wash", "rgba(99,102,241,0.5)");

  /** The answers being written, by chat id: the one on screen and any left in the background. */
  const runs = new Map<string, Run>();
  /** The answer of the chat on screen, while it is written. */
  const answering = (): Run | undefined => runs.get(State.chatId);
  /** A question is being made ready (its folder, its file) before it goes. */
  let preparing = false;
  /** The chat the log shows, to notice another one coming on screen. */
  let shownChat = State.chatId;
  let renderedCount = -1;
  /** What the screen button added, waiting for the next question. */
  let screen = emptyScreen();
  /** Screenshots taken and shown, not yet kept or cancelled. */
  let preview: ScreenShot[] | null = null;
  /** Bumped when the panel closes, so a late answer is dropped (and its screenshots deleted). */
  let screenTicket = 0;
  // An answer comes token by token: where the on-screen chat's text so far is shown.
  let live: HTMLElement | null = null;
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
  /** The same for Antigravity CLI, whose quotas are asked of agy (antigravity_plan.rs). */
  let antigravityShown = false;
  const antigravityUsage = () => State.settings.chatShowUsage && State.settings.chatProvider === "antigravity-cli";

  let usageLineShown: UsageLine | null = null;

  function drawUsage(now = Date.now()) {
    const line = usageLine(State.settings, State.planUsage, seenUsage.get(State.settings.chatProvider), now, State.antigravityPlanUsage);
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
    // agy is asked again when its numbers are more than a minute old.
    if (antigravityUsage()) refreshAntigravityPlanUsage();
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
    if (State.view !== "prompt" || State.mode !== "expanded") {
      openRouterShown = false;
      antigravityShown = false;
    }
  });

  function drawModelButton() {
    const p = providerDef(State.settings.chatProvider);
    modelDot.style.background = p.accent;
    const model = activeModel(State.settings) || t(STRINGS.noModel);
    const effort = effortFor(p.id, State.settings.chatEffort);
    modelName.textContent = effort ? `${model} · ${effortLabel(effort)}` : model;
    modelBtn.classList.toggle("open", picker.isOpen);
    drawSend();
    drawPermButton();
  }

  /**
   * While the chat on screen is answered, the send button is its Stop button;
   * an edited question sends (it stops that answer and replaces it).
   */
  function drawSend() {
    const run = answering();
    const stops = run != null && editing == null;
    const shows = stops ? "stop" : "send";
    if (shows !== sendShows) {
      sendShows = shows;
      send.replaceChildren(svg(stops ? ICONS.stop : ICONS.arrowUp, 11));
      send.classList.toggle("stop", stops);
    }
    send.title = t(stops ? STRINGS.stop : STRINGS.send);
    send.setAttribute("aria-label", send.title);
    send.disabled = run?.stopping ?? false;
  }

  /** The Stop button (or Escape in the text field): what was written so far stays. */
  function stop() {
    const run = answering();
    if (!run || run.stopping) return;
    run.stopping = true;
    drawSend();
    void Bridge.chatStop(run.chatId);
  }

  // ── Copy and edit ─────────────────────────────────────────────────────────

  /** Edit on a question: its text goes back in the field; sending replaces it. */
  function startEdit(message: ChatMessage) {
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
    // The file went with the edited question: it goes again with it. One that
    // went with a later question leaves the context with it.
    if (file?.sent && file.sentWith === id) file.sent = false;
    State.chatHistory = kept;
    State.chatSession = null;
    renderedCount = -1;
    // The files of the dropped turns leave the chat's files, and Rust forgets them too.
    rewindChatFiles(State.chatId, keep);
    presenceAsked = "";
    drawChatFiles();
    await Bridge.chatRewind(State.chatId, keep);
  }

  // ── Permissions ───────────────────────────────────────────────────────────
  //
  // What Claude Code or Antigravity CLI may do without a card, from the next
  // message on: each turn starts the CLI again with that mode.

  function drawPermissions() {
    clear(permList);
    const p = providerDef(State.settings.chatProvider);
    const current = parsePermissionMode(State.settings.chatPermissionMode, p.id);
    for (const mode of permissionModesFor(p.id)) {
      const on = mode === current;
      const row = h(
        "button",
        { class: on ? "picker-model perm-row on" : "picker-model perm-row", style: `--accent:${p.accent}` },
        h(
          "span",
          { class: "perm-text" },
          h("span", { class: "picker-model-name", text: t(PERMISSION_TEXT[mode].name) }),
          h("span", {
            class: "perm-note",
            text: t(mode === "auto" && p.id === "antigravity-cli" ? AGY_AUTO_NOTE : PERMISSION_TEXT[mode].note),
          }),
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
    const mode = parsePermissionMode(State.settings.chatPermissionMode, State.settings.chatProvider);
    permBtn.classList.toggle("lit", mode !== "default");
    permBtn.title = `${t(STRINGS.permissions)} · ${t(PERMISSION_TEXT[mode].name)}`;
    permBtn.setAttribute("aria-label", permBtn.title);
  }

  permBtn.addEventListener("click", () => {
    if (body.classList.contains("authorizing")) {
      closePermissions();
      return;
    }
    openPermissions();
  });

  function openPermissions() {
    if (picker.isOpen) picker.close();
    closeHistory();
    closeScreen();
    closeUsage();
    drawPermissions();
    body.classList.add("authorizing");
    permBtn.classList.add("open");
    panelChanged();
  }

  // ── New chat, past chats, attach ──────────────────────────────────────────

  function closeHistory() {
    body.classList.remove("browsing");
    historyBtn.classList.remove("open");
    panelChanged();
  }

  function openFiles() {
    if (picker.isOpen) picker.close();
    closeHistory();
    closeScreen();
    closePermissions();
    closeUsage();
    body.classList.add("filing");
    filesBtn.classList.add("open");
    panelChanged();
    if (filesTab === "chat") drawChatFiles();
  }

  // ── The chat's files ──────────────────────────────────────────────────────

  /** Which list the panel shows: what waits, or the chat's files. */
  let filesTab: "attached" | "chat" = "attached";
  /** The folders of both lists the user opened ("Computer", a kind of the chat's files), kept open across redraws. */
  const openGroups = new Set<string>();
  /** The chat's files known to be gone, by path, and the list they were asked for. */
  let missingFiles = new Set<string>();
  let presenceAsked = "";
  /** The chat's pictures, small on their rows and big in their previews. */
  const chatPictures = new Map<string, Promise<string | null>>();
  const chatPicturesHere = new Map<string, string>();

  function showFilesTab(tab: "attached" | "chat") {
    filesTab = tab;
    attachTab.classList.toggle("on", tab === "attached");
    chatFilesTab.classList.toggle("on", tab === "chat");
    filesList.style.display = tab === "attached" ? "" : "none";
    chatFilesList.style.display = tab === "chat" ? "" : "none";
    removeAllBtn.style.display = tab === "attached" ? "" : "none";
    if (tab === "chat") drawChatFiles();
  }

  function chatPicture(path: string): Promise<string | null> {
    let asked = chatPictures.get(path);
    if (!asked) {
      asked = Bridge.chatFilePreview(path).catch(() => null);
      chatPictures.set(path, asked);
      void asked.then((src) => {
        if (!src || chatPictures.get(path) !== asked) return;
        chatPicturesHere.set(path, src);
        drawChatFiles();
      });
    }
    return asked;
  }

  /** The chat's files, newest first; asked again each time, so a new one shows at once. */
  function drawChatFiles() {
    if (filesTab !== "chat" || !body.classList.contains("filing")) return;
    const files = chatFiles(State.chatId);
    // Which are still there: asked once each time the list or the chat changes.
    const asking = `${State.chatId}\n${files.map((f) => f.path).join("\n")}`;
    if (asking !== presenceAsked) {
      presenceAsked = asking;
      const paths = files.map((f) => f.path);
      void Bridge.chatFilesPresent(paths).then((present) => {
        if (presenceAsked !== asking || !present) return;
        missingFiles = new Set(paths.filter((_, i) => present[i] === false));
        drawChatFiles();
      });
    }
    clear(chatFilesList);
    for (const file of files) {
      if (!missingFiles.has(file.path) && PICTURE_FILE.test(file.name)) void chatPicture(file.path);
    }
    // A folder for each of what happened to them: a file attached and read is in both.
    for (const { kind, files: inKind } of filesByKind(files)) {
      const rows = inKind.map((file) => chatFileRow(file, missingFiles.has(file.path), chatPicturesHere.get(file.path), () => void openChatFile(file), () => [
        { kind: "item", label: t(STRINGS.openFile), run: () => void openChatFile(file) },
        { kind: "item", label: t(STRINGS.openLocation), run: () => void revealChatFile(file) },
        { kind: "sep" },
        { kind: "item", label: t(STRINGS.copyPath), run: () => void writeClipboard(file.path) },
        { kind: "sep" },
        { kind: "item", label: t(STRINGS.removeFromContext), run: () => forgetChatFile(file) },
      ], () => forgetChatFile(file)));
      const def = CHAT_FILE_KINDS[kind];
      const key = `chat\t${kind}`;
      chatFilesList.append(attachGroup(
        { label: t(def.label), detail: "", tile: `chat-file-${kind}`, icon: def, rows },
        openGroups.has(key),
        (open) => (open ? openGroups.add(key) : openGroups.delete(key)),
      ));
    }
    if (files.length === 0) {
      chatFilesList.append(h("div", { class: "files-empty" },
        h("span", { class: "files-empty-icon" }, svg(ICONS.folder, 16, { stroke: 1.6 })),
        h("div", { class: "files-empty-title", text: t(STRINGS.noChatFiles) }),
        h("div", { class: "files-empty-hint", text: t(STRINGS.chatFilesHint) })));
    }
  }

  /** Its ×: out of the chat's list and context; the AI is told with the next question. */
  function forgetChatFile(file: ChatFile) {
    removeChatFile(State.chatId, file);
    void Bridge.chatForgetFile(State.chatId, file.name, file.path);
    presenceAsked = "";
    Sound.play("pop");
    drawChatFiles();
  }

  /** Gone since: the row says so. */
  function lostChatFile(file: ChatFile) {
    missingFiles.add(file.path);
    Sound.play("error");
    drawChatFiles();
  }

  /** A picture shows in its preview; any other file opens in its app (a program only in File Explorer). */
  async function openChatFile(file: ChatFile) {
    if (PICTURE_FILE.test(file.name) && !missingFiles.has(file.path)) {
      const image = await chatPicture(file.path);
      if (image) {
        openPreview(filePreview(file, image), null);
        return;
      }
    }
    const done = await Bridge.chatFileOpen(file.path);
    if (done === "missing") lostChatFile(file);
  }

  async function revealChatFile(file: ChatFile) {
    const done = await Bridge.chatFileReveal(file.path);
    if (done === "missing") lostChatFile(file);
  }

  function closeFiles() {
    body.classList.remove("filing");
    filesBtn.classList.remove("open");
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
    closeZoom();
    if (!body.classList.contains("screening")) return;
    screenTicket++;
    if (preview) dropShots(preview.map((s) => s.path));
    preview = null;
    body.classList.remove("screening");
    screenBtn.classList.remove("open");
    panelChanged();
  }

  /** Forgets what the screen button or a shortcut added and was not sent yet (a new chat). */
  function clearScreen() {
    dropShots(shotPaths(screen));
    screen = nextScreen(screen);
  }

  /** Remove all: every attachment waiting goes, the screenshots' files with them. */
  function removeAll() {
    if (State.droppedFile && !State.droppedFile.sent) {
      State.droppedFile = null;
      if (State.promptContext?.kind === "file") State.promptContext = null;
    }
    State.moreFiles = [];
    dropShots(shotPaths(screen));
    // What rides along by itself stays out of this message too.
    const skip = screenItems(screen).filter((it) => it.kind === "folder" || it.kind === "tab").map((it) => it.key);
    screen = { ...nextScreen(screen), autoSkip: skip };
    Sound.play("pop");
    State.notify();
    input.focus();
  }

  /** The attachments with nothing in them: what they are for. */
  function noAttachments(): HTMLElement {
    return h("div", { class: "files-empty" },
      h("span", { class: "files-empty-icon" }, svg(ICONS.paperclip, 16, { stroke: 1.6 })),
      h("div", { class: "files-empty-title", text: t(STRINGS.noAttachments) }),
      h("div", { class: "files-empty-hint", text: t(STRINGS.attachHint) }));
  }

  /** Takes back one of them (its ×, or Remove in its preview): a screenshot's file is deleted. */
  function removeItem(item: ScreenItem) {
    if (item.kind === "shot" && screen.shots.some((s) => s.path === item.key)) dropShots([item.key]);
    screen = withoutItem(screen, item);
  }

  // ── What goes with every message by itself (autoShare) ────────────────────
  //
  // Only while the setting is on, and only when the text field takes focus or
  // a message went: the folders' names and the tabs' titles, for the
  // attachments. Their listings and pages are read when the message goes.
  // Nothing found or an error: nothing shown, nothing sent.

  let peeking = false;
  let peekedAt = -Infinity;
  /** The settings as the view last saw them, to notice one being turned on or off. */
  let sharesAuto = "";

  async function peekExplorer(force: boolean) {
    const every = autoShare(State.settings);
    if (!every.folders && !every.tabs) return;
    const now = performance.now();
    if (peeking || (!force && now - peekedAt < PEEK_EVERY_MS)) return;
    peeking = true;
    peekedAt = now;
    let folders: ExplorerFolder[] = [];
    let tabs: BrowserTab[] = [];
    try {
      [folders, tabs] = await Promise.all([
        every.folders ? Bridge.screenExplorerPeekAll().catch(() => []) : Promise.resolve([]),
        every.tabs ? Bridge.screenTabs().catch(() => []) : Promise.resolve([]),
      ]);
    } finally {
      peeking = false;
    }
    const still = autoShare(State.settings);
    const before = autoKey(screen);
    screen = { ...screen, autoFolders: still.folders ? folders ?? [] : [], autoTabs: still.tabs ? tabs ?? [] : [] };
    if (autoKey(screen) !== before) State.notify();
  }

  /** What goes by itself, as a key: a change redraws the attachments. */
  function autoKey(p: PendingScreen): string {
    return [...(p.autoFolders ?? []).map((f) => f.path), ...(p.autoTabs ?? []).map((tab) => `${tab.id}\t${tab.title}`)].join("\n");
  }

  /** The folders open in File Explorer with their listings; none on an error. */
  async function explorerAll(paths: string[] = []): Promise<ExplorerFolder[]> {
    try {
      return (await Bridge.screenExplorerShare(paths)) ?? [];
    } catch (err) {
      void Bridge.log(`[explorer] ${String(err)}`);
      return [];
    }
  }

  /** What goes by itself with this message, read now, added to what the user shared. */
  async function withAuto(waiting: PendingScreen): Promise<PendingScreen> {
    const every = autoShare(State.settings);
    let shared = waiting;
    if (every.folders) {
      const extra = foldersByThemselves(waiting, await explorerAll());
      if (extra.length > 0) shared = { ...shared, folders: withFolders(shared.folders ?? [], extra) };
    }
    if (every.tabs) {
      const open = await Bridge.screenTabs().catch(() => [] as BrowserTab[]);
      const pick = tabsByThemselves(waiting, open ?? []);
      if (pick.length > 0) {
        try {
          shared = { ...shared, tabs: withTabs(shared.tabs, (await Bridge.screenTabShare(pick.map((tab) => tab.id))) ?? []) };
        } catch (err) {
          void Bridge.log(`[share] tabs: ${String(err)}`);
        }
      }
    }
    return shared;
  }

  /** What a sharing shortcut just took (island/shortcuts.ts runShared). */
  function takeShare() {
    const share = State.incomingShare;
    if (!share) return;
    State.incomingShare = null;
    if (share.kind === "screen") {
      // Each "Ask about my screen" adds its screenshot to the ones waiting.
      screen = keepShots(screen, share.shots);
    } else if (share.kind === "selection") {
      screen = withSelection(screen, share.selection);
    } else if (share.kind === "page") {
      screen = { ...screen, tabs: withTabs(screen.tabs, [share.tab]) };
    } else if (share.kind === "file") {
      // A PDF open in the browser goes as the file itself, as if attached
      // (after this draw: attaching it redraws the chat).
      const file = share.file;
      window.setTimeout(() => void useFile(file), 0);
    }
  }

  function screenStatus(text: string) {
    screenList.append(h("div", { class: "picker-status", text }));
  }

  function openScreen() {
    if (picker.isOpen) picker.close();
    closeHistory();
    closeFiles();
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
    // Only the folders' names, for the labels: nothing is listed before a click.
    const peek: Promise<ExplorerPeek> = Bridge.screenExplorerPeekAll().then(
      (folders) => ({ folders: folders ?? [], problem: "" }),
      (err) => ({ folders: [], problem: String(err).replace(/^Error:\s*/, "") }),
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
        : entry.kind === "explorers" ? String(entry.folders.length)
        : entry.kind === "tabs" ? String(entry.count)
        : "";
      const opens = entry.kind === "windows" || entry.kind === "tabs" || entry.kind === "explorers";
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

  /** One folder open in File Explorer, or all of them (`[]`), with what is in them. */
  async function shareFolders(paths: string[]) {
    const ticket = ++screenTicket;
    clear(screenList);
    try {
      const folders = (await Bridge.screenExplorerShare(paths)) ?? [];
      if (ticket !== screenTicket) return;
      if (folders.length === 0) {
        screenStatus(t(SCREEN_STRINGS.noExplorer));
        return;
      }
      screen = { ...screen, folders: withFolders(screen.folders ?? [], folders) };
      added();
    } catch (err) {
      if (ticket === screenTicket) screenStatus(String(err).replace(/^Error:\s*/, ""));
    }
  }

  async function pickEntry(entry: MenuEntry) {
    if (entry.kind === "windows") return openWindows();
    if (entry.kind === "tabs") return openTabs();
    if (entry.kind === "explorer") return shareFolders([entry.folder.path]);
    if (entry.kind === "explorers") {
      ++screenTicket;
      drawPicks(t(SCREEN_STRINGS.explorers), folderPicks(entry.folders), (pick) => void shareFolders(typeof pick.id === "string" ? [pick.id] : []));
      return;
    }
    const ticket = ++screenTicket;
    clear(screenList);
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
          zoomable(h("img", { src: s.preview, alt: screenLabel(s.display) }) as HTMLImageElement, screenLabel(s.display)),
          h("figcaption", { text: screenLabel(s.display) }),
        ),
      );
    }
    const keep = h("button", { class: "btn primary", text: t(STRINGS.attachShots) });
    const cancel = h("button", { class: "btn secondary", text: t(STRINGS.cancel) });
    keep.addEventListener("click", () => {
      if (!preview) return;
      screen = keepShots(screen, preview);
      preview = null; // kept: closing must not delete them
      closeScreen();
      Sound.play("attach");
      State.notify();
      // Attached only: the question is written, and sent, when the user wants.
      input.focus();
    });
    cancel.addEventListener("click", () => {
      closeScreen(); // deletes the previewed screenshots
      Sound.play("pop");
      input.focus();
    });
    screenList.append(row, h("div", { class: "screen-actions" }, cancel, keep));
  }

  // ── What an attachment sends ──────────────────────────────────────────────

  /**
   * The screen panel, showing what an attachment sends: Remove takes it back,
   * Close keeps it; either way the attachments it was opened from come back.
   * A chat's file has no Remove (`onRemove` null).
   */
  function openPreview(blocks: PreviewBlock[], onRemove: (() => void) | null) {
    if (picker.isOpen) picker.close();
    closeHistory();
    closeFiles();
    closePermissions();
    closeUsage();
    if (body.classList.contains("screening")) closeScreen();
    screenTicket++;
    body.classList.add("screening");
    panelChanged();
    screenTitle.textContent = t(PREVIEW_STRINGS.title);
    clear(screenList);
    // One picture alone takes all the room the panel has.
    const single = blocks.length === 1 && blocks[0].image !== "";
    const items = h("div", { class: single ? "screen-preview single" : "screen-preview" });
    for (const b of blocks) {
      items.append(h(
        "div",
        { class: "screen-preview-item" },
        h("div", { class: "screen-preview-head", text: b.heading }),
        b.detail ? h("div", { class: "screen-preview-detail", text: b.detail }) : null,
        b.image ? zoomable(h("img", { class: "screen-preview-img", src: b.image, alt: b.heading }) as HTMLImageElement, b.heading) : null,
        b.note ? h("div", { class: "screen-preview-note", text: b.note }) : null,
        b.text ? h("pre", { class: "screen-preview-text", text: b.text }) : null,
      ));
    }
    const remove = onRemove ? h("button", { class: "btn secondary", text: t(SCREEN_STRINGS.remove) }) : null;
    const close = h("button", { class: "btn primary", text: t(PREVIEW_STRINGS.close) });
    remove?.addEventListener("click", () => {
      closeScreen();
      onRemove?.();
      openFiles();
      input.focus();
    });
    close.addEventListener("click", () => {
      closeScreen();
      openFiles();
      input.focus();
    });
    screenList.append(items, h("div", { class: "screen-actions" }, remove, close));
  }

  /** A file's preview, with its picture when it is one in the inbox. */
  async function openFilePreview(file: { name: string; path: string; size?: number }, onRemove: () => void) {
    openPreview(filePreview(file), onRemove);
    const ticket = screenTicket;
    const image = await filePicture(file.path);
    if (image && ticket === screenTicket && body.classList.contains("screening")) {
      openPreview(filePreview(file, image), onRemove);
    }
  }

  // A picture attached as a file shows itself small on its row, and big in
  // its preview: asked once for both, and forgotten once it is no longer attached.
  const filePictures = new Map<string, Promise<string | null>>();
  const filePicturesHere = new Map<string, string>();
  function filePicture(path: string): Promise<string | null> {
    let asked = filePictures.get(path);
    if (!asked) {
      asked = Bridge.filePreview(path).catch(() => null);
      filePictures.set(path, asked);
      void asked.then((src) => {
        if (!src || filePictures.get(path) !== asked) return;
        filePicturesHere.set(path, src);
        State.notify(); // its row shows it
      });
    }
    return asked;
  }
  /** Only the files still attached keep their pictures. */
  function forgetFilePictures(keep: ReadonlySet<string>) {
    for (const path of filePictures.keys()) {
      if (!keep.has(path)) {
        filePictures.delete(path);
        filePicturesHere.delete(path);
      }
    }
  }

  /** The past chats of what is on screen: the chat's, or the tool workshop's. */
  function slotChats(): SavedChat[] {
    const workshop = State.chatSlot === "forge";
    return loadChats().filter((c) => isWorkshopChat(c.id) === workshop);
  }

  function drawHistory() {
    clear(historyList);
    const chats = slotChats();
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
        // The plan it made goes with it, finished or not.
        chatDeleted(c.id);
        dropChatFiles(c.id);
        // Being answered in the background: that answer ends with it.
        const run = runs.get(c.id);
        if (run) {
          run.forgotten = true;
          if (!run.stopping) void Bridge.chatStop(c.id);
          run.stopping = true;
        }
        // The chat on screen is gone: so is it from the screen.
        if (c.id === State.chatId) {
          newChat();
          return;
        }
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
      const first = query ? searchChats(slotChats(), query)[0]?.chat : slotChats()[0];
      if (first) openChat(first);
    }
  });

  function openChat(c: SavedChat) {
    editing = null;
    const run = runs.get(c.id);
    if (run) {
      // Still being answered: it comes back as it is, its answer still coming.
      State.chatHistory = run.history;
      State.chatSession = run.session;
    } else {
      // Rust takes every turn back as it is (chat_restore): each one's place there is its place here.
      State.chatHistory = c.turns.map((turn, i) => ({ id: nextId++, role: turn.role, content: turn.content, turn: i }));
      State.chatSession = c.session;
      void Bridge.chatRestore(c.id, c.turns, c.session);
    }
    State.chatId = c.id;
    State.droppedFile = null;
    State.promptContext = null;
    closeScreen();
    clearScreen();
    closeHistory();
    Sound.play("blip");
    renderedCount = -1;
    State.notify();
    onHeightChange();
    input.focus();
  }

  /** A new chat; an answer still being written in the one before goes on in the background. */
  function newChat() {
    if (editing != null) setInput("");
    editing = null;
    State.startChat();
    State.droppedFile = null;
    State.promptContext = null;
    closeScreen();
    clearScreen();
    void Bridge.chatReset(State.chatId);
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
      h("button", { class: "welcome-chip", onclick: run }, h("span", { text: t(label) }));
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

  /** The tool workshop's empty chat: a question, and three ways to start. */
  function forgeWelcome(): HTMLElement {
    const start = (label: string, run: () => void) =>
      h("button", { class: "welcome-chip", onclick: run }, h("span", { text: t(label) }));
    const write = (text: string) => {
      setInput(t(text));
      void Bridge.focusWindow(true);
      window.setTimeout(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }, 60);
    };
    return h(
      "div",
      { class: "chat-welcome forge-welcome" },
      h("div", { class: "welcome-title", text: t(FORGE_STRINGS.welcome) }),
      h("div", { class: "forge-welcome-sub", text: t(FORGE_STRINGS.welcomeSub) }),
      h(
        "div",
        { class: "welcome-chips" },
        start(FORGE_STRINGS.startNew, () => write(FORGE_STRINGS.startNewText)),
        start(FORGE_STRINGS.startScript, () => {
          write(FORGE_STRINGS.startScriptText);
          void attach();
        }),
        start(FORGE_STRINGS.startApp, () => write(FORGE_STRINGS.startAppText)),
      ),
    );
  }

  // ── The tool workshop ─────────────────────────────────────────────────────

  /** What the slot left behind waits for it: what the screen button added, the field, by slot. */
  const parkedUi: Partial<Record<"chat" | "forge", { screen: typeof screen; text: string }>> = {};
  let shownSlot = State.chatSlot;
  /** The newest draft of the workshop chat on screen, worked out again when its messages change. */
  let draftSeen = "";
  let draft: ToolDraft | null = null;

  /** The other slot came on screen (State.useSlot): its field, its attachments, its chat in Rust. */
  function slotChanged() {
    parkedUi[shownSlot] = { screen, text: input.value };
    if (picker.isOpen) picker.close();
    closeHistory();
    closeFiles();
    closeScreen();
    closePermissions();
    closeUsage();
    editing = null;
    const back = parkedUi[State.chatSlot];
    delete parkedUi[State.chatSlot];
    screen = back?.screen ?? emptyScreen();
    setInput(back?.text ?? "");
    shownSlot = State.chatSlot;
    // Rust lets a chat go once another is on screen: it gets this one back as it is.
    if (!runs.has(State.chatId) && State.chatHistory.length > 0) {
      State.chatHistory = State.chatHistory.map((m, i) => ({ ...m, turn: i }));
      void Bridge.chatRestore(State.chatId, State.chatHistory.map((m) => ({ role: m.role, content: m.content })), State.chatSession);
    }
    const workshop = State.chatSlot === "forge";
    cardEl.classList.toggle("forge", workshop);
    cardEl.style.setProperty("--wash", workshop ? "rgba(245,165,36,0.42)" : "rgba(99,102,241,0.5)");
    renderedCount = -1;
    // A GitHub event that came while the workshop was on screen goes now.
    if (!workshop && heard.length) window.setTimeout(() => runHeard(), 0);
  }

  /**
   * The Tools tab opened the workshop. Add a tool goes on with the tool being
   * made, unless it is saved as it is (then a new one starts); Change with
   * Lumo goes back to the workshop chat already on that tool, or opens one.
   */
  function takeForgeAsk() {
    const ask = State.forgeAsk;
    if (!ask || State.chatSlot !== "forge") return;
    State.forgeAsk = null;
    if (ask.edit) {
      void openOnTool(ask.edit);
      return;
    }
    const current = latestDraft(State.chatHistory);
    const link = savedLink(State.chatId);
    if (current && link?.key === draftKey(current) && !answering()) newChat();
  }

  /**
   * A new workshop chat on a saved tool: it starts with the tool as it is,
   * which the AI sees as its own answer, and saving updates that tool.
   */
  async function openOnTool(tool: ToolInfo) {
    // The newest workshop chat that opened on (or saved) this tool, as it was left.
    const onTool = (id: string) => isWorkshopChat(id) && savedLink(id)?.tool === tool.id;
    if (onTool(State.chatId) && State.chatHistory.length > 0) return;
    const last = loadChats().filter((c) => onTool(c.id)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (last) {
      openChat(last);
      return;
    }
    const files = (await Bridge.toolsFiles(tool.id)) ?? [];
    newChat();
    const seed = draftOf(tool, files.map(([name, content]) => ({ name, content })));
    const turns: { role: "user" | "assistant"; content: string }[] = [
      { role: "user", content: t(FORGE_STRINGS.editAsk, { name: tool.name }) },
      { role: "assistant", content: `${t(FORGE_STRINGS.editHere, { name: tool.name })}\n\n${blocksOf(seed)}` },
    ];
    State.chatHistory = turns.map((turn, i) => ({ id: nextId++, role: turn.role, content: turn.content, turn: i }));
    void Bridge.chatRestore(State.chatId, turns, null);
    const parsed = latestDraft(State.chatHistory);
    if (parsed) linkSaved(State.chatId, tool.id, draftKey(parsed));
    saveChat({ id: State.chatId, title: chatTitle(turns), updatedAt: Date.now(), provider: State.settings.chatProvider, session: null, turns });
    renderedCount = -1;
    State.notify();
  }

  /**
   * Saves a chat in the history when its question goes (so it can be found
   * again while it is answered) and after its answer, on screen or not.
   */
  function remember(run: Run) {
    if (run.forgotten) return;
    const turns = run.history.map((m) => ({ role: m.role, content: m.content }));
    if (turns.length === 0) return;
    saveChat({
      id: run.chatId,
      title: chatTitle(turns),
      updatedAt: Date.now(),
      provider: run.provider,
      session: run.session,
      turns,
    });
    if (body.classList.contains("browsing")) drawHistory();
  }

  async function attach() {
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
    // A file is already waiting: this one goes with it, in the same question.
    const waiting = State.droppedFile;
    if (waiting && !waiting.sent) {
      const known = [waiting, ...State.moreFiles].some((f) => f.path === file.path);
      if (!known) State.moreFiles = [...State.moreFiles, { name: file.name, path: file.path }];
      Sound.play("attach");
      State.notify();
      return;
    }
    // It joins the chat open now: every provider takes it with the next question.
    State.droppedFile = { name: file.name, path: file.path };
    State.promptContext = { kind: "file", name: file.name, path: file.path };
    Sound.play("attach");
    State.notify();
  }

  /**
   * A question sent with a shared folder: the file of it the question names
   * goes with it, unless a file the user added is still waiting.
   */
  async function attachNamed(folders: readonly ExplorerFolder[], query: string) {
    if (State.droppedFile && !State.droppedFile.sent) return;
    for (const folder of folders) {
      try {
        const file = await Bridge.explorerAttach(folder.path, query);
        if (file) await useFile(file);
      } catch (err) {
        void Bridge.log(`[explorer] ${String(err)}`);
      }
    }
  }

  newBtn.addEventListener("click", newChat);
  attachBtn.addEventListener("click", () => void attach());
  screenBtn.addEventListener("click", () => {
    if (body.classList.contains("screening")) closeScreen();
    else openScreen();
  });
  filesBtn.addEventListener("click", () => {
    if (body.classList.contains("filing")) closeFiles();
    else openFiles();
  });
  removeAllBtn.addEventListener("click", () => removeAll());
  attachTab.addEventListener("click", () => showFilesTab("attached"));
  chatFilesTab.addEventListener("click", () => showFilesTab("chat"));
  historyBtn.addEventListener("click", () => {
    if (body.classList.contains("browsing")) {
      closeHistory();
      return;
    }
    openHistory();
  });

  function openHistory() {
    if (picker.isOpen) picker.close();
    closeFiles();
    closeScreen();
    closePermissions();
    closeUsage();
    historySearch.value = "";
    drawHistory();
    body.classList.add("browsing");
    historyBtn.classList.add("open");
    panelChanged();
    historySearch.focus();
  }

  modelBtn.addEventListener("click", () => {
    if (picker.isOpen) picker.close();
    else picker.open();
  });

  /**
   * What the closed island says the chat is doing: the answer of the chat on
   * screen, else the last one left going in the background.
   */
  function drawIslandActivity() {
    const run = answering() ?? [...runs.values()].pop();
    const next = run ? { label: run.text === "" || run.dots ? activityLabel(run.activity) : null } : null;
    const now = State.chatActivity;
    if (next == null ? now == null : now != null && now.label === next.label) return;
    State.chatActivity = next;
    State.notify();
  }

  void onEvent<{ chat: string; text: string }>("chat-delta", ({ chat, text }) => {
    const run = runs.get(chat);
    if (!run || !text) return; // nothing visible yet: the dots stay
    run.text = text;
    run.dots = false;
    // The closed island says it is writing now.
    drawIslandActivity();
    // Another chat is on screen: this one's text shows when it comes back.
    if (chat !== State.chatId) return;
    // The text shows: the dots and what the answer was doing go.
    log.querySelector(".typing")?.parentElement?.remove();
    if (!live) {
      live = h("div", { class: "reply" });
      log.append(h("div", { class: "chat-row" }, live));
    }
    drawAnswer(live, text, isWorkshopChat(chat));
  });

  /**
   * The line next to the dots says what the answer is doing now. `again`:
   * Claude Code went back to its tools after some text, so the dots come
   * back under it.
   */
  function showActivity(run: Run, next: ChatActivity, again = false) {
    run.activity = next;
    if (again && run.text) run.dots = true;
    drawIslandActivity();
    if (run.chatId !== State.chatId) return;
    const label = log.querySelector(".typing-label");
    if (label) label.textContent = activityLabel(next);
    else if (again && live) log.append(typingDots(activityLabel(next)));
  }

  // A file the answer read, edited or created: the chat's files list it.
  void onEvent<ChatFileEvent>("chat-file", ({ chat, kind, path }) => {
    addChatFile(chat, kind, path, undefined, undefined, runs.get(chat)?.turn);
    if (chat === State.chatId) drawChatFiles();
  });

  void onEvent<{ chat: string; activity: ChatActivity }>("chat-activity", ({ chat, activity }) => {
    const run = runs.get(chat);
    if (!run || !activity) return;
    clearTimeout(run.timer);
    showActivity(run, activity, true);
  });

  /** The answer a message typed meanwhile waits for (`sendAfter`). */
  let waitingFor: Run | null = null;

  /**
   * What is typed while `run` is written goes as soon as it ends, if it is
   * still in the field and its chat on screen. After Stop it stays there.
   */
  function sendAfter(run: Run) {
    if (waitingFor === run) return;
    waitingFor = run;
    input.title = t("Sent as soon as this answer ends");
    void run.done.then(() => {
      if (waitingFor !== run) return;
      waitingFor = null;
      input.title = "";
      if (!run.stopping && State.chatId === run.chatId && input.value.trim() && !answering()) void submit();
    });
  }

  /**
   * Sends what is typed, or `auto`: a message Lumo writes itself (a GitHub
   * event the chat listened for), which leaves the field, the files waiting
   * and the screen alone.
   */
  async function submit(auto?: string) {
    const query = auto ?? input.value.trim();
    if (!query || preparing) return;
    // "/timer 10m pasta": a timer on the closed island, nothing sent to the AI.
    const timer = auto ? null : /^\/timer\s+(\S+)\s*(.*)$/i.exec(query);
    const timerMs = timer ? parseDuration(timer[1]) : null;
    if (timer && timerMs != null) {
      setInput("");
      compactTimer(timerMs, timer[2]);
      Sound.play("blip");
      return;
    }
    // "/pdfcraft merge them": the AI is asked to use that tool for what follows;
    // the chat shows what was typed.
    const called = auto ? null : toolCommand(query, State.settings.chatProvider, State.tools);
    const asked = called ? toolAsk(called.tool, called.rest) : query;
    // "/new", "/model"…: Lumo's own, run here like a pick in the menu.
    const own = auto || editing != null ? null : lumoCommand(query, State.settings.chatProvider);
    if (own) {
      closeSlash();
      setInput("");
      runLumo(own);
      return;
    }
    // The chat on screen is being answered: the next question waits in the
    // field and goes once it is done, but an edited one stops it and replaces it.
    const current = answering();
    if (current) {
      if (!auto && editing == null) sendAfter(current);
      if (auto || editing == null) return;
      const here = State.chatId;
      preparing = true;
      stop();
      await current.done;
      preparing = false;
      if (State.chatId !== here || editing == null || answering()) return;
    }
    if (picker.isOpen) picker.close();
    closeHistory();
    closeScreen();
    if (!auto) setInput("");
    Sound.play("send");

    let run: Run;
    let finish = () => {};
    // What went with the question, given back to the field if it did not go.
    let giveBack = (_all: boolean) => {};
    /** The files that went with the question: the chat's files once it is answered. */
    let sent: { name: string; path: string }[] = [];
    let question: ChatMessage;
    let context: ChatContext | null;
    let screenContext: ScreenContext | null;
    preparing = true;
    try {
      // An edited question replaces the one it came from, and what followed it.
      const edited = auto ? null : editing;
      if (!auto) editing = null;
      if (edited != null) await rewindTo(edited);

      // What the screen button added goes once, then the chip goes.
      const waiting = screen;
      const shared = auto ? waiting : await withAuto(waiting);
      if (!auto && (shared.folders?.length ?? 0) > 0) await attachNamed(shared.folders ?? [], query);

      // The file goes with the first question asked after it was added, once.
      const file = auto ? null : State.droppedFile;
      context = file && !file.sent ? { kind: "file", name: file.name, path: file.path } : null;
      const more = auto ? [] : State.moreFiles;
      screenContext = auto ? null : screenPayload(shared, more);
      sent = [...(file && context ? [file] : []), ...more];

      // The chat it is asked in, whichever is on screen when its answer comes.
      const chatId = State.chatId;
      const history = State.chatHistory;
      // Where the question goes in Rust's conversation: after every turn recorded.
      const turn = history.reduce((n, m) => (m.turn != null ? Math.max(n, m.turn + 1) : n), 0);
      question = { id: nextId++, role: "user", content: query };
      history.push(question);

      // What went with it leaves the field, which is ready for the next question.
      if (file && context) {
        file.sent = true;
        file.sentWith = question.id;
      }
      if (more.length > 0) State.moreFiles = State.moreFiles.filter((f) => !more.includes(f));
      // Rust deletes the screenshots once the turn went: what went no longer
      // waits, even if something changed the attachments meanwhile.
      const cleared = auto ? null : screen === waiting ? nextScreen(screen) : null;
      if (cleared) screen = cleared;
      else if (!auto && screenContext) screen = afterSent(screen, shared);
      giveBack = (all) => {
        // A file goes with the next question, unless the user moved on.
        if (file && context && State.droppedFile === file) file.sent = false;
        if (State.chatId !== chatId) return;
        const back = more.filter((f) => !State.moreFiles.some((m) => m.path === f.path));
        if (back.length > 0) State.moreFiles = [...back, ...State.moreFiles];
        // Rust deletes the screenshots once a turn went, stopped or not: only a failed one keeps them.
        if (all && cleared && screen === cleared) screen = waiting;
      };

      const activity = firstActivity(State.settings.chatProvider, context, screenContext);
      const done = new Promise<void>((resolve) => (finish = resolve));
      run = {
        chatId,
        history,
        session: State.chatSession,
        provider: State.settings.chatProvider,
        turn,
        text: "",
        activity,
        dots: false,
        stopping: false,
        done,
      };
      const started = run;
      if (activity !== THINKING) run.timer = setTimeout(() => showActivity(started, THINKING), FIRST_ACTIVITY_MS);
      runs.set(chatId, run);
    } finally {
      preparing = false;
    }
    // Found in Past chats while it is answered, to come back to it.
    remember(run);
    State.stateOverride = "thinking";
    drawIslandActivity();
    drawModelButton();
    State.notify();
    onHeightChange();

    let outcome: "finished" | "error" | null = null;
    try {
      const reply = await Bridge.chatSend(run.chatId, asked, context, screenContext);
      // Stopped before anything was written: the question stays, unanswered,
      // and Rust kept nothing of it (the file goes with the next one).
      const recorded = !reply.stopped || reply.text !== "";
      if (recorded && reply.turns != null) question.turn = reply.turns - 2;
      // A timer the answer asked for starts now; its line is not shown.
      const timed = takeTimers(reply.text);
      for (const timer of timed.timers) compactTimer(timer.ms, timer.label);
      // What it asked Lumo to listen for on GitHub, and to stop listening to.
      const answered = takeListens(timed.text);
      for (const stop of answered.stops) void Bridge.listenCancel(stop.repo, stop.number);
      const added = await Promise.all(answered.listens.map((ask) => Bridge.listenAdd(ask.repo, ask.number, ask.until, ask.task, run.chatId)));
      // A line Lumo could not read or start is said, never just dropped.
      const unheard = [...answered.unread, ...answered.listens.filter((_, i) => !added[i]).map((a) => `${a.repo}#${a.number} ${a.until}`)];
      const content = unheard.length
        ? `${answered.text}\n\n_${t(LISTEN_STRINGS.unread, { what: unheard.join(", ") })}_`.trim()
        : answered.text;
      if (recorded) {
        for (const f of sent) addChatFile(run.chatId, "attached", f.path, f.name, Date.now(), question.turn ?? run.turn);
        run.history.push({
          id: nextId++,
          role: "assistant",
          content,
          stopped: reply.stopped || undefined,
          turn: reply.turns != null ? reply.turns - 1 : undefined,
        });
      } else {
        giveBack(false);
      }
      if (reply.session) run.session = reply.session;
      if (State.chatId === run.chatId) {
        State.chatSession = run.session;
        void peekExplorer(true);
      }
      remember(run);
      askOpenRouter(true);
      // An answer from agy used some of its quota: asked again (at most once a minute).
      if (antigravityUsage()) refreshAntigravityPlanUsage();
      outcome = reply.stopped ? null : "finished";
      Sound.play(reply.stopped ? "pop" : "finish");
      if (!reply.stopped) noticeAway(COMPACT_TEXT.answered);
    } catch (err) {
      giveBack(true);
      outcome = "error";
      noticeAway(COMPACT_TEXT.failed);
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      State.view = "note";
      Sound.play("error");
    } finally {
      clearTimeout(run.timer);
      runs.delete(run.chatId);
      finish();
      // Another answer still being written: Lumo keeps thinking.
      if (runs.size === 0) settle(outcome);
      if (State.chatId === run.chatId) {
        live = null;
        renderedCount = -1; // the finished answer replaces the streamed one
        if (!auto) input.focus();
      }
      drawIslandActivity();
      drawModelButton();
      State.notify();
      onHeightChange();
      // A GitHub event that came in meanwhile goes now.
      if (heard.length) window.setTimeout(() => runHeard(), 0);
    }
  }

  // ── Listening to GitHub ───────────────────────────────────────────────────

  /** GitHub events with something for Claude to do, waiting for the chat to be free. */
  const heard: ListenFired[] = [];

  /**
   * The next one goes to Claude in the chat that asked for it: that chat is
   * opened from the history when another is on screen (a new one when it was
   * deleted; the message says all it needs).
   */
  function runHeard() {
    // The tool workshop is on screen: the event waits for the chat to come back.
    if (State.chatSlot !== "chat") return;
    // Its chat answers one message at a time: the event waits for that answer.
    const next = heard[0];
    if (!next || preparing || runs.has(next.watch.chatId)) return;
    const fired = heard.shift();
    if (!fired) return;
    if (State.chatId !== fired.watch.chatId) {
      const saved = loadChats().find((c) => c.id === fired.watch.chatId);
      if (saved) openChat(saved);
      else newChat();
    }
    void submit(listenMessage(fired));
  }

  void onEvent<ListenFired>("listen-fired", (fired) => {
    if (!fired) return;
    Sound.play(fired.met ? "finish" : "error");
    compactNotice(`GitHub · ${fired.summary}`, LISTEN_COLOR, 10_000);
    if (!fired.watch.task) return;
    heard.push(fired);
    runHeard();
  });
  void onEvent<ListenWatch[]>("listen-changed", (list) => {
    State.listening = list ?? [];
    State.notify();
  });
  void Bridge.listenList().then((list) => {
    if (!list) return;
    State.listening = list;
    State.notify();
  });

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


  // ── Commands ("/") ────────────────────────────────────────────────────────

  /** What Claude Code's last turn said it has (`chat-commands`); null before one. */
  let cliCommands: string[] | null = null;
  void Bridge.chatCommands().then((list) => {
    if (cliCommands == null && Array.isArray(list)) cliCommands = list;
  });
  void onEvent<string[]>("chat-commands", (list) => {
    if (Array.isArray(list)) cliCommands = list;
  });
  /** The commands the menu shows now, and the one Enter would run. */
  let slashItems: SlashCommand[] = [];
  let slashAt = 0;
  /** The field has the focus (a press on it reopens the menu only when it had not). */
  let fieldFocused = false;
  let reopenOnClick = false;

  function slashOpen(): boolean {
    return body.classList.contains("commanding");
  }

  /** Shows the menu for what is typed, if it starts with "/" and something matches; else closes it. */
  function showSlash() {
    const query = slashQuery(input.value);
    const items = query == null ? [] : slashMatches(slashCommands(State.settings.chatProvider, cliCommands, State.tools), query);
    if (items.length === 0) {
      closeSlash();
      return;
    }
    slashItems = items;
    // The best match is the one Enter runs.
    slashAt = 0;
    drawSlash();
    if (!slashOpen()) {
      // Over the log, its bottom just above the field.
      const top = bar.offsetTop;
      if (Number.isFinite(top) && top > 0) {
        slashEl.style.bottom = `${body.clientHeight - top + 6}px`;
        slashEl.style.left = `${bar.offsetLeft}px`;
      }
      body.classList.add("commanding");
      panelChanged();
    }
  }

  function closeSlash() {
    if (!slashOpen()) return;
    body.classList.remove("commanding");
    panelChanged();
  }

  function drawSlash() {
    clear(slashList);
    slashItems.forEach((c, i) => {
      const note = c.text ?? (c.note ? t(c.note) : c.kind === "cli" ? "Claude Code" : "");
      const row = h(
        "button",
        {
          class: `slash-row${i === slashAt ? " on" : ""}`,
          role: "option",
          "aria-selected": String(i === slashAt),
        },
        h("span", { class: "slash-icon" }, slashIcon(c.icon)),
        h("span", { class: "slash-name", text: c.name }),
        h("span", { class: "slash-note", text: note }),
      );
      // The field keeps the focus: the press is the menu's, not a press elsewhere.
      row.addEventListener("mousedown", (e) => e.preventDefault());
      row.addEventListener("mousemove", () => {
        if (slashAt === i) return;
        slashAt = i;
        drawSlash();
      });
      row.addEventListener("click", () => pickSlash(c, false));
      slashList.append(row);
    });
    (slashList.children[slashAt] as HTMLElement | undefined)?.scrollIntoView?.({ block: "nearest" });
  }

  /**
   * Runs a command from the menu. `complete` (Tab): only its name goes in the
   * field, followed by a space, for what goes with it.
   */
  function pickSlash(c: SlashCommand | undefined, complete: boolean) {
    if (!c) return;
    closeSlash();
    input.focus();
    if (complete || c.args) {
      setInput(`/${c.name} `);
      input.setSelectionRange(input.value.length, input.value.length);
      return;
    }
    if (c.kind !== "lumo") {
      setInput(`/${c.name}`);
      void submit();
      return;
    }
    setInput("");
    if (c.action) runLumo(c.action);
  }

  /** A command's icon, drawn as its button draws it: some are filled, the others stroked. */
  function slashIcon(name: string): SVGSVGElement {
    const path = ICONS[name as keyof typeof ICONS] ?? ICONS.terminal;
    return FILLED_ICONS.has(name) ? svg(path, 12) : svg(path, 13, { stroke: 1.8 });
  }

  /** One of Lumo's own commands, as its button would. */
  function runLumo(action: SlashAction) {
    switch (action) {
      case "new":
        newChat();
        break;
      case "history":
        openHistory();
        break;
      case "model":
      case "effort":
        if (!picker.isOpen) picker.open();
        break;
      case "attach":
        void attach();
        break;
      case "screen":
        openScreen();
        break;
      case "permissions":
        openPermissions();
        break;
      case "timer":
        setInput("/timer ");
        input.focus();
        break;
    }
  }

  /** Arrows, Enter, Tab and Escape while the menu is open; true when the key was the menu's. */
  function slashKey(ke: KeyboardEvent): boolean {
    if (!slashOpen() || ke.isComposing) return false;
    const n = slashItems.length;
    const step = (d: number) => {
      slashAt = (((slashAt + d) % n) + n) % n;
      drawSlash();
    };
    switch (ke.key) {
      case "ArrowDown":
        step(1);
        return true;
      case "ArrowUp":
        step(-1);
        return true;
      case "Enter":
        if (ke.shiftKey) return false;
        pickSlash(slashItems[slashAt], false);
        return true;
      case "Tab":
        pickSlash(slashItems[slashAt], true);
        return true;
      case "Escape":
        closeSlash();
        return true;
    }
    return false;
  }

  input.addEventListener("input", showSlash);
  input.addEventListener("focus", () => (fieldFocused = true));
  input.addEventListener("blur", () => {
    fieldFocused = false;
    closeSlash();
  });
  // A press on the field closes the menu (the document's press did) and,
  // when the field had lost the focus, opens it again for what is typed.
  input.addEventListener("mousedown", () => (reopenOnClick = !fieldFocused && !slashOpen()));
  input.addEventListener("click", () => {
    if (reopenOnClick) showSlash();
    reopenOnClick = false;
  });

  input.addEventListener("paste", (e) => {
    const data = (e as ClipboardEvent).clipboardData;
    if (pasteAction(data) === "text") return;
    e.preventDefault();
    void pasteAttach(pastedFiles(data));
  });
  input.addEventListener("focus", () => void peekExplorer(false));

  send.addEventListener("click", () => {
    if (answering() && editing == null) stop();
    else void submit();
  });
  // The field stays open while an answer is written: the next question can be
  // typed, and goes with Enter once the answer is done (or stopped).
  input.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    const key = ke.key;
    if (slashKey(ke)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
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
    } else if (key === "Escape" && editing != null) {
      e.preventDefault();
      cancelEdit();
    } else if (key === "Escape" && answering()) {
      e.preventDefault();
      stop();
    }
    e.stopPropagation(); // Escape closes the island, not the chat
  });

  return {
    el,
    sync() {
      if (State.chatSlot !== shownSlot) slotChanged();
      takeForgeAsk();
      const workshop = State.chatSlot === "forge";
      if (workshop) {
        const seen = `${State.chatId}\t${State.chatHistory.length}\t${State.chatHistory.at(-1)?.content.length ?? 0}`;
        if (seen !== draftSeen) {
          draftSeen = seen;
          draft = latestDraft(State.chatHistory);
        }
        forge.sync(State.chatId, draft);
      }
      micBtn.hidden = workshop;
      takeShare();
      if (State.planIcon && planBtn.style.display === "none") {
        // It just landed: a little pop.
        planBtn.classList.remove("pop");
        void planBtn.offsetWidth;
        planBtn.classList.add("pop");
      }
      planBtn.style.display = State.planIcon ? "" : "none";
      planBtn.classList.toggle("open", State.planOpen);
      // Another chat came on screen (here, or a new chat from the menu or a
      // shortcut): the log is drawn again, with its answer if one is coming.
      if (State.chatId !== shownChat) {
        shownChat = State.chatId;
        live = null;
        renderedCount = -1;
        openedChat = true;
        drawIslandActivity();
        drawChatFiles();
      }
      const run = answering();
      // An email's button asked something: it goes at once (after this draw).
      const ask = State.chatAsk;
      if (ask && !run && !preparing) {
        State.chatAsk = null;
        setInput(ask);
        window.setTimeout(() => void submit(), 0);
      }
      const every = autoShare(State.settings);
      const everyKey = `${every.folders}\t${every.tabs}`;
      if (everyKey !== sharesAuto) {
        sharesAuto = everyKey;
        screen = {
          ...screen,
          autoFolders: every.folders ? screen.autoFolders : [],
          autoTabs: every.tabs ? screen.autoTabs : [],
          autoSkip: [],
        };
        if (every.folders || every.tabs) void peekExplorer(true);
      }
      // The edited question left the chat another way (a new chat, a file): nothing to replace.
      if (editing != null && !State.chatHistory.some((m) => m.id === editing)) editing = null;
      // The file that went with a question is the chat's now: only what waits is listed.
      const file = State.droppedFile && !State.droppedFile.sent ? State.droppedFile : null;
      const moreFiles = State.moreFiles;
      const files = [...(file ? [file] : []), ...moreFiles];
      const items = screenItems(screen);
      const pictures = files.map((f) => (PICTURE_FILE.test(f.name) ? filePicturesHere.get(f.path) ?? "" : ""));
      const attached = files.length + items.length;
      const filesKey = [
        ...files.map((f, i) => `file\t${f.path}\t${fileDetail(f)}\t${pictures[i] ? "picture" : ""}`),
        ...items.map((it) => `${it.kind}\t${it.key}\t${it.label}\t${it.detail}`),
      ].join("\n");
      if (filesList.dataset.key !== filesKey) {
        filesList.dataset.key = filesKey;
        clear(filesList);
        forgetFilePictures(new Set(files.map((f) => f.path)));
        // Every screenshot, window, tab, selection and folder on its own, in
        // the "Computer" folder, always first: its × takes back that one only.
        const computerRows = items.map((item) => {
          const removeIt = () => {
            removeItem(item);
            Sound.play("pop");
            State.notify();
          };
          return attachRow(item, removeIt, () => openPreview(itemPreview(screen, item), removeIt));
        });
        if (computerRows.length > 0) {
          filesList.append(attachGroup(
            { label: t(STRINGS.computer), detail: t(STRINGS.computerHint), tile: "attach-computer", icon: COMPUTER_ICON, rows: computerRows },
            openGroups.has("computer"),
            (open) => (open ? openGroups.add("computer") : openGroups.delete("computer")),
          ));
        }
        // A dropped, pasted or picked file: its × takes it out before it is sent.
        if (file) {
          const removeFile = () => {
            State.droppedFile = null;
            if (State.promptContext?.kind === "file") State.promptContext = null;
            // The next file waiting takes its place.
            const [next, ...rest] = State.moreFiles;
            if (next) {
              State.moreFiles = rest;
              State.droppedFile = { ...next };
              State.promptContext = { kind: "file", name: next.name, path: next.path };
            }
            Sound.play("pop");
            State.notify();
          };
          filesList.append(attachRow(
            { kind: "file", label: file.name, detail: fileDetail(file), title: file.path, thumb: pictures[0] || undefined },
            removeFile,
            () => void openFilePreview(file, removeFile),
          ));
        }
        moreFiles.forEach((more, i) => {
          const removeMore = () => {
            State.moreFiles = State.moreFiles.filter((f) => f.path !== more.path);
            Sound.play("pop");
            State.notify();
          };
          filesList.append(attachRow(
            { kind: "file", label: more.name, detail: fileDetail(more), title: more.path, thumb: pictures[i + (file ? 1 : 0)] || undefined },
            removeMore,
            () => void openFilePreview(more, removeMore),
          ));
        });
        if (attached === 0) filesList.append(noAttachments());
        filesBadge.textContent = attached > 0 ? String(attached) : "";
        filesCount.textContent = attached > 0 ? String(attached) : "";
        filesBtn.classList.toggle("has-files", attached > 0);
        removeAllBtn.hidden = attached < 2;
        // Asked once each; a picture that comes redraws the rows with it.
        for (const f of files) if (PICTURE_FILE.test(f.name)) void filePicture(f.path);
      }
      // Something is already attached: the ways to start make room for it.
      body.classList.toggle("has-context", attached > 0 || editing != null);
      // A dropped file just came in: a word that it did, for a moment.
      const uploaded = State.uploadedNote && State.uploadedNote.until > Date.now() ? State.uploadedNote : null;
      if (!uploaded) State.uploadedNote = null;
      const listened = listeningLine(State.listening.filter((w) => w.chatId === State.chatId));
      const editKey = editing != null ? String(editing) : uploaded ? `uploaded\t${uploaded.name}\t${uploaded.until}` : listened ? `listen\t${listened}` : "";
      if (chipRow.dataset.label !== editKey) {
        chipRow.dataset.label = editKey;
        clear(chipRow);
        if (editing != null) chipRow.append(noteChip(t(STRINGS.editing), t(STRINGS.editingHint), cancelEdit));
        else if (uploaded) chipRow.append(uploadedChip(uploaded.name));
        else if (listened) {
          // What this chat listens for on GitHub; × stops it.
          chipRow.append(noteChip(listened, t(LISTEN_STRINGS.hint), () => {
            for (const w of State.listening.filter((w) => w.chatId === State.chatId)) void Bridge.listenCancel(w.repo, w.number, w.until);
          }));
        }
      }

      const count = State.chatHistory.length + (run ? 0.5 : 0);
      if (count !== renderedCount) {
        renderedCount = count;
        live = null;
        const kept = log.scrollTop;
        clear(log);
        // A new chat opens on a few ways to start, now that it is home.
        if (count === 0) log.append(workshop ? forgeWelcome() : welcome());
        // What an edit would drop shows faded.
        const at = editing == null ? -1 : State.chatHistory.findIndex((m) => m.id === editing);
        State.chatHistory.forEach((m, i) => {
          log.append(bubble(m, { onEdit: startEdit, editing: i === at, dropped: at >= 0 && i > at, workshop }));
        });
        // The answer being written: its text so far, then the dots while it works.
        if (run?.text) {
          live = h("div", { class: "reply" });
          log.append(h("div", { class: "chat-row" }, live));
          drawAnswer(live, run.text, workshop);
        }
        if (run && (!run.text || run.dots)) log.append(typingDots(activityLabel(run.activity)));
        // The chat stays where it was read; one just opened shows its end.
        log.scrollTop = openedChat ? log.scrollHeight : kept;
        openedChat = false;
      }

      micBtn.classList.toggle("lit", State.liveActive);
      drawModelButton();
      const openRouter = State.mode === "expanded" && State.view === "prompt"
        && State.settings.chatShowUsage && State.settings.chatProvider === "openrouter";
      if (openRouter && !openRouterShown) askOpenRouter(false);
      openRouterShown = openRouter;
      // agy: asked when the chat opens on it (stale numbers only), as for OpenRouter.
      const agyShown = State.mode === "expanded" && State.view === "prompt" && antigravityUsage();
      if (agyShown && !antigravityShown) refreshAntigravityPlanUsage();
      antigravityShown = agyShown;
      drawUsage();

      input.placeholder = workshop
        ? t(FORGE_STRINGS.placeholder)
        : t(State.chatHistory.length === 0 ? STRINGS.placeholderFirst : STRINGS.placeholderNext);
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
