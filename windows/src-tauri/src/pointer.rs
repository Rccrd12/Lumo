// Gemini Live's point_at: an animated pointer on the user's screen, at the
// spot the model picked in its last screenshot, with a few words next to it —
// "click here" without moving the user's own mouse.
//
// It is a small transparent window of its own (pointer.html), made the first
// time the model points during a call and gone when the call ends. It never
// takes the mouse or the keyboard: clicks go through it to what is under it,
// and the text box the user is typing in keeps the focus. It shows for a few
// seconds, then fades. The page's animations are finite, so nothing is drawn
// once it has faded; screenshots leave it out (screen::capture_unseen).
//
// As with the desktop Mochi (desktop.rs), Windows never shows or hides the
// window, which could take the focus: it is made visible off-screen and only
// moved.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::platform;

pub const LABEL: &str = "pointer";

/// The window, in logical pixels; the pointer's tip is at its centre, so its
/// label fits on any side of it (pointer.css keeps the label narrower than half).
const W: f64 = 480.0;
const H: f64 = 220.0;
/// How long it shows, then how long it takes to fade.
const SHOW: Duration = Duration::from_secs(9);
const FADE: Duration = Duration::from_millis(450);

const PARK: bool = cfg!(windows);
const PARKED: (i32, i32) = (-32000, -32000);

/// What the page draws: `seq` tells a new pointing from one already shown.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pointing {
    pub seq: u64,
    pub label: String,
    /// The label goes to the left of the pointer (near the right edge), or above it (near the bottom).
    pub flip_x: bool,
    pub flip_y: bool,
}

/// Bumped by every pointing and every hide: a timer of an older one does nothing.
static SEQ: AtomicU64 = AtomicU64::new(0);
/// What shows now, for a page that loads after it was asked for.
static CURRENT: Mutex<Option<Pointing>> = Mutex::new(None);

/// The display (left, top, width, height) holding physical point `p`, and how
/// far across and down it `p` is (0…1); None when `p` is on none of them.
pub fn display_of(displays: &[(i32, i32, u32, u32)], p: (i32, i32)) -> Option<((i32, i32, u32, u32), (f64, f64))> {
    let d = *displays.iter().find(|d| p.0 >= d.0 && p.0 < d.0 + d.2 as i32 && p.1 >= d.1 && p.1 < d.1 + d.3 as i32)?;
    Some((d, ((p.0 - d.0) as f64 / d.2 as f64, (p.1 - d.1) as f64 / d.3 as f64)))
}

/// Where the window goes for its centre (the pointer's tip) to be at `tip`.
pub fn origin(tip: (i32, i32), size: (u32, u32)) -> (i32, i32) {
    (tip.0 - (size.0 / 2) as i32, tip.1 - (size.1 / 2) as i32)
}

/// The label, one short line.
pub fn tidy_label(label: &str) -> String {
    let line = label.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= 32 {
        return line;
    }
    let cut: String = line.chars().take(31).collect();
    format!("{}…", cut.trim_end())
}

fn page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/pointer.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("pointer.html".into())
}

