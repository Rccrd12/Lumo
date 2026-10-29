// The island's own tools for the chat's agents: a timer (`set_timer`), and
// listening (`listen`, `stop_listening`, `list_listening`). `listen` takes a
// source and a target: a pull request on GitHub, or on this PC a file or a
// folder, a program or a port, a web page (listen_local.rs).
// `listen_pull_request`, its name before, still works.
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
pub const LISTEN: &str = "listen";
/// `listen`'s name before: still answered, no longer offered.
pub const LISTEN_PULL_REQUEST: &str = "listen_pull_request";
pub const UNLISTEN: &str = "stop_listening";
pub const LIST: &str = "list_listening";
/// Every one offered.
pub const NAMES: &[&str] = &[SET_TIMER, LISTEN, UNLISTEN, LIST];

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
        let target = json!({
            "source": {
                "type": "string",
                "enum": crate::listen::SOURCES,
                "description": "Where to listen. github.pr: a pull request on GitHub. fs: a file or a folder on this PC. \
process: a program running on this PC, or a port on it. web: a web page. email: the user's inbox (the Email pill). \
service: one of the user's services (vercel, stripe, n8n, resend, notion, calcom) or their calendar. windows: Windows \
itself. agent: a coding agent's session (Claude Code, Codex and the others). webhook: an address on this PC that other \
programs can call. tool: one of the user's own tools, run now and then.",
            },
            "target": {
                "type": "string",
                "description": "What to listen to: for github.pr, owner/repository#number or the pull request's link; \
for fs, the full path (C:\\Users\\name\\Downloads, or ~\\Downloads); for process, the executable's name (node.exe) or, \
with port_open or port_closed, the port number; for web, the link; for email, the sender (from) or words of the \
subject (subject), nothing for new; for service, the service, or calendar; for windows, the app whose notifications \
to wait for, else nothing; for agent, any or one of claude, codex, gemini, antigravity, cursor, copilot, opencode, \
amp, hermes, muse; for webhook, a short name; for tool, the tool's id.",
            },
        });
        let mut watch = target.clone();
        watch["event"] = json!({
            "type": "string",
            "enum": events(),
            "description": "github.pr: checks (finished, passed or failed), green (passed), approved, ready (checks \
passed and it can be merged), merged, closed. fs: created, changed, deleted, download (a download finished in the \
folder). process: started, exited, port_open, port_closed. web: changed (what the page shows), up, down, contains \
(the page shows text). email: new, from, subject. service: event, succeeded, failed, or soon for the calendar (an \
event starts within amount minutes). windows: notification, battery_low, plugged, unplugged, offline, online, usb (a \
drive is connected), back (the user is back after amount minutes away). agent: finished, permission (it asks for a \
permission or a reply), failed. webhook: called. tool: changed (what it prints), contains.",
        });
        watch["mode"] = json!({
            "type": "string",
            "enum": crate::listen::MODES,
            "description": "once (the default): it ends when the event happens. every: it fires again each time; on \
github.pr only for checks or green, once for each new commit, until the pull request is merged or closed.",
        });
        watch["text"] = json!({
            "type": "string",
            "maxLength": 200,
            "description": "contains only (web, tool): the text to wait for.",
        });
        watch["amount"] = json!({
            "type": "integer",
            "minimum": 1,
            "maximum": 1440,
            "description": "service soon: the minutes before the event (10). windows battery_low: the percent (20); \
back: the minutes away (5). tool: the minutes between two runs (15). Leave it out for the rest.",
        });
        watch["then"] = json!({
            "type": "string",
            "maxLength": MAX_TASK,
            "description": "What you will do then, e.g. merge it with gh pr merge --squash. Leave it out when the user \
only wants to be told.",
        });
        all.push(tool(
            LISTEN,
            "Lumo listens for an event and tells the user once it happens; with something to do then, it sends you a \
message in this chat that says what happened, and you do it then. Use it instead of waiting, sleeping or polling \
yourself, then say in a few words that Lumo is listening and end your answer.",
            watch,
            &["source", "target", "event"],
        ));
        all.push(tool(UNLISTEN, "Stops listening to something Lumo listens to.", target, &["target"]));
        all.push(tool(LIST, "Lists what Lumo is listening to, in every chat.", json!({}), &[]));
    }
    all
}

