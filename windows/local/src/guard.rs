// What local models get wrong, caught: a tool call written as text, a change
// said but not made, arguments that aren't JSON; and how long an answer may be.

use serde_json::{json, Value};

/// Whether the user asks for a change to a file (or for something written).
/// A word said not to be done ("Non modificare niente") asks for nothing.
pub fn asks_change(query: &str) -> bool {
    said(query, &[
        "modific", "scriv", "aggiung", "cambi", "cancell", "rimuov", "togli", "salva", "corregg", "sistem", "aggiorn", "riscriv", "allung", "accorc",
        "edit", "write", "add ", "change", "delete", "remove", "save", "fix", "update", "rewrite", "modif", "écri", "ajout", "escrib", "añad", "cambia",
    ])
}

/// Whether an answer says, in the first person, that a file was changed
/// ("non ho modificato nulla" says it wasn't).
pub fn claims_change(text: &str) -> bool {
    said(text, &[
        "ho modificato", "ho scritto", "ho salvato", "ho aggiornato", "ho aggiunto", "ho sovrascritto", "ho cancellato", "ho riscritto", "ho corretto",
        "è stato modificato", "è stata modificata", "è stato aggiornato", "è stata aggiornata",
        "i modified", "i've modified", "i have modified", "i updated", "i've updated", "i have updated", "i wrote", "i've written", "i saved",
        "i've saved", "i added", "i've added", "i changed", "i've changed", "has been updated", "has been modified", "j'ai modifié", "he modificado",
    ])
}

/// Whether an answer says, in the first person, that something was done:
/// a file changed, a timer set, a folder listened to, a mail written.
pub fn claims_done(text: &str) -> bool {
    claims_change(text)
        || said(text, &[
            "ho impostato", "ho attivato", "ho messo", "ho creato", "ho programmato", "ho iniziato", "ho avviato", "ho preparato", "ho inviato", "ho mandato",
            "ti avviserò", "ti avviso io", "i've set", "i have set", "i set up", "i've created", "i created", "i've started", "i started", "i'll let you know",
            "i will let you know", "i'll notify", "i've sent", "i sent",
            // A search said made with no call ("I searched in three languages, nothing").
            "ho cercato", "ho fatto una ricerca", "ho fatto diverse ricerche", "ho fatto delle ricerche", "ho riprovato a cercare", "i searched",
            "i've searched", "i have searched", "i looked it up",
        ])
}

/// The words that say a thing is not so, or not to be done.
const NEGATIONS: &[&str] = &[
    "non", "nessun", "nessuno", "nessuna", "niente", "nulla", "senza", "né", "mai", "nemmeno", "neanche", "neppure", "not", "no", "never", "nothing",
    "none", "nor", "neither", "without", "pas", "rien", "jamais", "sans", "ni", "sin", "nunca", "nada", "ningún", "ninguno", "ninguna",
];

/// The words that open a clause of their own, as a comma does ("Non ho
/// toccato i test ma ho corretto il bug").
const BUT: &[&str] = &["ma", "però", "but", "however", "mais", "pero"];

/// Whether `text` says one of `words` (lowercase; parts of words too), and
/// not after a negation of its own clause: "Non modificare niente" doesn't
/// ask for a change, "Ho corretto i bug, non ho modificato i test" says one.
fn said(text: &str, words: &[&str]) -> bool {
    let t = text.to_lowercase();
    words.iter().any(|w| t.match_indices(w).any(|(at, _)| !negated(&t[..at])))
}

/// Whether the clause that `before` ends with (from the last , . ; : ! ? or
/// line break, or the last "but") has a negation in it.
fn negated(before: &str) -> bool {
    let clause = before.rsplit([',', '.', ';', ':', '!', '?', '\n']).next().unwrap_or_default();
    let words: Vec<&str> = clause.split(|c: char| !(c.is_alphanumeric() || c == '\'' || c == '’')).filter(|w| !w.is_empty()).collect();
    let clause = words.rsplit(|w| BUT.contains(w)).next().unwrap_or_default();
    clause.iter().any(|w| NEGATIONS.contains(w) || w.ends_with("n't") || w.ends_with("n’t"))
}

