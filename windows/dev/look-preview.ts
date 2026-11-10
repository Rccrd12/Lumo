// Dev harness: the real island in a plain browser, with a Claude Code
// session, a permission request, a chat and the tools. `npm run dev`, then
// open /dev/look-preview.html. `?view=approval` opens straight on a view.
// Not part of the app bundle.

import "../src/style.css";
import "../src/look-new.css";
import { State } from "../src/core/state";
import { Island } from "../src/island/island";
import { registerHookHandlers } from "../src/island/hooks";
import type { IslandViewName } from "../src/core/layout";
import { Feed } from "../src/core/compact";
import { Calendar } from "../src/island/activities";
import { setLanguage } from "../src/i18n/i18n";

type Listener = (e: { event: string; id: number; payload: unknown }) => void;
const listeners = (window as unknown as { __lumoListeners: Map<string, Listener> }).__lumoListeners;
const emit = (event: string, payload: unknown) => listeners.get(event)?.({ event, id: 0, payload });
const hook = (payload: Record<string, unknown>) => emit("hook", payload);

const params = new URLSearchParams(location.search);
// ?lang=it: the island in that language (as Settings → General → Language).
const lang = params.get("lang");
if (lang) {
  setLanguage(lang as Parameters<typeof setLanguage>[0]);
  State.settings = { ...State.settings, language: lang } as typeof State.settings;
}
const island = new Island(document.getElementById("root")!);
(window as unknown as { island: Island; State: typeof State }).island = island;
(window as unknown as { State: typeof State }).State = State;
(window as unknown as { Calendar: typeof Calendar }).Calendar = Calendar;
await registerHookHandlers(island);
State.settings = { ...State.settings, soundEnabled: false, ...(lang ? { language: lang } : {}) } as typeof State.settings;
island.applySettings();
State.loadIntegrationTasks();

// A Claude Code session at work in "lumo".
const cwd = "C:\\dev\\lumo";
// With ?idle nothing runs and nothing plays: the home as it is most of the day.
if (!params.has("idle")) {
  hook({ hook_event_name: "SessionStart", cwd });
  hook({ hook_event_name: "UserPromptSubmit", cwd, prompt: "Add a dark mode toggle to the settings" });
  hook({ hook_event_name: "PreToolUse", cwd, tool_name: "Read", tool_input: { file_path: `${cwd}\\src\\settings\\general.ts` } });
  hook({ hook_event_name: "PreToolUse", cwd, tool_name: "Edit", tool_input: { file_path: `${cwd}\\src\\settings\\general.ts`, old_string: "a", new_string: "b" } });

  // A timer and some music, for the live activities.
  Feed.timers = [{ id: 1, label: "Pasta", endsAt: Date.now() + 398_000, total: 600_000 }];
  Feed.media = { title: "Midnight City", artist: "M83", app: "Spotify", playing: true };
}

// Idle, the Email pill on with nothing unread, as most days.
if (params.has("idle")) {
  State.settings = { ...State.settings, activeIntegrations: [...State.settings.activeIntegrations, "integration_mail"] };
  State.integrations.integration_mail = { loaded: true, error: null, configured: true, data: { messages: [] } } as unknown as typeof State.integrations.integration_mail;
  State.loadIntegrationTasks();
}

// A plan, with ?plan: Claude Code leaving Plan Mode with four steps.
if (params.has("plan")) {
  hook({ hook_event_name: "PreToolUse", cwd, tool_name: "ExitPlanMode", tool_input: { plan: "1. Read the settings page\n2. Add the toggle\n3. Save it with the others\n4. Run the tests" } });
  // ?plan=2: under way, the first step done and the second one going.
  if (params.get("plan") === "2") {
    hook({ hook_event_name: "PreToolUse", cwd, tool_name: "TodoWrite", tool_input: { todos: [
      { content: "Read the settings page", status: "completed" },
      { content: "Add the toggle", status: "in_progress" },
      { content: "Save it with the others", status: "pending" },
      { content: "Run the tests", status: "pending" },
    ] } });
  }
}

