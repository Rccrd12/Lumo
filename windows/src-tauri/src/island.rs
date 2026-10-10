// Island window: placement on the chosen display, the two window sizes
// (full panel / invisible wake strip), click-through and the cursor poll.
//
// There is no notch on a PC, so the island is a black shape drawn at the top
// centre of the main display inside a borderless, transparent, always-on-top
// window that never takes focus.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::platform::{self, cursor_physical, left_button_down};

/// Logical size of the full window — the largest island view (Settings, 440
/// high) with the gap and the room around it.
pub const PANEL_W: f64 = 720.0;
pub const PANEL_H: f64 = 480.0;
/// Between the island and the edge of the screen it is docked to, in page pixels.
pub const EDGE_GAP: f64 = 10.0;

/// The gap Settings → Island → Distance from the edge asks for, in page
/// pixels (src/core/layout.ts edgeGap): "light" is the usual one; "medium" is
/// just past the 14 px hover margin, so the cursor crosses the edge above the
/// island without opening it.
pub fn edge_gap_of(name: &str) -> f64 {
    match name {
        "none" => 0.0,
        "medium" => 18.0,
        "wide" => 28.0,
        _ => EDGE_GAP,
    }
}

/// The gap of the island placed last (apply_geometry), for what reads it
/// between two placements: the anchor, a drop near an edge.
static GAP_BITS: AtomicU64 = AtomicU64::new(0x4024_0000_0000_0000); // 10.0

pub fn edge_gap() -> f64 {
    f64::from_bits(GAP_BITS.load(Ordering::Relaxed))
}
/// Logical size of the invisible strip that wakes the island when it is hidden.
pub const STRIP_W: f64 = 240.0;
pub const STRIP_H: f64 = 6.0;

pub const WINDOW_LABEL: &str = "island";

/// How big the island is drawn, as a zoom of the whole page: 1 is the Mac's
/// size. A little bigger by default on a PC, where screens sit further away.
pub const DEFAULT_ZOOM: f64 = 1.15;
const MIN_ZOOM: f64 = 0.8;
const MAX_ZOOM: f64 = 1.6;

/// The zoom in effect, for the cursor poll and the input region.
static ZOOM_BITS: AtomicU64 = AtomicU64::new(DEFAULT_ZOOM.to_bits());

pub fn clamp_zoom(zoom: f64) -> f64 {
    if zoom.is_finite() { zoom.clamp(MIN_ZOOM, MAX_ZOOM) } else { DEFAULT_ZOOM }
}

pub fn zoom() -> f64 {
    f64::from_bits(ZOOM_BITS.load(Ordering::Relaxed))
}

/// Which edge of the display the island hangs from.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dock {
    #[default]
    Top,
    Bottom,
    Left,
    Right,
}

impl Dock {
    pub fn parse(s: &str) -> Self {
        match s {
            "bottom" => Dock::Bottom,
            "left" => Dock::Left,
            "right" => Dock::Right,
            _ => Dock::Top,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Dock::Top => "top",
            Dock::Bottom => "bottom",
            Dock::Left => "left",
            Dock::Right => "right",
        }
    }

    /// On a side the closed island stands upright.
    fn upright(self) -> bool {
        matches!(self, Dock::Left | Dock::Right)
    }
}

/// The edge in effect, for Mochi's flights home (desktop.rs).
static DOCK: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

pub fn dock() -> Dock {
    match DOCK.load(Ordering::Relaxed) {
        1 => Dock::Bottom,
        2 => Dock::Left,
        3 => Dock::Right,
        _ => Dock::Top,
    }
}

/// Where Mochi's flights home aim, as a physical point on screen: the middle
/// of the island's top, wherever it is docked or floats. `pos`/`size` are the
/// window's, `k` its scale times the zoom, `rect` the island as last drawn
/// (page pixels); before one was drawn, the closed pill against the top.
pub fn anchor(pos: (f64, f64), size: (f64, f64), k: f64, rect: IslandRect) -> (f64, f64) {
    if rect.w > 0.0 {
        return (pos.0 + (rect.x + rect.w / 2.0) * k, pos.1 + rect.y * k);
    }
    let pill_long = NOTCH_PILL.0 * k;
    match dock() {
        Dock::Top => (pos.0 + size.0 / 2.0, pos.1 + edge_gap() * k),
        Dock::Bottom => (pos.0 + size.0 / 2.0, pos.1 + size.1 - (edge_gap() + NOTCH_PILL.1) * k),
        Dock::Left => (pos.0 + (edge_gap() + NOTCH_PILL.1 / 2.0) * k, pos.1 + (size.1 - pill_long) / 2.0),
        Dock::Right => (pos.0 + size.0 - (edge_gap() + NOTCH_PILL.1 / 2.0) * k, pos.1 + (size.1 - pill_long) / 2.0),
    }
}

/// How big the island is and where the user put it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    pub zoom: f64,
    pub dock: Dock,
    /// From the middle of that edge, along it, in logical pixels.
    pub offset: f64,
    /// Floating: how far the window is from that edge (top or bottom only),
    /// in logical pixels. 0 = docked against it.
    pub float: f64,
    /// The open island's width, and the height the user gave it (0 = each
    /// view's own), in page pixels.
    pub width: f64,
    pub height: f64,
    /// The live activities beside the open island (on the top and bottom
    /// edges), as (width, height) page pixels, or (0, 0) when they are not:
    /// the window is wider by their room on each side, and tall enough.
    pub activities: (f64, f64),
    /// Between the island and its edge of the screen, in page pixels (edge_gap_of).
    pub gap: f64,
}

impl Placement {
    pub fn of(s: &crate::settings::Settings) -> Self {
        Self {
            zoom: s.island_zoom,
            // Moving it needs the cursor poll; without it (Linux) it stays on top.
            dock: if platform::CURSOR_POLL { Dock::parse(&s.island_dock) } else { Dock::Top },
            offset: s.island_offset,
            float: if platform::CURSOR_POLL { s.island_float.max(0.0) } else { 0.0 },
            width: s.island_width,
            height: s.island_height,
            activities: crate::activities::room_of(s),
            gap: edge_gap_of(&s.island_edge_gap),
        }
    }
}

/// How wide the open island is by default: the Mac's 640.
pub const DEFAULT_WIDTH: f64 = 640.0;
const MIN_WIDTH: f64 = 560.0;
const MAX_WIDTH: f64 = 1200.0;
/// A height the user picked; 0 means each view keeps its own.
const MIN_HEIGHT: f64 = 160.0;
const MAX_HEIGHT: f64 = 640.0;
/// Room the window keeps around the island, for the hit margin and Mochi's glow.
const SIDE_ROOM: f64 = PANEL_W - DEFAULT_WIDTH;
const BOTTOM_ROOM: f64 = 20.0;

/// The window grows in steps of this much, so a resize does not resize it at every pixel.
const PANEL_STEP: f64 = 40.0;

pub fn clamp_width(w: f64) -> f64 {
    if w.is_finite() { w.clamp(MIN_WIDTH, MAX_WIDTH) } else { DEFAULT_WIDTH }
}

pub fn clamp_height(h: f64) -> f64 {
    if h.is_finite() && h > 0.0 { h.clamp(MIN_HEIGHT, MAX_HEIGHT) } else { 0.0 }
}

fn finite(v: f64) -> f64 {
    if v.is_finite() { v } else { 0.0 }
}

/// The window's logical size: the 720 × 320 panel, or more for a wider or
/// taller island. On a side the island is centred up and down, so it needs
/// room at both ends.
fn panel_size(p: Placement) -> (f64, f64) {
    let up = |v: f64| (v / PANEL_STEP).ceil() * PANEL_STEP;
    let ends = if p.dock.upright() { SIDE_ROOM } else { BOTTOM_ROOM + p.gap };
    // The live activities on one side: the same room on the other keeps the
    // island centred (activities.rs GAP).
    let (aw, ah) = if p.dock.upright() { (0.0, 0.0) } else { p.activities };
    let beside = if aw > 0.0 { 2.0 * (aw + crate::activities::GAP) } else { 0.0 };
    (
        PANEL_W.max(up(clamp_width(p.width) + SIDE_ROOM + beside)),
        PANEL_H.max(up(clamp_height(p.height).max(ah) + ends)),
    )
}

