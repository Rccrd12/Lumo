// Claude API client: multi-turn chat with web search, and files sent as
// document/image/text blocks.
//
// Everything happens here rather than in the island: the API key never leaves
// the credential store, and file bytes never cross the IPC boundary.
//
// LUMO_ANTHROPIC_BASE_URL points the chat at an Anthropic-compatible gateway
// instead (issue #180). Only that variable is read: Claude Code's own
// ANTHROPIC_BASE_URL may name a proxy the user never meant to hand this key to.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::Url;
use serde_json::{json, Value};

use tauri::AppHandle;

use crate::chat::{self, Chat, ChatContext, ChatReply, ModelInfo};
use crate::chat_usage::{self, ChatUsage};
use crate::i18n::{t, tf};
use crate::{net, secrets};

/// Credential store entry of the Anthropic API key.
pub const KEY: &str = "anthropic-api-key";
const DEFAULT_ENDPOINT: &str = "https://api.anthropic.com/v1/messages";
const BASE_URL_VAR: &str = "LUMO_ANTHROPIC_BASE_URL";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// Server-side fallback: on a policy decline the API retries the same request on
/// a fallback model inside the same call, so the island never shows a dead end.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// The room of a supervisor's review (`complete`): a short verdict.
const REVIEW_MAX_TOKENS: u32 = 4096;
/// The room of a chat answer when the model's own ceiling isn't known (a
/// gateway without the model list): the answer streams in, so a long one
/// costs no wait for the whole of it.
const FALLBACK_MAX_TOKENS: u64 = 32_000;
/// Asked again with this room when the model refuses the one it was given.
const SMALL_MAX_TOKENS: u64 = 8_192;
/// Rounds of the user's tools (or of a paused web search) one answer may
/// take before it must answer.
const MAX_TOOL_ROUNDS: usize = 25;
/// The answer streams in: no limit on the whole of it, only on this long with
/// nothing from the API, which sends a `ping` every few seconds while it works.
const SILENCE: Duration = Duration::from_secs(180);
/// The text shown while streaming goes out at most this often.
const DELTA_INTERVAL: Duration = Duration::from_millis(1000 / 15);
/// Ceilings on one event line and on a whole streamed answer.
const MAX_EVENT: usize = 8 * 1024 * 1024;
const MAX_STREAM: usize = 64 * 1024 * 1024;
/// Text and code files are inlined; anything larger is skipped.
const MAX_INLINE_TEXT: u64 = 200_000;

pub const DEFAULT_MODEL: &str = "claude-opus-5-5";

/// The Messages endpoint: Anthropic's, or the gateway in LUMO_ANTHROPIC_BASE_URL.
/// Read once; the gateway's host (never the key) goes to the log once.
fn endpoint() -> Result<Url, String> {
    static ENDPOINT: OnceLock<Result<Url, String>> = OnceLock::new();
    ENDPOINT
        .get_or_init(|| {
            let raw = std::env::var(BASE_URL_VAR).ok().filter(|v| !v.trim().is_empty());
            let resolved = match raw {
                None => Ok(Url::parse(DEFAULT_ENDPOINT).expect("valid default endpoint")),
                Some(raw) => net::anthropic_endpoint(&raw),
            };
            match &resolved {
                Ok(url) if url.as_str() != DEFAULT_ENDPOINT => crate::log::line(format!(
                    "chat: Claude requests go to {} ({BASE_URL_VAR})",
                    net::host_for_log(url)
                )),
                Err(err) => crate::log::line(format!("chat: {err}")),
                _ => {}
            }
            resolved
        })
        .clone()
}

/// The model list endpoint next to the Messages one.
fn models_endpoint(messages: &Url) -> Url {
    let mut url = messages.clone();
    let path = url.path().trim_end_matches("/messages").to_string();
    url.set_path(&format!("{path}/models"));
    url.set_query(Some("limit=100"));
    url
}

/// The user's content blocks for one turn. The window context rides along with
/// the first message only, like ClaudeService.chat(); a file with the question
/// asked after it was added (chat::turn_context).
fn user_content(first: bool, context: Option<&ChatContext>, query: &str) -> Vec<Value> {
    let mut content: Vec<Value> = Vec::new();
    match chat::turn_context(first, context) {
        Some(ChatContext::File { name, path }) => {
            if let Some(block) = file_block(path) {
                content.push(block);
            }
            content.push(json!({ "type": "text", "text": format!("File: {name}") }));
        }
        Some(ChatContext::Window { app_name, title, url }) => {
            let line = chat::window_line(app_name, title, url.as_deref());
            content.push(json!({ "type": "text", "text": line }));
        }
        None => {}
    }
    content.push(json!({ "type": "text", "text": query }));
    content
}

