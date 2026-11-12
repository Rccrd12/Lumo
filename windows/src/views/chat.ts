// Chat view: the prompt box, the bubbles, the typing dots and the model picker.
//
// Answers, and questions once sent, are rendered as Markdown (markdown.ts).
// Every chat streams its answer (a local model, the cloud APIs, the agents): Rust sends `chat-delta` events with the
// text visible so far. The model name above the text field opens the picker:
// provider chips, then the models of the chosen provider, asked for only once
// it is picked.
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
// as far as it got. A question sent while the answer is written (the Stop
// button turns back into the arrow as soon as something is typed) leaves the
// field and waits just above it, where it can be edited or cancelled; it goes
// once the answer ends, or comes back to the field after Stop. Under each
// message, a line of actions as in Claude's app (under the mouse, always under
// the last answer): Copy, and when it was sent; each question has Edit:
// sending the edited text replaces it and drops what followed, here and in
// Rust (chat.rs rewind); sent mid-answer, it stops that answer first. The last
// question and its answer have Retry: the question goes again, unchanged.
//
// The screen button next to the paperclip adds what is on the user's screen,
// only when they ask (views/share-panel.ts): the open windows or the browser
// tabs (Edge, Chrome), one or all, each going with what it shows (share.rs); a
// screenshot of one display or all of them, shown first with Send / Cancel
// (core/screen.ts); or a folder open in File Explorer: its listing goes with
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
import { checklistsIn, copyButton, renderMarkdown, writeClipboard } from "./markdown";
import type { MenuEntry as MenuItem } from "./context-menu";
import { ownMenu } from "./own-menu";
import { renderAnswer } from "./context-card";
import { forgetCardsFrom } from "./rich/index";
import { Ink, inkWorks } from "./ink";
import { agyContextWindow, drawNewUsage, lastContextReport } from "./usage-panel";
import { drawShareGrid, type ShareItem, type ShareKind, type ShareKindId } from "./share-panel";
import {
  Bridge, onEvent, type BrowserTab, type ChatActivity, type LocalLoad, type ChatContext, type ChatFileEvent, type ExplorerFolder, type ModelInfo,
  type OpenWindow, type ScreenContext, type ScreenDisplay, type ScreenShot, type UnslothStudio, UNSLOTH_STUDIO_EVENT,
} from "../core/bridge";
import {
  activeModel, apiCaps, capsContext, capsWords, effortFor, effortsFor, hasPermissions, isApiProvider, isCliProvider, localCapsOf, usesLumoTools, parsePermissionMode, parseSandboxLevel, permissionModesFor, pickModel, providerDef, setLocalCaps, storedPermissionMode, withPermissionMode,
  anyProviderReady, visibleProviders, withModel, type PermissionMode, type ProviderDef, type SandboxLevel,
} from "../core/providers";
import { Sound } from "../core/sound";
import { State, planAskInChat, type ActiveChatRun, type ChatMessage } from "../core/state";
import {
  chatChecklists, chatTitle, compactOf, deleteChat, joinOwnAnswer, loadChats, saveChat, searchChats, setChatChecklists, setCompact, type ChatHit, type SavedChat,
} from "../core/chats";
import {
  checklistNote, lineagesOf, listsInChat, messageScope, nextMessage, noteChatChecklists, withTold, type Checklist,
} from "../core/checklists";
import {
  addChatFile, aiKind, chatCopies, chatFiles, dropChatFiles, keptCopies, noteSentCopies, filesByKind, removeChatFile, rewindChatFiles, type ChatFile, type ChatFileKind,
} from "../core/chat-files";
import { ageLabel } from "../core/plan";
import { refreshAntigravityPlanUsage, refreshClaudePlanOnline } from "./usage";
import { OPENROUTER_STALE_MS, USAGE_TEXT, usageLine, type ChatUsage, type SeenUsage, type UsageLine } from "../core/chat-usage";
import {
  ITEM_STRINGS, PREVIEW_STRINGS, SCREEN_STRINGS, withSelection, emptyScreen, filePreview, formatSize, itemPreview, keepShots,
  afterSent, autoShare, folderPicks, foldersByThemselves, nextScreen, noImagesReason, screenItems, screenLabel, screenPayload, seesImages, short,
  shotPaths, tabPicks, tabsByThemselves, windowPicks, withFolders, withTabs, withWindows, withoutItem, type ExplorerPeek, type ItemKind, type PickEntry,
  type PendingScreen, type PreviewBlock, type ScreenItem,
} from "../core/screen";
import { MAX_PASTE_BYTES, PASTE_STRINGS, pasteAction, pastedFiles, pastedName } from "../core/paste";
import { COMPUTER_TEXT } from "../core/computer";
import { closePicture } from "./picture";
import type { ViewHost } from "./views";
import { N_, dayMonth, language, t, tl, tn } from "../i18n/i18n";
import { LIVE_STRINGS } from "../live/strings";
import { type CopyDiff, type CopyView, type Pair, type Segment, copyView, counts, pairs, wordMarks } from "../core/copy-diff";
import { COMPACT_TEXT, UPLOADED_TEXT, compactNotice, compactTimer, parseDuration, speakerName, takeTimers } from "../core/compact";
import { LISTEN_COLOR, LISTEN_STRINGS, activeWatches, answersInChat, firedTitle, listenMessage, takeListens, untilText, watchColor, watchLabel, type ListenAsk, type ListenFired, type ListenWatch } from "../core/listen";
import { buildListeningPanel, listeningButtonTitle } from "./listening";
import { blocksOf, draftIn, draftKey, draftOf, isWorkshopChat, latestDraft, stripDraft, type ToolDraft, type ToolInfo } from "../core/tools";
import { CONTEXT_STRINGS } from "../core/context-usage";
import { FORGE_STRINGS, buildForgePanel, draftChip, linkSaved, savedLink } from "./forge";
import { buildPlanStrip } from "./plan-strip";
import { planAskSteps } from "./plan-ask";
import { planKey } from "../core/agent-plan";
import {
  SLASH_STRINGS, lumoCommand, slashCommands, slashMatches, slashQuery, toolAsk, toolCommand, type SlashAction, type SlashCommand,
} from "../core/slash";

/** At most this many watches wait for the user's word in one chat: the latest are kept. */
const MAX_LISTEN_ASKS = 6;

const STRINGS = {
  placeholderFirst: N_("Ask me anything…"),
  placeholderNext: N_("Continue…"),
  planKeep: N_("Keep planning"),
  planApprove: N_("Approve the plan"),
  listenAsk: N_("Start listening?"),
  listenWhy: N_("The answer asks Lumo to listen. What Lumo hears goes back to the chat as a message."),
  listenThen: N_("then: {task}"),
  listenNo: N_("Not now"),
  listenYes: N_("Listen"),
  planChange: N_("Or write what to change…"),
  send: N_("Send"),
  toEnd: N_("Go to the bottom"),
  showAll: N_("Show all"),
  showLess: N_("Show less"),
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
  sandbox: N_("Sandbox"),
  isolate: N_("How to isolate code?"),
  welcome: N_("What can I do for you?"),
  askFile: N_("Ask about a file"),
  lookScreen: N_("Look at my screen"),
  writeMessage: N_("Write a message"),
  writeMessageStart: N_("Help me write a message to "),
  stop: N_("Stop"),
  stopped: N_("Stopped"),
  edit: N_("Edit"),
  retry: N_("Retry"),
  editing: N_("Editing a message"),
  editingHint: N_("Sending replaces this message and everything after it."),
  queued: N_("Queued"),
  queuedHint: N_("Sent as soon as this answer ends"),
};

/** The commands' icons drawn filled (core/slash.ts); the others are strokes. */
const FILLED_ICONS = new Set(["plus", "gear", "timer", "stack"]);

/** The effort levels by name, "Auto" for the CLI's own default. */
/** Two arrows meeting at a line: the chat pressed together. */
const COMPACT_ICON = "M12 3.5v5.5M9 6.5l3 2.5 3-2.5M12 20.5V15M9 17.5l3-2.5 3 2.5M5 12h14";

/** How full a local model's context is (%) before the chat compacts itself. */
const AUTO_COMPACT_PCT = 80;

/** /compact with the providers called by their API. */
const COMPACT_STRINGS = {
  action: N_("Compact the chat"),
  working: N_("Compacting the chat…"),
  done: N_("Chat compacted: the model now starts from its summary"),
  auto: N_("Context at {pct}%: compacting the chat before answering…"),
  autoDone: N_("Chat compacted by itself: the model starts again from its summary"),
  nothing: N_("Nothing new to compact"),
};

/** The picker's − and + on a local model: in and out of the server's memory. */
const LOAD_STRINGS = {
  load: N_("Load into memory"),
  eject: N_("Eject from memory"),
  loading: N_("Loading the model…"),
};
const LOAD_RING = "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z";
const LOAD_MINUS = `${LOAD_RING}M8.5 12h7`;
const LOAD_PLUS = `${LOAD_RING}M8.5 12h7M12 8.5v7`;

const EFFORT_NAMES: Record<string, string> = {
  // A local model that thinks or doesn't (local_models.rs).
  off: N_("Off"),
  on: N_("On"),
  low: N_("Low"),
  medium: N_("Medium"),
  high: N_("High"),
  xhigh: N_("Extra high"),
  max: N_("Max"),
};

/** Each permission mode of the CLIs: its name and what it lets through. */
const PERMISSION_TEXT: Record<Exclude<PermissionMode, "off">, { name: string; note: string }> = {
  default: { name: N_("Ask every time"), note: N_("Asks before each action that needs a permission.") },
  auto: { name: N_("Auto"), note: N_("The AI decides what is safe to do without asking, and asks for the rest.") },
  plan: { name: N_("Plan only"), note: N_("Reads and plans, and changes nothing.") },
};

/** Auto with Antigravity CLI: agy's own Turbo preset (antigravity_cli.rs). */
const AGY_AUTO_NOTE = N_("Runs every command and changes any file without asking.");
/** Auto with Copilot CLI or Cursor CLI: an action allowed once is allowed for the rest of the chat (acp_chat.rs). */
const ACP_AUTO_NOTE = N_("Asks when the CLI asks. What you allow is allowed for the rest of the chat.");
/**
 * The modes with a local model or a provider called by its API, whose actions
 * are the user's tools and the web (local_chat.rs, tools.rs Asking).
 */
const LOCAL_TEXT: Record<PermissionMode, { name: string; note: string }> = {
  default: { name: N_("Ask for approval"), note: N_("Asks before using tools or the internet.") },
  auto: { name: N_("Approve for me"), note: N_("Only asks for risky actions.") },
  off: { name: N_("Run automatically"), note: N_("Never asks. Code stays in the sandbox.") },
  plan: { name: PERMISSION_TEXT.plan.name, note: N_("Gets none of your tools: it only answers and plans.") },
};

/** A mode's name and note with `provider`. */
function modeText(provider: ProviderDef, mode: PermissionMode): { name: string; note: string } {
  if (usesLumoTools(provider.id) || mode === "off") return LOCAL_TEXT[mode];
  const text = PERMISSION_TEXT[mode];
  if (mode === "auto" && provider.id === "antigravity-cli") return { ...text, note: AGY_AUTO_NOTE };
  if (mode === "auto" && (provider.id === "copilot-cli" || provider.id === "cursor-cli")) return { ...text, note: ACP_AUTO_NOTE };
  return text;
}

/**
 * How far a local model's tools are kept from the computer (Settings.localSandbox).
 * Its "Low" and "High" are not the effort's: other languages may say them
 * another way (Italian: Bassa, not Basso), so their keys carry the context
 * before a "|" (`tc`).
 */
const SANDBOX_TEXT: Record<SandboxLevel, { name: string; note: string; color: string }> = {
  low: { name: N_("sandbox|Low"), note: N_("Only Lumo's protections. Risky code asks first."), color: "#f5a524" },
  high: { name: N_("sandbox|High"), note: N_("Tools also run in the Windows sandbox."), color: "#4ade80" },
};

/** A key with its context ("sandbox|Low"): its translation, else its English after the "|". */
function tc(key: string): string {
  const text = t(key);
  return text === key ? key.slice(key.indexOf("|") + 1) : text;
}

/** What the effort says, in the interface language. */
function effortLabel(effort: string): string {
  return effort ? t(EFFORT_NAMES[effort] ?? effort) : t(STRINGS.effortAuto);
}

let nextId = 1;

/** The folder open in File Explorer is asked again at most this often while the field takes focus. */
const PEEK_EVERY_MS = 1500;

/** How long a plan that just came up over the field ignores clicks (as the permission card). */
const PLAN_ASK_GUARD_MS = 600;
/**
 * The screen menu waits at most this long for the browsers' tabs (read from
 * their windows on Windows); a slow browser adds its entry when it answers.
 */
const TABS_WAIT_MS = 1200;

/** How a message is drawn: `onEdit` puts a question back in the text field. */
interface BubbleOptions {
  onEdit?: (message: ChatMessage) => void;
  /** Retry, on the last question and its answer while nothing is answered: the question goes again. */
  onRetry?: () => void;
  /** Its actions stay in sight without the mouse: the last answer, or a question left without one. */
  shown?: boolean;
  /** The question being edited, and what sending it would drop. */
  editing?: boolean;
  dropped?: boolean;
  /** A tool workshop's answer: the draft's blocks show as one line naming it. */
  workshop?: boolean;
  /** Which message it is (core/checklists.ts messageScope): its cards keep their own state. */
  scope?: string;
}