/// The window's physical frame (x, y, width, height) in the display's usable
/// area `(ax, ay, aw, ah)`: the panel against its edge, moved along it by the
/// offset and kept whole, or the wake strip along that edge.
fn frame(area: (i32, i32, u32, u32), scale: f64, p: Placement, collapsed: bool) -> (i32, i32, u32, u32) {
    let (ax, ay, aw, ah) = (area.0 as f64, area.1 as f64, area.2 as f64, area.3 as f64);
    let z = clamp_zoom(p.zoom);
    let (lw, lh) = panel_size(p);
    let pw = (lw * z * scale).round().min(aw).max(1.0);
    let ph = (lh * z * scale).round().min(ah).max(1.0);
    let off = finite(p.offset) * scale;
    let along_x = (ax + (aw - pw) / 2.0 + off).clamp(ax, (ax + aw - pw).max(ax)).round();
    let along_y = (ay + (ah - ph) / 2.0 + off).clamp(ay, (ay + ah - ph).max(ay)).round();
    // A floating window stays on the display; the island inside it makes up
    // the difference (see `shift`).
    let lift = float_of(p) * scale;
    let (x, y) = match p.dock {
        Dock::Top => (along_x, (ay + lift).min(ay + ah - ph).max(ay).round()),
        Dock::Bottom => (along_x, (ay + ah - ph - lift).max(ay).round()),
        Dock::Left => (ax, along_y),
        Dock::Right => (ax + aw - pw, along_y),
    };
    if collapsed {
        let long = (STRIP_W * z * scale).round().max(1.0);
        let thin = (STRIP_H * z * scale).round().max(1.0);
        let (sx, sy, sw, sh) = match p.dock {
            // A floating island hides into its edge like a docked one.
            Dock::Top => (x + ((pw - long) / 2.0).round(), ay, long, thin),
            Dock::Bottom => (x + ((pw - long) / 2.0).round(), ay + ah - thin, long, thin),
            Dock::Left => (x, y + ((ph - long) / 2.0).round(), thin, long),
            Dock::Right => (ax + aw - thin, y + ((ph - long) / 2.0).round(), thin, long),
        };
        return (sx as i32, sy as i32, sw as u32, sh as u32);
    }
    (x as i32, y as i32, pw as u32, ph as u32)
}

fn float_of(p: Placement) -> f64 {
    if p.dock.upright() { 0.0 } else { finite(p.float).max(0.0) }
}

/// How far, in page pixels, the island is drawn from its usual place in the
/// window: where a floating island (or one floated near a corner) really is,
/// once the window was kept on the display.
pub fn shift(area: (i32, i32, u32, u32), scale: f64, p: Placement) -> (f64, f64) {
    let (ax, ay, aw, ah) = (area.0 as f64, area.1 as f64, area.2 as f64, area.3 as f64);
    let (x, y, w, h) = frame(area, scale, p, false);
    let (x, y, w, h) = (x as f64, y as f64, w as f64, h as f64);
    let k = scale * clamp_zoom(p.zoom);
    let off = finite(p.offset) * scale;
    let lift = float_of(p) * scale;
    let tidy = |v: f64| if v.abs() < 0.5 { 0.0 } else { (v * 10.0).round() / 10.0 };
    match p.dock {
        Dock::Top => (tidy((ax + aw / 2.0 + off - (x + w / 2.0)) / k), tidy((ay + lift - y) / k)),
        Dock::Bottom => (tidy((ax + aw / 2.0 + off - (x + w / 2.0)) / k), tidy((ay + ah - lift - (y + h)) / k)),
        Dock::Left | Dock::Right => (0.0, tidy((ay + ah / 2.0 + off - (y + h / 2.0)) / k)),
    }
}

/// Let go this close to an edge (logical pixels), the island docks to it;
/// further away it floats where it was left.
const SNAP_EDGE: f64 = 48.0;

/// Where a let-go island goes, given as a physical rectangle (left, top,
/// right, bottom): against an edge it is close to, or floating where it is,
/// growing down in the upper half of the display and up in the lower half.
fn landing(area: (i32, i32, u32, u32), scale: f64, zoom: f64, island: (f64, f64, f64, f64)) -> (Dock, f64) {
    let (ay, ah) = (area.1 as f64, area.3 as f64);
    let (_, t, _, b) = island;
    let dock = nearest_edge(area, island);
    let (ax, aw) = (area.0 as f64, area.2 as f64);
    let gap = match dock {
        Dock::Top => t - ay,
        Dock::Bottom => ay + ah - b,
        Dock::Left => island.0 - ax,
        Dock::Right => ax + aw - island.2,
    };
    // The island keeps a gap from its edge, so "close" counts from there.
    if gap / scale < SNAP_EDGE + edge_gap() * zoom {
        return (dock, 0.0);
    }
    let gap_px = edge_gap() * zoom * scale;
    if (t + b) / 2.0 < ay + ah / 2.0 {
        (Dock::Top, ((t - ay - gap_px) / scale).round().max(0.0))
    } else {
        (Dock::Bottom, ((ay + ah - b - gap_px) / scale).round().max(0.0))
    }
}

/// The edge of the area nearest to the island, given as a physical rectangle
/// (left, top, right, bottom): where a dropped island goes. An island still
/// touching its edge stays on it, however it was grabbed.
fn nearest_edge(area: (i32, i32, u32, u32), island: (f64, f64, f64, f64)) -> Dock {
    let (ax, ay, aw, ah) = (area.0 as f64, area.1 as f64, area.2 as f64, area.3 as f64);
    let (l, t, r, b) = island;
    let gaps = [
        (t - ay, Dock::Top),
        (ay + ah - b, Dock::Bottom),
        (l - ax, Dock::Left),
        (ax + aw - r, Dock::Right),
    ];
    gaps.iter().fold(gaps[0], |best, g| if g.0 < best.0 { *g } else { best }).1
}

/// Where along `dock` an island whose centre is at the physical point `centre`
/// sits, in logical pixels from the middle of the edge. Close to the middle it
/// snaps to it.
fn offset_along(area: (i32, i32, u32, u32), scale: f64, dock: Dock, centre: (f64, f64)) -> f64 {
    let (ax, ay, aw, ah) = (area.0 as f64, area.1 as f64, area.2 as f64, area.3 as f64);
    let (pos, mid, len) = if dock.upright() {
        (centre.1, ay + ah / 2.0, ah)
    } else {
        (centre.0, ax + aw / 2.0, aw)
    };
    let off = (pos - mid) / scale;
    let snap = (len / scale * SNAP_FRACTION).max(SNAP_MIN);
    if off.abs() < snap { 0.0 } else { off.round() }
}

/// Dropped this close to the middle of an edge (a share of its length, at
/// least SNAP_MIN logical px), the island centres itself.
const SNAP_FRACTION: f64 = 0.1;
const SNAP_MIN: f64 = 80.0;

/// The offset `frame` really used, once it kept the panel whole: what to
/// remember, so the island never sits further out than it is drawn.
fn effective_offset(area: (i32, i32, u32, u32), scale: f64, p: Placement) -> f64 {
    let (x, y, w, h) = frame(area, scale, p, false);
    let off = if p.dock.upright() {
        (y as f64 + h as f64 / 2.0) - (area.1 as f64 + area.3 as f64 / 2.0)
    } else {
        (x as f64 + w as f64 / 2.0) - (area.0 as f64 + area.2 as f64 / 2.0)
    };
    (off / scale).round()
}

