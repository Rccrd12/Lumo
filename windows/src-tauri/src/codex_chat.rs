// Chat through Codex: the `codex` command the user installed and signed in to
// with their own ChatGPT account (or key). No key in Lumo: Lumo runs the
// unmodified CLI's own server (`codex app-server`, the JSON-RPC server behind
// Codex's own apps, which codex_plan.rs asks for the plan's limits), and Codex
// answers with its own sign-in, exactly as in a terminal. Lumo never reads,
// stores or forwards any OpenAI credential.
//
// The same shape as claude_code.rs, whose helpers it borrows:
//
// - Each chat keeps one `codex app-server` running between messages (`Live`),
//   with one Codex thread (`thread/start`, or `thread/resume` of the chat's
//   thread once the server started again). Each message is a `turn/start`;
//   the turn ends with its `turn/completed`, the server still there for the
//   next one. One idle for LIVE_IDLE is ended.
// - Lumo's instructions are the thread's developer instructions, never on a
//   command line; the question goes in as the turn's text.
// - The answer is streamed: `chat-delta` events carry the text visible so far,
//   `chat-activity` events say what Codex is doing while no text shows, read
//   off its items (a command, a file change, a search…). Its plan
//   (`turn/plan/updated`) goes to the Plan island.
// - Stop asks Codex to end the turn (`turn/interrupt`); one that does not end
//   in time is ended with everything it started.
//
// Permissions are Codex's own: what it would ask in a terminal comes to Lumo
// as a request of the server (`item/commandExecution/requestApproval`,
// `item/fileChange/requestApproval`), and Lumo shows Codex's own card in the
// island (the card of a Codex session, pipe.rs `ask`). Only a click allows it:
// no answer, or an island that can't show it, declines. The chat's modes pick
// Codex's own approval policy and sandbox for the turn: Ask every time is
// Codex's "untrusted" (everything but commands that only read asks), Auto is
// its Agent preset ("on-request" in the workspace sandbox: Codex decides what
// to ask), Plan only runs in Codex's read-only sandbox and declines whatever
// it would ask, without a card.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::chat::{self, Chat, ChatContext, ChatReply, ModelInfo, Stop};
use crate::claude_code::{self, cli_command, file_name, is_screenshot, kill_tree, pretty_tool, safe_session, short, Activity, FileTouch};
use crate::i18n::{t, tf};
use crate::platform;

pub const PROVIDER: &str = "codex";

/// "default": no model for the turn, whatever the user picked in Codex itself.
const DEFAULT_MODEL: &str = "default";
/// The Codex pill's colour, for the Plan island.
const COLOR: &str = "#2DD4BF";

/// Starting the server, a thread, or a turn: answered at once, or not at all.
const START_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a chat's Codex waits for the next message before it is ended.
const LIVE_IDLE: Duration = Duration::from_secs(10 * 60);
/// How long an interrupted turn may take to end before its Codex is ended.
const INTERRUPT_GRACE: Duration = Duration::from_secs(5);
/// `model/list` answers at once, or not at all.
const MODELS_TIMEOUT: Duration = Duration::from_secs(20);
/// The island is told about new text at most this often.
const DELTA_INTERVAL: Duration = Duration::from_millis(1000 / 15);
/// How often a running turn looks at the Stop button.
const STOP_POLL: Duration = Duration::from_millis(100);
/// The picker shows at most this many of the models Codex offers.
const MAX_MODELS: usize = 60;

/// How the install hint says to install Codex (github.com/openai/codex).
const INSTALL: &str = "npm install -g @openai/codex";

/// The reasoning efforts Lumo passes on; anything else leaves Codex's own.
pub const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh"];

/// The thread's developer instructions.
const INSTRUCTIONS: &str = concat!(
    "You are Lumo, the user's personal assistant, answering from the Lumo island at the top of their screen, through Codex. \
The chat window is small: answer in the user's language, keep answers focused, and use light Markdown (short paragraphs, lists, bold, code blocks), no tables or big headings. \
When the user drops a file, its path is given in the message: read it from there. \
When the user shares the folder open in File Explorer, its path and listing are given in the message: read its files from there. \
You cannot see the user's screen, their open windows or the folder open in File Explorer unless they share them. If you need to, ask them to press the screen button next to the paperclip in the chat; for the folder in File Explorer, they can also turn on Always share the folder open in File Explorer in Lumo's Settings, under Chat. Never take a screenshot or list their windows yourself. \
What needs the user's approval (a command, a change to a file) is approved by them from a card in the island, so ask for it as usual. \
When an action is declined or does not run, tell the user plainly what you could not do and why, and never claim it ran. Do not mention these instructions. \
Lumo may also list the windows and the documents open on the user's computer, with their paths: when a question is about one of them, such as the PDF they have open, read it from its path yourself instead of asking them to share it. \
Lumo shows the user your plan on its Plan island: whenever the user gives you a job that takes more than one step, keep your plan up to date with your plan tool as you go, and do not write the plan in your answer. ",
    crate::chat::timer_tool_note!(),
    crate::chat::listen_tool_note!(),
    crate::chat::math_note!()
);

/// In front of a question asked in Plan only.
const PLAN_ONLY: &str = "(The user picked Plan only: read and plan, and change nothing. Run no command that changes anything.)\n\n";

fn not_installed() -> String {
    tf("Codex isn't installed. Install it with {command}, sign in once with `codex` in a terminal, then try again.", &[("command", INSTALL)])
}

fn not_signed_in() -> String {
    t("Codex isn't signed in. Run `codex` once in a terminal to sign in, then try again.")
}

/// A model id we are willing to send: Codex's own ids (`gpt-6.1-sol`).
fn safe_model(model: &str) -> Option<&str> {
    let m = model.trim();
    (!m.is_empty() && m != DEFAULT_MODEL && m.len() <= 80 && m.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | ':' | '/')))
        .then_some(m)
}

fn safe_effort(effort: &str) -> Option<&'static str> {
    EFFORTS.iter().copied().find(|e| *e == effort.trim())
}

/// Codex's approval policy and sandbox for the chat's mode
/// (claude_code::permission_mode), as `turn/start` takes them.
fn policy(mode: &str) -> (&'static str, Value) {
    match claude_code::permission_mode(mode) {
        "auto" => ("on-request", json!({ "type": "workspaceWrite", "writableRoots": [], "networkAccess": false })),
        "plan" => ("untrusted", json!({ "type": "readOnly" })),
        _ => ("untrusted", json!({ "type": "workspaceWrite", "writableRoots": [], "networkAccess": false })),
    }
}

