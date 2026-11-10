// Cloud providers that speak the OpenAI chat completions API: OpenAI, Google AI
// (Gemini's OpenAI-compatible endpoint) and
// OpenRouter. One table describes them; one client talks to all three.
//
// Same contract as claude.rs: the key never leaves the credential store and
// file bytes never cross the IPC boundary. The only tools sent are the user's
// own (the Tools tab, tools.rs), each call asked for on the island; a model
// that can't take tools is asked again without them.
//
// The answer streams in and is put back together as the whole one would be,
// with what each provider adds for the next request (Gemini's thought
// signatures, OpenRouter's reasoning details); a model the account may not
// stream is asked again for the whole answer.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::Url;
use serde_json::{json, Value};

use tauri::AppHandle;

use crate::chat::{self, Chat, ChatContext, ChatReply, ModelInfo};
use crate::chat_usage::{self, ChatUsage};
use crate::i18n::{t, tf};
use crate::{net, secrets};
use lumo_local::sse::{filter_thinking_blocks, progressive_filter};

pub struct Provider {
    pub id: &'static str,
    pub name: &'static str,
    pub base_url: &'static str,
    /// Credential store entry of its API key.
    pub key: &'static str,
    /// Relative to `base_url`.
    pub models_path: &'static str,
    pub default_model: &'static str,
    /// Model ids containing any of these are not chat models.
    pub not_chat: &'static [&'static str],
    /// OpenAI's reasoning models refuse `max_tokens` and want
    /// `max_completion_tokens`; the compatible APIs take the older name. A
    /// chat answer sends neither (the model's own ceiling holds): only a
    /// supervisor's review, and an answer the credits can't pay for whole.
    pub max_tokens_field: &'static str,
}

pub const PROVIDERS: &[Provider] = &[
    Provider {
        id: "openai",
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
        key: "openai-api-key",
        models_path: "models",
        default_model: "gpt-4o",
        not_chat: &[
            "embed", "tts", "whisper", "dall-e", "audio", "realtime", "moderat", "codex",
            "computer-use", "transcribe", "image", "sora", "babbage", "davinci", "instruct",
        ],
        max_tokens_field: "max_completion_tokens",
    },
    Provider {
        id: "google",
        name: "Google AI",
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        key: "google-api-key",
        models_path: "models",
        default_model: "gemini-2.0-flash",
        not_chat: &["embed", "imagen", "veo", "aqa", "tts", "audio", "live"],
        max_tokens_field: "max_tokens",
    },
    Provider {
        id: "openrouter",
        name: "OpenRouter",
        base_url: "https://openrouter.ai/api/v1",
        key: "openrouter-api-key",
        models_path: "models",
        default_model: "openrouter/auto",
        not_chat: &[],
        max_tokens_field: "max_tokens",
    },
];

pub fn provider(id: &str) -> Option<&'static Provider> {
    PROVIDERS.iter().find(|p| p.id == id)
}

/// The room of a supervisor's review (`complete`): a short verdict.
const REVIEW_MAX_TOKENS: u32 = 4096;
/// Rounds of the user's tools one answer may take before it must answer.
const MAX_TOOL_ROUNDS: usize = 25;
/// A whole answer (a supervisor's review, or a model that may not stream):
/// a reasoning model may think for minutes first, and a request ended before
/// it answers is paid for all the same.
const WHOLE_ANSWER: Duration = Duration::from_secs(10 * 60);
/// A chat answer streams in: no limit on the whole of it, only on this long
/// with nothing from the server.
const SILENCE: Duration = Duration::from_secs(180);
/// The text shown while streaming goes out at most this often.
const DELTA_INTERVAL: Duration = Duration::from_millis(1000 / 15);
/// Ceilings on one event line and on a whole streamed answer.
const MAX_EVENT: usize = 8 * 1024 * 1024;
const MAX_STREAM: usize = 64 * 1024 * 1024;
/// Text and code files are inlined; anything larger is skipped.
const MAX_INLINE_TEXT: u64 = 200_000;
/// Images are sent inline as data URLs; past this size they are skipped.
const MAX_IMAGE: u64 = 5_000_000;

pub(crate) fn url(p: &Provider, tail: &str) -> Result<Url, String> {
    let base = Url::parse(p.base_url).map_err(|e| e.to_string())?;
    Url::parse(&net::join(&base, tail)).map_err(|e| e.to_string())
}

/// The user's message for one turn: plain text, or text and an image part
/// when the turn carries a dropped picture.
pub(crate) fn user_message(first: bool, context: Option<&ChatContext>, query: &str, pdf: PdfAs) -> Value {
    let mut prefix = String::new();
    let mut leading = Vec::new();
    match chat::turn_context(first, context) {
        Some(ChatContext::File { name, path }) => match file_part(path, pdf) {
            Some(FilePart::Image(part)) => {
                leading.push(part);
                prefix = format!("File: {name}\n\n");
            }
            Some(FilePart::Text(body)) => prefix = format!("File: {name}\nFile contents:\n{body}\n\n"),
            Some(FilePart::Pdf { parts, text }) => {
                prefix = match text {
                    Some(body) => format!("File: {name}\nFile contents:\n{body}\n\n"),
                    None => format!("File: {name}\n\n"),
                };
                leading = parts;
            }
            None if is_pdf(path) => prefix = format!("File: {name}\n{PDF_UNREAD}\n\n"),
            None => prefix = format!("File: {name}\n\n"),
        },
        Some(ChatContext::Window { app_name, title, url }) => {
            prefix = format!("{}\n\n", chat::window_line(app_name, title, url.as_deref()));
        }
        None => {}
    }
    let text = format!("{prefix}{query}");
    if leading.is_empty() {
        return json!({ "role": "user", "content": text });
    }
    leading.push(json!({ "type": "text", "text": text }));
    json!({ "role": "user", "content": leading })
}

