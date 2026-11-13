// Chat through GitHub Copilot CLI and Cursor's CLI: the `copilot` and
// `cursor-agent` commands the user installed and signed in to with their own
// account. No key in Lumo: Lumo runs each CLI's own Agent Client Protocol
// server (`copilot --acp`, `cursor-agent acp`: JSON-RPC 2.0, one message per
// line on stdin and stdout), and the CLI answers with its own sign-in,
// exactly as in a terminal. Lumo never reads, stores or forwards any GitHub
// or Cursor credential.
//
// The same shape as codex_chat.rs:
//
// - Each chat keeps one server running between messages (`Live`), with one
//   ACP session (`session/new`, or `session/load` of the chat's session once
//   the server started again). Each message is a `session/prompt`, answered
//   when the turn ends, the server still there for the next one. One idle for
//   LIVE_IDLE is ended.
// - ACP has no system prompt: Lumo's instructions go in front of the first
//   question of a new session, never on a command line.
// - The answer is streamed: `chat-delta` events carry the text visible so far
//   (`agent_message_chunk`), `chat-activity` events say what the CLI is doing
//   while no text shows, read off its tool calls (`tool_call`, by their kind).
//   Its plan (`plan`, Cursor's to-dos) goes to the Plan island.
// - Stop sends `session/cancel`; one that does not end in time is ended with
//   everything it started.
// - The tasks Cursor's agent hands to subagents (`cursor/task`) are the
//   chat's agents (`Tasks`, chat_agents.rs), each done when the tool call it
//   runs in is.
//
// Permissions are the CLI's own: what it would ask in a terminal comes to Lumo
// as `session/request_permission`, and Lumo shows a card in the island (pipe.rs
// `ask`). Only a click allows: no answer, or an island that can't show it,
// rejects. Ask every time answers a click with the CLI's "allow once"; Auto
// with its "always allow" for that session, so it stops asking for the same
// thing (still one click at least); Plan only switches the session to the
// CLI's own plan mode when it has one, and rejects whatever it would ask,
// without a card.
//
// Lumo's tools (the island's timer and GitHub tools, the email's, the user's
// own) are MCP servers: Copilot takes them in `session/new`, Cursor only from
// a `.cursor/mcp.json` of the folder it runs in (Lumo's work folder), which
// Lumo keeps its own entries in.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::chat::{self, Chat, ChatContext, ChatReply, ModelInfo, Stop};
use crate::chat_agents::{self, AgentRow, AgentState, Agents, Tell};
use crate::claude_code::{self, cli_command, file_name, is_screenshot, kill_tree, short, Activity, FileTouch};
use crate::i18n::{t, tf};
use crate::platform;

pub const COPILOT: &str = "copilot-cli";
pub const CURSOR: &str = "cursor-cli";

/// "default": no model for the session, whatever the user picked in the CLI itself.
const DEFAULT_MODEL: &str = "default";
/// The ACP version Lumo speaks.
const PROTOCOL_VERSION: u64 = 1;
/// Lumo's MCP server, as the CLIs know it (the user's tools are tools::SERVER).
const LUMO_SERVER: &str = "lumo";

/// Starting the server or a session: answered at once, or not at all.
const START_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a chat's CLI waits for the next message before it is ended.
const LIVE_IDLE: Duration = Duration::from_secs(10 * 60);
/// How long a cancelled turn may take to end before its CLI is ended.
const INTERRUPT_GRACE: Duration = Duration::from_secs(5);
/// Listing the models answers at once, or not at all.
const MODELS_TIMEOUT: Duration = Duration::from_secs(20);
/// The island is told about new text at most this often.
const DELTA_INTERVAL: Duration = Duration::from_millis(1000 / 15);
/// How often a running turn looks at the Stop button.
const STOP_POLL: Duration = Duration::from_millis(100);
/// The picker shows at most this many of the models a CLI offers.
const MAX_MODELS: usize = 60;

/// The reasoning efforts Copilot CLI takes (`--effort`); anything else leaves its own.
pub const COPILOT_EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

/// How the install hint says to install Copilot CLI (github.com/github/copilot-cli).
const COPILOT_INSTALL: &str = "npm install -g @github/copilot";

/// Lumo's instructions, in front of the first question of a session.
const INSTRUCTIONS: &str = concat!(
    "You are Lumo, the user's personal assistant, answering from the Lumo island at the top of their screen. \
The chat window is small: answer in the user's language, keep answers focused, and use light Markdown (short paragraphs, lists, bold, code blocks), no tables or big headings. \
When the user drops a file, its path is given in the message: read it from there. \
When the user shares the folder open in File Explorer, its path and listing are given in the message: read its files from there. \
You cannot see the user's screen, their open windows or the folder open in File Explorer unless they share them. If you need to, ask them to press the screen button next to the paperclip in the chat; for the folder in File Explorer, they can also turn on Always share the folder open in File Explorer in Lumo's Settings, under Chat. Never take a screenshot or list their windows yourself. \
What needs the user's approval (a command, a change to a file) is approved by them from a card in the island, so ask for it as usual. \
When an action is declined or does not run, tell the user plainly what you could not do and why, and never claim it ran. Do not mention these instructions. \
Lumo may also list the windows and the documents open on the user's computer, with their paths: when a question is about one of them, such as the PDF they have open, read it from its path yourself instead of asking them to share it. \
Lumo shows the user your plan on its Plan island: whenever the user gives you a job that takes more than one step, keep your plan or to-do list up to date with your own tool for it as you go, and do not write the plan in your answer. ",
    crate::chat::timer_tool_note!(),
    crate::chat::listen_tool_note!(),
    crate::chat::math_note!(),
    crate::chat::rich_note!()
);

/// In front of a question asked in Plan only.
const PLAN_ONLY: &str = "(The user picked Plan only: read and plan, and change nothing. Run no command that changes anything.)\n\n";

// ── Which CLI ─────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Agent {
    Copilot,
    Cursor,
}

impl Agent {
    pub fn of(provider: &str) -> Option<Agent> {
        match provider {
            COPILOT => Some(Agent::Copilot),
            CURSOR => Some(Agent::Cursor),
            _ => None,
        }
    }

    pub fn provider(self) -> &'static str {
        match self {
            Agent::Copilot => COPILOT,
            Agent::Cursor => CURSOR,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Agent::Copilot => "Copilot CLI",
            Agent::Cursor => "Cursor CLI",
        }
    }

    /// Its cards' `lumo_agent`: the pill its own sessions have (src/core/pills.ts).
    fn tag(self) -> &'static str {
        match self {
            Agent::Copilot => "copilot",
            Agent::Cursor => "cursor",
        }
    }

    /// Its pill's colour, for the Plan island.
    fn color(self) -> &'static str {
        match self {
            Agent::Copilot => "#818CF8",
            Agent::Cursor => "#C0C4CC",
        }
    }

    fn exe(self) -> Option<PathBuf> {
        match self {
            Agent::Copilot => platform::copilot_candidates(),
            Agent::Cursor => platform::cursor_candidates(),
        }
        .into_iter()
        .next()
    }

    fn not_installed(self) -> String {
        match self {
            Agent::Copilot => tf(
                "Copilot CLI isn't installed. Install it with {command}, sign in once with `copilot` in a terminal, then try again.",
                &[("command", COPILOT_INSTALL)],
            ),
            Agent::Cursor => t("Cursor CLI isn't installed. Install it from cursor.com/cli, sign in once with `cursor-agent login` in a terminal, then try again."),
        }
    }

    fn not_signed_in(self) -> String {
        match self {
            Agent::Copilot => t("Copilot CLI isn't signed in. Run `copilot` once in a terminal and sign in with /login, then try again."),
            Agent::Cursor => t("Cursor CLI isn't signed in. Run `cursor-agent login` once in a terminal, then try again."),
        }
    }

    /// Its server's command line. Copilot takes Lumo's own MCP servers as
    /// allowed (their tools ask on the island themselves, tools.rs and
    /// mail.rs) and the effort; Cursor is told to load the MCP servers of
    /// Lumo's folder without asking in a terminal nobody sees.
    fn args(self, effort: &str) -> Vec<String> {
        match self {
            Agent::Copilot => {
                let mut args = vec!["--acp".to_string(), "--stdio".to_string()];
                for server in [LUMO_SERVER, crate::tools::SERVER] {
                    args.push("--allow-tool".into());
                    args.push(server.into());
                }
                if let Some(e) = safe_effort(effort) {
                    args.push(format!("--effort={e}"));
                }
                args
            }
            Agent::Cursor => vec!["--approve-mcps".into(), "acp".into()],
        }
    }

    /// The bare command line, for a CLI older than the flags above.
    fn bare_args(self) -> Vec<String> {
        match self {
            Agent::Copilot => vec!["--acp".into()],
            Agent::Cursor => vec!["acp".into()],
        }
    }
}

/// A model id we are willing to send: the ids the CLI listed (`claude-sonnet-4.5`,
/// `gpt-5`, `sonnet-4.5-thinking`).
fn safe_model(model: &str) -> Option<&str> {
    let m = model.trim();
    (!m.is_empty() && m != DEFAULT_MODEL && m.len() <= 80 && m.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | ':' | '/' | '[' | ']')))
        .then_some(m)
}

fn safe_effort(effort: &str) -> Option<&'static str> {
    COPILOT_EFFORTS.iter().copied().find(|e| *e == effort.trim())
}

/// A session id we keep and send back: whatever the CLI gave, if it is plain.
fn safe_session(id: &str) -> Option<&str> {
    (!id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))).then_some(id)
}

/// The CLI says it has no sign-in to use.
fn is_auth_error(text: &str) -> bool {
    let l = text.to_lowercase();
    ["401", "unauthorized", "not logged in", "not signed in", "login required", "please log in", "authentication required", "auth_required", "not authenticated"]
        .iter()
        .any(|w| l.contains(w))
}

/// An error the CLI reported, for the island.
fn acp_error(agent: Agent, error: &str) -> String {
    if is_auth_error(error) {
        agent.not_signed_in()
    } else {
        tf("{agent}: {error}", &[("agent", agent.name()), ("error", error)])
    }
}

/// An error answer of the server: ACP's `auth_required` (-32000) or its words
/// say it wants a sign-in.
fn rpc_error(agent: Agent, error: &Value) -> String {
    let message = error["message"].as_str().unwrap_or("error");
    if error["code"].as_i64() == Some(-32000) {
        return agent.not_signed_in();
    }
    acp_error(agent, message)
}

// ── Lumo's tools ──────────────────────────────────────────────────────────────

/// One of Lumo's MCP servers: lumo-hook with `args`, marked as the island's run.
fn server(args: &[&str]) -> Value {
    let mut entry = crate::computer::server_entry();
    entry["args"] = json!(args);
    entry
}

