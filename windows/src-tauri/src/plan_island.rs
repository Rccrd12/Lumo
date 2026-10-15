// The Plan island's window side (src/island/plan.ts, plan.html).
//
// A third island with the plan an agent follows, in a window of its own that
// only draws: the island's page holds the plans and says when it shows. The
// first time it comes right of the open island, level with it (or left of
// it, on the right edge); moved by its top bar, it stays where it was left;
// its grips resize it. Both follow the global cursor, which only the cursor
// poll gives (Windows), and are kept in Settings.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::island;
use crate::platform::{self, cursor_physical, left_button_down};
use crate::settings::Settings;

pub const LABEL: &str = "plan";
/// Its size by default, in page pixels.
const DEFAULT_W: f64 = 280.0;
const DEFAULT_H: f64 = 340.0;
const MIN_W: f64 = 220.0;
const MAX_W: f64 = 480.0;
const MIN_H: f64 = 180.0;
const MAX_H: f64 = 720.0;
/// Its gap from the island, in page pixels (the live activities' own).
const GAP: f64 = crate::activities::GAP;

pub fn clamp_width(w: f64) -> f64 {
    if w.is_finite() && w > 0.0 { w.clamp(MIN_W, MAX_W) } else { DEFAULT_W }
}

pub fn clamp_height(h: f64) -> f64 {
    if h.is_finite() && h > 0.0 { h.clamp(MIN_H, MAX_H) } else { DEFAULT_H }
}

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
        .inner_size(DEFAULT_W, DEFAULT_H)
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

