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

use std::time::Duration;

use reqwest::Url;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::chat::{self, Chat, ChatContext, ChatReply, ModelInfo};
use crate::claude_code::Activity;
use crate::local_models::Caps;
use crate::local_profile as profile;
use crate::settings::Settings;
use crate::i18n::{t, tf};
use crate::{net, secrets};
use lumo_local::guard::{answer_room, append_text};
use lumo_local::{Doing, End, Endpoint, Failure, Loaded, Outcome};

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

/// The tools a turn offers in permission `mode` (claude_code::permission_mode):
/// on Plan only, the island's own (a timer, listening) and the email's that
/// only read, none of the user's and nothing that sends or changes an email.
fn tools_for_mode(all: Vec<(String, String, Value)>, mode: &str) -> Vec<(String, String, Value)> {
    if mode != "plan" {
        return all;
    }
    let reads = |id: &str| {
        crate::island_tools::NAMES.contains(&id) || crate::mail_tool_defs::MAIL_NAMES.contains(&id) || crate::web_search::NAMES.contains(&id) || crate::workspace::READS.contains(&id)
    };
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

/// What the server said, in the user's language where Lumo knows it.
fn server_error(server: &Server, e: String) -> String {
    // The server dropped the answer halfway, or its model process ended
    // ("terminated", LM Studio): said as such, in the user's language.
    if lumo_local::Failure::Server(e.clone()).is_cut_short() {
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

/// What went wrong, in the user's language.
fn failure(server: &Server, model: &str, base: &Url, f: Failure) -> String {
    match f {
        Failure::NotInstalled => tf("{model} isn't installed. Pick another model above the chat box.", &[("model", model)]),
        Failure::Unreachable => unreachable(base),
        Failure::TooLarge => t("The server's answer is too large."),
        Failure::CutShort => server_error(server, "terminated".into()),
        Failure::Status(_, e) | Failure::Server(e) => server_error(server, e),
    }
}

/// Where the requests of a chat go, with the clients for them.
pub(crate) fn endpoint(server: &Server, base: &Url) -> Result<Endpoint, String> {
    Ok(Endpoint {
        url: net::join(base, "v1/chat/completions"),
        authorization: bearer(server.key.as_deref()),
        // No limit on an answer that streams in, only on five minutes of silence.
        streaming: net::streaming_client(base, Duration::from_secs(300))?,
        whole: net::client(base, Duration::from_secs(600))?,
        // Once the answer flows, a minute of silence is a stream that hung.
        stall: Duration::from_secs(60),
    })
}

/// The app, for a turn (lumo-local's `Hooks`): the island shows the answer
/// and what it is doing, and Lumo's tools run and load.
struct Island<'a, P> {
    app: &'a AppHandle,
    chat: &'a Chat,
    events: &'a chat::ChatEvents,
    /// What the island shows: kept if Stop is pressed mid-answer.
    shown: &'a mut String,
    all: &'a [(String, String, Value)],
    /// The system message, for the tools loaded (and none, for a model that takes none).
    prompt_for: &'a P,
    always_ask: bool,
}

impl<P: Fn(&[String], bool) -> String + Sync> lumo_local::Hooks for Island<'_, P> {
    fn shown(&mut self, text: &str) {
        text.clone_into(self.shown);
        self.events.delta(self.app, text);
    }

    fn doing(&mut self, doing: Doing) {
        self.events.activity(self.app, match doing {
            Doing::Prompt => Activity::new("prompt", ""),
            Doing::Thinking => Activity::thinking(),
        });
    }

    fn without_tools(&mut self) -> String {
        (self.prompt_for)(&[], false)
    }

    fn load(&mut self, name: &str, input: &Value, offered: &[String]) -> Option<Loaded> {
        // More of Lumo's tools, from now on in this chat: asked for by name,
        // or called straight from the catalog.
        let wanted = if name == profile::MORE {
            profile::asked(self.all, input)
        } else if profile::in_catalog(self.all, offered, name) {
            vec![name.to_string()]
        } else {
            return None;
        };
        let now = profile::loaded(self.chat.id(), &wanted);
        let tools = profile::pick(self.all, &now);
        Some(Loaded {
            wanted,
            tools: crate::openai_compat::function_tools(&tools),
            names: tools.iter().map(|(id, _, _)| id.clone()).collect(),
            system: (self.prompt_for)(&now, true),
        })
    }

    fn known(&self) -> Vec<String> {
        self.all.iter().map(|(id, _, _)| id.clone()).collect()
    }

    fn call(&mut self, name: &str, input: Value) -> impl std::future::Future<Output = (String, bool)> + Send {
        self.events.activity(self.app, if crate::web_search::NAMES.contains(&name) {
            crate::web_search::activity(name)
        } else if crate::workspace::NAMES.contains(&name) {
            crate::workspace::activity(name, &input)
        } else {
            Activity::new("tool", crate::claude_code::pretty_tool(name))
        });
        let (app, chat, always_ask, name) = (self.app, self.chat.id().to_string(), self.always_ask, name.to_string());
        async move { crate::tools::call_for_chat(app, &chat, &name, input, always_ask).await }
    }
}

/// The log's line for a turn: what it sent, what it took, how it ended.
fn log_turn(server: &Server, model: &str, prompt: usize, tools: usize, outcome: &Result<Outcome, Failure>) {
    let how = match outcome {
        Ok(o) => {
            let end = match o.end {
                End::Answer => "answered",
                End::Cut => "cut at the length limit",
                End::Rounds => "stopped after the last round of tools",
            };
            let used = o.used.map(|u| format!(", {u} tokens used")).unwrap_or_default();
            let fixes = if o.fixes.is_empty() { String::new() } else { format!(", put right: {}", o.fixes.join(", ")) };
            let notes = if o.notes.is_empty() { String::new() } else { format!(", on the way: {}", o.notes.join(" | ")) };
            format!("{end}{} after {} rounds{used}{fixes}{notes}", if o.whole { " whole" } else { "" }, o.rounds)
        }
        Err(f) => format!("failed: {f:?}"),
    };
    crate::log::line(format!("[local] {} {model}: ~{prompt} tokens of prompt, {tools} tools; {how}", server.id));
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
    // Lumo's own web search, when the user turned it on (web_search.rs).
    let web = caps.tools != Some(false) && tauri::async_runtime::spawn_blocking(crate::web_search::enabled).await.unwrap_or(false);
    // Every tool the chat could have; a local model starts with the core ones
    // and those of the groups the question names (local_profile.rs).
    let all = if caps.tools == Some(false) {
        Vec::new()
    } else {
        let all = tauri::async_runtime::spawn_blocking(move || crate::tools::chat_tools(mail, web, true)).await.unwrap_or_default();
        tools_for_mode(all, mode)
    };
    let user_tools: Vec<_> = all.iter().filter(|(id, _, _)| profile::group_of(id) == Some(profile::Group::User)).cloned().collect();
    let mut named = profile::named_groups(&query, &user_tools);
    if chat.is_workshop() {
        named.push(profile::Group::User);
    }
    let loaded = profile::loaded(chat.id(), &profile::in_groups(&all, &named));
    let tools = profile::pick(&all, &loaded);
    let web = web && tools.iter().any(|(id, _, _)| crate::web_search::NAMES.contains(&id.as_str()));
    let always_ask = mode == "default";
    let workspace = tools.iter().any(|(id, _, _)| id == crate::workspace::COPY);
    // What the model is told, for the tools it has loaded (and none, when the server takes none).
    let prompt_for = |loaded: &[String], tools: bool| {
        let groups: Vec<profile::Group> = profile::Group::ALL.into_iter().filter(|g| loaded.iter().any(|id| profile::group_of(id) == Some(*g))).collect();
        let catalog = profile::catalog(&all, loaded);
        profile::system_prompt(&profile::Prompt {
            first_name: crate::identity::first_name(),
            tools,
            web: web && tools,
            timer: tools,
            workspace: workspace && tools,
            groups: &groups,
            catalog: &catalog,
            mail: if mode == "plan" && !mail.is_empty() { "mail" } else { mail },
            plan: mode == "plan",
            workshop: chat.is_workshop(),
        })
    };
    let system = prompt_for(&loaded, !tools.is_empty());
    // Built once the model is in memory, when its server says what it can do.
    let mut user = Value::Null;
    let mut body = Value::Null;

    // What the island shows so far: kept if Stop is pressed mid-answer. What
    // was said before each round of tools stays above the round after it.
    let mut shown = String::new();
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
        // A dropped file, to work on: where it is, to copy it.
        if workspace {
            if let Some(ChatContext::File { path, .. }) = chat::turn_context(turn.first, context.as_ref()) {
                append_text(&mut user, &format!("(This file is at {path}: copy it with {} to work on it.)", crate::workspace::COPY));
            }
        }
        body = request_body(model, &system, &turn.history, &user);
        // As long an answer as the context leaves room for, not 4 096 tokens.
        body["max_tokens"] = json!(answer_room(context_size, (taken_chars / 3) as u64 + u64::from(pages) * crate::openai_compat::PAGE_TOKENS));
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
        let to = endpoint(server, &base)?;
        let rules = lumo_local::Rules {
            key: format!("{}\u{0}{model}", server.id),
            query: &query,
            workspace,
            changes: &[crate::workspace::WRITE, crate::workspace::EDIT, crate::workspace::DELETE],
            max_rounds: MAX_TOOL_ROUNDS,
            pause: Duration::from_secs(1),
        };
        let mut island = Island { app, chat, events: &events, shown: &mut shown, all: &all, prompt_for: &prompt_for, always_ask };
        let outcome = lumo_local::run(&to, &mut body, &rules, &mut island).await;
        log_turn(server, model, taken_chars / 3, tools.len(), &outcome);
        outcome.map_err(|f| failure(server, model, &base, f))
    };
    let streamed = chat.unless_stopped(answer).await;
    let plain = chat::plain_question(turn.first, context.as_ref(), &query);
    // The question as it went, without the pictures a server refused.
    let user = match body["messages"].get(1 + turn.history.len()) {
        Some(sent) if !sent.is_null() => sent.clone(),
        _ => user,
    };
    let Some(outcome) = streamed else {
        // The connection is closed. What was written stays in the conversation.
        if !shown.is_empty() {
            chat.commit(&turn, user, json!({ "role": "assistant", "content": shown }), &plain, &shown);
        }
        return Ok(ChatReply::stopped(shown, None));
    };
    let outcome = outcome?;
    // How full the context is, out of what the model is loaded with now.
    if let Some(used) = outcome.used {
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
    // After the tools, what was said before each call comes first; an answer
    // stopped at the length limit says so under it.
    let mut answer = outcome.answer();
    if outcome.end == End::Cut {
        answer = format!("{answer}\n\n_{}_", t("The answer was cut off at the length limit: ask to continue.")).trim_start().to_string();
    }
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
    let to = endpoint(server, &base)?;
    let answer = lumo_local::transport::stream(&to, &body, |_| {}).await.map_err(|f| failure(server, model, &base, f))?.text;
    if answer.is_empty() {
        return Err(t("No response text."));
    }
    Ok(answer)
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