// The plans' usage, with ?plans: Claude and Codex turned on, with numbers.
if (params.has("plans")) {
  State.settings = { ...State.settings, showPlanInNotch: true, planRelayInstalled: true, showCodexPlanInNotch: true };
  const hour = 3_600_000;
  State.planUsage = { fiveHour: { usedPct: 42, resetsAt: Date.now() + 2 * hour }, sevenDay: { usedPct: 18, resetsAt: Date.now() + 90 * hour }, updatedAt: Date.now() };
  State.codexPlanUsage = { fiveHour: { usedPct: 71, resetsAt: Date.now() + hour }, updatedAt: Date.now() };
}

// Two more sessions, with ?busy: Codex at work on a site, and another Claude Code session done.
if (params.has("busy")) {
  const site = "C:\\dev\\sito-portfolio";
  hook({ hook_event_name: "SessionStart", cwd: site, lumo_agent: "codex" });
  hook({ hook_event_name: "PreToolUse", cwd: site, lumo_agent: "codex", tool_name: "Write", tool_input: { file_path: `${site}\\main.py` } });
  const api = "C:\\dev\\api-server";
  hook({ hook_event_name: "SessionStart", cwd: api, session_id: "s2" });
  hook({ hook_event_name: "PreToolUse", cwd: api, session_id: "s2", tool_name: "Bash", tool_input: { command: "npm test" } });
  hook({ hook_event_name: "Stop", cwd: api, session_id: "s2", last_assistant_message: "2 files changed, tests green" });
  // The calendar and the email, as their feeds would leave them.
  // After the calendar's own first (empty) look.
  window.setTimeout(() => {
    Calendar.configured = true;
    Calendar.events = [
      { title: "Design review", start: Date.now() + 20 * 60_000, end: Date.now() + 50 * 60_000, allDay: false, location: "" },
      { title: "Sprint planning", start: Date.now() + 18 * 3_600_000, end: Date.now() + 19 * 3_600_000, allDay: false, location: "" },
    ];
    State.notify();
  }, 600);
  State.settings = { ...State.settings, activeIntegrations: [...State.settings.activeIntegrations, "integration_mail"] };
  State.integrations.integration_mail = {
    loaded: true, error: null, configured: true,
    data: { messages: [
      { id: "m1", from: "Ada Lovelace", address: "ada@example.com", subject: "Lunch tomorrow?", preview: "", body: "" },
      { id: "m2", from: "Grace Hopper", address: "grace@example.com", subject: "The talk", preview: "", body: "" },
    ] },
  } as unknown as typeof State.integrations.integration_mail;
}

// A program asking Claude Code about one folder after another, eight at a
// time, with ?background (core/background.ts): 36 of 120 answered, one failed, eight at work.
if (params.has("background")) {
  const folders = ["Zoom", "Slack", "Dropbox", "OneDrive", "Teams", "Figma", "Notion", "Obsidian", "VLC", "GIMP",
    "Blender", "Unity", "Epic Games", "Battle.net", "Origin", "Ubisoft", "WhatsApp", "Telegram", "Signal", "Skype",
    "Opera", "Brave", "Vivaldi", "Firefox", "Thunderbird", "LibreOffice", "Audacity", "OBS", "Postman", "Docker",
    "JetBrains", "Python", "Node", "Git", "PuTTY", "WinRAR", "7-Zip", "Discord", "Steam", "Spotify",
    "NVIDIA Corporation", "Microsoft", "Adobe", "Google", "Logitech"];
  const said = lang === "it"
    ? ["cache: si può eliminare", "dati dell'app: tienili", "log: si possono eliminare", "si ricrea da sola"]
    : ["cache: safe to delete", "the app's data: keep it", "logs: safe to delete", "rebuilt by itself"];
  const bg = (event: string, session: string, extra: Record<string, unknown> = {}) => hook({
    hook_event_name: event, session_id: session, cwd: `C:\\Temp\\easy-uninstaller-ai\\4242-${session}`,
    lumo_background: true, lumo_launcher: "Easy Uninstaller", lumo_batch_total: 120, ...extra,
  });
  const end = (i: number) => i === 12
    ? bg("StopFailure", `q${i}`, { error: "timeout" })
    : bg("Stop", `q${i}`, { last_assistant_message: JSON.stringify({ what: `${folders[i]}: ${said[i % said.length]}`, safe: i % 4 !== 1 }) });
  for (let i = 0; i < folders.length; i++) {
    if (i >= 8) end(i - 8);
    bg("SessionStart", `q${i}`);
    bg("UserPromptSubmit", `q${i}`, { prompt: `Folder: %LOCALAPPDATA%\\${folders[i]}\nSize: 1.2 GB\nWhat is it, and can it be deleted?` });
  }
}