/// Where the island's centre is in a panel of logical size `panel` docked at
/// `dock`, for an island `w` × `h` drawn in it, moved by `shift` (page pixels).
fn centre_in_panel(dock: Dock, panel: (f64, f64), w: f64, h: f64, shift: (f64, f64)) -> (f64, f64) {
    let (cx, cy) = match dock {
        Dock::Top => (panel.0 / 2.0, edge_gap() + h / 2.0),
        Dock::Bottom => (panel.0 / 2.0, panel.1 - edge_gap() - h / 2.0),
        Dock::Left => (edge_gap() + w / 2.0, panel.1 / 2.0),
        Dock::Right => (panel.0 - edge_gap() - w / 2.0, panel.1 / 2.0),
    };
    (cx + shift.0, cy + shift.1)
}

/// Margin around the island that still counts as "on the island", in logical px.
/// Wider than the macOS 6 pt because a click must never be swallowed.
const HIT_MARGIN: f64 = 14.0;

#[derive(Serialize, Clone)]
pub struct CursorPayload {
    pub x: f64,
    pub y: f64,
    /// Over the live activities' own window, which counts as the island.
    pub panel: bool,
}

#[derive(Serialize, Clone)]
pub struct ScreenInfo {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

/// The island shape in window-logical coordinates, pushed by the front end.
/// The poll thread owns the click-through decision so it lands in the same 16 ms
/// tick as the cursor read — an IPC round trip here loses clicks.
#[derive(Clone, Copy, Default)]
pub struct IslandRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Wakes / parks the cursor poll thread so a hidden island costs literally nothing.
pub struct PollGate {
    active: Mutex<bool>,
    cv: Condvar,
    pub collapsed: AtomicBool,
    pub rect: Mutex<IslandRect>,
    /// Mirrors the window flag so we only call into the OS when it changes.
    ignoring: AtomicBool,
}

impl PollGate {
    pub fn new() -> Self {
        Self {
            active: Mutex::new(false),
            cv: Condvar::new(),
            collapsed: AtomicBool::new(true),
            rect: Mutex::new(IslandRect::default()),
            ignoring: AtomicBool::new(false),
        }
    }

    pub fn set_rect(&self, rect: IslandRect) {
        *self.rect.lock().unwrap() = rect;
    }

    /// Forces the next poll tick to re-apply the flag (after a window resize).
    pub fn forget_ignore_state(&self) {
        self.ignoring.store(false, Ordering::Relaxed);
    }

    pub fn set_active(&self, on: bool) {
        let mut guard = self.active.lock().unwrap();
        *guard = on;
        self.cv.notify_all();
    }

    pub(crate) fn wait_until_active(&self) {
        let mut guard = self.active.lock().unwrap();
        while !*guard {
            guard = self.cv.wait(guard).unwrap();
        }
    }

    pub(crate) fn is_active(&self) -> bool {
        *self.active.lock().unwrap()
    }
}

pub fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn monitor_contains(m: &Monitor, x: f64, y: f64) -> bool {
    let p = m.position();
    let s = m.size();
    x >= p.x as f64
        && x < (p.x + s.width as i32) as f64
        && y >= p.y as f64
        && y < (p.y + s.height as i32) as f64
}

/// A display's logical origin, the key `at:<x>,<y>` preferences are matched on.
/// Names are no good for that: two monitors of the same model share one.
fn logical_origin(m: &Monitor) -> (i32, i32) {
    let scale = m.scale_factor();
    let p = m.position();
    ((p.x as f64 / scale).round() as i32, (p.y as f64 / scale).round() as i32)
}

/// One entry of the "Island lives on" list in Settings.
#[derive(Serialize, Clone)]
pub struct MonitorChoice {
    pub key: String,
    pub label: String,
}

pub fn monitor_choices(app: &AppHandle) -> Vec<MonitorChoice> {
    let Ok(monitors) = app.available_monitors() else { return Vec::new() };
    let ids: Vec<DisplayId> = monitors.iter().map(describe).collect();
    let primary = app.primary_monitor().ok().flatten().map(|p| describe(&p));
    let main = primary.and_then(|p| ids.iter().position(|d| *d == p));
    let labels = display_labels(&ids, main);
    ids.iter().zip(labels).map(|(d, label)| MonitorChoice { key: d.key(), label }).collect()
}

/// Where a display sits next to the main one, for its label.
fn side_of(d: &DisplayId, main: &DisplayId) -> &'static str {
    let (cx, cy) = (d.x * 2 + d.w - main.x * 2 - main.w, d.y * 2 + d.h - main.y * 2 - main.h);
    if cx.abs() >= cy.abs() {
        if cx < 0 { crate::i18n::n_("{display} · on the left") } else { crate::i18n::n_("{display} · on the right") }
    } else if cy < 0 {
        crate::i18n::n_("{display} · above")
    } else {
        crate::i18n::n_("{display} · below")
    }
}

/// "Display 2 — 1440×900 · on the left": numbered from left to right, the
/// main one said so, the others placed next to it. The system's own names
/// (`\\.\DISPLAY5` on Windows) mean nothing to people.
fn display_labels(ids: &[DisplayId], main: Option<usize>) -> Vec<String> {
    let mut order: Vec<usize> = (0..ids.len()).collect();
    order.sort_by_key(|&i| (ids[i].x, ids[i].y));
    let mut out = vec![String::new(); ids.len()];
    for (n, &i) in order.iter().enumerate() {
        let d = &ids[i];
        let display = crate::i18n::tf(
            "Display {n} — {width}×{height}",
            &[("n", &(n + 1).to_string()), ("width", &d.w.to_string()), ("height", &d.h.to_string())],
        );
        out[i] = match main {
            _ if ids.len() == 1 => display,
            Some(m) if m == i => crate::i18n::tf("{display} · main", &[("display", &display)]),
            Some(m) => crate::i18n::tf(side_of(d, &ids[m]), &[("display", &display)]),
            None => display,
        };
    }
    out
}

/// What a display is remembered by: its logical origin, plus its name and
/// logical size, so it is still found after the layout is rearranged or the
/// resolution changes (the Mac keeps the display's UUID for the same reason;
/// Tauri has no stable ID).
#[derive(Debug, Clone, PartialEq)]
struct DisplayId {
    name: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

impl DisplayId {
    /// `at:<x>,<y>` stays first, so a preference saved before still matches.
    fn key(&self) -> String {
        format!("at:{},{}|{}|{}x{}", self.x, self.y, self.name.replace('|', " "), self.w, self.h)
    }
}

fn describe(m: &Monitor) -> DisplayId {
    let (x, y) = logical_origin(m);
    let scale = m.scale_factor();
    let s = m.size();
    DisplayId {
        name: m.name().cloned().unwrap_or_else(|| "Display".into()),
        x,
        y,
        w: (s.width as f64 / scale).round() as i32,
        h: (s.height as f64 / scale).round() as i32,
    }
}

/// Which display a saved `at:` preference points at, best match first: same
/// place and name; the same name and size elsewhere (layout rearranged); the
/// same name alone when unique (resolution changed); the same place. None
/// means unplugged, and the caller falls back to the primary display.
fn pick_display(pref: &str, displays: &[DisplayId]) -> Option<usize> {
    let rest = pref.strip_prefix("at:")?;
    let mut parts = rest.split('|');
    let (x, y) = parts.next()?.split_once(',')?;
    let (x, y) = (x.trim().parse::<i32>().ok()?, y.trim().parse::<i32>().ok()?);
    let name = parts.next();
    let size = parts.next().and_then(|s| {
        let (w, h) = s.split_once('x')?;
        Some((w.parse::<i32>().ok()?, h.parse::<i32>().ok()?))
    });
    let at = |d: &DisplayId| d.x == x && d.y == y;
    if let Some(name) = name {
        if let Some(i) = displays.iter().position(|d| at(d) && d.name == name) {
            return Some(i);
        }
        if let Some((w, h)) = size {
            if let Some(i) = displays.iter().position(|d| d.name == name && d.w == w && d.h == h) {
                return Some(i);
            }
        }
        let mut same_name = displays.iter().enumerate().filter(|(_, d)| d.name == name);
        if let (Some((i, _)), None) = (same_name.next(), same_name.next()) {
            return Some(i);
        }
    }
    displays.iter().position(at)
}

/// The display the island lives on: a chosen one, the primary one, or the one
/// under the cursor.
fn target_monitor(app: &AppHandle, pref: &str) -> Option<Monitor> {
    let monitors = app.available_monitors().ok()?;
    let ids: Vec<DisplayId> = monitors.iter().map(describe).collect();
    if let Some(i) = pick_display(pref, &ids) {
        return Some(monitors[i].clone());
    }
    if pref == "cursor" {
        if let Some((cx, cy)) = cursor_physical() {
            if let Some(m) = monitors.iter().find(|m| monitor_contains(m, cx, cy)) {
                return Some(m.clone());
            }
        }
    }
    app.primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.into_iter().next())
}

