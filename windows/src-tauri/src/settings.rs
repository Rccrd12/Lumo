// Preferences, stored as plain JSON in settings.json under platform::config_dir().
// No secret ever lands here — API keys live in the OS keychain (see secrets.rs).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

/// A field the file lacks takes its value from `Default`, so a settings.json
/// written by an older build still loads, whatever has been added since.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub sound_enabled: bool,
    pub sound_volume: f64,
    pub auto_close_interval: f64,
    pub absence_interval: f64,
    pub active_integrations: Vec<String>,
    /// The always-on workspace pill (src/core/pills.ts checks it is one).
    pub main_pill: String,
    /// "primary" = the main display, "cursor" = whichever display the mouse is on.
    pub screen: String,
    /// How big the island is drawn: 1 is the Mac's size, up to 1.6.
    pub island_zoom: f64,
    /// The display edge the island hangs from ("top", "bottom", "left",
    /// "right") and how far from its middle, in logical pixels. Owned by the
    /// Rust side (island.rs) — what a webview sends back is ignored.
    pub island_dock: String,
    pub island_offset: f64,
    /// Let go away from every edge, the island floats: how far its window is
    /// from the top or bottom edge it grows from, in logical pixels (0 = against it).
    pub island_float: f64,
    /// How wide the open island is, and how tall (0 = each view's own), in
    /// page pixels. Dragged from the island's grips, so owned by Rust too.
    pub island_width: f64,
    pub island_height: f64,
    /// How big the icons are drawn, against the Mac's size.
    pub icon_scale: f64,
    /// When the open island closes on its own: "timer" (`auto_close_interval`
    /// seconds after the mouse leaves), "leave" (as soon as it leaves),
    /// "click" (a click outside it) or "never" (only Esc or a shortcut).
    pub island_close: String,
    /// The closed island opens as soon as the mouse rests on it.
    pub island_hover_open: bool,
    /// The closed island goes away a minute after the mouse left it.
    pub island_auto_hide: bool,
    /// The closed island says what the AI is doing and what just happened.
    pub compact_activity: bool,
    /// The closed island shows the music playing, with its buttons (media.rs).
    pub compact_media: bool,
    /// The live activities (src/island/activities.ts): on or off.
    pub activities_panel: bool,
    /// Folded into their icon in the open island's top bar.
    pub activities_folded: bool,
    /// Beside the island: "left" or "right".
    pub activities_side: String,
    /// Their size in page pixels; a height of 0 follows the island.
    pub activities_width: f64,
    pub activities_height: f64,
    /// Moved off the island into a window of their own (activities.rs), at
    /// this physical desktop position. Windows only.
    pub activities_detached: bool,
    pub activities_x: f64,
    pub activities_y: f64,
    pub autostart: bool,
    pub hooks_installed: bool,
    /// Claude model used by the chat. Changeable in the settings window.
    pub model: String,
    /// Show the Claude plan pill (5 h and weekly limits) in the island's header.
    /// Off until the user turns it on, so the header stays as it shipped.
    pub show_plan_in_notch: bool,
    /// Lumo's status line relay is the one in Claude Code's settings.json.
    /// Like `hooks_installed`, the real state wins at launch over what was stored.
    pub plan_relay_installed: bool,
    /// Show the Codex plan pill (5 h / weekly limits from `codex app-server`).
    /// Off by default; nothing is installed for it.
    pub show_codex_plan_in_notch: bool,
    /// Who the chat talks to: "anthropic", a cloud provider of
    /// openai_compat.rs ("openai", "google", "openrouter"), or a model server
    /// of local_chat.rs ("ollama", "lmstudio", "custom"). Picked in the chat view.
    pub chat_provider: String,
    /// The model picked for each provider other than Anthropic (whose model is
    /// `model`), by provider id.
    pub chat_models: BTreeMap<String, String>,
    /// Claude Code's effort level for the chat ("low" … "max"); empty: Claude
    /// Code's own default. Only the Claude Code provider uses it.
    pub chat_effort: String,
    /// What the chat's CLIs (Claude Code, Antigravity CLI) may do without a
    /// card: "default" (ask for everything), "auto" (the CLI decides what is
    /// safe; "acceptEdits", from before, reads as it) or "plan" (plan only,
    /// change nothing). Picked from the chat's field; anything else reads as
    /// "default".
    pub chat_permission_mode: String,
    /// A quiet line next to the chat's model picker with what the provider has
    /// left (chat_usage.rs): the Claude plan for Claude Code, the rate limits
    /// Anthropic and OpenAI answer with, OpenRouter's key credits. Off until
    /// the user turns it on, so the chat stays as it shipped.
    pub chat_show_usage: bool,
    /// Every chat message carries the folder open in File Explorer (its path
    /// and listing, explorer.rs), as if picked from the screen button. Off
    /// until the user turns it on in Settings → Chat.
    pub chat_share_explorer: bool,
    /// Every chat message carries the open windows and the documents they
    /// show, found on disk (desk.rs). On until the user turns it off.
    pub chat_share_open: bool,
    /// Gemini Live, the voice conversation (live.rs, src/live): the model,
    /// "gemini-3.8-live" or "gemini-3.8-live-extended-thinking". Kept as it
    /// comes; src/live/protocol.ts reads anything else as "gemini-3.8-live".
    pub live_model: String,
    /// How much the Extended Thinking model reasons in the background:
    /// "low", "medium" or "high". The other model takes none.
    pub live_thinking: String,
    /// One of Gemini's prebuilt voices ("Kore", "Puck"…); empty: the model's own.
    pub live_voice: String,
    /// Who Gemini asks when it cannot do something itself: "claude-code" or
    /// "antigravity-cli". Anything else reads as "claude-code".
    pub live_helper: String,
    /// The helper's model: "default" (whatever the user set in Claude Code or
    /// agy), else an id the chat's picker offers for that helper
    /// (claude_code::MODELS, or what `agy models` lists). Checked before it
    /// reaches a command line.
    pub live_helper_model: String,
    /// Claude Code's effort for the helper ("low" … "max"); empty: its own
    /// default. Antigravity CLI has none (its models carry it in their name).
    pub live_helper_effort: String,
    /// Gemini may take a screenshot when it needs to see the screen, without
    /// asking first (the island says when it looks). On until turned off.
    pub live_screen: bool,
    /// Addresses of the model servers once connected; empty means not connected.
    pub ollama_url: String,
    pub lmstudio_url: String,
    /// Any other OpenAI-compatible server; its key, if any, is in the keychain.
    pub custom_url: String,
    /// Global shortcuts the user changed, by action id; the others keep their
    /// default (see shortcuts.rs).
    pub shortcuts: crate::shortcuts::Bindings,
    /// Mochi's outfit, picked in the wardrobe: "auto" (dresses for the
    /// season), "none" or an outfit id — the Mac's raw values. The island reads
    /// anything it doesn't know as "auto", so the value is stored as it comes.
    pub mochi_outfit: String,
    /// How much Lumo moves on his own: "still", "calm" or "lively". Kept as
    /// it comes; src/core/state.ts reads anything else as "calm".
    pub lumo_motion: String,
    /// Lumo's look, picked in the wardrobe or Settings → Island: "filo" (a
    /// ring of light), "punto", "goccia" or "lucciola" (the firefly). Kept as
    /// it comes; src/mochi/wardrobe.ts reads anything else as "filo".
    pub lumo_character: String,
    /// A colour of the user's own for a pill's Mochi, by pill ID ("#RRGGBB"),
    /// picked in Settings → Active pills. Empty means the catalog's colours.
    /// Kept as it comes, like `mochi_outfit`: src/core/pill-colors.ts reads
    /// whatever is not a colour as "no choice".
    pub pill_colors: BTreeMap<String, String>,
    /// Interface language: "" follows the system, else one of i18n::LANGUAGES
    /// ("fr", "pt-BR", "zh-Hans"…). Kept as it comes, like `mochi_outfit`: a
    /// code this build doesn't know reads as "".
    pub language: String,
    /// Mochi on the desktop: whether he lives there, and his spot. Owned by
    /// the Rust side (desktop.rs) — what a webview sends back is ignored.
    pub desktop_mochi: DesktopMochiPref,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopMochiPref {
    /// He was on the desktop when the app quit: he flies back out at launch.
    pub on_desktop: bool,
    /// Top-left corner of his window where the user last left him.
    pub spot: Option<DesktopSpot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesktopSpot {
    pub x: f64,
    pub y: f64,
    /// What x and y are measured in (`DesktopMode::space`).
    pub space: String,
}

/// A little bigger than the Mac's icons, which sit closer to the eye.
pub const DEFAULT_ICON_SCALE: f64 = 1.25;

fn default_model() -> String {
    crate::claude::DEFAULT_MODEL.to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            sound_enabled: true,
            sound_volume: 0.12,
            auto_close_interval: 15.0,
            absence_interval: 180.0,
            active_integrations: vec![
                "integration_resend".into(),
                "integration_n8n".into(),
                "integration_vercel".into(),
                "integration_github".into(),
            ],
            main_pill: "integration_claude".into(),
            screen: "primary".into(),
            island_zoom: crate::island::DEFAULT_ZOOM,
            island_dock: "top".into(),
            island_offset: 0.0,
            island_float: 0.0,
            island_width: crate::island::DEFAULT_WIDTH,
            island_height: 0.0,
            icon_scale: DEFAULT_ICON_SCALE,
            island_close: "timer".into(),
            island_hover_open: false,
            island_auto_hide: false,
            compact_activity: true,
            compact_media: true,
            activities_panel: true,
            activities_folded: false,
            activities_side: "left".into(),
            activities_width: crate::activities::DEFAULT_WIDTH,
            activities_height: 0.0,
            activities_detached: false,
            activities_x: 0.0,
            activities_y: 0.0,
            autostart: false,
            hooks_installed: false,
            model: default_model(),
            show_plan_in_notch: false,
            plan_relay_installed: false,
            show_codex_plan_in_notch: false,
            chat_provider: crate::chat::ANTHROPIC.into(),
            chat_models: BTreeMap::new(),
            chat_effort: String::new(),
            chat_permission_mode: "default".into(),
            chat_show_usage: false,
            chat_share_explorer: false,
            chat_share_open: true,
            live_model: "gemini-3.8-live".into(),
            live_thinking: "medium".into(),
            live_voice: String::new(),
            live_helper: "claude-code".into(),
            live_helper_model: "default".into(),
            live_helper_effort: String::new(),
            live_screen: true,
            ollama_url: String::new(),
            lmstudio_url: String::new(),
            custom_url: String::new(),
            shortcuts: Default::default(),
            mochi_outfit: "auto".into(),
            lumo_motion: "calm".into(),
            lumo_character: "filo".into(),
            pill_colors: BTreeMap::new(),
            language: String::new(),
            desktop_mochi: DesktopMochiPref::default(),
        }
    }
}

