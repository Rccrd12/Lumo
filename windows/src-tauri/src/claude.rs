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
/// An image whose base64 fits the API's 5 MB (5 × 1024 × 1024 characters).
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024 / 4 * 3;
/// A PDF whose base64 leaves room in the API's 32 MB request.
const MAX_PDF_BYTES: u64 = 22 * 1024 * 1024;

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
        // Prompt caching: the conversation so far is read from the cache on
        // the next message (and the next round of tools), at a tenth of the
        // price, instead of being paid for again in full. The API moves the
        // breakpoint to the last block by itself.
        "cache_control": { "type": "ephemeral" },
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
async fn run_user_tools(
    app: &AppHandle,
    chat: &Chat,
    blocks: &[Value],
    offered: &[(String, String, Value)],
    asking: crate::tools::Asking,
    sandbox_high: bool,
    launch: &Launch,
) -> Vec<Value> {
    let mut results = Vec::new();
    for b in blocks.iter().filter(|b| b["type"] == "tool_use") {
        let id = b["id"].as_str().unwrap_or_default();
        let name = b["name"].as_str().unwrap_or_default();
        // Only a tool offered in this turn runs (its web search is the API's own).
        if name == "web_search" || !crate::tools::offered_in(offered, name) {
            results.push(json!({ "type": "tool_result", "tool_use_id": id, "content": crate::tools::not_offered(name), "is_error": true }));
            continue;
        }
        // Agents of its own (api_agents.rs): they run here, and their reports are the result.
        if name == crate::api_agents::RUN {
            chat.events().activity(app, crate::claude_code::Activity::new("subtask", ""));
            let turn: crate::api_agents::Turn = Box::new(move |task, sink| Box::pin(agent_turn(app, chat.id(), launch, task, sink)));
            let run = Box::pin(crate::api_agents::run(app, chat.id(), chat::ANTHROPIC, &b["input"], crate::api_agents::MAX_AGENTS, turn));
            let (text, failed) = crate::chat_agents::alive_while(app, chat.id(), run).await;
            results.push(json!({ "type": "tool_result", "tool_use_id": id, "content": text, "is_error": failed }));
            continue;
        }
        // The island says which tool runs, in place of Thinking….
        let act = if crate::github_tools::NAMES.contains(&name) {
            crate::github_tools::activity(name, &b["input"])
        } else {
            crate::claude_code::Activity::new("tool", crate::claude_code::pretty_tool(name))
        };
        chat.events().activity(app, act);
        let (text, failed) = crate::tools::call_for_chat(app, chat.id(), name, b["input"].clone(), asking, sandbox_high).await;
        results.push(json!({ "type": "tool_result", "tool_use_id": id, "content": text, "is_error": failed }));
    }
    results
}

/// What an agent of the chat runs with (api_agents.rs): the chat's model, key and tools.
struct Launch {
    endpoint: Url,
    key: String,
    model: String,
    max_tokens: u64,
    effort: Option<String>,
    tools: Vec<(String, String, Value)>,
    asking: crate::tools::Asking,
    sandbox_high: bool,
}

