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
//   turn's `result` came back, which ends agy cleanly; while subagents it
//   started still work, it stays open and agy goes on with them after the
//   answer (`linger`).
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
//   `invoke_subagent` starts subagents in the background: their work is read
//   in their own transcripts, and the subagents they start in turn from the
//   file agy keeps for each in its parent's folder (`children_of`).
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

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::chat::{self, Chat, ChatContext, ChatReply, ModelInfo, Stop};
use crate::chat_agents::{self, AgentRow, AgentState, AgentTalk, Agents, PlanStep, Tell};
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
/// Whose a tool step in `Run::pending` is: the chat's own answer's.
const MAIN: &str = "";
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
The user's email: Lumo's email tools from the lumo MCP server (mail_recent, mail_search, mail_read, mail_attachment, mail_folders) read their mailbox, every folder, read or unread mail alike, and the files attached. Use them for any question about email, and never say there is no email before looking. To send one (files attached by their full paths), answer one in its conversation or forward one, use mail_send, mail_reply or mail_forward when Lumo offers them: the user sees the email on a card and it goes only if they click Send; mail_draft saves one in their Drafts. Without them, write a draft for the user to send themselves. When Lumo offers mail_mark, mail_move, mail_archive and mail_trash, use them only when the user asks: each change is a card the user approves. \
Lumo may also list the windows and the documents open on the user's computer, with their paths: when a question is about one of them, such as the PDF they have open, read it from its path yourself instead of asking them to share it. \
Lumo shows the user your plan on its Plan island. So whenever the user gives you a job that takes more than one step (writing code, creating or changing files, running several commands), your very first tool call must be Lumo's update_plan tool (from the lumo MCP server), with every step of your plan: the first in_progress, the others pending. Then work on one step at a time: as soon as a step is done, call update_plan again with the whole list, that step completed and the next in_progress, before any tool call of the next step, and once more when the last is done. Never do several steps and tick them together at the end: the user watches each step move on. Do this even for small jobs, and do not write the plan in your answer: the Plan island shows it. When you start subagents (invoke_subagent), tell each one in its prompt to begin by calling Lumo's update_plan with its own steps and with agent set to its role (always: without agent, its plan would show as yours), and to call it again as each step is done: Lumo shows each subagent's plan on its own row. Ask the same of any subagent they start in turn. \
Subagents work in the background: once you started them, tell the user in a sentence what each one does and end your turn, without waiting for them. Lumo shows the user their progress, and the user can write to you meanwhile; their messages wake you, and then you tell the user what they found. ",
    crate::chat::timer_tool_note!(),
    crate::chat::listen_tool_note!(),
    crate::chat::math_note!(),
    crate::chat::rich_note!()
);

/// "default": no `--model`, whatever the user picked in agy itself.
const DEFAULT_MODEL: &str = "default";

/// The detail of the step that leaves plan mode (`exit_plan_mode`), where
/// Orchestrator's planner hands the plan to its executor.
const PLAN_EXIT: &str = "exit";

fn not_installed() -> String {
    tf(
        "Antigravity CLI isn't installed. Install it with {command}, sign in once with `agy` in a terminal, then try again.",
        &[("command", INSTALL)],
    )
}

fn not_signed_in() -> String {
    t("Antigravity CLI isn't signed in. Run `agy` once in a terminal to sign in with your Google account, then try again.")
}

fn permission_needed() -> String {
    t("Antigravity CLI needed a permission that wasn't given. Install Lumo's Antigravity hooks to approve commands from the island.")
}

/// A chat turn's error as the island shows it: not installed or not signed
/// in comes with the card that puts it right (chat::FIX_MARK).
fn chat_error(error: String) -> String {
    if error == not_signed_in() {
        chat::with_fix(error, chat::FIX_AGY_SIGN_IN)
    } else if error == not_installed() {
        chat::with_fix(error, chat::FIX_AGY_INSTALL)
    } else if error == permission_needed() && !crate::agents::antigravity_cards_ready() {
        chat::with_fix(error, chat::FIX_AGY_HOOKS)
    } else {
        error
    }
}