/** Sends a message as if typed, for a card's button (the quiz's next questions): set once the chat is built. */
let sendFromCard: ((text: string) => void) | undefined;

/** The "2 min ago" under the messages on screen, kept fresh as the chat is drawn and hovered. */
let sentTimes: { el: HTMLElement; at: number }[] = [];

/** "just now", "12 min ago", "3 h ago", then the day: when a message was sent or answered. */
/** A message as Rust's conversation holds it (chat_restore): what it kept, when not what shows. */
export function conversationTurn(m: { role: "user" | "assistant"; content: string; kept?: string }): { role: "user" | "assistant"; content: string } {
  return { role: m.role, content: m.kept ?? m.content };
}

export function sentAgo(at: number, now = Date.now()): string {
  if (now - at < 86_400_000) return ageLabel(at, now);
  const d = new Date(at);
  return dayMonth(d.getMonth(), d.getDate());
}

function refreshTimes(times = sentTimes, now = Date.now()) {
  for (const { el, at } of times) {
    const text = sentAgo(at, now);
    if (el.textContent !== text) el.textContent = text;
  }
}

/** A message's action button: an icon, its name under the mouse. */
function msgAction(cls: string, name: string, icon: SVGElement, run: () => void): HTMLElement {
  const btn = h("button", { class: `msg-action ${cls}`, title: tl(name), "aria-label": tl(name) }, icon);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    run();
  });
  return btn;
}

/**
 * One message, rendered as Markdown on both sides, its actions on a line
 * under it as in Claude's app: under an answer Copy, Retry and when it came;
 * under a question when it was sent, Retry, Edit and Copy. They show under
 * the mouse, and always under the last answer (or a question whose answer
 * failed). Retry is only on the last question and its answer: anywhere else
 * it would drop what follows unseen, which Edit shows first. Copy takes the
 * text as it was written, Markdown included.
 */
function bubble(message: ChatMessage, opts: BubbleOptions = {}): HTMLElement {
  const state = opts.editing ? " editing" : opts.dropped ? " dropped" : "";
  // The answer failed: what went wrong stays under the question.
  if (message.role === "assistant" && message.failed) {
    return h("div", { class: `chat-row${state}` }, h("div", { class: "reply-wrap" }, h("div", { class: "msg-failed", text: message.content })));
  }
  const copy = copyButton(message.content, "msg-action msg-copy", 12);
  const retry = opts.onRetry ? msgAction("msg-retry", STRINGS.retry, svg(ICONS.arrowClockwise, 12, { stroke: 1.9 }), opts.onRetry) : null;
  const times: typeof sentTimes = [];
  let when: HTMLElement | null = null;
  if (message.at != null) {
    const at = message.at;
    when = h("span", { class: "msg-time", text: sentAgo(at), title: new Date(at).toLocaleString(language()) });
    times.push({ el: when, at });
    sentTimes.push(...times);
  }
  const bar = h("div", { class: opts.shown ? "msg-actions shown" : "msg-actions" });
  let row: HTMLElement;
  if (message.role === "user") {
    const onEdit = opts.onEdit;
    const edit = onEdit ? msgAction("msg-edit", STRINGS.edit, svg(ICONS.pencil, 12, { stroke: 1.8 }), () => onEdit(message)) : null;
    bar.append(...[when, retry, edit, copy].filter((x): x is HTMLElement => x != null));
    const sent = sentBubble(message.content);
    row = h("div", { class: `chat-row user${state}` }, sent, foldToggle(sent, message.id), bar);
  } else {
    const reply = h("div", { class: "reply" });
    drawReply(reply, message.content, !!opts.workshop, opts.scope);
    // A stopped answer says so on the same line.
    const stopped = message.stopped ? h("span", { class: "msg-stopped", text: tl(STRINGS.stopped) }) : null;
    bar.append(...[copy, retry, stopped, when].filter((x): x is HTMLElement => x != null));
    const copies = message.copies?.length ? copiesBox(message.copies) : null;
    row = h("div", { class: `chat-row${state}` }, h("div", { class: "reply-wrap" }, reply, copies, bar));
  }
  // Hovered after a while: its time says how long ago it is now.
  if (times.length) row.addEventListener("mouseenter", () => refreshTimes(times));
  return row;
}

/**
 * A question as sent: Markdown and TeX as in the answers, inside its bubble,
 * but none of the answers' cards (plainQuestion). The prompt box stays plain
 * text; Copy and Edit take what was written.
 */
function sentBubble(text: string): HTMLElement {
  const el = h("div", { class: "bubble md" });
  renderMarkdown(el, plainQuestion(text));
  unmark(el);
  return el;
}

/** Taller than this (page px), a question is folded to its first lines (style.css `.bubble.folded`), with Show all under it. */
const FOLD_OVER = 240;
/** The long questions opened with Show all, by chat and message: a redrawn log keeps them open. */
const unfolded = new Set<string>();
/** Each bubble's own measure, once it is laid out and whenever its width changes. */
const foldMeasures = new WeakMap<Element, () => void>();
let foldObserver: ResizeObserver | null = null;

/**
 * A long question, folded: its first lines, fading, and Show all under it,
 * which turns into Show less once it is open. A short one has no button.
 * Measured once laid out, so it never depends on how many characters it has.
 */
function foldToggle(bubble: HTMLElement, id: number): HTMLElement {
  const key = `${State.chatId}:${id}`;
  const label = h("span", { class: "msg-fold-label" });
  const chevron = h("span", { class: "msg-fold-chevron" }, svg(ICONS.chevronUp, 10, { stroke: 2 }));
  const btn = h("button", { class: "msg-fold", hidden: "" }, label, chevron);
  const paint = () => {
    const open = unfolded.has(key);
    const long = bubble.scrollHeight > FOLD_OVER;
    btn.hidden = !long;
    bubble.classList.toggle("folded", long && !open);
    btn.classList.toggle("open", open);
    label.textContent = t(open ? STRINGS.showLess : STRINGS.showAll);
    btn.setAttribute("aria-expanded", String(open));
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const closing = unfolded.has(key);
    if (closing) unfolded.delete(key);
    else unfolded.add(key);
    paint();
    // Folded again from far down: the question's top comes back in sight.
    if (closing) bubble.scrollIntoView?.({ block: "nearest" });
  });
  if (typeof ResizeObserver !== "undefined") {
    foldObserver ??= new ResizeObserver((entries) => {
      for (const entry of entries) foldMeasures.get(entry.target)?.();
    });
    foldMeasures.set(bubble, paint);
    foldObserver.observe(bubble);
  }
  return btn;
}

/** Takes plainQuestion's marks back out of the drawn text, so a selection copies what was written. */
function unmark(node: Node): void {
  if (node.nodeType === 3) {
    const text = node as Text;
    if (text.data.includes(NOT_A_CARD)) text.data = text.data.split(NOT_A_CARD).join("");
    return;
  }
  for (const child of Array.from(node.childNodes)) unmark(child);
}

/** An invisible mark that keeps a line from being read as a card. */
const NOT_A_CARD = "\u2060";

/**
 * A question's Markdown with what would make a card in an answer kept as
 * the text it was before the cards: a task list (`- [ ] a`) stays a list of
 * bullets, an image line (`![a](https://…)`) a line of text, never fetched,
 * an alert (`> [!NOTE]`) a quote, and a ```diff or ```lumo-… block code. An
 * invisible mark goes before what the cards look for, outside code blocks.
 */
