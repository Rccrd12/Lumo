// Markdown in the chat's answers: headings, paragraphs, fenced code with a copy button,
// bullet and numbered lists, quotes and rules, with bold, italic, `code` and
// links inside the text, and — on Windows only — tables (Claude Code's
// commands, /doctor among them, answer with them) — and TeX math ($…$, $$…$$, \(…\), \[…\]), drawn
// by math.ts. Also on Windows only, the rich cards of views/rich: GitHub's
// alerts (`> [!NOTE]`…), the ```lumo-… blocks Lumo's system prompt teaches
// (chat.rs), GitHub's task lists (`- [ ] text`) as a checklist to tick,
// a ```diff block and a line that is only an image.
//
// Everything is built as DOM nodes with textContent, never as HTML, so nothing
// a model writes can inject markup. Links open only when they are http(s), and
// even then through Rust, which checks the scheme again.

import { Bridge } from "../core/bridge";
import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { renderMath } from "./math";
import { isMark, protect, scan, spanOf, unprotect, type Span } from "./scan";
import {
  CALLOUT_TYPES, RICH_KINDS, renderCallout, renderChecklist, renderDiffCard, renderImage, renderRich, type CalloutType, type RichContext,
} from "./rich/index";
import { MAX_PER_ANSWER } from "./rich/image";
import { parseCards } from "./rich/cards";
import { checklistsEpoch, parseChecklist, taskItem, type Checklist, type ChecklistItem } from "../core/checklists";
import { N_, t } from "../i18n/i18n";

const STRINGS = {
  copy: N_("Copy"),
  copied: N_("Copied"),
};

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; lang: string; code: string }
  /** `prefix` is "•" or "1."; `indent` the nesting level, from 0. */
  | { kind: "item"; prefix: string; text: string; indent: number }
  | { kind: "quote"; text: string }
  | { kind: "math"; tex: string }
  /** The header row, then the rows, as cells of inline text. */
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "rule" }
  /** A GitHub alert: `> [!NOTE] Title` and the quote lines under it, their Markdown without the `>`. */
  | { kind: "callout"; type: CalloutType; title: string; body: string }
  /**
   * A ```lumo-… block (views/rich): its kind after "lumo-", the title on its
   * fence line and its lines; `open` while its closing fence has not come yet.
   */
  | { kind: "rich"; type: string; title: string; body: string; open: boolean }
  /** List items that are all GitHub task items, `- [ ] text` / `- [x] text`: one checklist. */
  | { kind: "checklist"; items: ChecklistItem[] }
  /** A line that is only an image: `![alt](https://…)`. */
  | { kind: "image"; alt: string; url: string };

const isRule = (s: string) => s === "---" || s === "***" || s === "___";
const isBullet = (s: string) => /^[-*+] /.test(s);
const ordered = (s: string) => /^(\d+)\.\s+/.exec(s);
const isQuote = (s: string) => s.startsWith("> ") || s === ">";
const isTableRow = (s: string) => s.startsWith("|") && s.length > 1;
/**
 * `[!NOTE] text` with no `>` before it, as small local models write it: the
 * text after it and the lines under it, to a blank line, are its body.
 */
const LOOSE_CALLOUT = new RegExp(`^(?:\\*\\*)?\\[!(${CALLOUT_TYPES.join("|")})\\](?:\\*\\*)?[ \\t]*(.*)$`, "i");
/** A line that ends a loose callout's text: a list item, a heading, a quote, a table row, a fence. */
const LOOSE_CALLOUT_END = /^\s*(?:[-*+•]\s|\d+[.)]\s|#|>|\||```)/;
/** `> [!TIP]`, `>[!warning] A title`: the alert's kind and title. */
const CALLOUT = new RegExp(`^>\\s*\\[!(${CALLOUT_TYPES.join("|")})\\][ \\t]*(.*)$`, "i");
/**
 * ```lumo-steps A title: one of the rich cards' fences. Four backticks or
 * more (````lumo-steps) let the block hold ``` code blocks of its own.
 */
