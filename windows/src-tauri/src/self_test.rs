// /test in a chat with a local model: Lumo puts the model picked through a
// long run of real questions (answers, tools, files, email, listening, made-up
// tools, pictures, reasoning, Stop…) and writes what happened, scenario by
// scenario, to %LOCALAPPDATA%\com.rccrd12.lumo\local-test-….md.
//
// FOR TESTING ONLY: take it out before the release, with `mod self_test` in
// lib.rs and its two lines in chat.rs (`self_test::is_command`).
//
// Nothing real happens: the workspace tools work on copies of files made for
// the test, in a folder of their own deleted at the end; the email, listening
// and timer tools only answer as they would (nothing is sent, read or set),
// and none of the user's tools is offered, so no permission is ever asked.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::chat::{Chat, ChatReply};
use crate::claude_code::Activity;
use crate::local_chat::Server;
use crate::local_models::Caps;
use crate::local_profile as profile;
use lumo_local::guard::answer_room;
use lumo_local::{Doing, End, Failure, Hooks, Loaded, Outcome};

pub fn is_command(query: &str) -> bool {
    query.trim().eq_ignore_ascii_case("/test")
}

/// The longest a question may take before it counts as stuck.
const TURN_LIMIT: Duration = Duration::from_secs(6 * 60);
/// The mail tools offered, as the Email pill gives them when it may send.
const MAIL: &str = "mail,mailsend";
/// A red square, 32×32, for a model that sees.
const RED_PNG: [u8; 99] = [
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 32, 0, 0, 0, 32, 8, 2, 0, 0, 0, 252, 24, 237, 163, 0, 0, 0, 42, 73, 68, 65, 84, 120,
    218, 99, 184, 35, 34, 66, 83, 196, 48, 106, 193, 168, 5, 163, 22, 140, 90, 48, 106, 193, 168, 5, 163, 22, 140, 90, 48, 106, 193, 168, 5, 163, 22, 12, 21, 11,
    0, 157, 203, 16, 61, 125, 252, 185, 138, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];

const NOTES: &str = "Lista della spesa\nlatte\npane\nuova\nfarina\nzucchero\nil gatto mangia solo crocchette\nmele\npere\nbanane\ncaffè\nfine della lista\n";
const STORY: &str = "Il faro di Punta Nera era spento da anni.\nOgni sera Marta saliva i gradini lo stesso, contava le onde e scendeva.\nUna notte vide una luce sul mare, piccola e ferma.\nNon era una barca, e non era una stella.\nLa mattina dopo trovò sulla spiaggia una lanterna ancora calda.\nDa allora il faro è acceso di nuovo, e nessuno sa chi lo accenda.\n";

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Level {
    Ok,
    Skipped,
    Warn,
    Ko,
}

impl Level {
    fn mark(self) -> &'static str {
        match self {
            Level::Ok => "✅ OK",
            Level::Skipped => "⏭ saltato",
            Level::Warn => "⚠️ avviso",
            Level::Ko => "❌ KO",
        }
    }
}

/// A file made for a scenario, given to the model the way a dropped file is.
#[derive(Clone, Copy)]
enum File {
    None,
    Notes,
    Story,
}

struct Case {
    id: String,
    title: &'static str,
    /// The questions, in order, in one conversation.
    turns: Vec<&'static str>,
    file: File,
    image: bool,
    /// Asked whole from the start (as after a hung stream).
    whole: bool,
    /// The first question is stopped after this long (Stop pressed).
    stop_first: Option<Duration>,
    max_tokens: Option<u64>,
    /// The reasoning level, of Lumo's names; None: the one picked in the chat.
    effort: Option<String>,
    check: fn(&Run) -> Vec<(Level, String)>,
}

impl Case {
    fn new(id: &str, title: &'static str, turns: &[&'static str], check: fn(&Run) -> Vec<(Level, String)>) -> Self {
        Case { id: id.into(), title, turns: turns.to_vec(), file: File::None, image: false, whole: false, stop_first: None, max_tokens: None, effort: None, check }
    }
}

/// A tool call made in a scenario: its name, input, and what went back.
struct Call {
    name: String,
    input: Value,
    answer: String,
}

/// What a scenario did.
#[derive(Default)]
struct Run {
    /// Each question's outcome (Err: what went wrong, said).
    turns: Vec<Result<Outcome, String>>,
    calls: Vec<Call>,
    /// The files in the scenario's workspace at the end: name, text.
    files: Vec<(String, String)>,
    took: Duration,
    /// From the question to the first text of the last answer.
    first_text: Option<Duration>,
    /// The last request's messages, as they were at the end.
    messages: Vec<Value>,
    /// The stopped question ended in time, when one was stopped.
    stopped: Option<bool>,
    original_len: usize,
}

