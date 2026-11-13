// One request to the server, its answer read as it streams in or, for a
// server whose stream hangs (LM Studio, on some tool calls), whole.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use reqwest::Client;
use serde_json::{json, Value};

use crate::sse::{filter_thinking_blocks, finish_reason_of, parse_sse_line, progressive_filter, usage_of, without_half_tag, CallParts, Event};

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
    /// Once the answer flows, this long with nothing more is a stream that
    /// hung (LM Studio stops halfway, and says nothing for minutes).
    pub stall: Duration,
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
        matches!(self, Failure::CutShort) || self.is_engine()
    }

    /// The server's engine dropped the request: LM Studio's words when its
    /// model process ends or fails one ("terminated", "Engine protocol
    /// predict request failed: fetch failed"), in an error event or with any
    /// status (it sends them with a 400 too).
    pub fn is_engine(&self) -> bool {
        match self {
            Failure::Server(e) | Failure::Status(_, e) => {
                let e = e.trim().to_lowercase();
                e == "terminated" || ["fetch failed", "predict request failed", "model has crashed", "model crashed"].iter().any(|w| e.contains(w))
            }
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
    /// The model reasons, before any text: the prompt is read. Once.
    Reasoning,
    /// The model prepares a call of this tool (each new one, once its name comes).
    Calling(String),
    /// A piece of the stream came, whatever it holds (reasoning, a call's
    /// arguments, nothing new to show): the answer is still moving.
    Chunk,
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
/// most 15 times a second and once more at the end, `Reasoning` once when the
/// model reasons before any visible text, `Calling` as each tool call starts,
/// and `Chunk` for every piece of the stream that comes.
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
    // The visible text last sent.
    let mut shown = String::new();
    let mut started = false;
    // Some of the answer's text showed: what comes next is the answer, not reasoning.
    let mut visible = false;
    // The tools whose calls the model started, in order.
    let mut calling: Vec<String> = Vec::new();
    let mut used = None;
    // The answer said it is over (`finish_reason`, `[DONE]`): what follows is
    // only waited for a moment, then the stream ends even if the connection
    // stays open (LM Studio keeps it open).
    let finished = AtomicBool::new(false);
    // Something of the answer came (text, reasoning, a call): from then on a
    // silence of `to.stall` is a stream that hung. Before, the model may
    // still be reading a long prompt.
    let flowing = AtomicBool::new(false);
    let done = AtomicBool::new(false);
    let cut = AtomicBool::new(false);
    // The bytes of the tool calls so far: they count against MAX_ANSWER as the text does.
    let call_bytes = AtomicUsize::new(0);
    let mut take = |line: &str, text: &mut String, on: &mut dyn FnMut(Seen)| -> Result<(), Failure> {
        if let Some(reason) = finish_reason_of(line) {
            finished.store(true, Ordering::Relaxed);
            if reason == "length" {
                cut.store(true, Ordering::Relaxed);
            }
        }
        if let Some(total) = usage_of(line) {
            used = Some(total);
        }
        let event = parse_sse_line(line);
        // Only a sign of the model at work: LM Studio opens its answer with
        // an empty `{"role":"assistant"}` delta while it still reads the prompt.
        if !started && text.is_empty() && matches!(event, Some(Event::Reasoning)) {
            started = true;
            on(Seen::Reasoning);
        }
        if let Some(Event::Calls(pieces)) = &event {
            for name in pieces.iter().filter_map(|p| p.pointer("/function/name").and_then(Value::as_str)).filter(|n| !n.is_empty()) {
                if calling.last().map(String::as_str) != Some(name) {
                    calling.push(name.to_string());
                    on(Seen::Calling(name.to_string()));
                }
            }
        }
        if matches!(event, Some(Event::Text(_) | Event::Reasoning | Event::Calls(_))) {
            flowing.store(true, Ordering::Relaxed);
        }
        match event {
            Some(Event::Done) => done.store(true, Ordering::Relaxed),
            Some(Event::Text(delta)) => {
                text.push_str(&delta);
                // Reasoning written in the text (`<think>…`) is hidden: it is reasoning too.
                if !started && !visible {
                    if progressive_filter(text).is_empty() {
                        started = true;
                        on(Seen::Reasoning);
                    } else {
                        visible = true;
                    }
                }
            }
            Some(Event::Reasoning) | None => {}
            Some(Event::Usage(total)) => used = Some(total),
            Some(Event::Calls(pieces)) => {
                calls.feed(&pieces);
                call_bytes.store(calls.size(), Ordering::Relaxed);
            }
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
        } else if flowing.load(Ordering::Relaxed) {
            match tokio::time::timeout(to.stall, reply.chunk()).await {
                Ok(next) => next,
                Err(_) => return Err(Failure::CutShort),
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
        on(Seen::Chunk);
        pending.extend_from_slice(&chunk);
        // Whole lines only: a chunk may end in the middle of one, or of a character.
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            take(String::from_utf8_lossy(&line).trim_end(), &mut text, &mut on)?;
        }
        if done.load(Ordering::Relaxed) {
            break;
        }
        if pending.len() > MAX_LINE || text.len() + call_bytes.load(Ordering::Relaxed) > MAX_ANSWER {
            return Err(Failure::TooLarge);
        }
        // Only text that changed goes out: the same text again would take
        // what the answer is doing (a call it writes) off the island.
        if last.elapsed() >= DELTA_INTERVAL {
            last = Instant::now();
            let visible = progressive_filter(&text);
            let visible = without_half_tag(&visible);
            if visible != shown {
                visible.clone_into(&mut shown);
                on(Seen::Text(shown.clone()));
            }
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
