// What a local model is given: a short prompt of its own and the tools the
// question needs, not Claude's whole set. A model on the user's PC reads
// every word of it before each answer, and 27 tools and ~7 000 tokens of
// instructions made small models slow, confused and prone to writing calls
// as text. The core tools are always there (the copies, the web search, the
// timer); the email, listening and the user's own tools come in groups, when
// the question names them or when the model asks with `lumo_tools`, and stay
// for the rest of the chat.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

/// The tool a model calls for a group it doesn't have yet.
pub const MORE: &str = "lumo_tools";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Group {
    Mail,
    Listen,
    User,
}

impl Group {
    pub const ALL: [Group; 3] = [Group::Mail, Group::Listen, Group::User];

    pub fn id(self) -> &'static str {
        match self {
            Group::Mail => "mail",
            Group::Listen => "listen",
            Group::User => "user",
        }
    }

    fn from_id(id: &str) -> Option<Group> {
        Group::ALL.into_iter().find(|g| g.id() == id)
    }

    /// What `lumo_tools` says the group is for.
    fn about(self) -> &'static str {
        match self {
            Group::Mail => "mail: read, search and write the user's email",
            Group::Listen => "listen: be told when something happens (a pull request, a file, a download, a program, a web page)",
            Group::User => "user: the user's own tools",
        }
    }
}

/// The group a tool belongs to; None for a core one.
pub fn group_of(id: &str) -> Option<Group> {
    if crate::tools::is_mail_tool(id) {
        Some(Group::Mail)
    } else if id == crate::island_tools::SET_TIMER {
        None
    } else if crate::island_tools::NAMES.contains(&id) {
        Some(Group::Listen)
    } else if crate::web_search::NAMES.contains(&id) || crate::workspace::NAMES.contains(&id) {
        None
    } else {
        Some(Group::User)
    }
}

/// Words that bring a group in, in the languages Lumo speaks most (lower case).
const MAIL_WORDS: &[&str] = &[
    "mail", "posta", "inbox", "casella", "allegat", "attachment", "newsletter", "correo", "courriel", "gmail", "outlook", "邮件", "почт", "письм",
];
const LISTEN_WORDS: &[&str] = &[
    "avvisami", "avvertimi", "dimmi quando", "fammi sapere quando", "appena finisce", "appena arriva", "notificami", "ascolta", "tell me when",
    "let me know when", "notify me", "alert me", "ping me", "once it", "pull request", "github.com/", "avísame", "préviens-moi", "listen",
];

/// The groups a question names, with the words of the user's own tools.
pub fn named_groups(query: &str, user_tools: &[(String, String, Value)]) -> Vec<Group> {
    let q = query.to_lowercase();
    let mut found = Vec::new();
    if MAIL_WORDS.iter().any(|w| q.contains(w)) {
        found.push(Group::Mail);
    }
    if LISTEN_WORDS.iter().any(|w| q.contains(w)) {
        found.push(Group::Listen);
    }
    let user = user_tools.iter().any(|(id, _, _)| {
        let id = id.to_lowercase();
        id.len() >= 3 && (q.contains(&id) || q.contains(&format!("/{id}")))
    });
    if user {
        found.push(Group::User);
    }
    found
}

/// The groups each chat has used, kept for the rest of the chat.
fn sticky() -> &'static Mutex<HashMap<String, Vec<Group>>> {
    static STICKY: std::sync::OnceLock<Mutex<HashMap<String, Vec<Group>>>> = std::sync::OnceLock::new();
    STICKY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The groups `chat` has, after adding `more`.
pub fn groups_of(chat: &str, more: &[Group]) -> Vec<Group> {
    let mut all = sticky().lock().unwrap_or_else(|e| e.into_inner());
    let had = all.entry(chat.to_string()).or_default();
    for g in more {
        if !had.contains(g) {
            had.push(*g);
        }
    }
    had.clone()
}

/// The tools of `all` a turn starts with: the core ones and those of `groups`.
pub fn pick(all: &[(String, String, Value)], groups: &[Group]) -> Vec<(String, String, Value)> {
    all.iter()
        .filter(|(id, _, _)| group_of(id).is_none_or(|g| groups.contains(&g)))
        .map(|(id, d, s)| (id.clone(), short(d), s.clone()))
        .collect()
}

/// The groups of `all` not in `groups`: what `lumo_tools` offers.
pub fn missing(all: &[(String, String, Value)], groups: &[Group]) -> Vec<Group> {
    Group::ALL
        .into_iter()
        .filter(|g| !groups.contains(g) && all.iter().any(|(id, _, _)| group_of(id) == Some(*g)))
        .collect()
}

/// The `lumo_tools` tool for the groups not loaded yet.
pub fn more_tool(missing: &[Group]) -> (String, String, Value) {
    let ids: Vec<&str> = missing.iter().map(|g| g.id()).collect();
    let about: Vec<&str> = missing.iter().map(|g| g.about()).collect();
    (
        MORE.to_string(),
        format!("Gives you more of Lumo's tools, for the rest of the chat: {}. Call it before you need them, then call them.", about.join("; ")),
        json!({
            "type": "object",
            "properties": { "group": { "type": "string", "enum": ids } },
            "required": ["group"],
            "additionalProperties": false
        }),
    )
}

/// The group a `lumo_tools` call asks for.
pub fn asked_group(input: &Value) -> Option<Group> {
    input.get("group").and_then(Value::as_str).and_then(Group::from_id)
}

/// The first sentences of a description, at most `SHORT` characters: the
/// rest is for the bigger models.
const SHORT: usize = 320;

