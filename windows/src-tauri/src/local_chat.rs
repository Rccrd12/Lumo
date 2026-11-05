// Chat with a model server the user runs: Ollama, LM Studio, or any other
// server that speaks the OpenAI API (vLLM, llama.cpp, Unsloth…).
//
// The answer is streamed token by token. Each step goes to the island as a
// `chat-delta` event carrying the text visible so far, and the island shows it
// growing; the reply of the command is the finished text. `<think>` blocks of
// reasoning models stay hidden while open and are dropped from the answer.
//
// What the model can do decides what goes with a question (local_models.rs
// caps): pictures (screenshots, a dropped image) to a model that sees them,
// the island's tools and the user's (the Tools tab, each call asked for on the
// island) to one that calls tools, and the reasoning level picked to one that
// reasons. A server that says nothing is sent the tools all the same, and a
// model that refuses them is asked again without.
//
// The chat's permission modes hold here too: Ask every time is a card for
// each call of the user's tools, even one they trust; Auto lets the tools
// they trust run without asking (the others ask); Plan only gives the model
// none of the user's tools, only the island's timer and listening.
//
// Nothing leaves the machine unless the user pointed the server address
// somewhere else: that address is the only place this module talks to.

use std::time::{Duration, Instant};

use reqwest::Url;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::chat::{self, Chat, ChatContext, ChatReply, ModelInfo};
use crate::claude_code::Activity;
use crate::local_models::Caps;
use crate::settings::Settings;
use crate::i18n::{t, tf};
use crate::{net, secrets};

/// Credential store entry of the key of the user's own OpenAI-compatible server.
pub const CUSTOM_KEY: &str = "openai-compatible-key";
/// Unsloth Studio's key (`sk-unsloth-…`, its Settings → API), bound to its address too.
pub const UNSLOTH_KEY: &str = "unsloth-studio-key";

/// The credential store entry of a server's key: only the custom server and
/// Unsloth Studio take one.
pub fn key_entry(id: &str) -> Option<&'static str> {
    match id {
        "custom" => Some(CUSTOM_KEY),
        "unsloth" => Some(UNSLOTH_KEY),
        _ => None,
    }
}

const MAX_TOKENS: u32 = 4096;
/// Rounds of tools one answer may take before it must answer.
const MAX_TOOL_ROUNDS: usize = 8;
/// A text file is sent inline up to this many characters; the rest is cut.
const MAX_INLINE_CHARS: usize = 24_000;
/// The island is told about new text at most this often.
const DELTA_INTERVAL: Duration = Duration::from_millis(1000 / 15);
/// Ceilings for a streamed answer: one event line, and the whole answer.
const MAX_LINE: usize = 1024 * 1024;
const MAX_ANSWER: usize = 4 * 1024 * 1024;
/// Ollama and LM Studio ignore the key, but some clients insist on sending one.
const NO_KEY: &str = "ollama";
/// Models that embed or rank rather than chat are left out of the list.
const NOT_CHAT: &[&str] = &["embed", "bge-", "all-minilm", "clip", "rerank"];

// ── The custom server's key ───────────────────────────────────────────────────
//
// The key is stored together with the one address it was entered for, and is
// only ever sent there. The address in the settings, or the one given to
// "Connect", can be changed from the page; the key cannot follow it. And a key
// never goes over plain http to another machine.

#[derive(Serialize, serde::Deserialize)]
struct BoundKey {
    url: String,
    key: String,
}

fn may_carry_key(url: &Url) -> bool {
    url.scheme() == "https" || net::is_loopback_url(url)
}

/// Settings → Local models: stores `id`'s key for the address typed next to it.
pub fn set_key(id: &str, typed_url: &str, key: &str) -> Result<(), String> {
    let entry = key_entry(id).ok_or_else(|| format!("{id} takes no key"))?;
    let url = net::normalise_server_url(typed_url)?;
    if !may_carry_key(&url) {
        return Err(t("A key is only sent over https, or to a server on this computer."));
    }
    let bound = BoundKey { url: url.as_str().trim_end_matches('/').to_string(), key: key.trim().to_string() };
    let value = serde_json::to_string(&bound).map_err(|e| e.to_string())?;
    secrets::set(entry, &value)
}

/// `id`'s key, if it was entered for exactly this address.
fn key_of(id: &str, url: &Url) -> Option<String> {
    let stored = secrets::get(key_entry(id)?)?;
    key_for(&stored, url)
}

fn key_for(stored: &str, url: &Url) -> Option<String> {
    let bound: BoundKey = serde_json::from_str(stored).ok()?;
    (may_carry_key(url) && bound.url == url.as_str().trim_end_matches('/') && !bound.key.is_empty())
        .then_some(bound.key)
}

/// Whether `provider` is a model server of the user's (Ollama, LM Studio,
/// Unsloth Studio, a custom one).
pub fn is_local(provider: &str) -> bool {
    matches!(provider, "ollama" | "lmstudio" | "unsloth" | "custom")
}

/// A model server as the settings describe it.
pub struct Server {
    pub id: &'static str,
    pub name: &'static str,
    /// As stored: empty until the user connects it.
    pub url: String,
    pub key: Option<String>,
}

/// Ollama, LM Studio, Unsloth Studio or "custom", from the settings; None for any other id.
pub fn server(settings: &Settings, id: &str) -> Option<Server> {
    let (id, name, url, key) = match id {
        "ollama" => ("ollama", "Ollama", &settings.ollama_url, None),
        "lmstudio" => ("lmstudio", "LM Studio", &settings.lmstudio_url, None),
        "unsloth" => {
            let key = net::normalise_server_url(&settings.unsloth_url).ok().and_then(|u| key_of("unsloth", &u));
            ("unsloth", "Unsloth Studio", &settings.unsloth_url, key)
        }
        "custom" => {
            let key = net::normalise_server_url(&settings.custom_url).ok().and_then(|u| key_of("custom", &u));
            ("custom", crate::i18n::n_("OpenAI-compatible server"), &settings.custom_url, key)
        }
        _ => return None,
    };
    Some(Server { id, name, url: url.clone(), key })
}

/// The usual address of a server on this machine; none for "custom". Ollama's
/// own OLLAMA_HOST wins when it is set, as the Ollama CLI does.
fn usual_address(id: &str) -> Option<String> {
    match id {
        "ollama" => Some(
            std::env::var("OLLAMA_HOST")
                .ok()
                .filter(|v| !v.trim().is_empty())
                .unwrap_or_else(|| "http://127.0.0.1:11434".into()),
        ),
        "lmstudio" => Some("http://127.0.0.1:1234".into()),
        // Unsloth Studio says which port it took; 8888 most often, else 8000 (connect tries both).
        "unsloth" => Some("http://127.0.0.1:8888".into()),
        _ => None,
    }
}

pub(crate) fn bearer(key: Option<&str>) -> String {
    format!("Bearer {}", key.filter(|k| !k.is_empty()).unwrap_or(NO_KEY))
}

pub(crate) fn unreachable(url: &Url) -> String {
    tf("Cannot reach {url}. Is the server running?", &[("url", url.as_str().trim_end_matches('/'))])
}

pub(crate) fn base_url(server: &Server) -> Result<Url, String> {
    if server.url.trim().is_empty() {
        return Err(tf("Connect {name} in Settings → Local models first.", &[("name", &t(server.name))]));
    }
    net::normalise_server_url(&server.url)
}