/// Every event of every source, once each.
fn events() -> Vec<&'static str> {
    let mut all: Vec<&str> = crate::listen::UNTILS.to_vec();
    for source in &crate::listen::SOURCES[1..] {
        for until in crate::listen_local::untils(source) {
            if !all.contains(until) {
                all.push(until);
            }
        }
    }
    all
}

/// The source a call names, as listen.rs calls it (GitHub when it names none).
fn source_of(input: &Value) -> Result<&'static str, String> {
    match input["source"].as_str().unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "" | "github" | "github.pr" | "pr" => Ok(crate::listen::GITHUB),
        "fs" | "file" | "files" | "folder" => Ok("fs"),
        "process" | "program" | "port" | "app" => Ok("process"),
        "web" | "page" | "url" | "site" => Ok("web"),
        "email" | "mail" | "inbox" => Ok("email"),
        "service" | "services" | "calendar" => Ok("service"),
        "windows" | "pc" | "system" | "notifications" | "battery" | "network" | "usb" => Ok("windows"),
        "agent" | "agents" | "session" | "claude" | "codex" => Ok("agent"),
        "webhook" | "hook" => Ok("webhook"),
        "tool" | "own_tool" => Ok("tool"),
        _ => Err(format!("source must be one of {}.", crate::listen::SOURCES.join(", "))),
    }
}

/// `[[listen web "https://…" every changed: then]]` and what the model is told, for a watch on this PC.
fn local_line(source: &str, input: &Value) -> Result<(String, String), String> {
    let event = input["event"].as_str().unwrap_or("").trim().to_ascii_lowercase();
    let text = clean(input["text"].as_str().unwrap_or(""), 200).replace('"', "'");
    let home = crate::platform::home_dir();
    let target = crate::listen_local::target(source, &event, input["target"].as_str().unwrap_or(""), &text, &home)?;
    let amount = crate::listen_local::amount_of(source, &event, input["amount"].as_u64().unwrap_or(0).min(u32::MAX as u64) as u32);
    let mode = input["mode"].as_str().unwrap_or("once").trim().to_ascii_lowercase();
    if !crate::listen::mode_ok(source, &event, if mode.is_empty() { "once" } else { mode.as_str() }) {
        return Err("mode must be once or every.".into());
    }
    let every = if mode == "every" { "every " } else { "" };
    let mut words = if event == "contains" { format!(" \"{text}\"") } else { String::new() };
    if amount > 0 {
        words.push_str(&format!(" {amount}"));
    }
    let then = clean(input["then"].as_str().unwrap_or(""), MAX_TASK);
    let head = format!("[[listen {source} \"{target}\" {every}{event}{words}");
    let line = if then.is_empty() { format!("{head}]]") } else { format!("{head}: {then}]]") };
    let after = if then.is_empty() {
        "Lumo will tell the user."
    } else {
        "Lumo will tell the user and send you a message in this chat starting with Lumo: that says what happened; do \
what you meant to then."
    };
    let after = if every.is_empty() { after.to_string() } else { format!("{after} It does so again each time.") };
    let what = crate::listen_local::label(source, &event, &target);
    Ok((line, format!("Lumo listens to {what} as soon as your answer ends. {after} Say in a few words that Lumo is listening, and end your answer.")))
}