impl Run {
    fn last(&self) -> Option<&Outcome> {
        self.turns.last().and_then(|t| t.as_ref().ok())
    }
    fn answer(&self) -> String {
        self.last().map(Outcome::answer).unwrap_or_default()
    }
    fn lower(&self) -> String {
        self.answer().to_lowercase()
    }
    fn ran(&self, name: &str) -> usize {
        self.calls.iter().filter(|c| c.name == name).count()
    }
    fn ran_any(&self, pred: impl Fn(&str) -> bool) -> bool {
        self.calls.iter().any(|c| pred(&c.name))
    }
    fn file(&self, name: &str) -> Option<&str> {
        self.files.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, t)| t.as_str())
    }
}

/// The app for the test: the tools answer as they would, nothing real happens.
struct TestIsland<'a, P> {
    chat: String,
    workspace: String,
    all: &'a [(String, String, Value)],
    prompt_for: &'a P,
    calls: Vec<Call>,
    started: Instant,
    first_text: Option<Duration>,
}

impl<P: Fn(&[String], bool) -> String + Sync> Hooks for TestIsland<'_, P> {
    fn shown(&mut self, text: &str) {
        if self.first_text.is_none() && !text.is_empty() {
            self.first_text = Some(self.started.elapsed());
        }
    }

    fn doing(&mut self, _: Doing) {}

    fn without_tools(&mut self) -> String {
        (self.prompt_for)(&[], false)
    }

    fn load(&mut self, name: &str, input: &Value, offered: &[String]) -> Option<Loaded> {
        let wanted = if name == profile::MORE {
            profile::asked(self.all, input)
        } else if profile::in_catalog(self.all, offered, name) {
            vec![name.to_string()]
        } else {
            return None;
        };
        let now = profile::loaded(&self.chat, &wanted);
        let tools = profile::pick(self.all, &now);
        Some(Loaded {
            wanted,
            tools: crate::openai_compat::function_tools(&tools),
            names: tools.iter().map(|(id, _, _)| id.clone()).collect(),
            system: (self.prompt_for)(&now, true),
        })
    }

    fn known(&self) -> Vec<String> {
        self.all.iter().map(|(id, _, _)| id.clone()).collect()
    }

    fn call(&mut self, name: &str, input: Value) -> impl std::future::Future<Output = (String, bool)> + Send {
        let (answer, failed) = if crate::workspace::NAMES.contains(&name) {
            let (text, failed, _) = crate::workspace::call(&self.workspace, name, &input);
            (text, failed)
        } else {
            (pretend(name, &input), false)
        };
        self.calls.push(Call { name: name.to_string(), input, answer: answer.clone() });
        async move { (answer, failed) }
    }
}

/// What a tool other than the workspace's would answer, without doing it.
fn pretend(name: &str, input: &Value) -> String {
    match name {
        "set_timer" => format!("Timer set: {input}. It shows on Lumo's island."),
        "listen" | "listen_pull_request" => "Lumo is listening: it tells the user on the island when that changes.".into(),
        "stop_listening" => "Stopped listening.".into(),
        "list_listening" => "Nothing is being listened to.".into(),
        n if n.starts_with("mail_send") || n.contains("draft") || n.contains("reply") || n.contains("forward") => {
            "The email is on Lumo's island for the user to check and send: it isn't sent yet.".into()
        }
        n if n.starts_with("mail") => json!([{
            "id": "m1",
            "from": "Marco Rossi <marco@example.com>",
            "date": "today 18:02",
            "subject": "Cena venerdì",
            "unread": true,
            "text": "Ciao! Venerdì alle 20 da Gino, ci sei? Porto anche Giulia. Marco",
        }])
        .to_string(),
        _ => "Done.".into(),
    }
}