/// What the "Connect" button reports: the address as it will be stored, the
/// chat models the server has, and whether the address is this machine.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connected {
    pub url: String,
    pub models: Vec<String>,
    pub loopback: bool,
}

/// Settings → Local models → Connect: does the server answer, and which models
/// does it have? An empty address means the usual one on this machine.
pub async fn connect(id: &str, typed: &str) -> Result<Connected, String> {
    let raw = if typed.trim().is_empty() { usual_address(id).unwrap_or_default() } else { typed.to_string() };
    let mut url = net::normalise_server_url(&raw)?;
    let mut models = list(&url, key_of(id, &url).as_deref()).await;
    // Unsloth Studio on its other usual port.
    if id == "unsloth" && typed.trim().is_empty() && models.is_err() {
        let other = net::normalise_server_url("http://127.0.0.1:8000")?;
        if let Ok(found) = list(&other, key_of(id, &other).as_deref()).await {
            url = other;
            models = Ok(found);
        }
    }
    let models = models?;
    Ok(Connected {
        url: url.as_str().trim_end_matches('/').to_string(),
        models,
        loopback: net::is_loopback_url(&url),
    })
}

/// The models of a connected server, for the picker in the chat view.
pub async fn models(server: &Server) -> Result<Vec<ModelInfo>, String> {
    let url = base_url(server)?;
    let models = list(&url, server.key.as_deref()).await?;
    if models.is_empty() {
        return Err(tf("No models yet. Download one in {name} first.", &[("name", &t(server.name))]));
    }
    Ok(models.into_iter().map(|id| ModelInfo { label: id.clone(), id }).collect())
}

/// `GET /v1/models`, chat models only, or why the server can't be reached.
async fn list(base: &Url, key: Option<&str>) -> Result<Vec<String>, String> {
    let response = net::client(base, Duration::from_secs(5))?
        .get(net::join(base, "v1/models"))
        .header("Authorization", bearer(key))
        .send()
        .await
        .map_err(|_| unreachable(base))?;
    if matches!(response.status().as_u16(), 401 | 403) {
        return Err(t("The server refused the key. Check it, then connect again."));
    }
    if !response.status().is_success() {
        return Err(unreachable(base));
    }
    let bytes = net::read_capped(response, net::MAX_BODY).await?;
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| unreachable(base))?;
    parse_models(&body).ok_or_else(|| unreachable(base))
}

fn parse_models(body: &Value) -> Option<Vec<String>> {
    let items = body.get("data")?.as_array()?;
    Some(
        items
            .iter()
            // Unsloth Studio names its speech and music models' `task`: they don't chat.
            .filter(|m| m.get("task").is_none_or(Value::is_null))
            .filter_map(|m| m.get("id").and_then(Value::as_str))
            .filter(|id| !NOT_CHAT.iter().any(|n| id.to_lowercase().contains(n)))
            .map(str::to_string)
            .collect(),
    )
}

// ── Messages ──────────────────────────────────────────────────────────────────

/// What a dropped file adds to its message: text inline (cut), a PDF's text
/// (pdf_text.rs), anything else by name only.
fn file_note(name: &str, path: &str) -> String {
    let ext = std::path::Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let binary = matches!(ext.as_str(), "pdf" | "jpg" | "jpeg" | "png" | "gif" | "webp");
    // Read no more than the inline limit can use (4 bytes per character at most).
    if ext == "pdf" {
        return match crate::pdf_text::text(path, MAX_INLINE_CHARS) {
            Some(text) => format!("File: {name}\nFile contents:\n{text}"),
            None => format!("File: {name}\n{}", crate::openai_compat::PDF_UNREAD),
        };
    }
    let text = if binary { None } else { read_prefix(path, MAX_INLINE_CHARS * 4) };
    match text {
        Some(text) if !text.is_empty() => {
            let mut body: String = text.chars().take(MAX_INLINE_CHARS).collect();
            if body.len() < text.len() {
                body.push_str("\n[truncated]");
            }
            format!("File: {name}\nFile contents:\n{body}")
        }
        _ => format!("File: {name}"),
    }
}

/// The first `limit` bytes of a file as UTF-8 text (a character cut in half at
/// the end is dropped), or None for a file that is not text.
fn read_prefix(path: &str, limit: usize) -> Option<String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path).ok()?.take(limit as u64).read_to_end(&mut bytes).ok()?;
    match String::from_utf8(bytes) {
        Ok(text) => Some(text),
        Err(e) if e.utf8_error().error_len().is_none() => {
            let valid = e.utf8_error().valid_up_to();
            let mut bytes = e.into_bytes();
            bytes.truncate(valid);
            String::from_utf8(bytes).ok()
        }
        Err(_) => None,
    }
}

fn user_text(first: bool, context: Option<&ChatContext>, query: &str) -> String {
    match chat::turn_context(first, context) {
        Some(ChatContext::File { name, path }) => format!("{}\n\n{query}", file_note(name, path)),
        Some(ChatContext::Window { app_name, title, url }) => {
            format!("{}\n\n{query}", chat::window_line(app_name, title, url.as_deref()))
        }
        None => query.to_string(),
    }
}

fn request_body(model: &str, system: &str, history: &[Value], user: &Value) -> Value {
    let mut messages = vec![json!({ "role": "system", "content": system })];
    messages.extend(history.iter().cloned());
    messages.push(user.clone());
    json!({ "model": model, "messages": messages, "stream": true, "max_tokens": MAX_TOKENS })
}

/// Added to Lumo's instructions on Plan only.
const PLAN_NOTE: &str = "\n\nThe user picked Plan only: read and plan, and change nothing. You have none of the user's tools now; say what you would do with them instead.";

/// The tools a turn offers in permission `mode` (claude_code::permission_mode):
/// on Plan only, the island's own (a timer, listening) and the email's that
/// only read, none of the user's and nothing that sends or changes an email.
fn tools_for_mode(all: Vec<(String, String, Value)>, mode: &str) -> Vec<(String, String, Value)> {
    if mode != "plan" {
        return all;
    }
    let reads = |id: &str| crate::island_tools::NAMES.contains(&id) || crate::mail_tool_defs::MAIL_NAMES.contains(&id);
    all.into_iter().filter(|(id, _, _)| reads(id)).collect()
}

/// Whether `path` is a picture a model that sees can be sent.
fn is_image(path: &str) -> bool {
    let ext = std::path::Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "gif" | "webp")
}

/// The user's message: text only, or with its pictures for a model that
/// sees them. `shared`: the screenshots and the files shared from the screen
/// button (a model that doesn't see gets the text of the text files only).
#[cfg(test)]
fn user_message(vision: bool, first: bool, context: Option<&ChatContext>, query: &str, shared: &[String]) -> Value {
    user_message_in(vision, crate::openai_compat::MAX_PDF_PAGES, first, context, query, shared)
}

/// `user_message`, with at most `pages` of a PDF drawn for a model that sees.
fn user_message_in(vision: bool, pages: u32, first: bool, context: Option<&ChatContext>, query: &str, shared: &[String]) -> Value {
    use crate::openai_compat::PdfAs;
    // A PDF: pictures of its pages for a model that sees, when it has few; else its text.
    let pdf = if vision { PdfAs::TextAndPages { pages } } else { PdfAs::Text };
    let dropped = matches!(chat::turn_context(first, context), Some(ChatContext::File { path, .. }) if is_image(path) || crate::openai_compat::is_pdf(path));
    let user = if vision && dropped {
        crate::openai_compat::user_message(first, context, query, pdf)
    } else {
        json!({ "role": "user", "content": user_text(first, context, query) })
    };
    let shared: Vec<String> = shared.iter().filter(|p| vision || !is_image(p)).cloned().collect();
    crate::openai_compat::with_images(user, &shared, pdf)
}

