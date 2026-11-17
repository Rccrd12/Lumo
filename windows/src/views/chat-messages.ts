// The chat's messages (views/chat.ts): a question's and an answer's bubble,
// what went with a question, warnings, long questions folded, the copies an
// answer made, what the answer is doing beside the typing dots, the answer's
// checklists, and the chips above the field.

import { h, svg, clear } from "./dom";
import { ICONS } from "./icons";
import { checklistsIn, copyButton, renderMarkdown } from "./markdown";
import { renderAnswer } from "./context-card";
import { Bridge, type ChatActivity, type ChatContext, type ScreenContext } from "../core/bridge";
import { activeModel, isCliProvider, providerDef } from "../core/providers";
import { State, type ChatMessage } from "../core/state";
import { chatChecklists, fromSavedTurn, setChatChecklists, toSavedTurn, type AnswerWarning } from "../core/chats";
import type { AskQuote } from "../core/chats";
import { THUMB_EDGE, groupKey, keptItems, readSent, sentGroups, type SentGroup, type SentItem } from "../core/sent";
import type { ChatPermissions, SavedTurn } from "../core/chats";
import { checklistNote, lineagesOf, listsInChat, noteChatChecklists, withTold, type Checklist } from "../core/checklists";
import { ageLabel } from "../core/plan";
import { SCREEN_STRINGS } from "../core/screen";
import { COMPUTER_TEXT } from "../core/computer";
import { currentStep } from "../core/computer-use";
import { computerRecapBox } from "./computer-recap";
import { N_, dayMonth, language, t, tl } from "../i18n/i18n";
import { type CopyDiff, type CopyView, type Pair, type Segment, copyView, counts, pairs, wordMarks } from "../core/copy-diff";
import { COMPACT_TEXT, UPLOADED_TEXT, compactNotice, speakerName, takeTimers } from "../core/compact";
import { takeListens } from "../core/listen";
import { draftIn, isWorkshopChat, stripDraft } from "../core/tools";
import { FORGE_STRINGS, draftChip } from "./forge";
import { STRINGS } from "./chat-strings";

let nextId = 1;

/** A new message's id, for the chat's history. */
export function newMessageId(): number {
  return nextId++;
}

/** The folder open in File Explorer is asked again at most this often while the field takes focus. */
export const PEEK_EVERY_MS = 1500;

/** How long a plan that just came up over the field ignores clicks (as the permission card). */
export const PLAN_ASK_GUARD_MS = 600;
/**
 * The screen menu waits at most this long for the browsers' tabs (read from
 * their windows on Windows); a slow browser adds its entry when it answers.
 */
export const TABS_WAIT_MS = 1200;

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
  /** A click on one of the things that went with a question, in the list under it. */
  onOpenSent?: (message: ChatMessage, item: SentItem) => void;
}

/** Sends a message as if typed, for a card's button (the quiz's next questions): set once the chat is built. */
export let sendFromCard: ((text: string) => boolean) | undefined;

export function setSendFromCard(send: (text: string) => boolean) {
  sendFromCard = send;
}

/** The "2 min ago" under the messages on screen, kept fresh as the chat is drawn and hovered. */
export let sentTimes: { el: HTMLElement; at: number }[] = [];

export function setSentTimes(times: { el: HTMLElement; at: number }[]) {
  sentTimes = times;
}

/** "just now", "12 min ago", "3 h ago", then the day: when a message was sent or answered. */
/** The chat's messages as Past chats keeps them: what failed left out, what went with a question kept small. */
export function savedTurns(history: readonly ChatMessage[]): SavedTurn[] {
  return history.filter((m) => !m.failed).map((m) => ({
    ...toSavedTurn(m),
    ...(m.sent?.length ? { sent: keptItems(m.sent) } : {}),
  }));
}

/** A kept message back on screen: Rust takes every turn back as it is, so its place there is its index. */
export function messageOf(turn: SavedTurn, i: number): ChatMessage {
  const sent = readSent(turn.sent);
  return {
    id: nextId++, role: turn.role, content: turn.content, turn: i, ...fromSavedTurn(turn),
    ...(sent ? { sent } : {}),
  };
}

/** A message as Rust's conversation holds it (chat_restore): what it kept, when not what shows. */
export function conversationTurn(m: { role: "user" | "assistant"; content: string; kept?: string }): { role: "user" | "assistant"; content: string } {
  return { role: m.role, content: m.kept ?? m.content };
}

