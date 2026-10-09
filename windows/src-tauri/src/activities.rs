// The live activities' window side (src/island/activities.ts).
//
// Beside the open island they are drawn in the island's own window, which
// keeps room for them on both sides (`room_of`, island.rs panel_size). Their
// grips resize them with the mouse (`activities_resize`). Dragged by their top
// bar they come off the island into a window of their own, put wherever the
// mouse leaves them; dropped back against the island's left or right side they
// join it there again. That window (activities.html) only draws: the island's
// page holds the timers, the music, the calendar and the emails, sends it what
// to show and hears its clicks.
//
// Moving and resizing follow the global cursor, which only the cursor poll
// gives (Windows): elsewhere the activities stay beside the island.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::island::{self, WINDOW_LABEL};
use crate::platform::{self, cursor_physical, left_button_down};
use crate::settings::Settings;

pub const LABEL: &str = "activities";
/// Their width by default, and their gap from the island, in page pixels
/// (src/island/activities.ts ACTIVITIES_W, ACTIVITIES_GAP).
pub const DEFAULT_WIDTH: f64 = 264.0;
pub const GAP: f64 = 12.0;
const MIN_W: f64 = 220.0;
const MAX_W: f64 = 480.0;
const MIN_H: f64 = 200.0;
const MAX_H: f64 = 640.0;
/// Their own window's height when none was picked.
const DEFAULT_H: f64 = 400.0;
/// Let go this close to the island's side (logical pixels), they join it.
const SNAP: f64 = 90.0;

pub fn clamp_width(w: f64) -> f64 {
    if w.is_finite() { w.clamp(MIN_W, MAX_W) } else { DEFAULT_WIDTH }
}

pub fn clamp_height(h: f64) -> f64 {
    if h.is_finite() && h > 0.0 { h.clamp(MIN_H, MAX_H) } else { 0.0 }
}

/// The room the island's window keeps for them: none when they are off or in
/// their own window. Folded they keep it, so folding never resizes the window.
pub fn room_of(s: &Settings) -> (f64, f64) {
    if !s.activities_panel || s.activities_detached {
        return (0.0, 0.0);
    }
    (clamp_width(s.activities_width), clamp_height(s.activities_height))
}

#[derive(Serialize, Clone)]
struct SizePayload {
    width: f64,
    height: f64,
}

/// The island's display scale times its zoom: page pixels to physical ones.
fn island_k(win: &WebviewWindow) -> f64 {
    win.scale_factor().unwrap_or(1.0) * island::zoom()
}

// ── Resizing beside the island ────────────────────────────────────────────────

/// A grip beside the island: `fx` / `fy` are how the width and height follow
/// the mouse (−1, 0 or 1); `height` is the height drawn when the drag started.
/// The page hears each size (`activities-resize`); the window grows as they
/// do, and the size is kept when the button is let go.
#[tauri::command]
pub fn activities_resize(app: AppHandle, fx: f64, fy: f64, height: f64) {
    if !platform::CURSOR_POLL {
        return;
    }
    std::thread::spawn(move || {
        let Some(win) = island::window(&app) else { return };
        let Some((sx, sy)) = cursor_physical() else { return };
        let k = island_k(&win);
        let shared = app.state::<crate::Shared>();
        let start_w = clamp_width(shared.settings.lock().unwrap().activities_width);
        let start_h = if height.is_finite() && height > 0.0 { height.clamp(MIN_H, MAX_H) } else { DEFAULT_H };
        let (fx, fy) = (fx.clamp(-1.0, 1.0), fy.clamp(-1.0, 1.0));
        let mut size = (start_w, start_h);
        let mut room = (start_w, start_h);
        while left_button_down() {
            std::thread::sleep(Duration::from_millis(8));
            let Some((cx, cy)) = cursor_physical() else { break };
            let next = (
                (start_w + fx * (cx - sx) / k).clamp(MIN_W, MAX_W).round(),
                (start_h + fy * (cy - sy) / k).clamp(MIN_H, MAX_H).round(),
            );
            if next == size {
                continue;
            }
            size = next;
            // The window grows first, so they are never cut.
            if size.0 > room.0 || size.1 > room.1 {
                room = (room.0.max(size.0), room.1.max(size.1));
                let (pref, mut p) = {
                    let s = shared.settings.lock().unwrap();
                    (s.screen.clone(), island::Placement::of(&s))
                };
                p.activities = room;
                let collapsed = shared.gate.collapsed.load(std::sync::atomic::Ordering::Relaxed);
                island::apply_geometry(&app, &pref, p, collapsed);
            }
            let _ = app.emit_to(WINDOW_LABEL, "activities-resize", SizePayload { width: size.0, height: size.1 });
        }
        if size != (start_w, start_h) {
            crate::update_island(&app, |s| {
                s.activities_width = size.0;
                if fy != 0.0 {
                    s.activities_height = size.1;
                }
            });
        }
    });
}