#[cfg(test)]
mod display_tests {
    use super::*;

    fn d(name: &str, x: i32, y: i32, w: i32, h: i32) -> DisplayId {
        DisplayId { name: name.into(), x, y, w, h }
    }

    #[test]
    fn a_display_is_found_again_after_changes() {
        let dell = d("DELL U2720Q", 1920, 0, 2560, 1440);
        let lap = d("eDP-1", 0, 0, 1920, 1200);
        let key = dell.key();
        assert_eq!(pick_display(&key, &[lap.clone(), dell.clone()]), Some(1));
        // Rearranged: the Dell moved to the left of the laptop.
        let moved = [d("eDP-1", 2560, 0, 1920, 1200), d("DELL U2720Q", 0, 0, 2560, 1440)];
        assert_eq!(pick_display(&key, &moved), Some(1));
        // Resolution changed, still the only Dell.
        let rescaled = [lap.clone(), d("DELL U2720Q", 1920, 0, 1920, 1080)];
        assert_eq!(pick_display(&key, &rescaled), Some(1));
        // Unplugged: nothing, so the caller falls back to the primary display.
        assert_eq!(pick_display(&key, &[lap.clone()]), None);
    }

    #[test]
    fn two_identical_monitors_are_told_apart_by_place() {
        let a = d("LG 27UL500", 0, 0, 1920, 1080);
        let b = d("LG 27UL500", 1920, 0, 1920, 1080);
        assert_eq!(pick_display(&b.key(), &[a.clone(), b.clone()]), Some(1));
        assert_eq!(pick_display(&a.key(), &[a, b]), Some(0));
    }

    #[test]
    fn preferences_saved_before_still_match() {
        let lap = d("eDP-1", 0, 0, 1920, 1200);
        let ext = d("HDMI-1", 1920, 0, 1920, 1080);
        assert_eq!(pick_display("at:1920,0", &[lap.clone(), ext.clone()]), Some(1));
        assert_eq!(pick_display("primary", &[lap, ext]), None);
        assert_eq!(pick_display("at:nonsense", &[]), None);
    }
}

pub fn screen_info(app: &AppHandle, pref: &str) -> ScreenInfo {
    match target_monitor(app, pref) {
        Some(m) => {
            let scale = m.scale_factor();
            let p = m.position();
            let s = m.size();
            ScreenInfo {
                x: p.x as f64 / scale,
                y: p.y as f64 / scale,
                width: s.width as f64 / scale,
                height: s.height as f64 / scale,
                scale,
            }
        }
        None => ScreenInfo { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0, scale: 1.0 },
    }
}

fn display_of(m: &Monitor) -> (i32, i32, u32, u32) {
    let (p, s) = (m.position(), m.size());
    (p.x, p.y, s.width, s.height)
}

/// The part of a display the island may use: on Windows, the work area, so it
/// never hides under the taskbar. On Linux the whole display, as before (the
/// island goes over the top panel).
fn area_of(m: &Monitor) -> (i32, i32, u32, u32) {
    if cfg!(target_os = "linux") {
        return display_of(m);
    }
    let r = m.work_area();
    if r.size.width == 0 || r.size.height == 0 {
        return display_of(m);
    }
    (r.position.x, r.position.y, r.size.width, r.size.height)
}

/// A size dragged from one of the island's grips, as the page hears it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SizePayload {
    width: f64,
    height: f64,
}

/// The size a grip dragged by `d` page pixels gives. `fx` and `fy` say how
/// the grip moves the size: 2 for a side whose opposite side follows it (the
/// island stays centred), 1 or −1 for a free edge, 0 when it leaves that size
/// alone. `height` is the height drawn when the drag started; `room` is how
/// much the display allows, in page pixels.
fn resized(p: Placement, f: (f64, f64), height: f64, d: (f64, f64), room: (f64, f64)) -> Placement {
    let mut next = p;
    if f.0 != 0.0 {
        let max = (room.0 - SIDE_ROOM).clamp(MIN_WIDTH, MAX_WIDTH);
        next.width = (clamp_width(p.width) + f.0 * d.0).clamp(MIN_WIDTH, max).round();
    }
    if f.1 != 0.0 {
        let ends = if p.dock.upright() { SIDE_ROOM } else { BOTTOM_ROOM + p.gap };
        let max = (room.1 - ends).clamp(MIN_HEIGHT, MAX_HEIGHT);
        next.height = (height + f.1 * d.1).clamp(MIN_HEIGHT, max).round();
    }
    next
}

/// Resizes the island with the mouse while the left button is held on one of
/// its grips (see `resized`). The page hears each new size (`island-resize`)
/// and springs to it; the window only grows meanwhile, so the island is never
/// cut, and fits it again once the button is let go. Returns the size it ended
/// at. Needs the cursor poll (Windows): elsewhere it returns at once.
pub fn resize(app: &AppHandle, pref: &str, start: Placement, f: (f64, f64), height: f64) -> Option<Placement> {
    let win = window(app)?;
    let m = target_monitor(app, pref)?;
    let area = area_of(&m);
    let scale = m.scale_factor();
    let k = scale * clamp_zoom(start.zoom);
    let (sx, sy) = cursor_physical()?;
    let f = (finite(f.0).clamp(-2.0, 2.0), finite(f.1).clamp(-2.0, 2.0));
    let room = (area.2 as f64 / k, area.3 as f64 / k);
    let height = if height.is_finite() && height > 0.0 { height } else { MIN_HEIGHT };
    let mut p = start;
    // The largest size reached: the window keeps room for it until the end.
    let mut room_for = start;
    while left_button_down() {
        std::thread::sleep(Duration::from_millis(8));
        let Some((cx, cy)) = cursor_physical() else { break };
        let next = resized(start, f, height, ((cx - sx) / k, (cy - sy) / k), room);
        if next == p {
            continue;
        }
        p = next;
        let grown = Placement {
            width: clamp_width(room_for.width).max(clamp_width(p.width)),
            height: clamp_height(room_for.height).max(clamp_height(p.height)),
            ..p
        };
        if grown != room_for {
            room_for = grown;
            let (x, y, w, h) = frame(area, scale, room_for, false);
            let _ = win.set_size(PhysicalSize::new(w, h));
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
        let _ = app.emit_to(WINDOW_LABEL, "island-resize", SizePayload { width: clamp_width(p.width), height: p.height });
    }
    Some(p)
}

/// The page hears where a dropped island is going before the window moves.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DockPayload {
    dock: Dock,
    offset: f64,
    float: f64,
    shift_x: f64,
    shift_y: f64,
}

/// Where the island is drawn in its window (see `shift`), for the page.
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct ShiftPayload {
    pub x: f64,
    pub y: f64,
}

