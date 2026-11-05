// The memory and the downloads of the user's model servers, for Settings →
// Local models: which model Ollama or LM Studio holds in memory, freeing it
// with one click, and downloading a model with its progress.
//
// Only the server the user connected is ever asked, at the address in the
// settings, and only when Settings asks: nothing runs in the background.
//
// - Ollama: `GET /api/ps` lists the models in memory; a request with
//   `keep_alive: 0` unloads one; `POST /api/pull` downloads one, its progress
//   streamed as JSON lines, one per layer.
// - LM Studio (0.4 and later, its REST API v1): `GET /api/v1/models` says
//   which models have instances loaded; `POST /api/v1/models/unload` unloads
//   one instance; `POST /api/v1/models/download` starts a download, and
//   `GET /api/v1/models/download/status/<job>` says how far it is.
//
// And what a model can do, for the chat (`caps`): whether it sees pictures,
// calls tools and reasons (with which levels), its longest context and the
// one it is loaded with. Ollama says it in `POST /api/show` (`capabilities`,
// `model_info`) and `GET /api/ps` (`context_length`, Ollama 0.12 and later);
// LM Studio in `GET /api/v1/models` (`capabilities`, `max_context_length`,
// each loaded instance's `config.context_length`). Any other server says
// nothing: the chat tries, and does without what it refuses.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use reqwest::Url;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::i18n::{t, tf};
use crate::local_chat::{self, Server};
use crate::net;

/// Asking what is loaded, or unloading: answered at once.
const QUICK: Duration = Duration::from_secs(10);
/// Unloading waits for the server to let the model go.
const UNLOAD: Duration = Duration::from_secs(60);
/// A download may stay silent this long (Ollama checks a layer, LM Studio
/// starts) before it is given up on.
const PULL_IDLE: Duration = Duration::from_secs(10 * 60);
/// How often LM Studio is asked how far its download is.
const POLL: Duration = Duration::from_secs(1);
/// The progress goes to Settings at most this often.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
/// The longest model name Lumo sends.
const MAX_NAME: usize = 300;
/// One line of Ollama's progress.
const MAX_LINE: usize = 64 * 1024;

/// The downloads running, by server.
static PULLING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// A model in memory.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Loaded {
    /// What the server calls it, as shown.
    pub name: String,
    /// What unloads it: Ollama's model name, LM Studio's instance id.
    #[serde(skip)]
    pub handle: String,
    /// Its size in bytes, when the server says (0 otherwise).
    pub size: u64,
    /// How much of it is in the graphics card's memory (Ollama), else 0.
    pub vram: u64,
}

/// How far a download is: bytes so far and in all (0 while unknown).
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub provider: String,
    pub model: String,
    pub completed: u64,
    pub total: u64,
}

/// Ollama or LM Studio, connected; anything else can't do this.
fn server_for(provider: &str) -> Result<(Server, Url), String> {
    let settings = crate::settings::load();
    let server = match provider {
        "ollama" | "lmstudio" => local_chat::server(&settings, provider),
        _ => None,
    }
    .ok_or_else(|| format!("Unknown model server: {provider}"))?;
    let url = local_chat::base_url(&server)?;
    Ok((server, url))
}

/// A model name we are willing to send: one word as the servers write them
/// (`llama3.2:3b`, `hf.co/user/repo:Q4_K_M`, `openai/gpt-oss-20b`, a Hugging
/// Face link for LM Studio), nothing else.
fn safe_name(name: &str) -> Option<&str> {
    let n = name.trim();
    let ok = !n.is_empty()
        && n.len() <= MAX_NAME
        && !n.starts_with('-')
        && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | ':' | '/' | '@' | '+'));
    ok.then_some(n)
}

// ── What is in memory ─────────────────────────────────────────────────────────

/// Ollama's `/api/ps`.
fn parse_ollama_ps(body: &Value) -> Vec<Loaded> {
    body["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let name = m["name"].as_str().or_else(|| m["model"].as_str())?.to_string();
            let handle = m["model"].as_str().unwrap_or(&name).to_string();
            Some(Loaded { name, handle, size: m["size"].as_u64().unwrap_or(0), vram: m["size_vram"].as_u64().unwrap_or(0) })
        })
        .collect()
}

/// LM Studio's `/api/v1/models`: each loaded instance.
fn parse_lmstudio_models(body: &Value) -> Vec<Loaded> {
    let mut out = Vec::new();
    for m in body["models"].as_array().into_iter().flatten() {
        let name = m["display_name"].as_str().or_else(|| m["key"].as_str()).unwrap_or("").to_string();
        for instance in m["loaded_instances"].as_array().into_iter().flatten() {
            let Some(id) = instance["id"].as_str() else { continue };
            let shown = if name.is_empty() { id.to_string() } else { name.clone() };
            out.push(Loaded { name: shown, handle: id.to_string(), size: m["size_bytes"].as_u64().unwrap_or(0), vram: 0 });
        }
    }
    out
}