/// Screenshots and files the user shared (screen.rs): image parts, and the
/// text of a text file, ahead of the message's text, on whichever turn they
/// were added.
pub(crate) fn with_images(mut user: Value, images: &[String], pdf: PdfAs) -> Value {
    let parts: Vec<Value> = images
        .iter()
        .flat_map(|path| {
            let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            match file_part(path, pdf) {
                Some(FilePart::Image(part)) => vec![part],
                Some(FilePart::Text(body)) => vec![json!({ "type": "text", "text": format!("File: {name}\nFile contents:\n{body}") })],
                Some(FilePart::Pdf { mut parts, text }) => {
                    if let Some(body) = text {
                        parts.push(json!({ "type": "text", "text": format!("File: {name}\nFile contents:\n{body}") }));
                    }
                    parts
                }
                None if is_pdf(path) => vec![json!({ "type": "text", "text": format!("File: {name}\n{PDF_UNREAD}") })],
                None => Vec::new(),
            }
        })
        .collect();
    if parts.is_empty() {
        return user;
    }
    let rest = match user["content"].take() {
        Value::Array(items) => items,
        Value::String(text) => vec![json!({ "type": "text", "text": text })],
        other => vec![other],
    };
    user["content"] = Value::Array(parts.into_iter().chain(rest).collect());
    user
}

fn request_body(model: &str, system: &str, history: &[Value], user: &Value) -> Value {
    let mut messages = vec![json!({ "role": "system", "content": system })];
    messages.extend(history.iter().cloned());
    messages.push(user.clone());
    json!({ "model": model, "messages": messages })
}

/// The answer's tokens OpenRouter says the credits pay for, when it refused
/// the request for the model's whole ceiling ("…but can only afford 7461").
fn affordable(error: &str) -> Option<u64> {
    let at = error.find("can only afford")? + "can only afford".len();
    let n: String = error[at..].trim_start().chars().take_while(char::is_ascii_digit).collect();
    n.parse().ok().filter(|n| *n >= 256)
}

/// Whether the answer stopped at the length limit (`finish_reason: length`).
fn cut(response: &Value) -> bool {
    response.pointer("/choices/0/finish_reason").and_then(Value::as_str) == Some("length")
}

/// The answer's text, or the error the provider put in a 200 reply
/// (OpenRouter does when the upstream model fails).
fn reply_text(p: &Provider, response: &Value) -> Result<String, String> {
    let text = response
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if !text.is_empty() {
        return Ok(text);
    }
    if let Some(msg) = response.pointer("/error/message").and_then(Value::as_str) {
        return Err(format!("{}: {msg}", p.name));
    }
    if cut(response) {
        return Err(t("The model used all its room reasoning and wrote no answer: ask again, or turn reasoning down."));
    }
    Err(t("No response text."))
}

fn status_error(p: &Provider, status: u16, detail: &str) -> String {
    match status {
        401 | 403 => tf(
            "{name} rejected the API key ({status}). Check it in Settings.",
            &[("name", p.name), ("status", &status.to_string())],
        ),
        402 => tf("{name}: not enough credits (402). {detail}", &[("name", p.name), ("detail", detail)]),
        404 => tf(
            "{name}: model not found (404). Pick another one above the chat box. {detail}",
            &[("name", p.name), ("detail", detail)],
        ),
        429 => tf("{name} rate limit reached (429): {detail}", &[("name", p.name), ("detail", detail)]),
        _ => format!("{} {status}: {detail}", p.name),
    }
}

/// One chat turn with a cloud provider. For OpenAI, `usage` gets the rate
/// limits the answer came back with (chat_usage.rs).
#[allow(clippy::too_many_arguments)]
pub async fn send(
    app: &AppHandle,
    chat: &Chat,
    p: &'static Provider,
    model: &str,
    query: String,
    context: Option<ChatContext>,
    images: &[String],
    usage: &mut Option<ChatUsage>,
) -> Result<ChatReply, String> {
    let key = secrets::get(p.key).ok_or_else(|| tf("{name} API key missing. Add it in Settings.", &[("name", p.name)]))?;
    if model.is_empty() {
        return Err(tf("Pick a {name} model above the chat box.", &[("name", p.name)]));
    }
    let turn = chat.begin(p.id);
    let pdf = if matches!(p.id, "openai" | "openrouter") { PdfAs::File } else { PdfAs::TextAndPages { pages: MAX_PDF_PAGES, chars: MAX_PDF_CHARS } };
    let user = with_images(user_message(turn.first, context.as_ref(), &query, pdf), images, pdf);
    // Lumo's email tools, usable only while this turn runs.
    let mail = crate::mail::ai_tools(app);
    let _mail = (!mail.is_empty()).then(crate::mail::agent_turn);
    // Lumo's own web search, when the user turned it on (web_search.rs).
    let web = tauri::async_runtime::spawn_blocking(crate::web_search::enabled).await.unwrap_or(false);
    let system = format!("{}{}{}", chat::system_prompt_in(chat, web, true), chat::api_tools_note(mail), if web { crate::web_search::NOTE } else { "" });
    let mut body = request_body(model, &system, &turn.history, &user);
    let tools = tauri::async_runtime::spawn_blocking(move || crate::tools::chat_tools(mail, web, false)).await.unwrap_or_default();
    if !tools.is_empty() {
        body["tools"] = function_tools(&tools);
    }
    let endpoint = url(p, "chat/completions")?;

    // Streamed: the text shows as it is written, and Stop keeps what showed.
    let shown = Mutex::new(String::new());
    let events = chat.events();
    let mut said: Vec<String> = Vec::new();
    let answer = async {
        let mut rounds = 0;
        let mut capped = false;
        let mut streaming = true;
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
            let sent = if streaming { stream_post(p, &endpoint, &key, &body, usage, show).await } else { post(p, &endpoint, &key, &body, usage).await };
            let mut json = match sent {
                // A model this account may not stream (OpenAI asks some
                // organisations to be verified first): the whole answer, at once.
                Err((400, e)) if streaming && e.to_lowercase().contains("stream") => {
                    streaming = false;
                    continue;
                }
                // The credits don't cover the model's whole ceiling: the answer
                // gets the room they pay for (OpenRouter says how much).
                Err((402, e)) if !capped && affordable(&e).is_some() => {
                    capped = true;
                    body[p.max_tokens_field] = json!(affordable(&e));
                    continue;
                }
                // A model that takes no tools refuses the request: once more without them.
                // Only on the first request: later ones carry the tools' answers,
                // which no server takes without the tools they answer.
                Err((400 | 404 | 422, _)) if rounds == 0 && body.get("tools").is_some() => {
                    body.as_object_mut().map(|b| b.remove("tools"));
                    continue;
                }
                other => other.map_err(|(_, e)| e)?,
            };
            // Reasoning written in the text (Gemma's `<thought>`) is never shown, nor sent back.
            if let Some(content) = json.pointer_mut("/choices/0/message/content").filter(|c| c.is_string()) {
                *content = json!(filter_thinking_blocks(content.as_str().unwrap_or_default()));
            }
            let message = json.pointer("/choices/0/message").cloned().unwrap_or(Value::Null);
            let calls = message["tool_calls"].as_array().cloned().unwrap_or_default();
            if calls.is_empty() || body.get("tools").is_none() || rounds == MAX_TOOL_ROUNDS {
                return Ok::<_, String>(json);
            }
            rounds += 1;
            if let Some(text) = message["content"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
                said.push(text.to_string());
            }
            let mut turn_messages = vec![message.clone()];
            for call in &calls {
                let name = call.pointer("/function/name").and_then(Value::as_str).unwrap_or_default();
                let input = call.pointer("/function/arguments").and_then(Value::as_str).and_then(|a| serde_json::from_str(a).ok()).unwrap_or_else(|| json!({}));
                // The island says which tool runs, in place of Thinking….
                let act = if crate::web_search::NAMES.contains(&name) {
                    crate::web_search::activity(name)
                } else if crate::github_tools::NAMES.contains(&name) {
                    crate::github_tools::activity(name, &input)
                } else {
                    crate::claude_code::Activity::new("tool", crate::claude_code::pretty_tool(name))
                };
                chat.events().activity(app, act);
                let (text, _) = crate::tools::call_for_chat(app, chat.id(), name, input, crate::tools::Asking::Untrusted, false).await;
                turn_messages.push(json!({ "role": "tool", "tool_call_id": call["id"], "content": text }));
            }
            if let Some(messages) = body["messages"].as_array_mut() {
                messages.extend(turn_messages);
            }
        }
    };
    let plain = chat::plain_question(turn.first, context.as_ref(), &query);
    let Some(json) = chat.unless_stopped(answer).await else {
        // Stopped: what showed stays, in the chat and in the conversation.
        let shown = shown.into_inner().unwrap_or_else(|p| p.into_inner()).trim().to_string();
        if !shown.is_empty() {
            chat.commit(&turn, user, json!({ "role": "assistant", "content": shown }), &plain, &shown);
        }
        return Ok(ChatReply::stopped(shown, None));
    };
    let json = json?;
    let mut text = reply_text(p, &json)?;
    if cut(&json) {
        text = format!("{text}\n\n_{}_", t("The answer was cut off at the length limit: ask to continue."));
    }
    // After the user's tools, what was said before each call comes first.
    let text = if said.is_empty() { text } else { said.into_iter().chain([text]).collect::<Vec<_>>().join("\n\n") };

    chat.commit(&turn, user, json!({ "role": "assistant", "content": text }), &plain, &text);
    Ok(ChatReply::answer(text, None))
}