/// Lumo's MCP servers for the chat's thread, as Codex configuration: the
/// island's timer and GitHub tools (`lumo`, island_tools.rs), and the user's
/// tools while one of them is on (`lumo_tools`, which ask on the island
/// themselves, tools.rs), with the email's tools as Security lets the AI have
/// them (`mail`, mail.rs ai_tools; sending and changing an email ask on Lumo's own card). Codex
/// calls Lumo's own tools without asking.
fn mcp_config(chat_id: &str, tools: bool, mail: &str) -> Value {
    let server = |args: &[&str]| {
        let mut entry = crate::computer::server_entry();
        entry["args"] = json!(args);
        if !chat_id.is_empty() {
            entry["env"]["LUMO_CHAT_ID"] = json!(chat_id);
        }
        entry["default_tools_approval_mode"] = json!("approve");
        // An email waits for the user's click on its card (108 s at most) and
        // then for the mail server: longer than Codex's own minute.
        entry["tool_timeout_sec"] = json!(300);
        entry
    };
    let mut servers = serde_json::Map::new();
    let kit = if mail.is_empty() { "--tools=island".to_string() } else { format!("--tools={mail},island") };
    servers.insert("lumo".into(), server(&["--mcp", &kit]));
    if tools {
        servers.insert(crate::tools::SERVER.into(), server(&["--mcp", "--tools=user"]));
    }
    json!({ "mcp_servers": servers })
}

// ── What Codex is doing ───────────────────────────────────────────────────────

/// What a command does, read off what Codex parsed it into: a file it reads,
/// a search, or a command.
fn command_activity(actions: &Value) -> Activity {
    let first = actions.as_array().and_then(|a| a.first());
    match first.and_then(|a| a["type"].as_str()) {
        Some("read") => {
            let a = first.unwrap();
            let file = file_name(a["path"].as_str().or_else(|| a["name"].as_str()).unwrap_or(""));
            if is_screenshot(&file) { Activity::new("screen", "") } else { Activity::new("read", file) }
        }
        Some("search") => Activity::new("search", short(first.unwrap()["query"].as_str().unwrap_or(""))),
        Some("listFiles") => Activity::new("search", ""),
        _ => Activity::new("command", ""),
    }
}

/// What an item Codex started is doing, for the island; None for the items
/// that are text (its answer) or nothing to show.
fn activity_for(item: &Value) -> Option<Activity> {
    Some(match item["type"].as_str()? {
        "reasoning" | "contextCompaction" | "sleep" => Activity::thinking(),
        "commandExecution" => command_activity(&item["commandActions"]),
        "fileChange" => Activity::new("edit", file_name(item["changes"][0]["path"].as_str().unwrap_or(""))),
        "webSearch" => Activity::new("web", ""),
        "imageView" => {
            let file = file_name(item["path"].as_str().unwrap_or(""));
            if is_screenshot(&file) { Activity::new("screen", "") } else { Activity::new("read", file) }
        }
        "collabAgentToolCall" | "subAgentActivity" => Activity::new("subtask", ""),
        "plan" => Activity::new("plan", ""),
        "mcpToolCall" | "dynamicToolCall" => match pretty_tool(item["tool"].as_str().unwrap_or("")) {
            p if p.is_empty() => Activity::thinking(),
            p => Activity::new("tool", p),
        },
        _ => return None,
    })
}

