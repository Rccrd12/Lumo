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
// A plan the model shows on the Plan island (update_plan) is kept up to date:
// lumo-local reminds the model when its tools go past it, sends it back once,
// unseen, when it answers with the plan behind, and shows a list of steps it wrote
// as the plan, and asks for one when a job takes several rounds of changes
// with none (lumo_local::plan). The plan tool is always offered, so a plan
// doesn't wait for the question to ask for one; each new question in a chat
// whose plan isn't done says where it stands.
//
// The chat's permission modes hold here too, as Unsloth Studio names them
// (tools.rs Asking): Ask for approval is a card for each call of the user's
// tools, even one they trust, and for each web search or page read; Approve
// for me asks for a tool they trust only when it looks risky (it reaches the
// internet, writes or touches the system, or the supervisor said to be
// careful with it); Run automatically doesn't ask for one that runs in the
// Windows sandbox; Plan only gives the model none of the user's tools, only
// the island's timer and listening. A tool they didn't trust (Ask every time)
// always asks.
//
// Nothing leaves the machine unless the user pointed the server address
// somewhere else: that address is the only place this module talks to.

use std::time::Duration;

use reqwest::Url;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

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
/// A dropped file's text, sent inline up to this many characters when the
/// model's context isn't known; the rest is cut.
const MAX_INLINE_CHARS: usize = 24_000;
/// How much of the context a dropped file's text may fill, with what the
/// chat already holds: the rest stays for the answer and its reasoning.
const FILE_SHARE_PCT: u64 = 60;
/// The least and the most of a file's text sent, whatever the context.
const MIN_FILE_CHARS: usize = 4_000;
const MAX_FILE_CHARS: usize = 1_000_000;

/// How many characters of a dropped file's text go to a model with `context`
/// tokens (0: not known), `taken` of them by the instructions, the tools and
/// the conversation: up to 60 % of the context, at about 3 characters a token.
fn file_chars(context: u64, taken: u64) -> usize {
    if context == 0 {
        return MAX_INLINE_CHARS;
    }
    let tokens = (context * FILE_SHARE_PCT / 100).saturating_sub(taken);
    usize::try_from(tokens.saturating_mul(3)).unwrap_or(MAX_FILE_CHARS).clamp(MIN_FILE_CHARS, MAX_FILE_CHARS)
}
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
    let mut models = list(id, &url, key_of(id, &url).as_deref()).await;
    // Unsloth Studio on its other usual port.
    if id == "unsloth" && typed.trim().is_empty() && models.is_err() {
        let other = net::normalise_server_url("http://127.0.0.1:8000")?;
        if let Ok(found) = list(id, &other, key_of(id, &other).as_deref()).await {
            url = other;
            models = Ok(found);
        }
    }
    let models = models?;
    Ok(Connected {
        url: url.as_str().trim_end_matches('/').to_string(),
        models: models.into_iter().map(|m| m.id).collect(),
        loopback: net::is_loopback_url(&url),
    })
}

/// The models of a connected server, for the picker in the chat view.
pub async fn models(server: &Server) -> Result<Vec<ModelInfo>, String> {
    let url = base_url(server)?;
    let models = list(server.id, &url, server.key.as_deref()).await?;
    if models.is_empty() {
        return Err(tf("No models yet. Download one in {name} first.", &[("name", &t(server.name))]));
    }
    Ok(models)
}

/// `GET /v1/models`, chat models only, or why the server can't be reached.
async fn list(id: &str, base: &Url, key: Option<&str>) -> Result<Vec<ModelInfo>, String> {
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
    let models = parse_models(&body).ok_or_else(|| unreachable(base))?;
    Ok(if id == "unsloth" { unsloth_models(models) } else { models.into_iter().map(|(id, _)| ModelInfo { label: id.clone(), id }).collect() })
}

/// The chat models of a `/v1/models` answer: each id, with its row.
fn parse_models(body: &Value) -> Option<Vec<(String, Value)>> {
    let items = body.get("data")?.as_array()?;
    Some(
        items
            .iter()
            // Unsloth Studio names its speech and music models' `task`: they don't chat.
            .filter(|m| m.get("task").is_none_or(Value::is_null))
            .filter_map(|m| Some((m.get("id")?.as_str()?.to_string(), m.clone())))
            .filter(|(id, _)| !NOT_CHAT.iter().any(|n| id.to_lowercase().contains(n)))
            .collect(),
    )
}

