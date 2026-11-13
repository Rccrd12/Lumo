//! lumo-hook — the relay Claude Code (and every other agent) runs on each hook
//! event.
//!
//! Reads the hook JSON on stdin, maps the agent's event and field names onto
//! Claude Code's (normalize.rs), adds a little terminal context, and hands it to
//! Lumo over the named pipe `\\.\pipe\lumo-<sid>`.
//!
//! Hard rule (docs/CLAUDE.md): **never block the agent.**
//! * If the pipe does not exist — Lumo is closed — we exit 0 immediately, with
//!   only the "no opinion" reply the agent expects (reply.rs), and the session
//!   carries on untouched.
//! * Every step runs under a deadline enforced by the main thread, so a pipe that
//!   accepts the connection and then stops reading cannot wedge the session
//!   either: we abandon the worker and exit.
//! * Only `PermissionRequest` waits for an answer, because approving from the
//!   island is the whole point. No answer means no decision, and the agent asks
//!   in its terminal exactly as if Lumo were not installed.
//!
//! Usage: `lumo-hook [--agent <name>] [<EventName>]` (the event name is also
//! read from the JSON; `--agent` is absent for Claude Code), or
//! `lumo-hook --statusline` as Claude Code's status line command (plan usage,
//! see statusline.rs): it passes the plan limits on and runs the status line the
//! user had before, so that keeps working, or `lumo-hook --mcp` as the MCP
//! server of the island chat's computer use (mcp.rs).

use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;

mod agy_rules;
mod background;
mod mail_tools;
mod mcp;
mod normalize;
mod reply;
mod title;
mod write_stat;

/// Budget for getting a pipe connection. Beyond this the agent wins, always.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(300);
/// Whole-run budget for an event nobody waits on: connect and write, no more.
const FIRE_AND_FORGET_BUDGET: Duration = Duration::from_secs(2);
/// How long a permission prompt may stay on screen before the terminal takes over.
const DECISION_BUDGET: Duration = Duration::from_secs(110);
/// How often a waiting relay checks that the process that ran it is still there.
const PARENT_POLL: Duration = Duration::from_millis(100);
/// How long the event may take to arrive on stdin. The agent writes it and
/// closes stdin at once; one that keeps it open would otherwise hold the relay,
/// and the agent with it, before any budget below starts to count.
const STDIN_TIMEOUT: Duration = Duration::from_secs(3);
/// The most of stdin read: an event bigger than this is cut, so not read as
/// JSON, and gets the usual "no opinion".
const MAX_STDIN: u64 = 32 * 1024 * 1024;
/// A card of the island's Antigravity CLI chat must be answered before
/// Antigravity gives up on the hook: the hook's `timeout` in hooks.json, which
/// Lumo's own hooks pass on as `--wait`. Without it (hooks installed before
/// the chat came, which give 10 s) the relay waits this long, no more.
const ANTIGRAVITY_SHORT_WAIT: u64 = 8;

/// Fields that are pointless to forward and can be enormous (a whole file read,
/// a full command output). The island never shows them.
const DROPPED_FIELDS: &[&str] = &["tool_response", "tool_output", "transcript_path"];
/// The events that carry a Claude Code session's title (title.rs).
const TITLE_EVENTS: &[&str] = &["SessionStart", "UserPromptSubmit", "Stop"];
/// Longest string forwarded for any single field; the island truncates to far
/// less than this anyway.
const MAX_FIELD_LEN: usize = 2_000;

mod statusline;

/// The live diff needs the whole text of a file edit, once it has happened:
/// PostToolUse of these tools keeps its edit strings far longer than the rest.
const DIFF_TOOLS: &[&str] = &["Edit", "MultiEdit", "Write"];
/// The `tool_input` keys holding the text being replaced or written.
const DIFF_FIELDS: &[&str] = &["old_string", "new_string", "content"];
/// Per edit string. The island stops diffing at 200 KB anyway (DiffEngine).
const MAX_DIFF_FIELD_LEN: usize = 256 * 1024;
/// For all edit strings of one event together, so the line stays well under the
/// 1 MiB the app reads from the pipe even once JSON-escaped.
const MAX_DIFF_TOTAL: usize = 512 * 1024;
/// The `tool_input` keys a permission card shows as what Allow allows: the
/// command, the file, the page, the plan Claude Code asks to start (its steps).
const TARGET_FIELDS: &[&str] = &["command", "cmd", "CommandLine", "script", "file_path", "notebook_path", "path", "url", "plan"];
/// The tools that write a file, whose text travels on the live diff's budget:
/// Claude Code's, Antigravity's (its IDE's and its CLI's `edit_file`), Gemini
/// CLI's, Copilot CLI's and OpenCode's. Their card names the file and counts
/// the lines (write_stat.rs), never shows the text: a text cut short changes
/// nothing on it (`lumo_text_cut`).
const CONTENT_TOOLS: &[&str] = &[
    "Write", "Edit", "MultiEdit", "NotebookEdit",
    "write_to_file", "replace_file_content", "multi_replace_file_content", "edit_file", "create_file",
    "write_file", "replace",
    "create", "edit", "write",
];
/// Their `tool_input` keys holding the text written or replaced (Antigravity's
/// `ReplacementChunks` hold Target/ReplacementContent, its CLI's `edit_file`
/// Target/Replacement).
const CONTENT_FIELDS: &[&str] = &[
    "old_string", "new_string", "content", "new_source",
    "CodeContent", "TargetContent", "ReplacementContent", "Target", "Replacement",
    "file_text", "old_str", "new_str", "oldString", "newString",
];
/// Per target string of a permission request: the card shows the whole of it,
/// so a long script reaches the island whole. Past this the request carries
/// `lumo_input_cut` (and `lumo_input_bytes`, its whole size): the card says it
/// shows the beginning, and "Allow for this session" never remembers it. Allow
/// itself stays: the user decides, and in Auto nothing waits for them.
const MAX_TARGET_LEN: usize = 64 * 1024;

mod win;
use win::{ancestry, connect, parent};

/// What the command line says: `--agent <name>`, the event name, and
/// `--wait <seconds>`: how long the agent lets this hook run (Antigravity's
/// PreToolUse, after the event name so an older relay ignores it).
struct Args {
    agent: String,
    event: String,
    wait: Option<u64>,
    /// `--chat-guard`: the PreToolUse hook the island's Claude Code chat adds
    /// for itself (claude_code.rs chat_settings): it only stops the commands
    /// that would wait on GitHub.
    chat_guard: bool,
}

fn args() -> Args {
    let mut agent = String::new();
    let mut event = String::new();
    let mut wait = None;
    let mut chat_guard = false;
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        if arg == "--chat-guard" {
            chat_guard = true;
        } else if arg == "--agent" {
            agent = it.next().unwrap_or_default();
        } else if arg == "--wait" {
            wait = it.next().and_then(|s| s.parse().ok());
        } else if event.is_empty() {
            event = arg;
        }
    }
    Args { agent, event, wait, chat_guard }
}

/// How long a card of the island's Antigravity CLI chat may wait for a click.
fn card_budget(wait: Option<u64>) -> Duration {
    Duration::from_secs(wait.unwrap_or(ANTIGRAVITY_SHORT_WAIT).clamp(1, DECISION_BUDGET.as_secs()))
}

/// One event, ready to forward.
struct Event {
    /// The payload as one line of JSON.
    line: String,
    /// The canonical event name.
    name: String,
    /// For Claude Code's AskUserQuestion, the question as it was asked.
    question: Option<Value>,
    /// A shell command of the island's own Antigravity CLI chat, forwarded as
    /// a permission request (see `prepare`).
    island_card: bool,
    /// A shell command of an Antigravity session that none of its rules covers,
    /// forwarded as a permission request (see `prepare`): no click is "ask".
    agy_gate: bool,
    /// Claude Code asking to leave plan mode (ExitPlanMode): the only request
    /// "Approve and let it edit files" may answer (reply::decision_json).
    plan: bool,
}

