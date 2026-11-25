// A terminal for the local models (Settings → Security → "Let local models use
// a terminal", off by default): `workspace_run` runs one command with cmd.exe
// in the chat's own folder of copies (workspace.rs), inside the Windows
// sandbox Lumo already keeps the user's tools in (sandbox.rs). There it:
//   * reads and writes that folder only, and a temporary folder of its own;
//     Python and Node, when installed, are opened to it to read and run;
//     the user's files, Lumo's data and the other chats' folders stay closed;
//   * has no internet, unless the model asked for it and the user allowed
//     that command on its card (Settings: Internet in commands, "ask" or "never");
//   * is stopped after the time Settings gives it (30 s, 2 or 10 minutes),
//     with everything it started, and can't hold more than MEMORY nor start
//     more than PROCESSES programs at once;
//   * gets none of Lumo's keys or tokens (sandbox.rs passed_on).
// Only with Sandbox High: on Low, or where Windows won't make the sandbox,
// the model isn't offered it at all. Never on Plan only.
//
// Cards: Ask for approval and Approve for me ask for every command, Run
// automatically for none but those that want the internet. "Allow for this
// chat" lets the chat's next commands run without a card, until Lumo quits;
// a command that wants the internet always asks.
//
// What a command changed in the folder joins the chat's files and the copies
// under the answer (`chat-file`); the command and the end of what it printed
// go under the answer too (`chat-command`, src/views/chat-messages.ts).

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::tools::Asking;

pub const RUN: &str = "workspace_run";
pub const NAMES: [&str; 1] = [RUN];

/// The longest command a model may give.
const MAX_COMMAND: usize = 4_000;
/// What goes back to the model of what the command printed, at most.
const MAX_OUTPUT: usize = 32 * 1024;
/// What the chat keeps of it under the answer: its end, at most.
const SHOWN_OUTPUT: usize = 2 * 1024;
/// All the command's programs together, at most.
const MEMORY: u64 = 4 * 1024 * 1024 * 1024;
/// Programs running at once, at most: no command fills the computer with them.
const PROCESSES: u32 = 64;
/// The times Settings offers, in seconds; anything else reads as the default.
const TIMEOUTS: [u64; 3] = [30, 120, 600];
const DEFAULT_TIMEOUT: u64 = 120;
/// Folders a command fills by itself (installed packages, caches): what
/// changes in them isn't listed under the answer.
const NOT_LISTED: &[&str] = &[".libs", "__pycache__", "node_modules", ".venv", "venv", ".pytest_cache"];
/// The most files looked at, before and after a command, to tell what it changed.
const MAX_SEEN: usize = 5_000;
/// The most changed files listed under one command's answer.
const MAX_LISTED: usize = 50;

/// What Settings says of the terminal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Config {
    pub on: bool,
    /// A command may ask for the internet (on its card); else never.
    pub network: bool,
    pub timeout: u64,
}

impl Config {
    pub fn of(s: &crate::settings::Settings) -> Config {
        Config { on: s.local_terminal, network: s.local_terminal_network != "never", timeout: timeout_of(s.local_terminal_timeout) }
    }
}

/// A command's time, as Settings may hold it.
pub fn timeout_of(seconds: u64) -> u64 {
    if TIMEOUTS.contains(&seconds) { seconds } else { DEFAULT_TIMEOUT }
}

fn config() -> Config {
    Config::of(&crate::settings::load())
}

/// Whether a local model's turn is offered the terminal: on in Settings, the
/// chat on Sandbox High, and a Windows that lets Lumo make its sandbox. Blocking.
pub fn offered(sandbox_high: bool) -> bool {
    sandbox_high && config().on && crate::sandbox::available()
}

