// Unsloth Studio started by Lumo when the chat needs it, and stopped again
// once it has been idle (Settings → Chat → Local models → "Start and stop it
// by itself").
//
// Unsloth Studio's own installer puts a Python of its own in
// %USERPROFILE%\.unsloth\studio\unsloth_studio, and its desktop app starts the
// server through that interpreter rather than the unsigned unsloth.exe, which
// Windows Application Control may deny. Lumo does the same:
// `python.exe -X utf8 -c <its CLI's entry> studio -H 127.0.0.1 -p <port> --silent`,
// with no console window. Its web page stays served, so the user can still
// open it in a browser while it runs.
//
// Lumo only ever stops a server it started itself: one the user opened stays
// as it is. The one it started is in Lumo's job (platform::end_with_lumo), so
// it ends with Lumo even after a crash, unless "Stop after" is Never. Nothing runs while Unsloth Studio isn't wanted: no watcher until
// Lumo has started it, and the watcher ends with it.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::Url;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::i18n::{t, tf};
use crate::settings::Settings;
use crate::{net, platform};

/// The island and Settings follow Unsloth Studio's state through this event.
pub const EVENT: &str = "unsloth-studio";

/// The entry of Unsloth's CLI through its own interpreter, byte for byte as its
/// installer's `unsloth.cmd` and its desktop app run it.
const ENTRY: &str = "import sys, os; sys.path[:1] = [x for x in sys.path[:1] if getattr(sys.flags, 'safe_path', False) or x not in ('', os.getcwd())]; sys.argv[0] = 'unsloth'; from unsloth_cli import app; sys.exit(app())";

/// The longest a start may take: the first one after an update installs things.
const START_LIMIT: Duration = Duration::from_secs(180);
/// How often a start looks whether the server answers yet.
const START_POLL: Duration = Duration::from_millis(500);
/// How often the idle watcher looks, while Lumo's Unsloth Studio runs.
const IDLE_POLL: Duration = Duration::from_secs(30);

/// The server Lumo started.
struct Owned {
    child: Child,
    port: u16,
    /// When it was started, for the seconds a start has taken.
    started: Instant,
    /// It answered: the start is over.
    ready: bool,
    /// The last time the chat needed it.
    last_used: Instant,
    /// Answers being written with it now: never stopped under one.
    busy: usize,
}

static OWNED: Mutex<Option<Owned>> = Mutex::new(None);
/// One start at a time: a second caller waits for the first one's server.
static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// What Settings and the chat's picker show.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Unsloth Studio's own Python was found on this computer.
    pub installed: bool,
    /// "off", "starting" or "on".
    pub state: &'static str,
    /// Lumo started it, so Lumo stops it.
    pub owned: bool,
    /// How long the start has taken so far.
    pub seconds: u64,
}

// ── Where it is ───────────────────────────────────────────────────────────────

/// Unsloth Studio's folder, as its CLI finds it: UNSLOTH_STUDIO_HOME (or
/// STUDIO_HOME), else UNSLOTH_HOME\studio once an install is there, else
/// %USERPROFILE%\.unsloth\studio.
fn studio_home() -> PathBuf {
    for var in ["UNSLOTH_STUDIO_HOME", "STUDIO_HOME"] {
        if let Some(dir) = std::env::var_os(var).filter(|v| !v.is_empty()) {
            return PathBuf::from(dir);
        }
    }
    let legacy = platform::home_dir().join(".unsloth").join("studio");
    if let Some(master) = std::env::var_os("UNSLOTH_HOME").filter(|v| !v.is_empty()) {
        let candidate = PathBuf::from(master).join("studio");
        if python_in(&candidate).is_some() || python_in(&legacy).is_none() {
            return candidate;
        }
    }
    legacy
}

/// The interpreter of the install at `home`: its venv, or the one older installs had.
fn python_in(home: &std::path::Path) -> Option<PathBuf> {
    ["unsloth_studio", ".venv"]
        .into_iter()
        .map(|venv| home.join(venv).join("Scripts").join("python.exe"))
        .find(|p| p.is_file())
}

/// Unsloth Studio's Python, if it is installed.
fn python() -> Option<PathBuf> {
    python_in(&studio_home())
}

/// The port of `url` when it is this computer over http, the only server Lumo starts.
fn local_port(url: &str) -> Option<u16> {
    let url = net::normalise_server_url(url).ok()?;
    (url.scheme() == "http" && net::is_loopback_url(&url)).then(|| url.port_or_known_default()).flatten()
}

fn base(port: u16) -> Url {
    Url::parse(&format!("http://127.0.0.1:{port}")).expect("a loopback address")
}

