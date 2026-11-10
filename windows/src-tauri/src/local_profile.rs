// What a local model is given: a short prompt of its own and the tools the
// question needs, not Claude's whole set. A model on the user's PC reads
// every word of it before each answer, and 27 tools and ~7 000 tokens of
// instructions made small models slow, confused and prone to writing calls
// as text. The core tools are always there (the copies, the web search, the
// timer); every other one is a line in a catalog in the prompt, so the model
// knows it exists, and comes whole when the question names its group, when
// the model asks for it by name with `lumo_tools`, or when the model calls it
// straight away. Loaded, it stays for the rest of the chat.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

/// The tool a model calls for a group it doesn't have yet.
pub use lumo_local::MORE;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Group {
    Mail,
    GitHub,
    Listen,
    Plan,
    User,
}

impl Group {
    pub const ALL: [Group; 5] = [Group::Mail, Group::GitHub, Group::Listen, Group::Plan, Group::User];

    pub fn id(self) -> &'static str {
        match self {
            Group::Mail => "mail",
            Group::GitHub => "github",
            Group::Listen => "listen",
            Group::Plan => "plan",
            Group::User => "user",
        }
    }

    fn from_id(id: &str) -> Option<Group> {
        Group::ALL.into_iter().find(|g| g.id() == id)
    }
}

/// The group a tool belongs to; None for a core one.
pub fn group_of(id: &str) -> Option<Group> {
    if crate::tools::is_mail_tool(id) {
        Some(Group::Mail)
    } else if crate::github_tools::NAMES.contains(&id) {
        Some(Group::GitHub)
    } else if id == crate::island_tools::SET_TIMER {
        None
    } else if id == crate::island_tools::UPDATE_PLAN {
        Some(Group::Plan)
    } else if crate::island_tools::NAMES.contains(&id) {
        Some(Group::Listen)
    } else if crate::web_search::NAMES.contains(&id) || crate::workspace::NAMES.contains(&id) {
        None
    } else {
        Some(Group::User)
    }
}

/// True when `word` appears in `q` as a standalone word (bounded by non-alphanumeric chars).
fn has_word(q: &str, word: &str) -> bool {
    q.split(|c: char| !c.is_alphanumeric()).any(|w| w == word)
}

/// Words that bring a group in, in the languages Lumo speaks most (lower case).
const MAIL_WORDS: &[&str] = &[
    "mail", "e-mail", "posta", "inbox", "casella", "allegat", "attachment", "newsletter", "mittente", "bozz",
    "correo", "courriel", "gmail", "outlook", "邮件", "почт", "письм",
];
const GITHUB_PHRASES: &[&str] = &[
    "github", "pull request", "merge request", "workflow", "github actions", "repository", "repositories",
    "commit", "branch", "da revisionare", "to review", "code review",
];
const GITHUB_WORDS: &[&str] = &["pr", "prs", "ci", "repo", "repos", "issue", "issues"];
const LISTEN_WORDS: &[&str] = &[
    "avvisami", "avvertimi", "dimmi quando", "fammi sapere quando", "appena finisce", "appena arriva", "notificami",
    "monitora", "tieni d'occhio", "ascolta", "tell me when", "let me know when", "notify me", "alert me", "ping me",
    "once it", "pull request", "github.com/", "avísame", "préviens-moi", "listen",
];
const PLAN_PHRASES: &[&str] = &[
    "pianifica", "passo dopo passo", "step by step", "step-by-step", "multi-step", "roadmap", "checklist", "update_plan",
];
const PLAN_WORDS: &[&str] = &["plan", "piano"];

