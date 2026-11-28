// Maya (maya-inkling-mini, github.com/alesha-pro/maya-inkling-mini), started
// and stopped by Lumo like Unsloth Studio (unsloth_studio.rs): an engine
// written for Inkling 2 Mini alone, with its own OpenAI-compatible server
// (`serve/server.py`). The user builds it once in a folder of their own, as
// its guide says; Lumo never builds, installs or downloads anything. Settings
// → Chat → Local models takes that folder, and Lumo writes the server's
// config itself from what the user picked there (their graphics card, the
// context, vision, the drafter), in Lumo's own data folder: the folder's own
// files are never written.
//
// The server runs as `python -X utf8 serve/server.py --engine maya --config
// <Lumo's config> --host 127.0.0.1 --port 18000 --fit-max-tokens`, with no
// window, from the folder's own .venv when it has one, else the Python on
// PATH. `--fit-max-tokens`: an answer longer than the context leaves is cut
// to fit rather than refused. Its output goes to a log in Lumo's data
// folder, which an error points to, and the engine's own lines (stderr) to
// engine.log beside it.
//
// Lumo only ever stops a server it started itself, as with Unsloth Studio:
// one the user opened stays as it is, and the one Lumo started is in Lumo's
// job, so it ends with Lumo even after a crash, unless "Stop after" is Never.
// Nothing runs while Maya isn't wanted.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::Url;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::i18n::{t, tf};
use crate::settings::Settings;
use crate::unsloth_studio::{ticking, waiting};
use crate::{net, platform};

/// The island and Settings follow Maya's state through this event.
pub const EVENT: &str = "maya-server";

/// The port Lumo's Maya listens on (Maya's own default is 8095, its guide's 18000).
pub const PORT: u16 = 18000;
/// The one model Maya serves.
pub const MODEL: &str = "inkling-2-mini";

/// The longest a start may take: the first one reads 17.6 GB from the disk.
const START_LIMIT: Duration = Duration::from_secs(10 * 60);
/// How often a start looks whether the server answers yet.
const START_POLL: Duration = Duration::from_millis(500);
/// How often the idle watcher looks, while Lumo's Maya runs.
const IDLE_POLL: Duration = Duration::from_secs(30);

/// What the folder must hold, relative to it.
const SERVER: &str = "serve/server.py";
const WEIGHTS: &str = "models/Inkling-2-Mini-UD-Q4_K_XL.gguf";
const TOKENIZER: &str = "ik2/tokenizer";
const DRAFTER: &str = "models/mtp.safetensors";
const MMPROJ: &str = "models/mmproj-BF16.gguf";

/// The contexts a card of 24 GB or more takes: with the drafter, and without (the guide's configs).
const FULL_CONTEXT_DRAFTER: u64 = 262_144;
const FULL_CONTEXT: u64 = 344_064;
/// The most a smaller card takes: the experts' cache shrinks as the context grows.
const SMALL_CONTEXT: u64 = 65_536;
/// A smaller card's context unless the user picks another.
const SMALL_DEFAULT: u64 = 16_384;
/// The least context Lumo asks for.
const MIN_CONTEXT: u64 = 4_096;
/// The drafter's global layer sees at most this much (the guide's IK2_DRAFT_CTX).
const DRAFT_CTX: u64 = 65_536;

/// The server Lumo started.
struct Owned {
    child: Child,
    started: Instant,
    ready: bool,
    last_used: Instant,
    busy: usize,
    /// The config it was started with: another one in Settings now starts it again.
    config: String,
}

static OWNED: Mutex<Option<Owned>> = Mutex::new(None);
/// One start at a time: a second caller waits for the first one's server.
static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// What Settings and the chat's picker show.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The folder holds everything the server needs.
    pub installed: bool,
    /// "off", "starting" or "on".
    pub state: &'static str,
    /// Lumo started it, so Lumo stops it.
    pub owned: bool,
    /// How long the start has taken so far.
    pub seconds: u64,
    /// Started with other settings than Settings has now: they apply once it starts again.
    pub outdated: bool,
}

// ── The folder ────────────────────────────────────────────────────────────────

