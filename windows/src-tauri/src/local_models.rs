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
}
