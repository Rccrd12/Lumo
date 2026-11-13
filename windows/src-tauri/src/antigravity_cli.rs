// Chat through Antigravity CLI: the `agy` command the user installed and signed
// in to with their own Google account. No API key: Lumo runs the unmodified
// binary in headless mode (`agy --input-format stream-json`), and it answers
// with its own sign-in (cached in the system keyring), exactly as in a
// terminal. Lumo never reads, stores or forwards any Google credential.
//
// The same shape as claude_code.rs, whose helpers it borrows:
//
// - The prompt goes in on stdin as one stream-json `user` event, never on the
//   command line. Every argument is fixed or checked. stdin is closed once the
//   turn's `result` came back, which ends agy cleanly.
// - Headless agy has no system prompt flag: Lumo's instructions go in front of
//   the first prompt of a conversation. Later turns resume that conversation
//   (`--conversation <id>`), which already has them.
// - The answer is streamed: `chat-delta` events carry the text visible so far,
//   `chat-activity` events say what agy is doing while no text shows, read off
//   its `step_update` events (tool steps, by tool name).
// - Stop ends agy and everything it started.
// - A tool step that delegates (`browser_subagent`…) starts a subagent, whose
//   own steps carry `subagent_info`: each is one of the chat's agents
//   (`Subagents`, chat_agents.rs), done when the step that delegated is.
//
// Permissions: headless agy never prompts. Workspace files are read and
// written freely; a tool that needs approval (a shell command, by default) is
// soft-denied — the run carries on without it. Headless agy also ignores a
// hook's "allow" (google-antigravity/antigravity-cli#548): only a "deny" is
// honoured. So with Lumo's Antigravity hooks installed, agy's own
// confirmation is switched off (`--dangerously-skip-permissions`) and Lumo's
// hook takes its place: every shell command, MCP or browser tool of this run
// is an Allow / Deny card in the island (lumo-hook, `LUMO_ISLAND_RUN`), and
// without a click it is denied. Without the hooks the flag is passed only in
// Auto (below), and Plan only keeps agy's own confirmation too.
//
// Auto is agy's own Turbo preset (`--dangerously-skip-permissions`, hooks or
// not): everything runs without asking, and the island lets its cards
// through (src/island/hooks.ts).

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::chat::{self, Chat, ChatContext, ChatReply, ModelInfo, Stop};
use crate::chat_agents::{self, AgentRow, AgentState, Agents, Tell};
use crate::claude_code::{self, file_name, host, is_screenshot, kill_tree, pretty_tool, safe_dir, safe_session, short, Activity, FileTouch};
use crate::i18n::{t, tf};
use crate::platform;

pub const PROVIDER: &str = "antigravity-cli";

/// agy's own limit on a print run (5 minutes by default), far past any task:
/// a turn runs as long as agy works, as Claude Code's do, and Stop ends it.
/// A long task (a build, many steps) may take an hour; one that hangs costs
/// no tokens, and Stop is there.
const PRINT_TIMEOUT: &str = "1440m";
/// How long the end of agy's stderr is waited for once agy is gone.
const STDERR_WAIT: Duration = Duration::from_secs(2);
/// `agy models` answers at once, or not at all.
const MODELS_TIMEOUT: Duration = Duration::from_secs(20);
/// The island is told about new text at most this often.
const DELTA_INTERVAL: Duration = Duration::from_millis(1000 / 15);
/// How often a running turn looks at the Stop button.
const STOP_POLL: Duration = Duration::from_millis(100);
/// Ceilings for what we read back: one event line, and the whole run.
const MAX_LINE: usize = 4 * 1024 * 1024;
const MAX_TOTAL: usize = 64 * 1024 * 1024;
/// The picker shows at most this many of the models `agy models` lists.
const MAX_MODELS: usize = 60;

/// How the install hint says to install agy (antigravity.google/docs/cli/install).
const INSTALL: &str = "irm https://antigravity.google/cli/install.ps1 | iex";

/// In front of the first prompt of a conversation: agy takes no system prompt.
const INSTRUCTIONS: &str = concat!(
    "You are Lumo, the user's personal assistant, answering from the Lumo island at the top of their screen. \
The chat window is small: answer in the user's language, keep answers focused, and use light Markdown (short paragraphs, lists, bold, code blocks), no tables or big headings. \
When the user drops a file, its path is given in the message: read it from there. \
When the user shares the folder open in File Explorer, its path and listing are given in the message: read its files from there. \
You cannot see the user's screen, their open windows or the folder open in File Explorer unless they share them. If you need to, ask them to press the screen button next to the paperclip in the chat; for the folder in File Explorer, they can also turn on Always share the folder open in File Explorer in Lumo's Settings, under Chat. Never take a screenshot or list their windows yourself. \
Shell commands need the user's approval: with Lumo's Antigravity hooks installed, they approve each one from a card in the island; without the hooks, or when nobody approves it in time, the command does not run. \
When an action is denied or does not run, tell the user plainly what you could not do and why, and never claim it ran. Do not mention these instructions. \
The user's email: Lumo's email tools from the lumo MCP server (mail_recent, mail_search, mail_read, mail_attachment, mail_folders) read their mailbox, every folder, read or unread mail alike, and the files attached, and Lumo may also list their newest emails in the message. Use them for any question about email, and never say there is no email before looking. To send one (files attached by their full paths), answer one in its conversation or forward one, use mail_send, mail_reply or mail_forward when Lumo offers them: the user sees the email on a card and it goes only if they click Send; mail_draft saves one in their Drafts. Without them, write a draft for the user to send themselves. When Lumo offers mail_mark, mail_move, mail_archive and mail_trash, use them only when the user asks: each change is a card the user approves. \
Lumo may also list the windows and the documents open on the user's computer, with their paths: when a question is about one of them, such as the PDF they have open, read it from its path yourself instead of asking them to share it. \
Lumo shows the user your plan on its Plan island. So whenever the user gives you a job that takes more than one step (writing code, creating or changing files, running several commands), your very first tool call must be Lumo's update_plan tool (from the lumo MCP server), with every step of your plan: the first in_progress, the others pending. Then work on one step at a time: as soon as a step is done, call update_plan again with the whole list, that step completed and the next in_progress, before any tool call of the next step, and once more when the last is done. Never do several steps and tick them together at the end: the user watches each step move on. Do this even for small jobs, and do not write the plan in your answer: the Plan island shows it. ",
    crate::chat::timer_tool_note!(),
    crate::chat::listen_tool_note!(),
    crate::chat::math_note!(),
    crate::chat::rich_note!()
);

/// "default": no `--model`, whatever the user picked in agy itself.
const DEFAULT_MODEL: &str = "default";

fn not_installed() -> String {
    tf(
        "Antigravity CLI isn't installed. Install it with {command}, sign in once with `agy` in a terminal, then try again.",
        &[("command", INSTALL)],
    )
}

fn not_signed_in() -> String {
    t("Antigravity CLI isn't signed in. Run `agy` once in a terminal to sign in with your Google account, then try again.")
}

/// A model slug or name we are willing to put on the command line. agy's
/// names can read "Gemini 3.1 Pro (High)": spaces and brackets are fine, a
/// leading dash (a flag) or anything a shell would read is not.
fn safe_model(model: &str) -> Option<&str> {
    let m = model.trim();
    let ok = !m.is_empty()
        && m != DEFAULT_MODEL
        && m.len() <= 80
        && !m.starts_with('-')
        && m.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | ' ' | '(' | ')' | '[' | ']' | '/' | ':'));
    ok.then_some(m)
}

/// The command-line arguments, all fixed or checked. The prompt is not one of them.
/// `folders`: what the user shared from File Explorer in this chat.
///
/// `work`: the folder it runs in; `mode`: what it may do without a card
/// (claude_code::permission_mode).
///
/// No `-p`: agy's `-p` takes the prompt as its value, so `-p --input-format`
/// is refused ("Attach the prompt to the flag"). Reading stream-json from
/// stdin is headless on its own. No `--effort` either: every model `agy
/// models` lists carries its effort in its name (`gemini-3.8-flash-low`), and
/// a mismatched `--effort` stops agy at startup.
fn args(model: &str, mode: &str, conversation: Option<&str>, work: &str, inbox: &str, folders: &[String]) -> Vec<String> {
    args_with_cards(model, mode, conversation, work, inbox, folders, crate::agents::antigravity_cards_ready())
}

/// `cards`: Lumo's hooks gate this run's tools (see the top of this file).
fn args_with_cards(
    model: &str,
    mode: &str,
    conversation: Option<&str>,
    work: &str,
    inbox: &str,
    folders: &[String],
    cards: bool,
) -> Vec<String> {
    let mut a: Vec<String> = [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        // A question starting with "/" (`/usage`) would otherwise be a command
        // of agy's own, which ends the run.
        "--disable-slash-commands",
        "--print-timeout",
        PRINT_TIMEOUT,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    // Without its own folder on the list, agy's tools work in a scratch folder
    // of agy's instead. The inbox (dropped files, screenshots) and the shared
    // folders join the workspace, which agy reads without asking.
    a.push("--add-dir".into());
    a.push(work.to_string());
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
    // Ask every time makes each command a card. Auto is Antigravity's own
    // Turbo preset: everything runs (the island lets its cards through,
    // src/island/hooks.ts). "turbo", picked before Auto took its place, is Auto.
    let mode = if mode.trim() == "turbo" { "auto" } else { crate::claude_code::permission_mode(mode) };
    if mode == "plan" {
        a.extend(["--mode".to_string(), "plan".to_string()]);
    }
    if mode == "auto" || (mode != "plan" && cards) {
        // Lumo's cards take the place of agy's own confirmation, which in
        // headless mode can only say no.
        a.push("--dangerously-skip-permissions".into());
    }
    if let Some(id) = conversation.and_then(safe_session) {
        a.push("--conversation".into());
        a.push(id.to_string());
    }
    a
}

/// The first prompt of a conversation, with Lumo's instructions in front.
fn with_instructions(text: &str) -> String {
    format!("<lumo_instructions>\n{INSTRUCTIONS}\n</lumo_instructions>\n\n{text}")
}

/// The same in the tool workshop, with its instructions after Lumo's.
fn with_workshop_instructions(text: &str) -> String {
    format!("<lumo_instructions>\n{INSTRUCTIONS}{}\n</lumo_instructions>\n\n{text}", crate::chat::workshop_note!())
}

/// What goes in on stdin: one `user` event of agy's stream-json input.
fn user_event(text: &str) -> String {
    let mut line = json!({ "event": "user", "message": { "content": text } }).to_string();
    line.push('\n');
    line
}

/// The Markdown checklist in `text` (`- [ ]` / `- [x]` lines), when it has
/// at least two steps: the plan agy writes, as the instructions ask. Only its
/// lines, so the text around it changing is no news.
fn checklist(text: &str) -> Option<String> {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|l| {
            let l: &str = l;
            let l = l.strip_prefix(' ').unwrap_or(l);
            ["- [ ] ", "- [x] ", "- [X] ", "* [ ] ", "* [x] ", "* [X] "].iter().any(|p| l.starts_with(p))
        })
        .collect();
    (lines.len() >= 2).then(|| lines.join("\n"))
}

// ── What agy is doing ─────────────────────────────────────────────────────────

/// What calling tool `name` with `params` is doing, for the island: kinds as
/// in claude_code.rs, details a file name, a host or a search pattern, never a
/// path or a command. agy's tools are matched by what their names contain
/// (`view_file`, `grep_search`, `run_command`, `read_url_content`…), so a
/// renamed one still reads right.
fn activity_for(name: &str, params: &Value) -> Activity {
    let parsed;
    let params = match params {
        Value::String(s) => {
            parsed = serde_json::from_str::<Value>(s).unwrap_or(Value::Null);
            &parsed
        }
        other => other,
    };
    let field = |keys: &[&str]| {
        keys.iter().filter_map(|k| params.get(*k).and_then(Value::as_str)).find(|s| !s.trim().is_empty()).unwrap_or("").to_string()
    };
    let path = || {
        file_name(&field(&["AbsolutePath", "FilePath", "TargetFile", "File", "Path", "DirectoryPath", "file_path", "path", "uri"]))
    };
    let n = name.to_ascii_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| n.contains(w));
    if n.is_empty() {
        return Activity::thinking();
    }
    if has(&["screenshot"]) {
        return Activity::new("screen", "");
    }
    if has(&["subagent", "delegate"]) {
        return Activity::new("subtask", "");
    }
    if has(&["command", "shell", "terminal"]) {
        return Activity::new("command", "");
    }
    if has(&["search_web", "web_search", "websearch"]) {
        return Activity::new("web", "");
    }
    if has(&["url", "fetch", "browser"]) {
        return match host(&field(&["Url", "URL", "url", "Uri"])) {
            h if h.is_empty() => Activity::new("web", ""),
            h => Activity::new("read", h),
        };
    }
    if has(&["list_dir", "list_directory"]) {
        return Activity::new("search", "");
    }
    if has(&["grep", "search", "find", "glob"]) {
        return Activity::new("search", short(&field(&["Query", "Pattern", "SearchPattern", "query", "pattern"])));
    }
    if has(&["write", "replace", "edit", "create_file", "delete"]) {
        return Activity::new("edit", path());
    }
    if has(&["view", "read", "open"]) {
        let file = path();
        return if is_screenshot(&file) { Activity::new("screen", "") } else { Activity::new("read", file) };
    }
    if has(&["plan", "todo"]) {
        return Activity::new("plan", "");
    }
    match pretty_tool(name) {
        p if p.is_empty() => Activity::thinking(),
        p => Activity::new("tool", p),
    }
}