/// The island's tools (island_tools.rs) and the user's that are on and reviewed (tools.rs), as functions.
pub(crate) fn function_tools(tools: &[(String, String, Value)]) -> Value {
    Value::Array(
        tools
            .iter()
            .map(|(id, description, schema)| json!({ "type": "function", "function": { "name": id, "description": description, "parameters": schema } }))
            .collect(),
    )
}

/// One question with no conversation and no tools: the supervisor's review
/// of a tool (tool_review.rs).
pub async fn complete(p: &'static Provider, model: &str, system: &str, prompt: &str) -> Result<String, String> {
    let key = secrets::get(p.key).ok_or_else(|| tf("{name} API key missing. Add it in Settings.", &[("name", p.name)]))?;
    let user = json!({ "role": "user", "content": prompt });
    let mut body = request_body(model, system, &[], &user);
    body[p.max_tokens_field] = json!(REVIEW_MAX_TOKENS);
    let endpoint = url(p, "chat/completions")?;
    let json = post(p, &endpoint, &key, &body, &mut None).await.map_err(|(_, e)| e)?;
    reply_text(p, &json)
}

/// One request to the chat completions endpoint, its answer as JSON; an
/// error with the HTTP status (0 when there was none).
async fn post(p: &Provider, endpoint: &Url, key: &str, body: &Value, usage: &mut Option<ChatUsage>) -> Result<Value, (u16, String)> {
    let response = net::client(endpoint, WHOLE_ANSWER)
        .map_err(|e| (0, e))?
        .post(endpoint.clone())
        .bearer_auth(key)
        .json(body)
        .send()
        .await
        .map_err(|e| (0, tf("Network error: {error}", &[("error", &e.to_string())])))?;
    if p.id == "openai" {
        *usage = chat_usage::from_openai(response.headers(), chat_usage::now_ms());
    }
    let status = response.status();
    if !status.is_success() {
        let body = net::read_capped(response, net::MAX_ERROR_BODY).await.unwrap_or_default();
        return Err((status.as_u16(), status_error(p, status.as_u16(), &net::error_detail(&body))));
    }
    let bytes = net::read_capped(response, net::MAX_BODY).await.map_err(|e| (0, e))?;
    serde_json::from_slice(&bytes).map_err(|e| (0, tf("Bad API response: {error}", &[("error", &e.to_string())])))
}

