// Lumo for Windows — app wiring and the commands the island calls.

mod activities;
mod agent_hooks;
mod agents;
mod antigravity_cli;
mod autostart;
mod calendar;
mod chat;
mod chat_usage;
mod claude;
mod claude_code;
mod clipboard;
mod codex_plan;
mod computer;
mod config_file;
mod desk;
mod desktop;
mod explorer;
mod files;
mod github;
mod hooks;
mod i18n;
mod identity;
mod integrations;
mod island;
mod live;
mod local_chat;
mod log;
mod mail;
mod media;
mod migrate;
mod net;
mod openai_compat;
mod pipe;
mod plan_usage;
mod platform;
mod recap;
mod screen;
mod secrets;
mod selection;
mod session_window;
mod settings;
mod share;
mod shortcuts;
mod tray;
mod typing;
mod updater;
#[cfg(windows)]
mod webview_drop;

use std::process::Command;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{ManagerExt, MacosLauncher};

use chat::{Chat, ChatContext, ChatReply, ModelInfo};
use files::DroppedFile;
use hooks::{HookPreview, HookStatus};
use island::{PollGate, ScreenInfo};
use pipe::Pending;
use settings::Settings;

pub struct Shared {
    pub settings: Mutex<Settings>,
    pub gate: Arc<PollGate>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootInfo {
    settings: Settings,
    screen: ScreenInfo,
    version: String,
    hook_path: String,
    /// False where the OS has no global cursor (Wayland): the page then reports
    /// the cursor from its own mouse events.
    cursor_poll: bool,
    /// Where the island is drawn in its window (island::shift).
    shift: island::ShiftPayload,
}

#[tauri::command]
fn boot(app: AppHandle, shared: State<Shared>) -> BootInfo {
    let mut settings = shared.settings.lock().unwrap().clone();
    // The real state of ~/.claude/settings.json wins over whatever we stored.
    let hooks_status = hooks::status();
    settings.hooks_installed = hooks_status.installed;
    settings.plan_relay_installed = hooks_status.plan_relay_installed;
    let screen = island::screen_info(&app, &settings.screen);
    let shift = island::current_shift(&app, &settings.screen, island::Placement::of(&settings));
    BootInfo {
        settings,
        screen,
        version: env!("CARGO_PKG_VERSION").to_string(),
        hook_path: settings::hook_exe_path().to_string_lossy().to_string(),
        cursor_poll: platform::CURSOR_POLL,
        shift,
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, shared: State<Shared>, settings: Settings) {
    let (screen_changed, autostart_changed, shortcuts_changed) = {
        let mut current = shared.settings.lock().unwrap();
        let screen_changed = current.screen != settings.screen
            || current.island_zoom != settings.island_zoom
            || current.island_edge_gap != settings.island_edge_gap
            || activities::room_of(&current) != activities::room_of(&settings);
        let autostart_changed = current.autostart != settings.autostart;
        let shortcuts_changed = current.shortcuts != settings.shortcuts;
        // Where Mochi sits on the desktop is desktop.rs's to say, not a webview's.
        let mut settings = settings.clone();
        settings.desktop_mochi = current.desktop_mochi.clone();
        // Where the island was dragged is island.rs's to say, too.
        settings.island_dock = current.island_dock.clone();
        settings.island_offset = current.island_offset;
        settings.island_float = current.island_float;
        settings.island_width = current.island_width;
        settings.island_height = current.island_height;
        // So are where the live activities were left and how big.
        settings.activities_detached = current.activities_detached;
        settings.activities_side = current.activities_side.clone();
        settings.activities_x = current.activities_x;
        settings.activities_y = current.activities_y;
        settings.activities_width = current.activities_width;
        settings.activities_height = current.activities_height;
        *current = settings;
        (screen_changed, autostart_changed, shortcuts_changed)
    };
    let settings = shared.settings.lock().unwrap().clone();
    if let Err(err) = settings::save(&settings) {
        log::line(format!("could not save settings: {err}"));
    }
    if autostart_changed {
        let manager = app.autolaunch();
        let result = if settings.autostart { manager.enable() } else { manager.disable() };
        if let Err(err) = result {
            eprintln!("[lumo] autostart: {err}");
        }
    }
    if screen_changed {
        let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
        island::apply_geometry(&app, &settings.screen, island::Placement::of(&settings), collapsed);
    }
    integrations::settings_saved(&app, &settings.active_integrations);
    if shortcuts_changed {
        shortcuts::apply(&app, &settings.shortcuts);
    }
    if i18n::set_picked(&settings.language) {
        language_changed(&app);
    }
    // Keep the other window in step (island ⇄ settings window).
    let _ = app.emit("settings-changed", settings);
}

/// The island reports the system's languages at launch, for "System" in
/// Settings → Language (WebView2 and WebKitGTK know them best).
#[tauri::command]
fn set_system_languages(app: AppHandle, languages: Vec<String>) {
    if i18n::set_system(languages) {
        language_changed(&app);
    }
}

/// What Rust labels itself follows the new language: the tray menu and the
/// settings window's title. The webviews switch on their own.
fn language_changed(app: &AppHandle) {
    tray::retitle(app);
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.set_title(&i18n::t("Settings — Lumo"));
    }
}

/// Hidden island → shrink the window to the invisible wake strip and park the
/// cursor poll; anything else → full panel and 60 Hz polling.
#[tauri::command]
fn set_collapsed(app: AppHandle, shared: State<Shared>, collapsed: bool) {
    let (pref, placement) = placement(&shared);
    shared.gate.collapsed.store(collapsed, Ordering::Relaxed);
    island::apply_geometry(&app, &pref, placement, collapsed);
    // The wake strip must always take the mouse, and a resize invalidates the flag.
    island::refresh_click_through(&app, &shared.gate);
    shared.gate.set_active(!collapsed);
    platform::set_pointer_watch(!collapsed);
}

/// The front end pushes the island shape; Rust decides click-through from it.
#[tauri::command]
fn set_island_rect(app: AppHandle, shared: State<Shared>, x: f64, y: f64, width: f64, height: f64) {
    shared.gate.set_rect(island::IslandRect { x, y, w: width, h: height });
    // Without the cursor poll the input region is the click-through: it follows the island.
    if !platform::CURSOR_POLL {
        island::refresh_click_through(&app, &shared.gate);
    }
}

#[tauri::command]
fn focus_window(app: AppHandle, focused: bool) {
    let Some(win) = island::window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn reposition(app: AppHandle, shared: State<Shared>) {
    let (pref, placement) = placement(&shared);
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(&app, &pref, placement, collapsed);
}

/// The island's display preference and placement, as the settings say.
fn placement(shared: &Shared) -> (String, island::Placement) {
    let s = shared.settings.lock().unwrap();
    (s.screen.clone(), island::Placement::of(&s))
}

/// Saves what `change` does to the settings, places the island for them and
/// tells both windows.
pub(crate) fn update_island(app: &AppHandle, change: impl FnOnce(&mut Settings)) {
    let shared = app.state::<Shared>();
    let settings = {
        let mut s = shared.settings.lock().unwrap();
        change(&mut s);
        s.clone()
    };
    if let Err(err) = settings::save(&settings) {
        log::line(format!("could not save settings: {err}"));
    }
    let collapsed = shared.gate.collapsed.load(Ordering::Relaxed);
    island::apply_geometry(app, &settings.screen, island::Placement::of(&settings), collapsed);
    let _ = app.emit("settings-changed", settings);
}

/// A drag from the island's top (or Alt + drag): it follows the mouse until
/// the button is let go, then goes to the nearest edge.
#[tauri::command]
fn island_drag(app: AppHandle, island: Option<(f64, f64, f64, f64)>) {
    std::thread::spawn(move || {
        let shared = app.state::<Shared>();
        let (pref, start) = placement(&shared);
        // The island itself, as the page drew it: the rect that takes the
        // mouse also holds the live activities beside the open island, and
        // its centre is not the island's.
        let rect = match island {
            Some((x, y, w, h)) if w > 0.0 && h > 0.0 && [x, y, w, h].iter().all(|v| v.is_finite()) => {
                island::IslandRect { x, y, w, h }
            }
            _ => *shared.gate.rect.lock().unwrap(),
        };
        let Some(dropped) = island::drag(&app, &pref, start, rect) else { return };
        let p = dropped.placement;
        update_island(&app, |s| {
            s.island_dock = p.dock.name().to_string();
            s.island_offset = p.offset;
            s.island_float = p.float;
            if let Some(screen) = dropped.screen {
                s.screen = screen;
            }
        });
    });
}

/// A drag on one of the island's grips: it follows the mouse until the button
/// is let go. `fx`/`fy` say how the grip changes the width and height (see
/// island::resized); `height` is the island's height as drawn.
#[tauri::command]
fn island_resize(app: AppHandle, fx: f64, fy: f64, height: f64) {
    std::thread::spawn(move || {
        let (pref, start) = placement(&app.state::<Shared>());
        let Some(p) = island::resize(&app, &pref, start, (fx, fy), height) else { return };
        // Unchanged (a click, or the first half of a double click): nothing to
        // save, and nothing to undo a reset with. The window only grows when
        // the size does.
        if p == start {
            return;
        }
        update_island(&app, |s| {
            s.island_width = island::clamp_width(p.width);
            s.island_height = island::clamp_height(p.height);
        });
    });
}

/// A double click on a grip: back to the usual width, height, or both.
#[tauri::command]
fn island_reset_size(app: AppHandle, width: bool, height: bool) {
    update_island(&app, |s| {
        if width {
            s.island_width = island::DEFAULT_WIDTH;
        }
        if height {
            s.island_height = 0.0;
        }
    });
}

/// Puts the island back at the top centre of its display.
#[tauri::command]
fn island_recenter(app: AppHandle) {
    recenter_island(&app);
}

pub(crate) fn recenter_island(app: &AppHandle) {
    update_island(app, |s| {
        s.island_dock = "top".into();
        s.island_offset = 0.0;
        s.island_float = 0.0;
    });
}

/// The displays the island can be pinned to, for Settings.
#[tauri::command]
fn list_monitors(app: AppHandle) -> Vec<island::MonitorChoice> {
    island::monitor_choices(&app)
}

#[tauri::command]
fn open_url(url: String) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    platform::open_url(&url);
}

/// "Open terminal" opens the working folder in VS Code when `code` is on PATH,
/// and falls back to the file manager otherwise.
#[tauri::command]
fn open_in_vscode(path: Option<String>) -> bool {
    // No shell anywhere near this. The path is a project folder chosen by
    // whoever is using Claude Code, and a shell would happily read `&`, `^`, `%`
    // or `$` in a folder name as syntax. Finding the launcher ourselves and
    // handing the path over as a separate argument keeps it a path.
    let path = path.filter(|p| !p.is_empty());
    // It arrives in a hook payload: only an existing folder, given by its full
    // path, goes any further. `code` would read `--something` as an option, and
    // xdg-open would launch a file with whatever handles its type.
    if let Some(p) = path.as_deref() {
        let p = std::path::Path::new(p);
        if !(p.is_absolute() && p.is_dir()) {
            return false;
        }
    }
    if let Some(code) = platform::find_on_path("code") {
        let mut cmd = Command::new(code);
        if let Some(p) = path.as_deref() {
            cmd.arg(p);
        }
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    if let Some(p) = path.as_deref() {
        platform::reveal_folder(p);
    }
    false
}

/// "Open terminal": brings forward the terminal or editor window the session
/// runs in, when it was found (Windows, see session_window.rs); otherwise opens
/// the folder in VS Code, as before.
#[tauri::command]
fn open_session(session_id: Option<String>, path: Option<String>) -> bool {
    if let Some(owner) = session_id.as_deref().and_then(session_window::lookup) {
        let folder = path.as_deref().map(session_window::folder_name).unwrap_or_default();
        if platform::focus_process_window(owner, folder) {
            return true;
        }
    }
    open_in_vscode(path)
}

/// The Claude Desktop pill's target: the Claude app (Windows only — it has no
/// Linux build).
#[tauri::command]
fn open_claude_desktop() -> bool {
    platform::open_claude_desktop()
}

/// The file behind a live diff, if it may be handed to the editor: an existing
/// regular file given by its full path. Anything else — a relative path, a
/// folder, a path `code` could read as an option — goes no further.
fn diff_file(path: &str) -> Option<&std::path::Path> {
    let p = std::path::Path::new(path);
    (p.is_absolute() && p.is_file()).then_some(p)
}

/// The diff card's ↗: opens the edited file in VS Code when `code` is on PATH,
/// otherwise shows its folder. The file itself is never opened by its type —
/// xdg-open or Explorer would run a script that Claude just wrote.
#[tauri::command]
fn open_file_in_vscode(path: String) -> bool {
    let Some(file) = diff_file(&path) else { return false };
    if let Some(code) = platform::find_on_path("code") {
        let mut cmd = Command::new(code);
        cmd.arg(file);
        if platform::no_console(&mut cmd).spawn().is_ok() {
            return true;
        }
    }
    if let Some(folder) = file.parent().filter(|d| d.is_dir()) {
        platform::reveal_folder(&folder.to_string_lossy());
    }
    false
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Tray → Pause. Paused means paused: the pollers stop talking to the network,
/// not just the island stopping showing things.
#[tauri::command]
fn set_paused(paused: bool) {
    integrations::set_paused(paused);
}

// ── Claude Code hooks ─────────────────────────────────────────────────────────

#[tauri::command]
fn hooks_status() -> HookStatus {
    hooks::status()
}

/// Pill ID → whether that agent's hooks reach Lumo. Read-only.
#[tauri::command]
fn agent_hooks_status() -> std::collections::HashMap<String, bool> {
    agent_hooks::status()
}

/// Returns the diff the user has to look at before anything is written.
#[tauri::command]
fn hooks_preview(install: bool) -> Result<HookPreview, String> {
    hooks::preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn hooks_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    // The fingerprint comes from the preview the user actually looked at, so a
    // settings.json that changed in between is refused rather than overwritten.
    let backup = hooks::write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.hooks_installed = install;
        if let Err(err) = settings::save(&current) {
            log::line(format!("could not save settings: {err}"));
        }
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

// ── Other agents' hooks and plugins ──────────────────────────────────────────

#[tauri::command]
fn agent_hooks_list() -> Vec<agents::AgentStatus> {
    agents::list()
}

/// The diff the user has to look at before anything is written.
#[tauri::command]
fn agent_hooks_preview(agent: String, install: bool) -> Result<config_file::Plan, String> {
    agents::preview(&agent, install)
}

/// Only ever called from an explicit click in the settings window, with the
/// fingerprint of the preview the user looked at.
#[tauri::command]
fn agent_hooks_apply(agent: String, install: bool, fingerprint: String) -> Result<String, String> {
    let backups = agents::apply(&agent, install, &fingerprint)?;
    let done = if install { "installed" } else { "removed" };
    log::line(format!("agent hooks {done} for {agent}"));
    Ok(backups)
}

// ── Plan usage ────────────────────────────────────────────────────────────────

/// The diff of putting the plan usage relay into (or taking it out of) the
/// status line, before anything is written.
#[tauri::command]
fn status_line_preview(install: bool) -> Result<HookPreview, String> {
    hooks::status_line_preview(install)
}

/// Only ever called from an explicit click in the settings window.
#[tauri::command]
fn status_line_apply(
    app: AppHandle,
    shared: State<Shared>,
    install: bool,
    fingerprint: String,
) -> Result<String, String> {
    let backup = hooks::status_line_write(install, &fingerprint)?;
    let updated = {
        let mut current = shared.settings.lock().unwrap();
        current.plan_relay_installed = install;
        // As on the Mac: taking the relay out turns the pill off with it.
        if !install {
            current.show_plan_in_notch = false;
        }
        if let Err(err) = settings::save(&current) {
            log::line(format!("could not save settings: {err}"));
        }
        current.clone()
    };
    let _ = app.emit("settings-changed", updated);
    Ok(backup)
}

/// Codex plan usage, asked of the Codex CLI (`codex app-server`) when its pill
/// shows. Off the main thread: it can take a few seconds.
#[tauri::command]
async fn codex_plan_usage() -> Option<serde_json::Value> {
    tauri::async_runtime::spawn_blocking(codex_plan::read).await.ok().flatten()
}

/// The Claude plan's usage asked of Anthropic with Claude Code's sign-in
/// (plan_usage.rs). Only when turned on in Settings; never on its own.
#[tauri::command]
async fn plan_usage_fetch(shared: State<'_, Shared>) -> Result<serde_json::Value, String> {
    if !shared.settings.lock().unwrap().plan_usage_online {
        return Err("off".into());
    }
    plan_usage::fetch().await
}

#[tauri::command]
fn approval_decision(app: AppHandle, request_id: String, decision: String) {
    recap::record_decision(&app, &request_id, &decision);
    pipe::answer(&app, &request_id, &decision);
}

/// An option picked on the island for a question Claude Code asked.
#[tauri::command]
fn approval_answer(
    app: AppHandle,
    request_id: String,
    answers: std::collections::HashMap<String, serde_json::Value>,
) {
    // An answered question is not an Allow / Deny: nothing for the recap.
    recap::forget_request(&app, &request_id);
    pipe::answer_question(&app, &request_id, &answers);
}

/// The island has the card on screen, so the long wait for a human may begin.
/// Until this arrives the relay only waits a few hundred milliseconds, which is
/// what stops a paused or unresponsive island from freezing Claude Code.
#[tauri::command]
fn approval_ack(app: AppHandle, request_id: String) {
    pipe::acknowledge(&app, &request_id);
}

/// Nobody can act on this request — the island is paused, or another card is
/// already up. Claude Code falls back to asking in the terminal immediately.
#[tauri::command]
fn approval_decline(app: AppHandle, request_id: String) {
    recap::forget_request(&app, &request_id);
    pipe::decline(&app, &request_id);
}

// ── Chat, files and secrets ───────────────────────────────────────────────────

/// One chat turn with the provider picked in the chat view. API keys and any
/// file bytes stay on the Rust side.
#[tauri::command]
async fn chat_send(
    app: AppHandle,
    shared: State<'_, Shared>,
    chat: State<'_, Chat>,
    query: String,
    context: Option<ChatContext>,
    screen: Option<screen::ScreenContext>,
) -> Result<ChatReply, String> {
    let settings = shared.settings.lock().unwrap().clone();
    let shots: Vec<String> = screen.as_ref().map(|s| s.shots.iter().map(|r| r.path.clone()).collect()).unwrap_or_default();
    let reply = chat::send(&app, &chat, &settings, query, context, screen).await;
    // Screenshots are read once the turn is answered: they don't stay on disk.
    // A failed turn keeps them, so the same message can be sent again.
    if reply.is_ok() {
        screen::discard(&shots);
    }
    reply
}

/// The models a provider offers, for the picker in the chat view. Only asked
/// once the user picked that provider, and only with its key or address.
#[tauri::command]
async fn chat_models(shared: State<'_, Shared>, provider: String) -> Result<Vec<ModelInfo>, String> {
    let settings = shared.settings.lock().unwrap().clone();
    chat::models(&settings, &provider).await
}

/// The OpenRouter key's credits, for the line next to the chat's model picker.
/// Asked only while "Show remaining usage in the chat" is on, OpenRouter is
/// the chat's provider and has a key; the island asks when the chat opens and
/// after an answer. Anthropic and OpenAI need no call: their numbers come with
/// each answer (`chat-usage`).
#[tauri::command]
async fn chat_usage(shared: State<'_, Shared>) -> Result<Option<chat_usage::ChatUsage>, String> {
    let settings = shared.settings.lock().unwrap().clone();
    if !settings.chat_show_usage || settings.chat_provider != "openrouter" {
        return Ok(None);
    }
    chat_usage::openrouter().await
}

/// Settings → Local models → Connect: does the server answer, and with which models?
#[tauri::command]
async fn local_connect(provider: String, url: String) -> Result<local_chat::Connected, String> {
    local_chat::connect(&provider, &url).await
}

/// Stores the custom server's key for the address typed next to it; it is only
/// ever sent to that address.
#[tauri::command]
fn local_set_key(url: String, key: String) -> Result<(), String> {
    local_chat::set_custom_key(&url, &key)
}

#[tauri::command]
fn chat_reset(chat: State<Chat>) {
    chat.reset();
}

/// The chat's Stop button: ends the answer being written. `chat_send` then
/// returns what was written so far, marked stopped.
#[tauri::command]
fn chat_stop(chat: State<Chat>) {
    chat.stop();
}

/// An edited message: the conversation goes back to its first `keep` turns
/// (as `chat_send` counted them) before the edited one is sent.
#[tauri::command]
fn chat_rewind(chat: State<Chat>, keep: usize) {
    chat.rewind(keep);
}

/// One turn of a chat from the history, as the island keeps it.
#[derive(serde::Deserialize)]
struct SavedTurn {
    role: String,
    content: String,
}

/// Opens a chat from the history: what was said, and the Claude Code session
/// or Antigravity CLI conversation that answered it, if any, so the next
/// question continues it.
#[tauri::command]
fn chat_restore(chat: State<Chat>, turns: Vec<SavedTurn>, session: Option<String>) {
    chat.restore(turns.into_iter().map(|t| (t.role, t.content)).collect(), session);
}

/// "Attach a file" in the chat: the system's file picker, then the same copy
/// into the inbox as a drop. Only a file the user picked there can be added.
#[tauri::command]
async fn pick_file(app: AppHandle) -> Result<Option<DroppedFile>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file().blocking_pick_file())
        .await
        .map_err(|e| e.to_string())?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|e| e.to_string())?.to_string_lossy().to_string();
    files::allow_dropped([path.clone()]);
    files::ingest(&path).map(Some)
}

// ── The chat's screen button ──────────────────────────────────────────────────
//
// Each of these runs only when the user clicks its entry in the menu
// (screen.rs): nothing is listed or captured in the background.

/// The displays, for the menu's "Screen 1", "Screen 2"… entries. Captures nothing.
#[tauri::command]
async fn screen_displays() -> Result<Vec<screen::Display>, String> {
    tauri::async_runtime::spawn_blocking(screen::displays).await.map_err(|e| e.to_string())?
}

/// "Open windows": titles and app names of the visible windows, for the menu
/// to list (and for `screen_window_share` to pick from).
#[tauri::command]
async fn screen_windows() -> Result<Vec<screen::WindowInfo>, String> {
    tauri::async_runtime::spawn_blocking(share::windows).await.map_err(|e| e.to_string())?
}

/// The windows picked in the menu (all of them when `ids` is empty), each
/// with what it shows: its text and the document it has open.
#[tauri::command]
async fn screen_window_share(ids: Vec<i64>) -> Result<Vec<share::SharedWindow>, String> {
    tauri::async_runtime::spawn_blocking(move || share::read_windows(&ids)).await.map_err(|e| e.to_string())?
}

/// A screenshot of one picked window, for the providers that see images.
#[tauri::command]
async fn screen_window_shot(id: i64) -> Result<screen::Shot, String> {
    tauri::async_runtime::spawn_blocking(move || share::window_shot(id)).await.map_err(|e| e.to_string())?
}

/// "Browser tabs": the tabs open in Edge and Chrome, titles and addresses.
#[tauri::command]
async fn screen_tabs() -> Result<Vec<share::BrowserTab>, String> {
    tauri::async_runtime::spawn_blocking(share::tabs).await.map_err(|e| e.to_string())?
}

/// The tabs picked in the menu (all of them when `ids` is empty), each with
/// its page's text.
#[tauri::command]
async fn screen_tab_share(ids: Vec<String>) -> Result<Vec<share::BrowserTab>, String> {
    share::read_tabs(ids).await
}

/// A screenshot of one display (`display`, from 0) or all of them, into the
/// inbox, with a preview for the island to show before anything is sent. The
/// island keeps itself out of the picture meanwhile (Windows 10 2004 and later:
/// content protection, which Lumo never uses otherwise).
#[tauri::command]
async fn screen_capture(app: AppHandle, display: Option<usize>) -> Result<Vec<screen::Shot>, String> {
    tauri::async_runtime::spawn_blocking(move || screen::capture_unseen(&app, display))
        .await
        .map_err(|e| e.to_string())?
}

/// Cancel in the preview: the screenshots are deleted from the inbox.
#[tauri::command]
fn screen_discard(paths: Vec<String>) {
    screen::discard(&paths);
}

/// The folder open in File Explorer, its name only, for the menu's label.
/// Lists nothing; remembers nothing.
#[tauri::command]
async fn screen_explorer_peek() -> Result<Option<explorer::ExplorerFolder>, String> {
    tauri::async_runtime::spawn_blocking(explorer::peek).await.map_err(|e| e.to_string())?
}

/// "Folder open in File Explorer": that folder and what is in it (names,
/// sizes, dates), now shared with the chat.
#[tauri::command]
async fn screen_explorer() -> Result<Option<explorer::ExplorerFolder>, String> {
    tauri::async_runtime::spawn_blocking(explorer::share).await.map_err(|e| e.to_string())?
}

/// A question sent with a shared folder: the file of it that the question
/// names, copied into the inbox like a picked file, or nothing.
#[tauri::command]
async fn explorer_attach(folder: String, query: String) -> Result<Option<DroppedFile>, String> {
    tauri::async_runtime::spawn_blocking(move || explorer::attach(&folder, &query)).await.map_err(|e| e.to_string())?
}

/// Copies a dropped file into the inbox and reports its name back.
#[tauri::command]
fn ingest_file(path: String) -> Result<DroppedFile, String> {
    files::ingest(&path)
}

/// Ctrl+V in the chat with an image (or a file the page can read): its bytes,
/// sent raw, written into the inbox like a dropped file. The name rides in the
/// `x-lumo-name` header, percent-encoded.
#[tauri::command]
async fn paste_file(request: tauri::ipc::Request<'_>) -> Result<DroppedFile, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(i18n::t("Couldn't paste this."));
    };
    if bytes.len() > files::MAX_PASTE {
        return Err(i18n::t("This file is too big to paste. Attach it with the paperclip instead."));
    }
    let name = request
        .headers()
        .get("x-lumo-name")
        .and_then(|v| v.to_str().ok())
        .and_then(explorer::percent_decode_text)
        .unwrap_or_default();
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || files::write_in(&name, &bytes)).await.map_err(|e| e.to_string())?
}

