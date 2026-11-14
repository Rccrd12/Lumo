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
import type { ComputerState } from "../src/core/computer-use";

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

// An order's email as a shop draws it: a table 600 px wide, its pictures on its site.
function shopHtml(it: boolean): string {
  const img = (name: string, w: number, hh: number, style = "") => `<img src="https://img.libreria-aurora.example/${name}.png" width="${w}" height="${hh}" alt="" style="display:block;${style}">`;
  const tr = (en: string, itText: string) => (it ? itText : en);
  return `<table width="600" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;color:#1f2a44;background:#fff">
<tr><td style="padding:22px 28px">${img("logo", 180, 40)}</td></tr>
<tr><td>${img("hero", 600, 170)}</td></tr>
<tr><td style="padding:24px 28px 8px;font-size:15px;line-height:1.5">${tr("Hi Riccardo,<br>your parcel left our warehouse in Bologna and arrives on <b>Friday 14 November</b>.", "Ciao Riccardo,<br>il tuo pacco è partito dal nostro magazzino di Bologna e arriverà <b>venerdì 14 novembre</b>.")}</td></tr>
<tr><td style="padding:14px 28px"><a href="https://libreria-aurora.example/ordini/48213/traccia?utm_source=email&utm_campaign=shipped" style="display:inline-block;background:#e8743b;color:#fff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 26px;border-radius:8px">${tr("Track your parcel", "Segui la spedizione")}</a></td></tr>
<tr><td style="padding:14px 28px"><table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e6e8ee;border-radius:10px"><tr>
<td width="96" style="padding:14px">${img("book", 80, 116, "border-radius:4px")}</td>
<td style="padding:14px 14px 14px 0;font-size:14px;line-height:1.5"><b>Il nome della rosa</b><br><span style="color:#6b7385">Umberto Eco</span><br><span style="color:#6b7385">${tr("Quantity: 1", "Quantità: 1")}</span></td>
<td align="right" style="padding:14px;font-size:15px;font-weight:700;white-space:nowrap">14,90 €</td></tr></table></td></tr>
<tr><td style="padding:6px 28px 4px"><table width="100%" style="font-size:14px;color:#6b7385"><tr><td>${tr("Shipping", "Spedizione")}</td><td align="right">3,90 €</td></tr><tr><td style="color:#1f2a44;font-weight:700;padding-top:6px">${tr("Total", "Totale")}</td><td align="right" style="color:#1f2a44;font-weight:700;padding-top:6px">18,80 €</td></tr></table></td></tr>
<tr><td style="padding:22px 28px;font-size:12px;color:#9aa1b0;line-height:1.5;border-top:1px solid #eef0f3">${tr("Questions?", "Hai domande?")} <a href="https://libreria-aurora.example/aiuto" style="color:#3b4f7d">${tr("Get help", "Visita l'assistenza")}</a><br>Libreria Aurora · Via dei Libri 12, Bologna</td></tr>
</table><img src="https://track.libreria-aurora.example/open.gif?u=48213" width="1" height="1" alt="">`;
}

// The shop's pictures, drawn here as Rust's web_image would hand them over (PNG bytes).
async function pictureFor(url: string): Promise<ArrayBuffer> {
  const name = url.split("/").pop()?.replace(".png", "") ?? "";
  const size: Record<string, [number, number]> = { logo: [360, 80], hero: [1200, 340], book: [160, 232] };
  const [w, hh] = size[name] ?? [2, 2];
  const c = document.createElement("canvas");
  c.width = w;
  c.height = hh;
  const g = c.getContext("2d")!;
  if (name === "logo") {
    g.fillStyle = "#fff"; g.fillRect(0, 0, w, hh);
    g.fillStyle = "#e8743b"; g.beginPath(); g.arc(40, 40, 26, 0, 7); g.fill();
    g.fillStyle = "#fff"; g.beginPath(); g.arc(40, 40, 12, 0, 7); g.fill();
    g.fillStyle = "#1f2a44"; g.font = "40px Georgia, serif"; g.fillText("Libreria Aurora", 84, 54);
  } else if (name === "hero") {
    const grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, "#1f2a44"); grad.addColorStop(1, "#3b4f7d");
    g.fillStyle = grad; g.fillRect(0, 0, w, hh);
    g.fillStyle = "#e8743b"; g.fillRect(840, 76, 124, 188);
    g.fillStyle = "#c8913f"; g.fillRect(992, 192, 116, 52);
    g.fillStyle = "#fff"; g.font = "bold 56px Arial"; g.fillText(url.includes("hero") ? "Il tuo pacco è partito!" : "", 80, 156);
    g.fillStyle = "#c9d3ea"; g.font = "30px Arial"; g.fillText("Arriva venerdì 14 novembre", 80, 220);
  } else if (name === "book") {
    g.fillStyle = "#7a2e2e"; g.fillRect(0, 0, w, hh);
    g.fillStyle = "#e9c46a"; g.fillRect(16, 28, 128, 4);
    g.fillStyle = "#f5e6c8"; g.font = "22px Georgia, serif"; g.textAlign = "center";
    g.fillText("Il nome", 80, 104); g.fillText("della rosa", 80, 132);
    g.fillStyle = "#e9c46a"; g.font = "16px Georgia, serif"; g.fillText("U. ECO", 80, 192);
  }
  const blob = await new Promise<Blob>((done) => c.toBlob((b) => done(b!), "image/png"));
  return blob.arrayBuffer();
}