/// One axis of a damped spring, for the window's bounce into place.
#[derive(Clone, Copy)]
struct Axis {
    x: f64,
    v: f64,
}

impl Axis {
    /// Semi-implicit Euler: stable at the 8 ms steps used here.
    fn step(&mut self, target: f64, dt: f64) {
        let omega = 2.0 * std::f64::consts::PI / BOUNCE_RESPONSE;
        let a = -omega * omega * (self.x - target) - 2.0 * BOUNCE_DAMPING * omega * self.v;
        self.v += a * dt;
        self.x += self.v * dt;
    }

    fn settled(&self, target: f64) -> bool {
        (self.x - target).abs() < 0.5 && self.v.abs() < 20.0
    }
}

/// How the island settles into place: a spring of this period (s) and damping
/// ratio — just under 1, so it eases in with the faintest overshoot instead of
/// a bounce, and lands where it was let go when it floats.
const BOUNCE_RESPONSE: f64 = 0.36;
const BOUNCE_DAMPING: f64 = 0.75;
/// How quickly the dragged island catches up with the mouse (s).
const FOLLOW: f64 = 0.045;

/// Where a dragged island ended: its edge, the offset along it, and the
/// display it was dropped on (its Settings key) when that changed.
pub struct Dropped {
    pub placement: Placement,
    pub screen: Option<String>,
}

/// Moves the island with the mouse while the left button is held — a drag
/// from its top, or Alt + drag anywhere on it. It follows the mouse with a
/// little smoothing; let go, it goes to the nearest edge of the display it is
/// on (upright on a side), snaps to the middle of that edge when close to it,
/// and bounces into place. `rect` is the island as last drawn, in page pixels.
/// Needs the cursor poll (Windows): elsewhere it returns at once.
pub fn drag(app: &AppHandle, pref: &str, start: Placement, rect: IslandRect) -> Option<Dropped> {
    let win = window(app)?;
    // A new drag takes over from a bounce still under way.
    let generation = DRAGS.fetch_add(1, Ordering::SeqCst) + 1;
    let (sx, sy) = cursor_physical()?;
    let origin = win.outer_position().ok()?;
    let (ox, oy) = (origin.x as f64, origin.y as f64);
    let (mut x, mut y) = (ox, oy);
    let mut shown = (origin.x, origin.y);
    let mut last = std::time::Instant::now();
    let (mut cx, mut cy) = (sx, sy);
    while left_button_down() {
        std::thread::sleep(Duration::from_millis(8));
        let now = std::time::Instant::now();
        let dt = now.duration_since(last).as_secs_f64();
        last = now;
        if let Some(c) = cursor_physical() {
            (cx, cy) = c;
        }
        let pull = 1.0 - (-dt / FOLLOW).exp();
        x += (ox + cx - sx - x) * pull;
        y += (oy + cy - sy - y) * pull;
        let at = (x.round() as i32, y.round() as i32);
        if at != shown {
            let _ = win.set_position(PhysicalPosition::new(at.0, at.1));
            shown = at;
        }
    }

    // The display under the mouse, and its edge nearest to it.
    let monitors = app.available_monitors().ok()?;
    let m = monitors
        .iter()
        .find(|m| monitor_contains(m, cx, cy))
        .cloned()
        .or_else(|| target_monitor(app, pref))?;
    let current = target_monitor(app, pref);
    let screen = match &current {
        Some(c) if describe(c) == describe(&m) => None,
        _ => Some(describe(&m).key()),
    };
    let area = area_of(&m);
    let scale = m.scale_factor();
    let k = scale * clamp_zoom(start.zoom);

    // The island on screen as it was let go: docked to an edge it is close
    // to, or floating where it is.
    let (rw, rh) = if rect.w > 0.0 { (rect.w, rect.h) } else { (NOTCH_PILL.0, NOTCH_PILL.1) };
    let (left, top) = (x + rect.x * k, y + rect.y * k);
    let (dock, float) = landing(area, scale, clamp_zoom(start.zoom), (left, top, left + rw * k, top + rh * k));
    let centre = (left + rw * k / 2.0, top + rh * k / 2.0);
    let mut p = Placement { dock, float, offset: offset_along(area, scale, dock, centre), ..start };
    if float > 0.0 {
        // Floating, it stays exactly where it was let go, even near a corner.
        let mid = area.0 as f64 + area.2 as f64 / 2.0;
        p.offset = ((centre.0 - mid) / scale).round();
    } else {
        p.offset = effective_offset(area, scale, p);
    }
    let moved = shift(area, scale, p);
    let _ = app.emit_to(
        WINDOW_LABEL,
        "island-dock",
        DockPayload { dock, offset: p.offset, float: p.float, shift_x: moved.0, shift_y: moved.1 },
    );

    // Re-anchored in its new panel, the island keeps its place on screen for a
    // moment, then springs to the edge.
    let (tx, ty, tw, th) = frame(area, scale, p, false);
    // A closed island turns upright on a side, and back on the top or bottom.
    let turned = rw.min(rh) < 40.0 && dock.upright() != start.dock.upright();
    let (iw, ih) = if turned { (rh, rw) } else { (rw, rh) };
    let inside = centre_in_panel(dock, panel_size(p), iw, ih, moved);
    let mut ax = Axis { x: centre.0 - inside.0 * k, v: 0.0 };
    let mut ay = Axis { x: centre.1 - inside.1 * k, v: 0.0 };
    let _ = win.set_size(PhysicalSize::new(tw, th));
    let started = std::time::Instant::now();
    let dt = 0.008;
    while started.elapsed() < Duration::from_millis(1500) {
        if DRAGS.load(Ordering::SeqCst) != generation {
            // Picked up again mid-bounce: that drag places it now.
            return None;
        }
        ax.step(tx as f64, dt);
        ay.step(ty as f64, dt);
        let at = (ax.x.round() as i32, ay.x.round() as i32);
        if at != shown {
            let _ = win.set_position(PhysicalPosition::new(at.0, at.1));
            shown = at;
        }
        if ax.settled(tx as f64) && ay.settled(ty as f64) {
            break;
        }
        std::thread::sleep(Duration::from_millis(8));
    }
    let _ = win.set_position(PhysicalPosition::new(tx, ty));
    // Dropped on a display of another scale, the window was resized on the
    // way: back to the size worked out for that display.
    let _ = win.set_size(PhysicalSize::new(tw, th));
    let _ = win.set_position(PhysicalPosition::new(tx, ty));
    Some(Dropped { placement: p, screen })
}

/// Counts drags, so a bounce knows when a newer drag has taken the window.
static DRAGS: AtomicU64 = AtomicU64::new(0);

/// The closed island, in page pixels, when no shape was pushed yet.
const NOTCH_PILL: (f64, f64) = (288.0, 32.0);

/// Where the island is drawn in its window now, for the page's first draw.
pub fn current_shift(app: &AppHandle, pref: &str, placement: Placement) -> ShiftPayload {
    let (x, y) = target_monitor(app, pref)
        .map(|m| shift(area_of(&m), m.scale_factor(), placement))
        .unwrap_or((0.0, 0.0));
    ShiftPayload { x, y }
}