/// Screenshots the user shared from the chat's screen button (screen.rs), as
/// image blocks ahead of the question, on whichever turn they were added.
fn image_blocks(images: &[String]) -> Vec<Value> {
    images.iter().filter_map(|path| file_block(path)).collect()
}

fn request_body(model: &str, system: &str, history: &[Value], user: &Value, max_tokens: u64) -> Value {
    let mut messages = history.to_vec();
    messages.push(user.clone());
    json!({
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "tools": [{ "type": "web_search_20260209", "name": "web_search", "max_uses": 5 }],
        "fallbacks": "default",
        "messages": messages,
    })
}

/// The island's tools (island_tools.rs) and the user's that are on and
/// reviewed (tools.rs), as the Messages API takes them, after its web search.
fn with_user_tools(mut body: Value, tools: &[(String, String, Value)]) -> Value {
    if let Some(list) = body["tools"].as_array_mut() {
        for (id, description, schema) in tools.iter().filter(|(id, _, _)| id != "web_search") {
            list.push(json!({ "name": id, "description": description, "input_schema": schema }));
        }
    }
    body
}

/// The tool calls of an answer that stopped for them, as the next user turn's
/// tool_result blocks: each call of the user's tools asks on the island (tools.rs).
async fn run_user_tools(app: &AppHandle, chat: &Chat, blocks: &[Value]) -> Vec<Value> {
    let mut results = Vec::new();
    for b in blocks.iter().filter(|b| b["type"] == "tool_use") {
        let id = b["id"].as_str().unwrap_or_default();
        let name = b["name"].as_str().unwrap_or_default();
        // The island says which tool runs, in place of Thinking….
        let act = if crate::github_tools::NAMES.contains(&name) {
            crate::github_tools::activity(name, &b["input"])
        } else {
            crate::claude_code::Activity::new("tool", crate::claude_code::pretty_tool(name))
        };
        chat.events().activity(app, act);
        let (text, failed) = crate::tools::call_for_chat(app, chat.id(), name, b["input"].clone(), crate::tools::Asking::Untrusted, false).await;
        results.push(json!({ "type": "tool_result", "tool_use_id": id, "content": text, "is_error": failed }));
    }
    results
}

/// The assistant's full text from a Messages API content array. Web search
/// answers interleave text with tool blocks, and citations split a sentence
/// across adjacent text blocks: every text block is kept, joined as is, and
/// only the whole trimmed.
pub fn response_text(content: &[Value]) -> Option<String> {
    let text: String = content
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect();
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// The content blocks to keep in the history and the text to show, or why there are none.
fn interpret(response: &Value) -> Result<(Vec<Value>, String), String> {
    // A policy decline comes back as HTTP 200 with stop_reason "refusal".
    if response.get("stop_reason").and_then(Value::as_str) == Some("refusal") {
        let why = response
            .pointer("/stop_details/explanation")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| t("Claude declined this one."));
        return Err(why);
    }
    let blocks = response
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| t("Unexpected API response."))?;
    let cut = response.get("stop_reason").and_then(Value::as_str) == Some("max_tokens");
    let text = response_text(&blocks).ok_or_else(|| {
        if cut {
            t("The model used all its room reasoning and wrote no answer: ask again, or turn reasoning down.")
        } else {
            t("No response text.")
        }
    })?;
    Ok((blocks, text))
}

/// The answer under the line that says it was cut at the length limit.
fn with_cut_note(text: String, response: &Value) -> String {
    if response.get("stop_reason").and_then(Value::as_str) == Some("max_tokens") {
        format!("{text}\n\n_{}_", t("The answer was cut off at the length limit: ask to continue."))
    } else {
        text
    }
}

