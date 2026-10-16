// The Plan island's window side (src/island/plan.ts), the live activities'
// own (activities.rs) for the plan an agent follows.
//
// Beside the open island it is drawn in the island's own window, on the side
// the live activities leave free, which keeps room for it (`room_of`,
// activities.rs side_room). Its grips resize it with the mouse
// (`plan_resize`). Dragged by its top bar it comes off the island into a
// window of its own, put wherever the mouse leaves it; dropped back against
// the island's side it joins it there again. That window (plan.html) only
// draws: the island's page holds the plans, sends it what to show and hears
// its clicks.
//
// Moving and resizing follow the global cursor, which only the cursor poll
// gives (Windows): elsewhere it stays beside the island.
//
// As with the live activities, coming off the island and joining it again
// never leaves a frame without it: its window shows where it is drawn before
// the page lets go of it, and when it joins, it slides to its place beside
// the island and only hides once the page has drawn it there.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::activities::{island_k, island_on_screen, monitor_at, slide, snap_side, update_settings, GAP};
use crate::island::{self, WINDOW_LABEL};
use crate::platform::{self, cursor_physical, left_button_down};
use crate::settings::Settings;

pub const LABEL: &str = "plan";
/// Its width by default, in page pixels (src/views/plan-view.ts PLAN_W).
pub const DEFAULT_WIDTH: f64 = 280.0;
const MIN_W: f64 = 220.0;
const MAX_W: f64 = 480.0;
const MIN_H: f64 = 180.0;
const MAX_H: f64 = 720.0;
/// Its own window's height when none was picked.
const DEFAULT_H: f64 = 340.0;

pub fn clamp_width(w: f64) -> f64 {
    if w.is_finite() && w > 0.0 { w.clamp(MIN_W, MAX_W) } else { DEFAULT_WIDTH }
}

pub fn clamp_height(h: f64) -> f64 {
    if h.is_finite() && h > 0.0 { h.clamp(MIN_H, MAX_H) } else { 0.0 }
}

/// The room the island's window keeps for it, beside the open island. Kept
/// whether a plan shows or not, so neither a plan coming nor it going resizes
/// the window (and makes it flash).
pub fn room_of(s: &Settings) -> (f64, f64) {
    (clamp_width(s.agent_plan_width), clamp_height(s.agent_plan_height))
}

/// The side of the island it is drawn on: the one the live activities leave
/// free (src/island/island.ts planPlace).
pub fn side_of(s: &Settings) -> &'static str {
    if s.activities_panel && s.activities_side == "right" { "left" } else { "right" }
}

#[derive(Serialize, Clone)]
struct SizePayload {
    width: f64,
    height: f64,
}

// ── Resizing beside the island ────────────────────────────────────────────────

/// A grip beside the island: `fx` / `fy` are how the width and height follow
/// the mouse (−1, 0 or 1); `height` is the height drawn when the drag started.
/// The page hears each size (`plan-resize`); the window grows as it does, and
/// the size is kept when the button is let go.
#[tauri::command]
pub fn plan_resize(app: AppHandle, fx: f64, fy: f64, height: f64) {
    std::thread::spawn(move || {
        let Some(win) = island::window(&app) else { return };
        let Some((sx, sy)) = cursor_physical() else { return };
        let k = island_k(&win);
        let shared = app.state::<crate::Shared>();
        let start_w = clamp_width(shared.settings.lock().unwrap().agent_plan_width);
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
            // The window grows first, so it is never cut.
            if size.0 > room.0 || size.1 > room.1 {
                room = (room.0.max(size.0), room.1.max(size.1));
                let (pref, mut p) = {
                    let s = shared.settings.lock().unwrap();
                    (s.screen.clone(), island::Placement::of(&s))
                };
                p.activities = (p.activities.0.max(room.0), p.activities.1.max(room.1));
                let collapsed = shared.gate.collapsed.load(std::sync::atomic::Ordering::Relaxed);
                island::apply_geometry(&app, &pref, p, collapsed);
            }
            let _ = app.emit_to(WINDOW_LABEL, "plan-resize", SizePayload { width: size.0, height: size.1 });
        }
        if size != (start_w, start_h) {
            crate::update_island(&app, |s| {
                s.agent_plan_width = size.0;
                if fy != 0.0 {
                    s.agent_plan_height = size.1;
                }
            });
        }
    });
}

// ── Its own window ───────────────────────────────────────────────────────────

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

