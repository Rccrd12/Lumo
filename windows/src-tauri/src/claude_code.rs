// Chat through Claude Code itself: the `claude` CLI the user installed and
// signed in to with their own Claude plan (Pro, Max…). No API key: Coucou runs
// the unmodified binary as `claude -p`, and Claude Code answers with its own
// sign-in, exactly as in a terminal. Coucou never reads, stores or forwards any
// Claude credential.
//
// Unlike the other providers, Claude Code can act: read a dropped PDF or image,
// read and edit files, run commands, search the web. Every action that needs a
// permission goes through Claude Code's own PermissionRequest hook — the one
// Coucou already installs — so it shows up in the island as the usual
// Allow / Deny card. Without the hooks, or with nobody clicking, Claude Code
// denies the action: `-p` never allows anything on its own.
//
// The prompt goes in on stdin, never on the command line: an npm install is a
// `claude.cmd`, and cmd.exe would interpret what the user typed. Every argument
// is fixed or checked.
//
// The answer is streamed like a local model's: `chat-delta` events carry the
// text visible so far, the command's reply is the final answer.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::chat::{self, Chat, ChatContext, ChatReply, ModelInfo};
use crate::i18n::{t, tf};
use crate::island::WINDOW_LABEL;
use crate::platform;

pub const PROVIDER: &str = "claude-code";

/// A turn can wait on the user's Allow / Deny clicks, so it gets a long while.
const TURN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// The island is told about new text at most this often.
const DELTA_INTERVAL: Duration = Duration::from_millis(1000 / 15);
/// Ceilings for what we read back: one event line, and the whole run.
const MAX_LINE: usize = 4 * 1024 * 1024;
const MAX_TOTAL: usize = 64 * 1024 * 1024;
/// Earlier turns from another provider, carried over as text, are cut to this.
const MAX_CARRIED_CHARS: usize = 24_000;

/// Added to Claude Code's own instructions. Plain words only: it is an argument.
const APPEND_PROMPT: &str = "You are Mochi, the user's personal assistant, answering from the Coucou island at the top of their screen. \
The chat window is small: answer in the user's language, keep answers focused, and use light Markdown (short paragraphs, lists, bold, code blocks), no tables or big headings. \
When the user drops a file, its path is given in the message: read it from there. \
You cannot see the user's screen or their open windows unless they share them. If you need to, ask them to press the screen button next to the paperclip in the chat. Never take a screenshot or list their windows yourself. \
Every action that needs a permission is approved by the user in the island, so ask for it normally.";

/// The models Claude Code takes by alias. "default": whatever the user set in Claude Code.
const DEFAULT_MODEL: &str = "default";
const MODELS: &[(&str, &str)] = &[(DEFAULT_MODEL, "Default"), ("opus", "Opus"), ("sonnet", "Sonnet"), ("haiku", "Haiku")];

