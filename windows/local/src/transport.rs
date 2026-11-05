// One request to the server, its answer read as it streams in or, for a
// server whose stream hangs (LM Studio, on some tool calls), whole.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use reqwest::Client;
use serde_json::{json, Value};

use crate::sse::{filter_thinking_blocks, finish_reason, parse_sse_line, progressive_filter, CallParts, Event};

/// The text shown while streaming goes out at most this often.
pub const DELTA_INTERVAL: Duration = Duration::from_millis(1000 / 15);
/// Ceilings on one event line and on a whole answer.
pub const MAX_LINE: usize = 1024 * 1024;
pub const MAX_ANSWER: usize = 4 * 1024 * 1024;
/// Ceiling on a whole (not streamed) answer, and on an error's body.
pub const MAX_BODY: usize = 8 * 1024 * 1024;
pub const MAX_ERROR_BODY: usize = 64 * 1024;
/// How long the stream waits for the usage chunk and `[DONE]` once the answer is over.
pub const AFTER_FINISH: Duration = Duration::from_secs(1);

/// Where the requests go: the chat completions address, the `Authorization`
/// header, and the clients the app made for it (`streaming` with a limit on
/// silence only, `whole` with one on the whole answer).
#[derive(Clone)]
pub struct Endpoint {
    pub url: String,
    pub authorization: String,
    pub streaming: Client,
    pub whole: Client,
}

/// What went wrong, for the app to say in the user's language.
#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    /// 404: the model isn't on the server.
    NotInstalled,
    /// Refused, with the HTTP status and what the server said (may be empty).
    Status(u16, String),
    /// No connection, or it broke halfway.
    Unreachable,
    /// The server gave up on the answer: it closed before the answer was over
    /// with nothing in it, or the whole answer isn't one.
    CutShort,
    /// An answer or a line past the ceilings.
    TooLarge,
    /// An error event, in the server's words (LM Studio's "terminated").
    Server(String),
}

impl Failure {
    /// The server dropped the answer halfway: said as such, and a streamed
    /// request is asked again whole.
    pub fn is_cut_short(&self) -> bool {
        match self {
            Failure::CutShort => true,
            Failure::Server(e) => e.trim().eq_ignore_ascii_case("terminated"),
            _ => false,
        }
    }
}

/// An answer: its text without its thinking, and the tools it calls (each
/// `{id, name, arguments}`, the arguments a JSON text).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Answer {
    pub text: String,
    pub calls: Vec<Value>,
    /// The tokens the request and its answer took, when the server said.
    pub used: Option<u64>,
    /// It stopped at the length limit (`finish_reason: length`).
    pub cut: bool,
}

/// What the stream shows while it comes in.
#[derive(Debug, Clone, PartialEq)]
pub enum Seen {
    /// The visible text so far.
    Text(String),
    /// The model started (it reasons, prepares a tool call, or the server
    /// opened its answer) before any text: the prompt is read.
    Started,
}