/// agy skipped a command it needed the user's OK for (soft-denied, said in
/// its steps or on stderr) and Lumo's hooks aren't there to ask for it: the
/// island offers to set them up (chat::FIX_AGY_HOOKS).
fn needs_hooks(denied: usize, stderr_tail: &str, cards_ready: bool) -> bool {
    let refused = denied > 0 || (stderr_tail.contains("permission") && stderr_tail.contains("denied"));
    refused && !cards_ready
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
    if !inbox.is_empty() {
        a.push("--add-dir".into());
        a.push(inbox.to_string());
    }
    for dir in folders.iter().filter_map(|d| safe_dir(d)) {
        a.push("--add-dir".into());
        a.push(dir.to_string());
    }
    if let Some((planner, executor)) = orchestration(model) {
        let labels = LABELS.lock().unwrap_or_else(|e| e.into_inner()).clone().unwrap_or_default();
        let (row, settings) = orchestrator_run(planner, executor, &labels);
        a.push("--model".into());
        a.push(row);
        if let Some(settings) = settings {
            a.push("--settings".into());
            a.push(settings);
        }
    } else if let Some(m) = safe_model(model) {
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
    // Lumo's browser, called through call_mcp_tool or by its own name: the
    // site it opens, as for Claude Code (browser.rs activity).
    if let Some((_, input)) = browser_call(name, params) {
        return crate::browser::activity(&input);
    }
    // Any other MCP tool called through call_mcp_tool: that tool, by its name.
    if let Some((_, tool, _)) = mcp_call(name, params) {
        return match pretty_tool(&tool) {
            p if p.is_empty() => Activity::new("tool", ""),
            p => Activity::new("tool", p),
        };
    }
    if n == "send_message" {
        return match field(&["Recipient", "recipient", "to"]).as_str() {
            // A conversation's id (a subagent reporting to its parent): no name for the user.
            "" | "main" | "coordinator" => Activity::new("talk", ""),
            to if safe_session(to).is_some() => Activity::new("talk", ""),
            to => Activity::new("talk", short(to)),
        };
    }
    if n == "post_message" {
        let text = field(&["text", "message", "Message"]);
        let target = text
            .split_whitespace()
            .find(|w| w.starts_with('@') && w.len() > 1)
            .map(|w| w.trim_start_matches('@').trim_end_matches(|c: char| !c.is_alphanumeric() && c != '-' && c != '_'))
            .filter(|w| !w.is_empty())
            .unwrap_or("");
        return Activity::new("talk", short(target));
    }
    if has(&["screenshot"]) {
        return Activity::new("screen", "");
    }
    if has(&["subagent", "delegate", "workflow", "swarm"]) {
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
        // How an MCP tool is called (agy's mcp\<server>\<tool>.json), read
        // before calling it: getting ready, not a file of the chat's.
        if mcp_schema(&field(&["AbsolutePath", "FilePath", "TargetFile", "File", "Path", "file_path", "path"])) {
            return Activity::thinking();
        }
        let file = path();
        return if is_screenshot(&file) { Activity::new("screen", "") } else { Activity::new("read", file) };
    }
    if name == "exit_plan_mode" {
        // Orchestrator's planner hands over to its executor here (Phases).
        return Activity::new("plan", PLAN_EXIT);
    }
    if has(&["plan", "todo"]) {
        return Activity::new("plan", "");
    }
    match pretty_tool(name) {
        p if p.is_empty() => Activity::thinking(),
        p => Activity::new("tool", p),
    }
}

/// An MCP tool call agy makes through its own `call_mcp_tool` (`params`:
/// ServerName, ToolName and Arguments, an object or its JSON text, as
/// hook/src/mcp.rs lumo_call reads them): the server, the tool, and its
/// arguments. None for any other tool.
fn mcp_call(name: &str, params: &Value) -> Option<(String, String, Value)> {
    let n = name.to_ascii_lowercase();
    if !(n.contains("mcp") && n.contains("call")) {
        return None;
    }
    let params = params_of(params);
    let text = |keys: &[&str]| keys.iter().filter_map(|k| params.get(*k).and_then(Value::as_str)).map(str::trim).find(|s| !s.is_empty()).map(str::to_string);
    let tool = text(&["ToolName", "toolName", "tool_name", "tool", "Name", "name"])?;
    let server = text(&["ServerName", "serverName", "server_name", "Server", "server"]).unwrap_or_default();
    let args = ["Arguments", "arguments", "Args", "args", "Input", "input"].iter().find_map(|k| params.get(*k)).map(params_of).filter(Value::is_object);
    Some((server, tool, args.unwrap_or_else(|| json!({}))))
}

/// A call of Lumo's browser (browser.rs): through `call_mcp_tool`, or by
/// its own name ("mcp_lumo_browser_open"). The tool and its input.
fn browser_call(name: &str, params: &Value) -> Option<(&'static str, Value)> {
    if let Some(tool) = crate::browser::tool_of("", name) {
        return Some((tool, params_of(params)));
    }
    let (server, tool, args) = mcp_call(name, params)?;
    crate::browser::tool_of(&server, &tool).map(|tool| (tool, args))
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

/// The description agy keeps of an MCP server's tool, which a model reads
/// before calling it (`.gemini\antigravity-cli\mcp\lumo\browser_open.json`).
fn mcp_schema(path: &str) -> bool {
    let p = path.replace('\\', "/").to_ascii_lowercase();
    agy_own(path) && p.contains("/mcp/") && p.ends_with(".json")
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

/// The fields of a `result` that go to the log: never its answer (the user's
/// work, maybe long), only its length. Only these, so a field agy adds one
/// day (its steps, an output) stays out of the log.
const LOGGED_FIELDS: [&str; 4] = ["status", "error", "usage", "conversation_id"];

/// A `result` event as agy wrote it, for the log: the fields above, and its
/// answer only as its length, wherever agy put it.
fn logged_result(frame: &Value) -> String {
    let v = match frame.get("event").and_then(Value::as_str).and_then(|e| frame.get(e)) {
        Some(inner) if inner.is_object() => inner,
        _ => frame,
    };
    let mut out = serde_json::Map::new();
    for key in LOGGED_FIELDS {
        if let Some(x) = v.get(key) {
            out.insert(key.to_string(), x.clone());
        }
    }
    if let Some(text) = v.get("response").and_then(Value::as_str) {
        out.insert("response".to_string(), json!(format!("<{} characters>", text.chars().count())));
    }
    Value::Object(out).to_string()
}

/// agy's words when the model sent a tool call it could not read (Gemini's
/// MALFORMED_FUNCTION_CALL): agy has the model try again, but may still end
/// the turn with them.
fn is_malformed_call(error: &str) -> bool {
    let l = error.to_ascii_lowercase();
    l.contains("malformed function call") || l.contains("improperly formatted function call")
}

/// At most this many characters of agy's error are shown (a stack trace would
/// fill the island).
const ERROR_WORDS_MAX: usize = 600;

/// The part of agy's error worth showing: for a malformed call, its line
/// that says so, without what agy tells the model ("Please retry…"); at most
/// ERROR_WORDS_MAX characters.
fn error_words(error: &str) -> String {
    let error = error.trim();
    // ASCII lowercase keeps every byte where it was, so the place found is
    // a place in `error` too (to_lowercase can change a character's length).
    let at = error.to_ascii_lowercase().find("malformed function call");
    let words = match at {
        Some(at) => error[at..].lines().next().unwrap_or("").trim(),
        None => error,
    };
    if words.chars().count() <= ERROR_WORDS_MAX {
        return words.to_string();
    }
    let cut: String = words.chars().take(ERROR_WORDS_MAX).collect();
    format!("{}…", cut.trim_end())
}

/// What agy said, after what Lumo says about it (chat::ERROR_DETAIL).
fn with_agy_words(said: String, error: &str) -> String {
    format!("{said}\n{}{}", crate::chat::ERROR_DETAIL, tf("Antigravity CLI's message: {error}", &[("error", &error_words(error))]))
}

/// The answer to keep when agy ended the turn with `error`: the one its
/// result still carried, or, for a malformed tool call only, what was
/// streamed. Any other error with only streamed text (a quota, the network)
/// is said as an error, as that text may be a step's words ("Now I read…"),
/// not an answer.
fn kept_answer(error: &str, response: &str, streamed: &str) -> Option<String> {
    if is_auth_error(error) {
        return None;
    }
    if !response.trim().is_empty() {
        return Some(response.to_string());
    }
    let streamed = streamed.trim();
    (is_malformed_call(error) && !streamed.is_empty()).then(|| streamed.to_string())
}

/// The answer came, but agy ended the turn with `error`: said under it. The
/// island writes the words in its language (src/views/chat.ts warningWords),
/// so a chat opened later in another language reads in that one.
fn answer_warning(error: &str) -> crate::chat::ChatWarning {
    crate::chat::ChatWarning {
        kind: if is_malformed_call(error) { "malformed" } else { "error" }.to_string(),
        message: error_words(error),
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
    ["TaskName", "TaskSummary", "Task", "Prompt", "Description", "title", "brief", "task", "prompt", "description"]
        .iter()
        .filter_map(|k| params.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            params
                .get("Script")
                .and_then(Value::as_str)
                .map(extract_workflow_roles)
                .filter(|r| !r.is_empty())
                .map(|r| r.join(", "))
        })
        .unwrap_or_else(|| pretty_tool(name))
}

/// Extracts static `role="..."` / `role='...'` names from a `run_workflow` Python script.
fn extract_workflow_roles(script: &str) -> Vec<String> {
    let mut roles = Vec::new();
    let mut rest = script;
    while let Some(pos) = rest.find("role") {
        rest = &rest[pos + 4..];
        let trimmed = rest.trim_start();
        let Some(after_eq) = trimmed.strip_prefix('=') else { continue };
        let after_eq = after_eq.trim_start();
        let quote = match after_eq.chars().next() {
            Some(q @ ('"' | '\'')) => q,
            _ => continue,
        };
        let inside = &after_eq[1..];
        let Some(end) = inside.find(quote) else { break };
        let role = inside[..end].trim();
        if !role.is_empty() && !role.contains('{') && !role.contains('}') && !roles.iter().any(|r| r == role) {
            roles.push(role.to_string());
        }
        rest = &inside[end + 1..];
    }
    roles
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
    /// `send_message` / `post_message` calls still running: step index → (row id, previous final state if reopened).
    talks: HashMap<u64, (String, Option<AgentState>)>,
    /// Files the subagents wrote, not passed on yet.
    files: Vec<FileTouch>,
    /// agy's folder of conversations (`…/brain`), where the subagents a
    /// subagent starts have their transcripts (`find_children`).
    brain: Option<PathBuf>,
    /// When the first subagent started: a conversation older than that is
    /// none of this turn's.
    since: Option<SystemTime>,
    /// The conversations of `brain` already looked at (or too old to be ours).
    looked: HashSet<String>,
    /// The first lines of the conversations of `brain` read but not yet
    /// claimed by a subagent (an older agy, `scan_brain`): one may be the
    /// child of a subagent whose call to start it is read only later.
    firsts: HashMap<String, Value>,
    /// agy keeps its subagents in their parent's folder (`children_of`):
    /// `brain` is not looked through.
    child_files: bool,
    /// The main conversation (the chat's), as agy's stream names it.
    main: Option<String>,
    /// Its transcript (`main_log`): how far it was read, a line not yet
    /// whole, whether it was found, and the plans its own update_plan calls
    /// gave, the only ones the chat's Plan shows while subagents work
    /// (`release_plans`: lumo-hook can't say whose a plan is).
    main_read: u64,
    main_partial: Vec<u8>,
    main_found: bool,
    main_plans: Vec<Vec<PlanStep>>,
    /// Every plan a subagent gave, each version: never the chat's.
    their_plans: Vec<Vec<PlanStep>>,
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
    /// Its conversation's id (`conversation_id`, from `log_uri`, or its folder
    /// in agy's `brain`): the sender its own subagents name in their first line.
    conversation: Option<String>,
    /// Its roster name (swarm worker or named subagent), when known.
    name: Option<String>,
    /// Its transcript, once the step is done and names it.
    log: Option<PathBuf>,
    /// How far the transcript was read, and a line not yet whole.
    read: u64,
    partial: Vec<u8>,
    /// Its report, the files and subagents its calls are waiting on.
    reading: Reading,
    /// Inside a line past MAX_LINE: dropped up to its end.
    skipping: bool,
    /// The conversation that started it, from the first line of its
    /// transcript: its messages there are its report.
    sender: Option<String>,
    /// The first line of its transcript was read.
    began: bool,
    /// The row of the subagent that started it, when one did.
    parent: Option<String>,
    /// The subagents its own calls started: the role each call gave ("" for
    /// none) and its task, in order, and whether a subagent found took it.
    roles: Vec<(String, String)>,
    claimed: Vec<bool>,
    /// How many of them were found.
    children: usize,
    /// It answered (no more calls) at least once.
    answered: bool,
    /// It answered while subagents of its own still work, at this time: it
    /// waits for them (agy wakes it with their messages), it is not done.
    waiting_since: Option<Instant>,
    /// The user asked agy to stop it, at this time: it is stopping until agy
    /// says it stopped, or STOP_WAIT passed.
    stop_asked: Option<Instant>,
    /// Its folder of children was listed once (`find_children`).
    listed: bool,
    /// agy's error stopped it, at this time, with these words: failed unless
    /// it goes on within FAIL_GRACE.
    failing: Option<(Instant, String)>,
    /// The lines of its transcript read so far, and at which of them a
    /// message of its own subagents last reached it, and it last reported
    /// (or answered): one that heard from them after its last report still
    /// owes its parent theirs (`settle`).
    lines: u64,
    heard_at: u64,
    reported_at: u64,
    /// The conversations of its own subagents whose messages reached it.
    heard_from: HashSet<String>,
    /// When its subagents were all seen done while it still owed its report.
    owing_since: Option<Instant>,
}

impl Spawn {
    fn new(step: u64, n: usize, row: String, conversation: Option<String>, name: Option<String>, log: Option<PathBuf>) -> Spawn {
        let conversation = conversation.or_else(|| log.as_deref().and_then(conversation_of));
        Spawn {
            step,
            n,
            row,
            conversation,
            name,
            log,
            read: 0,
            partial: Vec::new(),
            reading: Reading::default(),
            skipping: false,
            sender: None,
            began: false,
            parent: None,
            roles: Vec::new(),
            claimed: Vec::new(),
            children: 0,
            answered: false,
            waiting_since: None,
            stop_asked: None,
            listed: false,
            failing: None,
            lines: 0,
            heard_at: 0,
            reported_at: 0,
            heard_from: HashSet::new(),
            owing_since: None,
        }
    }

    /// A subagent it started was found: the role its call gave it, by its
    /// task when the task is known, else the next one not taken. None when
    /// the call named no role (or no call is known).
    fn claim(&mut self, prompt: Option<&str>, role: Option<&str>) -> Option<String> {
        self.children += 1;
        let free = |i: &usize| !self.claimed[*i];
        let n = self.roles.len();
        let by = |f: &dyn Fn(&(String, String)) -> bool| (0..n).filter(free).find(|i| f(&self.roles[*i]));
        let pick = role
            .and_then(|r| by(&|(have, _)| have.eq_ignore_ascii_case(r)))
            .or_else(|| prompt.map(str::trim).filter(|p| !p.is_empty()).and_then(|p| by(&|(_, task)| task.trim() == p)))
            .or_else(|| (0..n).find(free));
        let i = pick?;
        self.claimed[i] = true;
        Some(self.roles[i].0.clone()).filter(|r| !r.is_empty())
    }

    /// Its calls started these subagents.
    fn invoked(&mut self, started: Vec<(String, String)>) {
        self.claimed.extend(started.iter().map(|_| false));
        self.roles.extend(started);
    }

    /// The last `n` it started never did (their call failed).
    fn cancelled(&mut self, mut n: usize) {
        let mut i = self.roles.len();
        while n > 0 && i > 0 {
            i -= 1;
            if !self.claimed[i] {
                self.roles.remove(i);
                self.claimed.remove(i);
                n -= 1;
            }
        }
    }
}

/// How long a subagent that started subagents of its own and then answered
/// is waited for, when they don't all show (agy may name them in another
/// way): then it is done, as before.
const CHILD_GRACE: Duration = Duration::from_secs(30);
/// How long a subagent whose own subagents are done is waited for to pass
/// their results on to its parent: then it is done, report or not.
const REPORT_WAIT: Duration = Duration::from_secs(120);
/// The most conversations of agy's `brain` not seen before looked at in one go.
const MAX_SCAN: usize = 4000;
/// The most first lines kept while no subagent claims them.
const MAX_FIRSTS: usize = 512;
/// How long a subagent the user stopped says it is stopping, until agy says
/// it stopped: past that, agy did not (the row is at work again).
const STOP_WAIT: Duration = Duration::from_secs(20);
/// How long a subagent whose transcript says agy's error stopped it is given
/// to go on: agy 1.5.13 never does (it stays "alive", its parent waits).
const FAIL_GRACE: Duration = Duration::from_secs(20);

/// The conversation a transcript is the log of, and agy's folder of them:
/// `…/brain/<conversation>/…/transcript.jsonl`.
fn brain_of(log: &std::path::Path) -> Option<(PathBuf, String)> {
    let parts: Vec<_> = log.components().collect();
    let at = parts.iter().position(|c| c.as_os_str().eq_ignore_ascii_case("brain"))?;
    let conversation = parts.get(at + 1)?.as_os_str().to_str()?.to_string();
    // The conversation's folder, then at least the transcript: never the brain itself.
    if parts.len() < at + 3 || conversation.is_empty() || conversation == ".." {
        return None;
    }
    let brain: PathBuf = parts[..=at].iter().collect();
    Some((brain, conversation))
}

fn conversation_of(log: &std::path::Path) -> Option<String> {
    brain_of(log).map(|(_, c)| c)
}

/// The first line of a transcript, once it is whole.
fn first_line(path: &std::path::Path) -> Option<Value> {
    let file = std::fs::File::open(path).ok()?;
    let mut head = Vec::new();
    file.take(64 * 1024).read_to_end(&mut head).ok()?;
    let end = head.iter().position(|b| *b == b'\n')?;
    serde_json::from_slice(&head[..end]).ok()
}

/// The message a subagent's transcript begins with: agy's own words around
/// it ("The following is a <SYSTEM_MESSAGE> not actually sent by the user…"),
/// then "[Message] timestamp=… sender=<parent> priority=… content=<task>".
fn first_message(first: &Value) -> Option<&str> {
    let content = first["content"].as_str()?;
    let at = content.find("[Message]")?;
    Some(&content[at + "[Message]".len()..])
}

/// Who started the subagent whose transcript begins with `first`: the
/// conversation its first message came from.
fn sender_of(first: &Value) -> Option<&str> {
    let message = first_message(first)?;
    let head = message.split_once(" content=").map_or(message, |(h, _)| h);
    let at = head.find("sender=")?;
    head[at + "sender=".len()..].split_whitespace().next().filter(|s| !s.is_empty())
}

/// The task a subagent was given, from the message that started it.
fn first_prompt(first: &Value) -> Option<&str> {
    let (_, prompt) = first_message(first)?.split_once(" content=")?;
    let prompt = prompt.split("</SYSTEM_MESSAGE>").next().unwrap_or(prompt).trim();
    (!prompt.is_empty()).then_some(prompt)
}

/// A title for a subagent from the message that started it, when no role names it.
fn prompt_title(first: &Value) -> Option<String> {
    first_prompt(first).map(|p| short(&chat_agents::summary_of(p)))
}

/// Whether a tool is agy's `invoke_subagent` (whatever agy puts in front).
/// Not `define_subagent`, `manage_subagents`, nor Lumo's `browser_subagent`.
fn is_invoke(name: &str) -> bool {
    let n = name.trim().to_ascii_lowercase();
    n == "invoke_subagent" || n.ends_with("_invoke_subagent") || n.ends_with("/invoke_subagent")
}

/// One subagent as agy keeps it in its parent's folder,
/// `brain/<parent>/.system_generated/subagents/<child>.json`: one file per
/// child (swarm workers too), written as it starts, its state changed as it ends.
#[derive(Clone, Debug, PartialEq)]
struct ChildFile {
    conversation: String,
    /// The role its call gave it, else its type ("code reviewer").
    role: Option<String>,
    /// Ended by agy: stopped by its parent (or the user), or closed after it
    /// finished. "SUBAGENT_STATE_KILLED".
    killed: bool,
    /// The step of its parent's conversation that started it: their order.
    step: u64,
}

/// A conversation id of agy's as a folder name: letters, digits, `-`, `_`
/// and dots, never `.` or `..`.
fn safe_id(id: &str) -> Option<&str> {
    let ok = !id.is_empty() && id.len() <= 128 && id != "." && id != ".." && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    ok.then_some(id)
}

/// A role or a type, as a title: "code_reviewer" reads "code reviewer".
fn role_title(s: &str) -> String {
    if s.contains('_') && !s.contains(' ') {
        pretty_tool(s)
    } else {
        s.to_string()
    }
}

fn child_file(v: &Value) -> Option<ChildFile> {
    let conversation = ["conversationId", "conversation_id"].iter().filter_map(|k| v[*k].as_str()).map(str::trim).find(|s| !s.is_empty())?;
    let conversation = safe_id(conversation)?.to_string();
    let d = &v["subagentDescriptor"];
    let text = |keys: &[&str]| keys.iter().filter_map(|k| d[*k].as_str()).map(str::trim).find(|s| !s.is_empty() && *s != "self").map(role_title);
    let role = text(&["role", "Role"]).or_else(|| text(&["typeName", "type_name"]));
    let state = v["state"].as_str().unwrap_or("").to_ascii_uppercase();
    let step = v["spawnStepIndex"].as_u64().or_else(|| v["spawnStepIndex"].as_str().and_then(|s| s.trim().parse().ok())).unwrap_or(u64::MAX);
    Some(ChildFile { conversation, role, killed: state.contains("KILLED"), step })
}

/// The most child files read for one parent.
const MAX_CHILD_FILES: usize = 256;

/// The subagents agy keeps for conversation `parent` in `brain`, in the
/// order they started; None when it keeps none there (an older agy, or none
/// started yet).
fn children_of(brain: &Path, parent: &str) -> Option<Vec<ChildFile>> {
    let parent = safe_id(parent)?;
    let dir = brain.join(parent).join(".system_generated").join("subagents");
    let entries = std::fs::read_dir(dir).ok()?;
    let mut out: Vec<ChildFile> = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("json")))
        .take(MAX_CHILD_FILES)
        .filter_map(|e| {
            let file = std::fs::File::open(e.path()).ok()?;
            let mut text = Vec::new();
            file.take(64 * 1024).read_to_end(&mut text).ok()?;
            child_file(&serde_json::from_slice(&text).ok()?)
        })
        .collect();
    out.sort_by(|a, b| a.step.cmp(&b.step).then_with(|| a.conversation.cmp(&b.conversation)));
    Some(out)
}

/// The subagents an `invoke_subagent` call starts, one per subagent: the role
/// it gives each ("" when it names none) and its task; nothing for any other
/// call (`define_subagent`, `manage_subagents`, Lumo's browser agent…).
fn invoked(name: &str, args: &Value) -> Vec<(String, String)> {
    if !is_invoke(name) {
        return Vec::new();
    }
    let pick = |v: &Value, keys: &[&str]| keys.iter().filter_map(|k| v[*k].as_str()).map(str::trim).find(|s| !s.is_empty()).map(str::to_string);
    let one = |v: &Value| {
        let role = pick(v, &["role", "Role", "name", "Name"]).or_else(|| pick(v, &["type_name", "TypeName", "typeName"]).filter(|t| t != "self"));
        (role.map(|r| role_title(&r)).unwrap_or_default(), pick(v, &["initial_prompt", "Prompt", "prompt", "InitialPrompt", "task", "Task"]).unwrap_or_default())
    };
    let listed: Vec<(String, String)> = args
        .as_object()
        .into_iter()
        .flat_map(|m| m.values())
        .filter_map(Value::as_array)
        .flat_map(|list| list.iter().filter(|e| e.is_object()).map(one))
        .collect();
    if !listed.is_empty() {
        return listed;
    }
    vec![one(args)]
}

/// The roles alone (`invoked`).
#[cfg(test)]
fn invoked_roles(name: &str, args: &Value) -> Vec<String> {
    invoked(name, args).into_iter().map(|(r, _)| r).collect()
}

/// The conversations a `manage_subagents` call stops: Some(empty) for all of them.
fn kills_of(name: &str, args: &Value) -> Option<Vec<String>> {
    let n = name.trim().to_ascii_lowercase();
    if !(n == "manage_subagents" || n.ends_with("_manage_subagents") || n.ends_with("/manage_subagents")) {
        return None;
    }
    let action = args["Action"].as_str().or_else(|| args["action"].as_str()).unwrap_or("").trim().to_ascii_lowercase();
    match action.as_str() {
        "kill_all" => Some(Vec::new()),
        "kill" => {
            // A list, or its JSON text.
            let list = match args.get("ConversationIds").or_else(|| args.get("conversationIds"))? {
                Value::String(text) => serde_json::from_str::<Value>(text).ok()?,
                other => other.clone(),
            };
            let ids: Vec<String> = list.as_array()?.iter().filter_map(Value::as_str).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
            (!ids.is_empty()).then_some(ids)
        }
        _ => None,
    }
}

/// The plan a subagent gives Lumo's update_plan, by the tool's own name or
/// through `call_mcp_tool`.
fn plan_call_of(name: &str, args: &Value) -> Option<Vec<PlanStep>> {
    if is_plan_tool(name) {
        return chat_agents::plan_of(args);
    }
    let (server, tool, args) = mcp_call(name, args)?;
    let lumo = server.is_empty() || server.to_ascii_lowercase().contains("lumo");
    (lumo && tool.to_ascii_lowercase().ends_with("update_plan")).then(|| chat_agents::plan_of(&args)).flatten()
}

/// What one line of a subagent's transcript said, past its row.
#[derive(Default, Debug, PartialEq)]
struct Heard {
    /// Its answer: no more calls.
    answered: bool,
    /// It called tools.
    called: bool,
    /// The subagents its calls started: role and task (`invoked`).
    invoked: Vec<(String, String)>,
    /// How many of the last ones it started never did: the call failed.
    cancelled: usize,
    /// The subagents it stopped (`manage_subagents`), by conversation, once
    /// the call went through; Some(empty) for all of its own.
    killed: Option<Vec<String>>,
    /// agy's error that stopped it (an `ERROR_MESSAGE` of its transcript:
    /// the model unavailable…). agy neither tries again nor tells its parent.
    error: Option<String>,
    /// A message reached it from a conversation other than its parent's (one
    /// of its own subagents reporting): this one.
    message_from: Option<String>,
    /// It sent its parent a message (`send_message`): a report.
    reported: bool,
}

/// What reading a subagent's transcript keeps from line to line.
#[derive(Default, Debug)]
struct Reading {
    /// What it sent its parent (`send_message`): its report.
    report: Option<String>,
    /// Files its last calls write, told once their result says they did.
    pending: Vec<FileTouch>,
    /// How many subagents its last calls started, until their result says they did.
    unconfirmed: usize,
    /// The subagents its last calls stop, until their result says they did.
    kills: Option<Vec<String>>,
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

/// The subagent's conversation id carried by its `log_uri` (`.../brain/<cid>/.../transcript.jsonl`).
fn conversation_from_log_uri(uri: &str) -> Option<String> {
    let path = transcript_path(uri)?;
    let normalized = path.to_string_lossy().replace('\\', "/");
    let (_, rest) = normalized.split_once("/brain/")?;
    let cid = rest.split('/').next()?.trim();
    (!cid.is_empty() && cid != "." && cid != "..").then(|| cid.to_string())
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

/// Whether a call's result says it failed: it begins so ("Error: file
/// already exists", "Failed to write…", "Permission denied"), or says it was
/// refused. Not a word in a name it gives back ("Created file errors.log").
fn call_failed(content: &str) -> bool {
    let text = content.trim_start().to_ascii_lowercase();
    ["error", "failed", "failure", "denied", "permission denied", "access is denied", "not allowed", "refused"].iter().any(|w| text.starts_with(w))
        || [" was denied", " is not allowed", " not permitted", "access is denied", "permission denied"].iter().any(|w| text.contains(w))
}

/// The calls of Lumo's browser in one line of a subagent's transcript.
fn transcript_browsing(line: &Value) -> Vec<(&'static str, Value)> {
    let calls = line["tool_calls"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    calls.iter().filter_map(|call| browser_call(call["name"].as_str().unwrap_or(""), &transcript_args(&call["args"]))).collect()
}

/// One line of a subagent's transcript on its row: its steps, what it does
/// now, its tokens, its report, and the files it wrote (`pending` until the
/// call's result says it went through). `to_parent`: whether a conversation
/// is the one that started it, whose messages are its report (a message to
/// a subagent of its own is an order, not its report).
fn transcript_line(row: &mut AgentRow, reading: &mut Reading, files: &mut Vec<FileTouch>, line: &Value, to_parent: &dyn Fn(&str) -> bool) -> Heard {
    let mut heard = Heard::default();
    // A message to it: from one of its own subagents, unless its parent sent it.
    if line["type"] == "SYSTEM_MESSAGE" {
        heard.message_from = sender_of(line).filter(|s| !to_parent(s)).map(str::to_string);
        return heard;
    }
    if line["type"] == "ERROR_MESSAGE" {
        heard.error = Some(error_text(&line["error"]).or_else(|| line["content"].as_str().map(str::to_string)).unwrap_or_default());
        return heard;
    }
    let read = |k: &str| line[k].as_u64().unwrap_or(0);
    let context = read("input_tokens") + read("cache_read_tokens");
    if context > 0 {
        row.tokens = Some(row.tokens.unwrap_or(0).max(context));
    }
    // A call's result: the files it wrote and the subagents it started or
    // stopped, unless it failed.
    if line["type"] == "GENERIC" && (!reading.pending.is_empty() || reading.unconfirmed > 0 || reading.kills.is_some()) {
        let failed = line["status"].as_str().is_some_and(|s| s != "DONE") || call_failed(line["content"].as_str().unwrap_or(""));
        for touch in reading.pending.drain(..) {
            if !failed && !files.contains(&touch) {
                files.push(touch);
            }
        }
        if failed {
            heard.cancelled = std::mem::take(&mut reading.unconfirmed);
            reading.kills = None;
        } else {
            reading.unconfirmed = 0;
            heard.killed = reading.kills.take();
        }
    }
    let calls = line["tool_calls"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    for call in calls {
        let name = call["name"].as_str().unwrap_or("");
        let args = transcript_args(&call["args"]);
        row.steps += 1;
        row.now = Some(activity_for(name, &args));
        heard.called = true;
        // Its own plan (concepts/piano-dei-sotto-agenti), and the subagents it starts or stops.
        if let Some(plan) = plan_call_of(name, &args) {
            row.plan = Some(plan);
        }
        let started = invoked(name, &args);
        reading.unconfirmed += started.len();
        heard.invoked.extend(started);
        if let Some(ids) = kills_of(name, &args) {
            match (&mut reading.kills, ids.is_empty()) {
                (_, true) => reading.kills = Some(Vec::new()),
                (Some(all), _) if all.is_empty() => {}
                (Some(list), _) => list.extend(ids),
                (None, _) => reading.kills = Some(ids),
            }
        }
        if name == "send_message" {
            let to = ["Recipient", "recipient", "to"].iter().filter_map(|k| args[*k].as_str()).map(str::trim).find(|s| !s.is_empty()).unwrap_or("");
            if let Some(text) = args["Message"].as_str().or_else(|| args["message"].as_str()).map(str::trim).filter(|t| !t.is_empty() && to_parent(to)) {
                heard.reported = true;
                reading.report = Some(text.to_string());
                row.summary = Some(crate::chat_agents::summary_of(text));
                if let Some(talk) = row.talk.as_mut().filter(|t| t.pending()) {
                    talk.answer(text);
                }
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
            reading.pending.extend(touch);
        }
    }
    // Its calls cut from the line (a long one): a step all the same, never its answer.
    let cut = line["truncated_fields"].as_array().is_some_and(|f| f.iter().any(|x| x == "tool_calls"));
    if cut && calls.is_empty() {
        row.steps += 1;
        row.now = Some(Activity::new("tool", ""));
        heard.called = true;
        return heard;
    }
    let answer = line["content"].as_str().map(str::trim).filter(|t| !t.is_empty());
    match answer {
        Some(answer) if calls.is_empty() && line["type"] == "PLANNER_RESPONSE" && line["source"] == "MODEL" => {
            let reply_text = reading.report.as_deref().unwrap_or(answer);
            row.summary = Some(crate::chat_agents::summary_of(reply_text));
            if let Some(talk) = row.talk.as_mut().filter(|t| t.pending()) {
                talk.answer(reply_text);
            }
            heard.answered = true;
            heard
        }
        _ => {
            if calls.is_empty() && line["source"] == "MODEL" && line["type"] == "PLANNER_RESPONSE" {
                row.now = Some(Activity::thinking());
            }
            heard
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
            let conv = text(&["conversation_id", "conversationId"])
                .or_else(|| text(&["log_uri", "logUri"]).and_then(|u| conversation_from_log_uri(&u)));
            let name = text(&["name", "role"]);
            if let Some(spawn) = self.spawns.iter_mut().find(|s| s.step == index && s.n == n) {
                if spawn.log.is_none() {
                    if spawn.conversation.is_none() {
                        spawn.conversation = log.as_deref().and_then(conversation_of);
                    }
                    spawn.log = log;
                }
                if spawn.conversation.is_none() {
                    spawn.conversation = conv;
                }
                if spawn.name.is_none() {
                    spawn.name = name;
                }
                if self.brain.is_none() {
                    self.brain = spawn.log.as_deref().and_then(brain_of).map(|(b, _)| b);
                }
                continue;
            }
            let row = format!("agy-{}-{index}-{}", self.mark(), n + 1);
            let title = text(&["role", "name", "type_name"]).map(|s| if s.contains('_') { pretty_tool(&s) } else { s }).unwrap_or_else(|| t("Agent"));
            let made = self.agents.upsert(&row, || AgentRow::new(row.as_str(), PROVIDER, &title));
            made.now = Some(Activity::thinking());
            made.can_ask = true;
            made.can_stop = true;
            self.since.get_or_insert_with(|| SystemTime::now() - Duration::from_secs(5));
            if self.brain.is_none() {
                self.brain = log.as_deref().and_then(brain_of).map(|(b, _)| b);
            }
            self.spawns.push(Spawn::new(index, n, row, conv, name, log));
        }
    }

    /// Finds a subagent's row id by row id, conversation id, roster name, or title.
    fn resolve(&self, to: &str) -> Option<String> {
        let to = to.trim().trim_start_matches('@');
        if to.is_empty() || to == "main" || to == "coordinator" || to == "all" {
            return None;
        }
        if self.agents.get(to).is_some() {
            return Some(to.to_string());
        }
        if let Some(spawn) = self.spawns.iter().rev().find(|s| s.conversation.as_deref() == Some(to)) {
            return Some(spawn.row.clone());
        }
        if let Some(spawn) = self.spawns.iter().rev().find(|s| s.name.as_deref().is_some_and(|n| n.eq_ignore_ascii_case(to))) {
            return Some(spawn.row.clone());
        }
        self.agents
            .ids()
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .find(|id| self.agents.get(id).is_some_and(|r| r.title.eq_ignore_ascii_case(to)))
    }

    /// The main agent sent a message to a subagent (`send_message` / `post_message`).
    fn talk_sent(&mut self, index: u64, to: &str, message: &str) {
        if self.talks.contains_key(&index) {
            return;
        }
        let Some(id) = self.resolve(to) else { return };
        let call = format!("step-{index}");
        let was_final = self.agents.get(&id).map(|r| r.state).filter(|s| s.is_final());
        let Some(row) = self.agents.touch(&id) else { return };
        if row.talk.as_ref().is_some_and(|t| t.call == call) {
            return;
        }
        row.talk = Some(AgentTalk::new(&call, message));
        if row.state.is_final() {
            row.reopen();
            row.can_stop = true;
            row.can_ask = true;
        }
        if let Some(spawn) = self.spawns.iter_mut().find(|s| s.row == id) {
            spawn.reading.report = None;
            spawn.answered = false;
        }
        self.talks.insert(index, (id, was_final));
    }

    /// The main agent's `send_message` / `post_message` step ended.
    fn talk_done(&mut self, index: u64, failed: Option<Option<String>>) {
        let Some((id, was_final)) = self.talks.remove(&index) else { return };
        let Some(err) = failed else { return };
        let why = err.unwrap_or_default();
        let Some(row) = self.agents.touch(&id) else { return };
        let call = format!("step-{index}");
        if let Some(talk) = row.talk.as_mut().filter(|t| t.call == call && t.pending()) {
            talk.failed = Some(why);
        }
        if let Some(prev) = was_final {
            row.end(prev, None);
            row.can_stop = false;
        }
    }

    /// A `system_message` step in the main stream carrying a subagent's reply.
    fn system_reply(&mut self, v: &Value) {
        let Some((sender, content)) = system_message_reply(v) else { return };
        let Some(id) = self.resolve(&sender) else { return };
        if !self.agents.get(&id).is_some_and(|r| r.talk.as_ref().is_some_and(AgentTalk::pending)) {
            return;
        }
        if let Some(row) = self.agents.touch(&id) {
            if let Some(talk) = row.talk.as_mut().filter(|t| t.pending()) {
                talk.answer(&content);
            }
        }
    }

    /// Handles `swarm` tool calls (`add` and `kill`) as rows in the Agents card.
    fn swarm_step(&mut self, index: u64, done: bool, failed: Option<Option<String>>, info: &Value) {
        let params = params_of(&info["parameters"]);
        let action = params["action"].as_str().unwrap_or("").trim();
        match action {
            "add" => {
                let base = params["name"].as_str().unwrap_or("").trim();
                if base.is_empty() {
                    return;
                }
                let names: Vec<String> = if let Some(tasks) = params["tasks"].as_array().filter(|t| !t.is_empty()) {
                    (1..=tasks.len()).map(|i| format!("{base}-{i}")).collect()
                } else {
                    let count = params["n"].as_u64().unwrap_or(1).min(32);
                    if count > 1 {
                        (1..=count).map(|i| format!("{base}-{i}")).collect()
                    } else {
                        vec![base.to_string()]
                    }
                };
                if !done {
                    for (n, worker_name) in names.into_iter().enumerate() {
                        let row_id = format!("swarm-{worker_name}");
                        let made = self.agents.upsert(&row_id, || AgentRow::new(row_id.as_str(), PROVIDER, &worker_name));
                        if made.state.is_final() {
                            made.reopen();
                        }
                        made.now = Some(Activity::thinking());
                        made.background = true;
                        made.can_ask = true;
                        made.can_stop = true;
                        if !self.spawns.iter().any(|s| s.row == row_id) {
                            self.spawns.push(Spawn::new(index, n, row_id, None, Some(worker_name), None));
                        }
                    }
                } else if let Some(err) = failed {
                    let ids: Vec<String> = self.spawns.iter().filter(|s| s.step == index && s.row.starts_with("swarm-")).map(|s| s.row.clone()).collect();
                    for id in ids {
                        if let Some(row) = self.agents.touch(&id) {
                            row.end(AgentState::Failed, err.clone());
                            row.can_stop = false;
                        }
                    }
                }
            }
            "kill" if done && failed.is_none() => {
                let target = params["name"].as_str().unwrap_or("").trim().trim_start_matches('@');
                if target.is_empty() {
                    return;
                }
                // The worker of that name, or the workers `add` numbered after it ("w" → "w-1", "w-2"…).
                let numbered = |n: &str| n.strip_prefix(target).and_then(|r| r.strip_prefix('-')).is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_digit()));
                let ids: Vec<String> = self
                    .spawns
                    .iter()
                    .filter(|s| s.row.starts_with("swarm-") && s.name.as_deref().is_some_and(|n| n == target || numbered(n)))
                    .map(|s| s.row.clone())
                    .collect();
                for id in ids {
                    self.stopped(&id);
                }
            }
            _ => {}
        }
    }

    /// Handles `post_message` tool calls by attaching a Talk to the first `@mention`ed swarm worker.
    fn post_message_step(&mut self, index: u64, info: &Value) {
        let params = params_of(&info["parameters"]);
        let text = ["text", "message", "Message"]
            .iter()
            .filter_map(|k| params[*k].as_str())
            .map(str::trim)
            .find(|s| !s.is_empty())
            .unwrap_or("");
        for word in text.split_whitespace() {
            let Some(rest) = word.strip_prefix('@') else { continue };
            let name = rest.trim_end_matches(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_');
            if name.is_empty() || name == "all" || name == "coordinator" {
                continue;
            }
            if self.resolve(name).is_some() {
                self.talk_sent(index, name, text);
                break;
            }
        }
    }

    /// Handles `read_board` tool output: `[done]` messages from known swarm workers finish their row.
    fn read_board_step(&mut self, info: &Value) {
        let Some(output) = ["output", "response", "result"].iter().filter_map(|k| info[*k].as_str()).find(|s| !s.trim().is_empty()) else {
            return;
        };
        let workers: Vec<(String, String)> = self
            .spawns
            .iter()
            .filter(|s| s.row.starts_with("swarm-"))
            .filter_map(|s| Some((s.name.clone()?, s.row.clone())))
            .collect();
        for line in output.lines() {
            let Some(done_at) = line.find("[done]") else { continue };
            let summary = line[done_at + "[done]".len()..].trim();
            for (name, row_id) in &workers {
                if !names(&line[..done_at], name) {
                    continue;
                }
                if self.agents.get(row_id).is_some_and(|r| !r.state.is_final()) {
                    if let Some(row) = self.agents.touch(row_id) {
                        if !summary.is_empty() {
                            row.summary = Some(crate::chat_agents::summary_of(summary));
                            if let Some(talk) = row.talk.as_mut().filter(|t| t.pending()) {
                                talk.answer(summary);
                            }
                        }
                        row.end(AgentState::Done, None);
                        row.can_stop = false;
                    }
                }
            }
        }
    }

    /// Handles `run_workflow` tool calls: spawns one row per static `role="..."` in `Script` and finishes them when the step ends.
    fn workflow_step(&mut self, index: u64, done: bool, failed: Option<Option<String>>, info: &Value) {
        if !done {
            if self.spawns.iter().any(|s| s.step == index) {
                return;
            }
            let params = params_of(&info["parameters"]);
            let Some(script) = params["Script"].as_str() else { return };
            for (n, role) in extract_workflow_roles(script).into_iter().enumerate() {
                let row_id = format!("wf-{}-{index}-{}", self.mark(), n + 1);
                let made = self.agents.upsert(&row_id, || AgentRow::new(row_id.as_str(), PROVIDER, &role));
                made.now = Some(Activity::thinking());
                self.spawns.push(Spawn::new(index, n, row_id, None, Some(role), None));
            }
            return;
        }
        let ids: Vec<String> = self
            .spawns
            .iter()
            .filter(|s| s.step == index && s.row.starts_with("wf-") && s.log.is_none())
            .map(|s| s.row.clone())
            .collect();
        for id in ids {
            if self.agents.get(&id).is_some_and(|r| !r.state.is_final()) {
                if let Some(row) = self.agents.touch(&id) {
                    match &failed {
                        Some(err) => row.end(AgentState::Failed, err.clone()),
                        None => row.end(AgentState::Done, None),
                    }
                    row.can_stop = false;
                }
            }
        }
    }

    /// Handles `manage_subagents` (`kill` / `kill_all`) called by agy itself.
    fn manage_step(&mut self, info: &Value) {
        let params = params_of(&info["parameters"]);
        let Some(ids) = kills_of("manage_subagents", &params) else { return };
        let targets: Vec<String> = if ids.is_empty() {
            // Its own subagents, and theirs with them.
            self.spawns.iter().filter(|s| s.parent.is_none()).map(|s| s.row.clone()).collect()
        } else {
            ids.iter().filter_map(|id| self.resolve(id)).collect()
        };
        for id in targets {
            self.stopped(&id);
        }
    }

    /// The user asked to stop one open subagent: the stream-json message
    /// that asks agy to, to write on its input. The row says it is stopping
    /// until agy says it stopped (`stopped`), or STOP_WAIT passed.
    fn stop_one(&mut self, id: &str) -> Option<String> {
        if !self.agents.get(id).is_some_and(|r| !r.state.is_final() && r.can_stop) {
            return None;
        }
        let spawn = self.spawns.iter_mut().rev().find(|s| s.row == id)?;
        let swarm_name = spawn.name.as_deref().filter(|_| spawn.row.starts_with("swarm-"));
        let target = spawn.conversation.as_deref().unwrap_or(id);
        let line = stop_agent_event(swarm_name, target);
        spawn.stop_asked = Some(Instant::now());
        if let Some(row) = self.agents.touch(id) {
            row.stopping = true;
        }
        Some(line)
    }

    /// Row `id` was stopped, by the user or by the agent that started it:
    /// and every subagent it started, which agy stops with it.
    fn stopped(&mut self, id: &str) {
        let mut ids = vec![id.to_string()];
        let mut i = 0;
        while i < ids.len() {
            let parent = ids[i].clone();
            ids.extend(self.spawns.iter().filter(|s| s.parent.as_deref() == Some(parent.as_str())).map(|s| s.row.clone()));
            i += 1;
        }
        for id in ids {
            if self.agents.get(&id).is_some_and(|r| !r.state.is_final()) {
                if let Some(row) = self.agents.touch(&id) {
                    row.end(AgentState::Stopped, None);
                    row.can_stop = false;
                    row.can_ask = false;
                }
            }
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
        // Who each one's parent is: its messages there are its report.
        let known: HashSet<String> = self.spawns.iter().filter_map(|s| s.conversation.clone()).collect();
        let parents: Vec<Option<String>> = self
            .spawns
            .iter()
            .map(|s| match &s.parent {
                Some(p) => self.spawns.iter().find(|o| o.row == *p).and_then(|o| o.conversation.clone()),
                None => self.main.clone(),
            })
            .collect();
        let mut kills: Vec<(usize, Vec<String>)> = Vec::new();
        for (i, spawn) in self.spawns.iter_mut().enumerate() {
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
            // Its calls of Lumo's browser: the tabs they open or use are its own.
            let mut browsed = Vec::new();
            for line in whole.split(|b| *b == b'\n').filter(|l| l.len() <= MAX_LINE) {
                let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
                if !std::mem::replace(&mut spawn.began, true) {
                    spawn.sender = sender_of(&v).map(str::to_string);
                }
                browsed.extend(transcript_browsing(&v));
                let parent = spawn.sender.clone().or_else(|| parents[i].clone());
                let to_parent = |to: &str| {
                    let to = to.trim().trim_start_matches('@');
                    match &parent {
                        Some(p) => to.eq_ignore_ascii_case(p),
                        // Who started it is not known: anyone but a subagent of ours.
                        None => !known.contains(to),
                    }
                };
                let heard = transcript_line(row, &mut spawn.reading, &mut self.files, &v, &to_parent);
                if let Some(plan) = row.plan.as_ref().filter(|p| !self.their_plans.contains(p)) {
                    if self.their_plans.len() >= MAX_PLANS_KEPT {
                        self.their_plans.remove(0);
                    }
                    self.their_plans.push(plan.clone());
                }
                spawn.lines += 1;
                if let Some(from) = heard.message_from {
                    spawn.heard_at = spawn.lines;
                    spawn.heard_from.insert(from);
                }
                if heard.reported || heard.answered {
                    spawn.reported_at = spawn.lines;
                }
                spawn.invoked(heard.invoked);
                spawn.cancelled(heard.cancelled);
                if let Some(ids) = heard.killed {
                    kills.push((i, ids));
                }
                if let Some(error) = heard.error {
                    spawn.failing = Some((Instant::now(), error));
                }
                if heard.called || heard.answered {
                    spawn.failing = None;
                }
                if heard.called {
                    // Woken (by its subagents' messages): at work again.
                    spawn.waiting_since = None;
                }
                if heard.answered {
                    spawn.answered = true;
                    if spawn.roles.is_empty() {
                        row.end(AgentState::Done, None);
                        row.can_stop = false;
                        break;
                    }
                    // Subagents of its own: done once they are (`settle`).
                    spawn.waiting_since = Some(Instant::now());
                }
            }
            for (tool, input) in browsed {
                self.agents.browsed(&spawn.row, tool, input);
            }
        }
        // The subagents they stopped themselves (manage_subagents).
        for (i, ids) in kills {
            let parent = self.spawns[i].row.clone();
            let targets: Vec<String> = if ids.is_empty() {
                self.spawns.iter().filter(|s| s.parent.as_deref() == Some(parent.as_str())).map(|s| s.row.clone()).collect()
            } else {
                ids.iter().filter_map(|id| self.resolve(id)).filter(|r| *r != parent).collect()
            };
            for id in targets {
                self.stopped(&id);
                changed = true;
            }
        }
        // The subagents the subagents started, as soon as agy names them.
        changed |= self.find_children();
        changed |= self.settle();
        read_any |= self.read_main();
        (changed, read_any)
    }

    /// The main conversation's transcript, in agy's folder of conversations,
    /// once both are known.
    fn main_log(&self) -> Option<PathBuf> {
        let main = safe_id(self.main.as_deref()?)?;
        Some(self.brain.as_ref()?.join(main).join(".system_generated").join("logs").join("transcript.jsonl"))
    }

    /// The plans the main conversation's own calls of update_plan gave since
    /// the last look (a chunk at most): whether anything was read.
    fn read_main(&mut self) -> bool {
        use std::io::{Seek, SeekFrom};
        let Some(path) = self.main_log() else { return false };
        let Ok(mut file) = std::fs::File::open(&path) else { return false };
        self.main_found = true;
        if file.seek(SeekFrom::Start(self.main_read)).is_err() {
            return false;
        }
        let mut fresh = Vec::new();
        let Ok(n) = (&mut file).take(TRANSCRIPT_CHUNK).read_to_end(&mut fresh) else { return false };
        if n == 0 {
            return false;
        }
        self.main_read += n as u64;
        self.main_partial.extend_from_slice(&fresh);
        let whole: Vec<u8> = match self.main_partial.iter().rposition(|b| *b == b'\n') {
            Some(last) => self.main_partial.drain(..=last).collect(),
            None => Vec::new(),
        };
        // A line past MAX_LINE (a huge file written whole) holds no plan of ours.
        if self.main_partial.len() > MAX_LINE {
            self.main_partial.clear();
        }
        for line in whole.split(|b| *b == b'\n').filter(|l| !l.is_empty() && l.len() <= MAX_LINE) {
            let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
            for call in v["tool_calls"].as_array().map(Vec::as_slice).unwrap_or(&[]) {
                let Some(plan) = plan_call_of(call["name"].as_str().unwrap_or(""), &transcript_args(&call["args"])) else { continue };
                if self.main_plans.len() >= MAX_PLANS_KEPT {
                    self.main_plans.remove(0);
                }
                self.main_plans.push(plan);
            }
        }
        true
    }

    /// Whose a plan lumo-hook handed over without `agent` is: the chat's
    /// (true) when the main conversation's transcript has that call, a
    /// subagent's (false) when one of theirs gave it; None while it can't be
    /// told yet. Without the main transcript (not found), every plan none of
    /// theirs gave is the chat's.
    fn whose_plan(&self, steps: &Option<Vec<PlanStep>>) -> Option<bool> {
        let Some(steps) = steps else { return Some(false) };
        if self.main_plans.contains(steps) {
            return Some(true);
        }
        let theirs = self.their_plans.contains(steps) || self.agents.ids().any(|id| self.agents.get(&id).is_some_and(|r| r.plan.as_ref() == Some(steps)));
        if theirs {
            return Some(false);
        }
        (!self.main_found).then_some(true)
    }

    /// The subagents the open subagents started (and the end agy gave any of
    /// them): agy keeps each in its parent's folder (`children_of`). An older
    /// agy keeps none there: then they are looked for through its whole
    /// `brain` (`scan_brain`). Whether a row changed.
    fn find_children(&mut self) -> bool {
        let Some(brain) = self.brain.clone() else { return false };
        let mut changed = false;
        // The chat's own conversation (the end of the subagents it started),
        // then each subagent still open.
        let mut parents: Vec<(Option<usize>, String)> = self.main.iter().map(|m| (None, m.clone())).collect();
        for (i, s) in self.spawns.iter().enumerate() {
            let open = self.agents.get(&s.row).is_some_and(|r| !r.state.is_final());
            if let (true, Some(c)) = (open, &s.conversation) {
                parents.push((Some(i), c.clone()));
            }
        }
        for (parent, conversation) in parents {
            let Some(list) = children_of(&brain, &conversation) else { continue };
            self.child_files = true;
            if let Some(i) = parent {
                // Taken up again (Ask): the subagents of its earlier rounds are none of this one's.
                if !std::mem::replace(&mut self.spawns[i].listed, true) && self.agents.get(&self.spawns[i].row).is_some_and(|r| r.round > 0) {
                    for child in &list {
                        if !self.spawns.iter().any(|s| s.conversation.as_deref() == Some(child.conversation.as_str())) {
                            self.looked.insert(child.conversation.clone());
                        }
                    }
                }
            }
            for child in list {
                changed |= self.child_seen(&brain, parent, child);
            }
        }
        if !self.child_files {
            changed |= self.scan_brain();
        }
        changed
    }

    /// Subagent `child`, as agy keeps it in the folder of its parent (the
    /// spawn at `parent`, or the chat's own conversation): a row under its
    /// parent the first time, and its end once agy ended it.
    fn child_seen(&mut self, brain: &Path, parent: Option<usize>, child: ChildFile) -> bool {
        let known = self.spawns.iter().position(|s| s.conversation.as_deref() == Some(child.conversation.as_str()));
        let pos = match known {
            Some(pos) => pos,
            // The chat's own subagents are named by its stream, and one of an earlier round is not ours.
            None if parent.is_none() || self.looked.contains(&child.conversation) => return false,
            None => {
                let Some(p) = parent else { return false };
                let log = brain.join(&child.conversation).join(".system_generated").join("logs").join("transcript.jsonl");
                let first = first_line(&log);
                let role = self.spawns[p].claim(first.as_ref().and_then(first_prompt), child.role.as_deref());
                let parent_row = self.spawns[p].row.clone();
                let title = child.role.clone().or(role.clone()).or_else(|| first.as_ref().and_then(prompt_title)).unwrap_or_else(|| t("Agent"));
                let row = format!("agy-{}-{}", self.mark(), child.conversation);
                let made = self.agents.upsert(&row, || AgentRow::new(row.as_str(), PROVIDER, &title));
                made.parent = Some(parent_row.clone());
                made.now = Some(Activity::thinking());
                made.can_ask = true;
                made.can_stop = true;
                let mut spawn = Spawn::new(u64::MAX, 0, row, Some(child.conversation.clone()), child.role.clone().or(role), Some(log));
                spawn.parent = Some(parent_row);
                self.spawns.push(spawn);
                self.spawns.len() - 1
            }
        };
        let mut changed = known.is_none();
        let id = self.spawns[pos].row.clone();
        // Found first by its first line (an older way): now its parent and role are certain.
        if let Some(p) = parent.filter(|p| *p != pos) {
            if self.spawns[pos].parent.is_none() && self.spawns[pos].step == u64::MAX {
                let parent_row = self.spawns[p].row.clone();
                self.spawns[pos].parent = Some(parent_row.clone());
                if let Some(row) = self.agents.touch(&id) {
                    row.parent = Some(parent_row);
                }
                changed = true;
            }
        }
        // Ended by agy: stopped, or closed once it had answered.
        if child.killed && self.agents.get(&id).is_some_and(|r| !r.state.is_final()) {
            let spawn = &self.spawns[pos];
            if spawn.answered || spawn.reading.report.is_some() {
                if let Some(row) = self.agents.touch(&id) {
                    row.end(AgentState::Done, None);
                    row.can_stop = false;
                }
            } else {
                self.stopped(&id);
            }
            changed = true;
        }
        changed
    }

    /// The subagents a subagent started, for an agy that keeps none in its
    /// parent's folder: a conversation of this turn whose first message came
    /// from that subagent's conversation. Looked for only while a subagent
    /// started more than were found; a conversation read but not claimed
    /// yet (its parent's call is read later) waits in `firsts`. Whether a
    /// row was added.
    fn scan_brain(&mut self) -> bool {
        let wanted = |s: &Spawn| s.conversation.is_some() && s.roles.len() > s.children;
        if !self.spawns.iter().any(wanted) {
            return false;
        }
        let (Some(brain), Some(since)) = (self.brain.clone(), self.since) else { return false };
        let Ok(entries) = std::fs::read_dir(&brain) else { return false };
        // At most MAX_SCAN conversations not seen yet, each look: the ones seen don't count.
        let mut fresh = 0;
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if self.looked.contains(&name) || self.firsts.contains_key(&name) || self.spawns.iter().any(|s| s.conversation.as_deref() == Some(name.as_str())) {
                continue;
            }
            if fresh >= MAX_SCAN {
                break;
            }
            fresh += 1;
            let Ok(meta) = entry.metadata() else { continue };
            let born = meta.created().or_else(|_| meta.modified()).ok();
            if !meta.is_dir() || born.is_some_and(|b| b < since) {
                self.looked.insert(name);
                continue;
            }
            let log = entry.path().join(".system_generated").join("logs").join("transcript.jsonl");
            // Not written yet: looked at again next time.
            let Some(first) = first_line(&log) else { continue };
            match sender_of(&first) {
                Some(_) if self.firsts.len() < MAX_FIRSTS => {
                    self.firsts.insert(name, first);
                }
                _ => {
                    self.looked.insert(name);
                }
            }
        }
        let mut names: Vec<String> = self.firsts.keys().cloned().collect();
        names.sort();
        let mut added = false;
        for name in names {
            let Some(sender) = self.firsts.get(&name).and_then(sender_of).map(str::to_string) else { continue };
            let Some(p) = self.spawns.iter().position(|s| wanted(s) && s.conversation.as_deref() == Some(sender.as_str())) else { continue };
            let Some(first) = self.firsts.remove(&name) else { continue };
            self.looked.insert(name.clone());
            let role = self.spawns[p].claim(first_prompt(&first), None);
            let parent_row = self.spawns[p].row.clone();
            let title = role.clone().or_else(|| prompt_title(&first)).unwrap_or_else(|| t("Agent"));
            let row = format!("agy-{}-{name}", self.mark());
            let made = self.agents.upsert(&row, || AgentRow::new(row.as_str(), PROVIDER, &title));
            made.parent = Some(parent_row.clone());
            made.now = Some(Activity::thinking());
            made.can_ask = true;
            made.can_stop = true;
            let log = brain.join(&name).join(".system_generated").join("logs").join("transcript.jsonl");
            let mut spawn = Spawn::new(u64::MAX, 0, row, Some(name), role, Some(log));
            spawn.parent = Some(parent_row);
            self.spawns.push(spawn);
            added = true;
        }
        added
    }

    /// The subagents that answered while subagents of their own work: each
    /// says how many of those finished, and is done once they all are (or,
    /// when some never showed, a moment after it answered). A Stop agy never
    /// confirmed is taken back. Whether a row changed.
    fn settle(&mut self) -> bool {
        let mut changed = false;
        for i in 0..self.spawns.len() {
            let id = self.spawns[i].row.clone();
            if self.agents.get(&id).is_none_or(|r| r.state.is_final()) {
                continue;
            }
            // agy's error stopped it and it never went on: failed, with agy's words.
            if let Some((_, error)) = self.spawns[i].failing.take_if(|(at, _)| at.elapsed() >= FAIL_GRACE) {
                if let Some(row) = self.agents.touch(&id) {
                    // Past agy's prefixes ("API error (attempt 1): UNAVAILABLE (code 503): …").
                    let said = error.rsplit_once("): ").map_or(error.as_str(), |(_, w)| w);
                    let words = Some(error_words(said)).filter(|w| !w.is_empty());
                    row.end(AgentState::Failed, words.map(|w| crate::chat_agents::summary_of(&w)));
                    row.can_stop = false;
                    changed = true;
                }
                continue;
            }
            if self.spawns[i].stop_asked.is_some_and(|at| at.elapsed() >= STOP_WAIT) {
                self.spawns[i].stop_asked = None;
                if let Some(row) = self.agents.touch(&id) {
                    row.stopping = false;
                    changed = true;
                }
            }
            let Some(since) = self.spawns[i].waiting_since else { continue };
            let kids: Vec<&Spawn> = self.spawns.iter().filter(|s| s.parent.as_deref() == Some(id.as_str())).collect();
            let done = kids.iter().filter(|k| self.agents.get(&k.row).is_some_and(|r| r.state.is_final())).count();
            let open = kids.len() - done;
            let missing = self.spawns[i].roles.len().saturating_sub(kids.len());
            let total = kids.len() + missing;
            // Its subagents done, it still owes its parent their results: agy
            // wakes it with their messages, it reports, and only then is it done
            // (its parent waits for that report to write to the chat).
            let owes = open == 0 && !(missing > 0 && since.elapsed() < CHILD_GRACE) && self.owes_report(i);
            if !owes {
                self.spawns[i].owing_since = None;
            }
            let owing = owes && self.spawns[i].owing_since.get_or_insert_with(Instant::now).elapsed() < REPORT_WAIT;
            if open > 0 || (missing > 0 && since.elapsed() < CHILD_GRACE) || owing {
                let now = Activity::new("agents", format!("{done}/{total}"));
                if self.agents.get(&id).is_some_and(|r| r.now.as_ref() != Some(&now)) {
                    if let Some(row) = self.agents.touch(&id) {
                        row.now = Some(now);
                        changed = true;
                    }
                }
            } else if let Some(row) = self.agents.touch(&id) {
                row.end(AgentState::Done, None);
                row.can_stop = false;
                changed = true;
            }
        }
        changed
    }

    /// Whether the subagent `spawns[i]`, its own subagents done, has not yet
    /// passed their results on: a message of theirs reached it after its last
    /// report, or one that reported to it has not reached it yet.
    fn owes_report(&self, i: usize) -> bool {
        let spawn = &self.spawns[i];
        if spawn.heard_at > spawn.reported_at {
            return true;
        }
        self.spawns.iter().filter(|k| k.parent.as_deref() == Some(spawn.row.as_str()) && k.reading.report.is_some()).any(|k| {
            k.conversation.as_ref().is_some_and(|c| !spawn.heard_from.contains(c))
        })
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
        // A call of Lumo's browser: the tab it opens or uses is this
        // subagent's (told again with each update: browser.rs takes it once).
        if !done && v["step_type"] == "tool" {
            let info = &v["tool_info"];
            let name = info["name"].as_str().filter(|s| !s.is_empty()).or_else(|| v["tool_name"].as_str()).unwrap_or("");
            if let Some((tool, input)) = browser_call(name, &info["parameters"]) {
                self.agents.browsed(&id, tool, input);
            }
        }
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

    /// agy ended (`state`: as its turn did): no subagent outlives it. One
    /// still at work was cut off, never done: it failed, and the island
    /// offers Resume (`ended_by`); stopped with the user's Stop.
    fn run_ended(&mut self, state: AgentState) {
        let (state, error) = match state {
            AgentState::Stopped => (AgentState::Stopped, String::new()),
            _ => (AgentState::Failed, tf("{agent} ended", &[("agent", "Antigravity CLI")])),
        };
        if self.agents.open() > 0 {
            self.agents.end_open(state, &error);
        }
        let ids: Vec<String> = self.agents.ids().collect();
        for id in ids {
            let needs_update = self
                .agents
                .get(&id)
                .is_some_and(|r| r.can_stop || r.stopping || (r.state == AgentState::Stopped && r.can_ask) || r.talk.as_ref().is_some_and(AgentTalk::pending));
            if !needs_update {
                continue;
            }
            if let Some(row) = self.agents.touch(&id) {
                row.can_stop = false;
                row.stopping = false;
                // Stopped, it can't be asked again; cut off or done, a later turn can.
                if row.state == AgentState::Stopped {
                    row.can_ask = false;
                }
                if let Some(talk) = row.talk.as_mut().filter(|t| t.pending()) {
                    talk.failed = Some(if error.is_empty() { t("The task was stopped.") } else { error.clone() });
                }
            }
        }
    }
}

/// Whether `text` names `name` as a whole: "w-1" in "w-1: [done]" or
/// "\"w-1\"", not in "w-10" nor "xw-1".
fn names(text: &str, name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let part = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '-' || c == '_');
    text.match_indices(name).any(|(at, _)| !part(text[..at].chars().next_back()) && !part(text[at + name.len()..].chars().next()))
}

/// `text` with every whole `from` (`names`) made `to`.
fn replace_whole(text: &str, from: &str, to: &str) -> String {
    let part = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '-' || c == '_');
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (at, _) in text.match_indices(from) {
        if at < last || part(text[..at].chars().next_back()) || part(text[at + from.len()..].chars().next()) {
            continue;
        }
        out.push_str(&text[last..at]);
        out.push_str(to);
        last = at + from.len();
    }
    out.push_str(&text[last..]);
    out
}

/// Extracts `(sender, content)` from an agy `system_message` step (`[Message] ... sender=<id> ... content=<msg>`).
fn system_message_reply(v: &Value) -> Option<(String, String)> {
    let text = v["content"].as_str().or_else(|| v["text_delta"].as_str()).or_else(|| v["message"].as_str())?;
    let s_at = text.find("sender=")?;
    let sender_rest = &text[s_at + "sender=".len()..];
    let sender = sender_rest.split_whitespace().next()?.trim();
    if sender.is_empty() {
        return None;
    }
    let c_at = text.find("content=")?;
    let content_rest = &text[c_at + "content=".len()..];
    let content = content_rest.split("\n</SYSTEM_MESSAGE>").next().unwrap_or(content_rest).trim();
    if content.is_empty() {
        return None;
    }
    Some((sender.to_string(), content.to_string()))
}

/// Builds the stream-json user event instructing `agy` to stop a single swarm worker or subagent.
fn stop_agent_event(swarm_name: Option<&str>, target: &str) -> String {
    match swarm_name {
        Some(worker) => user_event(&format!("Stop swarm worker \"{worker}\" now with swarm (action: \"kill\", name: \"{worker}\").")),
        None => user_event(&format!("Stop subagent \"{target}\" now with manage_subagents (Action: \"kill\", ConversationIds: [\"{target}\"]).")),
    }
}

struct StopperGuard {
    chat: String,
    id: u64,
}

impl Drop for StopperGuard {
    fn drop(&mut self) {
        chat_agents::forget_stopper_of(&self.chat, self.id);
    }
}

// ── Reading the stream ────────────────────────────────────────────────────────

/// What the stream-json output has told us so far.
#[derive(Default, Debug)]
struct Run {
    /// The conversation to resume next turn.
    conversation: Option<String>,
    /// The text of the response step being written.
    visible: String,
    /// Every response step of the turn so far, one paragraph each: what the
    /// island shows (chat::add_shown), the sentences before the tools too.
    shown: String,
    /// The next text starts a step of its own in `shown`.
    new_step: bool,
    /// Every text of the turn, each step on its own lines (chat::keep_lumo_lines).
    said: String,
    /// The `step_index` `visible` belongs to.
    text_step: Option<u64>,
    /// The `result` event: final text, or the error agy reported.
    result: Option<Result<String, String>>,
    /// The answer a `result` that reported an error still carried: agy can end
    /// a turn the model finished as an error (a malformed tool call it had the
    /// model try again, earlier in the turn).
    failed_response: String,
    /// That `result` as agy wrote it, its answer left out (only its length):
    /// for the log, so what agy said is known later.
    failed_line: Option<String>,
    denied: usize,
    /// The user pressed Stop and the CLI was ended.
    stopped: bool,
    /// What the answer is doing since the text last grew (None once it does).
    activity: Option<Activity>,
    /// `activity` changed and the island was not told yet (`take_activity`).
    activity_changed: bool,
    /// Tool steps still running, oldest first: whose step it is (`MAIN`, or
    /// the subagent's conversation: each counts its steps from 0), its index,
    /// and what it is doing.
    pending: Vec<(String, u64, Activity)>,
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
    /// The steps of the chat's own conversation still going, and when it was last heard.
    open_steps: HashSet<u64>,
    last_main: Option<Instant>,
    /// agy's stream showed a plan of the chat's own: a plan lumo-hook hands
    /// over while subagents work is that one again, or one of theirs (`release_plans`).
    stream_plans: bool,
    /// agy, going on with the subagents after the turn's answer (`agy_turn`).
    agy: Option<Box<Agy>>,
    /// agy's input is open (`drive` says, for `leave`).
    agy_open: bool,
    /// What agy writes by itself, between two messages of the chat (`linger`).
    own: bool,
}

/// The tokens a result's `usage` counts: what the model read (cached or not,
/// as agy's input counts the cache in) and what it wrote and thought.
fn usage_tokens(usage: &Value) -> Option<u64> {
    let n = |k: &str| usage[k].as_u64().unwrap_or(0);
    let total = n("input_tokens") + n("output_tokens") + n("thinking_tokens");
    (total > 0).then_some(total)
}

/// The context window used at the latest model step in a transcript's bytes:
/// `input_tokens + cache_read_tokens + output_tokens` of the last valid JSON
/// line where `input_tokens + cache_read_tokens > 0`. Lines without token
/// usage (`GENERIC`, `USER_INPUT`, etc.) and malformed lines are ignored.
fn last_transcript_context(bytes: &[u8]) -> Option<u64> {
    for line in bytes.split(|&b| b == b'\n').rev() {
        let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
        let n = |k: &str| v[k].as_u64().unwrap_or(0);
        let prompt = n("input_tokens").saturating_add(n("cache_read_tokens"));
        if prompt > 0 {
            return Some(prompt.saturating_add(n("output_tokens")));
        }
    }
    None
}

/// Locates `conversation_id`'s `transcript.jsonl` under `home`'s `.gemini`
/// directory (`antigravity-cli`, falling back to `antigravity`).
fn conversation_transcript_in(home: &Path, conversation_id: &str) -> Option<PathBuf> {
    let id = safe_session(conversation_id)?;
    ["antigravity-cli", "antigravity"]
        .into_iter()
        .map(|dir| home.join(".gemini").join(dir).join("brain").join(id).join(".system_generated").join("logs").join("transcript.jsonl"))
        .find(|p| p.is_file())
}

/// Locates the main conversation's `transcript.jsonl` in agy's `.gemini`
/// folder, or `None` if `conversation_id` is invalid, home isn't set, or
/// neither `antigravity-cli` nor `antigravity` has the file.
fn conversation_transcript(conversation_id: &str) -> Option<PathBuf> {
    let home = std::env::var_os(platform::HOME_VAR).filter(|v| !v.is_empty()).map(PathBuf::from)?;
    conversation_transcript_in(&home, conversation_id)
}

/// Reads up to `TRANSCRIPT_CHUNK` bytes from the tail of `path`, skipping a
/// partial first line when seeking past byte `0`, and returns the latest
/// step's context size.
fn read_transcript_context(path: &Path) -> Option<u64> {
    last_transcript_context(&read_transcript_tail(path)?)
}

/// Up to `TRANSCRIPT_CHUNK` bytes from the tail of `path`, from the first
/// whole line.
fn read_transcript_tail(path: &Path) -> Option<Vec<u8>> {
    use std::io::{Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TRANSCRIPT_CHUNK);
    if start > 0 {
        file.seek(SeekFrom::Start(start)).ok()?;
    }
    let mut buf = Vec::with_capacity((len - start).min(TRANSCRIPT_CHUNK) as usize);
    (&mut file).take(TRANSCRIPT_CHUNK).read_to_end(&mut buf).ok()?;
    if start > 0 {
        let nl = buf.iter().position(|&b| b == b'\n')?;
        buf.drain(..=nl);
    }
    Some(buf)
}

/// How long a turn agy took up by itself (a subagent's message woke it) may
/// write nothing in its transcript and still count as under way: the model
/// may think a long while before its next step, and agy says nothing of it.
const WOKEN_TURN_MAX: Duration = Duration::from_secs(5 * 60);

/// Whether the last line of a transcript leaves its turn under way: a
/// message that woke it (a subagent's, agy's own), the user's, a tool's
/// result, or a step of the model that calls tools. Only an answer without
/// tool calls, or agy's error, ends a turn.
fn turn_under_way(tail: &[u8]) -> bool {
    for line in tail.split(|&b| b == b'\n').rev() {
        let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
        let calls = v["tool_calls"].as_array().is_some_and(|c| !c.is_empty())
            || v["truncated_fields"].as_array().is_some_and(|f| f.iter().any(|x| x == "tool_calls"));
        return match v["type"].as_str() {
            Some("PLANNER_RESPONSE") => calls,
            Some("ERROR_MESSAGE") | None => false,
            Some(_) => true,
        };
    }
    false
}

/// Whether the turn in `path` is under way and its transcript moved within
/// `max`: one woken by a subagent's message, while agy's stream is quiet
/// (the model thinks), is not to be cut off by closing agy's input.
fn transcript_turn_under_way(path: &Path, max: Duration) -> bool {
    let fresh = std::fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|at| at.elapsed().ok()).is_some_and(|age| age < max);
    fresh && read_transcript_tail(path).is_some_and(|tail| turn_under_way(&tail))
}

/// The same for the chat's conversation `conversation_id`, in agy's `.gemini` folder.
fn woken_turn_under_way(conversation_id: &str) -> bool {
    conversation_transcript(conversation_id).is_some_and(|path| transcript_turn_under_way(&path, WOKEN_TURN_MAX))
}

/// Actual context window used at the latest model step of `conversation_id`,
/// read from agy's main `transcript.jsonl` instead of the cumulative `result.usage`.
fn transcript_context_tokens(conversation_id: &str) -> Option<u64> {
    let path = conversation_transcript(conversation_id)?;
    read_transcript_context(&path)
}

impl Run {
    /// What agy writes by itself while `subagents` work, in `conversation`.
    fn lingering(subagents: Subagents, conversation: &str) -> Run {
        Run { subagents, conversation: Some(conversation.to_string()), own: true, ..Run::default() }
    }

    /// The same, after what it wrote went to the chat.
    fn next_turn(&mut self) -> Run {
        Run {
            subagents: std::mem::take(&mut self.subagents),
            conversation: self.conversation.take(),
            plan_seen: self.plan_seen.take(),
            stream_plans: self.stream_plans,
            own: true,
            ..Run::default()
        }
    }

    /// A step of the chat's own conversation began, or ended.
    fn main_step(&mut self, index: u64, done: bool) {
        if done {
            self.open_steps.remove(&index);
        } else {
            self.open_steps.insert(index);
        }
        self.last_main = Some(Instant::now());
    }

    /// Writing: a step of its own still going. Not a subagent's (in
    /// `pending` too): one cut off before its DONE would keep the chat
    /// writing until the end of the turn.
    fn writing(&self) -> bool {
        !self.open_steps.is_empty()
    }

    /// Not writing, and quiet for QUIET_ANSWER.
    fn idle(&self) -> bool {
        !self.writing() && self.last_main.is_none_or(|at| at.elapsed() >= QUIET_ANSWER)
    }

    /// Its answer is written, all its steps done, quiet for `quiet`, while
    /// its subagents work: agy waits for them.
    fn answered_with_agents(&self, quiet: Duration) -> bool {
        self.result.is_none()
            && !self.shown.trim().is_empty()
            && !self.writing()
            && self.last_main.is_some_and(|at| at.elapsed() >= quiet)
            && self.subagents.spawns_open()
    }

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
                    (s, error) => {
                        self.failed_line = Some(logged_result(&frame));
                        self.failed_response = response;
                        Err(error.unwrap_or_else(|| s.to_string()))
                    }
                });
                false
            }
            Some(event) => {
                if self.conversation.is_none() {
                    self.conversation = id.map(str::to_string);
                }
                // agy names the chat's own conversation first thing.
                if event == "init" && self.subagents.main.is_none() {
                    let named = v.get("conversation_id").or_else(|| frame.get("conversation_id")).and_then(Value::as_str);
                    self.subagents.main = named.map(str::trim).filter(|c| safe_id(c).is_some()).map(str::to_string);
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
        // The chat's own conversation: its subagents' messages to it are their reports.
        if self.subagents.main.is_none() && v.get("subagent_info").is_none_or(Value::is_null) {
            self.subagents.main = v["conversation_id"].as_str().map(str::trim).filter(|c| safe_id(c).is_some()).map(str::to_string);
        }
        // A step that starts subagents (step_type "subagent", or a tool's
        // step that names them): a row for each, and none for the step itself.
        if let Some(list) = v["subagent_info"]["subagents"].as_array().filter(|a| !a.is_empty()) {
            self.subagents.spawned(index, list);
            if v["state"] == "ERROR" {
                self.subagents.spawn_failed(index, error_text(&v["error"]).or_else(|| error_text(&v["subagent_info"]["error"])));
            }
            if done {
                self.finished_tool(MAIN, index);
                // Started, not finished: they work on.
                if self.subagents.spawns_open() {
                    self.set_activity(Activity::new("agents", ""));
                }
            } else {
                self.started_tool(MAIN, index, Activity::new("subtask", ""));
            }
            self.main_step(index, done);
            return false;
        }
        // A subagent at work: its own steps are its row's, not the answer's.
        if v.get("subagent_info").is_some_and(|s| !s.is_null()) {
            self.subagents.step(index, done, v);
            // Its step N is not the answer's step N.
            let whose = format!("subagent:{}", v["subagent_info"]["conversation_id"].as_str().unwrap_or_default());
            if done {
                self.finished_tool(&whose, index);
            } else {
                self.started_tool(&whose, index, Activity::new("subtask", ""));
            }
            return false;
        }
        self.main_step(index, done);
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
                // A new response step: shown after the ones before, which stay.
                if self.text_step != Some(index) {
                    self.text_step = Some(index);
                    self.visible.clear();
                    self.said.push('\n');
                    self.new_step = true;
                }
                self.visible.push_str(text);
                self.said.push_str(text);
                chat::add_shown(&mut self.shown, text, &mut self.new_step);
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
                    self.subagents.talk_done(index, failed.then(|| error_text(&info["error"])));
                    if name == "swarm" {
                        self.subagents.swarm_step(index, true, failed.then(|| error_text(&info["error"])), info);
                    } else if name == "read_board" && !failed {
                        self.subagents.read_board_step(info);
                    } else if name == "run_workflow" {
                        self.subagents.workflow_step(index, true, failed.then(|| error_text(&info["error"])), info);
                    } else if name == "manage_subagents" && !failed {
                        self.subagents.manage_step(info);
                    }
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
                    self.finished_tool(MAIN, index);
                } else {
                    if is_plan_tool(name) {
                        self.saw_plan(&info["parameters"]);
                    }
                    if name == "send_message" {
                        let params = params_of(&info["parameters"]);
                        let to = ["Recipient", "recipient", "to"].iter().filter_map(|k| params[*k].as_str()).map(str::trim).find(|s| !s.is_empty()).unwrap_or("");
                        let message = ["Message", "message", "content"].iter().filter_map(|k| params[*k].as_str()).map(str::trim).find(|s| !s.is_empty()).unwrap_or("");
                        self.subagents.talk_sent(index, to, message);
                    } else if name == "swarm" {
                        self.subagents.swarm_step(index, false, None, info);
                    } else if name == "post_message" {
                        self.subagents.post_message_step(index, info);
                    } else if name == "run_workflow" {
                        self.subagents.workflow_step(index, false, None, info);
                    } else if activity_for(name, &Value::Null).kind == "subtask" {
                        self.subagents.delegated(index, delegated_title(name, &info["parameters"]));
                    }
                    if !self.touching.iter().any(|(i, _)| *i == index) {
                        if let Some(touch) = touch_for(name, &info["parameters"]) {
                            self.touching.push((index, touch));
                        }
                    }
                    self.started_tool(MAIN, index, activity_for(name, &info["parameters"]));
                }
                false
            }
            Some("user_input" | "checkpoint") => false,
            // A subagent's message woke the answer: it coordinates them.
            Some("system_message") => {
                self.subagents.system_reply(v);
                if self.subagents.spawns_open() {
                    self.set_activity(Activity::new("agents", ""));
                }
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
    fn started_tool(&mut self, whose: &str, index: u64, activity: Activity) {
        match self.pending.iter_mut().find(|(w, i, _)| w == whose && *i == index) {
            Some(entry) => entry.2 = activity.clone(),
            None => self.pending.push((whose.to_string(), index, activity.clone())),
        }
        self.set_activity(activity);
    }

    /// A tool step is done: the one still running shows, or agy thinks again.
    fn finished_tool(&mut self, whose: &str, index: u64) {
        self.pending.retain(|(w, i, _)| !(w == whose && *i == index));
        let next = self.pending.last().map(|(_, _, a)| a.clone()).unwrap_or_else(Activity::thinking);
        self.set_activity(next);
    }

    /// Lumo's update_plan called with `params` (an object, or its JSON text).
    fn saw_plan(&mut self, params: &Value) {
        let params = match params {
            Value::String(s) => serde_json::from_str::<Value>(s).unwrap_or(Value::Null),
            v => v.clone(),
        };
        // A subagent's plan (`agent`) is its row's, never the chat's.
        let subagent = params["agent"].as_str().is_some_and(|a| !a.trim().is_empty());
        if subagent || !params["plan"].as_array().is_some_and(|p| !p.is_empty()) || self.plan_seen.as_ref() == Some(&params) {
            return;
        }
        self.plan_seen = Some(params.clone());
        self.stream_plans = true;
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

/// The island chats agy is answering now (`send`), for a plan that names none.
static AT_WORK: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Island chat `chat` has agy at work until this is dropped (the turn's end,
/// stopped or failed too).
struct AtWork(String);

impl AtWork {
    fn start(chat: &str) -> AtWork {
        AT_WORK.lock().unwrap_or_else(|e| e.into_inner()).push(chat.to_string());
        AtWork(chat.to_string())
    }
}

impl Drop for AtWork {
    fn drop(&mut self) {
        let mut all = AT_WORK.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(i) = all.iter().position(|c| *c == self.0) {
            all.remove(i);
        }
    }
}

/// The island chats whose agy has subagents at work.
static WITH_AGENTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Chat `chat`'s agy has subagents at work (`open`), or none.
fn with_agents(chat: &str, open: bool) {
    if chat.is_empty() {
        return;
    }
    let mut all = WITH_AGENTS.lock().unwrap_or_else(|e| e.into_inner());
    let at = all.iter().position(|c| c == chat);
    match (open, at) {
        (true, None) => all.push(chat.to_string()),
        (false, Some(i)) => {
            all.remove(i);
        }
        _ => {}
    }
}

fn has_agents(chat: &str) -> bool {
    WITH_AGENTS.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|c| c == chat)
}

/// The plans lumo-hook handed over while the chat's subagents work, by chat, with when.
static HELD_PLANS: Mutex<Vec<(String, Value, Instant)>> = Mutex::new(Vec::new());
/// How long such a plan waits: the subagent that gave it has its transcript read by then.
const PLAN_HOLD: Duration = Duration::from_millis(4500);
/// How long a plan waits for the main conversation's transcript to show it
/// is the chat's: past that (or at the turn's end), it is left out.
const PLAN_VERIFY: Duration = Duration::from_secs(60);
/// The most plans kept of the main conversation, and of the subagents.
const MAX_PLANS_KEPT: usize = 256;
/// The most plans held.
const MAX_HELD_PLANS: usize = 64;

fn hold_plan(chat: &str, input: Value) {
    let mut all = HELD_PLANS.lock().unwrap_or_else(|e| e.into_inner());
    if all.len() >= MAX_HELD_PLANS {
        all.remove(0);
    }
    all.push((chat.to_string(), input, Instant::now()));
}

/// The plans held for chat `chat` that are its own, in the order they came
/// (`all`: the turn is over, every one held is settled now). A plan is the
/// chat's once the main conversation's transcript has that call
/// (`whose_plan`); one a subagent gave, or one never found there within
/// PLAN_VERIFY, is left out, as are all once agy's stream showed the chat's
/// own (it shows them).
fn release_plans(chat: &str, state: &Run, all: bool) -> Vec<Value> {
    if chat.is_empty() {
        return Vec::new();
    }
    let mut held = HELD_PLANS.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = Vec::new();
    let mut keep = Vec::new();
    for (c, input, at) in held.drain(..) {
        if c != chat || (!all && at.elapsed() < PLAN_HOLD) {
            keep.push((c, input, at));
            continue;
        }
        if state.stream_plans {
            continue;
        }
        match state.subagents.whose_plan(&chat_agents::plan_of(&input)) {
            Some(true) => out.push(input),
            Some(false) => {}
            None if all || at.elapsed() >= PLAN_VERIFY => crate::log::line("antigravity: a plan the chat's own conversation never gave, left out"),
            None => keep.push((c, input, at)),
        }
    }
    *held = keep;
    out
}

/// The chat an update_plan from lumo-hook belongs to: the one it names
/// (`LUMO_CHAT_ID`), else the only chat agy is answering. With none named and
/// several (or none) at work, nobody: the plan never lands in the chat on
/// screen, and agy's stream still brings it with its chat.
fn plan_chat(named: &str, at_work: &[String]) -> Option<String> {
    if !named.is_empty() {
        return Some(named.to_string());
    }
    let first = at_work.first()?;
    at_work.iter().all(|c| c == first).then(|| first.clone()).filter(|c| !c.is_empty())
}

/// A call of Lumo's update_plan tool, handed over by lumo-hook's MCP server
/// (`{"lumo_plan": {"input": …, "chat": …}}`, pipe.rs): its plan goes to the
/// Plan island, as the plan of the chat agy was started for (`LUMO_CHAT_ID`).
/// agy's stream says the same of its tool steps, but not of every build's
/// MCP calls: this is the way that always comes. A lumo-hook that got no
/// `LUMO_CHAT_ID` from agy names no chat (`plan_chat`).
pub fn serve_plan(app: &AppHandle, request: &Value) -> Value {
    let input = &request["input"];
    if !input["plan"].as_array().is_some_and(|p| !p.is_empty()) {
        return json!({ "error": "The plan needs at least one step." });
    }
    // A subagent's own plan: its row shows it (read from its transcript), never the chat.
    if input["agent"].as_str().is_some_and(|a| !a.trim().is_empty()) {
        return json!({ "text": "Plan shown to the user." });
    }
    let named = request["chat"].as_str().unwrap_or("");
    let at_work = AT_WORK.lock().unwrap_or_else(|e| e.into_inner()).clone();
    match plan_chat(named, &at_work) {
        // Its subagents at work: theirs come this way too, without `agent`
        // when one forgets it, and lumo-hook can't say whose it is. Held a
        // moment, it goes to the chat only if it is none of theirs (`release_plans`).
        Some(chat) if has_agents(&chat) => hold_plan(&chat, input.clone()),
        Some(chat) => emit_plan(app, &chat, "update_plan", input.clone()),
        None => crate::log::line("antigravity: a plan naming no chat, with no single chat at work, left out"),
    }
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
        permission_needed()
    } else if !stderr_tail.is_empty() {
        tf("Antigravity CLI gave no answer: {error}", &[("error", stderr_tail)])
    } else if denied > 0 {
        permission_needed()
    } else {
        t("Antigravity CLI gave no answer.")
    }
}

/// The error a `result` reported, for the island.
fn result_error(error: &str) -> String {
    if is_auth_error(error) {
        not_signed_in()
    } else if is_malformed_call(error) {
        with_agy_words(
            t("Antigravity CLI stopped: the model sent an empty tool call and couldn't correct it. What it did so far is saved: write “continue” to pick up from there."),
            error,
        )
    } else {
        tf("Antigravity CLI: {error}", &[("error", error)])
    }
}

/// agy at work for a chat: the process, its input (open while it may be
/// told more: a message, a subagent to stop) and its output, by lines.
struct Agy {
    child: std::process::Child,
    stdin: Option<std::process::ChildStdin>,
    /// When its input was closed: it ends by itself, or is ended AFTER_RESULT later.
    closed_at: Option<Instant>,
    /// Turns that ended before their result (`Ended::Early`): results still to come.
    owed: usize,
    rx: mpsc::Receiver<Vec<u8>>,
    /// The first 64 KB of its stderr, once it closed.
    err_text: mpsc::Receiver<String>,
    /// The agents the island asked to stop, not passed on yet; None once its
    /// input closed: nothing can be passed on, and the island is told so.
    stop_requests: Arc<Mutex<Option<Vec<String>>>>,
    _stopper: Option<StopperGuard>,
    /// The island chat it answers ("" for none).
    chat: String,
    /// What it was started with but its conversation: another message of the
    /// chat with the same key may go to it.
    key: String,
}

impl std::fmt::Debug for Agy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Agy").field("chat", &self.chat).field("open", &self.stdin.is_some()).finish()
    }
}

