// Chat through Claude Code itself: the `claude` CLI the user installed and
// signed in to with their own Claude plan (Pro, Max…). No API key: Lumo runs
// the unmodified binary as `claude -p`, and Claude Code answers with its own
// sign-in, exactly as in a terminal. Lumo never reads, stores or forwards any
// Claude credential.
//
// Unlike the other providers, Claude Code can act: read a dropped PDF or image,
// read and edit files, run commands, search the web. Every action that needs a
// permission goes through Claude Code's own PermissionRequest hook — the one
// Lumo installs, which the chat's run also adds for itself (`chat_settings`) —
// so it shows up in the island as the usual Allow / Deny card, only when Claude
// Code would really ask. With nobody clicking, Claude Code denies the action:
// `-p` never allows anything on its own.
//
// Each chat keeps its own Claude Code running between messages (`live_turn`,
// `--input-format stream-json`): a message is a line on its stdin, Stop
// interrupts the turn, and the process ends after a while without messages.
//
// The prompt goes in on stdin, never on the command line: an npm install is a
// `claude.cmd`, and cmd.exe would interpret what the user typed. Every argument
// is fixed or checked.
//
// A message that is one of Claude Code's commands ("/compact", "/context",
// the user's own) goes in alone, exactly as typed, so Claude Code runs it as
// in a terminal. The commands it has come with its first line (`init`), kept
// for the island's "/" menu (`commands`, the `chat-commands` event).
//
// The answer is streamed like a local model's: `chat-delta` events carry the
// text visible so far, the command's reply is the final answer. While no text
// shows, `chat-activity` events say what Claude Code is doing (thinking,
// reading a file, running a command…), read off the tool calls it streams.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::chat::{self, Chat, ChatContext, ChatReply, ModelInfo, Stop};
use crate::i18n::{t, tf};
use crate::island::WINDOW_LABEL;
use crate::platform;

pub const PROVIDER: &str = "claude-code";

/// The island is told about new text at most this often.
const DELTA_INTERVAL: Duration = Duration::from_millis(1000 / 15);
/// How often a running turn looks at the Stop button.
const STOP_POLL: Duration = Duration::from_millis(100);
/// Ceilings for what we read back: one event line, and the whole run.
const MAX_LINE: usize = 4 * 1024 * 1024;
const MAX_TOTAL: usize = 64 * 1024 * 1024;
/// Earlier turns from another provider, carried over as text, are cut to this.
const MAX_CARRIED_CHARS: usize = 24_000;

/// Added to Claude Code's own instructions. Plain words only: it is an argument.
const APPEND_PROMPT: &str = concat!(
    "You are Lumo, the user's personal assistant, answering from the Lumo island at the top of their screen. \
The chat window is small: answer in the user's language, keep answers focused, and use light Markdown (short paragraphs, lists, bold, code blocks), no tables or big headings. \
When the user drops a file, its path is given in the message: read it from there. \
When the user shares the folder open in File Explorer, its path and listing are given in the message: read its files from there. \
You cannot see the user's screen, their open windows or the folder open in File Explorer unless they share them. If you need to, ask them to press the screen button next to the paperclip in the chat; for the folder in File Explorer, they can also turn on Always share the folder open in File Explorer in Lumo's Settings, under Chat. Never take a screenshot or list their windows yourself. \
Every action that needs a permission is approved by the user in the island, so ask for it normally. Lumo may also list the windows and the documents open on the user's computer, with their paths: when a question is about one of them, such as the PDF they have open, read it from its path yourself instead of asking them to share it. \
Lumo shows the user your plan on its Plan island. So whenever the user gives you a job that takes more than one step (writing code, creating or changing files, running several commands), your very first tool call must be TaskCreate, once for each step of your plan (or TodoWrite with the whole list, when that is the tool you have; load them with ToolSearch first if they are deferred), before any other tool. Then, as you work, mark each step in_progress when you start it and completed when it is done (TaskUpdate). Do this even for small jobs, and never write the plan as text instead. ",
    crate::chat::timer_tool_note!(),
    crate::chat::listen_tool_note!(),
    crate::chat::math_note!()
);

/// Added instead when the chat may use the computer (Settings → Chat → Let
/// Claude use the computer, computer.rs). Plain words only: it is an argument.
const COMPUTER_PROMPT: &str = concat!(
    "You are Lumo, the user's personal assistant, answering from the Lumo island at the top of their screen. \
The chat window is small: answer in the user's language, keep answers focused, and use light Markdown (short paragraphs, lists, bold, code blocks), no tables or big headings. \
When the user drops a file, its path is given in the message: read it from there. \
When the user shares the folder open in File Explorer, its path and listing are given in the message: read its files from there. ",
    crate::computer::computer_note!(),
    "Every action that needs a permission is approved by the user in the island, so ask for it normally. Lumo may also list the windows and the documents open on the user's computer, with their paths: when a question is about one of them, such as the PDF they have open, read it from its path yourself instead of asking them to share it. \
Lumo shows the user your plan on its Plan island. So whenever the user gives you a job that takes more than one step (writing code, creating or changing files, running several commands), your very first tool call must be TaskCreate, once for each step of your plan (or TodoWrite with the whole list, when that is the tool you have; load them with ToolSearch first if they are deferred), before any other tool. Then, as you work, mark each step in_progress when you start it and completed when it is done (TaskUpdate). Do this even for small jobs, and never write the plan as text instead. ",
    crate::chat::timer_tool_note!(),
    crate::chat::listen_tool_note!(),
    crate::chat::math_note!()
);

/// Lumo's computer use tools that only look: Claude Code runs them without asking.
const COMPUTER_LOOKING: &str = "mcp__lumo__screenshot mcp__lumo__zoom mcp__lumo__cursor_position mcp__lumo__wait";

/// The island's timer and GitHub tools (island_tools.rs): they only start what
/// the user asked for, so Claude Code runs them without asking.
const ISLAND_ALLOWED: &str =
    "mcp__lumo__set_timer mcp__lumo__listen mcp__lumo__listen_pull_request mcp__lumo__stop_listening mcp__lumo__list_listening";

/// Lumo's email tools that only read (mail.rs): Claude Code runs them without
/// asking, as Security lets the AI read the email.
const MAIL_ALLOWED: &str = "mcp__lumo__mail_recent mcp__lumo__mail_search mcp__lumo__mail_read";
/// `mail_send` has Lumo's own card, with the email on it (mail.rs send): no
/// card of Claude Code's before it.
const MAIL_SEND_ALLOWED: &str = "mcp__lumo__mail_send";

/// The MCP server of the user's own tools (the Tools tab, tools.rs): its
/// tools are `mcp__lumo_tools__<id>`. Claude Code may call them without
/// asking: Lumo asks for each call itself, with its own card (tools.rs approve).
const TOOLS_SERVER: &str = crate::tools::SERVER;

/// Every tool of the user's tools server, for `--allowedTools`.
const TOOLS_SERVER_ALLOWED: &str = "mcp__lumo_tools";

/// Added in the tool workshop: Claude Code can try what it writes.
const WORKSHOP_TRY: &str = " In the workshop you may try the script before you give it: write it in a folder named tool-workshop inside your working directory and run it, asking for permissions as usual, then fix what fails. Plan the work first, as said above.";

/// The `--mcp-config` of a chat that may use the computer: `lumo-hook --mcp`
/// (its tools are `mcp__lumo__…`), marked as the island's own run.
#[cfg(test)]
fn computer_config() -> Value {
    mcp_config(true, false, false, "")
}

/// Lumo's MCP servers for a chat turn: computer use, the island's tools and
/// the email's (`lumo`; `mail` is mail.rs ai_tools: "", "mail" or
/// "mail,mailsend"), and the user's tools while one of them is on.
fn mcp_config(computer: bool, tools: bool, island: bool, mail: &str) -> Value {
    let mut servers = serde_json::Map::new();
    if computer || island || !mail.is_empty() {
        let mut server = crate::computer::server_entry();
        server["type"] = json!("stdio");
        if island || !mail.is_empty() {
            let kits: Vec<&str> = [computer.then_some("computer"), (!mail.is_empty()).then_some(mail), island.then_some("island")]
                .into_iter()
                .flatten()
                .collect();
            server["args"] = json!(["--mcp", format!("--tools={}", kits.join(","))]);
        }
        servers.insert("lumo".into(), server);
    }
    if tools {
        let mut server = crate::computer::server_entry();
        server["type"] = json!("stdio");
        server["args"] = json!(["--mcp", "--tools=user"]);
        servers.insert(TOOLS_SERVER.into(), server);
    }
    json!({ "mcpServers": servers })
}

/// `args`, plus Lumo's computer use: the MCP server and its looking tools
/// allowed. Left out when the file can't be written where Claude Code can be
/// pointed at it.
#[cfg(test)]
fn with_computer(args: Vec<String>) -> Vec<String> {
    with_mcp(args, true, false, false, "")
}

/// `args`, plus Lumo's MCP servers: computer use (its looking tools allowed),
/// the user's tools, and the island's timer and GitHub tools (allowed). Left
/// out when the file can't be written where Claude Code can be pointed at it.
fn with_mcp(mut args: Vec<String>, computer: bool, tools: bool, island: bool, mail: &str) -> Vec<String> {
    if !computer && !tools && !island && mail.is_empty() {
        return args;
    }
    let name = match (computer, island) {
        (true, false) => "chat-computer.json",
        (true, true) => "chat-computer-island.json",
        (false, true) if tools => "chat-tools-island.json",
        (false, true) => "chat-island.json",
        (false, false) => "chat-tools.json",
    };
    // The email's tools in a file of their own: one name, one configuration.
    let name = if mail.is_empty() { name.to_string() } else { name.replace(".json", &format!("-{}.json", mail.replace(',', "-"))) };
    let path = crate::platform::local_dir().join(name);
    let text = mcp_config(computer, tools, island, mail).to_string();
    let written = path.parent().is_some_and(|d| std::fs::create_dir_all(d).is_ok()) && std::fs::write(&path, text).is_ok();
    let path = path.to_string_lossy().to_string();
    if written && safe_dir(&path).is_some() {
        args.push("--mcp-config".into());
        args.push(path);
        let sends = mail.split(',').any(|k| k == "mailsend");
        let allowed: Vec<&str> = [
            computer.then_some(COMPUTER_LOOKING),
            island.then_some(ISLAND_ALLOWED),
            (!mail.is_empty()).then_some(MAIL_ALLOWED),
            sends.then_some(MAIL_SEND_ALLOWED),
            tools.then_some(TOOLS_SERVER_ALLOWED),
        ]
            .into_iter()
            .flatten()
            .collect();
        if !allowed.is_empty() {
            args.push("--allowedTools".into());
            args.push(allowed.join(" "));
        }
    }
    args
}

/// The models offered for Claude Code: the current ones by id, so the picker
/// says which version runs. "default": whatever the user set in Claude Code.
/// Older chats saved an alias ("opus"…), which still goes on the command line.
const DEFAULT_MODEL: &str = "default";
const MODELS: &[(&str, &str)] = &[
    (DEFAULT_MODEL, "Default"),
    ("claude-opus-5-5", "Opus 5.5"),
    ("claude-sonnet-5-5", "Sonnet 5.5"),
    ("claude-haiku-5-5", "Haiku 5.5"),
];

/// Claude Code is set up for Lumo: installed, with Lumo's hooks (so its
/// actions can be approved in the island). Blocking.
pub fn ready() -> bool {
    !platform::claude_candidates().is_empty() && crate::hooks::status().installed
}

/// Where Claude Code works when Lumo starts it: `~/Lumo`. Files outside it
/// can still be read or edited, each time with the user's Allow.
pub fn work_dir() -> PathBuf {
    platform::home_dir().join("Lumo")
}

pub fn models() -> Vec<ModelInfo> {
    MODELS
        .iter()
        .map(|(id, label)| ModelInfo { id: id.to_string(), label: t(label) })
        .collect()
}

/// The effort levels `claude --effort` takes; anything else leaves Claude Code's default.
pub const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

fn safe_effort(effort: &str) -> Option<&'static str> {
    EFFORTS.iter().copied().find(|e| *e == effort.trim())
}

/// A model alias or id we are willing to put on the command line.
fn safe_model(model: &str) -> Option<&str> {
    let m = model.trim();
    (!m.is_empty() && m != DEFAULT_MODEL && m.len() <= 64 && m.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '[' | ']')))
        .then_some(m)
}