const RICH_FENCE = new RegExp(`^(\`{3,})[ \\t]*lumo-(${RICH_KINDS.join("|")})\\b[ \\t]*(.*)$`);
/** A fence line: its backticks and what follows them. */
const FENCE_LINE = /^[ \t]*(`{3,})(.*)$/;
/**
 * "lumo-cards A title" on a line of its own with no fence, as small local
 * models write it, the cards as a list under it (views/rich/cards.ts).
 */
const LOOSE_CARDS = /^[ \t]*(?:\*\*|`)?lumo-cards(?:\*\*|`)?(?:[ \t]+(.*?))?[ \t]*$/;
/**
 * A line of a chart left without its fence name (```, ```plot), as small
 * local models write it: only these keys, with a curve and an x range.
 */
const LOOSE_PLOT_LINE = /^[ \t]*(formula|y|x|yrange|region)[ \t]*:/i;
function loosePlot(lang: string, code: string[]): boolean {
  if (lang !== "" && lang.toLowerCase() !== "plot") return false;
  const keys = code.filter((l) => l.trim()).map((l) => LOOSE_PLOT_LINE.exec(l)?.[1].toLowerCase());
  return keys.length > 0 && keys.every(Boolean) && keys.includes("y") && keys.includes("x");
}
/** A line that goes on a list: blank, indented, or an item. */
const LIST_LINE = /^(?:[ \t]*$|[ \t]|[-*+•][ \t])/;
/**
 * A line that is only an image: `![alt](https://…)`, `![alt](<https://…>)`,
 * a "title" after it or not. Parentheses in the address are fine when they
 * pair up, as in Wikimedia's "Saturn_(cropped).jpg".
 */
const IMAGE_LINE = /^!\[([^\]\n]*)\]\(\s*(?:<([^>\s]+)>|((?:[^()\s]|\([^()\s]*\))+|[^)\s>]+))(?:\s+"[^"]*")?\s*\)$/;
/** The line under a table's header: `|---|:--:|`. */
const isTableRule = (s: string | undefined) => s != null && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(s.trim()) && s.includes("-");
/** A table starts at `i`: a row, and the rule right under it. */
const tableAt = (lines: string[], i: number) => isTableRow(lines[i].trim()) && isTableRule(lines[i + 1]);

/**
 * A row's cells, without the outer pipes; `\|` stays a pipe inside a cell, and
 * so does a pipe inside `code` or a formula ($|x|$).
 */
function tableCells(line: string): string[] {
  const source = line.trim();
  const { masked: s, spans } = protect(source, scan(source, false));
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < s.length; i++) {
    // \| outside code and formulas is a pipe of the cell; inside a formula
    // it stays TeX's \| (a norm, ‖v‖), and the scan already kept it there.
    if (s[i] === "\\" && s[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cell);
      cell = "";
    } else cell += s[i];
  }
  cells.push(cell);
  // The outer pipes leave an empty cell at each end.
  if (s.startsWith("|")) cells.shift();
  if (cells.length > 1 && s.endsWith("|") && !s.endsWith("\\|")) cells.pop();
  // In `code`, \| is a pipe as GitHub reads it; in a formula it stays TeX.
  const restore = (c: string) =>
    [...c].map((ch) => {
      const span = isMark(ch) ? spanOf(ch, spans) : undefined;
      if (!span) return ch;
      const raw = source.slice(span.from, span.to);
      return span.kind === "code" ? raw.replace(/\\\|/g, "|") : raw;
    }).join("");
  return cells.map((c) => restore(c).trim());
}

/** A list item line, bullet or numbered, at any depth. */
const isItem = (line: string) => isBullet(line.trim()) || ordered(line.trim()) != null;
/** A list item's depth, in spaces before its marker. */
const depth = (line: string) => line.length - line.trimStart().length;

/**
 * The list that starts at `i`: its lines up to `end`, items apart or not by
 * a blank line, and its items when every one is a task item (`- [ ] …`). A
 * wrapped item's indented lines join it. A numbered item at the first item's
 * depth after bullets, or a bullet after numbered items, starts another list,
 * so a task list followed by numbered steps stays a checklist.
 */
function listAt(lines: string[], i: number): { end: number; tasks: ChecklistItem[] | null } {
  const tasks: ChecklistItem[] = [];
  const numbered = ordered(lines[i].trim()) != null;
  const otherList = (line: string) => isItem(line) && depth(line) === depth(lines[i]) && (ordered(line.trim()) != null) !== numbered;
  let mixed = false;
  let j = i;
  while (j < lines.length) {
    const line = lines[j];
    if (!line.trim()) {
      let k = j;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k >= lines.length || !isItem(lines[k])) break;
      j = k;
      continue;
    }
    if (otherList(line)) break;
    const task = taskItem(line);
    if (task) tasks.push(task);
    else if (isItem(line)) mixed = true;
    else if (/^[ \t]/.test(line) && tasks.length && !mixed && !FENCE_LINE.test(line)) tasks[tasks.length - 1].text += ` ${line.trim()}`;
    else break;
    j++;
  }
  return { end: j, tasks: mixed || !tasks.length ? null : tasks };
}

/** The image block a line is, when it is only an https image. */
function imageAt(line: string): Extract<Block, { kind: "image" }> | null {
  const image = IMAGE_LINE.exec(line);
  const url = image ? safeWebUrl(image[2] ?? image[3]) : null;
  return image && url?.startsWith("https:") ? { kind: "image", alt: image[1].trim(), url } : null;
}