/// The tool of `names` that `text` writes as a line of its own (`[[name …]]`
/// or `[name(…)]`) instead of calling it.
fn written_call(text: &str, names: &[String]) -> Option<String> {
    let mut rest = text;
    while let Some(at) = rest.find('[') {
        let after = rest[at..].trim_start_matches('[').trim_start();
        if let Some(name) = names.iter().find(|n| {
            after.starts_with(n.as_str()) && after[n.len()..].starts_with(|c: char| c.is_whitespace() || c == '(' || c == ':' || c == '{' || c == '"')
        }) {
            return Some(name.clone());
        }
        rest = &rest[at + 1..];
    }
    None
}

/// Whether the stream of `model` on `server` hung in this session, after
/// noting that it did when `now`.
fn hung(server: &Server, model: &str, now: bool) -> bool {
    static HUNG: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
    let key = format!("{}\u{0}{model}", server.id);
    let mut hung = HUNG.lock().unwrap_or_else(|e| e.into_inner());
    if now && !hung.contains(&key) {
        hung.push(key.clone());
    }
    hung.contains(&key)
}

/// The server gave up on the answer halfway.
fn is_cut_short(e: &str) -> bool {
    e == CUT_SHORT || e.trim().eq_ignore_ascii_case("terminated")
}

/// What the server said, in the user's language where Lumo knows it.
fn server_error(server: &Server, e: String) -> String {
    // The server dropped the answer halfway, or its model process ended
    // ("terminated", LM Studio): said as such, in the user's language.
    if is_cut_short(&e) {
        return tf(
            "{name} stopped the answer before it was over: the model may have crashed or run out of memory. Look at {name}, then ask again.",
            &[("name", &t(server.name))],
        );
    }
    if e.trim().is_empty() {
        return tf("{name} answered with an error and gave no reason. Look at {name}, then ask again.", &[("name", &t(server.name))]);
    }
    if server.id == "unsloth" && e.contains("No model loaded") {
        return t("No model is loaded in Unsloth Studio. Pick one above the chat box, and Lumo loads it.");
    }
    e
}

/// Takes the pictures out of the last message of `body` (its text stays),
/// for a server that refused them. Whether there were any.
fn without_images(body: &mut Value) -> bool {
    let Some(last) = body["messages"].as_array_mut().and_then(|m| m.last_mut()) else { return false };
    let Some(parts) = last["content"].as_array() else { return false };
    if !parts.iter().any(|p| p["type"] == "image_url") {
        return false;
    }
    let text: Vec<&str> = parts.iter().filter(|p| p["type"] == "text").filter_map(|p| p["text"].as_str()).collect();
    last["content"] = json!(text.join("\n\n"));
    true
}