/// A Claude Code session id: a UUID, nothing else.
pub(crate) fn safe_session(id: &str) -> Option<&str> {
    (id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')).then_some(id)
}

/// A shared folder we are willing to put on the command line: a full path with
/// nothing cmd.exe would read as syntax (an npm install is a `.cmd`). Any other
/// is left out, and Claude Code asks before reading there.
pub(crate) fn safe_dir(dir: &str) -> Option<&str> {
    let full = dir.starts_with("\\\\") || dir.starts_with('/') || dir.as_bytes().get(1) == Some(&b':');
    (full && dir.len() <= 1024 && !dir.chars().any(|c| c.is_control() || matches!(c, '"' | '%' | '^' | '&' | '|' | '<' | '>' | '!' | '`')))
        .then_some(dir)
}

/// What the chat's CLIs may do without a card, as picked in the chat's field
/// (Settings::chat_permission_mode): "default" asks for everything, "auto"
/// lets the CLI decide what is safe to do without asking (Claude Code's own
/// auto mode; "acceptEdits", picked before, reads as it), "plan" changes
/// nothing. Anything else — `bypassPermissions`, `dontAsk`, Antigravity's `turbo`, a typo — is
/// "default": nothing is ever allowed wholesale.
pub(crate) fn permission_mode(raw: &str) -> &'static str {
    match raw.trim() {
        "auto" | "acceptEdits" => "auto",
        "plan" => "plan",
        _ => "default",
    }
}

/// The settings the chat's run adds for itself (`--settings`; the user's
/// settings.json is not touched):
///   * Lumo's PermissionRequest hook, the same entry installing writes
///     (hooks::permission_request_entry), so a card comes up exactly when
///     Claude Code would ask: what the user's own rules, the mode or an "Allow
///     for this session" already allow goes through without one. `claude -p`
///     denies what nobody decided.
///   * a PreToolUse hook on shell commands that lets everything through as the
///     mode says, but a command that would sit waiting on GitHub (`gh pr checks
///     --watch`, a sleep loop): Claude is told to let Lumo listen instead
///     (lumo-hook reply::blocking_wait).
fn chat_settings(permission: Value, guard: &str) -> Value {
    json!({
        "hooks": {
            "PermissionRequest": [permission],
            "PreToolUse": [{
                "matcher": "Bash|PowerShell",
                "hooks": [{ "type": "command", "command": guard, "timeout": 10 }],
            }],
        },
    })
}

/// `args`, plus the chat's own hooks (`chat_settings`), when the file could be
/// written where Claude Code can be pointed at it.
fn with_cards(mut args: Vec<String>) -> Vec<String> {
    let guard = crate::agents::relay_command(crate::agents::Shell::Sh, "--chat-guard PreToolUse");
    let path = crate::platform::local_dir().join("chat-hooks.json");
    let text = chat_settings(crate::hooks::permission_request_entry(), &guard).to_string();
    let written = path.parent().is_some_and(|d| std::fs::create_dir_all(d).is_ok()) && std::fs::write(&path, text).is_ok();
    let path = path.to_string_lossy().to_string();
    if written && safe_dir(&path).is_some() {
        args.push("--settings".into());
        args.push(path);
    }
    args
}

/// The command-line arguments, all fixed or checked. The prompt is not one of them.
/// `folders`: what the user shared from File Explorer in this chat.
#[cfg(test)]
fn args(model: &str, effort: &str, mode: &str, session: Option<&str>, inbox: &str, folders: &[String]) -> Vec<String> {
    args_with(APPEND_PROMPT, model, effort, mode, session, inbox, folders)
}

/// `append`, added to Claude Code's instructions: from a file when it can be
/// written where Claude Code can be pointed at it. cmd.exe takes at most 8191
/// characters on a line, and the tool workshop's instructions alone fill most
/// of them: on the command line they made an npm install's `claude.cmd` fail
/// before Claude Code started. One file for each text, so chats running side
/// by side never read each other's.
fn instructions(append: &str) -> Vec<String> {
    use std::hash::{Hash, Hasher};
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    append.hash(&mut hash);
    let path = crate::platform::local_dir().join(format!("chat-prompt-{:016x}.txt", hash.finish()));
    let written = std::fs::read_to_string(&path).is_ok_and(|t| t == append)
        || (path.parent().is_some_and(|d| std::fs::create_dir_all(d).is_ok()) && std::fs::write(&path, append).is_ok());
    let path = path.to_string_lossy().to_string();
    if written && safe_dir(&path).is_some() {
        vec!["--append-system-prompt-file".into(), path]
    } else {
        vec!["--append-system-prompt".into(), append.to_string()]
    }
}

/// `args`, with `append` added to Claude Code's instructions instead of the chat's.
fn args_with(
    append: &str,
    model: &str,
    effort: &str,
    mode: &str,
    session: Option<&str>,
    inbox: &str,
    folders: &[String],
) -> Vec<String> {
    let mut a: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        // The mode picked in the chat, never one the user's settings default
        // to: what it does not let through is a card in the island.
        "--permission-mode",
        permission_mode(mode),
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    a.extend(instructions(append));
    a.push("--add-dir".into());
    a.push(inbox.to_string());
    for dir in folders.iter().filter_map(|d| safe_dir(d)) {
        a.push("--add-dir".into());
        a.push(dir.to_string());
    }
    if let Some(m) = safe_model(model) {
        a.push("--model".into());
        a.push(m.to_string());
    }
    if let Some(e) = safe_effort(effort) {
        a.push("--effort".into());
        a.push(e.to_string());
    }
    if let Some(s) = session.and_then(safe_session) {
        a.push("--resume".into());
        a.push(s.to_string());
    }
    a
}

/// What goes in on stdin: the question, with the file or the window when the
/// island sends one (a file only once, with the question after it was added),
/// and — when this session has not seen the turns before (another provider
/// answered them, or a message was edited) — that conversation as plain text,
/// with the files added in it (`files`: name, path).
pub(crate) fn prompt(context: Option<&ChatContext>, carried: &[Value], files: &[(String, String)], query: &str) -> String {
    let mut out = String::new();
    if !carried.is_empty() {
        let mut transcript = String::new();
        for turn in carried {
            let role = turn["role"].as_str().unwrap_or("user");
            let text = turn["content"].as_str().unwrap_or("");
            transcript.push_str(&format!("{role}: {text}\n\n"));
        }
        let cut: String = transcript.chars().rev().take(MAX_CARRIED_CHARS).collect::<Vec<_>>().into_iter().rev().collect();
        out.push_str("Earlier in this conversation:\n\n");
        out.push_str(&cut);
        let current = match context {
            Some(ChatContext::File { path, .. }) => Some(path.as_str()),
            _ => None,
        };
        let earlier: Vec<_> = files.iter().filter(|(_, p)| Some(p.as_str()) != current).collect();
        if !earlier.is_empty() {
            out.push_str("Files the user added earlier in this conversation:\n");
            for (name, path) in earlier {
                out.push_str(&format!("- {name}: {path}\n"));
            }
            out.push('\n');
        }
        out.push_str("---\n\n");
    }
    match context {
        Some(ChatContext::File { name, path }) => {
            out.push_str(&format!("The user added a file to the chat: {name}\nPath: {path}\n\n"));
        }
        Some(ChatContext::Window { app_name, title, url }) => {
            out.push_str(&chat::window_line(app_name, title, url.as_deref()));
            out.push_str("\n\n");
        }
        None => {}
    }
    out.push_str(query);
    out
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// The commands Claude Code's last turn said it has, for the island's menu.
static COMMANDS: std::sync::Mutex<Option<Vec<String>>> = std::sync::Mutex::new(None);

/// The commands Claude Code has, as its last turn said; None before one.
pub fn commands() -> Option<Vec<String>> {
    COMMANDS.lock().unwrap().clone()
}

/// A command's name as it may be typed: letters, digits and `-_:.`, never a path.
fn is_command_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && name.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
}

/// `init`'s `slash_commands`: the names, without a slash, once each.
fn command_names(list: &[Value]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in list.iter().filter_map(Value::as_str) {
        let name = name.trim_start_matches('/');
        if is_command_name(name) && !out.iter().any(|n| n == name) && out.len() < 200 {
            out.push(name.to_string());
        }
    }
    out
}

/// Whether `query` is one of Claude Code's commands, to go to it alone (chat.rs).
pub(crate) fn is_command(query: &str) -> bool {
    command_of(query).is_some()
}

/// The command `query` is, when it is one ("/compact", "/review 12"): its name.
fn command_of(query: &str) -> Option<&str> {
    let rest = query.trim().strip_prefix('/')?;
    let name = rest.split_whitespace().next()?;
    is_command_name(name).then_some(name)
}

// ── What Claude Code is doing ─────────────────────────────────────────────────

/// What the answer is doing while no text shows: the line next to the island's
/// typing dots (`chat-activity`, worded by views/chat.ts). `kind` is one of
/// thinking, read, search, command, edit, web, subtask, plan, screen, tool;
/// `detail` is a file name, a host, a search pattern or a tool's name, cut
/// short — never a full path.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Activity {
    pub kind: &'static str,
    pub detail: String,
}

impl Activity {
    pub(crate) fn new(kind: &'static str, detail: impl Into<String>) -> Self {
        Activity { kind, detail: detail.into() }
    }

    pub(crate) fn thinking() -> Self {
        Activity::new("thinking", "")
    }
}

/// A detail shows on one short line.
const MAX_DETAIL: usize = 48;

pub(crate) fn short(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= MAX_DETAIL {
        return line;
    }
    let cut: String = line.chars().take(MAX_DETAIL - 1).collect();
    format!("{}…", cut.trim_end())
}

/// The last part of a path, Windows or Unix.
pub(crate) fn file_name(path: &str) -> String {
    short(path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or(""))
}

/// The host of a URL, without "www.", a port or a sign-in.
pub(crate) fn host(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let authority = authority.rsplit('@').next().unwrap_or("");
    let name = authority.split(':').next().unwrap_or("");
    short(name.strip_prefix("www.").unwrap_or(name))
}

/// The screenshots screen.rs writes to the inbox (`screen::shot_file_name`).
pub(crate) fn is_screenshot(name: &str) -> bool {
    name.starts_with("screenshot-") && name.contains("-screen") && name.ends_with(".png")
}

/// A tool's name as words: `ToolSearch` → "Tool Search", `mcp__github__create_issue`
/// → "create issue (github)".
pub(crate) fn pretty_tool(name: &str) -> String {
    fn words(s: &str) -> String {
        let mut out = String::new();
        let mut prev_lower = false;
        for c in s.chars() {
            if c == '_' || c == '-' {
                out.push(' ');
                prev_lower = false;
                continue;
            }
            if c.is_uppercase() && prev_lower {
                out.push(' ');
            }
            prev_lower = c.is_lowercase() || c.is_ascii_digit();
            out.push(c);
        }
        out.split_whitespace().collect::<Vec<_>>().join(" ")
    }
    let pretty = match name.strip_prefix("mcp__") {
        Some(rest) => match rest.split_once("__") {
            Some((server, tool)) => format!("{} ({})", words(tool), words(server)),
            None => words(rest),
        },
        None => words(name),
    };
    short(&pretty)
}

// ── The files a turn used ─────────────────────────────────────────────────────

/// A file the answer read, changed or made, for the chat's files (`chat-file`
/// events, src/core/chat-files.ts): `kind` is read, edited or created, `path`
/// the full path the tool was given. Told once the tool ran without an error.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FileTouch {
    pub kind: &'static str,
    pub path: String,
}

impl FileTouch {
    pub(crate) fn new(kind: &'static str, path: &str) -> Option<Self> {
        let path = path.trim();
        is_full_path(path).then(|| FileTouch { kind, path: path.to_string() })
    }

    /// A file a tool writes whole: created when nothing was there before it ran.
    pub(crate) fn written(path: &str) -> Option<Self> {
        let existed = std::path::Path::new(path.trim()).exists();
        FileTouch::new(if existed { "edited" } else { "created" }, path)
    }
}

/// A full path: a drive (`C:\`), a share (`\\server\`) or a Unix root. A
/// relative one names no file the island could open.
pub(crate) fn is_full_path(path: &str) -> bool {
    let b = path.as_bytes();
    let drive = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/');
    drive || path.starts_with(r"\\") || path.starts_with('/')
}