// ── Their own window ─────────────────────────────────────────────────────────

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

fn page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/activities.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("activities.html".into())
}

fn create(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(win) = window(app) {
        return Some(win);
    }
    let win = WebviewWindowBuilder::new(app, LABEL, page_url(app))
        .additional_browser_args(crate::BROWSER_ARGS)
        .title("Lumo")
        .inner_size(DEFAULT_WIDTH, DEFAULT_H)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .disable_drag_drop_handler()
        .visible(false)
        .build()
        .map_err(|e| crate::log::line(format!("activities window failed: {e}")))
        .ok()?;
    platform::make_non_activating(&win);
    Some(win)
}

/// The monitor a physical point is on, as (x, y, w, h, scale).
fn monitor_at(app: &AppHandle, p: (f64, f64)) -> Option<(f64, f64, f64, f64, f64)> {
    let list = app.available_monitors().ok()?;
    let found = list.iter().find(|m| {
        let (pos, size) = (m.position(), m.size());
        p.0 >= pos.x as f64 && p.0 < (pos.x + size.width as i32) as f64 && p.1 >= pos.y as f64 && p.1 < (pos.y + size.height as i32) as f64
    });
    let m = found.or_else(|| list.first())?;
    let (pos, size) = (m.position(), m.size());
    Some((pos.x as f64, pos.y as f64, size.width as f64, size.height as f64, m.scale_factor()))
}

/// Their own window's size in physical pixels, for the display at `p`.
fn physical_size(app: &AppHandle, s: &Settings, p: (f64, f64)) -> (u32, u32) {
    let scale = monitor_at(app, p).map(|m| m.4).unwrap_or(1.0);
    let h = if s.activities_height > 0.0 { clamp_height(s.activities_height) } else { DEFAULT_H };
    ((clamp_width(s.activities_width) * scale).round() as u32, (h * scale).round() as u32)
}

/// Shown while the island is open (and they are off it); hidden otherwise.
#[tauri::command]
pub fn activities_show(app: AppHandle, show: bool) {
    if !platform::CURSOR_POLL {
        return;
    }
    if !show {
        if let Some(win) = window(&app) {
            let _ = win.hide();
        }
        *SHOWN_AT.lock().unwrap() = None;
        return;
    }
    let settings = app.state::<crate::Shared>().settings.lock().unwrap().clone();
    if !settings.activities_detached {
        return;
    }
    let Some(win) = create(&app) else { return };
    let mut at = (settings.activities_x, settings.activities_y);
    // A spot on a display that is gone: next to the island instead.
    if monitor_at(&app, at).is_none_or(|m| at.0 < m.0 || at.1 < m.1 || at.0 > m.0 + m.2 || at.1 > m.1 + m.3) {
        if let Some(island) = island::window(&app) {
            if let Ok(o) = island.outer_position() {
                at = (o.x as f64 + 20.0, o.y as f64 + 20.0);
            }
        }
    }
    let (w, h) = physical_size(&app, &settings, at);
    let _ = win.set_size(PhysicalSize::new(w, h));
    let _ = win.set_position(PhysicalPosition::new(at.0.round() as i32, at.1.round() as i32));
    let _ = win.show();
    let _ = win.set_always_on_top(true);
    remember(&win);
}

/// Where the island is on the screen, in physical pixels (left, top, right, bottom).
fn island_on_screen(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
    let win = island::window(app)?;
    let o = win.outer_position().ok()?;
    let k = island_k(&win);
    let r = *app.state::<crate::Shared>().gate.rect.lock().unwrap();
    if r.w <= 0.0 {
        return None;
    }
    let left = o.x as f64 + r.x * k;
    let top = o.y as f64 + r.y * k;
    Some((left, top, left + r.w * k, top + r.h * k))
}