/// What calling tool `name` with `params` does to a file, matched by name
/// like `activity_for`; None for every other tool (a page, a folder, a
/// deletion) and for a screenshot.
fn touch_for(name: &str, params: &Value) -> Option<FileTouch> {
    let parsed;
    let params = match params {
        Value::String(s) => {
            parsed = serde_json::from_str::<Value>(s).unwrap_or(Value::Null);
            &parsed
        }
        other => other,
    };
    let path = ["AbsolutePath", "FilePath", "TargetFile", "File", "Path", "file_path", "path"]
        .iter()
        .filter_map(|k| params.get(*k).and_then(Value::as_str))
        .find(|s| !s.trim().is_empty())?;
    let n = name.to_ascii_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| n.contains(w));
    if has(&["screenshot", "url", "fetch", "browser", "list_dir", "list_directory", "delete"]) || is_screenshot(&file_name(path)) || agy_own(path) {
        return None;
    }
    if has(&["write", "create_file"]) {
        return FileTouch::written(path);
    }
    if has(&["replace", "edit"]) {
        return FileTouch::new("edited", path);
    }
    if has(&["view", "read", "open"]) {
        return FileTouch::new("read", path);
    }
    None
}

/// A file of agy's own (its `.gemini` folder: settings, logs, what Lumo's
/// tools answered it), not one of the chat's.
fn agy_own(path: &str) -> bool {
    let p = path.replace('\\', "/").to_ascii_lowercase();
    p.contains("/.gemini/antigravity") || p.starts_with(".gemini/antigravity")
}

/// A tool error that says a permission was not given.
fn is_denial(error: &Value) -> bool {
    let text = match error {
        Value::Null => return false,
        Value::String(s) => s.to_lowercase(),
        other => other.to_string().to_lowercase(),
    };
    ["permission", "denied", "not allowed", "approval"].iter().any(|w| text.contains(w))
}

/// How many soft-denials agy noted on stderr.
fn stderr_denials(stderr: &str) -> usize {
    stderr
        .lines()
        .map(str::to_lowercase)
        .filter(|l| l.contains("denied") || (l.contains("permission") && l.contains("tool")))
        .count()
}

/// agy says it has no sign-in to use.
fn is_auth_error(text: &str) -> bool {
    let l = text.to_lowercase();
    ["authentication required", "not authenticated", "unauthenticated", "login required", "not logged in", "not signed in"]
        .iter()
        .any(|w| l.contains(w))
}

/// The words of a `result` error: a string, or `{type, message}`.
fn error_text(error: &Value) -> Option<String> {
    match error {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Object(o) => o
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| o.get("type").and_then(Value::as_str))
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string()),
        _ => None,
    }
}

// ── The subagents it delegates to ─────────────────────────────────────────────

/// A tool's parameters: an object, or its JSON text.
fn params_of(params: &Value) -> Value {
    match params {
        Value::String(s) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
        other => other.clone(),
    }
}

/// The task a delegating step gives its subagent, as its parameters say it,
/// else the tool's name in words ("browser subagent").
fn delegated_title(name: &str, params: &Value) -> String {
    let params = params_of(params);
    ["TaskName", "TaskSummary", "Task", "Prompt", "Description", "task", "prompt", "description"]
        .iter()
        .filter_map(|k| params.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| pretty_tool(name))
}

/// The subagents of a turn: one row for each, by its conversation.
#[derive(Default, Debug)]
struct Subagents {
    agents: Agents,
    /// The steps of the main conversation that delegate, still running:
    /// step index, the title they give, and the row once its first step came.
    delegating: Vec<(u64, String, Option<String>)>,
    /// The subagents' steps already counted, as "row:step".
    counted: HashSet<String>,
    /// This turn's mark (chat_agents::run_mark), made when first needed: in
    /// the ids of subagents named by their step, which a later turn reuses.
    mark: Option<String>,
    /// The subagents `invoke_subagent` started, each with its transcript.
    spawns: Vec<Spawn>,
    /// Files the subagents wrote, not passed on yet.
    files: Vec<FileTouch>,
}

/// A subagent `invoke_subagent` started. agy's stream says nothing of its
/// work: its own transcript (`log_uri`, a JSON line per step) does.
#[derive(Debug)]
struct Spawn {
    /// The step that started it, and its place in that step's list.
    step: u64,
    n: usize,
    /// Its row's id.
    row: String,
    /// Its transcript, once the step is done and names it.
    log: Option<PathBuf>,
    /// How far the transcript was read, and a line not yet whole.
    read: u64,
    partial: Vec<u8>,
    /// What it sent its parent (`send_message`): its report.
    report: Option<String>,
    /// Files its last call writes, told once the call's result says it did.
    pending: Vec<FileTouch>,
    /// Inside a line past MAX_LINE: dropped up to its end.
    skipping: bool,
}

/// How much of a transcript is read at a time.
const TRANSCRIPT_CHUNK: u64 = 512 * 1024;
/// How often the subagents' transcripts are looked at while they work.
const TRANSCRIPT_POLL: Duration = Duration::from_millis(1500);

/// The file a subagent's `log_uri` names: only agy's own transcript of it,
/// in its `.gemini` folder, never any other file a stream might name.
fn transcript_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let mut bytes = Vec::with_capacity(rest.len());
    let raw = rest.as_bytes();
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' && i + 2 < raw.len() {
            if let Ok(b) = u8::from_str_radix(std::str::from_utf8(&raw[i + 1..i + 3]).ok()?, 16) {
                bytes.push(b);
                i += 3;
                continue;
            }
        }
        bytes.push(raw[i]);
        i += 1;
    }
    let path = String::from_utf8(bytes).ok()?;
    // file:///C:/… on Windows, file:///home/… elsewhere; never a host's
    // (file://host/…, file:////host/share/…: a network share).
    let local = path.strip_prefix('/')?;
    let path = if local.as_bytes().get(1) == Some(&b':') && local.as_bytes().get(2) == Some(&b'/') {
        local.replace('/', "\\")
    } else if !local.starts_with('/') && !local.starts_with('\\') && !local.contains(':') {
        format!("/{local}")
    } else {
        return None;
    };
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    let ours = lower.contains("/.gemini/antigravity") && lower.ends_with("/transcript.jsonl") && !lower.contains("/../");
    ours.then(|| PathBuf::from(path))
}

/// A tool call's arguments, as a subagent's transcript writes them: each
/// value is its JSON text ("\"C:\\\\a.txt\""), read back here.
fn transcript_args(args: &Value) -> Value {
    let Some(map) = args.as_object() else { return Value::Null };
    Value::Object(
        map.iter()
            .map(|(k, v)| {
                let v = match v.as_str() {
                    Some(text) => serde_json::from_str::<Value>(text).unwrap_or_else(|_| v.clone()),
                    None => v.clone(),
                };
                (k.clone(), v)
            })
            .collect(),
    )
}