/// One chat turn with a model server.
#[allow(clippy::too_many_arguments)]
pub async fn send(
    app: &AppHandle,
    chat: &Chat,
    server: &Server,
    model: &str,
    caps: &Caps,
    effort: &str,
    mode: &str,
    query: String,
    context: Option<ChatContext>,
    shared: &[String],
    usage: &mut Option<crate::chat_usage::ChatUsage>,
) -> Result<ChatReply, String> {
    let base = base_url(server)?;
    if model.is_empty() {
        return Err(t("Pick a model above the chat box first."));
    }
    let turn = chat.begin(server.id);
    // The tools, unless the server says the model takes none.
    let mode = crate::claude_code::permission_mode(mode);
    // Lumo's email tools, usable only while this turn runs.
    let mail = if caps.tools == Some(false) { "" } else { crate::mail::ai_tools(app) };
    let _mail = (!mail.is_empty()).then(crate::mail::agent_turn);
    let tools = if caps.tools == Some(false) {
        Vec::new()
    } else {
        let all = tauri::async_runtime::spawn_blocking(move || crate::tools::chat_tools(mail)).await.unwrap_or_default();
        tools_for_mode(all, mode)
    };
    let always_ask = mode == "default";
    let system = chat::system_prompt_in(chat, false, !tools.is_empty());
    let system = if tools.is_empty() { system } else { format!("{system}{}", chat::api_tools_note(if mode == "plan" && !mail.is_empty() { "mail" } else { mail })) };
    let system = if mode == "plan" { format!("{system}{PLAN_NOTE}") } else { system };
    // Built once the model is in memory, when its server says what it can do.
    let mut user = Value::Null;
    let mut body = Value::Null;
    let mut used = None;

    // What the island shows so far: kept if Stop is pressed mid-answer. What
    // was said before each round of tools stays above the round after it.
    let mut shown = String::new();
    let mut said: Vec<String> = Vec::new();
    let events = chat.events();
    let answer = async {
        // A model not in memory is loaded first, so the island can say so
        // (with how far, when LM Studio tells); a local model then reads the
        // whole prompt before it writes, which takes a while too.
        if caps.loaded == Some(false) {
            events.activity(app, Activity::new("loading", ""));
            let loaded = crate::local_models::load(server, model, |percent| {
                events.activity(app, Activity::new("loading", percent.to_string()));
            })
            .await;
            if let Err(e) = loaded {
                crate::log::line(format!("[local] loading {model}: {e}"));
                // Unsloth Studio answers nothing until a model is in: its reason, said.
                if server.id == "unsloth" {
                    return Err(tf("Unsloth Studio couldn't load the model: {error}", &[("error", &e)]));
                }
            }
        }
        let caps = if caps.loaded == Some(false) { crate::local_models::caps(server, model).await } else { caps.clone() };
        // Pictures go unless the server says the model doesn't see them; one
        // that refuses them is asked again without (below).
        // A PDF's pages go as pictures as far as the context leaves room for
        // them, past the instructions, the tools, the conversation and the answer.
        let context_size = if caps.loaded_context > 0 { caps.loaded_context } else { caps.max_context };
        let taken_chars = system.len() + turn.history.iter().map(|m| m.to_string().len()).sum::<usize>() + query.len() + if tools.is_empty() { 0 } else { crate::openai_compat::function_tools(&tools).to_string().len() };
        let taken = (taken_chars / 3) as u64 + u64::from(MAX_TOKENS);
        let pages = crate::openai_compat::pages_that_fit(context_size, taken);
        user = user_message_in(caps.vision != Some(false), pages, turn.first, context.as_ref(), &query, shared);
        body = request_body(model, &system, &turn.history, &user);
        if !tools.is_empty() {
            body["tools"] = crate::openai_compat::function_tools(&tools);
        }
        if let Some(level) = crate::local_models::reasoning_effort(&caps, effort) {
            body["reasoning_effort"] = json!(level);
            // Unsloth Studio turns thinking on and off with its own switch.
            if server.id == "unsloth" {
                body["enable_thinking"] = json!(level != "none");
            }
        }
        // How much of the context the chat fills comes with the last event (the ring).
        if matches!(server.id, "ollama" | "lmstudio" | "unsloth") {
            body["stream_options"] = json!({ "include_usage": true });
        }
        let mut rounds = 0;
        // A model whose stream hung once in this session answers whole from then on.
        let mut whole = hung(server, model, false);
        let mut corrected = false;
        let names: Vec<String> = tools.iter().map(|(id, _, _)| id.clone()).collect();
        loop {
            events.activity(app, Activity::new("prompt", ""));
            let before = said.join("\n\n");
            // Once the server dropped a streamed answer, the answer comes whole.
            let streamed = if whole {
                ask_whole(&base, server.key.as_deref(), model, &body).await
            } else {
                stream(
                &base,
                server.key.as_deref(),
                model,
                &body,
                |visible| {
                    // Nothing new yet in this round (a tool ran, the model reads or
                    // thinks): the text so far isn't sent again, or the island would
                    // drop the dots that say what the answer is doing.
                    if visible.is_empty() {
                        return;
                    }
                    shown = if before.is_empty() { visible } else { format!("{before}\n\n{visible}") };
                    events.delta(app, &shown);
                },
                || events.activity(app, Activity::thinking()),
            )
            .await
            };
            if let (true, Ok(answer)) = (whole, &streamed) {
                if !answer.text.is_empty() {
                    shown = if before.is_empty() { progressive_filter(&answer.text) } else { format!("{before}\n\n{}", progressive_filter(&answer.text)) };
                    events.delta(app, &shown);
                }
            }
            let streamed = match streamed {
                // A model that doesn't see refuses the pictures: once more with the text alone.
                Err((400 | 422, _)) if without_images(&mut body) => {
                    if let Some(last) = body["messages"].as_array().and_then(|m| m.last()).filter(|m| m["role"] == "user") {
                        user = last.clone();
                    }
                    continue;
                }
                // A model that takes no tools refuses the request: once more without them.
                Err((400 | 422, _)) if body.get("tools").is_some() => {
                    body.as_object_mut().map(|b| b.remove("tools"));
                    let system = chat::system_prompt_in(chat, false, false);
                    body["messages"][0]["content"] = json!(if mode == "plan" { format!("{system}{PLAN_NOTE}") } else { system });
                    continue;
                }
                // The server dropped the answer before anything of it came (LM
                // Studio sometimes never ends one, then says "terminated"): no
                // tool ran, so it is asked once more.
                // LM Studio's stream hangs on some tool calls (long text in their
                // arguments, with Gemma): the same request, not streamed, from then on.
                Err((0, e)) if !whole && is_cut_short(&e) => {
                    whole = hung(server, model, true);
                    events.activity(app, Activity::thinking());
                    continue;
                }
                other => other.map_err(|(_, e)| server_error(server, e))?,
            };
            if streamed.used.is_some() {
                used = streamed.used;
            }
            // A tool call written in the answer as text (`[[workspace_edit …]]`,
            // like the timer's line) does nothing: the model is told so once,
            // and what it wrote is not kept.
            if streamed.calls.is_empty() && !corrected && body.get("tools").is_some() && written_call(&streamed.text, &names).is_some() {
                corrected = true;
                let name = written_call(&streamed.text, &names).unwrap_or_default();
                if let Some(messages) = body["messages"].as_array_mut() {
                    messages.push(json!({ "role": "assistant", "content": streamed.text }));
                    messages.push(json!({ "role": "user", "content": format!("(Lumo: {name} written in your answer is only text: nothing was done. Call the {name} tool itself, as a function call, then answer. Never write a tool call in your answer, and never say something was done when no tool did it.)") }));
                }
                shown = before.clone();
                events.delta(app, &shown);
                events.activity(app, Activity::thinking());
                continue;
            }
            if streamed.calls.is_empty() || body.get("tools").is_none() || rounds == MAX_TOOL_ROUNDS {
                return Ok::<_, String>(streamed.text);
            }
            rounds += 1;
            if !streamed.text.is_empty() {
                said.push(streamed.text.clone());
            }
            let calls: Vec<Value> = streamed
                .calls
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    let id = c["id"].as_str().filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| format!("call_{rounds}_{i}"));
                    json!({ "id": id, "type": "function", "function": { "name": c["name"], "arguments": c["arguments"] } })
                })
                .collect();
            let mut turn_messages = vec![json!({ "role": "assistant", "content": streamed.text, "tool_calls": calls })];
            for call in &calls {
                let name = call.pointer("/function/name").and_then(Value::as_str).unwrap_or_default();
                let input = call.pointer("/function/arguments").and_then(Value::as_str).and_then(|a| serde_json::from_str(a).ok()).unwrap_or_else(|| json!({}));
                events.activity(app, Activity::new("tool", crate::claude_code::pretty_tool(name)));
                let (text, _) = crate::tools::call_for_chat(app, chat.id(), name, input, always_ask).await;
                turn_messages.push(json!({ "role": "tool", "tool_call_id": call["id"], "name": name, "content": text }));
            }
            if let Some(messages) = body["messages"].as_array_mut() {
                messages.extend(turn_messages);
            }
        }
    };
    let streamed = chat.unless_stopped(answer).await;
    let plain = chat::plain_question(turn.first, context.as_ref(), &query);
    let Some(answer) = streamed else {
        // The connection is closed. What was written stays in the conversation.
        if !shown.is_empty() {
            chat.commit(&turn, user, json!({ "role": "assistant", "content": shown }), &plain, &shown);
        }
        return Ok(ChatReply::stopped(shown, None));
    };
    let answer = answer?;
    // How full the context is, out of what the model is loaded with now.
    if let Some(used) = used {
        let now = crate::local_models::caps(server, model).await;
        let total = if now.loaded_context > 0 { now.loaded_context } else { now.max_context };
        *usage = Some(crate::chat_usage::ChatUsage {
            provider: server.id.to_string(),
            context: Some(crate::chat_usage::ContextUse { chat: chat.id().to_string(), used, total }),
            tokens: None,
            requests: None,
            credits: None,
        });
    }
    // After the tools, what was said before each call comes first.
    let answer = said.into_iter().chain([answer]).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n\n");
    if answer.is_empty() {
        return Err(t("No response text."));
    }
    chat.commit(&turn, user, json!({ "role": "assistant", "content": answer }), &plain, &answer);
    Ok(ChatReply::answer(answer, None))
}

/// One question with no conversation: the supervisor's review of a tool
/// (tool_review.rs).
pub async fn complete(server: &Server, model: &str, system: &str, prompt: &str) -> Result<String, String> {
    let base = base_url(server)?;
    if model.is_empty() {
        return Err(t("Pick a model above the chat box first."));
    }
    let user = json!({ "role": "user", "content": prompt });
    let body = request_body(model, system, &[], &user);
    let answer = stream(&base, server.key.as_deref(), model, &body, |_| {}, || {}).await.map_err(|(_, e)| server_error(server, e))?.text;
    if answer.is_empty() {
        return Err(t("No response text."));
    }
    Ok(answer)
}

// ── Streaming ─────────────────────────────────────────────────────────────────

/// One server-sent event line.
#[derive(Debug, PartialEq)]
enum Event {
    /// `data: [DONE]`: the answer is complete. Some servers (LM Studio) keep
    /// the connection open after it, so the stream ends here, not at its close.
    Done,
    /// A piece of the answer's text.
    Text(String),
    /// Pieces of tool calls, each with its `index` (the OpenAI API streams a
    /// call's arguments in pieces; Ollama sends each call whole).
    Calls(Vec<Value>),
    /// What the request and its answer took, in tokens (the last event, with
    /// `stream_options.include_usage`).
    Usage(u64),
    /// A piece of the model's reasoning (`reasoning_content`, Ollama's
    /// `reasoning`), never shown: it only says the model is thinking.
    Reasoning,
    /// An error event.
    Error(String),
}

