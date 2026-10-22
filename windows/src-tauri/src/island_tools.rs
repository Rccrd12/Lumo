// The island's own tools for the chat's agents: a timer (`set_timer`), and
// listening to a pull request on GitHub (`listen_pull_request`,
// `stop_listening`).
//
// They do what the `[[timer …]]`, `[[listen …]]` and `[[unlisten …]]` lines
// do (chat.rs timer_note, listen_tool_note), as real tools: the model gets told at
// once when what it asked for can't be done (a repository that isn't one, an
// event Lumo can't watch), instead of the line being dropped.
//
// Claude Code and Antigravity CLI get them from lumo-hook's MCP server
// (`--tools=island`), which hands each call here over the pipe
// (`{"lumo_island": {"tool": …, "input": …, "chat": …}}`, pipe.rs); the chat's
// API providers call `call` themselves (claude.rs, openai_compat.rs). A call
// becomes the very line the model would have written, kept for its chat until
// the turn's answer comes back (chat.rs dispatch adds it), so the island starts
// the timer and the watch the way it always did (src/core/compact.ts
// takeTimers, src/core/listen.ts takeListens). The lines stay the fallback for
// a model without tools, and for a call Lumo can't tie to a chat.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{json, Value};

pub const SET_TIMER: &str = "set_timer";
pub const LISTEN: &str = "listen_pull_request";
pub const UNLISTEN: &str = "stop_listening";
/// Every one of them.
pub const NAMES: &[&str] = &[SET_TIMER, LISTEN, UNLISTEN];

/// The longest timer: a day.
const MAX_SECONDS: u64 = 24 * 3600;
const MAX_LABEL: usize = 80;
const MAX_TASK: usize = 500;

/// The lines for Lumo the tools asked for, by chat id, until its answer comes back.
static PENDING: Mutex<Option<HashMap<String, Vec<String>>>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut HashMap<String, Vec<String>>) -> T) -> T {
    f(PENDING.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new))
}

/// One tool: its name, what it does, and the JSON schema of its input.
fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> (String, String, Value) {
    let schema = json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false });
    (name.to_string(), description.to_string(), schema)
}

/// The tools, as the chat's API providers take them: name, the words the
/// model reads, the JSON schema of the input. `listen`: the GitHub ones too,
/// for the agents that can act once it happens.
pub fn api_tools(listen: bool) -> Vec<(String, String, Value)> {
    let mut all = vec![tool(
        SET_TIMER,
        "Starts a timer on Lumo's island. Use it only when the user asks for a timer or to be reminded in some \
time, then say in a few words that it is set.",
        json!({
            "seconds": { "type": "integer", "minimum": 1, "maximum": MAX_SECONDS, "description": "How long: 600 for 10 minutes." },
            "label": { "type": "string", "maxLength": MAX_LABEL, "description": "What it is for, in a few words, in the user's language." },
        }),
        &["seconds"],
    )];
    if listen {
        let pr = json!({
            "repo": { "type": "string", "description": "owner/repository on GitHub, e.g. octocat/hello." },
            "number": { "type": "integer", "minimum": 1, "description": "The pull request's number." },
        });
        let mut watch = pr.clone();
        watch["event"] = json!({
            "type": "string",
            "enum": crate::listen::UNTILS,
            "description": "checks: its checks finished, passed or failed. green: they passed. approved. ready: checks \
passed and it can be merged. merged. closed.",
        });
        watch["then"] = json!({
            "type": "string",
            "maxLength": MAX_TASK,
            "description": "What you will do then, e.g. merge it with gh pr merge --squash. Leave it out when the user \
only wants to be told.",
        });
        all.push(tool(
            LISTEN,
            "Lumo watches a pull request on GitHub and tells the user once the event happens; with something to do \
then, it sends you a message in this chat starting with GitHub: and you do it then. Use it instead of waiting, \
sleeping or polling yourself, then say in a few words that Lumo is listening and end your answer.",
            watch,
            &["repo", "number", "event"],
        ));
        all.push(tool(UNLISTEN, "Stops listening to a pull request on GitHub.", pr, &["repo", "number"]));
    }
    all
}

/// Text that goes inside `[[…]]`: one line, no brackets, at most `max` characters.
fn clean(text: &str, max: usize) -> String {
    let one: String = text.chars().map(|c| if c.is_control() || c == '[' || c == ']' { ' ' } else { c }).collect();
    one.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}

fn pull_request(input: &Value) -> Result<(String, u64), String> {
    let repo = input["repo"].as_str().unwrap_or("").trim().trim_end_matches(".git").to_string();
    let number = input["number"].as_u64().or_else(|| input["number"].as_str().and_then(|n| n.trim().trim_start_matches('#').parse().ok()));
    match number {
        Some(n) if crate::listen::valid(&repo, n, "checks") => Ok((repo, n)),
        _ => Err("Give the repository as owner/repository and the pull request's number.".into()),
    }
}