pub use crate::platform::{config_dir, local_dir};

pub fn hook_exe_path() -> PathBuf {
    local_dir().join("bin").join(crate::platform::HOOK_EXE)
}

fn settings_path() -> PathBuf {
    config_dir().join("settings.json")
}

pub fn load() -> Settings {
    load_from(&settings_path())
}

pub fn save(settings: &Settings) -> std::io::Result<()> {
    let dir = config_dir();
    crate::platform::ensure_private_dir(&dir)?;
    save_to(&settings_path(), settings)
}

/// How many copies `set_aside` can make within one second before it gives up.
const MAX_COPIES_PER_SECOND: u32 = 100;

/// settings.json files that are there but whose contents never made it into
/// memory: they could not be read, or could not be used and could not be copied
/// aside either. What is in memory for them is the defaults, so the next save
/// must not quietly replace them — see `keep_what_was_not_loaded`.
static NOT_LOADED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn not_loaded() -> MutexGuard<'static, Vec<PathBuf>> {
    NOT_LOADED.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One line in lumo.log. Tests must never write to the real one.
fn note(message: String) {
    #[cfg(not(test))]
    crate::log::line(message);
    #[cfg(test)]
    eprintln!("{message}");
}

/// The settings held in the bytes of a settings.json, or `None` when there is
/// nothing usable in them. Split from `load_from` so it can be tested without a
/// file.
fn parse(bytes: &[u8]) -> Option<Settings> {
    // PowerShell 5 and Notepad write a UTF-8 BOM, and serde_json refuses it.
    let text = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if text.iter().all(u8::is_ascii_whitespace) {
        return Some(Settings::default());
    }
    let Value::Object(fields) = serde_json::from_slice(text).ok()? else {
        return None;
    };
    let whole = serde_json::from_value(Value::Object(fields.clone()));
    Some(whole.unwrap_or_else(|_| salvage(fields)))
}