export function sentAgo(at: number, now = Date.now()): string {
  if (now - at < 86_400_000) return ageLabel(at, now);
  const d = new Date(at);
  return dayMonth(d.getMonth(), d.getDate());
}

export function refreshTimes(times = sentTimes, now = Date.now()) {
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
export function bubble(message: ChatMessage, opts: BubbleOptions = {}): HTMLElement {
  const state = opts.editing ? " editing" : opts.dropped ? " dropped" : "";
  // The answer failed: what went wrong stays under the question, the CLI's
  // own words for it apart and smaller when Lumo said it in plain words.
  if (message.role === "assistant" && message.failed) {
    const [said, words] = failedParts(message.content);
    const detail = words ? h("div", { class: "msg-warning-detail", text: words }) : null;
    return h("div", { class: `chat-row${state}` }, h("div", { class: "reply-wrap" }, h("div", { class: "msg-failed", text: said }), detail));
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
  // An answer with a warning keeps its bar in sight, the warning on it.
  const bar = h("div", { class: opts.shown || message.warning ? "msg-actions shown" : "msg-actions" });
  let row: HTMLElement;
  if (message.role === "user") {
    const onEdit = opts.onEdit;
    const edit = onEdit ? msgAction("msg-edit", STRINGS.edit, svg(ICONS.pencil, 12, { stroke: 1.8 }), () => onEdit(message)) : null;
    bar.append(...[when, retry, edit, copy].filter((x): x is HTMLElement => x != null));
    const sent = sentBubble(message.content);
    // Asked of an agent: that agent on top of the question, as WhatsApp's quoted Reply.
    if (message.ask) sent.insertBefore(askQuote(message.ask), sent.firstChild);
    foldLong(sent, message.content);
    row = h("div", { class: `chat-row user${state}` }, sent, bar);
    const went = message.sent?.length ? message.sent : null;
    if (went) {
      // What went with it: its icons on the bubble's top right corner, and their list under it on a click.
      sent.classList.add("has-sent");
      const key = `${State.chatId}:${message.id}`;
      const list = sentList(message, went, opts.onOpenSent);
      list.hidden = openSentList !== key;
      const badges = sentBadges(went, "sent-badges");
      badges.classList.toggle("open", !list.hidden);
      badges.addEventListener("click", (e) => {
        e.stopPropagation();
        openSentList = list.hidden ? key : null;
        list.hidden = !list.hidden;
        badges.classList.toggle("open", !list.hidden);
        badges.setAttribute("aria-expanded", String(!list.hidden));
        if (!list.hidden) list.scrollIntoView?.({ block: "nearest" });
      });
      badges.setAttribute("aria-expanded", String(!list.hidden));
      row.replaceChildren(h("div", { class: "bubble-wrap" }, sent, badges), list, bar);
    }
  } else {
    const reply = h("div", { class: "reply" });
    drawReply(reply, message.content, !!opts.workshop, opts.scope);
    // A stopped answer says so on the same line.
    const stopped = message.stopped ? h("span", { class: "msg-stopped", text: tl(STRINGS.stopped) }) : null;
    // The CLI ended with an error after this answer: one line on the bar,
    // which stays in sight, what to know on a click.
    const warned = message.warning ? warningWords(message.warning) : null;
    const detail = warned ? h("div", { class: "msg-warning-detail", text: warned.detail }) : null;
    let warning: HTMLElement | null = null;
    if (warned && detail) {
      detail.hidden = !openWarnings.has(message);
      warning = h("button", { class: "msg-warning", "aria-expanded": String(!detail.hidden) }, svg(ICONS.warning, 11, { stroke: 2.2 }), h("span", { text: warned.line }));
      warning.addEventListener("click", (e) => {
        e.stopPropagation();
        detail.hidden = !detail.hidden;
        if (detail.hidden) openWarnings.delete(message);
        else openWarnings.add(message);
        warning?.setAttribute("aria-expanded", String(!detail.hidden));
        // Opened at the bottom of the log: what it says comes in sight.
        if (!detail.hidden) detail.scrollIntoView?.({ block: "nearest" });
      });
    }
    bar.append(...[copy, retry, stopped, warning, when].filter((x): x is HTMLElement => x != null));
    // The turn used the computer: how it went, under the answer (views/computer-recap.ts).
    const computer = message.computer ? computerRecapBox(message.computer, message.id) : null;
    const copies = message.copies?.length ? copiesBox(message.copies) : null;
    row = h("div", { class: `chat-row${state}` }, h("div", { class: "reply-wrap" }, reply, computer, copies, bar, detail));
  }
  // Hovered after a while: its time says how long ago it is now.
  if (times.length) row.addEventListener("mouseenter", () => refreshTimes(times));
  return row;
}

/** The question whose list of what went with it is open (chat id and message id): a redrawn log keeps it open. */
let openSentList: string | null = null;

/** Each kind's colour (the attachments' tiles) and icon, drawn as a stroke. */
const SENT_ICONS: Record<SentGroup["key"], { cls: string; path: string }> = {
  file: { cls: "attach-file", path: ICONS.docLine },
  picture: { cls: "attach-file", path: ICONS.photo },
  shot: { cls: "attach-shot", path: ICONS.display },
  window: { cls: "attach-window", path: ICONS.window },
  tab: { cls: "attach-tab", path: ICONS.globe },
  selection: { cls: "attach-selection", path: ICONS.textLines },
  folder: { cls: "attach-folder", path: ICONS.folder },
};

/**
 * What went with a question, small: one icon for each kind of thing, in its
 * colour, with how many beside it when more than one; a picture shows its
 * own small picture. A button on the bubble, a plain line elsewhere.
 */
export function sentBadges(items: readonly SentItem[], cls: string): HTMLElement {
  const groups = sentGroups(items);
  const names = items.map((i) => i.label).join("\n");
  const el = cls === "sent-badges"
    ? h("button", { class: cls, title: `${tl(STRINGS.sentWith)}\n${names}`, "aria-label": tl(STRINGS.sentWith) })
    : h("span", { class: cls, title: names });
  for (const g of groups) {
    const look = SENT_ICONS[g.key];
    const thumb = g.first.thumb;
    const mark = thumb
      ? h("img", { class: "sent-thumb", src: thumb, alt: "", draggable: "false" })
      : svg(look.path, 11, { stroke: 1.6 });
    el.append(h("span", { class: `sent-item ${look.cls}` }, mark, g.count > 1 ? h("span", { class: "sent-count", text: String(g.count) }) : null));
  }
  return el;
}

/** Under a question, once its icons are clicked: each thing that went with it, a click opening it. */
function sentList(message: ChatMessage, items: readonly SentItem[], onOpen?: (message: ChatMessage, item: SentItem) => void): HTMLElement {
  const list = h("div", { class: "sent-list" },
    h("div", { class: "sent-list-head" }, h("span", { text: tl(STRINGS.sentWith) }), h("span", { class: "sent-list-count", text: String(items.length) })));
  for (const item of items) {
    const look = SENT_ICONS[groupKey(item)];
    const tile = h("span", { class: `attach-tile ${look.cls}` },
      item.thumb ? h("img", { class: "attach-thumb", src: item.thumb, alt: "", draggable: "false" }) : svg(look.path, 15, { stroke: 1.6 }));
    const row = h("div", { class: "sent-row", title: item.title, role: "button", tabindex: "0" },
      tile,
      h("span", { class: "attach-text" },
        h("span", { class: "attach-name", text: item.label }),
        item.detail ? h("span", { class: "attach-detail", text: item.detail }) : null),
      h("span", { class: "sent-open" }, svg(ICONS.arrowUpRight, 10, { stroke: 1.8 })));
    const open = () => onOpen?.(message, item);
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      open();
    });
    row.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") open();
    });
    list.append(row);
  }
  return list;
}