/// Ctrl+V in the chat found no text and no image: the file copied in File
/// Explorer (CF_HDROP), copied into the inbox; nothing when there is none.
#[tauri::command]
async fn paste_copied_file() -> Result<Option<DroppedFile>, String> {
    tauri::async_runtime::spawn_blocking(clipboard::paste_copied_file).await.map_err(|e| e.to_string())?
}

/// The text on the clipboard, for the right-click menu's Paste.
#[tauri::command]
async fn clipboard_text() -> Option<String> {
    tauri::async_runtime::spawn_blocking(clipboard::text).await.ok().flatten()
}

/// The island may only ask whether a key exists — never read it.
/// The chat providers that are set up, for the model picker: a key in the
/// credential store, or the CLI on this computer with Lumo's hooks in place
/// (Claude Code, Antigravity CLI). The model servers are the page's to judge
/// (their address in the settings). Async: the credential store and the disk
/// may take a moment, and the main thread is not kept waiting.
#[tauri::command]
async fn chat_providers() -> Vec<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let mut ready = Vec::new();
        for (id, key) in [
            ("anthropic", "anthropic-api-key"),
            ("google", "google-api-key"),
            ("openai", "openai-api-key"),
            ("openrouter", "openrouter-api-key"),
        ] {
            if secrets::present(key) {
                ready.push(id.to_string());
            }
        }
        if claude_code::ready() {
            ready.push("claude-code".to_string());
        }
        let antigravity_hooks = agents::list().iter().any(|a| a.id == "antigravity" && a.installed);
        if !platform::agy_candidates().is_empty() && antigravity_hooks {
            ready.push("antigravity-cli".to_string());
        }
        ready
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
fn secret_present(key: String) -> bool {
    secrets::present(&key)
}