/// One request, its answer read as it streams in (`stream: true`), put back
/// together as the whole answer would be (`choices[0].message`, its
/// `finish_reason`, `usage`), with what the provider adds kept as it came:
/// Gemini's thought signatures on the tool calls, OpenRouter's reasoning
/// details, which the next request must send back unchanged. `on_text` gets
/// the answer's text so far, at most 15 times a second and once more at the end.
async fn stream_post(
    p: &Provider,
    endpoint: &Url,
    key: &str,
    body: &Value,
    usage: &mut Option<ChatUsage>,
    mut on_text: impl FnMut(&str),
) -> Result<Value, (u16, String)> {
    let mut body = body.clone();
    body["stream"] = json!(true);
    let silent = || tf("The server sent nothing for {minutes} minutes: the answer was stopped.", &[("minutes", &(SILENCE.as_secs() / 60).to_string())]);
    let mut response = net::streaming_client(endpoint, SILENCE)
        .map_err(|e| (0, e))?
        .post(endpoint.clone())
        .bearer_auth(key)
        .json(&body)
        .send()
        .await
        .map_err(|e| (0, if e.is_timeout() { silent() } else { tf("Network error: {error}", &[("error", &e.to_string())]) }))?;
    if p.id == "openai" {
        *usage = chat_usage::from_openai(response.headers(), chat_usage::now_ms());
    }
    let status = response.status();
    if !status.is_success() {
        let body = net::read_capped(response, net::MAX_ERROR_BODY).await.unwrap_or_default();
        return Err((status.as_u16(), status_error(p, status.as_u16(), &net::error_detail(&body))));
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
            // The answer was over: a connection dropped after it loses nothing.
            Err(_) if answer.finish_reason.is_some() => break,
            Err(e) if e.is_timeout() => return Err((0, silent())),
            Err(e) => return Err((0, tf("Network error: {error}", &[("error", &e.to_string())]))),
        };
        total += chunk.len();
        if total > MAX_STREAM {
            return Err((0, t("The server's answer is too large.")));
        }
        pending.extend_from_slice(&chunk);
        // Whole lines only: a chunk may end in the middle of one, or of a character.
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            unsent |= answer.line(String::from_utf8_lossy(&line).trim_end()).map_err(|e| (0, format!("{}: {e}", p.name)))?;
        }
        if pending.len() > MAX_EVENT {
            return Err((0, t("The server's answer is too large.")));
        }
        if unsent && last.elapsed() >= DELTA_INTERVAL {
            unsent = false;
            last = Instant::now();
            on_text(&progressive_filter(&answer.content));
        }
        if answer.done {
            break;
        }
    }
    // A last line without its newline.
    answer.line(String::from_utf8_lossy(&pending).trim_end()).map_err(|e| (0, format!("{}: {e}", p.name)))?;
    on_text(&progressive_filter(&answer.content));
    answer.finish().ok_or_else(|| (0, tf("Network error: {error}", &[("error", "the answer stopped halfway")])))
}

/// A streamed answer put back together from its `choices[0].delta`s.
#[derive(Default)]
struct Assembly {
    content: String,
    /// The tool calls by their `index`: id, type, function, and anything
    /// else the provider puts on them (Gemini's `extra_content`).
    calls: Vec<Value>,
    /// OpenRouter's reasoning blocks, each one's pieces joined.
    reasoning_details: Vec<Value>,
    /// Other fields of the message the provider sends (kept, sent back).
    extra: serde_json::Map<String, Value>,
    finish_reason: Option<String>,
    usage: Option<Value>,
    /// Something came: an answer that ends with nothing at all is cut short.
    heard: bool,
    /// `[DONE]` came.
    done: bool,
}

/// `into` with `from`'s fields: objects merged, anything else replaced.
fn merge(into: &mut Value, from: &Value) {
    match (into, from) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                merge(a.entry(k.clone()).or_insert(Value::Null), v);
            }
        }
        (into, from) if !from.is_null() => *into = from.clone(),
        _ => {}
    }
}

/// `field` of `into` with `more` added at its end.
fn append(into: &mut Value, field: &str, more: &str) {
    let joined = format!("{}{more}", into[field].as_str().unwrap_or_default());
    into[field] = json!(joined);
}

impl Assembly {
    /// One line of the event stream; true when the text grew.
    fn line(&mut self, line: &str) -> Result<bool, String> {
        let Some(data) = line.strip_prefix("data:").map(str::trim) else { return Ok(false) };
        if data == "[DONE]" {
            self.done = true;
            return Ok(false);
        }
        let Ok(event) = serde_json::from_str::<Value>(data) else { return Ok(false) };
        self.event(&event)
    }