/// The monitors as (x, y, w, h, scale), physical.
fn monitors(app: &AppHandle) -> Vec<(f64, f64, f64, f64, f64)> {
    app.available_monitors()
        .map(|list| {
            list.iter()
                .map(|m| {
                    let (p, s) = (m.position(), m.size());
                    (p.x as f64, p.y as f64, s.width as f64, s.height as f64, m.scale_factor())
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The monitor a physical point is on.
fn monitor_at(list: &[(f64, f64, f64, f64, f64)], p: (f64, f64)) -> Option<(f64, f64, f64, f64, f64)> {
    list.iter().copied().find(|m| p.0 >= m.0 && p.0 < m.0 + m.2 && p.1 >= m.1 && p.1 < m.1 + m.3)
}

/// Where it goes the first time, in physical pixels, for a window `size`
/// big: beside the open island `island` (l, t, r, b), on its right (on its
/// left when the island hangs from the right edge), past the live activities
/// when they are beside it on that side. Level with its top, or its bottom
/// when it hangs from the bottom edge.
pub fn beside_island(island: (f64, f64, f64, f64), size: (f64, f64), k: f64, dock: island::Dock, activities_right: Option<f64>) -> (f64, f64) {
    let gap = GAP * k;
    let x = match dock {
        island::Dock::Right => island.0 - gap - size.0,
        _ => island.2 + gap + activities_right.map_or(0.0, |w| (w + GAP) * k),
    };
    let y = if dock == island::Dock::Bottom { island.3 - size.1 } else { island.1 };
    (x.round(), y.round())
}

/// `at` moved so a window `size` big is whole on the monitor `m`.
fn kept_on(m: (f64, f64, f64, f64, f64), at: (f64, f64), size: (f64, f64)) -> (f64, f64) {
    (
        at.0.clamp(m.0, (m.0 + m.2 - size.0).max(m.0)),
        at.1.clamp(m.1, (m.1 + m.3 - size.1).max(m.1)),
    )
}

/// Its size in physical pixels at the display `scale`: drawn at the island's zoom.
fn physical_size(s: &Settings, scale: f64) -> (f64, f64) {
    let k = scale * island::zoom();
    ((clamp_width(s.agent_plan_width) * k).round(), (clamp_height(s.agent_plan_height) * k).round())
}

/// Shown with a plan to show, hidden otherwise. Async: a window made in a
/// synchronous command can deadlock on Windows.
#[tauri::command]
pub async fn plan_show(app: AppHandle, show: bool) {
    if !show {
        if let Some(win) = window(&app) {
            let _ = win.hide();
        }
        return;
    }
    let Some(win) = create(&app) else { return };
    if win.is_visible().unwrap_or(false) {
        return;
    }
    let settings = app.state::<crate::Shared>().settings.lock().unwrap().clone();
    let list = monitors(&app);
    let saved = (settings.agent_plan_x, settings.agent_plan_y);
    let placed = settings.agent_plan_moved && monitor_at(&list, saved).is_some();
    let at = if placed {
        let m = monitor_at(&list, saved).unwrap();
        kept_on(m, saved, physical_size(&settings, m.4))
    } else {
        let Some(rect) = island::open_rect(&app, 200.0) else { return };
        let m = monitor_at(&list, (rect.0, rect.1)).or_else(|| list.first().copied());
        let Some(m) = m else { return };
        let size = physical_size(&settings, m.4);
        let p = island::Placement::of(&settings);
        // The live activities beside the island on its right push it further.
        let activities_right = (settings.activities_panel
            && !settings.activities_folded
            && !settings.activities_detached
            && settings.activities_side == "right")
            .then(|| crate::activities::clamp_width(settings.activities_width));
        let k = m.4 * island::clamp_zoom(p.zoom);
        kept_on(m, beside_island(rect, size, k, p.dock, activities_right), size)
    };
    let scale = monitor_at(&list, at).map(|m| m.4).unwrap_or(1.0);
    let (w, h) = physical_size(&settings, scale);
    let _ = win.set_zoom(island::zoom());
    let _ = win.set_size(PhysicalSize::new(w as u32, h as u32));
    let _ = win.set_position(PhysicalPosition::new(at.0.round() as i32, at.1.round() as i32));
    let _ = win.show();
    let _ = win.set_always_on_top(true);
}

/// Settings only Rust writes (where it is, how big): kept and sent to the pages.
fn update_settings(app: &AppHandle, change: impl FnOnce(&mut Settings)) {
    let shared = app.state::<crate::Shared>();
    let after = {
        let mut s = shared.settings.lock().unwrap();
        change(&mut s);
        s.clone()
    };
    if let Err(err) = crate::settings::save(&after) {
        crate::log::line(format!("could not save settings: {err}"));
    }
    let _ = app.emit("settings-changed", after);
}

/// Its top bar dragged: it follows the mouse until let go, and stays there.
#[tauri::command]
pub fn plan_drag(app: AppHandle) {
    std::thread::spawn(move || {
        let Some(win) = window(&app) else { return };
        let Some((cx, cy)) = cursor_physical() else { return };
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
            }
        }
        if at != (start.x as f64, start.y as f64) {
            update_settings(&app, |s| {
                s.agent_plan_moved = true;
                s.agent_plan_x = at.0;
                s.agent_plan_y = at.1;
            });
        }
    });
}

/// A grip: it follows the mouse (`fx` −1 left edge, 1 right edge; `fy` −1
/// top, 1 bottom), and the size is kept when let go.
#[tauri::command]
pub fn plan_window_resize(app: AppHandle, fx: f64, fy: f64) {
    std::thread::spawn(move || {
        let Some(win) = window(&app) else { return };
        let Some((sx, sy)) = cursor_physical() else { return };
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else { return };
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
        if last != start {
            update_settings(&app, |s| {
                // Where it is now, so it shows there again (not beside the island).
                s.agent_plan_moved = true;
                s.agent_plan_x = last.0;
                s.agent_plan_y = last.1;
                s.agent_plan_width = clamp_width(last.2 / scale);
                s.agent_plan_height = clamp_height(last.3 / scale);
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_shown_right_of_the_island_level_with_it() {
        let island = (1000.0, 10.0, 1640.0, 250.0);
        assert_eq!(beside_island(island, (280.0, 340.0), 1.0, island::Dock::Top, None), (1652.0, 10.0));
        // Past the live activities on that side.
        assert_eq!(beside_island(island, (280.0, 340.0), 1.0, island::Dock::Top, Some(264.0)), (1928.0, 10.0));
        // Hanging from the bottom: level with its bottom; from the right: on its left.
        assert_eq!(beside_island(island, (280.0, 340.0), 1.0, island::Dock::Bottom, None), (1652.0, -90.0));
        assert_eq!(beside_island(island, (280.0, 340.0), 2.0, island::Dock::Right, None), (696.0, 10.0));
    }

    #[test]
    fn kept_whole_on_its_display() {
        let m = (0.0, 0.0, 1920.0, 1080.0, 1.0);
        assert_eq!(kept_on(m, (1800.0, 10.0), (280.0, 340.0)), (1640.0, 10.0));
        assert_eq!(kept_on(m, (100.0, -50.0), (280.0, 340.0)), (100.0, 0.0));
    }

    #[test]
    fn sizes_stay_in_range() {
        assert_eq!(clamp_width(0.0), DEFAULT_W);
        assert_eq!(clamp_width(100.0), MIN_W);
        assert_eq!(clamp_height(f64::NAN), DEFAULT_H);
        assert_eq!(clamp_height(9000.0), MAX_H);
    }
}
