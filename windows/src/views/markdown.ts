// Markdown in the chat's answers: headings, paragraphs, fenced code with a copy button,
// bullet and numbered lists, quotes and rules, with bold, italic, `code` and
// links inside the text, and — on Windows only — tables (Claude Code's
// commands, /doctor among them, answer with them) — and TeX math ($…$, $$…$$, \(…\), \[…\]), drawn
// by math.ts.
//
// Everything is built as DOM nodes with textContent, never as HTML, so nothing
// a model writes can inject markup. Links open only when they are http(s), and
// even then through Rust, which checks the scheme again.

import { Bridge } from "../core/bridge";
import { h, svg } from "./dom";
import { ICONS } from "./icons";
import { renderMath } from "./math";
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
  | { kind: "rule" };

const isRule = (s: string) => s === "---" || s === "***" || s === "___";
const isBullet = (s: string) => /^[-*+] /.test(s);
const ordered = (s: string) => /^(\d+)\.\s+/.exec(s);
const isQuote = (s: string) => s.startsWith("> ") || s === ">";
const isTableRow = (s: string) => s.startsWith("|") && s.length > 1;
/** The line under a table's header: `|---|:--:|`. */
const isTableRule = (s: string | undefined) => s != null && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(s.trim()) && s.includes("-");
/** A table starts at `i`: a row, and the rule right under it. */
const tableAt = (lines: string[], i: number) => isTableRow(lines[i].trim()) && isTableRule(lines[i + 1]);

/** A row's cells, without the outer pipes; `\|` stays a pipe inside a cell. */
function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  const s = line.trim();
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += s[i];
  }
  cells.push(cell.trim());
  // The outer pipes leave an empty cell at each end.
  if (s.startsWith("|")) cells.shift();
  if (cells.length > 1 && s.endsWith("|") && !s.endsWith("\\|")) cells.pop();
  return cells;
}

/** Parses the blocks, line by line. */
export function parseMarkdown(input: string): Block[] {
  const blocks: Block[] = [];
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      blocks.push({ kind: "code", lang, code: code.join("\n") });
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
      if (!s || next.startsWith("#") || next.startsWith("```") || isQuote(s) || isBullet(s) || isRule(s) || ordered(s)) break;
      if (s.startsWith("$$") || s.startsWith("\\[") || tableAt(lines, i)) break;
      para.push(next);
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
 * comes first. No lookbehind: one regex literal an engine rejects would take
 * the whole island down with it.
 */
const INLINE = /`([^`\n]+)`|\*\*([^*]+?)\*\*|__([^_]+?)__|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_(?!\w)|\[([^\]\n]+)\]\(([^)\s]+)\)/g;

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

/**
 * Math is found with the rest, whichever comes first: $$…$$, \(…\), \[…\]
 * and $…$. A $…$ needs no space just inside its dollars and no digit just
 * after, so "$5 and $10" stays text.
 */
const MATH = /\$\$([^$]+?)\$\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\$([^$\n]+?)\$/;
const ALL = new RegExp(`(\`[^\`\n]+\`)|${MATH.source}|${INLINE.source.slice(INLINE.source.indexOf("|") + 1)}`, "g");

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const pushText = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += t;
    else out.push({ kind: "text", text: t });
  };
  const re = new RegExp(ALL.source, "g");
  let at = 0;
  let m: RegExpExecArray | null;
  // Groups: 1 code; 2 $$, 3 \(, 4 \[, 5 $; 6 **, 7 __, 8 *, 9 _; 10 link text, 11 its address.
  while ((m = re.exec(text))) {
    if (m[5] != null && (/^\s|\s$/.test(m[5]) || /\d/.test(text[m.index + m[0].length] ?? ""))) {
      re.lastIndex = m.index + 1;
      continue;
    }
    // snake_case_words are not italics: an opening _ must not follow a letter.
    if (m[9] != null && isWordChar(text[m.index - 1])) {
      re.lastIndex = m.index + 1;
      continue;
    }
    pushText(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] != null) out.push({ kind: "code", text: m[1].slice(1, -1) });
    else if (m[2] != null || m[3] != null || m[4] != null || m[5] != null) {
      out.push({ kind: "math", tex: m[2] ?? m[3] ?? m[4] ?? m[5], display: m[2] != null || m[4] != null });
    } else if (m[10] != null) out.push({ kind: "link", url: safeWebUrl(m[11]), children: parseInline(m[10]) });
    else if (m[6] != null || m[7] != null) out.push({ kind: "strong", children: parseInline(m[6] ?? m[7]) });
    else out.push({ kind: "em", children: parseInline(m[8] ?? m[9]) });
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
        into.append(renderMath(node.tex, node.display));
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
export function copyButton(text: string, cls = "md-copy"): HTMLElement {
  const btn = h("button", { class: cls, title: t(STRINGS.copy), "aria-label": t(STRINGS.copy) }, svg(ICONS.copy, 11));
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await writeClipboard(text);
    btn.replaceChildren(svg(ICONS.check, 11, { stroke: 2.2 }));
    btn.classList.add("done");
    btn.title = t(STRINGS.copied);
    window.setTimeout(() => {
      btn.replaceChildren(svg(ICONS.copy, 11));
      btn.classList.remove("done");
      btn.title = t(STRINGS.copy);
    }, 1500);
  });
  return btn;
}

/** More columns than this and a table is drawn row by row instead. */
const WIDE_TABLE = 3;

function render(block: Block): HTMLElement {
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
    case "code":
      return h("div", { class: "md-pre" }, h("pre", { text: block.code }), copyButton(block.code));
    case "item": {
      const text = h("span", { class: "md-p" });
      inline(block.text, text);
      const item = h("div", { class: "md-item" }, h("span", { class: "md-bullet", text: block.prefix }), text);
      if (block.indent) item.style.paddingLeft = `${block.indent * 12}px`;
      return item;
    }
    case "quote": {
      const text = h("span", { class: "md-p" });
      inline(block.text, text);
      return h("div", { class: "md-quote" }, h("i"), text);
    }
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
      return renderMath(block.tex, true);
  }
}

/** Replaces what `into` shows with the Markdown rendered. */
export function renderMarkdown(into: HTMLElement, markdown: string) {
  into.replaceChildren(...parseMarkdown(markdown).map(render));
}