fn cases(caps: &Caps) -> Vec<Case> {
    let mut all = vec![
        Case::new("saluto", "Risposta semplice", &["Ciao! Presentati in una frase."], |r| {
            let mut out = vec![];
            if !r.calls.is_empty() {
                out.push((Level::Warn, format!("ha chiamato strumenti senza motivo: {}", names(r))));
            }
            out
        }),
        Case::new("conto", "Conto senza strumenti", &["Quanto fa 17 × 23? Rispondi solo con il numero."], |r| {
            let mut out = vec![];
            if !r.answer().contains("391") {
                out.push((Level::Ko, "il risultato (391) non c'è".into()));
            }
            if !r.calls.is_empty() {
                out.push((Level::Warn, format!("ha chiamato strumenti senza motivo: {}", names(r))));
            }
            out
        }),
        Case::new("markdown", "Codice in Markdown", &["Scrivimi una funzione Python che inverte una stringa, con un esempio."], |r| {
            let mut out = vec![];
            if !r.answer().contains("```") {
                out.push((Level::Warn, "il codice non è in un blocco ```".into()));
            }
            out
        }),
        Case::new("timer", "Un timer", &["Mettimi un timer di 3 minuti per la pasta."], |r| match r.calls.iter().find(|c| c.name == "set_timer") {
            None => vec![(Level::Ko, "set_timer non chiamato".into())],
            Some(c) if !c.input.to_string().contains('3') && !c.input.to_string().contains("180") => vec![(Level::Warn, format!("durata strana: {}", c.input))],
            _ => vec![],
        }),
        Case::new("tre-timer", "Tre timer insieme", &["Metti tre timer: uno da 1 minuto, uno da 2 e uno da 3."], |r| match r.ran("set_timer") {
            0 => vec![(Level::Ko, "set_timer non chiamato".into())],
            3 => vec![],
            n => vec![(Level::Warn, format!("set_timer chiamato {n} volte invece di 3"))],
        }),
        Case { file: File::Notes, ..Case::new("leggi-file", "Leggere un file", &["Quante righe ha questo file? E cosa dice la settima riga?"], |r| {
            let mut out = vec![];
            if !r.ran_any(|n| n == crate::workspace::READ || n == crate::workspace::SEARCH) {
                out.push((Level::Ko, "il file non è stato letto (né workspace_read né workspace_search)".into()));
            }
            if !r.answer().contains("12") {
                out.push((Level::Warn, "non dice 12 righe".into()));
            }
            if !r.lower().contains("gatto") {
                out.push((Level::Warn, "non riporta la settima riga (gatto)".into()));
            }
            out
        }) },
        Case { file: File::Notes, ..Case::new("modifica-riga", "Cambiare una parola", &["Nel file cambia la parola «gatto» con «cane», solo quella."], |r| {
            let mut out = vec![];
            match r.file("notes.txt") {
                None => out.push((Level::Ko, "la copia di notes.txt non c'è".into())),
                Some(t) if t.contains("gatto") || !t.contains("cane") => out.push((Level::Ko, "nella copia «gatto» non è diventato «cane»".into())),
                Some(t) if t.lines().count() != NOTES.lines().count() => out.push((Level::Warn, format!("la copia ha {} righe invece di {}", t.lines().count(), NOTES.lines().count()))),
                _ => {}
            }
            if r.ran(crate::workspace::WRITE) > 0 && r.ran(crate::workspace::EDIT) == 0 {
                out.push((Level::Warn, "ha riscritto il file intero invece di usare workspace_edit".into()));
            }
            out
        }) },
        Case { file: File::Notes, ..Case::new("aggiungi-riga", "Aggiungere una riga (detto e non fatto?)", &["Aggiungi in fondo al file una riga con scritto «controllato da Lumo»."], |r| {
            match r.file("notes.txt") {
                None => vec![(Level::Ko, "la copia di notes.txt non c'è".into())],
                Some(t) if !t.trim_end().ends_with("controllato da Lumo") => vec![(Level::Ko, "l'ultima riga della copia non è «controllato da Lumo»".into())],
                _ => vec![],
            }
        }) },
        Case { file: File::Story, ..Case::new("riscrittura-lunga", "Riscrivere un file più lungo (il caso che bloccava Gemma)", &["Riscrivi tutto il file in modo più lungo e dettagliato, almeno il doppio."], |r| {
            // Over the copy or in a new file beside it: the longest text counts.
            let longest = r.files.iter().max_by_key(|(_, t)| t.len());
            match longest {
                None => vec![(Level::Ko, "nessun file nella cartella di lavoro".into())],
                Some((name, t)) if t.len() * 2 < r.original_len * 3 => vec![(Level::Ko, format!("il file più lungo ({name}) è di {} caratteri, l'originale {}: non è più lungo di 1,5 volte", t.len(), r.original_len))],
                Some((name, _)) if !name.eq_ignore_ascii_case("racconto.txt") => vec![(Level::Warn, format!("ha scritto la versione lunga in {name} invece di riscrivere racconto.txt"))],
                _ => vec![],
            }
        }) },
        Case::new("crea-e-rileggi", "Due giri di strumenti", &["Crea un file frutti.txt con cinque frutti, uno per riga, poi rileggilo e dimmi qual è il terzo."], |r| {
            let mut out = vec![];
            match r.file("frutti.txt") {
                None => out.push((Level::Ko, "frutti.txt non è stato creato".into())),
                Some(t) if t.lines().filter(|l| !l.trim().is_empty()).count() < 5 => out.push((Level::Warn, "frutti.txt ha meno di cinque righe".into())),
                Some(t) => {
                    let third = t.lines().filter(|l| !l.trim().is_empty()).nth(2).unwrap_or_default().trim().trim_start_matches(|c: char| !c.is_alphabetic()).to_lowercase();
                    if !third.is_empty() && !r.lower().contains(&third) {
                        out.push((Level::Warn, format!("il terzo frutto del file è «{third}», la risposta non lo dice")));
                    }
                }
            }
            if r.ran(crate::workspace::READ) == 0 {
                out.push((Level::Warn, "non l'ha riletto".into()));
            }
            out
        }),
        Case::new("mail-parole", "Email chiesta per nome", &["Ho email nuove? Leggimi l'ultima."], |r| {
            let mut out = vec![];
            if !r.ran_any(|n| n.starts_with("mail")) {
                out.push((Level::Ko, "nessuno strumento email chiamato".into()));
            } else if !r.lower().contains("marco") && !r.lower().contains("gino") {
                out.push((Level::Warn, "la risposta non riporta la mail (Marco, Gino)".into()));
            }
            out
        }),
        Case::new("mail-catalogo", "Email dal catalogo, senza dire «mail»", &["Marco mi ha scritto qualcosa per venerdì? Controlla."], |r| {
            if r.ran_any(|n| n.starts_with("mail")) {
                vec![]
            } else {
                vec![(Level::Warn, "non ha cercato tra le email (strumento nel catalogo non caricato)".into())]
            }
        }),
        Case::new("manda-mail", "Scrivere una mail (simulata)", &["Scrivi una mail a marco@example.com: venerdì ci sono, porto il dolce."], |r| {
            if r.ran_any(|n| n.starts_with("mail_send") || n.contains("draft")) {
                vec![]
            } else {
                vec![(Level::Warn, "nessuna bozza o invio chiamato".into())]
            }
        }),
        Case::new("ascolto", "Ascoltare una cartella", &["Avvisami quando cambia qualcosa nella cartella Download."], |r| {
            if r.ran("listen") > 0 {
                vec![]
            } else {
                vec![(Level::Ko, "listen non chiamato".into())]
            }
        }),
        Case::new("inesistente", "Una cosa che nessuno strumento fa", &["Prenotami un tavolo per due stasera alle 20 al ristorante Da Gino."], |r| {
            let mut out = vec![];
            if r.ran_any(|n| n.starts_with("mail_send")) {
                out.push((Level::Warn, "ha provato a mandare una mail per prenotare".into()));
            }
            out
        }),
        Case::new("memoria", "Ricordare il turno prima", &["Mi chiamo Tester e il mio colore preferito è il verde. Rispondi solo: ok.", "Qual è il mio colore preferito?"], |r| {
            if r.lower().contains("verde") {
                vec![]
            } else {
                vec![(Level::Ko, "non ricorda il verde dal turno prima".into())]
            }
        }),
        Case { max_tokens: Some(80), ..Case::new("tagliata", "Risposta tagliata al limite", &["Scrivi una storia di almeno 1000 parole su un faro."], |r| {
            if r.last().is_some_and(|o| o.end == End::Cut) {
                vec![]
            } else {
                vec![(Level::Warn, "con max_tokens 80 il server non ha detto finish_reason: length".into())]
            }
        }) },
        Case { whole: true, ..Case::new("intera", "Risposta intera (senza stream)", &["Dimmi tre colori, separati da virgole."], |_| vec![]) },
        Case { whole: true, file: File::Story, ..Case::new("intera-strumenti", "Strumenti senza stream", &["Quante righe ha questo file?"], |r| {
            if r.ran(crate::workspace::READ) + r.ran(crate::workspace::SEARCH) == 0 {
                vec![(Level::Ko, "il file non è stato letto".into())]
            } else {
                vec![]
            }
        }) },
        Case { stop_first: Some(Duration::from_secs(4)), ..Case::new("stop", "Stop a metà, poi un'altra domanda", &["Scrivi una storia di 800 parole su un drago.", "Rispondi solo: ok."], |r| {
            let mut out = vec![];
            if r.stopped == Some(false) {
                out.push((Level::Warn, "la prima risposta è finita prima dello Stop (4 s)".into()));
            }
            if r.stopped == Some(true) && r.answer().trim().is_empty() {
                out.push((Level::Ko, "dopo lo Stop la domanda seguente non ha avuto risposta".into()));
            }
            out
        }) },
    ];
    if caps.vision == Some(false) {
        all.push(Case::new("immagine", "Un'immagine", &[], |_| vec![(Level::Skipped, "il server dice che il modello non vede immagini".into())]));
    } else {
        all.push(Case { image: true, ..Case::new("immagine", "Un'immagine", &["Di che colore è questa immagine? Una parola."], |r| {
            if r.lower().contains("ross") || r.lower().contains("red") {
                vec![]
            } else {
                vec![(Level::Warn, "non dice rosso".into())]
            }
        }) });
    }
    for level in &caps.reasoning {
        all.push(Case {
            effort: Some(level.clone()),
            id: format!("ragionamento-{level}"),
            ..Case::new("", "Ragionamento", &["Quanto fa 12 × 12? Rispondi solo con il numero."], |r| {
                if r.answer().contains("144") {
                    vec![]
                } else {
                    vec![(Level::Ko, "il risultato (144) non c'è".into())]
                }
            })
        });
    }
    all
}