fn create(app: &AppHandle) -> Result<WebviewWindow, String> {
    let mut builder = WebviewWindowBuilder::new(app, LABEL, page_url(app))
        .additional_browser_args(crate::BROWSER_ARGS)
        .title("Lumo")
        .inner_size(W, H)
        .resizable(cfg!(target_os = "linux"))
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .focused(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .disable_drag_drop_handler()
        .focusable(false)
        .visible(PARK);
    if PARK {
        builder = builder.position(PARKED.0 as f64, PARKED.1 as f64);
    }
    let win = builder.build().map_err(|e| {
        crate::log::line(format!("pointer window failed: {e}"));
        "The pointer couldn't be shown.".to_string()
    })?;
    platform::make_non_activating(&win);
    let _ = win.set_ignore_cursor_events(true);
    Ok(win)
}

/// The scale of the display at physical point `p`.
fn scale_at(app: &AppHandle, p: (i32, i32)) -> f64 {
    app.available_monitors()
        .ok()
        .and_then(|list| {
            list.into_iter().find(|m| {
                let (pos, size) = (m.position(), m.size());
                p.0 >= pos.x && p.0 < pos.x + size.width as i32 && p.1 >= pos.y && p.1 < pos.y + size.height as i32
            })
        })
        .map(|m| m.scale_factor())
        .unwrap_or(1.0)
}

/// Puts the window's centre on `tip` and checks it is there. Moving onto a
/// display of another scale makes Windows resize (and may move) the window
/// on its own: the centre is worked out again from the size it then has,
/// until the window stays where it was put.
fn place(win: &WebviewWindow, tip: (i32, i32), scale: f64) -> String {
    let want = PhysicalSize::new((W * scale).round() as u32, (H * scale).round() as u32);
    let _ = win.set_size(want);
    let mut report = String::new();
    for attempt in 0..4 {
        let size = win.outer_size().map(|s| (s.width, s.height)).unwrap_or((want.width, want.height));
        let at = origin(tip, size);
        let _ = win.set_position(PhysicalPosition::new(at.0, at.1));
        std::thread::sleep(Duration::from_millis(40));
        let now = win.outer_position().map(|p| (p.x, p.y)).ok();
        let size_now = win.outer_size().map(|s| (s.width, s.height)).ok();
        report = format!("window at {now:?} size {size_now:?} (wanted {at:?}, attempt {})", attempt + 1);
        if now == Some(at) && size_now == Some(size) {
            break;
        }
    }
    report
}

/// Points at `tip` (physical desktop pixels), with `label` next to the
/// pointer, for a few seconds. Blocking only briefly; the window is made the
/// first time (off the main thread: the caller is an async command).
pub fn point(app: &AppHandle, tip: (i32, i32), label: &str) -> Result<(), String> {
    let Some((display, (x, y))) = display_of(&crate::screen::display_rects(), tip) else {
        crate::log::line(format!("point: {tip:?} is on no display"));
        return Err("That point is off the screen.".into());
    };
    let scale = scale_at(app, tip);
    let win = match app.get_webview_window(LABEL) {
        Some(win) => win,
        None => create(app)?,
    };
    let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let pointing = Pointing {
        seq,
        label: tidy_label(label),
        flip_x: x > 0.72,
        flip_y: y > 0.8,
    };
    *CURRENT.lock().unwrap_or_else(|e| e.into_inner()) = Some(pointing.clone());
    let placed = place(&win, tip, scale);
    if !PARK {
        let _ = win.show();
    }
    let _ = win.set_always_on_top(true);
    let _ = app.emit_to(LABEL, "pointer-show", &pointing);
    crate::log::line(format!("point: tip {tip:?} on display {display:?} at scale {scale}; {placed}"));
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SHOW);
        if SEQ.load(Ordering::SeqCst) == seq {
            hide(&app);
        }
    });
    Ok(())
}

/// The pointer fades, then its window goes out of sight.
pub fn hide(app: &AppHandle) {
    let seq = SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    if CURRENT.lock().unwrap_or_else(|e| e.into_inner()).take().is_none() {
        return;
    }
    let _ = app.emit_to(LABEL, "pointer-hide", ());
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FADE);
        if SEQ.load(Ordering::SeqCst) != seq {
            return; // pointing again meanwhile
        }
        let Some(win) = app.get_webview_window(LABEL) else { return };
        if PARK {
            let _ = win.set_position(PhysicalPosition::new(PARKED.0, PARKED.1));
        } else {
            let _ = win.hide();
        }
    });
}

/// The call ended: the pointer and its window go.
pub fn close(app: &AppHandle) {
    SEQ.fetch_add(1, Ordering::SeqCst);
    CURRENT.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.destroy();
    }
}

// ── Commands ──────────────────────────────────────────────────────────────────
// Pointing itself is live.rs's live_point: it finds the spot first.

#[tauri::command]
pub async fn live_point_hide(app: AppHandle) {
    close(&app);
}

/// What the pointer page should show now (it may load after it was asked for).
#[tauri::command]
pub fn live_pointer_current() -> Option<Pointing> {
    CURRENT.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_point_is_found_on_its_display_wherever_the_displays_are() {
        // The main display, and a second one on its left at another size.
        let displays = [(0, 0, 1920, 1080), (-2560, -200, 2560, 1440)];
        assert_eq!(display_of(&displays, (960, 270)), Some((displays[0], (0.5, 0.25))));
        assert_eq!(display_of(&displays, (-1280, 520)), Some((displays[1], (0.5, 0.5))));
        assert_eq!(display_of(&displays, (5000, 10)), None);
        // The window's centre is the tip, whatever size the window has.
        assert_eq!(origin((960, 270), (720, 330)), (600, 105));
        assert_eq!(origin((-1280, 520), (480, 220)), (-1520, 410));
    }

    #[test]
    fn the_label_is_one_short_line() {
        assert_eq!(tidy_label("  Clicca\nqui  "), "Clicca qui");
        let long = tidy_label(&"parola ".repeat(20));
        assert_eq!(long.chars().count(), 32);
        assert!(long.ends_with('…'));
    }
}