/// Places and sizes the window. `collapsed` picks the wake strip instead of the panel.
pub fn apply_geometry(app: &AppHandle, pref: &str, placement: Placement, collapsed: bool) {
    let Some(win) = window(app) else { return };
    let Some(m) = target_monitor(app, pref) else { return };

    let scale = m.scale_factor();
    let zoom = clamp_zoom(placement.zoom);
    ZOOM_BITS.store(zoom.to_bits(), Ordering::Relaxed);
    GAP_BITS.store(placement.gap.to_bits(), Ordering::Relaxed);
    let dock_bits = match placement.dock {
        Dock::Top => 0,
        Dock::Bottom => 1,
        Dock::Left => 2,
        Dock::Right => 3,
    };
    DOCK.store(dock_bits, Ordering::Relaxed);
    let area = area_of(&m);
    let (x, y, pw, ph) = frame(area, scale, placement, collapsed);
    let (sx, sy) = shift(area, scale, placement);
    let _ = app.emit_to(WINDOW_LABEL, "island-shift", ShiftPayload { x: sx, y: sy });

    // GTK never sizes a non-resizable window below its natural size (200 px
    // here), so on Linux the 6 px wake strip would stay a 200 px block. tao
    // re-applies the config's `resizable: false` after the first configure, so
    // this is asked every time, just before the resize. Undecorated, the window
    // still offers the user nothing to resize it by. (Found by @YossiYad, #44.)
    #[cfg(target_os = "linux")]
    let _ = win.set_resizable(true);
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let (lx, ly) = logical_origin(&m);
    platform::pin_to_monitor(&win, lx, ly);
    // Moving across displays of different scales makes Windows resize the
    // window to its suggested rectangle, which can also move it: re-assert the
    // physical size, then the place.
    let _ = win.set_size(PhysicalSize::new(pw, ph));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    // The page keeps its 720 × 320 layout; the webview draws it bigger.
    let _ = win.set_zoom(zoom);
    // The live activities in their own window are drawn at the same zoom.
    if let Some(panel) = crate::activities::window(app) {
        let _ = panel.set_zoom(zoom);
    }
    let _ = win.set_always_on_top(true);
}

#[cfg(test)]
mod placement_tests {
    use super::*;

    const FHD: (i32, i32, u32, u32) = (0, 0, 1920, 1080);
    const HOME: Placement = Placement { zoom: 1.0, dock: Dock::Top, offset: 0.0, float: 0.0, width: DEFAULT_WIDTH, height: 0.0, activities: (0.0, 0.0), gap: EDGE_GAP };

    #[test]
    fn the_distance_from_the_edge_is_none_medium_or_wide() {
        assert_eq!(edge_gap_of("none"), 0.0);
        assert_eq!(edge_gap_of("light"), EDGE_GAP);
        assert_eq!(edge_gap_of("anything else"), EDGE_GAP);
        assert!(edge_gap_of("medium") > HIT_MARGIN, "the cursor passes above it");
        assert_eq!(edge_gap_of("wide"), 28.0);
        // A wider gap leaves the island its room: the window is never shorter.
        let tall = Placement { height: 600.0, ..HOME };
        assert!(panel_size(Placement { gap: 28.0, ..tall }).1 >= panel_size(tall).1);
    }

    #[test]
    fn home_is_the_top_centre_and_the_zoom_grows_the_window() {
        assert_eq!(frame(FHD, 1.0, HOME, false), (600, 0, 720, 480));
        assert_eq!(frame(FHD, 1.0, Placement { zoom: 1.5, ..HOME }, false), (420, 0, 1080, 720));
        assert_eq!(frame(FHD, 2.0, HOME, false), (240, 0, 1440, 960));
        // The wake strip sits at the top of where the panel is.
        assert_eq!(frame(FHD, 1.0, HOME, true), (840, 0, 240, 6));
        // Silly zooms are brought back into range.
        assert_eq!(frame(FHD, 1.0, Placement { zoom: f64::NAN, ..HOME }, false).2, (720.0 * DEFAULT_ZOOM).round() as u32);
        assert_eq!(frame(FHD, 1.0, Placement { zoom: 9.0, ..HOME }, false).2, (720.0 * MAX_ZOOM) as u32);
    }

    #[test]
    fn each_edge_holds_the_panel_and_its_wake_strip() {
        // A taskbar 40 px high at the bottom: the work area stops above it.
        let work = (0, 0, 1920, 1040);
        let at = |dock, offset| Placement { dock, offset, ..HOME };
        assert_eq!(frame(work, 1.0, at(Dock::Bottom, 0.0), false), (600, 560, 720, 480));
        assert_eq!(frame(work, 1.0, at(Dock::Bottom, 0.0), true), (840, 1034, 240, 6));
        // On a side the panel is centred up and down, and the strip stands upright.
        assert_eq!(frame(work, 1.0, at(Dock::Left, 0.0), false), (0, 280, 720, 480));
        assert_eq!(frame(work, 1.0, at(Dock::Left, 0.0), true), (0, 400, 6, 240));
        assert_eq!(frame(work, 1.0, at(Dock::Right, -100.0), false), (1200, 180, 720, 480));
        assert_eq!(frame(work, 1.0, at(Dock::Right, -100.0), true), (1914, 300, 6, 240));
        // Moved along its edge, it stays whole on the display.
        assert_eq!(frame(work, 1.0, at(Dock::Top, -300.0), false), (300, 0, 720, 480));
        assert_eq!(frame(work, 1.0, at(Dock::Top, 5000.0), false), (1200, 0, 720, 480));
        assert_eq!(frame(work, 1.0, at(Dock::Left, -5000.0), false), (0, 0, 720, 480));
        // A second display to the right, at 150 %.
        let right = (1920, 0, 2560, 1440);
        assert_eq!(frame(right, 1.5, at(Dock::Top, 100.0), false), (1920 + 740 + 150, 0, 1080, 720));
    }

    #[test]
    fn a_dropped_island_goes_to_the_nearest_edge() {
        let pill = |x: f64, y: f64| (x, y, x + 288.0, y + 32.0);
        assert_eq!(nearest_edge(FHD, pill(800.0, 100.0)), Dock::Top);
        assert_eq!(nearest_edge(FHD, pill(800.0, 1000.0)), Dock::Bottom);
        assert_eq!(nearest_edge(FHD, pill(30.0, 500.0)), Dock::Left);
        assert_eq!(nearest_edge(FHD, pill(1600.0, 300.0)), Dock::Right);
        // An open island on the left, nudged up and grabbed far from the edge,
        // still touches the left edge: it stays there.
        assert_eq!(nearest_edge(FHD, (0.0, 200.0, 640.0, 360.0)), Dock::Left);
    }

    #[test]
    fn near_the_middle_of_an_edge_it_centres_itself() {
        // 10 % of 1920 is 192 px: closer than that is the middle.
        assert_eq!(offset_along(FHD, 1.0, Dock::Top, (960.0 + 150.0, 10.0)), 0.0);
        assert_eq!(offset_along(FHD, 1.0, Dock::Top, (960.0 - 400.0, 10.0)), -400.0);
        // Along a side it is the height that counts, in logical pixels.
        assert_eq!(offset_along(FHD, 2.0, Dock::Left, (5.0, 540.0 + 90.0)), 0.0);
        assert_eq!(offset_along(FHD, 2.0, Dock::Left, (5.0, 540.0 + 400.0)), 200.0);
        // What is remembered is where the panel really is, kept whole.
        let far = Placement { offset: 5000.0, ..HOME };
        assert_eq!(effective_offset(FHD, 1.0, far), 600.0);
        assert_eq!(frame(FHD, 1.0, Placement { offset: 600.0, ..HOME }, false), frame(FHD, 1.0, far, false));
    }

    #[test]
    fn let_go_near_an_edge_it_docks_elsewhere_it_floats() {
        let pill = |x: f64, y: f64| (x, y, x + 288.0, y + 32.0);
        // Within 48 px of the gap: docked, against that edge.
        assert_eq!(landing(FHD, 1.0, 1.0, pill(800.0, 40.0)), (Dock::Top, 0.0));
        assert_eq!(landing(FHD, 1.0, 1.0, pill(20.0, 500.0)), (Dock::Left, 0.0));
        assert_eq!(landing(FHD, 1.0, 1.0, pill(800.0, 1080.0 - 32.0 - 50.0)), (Dock::Bottom, 0.0));
        // Further out: floating, from the top in the upper half…
        assert_eq!(landing(FHD, 1.0, 1.0, pill(800.0, 300.0)), (Dock::Top, 290.0));
        // …from the bottom in the lower half, growing upwards.
        assert_eq!(landing(FHD, 1.0, 1.0, pill(800.0, 700.0)), (Dock::Bottom, 1080.0 - 732.0 - 10.0));
        // At 150 % the distances are logical pixels.
        assert_eq!(landing(FHD, 1.5, 1.0, pill(800.0, 300.0)), (Dock::Top, 190.0));
    }