async fn get_json(server: &Server, base: &Url, path: &str) -> Result<Value, String> {
    let response = net::client(base, QUICK)?
        .get(net::join(base, path))
        .header("Authorization", local_chat::bearer(server.key.as_deref()))
        .send()
        .await
        .map_err(|_| local_chat::unreachable(base))?;
    let status = response.status();
    let bytes = net::read_capped(response, net::MAX_BODY).await?;
    if status.as_u16() == 404 && server.id == "lmstudio" {
        return Err(t("This needs LM Studio 0.4 or later."));
    }
    if !status.is_success() {
        return Err(tf("{name}: {error}", &[("name", server.name), ("error", &net::error_detail(&bytes))]));
    }
    serde_json::from_slice(&bytes).map_err(|_| local_chat::unreachable(base))
}

async fn post_json(server: &Server, base: &Url, path: &str, body: Value, timeout: Duration) -> Result<Value, String> {
    let response = net::client(base, timeout)?
        .post(net::join(base, path))
        .header("Authorization", local_chat::bearer(server.key.as_deref()))
        .json(&body)
        .send()
        .await
        .map_err(|_| local_chat::unreachable(base))?;
    let status = response.status();
    let bytes = net::read_capped(response, net::MAX_BODY).await?;
    if status.as_u16() == 404 && server.id == "lmstudio" {
        return Err(t("This needs LM Studio 0.4 or later."));
    }
    if !status.is_success() {
        return Err(tf("{name}: {error}", &[("name", server.name), ("error", &net::error_detail(&bytes))]));
    }
    Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// The models `provider` holds in memory now.
pub async fn loaded(provider: &str) -> Result<Vec<Loaded>, String> {
    let (server, base) = server_for(provider)?;
    if server.id == "ollama" {
        Ok(parse_ollama_ps(&get_json(&server, &base, "api/ps").await?))
    } else {
        Ok(parse_lmstudio_models(&get_json(&server, &base, "api/v1/models").await?))
    }
}

/// Frees `provider`'s memory: every model it holds is unloaded. How many were.
pub async fn unload_all(provider: &str) -> Result<usize, String> {
    let (server, base) = server_for(provider)?;
    let models = loaded(provider).await?;
    for m in &models {
        if server.id == "ollama" {
            // Unloaded at once: no prompt, kept alive for no time at all.
            post_json(&server, &base, "api/generate", json!({ "model": m.handle, "keep_alive": 0 }), UNLOAD).await?;
        } else {
            post_json(&server, &base, "api/v1/models/unload", json!({ "instance_id": m.handle }), UNLOAD).await?;
        }
    }
    Ok(models.len())
}

// ── What a model can do ───────────────────────────────────────────────────────

/// What a local model can do, as its server says; None (or empty) where it
/// says nothing, as an OpenAI-compatible server of another kind never does.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Caps {
    /// It reads pictures (screenshots, a dropped image).
    pub vision: Option<bool>,
    /// It calls tools (the island's and the user's).
    pub tools: Option<bool>,
    /// It reasons: the levels it takes, from Lumo's names ("off", "on",
    /// "low", "medium", "high"); empty when it doesn't, or nobody says.
    pub reasoning: Vec<String>,
    /// The longest context it was made for, in tokens (0: not said).
    pub max_context: u64,
    /// The context it is loaded with now, in tokens (0: not loaded, or not said).
    pub loaded_context: u64,
    /// It is in memory now (None: not said), so the chat knows to load it first.
    pub loaded: Option<bool>,
}

/// How long what a server said about a model is kept: it changes when the
/// user loads the model again with another context, and is asked again then.
const CAPS_FRESH: Duration = Duration::from_secs(20);
/// What servers said, by server, address and model.
static CAPS: Mutex<Option<HashMap<String, (std::time::Instant, Caps)>>> = Mutex::new(None);

/// The levels Lumo offers, in order; anything else a server names is left out.
const LEVELS: &[&str] = &["off", "on", "low", "medium", "high"];