fn names(r: &Run) -> String {
    r.calls.iter().map(|c| c.name.as_str()).collect::<Vec<_>>().join(", ")
}

/// What every scenario is checked for, besides its own checks.
/// The requests of a turn the server lost or refused, and Lumo asked again.
fn lost_requests(o: &Outcome) -> usize {
    o.fixes.iter().filter(|f| **f == "asked again").count()
}

fn common(r: &Run, expect_cut: bool) -> Vec<(Level, String)> {
    let mut out = vec![];
    for (i, t) in r.turns.iter().enumerate() {
        let n = if r.turns.len() > 1 { format!(" (domanda {})", i + 1) } else { String::new() };
        match t {
            Err(e) => out.push((Level::Ko, format!("errore{n}: {e}"))),
            Ok(o) => {
                if o.answer().trim().is_empty() && !(expect_cut && o.end == End::Cut) {
                    out.push((Level::Ko, format!("risposta vuota{n}")));
                }
                if o.end == End::Rounds {
                    out.push((Level::Ko, format!("ancora strumenti dopo l'ultimo giro{n}")));
                }
                if o.end == End::Cut && !expect_cut {
                    out.push((Level::Warn, format!("risposta tagliata al limite di lunghezza{n}")));
                }
                // The server losing requests (LM Studio's own bug) isn't
                // Lumo's doing: said, not counted as a warning.
                let lost = lost_requests(o);
                if lost > 0 {
                    out.push((Level::Ok, format!("il server ha perso {lost} richiest{}, rifatt{} da Lumo{n}", if lost == 1 { "a" } else { "e" }, if lost == 1 { "a" } else { "e" })));
                }
                if o.fixes.contains(&"answered whole") {
                    out.push((Level::Warn, format!("lo stream si è bloccato, risposta chiesta intera{n}")));
                }
                for fix in o.fixes.iter().filter(|f| !matches!(**f, "answered whole" | "tools loaded" | "asked again")) {
                    out.push((Level::Warn, format!("corretto da Lumo: {fix}{n}")));
                }
                let a = o.answer();
                if a.contains("<think>") || a.contains("</think>") {
                    out.push((Level::Warn, format!("<think> rimasto nella risposta{n}")));
                }
                if a.contains("[[") || a.contains("\"name\":") || a.contains("<tool_call>") {
                    out.push((Level::Warn, format!("sembra una chiamata scritta come testo{n}")));
                }
            }
        }
    }
    out
}