/// The first `cap` bytes `from` writes, as text. Not always UTF-8: cmd.exe
/// says what went wrong in the console's code page ("La riga di comando è
/// troppo lunga."), and a cap can cut a character in two: kept all the same,
/// as claude_code::read_stderr does, rather than lost whole.
fn first_text(from: &mut impl Read, cap: u64) -> String {
    let mut bytes = Vec::new();
    let _ = from.take(cap).read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

impl Agy {
    /// Its input closes: agy ends once it is done.
    fn close_input(&mut self) {
        if self.stdin.take().is_some() {
            self.closed_at = Some(Instant::now());
        }
        *self.stop_requests.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    /// Writes `line` on its input; false when it is closed or gone.
    fn write(&mut self, line: &str) -> bool {
        let Some(pipe) = self.stdin.as_mut() else { return false };
        pipe.write_all(line.as_bytes()).and_then(|_| pipe.flush()).is_ok()
    }
}

/// The key of a run with `args`: all of them but the conversation it resumes.
fn agy_key(exe: &Path, args: &[String], extra: &str) -> String {
    let mut parts = vec![exe.to_string_lossy().to_string(), extra.to_string()];
    let mut skip = false;
    for a in args {
        if std::mem::take(&mut skip) {
            continue;
        }
        if a == "--conversation" {
            skip = true;
            continue;
        }
        parts.push(a.clone());
    }
    parts.join("\n")
}

/// Starts agy headless in `dir` for the island chat `chat_id`.
fn start_agy(exe: &Path, args: &[String], dir: &Path, chat_id: &str, key: String) -> Result<Agy, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe);
    cmd.args(args).current_dir(dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
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
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take();
    let (err_tx, err_text) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(mut e) = stderr {
            s = first_text(&mut e, 64 * 1024);
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
    let stop_requests = Arc::new(Mutex::new(stdin.is_some().then(Vec::new)));
    let stopper = (!chat_id.is_empty()).then(|| {
        let q = stop_requests.clone();
        let id = chat_agents::register_stopper(
            chat_id,
            PROVIDER,
            Box::new(move |agent_id: &str| match q.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
                Some(requests) => {
                    requests.push(agent_id.to_string());
                    Ok(())
                }
                // Its input closed: agy can't be asked any more; it is ending, and its agents with it.
                None => Err(t("Antigravity is closing and can no longer stop one agent alone.")),
            }),
        );
        StopperGuard { chat: chat_id.to_string(), id }
    });
    Ok(Agy { child, stdin, closed_at: None, owed: 0, rx, err_text, stop_requests, _stopper: stopper, chat: chat_id.to_string(), key })
}

/// Where what a turn reads goes.
struct Sink<'a> {
    text: &'a mut dyn FnMut(&str),
    activity: &'a mut dyn FnMut(&Activity),
    file: &'a mut dyn FnMut(&FileTouch),
    plan: &'a mut dyn FnMut(&Value),
}