fn short(description: &str) -> String {
    if description.chars().count() <= SHORT {
        return description.to_string();
    }
    let mut out = String::new();
    for sentence in description.split_inclusive(". ") {
        if out.chars().count() + sentence.chars().count() > SHORT && !out.is_empty() {
            break;
        }
        out.push_str(sentence);
    }
    if out.chars().count() > SHORT {
        out = out.chars().take(SHORT).collect::<String>() + "…";
    }
    out.trim_end().to_string()
}

/// What a local model is told. `tools`: it has any; `web`, `timer`,
/// `workspace`: those core tools; `groups`: the groups it has now; `more`:
/// it can ask for the others; `mail`: what the email tools may do.
pub struct Prompt<'a> {
    pub first_name: Option<&'a str>,
    pub tools: bool,
    pub web: bool,
    pub timer: bool,
    pub workspace: bool,
    pub groups: &'a [Group],
    pub more: bool,
    pub mail: &'a str,
    pub plan: bool,
    pub workshop: bool,
}

pub fn system_prompt(p: &Prompt) -> String {
    let who = match p.first_name {
        Some(name) => format!("You are Lumo, {name}'s assistant at the top of their screen."),
        None => "You are Lumo, an assistant at the top of the user's screen.".to_string(),
    };
    let mut out = format!(
        "{who} Answer in the user's language, with light Markdown (short paragraphs, lists, **bold**, `code`, fenced code); no tables or big headings, the window is small. \
Lumo may give you the windows and documents open on the user's computer: use them. Write math as $…$ or $$…$$."
    );
    if p.web {
        out.push_str(" web_search searches the web and web_fetch reads a page: use them for current or specific facts instead of guessing, and give the links you used.");
    } else {
        out.push_str(" You have no web access: say so when something needs current information.");
    }
    if p.tools {
        out.push_str(" To use a tool, call it as a function call: never write a call in your answer, and never say something was done unless a tool did it. If a tool fails, say what failed.");
    }
    if p.timer {
        out.push_str(" For a timer or a reminder in some time, call set_timer, only when asked.");
    }
    if p.workspace {
        out.push_str(" You can't open or change the user's files yourself: copy a file or folder into your own folder with workspace_copy (its full path), then read and change the copy with the other workspace tools. The original never changes, so say that the copy changed, never their file; the user can write it over the original with a click.");
        out.push_str(&crate::workspace::folders_note());
    }
    if p.groups.contains(&Group::Mail) && !p.mail.is_empty() {
        out.push_str(" The user's email: mail_recent, mail_search and mail_read read every folder; look before saying there is none.");
        if p.mail.contains("mailsend") {
            out.push_str(" mail_send, mail_reply and mail_forward show the email on a card and it goes only if the user clicks Send; mail_draft saves a draft.");
        } else {
            out.push_str(" You can't send email: write a draft for the user.");
        }
        if p.mail.contains("mailmanage") {
            out.push_str(" mail_mark, mail_move, mail_archive and mail_trash only when the user asks.");
        }
    }
    if p.groups.contains(&Group::Listen) {
        out.push_str(" To be told when something happens (a pull request's checks, a file or download, a program, a web page, an email), call listen with what to do then, and never wait, sleep or poll yourself; Lumo writes to you in this chat when it happens.");
    }
    if p.more {
        out.push_str(" More tools (email, listening, the user's own tools) come with lumo_tools: call it when the user asks for something they do.");
    }
    if p.plan {
        out.push_str(" The user picked Plan only: read and plan, and change nothing.");
    }
    if p.workshop {
        out.push_str(crate::chat::workshop_note!());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(id: &str) -> (String, String, Value) {
        (id.to_string(), "Does it.".to_string(), json!({}))
    }

    #[test]
    fn the_question_brings_in_its_groups() {
        let user = vec![tool("pdfcraft")];
        assert_eq!(named_groups("Ciao, che mi racconti?", &user), vec![]);
        assert_eq!(named_groups("Leggimi l'ultima mail di Marco", &user), vec![Group::Mail]);
        assert_eq!(named_groups("Avvisami quando finiscono i check", &user), vec![Group::Listen]);
        assert_eq!(named_groups("Unisci questi pdf con pdfcraft", &user), vec![Group::User]);
    }

    #[test]
    fn a_turn_starts_with_the_core_tools_and_its_groups() {
        let all = vec![tool("set_timer"), tool("listen"), tool("mail_read"), tool("web_search"), tool("workspace_copy"), tool("pdfcraft")];
        let names = |v: Vec<(String, String, Value)>| v.into_iter().map(|t| t.0).collect::<Vec<_>>();
        assert_eq!(names(pick(&all, &[])), ["set_timer", "web_search", "workspace_copy"]);
        assert_eq!(names(pick(&all, &[Group::Mail])), ["set_timer", "mail_read", "web_search", "workspace_copy"]);
        assert_eq!(missing(&all, &[Group::Mail]), vec![Group::Listen, Group::User]);
        assert_eq!(asked_group(&json!({"group": "listen"})), Some(Group::Listen));
    }

    #[test]
    fn groups_stay_with_their_chat() {
        assert_eq!(groups_of("chat-a", &[Group::Mail]), vec![Group::Mail]);
        assert_eq!(groups_of("chat-a", &[]), vec![Group::Mail]);
        assert_eq!(groups_of("chat-b", &[]), vec![]);
    }

    #[test]
    fn long_descriptions_keep_their_first_sentences() {
        let long = format!("First one. Second one. {}", "x".repeat(400));
        assert_eq!(short(&long), "First one. Second one.");
        assert_eq!(short("Short."), "Short.");
    }
}