/// What a Maya folder holds.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Install {
    /// Everything the server needs is there.
    pub ready: bool,
    /// What is missing, in a sentence; "" when nothing is.
    pub missing: String,
    /// The drafter's weights are there (`hf download … mtp.safetensors`).
    pub drafter: bool,
    /// The image encoder is built and its weights are there.
    pub vision: bool,
}

/// The engine as the build leaves it: Ninja puts it in build/, Visual
/// Studio's generator in build/Release/.
fn engine_in(dir: &Path) -> Option<PathBuf> {
    ["build/maya-ik2.exe", "build/Release/maya-ik2.exe", "build/maya-ik2"].into_iter().map(|p| dir.join(p)).find(|p| p.is_file())
}

/// The image encoder, built beside the engine (tools/vision).
fn vision_in(dir: &Path) -> Option<PathBuf> {
    ["build-vision/bin/maya-vision.exe", "build-vision/bin/Release/maya-vision.exe", "build-vision/Release/maya-vision.exe", "build-vision/bin/maya-vision"]
        .into_iter()
        .map(|p| dir.join(p))
        .find(|p| p.is_file())
}

/// The Python that runs the server: the folder's own environment (START-MAYA.bat
/// makes `.venv`), else the one on PATH, never the Microsoft Store's stub.
fn python_in(dir: &Path) -> Option<PathBuf> {
    [".venv", "venv"]
        .into_iter()
        .map(|v| dir.join(v).join("Scripts").join("python.exe"))
        .find(|p| p.is_file())
        .or_else(|| platform::find_on_path("python").filter(|p| !p.to_string_lossy().contains("WindowsApps")))
}

/// What `dir` holds, checked as Settings shows it.
pub fn install(dir: &str) -> Install {
    let dir = Path::new(dir.trim());
    if dir.as_os_str().is_empty() || !dir.is_dir() {
        return Install { missing: t("This folder doesn't exist."), ..Default::default() };
    }
    let drafter = dir.join(DRAFTER).is_file();
    let vision = vision_in(dir).is_some() && dir.join(MMPROJ).is_file();
    let missing = if !dir.join(SERVER).is_file() {
        t("This isn't a maya-inkling-mini folder: serve/server.py isn't in it.")
    } else if engine_in(dir).is_none() {
        t("The engine isn't built yet: build maya-ik2 as the project's guide says, then connect again.")
    } else if !dir.join(WEIGHTS).is_file() {
        tf("The model isn't downloaded yet: {file} goes in the models folder.", &[("file", "Inkling-2-Mini-UD-Q4_K_XL.gguf")])
    } else if !dir.join(TOKENIZER).is_dir() {
        t("The tokenizer isn't made yet: run tools/strata_tokenizer.py as the project's guide says.")
    } else if python_in(dir).is_none() {
        t("Python isn't found: neither the folder's .venv nor a Python on PATH.")
    } else {
        String::new()
    };
    Install { ready: missing.is_empty(), missing, drafter, vision }
}

/// Settings → Local models → Maya → Connect: the folder holds a Maya that
/// runs, so it is kept, with the address Lumo will start it at.
pub fn connect(dir: &str) -> Result<crate::local_chat::Connected, String> {
    let found = install(dir);
    if !found.ready {
        return Err(found.missing);
    }
    Ok(crate::local_chat::Connected { url: address(), models: vec![MODEL.to_string()], loopback: true })
}

/// Where Lumo's Maya answers.
pub fn address() -> String {
    format!("http://127.0.0.1:{PORT}")
}

fn base() -> Url {
    Url::parse(&address()).expect("a loopback address")
}

// ── Its config ────────────────────────────────────────────────────────────────

/// A card of 24 GB or more holds every expert; a smaller one ("8", "12", "16")
/// keeps them in the computer's memory with a cache on the card.
fn full_card(vram: &str) -> bool {
    !matches!(vram, "8" | "12" | "16")
}

/// The longest context the settings allow.
pub fn max_context(settings: &Settings) -> u64 {
    if !full_card(&settings.maya_vram) {
        SMALL_CONTEXT
    } else if settings.maya_drafter {
        FULL_CONTEXT_DRAFTER
    } else {
        FULL_CONTEXT
    }
}