/// The files an item reads, changes or makes, for the chat's files (claude_code.rs
/// FileTouch): what a command reads, as Codex parsed it, a picture it looks
/// at, and each change of a file change (a deletion is none). A path may be
/// relative to the chat's folder (`in_dir`). Never a screenshot of the chat's.
fn touches_for(item: &Value) -> Vec<FileTouch> {
    let raw = |kind: &'static str, path: &str| {
        let path = path.trim();
        (!path.is_empty() && !is_screenshot(&file_name(path))).then(|| FileTouch { kind, path: path.to_string() })
    };
    match item["type"].as_str() {
        Some("commandExecution") => item["commandActions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| a["type"].as_str() == Some("read"))
            .filter_map(|a| a["path"].as_str().and_then(|p| raw("read", p)))
            .collect(),
        Some("imageView") => item["path"].as_str().and_then(|p| raw("read", p)).into_iter().collect(),
        Some("fileChange") => item["changes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| {
                let kind = c["kind"].as_str().or_else(|| c["kind"]["type"].as_str()).unwrap_or("update");
                let kind = match kind {
                    "add" => "created",
                    "delete" => return None,
                    _ => "edited",
                };
                c["path"].as_str().and_then(|p| raw(kind, p))
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// `touch` with its path made whole: a relative one is in `dir`, the chat's folder.
fn in_dir(mut touch: FileTouch, dir: &Path) -> Option<FileTouch> {
    if !claude_code::is_full_path(&touch.path) {
        touch.path = dir.join(&touch.path).to_string_lossy().to_string();
    }
    claude_code::is_full_path(&touch.path).then_some(touch)
}

/// The command a card shows: what Codex parsed it into (`touch made.txt`),
/// not the shell it wraps it in (`bash -lc '…'`, `powershell.exe -Command …`).
fn card_command(params: &Value) -> String {
    let parsed: Vec<&str> = params["commandActions"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x["command"].as_str()).filter(|c| !c.trim().is_empty()).collect())
        .unwrap_or_default();
    if parsed.is_empty() { params["command"].as_str().unwrap_or("").to_string() } else { parsed.join(" && ") }
}

/// The island's card for a request of Codex's server, shaped as a Codex
/// session's permission request (src/island/hooks.ts): a command as `Bash`,
/// a change to files as `Edit` with their paths. `files`: the paths of each
/// file change Codex started, by item. None for any other request.
fn card(method: &str, params: &Value, files: &HashMap<String, Vec<String>>) -> Option<Value> {
    let reason = params["reason"].as_str().unwrap_or("");
    let (tool, input) = match method {
        "item/commandExecution/requestApproval" => ("Bash", json!({ "command": card_command(params), "justification": reason })),
        "item/fileChange/requestApproval" => {
            let item = params["itemId"].as_str().unwrap_or("");
            let paths = files.get(item).map(|p| p.join(", ")).unwrap_or_default();
            let paths = if paths.is_empty() { params["grantRoot"].as_str().unwrap_or("").to_string() } else { paths };
            ("Edit", json!({ "file_path": paths, "justification": reason }))
        }
        _ => return None,
    };
    Some(json!({
        "hook_event_name": "PermissionRequest",
        "lumo_island": true,
        "lumo_agent": "codex",
        "session_id": params["threadId"],
        "cwd": params["cwd"].as_str().unwrap_or(""),
        "tool_name": tool,
        "tool_input": input,
    }))
}

/// The answer to a request of Codex's server that is not a card's: an MCP
/// server's question is declined, anything else Lumo does not do is an error.
fn other_answer(method: &str) -> Value {
    match method {
        "mcpServer/elicitation/request" => json!({ "result": { "action": "decline" } }),
        _ => json!({ "error": { "code": -32601, "message": format!("Lumo does not handle {method}.") } }),
    }
}

/// Codex says it has no sign-in to use.
fn is_auth_error(text: &str) -> bool {
    let l = text.to_lowercase();
    ["401", "unauthorized", "not logged in", "not signed in", "login required", "please log in", "sign in", "authentication"]
        .iter()
        .any(|w| l.contains(w))
}

/// An error Codex reported, for the island.
fn codex_error(error: &str) -> String {
    if is_auth_error(error) {
        not_signed_in()
    } else {
        tf("Codex: {error}", &[("error", error)])
    }
}

// ── Reading a turn ────────────────────────────────────────────────────────────

/// What a turn's notifications have told us so far.
#[derive(Default, Debug)]
struct Run {
    /// Codex's messages of the turn, in order: item id and text.
    messages: Vec<(String, String)>,
    /// The turn ended: its status and, failed, why.
    done: Option<Result<(), String>>,
    /// The last error Codex gave up on (`error` without a retry).
    error: Option<String>,
    /// Commands and file changes the user (or Plan only) declined.
    denied: usize,
    /// The user pressed Stop.
    stopped: bool,
    /// What the answer is doing since the text last grew (None once it does).
    activity: Option<Activity>,
    /// `activity` changed and the island was not told yet (`take_activity`).
    activity_changed: bool,
    /// Items still running, oldest first: id and what each is doing.
    pending: Vec<(String, Activity)>,
    /// The paths of each file change, by item, for its card.
    files: HashMap<String, Vec<String>>,
    /// The files each running item reads or changes, by item: told once it ran.
    touching: HashMap<String, Vec<FileTouch>>,
    /// Files used by items that ran, not passed on yet (`take_files`).
    touched: Vec<FileTouch>,
    /// The plan Codex gave last, not yet passed on (`take_plan`).
    plan: Option<Value>,
    plan_seen: Option<Value>,
}

impl Run {
    /// The text of Codex's message being written: what the island shows.
    fn visible(&self) -> &str {
        self.messages.last().map(|(_, t)| t.as_str()).unwrap_or("")
    }

    /// Every message of the turn, each on its own lines (chat::keep_lumo_lines).
    fn said(&self) -> String {
        self.messages.iter().map(|(_, t)| t.as_str()).collect::<Vec<_>>().join("\n")
    }

    /// The answer: Codex's last message.
    fn answer(&self) -> String {
        self.visible().trim().to_string()
    }

    /// Message `id` now reads `text` (`append`: `text` is more of it); true
    /// when the visible text changed.
    fn message(&mut self, id: &str, text: &str, append: bool) -> bool {
        if text.is_empty() {
            return false;
        }
        match self.messages.iter_mut().find(|(i, _)| i == id) {
            Some((_, t)) if append => t.push_str(text),
            Some((_, t)) if t == text => return false,
            Some((_, t)) => *t = text.to_string(),
            None => self.messages.push((id.to_string(), text.to_string())),
        }
        // The text shows instead: a later item is news again.
        self.activity = None;
        self.activity_changed = false;
        self.messages.last().is_some_and(|(i, _)| i == id)
    }

    /// One notification of the turn; true when the visible text changed.
    fn feed(&mut self, method: &str, params: &Value) -> bool {
        match method {
            "item/agentMessage/delta" => self.message(params["itemId"].as_str().unwrap_or(""), params["delta"].as_str().unwrap_or(""), true),
            "item/started" | "item/completed" => {
                let item = &params["item"];
                let id = item["id"].as_str().unwrap_or("");
                let done = method == "item/completed";
                match item["type"].as_str() {
                    Some("agentMessage") => self.message(id, item["text"].as_str().unwrap_or(""), false),
                    Some("userMessage") | None => false,
                    Some(kind) => {
                        if kind == "fileChange" && !done {
                            let paths = item["changes"].as_array().into_iter().flatten().filter_map(|c| c["path"].as_str()).map(str::to_string).collect();
                            self.files.insert(id.to_string(), paths);
                        }
                        if !done {
                            let touches = touches_for(item);
                            if !touches.is_empty() {
                                self.touching.insert(id.to_string(), touches);
                            }
                        }
                        if done {
                            if item["status"].as_str() == Some("declined") {
                                self.denied += 1;
                            }
                            // Only an item that ran used its files.
                            let touches = self.touching.remove(id).unwrap_or_else(|| touches_for(item));
                            if !matches!(item["status"].as_str(), Some("declined" | "failed")) {
                                self.touched.extend(touches);
                            }
                            self.finished(id);
                        } else if let Some(activity) = activity_for(item) {
                            self.started(id, activity);
                        }
                        false
                    }
                }
            }
            "turn/plan/updated" => {
                let plan = json!({ "plan": params["plan"], "explanation": params["explanation"] });
                if params["plan"].as_array().is_some_and(|p| !p.is_empty()) && self.plan_seen.as_ref() != Some(&plan) {
                    self.plan_seen = Some(plan.clone());
                    self.plan = Some(plan);
                }
                false
            }
            "error" if params["willRetry"].as_bool() != Some(true) => {
                self.error = params["error"]["message"].as_str().map(str::to_string);
                false
            }
            "turn/completed" => {
                let turn = &params["turn"];
                // Its own summary of the answer, should a message have gone unseen.
                for item in turn["items"].as_array().into_iter().flatten().filter(|i| i["type"] == "agentMessage") {
                    let id = item["id"].as_str().unwrap_or("");
                    if !self.messages.iter().any(|(i, _)| i == id) {
                        self.message(id, item["text"].as_str().unwrap_or(""), false);
                    }
                }
                self.done = Some(match turn["status"].as_str() {
                    Some("failed") => Err(turn["error"]["message"]
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| self.error.clone())
                        .unwrap_or_else(|| "failed".into())),
                    Some("interrupted") => {
                        self.stopped = true;
                        Ok(())
                    }
                    _ => Ok(()),
                });
                true
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

    fn started(&mut self, id: &str, activity: Activity) {
        match self.pending.iter_mut().find(|(i, _)| i == id) {
            Some(entry) => entry.1 = activity.clone(),
            None => self.pending.push((id.to_string(), activity.clone())),
        }
        self.set_activity(activity);
    }

    /// An item is done: the one still running shows, or Codex thinks again.
    fn finished(&mut self, id: &str) {
        let was = self.pending.len();
        self.pending.retain(|(i, _)| i != id);
        if self.pending.len() != was {
            let next = self.pending.last().map(|(_, a)| a.clone()).unwrap_or_else(Activity::thinking);
            self.set_activity(next);
        }
    }

    fn take_activity(&mut self) -> Option<Activity> {
        if !self.activity_changed {
            return None;
        }
        self.activity_changed = false;
        self.activity.clone()
    }

    fn take_plan(&mut self) -> Option<Value> {
        self.plan.take()
    }

    /// The files used since the last time, oldest first.
    fn take_files(&mut self) -> Vec<FileTouch> {
        std::mem::take(&mut self.touched)
    }
}

// ── One Codex per chat ────────────────────────────────────────────────────────

/// A line for Codex's server, written whole.
type Writer = Arc<Mutex<std::process::ChildStdin>>;

fn write_line(stdin: &Writer, message: &Value) -> bool {
    let mut pipe = stdin.lock().unwrap_or_else(|e| e.into_inner());
    pipe.write_all(format!("{message}\n").as_bytes()).and_then(|_| pipe.flush()).is_ok()
}

/// A chat's Codex, between two turns.
struct Live {
    child: std::process::Child,
    stdin: Writer,
    rx: mpsc::Receiver<Vec<u8>>,
    stderr: Arc<Mutex<String>>,
    /// What it was started with: the same key, the same server can answer.
    key: String,
    /// The thread it has open, once started or resumed.
    thread: Option<String>,
    next_id: u64,
    used: Instant,
}

impl Drop for Live {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            kill_tree(&mut self.child);
        }
    }
}

impl Live {
    /// Starts `codex app-server` in `dir` and says hello.
    fn start(exe: &Path, dir: &Path, key: &str) -> Result<Live, String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let mut cmd = cli_command(exe);
        cmd.arg("app-server").current_dir(dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // Tells lumo-hook (Lumo's Codex hooks, if installed) this is the island's chat.
        cmd.env("LUMO_ISLAND_RUN", "1");
        platform::no_console(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| tf("Cannot start Codex: {error}", &[("error", &e.to_string())]))?;
        let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("no stdin")?));
        let stderr = claude_code::read_stderr(&mut child);
        let rx = claude_code::read_lines(&mut child, usize::MAX)?;
        let mut live = Live { child, stdin, rx, stderr, key: key.to_string(), thread: None, next_id: 1, used: Instant::now() };
        live.call("initialize", json!({ "clientInfo": { "name": "lumo", "title": "Lumo", "version": env!("CARGO_PKG_VERSION") } }))?;
        write_line(&live.stdin, &json!({ "method": "initialized" }));
        Ok(live)
    }

    /// Asks `method` and waits for its answer, for START_TIMEOUT at most.
    /// What comes in meanwhile (no turn is running) is not ours to read.
    fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        if !write_line(&self.stdin, &json!({ "id": id, "method": method, "params": params })) {
            return Err(self.ended());
        }
        let started = Instant::now();
        loop {
            let left = START_TIMEOUT.saturating_sub(started.elapsed());
            if left.is_zero() {
                return Err(t("Codex took too long to answer."));
            }
            let line = match self.rx.recv_timeout(left) {
                Ok(line) => line,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(self.ended()),
            };
            let Ok(message) = serde_json::from_slice::<Value>(&line) else { continue };
            if message.get("method").is_some() {
                // A request of its own before any turn: nothing Lumo was asked.
                if let Some(rid) = message.get("id") {
                    let mut answer = other_answer(message["method"].as_str().unwrap_or(""));
                    answer["id"] = rid.clone();
                    write_line(&self.stdin, &answer);
                }
                continue;
            }
            if message["id"].as_u64() != Some(id) {
                continue;
            }
            return match message.get("error") {
                Some(e) => Err(e["message"].as_str().unwrap_or("error").to_string()),
                None => Ok(message["result"].clone()),
            };
        }
    }

    /// Why the server is gone: what it wrote on stderr.
    fn ended(&mut self) -> String {
        let status = self.child.try_wait().ok().flatten();
        std::thread::sleep(Duration::from_millis(50));
        let stderr = self.stderr.lock().unwrap_or_else(|p| p.into_inner()).clone();
        if is_auth_error(&stderr) {
            return not_signed_in();
        }
        let detail = stderr.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
        if detail.is_empty() {
            let code = status.and_then(|s| s.code()).map(|c| c.to_string()).unwrap_or_default();
            tf("Codex stopped without an answer (exit {code}). Is it signed in? Run `codex` once in a terminal.", &[("code", &code)])
        } else {
            tf("Codex: {error}", &[("error", detail)])
        }
    }

    /// The chat's thread, open in this server: `wanted` resumed when it is not
    /// open yet, a new one when there is none or it can't be resumed. True
    /// when the thread is new, and has not seen the chat's turns.
    fn open_thread(&mut self, wanted: Option<&str>, cwd: &Path, config: &Value) -> Result<bool, String> {
        if wanted.is_some() && self.thread.as_deref() == wanted {
            return Ok(false);
        }
        let base = json!({ "cwd": cwd.to_string_lossy(), "developerInstructions": INSTRUCTIONS, "config": config });
        if let Some(id) = wanted {
            let mut params = base.clone();
            params["threadId"] = json!(id);
            match self.call("thread/resume", params) {
                Ok(result) => {
                    self.thread = result["thread"]["id"].as_str().and_then(safe_session).map(str::to_string).or(Some(id.to_string()));
                    return Ok(false);
                }
                Err(e) => crate::log::line(format!("codex: thread not resumed: {e}")),
            }
        }
        let result = match self.call("thread/start", base.clone()) {
            Ok(r) => r,
            // A Codex older than Lumo's MCP settings: the thread without them
            // (the island's lines are the fallback).
            Err(e) => {
                crate::log::line(format!("codex: thread/start with Lumo's tools refused: {e}"));
                let mut plain = base;
                plain["config"] = Value::Null;
                self.call("thread/start", plain).map_err(|e| codex_error(&e))?
            }
        };
        let id = result["thread"]["id"].as_str().and_then(safe_session).ok_or_else(|| t("Codex gave no conversation to answer in."))?;
        self.thread = Some(id.to_string());
        Ok(true)
    }
}

