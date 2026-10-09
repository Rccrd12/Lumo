// "Open at login".
//
// The autostart plugin names its entry after the app (productName): the
// `HKCU\…\Run` value on Windows, `~/.config/autostart/<name>.desktop` on Linux.
// At every launch the entry left under the app's old name (migrate.rs) is
// removed, so the app never starts twice, and with autostart on the current
// entry is written again, so it points at this exe wherever it now lives.

use tauri::{AppHandle, Runtime};
use tauri_plugin_autostart::ManagerExt;

pub fn refresh<R: Runtime>(app: &AppHandle<R>, on: bool) {
    if app.package_info().name != crate::migrate::OLD_AUTOSTART {
        remove_legacy();
    }
    if on {
        if let Err(err) = app.autolaunch().enable() {
            crate::log::line(format!("autostart: {err}"));
        }
    }
}

/// Removes the entry under the old name, when there is one. Nothing else is touched.
fn remove_legacy() {
    let Ok(exe) = std::env::current_exe() else { return };
    // The path only matters to enable(); disable() goes by the name.
    let Ok(legacy) = auto_launch::AutoLaunchBuilder::new()
        .set_app_name(crate::migrate::OLD_AUTOSTART)
        .set_app_path(&exe.display().to_string())
        .build()
    else {
        return;
    };
    if legacy.is_enabled().unwrap_or(false) && legacy.disable().is_ok() {
        crate::log::line("autostart: removed the entry left under the old name");
    } else {
        // Present but turned off in Task Manager reads as not enabled: gone too.
        let _ = legacy.disable();
    }
}