/// Whether a server answers on `port`, whatever it says (the key is not needed to know).
async fn answers(port: u16) -> bool {
    let base = base(port);
    let Ok(client) = net::client(&base, Duration::from_secs(2)) else { return false };
    client.get(net::join(&base, "v1/models")).send().await.is_ok()
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

/// Unsloth Studio as it is now, for Settings.
pub async fn status(settings: &Settings) -> Status {
    let installed = python().is_some();
    owned_ended();
    let (owned_port, ready, seconds) = owned(|o| match o {
        Some(own) => (Some(own.port), own.ready, own.started.elapsed().as_secs()),
        None => (None, false, 0),
    });
    if owned_port.is_some() && !ready {
        return Status { installed, state: "starting", owned: true, seconds };
    }
    let port = owned_port.or_else(|| local_port(&settings.unsloth_url));
    let on = match port {
        Some(port) => answers(port).await,
        None => false,
    };
    Status { installed, state: if on { "on" } else { "off" }, owned: on && owned_port.is_some(), seconds: 0 }
}

/// The chat used Unsloth Studio: its idle time starts again.
fn touch() {
    owned(|o| {
        if let Some(own) = o {
            own.last_used = Instant::now();
        }
    });
}

/// Held while an answer is written with Unsloth Studio: Lumo doesn't stop it under one.
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

/// Before the chat talks to Unsloth Studio: started when "Start and stop it
/// by itself" is on and it doesn't answer. `tick` hears each second of a start.
/// Not installed, or at an address on another computer: nothing is done, and
/// the chat says what it always said.
pub async fn ensure(app: &AppHandle, settings: &Settings, tick: impl FnMut(u64)) -> Result<(), String> {
    if !settings.unsloth_auto_start || settings.unsloth_url.trim().is_empty() {
        return Ok(());
    }
    let Some(port) = local_port(&settings.unsloth_url) else { return Ok(()) };
    touch();
    if python().is_none() {
        return Ok(());
    }
    start(app, port, tick).await
}

/// Settings → "Start now": Unsloth Studio at the address it is connected at.
pub async fn start_now(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let port = local_port(&settings.unsloth_url)
        .ok_or_else(|| t("Lumo only starts Unsloth Studio on this computer."))?;
    start(app, port, |_| {}).await
}

async fn start(app: &AppHandle, port: u16, mut tick: impl FnMut(u64)) -> Result<(), String> {
    if answers(port).await {
        return Ok(());
    }
    let _one = STARTING.lock().await;
    // Another caller's start may have finished meanwhile.
    if answers(port).await {
        return Ok(());
    }
    owned_ended();
    let python = python().ok_or_else(|| t("Unsloth Studio isn't installed on this computer."))?;
    if owned(|o| o.is_none()) {
        let child = spawn(&python, port).map_err(|e| {
            crate::log::line(format!("[unsloth] start: {e}"));
            tf("Lumo couldn't start Unsloth Studio: {error}", &[("error", &e.to_string())])
        })?;
        crate::log::line(format!("[unsloth] started on port {port} (pid {})", child.id()));
        owned(|o| *o = Some(Owned { child, port, started: Instant::now(), ready: false, last_used: Instant::now(), busy: 0 }));
    }
    let began = Instant::now();
    let mut said = 0;
    tick(0);
    emit(app, Status { installed: true, state: "starting", owned: true, seconds: 0 });
    loop {
        tokio::time::sleep(START_POLL).await;
        if owned_ended() {
            crate::log::line("[unsloth] ended while starting");
            emit(app, Status { installed: true, state: "off", owned: false, seconds: 0 });
            return Err(t("Unsloth Studio stopped while starting. Open it once from its own shortcut to see why."));
        }
        if answers(port).await {
            owned(|o| {
                if let Some(own) = o {
                    own.ready = true;
                    own.last_used = Instant::now();
                }
            });
            crate::log::line(format!("[unsloth] answering after {} s", began.elapsed().as_secs()));
            emit(app, Status { installed: true, state: "on", owned: true, seconds: 0 });
            watch_idle(app.clone());
            return Ok(());
        }
        let seconds = began.elapsed().as_secs();
        if seconds != said {
            said = seconds;
            tick(seconds);
            emit(app, Status { installed: true, state: "starting", owned: true, seconds });
        }
        if began.elapsed() > START_LIMIT {
            crate::log::line("[unsloth] gave up starting");
            stop_owned(app).await;
            return Err(t("Unsloth Studio didn't start within 3 minutes. Open it once from its own shortcut to see why."));
        }
    }
}

/// `unsloth studio` on `port`, on this computer only, with no window.
fn spawn(python: &std::path::Path, port: u16) -> std::io::Result<Child> {
    let mut cmd = Command::new(python);
    cmd.args(["-X", "utf8", "-c", ENTRY, "studio", "-H", "127.0.0.1", "-p", &port.to_string(), "--silent"])
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Its folder, not Lumo's: what it writes beside itself stays there.
    if let Some(home) = python.ancestors().nth(3).filter(|d| d.is_dir()) {
        cmd.current_dir(home);
    }
    platform::no_console(&mut cmd);
    let child = cmd.spawn()?;
    // Ends with Lumo even when Lumo itself doesn't get to stop it (a crash, the
    // Task Manager): no server left holding the GPU's memory that no Lumo knows.
    if !platform::end_with_lumo(&child) {
        crate::log::line("[unsloth] not in Lumo's job: a crash of Lumo would leave it running");
    }
    Ok(child)
}

// ── Stopping it ───────────────────────────────────────────────────────────────

/// The minutes of "Stop after", or None when only Lumo's exit (or nothing) stops it.
fn idle_limit(stop_after: &str) -> Option<Duration> {
    stop_after.parse::<u64>().ok().filter(|m| *m > 0).map(|m| Duration::from_secs(m * 60))
}

/// While Lumo's Unsloth Studio runs: stopped once idle for "Stop after".
fn watch_idle(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(IDLE_POLL).await;
            if owned_ended() {
                emit(&app, Status { installed: true, state: "off", owned: false, seconds: 0 });
                return;
            }
            let Some(limit) = idle_limit(&crate::settings::load().unsloth_stop_after) else {
                // Stopped by Lumo's exit, or never: nothing to watch until then.
                if owned(|o| o.is_none()) {
                    return;
                }
                continue;
            };
            let idle = owned(|o| match o {
                Some(own) => Some(own.busy == 0 && own.last_used.elapsed() >= limit),
                None => None,
            });
            match idle {
                None => return,
                Some(true) => {
                    crate::log::line("[unsloth] idle: stopping");
                    stop_owned(&app).await;
                    return;
                }
                Some(false) => {}
            }
        }
    });
}