/// What `server` says `model` can do. Asked at most every few seconds per
/// model; a server that doesn't answer gives the empty Caps (nothing known).
pub async fn caps(server: &Server, model: &str) -> Caps {
    let Some(model) = safe_name(model) else { return Caps::default() };
    if !matches!(server.id, "ollama" | "lmstudio" | "unsloth") {
        return Caps::default();
    }
    let Ok(base) = local_chat::base_url(server) else { return Caps::default() };
    let key = format!("{}|{}|{model}", server.id, base.as_str());
    if let Some((at, caps)) = CAPS.lock().unwrap_or_else(|e| e.into_inner()).as_ref().and_then(|m| m.get(&key)) {
        if at.elapsed() < CAPS_FRESH {
            return caps.clone();
        }
    }
    let caps = if server.id == "ollama" {
        let show = post_json(server, &base, "api/show", json!({ "model": model }), QUICK).await;
        let ps = get_json(server, &base, "api/ps").await;
        match show {
            Ok(show) => parse_ollama_caps(model, &show, ps.as_ref().ok()),
            Err(e) => {
                crate::log::line(format!("[local] {model}: {e}"));
                Caps::default()
            }
        }
    } else if server.id == "unsloth" {
        // Unsloth Studio runs llama-server: its model list says what is in
        // memory, /v1/props what the loaded model was started with.
        let models = get_json(server, &base, "v1/models").await;
        let props = get_json(server, &base, "v1/props").await;
        match models {
            Ok(models) => parse_unsloth_caps(model, &models, props.as_ref().ok()),
            Err(e) => {
                crate::log::line(format!("[local] {model}: {e}"));
                Caps::default()
            }
        }
    } else {
        match get_json(server, &base, "api/v1/models").await {
            Ok(body) => parse_lmstudio_caps(model, &body),
            Err(e) => {
                crate::log::line(format!("[local] {model}: {e}"));
                Caps::default()
            }
        }
    };
    CAPS.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(key, (std::time::Instant::now(), caps.clone()));
    caps
}

/// Which of `models` (the chat picker's, as `/v1/models` names them) are in
/// `provider`'s memory now, for the picker's − and + (Ollama's `/api/ps`, LM
/// Studio's loaded instances).
pub async fn loaded_of(provider: &str, models: &[String]) -> Result<Vec<String>, String> {
    let (server, base) = server_for(provider)?;
    if server.id == "ollama" {
        let ps = get_json(&server, &base, "api/ps").await?;
        let names: Vec<String> = ps["models"].as_array().into_iter().flatten().flat_map(|m| [m["name"].as_str(), m["model"].as_str()]).flatten().map(str::to_string).collect();
        let same = |id: &str| names.iter().any(|n| n == id || n.strip_suffix(":latest") == Some(id));
        Ok(models.iter().filter(|id| same(id)).cloned().collect())
    } else {
        let body = get_json(&server, &base, "api/v1/models").await?;
        Ok(models.iter().filter(|id| lmstudio_entry(id, &body).is_some_and(|(_, instance)| instance.is_some())).cloned().collect())
    }
}