/// Which side of the island a window at `rect` (physical l, t, r, b) joins
/// when let go there, if any.
pub fn snap_side(rect: (f64, f64, f64, f64), island: (f64, f64, f64, f64), scale: f64) -> Option<&'static str> {
    let reach = SNAP * scale;
    let overlaps = rect.1 < island.3 && rect.3 > island.1;
    if !overlaps {
        return None;
    }
    if (rect.2 - island.0).abs() < reach || (rect.0 < island.0 && rect.2 > island.0 && rect.2 < island.0 + reach) {
        return Some("left");
    }
    if (rect.0 - island.2).abs() < reach || (rect.2 > island.2 && rect.0 < island.2 && rect.0 > island.2 - reach) {
        return Some("right");
    }
    None
}

/// Their top bar dragged: off the island (`from` is where they are drawn in
/// the island's page: x, y, width, height) or, already off it, from their own
/// window. They follow the mouse until it is let go; against the island's
/// side they join it, anywhere else they stay.
#[tauri::command]
pub fn activities_drag(app: AppHandle, from: Option<(f64, f64, f64, f64)>) {
    if !platform::CURSOR_POLL {
        return;
    }
    std::thread::spawn(move || {
        let Some((cx, cy)) = cursor_physical() else { return };
        let Some(win) = create(&app) else { return };
        if let Some((x, y, w, h)) = from {
            // Off the island: their window takes their place under the mouse.
            let Some(island_win) = island::window(&app) else { return };
            let Ok(o) = island_win.outer_position() else { return };
            let k = island_k(&island_win);
            let (px, py) = (o.x as f64 + x * k, o.y as f64 + y * k);
            let scale = monitor_at(&app, (px, py)).map(|m| m.4).unwrap_or(1.0);
            let _ = win.set_size(PhysicalSize::new((w * scale).round() as u32, (h * scale).round() as u32));
            let _ = win.set_position(PhysicalPosition::new(px.round() as i32, py.round() as i32));
            let _ = win.show();
            let _ = win.set_always_on_top(true);
            remember(&win);
            crate::update_island(&app, |s| {
                s.activities_detached = true;
                s.activities_height = h.clamp(MIN_H, MAX_H);
                s.activities_x = px;
                s.activities_y = py;
            });
        }
        let Ok(start) = win.outer_position() else { return };
        let grab = (cx - start.x as f64, cy - start.y as f64);
        let mut at = (start.x as f64, start.y as f64);
        while left_button_down() {
            std::thread::sleep(Duration::from_millis(8));
            let Some((mx, my)) = cursor_physical() else { break };
            let next = ((mx - grab.0).round(), (my - grab.1).round());
            if next != at {
                at = next;
                let _ = win.set_position(PhysicalPosition::new(at.0 as i32, at.1 as i32));
                let mut shown = SHOWN_AT.lock().unwrap();
                if let Some(r) = shown.as_mut() {
                    let (w, h) = (r.2 - r.0, r.3 - r.1);
                    *r = (at.0, at.1, at.0 + w, at.1 + h);
                }
            }
        }
        let size = win.outer_size().map(|s| (s.width as f64, s.height as f64)).unwrap_or((0.0, 0.0));
        let rect = (at.0, at.1, at.0 + size.0, at.1 + size.1);
        let scale = monitor_at(&app, at).map(|m| m.4).unwrap_or(1.0);
        let side = island_on_screen(&app).and_then(|island| snap_side(rect, island, scale));
        match side {
            Some(side) => {
                let _ = win.hide();
                *SHOWN_AT.lock().unwrap() = None;
                crate::update_island(&app, |s| {
                    s.activities_detached = false;
                    s.activities_side = side.into();
                });
                let _ = app.emit_to(WINDOW_LABEL, "activities-joined", side);
            }
            None => {
                remember(&win);
                crate::update_island(&app, |s| {
                    s.activities_x = at.0;
                    s.activities_y = at.1;
                });
            }
        }
    });
}