/// One line of a subagent's transcript on its row: its steps, what it does
/// now, its tokens, its report, and the files it wrote (`pending` until the
/// call's result says it went through). True once it is done: its answer,
/// with no more calls.
fn transcript_line(row: &mut AgentRow, report: &mut Option<String>, pending: &mut Vec<FileTouch>, files: &mut Vec<FileTouch>, line: &Value) -> bool {
    let read = |k: &str| line[k].as_u64().unwrap_or(0);
    let context = read("input_tokens") + read("cache_read_tokens");
    if context > 0 {
        row.tokens = Some(row.tokens.unwrap_or(0).max(context));
    }
    // A call's result: the files it wrote, unless it failed.
    if line["type"] == "GENERIC" && !pending.is_empty() {
        let text = line["content"].as_str().unwrap_or("").to_ascii_lowercase();
        let failed = line["status"].as_str().is_some_and(|s| s != "DONE") || ["error", "failed", "denied", "not allowed"].iter().any(|w| text.contains(w));
        for touch in pending.drain(..) {
            if !failed && !files.contains(&touch) {
                files.push(touch);
            }
        }
    }
    let calls = line["tool_calls"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    for call in calls {
        let name = call["name"].as_str().unwrap_or("");
        let args = transcript_args(&call["args"]);
        row.steps += 1;
        row.now = Some(activity_for(name, &args));
        if name == "send_message" {
            if let Some(text) = args["Message"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
                *report = Some(text.to_string());
                row.summary = Some(crate::chat_agents::summary_of(text));
            }
        }
        let lower = name.to_ascii_lowercase();
        let path = ["Path", "TargetFile", "AbsolutePath", "FilePath", "File"].iter().filter_map(|k| args[*k].as_str()).find(|p| !p.trim().is_empty());
        if let Some(path) = path.filter(|p| !agy_own(p)) {
            let touch = if lower.contains("write") || lower.contains("create_file") {
                FileTouch::new("created", path)
            } else if lower.contains("replace") || lower.contains("edit") {
                FileTouch::new("edited", path)
            } else {
                None
            };
            pending.extend(touch);
        }
    }
    // Its calls cut from the line (a long one): a step all the same, never its answer.
    let cut = line["truncated_fields"].as_array().is_some_and(|f| f.iter().any(|x| x == "tool_calls"));
    if cut && calls.is_empty() {
        row.steps += 1;
        row.now = Some(Activity::new("tool", ""));
        return false;
    }
    let answer = line["content"].as_str().map(str::trim).filter(|t| !t.is_empty());
    match answer {
        Some(answer) if calls.is_empty() && line["type"] == "PLANNER_RESPONSE" && line["source"] == "MODEL" => {
            row.summary = Some(crate::chat_agents::summary_of(report.as_deref().unwrap_or(answer)));
            true
        }
        _ => {
            if calls.is_empty() && line["source"] == "MODEL" && line["type"] == "PLANNER_RESPONSE" {
                row.now = Some(Activity::thinking());
            }
            false
        }
    }
}

impl Subagents {
    /// A tool step of the main conversation that delegates began.
    fn delegated(&mut self, index: u64, title: String) {
        if !self.delegating.iter().any(|d| d.0 == index) {
            self.delegating.push((index, title, None));
        }
    }

    /// The step that delegated ended (`error`: as ERROR): its subagent with it.
    fn delegation_ended(&mut self, index: u64, error: Option<Option<String>>) {
        let Some(pos) = self.delegating.iter().position(|d| d.0 == index) else { return };
        let (_, _, row) = self.delegating.remove(pos);
        let Some(id) = row else { return };
        if self.agents.get(&id).is_some_and(|r| r.state.is_final()) {
            return;
        }
        if let Some(row) = self.agents.touch(&id) {
            match error {
                Some(error) => row.end(AgentState::Failed, error),
                None => row.end(AgentState::Done, None),
            }
        }
    }

    /// A step that starts subagents (agy's `invoke_subagent`: step_type
    /// "subagent", its `subagent_info.subagents`, in place of a tool's info):
    /// one row each, named by its role, as soon as the step says it. The step
    /// is done once they are started, and names each one's transcript: their
    /// work is read there (`read_transcripts`), as agy's stream has no step
    /// of theirs.
    fn spawned(&mut self, index: u64, list: &[Value]) {
        for (n, entry) in list.iter().enumerate() {
            let text = |keys: &[&str]| keys.iter().filter_map(|k| entry[*k].as_str()).map(str::trim).find(|s| !s.is_empty()).map(str::to_string);
            let log = text(&["log_uri", "logUri"]).and_then(|u| transcript_path(&u));
            if let Some(spawn) = self.spawns.iter_mut().find(|s| s.step == index && s.n == n) {
                if spawn.log.is_none() {
                    spawn.log = log;
                }
                continue;
            }
            let row = format!("agy-{}-{index}-{}", self.mark(), n + 1);
            let title = text(&["role", "name", "type_name"]).map(|s| if s.contains('_') { pretty_tool(&s) } else { s }).unwrap_or_else(|| t("Agent"));
            let made = self.agents.upsert(&row, || AgentRow::new(row.as_str(), PROVIDER, &title));
            made.now = Some(Activity::thinking());
            self.spawns.push(Spawn { step: index, n, row, log, read: 0, partial: Vec::new(), report: None, pending: Vec::new(), skipping: false });
        }
    }

    /// Whether a subagent `invoke_subagent` started is still at work.
    fn spawns_open(&self) -> bool {
        self.spawns.iter().any(|s| self.agents.get(&s.row).is_some_and(|r| !r.state.is_final()))
    }

    /// What the subagents still at work wrote in their transcripts since the
    /// last look (a chunk each at most): whether a row changed, and whether
    /// anything was read.
    fn read_transcripts(&mut self) -> (bool, bool) {
        use std::io::{Seek, SeekFrom};
        let (mut changed, mut read_any) = (false, false);
        for spawn in &mut self.spawns {
            let Some(path) = spawn.log.as_ref() else { continue };
            if self.agents.get(&spawn.row).is_none_or(|r| r.state.is_final()) {
                continue;
            }
            let Ok(mut file) = std::fs::File::open(path) else { continue };
            if file.seek(SeekFrom::Start(spawn.read)).is_err() {
                continue;
            }
            let mut fresh = Vec::new();
            let Ok(n) = (&mut file).take(TRANSCRIPT_CHUNK).read_to_end(&mut fresh) else { continue };
            if n == 0 {
                continue;
            }
            read_any = true;
            spawn.read += n as u64;
            // A line past MAX_LINE (a huge file written whole) is dropped up to its end.
            let mut fresh = &fresh[..];
            if spawn.skipping {
                match fresh.iter().position(|b| *b == b'\n') {
                    Some(end) => {
                        spawn.skipping = false;
                        fresh = &fresh[end + 1..];
                    }
                    None => continue,
                }
            }
            spawn.partial.extend_from_slice(fresh);
            let last = spawn.partial.iter().rposition(|b| *b == b'\n');
            let whole: Vec<u8> = match last {
                Some(last) => spawn.partial.drain(..=last).collect(),
                None => Vec::new(),
            };
            if spawn.partial.len() > MAX_LINE {
                spawn.partial.clear();
                spawn.skipping = true;
            }
            let Some(row) = self.agents.touch(&spawn.row) else { continue };
            changed = true;
            for line in whole.split(|b| *b == b'\n').filter(|l| l.len() <= MAX_LINE) {
                let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
                if transcript_line(row, &mut spawn.report, &mut spawn.pending, &mut self.files, &v) {
                    row.end(AgentState::Done, None);
                    break;
                }
            }
        }
        (changed, read_any)
    }

    /// The step that started subagents failed: they never ran.
    fn spawn_failed(&mut self, index: u64, error: Option<String>) {
        for spawn in self.spawns.iter().filter(|s| s.step == index) {
            if let Some(row) = self.agents.touch(&spawn.row) {
                row.end(AgentState::Failed, error.clone());
            }
        }
    }

    /// This turn's mark.
    fn mark(&mut self) -> String {
        self.mark.get_or_insert_with(chat_agents::run_mark).clone()
    }

    /// The step that delegated to a subagent heard of now, by its place in
    /// `delegating`: the oldest still without a subagent (agy starts them in
    /// the order it delegated), or else the latest. agy's steps don't say,
    /// so the one rule names a subagent, titles it and ends it.
    fn delegation(&self) -> Option<usize> {
        self.delegating.iter().position(|d| d.2.is_none()).or_else(|| self.delegating.len().checked_sub(1))
    }

    /// One step of a subagent (`subagent_info`).
    fn step(&mut self, index: u64, done: bool, v: &Value) {
        let info = &v["subagent_info"];
        let conversation = ["conversation_id", "conversationId"].iter().filter_map(|k| info[*k].as_str()).map(str::trim).find(|s| !s.is_empty());
        let delegation = self.delegation();
        // Without its conversation, the step that delegated names it, with
        // the turn's mark: the next turn has a step 5 of its own.
        let id = match conversation {
            Some(conversation) => conversation.to_string(),
            None => {
                let mark = self.mark();
                match delegation {
                    Some(pos) => format!("step-{}-{mark}", self.delegating[pos].0),
                    None => format!("subagent-{mark}"),
                }
            }
        };
        if self.agents.get(&id).is_none() {
            // The step that delegated, when it has no subagent yet, gives it its title.
            let title = match delegation.map(|pos| &mut self.delegating[pos]).filter(|d| d.2.is_none()) {
                Some(d) => {
                    d.2 = Some(id.clone());
                    d.1.clone()
                }
                None => t("Agent"),
            };
            self.agents.upsert(&id, || AgentRow::new(id.as_str(), PROVIDER, &title));
        }
        if self.agents.get(&id).is_some_and(|r| r.state.is_final()) {
            return;
        }
        let first = !done && v["step_type"] == "tool" && self.counted.insert(format!("{id}:{index}"));
        let Some(row) = self.agents.touch(&id) else { return };
        if done {
            return;
        }
        if first {
            row.steps += 1;
        }
        row.now = Some(match v["step_type"].as_str() {
            Some("tool") => {
                let info = &v["tool_info"];
                let name = info["name"].as_str().filter(|s| !s.is_empty()).or_else(|| v["tool_name"].as_str()).unwrap_or("");
                activity_for(name, &info["parameters"])
            }
            _ => Activity::thinking(),
        });
    }

    /// The run is over: the subagents still open end as it did.
    fn run_ended(&mut self, state: AgentState) {
        let error = if state == AgentState::Failed { tf("{agent} ended", &[("agent", "Antigravity CLI")]) } else { String::new() };
        if self.agents.open() > 0 {
            self.agents.end_open(state, &error);
        }
    }
}

// ── Reading the stream ────────────────────────────────────────────────────────

/// What the stream-json output has told us so far.
#[derive(Default, Debug)]
struct Run {
    /// The conversation to resume next turn.
    conversation: Option<String>,
    /// The text of the response step being written, for the island.
    visible: String,
    /// Every text of the turn, each step on its own lines (chat::keep_lumo_lines).
    said: String,
    /// The `step_index` `visible` belongs to.
    text_step: Option<u64>,
    /// The `result` event: final text, or the error agy reported.
    result: Option<Result<String, String>>,
    denied: usize,
    /// The user pressed Stop and the CLI was ended.
    stopped: bool,
    /// What the answer is doing since the text last grew (None once it does).
    activity: Option<Activity>,
    /// `activity` changed and the island was not told yet (`take_activity`).
    activity_changed: bool,
    /// Tool steps still running, oldest first: step index and what each is doing.
    pending: Vec<(u64, Activity)>,
    /// The last lines agy wrote on stderr: why an answer came back empty.
    stderr_tail: String,
    /// The plans agy gave Lumo's update_plan tool, not yet passed on (`take_plan`).
    plan: Option<Value>,
    /// The last plan passed on: the same call seen again is no news.
    plan_seen: Option<Value>,
    /// Tool steps that read or write a file, still running: step index and
    /// the file, as first seen (before the tool ran, so a write knows whether it creates).
    touching: Vec<(u64, FileTouch)>,
    /// Files used by steps that finished, not passed on yet (`take_files`).
    touched: Vec<FileTouch>,
    /// The tokens the turn's result says it used (read and written): about how
    /// full the conversation is, for the chat's usage menu.
    context_used: Option<u64>,
    /// The subagents its steps delegated to.
    subagents: Subagents,
}

/// The tokens a result's `usage` counts: what the model read (cached or not,
/// as agy's input counts the cache in) and what it wrote and thought.
fn usage_tokens(usage: &Value) -> Option<u64> {
    let n = |k: &str| usage[k].as_u64().unwrap_or(0);
    let total = n("input_tokens") + n("output_tokens") + n("thinking_tokens");
    (total > 0).then_some(total)
}

impl Run {
    /// Takes one line; true when the visible text changed.
    fn feed(&mut self, line: &[u8]) -> bool {
        let Ok(frame) = serde_json::from_slice::<Value>(line) else { return false };
        let event = frame.get("event").and_then(Value::as_str);
        // agy puts each event's fields in an object named after it
        // (`{"event": "result", "result": {…}}`); older builds put them next
        // to `event`.
        let v = match event.and_then(|e| frame.get(e)) {
            Some(inner) if inner.is_object() => inner,
            _ => &frame,
        };
        let id = v
            .get("conversation_id")
            .or_else(|| frame.get("conversation_id"))
            .and_then(Value::as_str)
            .and_then(safe_session);
        match event {
            Some("result") => {
                // The result's conversation is the one to resume, whatever came before.
                if let Some(id) = id {
                    self.conversation = Some(id.to_string());
                }
                if let Some(used) = usage_tokens(&v["usage"]) {
                    self.context_used = Some(used);
                }
                let status = v["status"].as_str().unwrap_or("").trim().to_ascii_uppercase();
                let error = error_text(&v["error"]);
                let response = v["response"].as_str().unwrap_or("").to_string();
                self.result = Some(match (status.as_str(), error) {
                    ("SUCCESS", _) | ("", None) => Ok(response),
                    (_, Some(e)) => Err(e),
                    (s, None) => Err(s.to_string()),
                });
                false
            }
            Some(event) => {
                if self.conversation.is_none() {
                    self.conversation = id.map(str::to_string);
                }
                event == "step_update" && self.step(v)
            }
            None => false,
        }
    }

    /// One `step_update`; true when the visible text changed.
    fn step(&mut self, v: &Value) -> bool {
        let index = v["step_index"].as_u64().unwrap_or(u64::MAX);
        // A step ends DONE, or ERROR (a tool refused or failed).
        let done = matches!(v["state"].as_str(), Some("DONE" | "ERROR"));
        // A step that starts subagents: a row for each; the answer waits on them.
        if let Some(list) = v["subagent_info"]["subagents"].as_array().filter(|_| v["step_type"] == "subagent" || v.get("tool_info").is_none()) {
            self.subagents.spawned(index, list);
            if v["state"] == "ERROR" {
                self.subagents.spawn_failed(index, error_text(&v["error"]).or_else(|| error_text(&v["subagent_info"]["error"])));
            }
            if done {
                self.finished_tool(index);
                // Started, not finished: the answer waits on them.
                if self.subagents.spawns_open() {
                    self.set_activity(Activity::new("subtask", ""));
                }
            } else {
                self.started_tool(index, Activity::new("subtask", ""));
            }
            return false;
        }
        // A subagent at work: its own steps are its row's, not the answer's.
        if v.get("subagent_info").is_some_and(|s| !s.is_null()) {
            self.subagents.step(index, done, v);
            if done {
                self.finished_tool(index);
            } else {
                self.started_tool(index, Activity::new("subtask", ""));
            }
            return false;
        }
        match v["step_type"].as_str() {
            Some("agent_response") => {
                let text = v["text_delta"].as_str().unwrap_or("");
                if text.is_empty() {
                    // Working on an answer that shows no text yet.
                    if !done && self.text_step != Some(index) {
                        self.set_activity(Activity::thinking());
                    }
                    return false;
                }
                // A new response step: the island shows it, not the one before.
                if self.text_step != Some(index) {
                    self.text_step = Some(index);
                    self.visible.clear();
                    self.said.push('\n');
                }
                self.visible.push_str(text);
                self.said.push_str(text);
                // The text shows instead: a later tool step is news again.
                self.activity = None;
                self.activity_changed = false;
                true
            }
            Some("tool") => {
                let info = &v["tool_info"];
                let name = info["name"].as_str().filter(|s| !s.is_empty()).or_else(|| v["tool_name"].as_str()).unwrap_or("");
                if done {
                    // A step that delegated: its subagent is done, or failed with it.
                    let failed = v["state"] == "ERROR" || error_text(&info["error"]).is_some();
                    self.subagents.delegation_ended(index, failed.then(|| error_text(&info["error"])));
                    if is_denial(&info["error"]) {
                        self.denied += 1;
                    }
                    if let Some(pos) = self.touching.iter().position(|(i, _)| *i == index) {
                        let (_, touch) = self.touching.remove(pos);
                        // A step that failed or was refused did nothing to the file.
                        if v["state"] != "ERROR" && error_text(&info["error"]).is_none() {
                            self.touched.push(touch);
                        }
                    }
                    self.finished_tool(index);
                } else {
                    if is_plan_tool(name) {
                        self.saw_plan(&info["parameters"]);
                    }
                    if activity_for(name, &Value::Null).kind == "subtask" {
                        self.subagents.delegated(index, delegated_title(name, &info["parameters"]));
                    }
                    if !self.touching.iter().any(|(i, _)| *i == index) {
                        if let Some(touch) = touch_for(name, &info["parameters"]) {
                            self.touching.push((index, touch));
                        }
                    }
                    self.started_tool(index, activity_for(name, &info["parameters"]));
                }
                false
            }
            Some("user_input" | "checkpoint") => false,
            // A subagent's message woke the answer: it coordinates them.
            Some("system_message") if self.subagents.spawns_open() => {
                self.set_activity(Activity::new("subtask", ""));
                false
            }
            // Any other step agy is working on: it thinks.
            _ => {
                if !done {
                    self.set_activity(Activity::thinking());
                }
                false
            }
        }
    }

    fn set_activity(&mut self, activity: Activity) {
        if self.activity.as_ref() != Some(&activity) {
            self.activity = Some(activity);
            self.activity_changed = true;
        }
    }

    /// A tool step began (or says more about itself): remembered until it is done.
    fn started_tool(&mut self, index: u64, activity: Activity) {
        match self.pending.iter_mut().find(|(i, _)| *i == index) {
            Some(entry) => entry.1 = activity.clone(),
            None => self.pending.push((index, activity.clone())),
        }
        self.set_activity(activity);
    }

    /// A tool step is done: the one still running shows, or agy thinks again.
    fn finished_tool(&mut self, index: u64) {
        self.pending.retain(|(i, _)| *i != index);
        let next = self.pending.last().map(|(_, a)| a.clone()).unwrap_or_else(Activity::thinking);
        self.set_activity(next);
    }

    /// Lumo's update_plan called with `params` (an object, or its JSON text).
    fn saw_plan(&mut self, params: &Value) {
        let params = match params {
            Value::String(s) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
            v => v.clone(),
        };
        if !params["plan"].as_array().is_some_and(|p| !p.is_empty()) || self.plan_seen.as_ref() == Some(&params) {
            return;
        }
        self.plan_seen = Some(params.clone());
        self.plan = Some(params);
    }

    /// The plan agy last gave, once.
    fn take_plan(&mut self) -> Option<Value> {
        self.plan.take()
    }

    /// The files used since the last time, oldest first.
    fn take_files(&mut self) -> Vec<FileTouch> {
        self.touched.append(&mut self.subagents.files);
        std::mem::take(&mut self.touched)
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

/// agy's plan, to the Plan island (src/island/plan.ts) as island chat
/// `chat`'s: the chat agy works for, never the one on screen when it comes.
fn emit_plan(app: &AppHandle, chat: &str, tool: &str, input: Value) {
    let _ = app.emit_to(crate::island::WINDOW_LABEL, "chat-plan", plan_event(chat, tool, input));
}

/// The `chat-plan` event of agy's plan for island chat `chat`.
fn plan_event(chat: &str, tool: &str, input: Value) -> Value {
    json!({ "chat": chat, "tool": tool, "input": input, "agent": "Antigravity CLI", "color": "#E879F9" })
}

/// A call of Lumo's update_plan tool, handed over by lumo-hook's MCP server
/// (`{"lumo_plan": {"input": …, "chat": …}}`, pipe.rs): its plan goes to the
/// Plan island, as the plan of the chat agy was started for (`LUMO_CHAT_ID`).
/// agy's stream says the same of its tool steps, but not of every build's
/// MCP calls: this is the way that always comes.
pub fn serve_plan(app: &AppHandle, request: &Value) -> Value {
    let input = &request["input"];
    if !input["plan"].as_array().is_some_and(|p| !p.is_empty()) {
        return json!({ "error": "The plan needs at least one step." });
    }
    let chat = request["chat"].as_str().unwrap_or("");
    emit_plan(app, chat, "update_plan", input.clone());
    json!({ "text": "Plan shown to the user." })
}

/// Whether agy's tool `name` is Lumo's update_plan (lumo-hook's MCP server,
/// `--tools=plan`), whatever agy puts in front: "mcp_lumo_update_plan",
/// "lumo/update_plan"…
fn is_plan_tool(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("lumo") && lower.trim_end().ends_with("update_plan")
}

/// Why a run ended without a result, from what agy wrote on stderr.
fn failure(stderr: &str, code: &str) -> String {
    if is_auth_error(stderr) {
        return not_signed_in();
    }
    let detail = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    if detail.is_empty() {
        tf("Antigravity CLI stopped without an answer (exit {code}). Is it signed in? Run `agy` once in a terminal.", &[("code", code)])
    } else {
        tf("Antigravity CLI: {error}", &[("error", detail)])
    }
}

/// The last few lines of stderr, joined, for the log and an empty answer's message.
fn stderr_tail(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines[lines.len().saturating_sub(3)..].join(" · ")
}

/// What to say when agy's turn ended without any text: what it wrote on
/// stderr when it wrote anything (a refused permission is said there), else
/// that a permission was refused when one was.
fn empty_answer(denied: usize, stderr_tail: &str) -> String {
    // agy's own advice (an allow rule, or skipping permissions) is not for the
    // island: Lumo's hooks are the way to approve a command from it.
    let refused = stderr_tail.contains("permission") && (stderr_tail.contains("denied") || stderr_tail.contains("auto-denied"));
    if refused && !crate::agents::antigravity_cards_ready() {
        t("Antigravity CLI needed a permission that wasn't given. Install Lumo's Antigravity hooks to approve commands from the island.")
    } else if !stderr_tail.is_empty() {
        tf("Antigravity CLI gave no answer: {error}", &[("error", stderr_tail)])
    } else if denied > 0 {
        t("Antigravity CLI needed a permission that wasn't given. Install Lumo's Antigravity hooks to approve commands from the island.")
    } else {
        t("Antigravity CLI gave no answer.")
    }
}

/// The error a `result` reported, for the island.
fn result_error(error: &str) -> String {
    if is_auth_error(error) {
        not_signed_in()
    } else {
        tf("Antigravity CLI: {error}", &[("error", error)])
    }
}

/// Runs agy headless once in `dir`, blocking. `on_text` gets the visible text as
/// it grows, `on_activity` what agy is doing each time it changes, `on_file`
/// each file a tool step read or wrote once it finished, `on_plan` each plan
/// it gives Lumo's update_plan tool, `tell` every line (a sign of life) and
/// the subagents it delegates to. Stop ends the CLI and its children; the
/// run so far is returned, `stopped`.
#[allow(clippy::too_many_arguments)]
fn run(
    exe: PathBuf,
    args: Vec<String>,
    input: String,
    dir: PathBuf,
    chat_id: &str,
    stop: Arc<Stop>,
    mut on_text: impl FnMut(&str),
    mut on_activity: impl FnMut(&Activity),
    mut on_file: impl FnMut(&FileTouch),
    mut on_plan: impl FnMut(&Value),
    tell: &Tell,
) -> Result<Run, String> {
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut cmd = Command::new(&exe);
    cmd.args(&args).current_dir(&dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // Tells lumo-hook this run is the island's chat, not a session to show.
    cmd.env("LUMO_ISLAND_RUN", "1");
    // Which chat the island's tools are called from (lumo-hook's MCP server, island_tools.rs).
    if !chat_id.is_empty() {
        cmd.env("LUMO_CHAT_ID", chat_id);
    }
    platform::no_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| tf("Cannot start Antigravity CLI: {error}", &[("error", &e.to_string())]))?;
    platform::chat_ends_with_lumo(&child);

    // Open until the turn's result: closing it ends agy's stream-json input.
    let mut stdin = child.stdin.take();
    if let Some(pipe) = stdin.as_mut() {
        let _ = pipe.write_all(input.as_bytes());
        let _ = pipe.flush();
    }
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take();
    let (err_tx, err_text) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = stderr {
            let mut e = e;
            let _ = (&mut e).take(64 * 1024).read_to_string(&mut s);
            // Past the cap, keep the pipe flowing: a full one would stall agy.
            let _ = std::io::copy(&mut e, &mut std::io::sink());
        }
        let _ = err_tx.send(s);
    });

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut total = 0usize;
        loop {
            let mut line = Vec::new();
            match (&mut reader).take(MAX_LINE as u64 + 1).read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    total += n;
                    // A line past MAX_LINE: the rest of it is dropped up to its end,
                    // so its tail is not read as the next line.
                    if n > MAX_LINE && !line.ends_with(b"\n") {
                        let rest = reader.skip_until(b'\n').unwrap_or(0);
                        total = total.saturating_add(rest);
                        if total > MAX_TOTAL {
                            break;
                        }
                        continue;
                    }
                    if total > MAX_TOTAL || tx.send(line).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
    });

    let mut last_emit = Instant::now() - DELTA_INTERVAL;
    let mut unsent = false;
    let mut state = Run::default();
    let mut last_look = Instant::now();
    // When the turn's result came.
    let mut result_at: Option<Instant> = None;
    loop {
        if stop.is_stopped() && state.result.is_none() {
            drop(stdin.take());
            kill_tree(&mut child);
            state.stopped = true;
            state.subagents.run_ended(AgentState::Stopped);
            tell(&mut state.subagents.agents, false);
            return Ok(state);
        }
        // The answer is in: agy gets a moment to end, then it and what it
        // started are ended, at once on Stop. A process left holding its
        // output would otherwise keep the turn, and Stop, waiting for ever.
        if done_waiting(result_at, stop.is_stopped(), claude_code::AFTER_RESULT) {
            kill_tree(&mut child);
            break;
        }
        // The subagents' own work, from their transcripts.
        if last_look.elapsed() >= TRANSCRIPT_POLL {
            last_look = Instant::now();
            if state.subagents.read_transcripts().0 {
                tell(&mut state.subagents.agents, true);
                for file in state.take_files() {
                    on_file(&file);
                }
            }
        }
        match rx.recv_timeout(STOP_POLL) {
            Ok(line) => {
                unsent |= state.feed(&line);
                tell(&mut state.subagents.agents, true);
                if state.result.is_some() && result_at.is_none() {
                    // The turn is over: agy may end.
                    drop(stdin.take());
                    result_at = Some(Instant::now());
                }
                let activity = state.take_activity();
                if unsent && (activity.is_some() || last_emit.elapsed() >= DELTA_INTERVAL) {
                    unsent = false;
                    last_emit = Instant::now();
                    on_text(&state.visible);
                }
                if let Some(activity) = activity {
                    on_activity(&activity);
                }
                for file in state.take_files() {
                    on_file(&file);
                }
                if let Some(plan) = state.take_plan() {
                    on_plan(&plan);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    drop(stdin);
    // What they wrote last (their answer comes a moment after their report), to the end.
    for _ in 0..64 {
        if !state.subagents.read_transcripts().1 {
            break;
        }
    }
    for file in state.take_files() {
        on_file(&file);
    }
    // The turn is over: a subagent can't outlive it.
    state.subagents.run_ended(if matches!(state.result, Some(Ok(_))) { AgentState::Done } else { AgentState::Failed });
    tell(&mut state.subagents.agents, false);
    let status = if state.result.is_some() {
        // Ended already, or its output closed with the answer in: it may not
        // be gone yet, and is not waited for past AFTER_RESULT.
        claude_code::end_after_result(&mut child, &stop, claude_code::AFTER_RESULT)
    } else {
        child.wait().ok()
    };
    // A process agy left behind may still hold stderr: what was read by then.
    let stderr = err_text.recv_timeout(STDERR_WAIT).unwrap_or_default();
    state.denied += stderr_denials(&stderr);
    state.stderr_tail = stderr_tail(&stderr);
    if state.result.is_none() {
        let code = status.and_then(|s| s.code()).map(|c| c.to_string()).unwrap_or_default();
        return Err(failure(&stderr, &code));
    }
    Ok(state)
}

/// Whether a turn whose result came at `result_at` waited long enough for agy
/// to end by itself: `grace` after it, or at once on Stop. Never before the result.
fn done_waiting(result_at: Option<Instant>, stopped: bool, grace: Duration) -> bool {
    result_at.is_some_and(|at| stopped || at.elapsed() >= grace)
}

// ── Models ────────────────────────────────────────────────────────────────────

/// The models of `agy models`, whatever its layout: JSON, one per line, or a
/// table whose first column is the model. A line that names no model (a
/// heading, a hint) is left out: every model name has a digit in it.
fn parse_models(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |id: &str| {
        let id = id.trim();
        let id = ["- ", "* ", "• ", "› ", "> "].iter().find_map(|b| id.strip_prefix(b)).unwrap_or(id).trim_start();
        let id = ["(current)", "(default)", "(selected)", "*"]
            .iter()
            .fold(id, |s, mark| s.strip_suffix(mark).unwrap_or(s).trim_end());
        if let Some(m) = safe_model(id).filter(|m| m.chars().any(|c| c.is_ascii_digit())) {
            if !out.iter().any(|o| o == m) && out.len() < MAX_MODELS {
                out.push(m.to_string());
            }
        }
    };
    if let Ok(v) = serde_json::from_str::<Value>(text.trim()) {
        let list = v.as_array().or_else(|| v.get("models").and_then(Value::as_array));
        for item in list.into_iter().flatten() {
            let id = item.as_str().or_else(|| ["id", "slug", "model", "name"].iter().find_map(|k| item.get(*k).and_then(Value::as_str)));
            if let Some(id) = id {
                add(id);
            }
        }
        return out;
    }
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.ends_with(':') {
            continue;
        }
        let first = line.split('\t').next().unwrap_or("").split("  ").next().unwrap_or("");
        add(first);
    }
    out
}

/// Runs `agy models`, for at most MODELS_TIMEOUT. Nothing on any failure.
fn list_models(exe: PathBuf) -> Vec<String> {
    let mut cmd = Command::new(&exe);
    cmd.arg("models").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    platform::no_console(&mut cmd);
    let Ok(mut child) = cmd.spawn() else { return Vec::new() };
    let reader = crate::antigravity_plan::Output::read(child.stdout.take(), 256 * 1024);
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < MODELS_TIMEOUT => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                kill_tree(&mut child);
                return Vec::new();
            }
        }
    }
    parse_models(&reader.text_after_exit())
}