#[tauri::command]
fn secret_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    // Bound to its server's address: only local_set_key may store it.
    if key == local_chat::CUSTOM_KEY {
        return Err("use local_set_key".into());
    }
    let before = (key == "github-token").then(|| secrets::get(&key));
    secrets::set(&key, &value)?;
    if key.starts_with("mail-") {
        mail::keys_changed();
    }
    // The live activities fetch the new calendar at once.
    if key == calendar::URL_KEY {
        let _ = app.emit_to(island::WINDOW_LABEL, "calendar-changed", ());
    }
    if let Some(before) = before {
        if secrets::get(&key) != before {
            integrations::github_token_changed(&app);
        }
    }
    Ok(())
}

#[tauri::command]
fn secret_clear(app: AppHandle, key: String) -> Result<(), String> {
    let had = key == "github-token" && secrets::present(&key);
    secrets::clear(&key)?;
    if had {
        integrations::github_token_changed(&app);
    }
    Ok(())
}

/// Opens the configured n8n instance — the URL lives in the Credential Manager.
#[tauri::command]
fn open_n8n() {
    if let Some(url) = secrets::get("n8n-url") {
        open_url(url);
    }
}

/// Refresh buttons in the integration cards.
#[tauri::command]
async fn refresh_integration(app: AppHandle, id: String) {
    integrations::poll_once(app, &id).await;
}