export function plainQuestion(text: string): string {
  // The backticks of the code block the line is in, 0 outside one: only a bare
  // fence at least as long closes it (as views/markdown.ts reads it), so a
  // ```js inside a ````markdown block does not.
  let fence = 0;
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const mark = /^([ \t]*)(`{3,})(.*)$/.exec(line);
      if (mark && !fence) {
        fence = mark[2].length;
        return `${mark[1]}${mark[2]}${NOT_A_CARD}${mark[3]}`;
      }
      if (mark && mark[2].length >= fence && !mark[3].trim()) {
        fence = 0;
        return line;
      }
      if (fence) return line;
      return line
        .replace(/^(\s*)(?=!\[)/, `$1${NOT_A_CARD}`)
        .replace(/^(\s*>\s*)(?=\[!)/, `$1${NOT_A_CARD}`)
        .replace(/^(\s*)(?=(?:\*\*)?\[!)/, `$1${NOT_A_CARD}`)
        .replace(/^(\s*[-*+][ \t]+)(?=\[[ xX]\])/, `$1${NOT_A_CARD}`);
    })
    .join("\n");
}

/** What the copies' box under an answer says (workspace.rs). */
const COPY_STRINGS = {
  title: N_("Changed in Lumo's copies: your files are as they were"),
  open: N_("Open"),
  folder: N_("Show the folder"),
  confirm: N_("Write it over the original"),
  original: N_("The original: {path}"),
  rewritten: N_("rewritten"),
  line: N_("line {n}"),
  places: N_("{count} places"),
  newText: N_("New text"),
  changes: N_("Changes"),
  sideBySide: N_("Before and after"),
  before: N_("Before"),
  after: N_("After"),
  wasEmpty: N_("Before, it was empty."),
  was: N_("Before, it was: “{text}”"),
  wasLines: N_("Before, it had {count} lines."),
  wasLine: N_("Before, it had one line."),
  done: N_("Written over the original."),
  unchanged: N_("The copy is the same as the original."),
};

/** A path in a chat's folder of copies (workspace.rs). */
export function inWorkspace(path: string): boolean {
  return /[\\/]com\.rccrd12\.lumo[\\/]workspaces[\\/]/i.test(path);
}

/**
 * The copies an answer changed or made: each with Open and, for a copy of a
 * file of the computer, what changed in it and a button that writes it over
 * the original.
 */
function copiesBox(copies: { chat: string; path: string; made?: boolean }[]): HTMLElement {
  const box = h("div", { class: "reply-copies" },
    h("div", { class: "reply-copies-title", text: t(COPY_STRINGS.title) }));
  for (const copy of copies) {
    const name = copy.path.split(/[\\/]/).pop() ?? copy.path;
    const detail = h("div", { class: "reply-copy-detail" });
    const open = h("button", { class: "reply-copy-btn", text: t(COPY_STRINGS.open) });
    open.addEventListener("click", () => void Bridge.chatFileOpen(copy.path));
    const folder = h("button", { class: "reply-copy-btn", text: t(COPY_STRINGS.folder) });
    folder.addEventListener("click", () => void Bridge.chatFileReveal(copy.path));
    const row = h("div", { class: "reply-copy-row" },
      h("span", { class: "reply-copy-name", text: name, title: copy.path }), open, folder);
    box.append(h("div", { class: "reply-copy" }, row, detail));
    // A copy of a file of the computer shows what changed right away.
    if (!copy.made) void showDiff(copy, detail, row);
  }
  return box;
}

async function showDiff(copy: { chat: string; path: string }, detail: HTMLElement, row: HTMLElement) {
  clear(detail);
  let diff: CopyDiff;
  try {
    diff = await Bridge.workspaceDiff(copy.chat, copy.path);
  } catch (err) {
    detail.append(h("div", { class: "reply-copy-note", text: String(err) }));
    return;
  }
  const { added, removed } = counts(diff);
  if (added + removed === 0) {
    detail.append(h("div", { class: "reply-copy-note", text: t(COPY_STRINGS.unchanged) }));
    return;
  }
  const best = copyView(diff);
  const found = pairs(diff);
  // Beside the name: how it changed.
  const where = best === "text" ? t(COPY_STRINGS.rewritten)
    : found.length === 1 ? t(COPY_STRINGS.line, { n: found[0].at }) : t(COPY_STRINGS.places, { count: found.length });
  const name = row.querySelector(".reply-copy-name");
  if (name) name.append(h("span", { class: "reply-copy-where", text: ` · ${where}` }));
  name?.after(h("span", { class: "reply-copy-count" },
    h("span", { class: "plus", text: `+${added}` }), " ", h("span", { class: "minus", text: `−${removed}` })));

  const body = h("div", { class: "reply-copy-body" });
  const show = (view: CopyView) => {
    clear(body);
    if (view === "text") body.append(newText(diff));
    else if (view === "pairs") body.append(sideBySide(found));
    else body.append(changedLines(diff));
    for (const [b, v] of tabs) b.classList.toggle("on", v === view);
  };
  // The rewritten file and the few changed lines can also be seen line by line.
  const tabs: [HTMLElement, CopyView][] = best === "byLine" ? [] : [
    [h("button", { class: "reply-copy-btn", text: t(best === "text" ? COPY_STRINGS.newText : COPY_STRINGS.sideBySide) }), best],
    [h("button", { class: "reply-copy-btn", text: t(COPY_STRINGS.changes) }), "byLine"],
  ];
  for (const [b, v] of tabs) b.addEventListener("click", () => show(v));

  const confirm = h("button", { class: "reply-copy-btn primary", text: t(COPY_STRINGS.confirm) });
  confirm.addEventListener("click", async () => {
    try {
      await Bridge.workspacePutBack(copy.chat, copy.path);
      clear(detail);
      detail.append(h("div", { class: "reply-copy-note", text: t(COPY_STRINGS.done) }));
    } catch (err) {
      detail.append(h("div", { class: "reply-copy-note", text: String(err) }));
    }
  });
  if (tabs.length) detail.append(h("div", { class: "reply-copy-row" }, ...tabs.map(([b]) => b)));
  // Where the click writes, in full: the manifest says it, the user sees it.
  detail.append(
    body,
    h("div", { class: "reply-copy-note", text: t(COPY_STRINGS.original, { path: diff.original }) }),
    h("div", { class: "reply-copy-row" }, confirm));
  show(best);
}

/** The copy rewritten: its text, to read, and what it was. */
function newText(diff: CopyDiff): HTMLElement {
  const before = diff.before.trim();
  const was = before === "" ? t(COPY_STRINGS.wasEmpty)
    : before.length <= 80 && !before.includes("\n") ? t(COPY_STRINGS.was, { text: before })
    : diff.beforeLines === 1 ? t(COPY_STRINGS.wasLine) : t(COPY_STRINGS.wasLines, { count: diff.beforeLines });
  return h("div", { class: "reply-copy-view" },
    h("div", { class: "reply-copy-text", text: diff.text }),
    h("div", { class: "reply-copy-note", text: was }));
}

/** A few changed lines: before and after side by side, the changed words lit. */
function sideBySide(found: Pair[]): HTMLElement {
  const marked = (segments: Segment[]) => segments.map((s) => s.changed ? h("mark", { text: s.text }) : document.createTextNode(s.text));
  return h("div", { class: "reply-copy-view" }, ...found.map((p) => {
    const words = wordMarks(p.before.join("\n"), p.after.join("\n"));
    return h("div", { class: "reply-copy-pair" },
      h("div", { class: "reply-copy-side del" }, h("div", { class: "reply-copy-label", text: t(COPY_STRINGS.before) }), ...marked(words.before)),
      h("div", { class: "reply-copy-side add" }, h("div", { class: "reply-copy-label", text: t(COPY_STRINGS.after) }), ...marked(words.after)));
  }));
}

/** The changed lines with three of their neighbours, numbered, each wrapped. */
function changedLines(diff: CopyDiff): HTMLElement {
  return h("div", { class: "reply-copy-diff" }, ...diff.lines.slice(0, 400).map((l, i) => {
    if (l === "…") return h("div", { class: "copy-line gap", text: "⋯" });
    const kind = l[0] === "+" ? "add" : l[0] === "-" ? "del" : "same";
    return h("div", { class: `copy-line ${kind}` },
      h("span", { class: "num", text: String(diff.numbers[i] || "") }),
      h("span", { class: "sym", text: kind === "add" ? "+" : kind === "del" ? "−" : "" }),
      h("span", { class: "txt", text: l.slice(1) }));
  }));
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
  // A local model (local_chat.rs): its server started (Unsloth Studio, unsloth_studio.rs),
  // loading it, then reading the prompt.
  starting: N_("Starting Unsloth Studio…"),
  loading: N_("Loading the model…"),
  loadingAt: N_("Loading the model: {percent}%"),
  prompt: N_("Processing the prompt…"),
  // A local model asked again after its server dropped the request, or sent
  // back once (lumo-local's Doing). Its reasoning and the calls it writes say
  // Thinking… and Using {tool}, as every provider's do.
  retry: N_("{name} stopped the answer: trying again ({attempt} of {of})…"),
  correctWritten: N_("It wrote the tool instead of using it: asking again…"),
  correctDone: N_("It said it was done without doing it: asking again…"),
  correctStopped: N_("It stopped halfway: asking again…"),
  seconds: N_("{seconds} s"),
};

const ISLAND_ACTIVITY_STRINGS = {
  subtask: N_("Sub-task"),
  tool: N_("Uses a tool"),
  retry: N_("Tries again"),
  correcting: N_("Asks again"),
};

/** What is timed next to the dots: the seconds it has been at it. */
const TIMED = new Set(["starting", "prompt", "reasoning", "thinking", "retry"]);

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
  model: string;
  /** The turn the question is in Rust's conversation (chat.rs), for the files it uses. */
  turn: number;
  /** The answer's text so far: "" until it shows. */
  text: string;
  /** What the answer is doing, shown next to the dots until its text does. */
  activity: ChatActivity;
  /** When `activity` began (epoch ms), for the seconds next to it. */
  since: number;
  /** The dots are back under the text: the CLI went back to its tools. */
  dots: boolean;
  /** Turns the first activity of a provider that streams no tools into Thinking…. */
  timer?: ReturnType<typeof setTimeout>;
  /** Stop was pressed: the answer is being ended. */
  stopping: boolean;
  /** Deleted from Past chats meanwhile: its answer is stopped, and the chat is not saved again. */
  forgotten?: boolean;
  /** The copies the answer changed or made in the chat's folder (workspace.rs). */
  copies?: Map<string, boolean>;
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

/**
 * Who gives one answer: the provider and model it was asked of, kept with the
 * answer, so picking another model while it is written doesn't rename it.
 */
function runSpeaker(run: { provider: string; model: string }): { who: string; color: string } {
  const p = providerDef(run.provider);
  return { who: speakerName(p.id, t(p.name), run.model), color: p.accent };
}

/** Says on the closed island how the answer went, unless the chat is on screen. */
function noticeAway(text: string, speaker: { who: string; color: string }) {
  if (State.mode === "expanded" && State.view === "prompt") return;
  compactNotice(t(text, { helper: speaker.who }), speaker.color);
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
    case "starting":
      return t(ACTIVITY_STRINGS.starting);
    case "loading":
      return /^\d{1,3}$/.test(detail) ? t(ACTIVITY_STRINGS.loadingAt, { percent: detail }) : t(ACTIVITY_STRINGS.loading);
    case "prompt":
      return t(ACTIVITY_STRINGS.prompt);
    case "calling":
      return detail ? t(ACTIVITY_STRINGS.tool, { tool: detail }) : t(ACTIVITY_STRINGS.thinking);
    case "retry": {
      const [attempt, of] = detail.split("/");
      const name = t(providerDef(State.settings.chatProvider).name);
      return attempt && of ? t(ACTIVITY_STRINGS.retry, { name, attempt, of }) : t(ACTIVITY_STRINGS.thinking);
    }
    case "correcting":
      return t(detail === "written" ? ACTIVITY_STRINGS.correctWritten : detail === "done" ? ACTIVITY_STRINGS.correctDone : ACTIVITY_STRINGS.correctStopped);
    default:
      return t(ACTIVITY_STRINGS.thinking);
  }
}

/**
 * The label with the seconds it has lasted, for what is timed (thinking,
 * reading the prompt, trying again), from 2 s on, the same for every provider.
 */
export function timedLabel(label: string, _provider: string, activity: ChatActivity | null, since: number, now = Date.now()): string {
  const seconds = Math.floor((now - since) / 1000);
  if (!activity || !TIMED.has(activity.kind) || seconds < 2) return label;
  return `${label} ${t(ACTIVITY_STRINGS.seconds, { seconds })}`;
}

/**
 * When `activity` began. Unsloth Studio starting says the seconds its start has
 * taken (unsloth_studio.rs): a start the model picker began earlier goes on from
 * its seconds, as the picker shows them, not from 0.
 */
export function activitySince(activity: ChatActivity, now = Date.now()): number {
  const seconds = activity.kind === "starting" && /^\d{1,4}$/.test(activity.detail) ? Number(activity.detail) : 0;
  return now - seconds * 1000;
}

/**
 * The same, in the closed island's fewer words (core/compact.ts): what it
 * looks for, runs or uses is left to the chat.
 */
export function islandActivityLabel(activity: ChatActivity | null): string {
  switch (activity?.kind) {
    case "search":
      return t(COMPACT_TEXT.searching);
    case "command":
      return t(COMPACT_TEXT.command);
    case "subtask":
      return t(ISLAND_ACTIVITY_STRINGS.subtask);
    case "tool":
    case "calling":
      return activity.detail.trim() ? t(ISLAND_ACTIVITY_STRINGS.tool) : t(COMPACT_TEXT.thinking);
    case "retry":
      return t(ISLAND_ACTIVITY_STRINGS.retry);
    case "correcting":
      return t(ISLAND_ACTIVITY_STRINGS.correcting);
    case "read":
    case "edit":
    case "web":
    case "plan":
    case "screen":
    case "computer":
    case "starting":
    case "loading":
    case "prompt":
      return activityLabel(activity);
    default:
      return t(COMPACT_TEXT.thinking);
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
 * A finished answer's text, in its bubble. `scope`: the message it is, so its
 * cards keep their state. `streaming`: the ink is still uncovering it (the
 * text is cut short), so a card not closed yet waits and none can send.
 */
function drawReply(reply: HTMLElement, content: string, workshop: boolean, scope?: string, streaming = false) {
  if (workshop) {
    const shown = stripDraft(content);
    renderMarkdown(reply, shown.text, { scope, streaming });
    const draft = shown.draft ? draftIn(content) : null;
    if (draft) reply.append(draftChip(draft.name));
  } else {
    renderAnswer(reply, content, { scope, streaming, send: streaming ? undefined : sendFromCard });
  }
}

/**
 * An answer as far as it is written, without Lumo's lines; in the tool
 * workshop, the tool's blocks give way to a line saying it is being written.
 * `scope`: the message it will be, so its cards keep their state when the
 * finished answer replaces it.
 */
function drawAnswer(into: HTMLElement, text: string, workshop: boolean, scope: string) {
  const shown = takeListens(takeTimers(text).text).text;
  if (!workshop) {
    renderAnswer(into, shown, { streaming: true, scope });
    return;
  }
  const words = stripDraft(shown);
  let line: HTMLElement | null = null;
  if (words.writing || words.draft) {
    // The same line from one draw to the next, so its dot pulses on.
    line = forgeLines.get(into) ?? h("div", { class: "forge-writing" }, h("i"), h("span", { text: t(FORGE_STRINGS.writing) }));
    forgeLines.set(into, line);
  }
  renderMarkdown(into, words.text, { streaming: true, scope, after: line });
}

/** The workshop's "Writing the tool…" line of each answer being written. */
const forgeLines = new WeakMap<HTMLElement, HTMLElement>();

/** The checklists read from each answer's text, so a redraw doesn't read them again. */
const answerLists = new Map<string, Checklist[]>();
const ANSWER_LISTS_LIMIT = 200;

function listsOfAnswer(text: string): Checklist[] {
  let lists = answerLists.get(text);
  if (!lists) {
    lists = checklistsIn(text);
    if (answerLists.size >= ANSWER_LISTS_LIMIT) answerLists.clear();
    answerLists.set(text, lists);
  }
  return lists;
}

/**
 * Tells core/checklists.ts which checklists `chatId`'s answers hold, the one
 * being written included, before they are drawn: a list written again
 * further down shows as updated there. In the tool workshop, only from what
 * its answers show: the tool's blocks are not drawn.
 */
function noteChecklists(chatId: string, history: ChatMessage[], writing?: string) {
  const workshop = isWorkshopChat(chatId);
  const shown = (text: string) => (workshop ? stripDraft(text).text : text);
  const writ = writing ? checklistsIn(shown(writing), true) : undefined;
  noteChatChecklists(chatId, listsInChat(history, (text) => listsOfAnswer(shown(text)), writ));
}

/**
 * What the user ticked in `chatId`'s checklists, when it differs from what
 * the AI last wrote and it was not told yet: lines to send with the question
 * (never shown in its bubble, nor in Copy or Edit), and what to remember as
 * told once the question went (checklistsTold).
 */
function checklistsToTell(chatId: string, history: ChatMessage[]): { text: string; told: Record<string, string> } {
  noteChecklists(chatId, history);
  return checklistNote(lineagesOf(chatId), chatChecklists(chatId));
}

/** The AI got the question and its checklist lines: they are not sent again. */
function checklistsTold(chatId: string, told: Record<string, string>) {
  if (Object.keys(told).length) setChatChecklists(chatId, withTold(chatChecklists(chatId), told));
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
  /** Asks a local model's server what the model picked can do, when it changed (or `force`d). */
  refreshCaps(force?: boolean): void;
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

  /**
   * A local model's server is asked what the model picked can do (pictures,
   * tools, reasoning, its context) each time the model changes: the effort
   * slider, the screenshots and the line next to the model follow. A provider
   * called by its API says it in its model list, once the picker has it: no
   * call of its own.
   */
  let capsKey = "";
  function refreshCaps(force = false) {
    if (force) capsKey = "";
    const p = providerDef(State.settings.chatProvider);
    const model = activeModel(State.settings);
    const api = isApiProvider(p.id);
    const key = (p.urlField || api) && model ? `${p.id}|${model}|${api && cache.has(p.id) ? "listed" : ""}` : "";
    if (key === capsKey) return;
    capsKey = key;
    if (!key) return;
    if (api) {
      setLocalCaps(p.id, apiCaps(cache.get(p.id)?.find((m) => m.id === model)));
      drawEfforts();
      onChange();
      return;
    }
    setLocalCaps(p.id, null);
    void Bridge.localCaps(p.id, model)
      .then((caps) => {
        if (capsKey !== key) return;
        setLocalCaps(p.id, caps);
        drawCaps();
        drawEfforts();
        onChange();
      })
      .catch(() => {});
  }

  /** What the local model picked can do, on its row: "Images · Tools · Thinking · Context 64k / 256k". */
  function drawCaps() {
    const p = providerDef(State.settings.chatProvider);
    const slot = list.querySelector<HTMLElement>(".picker-model.on .picker-model-caps");
    if (!slot || !p.urlField) return;
    const caps = localCapsOf(p.id);
    const context = capsContext(caps);
    const words = capsWords(caps).map((w) => t(w));
    if (context) words.push(`${t(CONTEXT_STRINGS.title)} ${context}`);
    slot.textContent = words.join(" · ");
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
        on && p.urlField ? h("span", { class: "picker-model-caps" }) : null,
        on ? svg(ICONS.check, 11, { stroke: 2.2 }) : null,
      );
      if (holds(p)) row.append(loadButton(p, m.id));
      row.addEventListener("click", () => {
        State.settings = withModel(State.settings, p.id, m.id);
        saveSettings();
        Sound.play("blip");
        close();
        refreshCaps();
      });
      list.append(row);
    }
    drawCaps();
    list.querySelector(".picker-model.on")?.scrollIntoView({ block: "nearest" });
    if (holds(p)) void drawLoaded(p, models.map((m) => m.id));
  }

  /** Ollama and LM Studio load and eject models; a custom server doesn't say. */
  function holds(p: ProviderDef): boolean {
    return p.id === "ollama" || p.id === "lmstudio" || p.id === "unsloth";
  }

  /** Which models are in memory: − on those, + on the others. */
  async function drawLoaded(p: ProviderDef, ids: string[]) {
    const ticket = request;
    let loaded: string[];
    try {
      loaded = await Bridge.localLoadedOf(p.id, ids);
    } catch {
      return;
    }
    if (ticket !== request || !isOpen) return;
    for (const b of list.querySelectorAll<HTMLElement>(".picker-model-load")) {
      if (b.dataset.busy) continue;
      setLoadState(b, loaded.includes(b.dataset.model ?? "") ? "loaded" : "unloaded");
    }
  }

  function setLoadState(b: HTMLElement, state: "loaded" | "unloaded" | "busy", percent?: number) {
    b.dataset.state = state;
    b.hidden = false;
    clear(b);
    if (state === "busy") {
      b.dataset.busy = "1";
      b.title = t(LOAD_STRINGS.loading);
      b.append(h("span", { class: "picker-model-load-pct", text: percent != null ? `${percent}%` : "…" }));
      return;
    }
    delete b.dataset.busy;
    b.title = t(state === "loaded" ? LOAD_STRINGS.eject : LOAD_STRINGS.load);
    b.append(svg(state === "loaded" ? LOAD_MINUS : LOAD_PLUS, 15, { stroke: 1.6 }));
  }

  /** The round − / + at the far right of a local model's row. */
  function loadButton(p: ProviderDef, model: string): HTMLElement {
    const b = h("span", { class: "picker-model-load", role: "button" });
    b.dataset.model = model;
    b.hidden = true;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (b.dataset.busy) return;
      const eject = b.dataset.state === "loaded";
      setLoadState(b, "busy");
      const done = eject ? Bridge.localUnloadModel(p.id, model) : Bridge.localLoad(p.id, model);
      Sound.play("blip");
      void done
        .then(() => setLoadState(b, eject ? "unloaded" : "loaded"))
        .catch((err) => {
          setLoadState(b, eject ? "loaded" : "unloaded");
          b.title = String(err).replace(/^Error:\s*/, "");
        })
        .finally(() => {
          if (State.settings.chatProvider === p.id && activeModel(State.settings) === model) {
            capsKey = "";
            refreshCaps();
          }
        });
    });
    return b;
  }

  void onEvent<LocalLoad>("local-load", (e) => {
    for (const b of list.querySelectorAll<HTMLElement>(".picker-model-load")) {
      if (b.dataset.model === e.model && b.dataset.busy) setLoadState(b, "busy", Math.round(e.percent));
    }
  });

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
    // Unsloth Studio off: Lumo starts it before it lists the models, and says so.
    const starting = p.id === "unsloth"
      ? await onEvent<UnslothStudio>(UNSLOTH_STUDIO_EVENT, (s) => {
          if (ticket !== request || s.state !== "starting") return;
          const seconds = s.seconds >= 2 ? ` ${t(ACTIVITY_STRINGS.seconds, { seconds: s.seconds })}` : "";
          status(`${t(ACTIVITY_STRINGS.starting)}${seconds}`);
        })
      : null;
    try {
      const models = await Bridge.chatModels(p.id).finally(() => starting?.());
      if (ticket !== request) return;
      if (!p.urlField) cache.set(p.id, models);
      const keep = pickModel(p, models.map((m) => m.id), activeModel(State.settings));
      if (keep && keep !== activeModel(State.settings)) {
        State.settings = withModel(State.settings, p.id, keep);
        saveSettings();
        onChange();
      }
      // The list says what its models take: the effort slider follows.
      if (isApiProvider(p.id)) refreshCaps();
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
    refreshCaps,
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

/** Within this of the end the log is at its end, and stuck to it. */
const STUCK_PX = 1;
/** Further up from the end than this share of the log's height, the arrow down shows. */
const TO_END_ARROW_SCREENS = 1;

// ── View ──────────────────────────────────────────────────────────────────────

/** `openSettings`: the island's Settings view (the window where there is no island, as in tests). */
/** The copies waiting in the field, not sent yet: never deleted from under it. */
function fieldCopies(): string[] {
  return [State.droppedFile?.path ?? "", ...State.moreFiles.map((f) => f.path)].filter(Boolean);
}

export function buildPrompt(
  onHeightChange: () => void,
  openSettings: () => void = () => void Bridge.openSettingsWindow(),
  talk: () => void = () => {},
  showPlan: () => void = () => {},
  chatDeleted: (chatId: string) => void = () => {},
  openTools: () => void = () => {},
  decide: (d: "allow" | "deny", requestId: string) => void = () => {},
  chatRewound: (chatId: string) => void = () => {},
): ViewHost {
  // Copies no past chat names any more (deleted before Lumo released them,
  // or gone past the history's end) leave the inbox once a day old.
  void Bridge.inboxTidy([...keptCopies(), ...fieldCopies()]);
  const chipRow = h("div", { class: "chip-row" });
  const log = h("div", { class: "chat-log" });
  // The log stays where it is read: sending a question and the answer being
  // written never scroll it. Only a chat coming on screen opens at its end.
  gentleWheel(log);
  let openedChat = true;
  // Scrolled all the way down, the log is stuck to its end and follows what is
  // written there, with no animation; the slightest scroll up lets go of it.
  // Away from the end, an arrow over the log brings it back down.
  let stuck = true;
  const toEnd = h("button", { class: "chat-to-end", title: tl(STRINGS.toEnd) }, svg(ICONS.arrowDown, 11));
  toEnd.hidden = true;
  const fromEnd = () => log.scrollHeight - log.clientHeight - log.scrollTop;
  /** The arrow shows about a screenful up from the end, at the bottom of the log. */
  function drawToEnd() {
    const away = log.clientHeight > 0 && fromEnd() > log.clientHeight * TO_END_ARROW_SCREENS;
    if (away) {
      toEnd.style.top = `${log.offsetTop + log.clientHeight - 32}px`;
      toEnd.style.left = `${log.offsetLeft + log.clientWidth / 2 - 13}px`;
    }
    if (toEnd.hidden === away) toEnd.hidden = !away;
  }
  /** Stuck: down to the end of what is there now. */
  function follow() {
    if (stuck && log.clientHeight > 0) log.scrollTop = log.scrollHeight;
    drawToEnd();
  }
  log.addEventListener("scroll", () => {
    if (log.clientHeight === 0) return; // hidden behind a panel
    stuck = fromEnd() <= STUCK_PX;
    drawToEnd();
  }, { passive: true });
  // A turn of the wheel upwards lets go at once, before the scroll it starts.
  log.addEventListener("wheel", (e) => {
    if (e.deltaY < 0 && !e.ctrlKey && !e.shiftKey) stuck = false;
  }, { passive: true });
  // Whatever grows the log (streamed text, the dots, a picture loading, the
  // island resizing) keeps it at its end while it is stuck there.
  if (typeof MutationObserver !== "undefined") {
    new MutationObserver(follow).observe(log, { childList: true, subtree: true, characterData: true });
  }
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(follow).observe(log);
  log.addEventListener("load", follow, true);
  // The log drawn again (an answer just finished) puts back the place it was
  // read at. Its cards are new and fit themselves once laid out (rich/resize.ts),
  // so for that first frame one can be taller than it was while written: the
  // browser's scroll anchoring would hold on to that and leave the chat higher
  // up than where it was read. It is off until the cards have fitted, two frames.
  let anchorFrame = 0;
  function holdPlace() {
    if (typeof requestAnimationFrame === "undefined") return;
    log.style.overflowAnchor = "none";
    cancelAnimationFrame(anchorFrame);
    anchorFrame = requestAnimationFrame(() => {
      anchorFrame = requestAnimationFrame(() => {
        anchorFrame = 0;
        log.style.overflowAnchor = "";
      });
    });
  }
  toEnd.addEventListener("click", () => {
    stuck = true;
    follow();
  });
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

  // The question sent while the chat was answered, just above the field.
  const queueText = h("div", { class: "queue-text" });
  const queueEdit = h("button", { class: "queue-btn", title: tl(STRINGS.edit), "aria-label": tl(STRINGS.edit) }, svg(ICONS.pencil, 11, { stroke: 1.8 }));
  const queueCancel = h("button", { class: "queue-btn", title: tl(STRINGS.cancel), "aria-label": tl(STRINGS.cancel) }, svg(ICONS.xmark, 9));
  const queueEl = h(
    "div",
    { class: "chat-queue", title: tl(STRINGS.queuedHint) },
    h("span", { class: "queue-label" }, svg(ICONS.clock, 10, { stroke: 2 }), h("span", { text: tl(STRINGS.queued) })),
    queueText,
    queueEdit,
    queueCancel,
  );
  queueEl.hidden = true;

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
  // What Lumo is listening to (views/listening.ts): always there, grey while
  // nothing listens; lit, with how many, while something does.
  const listenBadge = h("span", { class: "tool-badge listen-badge" });
  const listenBtn = h("button", { class: "tool-btn listen-btn", title: tl("Listening"), "aria-label": tl("Listening") },
    svg(ICONS.waves, 13, { stroke: 1.8 }), listenBadge);
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
  /** Watches each chat's answers asked for, waiting for the user's Listen (drawListenAsk). */
  const listenAsks = new Map<string, ListenAsk[]>();
  // The plan: a chip beside the model in place of the icon, its steps rising
  // over the chat from this row (plan-strip.ts).
  const planStrip = buildPlanStrip(() => showPlan());
  // The new look's plan asking to start, from this chat (concept C1): its steps
  // over the field, Approve and Keep planning; what is typed in the field
  // instead says what to change (the plan is declined, the text goes next).
  const planAskTitle = h("span", { class: "plan-ask-title" });
  const planAskWho = h("span", { class: "plan-ask-who" });
  const planAskList = h("div", { class: "plan-ask-list" });
  let planAskFor: string | null = null;
  let planAskAt = 0;
  const planDecide = (d: "allow" | "deny") => () => {
    // A click meant for something else, as the card came up, answers nothing.
    if (planAskFor == null || performance.now() - planAskAt < PLAN_ASK_GUARD_MS) return;
    decide(d, planAskFor);
  };
  const planApprove = h("button", { class: "plan-ask-btn approve", type: "button", onclick: planDecide("allow") }, h("span", { text: tl(STRINGS.planApprove) }));
  const planAsk = h("div", { class: "plan-ask" },
    h("div", { class: "plan-ask-head" }, planAskTitle, planAskWho),
    planAskList,
    h("div", { class: "plan-ask-actions" },
      h("button", { class: "plan-ask-btn keep", type: "button", onclick: planDecide("deny") }, h("span", { text: tl(STRINGS.planKeep) })),
      planApprove));
  planAsk.hidden = true;
  /** The plan this chat asks to start, if one is waiting for an answer. */
  const planAsking = () => {
    const req = State.pendingApproval;
    return State.chatSlot !== "forge" && planAskInChat(req) ? req : null;
  };
  function drawPlanAsk() {
    const req = planAsking();
    planStrip.ask(req?.plan ?? null);
    const id = req?.requestId ?? null;
    if (id === planAskFor) return;
    planAskFor = id;
    planAskAt = performance.now();
    planAsk.hidden = !req;
    // A plan too long to reach the island whole is never approved from here (pipe.rs refuses it).
    planApprove.style.display = req?.cut === true ? "none" : "";
    clear(planAskList);
    if (req?.plan) {
      planAskTitle.textContent = tn("{agent} has a plan · {count} step", "{agent} has a plan · {count} steps", req.plan.length,
        { agent: t(providerDef(State.settings.chatProvider).name) });
      planAskWho.textContent = activeModel(State.settings) || "";
      planAskList.append(planAskSteps(req.plan));
    }
    onHeightChange();
  }
  // What an answer asked Lumo to listen for, over the field, waiting for the
  // user's word: nothing listens, and nothing is sent to the chat later, until
  // Listen is clicked (concept: ascolto-con-conferma).
  const listenAskList = h("div", { class: "listen-ask-list" });
  let listenAskShownFor = "";
  let listenAskAt = 0;
  const listenAskDecide = (yes: boolean) => () => {
    // A click meant for something else, as the box came up, answers nothing.
    if (performance.now() - listenAskAt < PLAN_ASK_GUARD_MS) return;
    const chatId = State.chatId;
    const asks = listenAsks.get(chatId) ?? [];
    listenAsks.delete(chatId);
    drawListenAsk();
    if (yes && asks.length) void startListens(chatId, asks);
  };
  const listenAsk = h("div", { class: "plan-ask listen-ask" },
    h("div", { class: "plan-ask-head" }, h("span", { class: "plan-ask-title", text: tl(STRINGS.listenAsk) })),
    h("div", { class: "listen-ask-why", text: tl(STRINGS.listenWhy) }),
    listenAskList,
    h("div", { class: "plan-ask-actions" },
      h("button", { class: "plan-ask-btn keep", type: "button", onclick: listenAskDecide(false) }, h("span", { text: tl(STRINGS.listenNo) })),
      h("button", { class: "plan-ask-btn approve", type: "button", onclick: listenAskDecide(true) }, h("span", { text: tl(STRINGS.listenYes) }))));
  listenAsk.hidden = true;
  /** The box for the chat on screen: each watch its answer asked for, by name, event and what then. */
  function drawListenAsk() {
    const asks = State.chatSlot !== "forge" ? listenAsks.get(State.chatId) ?? [] : [];
    const key = asks.length ? `${State.chatId}:${JSON.stringify(asks)}` : "";
    if (key === listenAskShownFor) return;
    listenAskShownFor = key;
    listenAskAt = performance.now();
    listenAsk.hidden = asks.length === 0;
    clear(listenAskList);
    for (const ask of asks) {
      const w = { ...ask, id: 0, chatId: State.chatId, startedAt: 0 } as ListenWatch;
      listenAskList.append(h("div", { class: "listen-ask-row", style: `--watch:${watchColor(w)}` },
        h("span", { class: "listen-ask-dot" }),
        h("span", { class: "listen-ask-text" },
          h("span", { class: "listen-ask-what", text: `${watchLabel(w)} · ${untilText(w)}${w.text ? ` "${w.text}"` : ""}` }),
          ask.task ? h("span", { class: "listen-ask-then", text: t(STRINGS.listenThen, { task: ask.task }) }) : null)));
    }
    onHeightChange();
  }
  // The ring sits right before the model it measures.
  const modelRow = h("div", { class: "model-row" },
    planStrip.el,
    h("div", { class: "chat-tools" }, newBtn, historyBtn, filesBtn, listenBtn),
    h("div", { class: "model-side" }, planBtn, planStrip.chip, usageEl, modelBtn));

  const body = h("div", { class: "chat-body" });
  const picker = buildPicker(() => {
    body.classList.toggle("picking", picker.isOpen);
    if (picker.isOpen) {
      closeFiles();
      closeHistory();
      closeScreen();
      closePermissions();
      closeUsage();
      closeListening();
    }
    panelChanged();
    drawModelButton();
    drawUsage();
  }, openSettings);

  /** An open list gets the chat's full height; closing it gives the room back. */
  function panelChanged() {
    const open = picker.isOpen || ["browsing", "filing", "screening", "authorizing", "metering", "commanding", "hearing"].some((c) => body.classList.contains(c));
    const hearing = body.classList.contains("hearing");
    // The usage menu holds the context and the limits: as much room as Listening.
    // A local model's four modes (an API provider's too) want more room than the CLIs' three.
    const tall = (body.classList.contains("metering") && usageList.querySelector(".usage-ctx") != null)
      || body.classList.contains("screening")
      || (body.classList.contains("authorizing") && usesLumoTools(State.settings.chatProvider));
    if (open === State.chatPanelOpen && hearing === State.listeningOpen && tall === State.chatPanelTall) return;
    State.chatPanelOpen = open;
    State.listeningOpen = hearing;
    State.chatPanelTall = tall;
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
  const permHead = h("div", { class: "picker-title", text: t(STRINGS.permissions) });
  const permEl = h("div", { class: "picker permissions" }, permHead, permList);
  const usageTitle = h("div", { class: "picker-title" });
  const usageList = h("div", { class: "picker-list usage-list" });
  const usagePanel = h("div", { class: "picker usage-panel usage-new" }, usageTitle, usageList);
  // What Lumo is listening to, and what it heard; a row of another chat opens it.
  const listening = buildListeningPanel({
    goToChat: (chatId) => {
      const saved = loadChats().find((c) => c.id === chatId);
      if (!saved) return;
      closeListening();
      openChat(saved);
    },
    close: () => closeListening(),
    // Make a source: a tool of one's own, in the workshop.
    openWorkshop: () => {
      closeListening();
      State.forgeAsk = { edit: null };
      State.useSlot("forge");
      State.notify();
    },
  });
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
  body.append(forge.head, chipRow, log, picker.el, historyEl, filesEl, listening.el, screenEl, permEl, usagePanel, slashEl, queueEl, planAsk, listenAsk, modelRow, bar, toEnd);

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
    if (body.classList.contains("hearing") && !inside(listening.el, listenBtn)) closeListening();
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
  /**
   * The on-screen answer, written in ink (views/ink.ts): at a steady pace,
   * behind a soft edge. It goes on into the finished answer's bubble until
   * what arrived is all uncovered.
   */
  let ink: Ink | null = null;
  let inkChat = "";
  /**
   * Shows `text`, the answer of `chat` so far, in `into`. `fresh`: its first
   * words, written from the start; otherwise an answer already under way
   * shows as far as it got at once, and only what comes next is written.
   */
  function writeAnswer(chat: string, into: HTMLElement, text: string, fresh: boolean, scope: string) {
    const workshop = isWorkshopChat(chat);
    if (!inkWorks()) {
      drawAnswer(into, text, workshop, scope);
      return;
    }
    if (fresh || !ink || inkChat !== chat) {
      ink?.stop();
      ink = new Ink((el, words) => drawAnswer(el, words, workshop, scope));
      inkChat = chat;
      ink.update(text);
      if (!fresh) ink.skip();
      ink.mount(into);
      return;
    }
    ink.update(text);
    if (ink.target !== into) ink.mount(into);
  }
  function dropInk() {
    ink?.stop();
    ink = null;
    inkChat = "";
  }
  /** The question being edited (its id): sending replaces it and drops what follows. */
  let editing: number | null = null;
  /** What the send button shows now: "send" or "stop". */
  let sendShows = "send";

  // ── Remaining usage ───────────────────────────────────────────────────────

  /** The last numbers each provider came back with (Anthropic, OpenAI, OpenRouter). */
  const seenUsage = new Map<string, SeenUsage>();
  /** A local model's context, per chat: each chat shows its own, not the last one answered. */
  const seenContext = new Map<string, SeenUsage>();
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
    const local = Boolean(providerDef(State.settings.chatProvider).urlField);
    const seen = local ? seenContext.get(State.chatId) : seenUsage.get(State.settings.chatProvider);
    // A provider called by its API: this chat's context too, next to its limits.
    const context = isApiProvider(State.settings.chatProvider) ? seenContext.get(State.chatId) : undefined;
    const line = usageLine(State.settings, State.planUsage, seen, now, State.antigravityPlanUsage, State.chatId, context);
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
    // A local model's ring is its context: the menu says only that. So does
    // an API provider's that tells no limits (Google's).
    const local = providerDef(State.settings.chatProvider).urlField !== null || Boolean(line?.context);
    usageTitle.textContent = USAGE_TEXT.title;
    clear(usageList);
    if (!line) return;
    // The context as one split bar, then the limits as bars (views/usage-panel.ts).
    usageTitle.textContent = local ? t(CONTEXT_STRINGS.title) : USAGE_TEXT.title;
    const report = lastContextReport(State.chatHistory);
    // Claude Code's answers say how full the conversation is (claude_code.rs, chat-usage).
    const filled = local ? null : seenContext.get(State.chatId)?.context ?? null;
    // Antigravity CLI says only the tokens: its model's window comes from its name, and the figure is about.
    const agy = State.settings.chatProvider === "antigravity-cli";
    const total = filled ? (filled.total > 0 ? filled.total : agy ? agyContextWindow(activeModel(State.settings)) ?? 0 : 0) : 0;
    const fill = filled && total > 0 ? { used: filled.used, total, estimate: agy } : null;
    drawNewUsage(usageList, {
      line, local, report, fill,
      askContext: State.settings.chatProvider === "claude-code" && !report?.fresh ? () => {
        closeUsage();
        void submit("/context");
      } : null,
    });
    // Taller while it holds the context (the menu may be open as /context lands).
    if (body.classList.contains("metering")) panelChanged();
    // A local model's context, or an API provider's: /compact from here, under its bar.
    if ((local || isApiProvider(State.settings.chatProvider)) && State.chatHistory.length > 0) {
      const compact = h("button", { class: "usage-compact", title: t(SLASH_STRINGS.compact), onclick: () => void compactChat() },
        svg(COMPACT_ICON, 12, { stroke: 1.8 }), h("span", { text: t(COMPACT_STRINGS.action) }));
      usageList.append(h("div", { class: "usage-compact-row" }, compact));
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
    closeListening();
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
    // An API provider's model whose context Rust doesn't know: its list's, when the picker has it.
    if (u.context && !(u.context.total > 0) && isApiProvider(u.provider)) {
      const total = localCapsOf(u.provider)?.maxContext ?? 0;
      if (total > 0) u = { ...u, context: { ...u.context, total } };
    }
    seenUsage.set(u.provider, { ...u, at: Date.now() });
    if (u.context && typeof u.context.chat === "string") seenContext.set(u.context.chat, { ...u, at: Date.now() });
    // The usage menu open on this chat shows how full it now is.
    if (body.classList.contains("metering")) drawUsageMenu();
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
    picker.refreshCaps();
    const p = providerDef(State.settings.chatProvider);
    modelDot.style.background = p.accent;
    const model = activeModel(State.settings) || t(STRINGS.noModel);
    const effort = effortFor(p.id, State.settings.chatEffort);
    modelName.textContent = effort ? `${model} · ${effortLabel(effort)}` : model;
    // A long name is cut; the whole of it shows on hover.
    modelName.title = modelName.textContent;
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
    // Something typed meanwhile: the arrow, which queues it.
    const stops = run != null && editing == null && !input.value.trim();
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
   * Retry on the last question or its answer: the question goes again as it
   * was written, as if edited and sent unchanged; its answer leaves the chat.
   * What is typed in the field stays there.
   */
  function retry(message: ChatMessage) {
    if (preparing || answering() || editing != null) return;
    editing = message.id;
    void submit(undefined, message.content);
  }

  /**
   * Sending an edited question: it and everything after it leave the chat,
   * here and in Rust (chat.rs rewind), before the new text is sent. The Claude
   * Code session is left behind too: the next turn starts a fresh one with the
   * kept turns carried as text, so the dropped ones are gone for it as well,
   * and so is the plan they made: it leaves the Plan island, or the next
   * answer's steps would be added to it as if the model still followed it.
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
    // The cards of the dropped messages (a quiz's answers) are not the next answer's.
    forgetCardsFrom(State.chatId, kept.filter((m) => !m.failed).length);
    renderedCount = -1;
    // The files of the dropped turns leave the chat's files, and Rust forgets them too.
    rewindChatFiles(State.chatId, keep);
    presenceAsked = "";
    drawChatFiles();
    if (State.chatId) chatRewound(State.chatId);
    await Bridge.chatRewind(State.chatId, keep);
  }

  // ── Permissions ───────────────────────────────────────────────────────────
  //
  // What Claude Code or Antigravity CLI may do without a card, from the next
  // message on: each turn starts the CLI again with that mode. A local model,
  // and a provider called by its API, whose actions are Lumo's tools run on
  // this computer, have a fourth mode, and the sandbox's level behind the
  // chip in the title.

  /** What the panel shows with a local model or an API provider: the modes, or the sandbox's levels. */
  let permView: "modes" | "sandbox" = "modes";

  function drawPermissions() {
    clear(permList);
    const p = providerDef(State.settings.chatProvider);
    if (usesLumoTools(p.id) && permView === "sandbox") {
      drawSandbox(p);
      return;
    }
    drawPermHead(p);
    const current = parsePermissionMode(storedPermissionMode(State.settings, p.id), p.id);
    for (const mode of permissionModesFor(p.id)) {
      const on = mode === current;
      const text = modeText(p, mode);
      const row = h(
        "button",
        { class: on ? "picker-model perm-row on" : "picker-model perm-row", style: `--accent:${p.accent}` },
        h(
          "span",
          { class: "perm-text" },
          h("span", { class: "picker-model-name", text: t(text.name) }),
          h("span", { class: "perm-note", text: t(text.note) }),
        ),
        on ? svg(ICONS.check, 11, { stroke: 2.2 }) : null,
      );
      row.addEventListener("click", () => {
        // The stored mode, not the one shown: one setting serves every provider
        // but Antigravity CLI, which keeps its own, and a CLI shows a local
        // model's "off" as "default".
        if (storedPermissionMode(State.settings, p.id) !== mode) {
          State.settings = withPermissionMode(State.settings, p.id, mode);
          saveSettings();
          Sound.play("blip");
        }
        closePermissions();
        State.notify();
      });
      permList.append(row);
    }
  }

  /** The panel's title: with a local model or an API provider, the sandbox's chip beside it. */
  function drawPermHead(p: ProviderDef) {
    clear(permHead);
    if (!usesLumoTools(p.id)) {
      permHead.className = "picker-title";
      permHead.textContent = t(STRINGS.permissions);
      return;
    }
    const level = SANDBOX_TEXT[parseSandboxLevel(State.settings.localSandbox)];
    const chip = h(
      "button",
      { class: "sandbox-chip" },
      h("span", { text: t(STRINGS.sandbox) }),
      h("span", { class: "sandbox-level", style: `color:${level.color}`, text: tc(level.name) }),
      svg(ICONS.chevronRight, 9, { stroke: 2.2 }),
    );
    chip.addEventListener("click", () => {
      permView = "sandbox";
      drawPermissions();
    });
    permHead.className = "picker-title perm-head";
    permHead.append(h("span", { text: t(STRINGS.permissions) }), chip);
  }

  /** The sandbox's levels, under a way back to the modes. */
  function drawSandbox(p: ProviderDef) {
    clear(permHead);
    const back = h("button", { class: "perm-back" }, svg(ICONS.chevronLeft, 10, { stroke: 2.2 }), h("span", { text: t(STRINGS.isolate) }));
    back.addEventListener("click", () => {
      permView = "modes";
      drawPermissions();
    });
    permHead.className = "picker-title perm-head";
    permHead.append(back);
    const current = parseSandboxLevel(State.settings.localSandbox);
    for (const level of ["low", "high"] as const) {
      const on = level === current;
      const row = h(
        "button",
        { class: on ? "picker-model perm-row on" : "picker-model perm-row", style: `--accent:${p.accent}` },
        h(
          "span",
          { class: "perm-text" },
          h("span", { class: "picker-model-name", text: tc(SANDBOX_TEXT[level].name) }),
          h("span", { class: "perm-note", text: t(SANDBOX_TEXT[level].note) }),
        ),
        on ? svg(ICONS.check, 11, { stroke: 2.2 }) : null,
      );
      row.addEventListener("click", () => {
        if (State.settings.localSandbox !== level) {
          State.settings = { ...State.settings, localSandbox: level };
          saveSettings();
          Sound.play("blip");
        }
        permView = "modes";
        drawPermissions();
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

  /** The shield: shown for the CLIs, the model servers and the API providers, lit when they may do more than ask. */
  function drawPermButton() {
    const cli = hasPermissions(State.settings.chatProvider);
    permBtn.hidden = !cli;
    if (!cli) closePermissions();
    const mode = parsePermissionMode(storedPermissionMode(State.settings, State.settings.chatProvider), State.settings.chatProvider);
    permBtn.classList.toggle("lit", mode !== "default");
    permBtn.title = `${t(STRINGS.permissions)} · ${t(modeText(providerDef(State.settings.chatProvider), mode).name)}`;
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
    closeListening();
    permView = "modes";
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
    closeListening();
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

  // ── Listening ─────────────────────────────────────────────────────────────

  function openListening() {
    if (picker.isOpen) picker.close();
    closeHistory();
    closeFiles();
    closeScreen();
    closePermissions();
    closeUsage();
    body.classList.add("hearing");
    listenBtn.classList.add("open");
    listening.opened();
    panelChanged();
  }

  function closeListening() {
    if (!body.classList.contains("hearing")) return;
    body.classList.remove("hearing");
    listenBtn.classList.remove("open");
    panelChanged();
  }

  /** What the waves were last drawn for. */
  let listenKey = "";

  /** The waves: lit, with how many, while something listens; the panel redrawn. */
  function drawListening() {
    const on = activeWatches(State.listening).length;
    listenBtn.classList.toggle("listening", on > 0);
    listenBadge.textContent = on > 0 ? String(on) : "";
    const title = listeningButtonTitle(State.listening);
    listenBtn.title = title;
    listenBtn.setAttribute("aria-label", title);
    if (body.classList.contains("hearing")) listening.draw();
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
    closeListening();
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
    // Pills and tiles (views/share-panel.ts), with the windows listed too.
    let windows: OpenWindow[] = [];
    try {
      windows = (await Bridge.screenWindows()) ?? [];
    } catch {
      // The Windows pill then says none is open.
    }
    if (ticket !== screenTicket) return;
    drawShareTiles(displays, explorer, tabList ?? [], windows, problem);
    // Drawn without the tabs: they join once they come, if the menu is still there.
    if (tabList === null) {
      void tabs.then((list) => {
        if (ticket === screenTicket && list.length > 0) drawShareTiles(displays, explorer, list, windows, problem);
      });
    }
  }

  /** The kind of things the Share menu shows: the last one picked. */
  let shareKind: ShareKindId = "windows";

  function drawShareTiles(displays: ScreenDisplay[], explorer: ExplorerPeek, tabList: BrowserTab[], windows: OpenWindow[], problem: string) {
    const images = seesImages(providerDef(State.settings.chatProvider));
    const fromPicks = (picks: PickEntry[], go: (pick: PickEntry) => void): ShareItem[] =>
      picks.map((pick) => ({ key: String(pick.id), label: pick.label, detail: pick.detail, title: [pick.title || pick.label, pick.detail].filter(Boolean).join("\n"), all: pick.id == null, go: () => go(pick) }));
    const screens: ShareItem[] = displays.map((d) => ({
      key: `d${d.index}`, label: screenLabel(d.index), detail: `${d.width} × ${d.height}`, title: `${screenLabel(d.index)} · ${d.width} × ${d.height}`, disabled: !images,
      go: () => void shareScreen(d.index),
    }));
    if (displays.length > 1) screens.unshift({ key: "all", label: t(SCREEN_STRINGS.allScreens), title: t(SCREEN_STRINGS.allScreens), all: true, disabled: !images, go: () => void shareScreen(null) });
    const folders = explorer.problem ? [] : explorer.folders;
    const kinds: ShareKind[] = [
      { id: "windows", count: windows.length, items: fromPicks(windowPicks(windows), (pick) => void shareWindows(pick, windows)), empty: t(SCREEN_STRINGS.noWindows) },
      ...(displays.length ? [{ id: "screens" as const, count: displays.length, items: screens }] : []),
      ...(tabList.length ? [{ id: "tabs" as const, count: tabList.length, items: fromPicks(tabPicks(tabList), (pick) => void shareTabs(pick)) }] : []),
      ...(folders.length ? [{ id: "folders" as const, count: folders.length, items: fromPicks(folderPicks(folders), (pick) => void shareFolders(typeof pick.id === "string" ? [pick.id] : [])) }] : []),
    ];
    const notes = problem ? [problem] : displays.length > 0 && !images ? [noImagesReason(providerDef(State.settings.chatProvider))] : [];
    drawShareGrid(screenList, kinds, shareKind, (id) => { shareKind = id; }, notes, t(SCREEN_STRINGS.nothingYet));
  }

  /** Something was added from the menu: the panel goes, the chip shows. */
  function added() {
    closeScreen();
    Sound.play("attach");
    State.notify();
    input.focus();
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

  /** A picture of one screen, or of all of them (`null`), to confirm before it is added. */
  async function shareScreen(index: number | null) {
    const ticket = ++screenTicket;
    clear(screenList);
    screenStatus(t(SCREEN_STRINGS.capturing));
    let shots: ScreenShot[];
    try {
      shots = await Bridge.screenCapture(index);
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
    closeListening();
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
        // Its copies in the inbox too, but for those another chat or the field still has.
        const copies = chatCopies(c.id);
        dropChatFiles(c.id);
        // So does its folder of copies (workspace.rs).
        void Bridge.workspaceDelete(c.id);
        if (copies.length > 0) void Bridge.inboxRelease(copies, [...keptCopies(), ...fieldCopies()]);
        // Being answered in the background (or just finished): that entry ends with it.
        clearFinishedChat(c.id);
        const run = runs.get(c.id);
        if (run) {
          run.forgotten = true;
          if (!run.stopping) void Bridge.chatStop(c.id);
          run.stopping = true;
          drawIslandActivity();
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
      State.chatHistory = c.turns.map((turn, i) => ({ id: nextId++, role: turn.role, content: turn.content, turn: i, at: typeof turn.at === "number" ? turn.at : undefined, kept: typeof turn.kept === "string" ? turn.kept : undefined }));
      State.chatSession = c.session;
      void Bridge.chatRestore(c.id, State.chatHistory.map(conversationTurn), c.session, compactOf(c.id));
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
    closeListening();
    editing = null;
    const back = parkedUi[State.chatSlot];
    delete parkedUi[State.chatSlot];
    screen = back?.screen ?? emptyScreen();
    setInput(back?.text ?? "");
    shownSlot = State.chatSlot;
    // Rust lets a chat go once another is on screen: it gets this one back as it is.
    if (!runs.has(State.chatId) && State.chatHistory.length > 0) {
      State.chatHistory = State.chatHistory.map((m, i) => ({ ...m, turn: i }));
      void Bridge.chatRestore(State.chatId, State.chatHistory.map(conversationTurn), State.chatSession, compactOf(State.chatId));
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
    const turns = run.history.filter((m) => !m.failed).map((m) => ({ role: m.role, content: m.content, at: m.at, ...(m.kept ? { kept: m.kept } : {}) }));
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
  listenBtn.addEventListener("click", () => {
    if (body.classList.contains("hearing")) closeListening();
    else openListening();
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
    closeListening();
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
  /** The chat is being compacted: what the closed island says meanwhile. */
  let compactingLabel: string | null = null;
  let activeChatsKey = "";
  /** How long a finished chat stays on the home with "Done" before leaving the list (matches hooks.ts). */
  const CHAT_DONE_HOLD_MS = 5200;
  const finishedChats = new Map<string, { provider: string; model: string; title: string; timer: ReturnType<typeof setTimeout> }>();

  function clearFinishedChat(chatId: string) {
    const prev = finishedChats.get(chatId);
    if (!prev) return;
    clearTimeout(prev.timer);
    finishedChats.delete(chatId);
    drawIslandActivity();
  }

  function noteFinishedChat(run: Run) {
    clearFinishedChat(run.chatId);
    const title = chatTitle(run.history);
    const timer = setTimeout(() => {
      finishedChats.delete(run.chatId);
      drawIslandActivity();
    }, CHAT_DONE_HOLD_MS);
    (timer as { unref?: () => void }).unref?.();
    finishedChats.set(run.chatId, { provider: run.provider, model: run.model, title, timer });
  }

  function drawIslandActivity() {
    const liveRuns = [...runs.values()].filter((r) => !r.forgotten);
    const current = answering();
    const run = (current && !current.forgotten ? current : undefined) ?? liveRuns.at(-1);
    const next = run
      ? { ...runSpeaker(run), label: run.text === "" || run.dots ? timedLabel(islandActivityLabel(run.activity), run.provider, run.activity, run.since) : null }
      : compactingLabel != null ? { ...chatSpeaker(), label: compactingLabel } : null;
    const nextChats: ActiveChatRun[] = liveRuns.map((r) => {
      const { who, color } = runSpeaker(r);
      return {
        chatId: r.chatId,
        who,
        color,
        title: chatTitle(r.history) || t("Chat"),
        line: r.text === "" || r.dots ? runLabel(r) : t(COMPACT_TEXT.writing),
      };
    });
    if (compacting && compactingLabel != null && !nextChats.some((c) => c.chatId === State.chatId)) {
      const { who, color } = chatSpeaker();
      nextChats.push({
        chatId: State.chatId,
        who,
        color,
        title: chatTitle(State.chatHistory) || t("Chat"),
        line: compactingLabel,
      });
    }
    for (const [chatId, fin] of finishedChats) {
      if (nextChats.some((c) => c.chatId === chatId)) continue;
      const { who, color } = runSpeaker(fin);
      nextChats.push({
        chatId,
        who,
        color,
        title: fin.title || t("Chat"),
        line: t("Done"),
        done: true,
      });
    }
    const nextKey = nextChats.map((c) => `${c.chatId}\t${c.who}\t${c.color}\t${c.title}\t${c.line}\t${c.done ? 1 : 0}`).join("\n");
    const now = State.chatActivity;
    const sameActivity = next == null ? now == null : now != null && now.label === next.label && now.who === next.who && now.color === next.color;
    if (sameActivity && nextKey === activeChatsKey) return;
    activeChatsKey = nextKey;
    State.chatActivity = next;
    State.activeChats = nextChats;
    State.notify();
  }

  void onEvent<{ chat: string; text: string }>("chat-delta", ({ chat, text }) => {
    const run = runs.get(chat);
    if (!run || !text) return; // nothing visible yet: the dots stay
    const fresh = !run.text;
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
    noteChecklists(chat, run.history, text);
    writeAnswer(chat, live, text, fresh, messageScope(chat, nextMessage(run.history)));
    follow();
  });

  /**
   * The line next to the dots says what the answer is doing now. `again`:
   * Claude Code went back to its tools after some text, so the dots come
   * back under it.
   */
  function showActivity(run: Run, next: ChatActivity, again = false) {
    // The seconds start again only when the words do (reasoning is Thinking… too).
    if (activityLabel(next) !== activityLabel(run.activity)) run.since = activitySince(next);
    run.activity = next;
    if (again && run.text) run.dots = true;
    drawIslandActivity();
    tickSeconds();
    if (run.chatId !== State.chatId) return;
    const label = log.querySelector(".typing-label");
    if (label) label.textContent = runLabel(run);
    else if (again && live) log.append(typingDots(runLabel(run)));
    follow();
  }

  /** What the dots say for `run`, with its seconds. */
  function runLabel(run: Run): string {
    return timedLabel(activityLabel(run.activity), run.provider, run.activity, run.since);
  }

  /**
   * The seconds next to the dots move once a second while something timed is
   * on show (a local model reading the prompt, reasoning, asked again); the
   * timer stops as soon as nothing is.
   */
  let secondsTimer: ReturnType<typeof setInterval> | null = null;
  function tickSeconds() {
    const timed = () => [...runs.values()].some((r) => (!r.text || r.dots) && TIMED.has(r.activity.kind));
    if (secondsTimer != null || !timed()) return;
    secondsTimer = setInterval(() => {
      if (!timed()) {
        clearInterval(secondsTimer!);
        secondsTimer = null;
        return;
      }
      drawIslandActivity();
      const run = answering();
      const label = log.querySelector(".typing-label");
      if (run && label && (!run.text || run.dots)) label.textContent = runLabel(run);
    }, 1000);
    // Under Node (the tests), an answer left going doesn't keep the process alive.
    (secondsTimer as { unref?: () => void }).unref?.();
  }

  // A file the answer read, edited or created: the chat's files list it.
  void onEvent<ChatFileEvent>("chat-file", ({ chat, kind, path }) => {
    addChatFile(chat, kind, path, undefined, undefined, runs.get(chat)?.turn);
    // A copy changed or made in the chat's folder: listed under the answer.
    const run = runs.get(chat);
    // `made`: the model wrote it from nothing, so there is no original to put it back over.
    if (run && kind !== "read" && inWorkspace(path)) {
      const copies = (run.copies ??= new Map());
      copies.set(path, copies.get(path) ?? kind === "created");
    }
    if (chat === State.chatId) drawChatFiles();
  });

  void onEvent<{ chat: string; activity: ChatActivity }>("chat-activity", ({ chat, activity }) => {
    const run = runs.get(chat);
    if (!run || !activity) return;
    clearTimeout(run.timer);
    showActivity(run, activity, true);
  });

  /** The answers a queued question waits for (`sendAfter`). */
  const waitingFor = new Set<Run>();
  /** The question sent while its chat was answered, by chat: it waits above the field. */
  const queued = new Map<string, string>();
  let queueShown = "";

  /** The question leaves the field and waits above it; a second one joins it. */
  function enqueue(run: Run, text: string, typed: boolean) {
    const before = queued.get(run.chatId);
    queued.set(run.chatId, before ? `${before}\n${text}` : text);
    // A card's button leaves what is being typed in the field.
    if (typed) setInput("");
    Sound.play("blip");
    drawQueue();
    drawSend();
    sendAfter(run);
  }

  /** The queued question of the chat on screen, back in the field (before what is typed there now). */
  function unqueue() {
    const text = queued.get(State.chatId);
    if (text == null) return;
    queued.delete(State.chatId);
    const typed = input.value.trim();
    setInput(typed ? `${text}\n${typed}` : text);
    drawQueue();
    drawSend();
  }

  function drawQueue() {
    const shown = queued.get(State.chatId) ?? "";
    if (shown === queueShown) return;
    queueShown = shown;
    queueEl.hidden = !shown;
    queueText.textContent = shown;
    queueText.title = shown;
  }

  queueEdit.addEventListener("click", (e) => {
    e.stopPropagation();
    unqueue();
    Sound.play("blip");
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  queueText.addEventListener("click", () => queueEdit.click());
  queueCancel.addEventListener("click", (e) => {
    e.stopPropagation();
    queued.delete(State.chatId);
    drawQueue();
    Sound.play("pop");
    input.focus();
  });

  /**
   * The queued question goes as soon as `run` ends, if its chat is on screen
   * (otherwise once it is again). After Stop it comes back to the field.
   */
  function sendAfter(run: Run) {
    if (waitingFor.has(run)) return;
    waitingFor.add(run);
    void run.done.then(() => {
      waitingFor.delete(run);
      if (!queued.has(run.chatId)) return;
      if (!run.stopping) sendQueued();
      else if (State.chatId === run.chatId) unqueue();
      // Stopped while elsewhere: back in the field once the chat is on screen.
      else stoppedAway.add(run.chatId);
    });
  }
  /** Chats whose answer was stopped while they were not on screen: their queued question does not go by itself. */
  const stoppedAway = new Set<string>();

  /** The queued question of the chat on screen goes, once it is done answering. */
  function sendQueued() {
    const chatId = State.chatId;
    const text = queued.get(chatId);
    if (text == null || preparing || answering() || editing != null || stoppedAway.has(chatId)) return;
    for (const r of waitingFor) if (r.chatId === chatId) return;
    queued.delete(chatId);
    drawQueue();
    void submit(undefined, text);
  }

  /**
   * Sends what is typed, or `auto`: a message Lumo writes itself (a GitHub
   * event the chat listened for), which leaves the field, the files waiting
   * and the screen alone. `queuedText`: the question that waited above the
   * field, sent as if typed, leaving what is typed now where it is.
   */
  sendFromCard = (text) => {
    // Not while a question is edited: sending it drops what follows it.
    if (editing != null || preparing) return;
    // While an answer is written, it waits above the field like a question typed.
    const current = answering();
    if (current) enqueue(current, text, false);
    else void submit(text);
  };

  /**
   * `text`, which could not go into `chatId` (another chat came on screen),
   * waits above that chat's field and goes once it is back. A question that
   * waited already gives way to one queued since.
   */
  function waitAgain(chatId: string, text: string, wasQueued: boolean) {
    const before = queued.get(chatId);
    if (before != null && wasQueued) return;
    queued.set(chatId, before ? `${before}\n${text}` : text);
    drawQueue();
  }

  async function submit(auto?: string, queuedText?: string) {
    const query = auto ?? queuedText ?? input.value.trim();
    const typed = auto == null && queuedText == null;
    if (!query || preparing) return;
    // "/timer 10m pasta": a timer on the closed island, nothing sent to the AI.
    const timer = auto ? null : /^\/timer\s+(\S+)\s*(.*)$/i.exec(query);
    const timerMs = timer ? parseDuration(timer[1]) : null;
    if (timer && timerMs != null) {
      if (typed) setInput("");
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
      if (typed) setInput("");
      runLumo(own);
      return;
    }
    // A plan asking to start (concept C1): what is typed says what to change.
    // The plan is declined, so Claude keeps planning, and the text goes next.
    const asking = typed ? planAsking() : null;
    if (asking) decide("deny", asking.requestId);
    // The chat on screen is being answered: the next question waits above the
    // field and goes once it is done, but an edited one stops it and replaces it.
    const current = answering();
    if (current) {
      if (!auto && editing == null) enqueue(current, query, typed);
      if (auto || editing == null) return;
      const here = State.chatId;
      preparing = true;
      stop();
      await current.done;
      preparing = false;
      if (State.chatId !== here || editing == null || answering()) return;
    }
    // Nearly full: the chat is compacted first, the question waiting in the field.
    const full = editing == null ? autoCompactAt() : null;
    // The chat the question was asked in. Compacting, rewinding or reading
    // the screen first takes time, and another chat opened meanwhile must
    // not get the question.
    const askedIn = State.chatId;
    if (full != null) {
      preparing = true;
      try {
        await compactChat(full);
      } finally {
        preparing = false;
      }
      if (State.chatId !== askedIn) {
        // A question that waited, or a message Lumo wrote itself (a watch
        // that fired), waits above that chat's field; what is typed stays there.
        if (!typed) waitAgain(askedIn, query, queuedText != null);
        return;
      }
    }
    if (picker.isOpen) picker.close();
    closeHistory();
    closeScreen();
    if (typed) setInput("");
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
      // Another chat came on screen meanwhile: the question goes back to the
      // field rather than into it.
      if (State.chatId !== askedIn) {
        if (typed && !input.value.trim()) setInput(query);
        // A question that waited above the field, or Lumo's own message,
        // waits there again.
        else if (!typed) waitAgain(askedIn, query, queuedText != null);
        return;
      }

      // The file goes with the first question asked after it was added, once.
      const file = auto ? null : State.droppedFile;
      context = file && !file.sent ? { kind: "file", name: file.name, path: file.path } : null;
      const more = auto ? [] : State.moreFiles;
      screenContext = auto ? null : screenPayload(shared, more);
      sent = [...(file && context ? [file] : []), ...more];

      // The chat it is asked in, whichever is on screen when its answer comes.
      const chatId = State.chatId;
      const history = State.chatHistory;
      // Its copies in the inbox now belong to the chat: they go when it is deleted.
      noteSentCopies(chatId, sent.map((f) => f.path));
      // Where the question goes in Rust's conversation: after every turn recorded.
      const turn = history.reduce((n, m) => (m.turn != null ? Math.max(n, m.turn + 1) : n), 0);
      question = { id: nextId++, role: "user", content: query, at: Date.now() };
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
        model: activeModel(State.settings),
        turn,
        text: "",
        activity,
        since: Date.now(),
        dots: false,
        stopping: false,
        done,
      };
      const started = run;
      if (activity !== THINKING) run.timer = setTimeout(() => showActivity(started, THINKING), FIRST_ACTIVITY_MS);
      clearFinishedChat(chatId);
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
      // What the user ticked in the chat's checklists goes with the question,
      // unseen. Not with a command the CLI runs (Claude Code's "/compact",
      // agy's "/usage"), which would take it as its own words: it goes with
      // the next question.
      const command = !called && asked.trim().startsWith("/");
      const ticked = auto || command ? null : checklistsToTell(run.chatId, run.history);
      const reply = await Bridge.chatSend(run.chatId, ticked?.text ? `${asked}\n\n${ticked.text}` : asked, context, screenContext);
      // Stopped before anything was written: the question stays, unanswered,
      // and Rust kept nothing of it (the file goes with the next one).
      const recorded = !reply.stopped || reply.text !== "";
      if (recorded && ticked) checklistsTold(run.chatId, ticked.told);
      if (recorded && reply.turns != null) question.turn = reply.turns - 2;
      const content = await lumoLines(run.chatId, reply.text);
      if (recorded) {
        for (const f of sent) addChatFile(run.chatId, "attached", f.path, f.name, Date.now(), question.turn ?? run.turn);
        run.history.push({
          id: nextId++,
          role: "assistant",
          content,
          at: Date.now(),
          stopped: reply.stopped || undefined,
          kept: reply.kept,
          turn: reply.turns != null ? reply.turns - 1 : undefined,
          copies: run.copies?.size ? [...run.copies].map(([path, made]) => ({ chat: run.chatId, path, made: made || undefined })) : undefined,
        });
        run.copies = undefined;
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
      if (!reply.stopped) noticeAway(COMPACT_TEXT.answered, runSpeaker(run));
    } catch (err) {
      giveBack(true);
      outcome = "error";
      noticeAway(COMPACT_TEXT.failed, runSpeaker(run));
      const problem = String(err).replace(/^Error:\s*/, "").trim() || t(COMPACT_TEXT.failed, { helper: runSpeaker(run).who });
      // Said in the chat, under the question, so it is still there when the
      // island opens again; the note says it too when the chat isn't on screen.
      run.history.push({ id: nextId++, role: "assistant", content: problem, failed: true, at: Date.now() });
      if (!(State.mode === "expanded" && State.view === "prompt")) {
        State.noteMessage = problem;
        State.view = "note";
      }
      Sound.play("error");
    } finally {
      clearTimeout(run.timer);
      runs.delete(run.chatId);
      if (outcome === "finished" && !run.forgotten) noteFinishedChat(run);
      // A local model the answer loaded: what it can do (reasoning, context) is known only now.
      const caps = localCapsOf(run.provider);
      if (providerDef(run.provider).urlField && run.provider === State.settings.chatProvider && (!caps || caps.loadedContext === 0)) {
        picker.refreshCaps(true);
      }
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

  /**
   * What Lumo does for the lines an answer of `chatId` wrote for it, which go
   * from its text: a timer starts, and what it asked Lumo to listen for, on
   * GitHub or this PC, is listened to (or no longer). A line Lumo could not
   * read or start is said at the end.
   */
  async function lumoLines(chatId: string, text: string): Promise<string> {
    // A timer the answer asked for starts now; its line is not shown.
    const timed = takeTimers(text);
    for (const timer of timed.timers) compactTimer(timer.ms, timer.label);
    // What it asked Lumo to listen for, on GitHub or this PC, and to stop listening to.
    const answered = takeListens(timed.text);
    for (const stop of answered.stops) {
      if (stop.source === "github.pr") void Bridge.listenCancel(stop.repo, stop.number);
      else void Bridge.listenCancelLocal(stop.source, stop.target);
    }
    // What it asked to listen for waits for the user's Listen, over the field.
    if (answered.listens.length) {
      listenAsks.set(chatId, [...(listenAsks.get(chatId) ?? []), ...answered.listens].slice(-MAX_LISTEN_ASKS));
      drawListenAsk();
    }
    // A line Lumo could not read is said, never just dropped.
    const unheard = answered.unread;
    return unheard.length
      ? `${answered.text}\n\n_${t(LISTEN_STRINGS.unread, { what: unheard.join(", ") })}_`.trim()
      : answered.text;
  }

  /** The watches the user said Listen to, for chat `chatId`: what can't start is said on the island. */
  async function startListens(chatId: string, asks: ListenAsk[]) {
    const addOne = (ask: ListenAsk) => ask.source === "github.pr"
      ? Bridge.listenAdd(ask.repo, ask.number, ask.until, ask.task, chatId, ask.mode)
      : Bridge.listenAddLocal(ask.source, ask.target, ask.until, ask.text, ask.task, chatId, ask.mode, ask.amount);
    const added = await Promise.all(asks.map(addOne));
    const named = (a: ListenAsk) => (a.source === "github.pr" ? `${a.repo}#${a.number} ${a.until}` : `${a.target} ${a.until}`);
    const unheard = asks.filter((_, i) => !added[i]).map(named);
    Sound.play(unheard.length ? "error" : "blip");
    if (unheard.length) compactNotice(t(LISTEN_STRINGS.unread, { what: unheard.join(", ") }), LISTEN_COLOR, 10_000);
  }

  // ── What Claude Code writes by itself ─────────────────────────────────────

  /**
   * Claude Code answered by itself between two questions (a command it left
   * running in the background ended, an agent it started reported): its
   * answer joins the chat's last one, as Rust's conversation has it (chat.rs
   * `add_own`), whether the chat is on screen, being answered or only in Past
   * chats, and the closed island says so. Not in a chat that left that session.
   */
  async function ownAnswer(chatId: string, text: string, session: string | null) {
    const content = await lumoLines(chatId, text);
    if (!content) return;
    const saved = loadChats().find((c) => c.id === chatId);
    const run = runs.get(chatId);
    const onScreen = chatId === State.chatId;
    const history = run?.history ?? (onScreen ? State.chatHistory : null);
    const known = run ? run.session : onScreen ? State.chatSession : saved?.session ?? null;
    if (session && known && known !== session) return;
    if (history) {
      if (!joinOwnAnswer(history, content)) return;
      const turns = history.filter((m) => !m.failed).map((m) => ({ role: m.role, content: m.content }));
      if (run) remember(run);
      else if (saved) saveChat({ ...saved, title: chatTitle(turns), updatedAt: Date.now(), turns });
      if (onScreen) renderedCount = -1;
    } else {
      if (!saved) return;
      const turns = saved.turns.map((turn) => ({ ...turn }));
      if (!joinOwnAnswer(turns, content)) return;
      saveChat({ ...saved, updatedAt: Date.now(), turns });
      if (body.classList.contains("browsing")) drawHistory();
    }
    Sound.play("finish");
    noticeAway(COMPACT_TEXT.answered, run ? runSpeaker(run) : chatSpeaker());
    State.notify();
  }

  void onEvent<{ chat: string; text: string; session: string | null }>("chat-own-answer", (own) => {
    if (own?.chat && own.text) void ownAnswer(own.chat, own.text, own.session ?? null);
  });

  // ── Listening to GitHub ───────────────────────────────────────────────────

  /** Events with something for Claude to do, waiting for the chat to be free. */
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
      // Only to be told, and its chat is gone: the island's notice was enough.
      else if (!fired.watch.task.trim()) return runHeard();
      else newChat();
    }
    void submit(listenMessage(fired));
  }

  void onEvent<ListenFired>("listen-fired", (fired) => {
    if (!fired) return;
    Sound.play(fired.met ? "finish" : "error");
    compactNotice(`${firedTitle(fired.watch)} · ${fired.summary}`, watchColor(fired.watch), 10_000);
    // What it heard joins the panel's history.
    if (body.classList.contains("hearing")) listening.opened();
    // With no task, the chat it was asked in still says what happened.
    if (!answersInChat(fired)) return;
    heard.push(fired);
    runHeard();
  });
  void onEvent<ListenWatch[]>("listen-changed", (list) => {
    State.listening = list ?? [];
    drawListening();
    State.notify();
  });
  void Bridge.listenList().then((list) => {
    if (!list) return;
    State.listening = list;
    drawListening();
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
      case "compact":
        void compactChat();
        break;
    }
  }

  /**
   * /compact with a provider called by its API: the chat's model sums up the
   * conversation, and from the next question on it is sent the summary in
   * place of the turns it sums up. What was said stays on screen.
   */
  let compacting = false;
  /** `auto`: compacted by itself before a question, with the context this full (%). */
  async function compactChat(auto?: number) {
    const chatId = State.chatId;
    if (compacting || answering() || (auto == null && preparing)) return;
    if (State.chatHistory.length === 0) {
      compactNotice(t(COMPACT_STRINGS.nothing), providerDef(State.settings.chatProvider).accent);
      return;
    }
    compacting = true;
    // Asked with /compact: nothing is sent, edited or retried until the
    // summary is in, or it would sum up a chat that has moved on (or replace
    // the turns just asked). By itself, before a question, submit holds it already.
    const own = auto == null;
    if (own) preparing = true;
    closeUsage();
    compactingLabel = auto == null ? t(COMPACT_STRINGS.working) : t(COMPACT_STRINGS.auto, { pct: auto });
    drawIslandActivity();
    const row = typingDots(compactingLabel);
    log.append(row);
    follow();
    onHeightChange();
    try {
      const done = await Bridge.chatCompact(chatId);
      if (done) {
        setCompact(chatId, { upto: done.upto, summary: done.summary });
        estimateContext(chatId, done.before, done.after);
      }
      const said = done ? (auto == null ? COMPACT_STRINGS.done : COMPACT_STRINGS.autoDone) : COMPACT_STRINGS.nothing;
      compactNotice(t(said), providerDef(State.settings.chatProvider).accent);
      Sound.play("blip");
    } catch (err) {
      State.noteMessage = String(err).replace(/^Error:\s*/, "");
      Sound.play("error");
    } finally {
      compacting = false;
      if (own) preparing = false;
      compactingLabel = null;
      drawIslandActivity();
      row.remove();
      State.notify();
      onHeightChange();
    }
  }

  /**
   * After a compaction the ring shows an estimate until the next answer says:
   * what the chat filled, less the history the summary replaced (about three
   * characters a token, as local_chat.rs counts).
   */
  function estimateContext(chatId: string, before: number, after: number) {
    const seen = seenContext.get(chatId);
    const c = seen?.context;
    if (!seen || !c || !(c.total > 0)) return;
    const used = Math.max(Math.round(after / 3), Math.round(c.used - (before - after) / 3));
    seenContext.set(chatId, { ...seen, context: { ...c, used, estimate: true }, at: Date.now() });
  }

  /**
   * A local model's chat over 80 % full, with "Compact by itself" on: how full
   * (%) when it should be compacted before the next question, else null.
   */
  function autoCompactAt(): number | null {
    if (State.settings.chatAutoCompact === false || !providerDef(State.settings.chatProvider).urlField) return null;
    const c = seenContext.get(State.chatId)?.context;
    if (!c || c.estimate || !(c.total > 0) || State.chatHistory.length === 0) return null;
    const pct = Math.round((c.used / c.total) * 100);
    return pct >= AUTO_COMPACT_PCT ? pct : null;
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

  input.addEventListener("input", () => drawSend());
  send.addEventListener("click", () => {
    if (answering() && editing == null && !input.value.trim()) stop();
    else void submit();
  });
  // The field stays open while an answer is written: the next question can be
  // typed, and Enter queues it above the field until the answer is done.
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
      // Only this chat's own plan, as a chip while it is open, as the icon
      // once put away; another chat's or a terminal's plan is not this chat's
      // (they show on the home).
      const ownPlan = !workshop ? State.plans.find((p) => p.key === planKey("chat", String(State.chatId ?? ""))) ?? null : null;
      drawPlanAsk();
      drawListenAsk();
      planStrip.sync(State.planOpen ? ownPlan : null);
      const planIconShown = ownPlan != null && planStrip.chip.hidden;
      // The home asked for a chat (its plan's row): that one comes on screen.
      if (State.chatToOpen != null) {
        const id = State.chatToOpen;
        State.chatToOpen = null;
        if (id !== State.chatId) {
          const saved = loadChats().find((c) => c.id === id);
          const inFlight = !saved ? runs.get(id) : undefined;
          const target = saved ?? (inFlight ? {
            id,
            title: chatTitle(inFlight.history),
            updatedAt: Date.now(),
            provider: inFlight.provider,
            session: inFlight.session,
            turns: [],
          } : undefined);
          if (target) queueMicrotask(() => openChat(target));
        }
      }
      if (planIconShown && planBtn.style.display === "none") {
        // It just landed: a little pop.
        planBtn.classList.remove("pop");
        void planBtn.offsetWidth;
        planBtn.classList.add("pop");
      }
      planBtn.style.display = planIconShown ? "" : "none";
      planBtn.classList.toggle("open", State.planOpen);
      // Another chat came on screen (here, or a new chat from the menu or a
      // shortcut): the log is drawn again, with its answer if one is coming.
      if (State.chatId !== shownChat) {
        shownChat = State.chatId;
        live = null;
        dropInk();
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
      // The waves and the Listening panel follow the watches and the chat on screen.
      const heardKey = `${State.chatId}\n${JSON.stringify(State.listening)}`;
      if (heardKey !== listenKey) {
        listenKey = heardKey;
        drawListening();
      }
      const editKey = editing != null ? String(editing) : uploaded ? `uploaded\t${uploaded.name}\t${uploaded.until}` : "";
      if (chipRow.dataset.label !== editKey) {
        chipRow.dataset.label = editKey;
        clear(chipRow);
        if (editing != null) chipRow.append(noteChip(t(STRINGS.editing), t(STRINGS.editingHint), cancelEdit));
        else if (uploaded) chipRow.append(uploadedChip(uploaded.name));
      }

      // The queued question shows with its chat, and goes if it ended meanwhile.
      if (!run && stoppedAway.delete(State.chatId)) unqueue();
      drawQueue();
      if (!run) queueMicrotask(sendQueued);

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
        // Which checklists are lists written again further down, before any is drawn.
        noteChecklists(State.chatId, State.chatHistory, run?.text);
        let place = 0;
        sentTimes = [];
        // Retry is on the last question and its answer, once nothing is answered or edited.
        const history = State.chatHistory;
        const lastAsked = history.map((m) => m.role).lastIndexOf("user");
        const asked = lastAsked >= 0 && !run && editing == null ? history[lastAsked] : null;
        // No answer under the last question (it failed, or was stopped before a word): its actions stay in sight.
        const unanswered = asked != null && (lastAsked === history.length - 1 || !!history[lastAsked + 1]?.failed);
        history.forEach((m, i) => {
          // A message's scope is its place among those kept with the chat, as the checklists count them.
          const scope = messageScope(State.chatId, m.failed ? -1 : place++);
          const retries = asked != null && (i === lastAsked || (i === lastAsked + 1 && !m.failed));
          const last = i === history.length - 1 && m.role === "assistant" && !run;
          const shown = editing == null && (unanswered ? i === lastAsked : last);
          log.append(bubble(m, {
            onEdit: startEdit, onRetry: retries && asked ? () => retry(asked) : undefined, shown,
            editing: i === at, dropped: at >= 0 && i > at, workshop, scope,
          }));
        });
        // An answer just finished: the ink goes on in its bubble until all is uncovered.
        const last = State.chatHistory[State.chatHistory.length - 1];
        const inked = ink && !run && inkChat === State.chatId && ink.behind ? ink : null;
        const lastReply = log.lastElementChild?.querySelector<HTMLElement>(".reply");
        if (inked && last?.role === "assistant" && !last.failed && lastReply) {
          inked.update(last.content, true);
          const scope = messageScope(State.chatId, place - 1);
          inked.mount(lastReply, (el, words) => drawReply(el, words, workshop, scope, words.length < last.content.length));
        } else if (!run) dropInk();
        // The answer being written: its text so far, then the dots while it works.
        if (run?.text) {
          live = h("div", { class: "reply" });
          log.append(h("div", { class: "chat-row" }, live));
          writeAnswer(run.chatId, live, run.text, false, messageScope(State.chatId, place));
        }
        if (run && (!run.text || run.dots)) log.append(typingDots(runLabel(run)));
        // The chat stays where it was read, or at its end when it is stuck
        // there; one just opened shows its end.
        if (openedChat) stuck = true;
        if (!stuck) holdPlace();
        log.scrollTop = stuck ? log.scrollHeight : kept;
        openedChat = false;
        drawToEnd();
      } else refreshTimes();

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
        : planAsking() ? t(STRINGS.planChange)
        : t(State.chatHistory.length === 0 ? STRINGS.placeholderFirst : STRINGS.placeholderNext);
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