/// The context Maya starts with: the one picked (0: the card's usual one),
/// within what the card takes.
pub fn context(settings: &Settings) -> u64 {
    let max = max_context(settings);
    let picked = match settings.maya_context {
        0 if full_card(&settings.maya_vram) => max,
        0 => SMALL_DEFAULT,
        n => n,
    };
    picked.clamp(MIN_CONTEXT, max)
}

/// The experts' cache on a smaller card, in GB: the card less what the rest needs.
fn cache_gb(vram: &str) -> &'static str {
    match vram {
        "16" => "14",
        "12" => "10",
        _ => "7",
    }
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// The server's config for `dir` with what Settings says, as the guide's
/// configs in docs/inkling2-mini/ write it, every path whole.
fn config(settings: &Settings, dir: &Path) -> Value {
    let engine = engine_in(dir).unwrap_or_else(|| dir.join("build/maya-ik2"));
    let weights = path_str(&dir.join(WEIGHTS));
    let ctx = context(settings);
    let found = install(&path_str(dir));
    // On a smaller card the drafter slows Maya down (the guide's 8 GB config has none):
    // checking two tokens at once runs about twice the experts on the processor.
    let drafter = settings.maya_drafter && found.drafter && full_card(&settings.maya_vram);
    let vision = settings.maya_vision && found.vision;
    let mut args = vec!["--model".to_string(), weights.clone(), "--max-context".into(), ctx.to_string()];
    let mut env = serde_json::Map::new();
    let mut set = |k: &str, v: &str| {
        env.insert(k.to_string(), json!(v));
    };
    if full_card(&settings.maya_vram) {
        // ik2-mini.json / ik2-mini-long.json: every expert in the card's memory.
        set("IK2_KV", "fp8");
    } else {
        // ik2-mini-8gb.json: the experts in the computer's memory, a cache of them on the card.
        args.extend(["--chunk", "512", "--cache-gb", cache_gb(&settings.maya_vram), "--threads", "8"].map(String::from));
        for (k, v) in [
            ("IK2_CPU", "1"),
            ("IK2_UP_MS", "5"),
            ("IK2_CPU_Q8", "1"),
            ("IK2_LAZY_CPU", "1"),
            ("IK2_LAZY_MAX", "2"),
            ("IK2_LAZY_PER", "1"),
            ("IK2_DENSE", "q8"),
            ("IK2_ROOM_MIB", "256"),
        ] {
            set(k, v);
        }
        // A longer context on a smaller card: its memory in FP8, as the full card's,
        // leaves the experts' cache the room it would take (64K: 657 experts, not 410).
        if ctx > SMALL_DEFAULT {
            set("IK2_KV", "fp8");
        }
    }
    for (k, v) in [("IK2_GATE_TILE", "64"), ("IK2_GATE_BF16", "1"), ("IK2_Q8_UNROLL", "1"), ("IK2_BATCH_PREFILL", "1")] {
        set(k, v);
    }
    if drafter {
        args.extend(["--draft".to_string(), path_str(&dir.join(DRAFTER))]);
        set("IK2_DRAFT_CTX", &ctx.min(DRAFT_CTX).to_string());
    }
    let mut cfg = json!({
        "exe": path_str(&engine),
        "args": args,
        "env": env,
        "cwd": path_str(dir),
        "tokenizer": path_str(&dir.join(TOKENIZER)),
        "model_name": MODEL,
        // The engine's own lines (its errors, what it did with the card's memory) go
        // to this file, the server's too: without it the server drops them.
        "log": path_str(&engine_log_path()),
    });
    if vision {
        // The encoder on the processor, as the guide's default config has it: it takes nothing from the card.
        cfg["vision"] = json!({
            "exe": path_str(&vision_in(dir).unwrap_or_default()),
            "mmproj": path_str(&dir.join(MMPROJ)),
            "model": weights,
            "gpu": false,
            "resident": true,
        });
    }
    cfg
}

fn config_text(settings: &Settings) -> String {
    serde_json::to_string_pretty(&config(settings, Path::new(settings.maya_dir.trim()))).unwrap_or_default()
}

/// Lumo's own folder for Maya: its config and its log.
fn data_dir() -> PathBuf {
    crate::settings::local_dir().join("maya")
}

pub fn log_path() -> PathBuf {
    data_dir().join("server.log")
}

