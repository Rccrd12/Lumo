// Chat through Claude Code itself: the `claude` CLI the user installed and
// signed in to with their own Claude plan (Pro, Max…). No API key: Lumo runs
// the unmodified binary as `claude -p`, and Claude Code answers with its own
// sign-in, exactly as in a terminal. Lumo never reads, stores or forwards any
// Claude credential.
//
// Unlike the other providers, Claude Code can act: read a dropped PDF or image,
// read and edit files, run commands, search the web. Every action that needs a
// permission goes through Claude Code's own PermissionRequest hook — the one
// Lumo already installs — so it shows up in the island as the usual
// Allow / Deny card. Without the hooks, or with nobody clicking, Claude Code
// denies the action: `-p` never allows anything on its own.
//
// The prompt goes in on stdin, never on the command line: an npm install is a
// `claude.cmd`, and cmd.exe would interpret what the user typed. Every argument
// is fixed or checked.
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

/// A turn can wait on the user's Allow / Deny clicks, so it gets a long while.
const TURN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
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
Every action that needs a permission is approved by the user in the island, so ask for it normally. ",
    crate::chat::timer_note!()
);

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
/// nothing. Anything else — `bypassPermissions`, `dontAsk`, a typo — is
/// "default": nothing is ever allowed wholesale.
pub(crate) fn permission_mode(raw: &str) -> &'static str {
    match raw.trim() {
        "auto" | "acceptEdits" => "auto",
        "plan" => "plan",
        _ => "default",
    }
}

