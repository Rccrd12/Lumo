// The user's own tools (the Tools tab, src-tauri/src/tools.rs) and the tool
// workshop's drafts. Pure helpers, so they can be tested without a webview.
//
// In the workshop (views/forge.ts) the AI hands a tool over at the end of an
// answer (chat.rs workshop_note): a ```lumo-tool block with its JSON (name,
// description, entry, params, permissions, args, timeout), then a
// ```lumo-file <name> block for each of its files. parseDraft reads the newest
// one back; stripDraft takes the blocks out of what the chat shows.

/** The workshop's chats have ids that start so (chat.rs is_workshop). */
export const WORKSHOP_PREFIX = "forge-";

export function isWorkshopChat(id: string): boolean {
  return id.startsWith(WORKSHOP_PREFIX);
}

/** What a tool may say it needs (tools.rs PERMISSIONS). */
export const TOOL_PERMISSIONS = ["network", "read", "write", "system"] as const;
export type ToolPermission = (typeof TOOL_PERMISSIONS)[number];
const PARAM_TYPES = ["string", "number", "integer", "boolean"];

export interface ToolParam {
  name: string;
  type: string;
  description: string;
  required: boolean;
}

export interface ToolFile {
  name: string;
  content: string;
}

/** A tool as the workshop shows it, and hands it to tools_try / tools_save. */
export interface ToolDraft {
  name: string;
  description: string;
  entry: string;
  args: string[];
  params: ToolParam[];
  permissions: ToolPermission[];
  timeout: number;
  files: ToolFile[];
  /** The saved tool this draft changes. */
  replaces?: string | null;
}

/** What the supervisor said about a tool (tools.rs Review, tool_review.rs). */
export interface ToolReview {
  fingerprint: string;
  verdict: "ok" | "caution" | "danger";
  summary: string;
  points: string[];
  /** What the code does that the tool didn't declare. */
  undeclared: string[];
  model: string;
  at: number;
}

/** A saved tool (tools.rs ToolInfo). */
export interface ToolInfo {
  id: string;
  name: string;
  description: string;
  entry: string;
  args: string[];
  params: ToolParam[];
  permissions: string[];
  enabled: boolean;
  timeout: number;
  created: number;
  updated: number;
  dir: string;
  files: string[];
  missing: boolean;
  /** The user lets agents run it without a card (counts only while `mayTrust`). */
  trust?: boolean;
  /** The supervisor's last review, maybe of an older version of the tool. */
  review?: ToolReview;
  /** The review is of the tool as it is now: only then do agents get it. */
  reviewed?: boolean;
  /** What it didn't declare and Lumo couldn't stop it doing anyway. */
  unguarded?: string[];
  mayTrust?: boolean;
}

/** Where a tool stands with the supervisor, for its badge. */
export type ReviewState = "reviewing" | "none" | "ok" | "caution" | "danger";

export function reviewState(tool: ToolInfo, reviewing: boolean): ReviewState {
  if (reviewing) return "reviewing";
  if (!tool.reviewed || !tool.review) return "none";
  return tool.review.verdict;
}

/** The longest line of input the approval card shows. */
const MAX_TARGET = 160;

/**
 * The approval card's line for a call of one of the user's tools: its name,
 * then what it is given ("Benchmark · quick: true, rounds: 3").
 */
export function userToolTarget(name: string, input: Record<string, unknown>): string {
  const parts = Object.entries(input ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
  const line = parts.length ? `${name} · ${parts.join(", ")}` : name;
  return line.length > MAX_TARGET ? `${line.slice(0, MAX_TARGET - 1)}…` : line;
}

/** What a try in the workshop came back with (tools.rs RunResult). */
export interface ToolRun {
  ok: boolean;
  output: string;
  ms: number;
}

// ── Reading the AI's blocks ───────────────────────────────────────────────────

/** A fenced block of ours: its fence, kind, the words after it, and what it holds. */
const BLOCK = /^(`{3,}|~{3,})[ \t]*(lumo-tool|lumo-file)\b[ \t]*([^\n]*)\n([\s\S]*?)\n?^\1[ \t]*$/gm;
/** One of ours still being written: from its opening fence to the end. */
const OPEN_BLOCK = /^(`{3,}|~{3,})[ \t]*lumo-(?:tool|file)\b[\s\S]*$/m;

interface Found {
  manifest: Record<string, unknown> | null;
  files: ToolFile[];
}

function blocks(text: string): Found {
  const found: Found = { manifest: null, files: [] };
  for (const m of text.matchAll(BLOCK)) {
    const [, , kind, after, body] = m;
    if (kind === "lumo-tool") {
      try {
        const parsed = JSON.parse(body);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) found.manifest = parsed as Record<string, unknown>;
      } catch {
        // A manifest that isn't JSON is no draft.
      }
    } else {
      const name = after.trim().replace(/^["'`]|["'`]$/g, "").replace(/^.*[\\/]/, "");
      if (name) {
        const at = found.files.findIndex((f) => f.name.toLowerCase() === name.toLowerCase());
        const file = { name, content: body.endsWith("\n") ? body : `${body}\n` };
        if (at >= 0) found.files[at] = file;
        else found.files.push(file);
      }
    }
  }
  return found;
}

const str = (v: unknown, max = 2000): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

function params(v: unknown): ToolParam[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({
      name: str(p.name, 40),
      type: PARAM_TYPES.includes(str(p.type)) ? str(p.type) : "string",
      description: str(p.description, 400),
      required: p.required === true,
    }))
    .filter((p) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p.name));
}

function permissions(v: unknown): ToolPermission[] {
  const list = Array.isArray(v) ? v.map((p) => str(p).toLowerCase()) : [];
  return TOOL_PERMISSIONS.filter((p) => list.includes(p));
}

