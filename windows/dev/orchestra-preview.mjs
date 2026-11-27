// Screenshots of the projects (views/orchestra.ts, views/projects.ts) in the
// island preview, for review against the concepts (modalita-orchestratore v2,
// progetti v2): an Italian project comparing three rental contracts, a
// coordinator and three threads, with its plan, messages between members, a
// decision card, a file kept from a second writer, a queued message and files
// handed over; then the empty chat's Projects card, the list, New project's
// form and its menus, the gear and the project's settings, a paused thread.
//
// With `npm run dev` running: node dev/orchestra-preview.mjs [out folder]

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const OUT = process.argv[2] ?? "orchestra-shots";
const URL = "http://127.0.0.1:1420/dev/look-preview.html?lang=it&idle&view=prompt";
const W = 900;
const H = 600;
mkdirSync(OUT, { recursive: true });

const now = Date.now();
const min = 60_000;
const LM = { provider: "lmstudio", model: "gemma-4-26b-a4b", effort: "medium" };
const OPUS = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };

const msg = (id, kind, from, text, extra = {}) => ({ id, at: now - (extra.ago ?? 0) * min, kind, from, text, ...extra });

const verdiCard = {
  question: "La clausola 9 aggiorna il canone al 100% dell'indice ISTAT (di solito è il 75%). La segno come clausola strana?",
  options: [
    { label: "Sì, segnala", consequence: "Finisce nel resoconto tra le clausole da rivedere." },
    { label: "No, è normale", consequence: "La riporta senza segnalarla." },
  ],
  recommended: 0,
};

