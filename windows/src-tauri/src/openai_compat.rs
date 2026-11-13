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
use lumo_local::sse::{filter_thinking_blocks, progressive_filter, without_half_tag};
use lumo_local::transport::AFTER_FINISH;

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

/// The reasoning effort picked, as `p` takes it: OpenRouter's `reasoning`
/// object, OpenAI's and Gemini's `reasoning_effort`. "" sends none: the
/// model's own.
fn with_effort(p: &Provider, body: &mut Value, model: &str, effort: &str) {
    if !takes_effort(p, model, effort) {
        return;
    }
    if p.id == "openrouter" {
        body["reasoning"] = json!({ "effort": effort });
    } else {
        body["reasoning_effort"] = json!(effort);
    }
}

/// Whether `effort` goes to `model`: a level the picker offers, to a model
/// that reasons (OpenRouter's list is not at hand here: it passes the level
/// on to a model that takes one). One picked for another provider
/// (Claude Code's "max") doesn't go.
fn takes_effort(p: &Provider, model: &str, effort: &str) -> bool {
    if !REASONING_LEVELS.contains(&effort) {
        return false;
    }
    p.id == "openrouter" || !reasoning_levels(p, &Value::Null, model).is_empty()
}

/// The reasoning levels offered with these providers, lowest first.
const REASONING_LEVELS: [&str; 3] = ["low", "medium", "high"];

fn has_effort(body: &Value) -> bool {
    body.get("reasoning").is_some() || body.get("reasoning_effort").is_some()
}

fn without_effort(body: &mut Value) {
    if let Some(b) = body.as_object_mut() {
        b.remove("reasoning");
        b.remove("reasoning_effort");
    }
}

/// The reasoning levels the picker offers for a model of `p`'s list: what
/// OpenRouter's list says (`supported_parameters`), and for OpenAI and Google,
/// whose lists say nothing of it, the families that reason (o-series and
/// GPT-5; Gemini 2.5 and later). A model that refuses the level after all is
/// asked again at its own.
fn reasoning_levels(p: &Provider, m: &Value, id: &str) -> Vec<String> {
    let levels = || REASONING_LEVELS.map(String::from).to_vec();
    let lower = id.to_lowercase();
    let reasons = match p.id {
        "openrouter" => m["supported_parameters"].as_array().is_some_and(|ps| ps.iter().any(|x| x == "reasoning")),
        "openai" => {
            let o_series = lower.len() > 1 && lower.starts_with('o') && lower.as_bytes()[1].is_ascii_digit();
            (o_series || lower.starts_with("gpt-5")) && !lower.contains("chat")
        }
        "google" => gemini_version(&lower).is_some_and(|v| v >= 2.5) || lower.contains("thinking"),
        _ => false,
    };
    if reasons { levels() } else { Vec::new() }
}

/// 2.5 for "gemini-2.5-flash", 3.0 for "gemini-3-pro-preview".
fn gemini_version(id: &str) -> Option<f32> {
    let rest = id.strip_prefix("gemini-")?;
    let v: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    v.trim_end_matches('.').parse().ok()
}

