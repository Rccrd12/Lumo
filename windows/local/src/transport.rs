// One request to the server, its answer read as it streams in or, for a
// server whose stream hangs (LM Studio, on some tool calls), whole.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use reqwest::Client;
use serde_json::{json, Value};

use crate::sse::{filter_thinking_blocks, usage_counts, finish_reason_of, parse_sse_line, progressive_filter, usage_of, without_half_tag, CallParts, Event};

/// The tokens a model made, and how long it took.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Made {
    /// Every token it made: reasoning, text and tool calls.
    pub tokens: u64,
    /// Of which reasoning: `reasoning_content`, and text before any of the
    /// answer shows (`<think>…</think>`).
    pub reasoning: u64,
    /// The seconds from its first token to its last (now, while it streams).
    pub secs: f64,
    /// The tokens of the prompt it read, when the server said.
    pub prompt_tokens: Option<u64>,
    /// The seconds from the request to the first token: reading the prompt.
    pub prompt_secs: f64,
    /// The seconds since the turn began, its tools included (turn.rs; 0 from `stream`).
    pub total_secs: f64,
}

/// The text shown while streaming goes out at most this often.
pub const DELTA_INTERVAL: Duration = Duration::from_millis(1000 / 15);
/// Ceilings on one event line and on a whole answer.
pub const MAX_LINE: usize = 1024 * 1024;
pub const MAX_ANSWER: usize = 4 * 1024 * 1024;
/// Ceiling on a whole (not streamed) answer, and on an error's body.
pub const MAX_BODY: usize = 8 * 1024 * 1024;
pub const MAX_ERROR_BODY: usize = 64 * 1024;
/// How often the tokens the model made so far go out while it streams.
pub const MADE_INTERVAL: Duration = Duration::from_millis(250);
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
    /// status (it sends them with a 400 too); Unsloth Studio's when its
    /// connection to llama-server broke halfway ("Lost connection to the
    /// model server. It may have crashed"), which happens with the model
    /// still well and in memory.
    pub fn is_engine(&self) -> bool {
        match self {
            Failure::Server(e) | Failure::Status(_, e) => {
                let e = e.trim().to_lowercase();
                e == "terminated" || ["fetch failed", "predict request failed", "model has crashed", "model crashed", "lost connection to the model server", "lost connection to llama-server"].iter().any(|w| e.contains(w))
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
    /// The tokens the model made, when a whole answer's `usage` says
    /// (`completion_tokens`; a streamed answer says them with `Seen::Made`).
    pub made: Option<u64>,
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
    /// What the model made so far: four times a second at most while it
    /// streams, and once more at the end, with the server's own counts when
    /// it gave them (`usage`).
    Made(Made),
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
    let made = json.pointer("/usage/completion_tokens").and_then(Value::as_u64);
    Ok(Answer { text, calls, used: json.pointer("/usage/total_tokens").and_then(Value::as_u64), cut, made })
}

/// Tells each call of `calls` not told yet (from `told`) once its tool's name
/// is whole: its arguments began, a call after it began, or the answer is
/// `over`. A name may come in pieces ("set_", "timer"). The same tool twice
/// in a row is told once.
fn tell_calls(calls: &CallParts, over: bool, told: &mut usize, told_tool: &mut String, on: &mut dyn FnMut(Seen)) {
    while let Some(call) = calls.calls.get(*told) {
        let named = call["name"].as_str().unwrap_or("");
        let began = !call["arguments"].as_str().unwrap_or("").is_empty() || *told + 1 < calls.calls.len();
        if !(over || began) {
            break;
        }
        *told += 1;
        if !named.is_empty() && named != told_tool {
            named.clone_into(told_tool);
            on(Seen::Calling(named.to_string()));
        }
    }
}

/// "None" in the token counters and times of `stream`.
const NONE: u64 = u64::MAX;

/// Nanoseconds since `began`.
fn since(began: Instant) -> u64 {
    u64::try_from(began.elapsed().as_nanos()).unwrap_or(NONE - 1)
}

/// The seconds from `from` to `to`, both in nanoseconds.
fn secs_between(from: u64, to: u64) -> f64 {
    to.saturating_sub(from) as f64 / 1e9
}

/// Posts the request and reads the event stream. `on` gets the visible text at
/// most 15 times a second and once more at the end, `Reasoning` once when the
/// model reasons before any visible text, `Calling` as each tool call starts (`tell_calls`),
/// `Chunk` for every piece of the stream that comes, and `Made` with the
/// tokens made so far.
///
/// The servers send no count while they stream, but Ollama, LM Studio,
/// llama.cpp and vLLM send each token as its own piece: the pieces with text,
/// reasoning or a call are counted, one token each. The count the server gives
/// at the end (or on every piece, vLLM's continuous usage) replaces it.
pub async fn stream(to: &Endpoint, body: &Value, mut on: impl FnMut(Seen)) -> Result<Answer, Failure> {
    // From the request on: the time to the first token is the prompt read.
    let began = Instant::now();
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
    // The calls told so far (`Seen::Calling`), and the tool of the last one.
    let mut told = 0;
    let mut told_tool = String::new();
    let mut used = None;
    // The tokens made: counted (one per piece), and as the server says
    // (NONE: it didn't). Atomics, as the flags above: read between the
    // pieces while `take` holds them, and the future stays Send.
    let made = AtomicU64::new(0);
    let said_made = AtomicU64::new(NONE);
    // Of which reasoning, counted until some of the answer shows, and as the
    // server says; and the prompt's tokens, as it says.
    let reasoning = AtomicU64::new(0);
    let answer_shows = AtomicBool::new(false);
    let said_reasoning = AtomicU64::new(NONE);
    let said_prompt = AtomicU64::new(NONE);
    // When the first token and the last came, in nanoseconds after `began`.
    let first_token = AtomicU64::new(NONE);
    let last_token = AtomicU64::new(0);
    let mut made_told = Instant::now();
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
        if let Some(u) = usage_counts(line) {
            said_made.store(u.completion.min(NONE - 1), Ordering::Relaxed);
            if let Some(r) = u.reasoning {
                said_reasoning.store(r.min(NONE - 1), Ordering::Relaxed);
            }
            if let Some(p) = u.prompt {
                said_prompt.store(p.min(NONE - 1), Ordering::Relaxed);
            }
        }
        let event = parse_sse_line(line);
        if matches!(event, Some(Event::Text(_) | Event::Reasoning | Event::Calls(..))) {
            made.fetch_add(1, Ordering::Relaxed);
            let now = since(began);
            last_token.store(now, Ordering::Relaxed);
            if first_token.load(Ordering::Relaxed) == NONE {
                first_token.store(now, Ordering::Relaxed);
            }
        }
        // Only a sign of the model at work: LM Studio opens its answer with
        // an empty `{"role":"assistant"}` delta while it still reads the prompt.
        if !started && text.is_empty() && matches!(event, Some(Event::Reasoning)) {
            started = true;
            on(Seen::Reasoning);
        }
        if matches!(event, Some(Event::Text(_) | Event::Reasoning | Event::Calls(..))) {
            flowing.store(true, Ordering::Relaxed);
        }
        match event {
            Some(Event::Done) => done.store(true, Ordering::Relaxed),
            Some(Event::Text(delta)) => {
                text.push_str(&delta);
                // Until some of the answer shows, its text is reasoning
                // (`<think>…`, the blank lines after it).
                if !answer_shows.load(Ordering::Relaxed) {
                    if without_half_tag(&progressive_filter(text)).trim().is_empty() {
                        reasoning.fetch_add(1, Ordering::Relaxed);
                    } else {
                        answer_shows.store(true, Ordering::Relaxed);
                    }
                }
                // Reasoning written in the text (`<think>…`) is hidden: it is
                // reasoning too. The start of a tag (`<`) is not known yet.
                if !started && !visible {
                    let seen = progressive_filter(text);
                    if seen.is_empty() {
                        started = true;
                        on(Seen::Reasoning);
                    } else if !without_half_tag(&seen).is_empty() {
                        visible = true;
                    }
                }
            }
            Some(Event::Reasoning) => {
                reasoning.fetch_add(1, Ordering::Relaxed);
            }
            None => {}
            Some(Event::Usage(total)) => used = Some(total),
            Some(Event::Calls(pieces, words)) => {
                // The words that came with the calls go before them, as said.
                text.push_str(&words);
                calls.feed(&pieces);
                call_bytes.store(calls.size(), Ordering::Relaxed);
                tell_calls(&calls, false, &mut told, &mut told_tool, on);
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
        let first = first_token.load(Ordering::Relaxed);
        if first != NONE && made_told.elapsed() >= MADE_INTERVAL {
            made_told = Instant::now();
            let said = said_made.load(Ordering::Relaxed);
            let tokens = made.load(Ordering::Relaxed).max(if said == NONE { 0 } else { said });
            on(Seen::Made(Made {
                tokens,
                reasoning: reasoning.load(Ordering::Relaxed).min(tokens),
                secs: secs_between(first, since(began)),
                prompt_tokens: None,
                prompt_secs: secs_between(0, first),
                total_secs: 0.0,
            }));
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
    tell_calls(&calls, true, &mut told, &mut told_tool, &mut on);
    // Closed before the answer was over, with nothing in it: the server gave up.
    let over = finished.load(Ordering::Relaxed) || done.load(Ordering::Relaxed);
    if !over && text.trim().is_empty() && calls.calls.is_empty() {
        return Err(Failure::CutShort);
    }
    // The last state always goes out, whatever the throttle skipped.
    on(Seen::Text(progressive_filter(&text)));
    // The count as it ended: the server's own when it gave one, over the
    // time from the first token to the last (not the wait for `[DONE]`).
    let first = first_token.load(Ordering::Relaxed);
    if first != NONE {
        let said = said_made.load(Ordering::Relaxed);
        let tokens = if said == NONE { made.load(Ordering::Relaxed) } else { said };
        let said_reasoning = said_reasoning.load(Ordering::Relaxed);
        let reasoning = if said_reasoning == NONE { reasoning.load(Ordering::Relaxed) } else { said_reasoning };
        let prompt = said_prompt.load(Ordering::Relaxed);
        on(Seen::Made(Made {
            tokens,
            reasoning: reasoning.min(tokens),
            secs: secs_between(first, last_token.load(Ordering::Relaxed)),
            prompt_tokens: (prompt != NONE).then_some(prompt),
            prompt_secs: secs_between(0, first),
            total_secs: 0.0,
        }));
    }
    Ok(Answer { text: filter_thinking_blocks(&text), calls: calls.done(), used, cut: cut.load(Ordering::Relaxed), made: None })
}