/// The GitHub card was opened: refetch its `section` ("pulse" or "activity")
/// if it is stale. The pollers still decline while the pill is off or paused.
#[tauri::command]
fn github_refresh(section: String) {
    integrations::github_refresh_if_stale(&section);
}

/// Lets the island write to the same log as the Rust side.
#[tauri::command]
fn log_line(message: String) {
    log::line(format!("ui  {message}"));
}

// ── Global shortcuts ──────────────────────────────────────────────────────────

/// How each global shortcut went: registered, taken by another app, and so on.
#[tauri::command]
fn shortcuts_status(app: AppHandle) -> shortcuts::Report {
    shortcuts::status(&app)
}

/// Settings is recording a new combination: let go of ours meanwhile, so the
/// keys reach the recorder instead of running an action. `false` takes them back.
#[tauri::command]
fn shortcuts_suspend(app: AppHandle, shared: State<Shared>, suspended: bool) {
    if suspended {
        shortcuts::suspend(&app);
    } else {
        let stored = shared.settings.lock().unwrap().shortcuts.clone();
        shortcuts::apply(&app, &stored);
    }
}

// ── Settings window ───────────────────────────────────────────────────────────

/// WebView2 allows exactly one browser environment per app, and its options are
/// fixed by whichever webview is created first. Every window must therefore ask
/// for the *same* arguments as the island (see `additionalBrowserArgs` in
/// tauri.conf.json) — a mismatch makes the second window come up blank, with no
/// error anywhere.
pub(crate) const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