/// The engine's log (the config's "log"): started anew with each server.
fn engine_log_path() -> PathBuf {
    data_dir().join("engine.log")
}

// ── Its state ─────────────────────────────────────────────────────────────────

fn owned<R>(f: impl FnOnce(&mut Option<Owned>) -> R) -> R {
    f(&mut OWNED.lock().unwrap_or_else(|e| e.into_inner()))
}

/// Whether the server Lumo started has ended by itself (closed, crashed); it is forgotten then.
fn owned_ended() -> bool {
    owned(|o| {
        let ended = o.as_mut().is_some_and(|own| !matches!(own.child.try_wait(), Ok(None)));
        if ended {
            *o = None;
        }
        ended
    })
}

fn emit(app: &AppHandle, status: Status) {
    let _ = app.emit(EVENT, status);
}

fn status_of(state: &'static str, owned: bool, seconds: u64) -> Status {
    Status { installed: true, state, owned, seconds, outdated: false }
}

/// Whether a server answers with the model loaded: Maya opens its port once
/// the engine is up, and says its context then.
async fn answers() -> bool {
    let base = base();
    let Ok(client) = net::client(&base, Duration::from_secs(2)) else { return false };
    let Ok(reply) = client.get(net::join(&base, "v1/models")).send().await else { return false };
    // A key the user gave their own Maya: it answers, so it is on.
    if reply.status() == reqwest::StatusCode::UNAUTHORIZED {
        return true;
    }
    let Ok(body) = reply.json::<Value>().await else { return false };
    body["data"].as_array().into_iter().flatten().any(|m| m["context_length"].as_u64().unwrap_or(1) > 0)
}

/// Maya as it is now, for Settings.
pub async fn status(settings: &Settings) -> Status {
    let installed = install(&settings.maya_dir).ready;
    owned_ended();
    let (mine, ready, seconds, config) = owned(|o| match o {
        Some(own) => (true, own.ready, own.started.elapsed().as_secs(), own.config.clone()),
        None => (false, false, 0, String::new()),
    });
    if mine && !ready {
        return Status { installed, state: "starting", owned: true, seconds, outdated: false };
    }
    let on = !settings.maya_url.trim().is_empty() && answers().await;
    let outdated = on && mine && config != config_text(settings);
    Status { installed, state: if on { "on" } else { "off" }, owned: on && mine, seconds: 0, outdated }
}

fn touch() {
    owned(|o| {
        if let Some(own) = o {
            own.last_used = Instant::now();
        }
    });
}

/// Held while an answer is written with Maya: Lumo doesn't stop it under one.
pub struct Busy(bool);

pub fn busy() -> Busy {
    let held = owned(|o| match o {
        Some(own) => {
            own.busy += 1;
            own.last_used = Instant::now();
            true
        }
        None => false,
    });
    Busy(held)
}

impl Drop for Busy {
    fn drop(&mut self) {
        if !self.0 {
            return;
        }
        owned(|o| {
            if let Some(own) = o {
                own.busy = own.busy.saturating_sub(1);
                own.last_used = Instant::now();
            }
        });
    }
}

// ── Starting it ───────────────────────────────────────────────────────────────

/// Before the chat talks to Maya: started when "Start and stop it by itself"
/// is on and it doesn't answer, and started again when Settings changed since
/// (not under an answer). `tick` hears each second of a start.
pub async fn ensure(app: &AppHandle, settings: &Settings, tick: impl FnMut(u64)) -> Result<(), String> {
    if !settings.maya_auto_start || settings.maya_url.trim().is_empty() {
        return Ok(());
    }
    touch();
    start(app, settings, false, tick).await
}

/// Settings → "Start now", or "Restart" with the settings of now.
pub async fn start_now(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    if settings.maya_url.trim().is_empty() {
        return Err(t("Connect Maya in Settings → Local models first."));
    }
    start(app, settings, true, |_| {}).await
}

/// Lumo's server was started and doesn't answer yet.
fn starting_now() -> bool {
    owned(|o| o.as_ref().is_some_and(|own| !own.ready))
}

/// Lumo's server runs with another config than `wanted`, and writes no answer now.
fn idle_and_outdated(wanted: &str) -> bool {
    owned(|o| o.as_ref().is_some_and(|own| own.ready && own.busy == 0 && own.config != wanted))
}