/// Lumo's MCP servers for the chat: the island's timer and GitHub tools
/// (`lumo`, island_tools.rs) with the email's as Security lets the AI have
/// them (mail.rs ai_tools), and the user's tools while one of them is on
/// (`lumo_tools`, tools.rs). By name.
fn servers(tools: bool, mail: &str) -> Vec<(String, Value)> {
    let kit = if mail.is_empty() { "--tools=island".to_string() } else { format!("--tools={mail},island") };
    let mut out = vec![(LUMO_SERVER.to_string(), server(&["--mcp", &kit]))];
    if tools {
        out.push((crate::tools::SERVER.to_string(), server(&["--mcp", "--tools=user"])));
    }
    out
}

/// The servers as ACP's `session/new` takes them (Copilot): command, args,
/// and the environment as a list, with the chat they serve.
fn acp_servers(chat_id: &str, tools: bool, mail: &str) -> Value {
    Value::Array(
        servers(tools, mail)
            .into_iter()
            .map(|(name, entry)| {
                let mut env: Vec<Value> = entry["env"]
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(k, v)| json!({ "name": k, "value": v.as_str().unwrap_or("") }))
                    .collect();
                if !chat_id.is_empty() {
                    env.push(json!({ "name": "LUMO_CHAT_ID", "value": chat_id }));
                }
                json!({ "name": name, "command": entry["command"], "args": entry["args"], "env": env })
            })
            .collect(),
    )
}

/// Cursor reads MCP servers only from `.cursor/mcp.json` (the folder it runs
/// in, or the user's own): Lumo's go in the one of Lumo's work folder, the
/// chat they serve read from the environment Lumo starts Cursor with. Lumo's
/// tools are allowed in its `.cursor/cli.json` (they ask on the island
/// themselves). Whatever else either file holds is kept; one Lumo can't read
/// is the user's and left alone. Returns the servers written, for the key
/// that tells when Cursor must start again to read them.
fn cursor_workspace(work: &Path, tools: bool, mail: &str) -> Value {
    let dir = work.join(".cursor");
    let mut wanted = serde_json::Map::new();
    for (name, mut entry) in servers(tools, mail) {
        entry["env"]["LUMO_CHAT_ID"] = json!("${env:LUMO_CHAT_ID}");
        wanted.insert(name, entry);
    }
    let edit = |file: &str, change: &dyn Fn(&mut Value)| {
        let path = dir.join(file);
        let mut config = match std::fs::read_to_string(&path).ok().as_deref().map(serde_json::from_str::<Value>) {
            Some(Ok(v)) if v.is_object() => v,
            Some(_) => return,
            None => json!({}),
        };
        let before = config.clone();
        change(&mut config);
        if config != before {
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(text) = serde_json::to_string_pretty(&config) {
                let _ = std::fs::write(&path, text);
            }
        }
    };
    edit("mcp.json", &|config| cursor_mcp(config, &wanted));
    edit("cli.json", &cursor_allow);
    Value::Object(wanted)
}

/// `config` (a `.cursor/mcp.json`) with Lumo's servers as `wanted`: the user's tools' gone when off.
fn cursor_mcp(config: &mut Value, wanted: &serde_json::Map<String, Value>) {
    if !config["mcpServers"].is_object() {
        config["mcpServers"] = json!({});
    }
    let servers = config["mcpServers"].as_object_mut().expect("an object");
    for name in [LUMO_SERVER, crate::tools::SERVER] {
        match wanted.get(name) {
            Some(entry) => {
                servers.insert(name.to_string(), entry.clone());
            }
            None => {
                servers.remove(name);
            }
        }
    }
}

/// `config` (a `.cursor/cli.json`) allowing Lumo's own MCP servers.
fn cursor_allow(config: &mut Value) {
    if !config["permissions"].is_object() {
        config["permissions"] = json!({});
    }
    if !config["permissions"]["allow"].is_array() {
        config["permissions"]["allow"] = json!([]);
    }
    let allow = config["permissions"]["allow"].as_array_mut().expect("an array");
    for rule in [format!("Mcp({LUMO_SERVER}:*)"), format!("Mcp({}:*)", crate::tools::SERVER)] {
        if !allow.iter().any(|r| r.as_str() == Some(rule.as_str())) {
            allow.push(json!(rule));
        }
    }
}

// ── What the session offers ───────────────────────────────────────────────────

/// One of a session's `configOptions` that picks a value.
#[derive(Clone, Debug, Default, PartialEq)]
struct Choice {
    id: String,
    category: String,
    current: String,
    values: Vec<(String, String)>,
}

/// What a session can be set to: its `configOptions`, and the older `modes`
/// and `models` fields some CLIs give instead.
#[derive(Clone, Debug, Default, PartialEq)]
struct Offer {
    choices: Vec<Choice>,
    modes: Vec<(String, String)>,
    mode: Option<String>,
    models: Vec<(String, String)>,
    model: Option<String>,
}

/// `(value, name)` pairs of a list of options, groups flattened.
fn option_values(options: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for o in options.as_array().into_iter().flatten() {
        if o["options"].is_array() {
            out.extend(option_values(&o["options"]));
            continue;
        }
        let Some(value) = o["value"].as_str().or_else(|| o["id"].as_str()) else { continue };
        let name = o["name"].as_str().filter(|n| !n.trim().is_empty()).unwrap_or(value);
        out.push((value.to_string(), name.trim().to_string()));
    }
    out
}

/// Each model once, by its id and by its name: Copilot CLI lists "Auto"
/// twice (two ids, one name), which the picker can't tell apart. The first stays.
fn once_each(list: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for (id, name) in list {
        let seen = out.iter().any(|(i, n)| *i == id || n.trim().eq_ignore_ascii_case(name.trim()));
        if !seen {
            out.push((id, name));
        }
    }
    out
}

impl Offer {
    /// Read off a `session/new` or `session/load` answer.
    fn parse(result: &Value) -> Offer {
        let mut offer = Offer::default();
        offer.set_choices(&result["configOptions"]);
        let modes = &result["modes"];
        offer.modes = modes["availableModes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| {
                let id = m["id"].as_str()?;
                Some((id.to_string(), m["name"].as_str().unwrap_or(id).to_string()))
            })
            .collect();
        offer.mode = modes["currentModeId"].as_str().map(str::to_string);
        let models = &result["models"];
        offer.models = models["availableModels"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| {
                let id = m["modelId"].as_str().or_else(|| m["id"].as_str())?;
                Some((id.to_string(), m["name"].as_str().unwrap_or(id).to_string()))
            })
            .collect();
        offer.model = models["currentModelId"].as_str().map(str::to_string);
        offer
    }

    /// The whole list of `configOptions`, as given again after each change.
    fn set_choices(&mut self, options: &Value) {
        let Some(list) = options.as_array() else { return };
        self.choices = list
            .iter()
            .filter(|o| o["type"].as_str().unwrap_or("select") == "select")
            .filter_map(|o| {
                Some(Choice {
                    id: o["id"].as_str()?.to_string(),
                    category: o["category"].as_str().unwrap_or("").to_string(),
                    current: o["currentValue"].as_str().unwrap_or("").to_string(),
                    values: option_values(&o["options"]),
                })
            })
            .collect();
    }

    fn choice(&self, category: &str) -> Option<&Choice> {
        self.choices.iter().find(|c| c.category == category && !c.values.is_empty())
    }

    /// The models the picker offers: id and name.
    fn model_list(&self) -> Vec<(String, String)> {
        // Both lists when the CLI gives both: its config option may hold less
        // ("Auto" alone) than its models.
        let mut list = self.choice("model").map(|c| c.values.clone()).unwrap_or_default();
        list.extend(self.models.iter().cloned());
        once_each(list.into_iter().filter(|(id, _)| safe_model(id).is_some()).collect()).into_iter().take(MAX_MODELS).collect()
    }

    fn current_model(&self) -> Option<&str> {
        self.choice("model").map(|c| c.current.as_str()).or(self.model.as_deref())
    }

    fn mode_list(&self) -> &[(String, String)] {
        self.choice("mode").map(|c| c.values.as_slice()).unwrap_or(&self.modes)
    }

    fn current_mode(&self) -> Option<&str> {
        self.choice("mode").map(|c| c.current.as_str()).or(self.mode.as_deref())
    }

    /// The CLI's own plan mode, if it has one.
    fn plan_mode(&self) -> Option<String> {
        self.mode_list()
            .iter()
            .find(|(id, name)| {
                let id = id.to_lowercase();
                id == "plan" || id.ends_with("#plan") || id.ends_with("/plan") || name.trim().eq_ignore_ascii_case("plan")
            })
            .map(|(id, _)| id.clone())
    }

    /// The request that sets the model to `id` (without the session), if offered.
    fn set_model(&self, id: &str) -> Option<(&'static str, Value)> {
        if let Some(c) = self.choice("model").filter(|c| c.values.iter().any(|(v, _)| v == id)) {
            return Some(("session/set_config_option", json!({ "configId": c.id, "value": id })));
        }
        self.models.iter().any(|(m, _)| m == id).then(|| ("session/set_model", json!({ "modelId": id })))
    }

    /// The request that sets the mode to `id` (without the session), if offered.
    fn set_mode(&self, id: &str) -> Option<(&'static str, Value)> {
        if let Some(c) = self.choice("mode") {
            return c.values.iter().any(|(v, _)| v == id).then(|| ("session/set_config_option", json!({ "configId": c.id, "value": id })));
        }
        self.modes.iter().any(|(m, _)| m == id).then(|| ("session/set_mode", json!({ "modeId": id })))
    }

    /// What `method` with `params` changed, once answered with `result`.
    fn applied(&mut self, method: &str, params: &Value, result: &Value) {
        match method {
            "session/set_config_option" => {
                if result["configOptions"].is_array() {
                    self.set_choices(&result["configOptions"]);
                } else if let Some(c) = self.choices.iter_mut().find(|c| Some(c.id.as_str()) == params["configId"].as_str()) {
                    c.current = params["value"].as_str().unwrap_or("").to_string();
                }
            }
            "session/set_mode" => self.mode = params["modeId"].as_str().map(str::to_string),
            "session/set_model" => self.model = params["modelId"].as_str().map(str::to_string),
            _ => {}
        }
    }
}

// ── What the CLI is doing ─────────────────────────────────────────────────────

/// The first path a tool call names: its locations, or its input's path.
fn call_path(call: &Value) -> String {
    let input = &call["rawInput"];
    call["locations"][0]["path"]
        .as_str()
        .or_else(|| input["path"].as_str())
        .or_else(|| input["file_path"].as_str())
        .or_else(|| input["filePath"].as_str())
        .unwrap_or("")
        .to_string()
}