/// One chat turn. Returns the assistant's text, or a message the island shows
/// in the note view. `usage` gets the rate limits the answer came back with
/// (chat_usage.rs), a refused one included.
pub async fn send(
    app: &AppHandle,
    chat: &Chat,
    model: &str,
    query: String,
    context: Option<ChatContext>,
    images: &[String],
    usage: &mut Option<ChatUsage>,
) -> Result<ChatReply, String> {
    let key = secrets::get(KEY).ok_or_else(|| t("API key missing. Open settings."))?;
    let endpoint = endpoint()?;

    let turn = chat.begin(chat::ANTHROPIC);
    let mut content = image_blocks(images);
    content.extend(user_content(turn.first, context.as_ref(), &query));
    let user = json!({ "role": "user", "content": content });
    // Lumo's email tools, usable only while this turn runs.
    let mail = crate::mail::ai_tools(app);
    let _mail = (!mail.is_empty()).then(crate::mail::agent_turn);
    let tools = tauri::async_runtime::spawn_blocking(move || crate::tools::chat_tools(mail, false, false)).await.unwrap_or_default();
    let system = format!("{}{}", chat::system_prompt_in(chat, true, true), chat::api_tools_note(mail));
    let room = max_tokens_for(&endpoint, &key, model).await;
    let mut body = with_user_tools(request_body(model, &system, &turn.history, &user, room), &tools);

    // Streamed: the text shows as it is written, and Stop keeps what showed.
    let shown = Mutex::new(String::new());
    let events = chat.events();
    let mut said: Vec<String> = Vec::new();
    let answer = async {
        let mut rounds = 0;
        let mut smaller = false;
        loop {
            let before = said.join("\n\n");
            let show = |text: &str| {
                let text = text.trim_start();
                let all = if before.is_empty() { text.to_string() } else if text.is_empty() { before.clone() } else { format!("{before}\n\n{text}") };
                if !all.is_empty() {
                    events.delta(app, &all);
                }
                *shown.lock().unwrap_or_else(|p| p.into_inner()) = all;
            };
            let response = match stream_call(&endpoint, &key, &body, usage, show).await {
                Ok(response) => response,
                // A model with a smaller ceiling than its list said (or a gateway's).
                Err(Failed::Status(400, e)) if !smaller && e.contains("max_tokens") => {
                    smaller = true;
                    body["max_tokens"] = json!(SMALL_MAX_TOKENS);
                    continue;
                }
                Err(e) => return Err(e.to_string()),
            };
            let stop = response["stop_reason"].as_str().unwrap_or_default();
            let stopped_for_tools = stop == "tool_use" && !tools.is_empty();
            // A long web search hands the turn back halfway: sent again as it is, it goes on.
            let paused = stop == "pause_turn";
            if !(stopped_for_tools || paused) || rounds == MAX_TOOL_ROUNDS {
                return Ok::<_, String>(response);
            }
            rounds += 1;
            let blocks = response["content"].as_array().cloned().unwrap_or_default();
            if let Some(text) = response_text(&blocks) {
                said.push(text);
            }
            let results = if stopped_for_tools { run_user_tools(app, chat, &blocks).await } else { Vec::new() };
            if let Some(messages) = body["messages"].as_array_mut() {
                messages.push(json!({ "role": "assistant", "content": blocks }));
                if !results.is_empty() {
                    messages.push(json!({ "role": "user", "content": results }));
                }
            }
        }
    };
    let plain = chat::plain_question(turn.first, context.as_ref(), &query);
    let Some(response) = chat.unless_stopped(answer).await else {
        // Stopped: what showed stays, in the chat and in the conversation.
        let shown = shown.into_inner().unwrap_or_else(|p| p.into_inner()).trim().to_string();
        if !shown.is_empty() {
            chat.commit(&turn, user, json!({ "role": "assistant", "content": shown }), &plain, &shown);
        }
        return Ok(ChatReply::stopped(shown, None));
    };
    let response = response?;
    let (blocks, text) = interpret(&response)?;
    let text = with_cut_note(text, &response);

    // Store the whole content — tool_use / tool_result blocks included — so the
    // next turn has the right context. After the user's tools, the answer is
    // kept as its text: the calls and their results stay with this turn.
    if said.is_empty() {
        chat.commit(&turn, user, json!({ "role": "assistant", "content": blocks }), &plain, &text);
        return Ok(ChatReply::answer(text, None));
    }
    said.push(text);
    let text = said.join("\n\n");
    chat.commit(&turn, user, json!({ "role": "assistant", "content": text }), &plain, &text);
    Ok(ChatReply::answer(text, None))
}

/// One question with no conversation and no tools: the supervisor's review
/// of a tool (tool_review.rs).
pub async fn complete(model: &str, system: &str, prompt: &str) -> Result<String, String> {
    let key = secrets::get(KEY).ok_or_else(|| t("API key missing. Open settings."))?;
    let endpoint = endpoint()?;
    let body = json!({
        "model": model,
        "max_tokens": REVIEW_MAX_TOKENS,
        "system": system,
        "messages": [{ "role": "user", "content": prompt }],
    });
    let response = call(&endpoint, &key, &body, &mut None).await?;
    Ok(interpret(&response)?.1)
}