/// `text` cut to `max` characters.
fn short(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    format!("{}… [+{} caratteri]", text.chars().take(max).collect::<String>(), text.chars().count() - max)
}

fn stamp() -> (String, String) {
    let t = crate::platform::local_time();
    (
        format!("{:04}{:02}{:02}-{:02}{:02}{:02}", t.year, t.month, t.day, t.hour, t.minute, t.second),
        format!("{:04}-{:02}-{:02} {:02}:{:02}", t.year, t.month, t.day, t.hour, t.minute),
    )
}

/// The files of a workspace folder, by name (the manifest left out).
fn files_in(dir: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if !e.file_name().to_string_lossy().starts_with(".lumo") {
                out.push((e.file_name().to_string_lossy().to_string(), std::fs::read_to_string(&p).unwrap_or_default()));
            }
        }
    }
    out
}

/// /test: every scenario on `model` of `server`, the report written after each.
pub async fn run(app: &AppHandle, chat: &Chat, server: &Server, model: &str, caps: &Caps, effort: &str) -> Result<ChatReply, String> {
    let base = crate::local_chat::base_url(server)?;
    if model.is_empty() {
        return Err("Scegli un modello sopra la chat, poi scrivi /test.".into());
    }
    let events = chat.events();
    let (file_stamp, when) = stamp();
    let report_path = crate::platform::local_dir().join(format!("local-test-{file_stamp}.md"));
    let files_dir = std::env::temp_dir().join(format!("lumo-test-{file_stamp}"));
    std::fs::create_dir_all(&files_dir).map_err(|e| e.to_string())?;
    let notes = files_dir.join("notes.txt");
    let story = files_dir.join("racconto.txt");
    let png = files_dir.join("rosso.png");
    std::fs::write(&notes, NOTES).map_err(|e| e.to_string())?;
    std::fs::write(&story, STORY).map_err(|e| e.to_string())?;
    std::fs::write(&png, RED_PNG).map_err(|e| e.to_string())?;

    let mut progress = format!("**Test di {model}** su {}: comincio.", crate::i18n::t(server.name));
    let mut sections: Vec<String> = Vec::new();
    let mut rows: Vec<String> = Vec::new();
    let mut tally = [0usize; 4];
    let mut lost = 0usize;
    let started = Instant::now();

    let work = async {
        // The model in memory first, as the chat does.
        events.delta(app, &progress);
        if caps.loaded == Some(false) {
            events.activity(app, Activity::new("loading", ""));
            if let Err(e) = crate::local_models::load(server, model, |p| events.activity(app, Activity::new("loading", p.to_string()))).await {
                crate::log::line(format!("[test] loading {model}: {e}"));
            }
        }
        let caps = if caps.loaded == Some(false) { crate::local_models::caps(server, model).await } else { caps.clone() };
        let header = header(server, &base, model, &caps, &when);
        let all: Vec<(String, String, Value)> = tauri::async_runtime::spawn_blocking(|| crate::tools::chat_tools(MAIL, false, true))
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|(id, _, _)| profile::group_of(id) != Some(profile::Group::User))
            .collect();
        let prompt_for = |loaded: &[String], tools: bool| {
            let groups: Vec<profile::Group> = profile::Group::ALL.into_iter().filter(|g| loaded.iter().any(|id| profile::group_of(id) == Some(*g))).collect();
            let catalog = profile::catalog(&all, loaded);
            profile::system_prompt(&profile::Prompt {
                first_name: crate::identity::first_name(),
                tools,
                web: false,
                timer: tools,
                workspace: tools,
                groups: &groups,
                catalog: &catalog,
                mail: MAIL,
                plan: false,
                workshop: false,
            })
        };
        let to = crate::local_chat::endpoint(server, &base)?;
        let cases = cases(&caps);
        let total = cases.len();
        for (i, case) in cases.iter().enumerate() {
            events.activity(app, Activity::new("tool", format!("Test {}/{total}: {}", i + 1, case.title)));
            let run = if case.turns.is_empty() {
                Run::default()
            } else {
                one(&to, server, model, &caps, effort, case, &file_stamp, &all, &prompt_for, &notes, &story, &png).await
            };
            let mut found = if case.turns.is_empty() { Vec::new() } else { common(&run, case.max_tokens.is_some()) };
            found.extend((case.check)(&run));
            let level = found.iter().map(|(l, _)| *l).max().unwrap_or(Level::Ok);
            lost += run.turns.iter().filter_map(|t| t.as_ref().ok()).map(lost_requests).sum::<usize>();
            tally[level as usize] += 1;
            let rounds: usize = run.turns.iter().filter_map(|t| t.as_ref().ok()).map(|o| o.rounds).sum();
            let notes_line = found.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join("; ");
            rows.push(format!("| {} | {} | {} | {:.1} s | {rounds} | {} |", i + 1, case.id, level.mark(), run.took.as_secs_f64(), notes_line.replace('|', "/")));
            sections.push(section(i + 1, case, &run, level, &found));
            progress.push_str(&format!("\n- {} **{}** {:.0} s{}", level.mark(), case.title, run.took.as_secs_f64(), if notes_line.is_empty() { String::new() } else { format!(": {}", short(&notes_line, 120)) }));
            events.delta(app, &progress);
            write_report(&report_path, &header, &tally, lost, started.elapsed(), &rows, &sections);
        }
        Ok::<_, String>(())
    };
    let finished = chat.unless_stopped(work).await;
    let _ = std::fs::remove_dir_all(&files_dir);
    let summary = format!(
        "{progress}\n\n**{} OK, {} avvisi, {} KO, {} saltati** in {} min. Il report è in `{}`: mandamelo.",
        tally[0],
        tally[2],
        tally[3],
        tally[1],
        started.elapsed().as_secs() / 60,
        report_path.display()
    );
    crate::log::line(format!("[test] {model}: {} OK, {} warnings, {} KO -> {}", tally[0], tally[2], tally[3], report_path.display()));
    match finished {
        None => Ok(ChatReply::stopped(format!("{summary}\n\n(Fermato: il report ha gli scenari fatti fin qui.)"), None)),
        Some(Err(e)) => Err(e),
        Some(Ok(())) => Ok(ChatReply::answer(summary, None)),
    }
}