/// `[[unlisten fs "C:\…"]]`: the target as listen.rs keeps it, whatever the event.
fn local_unlisten(source: &str, input: &Value) -> Result<(String, String), String> {
    let given = input["target"].as_str().unwrap_or("");
    let home = crate::platform::home_dir();
    let target = if matches!(source, "fs" | "process" | "web") {
        ["changed", "port_open", "started"].iter().find_map(|until| crate::listen_local::target(source, until, given, "x", &home).ok())
    } else {
        // As kept: the services and agents by their names in a watch.
        let named = crate::listen_local::canonical(source, given);
        (!named.is_empty() && !named.contains(['"', '[', ']'])).then_some(named)
    }
    .ok_or_else(|| "Give the target as Lumo listens to it (list_listening says).".to_string())?;
    Ok((format!("[[unlisten {source} \"{target}\"]]"), format!("Lumo stops listening to {target} as soon as your answer ends.")))
}

/// Text that goes inside `[[…]]`: one line, no brackets, at most `max` characters.
fn clean(text: &str, max: usize) -> String {
    let one: String = text.chars().map(|c| if c.is_control() || c == '[' || c == ']' { ' ' } else { c }).collect();
    one.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect()
}

/// `owner/repo#12`, `owner/repo/pull/12` or the pull request's link.
fn pull_request_of(target: &str) -> Option<(String, u64)> {
    let text = target.trim().trim_start_matches('<').trim_end_matches('>');
    let text = text.split_once("://").map_or(text, |(_, rest)| rest);
    let text = text.strip_prefix("www.").unwrap_or(text);
    let text = text.strip_prefix("github.com/").unwrap_or(text);
    let (repo, number) = if let Some((repo, number)) = text.split_once('#') {
        (repo.trim().to_string(), number.trim())
    } else {
        let parts: Vec<&str> = text.split('/').collect();
        match parts.as_slice() {
            [owner, name, "pull" | "pulls", number, ..] => (format!("{owner}/{name}"), *number),
            _ => return None,
        }
    };
    let repo = repo.trim_end_matches(".git").to_string();
    let number: u64 = number.trim_start_matches('#').parse().ok()?;
    crate::listen::valid(&repo, number, "checks").then_some((repo, number))
}

/// The pull request a call names: `target` (and `source`), or `repo` and `number` as before.
fn pull_request(input: &Value) -> Result<(String, u64), String> {
    if let Some(target) = input["target"].as_str() {
        return pull_request_of(target).ok_or_else(|| "Give the target as owner/repository#number or the pull request's link.".into());
    }
    let repo = input["repo"].as_str().unwrap_or("").trim().trim_end_matches(".git").to_string();
    let number = input["number"].as_u64().or_else(|| input["number"].as_str().and_then(|n| n.trim().trim_start_matches('#').parse().ok()));
    match number {
        Some(n) if crate::listen::valid(&repo, n, "checks") => Ok((repo, n)),
        _ => Err("Give the repository as owner/repository and the pull request's number.".into()),
    }
}

/// What Lumo listens to, for `list_listening`.
fn listening_text(watches: &[crate::listen::Watch], chat_id: &str) -> String {
    if watches.is_empty() {
        return "Lumo is not listening to anything.".into();
    }
    let rows: Vec<String> = watches
        .iter()
        .map(|w| {
            let mut row = format!("- {} {} ({})", w.label(), w.until, w.mode);
            if w.paused {
                row.push_str(", paused");
            }
            if w.chat_id == chat_id {
                row.push_str(", this chat");
            }
            if !w.task.is_empty() {
                row.push_str(&format!(": then {}", w.task));
            }
            row
        })
        .collect();
    format!("Lumo is listening to:\n{}", rows.join("\n"))
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
        LISTEN | LISTEN_PULL_REQUEST => {
            let source = source_of(input)?;
            if source != crate::listen::GITHUB {
                return local_line(source, input);
            }
            let (repo, number) = pull_request(input)?;
            let event = input["event"].as_str().unwrap_or("").trim().to_ascii_lowercase();
            if !crate::listen::UNTILS.contains(&event.as_str()) {
                return Err(format!("event must be one of {}.", crate::listen::UNTILS.join(", ")));
            }
            let mode = input["mode"].as_str().unwrap_or("once").trim().to_ascii_lowercase();
            if !crate::listen::mode_ok(source, &event, if mode.is_empty() { "once" } else { mode.as_str() }) {
                return Err(format!("mode must be once, or every with {}.", crate::listen::EVERY_UNTILS.join(" or ")));
            }
            let every = if mode == "every" { "every " } else { "" };
            let then = clean(input["then"].as_str().unwrap_or(""), MAX_TASK);
            let line = if then.is_empty() {
                format!("[[listen {repo}#{number} {every}{event}]]")
            } else {
                format!("[[listen {repo}#{number} {every}{event}: {then}]]")
            };
            let after = if then.is_empty() {
                "Lumo will tell the user."
            } else {
                "Lumo will tell the user and send you a message in this chat starting with GitHub: that says what \
happened; do what you meant to only if it is what you waited for."
            };
            let after = if every.is_empty() { after.to_string() } else { format!("{after} It does so again for each new commit.") };
            Ok((line, format!("Lumo listens to {repo}#{number} as soon as your answer ends. {after} Say in a few words that Lumo is listening, and end your answer.")))
        }
        UNLISTEN => {
            let source = source_of(input)?;
            if source != crate::listen::GITHUB {
                return local_unlisten(source, input);
            }
            let (repo, number) = pull_request(input)?;
            Ok((format!("[[unlisten {repo}#{number}]]"), format!("Lumo stops listening to {repo}#{number} as soon as your answer ends.")))
        }
        _ => Err(format!("Lumo has no tool called {tool}.")),
    }
}