async fn call(endpoint: &Url, key: &str, body: &Value, usage: &mut Option<ChatUsage>) -> Result<Value, String> {
    let response = net::client(endpoint, Duration::from_secs(90))?
        .post(endpoint.clone())
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", FALLBACK_BETA)
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| tf("Network error: {error}", &[("error", &e.to_string())]))?;

    // Every answer, a 429 too, says what is left: no call of its own for it.
    *usage = chat_usage::from_anthropic(response.headers());
    let status = response.status();
    if !status.is_success() {
        // Surface the API's own message, which is what makes a bad key obvious.
        let body = net::read_capped(response, net::MAX_ERROR_BODY).await.unwrap_or_default();
        return Err(format!("Claude API {status}: {}", net::error_detail(&body)));
    }
    let bytes = net::read_capped(response, net::MAX_BODY).await?;
    serde_json::from_slice(&bytes).map_err(|e| tf("Bad API response: {error}", &[("error", &e.to_string())]))
}

/// Why a streamed answer failed: the API refused it (its status and words),
/// or the answer didn't arrive whole.
#[derive(Debug)]
enum Failed {
    Status(u16, String),
    Other(String),
}

impl std::fmt::Display for Failed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failed::Status(status, detail) => {
                let status = reqwest::StatusCode::from_u16(*status).map(|s| s.to_string()).unwrap_or_else(|_| status.to_string());
                write!(f, "Claude API {status}: {detail}")
            }
            Failed::Other(e) => f.write_str(e),
        }
    }
}

/// The silence of `SILENCE`, said.
fn silent() -> String {
    tf("The server sent nothing for {minutes} minutes: the answer was stopped.", &[("minutes", &(SILENCE.as_secs() / 60).to_string())])
}

/// One request, its answer read as it streams in (`stream: true`), put back
/// together as the Messages API gives it whole. `on_text` gets the answer's
/// text so far, at most 15 times a second and once more at the end.
async fn stream_call(
    endpoint: &Url,
    key: &str,
    body: &Value,
    usage: &mut Option<ChatUsage>,
    mut on_text: impl FnMut(&str),
) -> Result<Value, Failed> {
    let mut body = body.clone();
    body["stream"] = json!(true);
    let mut response = net::streaming_client(endpoint, SILENCE)
        .map_err(Failed::Other)?
        .post(endpoint.clone())
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("anthropic-beta", FALLBACK_BETA)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| Failed::Other(if e.is_timeout() { silent() } else { tf("Network error: {error}", &[("error", &e.to_string())]) }))?;

    // Every answer, a 429 too, says what is left: no call of its own for it.
    *usage = chat_usage::from_anthropic(response.headers());
    let status = response.status();
    if !status.is_success() {
        let body = net::read_capped(response, net::MAX_ERROR_BODY).await.unwrap_or_default();
        return Err(Failed::Status(status.as_u16(), net::error_detail(&body)));
    }

    let mut answer = Assembly::default();
    let mut pending: Vec<u8> = Vec::new();
    let mut total = 0usize;
    let mut last = Instant::now().checked_sub(DELTA_INTERVAL).unwrap_or_else(Instant::now);
    let mut unsent = false;
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(e) if e.is_timeout() => return Err(Failed::Other(silent())),
            Err(e) => return Err(Failed::Other(tf("Network error: {error}", &[("error", &e.to_string())]))),
        };
        total += chunk.len();
        if total > MAX_STREAM {
            return Err(Failed::Other(t("The server's answer is too large.")));
        }
        pending.extend_from_slice(&chunk);
        // Whole lines only: a chunk may end in the middle of one, or of a character.
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            unsent |= answer.line(String::from_utf8_lossy(&line).trim_end()).map_err(Failed::Other)?;
        }
        if pending.len() > MAX_EVENT {
            return Err(Failed::Other(t("The server's answer is too large.")));
        }
        if unsent && last.elapsed() >= DELTA_INTERVAL {
            unsent = false;
            last = Instant::now();
            on_text(&answer.text);
        }
        if answer.over {
            break;
        }
    }
    // A last line without its newline.
    answer.line(String::from_utf8_lossy(&pending).trim_end()).map_err(Failed::Other)?;
    on_text(&answer.text);
    answer.finish()
}