/// How reading a turn ended.
#[derive(Debug, PartialEq)]
enum Ended {
    /// Its result came: with subagents still at work, agy goes on (`may_linger`).
    Result,
    /// No result yet, but the answer is written and agy waits for its
    /// subagents (`answered_with_agents`): it goes on with them.
    Early,
    /// Stop: agy is to be ended.
    Stopped,
    /// agy's output closed (it ended), or it was ended AFTER_RESULT past its input.
    Closed,
    /// `leave` said to.
    Left,
}

/// How long the answer stays quiet, all its steps done and its subagents at
/// work, before it counts as written: agy waits for them (they wake it with
/// their messages), and the user can write again meanwhile.
const QUIET_ANSWER: Duration = Duration::from_secs(4);
/// How long agy still going with its subagents has to take a message up:
/// it says so at once (a step of its conversation for the message).
const NOT_TAKEN: Duration = Duration::from_secs(45);

/// Reads agy's output for one turn (or, lingering, for what it does by
/// itself) into `state`, until it ends as `Ended` says. `may_linger`: a
/// result (or an answer, `Early`) with subagents at work leaves agy going.
/// `leave`: asked each time round, to leave at once.
#[allow(clippy::too_many_arguments)]
fn drive(agy: &mut Agy, state: &mut Run, stop: &Stop, may_linger: bool, sink: &mut Sink, tell: &Tell, leave: &mut dyn FnMut(&Run) -> bool) -> Ended {
    let mut last_emit = Instant::now() - DELTA_INTERVAL;
    let mut unsent = false;
    let mut last_look = Instant::now();
    loop {
        if stop.is_stopped() && state.result.is_none() {
            return Ended::Stopped;
        }
        // The agents the island asked to stop: agy is asked to, while it can be told.
        let requested: Vec<String> = agy.stop_requests.lock().unwrap_or_else(|e| e.into_inner()).as_mut().map(std::mem::take).unwrap_or_default();
        if !requested.is_empty() && agy.stdin.is_some() {
            let mut changed = false;
            for agent_id in requested {
                if let Some(line) = state.subagents.stop_one(&agent_id) {
                    changed |= agy.write(&line);
                }
            }
            if changed {
                tell(&mut state.subagents.agents, false);
            }
        }
        // Its input closed: agy gets a moment to end, then it and what it
        // started are ended, at once on Stop. A process left holding its
        // output would otherwise keep the turn, and Stop, waiting for ever.
        if done_waiting(agy.closed_at, stop.is_stopped(), claude_code::AFTER_RESULT) {
            kill_tree(&mut agy.child);
            return Ended::Closed;
        }
        // The subagents' own work, from their transcripts, and the plans
        // held meanwhile (`serve_plan`).
        if last_look.elapsed() >= TRANSCRIPT_POLL {
            last_look = Instant::now();
            if state.subagents.read_transcripts().0 {
                tell(&mut state.subagents.agents, true);
                for file in state.take_files() {
                    (sink.file)(&file);
                }
            }
            for plan in release_plans(&agy.chat, state, false) {
                (sink.plan)(&plan);
            }
            // Any subagent this turn, at work or not: a plan that comes now may
            // still be one of theirs (one of theirs started last is read last).
            with_agents(&agy.chat, !state.subagents.spawns.is_empty());
        }
        // The answer is written and agy waits for its subagents: it goes on with them.
        if may_linger && state.result.is_none() && state.answered_with_agents(QUIET_ANSWER) {
            if unsent {
                (sink.text)(&state.shown);
            }
            return Ended::Early;
        }
        match agy.rx.recv_timeout(STOP_POLL) {
            Ok(line) => {
                unsent |= state.feed(&line);
                // The result of a turn that ended before it: in a turn of the
                // user's, none of its own (lingering, it ends what agy wrote by itself).
                if state.result.is_some() && agy.owed > 0 {
                    agy.owed -= 1;
                    if !state.own {
                        state.result = None;
                    }
                }
                tell(&mut state.subagents.agents, true);
                let activity = state.take_activity();
                if unsent && (activity.is_some() || last_emit.elapsed() >= DELTA_INTERVAL || state.result.is_some()) {
                    unsent = false;
                    last_emit = Instant::now();
                    (sink.text)(&state.shown);
                }
                if let Some(activity) = activity {
                    (sink.activity)(&activity);
                }
                for file in state.take_files() {
                    (sink.file)(&file);
                }
                if let Some(plan) = state.take_plan() {
                    (sink.plan)(&plan);
                }
                if state.result.is_some() && agy.closed_at.is_none() {
                    // Its subagents work on: agy too, its input open for what comes next.
                    if may_linger && state.subagents.spawns_open() {
                        return Ended::Result;
                    }
                    // The turn is over: agy may end.
                    agy.close_input();
                }
            }
            // Nothing more to read for now: it may be left.
            Err(mpsc::RecvTimeoutError::Timeout) => {
                state.agy_open = agy.stdin.is_some();
                if leave(state) {
                    return Ended::Left;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ended::Closed,
        }
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
    let agy = start_agy(&exe, &args, &dir, chat_id, String::new())?;
    let mut sink = Sink { text: &mut on_text, activity: &mut on_activity, file: &mut on_file, plan: &mut on_plan };
    // A run of its own (a command): no conversation to keep subagents for.
    agy_turn(agy, input, Run::default(), &stop, false, &mut sink, tell, None).map_err(|(e, _)| e)
}

/// A turn that failed: why, and the subagents it had, kept for the next
/// turn of the same conversation (Ask on their rows still reaches them).
type TurnFailed = (String, Box<Subagents>);

/// One turn of agy (`agy`: started for it, or one still at work for the
/// chat): `input` goes on its input, its output is read (`drive`) into a run
/// that starts from `state`. With `may_linger`, a turn that ends while its
/// subagents work leaves agy going with them: the run carries it (`agy`).
/// `again`: agy was still going with its subagents; should it never take
/// the message up (nothing of the chat's own conversation comes in
/// NOT_TAKEN), it ends and `again` starts a new one for it.
#[allow(clippy::too_many_arguments)]
fn agy_turn(mut agy: Agy, input: String, mut state: Run, stop: &Stop, may_linger: bool, sink: &mut Sink, tell: &Tell, again: Option<&dyn Fn() -> Result<Agy, String>>) -> Result<Run, TurnFailed> {
    let mut ended = Ended::Left;
    if agy.write(&input) {
        let sent = Instant::now();
        let mut not_taken = |run: &Run| again.is_some() && run.last_main.is_none() && run.result.is_none() && sent.elapsed() >= NOT_TAKEN;
        ended = drive(&mut agy, &mut state, stop, may_linger, sink, tell, &mut not_taken);
    }
    if ended == Ended::Left {
        // It never took the message (or could not be told): a new agy answers it,
        // and what the old one still had at work ends with it.
        agy.close_input();
        kill_tree(&mut agy.child);
        state.subagents.run_ended(AgentState::Failed);
        tell(&mut state.subagents.agents, false);
        let Some(again) = again else { return Err((t("Antigravity CLI didn't answer."), Box::new(std::mem::take(&mut state.subagents)))) };
        crate::log::line("antigravity: agy at work with its subagents did not take the message; a new one answers it");
        let agy = match again() {
            Ok(agy) => agy,
            Err(e) => return Err((e, Box::new(std::mem::take(&mut state.subagents)))),
        };
        return agy_turn(agy, input, Run { subagents: std::mem::take(&mut state.subagents), ..Run::default() }, stop, may_linger, sink, tell, None);
    }
    if ended == Ended::Stopped {
        agy.close_input();
        kill_tree(&mut agy.child);
        state.stopped = true;
        state.subagents.run_ended(AgentState::Stopped);
        tell(&mut state.subagents.agents, false);
        with_agents(&agy.chat, false);
        return Ok(state);
    }
    if matches!(ended, Ended::Result | Ended::Early) {
        // The answer is in, its subagents work on: so does agy, after it.
        if ended == Ended::Early {
            state.result = Some(Ok(String::new()));
            agy.owed += 1;
        }
        state.agy = Some(Box::new(agy));
        return Ok(state);
    }
    if let Err(e) = finish(agy, &mut state, sink, tell) {
        return Err((e, Box::new(std::mem::take(&mut state.subagents))));
    }
    Ok(state)
}

/// agy ended (or is ended): what its subagents wrote last, their end, and why
/// a run without a result failed.
fn finish(mut agy: Agy, state: &mut Run, sink: &mut Sink, tell: &Tell) -> Result<(), String> {
    agy.close_input();
    // What they wrote last (their answer comes a moment after their report), to the end.
    for _ in 0..64 {
        if !state.subagents.read_transcripts().1 {
            break;
        }
    }
    for file in state.take_files() {
        (sink.file)(&file);
    }
    for plan in release_plans(&agy.chat, state, true) {
        (sink.plan)(&plan);
    }
    // agy is over: a subagent can't outlive it.
    state.subagents.run_ended(if matches!(state.result, Some(Ok(_))) { AgentState::Done } else { AgentState::Failed });
    tell(&mut state.subagents.agents, false);
    with_agents(&agy.chat, false);
    let status = if state.result.is_some() {
        // Ended already, or its output closed with the answer in: it may not
        // be gone yet, and is not waited for past AFTER_RESULT.
        claude_code::end_after_result(&mut agy.child, &Stop::default(), claude_code::AFTER_RESULT)
    } else {
        agy.child.wait().ok()
    };
    // A process agy left behind may still hold stderr: what was read by then.
    let stderr = agy.err_text.recv_timeout(STDERR_WAIT).unwrap_or_default();
    state.denied += stderr_denials(&stderr);
    state.stderr_tail = stderr_tail(&stderr);
    if state.result.is_none() {
        let code = status.and_then(|s| s.code()).map(|c| c.to_string()).unwrap_or_default();
        return Err(failure(&stderr, &code));
    }
    if let Some(line) = &state.failed_line {
        crate::log::line(format!("antigravity: the turn ended with an error: {line}"));
    }
    // `result.usage` sums every step and subagent of the turn; prefer the main
    // transcript's latest model step for the actual context window in use.
    if let Some(used) = state.conversation.as_deref().and_then(transcript_context_tokens) {
        state.context_used = Some(used);
    }
    Ok(())
}

// ── agy going on with its subagents ──────────────────────────────────────────
//
// agy's subagents work in the background: the one that started them ends its
// turn, and their messages wake it later. The chat's answer ends with the
// turn (or once it is written and agy only waits, `Ended::Early`), and agy
// goes on with them here, between two messages of the chat, as Claude Code
// does (concepts/sotto-agenti-completo): their rows keep moving, what agy
// writes when they wake it joins the chat (`own_answer`), Stop on a row
// still reaches it. The chat's next message goes to it (`take_lingering`);
// with other settings, it would end them: not without the user (WOULD_STOP).
// Once its subagents are all done and it is quiet, its input closes and it ends.

/// How long agy stays quiet with no subagent at work before its input closes.
const LINGER_QUIET: Duration = Duration::from_secs(15);
/// How often agy's transcript is looked at while it says a turn it took
/// up by itself is under way.
const WOKEN_TURN_POLL: Duration = Duration::from_secs(2);

/// A chat's agy going on with its subagents.
struct Lingering {
    key: String,
    conversation: String,
    /// The chat's next message wants it (handed back on `back`), or the
    /// chat ends it (`end`).
    want: Arc<std::sync::atomic::AtomicBool>,
    end: Arc<Stop>,
    back: mpsc::Receiver<(Agy, Subagents)>,
    /// Its subagents still at work.
    open: Arc<std::sync::atomic::AtomicUsize>,
}

static LINGERING: Mutex<Option<HashMap<String, Lingering>>> = Mutex::new(None);

fn lingering<T>(f: impl FnOnce(&mut HashMap<String, Lingering>) -> T) -> T {
    f(LINGERING.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new))
}

/// What the chat's next message finds of its agy: one to answer it (the
/// same settings, the same conversation), handed back once agy is not
/// writing by itself; `Err(WOULD_STOP)` when a new one would end subagents
/// at work and the user did not say to; else nothing (one still going ends).
fn take_lingering(chat_id: &str, key: &str, conversation: Option<&str>, stop: &Stop) -> Result<Option<(Agy, Subagents)>, String> {
    let Some(l) = lingering(|all| all.remove(chat_id)) else { return Ok(None) };
    let same = l.key == key && Some(l.conversation.as_str()) == conversation;
    if !same {
        let open = l.open.load(std::sync::atomic::Ordering::SeqCst);
        if let Some(open) = chat_agents::in_the_way(chat_id, open) {
            lingering(|all| all.insert(chat_id.to_string(), l));
            return Err(chat_agents::would_stop(open));
        }
        l.end.stop();
        return Ok(None);
    }
    l.want.store(true, std::sync::atomic::Ordering::SeqCst);
    loop {
        match l.back.recv_timeout(STOP_POLL) {
            Ok(got) => return Ok(Some(got)),
            // It ended meanwhile: a new one answers.
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(None),
            Err(mpsc::RecvTimeoutError::Timeout) if stop.is_stopped() => {
                l.want.store(false, std::sync::atomic::Ordering::SeqCst);
                // Handed back just now: it goes on as it was.
                if let Ok((agy, subagents)) = l.back.try_recv() {
                    drop(l);
                    return Ok(Some((agy, subagents)));
                }
                lingering(|all| all.insert(chat_id.to_string(), l));
                return Ok(None);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

/// Ends the chat's agy still going with its subagents (a new chat, a deleted one, an edited question).
pub fn close(chat_id: &str) {
    if let Some(l) = lingering(|all| all.remove(chat_id)) {
        l.end.stop();
    }
}

/// agy goes on with its subagents for chat `chat_id`, in conversation
/// `conversation`, on a thread of its own (`linger`).
fn keep_going(app: &AppHandle, chat_id: &str, conversation: &str, agy: Agy, mut subagents: Subagents, tell: Tell) {
    // Their turn is over: they work in the background.
    let open = subagents.agents.open_ids();
    for id in &open {
        if let Some(row) = subagents.agents.touch(id) {
            row.background = true;
        }
    }
    tell(&mut subagents.agents, false);
    let want = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let end = Arc::new(Stop::default());
    let count = Arc::new(std::sync::atomic::AtomicUsize::new(open.len()));
    let (tx, back) = mpsc::channel();
    let l = Lingering { key: agy.key.clone(), conversation: conversation.to_string(), want: want.clone(), end: end.clone(), back, open: count.clone() };
    if let Some(old) = lingering(|all| all.insert(chat_id.to_string(), l)) {
        old.end.stop();
    }
    let app = app.clone();
    let chat_id = chat_id.to_string();
    let conversation = conversation.to_string();
    std::thread::spawn(move || {
        let events = chat::ChatEvents::new(&chat_id);
        let mut on_text = |_: &str| {};
        let mut on_activity = |_: &Activity| {};
        let mut on_file = |file: &FileTouch| events.file(&app, file);
        let mut on_plan = |plan: &Value| emit_plan(&app, &chat_id, "update_plan", plan.clone());
        let mut sink = Sink { text: &mut on_text, activity: &mut on_activity, file: &mut on_file, plan: &mut on_plan };
        let mut own = |text: &str| own_answer(&app, &chat_id, &conversation, text);
        let subagents = linger(&chat_id, &conversation, agy, subagents, &tell, &want, end, &count, tx, &mut sink, &mut own);
        if let Some(subagents) = subagents {
            save_chat_subagents(&chat_id, &conversation, subagents);
        }
    });
}

/// agy going on with its subagents (`keep_going`): what it writes by itself
/// goes to `own`, until the chat's next message wants it (then it goes back
/// to it on `back`, with its subagents), the chat ends it (`end`), or it ends
/// once quiet with none at work. Its subagents, when it ended.
#[allow(clippy::too_many_arguments)]
fn linger(
    chat_id: &str,
    conversation: &str,
    mut agy: Agy,
    subagents: Subagents,
    tell: &Tell,
    want: &std::sync::atomic::AtomicBool,
    end: Arc<Stop>,
    count: &std::sync::atomic::AtomicUsize,
    back: mpsc::Sender<(Agy, Subagents)>,
    sink: &mut Sink,
    own: &mut dyn FnMut(&str),
) -> Option<Subagents> {
    use std::sync::atomic::Ordering;
    let mut state = Run::lingering(subagents, conversation);
    // What agy last wrote to the chat: a result that repeats it is no news.
    let mut said = String::new();
    let mut quiet = Instant::now();
    // When its transcript was last seen to say its turn is under way.
    let mut busy_seen: Option<Instant> = None;
    loop {
        let mut leave = |run: &Run| {
            let open = run.subagents.spawns_open();
            count.store(run.subagents.agents.open(), Ordering::SeqCst);
            if open || !run.idle() {
                quiet = Instant::now();
            }
            // Not while it writes by itself: the message goes once it is done.
            let ready = run.agy_open && run.idle() && (want.load(Ordering::SeqCst) || (!open && quiet.elapsed() >= LINGER_QUIET));
            if !ready {
                return false;
            }
            // Nor while a subagent's message woke it and the model thinks
            // between two steps, which agy's stream says nothing of: closing
            // its input then ends agy mid-turn, and the parent never goes on
            // with its subagents' reports. Its transcript says (looked at
            // now and then, not at each poll).
            if busy_seen.is_some_and(|at| at.elapsed() < WOKEN_TURN_POLL) {
                return false;
            }
            if woken_turn_under_way(conversation) {
                busy_seen = Some(Instant::now());
                quiet = Instant::now();
                return false;
            }
            busy_seen = None;
            true
        };
        let ended = drive(&mut agy, &mut state, &end, true, sink, tell, &mut leave);
        // What it wrote by itself, woken by its subagents: to the chat.
        if matches!(ended, Ended::Result | Ended::Early | Ended::Closed) {
            if let Some(text) = own_text(&mut state, &mut said) {
                own(&text);
            }
        }
        match ended {
            Ended::Result | Ended::Early => {
                if ended == Ended::Early {
                    agy.owed += 1;
                }
                state = state.next_turn();
            }
            Ended::Left if want.load(Ordering::SeqCst) && agy.stdin.is_some() => {
                lingering(|all| {
                    if all.get(chat_id).is_some_and(|l| Arc::ptr_eq(&l.end, &end)) {
                        all.remove(chat_id);
                    }
                });
                let _ = back.send((agy, std::mem::take(&mut state.subagents)));
                return None;
            }
            // Nothing at work, all quiet: its input closes, and it ends.
            Ended::Left => {
                agy.close_input();
                state = state.next_turn();
            }
            Ended::Stopped => {
                agy.close_input();
                kill_tree(&mut agy.child);
                state.subagents.run_ended(AgentState::Stopped);
                break;
            }
            Ended::Closed => {
                let _ = finish(agy, &mut state, sink, tell);
                break;
            }
        }
    }
    tell(&mut state.subagents.agents, false);
    with_agents(chat_id, false);
    // No message can go to it now: the next one starts agy again.
    lingering(|all| {
        if all.get(chat_id).is_some_and(|l| Arc::ptr_eq(&l.end, &end)) {
            all.remove(chat_id);
        }
    });
    Some(std::mem::take(&mut state.subagents))
}

/// What agy wrote by itself since it last went to the chat; None when it
/// wrote nothing new (a result that repeats it).
fn own_text(state: &mut Run, said: &mut String) -> Option<String> {
    let text = match state.result.take() {
        Some(Ok(text)) => chat::keep_lumo_lines(chat::turn_answer(&state.shown, &state.visible, &text), &state.said),
        _ => state.shown.trim().to_string(),
    };
    let text = text.trim().to_string();
    if text.is_empty() || text == *said || said.ends_with(&text) {
        return None;
    }
    *said = text.clone();
    Some(text)
}

/// What agy wrote by itself in the chat `chat_id`, woken by its subagents:
/// it joins the chat's last answer, here (chat.rs `add_own`) and on the
/// island (`chat-own-answer`), as Claude Code's do.
fn own_answer(app: &AppHandle, chat_id: &str, conversation: &str, text: &str) {
    let mut cli = None;
    if let Some(chat) = tauri::Manager::try_state::<chat::Chats>(app).and_then(|c| c.find(chat_id)) {
        chat.add_own(PROVIDER, Some(conversation), text);
        cli = chat.cli_state();
    }
    let _ = app.emit_to(crate::island::WINDOW_LABEL, "chat-own-answer", json!({ "chat": chat_id, "text": text, "session": conversation, "cli": cli }));
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
        if let Some(m) = safe_model(id).filter(|m| m.chars().any(|c| c.is_ascii_digit()) || is_orchestrator_row(m)) {
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

/// The names `agy models` gives its models beside their ids, in a table
/// (`gemini-4-neon-high   Gemini 4 Neon (High)`) or as JSON (`name`, `label`):
/// what agy's settings take for Orchestrator's planner and executor.
fn parse_labels(text: &str) -> Vec<(String, String)> {
    let clean = |label: &str| {
        let label = label.trim();
        (!label.is_empty() && label.len() <= 80 && label.chars().all(|c| !c.is_control() && c != '"' && c != '\\')).then(|| label.to_string())
    };
    let mut out = Vec::new();
    if let Ok(v) = serde_json::from_str::<Value>(text.trim()) {
        let list = v.as_array().or_else(|| v.get("models").and_then(Value::as_array));
        for item in list.into_iter().flatten() {
            let id = ["id", "slug", "model"].iter().find_map(|k| item.get(*k).and_then(Value::as_str)).and_then(safe_model);
            let label = ["label", "name", "display_name"].iter().find_map(|k| item.get(*k).and_then(Value::as_str)).and_then(clean);
            if let (Some(id), Some(label)) = (id, label) {
                out.push((id.to_string(), label));
            }
        }
        return out;
    }
    for line in text.lines() {
        let line = line.trim();
        let Some(split) = line.find(|c: char| c.is_whitespace()) else { continue };
        let (id, rest) = line.split_at(split);
        if let (Some(id), Some(label)) = (safe_model(id), clean(rest)) {
            out.push((id.to_string(), label));
        }
    }
    out
}

/// The names of agy's models by their ids, from the last `agy models`.
static LABELS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn label_of(id: &str) -> Option<String> {
    LABELS.lock().unwrap_or_else(|e| e.into_inner()).as_ref()?.get(id).cloned()
}

/// Runs `agy models`, for at most MODELS_TIMEOUT. Nothing on any failure.
/// The names it gives its models are kept (LABELS).
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
    let text = reader.text_after_exit();
    let labels = parse_labels(&text);
    if !labels.is_empty() {
        *LABELS.lock().unwrap_or_else(|e| e.into_inner()) = Some(labels.into_iter().collect());
    }
    parse_models(&text)
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/// One of agy's Orchestrator rows (`gemini-pro-orchestrator-neon`): one per
/// planner, the executor never in it, and no digit (the single model it once
/// was, `gemini-pro-orchestrator-g1-pro`, is a model of its own).
fn is_orchestrator_row(id: &str) -> bool {
    id.split('-').any(|w| w == "orchestrator") && !id.chars().any(|c| c.is_ascii_digit())
}

/// The picker's Orchestrator pick, `orchestrator:<planner>:<executor>` (the
/// ids of `agy models`, src/core/orchestrator.ts): its two ids, each checked.
fn orchestration(model: &str) -> Option<(&str, &str)> {
    let rest = model.trim().strip_prefix("orchestrator:")?;
    let (planner, executor) = rest.split_once(':')?;
    Some((safe_model(planner)?, safe_model(executor).filter(|e| !e.contains(':'))?))
}

/// What runs an Orchestrator pick: agy's Orchestrator row for its planner
/// (`Orchestrator (Neon)` for `Gemini 4 Neon (High)`), else its first, and
/// the settings for this run only (`--settings`, never saved) naming the
/// planner and the executor as agy's own settings do. No settings when a name
/// is unknown: agy's own choice then.
fn orchestrator_run(planner: &str, executor: &str, labels: &HashMap<String, String>) -> (String, Option<String>) {
    let mut rows: Vec<(&String, &String)> = labels.iter().filter(|(id, _)| is_orchestrator_row(id)).collect();
    rows.sort();
    let planner_name = labels.get(planner);
    let family = |label: &str| label.split('(').next().unwrap_or("").trim().rsplit(' ').next().unwrap_or("").to_string();
    let row = planner_name
        .and_then(|p| {
            let word = family(p);
            rows.iter().find(|(_, label)| label.split(['(', ')']).nth(1).is_some_and(|w| w.trim() == word))
        })
        .or(rows.first())
        .map(|(id, _)| id.to_string())
        .unwrap_or_else(|| "gemini-pro-orchestrator".to_string());
    let settings = match (planner_name, labels.get(executor)) {
        (Some(p), Some(e)) => Some(json!({ "orchestrator": { "planner": p, "executor": e } }).to_string()),
        _ => None,
    };
    (row, settings)
}

/// The names of `model`'s planner and executor, asked of agy when they are
/// not known yet (Lumo started since the picker last listed them). Blocks.
fn orchestrator_labels(model: &str) {
    let Some((planner, executor)) = orchestration(model) else { return };
    if label_of(planner).is_some() && label_of(executor).is_some() {
        return;
    }
    if let Some(exe) = platform::agy_candidates().into_iter().next() {
        list_models(exe);
    }
}

/// How the island says who is at work during an Orchestrator turn: the
/// planner until agy leaves plan mode, the executor after; any other step as it is.
struct Phases {
    planner: String,
    executor: String,
    executing: bool,
}

impl Phases {
    fn of(model: &str) -> Option<Phases> {
        let (planner, executor) = orchestration(model)?;
        Some(Phases { planner: role_name(planner), executor: role_name(executor), executing: false })
    }

    fn map(&mut self, activity: &Activity) -> Activity {
        if activity.kind == "plan" && activity.detail == PLAN_EXIT {
            self.executing = true;
        }
        if activity.kind != "thinking" {
            return activity.clone();
        }
        let line = if self.executing {
            tf("{model} is executing…", &[("model", &self.executor)])
        } else {
            tf("{model} is planning…", &[("model", &self.planner)])
        };
        Activity::new("step", line)
    }
}

/// A planner's or executor's name beside the other's: Gemini 4's by their own
/// ("Neon"), the others without whose they are ("Sonnet 5.5"), no effort.
fn role_name(id: &str) -> String {
    let name = label_of(id).unwrap_or_else(|| id.to_string());
    let name = name.split('(').next().unwrap_or("").trim();
    let name = name.strip_prefix("Gemini 4 ").or_else(|| name.strip_prefix("Claude ")).unwrap_or(name);
    if name.is_empty() { id.to_string() } else { name.to_string() }
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

/// Subagents kept per chat across turns (along with its conversation id), so
/// Ask in a later turn can reach an earlier subagent and follow its transcript.
/// With when they were kept: past MAX_CHAT_SUBAGENTS chats, the oldest go first.
static CHAT_SUBAGENTS: Mutex<Option<HashMap<String, KeptSubagents>>> = Mutex::new(None);
/// A chat's subagents kept: its conversation, them, and when they were kept.
type KeptSubagents = (String, Subagents, Instant);
const MAX_CHAT_SUBAGENTS: usize = 64;

fn take_chat_subagents(chat_id: &str, conversation: Option<&str>) -> Option<Subagents> {
    let conv = conversation?;
    let mut all = CHAT_SUBAGENTS.lock().unwrap_or_else(|e| e.into_inner());
    let map = all.as_mut()?;
    if map.get(chat_id).is_some_and(|(c, _, _)| c == conv) {
        map.remove(chat_id).map(|(_, s, _)| s)
    } else {
        None
    }
}

fn save_chat_subagents(chat_id: &str, conversation: &str, subagents: Subagents) {
    if chat_id.is_empty() || conversation.is_empty() || subagents.spawns.is_empty() {
        return;
    }
    let mut all = CHAT_SUBAGENTS.lock().unwrap_or_else(|e| e.into_inner());
    let map = all.get_or_insert_with(HashMap::new);
    if map.len() >= MAX_CHAT_SUBAGENTS && !map.contains_key(chat_id) {
        if let Some(oldest) = map.iter().min_by_key(|(_, (_, _, kept))| *kept).map(|(id, _)| id.clone()) {
            map.remove(&oldest);
        }
    }
    map.insert(chat_id.to_string(), (conversation.to_string(), subagents, Instant::now()));
}

/// Replaces internal `agy-...` row ids in an Ask prompt with the real
/// subagent conversation id or swarm worker name that `agy` knows.
fn rewrite_ask_ids(query: &str, subagents: Option<&Subagents>) -> String {
    let Some(sub) = subagents else { return query.to_string() };
    let mut out = query.to_string();
    for spawn in &sub.spawns {
        let Some(target) = spawn.conversation.as_deref().or(spawn.name.as_deref()) else { continue };
        if spawn.row != target && names(&out, &spawn.row) {
            out = replace_whole(&out, &spawn.row, target);
        }
    }
    out
}

/// One chat turn through Antigravity CLI.
#[allow(clippy::too_many_arguments)]
pub async fn send(
    app: &AppHandle,
    chat: &Chat,
    model: &str,
    mode: &str,
    computer: bool,
    browser: bool,
    query: String,
    context: Option<ChatContext>,
    folder: Option<String>,
) -> Result<ChatReply, String> {
    let exe = platform::agy_candidates().into_iter().next().ok_or_else(|| chat_error(not_installed()))?;
    if let Some(name) = command_of(&query) {
        return command(app, chat, exe, name, model, mode, folder).await;
    }

    let turn = chat.begin(PROVIDER);
    // Only an Antigravity conversation: never a Claude Code session.
    let conversation = chat.cli_session_for(PROVIDER);
    let seeded_subagents = take_chat_subagents(chat.id(), conversation.as_deref());
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
    // Computer use: the note in front of the question, whole the first time
    // this conversation hears it, then a short reminder.
    let computer = computer && cfg!(windows);
    let grid = crate::computer::uses_grid(PROVIDER, model);
    let text = if computer {
        crate::computer::with_note(&text, grid, !crate::computer::note_heard(chat.id(), conversation.as_deref(), grid))
    } else {
        text
    };
    // This chat's folder of the inbox, or all of it with "Other chats' files" on.
    let inbox = crate::files::cli_inbox(chat.id(), crate::settings::load().chat_other_files);
    let work = claude_code::work_dir();
    let picked = model.to_string();
    let _ = tauri::async_runtime::spawn_blocking(move || orchestrator_labels(&picked)).await;
    let args = args(model, mode, conversation.as_deref(), &work.to_string_lossy(), &inbox, &chat.cli_dirs(folder));
    // Orchestrator: who is at work, the planner or the executor, said on the island.
    let mut phases = Phases::of(model);
    // Lumo's plan tool, its email tools while the Email pill is on and Security
    // lets the AI read it (only during this turn), and the user's tools that are on (each call asks on the island).
    let tools = tauri::async_runtime::spawn_blocking(crate::tools::any_enabled).await.unwrap_or(false);
    let mail = crate::mail::ai_tools(app);
    // What it starts with: the same, agy still going with its subagents answers this message too.
    let key = agy_key(&exe, &args, &format!("{mail}|{tools}|{computer}|{browser}"));
    crate::computer::agy_workspace(&work, mail, tools, computer, browser);
    let mail_turn = crate::mail::agent_turn();
    // The computer usable while this turn runs, each action asked for by Lumo.
    let computer_turn = computer.then(|| crate::computer::OtherTurn::begin(app, PROVIDER, chat.id(), "antigravity", mode, grid));
    // Lumo's browser: what changes a page asks on Lumo's card while this turn runs.
    let browser_turn = browser.then(|| crate::browser::AskTurn::begin(PROVIDER, chat.id(), "antigravity", mode));

    let app2 = app.clone();
    let events = chat.events();
    let stop = chat.stopper();
    let chat_id = chat.id().to_string();
    let usage_chat = chat_id.clone();
    // For a plan of Lumo's update_plan that names no chat (serve_plan).
    let _at_work = AtWork::start(&chat_id);
    // The subagents agy delegates to, and the turn's sign of life.
    let tell = chat_agents::teller(app, chat.id(), PROVIDER);
    let tell2 = tell.clone();
    let conversation2 = conversation.clone();
    let state = tauri::async_runtime::spawn_blocking(move || -> Result<Run, (String, Option<Box<Subagents>>)> {
        let conversation = conversation2;
        // agy's plan, for the Plan island (src/island/plan.ts): what it gives
        // Lumo's update_plan tool, as it goes. A checklist in its answer is
        // its plan only while it has not called the tool.
        let emit = |tool: &str, input: Value| emit_plan(&app2, &chat_id, tool, input);
        let by_tool = std::cell::Cell::new(false);
        let mut plan_sent = String::new();
        // agy still going with its subagents answers it, else a new one.
        let start = || start_agy(&exe, &args, &work, &chat_id, key.clone());
        // A turn that can't start hands the kept subagents back.
        let lingering = match take_lingering(&chat_id, &key, conversation.as_deref(), &stop) {
            Ok(lingering) => lingering,
            Err(e) => return Err((e, seeded_subagents.map(Box::new))),
        };
        let (agy, seeded, reused) = match lingering {
            Some((agy, subagents)) => (agy, Some(subagents), true),
            None => match start() {
                Ok(agy) => (agy, seeded_subagents, false),
                Err(e) => return Err((e, seeded_subagents.map(Box::new))),
            },
        };
        // Ask on a row names it by its row: agy knows it by its conversation.
        let input = user_event(&rewrite_ask_ids(&text, seeded.as_ref()));
        let mut on_text = |text: &str| {
            events.delta(&app2, text);
            if let Some(list) = checklist(text).filter(|_| !by_tool.get()) {
                if list != plan_sent {
                    emit("Checklist", json!({ "text": list }));
                    plan_sent = list;
                }
            }
        };
        let mut on_activity = |activity: &Activity| match phases.as_mut() {
            Some(phases) => events.activity(&app2, phases.map(activity)),
            None => events.activity(&app2, activity),
        };
        let mut on_file = |file: &FileTouch| events.file(&app2, file);
        let mut on_plan = |plan: &Value| {
            by_tool.set(true);
            emit("update_plan", plan.clone());
        };
        let mut sink = Sink { text: &mut on_text, activity: &mut on_activity, file: &mut on_file, plan: &mut on_plan };
        let state = Run { subagents: seeded.unwrap_or_default(), ..Run::default() };
        agy_turn(agy, input, state, &stop, true, &mut sink, &tell2, reused.then_some(&start as &dyn Fn() -> Result<Agy, String>)).map_err(|(e, subagents)| (e, Some(subagents)))
    })
    .await
    .map_err(|e| (e.to_string(), None))
    .and_then(|r| r);
    // What the turn did on the computer, for under its answer (as Claude
    // Code's). Subagents still at work keep the computer, the email tools
    // and the browser's cards, with the same rules, until the last ends.
    let recap = computer_turn.and_then(|t| t.finish(matches!(&state, Ok(s) if s.stopped)));
    let _ = chat_agents::keep_while_agents(chat.id(), mail_turn);
    if let Some(browser_turn) = browser_turn {
        let _ = chat_agents::keep_while_agents(chat.id(), browser_turn);
    }
    let plain = chat::plain_question(true, context.as_ref(), &query);
    // It failed after using the computer: the turn is kept as an empty answer
    // that says why, so the recap of what was done on the screen is shown and
    // saved under it (and the next turn knows it was done).
    let failed = |error: String, recap: Option<Value>| -> Result<ChatReply, String> {
        let Some(recap) = recap else { return Err(chat_error(error)) };
        chat.commit(&turn, json!({ "role": "user", "content": plain }), json!({ "role": "assistant", "content": chat::NO_ANSWER }), &plain, chat::NO_ANSWER);
        Ok(ChatReply { computer: Some(recap), ..ChatReply::no_answer(error, chat.cli_session()) })
    };
    let mut state = match state {
        Ok(state) => state,
        Err((e, subagents)) => {
            // The conversation stays the chat's: its subagents stay with it.
            if let (Some(conversation), Some(subagents)) = (&conversation, subagents) {
                save_chat_subagents(chat.id(), conversation, *subagents);
            }
            return failed(e, recap);
        }
    };

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
        // The conversation has the whole note of computer use now.
        if computer {
            crate::computer::note_given(chat.id(), id, grid);
        }
        match state.agy.take() {
            // Its subagents work on, and agy with them.
            Some(agy) => keep_going(app, chat.id(), id, *agy, std::mem::take(&mut state.subagents), tell.clone()),
            None => save_chat_subagents(chat.id(), id, std::mem::take(&mut state.subagents)),
        }
    }
    // No conversation to go on in: agy ends, and its subagents with it.
    if let Some(mut agy) = state.agy.take() {
        agy.close_input();
        kill_tree(&mut agy.child);
        state.subagents.run_ended(AgentState::Failed);
        tell(&mut state.subagents.agents, false);
        with_agents(chat.id(), false);
    }
    // Stopped before agy named the conversation: the one it resumed is still
    // the chat's, and keeps its subagents for the next turn.
    if state.conversation.is_none() {
        if let Some(conversation) = &conversation {
            save_chat_subagents(chat.id(), conversation, std::mem::take(&mut state.subagents));
        }
    }
    if state.stopped {
        let shown = state.shown.trim().to_string();
        if !shown.is_empty() {
            chat.commit(&turn, json!({ "role": "user", "content": plain }), json!({ "role": "assistant", "content": shown }), &plain, &shown);
        } else if recap.is_some() {
            // Stopped before it wrote anything, but it used the computer: the
            // turn is kept, as an empty answer, so the recap has an answer to
            // go under and the next turn knows what was done.
            chat.commit(&turn, json!({ "role": "user", "content": plain }), json!({ "role": "assistant", "content": chat::NO_ANSWER }), &plain, chat::NO_ANSWER);
            return Ok(ChatReply { computer: recap, kept: Some(chat::NO_ANSWER.into()), ..ChatReply::stopped(String::new(), chat.cli_session()) });
        }
        return Ok(ChatReply { computer: recap, ..ChatReply::stopped(shown, chat.cli_session()) });
    }
    let mut warning = None;
    let answer = match state.result {
        // The result repeats the last step; every step it wrote goes before
        // it, so none disappears once the answer is saved (empty: what was streamed).
        Some(Ok(text)) => chat::turn_answer(&state.shown, &state.visible, &text),
        // An error with an answer written: the answer stays, the error is
        // said under it (kept_answer). Without one, or signed out, the error alone.
        Some(Err(e)) => {
            let Some(written) = kept_answer(&e, &state.failed_response, &state.visible).map(|w| chat::turn_answer(&state.shown, &state.visible, &w)) else {
                return failed(result_error(&e), recap);
            };
            warning = Some(answer_warning(&e));
            written
        }
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
    let fix = needs_hooks(state.denied, &state.stderr_tail, crate::agents::antigravity_cards_ready()).then_some(chat::FIX_AGY_HOOKS);
    Ok(ChatReply { warning, fix, computer: recap, ..ChatReply::answer(answer, chat.cli_session()) })
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
    // A command's turn tells the conversation nothing it missed (/usage
    // never goes to it): that waits for its next question.
    let turn = chat.begin_aside(PROVIDER);
    let query = format!("/{name}");
    let work = claude_code::work_dir();
    let answer = if name == COMPACT {
        let Some(conversation) = chat.cli_session_for(PROVIDER) else {
            // A new conversation would take it for a question.
            return Ok(ChatReply::answer(t("Send a message first: Antigravity CLI hasn't seen this conversation yet."), chat.cli_session()));
        };
        let inbox = crate::files::cli_inbox(chat.id(), crate::settings::load().chat_other_files);
        let picked = model.to_string();
        let _ = tauri::async_runtime::spawn_blocking(move || orchestrator_labels(&picked)).await;
        let mut args = args(model, mode, Some(conversation.as_str()), &work.to_string_lossy(), &inbox, &chat.cli_dirs(folder));
        args.retain(|a| a != "--disable-slash-commands");
        let events = chat.events();
        let app2 = app.clone();
        let stop = chat.stopper();
        let chat_id = chat.id().to_string();
        let input = user_event(&query);
        // A set of its own: the agents of the chat's turns lingering on are not this command's.
        let tell = chat_agents::teller(app, chat.id(), "antigravity-cli-command");
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
    // No chat's: the inbox only with "Other chats' files" on.
    let inbox = if crate::settings::load().chat_other_files { crate::files::inbox_dir().to_string_lossy().to_string() } else { String::new() };
    orchestrator_labels(model);
    let args = args(model, mode, None, &work.to_string_lossy(), &inbox, &folders);
    crate::computer::agy_workspace(&work, mail, crate::tools::any_enabled(), false, false);
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
    complete_in("tool-review", model, prompt, Arc::new(Stop::default()))
}

/// `complete`, in the folder `work` of its own under Lumo's local data (a
/// chat's name, chat_title.rs); `stop` ends it early.
pub(crate) fn complete_in(work: &str, model: &str, prompt: &str, stop: Arc<Stop>) -> Result<String, String> {
    let exe = platform::agy_candidates().into_iter().next().ok_or_else(not_installed)?;
    let work = platform::local_dir().join(work);
    let dir = work.to_string_lossy().to_string();
    let args = args_with_cards(model, "plan", None, &dir, &dir, &[], false);
    let state = run(exe, args, user_event(prompt), work, "", stop, |_| {}, |_| {}, |_| {}, |_| {}, &chat_agents::silent())?;
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

    /// A subagent's message woke the parent (concepts: the real run of
    /// 24 Nov., agy 1.5.16): its transcript ends on that message, a tool's
    /// result or a step that calls tools while the model thinks, and agy's
    /// stream is quiet. Its input must not close then: agy would end mid-turn
    /// and the parent would never go on with its subagents' reports.
    #[test]
    fn a_turn_woken_by_a_subagent_is_under_way_until_its_answer() {
        let line = |v: Value| format!("{v}\n");
        let mut t = String::new();
        t += &line(json!({"type": "PLANNER_RESPONSE", "source": "MODEL", "content": "Waiting for shard_001."}));
        assert!(!turn_under_way(t.as_bytes()), "an answer without tool calls ends a turn");
        t += &line(json!({"type": "SYSTEM_MESSAGE", "source": "SYSTEM", "content": "[Message] sender=d038 content=shard_001 done"}));
        assert!(turn_under_way(t.as_bytes()), "the report woke it");
        t += &line(json!({"type": "PLANNER_RESPONSE", "source": "MODEL", "tool_calls": [{"name": "run_command", "args": {}}]}));
        assert!(turn_under_way(t.as_bytes()), "it calls a tool");
        t += &line(json!({"type": "GENERIC", "source": "MODEL", "status": "DONE", "content": "merged"}));
        assert!(turn_under_way(t.as_bytes()), "the tool's result: the model goes on");
        t += &line(json!({"type": "SYSTEM_MESSAGE", "source": "SYSTEM", "content": "Subagent d038 has gone idle."}));
        assert!(turn_under_way(t.as_bytes()));
        t += "{\"type\": \"PLANNER_RESP"; // a line still being written
        assert!(turn_under_way(t.as_bytes()), "a half-written line is skipped");
        t += &line(json!({"type": "PLANNER_RESPONSE", "source": "MODEL", "truncated_fields": ["tool_calls"]}));
        assert!(turn_under_way(t.as_bytes()), "calls cut from the line are calls all the same");
        let mut done = t.clone();
        done += &line(json!({"type": "PLANNER_RESPONSE", "source": "MODEL", "content": "Wave 1 merged: 90/90."}));
        assert!(!turn_under_way(done.as_bytes()), "its answer ends it");
        t += &line(json!({"type": "ERROR_MESSAGE", "error": {"message": "quota"}}));
        assert!(!turn_under_way(t.as_bytes()), "agy's error ends it");
        assert!(!turn_under_way(b""), "no transcript, nothing under way");
    }

    #[test]
    fn a_woken_turn_counts_while_its_transcript_moves_and_only_while_it_does() {
        let dir = std::env::temp_dir().join(format!("lumo-woken-{}", chat_agents::run_mark()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("transcript.jsonl");
        std::fs::write(&path, format!("{}\n", json!({"type": "SYSTEM_MESSAGE", "content": "report"}))).unwrap();
        assert!(transcript_turn_under_way(&path, WOKEN_TURN_MAX), "just woken: under way");
        assert!(!transcript_turn_under_way(&path, Duration::ZERO), "silent past the limit: no longer waited for");
        std::fs::write(&path, format!("{}\n", json!({"type": "PLANNER_RESPONSE", "content": "Done."}))).unwrap();
        assert!(!transcript_turn_under_way(&path, WOKEN_TURN_MAX), "answered: agy may end");
        assert!(!transcript_turn_under_way(&dir.join("none.jsonl"), WOKEN_TURN_MAX));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_subagent_reporting_to_its_parent_by_id_shows_no_id() {
        let to_parent = json!({"Recipient": "52500962-219b-4002-bdb2-47bc3d4412fc", "Message": "shard_008 done"});
        let a = activity_for("send_message", &to_parent);
        assert_eq!((a.kind, a.detail.as_str()), ("talk", ""));
        let named = activity_for("send_message", &json!({"Recipient": "reviewer", "Message": "look"}));
        assert_eq!((named.kind, named.detail.as_str()), ("talk", "reviewer"));
    }

    #[test]
    fn what_agy_wrote_on_stderr_is_kept_when_it_is_not_utf8() {
        // cmd.exe in Italian: "è" in the console's code page (0xE8), not UTF-8.
        let mut cp = std::io::Cursor::new(b"La riga di comando \xe8 troppo lunga.\r\n".to_vec());
        let text = first_text(&mut cp, 64 * 1024);
        assert!(text.starts_with("La riga di comando ") && text.contains("troppo lunga."), "{text:?}");
        assert_eq!(failure(&text, "1"), tf("Antigravity CLI: {error}", &[("error", text.trim())]));
        // The cap cuts "é" in two: what came before stays.
        let mut cut = std::io::Cursor::new(format!("{}é", "a".repeat(9)).into_bytes());
        assert_eq!(first_text(&mut cut, 10), format!("{}\u{FFFD}", "a".repeat(9)));
        // The rest is still there to be drained.
        assert_eq!(cut.position(), 10);
    }

    #[test]
    fn not_signed_in_or_installed_comes_with_its_card_and_skipped_commands_with_the_hooks_one() {
        assert_eq!(chat_error(not_signed_in()), chat::with_fix(not_signed_in(), chat::FIX_AGY_SIGN_IN));
        assert_eq!(chat_error(not_installed()), chat::with_fix(not_installed(), chat::FIX_AGY_INSTALL));
        assert_eq!(chat_error("agy crashed".into()), "agy crashed");
        // A command agy skipped, while Lumo isn't connected to it: the card to connect.
        assert!(needs_hooks(1, "", false));
        assert!(needs_hooks(0, "tool permission auto-denied in headless mode", false));
        // Connected, or nothing skipped: no card.
        assert!(!needs_hooks(2, "", true));
        assert!(!needs_hooks(0, "some other error", false));
    }

    #[test]
    fn a_plan_naming_no_chat_goes_to_the_only_chat_agy_answers_or_to_none() {
        let at = |c: &[&str]| c.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        // Named (LUMO_CHAT_ID reached lumo-hook): that chat, whatever runs.
        assert_eq!(plan_chat("chat-a", &at(&["chat-b", "chat-c"])), Some("chat-a".into()));
        // Not named: the one chat agy is answering.
        assert_eq!(plan_chat("", &at(&["chat-a"])), Some("chat-a".into()));
        // Not named, two chats at work or none: nobody, never the chat on screen.
        assert_eq!(plan_chat("", &at(&["chat-a", "chat-b"])), None);
        assert_eq!(plan_chat("", &at(&[])), None);
        assert_eq!(plan_chat("", &at(&[""])), None);
    }

    #[test]
    fn a_chat_is_at_work_until_its_turn_ends() {
        let id = "at-work-test-chat";
        let count = || AT_WORK.lock().unwrap().iter().filter(|c| *c == id).count();
        {
            let _turn = AtWork::start(id);
            assert_eq!(count(), 1);
        }
        assert_eq!(count(), 0);
    }

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
        let a = args("default", "", None, "/w", "", &[]);
        assert_eq!(a.iter().filter(|s| *s == "--add-dir").count(), 1, "no inbox, only its folder: {a:?}");
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
        assert_eq!(run.visible, "The PDF says hi.");
        // The step before the tools stays shown, and in the answer.
        assert_eq!(run.shown, "Let me read it.\n\nThe PDF says hi.", "a new response step goes after the one before");
        assert_eq!(chat::turn_answer(&run.shown, &run.visible, "The PDF says hi."), "Let me read it.\n\nThe PDF says hi.");
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
    fn last_transcript_context_takes_latest_model_step_not_sum() {
        assert_eq!(last_transcript_context(b""), None);
        assert_eq!(last_transcript_context(b"not json\n{\"type\":\"USER_INPUT\",\"content\":\"hi\"}\n"), None);
        assert_eq!(
            last_transcript_context(br#"{"type":"PLANNER_RESPONSE","output_tokens":24,"content":"done"}"#),
            None,
            "output_tokens alone without prompt tokens is ignored"
        );

        let transcript = concat!(
            r#"{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","content":"hello"}"#, "\n",
            r#"{"step_index":1,"source":"MODEL","type":"PLANNER_RESPONSE","input_tokens":20000,"cache_read_tokens":0,"output_tokens":500}"#, "\n",
            r#"{"step_index":2,"source":"MODEL","type":"GENERIC","content":"tool output"}"#, "\n",
            r#"{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","input_tokens":12000,"cache_read_tokens":20500,"output_tokens":300}"#, "\n",
            r#"{"step_index":4,"source":"MODEL","type":"GENERIC","content":"more tool output"}"#, "\n",
            r#"{"step_index":5,"source":"MODEL","type":"PLANNER_RESPONSE","output_tokens":24,"content":"final summary"}"#, "\n",
            "{malformed json\n",
        );
        assert_eq!(last_transcript_context(transcript.as_bytes()), Some(12000 + 20500 + 300));
    }

    #[test]
    fn conversation_transcript_validates_id_and_falls_back() {
        let home = std::env::temp_dir().join(format!("lumo-agy-ctx-{}", chat_agents::run_mark()));
        let valid_id = "11111111-2222-3333-4444-555555555555";
        for bad in ["", "../evil", "sub-1", "11111111-2222-3333-4444-55555555555/", "not-a-uuid"] {
            assert_eq!(conversation_transcript(bad), None, "{bad}");
            assert_eq!(conversation_transcript_in(&home, bad), None, "{bad}");
        }
        assert_eq!(conversation_transcript_in(&home, valid_id), None);

        let fallback = home.join(".gemini").join("antigravity").join("brain").join(valid_id).join(".system_generated").join("logs").join("transcript.jsonl");
        std::fs::create_dir_all(fallback.parent().unwrap()).unwrap();
        std::fs::write(&fallback, b"").unwrap();
        assert_eq!(conversation_transcript_in(&home, valid_id), Some(fallback.clone()));

        let primary = home.join(".gemini").join("antigravity-cli").join("brain").join(valid_id).join(".system_generated").join("logs").join("transcript.jsonl");
        std::fs::create_dir_all(primary.parent().unwrap()).unwrap();
        std::fs::write(&primary, b"").unwrap();
        assert_eq!(conversation_transcript_in(&home, valid_id), Some(primary));

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn read_transcript_context_reads_tail_past_chunk_boundary() {
        let dir = std::env::temp_dir().join(format!("lumo-agy-tail-{}", chat_agents::run_mark()));
        std::fs::create_dir_all(&dir).unwrap();
        let small = dir.join("small.jsonl");
        std::fs::write(
            &small,
            r#"{"type":"PLANNER_RESPONSE","input_tokens":1500,"cache_read_tokens":500,"output_tokens":42}"#,
        )
        .unwrap();
        assert_eq!(read_transcript_context(&small), Some(2042));

        let large = dir.join("large.jsonl");
        let filler_line = format!(
            "{{\"step_index\":1,\"type\":\"PLANNER_RESPONSE\",\"input_tokens\":999999,\"cache_read_tokens\":0,\"output_tokens\":1,\"thinking\":\"{}\"}}\n",
            "x".repeat(1024)
        );
        let mut bytes = Vec::with_capacity((TRANSCRIPT_CHUNK as usize) + 8192);
        while bytes.len() <= TRANSCRIPT_CHUNK as usize {
            bytes.extend_from_slice(filler_line.as_bytes());
        }
        bytes.extend_from_slice(br#"{"step_index":2,"type":"PLANNER_RESPONSE","input_tokens":4000,"cache_read_tokens":50000,"output_tokens":250}"#);
        bytes.push(b'\n');
        bytes.extend_from_slice(br#"{"step_index":3,"type":"GENERIC","content":"done"}"#);
        bytes.push(b'\n');
        std::fs::write(&large, &bytes).unwrap();
        assert_eq!(read_transcript_context(&large), Some(54250));

        assert_eq!(read_transcript_context(&dir.join("missing.jsonl")), None);
        let _ = std::fs::remove_dir_all(&dir);
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

    /// agy's words when Gemini sent a tool call it could not read.
    const MALFORMED: &str = "Your previous response contained an improperly formatted function call: Malformed function call: Failed to parse function call: Function call is empty - no input to parse.\nPlease retry with a properly formatted function call\nRetries remaining: 3";

    #[test]
    fn an_answer_that_ends_in_an_error_is_kept_with_the_error_and_logged_without_it() {
        let mut run = Run::default();
        let line = json!({ "event": "result", "result": { "status": "ERROR", "error": MALFORMED, "response": "Ecco gli appunti: 109 pagine." } }).to_string();
        run.feed(line.as_bytes());
        assert_eq!(run.result, Some(Err(MALFORMED.into())));
        assert_eq!(run.failed_response, "Ecco gli appunti: 109 pagine.");
        // The log has what agy said, never the answer itself.
        let logged = run.failed_line.unwrap();
        assert!(logged.contains("Retries remaining") && logged.contains("<29 characters>") && !logged.contains("appunti"));
        // Only the fields it lists: one agy adds (its steps, an output) stays out.
        let mut more = Run::default();
        let line = json!({ "event": "result", "result": { "status": "ERROR", "error": "boom", "response": "ok", "output": "il testo degli appunti" } }).to_string();
        more.feed(line.as_bytes());
        let logged = more.failed_line.unwrap();
        assert!(logged.contains("boom") && logged.contains("<2 characters>") && !logged.contains("appunti"));

        // A result that went well leaves nothing for the log.
        let mut ok = Run::default();
        ok.feed(br#"{"event":"result","result":{"status":"SUCCESS","response":"ok"}}"#);
        assert_eq!((ok.failed_line, ok.failed_response.as_str()), (None, ""));
    }

    #[test]
    fn a_malformed_tool_call_is_said_in_plain_words_with_agys_own_line_apart() {
        assert!(is_malformed_call(MALFORMED) && !is_malformed_call("quota exceeded"));
        assert_eq!(error_words(MALFORMED), "Malformed function call: Failed to parse function call: Function call is empty - no input to parse.");
        assert_eq!(error_words("quota exceeded"), "quota exceeded");

        // No answer: what happened and what to do, then agy's line after the separator.
        let said = result_error(MALFORMED);
        let (plain, words) = said.split_once(crate::chat::ERROR_DETAIL).unwrap();
        assert!(plain.contains("empty tool call") && plain.contains("continue"));
        assert_eq!(words, format!("Antigravity CLI's message: {}", error_words(MALFORMED)));
        assert!(!said.contains("Please retry"));
        // Other errors are said as before.
        assert_eq!(result_error("quota exceeded"), "Antigravity CLI: quota exceeded");

        // With an answer: its kind and agy's words, the island says them in its language.
        let w = answer_warning(MALFORMED);
        assert_eq!((w.kind.as_str(), w.message.as_str()), ("malformed", error_words(MALFORMED).as_str()));
        assert_eq!(answer_warning("internal error").kind, "error");
    }

    #[test]
    fn an_error_keeps_agys_answer_and_streamed_words_only_after_a_malformed_call() {
        // agy's result carried the answer: kept, whatever the error.
        assert_eq!(kept_answer("quota exceeded", "Ecco gli appunti.", "Ora leggo…"), Some("Ecco gli appunti.".into()));
        assert_eq!(kept_answer(MALFORMED, "Ecco gli appunti.", ""), Some("Ecco gli appunti.".into()));
        // Only streamed words: an answer after a malformed call, a step's words otherwise.
        assert_eq!(kept_answer(MALFORMED, "", "  Fatto: 109 pagine.\n"), Some("Fatto: 109 pagine.".into()));
        assert_eq!(kept_answer("quota exceeded", "", "Ora leggo il file…"), None);
        // Nothing written, or signed out: the error alone.
        assert_eq!(kept_answer(MALFORMED, " ", " "), None);
        assert_eq!(kept_answer("authentication required", "Ecco.", "Ecco."), None);
    }

    #[test]
    fn agys_words_are_found_whatever_comes_before_them_and_kept_short() {
        // Characters whose lowercase takes more or fewer bytes (Kelvin sign, dotted I) before them.
        assert_eq!(error_words("\u{212A}\u{212A}Malformed function call: empty\nPlease retry"), "Malformed function call: empty");
        assert_eq!(error_words("İ İ: Malformed function call: empty"), "Malformed function call: empty");
        // A long error is cut, on a character.
        let long = "é".repeat(ERROR_WORDS_MAX + 50);
        let words = error_words(&long);
        assert_eq!(words.chars().count(), ERROR_WORDS_MAX + 1);
        assert!(words.ends_with('…'));
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

    #[test]
    fn lumo_s_browser_through_call_mcp_tool_says_the_site_and_other_mcp_tools_their_name() {
        let a = |name: &str, params: Value| activity_for(name, &params);
        let open = json!({ "ServerName": "lumo", "ToolName": "browser_open", "Arguments": "{\"url\":\"https://www.borsaitaliana.it/indici\"}", "toolSummary": "Open" });
        assert_eq!(a("call_mcp_tool", open.clone()), Activity::new("read", "borsaitaliana.it"));
        assert_eq!(a("call_mcp_tool", json!(open.to_string())), Activity::new("read", "borsaitaliana.it"), "its input as JSON text");
        let read = json!({ "ServerName": "lumo", "ToolName": "browser_read", "Arguments": { "tab": 2 } });
        assert_eq!(a("call_mcp_tool", read), Activity::new("web", ""));
        assert_eq!(a("mcp_lumo_browser_open", json!({ "url": "example.com" })), Activity::new("read", "example.com"));
        assert_eq!(a("call_mcp_tool", json!({ "ServerName": "github", "ToolName": "create_issue" })), Activity::new("tool", "create issue"));
        assert_eq!(a("call_mcp_tool", json!({})), Activity::new("tool", "call mcp tool"), "before the parameters are known");
        // Reading how to call a tool, before calling it: getting ready, not a file.
        let schema = json!({ "Path": "C:\\Users\\me\\.gemini\\antigravity-cli\\mcp\\lumo\\browser_close.json" });
        assert_eq!(a("read_file", schema), Activity::thinking());
        assert_eq!(a("read_file", json!({ "Path": "C:\\work\\mcp\\lumo\\browser_close.json" })), Activity::new("read", "browser_close.json"), "the chat's own file");
        // Another server's tool named like Lumo's is not Lumo's browser.
        assert_eq!(browser_call("call_mcp_tool", &json!({ "ServerName": "github", "ToolName": "browser_open", "Arguments": { "url": "x.com" } })), None);
        assert_eq!(browser_call("call_mcp_tool", &open), Some(("browser_open", json!({ "url": "https://www.borsaitaliana.it/indici" }))));
    }

    #[test]
    fn a_subagent_s_browser_calls_make_its_tabs_its_own() {
        // In its transcript: each argument is its JSON text.
        let line: Value = serde_json::from_str(r#"{"step_index":4,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"call_mcp_tool","args":{"ServerName":"\"lumo\"","ToolName":"\"browser_open\"","Arguments":"{\"url\":\"https://finance.yahoo.com\"}"}},{"name":"view_file","args":{"AbsolutePath":"\"C:\\\\a.txt\""}}]}"#).unwrap();
        assert_eq!(transcript_browsing(&line), [("browser_open", json!({ "url": "https://finance.yahoo.com" }))]);
        // A subagent agy delegated to, in the stream: its row is told, once the step starts.
        let mut run = Run::default();
        run.feed(br#"{"event":"step_update","step_index":3,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"browser_subagent","parameters":{"TaskName":"Markets"}}}"#);
        run.feed(br#"{"event":"step_update","step_index":1,"state":"ACTIVE","step_type":"tool","subagent_info":{"conversation_id":"sub-1"},"tool_info":{"name":"call_mcp_tool","parameters":{"ServerName":"lumo","ToolName":"browser_read","Arguments":{"tab":4}}}}"#);
        run.feed(br#"{"event":"step_update","step_index":1,"state":"DONE","step_type":"tool","subagent_info":{"conversation_id":"sub-1"},"tool_info":{"name":"call_mcp_tool"}}"#);
        assert_eq!(run.subagents.agents.take_browsed(), [("sub-1".to_string(), "browser_read", json!({ "tab": 4 }))]);
        assert_eq!(run.subagents.agents.get("sub-1").unwrap().now, Some(Activity::new("web", "")));
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
    fn a_subagents_steps_neither_keep_the_chat_writing_nor_end_its_own() {
        let mut run = Run::default();
        // A subagent's step that never gets its DONE (the subagent was cut off).
        run.feed(br#"{"event":"step_update","step_index":7,"state":"ACTIVE","step_type":"tool","subagent_info":{"conversation_id":"x"}}"#);
        assert!(run.open_steps.is_empty() && !run.writing());
        // The chat's own command 5 and the subagent's step 5: its DONE ends its own only.
        run.feed(br#"{"event":"step_update","step_index":5,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls"}}}"#);
        assert!(run.writing());
        run.feed(br#"{"event":"step_update","step_index":5,"state":"ACTIVE","step_type":"tool","subagent_info":{"conversation_id":"x"}}"#);
        run.feed(br#"{"event":"step_update","step_index":5,"state":"DONE","step_type":"tool","subagent_info":{"conversation_id":"x"}}"#);
        assert!(run.pending.iter().any(|(w, i, a)| w == MAIN && *i == 5 && *a == Activity::new("command", "")), "{:?}", run.pending);
        run.feed(br#"{"event":"step_update","step_index":5,"state":"DONE","step_type":"tool","tool_info":{"name":"run_command"}}"#);
        assert!(!run.writing());
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

    /// `agy models` as agy 1.5.16 prints it (cut).
    const AGY_1_5_16: &str = "gemini-4-neon-high             Gemini 4 Neon (High)
gemini-4-neon-low              Gemini 4 Neon (Low)
gemini-4-carbon-medium         Gemini 4 Carbon (Medium)
gemini-4-hydrogen-high         Gemini 4 Hydrogen (High)
gemini-4-hydrogen-low          Gemini 4 Hydrogen (Low)
gemini-pro-orchestrator-neon   Orchestrator (Neon)
gemini-pro-orchestrator        Orchestrator (Carbon)
gemini-pro-orchestrator-argon  Orchestrator (Argon)
claude-sonnet-5-5-medium       Claude Sonnet 5.5 (Medium)
";

    #[test]
    fn orchestrator_rows_are_listed_with_no_digit_in_their_names() {
        let listed = parse_models(AGY_1_5_16);
        for row in ["gemini-pro-orchestrator-neon", "gemini-pro-orchestrator", "gemini-pro-orchestrator-argon"] {
            assert!(listed.iter().any(|m| m == row), "{row} in {listed:?}");
        }
        assert!(!parse_models("Models:\nUse --model to pick one\n").iter().any(|m| m.contains("orchestrator")));
    }

    #[test]
    fn the_names_agy_gives_its_models_are_read_beside_their_ids() {
        let labels: HashMap<String, String> = parse_labels(AGY_1_5_16).into_iter().collect();
        assert_eq!(labels["gemini-4-carbon-medium"], "Gemini 4 Carbon (Medium)");
        assert_eq!(labels["gemini-pro-orchestrator"], "Orchestrator (Carbon)");
        assert_eq!(labels["claude-sonnet-5-5-medium"], "Claude Sonnet 5.5 (Medium)");
        let json: HashMap<String, String> = parse_labels(r#"[{"id":"gemini-4-neon-high","name":"Gemini 4 Neon (High)"},{"id":"x-1","name":"bad \"quote"}]"#).into_iter().collect();
        assert_eq!(json.len(), 1, "a name that would break the settings is left out: {json:?}");
        assert!(parse_labels("gemini-3-pro\n").is_empty(), "no name, nothing");
    }

    #[test]
    fn an_orchestrator_pick_runs_its_planners_row_with_both_models_for_this_run_only() {
        let labels: HashMap<String, String> = parse_labels(AGY_1_5_16).into_iter().collect();
        let (row, settings) = orchestrator_run("gemini-4-carbon-medium", "gemini-4-hydrogen-low", &labels);
        assert_eq!(row, "gemini-pro-orchestrator", "Carbon plans: Orchestrator (Carbon)");
        let settings: Value = serde_json::from_str(&settings.unwrap()).unwrap();
        assert_eq!(settings, json!({ "orchestrator": { "planner": "Gemini 4 Carbon (Medium)", "executor": "Gemini 4 Hydrogen (Low)" } }));
        let (row, _) = orchestrator_run("gemini-4-neon-low", "claude-sonnet-5-5-medium", &labels);
        assert_eq!(row, "gemini-pro-orchestrator-neon");
        // A planner with no row of its own: one of agy's rows, the settings say which plans.
        let (row, settings) = orchestrator_run("gemini-4-hydrogen-high", "gemini-4-hydrogen-low", &labels);
        assert!(is_orchestrator_row(&row));
        assert!(settings.unwrap().contains("Gemini 4 Hydrogen (High)"));
        // Names not known: agy's own planner and executor.
        let (row, settings) = orchestrator_run("gemini-4-neon-high", "gemini-4-hydrogen-high", &HashMap::new());
        assert_eq!((row.as_str(), settings), ("gemini-pro-orchestrator", None));
    }

    #[test]
    fn an_orchestrator_pick_is_two_checked_ids() {
        assert_eq!(orchestration("orchestrator:gemini-4-neon-high:gemini-4-hydrogen-high"), Some(("gemini-4-neon-high", "gemini-4-hydrogen-high")));
        assert_eq!(orchestration("orchestrator:gemini-4-neon-high"), None);
        assert_eq!(orchestration("orchestrator:--evil:gemini-4-hydrogen-high"), None);
        assert_eq!(orchestration("orchestrator:a-1:b-1:c-1"), None);
        assert_eq!(orchestration("gemini-4-neon-high"), None);
        // Its args: the row and the settings, never the pick itself.
        *LABELS.lock().unwrap() = Some(parse_labels(AGY_1_5_16).into_iter().collect());
        let a = args("orchestrator:gemini-4-neon-high:claude-sonnet-5-5-medium", "", None, "/w", "", &[]);
        assert!(a.windows(2).any(|w| w == ["--model", "gemini-pro-orchestrator-neon"]), "{a:?}");
        let at = a.iter().position(|x| x == "--settings").expect("--settings");
        assert!(a[at + 1].contains("Claude Sonnet 5.5 (Medium)"));
        assert!(!a.iter().any(|x| x.starts_with("orchestrator:")));
    }

    #[test]
    fn an_orchestrator_turn_says_who_plans_then_who_executes() {
        *LABELS.lock().unwrap() = Some(parse_labels(AGY_1_5_16).into_iter().collect());
        let mut phases = Phases::of("orchestrator:gemini-4-neon-high:claude-sonnet-5-5-medium").unwrap();
        assert_eq!(phases.map(&Activity::thinking()), Activity::new("step", "Neon is planning…"));
        let read = Activity::new("read", "main.rs");
        assert_eq!(phases.map(&read), read, "a step of its own stays as it is");
        let exit = activity_for("exit_plan_mode", &json!({ "plan": "1. Write it" }));
        assert_eq!(phases.map(&exit), exit);
        assert_eq!(phases.map(&Activity::thinking()), Activity::new("step", "Sonnet 5.5 is executing…"));
        assert!(Phases::of("gemini-4-neon-high").is_none());
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
        // Both started: the answer waits for its agents, it doesn't think.
        assert_eq!(run.take_activity(), Some(Activity::new("agents", "")));
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

    /// A folder of agy's own for a test: `<temp>/<mark>/.gemini/antigravity-cli/brain`.
    fn test_brain() -> PathBuf {
        let brain = std::env::temp_dir().join(format!("lumo-agy-{}", chat_agents::run_mark())).join(".gemini").join("antigravity-cli").join("brain");
        std::fs::create_dir_all(&brain).unwrap();
        brain
    }

    /// The transcript of conversation `id` in `brain`, and its `log_uri`.
    fn transcript_of(brain: &std::path::Path, id: &str) -> (PathBuf, String) {
        let logs = brain.join(id).join(".system_generated").join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let path = logs.join("transcript.jsonl");
        let slashed = path.to_string_lossy().replace('\\', "/").replace(' ', "%20");
        let uri = if slashed.starts_with('/') { format!("file://{slashed}") } else { format!("file:///{slashed}") };
        (path, uri)
    }

    fn append(path: &std::path::Path, lines: &[String]) {
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    fn started_by(sender: &str, prompt: &str) -> String {
        json!({ "step_index": 0, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE", "content": format!("[Message] sender={sender} content={prompt}") }).to_string()
    }

    fn calls(calls: Value) -> String {
        json!({ "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": calls }).to_string()
    }

    fn answer(text: &str) -> String {
        json!({ "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE", "content": text }).to_string()
    }

    #[test]
    fn a_subagent_that_starts_subagents_waits_for_them_and_each_is_a_row_under_it() {
        let brain = test_brain();
        let (coord, uri) = transcript_of(&brain, "sub");
        let mut run = Run::default();
        run.feed(SPAWN_A.as_bytes());
        run.feed(done_with(SPAWN_A, &uri).as_bytes());
        let coordinator = run.subagents.spawns[0].row.clone();
        assert_eq!(run.subagents.spawns[0].conversation.as_deref(), Some("sub"));
        // It plans, starts two subagents of its own (a transcript writes each argument as JSON text), then answers.
        let plan = json!({ "plan": [{ "step": "Start the batches", "status": "completed" }, { "step": "Wait for them", "status": "in_progress" }], "agent": "Writer A" });
        let roles = json!([{ "role": "Batch 1", "initial_prompt": "Do 1" }, { "role": "Batch 2", "initial_prompt": "Do 2" }]);
        append(&coord, &[
            started_by("main-1", "Coordinate the batches"),
            calls(json!([{ "name": "mcp_lumo_update_plan", "args": { "plan": plan["plan"].to_string(), "agent": "\"Writer A\"" } }])),
            calls(json!([{ "name": "invoke_subagent", "args": { "Subagents": roles.to_string() } }])),
            answer("Started both batches: waiting for them."),
        ]);
        run.subagents.read_transcripts();
        let row = run.subagents.agents.get(&coordinator).unwrap();
        assert!(!row.state.is_final(), "it waits for its subagents");
        assert_eq!(row.now, Some(Activity::new("agents", "0/2")));
        assert_eq!(row.plan.as_ref().unwrap().iter().map(|s| s.status).collect::<Vec<_>>(), ["done", "active"]);
        // Their transcripts show: a row each, under it, named by the role its call gave.
        let (one, _) = transcript_of(&brain, "child-1");
        let (two, _) = transcript_of(&brain, "child-2");
        append(&one, &[started_by("sub", "Do 1")]);
        append(&two, &[started_by("sub", "Do 2")]);
        // Another session's conversation, started by someone else: none of ours.
        let (other, _) = transcript_of(&brain, "elsewhere");
        append(&other, &[started_by("someone-else", "Hello")]);
        run.subagents.read_transcripts();
        let kids: Vec<&AgentRow> = run.subagents.agents.ids().filter_map(|id| run.subagents.agents.get(&id)).filter(|r| r.parent.as_deref() == Some(coordinator.as_str())).collect();
        let mut titles: Vec<&str> = kids.iter().map(|r| r.title.as_str()).collect();
        titles.sort();
        assert_eq!(titles, ["Batch 1", "Batch 2"]);
        assert_eq!(run.subagents.agents.open(), 3);
        // One finishes: the coordinator says so, and still waits.
        append(&one, &[answer("Batch 1 done.")]);
        run.subagents.read_transcripts();
        assert_eq!(run.subagents.agents.open(), 2);
        assert_eq!(run.subagents.agents.get(&coordinator).unwrap().now, Some(Activity::new("agents", "1/2")));
        // Woken by their messages, it works again, and answers once more; the last one finishes.
        append(&coord, &[calls(json!([{ "name": "view_file", "args": { "AbsolutePath": "\"C:\\\\work\\\\one.md\"" } }]))]);
        append(&two, &[answer("Batch 2 done.")]);
        run.subagents.read_transcripts();
        assert!(!run.subagents.agents.get(&coordinator).unwrap().state.is_final(), "it hasn't answered since");
        append(&coord, &[answer("Both batches are done.")]);
        run.subagents.read_transcripts();
        let row = run.subagents.agents.get(&coordinator).unwrap();
        assert_eq!(row.state, AgentState::Done);
        assert_eq!(row.summary.as_deref(), Some("Both batches are done."));
        assert_eq!(run.subagents.agents.open(), 0);
        let _ = std::fs::remove_dir_all(brain.parent().unwrap().parent().unwrap().parent().unwrap());
    }

    /// agy 1.5.13 (live test 3d): a subagent the model's server refuses stops
    /// on an ERROR_MESSAGE of its transcript, stays "alive" and tells no one.
    #[test]
    fn a_subagent_stopped_by_agys_error_fails_unless_it_goes_on() {
        let brain = test_brain();
        let (log, uri) = transcript_of(&brain, "sub");
        let mut run = Run::default();
        run.feed(done_with(SPAWN_A, &uri).as_bytes());
        let id = run.subagents.spawns[0].row.clone();
        let refused = json!({ "type": "ERROR_MESSAGE", "source": "SYSTEM", "status": "DONE", "error": "API error (attempt 1): UNAVAILABLE (code 503): No capacity available for model gemini-3.5-flash-lite" }).to_string();
        append(&log, &[started_by("main-1", "Count to ten"), refused.clone()]);
        run.subagents.read_transcripts();
        assert!(!run.subagents.agents.get(&id).unwrap().state.is_final(), "given a moment to go on");
        // It goes on: nothing failed.
        append(&log, &[calls(json!([{ "name": "view_file", "args": { "AbsolutePath": "\"C:\\\\work\\\\a.md\"" } }]))]);
        run.subagents.read_transcripts();
        assert!(run.subagents.spawns[0].failing.is_none());
        // Stopped again, for good: failed past the grace, with agy's words.
        append(&log, &[refused]);
        run.subagents.read_transcripts();
        run.subagents.spawns[0].failing.as_mut().unwrap().0 = Instant::now() - FAIL_GRACE;
        run.subagents.read_transcripts();
        let row = run.subagents.agents.get(&id).unwrap();
        assert_eq!(row.state, AgentState::Failed);
        assert!(row.error.as_deref().unwrap().contains("No capacity available"), "{:?}", row.error);
        assert!(!row.can_stop);
        let _ = std::fs::remove_dir_all(brain.parent().unwrap().parent().unwrap().parent().unwrap());
    }

    #[test]
    fn a_subagent_whose_subagents_never_show_is_done_a_moment_after_it_answered() {
        let brain = test_brain();
        let (coord, uri) = transcript_of(&brain, "sub");
        let mut run = Run::default();
        run.feed(done_with(SPAWN_A, &uri).as_bytes());
        let coordinator = run.subagents.spawns[0].row.clone();
        append(&coord, &[calls(json!([{ "name": "invoke_subagent", "args": { "Role": "\"Helper\"" } }])), answer("Started a helper.")]);
        run.subagents.read_transcripts();
        assert!(!run.subagents.agents.get(&coordinator).unwrap().state.is_final());
        run.subagents.spawns[0].waiting_since = Some(Instant::now() - CHILD_GRACE);
        run.subagents.read_transcripts();
        assert_eq!(run.subagents.agents.get(&coordinator).unwrap().state, AgentState::Done);
        let _ = std::fs::remove_dir_all(brain.parent().unwrap().parent().unwrap().parent().unwrap());
    }

    #[test]
    fn what_starts_a_subagent_and_who_started_one() {
        assert_eq!(invoked_roles("invoke_subagent", &json!({ "Subagents": [{ "role": "A" }, { "type_name": "code_reviewer" }, {}] })), ["A", "code reviewer", ""]);
        assert_eq!(invoked_roles("invoke_subagent", &json!({ "Role": "Solo" })), ["Solo"]);
        assert_eq!(invoked_roles("invoke_subagent", &json!({})), [""]);
        assert!(invoked_roles("browser_subagent", &json!({})).is_empty(), "Lumo's browser is no conversation");
        assert!(invoked_roles("view_file", &json!({})).is_empty());
        let first = json!({ "content": "[Message] sender=abc-123 content=Convert chapter 7" });
        assert_eq!(sender_of(&first), Some("abc-123"));
        assert_eq!(prompt_title(&first).as_deref(), Some("Convert chapter 7"));
        assert_eq!(sender_of(&json!({ "content": "Hello" })), None);
        let (brain, conversation) = brain_of(std::path::Path::new("/home/me/.gemini/antigravity-cli/brain/c1/.system_generated/logs/transcript.jsonl")).unwrap();
        assert_eq!((brain, conversation.as_str()), (PathBuf::from("/home/me/.gemini/antigravity-cli/brain"), "c1"));
        assert_eq!(brain_of(std::path::Path::new("/home/me/.gemini/antigravity-cli/x/transcript.jsonl")), None);
        // A subagent's plan, by name or through call_mcp_tool; another server's update_plan is not Lumo's.
        assert!(plan_call_of("mcp_lumo_update_plan", &json!({ "plan": [{ "step": "a", "status": "pending" }] })).is_some());
        assert!(plan_call_of("call_mcp_tool", &json!({ "ServerName": "lumo", "ToolName": "update_plan", "Arguments": { "plan": [{ "step": "a", "status": "pending" }] } })).is_some());
        assert!(plan_call_of("call_mcp_tool", &json!({ "ServerName": "other", "ToolName": "update_plan", "Arguments": { "plan": [{ "step": "a", "status": "pending" }] } })).is_none());
    }

    #[test]
    fn a_subagents_plan_is_never_the_chats() {
        let mut run = Run::default();
        let step = |params: Value| format!(r#"{{"event":"step_update","step_index":4,"state":"ACTIVE","step_type":"tool","tool_info":{{"name":"mcp_lumo_update_plan","parameters":{params}}}}}"#);
        run.feed(step(json!({ "plan": [{ "step": "Mine", "status": "pending" }], "agent": "Batch 1" })).as_bytes());
        assert_eq!(run.take_plan(), None);
        run.feed(step(json!({ "plan": [{ "step": "Main", "status": "pending" }] })).as_bytes());
        assert!(run.take_plan().is_some());
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
        let (mut reading, mut files) = (Reading::default(), Vec::new());
        let lines: Vec<Value> = TRANSCRIPT_A.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        let mut ended = Vec::new();
        let anyone = |_: &str| true;
        for (i, l) in lines.iter().enumerate() {
            ended.push(transcript_line(&mut row, &mut reading, &mut files, l, &anyone).answered);
            if i == 1 {
                assert!(files.is_empty(), "not before the call's result");
            }
        }
        assert_eq!(ended, [false, false, false, false, false, true]);
        assert_eq!(row.steps, 2);
        assert_eq!(row.tokens, Some(10_514));
        assert_eq!(files, vec![FileTouch { kind: "created", path: r"C:\work\a.txt".into() }]);
        assert_eq!(reading.report.as_deref(), Some("File a.txt has been created."));
        assert_eq!(row.summary.as_deref(), Some("File a.txt has been created."), "what it told its parent");
        // A write that failed lists nothing; a line whose calls were cut is a step, never its answer.
        let (mut row, mut reading, mut files) = (AgentRow::new("r", PROVIDER, "W"), Reading::default(), Vec::new());
        {
            let mut feed = |l: &str| transcript_line(&mut row, &mut reading, &mut files, &serde_json::from_str(l).unwrap(), &anyone).answered;
            assert!(!feed(&lines_of(1)));
            assert!(!feed(r#"{"source":"MODEL","type":"GENERIC","status":"DONE","content":"Error: file already exists"}"#));
            assert!(!feed(&lines_of(1)));
            assert!(!feed(r#"{"source":"MODEL","type":"GENERIC","status":"DONE","content":"Permission denied: C:\\work\\a.txt"}"#));
            assert!(!feed(r#"{"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"I'll write the renderer now.","truncated_fields":["tool_calls"]}"#));
        }
        assert!(files.is_empty());
        assert_eq!(row.steps, 3);
        assert!(!row.state.is_final());
    }

    #[test]
    fn a_file_with_error_in_its_name_is_written_all_the_same() {
        assert!(!call_failed("Created file C:\\work\\error-handler.ts."));
        assert!(!call_failed("Wrote errors.log"));
        assert!(call_failed("Error: file already exists"));
        assert!(call_failed("  failed to write C:\\a.txt"));
        assert!(call_failed("The write to C:\\a.txt was denied by the user."));
        assert!(call_failed("Access is denied."));
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
        // The turn's answer came while it worked: it was cut off, not done, and Resume is offered.
        sub.run_ended(AgentState::Done);
        let c = sub.agents.get("c").unwrap();
        assert_eq!((c.state, c.ended_by), (AgentState::Failed, Some("cli")));
    }

    #[test]
    fn invoke_subagent_supports_ask_talk_reopen_reply_and_rewrite_ids() {
        let dir = std::env::temp_dir()
            .join(format!("lumo-agy-ask-{}", chat_agents::run_mark()))
            .join(".gemini")
            .join("antigravity-cli")
            .join("brain")
            .join("sub-ask-1")
            .join(".system_generated")
            .join("logs");
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("transcript.jsonl");
        std::fs::write(&log, TRANSCRIPT_A).unwrap();
        let uri = format!("file:///{}", log.to_string_lossy().replace('\\', "/").trim_start_matches('/'));
        assert_eq!(conversation_from_log_uri(&uri).as_deref(), Some("sub-ask-1"));

        let mut run = Run::default();
        run.feed(SPAWN_A.as_bytes());
        run.feed(done_with(SPAWN_A, &uri).replace(r#""conversation_id":"sub""#, r#""conversation_id":"sub-ask-1""#).as_bytes());
        let id = run.subagents.spawns[0].row.clone();
        let row = run.subagents.agents.get(&id).unwrap();
        assert!(row.can_ask);
        assert!(row.can_stop);

        assert!(run.subagents.read_transcripts().0);
        let row = run.subagents.agents.get(&id).unwrap();
        assert_eq!(row.state, AgentState::Done);
        assert!(row.can_ask);
        assert!(!row.can_stop);

        let rewritten = rewrite_ask_ids(&format!("send_message (Recipient: \"{id}\")"), Some(&run.subagents));
        assert!(rewritten.contains("\"sub-ask-1\""), "got {rewritten}");
        assert!(!rewritten.contains(&id), "internal row id must be rewritten: {rewritten}");

        let send_active = r#"{"event":"step_update","step_update":{"conversation_id":"main-1","step_index":10,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"send_message","parameters":{"Recipient":"sub-ask-1","Message":"Controlla i test"}}}}"#;
        run.feed(send_active.as_bytes());
        let row = run.subagents.agents.get(&id).unwrap();
        assert_eq!(row.state, AgentState::Working);
        assert_eq!(row.round, 1);
        assert_eq!(row.talk.as_ref().map(|t| t.message.as_str()), Some("Controlla i test"));
        assert!(row.talk.as_ref().unwrap().reply.is_none());

        let send_done = r#"{"event":"step_update","step_update":{"conversation_id":"main-1","step_index":10,"state":"DONE","step_type":"tool","tool_info":{"name":"send_message"}}}"#;
        run.feed(send_done.as_bytes());

        let followup = concat!(
            r#"{"step_index":6,"source":"SYSTEM","type":"SYSTEM_MESSAGE","status":"DONE","content":"[Message] sender=main-1 content=Controlla i test"}"#, "\n",
            r#"{"step_index":7,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"Tutti i test unitari passano."}"#, "\n",
        );
        std::fs::write(&log, format!("{TRANSCRIPT_A}{followup}")).unwrap();
        run.subagents.read_transcripts();
        let row = run.subagents.agents.get(&id).unwrap();
        assert_eq!(row.state, AgentState::Done);
        assert_eq!(row.talk.as_ref().and_then(|t| t.reply.as_deref()), Some("Tutti i test unitari passano."));

        // Failed send_message reports error in talk.failed.
        let send_fail_active = r#"{"event":"step_update","step_update":{"conversation_id":"main-1","step_index":11,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"send_message","parameters":{"Recipient":"sub-ask-1","Message":"Ancora?"}}}}"#;
        let send_fail_done = r#"{"event":"step_update","step_update":{"conversation_id":"main-1","step_index":11,"state":"DONE","step_type":"tool","tool_info":{"name":"send_message","error":{"message":"Recipient unavailable"}}}}"#;
        run.feed(send_fail_active.as_bytes());
        run.feed(send_fail_done.as_bytes());
        let row = run.subagents.agents.get(&id).unwrap();
        assert_eq!(row.talk.as_ref().and_then(|t| t.failed.as_deref()), Some("Recipient unavailable"));
        let _ = std::fs::remove_dir_all(dir.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn swarm_workflow_post_message_read_board_and_nested_subagents_are_tracked() {
        let mut run = Run::default();

        // Single swarm worker + sharded tasks swarm workers.
        let swarm_add = r#"{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"swarm","parameters":{"action":"add","name":"worker-a","brief":"Inspect parser"}}}}"#;
        let swarm_tasks = r#"{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"swarm","parameters":{"action":"add","name":"shard","brief":"Audit module","tasks":["auth","billing"]}}}}"#;
        run.feed(swarm_add.as_bytes());
        run.feed(swarm_tasks.as_bytes());

        let w = run.subagents.agents.get("swarm-worker-a").expect("swarm-worker-a row");
        assert_eq!(w.state, AgentState::Working);
        assert!(w.can_ask);
        assert!(w.can_stop);
        assert!(run.subagents.agents.get("swarm-shard-1").is_some());
        assert!(run.subagents.agents.get("swarm-shard-2").is_some());

        // post_message attaches AgentTalk via @mention.
        let post_msg = r#"{"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"post_message","parameters":{"message":"@worker-a check edge cases"}}}}"#;
        run.feed(post_msg.as_bytes());
        let w = run.subagents.agents.get("swarm-worker-a").unwrap();
        assert!(w.talk.as_ref().is_some_and(|t| t.message.contains("check edge cases")));

        // read_board [done] finishes worker with summary.
        let board = r#"{"event":"step_update","step_update":{"step_index":4,"state":"DONE","step_type":"tool","tool_info":{"name":"read_board","response":"worker-a: [done] Parser handles empty input."}}}"#;
        run.feed(board.as_bytes());
        let w = run.subagents.agents.get("swarm-worker-a").unwrap();
        assert_eq!(w.state, AgentState::Done);
        assert!(!w.can_stop);

        // extract_workflow_roles and run_workflow.
        let roles = extract_workflow_roles("parallel([agent('a', role='Security Reviewer'), agent('b', role=\"Docs Writer\")])");
        assert_eq!(roles, vec!["Security Reviewer", "Docs Writer"]);

        let wf_active = r#"{"event":"step_update","step_update":{"step_index":5,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"run_workflow","parameters":{"Description":"Audit","Script":"agent('x', role='Code Auditor')"}}}}"#;
        let wf_done = r#"{"event":"step_update","step_update":{"step_index":5,"state":"DONE","step_type":"tool","tool_info":{"name":"run_workflow"}}}"#;
        run.feed(wf_active.as_bytes());
        let rows = run.subagents.agents.changed();
        assert!(rows.iter().any(|r| r.title == "Code Auditor" && r.state == AgentState::Working));
        run.feed(wf_done.as_bytes());
        let auditor = run.subagents.agents.changed().into_iter().find(|r| r.title == "Code Auditor").unwrap();
        assert_eq!(auditor.state, AgentState::Done);

        // tool step with subagent_info.subagents list.
        let nested = r#"{"event":"step_update","step_update":{"step_index":6,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"delegate"},"subagent_info":{"subagents":[{"conversation_id":"nested-1","role":"Helper"}]}}}"#;
        run.feed(nested.as_bytes());
        let nested_id = run.subagents.resolve("nested-1").expect("nested-1");
        assert_eq!(run.subagents.agents.get(&nested_id).unwrap().title, "Helper");
    }

    #[test]
    fn manage_subagents_and_stop_one_stop_workers() {
        let mut run = Run::default();
        run.feed(SPAWN_A.as_bytes());
        run.feed(done_with(SPAWN_A, "file:///C:/Users/me/.gemini/antigravity-cli/brain/sub-stop/.system_generated/logs/transcript.jsonl").replace(r#""conversation_id":"sub""#, r#""conversation_id":"sub-stop""#).as_bytes());
        run.feed(SPAWN_B.as_bytes());
        run.feed(done_with(SPAWN_B, "file:///C:/Users/me/.gemini/antigravity-cli/brain/sub-keep/.system_generated/logs/transcript.jsonl").replace(r#""conversation_id":"sub""#, r#""conversation_id":"sub-keep""#).as_bytes());

        let id_a = run.subagents.spawns[0].row.clone();
        let id_b = run.subagents.spawns[1].row.clone();

        let ev = run.subagents.stop_one(&id_a).expect("stop event for invoke_subagent");
        assert!(ev.contains("manage_subagents") && ev.contains("sub-stop"), "got {ev}");
        // Stopping, until agy says it stopped it.
        let row_a = run.subagents.agents.get(&id_a).unwrap();
        assert_eq!((row_a.state, row_a.stopping), (AgentState::Working, true));
        assert!(run.subagents.stop_one(&id_a).is_some(), "asked again, it is asked again");
        run.feed(br#"{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"tool","tool_info":{"name":"manage_subagents","parameters":{"Action":"kill","ConversationIds":["sub-stop"]}}}}"#);
        let row_a = run.subagents.agents.get(&id_a).unwrap();
        assert_eq!((row_a.state, row_a.stopping), (AgentState::Stopped, false));
        assert!(!row_a.can_stop && !row_a.can_ask);
        assert_eq!(run.subagents.stop_one(&id_a), None, "stopped already");

        // Swarm worker stop_one emits swarm kill event.
        run.feed(br#"{"event":"step_update","step_update":{"step_index":4,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"swarm","parameters":{"action":"add","name":"worker-s","brief":"Run checks"}}}}"#);
        let sw_ev = run.subagents.stop_one("swarm-worker-s").expect("stop event for swarm");
        assert!(sw_ev.contains("swarm") && sw_ev.contains("worker-s"), "got {sw_ev}");
        assert!(run.subagents.agents.get("swarm-worker-s").unwrap().stopping);
        run.feed(br#"{"event":"step_update","step_update":{"step_index":6,"state":"DONE","step_type":"tool","tool_info":{"name":"swarm","parameters":{"action":"kill","name":"worker-s"}}}}"#);
        assert_eq!(run.subagents.agents.get("swarm-worker-s").unwrap().state, AgentState::Stopped);

        // manage_subagents kill_all stops remaining active rows.
        run.feed(br#"{"event":"step_update","step_update":{"step_index":7,"state":"DONE","step_type":"tool","tool_info":{"name":"manage_subagents","parameters":{"Action":"kill_all"}}}}"#);
        let row_b = run.subagents.agents.get(&id_b).unwrap();
        assert_eq!(row_b.state, AgentState::Stopped);
        assert!(!row_b.can_stop);
    }

    /// agy's own file of a subagent, in its parent's folder.
    fn child_json(brain: &std::path::Path, parent: &str, child: &str, role: &str, state: &str, step: u64) {
        let dir = brain.join(parent).join(".system_generated").join("subagents");
        std::fs::create_dir_all(&dir).unwrap();
        let v = json!({ "conversationId": child, "subagentDescriptor": { "typeName": "self", "role": role }, "state": state, "spawnStepIndex": step, "workspaceUris": [] });
        std::fs::write(dir.join(format!("{child}.json")), v.to_string()).unwrap();
    }

    /// The first line of a child's transcript, as agy 1.5.9 writes it.
    fn real_first(sender: &str, task: &str) -> String {
        json!({ "step_index": 0, "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE",
            "content": format!("The following is a <SYSTEM_MESSAGE> not actually sent by the user, but provided by the system.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-18T21:04:11Z sender={sender} priority=MESSAGE_PRIORITY_HIGH content={task}\n</SYSTEM_MESSAGE>") })
        .to_string()
    }

    #[test]
    fn the_first_line_agy_really_writes_names_the_parent_and_the_task() {
        let first: Value = serde_json::from_str(&real_first("9b1c-parent", "Convert chapter 7\nto Markdown")).unwrap();
        assert_eq!(sender_of(&first), Some("9b1c-parent"));
        assert_eq!(first_prompt(&first), Some("Convert chapter 7\nto Markdown"));
        assert_eq!(prompt_title(&first).as_deref(), Some("Convert chapter 7 to Markdown"));
        // A message whose task mentions a sender is not fooled by it.
        let tricky = json!({ "content": "[Message] sender=real content=Reply to sender=fake please" });
        assert_eq!(sender_of(&tricky), Some("real"));
        let file = child_file(&json!({ "conversationId": "c-1", "subagentDescriptor": { "typeName": "code_reviewer", "role": "" }, "state": "SUBAGENT_STATE_KILLED", "spawnStepIndex": "12" })).unwrap();
        assert_eq!(file, ChildFile { conversation: "c-1".into(), role: Some("code reviewer".into()), killed: true, step: 12 });
        assert_eq!(child_file(&json!({ "conversationId": "../x" })), None, "never a path");
        assert_eq!(kills_of("manage_subagents", &json!({ "Action": "kill", "ConversationIds": "[\"a\",\"b\"]" })), Some(vec!["a".to_string(), "b".to_string()]));
        assert_eq!(kills_of("manage_subagents", &json!({ "Action": "kill_all" })), Some(vec![]));
        assert_eq!(kills_of("manage_subagents", &json!({ "Action": "list" })), None);
        assert_eq!(kills_of("define_subagent", &json!({ "Action": "kill_all" })), None);
    }

    #[test]
    fn the_children_agy_keeps_in_their_parents_folder_are_rows_under_it_by_their_role_and_end_as_agy_ends_them() {
        let brain = test_brain();
        let (coord, uri) = transcript_of(&brain, "coord");
        let mut run = Run::default();
        run.feed(done_with(SPAWN_A, &uri).replace(r#""conversation_id":"sub""#, r#""conversation_id":"coord""#).as_bytes());
        let coordinator = run.subagents.spawns[0].row.clone();
        append(&coord, &[
            real_first("main-1", "Coordinate"),
            calls(json!([{ "name": "invoke_subagent", "args": { "TypeName": "\"self\"", "Role": "\"Tester\"", "Prompt": "\"Run the tests\"" } }])),
            calls(json!([{ "name": "invoke_subagent", "args": { "TypeName": "\"self\"", "Role": "\"Reviewer\"", "Prompt": "\"Review the diff\"" } }])),
            answer("Both started."),
        ]);
        // agy names them in the coordinator's folder: the later one first on disk.
        child_json(&brain, "coord", "zz-tester", "Tester", "SUBAGENT_STATE_ALIVE", 3);
        child_json(&brain, "coord", "aa-reviewer", "Reviewer", "SUBAGENT_STATE_ALIVE", 5);
        // A conversation elsewhere in the brain that names it as sender: never looked through.
        let (stray, _) = transcript_of(&brain, "stray");
        append(&stray, &[real_first("coord", "Not one of them")]);
        run.subagents.read_transcripts();
        let kids: Vec<AgentRow> = run.subagents.agents.ids().filter_map(|id| run.subagents.agents.get(&id).cloned()).filter(|r| r.parent.as_deref() == Some(coordinator.as_str())).collect();
        assert_eq!(kids.iter().map(|r| r.title.as_str()).collect::<Vec<_>>(), ["Tester", "Reviewer"], "in the order they started");
        assert_eq!(run.subagents.agents.get(&coordinator).unwrap().now, Some(Activity::new("agents", "0/2")));
        // The tester answers its parent and agy closes it; the reviewer is stopped before it said anything.
        let (tester, _) = transcript_of(&brain, "zz-tester");
        append(&tester, &[
            real_first("coord", "Run the tests"),
            calls(json!([{ "name": "send_message", "args": { "Recipient": "\"coord\"", "Message": "\"All 40 tests pass.\"" } }])),
        ]);
        run.subagents.read_transcripts();
        child_json(&brain, "coord", "zz-tester", "Tester", "SUBAGENT_STATE_KILLED", 3);
        child_json(&brain, "coord", "aa-reviewer", "Reviewer", "SUBAGENT_STATE_KILLED", 5);
        run.subagents.read_transcripts();
        let by = |t: &str| run.subagents.agents.ids().filter_map(|id| run.subagents.agents.get(&id).cloned()).find(|r| r.title == t).unwrap();
        assert_eq!((by("Tester").state, by("Tester").summary.as_deref()), (AgentState::Done, Some("All 40 tests pass.")));
        assert_eq!(by("Reviewer").state, AgentState::Stopped);
        // Both ended, but the tester's report has not reached the coordinator:
        // it is still at work, for it owes the chat that report.
        assert_eq!(run.subagents.agents.get(&coordinator).unwrap().state, AgentState::Working);
        // agy wakes it with the message, and it passes the result on: done.
        append(&coord, &[real_first("zz-tester", "All 40 tests pass."), answer("The tests pass; the review was stopped.")]);
        run.subagents.read_transcripts();
        assert_eq!(run.subagents.agents.get(&coordinator).unwrap().state, AgentState::Done);
        assert_eq!(run.subagents.agents.open(), 0);
        let _ = std::fs::remove_dir_all(brain.parent().unwrap().parent().unwrap().parent().unwrap());
    }

    #[test]
    fn a_subagent_whose_own_are_done_works_until_it_reports_what_they_said_and_no_longer_than_report_wait() {
        let brain = test_brain();
        let (coord, uri) = transcript_of(&brain, "coord");
        let mut run = Run::default();
        run.feed(done_with(SPAWN_A, &uri).replace(r#""conversation_id":"sub""#, r#""conversation_id":"coord""#).as_bytes());
        let coordinator = run.subagents.spawns[0].row.clone();
        append(&coord, &[
            real_first("main-1", "Coordinate"),
            calls(json!([{ "name": "invoke_subagent", "args": { "TypeName": "\"self\"", "Role": "\"Lister\"", "Prompt": "\"List the folders\"" } }])),
            answer("Started; I will report."),
        ]);
        child_json(&brain, "coord", "k-lister", "Lister", "SUBAGENT_STATE_ALIVE", 2);
        run.subagents.read_transcripts();
        let (lister, _) = transcript_of(&brain, "k-lister");
        append(&lister, &[
            real_first("coord", "List the folders"),
            calls(json!([{ "name": "send_message", "args": { "Recipient": "\"coord\"", "Message": "\"src, hook, local\"" } }])),
        ]);
        child_json(&brain, "coord", "k-lister", "Lister", "SUBAGENT_STATE_KILLED", 2);
        // The message reached it, but it has not passed it on yet.
        append(&coord, &[real_first("k-lister", "src, hook, local")]);
        run.subagents.read_transcripts();
        let state = |run: &Run| run.subagents.agents.get(&coordinator).unwrap().state;
        assert_eq!(state(&run), AgentState::Working);
        assert_eq!(run.subagents.agents.get(&coordinator).unwrap().now, Some(Activity::new("agents", "1/1")));
        // It never does: past REPORT_WAIT it is done all the same, never left at work.
        run.subagents.spawns[0].owing_since = Some(Instant::now() - REPORT_WAIT);
        run.subagents.read_transcripts();
        assert_eq!(state(&run), AgentState::Done);
        let _ = std::fs::remove_dir_all(brain.parent().unwrap().parent().unwrap().parent().unwrap());
    }

    #[test]
    fn a_stop_says_stopping_until_agy_confirms_it_and_is_taken_back_when_it_never_does() {
        let brain = test_brain();
        let (_, uri) = transcript_of(&brain, "w1");
        let mut run = Run::default();
        run.feed(br#"{"event":"step_update","step_update":{"conversation_id":"main-x","step_index":1,"state":"DONE","step_type":"user_input"}}"#);
        run.feed(done_with(SPAWN_A, &uri).replace(r#""conversation_id":"sub""#, r#""conversation_id":"w1""#).as_bytes());
        let row = run.subagents.spawns[0].row.clone();
        assert_eq!(run.subagents.main.as_deref(), Some("main-x"));
        assert!(run.subagents.stop_one(&row).is_some());
        assert!(run.subagents.agents.get(&row).unwrap().stopping);
        // Never confirmed: past STOP_WAIT it is at work again, its Stop offered again.
        run.subagents.spawns[0].stop_asked = Some(Instant::now() - STOP_WAIT);
        run.subagents.read_transcripts();
        let r = run.subagents.agents.get(&row).unwrap();
        assert_eq!((r.state, r.stopping, r.can_stop), (AgentState::Working, false, true));
        // Asked again, and agy's file of the chat's own subagents says it was stopped.
        run.subagents.stop_one(&row);
        child_json(&brain, "main-x", "w1", "Writer A", "SUBAGENT_STATE_KILLED", 2);
        run.subagents.read_transcripts();
        let r = run.subagents.agents.get(&row).unwrap();
        assert_eq!((r.state, r.stopping), (AgentState::Stopped, false));
        let _ = std::fs::remove_dir_all(brain.parent().unwrap().parent().unwrap().parent().unwrap());
    }

    #[test]
    fn the_chats_plan_while_subagents_work_is_its_own_never_the_last_subagents() {
        let chat = "chat-plans";
        let mut run = Run::default();
        run.feed(SPAWN_A.as_bytes());
        let row = run.subagents.spawns[0].row.clone();
        let theirs = json!({ "plan": [{ "step": "Read", "status": "in_progress" }, { "step": "Write", "status": "pending" }] });
        let mine = json!({ "plan": [{ "step": "Start the writers", "status": "completed" }, { "step": "Merge", "status": "pending" }] });
        // lumo-hook hands both over, without `agent`: whose they are is not said
        // (and the chat's own transcript is not found: every one not theirs is the chat's).
        with_agents(chat, true);
        assert!(has_agents(chat));
        hold_plan(chat, theirs.clone());
        hold_plan(chat, mine.clone());
        // Too early: both wait.
        assert!(release_plans(chat, &run, false).is_empty());
        // The subagent's transcript shows the first as its own.
        run.subagents.agents.touch(&row).unwrap().plan = chat_agents::plan_of(&theirs);
        assert_eq!(release_plans(chat, &run, true), vec![mine.clone()]);
        // agy's stream shows the chat's plans itself: what lumo-hook hands over then is never news.
        hold_plan(chat, mine.clone());
        run.stream_plans = true;
        assert!(release_plans(chat, &run, true).is_empty());
        with_agents(chat, false);
        assert!(!has_agents(chat));
    }

    #[test]
    fn the_chats_plan_is_one_its_own_conversation_gave_never_a_subagents_one_level_down() {
        let chat = "chat-plans-main";
        let brain = test_brain();
        let (main, _) = transcript_of(&brain, "main-1");
        let (_, uri) = transcript_of(&brain, "coord");
        let mut run = Run::default();
        run.feed(br#"{"event":"init","conversation_id":"main-1","init":{"model":"gemini-3.8-flash-low"}}"#);
        run.feed(SPAWN_A.as_bytes());
        run.feed(done_with(SPAWN_A, &uri).replace(r#""conversation_id":"sub""#, r#""conversation_id":"coord""#).as_bytes());
        assert_eq!(run.subagents.main.as_deref(), Some("main-1"));
        append(&main, &[answer("Starting the coordinator.")]);
        run.subagents.read_transcripts();
        // The coordinator's own subagent (not read yet) and the chat each give a plan, without `agent`.
        let deep = json!({ "plan": [{ "step": "Elencare le cartelle", "status": "in_progress" }] });
        let mine = json!({ "plan": [{ "step": "Start the coordinator", "status": "completed" }, { "step": "Wait", "status": "in_progress" }] });
        let aged = |input: &Value, by: Duration| HELD_PLANS.lock().unwrap().push((chat.to_string(), input.clone(), Instant::now() - by));
        with_agents(chat, true);
        aged(&deep, PLAN_HOLD);
        aged(&mine, PLAN_HOLD);
        // Neither is in the chat's own transcript yet: both wait.
        assert!(release_plans(chat, &run, false).is_empty());
        // The chat's call shows up there: that one is the chat's, the other still waits.
        append(&main, &[calls(json!([{ "name": "mcp_lumo_update_plan", "args": { "plan": mine["plan"].clone() } }]))]);
        run.subagents.read_transcripts();
        assert_eq!(release_plans(chat, &run, false), vec![mine.clone()]);
        // The turn ends and the other was never the chat's: left out, never shown.
        assert!(release_plans(chat, &run, true).is_empty());
        // Nor is one never found there within PLAN_VERIFY.
        aged(&deep, PLAN_VERIFY);
        assert!(release_plans(chat, &run, false).is_empty());
        assert!(HELD_PLANS.lock().unwrap().iter().all(|(c, _, _)| c != chat));
        // A plan a subagent gave earlier, even one it has since replaced, is never the chat's.
        let old = json!({ "plan": [{ "step": "Count", "status": "pending" }] });
        run.subagents.their_plans.push(chat_agents::plan_of(&old).unwrap());
        assert_eq!(run.subagents.whose_plan(&chat_agents::plan_of(&old)), Some(false));
        with_agents(chat, false);
        let _ = std::fs::remove_dir_all(brain.parent().unwrap().parent().unwrap().parent().unwrap());
    }

    #[test]
    fn the_answer_is_written_once_quiet_with_its_subagents_at_work() {
        let mut run = Run::default();
        run.feed(SPAWN_A.as_bytes());
        assert!(!run.answered_with_agents(Duration::ZERO), "still starting it");
        run.feed(done_with(SPAWN_A, "file:///C:/Users/me/.gemini/antigravity-cli/brain/sub/.system_generated/logs/transcript.jsonl").as_bytes());
        run.feed(br#"{"event":"step_update","step_update":{"step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"I started a writer."}}"#);
        assert!(!run.answered_with_agents(Duration::ZERO), "still writing");
        run.feed(br#"{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"agent_response","text_delta":""}}"#);
        assert!(run.answered_with_agents(Duration::ZERO));
        assert!(!run.answered_with_agents(Duration::from_secs(60)), "not quiet long enough");
        // Its subagent done: nothing to wait for, the result ends the turn.
        run.subagents.agents.touch(&run.subagents.spawns[0].row.clone()).unwrap().end(AgentState::Done, None);
        assert!(!run.answered_with_agents(Duration::ZERO));
        // Nothing written: never.
        let mut quiet = Run::default();
        quiet.feed(SPAWN_A.as_bytes());
        assert!(!quiet.answered_with_agents(Duration::ZERO));
    }

    #[test]
    fn another_message_goes_to_agy_still_at_work_only_with_the_same_settings() {
        let exe = std::path::Path::new("agy");
        let a = ["--model".to_string(), "m".to_string(), "--conversation".to_string(), "c1".to_string()];
        let b = ["--model".to_string(), "m".to_string()];
        assert_eq!(agy_key(exe, &a, "x"), agy_key(exe, &b, "x"), "the conversation is not part of it");
        assert_ne!(agy_key(exe, &b, "x"), agy_key(exe, &b, "y"));
        // Other settings, 2 agents at work: not without the user.
        let chat = "chat-linger";
        let (_tx, back) = mpsc::channel();
        let end = Arc::new(Stop::default());
        let l = Lingering { key: "k1".into(), conversation: "c1".into(), want: Arc::default(), end: end.clone(), back, open: Arc::new(std::sync::atomic::AtomicUsize::new(2)) };
        lingering(|all| all.insert(chat.to_string(), l));
        let err = take_lingering(chat, "k2", Some("c1"), &Stop::default()).err().unwrap();
        assert_eq!(err, chat_agents::would_stop(2));
        assert!(!end.is_stopped());
        // The user said to send all the same: agy ends, and a new one answers.
        chat_agents::allow_restart(chat);
        assert!(take_lingering(chat, "k2", Some("c1"), &Stop::default()).unwrap().is_none());
        assert!(end.is_stopped());
        assert!(lingering(|all| all.get(chat).is_none()));
        // Its thread gone (the channel closed): a new one answers.
        let (tx, back) = mpsc::channel::<(Agy, Subagents)>();
        drop(tx);
        let l = Lingering { key: "k1".into(), conversation: "c1".into(), want: Arc::default(), end: Arc::default(), back, open: Arc::default() };
        lingering(|all| all.insert(chat.to_string(), l));
        assert!(take_lingering(chat, "k1", Some("c1"), &Stop::default()).unwrap().is_none());
    }

    /// A stand-in for agy: prints `lines`, then copies its input to its
    /// output until it closes (`more`), as agy stays until its input closes.
    fn fake_agy(lines: &[String]) -> (Agy, PathBuf) {
        let dir = std::env::temp_dir().join(format!("lumo-fake-agy-{}", chat_agents::run_mark()));
        std::fs::create_dir_all(&dir).unwrap();
        let stream = dir.join("stream.jsonl");
        std::fs::write(&stream, lines.join("\n") + "\n").unwrap();
        let args = ["/c".to_string(), "type".to_string(), stream.to_string_lossy().to_string(), "&".to_string(), "more".to_string()];
        (start_agy(std::path::Path::new("cmd"), &args, &dir, "", "k".into()).unwrap(), dir)
    }

    #[test]
    fn an_answer_written_while_its_subagents_work_ends_the_turn_and_agy_goes_on_with_them() {
        let uri = "file:///C:/Users/me/.gemini/antigravity-cli/brain/sub/.system_generated/logs/transcript.jsonl";
        let (agy, dir) = fake_agy(&[
            done_with(SPAWN_A, uri),
            r#"{"event":"step_update","step_update":{"conversation_id":"main-1","step_index":3,"state":"ACTIVE","step_type":"agent_response","text_delta":"I started a writer."}}"#.to_string(),
            r#"{"event":"step_update","step_update":{"conversation_id":"main-1","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":""}}"#.to_string(),
        ]);
        let shown = std::cell::RefCell::new(String::new());
        let (mut on_text, mut on_activity, mut on_file, mut on_plan) = (|t: &str| *shown.borrow_mut() = t.to_string(), |_: &Activity| {}, |_: &FileTouch| {}, |_: &Value| {});
        let mut sink = Sink { text: &mut on_text, activity: &mut on_activity, file: &mut on_file, plan: &mut on_plan };
        let started = Instant::now();
        let mut state = agy_turn(agy, user_event("go"), Run::default(), &Stop::default(), true, &mut sink, &chat_agents::silent(), None).unwrap();
        // Written and quiet, its writer at work: the answer is in, agy goes on.
        assert!(started.elapsed() >= QUIET_ANSWER && started.elapsed() < Duration::from_secs(30));
        assert_eq!(state.result, Some(Ok(String::new())));
        assert_eq!(chat::turn_answer(&state.shown, &state.visible, ""), "I started a writer.");
        assert_eq!(*shown.borrow(), "I started a writer.");
        assert_eq!(state.subagents.agents.open(), 1);
        let mut agy = state.agy.take().expect("agy goes on");
        assert_eq!(agy.owed, 1, "its result is still to come");
        assert!(agy.write(&user_event("a message for the subagent")), "it can still be told");
        // Its input closed, it ends; a writer still at work then was cut off, never done.
        agy.close_input();
        let mut own = state.next_turn();
        let ended = drive(&mut agy, &mut own, &Stop::default(), true, &mut sink, &chat_agents::silent(), &mut |_| false);
        assert_eq!(ended, Ended::Closed);
        let _ = finish(*agy, &mut own, &mut sink, &chat_agents::silent());
        let row = own.subagents.agents.get(&own.subagents.spawns[0].row).unwrap();
        assert_eq!((row.state, row.ended_by), (AgentState::Failed, Some("cli")));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_turn_that_fails_hands_its_subagents_back_for_the_next_turn() {
        // agy starts a writer, then ends without a result.
        let uri = "file:///C:/Users/me/.gemini/antigravity-cli/brain/sub/.system_generated/logs/transcript.jsonl";
        let dir = std::env::temp_dir().join(format!("lumo-fake-agy-{}", chat_agents::run_mark()));
        std::fs::create_dir_all(&dir).unwrap();
        let stream = dir.join("stream.jsonl");
        std::fs::write(&stream, done_with(SPAWN_A, uri) + "\n").unwrap();
        let args = ["/c".to_string(), "type".to_string(), stream.to_string_lossy().to_string()];
        let agy = start_agy(std::path::Path::new("cmd"), &args, &dir, "", "k".into()).unwrap();
        let (mut on_text, mut on_activity, mut on_file, mut on_plan) = (|_: &str| {}, |_: &Activity| {}, |_: &FileTouch| {}, |_: &Value| {});
        let mut sink = Sink { text: &mut on_text, activity: &mut on_activity, file: &mut on_file, plan: &mut on_plan };
        let Err((_, subagents)) = agy_turn(agy, user_event("go"), Run::default(), &Stop::default(), true, &mut sink, &chat_agents::silent(), None) else {
            panic!("no result: the turn fails");
        };
        assert_eq!(subagents.spawns.len(), 1, "the writer is handed back");
        // Kept under the conversation, the next turn of it finds them.
        let chat = "chat-failed-turn";
        save_chat_subagents(chat, "main-1", *subagents);
        assert_eq!(take_chat_subagents(chat, Some("main-1")).map(|s| s.spawns.len()), Some(1));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_turn_without_subagents_ends_with_its_result_and_agy_with_it() {
        let (agy, dir) = fake_agy(&[
            r#"{"event":"step_update","step_update":{"conversation_id":"main-1","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"Hello."}}"#.to_string(),
            r#"{"event":"result","result":{"status":"SUCCESS","response":"Hello.","conversation_id":"main-1"}}"#.to_string(),
        ]);
        let (mut on_text, mut on_activity, mut on_file, mut on_plan) = (|_: &str| {}, |_: &Activity| {}, |_: &FileTouch| {}, |_: &Value| {});
        let mut sink = Sink { text: &mut on_text, activity: &mut on_activity, file: &mut on_file, plan: &mut on_plan };
        let started = Instant::now();
        let state = agy_turn(agy, user_event("hi"), Run::default(), &Stop::default(), true, &mut sink, &chat_agents::silent(), None).unwrap();
        assert!(state.agy.is_none());
        assert_eq!(state.result, Some(Ok("Hello.".to_string())));
        assert!(started.elapsed() < claude_code::AFTER_RESULT, "its input closed with the result: it ended at once");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn agy_going_on_with_its_subagents_tells_the_chat_what_it_writes_and_hands_itself_to_the_next_message() {
        let brain = test_brain();
        let (writer, uri) = transcript_of(&brain, "sub");
        append(&writer, &[started_by("main-1", "Create a.txt")]);
        let (agy, dir) = fake_agy(&[
            done_with(SPAWN_A, &uri),
            r#"{"event":"step_update","step_update":{"conversation_id":"main-1","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"I started a writer."}}"#.to_string(),
        ]);
        let (mut on_text, mut on_activity, mut on_file, mut on_plan) = (|_: &str| {}, |_: &Activity| {}, |_: &FileTouch| {}, |_: &Value| {});
        let mut sink = Sink { text: &mut on_text, activity: &mut on_activity, file: &mut on_file, plan: &mut on_plan };
        let silent = chat_agents::silent();
        let mut state = agy_turn(agy, user_event("go"), Run::default(), &Stop::default(), true, &mut sink, &silent, None).unwrap();
        let mut agy = *state.agy.take().unwrap();
        // The writer finishes; its message wakes agy, which tells the chat, and its turn ends.
        append(&writer, &[answer("a.txt is ready.")]);
        for line in [
            r#"{"event":"step_update","step_update":{"conversation_id":"main-1","step_index":4,"state":"DONE","step_type":"system_message"}}"#,
            r#"{"event":"step_update","step_update":{"conversation_id":"main-1","step_index":5,"state":"DONE","step_type":"agent_response","text_delta":"The writer finished: a.txt is ready."}}"#,
            r#"{"event":"result","result":{"status":"SUCCESS","response":"The writer finished: a.txt is ready.","conversation_id":"main-1"}}"#,
        ] {
            assert!(agy.write(&format!("{line}\n")));
        }
        // The chat's next message wants it meanwhile.
        let want = std::sync::atomic::AtomicBool::new(true);
        let (tx, back) = mpsc::channel();
        let mut told = Vec::new();
        let mut own = |text: &str| told.push(text.to_string());
        let left = linger("", "main-1", agy, std::mem::take(&mut state.subagents), &silent, &want, Arc::default(), &std::sync::atomic::AtomicUsize::new(0), tx, &mut sink, &mut own);
        assert!(left.is_none(), "handed over, not ended");
        assert_eq!(told, ["The writer finished: a.txt is ready."], "once, though its result says it again");
        let (mut agy, mut subagents) = back.try_recv().expect("handed to the next message");
        assert!(agy.stdin.is_some(), "it can take the message");
        // Its writer goes on being read with the next message.
        subagents.read_transcripts();
        assert_eq!(subagents.agents.open(), 0, "its writer is done");
        assert_eq!(agy.owed, 0, "the result it owed came");
        agy.close_input();
        kill_tree(&mut agy.child);
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::remove_dir_all(brain.parent().unwrap().parent().unwrap().parent().unwrap());
    }

    /// The subagents' bugs an audit found (each test failed before its fix),
    /// on agy's older layout too: no folder of children, each found by the
    /// first line of its transcript.
    mod audit {
    use super::*;

    fn brain() -> PathBuf {
        let b = std::env::temp_dir().join(format!("lumo-audit-{}", chat_agents::run_mark())).join(".gemini").join("antigravity-cli").join("brain");
        std::fs::create_dir_all(&b).unwrap();
        b
    }

    fn transcript(brain: &std::path::Path, id: &str) -> (PathBuf, String) {
        let logs = brain.join(id).join(".system_generated").join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        let path = logs.join("transcript.jsonl");
        let slashed = path.to_string_lossy().replace('\\', "/");
        let uri = if slashed.starts_with('/') { format!("file://{slashed}") } else { format!("file:///{slashed}") };
        (path, uri)
    }

    fn append(path: &std::path::Path, lines: &[String]) {
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
    }

    fn started_by(sender: &str, prompt: &str) -> String {
        json!({ "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE", "content": format!("[Message] sender={sender} content={prompt}") }).to_string()
    }

    fn calls(calls: Value) -> String {
        json!({ "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": calls }).to_string()
    }

    fn result(content: &str) -> String {
        json!({ "source": "MODEL", "type": "GENERIC", "status": "DONE", "content": content }).to_string()
    }

    fn answer(text: &str) -> String {
        json!({ "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE", "content": text }).to_string()
    }

    /// The main stream starting one subagent per role, its transcript at `uri` (DONE: it names it).
    fn spawn(step: u64, role: &str, conv: &str, uri: &str) -> String {
        json!({ "event": "step_update", "step_update": { "conversation_id": "main-1", "step_index": step, "state": "DONE", "step_type": "subagent", "tool_name": "invoke_subagent",
            "subagent_info": { "subagents": [{ "type_name": "self", "role": role, "conversation_id": conv, "log_uri": uri }] } } })
        .to_string()
    }

    fn invoke(roles: &[(&str, &str)]) -> String {
        let list: Vec<Value> = roles.iter().map(|(r, p)| json!({ "role": r, "initial_prompt": p })).collect();
        calls(json!([{ "name": "invoke_subagent", "args": { "Subagents": Value::Array(list).to_string() } }]))
    }

    fn kids_of<'a>(run: &'a Run, parent: &str) -> Vec<&'a AgentRow> {
        run.subagents.agents.ids().filter_map(|id| run.subagents.agents.get(&id)).filter(|r| r.parent.as_deref() == Some(parent)).collect()
    }

    fn clean(brain: &std::path::Path) {
        let _ = std::fs::remove_dir_all(brain.parent().unwrap().parent().unwrap().parent().unwrap());
    }

    /// two coordinators at work. A's child shows in the same look as A's
    /// call that started it, while B still waits for one of its own: A's child
    /// is marked "looked at" before A asked for it, and is never shown. A then
    /// waits 30 s ("0 of 1 finished") and turns Done while its child still works.
    #[test]
    fn a_child_seen_while_a_sibling_waits_is_never_lost() {
        let brain = brain();
        let (a, ua) = transcript(&brain, "coord-a");
        let (b, ub) = transcript(&brain, "coord-b");
        let mut run = Run::default();
        run.feed(spawn(2, "Coordinator A", "coord-a", &ua).as_bytes());
        run.feed(spawn(3, "Coordinator B", "coord-b", &ub).as_bytes());
        let row_a = run.subagents.spawns[0].row.clone();
        // B asked for a child that has not shown yet: B is "wanted".
        append(&b, &[started_by("main-1", "Batch B"), invoke(&[("B child", "Do B")])]);
        append(&a, &[started_by("main-1", "Batch A")]);
        run.subagents.read_transcripts();
        // In the next 1.5 s: A starts its child, and the child's transcript appears.
        append(&a, &[invoke(&[("A child", "Do A")])]);
        let (ac, _) = transcript(&brain, "a-child");
        append(&ac, &[started_by("coord-a", "Do A")]);
        run.subagents.read_transcripts();
        run.subagents.read_transcripts();
        let titles: Vec<String> = kids_of(&run, &row_a).iter().map(|r| r.title.clone()).collect();
        clean(&brain);
        assert_eq!(titles, ["A child"], "A's child must show under A");
    }

    /// a coordinator starts "Tester" then "Reviewer". Their folders in
    /// agy's brain are found in folder order (on NTFS: by name, a random id),
    /// and each takes the next role in the list: the titles can be swapped.
    #[test]
    fn each_child_gets_the_role_its_call_gave_it() {
        for (first, second) in [("zz-child", "aa-child"), ("aa-child", "zz-child")] {
            let brain = brain();
            let (c, uc) = transcript(&brain, "coord");
            let mut run = Run::default();
            run.feed(spawn(2, "Coordinator", "coord", &uc).as_bytes());
            let coord = run.subagents.spawns[0].row.clone();
            append(&c, &[started_by("main-1", "Coordinate"), invoke(&[("Tester", "Run the tests"), ("Reviewer", "Review the diff")])]);
            run.subagents.read_transcripts();
            let (t, _) = transcript(&brain, first);
            append(&t, &[started_by("coord", "Run the tests")]);
            let (r, _) = transcript(&brain, second);
            append(&r, &[started_by("coord", "Review the diff")]);
            run.subagents.read_transcripts();
            let tester = run.subagents.spawns.iter().find(|s| s.conversation.as_deref() == Some(first)).map(|s| s.row.clone()).unwrap();
            let title = run.subagents.agents.get(&tester).unwrap().title.clone();
            let parent = run.subagents.agents.get(&tester).unwrap().parent.clone();
            clean(&brain);
            assert_eq!(parent.as_deref(), Some(coord.as_str()));
            assert_eq!(title, "Tester", "the child told to run the tests (folder {first}) is the Tester");
        }
    }

    /// Once a bug: a subagent that tells one of its own subagents what to do
    /// (send_message to the child) has that order taken as its report: its
    /// summary, and the reply of a question the user asked it, are the order.
    #[test]
    fn a_message_to_its_own_child_is_not_its_report() {
        let brain = brain();
        let (c, uc) = transcript(&brain, "coord");
        let mut run = Run::default();
        run.feed(spawn(2, "Coordinator", "coord", &uc).as_bytes());
        let coord = run.subagents.spawns[0].row.clone();
        append(&c, &[
            started_by("main-1", "Coordinate"),
            calls(json!([{ "name": "send_message", "args": { "Recipient": "\"child-1\"", "Message": "\"Now do batch 2, skip the docs\"" } }])),
            result("Message sent to \"child-1\"."),
            answer("Both batches are done: 14 files fixed."),
        ]);
        run.subagents.read_transcripts();
        let summary = run.subagents.agents.get(&coord).unwrap().summary.clone();
        clean(&brain);
        assert_eq!(summary.as_deref(), Some("Both batches are done: 14 files fixed."));
    }

    /// Once a bug: any call whose name has "subagent" in it counts as starting one:
    /// define_subagent, manage_subagents (kill), and an invoke_subagent that
    /// failed. The subagent then "waits for its subagents: 0 of 1 finished" for
    /// 30 s after its answer, for a child that never existed.
    #[test]
    fn only_a_call_that_started_a_subagent_counts() {
        for (name, args, res) in [
            ("define_subagent", json!({ "Name": "\"reviewer\"", "Prompt": "\"Review code\"" }), "Defined subagent reviewer."),
            ("manage_subagents", json!({ "Action": "\"kill\"", "ConversationIds": "[\"x\"]" }), "Killed 1 subagent."),
            ("invoke_subagent", json!({ "Subagents": "[{\"type_name\":\"reviewer\"}]" }), "Error: subagent reviewer not found or not allowed to be invoked"),
        ] {
            let brain = brain();
            let (c, uc) = transcript(&brain, "sub");
            let mut run = Run::default();
            run.feed(spawn(2, "Helper", "sub", &uc).as_bytes());
            let row = run.subagents.spawns[0].row.clone();
            append(&c, &[started_by("main-1", "Help"), calls(json!([{ "name": name, "args": args }])), result(res), answer("Done.")]);
            run.subagents.read_transcripts();
            let state = run.subagents.agents.get(&row).unwrap().state;
            let now = run.subagents.agents.get(&row).unwrap().now.clone();
            clean(&brain);
            assert_eq!(state, AgentState::Done, "{name}: it answered and started nobody, yet shows {now:?}");
        }
    }

    /// Once a bug: a coordinator stops one of its own subagents (manage_subagents
    /// kill, in its transcript): that row is never told, it goes on "working"
    /// (then "No signal") until the turn ends, and then turns green Done.
    #[test]
    fn a_child_its_coordinator_stopped_is_stopped() {
        let brain = brain();
        let (c, uc) = transcript(&brain, "coord");
        let mut run = Run::default();
        run.feed(spawn(2, "Coordinator", "coord", &uc).as_bytes());
        append(&c, &[started_by("main-1", "Coordinate"), invoke(&[("Slow one", "Do it")])]);
        run.subagents.read_transcripts();
        let (k, _) = transcript(&brain, "kid");
        append(&k, &[started_by("coord", "Do it")]);
        run.subagents.read_transcripts();
        let kid = run.subagents.resolve("kid").unwrap();
        append(&c, &[calls(json!([{ "name": "manage_subagents", "args": { "Action": "\"kill\"", "ConversationIds": "[\"kid\"]" } }])), result("Killed 1 subagent.")]);
        run.subagents.read_transcripts();
        let state = run.subagents.agents.get(&kid).unwrap().state;
        clean(&brain);
        assert_eq!(state, AgentState::Stopped);
    }

    /// Once a bug: the turn's answer came while a subagent was still at work (its
    /// transcript has no answer): Lumo ends agy and every process it started,
    /// and the row says Done, green, with no summary. It never finished: it
    /// was cut off, and should say so (and offer Resume).
    #[test]
    fn a_subagent_cut_off_by_the_end_of_the_turn_is_not_done() {
        let brain = brain();
        let (c, uc) = transcript(&brain, "sub");
        let mut run = Run::default();
        run.feed(spawn(2, "Writer", "sub", &uc).as_bytes());
        let row = run.subagents.spawns[0].row.clone();
        append(&c, &[started_by("main-1", "Write the docs"), calls(json!([{ "name": "write_file", "args": { "Path": "\"C:\\\\w\\\\a.md\"" } }]))]);
        run.subagents.read_transcripts();
        run.feed(br#"{"event":"result","result":{"status":"SUCCESS","response":"I started a writer.","conversation_id":"main-1"}}"#);
        // What run_with_subagents does once the answer is in.
        run.subagents.read_transcripts();
        run.subagents.run_ended(AgentState::Done);
        let state = run.subagents.agents.get(&row).unwrap().state;
        clean(&brain);
        assert_ne!(state, AgentState::Done, "it never answered: it was cut off");
    }

    /// Once a bug: with 10 or more subagents from one call, Ask on the 10th is sent
    /// to the 1st: its row id `agy-<mark>-2-10` holds the 1st's `agy-<mark>-2-1`.
    #[test]
    fn ask_reaches_the_tenth_subagent_not_the_first() {
        let mut run = Run::default();
        // Conversation ids as agy gives them: nothing in common with the place.
        let ids = ["9f2c", "41aa", "c03e", "7b19", "e5d0", "2a6f", "d8c4", "06be", "b37a", "5e91"];
        let list: Vec<Value> = ids.iter().enumerate().map(|(n, id)| json!({ "role": format!("Batch {}", n + 1), "conversation_id": id })).collect();
        run.feed(json!({ "event": "step_update", "step_update": { "step_index": 2, "state": "DONE", "step_type": "subagent", "subagent_info": { "subagents": list } } }).to_string().as_bytes());
        let tenth = run.subagents.spawns[9].row.clone();
        let ask = rewrite_ask_ids(&format!("Send it with send_message (Recipient: \"{tenth}\")"), Some(&run.subagents));
        assert!(ask.contains("\"5e91\""), "got {ask}");
    }

    /// Once a bug: swarm with 10+ workers: "w-10: [done]" on the board ends w-1 too
    /// (`line.starts_with(name)`), while w-1 is still at work.
    #[test]
    fn the_board_saying_w10_is_done_does_not_end_w1() {
        let mut run = Run::default();
        run.feed(br#"{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"swarm","parameters":{"action":"add","name":"w","n":12}}}}"#);
        run.feed(br#"{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_info":{"name":"read_board","response":"w-10 [done] parser fixed"}}}"#);
        assert_eq!(run.subagents.agents.get("swarm-w-10").unwrap().state, AgentState::Done);
        assert_eq!(run.subagents.agents.get("swarm-w-1").unwrap().state, AgentState::Working);
    }

    /// Once a bug: swarm kill "test" also stops the worker "test-runner".
    #[test]
    fn killing_one_worker_stops_only_it() {
        let mut run = Run::default();
        run.feed(br#"{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"swarm","parameters":{"action":"add","name":"test"}}}}"#);
        run.feed(br#"{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"swarm","parameters":{"action":"add","name":"test-runner"}}}}"#);
        run.feed(br#"{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"tool","tool_info":{"name":"swarm","parameters":{"action":"kill","name":"test"}}}}"#);
        assert_eq!(run.subagents.agents.get("swarm-test").unwrap().state, AgentState::Stopped);
        assert_eq!(run.subagents.agents.get("swarm-test-runner").unwrap().state, AgentState::Working);
    }

    /// Once a bug: agy's brain holds one folder per conversation, and every subagent
    /// is one: past 4000 (MAX_SCAN) the folders looked at are always the same
    /// first 4000, already-looked ones included, and a new child past them is
    /// never found.
    #[test]
    fn a_child_is_found_in_a_brain_of_many_conversations() {
        let brain = brain();
        for i in 0..MAX_SCAN {
            std::fs::create_dir_all(brain.join(format!("old-{i:05}"))).unwrap();
        }
        std::thread::sleep(Duration::from_millis(20));
        let (c, uc) = transcript(&brain, "coord");
        let mut run = Run::default();
        run.feed(spawn(2, "Coordinator", "coord", &uc).as_bytes());
        let coord = run.subagents.spawns[0].row.clone();
        // The old folders predate the turn.
        run.subagents.since = Some(SystemTime::now());
        std::thread::sleep(Duration::from_millis(20));
        append(&c, &[started_by("main-1", "Coordinate"), invoke(&[("Kid", "Do it")])]);
        run.subagents.read_transcripts();
        let (k, _) = transcript(&brain, "zzzz-kid");
        append(&k, &[started_by("coord", "Do it")]);
        for _ in 0..3 {
            run.subagents.read_transcripts();
        }
        let n = kids_of(&run, &coord).len();
        clean(&brain);
        assert_eq!(n, 1);
    }

    /// Once a bug: agy starts subagents from an
    /// ordinary tool step (`step_type: "tool"` with `subagent_info.subagents`):
    /// besides the right row ("Helper"), the same step makes a row "Agent" (or
    /// the tool's title) that nothing ever ends: it works until the turn ends.
    #[test]
    fn subagents_from_a_tool_step_make_no_extra_row() {
        let mut run = Run::default();
        run.feed(br#"{"event":"step_update","step_update":{"step_index":6,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"delegate"},"subagent_info":{"subagents":[{"conversation_id":"nested-1","role":"Helper"}]}}}"#);
        let titles: Vec<String> = run.subagents.agents.ids().filter_map(|id| run.subagents.agents.get(&id).map(|r| r.title.clone())).collect();
        assert_eq!(titles, ["Helper"]);
    }

    /// Once a bug: Stop on a subagent marks its row
    /// Stopped at once and only asks the main agent, in words, to stop it: once
    /// the turn's answer came the message has nowhere to go (agy's input is
    /// closed), and the row says Stopped all the same. Here: the answer is in,
    /// Stop is clicked, the row is Stopped though nothing reached agy.
    #[test]
    fn stop_after_the_answer_does_not_claim_a_stop() {
        let mut run = Run::default();
        run.feed(spawn(2, "Writer", "sub", "file:///C:/Users/me/.gemini/antigravity-cli/brain/sub/.system_generated/logs/transcript.jsonl").as_bytes());
        let row = run.subagents.spawns[0].row.clone();
        run.feed(br#"{"event":"result","result":{"status":"SUCCESS","response":"Started.","conversation_id":"main-1"}}"#);
        // run_with_subagents: stdin was dropped with the result; stop_one is still called.
        let stdin_open = run.result.is_none();
        let _line = run.subagents.stop_one(&row);
        let state = run.subagents.agents.get(&row).unwrap().state;
        assert!(stdin_open || state != AgentState::Stopped, "nothing was sent to agy, yet the row says Stopped");
    }
    }
}