/// The line for Lumo a call stands for, and what the model is told; or why it can't be done.
pub fn line(tool: &str, input: &Value) -> Result<(String, String), String> {
    match tool {
        SET_TIMER => {
            let seconds = input["seconds"].as_u64().or_else(|| input["seconds"].as_f64().filter(|s| *s >= 1.0).map(|s| s.round() as u64));
            let Some(seconds) = seconds.filter(|s| (1..=MAX_SECONDS).contains(s)) else {
                return Err(format!("seconds must be a whole number from 1 to {MAX_SECONDS}."));
            };
            let label = clean(input["label"].as_str().unwrap_or(""), MAX_LABEL);
            let line = if label.is_empty() { format!("[[timer {seconds}s]]") } else { format!("[[timer {seconds}s: {label}]]") };
            Ok((line, "The timer starts on the island as soon as your answer ends. Say in a few words that it is set.".into()))
        }
        LISTEN => {
            let (repo, number) = pull_request(input)?;
            let event = input["event"].as_str().unwrap_or("").trim().to_ascii_lowercase();
            if !crate::listen::UNTILS.contains(&event.as_str()) {
                return Err(format!("event must be one of {}.", crate::listen::UNTILS.join(", ")));
            }
            let then = clean(input["then"].as_str().unwrap_or(""), MAX_TASK);
            let line = if then.is_empty() { format!("[[listen {repo}#{number} {event}]]") } else { format!("[[listen {repo}#{number} {event}: {then}]]") };
            let after = if then.is_empty() {
                "Lumo will tell the user."
            } else {
                "Lumo will tell the user and send you a message in this chat starting with GitHub: that says what \
happened; do what you meant to only if it is what you waited for."
            };
            Ok((line, format!("Lumo listens to {repo}#{number} as soon as your answer ends. {after} Say in a few words that Lumo is listening, and end your answer.")))
        }
        UNLISTEN => {
            let (repo, number) = pull_request(input)?;
            Ok((format!("[[unlisten {repo}#{number}]]"), format!("Lumo stops listening to {repo}#{number} as soon as your answer ends.")))
        }
        _ => Err(format!("Lumo has no tool called {tool}.")),
    }
}

/// A call for the chat `chat_id`: its line is kept for the answer. What goes
/// back to the model, and whether it failed.
pub fn call(chat_id: &str, tool: &str, input: &Value) -> (String, bool) {
    if chat_id.is_empty() {
        return ("Lumo can't tell which chat this is for: write the line for Lumo in your answer instead.".into(), true);
    }
    match line(tool, input) {
        Ok((line, said)) => {
            with(|pending| pending.entry(chat_id.to_string()).or_default().push(line));
            (said, false)
        }
        Err(why) => (why, true),
    }
}

/// `{"lumo_island": {"tool": …, "input": …, "chat": …}}` from lumo-hook's MCP server.
pub fn serve(request: &Value) -> Value {
    let chat = request["chat"].as_str().unwrap_or("");
    let tool = request["tool"].as_str().unwrap_or("");
    match call(chat, tool, &request["input"]) {
        (text, false) => json!({ "text": text }),
        (error, true) => json!({ "error": error }),
    }
}

/// The lines the tools asked for during the chat's turn, taken: one per line.
pub fn take(chat_id: &str) -> String {
    with(|pending| pending.remove(chat_id)).map(|lines| lines.join("\n")).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_call_becomes_the_line_the_island_already_reads() {
        let ok = |tool: &str, input: Value| line(tool, &input).unwrap().0;
        assert_eq!(ok(SET_TIMER, json!({ "seconds": 600, "label": "Pasta [al dente]\n" })), "[[timer 600s: Pasta al dente]]");
        assert_eq!(ok(SET_TIMER, json!({ "seconds": 90 })), "[[timer 90s]]");
        assert_eq!(ok(LISTEN, json!({ "repo": "octocat/hello", "number": 42, "event": "checks" })), "[[listen octocat/hello#42 checks]]");
        assert_eq!(
            ok(LISTEN, json!({ "repo": "octocat/hello.git", "number": "#42", "event": "Ready", "then": "merge it: gh pr merge --squash ]]" })),
            "[[listen octocat/hello#42 ready: merge it: gh pr merge --squash]]"
        );
        assert_eq!(ok(UNLISTEN, json!({ "repo": "octocat/hello", "number": 42 })), "[[unlisten octocat/hello#42]]");
    }

    #[test]
    fn what_cant_be_done_is_said_to_the_model() {
        assert!(line(SET_TIMER, &json!({ "seconds": 0 })).is_err());
        assert!(line(SET_TIMER, &json!({ "seconds": MAX_SECONDS + 1 })).is_err());
        assert!(line(LISTEN, &json!({ "repo": "octocat", "number": 42, "event": "checks" })).is_err());
        assert!(line(LISTEN, &json!({ "repo": "../x/y", "number": 42, "event": "checks" })).is_err());
        assert!(line(LISTEN, &json!({ "repo": "octocat/hello", "number": 42, "event": "deployed" })).is_err());
        assert!(line("rm", &json!({})).is_err());
    }

    #[test]
    fn the_lines_wait_for_their_own_chat_and_go_once() {
        assert!(!call("chat-a", SET_TIMER, &json!({ "seconds": 60, "label": "tea" })).1);
        assert!(!call("chat-b", UNLISTEN, &json!({ "repo": "o/r", "number": 3 })).1);
        assert!(!call("chat-a", LISTEN, &json!({ "repo": "o/r", "number": 3, "event": "merged" })).1);
        assert_eq!(take("chat-a"), "[[timer 60s: tea]]\n[[listen o/r#3 merged]]");
        assert_eq!(take("chat-a"), "");
        assert_eq!(take("chat-b"), "[[unlisten o/r#3]]");
        // Without a chat, the model is told to write the line itself.
        let (said, failed) = call("", SET_TIMER, &json!({ "seconds": 60 }));
        assert!(failed && said.contains("line"));
        assert_eq!(serve(&json!({ "tool": SET_TIMER, "input": { "seconds": 0 }, "chat": "chat-c" }))["error"].is_string(), true);
        assert_eq!(take("chat-c"), "");
    }

    #[test]
    fn the_github_tools_go_only_to_the_agents_that_can_act() {
        let names = |listen| api_tools(listen).into_iter().map(|t| t.0).collect::<Vec<_>>();
        assert_eq!(names(false), [SET_TIMER]);
        assert_eq!(names(true), NAMES);
    }
}