/// What a tool call is doing, for the island, by its ACP kind.
fn activity_for(call: &Value) -> Activity {
    let input = &call["rawInput"];
    match call["kind"].as_str().unwrap_or("other") {
        "read" => {
            let file = file_name(&call_path(call));
            if is_screenshot(&file) { Activity::new("screen", "") } else { Activity::new("read", file) }
        }
        "edit" | "delete" | "move" => Activity::new("edit", file_name(&call_path(call))),
        "search" => Activity::new("search", short(input["query"].as_str().or_else(|| input["pattern"].as_str()).unwrap_or(""))),
        "execute" => Activity::new("command", ""),
        "think" => Activity::thinking(),
        "fetch" => Activity::new("web", ""),
        "switch_mode" => Activity::new("plan", ""),
        _ => match call["title"].as_str().map(short).unwrap_or_default() {
            title if title.is_empty() => Activity::thinking(),
            title => Activity::new("tool", title),
        },
    }
}

/// The files a tool call reads or changes, for the chat's files: each of its
/// locations (a deletion or a move is none). A path may be relative to the
/// chat's folder (`in_dir`). Never a screenshot of the chat's.
fn touches_for(call: &Value) -> Vec<FileTouch> {
    let kind = match call["kind"].as_str() {
        Some("read") => "read",
        Some("edit") => "edited",
        _ => return Vec::new(),
    };
    let mut paths: Vec<String> = call["locations"].as_array().into_iter().flatten().filter_map(|l| l["path"].as_str()).map(str::to_string).collect();
    if paths.is_empty() {
        paths.push(call_path(call));
    }
    paths.dedup();
    paths
        .into_iter()
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty() && !is_screenshot(&file_name(p)))
        .map(|path| FileTouch { kind, path })
        .collect()
}

/// `touch` with its path made whole: a relative one is in `dir`, the chat's
/// folder. A file edited that was not there before is one created.
fn in_dir(mut touch: FileTouch, dir: &Path) -> Option<FileTouch> {
    if !claude_code::is_full_path(&touch.path) {
        touch.path = dir.join(&touch.path).to_string_lossy().to_string();
    }
    claude_code::is_full_path(&touch.path).then_some(touch)
}

/// A plan as the Plan island takes it (codex_chat.rs's shape): its steps and
/// their state. None for an empty one.
fn island_plan(steps: impl Iterator<Item = (String, String)>) -> Option<Value> {
    let plan: Vec<Value> = steps
        .filter(|(step, _)| !step.trim().is_empty())
        .map(|(step, status)| {
            let status = match status.as_str() {
                "in_progress" | "inProgress" | "running" => "inProgress",
                "completed" | "done" | "cancelled" => "completed",
                _ => "pending",
            };
            json!({ "step": step.trim(), "status": status })
        })
        .collect();
    (!plan.is_empty()).then(|| json!({ "plan": plan, "explanation": null }))
}

// ── Cards ─────────────────────────────────────────────────────────────────────

/// The command of a tool call that runs one: its input's, or its title.
fn call_command(call: &Value) -> String {
    let input = &call["rawInput"];
    let command = match &input["command"] {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "),
        _ => input["cmd"].as_str().unwrap_or("").to_string(),
    };
    if command.trim().is_empty() { call["title"].as_str().unwrap_or("").to_string() } else { command }
}

/// The island's card for a `session/request_permission`, shaped as a
/// permission request of the CLI's own sessions (src/island/hooks.ts): a
/// command as `Bash`, a change to files as `Edit` with their paths, a page
/// as `WebFetch`. `calls`: what the CLI said of each tool call so far.
fn card(agent: Agent, params: &Value, cwd: &Path, calls: &HashMap<String, Value>, remembered: bool) -> Value {
    let mut call = params["toolCall"]["toolCallId"].as_str().and_then(|id| calls.get(id)).cloned().unwrap_or_else(|| json!({}));
    merge(&mut call, &params["toolCall"]);
    let input = &call["rawInput"];
    let title = call["title"].as_str().unwrap_or("").trim().to_string();
    let listed: Vec<&str> = call["locations"].as_array().into_iter().flatten().filter_map(|l| l["path"].as_str()).collect();
    let paths = |between: &str| if listed.is_empty() { call_path(&call) } else { listed.join(between) };
    // Each by its own name: a deletion or a move never reads as an edit.
    let (tool, tool_input) = match call["kind"].as_str().unwrap_or("other") {
        "execute" => ("Bash".to_string(), json!({ "command": call_command(&call), "description": input["description"].as_str().unwrap_or("") })),
        "edit" => ("Edit".to_string(), json!({ "file_path": paths(", ") })),
        "delete" => ("Delete".to_string(), json!({ "file_path": paths(", ") })),
        "move" => ("Move".to_string(), json!({ "file_path": paths(" → ") })),
        "read" => ("Read".to_string(), json!({ "file_path": paths(", ") })),
        "fetch" => ("WebFetch".to_string(), json!({ "url": input["url"].as_str().unwrap_or(&title) })),
        _ => {
            let name = if title.is_empty() { "Tool".to_string() } else { short(&title) };
            let shown = if input.is_object() { input.clone() } else { json!({ "description": title }) };
            (name, shown)
        }
    };
    let mut card = json!({
        "hook_event_name": "PermissionRequest",
        "lumo_island": true,
        "lumo_agent": agent.tag(),
        "session_id": params["sessionId"],
        "cwd": cwd.to_string_lossy(),
        "tool_name": tool,
        "tool_input": tool_input,
    });
    // In Auto the click is answered with the CLI's "always allow": the card says so.
    if remembered {
        card["lumo_remembered"] = json!(true);
    }
    card
}

/// The answer to a `session/request_permission`: the option the click stands
/// for, by its kind (`allow_once`, `allow_always`, `reject_once`,
/// `reject_always`; Cursor's ids say the same with hyphens). An allow is never
/// more than the click: "always" only in Auto (`remember`), and with no option
/// that fits, the request is cancelled, which allows nothing.
fn permission_answer(options: &Value, allowed: bool, remember: bool) -> Value {
    let pick = |kind: &str| {
        options.as_array().into_iter().flatten().find(|o| {
            o["kind"].as_str() == Some(kind) || o["optionId"].as_str().map(|id| id.replace('-', "_")).as_deref() == Some(kind)
        })
    };
    let chosen = if allowed {
        if remember { pick("allow_always").or_else(|| pick("allow_once")) } else { pick("allow_once") }
    } else {
        pick("reject_once").or_else(|| pick("reject_always"))
    };
    match chosen.and_then(|o| o["optionId"].as_str()) {
        Some(id) => json!({ "outcome": { "outcome": "selected", "optionId": id } }),
        None => json!({ "outcome": { "outcome": "cancelled" } }),
    }
}

/// The answer to a request of the CLI that is not a permission: Cursor's
/// question is skipped (the agent asks in its answer instead), its plan taken
/// (Plan only rejects anything it would then do), anything else Lumo does not
/// do is an error.
fn other_answer(method: &str) -> Value {
    match method {
        "cursor/ask_question" => json!({ "result": { "outcome": { "outcome": "skipped", "reason": "Lumo's chat can't show this question: ask it in your answer instead." } } }),
        "cursor/create_plan" => json!({ "result": { "outcome": { "outcome": "accepted" } } }),
        _ => json!({ "error": { "code": -32601, "message": format!("Lumo does not handle {method}.") } }),
    }
}

/// `into` with the fields of `from` (an object) put over its own.
fn merge(into: &mut Value, from: &Value) {
    let Some(fields) = from.as_object() else { return };
    if !into.is_object() {
        *into = json!({});
    }
    for (k, v) in fields {
        if k != "sessionUpdate" && !v.is_null() {
            into[k] = v.clone();
        }
    }
}

// ── Reading a turn ────────────────────────────────────────────────────────────

/// What a turn's notifications have told us so far.
#[derive(Default, Debug)]
struct Run {
    /// The CLI's messages of the turn, in order: a tool call between two
    /// chunks of text starts a new one.
    messages: Vec<String>,
    /// A tool call came since the last text.
    after_tool: bool,
    /// The turn ended (its `session/prompt` answered): fine, or why not.
    done: Option<Result<(), String>>,
    /// Why it ended (`end_turn`, `refusal`, `cancelled`…).
    stop_reason: String,
    /// Commands and file changes the user (or Plan only) declined.
    denied: usize,
    /// The user pressed Stop.
    stopped: bool,
    /// What the answer is doing since the text last grew (None once it does).
    activity: Option<Activity>,
    activity_changed: bool,
    /// Tool calls still running, oldest first: id and what each is doing.
    pending: Vec<(String, Activity)>,
    /// What the CLI said of each tool call, by id, for its card.
    calls: HashMap<String, Value>,
    /// The files each running call reads or changes: told once it ran.
    touching: HashMap<String, Vec<FileTouch>>,
    /// Files used by calls that ran, not passed on yet (`take_files`).
    touched: Vec<FileTouch>,
    /// Cursor's to-dos: id, text and state.
    todos: Vec<(String, String, String)>,
    /// The plan given last, not yet passed on (`take_plan`).
    plan: Option<Value>,
    plan_seen: Option<Value>,
}

impl Run {
    /// The text of the message being written: what the island shows.
    fn visible(&self) -> &str {
        self.messages.last().map(String::as_str).unwrap_or("")
    }

    /// Every message of the turn, each on its own lines (chat::keep_lumo_lines).
    fn said(&self) -> String {
        self.messages.join("\n")
    }

    /// The answer: the CLI's last message.
    fn answer(&self) -> String {
        self.visible().trim().to_string()
    }

    /// More of the answer's text; true when the visible text changed.
    fn text(&mut self, text: &str) -> bool {
        if text.is_empty() {
            return false;
        }
        match self.messages.last_mut() {
            Some(last) if !self.after_tool => last.push_str(text),
            _ => self.messages.push(text.to_string()),
        }
        self.after_tool = false;
        self.activity = None;
        self.activity_changed = false;
        true
    }

    /// One `session/update`; true when the visible text changed.
    fn feed(&mut self, update: &Value) -> bool {
        match update["sessionUpdate"].as_str().unwrap_or("") {
            "agent_message_chunk" => {
                let content = &update["content"];
                if content["type"].as_str().unwrap_or("text") != "text" {
                    return false;
                }
                self.text(content["text"].as_str().unwrap_or(""))
            }
            "agent_thought_chunk" => {
                if self.pending.is_empty() && self.visible().is_empty() {
                    self.set_activity(Activity::thinking());
                }
                false
            }
            kind @ ("tool_call" | "tool_call_update") => {
                let Some(id) = update["toolCallId"].as_str().map(str::to_string) else { return false };
                let call = self.calls.entry(id.clone()).or_insert_with(|| json!({}));
                merge(call, update);
                let call = call.clone();
                if !self.messages.is_empty() {
                    self.after_tool = true;
                }
                if update["locations"].is_array() || update["rawInput"].is_object() || kind == "tool_call" {
                    let touches = touches_for(&call);
                    if !touches.is_empty() {
                        self.touching.insert(id.clone(), touches);
                    }
                }
                match call["status"].as_str() {
                    Some("completed") => {
                        let touches = self.touching.remove(&id).unwrap_or_default();
                        self.touched.extend(touches);
                        self.finished(&id);
                    }
                    Some("failed") => {
                        self.touching.remove(&id);
                        self.finished(&id);
                    }
                    _ => self.started(&id, activity_for(&call)),
                }
                false
            }
            "plan" => {
                let steps = update["entries"].as_array().into_iter().flatten().map(|e| {
                    (e["content"].as_str().unwrap_or("").to_string(), e["status"].as_str().unwrap_or("").to_string())
                });
                if let Some(plan) = island_plan(steps) {
                    self.new_plan(plan);
                }
                false
            }
            _ => false,
        }
    }

