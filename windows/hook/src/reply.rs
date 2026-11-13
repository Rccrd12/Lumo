//! What the relay prints back to the agent — the only place that knows each
//! agent's stdout contract.
//!
//! The one rule that matters: **nothing that allows anything is ever printed
//! without a decision a human clicked.** With no decision the reply is silence,
//! an empty `{}`, or Copilot's explicit "ask", and every agent then asks in its
//! own terminal exactly as if Lumo were not installed.

use serde_json::{json, Map, Value};

/// The agents whose permission requests the island can answer: Claude Code
/// (no `--agent`, in a terminal or in the Claude app), Codex, Copilot CLI,
/// Muse Code and OpenCode (its plugin's `permission.ask`, agents.rs). Any
/// decision for another agent is ignored here too, whatever the app sent.
pub fn takes_decisions(agent: &str) -> bool {
    matches!(agent, "" | "claude-desktop" | "codex" | "copilot" | "muse" | "opencode")
}

/// Agents that read a JSON object on stdout after every hook and get `{}` —
/// "no opinion" — when there is nothing to say.
fn wants_json(agent: &str) -> bool {
    matches!(agent, "gemini" | "antigravity" | "copilot" | "muse")
}

/// The line to print for `event` from `agent`, given the island's `decision`
/// (`None`: nobody clicked) and, for Claude Code's AskUserQuestion, the
/// question as it was asked.
pub fn stdout(agent: &str, event: &str, decision: Option<&str>, question: Option<&Value>) -> Option<String> {
    if event != "PermissionRequest" {
        // Antigravity reads "{}" on PreToolUse as a denial. "ask" keeps its own prompt
        // (and the user's Always Allow): Lumo never allows a tool by itself.
        if agent.eq_ignore_ascii_case("antigravity") && event == "PreToolUse" {
            return Some(r#"{"decision":"ask"}"#.to_string());
        }
        return wants_json(agent).then(|| "{}".to_string());
    }
    let decision = decision.filter(|_| takes_decisions(agent));
    // "Approve and let it edit files" is Claude Code's alone (its plan mode):
    // for anyone else it is the plain allow it also is.
    let decision = decision.map(|d| if d.trim() == "edits" && !matches!(agent, "" | "claude-desktop") { "allow" } else { d });
    match agent {
        // Copilot CLI and Muse Code read a bare permissionDecision. Copilot is
        // fail-closed: it must always get valid JSON, so silence is an "ask".
        "copilot" | "muse" => {
            let word = match decision.map(str::trim) {
                Some("allow" | "always" | "edits") => Some("allow"),
                Some("deny") => Some("deny"),
                _ => None,
            };
            match word {
                Some(word) => Some(json!({ "permissionDecision": word }).to_string()),
                None if agent == "copilot" => Some(json!({ "permissionDecision": "ask" }).to_string()),
                None => None,
            }
        }
        // Claude Code and Codex share the documented hookSpecificOutput. Only
        // Claude Code asks questions, in a terminal or in the Claude app.
        "" | "claude-desktop" => decision.and_then(|d| decision_json(d, question)),
        _ => decision.and_then(|d| decision_json(d, None)),
    }
}

/// The Antigravity tools the island's own chat (antigravity_cli.rs) shows a
/// card for: shell commands, MCP tools, the browser, the web (a page read or a
/// search carries in its address or its words whatever the model put there),
/// and any tool not on the lists below — what agy would ask about, and what
/// runs on nobody's say once agy's own confirmation is off. Its file tools
/// need none here (reads_outside and writes_outside decide by the path), and
/// neither does a call of Lumo's own email or plan tool, even through agy's
/// `call_mcp_tool`, nor one of its computer tools or of the user's own tools,
/// which Lumo asks for itself.
pub fn island_card(tool: &str, input: Option<&serde_json::Value>) -> bool {
    // The user's own tools: Lumo asks for each call itself (tools.rs in the app).
    if crate::mcp::user_tool_call(tool, input) {
        return false;
    }
    // Lumo's email tools only read the user's mailbox, or have Lumo's own
    // card (an email to send, a change), its plan tool only shows, its island
    // tools only start a timer or a watch (mcp.rs).
    // Its computer tools have Lumo's own card in the island's chat (computer.rs
    // `OtherTurn`, which asks as the chat's mode says).
    if crate::mcp::lumo_call(tool, input).is_some_and(|name| {
        crate::mcp::NAMES.contains(&name)
            || crate::mcp::MAIL_NAMES.contains(&name)
            || crate::mcp::MAIL_SEND_NAMES.contains(&name)
            || crate::mcp::MAIL_MANAGE_NAMES.contains(&name)
            || name == crate::mcp::PLAN_NAME
            || crate::mcp::ISLAND_NAMES.contains(&name)
    }) {
        return false;
    }
    let tool = agy_tool(tool);
    if tool.is_empty() {
        return false;
    }
    if ["command", "shell", "terminal", "mcp", "browser"].iter().any(|w| tool.contains(w)) {
        return true;
    }
    // Known, and on nobody's say only within what reads_outside and
    // writes_outside let through; anything else (`read_url_content`,
    // `search_web`, a subagent, a tool agy adds later) is a card.
    !(AGY_READS.contains(&tool.as_str()) || AGY_WRITES.contains(&tool.as_str()) || AGY_OWN.contains(&tool.as_str()))
}

/// Antigravity's tools that read files or folders: no card inside the run's
/// workspace (reads_outside).
const AGY_READS: &[&str] = &[
    "view_file", "view_file_outline", "view_code_item", "list_dir", "grep_search", "find_by_name", "codebase_search",
];

/// Antigravity's tools that change files: no card inside the run's workspace (writes_outside).
const AGY_WRITES: &[&str] = &["write_to_file", "replace_file_content", "multi_replace_file_content"];

/// Antigravity's own bookkeeping, which reaches nothing outside it: a chunk of
/// a page already read (whose reading was a card), its plan's steps, a word to
/// the user, its suggestions, its past conversations, an image of its model's.
const AGY_OWN: &[&str] = &[
    "view_content_chunk", "task_boundary", "notify_user", "suggested_responses", "trajectory_search", "generate_image",
];

/// A tool's name as agy's hooks give it, without a namespace (`default_api:view_file`), lower case.
fn agy_tool(tool: &str) -> String {
    tool.rsplit(':').next().unwrap_or(tool).trim().to_ascii_lowercase()
}

/// An Antigravity tool that reads (`view_file`, `list_dir`, `grep_search`…)
/// a file or folder outside the run's workspace (`workspaces`), or one that
/// holds keys or passwords wherever it is. agy reads anything without asking
/// once its own confirmation is off, and what it reads the model can send on
/// (a page's address, a search): so a read that leaves the workspace — the
/// chat's folder, the inbox of dropped files, the folders the user shared —
/// is a card, with its path on it. A path that cannot be placed for sure
/// (`..`, no workspace known, `~`, `$HOME`, `%USERPROFILE%`) is one too, and
/// so is a network path. Antigravity's own folder in the user's home
/// (`.gemini/antigravity…`, its plans) is its own to read (agy_own).
pub fn reads_outside(tool: &str, input: Option<&Value>, workspaces: &[String]) -> bool {
    if !AGY_READS.contains(&agy_tool(tool).as_str()) {
        return false;
    }
    let Some(input) = input.and_then(Value::as_object) else { return false };
    let roots: Vec<String> = workspaces.iter().map(|w| norm_path(w)).filter(|w| !w.is_empty()).collect();
    input
        .iter()
        .filter(|(key, _)| ["file", "path", "dir", "target"].iter().any(|w| key.to_ascii_lowercase().contains(w)))
        .flat_map(|(_, value)| match value {
            Value::String(s) => vec![s.as_str()],
            Value::Array(items) => items.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        })
        .filter(|path| !path.trim().is_empty())
        .any(|path| {
            let p = norm_path(path);
            if p.split('/').any(|part| part == "..") || holds_secrets(&p) {
                return true;
            }
            if agy_own(&p) {
                return false;
            }
            // The home folder or a variable the tool may expand: it can't be
            // placed for sure, as for a write.
            if p.starts_with(['~', '$']) || p.contains('%') {
                return true;
            }
            // A network path (`\\server\share`, `\\?\UNC\…`, `\\.\…`) is
            // absolute: only a card lets Windows reach that server.
            let absolute = p.starts_with('/') || p.as_bytes().get(1) == Some(&b':');
            absolute && !roots.iter().any(|r| p == *r || p.starts_with(&format!("{r}/")))
        })
}

/// Antigravity's own folder (its plans, its brain), as norm_path writes it:
/// `<drive>:/users/<name>/.gemini/antigravity…` or `~/.gemini/antigravity…`,
/// and only there. Not a `.gemini/antigravity` anywhere else in a path: on a
/// network share (`//server/x/.gemini/antigravity`) a read would reach that
/// server with no card.
fn agy_own(p: &str) -> bool {
    let parts: Vec<&str> = p.split('/').collect();
    let rest = match parts.as_slice() {
        [drive, "users", name, rest @ ..] if drive.len() == 2 && drive.ends_with(':') && drive.as_bytes()[0].is_ascii_alphabetic() && !name.is_empty() => rest,
        ["~", rest @ ..] => rest,
        _ => return false,
    };
    matches!(rest, [".gemini", "antigravity", ..])
}

/// A path (as norm_path writes it) to keys, passwords, sign-ins or a browser's
/// profile: a card even inside the workspace. The app's live.rs is_sensitive
/// is the fuller list, for what Lumo itself reads.
fn holds_secrets(p: &str) -> bool {
    const DIRS: &[&str] = &[
        ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".password-store", ".claude", ".codex", ".copilot", ".cursor",
        ".terraform.d", "gcloud", "usersecrets",
    ];
    const NAMES: &[&str] = &[
        "credentials", "credentials.json", ".credentials.json", ".netrc", "_netrc", ".git-credentials", "id_rsa", "id_ed25519",
        "id_ecdsa", "auth.json", "oauth_creds.json", ".npmrc", ".pypirc", ".pgpass", ".vault-token", "hosts.yml",
    ];
    const ENDINGS: &[&str] = &[".pem", ".key", ".pfx", ".p12", ".kdbx", ".ppk", ".gpg"];
    const PLACES: &[&str] = &[
        "/appdata/roaming/microsoft/credentials", "/appdata/local/microsoft/credentials", "/appdata/roaming/microsoft/protect",
        "/user data/", "/firefox/profiles", "/thunderbird/profiles", "/opera software", "/com.rccrd12.lumo/",
    ];
    // Windows drops the dots and spaces a name ends with, and what follows a
    // colon in a name is one of its streams (`id_rsa:x` is id_rsa).
    let parts: Vec<&str> = p
        .split('/')
        .enumerate()
        .map(|(i, part)| if i == 0 { part } else { part.split(':').next().unwrap_or(part) })
        .map(|part| part.trim_end_matches(['.', ' ']))
        .filter(|part| !part.is_empty())
        .collect();
    let name = parts.last().copied().unwrap_or_default();
    let whole = format!("{}/", parts.join("/"));
    parts.iter().any(|part| DIRS.contains(part))
        || NAMES.contains(&name)
        || ENDINGS.iter().any(|e| name.ends_with(e))
        || name == ".env"
        || name.starts_with(".env.")
        || name.contains("password")
        // Lumo's own data, but for the inbox of dropped files.
        || (PLACES.iter().any(|place| whole.contains(place)) && !whole.contains("/com.rccrd12.lumo/inbox/"))
}

/// An Antigravity file tool that changes something (`write_to_file`,
/// `replace_file_content`…) outside the run's workspace (`workspaces`, agy's
/// `workspacePaths`). agy would ask about it, but its own confirmation is off
/// in the island's chat, so it is a card. A path that cannot be placed for
/// sure (`..`, no workspace known, the home folder or a variable the tool
/// may expand: `~`, `$HOME`, `%USERPROFILE%`) is one too. Reading stays free:
/// the chat reads the documents the user has open, wherever they are.
pub fn writes_outside(tool: &str, input: Option<&Value>, workspaces: &[String]) -> bool {
    let tool = tool.to_ascii_lowercase();
    if !["write", "replace", "edit", "delete", "remove", "move", "rename", "create"].iter().any(|w| tool.contains(w)) {
        return false;
    }
    let Some(input) = input.and_then(Value::as_object) else { return false };
    let roots: Vec<String> = workspaces.iter().map(|w| norm_path(w)).filter(|w| !w.is_empty()).collect();
    input
        .iter()
        .filter(|(key, _)| ["file", "path", "target", "dest"].iter().any(|w| key.to_ascii_lowercase().contains(w)))
        .filter_map(|(_, value)| value.as_str())
        .filter(|path| !path.trim().is_empty())
        .any(|path| {
            let p = norm_path(path);
            if p.split('/').any(|part| part == "..") {
                return true;
            }
            // Not relative to the workspace once expanded: `~/…`, `$HOME/…`,
            // `${env:…}`, `%USERPROFILE%\…` (and `%3A`, a `file://` address's colon).
            if p.starts_with(['~', '$']) || p.contains('%') {
                return true;
            }
            // A relative path is the workspace's own.
            let absolute = p.starts_with('/') || p.as_bytes().get(1) == Some(&b':');
            absolute && !roots.iter().any(|r| p == *r || p.starts_with(&format!("{r}/")))
        })
}

/// A path to compare: forward slashes, lower case (Windows), no `file://`, no trailing slash.
fn norm_path(path: &str) -> String {
    let p = path.trim();
    // `file:///C:/x` is C:/x; `file://server/x` names a server: //server/x.
    let p = match p.strip_prefix("file:///") {
        Some(rest) => rest.to_string(),
        None => p.strip_prefix("file://").map(|rest| format!("//{rest}")).unwrap_or_else(|| p.to_string()),
    };
    let p = p.replace('\\', "/").to_lowercase();
    let p = if p.as_bytes().get(2) == Some(&b':') && p.starts_with('/') { p[1..].to_string() } else { p };
    p.trim_end_matches('/').to_string()
}

/// Whether a shell command would sit waiting for something to happen: GitHub's
/// own watchers (`gh pr checks --watch`, `gh run watch`), a long sleep, or a
/// loop that sleeps. Such a command holds the island's chat with nothing to
/// show; Lumo listens instead (claude_wait_denied).
pub fn blocking_wait(command: &str) -> bool {
    let lower = unquoted(&command.to_ascii_lowercase());
    let words: Vec<&str> = lower
        .split(|c: char| c.is_whitespace() || matches!(c, ';' | '&' | '|' | '(' | ')' | '{' | '}'))
        .filter(|w| !w.is_empty())
        .collect();
    let has = |seq: &[&str]| words.windows(seq.len()).any(|w| w == seq);
    if (has(&["gh", "pr", "checks"]) && words.contains(&"--watch")) || has(&["gh", "run", "watch"]) {
        return true;
    }
    // Each command of the line, as its words: only a word in a command's place
    // runs. `git commit -m "sleep for a bit"` or `npm test -- --timeout 30`
    // only mention one.
    let commands: Vec<Vec<&str>> = lower
        .split([';', '&', '|', '(', ')', '{', '}', '\n'])
        .map(|part| {
            let mut words: Vec<&str> = part.split_whitespace().collect();
            while words.first().is_some_and(|w| matches!(*w, "do" | "then" | "else" | "!")) {
                words.remove(0);
            }
            words
        })
        .filter(|words| !words.is_empty())
        .collect();
    // A wait: sleep, PowerShell's Start-Sleep, or cmd's `timeout /t 30`.
    // Git Bash's `timeout 30 npm test` only limits the command after it.
    let waits = |c: &Vec<&str>| match c[0] {
        "sleep" | "start-sleep" => true,
        "timeout" => c.get(1).is_some_and(|w| matches!(*w, "/t" | "-t")) || (c.len() == 2 && seconds(c[1]).is_some()),
        _ => false,
    };
    let sleeps: Vec<&Vec<&str>> = commands.iter().filter(|c| waits(c)).collect();
    if sleeps.is_empty() {
        return false;
    }
    if commands.iter().any(|c| matches!(c[0], "while" | "until" | "for")) {
        return true;
    }
    // A single long sleep: the first number after it, in seconds (30, 30s, 2m, 1h).
    sleeps.iter().any(|c| c[1..].iter().take(3).find_map(|w| seconds(w.trim_start_matches(['-', '/']))).is_some_and(|s| s >= 30.0))
}

/// `command` with what is in quotes left out: text, not commands.
fn unquoted(command: &str) -> String {
    let mut out = String::with_capacity(command.len());
    let mut quote: Option<char> = None;
    for c in command.chars() {
        match quote {
            Some(q) if c == q => {
                quote = None;
                out.push(' ');
            }
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None => out.push(c),
        }
    }
    out
}

fn seconds(word: &str) -> Option<f64> {
    let (num, unit) = word.split_at(word.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(word.len()));
    let n: f64 = num.parse().ok()?;
    match unit {
        "" | "s" => Some(n),
        "m" => Some(n * 60.0),
        "h" => Some(n * 3600.0),
        _ => None,
    }
}

/// Claude Code's PreToolUse reply to a command that would wait on GitHub:
/// denied, with what to do instead.
/// A computer tool of the island's Claude Code chat that did not get its
/// turn: `place` and how many wait, or None when the user pressed Esc.
/// Only ever a deny: the turn come, the hook prints nothing.
pub fn computer_turn_denied(place: Option<(usize, usize)>) -> String {
    let reason = match place {
        Some((place, of)) => format!(
            "Lumo: another agent of this chat is using the computer, and Lumo lets one agent at a time use it. You are {} of {of} waiting for it. Do work that doesn't need the screen meanwhile, then call the tool again: you keep your place.",
            ordinal(place)
        ),
        None => "Lumo: the user pressed Esc to stop you using the computer. Don't use Lumo's computer tools again in this turn: say briefly what you did and stop.".to_string(),
    };
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    })
    .to_string()
}