/// The tool as the model reads it.
pub fn api_tool() -> (String, String, Value) {
    let c = config();
    let mut properties = json!({
        "command": { "type": "string", "description": "The command, as typed in cmd.exe (one line; && and | work)." },
        "reason": { "type": "string", "description": "What it does, in a few words in the user's language: shown to the user." },
    });
    let net = if c.network {
        properties["internet"] = json!({ "type": "boolean", "description": "true only if the command needs the internet (pip install, a download): the user is asked first." });
        " It has no internet unless you set internet (the user is asked first)."
    } else {
        " It has no internet."
    };
    let about = format!(
        "Runs a command in your own folder (the one workspace_copy copies into), with cmd.exe on Windows, in Lumo's sandbox: \
         it sees and changes only that folder, so copy files in first and refer to them by their names there.{net} \
         Python and Node work when the user has them; install Python packages with pip install --target .libs (.libs is on PYTHONPATH). \
         It is stopped after {} s. You get its exit code and what it printed.",
        c.timeout
    );
    (RUN.into(), about, json!({ "type": "object", "properties": properties, "required": ["command", "reason"] }))
}

/// What the island says the model is doing with it: the model's words for
/// it, never the command itself (as for Claude Code's, claude_code.rs).
pub fn activity(input: &Value) -> crate::claude_code::Activity {
    let reason: String = input.get("reason").and_then(Value::as_str).unwrap_or("").trim().chars().take(80).collect();
    crate::claude_code::Activity::new("command", reason)
}

/// The chats whose commands run without a card ("Allow for this chat"), until Lumo quits.
static ALLOWED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn allowed(chat: &str) -> bool {
    ALLOWED.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|s| s.contains(chat))
}

fn allow(chat: &str) {
    ALLOWED.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashSet::new).insert(chat.to_string());
}

/// The chat is gone: its "Allow for this chat" goes with it.
pub fn forget(chat: &str) {
    if let Some(set) = ALLOWED.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        set.remove(chat);
    }
}

/// Whether a command needs a card, `asking` as the chat's shield says:
/// always on Ask for approval and Approve for me (a command can do anything
/// in its folder), never on Run automatically, since it runs in the sandbox,
/// but for one that wants the internet, which always asks. "Allow for this
/// chat" stands for the chat's commands without the internet.
pub fn needs_card(asking: Asking, internet: bool, chat_allowed: bool) -> bool {
    if internet {
        return true;
    }
    if chat_allowed {
        return false;
    }
    asking != Asking::Sandboxed
}

/// A command as given: one line, not empty, not too long. Err: what the model is told.
pub fn checked_command(input: &Value) -> Result<String, String> {
    let command = input.get("command").and_then(Value::as_str).unwrap_or("").trim();
    if command.is_empty() {
        return Err("Give the command to run.".into());
    }
    if command.len() > MAX_COMMAND {
        return Err(format!("The command is too long ({} characters, {MAX_COMMAND} at most): write a script in your folder and run that.", command.len()));
    }
    if command.contains(['\n', '\r', '\0']) {
        return Err("Give one line: cmd.exe runs only the first of several. Join commands with &&, or write a script in your folder and run that.".into());
    }
    Ok(command.to_string())
}

/// cmd.exe's line for `command`: no AutoRun (/d), the command as it is
/// between the outer quotes (/s), the console's code page set to UTF-8 first,
/// so what its own commands print (dir, type) reads as text.
pub fn cmd_line(command: &str) -> String {
    format!("/d /s /c \"chcp 65001>nul & {command}\"")
}