/// A model's context in tokens, for the ring: OpenRouter's list says it
/// (`context_length`); for Google and OpenAI, whose lists don't, the size of
/// the families everyone knows. 0: not known.
fn context_of(p: &Provider, m: &Value, id: &str) -> u64 {
    if let Some(n) = m["context_length"].as_u64().or_else(|| m["input_token_limit"].as_u64()) {
        return n;
    }
    let lower = id.to_lowercase();
    match p.id {
        "google" if lower.starts_with("gemini-") => 1_048_576,
        "google" if lower.starts_with("gemma-3n") => 32_768,
        "google" if lower.starts_with("gemma-") => 131_072,
        "openai" if lower.starts_with("gpt-4.1") => 1_047_576,
        "openai" if lower.starts_with("gpt-5") => 400_000,
        "openai" if lower.starts_with("gpt-4o") => 128_000,
        "openai" if lower.starts_with("o1") || lower.starts_with("o3") || lower.starts_with("o4") => 200_000,
        _ => 0,
    }
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
/// limits the answer came back with (chat_usage.rs); for each, how full the
/// context is. `effort`: the reasoning effort picked ("" the model's own);
/// `mode` and `sandbox`: the chat's permissions, as with a local model.
#[allow(clippy::too_many_arguments)]
pub async fn send(
    app: &AppHandle,
    chat: &Chat,
    p: &'static Provider,
    model: &str,
    effort: &str,
    mode: &str,
    sandbox: &str,
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
    let mode = crate::tools::chat_mode(mode);
    let asking = crate::tools::Asking::for_local(mode);
    let sandbox_high = sandbox != "low";
    let plan = if mode == "plan" { crate::tools::PLAN_ONLY_NOTE } else { "" };
    let system = format!("{}{}{}{plan}", chat::system_prompt_in(chat, web, true), chat::api_tools_note(mail), if web { crate::web_search::NOTE } else { "" });
    let mut body = request_body(model, &system, &turn.history, &user);
    let all = tauri::async_runtime::spawn_blocking(move || crate::tools::chat_tools(mail, web, false)).await.unwrap_or_default();
    let tools = crate::tools::tools_for_mode(all, mode);
    if !tools.is_empty() {
        body["tools"] = function_tools(&tools);
    }
    with_effort(p, &mut body, model, effort);
    // The tokens of each answer come with its last piece, for the ring.
    body["stream_options"] = json!({ "include_usage": true });
    let endpoint = url(p, "chat/completions")?;

    // Streamed: the text shows as it is written, and Stop keeps what showed.
    let shown = Mutex::new(String::new());
    let events = chat.events();
    let mut said: Vec<String> = Vec::new();
    let answer = async {
        let mut rounds = 0;
        let mut capped = false;
        let mut streaming = true;
        let mut retried = false;
        loop {
            // Each request is news (the first, a retry, the round after the tools).
            events.signal(app);
            let before = said.join("\n\n");
            let show = |text: &str| {
                let text = text.trim_start();
                let all = if before.is_empty() { text.to_string() } else if text.is_empty() { before.clone() } else { format!("{before}\n\n{text}") };
                if !all.is_empty() {
                    events.delta(app, &all);
                }
                *shown.lock().unwrap_or_else(|p| p.into_inner()) = all;
            };
            // A whole answer tells nothing until it comes (a reasoning model:
            // minutes): alive all the same.
            let sent = if streaming {
                stream_post(p, &endpoint, &key, &body, usage, show, || events.signal(app)).await
            } else {
                crate::chat_agents::alive_while(app, events.chat_id(), post(p, &endpoint, &key, &body, usage)).await
            };
            // A whole answer, or a refusal, is news too.
            events.signal(app);
            let mut json = match sent {
                // A model this account may not stream (OpenAI asks some
                // organisations to be verified first): the whole answer, at once.
                Err((400, e)) if streaming && mentions_streaming(&e) => {
                    // stream_options alone, when the server knows no such field: streamed all the same.
                    if body.get("stream_options").is_some() && e.contains("stream_options") {
                        body.as_object_mut().map(|b| b.remove("stream_options"));
                        continue;
                    }
                    streaming = false;
                    body.as_object_mut().map(|b| b.remove("stream_options"));
                    continue;
                }
                // A model that doesn't reason, or not at this level: at its own.
                Err((400 | 422, e)) if has_effort(&body) && e.to_lowercase().contains("reasoning") => {
                    without_effort(&mut body);
                    continue;
                }
                // The server failed on its side (Google AI's "Internal error
                // encountered" now and then): asked once more, a moment later.
                Err((500 | 502 | 503 | 504, _)) if !retried => {
                    retried = true;
                    tokio::time::sleep(Duration::from_secs(2)).await;
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
                Err((status, e)) => {
                    crate::log::line(format!("chat: {} {model} refused (round {rounds}, {}): {status} {e}; {}", p.id, if streaming { "streamed" } else { "whole" }, request_shape(&body)));
                    return Err(e);
                }
                Ok(json) => json,
            };
            // How full the context is: this request and its answer, the last round's.
            if let Some(n) = chat_usage::context_tokens(&json["usage"]) {
                chat_usage::with_context(usage, p.id, chat.id(), n, context_of(p, &Value::Null, model));
            }
            // Reasoning written in the text (Gemma's `<thought>`) is never shown, nor sent back.
            if let Some(content) = json.pointer_mut("/choices/0/message/content").filter(|c| c.is_string()) {
                *content = json!(filter_thinking_blocks(content.as_str().unwrap_or_default()));
            }
            let message = json.pointer("/choices/0/message").cloned().unwrap_or(Value::Null);
            let calls = message["tool_calls"].as_array().cloned().unwrap_or_default();
            if calls.is_empty() || body.get("tools").is_none() {
                return Ok::<_, String>((json, false));
            }
            // Still at its tools after all its rounds: what it said is the answer.
            if rounds == MAX_TOOL_ROUNDS {
                return Ok((json, true));
            }
            rounds += 1;
            if let Some(text) = message["content"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
                said.push(text.to_string());
            }
            let mut turn_messages = vec![message.clone()];
            for call in &calls {
                let name = call.pointer("/function/name").and_then(Value::as_str).unwrap_or_default();
                // Arguments that aren't whole JSON (a call cut short) never run as `{}`.
                let Some(input) = call_input(call) else {
                    turn_messages.push(json!({ "role": "tool", "tool_call_id": call["id"], "content": "The arguments of this call were not valid JSON, so it did not run. Call it again with complete arguments." }));
                    continue;
                };
                // The island says which tool runs, in place of Thinking….
                let act = if crate::web_search::NAMES.contains(&name) {
                    crate::web_search::activity(name)
                } else if crate::github_tools::NAMES.contains(&name) {
                    crate::github_tools::activity(name, &input)
                } else {
                    crate::claude_code::Activity::new("tool", crate::claude_code::pretty_tool(name))
                };
                // Only a tool offered in this turn runs: a name the model made
                // up, or one Lumo did not offer (web search off), is refused.
                if !crate::tools::offered_in(&tools, name) {
                    turn_messages.push(json!({ "role": "tool", "tool_call_id": call["id"], "content": crate::tools::not_offered(name) }));
                    continue;
                }
                chat.events().activity(app, act);
                let (text, _) = crate::tools::call_for_chat(app, chat.id(), name, input, asking, sandbox_high).await;
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
    let (json, capped) = json?;
    if capped {
        let last = json.pointer("/choices/0/message/content").and_then(Value::as_str).map(str::to_string);
        let text = crate::claude::capped_answer(said, last, MAX_TOOL_ROUNDS);
        chat.commit(&turn, user, json!({ "role": "assistant", "content": text }), &plain, &text);
        return Ok(ChatReply::answer(text, None));
    }
    // An empty last word after the tools (Gemini does it): what was said
    // before them, and that they ran, stay; the turn is not thrown away.
    let silent_after_tools = !said.is_empty()
        && json.pointer("/error/message").is_none()
        && json.pointer("/choices/0/message/content").and_then(Value::as_str).is_none_or(|c| c.trim().is_empty());
    let mut text = if silent_after_tools { String::new() } else { reply_text(p, &json)? };
    if cut(&json) {
        text = format!("{text}\n\n_{}_", t("The answer was cut off at the length limit: ask to continue."));
    } else if json.pointer("/choices/0/finish_reason").and_then(Value::as_str) == Some(STOPPED_HALFWAY) {
        text = format!("{text}\n\n_{}_", t("The connection closed before the answer was over: it may be cut. Ask to continue."));
    }
    // After the user's tools, what was said before each call comes first.
    let text = if said.is_empty() { text } else { said.into_iter().chain([text]).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n") };

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
/// /compact: the conversation summed up, streamed (a reasoning model may
/// think for minutes first) at the model's own room. A summary cut at the
/// length limit is an error, not a summary.
pub async fn summarize(p: &'static Provider, model: &str, system: &str, prompt: &str) -> Result<String, String> {
    let key = secrets::get(p.key).ok_or_else(|| tf("{name} API key missing. Add it in Settings.", &[("name", p.name)]))?;
    let user = json!({ "role": "user", "content": prompt });
    let body = request_body(model, system, &[], &user);
    let endpoint = url(p, "chat/completions")?;
    let mut streaming = true;
    let mut retried = false;
    let json = loop {
        let sent = if streaming { stream_post(p, &endpoint, &key, &body, &mut None, |_| {}, || {}).await } else { post(p, &endpoint, &key, &body, &mut None).await };
        match sent {
            Ok(json) => break json,
            Err((400, e)) if streaming && mentions_streaming(&e) => streaming = false,
            Err((500 | 502 | 503 | 504, _)) if !retried => {
                retried = true;
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err((_, e)) => return Err(e),
        }
    };
    let text = reply_text(p, &json)?;
    if cut(&json) || json.pointer("/choices/0/finish_reason").and_then(Value::as_str) == Some(STOPPED_HALFWAY) {
        return Err(t("The summary was cut off at the length limit. Try again."));
    }
    Ok(filter_thinking_blocks(&text))
}

/// Whether a refusal is about streaming itself ("stream", "streaming",
/// "stream_options"), not a word that only holds it ("upstream").
fn mentions_streaming(error: &str) -> bool {
    error
        .to_lowercase()
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .any(|w| w == "stream" || w == "streaming" || w.starts_with("stream_"))
}

/// A tool call's arguments as JSON: an object, or nothing when they don't
/// parse (a call cut short). No arguments at all are `{}`.
fn call_input(call: &Value) -> Option<Value> {
    match call.pointer("/function/arguments") {
        None | Some(Value::Null) => Some(json!({})),
        Some(Value::String(a)) if a.trim().is_empty() => Some(json!({})),
        Some(Value::String(a)) => serde_json::from_str::<Value>(a).ok().filter(Value::is_object),
        Some(v @ Value::Object(_)) => Some(v.clone()),
        Some(_) => None,
    }
}

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

/// What a request holds, for the log when it is refused: the roles of its
/// last messages and the shape of the assistant's tool calls, never their text.
fn request_shape(body: &Value) -> String {
    let messages = body["messages"].as_array().map(Vec::as_slice).unwrap_or_default();
    let tools = body["tools"].as_array().map_or(0, Vec::len);
    let last: Vec<String> = messages
        .iter()
        .rev()
        .take(4)
        .rev()
        .map(|m| {
            let role = m["role"].as_str().unwrap_or("?");
            let content = match &m["content"] {
                Value::Null => "null".to_string(),
                Value::String(t) => format!("{} chars", t.chars().count()),
                Value::Array(parts) => format!("{} parts", parts.len()),
                _ => "other".to_string(),
            };
            let calls = m["tool_calls"].as_array().map(|calls| {
                let ids = calls.iter().filter(|c| c["id"].as_str().is_some_and(|id| !id.is_empty())).count();
                let signed = calls.iter().filter(|c| c.get("extra_content").is_some()).count();
                format!(", {} calls ({ids} with an id, {signed} with extra_content)", calls.len())
            });
            let keys: Vec<&str> = m.as_object().map(|o| o.keys().map(String::as_str).filter(|k| !matches!(*k, "role" | "content" | "tool_calls")).collect()).unwrap_or_default();
            format!("{role} [{content}{}{}]", calls.unwrap_or_default(), if keys.is_empty() { String::new() } else { format!(", also {}", keys.join(" ")) })
        })
        .collect();
    format!("{} messages, {tools} tools; last: {}", messages.len(), last.join(" · "))
}

/// One request, its answer read as it streams in (`stream: true`), put back
/// together as the whole answer would be (`choices[0].message`, its
/// `finish_reason`, `usage`), with what the provider adds kept as it came:
/// Gemini's thought signatures on the tool calls, OpenRouter's reasoning
/// details, which the next request must send back unchanged. `on_text` gets
/// the answer's text so far, at most 15 times a second and once more at the
/// end; `on_chunk`, every piece of the stream that comes, even one that adds
/// nothing to the text (reasoning, a tool call's arguments): the chat's sign
/// of life (chat_agents.rs), so a model that thinks for long isn't taken for stuck.
async fn stream_post(
    p: &Provider,
    endpoint: &Url,
    key: &str,
    body: &Value,
    usage: &mut Option<ChatUsage>,
    mut on_text: impl FnMut(&str),
    on_chunk: impl Fn(),
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
        // Once the answer said it was over, only a short wait for its usage
        // and `[DONE]`: a server that keeps the line open never holds the
        // turn for minutes.
        let next = if answer.finish_reason.is_some() {
            match tokio::time::timeout(AFTER_FINISH, response.chunk()).await {
                Ok(next) => next,
                Err(_) => break,
            }
        } else {
            response.chunk().await
        };
        let chunk = match next {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            // The answer was over: a connection dropped after it loses nothing.
            Err(_) if answer.finish_reason.is_some() => break,
            Err(e) if e.is_timeout() => return Err((0, silent())),
            Err(e) => return Err((0, tf("Network error: {error}", &[("error", &e.to_string())]))),
        };
        on_chunk();
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
            // Never the start of a reasoning tag the next piece may close (`<thi`).
            on_text(without_half_tag(&progressive_filter(&answer.content)));
        }
        if answer.done {
            break;
        }
    }
    // A last line without its newline.
    answer.line(String::from_utf8_lossy(&pending).trim_end()).map_err(|e| (0, format!("{}: {e}", p.name)))?;
    on_text(&progressive_filter(&answer.content));
    // Closed with neither `[DONE]` nor a finish_reason: the answer stopped
    // halfway. A tool call may be cut short in it: nothing runs then.
    let halfway = !answer.done && answer.finish_reason.is_none();
    if halfway && !answer.calls.is_empty() {
        return Err((0, tf("Network error: {error}", &[("error", "the answer stopped halfway")])));
    }
    if halfway {
        answer.finish_reason = Some(STOPPED_HALFWAY.into());
    }
    answer.finish().ok_or_else(|| (0, tf("Network error: {error}", &[("error", "the answer stopped halfway")])))
}

/// The finish_reason of an answer whose stream closed before it said it was
/// over: its text is kept, with a line that says it may be cut.
const STOPPED_HALFWAY: &str = "lumo_stopped_halfway";

/// A streamed answer put back together from its `choices[0].delta`s.
#[derive(Default)]
struct Assembly {
    content: String,
    /// The tool calls, in the order they began: id, type, function, and
    /// anything else the provider puts on them (Gemini's `extra_content`).
    calls: Vec<Value>,
    /// For each `index` the server gave, the call its pieces go to now.
    slots: Vec<(u64, usize)>,
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

/// `field` of `into` with `more` added at its end. Only into an object: a
/// server's piece of another shape is left out, never a panic (which would
/// take the whole app down).
fn append(into: &mut Value, field: &str, more: &str) {
    if !into.is_object() {
        return;
    }
    let joined = format!("{}{more}", into[field].as_str().unwrap_or_default());
    into[field] = json!(joined);
}

impl Assembly {
    /// A new tool call, for the server's `index` from now on. None past 65.
    fn start_call(&mut self, index: Option<u64>) -> Option<usize> {
        if self.calls.len() > 64 {
            return None;
        }
        self.calls.push(json!({ "id": "", "type": "function", "function": { "name": "", "arguments": "" } }));
        let at = self.calls.len() - 1;
        if let Some(index) = index {
            self.slots.retain(|(i, _)| *i != index);
            self.slots.push((index, at));
        }
        Some(at)
    }

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
                        let id = piece["id"].as_str().filter(|id| !id.is_empty());
                        let at = match piece["index"].as_u64() {
                            Some(index) => match self.slots.iter().find(|(i, _)| *i == index).map(|(_, at)| *at) {
                                // Another id at an index already taken is another
                                // call (as lumo_local::sse::CallParts): never two
                                // calls fused into one made-up name.
                                Some(at) if id.is_some_and(|id| self.calls[at]["id"].as_str().is_some_and(|had| !had.is_empty() && had != id)) => self.start_call(Some(index)),
                                Some(at) => Some(at),
                                None => self.start_call(Some(index)),
                            },
                            // No index (some servers): a new id is a new call, the rest goes on the last one.
                            None => match self.calls.last() {
                                Some(last) if id.is_none_or(|id| last["id"] == id || last["id"] == "") => Some(self.calls.len() - 1),
                                _ => self.start_call(None),
                            },
                        };
                        let Some(at) = at else { continue };
                        let call = &mut self.calls[at];
                        if let Some(name) = piece.pointer("/function/name").and_then(Value::as_str) {
                            // A name sent again whole with each piece is said once.
                            if call["function"]["name"].as_str() != Some(name) {
                                append(&mut call["function"], "name", name);
                            }
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
        // A piece that is not an object is no block: left out.
        if !piece.is_object() {
            return;
        }
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
        let mut calls: Vec<Value> = self.calls.into_iter().filter(|c| c.pointer("/function/name").and_then(Value::as_str).is_some_and(|n| !n.is_empty())).collect();
        // A call the stream gave no id: one of its own, which its answer names.
        for (i, call) in calls.iter_mut().enumerate() {
            if call["id"].as_str().is_none_or(str::is_empty) {
                call["id"] = json!(format!("call_{i}"));
            }
        }
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
            let reasoning = reasoning_levels(p, m, &id);
            let context = context_of(p, m, &id);
            Some((ModelInfo { id, label, reasoning, context }, created, free))
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
    fn only_a_refusal_about_streaming_turns_streaming_off() {
        assert!(mentions_streaming("Your organization must be verified to stream this model."));
        assert!(mentions_streaming("Unrecognized request argument supplied: stream_options"));
        assert!(mentions_streaming("Streaming is not supported"));
        assert!(!mentions_streaming("Upstream provider returned an error"));
        assert!(!mentions_streaming("upstream_error: bad request"));
    }

    #[test]
    fn a_call_whose_arguments_do_not_parse_is_not_run_with_none() {
        let call = |args: Value| json!({ "id": "c", "function": { "name": "workspace_write", "arguments": args } });
        assert_eq!(call_input(&call(json!(r#"{"path":"a.txt"}"#))), Some(json!({ "path": "a.txt" })));
        assert_eq!(call_input(&call(json!(""))), Some(json!({})));
        assert_eq!(call_input(&call(Value::Null)), Some(json!({})));
        assert_eq!(call_input(&call(json!({ "path": "a.txt" }))), Some(json!({ "path": "a.txt" })));
        // Cut short, or not an object.
        assert_eq!(call_input(&call(json!(r#"{"path":"a.tx"#))), None);
        assert_eq!(call_input(&call(json!("[1,2]"))), None);
    }

    #[test]
    fn a_stream_that_closes_before_it_is_over_is_not_taken_for_a_whole_answer() {
        use crate::net::tests::serve_once;
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let ask = |body: &str| {
            let u = serve_once("200 OK", "Content-Type: text/event-stream\r\n", body.as_bytes().to_vec());
            let endpoint = Url::parse(&u).unwrap();
            rt.block_on(stream_post(p("openai"), &endpoint, "k", &json!({ "model": "m" }), &mut None, |_| {}, || {}))
        };
        // Whole: a finish_reason, or [DONE].
        let whole = ask("data: {\"choices\":[{\"delta\":{\"content\":\"Hi.\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n").unwrap();
        assert_eq!(whole.pointer("/choices/0/finish_reason").and_then(Value::as_str), Some("stop"));
        // Text cut short: kept, marked.
        let text = ask("data: {\"choices\":[{\"delta\":{\"content\":\"Half an\"}}]}\n\n").unwrap();
        assert_eq!(text.pointer("/choices/0/message/content").and_then(Value::as_str), Some("Half an"));
        assert_eq!(text.pointer("/choices/0/finish_reason").and_then(Value::as_str), Some(STOPPED_HALFWAY));
        // A tool call cut short: an error, nothing runs.
        let call = ask("data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c\",\"function\":{\"name\":\"workspace_write\",\"arguments\":\"{\\\"pa\"}}]}}]}\n\n");
        assert!(call.is_err());
    }

    #[test]
    fn a_stream_of_reasoning_alone_is_still_a_sign_of_life() {
        // No text shows while the model reasons: each piece that comes says it is at work all the same.
        use crate::net::tests::serve_once;
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let body = "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"hmm\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
        let u = serve_once("200 OK", "Content-Type: text/event-stream\r\n", body.as_bytes().to_vec());
        let endpoint = Url::parse(&u).unwrap();
        let signals = std::cell::Cell::new(0);
        let mut shown = String::new();
        let answer = rt.block_on(stream_post(p("openai"), &endpoint, "k", &json!({ "model": "m" }), &mut None, |t| shown = t.to_string(), || signals.set(signals.get() + 1)));
        assert!(answer.is_ok());
        assert_eq!(shown, "", "no text ever showed");
        assert!(signals.get() >= 1);
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
    fn reasoning_pieces_of_the_wrong_shape_are_no_panic() {
        let (whole, _) = assemble(&[
            r#"data: {"choices":[{"index":0,"delta":{"reasoning_details":[5,{"text":"x"},"y",{"text":"z"}]}}]}"#,
            r#"data: {"choices":[{"index":0,"delta":{"content":"Ok."},"finish_reason":"stop"}]}"#,
            "data: [DONE]",
        ]);
        let whole = whole.unwrap();
        assert_eq!(whole["choices"][0]["message"]["content"], "Ok.");
        assert_eq!(whole["choices"][0]["message"]["reasoning_details"], json!([{"text":"xz"}]));
        let mut text = json!(5);
        append(&mut text, "text", "more");
        assert_eq!(text, json!(5), "only into an object");
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
    fn two_calls_at_the_same_index_stay_two_calls() {
        let (whole, _) = assemble(&[
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","type":"function","function":{"name":"set_timer","arguments":"{\"minutes\":1}"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"b","type":"function","function":{"name":"listen","arguments":"{}"}}]}}]}"#,
            // A name sent again whole with the next piece of its call.
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c","function":{"name":"read_file","arguments":"{\"path\":"}}]}}]}"#,
            r#"data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"name":"read_file","arguments":"\"a.txt\"}"}}]},"finish_reason":"tool_calls"}]}"#,
            "data: [DONE]",
        ]);
        let whole = whole.unwrap();
        let calls = whole.pointer("/choices/0/message/tool_calls").and_then(Value::as_array).unwrap();
        let named: Vec<_> = calls.iter().map(|c| (c["id"].as_str().unwrap(), c["function"]["name"].as_str().unwrap(), c["function"]["arguments"].as_str().unwrap())).collect();
        assert_eq!(named, [("a", "set_timer", r#"{"minutes":1}"#), ("b", "listen", "{}"), ("c", "read_file", r#"{"path":"a.txt"}"#)]);
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
        let (whole, _) = assemble(&[r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"one","arguments":"{}"}}]}}]}"#]);
        assert_eq!(whole.unwrap()["choices"][0]["message"]["tool_calls"][0]["id"], "call_0", "a call with no id gets one");
    }

    #[test]
    fn a_refused_request_is_logged_by_its_shape_only() {
        let body = json!({"tools":[{}],"messages":[
            {"role":"system","content":"secret instructions"},
            {"role":"user","content":"my question"},
            {"role":"assistant","content":null,"tool_calls":[{"id":"","function":{}},{"id":"x","extra_content":{},"function":{}}]},
            {"role":"tool","tool_call_id":"x","content":"result"}]});
        let shape = request_shape(&body);
        assert_eq!(shape, "4 messages, 1 tools; last: system [19 chars] · user [11 chars] · assistant [null, 2 calls (1 with an id, 1 with extra_content)] · tool [6 chars, also tool_call_id]");
        assert!(!shape.contains("secret") && !shape.contains("question"));
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

    #[test]
    fn the_reasoning_levels_follow_the_list_or_the_family() {
        let none = Value::Null;
        for id in ["o3", "o4-mini", "gpt-5", "gpt-5.1-mini"] {
            assert_eq!(reasoning_levels(p("openai"), &none, id), ["low", "medium", "high"], "{id}");
        }
        for id in ["gpt-4o", "gpt-4.1-mini", "gpt-5-chat-latest", "omni-moderation"] {
            assert!(reasoning_levels(p("openai"), &none, id).is_empty(), "{id}");
        }
        for id in ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3-pro-preview", "gemini-3.1-flash"] {
            assert_eq!(reasoning_levels(p("google"), &none, id).len(), 3, "{id}");
        }
        for id in ["gemini-2.0-flash", "gemma-3-27b-it", "gemini-1.5-pro"] {
            assert!(reasoning_levels(p("google"), &none, id).is_empty(), "{id}");
        }
        let thinks = json!({"supported_parameters":["tools","reasoning","include_reasoning"]});
        assert_eq!(reasoning_levels(p("openrouter"), &thinks, "x/y").len(), 3);
        assert!(reasoning_levels(p("openrouter"), &json!({"supported_parameters":["tools"]}), "x/y").is_empty());
    }

    #[test]
    fn the_effort_goes_as_each_provider_takes_it_and_only_where_it_is_taken() {
        let mut body = json!({});
        with_effort(p("google"), &mut body, "gemini-2.5-flash", "high");
        assert_eq!(body["reasoning_effort"], "high");
        let mut body = json!({});
        with_effort(p("openrouter"), &mut body, "anthropic/claude-opus-5.5", "low");
        assert_eq!(body["reasoning"], json!({"effort":"low"}));
        assert!(body.get("reasoning_effort").is_none());
        // A model that doesn't reason, Auto, or a level of another provider's (Claude Code's max): none.
        for (provider, model, effort) in [("openai", "gpt-4o", "high"), ("google", "gemini-2.5-flash", ""), ("google", "gemini-2.5-flash", "max")] {
            let mut body = json!({});
            with_effort(p(provider), &mut body, model, effort);
            assert!(!has_effort(&body), "{provider} {model} {effort}");
        }
        let mut body = json!({"reasoning":{"effort":"low"},"reasoning_effort":"low","model":"m"});
        without_effort(&mut body);
        assert_eq!(body, json!({"model":"m"}));
    }

    #[test]
    fn a_models_context_comes_from_its_list_or_its_family() {
        let none = Value::Null;
        assert_eq!(context_of(p("openrouter"), &json!({"context_length":200_000}), "a/b"), 200_000);
        assert_eq!(context_of(p("openrouter"), &none, "a/b"), 0, "not known");
        assert_eq!(context_of(p("google"), &none, "gemini-2.5-flash"), 1_048_576);
        assert_eq!(context_of(p("google"), &none, "gemma-3-27b-it"), 131_072);
        assert_eq!(context_of(p("openai"), &none, "gpt-4o-mini"), 128_000);
        assert_eq!(context_of(p("openai"), &none, "o3"), 200_000);
        let list = json!({"data":[{"id":"x/think","name":"Think","context_length":64_000,"supported_parameters":["reasoning"]}]});
        let models = parse_models(p("openrouter"), &list);
        assert_eq!((models[0].reasoning.len(), models[0].context), (3, 64_000));
    }
}