/// One agent's whole turn: its task alone, the chat's tools (no more
/// agents), its rounds of tools, and its last word as the report.
async fn agent_turn(app: &AppHandle, chat_id: &str, l: &Launch, task: crate::api_agents::Task, sink: crate::api_agents::Sink) -> Result<String, String> {
    let user = json!({ "role": "user", "content": task.task });
    let mut body = with_user_tools(request_body(&l.model, crate::api_agents::SYSTEM, &[], &user, l.max_tokens), &l.tools);
    if let Some(effort) = &l.effort {
        body["output_config"] = json!({ "effort": effort });
    }
    let mut said: Vec<String> = Vec::new();
    let (mut rounds, mut smaller, mut retried, mut limited) = (0, false, false, 0);
    loop {
        let response = match stream_call(&l.endpoint, &l.key, &body, &mut None, |_| sink.chunk(), || sink.chunk()).await {
            Ok(response) => response,
            Err(Failed::Status(400, e)) if !smaller && e.contains("max_tokens") => {
                smaller = true;
                body["max_tokens"] = json!(SMALL_MAX_TOKENS);
                continue;
            }
            Err(Failed::Status(400, e)) if body.get("output_config").is_some() && e.contains("effort") => {
                body.as_object_mut().map(|b| b.remove("output_config"));
                continue;
            }
            // Agents at once may meet the rate limit: each waits it out a few times.
            Err(Failed::Status(429, _)) if limited < AGENT_BACKOFF.len() => {
                sink.rate_limited(true);
                tokio::time::sleep(AGENT_BACKOFF[limited]).await;
                limited += 1;
                sink.rate_limited(false);
                continue;
            }
            Err(Failed::Status(500 | 502 | 503 | 504 | 529, _)) if !retried => {
                retried = true;
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        if let Some(n) = chat_usage::context_tokens(&response["usage"]) {
            sink.tokens(n);
        }
        let stop = response["stop_reason"].as_str().unwrap_or_default();
        let blocks = response["content"].as_array().cloned().unwrap_or_default();
        let for_tools = stop == "tool_use" && !l.tools.is_empty();
        if !(for_tools || stop == "pause_turn") {
            said.extend(response_text(&blocks));
            let report = said.join("\n\n");
            return if report.trim().is_empty() { Err(t("No response text.")) } else { Ok(report) };
        }
        if rounds == crate::api_agents::MAX_AGENT_ROUNDS {
            return Ok(capped_answer(said, response_text(&blocks), rounds));
        }
        rounds += 1;
        said.extend(response_text(&blocks));
        let mut results = Vec::new();
        for b in blocks.iter().filter(|b| for_tools && b["type"] == "tool_use") {
            let id = b["id"].as_str().unwrap_or_default();
            let name = b["name"].as_str().unwrap_or_default();
            if name == "web_search" || !crate::tools::offered_in(&l.tools, name) {
                results.push(json!({ "type": "tool_result", "tool_use_id": id, "content": crate::tools::not_offered(name), "is_error": true }));
                continue;
            }
            sink.step(crate::claude_code::Activity::new("tool", crate::claude_code::pretty_tool(name)));
            let (text, failed) = sink.alive_while(Box::pin(crate::tools::call_for_chat(app, chat_id, name, b["input"].clone(), l.asking, l.sandbox_high))).await;
            results.push(json!({ "type": "tool_result", "tool_use_id": id, "content": text, "is_error": failed }));
        }
        if let Some(messages) = body["messages"].as_array_mut() {
            messages.push(json!({ "role": "assistant", "content": blocks }));
            if !results.is_empty() {
                messages.push(json!({ "role": "user", "content": results }));
            }
        }
    }
}

/// How long an agent waits each time it meets the rate limit, before it fails.
const AGENT_BACKOFF: [Duration; 3] = [Duration::from_secs(5), Duration::from_secs(15), Duration::from_secs(30)];

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

/// A tool call the content leaves without its result: a `tool_use` (or a
/// server tool's) cut off by the length limit. Kept in the history, every
/// later request of the chat would be refused by the API.
fn calls_left_open(blocks: &[Value]) -> bool {
    let answered: std::collections::HashSet<&str> = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str).is_some_and(|t| t.ends_with("tool_result")))
        .filter_map(|b| b.get("tool_use_id").and_then(Value::as_str))
        .collect();
    blocks.iter().any(|b| {
        matches!(b.get("type").and_then(Value::as_str), Some("tool_use" | "server_tool_use"))
            && !b.get("id").and_then(Value::as_str).is_some_and(|id| answered.contains(id))
    })
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
/// (chat_usage.rs), a refused one included, and how full the context is.
/// `effort`: the reasoning effort picked ("" the model's own); `mode` and
/// `sandbox`: the chat's permissions, as with a local model (tools.rs Asking).
#[allow(clippy::too_many_arguments)]
pub async fn send(
    app: &AppHandle,
    chat: &Chat,
    model: &str,
    effort: &str,
    mode: &str,
    sandbox: &str,
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
    let mode = crate::tools::chat_mode(mode);
    let asking = crate::tools::Asking::for_local(mode);
    let sandbox_high = sandbox != "low";
    let all = tauri::async_runtime::spawn_blocking(move || crate::tools::chat_tools(mail, false, false)).await.unwrap_or_default();
    let mut tools = crate::tools::tools_for_mode(all, mode);
    let plan = if mode == "plan" { crate::tools::PLAN_ONLY_NOTE } else { "" };
    let known = model_facts(&endpoint, &key, model).await;
    // Agents of its own, with the chat's tools but none that start more (api_agents.rs).
    let launch = Launch {
        endpoint: endpoint.clone(),
        key: key.clone(),
        model: model.to_string(),
        max_tokens: known.max_tokens,
        effort: known.efforts.iter().any(|e| e == effort).then(|| effort.to_string()),
        tools: crate::api_agents::sub_tools(&tools),
        asking,
        sandbox_high,
    };
    tools.push(crate::api_agents::tool());
    let system = format!("{}{}{plan}{}", chat::system_prompt_in(chat, true, true), chat::api_tools_note(mail), crate::api_agents::NOTE);
    let mut body = with_user_tools(request_body(model, &system, &turn.history, &user, known.max_tokens), &tools);
    // The effort picked, when the model takes it (its list says which; one
    // that refuses it after all is asked again at its own). One picked for
    // another provider (Claude Code's) that this model doesn't take: its own.
    if known.efforts.iter().any(|e| e == effort) {
        body["output_config"] = json!({ "effort": effort });
    }

    // Streamed: the text shows as it is written, and Stop keeps what showed.
    let shown = Mutex::new(String::new());
    let events = chat.events();
    let mut said: Vec<String> = Vec::new();
    let answer = async {
        let mut rounds = 0;
        let mut smaller = false;
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
            let response = match stream_call(&endpoint, &key, &body, usage, show, || events.signal(app)).await {
                Ok(response) => response,
                // A model with a smaller ceiling than its list said (or a gateway's).
                Err(Failed::Status(400, e)) if !smaller && e.contains("max_tokens") => {
                    smaller = true;
                    body["max_tokens"] = json!(SMALL_MAX_TOKENS);
                    continue;
                }
                // A model that takes no effort, or not this one: at its own.
                Err(Failed::Status(400, e)) if body.get("output_config").is_some() && e.contains("effort") => {
                    body.as_object_mut().map(|b| b.remove("output_config"));
                    continue;
                }
                // The API failed on its side, or is overloaded (529): asked once more, a moment later.
                Err(Failed::Status(500 | 502 | 503 | 504 | 529, _)) if !retried => {
                    retried = true;
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
                Err(e) => return Err(e.to_string()),
            };
            // How full the context is: this request and its answer, the last round's.
            if let Some(n) = chat_usage::context_tokens(&response["usage"]) {
                chat_usage::with_context(usage, chat::ANTHROPIC, chat.id(), n, known.context);
            }
            let stop = response["stop_reason"].as_str().unwrap_or_default();
            let stopped_for_tools = stop == "tool_use" && !tools.is_empty();
            // A long web search hands the turn back halfway: sent again as it is, it goes on.
            let paused = stop == "pause_turn";
            if !(stopped_for_tools || paused) {
                return Ok::<_, String>((response, false));
            }
            // Still at its tools after all its rounds: what it said is the answer.
            if rounds == MAX_TOOL_ROUNDS {
                return Ok((response, true));
            }
            rounds += 1;
            let blocks = response["content"].as_array().cloned().unwrap_or_default();
            if let Some(text) = response_text(&blocks) {
                said.push(text);
            }
            let results = if stopped_for_tools { Box::pin(run_user_tools(app, chat, &blocks, &tools, asking, sandbox_high, &launch)).await } else { Vec::new() };
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
    let (response, capped) = response?;
    if capped {
        // Its last answer asks for tools that won't run: kept as its text,
        // with no tool_use left unanswered in the conversation.
        let blocks = response["content"].as_array().cloned().unwrap_or_default();
        let text = capped_answer(said, response_text(&blocks), MAX_TOOL_ROUNDS);
        chat.commit(&turn, user, json!({ "role": "assistant", "content": text }), &plain, &text);
        return Ok(ChatReply::answer(text, None));
    }
    let (blocks, text) = match interpret(&response) {
        // An empty last word after the tools: what was said before them stays.
        Err(_) if !said.is_empty() && response["stop_reason"] != "refusal" => (Vec::new(), String::new()),
        other => other?,
    };
    let said_now = text.clone();
    let text = with_cut_note(text, &response);

    // Store the whole content — tool_use / tool_result blocks included — so the
    // next turn has the right context. After the user's tools, the answer is
    // kept as its text: the calls and their results stay with this turn.
    if said.is_empty() {
        // An answer cut while it was still writing a tool call keeps only its
        // text: the call never ran, and left open it would break the chat.
        let content = if calls_left_open(&blocks) { json!(said_now) } else { json!(blocks) };
        chat.commit(&turn, user, json!({ "role": "assistant", "content": content }), &plain, &text);
        return Ok(ChatReply::answer(text, None));
    }
    said.push(text);
    let text = said.iter().map(|s| s.trim()).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n");
    chat.commit(&turn, user, json!({ "role": "assistant", "content": text }), &plain, &text);
    Ok(ChatReply::answer(text, None))
}

/// The answer of a turn whose tools ran for all of MAX_TOOL_ROUNDS: what
/// was said along the way and in the last answer, then why it ends there.
pub(crate) fn capped_answer(mut said: Vec<String>, last: Option<String>, rounds: usize) -> String {
    said.extend(last.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()));
    said.push(format!("_{}_", tf("Lumo stopped the tools after {count} rounds: ask to continue.", &[("count", &rounds.to_string())])));
    said.join("\n\n")
}

/// /compact: the conversation summed up, streamed with the model's whole room
/// (a reasoning model thinks first, and a long chat's summary is long). No
/// tools. A summary cut at the length limit is an error, not a summary.
pub async fn summarize(model: &str, system: &str, prompt: &str) -> Result<String, String> {
    let key = secrets::get(KEY).ok_or_else(|| t("API key missing. Open settings."))?;
    let endpoint = endpoint()?;
    let known = model_facts(&endpoint, &key, model).await;
    let user = json!({ "role": "user", "content": prompt });
    let mut body = request_body(model, system, &[], &user, known.max_tokens);
    // Asked once: nothing to read back from a cache, which costs more to write.
    if let Some(b) = body.as_object_mut() {
        b.remove("tools");
        b.remove("cache_control");
    }
    let mut smaller = false;
    let mut retried = false;
    let response = loop {
        match stream_call(&endpoint, &key, &body, &mut None, |_| {}, || {}).await {
            Ok(response) => break response,
            Err(Failed::Status(400, e)) if !smaller && e.contains("max_tokens") => {
                smaller = true;
                body["max_tokens"] = json!(SMALL_MAX_TOKENS);
            }
            Err(Failed::Status(500 | 502 | 503 | 504 | 529, _)) if !retried => {
                retried = true;
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    let (_, text) = interpret(&response)?;
    if response["stop_reason"] == "max_tokens" {
        return Err(t("The summary was cut off at the length limit. Try again."));
    }
    Ok(text)
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
/// text so far, at most 15 times a second and once more at the end;
/// `on_chunk`, every piece of the stream that comes, even one that adds
/// nothing to the text (reasoning, a tool call's input): the chat's sign of
/// life (chat_agents.rs), so a model that thinks for long isn't taken for stuck.
async fn stream_call(
    endpoint: &Url,
    key: &str,
    body: &Value,
    usage: &mut Option<ChatUsage>,
    mut on_text: impl FnMut(&str),
    on_chunk: impl Fn(),
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
        on_chunk();
        total += chunk.len();
        if total > MAX_STREAM {
            return Err(Failed::Other(t("The server's answer is too large.")));
        }
        pending.extend_from_slice(&chunk);
        // Whole lines only: a chunk may end in the middle of one, or of a character.
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            unsent |= answer.line(String::from_utf8_lossy(&line).trim_end()).map_err(|e| answer.failed(e))?;
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
    answer.line(String::from_utf8_lossy(&pending).trim_end()).map_err(|e| answer.failed(e))?;
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
    /// The stream ended on the API's own failure (overloaded, an internal
    /// error) before anything was written: worth asking once more, as a 529.
    retryable: bool,
}

impl Assembly {
    /// A stream's `error` event as the call's failure: the API's own trouble,
    /// with nothing written yet, goes the way of a 529 (asked once more).
    fn failed(&self, e: String) -> Failed {
        if self.retryable {
            Failed::Status(529, e)
        } else {
            Failed::Other(e)
        }
    }

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
            // Only objects are kept: writing into anything else would panic.
            "message_start" => self.message = event["message"].is_object().then(|| event["message"].clone()),
            "content_block_start" => {
                let Some(i) = index.filter(|i| *i < 4096) else { return Ok(false) };
                while self.blocks.len() <= i {
                    self.blocks.push(Value::Null);
                }
                let block = &event["content_block"];
                self.blocks[i] = if block.is_object() { block.clone() } else { Value::Null };
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
                        if !message["usage"].is_object() {
                            message["usage"] = json!({});
                        }
                        for (k, v) in used {
                            message["usage"][k] = v.clone();
                        }
                    }
                }
            }
            "message_stop" => self.over = true,
            "error" => {
                let message = event.pointer("/error/message").and_then(Value::as_str).unwrap_or("error");
                let kind = event.pointer("/error/type").and_then(Value::as_str).unwrap_or_default();
                self.retryable = matches!(kind, "overloaded_error" | "api_error") && self.text.is_empty() && self.blocks.is_empty();
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

/// What the model list says of `model`: the longest answer it may write
/// (`max_tokens`, the whole of it is the answer's room), its context
/// (`max_input_tokens`, 0 when not said) and the effort levels it takes,
/// asked once per model.
#[derive(Clone)]
struct ModelFacts {
    max_tokens: u64,
    context: u64,
    efforts: Vec<String>,
}

impl ModelFacts {
    fn unknown() -> Self {
        ModelFacts { max_tokens: FALLBACK_MAX_TOKENS, context: 0, efforts: Vec::new() }
    }
}

/// How long a model the list said nothing of is not asked about again: a
/// gateway without the model list would cost every turn its 10 s otherwise.
const UNKNOWN_FOR: Duration = Duration::from_secs(10 * 60);

async fn model_facts(endpoint: &Url, key: &str, model: &str) -> ModelFacts {
    static KNOWN: LazyLock<Mutex<HashMap<String, ModelFacts>>> = LazyLock::new(Default::default);
    static UNKNOWN: LazyLock<Mutex<HashMap<String, std::time::Instant>>> = LazyLock::new(Default::default);
    if let Some(facts) = KNOWN.lock().unwrap_or_else(|p| p.into_inner()).get(model) {
        return facts.clone();
    }
    if UNKNOWN.lock().unwrap_or_else(|p| p.into_inner()).get(model).is_some_and(|at| at.elapsed() < UNKNOWN_FOR) {
        return ModelFacts::unknown();
    }
    let facts = model_entry(endpoint, key, model).await.and_then(|json| {
        let max_tokens = json["max_tokens"].as_u64().filter(|n| *n >= 1024)?;
        Some(ModelFacts { max_tokens, context: json["max_input_tokens"].as_u64().unwrap_or(0), efforts: efforts(&json) })
    });
    let Some(facts) = facts else {
        let mut unknown = UNKNOWN.lock().unwrap_or_else(|p| p.into_inner());
        unknown.retain(|_, at| at.elapsed() < UNKNOWN_FOR);
        unknown.insert(model.to_string(), std::time::Instant::now());
        return ModelFacts::unknown();
    };
    KNOWN.lock().unwrap_or_else(|p| p.into_inner()).insert(model.to_string(), facts.clone());
    facts
}

async fn model_entry(endpoint: &Url, key: &str, model: &str) -> Option<Value> {
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
    serde_json::from_slice::<Value>(&bytes).ok()
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
            Some(ModelInfo { id, label, reasoning: efforts(m), context: m["max_input_tokens"].as_u64().unwrap_or(0) })
        })
        .collect()
}

/// The effort levels a model of the list takes (`capabilities.effort`), in order.
fn efforts(m: &Value) -> Vec<String> {
    let effort = &m["capabilities"]["effort"];
    if effort["supported"].as_bool() != Some(true) {
        return Vec::new();
    }
    EFFORTS.iter().filter(|level| effort[**level]["supported"].as_bool() == Some(true)).map(|level| level.to_string()).collect()
}

/// The Messages API's effort levels (`output_config.effort`), lowest first.
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

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
        // Past what the API takes, the whole turn would be refused: the
        // model is told instead, and the question still goes.
        let len = std::fs::metadata(path).ok()?.len();
        if len > max_attachment(block_type) {
            let name = std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            return Some(json!({ "type": "text", "text": too_large_note(&name, len, max_attachment(block_type)) }));
        }
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

/// The largest file of `block_type` the Messages API takes: an image's
/// base64 may be 5 MB, a request 32 MB (a PDF's base64 with the rest).
fn max_attachment(block_type: &str) -> u64 {
    if block_type == "image" {
        MAX_IMAGE_BYTES
    } else {
        MAX_PDF_BYTES
    }
}

/// What the model reads in place of a file too large to send.
fn too_large_note(name: &str, len: u64, max: u64) -> String {
    let mb = |n: u64| format!("{:.1} MB", n as f64 / 1_000_000.0);
    format!("(The file {name} was not sent: it is {}, and the API takes at most {}. Tell the user it is too large and ask for a smaller copy if it matters.)", mb(len), mb(max))
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
    fn an_overloaded_stream_is_asked_again_only_before_any_text() {
        let start = r#"data: {"type":"message_start","message":{"id":"m","content":[],"usage":{}}}"#;
        let overloaded = r#"data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#;
        let mut a = Assembly::default();
        a.line(start).unwrap();
        let e = a.line(overloaded).unwrap_err();
        assert!(matches!(a.failed(e), Failed::Status(529, _)));
        // Text already shown: the failure is told, not asked again.
        let mut a = Assembly::default();
        a.line(start).unwrap();
        a.line(r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#).unwrap();
        a.line(r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Ciao"}}"#).unwrap();
        let e = a.line(overloaded).unwrap_err();
        assert!(matches!(a.failed(e), Failed::Other(_)));
        // Any other error neither.
        let mut a = Assembly::default();
        let e = a.line(r#"data: {"type":"error","error":{"type":"invalid_request_error","message":"bad"}}"#).unwrap_err();
        assert!(matches!(a.failed(e), Failed::Other(_)));
    }

    #[test]
    fn a_tool_call_cut_at_the_length_limit_is_never_kept_open() {
        let text = json!({ "type": "text", "text": "Sending it now." });
        let call = json!({ "type": "tool_use", "id": "toolu_1", "name": "send_email", "input": {} });
        assert!(calls_left_open(&[text.clone(), call]), "a tool_use with no result");
        // Web search: the server's call and its result come back together.
        let search = json!({ "type": "server_tool_use", "id": "srvtoolu_1", "name": "web_search", "input": {} });
        let found = json!({ "type": "web_search_tool_result", "tool_use_id": "srvtoolu_1", "content": [] });
        assert!(!calls_left_open(&[search.clone(), found, text.clone()]));
        assert!(calls_left_open(&[search, text.clone()]), "a search cut before its result");
        assert!(!calls_left_open(&[text]));
    }

    #[test]
    fn an_answer_still_at_its_tools_after_every_round_keeps_what_was_said() {
        let text = capped_answer(vec!["Looking.".into()], Some("One more search.".into()), 25);
        assert!(text.starts_with("Looking.\n\nOne more search.\n\n_"), "{text}");
        assert!(text.contains("25"), "{text}");
        // Nothing said at all: only why it ends there, never "No response text."
        let text = capped_answer(Vec::new(), None, 25);
        assert!(text.starts_with('_') && text.contains("25"), "{text}");
    }

    #[test]
    fn a_picture_or_pdf_too_large_for_the_api_is_told_not_sent() {
        let dir = std::env::temp_dir().join(format!("lumo-claude-big-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let small = dir.join("small.png");
        std::fs::write(&small, vec![0u8; 1000]).unwrap();
        assert_eq!(file_block(small.to_str().unwrap()).unwrap()["type"], "image");
        let big = dir.join("photo.jpg");
        std::fs::write(&big, vec![0u8; MAX_IMAGE_BYTES as usize + 1]).unwrap();
        let block = file_block(big.to_str().unwrap()).unwrap();
        assert_eq!(block["type"], "text");
        assert!(block["text"].as_str().unwrap().contains("photo.jpg was not sent"));
        // Its base64 fits the API's 5 MB.
        assert!(MAX_IMAGE_BYTES.div_ceil(3) * 4 <= 5 * 1024 * 1024);
        let _ = std::fs::remove_dir_all(&dir);
    }

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
    fn a_stream_of_thinking_alone_is_still_a_sign_of_life() {
        // No text shows while the model thinks: each piece that comes says it is at work all the same.
        use crate::net::tests::serve_once;
        let body = [
            r#"data: {"type":"message_start","message":{"content":[]}}"#,
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}"#,
            r#"data: {"type":"content_block_stop","index":0}"#,
            r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}"#,
            r#"data: {"type":"message_stop"}"#,
        ]
        .iter()
        .map(|l| format!("{l}\n\n"))
        .collect::<String>();
        let u = serve_once("200 OK", "Content-Type: text/event-stream\r\n", body.into_bytes());
        let endpoint = Url::parse(&u).unwrap();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let signals = std::cell::Cell::new(0);
        let answer = rt.block_on(stream_call(&endpoint, "k", &json!({ "model": "m" }), &mut None, |_| {}, || signals.set(signals.get() + 1)));
        assert!(answer.is_ok());
        assert!(signals.get() >= 1);
    }

    #[test]
    fn a_stream_of_the_wrong_shapes_is_no_panic() {
        // A proxy set through the base address may send anything: values that
        // are not objects where objects go are left out, never written into.
        let (message, texts) = assemble(&[
            r#"data: {"type":"message_start","message":{"content":[],"usage":5}}"#,
            r#"data: {"type":"content_block_start","index":0,"content_block":"text"}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"citations_delta","citation":1}}"#,
            r#"data: {"type":"content_block_stop","index":0}"#,
            r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}"#,
            r#"data: {"type":"message_stop"}"#,
        ]);
        assert_eq!(texts, ["Hi"]);
        let message = message.unwrap();
        assert_eq!(message["usage"]["output_tokens"], 2);
        assert_eq!(message["content"][0]["text"], "Hi");
        let (message, _) = assemble(&[r#"data: {"type":"message_start","message":[1]}"#, r#"data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}"#, r#"data: {"type":"message_stop"}"#]);
        assert!(message.is_err(), "no message to put together");
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
        // The conversation is cached for the next message.
        assert_eq!(body["cache_control"], json!({ "type": "ephemeral" }));
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
                ModelInfo { id: "claude-opus-5".into(), label: "Claude Opus 5".into(), ..Default::default() },
                ModelInfo { id: "claude-x".into(), label: "claude-x".into(), ..Default::default() },
            ]
        );
    }

    #[test]
    fn the_list_says_each_models_efforts_and_context() {
        let list = json!({"data":[
            {"id":"claude-opus-5-5","display_name":"Claude Opus 5.5","max_input_tokens":1_000_000,"capabilities":{"effort":{"supported":true,
                "low":{"supported":true},"medium":{"supported":true},"high":{"supported":true},"xhigh":{"supported":true},"max":{"supported":true}}}},
            {"id":"claude-opus-4-6","max_input_tokens":1_000_000,"capabilities":{"effort":{"supported":true,
                "low":{"supported":true},"medium":{"supported":true},"high":{"supported":true},"xhigh":{"supported":false},"max":{"supported":true}}}},
            {"id":"claude-haiku-4-5","max_input_tokens":200_000,"capabilities":{"effort":{"supported":false}}}
        ]});
        let models = parse_models(&list);
        assert_eq!(models[0].reasoning, ["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(models[0].context, 1_000_000);
        assert_eq!(models[1].reasoning, ["low", "medium", "high", "max"], "only the levels it takes");
        assert!(models[2].reasoning.is_empty(), "no effort: no slider");
        assert_eq!(models[2].context, 200_000);
    }
}
