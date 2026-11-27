// Screenshots of the orchestra (views/orchestra.ts) in the island preview,
// for review against the concept (modalita-orchestratore v2): an Italian
// orchestra comparing three rental contracts, a coordinator and three
// threads, with its plan, messages between members, a decision card, a
// file kept from a second writer, a queued message and files handed over.
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
  plan: [
    { step: "Estrarre i dati di corso Italia 3", status: "completed" },
    { step: "Estrarre i dati di via Roma 12 e tenere il riepilogo", status: "in_progress" },
    { step: "Estrarre i dati di via Verdi 7", status: "in_progress" },
    { step: "Confrontare i tre e scegliere", status: "pending" },
  ],
  locks: [{ path: "Contratti/riepilogo.csv", member: "t1" }],
  coordinator: {
    id: "coordinator", chat: "orc-o1-coordinator", title: "Coordinatore", task: "", pick: OPUS,
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
      id: "t1", chat: "orc-o1-t1", title: "Via Roma 12", task: "Estrai i dati di via Roma 12 e tieni il riepilogo.", pick: LM,
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
      id: "t2", chat: "orc-o1-t2", title: "Corso Italia 3", task: "Estrai i dati di corso Italia 3.", pick: LM,
      state: "done", activity: null, queued: 0,
      messages: [
        msg("i1", "relay", "coordinator", "Leggi `Contratti/corso-italia-3.pdf` ed estrai i dati, poi mandameli.", { ago: 11 }),
        msg("i2", "assistant", "t2", "Fatto: 4+4 anni, 950 €/mese, nessuna clausola strana.", { ago: 4 }),
        msg("i3", "relay", "t2", "4+4 anni, 950 €/mese, deposito 2 mensilità, penale di 3 mensilità, nessuna clausola strana.", { to: "coordinator", ago: 4 }),
      ],
    },
    {
      id: "t3", chat: "orc-o1-t3", title: "Via Verdi 7", task: "Estrai i dati di via Verdi 7.", pick: LM,
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
      { id: snap.id, title: snap.title, updated: snap.updated, working: true },
      { id: "o0", title: "Traduzione del sito in tre lingue", updated: snap.updated - 26 * 3_600_000, working: false },
      { id: "o-1", title: "Pulizia della cartella Download", updated: snap.updated - 4 * 86_400_000, working: false },
    ],
    orchestra_open: () => structuredClone(snap),
    orchestra_read_file: ({ path }) => ({ name: path.split("/").pop(), path, text: report }),
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

// 3. A thread at work: the answer streaming in, what it is doing.
await member("t1");
await emit("chat-delta", { chat: "orc-o1-t1", text: "Ho trovato le penali a pagina 6: **6 mesi di preavviso**, nessuna penale dopo il primo anno. Ora aggiungo al riepilogo la riga di via Verdi 7" });
await emit("chat-activity", { chat: "orc-o1-t1", activity: { kind: "edit", detail: "riepilogo.csv" } });
await shot("3-thread-al-lavoro");

// 4. A Markdown file handed over, open beside the chat.
await member("coordinator");
await page.click(".orc-fcard");
await page.waitForTimeout(400);
await shot("4-report-aperto");
await page.click(".orc-doc-x");

// 5. The past orchestras, from the rail's title.
await page.click(".orc-top");
await page.waitForTimeout(300);
await shot("5-orchestre");
await page.click(".orc-top");

// 6. The model picker: Orchestra chosen, its two roles.
await page.click(".model-btn");
await page.waitForTimeout(900);
await shot("6-scelta-modelli");
// 6b. The coordinator's model, chosen among the providers that may take the role.
await page.click(".orch-pick");
await page.waitForTimeout(600);
await shot("6b-modello-coordinatore");

// The picker closes as it opened.
await page.click(".model-btn");
await page.waitForTimeout(300);

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

// 8. A new orchestra: empty until the first message starts it.
// Clicked from the page, the pointer staying where it is: a new orchestra
// changes the island's size and must not read as the pointer leaving.
await page.evaluate(() => {
  window.island.holdOpen();
  document.querySelector(".orc-top").click();
  document.querySelector(".orc-menu-new").click();
});
await page.waitForTimeout(500);
await shot("8-nuova-orchestra");

await browser.close();