/// The picker's −: `model` leaves `provider`'s memory (every copy LM Studio
/// holds of it).
pub async fn unload(provider: &str, model: &str) -> Result<(), String> {
    let model = safe_name(model).ok_or_else(|| t("Pick a model above the chat box first."))?;
    let (server, base) = server_for(provider)?;
    if server.id == "ollama" {
        post_json(&server, &base, "api/generate", json!({ "model": model, "keep_alive": 0 }), UNLOAD).await?;
    } else {
        let body = get_json(&server, &base, "api/v1/models").await?;
        let ids: Vec<String> = lmstudio_entry(model, &body)
            .map(|(m, _)| m["loaded_instances"].as_array().into_iter().flatten().filter_map(|i| i["id"].as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        for id in ids {
            post_json(&server, &base, "api/v1/models/unload", json!({ "instance_id": id }), UNLOAD).await?;
        }
    }
    forget(&server, model);
    Ok(())
}

/// The picker's +: `model` is loaded into `provider`'s memory, how far told
/// as `local-load` events (LM Studio's percent; Ollama says nothing until it is in).
pub async fn load_for_picker(app: &AppHandle, provider: &str, model: &str) -> Result<(), String> {
    let (server, _) = server_for(provider)?;
    load(&server, model, |percent| {
        let _ = app.emit("local-load", json!({ "provider": provider, "model": model, "percent": percent }));
    })
    .await
}

/// What was said of `model` is asked again next time: it was just loaded.
pub fn forget(server: &Server, model: &str) {
    let Ok(base) = local_chat::base_url(server) else { return };
    let key = format!("{}|{}|{model}", server.id, base.as_str());
    if let Some(all) = CAPS.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        all.remove(&key);
    }
}

/// How long loading a model may take before it is given up on.
const LOAD: Duration = Duration::from_secs(10 * 60);

/// Loads `model` into memory before the chat's question goes, so the island
/// can say so: LM Studio tells how far it is (`on_progress`, 0–100), through
/// its own chat endpoint's `model_load.progress` events, and the stream is
/// dropped as soon as the model is in (nothing is written); Ollama loads it
/// for a request without a prompt, and says nothing until then. A server that
/// can't is no error: the question loads the model itself.
pub async fn load(server: &Server, model: &str, mut on_progress: impl FnMut(u8)) -> Result<(), String> {
    let model = safe_name(model).ok_or_else(|| t("Pick a model above the chat box first."))?;
    let base = local_chat::base_url(server)?;
    let result = if server.id == "ollama" {
        post_json(server, &base, "api/generate", json!({ "model": model }), LOAD).await.map(|_| ())
    } else if server.id == "lmstudio" {
        load_lmstudio(server, &base, model, &mut on_progress).await
    } else {
        Ok(())
    };
    forget(server, model);
    result
}

async fn load_lmstudio(server: &Server, base: &Url, model: &str, on_progress: &mut impl FnMut(u8)) -> Result<(), String> {
    let mut reply = net::streaming_client(base, LOAD)?
        .post(net::join(base, "api/v1/chat"))
        .header("Authorization", local_chat::bearer(server.key.as_deref()))
        .json(&json!({ "model": model, "input": "Hi", "stream": true, "store": false }))
        .send()
        .await
        .map_err(|_| local_chat::unreachable(base))?;
    if !reply.status().is_success() {
        return Err(format!("HTTP {}", reply.status().as_u16()));
    }
    let mut pending = Vec::<u8>::new();
    while let Some(chunk) = reply.chunk().await.map_err(|_| local_chat::unreachable(base))? {
        pending.extend_from_slice(&chunk);
        while let Some(end) = pending.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            match load_event(String::from_utf8_lossy(&line).trim_end()) {
                Some(LoadEvent::Progress(p)) => on_progress(p),
                // In memory: the rest of this answer is of no use.
                Some(LoadEvent::Loaded) => return Ok(()),
                None => {}
            }
        }
        if pending.len() > MAX_LINE {
            return Ok(());
        }
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
enum LoadEvent {
    /// How far the model is loaded, 0–100.
    Progress(u8),
    /// It is in memory (it was, or it is now): nothing more to wait for.
    Loaded,
}

/// One line of LM Studio's chat stream, as far as loading goes: `data:` lines
/// carry a `type` (model_load.progress with its `progress` from 0 to 1;
/// model_load.end; anything past loading means it is in).
fn load_event(line: &str) -> Option<LoadEvent> {
    let payload = line.strip_prefix("data:")?.trim_start();
    let v: Value = serde_json::from_str(payload).ok()?;
    match v["type"].as_str()? {
        "model_load.progress" => Some(LoadEvent::Progress((v["progress"].as_f64()?.clamp(0.0, 1.0) * 100.0).round() as u8)),
        "chat.start" | "model_load.start" => None,
        _ => Some(LoadEvent::Loaded),
    }
}

/// Ollama's `/api/show` of `model`, and its `/api/ps` for the context it is
/// loaded with. Its `capabilities` name "vision", "tools", "thinking"; its
/// `model_info` gives the longest context as `<architecture>.context_length`.
/// gpt-oss takes low, medium and high; Ollama's other thinking models think
/// or don't.
fn parse_ollama_caps(model: &str, show: &Value, ps: Option<&Value>) -> Caps {
    let said: Vec<&str> = show["capabilities"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
    let has = |c: &str| said.contains(&c);
    let known = !said.is_empty();
    let family = show.pointer("/details/family").and_then(Value::as_str).unwrap_or("").to_lowercase();
    let reasoning: &[&str] = if !has("thinking") {
        &[]
    } else if family.contains("gptoss") || family.contains("gpt-oss") || model.to_lowercase().contains("gpt-oss") {
        &["low", "medium", "high"]
    } else {
        &["off", "on"]
    };
    let max_context = show["model_info"]
        .as_object()
        .and_then(|info| info.iter().find(|(k, _)| k.ends_with(".context_length")).and_then(|(_, v)| v.as_u64()))
        .unwrap_or(0);
    // `/api/ps` names a model as it was asked for: "llama3.2" is "llama3.2:latest".
    let same = |name: &str| name == model || name.strip_suffix(":latest") == Some(model);
    let running = ps.and_then(|ps| ps["models"].as_array()).map(|all| {
        all.iter().find(|m| [m["name"].as_str(), m["model"].as_str()].into_iter().flatten().any(same)).cloned()
    });
    let loaded_context = running.clone().flatten().and_then(|m| m["context_length"].as_u64()).unwrap_or(0);
    Caps {
        vision: known.then(|| has("vision")),
        tools: known.then(|| has("tools")),
        reasoning: reasoning.iter().map(|s| s.to_string()).collect(),
        max_context,
        loaded_context,
        loaded: running.map(|m| m.is_some()),
    }
}

/// LM Studio's `/api/v1/models` entry for `model` (as `/v1/models` names it),
/// and its loaded instance if any: the entry whose key or variant is
/// `model`, else the one with a loaded instance by that id (a second copy of
/// a model is "key:2").
fn lmstudio_entry<'a>(model: &str, body: &'a Value) -> Option<(&'a Value, Option<Value>)> {
    let entries = body["models"].as_array()?;
    let instance_of = |m: &Value| m["loaded_instances"].as_array().into_iter().flatten().find(|i| i["id"].as_str() == Some(model)).cloned();
    entries
        .iter()
        .find(|m| m["key"].as_str() == Some(model) || m["selected_variant"].as_str() == Some(model))
        .map(|m| (m, m["loaded_instances"].get(0).cloned()))
        .or_else(|| entries.iter().find_map(|m| instance_of(m).map(|i| (m, Some(i)))))
}

/// LM Studio's `/api/v1/models`: what `model` can do (`lmstudio_entry`).
/// Unsloth Studio (llama-server underneath): `/v1/models` lists the models
/// with `loaded`, and llama-server's `meta.n_ctx_train`; `/v1/props`
/// describes the model in memory: its context (`n_ctx`), whether it reads
/// pictures (`modalities.vision`) and, from its chat template, tools.
/// What isn't said stays unknown.
fn parse_unsloth_caps(model: &str, models: &Value, props: Option<&Value>) -> Caps {
    let entry = models["data"].as_array().into_iter().flatten().chain(models["models"].as_array().into_iter().flatten()).find(|m| {
        [&m["id"], &m["name"], &m["model"]].iter().any(|v| v.as_str() == Some(model))
    });
    let loaded = entry.and_then(|m| m["loaded"].as_bool().or_else(|| m["status"]["value"].as_str().map(|s| s == "loaded")));
    let number = |v: &Value| v.as_u64().filter(|n| *n > 0);
    let max_context = entry
        .and_then(|m| number(&m["meta"]["n_ctx_train"]).or_else(|| number(&m["context_length"])).or_else(|| number(&m["max_context_length"])))
        .unwrap_or(0);
    let mut caps = Caps { max_context, loaded, ..Caps::default() };
    // The props are the loaded model's: only taken for it.
    let props = props.filter(|p| {
        let path = p["model_path"].as_str().unwrap_or("");
        let alias = p["model_alias"].as_str().or(p["alias"].as_str()).unwrap_or("");
        loaded != Some(false) && (alias == model || path.contains(model) || (alias.is_empty() && path.is_empty()))
    });
    if let Some(p) = props {
        caps.loaded_context = number(&p["default_generation_settings"]["n_ctx"]).or_else(|| number(&p["n_ctx"])).unwrap_or(0);
        caps.vision = p["modalities"]["vision"].as_bool();
        let template = &p["chat_template_caps"];
        caps.tools = template["supports_tool_calls"].as_bool().or(template["supports_tools"].as_bool());
        if caps.loaded.is_none() {
            caps.loaded = Some(true);
        }
    }
    caps
}

fn parse_lmstudio_caps(model: &str, body: &Value) -> Caps {
    let Some((m, instance)) = lmstudio_entry(model, body) else { return Caps::default() };
    let caps = &m["capabilities"];
    let reasoning = caps["reasoning"]["allowed_options"]
        .as_array()
        .map(|options| {
            let said: Vec<&str> = options.iter().filter_map(Value::as_str).collect();
            LEVELS.iter().filter(|l| said.contains(l)).map(|l| l.to_string()).collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Caps {
        vision: caps["vision"].as_bool(),
        tools: caps["trained_for_tool_use"].as_bool(),
        // A model that only reasons ("on" alone) has nothing to pick.
        reasoning: if reasoning.len() > 1 { reasoning } else { Vec::new() },
        max_context: m["max_context_length"].as_u64().unwrap_or(0),
        loaded_context: instance.as_ref().and_then(|i| i.pointer("/config/context_length").and_then(Value::as_u64)).unwrap_or(0),
        loaded: Some(instance.is_some()),
    }
}

/// What the chat sends as `reasoning_effort` (Ollama and LM Studio both take
/// it on their OpenAI-compatible API) for the level picked, when the model
/// takes that level: "off" is "none", "on" is "medium".
pub fn reasoning_effort(caps: &Caps, picked: &str) -> Option<&'static str> {
    if !caps.reasoning.iter().any(|l| l == picked) {
        return None;
    }
    match picked {
        "off" => Some("none"),
        "on" | "medium" => Some("medium"),
        "low" => Some("low"),
        "high" => Some("high"),
        _ => None,
    }
}

// ── Downloads ─────────────────────────────────────────────────────────────────

/// Ollama's progress, layer by layer: what each one has, summed.
#[derive(Default)]
struct OllamaPull {
    layers: HashMap<String, (u64, u64)>,
    error: Option<String>,
    success: bool,
}

impl OllamaPull {
    /// One line of `/api/pull`.
    fn feed(&mut self, line: &[u8]) {
        let Ok(v) = serde_json::from_slice::<Value>(line) else { return };
        if let Some(e) = v["error"].as_str() {
            self.error = Some(e.to_string());
            return;
        }
        if v["status"].as_str() == Some("success") {
            self.success = true;
        }
        if let (Some(digest), Some(total)) = (v["digest"].as_str(), v["total"].as_u64()) {
            let completed = v["completed"].as_u64().unwrap_or(0).min(total);
            let entry = self.layers.entry(digest.to_string()).or_default();
            *entry = (completed.max(entry.0), total);
        }
    }

    fn sums(&self) -> (u64, u64) {
        self.layers.values().fold((0, 0), |(c, t), (lc, lt)| (c + lc, t + lt))
    }
}

/// Only one download at a time for each server.
struct PullGuard(String);

impl PullGuard {
    fn take(provider: &str) -> Option<PullGuard> {
        let mut all = PULLING.lock().unwrap_or_else(|e| e.into_inner());
        all.get_or_insert_with(HashSet::new).insert(provider.to_string()).then(|| PullGuard(provider.to_string()))
    }
}

impl Drop for PullGuard {
    fn drop(&mut self) {
        if let Some(all) = PULLING.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            all.remove(&self.0);
        }
    }
}

/// Downloads `model` to `provider`, telling Settings how far it is
/// (`local-pull` events). Returns once it is there.
pub async fn pull(app: &AppHandle, provider: &str, model: &str) -> Result<(), String> {
    let model = safe_name(model).ok_or_else(|| t("Type the model's name as the server writes it, such as llama3.2 or openai/gpt-oss-20b."))?.to_string();
    let (server, base) = server_for(provider)?;
    let _guard = PullGuard::take(provider).ok_or_else(|| t("A download is already running."))?;
    let mut last = std::time::Instant::now() - PROGRESS_INTERVAL;
    let mut tell = |completed: u64, total: u64, force: bool| {
        if force || last.elapsed() >= PROGRESS_INTERVAL {
            last = std::time::Instant::now();
            let _ = app.emit("local-pull", Progress { provider: provider.to_string(), model: model.clone(), completed, total });
        }
    };
    tell(0, 0, true);
    if server.id == "ollama" {
        let mut response = net::streaming_client(&base, PULL_IDLE)?
            .post(net::join(&base, "api/pull"))
            .json(&json!({ "model": model, "name": model, "stream": true }))
            .send()
            .await
            .map_err(|_| local_chat::unreachable(&base))?;
        if !response.status().is_success() {
            let bytes = net::read_capped(response, net::MAX_BODY).await.unwrap_or_default();
            return Err(tf("{name}: {error}", &[("name", server.name), ("error", &net::error_detail(&bytes))]));
        }
        let mut state = OllamaPull::default();
        let mut buf: Vec<u8> = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| tf("Network error: {error}", &[("error", &e.to_string())]))? {
            buf.extend_from_slice(&chunk);
            while let Some(end) = buf.iter().position(|b| *b == b'\n') {
                let line: Vec<u8> = buf.drain(..=end).collect();
                state.feed(&line);
            }
            if buf.len() > MAX_LINE {
                buf.clear();
            }
            if let Some(e) = state.error.take() {
                return Err(tf("{name}: {error}", &[("name", server.name), ("error", &e)]));
            }
            let (c, t) = state.sums();
            tell(c, t, false);
        }
        state.feed(&buf);
        if let Some(e) = state.error {
            return Err(tf("{name}: {error}", &[("name", server.name), ("error", &e)]));
        }
        if !state.success {
            return Err(t("The download stopped before it was done."));
        }
        let (_, t) = state.sums();
        tell(t, t, true);
        return Ok(());
    }

    // LM Studio: the download is a job of its own, asked about once a second.
    let started = post_json(&server, &base, "api/v1/models/download", json!({ "model": model }), QUICK).await?;
    let mut status = started.clone();
    let job = started["job_id"].as_str().filter(|j| !j.is_empty() && j.len() <= 100 && j.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))).map(str::to_string);
    let mut silent = std::time::Instant::now();
    let mut seen = 0u64;
    loop {
        let total = status["total_size_bytes"].as_u64().unwrap_or(0);
        let done = status["downloaded_bytes"].as_u64().unwrap_or(0);
        let done = if total > 0 { done.min(total) } else { done };
        match status["status"].as_str().unwrap_or("") {
            "completed" | "already_downloaded" => {
                tell(total, total, true);
                return Ok(());
            }
            "failed" => return Err(t("LM Studio could not download the model.")),
            "paused" => return Err(t("The download is paused in LM Studio.")),
            _ => {}
        }
        tell(done, total, false);
        if done != seen {
            seen = done;
            silent = std::time::Instant::now();
        }
        if silent.elapsed() > PULL_IDLE {
            return Err(t("The download stopped before it was done."));
        }
        let Some(job) = &job else { return Err(t("The download stopped before it was done.")) };
        tokio::time::sleep(POLL).await;
        status = get_json(&server, &base, &format!("api/v1/models/download/status/{job}")).await?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ollama_says_what_a_model_can_do_and_the_context_it_runs_with() {
        let show = json!({
            "capabilities": ["completion", "vision", "tools", "thinking"],
            "details": { "family": "qwen3" },
            "model_info": { "general.architecture": "qwen3", "qwen3.context_length": 262144 },
        });
        let ps = json!({ "models": [{ "name": "qwen3-vl:8b", "model": "qwen3-vl:8b", "context_length": 65536 }] });
        let caps = parse_ollama_caps("qwen3-vl:8b", &show, Some(&ps));
        assert_eq!(caps, Caps { vision: Some(true), tools: Some(true), reasoning: vec!["off".into(), "on".into()], max_context: 262144, loaded_context: 65536, loaded: Some(true) });

        // gpt-oss takes levels; ":latest" is the same model; not loaded, no context.
        let show = json!({ "capabilities": ["completion", "tools", "thinking"], "details": { "family": "gptoss" } });
        let ps = json!({ "models": [{ "name": "llama3.2:latest", "context_length": 4096 }] });
        let caps = parse_ollama_caps("gpt-oss:20b", &show, Some(&ps));
        assert_eq!((caps.vision, caps.reasoning.len(), caps.loaded_context, caps.loaded), (Some(false), 3, 0, Some(false)));
        let caps = parse_ollama_caps("llama3.2", &json!({ "capabilities": ["completion"] }), Some(&ps));
        assert_eq!((caps.tools, caps.loaded_context), (Some(false), 4096));

        // An Ollama too old to say: nothing known.
        assert_eq!(parse_ollama_caps("m", &json!({}), None), Caps::default());
    }

    #[test]
    fn lm_studio_says_what_a_model_can_do_and_the_context_it_was_loaded_with() {
        let body = json!({ "models": [
            { "key": "google/gemma-4-26b-a4b", "max_context_length": 262144,
              "capabilities": { "vision": true, "trained_for_tool_use": true, "reasoning": { "allowed_options": ["off", "on"], "default": "on" } },
              "loaded_instances": [{ "id": "google/gemma-4-26b-a4b", "config": { "context_length": 65536 } }] },
            { "key": "deepseek/r1", "max_context_length": 131072,
              "capabilities": { "vision": false, "trained_for_tool_use": true, "reasoning": { "allowed_options": ["on"], "default": "on" } },
              "loaded_instances": [{ "id": "deepseek/r1:2", "config": { "context_length": 8192 } }] },
            { "key": "nomic-embed", "type": "embedding", "loaded_instances": [] },
        ] });
        let caps = parse_lmstudio_caps("google/gemma-4-26b-a4b", &body);
        assert_eq!(caps, Caps { vision: Some(true), tools: Some(true), reasoning: vec!["off".into(), "on".into()], max_context: 262144, loaded_context: 65536, loaded: Some(true) });
        // A second copy by its instance id; "on" alone is nothing to pick.
        let caps = parse_lmstudio_caps("deepseek/r1:2", &body);
        assert_eq!((caps.vision, caps.reasoning.is_empty(), caps.loaded_context), (Some(false), true, 8192));
        let embed = parse_lmstudio_caps("nomic-embed", &body);
        assert_eq!((embed.vision, embed.loaded), (None, Some(false)));
        assert_eq!(parse_lmstudio_caps("unknown", &body), Caps::default());
    }

    #[test]
    fn lm_studio_says_how_far_the_model_is_loaded_and_when_it_is_in() {
        assert_eq!(load_event(r#"data: {"type":"chat.start","model_instance_id":"m"}"#), None);
        assert_eq!(load_event(r#"data: {"type":"model_load.start","model_instance_id":"m"}"#), None);
        assert_eq!(load_event(r#"data: {"type":"model_load.progress","progress":0.424}"#), Some(LoadEvent::Progress(42)));
        assert_eq!(load_event(r#"data: {"type":"model_load.progress","progress":1.5}"#), Some(LoadEvent::Progress(100)));
        assert_eq!(load_event(r#"data: {"type":"model_load.end","load_time_seconds":3.1}"#), Some(LoadEvent::Loaded));
        // Already in memory: the prompt comes at once.
        assert_eq!(load_event(r#"data: {"type":"prompt_processing.start"}"#), Some(LoadEvent::Loaded));
        assert_eq!(load_event("event: model_load.progress"), None);
        assert_eq!(load_event("data: nope"), None);
    }

    #[test]
    fn the_level_picked_goes_as_reasoning_effort_only_when_the_model_takes_it() {
        let on_off = Caps { reasoning: vec!["off".into(), "on".into()], ..Caps::default() };
        assert_eq!(reasoning_effort(&on_off, "off"), Some("none"));
        assert_eq!(reasoning_effort(&on_off, "on"), Some("medium"));
        assert_eq!(reasoning_effort(&on_off, "high"), None);
        assert_eq!(reasoning_effort(&on_off, ""), None);
        let levels = Caps { reasoning: vec!["low".into(), "medium".into(), "high".into()], ..Caps::default() };
        assert_eq!(reasoning_effort(&levels, "low"), Some("low"));
        assert_eq!(reasoning_effort(&Caps::default(), "low"), None);
    }

    #[test]
    fn ollamas_models_in_memory_are_read_off_api_ps() {
        let body = json!({ "models": [
            { "name": "llama3.2:3b", "model": "llama3.2:3b", "size": 3_400_000_000u64, "size_vram": 3_000_000_000u64, "expires_at": "2026-10-22T15:00:00Z" },
            { "model": "qwen3:8b", "size": 6_000_000_000u64 },
        ] });
        let loaded = parse_ollama_ps(&body);
        assert_eq!(loaded.len(), 2);
        assert_eq!((loaded[0].name.as_str(), loaded[0].size, loaded[0].vram), ("llama3.2:3b", 3_400_000_000, 3_000_000_000));
        assert_eq!((loaded[1].name.as_str(), loaded[1].handle.as_str()), ("qwen3:8b", "qwen3:8b"));
        assert!(parse_ollama_ps(&json!({ "models": [] })).is_empty());
        assert!(parse_ollama_ps(&json!({})).is_empty());
    }

    #[test]
    fn lm_studios_loaded_instances_are_what_is_in_memory() {
        let body = json!({ "models": [
            { "type": "llm", "key": "openai/gpt-oss-20b", "display_name": "GPT-OSS 20B", "size_bytes": 12_000_000_000u64,
              "loaded_instances": [{ "id": "openai/gpt-oss-20b", "config": { "context_length": 4096 } }] },
            { "type": "llm", "key": "qwen/qwen3-8b", "size_bytes": 5_000_000_000u64, "loaded_instances": [] },
            { "type": "embedding", "key": "nomic-embed", "loaded_instances": [{ "id": "nomic-embed:2" }] },
        ] });
        let loaded = parse_lmstudio_models(&body);
        assert_eq!(loaded.len(), 2);
        assert_eq!((loaded[0].name.as_str(), loaded[0].handle.as_str(), loaded[0].size), ("GPT-OSS 20B", "openai/gpt-oss-20b", 12_000_000_000));
        assert_eq!((loaded[1].name.as_str(), loaded[1].handle.as_str()), ("nomic-embed", "nomic-embed:2"));
    }

    #[test]
    fn ollamas_progress_is_summed_over_its_layers() {
        let mut pull = OllamaPull::default();
        for line in [
            r#"{"status":"pulling manifest"}"#,
            r#"{"status":"pulling a1","digest":"sha256:a1","total":1000,"completed":100}"#,
            r#"{"status":"pulling b2","digest":"sha256:b2","total":50,"completed":50}"#,
            r#"{"status":"pulling a1","digest":"sha256:a1","total":1000,"completed":600}"#,
            "not json",
        ] {
            pull.feed(line.as_bytes());
        }
        assert_eq!(pull.sums(), (650, 1050));
        assert!(!pull.success);
        pull.feed(br#"{"status":"success"}"#);
        assert!(pull.success);
        pull.feed(br#"{"error":"pull model manifest: file does not exist"}"#);
        assert_eq!(pull.error.as_deref(), Some("pull model manifest: file does not exist"));
    }

    #[test]
    fn only_a_model_name_is_sent() {
        for ok in ["llama3.2", "llama3.2:3b", "hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M", "openai/gpt-oss-20b", "https://huggingface.co/lmstudio-community/gpt-oss-20b-GGUF"] {
            assert_eq!(safe_name(ok), Some(ok), "{ok}");
        }
        assert_eq!(safe_name("  qwen3:8b \n"), Some("qwen3:8b"));
        for bad in ["", "-rf", "llama 3", "a\"b", "x;y", &"a".repeat(MAX_NAME + 1)] {
            assert_eq!(safe_name(bad), None, "{bad}");
        }
    }

    #[test]
    fn one_download_at_a_time_for_each_server() {
        let first = PullGuard::take("test-server").unwrap();
        assert!(PullGuard::take("test-server").is_none());
        assert!(PullGuard::take("test-other").is_some());
        drop(first);
        assert!(PullGuard::take("test-server").is_some());
    }
    #[test]
    fn unsloth_studio_says_what_is_loaded_and_how() {
        let models = json!({ "data": [
            { "id": "gemma-4-26b", "loaded": true, "meta": { "n_ctx_train": 262144 } },
            { "id": "qwen3-8b", "loaded": false }
        ] });
        let props = json!({
            "model_alias": "gemma-4-26b",
            "default_generation_settings": { "n_ctx": 65536 },
            "modalities": { "vision": true },
            "chat_template_caps": { "supports_tool_calls": true }
        });
        let caps = parse_unsloth_caps("gemma-4-26b", &models, Some(&props));
        assert_eq!(caps, Caps { vision: Some(true), tools: Some(true), reasoning: vec![], max_context: 262144, loaded_context: 65536, loaded: Some(true) });
        // The props are the loaded model's, not another's.
        let other = parse_unsloth_caps("qwen3-8b", &models, Some(&props));
        assert_eq!(other, Caps { loaded: Some(false), ..Caps::default() });
        assert_eq!(parse_unsloth_caps("gone", &json!({}), None), Caps::default());
    }
}
