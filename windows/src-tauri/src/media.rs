// What is playing, for the closed island's music line (src/core/compact.ts),
// and its three buttons. Windows: the system's media controls (the same ones
// the volume flyout shows). Linux: MPRIS over D-Bus, which every player
// speaks. Nothing leaves the computer.
//
// The island asks only while it is on screen, every few seconds: a hidden
// island asks nothing, so it still costs nothing.

use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone, Default, Debug, PartialEq)]
pub struct NowPlaying {
    pub title: String,
    pub artist: String,
    /// The player, as the system names it ("Spotify.exe", "spotify").
    pub app: String,
    pub playing: bool,
}

#[derive(Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub enum MediaAction {
    Toggle,
    Next,
    Previous,
}

/// "Spotify.exe", "308046B0AF4A39CB" or "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"
/// as a name to show: the part before the `!` or `_`, without `.exe`.
pub fn app_name(id: &str) -> String {
    // MPRIS: "org.mpris.MediaPlayer2.firefox.instance_1_42" → "firefox".
    if let Some(rest) = id.strip_prefix("org.mpris.MediaPlayer2.") {
        return rest.split('.').next().unwrap_or(rest).to_string();
    }
    let id = id.split('!').next().unwrap_or(id);
    let id = id.rsplit(['\\', '/']).next().unwrap_or(id);
    let id = id.strip_suffix(".exe").or_else(|| id.strip_suffix(".EXE")).unwrap_or(id);
    let id = id.split('_').next().unwrap_or(id);
    // "Microsoft.ZuneMusic" → "ZuneMusic".
    let last = id.rsplit('.').next().unwrap_or(id);
    // A bare hash says nothing.
    if last.len() >= 12 && last.chars().all(|c| c.is_ascii_hexdigit()) {
        return String::new();
    }
    last.to_string()
}

#[tauri::command]
pub async fn media_now() -> Option<NowPlaying> {
    tauri::async_runtime::spawn_blocking(now_playing).await.ok().flatten()
}

#[tauri::command]
pub async fn media_control(action: MediaAction) -> bool {
    tauri::async_runtime::spawn_blocking(move || control(action)).await.unwrap_or(false)
}

// ── Windows ───────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn session() -> Option<windows::Media::Control::GlobalSystemMediaTransportControlsSession> {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager as Manager;
    let manager = Manager::RequestAsync().ok()?.get().ok()?;
    manager.GetCurrentSession().ok()
}

#[cfg(windows)]
fn now_playing() -> Option<NowPlaying> {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status;
    let session = session()?;
    let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let title = props.Title().map(|s| s.to_string()).unwrap_or_default();
    let artist = props.Artist().map(|s| s.to_string()).unwrap_or_default();
    if title.trim().is_empty() && artist.trim().is_empty() {
        return None;
    }
    let playing = session
        .GetPlaybackInfo()
        .and_then(|info| info.PlaybackStatus())
        .map(|s| s == Status::Playing)
        .unwrap_or(false);
    let app = session.SourceAppUserModelId().map(|s| app_name(&s.to_string())).unwrap_or_default();
    Some(NowPlaying { title, artist, app, playing })
}

#[cfg(windows)]
fn control(action: MediaAction) -> bool {
    let Some(session) = session() else { return false };
    let op = match action {
        MediaAction::Toggle => session.TryTogglePlayPauseAsync(),
        MediaAction::Next => session.TrySkipNextAsync(),
        MediaAction::Previous => session.TrySkipPreviousAsync(),
    };
    op.and_then(|op| op.get()).unwrap_or(false)
}

// ── Linux ─────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
mod mpris {
    use std::time::Duration;

    use dbus::arg::{prop_cast, PropMap};
    use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;
    use dbus::blocking::Connection;

    const PREFIX: &str = "org.mpris.MediaPlayer2.";
    const PLAYER: &str = "org.mpris.MediaPlayer2.Player";
    const PATH: &str = "/org/mpris/MediaPlayer2";
    const TIMEOUT: Duration = Duration::from_millis(400);

    pub struct Player {
        pub name: String,
        pub status: String,
        pub title: String,
        pub artist: String,
    }

    /// Every player on the session bus, the playing ones first.
    pub fn players(conn: &Connection) -> Vec<Player> {
        let bus = conn.with_proxy("org.freedesktop.DBus", "/org/freedesktop/DBus", TIMEOUT);
        let names: Vec<String> = bus
            .method_call("org.freedesktop.DBus", "ListNames", ())
            .map(|(names,): (Vec<String>,)| names)
            .unwrap_or_default();
        let mut found: Vec<Player> = names
            .into_iter()
            .filter(|n| n.starts_with(PREFIX))
            .filter_map(|name| {
                let proxy = conn.with_proxy(name.as_str(), PATH, TIMEOUT);
                let status: String = proxy.get(PLAYER, "PlaybackStatus").ok()?;
                let meta: PropMap = proxy.get(PLAYER, "Metadata").unwrap_or_default();
                let title = prop_cast::<String>(&meta, "xesam:title").cloned().unwrap_or_default();
                let artist = prop_cast::<Vec<String>>(&meta, "xesam:artist")
                    .map(|a| a.join(", "))
                    .unwrap_or_default();
                Some(Player { name, status, title, artist })
            })
            .collect();
        found.sort_by_key(|p| match p.status.as_str() {
            "Playing" => 0,
            "Paused" => 1,
            _ => 2,
        });
        found
    }

    pub fn call(conn: &Connection, name: &str, method: &str) -> bool {
        conn.with_proxy(name, PATH, TIMEOUT).method_call::<(), _, _, _>(PLAYER, method, ()).is_ok()
    }
}

#[cfg(target_os = "linux")]
fn now_playing() -> Option<NowPlaying> {
    let conn = dbus::blocking::Connection::new_session().ok()?;
    let player = mpris::players(&conn).into_iter().find(|p| p.status != "Stopped")?;
    if player.title.trim().is_empty() && player.artist.trim().is_empty() {
        return None;
    }
    Some(NowPlaying {
        title: player.title,
        artist: player.artist,
        app: app_name(&player.name),
        playing: player.status == "Playing",
    })
}

#[cfg(target_os = "linux")]
fn control(action: MediaAction) -> bool {
    let Ok(conn) = dbus::blocking::Connection::new_session() else { return false };
    let Some(player) = mpris::players(&conn).into_iter().find(|p| p.status != "Stopped") else {
        return false;
    };
    let method = match action {
        MediaAction::Toggle => "PlayPause",
        MediaAction::Next => "Next",
        MediaAction::Previous => "Previous",
    };
    mpris::call(&conn, &player.name, method)
}

#[cfg(not(any(windows, target_os = "linux")))]
fn now_playing() -> Option<NowPlaying> {
    None
}

#[cfg(not(any(windows, target_os = "linux")))]
fn control(_action: MediaAction) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn players_get_a_readable_name() {
        assert_eq!(app_name("Spotify.exe"), "Spotify");
        assert_eq!(app_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "ZuneMusic");
        assert_eq!(app_name("org.mpris.MediaPlayer2.spotify"), "spotify");
        assert_eq!(app_name("org.mpris.MediaPlayer2.firefox.instance_1_42"), "firefox");
        assert_eq!(app_name("308046B0AF4A39CB"), "");
        assert_eq!(app_name(r"C:\Program Files\VLC\vlc.exe"), "vlc");
    }
}