/** A picture made small and square (THUMB_EDGE), to keep with a question; none when it can't be drawn. */
export function smallPicture(src: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined" || typeof document === "undefined") {
      resolve(undefined);
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const c = document.createElement("canvas");
        const g = side > 0 ? c.getContext("2d") : null;
        if (!g) {
          resolve(undefined);
          return;
        }
        c.width = c.height = THUMB_EDGE;
        g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, THUMB_EDGE, THUMB_EDGE);
        resolve(c.toDataURL("image/jpeg", 0.75));
      } catch {
        resolve(undefined);
      }
    };
    img.onerror = () => resolve(undefined);
    img.src = src;
  });
}

/** The answers whose warning (ChatMessage.warning) is open: a redrawn log keeps it open. */
const openWarnings = new WeakSet<ChatMessage>();

/** The closed island's note for an answer with a warning: the island's amber (--amber). */
export const WARNING_COLOR = "#f5a524";

/** What a warning under an answer says (antigravity_cli.rs answer_warning). */
const WARNING_TEXT = {
  line: N_("Antigravity CLI reported a problem at the end"),
  malformed: N_("While working, the model sent an empty tool call, a mistake of the model's own, and Antigravity CLI had it try again. The answer above is the last one it wrote: check that the work is done, and if it isn't, write “continue”."),
  error: N_("Antigravity CLI ended this turn with an error after writing the answer above: check that the work is done, and if it isn't, write “continue”."),
  message: N_("Antigravity CLI's message: {error}"),
};