    #[test]
    fn a_floating_island_stays_where_it_was_left() {
        let float = |offset, float| Placement { offset, float, ..HOME };
        // High enough: the window moves with it and the island is drawn as usual.
        assert_eq!(frame(FHD, 1.0, float(0.0, 200.0), false), (600, 200, 720, 480));
        assert_eq!(shift(FHD, 1.0, float(0.0, 200.0)), (0.0, 0.0));
        // Low down the window stops at the bottom of the display, and the island
        // is drawn lower in it.
        assert_eq!(frame(FHD, 1.0, float(0.0, 700.0), false).1, 600);
        assert_eq!(shift(FHD, 1.0, float(0.0, 700.0)), (0.0, 100.0));
        // Near a corner, it is drawn off the window's middle.
        assert_eq!(shift(FHD, 1.0, float(-900.0, 200.0)), (-300.0, 0.0));
        // Growing up from the bottom edge.
        let up = Placement { dock: Dock::Bottom, float: 300.0, ..HOME };
        assert_eq!(frame(FHD, 1.0, up, false), (600, 300, 720, 480));
        assert_eq!(shift(FHD, 1.0, up), (0.0, 0.0));
        // Hidden, it slips into its edge like a docked island.
        assert_eq!(frame(FHD, 1.0, float(0.0, 200.0), true), (840, 0, 240, 6));
        // Docked on a side, there is nothing to float.
        assert_eq!(frame(FHD, 1.0, Placement { dock: Dock::Left, float: 300.0, ..HOME }, false), (0, 300, 720, 480));
    }

    #[test]
    fn the_island_centre_follows_its_edge() {
        // A 10 px gap from its edge.
        assert_eq!(centre_in_panel(Dock::Top, (720.0, 320.0), 288.0, 32.0, (0.0, 0.0)), (360.0, 26.0));
        assert_eq!(centre_in_panel(Dock::Bottom, (720.0, 320.0), 288.0, 32.0, (0.0, 0.0)), (360.0, 294.0));
        assert_eq!(centre_in_panel(Dock::Left, (720.0, 320.0), 32.0, 288.0, (0.0, 0.0)), (26.0, 160.0));
        assert_eq!(centre_in_panel(Dock::Right, (720.0, 320.0), 640.0, 160.0, (0.0, 0.0)), (390.0, 160.0));
        // Moved in its window, it is drawn that much further.
        assert_eq!(centre_in_panel(Dock::Top, (720.0, 320.0), 288.0, 32.0, (-200.0, 40.0)), (160.0, 66.0));
    }

    #[test]
    fn a_wider_or_taller_island_grows_the_window_round_its_place() {
        // 900 + 80 of room, rounded up to the next 40.
        assert_eq!(frame(FHD, 1.0, Placement { width: 900.0, ..HOME }, false), (460, 0, 1000, 480));
        // 500 + 20 of room + the 10 px gap, rounded up to the next 40.
        assert_eq!(frame(FHD, 1.0, Placement { height: 500.0, ..HOME }, false), (600, 0, 720, 560));
        // On a side the height needs room at both ends.
        assert_eq!(frame(FHD, 1.0, Placement { height: 500.0, dock: Dock::Left, ..HOME }, false), (0, 240, 720, 600));
        // Nothing narrower than the panel, and never more than the display.
        assert_eq!(frame(FHD, 1.0, Placement { width: 100.0, ..HOME }, false).2, 720);
        // The live activities beside it: room on both sides, the island still centred.
        assert_eq!(frame(FHD, 1.0, Placement { activities: (264.0, 0.0), ..HOME }, false), (320, 0, 1280, 480));
        assert_eq!(frame(FHD, 1.0, Placement { activities: (264.0, 0.0), dock: Dock::Left, ..HOME }, false).2, 720);
        assert_eq!(frame(FHD, 1.0, Placement { activities: (264.0, 600.0), ..HOME }, false).3, 640);
        assert_eq!(frame(FHD, 1.6, Placement { width: 1200.0, height: 640.0, ..HOME }, false), (0, 0, 1920, 1080));
        assert_eq!(frame(FHD, 1.0, Placement { width: f64::NAN, height: f64::NAN, offset: f64::NAN, ..HOME }, false), (600, 0, 720, 480));
    }

    #[test]
    fn a_grip_moves_the_size_it_holds_and_stops_at_the_limits() {
        let room = (1920.0, 1080.0);
        // A side whose opposite follows: 30 px out is 60 px wider.
        assert_eq!(resized(HOME, (2.0, 0.0), 300.0, (30.0, 0.0), room).width, 700.0);
        // A left grip: moving left (negative) widens.
        assert_eq!(resized(HOME, (-2.0, 0.0), 300.0, (-30.0, 0.0), room).width, 700.0);
        assert_eq!(resized(HOME, (2.0, 0.0), 300.0, (-500.0, 0.0), room).width, MIN_WIDTH);
        assert_eq!(resized(HOME, (2.0, 0.0), 300.0, (5000.0, 0.0), room).width, MAX_WIDTH);
        // A small display keeps the island inside it.
        assert_eq!(resized(HOME, (2.0, 0.0), 300.0, (5000.0, 0.0), (1000.0, 700.0)).width, 920.0);
        // The bottom starts from the height drawn and leaves the width alone.
        let tall = resized(HOME, (0.0, 1.0), 280.0, (400.0, 50.0), room);
        assert_eq!((tall.width, tall.height), (DEFAULT_WIDTH, 330.0));
        assert_eq!(resized(HOME, (0.0, 1.0), 280.0, (0.0, 900.0), (1920.0, 500.0)).height, 470.0);
        // A corner does both.
        let both = resized(HOME, (2.0, 1.0), 160.0, (20.0, 40.0), room);
        assert_eq!((both.width, both.height), (680.0, 200.0));
        // Never shorter than the smallest view.
        assert_eq!(resized(HOME, (0.0, 1.0), 160.0, (0.0, -100.0), room).height, MIN_HEIGHT);
    }

    #[test]
    fn the_bounce_overshoots_a_little_and_settles() {
        let mut a = Axis { x: 0.0, v: 0.0 };
        let mut most: f64 = 0.0;
        let mut steps = 0;
        while !a.settled(100.0) && steps < 1000 {
            a.step(100.0, 0.008);
            most = most.max(a.x);
            steps += 1;
        }
        assert!(steps < 200, "took {steps} steps");
        assert!(most > 101.0 && most < 130.0, "overshoot {most}");
    }

    #[test]
    fn docks_read_back_from_their_names() {
        for d in [Dock::Top, Dock::Bottom, Dock::Left, Dock::Right] {
            assert_eq!(Dock::parse(d.name()), d);
        }
        assert_eq!(Dock::parse("nonsense"), Dock::Top);
    }

    #[test]
    fn displays_get_plain_names_numbered_from_the_left() {
        let d = |x, y, w, h| DisplayId { name: r"\\.\DISPLAY5".into(), x, y, w, h };
        let ids = vec![d(0, 0, 2560, 1440), d(-1440, -87, 1440, 900), d(560, -1080, 1920, 1080)];
        let labels = display_labels(&ids, Some(0));
        assert_eq!(labels[1], "Display 1 — 1440×900 · on the left");
        assert_eq!(labels[0], "Display 2 — 2560×1440 · main");
        assert_eq!(labels[2], "Display 3 — 1920×1080 · above");
        assert_eq!(display_labels(&ids[..1], Some(0)), vec!["Display 1 — 2560×1440"]);
    }
}

