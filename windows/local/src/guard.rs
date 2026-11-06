// What local models get wrong, caught: a tool call written as text, a change
// said but not made, arguments that aren't JSON; and how long an answer may be.

use serde_json::{json, Value};

/// Whether the user asks for a change to a file (or for something written).
pub fn asks_change(query: &str) -> bool {
    let q = query.to_lowercase();
    [
        "modific", "scriv", "aggiung", "cambi", "cancell", "rimuov", "togli", "salva", "corregg", "sistem", "aggiorn", "riscriv", "allung", "accorc",
        "edit", "write", "add ", "change", "delete", "remove", "save", "fix", "update", "rewrite", "modif", "écri", "ajout", "escrib", "añad", "cambia",
    ]
    .iter()
    .any(|w| q.contains(w))
}

/// Whether an answer says, in the first person, that a file was changed.
pub fn claims_change(text: &str) -> bool {
    let t = text.to_lowercase();
    [
        "ho modificato", "ho scritto", "ho salvato", "ho aggiornato", "ho aggiunto", "ho sovrascritto", "ho cancellato", "ho riscritto", "ho corretto",
        "è stato modificato", "è stata modificata", "è stato aggiornato", "è stata aggiornata",
        "i modified", "i've modified", "i have modified", "i updated", "i've updated", "i have updated", "i wrote", "i've written", "i saved",
        "i've saved", "i added", "i've added", "i changed", "i've changed", "has been updated", "has been modified", "j'ai modifié", "he modificado",
    ]
    .iter()
    .any(|w| t.contains(w))
}

/// Whether an answer says, in the first person, that something was done:
/// a file changed, a timer set, a folder listened to, a mail written.
pub fn claims_done(text: &str) -> bool {
    let t = text.to_lowercase();
    claims_change(text)
        || [
            "ho impostato", "ho attivato", "ho messo", "ho creato", "ho programmato", "ho iniziato", "ho avviato", "ho preparato", "ho inviato", "ho mandato",
            "ti avviserò", "ti avviso io", "i've set", "i have set", "i set up", "i've created", "i created", "i've started", "i started", "i'll let you know",
            "i will let you know", "i'll notify", "i've sent", "i sent",
        ]
        .iter()
        .any(|w| t.contains(w))
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
        "ora apro", "ora copio", "adesso copio", "lo leggo", "ora lo ", "adesso lo ", "poi lo ", "poi riscriv", "poi modific", "poi cambi",
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
    fn a_thing_said_done_or_only_announced_is_noticed() {
        assert!(claims_done("Ho impostato l'ascolto per la cartella Downloads. Ti avviserò."));
        assert!(!claims_done("Non posso prenotare tavoli, ma posso scrivere una mail."));
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