/// What calling `name` with `input` does to a file; None for every other tool,
/// and for a screenshot the chat itself took.
fn touch_for(name: &str, input: &Value) -> Option<FileTouch> {
    let field = |keys: &[&str]| keys.iter().filter_map(|k| input.get(*k).and_then(Value::as_str)).find(|s| !s.trim().is_empty());
    match name {
        "Read" => field(&["file_path"]).filter(|p| !is_screenshot(&file_name(p))).and_then(|p| FileTouch::new("read", p)),
        "Edit" | "MultiEdit" => field(&["file_path"]).and_then(|p| FileTouch::new("edited", p)),
        "NotebookEdit" => field(&["notebook_path"]).and_then(|p| FileTouch::new("edited", p)),
        "Write" => field(&["file_path"]).and_then(FileTouch::written),
        _ => None,
    }
}

/// What calling tool `name` with `input` is doing, for the island.
fn activity_for(name: &str, input: &Value) -> Activity {
    let field = |keys: &[&str]| {
        keys.iter().filter_map(|k| input.get(*k).and_then(Value::as_str)).find(|s| !s.trim().is_empty()).unwrap_or("").to_string()
    };
    match name {
        "Read" | "NotebookRead" => {
            let file = file_name(&field(&["file_path", "notebook_path", "path"]));
            if is_screenshot(&file) {
                Activity::new("screen", "")
            } else {
                Activity::new("read", file)
            }
        }
        "Grep" | "Glob" => Activity::new("search", short(&field(&["pattern"]))),
        "LS" => Activity::new("search", ""),
        // What the command is for, as Claude Code describes it ("Watch the PR's checks").
        "Bash" | "PowerShell" => Activity::new("command", short(&field(&["description"]))),
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => Activity::new("edit", file_name(&field(&["file_path", "notebook_path"]))),
        "WebSearch" | "web_search" => Activity::new("web", ""),
        "WebFetch" | "web_fetch" => match host(&field(&["url"])) {
            h if h.is_empty() => Activity::new("web", ""),
            h => Activity::new("read", h),
        },
        "Task" | "Agent" => Activity::new("subtask", ""),
        "TodoWrite" | "TodoRead" | "EnterPlanMode" | "ExitPlanMode" => Activity::new("plan", ""),
        // Lumo's computer use (computer.rs): looking, or using the computer.
        "mcp__lumo__screenshot" | "mcp__lumo__zoom" => Activity::new("screen", ""),
        _ if name.starts_with("mcp__lumo__") => Activity::new("computer", ""),
        _ if name.to_lowercase().contains("screenshot") => Activity::new("screen", ""),
        _ => match pretty_tool(name) {
            p if p.is_empty() => Activity::thinking(),
            p => Activity::new("tool", p),
        },
    }
}

/// A line of the main conversation, not of a subagent (those carry a parent).
fn top_level(v: &Value) -> bool {
    v.get("parent_tool_use_id").map(Value::is_null).unwrap_or(true)
}

// ── Reading the stream ────────────────────────────────────────────────────────

/// What the stream-json output has told us so far.
#[derive(Default, Debug)]
struct Run {
    session: Option<String>,
    /// The text of the assistant message being written, for the island.
    visible: String,
    /// Every text of the turn, each message on its own lines (chat::keep_lumo_lines).
    said: String,
    /// The `result` line: final text, or the error Claude Code reported.
    result: Option<Result<String, String>>,
    denied: usize,
    /// The user pressed Stop and the CLI was ended.
    stopped: bool,
    /// What the answer is doing since the text last grew (None once it does).
    activity: Option<Activity>,
    /// `activity` changed and the island was not told yet (`take_activity`).
    activity_changed: bool,
    /// The tool calls of the message being written: block index, id, name, input so far.
    blocks: Vec<(u64, String, String, String)>,
    /// Tool calls not answered yet, oldest first: id and what each is doing.
    pending: Vec<(String, Activity)>,
    /// Plan tool calls of the main conversation not passed on yet (`take_plans`):
    /// name and whole input, for the Plan island (src/island/plan.ts).
    plans: Vec<(String, Value)>,
    /// Calls that read or write a file, waiting for their result: tool call id
    /// and the file. Seen before the tool runs, so Write knows whether it creates.
    touching: Vec<(String, FileTouch)>,
    /// Files used by calls that ran, not passed on yet (`take_files`).
    touched: Vec<FileTouch>,
    /// TaskCreate calls waiting for their result, which says the task's id:
    /// tool call id and input. The ids go on over the session (and further),
    /// so TaskUpdate's can only be matched with the ones TaskCreate answered.
    creating: Vec<(String, Value)>,
    /// The Claude plan's limits this turn reported (`rate_limit_event`), in the
    /// status line's shape: `five_hour` / `seven_day` → `used_percentage`, `resets_at`.
    rate_limits: serde_json::Map<String, Value>,
    /// The commands Claude Code said it has (`init`'s `slash_commands`), names without the slash.
    commands: Option<Vec<String>>,
    /// The conversation was compacted (`/compact`, or Claude Code doing it by itself).
    compacted: bool,
}

/// One `rate_limit_event` of the stream, in the status line's shape — the
/// plan gauge reads only that. Its `utilization` is a fraction. Claude Code
/// leaves it out while the window is far from its limit: the window is then
/// `low` (no figure, but its reset time), which the gauge shows as such.
fn plan_window(info: &Value) -> Option<(String, Value)> {
    let get = |camel: &str, snake: &str| info.get(camel).or_else(|| info.get(snake)).cloned().unwrap_or(Value::Null);
    let kind = get("rateLimitType", "rate_limit_type");
    let kind = kind.as_str().filter(|k| matches!(*k, "five_hour" | "seven_day"))?;
    let resets = get("resetsAt", "resets_at").as_f64().filter(|r| r.is_finite() && *r > 0.0)?;
    // Epoch seconds, as the status line has them; milliseconds are brought back.
    let resets = if resets > 1e12 { resets / 1000.0 } else { resets };
    match get("utilization", "utilization").as_f64().filter(|u| u.is_finite() && *u >= 0.0) {
        Some(used) => Some((kind.to_string(), json!({ "used_percentage": (used * 100.0).min(200.0), "resets_at": resets.round() }))),
        None if get("status", "status").as_str() == Some("allowed") => {
            Some((kind.to_string(), json!({ "low": true, "resets_at": resets.round() })))
        }
        None => None,
    }
}

/// The tools an agent writes its plan with (src/core/agent-plan.ts reads them).
fn is_plan_tool(name: &str) -> bool {
    matches!(name, "TodoWrite" | "ExitPlanMode" | "TaskCreate" | "TaskUpdate")
}

/// The id of the task a TaskCreate result says it made: the structured
/// result (`tool_use_result.task.id`), else its text ("Task #4 created…").
/// None when it failed.
fn created_task_id(line: &Value, result: &Value) -> Option<String> {
    if result["is_error"].as_bool() == Some(true) {
        return None;
    }
    if let Some(id) = line["tool_use_result"]["task"]["id"].as_str().filter(|s| !s.is_empty()) {
        return Some(id.to_string());
    }
    let text = match &result["content"] {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join(" "),
        _ => String::new(),
    };
    let rest = &text[text.find('#')? + 1..];
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    (!digits.is_empty()).then_some(digits)
}

impl Run {
    /// The plan tool calls seen since the last time, oldest first.
    fn take_plans(&mut self) -> Vec<(String, Value)> {
        std::mem::take(&mut self.plans)
    }

    /// The files used since the last time, oldest first.
    fn take_files(&mut self) -> Vec<FileTouch> {
        std::mem::take(&mut self.touched)
    }

    /// The files the tools of a whole message use, the main conversation's or
    /// a subagent's: a call is noted with its file, and told once it ran
    /// without an error.
    fn files_of(&mut self, v: &Value) {
        let user = v["type"] == "user";
        for block in v["message"]["content"].as_array().into_iter().flatten() {
            if !user && matches!(block["type"].as_str(), Some("tool_use" | "server_tool_use")) {
                let id = block["id"].as_str().unwrap_or("").to_string();
                if let Some(touch) = touch_for(block["name"].as_str().unwrap_or(""), &block["input"]) {
                    if !id.is_empty() && !self.touching.iter().any(|(t, _)| *t == id) {
                        self.touching.push((id, touch));
                    }
                }
            } else if user && block["type"] == "tool_result" {
                let id = block["tool_use_id"].as_str().unwrap_or("");
                let Some(pos) = self.touching.iter().position(|(t, _)| t == id) else { continue };
                let (_, mut touch) = self.touching.remove(pos);
                if block["is_error"].as_bool() == Some(true) {
                    continue;
                }
                // Claude Code says itself whether Write made the file.
                if touch.kind != "read" {
                    match v["tool_use_result"]["type"].as_str() {
                        Some("create") => touch.kind = "created",
                        Some("update") => touch.kind = "edited",
                        _ => {}
                    }
                }
                self.touched.push(touch);
            }
        }
    }

    /// Takes one line; true when the visible text changed.
    fn feed(&mut self, line: &[u8]) -> bool {
        let Ok(v) = serde_json::from_slice::<Value>(line) else { return false };
        if let Some(id) = v.get("session_id").and_then(Value::as_str).and_then(safe_session) {
            self.session = Some(id.to_string());
        }
        match v.get("type").and_then(Value::as_str) {
            Some("stream_event") => {
                // Messages of subagents carry a parent: only the main conversation
                // shows (its Task call already says a sub-task is being worked on).
                if !top_level(&v) {
                    return false;
                }
                let event = &v["event"];
                let index = event["index"].as_u64().unwrap_or(0);
                match event["type"].as_str() {
                    Some("message_start") => {
                        self.blocks.clear();
                        self.said.push('\n');
                        let changed = !self.visible.is_empty();
                        self.visible.clear();
                        changed
                    }
                    Some("content_block_start") => {
                        let block = &event["content_block"];
                        match block["type"].as_str() {
                            Some("tool_use" | "server_tool_use") => {
                                let name = block["name"].as_str().unwrap_or("").to_string();
                                let id = block["id"].as_str().unwrap_or("").to_string();
                                // The input comes in pieces, then whole in the
                                // `assistant` line: the tool alone says enough for now.
                                self.set_activity(activity_for(&name, &block["input"]));
                                self.blocks.retain(|b| b.0 != index);
                                self.blocks.push((index, id, name, String::new()));
                            }
                            Some("thinking" | "redacted_thinking") => self.set_activity(Activity::thinking()),
                            _ => {}
                        }
                        false
                    }
                    Some("content_block_delta") if event["delta"]["type"] == "input_json_delta" => {
                        if let Some(b) = self.blocks.iter_mut().find(|b| b.0 == index) {
                            b.3.push_str(event["delta"]["partial_json"].as_str().unwrap_or(""));
                        }
                        false
                    }
                    Some("content_block_stop") => {
                        if let Some(pos) = self.blocks.iter().position(|b| b.0 == index) {
                            let (_, id, name, input) = self.blocks.remove(pos);
                            let input = serde_json::from_str::<Value>(&input).unwrap_or(Value::Null);
                            self.started_tool(id, activity_for(&name, &input));
                        }
                        false
                    }
                    Some("content_block_delta") if event["delta"]["type"] == "text_delta" => {
                        let text = event["delta"]["text"].as_str().unwrap_or("");
                        self.visible.push_str(text);
                        self.said.push_str(text);
                        if !text.is_empty() {
                            // The text shows instead: a later tool call is news again.
                            self.activity = None;
                            self.activity_changed = false;
                        }
                        !text.is_empty()
                    }
                    _ => false,
                }
            }
            // A subagent's message: only the files its tools use, for the chat's files.
            Some("assistant" | "user") if !top_level(&v) => {
                self.files_of(&v);
                false
            }
            // The whole message, with the tool inputs complete.
            Some("assistant") if top_level(&v) => {
                self.files_of(&v);
                for block in v["message"]["content"].as_array().into_iter().flatten() {
                    if matches!(block["type"].as_str(), Some("tool_use" | "server_tool_use")) {
                        let name = block["name"].as_str().unwrap_or("");
                        let id = block["id"].as_str().unwrap_or("").to_string();
                        self.started_tool(id.clone(), activity_for(name, &block["input"]));
                        if name == "TaskCreate" {
                            self.creating.push((id.clone(), block["input"].clone()));
                        } else if is_plan_tool(name) {
                            self.plans.push((name.to_string(), block["input"].clone()));
                        }
                    }
                }
                false
            }
            // Tool results: once every call is answered, Claude thinks again.
            Some("user") if top_level(&v) => {
                self.files_of(&v);
                let mut answered = false;
                for block in v["message"]["content"].as_array().into_iter().flatten() {
                    if block["type"] == "tool_result" {
                        let id = block["tool_use_id"].as_str().unwrap_or("");
                        if let Some(pos) = self.creating.iter().position(|(c, _)| c == id) {
                            let (_, mut input) = self.creating.remove(pos);
                            if let Some(task) = created_task_id(&v, block) {
                                input["taskId"] = Value::String(task);
                                self.plans.push(("TaskCreate".to_string(), input));
                            }
                        }
                        let before = self.pending.len();
                        self.pending.retain(|(p, _)| p != id);
                        answered |= self.pending.len() != before;
                    }
                }
                if answered {
                    let next = self.pending.last().map(|(_, a)| a.clone()).unwrap_or_else(Activity::thinking);
                    self.set_activity(next);
                }
                false
            }
            Some("rate_limit_event") => {
                if let Some((kind, window)) = plan_window(&v["rate_limit_info"]) {
                    self.rate_limits.insert(kind, window);
                }
                false
            }
            Some("system") if v["subtype"] == "permission_denied" => {
                self.denied += 1;
                false
            }
            Some("system") if v["subtype"] == "init" => {
                if let Some(list) = v["slash_commands"].as_array() {
                    self.commands = Some(command_names(list));
                }
                false
            }
            Some("system") if v["subtype"] == "compact_boundary" => {
                self.compacted = true;
                false
            }
            Some("result") => {
                let text = v["result"].as_str().unwrap_or("").to_string();
                let is_error = v["is_error"].as_bool().unwrap_or(false) || v["subtype"].as_str().is_some_and(|s| s != "success");
                self.result = Some(if is_error {
                    Err(if text.is_empty() { v["subtype"].as_str().unwrap_or("error").to_string() } else { text })
                } else {
                    Ok(text)
                });
                false
            }
            _ => false,
        }
    }

