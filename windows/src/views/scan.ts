// The one reading of what in a text is code, a formula or an escaped
// character, before any Markdown: these spans are set aside first, so a star,
// an underscore, a pipe or a hash inside them is never read as emphasis, a
// table's column or a heading. markdown.ts parses the rest; ink.ts and the
// cards ask the same spans where not to cut and where a formula is.

export type Span =
  | { kind: "code"; from: number; to: number; text: string }
  | { kind: "math"; from: number; to: number; tex: string; display: boolean }
  /** An escaped character (`\$`, `\*`…), or a character of the text that looks like a mark: shown as it is. */
  | { kind: "text"; from: number; to: number; text: string };

/** The marks written in place of the spans: one character each, from the private use area. */
const MARK_BASE = 0xe000;
const MARK_LAST = 0xf8ff;
export const isMark = (c: string) => c.length === 1 && c.charCodeAt(0) >= MARK_BASE && c.charCodeAt(0) <= MARK_LAST;

/**
 * The spans of `text`, in order. `multiline`: a $$…$$, \[…\] or \(…\) may run
 * across lines (a paragraph); a $…$ and `code` never do.
 */
export function scan(text: string, multiline = true): Span[] {
  const spans: Span[] = [];
  const n = text.length;
  let i = 0;
  const lineEnd = (from: number) => {
    const e = text.indexOf("\n", from);
    return e < 0 ? n : e;
  };
  while (i < n) {
    const c = text[i];
    // A character of the text that is one of the marks: kept as text.
    if (isMark(c)) {
      spans.push({ kind: "text", from: i, to: i + 1, text: c });
      i++;
      continue;
    }
    if (c === "\\") {
      const next = text[i + 1];
      // \( … \) and \[ … \]: always a formula.
      if (next === "(" || next === "[") {
        const close = next === "(" ? "\\)" : "\\]";
        const end = text.indexOf(close, i + 2);
        if (end > i + 2 && (multiline || !text.slice(i, end).includes("\n"))) {
          spans.push({ kind: "math", from: i, to: end + 2, tex: text.slice(i + 2, end), display: next === "[" });
          i = end + 2;
          continue;
        }
      }
      // An escaped mark is that character, never the start of anything.
      if (next != null && "$*_`~#".includes(next)) {
        spans.push({ kind: "text", from: i, to: i + 2, text: next });
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (c === "`") {
      let k = i;
      while (text[k] === "`") k++;
      const ticks = k - i;
      const end = text.indexOf("`".repeat(ticks), k);
      const stop = lineEnd(k);
      // A run of the same length closes it, on the same line, not part of a longer run.
      if (end >= 0 && end <= stop && text[end + ticks] !== "`" && end > k) {
        spans.push({ kind: "code", from: i, to: end + ticks, text: text.slice(k, end) });
        i = end + ticks;
        continue;
      }
      i = k;
      continue;
    }
    if (c === "$") {
      if (text[i + 1] === "$") {
        const end = text.indexOf("$$", i + 2);
        if (end > i + 2 && (multiline || !text.slice(i, end).includes("\n"))) {
          spans.push({ kind: "math", from: i, to: end + 2, tex: text.slice(i + 2, end), display: true });
          i = end + 2;
          continue;
        }
        i += 2;
        continue;
      }
      const end = closingDollar(text, i);
      if (end != null) {
        spans.push({ kind: "math", from: i, to: end + 1, tex: text.slice(i + 1, end), display: false });
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return spans;
}

/**
 * Where the $ at `at` closes as a formula, null when it is money: the rules
 * markdown.ts had, in one place. No space just inside the dollars, on one
 * line, no digit just before the opening $ ("25$") or just after the closing
 * one ("$5 … $10"), and no ** inside ("$0,20 … **$ 130**").
 */
function closingDollar(text: string, at: number): number | null {
  if (/\d/.test(text[at - 1] ?? "")) return null;
  for (let j = at + 1; j < text.length; j++) {
    const c = text[j];
    if (c === "\n") return null;
    if (c === "\\") {
      j++;
      continue;
    }
    if (c !== "$") continue;
    const tex = text.slice(at + 1, j);
    if (!tex || /^\s|\s$/.test(tex) || tex.includes("**") || /\d/.test(text[j + 1] ?? "")) return null;
    return j;
  }
  return null;
}

/** The text with each span written as one mark, and the spans by mark. */
export function protect(text: string, spans = scan(text)): { masked: string; spans: Span[] } {
  if (!spans.length || spans.length > MARK_LAST - MARK_BASE) return { masked: text, spans: [] };
  let masked = "";
  let at = 0;
  spans.forEach((s, k) => {
    masked += text.slice(at, s.from) + String.fromCharCode(MARK_BASE + k);
    at = s.to;
  });
  return { masked: masked + text.slice(at), spans };
}

/** The span a mark stands for. */
export const spanOf = (mark: string, spans: Span[]) => spans[mark.charCodeAt(0) - MARK_BASE];

/** The source text back, every mark replaced by what it stood for in `source`. */
export function unprotect(masked: string, spans: Span[], source: string): string {
  if (!spans.length) return masked;
  let out = "";
  for (const c of masked) {
    const s = isMark(c) ? spans[c.charCodeAt(0) - MARK_BASE] : undefined;
    out += s ? source.slice(s.from, s.to) : c;
  }
  return out;
}