/// In a dev build the pages are served by Vite, so the second window needs the
/// absolute dev URL; a bundled build resolves it inside the app bundle.
fn settings_page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/settings.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("settings.html".into())
}

/// The settings window is created hidden at launch and only ever shown and
/// hidden afterwards. A WebView2 window created later — on the main thread or
/// not — silently comes up blank in this app, so the window that works is the
/// one that exists before the island's webview does.
fn create_settings_window(app: &AppHandle) {
    let url = settings_page_url(app);
    match WebviewWindowBuilder::new(app, "settings", url)
        .additional_browser_args(BROWSER_ARGS)
        .title(i18n::t("Settings — Lumo"))
        // Room for the section list on the left and the section beside it.
        .inner_size(780.0, 680.0)
        .min_inner_size(600.0, 480.0)
        .resizable(true)
        .visible(false)
        .center()
        .build()
    {
        Ok(win) => {
            // Closing it must only hide it, or it could never be reopened.
            let hidden = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });
        }
        Err(err) => log::line(format!("settings window failed: {err}")),
    }
}

fn show_settings_window(app: &AppHandle) {
    let Some(win) = app.get_webview_window("settings") else {
        log::line("settings window missing");
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

#[tauri::command]
fn open_settings_window(app: AppHandle) {
    show_settings_window(&app);
}

/// The app identifier (tauri.conf.json): the keychain service, and the folder
/// of Lumo's data and of its WebView's.
pub const IDENTIFIER: &str = "com.rccrd12.lumo";

pub fn run() {
    // Before anything opens a folder or a WebView starts.
    migrate::folders();
    migrate::keys();
    platform::prepare_environment();
    let loaded = settings::load();
    i18n::set_picked(&loaded.language);
    let gate = Arc::new(PollGate::new());

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // `lumo --shortcut <action>`: what a desktop's own keyboard
            // settings run where we can't listen for keys ourselves (Wayland).
            match shortcuts::from_args(&argv) {
                Some(action) => shortcuts::dispatch(app, action),
                None => {
                    let _ = app.emit_to(island::WINDOW_LABEL, "tray", "open".to_string());
                }
            }
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_dialog::init());
    // Where no global shortcut can work, the plugin isn't even started.
    if platform::global_shortcuts_blocked().is_none() {
        builder = builder.plugin(shortcuts::plugin());
    }

    builder
        .manage(Shared {
            settings: Mutex::new(loaded.clone()),
            gate: gate.clone(),
        })
        .manage(Pending::default())
        .manage(Chat::default())
        .manage(shortcuts::Registry::default())
        .manage(recap::load())
        .invoke_handler(tauri::generate_handler![
            boot,
            save_settings,
            set_system_languages,
            set_collapsed,
            set_island_rect,
            focus_window,
            reposition,
            list_monitors,
            open_url,
            open_in_vscode,
            open_session,
            open_claude_desktop,
            open_file_in_vscode,
            quit_app,
            hooks_status,
            agent_hooks_status,
            hooks_preview,
            hooks_apply,
            agent_hooks_list,
            agent_hooks_preview,
            agent_hooks_apply,
            status_line_preview,
            status_line_apply,
            codex_plan_usage,
            plan_usage_fetch,
            approval_decision,
            approval_answer,
            approval_ack,
            approval_decline,
            log_line,
            chat_send,
            chat_models,
            chat_usage,
            local_connect,
            local_set_key,
            chat_reset,
            chat_restore,
            chat_stop,
            chat_rewind,
            island_drag,
            island_resize,
            island_reset_size,
            island_recenter,
            pick_file,
            screen_displays,
            screen_windows,
            screen_window_share,
            screen_window_shot,
            screen_tabs,
            screen_tab_share,
            screen_capture,
            screen_discard,
            screen_explorer_peek,
            screen_explorer,
            explorer_attach,
            live::live_token,
            live::live_read,
            live::live_find,
            live::live_document,
            live::live_open,
            live::live_open_app,
            live::live_help,
            live::live_help_stop,
            live::live_computer,
            live::live_computer_ready,
            live::live_microphone,
            typing::live_type,
            media::media_now,
            activities::activities_resize,
            activities::activities_show,
            activities::activities_prepare,
            activities::activities_drag,
            activities::activities_window_resize,
            activities::activities_focus,
            calendar::calendar_fetch,
            media::media_control,
            ingest_file,
            paste_file,
            paste_copied_file,
            clipboard_text,
            secret_present,
            chat_providers,
            secret_set,
            secret_clear,
            refresh_integration,
            github_refresh,
            open_n8n,
            open_settings_window,
            set_paused,
            shortcuts_status,
            shortcuts_suspend,
            recap::recap_history,
            recap::recap_prefs,
            recap::recap_set_enabled,
            recap::recap_set_hide_projects,
            recap::recap_mark_shown,
            recap::recap_clear,
            recap::recap_save_png,
            recap::recap_reveal_saved,
            updater::update_check,
            updater::update_install,
            desktop::desktop_mochi_info,
            desktop::desktop_mochi_pick_up,
            desktop::desktop_mochi_carry,
            desktop::desktop_mochi_carry_end,
            desktop::desktop_mochi_drag_begin,
            desktop::desktop_mochi_drag_move,
            desktop::desktop_mochi_drag_end,
            desktop::desktop_mochi_fly_out,
            desktop::desktop_mochi_fly_home,
            desktop::desktop_mochi_set_asleep,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tray::build(&handle)?;
            // Before the island: see create_settings_window.
            create_settings_window(&handle);
            // Same rule for Mochi's desktop window.
            desktop::setup(&handle);

            if let Some(win) = island::window(&handle) {
                // Where Tauri takes the drop itself (Linux), its paths are the
                // ones ingest_file may copy (files.rs).
                win.on_window_event(|event| {
                    if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                        files::allow_dropped(paths.iter().map(|p| p.to_string_lossy().to_string()));
                    }
                });
                platform::make_non_activating(&win);
                #[cfg(windows)]
                webview_drop::install(&handle);
                live::install(&handle);
                island::apply_geometry(&handle, &loaded.screen, island::Placement::of(&loaded), false);
                let _ = win.show();
            }
            gate.collapsed.store(false, Ordering::Relaxed);
            // Nothing drawn yet, so nothing takes the mouse until the page
            // reports the island's shape.
            if !platform::CURSOR_POLL {
                island::refresh_click_through(&handle, &gate);
            }
            gate.set_active(true);
            island::spawn_cursor_poll(handle.clone(), gate.clone());

            log::line(format!("--- Lumo {} started ---", env!("CARGO_PKG_VERSION")));
            hooks::ensure_hook_exe(&handle);
            // Closed while Claude used the computer: the system's own arrow again.
            computer::recover();
            computer::forget_antigravity(&claude_code::work_dir());
            autostart::refresh(&handle, loaded.autostart);
            pipe::start(handle.clone());
            integrations::start(handle.clone());
            shortcuts::apply(&handle, &loaded.shortcuts);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Lumo")
        .run(|_, event| {
            // Quit while Claude used the computer: the system's own arrow again.
            if let tauri::RunEvent::Exit = event {
                computer::recover();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::diff_file;

    #[test]
    fn only_an_existing_file_by_its_full_path_reaches_the_editor() {
        let dir = std::env::temp_dir().join(format!("lumo-diff-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("edited.ts");
        std::fs::write(&file, "x").unwrap();

        assert!(diff_file(&file.to_string_lossy()).is_some());
        // A folder, a missing file, a relative path or an option never pass.
        assert!(diff_file(&dir.to_string_lossy()).is_none());
        assert!(diff_file(&dir.join("missing.ts").to_string_lossy()).is_none());
        assert!(diff_file("edited.ts").is_none());
        assert!(diff_file("--help").is_none());
        assert!(diff_file("").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