/// Position, size and scale of the monitor the island lives on. Any change here
/// means the island has to be placed again.
fn current_screen_key(app: &AppHandle) -> Option<(i32, i32, u32, u32, u64)> {
    let pref = app
        .try_state::<crate::Shared>()
        .map(|s| s.settings.lock().unwrap().screen.clone())
        .unwrap_or_else(|| "primary".into());
    let m = target_monitor(app, &pref)?;
    let p = m.position();
    let size = m.size();
    Some((p.x, p.y, size.width, size.height, m.scale_factor().to_bits()))
}

/// Emits `cursor` (window-logical coordinates) at ~60 Hz while the island is
/// visible. Parked on a condvar the rest of the time.
pub fn spawn_cursor_poll(app: AppHandle, gate: Arc<PollGate>) {
    std::thread::spawn(move || {
        let mut was_down = false;
        // Remembered across wakes so a display change while hidden is noticed the
        // moment the island comes back.
        let mut last_screen: Option<(i32, i32, u32, u32, u64)> = None;
        // Without a cursor to read (Linux) the loop only watches the display
        // layout, and twice a second is plenty for that: waking at 60 Hz just to
        // find no cursor costs CPU for nothing.
        let (period, screen_every) = if platform::CURSOR_POLL { (16, 30) } else { (500, 1) };
        loop {
            gate.wait_until_active();
            let mut last = (f64::MIN, f64::MIN);
            // Claude clicking for the chat (computer.rs): the island lets the mouse through.
            let mut was_acting = false;
            let mut ticks: u32 = 0;
            while gate.is_active() {
                std::thread::sleep(Duration::from_millis(period));

                // Monitors get plugged in, unplugged, rearranged and rescaled, and
                // an island pinned to coordinates that no longer exist is an island
                // nobody can reach. Checked about twice a second — the cursor poll
                // is already running, so this costs one monitor query.
                ticks = ticks.wrapping_add(1);
                if ticks % screen_every == 0 {
                    let now = current_screen_key(&app);
                    if now.is_some() && now != last_screen {
                        let first = last_screen.is_none();
                        last_screen = now;
                        if !first {
                            crate::log::line("display layout changed — repositioning".to_string());
                            let _ = app.emit_to(WINDOW_LABEL, "screen-changed", ());
                        }
                    }
                }

                let Some(win) = window(&app) else { continue };
                let Ok(origin) = win.outer_position() else { continue };
                // Page pixels: the monitor's scale times the island's zoom.
                let scale = win.scale_factor().unwrap_or(1.0) * zoom();
                let Some((cx, cy)) = cursor_physical() else { continue };
                let x = (cx - origin.x as f64) / scale;
                let y = (cy - origin.y as f64) / scale;
                let size = match win.inner_size() {
                    Ok(s) => (s.width as f64 / scale, s.height as f64 / scale),
                    Err(_) => (PANEL_W, PANEL_H),
                };
                // Click-through: the window only takes the mouse over the island
                // shape. A small entry margin means the flag is already off by the
                // time a moving cursor reaches a button.
                let r = *gate.rect.lock().unwrap();
                let on_island = r.w > 0.0
                    && x >= r.x - HIT_MARGIN
                    && x <= r.x + r.w + HIT_MARGIN
                    && y >= r.y - HIT_MARGIN
                    && y <= r.y + r.h + HIT_MARGIN;

                // A press anywhere else on the screen: the open island may close
                // on it (Settings → Island → "On a click outside the island").
                // Read before the "has the cursor moved" check, since a click
                // often comes without a move. A press may also be the start of a
                // file drag: make sure the drop target is ours before it arrives.
                let down = left_button_down();
                let on_panel = crate::activities::cursor_over((cx, cy));
                let acting = crate::computer::acting();
                if down && !was_down && !acting {
                    if !on_island && !on_panel {
                        let _ = win.emit("outside-press", ());
                    }
                    let handle = app.clone();
                    let _ = app.run_on_main_thread(move || platform::unblock_webview_drops(&handle));
                }
                was_down = down;

                if (x - last.0).abs() < 1.0 && (y - last.1).abs() < 1.0 && acting == was_acting {
                    continue;
                }
                last = (x, y);
                was_acting = acting;

                // A file being dragged has to be able to find us. WS_EX_TRANSPARENT
                // — what click-through is on Windows — hides the window from
                // WindowFromPoint, so OLE finds no drop target and shows the "no
                // drop" cursor. macOS has no such problem: AppKit delivers drags to
                // registered destinations whatever ignoresMouseEvents says. So while
                // a button is held anywhere over the panel, the whole panel takes
                // the mouse, which also makes the drop zone as forgiving as the Mac's.
                let dragging = down
                    && x >= 0.0
                    && x <= size.0
                    && y >= 0.0
                    && y <= size.1;

                let accept = (on_island || dragging) && !acting;
                if gate.ignoring.load(Ordering::Relaxed) == accept {
                    gate.ignoring.store(!accept, Ordering::Relaxed);
                    let _ = win.set_ignore_cursor_events(!accept);
                }

                let _ = win.emit("cursor", CursorPayload { x, y, panel: on_panel });
            }
        }
    });
}

/// Re-applies click-through after the window or the island changed shape.
///
/// With the cursor poll (Windows) the window takes the mouse again and the next
/// tick decides from the cursor. Without it (Linux) the input region is set to
/// the island itself, or to the whole wake strip while collapsed.
pub fn refresh_click_through(app: &AppHandle, gate: &PollGate) {
    if platform::CURSOR_POLL {
        set_ignore_cursor(app, false);
        gate.forget_ignore_state();
        return;
    }
    let Some(win) = window(app) else { return };
    let region = if gate.collapsed.load(Ordering::Relaxed) {
        // The wake strip itself, never "the whole window": if the window ever
        // fails to shrink to the strip, the rest of it must not swallow clicks
        // meant for whatever sits under the top of the screen.
        Some((0.0, 0.0, STRIP_W, STRIP_H))
    } else {
        let r = *gate.rect.lock().unwrap();
        if r.w <= 0.0 {
            // Nothing drawn yet: nothing takes the mouse.
            Some((0.0, 0.0, 0.0, 0.0))
        } else {
            let x0 = (r.x - HIT_MARGIN).max(0.0);
            let y0 = (r.y - HIT_MARGIN).max(0.0);
            let x1 = r.x + r.w + HIT_MARGIN;
            let y1 = r.y + r.h + HIT_MARGIN;
            Some((x0, y0, x1 - x0, y1 - y0))
        }
    };
    // The region is in window pixels; the island is drawn zoomed.
    let z = zoom();
    let region = region.map(|(x, y, w, h)| (x * z, y * z, w * z, h * z));
    platform::set_input_region(&win, region);
}

/// Computer use (computer.rs): while Claude clicks or drags, the island and
/// its live activities let the mouse through to what is under them. Let go,
/// the cursor poll decides again (or, while the island is shut, the wake strip
/// takes the mouse as before).
pub fn let_mouse_through(app: &AppHandle, through: bool) {
    let gate = app.try_state::<crate::Shared>().map(|s| s.gate.clone());
    if through {
        if let Some(gate) = &gate {
            gate.ignoring.store(true, Ordering::Relaxed);
        }
        set_ignore_cursor(app, true);
    } else if let Some(gate) = gate.filter(|g| g.collapsed.load(Ordering::Relaxed) || !platform::CURSOR_POLL) {
        refresh_click_through(app, &gate);
    }
    if let Some(panel) = crate::activities::window(app) {
        let _ = panel.set_ignore_cursor_events(through);
    }
}

pub fn set_ignore_cursor(app: &AppHandle, ignore: bool) {
    if let Some(win) = window(app) {
        let _ = win.set_ignore_cursor_events(ignore);
    }
}