/// Whether a short answer only says what the model is about to do ("Let me
/// read the file first."), and stops there.
pub fn announces(text: &str) -> bool {
    let t = text.trim().to_lowercase();
    if t.is_empty() || t.chars().count() > 300 {
        return false;
    }
    let t = t.replace("let me know", "").replace("fammi sapere", "");
    [
        "let me ", "i'll first", "i will first", "i'll now", "i will now", "now i'll", "i'm going to", "first, i", "first i ", "lasciami ", "fammi ",
        "prima leggo", "ora leggo", "adesso leggo", "leggo prima", "procedo a", "procedo con", "sto per ", "vado a ", "ora controllo", "adesso controllo",
        "ora apro", "ora copio", "adesso copio", "cerco subito", "ora cerco", "adesso cerco", "riprovo subito", "lo faccio subito", "lo leggo", "ora lo ", "adesso lo ", "poi lo ", "poi riscriv", "poi modific", "poi cambi",
    ]
    .iter()
    .any(|w| t.contains(w))
}

/// The longest answer to ask for: most of what the context leaves past the
/// prompt (`taken` tokens, a rough count), between 2 048 and 32 768 tokens;
/// 8 192 when the context isn't known.
pub fn answer_room(context: u64, taken: u64) -> u64 {
    if context == 0 {
        return 8_192;
    }
    (context.saturating_sub(taken) * 4 / 5).clamp(2_048, 32_768)
}

/// The tool of `names` that `text` writes as a line of its own (`[[name …]]`
/// or `[name(…)]`) instead of calling it.
pub fn written_call(text: &str, names: &[String]) -> Option<String> {
    let mut rest = text;
    while let Some(at) = rest.find('[') {
        let after = rest[at..].trim_start_matches('[').trim_start();
        if let Some(name) = names.iter().find(|n| {
            after.starts_with(n.as_str()) && after[n.len()..].starts_with(|c: char| c.is_whitespace() || c == '(' || c == ':' || c == '{' || c == '"')
        }) {
            return Some(name.clone());
        }
        rest = &rest[at + 1..];
    }
    None
}

/// `text` after what `message` says, as its last words.
pub fn append_text(message: &mut Value, text: &str) {
    match &mut message["content"] {
        Value::String(s) => {
            s.push_str("\n\n");
            s.push_str(text);
        }
        Value::Array(parts) => parts.push(json!({ "type": "text", "text": text })),
        _ => {}
    }
}

/// Takes the pictures out of the last message of `body` (its text stays),
/// for a server that refused them. Whether there were any.
pub fn without_images(body: &mut Value) -> bool {
    let Some(last) = body["messages"].as_array_mut().and_then(|m| m.last_mut()) else { return false };
    let Some(parts) = last["content"].as_array() else { return false };
    if !parts.iter().any(|p| p["type"] == "image_url") {
        return false;
    }
    let text: Vec<&str> = parts.iter().filter(|p| p["type"] == "text").filter_map(|p| p["text"].as_str()).collect();
    last["content"] = json!(text.join("\n\n"));
    true
}