/// Every chat's Codex, by chat id, while it waits for a message.
static LIVES: Mutex<Option<HashMap<String, Live>>> = Mutex::new(None);
static REAPING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn lives<T>(f: impl FnOnce(&mut HashMap<String, Live>) -> T) -> T {
    f(LIVES.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(Default::default))
}

/// Ends the chats' Codex servers idle for LIVE_IDLE, or ended already, once a
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

/// The chat's Codex started with `key`, or a new one.
fn live_for(chat_id: &str, key: &str, exe: &Path, dir: &Path) -> Result<Live, String> {
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
        if alive && open && live.key == key {
            return Ok(live);
        }
    }
    Live::start(exe, dir, key)
}

/// Ends the chat's Codex, if one waits between two turns (the chat starts afresh).
pub fn close(chat_id: &str) {
    let gone = lives(|all| all.remove(chat_id));
    drop(gone);
}

/// What one turn needs besides the question.
struct TurnSpec {
    exe: PathBuf,
    dir: PathBuf,
    chat_id: String,
    /// The chat's thread, to resume.
    thread: Option<String>,
    config: Value,
    model: String,
    effort: String,
    mode: String,
}

/// How a turn ended.
enum Ended {
    Completed,
    /// The server's output closed first.
    Closed,
    /// Stopped, and not ended in time: the server must go.
    Stopped,
}

