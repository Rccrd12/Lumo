// What is playing, for the closed island's music line (src/core/compact.ts),
// and its three buttons: the system's media controls (the same ones the volume
// flyout shows). Nothing leaves the computer.
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

fn session() -> Option<windows::Media::Control::GlobalSystemMediaTransportControlsSession> {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager as Manager;
    let manager = Manager::RequestAsync().ok()?.get().ok()?;
    manager.GetCurrentSession().ok()
}

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

fn control(action: MediaAction) -> bool {
    let Some(session) = session() else { return false };
    let op = match action {
        MediaAction::Toggle => session.TryTogglePlayPauseAsync(),
        MediaAction::Next => session.TrySkipNextAsync(),
        MediaAction::Previous => session.TrySkipPreviousAsync(),
    };
    op.and_then(|op| op.get()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn players_get_a_readable_name() {
        assert_eq!(app_name("Spotify.exe"), "Spotify");
        assert_eq!(app_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "ZuneMusic");
        assert_eq!(app_name("308046B0AF4A39CB"), "");
        assert_eq!(app_name(r"C:\Program Files\VLC\vlc.exe"), "vlc");
    }
}
