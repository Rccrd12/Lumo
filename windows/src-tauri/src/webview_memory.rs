// Memory of a webview nobody is looking at.
//
// The Settings window, once made, is only ever shown and hidden afterwards
// (see create_settings_window in lib.rs), so it is not simply closed. What
// WebView2 offers instead is a memory target: at "low" it trims what a webview
// holds while it is hidden, and takes it back when it is shown.

use tauri::WebviewWindow;

/// Asks WebView2 to keep `win`'s webview small (`low`) or normal. Best effort:
/// an old WebView2 runtime without the setting, or a window that is not ready
/// yet, is left as it is.
pub fn set_low(win: &WebviewWindow, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use wv2_core::Interface;
    let label = win.label().to_string();
    let result = win.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        // An old WebView2 runtime: nothing to ask.
        let Ok(core) = core.cast::<ICoreWebView2_19>() else { return };
        let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
        if let Err(err) = core.SetMemoryUsageTargetLevel(level) {
            crate::log::line(format!("webview memory {label}: {err}"));
        }
    });
    if let Err(err) = result {
        crate::log::line(format!("webview memory: {err}"));
    }
}