/// A grip of their own window: it follows the mouse (`fx` −1 left edge, 1
/// right edge; `fy` −1 top, 1 bottom), and the size is kept when let go.
#[tauri::command]
pub fn activities_window_resize(app: AppHandle, fx: f64, fy: f64) {
    if !platform::CURSOR_POLL {
        return;
    }
    std::thread::spawn(move || {
        let Some(win) = window(&app) else { return };
        let Some((sx, sy)) = cursor_physical() else { return };
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else { return };
        let scale = win.scale_factor().unwrap_or(1.0);
        let start = (pos.x as f64, pos.y as f64, size.width as f64, size.height as f64);
        let mut last = start;
        while left_button_down() {
            std::thread::sleep(Duration::from_millis(8));
            let Some((cx, cy)) = cursor_physical() else { break };
            let (dx, dy) = (cx - sx, cy - sy);
            let w = (start.2 + fx.signum() * dx).clamp(MIN_W * scale, MAX_W * scale).round();
            let h = (start.3 + fy.signum() * dy).clamp(MIN_H * scale, MAX_H * scale).round();
            let x = if fx < 0.0 { start.0 + start.2 - w } else { start.0 };
            let y = if fy < 0.0 { start.1 + start.3 - h } else { start.1 };
            let next = (x, y, w, h);
            if next == last {
                continue;
            }
            last = next;
            let _ = win.set_size(PhysicalSize::new(w as u32, h as u32));
            let _ = win.set_position(PhysicalPosition::new(x as i32, y as i32));
        }
        remember(&win);
        if last != start {
            crate::update_island(&app, |s| {
                s.activities_x = last.0;
                s.activities_y = last.1;
                s.activities_width = clamp_width(last.2 / scale);
                s.activities_height = clamp_height(last.3 / scale);
            });
        }
    });
}

/// Their own window takes the keyboard (the timer's field), or gives it back.
#[tauri::command]
pub fn activities_focus(app: AppHandle, focused: bool) {
    let Some(win) = window(&app) else { return };
    platform::set_activating(&win, focused);
    if focused {
        let _ = win.set_focus();
    }
}

/// Their own window's place while it shows (physical l, t, r, b), kept here so
/// the cursor poll asks the system nothing.
static SHOWN_AT: std::sync::Mutex<Option<(f64, f64, f64, f64)>> = std::sync::Mutex::new(None);

fn remember(win: &WebviewWindow) {
    let rect = match (win.is_visible(), win.outer_position(), win.outer_size()) {
        (Ok(true), Ok(p), Ok(s)) => Some((p.x as f64, p.y as f64, (p.x + s.width as i32) as f64, (p.y + s.height as i32) as f64)),
        _ => None,
    };
    *SHOWN_AT.lock().unwrap() = rect;
}

/// Whether the cursor (physical) is over their own window, when it shows: for
/// the island it counts as being over the island.
pub fn cursor_over(cursor: (f64, f64)) -> bool {
    SHOWN_AT
        .lock()
        .unwrap()
        .is_some_and(|r| cursor.0 >= r.0 && cursor.0 <= r.2 && cursor.1 >= r.1 && cursor.1 <= r.3)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn let_go_against_a_side_they_join_it() {
        let island = (1000.0, 10.0, 1640.0, 250.0);
        // Their right edge just left of the island's left edge.
        assert_eq!(snap_side((700.0, 20.0, 990.0, 400.0), island, 1.0), Some("left"));
        // Overlapping it a little from the left.
        assert_eq!(snap_side((740.0, 20.0, 1030.0, 400.0), island, 1.0), Some("left"));
        assert_eq!(snap_side((1660.0, 0.0, 1950.0, 300.0), island, 1.0), Some("right"));
        // Far away, or below it.
        assert_eq!(snap_side((100.0, 20.0, 390.0, 400.0), island, 1.0), None);
        assert_eq!(snap_side((700.0, 300.0, 990.0, 600.0), island, 1.0), None);
    }

    #[test]
    fn sizes_stay_in_range() {
        assert_eq!(clamp_width(100.0), MIN_W);
        assert_eq!(clamp_width(f64::NAN), DEFAULT_WIDTH);
        assert_eq!(clamp_height(0.0), 0.0);
        assert_eq!(clamp_height(9000.0), MAX_H);
    }
}