    fn set_activity(&mut self, activity: Activity) {
        if self.activity.as_ref() != Some(&activity) {
            self.activity = Some(activity);
            self.activity_changed = true;
        }
    }

    /// A tool call, its input complete or not: remembered until its result comes.
    fn started_tool(&mut self, id: String, activity: Activity) {
        if !id.is_empty() {
            match self.pending.iter_mut().find(|(p, _)| *p == id) {
                Some(entry) => entry.1 = activity.clone(),
                None => self.pending.push((id, activity.clone())),
            }
        }
        self.set_activity(activity);
    }

    /// The activity, once each time it changes.
    fn take_activity(&mut self) -> Option<Activity> {
        if !self.activity_changed {
            return None;
        }
        self.activity_changed = false;
        self.activity.clone()
    }
}

/// A command that runs Claude Code's `exe`. An npm install is a script that
/// needs its own Node: its folder goes first on PATH.
pub(crate) fn cli_command(exe: &std::path::Path) -> Command {
    let mut cmd = Command::new(exe);
    if let Some(parent) = exe.parent() {
        let mut dirs = vec![parent.to_path_buf()];
        if let Some(path) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&path));
        }
        if let Ok(joined) = std::env::join_paths(dirs) {
            cmd.env("PATH", joined);
        }
    }
    cmd
}

/// Starts Claude Code's `exe` in `dir` with `args`, stdin, stdout and stderr
/// piped, marked as the island's own run (for chat `chat_id`).
fn spawn(exe: &std::path::Path, args: &[String], dir: &std::path::Path, chat_id: &str) -> Result<std::process::Child, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut cmd = cli_command(exe);
    cmd.args(args).current_dir(dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Tells lumo-hook this run is the island's chat, not a session to show.
    cmd.env("LUMO_ISLAND_RUN", "1");
    // Which chat the island's tools are called from (lumo-hook's MCP server, island_tools.rs).
    if !chat_id.is_empty() {
        cmd.env("LUMO_CHAT_ID", chat_id);
    }
    // Claude Code only gives its newer models its to-do tools (TodoWrite, or
    // TaskCreate and TaskUpdate) when asked: without them the chat's plan is
    // only text, and the Plan island stays shut.
    cmd.env("CLAUDE_CODE_ENABLE_TODO_TOOLS", "1");
    platform::no_console(&mut cmd);
    cmd.spawn().map_err(|e| tf("Cannot start Claude Code: {error}", &[("error", &e.to_string())]))
}

/// Reads `child`'s stderr in the background, its first 64 KB kept.
pub(crate) fn read_stderr(child: &mut std::process::Child) -> Arc<std::sync::Mutex<String>> {
    let kept = Arc::new(std::sync::Mutex::new(String::new()));
    if let Some(mut e) = child.stderr.take() {
        let into = kept.clone();
        std::thread::spawn(move || {
            // Not always UTF-8: cmd.exe says what went wrong in the console's
            // code page ("La riga di comando è troppo lunga."), kept all the same.
            let mut bytes = Vec::new();
            let _ = (&mut e).take(64 * 1024).read_to_end(&mut bytes);
            *into.lock().unwrap_or_else(|p| p.into_inner()) = String::from_utf8_lossy(&bytes).into_owned();
            // Past the cap, keep the pipe flowing: a full one would stall claude.
            let _ = std::io::copy(&mut e, &mut std::io::sink());
        });
    }
    kept
}

/// `child`'s stdout, line by line, on a channel; at most `max_total` bytes in all.
pub(crate) fn read_lines(child: &mut std::process::Child, max_total: usize) -> Result<mpsc::Receiver<Vec<u8>>, String> {
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut total = 0usize;
        loop {
            let mut line = Vec::new();
            match (&mut reader).take(MAX_LINE as u64 + 1).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    total = total.saturating_add(n);
                    if total > max_total || tx.send(line).is_err() {
                        break;
                    }
                }
            }
        }
        // Whatever is left is read and dropped, so claude never blocks on a
        // full pipe while the turn winds down.
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
    });
    Ok(rx)
}

/// How a turn read off the stream ended.
#[derive(Debug, PartialEq)]
enum Ended {
    /// Its `result` line came.
    Result,
    /// The output closed first: the CLI ended.
    Closed,
    /// Stop was pressed, and the CLI could not be interrupted (or not in time): it must be ended.
    Stopped,
}

/// Reads one turn off `rx` until its `result`. `on_text` gets the visible
/// text as it grows, `on_activity` what Claude Code is doing each time it
/// changes, `on_file` each file a tool read or wrote once it ran, `on_plan`
/// each plan tool call (name, whole input). On Stop,
/// `interrupt` asks the CLI to end the turn and says whether it could; the
/// turn then goes on until its result, for INTERRUPT_GRACE at most.
fn read_turn(
    rx: &mpsc::Receiver<Vec<u8>>,
    stop: &Stop,
    mut interrupt: impl FnMut() -> bool,
    mut on_text: impl FnMut(&str),
    mut on_activity: impl FnMut(&Activity),
    mut on_file: impl FnMut(&FileTouch),
    mut on_plan: impl FnMut(&str, &Value),
) -> (Run, Ended) {
    let mut last_emit = Instant::now() - DELTA_INTERVAL;
    // Text the island was not shown yet (it is told at most every DELTA_INTERVAL).
    let mut unsent = false;
    let mut state = Run::default();
    let mut interrupted: Option<Instant> = None;
    // No time limit: a long piece of work, or a card nobody clicked yet, goes
    // on until it ends or the user presses Stop.
    loop {
        if stop.is_stopped() && !state.stopped {
            state.stopped = true;
            if !interrupt() {
                return (state, Ended::Stopped);
            }
            interrupted = Some(Instant::now());
        }
        if interrupted.is_some_and(|at| at.elapsed() > INTERRUPT_GRACE) {
            return (state, Ended::Stopped);
        }
        // Short waits, so Stop is felt at once (only while a turn runs).
        match rx.recv_timeout(STOP_POLL) {
            Ok(line) => {
                unsent |= state.feed(&line);
                let activity = state.take_activity();
                // What was written goes before what is done next, in order.
                if unsent && (activity.is_some() || last_emit.elapsed() >= DELTA_INTERVAL) && !state.stopped {
                    unsent = false;
                    last_emit = Instant::now();
                    on_text(&state.visible);
                }
                if let Some(activity) = activity.filter(|_| !state.stopped) {
                    on_activity(&activity);
                }
                for file in state.take_files() {
                    on_file(&file);
                }
                for (name, input) in state.take_plans() {
                    on_plan(&name, &input);
                }
                if state.result.is_some() {
                    return (state, Ended::Result);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return (state, Ended::Closed),
        }
    }
}

/// Why the CLI ended without a result, from what it wrote on stderr.
fn ended_without_answer(stderr: &str, status: Option<std::process::ExitStatus>) -> String {
    let detail = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
    let code = status.and_then(|s| s.code()).map(|c| c.to_string()).unwrap_or_default();
    if detail.is_empty() {
        tf("Claude Code stopped without an answer (exit {code}). Is it signed in? Run `claude` once in a terminal.", &[("code", &code)])
    } else {
        tf("Claude Code: {error}", &[("error", &detail)])
    }
}

/// Runs `claude -p` once in `dir`, blocking, the prompt on stdin (`read_turn`
/// says what the callbacks get). Stop ends the CLI and its children; the run
/// so far is returned, `stopped`.
#[allow(clippy::too_many_arguments)]
fn run(
    exe: PathBuf,
    args: Vec<String>,
    input: String,
    dir: PathBuf,
    chat_id: &str,
    stop: Arc<Stop>,
    on_text: impl FnMut(&str),
    on_activity: impl FnMut(&Activity),
    on_file: impl FnMut(&FileTouch),
    on_plan: impl FnMut(&str, &Value),
) -> Result<Run, String> {
    let mut child = spawn(&exe, &args, &dir, chat_id)?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes());
        // Dropping stdin ends the prompt.
    }
    let stderr = read_stderr(&mut child);
    let rx = read_lines(&mut child, MAX_TOTAL)?;
    let (state, ended) = read_turn(&rx, &stop, || false, on_text, on_activity, on_file, on_plan);
    if ended == Ended::Stopped {
        kill_tree(&mut child);
        return Ok(state);
    }
    let status = child.wait().ok();
    if state.result.is_none() {
        // The reader is done with stderr once the CLI ended.
        std::thread::sleep(Duration::from_millis(50));
        let stderr = stderr.lock().unwrap_or_else(|p| p.into_inner()).clone();
        return Err(ended_without_answer(&stderr, status));
    }
    Ok(state)
}

// ── One Claude Code per chat ──────────────────────────────────────────────────
//
// The island's chat keeps one Claude Code running for each chat
// (`--input-format stream-json`): each message goes in on its stdin as a
// stream-json user message, and the turn ends with its `result` line, the
// process still there for the next one. MCP servers, plugins and the session
// load once per chat, not once per message, and Stop interrupts the turn
// (a `control_request` of subtype `interrupt`, as the Agent SDK sends) instead
// of ending the process. A Claude Code idle for LIVE_IDLE is ended; one whose
// settings changed (model, effort, mode, tools, folders) or whose session is not
// the chat's any more (a new chat, an edited message) is ended and started
// again, resuming the chat's session.

/// How long a chat's Claude Code waits for the next message before it is ended.
const LIVE_IDLE: Duration = Duration::from_secs(10 * 60);
/// How long an interrupted turn may take to end before its Claude Code is ended.
const INTERRUPT_GRACE: Duration = Duration::from_secs(5);

/// A chat's Claude Code, between two turns.
struct Live {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    rx: mpsc::Receiver<Vec<u8>>,
    stderr: Arc<std::sync::Mutex<String>>,
    /// What it was started with (`live_key`).
    key: String,
    /// The session it is in, once its stream said.
    session: Option<String>,
    used: Instant,
}

impl Drop for Live {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            kill_tree(&mut self.child);
        }
    }
}

/// Every chat's Claude Code, by chat id, while it waits for a message.
static LIVES: std::sync::Mutex<Option<std::collections::HashMap<String, Live>>> = std::sync::Mutex::new(None);
/// Whether the thread that ends idle ones runs.
static REAPING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn lives<T>(f: impl FnOnce(&mut std::collections::HashMap<String, Live>) -> T) -> T {
    f(LIVES.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(Default::default))
}

/// What a chat's Claude Code is started with, but the session it resumes:
/// the same key, the same process can answer.
fn live_key(exe: &std::path::Path, args: &[String]) -> String {
    let mut parts = vec![exe.to_string_lossy().to_string()];
    let mut skip = false;
    for a in args {
        if std::mem::take(&mut skip) {
            continue;
        }
        if a == "--resume" {
            skip = true;
            continue;
        }
        parts.push(a.clone());
    }
    parts.join("\n")
}