const SNAP = {
  id: "o1",
  title: "Contratti di affitto",
  created: now - 12 * min,
  updated: now,
  icon: "house",
  color: "#f5b942",
  goal: "Confrontare i contratti di affitto nella cartella Contratti (durata, canone, penali, clausole strane) e dire quale conviene. Ogni contratto ha il suo resoconto in Markdown.",
  folder: "C:\\Users\\Riccardo\\Documenti\\Contratti",
  resume: true,
  threadPick: LM,
  plan: [
    { step: "Estrarre i dati di corso Italia 3", status: "completed" },
    { step: "Estrarre i dati di via Roma 12 e tenere il riepilogo", status: "in_progress" },
    { step: "Estrarre i dati di via Verdi 7", status: "in_progress" },
    { step: "Confrontare i tre e scegliere", status: "pending" },
  ],
  locks: [{ path: "Contratti/riepilogo.csv", member: "t1" }],
  coordinator: {
    id: "coordinator", chat: "orch-o1-m-coordinator", title: "Coordinatore", task: "", pick: OPUS,
    state: "working", activity: { kind: "talk", detail: "Via Roma 12" }, plan: [], queued: 1,
    messages: [
      msg("c1", "user", "user", "Confronta i 3 contratti di affitto nella cartella Contratti: durata, canone, penali e clausole strane. Poi dimmi quale conviene.", { ago: 12 }),
      msg("c2", "assistant", "coordinator", "Ecco il piano: un thread per contratto; poi li confronto io e ti dico quale conviene.", { ago: 12 }),
      msg("c3", "note", "t1", "Via Roma 12", { note: "started", ago: 11 }),
      msg("c4", "note", "t2", "Corso Italia 3", { note: "started", ago: 11 }),
      msg("c5", "note", "t3", "Via Verdi 7", { note: "started", ago: 11 }),
      msg("c6", "relay", "t2", "4+4 anni, 950 €/mese, deposito 2 mensilità, penale di 3 mensilità, nessuna clausola strana.", { ago: 4 }),
      msg("c7", "file", "t2", "", { file: { path: "Contratti/corso-italia-3.md", name: "corso-italia-3.md", markdown: true }, ago: 4 }),
      msg("c8", "file", "t2", "", { file: { path: "Contratti/corso-italia-3.csv", name: "corso-italia-3.csv", markdown: false }, ago: 4 }),
      msg("c9", "note", "t3", "Contratti/riepilogo.csv", { note: "lock", holder: "t1", ago: 2 }),
      msg("c10", "relay", "coordinator", "Il riepilogo lo tieni tu: aggiungi anche la riga di via Verdi 7 quando te la manda.", { to: "t1", ago: 2 }),
      msg("c11", "card", "t3", "", { card: verdiCard, ago: 1 }),
      msg("c12", "user", "user", "Per via Verdi guarda soprattutto le spese condominiali", { delivered: "queued", ago: 0 }),
    ],
  },
  threads: [
    {
      id: "t1", chat: "orch-o1-m-t1", title: "Via Roma 12", task: "Estrai i dati di via Roma 12 e tieni il riepilogo.", pick: LM,
      state: "working", activity: { kind: "read", detail: "via-roma-12.pdf" }, queued: 0,
      plan: [
        { step: "Leggere il PDF", status: "completed" },
        { step: "Estrarre canone e durata", status: "completed" },
        { step: "Cercare le penali", status: "in_progress" },
        { step: "Aggiornare il riepilogo", status: "pending" },
      ],
      messages: [
        msg("r1", "relay", "coordinator", "Leggi `Contratti/via-roma-12.pdf` ed estrai durata, canone, deposito, penali e clausole insolite, con le pagine. Tieni tu `Contratti/riepilogo.csv`.", { ago: 11 }),
        msg("r2", "assistant", "t1", "Il PDF ha 9 pagine: durata 3+2 anni, canone 820 €/mese, deposito 3 mensilità.", { ago: 6 }),
        msg("r3", "relay", "t3", "Riga per `riepilogo.csv`: via Verdi 7; 4+4; 880; deposito 2 mensilità; clausola ISTAT 9.", { ago: 1, delivered: "mid-turn" }),
        msg("r4", "relay", "coordinator", "Il riepilogo lo tieni tu: aggiungi anche la riga di via Verdi 7 quando te la manda.", { ago: 2 }),
      ],
    },
    {
      id: "t2", chat: "orch-o1-m-t2", title: "Corso Italia 3", task: "Estrai i dati di corso Italia 3.", pick: LM,
      state: "done", activity: null, queued: 0,
      messages: [
        msg("i1", "relay", "coordinator", "Leggi `Contratti/corso-italia-3.pdf` ed estrai i dati, poi mandameli.", { ago: 11 }),
        msg("i1b", "file", "t2", "", { file: { path: "Contratti/corso-italia-3.md", name: "corso-italia-3.md", markdown: true }, ago: 4 }),
        msg("i2", "assistant", "t2", "Fatto: 4+4 anni, 950 €/mese, nessuna clausola strana. Il resoconto completo è qui: corso-italia-3.md", { ago: 4 }),
        msg("i3", "relay", "t2", "4+4 anni, 950 €/mese, deposito 2 mensilità, penale di 3 mensilità, nessuna clausola strana.", { to: "coordinator", ago: 4 }),
      ],
    },
    {
      id: "t3", chat: "orch-o1-m-t3", title: "Via Verdi 7", task: "Estrai i dati di via Verdi 7.", pick: LM,
      state: "waiting", activity: null, queued: 0,
      messages: [
        msg("v1", "relay", "coordinator", "Leggi `Contratti/via-verdi-7.pdf` ed estrai durata, canone, deposito, penali e clausole insolite, con le pagine. Se una clausola è dubbia chiedi all'utente.", { ago: 11 }),
        msg("v2", "assistant", "t3", "Ho letto le 14 pagine. Aggiungo la mia riga al riepilogo.", { ago: 3 }),
        msg("v3", "note", "t3", "Contratti/riepilogo.csv", { note: "lock", holder: "t1", ago: 2 }),
        msg("v4", "relay", "t3", "Riga per `riepilogo.csv`: via Verdi 7; 4+4; 880; deposito 2 mensilità; clausola ISTAT 9.", { to: "t1", ago: 1 }),
        msg("v5", "user", "user", "Controlla anche se c'è la cedolare secca, mi interessa.", { delivered: "mid-turn", ago: 1 }),
        msg("v6", "assistant", "t3", "C'è, a pagina 3: con la cedolare secca il canone non si aggiorna all'ISTAT. Prima di chiudere il resoconto ti chiedo una cosa.", { ago: 1 }),
        msg("c11", "card", "t3", "", { card: verdiCard, ago: 1 }),
      ],
    },
  ],
};