fn main() {
    if std::env::args().skip(1).any(|a| a == "--statusline") {
        statusline::run();
    }
    // Lumo's computer use for the island's Claude Code chat (mcp.rs).
    if std::env::args().skip(1).any(|a| a == "--mcp") {
        mcp::run();
    }
    let args = args();
    let raw = read_stdin();
    let env = |key: &str| std::env::var(key).ok();
    let cwd = std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();

    // A Claude Code or Antigravity CLI run started by the island's own chat
    // (claude_code.rs, antigravity_cli.rs) is not a session to show: only its
    // permission requests go through, as the chat's Allow / Deny card.
    // Everything else gets the usual "no opinion".
    let from_island = is_island_run(&env);
    // A command of the island's Claude Code chat that would sit waiting on
    // GitHub (`gh pr checks --watch`, a sleep loop) holds the whole chat:
    // Claude is told to let Lumo listen instead (listen.rs), at once.
    if from_island && args.agent.is_empty() && args.chat_guard {
        if waits_on_github(&raw) {
            print(Some(reply::claude_wait_denied()));
        }
        // Anything else is not ours to show: Claude Code goes on as its mode says.
        std::process::exit(0);
    }
    // The island's Copilot CLI and Cursor CLI chats (acp_chat.rs) ask Lumo
    // over ACP themselves: Lumo's hooks of those CLIs stay out of them, with
    // the usual "no opinion", so a request never comes up twice.
    if from_island && is_acp_run(&env) {
        print(reply::stdout(&args.agent, normalize::event(&args.event), None, None));
        std::process::exit(0);
    }
    let prepared = prepare(&raw, &args, &env, &cwd).filter(|e| !from_island || e.name == "PermissionRequest");
    let Some(event) = prepared else {
        // Nothing we could forward. An agent that needs JSON still gets its
        // "no opinion" — Copilot is fail-closed and would deny without it.
        let name = normalize::event(&args.event);
        print(reply::stdout(&args.agent, name, None, None));
        std::process::exit(0);
    };

    // Only an agent whose decisions the island can give waits for one; any other
    // would be held for nothing, its decision being thrown away (reply.rs).
    let waits_for_answer = event.name == "PermissionRequest" && (event.island_card || event.agy_gate || reply::takes_decisions(&args.agent));
    let budget = match (waits_for_answer, event.island_card || event.agy_gate) {
        (true, true) => card_budget(args.wait),
        (true, false) => DECISION_BUDGET,
        _ => FIRE_AND_FORGET_BUDGET,
    };

    // The worker owns every blocking call. If it overruns the budget we simply
    // stop listening and exit: the process dying takes the pipe handle with it.
    // (No catch_unwind here — the release profile is panic = "abort", so it would
    // be dead code. `talk` is written to have nothing to panic on instead.)
    let (tx, rx) = mpsc::channel::<Heard>();
    let line = event.line.clone();
    std::thread::spawn(move || {
        let _ = tx.send(talk(&line, waits_for_answer));
    });

    // Claude Code ends the relay when its prompt is answered in the terminal,
    // and the app sees the pipe close at once. A shell between them (Git Bash,
    // cmd) can be the one ended, leaving us orphaned: its going ends us too.
    let parent = if waits_for_answer { parent() } else { None };
    let heard = wait(&rx, budget, || parent.as_ref().is_some_and(|p| p.gone()));
    let decision = match &heard {
        Heard::Said(d) => Some(d.clone()),
        _ => None,
    };
    // Letting it edit freely is for a plan only: on anything else it is the allow it also is.
    let decision = decision.map(|d| if d.trim() == "edits" && !event.plan { "allow".to_string() } else { d });
    if event.island_card {
        let why = match heard {
            Heard::NoLumo => reply::Unanswered::NotRunning,
            Heard::TimedOut => reply::Unanswered::TimedOut,
            _ => reply::Unanswered::Unknown,
        };
        print(Some(reply::antigravity_island(decision.as_deref(), why, budget.as_secs())));
    } else if event.agy_gate {
        print(Some(reply::antigravity_gate(decision.as_deref())));
    } else {
        print(reply::stdout(&args.agent, &event.name, decision.as_deref(), event.question.as_ref()));
    }
    std::process::exit(0);
}

/// What came back from Lumo.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Heard {
    /// Its one line: the decision, or why there is none (`unanswered …`).
    Said(String),
    /// Nothing: no answer awaited, or none came before the pipe closed.
    Nothing,
    /// No Lumo to talk to: the pipe isn't there, or took nothing.
    NoLumo,
    /// The budget ran out first.
    TimedOut,
}

/// The worker's answer, or nothing once `budget` runs out (TimedOut) or
/// `gone()` says the process that ran us has gone.
fn wait(rx: &mpsc::Receiver<Heard>, budget: Duration, gone: impl Fn() -> bool) -> Heard {
    let deadline = Instant::now() + budget;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Heard::TimedOut;
        }
        match rx.recv_timeout(left.min(PARENT_POLL)) {
            Ok(heard) => return heard,
            Err(mpsc::RecvTimeoutError::Timeout) if gone() => return Heard::Nothing,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Heard::Nothing,
        }
    }
}

/// The event on stdin: whatever came within STDIN_TIMEOUT, at most MAX_STDIN.
/// The thread still reading when time is up goes with the process.
fn read_stdin() -> Vec<u8> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut raw = Vec::new();
        let _ = std::io::stdin().lock().take(MAX_STDIN).read_to_end(&mut raw);
        let _ = tx.send(raw);
    });
    rx.recv_timeout(STDIN_TIMEOUT).unwrap_or_default()
}

/// A PreToolUse of a shell command that would wait (reply::blocking_wait).
fn waits_on_github(raw: &[u8]) -> bool {
    let Ok(v) = serde_json::from_slice::<Value>(without_bom(raw)) else { return false };
    matches!(v["tool_name"].as_str(), Some("Bash" | "PowerShell"))
        && v["tool_input"]["command"].as_str().is_some_and(reply::blocking_wait)
}

fn print(line: Option<String>) {
    if let Some(line) = line {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
}

/// Some shells hand us a UTF-8 BOM; serde_json would choke on it.
fn without_bom(raw: &[u8]) -> &[u8] {
    raw.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(raw)
}

/// The payload to forward, from the raw stdin bytes. `env` reads an environment
/// variable and `cwd` is the working directory, so tests stay pure.
fn prepare(raw: &[u8], args: &Args, env: &dyn Fn(&str) -> Option<String>, cwd: &str) -> Option<Event> {
    let mut payload = serde_json::from_slice::<Value>(without_bom(raw)).ok()?;
    let map = payload.as_object_mut()?;

    // Which agent this hook was installed for, so the app routes it to the right
    // pill. Absent means Claude Code, so existing hook commands keep working
    // unchanged; invalid names are discarded by the app, not here. A Claude Code
    // session started from the Claude desktop app is tagged `claude-desktop`.
    if let Some(tag) = agent_tag(&args.agent, env) {
        map.insert("lumo_agent".into(), Value::String(tag));
    }
    if is_island_run(env) {
        map.insert("lumo_island".into(), Value::Bool(true));
    } else if background::is_background(&args.agent, env) {
        // Started by another program, on its own (background.rs): the island
        // groups it under that program. The process chain is only read in the
        // app, never in tests.
        map.insert("lumo_background".into(), Value::Bool(true));
        let chain = || if cfg!(test) { Vec::new() } else { ancestry() };
        if let Some(name) = background::launcher(env, chain) {
            map.insert("lumo_launcher".into(), Value::String(name));
        }
        if let Some(total) = background::batch_total(env) {
            map.insert("lumo_batch_total".into(), Value::from(total));
        }
    }
    // Claude Code in Cursor's terminal goes on the Cursor pill.
    if !map.contains_key("term_editor") {
        if let Some(editor) = term_editor(env) {
            map.insert("term_editor".into(), Value::String(editor.into()));
        }
    }

    let raw_event = map
        .get("hook_event_name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| args.event.clone());
    normalize::fields(map, env);
    let name = normalize::refine(normalize::event(&raw_event), map);
    // The island's own Antigravity CLI chat runs agy headless, which quietly
    // denies a shell command nobody approved. Its PreToolUse for one goes to
    // the island as a permission request instead: the chat's Allow / Deny card.
    // (The island's Claude Code chat needs none of this: its PermissionRequest
    // hook comes as Claude Code's own, exactly when it would ask.)
    let tool = map.get("tool_name").and_then(Value::as_str).unwrap_or("");
    let island_card = is_island_run(env)
        && name == "PreToolUse"
        && args.agent == "antigravity"
        && (reply::island_card(tool, map.get("tool_input"))
            || reply::writes_outside(tool, map.get("tool_input"), &workspaces(map))
            || reply::reads_outside(tool, map.get("tool_input"), &workspaces(map)));
    // A shell command Antigravity is about to run in your own session (IDE or
    // CLI) that none of its rules covers: the island's Allow / Deny card, with
    // "Reply in Antigravity" to leave it to Antigravity's own prompt. Only with
    // hooks that give the relay time to wait (`--wait`).
    let agy_gate = !island_card && !is_island_run(env) && name == "PreToolUse" && args.agent == "antigravity" && args.wait.is_some() && {
        let command = shell_command(tool, map.get("tool_input"));
        let cwd = map.get("cwd").and_then(Value::as_str).unwrap_or(cwd);
        command.is_some_and(|c| agy_rules::AgyRules::load(&home_dir(env), cwd).verdict(c) == agy_rules::Verdict::Unknown)
    };
    if agy_gate {
        map.insert("lumo_agy_gate".into(), Value::Bool(true));
    }
    let island_card_like = island_card || agy_gate;
    let name = if island_card_like { "PermissionRequest".to_string() } else { name };
    if island_card_like {
        // The island takes the card down just before the relay stops waiting.
        map.insert("lumo_card_secs".into(), Value::from(card_budget(args.wait).as_secs()));
    }
    map.insert("hook_event_name".into(), Value::String(name.clone()));

    // A task Claude Code made: its id is all that is kept of the result, for
    // the Plan island (TaskUpdate names the task by it).
    if map.get("tool_name").and_then(Value::as_str) == Some("TaskCreate") {
        let id = map.get("tool_response").and_then(|r| r.pointer("/task/id")).and_then(Value::as_str).map(str::to_string);
        if let Some(id) = id {
            map.insert("lumo_task_id".into(), Value::String(id));
        }
    }
    // A Claude Code session's title, for the island to name it by (title.rs).
    // Only where it can change: a session (re)starts, a prompt (after a
    // /rename), a turn ends (Claude Code titles a session after its first one).
    if args.agent.is_empty() && TITLE_EVENTS.contains(&name.as_str()) {
        let title = map.get("transcript_path").and_then(Value::as_str).filter(|p| !p.is_empty()).and_then(|p| title::session_title(std::path::Path::new(p)));
        if let Some(title) = title {
            map.insert("lumo_title".into(), Value::String(title));
        }
    }
    for field in DROPPED_FIELDS {
        map.remove(*field);
    }

    if map.get("cwd").and_then(Value::as_str).map(str::is_empty).unwrap_or(true) && !cwd.is_empty() {
        map.insert("cwd".into(), Value::String(cwd.to_string()));
    }

    // Kept whole: what goes back to Claude Code must be its own input, not the
    // shortened copy the island is shown.
    let question = (map.get("tool_name").and_then(Value::as_str) == Some("AskUserQuestion"))
        .then(|| map.get("tool_input").cloned())
        .flatten();
    let plan = name == "PermissionRequest" && map.get("tool_name").and_then(Value::as_str) == Some("ExitPlanMode");

    // Every string is capped, except the edit text of a finished Edit /
    // MultiEdit / Write, which the live diff needs whole (within its own limits).
    truncate_payload(&mut payload, &name);

    let mut line = payload.to_string();
    line.push('\n');
    Some(Event { line, name, question, island_card, agy_gate, plan })
}

/// The shell command of an Antigravity `run_command` call, when it reached
/// the relay whole: a command too long to forward whole (a permission
/// request's target goes whole up to MAX_TARGET_LEN) is not one to approve
/// without seeing it, nor one its rules could read.
fn shell_command<'a>(tool: &str, input: Option<&'a Value>) -> Option<&'a str> {
    if tool != "run_command" && !tool.ends_with(":run_command") {
        return None;
    }
    let command = input?.get("command")?.as_str()?;
    let whole = command.len() <= MAX_TARGET_LEN;
    Some(command.trim()).filter(|c| whole && !c.is_empty())
}