/// One scenario: its questions in one conversation, on fresh copies.
#[allow(clippy::too_many_arguments)]
async fn one<P: Fn(&[String], bool) -> String + Sync>(
    to: &lumo_local::Endpoint,
    server: &Server,
    model: &str,
    caps: &Caps,
    effort: &str,
    case: &Case,
    stamp: &str,
    all: &[(String, String, Value)],
    prompt_for: &P,
    notes: &Path,
    story: &Path,
    png: &Path,
) -> Run {
    let chat = format!("self-test-{stamp}-{}", case.id);
    let mut island = TestIsland { chat: chat.clone(), workspace: chat.clone(), all, prompt_for, calls: Vec::new(), started: Instant::now(), first_text: None };
    let mut run = Run::default();
    let key = format!("self-test\u{0}{}\u{0}{model}\u{0}{stamp}\u{0}{}", server.id, case.id);
    if case.whole {
        lumo_local::turn::hung(&key, true);
    }
    let file: Option<PathBuf> = match case.file {
        File::None => None,
        File::Notes => Some(notes.to_path_buf()),
        File::Story => Some(story.to_path_buf()),
    };
    run.original_len = file.as_ref().and_then(|f| std::fs::read_to_string(f).ok()).map(|t| t.len()).unwrap_or(0);
    let context_size = if caps.loaded_context > 0 { caps.loaded_context } else { caps.max_context };
    let mut history: Vec<Value> = Vec::new();
    let started = Instant::now();
    for (n, question) in case.turns.iter().enumerate() {
        let named = profile::named_groups(question, &[]);
        let loaded = profile::loaded(&chat, &profile::in_groups(all, &named));
        let tools = profile::pick(all, &loaded);
        let system = prompt_for(&loaded, true);
        let mut text = question.to_string();
        if let (0, Some(f)) = (n, &file) {
            text = format!("{text}\n\n(This file is at {}: copy it with {} to work on it.)", f.display(), crate::workspace::COPY);
        }
        let mut user = json!({ "role": "user", "content": text });
        if case.image && n == 0 {
            user = crate::openai_compat::with_images(user, &[png.to_string_lossy().to_string()], crate::openai_compat::PdfAs::Text);
        }
        let mut messages = vec![json!({ "role": "system", "content": system })];
        messages.extend(history.iter().cloned());
        messages.push(user.clone());
        let function_tools = crate::openai_compat::function_tools(&tools);
        let taken = (messages.iter().map(|m| m.to_string().len()).sum::<usize>() + function_tools.to_string().len()) as u64 / 3;
        let mut body = json!({
            "model": model,
            "messages": messages,
            "stream": true,
            "max_tokens": case.max_tokens.unwrap_or_else(|| answer_room(context_size, taken)),
            "tools": function_tools,
        });
        let level = case.effort.as_deref().unwrap_or(effort);
        if let Some(level) = crate::local_models::reasoning_effort(caps, level) {
            body["reasoning_effort"] = json!(level);
            if server.id == "unsloth" {
                body["enable_thinking"] = json!(level != "none");
            }
        }
        if matches!(server.id, "ollama" | "lmstudio" | "unsloth") {
            body["stream_options"] = json!({ "include_usage": true });
        }
        let rules = lumo_local::Rules {
            key: key.clone(),
            query: question,
            workspace: true,
            changes: &[crate::workspace::WRITE, crate::workspace::EDIT, crate::workspace::DELETE],
            max_rounds: 8,
            pause: Duration::from_secs(1),
        };
        island.started = Instant::now();
        island.first_text = None;
        let limit = if n == 0 { case.stop_first.unwrap_or(TURN_LIMIT) } else { TURN_LIMIT };
        let outcome = tokio::time::timeout(limit, lumo_local::run(to, &mut body, &rules, &mut island)).await;
        let outcome = match outcome {
            Err(_) if n == 0 && case.stop_first.is_some() => {
                run.stopped = Some(true);
                continue;
            }
            Ok(Ok(o)) if n == 0 && case.stop_first.is_some() => {
                run.stopped = Some(false);
                Ok(o)
            }
            Err(_) => Err(format!("nessuna risposta in {} minuti", TURN_LIMIT.as_secs() / 60)),
            Ok(Err(f)) => Err(describe(f)),
            Ok(Ok(o)) => Ok(o),
        };
        if let Ok(o) = &outcome {
            history.push(user);
            history.push(json!({ "role": "assistant", "content": o.answer() }));
        }
        run.messages = body["messages"].as_array().cloned().unwrap_or_default();
        run.turns.push(outcome);
    }
    run.took = started.elapsed();
    run.first_text = island.first_text;
    run.calls = std::mem::take(&mut island.calls);
    let dir = crate::workspace::dir(&chat);
    run.files = files_in(&dir);
    crate::workspace::delete(&chat);
    run
}

