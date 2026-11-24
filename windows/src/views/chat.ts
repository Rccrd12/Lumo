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
import { readPlace, putPlace, type ReadPlace } from "./read-place";
import { ICONS } from "./icons";
import { writeClipboard } from "./markdown";
import { forgetCardsFrom } from "./rich/index";
import { Ink, inkWorks } from "./ink";
import { agyContextWindow, drawNewUsage, lastContextReport } from "./usage-panel";
import { drawShareGrid, type ShareItem, type ShareKind, type ShareKindId } from "./share-panel";
import { invoke } from "@tauri-apps/api/core";
import { Bridge, isDialogOpen, onEvent, type AgentWebTabs, type BrowserTab, type ChatActivity, type ChatAgentEvent, type ChatSignalEvent, type ChatContext, type ChatFileEvent, type ExplorerFolder, type OpenWindow, type ScreenContext, type ScreenDisplay, type ScreenShot } from "../core/bridge";
import { activeModel, effortFor, hasPermissions, isApiProvider, isCliProvider, localCapsOf, usesLumoTools, parsePermissionMode, parseSandboxLevel, permissionModesFor, providerDef, storedPermissionMode, withPermissionMode, modelFor, onChatModel, withModel, type ProviderId, type ProviderDef } from "../core/providers";
import { Sound } from "../core/sound";
import { State, planAskInChat, type ActiveChatRun, type ChatMessage } from "../core/state";
import { chatModelOf, chatName, chatNamedBy, chatPermissionsOf, chatTitle, cleanRecap, compactOf, deleteChat, joinOwnAnswer, loadChats, NAME_CHARS, nameChat, namingExchanges, newChatId, permissionsFor, saveChat, searchChats, setChatPermissions, setChatModel, setCompact, type ChatHit, type SavedChat } from "../core/chats";
import { cliOf, setChatCli } from "../core/chats";
import { agentAsk, applyAgent, applyBrowserTabs, applyComputerTurns, applySignal, browserChats, browserOf, batchEntries, countAgents, durationText, forgetChat, isFinal, islandAgentsLine, looksOf, newAgentStore, noteSignal, openCount, permissionMatch, restoreAgents, rewindAgents, sealAgents, setIslandAgents, stallOf, talkWaits, waitingTalk, withAgents, type ComputerTurns, type AgentBatch, type ChatAgents, type PendingCard, type TalkEntry } from "../core/chat-agents";
import { agentsCard, agentsCardKey, fillAgentsCard, fillTalkBox, mainBrowser, stopLater, talkBox, type AgentsCardHost } from "./agents-card";
import { browserTabsChanged, openBrowserView, setBrowserViewHost } from "./browser-watch";
import { updateChatTurns, type AskQuote } from "../core/chats";
import type { AgentsPeek } from "../core/compact";
import { PICTURE_NAME, comingBack, joinScreen, leaveScreen, restored, sentAgain, sentItems, type SentItem } from "../core/sent";
import type { ChatPermissions } from "../core/chats";
import { messageScope, nextMessage } from "../core/checklists";
import { addChatFile, chatCopies, chatFiles, dropChatFiles, keptCopies, noteSentCopies, filesByKind, removeChatFile, rewindChatFiles, samePath, withdrawAttached, type ChatFile } from "../core/chat-files";
import { refreshAntigravityPlanUsage, refreshClaudePlanOnline } from "./usage";
import { OPENROUTER_STALE_MS, USAGE_TEXT, usageLine, type ChatUsage, type SeenUsage, type UsageLine } from "../core/chat-usage";
import { PREVIEW_STRINGS, SCREEN_STRINGS, withSelection, emptyScreen, filePreview, itemPreview, keepShots, afterSent, autoShare, folderPicks, foldersByThemselves, nextScreen, noImagesReason, screenItems, screenLabel, screenPayload, seesImages, short, screenWaits, shotPaths, tabPicks, tabsByThemselves, windowPicks, withFolders, withTabs, withWindows, withoutItem, type ExplorerPeek, type PickEntry, type PendingScreen, type PreviewBlock, type ScreenItem } from "../core/screen";
import { MAX_PASTE_BYTES, PASTE_STRINGS, pasteAction, pastedFiles, pastedName } from "../core/paste";
import { closePicture } from "./picture";
import type { ViewHost } from "./views";
import { N_, language, t, tl, tn } from "../i18n/i18n";
import { LIVE_STRINGS } from "../live/strings";
import { COMPACT_TEXT, compactNews, compactNotice, compactTimer, parseDuration, takeTimers } from "../core/compact";
import { LISTEN_COLOR, LISTEN_STRINGS, activeWatches, answersInChat, firedTitle, listenMessage, listeningLine, takeListens, untilText, watchColor, watchLabel, type ListenAsk, type ListenFired, type ListenWatch } from "../core/listen";
import { LISTENING_STRINGS, buildListeningPanel, listeningButtonTitle, neededText, watchTile } from "./listening";
import { addHeard, addPending, dropHeard, heardIn, heardLine, markAsked, markSent, placeHeard, seenChat, unsentOnOpen, waitingElsewhere, wavesLit, type HeardLine } from "../core/heard";
import { blocksOf, draftKey, draftOf, isWorkshopChat, latestDraft, type ToolDraft, type ToolInfo } from "../core/tools";
import { CONTEXT_STRINGS } from "../core/context-usage";
import { FORGE_STRINGS, buildForgePanel, linkSaved, savedLink } from "./forge";
import { buildPlanStrip } from "./plan-strip";
import { planAskSteps } from "./plan-ask";
import { planKey } from "../core/agent-plan";
import { SLASH_STRINGS, lumoCommand, slashCommands, slashMatches, slashQuery, toolAsk, toolCommand, type SlashAction, type SlashCommand } from "../core/slash";
import { AGY, CHAT_FILE_KINDS, COMPUTER_ICON, PICTURE_FILE, attachGroup, attachRow, chatFileRow, fileDetail, saveSettings } from "./chat-attach";
import { splitFix } from "./chat-fix";
import { cliModelName } from "../core/model-names";
import { FIRST_ACTIVITY_MS, MODEL_CHECK_WAIT_MS, PEEK_EVERY_MS, PLAN_ASK_GUARD_MS, TABS_WAIT_MS, THINKING, TIMED, WARNING_COLOR, activityLabel, activitySince, bubble, chatSpeaker, checklistsToTell, checklistsTold, conversationTurn, drawAnswer, drawReply, failedParts, firstActivity, inWorkspace, islandActivityLabel, messageOf, newMessageId, noteChecklists, noteChip, noticeAway, refreshTimes, runSpeaker, savedTurns, sendFromCard, sentAgo, sentBadges, sentTimes, setSendFromCard, setSentTimes, settle, smallPicture, timedLabel, typingDots, uploadedChip, type Run } from "./chat-messages";
import { buildPicker, readyProviders } from "./chat-models";
import { AUTO_COMPACT_PCT, COMPACT_ICON, COMPACT_STRINGS, FILLED_ICONS, HOLD_TEXT, MAX_LISTEN_ASKS, RESTART_ON_EDIT, SANDBOX_TEXT, STRINGS, effortLabel, modeText, tc } from "./chat-strings";

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

// What the rest of Lumo and the tests ask of views/chat.ts, wherever it lives now.
export {
  SETTLE_MS, activityLabel, activitySince, chatSpeaker, conversationTurn, failedParts, firstActivity, inWorkspace, islandActivityLabel,
  plainQuestion, sentAgo, settle, timedLabel, warningWords,
} from "./chat-messages";
export { fileDetail } from "./chat-attach";

/** Within this of the end the log is at its end, and stuck to it. */
const STUCK_PX = 1;
/** Further up from the end than this share of the log's height, the arrow down shows. */
const TO_END_ARROW_SCREENS = 1;
/** The island opening: the chat gets its width back once the island has held its size this long. */
const PLACE_SETTLE_MS = 160;
/** And no later than this, however long the island takes to open. */
const PLACE_MAX_MS = 2000;

/** Where the chat was read, kept while its log is out of sight: whether it was at its end, or the place. */
interface KeptPlace {
  chatId: string;
  slot: typeof State.chatSlot;
  stuck: boolean;
  place: ReadPlace | null;
}

// ── View ──────────────────────────────────────────────────────────────────────

/** `openSettings`: the island's Settings view (the window where there is no island, as in tests). */
/**
 * What was written and attached in a chat and not sent yet, put aside while
 * another chat is on screen (views/chat.ts parkDraft): the field's text, the
 * files waiting, and what the screen button added. It comes back with its chat.
 */
interface ChatDraft {
  text: string;
  droppedFile: typeof State.droppedFile;
  moreFiles: typeof State.moreFiles;
  promptContext: typeof State.promptContext;
  screen: PendingScreen;
}

/** Each chat's draft, by chat id, while another chat is on screen. Lost when Lumo closes, as the field is. */
const drafts = new Map<string, ChatDraft>();