/// The models for the picker: "Default" (agy's own choice), then what
/// `agy models` lists. Asked only when the user opens the picker on this provider.
pub async fn models() -> Result<Vec<ModelInfo>, String> {
    let exe = platform::agy_candidates().into_iter().next().ok_or_else(not_installed)?;
    let listed = tauri::async_runtime::spawn_blocking(move || list_models(exe)).await.map_err(|e| e.to_string())?;
    let mut out = vec![ModelInfo { id: DEFAULT_MODEL.into(), label: t("Default"), ..Default::default() }];
    out.extend(listed.into_iter().map(|id| ModelInfo { label: id.clone(), id, ..Default::default() }));
    Ok(out)
}

// ── One turn ──────────────────────────────────────────────────────────────────

/// One chat turn through Antigravity CLI.
pub async fn send(
    app: &AppHandle,
    chat: &Chat,
    model: &str,
    mode: &str,
    query: String,
    context: Option<ChatContext>,
    folder: Option<String>,
) -> Result<ChatReply, String> {
    let exe = platform::agy_candidates().into_iter().next().ok_or_else(not_installed)?;
    if let Some(name) = command_of(&query) {
        return command(app, chat, exe, name, model, mode, folder).await;
    }

    let turn = chat.begin(PROVIDER);
    // Only an Antigravity conversation: never a Claude Code session.
    let conversation = chat.cli_session_for(PROVIDER);
    // Turns this conversation has not seen (another provider answered them, or
    // a message was edited) are carried over once, as text, with the instructions.
    let carried: Vec<Value> = if conversation.is_none() { turn.history.clone() } else { Vec::new() };
    // The turns another provider answered since this conversation last did:
    // they go in front of the question, and the conversation goes on.
    let unseen = chat.cli_unseen(PROVIDER);
    let text = format!("{}{}", claude_code::catch_up(&unseen), claude_code::prompt(context.as_ref(), &carried, &chat.files(), &query));
    let text = match conversation {
        Some(_) => text,
        None if chat.is_workshop() => with_workshop_instructions(&text),
        None => with_instructions(&text),
    };
    let input = user_event(&text);
    let inbox = crate::files::inbox_dir().to_string_lossy().to_string();
    let work = claude_code::work_dir();
    let args = args(model, mode, conversation.as_deref(), &work.to_string_lossy(), &inbox, &chat.cli_dirs(folder));
    // Lumo's plan tool, its email tools while the Email pill is on and Security
    // lets the AI read it (only during this turn), and the user's tools that are on (each call asks on the island).
    let tools = tauri::async_runtime::spawn_blocking(crate::tools::any_enabled).await.unwrap_or(false);
    crate::computer::agy_workspace(&work, crate::mail::ai_tools(app), tools);
    let _mail = crate::mail::agent_turn();

    let app2 = app.clone();
    let events = chat.events();
    let stop = chat.stopper();
    let chat_id = chat.id().to_string();
    let usage_chat = chat_id.clone();
    // The subagents agy delegates to, and the turn's sign of life.
    let tell = chat_agents::teller(app, chat.id());
    let state = tauri::async_runtime::spawn_blocking(move || {
        // agy's plan, for the Plan island (src/island/plan.ts): what it gives
        // Lumo's update_plan tool, as it goes. A checklist in its answer is
        // its plan only while it has not called the tool.
        let emit = |tool: &str, input: Value| emit_plan(&app2, &chat_id, tool, input);
        let by_tool = std::cell::Cell::new(false);
        let mut plan_sent = String::new();
        run(
            exe,
            args,
            input,
            work,
            &chat_id,
            stop,
            |text| {
                events.delta(&app2, text);
                if let Some(list) = checklist(text).filter(|_| !by_tool.get()) {
                    if list != plan_sent {
                        emit("Checklist", json!({ "text": list }));
                        plan_sent = list;
                    }
                }
            },
            |activity| events.activity(&app2, activity),
            |file| events.file(&app2, file),
            |plan| {
                by_tool.set(true);
                emit("update_plan", plan.clone());
            },
            &tell,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    // About how full the conversation is, for the chat's usage menu: agy does
    // not say its model's context window, the island knows it by the model's name.
    if let Some(used) = state.context_used {
        let usage = crate::chat_usage::ChatUsage {
            provider: "antigravity-cli".to_string(),
            context: Some(crate::chat_usage::ContextUse { chat: usage_chat, used, total: 0 }),
            tokens: None,
            requests: None,
            credits: None,
        };
        let _ = app.emit("chat-usage", usage);
    }
    if let Some(id) = &state.conversation {
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
        // The result repeats the answer; should it come back empty, what was
        // streamed is the answer.
        Some(Ok(text)) if text.trim().is_empty() => state.visible.trim().to_string(),
        Some(Ok(text)) => text,
        Some(Err(e)) => return Err(result_error(&e)),
        None => unreachable!("run() returns an error without a result"),
    };
    let answer = chat::keep_lumo_lines(answer, &state.said);
    let answer = if answer.trim().is_empty() {
        crate::log::line(format!("antigravity: empty answer; {} denied; stderr: {}", state.denied, state.stderr_tail));
        empty_answer(state.denied, &state.stderr_tail)
    } else {
        answer
    };
    chat.commit(&turn, json!({ "role": "user", "content": plain }), json!({ "role": "assistant", "content": answer }), &plain, &answer);
    Ok(ChatReply::answer(answer, chat.cli_session()))
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// agy's own commands that answer without a terminal, each tried from the
/// chat (agy 1.4.7): in the conversation, its commands are refused ("answered
/// by the CLI itself"), all but /compact, which compacts a conversation that
/// has turns. These others answer as a run of their own (`agy --print /usage`),
/// at once and without a model. The rest open agy's terminal views, or reach
/// the model as a question, so the chat keeps them off (`--disable-slash-commands`).
const COMPACT: &str = "compact";
const ON_THEIR_OWN: [&str; 3] = ["usage", "credits", "skills"];
/// A command run of its own answers in a few seconds.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
/// What a command run of its own may print.
const MAX_COMMAND_OUTPUT: u64 = 1024 * 1024;

/// The command `query` is ("/usage", typed alone): its name.
fn command_of(query: &str) -> Option<&'static str> {
    let name = query.trim().strip_prefix('/')?;
    [COMPACT].into_iter().chain(ON_THEIR_OWN).find(|c| c.eq_ignore_ascii_case(name))
}

/// Whether `query` is one of the commands Lumo runs for agy (chat.rs).
pub(crate) fn is_command(query: &str) -> bool {
    command_of(query).is_some()
}

/// A command's answer: agy's tab-separated table as Markdown, a row a line:
/// its first cell in bold, the others after it ("- **Remaining credits** · 0").
/// A link is a link, and a skill's description stops after its first sentence.
/// views/context-card.ts draws /usage's rows as a card.
fn command_text(response: &str) -> String {
    response
        .lines()
        .map(|l| l.split('\t').map(str::trim).filter(|c| !c.is_empty()).collect::<Vec<_>>())
        .filter_map(|r| match r.as_slice() {
            [] => None,
            [one] => Some(format!("- {one}")),
            [name, url] if url.starts_with("https://") && !url.contains(char::is_whitespace) => Some(format!("- [{name}]({url})")),
            [first, rest @ ..] => Some(format!("- **{first}** · {}", rest.iter().map(|c| first_sentence(c)).collect::<Vec<_>>().join(" · "))),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// A long text up to the end of its first sentence, or cut at a word.
fn first_sentence(text: &str) -> String {
    const MAX: usize = 140;
    if text.chars().count() <= MAX {
        return text.to_string();
    }
    let head: String = text.chars().take(MAX).collect();
    if let Some(end) = head.find(". ") {
        return head[..=end].to_string();
    }
    let cut = head.rfind(' ').unwrap_or(head.len());
    format!("{}…", head[..cut].trim_end())
}

/// The answer of a command run of its own: its `result`'s response, or the
/// error agy gave. Every other line of stdout is skipped.
fn command_answer(stdout: &str) -> Result<String, String> {
    let result = stdout
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
        .find(|v| v["event"] == "result")
        .map(|v| v["result"].clone())
        .ok_or_else(|| t("Antigravity CLI didn't answer."))?;
    if result["status"].as_str().is_some_and(|s| s.eq_ignore_ascii_case("error")) {
        return Err(result_error(result["error"].as_str().unwrap_or_default()));
    }
    Ok(command_text(result["response"].as_str().unwrap_or_default()))
}

/// Runs `agy --print /<name>` in `dir`, for at most COMMAND_TIMEOUT. Blocking.
fn run_on_its_own(exe: PathBuf, name: &str, dir: PathBuf) -> Result<String, String> {
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let slash = format!("/{name}");
    let mut cmd = Command::new(&exe);
    cmd.args(["--print", slash.as_str(), "--output-format", "stream-json"])
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    cmd.env("LUMO_ISLAND_RUN", "1");
    platform::no_console(&mut cmd);
    let mut child = cmd
        .spawn()
        .map_err(|e| tf("Cannot start Antigravity CLI: {error}", &[("error", &e.to_string())]))?;
    platform::chat_ends_with_lumo(&child);
    let reader = crate::antigravity_plan::Output::read(child.stdout.take(), MAX_COMMAND_OUTPUT);
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < COMMAND_TIMEOUT => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                kill_tree(&mut child);
                return Err(t("Antigravity CLI took too long and was stopped."));
            }
        }
    }
    command_answer(&reader.text_after_exit())
}

/// One of agy's commands typed in the chat: /compact in the conversation, the
/// others as a run of their own. The chat keeps the command and its answer.
async fn command(
    app: &AppHandle,
    chat: &Chat,
    exe: PathBuf,
    name: &'static str,
    model: &str,
    mode: &str,
    folder: Option<String>,
) -> Result<ChatReply, String> {
    let turn = chat.begin(PROVIDER);
    let query = format!("/{name}");
    let work = claude_code::work_dir();
    let answer = if name == COMPACT {
        let Some(conversation) = chat.cli_session_for(PROVIDER) else {
            // A new conversation would take it for a question.
            return Ok(ChatReply::answer(t("Send a message first: Antigravity CLI hasn't seen this conversation yet."), chat.cli_session()));
        };
        if !chat.cli_unseen(PROVIDER).is_empty() {
            // It would sum up the conversation without the turns another provider answered.
            return Ok(ChatReply::answer(t("Send a message first: Antigravity CLI hasn't seen the latest answers in this chat yet."), chat.cli_session()));
        }
        let inbox = crate::files::inbox_dir().to_string_lossy().to_string();
        let mut args = args(model, mode, Some(conversation.as_str()), &work.to_string_lossy(), &inbox, &chat.cli_dirs(folder));
        args.retain(|a| a != "--disable-slash-commands");
        let events = chat.events();
        let app2 = app.clone();
        let stop = chat.stopper();
        let chat_id = chat.id().to_string();
        let input = user_event(&query);
        let tell = chat_agents::teller(app, chat.id());
        let state = tauri::async_runtime::spawn_blocking(move || {
            run(exe, args, input, work, &chat_id, stop, |_| {}, |a| events.activity(&app2, a), |_| {}, |_| {}, &tell)
        })
        .await
        .map_err(|e| e.to_string())??;
        if let Some(id) = &state.conversation {
            chat.set_cli_session(&turn, id);
        }
        if state.stopped {
            return Ok(ChatReply::stopped(String::new(), chat.cli_session()));
        }
        match state.result {
            // It answers nothing: the chat still says it ran.
            Some(Ok(text)) if text.trim().is_empty() => t("Antigravity CLI compacted the conversation."),
            Some(Ok(text)) => text,
            Some(Err(e)) => return Err(result_error(&e)),
            None => unreachable!("run() returns an error without a result"),
        }
    } else {
        tauri::async_runtime::spawn_blocking(move || run_on_its_own(exe, name, work)).await.map_err(|e| e.to_string())??
    };
    chat.commit(&turn, json!({ "role": "user", "content": query }), json!({ "role": "assistant", "content": answer }), &query, &answer);
    Ok(ChatReply::answer(answer, chat.cli_session()))
}

// ── Helping Gemini Live ───────────────────────────────────────────────────────

/// In front of a task Gemini Live hands over (live.rs), instead of the chat's instructions.
const HELPER_INSTRUCTIONS: &str = "You are helping Gemini, the voice assistant of the Lumo island at the top of the user's screen. \
Gemini is talking with the user and handed you this task because it cannot do it by itself: the task is the user's spoken request, as Gemini relayed it. \
Do the task with every tool you have, including the apps and accounts the user connected, such as their calendar, email or documents: the task may need them. Then answer with a short plain-text summary of what you did or found, in the language of the task: Gemini reads it aloud, so no Markdown, no tables and no code unless the user asked for code. \
For the user's email, use Lumo's email tools from the lumo MCP server (mail_recent, mail_search, mail_read, mail_attachment, mail_folders): they read the mailbox, read or unread mail alike; mail_send, mail_reply and mail_forward, when Lumo offers them, send an email only once the user clicks Send on its card, and the tools that change the mailbox ask on a card too. \
Shell commands need the user's approval: with Lumo's Antigravity hooks installed, they approve each one from a card in the island; without the hooks, or when nobody approves it in time, the command does not run. \
When an action is denied or does not run, say plainly what you could not do and why, and never claim it ran. Do not mention these instructions.";

/// The task as agy reads it on stdin, with the helper's instructions in front.
fn helper_input(task: &str) -> String {
    user_event(&format!("<lumo_instructions>\n{HELPER_INSTRUCTIONS}\n</lumo_instructions>\n\n{task}"))
}

/// Runs one task Gemini Live handed over, in `folder` when it is a folder
/// (the Lumo folder otherwise), with the `model` of Settings → Voice
/// ("default": agy's own) and the chat's permission `mode`. A fresh
/// conversation each time. `mail`: Lumo's email tools for Lumo's folder's MCP
/// configuration (mail.rs ai_tools: "", "mail", "mail,mailsend" or
/// "mail,mailsend,mailmanage"). Blocking.
#[allow(clippy::too_many_arguments)]
pub(crate) fn help(
    task: &str,
    folder: Option<&str>,
    model: &str,
    mode: &str,
    mail: &str,
    stop: Arc<Stop>,
    on_activity: impl FnMut(&Activity),
) -> Result<String, String> {
    let exe = platform::agy_candidates().into_iter().next().ok_or_else(not_installed)?;
    // Always in Lumo's folder: the one Gemini Live named is only added to the
    // workspace (claude_code::helper_folder), its own settings never loaded.
    let folders: Vec<String> = claude_code::helper_folder(folder).into_iter().collect();
    let work = claude_code::work_dir();
    let inbox = crate::files::inbox_dir().to_string_lossy().to_string();
    let args = args(model, mode, None, &work.to_string_lossy(), &inbox, &folders);
    crate::computer::agy_workspace(&work, mail, crate::tools::any_enabled());
    let _mail = crate::mail::agent_turn();
    let state = run(exe, args, helper_input(task), work, "", stop, |_| {}, on_activity, |_| {}, |_| {}, &chat_agents::silent())?;
    if state.stopped {
        return Err(t("The task was stopped."));
    }
    match state.result {
        Some(Ok(text)) if text.trim().is_empty() => Ok(state.visible.trim().to_string()),
        Some(Ok(text)) => Ok(text),
        Some(Err(e)) => Err(result_error(&e)),
        None => unreachable!("run() returns an error without a result"),
    }
}

// ── Lumo's supervisor ─────────────────────────────────────────────────────────

/// One answer to `prompt` with `model`, for Lumo's supervisor (tool_review.rs):
/// a fresh conversation in plan mode, in a folder of its own, so it reads and
/// answers without running anything. Blocking.
pub(crate) fn complete(model: &str, prompt: &str) -> Result<String, String> {
    let exe = platform::agy_candidates().into_iter().next().ok_or_else(not_installed)?;
    let work = platform::local_dir().join("tool-review");
    let dir = work.to_string_lossy().to_string();
    let args = args_with_cards(model, "plan", None, &dir, &dir, &[], false);
    let state = run(exe, args, user_event(prompt), work, "", Arc::new(Stop::default()), |_| {}, |_| {}, |_| {}, |_| {}, &chat_agents::silent())?;
    match state.result {
        Some(Ok(text)) if text.trim().is_empty() => Ok(state.visible.trim().to_string()),
        Some(Ok(text)) => Ok(text),
        Some(Err(e)) => Err(result_error(&e)),
        None => Err(t("No response text.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agys_plan_names_the_chat_it_runs_for() {
        // Not the chat on screen when it comes: the user may have opened another meanwhile.
        let v = plan_event("chat-a", "update_plan", json!({ "plan": [{ "step": "Read", "status": "in_progress" }] }));
        assert_eq!(v["chat"], "chat-a");
        assert_eq!(v["agent"], "Antigravity CLI");
        assert_eq!(v["input"]["plan"][0]["step"], "Read");
    }

    #[test]
    fn once_the_answer_is_in_agy_is_ended_after_a_moment_or_at_once_on_stop() {
        let grace = claude_code::AFTER_RESULT;
        // No result yet: Stop has its own way out, and work goes on as long as it takes.
        assert!(!done_waiting(None, false, grace));
        assert!(!done_waiting(None, true, grace));
        let now = Instant::now();
        // The result just came: agy gets its moment to end by itself…
        assert!(!done_waiting(Some(now), false, grace));
        // …but Stop ends it at once (it used to be ignored after the result)…
        assert!(done_waiting(Some(now), true, grace));
        // …and so does the end of the moment, where it used to wait for ever.
        assert!(done_waiting(Some(now), false, Duration::ZERO));
        assert!(grace >= Duration::from_secs(5) && grace <= Duration::from_secs(30));
    }

    #[test]
    fn only_the_commands_agy_answers_headless_are_taken_alone() {
        assert_eq!(command_of("/usage"), Some("usage"));
        assert_eq!(command_of("  /Compact \n"), Some("compact"));
        assert_eq!(command_of("/credits"), Some("credits"));
        assert_eq!(command_of("/skills"), Some("skills"));
        assert_eq!(command_of("/context"), None, "it opens agy's terminal view");
        assert_eq!(command_of("/usage please"), None);
        assert_eq!(command_of("what is /usage?"), None);
        assert!(is_command("/usage") && !is_command("/model"));
    }

    #[test]
    fn a_command_run_of_its_own_answers_with_its_table_as_markdown() {
        let usage = concat!(
            r#"{"event":"command_result","command":{"name":"usage","data":{}}}"#,
            "\n",
            r#"{"event":"result","result":{"conversation_id":"","status":"SUCCESS","response":"Gemini Models\tWeekly Limit Remaining\t96%\t2026-10-28T22:06:14Z\nGemini Models\tFive Hour Limit Remaining\t97%\t2026-10-25T17:10:21Z\n"}}"#,
            "\n"
        );
        assert_eq!(
            command_answer(usage).unwrap(),
            "- **Gemini Models** · Weekly Limit Remaining · 96% · 2026-10-28T22:06:14Z\n- **Gemini Models** · Five Hour Limit Remaining · 97% · 2026-10-25T17:10:21Z"
        );
        let credits = r#"{"event":"result","result":{"status":"SUCCESS","response":"Remaining credits\t0\nUpgrade\thttps://antigravity.google/g1-upgrade\n"}}"#;
        assert_eq!(command_answer(credits).unwrap(), "- **Remaining credits** · 0\n- [Upgrade](https://antigravity.google/g1-upgrade)");
        let long = "Interactive guide to design and create a scheduled background automation. Use this skill when the user wants to create an automated or recurring scheduled task.";
        let skills = json!({ "event": "result", "result": { "status": "SUCCESS", "response": format!("automation\t{long}\n") } }).to_string();
        assert_eq!(command_answer(&skills).unwrap(), "- **automation** · Interactive guide to design and create a scheduled background automation.");
        let refused = r#"{"event":"result","result":{"status":"ERROR","response":"","error":"/usage is answered by the CLI itself"}}"#;
        assert!(command_answer(refused).is_err());
        assert!(command_answer("not json").is_err());
    }

    const CID: &str = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

    /// Without Lumo's hooks, whatever this computer has installed.
    fn args(model: &str, mode: &str, conversation: Option<&str>, work: &str, inbox: &str, folders: &[String]) -> Vec<String> {
        args_with_cards(model, mode, conversation, work, inbox, folders, false)
    }

    #[test]
    fn the_checklist_agy_writes_is_its_plan() {
        let text = "Ecco il piano:\n\n- [x] Creare la cartella\n- [ ] Scrivere game.py\n- [ ] Scrivere main.py\n\nInizio.";
        assert_eq!(checklist(text).as_deref(), Some("- [x] Creare la cartella\n- [ ] Scrivere game.py\n- [ ] Scrivere main.py"));
        // One line, or a plain list, is no plan.
        assert_eq!(checklist("- [ ] Only one"), None);
        assert_eq!(checklist("- a\n- b"), None);
    }

    #[test]
    fn the_plan_agy_gives_lumos_tool_is_passed_on_once() {
        assert!(is_plan_tool("mcp_lumo_update_plan") && is_plan_tool("lumo/update_plan"));
        assert!(!is_plan_tool("update_plan"), "not Lumo's");
        assert!(!is_plan_tool("mcp_lumo_mail_read"));
        assert!(INSTRUCTIONS.contains("update_plan"));
        let mut run = Run::default();
        let step = |index: u64, state: &str, params: &str| {
            format!(r#"{{"event":"step_update","step_index":{index},"state":"{state}","step_type":"tool","tool_info":{{"name":"mcp_lumo_update_plan","parameters":{params}}}}}"#)
        };
        let first = r#"{"plan":[{"step":"Read","status":"in_progress"},{"step":"Write","status":"pending"}]}"#;
        run.feed(step(2, "ACTIVE", first).as_bytes());
        assert_eq!(run.take_plan().unwrap()["plan"][0]["status"], "in_progress");
        // The same call again (its step said more, or ended): no news.
        run.feed(step(2, "ACTIVE", first).as_bytes());
        run.feed(step(2, "DONE", first).as_bytes());
        assert!(run.take_plan().is_none());
        // Its parameters as JSON text, as agy may give them.
        let next = serde_json::to_string(r#"{"plan":[{"step":"Read","status":"completed"},{"step":"Write","status":"in_progress"}]}"#).unwrap();
        run.feed(step(5, "ACTIVE", &next).as_bytes());
        assert_eq!(run.take_plan().unwrap()["plan"][1]["status"], "in_progress");
        // No steps, no plan.
        run.feed(step(6, "ACTIVE", r#"{"plan":[]}"#).as_bytes());
        assert!(run.take_plan().is_none());
    }

    #[test]
    fn with_lumos_cards_agys_own_confirmation_gives_way_except_in_plan_only() {
        let skips = |mode: &str, cards: bool| {
            args_with_cards("default", mode, None, "/w", "/inbox", &[], cards).contains(&"--dangerously-skip-permissions".to_string())
        };
        assert!(skips("auto", true));
        assert!(skips("default", true));
        assert!(!skips("plan", true), "Plan only keeps agy's own confirmation");
        assert!(skips("auto", false), "Auto is Antigravity's Turbo, cards or not");
        assert!(!skips("default", false), "Ask every time: never without the cards");
    }

    #[test]
    fn the_prompt_never_goes_on_the_command_line_and_odd_values_are_dropped() {
        let inbox = "C:\\Users\\me\\AppData\\Local\\com.rccrd12.lumo\\inbox";
        let a = args("gemini-3-pro", "default", Some(CID), "C:\\Users\\me\\Lumo", inbox, &[]);
        assert_eq!(
            &a[..7],
            ["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--print-timeout", "1440m"]
        );
        assert!(!a.iter().any(|s| s == "-p" || s == "--print"), "-p would swallow the next flag as the prompt: {a:?}");
        assert!(!a.contains(&"--effort".to_string()), "the model's name carries its effort: {a:?}");
        assert!(a.windows(2).any(|w| w == ["--model", "gemini-3-pro"]));
        assert!(a.windows(2).any(|w| w == ["--conversation", CID]));
        assert!(a.windows(2).any(|w| w == ["--add-dir", "C:\\Users\\me\\Lumo"]), "its own folder, not agy's scratch one");
        assert!(a.windows(2).any(|w| w == ["--add-dir", inbox]));
        assert!(!a.contains(&"--mode".to_string()), "default: agy's own request-review");
        assert!(!a.iter().any(|s| s.contains("dangerously")), "never skips permissions: {a:?}");

        let a = args("Gemini 3.1 Pro (High)", "", None, "/w", "/inbox", &["/home/me/My PDFs".into()]);
        assert!(a.windows(2).any(|w| w == ["--model", "Gemini 3.1 Pro (High)"]));
        assert!(a.windows(2).any(|w| w == ["--add-dir", "/home/me/My PDFs"]));
        assert!(!a.contains(&"--conversation".to_string()));

        let a = args("--dangerously-skip-permissions", "bypassPermissions", Some("x\" & calc"), "/w", "/inbox", &["C:\\A & calc".into()]);
        assert!(!a.iter().any(|s| s.contains("dangerously") || s.contains('&')), "{a:?}");
        assert!(!a.contains(&"--model".to_string()), "a flag is no model");
        assert!(!a.contains(&"--mode".to_string()), "nothing is let through wholesale");
        assert!(!a.contains(&"--conversation".to_string()));
        assert_eq!(a.iter().filter(|s| *s == "--add-dir").count(), 2, "its folder and the inbox: {a:?}");
        assert!(!args("default", "", None, "/w", "/inbox", &[]).contains(&"--model".to_string()), "Default: agy's own choice");
        assert_eq!(safe_model("gemini & calc"), None);
        assert_eq!(safe_model("100%"), None);
    }

    #[test]
    fn the_permission_mode_picked_in_the_chat_reaches_agy() {
        let mode = |m: &str| {
            let a = args("default", m, None, "/w", "/inbox", &[]);
            a.iter().position(|s| s == "--mode").map(|i| a[i + 1].clone())
        };
        assert_eq!(mode("auto"), None, "Turbo, not a mode");
        assert_eq!(mode("acceptEdits"), None);
        assert_eq!(mode("plan").as_deref(), Some("plan"));
        assert_eq!(mode("default"), None);
    }

    #[test]
    fn auto_lets_agy_run_everything() {
        for mode in ["auto", "acceptEdits", "turbo"] {
            for cards in [true, false] {
                let a = args_with_cards("default", mode, None, "/w", "/inbox", &[], cards);
                assert!(a.contains(&"--dangerously-skip-permissions".to_string()), "{mode} {a:?}");
                assert!(!a.contains(&"--sandbox".to_string()) && !a.contains(&"--mode".to_string()), "{a:?}");
            }
        }
        // Without the hooks, asking every time and planning keep agy's own confirmation.
        for mode in ["default", "plan", ""] {
            let a = args_with_cards("default", mode, None, "/w", "/inbox", &[], false);
            assert!(!a.iter().any(|s| s.contains("dangerously")), "{mode} {a:?}");
        }
        // Only those words: Claude Code's own words for letting everything through never do.
        let a = args_with_cards("default", "bypassPermissions", None, "/w", "/inbox", &[], false);
        assert!(!a.iter().any(|s| s.contains("dangerously")), "{a:?}");
    }

    #[test]
    fn the_answer_is_read_from_agys_nested_events() {
        // agy 1.2's real shape: each event's fields in an object named after it.
        let mut run = Run::default();
        let lines = [
            format!(r#"{{"event":"init","conversation_id":"{CID}","init":{{"model":"gemini-3.8-flash-low","permission_mode":"default"}}}}"#),
            r#"{"event":"step_update","step_update":{"step_index":0,"state":"DONE","step_type":"user_input"}}"#.to_string(),
            r#"{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Ciao! "}}"#.to_string(),
            r#"{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"Come posso aiutarti?\n"}}"#.to_string(),
            format!(r#"{{"event":"result","result":{{"status":"SUCCESS","response":"Ciao! Come posso aiutarti?","conversation_id":"{CID}","num_turns":1}}}}"#),
        ];
        for l in &lines {
            run.feed(l.as_bytes());
        }
        assert_eq!(run.visible, "Ciao! Come posso aiutarti?\n");
        assert_eq!(run.result, Some(Ok("Ciao! Come posso aiutarti?".to_string())));
        assert_eq!(run.conversation.as_deref(), Some(CID));

        // A tool refused: its step ends in ERROR, and that counts as a denial.
        let mut run = Run::default();
        run.feed(br#"{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls"}}}}"#);
        run.feed(br#"{"event":"step_update","step_update":{"step_index":2,"state":"ERROR","step_type":"tool","tool_info":{"name":"run_command","error":{"type":"denied","message":"permission check failed"}}}}"#);
        assert_eq!(run.denied, 1);
        assert!(run.pending.is_empty(), "an ERROR ends the step");
    }

    #[test]
    fn the_prompt_goes_in_as_one_user_event_with_the_instructions_first() {
        let line = user_event(&with_instructions("hello \"you\"\nthere"));
        assert!(line.ends_with('\n') && !line.trim_end().contains('\n'), "one line");
        let v: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(v["event"], "user");
        let content = v["message"]["content"].as_str().unwrap();
        assert!(content.starts_with("<lumo_instructions>\nYou are Lumo"));
        assert!(content.ends_with("</lumo_instructions>\n\nhello \"you\"\nthere"));
        assert!(INSTRUCTIONS.contains("press the screen button"), "agy asks, never captures");
        assert!(INSTRUCTIONS.contains("Always share the folder open in File Explorer"), "names the Settings switch");
        assert!(INSTRUCTIONS.contains("never claim it ran"), "a soft-denied action is said, not hidden");
        // The chat's rich blocks, in the workshop too.
        assert!(content.contains(crate::chat::rich_note!()));
        assert!(with_workshop_instructions("hi").contains(crate::chat::rich_note!()));
    }

    #[test]
    fn a_task_from_gemini_goes_in_with_the_helper_instructions() {
        let line = helper_input("Rename the photos in C:\\Pics");
        let v: Value = serde_json::from_str(line.trim_end()).unwrap();
        let content = v["message"]["content"].as_str().unwrap();
        assert!(content.starts_with("<lumo_instructions>\n"));
        assert!(content.contains(HELPER_INSTRUCTIONS));
        assert!(!content.contains(INSTRUCTIONS), "the chat's instructions are not the helper's");
        assert!(content.ends_with("</lumo_instructions>\n\nRename the photos in C:\\Pics"));
    }

    #[test]
    fn the_stream_gives_the_text_the_conversation_and_the_answer() {
        let mut run = Run::default();
        let lines = [
            r#"{"event":"init","cwd":"/home/me/Lumo","tools":["view_file"],"permission_mode":"default"}"#.to_string(),
            format!(r#"{{"event":"step_update","conversation_id":"{CID}","step_index":0,"state":"DONE","step_type":"user_input"}}"#),
            format!(r#"{{"event":"step_update","conversation_id":"{CID}","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Let me "}}"#),
            format!(r#"{{"event":"step_update","conversation_id":"{CID}","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"read it."}}"#),
            format!(r#"{{"event":"step_update","conversation_id":"{CID}","step_index":1,"state":"DONE","step_type":"agent_response"}}"#),
            format!(r#"{{"event":"step_update","conversation_id":"{CID}","step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"The PDF says hi."}}"#),
            "not json".into(),
            format!(
                r#"{{"event":"result","conversation_id":"{CID}","status":"SUCCESS","response":"The PDF says hi.","duration_seconds":2.5,"num_turns":1,"usage":{{"input_tokens":1200,"output_tokens":40,"thinking_tokens":10,"cache_read_tokens":0,"total_tokens":1250}}}}"#
            ),
        ];
        let mut changed = Vec::new();
        for l in &lines {
            changed.push(run.feed(l.as_bytes()));
        }
        assert_eq!(changed, [false, false, true, true, false, true, false, false]);
        assert_eq!(run.conversation.as_deref(), Some(CID));
        assert_eq!(run.visible, "The PDF says hi.", "a new response step replaces the one before");
        assert_eq!(run.result, Some(Ok("The PDF says hi.".into())));
        assert_eq!(run.denied, 0);
    }

    #[test]
    fn the_result_says_about_how_many_tokens_the_conversation_holds() {
        let mut run = Run::default();
        run.feed(br#"{"event":"result","result":{"status":"SUCCESS","response":"ok","usage":{"input_tokens":10050,"output_tokens":120,"thinking_tokens":30,"cache_read_tokens":9000,"total_tokens":10200}}}"#);
        assert_eq!(run.context_used, Some(10200));
        let mut bare = Run::default();
        bare.feed(br#"{"event":"result","result":{"status":"SUCCESS","response":"ok"}}"#);
        assert_eq!(bare.context_used, None);
    }

    #[test]
    fn a_failed_result_says_why() {
        let mut run = Run::default();
        run.feed(br#"{"event":"result","status":"ERROR","error":{"type":"INVALID_ARGUMENT","message":"unknown model: gemini-9"},"response":""}"#);
        assert_eq!(run.result, Some(Err("unknown model: gemini-9".into())));

        let mut run = Run::default();
        run.feed(br#"{"event":"result","status":"CANCELED","response":"half"}"#);
        assert_eq!(run.result, Some(Err("CANCELED".into())));

        let mut run = Run::default();
        run.feed(br#"{"event":"result","status":"ERROR","error":"authentication required"}"#);
        assert_eq!(result_error(run.result.unwrap().unwrap_err().as_str()), not_signed_in());
        assert_eq!(result_error("quota exceeded"), "Antigravity CLI: quota exceeded");

        // A conversation id that is not a UUID is never resumed.
        let mut run = Run::default();
        run.feed(br#"{"event":"result","conversation_id":"../../x","status":"SUCCESS","response":"ok"}"#);
        assert_eq!(run.conversation, None);
        assert_eq!(run.result, Some(Ok("ok".into())));
    }

    #[test]
    fn no_result_is_explained_and_a_missing_sign_in_says_so() {
        assert_eq!(failure("Error: authentication required. Run agy to sign in.\n", "1"), not_signed_in());
        assert_eq!(failure("starting\nboom: disk full\n\n", "2"), "Antigravity CLI: boom: disk full");
        assert!(failure("", "3").contains("(exit 3)"));
        assert!(not_installed().contains(INSTALL));
        assert!(not_installed().contains("`agy`"));
    }

    #[test]
    fn each_tool_says_what_it_does_with_names_never_paths_or_commands() {
        let a = |name: &str, params: Value| activity_for(name, &params);
        assert_eq!(a("view_file", json!({"AbsolutePath": "C:\\Users\\me\\Docs\\report.pdf"})), Activity::new("read", "report.pdf"));
        assert_eq!(a("view_file", json!({})), Activity::new("read", ""), "before the parameters are known");
        assert_eq!(
            a("view_file", json!({"AbsolutePath": "/home/me/.local/share/Lumo/inbox/screenshot-2026-10-09-101500-screen1.png"})),
            Activity::new("screen", ""),
            "Lumo's own screenshots are the screen"
        );
        assert_eq!(a("list_dir", json!({"DirectoryPath": "/home/me"})), Activity::new("search", ""));
        assert_eq!(a("grep_search", json!({"Query": "fn main", "SearchPath": "/src"})), Activity::new("search", "fn main"));
        assert_eq!(a("find_by_name", json!({"Pattern": "*.pdf"})), Activity::new("search", "*.pdf"));
        assert_eq!(a("run_command", json!({"CommandLine": "rm -rf /tmp/x"})), Activity::new("command", ""), "the command itself stays out");
        assert_eq!(a("write_to_file", json!({"TargetFile": "/work/src/main.rs"})), Activity::new("edit", "main.rs"));
        assert_eq!(a("replace_file_content", json!({"TargetFile": "D:\\nb\\notes.md"})), Activity::new("edit", "notes.md"));
        assert_eq!(a("search_web", json!({"query": "weather"})), Activity::new("web", ""));
        assert_eq!(a("read_url_content", json!({"Url": "https://user:pw@www.example.com:8080/a?b"})), Activity::new("read", "example.com"));
        assert_eq!(a("read_url_content", json!({})), Activity::new("web", ""));
        assert_eq!(a("browser_subagent", json!({})), Activity::new("subtask", ""));
        assert_eq!(a("take_screenshot", json!({})), Activity::new("screen", ""));
        assert_eq!(a("generate_image", json!({})), Activity::new("tool", "generate image"));
        assert_eq!(a("", json!({})), Activity::thinking());
        // Parameters sent as the JSON text of an object read the same.
        assert_eq!(a("view_file", json!("{\"AbsolutePath\":\"/a/b/c.txt\"}")), Activity::new("read", "c.txt"));
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
    fn the_stream_says_what_agy_is_doing_until_the_text_shows() {
        let mut run = Run::default();
        let seen = activities(
            &mut run,
            &[
                r#"{"event":"step_update","step_index":0,"state":"DONE","step_type":"user_input"}"#,
                r#"{"event":"step_update","step_index":1,"state":"ACTIVE","step_type":"agent_response"}"#,
                r#"{"event":"step_update","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"C:\\Users\\me\\report.pdf"}}}"#,
                // Said again: nothing new.
                r#"{"event":"step_update","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"C:\\Users\\me\\report.pdf"}}}"#,
                r#"{"event":"step_update","step_index":2,"state":"DONE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","output":"..."}}"#,
                r#"{"event":"step_update","step_index":3,"state":"DONE","step_type":"checkpoint"}"#,
            ],
        );
        assert_eq!(seen, vec![Activity::thinking(), Activity::new("read", "report.pdf"), Activity::thinking()]);

        // Text: the activity goes; two tools at once, thinking again once both are done.
        let seen = activities(
            &mut run,
            &[
                r#"{"event":"step_update","step_index":4,"state":"ACTIVE","step_type":"agent_response","text_delta":"Let me check."}"#,
                r#"{"event":"step_update","step_index":5,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls"}}}"#,
                r#"{"event":"step_update","step_index":6,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"search_web","parameters":{"query":"x"}}}"#,
                r#"{"event":"step_update","step_index":6,"state":"DONE","step_type":"tool","tool_info":{"name":"search_web"}}"#,
                r#"{"event":"step_update","step_index":5,"state":"DONE","step_type":"tool","tool_info":{"name":"run_command","error":{"type":"PERMISSION_DENIED","message":"run_command needs approval"}}}"#,
                r#"{"event":"step_update","step_index":7,"state":"ACTIVE","step_type":"tool","subagent_info":{"conversation_id":"x"}}"#,
            ],
        );
        assert_eq!(run.visible, "Let me check.");
        assert_eq!(
            seen,
            vec![Activity::new("command", ""), Activity::new("web", ""), Activity::new("command", ""), Activity::thinking(), Activity::new("subtask", "")],
        );
        assert_eq!(run.denied, 1, "the command was soft-denied");
        assert_eq!(run.pending.len(), 1);
    }

    #[test]
    fn soft_denials_on_stderr_are_counted() {
        assert_eq!(stderr_denials("Tool run_command denied: requires approval\nok\nPermission required for tool write_to_file\n"), 2);
        assert_eq!(stderr_denials("warning: unrecognized event skipped\n"), 0);
    }

    #[test]
    fn an_empty_answer_says_what_agy_said_rather_than_guessing() {
        let tail = stderr_tail("\n a\nb\n\nTool run_command denied: requires approval\nquota exceeded for gemini-3.8-pro\n");
        assert_eq!(tail, "b · Tool run_command denied: requires approval · quota exceeded for gemini-3.8-pro");
        assert!(empty_answer(1, &tail).contains("quota exceeded"), "the real reason, not a guess");
        assert!(empty_answer(1, "").contains("permission"));
        assert_eq!(empty_answer(0, ""), "Antigravity CLI gave no answer.");
    }

    #[test]
    fn the_models_are_read_off_whatever_agy_models_prints() {
        let text = "Available models:\n  gemini-3-pro (current)\n  gemini-3-flash\n* claude-opus-4-6\n\nUse --model <slug> to pick one.\n";
        assert_eq!(parse_models(text), ["gemini-3-pro", "gemini-3-flash", "claude-opus-4-6"]);
        let table = "MODEL            NAME\ngemini-3.1-pro   Gemini 3.1 Pro\ngpt-oss-120b\tGPT-OSS 120B\n";
        assert_eq!(parse_models(table), ["gemini-3.1-pro", "gpt-oss-120b"]);
        assert_eq!(parse_models("Gemini 3.1 Pro (High)\nClaude Opus 4.6 (Thinking)\n"), ["Gemini 3.1 Pro (High)", "Claude Opus 4.6 (Thinking)"]);
        assert_eq!(parse_models(r#"[{"id":"gemini-3-pro","name":"Gemini 3 Pro"},"gemini-3-flash"]"#), ["gemini-3-pro", "gemini-3-flash"]);
        assert_eq!(parse_models(r#"{"models":[{"slug":"gemini-3-pro"}]}"#), ["gemini-3-pro"]);
        assert_eq!(parse_models("--evil-1\ngemini-3 & calc\n"), Vec::<String>::new());
        assert!(parse_models("").is_empty());
    }

    #[test]
    fn the_files_a_step_read_or_wrote_are_told_once_it_finished() {
        let mut run = Run::default();
        let step = |i: u64, state: &str, name: &str, params: &str| {
            format!(r#"{{"event":"step_update","step_update":{{"step_index":{i},"state":"{state}","step_type":"tool","tool_info":{{"name":"{name}","parameters":{params}}}}}}}"#)
        };
        run.feed(step(1, "ACTIVE", "view_file", r#"{"AbsolutePath":"C:\\Docs\\report.pdf"}"#).as_bytes());
        run.feed(step(2, "ACTIVE", "write_to_file", r#"{"TargetFile":"C:\\lumo-nowhere\\main.rs"}"#).as_bytes());
        run.feed(step(3, "ACTIVE", "replace_file_content", r#"{"TargetFile":"D:\\nb\\notes.md"}"#).as_bytes());
        run.feed(step(4, "ACTIVE", "read_url_content", r#"{"Url":"https://example.com/a.txt"}"#).as_bytes());
        assert!(run.take_files().is_empty(), "not before they finished");
        run.feed(step(1, "DONE", "view_file", "{}").as_bytes());
        run.feed(step(2, "DONE", "write_to_file", "{}").as_bytes());
        run.feed(step(3, "ERROR", "replace_file_content", "{}").as_bytes());
        run.feed(step(4, "DONE", "read_url_content", "{}").as_bytes());
        assert_eq!(
            run.take_files(),
            vec![
                FileTouch { kind: "read", path: r"C:\Docs\report.pdf".into() },
                FileTouch { kind: "created", path: r"C:\lumo-nowhere\main.rs".into() },
            ]
        );
        assert!(run.take_files().is_empty(), "once");
    }

    /// agy 1.5.8's stream for "start two subagents" (a probe run), and what
    /// one of them wrote in its transcript.
    const SPAWN_A: &str = r#"{"event":"step_update","step_update":{"conversation_id":"main-1","step_index":2,"state":"ACTIVE","step_type":"subagent","tool_name":"invoke_subagent","subagent_info":{"subagents":[{"type_name":"self","role":"Writer A","initial_prompt":"Create a.txt"}]}}}"#;
    const SPAWN_B: &str = r#"{"event":"step_update","step_update":{"conversation_id":"main-1","step_index":3,"state":"ACTIVE","step_type":"subagent","tool_name":"invoke_subagent","subagent_info":{"subagents":[{"type_name":"self","role":"Writer B","initial_prompt":"Create b.txt"}]}}}"#;
    const TRANSCRIPT_A: &str = concat!(
        r#"{"step_index":0,"source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE","content":"[Message] sender=main-1 content=Create a.txt"}"#, "\n",
        r#"{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","input_tokens":10148,"output_tokens":290,"thinking":"Targeting file creation","tool_calls":[{"name":"write_file","args":{"Content":"\"hello\"","Overwrite":"true","Path":"\"C:\\\\work\\\\a.txt\""}}]}"#, "\n",
        r#"{"step_index":2,"source":"MODEL","type":"GENERIC","status":"DONE","content":"Created file."}"#, "\n",
        r#"{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","input_tokens":2408,"cache_read_tokens":8106,"tool_calls":[{"name":"send_message","args":{"Message":"\"File a.txt has been created.\"","Recipient":"\"main-1\""}}]}"#, "\n",
        r#"{"step_index":4,"source":"MODEL","type":"GENERIC","status":"DONE","content":"Message sent to \"main-1\"."}"#, "\n",
        r#"{"step_index":5,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","output_tokens":24,"content":"Completed creating a.txt and sent confirmation back to caller."}"#, "\n",
    );

    fn done_with(line: &str, log: &str) -> String {
        line.replace(r#""state":"ACTIVE""#, r#""state":"DONE""#).replace(r#""initial_prompt""#, &format!(r#""log_uri":"{log}","conversation_id":"sub","initial_prompt""#))
    }

    #[test]
    fn each_subagent_agy_starts_is_a_row_named_by_its_role() {
        let mut run = Run::default();
        assert!(!run.feed(SPAWN_A.as_bytes()));
        assert_eq!(run.take_activity(), Some(Activity::new("subtask", "")));
        run.feed(SPAWN_B.as_bytes());
        run.feed(SPAWN_A.as_bytes());
        let rows = run.subagents.agents.changed();
        assert_eq!(rows.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), ["Writer A", "Writer B"]);
        assert!(rows.iter().all(|r| r.state == AgentState::Working && r.source == PROVIDER && r.steps == 0));
        // Done at once (they are started): the rows go on.
        run.feed(done_with(SPAWN_A, "file:///C:/Users/me/.gemini/antigravity-cli/brain/sub/.system_generated/logs/transcript.jsonl").as_bytes());
        assert_eq!(run.subagents.agents.open(), 2);
        assert_eq!(run.subagents.spawns[0].log, Some(PathBuf::from(r"C:\Users\me\.gemini\antigravity-cli\brain\sub\.system_generated\logs\transcript.jsonl")));
        run.feed(done_with(SPAWN_B, "file:///C:/Users/me/.gemini/antigravity-cli/brain/sub-b/.system_generated/logs/transcript.jsonl").as_bytes());
        // Both started: the answer coordinates them, it doesn't think.
        assert_eq!(run.take_activity(), Some(Activity::new("subtask", "")));
        // A subagent's message wakes the answer: still so.
        run.feed(br#"{"event":"step_update","step_update":{"step_index":5,"state":"DONE","step_type":"system_message"}}"#);
        assert_eq!(run.take_activity(), None, "unchanged");
        // A start that failed: that row fails, never Done with the turn.
        run.feed(SPAWN_B.replace(r#""step_index":3"#, r#""step_index":7"#).replace(r#""state":"ACTIVE""#, r#""state":"ERROR""#).replace("Writer B", "Writer C").as_bytes());
        let c = run.subagents.agents.changed().into_iter().find(|r| r.title == "Writer C").unwrap();
        assert_eq!(c.state, AgentState::Failed);
        run.subagents.run_ended(AgentState::Done);
        assert_eq!(run.subagents.agents.open(), 0);
    }

    #[test]
    fn only_agys_own_transcript_is_read() {
        assert_eq!(transcript_path("file:///C:/Users/me/.gemini/antigravity-cli/brain/x/.system_generated/logs/transcript.jsonl"), Some(PathBuf::from(r"C:\Users\me\.gemini\antigravity-cli\brain\x\.system_generated\logs\transcript.jsonl")));
        assert_eq!(transcript_path("file:///home/me/.gemini/antigravity-cli/brain/x/logs/transcript.jsonl"), Some(PathBuf::from("/home/me/.gemini/antigravity-cli/brain/x/logs/transcript.jsonl")));
        assert_eq!(transcript_path("file:///C:/Users/My%20Name/.gemini/antigravity-cli/b/transcript.jsonl"), Some(PathBuf::from(r"C:\Users\My Name\.gemini\antigravity-cli\b\transcript.jsonl")));
        for other in ["file:////host/share/.gemini/antigravity-cli/x/transcript.jsonl", "file://host/.gemini/antigravity/x/transcript.jsonl", "file:///C:/Users/me/secrets.txt", "file:///C:/Users/me/.gemini/antigravity-cli/../../x/transcript.jsonl", "https://x/.gemini/antigravity/transcript.jsonl", "C:/a/.gemini/antigravity/transcript.jsonl"] {
            assert_eq!(transcript_path(other), None, "{other}");
        }
    }

    #[test]
    fn a_subagents_transcript_gives_its_steps_its_files_and_its_report() {
        let mut row = AgentRow::new("r", PROVIDER, "Writer A");
        let (mut report, mut pending, mut files) = (None, Vec::new(), Vec::new());
        let lines: Vec<Value> = TRANSCRIPT_A.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        let mut ended = Vec::new();
        for (i, l) in lines.iter().enumerate() {
            ended.push(transcript_line(&mut row, &mut report, &mut pending, &mut files, l));
            if i == 1 {
                assert!(files.is_empty(), "not before the call's result");
            }
        }
        assert_eq!(ended, [false, false, false, false, false, true]);
        assert_eq!(row.steps, 2);
        assert_eq!(row.tokens, Some(10_514));
        assert_eq!(files, vec![FileTouch { kind: "created", path: r"C:\work\a.txt".into() }]);
        assert_eq!(report.as_deref(), Some("File a.txt has been created."));
        assert_eq!(row.summary.as_deref(), Some("File a.txt has been created."), "what it told its parent");
        // A write that failed lists nothing; a line whose calls were cut is a step, never its answer.
        let (mut row, mut report, mut pending, mut files) = (AgentRow::new("r", PROVIDER, "W"), None, Vec::new(), Vec::new());
        {
            let mut feed = |l: &str| transcript_line(&mut row, &mut report, &mut pending, &mut files, &serde_json::from_str(l).unwrap());
            assert!(!feed(&lines_of(1)));
            assert!(!feed(r#"{"source":"MODEL","type":"GENERIC","status":"DONE","content":"Error: file already exists"}"#));
            assert!(!feed(r#"{"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"I'll write the renderer now.","truncated_fields":["tool_calls"]}"#));
        }
        assert!(files.is_empty());
        assert_eq!(row.steps, 2);
        assert!(!row.state.is_final());
    }

    fn lines_of(i: usize) -> String {
        TRANSCRIPT_A.lines().nth(i).unwrap().to_string()
    }

    #[test]
    fn the_transcripts_are_read_as_they_grow_and_their_files_reach_the_chat() {
        let dir = std::env::temp_dir().join(format!("lumo-agy-{}", chat_agents::run_mark())).join(".gemini").join("antigravity-cli").join("brain").join("sub");
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("transcript.jsonl");
        let (first, rest) = TRANSCRIPT_A.split_at(TRANSCRIPT_A.find("{\"step_index\":3").unwrap());
        // Half a line written yet: read once whole.
        std::fs::write(&log, format!("{first}{}", &rest[..40])).unwrap();
        let mut run = Run::default();
        run.feed(SPAWN_A.as_bytes());
        let uri = format!("file:///{}", log.to_string_lossy().replace('\\', "/").trim_start_matches('/'));
        run.feed(done_with(SPAWN_A, &uri).as_bytes());
        assert!(run.subagents.read_transcripts().0);
        let id = run.subagents.spawns[0].row.clone();
        assert_eq!(run.subagents.agents.get(&id).unwrap().steps, 1);
        assert_eq!(run.take_files(), vec![FileTouch { kind: "created", path: r"C:\work\a.txt".into() }]);
        assert_eq!(run.subagents.read_transcripts(), (false, false), "nothing new");
        std::fs::write(&log, TRANSCRIPT_A).unwrap();
        assert!(run.subagents.read_transcripts().0);
        let row = run.subagents.agents.get(&id).unwrap();
        assert_eq!((row.state, row.steps), (AgentState::Done, 2));
        assert!(!run.subagents.spawns_open());
        assert!(run.take_files().is_empty(), "each file once");
        let _ = std::fs::remove_dir_all(dir.parent().unwrap().parent().unwrap().parent().unwrap());
    }

    #[test]
    fn agys_own_files_are_not_the_chats() {
        let read = |p: &str| touch_for("view_file", &json!({ "AbsolutePath": p }));
        assert_eq!(read(r"C:\Users\me\.gemini\antigravity-cli\mcp\lumo\update_plan.json"), None);
        assert_eq!(read("/home/me/.gemini/antigravity/brain/x.md"), None);
        assert!(read(r"C:\Users\me\slither-io\index.html").is_some());
    }

    #[test]
    fn a_subagent_agy_delegates_to_is_a_row_done_when_its_step_is() {
        let mut run = Run::default();
        let lines = [
            r#"{"event":"step_update","step_index":3,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"browser_subagent","parameters":"{\"TaskName\":\"Check the pricing page\",\"Task\":\"Open the site\"}"}}"#,
            r#"{"event":"step_update","step_index":0,"state":"ACTIVE","step_type":"agent_response","subagent_info":{"conversation_id":"sub-1"}}"#,
            r#"{"event":"step_update","step_index":1,"state":"ACTIVE","step_type":"tool","subagent_info":{"conversation_id":"sub-1"},"tool_info":{"name":"read_url_content","parameters":{"Url":"https://www.example.com/pricing"}}}"#,
            // Said again, and done: one step.
            r#"{"event":"step_update","step_index":1,"state":"ACTIVE","step_type":"tool","subagent_info":{"conversation_id":"sub-1"},"tool_info":{"name":"read_url_content","parameters":{"Url":"https://www.example.com/pricing"}}}"#,
            r#"{"event":"step_update","step_index":1,"state":"DONE","step_type":"tool","subagent_info":{"conversation_id":"sub-1"},"tool_info":{"name":"read_url_content"}}"#,
        ];
        for l in lines {
            run.feed(l.as_bytes());
        }
        let rows = run.subagents.agents.changed();
        assert_eq!(rows.len(), 1);
        let a = run.subagents.agents.get("sub-1").unwrap();
        assert_eq!((a.title.as_str(), a.source.as_str(), a.state), ("Check the pricing page", PROVIDER, AgentState::Working));
        assert_eq!(a.steps, 1);
        assert_eq!(a.now, Some(Activity::new("read", "example.com")));
        assert!(!a.can_stop);
        // The step that delegated is done: so is its subagent.
        run.feed(br#"{"event":"step_update","step_index":3,"state":"DONE","step_type":"tool","tool_info":{"name":"browser_subagent","output":"..."}}"#);
        assert_eq!(run.subagents.agents.get("sub-1").unwrap().state, AgentState::Done);
        assert!(run.subagents.delegating.is_empty());

        // One with no conversation is named by its step; an ERROR fails it with the tool's error.
        let mut run = Run::default();
        run.feed(br#"{"event":"step_update","step_index":5,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"delegate_task","parameters":{}}}"#);
        run.feed(br#"{"event":"step_update","step_index":0,"state":"ACTIVE","step_type":"tool","subagent_info":{},"tool_info":{"name":"run_command","parameters":{}}}"#);
        let id = run.subagents.agents.changed()[0].id.clone();
        assert!(id.starts_with("step-5-"), "{id}");
        assert_eq!(run.subagents.agents.get(&id).unwrap().title, "delegate task");
        run.feed(br#"{"event":"step_update","step_index":5,"state":"ERROR","step_type":"tool","tool_info":{"name":"delegate_task","error":{"type":"FAILED","message":"Browser crashed"}}}"#);
        let a = run.subagents.agents.get(&id).unwrap();
        assert_eq!((a.state, a.error.as_deref()), (AgentState::Failed, Some("Browser crashed")));
    }

    #[test]
    fn two_delegations_at_once_each_name_and_end_their_own_subagent() {
        let delegate = |index: u64, task: &str| format!(r#"{{"event":"step_update","step_index":{index},"state":"ACTIVE","step_type":"tool","tool_info":{{"name":"browser_subagent","parameters":{{"TaskName":"{task}"}}}}}}"#);
        let sub_step = |info: &str| format!(r#"{{"event":"step_update","step_index":0,"state":"ACTIVE","step_type":"tool","subagent_info":{info},"tool_info":{{"name":"run_command","parameters":{{}}}}}}"#);
        let done = |index: u64| format!(r#"{{"event":"step_update","step_index":{index},"state":"DONE","step_type":"tool","tool_info":{{"name":"browser_subagent"}}}}"#);

        // With no conversation: the id, the title and the end come from the same step.
        let mut run = Run::default();
        for l in [delegate(3, "Pricing"), delegate(4, "Docs"), sub_step("{}"), sub_step("{}")] {
            run.feed(l.as_bytes());
        }
        let rows = run.subagents.agents.changed();
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert!(rows[0].id.starts_with("step-3-") && rows[1].id.starts_with("step-4-"), "{rows:?}");
        assert_eq!((rows[0].title.as_str(), rows[1].title.as_str()), ("Pricing", "Docs"));
        run.feed(done(3).as_bytes());
        assert_eq!(run.subagents.agents.get(&rows[0].id).unwrap().state, AgentState::Done);
        assert_eq!(run.subagents.agents.get(&rows[1].id).unwrap().state, AgentState::Working, "step 4 still runs");

        // With their conversations: each delegation has one subagent, and ends only it.
        let mut run = Run::default();
        for l in [delegate(3, "Pricing"), delegate(4, "Docs"), sub_step(r#"{"conversation_id":"a"}"#), sub_step(r#"{"conversation_id":"b"}"#), sub_step(r#"{"conversation_id":"a"}"#)] {
            run.feed(l.as_bytes());
        }
        run.feed(done(4).as_bytes());
        let (a, b) = (run.subagents.agents.get("a").unwrap(), run.subagents.agents.get("b").unwrap());
        assert_eq!((a.title.as_str(), a.state), ("Pricing", AgentState::Working));
        assert_eq!((b.title.as_str(), b.state), ("Docs", AgentState::Done));
    }

    #[test]
    fn a_subagent_named_by_its_step_is_another_one_in_the_next_turn() {
        // Two turns, each delegating at step 5 to a subagent with no
        // conversation, and one with neither: four rows, never the same id.
        let ids = |run: &mut Run| {
            run.feed(br#"{"event":"step_update","step_index":5,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"delegate_task","parameters":{}}}"#);
            run.feed(br#"{"event":"step_update","step_index":0,"state":"ACTIVE","step_type":"tool","subagent_info":{},"tool_info":{"name":"run_command"}}"#);
            run.feed(br#"{"event":"step_update","step_index":5,"state":"DONE","step_type":"tool","tool_info":{"name":"delegate_task"}}"#);
            run.subagents.step(0, false, &json!({ "step_type": "tool", "subagent_info": {} }));
            run.subagents.agents.changed().into_iter().map(|r| r.id).collect::<Vec<_>>()
        };
        let first = ids(&mut Run::default());
        let second = ids(&mut Run::default());
        assert_eq!((first.len(), second.len()), (2, 2), "{first:?} {second:?}");
        assert!(first[0].starts_with("step-5-") && first[1].starts_with("subagent-"));
        assert!(first.iter().all(|id| !second.contains(id)), "{first:?} {second:?}");
    }

    #[test]
    fn a_subagent_still_open_when_the_turn_ends_ends_with_it() {
        let mut sub = Subagents::default();
        sub.step(0, false, &json!({ "step_type": "tool", "subagent_info": { "conversation_id": "a" }, "tool_info": { "name": "view_file" } }));
        sub.step(0, false, &json!({ "step_type": "tool", "subagent_info": { "conversation_id": "b" }, "tool_info": { "name": "view_file" } }));
        assert_eq!(sub.agents.get("a").unwrap().title, "Agent", "no step named it");
        sub.agents.touch("a").unwrap().end(AgentState::Done, None);
        sub.run_ended(AgentState::Failed);
        assert_eq!(sub.agents.get("a").unwrap().state, AgentState::Done);
        let b = sub.agents.get("b").unwrap();
        assert_eq!((b.state, b.error.as_deref()), (AgentState::Failed, Some("Antigravity CLI ended")));
        let mut sub = Subagents::default();
        sub.step(0, false, &json!({ "step_type": "tool", "subagent_info": { "conversation_id": "c" } }));
        sub.run_ended(AgentState::Done);
        assert!(sub.agents.get("c").unwrap().error.is_none());
    }
}
