// "Open at login", kept right across the rename.
//
// The autostart plugin names its entry after the app (productName): the
// `HKCU\…\Run` value on Windows, `~/.config/autostart/<name>.desktop` on Linux.
// Up to 0.3.0 the app was called Coucou, so an upgraded install may still have
// a "Coucou" entry, pointing at the old exe (the per-user installer put it in
// %LOCALAPPDATA%\Coucou, the new one in %LOCALAPPDATA%\Lumo). At every launch:
// the entry under the old name is removed, so the app never starts twice, and
// with autostart on the current entry is written again, so it points at this
// exe wherever it now lives.

use tauri::{AppHandle, Runtime};
use tauri_plugin_autostart::ManagerExt;

/// The name the entry had before the rename.
const LEGACY_NAME: &str = "Coucou";

pub fn refresh<R: Runtime>(app: &AppHandle<R>, on: bool) {
    if app.package_info().name != LEGACY_NAME {
        remove_legacy();
    }
    if on {
        if let Err(err) = app.autolaunch().enable() {
            crate::log::line(format!("autostart: {err}"));
        }
    }
}

/// Removes the "Coucou" entry, when there is one. Nothing else is touched.
fn remove_legacy() {
    let Ok(exe) = std::env::current_exe() else { return };
    // The path only matters to enable(); disable() goes by the name.
    let Ok(legacy) = auto_launch::AutoLaunchBuilder::new()
        .set_app_name(LEGACY_NAME)
        .set_app_path(&exe.display().to_string())
        .build()
    else {
        return;
    };
    if legacy.is_enabled().unwrap_or(false) && legacy.disable().is_ok() {
        crate::log::line("autostart: removed the entry left under the old name (Coucou)");
    } else {
        // Present but turned off in Task Manager reads as not enabled: gone too.
        let _ = legacy.disable();
    }
}