/// The groups a question names, with the words of the user's own tools.
pub fn named_groups(query: &str, user_tools: &[(String, String, Value)]) -> Vec<Group> {
    let q = query.to_lowercase();
    let mut found = Vec::new();
    if MAIL_WORDS.iter().any(|w| q.contains(w)) {
        found.push(Group::Mail);
    }
    if GITHUB_PHRASES.iter().any(|w| q.contains(w)) || GITHUB_WORDS.iter().any(|w| has_word(&q, w)) {
        found.push(Group::GitHub);
    }
    // "Does the Downloads folder change?": a change to watch, not one to make.
    let watch = ["cambia", "cambiano", "si modifica", "nuovi file", "nuovo file", "arriva", "changes", "new file", "gets modified"].iter().any(|w| q.contains(w))
        && ["cartella", "download", "file", "folder", "pagina", "page", "sito", "site"].iter().any(|w| q.contains(w));
    if watch || LISTEN_WORDS.iter().any(|w| q.contains(w)) {
        found.push(Group::Listen);
    }
    if PLAN_PHRASES.iter().any(|w| q.contains(w)) || PLAN_WORDS.iter().any(|w| has_word(&q, w)) {
        found.push(Group::Plan);
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

/// The tools each chat has loaded beyond the core ones, kept for the rest of the chat.
fn sticky() -> &'static Mutex<HashMap<String, Vec<String>>> {
    static STICKY: std::sync::OnceLock<Mutex<HashMap<String, Vec<String>>>> = std::sync::OnceLock::new();
    STICKY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The tools `chat` has loaded, after adding `more`.
pub fn loaded(chat: &str, more: &[String]) -> Vec<String> {
    let mut all = sticky().lock().unwrap_or_else(|e| e.into_inner());
    let had = all.entry(chat.to_string()).or_default();
    for id in more {
        if !had.contains(id) {
            had.push(id.clone());
        }
    }
    had.clone()
}

/// The tools of `all` in `groups`.
pub fn in_groups(all: &[(String, String, Value)], groups: &[Group]) -> Vec<String> {
    all.iter().filter(|(id, _, _)| group_of(id).is_some_and(|g| groups.contains(&g))).map(|(id, _, _)| id.clone()).collect()
}

/// The tools of `all` a round offers: the core ones and the `loaded` ones,
/// and `lumo_tools` while some are left in the catalog.
pub fn pick(all: &[(String, String, Value)], loaded: &[String]) -> Vec<(String, String, Value)> {
    let mut out: Vec<_> = all
        .iter()
        .filter(|(id, _, _)| group_of(id).is_none() || loaded.contains(id))
        .map(|(id, d, s)| (id.clone(), short(d), s.clone()))
        .collect();
    if all.iter().any(|(id, _, _)| group_of(id).is_some() && !loaded.contains(id)) {
        out.push(more_tool());
    }
    out
}

/// The tools of `all` still in the catalog.
fn left<'a>(all: &'a [(String, String, Value)], loaded: &[String]) -> Vec<&'a (String, String, Value)> {
    all.iter().filter(|(id, _, _)| group_of(id).is_some() && !loaded.contains(id)).collect()
}

/// The catalog: one short line for each tool not loaded (email and GitHub each
/// condensed onto one line), for the model to know they exist.
pub fn catalog(all: &[(String, String, Value)], loaded: &[String]) -> String {
    let left = left(all, loaded);
    if left.is_empty() {
        return String::new();
    }
    let mut lines = Vec::new();
    let mail: Vec<&str> = left.iter().filter(|(id, _, _)| group_of(id) == Some(Group::Mail)).map(|(id, _, _)| id.as_str()).collect();
    if !mail.is_empty() {
        lines.push(format!("{}: the user's email (read, search, write)", mail.join(", ")));
    }
    let gh: Vec<&str> = left.iter().filter(|(id, _, _)| group_of(id) == Some(Group::GitHub)).map(|(id, _, _)| id.as_str()).collect();
    if !gh.is_empty() {
        lines.push(format!("{}: the user's GitHub (pull requests, reviews, CI checks, issues, repositories, commits)", gh.join(", ")));
    }
    for (id, description, _) in left.iter().filter(|(id, _, _)| !matches!(group_of(id), Some(Group::Mail | Group::GitHub))) {
        let line = match id.as_str() {
            crate::island_tools::LISTEN => "be told when a file or folder changes, a download ends, a pull request's checks finish, a program starts or exits, a web page changes".to_string(),
            crate::island_tools::UNLISTEN => "stop listening".to_string(),
            crate::island_tools::LIST => "what Lumo is listening to".to_string(),
            crate::island_tools::UPDATE_PLAN => "show and tick off a step-by-step plan on Lumo's Plan island".to_string(),
            _ => one_line(description),
        };
        lines.push(format!("{id}: {line}"));
    }
    format!(
        " More tools, not loaded yet. When one would help, call {MORE} with its names, or call it straight away: Lumo loads it and you call it again.\n- {}",
        lines.join("\n- ")
    )
}

/// The `lumo_tools` tool.
fn more_tool() -> (String, String, Value) {
    (
        MORE.to_string(),
        "Loads tools from the catalog in your instructions (More tools), by name, for the rest of the chat; then call them.".to_string(),
        json!({
            "type": "object",
            "properties": { "names": { "type": "array", "items": { "type": "string" }, "description": "The tools to load, as the catalog names them." } },
            "required": ["names"],
            "additionalProperties": false
        }),
    )
}

