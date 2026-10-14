// Y and N for a waiting permission, from anywhere.
//
// While a permission card (or the closed island's Deny / Allow) is on screen,
// the island asks for Y and N as global keys (`set_approval_keys`): a press
// answers the request even when the chat field has the keyboard or another
// app is in front. They go back the moment nothing waits any more, so they
// are never taken from other apps for longer than a card is showing. A press
// is handed to the island as an `approval-key` event ("allow" or "deny"); the
// island checks it against the request on screen, as it does a click.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

use crate::island::WINDOW_LABEL;

/// True while Y and N are Lumo's.
static HELD: AtomicBool = AtomicBool::new(false);

fn keys() -> [Shortcut; 2] {
    [Shortcut::new(None, Code::KeyY), Shortcut::new(None, Code::KeyN)]
}

/// The answer a global press gives, while Y and N are held: none for any other key.
pub fn decision(shortcut: &Shortcut) -> Option<&'static str> {
    if !HELD.load(Ordering::Relaxed) {
        return None;
    }
    key_decision(shortcut)
}

fn key_decision(shortcut: &Shortcut) -> Option<&'static str> {
    if shortcut.mods != Modifiers::empty() {
        return None;
    }
    match shortcut.key {
        Code::KeyY => Some("allow"),
        Code::KeyN => Some("deny"),
        _ => None,
    }
}

/// A global press of Y or N: to the island.
pub fn pressed<R: Runtime>(app: &AppHandle<R>, decision: &'static str) {
    let _ = app.emit_to(WINDOW_LABEL, "approval-key", decision);
}

/// Takes Y and N (`on`) or gives them back.
pub fn hold<R: Runtime>(app: &AppHandle<R>, on: bool) {
    if HELD.swap(on, Ordering::SeqCst) == on {
        return;
    }
    if on {
        register(app);
    } else {
        for key in keys() {
            let _ = app.global_shortcut().unregister(key);
        }
    }
}

fn register<R: Runtime>(app: &AppHandle<R>) {
    let gs = app.global_shortcut();
    for key in keys() {
        if gs.is_registered(key) {
            continue;
        }
        if let Err(err) = gs.register(key) {
            crate::log::line(format!("approval keys: {:?} not registered: {err}", key.key));
        }
    }
}

/// Every shortcut was just let go (shortcuts.rs): Y and N are taken again
/// while a request waits, or they would answer nothing until the next card.
pub fn keep<R: Runtime>(app: &AppHandle<R>) {
    if HELD.load(Ordering::SeqCst) {
        register(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn y_allows_and_n_denies() {
        assert_eq!(key_decision(&Shortcut::new(None, Code::KeyY)), Some("allow"));
        assert_eq!(key_decision(&Shortcut::new(None, Code::KeyN)), Some("deny"));
    }

    #[test]
    fn other_keys_and_modifiers_answer_nothing() {
        assert_eq!(key_decision(&Shortcut::new(None, Code::KeyA)), None);
        assert_eq!(key_decision(&Shortcut::new(Some(Modifiers::CONTROL), Code::KeyY)), None);
        assert_eq!(key_decision(&Shortcut::new(Some(Modifiers::SHIFT), Code::KeyN)), None);
    }
}