/**
 * A warning's line and what to know, in the island's language now (a chat
 * opened later in another language reads in that one); one saved by the
 * 0.22.2 betas keeps the words it was saved with.
 */
export function warningWords(w: AnswerWarning): { line: string; detail: string } {
  if ("line" in w) return w;
  const why = t(w.kind === "malformed" ? WARNING_TEXT.malformed : WARNING_TEXT.error);
  return { line: t(WARNING_TEXT.line), detail: `${why}\n\n${t(WARNING_TEXT.message, { error: w.message })}` };
}

/**
 * A failed answer's text: what Lumo says, and the CLI's own words for it when
 * they come apart (after U+2063, chat.rs ERROR_DETAIL).
 */
export function failedParts(text: string): [string, string] {
  const at = text.indexOf("\u2063");
  return at < 0 ? [text, ""] : [text.slice(0, at).trim(), text.slice(at + 1).trim()];
}

/** The agent a question was asked of, inside its bubble: who, and its line then. */
function askQuote(quote: AskQuote): HTMLElement {
  const el = h("div", { class: "bubble-quote" },
    h("b", { text: t(STRINGS.asking, { name: quote.title }), title: quote.title }),
    h("span", { text: quote.line, title: quote.line }));
  el.dataset.look = quote.look;
  return el;
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

/** Taller than this (page px), a question is folded to its first lines (style.css `.bubble-body.folded`), with Show more in it. */
const FOLD_OVER = 240;
/**
 * The long questions opened with Show more, by chat and text: a redrawn log
 * keeps them open, and so does a chat opened again, whose messages are given
 * new ids (openChat). The oldest go past UNFOLDED_KEPT.
 */
const unfolded = new Set<string>();
const UNFOLDED_KEPT = 100;
/** Each bubble's own measure, once it is laid out and whenever its width changes. */
const foldMeasures = new WeakMap<Element, () => void>();
let foldObserver: ResizeObserver | null = null;

/**
 * A long question, folded: its first lines, fading, and Show more at the
 * bottom of its bubble, which turns into Show less once it is open. A short
 * one is left as it is drawn. Measured once laid out, so it never depends on
 * how many characters it has.
 */
function foldLong(bubble: HTMLElement, text: string): void {
  if (typeof ResizeObserver === "undefined") return;
  const key = `${State.chatId}\n${text}`;
  // Made the first time the question is found long: its text goes in `body`, the button under it.
  let body: HTMLElement | null = null;
  let btn: HTMLElement | null = null;
  const paint = () => {
    const long = (body ?? bubble).scrollHeight > FOLD_OVER;
    if (long && !body) {
      body = h("div", { class: "bubble-body" });
      body.append(...Array.from(bubble.childNodes));
      btn = h("button", { class: "msg-fold" });
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const closing = unfolded.has(key);
        if (closing) unfolded.delete(key);
        else unfold(key);
        paint();
        // Folded again from far down: the question's top comes back in sight.
        if (closing) bubble.scrollIntoView?.({ block: "nearest" });
      });
      // Tab reaching a link in the hidden lines opens the question, so what has the keyboard is in sight.
      body.addEventListener("focusin", () => {
        if (!body?.classList.contains("folded")) return;
        unfold(key);
        paint();
      });
      bubble.append(body, btn);
    }
    if (!body || !btn) return;
    const open = unfolded.has(key);
    btn.hidden = !long;
    body.classList.toggle("folded", long && !open);
    // Only what changed: the island resizing measures every bubble at each frame,
    // and a rewritten label is a change in the log that its observers act on.
    const label = t(open ? STRINGS.showLess : STRINGS.showMore);
    if (btn.textContent !== label) btn.textContent = label;
    if (btn.getAttribute("aria-expanded") !== String(open)) btn.setAttribute("aria-expanded", String(open));
  };
  foldObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) foldMeasures.get(entry.target)?.();
  });
  foldMeasures.set(bubble, paint);
  foldObserver.observe(bubble);
}