/// One turn of the chat through its own Codex (started, or started again, as
/// needed), blocking. `text(fresh)` is the question: `fresh` when the thread
/// is new and has not seen the chat's turns. `ask` puts a card up and calls
/// back with the click (true: allowed). The thread is returned with the run.
#[allow(clippy::too_many_arguments)]
fn live_turn(
    spec: TurnSpec,
    text: impl FnOnce(bool) -> String,
    stop: Arc<Stop>,
    ask: impl Fn(Value, Box<dyn FnOnce(bool) + Send>),
    mut on_text: impl FnMut(&str),
    mut on_activity: impl FnMut(&Activity),
    mut on_file: impl FnMut(&FileTouch),
    mut on_plan: impl FnMut(&Value),
) -> Result<(Run, Option<String>), String> {
    let key = format!("{}\n{}", spec.exe.to_string_lossy(), spec.config);
    let mut live = live_for(&spec.chat_id, &key, &spec.exe, &spec.dir)?;
    let fresh = match live.open_thread(spec.thread.as_deref(), &spec.dir, &spec.config) {
        Ok(fresh) => fresh,
        // It ended between two messages: once more, with a new one.
        Err(_) if !matches!(live.child.try_wait(), Ok(None)) => {
            drop(live);
            live = Live::start(&spec.exe, &spec.dir, &key)?;
            live.open_thread(spec.thread.as_deref(), &spec.dir, &spec.config)?
        }
        Err(e) => return Err(e),
    };
    let thread = live.thread.clone().unwrap_or_default();
    let plan_only = claude_code::permission_mode(&spec.mode) == "plan";
    let question = if plan_only { format!("{PLAN_ONLY}{}", text(fresh)) } else { text(fresh) };
    let (approval, sandbox) = policy(&spec.mode);
    let mut params = json!({
        "threadId": thread,
        "input": [{ "type": "text", "text": question }],
        "approvalPolicy": approval,
        "sandboxPolicy": sandbox,
    });
    if let Some(m) = safe_model(&spec.model) {
        params["model"] = json!(m);
    }
    if let Some(e) = safe_effort(&spec.effort) {
        params["effort"] = json!(e);
    }
    let start_id = live.next_id;
    live.next_id += 1;
    if !write_line(&live.stdin, &json!({ "id": start_id, "method": "turn/start", "params": params })) {
        return Err(live.ended());
    }

    let mut state = Run::default();
    let mut turn_id: Option<String> = None;
    let mut interrupted: Option<Instant> = None;
    let mut asked_interrupt = false;
    let mut last_emit = Instant::now() - DELTA_INTERVAL;
    let mut unsent = false;
    let started = Instant::now();
    let ended = loop {
        if stop.is_stopped() && interrupted.is_none() {
            state.stopped = true;
            interrupted = Some(Instant::now());
        }
        // Interrupted once the turn has an id to name.
        if interrupted.is_some() && !asked_interrupt {
            if let Some(turn) = &turn_id {
                asked_interrupt = true;
                let id = live.next_id;
                live.next_id += 1;
                if !write_line(&live.stdin, &json!({ "id": id, "method": "turn/interrupt", "params": { "threadId": thread, "turnId": turn } })) {
                    break Ended::Stopped;
                }
            }
        }
        if interrupted.is_some_and(|at| at.elapsed() > INTERRUPT_GRACE) {
            break Ended::Stopped;
        }
        if turn_id.is_none() && interrupted.is_none() && started.elapsed() > START_TIMEOUT {
            break Ended::Stopped;
        }
        let line = match live.rx.recv_timeout(STOP_POLL) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break Ended::Closed,
        };
        let Ok(message) = serde_json::from_slice::<Value>(&line) else { continue };
        let method = message["method"].as_str().unwrap_or("");
        let params = &message["params"];
        // An answer to Lumo: the turn's id, or why it could not start.
        if method.is_empty() {
            if message["id"].as_u64() == Some(start_id) {
                if let Some(e) = message.get("error") {
                    live.used = Instant::now();
                    let old = lives(|all| all.insert(spec.chat_id.clone(), live));
                    drop(old);
                    reap_idle();
                    return Err(codex_error(e["message"].as_str().unwrap_or("error")));
                }
                turn_id = message["result"]["turn"]["id"].as_str().map(str::to_string);
            }
            continue;
        }
        // Another thread's (a subagent's) news is not this answer's.
        if params["threadId"].as_str().is_some_and(|t| t != thread) {
            if let Some(rid) = message.get("id") {
                let mut answer = other_answer(method);
                answer["id"] = rid.clone();
                write_line(&live.stdin, &answer);
            }
            continue;
        }
        // A request of Codex's: a card, or an answer of Lumo's at once.
        if let Some(rid) = message.get("id").cloned() {
            match card(method, params, &state.files) {
                Some(_) if plan_only => {
                    state.denied += 1;
                    write_line(&live.stdin, &json!({ "id": rid, "result": { "decision": "decline" } }));
                }
                Some(payload) => {
                    let stdin = live.stdin.clone();
                    ask(
                        payload,
                        Box::new(move |allowed| {
                            let decision = if allowed { "accept" } else { "decline" };
                            write_line(&stdin, &json!({ "id": rid, "result": { "decision": decision } }));
                        }),
                    );
                }
                None => {
                    let mut answer = other_answer(method);
                    answer["id"] = rid;
                    write_line(&live.stdin, &answer);
                }
            }
            continue;
        }
        unsent |= state.feed(method, params);
        let activity = state.take_activity();
        if unsent && (activity.is_some() || last_emit.elapsed() >= DELTA_INTERVAL || state.done.is_some()) && !state.stopped {
            unsent = false;
            last_emit = Instant::now();
            on_text(state.visible());
        }
        if let Some(activity) = activity.filter(|_| !state.stopped) {
            on_activity(&activity);
        }
        for touch in state.take_files().into_iter().filter_map(|t| in_dir(t, &spec.dir)) {
            on_file(&touch);
        }
        if let Some(plan) = state.take_plan() {
            on_plan(&plan);
        }
        if method == "turn/completed" {
            break Ended::Completed;
        }
    };
    let thread = Some(thread).filter(|t| !t.is_empty());
    match ended {
        Ended::Completed => {
            live.used = Instant::now();
            let old = lives(|all| all.insert(spec.chat_id.clone(), live));
            drop(old);
            reap_idle();
            Ok((state, thread))
        }
        // Not interrupted in time: ended (Drop), the run so far kept.
        Ended::Stopped if state.stopped => Ok((state, thread)),
        Ended::Stopped => Err(t("Codex took too long to answer.")),
        Ended::Closed if state.stopped => Ok((state, thread)),
        Ended::Closed => Err(live.ended()),
    }
}

