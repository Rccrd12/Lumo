// Gemini Live's read_notifications: the notifications Windows is keeping in
// its notification centre (a message, a reminder, a download done), with the
// app that sent each one and when. Read once, when the model calls the tool
// during a call; nothing is kept and nothing is dismissed.
//
// Windows: UserNotificationListener. The first time, Windows asks the user
// whether Lumo may read their notifications (Settings → Privacy & security →
// Notifications); until they allow it, the tool says so.

use serde::Serialize;

/// The newest first, at most this many.
pub const MAX: usize = 20;
/// Characters of one notification's text.
pub const MAX_TEXT: usize = 400;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub app: String,
    pub text: String,
    /// Unix seconds.
    pub at: i64,
}

/// A notification's lines (title, then body) as one text, capped.
pub fn joined(lines: &[String]) -> String {
    let text = lines.iter().map(|l| l.trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" — ");
    if text.chars().count() <= MAX_TEXT {
        return text;
    }
    let mut cut: String = text.chars().take(MAX_TEXT).collect();
    cut.push('…');
    cut
}

/// Windows' 100 ns ticks since 1601 as Unix seconds.
pub fn unix_seconds(ticks: i64) -> i64 {
    ticks / 10_000_000 - 11_644_473_600
}

pub fn read() -> Result<Vec<Notification>, String> {
    let mut list = imp::read()?;
    list.sort_by_key(|r| std::cmp::Reverse(r.at));
    list.truncate(MAX);
    Ok(list)
}

mod imp {
    use super::*;

    use ::windows::UI::Notifications::Management::{UserNotificationListener, UserNotificationListenerAccessStatus};
    use ::windows::UI::Notifications::{KnownNotificationBindings, NotificationKinds};

    fn refused() -> String {
        "Windows doesn't let Lumo read the notifications: the user can allow it in Settings → Privacy & security → Notifications.".into()
    }

    pub fn read() -> Result<Vec<Notification>, String> {
        let listener = UserNotificationListener::Current().map_err(|_| "This version of Windows doesn't let apps read notifications.".to_string())?;
        let status = match listener.GetAccessStatus() {
            Ok(UserNotificationListenerAccessStatus::Allowed) => UserNotificationListenerAccessStatus::Allowed,
            _ => listener.RequestAccessAsync().and_then(|op| op.get()).map_err(|_| refused())?,
        };
        if status != UserNotificationListenerAccessStatus::Allowed {
            return Err(refused());
        }
        let all = listener.GetNotificationsAsync(NotificationKinds::Toast).and_then(|op| op.get()).map_err(|e| e.message())?;
        let generic = KnownNotificationBindings::ToastGeneric().map_err(|e| e.message())?;
        let mut out = Vec::new();
        for n in all {
            let app = n
                .AppInfo()
                .and_then(|a| a.DisplayInfo())
                .and_then(|d| d.DisplayName())
                .map(|s| s.to_string())
                .unwrap_or_default();
            let at = n.CreationTime().map(|t| unix_seconds(t.UniversalTime)).unwrap_or(0);
            let lines: Vec<String> = n
                .Notification()
                .and_then(|x| x.Visual())
                .and_then(|v| v.GetBinding(&generic))
                .and_then(|b| b.GetTextElements())
                .map(|texts| texts.into_iter().filter_map(|t| t.Text().ok()).map(|s| s.to_string()).collect())
                .unwrap_or_default();
            let text = joined(&lines);
            if !text.is_empty() {
                out.push(Notification { app, text, at });
            }
        }
        Ok(out)
    }
}

/// Gemini Live's read_notifications.
#[tauri::command]
pub async fn pc_notifications() -> Result<Vec<Notification>, String> {
    tauri::async_runtime::spawn_blocking(read).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lines_are_one_text_without_empty_ones() {
        assert_eq!(joined(&["Marco".into(), " ".into(), "Ci vediamo alle 8?".into()]), "Marco — Ci vediamo alle 8?");
        let long = joined(&["x".repeat(MAX_TEXT + 10)]);
        assert_eq!(long.chars().count(), MAX_TEXT + 1);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn windows_time_reads_as_unix_time() {
        // 2026-01-01T00:00:00Z.
        assert_eq!(unix_seconds(134_116_992_000_000_000), 1_767_225_600);
    }
}