/// Where Claude Code works when Coucou starts it: `~/Coucou`. Files outside it
/// can still be read or edited, each time with the user's Allow.
pub fn work_dir() -> PathBuf {
    platform::home_dir().join("Coucou")
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
fn safe_session(id: &str) -> Option<&str> {
    (id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')).then_some(id)
}

/// The command-line arguments, all fixed or checked. The prompt is not one of them.
fn args(model: &str, effort: &str, session: Option<&str>, inbox: &str) -> Vec<String> {
    let mut a: Vec<String> = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        // Never `auto` or a mode the user's settings default to: here every
        // action that needs a permission is a card in the island.
        "--permission-mode",
        "default",
        "--append-system-prompt",
        APPEND_PROMPT,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    a.push("--add-dir".into());
    a.push(inbox.to_string());
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
/// island sends one (a file only once, with the question after it was added), and — when an earlier provider answered the turns before
/// — that conversation as plain text.
fn prompt(context: Option<&ChatContext>, carried: &[Value], query: &str) -> String {
    let mut out = String::new();
    if !carried.is_empty() {
        let mut transcript = String::new();
        for turn in carried {
            let role = turn["role"].as_str().unwrap_or("user");
            let text = turn["content"].as_str().unwrap_or("");
            transcript.push_str(&format!("{role}: {text}\n\n"));
        }
        let cut: String = transcript.chars().rev().take(MAX_CARRIED_CHARS).collect::<Vec<_>>().into_iter().rev().collect();
        out.push_str("Earlier in this conversation (another assistant answered):\n\n");
        out.push_str(&cut);
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
                // Messages of subagents carry a parent: only the main conversation shows.
                if !v.get("parent_tool_use_id").map(Value::is_null).unwrap_or(true) {
                    return false;
                }
                let event = &v["event"];
                match event["type"].as_str() {
                    Some("message_start") => {
                        let changed = !self.visible.is_empty();
                        self.visible.clear();
                        changed
                    }
                    Some("content_block_delta") if event["delta"]["type"] == "text_delta" => {
                        let text = event["delta"]["text"].as_str().unwrap_or("");
                        self.visible.push_str(text);
                        !text.is_empty()
                    }
                    _ => false,
                }
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
}

/// Runs `claude -p` once, blocking. `on_text` gets the visible text as it grows.
fn run(exe: PathBuf, args: Vec<String>, input: String, mut on_text: impl FnMut(&str)) -> Result<Run, String> {
    let dir = work_dir();
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
    // Tells coucou-hook this run is the island's chat, not a session to show.
    cmd.env("COUCOU_ISLAND_RUN", "1");
    platform::no_console(&mut cmd);
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
    let mut state = Run::default();
    let mut timed_out = false;
    loop {
        let left = TURN_TIMEOUT.saturating_sub(started.elapsed());
        if left.is_zero() {
            timed_out = true;
            break;
        }
        match rx.recv_timeout(left.min(Duration::from_secs(1))) {
            Ok(line) => {
                if state.feed(&line) && last_emit.elapsed() >= DELTA_INTERVAL {
                    last_emit = Instant::now();
                    on_text(&state.visible);
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
fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        let mut kill = Command::new("taskkill");
        kill.args(["/T", "/F", "/PID", &child.id().to_string()]);
        platform::no_console(&mut kill);
        let _ = kill.status();
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
    query: String,
    context: Option<ChatContext>,
) -> Result<ChatReply, String> {
    let exe = platform::claude_candidates()
        .into_iter()
        .next()
        .ok_or_else(|| t("Claude Code isn't installed. Install it, sign in once with `claude` in a terminal, then try again."))?;

    let turn = chat.begin(PROVIDER);
    let session = chat.cli_session();
    // Turns another provider answered are carried over once, as text.
    let carried: Vec<Value> = if session.is_none() { turn.history.clone() } else { Vec::new() };
    let input = prompt(context.as_ref(), &carried, &query);
    let inbox = crate::files::inbox_dir().to_string_lossy().to_string();
    let args = args(model, effort, session.as_deref(), &inbox);

    let app2 = app.clone();
    let state = tauri::async_runtime::spawn_blocking(move || {
        run(exe, args, input, |text| {
            let _ = app2.emit_to(WINDOW_LABEL, "chat-delta", text.to_string());
        })
    })
    .await
    .map_err(|e| e.to_string())??;

    if let Some(id) = &state.session {
        chat.set_cli_session(&turn, id);
    }
    let answer = match state.result {
        Some(Ok(text)) => text,
        Some(Err(e)) => return Err(tf("Claude Code: {error}", &[("error", &e)])),
        None => unreachable!("run() returns an error without a result"),
    };
    let answer = if answer.trim().is_empty() && state.denied > 0 {
        t("Claude Code needed a permission that wasn't given. Install Coucou's hooks to approve actions from the island.")
    } else {
        answer
    };
    let plain = chat::plain_question(true, context.as_ref(), &query);
    chat.commit(&turn, json!({ "role": "user", "content": plain }), json!({ "role": "assistant", "content": answer }), &plain, &answer);
    Ok(ChatReply { text: answer, session: chat.cli_session() })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "0b5a8f2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b";

    #[test]
    fn the_prompt_never_goes_on_the_command_line_and_odd_values_are_dropped() {
        let a = args("opus", "high", Some(SID), "C:\\Users\\me\\AppData\\Local\\Coucou\\inbox");
        assert!(a.windows(2).any(|w| w == ["--effort", "high"]));
        assert!(a.windows(2).any(|w| w == ["--model", "opus"]));
        assert!(a.windows(2).any(|w| w == ["--resume", SID]));
        assert!(a.windows(2).any(|w| w == ["--permission-mode", "default"]));
        assert_eq!(a[0], "-p");

        let a = args("opus & del *", "high & calc", Some("x\" & calc"), "/inbox");
        assert!(!a.contains(&"--effort".to_string()));
        assert!(!a.iter().any(|s| s.contains('&')), "{a:?}");
        assert!(!a.contains(&"--model".to_string()));
        assert!(!a.contains(&"--resume".to_string()));
        assert!(!APPEND_PROMPT.contains(['%', '"', '&', '|', '<', '>', '^', '`']));
        assert!(APPEND_PROMPT.contains("press the screen button"), "Claude asks, never captures");
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
    fn the_file_rides_along_and_other_providers_turns_are_carried_once() {
        let file = ChatContext::File { name: "a.pdf".into(), path: "C:\\inbox\\a.pdf".into() };
        let p = prompt(Some(&file), &[], "summary?");
        assert!(p.contains("Path: C:\\inbox\\a.pdf"));
        assert!(p.ends_with("summary?"));
        assert_eq!(prompt(None, &[], "more"), "more");

        let carried = vec![json!({"role":"user","content":"hi"}), json!({"role":"assistant","content":"hello"})];
        let p = prompt(None, &carried, "go on");
        assert!(p.contains("user: hi") && p.contains("assistant: hello") && p.ends_with("go on"));
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