/// The user's home folder, where Antigravity keeps its rules (`.gemini`).
fn home_dir(env: &dyn Fn(&str) -> Option<String>) -> std::path::PathBuf {
    env("USERPROFILE").or_else(|| env("HOME")).map(std::path::PathBuf::from).unwrap_or_default()
}

/// Antigravity's `workspacePaths`: the folders its run may change.
fn workspaces(map: &serde_json::Map<String, Value>) -> Vec<String> {
    map.get("workspacePaths")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

/// The island's chat started this run (claude_code.rs and antigravity_cli.rs set the variable).
fn is_island_run(env: &dyn Fn(&str) -> Option<String>) -> bool {
    env(ISLAND_RUN_VAR).as_deref() == Some("1")
}

/// Set by the app on the `claude -p` and headless `agy` runs of its chat; hooks inherit it.
const ISLAND_RUN_VAR: &str = "LUMO_ISLAND_RUN";

/// Set by the app, with ISLAND_RUN_VAR, on the CLIs its chat talks to over ACP.
const ACP_RUN_VAR: &str = "LUMO_ACP_RUN";

fn is_acp_run(env: &dyn Fn(&str) -> Option<String>) -> bool {
    env(ACP_RUN_VAR).as_deref() == Some("1")
}

/// The `lumo_agent` tag: `--agent` when given, otherwise `claude-desktop` for
/// a Claude Code session started from the Claude desktop app, which says so in
/// CLAUDE_CODE_ENTRYPOINT. Nothing
/// for a plain Claude Code session.
fn agent_tag(arg: &str, env: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    if !arg.is_empty() {
        return Some(arg.to_string());
    }
    (env("CLAUDE_CODE_ENTRYPOINT").as_deref() == Some("claude-desktop"))
        .then(|| "claude-desktop".to_string())
}

/// `cursor` when the session runs in Cursor's integrated terminal. Cursor sets
/// TERM_PROGRAM=vscode like VS Code does, so it is told apart by its own trace
/// variable, or by its executable behind VS Code's git helper.
fn term_editor(env: &dyn Fn(&str) -> Option<String>) -> Option<&'static str> {
    if env("CURSOR_TRACE_ID").is_some_and(|v| !v.is_empty()) {
        return Some("cursor");
    }
    let helper = env("VSCODE_GIT_ASKPASS_NODE").unwrap_or_default();
    let exe = helper.rsplit(['/', '\\']).next().unwrap_or_default().to_ascii_lowercase();
    exe.starts_with("cursor").then_some("cursor")
}

/// Caps the strings of a payload: every field to MAX_FIELD_LEN, except the edit
/// strings of a finished Edit / MultiEdit / Write, which the live diff needs
/// whole. If even those had to be cut, `lumo_diff_truncated` tells the island
/// not to show counts it cannot trust.
fn truncate_payload(payload: &mut serde_json::Value, event: &str) {
    if event == "PermissionRequest" {
        let tool = payload.get("tool_name").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let input = payload.as_object_mut().and_then(|map| map.remove("tool_input"));
        // Only the relay says how big a change is: never what came in.
        if let Some(map) = payload.as_object_mut() {
            for key in ["lumo_write_bytes", "lumo_write_lines", "lumo_write_added", "lumo_write_removed", "lumo_input_bytes", "lumo_text_cut"] {
                map.remove(key);
            }
        }
        let cwd = payload.get("cwd").and_then(Value::as_str).map(str::to_string)
            .or_else(|| std::env::current_dir().ok().map(|p| p.to_string_lossy().to_string()))
            .unwrap_or_default();
        truncate_strings(payload);
        if let Some(mut input) = input {
            // What a file tool changes, read before its text is cut: the card
            // shows these numbers, never the text, so the text's size never matters.
            let stat = if CONTENT_TOOLS.contains(&tool.as_str()) { write_stat::of_request(&input, &cwd) } else { None };
            let whole_size = input.to_string().len();
            let cut = cap_request_strings(&mut input, &tool);
            if let Some(map) = payload.as_object_mut() {
                map.insert("tool_input".into(), input);
                if cut.input {
                    map.insert("lumo_input_cut".into(), Value::Bool(true));
                    map.insert("lumo_input_bytes".into(), Value::from(whole_size));
                }
                if cut.text {
                    map.insert("lumo_text_cut".into(), Value::Bool(true));
                }
                if let Some(stat) = stat {
                    map.insert("lumo_write_added".into(), Value::from(stat.added));
                    map.insert("lumo_write_removed".into(), Value::from(stat.removed));
                    if let Some(bytes) = stat.bytes {
                        map.insert("lumo_write_bytes".into(), Value::from(bytes));
                    }
                }
            }
        }
        return;
    }
    let keeps_diff = event == "PostToolUse"
        && payload
            .get("tool_name")
            .and_then(|v| v.as_str())
            .is_some_and(|tool| DIFF_TOOLS.contains(&tool));
    let input = if keeps_diff {
        payload.as_object_mut().and_then(|map| map.remove("tool_input"))
    } else {
        None
    };

    truncate_strings(payload);

    if let Some(mut input) = input {
        let mut budget = MAX_DIFF_TOTAL;
        let mut cut_any = false;
        cap_diff_strings(&mut input, &mut budget, &mut cut_any);
        if let Some(map) = payload.as_object_mut() {
            map.insert("tool_input".into(), input);
            if cut_any {
                map.insert("lumo_diff_truncated".into(), serde_json::Value::Bool(true));
            }
        }
    }
}