// A short chat.
State.chatHistory = lang === "it" ? [
  { id: 1, role: "user", content: "Aggiungi l'interruttore del nuovo look" },
  { id: 2, role: "assistant", content: "Ho letto le impostazioni: ecco come lo farei." },
] : [
  { id: 1, role: "user", content: "What does `npm test` run in this repo?" },
  { id: 2, role: "assistant", content: "Node's built-in test runner on `tests/**/*.test.mjs`: 54 test files, done in about ten seconds. The TypeScript check is separate: `npx tsc --noEmit`." },
];

const PLAN_MD = lang === "it"
  ? "1. Leggi la pagina delle impostazioni\n2. Aggiungi l'interruttore\n3. Salvalo con gli altri\n4. Esegui i test"
  : "1. Read the settings page\n2. Add the toggle\n3. Save it with the others\n4. Run the tests";

function show(view: IslandViewName, ask = view === "approval") {
  // ?ask=plan: Claude Code asks to start its plan; ?ask=chatplan: the island's own chat asks.
  const askPlan = params.get("ask");
  if (askPlan && !State.pendingApproval) {
    const chat = askPlan === "chatplan";
    if (chat) State.settings = { ...State.settings, chatProvider: "claude-code" } as typeof State.settings;
    hook({ hook_event_name: "PermissionRequest", cwd, request_id: "rp", tool_name: "ExitPlanMode", tool_input: { plan: PLAN_MD }, ...(chat ? { lumo_island: true } : {}) });
    island.holdOpen();
    State.notify();
    sync();
    return;
  }
  if (ask && !State.pendingApproval) {
    hook({ hook_event_name: "PermissionRequest", cwd, request_id: "r1", tool_name: "Bash", tool_input: { command: "npm test", description: "Run the test suite" } });
    // As Claude Code offers it (session_rules.rs), so the line under the buttons shows.
    if (State.pendingApproval) State.pendingApproval.sessionAllow = true;
  }
  island.setView(view);
  if (view === "tools") window.setTimeout(sampleTools, 300);
  island.holdOpen();
  State.notify();
  sync();
}

// Three tools, as Rust would list them (tools.rs), after its own (empty) answer.
function sampleTools() {
  const tool = (id: string, name: string, description: string, permissions: string[], enabled: boolean, verdict: "ok" | "caution") => ({
    id, name, description, entry: "main.py", args: [], params: [], permissions, enabled, timeout: 60, created: 0, updated: 0,
    dir: "", files: ["main.py"], missing: false, reviewed: true, review: { verdict, summary: description, risks: [], undeclared: [], model: "claude-opus-5-5", at: 0 },
  });
  State.tools = [
    tool("bench", "PC Benchmark", "Measures CPU, RAM and disk", ["read", "system"], true, "ok"),
    tool("sales", "Sales report", "Yesterday's sales from your server", ["network"], true, "ok"),
    tool("clean", "Downloads cleanup", "Moves old files away", ["write"], false, "caution"),
  ] as unknown as typeof State.tools;
  State.notify();
}

const bar = document.getElementById("bar")!;
const views: [IslandViewName, string][] = [["overview", "Sessions"], ["approval", "Permission"], ["prompt", "Chat"], ["tools", "Tools"], ["upload", "Drop"]];
const buttons = new Map<string, HTMLButtonElement>();
for (const [view, label] of views) {
  const b = document.createElement("button");
  b.textContent = label;
  b.onclick = () => show(view);
  bar.append(b);
  buttons.set(view, b);
}
// A request folded away: the list shows it on top.
const waitBtn = document.createElement("button");
waitBtn.textContent = "Waiting";
waitBtn.onclick = () => show("overview", true);
bar.append(waitBtn);
const closeBtn = document.createElement("button");
closeBtn.textContent = "Close";
closeBtn.onclick = () => island.collapse();
bar.append(closeBtn);

function sync() {
  for (const [view, b] of buttons) b.classList.toggle("on", State.view === view);
}

show((params.get("view") as IslandViewName | null) ?? "overview", params.has("wait") || params.get("view") === "approval");