fn describe(f: Failure) -> String {
    match f {
        Failure::NotInstalled => "il modello non c'è sul server (404)".into(),
        Failure::Status(s, e) => format!("HTTP {s}: {e}"),
        Failure::Unreachable => "server non raggiungibile, o connessione caduta a metà".into(),
        Failure::CutShort => "il server ha chiuso la risposta senza niente dentro".into(),
        Failure::TooLarge => "risposta troppo grande".into(),
        Failure::Server(e) => format!("errore del server: {e}"),
    }
}

fn header(server: &Server, base: &reqwest::Url, model: &str, caps: &Caps, when: &str) -> String {
    let yes = |v: Option<bool>| match v {
        Some(true) => "sì",
        Some(false) => "no",
        None => "non detto",
    };
    format!(
        "# Lumo /test: {model}\n\n{when} · Lumo {} · {} ({}) · contesto caricato {} / massimo {} · vede immagini: {} · strumenti: {} · ragionamento: {}\n",
        env!("CARGO_PKG_VERSION"),
        crate::i18n::t(server.name),
        crate::net::host_for_log(base),
        caps.loaded_context,
        caps.max_context,
        yes(caps.vision),
        yes(caps.tools),
        if caps.reasoning.is_empty() { "no".to_string() } else { caps.reasoning.join(", ") },
    )
}