// The Email view's answer (mail.rs mail_view): three addresses, one of them
// failing with ?mailerror, five with ?mailmany (the row then scrolls); only
// the unread ones, or the recent ones too.
function sampleMail() {
  const it = lang === "it";
  const at = (daysAgo: number, h: number, m: number) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(h, m, 0, 0);
    return d.toString();
  };
  const mail = (id: string, account: string, from: string, address: string, subject: string, preview: string, date: string, unread = true) => ({
    id: `${account}/inbox:${id}`, account, from, address, subject, preview, body: preview, date, unread,
    link: account === "imap:1" ? "https://mail.google.com/mail/u/0/#inbox" : account === "outlook" ? "lumo-outlook:inbox" : undefined,
  });
  const failing = params.has("mailerror");
  const all = [
    mail("9", "imap:1", "Ada Lovelace", "ada@example.com", it ? "Pranzo domani?" : "Lunch tomorrow?", it ? "C'è un posto nuovo vicino all'ufficio, proviamo all'una?" : "There's a new place near the office, want to try it at 1?", at(0, 10, 42)),
    mail("4", "imap:2", "Marco Bianchi", "marco@example.com", it ? "Preventivo sito web" : "Website quote", it ? "Ti allego il preventivo aggiornato con le modifiche." : "Here is the updated quote with the changes.", at(0, 10, 15)),
    mail("1", "outlook", "Giulia Rossi", "giulia@example.com", it ? "Riunione di giovedì" : "Thursday's meeting", it ? "Possiamo spostarla alle 15?" : "Can we move it to 3 pm?", at(0, 9, 58)),
    mail("8", "imap:1", "GitHub", "noreply@github.com", it ? "Lumo: nuova release 0.22.1" : "Lumo: new release 0.22.1", it ? "Una nuova release è stata pubblicata." : "A new release was published.", at(0, 9, 31)),
    mail("7", "imap:1", "Libreria Aurora", "ordini@libreria-aurora.example", it ? "Il tuo ordine è stato spedito" : "Your order has shipped", it ? "Arriverà venerdì. Segui la spedizione: https://libreria-aurora.example/ordini/48213/traccia?utm_source=email&utm_campaign=shipped" : "It arrives on Friday. Track it: https://libreria-aurora.example/orders/48213/track?utm_source=email&utm_campaign=shipped", at(1, 18, 5)),
    mail("2", "outlook", "Luca Verdi", "luca@example.com", it ? "Foto del weekend" : "Weekend photos", it ? "Ecco le foto della gita!" : "Here are the photos from the trip!", at(1, 12, 40)),
    mail("3", "imap:2", "Sara Neri", "sara@example.com", it ? "Re: Bozza contratto" : "Re: Draft contract", it ? "Ho aggiunto i commenti nel documento." : "I added my comments in the document.", at(1, 9, 12), false),
    mail("6", "imap:1", "Spotify", "no-reply@example.com", it ? "La tua playlist della settimana" : "Your weekly playlist", it ? "Nuovi brani scelti per te." : "New songs picked for you.", at(3, 8, 0), false),
  ].filter((m) => !(failing && m.account === "imap:2"));
  (window as unknown as { __lumoMock: Record<string, (args: { unreadOnly: boolean }) => unknown> }).__lumoMock = {
    ...(window as unknown as { __lumoMock?: Record<string, unknown> }).__lumoMock,
    mail_view: ({ unreadOnly }) => ({
      accounts: [
        { key: "imap:1", label: "personale@gmail.com", state: "ok", unread: 3, inbox: "https://mail.google.com/mail/u/0/#inbox" },
        failing
          ? { key: "imap:2", label: "lavoro@studio.it", state: "error", error: it ? "Il server ha rifiutato la password per le app." : "The server refused the app password.", unread: 0 }
          : { key: "imap:2", label: "lavoro@studio.it", state: "ok", unread: 1 },
        { key: "outlook", label: "Outlook", state: "ok", unread: 2, inbox: "lumo-outlook:inbox" },
        ...(params.has("mailmany") ? [
          { key: "imap:3", label: "universita@studenti.it", state: "ok", unread: 0 },
          { key: "imap:4", label: "negozio@esempio.it", state: "ok", unread: 0 },
          { key: "imap:5", label: "famiglia@esempio.it", state: "ok", unread: 0 },
        ] : []),
      ],
      messages: all.filter((m) => !unreadOnly || m.unread),
    }),
    // The shop's email has HTML, its pictures on its own site (shown after Load images).
    mail_html: ({ id }: { id: string }) => ({ html: id === "imap:1/inbox:7" ? shopHtml(it) : "" }),
    web_image: ({ url }: { url: string }) => pictureFor(url),
  } as unknown as Record<string, (args: { unreadOnly: boolean }) => unknown>;
  State.settings = { ...State.settings, activeIntegrations: [...new Set([...State.settings.activeIntegrations, "integration_mail"])] };
}
sampleMail();