/// The tools of `all` a `lumo_tools` call asks for (by name, or by group).
pub fn asked(all: &[(String, String, Value)], input: &Value) -> Vec<String> {
    let mut words: Vec<String> = match input.get("names").or_else(|| input.get("name")).or_else(|| input.get("group")) {
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        Some(Value::String(s)) => s.split([',', ' ']).filter(|w| !w.is_empty()).map(str::to_string).collect(),
        _ => Vec::new(),
    };
    words.iter_mut().for_each(|w| *w = w.trim().to_lowercase());
    let mut out = Vec::new();
    for w in &words {
        if let Some(group) = Group::from_id(w) {
            out.extend(in_groups(all, &[group]));
        } else if all.iter().any(|(id, _, _)| id == w && group_of(id).is_some()) {
            out.push(w.clone());
        }
    }
    out.dedup();
    out
}

/// Whether a call names a tool of the catalog (in `all`, not offered now).
pub fn in_catalog(all: &[(String, String, Value)], offered: &[String], name: &str) -> bool {
    !offered.iter().any(|n| n == name) && all.iter().any(|(id, _, _)| id == name && group_of(id).is_some())
}

/// The first sentence of a description, at most 90 characters.
fn one_line(description: &str) -> String {
    let first = description.split(". ").next().unwrap_or(description).trim_end_matches('.');
    if first.chars().count() > 90 {
        first.chars().take(90).collect::<String>() + "…"
    } else {
        first.to_string()
    }
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
/// `workspace`: those core tools; `groups`: the groups it has tools of now;
/// `catalog`: the tools it can load; `mail`: what the email tools may do.
pub struct Prompt<'a> {
    pub first_name: Option<&'a str>,
    /// Today's date, as `today` writes it.
    pub today: &'a str,
    pub tools: bool,
    pub web: bool,
    pub timer: bool,
    pub workspace: bool,
    pub groups: &'a [Group],
    pub catalog: &'a str,
    pub mail: &'a str,
    pub plan: bool,
    pub workshop: bool,
}

/// Today on the user's computer, as "Sunday 8 November 2026".
pub fn today() -> String {
    let t = crate::platform::local_time();
    date_words(i64::from(t.year), t.month, t.day)
}

