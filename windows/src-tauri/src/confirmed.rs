// What writes another program's settings (Claude Code's settings.json, the
// other agents' hooks, the status line) only ever does so after the user
// looked at its diff in Settings and clicked: CLAUDE.md's rule, held here in
// Rust as well as in the page.
//
// * Only Settings may ask for the diff that counts, and for the write: the
//   Settings window, or Settings inside the island. The island's page also
//   shows what the AI writes, and the Settings in it reach Rust through that
//   page, so Rust can't tell one from the other: a write asked from there goes
//   only once the user said Yes in Windows' own box, which no page can click.
//   Any other window never can.
// * The diff is handed out with its fingerprint, and the write takes that
//   fingerprint once: a write needs a preview of its own, just before it.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Runtime};

use crate::i18n::t;

/// The window Settings opens in (lib.rs open_settings).
pub const SETTINGS_WINDOW: &str = "settings";

/// What a write turned down in Windows' box answers: Settings say nothing of it
/// (settings/parts.ts cancelledByHand).
pub const CANCELLED: &str = "cancelled";

/// How long a preview stays good for its write.
const VALID_FOR: Duration = Duration::from_secs(30 * 60);

/// Previews shown in Settings and not written yet: (what, fingerprint, when).
static SHOWN: Mutex<Vec<(String, String, Instant)>> = Mutex::new(Vec::new());

/// Who says yes to a write asked by a window.
#[derive(Debug, PartialEq, Eq)]
pub enum Confirm {
    /// The Settings window: its own click on the diff.
    Click,
    /// Settings inside the island: the click, then Windows' own Yes / No box.
    ByHand,
    /// Any other window: never.
    Refused,
}

pub fn confirm_for(window: &str) -> Confirm {
    match window {
        SETTINGS_WINDOW => Confirm::Click,
        crate::island::WINDOW_LABEL => Confirm::ByHand,
        _ => Confirm::Refused,
    }
}

/// A preview asked by `window` is one its write may take.
pub fn may_show(window: &str) -> bool {
    confirm_for(window) != Confirm::Refused
}

/// The preview of `what` (e.g. "hooks:install") with this fingerprint is on
/// screen in Settings: one write of it may follow.
pub fn shown(what: &str, fingerprint: &str) {
    let mut shown = SHOWN.lock().unwrap_or_else(|e| e.into_inner());
    shown.retain(|(w, _, at)| w != what && at.elapsed() < VALID_FOR);
    shown.push((what.to_string(), fingerprint.to_string(), Instant::now()));
}

fn is_shown(what: &str, fingerprint: &str) -> bool {
    let shown = SHOWN.lock().unwrap_or_else(|e| e.into_inner());
    shown.iter().any(|(w, f, at)| w == what && f == fingerprint && at.elapsed() < VALID_FOR)
}

fn show_again() -> String {
    t("Show the changes again in Settings before applying them.")
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
        None => Err(show_again()),
    }
}

/// What Windows' box says of a write: what it does (`title`: "Install Lumo's
/// hooks in Claude Code?") and the files it writes (`files`, whole paths).
pub struct Asked {
    pub title: String,
    pub files: Vec<String>,
}

/// The box's text under its title: the files, and the backup.
fn box_text(files: &[String]) -> String {
    let mut text = t("Lumo writes these files, after a backup of each:");
    for file in files {
        text.push('\n');
        text.push_str(file);
    }
    text
}

/// The write of `what`, asked by `window`, may go: the preview with this
/// fingerprint was shown, and from Settings inside the island the user said
/// Yes to it in Windows' own box. Turned down there: CANCELLED.
/// Blocks while the box is up (run it off the main thread).
pub fn by_hand<R: Runtime>(app: &AppHandle<R>, window: &str, what: &str, fingerprint: &str, asked: &Asked) -> Result<(), String> {
    match confirm_for(window) {
        Confirm::Refused => return Err(t("Only Lumo's Settings can change this, after you look at the changes.")),
        Confirm::Click => {}
        Confirm::ByHand => {
            // A stale preview is said at once, not after a Yes.
            if !is_shown(what, fingerprint) {
                return Err(show_again());
            }
            // Over the island, which is always on top.
            let island = app.get_webview_window(crate::island::WINDOW_LABEL);
            crate::log::line(format!("settings write {what}: Windows' box asks"));
            let yes = ask_windows(island.as_ref(), &asked.title, &box_text(&asked.files));
            crate::log::line(format!("settings write {what}: {}", if yes { "yes" } else { "cancelled" }));
            if !yes {
                return Err(CANCELLED.into());
            }
        }
    }
    take(what, fingerprint)
}

/// How long Windows' box keeps its Yes greyed out: a click or an Enter meant
/// for what was there before it came up never says Yes.
#[cfg(windows)]
const YES_AFTER_MS: usize = 1000;