/// Unsloth Studio lists a repo with several quants once bare (its default
/// quant) and once per quant (`repo:Q4_K_M`), so the same file can come
/// twice. One row per repo and `quant`, the first listed (the bare id, which
/// a model picked before still names), shown as "display_name · quant".
fn unsloth_models(models: Vec<(String, Value)>) -> Vec<ModelInfo> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (id, row) in models {
        let quant = row.get("quant").and_then(Value::as_str).map(str::trim).filter(|q| !q.is_empty());
        let repo = quant
            .and_then(|q| {
                let (base, pinned) = id.rsplit_once(':')?;
                pinned.eq_ignore_ascii_case(q).then_some(base)
            })
            .unwrap_or(&id);
        if !seen.insert((repo.to_lowercase(), quant.map(str::to_lowercase))) {
            continue;
        }
        let name = row
            .get("display_name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| repo.rsplit('/').next().unwrap_or(repo));
        let label = match quant {
            Some(q) => format!("{name} · {q}"),
            None => name.to_string(),
        };
        out.push(ModelInfo { label, id });
    }
    out
}

// ── Messages ──────────────────────────────────────────────────────────────────

/// What a dropped file adds to its message: text inline (cut), a PDF's text
/// (pdf_text.rs), anything else by name only.
fn file_note(name: &str, path: &str, chars: usize) -> String {
    let ext = std::path::Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let binary = matches!(ext.as_str(), "pdf" | "jpg" | "jpeg" | "png" | "gif" | "webp");
    // Read no more than the inline limit can use (4 bytes per character at most).
    if ext == "pdf" {
        return match crate::pdf_text::text_cut(path, chars) {
            Some(text) => format!("File: {name}\nFile contents:\n{text}"),
            None => format!("File: {name}\n{}", crate::openai_compat::PDF_UNREAD),
        };
    }
    let text = if binary { None } else { read_prefix(path, chars.saturating_mul(4)) };
    match text {
        Some(text) if !text.is_empty() => {
            let mut body: String = text.chars().take(chars).collect();
            if body.len() < text.len() {
                body.push('\n');
                body.push_str(crate::pdf_text::CUT);
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

fn user_text(first: bool, context: Option<&ChatContext>, query: &str, chars: usize) -> String {
    match chat::turn_context(first, context) {
        Some(ChatContext::File { name, path }) => format!("{}\n\n{query}", file_note(name, path, chars)),
        Some(ChatContext::Window { app_name, title, url }) => {
            format!("{}\n\n{query}", chat::window_line(app_name, title, url.as_deref()))
        }
        None => query.to_string(),
    }
}

/// How long `message` reads to a model, in characters: a picture in it
/// (base64, hundreds of thousands of them) counts as the page it is, some
/// PAGE_TOKENS tokens, not as its text.
fn chars_of(message: &Value) -> usize {
    let mut pictures = 0;
    let mut plain = message.clone();
    if let Some(parts) = plain["content"].as_array_mut() {
        for part in parts.iter_mut().filter(|p| p["type"] == "image_url") {
            pictures += 1;
            part["image_url"]["url"] = Value::String(String::new());
        }
    }
    plain.to_string().len() + pictures * (crate::openai_compat::PAGE_TOKENS as usize) * 3
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
        crate::island_tools::NAMES.contains(&id)
            || id == crate::island_tools::UPDATE_PLAN
            || crate::mail_tool_defs::MAIL_NAMES.contains(&id)
            || crate::github_tools::NAMES.contains(&id)
            || crate::web_search::NAMES.contains(&id)
            || crate::workspace::READS.contains(&id)
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
    user_message_in(vision, crate::openai_compat::MAX_PDF_PAGES, MAX_INLINE_CHARS, first, context, query, shared)
}

/// `user_message`, with at most `pages` of a PDF drawn for a model that sees,
/// and at most `chars` of a dropped file's text.
fn user_message_in(vision: bool, pages: u32, chars: usize, first: bool, context: Option<&ChatContext>, query: &str, shared: &[String]) -> Value {
    use crate::openai_compat::PdfAs;
    // A PDF: pictures of its pages for a model that sees, when it has few; else its text.
    let pdf = if vision { PdfAs::TextAndPages { pages, chars } } else { PdfAs::Text };
    let dropped = matches!(chat::turn_context(first, context), Some(ChatContext::File { path, .. }) if is_image(path) || crate::openai_compat::is_pdf(path));
    let user = if vision && dropped {
        crate::openai_compat::user_message(first, context, query, pdf)
    } else {
        json!({ "role": "user", "content": user_text(first, context, query, chars) })
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
    /// The tools called in this answer, for the conversation to keep (`ran_note`).
    ran: &'a mut Vec<String>,
    all: &'a [(String, String, Value)],
    /// The system message, for the tools loaded (and none, for a model that takes none).
    prompt_for: &'a P,
    asking: crate::tools::Asking,
    /// The user's tools run in the Windows sandbox when they can (Sandbox High).
    sandbox_high: bool,
    /// The server's id, as the ring knows it.
    server: &'static str,
    /// The context the model is loaded with, in tokens (0: not said), for the ring.
    context: u64,
    /// The model puts its plan right after its answer: its tools say nothing.
    hushed: bool,
}

impl<P: Fn(&[String], bool) -> String + Sync> lumo_local::Hooks for Island<'_, P> {
    fn shown(&mut self, text: &str) {
        text.clone_into(self.shown);
        self.events.delta(self.app, text);
    }

    /// The ring follows each round of tools, not only the end of the answer.
    fn used(&mut self, tokens: u64) {
        let usage = crate::chat_usage::ChatUsage {
            provider: self.server.to_string(),
            context: Some(crate::chat_usage::ContextUse { chat: self.chat.id().to_string(), used: tokens, total: self.context }),
            tokens: None,
            requests: None,
            credits: None,
        };
        let _ = self.app.emit("chat-usage", usage);
    }

    fn doing(&mut self, doing: Doing) {
        self.events.activity(self.app, match doing {
            Doing::Prompt => Activity::new("prompt", ""),
            Doing::Thinking => Activity::thinking(),
            Doing::Reasoning => Activity::new("reasoning", ""),
            Doing::Calling(name) => Activity::new("calling", crate::claude_code::pretty_tool(&name)),
            Doing::Retrying { attempt, of } => Activity::new("retry", format!("{attempt}/{of}")),
            Doing::Correcting(why) => Activity::new("correcting", match why {
                lumo_local::Correction::Written => "written",
                lumo_local::Correction::SaidDone => "done",
                lumo_local::Correction::Stopped => "stopped",
            }),
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

    fn show_plan(&mut self, input: &Value) {
        crate::tools::show_plan(self.app, self.chat.id(), self.server, input);
    }

    fn hush(&mut self, on: bool) {
        self.hushed = on;
    }

    fn call(&mut self, name: &str, input: Value) -> impl std::future::Future<Output = (String, bool)> + Send {
        if !self.hushed {
            self.events.activity(self.app, if crate::web_search::NAMES.contains(&name) {
                crate::web_search::activity(name)
            } else if crate::workspace::NAMES.contains(&name) {
                crate::workspace::activity(name, &input)
            } else if crate::github_tools::NAMES.contains(&name) {
                crate::github_tools::activity(name, &input)
            } else {
                Activity::new("tool", crate::claude_code::pretty_tool(name))
            });
        }
        self.ran.push(if name == crate::web_search::SEARCH {
            let query = input.get("query").and_then(Value::as_str).unwrap_or("").trim().chars().take(120).collect::<String>();
            format!("{name} \"{query}\"")
        } else {
            name.to_string()
        });
        let (app, chat, asking, high, name) = (self.app, self.chat.id().to_string(), self.asking, self.sandbox_high, name.to_string());
        async move { crate::tools::call_for_chat(app, &chat, &name, input, asking, high).await }
    }
}

/// What stays in the conversation of the tools an answer called: their
/// results don't (they would fill a small context), so without it the model
/// takes its earlier searches for never made, and agrees when told so.
fn ran_note(ran: &[String]) -> String {
    let mut seen = std::collections::HashSet::new();
    let calls: Vec<&str> = ran.iter().filter(|c| seen.insert(c.as_str())).map(String::as_str).take(10).collect();
    if calls.is_empty() {
        String::new()
    } else {
        format!("\n\n(Lumo's note, not shown to the user: tools called for this answer: {}.)", calls.join(", "))
    }
}

/// An answer without a note like `ran_note`'s, should a model copy it from the conversation.
fn without_note(answer: &str) -> String {
    match answer.find("(Lumo's note, not shown to the user") {
        Some(at) => answer[..at].trim_end().to_string(),
        None => answer.to_string(),
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
    sandbox: &str,
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
    // The chat's plan, when it isn't done: said with the question.
    let open_plan = if caps.tools == Some(false) { None } else { crate::island_tools::open_plan(chat.id()) };
    // The tools, unless the server says the model takes none.
    // Run automatically ("off") is the local chat's own mode; the rest read as the CLIs'.
    let mode = if mode.trim() == "off" { "off" } else { crate::claude_code::permission_mode(mode) };
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
    // The plan tool always, for a model that takes tools: it makes a plan
    // for a job of more than one step without being asked to (as Claude
    // Code does), not only when the question says "plan".
    if (mode == "plan" || caps.tools != Some(false)) && !named.contains(&profile::Group::Plan) {
        named.push(profile::Group::Plan);
    }
    if chat.is_workshop() {
        named.push(profile::Group::User);
    }
    let loaded = profile::loaded(chat.id(), &profile::in_groups(&all, &named));
    let tools = profile::pick(&all, &loaded);
    let web = web && tools.iter().any(|(id, _, _)| crate::web_search::NAMES.contains(&id.as_str()));
    let asking = crate::tools::Asking::for_local(mode);
    let sandbox_high = sandbox != "low";
    let workspace = tools.iter().any(|(id, _, _)| id == crate::workspace::COPY);
    let today = profile::today();
    // What the model is told, for the tools it has loaded (and none, when the server takes none).
    let prompt_for = |loaded: &[String], tools: bool| {
        let groups: Vec<profile::Group> = profile::Group::ALL.into_iter().filter(|g| loaded.iter().any(|id| profile::group_of(id) == Some(*g))).collect();
        let catalog = profile::catalog(&all, loaded);
        profile::system_prompt(&profile::Prompt {
            first_name: crate::identity::first_name(),
            today: &today,
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
    let mut ran: Vec<String> = Vec::new();
    let events = chat.events();
    let answer = async {
        // A model not in memory is loaded first, so the island can say so
        // (with how far, when LM Studio tells); a local model then reads the
        // whole prompt before it writes, which takes a while too.
        // The picker is loading this model already: that load is waited for,
        // with its percent, rather than taken for a model in memory.
        let mut caps = caps.clone();
        if let Some(load) = crate::local_models::picker_load(server, model) {
            events.activity(app, Activity::new("loading", ""));
            crate::local_models::wait_for_picker(load, |percent| {
                events.activity(app, Activity::new("loading", percent.to_string()));
            })
            .await;
            caps = crate::local_models::caps(server, model).await;
        }
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
            caps = crate::local_models::caps(server, model).await;
        }
        // Pictures go unless the server says the model doesn't see them; one
        // that refuses them is asked again without (below).
        // A PDF's pages go as pictures as far as the context leaves room for
        // them, past the instructions, the tools, the conversation and the answer.
        let context_size = if caps.loaded_context > 0 { caps.loaded_context } else { caps.max_context };
        let taken_chars = system.len() + turn.history.iter().map(chars_of).sum::<usize>() + query.len() + if tools.is_empty() { 0 } else { crate::openai_compat::function_tools(&tools).to_string().len() };
        let taken = (taken_chars / 3) as u64 + u64::from(MAX_TOKENS);
        let pages = crate::openai_compat::pages_that_fit(context_size, taken);
        let chars = file_chars(context_size, (taken_chars / 3) as u64);
        user = user_message_in(caps.vision != Some(false), pages, chars, turn.first, context.as_ref(), &query, shared);
        // The same for a model that doesn't see: what goes if the server refuses the pictures.
        let mut text_only = user_message_in(false, 0, chars, turn.first, context.as_ref(), &query, shared);
        // A dropped file, to work on: where it is, to copy it.
        if workspace {
            if let Some(ChatContext::File { path, .. }) = chat::turn_context(turn.first, context.as_ref()) {
                let note = format!("(This file is at {path}: copy it with {} to work on it, or to read all of it.)", crate::workspace::COPY);
                append_text(&mut user, &note);
                append_text(&mut text_only, &note);
            }
        }
        if let Some(plan) = open_plan.as_ref().filter(|_| tools.iter().any(|(id, _, _)| id == crate::island_tools::UPDATE_PLAN)) {
            let note = lumo_local::plan::turn_note(plan);
            append_text(&mut user, &note);
            append_text(&mut text_only, &note);
        }
        body = request_body(model, &system, &turn.history, &user);
        // As long an answer as the context leaves room for, not 4 096 tokens.
        // The question counts as sent: the file's text, and a picture as the page it is.
        let prompt_chars = taken_chars - query.len() + chars_of(&user);
        body["max_tokens"] = json!(answer_room(context_size, (prompt_chars / 3) as u64));
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
            text_only: (text_only != user).then_some(text_only),
            plan: open_plan.clone(),
        };
        let mut island = Island { app, chat, events: &events, shown: &mut shown, ran: &mut ran, all: &all, prompt_for: &prompt_for, asking, sandbox_high, server: server.id, context: context_size, hushed: false };
        let outcome = lumo_local::run(&to, &mut body, &rules, &mut island).await;
        log_turn(server, model, prompt_chars / 3, tools.len(), &outcome);
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
            chat.commit(&turn, user, json!({ "role": "assistant", "content": format!("{shown}{}", ran_note(&ran)) }), &plain, &shown);
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
    let mut answer = without_note(&outcome.answer());
    if outcome.end == End::Cut {
        // Cut before a word of it: the context was full, or its reasoning took all the room.
        let full = usage.as_ref().and_then(|u| u.context.as_ref()).is_some_and(|c| c.total > 0 && c.used * 10 >= c.total * 9);
        let why = if !answer.trim().is_empty() {
            t("The answer was cut off at the length limit: ask to continue.")
        } else if full {
            t("The context is full and the model had no room left to answer: compact the chat from the context ring, then ask again.")
        } else {
            t("The model used all its room reasoning and wrote no answer: ask again, or turn reasoning down.")
        };
        answer = format!("{answer}\n\n_{why}_").trim_start().to_string();
    }
    if answer.is_empty() {
        return Err(t("No response text."));
    }
    chat.commit(&turn, user, json!({ "role": "assistant", "content": format!("{answer}{}", ran_note(&ran)) }), &plain, &answer);
    Ok(ChatReply::answer(answer, None))
}

/// A web search made by Unsloth Studio itself (its `web_search` tool, with
/// the model it has in memory), for a chat with it: its engines answer where
/// Lumo's own are taken for a robot. Only with a key: a caller without one
/// gets no tools, and its model would answer from memory. An answer with no
/// link is taken for a search that didn't happen.
pub async fn unsloth_search(query: &str, range: &str) -> Result<String, String> {
    let settings = crate::settings::load();
    let server = server(&settings, "unsloth").ok_or_else(|| "Unsloth Studio isn't connected".to_string())?;
    if server.key.is_none() {
        // Why, for the log: no key at all, or one kept for another address.
        let why = match secrets::get(UNSLOTH_KEY).and_then(|s| serde_json::from_str::<BoundKey>(&s).ok()) {
            None => "no key is stored".to_string(),
            Some(b) if b.key.is_empty() => "the stored key is empty".to_string(),
            Some(b) => format!("the key is stored for {} and Unsloth Studio is at {}", b.url, settings.unsloth_url.trim()),
        };
        return Err(format!("Unsloth Studio gives its tools only with a key, and {why}"));
    }
    let base = base_url(&server)?;
    let model = crate::local_models::loaded("unsloth").await?.into_iter().next().map(|m| m.handle).ok_or_else(|| "no model in memory".to_string())?;
    let when = match range {
        "day" => " Only pages from the last day.",
        "week" => " Only pages from the last week.",
        "month" => " Only pages from the last month.",
        "year" => " Only pages from the last year.",
        _ => "",
    };
    let system = format!(
        "Today is {}. Search the web with web_search for what the user writes, then report what the pages found say: the facts, names, numbers and dates, each with the link of its page as a Markdown link. Only what the pages say, nothing from memory; if they don't answer, say so. No introduction.",
        profile::today()
    );
    let user = json!({ "role": "user", "content": format!("{query}{when}") });
    let mut body = request_body(&model, &system, &[], &user);
    body["enable_tools"] = json!(true);
    body["enabled_tools"] = json!(["web_search"]);
    body["permission_mode"] = json!("off");
    body["enable_thinking"] = json!(false);
    body["max_tokens"] = json!(2_048);
    let to = endpoint(&server, &base)?;
    let answer = lumo_local::transport::stream(&to, &body, |_| {}).await.map_err(|f| failure(&server, &model, &base, f))?.text;
    let answer = answer.trim();
    if !answer.contains("http") {
        return Err("it answered with no link: no search was made".into());
    }
    Ok(format!("Web search by Unsloth Studio for \"{query}\" (its engines, its summary of the pages):\n\n{answer}"))
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

    #[test]
    fn the_conversation_keeps_which_tools_an_answer_called() {
        assert_eq!(ran_note(&[]), "");
        let ran = ["web_search \"a\"".to_string(), "web_fetch".into(), "web_search \"a\"".into()];
        assert_eq!(ran_note(&ran), "\n\n(Lumo's note, not shown to the user: tools called for this answer: web_search \"a\", web_fetch.)");
        assert_eq!(without_note(&format!("Found it.{}", ran_note(&ran))), "Found it.");
    }

    #[test]
    fn a_file_s_text_takes_up_to_60_percent_of_the_context() {
        assert_eq!(file_chars(0, 0), MAX_INLINE_CHARS);
        // 32k context, 2 500 tokens of instructions and tools: some 17k tokens of text.
        assert_eq!(file_chars(32_768, 2_500), (32_768 * 60 / 100 - 2_500) * 3);
        assert_eq!(file_chars(131_072, 2_500), (131_072 * 60 / 100 - 2_500) * 3);
        // A small or full context still gets the start of the file.
        assert_eq!(file_chars(4_096, 4_000), MIN_FILE_CHARS);
        assert_eq!(file_chars(10_000_000, 0), MAX_FILE_CHARS);
    }

    #[test]
    fn a_picture_in_the_conversation_counts_as_a_page_not_as_its_base64() {
        let big = format!("data:image/png;base64,{}", "A".repeat(300_000));
        let message = json!({ "role": "user", "content": [{ "type": "image_url", "image_url": { "url": big } }, { "type": "text", "text": "Cos'è?" }] });
        let chars = chars_of(&message);
        assert!(chars < 10_000, "{chars}");
        assert!(chars >= crate::openai_compat::PAGE_TOKENS as usize * 3);
        assert_eq!(chars_of(&json!({ "role": "user", "content": "Ciao" })), json!({ "role": "user", "content": "Ciao" }).to_string().len());
    }

    fn block_on<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    fn url(s: &str) -> Url {
        net::normalise_server_url(s).unwrap()
    }

    #[test]
    fn plan_only_keeps_the_tools_that_only_look_and_none_of_the_users() {
        let tool = |id: &str| (id.to_string(), String::new(), json!({}));
        let all = vec![
            tool(crate::island_tools::SET_TIMER),
            tool(crate::island_tools::UPDATE_PLAN),
            tool("pdfcraft"),
            tool(crate::island_tools::LISTEN),
            tool(crate::github_tools::OVERVIEW),
            tool("mail_read"),
            tool("mail_send"),
        ];
        let ids = |v: Vec<(String, String, Value)>| v.into_iter().map(|t| t.0).collect::<Vec<_>>();
        assert_eq!(
            ids(tools_for_mode(all.clone(), "plan")),
            vec![
                crate::island_tools::SET_TIMER,
                crate::island_tools::UPDATE_PLAN,
                crate::island_tools::LISTEN,
                crate::github_tools::OVERVIEW,
                "mail_read",
            ]
        );
        assert_eq!(ids(tools_for_mode(all.clone(), "default")).len(), 7);
        assert_eq!(ids(tools_for_mode(all, "auto")).len(), 7);
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
        let ids: Vec<String> = block_on(list("ollama", &url(&u), None)).unwrap().into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["llama3.2", "qwen2.5-coder"]);

        let u = serve_once("500 Internal Server Error", "Content-Length: 2\r\n", b"{}".to_vec());
        assert!(block_on(list("ollama", &url(&u), None)).unwrap_err().starts_with("Cannot reach"));
        let u = serve_once("200 OK", "Content-Length: 8\r\n", b"not json".to_vec());
        assert!(block_on(list("ollama", &url(&u), None)).unwrap_err().starts_with("Cannot reach"));
        assert!(block_on(list("ollama", &url("http://127.0.0.1:1"), None)).unwrap_err().starts_with("Cannot reach"));
        let u = serve_once("401 Unauthorized", "Content-Length: 2\r\n", b"{}".to_vec());
        assert!(block_on(list("ollama", &url(&u), Some("bad"))).unwrap_err().contains("refused the key"));
    }

    #[test]
    fn unsloth_studio_lists_each_file_once_by_its_name_and_quant() {
        // Two quants of Ornith on disk: the bare id is the default one (Q4_K_M),
        // then one row per quant; plus a video model and a model without a quant.
        let body = json!({ "data": [
            { "id": "AtomicChat/Ornith-1.5-35B-A3B-GGUF", "quant": "Q4_K_M", "display_name": "Ornith-1.5-35B-A3B-GGUF" },
            { "id": "QuantStack/Wan2.2-TI2V-5B-GGUF", "task": "text-to-video", "quant": "Q4_K_M" },
            { "id": "unsloth/gemma-4-26b-GGUF", "quant": "UD-Q4_K_XL", "loaded": true },
            { "id": "AtomicChat/Ornith-1.5-35B-A3B-GGUF:Q4_K_M", "quant": "Q4_K_M", "display_name": "Ornith-1.5-35B-A3B-GGUF" },
            { "id": "AtomicChat/Ornith-1.5-35B-A3B-GGUF:Q4_K", "quant": "Q4_K", "display_name": "Ornith-1.5-35B-A3B-GGUF" },
            { "id": "my-finetune", "display_name": " " },
            { "id": "unsloth/embeddinggemma-300m-GGUF", "quant": "Q8_0" }
        ] });
        let rows = unsloth_models(parse_models(&body).unwrap());
        let shown: Vec<(&str, &str)> = rows.iter().map(|m| (m.id.as_str(), m.label.as_str())).collect();
        assert_eq!(shown, [
            ("AtomicChat/Ornith-1.5-35B-A3B-GGUF", "Ornith-1.5-35B-A3B-GGUF · Q4_K_M"),
            ("unsloth/gemma-4-26b-GGUF", "gemma-4-26b-GGUF · UD-Q4_K_XL"),
            ("AtomicChat/Ornith-1.5-35B-A3B-GGUF:Q4_K", "Ornith-1.5-35B-A3B-GGUF · Q4_K"),
            ("my-finetune", "my-finetune"),
        ]);
        // Same repo and quant in another case is still the same file.
        let cased = json!({ "data": [{ "id": "o/m:q4_k_m", "quant": "q4_k_m" }, { "id": "O/M", "quant": "Q4_K_M" }] });
        assert_eq!(unsloth_models(parse_models(&cased).unwrap()).len(), 1);
    }

    #[test]
    fn the_list_names_unsloth_models_and_leaves_the_others_as_they_are() {
        let body = br#"{"data":[{"id":"o/m","quant":"Q4_K_M","display_name":"M"},{"id":"o/m:Q4_K_M","quant":"Q4_K_M","display_name":"M"}]}"#;
        let u = serve_once("200 OK", &format!("Content-Length: {}\r\n", body.len()), body.to_vec());
        assert_eq!(block_on(list("unsloth", &url(&u), None)).unwrap(), vec![ModelInfo { id: "o/m".into(), label: "M · Q4_K_M".into() }]);
        let u = serve_once("200 OK", &format!("Content-Length: {}\r\n", body.len()), body.to_vec());
        let ids: Vec<String> = block_on(list("custom", &url(&u), None)).unwrap().into_iter().map(|m| m.label).collect();
        assert_eq!(ids, ["o/m", "o/m:Q4_K_M"]);
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
        let note = file_note("notes.txt", txt.to_str().unwrap(), MAX_INLINE_CHARS);
        let body = note.strip_prefix("File: notes.txt\nFile contents:\n").expect("inline text");
        let body = body.strip_suffix(&format!("\n{}", crate::pdf_text::CUT)).expect("marked as cut");
        assert_eq!(body.chars().count(), MAX_INLINE_CHARS);

        let small = dir.join("small.md");
        std::fs::write(&small, "# hi").unwrap();
        assert_eq!(file_note("small.md", small.to_str().unwrap(), MAX_INLINE_CHARS), "File: small.md\nFile contents:\n# hi");

        let png = dir.join("pic.png");
        std::fs::write(&png, "not really a picture").unwrap();
        assert_eq!(file_note("pic.png", png.to_str().unwrap(), MAX_INLINE_CHARS), "File: pic.png");
        assert_eq!(file_note("gone.txt", "/no/such/file", MAX_INLINE_CHARS), "File: gone.txt");
        let bin = dir.join("blob.bin");
        std::fs::write(&bin, [0xff, 0xfe, 0x00, 0x80]).unwrap();
        assert_eq!(file_note("blob.bin", bin.to_str().unwrap(), MAX_INLINE_CHARS), "File: blob.bin");
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