fn date_words(year: i64, month: u32, day: u32) -> String {
    const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const DAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    let Some(name) = month.checked_sub(1).and_then(|m| MONTHS.get(m as usize)) else { return String::new() };
    // Sakamoto's day of the week.
    const T: [i64; 12] = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
    let y = if month < 3 { year - 1 } else { year };
    let weekday = (y + y.div_euclid(4) - y.div_euclid(100) + y.div_euclid(400) + T[(month - 1) as usize] + day as i64).rem_euclid(7);
    format!("{} {day} {name} {year}", DAYS[weekday as usize])
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
    // A local model knows only up to its training: "yesterday" means nothing to it otherwise.
    if !p.today.is_empty() {
        out.push_str(&format!(" Today is {}.", p.today));
    }
    if p.web {
        out.push_str(" web_search searches the web and web_fetch reads a page: use them for current or specific facts instead of guessing, and give the links you used. Your own knowledge stops before today: for news and anything recent, search, with the dates in the query when they matter. Never say you searched, or what a search found, without calling web_search.");
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
    if p.groups.contains(&Group::GitHub) {
        out.push_str(crate::github_tools::NOTE);
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
    if p.groups.contains(&Group::Plan) {
        out.push_str(" Whenever a job takes more than one step (creating or changing files, several tools in a row), call update_plan before any other tool, with every step (first in_progress, others pending), even if the user didn't ask for a plan; then call update_plan again as each step finishes. A question you just answer needs no plan.");
    }
    if p.tools {
        out.push_str(p.catalog);
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

    #[test]
    fn today_is_said_with_its_day_of_the_week() {
        assert_eq!(date_words(2026, 11, 8), "Sunday 8 November 2026");
        assert_eq!(date_words(2024, 2, 29), "Thursday 29 February 2024");
        assert_eq!(date_words(2000, 1, 1), "Saturday 1 January 2000");
        assert_eq!(date_words(2026, 13, 1), "");
    }

    fn tool(id: &str) -> (String, String, Value) {
        (id.to_string(), "Does it.".to_string(), json!({}))
    }

    #[test]
    fn the_question_brings_in_its_groups() {
        let user = vec![tool("pdfcraft")];
        assert_eq!(named_groups("Ciao, che mi racconti?", &user), vec![]);
        assert_eq!(named_groups("Leggimi l'ultima mail di Marco", &user), vec![Group::Mail]);
        assert_eq!(named_groups("Quali PR ho aperte su GitHub e come va la CI?", &user), vec![Group::GitHub]);
        assert_eq!(named_groups("Controlla le ultime issue del mio repo", &user), vec![Group::GitHub]);
        assert_eq!(named_groups("Avvisami quando finiscono i check", &user), vec![Group::Listen]);
        assert_eq!(named_groups("Avvisami quando la pull request passa", &user), vec![Group::GitHub, Group::Listen]);
        // A pull request or its link still brings in the listening tools, as before GitHub's own.
        assert_eq!(named_groups("Segui https://github.com/Rccrd12/Lumo/pull/3", &user), vec![Group::GitHub, Group::Listen]);
        assert_eq!(named_groups("Quando la pull request viene approvata?", &user), vec![Group::GitHub, Group::Listen]);
        assert_eq!(named_groups("Ei, mi dici se la cartella download cambia?", &user), vec![Group::Listen]);
        assert_eq!(named_groups("Fammi un piano passo dopo passo", &user), vec![Group::Plan]);
        assert_eq!(named_groups("Unisci questi pdf con pdfcraft", &user), vec![Group::User]);
    }

    #[test]
    fn a_turn_starts_with_the_core_tools_and_a_catalog_of_the_rest() {
        let all = vec![
            tool("set_timer"),
            tool("update_plan"),
            tool("listen"),
            tool("mail_read"),
            tool("mail_search"),
            tool("github_overview"),
            tool("github_pr_view"),
            tool("web_search"),
            tool("workspace_copy"),
            tool("pdfcraft"),
        ];
        let names = |v: Vec<(String, String, Value)>| v.into_iter().map(|t| t.0).collect::<Vec<_>>();
        assert_eq!(names(pick(&all, &[])), ["set_timer", "web_search", "workspace_copy", MORE]);
        let with_mail = in_groups(&all, &[Group::Mail]);
        assert_eq!(names(pick(&all, &with_mail)), ["set_timer", "mail_read", "mail_search", "web_search", "workspace_copy", MORE]);
        let with_gh = in_groups(&all, &[Group::GitHub]);
        assert_eq!(names(pick(&all, &with_gh)), ["set_timer", "github_overview", "github_pr_view", "web_search", "workspace_copy", MORE]);
        let everything: Vec<String> = all.iter().map(|t| t.0.clone()).collect();
        assert_eq!(names(pick(&all, &everything)).last().map(String::as_str), Some("pdfcraft"), "nothing left, no lumo_tools");
        let catalog = catalog(&all, &[]);
        assert!(catalog.contains("- mail_read, mail_search: the user's email"));
        assert!(catalog.contains("- github_overview, github_pr_view: the user's GitHub"));
        assert!(catalog.contains("- update_plan: show and tick off a step-by-step plan"));
        assert!(catalog.contains("- listen: be told when a file or folder changes"));
        assert!(catalog.contains("- pdfcraft: Does it"));
        assert!(!catalog.contains("workspace_copy"));
        assert_eq!(asked(&all, &json!({"names": ["listen", "nope"]})), ["listen"]);
        assert_eq!(asked(&all, &json!({"names": ["mail"]})), ["mail_read", "mail_search"]);
        assert_eq!(asked(&all, &json!({"names": ["github"]})), ["github_overview", "github_pr_view"]);
        assert_eq!(asked(&all, &json!({"names": ["plan"]})), ["update_plan"]);
        assert!(in_catalog(&all, &["set_timer".into()], "listen"));
        assert!(in_catalog(&all, &["set_timer".into()], "github_overview"));
        assert!(!in_catalog(&all, &["set_timer".into()], "set_timer"));
    }

    #[test]
    fn tools_stay_with_their_chat() {
        assert_eq!(loaded("chat-a", &["listen".into()]), ["listen"]);
        assert_eq!(loaded("chat-a", &[]), ["listen"]);
        assert!(loaded("chat-b", &[]).is_empty());
    }

    #[test]
    fn long_descriptions_keep_their_first_sentences() {
        let long = format!("First one. Second one. {}", "x".repeat(400));
        assert_eq!(short(&long), "First one. Second one.");
        assert_eq!(short("Short."), "Short.");
    }
}