/// A call of `workspace_run` from chat `chat_id`, `provider` answering:
/// asked as `asking` says, run, and said under the answer. The answer for the
/// model and whether it failed.
pub async fn call(app: &AppHandle, chat_id: &str, provider: &str, input: &Value, asking: Asking) -> (String, bool) {
    let c = tauri::async_runtime::spawn_blocking(config).await.unwrap_or(Config { on: false, network: false, timeout: DEFAULT_TIMEOUT });
    // Turned off since the turn began.
    if !c.on {
        return (crate::tools::not_offered(RUN), true);
    }
    let command = match checked_command(input) {
        Ok(c) => c,
        Err(e) => return (e, true),
    };
    let reason = input.get("reason").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let wants_internet = input.get("internet").and_then(Value::as_bool) == Some(true);
    let internet = wants_internet && c.network;
    if needs_card(asking, internet, allowed(chat_id)) {
        let (agent, color) = crate::tools::plan_speaker(provider);
        let payload = json!({
            "hook_event_name": "PermissionRequest",
            "lumo_island": true,
            "tool_name": "Terminal",
            "tool_input": { "command": command, "description": reason },
            "lumo_terminal": { "agent": agent, "color": color, "internet": internet, "seconds": c.timeout },
            "lumo_session_allow": !internet,
        });
        match crate::pipe::ask_keeping(app, payload).await.as_deref() {
            Some("allow") => {}
            Some("always") => allow(chat_id),
            Some(_) => return ("The user said no to running this command.".into(), true),
            None => return ("Lumo couldn't ask the user (the island is paused or busy). Try again in a moment.".into(), true),
        }
    }
    let chat = chat_id.to_string();
    let line = command.clone();
    let ran = tauri::async_runtime::spawn_blocking(move || run(&chat, &line, internet, c.timeout))
        .await
        .unwrap_or_else(|_| Ran::failed("The command couldn't be started.".into()));
    for (kind, path) in &ran.changed {
        let path = path.to_string_lossy().to_string();
        crate::chat_files::remember(&path);
        let _ = app.emit_to(crate::island::WINDOW_LABEL, "chat-file", json!({ "chat": chat_id, "kind": kind, "path": path }));
    }
    let _ = app.emit_to(
        crate::island::WINDOW_LABEL,
        "chat-command",
        json!({
            "chat": chat_id,
            "command": command,
            "code": ran.code,
            "ok": ran.ok(),
            "ms": ran.ms,
            "stopped": ran.timed_out,
            "denied": ran.denied,
            "internet": internet,
            "output": tail(&ran.output, SHOWN_OUTPUT),
        }),
    );
    let mut text = ran.for_model(c.timeout);
    if wants_internet && !c.network {
        text.push_str("\n(It ran without the internet: the user turned the internet off for commands.)");
    }
    (text, !ran.ok())
}

/// A command that ran, or didn't.
#[derive(Debug, Default)]
pub struct Ran {
    /// Its exit code; None when it didn't start, was stopped or Windows gave none.
    pub code: Option<i32>,
    pub output: String,
    pub ms: u64,
    pub timed_out: bool,
    /// Something it tried was refused by the sandbox (its output says "Access is denied" or so).
    pub denied: bool,
    /// What it made or changed in the folder: "created" or "edited", and where.
    pub changed: Vec<(&'static str, PathBuf)>,
    /// It never started: why.
    pub not_started: Option<String>,
}

impl Ran {
    fn failed(why: String) -> Ran {
        Ran { not_started: Some(why), ..Default::default() }
    }

    pub fn ok(&self) -> bool {
        self.code == Some(0) && !self.timed_out && self.not_started.is_none()
    }