/// Stops the Unsloth Studio Lumo started, with what it runs (its llama-server).
/// One the user opened is left alone. Whether there was one to stop.
pub async fn stop_owned(app: &AppHandle) -> bool {
    let Some(mut own) = owned(Option::take) else { return false };
    let _ = tauri::async_runtime::spawn_blocking(move || crate::claude_code::kill_tree(&mut own.child)).await;
    emit(app, Status { installed: true, state: "off", owned: false, seconds: 0 });
    true
}

/// Lumo quits: its Unsloth Studio goes too, unless "Stop after" is Never.
pub fn on_exit(settings: &Settings) {
    let Some(mut own) = owned(Option::take) else { return };
    if settings.unsloth_stop_after == "never" {
        // Out of the job's reach too, or it would end with Lumo after all.
        platform::let_job_outlive_lumo();
        crate::log::line("[unsloth] left running (never stopped)");
        return;
    }
    crate::claude_code::kill_tree(&mut own.child);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_server_on_this_computer_over_http_is_started() {
        assert_eq!(local_port("http://127.0.0.1:8888"), Some(8888));
        assert_eq!(local_port("localhost:8000"), Some(8000));
        assert_eq!(local_port("http://127.0.0.1"), Some(80));
        assert_eq!(local_port("https://127.0.0.1:8888"), None);
        assert_eq!(local_port("http://192.168.1.20:8888"), None);
        assert_eq!(local_port("https://llm.example.com"), None);
        assert_eq!(local_port(""), None);
    }

    #[test]
    fn stop_after_reads_minutes_and_nothing_else() {
        assert_eq!(idle_limit("15"), Some(Duration::from_secs(900)));
        assert_eq!(idle_limit("5"), Some(Duration::from_secs(300)));
        assert_eq!(idle_limit("exit"), None);
        assert_eq!(idle_limit("never"), None);
        assert_eq!(idle_limit("0"), None);
        assert_eq!(idle_limit(""), None);
    }

    #[test]
    fn the_install_is_found_in_its_venv_or_the_older_one() {
        let dir = std::env::temp_dir().join(format!("lumo-unsloth-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(python_in(&dir), None);
        let old = dir.join(".venv").join("Scripts");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("python.exe"), "").unwrap();
        assert_eq!(python_in(&dir), Some(old.join("python.exe")));
        let new = dir.join("unsloth_studio").join("Scripts");
        std::fs::create_dir_all(&new).unwrap();
        std::fs::write(new.join("python.exe"), "").unwrap();
        assert_eq!(python_in(&dir), Some(new.join("python.exe")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
