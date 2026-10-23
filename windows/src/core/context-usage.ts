// Claude Code's /context report, read back from the Markdown it answers with
// (a title, the model and tokens, then tables), so the chat can draw it as a
// small card instead of rows of pipes (views/chat.ts). Pure helpers, so they
// can be tested without a webview.

import { N_ } from "../i18n/i18n";

export interface ContextCategory {
  /** As Claude Code names it ("Messages"). */
  name: string;
  tokens: number;
}

/** A group of the details: MCP tools by server, the skills, the memory files. */
export interface ContextGroup {
  name: string;
  count: number;
  tokens: number;
}

export interface ContextReport {
  model: string;
  used: number;
  total: number;
  /** Every category but Free space, in Claude Code's order (deferred ones and the buffer included). */
  categories: ContextCategory[];
  free: number;
  /** MCP tools by server, then skills and memory files, biggest first within each. */
  groups: { kind: "mcp" | "skills" | "memory"; items: ContextGroup[] }[];
}

/** Each category's name on screen and colour, by Claude Code's name. */
export const CONTEXT_CATEGORIES: Record<string, { label: string; color: string }> = {
  "System prompt": { label: N_("System prompt"), color: "#8b929e" },
  "System tools": { label: N_("System tools"), color: "#60a5fa" },
  "System tools (deferred)": { label: N_("System tools"), color: "#60a5fa" },
  "MCP tools": { label: N_("MCP tools"), color: "#a78bfa" },
  "MCP tools (deferred)": { label: N_("MCP tools"), color: "#a78bfa" },
  "MCP server instructions": { label: N_("MCP server instructions"), color: "#c4b5fd" },
  "Custom agents": { label: N_("Custom agents"), color: "#2dd4bf" },
  "Memory files": { label: N_("Memory files"), color: "#34d399" },
  Skills: { label: N_("Skills"), color: "#f5a524" },
  Messages: { label: N_("Messages"), color: "#E07950" },
  "Autocompact buffer": { label: N_("Kept free for compacting"), color: "#3a3d44" },
};

export const CONTEXT_STRINGS = {
  title: N_("Context"),
  used: N_("{used} of {total}"),
  free: N_("{free} free"),
  details: N_("Details"),
  deferred: N_("Loaded when needed"),
  more: N_("and {count} more"),
  mcp: N_("MCP tools"),
  skills: N_("Skills"),
  memory: N_("Memory files"),
};

/**
 * What Claude Code counts as used: the deferred tools are only named until a
 * turn needs them, and the autocompact buffer is room kept, not taken.
 */
export function isDeferred(name: string): boolean {
  return /\(deferred\)\s*$/i.test(name);
}

export const BUFFER = "Autocompact buffer";

/** "29.6k", "1m", "~480", "633" as a number of tokens; NaN when it is none. */
export function parseTokens(raw: string): number {
  const m = /^~?\s*([\d.,]+)\s*([km])?$/i.exec(raw.trim());
  if (!m) return NaN;
  const n = Number(m[1].replace(/,/g, ""));
  const unit = m[2]?.toLowerCase();
  return n * (unit === "k" ? 1e3 : unit === "m" ? 1e6 : 1);
}

/** A number of tokens the way Claude Code writes them: 633, 9.7k, 1m. */
export function formatTokens(n: number): string {
  if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/** How full, as a whole percent; "<1" for a sliver, so a used context never reads 0. */
export function usedPercent(report: ContextReport): string {
  const p = (report.used / report.total) * 100;
  return p > 0 && p < 1 ? "<1" : String(Math.round(p));
}

/** An MCP server as people know it: "claude_ai_Google_Calendar" is Google Calendar. */
export function serverName(name: string): string {
  return name.replace(/^claude_ai_/i, "").replace(/_/g, " ").trim() || name;
}

/** The cells of a Markdown table row, or null for a line that isn't one (or is its rule). */
function cells(line: string): string[] | null {
  const s = line.trim();
  if (!s.startsWith("|") || /^\|[\s:|-]+\|$/.test(s)) return null;
  return s.replace(/^\||\|$/g, "").split("|").map((c) => c.trim().replace(/^\*\*|\*\*$/g, ""));
}

/** The report in a /context answer; null for any other text. */
export function parseContextReport(text: string): ContextReport | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (!lines.some((l) => /^#{1,3}\s*Context Usage\s*$/i.test(l.trim()))) return null;
  const field = (name: string) => {
    const line = lines.find((l) => new RegExp(`^\\*\\*${name}:\\*\\*`, "i").test(l.trim()));
    return line ? line.trim().replace(new RegExp(`^\\*\\*${name}:\\*\\*`, "i"), "").trim() : "";
  };
  const tokens = /^([\d.,~]+[km]?)\s*\/\s*([\d.,]+[km]?)/i.exec(field("Tokens"));
  if (!tokens) return null;
  const report: ContextReport = {
    model: field("Model"),
    used: parseTokens(tokens[1]),
    total: parseTokens(tokens[2]),
    categories: [],
    free: 0,
    groups: [],
  };
  if (!(report.total > 0)) return null;

  // The tables, each under its heading.
  let section = "";
  const mcp = new Map<string, ContextGroup>();
  const skills: ContextGroup[] = [];
  const memory: ContextGroup[] = [];
  for (const line of lines) {
    const heading = /^#{1,4}\s*(.+?)\s*$/.exec(line.trim());
    if (heading) {
      section = heading[1].toLowerCase();
      continue;
    }
    const row = cells(line);
    if (!row || row.length < 2) continue;
    const last = parseTokens(row[row.length - 1]);
    // A header row ("Category | Tokens | Percentage") has no numbers.
    if (section.startsWith("estimated usage")) {
      const n = parseTokens(row[1]);
      if (Number.isNaN(n)) continue;
      if (/^free space$/i.test(row[0])) report.free = n;
      else if (n > 0) report.categories.push({ name: row[0], tokens: n });
    } else if (section.startsWith("mcp tools") && row.length >= 3 && !Number.isNaN(last)) {
      const server = row[1] || "?";
      const g = mcp.get(server) ?? { name: server, count: 0, tokens: 0 };
      g.count++;
      g.tokens += last;
      mcp.set(server, g);
    } else if (section.startsWith("skills") && !Number.isNaN(last)) {
      skills.push({ name: row[0], count: 1, tokens: last });
    } else if (section.startsWith("memory") && !Number.isNaN(last)) {
      // The file's name, not its whole path.
      const path = row.length >= 3 ? row[1] : row[0];
      memory.push({ name: path.replace(/^.*[\\/]/, "") || path, count: 1, tokens: last });
    }
  }
  const biggest = (a: ContextGroup, b: ContextGroup) => b.tokens - a.tokens;
  if (mcp.size) report.groups.push({ kind: "mcp", items: [...mcp.values()].sort(biggest) });
  if (skills.length) report.groups.push({ kind: "skills", items: skills.sort(biggest) });
  if (memory.length) report.groups.push({ kind: "memory", items: memory.sort(biggest) });
  if (!report.free) report.free = Math.max(0, report.total - report.categories.reduce((n, c) => n + c.tokens, 0));
  return report;
}