/** The draft in one answer, if it hands one over. */
export function draftIn(text: string): ToolDraft | null {
  const { manifest, files } = blocks(text);
  if (!manifest) return null;
  const name = str(manifest.name, 60);
  const entry = str(manifest.entry, 500) || files[0]?.name || "";
  if (!name || !entry) return null;
  const timeout = typeof manifest.timeout === "number" && manifest.timeout > 0 ? Math.min(600, Math.round(manifest.timeout)) : 0;
  return {
    name,
    description: str(manifest.description, 1500),
    entry,
    args: Array.isArray(manifest.args) ? manifest.args.filter((a): a is string => typeof a === "string").slice(0, 40) : [],
    params: params(manifest.params),
    permissions: permissions(manifest.permissions),
    timeout,
    files,
  };
}

/** A full path ("C:\…", "\\server\…", "/…"): a script already on the computer. */
export function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/");
}

/**
 * The newest draft of a workshop chat: the last answer that hands a tool
 * over. A file it names but leaves out (the AI changed another one only) is
 * taken from the answer that last gave it.
 */
export function latestDraft(messages: readonly { role: string; content: string }[]): ToolDraft | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "assistant") continue;
    const draft = draftIn(messages[i].content);
    if (!draft) continue;
    const has = (name: string) => draft.files.some((f) => f.name.toLowerCase() === name.toLowerCase());
    if (!isAbsolutePath(draft.entry) && !has(draft.entry)) {
      for (let j = i - 1; j >= 0; j--) {
        if (messages[j].role !== "assistant") continue;
        const older = blocks(messages[j].content).files.find((f) => f.name.toLowerCase() === draft.entry.toLowerCase());
        if (older) {
          draft.files.push(older);
          break;
        }
      }
    }
    return draft;
  }
  return null;
}

/**
 * A tool the workshop is making and hasn't saved as it is, for the Tools tab
 * to list: the user asked for one and there is no draft yet, the newest draft
 * isn't the one saved (`savedKey`, the draft the chat last saved or opened
 * on), or they asked for more since. Null when there is nothing being made.
 */
export function workshopTool(messages: readonly { role: string; content: string }[], savedKey: string | null): { draft: ToolDraft | null } | null {
  if (!messages.some((m) => m.role === "user")) return null;
  const draft = latestDraft(messages);
  if (!draft || savedKey !== draftKey(draft)) return { draft };
  let last = messages.length - 1;
  while (last >= 0 && !(messages[last].role === "assistant" && draftIn(messages[last].content))) last--;
  return messages.slice(last + 1).some((m) => m.role === "user") ? { draft } : null;
}

/** What the chat shows of an answer: its words, the blocks taken out. */
export function stripDraft(text: string): { text: string; draft: boolean; writing: boolean } {
  let draft = false;
  let out = text.replace(BLOCK, () => {
    draft = true;
    return "";
  });
  let writing = false;
  if (OPEN_BLOCK.test(out)) {
    writing = true;
    out = out.replace(OPEN_BLOCK, "");
  }
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), draft, writing };
}

/** The same draft, whatever the order of what it holds: to know a saved one from a changed one. */
export function draftKey(d: ToolDraft): string {
  return JSON.stringify([d.name, d.description, d.entry, d.args, d.params, d.permissions, d.timeout, d.files.map((f) => [f.name, f.content])]);
}

/** A saved tool as a draft, for the workshop to change it. */
export function draftOf(tool: ToolInfo, files: ToolFile[]): ToolDraft {
  return {
    name: tool.name,
    description: tool.description,
    entry: tool.entry,
    args: tool.args ?? [],
    params: params(tool.params),
    permissions: permissions(tool.permissions),
    timeout: tool.timeout ?? 0,
    files,
    replaces: tool.id,
  };
}

/**
 * The values typed in the workshop's try fields, as the tool's input: numbers
 * as numbers, a box as true or false, an empty field left out.
 */
export function tryInput(list: readonly ToolParam[], typed: Record<string, string | boolean>): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const p of list) {
    const v = typed[p.name];
    if (p.type === "boolean") {
      if (typeof v === "boolean") input[p.name] = v;
      continue;
    }
    const text = typeof v === "string" ? v.trim() : "";
    if (!text) continue;
    if (p.type === "number" || p.type === "integer") {
      const n = Number(text.replace(",", "."));
      input[p.name] = Number.isFinite(n) ? (p.type === "integer" ? Math.round(n) : n) : text;
    } else {
      input[p.name] = text;
    }
  }
  return input;
}

/** The size of a file's text, in bytes as saved (UTF-8). */
export function textBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The id Rust gives a tool of this name (tools.rs slug), for its tile's colour before it is saved. */
export function toolId(name: string): string {
  const folded = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const id = folded.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48).replace(/_+$/, "");
  return id || "tool";
}

/** A fence longer than any run of backticks in `text`, so the block holds it whole. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`{3,}/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** A draft written back as the AI hands one over: its lumo-tool block, then its files. */
export function blocksOf(d: ToolDraft): string {
  const manifest: Record<string, unknown> = {
    name: d.name,
    description: d.description,
    entry: d.entry,
    params: d.params,
    permissions: d.permissions,
  };
  if (d.args.length) manifest.args = d.args;
  if (d.timeout) manifest.timeout = d.timeout;
  const out = ["```lumo-tool", JSON.stringify(manifest, null, 2), "```"];
  for (const f of d.files) {
    const fence = fenceFor(f.content);
    out.push("", `${fence}lumo-file ${f.name}`, f.content.replace(/\n$/, ""), fence);
  }
  return out.join("\n");
}