fn ordinal(n: usize) -> String {
    let suffix = match (n % 10, n % 100) {
        (1, 11) | (2, 12) | (3, 13) => "th",
        (1, _) => "st",
        (2, _) => "nd",
        (3, _) => "rd",
        _ => "th",
    };
    format!("{n}{suffix}")
}

pub fn claude_wait_denied() -> String {
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "Lumo: do not wait for GitHub (or anything else) in a command, it holds the user's chat. Call Lumo's listen tool instead (or, without it, write [[listen owner/repo#123 event: what to do then]] on a line of its own in your answer), say Lumo will listen once the user confirms, and end your answer: Lumo then watches GitHub and messages you when it happens.",
        }
    })
    .to_string()
}

/// Why a card of the island's Antigravity chat got no decision, as the relay
/// saw it (main.rs): the app's own line (`unanswered …`, pipe.rs) says more.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unanswered {
    /// No Lumo on the other end of the pipe.
    NotRunning,
    /// The relay's time for the card ran out.
    TimedOut,
    /// Anything else: Lumo said nothing.
    Unknown,
}

/// What the model is told after a click on Deny.
const DENIED: &str = "The user denied this in Lumo. Don't try to do the same in another way: ask them what they want instead.";

/// What the model is told when nobody answered, by why: the true reason, so it
/// neither retries in vain nor tells the user something that did not happen.
fn unanswered_reason(word: &str, why: Unanswered, secs: u64) -> String {
    match (word, why) {
        ("timeout", _) | ("", Unanswered::TimedOut) => format!(
            "Nobody answered Lumo's card within {secs} s: the user may be away. Don't retry this on your own: say in your answer what you wanted to do, and wait for their reply."
        ),
        ("busy", _) => "Lumo couldn't show this request: it is paused, or other requests are already waiting. Try again in a moment; if it happens again, tell the user.".to_string(),
        ("released", _) => "Lumo took this request down before anyone answered (it was paused, or the request was withdrawn). Say in your answer what you wanted to do.".to_string(),
        ("", Unanswered::NotRunning) => "Lumo isn't running, so nobody could approve this. Say in your answer what you wanted to do.".to_string(),
        _ => "Nobody answered this request in Lumo, so it was not done. Don't retry it on your own: say in your answer what you wanted to do.".to_string(),
    }
}