    /// One chunk of the answer; true when the text grew.
    fn event(&mut self, event: &Value) -> Result<bool, String> {
        if let Some(e) = event.get("error").filter(|e| !e.is_null()) {
            let message = e.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| e.to_string());
            return Err(message);
        }
        if let Some(used) = event.get("usage").filter(|u| u.is_object()) {
            self.usage = Some(used.clone());
        }
        let Some(choice) = event.pointer("/choices/0") else { return Ok(false) };
        self.heard = true;
        if let Some(reason) = choice["finish_reason"].as_str() {
            self.finish_reason = Some(reason.to_string());
        }
        let Some(delta) = choice.get("delta").and_then(Value::as_object) else { return Ok(false) };
        let mut grew = false;
        for (k, v) in delta {
            match k.as_str() {
                "role" => {}
                "content" => {
                    if let Some(more) = v.as_str() {
                        self.content.push_str(more);
                        grew |= !more.is_empty();
                    }
                }
                // Only for the island's "Thinking…": never sent back.
                "reasoning" | "reasoning_content" => {}
                "refusal" => {
                    if let Some(more) = v.as_str() {
                        let joined = format!("{}{more}", self.extra.get("refusal").and_then(Value::as_str).unwrap_or_default());
                        self.extra.insert("refusal".into(), json!(joined));
                    }
                }
                "tool_calls" => {
                    for piece in v.as_array().into_iter().flatten() {
                        let index = match piece["index"].as_u64() {
                            Some(i) => i as usize,
                            // No index (some servers): a new id is a new call, the rest goes on the last one.
                            None => {
                                let id = piece["id"].as_str().filter(|id| !id.is_empty());
                                match self.calls.last() {
                                    Some(last) if id.is_none_or(|id| last["id"] == id || last["id"] == "") => self.calls.len() - 1,
                                    _ => self.calls.len(),
                                }
                            }
                        };
                        if index > 64 {
                            continue;
                        }
                        while self.calls.len() <= index {
                            self.calls.push(json!({ "id": "", "type": "function", "function": { "name": "", "arguments": "" } }));
                        }
                        let call = &mut self.calls[index];
                        if let Some(name) = piece.pointer("/function/name").and_then(Value::as_str) {
                            append(&mut call["function"], "name", name);
                        }
                        match piece.pointer("/function/arguments") {
                            Some(Value::String(more)) => append(&mut call["function"], "arguments", more),
                            // Some servers send the arguments as an object.
                            Some(v @ Value::Object(_)) => call["function"]["arguments"] = json!(v.to_string()),
                            _ => {}
                        }
                        for (k, v) in piece.as_object().into_iter().flatten().filter(|(k, _)| !matches!(k.as_str(), "index" | "function")) {
                            merge(&mut call[k.as_str()], v);
                        }
                    }
                }
                "reasoning_details" => {
                    for piece in v.as_array().into_iter().flatten() {
                        self.reasoning_detail(piece);
                    }
                }
                _ => merge(self.extra.entry(k.clone()).or_insert(Value::Null), v),
            }
        }
        Ok(grew)
    }

    /// One piece of a reasoning block: the text of the block it continues
    /// (same type and index) grows, or a new block starts.
    fn reasoning_detail(&mut self, piece: &Value) {
        // An encrypted block comes whole: two in a row with no index are two blocks.
        let same = self.reasoning_details.last_mut().filter(|last| {
            last["type"] == piece["type"] && last.get("index") == piece.get("index") && (piece.get("index").is_some() || piece["type"] != "reasoning.encrypted")
        });
        let Some(last) = same else {
            self.reasoning_details.push(piece.clone());
            return;
        };
        for (k, v) in piece.as_object().into_iter().flatten() {
            match (k.as_str(), v.as_str()) {
                ("text" | "summary", Some(more)) => append(last, k, more),
                _ if !v.is_null() => last[k.as_str()] = v.clone(),
                _ => {}
            }
        }
    }

    /// The answer as a whole one: None when nothing came.
    fn finish(self) -> Option<Value> {
        if !self.heard {
            return None;
        }
        let calls: Vec<Value> = self.calls.into_iter().filter(|c| c.pointer("/function/name").and_then(Value::as_str).is_some_and(|n| !n.is_empty())).collect();
        let mut message = json!({ "role": "assistant" });
        for (k, v) in self.extra {
            message[k.as_str()] = v;
        }
        // Reasoning written in the text is never shown, nor sent back.
        let content = filter_thinking_blocks(&self.content);
        // A message of tool calls only has no content (an empty one is refused).
        message["content"] = if content.is_empty() && !calls.is_empty() { Value::Null } else { json!(content) };
        if !calls.is_empty() {
            message["tool_calls"] = Value::Array(calls);
        }
        if !self.reasoning_details.is_empty() {
            message["reasoning_details"] = Value::Array(self.reasoning_details);
        }
        let mut whole = json!({ "choices": [{ "index": 0, "message": message, "finish_reason": self.finish_reason }] });
        if let Some(used) = self.usage {
            whole["usage"] = used;
        }
        Some(whole)
    }
}

/// The provider's chat models. Only ever asked with the user's key, once they
/// picked this provider in the chat.
pub async fn models(p: &Provider, key: &str) -> Result<Vec<ModelInfo>, String> {
    let endpoint = url(p, p.models_path)?;
    let response = net::client(&endpoint, Duration::from_secs(15))?
        .get(endpoint)
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| tf("Network error: {error}", &[("error", &e.to_string())]))?;
    let status = response.status();
    if !status.is_success() {
        let body = net::read_capped(response, net::MAX_ERROR_BODY).await.unwrap_or_default();
        return Err(status_error(p, status.as_u16(), &net::error_detail(&body)));
    }
    let bytes = net::read_capped(response, net::MAX_BODY).await?;
    let json: Value = serde_json::from_slice(&bytes).map_err(|_| t("Unexpected API response."))?;
    Ok(parse_models(p, &json))
}

fn parse_models(p: &Provider, json: &Value) -> Vec<ModelInfo> {
    let items = json.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut models: Vec<(ModelInfo, i64, bool)> = items
        .iter()
        .filter(|m| {
            // OpenRouter lists image and audio generators too.
            m.pointer("/architecture/output_modalities")
                .and_then(Value::as_array)
                .is_none_or(|mods| mods.iter().any(|x| x.as_str() == Some("text")))
        })
        .filter_map(|m| {
            let raw = m.get("id")?.as_str()?;
            // Gemini sometimes answers "models/gemini-…".
            let id = raw.strip_prefix("models/").unwrap_or(raw).to_string();
            let lower = id.to_lowercase();
            if id.is_empty() || p.not_chat.iter().any(|x| lower.contains(x)) {
                return None;
            }
            let created = m.get("created").and_then(Value::as_i64).unwrap_or(0);
            let free = p.id == "openrouter" && is_free(m, &id);
            let name = m.get("name").and_then(Value::as_str).unwrap_or(&id);
            let label = if free && !name.to_lowercase().contains("(free)") { format!("{name} (free)") } else { name.to_string() };
            Some((ModelInfo { id, label }, created, free))
        })
        .collect();
    match p.id {
        // Newest first.
        "openai" => models.sort_by_key(|m| std::cmp::Reverse(m.1)),
        // Free models first, then by name.
        "openrouter" => models.sort_by(|a, b| {
            b.2.cmp(&a.2).then_with(|| a.0.label.to_lowercase().cmp(&b.0.label.to_lowercase()))
        }),
        _ => {}
    }
    models.into_iter().map(|(m, _, _)| m).collect()
}

fn is_free(m: &Value, id: &str) -> bool {
    let zero = |ptr: &str| {
        m.pointer(ptr)
            .and_then(Value::as_str)
            .is_some_and(|v| v.parse::<f64>().ok() == Some(0.0))
    };
    id.ends_with(":free") || (zero("/pricing/prompt") && zero("/pricing/completion"))
}

enum FilePart {
    Image(Value),
    Text(String),
    /// A PDF: the file itself or its pages as pictures, and its text.
    Pdf { parts: Vec<Value>, text: Option<String> },
}

/// How a PDF goes to a model, as its API takes it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum PdfAs {
    /// Its text (a model that doesn't see).
    Text,
    /// Its pages as pictures when it has `pages` or fewer, else its text (a
    /// model that sees, whose API takes no file: Google's, a local server).
    /// At most `chars` of its text.
    TextAndPages { pages: u32, chars: usize },
    /// The file itself (OpenAI's and OpenRouter's `file` part).
    File,
}