/** Opened with Show more: kept, the oldest one going past UNFOLDED_KEPT. */
function unfold(key: string): void {
  unfolded.add(key);
  if (unfolded.size > UNFOLDED_KEPT) unfolded.delete(unfolded.values().next().value as string);
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
export const ACTIVITY_STRINGS = {
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
  /** Claude Code's SendMessage to one of its agents (claude_code.rs activity_for). */
  talking: N_("Talking to {name}"),
  message: N_("Sending a message"),
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
export const TIMED = new Set(["starting", "prompt", "reasoning", "thinking", "retry"]);

export const THINKING: ChatActivity = { kind: "thinking", detail: "" };

/**
 * An answer being written. It belongs to its chat: moving to another chat
 * leaves it going in the background, and it lands in its own chat when done.
 */
export interface Run {
  chatId: string;
  /** The chat's messages: State.chatHistory itself while the chat is on screen. */
  history: ChatMessage[];
  /** The CLI session the chat continues (State.chatSession while on screen). */
  session: string | null;
  provider: string;
  model: string;
  /** What the chat may do without asking, as it was when the question went (chats.ts permissionsFor). */
  permissions: ChatPermissions;
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
export const FIRST_ACTIVITY_MS = 1200;
/** How long a question waits for its chat's model to be checked (checkChatModel). */
export const MODEL_CHECK_WAIT_MS = 3000;

/** How long Lumo shows that an answer came (his hop) or went wrong (his shake). */
export const SETTLE_MS = 2000;

/**
 * The answer is over: Lumo shows how it went for a moment, then goes back to
 * what he showed before. A newer answer or anything else that took over is
 * left alone.
 */
export let settled = 0;
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
export function runSpeaker(run: { provider: string; model: string }): { who: string; color: string } {
  const p = providerDef(run.provider);
  return { who: speakerName(p.id, t(p.name), run.model), color: p.accent };
}

/** Says on the closed island how the answer went, unless the chat is on screen. */
export function noticeAway(text: string, speaker: { who: string; color: string }) {
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
    case "talk":
      return detail ? t(ACTIVITY_STRINGS.talking, { name: detail }) : t(ACTIVITY_STRINGS.message);
    case "plan":
      return t(ACTIVITY_STRINGS.plan);
    case "screen":
      return t(ACTIVITY_STRINGS.screen);
    case "computer": {
      // The step of its plan under way, while it uses the computer with one (computer-state).
      const step = State.computer && !State.computer.stopped ? currentStep(State.computer.steps)?.step.text.replace(/\s+/g, " ").trim() : "";
      return step || t(ACTIVITY_STRINGS.computer);
    }
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
    case "talk":
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
export function typingDots(label: string): HTMLElement {
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
export function drawReply(reply: HTMLElement, content: string, workshop: boolean, scope?: string, streaming = false) {
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
export function drawAnswer(into: HTMLElement, text: string, workshop: boolean, scope: string) {
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
export function noteChecklists(chatId: string, history: ChatMessage[], writing?: string) {
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
export function checklistsToTell(chatId: string, history: ChatMessage[]): { text: string; told: Record<string, string> } {
  noteChecklists(chatId, history);
  return checklistNote(lineagesOf(chatId), chatChecklists(chatId));
}

/** The AI got the question and its checklist lines: they are not sent again. */
export function checklistsTold(chatId: string, told: Record<string, string>) {
  if (Object.keys(told).length) setChatChecklists(chatId, withTold(chatChecklists(chatId), told));
}

/** A chip above the chat (the message being edited), with a way to leave it. */
export function noteChip(label: string, title: string, onRemove: () => void): HTMLElement {
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
export function uploadedChip(name: string): HTMLElement {
  const label = `${t(UPLOADED_TEXT)} · ${name}`;
  const chip = h("div", { class: "chip uploaded", title: label },
    h("span", { class: "chip-check" }, svg(ICONS.check, 9, { stroke: 2.2 })), h("span", { text: label }));
  requestAnimationFrame(() => chip.classList.add("settled"));
  return chip;
}