async fn start(app: &AppHandle, settings: &Settings, asked: bool, mut tick: impl FnMut(u64)) -> Result<(), String> {
    let wanted = config_text(settings);
    if idle_and_outdated(&wanted) {
        crate::log::line("[maya] the settings changed: starting it again");
        stop_owned(app).await;
    }
    if !starting_now() && answers().await {
        return Ok(());
    }
    let _one = if let Ok(one) = STARTING.try_lock() {
        one
    } else {
        let began = owned(|o| o.as_ref().map(|own| own.started)).unwrap_or_else(Instant::now);
        waiting(STARTING.lock(), began, &mut tick).await
    };
    if answers().await {
        return Ok(());
    }
    owned_ended();
    let dir = PathBuf::from(settings.maya_dir.trim());
    let found = install(&settings.maya_dir);
    if !found.ready {
        // Not ready, and not asked from Settings: the chat says what it always says of a server that doesn't answer.
        return if asked { Err(found.missing) } else { Ok(()) };
    }
    if owned(|o| o.is_none()) {
        let child = spawn(&dir, &wanted).map_err(|e| {
            crate::log::line(format!("[maya] start: {e}"));
            tf("Lumo couldn't start Maya: {error}", &[("error", &e.to_string())])
        })?;
        crate::log::line(format!("[maya] started on port {PORT} (pid {})", child.id()));
        owned(|o| *o = Some(Owned { child, started: Instant::now(), ready: false, last_used: Instant::now(), busy: 0, config: wanted }));
    }
    let began = owned(|o| o.as_ref().map(|own| own.started)).unwrap_or_else(Instant::now);
    let mut said = began.elapsed().as_secs();
    tick(said);
    emit(app, status_of("starting", true, said));
    loop {
        let up = ticking(
            async move {
                tokio::time::sleep(START_POLL).await;
                answers().await
            },
            began,
            &mut said,
            |seconds| {
                tick(seconds);
                emit(app, status_of("starting", true, seconds));
            },
        )
        .await;
        if !up && owned_ended() {
            crate::log::line("[maya] ended while starting");
            emit(app, status_of("off", false, 0));
            return Err(ended_why());
        }
        if up {
            owned(|o| {
                if let Some(own) = o {
                    own.ready = true;
                    own.last_used = Instant::now();
                }
            });
            crate::log::line(format!("[maya] answering after {} s", began.elapsed().as_secs()));
            // Started without a console, Maya's processes are background work to
            // Windows, throttled onto the slow cores: full speed for all of them
            // (the engine and the image encoder are up by now).
            if let Some(pid) = owned(|o| o.as_ref().map(|own| own.child.id())) {
                let n = crate::platform::full_speed_tree(pid);
                crate::log::line(format!("[maya] {n} processes at full speed"));
            }
            emit(app, status_of("on", true, 0));
            watch_idle(app.clone());
            return Ok(());
        }
        if began.elapsed() > START_LIMIT {
            crate::log::line("[maya] gave up starting");
            stop_owned(app).await;
            return Err(tf("Maya didn't start within 10 minutes. Its log says why: {path}", &[("path", &path_str(&log_path()))]));
        }
    }
}

/// Why the server ended while starting: the last lines of its log that say something.
fn ended_why() -> String {
    let log = std::fs::read_to_string(log_path()).unwrap_or_default();
    let last = last_words(&log);
    let path = path_str(&log_path());
    if last.is_empty() {
        tf("Maya stopped while starting. Its log is in {path}", &[("path", &path)])
    } else {
        tf("Maya stopped while starting: {why}. The whole log is in {path}", &[("why", &last), ("path", &path)])
    }
}

/// The last line of a log that says something, as an error, short.
fn last_words(log: &str) -> String {
    let line = log
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("Traceback") && !l.starts_with("File \"") && !l.starts_with("^"))
        .unwrap_or_default();
    let line = line.trim_end_matches('.');
    if line.chars().count() > 240 {
        format!("{}…", line.chars().take(240).collect::<String>())
    } else {
        line.to_string()
    }
}