const REPORT = `# Corso Italia 3

**Contratto di locazione** · 4+4 anni

## In breve

Canone di **950 €/mese**, deposito di 2 mensilità, penale di 3 mensilità per il recesso nei primi 2 anni. Nessuna clausola strana.

## I numeri

| Voce | Valore | Pagina |
| --- | --- | --- |
| Durata | 4+4 anni | 1 |
| Canone | 950 €/mese | 2 |
| Deposito | 2 mensilità | 2 |
| Penale | 3 mensilità | 5 |

## Da rivedere

- L'aggiornamento ISTAT è al 75%, come di solito.
- Le spese condominiali sono a parte, circa 60 €/mese.
`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W + 80, height: H + 60 }, deviceScaleFactor: 2 });
await ctx.addInitScript(([snap, report]) => {
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__orchestraSnap = snap;
  const models = {
    anthropic: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5", reasoning: ["low", "medium", "high", "max"] },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", reasoning: ["low", "medium", "high"] },
    ],
    lmstudio: [{ id: "gemma-4-26b-a4b", label: "gemma-4-26b-a4b" }, { id: "qwen3.5-35b-a3b", label: "qwen3.5-35b-a3b" }],
    google: [{ id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" }],
  };
  window.__lumoMock = {
    chat_providers: () => ["anthropic", "claude-code", "antigravity-cli", "codex", "google", "lmstudio"],
    chat_models: ({ provider }) => models[provider] ?? [],
    secret_present: () => true,
    local_caps: () => ({ vision: false, tools: true, reasoning: ["low", "medium", "high"], maxContext: 262144, loadedContext: 65536 }),
    local_loaded_of: () => [],
    orchestra_list: () => [
      { id: snap.id, title: snap.title, icon: "house", color: "#f5b942", goal: "Confrontare i 3 contratti di affitto e scegliere quale conviene.", updated: snap.updated, state: "waiting", working: 2, asking: "t3", planDone: 1, planTotal: 4, coordinator: snap.coordinator.pick, thread: snap.threadPick },
      { id: "o2", title: "Lumo", icon: "code", color: "#a78bfa", goal: "Modificare e aggiungere nuove feature alla repository, sempre con un concept e le foto prima.", updated: snap.updated - 5 * 60_000, state: "working", working: 2, asking: "", planDone: 3, planTotal: 5, coordinator: { provider: "claude-code", model: "opus", effort: "high" }, thread: { provider: "claude-code", model: "opus", effort: "medium" } },
      { id: "o0", title: "Traduzione del sito", icon: "globe", color: "#60a5fa", goal: "Tradurre il sito in inglese, tedesco e spagnolo, tenendo i termini del glossario.", updated: snap.updated - 26 * 3_600_000, state: "done", working: 0, asking: "", planDone: 3, planTotal: 3, coordinator: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "" }, thread: { provider: "google", model: "gemini-3.8-flash", effort: "" } },
      { id: "o-1", title: "Pulizia della cartella Download", icon: "broom", color: "#4ade80", goal: "Mettere in ordine Download: doppioni, installer vecchi, foto in Immagini.", updated: snap.updated - 4 * 86_400_000, state: "stopped", working: 0, asking: "", planDone: 1, planTotal: 4, coordinator: snap.threadPick, thread: snap.threadPick },
    ],
    pick_folder: () => "C:\\Users\\Riccardo\\Progetti\\Lumo",
    github_repo_names: () => [
      { name: "Rccrd12/Lumo", private: false, description: "Lumo for Windows" },
      { name: "Rccrd12/contratti", private: true, description: "I contratti di casa" },
      { name: "Rccrd12/sito", private: false, description: "Il sito personale" },
      { name: "Rccrd12/maya", private: true, description: "" },
    ],
    orchestra_open: () => structuredClone(snap),
    orchestra_set_pick: ({ member, pick }) => {
      const m = member === "coordinator" ? snap.coordinator : snap.threads.find((x) => x.id === member);
      m.pick = pick;
      return structuredClone(snap);
    },
    orchestra_read_file: ({ path }) => ({ name: path.split("/").pop(), path, text: report }),
    chat_file_find: ({ names }) => names.map((n) => (n === "corso-italia-3.md" ? { path: "Contratti/corso-italia-3.md", folder: false } : null)),
  };
}, [SNAP, REPORT]);

const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGEERR", e.message));
page.on("console", (m) => {
  if (m.type() === "error") console.error("console:", m.text());
});
await page.goto(URL);
await page.waitForTimeout(1200);
await page.addStyleTag({ content: "#bar{display:none!important} html,body{background:#151517!important}" });
await page.evaluate(([w, h, picks]) => {
  const { State, island } = window;
  State.settings = {
    ...State.settings,
    chatProvider: "anthropic",
    lmstudioUrl: "http://127.0.0.1:1234",
    orchestraMode: true,
    chatShowUsage: true,
    orchestraCoordinator: picks.OPUS,
    orchestraThread: picks.LM,
    islandSizes: { chat: { width: w, height: h } },
    islandHeight: h,
  };
  island.applySettings();
  State.notify();
}, [W, H, { OPUS, LM }]);
await page.waitForTimeout(800);