fn section(n: usize, case: &Case, run: &Run, level: Level, found: &[(Level, String)]) -> String {
    let mut s = format!("\n## {n}. {} ({}): {}\n\n", case.title, case.id, level.mark());
    for (l, note) in found {
        s.push_str(&format!("- {} {note}\n", l.mark()));
    }
    if case.turns.is_empty() {
        return s;
    }
    for (i, q) in case.turns.iter().enumerate() {
        s.push_str(&format!("\n**Domanda {}:** {q}\n", i + 1));
        if i == 0 && run.stopped == Some(true) {
            s.push_str("\n_Fermata dopo il tempo previsto (Stop)._\n");
            continue;
        }
        let at = if run.stopped == Some(true) { i - 1 } else { i };
        match run.turns.get(at) {
            Some(Ok(o)) => {
                s.push_str(&format!(
                    "\nFine: {:?} · giri {} · intera: {} · token: {} · corretto: {}\n",
                    o.end,
                    o.rounds,
                    if o.whole { "sì" } else { "no" },
                    o.used.map(|u| u.to_string()).unwrap_or("?".into()),
                    if o.fixes.is_empty() { "niente".to_string() } else { o.fixes.join(", ") }
                ));
                if !o.notes.is_empty() {
                    s.push_str(&format!("\nErrori del server lungo la strada: {}\n", o.notes.join(" · ")));
                }
                s.push_str(&format!("\n```text\n{}\n```\n", short(&o.answer(), 1500).replace("```", "'''")));
            }
            Some(Err(e)) => s.push_str(&format!("\nErrore: {e}\n")),
            None => {}
        }
    }
    s.push_str(&format!(
        "\nTempo: {:.1} s · prima parola dopo: {}\n",
        run.took.as_secs_f64(),
        run.first_text.map(|d| format!("{:.1} s", d.as_secs_f64())).unwrap_or("?".into())
    ));
    if !run.calls.is_empty() {
        s.push_str("\nStrumenti:\n");
        for c in &run.calls {
            s.push_str(&format!("- `{}` {} → {}\n", c.name, short(&c.input.to_string(), 300), short(&c.answer.replace('\n', " "), 200)));
        }
    }
    if !run.files.is_empty() {
        s.push_str("\nFile nella cartella di lavoro alla fine:\n");
        for (name, text) in &run.files {
            s.push_str(&format!("- {name}: {} righe, {} caratteri\n", text.lines().count(), text.len()));
        }
    }
    let transcript: Vec<String> = run
        .messages
        .iter()
        .skip(1)
        .map(|m| {
            let calls = m.get("tool_calls").map(|c| format!(" tool_calls={}", short(&c.to_string(), 600))).unwrap_or_default();
            let content = match &m["content"] {
                Value::String(t) => t.clone(),
                other => other.to_string(),
            };
            format!("[{}]{calls} {}", m["role"].as_str().unwrap_or("?"), short(&content, 800))
        })
        .collect();
    s.push_str(&format!("\n<details><summary>Messaggi dell'ultima richiesta</summary>\n\n```text\n{}\n```\n</details>\n", transcript.join("\n\n").replace("```", "'''")));
    s
}

fn write_report(path: &Path, header: &str, tally: &[usize; 4], lost: usize, took: Duration, rows: &[String], sections: &[String]) {
    let text = format!(
        "{header}\n**{} OK, {} avvisi, {} KO, {} saltati** · {} min · richieste perse dal server e rifatte: {lost}\n\n| # | Scenario | Esito | Tempo | Giri | Note |\n|---|---|---|---|---|---|\n{}\n{}",
        tally[0],
        tally[2],
        tally[3],
        tally[1],
        took.as_secs() / 60,
        rows.join("\n"),
        sections.concat()
    );
    let _ = crate::platform::ensure_private_dir(path.parent().unwrap_or(Path::new(".")));
    let _ = std::fs::write(path, text);
}