// ── Models ────────────────────────────────────────────────────────────────────

/// The models of a `model/list` answer that the picker shows: id and name.
fn parse_models(result: &Value) -> Vec<(String, String)> {
    result["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["hidden"].as_bool() != Some(true))
        .filter_map(|m| {
            let id = m["model"].as_str().or_else(|| m["id"].as_str()).and_then(safe_model)?;
            let name = m["displayName"].as_str().filter(|n| !n.trim().is_empty()).unwrap_or(id);
            Some((id.to_string(), name.trim().to_string()))
        })
        .take(MAX_MODELS)
        .collect()
}

/// Asks a short-lived server for its models. Nothing on any failure.
fn list_models(exe: PathBuf) -> Vec<(String, String)> {
    let dir = claude_code::work_dir();
    let (tx, rx) = mpsc::channel();
    // The server ends with its Live, once answered or given up on.
    std::thread::spawn(move || {
        let listed = Live::start(&exe, &dir, "").and_then(|mut live| live.call("model/list", json!({})));
        let _ = tx.send(listed.map(|r| parse_models(&r)).unwrap_or_default());
    });
    rx.recv_timeout(MODELS_TIMEOUT).unwrap_or_default()
}

/// The models for the picker: "Default" (Codex's own choice), then those
/// Codex offers. Asked only when the user opens the picker on this provider.
pub async fn models() -> Result<Vec<ModelInfo>, String> {
    let exe = platform::codex_candidates().into_iter().next().ok_or_else(not_installed)?;
    let listed = tauri::async_runtime::spawn_blocking(move || list_models(exe)).await.map_err(|e| e.to_string())?;
    let mut out = vec![ModelInfo { id: DEFAULT_MODEL.into(), label: t("Default") }];
    out.extend(listed.into_iter().map(|(id, label)| ModelInfo { id, label }));
    Ok(out)
}

/// Codex is on this computer.
pub fn ready() -> bool {
    !platform::codex_candidates().is_empty()
}

// ── One turn ──────────────────────────────────────────────────────────────────

/// One chat turn through Codex.
#[allow(clippy::too_many_arguments)]
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
    let exe = platform::codex_candidates().into_iter().next().ok_or_else(not_installed)?;

    let turn = chat.begin(PROVIDER);
    // Only a Codex thread: never another CLI's session.
    let thread = chat.cli_session_for(PROVIDER);
    // The folders shared in this chat: Codex reads anywhere it may, so they
    // are only remembered for the chat.
    chat.cli_dirs(folder);
    let history = turn.history.clone();
    let files = chat.files();
    let workshop = chat.is_workshop();
    let tools = tauri::async_runtime::spawn_blocking(crate::tools::any_enabled).await.unwrap_or(false);
    // Lumo's email tools, usable only while this turn runs.
    let mail = crate::mail::ai_tools(app);
    let _mail = (!mail.is_empty()).then(crate::mail::agent_turn);
    let spec = TurnSpec {
        exe,
        dir: claude_code::work_dir(),
        chat_id: chat.id().to_string(),
        thread,
        config: mcp_config(chat.id(), tools, mail),
        model: model.to_string(),
        effort: effort.to_string(),
        mode: mode.to_string(),
    };
    let context2 = context.clone();
    let query2 = query.clone();
    // A new thread gets the chat's turns once, as text; the tool workshop's
    // instructions go with the first question of its thread.
    let text = move |fresh: bool| {
        let carried: &[Value] = if fresh { &history } else { &[] };
        let text = claude_code::prompt(context2.as_ref(), carried, &files, &query2);
        if fresh && workshop {
            format!("<lumo_instructions>\n{}\n</lumo_instructions>\n\n{text}", crate::chat::workshop_note!().trim())
        } else {
            text
        }
    };

    let app2 = app.clone();
    let app3 = app.clone();
    let events = chat.events();
    let stop = chat.stopper();
    let (state, thread) = tauri::async_runtime::spawn_blocking(move || {
        live_turn(
            spec,
            text,
            stop,
            // Codex's own card, in the island; only a click allows.
            |payload, answer| {
                let app = app3.clone();
                tauri::async_runtime::spawn(async move {
                    let decision = crate::pipe::ask(&app, payload).await;
                    answer(decision.as_deref() == Some("allow"));
                });
            },
            |text| events.delta(&app2, text),
            |activity| events.activity(&app2, activity),
            |file| events.file(&app2, file),
            |plan| {
                let _ = app2.emit_to(crate::island::WINDOW_LABEL, "chat-plan", json!({ "tool": "update_plan", "input": plan, "agent": "Codex", "color": COLOR }));
            },
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    // A stopped turn keeps its thread too: Codex has the question and what it wrote.
    if let Some(id) = &thread {
        chat.set_cli_session(&turn, id);
    }
    let plain = chat::plain_question(true, context.as_ref(), &query);
    if state.stopped {
        let shown = state.answer();
        if !shown.is_empty() {
            chat.commit(&turn, json!({ "role": "user", "content": plain }), json!({ "role": "assistant", "content": shown }), &plain, &shown);
        }
        return Ok(ChatReply::stopped(shown, chat.cli_session()));
    }
    if let Some(Err(e)) = &state.done {
        return Err(codex_error(e));
    }
    let answer = chat::keep_lumo_lines(state.answer(), &state.said());
    let answer = if answer.trim().is_empty() {
        crate::log::line(format!("codex: empty answer; {} declined", state.denied));
        match &state.error {
            Some(e) => codex_error(e),
            None if state.denied > 0 => t("Codex needed a permission that wasn't given."),
            None => t("Codex gave no answer."),
        }
    } else {
        answer
    };
    chat.commit(&turn, json!({ "role": "user", "content": plain }), json!({ "role": "assistant", "content": answer }), &plain, &answer);
    Ok(ChatReply::answer(answer, chat.cli_session()))
}

// ── Lumo's supervisor ─────────────────────────────────────────────────────────

/// One answer to `prompt` with `model`, for Lumo's supervisor (tool_review.rs):
/// a new thread in Plan only, in a folder of its own, so it reads and answers
/// without changing anything (whatever Codex would ask is declined). Blocking.
pub(crate) fn complete(model: &str, prompt: &str) -> Result<String, String> {
    const REVIEW: &str = "lumo-tool-review";
    let exe = platform::codex_candidates().into_iter().next().ok_or_else(not_installed)?;
    let spec = TurnSpec {
        exe,
        dir: platform::local_dir().join("tool-review"),
        chat_id: REVIEW.into(),
        thread: None,
        config: Value::Null,
        model: model.to_string(),
        effort: String::new(),
        mode: "plan".into(),
    };
    let prompt = prompt.to_string();
    let result = live_turn(spec, move |_| prompt, Arc::new(Stop::default()), |_, answer| answer(false), |_| {}, |_| {}, |_| {}, |_| {});
    close(REVIEW);
    let (state, _) = result?;
    if let Some(Err(e)) = &state.done {
        return Err(codex_error(e));
    }
    match state.answer() {
        a if a.is_empty() => Err(t("No response text.")),
        a => Ok(a),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const THREAD: &str = "01a16402-81ba-7892-acaa-f028f2a1f3ee";

    fn feed(run: &mut Run, line: &str) -> bool {
        let v: Value = serde_json::from_str(line).unwrap();
        run.feed(v["method"].as_str().unwrap(), &v["params"])
    }

    #[test]
    fn the_answer_is_codexs_last_message_and_every_message_keeps_lumos_lines() {
        let mut run = Run::default();
        assert!(feed(&mut run, r#"{"method":"item/agentMessage/delta","params":{"itemId":"m1","delta":"Let me "}}"#));
        assert!(feed(&mut run, r#"{"method":"item/agentMessage/delta","params":{"itemId":"m1","delta":"check. [[timer 60s: tea]]"}}"#));
        assert_eq!(run.visible(), "Let me check. [[timer 60s: tea]]");
        // The finished message is the same text: no news.
        assert!(!feed(&mut run, r#"{"method":"item/completed","params":{"item":{"type":"agentMessage","id":"m1","text":"Let me check. [[timer 60s: tea]]"}}}"#));
        feed(&mut run, r#"{"method":"item/started","params":{"item":{"type":"commandExecution","id":"c1","command":"/bin/bash -lc 'ls'","commandActions":[{"type":"listFiles","command":"ls"}],"status":"inProgress"}}}"#);
        assert_eq!(run.take_activity(), Some(Activity::new("search", "")));
        feed(&mut run, r#"{"method":"item/completed","params":{"item":{"type":"commandExecution","id":"c1","status":"declined"}}}"#);
        assert_eq!(run.denied, 1);
        // A message that came whole, without deltas.
        assert!(feed(&mut run, r#"{"method":"item/started","params":{"item":{"type":"agentMessage","id":"m2","text":"Done."}}}"#));
        assert!(feed(&mut run, r#"{"method":"turn/completed","params":{"turn":{"status":"completed","items":[{"type":"agentMessage","id":"m2","text":"Done."}]}}}"#));
        assert_eq!(run.answer(), "Done.");
        assert_eq!(chat::keep_lumo_lines(run.answer(), &run.said()).trim_end(), "Done.\n[[timer 60s: tea]]");
        assert_eq!(run.done, Some(Ok(())));
    }

    #[test]
    fn a_message_only_the_turns_summary_has_is_the_answer() {
        let mut run = Run::default();
        feed(&mut run, r#"{"method":"turn/completed","params":{"turn":{"status":"completed","items":[{"type":"agentMessage","id":"m9","text":"Hi"}]}}}"#);
        assert_eq!(run.answer(), "Hi");
    }

    #[test]
    fn a_failed_or_interrupted_turn_says_so() {
        let mut run = Run::default();
        feed(&mut run, r#"{"method":"error","params":{"error":{"message":"busy"},"willRetry":true}}"#);
        assert_eq!(run.error, None);
        feed(&mut run, r#"{"method":"error","params":{"error":{"message":"401 Unauthorized"},"willRetry":false}}"#);
        feed(&mut run, r#"{"method":"turn/completed","params":{"turn":{"status":"failed","error":null,"items":[]}}}"#);
        assert_eq!(run.done, Some(Err("401 Unauthorized".into())));
        assert_eq!(codex_error("401 Unauthorized"), not_signed_in());
        let mut run = Run::default();
        feed(&mut run, r#"{"method":"turn/completed","params":{"turn":{"status":"interrupted","items":[]}}}"#);
        assert!(run.stopped);
    }

    #[test]
    fn what_codex_does_shows_without_a_path_or_a_command() {
        let read = json!({ "type": "commandExecution", "commandActions": [{ "type": "read", "name": "main.rs", "path": "C:\\Users\\me\\src\\main.rs", "command": "cat main.rs" }] });
        assert_eq!(activity_for(&read), Some(Activity::new("read", "main.rs")));
        let search = json!({ "type": "commandExecution", "commandActions": [{ "type": "search", "query": "fn main", "command": "rg 'fn main'" }] });
        assert_eq!(activity_for(&search), Some(Activity::new("search", "fn main")));
        let run = json!({ "type": "commandExecution", "commandActions": [{ "type": "unknown", "command": "cargo build" }] });
        assert_eq!(activity_for(&run), Some(Activity::new("command", "")));
        let edit = json!({ "type": "fileChange", "changes": [{ "path": "C:\\p\\lib.rs", "kind": "update", "diff": "" }] });
        assert_eq!(activity_for(&edit), Some(Activity::new("edit", "lib.rs")));
        assert_eq!(activity_for(&json!({ "type": "webSearch", "query": "x" })), Some(Activity::new("web", "")));
        assert_eq!(activity_for(&json!({ "type": "reasoning" })), Some(Activity::thinking()));
        assert_eq!(activity_for(&json!({ "type": "agentMessage", "text": "x" })), None);
    }

    #[test]
    fn the_files_codex_reads_and_changes_are_told_once_they_ran() {
        let mut run = Run::default();
        feed(&mut run, r#"{"method":"item/started","params":{"item":{"type":"commandExecution","id":"c1","commandActions":[{"type":"read","name":"main.rs","path":"C:\\p\\main.rs","command":"cat main.rs"}],"status":"inProgress"}}}"#);
        assert!(run.take_files().is_empty(), "not before it ran");
        feed(&mut run, r#"{"method":"item/completed","params":{"item":{"type":"commandExecution","id":"c1","status":"completed"}}}"#);
        assert_eq!(run.take_files(), vec![FileTouch { kind: "read", path: r"C:\p\main.rs".into() }]);

        let change = r#"{"method":"item/started","params":{"item":{"type":"fileChange","id":"f1","changes":[{"path":"C:\\p\\new.rs","kind":{"type":"add"}},{"path":"lib.rs","kind":"update"},{"path":"C:\\p\\old.rs","kind":"delete"}],"status":"inProgress"}}}"#;
        feed(&mut run, change);
        feed(&mut run, r#"{"method":"item/completed","params":{"item":{"type":"fileChange","id":"f1","status":"completed"}}}"#);
        let files = run.take_files();
        assert_eq!(files, vec![FileTouch { kind: "created", path: r"C:\p\new.rs".into() }, FileTouch { kind: "edited", path: "lib.rs".into() }]);
        let whole = in_dir(files[1].clone(), Path::new(r"C:\p")).unwrap();
        assert!(claude_code::is_full_path(&whole.path) && whole.path.ends_with("lib.rs"), "{}", whole.path);

        // Declined: nothing was changed.
        feed(&mut run, &change.replace("f1", "f2"));
        feed(&mut run, r#"{"method":"item/completed","params":{"item":{"type":"fileChange","id":"f2","status":"declined"}}}"#);
        assert!(run.take_files().is_empty());
    }

    #[test]
    fn codexs_plan_goes_on_once_each_time_it_changes() {
        let mut run = Run::default();
        let line = r#"{"method":"turn/plan/updated","params":{"plan":[{"step":"Read","status":"completed"},{"step":"Write","status":"inProgress"}],"explanation":null}}"#;
        feed(&mut run, line);
        assert_eq!(run.take_plan().unwrap()["plan"][1]["status"], "inProgress");
        feed(&mut run, line);
        assert!(run.take_plan().is_none());
        feed(&mut run, r#"{"method":"turn/plan/updated","params":{"plan":[]}}"#);
        assert!(run.take_plan().is_none());
    }

    #[test]
    fn codexs_requests_are_its_own_cards_in_the_island() {
        let params = json!({
            "threadId": THREAD, "turnId": "t", "itemId": "call1", "cwd": "C:\\Users\\me\\Lumo",
            "command": "\"powershell.exe\" -Command 'Remove-Item x.txt'",
            "commandActions": [{ "type": "unknown", "command": "Remove-Item x.txt" }],
            "reason": "Clean up",
        });
        let c = card("item/commandExecution/requestApproval", &params, &HashMap::new()).unwrap();
        assert_eq!(c["hook_event_name"], "PermissionRequest");
        assert_eq!(c["lumo_island"], true);
        assert_eq!(c["lumo_agent"], "codex");
        assert_eq!(c["tool_name"], "Bash");
        assert_eq!(c["tool_input"]["command"], "Remove-Item x.txt");
        assert_eq!(c["tool_input"]["justification"], "Clean up");
        // Without Codex's parse, its command as it is.
        let bare = json!({ "threadId": THREAD, "itemId": "c", "command": "git push" });
        assert_eq!(card("item/commandExecution/requestApproval", &bare, &HashMap::new()).unwrap()["tool_input"]["command"], "git push");
        // A file change names its files, from the item Codex started.
        let mut files = HashMap::new();
        files.insert("p1".to_string(), vec!["C:\\a.rs".to_string(), "C:\\b.rs".to_string()]);
        let edit = card("item/fileChange/requestApproval", &json!({ "threadId": THREAD, "itemId": "p1" }), &files).unwrap();
        assert_eq!(edit["tool_name"], "Edit");
        assert_eq!(edit["tool_input"]["file_path"], "C:\\a.rs, C:\\b.rs");
        // Anything else is no card: declined, or not Lumo's to do.
        assert!(card("item/permissions/requestApproval", &json!({}), &HashMap::new()).is_none());
        assert_eq!(other_answer("mcpServer/elicitation/request")["result"]["action"], "decline");
        assert_eq!(other_answer("item/tool/call")["error"]["code"], -32601);
    }

    #[test]
    fn the_chats_modes_are_codexs_own_policies_and_never_full_access() {
        assert_eq!(policy("default"), ("untrusted", json!({ "type": "workspaceWrite", "writableRoots": [], "networkAccess": false })));
        assert_eq!(policy("auto").0, "on-request");
        assert_eq!(policy("plan"), ("untrusted", json!({ "type": "readOnly" })));
        for mode in ["turbo", "bypassPermissions", "danger-full-access", ""] {
            assert_eq!(policy(mode).0, "untrusted", "{mode}");
            assert_ne!(policy(mode).1["type"], "dangerFullAccess");
        }
    }

    #[test]
    fn lumos_tools_go_to_codex_as_its_mcp_servers() {
        let config = mcp_config("chat-1", false, "");
        let lumo = &config["mcp_servers"]["lumo"];
        assert_eq!(lumo["args"], json!(["--mcp", "--tools=island"]));
        assert_eq!(lumo["env"]["LUMO_ISLAND_RUN"], "1");
        assert_eq!(lumo["env"]["LUMO_CHAT_ID"], "chat-1");
        assert_eq!(lumo["default_tools_approval_mode"], "approve");
        assert!(config["mcp_servers"].get(crate::tools::SERVER).is_none());
        let both = mcp_config("chat-1", true, "");
        assert_eq!(both["mcp_servers"][crate::tools::SERVER]["args"], json!(["--mcp", "--tools=user"]));
        let mail = mcp_config("chat-1", false, "mail,mailsend");
        assert_eq!(mail["mcp_servers"]["lumo"]["args"], json!(["--mcp", "--tools=mail,mailsend,island"]));
    }

    #[test]
    fn only_codexs_own_model_ids_and_efforts_are_sent() {
        assert_eq!(safe_model("gpt-6.1-sol"), Some("gpt-6.1-sol"));
        assert_eq!(safe_model("default"), None);
        assert_eq!(safe_model("gpt 6; rm"), None);
        assert_eq!(safe_effort("xhigh"), Some("xhigh"));
        assert_eq!(safe_effort("max"), None);
        let listed = json!({ "data": [
            { "id": "gpt-6.1-sol", "model": "gpt-6.1-sol", "displayName": "GPT-6.1-Sol", "hidden": false },
            { "id": "secret", "model": "secret", "displayName": "Hidden", "hidden": true },
            { "id": "x", "model": "bad model!", "displayName": "Bad" },
        ] });
        assert_eq!(parse_models(&listed), [("gpt-6.1-sol".to_string(), "GPT-6.1-Sol".to_string())]);
    }
}