/// One server-sent event line, or None for anything else (other lines,
/// `[DONE]`, a delta without content, such as reasoning-only ones).
/// Whether an event line says the answer is over (`finish_reason` set): only
/// the usage chunk and `[DONE]` may follow.
fn finish_reason(line: &str) -> bool {
    let Some(payload) = line.strip_prefix("data:").map(str::trim_start) else { return false };
    payload.contains("finish_reason")
        && serde_json::from_str::<Value>(payload).ok().is_some_and(|j| j.pointer("/choices/0/finish_reason").is_some_and(Value::is_string))
}

/// What `stream` says when the connection closed before the answer said it
/// was over and nothing came: `server_error` puts it in words.
const CUT_SHORT: &str = "\u{0}cut short";

/// How long the stream waits for the usage chunk and `[DONE]` once the answer is over.
const AFTER_FINISH: Duration = Duration::from_secs(1);

fn parse_sse_line(line: &str) -> Option<Event> {
    let payload = line.strip_prefix("data:")?.trim_start();
    if payload == "[DONE]" {
        return Some(Event::Done);
    }
    let json: Value = serde_json::from_str(payload).ok()?;
    if let Some(msg) = json.pointer("/error/message").and_then(Value::as_str) {
        return Some(Event::Error(msg.to_string()));
    }
    // LM Studio and llama.cpp also say it as `{"error": "…"}`.
    if let Some(error) = json.get("error").filter(|e| !e.is_null()) {
        return Some(Event::Error(error.as_str().map(str::to_string).unwrap_or_default()));
    }
    if let Some(total) = json.pointer("/usage/total_tokens").and_then(Value::as_u64).filter(|_| json.pointer("/choices/0/delta/content").is_none()) {
        return Some(Event::Usage(total));
    }
    let delta = json.pointer("/choices/0/delta")?;
    if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array).filter(|c| !c.is_empty()) {
        return Some(Event::Calls(calls.clone()));
    }
    match delta.get("content").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(text) => Some(Event::Text(text.to_string())),
        None => ["reasoning_content", "reasoning"]
            .iter()
            .any(|k| delta.get(*k).and_then(Value::as_str).is_some_and(|r| !r.is_empty()))
            .then_some(Event::Reasoning),
    }
}

/// The tool calls of an answer, put together from their pieces: each one's
/// id, name and arguments (a JSON text), in order.
#[derive(Default)]
struct CallParts {
    calls: Vec<Value>,
}

impl CallParts {
    fn feed(&mut self, pieces: &[Value]) {
        for (n, piece) in pieces.iter().enumerate() {
            let index = piece["index"].as_u64().map(|i| i as usize).unwrap_or(self.calls.len().max(n));
            if index > 64 {
                continue;
            }
            while self.calls.len() <= index {
                self.calls.push(json!({ "id": "", "name": "", "arguments": "" }));
            }
            let call = &mut self.calls[index];
            if let Some(id) = piece["id"].as_str() {
                call["id"] = json!(id);
            }
            if let Some(name) = piece.pointer("/function/name").and_then(Value::as_str) {
                let joined = format!("{}{name}", call["name"].as_str().unwrap_or(""));
                call["name"] = json!(joined);
            }
            match piece.pointer("/function/arguments") {
                Some(Value::String(more)) => {
                    let joined = format!("{}{more}", call["arguments"].as_str().unwrap_or(""));
                    call["arguments"] = json!(joined);
                }
                // Some servers send the arguments as an object.
                Some(v @ Value::Object(_)) => call["arguments"] = json!(v.to_string()),
                _ => {}
            }
        }
    }

    fn done(self) -> Vec<Value> {
        self.calls.into_iter().filter(|c| c["name"].as_str().is_some_and(|n| !n.is_empty())).collect()
    }
}

/// Removes finished `<think>…</think>` blocks (reasoning models such as DeepSeek-R1).
fn filter_thinking_blocks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<think>") {
        let Some(len) = rest[start..].find("</think>") else { break };
        out.push_str(&rest[..start]);
        rest = &rest[start + len + "</think>".len()..];
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// For the text shown while streaming: finished blocks go, and so does
/// everything after a block that has not been closed yet.
fn progressive_filter(text: &str) -> String {
    let cleaned = filter_thinking_blocks(text);
    match cleaned.find("<think>") {
        Some(at) => cleaned[..at].trim().to_string(),
        None => cleaned,
    }
}

/// A streamed answer: its text without its thinking, and the tools it calls.
#[derive(Debug)]
struct Streamed {
    text: String,
    calls: Vec<Value>,
    /// The tokens the request and its answer took, when the server said.
    used: Option<u64>,
}

/// Posts the request without streaming and reads the whole answer: for a
/// server whose stream hung (LM Studio, `stream`'s CUT_SHORT).
async fn ask_whole(base: &Url, key: Option<&str>, model: &str, body: &Value) -> Result<Streamed, (u16, String)> {
    let mut body = body.clone();
    body["stream"] = json!(false);
    if let Some(b) = body.as_object_mut() {
        b.remove("stream_options");
    }
    let reply = net::client(base, Duration::from_secs(600))
        .map_err(|e| (0, e))?
        .post(net::join(base, "v1/chat/completions"))
        .header("Authorization", bearer(key))
        .json(&body)
        .send()
        .await
        .map_err(|e| (0, if e.is_timeout() { CUT_SHORT.to_string() } else { unreachable(base) }))?;
    let status = reply.status();
    if status.as_u16() == 404 {
        return Err((404, tf("{model} isn't installed. Pick another model above the chat box.", &[("model", model)])));
    }
    let bytes = net::read_capped(reply, net::MAX_BODY).await.map_err(|_| (0, CUT_SHORT.to_string()))?;
    if !status.is_success() {
        let detail = net::error_detail(&bytes);
        return Err((status.as_u16(), if detail.is_empty() { format!("HTTP {}", status.as_u16()) } else { detail }));
    }
    whole_answer(&bytes).map_err(|e| (0, e))
}

/// The text, tool calls and tokens of a whole (not streamed) answer.
fn whole_answer(bytes: &[u8]) -> Result<Streamed, String> {
    let json: Value = serde_json::from_slice(bytes).map_err(|_| CUT_SHORT.to_string())?;
    if let Some(e) = json.get("error").filter(|e| !e.is_null()) {
        return Err(e.pointer("/message").or(Some(e)).and_then(Value::as_str).unwrap_or_default().to_string());
    }
    let message = json.pointer("/choices/0/message").ok_or_else(|| CUT_SHORT.to_string())?;
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
    Ok(Streamed { text, calls, used: json.pointer("/usage/total_tokens").and_then(Value::as_u64) })
}