/// The body of `reply`, refused past `limit` bytes.
async fn read_capped(mut reply: reqwest::Response, limit: usize) -> Result<Vec<u8>, Failure> {
    if reply.content_length().is_some_and(|n| n > limit as u64) {
        return Err(Failure::TooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = reply.chunk().await.map_err(|_| Failure::CutShort)? {
        if body.len() + chunk.len() > limit {
            return Err(Failure::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// What an error body says: `error.message`, a bare `error` or `message`, or
/// its first characters.
pub fn error_detail(body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    if let Ok(v) = serde_json::from_str::<Value>(&text) {
        for at in ["/error/message", "/error", "/message"] {
            if let Some(m) = v.pointer(at).and_then(Value::as_str) {
                return m.to_string();
            }
        }
    }
    text.trim().chars().take(200).collect()
}

/// A refused request, as a `Failure`.
async fn refused(reply: reqwest::Response) -> Failure {
    let status = reply.status().as_u16();
    if status == 404 {
        return Failure::NotInstalled;
    }
    let body = read_capped(reply, MAX_ERROR_BODY).await.unwrap_or_default();
    Failure::Status(status, error_detail(&body))
}

/// Posts the request without streaming and reads the whole answer.
pub async fn ask_whole(to: &Endpoint, body: &Value) -> Result<Answer, Failure> {
    let mut body = body.clone();
    body["stream"] = json!(false);
    if let Some(b) = body.as_object_mut() {
        b.remove("stream_options");
    }
    let reply = to
        .whole
        .post(&to.url)
        .header("Authorization", &to.authorization)
        .json(&body)
        .send()
        .await
        .map_err(|e| if e.is_timeout() { Failure::CutShort } else { Failure::Unreachable })?;
    if !reply.status().is_success() {
        return Err(refused(reply).await);
    }
    whole_answer(&read_capped(reply, MAX_BODY).await?)
}

/// The text, tool calls and tokens of a whole (not streamed) answer.
pub fn whole_answer(bytes: &[u8]) -> Result<Answer, Failure> {
    let json: Value = serde_json::from_slice(bytes).map_err(|_| Failure::CutShort)?;
    if let Some(e) = json.get("error").filter(|e| !e.is_null()) {
        return Err(Failure::Server(e.pointer("/message").or(Some(e)).and_then(Value::as_str).unwrap_or_default().to_string()));
    }
    let message = json.pointer("/choices/0/message").ok_or(Failure::CutShort)?;
    let text = filter_thinking_blocks(message.get("content").and_then(Value::as_str).unwrap_or_default());
    let calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|calls| {
            calls
                .iter()
                .map(|c| {
                    let arguments = match c.pointer("/function/arguments") {
                        Some(Value::String(a)) => a.clone(),
                        Some(other) if !other.is_null() => other.to_string(),
                        _ => String::new(),
                    };
                    json!({ "id": c["id"].as_str().unwrap_or(""), "name": c.pointer("/function/name").and_then(Value::as_str).unwrap_or(""), "arguments": arguments })
                })
                .filter(|c| c["name"].as_str().is_some_and(|n| !n.is_empty()))
                .collect()
        })
        .unwrap_or_default();
    let cut = json.pointer("/choices/0/finish_reason").and_then(Value::as_str) == Some("length");
    Ok(Answer { text, calls, used: json.pointer("/usage/total_tokens").and_then(Value::as_u64), cut })
}

/// Posts the request and reads the event stream. `on` gets the visible text at
/// most 15 times a second and once more at the end, and `Started` once, when
/// the model starts before any text.
pub async fn stream(to: &Endpoint, body: &Value, mut on: impl FnMut(Seen)) -> Result<Answer, Failure> {
    let mut reply = to
        .streaming
        .post(&to.url)
        .header("Authorization", &to.authorization)
        .json(body)
        .send()
        .await
        .map_err(|_| Failure::Unreachable)?;
    if !reply.status().is_success() {
        return Err(refused(reply).await);
    }

    let mut text = String::new();
    let mut calls = CallParts::default();
    let mut pending = Vec::<u8>::new();
    let mut last = Instant::now().checked_sub(DELTA_INTERVAL).unwrap_or_else(Instant::now);
    let mut started = false;
    let mut used = None;
    // The answer said it is over (`finish_reason`, `[DONE]`): what follows is
    // only waited for a moment, then the stream ends even if the connection
    // stays open (LM Studio keeps it open).
    let finished = AtomicBool::new(false);
    let done = AtomicBool::new(false);
    let cut = AtomicBool::new(false);
    let mut take = |line: &str, text: &mut String, on: &mut dyn FnMut(Seen)| -> Result<(), Failure> {
        if finish_reason(line) {
            finished.store(true, Ordering::Relaxed);
            if line.contains("\"length\"") {
                cut.store(true, Ordering::Relaxed);
            }
        }
        let event = parse_sse_line(line);
        if !started && text.is_empty() && line.starts_with("data:") && !matches!(event, Some(Event::Text(_) | Event::Done | Event::Error(_))) {
            started = true;
            on(Seen::Started);
        }
        match event {
            Some(Event::Done) => done.store(true, Ordering::Relaxed),
            Some(Event::Text(delta)) => text.push_str(&delta),
            Some(Event::Reasoning) | None => {}
            Some(Event::Usage(total)) => used = Some(total),
            Some(Event::Calls(pieces)) => calls.feed(&pieces),
            Some(Event::Error(message)) => return Err(Failure::Server(message)),
        }
        Ok(())
    };
    loop {
        let next = if finished.load(Ordering::Relaxed) {
            match tokio::time::timeout(AFTER_FINISH, reply.chunk()).await {
                Ok(next) => next,
                Err(_) => break,
            }
        } else {
            reply.chunk().await
        };
        let chunk = match next {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            // The answer was complete: a connection dropped after it loses nothing.
            Err(_) if finished.load(Ordering::Relaxed) => break,
            Err(_) => return Err(Failure::Unreachable),
        };
        pending.extend_from_slice(&chunk);
        // Whole lines only: a chunk may end in the middle of one, or of a character.
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            take(String::from_utf8_lossy(&line).trim_end(), &mut text, &mut on)?;
        }
        if done.load(Ordering::Relaxed) {
            break;
        }
        if pending.len() > MAX_LINE || text.len() > MAX_ANSWER {
            return Err(Failure::TooLarge);
        }
        if last.elapsed() >= DELTA_INTERVAL {
            last = Instant::now();
            on(Seen::Text(progressive_filter(&text)));
        }
    }
    // A last line without its newline.
    take(String::from_utf8_lossy(&pending).trim_end(), &mut text, &mut on)?;
    // Closed before the answer was over, with nothing in it: the server gave up.
    let over = finished.load(Ordering::Relaxed) || done.load(Ordering::Relaxed);
    if !over && text.trim().is_empty() && calls.calls.is_empty() {
        return Err(Failure::CutShort);
    }
    // The last state always goes out, whatever the throttle skipped.
    on(Seen::Text(progressive_filter(&text)));
    Ok(Answer { text: filter_thinking_blocks(&text), calls: calls.done(), used, cut: cut.load(Ordering::Relaxed) })
}