/// Settings from the fields of a settings.json that does not load as a whole.
/// Each field is taken on its own: one that is not the kind of value expected
/// falls back to its default instead of costing every other setting.
fn salvage(fields: Map<String, Value>) -> Settings {
    let Ok(Value::Object(mut kept)) = serde_json::to_value(Settings::default()) else {
        return Settings::default();
    };
    for (key, value) in fields {
        let mut candidate = kept.clone();
        candidate.insert(key.clone(), value);
        if serde_json::from_value::<Settings>(Value::Object(candidate.clone())).is_ok() {
            kept = candidate;
        } else {
            note(unusable_field(&key));
        }
    }
    serde_json::from_value(Value::Object(kept)).unwrap_or_default()
}

/// The log line for a field `salvage` had to drop. The name comes straight from
/// the file, so it is written escaped: a line break in it must not be able to
/// start what looks like another line of lumo.log.
fn unusable_field(key: &str) -> String {
    format!("settings.json: {key:?} is not usable — its default is used instead")
}

/// `load`, for the file at `path`: tests point it at a temporary directory.
///
/// Only a file that is not there means "start from the defaults" with nothing
/// more to do. One that cannot be read, or cannot be used, also gives the
/// defaults, but it still holds what the user had: it is kept, not written over.
fn load_from(path: &Path) -> Settings {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == ErrorKind::NotFound => return Settings::default(),
        Err(err) => {
            note(format!("can't read {}: {err} — using the defaults", path.display()));
            protect(path);
            return Settings::default();
        }
    };
    parse(&bytes).unwrap_or_else(|| {
        match set_aside(path, "corrupt", &bytes) {
            Ok(copy) => note(format!(
                "{} is not usable — kept as {}, using the defaults",
                path.display(),
                copy.display()
            )),
            Err(err) => {
                note(format!("{} is not usable and could not be copied: {err}", path.display()));
                protect(path);
            }
        }
        Settings::default()
    })
}

/// Marks `path` as holding something the next save must not write over.
fn protect(path: &Path) {
    let mut pending = not_loaded();
    if !pending.iter().any(|p| p == path) {
        pending.push(path.to_path_buf());
    }
}