/// `serve/server.py` with Lumo's config, on this computer only, with no window.
fn spawn(dir: &Path, config: &str) -> std::io::Result<Child> {
    let python = python_in(dir).ok_or_else(|| std::io::Error::other(t("Python isn't found: neither the folder's .venv nor a Python on PATH.")))?;
    std::fs::create_dir_all(data_dir())?;
    let config_path = data_dir().join("lumo-ik2.json");
    std::fs::write(&config_path, config)?;
    let log = std::fs::File::create(log_path())?;
    // (the server appends to it: emptied here, it holds this run only)
    std::fs::File::create(engine_log_path())?;
    let mut cmd = Command::new(python);
    cmd.args(["-X", "utf8"])
        .arg(dir.join(SERVER))
        .args(["--engine", "maya", "--config"])
        .arg(&config_path)
        .args(["--host", "127.0.0.1", "--port", &PORT.to_string(), "--fit-max-tokens"])
        .current_dir(dir)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUNBUFFERED", "1")
        // A key in the user's environment would lock Lumo out of its own
        // server (`--api-key` defaults to it): Lumo's Maya, on this computer
        // only, takes none.
        .env_remove("MAYA_API_KEY")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    platform::no_console(&mut cmd);
    let child = cmd.spawn()?;
    // Ends with Lumo even when Lumo itself doesn't get to stop it: no server
    // left holding the card's memory that no Lumo knows.
    if !platform::end_with_lumo(&child) {
        crate::log::line("[maya] not in Lumo's job: a crash of Lumo would leave it running");
    }
    Ok(child)
}

// ── Stopping it ───────────────────────────────────────────────────────────────

fn idle_limit(stop_after: &str) -> Option<Duration> {
    stop_after.parse::<u64>().ok().filter(|m| *m > 0).map(|m| Duration::from_secs(m * 60))
}

/// While Lumo's Maya runs: stopped once idle for "Stop after".
fn watch_idle(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(IDLE_POLL).await;
            if owned_ended() {
                emit(&app, status_of("off", false, 0));
                return;
            }
            let Some(limit) = idle_limit(&crate::settings::load().maya_stop_after) else {
                if owned(|o| o.is_none()) {
                    return;
                }
                continue;
            };
            let idle = owned(|o| o.as_ref().map(|own| own.busy == 0 && own.last_used.elapsed() >= limit));
            match idle {
                None => return,
                Some(true) => {
                    crate::log::line("[maya] idle: stopping");
                    stop_owned(&app).await;
                    return;
                }
                Some(false) => {}
            }
        }
    });
}

/// Stops the Maya Lumo started, with its engine. One the user opened is left alone.
pub async fn stop_owned(app: &AppHandle) -> bool {
    let Some(mut own) = owned(Option::take) else { return false };
    let _ = tauri::async_runtime::spawn_blocking(move || crate::claude_code::kill_tree(&mut own.child)).await;
    emit(app, status_of("off", false, 0));
    true
}