// Computer use with a plan, with ?computer=start|step|work|paused|ask|reply|card|recap (card&paused: a card while paused)
// (computer.rs computer-state; main.ts would pass these events on).
const computerScene = params.get("computer");
if (computerScene) await computerPreview(computerScene);

async function computerPreview(scene: string) {
  const it = lang === "it";
  const wait = (ms: number) => new Promise((done) => window.setTimeout(done, ms));
  const texts = it
    ? ["Clic nel testo di Blocco note", "Apro il menu File", "Scelgo «Salva con nome…»", "Scrivo «appunti.txt» e premo Invio", "Controllo che il file sia sul Desktop"]
    : ["Click in Notepad's text", "Open the File menu", "Choose “Save as…”", "Type “notes.txt” and press Enter", "Check the file is on the Desktop"];
  const plan = (done: number, list = texts) => list.map((text, i) => ({ text, status: i < done ? "done" : i === done ? "active" : "pending" } as const));
  const since = Date.now() - 24_000;
  const base = { engaged: true, paused: false, stopped: false, agent: "Claude Code", color: "#d97757", since };
  const state = (extra: Partial<ComputerState>) => island.onComputerState({ ...base, steps: plan(1), ...extra } as ComputerState);
  State.settings = { ...State.settings, chatProvider: "claude-code" } as typeof State.settings;
  if (scene === "recap") return computerRecapChat(it);
  island.setView("prompt");
  island.holdOpen();
  State.notify();
  await wait(300);
  // The plan as it was first shown (start), so a step reveal counts from it.
  state({ steps: plan(0, texts.slice(0, 4)), reveal: "start", revealMs: scene === "start" ? 3000 : 200 });
  island.onComputer(true);
  if (scene === "start") return;
  await wait(500);
  if (scene === "step") return void state({ steps: plan(2), reveal: "step", revealMs: 3000 });
  state({ steps: plan(2) });
  if (scene === "work") return;
  await wait(200);
  if (scene === "card") {
    const c = document.createElement("canvas");
    c.width = 360; c.height = 200;
    const g = c.getContext("2d")!;
    g.fillStyle = "#f3f3f3"; g.fillRect(0, 0, 360, 200);
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, 360, 30);
    g.fillStyle = "#222"; g.font = "13px Segoe UI, sans-serif";
    ["File", it ? "Modifica" : "Edit", it ? "Visualizza" : "View"].forEach((w, i) => g.fillText(w, 12 + i * 62, 20));
    g.fillStyle = "#fff"; g.strokeStyle = "#ccc"; g.fillRect(4, 30, 210, 168); g.strokeRect(4, 30, 210, 168);
    const items = it ? ["Nuovo", "Nuova finestra", "Apri…", "Salva", "Salva con nome…", "Stampa…"] : ["New", "New window", "Open…", "Save", "Save as…", "Print…"];
    items.forEach((w, i) => {
      if (i === 4) { g.fillStyle = "#dbe8f8"; g.fillRect(8, 38 + i * 26, 202, 24); }
      g.fillStyle = "#222"; g.fillText(w, 20, 55 + i * 26);
    });
    const blob = await new Promise<Blob>((done) => c.toBlob((b) => done(b!), "image/png"));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const mocks = window as unknown as { __lumoMock: Record<string, unknown> };
    mocks.__lumoMock = { ...mocks.__lumoMock, computer_peek: () => ({ image: btoa(bin), width: 360, height: 200, at: [80, 152],
      name: it ? "Salva con nome…" : "Save as…", role: it ? "voce di menu" : "menu item", app: it ? "Blocco note" : "Notepad" }) };
    hook({ hook_event_name: "PermissionRequest", cwd, request_id: "rc", tool_name: "mcp__lumo__left_click", tool_input: { coordinate: [207, 236] }, lumo_island: true });
    // ?computer=card&paused: the card waiting while computer use is paused.
    if (params.has("paused")) state({ steps: plan(2), paused: true, awayAt: Date.now() + 552_000 });
    island.holdOpen();
    State.notify();
    return;
  }
  // Paused: it stops by itself if left on (computer.rs AWAY), the banner counts down.
  const awayAt = Date.now() + 552_000;
  state({ steps: plan(2), paused: true, awayAt });
  if (scene === "paused" || scene === "ask") return;
  if (scene === "reply") {
    // The question went (Rust sends it back as `asked`), then the agent's new plan answers it.
    (document.querySelector(".cu-ask") as HTMLButtonElement | null)?.click();
    await wait(200);
    const input = document.querySelector(".cu-input") as HTMLInputElement;
    input.value = it ? "Salvalo in Documenti, non sul Desktop" : "Save it in Documents, not on the Desktop";
    input.dispatchEvent(new Event("input"));
    (document.querySelector(".cu-send") as HTMLButtonElement).click();
    state({ steps: plan(2), paused: true, awayAt, asked: input.value });
    await wait(300);
    const changed = [...texts.slice(0, 4), it ? "Controllo che il file sia in Documenti" : "Check the file is in Documents"];
    changed.splice(3, 0, it ? "Apro la cartella Documenti" : "Open the Documents folder");
    state({ steps: plan(2, changed), paused: true, awayAt, explanation: it
      ? "Va bene: prima di salvare apro la cartella Documenti, e alla fine controllo lì. Riprendi quando vuoi."
      : "Sure: before saving I open the Documents folder, and check there at the end. Resume when you like." });
  }
}