/// Before the first save over a file `load_from` could not load: copies it
/// aside if it can be read by now, and refuses the save if it still cannot.
fn keep_what_was_not_loaded(path: &Path) -> std::io::Result<()> {
    let mut pending = not_loaded();
    let Some(index) = pending.iter().position(|p| p == path) else {
        return Ok(());
    };
    match std::fs::read(path) {
        Ok(bytes) => {
            let copy = set_aside(path, "unread", &bytes)?;
            note(format!("{} was never loaded — kept as {}", path.display(), copy.display()));
        }
        // Gone since: nothing is left to protect.
        Err(err) if err.kind() == ErrorKind::NotFound => {}
        Err(err) => {
            return Err(std::io::Error::new(
                err.kind(),
                format!("{} still can't be read, so it is left as it is: {err}", path.display()),
            ));
        }
    }
    pending.swap_remove(index);
    Ok(())
}

/// Keeps `bytes`, the contents of `path`, in a file beside it named after it
/// with `.<kind>-YYYYMMDD-HHMMSS` appended. Contents an earlier copy of that
/// kind already holds are not copied again: a file nobody repairs would
/// otherwise leave one more copy behind at every launch.
fn set_aside(path: &Path, kind: &str, bytes: &[u8]) -> std::io::Result<PathBuf> {
    if let Some(copy) = same_copy(path, kind, bytes) {
        return Ok(copy);
    }
    let t = crate::platform::local_time();
    let stamp = format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        t.year, t.month, t.day, t.hour, t.minute, t.second
    );
    set_aside_as(path, kind, &stamp, bytes, write_whole)
}

/// The copy of `path` of this `kind` that already holds exactly `bytes`.
fn same_copy(path: &Path, kind: &str, bytes: &[u8]) -> Option<PathBuf> {
    let prefix = format!("{}.{kind}-", path.file_name()?.to_string_lossy());
    std::fs::read_dir(path.parent()?)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .filter(|entry| entry.metadata().is_ok_and(|m| m.len() == bytes.len() as u64))
        .map(|entry| entry.path())
        .find(|copy| std::fs::read(copy).is_ok_and(|held| held == bytes))
}