/** The closer of a $$ or \\[ left open in `text` (outside code and closed formulas), null when none is. */
function openDisplay(text: string): string | null {
  const opener = /\$\$|\\\[/.exec(protect(text).masked)?.[0];
  return opener ? (opener === "$$" ? "$$" : "\\]") : null;
}

/**
 * The line at or after `from` that closes a $$ or \\[ left open in `text`,
 * -1 when none is open or a blank line, a heading or a code fence comes
 * first: a $$ written as text never swallows the rest of the answer.
 */
function displayCloser(text: string, lines: string[], from: number): number {
  const closer = openDisplay(text);
  if (!closer) return -1;
  for (let k = from; k < lines.length; k++) {
    const line = lines[k];
    if (line.includes(closer)) return k;
    if (!line.trim() || /^#+(?:\s|$)/.test(line) || FENCE_LINE.test(line)) return -1;
  }
  return -1;
}

/**
 * Parses the blocks, line by line. `partial`: the text's last line may still
 * be being written (an answer as it streams in).
 */
export function parseMarkdown(input: string, partial = false): Block[] {
  const blocks: Block[] = [];
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  // The lines of a list with task and plain items mixed: a plain list.
  let plainList = -1;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const rich = RICH_FENCE.exec(line);
    if (rich) {
      // Only a bare fence of at least as many backticks closes the block, and
      // not inside a code block of its own (```bash … ```); one indented a
      // little closes it as well.
      const fence = rich[1].length;
      const body: string[] = [];
      let inner = 0;
      let closed = false;
      for (i++; i < lines.length; i++) {
        const m = FENCE_LINE.exec(lines[i]);
        if (m) {
          const bare = m[2].trim() === "";
          if (!inner && bare && m[1].length >= fence) {
            closed = true;
            break;
          }
          if (!inner) inner = m[1].length;
          else if (bare && m[1].length >= inner) inner = 0;
        }
        body.push(lines[i]);
      }
      blocks.push({ kind: "rich", type: rich[2], title: rich[3].trim(), body: body.join("\n"), open: !closed });
      i++;
      continue;
    }

    // The fence left out: the list under the line is the block, when it reads
    // as cards; otherwise the line and the list stay what they are.
    const loose = LOOSE_CARDS.exec(line);
    if (loose) {
      let end = i + 1;
      while (end < lines.length && LIST_LINE.test(lines[end])) end++;
      let last = end;
      while (last > i + 1 && lines[last - 1].trim() === "") last--;
      const title = (loose[1] ?? "").trim();
      const body = lines.slice(i + 1, last).join("\n");
      if (parseCards(title, body)) {
        blocks.push({ kind: "rich", type: "cards", title, body, open: partial && end >= lines.length });
        i = end;
        continue;
      }
    }

    // A code block: only a bare fence of at least as many backticks closes it,
    // so a ```js inside a ````markdown block is part of its code. Indented
    // under a list item, it is still one, its lines without that indent.
    const fence = FENCE_LINE.exec(line);
    if (fence) {
      const lang = fence[2].trim();
      const indent = line.length - line.trimStart().length;
      const code: string[] = [];
      for (i++; i < lines.length; i++) {
        const close = FENCE_LINE.exec(lines[i]);
        if (close && close[1].length >= fence[1].length && !close[2].trim()) break;
        code.push(lines[i].replace(new RegExp(`^[ \\t]{0,${indent}}`), ""));
      }
      if (loosePlot(lang, code)) blocks.push({ kind: "rich", type: "plot", title: "", body: code.join("\n"), open: i >= lines.length });
      else blocks.push({ kind: "code", lang, code: code.join("\n") });
      i++;
      continue;
    }

    // $$ … $$ or \[ … \] on lines of their own: a formula on a line of its own.
    const opener = line.trim().startsWith("$$") ? "$$" : line.trim().startsWith("\\[") ? "\\[" : null;
    if (opener) {
      const closer = opener === "$$" ? "$$" : "\\]";
      const first = line.trim().slice(2);
      const done = first.indexOf(closer);
      if (done >= 0) {
        // On one line; anything after it goes on as text.
        blocks.push({ kind: "math", tex: first.slice(0, done) });
        const rest = first.slice(done + 2).trim();
        if (rest) blocks.push({ kind: "paragraph", text: rest });
        i++;
        continue;
      }
      const tex: string[] = [first];
      for (i++; i < lines.length && !lines[i].includes(closer); i++) tex.push(lines[i]);
      let after = "";
      if (i < lines.length) {
        const end = lines[i].indexOf(closer);
        tex.push(lines[i].slice(0, end));
        after = lines[i].slice(end + 2).trim();
      }
      blocks.push({ kind: "math", tex: tex.join("\n") });
      // As on one line: anything after the closer goes on as text.
      if (after) blocks.push({ kind: "paragraph", text: after });
      i++;
      continue;
    }

    // A heading needs a space after the #s; "#hashtag" stays a paragraph.
    const hashes = /^#+/.exec(line)?.[0].length ?? 0;
    if (hashes && (line.length === hashes || line[hashes] === " ")) {
      const text = line.slice(hashes).trim();
      if (text) blocks.push({ kind: "heading", level: Math.min(hashes, 6), text });
      i++;
      continue;
    }

    if (tableAt(lines, i)) {
      const head = tableCells(line);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && isTableRow(lines[i].trim()); i++) rows.push(tableCells(lines[i]));
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    const stripped = line.trim();
    const alert = CALLOUT.exec(stripped);
    if (alert) {
      const body: string[] = [];
      for (i++; i < lines.length && lines[i].trim().startsWith(">"); i++) body.push(lines[i].trim().replace(/^> ?/, ""));
      blocks.push({ kind: "callout", type: alert[1].toLowerCase() as CalloutType, title: alert[2].trim(), body: body.join("\n") });
      continue;
    }
    const bare = LOOSE_CALLOUT.exec(stripped);
    // With no text, on its line or under it, it is no callout: left as written.
    if (bare && (bare[2].replace(/\*\*$/, "").trim() || (lines[i + 1]?.trim() && !LOOSE_CALLOUT_END.test(lines[i + 1])))) {
      // Bold around the whole line: the closing ** goes too.
      const first = /^\*\*/.test(stripped) ? bare[2].trim().replace(/\*\*$/, "").trim() : bare[2].trim();
      const body = first ? [first] : [];
      // Its text runs to a blank line or another block: a list, a heading, a
      // quote, a table or a fence stays its own (a task list, a checklist).
      for (i++; i < lines.length && lines[i].trim() && !LOOSE_CALLOUT_END.test(lines[i]); i++) body.push(lines[i].trim());
      blocks.push({ kind: "callout", type: bare[1].toLowerCase() as CalloutType, title: "", body: body.join("\n") });
      continue;
    }
    // The last line of a text still being written may be an address cut
    // short at a ")" of its own: it becomes an image once its line is done.
    const image = partial && i === lines.length - 1 ? null : imageAt(stripped);
    if (image) {
      blocks.push(image);
      i++;
      continue;
    }
    if (isRule(stripped)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    if (isQuote(stripped)) {
      blocks.push({ kind: "quote", text: stripped.startsWith("> ") ? stripped.slice(2) : "" });
      i++;
      continue;
    }

    // A list whose items are all task items is a checklist (views/rich/checklist.ts).
    if (i > plainList && isItem(line)) {
      const list = listAt(lines, i);
      if (list.tasks) {
        blocks.push({ kind: "checklist", items: list.tasks });
        i = list.end;
        continue;
      }
      plainList = list.end - 1;
    }

    const indent = Math.floor((line.length - line.trimStart().length) / 2);
    if (isBullet(stripped)) {
      blocks.push({ kind: "item", prefix: "•", text: stripped.slice(2), indent });
      i++;
      continue;
    }
    const number = ordered(stripped);
    if (number) {
      blocks.push({ kind: "item", prefix: `${number[1]}.`, text: stripped.slice(number[0].length), indent });
      i++;
      continue;
    }
    if (!stripped) {
      i++;
      continue;
    }

    // A paragraph runs until a blank line or the start of another block.
    const para = [line];
    for (i++; i < lines.length; i++) {
      const next = lines[i];
      const s = next.trim();
      if (!s || next.startsWith("#") || FENCE_LINE.test(next) || isQuote(s) || CALLOUT.test(s) || isBullet(s) || isRule(s) || ordered(s)) break;
      if (s.startsWith("$$") || s.startsWith("\\[") || tableAt(lines, i) || imageAt(s)) break;
      para.push(next);
    }
    // A formula opened inside the paragraph ("So $$" then its lines) runs to
    // its closer, whatever its lines look like, when the closer comes.
    for (let close = displayCloser(para.join("\n"), lines, i); close >= 0; close = displayCloser(para.join("\n"), lines, i)) {
      for (; i <= close; i++) para.push(lines[i]);
    }
    blocks.push({ kind: "paragraph", text: para.join("\n") });
  }
  return blocks;
}

// ── Inline ────────────────────────────────────────────────────────────────────

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "math"; tex: string; display: boolean }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  /** `url` is null when the target is not a web address: the text stays, the link goes. */
  | { kind: "link"; url: string | null; children: Inline[] };

/**
 * `code`, **bold**, __bold__, *italic*, _italic_ and [text](url), whichever
 * comes first; the url's parentheses are kept when they pair up. No lookbehind: one regex literal an engine rejects would take
 * the whole island down with it.
 */
const INLINE = /`([^`\n]+)`|\*\*((?:[^*\s]|\*[^*\s][^*]*?\*)(?:(?:[^*]|\*[^*\s][^*]*?\*)*?(?:[^*\s]|\*[^*\s][^*]*?\*))?)\*\*|__([^_\s](?:[^_]*?[^_\s])?)__(?!\w)|\*([^*\s](?:[^*]*?[^*\s])?)\*|_([^_\s](?:[^_]*?[^_\s])?)_(?!\w)|\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+|[^)\s]+)\)/g;

const isWordChar = (c: string | undefined) => c != null && /\w/.test(c);

/** The address if it is an http(s) one; anything else (javascript:, file:, data:…) is not a link. */
export function safeWebUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Emphasis and links: what is left once code, formulas and escapes are set aside (scan.ts). */
const EMPHASIS = new RegExp(INLINE.source.slice(INLINE.source.indexOf("|") + 1), "g");

/**
 * Stars that sit between two operands are multiplication, never emphasis:
 * "8*10^-9", "(2.25*10^-9*0.4^3)/(2*8,99*10^9)", "k*q1*q2", "2**10". A single
 * star is one when a letter, a digit or a closing bracket comes before it and
 * a letter, a digit or an opening bracket after it (or a sign then a digit,
 * after a number: "2*-3"); a ** only between numbers or brackets ("2**10",
 * "(a+b)**(n-1)"), so "**API**s", "**1990**s" and "**Nota**(…)" stay bold. Such stars are swapped
 * for TIMES before the parse and given back in what it returns. ASCII only:
 * Chinese and Japanese put emphasis between letters, with no spaces.
 */
const TIMES = "\uFDD0";
const BEFORE_FACTOR = /[A-Za-z0-9)\]]/;
const FACTOR = /[A-Za-z0-9([]/;

function maskProducts(text: string): string {
  if (!text.includes("*")) return text;
  // Where an emphasis of one star or of two was opened on this line (just
  // after its stars), -1 when none is: the next star of its kind after a
  // non-space closes it ("the *n*th term", "**Passo 1**(opzionale)").
  const open = [-1, -1, -1];
  return text.replace(/\*+/g, (run: string, at: number) => {
    const before = text[at - 1] ?? "";
    const after = text[at + run.length] ?? "";
    if (before === "\n") open.fill(-1);
    // Inside an open emphasis, only a star between a number or a one-letter
    // name and a number or letter is a product ("*area = b*h*"), and not
    // when the emphasis holds one word ("*n*th").
    const short = /[\d)\]]/.test(before) || (/[A-Za-z]/.test(before) && !/[A-Za-z]/.test(text[at - 2] ?? ""));
    const inside = run.length === 1 ? short && /[A-Za-z0-9]/.test(after) : /\d/.test(before) && /\d/.test(after);
    const from = run.length <= 2 ? open[run.length] : -1;
    if (from >= 0 && /\S/.test(before) && (!inside || !/\s/.test(text.slice(from, at)))) {
      open[run.length] = -1;
      return run;
    }
    if (!BEFORE_FACTOR.test(before)) {
      if (run.length <= 2 && /\S/.test(after)) open[run.length] = at + run.length;
      return run;
    }
    const product =
      run.length === 1
        ? FACTOR.test(after) || (/[\d)]/.test(before) && /[-+]/.test(after) && /\d/.test(text[at + 2] ?? ""))
        : run.length === 2 && /[\d)]/.test(before) && /[\d(]/.test(after);
    return product ? TIMES.repeat(run.length) : run;
  });
}

const unmask = (t: string) => (t.includes(TIMES) ? t.split(TIMES).join("*") : t);

export function parseInline(text: string): Inline[] {
  // First what is code, a formula or escaped, then the Markdown of the rest:
  // a star or an underscore inside a formula never opens an emphasis.
  const { masked, spans } = protect(text, scan(text));
  return parseMasked(maskProducts(masked), spans, text);
}

function parseMasked(text: string, spans: Span[], source: string): Inline[] {
  const out: Inline[] = [];
  const pushText = (raw: string) => {
    const t = unmask(raw);
    if (!t) return;
    let from = 0;
    const plain = (s: string) => {
      if (!s) return;
      const last = out[out.length - 1];
      if (last?.kind === "text") last.text += s;
      else out.push({ kind: "text", text: s });
    };
    for (let k = 0; k < t.length; k++) {
      if (!isMark(t[k]) || !spans.length) continue;
      plain(t.slice(from, k));
      from = k + 1;
      const span = spanOf(t[k], spans);
      if (span.kind === "code") out.push({ kind: "code", text: span.text });
      else if (span.kind === "math") out.push({ kind: "math", tex: span.tex, display: span.display });
      else plain(span.text);
    }
    plain(t.slice(from));
  };
  const re = new RegExp(EMPHASIS.source, "g");
  let at = 0;
  let m: RegExpExecArray | null;
  // Groups: 1 **, 2 __, 3 *, 4 _; 5 link text, 6 its address.
  while ((m = re.exec(text))) {
    // snake_case_words are not italics: an opening _ must not follow a letter.
    if ((m[4] != null || m[2] != null) && isWordChar(text[m.index - 1])) {
      re.lastIndex = m.index + 1;
      continue;
    }
    // A star run next to punctuation on its inner side and a letter on its outer side opens or closes nothing: "f(*args", "*.log".
    const starred = m[3] ?? m[1];
    if (starred != null && ((/[^\w\s]/.test(starred[starred.length - 1]) && isWordChar(text[m.index + m[0].length])) || (/[^\w\s]/.test(starred[0]) && isWordChar(text[m.index - 1])))) {
      re.lastIndex = m.index + 1;
      continue;
    }
    pushText(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[5] != null) out.push({ kind: "link", url: safeWebUrl(unprotect(unmask(m[6]), spans, source)), children: parseMasked(m[5], spans, source) });
    else if (m[1] != null || m[2] != null) out.push({ kind: "strong", children: parseMasked(m[1] ?? m[2], spans, source) });
    else out.push({ kind: "em", children: parseMasked(m[3] ?? m[4], spans, source) });
  }
  pushText(text.slice(at));
  return out;
}

function appendInline(into: HTMLElement, nodes: Inline[]) {
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        into.append(document.createTextNode(node.text));
        break;
      case "code":
        into.append(h("code", { class: "md-code", text: node.text }));
        break;
      case "math":
        into.append(node.display ? mathBlock(node.tex) : renderMath(node.tex));
        break;
      case "strong":
      case "em": {
        const el = h(node.kind === "strong" ? "strong" : "em");
        appendInline(el, node.children);
        into.append(el);
        break;
      }
      case "link": {
        if (!node.url) {
          appendInline(into, node.children);
          break;
        }
        const url = node.url;
        const a = h("a", { class: "md-link", href: url, title: url });
        a.addEventListener("click", (e) => {
          e.preventDefault();
          void Bridge.openUrl(url);
        });
        appendInline(a, node.children);
        into.append(a);
        break;
      }
    }
  }
}

function inline(text: string, into: HTMLElement) {
  appendInline(into, parseInline(text));
}

// ── Blocks ────────────────────────────────────────────────────────────────────

export async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // No clipboard API (or no permission): the old way, through a hidden field.
    const area = h("textarea", { style: "position:fixed;opacity:0" }) as HTMLTextAreaElement;
    area.value = text;
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}

/**
 * Puts the code on the clipboard; the check mark shows for a moment. The chat
 * uses it too, with its own class, to copy a whole message (views/chat.ts).
 */
export function copyButton(text: string, cls = "md-copy", size = 11): HTMLElement {
  const btn = h("button", { class: cls, title: t(STRINGS.copy), "aria-label": t(STRINGS.copy) }, svg(ICONS.copy, size));
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await writeClipboard(text);
    btn.replaceChildren(svg(ICONS.check, size, { stroke: 2.2 }));
    btn.classList.add("done");
    btn.title = t(STRINGS.copied);
    window.setTimeout(() => {
      btn.replaceChildren(svg(ICONS.copy, size));
      btn.classList.remove("done");
      btn.title = t(STRINGS.copy);
    }, 1500);
  });
  return btn;
}

/** More columns than this and a table is drawn row by row instead. */
const WIDE_TABLE = 3;

/** How one renderMarkdown call draws, and where the block being drawn is in it. */
interface Pass {
  streaming: boolean;
  /** renderMarkdown's scope: the message. */
  scope: string;
  /** The block's place among the message's cards, images and callouts. */
  n: number;
  /** A checklist's place among the message's checklists. */
  list: number;
  /** MarkdownOptions.send. */
  send?: (text: string) => void;
  /** The block holds the last line of a text still being written. */
  tail: boolean;
  /** The images drawn above the block in its answer (MarkdownOptions.imagesBefore). */
  images: number;
}

function render(block: Block, pass: Pass): HTMLElement {
  switch (block.kind) {
    case "heading": {
      const el = h("div", { class: block.level <= 2 ? "md-h md-h1" : "md-h" });
      inline(block.text, el);
      return el;
    }
    case "paragraph": {
      const el = h("div", { class: "md-p" });
      inline(block.text, el);
      return el;
    }
    case "code": {
      // A ```diff block (its info may name the file: ```diff src/a.ts:12) is the diff card.
      const diff = /^diff(?:\s|$)/.test(block.lang) ? renderDiffCard(block.code, block.lang.slice(4).trim(), richContext(pass)) : null;
      return diff ?? h("div", { class: "md-pre" }, h("pre", { text: block.code }), copyButton(block.code));
    }
    case "item": {
      const text = h("span", { class: "md-p" });
      inline(block.text, text);
      const item = h("div", { class: "md-item" }, h("span", { class: "md-bullet", text: block.prefix }), text);
      if (block.indent) item.style.paddingLeft = `${block.indent * 12}px`;
      return item;
    }
    case "quote":
      return quoteRun([block.text]);
    case "table": {
      const cell = (tag: "th" | "td" | "div", text: string) => {
        const el = h(tag);
        inline(text, el);
        return el;
      };
      const width = Math.max(block.head.length, ...block.rows.map((r) => r.length));
      // Too wide for the chat: each row on its own, its first cell as a title,
      // the others under it with their column's name.
      if (width > WIDE_TABLE) {
        return h(
          "div",
          { class: "md-rows" },
          ...block.rows.map((r) => {
            const fields = block.head.slice(1).map((name, n) => [name, r[n + 1] ?? ""]).filter(([, v]) => v);
            return h(
              "div",
              { class: "md-row" },
              cell("div", r[0] ?? ""),
              ...fields.map(([name, value]) => {
                const field = cell("div", value);
                field.className = "md-field";
                field.prepend(h("span", { class: "md-field-name", text: name }));
                return field;
              }),
            );
          }),
        );
      }
      const row = (tag: "th" | "td", cells: string[]) =>
        h("tr", {}, ...Array.from({ length: width }, (_, n) => cell(tag, cells[n] ?? "")));
      return h(
        "div",
        { class: "md-table" },
        h("table", {}, h("thead", {}, row("th", block.head)), h("tbody", {}, ...block.rows.map((r) => row("td", r)))),
      );
    }
    case "rule":
      return h("hr", { class: "md-rule" });
    case "math":
      return mathBlock(block.tex);
    case "callout": {
      const body = h("div", { class: "rc-callout-body" });
      renderMarkdown(body, block.body, { streaming: pass.streaming, scope: `${pass.scope}>${pass.n}`, partial: pass.tail, imagesBefore: pass.images });
      return renderCallout(block.type, block.title, body, (into, text) => inline(text, into));
    }
    case "rich": {
      // A block whose fence never closed in a finished (or stopped) answer is
      // read as if it had; only the answer being written shows a placeholder.
      const done = block.open && !pass.streaming ? { ...block, open: false } : block;
      // A block the card can't read stays what it was written as: code.
      return renderRich(done, richContext(pass)) ?? render({ kind: "code", lang: `lumo-${block.type}`, code: block.body }, pass);
    }
    case "checklist":
      return renderChecklist({ title: "", items: block.items }, richContext(pass));
    case "image":
      return renderImage(block.alt, block.url, pass.images);
  }
}

/** What the rich cards borrow from the Markdown, handed over so views/rich never imports it back. */
function richContext(pass: Pass): RichContext {
  return {
    markdown: (into, text) => renderMarkdown(into, text, { scope: `${pass.scope}>${pass.n}`, send: pass.send, imagesBefore: pass.images }),
    inline: (into, text) => inline(text, into),
    math: (tex, display) => renderMath(tex, display),
    copyButton: (text) => copyButton(text),
    scope: `${pass.scope}\u0000${pass.n}`,
    message: pass.scope,
    list: pass.list,
    send: pass.send,
  };
}

/** The checklist a block is, if it is one: a task list, or a ```lumo-checklist block that has been closed. */
function checklistOf(block: Block, streaming: boolean): Checklist | null {
  if (block.kind === "checklist") return { title: "", items: block.items };
  if (block.kind !== "rich" || block.type !== "checklist" || (block.open && streaming)) return null;
  return parseChecklist(block.title, block.body);
}

/**
 * The checklists in an answer, in the order renderMarkdown draws them (chat.ts
 * tells core/checklists.ts which lists each answer holds).
 */
export function checklistsIn(markdown: string, streaming = false): Checklist[] {
  // Most answers have none: no parsing for them.
  if (!/\[[ xX]\]|lumo-checklist/.test(markdown)) return [];
  return parseMarkdown(markdown)
    .map((b) => checklistOf(b, streaming))
    .filter((c): c is Checklist => c != null);
}

/**
 * A formula on a line of its own: a size up, centred on the chat,
 * scrolling sideways when wider than the chat, its TeX one click away.
 */
function mathBlock(tex: string): HTMLElement {
  return h(
    "div",
    { class: "md-math" },
    h("div", { class: "md-math-scroll" }, renderMath(tex, true)),
    copyButton(`$$${tex.trim()}$$`),
  );
}

/**
 * Quote lines one after the other, blank lines between them or not: one
 * quote with one bar down its side, its lines spaced as paragraphs.
 */
function quoteRun(lines: string[]): HTMLElement {
  const body = h("div", { class: "md-quote-body" });
  for (const line of lines) {
    const text = h("span", { class: "md-p" });
    inline(line, text);
    body.append(text);
  }
  return h("div", { class: "md-quote" }, h("i"), body);
}

export interface MarkdownOptions {
  /**
   * The answer is still being written (chat.ts's live row): a ```lumo-…
   * block whose fence has not come yet shows a placeholder. Otherwise it is
   * read as if closed, or shown as the code it is.
   */
  streaming?: boolean;
  /**
   * Which message this is (chat.ts: the chat and the message's place), so
   * two cards from the same text in two messages keep their own state.
   */
  scope?: string;
  /**
   * Sends a message in this chat as if the user had typed it (chat.ts), for
   * a card's button that asks the AI for more (the quiz's next questions).
   * Only a finished answer gets it.
   */
  send?: (text: string) => void;
  /**
   * The last line may still be being written. By default, while streaming,
   * unless the text ends with a line break.
   */
  partial?: boolean;
  /**
   * The images drawn above this text in the same answer (a callout's or a
   * card's text): an answer downloads its first MAX_PER_ANSWER images only.
   */
  imagesBefore?: number;
  /**
   * Shown after the text, left in place when it is already there (the tool
   * workshop's "Writing the tool…" line, its dot pulsing on across draws).
   */
  after?: HTMLElement | null;
}

/**
 * The images a block draws, or may: an image line, or the image lines in a
 * callout's or a card's text, counted the same at each redraw.
 */
function imagesOf(block: Block): number {
  if (block.kind === "image") return 1;
  if (block.kind === "callout" || block.kind === "rich") return block.body.split("\n").filter((l) => imageAt(l.trim())).length;
  return 0;
}

/** The finished cards each container shows, by identity, kept for its next redraw. */
const shown = new WeakMap<HTMLElement, Map<string, HTMLElement>>();

/**
 * What identifies a card, image or callout across redraws of the same
 * container: its place and its text. Null for anything drawn again each time,
 * and for a block still being written but its placeholder.
 */
function identity(block: Block, n: number, streaming: boolean, tail: boolean, images: number): string | null {
  switch (block.kind) {
    case "rich": {
      // Still being written: its placeholder, the same node while the body
      // grows, so its dots keep pulsing instead of starting over each chunk.
      if (block.open && streaming) return `pending\u0000${n}\u0000${block.type}\u0000${block.title}`;
      // A checklist is drawn again when a list is written again further down.
      const lists = block.type === "checklist" ? checklistsEpoch() : "";
      return `rich\u0000${n}\u0000${lists}\u0000${block.type}\u0000${block.title}\u0000${block.body}\u0000${block.open}`;
    }
    case "image":
      return `image\u0000${n}\u0000${images >= MAX_PER_ANSWER}\u0000${block.url}\u0000${block.alt}`;
    case "callout":
      return `callout\u0000${n}\u0000${tail}\u0000${block.type}\u0000${block.title}\u0000${block.body}`;
    case "checklist":
      return `checklist\u0000${n}\u0000${checklistsEpoch()}\u0000${block.items.map((i) => `${i.done ? "x" : " "}${i.indent}${i.text}`).join("\n")}`;
    case "code":
      return /^diff(?:\s|$)/.test(block.lang) ? `diff\u0000${n}\u0000${block.lang}\u0000${block.code}` : null;
    default:
      return null;
  }
}

/**
 * Makes `into` show `nodes`, in order, leaving where they are the ones it
 * already shows: a node taken out and put back starts its CSS animations
 * over (the placeholder's dots, at every chunk of an answer).
 */
function place(into: HTMLElement, nodes: HTMLElement[]): void {
  const wanted = new Set<Node>(nodes);
  for (const child of Array.from(into.childNodes)) if (!wanted.has(child)) child.remove();
  nodes.forEach((node, i) => {
    const at = into.childNodes[i] ?? null;
    if (at !== node) into.insertBefore(node, at);
  });
}

/**
 * Replaces what `into` shows with the Markdown rendered. A card, image or
 * callout already shown in `into` with the same text stays the same node, so
 * an answer still being written doesn't rebuild the cards above its end (a
 * slider being dragged, a button being pressed, the focus all stay).
 */
export function renderMarkdown(into: HTMLElement, markdown: string, opts: MarkdownOptions = {}) {
  const streaming = opts.streaming === true;
  const partial = opts.partial ?? (streaming && !markdown.endsWith("\n"));
  const blocks = parseMarkdown(markdown, partial);
  const before = shown.get(into);
  const kept = new Map<string, HTMLElement>();
  let n = 0;
  let list = 0;
  let images = opts.imagesBefore ?? 0;
  const out: HTMLElement[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (block.kind !== "quote") {
      const tail = partial && i === blocks.length - 1;
      const found = identity(block, n, streaming, tail, images);
      // A card drawn when nothing could be sent (the ink still uncovering the
      // answer) is drawn again once it can: a quiz's "N more questions".
      const placed = found != null && opts.send && block.kind === "rich" ? `${found}\u0000send` : found;
      const counted = placed != null || block.kind === "rich";
      const pass: Pass = { streaming, scope: opts.scope ?? "", n, list, send: opts.send, tail, images };
      images += imagesOf(block);
      if (checklistOf(block, streaming)) list++;
      if (counted) n++;
      const el = (placed != null ? before?.get(placed) : undefined) ?? render(block, pass);
      if (placed != null) kept.set(placed, el);
      out.push(el);
      continue;
    }
    const texts: string[] = [];
    for (; i < blocks.length && blocks[i].kind === "quote"; i++) texts.push((blocks[i] as { text: string }).text);
    i--;
    const lines: string[] = [];
    for (let k = 0; k < texts.length; k++) {
      if (!texts[k]) continue;
      // A formula over several quote lines ("> $$", "> a = b", "> $$") stays
      // one, when its closer comes before a blank quote line.
      let line = texts[k];
      const close = displayCloser(line, texts, k + 1);
      if (close >= 0) {
        line = texts.slice(k, close + 1).join("\n");
        k = close;
      }
      lines.push(line);
    }
    if (lines.length) out.push(quoteRun(lines));
  }
  if (opts.after) out.push(opts.after);
  place(into, out);
  if (kept.size) shown.set(into, kept);
  else shown.delete(into);
}