/// The command-line arguments, all fixed or checked. The prompt is not one of them.
/// `folders`: what the user shared from File Explorer in this chat.
fn args(model: &str, effort: &str, mode: &str, session: Option<&str>, inbox: &str, folders: &[String]) -> Vec<String> {
    args_with(APPEND_PROMPT, model, effort, mode, session, inbox, folders)
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
        "--append-system-prompt",
        append,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
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
        "Bash" | "PowerShell" => Activity::new("command", ""),
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => Activity::new("edit", file_name(&field(&["file_path", "notebook_path"]))),
        "WebSearch" | "web_search" => Activity::new("web", ""),
        "WebFetch" | "web_fetch" => match host(&field(&["url"])) {
            h if h.is_empty() => Activity::new("web", ""),
            h => Activity::new("read", h),
        },
        "Task" | "Agent" => Activity::new("subtask", ""),
        "TodoWrite" | "TodoRead" | "EnterPlanMode" | "ExitPlanMode" => Activity::new("plan", ""),
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
    /// The Claude plan's limits this turn reported (`rate_limit_event`), in the
    /// status line's shape: `five_hour` / `seven_day` → `used_percentage`, `resets_at`.
    rate_limits: serde_json::Map<String, Value>,
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

impl Run {
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
            // The whole message, with the tool inputs complete.
            Some("assistant") if top_level(&v) => {
                for block in v["message"]["content"].as_array().into_iter().flatten() {
                    if matches!(block["type"].as_str(), Some("tool_use" | "server_tool_use")) {
                        let name = block["name"].as_str().unwrap_or("");
                        let id = block["id"].as_str().unwrap_or("").to_string();
                        self.started_tool(id, activity_for(name, &block["input"]));
                    }
                }
                false
            }
            // Tool results: once every call is answered, Claude thinks again.
            Some("user") if top_level(&v) => {
                let mut answered = false;
                for block in v["message"]["content"].as_array().into_iter().flatten() {
                    if block["type"] == "tool_result" {
                        let id = block["tool_use_id"].as_str().unwrap_or("");
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

/// Runs `claude -p` once in `dir`, blocking. `on_text` gets the visible text as
/// it grows, `on_activity` what Claude Code is doing each time it changes.
/// Stop ends the CLI and its children; the run so far is returned, `stopped`.
fn run(
    exe: PathBuf,
    args: Vec<String>,
    input: String,
    dir: PathBuf,
    stop: Arc<Stop>,
    mut on_text: impl FnMut(&str),
    mut on_activity: impl FnMut(&Activity),
) -> Result<Run, String> {
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let mut cmd = Command::new(&exe);
    cmd.args(&args).current_dir(&dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // An npm install is a script that needs its own Node: its folder first on PATH.
    if let Some(parent) = exe.parent() {
        let mut dirs = vec![parent.to_path_buf()];
        if let Some(path) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&path));
        }
        if let Ok(joined) = std::env::join_paths(dirs) {
            cmd.env("PATH", joined);
        }
    }
    // Tells lumo-hook this run is the island's chat, not a session to show.
    cmd.env("LUMO_ISLAND_RUN", "1");
    platform::no_console(&mut cmd);
    // Its own process group, so Stop ends the tools and hooks it started too.
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| tf("Cannot start Claude Code: {error}", &[("error", &e.to_string())]))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input.as_bytes());
        // Dropping stdin ends the prompt.
    }
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take();
    let err_text = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = stderr {
            let mut e = e;
            let _ = (&mut e).take(64 * 1024).read_to_string(&mut s);
            // Past the cap, keep the pipe flowing: a full one would stall claude.
            let _ = std::io::copy(&mut e, &mut std::io::sink());
        }
        s
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
                    if total > MAX_TOTAL || tx.send(line).is_err() {
                        break;
                    }
                }
            }
        }
        // Whatever is left is read and dropped, so claude never blocks on a
        // full pipe while the turn winds down.
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
    });

    let started = Instant::now();
    let mut last_emit = Instant::now() - DELTA_INTERVAL;
    // Text the island was not shown yet (it is told at most every DELTA_INTERVAL).
    let mut unsent = false;
    let mut state = Run::default();
    let mut timed_out = false;
    loop {
        if stop.is_stopped() && state.result.is_none() {
            kill_tree(&mut child);
            state.stopped = true;
            return Ok(state);
        }
        let left = TURN_TIMEOUT.saturating_sub(started.elapsed());
        if left.is_zero() {
            timed_out = true;
            break;
        }
        // Short waits, so Stop is felt at once (only while a turn runs).
        match rx.recv_timeout(left.min(STOP_POLL)) {
            Ok(line) => {
                unsent |= state.feed(&line);
                let activity = state.take_activity();
                // What was written goes before what is done next, in order.
                if unsent && (activity.is_some() || last_emit.elapsed() >= DELTA_INTERVAL) {
                    unsent = false;
                    last_emit = Instant::now();
                    on_text(&state.visible);
                }
                if let Some(activity) = activity {
                    on_activity(&activity);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    if timed_out {
        kill_tree(&mut child);
        return Err(t("Claude Code took too long and was stopped."));
    }
    let status = child.wait().ok();
    let stderr = err_text.join().unwrap_or_default();
    if state.result.is_none() {
        let detail = stderr.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("").trim().to_string();
        let code = status.and_then(|s| s.code()).map(|c| c.to_string()).unwrap_or_default();
        return Err(if detail.is_empty() {
            tf("Claude Code stopped without an answer (exit {code}). Is it signed in? Run `claude` once in a terminal.", &[("code", &code)])
        } else {
            tf("Claude Code: {error}", &[("error", &detail)])
        });
    }
    Ok(state)
}

/// An npm install runs `claude.cmd`: killing cmd.exe alone would leave node running.
/// On Linux the whole process group goes (run() starts the CLI in its own).
pub(crate) fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        let mut kill = Command::new("taskkill");
        kill.args(["/T", "/F", "/PID", &child.id().to_string()]);
        platform::no_console(&mut kill);
        let _ = kill.status();
    }
    #[cfg(target_os = "linux")]
    if let Ok(pid) = i32::try_from(child.id()) {
        // SAFETY: a plain signal to the group the child leads; no memory is shared.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// One chat turn through Claude Code.
pub async fn send(
    app: &AppHandle,
    chat: &Chat,
    model: &str,
    effort: &str,
    mode: &str,
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
    let input = prompt(context.as_ref(), &carried, &chat.files(), &query);
    let inbox = crate::files::inbox_dir().to_string_lossy().to_string();
    let args = args(model, effort, mode, session.as_deref(), &inbox, &chat.cli_dirs(folder));

    let app2 = app.clone();
    let stop = chat.stopper();
    let state = tauri::async_runtime::spawn_blocking(move || {
        run(
            exe,
            args,
            input,
            work_dir(),
            stop,
            |text| {
                let _ = app2.emit_to(WINDOW_LABEL, "chat-delta", text.to_string());
            },
            |activity| {
                let _ = app2.emit_to(WINDOW_LABEL, "chat-activity", activity);
            },
        )
    })
    .await
    .map_err(|e| e.to_string())??;

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
        None => unreachable!("run() returns an error without a result"),
    };
    let answer = if answer.trim().is_empty() && state.denied > 0 {
        t("Claude Code needed a permission that wasn't given. Install Lumo's hooks to approve actions from the island.")
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

/// Runs one task Gemini Live handed over, in `folder` when it is a folder
/// (the Lumo folder otherwise), with the `model` and `effort` of Settings →
/// Voice and the chat's permission `mode`: what it may not do by itself is an
/// Allow / Deny card in the island, as in the chat. No session is kept: each
/// task starts afresh. Blocking.
pub(crate) fn help(
    task: &str,
    folder: Option<&str>,
    model: &str,
    effort: &str,
    mode: &str,
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
    let args = args_with(HELPER_PROMPT, model, effort, mode, None, &inbox, &folders);
    let state = run(exe, args, task.to_string(), dir, stop, |_| {}, on_activity)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "0b5a8f2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b";

    #[test]
    fn a_task_from_gemini_gets_the_helper_instructions_and_no_session() {
        let a = args_with(HELPER_PROMPT, DEFAULT_MODEL, "", "auto", None, "/home/me/.local/share/lumo/inbox", &["/home/me/docs".into()]);
        assert!(a.windows(2).any(|w| w == ["--append-system-prompt", HELPER_PROMPT]));
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
        for wholesale in ["bypassPermissions", "dontAsk", "", "plan & calc"] {
            assert_eq!(mode(wholesale), "default", "{wholesale}");
        }
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
    fn stop_ends_the_cli_and_keeps_what_it_wrote() {
        // A stand-in for `claude -p`: says something, then hangs until killed.
        #[cfg(unix)]
        {
            let script = r#"echo '{"type":"system","subtype":"init","session_id":"0b5a8f2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b"}'
echo '{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Read","input":{"file_path":"/home/me/report.pdf"}}]}}'
echo '{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Half an answer"}}}'
sleep 30 & wait"#;
            let stop = Arc::new(Stop::default());
            let stopper = stop.clone();
            let seen = std::sync::Mutex::new(String::new());
            let started = Instant::now();
            let activities = std::sync::Mutex::new(Vec::new());
            let state = run(
                PathBuf::from("/bin/sh"),
                vec!["-c".into(), script.into()],
                String::new(),
                std::env::temp_dir(),
                stop,
                |text| {
                    *seen.lock().unwrap() = text.to_string();
                    stopper.stop();
                },
                |activity| activities.lock().unwrap().push(activity.clone()),
            )
            .unwrap();
            assert!(state.stopped);
            assert_eq!(state.visible, "Half an answer");
            assert_eq!(state.session.as_deref(), Some(SID));
            assert!(state.result.is_none());
            assert_eq!(*seen.lock().unwrap(), "Half an answer");
            assert_eq!(*activities.lock().unwrap(), vec![Activity::new("read", "report.pdf")], "told as it happened");
            assert!(started.elapsed() < Duration::from_secs(10), "not left waiting on the CLI");
        }
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
}