fn page_url(app: &AppHandle) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/plan.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("plan.html".into())
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
        .map_err(|e| crate::log::line(format!("plan window failed: {e}")))
        .ok()?;
    platform::make_non_activating(&win);
    let _ = win.set_zoom(island::zoom());
    Some(win)
}

/// Its own window's size in physical pixels, for the display at `p`: drawn at
/// the island's zoom, so it is the same size off the island as on it.
fn physical_size(app: &AppHandle, s: &Settings, p: (f64, f64)) -> (u32, u32) {
    let scale = monitor_at(app, p).map(|m| m.4).unwrap_or(1.0) * island::zoom();
    let h = if s.agent_plan_height > 0.0 { clamp_height(s.agent_plan_height) } else { DEFAULT_H };
    ((clamp_width(s.agent_plan_width) * scale).round() as u32, (h * scale).round() as u32)
}

/// Its window made ahead, hidden, while it shows beside the island: taken off
/// it, it then has a page that is ready to draw it at once. Async: a window
/// made in a synchronous command can deadlock on Windows.
#[tauri::command]
pub async fn plan_prepare(app: AppHandle) {
    if window(&app).is_none() {
        let _ = create(&app);
    }
}

/// Shown while it is off the island with a plan to show, whether the island
/// is open or not; hidden otherwise.
/// Async for the same reason as `plan_prepare`: it may make the window.
#[tauri::command]
pub async fn plan_show(app: AppHandle, show: bool) {
    if !show {
        if let Some(win) = window(&app) {
            let _ = win.hide();
        }
        *SHOWN_AT.lock().unwrap() = None;
        return;
    }
    let settings = app.state::<crate::Shared>().settings.lock().unwrap().clone();
    if !settings.agent_plan_moved {
        return;
    }
    let Some(win) = create(&app) else { return };
    // Already out (just taken off the island, and maybe still moving): it stays where it is.
    if win.is_visible().unwrap_or(false) {
        remember(&win);
        return;
    }
    let mut at = (settings.agent_plan_x, settings.agent_plan_y);
    // A spot on a display that is gone: next to the island instead.
    if monitor_at(&app, at).is_none_or(|m| at.0 < m.0 || at.1 < m.1 || at.0 > m.0 + m.2 || at.1 > m.1 + m.3) {
        if let Some(island) = island::window(&app) {
            if let Ok(o) = island.outer_position() {
                at = (o.x as f64 + 20.0, o.y as f64 + 20.0);
            }
        }
    }
    let (w, h) = physical_size(&app, &settings, at);
    let _ = win.set_zoom(island::zoom());
    let _ = win.set_size(PhysicalSize::new(w, h));
    let _ = win.set_position(PhysicalPosition::new(at.0.round() as i32, at.1.round() as i32));
    let _ = win.show();
    let _ = win.set_always_on_top(true);
    remember(&win);
}