/// The biggest PDF sent as itself.
const MAX_PDF: u64 = 20_000_000;
/// The most of a PDF's text sent (a local model's: as much as its context has room for).
pub(crate) const MAX_PDF_CHARS: usize = 40_000;
/// A PDF of this many pages or fewer goes as pictures of them to a model that
/// sees; a longer one as its text.
pub(crate) const MAX_PDF_PAGES: u32 = 10;
/// What one page drawn 1024 pixels wide costs a model, in tokens, reckoned
/// high (Qwen's vision reads it as some 1,700; Gemma's as 256).
pub(crate) const PAGE_TOKENS: u64 = 2_000;

/// How many pages of a PDF may go as pictures to a model with `context`
/// tokens (0: not known), `taken` of them already spoken for (instructions,
/// tools, the conversation, room for the answer): as many as fit, at most
/// MAX_PDF_PAGES. A context not known is taken as a small one, 8k.
pub(crate) fn pages_that_fit(context: u64, taken: u64) -> u32 {
    let context = if context == 0 { 8_192 } else { context };
    // A tenth kept free: the reckoning is a guess.
    let free = (context - context / 10).saturating_sub(taken);
    u32::try_from(free / PAGE_TOKENS).unwrap_or(u32::MAX).min(MAX_PDF_PAGES)
}
/// Told the model of a PDF whose text couldn't be read, so it says so.
pub(crate) const PDF_UNREAD: &str = "(Lumo couldn't read this PDF: it may be a scan, protected, or damaged. Say so.)";

pub(crate) fn is_pdf(path: &str) -> bool {
    std::path::Path::new(path).extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("pdf"))
}

/// A PDF as `pdf` says: None when nothing of it could be read.
fn pdf_part(path: &str, pdf: PdfAs) -> Option<FilePart> {
    let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    if pdf == PdfAs::File && std::fs::metadata(path).ok()?.len() <= MAX_PDF {
        let bytes = std::fs::read(path).ok()?;
        let data = format!("data:application/pdf;base64,{}", crate::claude::base64_for(&bytes));
        return Some(FilePart::Pdf { parts: vec![json!({ "type": "file", "file": { "filename": name, "file_data": data } })], text: None });
    }
    let parts: Vec<Value> = match pdf {
        PdfAs::TextAndPages { pages, .. } if pages > 0 => crate::pdf_pages::render(path, pages),
        _ => Vec::new(),
    }
    .into_iter()
    .filter(|png| png.len() as u64 <= MAX_IMAGE)
    .map(|png| json!({ "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{}", crate::claude::base64_for(&png)) } }))
    .collect();
    // Its pages seen, its text isn't needed; a long PDF, or one Windows can't draw, goes as text.
    let chars = if let PdfAs::TextAndPages { chars, .. } = pdf { chars } else { MAX_PDF_CHARS };
    let text = if parts.is_empty() { crate::pdf_text::text_cut(path, chars) } else { None };
    (text.is_some() || !parts.is_empty()).then_some(FilePart::Pdf { parts, text })
}