/// Antigravity's PreToolUse reply to its chat's card (main.rs): `allow` only after a click
/// on Allow (or the chat's Auto, pipe.rs). Anything else — Deny, no click in
/// time, an answer not understood — is a deny: with agy's own confirmation
/// off, nothing else stops it. Its reason says what really happened (`why`,
/// and the app's `unanswered <word>` line), `secs` being how long the card waited.
pub fn antigravity_island(decision: Option<&str>, why: Unanswered, secs: u64) -> String {
    let deny = |reason: &str| json!({ "decision": "deny", "reason": reason }).to_string();
    match decision.map(str::trim) {
        Some("allow" | "always") => r#"{"decision":"allow"}"#.to_string(),
        Some("deny") => deny(DENIED),
        Some(line) if line.starts_with("unanswered ") => deny(&unanswered_reason(line["unanswered ".len()..].trim(), why, secs)),
        _ => deny(&unanswered_reason("", why, secs)),
    }
}

/// Antigravity's PreToolUse reply to the card of a command in your own session
/// (main.rs): `allow` only after a click on Allow, `deny` after one on Deny.
/// Anything else (Reply in Antigravity, no click in time, Lumo closed) is
/// "ask": Antigravity asks in its own window, as if Lumo were not there.
pub fn antigravity_gate(decision: Option<&str>) -> String {
    match decision.map(str::trim) {
        Some("allow" | "always" | "edits") => r#"{"decision":"allow"}"#.to_string(),
        Some("deny") => json!({ "decision": "deny", "reason": DENIED }).to_string(),
        _ => r#"{"decision":"ask"}"#.to_string(),
    }
}