/// `tool_input` of a diff tool: edit strings share MAX_DIFF_TOTAL, each capped at
/// MAX_DIFF_FIELD_LEN; any other string gets the ordinary cap.
fn cap_diff_strings(value: &mut serde_json::Value, budget: &mut usize, cut_any: &mut bool) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, v) in map.iter_mut() {
                match v {
                    serde_json::Value::String(s) if DIFF_FIELDS.contains(&key.as_str()) => {
                        let limit = MAX_DIFF_FIELD_LEN.min(*budget);
                        if cut(s, limit) {
                            *cut_any = true;
                        }
                        *budget = budget.saturating_sub(s.len());
                    }
                    _ => cap_diff_strings(v, budget, cut_any),
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                cap_diff_strings(item, budget, cut_any);
            }
        }
        serde_json::Value::String(s) => {
            cut(s, MAX_FIELD_LEN);
        }
        _ => {}
    }
}

/// What `cap_request_strings` had to cut.
#[derive(Debug, Default, Clone, Copy)]
struct Cut {
    /// Something the card shows: its command, its file, its page, any other field.
    input: bool,
    /// Only the text a file tool writes, which the card never shows (write_stat.rs counts it).
    text: bool,
}

/// `tool_input` of a permission request: its target (TARGET_FIELDS, at the
/// top, and the text Lumo's computer use types) up to MAX_TARGET_LEN, the text
/// a file tool writes (CONTENT_TOOLS) up to the live diff's budget, any other
/// string the ordinary cap. Says what was cut: the island then knows the
/// input it got is not the whole.
fn cap_request_strings(input: &mut Value, tool: &str) -> Cut {
    let mut cut_any = false;
    let mut text_cut = false;
    let writes = CONTENT_TOOLS.contains(&tool);
    // The card of a Type shows every character it will type: the text is its
    // target, never cut within what the tool accepts (5,000 characters).
    let types = mcp::lumo_tool(tool) == Some("type");
    let mut budget = MAX_DIFF_TOTAL;
    if let Value::Object(map) = input {
        for (key, v) in map.iter_mut() {
            match v {
                Value::String(s) if TARGET_FIELDS.contains(&key.as_str()) || (types && key == "text") => {
                    cut_any |= cut(s, MAX_TARGET_LEN)
                }
                _ if writes => {
                    let (other, text) = cap_content(v, key, &mut budget);
                    cut_any |= other;
                    text_cut |= text;
                }
                _ => cut_any |= cap_all(v),
            }
        }
    } else {
        cut_any |= cap_all(input);
    }
    Cut { input: cut_any, text: text_cut }
}

/// Part of a file tool's input (MultiEdit's `edits` included): the text it
/// writes or replaces shares MAX_DIFF_TOTAL, each piece at most
/// MAX_DIFF_FIELD_LEN; any other string the ordinary cap. Says whether any
/// other string was cut, and whether any of the text was.
fn cap_content(value: &mut Value, key: &str, budget: &mut usize) -> (bool, bool) {
    let either = |(a, b): (bool, bool), (c, d): (bool, bool)| (a | c, b | d);
    match value {
        Value::String(s) if CONTENT_FIELDS.contains(&key) => {
            let was_cut = cut(s, MAX_DIFF_FIELD_LEN.min(*budget));
            *budget = budget.saturating_sub(s.len());
            (false, was_cut)
        }
        Value::Object(map) => map.iter_mut().fold((false, false), |any, (k, v)| either(any, cap_content(v, k, budget))),
        Value::Array(items) => items.iter_mut().fold((false, false), |any, v| either(any, cap_content(v, key, budget))),
        other => (cap_all(other), false),
    }
}

/// `truncate_strings`, saying whether anything was cut.
fn cap_all(value: &mut Value) -> bool {
    match value {
        Value::String(s) => cut(s, MAX_FIELD_LEN),
        Value::Array(items) => items.iter_mut().fold(false, |any, v| cap_all(v) | any),
        Value::Object(map) => map.values_mut().fold(false, |any, v| cap_all(v) | any),
        _ => false,
    }
}

/// Caps every string in the payload. A single Write can carry a whole file.
fn truncate_strings(value: &mut Value) {
    match value {
        Value::String(s) => {
            cut(s, MAX_FIELD_LEN);
        }
        Value::Array(items) => items.iter_mut().for_each(truncate_strings),
        Value::Object(map) => map.values_mut().for_each(truncate_strings),
        _ => {}
    }
}

/// Shortens `s` to at most `max` bytes plus an ellipsis; true if it was cut.
fn cut(s: &mut String, max: usize) -> bool {
    if s.len() <= max {
        return false;
    }
    // Cut on a char boundary; a lone byte index can split UTF-8.
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s.truncate(end);
    s.push('…');
    true
}