/// `set_aside` for a given time stamp, writing through `write`. `-1`, `-2`… are
/// appended while the name is taken, so a copy that is already there is never
/// written over; and a copy that could not be written whole is removed, never
/// left looking like a faithful one.
fn set_aside_as(
    path: &Path,
    kind: &str,
    stamp: &str,
    bytes: &[u8],
    write: fn(&mut std::fs::File, &[u8]) -> std::io::Result<()>,
) -> std::io::Result<PathBuf> {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let base = format!("{name}.{kind}-{stamp}");
    for attempt in 0..MAX_COPIES_PER_SECOND {
        let copy = match attempt {
            0 => path.with_file_name(&base),
            n => path.with_file_name(format!("{base}-{n}")),
        };
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&copy) {
            Ok(mut file) => {
                let written = write(&mut file, bytes);
                drop(file);
                if written.is_err() {
                    let _ = std::fs::remove_file(&copy);
                }
                return written.map(|()| copy);
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
    Err(std::io::Error::new(ErrorKind::AlreadyExists, format!("too many copies named {base}")))
}

/// Writes `bytes` to `file` and waits until they are on the disk.
fn write_whole(file: &mut std::fs::File, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    file.write_all(bytes)?;
    file.sync_all()
}

/// `save`, for the file at `path`, whose directory already exists.
fn save_to(path: &Path, settings: &Settings) -> std::io::Result<()> {
    keep_what_was_not_loaded(path)?;
    let json = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(ErrorKind::InvalidData, e))?;

    // A dotfiles setup can make settings.json a symlink: write to the file it
    // points at, so the link survives the rename below.
    #[cfg(unix)]
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    #[cfg(unix)]
    let path = resolved.as_path();

    // Write beside the target and rename over it: a crash, a full disk or a
    // power cut leaves the previous settings.json intact rather than half a file.
    let temp = path.with_extension(format!("json.lumo-{}", std::process::id()));
    let written = std::fs::File::create(&temp)
        .and_then(|mut file| write_whole(&mut file, &json))
        .and_then(|()| std::fs::rename(&temp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    /// A settings.json in which no value is the default one.
    // Two #: the colours in it are written "#RRGGBB".
    const CUSTOM: &str = r##"{
  "soundEnabled": false,
  "soundVolume": 0.5,
  "autoCloseInterval": 30.0,
  "absenceInterval": 60.0,
  "activeIntegrations": ["integration_notion"],
  "mainPill": "agent_cursor",
  "screen": "cursor",
  "islandZoom": 1.3,
  "islandDock": "left",
  "islandOffset": -200.5,
  "islandFloat": 240.0,
  "islandWidth": 900.0,
  "islandHeight": 420.0,
  "iconScale": 1.5,
  "islandClose": "click",
  "islandHoverOpen": true,
  "islandAutoHide": true,
  "compactActivity": false,
  "compactMedia": false,
  "activitiesPanel": false,
  "activitiesFolded": true,
  "activitiesSide": "right",
  "activitiesWidth": 300.0,
  "activitiesHeight": 360.0,
  "activitiesDetached": true,
  "activitiesX": 120.0,
  "activitiesY": 80.0,
  "autostart": true,
  "hooksInstalled": true,
  "model": "some-model",
  "showPlanInNotch": true,
  "planRelayInstalled": true,
  "showCodexPlanInNotch": true,
  "chatProvider": "ollama",
  "chatModels": { "ollama": "llama3.2", "openai": "gpt-x" },
  "chatEffort": "high",
  "chatPermissionMode": "plan",
  "chatShowUsage": true,
  "chatShareExplorer": true,
  "chatShareOpen": false,
  "liveModel": "gemini-3.8-live-extended-thinking",
  "liveThinking": "high",
  "liveVoice": "Kore",
  "liveHelper": "antigravity-cli",
  "liveHelperModel": "gemini-3.8-flash-high",
  "liveHelperEffort": "max",
  "liveScreen": false,
  "ollamaUrl": "http://127.0.0.1:11434",
  "lmstudioUrl": "http://127.0.0.1:1234",
  "customUrl": "https://llm.example.com",
  "shortcuts": { "openChat": { "keys": "Ctrl+Shift+K", "enabled": false } },
  "mochiOutfit": "witchHat",
  "lumoMotion": "lively",
  "lumoCharacter": "goccia",
  "pillColors": { "integration_claude": "#2DD4BF" },
  "language": "pt-BR",
  "desktopMochi": { "onDesktop": true, "spot": { "x": 1500.5, "y": -300.0, "space": "screen" } }
}"##;

    fn custom() -> Value {
        serde_json::from_str(CUSTOM).unwrap()
    }

    /// `CUSTOM` with one key replaced, or removed when `value` is `None`.
    fn custom_with(key: &str, value: Option<Value>) -> Vec<u8> {
        let mut object = custom().as_object().unwrap().clone();
        match value {
            Some(value) => object.insert(key.to_string(), value),
            None => object.remove(key),
        };
        serde_json::to_vec(&object).unwrap()
    }

    /// Settings compare through their JSON: the struct has no `PartialEq`.
    fn shown(settings: &Settings) -> Value {
        serde_json::to_value(settings).unwrap()
    }

    fn defaults() -> Value {
        shown(&Settings::default())
    }

    /// A fresh directory of our own, and the settings.json it will hold.
    fn scratch(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir()
            .join(format!("lumo-settings-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("settings.json");
        (dir, file)
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    /// What was set aside under `settings.json.<kind>-…`.
    fn kept(dir: &Path, kind: &str) -> Vec<Vec<u8>> {
        let prefix = format!("settings.json.{kind}-");
        names(dir)
            .iter()
            .filter(|name| name.starts_with(&prefix))
            .map(|name| std::fs::read(dir.join(name)).unwrap())
            .collect()
    }

    // ── Reading ───────────────────────────────────────────────────────────────

    #[test]
    fn a_missing_file_is_the_defaults_and_is_not_created() {
        let (dir, file) = scratch("missing");
        assert_eq!(shown(&load_from(&file)), defaults());
        assert!(names(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_file_is_the_defaults_and_nothing_is_set_aside() {
        let (dir, file) = scratch("empty");
        for nothing in [&b""[..], &b" \r\n\t "[..]] {
            std::fs::write(&file, nothing).unwrap();
            assert_eq!(shown(&load_from(&file)), defaults());
        }
        assert_eq!(names(&dir), ["settings.json"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unknown_fields_are_ignored_and_the_known_ones_kept() {
        let bytes = custom_with("somethingFromALaterVersion", Some(json!({ "a": [1, 2] })));
        assert_eq!(shown(&parse(&bytes).unwrap()), custom());
    }

    #[test]
    fn a_file_from_before_the_model_setting_keeps_everything_else() {
        let loaded = shown(&parse(&custom_with("model", None)).unwrap());
        let mut expected = custom();
        expected["model"] = json!(crate::claude::DEFAULT_MODEL);
        assert_eq!(loaded, expected);
    }

    #[test]
    fn a_file_from_before_the_wardrobe_dresses_mochi_for_the_seasons() {
        let loaded = parse(&custom_with("mochiOutfit", None)).unwrap();
        assert_eq!(loaded.mochi_outfit, "auto");
        assert_eq!(loaded.model, "some-model");
        assert!(!loaded.sound_enabled);
    }

    #[test]
    fn a_file_from_before_the_explorer_setting_shares_nothing_by_itself() {
        let loaded = parse(&custom_with("chatShareExplorer", None)).unwrap();
        assert!(!loaded.chat_share_explorer);
        assert_eq!(loaded.chat_effort, "high");
        assert!(parse(CUSTOM.as_bytes()).unwrap().chat_share_explorer);
    }

    #[test]
    fn a_file_from_before_the_desktop_mochi_keeps_him_in_the_island() {
        let loaded = parse(&custom_with("desktopMochi", None)).unwrap();
        assert_eq!(loaded.desktop_mochi, DesktopMochiPref::default());
        assert!(!loaded.desktop_mochi.on_desktop);
        assert_eq!(loaded.mochi_outfit, "witchHat");
    }

    #[test]
    fn a_half_written_desktop_spot_costs_only_the_spot() {
        let loaded = parse(&custom_with(
            "desktopMochi",
            Some(json!({ "onDesktop": true, "spot": { "x": "left" } })),
        ))
        .unwrap();
        // The whole field falls back, and nothing else does.
        assert_eq!(loaded.desktop_mochi, DesktopMochiPref::default());
        assert_eq!(loaded.model, "some-model");

        let loaded = parse(&custom_with("desktopMochi", Some(json!({ "onDesktop": true })))).unwrap();
        assert!(loaded.desktop_mochi.on_desktop);
        assert_eq!(loaded.desktop_mochi.spot, None);
    }

    #[test]
    fn a_file_from_before_the_colours_paints_every_pill_as_the_catalog_says() {
        let loaded = parse(&custom_with("pillColors", None)).unwrap();
        assert!(loaded.pill_colors.is_empty());
        assert_eq!(loaded.mochi_outfit, "witchHat");
    }

    #[test]
    fn pill_colours_are_kept_as_written_and_cost_nothing_else_when_unusable() {
        // A pill a newer build added keeps its colour through a save by this one.
        let loaded = parse(&custom_with("pillColors", Some(json!({ "agent_new": "#abcdef" })))).unwrap();
        assert_eq!(loaded.pill_colors.get("agent_new").map(String::as_str), Some("#abcdef"));
        // Not a map of strings: the colours fall back, and nothing else does.
        let loaded = parse(&custom_with("pillColors", Some(json!(["#2DD4BF"])))).unwrap();
        assert!(loaded.pill_colors.is_empty());
        assert_eq!(loaded.model, "some-model");
    }

    #[test]
    fn a_file_from_before_the_looks_shows_lumo_as_filo() {
        let loaded = parse(&custom_with("lumoCharacter", None)).unwrap();
        assert_eq!(loaded.lumo_character, "filo");
        assert_eq!(loaded.lumo_motion, "lively");
        assert_eq!(Settings::default().lumo_character, "filo");
    }

    #[test]
    fn a_look_this_build_does_not_know_is_kept_as_written() {
        // A newer build may add looks: the island shows Filo for it, but
        // going back to that build must find the choice still there.
        let loaded = parse(&custom_with("lumoCharacter", Some(json!("perla")))).unwrap();
        assert_eq!(loaded.lumo_character, "perla");
        assert_eq!(loaded.mochi_outfit, "witchHat");
    }

    #[test]
    fn an_outfit_this_build_does_not_know_is_kept_as_written() {
        // A newer build may add outfits: the island shows "auto" for it, but
        // the choice must survive a save made by this one.
        let loaded = parse(&custom_with("mochiOutfit", Some(json!("topHat")))).unwrap();
        assert_eq!(loaded.mochi_outfit, "topHat");
        // The language too: "" (follow the system) when absent, as it comes otherwise.
        assert_eq!(parse(&custom_with("language", None)).unwrap().language, "");
        assert_eq!(parse(&custom_with("language", Some(json!("xx")))).unwrap().language, "xx");
    }

    #[test]
    fn a_missing_field_takes_its_default_and_the_rest_are_kept() {
        for key in custom().as_object().unwrap().keys() {
            let loaded = parse(&custom_with(key, None))
                .unwrap_or_else(|| panic!("a file without {key} was thrown away"));
            let mut expected = custom();
            expected[key] = defaults()[key].clone();
            assert_eq!(shown(&loaded), expected, "without {key}");
        }
    }

    #[test]
    fn a_field_of_the_wrong_type_takes_its_default_and_the_rest_are_kept() {
        for (key, wrong) in [
            ("soundVolume", json!("loud")),
            ("soundEnabled", json!(1)),
            ("activeIntegrations", json!("integration_n8n")),
            ("mainPill", json!(["agent_cursor"])),
            ("screen", Value::Null),
            ("shortcuts", json!("Ctrl+Alt+A")),
        ] {
            let loaded = parse(&custom_with(key, Some(wrong)))
                .unwrap_or_else(|| panic!("a file with a bad {key} was thrown away"));
            let mut expected = custom();
            expected[key] = defaults()[key].clone();
            assert_eq!(shown(&loaded), expected, "bad {key}");
        }
    }

    #[test]
    fn a_utf8_bom_is_not_corruption() {
        // What PowerShell 5's `Set-Content -Encoding utf8` and Notepad write.
        let (dir, file) = scratch("bom");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(CUSTOM.as_bytes());
        std::fs::write(&file, &bytes).unwrap();
        assert_eq!(shown(&load_from(&file)), custom());
        assert_eq!(names(&dir), ["settings.json"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unusable_file_is_the_defaults_and_is_set_aside_byte_for_byte() {
        for (name, bad) in [
            ("invalid", &b"{ \"soundVolume\": 0.5, \xff oops"[..]),
            ("not-an-object", &b"[1, 2, 3]"[..]),
        ] {
            let (dir, file) = scratch(name);
            std::fs::write(&file, bad).unwrap();
            assert_eq!(shown(&load_from(&file)), defaults());
            assert_eq!(kept(&dir, "corrupt"), [bad.to_vec()], "{name}");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn a_second_unusable_file_never_replaces_the_copy_of_the_first() {
        // Both within the same second: the names must still differ.
        let (dir, file) = scratch("twice");
        let (first, second) = (&b"{ first"[..], &b"{ second"[..]);
        std::fs::write(&file, first).unwrap();
        load_from(&file);
        std::fs::write(&file, second).unwrap();
        load_from(&file);
        let mut copies = kept(&dir, "corrupt");
        copies.sort();
        assert_eq!(copies, [first.to_vec(), second.to_vec()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn something_that_is_not_a_readable_file_is_the_defaults_and_is_left_alone() {
        // A directory in the file's place: a read error that is not "not found".
        let (dir, file) = scratch("unreadable");
        std::fs::create_dir(&file).unwrap();
        assert_eq!(shown(&load_from(&file)), defaults());
        assert_eq!(names(&dir), ["settings.json"]);
        assert!(file.is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Opens `path` the way a process that shares nothing does: nobody else can
    /// read or write it until the handle is dropped.
    #[cfg(windows)]
    fn locked(path: &Path) -> std::fs::File {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new().read(true).share_mode(0).open(path).unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn a_file_that_could_not_be_read_is_set_aside_before_it_is_saved_over() {
        let (dir, file) = scratch("locked-then-free");
        std::fs::write(&file, CUSTOM).unwrap();
        let lock = locked(&file);
        let loaded = load_from(&file);
        assert_eq!(shown(&loaded), defaults());
        drop(lock);

        save_to(&file, &loaded).unwrap();
        assert_eq!(kept(&dir, "unread"), [CUSTOM.as_bytes().to_vec()]);
        assert_eq!(shown(&load_from(&file)), defaults());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn a_file_that_still_cannot_be_read_is_not_saved_over() {
        let (dir, file) = scratch("locked");
        std::fs::write(&file, CUSTOM).unwrap();
        let lock = locked(&file);
        let loaded = load_from(&file);
        assert!(save_to(&file, &loaded).is_err());
        drop(lock);
        assert_eq!(std::fs::read(&file).unwrap(), CUSTOM.as_bytes());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn what_could_not_be_read_is_never_saved_over_unseen() {
        // The same as the two locked-file tests above, on every platform: a
        // directory in the file's place cannot be read either.
        let (dir, file) = scratch("unread");
        std::fs::create_dir(&file).unwrap();
        let loaded = load_from(&file);

        // Still unreadable: the save is refused and nothing is touched.
        assert!(save_to(&file, &loaded).is_err());
        assert!(file.is_dir());
        assert_eq!(names(&dir), ["settings.json"]);

        // Readable by now: kept aside first, and only then saved over.
        std::fs::remove_dir(&file).unwrap();
        std::fs::write(&file, CUSTOM).unwrap();
        save_to(&file, &loaded).unwrap();
        assert_eq!(kept(&dir, "unread"), [CUSTOM.as_bytes().to_vec()]);
        assert_eq!(shown(&load_from(&file)), defaults());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── Copies set aside ──────────────────────────────────────────────────────

    #[test]
    fn an_unusable_file_is_set_aside_once_however_often_it_is_loaded() {
        let (dir, file) = scratch("once");
        std::fs::write(&file, b"{ broken").unwrap();
        for _ in 0..3 {
            load_from(&file);
        }
        assert_eq!(kept(&dir, "corrupt"), [b"{ broken".to_vec()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn copies_made_within_the_same_second_are_numbered_and_none_is_written_over() {
        let (dir, file) = scratch("numbered");
        let stamp = "20260102-030405";
        let contents = [&b"one"[..], &b"two"[..], &b"three"[..]];
        let copies: Vec<PathBuf> = contents
            .iter()
            .map(|bytes| set_aside_as(&file, "corrupt", stamp, bytes, write_whole).unwrap())
            .collect();

        let named = |suffix: &str| dir.join(format!("settings.json.corrupt-{stamp}{suffix}"));
        assert_eq!(copies, [named(""), named("-1"), named("-2")]);
        for (copy, bytes) in copies.iter().zip(contents) {
            assert_eq!(std::fs::read(copy).unwrap(), bytes);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_copy_that_could_not_be_written_whole_is_removed() {
        fn half_then_fail(file: &mut std::fs::File, bytes: &[u8]) -> std::io::Result<()> {
            use std::io::Write;
            file.write_all(&bytes[..bytes.len() / 2])?;
            Err(std::io::Error::other("the disk is full"))
        }
        let (dir, file) = scratch("half");
        let copy = set_aside_as(&file, "corrupt", "20260102-030405", b"all of it", half_then_fail);
        assert!(copy.is_err());
        assert!(names(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_field_name_cannot_start_a_line_of_its_own_in_the_log() {
        let forged = "volume\r\n2026-01-02 03:04:05 hook id=1 answered allow";
        let line = unusable_field(forged);
        assert!(!line.contains(['\r', '\n']));
        assert!(line.contains(r"volume\r\n2026-01-02"));
    }

    // ── Writing ───────────────────────────────────────────────────────────────

    /// A dotfiles setup keeps the real file elsewhere and links to it.
    #[cfg(unix)]
    #[test]
    fn a_save_through_a_symlink_keeps_the_link_and_writes_its_target() {
        let (dir, file) = scratch("symlink");
        let real = dir.join("dotfiles-settings.json");
        std::fs::write(&real, CUSTOM).unwrap();
        std::os::unix::fs::symlink(&real, &file).unwrap();

        save_to(&file, &Settings::default()).unwrap();
        assert!(std::fs::symlink_metadata(&file).unwrap().file_type().is_symlink());
        assert_eq!(shown(&parse(&std::fs::read(&real).unwrap()).unwrap()), defaults());
        assert_eq!(names(&dir), ["dotfiles-settings.json", "settings.json"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_field_survives_a_save_and_a_load() {
        let (dir, file) = scratch("round-trip");
        let settings: Settings = serde_json::from_str(CUSTOM).unwrap();
        save_to(&file, &settings).unwrap();
        assert_eq!(shown(&load_from(&file)), custom());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_file_holds_the_camel_case_keys_the_front_end_uses() {
        let (dir, file) = scratch("keys");
        save_to(&file, &Settings::default()).unwrap();
        let written: Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        let keys: Vec<&str> = written.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "soundEnabled",
                "soundVolume",
                "autoCloseInterval",
                "absenceInterval",
                "activeIntegrations",
                "mainPill",
                "screen",
                "islandZoom",
                "islandDock",
                "islandOffset",
                "islandFloat",
                "islandWidth",
                "islandHeight",
                "iconScale",
                "islandClose",
                "islandHoverOpen",
                "islandAutoHide",
                "compactActivity",
                "compactMedia",
                "activitiesPanel",
                "activitiesFolded",
                "activitiesSide",
                "activitiesWidth",
                "activitiesHeight",
                "activitiesDetached",
                "activitiesX",
                "activitiesY",
                "autostart",
                "hooksInstalled",
                "model",
                "showPlanInNotch",
                "planRelayInstalled",
                "showCodexPlanInNotch",
                "chatProvider",
                "chatModels",
                "chatEffort",
                "chatPermissionMode",
                "chatShowUsage",
                "chatShareExplorer",
                "chatShareOpen",
                "liveModel",
                "liveThinking",
                "liveVoice",
                "liveHelper",
                "liveHelperModel",
                "liveHelperEffort",
                "liveScreen",
                "ollamaUrl",
                "lmstudioUrl",
                "customUrl",
                "shortcuts",
                "mochiOutfit",
                "lumoMotion",
                "lumoCharacter",
                "pillColors",
                "language",
                "desktopMochi",
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_from_before_gemini_live_gets_its_defaults() {
        let s: Settings = serde_json::from_str(r#"{"chatProvider":"google","language":"fr"}"#).unwrap();
        assert_eq!(s.chat_provider, "google");
        assert_eq!(s.live_model, "gemini-3.8-live");
        assert_eq!(s.live_thinking, "medium");
        assert_eq!(s.live_voice, "");
        assert_eq!(s.live_helper, "claude-code");
        assert_eq!(s.live_helper_model, "default");
        assert_eq!(s.live_helper_effort, "");
        assert!(s.live_screen);
    }

    #[test]
    fn a_save_replaces_the_file_that_was_there() {
        let (dir, file) = scratch("replace");
        std::fs::write(&file, CUSTOM).unwrap();
        save_to(&file, &Settings::default()).unwrap();
        assert_eq!(shown(&load_from(&file)), defaults());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_leaves_nothing_but_settings_json_behind() {
        let (dir, file) = scratch("tidy");
        save_to(&file, &Settings::default()).unwrap();
        save_to(&file, &Settings::default()).unwrap();
        assert_eq!(names(&dir), ["settings.json"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_temporary_file_that_cannot_be_written_leaves_the_original_alone() {
        // The new contents go to a file beside the target first. With a
        // directory squatting on that name, the write cannot even start.
        let (dir, file) = scratch("blocked");
        std::fs::write(&file, CUSTOM).unwrap();
        let temp = dir.join(format!("settings.json.lumo-{}", std::process::id()));
        std::fs::create_dir(&temp).unwrap();

        assert!(save_to(&file, &Settings::default()).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), CUSTOM.as_bytes());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