/// Lumo quits: its Maya goes too, unless "Stop after" is Never.
pub fn on_exit(settings: &Settings) {
    let Some(mut own) = owned(Option::take) else { return };
    if settings.maya_stop_after == "never" {
        platform::let_job_outlive_lumo();
        crate::log::line("[maya] left running (never stopped)");
        return;
    }
    crate::claude_code::kill_tree(&mut own.child);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with(vram: &str, ctx: u64, drafter: bool) -> Settings {
        Settings { maya_vram: vram.into(), maya_context: ctx, maya_drafter: drafter, ..Settings::default() }
    }

    #[test]
    fn the_context_is_the_one_picked_within_what_the_card_takes() {
        assert_eq!(context(&with("24", 0, true)), 262_144);
        assert_eq!(context(&with("24", 0, false)), 344_064);
        assert_eq!(context(&with("24", 32_768, true)), 32_768);
        assert_eq!(context(&with("24", 344_064, true)), 262_144, "the drafter takes room: 262K at most");
        assert_eq!(context(&with("8", 0, false)), 16_384);
        assert_eq!(context(&with("16", 131_072, false)), 65_536);
        assert_eq!(context(&with("12", 1, false)), 4_096);
    }

    fn fake_maya(name: &str, drafter: bool, vision: bool) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lumo-maya-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for f in [SERVER, "build/maya-ik2.exe", WEIGHTS, ".venv/Scripts/python.exe"] {
            let p = dir.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, "").unwrap();
        }
        std::fs::create_dir_all(dir.join(TOKENIZER)).unwrap();
        if drafter {
            std::fs::write(dir.join(DRAFTER), "").unwrap();
        }
        if vision {
            std::fs::create_dir_all(dir.join("build-vision/bin")).unwrap();
            std::fs::write(dir.join("build-vision/bin/maya-vision.exe"), "").unwrap();
            std::fs::write(dir.join(MMPROJ), "").unwrap();
        }
        dir
    }

    #[test]
    fn a_folder_says_what_it_lacks_first() {
        assert!(!install("").ready);
        let dir = fake_maya("lacks", false, false);
        let found = install(&path_str(&dir));
        assert!(found.ready, "{}", found.missing);
        assert!(!found.drafter && !found.vision);
        std::fs::remove_file(dir.join(WEIGHTS)).unwrap();
        let found = install(&path_str(&dir));
        assert!(!found.ready);
        assert!(found.missing.contains("Inkling-2-Mini-UD-Q4_K_XL.gguf"), "{}", found.missing);
        std::fs::remove_file(dir.join("build/maya-ik2.exe")).unwrap();
        assert!(install(&path_str(&dir)).missing.contains("engine"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_config_follows_the_card_vision_and_the_drafter() {
        let dir = fake_maya("config", true, true);
        let s = Settings { maya_dir: path_str(&dir), maya_vram: "24".into(), maya_drafter: true, maya_vision: true, ..Settings::default() };
        let cfg = config(&s, &dir);
        let args: Vec<&str> = cfg["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
        assert!(args.contains(&"--draft"));
        assert_eq!(args[args.iter().position(|a| *a == "--max-context").unwrap() + 1], "262144");
        assert_eq!(cfg["env"]["IK2_KV"], "fp8");
        assert_eq!(cfg["env"]["IK2_DRAFT_CTX"], "65536");
        assert_eq!(cfg["vision"]["gpu"], false);
        assert_eq!(cfg["model_name"], MODEL);
        // The engine's stderr kept, in Lumo's folder beside the server's log.
        assert_eq!(cfg["log"], path_str(&engine_log_path()));

        // Both off, on an 8 GB card: the guide's 8 GB config, no drafter, no encoder.
        // An 8 GB card leaves the drafter out even when it's on.
        let small_drafter = Settings { maya_vram: "8".into(), ..s.clone() };
        assert!(!config(&small_drafter, &dir)["args"].as_array().unwrap().iter().any(|a| a == "--draft"));
        let small = Settings { maya_vram: "8".into(), maya_drafter: false, maya_vision: false, ..s.clone() };
        let cfg = config(&small, &dir);
        let args: Vec<&str> = cfg["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
        assert!(!args.contains(&"--draft"));
        assert_eq!(args[args.iter().position(|a| *a == "--cache-gb").unwrap() + 1], "7");
        assert_eq!(args[args.iter().position(|a| *a == "--max-context").unwrap() + 1], "16384");
        assert_eq!(cfg["env"]["IK2_CPU"], "1");
        assert!(cfg["env"].get("IK2_KV").is_none());
        // 64K on the same card: its memory in FP8.
        let long = Settings { maya_context: 65_536, ..small.clone() };
        assert_eq!(config(&long, &dir)["env"]["IK2_KV"], "fp8");
        assert!(cfg.get("vision").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn switched_on_without_its_files_the_drafter_and_vision_stay_out() {
        let dir = fake_maya("nofiles", false, false);
        let s = Settings { maya_dir: path_str(&dir), maya_drafter: true, maya_vision: true, ..Settings::default() };
        let cfg = config(&s, &dir);
        assert!(!cfg["args"].as_array().unwrap().iter().any(|a| a == "--draft"));
        assert!(cfg.get("vision").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_log_s_last_words_are_its_error() {
        let log = "loading\nTraceback (most recent call last):\n  File \"x.py\", line 3\nRuntimeError: CUDA out of memory.\n\n";
        assert_eq!(last_words(log), "RuntimeError: CUDA out of memory");
        assert_eq!(last_words(""), "");
    }
}