/// Connect, send, and — for a permission request — wait for the island's word.
fn talk(payload: &str, waits_for_answer: bool) -> Heard {
    let Some(mut pipe) = connect() else { return Heard::NoLumo };

    if pipe.write_all(payload.as_bytes()).is_err() {
        return Heard::NoLumo;
    }
    let _ = pipe.flush();

    if !waits_for_answer {
        return Heard::Nothing;
    }

    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let answer = String::from_utf8_lossy(&buf).trim().to_string();
    if answer.is_empty() { Heard::Nothing } else { Heard::Said(answer) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(raw: &str, agent: &str, event: &str) -> (Value, Event) {
        let args = Args { agent: agent.into(), event: event.into(), wait: None, chat_guard: false };
        let ev = prepare(raw.as_bytes(), &args, &|_| None, "/home/me/here").expect("forwarded");
        let v = serde_json::from_str(ev.line.trim_end()).unwrap();
        (v, ev)
    }

    fn env_of(vars: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| vars.iter().find(|(k, _)| *k == name).map(|(_, v)| v.to_string())
    }

    #[test]
    fn a_bom_does_not_hide_a_command_that_waits_on_github() {
        let command = br#"{"tool_name":"Bash","tool_input":{"command":"gh pr checks 12 --watch"}}"#;
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(command);
        assert!(waits_on_github(command));
        assert!(waits_on_github(&bom));
    }

    #[test]
    fn the_islands_own_runs_are_marked() {
        let args = Args { agent: String::new(), event: String::new(), wait: None, chat_guard: false };
        let raw = br#"{"hook_event_name":"PermissionRequest","tool_name":"Write"}"#;
        let ev = prepare(raw, &args, &env_of(&[("LUMO_ISLAND_RUN", "1")]), "/p").unwrap();
        assert!(ev.line.contains(r#""lumo_island":true"#));
        assert!(is_island_run(&env_of(&[("LUMO_ISLAND_RUN", "1")])));
        assert!(is_acp_run(&env_of(&[("LUMO_ACP_RUN", "1")])));
        assert!(!is_acp_run(&env_of(&[("LUMO_ISLAND_RUN", "1")])));
        let ev = prepare(raw, &args, &|_| None, "/p").unwrap();
        assert!(!ev.line.contains("lumo_island"));
        assert!(!is_island_run(&|_| None));
    }

    #[test]
    fn a_session_another_program_started_is_marked_with_its_name() {
        let args = Args { agent: String::new(), event: String::new(), wait: None, chat_guard: false };
        let raw = br#"{"hook_event_name":"Stop","session_id":"s"}"#;
        let headless = env_of(&[
            ("CLAUDE_CODE_ENTRYPOINT", "sdk-cli"),
            ("LUMO_LAUNCHER", "Easy Uninstaller"),
            ("LUMO_BATCH_TOTAL", "120"),
        ]);
        let v: Value = serde_json::from_str(prepare(raw, &args, &headless, "/p").unwrap().line.trim_end()).unwrap();
        assert_eq!(v["lumo_background"], true);
        assert_eq!(v["lumo_launcher"], "Easy Uninstaller");
        assert_eq!(v["lumo_batch_total"], 120);
        // No name to give: still in the background.
        let v: Value = serde_json::from_str(prepare(raw, &args, &env_of(&[("CLAUDE_CODE_ENTRYPOINT", "sdk-cli")]), "/p").unwrap().line.trim_end()).unwrap();
        assert_eq!(v["lumo_background"], true);
        assert!(v.get("lumo_launcher").is_none());
        assert!(v.get("lumo_batch_total").is_none());
        // The island's own chat runs with -p too: it stays the island's.
        let own = env_of(&[("CLAUDE_CODE_ENTRYPOINT", "sdk-cli"), ("LUMO_ISLAND_RUN", "1")]);
        assert!(!prepare(raw, &args, &own, "/p").unwrap().line.contains("lumo_background"));
        // A session in a terminal is not.
        let typed = env_of(&[("CLAUDE_CODE_ENTRYPOINT", "cli")]);
        assert!(!prepare(raw, &args, &typed, "/p").unwrap().line.contains("lumo_background"));
    }

    #[test]
    fn a_task_made_keeps_only_its_id_of_the_result() {
        let args = Args { agent: String::new(), event: "PostToolUse".into(), wait: None, chat_guard: false };
        let raw = br#"{"hook_event_name":"PostToolUse","session_id":"s","tool_name":"TaskCreate","tool_input":{"subject":"Write game.py"},"tool_response":{"task":{"id":"7","subject":"Write game.py"}}}"#;
        let ev = prepare(raw, &args, &|_| None, "/p").unwrap();
        let v: Value = serde_json::from_str(ev.line.trim_end()).unwrap();
        assert_eq!(v["lumo_task_id"], "7");
        assert!(v.get("tool_response").is_none());
    }

    #[test]
    fn the_islands_claude_code_chat_asks_with_claude_codes_own_permission_request() {
        let island = env_of(&[("LUMO_ISLAND_RUN", "1")]);
        let ask = Args { agent: String::new(), event: "PermissionRequest".into(), wait: None, chat_guard: false };
        let request = br#"{"hook_event_name":"PermissionRequest","session_id":"s","tool_name":"PowerShell","tool_input":{"command":"Start-Process whatsapp:"}}"#;
        let ev = prepare(request, &ask, &island, "/p").unwrap();
        // Claude Code's own request: answered as one (reply::stdout), not as a converted card.
        assert!(!ev.island_card);
        assert_eq!(ev.name, "PermissionRequest");
        let v: Value = serde_json::from_str(ev.line.trim_end()).unwrap();
        assert_eq!(v["lumo_island"], true, "the card goes over the chat");
        assert!(v.get("lumo_agent").is_none());
        // Its PreToolUse never becomes a card.
        let pre = Args { agent: String::new(), event: "PreToolUse".into(), wait: Some(110), chat_guard: false };
        let command = br#"{"hook_event_name":"PreToolUse","tool_name":"PowerShell","tool_input":{"command":"ls"}}"#;
        assert!(!prepare(command, &pre, &island, "/p").unwrap().island_card);
    }

    #[test]
    fn a_shell_command_of_the_islands_antigravity_chat_is_a_permission_request() {
        let island = env_of(&[("LUMO_ISLAND_RUN", "1")]);
        let agy = Args { agent: "antigravity".into(), event: "PreToolUse".into(), wait: Some(100), chat_guard: false };
        let command = br#"{"hook_event_name":"PreToolUse","conversationId":"c1","toolCall":{"name":"run_command","args":{"CommandLine":"npm test"}}}"#;
        let ev = prepare(command, &agy, &island, "/p").unwrap();
        assert!(ev.island_card);
        assert_eq!(ev.name, "PermissionRequest");
        let v: Value = serde_json::from_str(ev.line.trim_end()).unwrap();
        assert_eq!(v["hook_event_name"], "PermissionRequest");
        assert_eq!(v["lumo_agent"], "antigravity");
        assert_eq!(v["lumo_island"], true);
        assert_eq!(v["tool_input"]["command"], "npm test");
        assert_eq!(v["lumo_card_secs"], 100, "what --wait allows");
        // Hooks installed before the chat came give the relay 10 s: it waits 8.
        assert_eq!(card_budget(None), Duration::from_secs(8));
        assert_eq!(card_budget(Some(100)), Duration::from_secs(100));
        assert_eq!(card_budget(Some(10_000)), DECISION_BUDGET, "never longer than any card");
        assert_eq!(card_budget(Some(0)), Duration::from_secs(1));

        // A file read in the workspace is no card: agy allows it by itself.
        let read = br#"{"hook_event_name":"PreToolUse","workspacePaths":["/w"],"toolCall":{"name":"view_file","args":{"AbsolutePath":"/w/a"}}}"#;
        let ev = prepare(read, &agy, &island, "/p").unwrap();
        assert!(!ev.island_card);
        assert_eq!(ev.name, "PreToolUse");
        // Outside it, it is a card: what the model reads, it can send on.
        let outside = br#"{"hook_event_name":"PreToolUse","workspacePaths":["/w"],"toolCall":{"name":"view_file","args":{"AbsolutePath":"/home/me/.ssh/id_ed25519"}}}"#;
        let ev = prepare(outside, &agy, &island, "/p").unwrap();
        assert!(ev.island_card);
        assert_eq!(ev.name, "PermissionRequest");
        // And a page read always is.
        let page = br#"{"hook_event_name":"PreToolUse","workspacePaths":["/w"],"toolCall":{"name":"read_url_content","args":{"Url":"https://example.com/?d=x"}}}"#;
        assert!(prepare(page, &agy, &island, "/p").unwrap().island_card);

        // Outside the island's chat, with hooks that give the relay no time to
        // wait, Antigravity's own prompt keeps the command (with time, it is
        // the gate's card: an_antigravity_command_no_rule_covers_…).
        let no_wait = Args { agent: "antigravity".into(), event: "PreToolUse".into(), wait: None, chat_guard: false };
        let ev = prepare(command, &no_wait, &|_| None, "/p").unwrap();
        assert!(!ev.island_card);
        assert_eq!(ev.name, "PreToolUse");
        // And no other agent's PreToolUse turns into a request.
        let gemini = Args { agent: "gemini".into(), event: "PreToolUse".into(), wait: None, chat_guard: false };
        let ev = prepare(command, &gemini, &island, "/p").unwrap();
        assert!(!ev.island_card);
        assert_eq!(ev.name, "PreToolUse");
    }

    #[test]
    fn claude_desktop_sessions_are_tagged_and_an_explicit_agent_wins() {
        let desktop = env_of(&[("CLAUDE_CODE_ENTRYPOINT", "claude-desktop")]);
        assert_eq!(agent_tag("", &desktop).as_deref(), Some("claude-desktop"));
        assert_eq!(agent_tag("gemini", &desktop).as_deref(), Some("gemini"));
        assert_eq!(agent_tag("", &env_of(&[("CLAUDE_CODE_ENTRYPOINT", "cli")])), None);
        assert_eq!(agent_tag("", &env_of(&[])), None);
    }

    #[test]
    fn cursor_is_told_apart_from_vs_code() {
        assert_eq!(term_editor(&env_of(&[("CURSOR_TRACE_ID", "abc")])), Some("cursor"));
        assert_eq!(
            term_editor(&env_of(&[(
                "VSCODE_GIT_ASKPASS_NODE",
                r"C:\Users\me\AppData\Local\Programs\cursor\Cursor.exe"
            )])),
            Some("cursor")
        );
        assert_eq!(
            term_editor(&env_of(&[(
                "VSCODE_GIT_ASKPASS_NODE",
                r"C:\Users\me\AppData\Local\Programs\Microsoft VS Code\Code.exe"
            )])),
            None
        );
        assert_eq!(term_editor(&env_of(&[("CURSOR_TRACE_ID", "")])), None);
        assert_eq!(term_editor(&env_of(&[("TERM_PROGRAM", "vscode")])), None);
    }

    #[test]
    fn long_strings_are_cut_on_a_char_boundary() {
        let mut v = serde_json::json!({ "tool_input": { "content": "é".repeat(4000) } });
        truncate_strings(&mut v);
        let s = v["tool_input"]["content"].as_str().unwrap();
        assert!(s.len() <= MAX_FIELD_LEN + 4);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn claude_code_payloads_are_forwarded_as_they_are() {
        let (v, ev) = run(r#"{"hook_event_name":"PreToolUse","tool_name":"Bash","cwd":"/p"}"#, "", "PreToolUse");
        assert_eq!(ev.name, "PreToolUse");
        assert!(v.get("lumo_agent").is_none());
        assert_eq!(v["cwd"], "/p");
        assert_eq!(v["tool_name"], "Bash");
    }

    #[test]
    fn an_agents_event_is_tagged_and_renamed() {
        // Gemini CLI: its own name in the payload, ours on the command line.
        let (v, ev) = run(r#"{"hook_event_name":"BeforeTool","toolCall":{"name":"shell","args":{"CommandLine":"ls"}}}"#, "gemini", "PreToolUse");
        assert_eq!(ev.name, "PreToolUse");
        assert_eq!(v["hook_event_name"], "PreToolUse");
        assert_eq!(v["lumo_agent"], "gemini");
        assert_eq!(v["tool_input"]["command"], "ls");
        assert_eq!(v["cwd"], "/home/me/here");

        // Copilot CLI sends no event name: the command line's camelCase one is used.
        let (_, ev) = run(r#"{"toolName":"bash"}"#, "copilot", "permissionRequest");
        assert_eq!(ev.name, "PermissionRequest");

        // Cursor: a stop that failed, and its tool output left behind.
        let (v, ev) = run(r#"{"hook_event_name":"stop","status":"error","tool_output":"huge"}"#, "cursor", "");
        assert_eq!(ev.name, "StopFailure");
        assert!(v.get("tool_output").is_none());
    }

    #[test]
    fn a_question_is_kept_whole_and_only_for_ask_user_question() {
        let long = "x".repeat(3000);
        let raw = format!(r#"{{"hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion","tool_input":{{"questions":[{{"question":"{long}"}}]}}}}"#);
        let (v, ev) = run(&raw, "", "");
        assert_eq!(ev.question.unwrap()["questions"][0]["question"].as_str().unwrap().len(), 3000);
        assert!(v["tool_input"]["questions"][0]["question"].as_str().unwrap().ends_with('…'));
        let (_, ev) = run(r#"{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"ls"}}"#, "", "");
        assert!(ev.question.is_none());
    }

    #[test]
    fn what_cannot_be_read_is_not_forwarded() {
        let args = Args { agent: "copilot".into(), event: "preToolUse".into(), wait: None, chat_guard: false };
        for raw in ["", "not json", "[1,2]"] {
            assert!(prepare(raw.as_bytes(), &args, &|_| None, "/").is_none());
        }
        // A BOM is not a reason to drop the event.
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(br#"{"hook_event_name":"Stop"}"#);
        assert!(prepare(&bom, &args, &|_| None, "/").is_some());
    }

    #[test]
    fn the_live_diff_rule_holds_through_the_normalised_relay() {
        let big = "z".repeat(10_000);
        // Claude Code's finished Edit: kept whole.
        let raw = format!(r#"{{"hook_event_name":"PostToolUse","tool_name":"Edit","tool_input":{{"old_string":"{big}","new_string":"a"}}}}"#);
        let (v, _) = run(&raw, "", "");
        assert_eq!(v["tool_input"]["old_string"].as_str().unwrap().len(), big.len());
        // The same edit before it happens, or an agent's event renamed onto
        // PreToolUse: the ordinary cap.
        let raw = format!(r#"{{"hook_event_name":"PreToolUse","tool_name":"Edit","tool_input":{{"old_string":"{big}"}}}}"#);
        let (v, _) = run(&raw, "", "");
        assert!(v["tool_input"]["old_string"].as_str().unwrap().len() <= MAX_FIELD_LEN + 4);
        let raw = format!(r#"{{"hook_event_name":"BeforeTool","tool_name":"Edit","tool_input":{{"content":"{big}"}}}}"#);
        let (v, ev) = run(&raw, "gemini", "");
        assert_eq!(ev.name, "PreToolUse");
        assert!(v["tool_input"]["content"].as_str().unwrap().len() <= MAX_FIELD_LEN + 4);
    }

    #[test]
    fn a_finished_edit_keeps_its_text_whole_for_the_live_diff() {
        let big = "line\n".repeat(4_000); // 20 KB, well past MAX_FIELD_LEN
        let mut v = serde_json::json!({
            "tool_name": "Edit",
            "tool_input": { "file_path": "/p/a.ts", "old_string": big, "new_string": big },
            "cwd": "x".repeat(4_000),
        });
        truncate_payload(&mut v, "PostToolUse");
        assert_eq!(v["tool_input"]["old_string"].as_str().unwrap().len(), big.len());
        assert_eq!(v["tool_input"]["new_string"].as_str().unwrap().len(), big.len());
        // Everything else keeps the ordinary cap, and nothing says "cut".
        assert!(v["cwd"].as_str().unwrap().len() <= MAX_FIELD_LEN + 4);
        assert!(v.get("lumo_diff_truncated").is_none());

        let mut multi = serde_json::json!({
            "tool_name": "MultiEdit",
            "tool_input": { "edits": [{ "old_string": big, "new_string": "x" }] },
        });
        truncate_payload(&mut multi, "PostToolUse");
        assert_eq!(multi["tool_input"]["edits"][0]["old_string"].as_str().unwrap().len(), big.len());
    }

    #[test]
    fn edits_are_still_capped_before_they_happen_and_for_other_tools() {
        let big = "é".repeat(4_000);
        for (event, tool) in [("PreToolUse", "Edit"), ("PermissionRequest", "Bash"), ("PostToolUse", "Bash")] {
            let mut v = serde_json::json!({ "tool_name": tool, "tool_input": { "content": big } });
            truncate_payload(&mut v, event);
            assert!(v["tool_input"]["content"].as_str().unwrap().len() <= MAX_FIELD_LEN + 4, "{event} {tool}");
        }
    }

    #[test]
    fn a_permission_request_carries_its_whole_command_or_says_it_was_cut() {
        // A long script: the card gets all of it, nothing says "cut".
        let long = format!("cd x && npm run build && powershell -c \"{}\"", "Get-Item a; ".repeat(1_000));
        let mut v = serde_json::json!({ "tool_name": "Bash", "tool_input": { "command": long, "description": "Build" } });
        truncate_payload(&mut v, "PermissionRequest");
        assert_eq!(v["tool_input"]["command"].as_str().unwrap(), long);
        assert!(v.get("lumo_input_cut").is_none());
        // Past what a card can carry: cut, and flagged.
        let huge = "x".repeat(MAX_TARGET_LEN + 10);
        let mut v = serde_json::json!({ "tool_name": "Bash", "tool_input": { "command": huge } });
        truncate_payload(&mut v, "PermissionRequest");
        assert!(v["tool_input"]["command"].as_str().unwrap().len() <= MAX_TARGET_LEN + 4);
        assert_eq!(v["lumo_input_cut"], serde_json::Value::Bool(true));
        // Any other field cut counts too: the input is not the whole one.
        let mut v = serde_json::json!({ "tool_name": "mcp__x__y", "tool_input": { "body": "y".repeat(MAX_FIELD_LEN + 1) } });
        truncate_payload(&mut v, "PermissionRequest");
        assert_eq!(v["lumo_input_cut"], serde_json::Value::Bool(true));
        let mut v = serde_json::json!({ "tool_name": "Bash", "tool_input": { "command": "ls" }, "cwd": "c".repeat(MAX_FIELD_LEN + 1) });
        truncate_payload(&mut v, "PermissionRequest");
        assert!(v.get("lumo_input_cut").is_none(), "only the input counts");
    }

    #[test]
    fn the_text_computer_use_types_reaches_its_card_whole() {
        // 5,000 characters, accents included (more bytes than characters).
        let text = "è".repeat(2_500) + &"a\n".repeat(1_250);
        for tool in ["mcp__lumo__type", "mcp_lumo_type", "lumo/type"] {
            let mut v = serde_json::json!({ "tool_name": tool, "tool_input": { "text": text } });
            truncate_payload(&mut v, "PermissionRequest");
            assert_eq!(v["tool_input"]["text"].as_str().unwrap(), text, "{tool}");
            assert!(v.get("lumo_input_cut").is_none(), "{tool}");
        }
        // Past what a card carries: cut, and flagged.
        let mut v = serde_json::json!({ "tool_name": "mcp__lumo__type", "tool_input": { "text": "x".repeat(MAX_TARGET_LEN + 10) } });
        truncate_payload(&mut v, "PermissionRequest");
        assert!(v["tool_input"]["text"].as_str().unwrap().len() <= MAX_TARGET_LEN + 4);
        assert_eq!(v["lumo_input_cut"], serde_json::Value::Bool(true));
        // Another server's `type`, or another field: the ordinary cap.
        for (tool, key) in [("mcp__work_lumo__type", "text"), ("mcp__x__type", "text"), ("mcp__lumo__type", "note")] {
            let mut v = serde_json::json!({ "tool_name": tool, "tool_input": { key: "y".repeat(MAX_FIELD_LEN + 1) } });
            truncate_payload(&mut v, "PermissionRequest");
            assert_eq!(v["lumo_input_cut"], serde_json::Value::Bool(true), "{tool} {key}");
        }
    }

    #[test]
    fn a_file_write_asking_permission_is_not_cut_for_the_text_it_writes() {
        // A new file of 14 KB: the card shows its path and counts its lines,
        // so the text travels whole and nothing says "cut" (Allow stays).
        let file = "export const x = 1;\n".repeat(700);
        let mut v = serde_json::json!({ "tool_name": "Write", "tool_input": { "file_path": "C:/p/page.ts", "content": file } });
        truncate_payload(&mut v, "PermissionRequest");
        assert_eq!(v["tool_input"]["content"].as_str().unwrap(), file);
        assert!(v.get("lumo_input_cut").is_none());
        // Edit, MultiEdit (its edits inside an array) and NotebookEdit the same.
        let big = "line\n".repeat(1_000); // 5 KB
        for (tool, input) in [
            ("Edit", serde_json::json!({ "file_path": "C:/p/a.ts", "old_string": big, "new_string": big })),
            ("MultiEdit", serde_json::json!({ "file_path": "C:/p/a.ts", "edits": [{ "old_string": big, "new_string": big }] })),
            ("NotebookEdit", serde_json::json!({ "notebook_path": "C:/p/a.ipynb", "new_source": big })),
        ] {
            let mut v = serde_json::json!({ "tool_name": tool, "tool_input": input });
            truncate_payload(&mut v, "PermissionRequest");
            assert!(v.get("lumo_input_cut").is_none(), "{tool}");
            assert!(v.to_string().contains(&big.replace('\n', "\\n")), "{tool} keeps its text");
        }
        // Past the diff budget the text is cut, which the card never shows:
        // it says so apart (`lumo_text_cut`), and the numbers are the whole
        // text's, read before the cut. Nothing the card shows was cut.
        let huge = "x\n".repeat(MAX_DIFF_FIELD_LEN);
        let mut v = serde_json::json!({ "tool_name": "Write", "tool_input": { "file_path": "C:/lumo-test-none/big.txt", "content": huge } });
        truncate_payload(&mut v, "PermissionRequest");
        assert!(v["tool_input"]["content"].as_str().unwrap().len() <= MAX_DIFF_FIELD_LEN + 4);
        assert!(v.get("lumo_input_cut").is_none());
        assert_eq!(v["lumo_text_cut"], serde_json::Value::Bool(true));
        assert_eq!(v["lumo_write_added"], MAX_DIFF_FIELD_LEN, "a new file: every line of it");
        assert_eq!(v["lumo_write_removed"], 0);
        assert_eq!(v["lumo_write_bytes"], 2 * MAX_DIFF_FIELD_LEN);
        // The edits of one request together never pass the shared budget either.
        let half = "y".repeat(MAX_DIFF_FIELD_LEN - 1);
        let edits: Vec<_> = (0..4).map(|_| serde_json::json!({ "old_string": half, "new_string": half })).collect();
        let mut v = serde_json::json!({ "tool_name": "MultiEdit", "tool_input": { "file_path": "C:/p/a.ts", "edits": edits } });
        truncate_payload(&mut v, "PermissionRequest");
        assert!(v.to_string().len() < MAX_DIFF_TOTAL + 64 * 1024);
        assert_eq!(v["lumo_text_cut"], serde_json::Value::Bool(true));
        assert!(v.get("lumo_input_cut").is_none());
        // Any other field of a file tool keeps the ordinary cap, and says so.
        let mut v = serde_json::json!({ "tool_name": "Write", "tool_input": { "file_path": "C:/p/a.ts", "content": "a", "note": "n".repeat(MAX_FIELD_LEN + 1) } });
        truncate_payload(&mut v, "PermissionRequest");
        assert_eq!(v["lumo_input_cut"], serde_json::Value::Bool(true));
        assert!(v["lumo_input_bytes"].as_u64().unwrap() > MAX_FIELD_LEN as u64, "its whole size goes along");
        // The other agents' file tools the same: Antigravity, Copilot CLI, OpenCode.
        let page = "<li>item</li>\n".repeat(250); // ~3.5 KB
        for (tool, input) in [
            ("write_to_file", serde_json::json!({ "TargetFile": "C:/w/menu.html", "CodeContent": page, "Overwrite": true })),
            ("replace_file_content", serde_json::json!({ "TargetFile": "C:/w/a.md", "TargetContent": page, "ReplacementContent": page })),
            ("multi_replace_file_content", serde_json::json!({ "TargetFile": "C:/w/a.md", "ReplacementChunks": [{ "TargetContent": page, "ReplacementContent": page }] })),
            ("create", serde_json::json!({ "path": "C:/w/a.html", "file_text": page })),
            ("edit", serde_json::json!({ "path": "C:/w/a.html", "old_str": page, "new_str": page })),
            ("edit", serde_json::json!({ "filePath": "C:/w/a.html", "oldString": page, "newString": page })),
            ("write_file", serde_json::json!({ "file_path": "C:/w/a.html", "content": page })),
            // Antigravity CLI's own edit tool.
            ("edit_file", serde_json::json!({ "Path": "C:/w/a.md", "Target": page, "Replacement": page })),
        ] {
            let mut v = serde_json::json!({ "tool_name": tool, "tool_input": input });
            truncate_payload(&mut v, "PermissionRequest");
            assert!(v.get("lumo_input_cut").is_none(), "{tool}");
            assert!(v.to_string().contains(&page.replace('\n', "\\n")), "{tool} keeps its text");
        }
        // Another tool's long text field is still cut: its card shows all of its input.
        let mut v = serde_json::json!({ "tool_name": "mcp__x__y", "tool_input": { "content": "y".repeat(MAX_FIELD_LEN + 1) } });
        truncate_payload(&mut v, "PermissionRequest");
        assert_eq!(v["lumo_input_cut"], serde_json::Value::Bool(true));
    }

    #[test]
    fn antigravity_clis_edit_of_a_few_pages_reaches_its_card_whole_with_its_numbers() {
        // What Gemini sent in the island's Antigravity chat: about 21 KB of
        // LaTeX in edit_file's Target/Replacement. Before, past 2 KB, the
        // request was cut and so refused.
        let target = "\\label{def:serie}\n";
        let notes = "\\item una riga di appunti sulle serie numeriche\n".repeat(420);
        let replacement = format!("{target}{notes}");
        let mut v = serde_json::json!({ "tool_name": "edit_file", "tool_input": { "Path": "C:/Users/me/Downloads/Analisi2.tex", "Target": target, "Replacement": replacement } });
        truncate_payload(&mut v, "PermissionRequest");
        assert!(v.get("lumo_input_cut").is_none());
        assert!(v.get("lumo_text_cut").is_none());
        assert_eq!(v["tool_input"]["Replacement"].as_str().unwrap(), replacement);
        assert_eq!((v["lumo_write_added"].as_u64(), v["lumo_write_removed"].as_u64()), (Some(420), Some(0)));
    }

    #[test]
    fn a_rewrite_of_a_big_file_counts_against_the_file_on_disk() {
        let dir = std::env::temp_dir().join(format!("lumo-hook-rewrite-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Analisi2.tex");
        let old: String = (0..8_700).map(|i| format!("\\par riga {i} del capitolo\n")).collect();
        std::fs::write(&file, &old).unwrap();
        // 400 KB and more: the text is cut on its way to the island, the numbers are not.
        let new = format!("{old}{}", "\\item appunti nuovi\n".repeat(1_249));
        assert!(new.len() > MAX_DIFF_FIELD_LEN);
        let mut v = serde_json::json!({ "tool_name": "write_to_file", "cwd": dir.to_string_lossy(), "tool_input": { "TargetFile": "Analisi2.tex", "CodeContent": new } });
        truncate_payload(&mut v, "PermissionRequest");
        assert_eq!(v["lumo_text_cut"], serde_json::Value::Bool(true));
        assert!(v.get("lumo_input_cut").is_none());
        assert_eq!((v["lumo_write_added"].as_u64(), v["lumo_write_removed"].as_u64()), (Some(1_249), Some(0)));
        assert_eq!(v["lumo_write_bytes"].as_u64(), Some(new.len() as u64));
        // What came in is never taken as the relay's word.
        let mut v = serde_json::json!({ "tool_name": "Bash", "tool_input": { "command": "ls" }, "lumo_write_added": 1, "lumo_text_cut": true });
        truncate_payload(&mut v, "PermissionRequest");
        assert!(v.get("lumo_write_added").is_none() && v.get("lumo_text_cut").is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_write_cut_short_still_tells_the_island_its_real_size() {
        // 400 KB in 4 096 lines, a new file: the text is cut at 256 KB, apart
        // (lumo_text_cut, Allow stays), and the card is told the file's own
        // numbers, not the cut's.
        let line = format!("{}\n", "x".repeat(99));
        let huge = line.repeat(4_096);
        let mut v = serde_json::json!({ "tool_name": "Write", "tool_input": { "file_path": "C:/lumo-test-none/big.txt", "content": huge } });
        truncate_payload(&mut v, "PermissionRequest");
        assert_eq!(v["lumo_text_cut"], serde_json::Value::Bool(true));
        assert!(v.get("lumo_input_cut").is_none());
        assert_eq!(v["lumo_write_bytes"], 400 * 1024);
        assert_eq!(v["lumo_write_added"], 4_096);
        assert_eq!(v["lumo_write_removed"], 0);
        // Bytes, not characters; a last line with no break still counts.
        let accents = "è".repeat(MAX_DIFF_FIELD_LEN) + "\nend";
        let mut v = serde_json::json!({ "tool_name": "Write", "tool_input": { "file_path": "C:/lumo-test-none/a.txt", "content": accents } });
        truncate_payload(&mut v, "PermissionRequest");
        assert_eq!(v["lumo_write_bytes"], MAX_DIFF_FIELD_LEN * 2 + 4);
        assert_eq!(v["lumo_write_added"], 2);
        // Whole: the same numbers, and nothing says "cut".
        let mut v = serde_json::json!({ "tool_name": "Write", "tool_input": { "file_path": "C:/lumo-test-none/a.txt", "content": "a\nb\n" } });
        truncate_payload(&mut v, "PermissionRequest");
        assert_eq!((v["lumo_write_added"].as_u64(), v["lumo_write_bytes"].as_u64()), (Some(2), Some(4)));
        assert!(v.get("lumo_text_cut").is_none() && v.get("lumo_input_cut").is_none());
        // Never numbers that came in with the request.
        let mut v = serde_json::json!({ "tool_name": "Bash", "lumo_write_bytes": 1, "lumo_write_lines": 1, "tool_input": { "command": "ls" } });
        truncate_payload(&mut v, "PermissionRequest");
        assert!(v.get("lumo_write_bytes").is_none() && v.get("lumo_write_lines").is_none());
        // An Edit cut short: counted from its whole text, which the card never shows.
        let mut v = serde_json::json!({ "tool_name": "Edit", "tool_input": { "file_path": "C:/p/a.txt", "old_string": "a", "new_string": "x\n".repeat(MAX_DIFF_FIELD_LEN) } });
        truncate_payload(&mut v, "PermissionRequest");
        assert_eq!(v["lumo_text_cut"], serde_json::Value::Bool(true));
        assert_eq!((v["lumo_write_added"].as_u64(), v["lumo_write_removed"].as_u64()), (Some(MAX_DIFF_FIELD_LEN as u64), Some(1)));
        assert!(v.get("lumo_write_bytes").is_none(), "a size only for a whole-file write");
    }

    #[test]
    fn a_long_plan_asking_to_start_reaches_the_island_whole() {
        let plan = "1. Read the settings page\n2. Add the toggle\n\n".to_string() + &"Details. ".repeat(320); // ~2.9 KB
        let mut v = serde_json::json!({ "tool_name": "ExitPlanMode", "tool_input": { "plan": plan } });
        truncate_payload(&mut v, "PermissionRequest");
        assert_eq!(v["tool_input"]["plan"].as_str().unwrap(), plan);
        assert!(v.get("lumo_input_cut").is_none());
        let huge = "p".repeat(MAX_TARGET_LEN + 10);
        let mut v = serde_json::json!({ "tool_name": "ExitPlanMode", "tool_input": { "plan": huge } });
        truncate_payload(&mut v, "PermissionRequest");
        assert_eq!(v["lumo_input_cut"], serde_json::Value::Bool(true));
    }

    #[test]
    fn an_edit_beyond_the_budget_is_cut_and_flagged() {
        let huge = "x".repeat(MAX_DIFF_FIELD_LEN + 10);
        let mut v = serde_json::json!({
            "tool_name": "Write",
            "tool_input": { "file_path": "/p/big.txt", "content": huge },
        });
        truncate_payload(&mut v, "PostToolUse");
        assert!(v["tool_input"]["content"].as_str().unwrap().len() <= MAX_DIFF_FIELD_LEN + 4);
        assert_eq!(v["lumo_diff_truncated"], serde_json::Value::Bool(true));

        // Together, the edit strings never pass the shared budget.
        let half = "y".repeat(MAX_DIFF_FIELD_LEN - 1);
        let edits: Vec<_> = (0..4)
            .map(|_| serde_json::json!({ "old_string": half, "new_string": half }))
            .collect();
        let mut multi = serde_json::json!({ "tool_name": "MultiEdit", "tool_input": { "edits": edits } });
        truncate_payload(&mut multi, "PostToolUse");
        assert!(multi.to_string().len() < MAX_DIFF_TOTAL + 64 * 1024);
        assert_eq!(multi["lumo_diff_truncated"], serde_json::Value::Bool(true));
    }

    #[test]
    fn a_waiting_relay_gives_up_as_soon_as_its_parent_is_gone() {
        let (tx, rx) = mpsc::channel::<Heard>();
        let started = Instant::now();
        let checks = std::cell::Cell::new(0);
        let gone = || {
            checks.set(checks.get() + 1);
            checks.get() >= 2
        };
        assert_eq!(wait(&rx, Duration::from_secs(5), gone), Heard::Nothing);
        assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
        // An answer still wins while the parent is there.
        tx.send(Heard::Said("allow".into())).unwrap();
        assert_eq!(wait(&rx, Duration::from_secs(5), || false), Heard::Said("allow".into()));
        // And the budget still ends a wait nobody answers, and says so.
        let started = Instant::now();
        assert_eq!(wait(&rx, Duration::from_millis(150), || false), Heard::TimedOut);
        assert!(started.elapsed() >= Duration::from_millis(150));
        drop(tx);
    }

    #[test]
    fn an_antigravity_command_no_rule_covers_is_a_card_that_otherwise_asks() {
        let home = std::env::temp_dir().join(format!("lumo-agy-gate-{}", std::process::id()));
        let settings = home.join(".gemini").join("antigravity-cli");
        std::fs::create_dir_all(&settings).unwrap();
        std::fs::write(settings.join("settings.json"), r#"{"permissions":{"allow":["command(ls)"],"deny":["command(rm -rf)"]}}"#).unwrap();
        let home_str = home.to_string_lossy().to_string();
        let env = |k: &str| (k == "USERPROFILE").then(|| home_str.clone());
        let agy = Args { agent: "antigravity".into(), event: "PreToolUse".into(), wait: Some(100), chat_guard: false };
        let run = |cmd: &str| format!(r#"{{"hook_event_name":"PreToolUse","conversationId":"c1","workspacePaths":["/w"],"toolCall":{{"name":"run_command","args":{{"CommandLine":"{cmd}"}}}}}}"#);

        let ev = prepare(run("npm install").as_bytes(), &agy, &env, "/p").unwrap();
        assert!(ev.agy_gate && !ev.island_card);
        assert_eq!(ev.name, "PermissionRequest");
        let v: Value = serde_json::from_str(ev.line.trim_end()).unwrap();
        assert_eq!(v["lumo_agy_gate"], true);
        assert_eq!(v["lumo_card_secs"], 100);
        assert!(v.get("lumo_island").is_none());

        // Antigravity's own rules decide these: no card, PreToolUse as before.
        for cmd in ["ls -la", "rm -rf build"] {
            let ev = prepare(run(cmd).as_bytes(), &agy, &env, "/p").unwrap();
            assert!(!ev.agy_gate, "{cmd}");
            assert_eq!(ev.name, "PreToolUse");
        }
        // A long command goes to the island whole, as any permission request's
        // target does; one too long to forward whole is left to Antigravity.
        let long = format!("npm run build -- {}", "x".repeat(3 * MAX_FIELD_LEN));
        let ev = prepare(run(&long).as_bytes(), &agy, &env, "/p").unwrap();
        assert!(ev.agy_gate);
        let v: Value = serde_json::from_str(ev.line.trim_end()).unwrap();
        assert_eq!(v["tool_input"]["command"], long.as_str());
        assert!(v.get("lumo_input_cut").is_none());
        let too_long = format!("npm run build -- {}", "x".repeat(MAX_TARGET_LEN));
        assert!(!prepare(run(&too_long).as_bytes(), &agy, &env, "/p").unwrap().agy_gate);
        // Hooks that give no time to wait, another tool, or the island's own chat: no gate.
        let short = Args { agent: "antigravity".into(), event: "PreToolUse".into(), wait: None, chat_guard: false };
        assert!(!prepare(run("npm install").as_bytes(), &short, &env, "/p").unwrap().agy_gate);
        let read = br#"{"hook_event_name":"PreToolUse","toolCall":{"name":"view_file","args":{"AbsolutePath":"/a"}}}"#;
        assert!(!prepare(read, &agy, &env, "/p").unwrap().agy_gate);
        let island = |k: &str| match k {
            "USERPROFILE" => Some(home_str.clone()),
            "LUMO_ISLAND_RUN" => Some("1".to_string()),
            _ => None,
        };
        let ev = prepare(run("npm install").as_bytes(), &agy, &island, "/p").unwrap();
        assert!(ev.island_card && !ev.agy_gate);

        // Only a click allows; anything else hands it back to Antigravity.
        assert_eq!(reply::antigravity_gate(Some("allow")), r#"{"decision":"allow"}"#);
        assert!(reply::antigravity_gate(Some("deny")).starts_with(r#"{"decision":"deny","reason":"The user denied this in Lumo."#));
        assert_eq!(reply::antigravity_gate(None), r#"{"decision":"ask"}"#);
        assert_eq!(reply::antigravity_gate(Some("maybe")), r#"{"decision":"ask"}"#);
        let _ = std::fs::remove_dir_all(home);
    }
}