/// A call for the chat `chat_id`: its line is kept for the answer. What goes
/// back to the model, and whether it failed.
pub fn call(chat_id: &str, tool: &str, input: &Value) -> (String, bool) {
    if tool == LIST {
        return (listening_text(&crate::listen::list(), chat_id), false);
    }
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
        assert_eq!(ok(LISTEN, json!({ "source": "github.pr", "target": "octocat/hello#42", "event": "checks" })), "[[listen octocat/hello#42 checks]]");
        assert_eq!(
            ok(LISTEN, json!({ "source": "github.pr", "target": "https://github.com/octocat/hello/pull/42/files", "event": "green", "mode": "every", "then": "fix what failed" })),
            "[[listen octocat/hello#42 every green: fix what failed]]"
        );
        // Its name before, with repo and number, still works.
        assert_eq!(ok(LISTEN_PULL_REQUEST, json!({ "repo": "octocat/hello", "number": 42, "event": "checks" })), "[[listen octocat/hello#42 checks]]");
        assert_eq!(
            ok(LISTEN_PULL_REQUEST, json!({ "repo": "octocat/hello.git", "number": "#42", "event": "Ready", "then": "merge it: gh pr merge --squash ]]" })),
            "[[listen octocat/hello#42 ready: merge it: gh pr merge --squash]]"
        );
        assert_eq!(ok(UNLISTEN, json!({ "repo": "octocat/hello", "number": 42 })), "[[unlisten octocat/hello#42]]");
        assert_eq!(ok(UNLISTEN, json!({ "target": "octocat/hello/pull/42" })), "[[unlisten octocat/hello#42]]");
    }

    #[test]
    fn a_watch_on_this_pc_becomes_its_line() {
        let ok = |tool: &str, input: Value| line(tool, &input).unwrap().0;
        assert_eq!(
            ok(LISTEN, json!({ "source": "fs", "target": "C:\\Users\\me\\Downloads\\", "event": "download", "mode": "every", "then": "sort it" })),
            "[[listen fs \"C:\\Users\\me\\Downloads\" every download: sort it]]"
        );
        assert_eq!(ok(LISTEN, json!({ "source": "program", "target": "Code", "event": "exited" })), "[[listen process \"code.exe\" exited]]");
        assert_eq!(ok(LISTEN, json!({ "source": "process", "target": "localhost:3000", "event": "port_open" })), "[[listen process \"3000\" port_open]]");
        assert_eq!(
            ok(LISTEN, json!({ "source": "web", "target": "https://example.com/p", "event": "contains", "text": "In \"stock\"" })),
            "[[listen web \"https://example.com/p\" contains \"In 'stock'\"]]"
        );
        assert_eq!(ok(UNLISTEN, json!({ "source": "web", "target": "https://example.com/p" })), "[[unlisten web \"https://example.com/p\"]]");
        assert_eq!(ok(UNLISTEN, json!({ "source": "process", "target": "3000" })), "[[unlisten process \"3000\"]]");
        assert!(line(LISTEN, &json!({ "source": "fs", "target": "Downloads", "event": "created" })).is_err());
        assert!(line(LISTEN, &json!({ "source": "web", "target": "https://example.com", "event": "contains" })).is_err());
        assert!(line(LISTEN, &json!({ "source": "fs", "target": "C:\\x", "event": "merged" })).is_err());
        // What Lumo hears, and Windows.
        assert_eq!(ok(LISTEN, json!({ "source": "email", "target": "Marco", "event": "from", "then": "reply" })), "[[listen email \"Marco\" from: reply]]");
        assert_eq!(ok(LISTEN, json!({ "source": "agent", "target": "Claude Code", "event": "finished", "mode": "every" })), "[[listen agent \"claude\" every finished]]");
        assert_eq!(ok(LISTEN, json!({ "source": "calendar", "target": "", "event": "soon", "amount": 15 })), "[[listen service \"calendar\" soon 15]]");
        assert_eq!(ok(LISTEN, json!({ "source": "battery", "event": "battery_low" })), "[[listen windows \"pc\" battery_low 20]]");
        assert_eq!(ok(LISTEN, json!({ "source": "webhook", "target": "Deploys", "event": "called" })), "[[listen webhook \"deploys\" called]]");
        assert_eq!(ok(UNLISTEN, json!({ "source": "service", "target": "Cal.com" })), "[[unlisten service \"calcom\"]]");
        assert!(line(LISTEN, &json!({ "source": "service", "target": "jira", "event": "event" })).is_err());
    }

    #[test]
    fn what_cant_be_done_is_said_to_the_model() {
        assert!(line(SET_TIMER, &json!({ "seconds": 0 })).is_err());
        assert!(line(SET_TIMER, &json!({ "seconds": MAX_SECONDS + 1 })).is_err());
        assert!(line(LISTEN, &json!({ "repo": "octocat", "number": 42, "event": "checks" })).is_err());
        assert!(line(LISTEN, &json!({ "repo": "../x/y", "number": 42, "event": "checks" })).is_err());
        assert!(line(LISTEN, &json!({ "repo": "octocat/hello", "number": 42, "event": "deployed" })).is_err());
        assert!(line(LISTEN, &json!({ "source": "github.pr", "target": "octocat/hello", "event": "checks" })).is_err());
        assert!(line(LISTEN, &json!({ "source": "slack", "target": "octocat/hello#1", "event": "checks" })).is_err());
        assert!(line(LISTEN, &json!({ "source": "github.pr", "target": "octocat/hello#1", "event": "merged", "mode": "every" })).is_err());
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
        assert!(serve(&json!({ "tool": SET_TIMER, "input": { "seconds": 0 }, "chat": "chat-c" }))["error"].is_string());
        assert_eq!(take("chat-c"), "");
    }

    #[test]
    fn the_list_says_what_lumo_listens_to() {
        assert_eq!(listening_text(&[], "c"), "Lumo is not listening to anything.");
        let w: crate::listen::Watch = serde_json::from_value(json!({
            "id": 1, "repo": "o/r", "number": 3, "until": "ready", "task": "merge it", "chatId": "c", "startedAt": 0, "paused": true
        }))
        .unwrap();
        assert_eq!(listening_text(&[w], "c"), "Lumo is listening to:\n- o/r#3 ready (once), paused, this chat: then merge it");
    }

    #[test]
    fn the_github_tools_go_only_to_the_agents_that_can_act() {
        let names = |listen| api_tools(listen).into_iter().map(|t| t.0).collect::<Vec<_>>();
        assert_eq!(names(false), [SET_TIMER]);
        assert_eq!(names(true), NAMES);
    }
}