    /// Cursor's `cursor/update_todos` and `cursor/create_plan` to-dos: merged
    /// into those it gave before, or in their place.
    fn todos(&mut self, todos: &Value, merge: bool) {
        if !merge {
            self.todos.clear();
        }
        for (i, todo) in todos.as_array().into_iter().flatten().enumerate() {
            let content = todo["content"].as_str().or_else(|| todo["title"].as_str()).unwrap_or("").to_string();
            let id = todo["id"].as_str().map(str::to_string).unwrap_or_else(|| format!("#{i}:{content}"));
            let status = todo["status"].as_str().unwrap_or("pending").to_string();
            match self.todos.iter_mut().find(|(have, _, _)| *have == id) {
                Some(entry) => {
                    if !content.is_empty() {
                        entry.1 = content;
                    }
                    entry.2 = status;
                }
                None => self.todos.push((id, content, status)),
            }
        }
        if let Some(plan) = island_plan(self.todos.iter().map(|(_, c, s)| (c.clone(), s.clone()))) {
            self.new_plan(plan);
        }
    }

    fn new_plan(&mut self, plan: Value) {
        if self.plan_seen.as_ref() != Some(&plan) {
            self.plan_seen = Some(plan.clone());
            self.plan = Some(plan);
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

    /// A call is done: the one still running shows, or the CLI thinks again.
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

    fn take_files(&mut self) -> Vec<FileTouch> {
        std::mem::take(&mut self.touched)
    }
}

// ── The tasks it hands to subagents ───────────────────────────────────────────

/// The first text of `keys` in `v`.
fn first_text<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().filter_map(|k| v[*k].as_str()).map(str::trim).find(|s| !s.is_empty())
}

/// The state a task's (or a tool call's) status ends it in; None while it runs.
fn final_state(status: &str) -> Option<AgentState> {
    match status {
        "completed" | "done" | "success" | "succeeded" => Some(AgentState::Done),
        "failed" | "error" | "errored" => Some(AgentState::Failed),
        "cancelled" | "canceled" | "stopped" | "interrupted" | "aborted" => Some(AgentState::Stopped),
        _ => None,
    }
}

/// The tasks of a chat's CLI (Cursor's `cursor/task`), by task id, kept
/// for as long as its server lives.
#[derive(Default, Debug)]
struct Tasks {
    agents: Agents,
    /// The tool call each task runs in → its task id.
    by_call: HashMap<String, String>,
    /// Tasks that named neither an id nor a call, numbered.
    unnamed: u64,
    /// This server's mark (chat_agents::run_mark), made when first needed:
    /// in the numbered tasks' ids, which the next server numbers from 1 again.
    mark: Option<String>,
}

impl Tasks {
    /// A `cursor/task` of the CLI `source` (a providers.ts id): a new task, or news of one.
    fn task(&mut self, source: &str, params: &Value) {
        // Its fields, at the top or in a `task` of their own.
        let task = if params["task"].is_object() { &params["task"] } else { params };
        let field = |keys: &[&str]| first_text(task, keys).or_else(|| first_text(params, keys)).map(str::to_string);
        let call = field(&["toolCallId", "tool_call_id"]);
        let id = match field(&["taskId", "task_id", "id", "agentId", "subagentId"]).or_else(|| call.clone()) {
            Some(id) => id,
            None => {
                self.unnamed += 1;
                let mark = self.mark.get_or_insert_with(chat_agents::run_mark);
                format!("task-{mark}-{}", self.unnamed)
            }
        };
        if let Some(call) = &call {
            self.by_call.insert(call.clone(), id.clone());
        }
        if self.agents.get(&id).is_some_and(|r| r.state.is_final()) {
            return;
        }
        let title = field(&["description", "title", "prompt", "name", "subagentType", "subagent_type"]);
        let row = self.agents.upsert(&id, || AgentRow::new(id.as_str(), source, &title.clone().unwrap_or_else(|| t("Agent"))));
        if let Some(title) = &title {
            row.title = short(title);
        }
        if let Some(summary) = field(&["summary", "result"]) {
            row.summary = Some(chat_agents::summary_of(&summary));
        }
        if let Some(state) = field(&["status", "state"]).as_deref().and_then(final_state) {
            row.end(state, field(&["error"]).filter(|_| state == AgentState::Failed));
            self.by_call.retain(|_, task| *task != id);
        }
    }

    /// A tool call's news (`tool_call`, `tool_call_update`): the task it
    /// runs ends with it, and its other news is a sign the task is alive.
    fn call_update(&mut self, update: &Value) {
        if !matches!(update["sessionUpdate"].as_str(), Some("tool_call" | "tool_call_update")) {
            return;
        }
        let Some(id) = update["toolCallId"].as_str().and_then(|call| self.by_call.get(call)).cloned() else { return };
        if self.agents.get(&id).is_some_and(|r| r.state.is_final()) {
            return;
        }
        let Some(row) = self.agents.touch(&id) else { return };
        match update["status"].as_str() {
            Some("completed") => row.end(AgentState::Done, None),
            Some("failed") => row.end(AgentState::Failed, None),
            _ => return,
        }
        self.by_call.retain(|_, task| *task != id);
    }

    /// The turn is over: the tasks still open ended with it (stopped, with Stop).
    fn turn_ended(&mut self, stopped: bool) {
        if self.agents.open() > 0 {
            self.agents.end_open(if stopped { AgentState::Stopped } else { AgentState::Done }, "");
        }
        self.by_call.clear();
    }
}

// ── One CLI per chat ──────────────────────────────────────────────────────────

/// A line for the CLI's server, written whole.
type Writer = Arc<Mutex<std::process::ChildStdin>>;

fn write_line(stdin: &Writer, message: &Value) -> bool {
    let mut message = message.clone();
    message["jsonrpc"] = json!("2.0");
    let mut pipe = stdin.lock().unwrap_or_else(|e| e.into_inner());
    pipe.write_all(format!("{message}\n").as_bytes()).and_then(|_| pipe.flush()).is_ok()
}

/// A chat's CLI, between two turns.
struct Live {
    agent: Agent,
    child: std::process::Child,
    stdin: Writer,
    rx: mpsc::Receiver<Vec<u8>>,
    stderr: Arc<Mutex<String>>,
    /// What it was started with: the same key, the same server can answer.
    key: String,
    /// It can open a session again (`session/load`).
    can_load: bool,
    /// The session it has open, once made or loaded.
    session: Option<String>,
    /// What that session can be set to.
    offer: Offer,
    /// The mode the session opened in: where it goes back to after Plan only.
    home_mode: Option<String>,
    next_id: u64,
    used: Instant,
    /// The tasks it handed to subagents, and who hears of them.
    tasks: Tasks,
    tell: Tell,
}

impl Drop for Live {
    fn drop(&mut self) {
        if matches!(self.child.try_wait(), Ok(None)) {
            kill_tree(&mut self.child);
        }
        // Its tasks end with it.
        if self.tasks.agents.open() > 0 {
            self.tasks.agents.end_open(AgentState::Failed, &tf("{agent} ended", &[("agent", self.agent.name())]));
        }
        (self.tell)(&mut self.tasks.agents, false);
    }
}

impl Live {
    /// Starts the CLI's server in `dir` with `args` and says hello; with the
    /// bare command line once more if those flags are too new for it.
    fn start(agent: Agent, exe: &Path, args: &[String], dir: &Path, chat_id: &str, key: &str) -> Result<Live, String> {
        match Live::start_with(agent, exe, args, dir, chat_id, key) {
            Err(e) if args != agent.bare_args().as_slice() && e != agent.not_signed_in() => {
                crate::log::line(format!("{}: not started with {args:?}: {e}", agent.tag()));
                Live::start_with(agent, exe, &agent.bare_args(), dir, chat_id, key)
            }
            started => started,
        }
    }