/** The copies waiting in the field, not sent yet, and in the drafts of the other chats: never deleted from under them. */
function fieldCopies(): string[] {
  const parked = [...drafts.values()].flatMap((d) => [d.droppedFile?.path ?? "", ...d.moreFiles.map((f) => f.path)]);
  return [State.droppedFile?.path ?? "", ...State.moreFiles.map((f) => f.path), ...parked].filter(Boolean);
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
  /** Settings on its Agents page, where a chat's CLI is set up (views/chat-fix.ts). */
  const openAgents = () => {
    try {
      window.localStorage.setItem("lumo.settings.page", "agents");
    } catch {
      // Settings open on the page they were on.
    }
    openSettings();
  };
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
    // The island closing or opening, or a panel leaving the log, moves the
    // log, not the user: where it is read and whether it follows its end stay
    // as they were, and the place goes back at once.
    if (readAt) {
      if (!wasOnScreen) return;
      if (readAt.place && !readAt.stuck) putPlace(log, readAt.place);
      else if (stuck) follow();
      return;
    }
    stuck = fromEnd() <= STUCK_PX;
    drawToEnd();
  }, { passive: true });
  // Show more opens a question downwards, from where it is read: the log lets
  // go of its end, so it is not carried to the question's last line.
  log.addEventListener("click", (e) => {
    if ((e.target as Element | null)?.closest?.(".msg-fold")) stuck = false;
  }, true);
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
  // The island closing narrows the chat to its small size and opening widens
  // it back. Followed frame by frame, every line of the chat wrapped again at
  // each step of the island's spring: the text shook, the whole log was laid
  // out again at every frame (the opening stuttered), and the browser's scroll
  // anchoring could lose the place read. So as the chat leaves the screen its
  // log keeps the width it had (the island clips it while it is smaller), and
  // gets it back only once the island has held its size, open again. The
  // place read is kept too, and put back after each step of the opening, in
  // the same frame, before it is painted (its height still changes: the
  // spring going past its size near the end clamped the log, which then held
  // to its end), and once more when the width is let go, in case the island
  // came back at another width.
  let readAt: KeptPlace | null = null;
  /** The width the log keeps while the island closes, is closed and opens; 0 when it follows the island. */
  let heldWidth = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let openedAt = 0;
  const chatOnScreen = () => State.mode === "expanded" && State.view === "prompt";
  let wasOnScreen = chatOnScreen();
  /** Stops putting the place back (the user scrolled, another chat came): the width is still let go once the island holds its size. */
  function stopPlacing() {
    if (!readAt) return;
    readAt = null;
    drawToEnd();
  }
  function holdWidth() {
    if (heldWidth || log.clientWidth <= 0) return;
    heldWidth = log.getBoundingClientRect().width;
    log.style.width = `${heldWidth}px`;
  }
  function releaseWidth() {
    if (!heldWidth) return;
    heldWidth = 0;
    log.style.width = "";
  }
  /** After each step of the island opening: the place, then the width once it holds. */
  const settleWatch = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
    if (!wasOnScreen) return;
    if (readAt?.place && !readAt.stuck) putPlace(log, readAt.place);
    else if (stuck) follow();
    settleLater();
  });
  function settleLater() {
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimer = performance.now() - openedAt >= PLACE_MAX_MS ? undefined : setTimeout(settled, PLACE_SETTLE_MS);
    if (settleTimer === undefined) settled();
  }
  function settled() {
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimer = undefined;
    settleWatch?.disconnect();
    if (!wasOnScreen) return;
    releaseWidth();
    const at = readAt;
    if (at?.place && !at.stuck) putPlace(log, at.place);
    stopPlacing();
    if (stuck) follow();
  }
  function keepPlace() {
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimer = undefined;
    settleWatch?.disconnect();
    // Closed again while it was still opening: the place kept, and the width, stand.
    // Closed behind a panel: the place it had when the panel opened.
    if (!readAt) readAt = coveredAt ? { ...coveredAt } : { chatId: State.chatId, slot: State.chatSlot, stuck, place: stuck ? null : readPlace(log) };
    holdWidth();
  }
  function putBackPlace() {
    const at = readAt;
    // Another chat came on screen meanwhile: it opens at its end (openedChat).
    if (at && (at.chatId !== State.chatId || at.slot !== State.chatSlot)) stopPlacing();
    else if (at) stuck = at.stuck;
    openedAt = performance.now();
    if (!settleWatch || !log.parentElement) {
      settled();
      return;
    }
    settleWatch.observe(log);
    settleWatch.observe(log.parentElement);
    settleLater();
  }
  State.subscribe(() => {
    const onScreen = chatOnScreen();
    if (onScreen === wasOnScreen) return;
    wasOnScreen = onScreen;
    if (onScreen) putBackPlace();
    else keepPlace();
  });
  // A panel (the usage menu, the models, past chats, the files, Listening,
  // the screen, the permissions) takes the log's place: hidden, it is laid
  // out again when the panel goes, and the browser may then put it elsewhere
  // (a card it had not drawn yet takes its real height above the place read,
  // and the scroll that follows let go of the end). So the place read, or
  // being at the end, is kept as the panel opens and put back as it closes,
  // as for the island opening.
  let coveredAt: KeptPlace | null = null;
  const COVERING = ["picking", "browsing", "filing", "screening", "authorizing", "metering", "hearing"];
  const covered = () => COVERING.some((c) => body.classList.contains(c));
  /** Before a panel hides the log: where it is read. */
  function coverLog() {
    if (coveredAt || log.clientHeight <= 0) return;
    // Still being put back after the island opened: that place is the one read.
    coveredAt = readAt ? { ...readAt } : { chatId: State.chatId, slot: State.chatSlot, stuck, place: stuck ? null : readPlace(log) };
  }
  /** The panels all gone: the place back, frame by frame until the log holds its size. */
  function uncoverLog() {
    const at = coveredAt;
    if (!at || covered()) return;
    coveredAt = null;
    // The island closed meanwhile: put back as it opens.
    if (!wasOnScreen) {
      if (!readAt?.place) readAt = at;
      return;
    }
    readAt = at;
    putBackPlace();
  }
  // The user scrolling, or about to, takes over from it.
  for (const type of ["wheel", "pointerdown", "keydown", "touchstart"]) {
    log.addEventListener(type, () => {
      if (readAt && wasOnScreen) stopPlacing();
    }, { passive: true, capture: true });
  }
  toEnd.addEventListener("click", () => {
    stopPlacing();
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

  // Ask on an agent's row: that agent over the field, as a quote (WhatsApp's
  // Reply), until the question goes or × takes it away.
  const askWho = h("span", { class: "ask-who" });
  const askLine = h("span", { class: "ask-line" });
  const askClose = h("button", { class: "ask-close", title: tl(SCREEN_STRINGS.remove), "aria-label": tl(SCREEN_STRINGS.remove) }, svg(ICONS.xmark, 9));
  const askEl = h("div", { class: "chat-ask" }, h("i", { class: "ask-bar" }), h("div", { class: "ask-text" }, askWho, askLine), askClose);
  askEl.hidden = true;

  // A message that would start the chat's CLI again under its agents at
  // work: held above the field until the user says to wait for them or to
  // stop them (HOLD_TEXT, `holdForAgents`).
  const holdText = h("div", { class: "hold-text" });
  const holdSub = h("div", { class: "hold-sub" });
  const holdWait = h("button", { class: "agents-btn primary", text: tl(HOLD_TEXT.wait) });
  const holdNow = h("button", { class: "agents-btn stop", text: tl(HOLD_TEXT.now) });
  const holdCancel = h("button", { class: "agents-btn", text: tl(STRINGS.cancel) });
  const holdEl = h("div", { class: "chat-hold" },
    h("i", { class: "ask-bar" }),
    h("div", { class: "hold-body" }, holdText, holdSub, h("div", { class: "hold-acts" }, holdWait, holdNow, holdCancel)));
  holdEl.hidden = true;
  /**
   * By chat: a message that would have started its CLI again under the
   * agents it left at work. `waiting`: it goes once they finish; else it is
   * back in the field and the bar asks. `stuck`: sent once they seemed done
   * and held again, so it waits for news of an agent before it tries again.
   * `edit`: an edited question (its message's id), which would end them too;
   * `retry` when Retry sent it (its text never was in the field).
   */
  const held = new Map<string, { text: string; quote?: AskQuote; count: number; name: string; waiting: boolean; stuck?: boolean; edit?: number; retry?: boolean }>();
  let holdShown = "";
  /** The chats whose next edited question goes even under their agents at work: the user said so. */
  const editAnyway = new Set<string>();
  /** The chats whose answer the user stopped while agents of theirs worked on: their cards say those go on. */
  const answerStopped = new Set<string>();

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
  // Its badge: how many other chats heard something not seen yet (Past chats marks them).
  const historyBadge = h("span", { class: "history-badge" });
  const historyBtn = h("button", { class: "tool-btn history-btn", title: tl(STRINGS.pastChats) }, svg(ICONS.clock, 13, { stroke: 1.8 }), historyBadge);
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
      const label = watchLabel(w);
      // A path or a page shortened in its label is read whole before Listen.
      const whole = ask.source !== "github.pr" && ask.target && !label.includes(ask.target) ? ask.target : "";
      const every = ask.mode === "every";
      listenAskList.append(h("div", { class: "listen-ask-row", style: `--watch:${watchColor(w)}` },
        h("span", { class: "listen-ask-dot" }),
        h("span", { class: "listen-ask-text" },
          h("span", { class: "listen-ask-what" },
            h("span", { text: `${label} · ${untilText(w)}${w.text ? ` "${w.text}"` : ""}` }),
            every ? h("span", { class: "listen-pill every", text: t(LISTENING_STRINGS.every) }) : null),
          whole ? h("span", { class: "listen-ask-target", text: whole }) : null,
          ask.task ? h("span", { class: "listen-ask-then", text: t(STRINGS.listenThen, { task: ask.task }) }) : null,
          // What it will do comes without asking again: said before Listen.
          ask.task ? h("span", { class: "listen-ask-warn", text: t(every ? STRINGS.listenDoesEvery : STRINGS.listenDoesOnce, { helper: chatSpeaker().who }) }) : null)));
    }
    onHeightChange();
  }
  // What Lumo heard for another chat, not seen yet: over the field, until
  // that chat is opened or Close is pressed (concept: barra-apri-chiudi).
  const heardBarTile = h("span", { class: "heard-bar-tile" });
  const heardBarWhat = h("span", { class: "heard-bar-what" });
  const heardBarWhere = h("span", { class: "heard-bar-where" });
  const heardBar = h("div", { class: "heard-bar" },
    heardBarTile,
    h("span", { class: "heard-bar-text" }, heardBarWhat, heardBarWhere),
    h("span", { class: "heard-bar-btns" },
      h("button", { class: "listen-head-btn", type: "button", onclick: () => openHeard() }, h("span", { text: tl(STRINGS.heardOpen) })),
      h("button", { class: "listen-head-btn", type: "button", onclick: () => closeHeard() }, h("span", { text: tl(STRINGS.heardClose) }))));
  heardBar.hidden = true;
  let heardBarFor = "";
  /** The line the bar shows, while it shows one. */
  let heardBarLine: HeardLine | null = null;

  function drawHeardBar() {
    const waiting = State.chatSlot === "chat" ? waitingElsewhere(State.listenPending, State.chatId) : null;
    const key = waiting ? `${waiting.line.id}\t${waiting.more}` : "";
    if (key === heardBarFor) return;
    heardBarFor = key;
    heardBarLine = waiting?.line ?? null;
    heardBar.hidden = !waiting;
    if (waiting) {
      const { line, more } = waiting;
      heardBarTile.replaceChildren(watchTile(line.watch));
      heardBar.style.setProperty("--watch", line.color);
      heardBarWhat.textContent = `${line.title} · ${line.summary}`;
      const chat = line.chatTitle || t("Chat");
      const where = line.asked && line.watch.task.trim() ? t(STRINGS.heardDoing, { helper: chatSpeaker().who, chat }) : t(STRINGS.heardIn, { chat });
      heardBarWhere.textContent = more > 0 ? `${where} · +${more}` : where;
    }
    onHeightChange();
  }

  /** Open that chat: the one the bar names comes on screen (and is seen). */
  function openHeard() {
    const line = heardBarLine;
    if (!line) return;
    const saved = loadChats().find((c) => c.id === line.chatId);
    const inFlight = !saved ? runs.get(line.chatId) : undefined;
    // A new chat for a task (its chat was deleted) not started yet: the bar stays until it is.
    if (!saved && !inFlight && (loadingAway.has(line.chatId) || heard.some((x) => x.chatId === line.chatId))) {
      Sound.play("error");
      return;
    }
    seen(line.chatId);
    if (saved) openChat(saved);
    else if (inFlight) openChat({ id: line.chatId, title: chatName(line.chatId, inFlight.history), updatedAt: Date.now(), provider: inFlight.provider, model: inFlight.model, session: inFlight.session, turns: [] });
    State.notify();
  }

  /** Close: as if that chat had been opened, the bar and its light go. */
  function closeHeard() {
    const line = heardBarLine;
    if (!line) return;
    seen(line.chatId);
    Sound.play("pop");
    State.notify();
  }

  /** `chatId` was seen: what it heard no longer waits (the island, the waves, Past chats). */
  function seen(chatId: string) {
    const next = seenChat(State.listenPending, chatId);
    if (next === State.listenPending) return;
    State.listenPending = next;
    drawHeardBar();
    drawListening();
    drawHistoryBadge();
    if (body.classList.contains("browsing")) drawHistory();
  }

  // The ring sits right before the model it measures.
  const modelRow = h("div", { class: "model-row" },
    planStrip.el,
    h("div", { class: "chat-tools" }, newBtn, historyBtn, filesBtn, listenBtn),
    h("div", { class: "model-side" }, planBtn, planStrip.chip, usageEl, modelBtn));

  const body = h("div", { class: "chat-body" });
  const picker = buildPicker(() => {
    if (picker.isOpen) coverLog();
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
  }, openSettings, () => setChatModel(State.chatId, State.settings.chatProvider, activeModel(State.settings)));

  /** An open list gets the chat's full height; closing it gives the room back. */
  function panelChanged() {
    uncoverLog();
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
    openPills: () => {
      try {
        window.localStorage.setItem("lumo.settings.page", "pills");
      } catch {
        // Settings open on the page they were on.
      }
      closeListening();
      openSettings();
    },
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
  body.append(forge.head, chipRow, log, picker.el, historyEl, filesEl, listening.el, screenEl, permEl, usagePanel, slashEl, queueEl, holdEl, askEl, planAsk, listenAsk, heardBar, modelRow, bar, toEnd);

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

  // While a question is edited: what comes back with it, and what leaves the
  // context (drawEditStrip), just over the model's row.
  const editStrip = h("div", { class: "edit-strip" });
  editStrip.hidden = true;
  body.insertBefore(editStrip, modelRow);

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
  // A press in a picker of ours (Choose… for a folder, the paperclip) is no
  // press elsewhere: the panel that opened it waits for what is picked.
  void onEvent<null>("outside-press", () => {
    if (!isDialogOpen()) closeListsBut(null);
  });

  const cardEl = h("div", { class: "card wash chat-card" }, body, forge.el, forge.guide, forge.help);
  const el = h("div", { class: "view" }, cardEl);
  cardEl.style.setProperty("--wash", "rgba(99,102,241,0.5)");

  /** The answers being written, by chat id: the one on screen and any left in the background. */
  const runs = new Map<string, Run>();
  /** The answer of the chat on screen, while it is written. */
  const answering = (): Run | undefined => runs.get(State.chatId);
  /** The agents each chat's CLI started, and each chat's sign of life (core/chat-agents.ts). */
  const agentStore = newAgentStore();
  /** The Agents cards in the log now, by card (views/agents-card.ts agentsCardKey): drawn again alone. */
  const shownCards = new Map<string, { el: HTMLElement; batch: AgentBatch }>();
  /** The "Talking to …" boxes in the log now, by the call that sent the message. */
  const shownTalks = new Map<string, { el: HTMLElement; talk: TalkEntry }>();
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
   * `paused`: the answer went back to its tools after this text, which is
   * whole for now: its last word shows too (Ink.pause).
   */
  function writeAnswer(chat: string, into: HTMLElement, text: string, fresh: boolean, scope: string, paused = false) {
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
      if (paused) ink.pause();
      if (!fresh) ink.skip();
      ink.mount(into);
      return;
    }
    ink.update(text);
    if (paused) ink.pause();
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
    coverLog();
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
    // Antigravity CLI: its model's effort, said as Claude Code's is (`gemini-4-argon · High`).
    const variant = p.id === AGY ? picker.variantOf(model) : null;
    const effort = variant ? variant.level : effortFor(p.id, State.settings.chatEffort);
    // Claude Code's and agy's models by their names ("Opus 5.5"), not their ids.
    const id = variant ? variant.base : model;
    const name = activeModel(State.settings) ? cliModelName(p.id, id, picker.labelOf(p.id, id)) : id;
    modelName.textContent = effort ? `${name} · ${effortLabel(effort)}` : name;
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
    // Its agents in the background go on: their cards say so, and offer to stop them too.
    if (openCount(agentStore.get(run.chatId)) > 0) {
      answerStopped.add(run.chatId);
      drawAgents(run.chatId, false, false);
    }
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
    void bringBack(message);
  }

  function cancelEdit() {
    if (editing == null) return;
    editing = null;
    // The bar asking about the agents goes with the edit.
    if (held.get(State.chatId)?.edit != null && !held.get(State.chatId)?.waiting) {
      held.delete(State.chatId);
      drawHold();
    }
    takeBackAgain();
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
    void bringBack(message).then(() => {
      if (editing === message.id) void submit(undefined, message.content);
    });
  }

  /** Edit is putting back what went with the question: sending waits for it. */
  let bringing: Promise<void> | null = null;

  // ── What went with a question, again ──────────────────────────────────────
  //
  // Edit (and Retry) put back in the attachments what went with the question
  // (core/sent.ts), so it goes again with it; its × takes any of it out first.
  // Given up, the edit takes back out only what it put there.

  /** What the edit put back in the attachments, and what the file waiting was before it. */
  let editBack: {
    screen: PendingScreen;
    more: string[];
    dropped: { was: typeof State.droppedFile; sent: boolean | undefined; context: typeof State.promptContext; now: typeof State.droppedFile } | null;
  } | null = null;
  /** For the line over the field while editing: what comes back, and what leaves the context. */
  let editSent: { back: SentItem[]; lost: SentItem[] } | null = null;
  /** Screenshots that went with a question: the chat keeps them (chat copies), nothing here deletes them. */
  const keptShots = new Set<string>();

  /** The things that went with the questions after `at` in the chat on screen. */
  function sentAfter(at: number): SentItem[] {
    return State.chatHistory.slice(at + 1).flatMap((m) => (m.role === "user" ? m.sent ?? [] : []));
  }

  function bringBack(message: ChatMessage): Promise<void> {
    const done = putBack(message);
    bringing = done;
    void done.finally(() => {
      if (bringing === done) bringing = null;
    });
    return done;
  }

  async function putBack(message: ChatMessage) {
    const items = message.sent ?? [];
    const at = State.chatHistory.findIndex((m) => m.id === message.id);
    const later = at < 0 ? [] : sentAfter(at);
    editSent = items.length || later.length ? { back: [], lost: later } : null;
    if (!items.length) return;
    // A file or a screenshot deleted since can't go again.
    const paths = items.flatMap((i) => (i.path ? [i.path] : []));
    let present: boolean[] | null = null;
    if (paths.length) present = await Bridge.chatFilesPresent(paths).catch(() => null);
    if (editing !== message.id) return;
    const gone = new Set(paths.filter((_, i) => present?.[i] === false));
    const { back, lost } = comingBack(items, message.again, (path) => !gone.has(path));
    editSent = { back, lost: [...lost, ...later] };
    const again = restored(back, message.again);
    for (const shot of again.screen.shots) keptShots.add(shot.path);
    const dropped = State.droppedFile;
    const before = { was: dropped, sent: dropped?.sent, context: State.promptContext };
    const more: string[] = [];
    for (const f of again.files) {
      const waiting = State.droppedFile;
      if (waiting && samePath(waiting.path, f.path)) waiting.sent = false;
      else if (waiting && !waiting.sent) {
        if (!State.moreFiles.some((m) => samePath(m.path, f.path))) {
          State.moreFiles = [...State.moreFiles, { name: f.name, path: f.path }];
          more.push(f.path);
        }
      } else {
        State.droppedFile = { name: f.name, path: f.path };
        State.promptContext = { kind: "file", name: f.name, path: f.path };
      }
    }
    // Only what it adds: what was already waiting stays if the edit is given up.
    editBack = { screen: leaveScreen(again.screen, screen), more, dropped: State.droppedFile !== before.was || before.sent !== State.droppedFile?.sent ? { ...before, now: State.droppedFile } : null };
    screen = joinScreen(screen, again.screen);
    // A screenshot kept with the chat shows its small picture until its own is read.
    for (const shot of again.screen.shots) {
      void chatPicture(shot.path).then((src) => {
        if (!src || !screen.shots.some((x) => x.path === shot.path && x.preview !== src)) return;
        screen = { ...screen, shots: screen.shots.map((x) => (x.path === shot.path ? { ...x, preview: src } : x)) };
        State.notify();
      });
    }
    State.notify();
  }

  /** The edit was given up: what it put back in the attachments leaves them again. */
  function takeBackAgain() {
    const back = editBack;
    editBack = null;
    editSent = null;
    if (!back) return;
    screen = leaveScreen(screen, back.screen);
    if (back.more.length) State.moreFiles = State.moreFiles.filter((f) => !back.more.includes(f.path));
    const d = back.dropped;
    if (d && State.droppedFile === d.now) {
      if (d.was && d.was === d.now) d.was.sent = d.sent;
      else {
        State.droppedFile = d.was;
        if (d.was && d.sent !== undefined) d.was.sent = d.sent;
        State.promptContext = d.context;
      }
    }
  }

  /** A click in the list under a question: what it was, as it went. */
  async function openSent(message: ChatMessage, item: SentItem) {
    const again = message.again;
    if (again && item.kind !== "file" && item.kind !== "shot") {
      const blocks = itemPreview(again.screen, { kind: item.kind, key: item.key });
      if (blocks.length) {
        openPreview(blocks, null, true);
        return;
      }
    }
    const plain = (over: Partial<PreviewBlock>): PreviewBlock => ({ heading: item.label, detail: item.detail, note: "", text: "", image: "", ...over });
    if (item.kind === "selection" && item.text) {
      openPreview([plain({ detail: item.window ?? "", text: item.text })], null, true);
      return;
    }
    if (item.path && (item.kind === "shot" || PICTURE_NAME.test(item.label))) {
      const image = (await chatPicture(item.path)) ?? item.thumb ?? "";
      if (image) {
        openPreview(item.kind === "shot" ? [plain({ image })] : filePreview({ name: item.label, path: item.path }, image), null, true);
        return;
      }
    }
    if (item.kind === "file" && item.path) {
      const done = await Bridge.chatFileOpen(item.path).catch(() => "missing");
      if (done === "missing") {
        Sound.play("error");
        openPreview([plain({ detail: item.path, note: t(STRINGS.fileMissing) })], null, true);
      }
      return;
    }
    openPreview([plain({})], null, true);
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
    setChatCli(State.chatId, null);
    // The cards of the dropped messages (a quiz's answers) are not the next answer's.
    forgetCardsFrom(State.chatId, kept.filter((m) => !m.failed).length);
    // So are the agents the dropped answers started: the next answer's start a card of their own.
    rewindAgents(agentStore, State.chatId, kept.filter((m) => m.role === "assistant" && !m.failed).length);
    // An agent quoted over the field may have gone with them: the quote goes too.
    askFor.delete(State.chatId);
    drawAsk();
    renderedCount = -1;
    // The files of the dropped turns leave the chat's files, and Rust forgets them too.
    rewindChatFiles(State.chatId, keep);
    presenceAsked = "";
    drawChatFiles();
    if (State.chatId) chatRewound(State.chatId);
    await Bridge.chatRewind(State.chatId, keep);
  }

  /** The small pictures of the screenshots and picture files that went with a question, made once it went. */
  async function addThumbs(items: SentItem[], shots: readonly { path: string; preview: string }[]) {
    let changed = false;
    for (const item of items) {
      let src: string | null | undefined = null;
      if (item.kind === "shot") src = shots.find((x) => x.path === item.path)?.preview;
      else if (item.kind === "file" && item.path && PICTURE_NAME.test(item.label)) {
        src = filePicturesHere.get(item.path) ?? (await Bridge.filePreview(item.path).catch(() => null));
      }
      const small = src ? await smallPicture(src) : undefined;
      if (small) {
        item.thumb = small;
        changed = true;
      }
    }
    if (changed) {
      renderedCount = -1;
      State.notify();
    }
  }

  /** Over the field while a question is edited: what comes back with it, and what leaves the context. */
  function drawEditStrip() {
    const shown = editing != null ? editSent : null;
    const key = shown ? JSON.stringify([shown.back.map((i) => [i.kind, i.key, !!i.thumb]), shown.lost.map((i) => [i.kind, i.key, !!i.thumb])]) : "";
    if (editStrip.dataset.key === key) return;
    editStrip.dataset.key = key;
    clear(editStrip);
    editStrip.hidden = !shown || (!shown.back.length && !shown.lost.length);
    if (!shown) return;
    const line = (label: string, items: SentItem[], cls: string) =>
      h("div", { class: `edit-strip-line ${cls}` }, h("span", { class: "edit-strip-label", text: t(label) }), sentBadges(items, "sent-badges static"));
    if (shown.back.length) editStrip.append(line(STRINGS.comeBack, shown.back, "back"));
    if (shown.lost.length) editStrip.append(line(STRINGS.leaveContext, shown.lost, "lost"));
    if (shown.back.length) editStrip.append(h("div", { class: "edit-strip-hint", text: t(STRINGS.comeBackHint) }));
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
    const current = parsePermissionMode(storedPermissionMode(chatPermissions(), p.id), p.id);
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
        // The stored mode, not the one shown: one mode serves every provider
        // but Antigravity CLI, which keeps its own, and a CLI shows a local
        // model's "off" as "default". It is this chat's alone: another chat,
        // and a new one, keep theirs (Settings → Security's default for a new one).
        const own = chatPermissions();
        if (storedPermissionMode(own, p.id) !== mode) {
          const next = withPermissionMode(own, p.id, mode);
          setChatPermissions(State.chatId, next);
          void Bridge.chatPermissions(State.chatId, next);
          Sound.play("blip");
        }
        closePermissions();
        State.notify();
      });
      permList.append(row);
    }
  }

  /**
   * What chat `id` may do without asking, from its first question on: a chat
   * that never had the shield picked keeps the default it was asked with, so
   * a later change in Settings → Security goes for new chats only.
   */
  function keptPermissions(id: string): ChatPermissions {
    const own = chatPermissionsOf(id);
    if (own) return own;
    const now = permissionsFor(id, State.settings);
    setChatPermissions(id, now);
    return now;
  }

  /**
   * What the chat on screen may do without asking: what was picked in it,
   * else Settings → Security → Default permissions, which a new chat starts with.
   */
  function chatPermissions() {
    return permissionsFor(State.chatId, State.settings);
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
    const mode = parsePermissionMode(storedPermissionMode(chatPermissions(), State.settings.chatProvider), State.settings.chatProvider);
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
    coverLog();
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
    coverLog();
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

  /** A question that did not go: its files leave the chat's list (they go again with the next one). */
  function unsend(run: Run, sent: readonly { path: string }[]) {
    if (sent.length === 0) return;
    withdrawAttached(run.chatId, sent.map((f) => f.path), run.turn);
    if (State.chatId === run.chatId) drawChatFiles();
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
    coverLog();
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

  /** The waves: lit, with how many in this chat, while it listens or another chat waits; the panel redrawn. */
  function drawListening() {
    // Lit while something listens for the chat on screen, or another chat
    // heard something not seen yet; the count is this chat's.
    const here = State.chatSlot === "chat" ? State.chatId : "";
    const on = activeWatches(State.listening).filter((w) => w.chatId === here).length;
    listenBtn.classList.toggle("listening", wavesLit(State.listening, State.listenPending, here));
    listenBadge.textContent = on > 0 ? String(on) : "";
    // Under the mouse: what this chat waits for ("Waits for the merge #7"), else how many listen.
    const mine = listeningLine(State.listening.filter((w) => w.chatId === here));
    const title = mine ? `${t("Listening")} · ${mine}` : listeningButtonTitle(State.listening);
    listenBtn.title = title;
    listenBtn.setAttribute("aria-label", title);
    if (body.classList.contains("hearing")) listening.draw();
  }

  /** The clock's badge: the other chats that heard something not seen yet. */
  function drawHistoryBadge() {
    const others = State.chatSlot === "chat" ? State.listenPending.filter((p) => p.chatId !== State.chatId).length : 0;
    historyBadge.textContent = others > 0 ? String(others) : "";
  }

  // ── Screen button ─────────────────────────────────────────────────────────
  //
  // Opening the menu only asks which displays there are. A window list or a
  // screenshot is made when its entry is clicked, never before; a screenshot
  // is previewed and joins the chat only on Send. Cancel deletes it.

  /** Forgets the screenshots that were not sent, and deletes them. */
  function dropShots(paths: string[]) {
    // One that went with a question is the chat's: it goes with the chat.
    const gone = paths.filter((p) => !keptShots.has(p));
    if (gone.length > 0) void Bridge.screenDiscard(gone);
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
    coverLog();
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
  /** `toChat`: Close goes back to the chat (a question's list of what went with it), not to the attachments. */
  function openPreview(blocks: PreviewBlock[], onRemove: (() => void) | null, toChat = false) {
    if (picker.isOpen) picker.close();
    closeHistory();
    closeFiles();
    closePermissions();
    closeUsage();
    closeListening();
    if (body.classList.contains("screening")) closeScreen();
    screenTicket++;
    coverLog();
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
      if (!toChat) openFiles();
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

  /** The chat being renamed in Past chats (its pencil), and what is typed so far. */
  let renaming: { id: string; draft: string } | null = null;

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
        forgetChat(agentStore, c.id);
        askFor.delete(c.id);
        queuedAsk.delete(c.id);
        // What it heard goes with it, and no longer waits to be seen; a task
        // still waiting to go to it goes too, or it would bring the chat back.
        dropHeard(c.id);
        forgetHeard(c.id);
        seen(c.id);
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
        }
        // Its CLI, waiting for a message, ends, and the agents it still runs
        // with it (a run being stopped closes it as it ends).
        void Bridge.chatClose(c.id);
        drawIslandActivity();
        // The chat on screen is gone: so is it from the screen, and what was
        // written in it and not sent with it.
        if (c.id === State.chatId) {
          newChat();
          dropDraft(c.id);
          return;
        }
        dropDraft(c.id);
        Sound.play("pop");
        drawHistory();
      });
      if (c.id === renaming?.id) {
        historyList.append(renameRow(c));
        continue;
      }
      const rename = h("button", { class: "history-rename", title: tl(STRINGS.renameChat) }, svg(ICONS.pencil, 12, { stroke: 1.6 }));
      rename.addEventListener("click", (e) => {
        e.stopPropagation();
        renaming = { id: c.id, draft: c.title };
        drawHistory();
      });
      const name = h("span", { class: "picker-model-name", text: c.title || "…" });
      // It heard something not seen yet: what, in its colour, and the waves.
      const heard = State.chatSlot === "chat" ? State.listenPending.find((p) => p.chatId === c.id) : undefined;
      const heardText = heard && !snippet ? h("span", { class: "history-snippet history-heard-line", style: `color:${heard.color}`, text: `${heard.title} · ${heard.summary}` }) : null;
      const under = snippet ?? heardText;
      const row = h(
        "div",
        { class: c.id === State.chatId ? "picker-model history-row on" : "picker-model history-row", title: c.title },
        under ? h("span", { class: "history-text" }, name, under) : name,
        heard ? h("span", { class: "history-heard" }, svg(ICONS.waves, 13, { stroke: 1.8 })) : null,
        h("span", { class: "history-date", text: new Date(c.updatedAt).toLocaleDateString() }),
        rename,
        remove,
      );
      row.addEventListener("click", () => openChat(c));
      historyList.append(row);
    }
    if (renaming) {
      const field = historyList.querySelector<HTMLInputElement>(".history-rename-input");
      if (field && document.activeElement !== field) {
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      }
    }
  }

  /**
   * A past chat's row while it is renamed: its name in a field. Enter (or a
   * click away) keeps what is typed, and its AI never names it again; Esc,
   * or a name left empty, keeps the one it had.
   */
  function renameRow(c: SavedChat): HTMLElement {
    const field = h("input", {
      type: "text",
      class: "history-search history-rename-input",
      maxlength: String(NAME_CHARS),
      spellcheck: "false",
      "aria-label": tl(STRINGS.renameChat),
    }) as HTMLInputElement;
    field.value = renaming?.draft ?? c.title;
    let done = false;
    const finish = (keep: boolean) => {
      if (done) return;
      done = true;
      renaming = null;
      const name = field.value.trim();
      if (keep && name && name !== c.title && nameChat(c.id, name, "user")) {
        Sound.play("pop");
        drawIslandActivity();
        State.notify();
      }
      drawHistory();
    };
    field.addEventListener("input", () => {
      if (renaming?.id === c.id) renaming.draft = field.value;
    });
    field.addEventListener("click", (e) => e.stopPropagation());
    field.addEventListener("keydown", (e) => {
      const ke = e as KeyboardEvent;
      e.stopPropagation(); // Escape here cancels the name, not the island
      if (ke.key === "Enter" && !ke.isComposing) {
        e.preventDefault();
        finish(true);
      } else if (ke.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    });
    // A click elsewhere keeps the name; the field gone with a redraw does not.
    field.addEventListener("blur", () => {
      if (field.isConnected) finish(true);
    });
    return h("div", { class: "picker-model history-row history-renaming" },
      field,
      h("span", { class: "history-date", text: tl(STRINGS.renameKeys) }));
  }

  /** The chats being named by their AI now, and how often each was asked. */
  const naming = new Set<string>();
  const namingTries = new Map<string, number>();
  /** A name that doesn't come after this many asks: the chat keeps its own. */
  const NAMING_TRIES = 2;

  /**
   * Once an answer is in, the chat's own AI names the chat in a few words
   * (Settings → Chat → Chat names, chat_title.rs), with the provider's
   * lightest model or the chat's: unless it has a name already, from its AI
   * or from the user. A name that doesn't come is said nowhere: the chat
   * keeps the start of its first question.
   */
  function nameByAi(run: Run) {
    const chatId = run.chatId;
    if (State.settings.chatAiTitles === false || run.forgotten || naming.has(chatId) || chatNamedBy(chatId)) return;
    const tries = namingTries.get(chatId) ?? 0;
    if (tries >= NAMING_TRIES) return;
    const exchanges = namingExchanges(run.history);
    if (!exchanges) return;
    naming.add(chatId);
    namingTries.set(chatId, tries + 1);
    void Bridge.chatTitle(run.provider, run.model, exchanges, State.settings.chatTitleModel !== "chat")
      .then((title) => {
        // Renamed by the user meanwhile, or deleted: that stands.
        if (!title || run.forgotten || chatNamedBy(chatId)) return;
        if (!nameChat(chatId, title, "ai")) return;
        drawIslandActivity();
        if (body.classList.contains("browsing") && renaming == null) drawHistory();
        State.notify();
      })
      .finally(() => naming.delete(chatId));
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
    // What an edit put back in the attachments was this chat's.
    const wasEditing = editing != null;
    takeBackAgain();
    editing = null;
    // What was written and attached here waits for this chat to come back.
    parkDraft(wasEditing);
    const run = runs.get(c.id);
    if (run) {
      // Still being answered: it comes back as it is, its answer still coming.
      State.chatHistory = run.history;
      State.chatSession = run.session;
    } else {
      // Rust takes every turn back as it is (chat_restore): each one's place there is its place here.
      State.chatHistory = c.turns.map((turn, i) => messageOf(turn, i));
      State.chatSession = c.session;
      void Bridge.chatRestore(c.id, State.chatHistory.map(conversationTurn), c.session, compactOf(c.id), cliOf(c.id));
      // Its answers' agents come back under them, unless the island still holds them.
      restoreAgents(agentStore, c.id, c.turns, c.provider);
    }
    State.chatId = c.id;
    // The picker shows the provider and model this chat is on (as it was left);
    // a voice call's transcript has none, and leaves the picker as it is.
    useChatModel(chatModelOf(c.id) ?? (run ? { provider: run.provider, model: run.model } : null));
    void checkChatModel(c.id);
    if (picker.isOpen) picker.close();
    closeScreen();
    closePermissions();
    // What was written and attached in it before, as it was left.
    restoreDraft(c.id);
    closeHistory();
    Sound.play("blip");
    renderedCount = -1;
    State.notify();
    onHeightChange();
    input.focus();
  }

  /**
   * The chat on screen goes off screen: what its field and its attachments
   * hold waits for it in `drafts`, and the field is empty for the next one.
   * The text of an edit given up (`editing`) is not a draft: it goes. The
   * screenshots stay on disk with their draft (clearScreen deletes the others).
   */
  function parkDraft(editing: boolean) {
    const text = editing ? "" : input.value ?? "";
    const file = State.droppedFile && !State.droppedFile.sent ? State.droppedFile : null;
    const waiting = { ...screen, autoFolders: [], autoTabs: [] };
    const draft: ChatDraft = {
      text,
      droppedFile: file,
      moreFiles: State.moreFiles,
      promptContext: file || State.promptContext?.kind !== "file" ? State.promptContext : null,
      screen: waiting,
    };
    const holds = text.trim() !== "" || file != null || draft.moreFiles.length > 0 || draft.promptContext != null || screenWaits(waiting);
    if (holds) drafts.set(State.chatId, draft);
    else drafts.delete(State.chatId);
    setInput("");
    State.droppedFile = null;
    State.moreFiles = [];
    State.promptContext = null;
    screen = nextScreen(screen);
  }

  /** Chat `id` is on screen: its draft back in the field and the attachments, else an empty field. */
  function restoreDraft(id: string) {
    const draft = drafts.get(id);
    drafts.delete(id);
    if (!draft) return;
    setInput(draft.text);
    State.droppedFile = draft.droppedFile;
    State.moreFiles = draft.moreFiles;
    State.promptContext = draft.promptContext;
    // What rides along by itself is what it is now, not what it was then.
    screen = { ...draft.screen, autoFolders: screen.autoFolders ?? [], autoTabs: screen.autoTabs ?? [] };
  }

  /** A deleted chat's draft goes with it, its screenshots' files too. */
  function dropDraft(id: string) {
    const draft = drafts.get(id);
    if (!draft) return;
    drafts.delete(id);
    dropShots(shotPaths(draft.screen));
  }

  /** The picker on a chat's provider and model, saved as the ones to start the next new chat with. */
  function useChatModel(chat: { provider: string; model?: string } | null) {
    const next = onChatModel(State.settings, chat, readyProviders);
    if (next === State.settings) return;
    State.settings = next;
    saveSettings();
  }

  /** The model check of a chat still under way, by chat: its question waits for it. */
  const modelChecks = new Map<string, Promise<void>>();

  /**
   * Chat `id`'s model, checked against its provider's list: one no longer
   * offered (retired since the chat was on it) gives way to the one the
   * picker would pick, in the chat and, where it is the provider's model in
   * the settings, there too, so a new chat does not start on it either.
   */
  function checkChatModel(id: string): Promise<void> {
    const known = modelChecks.get(id);
    if (known) return known;
    const on = chatModelOf(id);
    if (!on?.model) return Promise.resolve();
    const { provider, model } = on;
    const check = picker.replacementFor(provider, model)
      .then((next) => {
        if (!next) return;
        // Picked again meanwhile: that pick stands.
        const now = chatModelOf(id);
        if (now?.provider === provider && now.model === model) setChatModel(id, provider, next);
        if (modelFor(State.settings, provider) === model) {
          State.settings = withModel(State.settings, provider as ProviderId, next);
          saveSettings();
          State.notify();
        }
      })
      // No list (offline, the key refused): the model stays, and says so itself if it fails.
      .catch(() => {})
      .finally(() => modelChecks.delete(id));
    modelChecks.set(id, check);
    return check;
  }

  /** The check of chat `id`'s model, waited for at most `MODEL_CHECK_WAIT_MS`. */
  function modelChecked(id: string): Promise<void> {
    const check = modelChecks.get(id) ?? checkChatModel(id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<void>((resolve) => (timer = setTimeout(resolve, MODEL_CHECK_WAIT_MS)));
    return Promise.race([check, late]).finally(() => clearTimeout(timer));
  }

  /**
   * A new chat; an answer still being written in the one before goes on in
   * the background. It starts empty, with the default permissions; what was
   * written and attached in the one before waits for it.
   */
  function newChat() {
    const wasEditing = editing != null;
    takeBackAgain();
    editing = null;
    parkDraft(wasEditing);
    State.startChat();
    closeScreen();
    closePermissions();
    restoreDraft(State.chatId);
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
    const going = runs.get(State.chatId);
    if (going) {
      // Still being answered: it comes back with that answer (as openChat).
      State.chatHistory = going.history;
      State.chatSession = going.session;
    } else if (State.chatHistory.length > 0) {
      State.chatHistory = State.chatHistory.map((m, i) => ({ ...m, turn: i }));
      void Bridge.chatRestore(State.chatId, State.chatHistory.map(conversationTurn), State.chatSession, compactOf(State.chatId), cliOf(State.chatId));
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
    State.chatHistory = turns.map((turn, i) => ({ id: newMessageId(), role: turn.role, content: turn.content, turn: i }));
    setChatCli(State.chatId, null);
    void Bridge.chatRestore(State.chatId, turns, null);
    const parsed = latestDraft(State.chatHistory);
    if (parsed) linkSaved(State.chatId, tool.id, draftKey(parsed));
    saveChat({ id: State.chatId, title: chatName(State.chatId, turns), updatedAt: Date.now(), provider: State.settings.chatProvider, model: activeModel(State.settings), session: null, turns });
    renderedCount = -1;
    State.notify();
  }

  /**
   * Saves a chat in the history when its question goes (so it can be found
   * again while it is answered) and after its answer, on screen or not.
   */
  function remember(run: Run) {
    if (run.forgotten) return;
    const turns = savedTurns(run.history);
    if (turns.length === 0) return;
    saveChat({
      id: run.chatId,
      title: chatName(run.chatId, turns),
      updatedAt: Date.now(),
      provider: run.provider,
      model: run.model,
      session: run.session,
      // Each answer with the agents it started that ended.
      turns: withAgents(agentStore.get(run.chatId), turns),
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
    coverLog();
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
  /** The agents' segments last given to the closed island. */
  let islandPeekKey = "";
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
    const title = chatName(run.chatId, run.history);
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
    // A chat whose answer is done while its agents still work: the one on screen first.
    const working: { chat: ActiveChatRun; island: { who: string; label: string }; peek: AgentsPeek }[] = [];
    // Past chats are read once, and only when a chat at work is in none of the open slots.
    let saved: SavedChat[] | null = null;
    const savedChats = () => (saved ??= loadChats());
    for (const [chatId, c] of agentStore) {
      if (runs.has(chatId)) continue;
      const one = agentsActivity(chatId, c, savedChats);
      if (one) working[chatId === State.chatId ? "unshift" : "push"](one);
    }
    const agentChats = working.map((w) => w.chat);
    const agentsLine = run || compactingLabel != null ? undefined : working[0];
    // The closed island draws its segments after the words (island/compact.ts).
    setIslandAgents(agentsLine?.peek ?? null);
    const next = run
      ? { ...runSpeaker(run), label: run.text === "" || run.dots ? timedLabel(islandActivityLabel(run.activity), run.provider, run.activity, run.since) : null }
      : compactingLabel != null ? { ...chatSpeaker(), label: compactingLabel }
      : agentsLine ? { who: agentsLine.island.who, color: agentsLine.chat.color, label: agentsLine.island.label } : null;
    const nextChats: ActiveChatRun[] = liveRuns.map((r) => {
      const { who, color } = runSpeaker(r);
      return {
        chatId: r.chatId,
        who,
        color,
        title: chatName(r.chatId, r.history) || t("Chat"),
        line: r.text === "" || r.dots ? runLabel(r) : t(COMPACT_TEXT.writing),
      };
    });
    if (compacting && compactingLabel != null && !nextChats.some((c) => c.chatId === State.chatId)) {
      const { who, color } = chatSpeaker();
      nextChats.push({
        chatId: State.chatId,
        who,
        color,
        title: chatName(State.chatId, State.chatHistory) || t("Chat"),
        line: compactingLabel,
      });
    }
    for (const working of agentChats) if (!nextChats.some((c) => c.chatId === working.chatId)) nextChats.push(working);
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
    const peekKey = agentsLine ? `${agentsLine.peek.looks.join(",")}:${agentsLine.peek.done}/${agentsLine.peek.total}` : "";
    if (sameActivity && nextKey === activeChatsKey && peekKey === islandPeekKey) return;
    islandPeekKey = peekKey;
    activeChatsKey = nextKey;
    State.chatActivity = next;
    State.activeChats = nextChats;
    State.notify();
  }

  void onEvent<{ chat: string; text: string }>("chat-delta", ({ chat, text }) => {
    const run = runs.get(chat);
    if (!run || !text) return; // nothing visible yet: the dots stay
    // Text that comes is a sign of life too.
    noteSignal(agentStore, chat);
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
      // Above the agents it already started, if any: they go under the answer.
      log.insertBefore(h("div", { class: "chat-row" }, live), liveCards(run));
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
    if (again && run.text) {
      run.dots = true;
      // The text stopped for the tools: its last word shows now, not when the answer ends.
      if (ink && inkChat === run.chatId) ink.pause();
    }
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
   * The seconds next to the dots, and on the closed island, move once a
   * second while something timed is on show (thinking, a local model reading
   * the prompt, asked again), from the moment the question goes: a CLI that
   * thinks without a word (agy) sends no activity to start them. The timer
   * stops as soon as nothing is timed, and while the island is hidden (0 %
   * CPU); it starts again when the island shows.
   */
  let secondsTimer: ReturnType<typeof setInterval> | null = null;
  const timed = () => State.mode !== "hidden" && [...runs.values()].some((r) => (!r.text || r.dots) && TIMED.has(r.activity.kind));
  function tickSeconds() {
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
  // The island shows again: the seconds go on from where they are, not from
  // the number left while it was hidden.
  State.subscribe(() => {
    if (secondsTimer != null || !timed()) return;
    tickSeconds();
    queueMicrotask(drawIslandActivity);
  });

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
    noteSignal(agentStore, chat);
    showActivity(run, activity, true);
    drawStall();
  });

  // ── The agents a CLI started, and the sign of life ────────────────────────
  //
  // Concept: concepts/sotto-agenti. The store (core/chat-agents.ts) keeps each
  // chat's agents and when its answer last moved; the chat on screen draws its
  // Agents cards (views/agents-card.ts) under the answers that started them,
  // and only those cards again when an agent changes. The closed island and
  // the home list a chat whose answer is done while its agents still work.

  /** The words for the chat's answer waiting or giving no sign, after the dots' line. */
  const STALL_TEXT = {
    noSignal: N_("no signal for {time}"),
    waiting: N_("waiting for your permission"),
  };

  /** Which answer of `chatId` a new batch of agents goes under: the one being written, else the last. */
  function anchorFor(chatId: string): number {
    const run = runs.get(chatId);
    const history = run?.history ?? (chatId === State.chatId ? State.chatHistory : null);
    const answers = history
      ? history.filter((m) => m.role === "assistant" && !m.failed).length
      : (loadChats().find((c) => c.id === chatId)?.turns.filter((x) => x.role === "assistant").length ?? 0);
    return run ? answers : Math.max(0, answers - 1);
  }

  /** The permission cards waiting for the user, from the island's own chat. */
  function chatCards(): PendingCard[] {
    return [State.pendingApproval, ...State.approvalQueue]
      .filter((a) => a?.fromChat)
      // The agent that asked, when the hook said (Claude Code's `agent_id`).
      .map((a) => ({ sessionId: a!.sessionId, agentId: a!.subagentId, fromChat: true }));
  }

  /** What the cards up wait on in `chatId`: its answer itself, or some of its agents. `chats`: Past chats, read once by the caller. */
  function permissionOf(chatId: string, chats: () => SavedChat[] = loadChats): { main: boolean; agents: Set<string> } {
    const cards = chatCards();
    if (!cards.length) return { main: false, agents: new Set() };
    const run = runs.get(chatId);
    const session = run ? run.session : chatId === State.chatId ? State.chatSession : chats().find((c) => c.id === chatId)?.session ?? null;
    // A card with no session is the chat on screen's only for a CLI before
    // its first answer: an API or a local model's chat has no session ever,
    // and Rust says itself when one of its cards is up (`waiting`).
    const onScreen = chatId === State.chatId && (!run || isCliProvider(run.provider));
    return permissionMatch(cards, session, onScreen, agentStore.get(chatId)?.rows.keys() ?? []);
  }

  /**
   * The chat's answer waits for the user: a card is up for it, or for one of
   * its agents the answer waits on (not one in the background), or Rust said so.
   */
  function turnWaiting(chatId: string): boolean {
    const c = agentStore.get(chatId);
    if (c?.waiting === "permission") return true;
    const permission = permissionOf(chatId);
    return permission.main || [...permission.agents].some((id) => c?.rows.get(id)?.row.background === false);
  }

  /**
   * The line next to the dots of the answer on screen says when it has given
   * no sign for too long for who answers and what it does, in amber, or that
   * it waits for the user's permission (concept 3). The dots and their words
   * stay as they are.
   */
  function drawStall() {
    drawMainBrowser();
    const label = log.querySelector(".typing-label");
    const row = label?.parentElement;
    if (!row) return;
    const run = answering();
    let text = "";
    let tone = "";
    if (run && turnWaiting(run.chatId)) {
      text = ` · ${t(STALL_TEXT.waiting)}`;
      tone = "waiting";
    } else if (run) {
      const lastSignalAt = Math.max(agentStore.get(run.chatId)?.lastSignalAt ?? 0, run.since);
      const stall = stallOf({ kind: "turn", provider: run.provider, activity: run.activity, lastSignalAt });
      if (stall) {
        text = ` · ${t(STALL_TEXT.noSignal, { time: durationText(stall.seconds * 1000) })}`;
        tone = "stalled";
      }
    }
    let span = row.querySelector(".typing-stall");
    if (!text) {
      span?.remove();
      return;
    }
    if (!span) {
      span = h("span", { class: "typing-stall" });
      row.append(span);
    }
    span.className = `typing-stall ${tone}`;
    if (span.textContent !== text) span.textContent = text;
  }

  /**
   * The conversation's own browser tab (browser.rs, agent "main") next to the
   * dots of the answer on screen: its site and Watch. An agent's tab is on its
   * row of the Agents card; the conversation has no row. Drawn again only
   * when the tab changes.
   */
  function drawMainBrowser() {
    const label = log.querySelector(".typing-label");
    const row = label?.parentElement;
    if (!label || !row) return;
    const run = answering();
    const tab = run ? browserOf(run.chatId, "main") : undefined;
    const key = run && tab ? `${run.chatId}|${tab.tab}|${tab.host}|${tab.title}` : "";
    const shown = row.querySelector<HTMLElement>(".typing-browser");
    if ((shown?.dataset.key ?? "") === key) return;
    shown?.remove();
    if (!run || !tab) return;
    const chatId = run.chatId;
    // Watch: the agents' browser, on the conversation's own tab.
    const next = mainBrowser(chatId, () => openBrowserView(chatId, "main"));
    if (!next) return;
    next.dataset.key = key;
    label.after(next);
  }

  /** Who the agents of `c` belong to ("Claude Code"), in its colour. */
  function agentsSpeaker(chatId: string, c: ChatAgents): { who: string; color: string } {
    let source = "";
    for (const e of c.rows.values()) if (e.row.source) source = e.row.source;
    const run = runs.get(chatId);
    if (!source) return run ? runSpeaker(run) : chatSpeaker();
    const p = providerDef(source);
    return { who: t(p.name), color: p.accent };
  }

  /** What one Agents card of the chat on screen needs from the chat. */
  function agentsHost(chatId: string): AgentsCardHost {
    return {
      label: activityLabel,
      // Stops that one agent alone; its CLI says how it ended (a `chat-agent` event).
      stop: (agentId) => {
        const row = agentStore.get(chatId)?.rows.get(agentId)?.row;
        // Ended by itself while its Stop waited for Undo: nothing to stop (its CLI would answer an error).
        if (row && isFinal(row.state)) return;
        // Its own provider's stopper: another provider may have answered the chat since.
        void invoke("chat_stop_agent", { chatId, agentId, source: row?.source ?? null }).catch((err) => {
          compactNotice(String(err).replace(/^Error:\s*/, ""), "#f4505e");
          void Bridge.log(`[agents] stop ${agentId}: ${String(err)}`);
        });
        Sound.play("pop");
      },
      // Resume: a message to the chat, only on that click; it waits if an answer is being written.
      // False when it could not go (a question being edited): the card keeps offering it.
      send: (text) => sendFromCard?.(text) ?? false,
      requestOnTop: requestOnTop(chatId),
      // The card the agent asks on comes to the front, if it is still the one on top.
      seeRequest: (agentId) => {
        const pending = State.pendingApproval;
        if (!pending?.fromChat || requestOnTop(chatId) !== agentId) return;
        State.view = State.requestView(pending);
        State.notify();
      },
      // Ask: the agent over the field, as a quote; what is typed then goes to it.
      ask: editing == null ? (quote) => askAgent(chatId, quote) : undefined,
      // Give it the turn: first in line for the computer.
      computerFirst: (agentId) => {
        void invoke("chat_computer_first", { chatId, agentId }).catch((err) => void Bridge.log(`[agents] computer first ${agentId}: ${String(err)}`));
        Sound.play("blip");
      },
      // Watch: a live picture of the agent's hidden browser tab under its row (views/browser-watch.ts).
      watchBrowser: true,
      changed: () => onHeightChange(),
    };
  }

  /**
   * The agent of `chatId` the permission card on top asks for (Claude Code's
   * `agent_id`); null when that card is not one of its agents' (the answer's
   * own, another chat's, or no card: Claude Code checking a call in auto mode).
   */
  function requestOnTop(chatId: string): string | null {
    const pending = State.pendingApproval;
    const id = pending?.fromChat ? pending.subagentId : undefined;
    return id && agentStore.get(chatId)?.rows.has(id) ? id : null;
  }

  /** Draws the chat on screen's Agents cards again, where they are; a new card draws the log again. */
  function drawAgents(chatId: string, onlyOpen = false, redraw = true) {
    if (chatId !== State.chatId) return;
    const c = agentStore.get(chatId);
    if (!c) return;
    const unseen = c.batches.some((b) => !shownCards.has(agentsCardKey(chatId, b))) || c.talks.some((x) => !shownTalks.has(x.call));
    if (redraw && unseen) {
      // The log is drawn again on its next sync; it syncs now only when it shows.
      renderedCount = -1;
      if (State.view === "prompt") State.notify();
      return;
    }
    const permission = permissionOf(chatId).agents;
    for (const { el, batch } of shownCards.values()) {
      // Each second, only the cards whose agents are still at work.
      if (onlyOpen && !batch.ids.some((id) => { const e = c.rows.get(id); return e && !isFinal(e.row.state); })) continue;
      fillAgentsCard(el, { chatId, chat: c, batch, permission, answerStopped: answerStopped.has(chatId) }, agentsHost(chatId));
    }
    const who = agentsSpeaker(chatId, c).who;
    for (const { el, talk } of shownTalks.values()) {
      // Each second, only those still waiting for their answer.
      if (onlyOpen && !talkWaits(talk)) continue;
      fillTalkBox(el, talk, who);
    }
  }

  /** The "Talking to …" boxes of the answer `answer`, or of those past the last when `after`. */
  function talkBoxesFor(chatId: string, answer: number, after = false): HTMLElement[] {
    const c = agentStore.get(chatId);
    if (!c?.talks.length) return [];
    const who = agentsSpeaker(chatId, c).who;
    return c.talks.filter((x) => (after ? x.anchor >= answer : x.anchor === answer)).map((talk) => {
      const el = talkBox(talk, who);
      shownTalks.set(talk.call, { el, talk });
      return el;
    });
  }

  /** The Agents cards of the answer `answer` (its place among the answers), or of those past the last when `after`. */
  function agentCardsFor(chatId: string, answer: number, after = false): HTMLElement[] {
    const c = agentStore.get(chatId);
    if (!c?.batches.length) return [];
    const permission = permissionOf(chatId).agents;
    const host = agentsHost(chatId);
    return c.batches.filter((b) => (after ? b.anchor >= answer : b.anchor === answer)).map((batch) => {
      const el = agentsCard({ chatId, chat: c, batch, permission, answerStopped: answerStopped.has(chatId) }, host);
      shownCards.set(agentsCardKey(chatId, batch), { el, batch });
      return el;
    });
  }

  /** The permission cards last drawn on the agents (`chatCards`), to notice when one comes or goes. */
  let pendingCardsKey = "";

  /** The first Agents card under the answer `run` is writing, in the log; null for none. */
  function liveCards(run: Run): HTMLElement | null {
    const answers = run.history.filter((m) => m.role === "assistant" && !m.failed).length;
    for (const { el, batch } of shownCards.values()) if (batch.anchor >= answers && el.parentElement === log) return el;
    return null;
  }

  /** The agents of `chatId` that ended are kept with the chat, under their answers. */
  function saveAgents(chatId: string) {
    const run = runs.get(chatId);
    if (run) remember(run);
    else updateChatTurns(chatId, (turns) => withAgents(agentStore.get(chatId), turns));
  }

  /**
   * What the closed island and the home say of a chat whose answer is done
   * while its agents still work (concept 5); null for none.
   */
  function agentsActivity(chatId: string, c: ChatAgents, chats: () => SavedChat[]): { chat: ActiveChatRun; island: { who: string; label: string }; peek: AgentsPeek } | null {
    if (openCount(c) === 0) return null;
    const now = Date.now();
    // The batches at work only, as their cards count: not the agents of earlier answers.
    const entries = c.batches.map((b) => batchEntries(c, b)).filter((es) => es.some((e) => !isFinal(e.row.state))).flat();
    const permission = permissionOf(chatId, chats).agents;
    const line = islandAgentsLine(entries, now, permission);
    if (!line) return null;
    const { who, color } = agentsSpeaker(chatId, c);
    const counts = countAgents(entries, now, permission);
    const title = chatNamed(chatId, chats) || t("Chat");
    return {
      // The home's list: who answers, the chat's title, and how far they are after the words.
      chat: { chatId, who, color: line.stalled ? "#f5a524" : color, title, line: line.stalled ? line.text : `${line.text} · ${counts.done}/${counts.total}` },
      // The closed island: the chat's name, then the words; "3/8" comes after the segments (island/compact.ts).
      island: { who: `«${title}»`, label: line.text },
      peek: { looks: looksOf(entries, now, permission), done: counts.done, total: counts.total, stalled: line.stalled },
    };
  }

  // The agents' browser view (views/browser-watch.ts): each agent's name, Ask and Stop, from here.
  setBrowserViewHost({
    title: (chatId, agentId) => agentStore.get(chatId)?.rows.get(agentId)?.row.title ?? "",
    ask: (chatId, agentId) => {
      const row = agentStore.get(chatId)?.rows.get(agentId)?.row;
      if (!row || chatId !== State.chatId || editing != null) return;
      State.view = "prompt";
      State.notify();
      askAgent(chatId, { agentId, title: row.title, line: row.now ? activityLabel(row.now) : "", look: "working" });
    },
    // As Stop on its row: back to the chat, where the row says it stops and
    // offers Undo. Another chat's agent (not on screen to undo) stops at once.
    stop: (chatId, agentId) => {
      if (chatId !== State.chatId) {
        agentsHost(chatId).stop(agentId);
        return;
      }
      State.view = "prompt";
      State.notify();
      stopLater(chatId, agentId, agentsHost(chatId), () => drawAgents(chatId));
    },
  });

  void onEvent<ChatAgentEvent>("chat-agent", (ev) => {
    if (!ev?.chat || !ev.agent) return;
    const before = agentStore.get(ev.chat)?.rows.get(ev.agent.id)?.row.state;
    if (!applyAgent(agentStore, ev, () => anchorFor(ev.chat))) return;
    drawAgents(ev.chat);
    drawIslandActivity();
    tickAgents();
    // An agent that just started, or just ended, is kept with the chat: one
    // at work as ended halfway, should Lumo close before it ends (savedAgents).
    if (before === undefined || (isFinal(ev.agent.state) && before !== ev.agent.state)) saveAgents(ev.chat);
    // A message held for the agents: their count, and it goes once they finish.
    const hold = held.get(ev.chat);
    if (hold?.stuck) hold.stuck = false;
    if (ev.chat === State.chatId) {
      drawHold();
      releaseHeld();
    }
  });

  // The line for the computer changed (computer_turns.rs): the rows of the chats in it say so.
  let computerChats = new Set<string>();
  void onEvent<ComputerTurns>("computer-turns", (ev) => {
    if (!applyComputerTurns(ev)) return;
    const chats = new Set([...(ev?.holder ? [ev.holder.chat] : []), ...(ev?.waiting ?? []).map((w) => w.chat)]);
    for (const chat of new Set([...chats, ...computerChats])) drawAgents(chat);
    computerChats = chats;
    drawIslandActivity();
    tickAgents();
  });

  // The agents' browser tabs changed (browser.rs): the rows of the chats that had or have one say so.
  let tabChats = new Set<string>();
  void onEvent<AgentWebTabs>("browser-tabs", (ev) => {
    if (!applyBrowserTabs(ev)) return;
    const chats = browserChats();
    for (const chat of new Set([...chats, ...tabChats])) drawAgents(chat);
    tabChats = chats;
    drawMainBrowser();
    browserTabsChanged();
  });

  void onEvent<ChatSignalEvent>("chat-signal", (ev) => {
    if (!ev?.chat) return;
    const waiting = agentStore.get(ev.chat)?.waiting ?? null;
    applySignal(agentStore, ev);
    if (ev.chat !== State.chatId) return;
    drawStall();
    // Waiting for the user starts or stops: the cards say so too.
    if ((agentStore.get(ev.chat)?.waiting ?? null) !== waiting) drawAgents(ev.chat);
    tickAgents();
  });

  /**
   * The times on the cards, the sign of life next to the dots and the closed
   * island's line move once a second while the chat on screen shows them,
   * every 5 s while only the closed island has agents at work to say, and
   * not at all otherwise (0 % CPU while nothing goes on).
   */
  let agentsTimer: ReturnType<typeof setInterval> | null = null;
  let agentsEvery = 0;
  function agentsPace(): number {
    // The island hidden: nothing to draw, nothing runs (0 % CPU).
    if (State.mode === "hidden") return 0;
    const shown = State.mode === "expanded" && State.view === "prompt";
    const c = agentStore.get(State.chatId);
    if (shown && (answering() || openCount(c) > 0 || waitingTalk(c))) return 1000;
    for (const c of agentStore.values()) if (openCount(c) > 0) return 5000;
    return 0;
  }
  function tickAgents() {
    const every = agentsPace();
    if (every === agentsEvery) return;
    if (agentsTimer != null) clearInterval(agentsTimer);
    agentsTimer = null;
    agentsEvery = every;
    if (!every) return;
    agentsTimer = setInterval(() => {
      drawAgents(State.chatId, true);
      drawStall();
      drawIslandActivity();
      tickAgents();
    }, every);
    // Under Node (the tests), agents left at work don't keep the process alive.
    (agentsTimer as { unref?: () => void }).unref?.();
  }
  // The island hides or shows again, the chat leaves the screen or comes back:
  // the pace follows (a pace unchanged costs nothing).
  State.subscribe(() => {
    tickAgents();
    // Another chat on screen: its own held message, if any; a chat back on screen sends one whose agents finished.
    drawHold();
    releaseHeld();
  });

  /** The answers a queued question waits for (`sendAfter`). */
  const waitingFor = new Set<Run>();
  /** The question sent while its chat was answered, by chat: it waits above the field. */
  const queued = new Map<string, string>();
  /** The agent a queued question is asked of (Ask), by chat. */
  const queuedAsk = new Map<string, AskQuote>();
  let queueShown = "";

  /**
   * The question leaves the field and waits above it; a second one joins it.
   * One asked of an agent never joins another, which would go to that agent
   * too, or to none: it stays in the field (false).
   */
  function enqueue(run: Run, text: string, typed: boolean): boolean {
    const before = queued.get(run.chatId);
    const quote = typed ? askFor.get(run.chatId) : undefined;
    if (before != null && (quote || queuedAsk.has(run.chatId))) {
      Sound.play("error");
      return false;
    }
    queued.set(run.chatId, before ? `${before}\n${text}` : text);
    if (quote) {
      queuedAsk.set(run.chatId, quote);
      askFor.delete(run.chatId);
      drawAsk();
    }
    // A card's button leaves what is being typed in the field.
    if (typed) setInput("");
    Sound.play("blip");
    drawQueue();
    drawSend();
    sendAfter(run);
    return true;
  }

  /** The queued question of the chat on screen, back in the field (before what is typed there now). */
  function unqueue() {
    const text = queued.get(State.chatId);
    if (text == null) return;
    queued.delete(State.chatId);
    const quote = queuedAsk.get(State.chatId);
    queuedAsk.delete(State.chatId);
    if (quote) {
      askFor.set(State.chatId, quote);
      drawAsk();
    }
    const typed = input.value.trim();
    setInput(typed ? `${text}\n${typed}` : text);
    drawQueue();
    drawSend();
  }

  function drawQueue() {
    const text = queued.get(State.chatId) ?? "";
    const quote = text ? queuedAsk.get(State.chatId) : undefined;
    // Asked of an agent: its name before the question.
    const shown = quote ? `${t(STRINGS.asking, { name: quote.title })} · ${text}` : text;
    if (shown === queueShown) return;
    queueShown = shown;
    queueEl.hidden = !shown;
    queueText.textContent = shown;
    queueText.title = shown;
  }

  /** The quote over the field, by chat: the agent Ask was clicked on. */
  const askFor = new Map<string, AskQuote>();
  let askShown: AskQuote | undefined;

  /** Ask on a row of `chatId`'s agents: the agent over the field; nothing is sent. */
  function askAgent(chatId: string, quote: AskQuote) {
    if (chatId !== State.chatId || editing != null) return;
    askFor.set(chatId, quote);
    drawAsk();
    Sound.play("blip");
    input.focus();
  }

  function drawAsk() {
    const quote = askFor.get(State.chatId);
    if (quote === askShown) return;
    askShown = quote;
    askEl.hidden = !quote;
    if (quote) {
      askEl.dataset.look = quote.look;
      askWho.textContent = t(STRINGS.asking, { name: quote.title });
      askLine.textContent = quote.line;
      askLine.title = quote.line;
    }
    // The field's words say who the question goes to (sync).
    State.notify();
    onHeightChange();
  }

  askClose.addEventListener("click", (e) => {
    e.stopPropagation();
    askFor.delete(State.chatId);
    drawAsk();
    Sound.play("pop");
    input.focus();
  });

  // ── A message held for the agents at work ─────────────────────────────────

  /** The number of agents a turn's error says it would have ended (chat_agents.rs WOULD_STOP), or null. */
  function agentsInTheWay(err: unknown): number | null {
    const m = /lumo-agents-would-stop:(\d+)/.exec(String(err));
    return m ? Number(m[1]) : null;
  }

  /**
   * The message `text` of `chatId` did not go: it would have ended `count`
   * agents at work. Typed, it goes back in the field (with its agent's quote)
   * and the bar asks; Lumo's own, or one that waited, waits for them.
   */
  function holdForAgents(chatId: string, text: string, quote: AskQuote | undefined, count: number, typed: boolean, name: string) {
    const before = held.get(chatId);
    if (typed && chatId === State.chatId) {
      const now = input.value.trim();
      setInput(now ? `${text}\n${now}` : text);
      if (quote) {
        askFor.set(chatId, quote);
        drawAsk();
      }
      held.set(chatId, { text: "", count, name, waiting: false });
    } else {
      held.set(chatId, { text, quote, count, name, waiting: true, stuck: before?.waiting === true || !typed });
    }
    Sound.play("pop");
    drawHold();
  }

  function drawHold() {
    const entry = held.get(State.chatId);
    const open = openCount(agentStore.get(State.chatId));
    const count = open || entry?.count || 0;
    const key = entry ? `${State.chatId}:${entry.waiting}:${count}:${entry.text}:${entry.edit ?? ""}` : "";
    if (key === holdShown) return;
    holdShown = key;
    holdEl.hidden = !entry;
    if (entry) {
      const edit = entry.edit != null;
      holdEl.classList.toggle("waiting", entry.waiting);
      if (entry.waiting) {
        holdText.textContent = edit
          ? tn("Your edit goes when the agent still working finishes.", HOLD_TEXT.editWaiting, count)
          : tn("Your message goes when the agent still working finishes.", HOLD_TEXT.waiting, count);
      } else {
        holdText.textContent = edit
          ? tn("Editing the question starts {name} again and stops the agent still working.", HOLD_TEXT.editStops, count, { name: entry.name })
          : tn("{name} starts again with the new settings and stops the agent still working.", HOLD_TEXT.stops, count, { name: entry.name });
      }
      holdSub.textContent = entry.waiting ? entry.text : t(edit ? HOLD_TEXT.editChoose : HOLD_TEXT.choose);
      holdSub.title = holdSub.textContent;
      holdWait.textContent = t(edit ? HOLD_TEXT.editWait : HOLD_TEXT.wait);
      holdNow.textContent = t(edit ? HOLD_TEXT.editNow : HOLD_TEXT.now);
      holdWait.hidden = entry.waiting;
    }
    onHeightChange();
  }

  /** The chat on screen's held message goes, once the agents it waited for finished. */
  function releaseHeld() {
    const chatId = State.chatId;
    const entry = held.get(chatId);
    if (!entry?.waiting || entry.stuck || preparing || editing != null || answering()) return;
    if (openCount(agentStore.get(chatId)) > 0) return;
    held.delete(chatId);
    drawHold();
    if (entry.edit != null) {
      // The question it edits may have gone meanwhile (a new chat, another edit): it goes as a new one.
      if (State.chatHistory.some((m) => m.id === entry.edit)) editing = entry.edit;
    }
    void submit(undefined, entry.text, undefined, entry.quote);
  }

  /** The agents at work an edited question of `chatId` would stop, and whose they are; null for none. */
  function agentsAnEditStops(chatId: string): { count: number; name: string } | null {
    const c = agentStore.get(chatId);
    if (!c) return null;
    const open = [...c.rows.values()].filter((e) => !isFinal(e.row.state) && RESTART_ON_EDIT.has(e.row.source));
    return open.length ? { count: open.length, name: t(providerDef(open[0].row.source as ProviderId).name) } : null;
  }

  /** The edited question (the message `edit`) waits: the bar asks to wait for the agents or to stop them. */
  function holdEdit(chatId: string, edit: number, text: string, count: number, name: string) {
    held.set(chatId, { text, count, name, waiting: false, edit, retry: !!text });
    Sound.play("pop");
    drawHold();
  }

  holdWait.addEventListener("click", (e) => {
    e.stopPropagation();
    const entry = held.get(State.chatId);
    if (entry?.edit != null) return waitToEdit(entry);
    const text = input.value.trim();
    if (!entry || !text) return;
    const quote = askFor.get(State.chatId);
    askFor.delete(State.chatId);
    drawAsk();
    setInput("");
    held.set(State.chatId, { ...entry, text, quote, waiting: true, stuck: false });
    Sound.play("blip");
    drawHold();
    releaseHeld();
  });

  /** Edit when they finish: the edited question waits above the field, the edit no longer in it. */
  function waitToEdit(entry: NonNullable<ReturnType<typeof held.get>>) {
    const text = entry.retry ? entry.text : input.value.trim();
    if (!text) return;
    if (!entry.retry) setInput("");
    // What the edit put back in the attachments stays there, for it.
    editing = null;
    editBack = null;
    editSent = null;
    renderedCount = -1;
    held.set(State.chatId, { ...entry, text, waiting: true, stuck: false });
    Sound.play("blip");
    drawHold();
    State.notify();
    releaseHeld();
  }

  holdNow.addEventListener("click", (e) => {
    e.stopPropagation();
    const chatId = State.chatId;
    const entry = held.get(chatId);
    if (!entry) return;
    held.delete(chatId);
    drawHold();
    if (entry.edit != null) {
      // The edit goes now: its CLI starts again, and its agents stop with the old one.
      editAnyway.add(chatId);
      if (!entry.waiting && !entry.retry) return void submit();
      if (State.chatHistory.some((m) => m.id === entry.edit)) editing = entry.edit;
      return void submit(undefined, entry.text);
    }
    // The next message may start the CLI again: its agents stop with the old one.
    void invoke("chat_allow_restart", { chatId }).then(() => {
      if (State.chatId !== chatId) return;
      if (entry.waiting) void submit(undefined, entry.text, undefined, entry.quote);
      else void submit();
    });
  });

  holdCancel.addEventListener("click", (e) => {
    e.stopPropagation();
    const entry = held.get(State.chatId);
    if (!entry) return;
    held.delete(State.chatId);
    if (entry.edit != null) {
      if (entry.waiting) {
        // The edit that waited is back in the field, an edit again.
        if (State.chatHistory.some((m) => m.id === entry.edit)) editing = entry.edit;
        const now = input.value.trim();
        setInput(now ? `${entry.text}\n${now}` : entry.text);
      } else if (entry.retry) {
        // Retry given up: what it put back in the attachments goes again.
        editing = null;
        takeBackAgain();
      }
      renderedCount = -1;
      Sound.play("pop");
      drawHold();
      State.notify();
      input.focus();
      return;
    }
    // A message that waited goes back in the field, its quote with it.
    if (entry.waiting && entry.text) {
      const now = input.value.trim();
      setInput(now ? `${entry.text}\n${now}` : entry.text);
      if (entry.quote) {
        askFor.set(State.chatId, entry.quote);
        drawAsk();
      }
    }
    Sound.play("pop");
    drawHold();
    input.focus();
  });

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
    queuedAsk.delete(State.chatId);
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
    const quote = queuedAsk.get(chatId);
    queuedAsk.delete(chatId);
    drawQueue();
    void submit(undefined, text, undefined, quote);
  }

  /**
   * Sends what is typed, or `auto`: a message Lumo writes itself (a GitHub
   * event the chat listened for), which leaves the field, the files waiting
   * and the screen alone. `queuedText`: the question that waited above the
   * field, sent as if typed, leaving what is typed now where it is.
   */
  setSendFromCard((text) => {
    // Not while a question is edited: sending it drops what follows it.
    if (editing != null || preparing) return false;
    // While an answer is written, it waits above the field like a question typed.
    const current = answering();
    if (current) return enqueue(current, text, false);
    void submit(text);
    return true;
  });

  /**
   * `text`, which could not go into `chatId` (another chat came on screen),
   * waits above that chat's field and goes once it is back. A question that
   * waited already gives way to one queued since.
   */
  function waitAgain(chatId: string, text: string, wasQueued: boolean, quote?: AskQuote) {
    const before = queued.get(chatId);
    if (before != null && wasQueued) return;
    queued.set(chatId, before ? `${before}\n${text}` : text);
    // Joined to another, it is asked of no agent: going to one, the other would too.
    if (before != null) queuedAsk.delete(chatId);
    else if (quote) queuedAsk.set(chatId, quote);
    drawQueue();
  }

  /**
   * `away`: Lumo's own message goes to that chat, not the one on screen
   * (submitAway): its conversation, already loaded in Rust.
   */
  async function submit(auto?: string, queuedText?: string, away?: { chatId: string; history: ChatMessage[]; session: string | null }, queuedQuote?: AskQuote) {
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
    // Asked of one agent (Ask, the quote over the field): the CLI passes it on.
    // Not a command the CLI runs ("/compact"), which the quote leaves waiting.
    const quote = auto || away || editing != null ? undefined : queuedText != null ? queuedQuote : askFor.get(State.chatId);
    const command = !called && query.trim().startsWith("/");
    const quoted = quote && !command ? quote : undefined;
    const asked = quoted ? agentAsk(quoted, called ? toolAsk(called.tool, called.rest) : query, State.settings.chatProvider) : called ? toolAsk(called.tool, called.rest) : query;
    // "/new", "/model"…: Lumo's own, run here like a pick in the menu.
    const own = auto || editing != null ? null : lumoCommand(query, State.settings.chatProvider);
    if (own) {
      closeSlash();
      if (typed) setInput("");
      runLumo(own);
      return;
    }
    // An edited question starts the chat's CLI again, and its agents still at
    // work stop with it: not without the user (concepts/sotto-agenti-completo 4).
    if (!auto && !away && editing != null) {
      const inTheWay = agentsAnEditStops(State.chatId);
      if (inTheWay && !editAnyway.delete(State.chatId)) {
        holdEdit(State.chatId, editing, typed ? "" : query, inTheWay.count, inTheWay.name);
        return;
      }
    }
    // A plan asking to start (concept C1): what is typed says what to change.
    // The plan is declined, so Claude keeps planning, and the text goes next.
    const asking = typed ? planAsking() : null;
    if (asking) decide("deny", asking.requestId);
    // The chat on screen is being answered: the next question waits above the
    // field and goes once it is done, but an edited one stops it and replaces it.
    const current = away ? runs.get(away.chatId) : answering();
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
    const full = editing == null && !away ? autoCompactAt() : null;
    // The chat the question was asked in. Compacting, rewinding or reading
    // the screen first takes time, and another chat opened meanwhile must
    // not get the question.
    const askedIn = away?.chatId ?? State.chatId;
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
        if (!typed) waitAgain(askedIn, query, queuedText != null, quoted);
        return;
      }
    }
    // Another chat's message leaves the one on screen as it is.
    if (!away) {
      if (picker.isOpen) picker.close();
      closeHistory();
      closeScreen();
      if (typed) setInput("");
      Sound.play("send");
    }

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
      // Edit just clicked: what went with the question is back in the attachments first.
      if (!auto && editing != null && bringing) await bringing;
      const edited = auto ? null : editing;
      if (!auto) {
        editing = null;
        // What the edit put back goes with it now.
        editBack = null;
        editSent = null;
      }
      if (edited != null) await rewindTo(edited);

      // What the screen button added goes once, then the chip goes.
      const waiting = screen;
      const shared = auto ? waiting : await withAuto(waiting);
      if (!auto && (shared.folders?.length ?? 0) > 0) await attachNamed(shared.folders ?? [], query);
      // A chat's model that may be retired is checked first: just opened, or not on screen.
      if (away || modelChecks.has(askedIn)) await modelChecked(askedIn);
      // Another chat came on screen meanwhile: the question goes back to the
      // field rather than into it.
      if (!away && State.chatId !== askedIn) {
        if (typed && !input.value.trim()) setInput(query);
        // A question that waited above the field, or Lumo's own message,
        // waits there again.
        else if (!typed) waitAgain(askedIn, query, queuedText != null, quoted);
        return;
      }

      // The file goes with the first question asked after it was added, once.
      const file = auto ? null : State.droppedFile;
      context = file && !file.sent ? { kind: "file", name: file.name, path: file.path } : null;
      const more = auto ? [] : State.moreFiles;
      screenContext = auto ? null : screenPayload(shared, more);
      sent = [...(file && context ? [file] : []), ...more];

      // The chat it is asked in, whichever is on screen when its answer comes.
      const chatId = askedIn;
      const history = away?.history ?? State.chatHistory;
      // Its copies in the inbox now belong to the chat, its screenshots too
      // (Edit sends them again): they go when it is deleted.
      const shots = screenContext ? shared.shots.map((x) => x.path) : [];
      for (const path of shots) keptShots.add(path);
      noteSentCopies(chatId, [...sent.map((f) => f.path), ...shots]);
      // Where the question goes in Rust's conversation: after every turn recorded.
      const turn = history.reduce((n, m) => (m.turn != null ? Math.max(n, m.turn + 1) : n), 0);
      question = { id: newMessageId(), role: "user", content: query, at: Date.now() };
      // A new question: the note that the last answer was stopped under its agents goes.
      answerStopped.delete(chatId);
      // Its answer's agents get a card of their own, even after an answer that failed.
      sealAgents(agentStore, chatId);
      // What went with it shows on its bubble, and goes again on Edit.
      const went = screenContext || sent.length ? sentItems(screenContext ? shared : emptyScreen(), sent, fileDetail) : [];
      if (went.length) {
        question.sent = went;
        question.again = sentAgain(screenContext ? shared : emptyScreen(), sent);
        void addThumbs(went, screenContext ? shared.shots : []);
      }
      // The bubble shows the quote and what was typed; Rust's conversation holds what went.
      if (quoted) {
        question.ask = quoted;
        question.kept = asked;
        if (askFor.get(chatId) === quoted) askFor.delete(chatId);
        drawAsk();
      }
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

      // A chat not on screen (a watch that fired in it) is answered by its own
      // provider and model; the one on screen by what the picker shows.
      const own = away ? onChatModel(State.settings, chatModelOf(chatId), readyProviders) : State.settings;
      const activity = firstActivity(own.chatProvider, context, screenContext);
      const done = new Promise<void>((resolve) => (finish = resolve));
      run = {
        chatId,
        history,
        session: away ? away.session : State.chatSession,
        provider: own.chatProvider,
        model: modelFor(own, own.chatProvider),
        permissions: keptPermissions(chatId),
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
      // The answer's sign of life is counted from now.
      noteSignal(agentStore, chatId);
    } finally {
      preparing = false;
    }
    // Found in Past chats while it is answered, to come back to it.
    remember(run);
    // What went with it is in the chat's files at once, not only once answered.
    if (sent.length) {
      for (const f of sent) addChatFile(run.chatId, "attached", f.path, f.name, Date.now(), run.turn);
      if (State.chatId === run.chatId) drawChatFiles();
    }
    State.stateOverride = "thinking";
    drawIslandActivity();
    // Thinking… counts its seconds from now, on the chat and the closed island.
    tickSeconds();
    drawModelButton();
    State.notify();
    onHeightChange();

    let outcome: "finished" | "error" | null = null;
    try {
      // What the user ticked in the chat's checklists goes with the question,
      // unseen. Not with a command the CLI runs (Claude Code's "/compact",
      // agy's "/usage"), which would take it as its own words: it goes with
      // the next question.
      const ticked = auto || command ? null : checklistsToTell(run.chatId, run.history);
      const reply = await Bridge.chatSend(run.chatId, ticked?.text ? `${asked}\n\n${ticked.text}` : asked, context, screenContext, { provider: run.provider, model: run.model }, run.permissions);
      // Stopped before anything was written: the question stays, unanswered,
      // and Rust kept nothing of it (the file goes with the next one). Unless
      // it used the computer meanwhile: Rust kept the turn ("(No answer.)",
      // reply.kept), and its recap says how far it went.
      const recap = cleanRecap(reply.computer);
      const recorded = !reply.stopped || reply.text !== "" || recap != null;
      if (recorded && ticked) checklistsTold(run.chatId, ticked.told);
      if (recorded && reply.turns != null) question.turn = reply.turns - 2;
      const content = await lumoLines(run.chatId, reply.text);
      // Nothing of it was kept: what went with it leaves the chat's files until it goes again.
      if (!recorded) unsend(run, sent);
      if (recorded) {
        for (const f of sent) addChatFile(run.chatId, "attached", f.path, f.name, Date.now(), question.turn ?? run.turn);
        run.history.push({
          id: newMessageId(),
          role: "assistant",
          content,
          at: Date.now(),
          stopped: reply.stopped || undefined,
          kept: reply.kept,
          warning: reply.warning,
          fix: reply.fix,
          turn: reply.turns != null ? reply.turns - 1 : undefined,
          copies: run.copies?.size ? [...run.copies].map(([path, made]) => ({ chat: run.chatId, path, made: made || undefined })) : undefined,
          // It used the computer: its plan as it ended, stopped or not, shown and saved under it.
          computer: recap,
        });
        run.copies = undefined;
      } else {
        giveBack(false);
      }
      if (reply.session) run.session = reply.session;
      // What each CLI session of the chat saw, for opening it again (chat.rs cli_state).
      if (!run.forgotten) setChatCli(run.chatId, reply.cli ?? null);
      if (State.chatId === run.chatId) {
        State.chatSession = run.session;
        void peekExplorer(true);
      }
      remember(run);
      if (recorded && !reply.stopped) nameByAi(run);
      askOpenRouter(true);
      // An answer from agy used some of its quota: asked again (at most once a minute).
      if (antigravityUsage()) refreshAntigravityPlanUsage();
      outcome = reply.stopped ? null : "finished";
      Sound.play(reply.stopped ? "pop" : "finish");
      // Ended with an error after the answer: the closed island says so, in amber.
      if (!reply.stopped) noticeAway(reply.warning ? COMPACT_TEXT.answeredWithProblem : COMPACT_TEXT.answered, reply.warning ? { ...runSpeaker(run), color: WARNING_COLOR } : runSpeaker(run));
    } catch (err) {
      giveBack(true);
      unsend(run, sent);
      // It would have ended the agents the chat's CLI left at work: the
      // question leaves the chat, and the bar above the field asks what to do.
      const inTheWay = agentsInTheWay(err);
      if (inTheWay != null) {
        const at = run.history.indexOf(question);
        if (at >= 0) run.history.splice(at, 1);
        remember(run);
        holdForAgents(run.chatId, query, quoted, inTheWay, typed && !away, runSpeaker(run).who);
        return;
      }
      outcome = "error";
      noticeAway(COMPACT_TEXT.failed, runSpeaker(run));
      // What puts it right, when Lumo can (signed out, not installed): a card in its place (views/chat-fix.ts).
      const [problem, fix] = splitFix(String(err).replace(/^Error:\s*/, "").trim() || t(COMPACT_TEXT.failed, { helper: runSpeaker(run).who }));
      const [plainProblem] = failedParts(problem);
      // Said in the chat, under the question, so it is still there when the
      // island opens again; the note says it too when the chat isn't on screen.
      run.history.push({ id: newMessageId(), role: "assistant", content: problem, failed: true, fix, at: Date.now() });
      if (!away && !(State.mode === "expanded" && State.view === "prompt")) {
        State.noteMessage = plainProblem;
        State.view = "note";
      }
      Sound.play("error");
    } finally {
      clearTimeout(run.timer);
      runs.delete(run.chatId);
      if (outcome === "finished" && !run.forgotten) noteFinishedChat(run);
      // Its chat was deleted meanwhile: its CLI, back to waiting, ends now.
      if (run.forgotten) void Bridge.chatClose(run.chatId);
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
    // Each one's outcome: started, or why not (`needs:…`, what to turn on first).
    const addOne = async (ask: ListenAsk): Promise<{ ok: boolean; error?: string }> => ask.source === "github.pr"
      ? { ok: !!(await Bridge.listenAdd(ask.repo, ask.number, ask.until, ask.task, chatId, ask.mode)) }
      : Bridge.listenTryLocal(ask.source, ask.target, ask.until, ask.text, ask.task, chatId, ask.mode, ask.amount)
        .then((got) => ({ ok: !!got.watch, error: got.error }));
    const added = await Promise.all(asks.map(addOne));
    const named = (a: ListenAsk) => (a.source === "github.pr" ? `${a.repo}#${a.number} ${a.until}` : `${a.target} ${a.until}`);
    const unheard = asks.filter((_, i) => !added[i].ok).map(named);
    Sound.play(unheard.length ? "error" : "blip");
    if (!unheard.length) return;
    // What to do about it, when Rust said: "Turn on the Email pill first."
    const needs = [...new Set(added.map((a) => (a.ok ? null : neededText(a.error))).filter((n): n is string => !!n))];
    const said = t(LISTEN_STRINGS.unread, { what: unheard.join(", ") });
    compactNotice(needs.length ? `${said} ${needs.join(" ")}` : said, LISTEN_COLOR, 10_000);
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
    // While the chat's agents work, what it writes (a result that came in)
    // is an answer like any other: it joins the chat's, with Markdown.
    const agents = agentStore.get(chatId);
    if (history) {
      if (!joinOwnAnswer(history, content)) return;
      const turns = savedTurns(history);
      if (run) remember(run);
      else if (saved) saveChat({ ...saved, title: chatName(saved.id, turns), updatedAt: Date.now(), turns: withAgents(agents, turns) });
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

  void onEvent<{ chat: string; text: string; session: string | null; cli?: string | null }>("chat-own-answer", (own) => {
    if (own?.chat && typeof own.cli === "string") setChatCli(own.chat, own.cli);
    if (own?.chat && own.text) void ownAnswer(own.chat, own.text, own.session ?? null);
  });

  // ── Listening to GitHub ───────────────────────────────────────────────────

  /**
   * Events with something for Claude to do, each with its chat and its line
   * (core/heard.ts, `queued` there until it goes), waiting for that chat to be free.
   */
  const heard: { text: string; chatId: string; lineId: string }[] = [];
  /** Chats whose conversation Rust is loading for such a message (submitAway). */
  const loadingAway = new Set<string>();
  /**
   * A deleted chat's watch: the chat its task was done in instead, so its next
   * events go there too rather than to a new chat each time (until Rust's
   * list says the watch moved, listen_move).
   */
  const movedChat = new Map<string, { id: string; title: string }>();
  // Tasks that still waited when Lumo closed never went: their lines say so, with Ask.
  unsentOnOpen();

  /** A chat was deleted: what still waited to go to it goes too. */
  function forgetHeard(chatId: string) {
    for (let i = heard.length - 1; i >= 0; i--) if (heard[i].chatId === chatId) heard.splice(i, 1);
  }

  /** A message of `heard` goes to its chat now: its line no longer waits. */
  function handOver(next: { chatId: string; lineId: string }) {
    markSent(next.chatId, next.lineId);
  }

  /**
   * The next one goes to Claude in the chat that asked for it, where that
   * chat is: on screen, or in the background, the chat on screen staying as
   * it is (concept: compito-senza-cambiare-chat).
   */
  function runHeard() {
    // Each chat's messages go in their order; a chat busy answering, loading,
    // or put aside by the other slot (its history comes back as it was left)
    // holds back only its own.
    const held = new Set<string>([State.parkedChatId() ?? ""]);
    for (let i = 0; i < heard.length && !preparing; ) {
      const next = heard[i];
      if (held.has(next.chatId) || runs.has(next.chatId) || loadingAway.has(next.chatId)) {
        held.add(next.chatId);
        i++;
        continue;
      }
      heard.splice(i, 1);
      held.add(next.chatId);
      if (next.chatId === State.chatId) {
        handOver(next);
        void submit(next.text);
      } else void submitAway(next);
    }
  }

  /**
   * Lumo's own message to a chat that is not on screen: its conversation is
   * loaded in Rust beside the one on screen (chat_load), and answered there
   * in the background, as a chat left while it is answered is. Opened
   * meanwhile, it goes there as on screen.
   */
  async function submitAway(next: { text: string; chatId: string; lineId: string }) {
    const { chatId, text } = next;
    const saved = loadChats().find((c) => c.id === chatId);
    // Rust takes every turn back as it is: each one's place there is its place here (as openChat).
    const history: ChatMessage[] = (saved?.turns ?? []).map((turn, i) => messageOf(turn, i));
    const session = saved?.session ?? null;
    if (saved) restoreAgents(agentStore, chatId, saved.turns, saved.provider);
    loadingAway.add(chatId);
    try {
      await Bridge.chatLoad(chatId, history.map(conversationTurn), session, compactOf(chatId), cliOf(chatId));
    } finally {
      loadingAway.delete(chatId);
    }
    // Deleted while it loaded: the message goes with it, rather than bring it back.
    if (saved && !loadChats().some((c) => c.id === chatId)) return;
    if (preparing || runs.has(chatId)) {
      // Something else went first: it waits for its turn again, before its
      // chat's next ones (an answer that ends calls for it; a moment later in any case).
      const at = heard.findIndex((h) => h.chatId === chatId);
      heard.splice(at < 0 ? heard.length : at, 0, next);
      window.setTimeout(() => runHeard(), 2000);
      return;
    }
    handOver(next);
    if (State.chatId === chatId) void submit(text);
    else void submit(text, undefined, { chatId, history, session });
  }

  /** The chat `chatId` is on screen, open: what it hears is seen at once. */
  function chatVisible(chatId: string): boolean {
    return State.mode === "expanded" && State.view === "prompt" && State.chatSlot === "chat" && State.chatId === chatId;
  }

  /** A chat's name, wherever it is: on screen, being answered, or in Past chats. */
  function chatNamed(chatId: string, chats: () => SavedChat[] = loadChats): string | null {
    // The chat on screen, even still empty (a watch started from the panel),
    // or the one the other slot put aside.
    if (chatId === State.chatId) return chatName(chatId, State.chatHistory);
    const parked = State.parkedChat();
    if (parked && chatId === parked.chatId) return chatName(chatId, parked.chatHistory);
    const run = runs.get(chatId);
    if (run) return chatName(chatId, run.history);
    const saved = chats().find((c) => c.id === chatId);
    return saved ? saved.title : null;
  }

  /**
   * What a watch heard: a line in the chat that asked (core/heard.ts), which
   * waits to be seen unless that chat is open; with a task, the message to
   * Claude in that chat too. "Only tell me" never wakes the AI.
   */
  function hear(fired: ListenFired) {
    const asks = answersInChat(fired);
    let chatId = fired.watch.chatId;
    let name = chatId ? chatNamed(chatId) : null;
    if (name == null) {
      // No chat asked, or it was deleted: with nothing to do, the closed
      // island says it for a while; with a task, a new chat does it.
      if (!asks) {
        compactNotice(`${firedTitle(fired.watch)} · ${fired.summary}`, watchColor(fired.watch), 10_000);
        return;
      }
      // That chat was deleted, and an earlier event of it made a new one,
      // still there (saved, answered, or waiting to be): it goes there too.
      const moved = chatId ? movedChat.get(chatId) : undefined;
      const there = moved && (chatNamed(moved.id) != null || runs.has(moved.id) || loadingAway.has(moved.id) || heard.some((x) => x.chatId === moved.id));
      if (moved && there) {
        chatId = moved.id;
        name = chatNamed(moved.id) ?? moved.title;
      } else {
        const gone = chatId;
        chatId = newChatId();
        name = chatTitle([{ role: "user", content: listenMessage(fired) }]);
        if (gone) movedChat.set(gone, { id: chatId, title: name });
        // Listening every time: its next events go to this new chat, not to another new one each.
        if (fired.ended === false) void Bridge.listenMove(fired.watch.id, chatId);
      }
    }
    const line = heardLine({ ...fired, watch: { ...fired.watch, chatId } }, name);
    // With a task, Claude is asked already: no Ask button. Until the message
    // goes, the line waits (`queued`): a task Lumo closed on before it went
    // says so when Lumo opens again, and Ask is back (core/heard.ts unsentOnOpen).
    if (asks) {
      line.asked = true;
      line.queued = true;
    }
    // Lines of chats not saved yet stay: on screen, being answered, waiting to be seen or to be answered.
    const kept = [...loadChats().map((c) => c.id), State.chatId, State.parkedChatId() ?? "", chatId, ...runs.keys(), ...loadingAway, ...heard.map((x) => x.chatId), ...State.listenPending.map((p) => p.chatId)];
    addHeard(line, new Set(kept));
    if (!chatVisible(chatId)) {
      State.listenPending = addPending(State.listenPending, line);
      // Hidden (auto-hide, or put away in the edge): the closed island comes
      // out to say it, as the note did before the line took its place.
      compactNews();
    }
    if (chatId === State.chatId) renderedCount = -1;
    drawHeardBar();
    drawListening();
    drawHistoryBadge();
    if (body.classList.contains("browsing")) drawHistory();
    if (asks) {
      heard.push({ text: listenMessage({ ...fired, watch: line.watch }), chatId, lineId: line.id });
      runHeard();
    }
    State.notify();
  }

  /**
   * A line Lumo heard, between the chat's messages (concept: riga-in-chat):
   * the source's tile, what happened and when; Ask {helper} while the AI was
   * not asked about it, Stop listening while its watch goes on.
   */
  function heardRow(line: HeardLine): HTMLElement {
    const when = h("span", { class: "heard-time", text: sentAgo(line.at), title: new Date(line.at).toLocaleString(language()) });
    sentTimes.push({ el: when, at: line.at });
    // Its watch, still on: the same id (never given twice, listen.rs) on the
    // same source. Not the same chat: a deleted chat's task lands in a new one.
    const watching = !line.ended && State.listening.some((w) => w.id === line.watch.id && (w.source ?? "github.pr") === (line.watch.source ?? "github.pr"));
    const ask = line.asked ? null : h("button", {
      class: "listen-head-btn", type: "button",
      onclick: () => {
        // What it heard goes to the AI as a message, as a task would have sent
        // it; the button goes once it went (not while a question is edited).
        if (!sendFromCard?.(listenMessage({ watch: line.watch, met: line.met, summary: line.summary, ended: line.ended }))) {
          Sound.play("error");
          return;
        }
        markAsked(line.chatId, line.id);
        renderedCount = -1;
        State.notify();
      },
    }, h("span", { text: t(STRINGS.heardAsk, { helper: chatSpeaker().who }) }));
    const stop = watching ? h("button", {
      class: "listen-head-btn", type: "button",
      onclick: () => {
        void Bridge.listenStop(line.watch.id);
        Sound.play("pop");
      },
    }, h("span", { text: t(LISTENING_STRINGS.stop) })) : null;
    // Its task never went (Lumo closed first): said under the line, in the Listening panel's warning.
    const unsent = line.unsent ? h("span", { class: "listen-warn heard-unsent" },
      h("span", { class: "listen-warn-text" }, h("span", { class: "listen-warn-dot" }), t(STRINGS.heardUnsent))) : null;
    return h("div", { class: "chat-row heard-row" },
      h("div", { class: line.met ? "heard-pill" : "heard-pill not-met", style: `--watch:${line.color}` },
        watchTile(line.watch),
        h("span", { class: "heard-text" },
          h("span", { class: "heard-title", text: `${line.title} · ` }),
          h("span", { class: "heard-summary", text: line.summary }),
          h("span", { class: "heard-dot", text: " · " }),
          when)),
      unsent,
      ask || stop ? h("div", { class: "heard-actions" }, ask, stop) : null);
  }

  void onEvent<ListenFired>("listen-fired", (fired) => {
    if (!fired) return;
    Sound.play(fired.met ? "finish" : "error");
    // What it heard joins the panel's history.
    if (body.classList.contains("hearing")) listening.opened();
    hear(fired);
  });
  void onEvent<ListenWatch[]>("listen-changed", (list) => {
    State.listening = list ?? [];
    // A line's Stop listening goes with its watch.
    if (State.chatSlot === "chat" && heardIn(State.chatId).some((l) => !l.ended)) renderedCount = -1;
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
            title: chatName(id, inFlight.history),
            updatedAt: Date.now(),
            provider: inFlight.provider,
            model: inFlight.model,
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
      if (editing != null && !State.chatHistory.some((m) => m.id === editing)) {
        editing = null;
        editBack = null;
        editSent = null;
      }
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
      // The chat on screen, open, is seen: what it heard no longer waits.
      if (chatVisible(State.chatId) && State.listenPending.some((p) => p.chatId === State.chatId)) {
        State.listenPending = seenChat(State.listenPending, State.chatId);
        // The closed island draws again without it.
        queueMicrotask(() => State.notify());
      }
      // The waves, the bar, the clock's badge and the Listening panel follow
      // the watches, what waits to be seen and the chat on screen.
      const heardKey = `${State.chatId}\n${State.chatSlot}\n${JSON.stringify(State.listening)}\n${State.listenPending.map((p) => p.id).join(",")}`;
      if (heardKey !== listenKey) {
        listenKey = heardKey;
        drawListening();
        drawHeardBar();
        drawHistoryBadge();
      }
      const editKey = editing != null ? String(editing) : uploaded ? `uploaded\t${uploaded.name}\t${uploaded.until}` : "";
      if (chipRow.dataset.label !== editKey) {
        chipRow.dataset.label = editKey;
        clear(chipRow);
        if (editing != null) chipRow.append(noteChip(t(STRINGS.editing), t(STRINGS.editingHint), cancelEdit));
        else if (uploaded) chipRow.append(uploadedChip(uploaded.name));
      }
      drawEditStrip();

      // The queued question shows with its chat, and goes if it ended meanwhile.
      if (!run && stoppedAway.delete(State.chatId)) unqueue();
      drawQueue();
      drawAsk();
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
        setSentTimes([]);
        // Retry is on the last question and its answer, once nothing is answered or edited.
        const history = State.chatHistory;
        const lastAsked = history.map((m) => m.role).lastIndexOf("user");
        const asked = lastAsked >= 0 && !run && editing == null ? history[lastAsked] : null;
        // No answer under the last question (it failed, or was stopped before a word): its actions stay in sight.
        const unanswered = asked != null && (lastAsked === history.length - 1 || !!history[lastAsked + 1]?.failed);
        // What Lumo heard for the chat, between its messages by time.
        const heardLines = placeHeard(history, workshop ? [] : heardIn(State.chatId));
        // The Agents cards go under the answers that started them (views/agents-card.ts).
        shownCards.clear();
        shownTalks.clear();
        const answers = history.filter((m) => m.role === "assistant" && !m.failed).length;
        let answer = 0;
        let lastBubble: HTMLElement | null = null;
        history.forEach((m, i) => {
          for (const line of heardLines.before[i]) log.append(heardRow(line));
          // A message's scope is its place among those kept with the chat, as the checklists count them.
          const scope = messageScope(State.chatId, m.failed ? -1 : place++);
          // A failed answer with a card to put it right has its own Retry (views/chat-fix.ts).
          const retries = asked != null && (i === lastAsked || (i === lastAsked + 1 && (!m.failed || !!m.fix)));
          const last = i === history.length - 1 && m.role === "assistant" && !run;
          const shown = editing == null && (unanswered ? i === lastAsked : last);
          lastBubble = bubble(m, {
            onEdit: startEdit, onRetry: retries && asked ? () => retry(asked) : undefined, shown,
            editing: i === at, dropped: at >= 0 && i > at, workshop, scope, onOpenSent: (msg, item) => void openSent(msg, item),
            onOpenAgents: openAgents,
          });
          // The messages the CLI sent its agents meanwhile, before its answer.
          if (m.role === "assistant" && !m.failed) log.append(...talkBoxesFor(State.chatId, answer));
          log.append(lastBubble);
          if (m.role === "assistant" && !m.failed) {
            log.append(...agentCardsFor(State.chatId, answer));
            answer++;
          }
        });
        // The agents of an answer that never came (stopped, failed) go after
        // its question, and its failed answer.
        if (!run) log.append(...talkBoxesFor(State.chatId, answers, true), ...agentCardsFor(State.chatId, answers, true));
        // An answer just finished: the ink goes on in its bubble until all is uncovered.
        const last = State.chatHistory[State.chatHistory.length - 1];
        const inked = ink && !run && inkChat === State.chatId && ink.behind ? ink : null;
        const lastReply = (lastBubble as HTMLElement | null)?.querySelector<HTMLElement>(".reply");
        if (inked && last?.role === "assistant" && !last.failed && lastReply) {
          inked.update(last.content, true);
          const scope = messageScope(State.chatId, place - 1);
          inked.mount(lastReply, (el, words) => drawReply(el, words, workshop, scope, words.length < last.content.length));
        } else if (!run) dropInk();
        for (const line of heardLines.after) log.append(heardRow(line));
        // The messages sent to agents by the answer being written, before its text.
        if (run) log.append(...talkBoxesFor(State.chatId, answers, true));
        // The answer being written: its text so far, then the dots while it works.
        if (run?.text) {
          live = h("div", { class: "reply" });
          log.append(h("div", { class: "chat-row" }, live));
          writeAnswer(run.chatId, live, run.text, false, messageScope(State.chatId, place), run.dots);
        }
        // The agents of the answer being written.
        if (run) log.append(...agentCardsFor(State.chatId, answers, true));
        if (run && (!run.text || run.dots)) log.append(typingDots(runLabel(run)));
        drawStall();
        // The chat stays where it was read, or at its end when it is stuck
        // there; one just opened shows its end.
        if (openedChat) {
          stopPlacing();
          stuck = true;
        }
        if (!stuck && !readAt) holdPlace();
        log.scrollTop = stuck ? log.scrollHeight : kept;
        // Drawn again while the island is closed or opening: the place kept, found in the new log.
        if (readAt?.place && !stuck) putPlace(log, readAt.place);
        openedChat = false;
        drawToEnd();
      } else refreshTimes();
      // A permission card came or went: the agents and the dots' line say whether they wait for it.
      const cardsKey = chatCards().map((c) => `${c.sessionId}:${c.agentId ?? ""}`).join(",");
      if (cardsKey !== pendingCardsKey) {
        pendingCardsKey = cardsKey;
        drawAgents(State.chatId, false, false);
        drawStall();
      }
      tickAgents();

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
        : askFor.has(State.chatId) ? t(STRINGS.askPlaceholder, { name: askFor.get(State.chatId)!.title })
        : t(State.chatHistory.length === 0 ? STRINGS.placeholderFirst : STRINGS.placeholderNext);
    },
    focus() {
      input.focus();
      input.select();
    },
  };
}