/// The documented PermissionRequest output. Anything we do not recognise prints
/// nothing at all rather than guessing — silence is the safe answer.
/// See https://code.claude.com/docs/en/hooks
///
/// `question` is the AskUserQuestion input, when that is what is being asked:
/// the island may then answer it, which Claude Code takes as the same input
/// with an `answers` map added. Nothing else of the input can be changed from
/// the island, and no other tool's input can be changed at all.
///
/// `always` (allowed for this session on the island) is a plain allow here:
/// the rules Claude Code suggests with its request (`npm run:*`, a whole MCP
/// tool, a folder) reach further than the card showed, so none is handed back.
/// Lumo remembers the request itself (session_rules.rs in the app) and
/// answers the same one again at once.
pub fn decision_json(decision: &str, question: Option<&Value>) -> Option<String> {
    // A plan approved with "let it edit files without asking": allowed, and
    // Claude Code goes on in acceptEdits for this session only, exactly as its
    // own prompt's option does. Never written to a settings file.
    if decision.trim() == "edits" {
        return Some(
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": {
                        "behavior": "allow",
                        "updatedPermissions": [{ "type": "setMode", "mode": "acceptEdits", "destination": "session" }],
                    },
                }
            })
            .to_string(),
        );
    }
    if decision.trim_start().starts_with('{') {
        let reply = serde_json::from_str::<Value>(decision).ok()?;
        let answers = reply.get("answers")?.as_object()?;
        let question = question?;
        if !answers_fit(question, answers) {
            return None;
        }
        let mut input = question.as_object()?.clone();
        input.insert("answers".into(), Value::Object(answers.clone()));
        return Some(
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": { "behavior": "allow", "updatedInput": input },
                }
            })
            .to_string(),
        );
    }
    let behavior = match decision.trim() {
        // "always" still answers a plain allow; remembering it is the island's
        // business, not the agent's.
        "allow" | "always" => r#"{"behavior":"allow"}"#.to_string(),
        "deny" => r#"{"behavior":"deny","message":"Denied from Lumo"}"#.to_string(),
        _ => return None,
    };
    Some(format!(
        r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{behavior}}}}}"#
    ))
}