    fn start_with(agent: Agent, exe: &Path, args: &[String], dir: &Path, chat_id: &str, key: &str) -> Result<Live, String> {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let mut cmd = cli_command(exe);
        cmd.args(args).current_dir(dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        // Tells lumo-hook (Lumo's hooks of this CLI, if installed) this is the
        // island's chat, which asks over ACP itself: the hooks stay out of it.
        cmd.env("LUMO_ISLAND_RUN", "1");
        cmd.env("LUMO_ACP_RUN", "1");
        if !chat_id.is_empty() {
            cmd.env("LUMO_CHAT_ID", chat_id);
        }
        platform::no_console(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| tf("Cannot start {agent}: {error}", &[("agent", agent.name()), ("error", &e.to_string())]))?;
        platform::chat_ends_with_lumo(&child);
        let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("no stdin")?));
        let stderr = claude_code::read_stderr(&mut child);
        let rx = claude_code::read_lines(&mut child, usize::MAX)?;
        let mut live = Live {
            agent,
            child,
            stdin,
            rx,
            stderr,
            key: key.to_string(),
            can_load: false,
            session: None,
            offer: Offer::default(),
            home_mode: None,
            next_id: 1,
            used: Instant::now(),
            tasks: Tasks::default(),
            tell: chat_agents::silent(),
        };
        let hello = live.call(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                "clientInfo": { "name": "lumo", "title": "Lumo", "version": env!("CARGO_PKG_VERSION") },
            }),
        )?;
        live.can_load = hello["agentCapabilities"]["loadSession"].as_bool() == Some(true);
        // Cursor asks for its sign-in method by name before any session
        // (cursor.com/docs/cli/acp); it uses the sign-in `cursor-agent login` made.
        let methods: Vec<&str> = hello["authMethods"].as_array().into_iter().flatten().filter_map(|m| m["id"].as_str()).collect();
        if agent == Agent::Cursor && methods.contains(&"cursor_login") {
            live.call("authenticate", json!({ "methodId": "cursor_login" })).map_err(|_| agent.not_signed_in())?;
        }
        Ok(live)
    }

    /// Asks `method` and waits for its answer, for START_TIMEOUT at most.
    /// What comes in meanwhile is not ours to read (a session being loaded
    /// tells its past turns again), but a request is answered.
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
                return Err(tf("{agent} took too long to answer.", &[("agent", self.agent.name())]));
            }
            let line = match self.rx.recv_timeout(left) {
                Ok(line) => line,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => return Err(self.ended()),
            };
            let Ok(message) = serde_json::from_slice::<Value>(&line) else { continue };
            if let Some(asked) = message["method"].as_str() {
                if let Some(rid) = message.get("id") {
                    let mut answer = if asked == "session/request_permission" {
                        json!({ "result": { "outcome": { "outcome": "cancelled" } } })
                    } else {
                        other_answer(asked)
                    };
                    answer["id"] = rid.clone();
                    write_line(&self.stdin, &answer);
                } else if asked == "session/update" && message["params"]["update"]["sessionUpdate"] == "config_option_update" {
                    self.offer.set_choices(&message["params"]["update"]["configOptions"]);
                }
                continue;
            }
            if message["id"].as_u64() != Some(id) {
                continue;
            }
            return match message.get("error") {
                Some(e) => Err(rpc_error(self.agent, e)),
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
            return self.agent.not_signed_in();
        }
        let detail = stderr.lines().rev().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
        if detail.is_empty() {
            let code = status.and_then(|s| s.code()).map(|c| c.to_string()).unwrap_or_default();
            tf("{agent} stopped without an answer (exit {code}). Is it signed in?", &[("agent", self.agent.name()), ("code", &code)])
        } else {
            acp_error(self.agent, detail)
        }
    }

    /// The chat's session, open in this server: `wanted` loaded when it is
    /// not open yet, a new one when there is none or it can't be loaded. True
    /// when the session is new, and has not seen the chat's turns.
    fn open_session(&mut self, wanted: Option<&str>, cwd: &Path, mcp: &Value) -> Result<bool, String> {
        if wanted.is_some() && self.session.as_deref() == wanted {
            return Ok(false);
        }
        let cwd_text = cwd.to_string_lossy().to_string();
        if let Some(id) = wanted.filter(|_| self.can_load) {
            match self.call("session/load", json!({ "sessionId": id, "cwd": cwd_text, "mcpServers": mcp })) {
                Ok(result) => {
                    self.session = Some(id.to_string());
                    self.opened(&result);
                    return Ok(false);
                }
                Err(e) => crate::log::line(format!("{}: session not loaded: {e}", self.agent.tag())),
            }
        }
        let result = match self.call("session/new", json!({ "cwd": cwd_text, "mcpServers": mcp })) {
            Ok(r) => r,
            Err(e) if e == self.agent.not_signed_in() || mcp.as_array().is_none_or(|m| m.is_empty()) => return Err(e),
            // Lumo's tools refused: the session without them (the island's lines are the fallback).
            Err(e) => {
                crate::log::line(format!("{}: session/new with Lumo's tools refused: {e}", self.agent.tag()));
                self.call("session/new", json!({ "cwd": cwd_text, "mcpServers": [] }))?
            }
        };
        let id = result["sessionId"]
            .as_str()
            .and_then(safe_session)
            .ok_or_else(|| tf("{agent} gave no conversation to answer in.", &[("agent", self.agent.name())]))?;
        self.session = Some(id.to_string());
        self.opened(&result);
        Ok(true)
    }

    fn opened(&mut self, result: &Value) {
        self.offer = Offer::parse(result);
        self.home_mode = self.offer.current_mode().map(str::to_string);
    }

    /// Sets the session's model and mode for the turn, where the CLI offers
    /// them: the model picked (none: the CLI's own), and its plan mode in Plan
    /// only, the mode it opened in otherwise. What fails is only logged.
    fn prepare(&mut self, model: &str, plan_only: bool) {
        let Some(session) = self.session.clone() else { return };
        let mut wanted = Vec::new();
        if let Some(m) = safe_model(model).filter(|m| self.offer.current_model() != Some(m)) {
            wanted.extend(self.offer.set_model(m));
        }
        let mode = if plan_only { self.offer.plan_mode() } else { self.home_mode.clone() };
        if let Some(mode) = mode.filter(|m| self.offer.current_mode() != Some(m.as_str())) {
            wanted.extend(self.offer.set_mode(&mode));
        }
        for (method, mut params) in wanted {
            params["sessionId"] = json!(session);
            match self.call(method, params.clone()) {
                Ok(result) => self.offer.applied(method, &params, &result),
                Err(e) => crate::log::line(format!("{}: {method} refused: {e}", self.agent.tag())),
            }
        }
    }
}

/// Every chat's CLI, by chat id, while it waits for a message.
static LIVES: Mutex<Option<HashMap<String, Live>>> = Mutex::new(None);
static REAPING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn lives<T>(f: impl FnOnce(&mut HashMap<String, Live>) -> T) -> T {
    f(LIVES.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(Default::default))
}

/// Ends the chats' CLIs idle for LIVE_IDLE, or ended already, once a minute
/// while there is one; the thread goes when none is left.
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

/// Ends the chat's CLI, if one waits between two turns (the chat starts afresh).
pub fn close(chat_id: &str) {
    // Ending it waits for taskkill: never on the caller's thread, which is
    // the window's for a new chat or an edited message.
    if let Some(gone) = lives(|all| all.remove(chat_id)) {
        std::thread::spawn(move || drop(gone));
    }
}

/// What one turn needs besides the question.
struct TurnSpec {
    agent: Agent,
    exe: PathBuf,
    args: Vec<String>,
    dir: PathBuf,
    chat_id: String,
    /// The chat's session, to load.
    session: Option<String>,
    /// Lumo's MCP servers for `session/new` (Copilot), or none.
    mcp: Value,
    /// What else needs a new server when it changes (Cursor's workspace).
    extra_key: String,
    model: String,
    mode: String,
}