    /// What the model reads.
    pub fn for_model(&self, timeout: u64) -> String {
        if let Some(why) = &self.not_started {
            return why.clone();
        }
        let mut text = if self.timed_out {
            format!("Stopped after {timeout} s, with everything it started.")
        } else {
            match self.code {
                Some(code) => format!("Exit code {code}."),
                None => "It ended without an exit code.".into(),
            }
        };
        let out = self.output.trim();
        if out.is_empty() {
            text.push_str(" It printed nothing.");
        } else {
            text.push('\n');
            text.push_str(&head(out, MAX_OUTPUT));
        }
        if self.denied {
            text.push_str("\n(The sandbox refused something: commands see only your folder, never the user's files. Copy a file in with workspace_copy first.)");
        }
        if !self.changed.is_empty() {
            let names: Vec<String> = self.changed.iter().map(|(k, p)| format!("{} ({k})", p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default())).collect();
            text.push_str(&format!("\nChanged in your folder: {}.", names.join(", ")));
        }
        text
    }
}

/// `text`'s first `max` bytes, cut at a character, with … when cut.
fn head(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…", &text[..end])
}

/// `text`'s last `max` bytes, from a line's start when it can, with … when cut.
pub fn tail(text: &str, max: usize) -> String {
    let text = text.trim_end();
    if text.len() <= max {
        return text.to_string();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let rest = &text[start..];
    let rest = rest.find('\n').map(|i| &rest[i + 1..]).filter(|r| !r.is_empty()).unwrap_or(rest);
    format!("…\n{rest}")
}

/// Words Windows and its programs print when the sandbox refused them.
fn looks_denied(output: &str) -> bool {
    let o = output.to_lowercase();
    ["access is denied", "permission denied", "accesso negato", "errno 13", "eacces", "eperm"].iter().any(|w| o.contains(w))
}

/// The files in `dir` (not in NOT_LISTED folders, no links), with their size
/// and time, to tell what a command changed.
pub fn snapshot(dir: &Path) -> HashMap<PathBuf, (u64, Option<SystemTime>)> {
    let mut seen = HashMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(at) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&at) else { continue };
        for entry in entries.flatten() {
            if seen.len() >= MAX_SEEN {
                return seen;
            }
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if !NOT_LISTED.iter().any(|n| n.eq_ignore_ascii_case(&name)) {
                    stack.push(path);
                }
            } else if meta.is_file() {
                seen.insert(path, (meta.len(), meta.modified().ok()));
            }
        }
    }
    seen
}

/// What changed between two snapshots: files made ("created") and changed
/// ("edited"), in name order, MAX_LISTED at most.
pub fn changes(before: &HashMap<PathBuf, (u64, Option<SystemTime>)>, after: &HashMap<PathBuf, (u64, Option<SystemTime>)>) -> Vec<(&'static str, PathBuf)> {
    let mut out: Vec<(&'static str, PathBuf)> = after
        .iter()
        .filter_map(|(path, now)| match before.get(path) {
            None => Some(("created", path.clone())),
            Some(was) if was != now => Some(("edited", path.clone())),
            Some(_) => None,
        })
        .collect();
    out.sort_by(|a, b| a.1.cmp(&b.1));
    out.truncate(MAX_LISTED);
    out
}

/// Where a chat's commands keep their temporary files: beside its folder,
/// not in it, emptied before each command.
fn temp_dir(chat: &str) -> PathBuf {
    crate::platform::local_dir().join("terminal-temp").join(crate::workspace::safe_id(chat))
}

/// Python's and Node's programs for the sandbox, when the user has them:
/// the folders to put first on PATH and those to open to read.
fn runtimes() -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut path_first = Vec::new();
    let mut read = Vec::new();
    for (names, kind) in [(&["python", "py", "python3"][..], "py"), (&["node"][..], "js")] {
        let Some(exe) = names.iter().find_map(|n| crate::platform::find_on_path(n)) else { continue };
        let Some((start, reads)) = crate::tools::runtime(&exe, kind) else { continue };
        if let Some(dir) = start.parent() {
            path_first.push(dir.to_path_buf());
            // Python's Scripts folder: pip's own commands.
            if kind == "py" && dir.join("Scripts").is_dir() {
                path_first.push(dir.join("Scripts"));
            }
        }
        read.extend(reads);
    }
    if let Some(user) = std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join("Python")).filter(|p| p.is_dir()) {
        read.push(user);
    }
    (path_first, read)
}