/// True when `answers` answers exactly the questions Claude Code asked: one entry
/// per question, keyed by its text; a single-select answer is one of its option
/// labels (a string), a multi-select answer a non-empty list of distinct labels
/// (Claude Code 2.1.136+ takes the list).
fn answers_fit(question: &Value, answers: &Map<String, Value>) -> bool {
    let Some(items) = question.get("questions").and_then(|q| q.as_array()) else { return false };
    if items.is_empty() || items.len() != answers.len() {
        return false;
    }
    items.iter().all(|item| {
        let Some(text) = item.get("question").and_then(|q| q.as_str()) else { return false };
        let labels: Vec<&str> = item
            .get("options")
            .and_then(|o| o.as_array())
            .map(|opts| opts.iter().filter_map(|o| o.get("label").and_then(|l| l.as_str())).collect())
            .unwrap_or_default();
        let multi = item.get("multiSelect").and_then(|m| m.as_bool()).unwrap_or(false);
        match answers.get(text) {
            Some(Value::String(pick)) if !multi => labels.contains(&pick.as_str()),
            Some(Value::Array(picks)) if multi => {
                let picks: Vec<&str> = picks.iter().filter_map(|p| p.as_str()).collect();
                let mut seen = picks.clone();
                seen.sort_unstable();
                seen.dedup();
                !picks.is_empty() && seen.len() == picks.len() && picks.iter().all(|p| labels.contains(p))
            }
            _ => false,
        }
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_command_that_would_wait_on_github_is_told_to_let_lumo_listen() {
        for cmd in [
            "gh pr checks 22 --watch",
            "gh pr merge 22 --squash && gh pr checks 22 --watch --interval 30",
            "gh run watch 123456",
            "sleep 60 && gh pr view 22",
            "Start-Sleep -Seconds 120; gh pr view 22",
            "while true; do gh pr view 22 --json state; sleep 10; done",
            "until gh pr view 22 --json mergedAt -q .mergedAt | grep -q T; do sleep 5; done",
            "timeout /t 90",
        ] {
            assert!(blocking_wait(cmd), "{cmd}");
        }
        for cmd in [
            "gh pr merge 22 --squash",
            "gh pr checks 22",
            "sleep 2 && ls",
            "npm test -- --timeout 30000",
            "git status",
            // Ordinary commands that only mention a wait.
            "timeout 60 npm test",
            "git commit -m \"Wait for the sleep timer to end\"",
            "for f in *.log; do echo \"sleep 90\"; done",
            "echo 'while sleep 100'",
            "grep -r sleep src/ | head -30",
        ] {
            assert!(!blocking_wait(cmd), "{cmd}");
        }
        let v: serde_json::Value = serde_json::from_str(&claude_wait_denied()).unwrap();
        assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "deny");
        assert!(v["hookSpecificOutput"]["permissionDecisionReason"].as_str().unwrap().contains("[[listen"));
    }

    use super::*;

    const AGENTS: &[&str] = &[
        "", "gemini", "antigravity", "cursor", "codex", "copilot", "muse", "opencode", "amp",
        "hermes", "claude-desktop", "my-tool",
    ];
    const EVENTS: &[&str] = &[
        "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
        "PermissionRequest", "Notification", "Stop", "StopFailure", "SessionEnd", "Interrupt",
        "SubagentStart", "SubagentStop", "",
    ];

    /// Whatever a reply says, does it let anything through?
    fn allows(out: &str) -> bool {
        let v: Value = serde_json::from_str(out).expect("every reply is JSON");
        let text = v.to_string();
        // Any decision counts as one, except "ask" (Antigravity's PreToolUse): that hands the
        // choice back to the agent's own prompt.
        let decided = v.get("decision").is_some_and(|d| d.as_str() != Some("ask"));
        text.contains("allow") || decided || v.get("permission").is_some() || v.get("continue").is_some()
    }

    #[test]
    fn nothing_is_ever_allowed_without_a_decision() {
        for agent in AGENTS {
            for event in EVENTS {
                if let Some(out) = stdout(agent, event, None, None) {
                    assert!(!allows(&out), "{agent:?} {event} printed {out} with nobody clicking");
                }
                // A decline, a timeout or garbage from the app is no decision either.
                for not_a_decision in ["", "ask", "maybe", "{\"permissionDecision\":\"allow\"}"] {
                    if let Some(out) = stdout(agent, event, Some(not_a_decision), None) {
                        assert!(!allows(&out), "{agent:?} {event} {not_a_decision:?} printed {out}");
                    }
                }
            }
        }
    }

    #[test]
    fn a_decision_only_counts_on_a_permission_request_from_an_agent_that_takes_one() {
        for agent in AGENTS {
            for event in EVENTS.iter().filter(|e| **e != "PermissionRequest") {
                if let Some(out) = stdout(agent, event, Some("allow"), None) {
                    assert!(!allows(&out), "{agent:?} {event}: {out}");
                }
            }
            let out = stdout(agent, "PermissionRequest", Some("allow"), None);
            assert_eq!(out.as_deref().is_some_and(allows), takes_decisions(agent), "{agent:?}: {out:?}");
        }
    }

    #[test]
    fn each_agent_gets_its_own_reply_shape() {
        let allow = r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#;
        let deny = r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Lumo"}}}"#;
        for agent in ["", "claude-desktop", "codex", "opencode"] {
            assert_eq!(stdout(agent, "PermissionRequest", Some("allow"), None).unwrap(), allow);
            assert_eq!(stdout(agent, "PermissionRequest", Some("always"), None).unwrap(), allow);
            assert_eq!(stdout(agent, "PermissionRequest", Some("deny"), None).unwrap(), deny);
            assert_eq!(stdout(agent, "PermissionRequest", None, None), None);
            assert_eq!(stdout(agent, "PreToolUse", None, None), None);
        }
        for agent in ["copilot", "muse"] {
            assert_eq!(stdout(agent, "PermissionRequest", Some("allow"), None).unwrap(), r#"{"permissionDecision":"allow"}"#);
            assert_eq!(stdout(agent, "PermissionRequest", Some("deny"), None).unwrap(), r#"{"permissionDecision":"deny"}"#);
            assert_eq!(stdout(agent, "PreToolUse", None, None).unwrap(), "{}");
        }
        // Copilot is fail-closed: no decision is an explicit "ask", never silence.
        assert_eq!(stdout("copilot", "PermissionRequest", None, None).unwrap(), r#"{"permissionDecision":"ask"}"#);
        assert_eq!(stdout("muse", "PermissionRequest", None, None), None);
        // Antigravity needs a decision on PreToolUse: "ask" leaves it to Antigravity's own prompt;
        // other lifecycle events receive "{}".
        assert_eq!(stdout("antigravity", "PreToolUse", None, None).unwrap(), r#"{"decision":"ask"}"#);
        for event in ["PostToolUse", "UserPromptSubmit", "Stop"] {
            assert_eq!(stdout("antigravity", event, None, None).unwrap(), "{}");
        }
        // Gemini CLI reads "{}" as "no opinion".
        for event in ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"] {
            assert_eq!(stdout("gemini", event, None, None).unwrap(), "{}");
        }
        // Cursor: silence, which Cursor reads as "carry on as usual".
        for event in ["PreToolUse", "UserPromptSubmit", "Stop"] {
            assert_eq!(stdout("cursor", event, None, None), None);
        }
        // Hermes approvals are not supported: its decisions are never relayed.
        assert_eq!(stdout("hermes", "PermissionRequest", Some("allow"), None), None);
    }

    #[test]
    fn the_islands_antigravity_chat_is_allowed_only_after_a_click() {
        let island = |d: Option<&str>| antigravity_island(d, Unanswered::Unknown, 100);
        let reason = |out: String| -> String {
            let v: Value = serde_json::from_str(&out).unwrap();
            assert_eq!(v["decision"], "deny", "{out}");
            v["reason"].as_str().unwrap().to_string()
        };
        assert_eq!(island(Some("allow")), r#"{"decision":"allow"}"#);
        assert_eq!(island(Some("always")), r#"{"decision":"allow"}"#);
        assert_eq!(reason(island(Some("deny"))), DENIED);
        for not_a_decision in [None, Some(""), Some("ask"), Some("maybe"), Some(r#"{"permissionDecision":"allow"}"#), Some("unanswered what")] {
            let r = reason(island(not_a_decision));
            assert!(r.starts_with("Nobody answered this request in Lumo"), "{not_a_decision:?}: {r}");
        }
        // The true reason, never "nobody approved it" when nobody could.
        assert!(reason(island(Some("unanswered timeout"))).contains("within 100 s"));
        assert!(reason(antigravity_island(None, Unanswered::TimedOut, 60)).contains("within 60 s"));
        assert!(reason(island(Some("unanswered busy"))).contains("other requests are already waiting"));
        assert!(reason(island(Some("unanswered released"))).contains("before anyone answered"));
        assert!(reason(antigravity_island(None, Unanswered::NotRunning, 100)).starts_with("Lumo isn't running"));
        for r in [island(Some("deny")), island(None), island(Some("unanswered timeout"))] {
            assert!(!r.contains("Nobody approved it"), "{r}");
        }
        assert!(island_card("run_command", None));
        assert!(island_card("send_command_input", None));
        assert!(island_card("Shell", None));
        assert!(!island_card("view_file", None));
        assert!(!island_card("default_api:view_file", None));
        assert!(island_card("mcp_github_create_issue", None));
        // The web carries out what the model puts in an address or a search.
        assert!(island_card("read_url_content", None));
        assert!(island_card("search_web", None));
        // A tool agy adds later, or a subagent, is a card until it is known.
        assert!(island_card("browser_subagent", None));
        assert!(island_card("deploy_web_app", None));
        assert!(island_card("create_memory", None));
        assert!(!island_card("task_boundary", None) && !island_card("view_content_chunk", None));
        assert!(island_card("browser_click", None));
        assert!(!island_card("write_to_file", None));
        let ws = ["C:\\Users\\me\\Lumo".to_string(), "C:\\Users\\me\\AppData\\Local\\com.rccrd12.lumo\\inbox".to_string()];
        let w = |tool: &str, input: Value| writes_outside(tool, Some(&input), &ws);
        assert!(w("write_to_file", json!({"TargetFile": "C:\\Users\\Public\\lumo-test.txt"})), "outside: a card");
        assert!(!w("write_to_file", json!({"TargetFile": "c:/users/me/lumo/src/a.rs"})), "its own folder");
        assert!(!w("replace_file_content", json!({"TargetFile": "file:///C:/Users/me/Lumo/a.md"})));
        assert!(!w("write_to_file", json!({"TargetFile": "notes/a.md"})), "relative: the workspace's");
        assert!(w("write_to_file", json!({"TargetFile": "C:\\Users\\me\\Lumo\\..\\x.txt"})), "leaves it");
        assert!(w("write_to_file", json!({"TargetFile": "C:\\Users\\me\\Lumo2\\x.txt"})), "a sibling is not inside");
        assert!(!w("view_file", json!({"AbsolutePath": "C:\\Users\\Public\\a.pdf"})), "not a write");
        let r = |tool: &str, input: Value| reads_outside(tool, Some(&input), &ws);
        assert!(!r("view_file", json!({"AbsolutePath": "C:\\Users\\me\\Lumo\\notes.md"})), "the workspace's own");
        assert!(!r("view_file", json!({"AbsolutePath": "c:/users/me/appdata/local/com.rccrd12.lumo/inbox/a.pdf"})), "a dropped file");
        assert!(!r("grep_search", json!({"Query": "fn main", "SearchPath": "src"})), "relative: the workspace's");
        assert!(r("view_file", json!({"AbsolutePath": "C:\\Users\\Public\\a.pdf"})), "outside: a card");
        assert!(r("view_file", json!({"AbsolutePath": "C:\\Users\\me\\.aws\\credentials"})), "keys");
        assert!(r("list_dir", json!({"DirectoryPath": "C:\\Users\\me\\.ssh"})));
        assert!(r("view_file", json!({"AbsolutePath": "C:\\Users\\me\\Lumo\\.env"})), "keys, even inside");
        assert!(r("view_file", json!({"AbsolutePath": "C:\\Users\\me\\Lumo\\id_rsa:x"})), "a stream of a key file");
        assert!(r("codebase_search", json!({"Query": "x", "TargetDirectories": ["C:\\Users\\me\\Lumo", "D:\\other"]})), "one of a list");
        assert!(r("view_file", json!({"AbsolutePath": "C:\\Users\\me\\Lumo\\..\\x.txt"})), "leaves it");
        assert!(r("view_file", json!({"AbsolutePath": "\\\\server\\share\\a.txt"})), "a network path");
        assert!(r("view_file", json!({"AbsolutePath": "C:\\Users\\me\\AppData\\Local\\com.rccrd12.lumo\\EBWebView\\x"})), "Lumo's own data");
        assert!(!r("view_file", json!({"AbsolutePath": "C:\\Users\\me\\.gemini\\antigravity\\brain\\1\\task.md"})), "agy's own plan");
        assert!(!r("view_file", json!({"AbsolutePath": "~/.gemini/antigravity/brain/1/task.md"})), "agy's own plan, from home");
        // Antigravity's folder name on a network share or elsewhere is not its folder.
        for path in [
            "\\\\attacker.example\\x\\.gemini\\antigravity\\y.txt",
            "\\\\data.attacker.example@SSL\\DavWWWRoot\\.gemini\\antigravity\\x",
            "//attacker.example/x/.gemini/antigravity",
            "\\\\?\\UNC\\attacker.example\\x\\.gemini\\antigravity\\y",
            "\\\\?\\C:\\Users\\me\\.gemini\\antigravity\\y",
            "D:\\stuff\\.gemini\\antigravity\\y.txt",
            "file://attacker.example/x/.gemini/antigravity/y",
        ] {
            assert!(r("view_file", json!({ "AbsolutePath": path })), "{path}");
            assert!(r("list_dir", json!({ "DirectoryPath": path })), "{path}");
        }
        // The home folder or a variable: not the workspace's, for a read too.
        for path in ["~\\Documents\\tax.pdf", "%USERPROFILE%\\x.txt", "$HOME/x", "file:///C:/ws/%2e%2e/x"] {
            assert!(r("view_file", json!({ "AbsolutePath": path })), "{path}");
        }
        assert!(!r("write_to_file", json!({"TargetFile": "C:\\x.txt"})), "not a read");
        assert!(reads_outside("view_file", Some(&json!({"AbsolutePath": "/x/a"})), &[]), "no workspace known");
        assert!(writes_outside("write_to_file", Some(&json!({"TargetFile": "/x/a"})), &[]), "no workspace known");
        // The home folder or a variable the tool may expand: not the workspace's.
        for path in ["~\\Desktop\\x.txt", "~/x", "%USERPROFILE%\\x.txt", "$HOME/x", "${env:USERPROFILE}\\x", "$env:APPDATA\\x", "file:///C%3A/Users/Public/x"] {
            assert!(w("write_to_file", json!({ "TargetFile": path })), "{path}");
        }
        assert!(!island_card("", None));
        assert!(!island_card("mcp_lumo_mail_recent", None) && !island_card("lumo/mail_read", None), "Lumo's email only reads");
        assert!(island_card("mcp_gmail_send_message", None));
    }

    #[test]
    fn decision_json_matches_the_documented_shape() {
        assert_eq!(
            decision_json("allow", None).unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert!(decision_json("always", None).unwrap().contains(r#""behavior":"allow""#));
    }

    #[test]
    fn allowed_for_the_session_never_hands_back_broader_rules() {
        // What Claude Code suggests (a prefix, a folder, a mode) reaches further
        // than the card on screen: "Allow for this session" is a plain allow.
        assert_eq!(stdout("", "PermissionRequest", Some("always"), None), decision_json("allow", None));
        assert_eq!(stdout("codex", "PermissionRequest", Some("always"), None), decision_json("allow", None));
        assert!(!decision_json("always", None).unwrap().contains("updatedPermissions"));
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(decision_json("", None).is_none());
        assert!(decision_json("maybe", None).is_none());
        // The shape the app used to send must not be mistaken for a decision.
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#, None).is_none());
    }

    #[test]
    fn an_answered_question_goes_back_as_the_same_input_plus_answers() {
        let question = json!({
            "questions": [{ "question": "Which one?", "options": [{ "label": "A" }, { "label": "B" }] }]
        });
        let out = stdout("", "PermissionRequest", Some(r#"{"answers":{"Which one?":"B"}}"#), Some(&question)).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let decision = &v["hookSpecificOutput"]["decision"];
        assert_eq!(decision["behavior"], "allow");
        assert_eq!(decision["updatedInput"]["questions"], question["questions"]);
        assert_eq!(decision["updatedInput"]["answers"]["Which one?"], "B");
        // Claude Code in the Claude app asks the same way.
        let desktop = stdout("claude-desktop", "PermissionRequest", Some(r#"{"answers":{"Which one?":"B"}}"#), Some(&question));
        assert_eq!(desktop.as_deref(), Some(out.as_str()));
        // Only Claude Code asks questions: an answer for anyone else is nothing.
        assert!(stdout("codex", "PermissionRequest", Some(r#"{"answers":{"Which one?":"B"}}"#), Some(&question)).is_none());
    }

    #[test]
    fn answers_are_only_accepted_for_a_question() {
        assert!(decision_json(r#"{"answers":{"q":"a"}}"#, None).is_none());
        let question = json!({ "questions": [] });
        assert!(decision_json(r#"{"answers":{}}"#, Some(&question)).is_none());
        assert!(decision_json(r#"{"answers":{"q":1}}"#, Some(&question)).is_none());
        assert!(decision_json(r#"{"command":"rm -rf /"}"#, Some(&question)).is_none());
    }

    #[test]
    fn answers_must_match_the_questions_asked() {
        let q = json!({ "questions": [
            { "question": "Which one?", "options": [{ "label": "A" }, { "label": "B" }] },
            { "question": "Extras?", "multiSelect": true,
              "options": [{ "label": "Tests" }, { "label": "Docs" }, { "label": "Lint" }] }
        ]});
        let ok = |a: &str| decision_json(a, Some(&q)).is_some();
        assert!(ok(r#"{"answers":{"Which one?":"A","Extras?":["Tests","Docs"]}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":"C","Extras?":["Tests"]}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":"A","Extras?":["Tests"],"Other?":"x"}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":"A"}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":["A"],"Extras?":["Tests"]}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":"A","Extras?":"Tests"}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":"A","Extras?":[]}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":"A","Extras?":["Tests","Tests"]}}"#));
    }

    #[test]
    fn a_plan_approved_to_edit_freely_switches_claude_code_to_accept_edits_for_the_session() {
        for agent in ["", "claude-desktop"] {
            let out = stdout(agent, "PermissionRequest", Some("edits"), None).unwrap();
            let v: Value = serde_json::from_str(&out).unwrap();
            let decision = &v["hookSpecificOutput"]["decision"];
            assert_eq!(decision["behavior"], "allow");
            assert_eq!(decision["updatedPermissions"], json!([{ "type": "setMode", "mode": "acceptEdits", "destination": "session" }]));
        }
        // For any other agent it is a plain allow, never a mode.
        let allow = stdout("codex", "PermissionRequest", Some("allow"), None);
        assert_eq!(stdout("codex", "PermissionRequest", Some("edits"), None), allow);
        assert_eq!(stdout("copilot", "PermissionRequest", Some("edits"), None).unwrap(), r#"{"permissionDecision":"allow"}"#);
        // And it only ever answers a permission request.
        assert!(stdout("", "PreToolUse", Some("edits"), None).is_none());
    }
}