/// The input of a call from its arguments (a JSON text): `{}` when there are
/// none, None when they aren't a JSON object (cut off, or made up).
pub fn call_input(arguments: &str) -> Option<Value> {
    if arguments.trim().is_empty() {
        return Some(json!({}));
    }
    serde_json::from_str::<Value>(arguments).ok().filter(Value::is_object)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_change_said_but_not_made_is_noticed() {
        assert!(asks_change("Puoi modificarlo aggiungendoci qualche dettaglio?"));
        assert!(!asks_change("Me lo leggi?"));
        assert!(claims_change("Ho modificato proprio quella copia con il testo allungato."));
        assert!(!claims_change("Ecco cosa contiene il file."));
        assert_eq!(answer_room(0, 100), 8_192);
        assert_eq!(answer_room(32_768, 2_768), 24_000);
        assert_eq!(answer_room(8_192, 7_000), 2_048);
    }

    #[test]
    fn a_change_said_not_to_be_made_or_not_made_is_no_change() {
        // A change the user says not to make, and an answer that says none was made.
        assert!(!asks_change("Leggi il progetto in C:\\Users\\r\\lumo-bench e spiegami cosa fa, file per file. Non modificare niente."));
        assert!(!asks_change("Don't change anything, just tell me what it does."));
        assert!(!asks_change("Riassumi il file senza cambiare il resto"));
        assert!(!asks_change("Do not edit it: read it"));
        assert!(!claims_change("Ecco cosa fa ogni file. Come richiesto non ho modificato nulla. Se vuoi che sistemi questi bug, dimmelo."));
        assert!(!claims_change("Nessun file è stato modificato."));
        assert!(!claims_change("I haven't changed anything, and I didn't save it either."));
        assert!(!claims_done("Non ho impostato nessun timer."));
        assert!(!claims_done("No, I've never set one up."));
        // What is so still counts, next to what isn't.
        assert!(claims_change("Ho corretto i bug, non ho modificato i test."));
        assert!(claims_change("Non ho toccato i test ma ho corretto il bug."));
        assert!(claims_change("I didn't touch the tests. I changed main.rs."));
        assert!(asks_change("Correggi i bug. Non modificare i file in tests"));
        assert!(asks_change("Non leggerlo: modificalo"));
        assert!(claims_done("Non serviva altro; ho impostato il timer."));
        // A word with a negation inside it is no negation.
        assert!(claims_change("Nonostante tutto ho modificato il file."));
    }

    #[test]
    fn a_thing_said_done_or_only_announced_is_noticed() {
        assert!(claims_done("Ho impostato l'ascolto per la cartella Downloads. Ti avviserò."));
        assert!(!claims_done("Non posso prenotare tavoli, ma posso scrivere una mail."));
        assert!(claims_done("Ho fatto diverse ricerche (in italiano, inglese e polacco) ma non ho trovato alcuna notizia."));
        assert!(announces("Cerco subito l'informazione."));
        assert!(announces("Let me read the contents of the file first so I can expand on it appropriately."));
        assert!(announces("Prima leggo il file, poi lo allungo."));
        assert!(announces("Ho copiato il file nel mio workspace. Lo leggo per vedere il contenuto prima di fare la modifica."));
        assert!(!announces("Il file ha 12 righe. Fammi sapere se ti serve altro."));
        assert!(!announces("Done. Let me know if you need anything else."));
    }

    #[test]
    fn a_tool_call_written_as_text_is_caught() {
        let names = vec!["workspace_edit".to_string(), "web_search".to_string()];
        assert_eq!(written_call("Fatto.\n[[workspace_edit \"file.txt\" \"a\" \"b\"]]", &names).as_deref(), Some("workspace_edit"));
        assert_eq!(written_call("[web_search(query=\"meteo\")]", &names).as_deref(), Some("web_search"));
        assert_eq!(written_call("[[timer 10m: pasta]] and [link](https://x) about web_searching", &names), None);
        assert_eq!(written_call("Use [workspace_editor] later", &names), None);
    }

    #[test]
    fn arguments_that_are_not_an_object_are_refused() {
        assert_eq!(call_input(""), Some(json!({})));
        assert_eq!(call_input(r#"{"path":"a.txt"}"#), Some(json!({"path":"a.txt"})));
        assert_eq!(call_input(r#"{"path":"a.t"#), None);
        assert_eq!(call_input("[1]"), None);
    }

    #[test]
    fn pictures_are_taken_out_of_the_last_message_and_text_is_added_to_it() {
        let mut body = json!({"messages":[{"role":"user","content":[{"type":"text","text":"What is it?"},{"type":"image_url","image_url":{"url":"data:,"}}]}]});
        assert!(without_images(&mut body));
        assert_eq!(body["messages"][0]["content"], "What is it?");
        assert!(!without_images(&mut body));
        let mut message = json!({"role":"user","content":"a"});
        append_text(&mut message, "b");
        assert_eq!(message["content"], "a\n\nb");
    }
}