/// The arguments of a chat's Claude Code: `args`, taking its messages as stream-json.
fn live_args(mut args: Vec<String>) -> Vec<String> {
    args.push("--input-format".into());
    args.push("stream-json".into());
    args
}

/// One message as Claude Code takes it on stdin (`--input-format stream-json`).
fn user_line(text: &str) -> String {
    format!("{}\n", json!({ "type": "user", "message": { "role": "user", "content": [{ "type": "text", "text": text }] } }))
}

/// Asks Claude Code to end the turn it is on, keeping the process and the session.
fn interrupt_line(n: u64) -> String {
    format!("{}\n", json!({ "type": "control_request", "request_id": format!("lumo-interrupt-{n}"), "request": { "subtype": "interrupt" } }))
}

/// Ends the chats' Claude Codes idle for LIVE_IDLE, or ended already, once a
/// minute while there is one; the thread goes when none is left.
fn reap_idle() {
    if REAPING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(60));
        let gone: Vec<Live> = lives(|all| {
            let ids: Vec<String> = all
                .iter_mut()
                .filter_map(|(id, l)| (l.used.elapsed() > LIVE_IDLE || !matches!(l.child.try_wait(), Ok(None))).then(|| id.clone()))
                .collect();
            ids.iter().filter_map(|id| all.remove(id)).collect()
        });
        // Ended here, out of the lock (Drop ends each).
        drop(gone);
        let empty = lives(|all| {
            let empty = all.is_empty();
            if empty {
                REAPING.store(false, std::sync::atomic::Ordering::SeqCst);
            }
            empty
        });
        if empty {
            return;
        }
    });
}

/// The chat's Claude Code that can answer with `key` in `session`, or a new one.
fn live_for(chat_id: &str, key: &str, session: Option<&str>, exe: &std::path::Path, args: &[String], dir: &std::path::Path) -> Result<Live, String> {
    if let Some(mut live) = lives(|all| all.remove(chat_id)) {
        let alive = matches!(live.child.try_wait(), Ok(None));
        // Lines left from the turn before (after an interrupt) are not this turn's.
        let mut open = true;
        loop {
            match live.rx.try_recv() {
                Ok(_) => continue,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    open = false;
                    break;
                }
            }
        }
        if alive && open && live.key == key && live.session.as_deref() == session {
            return Ok(live);
        }
        // Another model, mode or session: this one goes (Drop ends it).
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut child = spawn(exe, &live_args(args.to_vec()), dir, chat_id)?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stderr = read_stderr(&mut child);
    let rx = read_lines(&mut child, usize::MAX)?;
    Ok(Live { child, stdin, rx, stderr, key: key.to_string(), session: session.map(str::to_string), used: Instant::now() })
}

/// One turn of the chat `chat_id` through its own Claude Code (started, or
/// started again, as needed), blocking. `session`: the chat's Claude Code
/// session, resumed by `args` when a new process starts. As `run` otherwise.
#[allow(clippy::too_many_arguments)]
fn live_turn(
    exe: PathBuf,
    args: Vec<String>,
    input: String,
    dir: PathBuf,
    chat_id: &str,
    session: Option<String>,
    stop: Arc<Stop>,
    on_text: impl FnMut(&str),
    on_activity: impl FnMut(&Activity),
    on_file: impl FnMut(&FileTouch),
    on_plan: impl FnMut(&str, &Value),
) -> Result<Run, String> {
    let key = live_key(&exe, &args);
    let mut live = live_for(chat_id, &key, session.as_deref(), &exe, &args, &dir)?;
    if live.stdin.write_all(user_line(&input).as_bytes()).and_then(|_| live.stdin.flush()).is_err() {
        // It ended between two messages: once more, with a new one.
        drop(live);
        live = live_for(chat_id, &key, session.as_deref(), &exe, &args, &dir)?;
        live.stdin.write_all(user_line(&input).as_bytes()).and_then(|_| live.stdin.flush()).map_err(|e| e.to_string())?;
    }
    let mut asked = 0u64;
    let stdin = &mut live.stdin;
    let (state, ended) = read_turn(
        &live.rx,
        &stop,
        || {
            asked += 1;
            stdin.write_all(interrupt_line(asked).as_bytes()).and_then(|_| stdin.flush()).is_ok()
        },
        on_text,
        on_activity,
        on_file,
        on_plan,
    );
    match ended {
        Ended::Result => {
            if state.session.is_some() {
                live.session = state.session.clone();
            }
            live.used = Instant::now();
            let old = lives(|all| all.insert(chat_id.to_string(), live));
            drop(old);
            reap_idle();
            Ok(state)
        }
        // Not interrupted in time: ended, the run so far kept.
        Ended::Stopped => Ok(state),
        Ended::Closed => {
            let status = live.child.wait().ok();
            if state.stopped {
                return Ok(state);
            }
            std::thread::sleep(Duration::from_millis(50));
            let stderr = live.stderr.lock().unwrap_or_else(|p| p.into_inner()).clone();
            Err(ended_without_answer(&stderr, status))
        }
    }
}

/// Ends the chat's Claude Code, if one waits between two turns (the chat starts afresh).
pub fn close(chat_id: &str) {
    let gone = lives(|all| all.remove(chat_id));
    drop(gone);
}

/// An npm install runs `claude.cmd`: killing cmd.exe alone would leave node running.
pub(crate) fn kill_tree(child: &mut std::process::Child) {
    let mut kill = Command::new("taskkill");
    kill.args(["/T", "/F", "/PID", &child.id().to_string()]);
    platform::no_console(&mut kill);
    let _ = kill.status();
    let _ = child.kill();
    let _ = child.wait();
}

/// One chat turn through Claude Code.
#[allow(clippy::too_many_arguments)]
pub async fn send(
    app: &AppHandle,
    chat: &Chat,
    model: &str,
    effort: &str,
    mode: &str,
    computer: bool,
    query: String,
    context: Option<ChatContext>,
    folder: Option<String>,
) -> Result<ChatReply, String> {
    let exe = platform::claude_candidates()
        .into_iter()
        .next()
        .ok_or_else(|| t("Claude Code isn't installed. Install it, sign in once with `claude` in a terminal, then try again."))?;

    let turn = chat.begin(PROVIDER);
    // Only a Claude Code session: never an Antigravity CLI conversation.
    let session = chat.cli_session_for(PROVIDER);
    // Turns this session has not seen (another provider answered them, or a
    // message was edited) are carried over once, as text.
    let carried: Vec<Value> = if session.is_none() { turn.history.clone() } else { Vec::new() };
    // A command goes alone, as typed: anything in front of it and it is a question.
    let command = command_of(&query).map(str::to_string);
    if command.is_some() && !carried.is_empty() {
        // A fresh session would run it on nothing, and then never be told the conversation.
        return Ok(ChatReply::answer(t("Send a message first: Claude Code hasn't seen this conversation yet."), chat.cli_session()));
    }
    let input = if command.is_some() { query.trim().to_string() } else { prompt(context.as_ref(), &carried, &chat.files(), &query) };
    let inbox = crate::files::inbox_dir().to_string_lossy().to_string();
    // Computer use: the chat's own instructions, Lumo's MCP server, and the
    // computer only usable while this turn runs.
    let base = if computer { COMPUTER_PROMPT } else { APPEND_PROMPT };
    // The tool workshop: what a tool is and how to hand one over, too.
    let append = if chat.is_workshop() { format!("{base}{}{WORKSHOP_TRY}", crate::chat::workshop_note!()) } else { base.to_string() };
    let mut args = with_cards(args_with(&append, model, effort, mode, session.as_deref(), &inbox, &chat.cli_dirs(folder)));
    // The user's tools that are on, for Claude to use (each call asks on the island).
    let tools = tauri::async_runtime::spawn_blocking(crate::tools::any_enabled).await.unwrap_or(false);
    // Lumo's email tools, as Settings → General → Security lets the AI have them,
    // usable only while this turn runs.
    let mail = crate::mail::ai_tools(app);
    args = with_mcp(args, computer, tools, true, mail);
    let _mail = (!mail.is_empty()).then(crate::mail::agent_turn);
    if computer {
        crate::computer::begin_turn();
    }

    let app2 = app.clone();
    let app3 = app.clone();
    let events = chat.events();
    let stop = chat.stopper();
    let chat_id = chat.id().to_string();
    let resumed = session.clone();
    let state = tauri::async_runtime::spawn_blocking(move || {
        live_turn(
            exe,
            args,
            input,
            work_dir(),
            &chat_id,
            resumed,
            stop,
            |text| events.delta(&app2, text),
            |activity| events.activity(&app2, activity),
            |file| events.file(&app2, file),
            // The plan Claude writes in the chat, for the Plan island.
            |tool, input| {
                let _ = app3.emit_to(WINDOW_LABEL, "chat-plan", json!({ "tool": tool, "input": input }));
            },
        )
    })
    .await
    .map_err(|e| e.to_string());
    if computer {
        crate::computer::end_turn(app);
    }
    let state = state??;

    // The commands it has, for the island's "/" menu.
    if let Some(list) = &state.commands {
        *COMMANDS.lock().unwrap() = Some(list.clone());
        let _ = app.emit_to(WINDOW_LABEL, "chat-commands", list);
    }
    // The plan's limits, when the turn said: the island's plan gauge (and the
    // chat's usage line) need not wait for a terminal session's status line.
    if !state.rate_limits.is_empty() {
        let _ = app.emit_to(WINDOW_LABEL, "chat-plan-usage", Value::Object(state.rate_limits.clone()));
    }
    // A stopped turn keeps its session too: Claude Code has the question and
    // what it wrote, as the island does.
    if let Some(id) = &state.session {
        chat.set_cli_session(&turn, id);
    }
    let plain = chat::plain_question(true, context.as_ref(), &query);
    if state.stopped {
        let shown = state.visible.trim().to_string();
        if !shown.is_empty() {
            chat.commit(&turn, json!({ "role": "user", "content": plain }), json!({ "role": "assistant", "content": shown }), &plain, &shown);
        }
        return Ok(ChatReply::stopped(shown, chat.cli_session()));
    }
    let answer = match state.result {
        Some(Ok(text)) => text,
        Some(Err(e)) => return Err(tf("Claude Code: {error}", &[("error", &e)])),
        None => unreachable!("live_turn() returns an error without a result"),
    };
    let answer = chat::keep_lumo_lines(answer, &state.said);
    let answer = if answer.trim().is_empty() && state.denied > 0 {
        t("Claude Code needed a permission that wasn't given. Install Lumo's hooks to approve actions from the island.")
    } else if answer.trim().is_empty() && state.compacted {
        t("Claude Code compacted the conversation.")
    } else if let Some(name) = command.as_deref().filter(|_| answer.trim().is_empty()) {
        // Some commands answer nothing: the chat still says it ran.
        tf("Claude Code ran /{command}.", &[("command", name)])
    } else {
        answer
    };
    chat.commit(&turn, json!({ "role": "user", "content": plain }), json!({ "role": "assistant", "content": answer }), &plain, &answer);
    Ok(ChatReply::answer(answer, chat.cli_session()))
}

// ── Helping Gemini Live ───────────────────────────────────────────────────────

/// Added to Claude Code's instructions when Gemini Live hands it a task (live.rs).
const HELPER_PROMPT: &str = "You are helping Gemini, the voice assistant of the Lumo island at the top of the user's screen. \
Gemini is talking with the user and handed you this task because it cannot do it by itself: the task is the user's spoken request, as Gemini relayed it. \
Do the task with every tool you have, including the apps and accounts the user connected, such as their calendar, email or documents: the task may need them. Then answer with a short plain-text summary of what you did or found, in the language of the task: Gemini reads it aloud, so no Markdown, no tables and no code unless the user asked for code. \
Every action that needs a permission is approved by the user in the island, so ask for it normally. \
When an action is denied or does not run, say plainly what you could not do and why, and never claim it ran.";

/// The helper's instructions when it may use the computer: Gemini hands over
/// what is to be done on the screen ("click Send", "fill in the form").
const HELPER_COMPUTER_PROMPT: &str = concat!(
    "You are helping Gemini, the voice assistant of the Lumo island at the top of the user's screen. \
Gemini is talking with the user and handed you this task because it cannot do it by itself: the task is the user's spoken request, as Gemini relayed it. \
Do the task with every tool you have, including the apps and accounts the user connected, such as their calendar, email or documents: the task may need them. Then answer with a short plain-text summary of what you did or found, in the language of the task: Gemini reads it aloud, so no Markdown, no tables and no code unless the user asked for code. ",
    crate::computer::computer_note!(),
    "Every action that needs a permission is approved by the user in the island, so ask for it normally. \
When an action is denied or does not run, say plainly what you could not do and why, and never claim it ran."
);