/// Runs `command` for chat `chat` in the sandbox, `internet` or not, for
/// `timeout` seconds at most. Blocking.
pub fn run(chat: &str, command: &str, internet: bool, timeout: u64) -> Ran {
    let started = Instant::now();
    let ws = crate::workspace::dir(chat);
    if let Err(e) = std::fs::create_dir_all(&ws) {
        return Ran::failed(format!("Your folder couldn't be made: {e}"));
    }
    let temp = temp_dir(chat);
    let _ = std::fs::remove_dir_all(&temp);
    if let Err(e) = std::fs::create_dir_all(&temp) {
        return Ran::failed(format!("The command's temporary folder couldn't be made: {e}"));
    }
    let before = snapshot(&ws);
    let (path_first, read) = runtimes();
    let windows = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let cmd = windows.join("System32").join("cmd.exe");
    let path = std::env::join_paths(path_first.iter().cloned().chain(std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default()))
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let text = |p: &Path| p.to_string_lossy().to_string();
    let mut env: Vec<(String, String)> = vec![
        ("PATH".into(), path),
        ("TEMP".into(), text(&temp)),
        ("TMP".into(), text(&temp)),
        ("PYTHONIOENCODING".into(), "utf-8".into()),
        ("PYTHONUTF8".into(), "1".into()),
        ("PYTHONPATH".into(), text(&ws.join(".libs"))),
        ("PIP_NO_CACHE_DIR".into(), "1".into()),
        ("PIP_DISABLE_PIP_VERSION_CHECK".into(), "1".into()),
        ("npm_config_cache".into(), text(&temp.join("npm"))),
    ];
    // No internet: what honours a proxy is pointed at one that isn't there,
    // as for the user's tools (the sandbox holds it anyway).
    if !internet {
        for var in ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] {
            env.push((var.into(), "http://127.0.0.1:9".into()));
        }
    }
    let line = cmd_line(command);
    let write = [ws.clone(), temp.clone()];
    let launch = crate::sandbox::Launch {
        exe: &cmd,
        args: &[],
        cwd: &ws,
        env: &env,
        read: &read,
        write: &write,
        network: internet,
        line: Some(&line),
        memory: MEMORY,
        processes: PROCESSES,
    };
    let mut child = match crate::sandbox::spawn(&launch) {
        Ok(c) => c,
        Err(e) => return Ran::failed(format!("The command couldn't start in the Windows sandbox: {e}")),
    };
    drop(child.stdin.take());
    let read_all = |r: Option<std::fs::File>| {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let buf = Arc::new(Mutex::new(Vec::new()));
        let held = buf.clone();
        std::thread::spawn(move || {
            if let Some(mut r) = r {
                let mut chunk = [0u8; 8192];
                loop {
                    match r.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            let mut held = held.lock().unwrap_or_else(|e| e.into_inner());
                            // Past twice what the model reads, the rest is read and dropped.
                            let room = (MAX_OUTPUT * 2).saturating_sub(held.len());
                            held.extend_from_slice(&chunk[..n.min(room)]);
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(_) => break,
                    }
                }
            }
            let _ = tx.send(());
        });
        (buf, rx)
    };
    let out = read_all(child.stdout.take());
    let err = read_all(child.stderr.take());
    let running = Instant::now();
    let limit = Duration::from_secs(timeout);
    let status = loop {
        match child.try_wait() {
            Ok(Some(code)) => break Some(code),
            Ok(None) if running.elapsed() < limit => std::thread::sleep(Duration::from_millis(40)),
            _ => break None,
        }
    };
    // Whatever it left running ends with it (its job).
    child.kill();
    let deadline = Instant::now() + Duration::from_secs(2);
    let collect = |(buf, rx): (Arc<Mutex<Vec<u8>>>, std::sync::mpsc::Receiver<()>)| {
        let _ = rx.recv_timeout(deadline.saturating_duration_since(Instant::now()));
        let held = buf.lock().unwrap_or_else(|e| e.into_inner());
        String::from_utf8_lossy(&held).to_string()
    };
    let stdout = collect(out);
    let stderr = collect(err);
    let output = [stdout.trim_end(), stderr.trim_end()].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join("\n");
    let _ = std::fs::remove_dir_all(&temp);
    let changed = changes(&before, &snapshot(&ws));
    Ran {
        code: status,
        denied: looks_denied(&output),
        output,
        ms: started.elapsed().as_millis() as u64,
        timed_out: status.is_none(),
        changed,
        not_started: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cards_as_the_shield_says() {
        // Ask for approval and Approve for me: every command.
        assert!(needs_card(Asking::Always, false, false));
        assert!(needs_card(Asking::Risky, false, false));
        // Run automatically: none, it runs in the sandbox.
        assert!(!needs_card(Asking::Sandboxed, false, false));
        // Allowed for the chat: no card.
        assert!(!needs_card(Asking::Always, false, true));
        // The internet always asks, whatever was allowed.
        assert!(needs_card(Asking::Sandboxed, true, false));
        assert!(needs_card(Asking::Always, true, true));
    }

    #[test]
    fn a_command_is_one_line() {
        assert_eq!(checked_command(&json!({ "command": "  python a.py  " })).unwrap(), "python a.py");
        assert!(checked_command(&json!({ "command": "" })).is_err());
        assert!(checked_command(&json!({})).is_err());
        assert!(checked_command(&json!({ "command": "dir\ndel x" })).is_err());
        assert!(checked_command(&json!({ "command": "a\0b" })).is_err());
        assert!(checked_command(&json!({ "command": "x".repeat(MAX_COMMAND + 1) })).is_err());
    }

    #[test]
    fn cmd_takes_the_command_as_it_is() {
        assert_eq!(cmd_line(r#"python -c "print('hi')" && dir"#), r#"/d /s /c "chcp 65001>nul & python -c "print('hi')" && dir""#);
    }

    #[test]
    fn times_are_those_settings_offers() {
        assert_eq!(timeout_of(30), 30);
        assert_eq!(timeout_of(600), 600);
        assert_eq!(timeout_of(0), DEFAULT_TIMEOUT);
        assert_eq!(timeout_of(99_999), DEFAULT_TIMEOUT);
    }

    #[test]
    fn the_end_of_the_output_is_kept() {
        assert_eq!(tail("short\n", 100), "short");
        let long = (1..=100).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        let t = tail(&long, 30);
        assert!(t.starts_with("…\n"));
        assert!(t.ends_with("line 100"));
        assert!(!t.contains("line 9\n"));
        // Never cut inside a character.
        assert!(tail(&"é".repeat(50), 9).ends_with('é'));
        assert_eq!(head("abc", 10), "abc");
        assert_eq!(head("abcdef", 3), "abc\n…");
    }

    #[test]
    fn what_a_command_changed_is_listed() {
        let dir = std::env::temp_dir().join(format!("lumo-terminal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".libs/pkg")).unwrap();
        std::fs::write(dir.join("vendite.csv"), "a,b\n").unwrap();
        std::fs::write(dir.join("same.txt"), "x").unwrap();
        let before = snapshot(&dir);
        std::fs::write(dir.join("vendite.csv"), "a,b\n1,2\n").unwrap();
        std::fs::write(dir.join("totali.py"), "print(1)").unwrap();
        // Installed packages are the command's own business.
        std::fs::write(dir.join(".libs/pkg/mod.py"), "").unwrap();
        let got = changes(&before, &snapshot(&dir));
        assert_eq!(got, vec![("created", dir.join("totali.py")), ("edited", dir.join("vendite.csv"))]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_model_reads_how_it_went() {
        let ran = Ran { code: Some(0), output: "12480\n".into(), ..Default::default() };
        assert!(ran.ok());
        assert_eq!(ran.for_model(120), "Exit code 0.\n12480");
        let stopped = Ran { timed_out: true, ..Default::default() };
        assert!(!stopped.ok());
        assert_eq!(stopped.for_model(30), "Stopped after 30 s, with everything it started. It printed nothing.");
        let denied = Ran { code: Some(1), output: "PermissionError: [Errno 13] Permission denied".into(), denied: true, ..Default::default() };
        assert!(denied.for_model(120).contains("workspace_copy"));
        assert!(looks_denied("Access is denied."));
        assert!(!looks_denied("all good"));
        assert_eq!(Ran::failed("no sandbox".into()).for_model(120), "no sandbox");
    }

    #[test]
    fn allowed_for_the_chat_until_forgotten() {
        assert!(!allowed("chat-t1"));
        allow("chat-t1");
        assert!(allowed("chat-t1"));
        assert!(!allowed("chat-t2"));
        forget("chat-t1");
        assert!(!allowed("chat-t1"));
    }
}