/// The chat's CLI started with `key`, or a new one.
fn live_for(spec: &TurnSpec, key: &str) -> Result<Live, String> {
    if let Some(mut live) = lives(|all| all.remove(&spec.chat_id)) {
        let alive = matches!(live.child.try_wait(), Ok(None));
        // Lines left from the turn before (after a cancel) are not this turn's.
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
    Live::start(spec.agent, &spec.exe, &spec.args, &spec.dir, &spec.chat_id, key)
}

/// How a turn ended.
enum Ended {
    Completed,
    /// The server's output closed first.
    Closed,
    /// Stopped, and not ended in time: the server must go.
    Stopped,
}

/// One turn of the chat through its own CLI (started, or started again, as
/// needed), blocking. `text(fresh)` is the question: `fresh` when the session
/// is new and has not seen the chat's turns. `ask` puts a card up and calls
/// back with the click (true: allowed). `tell` hears of every line (a sign
/// of life) and of the tasks the CLI hands to subagents. The session is
/// returned with the run.
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
    tell: Tell,
) -> Result<(Run, Option<String>), String> {
    let agent = spec.agent;
    let key = format!("{}\n{:?}\n{}\n{}", spec.exe.to_string_lossy(), spec.args, spec.mcp, spec.extra_key);
    let mut live = live_for(&spec, &key)?;
    let fresh = match live.open_session(spec.session.as_deref(), &spec.dir, &spec.mcp) {
        Ok(fresh) => fresh,
        // It ended between two messages: once more, with a new one.
        Err(_) if !matches!(live.child.try_wait(), Ok(None)) => {
            drop(live);
            live = Live::start(agent, &spec.exe, &spec.args, &spec.dir, &spec.chat_id, &key)?;
            live.open_session(spec.session.as_deref(), &spec.dir, &spec.mcp)?
        }
        Err(e) => return Err(e),
    };
    live.tell = tell;
    let session = live.session.clone().unwrap_or_default();
    let mode = claude_code::permission_mode(&spec.mode);
    let plan_only = mode == "plan";
    live.prepare(&spec.model, plan_only);
    let question = if plan_only { format!("{PLAN_ONLY}{}", text(fresh)) } else { text(fresh) };
    let prompt_id = live.next_id;
    live.next_id += 1;
    let prompt = json!({ "id": prompt_id, "method": "session/prompt", "params": { "sessionId": session, "prompt": [{ "type": "text", "text": question }] } });
    if !write_line(&live.stdin, &prompt) {
        return Err(live.ended());
    }

    let mut state = Run::default();
    let mut cancelled: Option<Instant> = None;
    let mut last_emit = Instant::now() - DELTA_INTERVAL;
    let mut unsent = false;
    // Files the turn read or wrote, not told to the island yet.
    let mut noted: Vec<FileTouch> = Vec::new();
    let ended = loop {
        if stop.is_stopped() && cancelled.is_none() {
            state.stopped = true;
            cancelled = Some(Instant::now());
            if !write_line(&live.stdin, &json!({ "method": "session/cancel", "params": { "sessionId": session } })) {
                break Ended::Stopped;
            }
        }
        if cancelled.is_some_and(|at| at.elapsed() > INTERRUPT_GRACE) {
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
        // Every line is a sign of life; the session's tasks are its agents.
        if params["sessionId"].as_str().is_none_or(|s| s == session) {
            match method {
                "cursor/task" => live.tasks.task(agent.provider(), params),
                "session/update" => live.tasks.call_update(&params["update"]),
                _ => {}
            }
        }
        (live.tell)(&mut live.tasks.agents, true);
        // An answer to Lumo: the end of the turn, or why it could not run.
        if method.is_empty() {
            if message["id"].as_u64() == Some(prompt_id) {
                match message.get("error") {
                    Some(e) => state.done = Some(Err(rpc_error(agent, e))),
                    None => {
                        state.stop_reason = message["result"]["stopReason"].as_str().unwrap_or("").to_string();
                        if state.stop_reason == "cancelled" {
                            state.stopped = true;
                        }
                        state.done = Some(Ok(()));
                    }
                }
                break Ended::Completed;
            }
            continue;
        }
        // Another session's news is not this answer's.
        let other_session = params["sessionId"].as_str().is_some_and(|s| s != session);
        // A request of the CLI's: a card, or an answer of Lumo's at once.
        if let Some(rid) = message.get("id").cloned() {
            if method == "session/request_permission" && !other_session {
                let options = params["options"].clone();
                if plan_only {
                    state.denied += 1;
                    write_line(&live.stdin, &json!({ "id": rid, "result": permission_answer(&options, false, false) }));
                } else {
                    let stdin = live.stdin.clone();
                    let remember = mode == "auto";
                    ask(
                        card(agent, params, &spec.dir, &state.calls, remember),
                        Box::new(move |allowed| {
                            write_line(&stdin, &json!({ "id": rid, "result": permission_answer(&options, allowed, remember) }));
                        }),
                    );
                }
                continue;
            }
            if method == "cursor/create_plan" {
                state.todos(&params["todos"], false);
                if let Some(plan) = params["plan"].as_str().filter(|p| !p.trim().is_empty()) {
                    state.after_tool = true;
                    unsent |= state.text(plan);
                }
            }
            let mut answer = if method == "session/request_permission" {
                json!({ "result": { "outcome": { "outcome": "cancelled" } } })
            } else {
                other_answer(method)
            };
            answer["id"] = rid;
            write_line(&live.stdin, &answer);
        } else if other_session {
            continue;
        } else {
            match method {
                "session/update" => unsent |= state.feed(&params["update"]),
                "cursor/update_todos" => state.todos(&params["todos"], params["merge"].as_bool() == Some(true)),
                "cursor/task" => state.set_activity(Activity::new("subtask", "")),
                _ => {}
            }
            if method == "session/update" && params["update"]["sessionUpdate"] == "config_option_update" {
                live.offer.set_choices(&params["update"]["configOptions"]);
            }
        }
        // Looked at as soon as they are noted, while a file the tool writes
        // may not be there yet: one that wasn't is "created". After Stop too,
        // told once the turn is over.
        noted.extend(state.take_files().into_iter().filter_map(|t| in_dir(t, &spec.dir)).map(|touch| {
            if touch.kind == "edited" {
                FileTouch::written(&touch.path).unwrap_or(touch)
            } else {
                touch
            }
        }));
        if state.stopped {
            continue;
        }
        let activity = state.take_activity();
        if unsent && (activity.is_some() || last_emit.elapsed() >= DELTA_INTERVAL) {
            unsent = false;
            last_emit = Instant::now();
            on_text(state.visible());
        }
        if let Some(activity) = activity {
            on_activity(&activity);
        }
        for touch in noted.drain(..) {
            on_file(&touch);
        }
        if let Some(plan) = state.take_plan() {
            on_plan(&plan);
        }
    };
    if unsent && !state.stopped {
        on_text(state.visible());
    }
    for touch in noted.into_iter().chain(state.take_files().into_iter().filter_map(|t| in_dir(t, &spec.dir))) {
        on_file(&touch);
    }
    let session = Some(session).filter(|s| !s.is_empty());
    match ended {
        Ended::Completed => {
            // Nothing reads the CLI between turns: its tasks end with this one.
            live.tasks.turn_ended(state.stopped);
            (live.tell)(&mut live.tasks.agents, false);
            live.used = Instant::now();
            let old = lives(|all| all.insert(spec.chat_id.clone(), live));
            drop(old);
            reap_idle();
            Ok((state, session))
        }
        // Not cancelled in time: ended (Drop), the run so far kept. The
        // user asked for it: its tasks stopped, not failed.
        Ended::Stopped | Ended::Closed if state.stopped => {
            live.tasks.turn_ended(true);
            (live.tell)(&mut live.tasks.agents, false);
            Ok((state, session))
        }
        Ended::Stopped => Err(tf("{agent} took too long to answer.", &[("agent", agent.name())])),
        Ended::Closed => Err(live.ended()),
    }
}

// ── Models ────────────────────────────────────────────────────────────────────

/// Asks a short-lived server what a new session offers. Nothing on any failure.
fn list_models(agent: Agent, exe: PathBuf) -> Vec<(String, String)> {
    let dir = claude_code::work_dir();
    let (tx, rx) = mpsc::channel();
    // The server ends with its Live, once answered or given up on.
    std::thread::spawn(move || {
        let listed = Live::start(agent, &exe, &agent.args(""), &dir, "", "").and_then(|mut live| {
            live.open_session(None, &dir, &json!([]))?;
            Ok(live.offer.model_list())
        });
        let _ = tx.send(listed.unwrap_or_default());
    });
    rx.recv_timeout(MODELS_TIMEOUT).unwrap_or_default()
}

/// The models for the picker: "Default" (the CLI's own choice), then those
/// it offers. Asked only when the user opens the picker on this provider.
pub async fn models(provider: &str) -> Result<Vec<ModelInfo>, String> {
    let agent = Agent::of(provider).ok_or_else(|| format!("Unknown chat provider: {provider}"))?;
    let exe = agent.exe().ok_or_else(|| agent.not_installed())?;
    let listed = tauri::async_runtime::spawn_blocking(move || list_models(agent, exe)).await.map_err(|e| e.to_string())?;
    let mut out = vec![ModelInfo { id: DEFAULT_MODEL.into(), label: t("Default"), ..Default::default() }];
    out.extend(listed.into_iter().filter(|(id, _)| id != DEFAULT_MODEL).map(|(id, label)| ModelInfo { id, label, ..Default::default() }));
    Ok(out)
}

/// The CLI is on this computer.
pub fn ready(provider: &str) -> bool {
    Agent::of(provider).is_some_and(|a| a.exe().is_some())
}

// ── One turn ──────────────────────────────────────────────────────────────────

/// One chat turn through Copilot CLI or Cursor CLI.
#[allow(clippy::too_many_arguments)]
pub async fn send(
    app: &AppHandle,
    chat: &Chat,
    provider: &str,
    model: &str,
    effort: &str,
    mode: &str,
    query: String,
    context: Option<ChatContext>,
    folder: Option<String>,
) -> Result<ChatReply, String> {
    let agent = Agent::of(provider).ok_or_else(|| format!("Unknown chat provider: {provider}"))?;
    let exe = agent.exe().ok_or_else(|| agent.not_installed())?;

    let turn = chat.begin(agent.provider());
    // Only this CLI's session: never another CLI's.
    let session = chat.cli_session_for(agent.provider());
    // The folders shared in this chat: the CLI reads anywhere it may, so they
    // are only remembered for the chat.
    chat.cli_dirs(folder);
    let history = turn.history.clone();
    let files = chat.files();
    let workshop = chat.is_workshop();
    let tools = tauri::async_runtime::spawn_blocking(crate::tools::any_enabled).await.unwrap_or(false);
    // Lumo's email tools, usable only while this turn runs.
    let mail = crate::mail::ai_tools(app);
    let _mail = (!mail.is_empty()).then(crate::mail::agent_turn);
    let dir = claude_code::work_dir();
    let (mcp, extra_key) = match agent {
        Agent::Copilot => (acp_servers(chat.id(), tools, mail), String::new()),
        Agent::Cursor => {
            let work = dir.clone();
            let written = tauri::async_runtime::spawn_blocking(move || cursor_workspace(&work, tools, mail)).await.map_err(|e| e.to_string())?;
            (json!([]), written.to_string())
        }
    };
    let spec = TurnSpec {
        agent,
        exe,
        args: agent.args(effort),
        dir,
        chat_id: chat.id().to_string(),
        session,
        mcp,
        extra_key,
        model: model.to_string(),
        mode: mode.to_string(),
    };
    let context2 = context.clone();
    let query2 = query.clone();
    // A new session gets Lumo's instructions and the chat's turns once, as
    // text, and the tool workshop's instructions with them.
    let text = move |fresh: bool| {
        let carried: &[Value] = if fresh { &history } else { &[] };
        let text = claude_code::prompt(context2.as_ref(), carried, &files, &query2);
        if !fresh {
            return text;
        }
        let workshop = if workshop { format!("\n\n{}", crate::chat::workshop_note!().trim()) } else { String::new() };
        format!("<lumo_instructions>\n{}{workshop}\n</lumo_instructions>\n\n{text}", INSTRUCTIONS.trim())
    };

    let app2 = app.clone();
    let app3 = app.clone();
    let events = chat.events();
    let stop = chat.stopper();
    // The tasks the CLI hands to subagents, and the turn's sign of life.
    let tell = chat_agents::teller(app, chat.id());
    let (state, session) = tauri::async_runtime::spawn_blocking(move || {
        live_turn(
            spec,
            text,
            stop,
            // The CLI's own question, as a card in the island; only a click allows.
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
                let _ = app2.emit_to(
                    crate::island::WINDOW_LABEL,
                    "chat-plan",
                    json!({ "tool": "update_plan", "input": plan, "agent": agent.name(), "color": agent.color() }),
                );
            },
            tell,
        )
    })
    .await
    .map_err(|e| e.to_string())??;

    // A stopped turn keeps its session too: the CLI has the question and what it wrote.
    if let Some(id) = &session {
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
        return Err(e.clone());
    }
    let answer = chat::keep_lumo_lines(state.answer(), &state.said());
    if answer.trim().is_empty() {
        crate::log::line(format!("{}: empty answer ({}); {} declined", agent.tag(), state.stop_reason, state.denied));
        let why = match state.stop_reason.as_str() {
            "refusal" => tf("{agent} declined to answer this.", &[("agent", agent.name())]),
            _ if state.denied > 0 => tf("{agent} needed a permission that wasn't given.", &[("agent", agent.name())]),
            _ => tf("{agent} gave no answer.", &[("agent", agent.name())]),
        };
        // The island shows why; the conversation keeps that there was no
        // answer, not Lumo's words as if the agent had said them.
        chat.commit(&turn, json!({ "role": "user", "content": plain }), json!({ "role": "assistant", "content": chat::NO_ANSWER }), &plain, chat::NO_ANSWER);
        return Ok(ChatReply::no_answer(why, chat.cli_session()));
    }
    chat.commit(&turn, json!({ "role": "user", "content": plain }), json!({ "role": "assistant", "content": answer }), &plain, &answer);
    Ok(ChatReply::answer(answer, chat.cli_session()))
}

// ── Lumo's supervisor ─────────────────────────────────────────────────────────