/// Runs one task Gemini Live handed over, in `folder` when it is a folder
/// (the Lumo folder otherwise), with the `model` and `effort` of Settings →
/// Voice and the chat's permission `mode`: what it may not do by itself is an
/// Allow / Deny card in the island, as in the chat. No session is kept: each
/// task starts afresh. Blocking.
#[allow(clippy::too_many_arguments)]
pub(crate) fn help(
    task: &str,
    folder: Option<&str>,
    model: &str,
    effort: &str,
    mode: &str,
    computer: bool,
    stop: Arc<Stop>,
    on_activity: impl FnMut(&Activity),
) -> Result<String, String> {
    let exe = platform::claude_candidates()
        .into_iter()
        .next()
        .ok_or_else(|| t("Claude Code isn't installed. Install it, sign in once with `claude` in a terminal, then try again."))?;
    let folder = folder.filter(|d| safe_dir(d).is_some() && std::path::Path::new(d).is_dir());
    let dir = folder.map(PathBuf::from).unwrap_or_else(work_dir);
    let inbox = crate::files::inbox_dir().to_string_lossy().to_string();
    let folders: Vec<String> = folder.map(|f| vec![f.to_string()]).unwrap_or_default();
    let prompt = if computer { HELPER_COMPUTER_PROMPT } else { HELPER_PROMPT };
    let args = with_cards(args_with(prompt, model, effort, mode, None, &inbox, &folders));
    // The user's own tools too, while one is on.
    let args = with_mcp(args, computer, crate::tools::any_enabled(), false, "");
    let state = run(exe, args, task.to_string(), dir, "", stop, |_| {}, on_activity, |_| {}, |_, _| {})?;
    if state.stopped {
        return Err(t("The task was stopped."));
    }
    match state.result {
        Some(Ok(text)) if text.trim().is_empty() && state.denied > 0 => {
            Err(t("Claude Code needed a permission that wasn't given. Install Lumo's hooks to approve actions from the island."))
        }
        Some(Ok(text)) if text.trim().is_empty() => Ok(state.visible.trim().to_string()),
        Some(Ok(text)) => Ok(text),
        Some(Err(e)) => Err(tf("Claude Code: {error}", &[("error", &e)])),
        None => unreachable!("run() returns an error without a result"),
    }
}