/// Posts the request and reads the event stream. `on_delta` gets the visible
/// text at most 15 times a second, and once more at the end; `on_think`, once,
/// when the model starts reasoning before any text. An error comes with the
/// HTTP status (0 when there was none).
async fn stream(
    base: &Url,
    key: Option<&str>,
    model: &str,
    body: &Value,
    mut on_delta: impl FnMut(String),
    mut on_think: impl FnMut(),
) -> Result<Streamed, (u16, String)> {
    let mut reply = net::streaming_client(base, Duration::from_secs(300))
        .map_err(|e| (0, e))?
        .post(net::join(base, "v1/chat/completions"))
        .header("Authorization", bearer(key))
        .json(body)
        .send()
        .await
        .map_err(|_| (0, unreachable(base)))?;

    let status = reply.status();
    if status.as_u16() == 404 {
        return Err((404, tf("{model} isn't installed. Pick another model above the chat box.", &[("model", model)])));
    }
    if !status.is_success() {
        let body = net::read_capped(reply, net::MAX_ERROR_BODY).await.unwrap_or_default();
        let detail = net::error_detail(&body);
        return Err((status.as_u16(), if detail.is_empty() { format!("HTTP {}", status.as_u16()) } else { detail }));
    }

    let mut accumulated = String::new();
    let mut calls = CallParts::default();
    let mut pending = Vec::<u8>::new();
    let mut last = Instant::now().checked_sub(DELTA_INTERVAL).unwrap_or_else(Instant::now);
    let mut thinking = false;
    let mut used = None;
    // The answer said it is over (`finish_reason`, `[DONE]`): what follows is
    // only waited for a moment, then the stream ends even if the connection stays open.
    let finished = std::sync::atomic::AtomicBool::new(false);
    let done = std::sync::atomic::AtomicBool::new(false);
    let mut take = |line: &str, accumulated: &mut String| -> Result<(), (u16, String)> {
        if finish_reason(line) {
            finished.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        match parse_sse_line(line) {
            Some(Event::Done) => done.store(true, std::sync::atomic::Ordering::Relaxed),
            Some(Event::Text(delta)) => accumulated.push_str(&delta),
            Some(Event::Reasoning) if !thinking && accumulated.is_empty() => {
                thinking = true;
                on_think();
            }
            Some(Event::Reasoning) => {}
            Some(Event::Usage(total)) => used = Some(total),
            Some(Event::Calls(pieces)) => calls.feed(&pieces),
            Some(Event::Error(message)) => return Err((0, message)),
            None => {}
        }
        Ok(())
    };
    loop {
        let next = if finished.load(std::sync::atomic::Ordering::Relaxed) {
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
            Err(_) if finished.load(std::sync::atomic::Ordering::Relaxed) => break,
            Err(_) => return Err((0, unreachable(base))),
        };
        pending.extend_from_slice(&chunk);
        // Whole lines only: a chunk may end in the middle of one, or of a character.
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            take(String::from_utf8_lossy(&line).trim_end(), &mut accumulated)?;
        }
        if done.load(std::sync::atomic::Ordering::Relaxed) {
            break;
        }
        if pending.len() > MAX_LINE || accumulated.len() > MAX_ANSWER {
            return Err((0, t("The server's answer is too large.")));
        }
        if last.elapsed() >= DELTA_INTERVAL {
            last = Instant::now();
            on_delta(progressive_filter(&accumulated));
        }
    }
    // A last line without its newline.
    take(String::from_utf8_lossy(&pending).trim_end(), &mut accumulated)?;
    // Closed before the answer was over, with nothing in it: the server gave up.
    let over = finished.load(std::sync::atomic::Ordering::Relaxed) || done.load(std::sync::atomic::Ordering::Relaxed);
    if !over && accumulated.trim().is_empty() && calls.calls.is_empty() {
        return Err((0, CUT_SHORT.to_string()));
    }
    // The last state always goes out, whatever the throttle skipped.
    on_delta(progressive_filter(&accumulated));
    Ok(Streamed { text: filter_thinking_blocks(&accumulated), calls: calls.done(), used })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::tests::serve_once;

    fn block_on<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    fn url(s: &str) -> Url {
        net::normalise_server_url(s).unwrap()
    }

    #[test]
    fn content_and_tool_calls_are_taken_from_the_event_stream() {
        let text = |s: &str| Some(Event::Text(s.into()));
        let line = r#"data: {"choices":[{"delta":{"content":"Hel"}}]}"#;
        assert_eq!(parse_sse_line(line), text("Hel"));
        let line = r#"data:{"choices":[{"delta":{"content":"lo"}}]}"#;
        assert_eq!(parse_sse_line(line), text("lo"));
        assert_eq!(parse_sse_line("data: [DONE]"), Some(Event::Done));
        assert!(finish_reason(r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#));
        assert!(!finish_reason(r#"data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}"#));
        assert_eq!(parse_sse_line(""), None);
        assert_eq!(parse_sse_line(": keep-alive"), None);
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#), None);
        // Reasoning only says the model is thinking (LM Studio's field, then Ollama's).
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"content":null,"reasoning_content":"x"}}]}"#), Some(Event::Reasoning));
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"content":"","reasoning":"x"}}]}"#), Some(Event::Reasoning));
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"content":""}}]}"#), None);
        // The last event says what the request and its answer took.
        assert_eq!(parse_sse_line(r#"data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":34,"total_tokens":1234}}"#), Some(Event::Usage(1234)));
        assert_eq!(parse_sse_line("data: not json"), None);
        assert_eq!(parse_sse_line(r#"data: {"error":{"message":"out of memory"}}"#), Some(Event::Error("out of memory".into())));
        let line = r#"data: {"choices":[{"delta":{"content":"","tool_calls":[{"index":0,"id":"c1","function":{"name":"set_timer"}}]}}]}"#;
        assert!(matches!(parse_sse_line(line), Some(Event::Calls(c)) if c.len() == 1));
    }

    #[test]
    fn a_tool_call_streamed_in_pieces_is_put_back_together() {
        let mut parts = CallParts::default();
        parts.feed(&[json!({"index":0,"id":"c1","function":{"name":"set_","arguments":""}})]);
        parts.feed(&[json!({"index":0,"function":{"name":"timer","arguments":"{\"min"}})]);
        parts.feed(&[json!({"index":0,"function":{"arguments":"utes\":5}"}}), json!({"index":1,"function":{"name":"listen","arguments":{"source":"x"}}})]);
        // A piece without a name is no call.
        parts.feed(&[json!({"index":2,"function":{"arguments":"{}"}})]);
        let calls = parts.done();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0], json!({"id":"c1","name":"set_timer","arguments":"{\"minutes\":5}"}));
        assert_eq!(calls[1]["name"], "listen");
        assert_eq!(calls[1]["arguments"], r#"{"source":"x"}"#);
    }

    #[test]
    fn plan_only_keeps_the_tools_that_only_look_and_none_of_the_users() {
        let tool = |id: &str| (id.to_string(), String::new(), json!({}));
        let all = vec![tool(crate::island_tools::SET_TIMER), tool("pdfcraft"), tool(crate::island_tools::LISTEN), tool("mail_read"), tool("mail_send")];
        let ids = |v: Vec<(String, String, Value)>| v.into_iter().map(|t| t.0).collect::<Vec<_>>();
        assert_eq!(ids(tools_for_mode(all.clone(), "plan")), vec![crate::island_tools::SET_TIMER, crate::island_tools::LISTEN, "mail_read"]);
        assert_eq!(ids(tools_for_mode(all.clone(), "default")).len(), 5);
        assert_eq!(ids(tools_for_mode(all, "auto")).len(), 5);
    }

    #[test]
    fn pictures_go_only_to_a_model_that_sees_them() {
        let dir = std::env::temp_dir().join(format!("lumo-local-vision-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("screenshot.png");
        std::fs::write(&png, [0x89, b'P', b'N', b'G']).unwrap();
        let txt = dir.join("notes.txt");
        std::fs::write(&txt, "hello").unwrap();
        let shared = vec![png.to_string_lossy().to_string(), txt.to_string_lossy().to_string()];

        let seen = user_message(true, false, None, "what's this?", &shared);
        let kinds: Vec<&str> = seen["content"].as_array().unwrap().iter().map(|p| p["type"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["image_url", "text", "text"]);
        let blind = user_message(false, false, None, "what's this?", &shared);
        let kinds: Vec<&str> = blind["content"].as_array().unwrap().iter().map(|p| p["type"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["text", "text"]);
        assert_eq!(user_message(false, false, None, "q", &[]), json!({"role":"user","content":"q"}));

        // A dropped picture: an image part for a model that sees, its name otherwise.
        let ctx = ChatContext::File { name: "pic.png".into(), path: png.to_string_lossy().into() };
        assert_eq!(user_message(true, true, Some(&ctx), "q", &[])["content"][0]["type"], "image_url");
        assert_eq!(user_message(false, true, Some(&ctx), "q", &[])["content"], "File: pic.png\n\nq");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finished_thinking_blocks_go_and_an_open_one_hides_what_follows() {
        assert_eq!(filter_thinking_blocks("<think>hmm</think>\n\nThe answer."), "The answer.");
        assert_eq!(filter_thinking_blocks("a<think>x</think>b<think>y</think>c"), "abc");
        assert_eq!(filter_thinking_blocks("plain"), "plain");
        // Streaming: nothing of an unfinished block shows.
        assert_eq!(progressive_filter("Sure. <think>let me think"), "Sure.");
        assert_eq!(progressive_filter("<think>still thinking"), "");
        assert_eq!(progressive_filter("<think>done</think>Visible <think>again"), "Visible");
        // A tag that is only half written is not a block yet.
        assert_eq!(progressive_filter("text <thi"), "text <thi");
    }

    #[test]
    fn the_request_streams_with_system_history_and_the_new_turn() {
        let history = vec![json!({"role":"user","content":"a"}), json!({"role":"assistant","content":"b"})];
        let body = request_body("llama3.2", "sys", &history, &json!({"role":"user","content":"c"}));
        assert_eq!(body["stream"], true);
        assert_eq!(body["model"], "llama3.2");
        assert_eq!(body["messages"].as_array().unwrap().len(), 4);
        assert_eq!(body["messages"][0]["role"], "system");
    }

    #[test]
    fn a_key_is_sent_as_the_bearer_and_without_one_the_placeholder_is() {
        assert_eq!(bearer(Some("sk-abc")), "Bearer sk-abc");
        assert_eq!(bearer(Some("")), "Bearer ollama");
        assert_eq!(bearer(None), "Bearer ollama");
    }

    #[test]
    fn a_server_that_is_not_connected_says_so() {
        let s = Settings::default();
        let ollama = server(&s, "ollama").unwrap();
        assert_eq!(base_url(&ollama).unwrap_err(), "Connect Ollama in Settings → Local models first.");
        assert!(server(&s, "openai").is_none());
        assert_eq!(usual_address("lmstudio").as_deref(), Some("http://127.0.0.1:1234"));
        assert_eq!(usual_address("custom"), None);
    }

    #[test]
    fn the_model_list_leaves_out_embedding_models_and_says_when_nothing_answers() {
        let body = br#"{"data":[{"id":"llama3.2"},{"id":"nomic-embed-text"},{"id":"BGE-large"},{"id":"qwen2.5-coder"}]}"#;
        let u = serve_once("200 OK", &format!("Content-Length: {}\r\n", body.len()), body.to_vec());
        assert_eq!(block_on(list(&url(&u), None)).unwrap(), vec!["llama3.2", "qwen2.5-coder"]);

        let u = serve_once("500 Internal Server Error", "Content-Length: 2\r\n", b"{}".to_vec());
        assert!(block_on(list(&url(&u), None)).unwrap_err().starts_with("Cannot reach"));
        let u = serve_once("200 OK", "Content-Length: 8\r\n", b"not json".to_vec());
        assert!(block_on(list(&url(&u), None)).unwrap_err().starts_with("Cannot reach"));
        assert!(block_on(list(&url("http://127.0.0.1:1"), None)).unwrap_err().starts_with("Cannot reach"));
        let u = serve_once("401 Unauthorized", "Content-Length: 2\r\n", b"{}".to_vec());
        assert!(block_on(list(&url(&u), Some("bad"))).unwrap_err().contains("refused the key"));
    }

    #[test]
    fn connect_cleans_a_pasted_address_and_reports_whether_it_is_this_machine() {
        let body = br#"{"data":[{"id":"m"}]}"#;
        let u = serve_once("200 OK", &format!("Content-Length: {}\r\n", body.len()), body.to_vec());
        let c = block_on(connect("lmstudio", &format!("{u}/v1/"))).unwrap();
        assert_eq!(c.url, u);
        assert_eq!(c.models, vec!["m"]);
        assert!(c.loopback);
        assert_eq!(block_on(connect("custom", " ")).unwrap_err(), "Enter the server address first.");
        assert!(block_on(connect("custom", "file:///etc")).is_err());
    }

    #[test]
    fn the_stream_is_read_line_by_line_and_thinking_stays_hidden() {
        let events = [
            r#"{"choices":[{"delta":{"content":"<think>\nstep "}}]}"#,
            r#"{"choices":[{"delta":{"content":"one\n</think>"}}]}"#,
            r#"{"choices":[{"delta":{"content":null,"reasoning_content":"internal"}}]}"#,
            r###"{"choices":[{"delta":{"content":"## Answer\n\n"}}]}"###,
            r#"{"choices":[{"delta":{"content":"- **item 1**\n"}}]}"#,
            r#"{"choices":[{"delta":{"content":"```python\nprint('hello')\n```"}}]}"#,
        ];
        let mut body = String::new();
        for e in events {
            body.push_str(&format!("data: {e}\n\n"));
        }
        body.push_str("data: [DONE]\n\n");
        let u = serve_once("200 OK", "Content-Type: text/event-stream\r\n", body.into_bytes());
        let mut seen = Vec::new();
        let mut thought = 0;
        let answer = block_on(stream(&url(&u), None, "m", &json!({}), |v| seen.push(v), || thought += 1)).unwrap().text;
        assert_eq!(thought, 0, "the reasoning came after the text had started");
        assert_eq!(answer, "## Answer\n\n- **item 1**\n```python\nprint('hello')\n```");
        assert_eq!(seen.last().unwrap(), &answer);
        assert!(seen.iter().all(|v| !v.contains("step") && !v.contains("internal")));
    }

    /// A server that sends `body` and then keeps the connection open, as LM
    /// Studio does after `[DONE]`.
    fn serve_and_hold(body: String) -> String {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            let _ = conn.set_read_timeout(Some(Duration::from_secs(10)));
            crate::net::tests::read_request(&mut conn);
            let _ = conn.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n");
            let _ = conn.write_all(body.as_bytes());
            let _ = conn.flush();
            std::thread::sleep(Duration::from_secs(20));
        });
        url
    }

    #[test]
    fn the_answer_ends_at_done_even_when_the_server_keeps_the_connection_open() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"Sunny.\"}}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"total_tokens\":42}}\n\n",
            "data: [DONE]\n\n",
        );
        let started = Instant::now();
        let streamed = block_on(stream(&url(&serve_and_hold(body.into())), None, "m", &json!({}), |_| {}, || {})).ok().unwrap();
        assert_eq!((streamed.text.as_str(), streamed.used), ("Sunny.", Some(42)));
        assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
        // No [DONE] at all: the finish_reason ends it a moment later.
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"Hi\"},\"finish_reason\":\"stop\"}]}\n\n";
        let started = Instant::now();
        let streamed = block_on(stream(&url(&serve_and_hold(body.into())), None, "m", &json!({}), |_| {}, || {})).ok().unwrap();
        assert_eq!(streamed.text, "Hi");
        assert!(started.elapsed() < AFTER_FINISH + Duration::from_secs(3), "{:?}", started.elapsed());
    }

    #[test]
    fn the_stream_brings_back_the_tools_the_model_calls() {
        let events = [
            r#"{"choices":[{"delta":{"content":"Setting it."}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"set_timer","arguments":"{\"minutes\":"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"5}"}}]}}]}"#,
        ];
        let body: String = events.iter().map(|e| format!("data: {e}\n\n")).collect();
        let u = serve_once("200 OK", "Content-Type: text/event-stream\r\n", body.into_bytes());
        let streamed = block_on(stream(&url(&u), None, "m", &json!({}), |_| {}, || {})).ok().unwrap();
        assert_eq!(streamed.text, "Setting it.");
        assert_eq!(streamed.calls, vec![json!({"id":"c1","name":"set_timer","arguments":"{\"minutes\":5}"})]);
    }

    #[test]
    fn a_whole_answer_brings_its_text_and_calls() {
        let body = br#"{"choices":[{"message":{"role":"assistant","content":"Ok.","tool_calls":[{"id":"c1","type":"function","function":{"name":"workspace_write","arguments":"{\"path\":\"file.txt\"}"}}]}}],"usage":{"total_tokens":42}}"#;
        let answer = whole_answer(body).unwrap();
        assert_eq!(answer.text, "Ok.");
        assert_eq!(answer.calls, vec![json!({"id":"c1","name":"workspace_write","arguments":"{\"path\":\"file.txt\"}"})]);
        assert_eq!(answer.used, Some(42));
        assert_eq!(whole_answer(br#"{"error":"terminated"}"#).err().unwrap(), "terminated");
        assert_eq!(whole_answer(b"").err().unwrap(), CUT_SHORT);
    }

    #[test]
    fn a_tool_call_written_as_text_is_caught() {
        let names = vec!["workspace_edit".to_string(), "web_search".to_string()];
        assert_eq!(written_call("Fatto.\n[[workspace_edit \"file.txt\" \"a\" \"b\"]]", &names).as_deref(), Some("workspace_edit"));
        assert_eq!(written_call("[web_search(query=\"meteo\")]", &names).as_deref(), Some("web_search"));
        assert_eq!(written_call("[[timer 10m: pasta]] and [link](https://x) about web_searching", &names), None);
        assert_eq!(written_call("Use [workspace_editor] later", &names), None);
    }

    #[test]
    fn stream_errors_say_what_happened() {
        let u = serve_once("404 Not Found", "Content-Length: 2\r\n", b"{}".to_vec());
        let err = block_on(stream(&url(&u), None, "unknown-model", &json!({}), |_| {}, || {})).err().unwrap();
        assert_eq!(err, (404, "unknown-model isn't installed. Pick another model above the chat box.".to_string()));
        let body = br#"{"error":{"message":"context too long"}}"#;
        let u = serve_once("400 Bad Request", &format!("Content-Length: {}\r\n", body.len()), body.to_vec());
        assert_eq!(block_on(stream(&url(&u), None, "m", &json!({}), |_| {}, || {})).err().unwrap(), (400, "context too long".to_string()));
        let u = serve_once("200 OK", "", b"data: {\"error\":{\"message\":\"crashed\"}}\n".to_vec());
        assert_eq!(block_on(stream(&url(&u), None, "m", &json!({}), |_| {}, || {})).err().unwrap().1, "crashed");
        let u = serve_once("200 OK", "", b"data: {\"error\":\"terminated\"}\n".to_vec());
        assert_eq!(block_on(stream(&url(&u), None, "m", &json!({}), |_| {}, || {})).err().unwrap().1, "terminated");
        // Closed with nothing and no end: cut short, never an empty answer.
        let u = serve_once("200 OK", "", b": ping\n".to_vec());
        assert_eq!(block_on(stream(&url(&u), None, "m", &json!({}), |_| {}, || {})).err().unwrap().1, CUT_SHORT);
    }

    #[test]
    fn an_endless_line_is_cut_off() {
        let u = serve_once("200 OK", "", vec![b'x'; MAX_LINE + 10]);
        let err = block_on(stream(&url(&u), None, "m", &json!({}), |_| {}, || {})).err().unwrap().1;
        assert_eq!(err, "The server's answer is too large.");
    }

    #[test]
    fn text_files_go_inline_cut_and_everything_else_by_name() {
        let dir = std::env::temp_dir().join(format!("lumo-local-chat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let txt = dir.join("notes.txt");
        std::fs::write(&txt, "é".repeat(MAX_INLINE_CHARS + 500)).unwrap();
        let note = file_note("notes.txt", txt.to_str().unwrap());
        let body = note.strip_prefix("File: notes.txt\nFile contents:\n").expect("inline text");
        let body = body.strip_suffix("\n[truncated]").expect("marked as cut");
        assert_eq!(body.chars().count(), MAX_INLINE_CHARS);

        let small = dir.join("small.md");
        std::fs::write(&small, "# hi").unwrap();
        assert_eq!(file_note("small.md", small.to_str().unwrap()), "File: small.md\nFile contents:\n# hi");

        let png = dir.join("pic.png");
        std::fs::write(&png, "not really a picture").unwrap();
        assert_eq!(file_note("pic.png", png.to_str().unwrap()), "File: pic.png");
        assert_eq!(file_note("gone.txt", "/no/such/file"), "File: gone.txt");
        let bin = dir.join("blob.bin");
        std::fs::write(&bin, [0xff, 0xfe, 0x00, 0x80]).unwrap();
        assert_eq!(file_note("blob.bin", bin.to_str().unwrap()), "File: blob.bin");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_custom_key_only_goes_to_the_address_it_was_entered_for() {
        let url = |u: &str| net::normalise_server_url(u).unwrap();
        let stored = serde_json::to_string(&BoundKey { url: "https://llm.example.com".into(), key: "sk-1".into() }).unwrap();
        assert_eq!(key_for(&stored, &url("https://llm.example.com")).as_deref(), Some("sk-1"));
        assert_eq!(key_for(&stored, &url("https://attacker.example")), None);
        assert_eq!(key_for(&stored, &url("http://llm.example.com")), None);
        // A plain string (the page can write one through secret_set) binds nothing.
        assert_eq!(key_for("sk-raw", &url("https://llm.example.com")), None);
        let local = serde_json::to_string(&BoundKey { url: "http://127.0.0.1:8080".into(), key: "k".into() }).unwrap();
        assert_eq!(key_for(&local, &url("http://127.0.0.1:8080")).as_deref(), Some("k"));
        assert!(!may_carry_key(&url("http://192.168.1.20:8080")));
    }
}
