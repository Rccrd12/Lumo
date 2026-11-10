// What writes another program's settings (Claude Code's settings.json, the
// other agents' hooks, the status line) only ever does so after the user
// looked at its diff in Settings and clicked: CLAUDE.md's rule, held here in
// Rust as well as in the page.
//
// * Only the Settings window may ask for the diff that counts, and for the
//   write: the island's window, which shows what the AI writes, never can.
// * The diff is handed out with its fingerprint, and the write takes that
//   fingerprint once: a write needs a preview of its own, just before it.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The window Settings opens in (lib.rs open_settings).
pub const SETTINGS_WINDOW: &str = "settings";

/// How long a preview stays good for its write.
const VALID_FOR: Duration = Duration::from_secs(30 * 60);

/// Previews shown in Settings and not written yet: (what, fingerprint, when).
static SHOWN: Mutex<Vec<(String, String, Instant)>> = Mutex::new(Vec::new());

/// Refused unless the call comes from the Settings window.
pub fn from_settings(window: &str) -> Result<(), String> {
    if window == SETTINGS_WINDOW {
        Ok(())
    } else {
        Err(crate::i18n::t("Only Lumo's Settings can change this, after you look at the changes."))
    }
}

/// The preview of `what` (e.g. "hooks:install") with this fingerprint is on
/// screen in Settings: one write of it may follow.
pub fn shown(what: &str, fingerprint: &str) {
    let mut shown = SHOWN.lock().unwrap_or_else(|e| e.into_inner());
    shown.retain(|(w, _, at)| w != what && at.elapsed() < VALID_FOR);
    shown.push((what.to_string(), fingerprint.to_string(), Instant::now()));
}

/// The write of `what` with this fingerprint was shown in Settings just
/// before: it may go, once.
pub fn take(what: &str, fingerprint: &str) -> Result<(), String> {
    let mut shown = SHOWN.lock().unwrap_or_else(|e| e.into_inner());
    shown.retain(|(_, _, at)| at.elapsed() < VALID_FOR);
    match shown.iter().position(|(w, f, _)| w == what && f == fingerprint) {
        Some(i) => {
            shown.remove(i);
            Ok(())
        }
        None => Err(crate::i18n::t("Show the changes again in Settings before applying them.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_write_needs_the_settings_window_and_a_preview_of_its_own() {
        assert!(from_settings("island").is_err());
        assert!(from_settings("computer").is_err());
        assert!(from_settings(SETTINGS_WINDOW).is_ok());
        // Not shown: refused.
        assert!(take("test:install", "abc").is_err());
        shown("test:install", "abc");
        // Another fingerprint, or another write, is not this one.
        assert!(take("test:install", "abd").is_err());
        assert!(take("test:remove", "abc").is_err());
        assert!(take("test:install", "abc").is_ok());
        // Once.
        assert!(take("test:install", "abc").is_err());
        // A newer preview of the same write replaces the one before.
        shown("test:install", "one");
        shown("test:install", "two");
        assert!(take("test:install", "one").is_err());
        assert!(take("test:install", "two").is_ok());
    }
}