/// One question for Claude Code, answered without acting (plan mode, in a
/// folder of its own, none of the user's tools): the supervisor's review of a tool
/// (tool_review.rs). The question goes on stdin, never the command line.
pub(crate) fn complete(model: &str, prompt: &str) -> Result<String, String> {
    let exe = platform::claude_candidates()
        .into_iter()
        .next()
        .ok_or_else(|| t("Claude Code isn't installed. Install it, sign in once with `claude` in a terminal, then try again."))?;
    let mut args: Vec<String> =
        ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan"].iter().map(|s| s.to_string()).collect();
    if let Some(m) = safe_model(model) {
        args.push("--model".into());
        args.push(m.into());
    }
    let dir = platform::local_dir().join("tool-review");
    let state = run(exe, args, prompt.to_string(), dir, "", Arc::new(Stop::default()), |_| {}, |_| {}, |_| {}, |_, _| {})?;
    match state.result {
        Some(Ok(text)) if !text.trim().is_empty() => Ok(text),
        Some(Ok(_)) => Ok(state.visible.trim().to_string()),
        Some(Err(e)) => Err(tf("Claude Code: {error}", &[("error", &e)])),
        None => Err(t("No response text.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "0b5a8f2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b";

    #[test]
    fn a_task_from_gemini_gets_the_helper_instructions_and_no_session() {
        let a = args_with(HELPER_PROMPT, DEFAULT_MODEL, "", "auto", None, "/home/me/.local/share/lumo/inbox", &["/home/me/docs".into()]);
        assert!(
            a.windows(2).any(|w| w == ["--append-system-prompt", HELPER_PROMPT])
                || a.windows(2).any(|w| w[0] == "--append-system-prompt-file" && std::fs::read_to_string(&w[1]).unwrap() == HELPER_PROMPT)
        );
        assert!(!a.iter().any(|s| s == APPEND_PROMPT || s == "--resume" || s == "--model" || s == "--effort"));
        assert!(a.windows(2).any(|w| w == ["--permission-mode", "auto"]));
        assert!(a.windows(2).any(|w| w == ["--add-dir", "/home/me/docs"]));

        // The model and effort picked in Settings → Voice, checked like the chat's.
        let a = args_with(HELPER_PROMPT, "claude-sonnet-5-5", "max", "default", None, "/inbox", &[]);
        assert!(a.windows(2).any(|w| w == ["--model", "claude-sonnet-5-5"]));
        assert!(a.windows(2).any(|w| w == ["--effort", "max"]));
        let a = args_with(HELPER_PROMPT, "opus & calc", "lots", "default", None, "/inbox", &[]);
        assert!(!a.iter().any(|s| s == "--model" || s == "--effort"));
    }

    #[test]
    fn gemini_lives_screen_work_goes_on_the_command_line_as_haiku_at_medium() {
        assert_eq!(safe_model(crate::live::COMPUTER_MODEL), Some("claude-haiku-5-5"));
        assert_eq!(safe_effort(crate::live::COMPUTER_EFFORT), Some("medium"));
    }

    #[test]
    fn the_users_tools_come_as_a_server_of_their_own_that_lumo_guards_itself() {
        let config = mcp_config(false, true, false, "");
        let server = &config["mcpServers"][TOOLS_SERVER];
        assert_eq!(server["args"], json!(["--mcp", "--tools=user"]));
        assert!(config["mcpServers"].get("lumo").is_none());
        let both = mcp_config(true, true, false, "");
        assert!(both["mcpServers"].get("lumo").is_some() && both["mcpServers"].get(TOOLS_SERVER).is_some());
        let a = with_mcp(vec!["-p".into()], false, true, false, "");
        if a.iter().any(|s| s == "--mcp-config") {
            // Claude Code lets the calls through: Lumo's own card asks for each (tools.rs approve).
            assert_eq!(a[a.len() - 2], "--allowedTools");
            assert_eq!(a[a.len() - 1], TOOLS_SERVER_ALLOWED);
            let b = with_mcp(vec!["-p".into()], true, true, false, "");
            assert_eq!(b[b.len() - 1], format!("{COMPUTER_LOOKING} {TOOLS_SERVER_ALLOWED}"));
        }
        assert_eq!(with_mcp(vec!["-p".into()], false, false, false, ""), ["-p"]);
        let workshop = format!("{APPEND_PROMPT}{}{WORKSHOP_TRY}", crate::chat::workshop_note!());
        assert!(!workshop.contains(['%', '"', '&', '|', '<', '>', '^', '`']), "plain words on the command line");
        assert!(workshop.contains("lumo-tool") && workshop.contains("lumo-file"));
    }

    #[test]
    fn the_workshops_long_instructions_go_in_a_file_of_their_own() {
        let workshop = format!("{APPEND_PROMPT}{}{WORKSHOP_TRY}", crate::chat::workshop_note!());
        let a = instructions(&workshop);
        if a[0] == "--append-system-prompt-file" {
            assert_eq!(std::fs::read_to_string(&a[1]).unwrap(), workshop);
            // The chat's own text is another file: a chat and the workshop can run together.
            let b = instructions(APPEND_PROMPT);
            assert_ne!(a[1], b[1]);
            assert_eq!(std::fs::read_to_string(&b[1]).unwrap(), APPEND_PROMPT);
            assert_eq!(instructions(&workshop), a, "the same text, the same file");
        } else {
            assert_eq!(a, ["--append-system-prompt", workshop.as_str()]);
        }
    }

    #[test]
    fn a_chats_claude_code_is_kept_for_the_same_settings_whatever_session_it_resumes() {
        let exe = std::path::Path::new("C:/claude.cmd");
        let a = args("opus", "high", "default", None, "/inbox", &[]);
        let b = args("opus", "high", "default", Some(SID), "/inbox", &[]);
        assert_eq!(live_key(exe, &a), live_key(exe, &b));
        assert_ne!(live_key(exe, &a), live_key(exe, &args("sonnet", "high", "default", None, "/inbox", &[])));
        assert_ne!(live_key(exe, &a), live_key(exe, &args("opus", "high", "plan", None, "/inbox", &[])));
        let l = live_args(a);
        assert_eq!(&l[l.len() - 2..], ["--input-format", "stream-json"]);
        let v: Value = serde_json::from_str(user_line("hi \"you\"\nthere").trim_end()).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["content"][0]["text"], "hi \"you\"\nthere");
        assert!(user_line("a\nb").ends_with('\n') && user_line("a\nb").matches('\n').count() == 1, "one line");
        let v: Value = serde_json::from_str(interrupt_line(3).trim_end()).unwrap();
        assert_eq!(v["request"]["subtype"], "interrupt");
        assert_eq!(v["type"], "control_request");
    }

    #[test]
    fn a_turn_ends_with_its_result_and_stop_interrupts_it_without_ending_the_process() {
        let feed = |lines: &[&str]| {
            let (tx, rx) = mpsc::channel::<Vec<u8>>();
            for l in lines {
                tx.send(l.as_bytes().to_vec()).unwrap();
            }
            (tx, rx)
        };
        let text = r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}}"#;
        let result = r#"{"type":"result","subtype":"success","result":"Hello","session_id":"0b5a8f2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b"}"#;
        let next = r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Next turn"}}}"#;
        let (_tx, rx) = feed(&[text, result, next]);
        let mut shown = String::new();
        let (state, ended) = read_turn(&rx, &Stop::default(), || unreachable!(), |t| shown = t.to_string(), |_| {}, |_| {}, |_, _| {});
        assert_eq!(ended, Ended::Result);
        assert_eq!(state.result, Some(Ok("Hello".to_string())));
        assert_eq!(state.session.as_deref(), Some(SID));
        // The next turn's lines stay for the next turn.
        assert!(rx.try_recv().unwrap().ends_with(b"}"));

        // Stop: interrupted, and the turn ends with the result the CLI gives then.
        let stop = Stop::default();
        stop.stop();
        let interrupted = r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":""}"#;
        let (_tx, rx) = feed(&[text, interrupted]);
        let mut asked = 0;
        let (state, ended) = read_turn(&rx, &stop, || { asked += 1; true }, |_| {}, |_| {}, |_| {}, |_, _| {});
        assert_eq!((ended, asked), (Ended::Result, 1));
        assert!(state.stopped);
        // A CLI that can't be interrupted (one prompt, no stdin) is ended.
        let (_tx, rx) = feed(&[text]);
        let (state, ended) = read_turn(&rx, &stop, || false, |_| {}, |_| {}, |_| {}, |_, _| {});
        assert_eq!(ended, Ended::Stopped);
        assert!(state.stopped);
        // The CLI ended before its result.
        let (tx, rx) = feed(&[text]);
        drop(tx);
        assert_eq!(read_turn(&rx, &Stop::default(), || false, |_| {}, |_| {}, |_| {}, |_, _| {}).1, Ended::Closed);
    }

    #[test]
    fn the_chat_always_gets_the_island_tools_and_may_run_them() {
        let config = mcp_config(false, false, true, "");
        assert_eq!(config["mcpServers"]["lumo"]["args"], json!(["--mcp", "--tools=island"]));
        assert_eq!(mcp_config(true, false, true, "")["mcpServers"]["lumo"]["args"], json!(["--mcp", "--tools=computer,island"]));
        let a = with_mcp(vec!["-p".into()], false, true, true, "");
        if a.iter().any(|s| s == "--mcp-config") {
            assert_eq!(a[a.len() - 1], format!("{ISLAND_ALLOWED} {TOOLS_SERVER_ALLOWED}"));
        }
        for tool in crate::island_tools::NAMES {
            assert!(ISLAND_ALLOWED.split(' ').any(|t| t == format!("mcp__lumo__{tool}")), "{tool}");
        }
        assert!(APPEND_PROMPT.contains("set_timer") && APPEND_PROMPT.contains("Lumo's listen tool") && APPEND_PROMPT.contains("[[listen"));
        assert!(COMPUTER_PROMPT.contains("set_timer"));
    }

    #[test]
    fn the_email_tools_come_as_security_lets_them() {
        let read = mcp_config(false, false, true, "mail");
        assert_eq!(read["mcpServers"]["lumo"]["args"], json!(["--mcp", "--tools=mail,island"]));
        let send = mcp_config(true, false, true, "mail,mailsend");
        assert_eq!(send["mcpServers"]["lumo"]["args"], json!(["--mcp", "--tools=computer,mail,mailsend,island"]));
        let a = with_mcp(vec!["-p".into()], false, false, true, "mail,mailsend");
        if let Some(i) = a.iter().position(|s| s == "--mcp-config") {
            assert!(a[i + 1].ends_with("chat-island-mail-mailsend.json"));
            assert_eq!(a[a.len() - 1], format!("{ISLAND_ALLOWED} {MAIL_ALLOWED} {MAIL_SEND_ALLOWED}"));
        }
        let a = with_mcp(vec!["-p".into()], false, false, true, "mail");
        if a.iter().any(|s| s == "--mcp-config") {
            assert!(!a[a.len() - 1].contains("mail_send"), "reading only");
        }
    }

    #[test]
    fn computer_use_adds_lumos_mcp_server_and_lets_its_looking_tools_run() {
        let config = computer_config();
        let server = &config["mcpServers"]["lumo"];
        assert!(server["command"].as_str().unwrap().contains("lumo-hook"));
        assert_eq!(server["type"], "stdio");
        assert_eq!(server["args"], json!(["--mcp"]));
        assert_eq!(server["env"]["LUMO_ISLAND_RUN"], "1", "the island's own run");
        let a = with_computer(vec!["-p".into()]);
        if let Some(i) = a.iter().position(|s| s == "--mcp-config") {
            assert!(a[i + 1].ends_with("chat-computer.json"));
            assert_eq!(a[a.len() - 2], "--allowedTools", "last: its list takes what follows");
            assert_eq!(a[a.len() - 1], COMPUTER_LOOKING);
            for tool in ["screenshot", "zoom", "cursor_position", "wait"] {
                assert!(COMPUTER_LOOKING.split(' ').any(|t| t == format!("mcp__lumo__{tool}")), "{tool}");
            }
            assert!(!COMPUTER_LOOKING.contains("click") && !COMPUTER_LOOKING.contains("type") && !COMPUTER_LOOKING.contains("key"));
        }
        // An argument on cmd.exe's line: plain words only, and it says how to stop.
        assert!(!COMPUTER_PROMPT.contains(['%', '"', '&', '|', '<', '>', '^', '`']));
        assert!(COMPUTER_PROMPT.contains("Esc") && COMPUTER_PROMPT.contains("Never type passwords"));
        assert!(!COMPUTER_PROMPT.contains("Never take a screenshot"), "the chat's usual rule doesn't hold here");
        assert!(!HELPER_COMPUTER_PROMPT.contains(['%', '"', '&', '|', '<', '>', '^', '`', '(', ')']));
        assert!(HELPER_COMPUTER_PROMPT.contains("helping Gemini") && HELPER_COMPUTER_PROMPT.contains("lumo MCP server"));
    }

    #[test]
    fn the_prompt_never_goes_on_the_command_line_and_odd_values_are_dropped() {
        let a = args("opus", "high", "default", Some(SID), "C:\\Users\\me\\AppData\\Local\\com.rccrd12.lumo\\inbox", &[]);
        assert!(a.windows(2).any(|w| w == ["--effort", "high"]));
        assert!(a.windows(2).any(|w| w == ["--model", "opus"]));
        assert!(a.windows(2).any(|w| w == ["--resume", SID]));
        assert!(a.windows(2).any(|w| w == ["--permission-mode", "default"]));
        assert_eq!(a[0], "-p");

        let a = args("opus & del *", "high & calc", "default", Some("x\" & calc"), "/inbox", &["C:\\A & calc".into(), "%TEMP%".into()]);
        assert!(!a.contains(&"--effort".to_string()));
        assert!(!a.iter().any(|s| s.contains('&')), "{a:?}");
        assert!(!a.contains(&"--model".to_string()));
        assert_eq!(a.iter().filter(|s| *s == "--add-dir").count(), 1, "only the inbox: {a:?}");
        assert!(!a.contains(&"--resume".to_string()));
        assert!(!APPEND_PROMPT.contains(['%', '"', '&', '|', '<', '>', '^', '`']));
        assert!(!HELPER_PROMPT.contains(['%', '"', '&', '|', '<', '>', '^', '`', '(', ')']));
        assert!(APPEND_PROMPT.contains("press the screen button"), "Claude asks, never captures");
        assert!(APPEND_PROMPT.contains("Always share the folder open in File Explorer"), "names the Settings switch");
    }

    #[test]
    fn the_plan_limits_are_read_off_the_stream_when_it_gives_them() {
        let mut run = Run::default();
        run.feed(br#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","rateLimitType":"five_hour","utilization":0.42,"resetsAt":1791560000}}"#);
        run.feed(br#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"seven_day","utilization":0.1,"resetsAt":1791900000000}}"#);
        // A limit the gauge has no place for: nothing.
        run.feed(br#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"overage","utilization":0.5,"resetsAt":1}}"#);
        assert_eq!(run.rate_limits.len(), 2);
        assert_eq!(run.rate_limits["five_hour"], json!({ "used_percentage": 42.0, "resets_at": 1791560000.0 }));
        assert_eq!(run.rate_limits["seven_day"]["resets_at"], json!(1791900000.0));
        // No utilization while all is well: low, with its reset time.
        run.feed(br#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour","resetsAt":1791570000}}"#);
        assert_eq!(run.rate_limits["five_hour"], json!({ "low": true, "resets_at": 1791570000.0 }));
    }

    #[test]
    fn the_chat_asks_with_lumos_own_permission_hook_and_guards_shell_commands() {
        let permission = crate::hooks::permission_request_entry();
        let v = chat_settings(permission.clone(), "'/x/lumo-hook' --chat-guard PreToolUse");
        // The very entry installing writes, so Claude Code runs it once when both are there.
        assert_eq!(v["hooks"]["PermissionRequest"][0], permission);
        let hook = &permission["hooks"][0];
        assert_eq!(hook["timeout"], 120, "longer than the relay waits for a click");
        assert!(hook.get("async").is_none(), "it waits for the click");
        assert!(hook["command"].as_str().unwrap().ends_with("PermissionRequest"));
        let guard = &v["hooks"]["PreToolUse"][0];
        assert_eq!(guard["matcher"], "Bash|PowerShell");
        assert!(guard["hooks"][0]["command"].as_str().unwrap().contains("--chat-guard"));
    }

    #[test]
    fn the_permission_mode_is_the_one_picked_and_never_lets_everything_through() {
        let mode = |m: &str| {
            let a = args("default", "", m, None, "/inbox", &[]);
            let i = a.iter().position(|s| s == "--permission-mode").unwrap();
            a[i + 1].clone()
        };
        assert_eq!(mode("auto"), "auto");
        assert_eq!(mode("acceptEdits"), "auto", "picked before Auto replaced it");
        assert_eq!(mode("plan"), "plan");
        assert_eq!(mode("default"), "default");
        for wholesale in ["bypassPermissions", "dontAsk", "turbo", "", "plan & calc"] {
            assert_eq!(mode(wholesale), "default", "{wholesale}");
        }
    }

    #[test]
    fn a_listen_line_written_before_a_tool_call_reaches_the_island() {
        // Claude writes the line, checks the CI with a command, then answers:
        // the result is only the last message, the line must not be lost.
        let mut run = Run::default();
        let lines = [
            r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"message_start"}}"#,
            r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Ok.\n[[listen Rccrd12/Lumo#22 checks]]\n"}}}"#,
            r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"message_start"}}"#,
            r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"The checks are still running."}}}"#,
            r#"{"type":"result","subtype":"success","is_error":false,"result":"The checks are still running."}"#,
        ];
        for l in &lines {
            run.feed(l.as_bytes());
        }
        let answer = match run.result.clone() {
            Some(Ok(text)) => chat::keep_lumo_lines(text, &run.said),
            other => panic!("{other:?}"),
        };
        assert_eq!(answer, "The checks are still running.\n[[listen Rccrd12/Lumo#22 checks]]\n");
        // Written in the last message already: not twice.
        assert_eq!(chat::keep_lumo_lines("Ok.\n[[listen o/r#1 merged]]".into(), "Ok.\n[[listen o/r#1 merged]]"), "Ok.\n[[listen o/r#1 merged]]");
    }

    #[test]
    fn the_stream_gives_the_text_the_session_and_the_answer() {
        let mut run = Run::default();
        let lines = [
            format!(r#"{{"type":"system","subtype":"init","session_id":"{SID}"}}"#),
            r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"message_start"}}"#.into(),
            r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Let me read "}}}"#.into(),
            r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"it."}}}"#.into(),
            r#"{"type":"stream_event","parent_tool_use_id":"toolu_1","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"subagent"}}}"#.into(),
            r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"message_start"}}"#.into(),
            r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"The PDF says hi."}}}"#.into(),
            "not json".into(),
            r#"{"type":"system","subtype":"permission_denied"}"#.into(),
            format!(r#"{{"type":"result","subtype":"success","is_error":false,"result":"The PDF says hi.","session_id":"{SID}"}}"#),
        ];
        for l in &lines {
            run.feed(l.as_bytes());
        }
        assert_eq!(run.session.as_deref(), Some(SID));
        assert_eq!(run.visible, "The PDF says hi.");
        assert_eq!(run.result, Some(Ok("The PDF says hi.".into())));
        assert_eq!(run.denied, 1);

        let mut run = Run::default();
        run.feed(br#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}"#);
        assert_eq!(run.result, Some(Err("error_max_turns".into())));
    }

    #[test]
    fn each_tool_says_what_it_does_with_names_never_paths() {
        let a = |name: &str, input: Value| activity_for(name, &input);
        assert_eq!(a("Read", json!({"file_path": "C:\\Users\\me\\Docs\\report.pdf"})), Activity::new("read", "report.pdf"));
        assert_eq!(a("Read", json!({"file_path": "/home/me/notes.md"})), Activity::new("read", "notes.md"));
        assert_eq!(a("Read", json!({})), Activity::new("read", ""), "before the input is known");
        assert_eq!(
            a("Read", json!({"file_path": "C:\\Users\\me\\AppData\\Local\\com.rccrd12.lumo\\inbox\\screenshot-2026-10-09-101500-screen1.png"})),
            Activity::new("screen", ""),
            "Lumo's own screenshots are the screen"
        );
        assert_eq!(a("Grep", json!({"pattern": "fn main", "path": "/src"})), Activity::new("search", "fn main"));
        assert_eq!(a("Glob", json!({"pattern": "**/*.pdf"})), Activity::new("search", "**/*.pdf"));
        assert_eq!(a("LS", json!({"path": "/home/me"})), Activity::new("search", ""));
        assert_eq!(a("Bash", json!({"command": "rm -rf /tmp/x"})), Activity::new("command", ""), "the command itself stays out");
        assert_eq!(a("PowerShell", json!({"command": "Get-ChildItem"})), Activity::new("command", ""));
        // What it is for, when Claude Code says: a long one is not a mystery.
        assert_eq!(a("Bash", json!({"command": "gh pr checks 22 --watch", "description": "Watch the PR's checks"})), Activity::new("command", "Watch the PR's checks"));
        for tool in ["Edit", "Write", "MultiEdit"] {
            assert_eq!(a(tool, json!({"file_path": "/work/src/main.rs"})), Activity::new("edit", "main.rs"));
        }
        assert_eq!(a("NotebookEdit", json!({"notebook_path": "D:\\nb\\plot.ipynb"})), Activity::new("edit", "plot.ipynb"));
        assert_eq!(a("WebSearch", json!({"query": "weather"})), Activity::new("web", ""));
        assert_eq!(a("WebFetch", json!({"url": "https://user:pw@www.example.com:8080/a?b"})), Activity::new("read", "example.com"));
        assert_eq!(a("WebFetch", json!({})), Activity::new("web", ""));
        assert_eq!(a("Task", json!({"description": "x"})), Activity::new("subtask", ""));
        assert_eq!(a("Agent", json!({})), Activity::new("subtask", ""));
        assert_eq!(a("TodoWrite", json!({"todos": []})), Activity::new("plan", ""));
        assert_eq!(a("mcp__github__create_issue", json!({})), Activity::new("tool", "create issue (github)"));
        assert_eq!(a("mcp__claude-in-chrome__take_screenshot", json!({})), Activity::new("screen", ""));
        assert_eq!(a("mcp__lumo__screenshot", json!({})), Activity::new("screen", ""));
        assert_eq!(a("mcp__lumo__zoom", json!({})), Activity::new("screen", ""));
        assert_eq!(a("mcp__lumo__left_click", json!({ "coordinate": [1, 2] })), Activity::new("computer", ""));
        assert_eq!(a("ToolSearch", json!({})), Activity::new("tool", "Tool Search"));
        assert_eq!(a("", json!({})), Activity::thinking());

        let long = a("Grep", json!({"pattern": "a".repeat(200)}));
        assert_eq!(long.detail.chars().count(), MAX_DETAIL);
        assert!(long.detail.ends_with('…'));
        assert_eq!(a("Grep", json!({"pattern": "two\nlines"})).detail, "two lines");
        assert_eq!(serde_json::to_value(Activity::new("read", "a.pdf")).unwrap(), json!({"kind": "read", "detail": "a.pdf"}));
    }

    /// Feeds lines; the activities told along the way, as take_activity gives them.
    fn activities(run: &mut Run, lines: &[&str]) -> Vec<Activity> {
        let mut out = Vec::new();
        for l in lines {
            run.feed(l.as_bytes());
            out.extend(run.take_activity());
        }
        out
    }

    #[test]
    fn the_plan_claude_writes_in_the_chat_is_passed_on_once() {
        let mut run = Run::default();
        run.feed(br#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"Ok."},{"type":"tool_use","id":"t1","name":"TodoWrite","input":{"todos":[{"content":"Create the folder","status":"in_progress"}]}},{"type":"tool_use","id":"t2","name":"Write","input":{}}]}}"#);
        // A subagent's plan stays out.
        run.feed(br#"{"type":"assistant","parent_tool_use_id":"t9","message":{"content":[{"type":"tool_use","id":"t3","name":"TodoWrite","input":{"todos":[]}}]}}"#);
        let plans = run.take_plans();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].0, "TodoWrite");
        assert_eq!(plans[0].1["todos"][0]["content"], "Create the folder");
        assert!(run.take_plans().is_empty());
        assert!(APPEND_PROMPT.contains("TaskCreate") && COMPUTER_PROMPT.contains("TaskCreate"));
    }

    #[test]
    fn a_task_created_is_passed_on_with_the_id_its_result_gives() {
        let mut run = Run::default();
        run.feed(br#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"c1","name":"TaskCreate","input":{"subject":"Write game.py"}},{"type":"tool_use","id":"c2","name":"TaskCreate","input":{"subject":"Write main.py"}}]}}"#);
        assert!(run.take_plans().is_empty(), "not before its id is known");
        run.feed(br#"{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"c1","content":"Task #4 created successfully: Write game.py"}]},"tool_use_result":{"task":{"id":"4","subject":"Write game.py"}}}"#);
        run.feed(br#"{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"c2","content":"Task #5 created successfully: Write main.py"}]}}"#);
        let plans = run.take_plans();
        assert_eq!(plans.len(), 2);
        assert_eq!(plans[0].1["taskId"], "4");
        assert_eq!(plans[1].1["taskId"], "5");
        assert_eq!(plans[1].1["subject"], "Write main.py");
        // One that failed is no step.
        run.feed(br#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"c3","name":"TaskCreate","input":{"subject":"x"}}]}}"#);
        run.feed(br#"{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"c3","is_error":true,"content":"bad"}]}}"#);
        assert!(run.take_plans().is_empty());
    }

    #[test]
    fn the_stream_says_what_claude_code_is_doing_until_the_text_shows() {
        let mut run = Run::default();
        let seen = activities(
            &mut run,
            &[
                r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"message_start"}}"#,
                r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}"#,
                r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_stop","index":0}}"#,
                r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}}"#,
                r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\":\"C:\\\\Users"}}}"#,
                r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\\\me\\\\report.pdf\"}"}}}"#,
                r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_stop","index":1}}"#,
                // The whole message says the same: nothing new.
                r#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"C:\\Users\\me\\report.pdf"}}]}}"#,
                // A subagent's doings stay out.
                r#"{"type":"stream_event","parent_tool_use_id":"toolu_9","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_8","name":"Bash","input":{}}}}"#,
                r#"{"type":"assistant","parent_tool_use_id":"toolu_9","message":{"content":[{"type":"tool_use","id":"toolu_8","name":"Bash","input":{}}]}}"#,
                r#"{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"..."}]}}"#,
            ],
        );
        assert_eq!(
            seen,
            vec![Activity::thinking(), Activity::new("read", ""), Activity::new("read", "report.pdf"), Activity::thinking()],
        );

        // Text: the activity goes, and a tool after it is news again (Claude Code
        // alternates text and tools), even the same one.
        let seen = activities(
            &mut run,
            &[
                r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"message_start"}}"#,
                r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check."}}}"#,
                r#"{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_start","index":1,"content_block":{"type":"thinking"}}}"#,
                // Two calls at once: thinking again only once both are answered.
                r#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"Let me check."},{"type":"tool_use","id":"toolu_2","name":"Bash","input":{"command":"ls"}},{"type":"tool_use","id":"toolu_3","name":"WebSearch","input":{"query":"x"}}]}}"#,
                r#"{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_3","content":"..."}]}}"#,
                r#"{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_2","content":"..."}]}}"#,
                r#"{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"toolu_unknown","content":"..."}]}}"#,
            ],
        );
        assert_eq!(run.visible, "Let me check.");
        assert_eq!(
            seen,
            // One line, two calls: the island is told the last one.
            vec![Activity::thinking(), Activity::new("web", ""), Activity::new("command", ""), Activity::thinking()],
        );
        assert!(run.pending.is_empty());
    }

    #[test]
    fn the_file_rides_along_and_other_providers_turns_are_carried_once() {
        let file = ChatContext::File { name: "a.pdf".into(), path: "C:\\inbox\\a.pdf".into() };
        let files = vec![("a.pdf".to_string(), "C:\\inbox\\a.pdf".to_string())];
        let p = prompt(Some(&file), &[], &files, "summary?");
        assert!(p.contains("Path: C:\\inbox\\a.pdf"));
        assert!(p.ends_with("summary?"));
        assert!(!p.contains("earlier"), "a session that saw the turns is not told again");
        assert_eq!(prompt(None, &[], &files, "more"), "more");

        let carried = vec![json!({"role":"user","content":"File: a.pdf\n\nhi"}), json!({"role":"assistant","content":"hello"})];
        let p = prompt(None, &carried, &[], "go on");
        assert!(p.contains("user: File: a.pdf\n\nhi") && p.contains("assistant: hello") && p.ends_with("go on"));
        assert!(!p.contains("Files the user added"));

        // A fresh session after an edit: the files of the kept turns, with their paths.
        let p = prompt(None, &carried, &files, "go on");
        assert!(p.contains("Files the user added earlier in this conversation:\n- a.pdf: C:\\inbox\\a.pdf\n"), "{p}");
        // Unless it goes with this question anyway.
        let p = prompt(Some(&file), &carried, &files, "go on");
        assert_eq!(p.matches("C:\\inbox\\a.pdf").count(), 1, "{p}");
    }

    #[test]
    fn a_shared_folder_is_added_only_when_cmd_exe_would_read_it_as_a_path() {
        let a = args("default", "", "default", None, "/inbox", &["C:\\Users\\me\\My PDFs".into(), "\\\\nas\\docs".into()]);
        assert!(a.windows(2).any(|w| w == ["--add-dir", "C:\\Users\\me\\My PDFs"]));
        assert!(a.windows(2).any(|w| w == ["--add-dir", "\\\\nas\\docs"]));
        assert_eq!(safe_dir("C:\\Tom & Jerry"), None);
        assert_eq!(safe_dir("C:\\100%"), None);
        assert_eq!(safe_dir("relative\\dir"), None);
        assert_eq!(safe_dir("C:\\a\nb"), None);
        assert_eq!(safe_dir(""), None);
        assert_eq!(safe_dir("/home/me/pdfs"), Some("/home/me/pdfs"));
    }

    #[test]
    fn only_uuids_are_resumed() {
        assert_eq!(safe_session(SID), Some(SID));
        assert_eq!(safe_session("../../etc"), None);
        assert_eq!(safe_model("claude-opus-5-5[1m]"), Some("claude-opus-5-5[1m]"));
        assert_eq!(safe_model(""), None);
        assert_eq!(safe_model("default"), None, "no --model: Claude Code's own choice");
    }

    #[test]
    fn the_commands_come_with_init_and_a_compaction_is_noticed() {
        let mut run = Run::default();
        let lines = [
            format!(r#"{{"type":"system","subtype":"init","session_id":"{SID}","slash_commands":["compact","/context","compact","review","../etc","a b",""]}}"#),
            r#"{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"manual"}}"#.into(),
            r#"{"type":"result","subtype":"success","is_error":false,"result":""}"#.into(),
        ];
        for l in &lines {
            run.feed(l.as_bytes());
        }
        assert_eq!(run.commands.as_deref(), Some(&["compact".to_string(), "context".into(), "review".into()][..]));
        assert!(run.compacted);
        assert_eq!(run.result, Some(Ok(String::new())));
    }

    #[test]
    fn only_a_slash_and_a_name_make_a_command() {
        assert_eq!(command_of("/compact"), Some("compact"));
        assert_eq!(command_of("  /review 12 please "), Some("review"));
        assert_eq!(command_of("/my-plugin:do.it"), Some("my-plugin:do.it"));
        assert_eq!(command_of("what does /compact do?"), None);
        assert_eq!(command_of("/"), None);
        assert_eq!(command_of("/usr/bin/env"), None, "a path is a question");
        assert_eq!(command_of("/../x"), None);
    }

    #[test]
    fn the_files_a_turn_read_or_wrote_are_told_once_they_ran() {
        let mut run = Run::default();
        run.feed(br#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"r1","name":"Read","input":{"file_path":"C:\\Users\\me\\Docs\\report.pdf"}},{"type":"tool_use","id":"w1","name":"Write","input":{"file_path":"C:\\lumo-nowhere\\game.py","content":"x"}},{"type":"tool_use","id":"e1","name":"Edit","input":{"file_path":"C:\\Users\\me\\notes.md"}},{"type":"tool_use","id":"g1","name":"Grep","input":{"pattern":"x"}}]}}"#);
        assert!(run.take_files().is_empty(), "not before they ran");
        run.feed(br#"{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"r1","content":"..."}]},"tool_use_result":{"type":"text"}}"#);
        run.feed(br#"{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"w1","content":"ok"}]}}"#);
        run.feed(br#"{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"e1","is_error":true,"content":"String not found"}]}}"#);
        run.feed(br#"{"type":"user","parent_tool_use_id":null,"message":{"content":[{"type":"tool_result","tool_use_id":"g1","content":"none"}]}}"#);
        assert_eq!(
            run.take_files(),
            vec![
                FileTouch { kind: "read", path: r"C:\Users\me\Docs\report.pdf".into() },
                FileTouch { kind: "created", path: r"C:\lumo-nowhere\game.py".into() },
            ],
            "a failed edit changed nothing, a search is no file"
        );
        assert!(run.take_files().is_empty(), "once");

        // Claude Code's own word on Write wins; a screenshot and a relative path stay out; a subagent's file counts.
        let mut run = Run::default();
        run.feed(br#"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"w2","name":"Write","input":{"file_path":"C:\\lumo-nowhere\\a.txt"}},{"type":"tool_use","id":"s1","name":"Read","input":{"file_path":"C:\\inbox\\screenshot-1-screen1.png"}},{"type":"tool_use","id":"x1","name":"Read","input":{"file_path":"notes.md"}}]}}"#);
        run.feed(br#"{"type":"assistant","parent_tool_use_id":"t9","message":{"content":[{"type":"tool_use","id":"sub","name":"Read","input":{"file_path":"C:\\sub.txt"}}]}}"#);
        for id in ["w2", "s1", "x1", "sub"] {
            let line = format!(r#"{{"type":"user","parent_tool_use_id":null,"message":{{"content":[{{"type":"tool_result","tool_use_id":"{id}","content":"ok"}}]}},"tool_use_result":{{"type":"update"}}}}"#);
            run.feed(line.as_bytes());
        }
        assert_eq!(
            run.take_files(),
            vec![FileTouch { kind: "edited", path: r"C:\lumo-nowhere\a.txt".into() }, FileTouch { kind: "read", path: r"C:\sub.txt".into() }]
        );
        assert!(is_full_path(r"\\server\share\a.txt") && is_full_path("/home/me/a") && is_full_path("D:/x"));
        assert!(!is_full_path("a.txt") && !is_full_path(r"..\a.txt") && !is_full_path("C:"));
    }
}