/// Its top bar dragged: off the island (`from` is where it is drawn in the
/// island's page: x, y, width, height) or, already off it, from its own
/// window. It follows the mouse until it is let go; against the island's side
/// it joins it, anywhere else it stays.
#[tauri::command]
pub fn plan_drag(app: AppHandle, from: Option<(f64, f64, f64, f64)>) {
    std::thread::spawn(move || {
        let Some((cx, cy)) = cursor_physical() else { return };
        let Some(win) = create(&app) else { return };
        if let Some((x, y, w, h)) = from {
            // Off the island: its window takes its place under the mouse.
            let Some(island_win) = island::window(&app) else { return };
            let Ok(o) = island_win.outer_position() else { return };
            let k = island_k(&island_win);
            let (px, py) = (o.x as f64 + x * k, o.y as f64 + y * k);
            // Exactly the size it has on the island: its scale and its zoom.
            let _ = win.set_zoom(island::zoom());
            let _ = win.set_size(PhysicalSize::new((w * k).round() as u32, (h * k).round() as u32));
            let _ = win.set_position(PhysicalPosition::new(px.round() as i32, py.round() as i32));
            let _ = win.show();
            let _ = win.set_always_on_top(true);
            remember(&win);
            // The page lets go of it once its window has drawn it (plan-painted).
            update_settings(&app, |s| {
                s.agent_plan_moved = true;
                s.agent_plan_height = h.clamp(MIN_H, MAX_H);
                s.agent_plan_x = px;
                s.agent_plan_y = py;
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
        let joins = island_on_screen(&app).and_then(|island| snap_side(rect, island, scale)).is_some();
        if joins {
            // Into its place beside the island first; the page draws it there
            // and only then hides this window (plan_show false).
            if let Some(target) = joined_rect(&app) {
                slide(&win, (at.0, at.1, size.0, size.1), target);
            }
            remember(&win);
            update_settings(&app, |s| s.agent_plan_moved = false);
            let _ = app.emit_to(WINDOW_LABEL, "plan-joined", ());
        } else {
            remember(&win);
            update_settings(&app, |s| {
                s.agent_plan_x = at.0;
                s.agent_plan_y = at.1;
            });
        }
    });
}

/// Where it is drawn beside the island once joined, in physical pixels (x, y,
/// width, height): on its side, level with the island's top (its bottom,
/// docked at the bottom), its gap away, as tall as the island while it
/// follows it (src/island/island.ts planPlace).
fn joined_rect(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
    let island_win = island::window(app)?;
    let k = island_k(&island_win);
    let (left, top, right, bottom) = island_on_screen(app)?;
    let shared = app.state::<crate::Shared>();
    let (w, h, side, bottom_dock) = {
        let s = shared.settings.lock().unwrap();
        let h = if s.activities_follow_island {
            (bottom - top) / k
        } else if s.agent_plan_height > 0.0 {
            clamp_height(s.agent_plan_height)
        } else {
            DEFAULT_H
        };
        (clamp_width(s.agent_plan_width), h, side_of(&s), island::Placement::of(&s).dock == island::Dock::Bottom)
    };
    let (w, h) = (w * k, h * k);
    let x = if side == "right" { right + GAP * k } else { left - GAP * k - w };
    let y = if bottom_dock { bottom - h } else { top };
    Some((x.round(), y.round(), w.round(), h.round()))
}

/// A grip of its own window: it follows the mouse (`fx` −1 left edge, 1 right
/// edge; `fy` −1 top, 1 bottom), and the size is kept when let go.
#[tauri::command]
pub fn plan_window_resize(app: AppHandle, fx: f64, fy: f64) {
    std::thread::spawn(move || {
        let Some(win) = window(&app) else { return };
        let Some((sx, sy)) = cursor_physical() else { return };
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else { return };
        // Page pixels to physical ones: the display's scale and the island's zoom.
        let scale = win.scale_factor().unwrap_or(1.0) * island::zoom();
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
            update_settings(&app, |s| {
                s.agent_plan_x = last.0;
                s.agent_plan_y = last.1;
                s.agent_plan_width = clamp_width(last.2 / scale);
                s.agent_plan_height = clamp_height(last.3 / scale);
            });
        }
    });
}

/// Its own window's place while it shows (physical l, t, r, b), kept here so
/// the cursor poll asks the system nothing.
static SHOWN_AT: std::sync::Mutex<Option<(f64, f64, f64, f64)>> = std::sync::Mutex::new(None);

fn remember(win: &WebviewWindow) {
    let rect = match (win.is_visible(), win.outer_position(), win.outer_size()) {
        (Ok(true), Ok(p), Ok(s)) => Some((p.x as f64, p.y as f64, (p.x + s.width as i32) as f64, (p.y + s.height as i32) as f64)),
        _ => None,
    };
    *SHOWN_AT.lock().unwrap() = rect;
}

/// Whether the cursor (physical) is over its own window, when it shows: with
/// the button held (moved or resized) it counts as being over the island.
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
    fn it_takes_the_side_the_live_activities_leave_free() {
        let mut s = Settings::default();
        assert_eq!(s.activities_side, "left");
        assert_eq!(side_of(&s), "right");
        s.activities_side = "right".into();
        assert_eq!(side_of(&s), "left");
        // No live activities: on the right.
        s.activities_panel = false;
        assert_eq!(side_of(&s), "right");
    }

    #[test]
    fn the_island_keeps_room_for_it() {
        let mut s = Settings::default();
        assert_eq!(room_of(&s), (DEFAULT_WIDTH, 0.0));
        // The larger of it and the live activities, on each side.
        assert_eq!(crate::activities::side_room(&s).0, DEFAULT_WIDTH);
        s.activities_width = 400.0;
        s.agent_plan_height = 500.0;
        assert_eq!(crate::activities::side_room(&s), (400.0, 500.0));
        s.activities_panel = false;
        s.activities_width = 264.0;
        assert_eq!(crate::activities::side_room(&s), (DEFAULT_WIDTH, 500.0));
    }

    #[test]
    fn sizes_stay_in_range() {
        assert_eq!(clamp_width(0.0), DEFAULT_WIDTH);
        assert_eq!(clamp_width(100.0), MIN_W);
        assert_eq!(clamp_height(f64::NAN), 0.0);
        assert_eq!(clamp_height(9000.0), MAX_H);
    }
}