/// Windows' own Yes / No box (a task dialog), which no page can click: the
/// question as its title, `text` under it, "Back up and write" and "Cancel".
/// Cancel is the default button (Enter, Space), and "Back up and write" works
/// only after YES_AFTER_MS. True only for "Back up and write"; Cancel, Esc,
/// the box closed, or a box Windows couldn't show are all a No.
#[cfg(windows)]
fn ask_windows<R: Runtime>(parent: Option<&tauri::WebviewWindow<R>>, title: &str, text: &str) -> bool {
    use windows::core::{HRESULT, PCWSTR};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Controls::{
        TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOGCONFIG_0, TASKDIALOG_BUTTON, TASKDIALOG_NOTIFICATIONS,
        TDF_ALLOW_DIALOG_CANCELLATION, TDF_CALLBACK_TIMER, TDF_SIZE_TO_CONTENT, TDM_ENABLE_BUTTON, TDN_CREATED, TDN_TIMER,
        TD_WARNING_ICON,
    };
    use windows::Win32::UI::WindowsAndMessaging::SendMessageW;

    const ID_WRITE: i32 = 1000;
    const ID_CANCEL: i32 = 1001;

    unsafe extern "system" fn callback(hwnd: HWND, msg: TASKDIALOG_NOTIFICATIONS, wparam: WPARAM, _: LPARAM, _: isize) -> HRESULT {
        // TDN_TIMER's wparam: the milliseconds since the box came up.
        let enable = match msg {
            TDN_CREATED => Some(false),
            TDN_TIMER if wparam.0 >= YES_AFTER_MS => Some(true),
            _ => None,
        };
        if let Some(on) = enable {
            let _: LRESULT = unsafe { SendMessageW(hwnd, TDM_ENABLE_BUTTON.0 as u32, Some(WPARAM(ID_WRITE as usize)), Some(LPARAM(on as isize))) };
        }
        HRESULT(0)
    }

    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (caption, title, text) = (wide("Lumo"), wide(title), wide(text));
    let (write, cancel) = (wide(&t("Back up and write")), wide(&t("Cancel")));
    let buttons = [
        TASKDIALOG_BUTTON { nButtonID: ID_WRITE, pszButtonText: PCWSTR(write.as_ptr()) },
        TASKDIALOG_BUTTON { nButtonID: ID_CANCEL, pszButtonText: PCWSTR(cancel.as_ptr()) },
    ];
    let owner = parent.and_then(|w| w.hwnd().ok()).map(|h| HWND(h.0 as _)).unwrap_or_default();
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: owner,
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_SIZE_TO_CONTENT | TDF_CALLBACK_TIMER,
        pszWindowTitle: PCWSTR(caption.as_ptr()),
        Anonymous1: TASKDIALOGCONFIG_0 { pszMainIcon: TD_WARNING_ICON },
        pszMainInstruction: PCWSTR(title.as_ptr()),
        pszContent: PCWSTR(text.as_ptr()),
        cButtons: buttons.len() as u32,
        pButtons: buttons.as_ptr(),
        nDefaultButton: ID_CANCEL,
        pfCallback: Some(callback),
        ..Default::default()
    };
    let mut pressed = 0i32;
    let shown = unsafe { TaskDialogIndirect(&config, Some(&mut pressed), None, None) };
    if let Err(e) = shown {
        crate::log::line(format!("settings write: Windows' box could not be shown: {e}"));
        return false;
    }
    pressed == ID_WRITE
}

/// Off Windows (the tests' builds): no box to ask in, so never a Yes.
#[cfg(not(windows))]
fn ask_windows<R: Runtime>(_: Option<&tauri::WebviewWindow<R>>, _: &str, _: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_write_needs_settings_and_from_the_island_windows_own_yes() {
        assert_eq!(confirm_for(SETTINGS_WINDOW), Confirm::Click);
        // Settings inside the island reach Rust as the island: Windows' box decides.
        assert_eq!(confirm_for(crate::island::WINDOW_LABEL), Confirm::ByHand);
        for other in ["computer", "main", "", "Settings"] {
            assert_eq!(confirm_for(other), Confirm::Refused, "{other:?}");
            assert!(!may_show(other));
        }
        assert!(may_show(SETTINGS_WINDOW) && may_show(crate::island::WINDOW_LABEL));
        // Looking at a preview leaves it for its write.
        shown("test:look", "f");
        assert!(is_shown("test:look", "f") && is_shown("test:look", "f"));
        assert!(!is_shown("test:look", "g"));
        assert!(take("test:look", "f").is_ok());
        assert!(!is_shown("test:look", "f"));
    }

    #[test]
    fn the_box_names_every_file_it_writes() {
        let text = box_text(&["C:\\Users\\me\\.claude\\settings.json".into(), "C:\\Users\\me\\.codex\\hooks.json".into()]);
        assert!(text.contains("\nC:\\Users\\me\\.claude\\settings.json\nC:\\Users\\me\\.codex\\hooks.json"), "{text}");
    }

    #[test]
    fn a_write_needs_a_preview_of_its_own() {
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