// A chat whose answer used the computer: the recap under it (views/computer-recap.ts).
async function computerRecapChat(it: boolean) {
  const shot = async (hue: number, label: string) => {
    const c = document.createElement("canvas");
    c.width = 160; c.height = 90;
    const g = c.getContext("2d")!;
    g.fillStyle = "#1d6fb8"; g.fillRect(0, 0, 160, 90);
    g.fillStyle = "#fff"; g.fillRect(18, 10, 124, 66);
    g.fillStyle = `hsl(${hue} 60% 92%)`; g.fillRect(18, 10, 124, 10);
    g.fillStyle = "#555"; g.font = "8px sans-serif"; g.fillText(label, 24, 34);
    g.fillStyle = "#202020"; g.fillRect(0, 80, 160, 10);
    const blob = await new Promise<Blob>((done) => c.toBlob((b) => done(b!), "image/png"));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  };
  const steps = it
    ? ["Clic nel testo di Blocco note", "Apro il menu File", "Scelgo «Salva con nome…»", "Scrivo «appunti.txt» e premo Invio", "Controllo che il file sia sul Desktop"]
    : ["Click in Notepad's text", "Open the File menu", "Choose “Save as…”", "Type “notes.txt” and press Enter", "Check the file is on the Desktop"];
  const images = await Promise.all(steps.map((s, i) => shot(200 + i * 30, s.slice(0, 24))));
  const stopped = params.has("stopped");
  State.chatHistory = [
    { id: 1, role: "user", content: it ? "Salva quello che ho scritto in Blocco note come appunti.txt sul Desktop" : "Save what I wrote in Notepad as notes.txt on the Desktop" },
    { id: 2, role: "assistant", content: stopped
      ? (it ? "Mi sono fermato come mi hai chiesto: il file non è ancora salvato." : "I stopped as you asked: the file isn't saved yet.")
      : (it ? "Fatto: **appunti.txt** è sul Desktop, con il testo che avevi scritto." : "Done: **notes.txt** is on the Desktop, with the text you wrote."),
      computer: { agent: "Claude Code", color: "#d97757", actions: stopped ? 5 : 9, ms: stopped ? 21_000 : 48_000, ...(stopped ? { stopped: true } : {}),
        steps: steps.map((text, i) => stopped
          ? { text, status: i < 2 ? "done" : i === 2 ? "active" : "pending", ...(i < 2 ? { image: images[i] } : {}) }
          : { text, status: "done", image: images[i] }) } },
  ] as typeof State.chatHistory;
  island.setView("prompt");
  island.holdOpen();
  State.notify();
}

const bar = document.getElementById("bar")!;
const views: [IslandViewName, string][] = [["overview", "Sessions"], ["approval", "Permission"], ["prompt", "Chat"], ["tools", "Tools"], ["mail", "Email"], ["upload", "Drop"]];
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

if (!computerScene) show((params.get("view") as IslandViewName | null) ?? "overview", params.has("wait") || params.get("view") === "approval");