/// A streamed answer put back together: the message of `message_start`, its
/// content blocks as their `content_block_*` events build them, and the stop
/// reason of `message_delta`.
#[derive(Default)]
struct Assembly {
    message: Option<Value>,
    blocks: Vec<Value>,
    /// The JSON of each tool call's input, as its pieces come (`input_json_delta`).
    inputs: HashMap<usize, String>,
    /// The text of the answer so far, every text block's.
    text: String,
    /// `message_stop` came.
    over: bool,
}

impl Assembly {
    /// One line of the event stream; true when the text grew.
    fn line(&mut self, line: &str) -> Result<bool, String> {
        let Some(data) = line.strip_prefix("data:") else { return Ok(false) };
        let Ok(event) = serde_json::from_str::<Value>(data.trim()) else { return Ok(false) };
        self.event(&event)
    }

    /// One event; true when the text grew.
    fn event(&mut self, event: &Value) -> Result<bool, String> {
        let index = event["index"].as_u64().map(|i| i as usize);
        match event["type"].as_str().unwrap_or_default() {
            "message_start" => self.message = Some(event["message"].clone()),
            "content_block_start" => {
                let Some(i) = index.filter(|i| *i < 4096) else { return Ok(false) };
                while self.blocks.len() <= i {
                    self.blocks.push(Value::Null);
                }
                self.blocks[i] = event["content_block"].clone();
                // A text block may open with text of its own.
                if let Some(text) = self.blocks[i]["text"].as_str().filter(|t| !t.is_empty() && self.blocks[i]["type"] == "text") {
                    self.text.push_str(text);
                    return Ok(true);
                }
            }
            "content_block_delta" => {
                let Some(block) = index.and_then(|i| self.blocks.get_mut(i)) else { return Ok(false) };
                let delta = &event["delta"];
                let add = |block: &mut Value, field: &str, more: &str| {
                    let joined = format!("{}{more}", block[field].as_str().unwrap_or_default());
                    block[field] = json!(joined);
                };
                match delta["type"].as_str().unwrap_or_default() {
                    "text_delta" => {
                        let more = delta["text"].as_str().unwrap_or_default();
                        add(block, "text", more);
                        self.text.push_str(more);
                        return Ok(!more.is_empty());
                    }
                    "input_json_delta" => {
                        let i = index.unwrap_or_default();
                        self.inputs.entry(i).or_default().push_str(delta["partial_json"].as_str().unwrap_or_default());
                    }
                    "thinking_delta" => add(block, "thinking", delta["thinking"].as_str().unwrap_or_default()),
                    "signature_delta" => add(block, "signature", delta["signature"].as_str().unwrap_or_default()),
                    "citations_delta" => {
                        if !block["citations"].is_array() {
                            block["citations"] = json!([]);
                        }
                        if let Some(list) = block["citations"].as_array_mut() {
                            list.push(delta["citation"].clone());
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                if let Some(i) = index {
                    if let (Some(json), Some(block)) = (self.inputs.remove(&i), self.blocks.get_mut(i)) {
                        block["input"] = if json.trim().is_empty() { json!({}) } else { serde_json::from_str(&json).unwrap_or_else(|_| json!({})) };
                    }
                }
            }
            "message_delta" => {
                if let Some(message) = self.message.as_mut() {
                    if let Some(delta) = event["delta"].as_object() {
                        for (k, v) in delta {
                            message[k] = v.clone();
                        }
                    }
                    if let Some(used) = event["usage"].as_object() {
                        for (k, v) in used {
                            message["usage"][k] = v.clone();
                        }
                    }
                }
            }
            "message_stop" => self.over = true,
            "error" => {
                let message = event.pointer("/error/message").and_then(Value::as_str).unwrap_or("error");
                return Err(format!("Claude API: {message}"));
            }
            _ => {}
        }
        Ok(false)
    }

    /// The whole message, as the API gives it unstreamed.
    fn finish(mut self) -> Result<Value, Failed> {
        let Some(mut message) = self.message.take().filter(|_| self.over) else {
            return Err(Failed::Other(tf("Network error: {error}", &[("error", "the answer stopped halfway")])));
        };
        // Pieces of a tool call whose block never closed.
        for (i, json) in std::mem::take(&mut self.inputs) {
            if let Some(block) = self.blocks.get_mut(i) {
                block["input"] = serde_json::from_str(&json).unwrap_or_else(|_| json!({}));
            }
        }
        message["content"] = Value::Array(self.blocks.into_iter().filter(|b| !b.is_null()).collect());
        Ok(message)
    }
}

/// The longest answer `model` may write, as the model list says (`max_tokens`),
/// asked once per model: the whole of it is the answer's room.
async fn max_tokens_for(endpoint: &Url, key: &str, model: &str) -> u64 {
    static KNOWN: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(Default::default);
    if let Some(n) = KNOWN.lock().unwrap_or_else(|p| p.into_inner()).get(model) {
        return *n;
    }
    let Some(n) = model_max_tokens(endpoint, key, model).await else { return FALLBACK_MAX_TOKENS };
    KNOWN.lock().unwrap_or_else(|p| p.into_inner()).insert(model.to_string(), n);
    n
}

async fn model_max_tokens(endpoint: &Url, key: &str, model: &str) -> Option<u64> {
    let mut url = models_endpoint(endpoint);
    url.set_query(None);
    url.path_segments_mut().ok()?.push(model);
    let response = net::client(&url, Duration::from_secs(10))
        .ok()?
        .get(url.clone())
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let bytes = net::read_capped(response, net::MAX_ERROR_BODY).await.ok()?;
    serde_json::from_slice::<Value>(&bytes).ok()?["max_tokens"].as_u64().filter(|n| *n >= 1024)
}

/// The models on the user's Anthropic account, newest first, as the API lists them.
pub async fn models(key: &str) -> Result<Vec<ModelInfo>, String> {
    let url = models_endpoint(&endpoint()?);
    let response = net::client(&url, Duration::from_secs(10))?
        .get(url.clone())
        .header("x-api-key", key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .send()
        .await
        .map_err(|e| tf("Network error: {error}", &[("error", &e.to_string())]))?;
    let status = response.status();
    if !status.is_success() {
        let body = net::read_capped(response, net::MAX_ERROR_BODY).await.unwrap_or_default();
        return Err(format!("Claude API {status}: {}", net::error_detail(&body)));
    }
    let bytes = net::read_capped(response, net::MAX_BODY).await?;
    let json: Value = serde_json::from_slice(&bytes).map_err(|_| t("Unexpected API response."))?;
    Ok(parse_models(&json))
}

fn parse_models(json: &Value) -> Vec<ModelInfo> {
    json.get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let id = m.get("id")?.as_str()?.to_string();
            let label = m.get("display_name").and_then(Value::as_str).unwrap_or(&id).to_string();
            Some(ModelInfo { id, label })
        })
        .collect()
}

/// PDF → document block, image → image block, text/code → inline text.
fn file_block(path: &str) -> Option<Value> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    let media_type = match ext.as_str() {
        "pdf" => Some(("document", "application/pdf")),
        "jpg" | "jpeg" => Some(("image", "image/jpeg")),
        "png" => Some(("image", "image/png")),
        "gif" => Some(("image", "image/gif")),
        "webp" => Some(("image", "image/webp")),
        _ => None,
    };

    if let Some((block_type, media)) = media_type {
        let bytes = std::fs::read(path).ok()?;
        return Some(json!({
            "type": block_type,
            "source": { "type": "base64", "media_type": media, "data": base64(&bytes) },
        }));
    }

    let len = std::fs::metadata(path).ok()?.len();
    if len > MAX_INLINE_TEXT {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    Some(json!({ "type": "text", "text": format!("File contents:\n{text}") }))
}

/// Small standalone base64 encoder — not worth another dependency.
/// Also used for Stripe's basic auth and the images sent to other providers.
pub(crate) fn base64_for(bytes: &[u8]) -> String {
    base64(bytes)
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    fn texts(parts: &[&str]) -> Vec<Value> {
        parts.iter().map(|t| json!({ "type": "text", "text": t })).collect()
    }

    #[test]
    fn every_text_block_is_kept_in_order_without_added_separators() {
        assert_eq!(response_text(&texts(&["Simple answer."])).as_deref(), Some("Simple answer."));
        let content = vec![
            json!({"type":"text","text":"I'll look that up.\n"}),
            json!({"type":"server_tool_use","id":"srvtoolu_01","name":"web_search","input":{"query":"test"}}),
            json!({"type":"web_search_tool_result","tool_use_id":"srvtoolu_01","content":[]}),
            json!({"type":"text","text":"The answer is 42."}),
        ];
        assert_eq!(response_text(&content).as_deref(), Some("I'll look that up.\nThe answer is 42."));
        // An empty leading block does not hide the answer.
        let content = vec![
            json!({"type":"text","text":""}),
            json!({"type":"web_search_tool_result","tool_use_id":"b","content":[]}),
            json!({"type":"text","text":"Here is the actual answer."}),
        ];
        assert_eq!(response_text(&content).as_deref(), Some("Here is the actual answer."));
        // Citations split a sentence across blocks: no newline is inserted.
        assert_eq!(
            response_text(&texts(&["Paris is the ", "capital", " of France."])).as_deref(),
            Some("Paris is the capital of France.")
        );
        // Search result text never leaks into the answer.
        let content = vec![
            json!({"type":"text","text":"Answer."}),
            json!({"type":"web_search_tool_result","tool_use_id":"a","content":[{"type":"web_search_result","title":"Page","text":"Leak"}]}),
        ];
        assert_eq!(response_text(&content).as_deref(), Some("Answer."));
        assert_eq!(response_text(&[json!({"type":"server_tool_use","id":"x"})]), None);
        assert_eq!(response_text(&texts(&["", "  \n"])), None);
    }

    /// The lines of a stream, fed one by one, then the whole message.
    fn assemble(lines: &[&str]) -> (Result<Value, Failed>, Vec<String>) {
        let mut a = Assembly::default();
        let mut texts = Vec::new();
        for line in lines {
            if a.line(line).unwrap() {
                texts.push(a.text.clone());
            }
        }
        (a.finish(), texts)
    }

    #[test]
    fn a_streamed_answer_is_put_back_together_as_the_whole_one() {
        let (message, texts) = assemble(&[
            "event: message_start",
            r#"data: {"type":"message_start","message":{"id":"m","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}}}"#,
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig"}}"#,
            r#"data: {"type":"content_block_stop","index":0}"#,
            "event: ping",
            r#"data: {"type":"ping"}"#,
            r#"data: {"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"s1","name":"web_search","input":{}}}"#,
            r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"query\": \"ta"}}"#,
            r#"data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"uri\"}"}}"#,
            r#"data: {"type":"content_block_stop","index":1}"#,
            r#"data: {"type":"content_block_start","index":2,"content_block":{"type":"web_search_tool_result","tool_use_id":"s1","content":[{"type":"web_search_result","title":"T","url":"https://e.x"}]}}"#,
            r#"data: {"type":"content_block_stop","index":2}"#,
            r#"data: {"type":"content_block_start","index":3,"content_block":{"type":"text","text":""}}"#,
            r#"data: {"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"Tauri 2.6 "}}"#,
            r#"data: {"type":"content_block_delta","index":3,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","url":"https://e.x"}}}"#,
            r#"data: {"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"adds windows."}}"#,
            r#"data: {"type":"content_block_stop","index":3}"#,
            r#"data: {"type":"content_block_start","index":4,"content_block":{"type":"tool_use","id":"t1","name":"read_file","input":{}}}"#,
            r#"data: {"type":"content_block_stop","index":4}"#,
            r#"data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":42}}"#,
            r#"data: {"type":"message_stop"}"#,
        ]);
        let message = message.unwrap();
        assert_eq!(texts, ["Tauri 2.6 ", "Tauri 2.6 adds windows."]);
        assert_eq!(message["stop_reason"], "tool_use");
        assert_eq!(message["usage"]["output_tokens"], 42);
        assert_eq!(message["usage"]["input_tokens"], 10);
        let content = message["content"].as_array().unwrap();
        assert_eq!(content.len(), 5);
        assert_eq!(content[0], json!({"type":"thinking","thinking":"","signature":"sig"}));
        assert_eq!(content[1]["input"], json!({"query":"tauri"}));
        assert_eq!(content[2]["content"][0]["title"], "T");
        assert_eq!(content[3]["text"], "Tauri 2.6 adds windows.");
        assert_eq!(content[3]["citations"][0]["url"], "https://e.x");
        assert_eq!(content[4]["input"], json!({}), "a call with no input pieces");
        assert_eq!(response_text(content).as_deref(), Some("Tauri 2.6 adds windows."));
    }