/// One answer to `prompt` with `model`, for Lumo's supervisor (tool_review.rs):
/// a new session in Plan only, in a folder of its own and with no tools of
/// Lumo's, so it reads and answers without changing anything (whatever the
/// CLI would ask is rejected). Blocking.
pub(crate) fn complete(provider: &str, model: &str, prompt: &str) -> Result<String, String> {
    const REVIEW: &str = "lumo-tool-review";
    let agent = Agent::of(provider).ok_or_else(|| format!("Unknown chat provider: {provider}"))?;
    let exe = agent.exe().ok_or_else(|| agent.not_installed())?;
    let spec = TurnSpec {
        agent,
        exe,
        args: agent.args(""),
        dir: platform::local_dir().join("tool-review"),
        chat_id: REVIEW.into(),
        session: None,
        mcp: json!([]),
        extra_key: String::new(),
        model: model.to_string(),
        mode: "plan".into(),
    };
    let prompt = prompt.to_string();
    let result = live_turn(spec, move |_| prompt, Arc::new(Stop::default()), |_, answer| answer(false), |_| {}, |_| {}, |_| {}, |_| {}, chat_agents::silent());
    close(REVIEW);
    let (state, _) = result?;
    if let Some(Err(e)) = &state.done {
        return Err(e.clone());
    }
    match state.answer() {
        a if a.is_empty() => Err(t("No response text.")),
        a => Ok(a),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_instructions_teach_the_chats_rich_blocks() {
        assert!(INSTRUCTIONS.contains(crate::chat::rich_note!()));
        assert!(INSTRUCTIONS.contains(crate::chat::math_note!()));
    }

    #[test]
    fn each_model_shows_once_from_both_lists() {
        let offer = Offer::parse(&json!({
            "configOptions": [{ "id": "model", "category": "model", "type": "select", "currentValue": "auto",
                "options": [{ "value": "auto", "name": "Auto" }, { "value": "auto-2", "name": "Auto" }] }],
            "models": { "availableModels": [{ "modelId": "auto", "name": "Auto" }, { "modelId": "gpt-5", "name": "GPT-5" }] },
        }));
        assert_eq!(offer.model_list(), [("auto".to_string(), "Auto".to_string()), ("gpt-5".to_string(), "GPT-5".to_string())]);
        assert_eq!(offer.set_model("auto").unwrap().0, "session/set_config_option");
        assert_eq!(offer.set_model("gpt-5").unwrap().0, "session/set_model");
        assert!(offer.set_model("nope").is_none());
    }

    fn feed(run: &mut Run, update: Value) -> bool {
        run.feed(&update)
    }

    #[test]
    fn the_answer_is_the_text_after_the_last_tool_call_and_every_message_keeps_lumos_lines() {
        let mut run = Run::default();
        assert!(feed(&mut run, json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "Let me " } })));
        assert!(feed(&mut run, json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "check. [[timer 60s: tea]]" } })));
        assert_eq!(run.visible(), "Let me check. [[timer 60s: tea]]");
        feed(&mut run, json!({ "sessionUpdate": "tool_call", "toolCallId": "c1", "title": "List files", "kind": "search", "status": "pending" }));
        assert_eq!(run.take_activity(), Some(Activity::new("search", "")));
        feed(&mut run, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed" }));
        assert_eq!(run.take_activity(), Some(Activity::thinking()));
        assert!(feed(&mut run, json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "Done." } })));
        assert_eq!(run.answer(), "Done.");
        assert_eq!(chat::keep_lumo_lines(run.answer(), &run.said()).trim_end(), "Done.\n[[timer 60s: tea]]");
        // A picture or anything but text is not the answer.
        assert!(!feed(&mut run, json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "image", "data": "x" } })));
        assert!(!feed(&mut run, json!({ "sessionUpdate": "available_commands_update", "availableCommands": [] })));
    }

    #[test]
    fn what_the_cli_does_shows_without_a_path_or_a_command() {
        let read = json!({ "kind": "read", "title": "Read main.rs", "locations": [{ "path": "C:\\Users\\me\\src\\main.rs" }] });
        assert_eq!(activity_for(&read), Activity::new("read", "main.rs"));
        let edit = json!({ "kind": "edit", "rawInput": { "path": "C:\\p\\lib.rs" } });
        assert_eq!(activity_for(&edit), Activity::new("edit", "lib.rs"));
        assert_eq!(activity_for(&json!({ "kind": "search", "rawInput": { "pattern": "fn main" } })), Activity::new("search", "fn main"));
        assert_eq!(activity_for(&json!({ "kind": "execute", "title": "cargo build --release" })), Activity::new("command", ""));
        assert_eq!(activity_for(&json!({ "kind": "fetch", "rawInput": { "url": "https://x.dev" } })), Activity::new("web", ""));
        assert_eq!(activity_for(&json!({ "kind": "think" })), Activity::thinking());
        assert_eq!(activity_for(&json!({ "kind": "other", "title": "lumo/set_timer" })), Activity::new("tool", "lumo/set_timer"));
        assert_eq!(activity_for(&json!({})), Activity::thinking());
    }

    #[test]
    fn the_files_a_call_reads_and_edits_are_told_once_it_ran() {
        let mut run = Run::default();
        feed(&mut run, json!({ "sessionUpdate": "tool_call", "toolCallId": "r1", "kind": "read", "status": "in_progress", "locations": [{ "path": "C:\\p\\main.rs" }] }));
        assert!(run.take_files().is_empty(), "not before it ran");
        feed(&mut run, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "r1", "status": "completed" }));
        assert_eq!(run.take_files(), vec![FileTouch { kind: "read", path: r"C:\p\main.rs".into() }]);

        feed(&mut run, json!({ "sessionUpdate": "tool_call", "toolCallId": "e1", "kind": "edit", "status": "pending" }));
        feed(&mut run, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "e1", "locations": [{ "path": "lib.rs" }] }));
        feed(&mut run, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "e1", "status": "completed" }));
        let files = run.take_files();
        assert_eq!(files, vec![FileTouch { kind: "edited", path: "lib.rs".into() }]);
        let whole = in_dir(files[0].clone(), Path::new(r"C:\p")).unwrap();
        assert!(claude_code::is_full_path(&whole.path) && whole.path.ends_with("lib.rs"), "{}", whole.path);

        // Failed or deleted: nothing to show.
        feed(&mut run, json!({ "sessionUpdate": "tool_call", "toolCallId": "e2", "kind": "edit", "locations": [{ "path": "C:\\p\\x.rs" }] }));
        feed(&mut run, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "e2", "status": "failed" }));
        feed(&mut run, json!({ "sessionUpdate": "tool_call", "toolCallId": "d1", "kind": "delete", "status": "completed", "locations": [{ "path": "C:\\p\\old.rs" }] }));
        assert!(run.take_files().is_empty());
    }

    #[test]
    fn the_plan_and_cursors_todos_go_to_the_plan_island_once_each_time_they_change() {
        let mut run = Run::default();
        let plan = json!({ "sessionUpdate": "plan", "entries": [
            { "content": "Read", "priority": "high", "status": "completed" },
            { "content": "Write", "priority": "medium", "status": "in_progress" },
        ] });
        feed(&mut run, plan.clone());
        let got = run.take_plan().unwrap();
        assert_eq!(got["plan"][0], json!({ "step": "Read", "status": "completed" }));
        assert_eq!(got["plan"][1]["status"], "inProgress");
        feed(&mut run, plan);
        assert!(run.take_plan().is_none());
        feed(&mut run, json!({ "sessionUpdate": "plan", "entries": [] }));
        assert!(run.take_plan().is_none());

        let mut run = Run::default();
        run.todos(&json!([{ "id": "1", "content": "Look", "status": "pending" }, { "id": "2", "content": "Fix", "status": "pending" }]), false);
        assert_eq!(run.take_plan().unwrap()["plan"].as_array().unwrap().len(), 2);
        run.todos(&json!([{ "id": "1", "status": "completed" }]), true);
        let got = run.take_plan().unwrap();
        assert_eq!(got["plan"][0], json!({ "step": "Look", "status": "completed" }));
        assert_eq!(got["plan"][1]["step"], "Fix");
    }

    #[test]
    fn a_permission_request_is_the_clis_own_card_in_the_island() {
        let mut calls = HashMap::new();
        calls.insert("t1".to_string(), json!({ "toolCallId": "t1", "kind": "execute", "title": "Run tests", "rawInput": { "command": ["npm", "test"] } }));
        let params = json!({ "sessionId": "s1", "toolCall": { "toolCallId": "t1" }, "options": [] });
        let c = card(Agent::Copilot, &params, Path::new(r"C:\Users\me\Lumo"), &calls, false);
        assert_eq!(c["hook_event_name"], "PermissionRequest");
        assert_eq!(c["lumo_island"], true);
        assert_eq!(c["lumo_agent"], "copilot");
        assert_eq!(c["tool_name"], "Bash");
        assert_eq!(c["tool_input"]["command"], "npm test");
        assert_eq!(c["session_id"], "s1");
        assert!(c.get("lumo_remembered").is_none(), "Ask every time: nothing remembered");

        let edit = json!({ "sessionId": "s1", "toolCall": { "toolCallId": "t2", "kind": "edit", "locations": [{ "path": "C:\\a.rs" }, { "path": "C:\\b.rs" }] } });
        let c = card(Agent::Cursor, &edit, Path::new("C:\\p"), &HashMap::new(), false);
        assert_eq!(c["lumo_agent"], "cursor");
        assert_eq!(c["tool_name"], "Edit");
        assert_eq!(c["tool_input"]["file_path"], "C:\\a.rs, C:\\b.rs");

        let other = json!({ "toolCall": { "toolCallId": "t3", "title": "lumo_tools: send_invoice", "rawInput": { "to": "x" } } });
        let c = card(Agent::Copilot, &other, Path::new("C:\\p"), &HashMap::new(), false);
        assert_eq!(c["tool_name"], "lumo_tools: send_invoice");
        assert_eq!(c["tool_input"]["to"], "x");
    }

    /// A deletion or a move is never shown as an edit: the click says what it allows.
    #[test]
    fn a_deletion_and_a_move_are_named_on_the_card() {
        let delete = json!({ "sessionId": "s1", "toolCall": { "toolCallId": "d1", "kind": "delete", "locations": [{ "path": "C:\\p\\old.ts" }] } });
        let c = card(Agent::Copilot, &delete, Path::new("C:\\p"), &HashMap::new(), false);
        assert_eq!(c["tool_name"], "Delete");
        assert_eq!(c["tool_input"]["file_path"], "C:\\p\\old.ts");

        let moved = json!({ "sessionId": "s1", "toolCall": { "toolCallId": "m1", "kind": "move", "locations": [{ "path": "C:\\p\\a.ts" }, { "path": "C:\\p\\b.ts" }] } });
        let c = card(Agent::Cursor, &moved, Path::new("C:\\p"), &HashMap::new(), false);
        assert_eq!(c["tool_name"], "Move");
        assert_eq!(c["tool_input"]["file_path"], "C:\\p\\a.ts → C:\\p\\b.ts");

        // Only an edit is an edit.
        let edit = json!({ "toolCall": { "toolCallId": "e1", "kind": "edit", "rawInput": { "path": "C:\\p\\c.ts" } } });
        assert_eq!(card(Agent::Copilot, &edit, Path::new("C:\\p"), &HashMap::new(), false)["tool_name"], "Edit");
    }

    /// In Auto the click stands for the rest of the chat, and the card says so.
    #[test]
    fn a_card_in_auto_says_its_allow_is_remembered() {
        let params = json!({ "sessionId": "s1", "toolCall": { "toolCallId": "t1", "kind": "execute", "rawInput": { "command": "npm test" } } });
        assert_eq!(card(Agent::Copilot, &params, Path::new("C:\\p"), &HashMap::new(), true)["lumo_remembered"], true);
        assert!(card(Agent::Copilot, &params, Path::new("C:\\p"), &HashMap::new(), false).get("lumo_remembered").is_none());
    }

    #[test]
    fn a_click_is_never_more_than_it_says() {
        let copilot = json!([
            { "optionId": "a1", "name": "Allow", "kind": "allow_once" },
            { "optionId": "a2", "name": "Always", "kind": "allow_always" },
            { "optionId": "r1", "name": "Reject", "kind": "reject_once" },
        ]);
        assert_eq!(permission_answer(&copilot, true, false)["outcome"]["optionId"], "a1");
        assert_eq!(permission_answer(&copilot, true, true)["outcome"]["optionId"], "a2");
        assert_eq!(permission_answer(&copilot, false, true)["outcome"]["optionId"], "r1");
        // Cursor's ids, without kinds.
        let cursor = json!([{ "optionId": "allow-once" }, { "optionId": "allow-always" }, { "optionId": "reject-once" }]);
        assert_eq!(permission_answer(&cursor, true, false)["outcome"]["optionId"], "allow-once");
        assert_eq!(permission_answer(&cursor, false, false)["outcome"]["optionId"], "reject-once");
        // Only "always" on offer: Ask every time allows nothing.
        let always = json!([{ "optionId": "x", "kind": "allow_always" }]);
        assert_eq!(permission_answer(&always, true, false), json!({ "outcome": { "outcome": "cancelled" } }));
        assert_eq!(permission_answer(&json!(null), false, false), json!({ "outcome": { "outcome": "cancelled" } }));
        // Cursor's question is skipped, its plan taken, anything else not Lumo's.
        assert_eq!(other_answer("cursor/ask_question")["result"]["outcome"]["outcome"], "skipped");
        assert_eq!(other_answer("cursor/create_plan")["result"]["outcome"]["outcome"], "accepted");
        assert_eq!(other_answer("fs/write_text_file")["error"]["code"], -32601);
    }

    #[test]
    fn the_session_offers_models_and_modes_either_way() {
        let config = json!({ "sessionId": "s", "configOptions": [
            { "id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": "agent",
              "options": [{ "value": "agent", "name": "Agent" }, { "value": "plan", "name": "Plan" }, { "value": "ask", "name": "Ask" }] },
            { "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "auto",
              "options": [{ "group": "g", "name": "Anthropic", "options": [{ "value": "sonnet-4.5", "name": "Sonnet 4.5" }] }, { "value": "auto", "name": "Auto" }, { "value": "bad model!", "name": "Bad" }] },
        ] });
        let mut offer = Offer::parse(&config);
        assert_eq!(offer.model_list(), [("sonnet-4.5".to_string(), "Sonnet 4.5".to_string()), ("auto".to_string(), "Auto".to_string())]);
        assert_eq!(offer.plan_mode().as_deref(), Some("plan"));
        assert_eq!(offer.set_model("sonnet-4.5"), Some(("session/set_config_option", json!({ "configId": "model", "value": "sonnet-4.5" }))));
        assert_eq!(offer.set_model("gpt-9"), None);
        let (method, mut params) = offer.set_mode("plan").unwrap();
        params["sessionId"] = json!("s");
        offer.applied(method, &params, &json!(null));
        assert_eq!(offer.current_mode(), Some("plan"));

        let older = json!({ "sessionId": "s",
            "modes": { "currentModeId": "https://agentclientprotocol.com/protocol/session-modes#agent", "availableModes": [
                { "id": "https://agentclientprotocol.com/protocol/session-modes#agent", "name": "Agent" },
                { "id": "https://agentclientprotocol.com/protocol/session-modes#plan", "name": "Plan" },
                { "id": "https://agentclientprotocol.com/protocol/session-modes#autopilot", "name": "Autopilot" }] },
            "models": { "currentModelId": "gpt-5", "availableModels": [{ "modelId": "gpt-5", "name": "GPT-5" }, { "modelId": "claude-sonnet-4.5", "name": "Claude Sonnet 4.5" }] } });
        let mut offer = Offer::parse(&older);
        assert_eq!(offer.plan_mode().as_deref(), Some("https://agentclientprotocol.com/protocol/session-modes#plan"));
        assert_eq!(offer.current_model(), Some("gpt-5"));
        let (method, params) = offer.set_model("claude-sonnet-4.5").unwrap();
        assert_eq!(method, "session/set_model");
        offer.applied(method, &params, &json!({}));
        assert_eq!(offer.current_model(), Some("claude-sonnet-4.5"));
        assert!(Offer::parse(&json!({})).plan_mode().is_none());
    }

    #[test]
    fn lumos_tools_go_to_copilot_in_the_session_and_to_cursor_in_its_folder() {
        let servers = acp_servers("chat-1", true, "mail");
        assert_eq!(servers[0]["name"], LUMO_SERVER);
        assert_eq!(servers[0]["args"], json!(["--mcp", "--tools=mail,island"]));
        let env = servers[0]["env"].as_array().unwrap();
        assert!(env.contains(&json!({ "name": "LUMO_ISLAND_RUN", "value": "1" })));
        assert!(env.contains(&json!({ "name": "LUMO_CHAT_ID", "value": "chat-1" })));
        assert_eq!(servers[1]["name"], crate::tools::SERVER);
        assert_eq!(acp_servers("", false, "").as_array().unwrap().len(), 1);

        let dir = std::env::temp_dir().join(format!("lumo-acp-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".cursor")).unwrap();
        std::fs::write(dir.join(".cursor").join("mcp.json"), r#"{"mcpServers":{"mine":{"command":"x"}}}"#).unwrap();
        cursor_workspace(&dir, true, "");
        let mcp: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".cursor").join("mcp.json")).unwrap()).unwrap();
        assert_eq!(mcp["mcpServers"]["mine"]["command"], "x", "the user's own server stays");
        assert_eq!(mcp["mcpServers"]["lumo"]["env"]["LUMO_CHAT_ID"], "${env:LUMO_CHAT_ID}");
        assert!(mcp["mcpServers"][crate::tools::SERVER].is_object());
        cursor_workspace(&dir, false, "");
        let mcp: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".cursor").join("mcp.json")).unwrap()).unwrap();
        assert!(mcp["mcpServers"].get(crate::tools::SERVER).is_none(), "the user's tools go when off");
        let cli: Value = serde_json::from_str(&std::fs::read_to_string(dir.join(".cursor").join("cli.json")).unwrap()).unwrap();
        assert_eq!(cli["permissions"]["allow"], json!(["Mcp(lumo:*)", "Mcp(lumo_tools:*)"]));
        // A file Lumo can't read is left alone.
        std::fs::write(dir.join(".cursor").join("mcp.json"), "{ not json").unwrap();
        cursor_workspace(&dir, true, "");
        assert_eq!(std::fs::read_to_string(dir.join(".cursor").join("mcp.json")).unwrap(), "{ not json");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_plain_ids_and_known_efforts_are_sent() {
        assert_eq!(safe_model("claude-sonnet-4.5"), Some("claude-sonnet-4.5"));
        assert_eq!(safe_model("default"), None);
        assert_eq!(safe_model("gpt 5 & calc"), None);
        assert_eq!(safe_effort("max"), Some("max"));
        assert_eq!(safe_effort("turbo"), None);
        assert_eq!(safe_session("4f1c2b7e-0000-4000-8000-1234567890ab"), Some("4f1c2b7e-0000-4000-8000-1234567890ab"));
        assert_eq!(safe_session("a b"), None);
        assert_eq!(Agent::Copilot.args("high"), ["--acp", "--stdio", "--allow-tool", "lumo", "--allow-tool", "lumo_tools", "--effort=high"]);
        assert_eq!(Agent::Cursor.args("high"), ["--approve-mcps", "acp"]);
        assert_eq!(Agent::of("copilot-cli"), Some(Agent::Copilot));
        assert_eq!(Agent::of("codex"), None);
    }

    #[test]
    fn sign_in_errors_say_how_to_sign_in() {
        assert_eq!(rpc_error(Agent::Cursor, &json!({ "code": -32000, "message": "Authentication required" })), Agent::Cursor.not_signed_in());
        assert_eq!(acp_error(Agent::Copilot, "401 Unauthorized"), Agent::Copilot.not_signed_in());
        assert!(acp_error(Agent::Copilot, "rate limited").contains("rate limited"));
    }

    #[test]
    fn each_task_cursor_hands_to_a_subagent_is_a_row_done_with_its_tool_call() {
        let mut tasks = Tasks::default();
        tasks.task(CURSOR, &json!({ "sessionId": "s", "toolCallId": "call-1", "taskId": "t1", "description": "Review the auth module", "subagentType": "explore" }));
        // Its fields in a `task` of their own, and no id: its call names it.
        tasks.task(CURSOR, &json!({ "sessionId": "s", "task": { "toolCallId": "call-2", "title": "Write the tests" } }));
        let rows = tasks.agents.changed();
        assert_eq!(rows.iter().map(|r| (r.id.as_str(), r.title.as_str())).collect::<Vec<_>>(), [("t1", "Review the auth module"), ("call-2", "Write the tests")]);
        assert!(rows.iter().all(|r| r.source == CURSOR && r.state == AgentState::Working && !r.can_stop));

        // News of a task by its id; its tool call ends it.
        tasks.task(CURSOR, &json!({ "taskId": "t1", "summary": "3 issues found so far" }));
        assert_eq!(tasks.agents.get("t1").unwrap().summary.as_deref(), Some("3 issues found so far"));
        assert_eq!(tasks.agents.get("t1").unwrap().title, "Review the auth module", "a title stays when none comes");
        tasks.call_update(&json!({ "sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "in_progress" }));
        assert_eq!(tasks.agents.get("t1").unwrap().state, AgentState::Working);
        tasks.call_update(&json!({ "sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "completed" }));
        tasks.call_update(&json!({ "sessionUpdate": "tool_call_update", "toolCallId": "call-2", "status": "failed" }));
        assert_eq!(tasks.agents.get("t1").unwrap().state, AgentState::Done);
        assert_eq!(tasks.agents.get("call-2").unwrap().state, AgentState::Failed);
        // A call of no task is none of theirs.
        tasks.call_update(&json!({ "sessionUpdate": "tool_call_update", "toolCallId": "call-9", "status": "completed" }));
        assert!(tasks.agents.get("call-9").is_none());

        // A task that says its own end; one with nothing to name it is numbered.
        tasks.task(CURSOR, &json!({ "taskId": "t3", "name": "Lint", "status": "failed", "error": "eslint crashed" }));
        assert_eq!(tasks.agents.get("t3").unwrap().error.as_deref(), Some("eslint crashed"));
        tasks.task(CURSOR, &json!({}));
        let numbered = tasks.agents.changed().pop().unwrap().id;
        assert!(numbered.starts_with("task-") && numbered.ends_with("-1"), "{numbered}");
        assert_eq!(tasks.agents.get(&numbered).unwrap().title, "Agent");
        // The turn ended: the open ones with it.
        tasks.turn_ended(true);
        assert_eq!(tasks.agents.get(&numbered).unwrap().state, AgentState::Stopped);
        assert_eq!(tasks.agents.open(), 0);

        // The next server numbers its tasks from 1 again: another id all the same.
        let mut next = Tasks::default();
        next.task(CURSOR, &json!({}));
        let again = next.agents.changed().pop().unwrap().id;
        assert!(again.ends_with("-1") && again != numbered, "{again} {numbered}");
    }
}