/// Images → image_url data URL, text/code → inline text, a PDF as `pdf`
/// says. Other binary files go by name only.
fn file_part(path: &str, pdf: PdfAs) -> Option<FilePart> {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let len = std::fs::metadata(path).ok()?.len();
    let image = match ext.as_str() {
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    };
    if let Some(media) = image {
        if len > MAX_IMAGE {
            return None;
        }
        let bytes = std::fs::read(path).ok()?;
        let url = format!("data:{media};base64,{}", crate::claude::base64_for(&bytes));
        return Some(FilePart::Image(json!({ "type": "image_url", "image_url": { "url": url } })));
    }
    if ext == "pdf" {
        return pdf_part(path, pdf);
    }
    if len > MAX_INLINE_TEXT {
        return None;
    }
    std::fs::read_to_string(path).ok().map(FilePart::Text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(id: &str) -> &'static Provider {
        provider(id).unwrap()
    }

    #[test]
    fn the_table_points_at_each_providers_own_api_and_key() {
        assert_eq!(url(p("openai"), "chat/completions").unwrap().as_str(), "https://api.openai.com/v1/chat/completions");
        assert_eq!(
            url(p("google"), "chat/completions").unwrap().as_str(),
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
        );
        assert_eq!(url(p("openrouter"), "models").unwrap().as_str(), "https://openrouter.ai/api/v1/models");
        for prov in PROVIDERS {
            assert!(crate::secrets::KNOWN_KEYS.contains(&prov.key), "{}", prov.key);
            assert!(prov.base_url.starts_with("https://"));
        }
        assert!(provider("anthropic").is_none());
        assert!(provider("ollama").is_none());
    }

    #[test]
    fn the_request_is_system_then_history_then_the_new_turn() {
        let history = vec![json!({"role":"user","content":"a"}), json!({"role":"assistant","content":"b"})];
        let user = user_message(false, None, "c", PdfAs::Text);
        assert_eq!(user, json!({"role":"user","content":"c"}));
        let body = request_body("gemini-x", "sys", &history, &user);
        assert_eq!(body["model"], "gemini-x");
        assert!(body.get("max_tokens").is_none(), "the model's own ceiling holds");
        let msgs = body["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 4);
        assert_eq!(msgs[0], json!({"role":"system","content":"sys"}));
        assert_eq!(msgs[3], user);
        assert!(body.get("tools").is_none(), "chat only: no tools");
        let body = request_body("gpt-5", "sys", &[], &user);
        assert!(body.get("max_completion_tokens").is_none() && body.get("max_tokens").is_none());
        // OpenAI's reasoning models refuse the old field name.
        assert_eq!(p("openai").max_tokens_field, "max_completion_tokens");
    }

    /// The lines of a stream, fed one by one: the whole answer, and the text seen as it grew.
    fn assemble(lines: &[&str]) -> (Option<Value>, Vec<String>) {
        let mut a = Assembly::default();
        let mut texts = Vec::new();
        for line in lines {
            if a.line(line).unwrap() {
                texts.push(a.content.clone());
            }
        }
        (a.finish(), texts)
    }

    #[test]
    fn a_streamed_answer_is_the_whole_one() {
        let (whole, texts) = assemble(&[
            r#"data: {"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}"#,
            "",
            r#"data: {"choices":[{"index":0,"delta":{"content":"Ciao, "}}]}"#,
            r#"data: {"choices":[{"index":0,"delta":{"content":"tutto bene."},"finish_reason":"length"}]}"#,
            r#"data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}"#,
            "data: [DONE]",
        ]);
        let whole = whole.unwrap();
        assert_eq!(texts, ["Ciao, ", "Ciao, tutto bene."]);
        assert_eq!(reply_text(p("openai"), &whole).unwrap(), "Ciao, tutto bene.");
        assert!(cut(&whole));
        assert_eq!(whole["usage"]["total_tokens"], 8);
        assert!(whole.pointer("/choices/0/message/tool_calls").is_none());
    }

    #[test]
    fn geminis_thought_signatures_ride_back_on_their_tool_calls() {
        let (whole, _) = assemble(&[
            r#"data: {"choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":"},"extra_content":{"google":{"thought_signature":"SIG1"}}}]}}]}"#,
            r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.txt\"}"}}]}}]}"#,
            r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"list","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}"#,
            "data: [DONE]",
        ]);
        let message = whole.unwrap()["choices"][0]["message"].clone();
        assert_eq!(message["content"], Value::Null, "tool calls only: no content");
        let calls = message["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["id"], "call_1");
        assert_eq!(calls[0]["function"]["arguments"], "{\"path\":\"a.txt\"}");
        assert_eq!(calls[0]["extra_content"]["google"]["thought_signature"], "SIG1");
        assert_eq!(calls[1]["function"]["name"], "list");
        assert!(calls[1].get("extra_content").is_none());
    }

    #[test]
    fn calls_with_no_index_are_told_apart_by_their_id() {
        let (whole, _) = assemble(&[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"id":"a","function":{"name":"one","arguments":"{\"x\":"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"1}"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"id":"b","function":{"name":"two","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}"#,
        ]);
        let message = whole.unwrap()["choices"][0]["message"].clone();
        let calls = message["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["function"]["arguments"], "{\"x\":1}");
        assert_eq!(calls[1]["id"], "b");
    }

    #[test]
    fn openrouters_reasoning_details_are_joined_and_kept() {
        let (whole, texts) = assemble(&[
            ": OPENROUTER PROCESSING",
            r#"data: {"choices":[{"delta":{"reasoning":"Let me","reasoning_details":[{"type":"reasoning.text","text":"Let me","format":"anthropic-claude-v1","index":0}]}}]}"#,
            r#"data: {"choices":[{"delta":{"reasoning":" think.","reasoning_details":[{"type":"reasoning.text","text":" think.","index":0}]}}]}"#,
            r#"data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","signature":"S","index":0}]}}]}"#,
            r#"data: {"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.encrypted","data":"E1","index":1}]}}]}"#,
            r#"data: {"choices":[{"delta":{"content":"Done."},"finish_reason":"stop"}]}"#,
            "data: [DONE]",
        ]);
        assert_eq!(texts, ["Done."], "the reasoning never shows as the answer");
        let message = whole.unwrap()["choices"][0]["message"].clone();
        assert_eq!(message["content"], "Done.");
        assert!(message.get("reasoning").is_none(), "only the details go back");
        let details = message["reasoning_details"].as_array().unwrap();
        assert_eq!(details.len(), 2);
        assert_eq!(details[0], json!({"type":"reasoning.text","text":"Let me think.","format":"anthropic-claude-v1","index":0,"signature":"S"}));
        assert_eq!(details[1]["data"], "E1");
    }

    #[test]
    fn gemmas_thoughts_stay_out_of_the_answer() {
        let (whole, _) = assemble(&[
            r#"data: {"choices":[{"delta":{"content":"<thought>The user said Ciao."}}]}"#,
            r#"data: {"choices":[{"delta":{"content":"</thought>Ciao! Come posso aiutarti?"},"finish_reason":"stop"}]}"#,
        ]);
        assert_eq!(whole.unwrap()["choices"][0]["message"]["content"], "Ciao! Come posso aiutarti?");
    }

    #[test]
    fn an_error_in_the_stream_or_an_empty_one_fails() {
        let mut a = Assembly::default();
        let e = a.line(r#"data: {"error":{"message":"Upstream model failed","code":502},"choices":[{"delta":{},"finish_reason":"error"}]}"#).unwrap_err();
        assert_eq!(e, "Upstream model failed");
        assert!(assemble(&[": keep-alive", ""]).0.is_none(), "nothing came: cut short");
    }

    #[test]
    fn what_the_credits_afford_is_read_from_openrouters_refusal() {
        let e = "OpenRouter: not enough credits (402). This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 7461. To increase, visit https://openrouter.ai/settings/credits";
        assert_eq!(affordable(e), Some(7461));
        assert_eq!(affordable("OpenRouter: not enough credits (402). Add credits."), None);
        assert_eq!(affordable("…but can only afford 12."), None, "too little to answer: said as it is");
    }

    #[test]
    fn an_answer_stopped_at_the_length_limit_is_seen() {
        assert!(cut(&json!({"choices":[{"finish_reason":"length","message":{"content":"Half"}}]})));
        assert!(!cut(&json!({"choices":[{"finish_reason":"stop","message":{"content":"All"}}]})));
        let empty = json!({"choices":[{"finish_reason":"length","message":{"content":""}}]});
        assert_eq!(reply_text(p("openai"), &empty).unwrap_err(), "The model used all its room reasoning and wrote no answer: ask again, or turn reasoning down.");
    }

    #[test]
    fn screenshots_go_ahead_of_the_text_on_any_turn() {
        let dir = std::env::temp_dir().join(format!("lumo-oai-shots-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("screenshot-screen1.png");
        std::fs::write(&png, [0x89, b'P', b'N', b'G']).unwrap();
        let shots = vec![png.to_string_lossy().to_string()];

        let msg = with_images(user_message(false, None, "what's on screen?", PdfAs::Text), &shots, PdfAs::Text);
        let parts = msg["content"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["type"], "image_url");
        assert_eq!(parts[1], json!({"type":"text","text":"what's on screen?"}));

        // A dropped picture and a screenshot: both images, then the text.
        let ctx = ChatContext::File { name: "pic.png".into(), path: png.to_string_lossy().into() };
        let msg = with_images(user_message(true, Some(&ctx), "compare", PdfAs::Text), &shots, PdfAs::Text);
        let kinds: Vec<&str> = msg["content"].as_array().unwrap().iter().map(|p| p["type"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["image_url", "image_url", "text"]);

        // Nothing readable: the message is left as it was.
        let plain = user_message(false, None, "q", PdfAs::Text);
        assert_eq!(with_images(plain.clone(), &["/no/such.png".into()], PdfAs::Text), plain);
        assert_eq!(with_images(plain.clone(), &[], PdfAs::Text), plain);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_rides_with_its_turn_as_text_or_an_image() {
        let dir = std::env::temp_dir().join(format!("lumo-oai-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let txt = dir.join("notes.txt");
        std::fs::write(&txt, "hello").unwrap();
        let ctx = ChatContext::File { name: "notes.txt".into(), path: txt.to_string_lossy().into() };
        assert_eq!(
            user_message(true, Some(&ctx), "sum up", PdfAs::Text)["content"],
            "File: notes.txt\nFile contents:\nhello\n\nsum up"
        );
        // Dropped mid-conversation: it rides with that question all the same.
        assert_eq!(user_message(false, Some(&ctx), "more", PdfAs::Text)["content"], "File: notes.txt\nFile contents:\nhello\n\nmore");

        let png = dir.join("pic.png");
        std::fs::write(&png, [0x89, b'P', b'N', b'G']).unwrap();
        let ctx = ChatContext::File { name: "pic.png".into(), path: png.to_string_lossy().into() };
        let msg = user_message(true, Some(&ctx), "what is it?", PdfAs::Text);
        let parts = msg["content"].as_array().unwrap();
        assert_eq!(parts[0]["type"], "image_url");
        assert!(parts[0]["image_url"]["url"].as_str().unwrap().starts_with("data:image/png;base64,"));
        assert_eq!(parts[1], json!({"type":"text","text":"File: pic.png\n\nwhat is it?"}));

        let pdf = dir.join("doc.pdf");
        std::fs::write(&pdf, "%PDF").unwrap();
        let ctx = ChatContext::File { name: "doc.pdf".into(), path: pdf.to_string_lossy().into() };
        // A PDF with nothing to read: the model is told, to say so.
        assert_eq!(user_message(true, Some(&ctx), "q", PdfAs::Text)["content"], format!("File: doc.pdf\n{PDF_UNREAD}\n\nq"));
        // How many pages fit: none in a small context, at most ten in a big one.
        assert_eq!(pages_that_fit(4_096, 3_000), 0);
        assert_eq!(pages_that_fit(32_768, 9_000), 10);
        assert_eq!(pages_that_fit(16_384, 9_000), 2);
        assert_eq!(pages_that_fit(262_144, 9_000), 10);
        assert_eq!(pages_that_fit(0, 2_000), 2);
        // Sent as itself to an API that takes files.
        let msg = user_message(true, Some(&ctx), "q", PdfAs::File);
        assert_eq!(msg["content"][0]["type"], "file");
        assert_eq!(msg["content"][0]["file"]["filename"], "doc.pdf");
        assert!(msg["content"][0]["file"]["file_data"].as_str().unwrap().starts_with("data:application/pdf;base64,"));
        assert_eq!(msg["content"][1], json!({ "type": "text", "text": "File: doc.pdf\n\nq" }));
        let _ = std::fs::remove_dir_all(dir);

        let ctx = ChatContext::Window { app_name: "Code".into(), title: "x".into(), url: None };
        assert_eq!(user_message(true, Some(&ctx), "q", PdfAs::Text)["content"], "Context — App: Code, Window: x\n\nq");
    }

    #[test]
    fn the_reply_text_or_the_error_inside_a_200_is_read() {
        let ok = json!({"choices":[{"message":{"role":"assistant","content":"  Hi!  "}}]});
        assert_eq!(reply_text(p("openai"), &ok).unwrap(), "Hi!");
        let failed = json!({"error":{"message":"upstream down"}});
        assert_eq!(reply_text(p("openrouter"), &failed).unwrap_err(), "OpenRouter: upstream down");
        assert_eq!(reply_text(p("google"), &json!({"choices":[]})).unwrap_err(), "No response text.");
    }

    #[test]
    fn status_errors_say_what_to_do() {
        assert!(status_error(p("openai"), 401, "x").contains("rejected the API key"));
        assert!(status_error(p("openrouter"), 402, "x").contains("credits"));
        assert_eq!(status_error(p("google"), 500, "boom"), "Google AI 500: boom");
    }

    #[test]
    fn model_lists_keep_chat_models_only() {
        let openai = json!({"data":[
            {"id":"gpt-4o","created":100},
            {"id":"text-embedding-3-small","created":300},
            {"id":"gpt-5-mini","created":200},
            {"id":"whisper-1","created":400},
            {"id":"dall-e-3","created":500}
        ]});
        let ids: Vec<_> = parse_models(p("openai"), &openai).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["gpt-5-mini", "gpt-4o"]);

        let google = json!({"data":[
            {"id":"models/gemini-2.0-flash"},
            {"id":"models/text-embedding-004"},
            {"id":"gemini-2.5-pro"},
            {"id":"models/imagen-3.0"}
        ]});
        let ids: Vec<_> = parse_models(p("google"), &google).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["gemini-2.0-flash", "gemini-2.5-pro"]);

        let openrouter = json!({"data":[
            {"id":"b/paid","name":"B Paid","pricing":{"prompt":"0.000001","completion":"0.000002"}},
            {"id":"a/free:free","name":"A (free)"},
            {"id":"c/zero","name":"C Zero","pricing":{"prompt":"0","completion":"0"}},
            {"id":"d/image","name":"D Image","architecture":{"output_modalities":["image"]}}
        ]});
        let models = parse_models(p("openrouter"), &openrouter);
        let labels: Vec<_> = models.iter().map(|m| m.label.as_str()).collect();
        assert_eq!(labels, vec!["A (free)", "C Zero (free)", "B Paid"]);
    }

    #[test]
    fn an_unknown_answer_gives_an_empty_list() {
        assert!(parse_models(p("openai"), &json!({"nope":true})).is_empty());
    }
}