const emit = (event, payload) => page.evaluate(([e, p]) => window.__lumoListeners.get(e)?.({ event: e, id: 0, payload: p }), [event, payload]);
const shot = async (name) => {
  await page.mouse.move(5, 5);
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 0, y: 0, width: W + 80, height: H + 40 } });
  console.log(`${OUT}/${name}.png`);
};
const member = (id) => page.click(`.orc-item[data-member="${id}"]`);

// How full each member's context is (chat_usage.rs, the chat-usage event, by the member's chat).
await emit("chat-usage", { provider: "anthropic", context: { chat: "orch-o1-m-coordinator", used: 38_400, total: 200_000 }, tokens: { remaining: 410_000, limit: 450_000 } });
await emit("chat-usage", { provider: "lmstudio", context: { chat: "orch-o1-m-t1", used: 21_800, total: 32_768 } });

// 1. The coordinator: its plan, who holds which files, a thread's report and files, a lock, a card, a queued message.
await page.evaluate(() => {
  document.querySelector(".orc-log").scrollTop = 0;
});
await shot("1-coordinatore");
await page.evaluate(() => {
  const log = document.querySelector(".orc-log");
  log.scrollTop = log.scrollHeight;
});
await shot("1b-coordinatore-fine");

// 2. A thread waiting for the user: its task, a lock, a message to another thread, a card.
await member("t3");
await shot("2-thread-aspetta-te");
// The same card with the mouse on its second choice: the whole row lights up, with the return arrow.
{
  const opt = page.locator(".orc-opt").nth(1);
  await opt.scrollIntoViewIfNeeded();
  const box = await opt.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/2b-card-scelta-sotto-il-mouse.png`, clip: { x: 0, y: 0, width: W + 80, height: H + 40 } });
  console.log(`${OUT}/2b-card-scelta-sotto-il-mouse.png`);
}

// 3. A thread at work: the answer streaming in, what it is doing.
await member("t1");
await emit("chat-delta", { chat: "orch-o1-m-t1", text: "Ho trovato le penali a pagina 6: **6 mesi di preavviso**, nessuna penale dopo il primo anno. Ora aggiungo al riepilogo la riga di via Verdi 7" });
await emit("chat-activity", { chat: "orch-o1-m-t1", activity: { kind: "edit", detail: "riepilogo.csv" } });
await shot("3-thread-al-lavoro");
await member("t2");
await page.waitForTimeout(500);
await shot("3d-thread-file-sotto-la-risposta");
await member("t1");
await page.waitForTimeout(300);
// The list opens over the conversation, scrolled to its end.
await page.evaluate(() => { const l = document.querySelector(".orc-log"); l.scrollTop = l.scrollHeight; });
await page.click(".orc-plan-btn");
await page.waitForTimeout(300);
await shot("3e-lista-aperta");
await page.click(".orc-plan-btn");
await page.waitForTimeout(200);
// A message from the coordinator, unfolded by a click on who it is from.
await page.evaluate(() => document.querySelector(".orc-from").click());
await page.waitForTimeout(250);
await shot("3a-messaggio-aperto");
await page.evaluate(() => document.querySelector(".orc-from").click());
// Its own model and effort, from the model button.
await page.click(".model-btn");
await page.waitForTimeout(500);
await shot("3c-modello-del-thread");
await page.keyboard.press("Escape");
await page.evaluate(() => document.querySelector(".orc-model-pop") && document.querySelector(".model-btn").click());
// Its context, from the ring by the model button.
await page.click(".chat-usage", { force: true });
await shot("3b-contesto-del-thread");
await page.click(".chat-usage", { force: true });

// 4. A Markdown file handed over, open beside the chat.
await member("coordinator");
await page.click(".orc-fcard");
await page.waitForTimeout(400);
await shot("4-report-aperto");
await page.click(".orc-doc-x");

// 5. The other projects, from the rail's title.
await page.click(".orc-top");
await page.waitForTimeout(300);
await shot("5-progetti-dal-menu");
await page.click(".orc-top");

// 6. The gear beside Stop all opens the project's settings in place of the conversation.
await page.click(".pj-gear");
await page.waitForTimeout(500);
await shot("6-impostazioni-progetto");
// Its environment: the user's GitHub repositories, from a search.
await page.click(".pj-repo-add");
await page.waitForTimeout(400);
await shot("6b-ambiente-scegli-repo");
await page.click('.pj-repo-opt[data-repo="Rccrd12/contratti"]');
await page.waitForTimeout(300);
await shot("6c-ambiente-con-repo");
await page.click(".pj-gear");
await page.waitForTimeout(300);

// 8. A thread paused by a usage limit: when it goes on.
await page.evaluate(() => {
  const s = structuredClone(window.__orchestraSnap);
  for (const m of [s.coordinator, ...s.threads]) for (const x of m.messages) if (x.card) x.card.chose = 0;
  const until = Math.floor(Date.now() / 1000) + 95 * 60;
  s.threads[2].state = "paused";
  s.threads[2].resumeAt = until;
  s.threads[2].messages.push({ id: "v9", at: Date.now(), kind: "note", from: "t3", text: "You've hit your usage limit. Try again later.", note: "limit", until });
  window.__lumoListeners.get("orchestra-update")?.({ event: "orchestra-update", id: 0, payload: s });
});
await member("t3");
await page.waitForTimeout(400);
await page.evaluate(() => {
  const log = document.querySelector(".orc-log");
  log.scrollTop = log.scrollHeight;
});
await shot("8-thread-in-pausa");

// 9. All the projects, from the menu.
await page.evaluate(() => {
  window.island.holdOpen();
  document.querySelector(".orc-top").click();
  [...document.querySelectorAll(".orc-menu-foot")].at(-2).click();
});
await page.waitForTimeout(600);
await shot("9-tutti-i-progetti");

// 10. New project, its icon, its two models.
await page.evaluate(() => document.querySelector(".pj-new").click());
await page.waitForTimeout(500);
await shot("10-nuovo-progetto");
await page.fill(".pj-name-input", "Lumo");
await page.fill(".pj-area", "Modificare e aggiungere nuove feature o fare miglioramenti in generale alla repository. L'importante è fare sempre dei concept con le modifiche o aggiunte che si vogliono fare, se possibile con foto.");
await page.click(".pj-mark-btn");
await page.waitForTimeout(300);
await page.click('.pj-icon[data-icon="code"]');
await page.click('.pj-color[data-color="#a78bfa"]');
await shot("10b-icona");
await page.click(".pj-mark-btn");
await page.click(".pj-folder");
await page.waitForTimeout(300);
await page.click(".pj-coord");
await page.waitForTimeout(700);
await shot("10c-modello-coordinatore");
await page.click(".pj-thread");
await page.waitForTimeout(700);
await shot("10d-modello-thread");
await page.click(".pj-h");

// Back to the project: Cancel, then its card.
await page.evaluate(() => {
  [...document.querySelectorAll(".pj-b")].find((b) => !b.classList.contains("primary") && !b.classList.contains("danger")).click();
});
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector(".pj-card").click());
await page.waitForTimeout(600);

// 7. The island at its usual width: the rail gives up some room.
await page.evaluate(() => {
  const { State, island } = window;
  State.settings = { ...State.settings, islandSizes: { chat: { width: 640, height: 520 } }, islandHeight: 520 };
  island.applySettings();
  State.notify();
});
await page.waitForTimeout(700);
await member("t3");
await shot("7-isola-stretta");

// 7b. The closed island: a thread waits for the user; then only work; then finished.
const closed = async (name, change) => {
  await page.evaluate(([c]) => {
    const { State } = window;
    const s = structuredClone(window.__orchestraSnap);
    eval(c)(s);
    window.__lumoListeners.get("orchestra-update")?.({ event: "orchestra-update", id: 0, payload: s });
    window.island.collapse();
    State.notify();
  }, [change]);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 0, y: 0, width: W + 80, height: 140 } });
  console.log(`${OUT}/${name}.png`);
};
await closed("7b-isola-chiusa-aspetta", "(s) => s");
await closed("7c-isola-chiusa-lavoro", "(s) => { for (const m of [s.coordinator, ...s.threads]) for (const x of m.messages) if (x.card) x.card.chose = 0; }");
await closed("7d-isola-chiusa-finito", `(s) => { for (const m of [s.coordinator, ...s.threads]) { m.state = "idle"; for (const x of m.messages) if (x.card) x.card.chose = 0; } s.coordinator.messages.push({ id: "z9", at: Date.now(), kind: "assistant", from: "coordinator", text: "Conviene **via Roma 12**: canone più basso e nessuna penale dopo il primo anno." }); }`);
await page.evaluate(() => { window.island.holdOpen(); window.State.mode = "expanded"; window.State.notify(); });
await page.waitForTimeout(600);

// 11. Back to a new chat: the Projects card under the three ways to start.
await page.evaluate(() => document.querySelector(".chat-tools .tool-btn").click());
await page.waitForTimeout(700);
await shot("11-chat-nuova-progetti");

await browser.close();
