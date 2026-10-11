// Notification-area icon. A left click hides the island into its edge or
// brings it back (Windows; on Linux the menu is all a tray icon offers); the
// right click opens the menu: Open, Recenter the island, Weekly recap,
// Wardrobe, Settings, Pause (Resume while paused), Quit.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::i18n::{n_, t};
use crate::island::WINDOW_LABEL;

/// The menu's items, id and English label, in order. The labels are shown in
/// the interface language (i18n.rs) and follow it when it changes.
const ITEMS: [(&str, &str); 7] = [
    ("open", n_("Open Lumo")),
    ("recenter", n_("Put the island back in the centre")),
    ("recap", n_("Weekly recap")),
    ("wardrobe", n_("Wardrobe…")),
    ("settings", n_("Settings…")),
    ("pause", n_("Pause")),
    ("quit", n_("Quit")),
];

/// Pause's label while Lumo is paused.
const RESUME: &str = n_("Resume");

/// Lumo is paused (the island tells, set_paused): Pause reads Resume.
static PAUSED: AtomicBool = AtomicBool::new(false);

/// Kept so a language change relabels the menu without rebuilding the tray.
struct Items(Vec<(&'static str, MenuItem<Wry>)>);

/// What an item says now, in the current language.
fn label_of(label: &'static str) -> String {
    if label == ITEMS[5].1 && PAUSED.load(Ordering::Relaxed) {
        t(RESUME)
    } else {
        t(label)
    }
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let mut items = Vec::new();
    for (id, label) in ITEMS {
        items.push((label, MenuItem::with_id(app, id, t(label), true, None::<&str>)?));
    }
    let [open, recenter, recap, wardrobe, settings, pause, quit] = [0, 1, 2, 3, 4, 5, 6].map(|i| &items[i].1);
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[open, recenter, recap, &sep1, wardrobe, settings, pause, &sep2, quit])?;
    app.manage(Items(items));

    let mut builder = TrayIconBuilder::with_id("lumo")
        .tooltip("Lumo")
        .menu(&menu)
        // The left click is the island's own: hide it or bring it back.
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                let _ = tray.app_handle().emit_to(WINDOW_LABEL, "tray", "toggle".to_string());
            }
        })
        .on_menu_event(|app: &AppHandle, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "recenter" => crate::recenter_island(app),
            id => {
                let _ = app.emit_to(WINDOW_LABEL, "tray", id.to_string());
            }
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    builder.build(app)?;
    Ok(())
}

/// Relabels the menu in the current language.
pub fn retitle(app: &AppHandle) {
    let Some(items) = app.try_state::<Items>() else { return };
    for (label, item) in &items.0 {
        let _ = item.set_text(label_of(label));
    }
}

/// Lumo was paused or resumed: Pause reads Resume while paused.
pub fn set_paused(app: &AppHandle, paused: bool) {
    PAUSED.store(paused, Ordering::Relaxed);
    retitle(app);
}