    #[test]
    fn a_stream_that_breaks_off_or_errs_is_an_error() {
        let (message, _) = assemble(&[
            r#"data: {"type":"message_start","message":{"content":[]}}"#,
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Half"}}"#,
        ]);
        assert!(message.is_err(), "no message_stop: the answer stopped halfway");
        let mut a = Assembly::default();
        let e = a.line(r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#).unwrap_err();
        assert_eq!(e, "Claude API: Overloaded");
    }

    #[test]
    fn an_answer_cut_at_the_length_limit_says_so() {
        let cut = json!({"stop_reason":"max_tokens","content":[{"type":"text","text":"Half of it"}]});
        let (_, text) = interpret(&cut).unwrap();
        assert_eq!(with_cut_note(text, &cut), "Half of it\n\n_The answer was cut off at the length limit: ask to continue._");
        let whole = json!({"stop_reason":"end_turn","content":[{"type":"text","text":"All of it"}]});
        assert_eq!(with_cut_note("All of it".into(), &whole), "All of it");
        let thought_only = json!({"stop_reason":"max_tokens","content":[{"type":"thinking","thinking":"","signature":"s"}]});
        assert!(interpret(&thought_only).unwrap_err().contains("reasoning"));
    }

    #[test]
    fn a_status_failure_reads_like_the_unstreamed_one() {
        assert_eq!(Failed::Status(400, "max_tokens: too large".into()).to_string(), "Claude API 400 Bad Request: max_tokens: too large");
    }

    #[test]
    fn a_refusal_or_an_empty_answer_is_an_error() {
        let refusal = json!({"stop_reason":"refusal","stop_details":{"explanation":"Not this."},"content":[]});
        assert_eq!(interpret(&refusal).unwrap_err(), "Not this.");
        assert_eq!(interpret(&json!({"stop_reason":"refusal"})).unwrap_err(), "Claude declined this one.");
        assert_eq!(interpret(&json!({"id":"x"})).unwrap_err(), "Unexpected API response.");
        assert_eq!(interpret(&json!({"content":[]})).unwrap_err(), "No response text.");
        let (blocks, text) = interpret(&json!({"content":[{"type":"text","text":" Hi "}]})).unwrap();
        assert_eq!(text, "Hi");
        assert_eq!(blocks.len(), 1);
    }

    #[test]
    fn the_request_carries_history_web_search_and_the_new_turn_last() {
        let history = vec![json!({"role":"user","content":"a"}), json!({"role":"assistant","content":"b"})];
        let user = json!({"role":"user","content":[{"type":"text","text":"c"}]});
        let body = request_body("claude-x", "sys", &history, &user, 64_000);
        assert_eq!(body["model"], "claude-x");
        assert_eq!(body["system"], "sys");
        assert_eq!(body["max_tokens"], 64_000);
        assert_eq!(body["tools"][0]["name"], "web_search");
        assert_eq!(body["messages"].as_array().unwrap().len(), 3);
        assert_eq!(body["messages"][2], user);
    }

    #[test]
    fn screenshots_become_image_blocks() {
        let dir = std::env::temp_dir().join(format!("lumo-claude-shots-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("screenshot-screen1.png");
        std::fs::write(&png, [0x89, b'P', b'N', b'G']).unwrap();
        let blocks = image_blocks(&[png.to_string_lossy().to_string(), "/no/such.png".into()]);
        assert_eq!(blocks.len(), 1, "a missing file is skipped");
        assert_eq!(blocks[0]["type"], "image");
        assert_eq!(blocks[0]["source"]["media_type"], "image/png");
        assert!(image_blocks(&[]).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_window_is_sent_with_the_first_turn_only() {
        let ctx = ChatContext::Window { app_name: "Edge".into(), title: "Docs".into(), url: Some("https://x.dev".into()) };
        let first = user_content(true, Some(&ctx), "q");
        assert_eq!(first.len(), 2);
        assert_eq!(first[0]["text"], "Context — App: Edge, Window: Docs, URL: https://x.dev");
        assert_eq!(user_content(false, Some(&ctx), "q"), vec![json!({"type":"text","text":"q"})]);
        // A file that cannot be read still names itself.
        let ctx = ChatContext::File { name: "gone.pdf".into(), path: "/no/such/gone.pdf".into() };
        assert_eq!(user_content(true, Some(&ctx), "q")[0]["text"], "File: gone.pdf");
    }

    #[test]
    fn the_model_list_sits_next_to_the_messages_endpoint() {
        let url = Url::parse(DEFAULT_ENDPOINT).unwrap();
        assert_eq!(models_endpoint(&url).as_str(), "https://api.anthropic.com/v1/models?limit=100");
        let url = net::anthropic_endpoint("https://gw.example.com/anthropic").unwrap();
        assert_eq!(models_endpoint(&url).as_str(), "https://gw.example.com/anthropic/v1/models?limit=100");
        let list = json!({"data":[{"id":"claude-opus-5","display_name":"Claude Opus 5"},{"id":"claude-x"},{"nope":1}]});
        assert_eq!(
            parse_models(&list),
            vec![
                ModelInfo { id: "claude-opus-5".into(), label: "Claude Opus 5".into() },
                ModelInfo { id: "claude-x".into(), label: "claude-x".into() },
            ]
        );
    }
}
