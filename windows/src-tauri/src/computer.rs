// Computer use for the island chat's Claude Code (Settings → Chat → "Let
// Claude use the computer", off by default, Windows only).
//
// Claude Code starts `lumo-hook --mcp` as an MCP server (claude_code.rs passes
// it with `--mcp-config`); each of its tool calls comes here over the relay
// pipe as `{"lumo_computer": {"tool": …, "input": …}}` (pipe.rs) and is
// answered with one line: a screenshot, what was done, or why not.
//
// What keeps it in hand:
// * It works only while the setting is on and a chat turn that started with
//   it is running (`begin_turn` / `end_turn`); anything else is refused.
// * Every action that does something (a click, a key, typed text) goes through
//   Claude Code's permissions: asking every time, it is an Allow / Deny card
//   on the island first. Screenshots, zooms and waits only look.
// * Esc, pressed anywhere, stops it for the rest of the turn: the key is taken
//   for as long as Claude is acting, and every later call is refused.
// * Lumo's own windows are left out of screenshots and let the mouse through
//   while Claude clicks, and nothing is typed while the keyboard is in Lumo.
//
// While Claude uses the computer, the screen it works on glows (an overlay
// window, computer.html, click-through and left out of screenshots), its
// mouse is an orange arrow drawn here, gliding from point to point, and the
// user's own mouse is held still (a low-level hook drops what the hand does;
// what Claude sends goes through). When a card waits on the island, the hand
// gets the mouse back to answer it.
//
// One screen at a time: the one under the mouse at the first screenshot of a
// turn, or the one Claude asks for. Screenshots are scaled down to what every
// model reads in full (1456 px on the long edge, about 1.15 megapixels), and
// Claude's coordinates, in those pixels, are scaled back up before acting.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::i18n::t;

/// A screenshot's long edge, at most, and its pixels: what every model Claude
/// Code may run on reads without downscaling it.
const MAX_EDGE: f64 = 1456.0;
const MAX_PIXELS: f64 = 1_150_000.0;
/// A zoom shows a region at most this many times bigger than on screen.
const MAX_ZOOM: f64 = 4.0;
const MAX_TEXT: usize = 5000;
const MAX_WAIT_SECS: f64 = 60.0;

/// What Claude reads when the user pressed Esc.
const STOPPED_TEXT: &str = "The user pressed Esc to stop you using the computer. Don't use Lumo's computer tools again in this turn: say briefly what you did and stop.";

// ── State of the turn ───────────────────────────────────────────────────────

/// A chat turn with computer use is running.
static TURN: AtomicBool = AtomicBool::new(false);
/// The user pressed Esc during it.
static STOPPED: AtomicBool = AtomicBool::new(false);
/// An action is under way: the island lets the mouse through (island.rs).
static ACTING: AtomicBool = AtomicBool::new(false);
/// The Esc key is ours, for the rest of the turn.
static STOP_KEY: AtomicBool = AtomicBool::new(false);
/// The screen Claude is working on, and how its screenshots are scaled.
static VIEW: Mutex<Option<View>> = Mutex::new(None);
/// One action at a time.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
/// Claude is using the computer in this turn: the glow, the orange mouse, the hand held still.
static ENGAGED: AtomicBool = AtomicBool::new(false);
/// Cards waiting on the island meanwhile: the hand has the mouse to answer them.
static CARDS: AtomicUsize = AtomicUsize::new(0);

/// The overlay's window (computer.html).
pub const OVERLAY: &str = "computer";

/// A chat turn that may use the computer starts.
pub fn begin_turn() {
    STOPPED.store(false, Ordering::SeqCst);
    *VIEW.lock().unwrap_or_else(|e| e.into_inner()) = None;
    TURN.store(true, Ordering::SeqCst);
}

/// The turn is over: nothing more is done, and Esc and the mouse are the user's again.
pub fn end_turn<R: Runtime>(app: &AppHandle<R>) {
    TURN.store(false, Ordering::SeqCst);
    ACTING.store(false, Ordering::SeqCst);
    release_stop_key(app);
    disengage(app);
}

/// Claude starts using the computer in this turn: the screen glows, the
/// mouse turns orange and the hand lets go of it.
fn engage(app: &AppHandle) {
    if ENGAGED.swap(true, Ordering::SeqCst) {
        return;
    }
    CARDS.store(0, Ordering::SeqCst);
    let rect = VIEW
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .map(|v| v.rect)
        .or_else(|| {
            let rects = crate::screen::monitor_rects();
            crate::screen::display_under_cursor().and_then(|i| rects.get(i).copied()).or_else(|| rects.first().copied())
        });
    if let Some(rect) = rect {
        overlay_show(app, rect);
    }
    imp::take_mouse(true);
}

/// The glow goes, the mouse is the user's again (also after Esc).
fn disengage<R: Runtime>(app: &AppHandle<R>) {
    if !ENGAGED.swap(false, Ordering::SeqCst) {
        return;
    }
    imp::take_mouse(false);
    fx(app, json!({ "kind": "hide" }));
    let app = app.clone();
    std::thread::spawn(move || {
        // The glow fades before the window goes.
        std::thread::sleep(Duration::from_millis(500));
        if !ENGAGED.load(Ordering::SeqCst) {
            if let Some(win) = app.get_webview_window(OVERLAY) {
                let _ = win.hide();
            }
        }
    });
}

/// A card came up on the island during the turn (pipe.rs): the hand gets the
/// mouse back to answer it, and the glow dims.
pub fn card_up<R: Runtime>(app: &AppHandle<R>) {
    if !TURN.load(Ordering::SeqCst) {
        return;
    }
    if CARDS.fetch_add(1, Ordering::SeqCst) == 0 && ENGAGED.load(Ordering::SeqCst) {
        imp::take_mouse(false);
        fx(app, json!({ "kind": "pause" }));
    }
}

/// The card was answered: Claude has the mouse again.
pub fn card_down<R: Runtime>(app: &AppHandle<R>) {
    if !TURN.load(Ordering::SeqCst) {
        return;
    }
    let left = CARDS.fetch_sub(1, Ordering::SeqCst).saturating_sub(1);
    if left == 0 && ENGAGED.load(Ordering::SeqCst) && !STOPPED.load(Ordering::SeqCst) {
        imp::take_mouse(true);
        fx(app, json!({ "kind": "resume" }));
    }
}

/// Lumo was closed while Claude had the mouse: its arrow is the system's own
/// again (the hook went with the process).
pub fn recover() {
    imp::recover();
}

// ── The overlay ─────────────────────────────────────────────────────────────

/// Tells the overlay what to draw (src/computer/fx.ts says what each one is).
fn fx<R: Runtime>(app: &AppHandle<R>, payload: Value) {
    let _ = app.emit_to(OVERLAY, "computer-fx", payload);
}

fn overlay_url<R: Runtime>(app: &AppHandle<R>) -> WebviewUrl {
    #[cfg(dev)]
    if let Some(mut base) = app.config().build.dev_url.clone() {
        base.set_path("/computer.html");
        return WebviewUrl::External(base);
    }
    let _ = app;
    WebviewUrl::App("computer.html".into())
}

/// The overlay's window, made once: transparent, on top, never taking the
/// mouse or the keyboard, left out of screenshots.
fn overlay(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(win) = app.get_webview_window(OVERLAY) {
        return Some(win);
    }
    let win = WebviewWindowBuilder::new(app, OVERLAY, overlay_url(app))
        .additional_browser_args(crate::BROWSER_ARGS)
        .title("Lumo")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .disable_drag_drop_handler()
        .visible(false)
        .build()
        .map_err(|e| crate::log::line(format!("computer overlay failed: {e}")))
        .ok()?;
    let _ = win.set_ignore_cursor_events(true);
    let _ = win.set_content_protected(true);
    crate::platform::make_non_activating(&win);
    Some(win)
}

/// The overlay over the screen at `rect` (physical pixels), shown.
fn overlay_show(app: &AppHandle, rect: (i32, i32, i32, i32)) {
    let Some(win) = overlay(app) else { return };
    overlay_place(&win, rect);
    let _ = win.show();
    let _ = win.set_ignore_cursor_events(true);
    fx(app, json!({ "kind": "show" }));
}

fn overlay_place<R: Runtime>(win: &WebviewWindow<R>, rect: (i32, i32, i32, i32)) {
    let _ = win.set_position(tauri::PhysicalPosition::new(rect.0, rect.1));
    let _ = win.set_size(tauri::PhysicalSize::new((rect.2 - rect.0).max(1) as u32, (rect.3 - rect.1).max(1) as u32));
}

/// True while Claude is clicking or dragging: the island lets the mouse through.
pub fn acting() -> bool {
    ACTING.load(Ordering::Relaxed)
}

/// The global shortcut that stops computer use: Esc, while Claude acts.
pub fn is_stop_key(shortcut: &tauri_plugin_global_shortcut::Shortcut) -> bool {
    use tauri_plugin_global_shortcut::{Code, Modifiers};
    STOP_KEY.load(Ordering::Relaxed) && shortcut.key == Code::Escape && shortcut.mods == Modifiers::empty()
}

/// Esc was pressed: every later call of this turn is refused.
pub fn stop<R: Runtime>(app: &AppHandle<R>) {
    if !TURN.load(Ordering::SeqCst) || STOPPED.swap(true, Ordering::SeqCst) {
        return;
    }
    crate::log::line("computer use: stopped with Esc");
    release_stop_key(app);
    // The mouse is the user's at once; the glow turns red, then goes.
    imp::take_mouse(false);
    fx(app, json!({ "kind": "stopped" }));
    let _ = app.emit_to(crate::island::WINDOW_LABEL, "computer-stopped", ());
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(700));
        disengage(&app);
    });
}

fn stop_shortcut() -> tauri_plugin_global_shortcut::Shortcut {
    tauri_plugin_global_shortcut::Shortcut::new(None, tauri_plugin_global_shortcut::Code::Escape)
}

/// Takes Esc for the rest of the turn (again, should Settings have let go of every shortcut).
fn hold_stop_key<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let key = stop_shortcut();
    if !gs.is_registered(key) {
        match gs.register(key) {
            Ok(()) => STOP_KEY.store(true, Ordering::SeqCst),
            Err(err) => crate::log::line(format!("computer use: Esc not registered: {err}")),
        }
    } else {
        STOP_KEY.store(true, Ordering::SeqCst);
    }
}

fn release_stop_key<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    if STOP_KEY.swap(false, Ordering::SeqCst) {
        let _ = app.global_shortcut().unregister(stop_shortcut());
    }
}

// ── Pure parts ──────────────────────────────────────────────────────────────

/// The size a `w` × `h` screen is sent at: the same, or smaller, keeping its shape.
pub fn agent_size(w: u32, h: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (w, h);
    }
    let (wf, hf) = (w as f64, h as f64);
    let scale = 1f64.min(MAX_EDGE / wf.max(hf)).min((MAX_PIXELS / (wf * hf)).sqrt());
    (((wf * scale).round() as u32).max(1), ((hf * scale).round() as u32).max(1))
}

/// The size a region of `w` × `h` screen pixels is zoomed to: as big as a
/// screenshot may be, at most MAX_ZOOM times its size.
pub fn zoom_size(w: u32, h: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (w, h);
    }
    let (wf, hf) = (w as f64, h as f64);
    let scale = MAX_ZOOM.min(MAX_EDGE / wf.max(hf)).min((MAX_PIXELS / (wf * hf)).sqrt());
    (((wf * scale).round() as u32).max(1), ((hf * scale).round() as u32).max(1))
}

/// The screen Claude works on: its rectangle in physical pixels, and the size
/// of the screenshots it is sent.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct View {
    /// From 0, in menu order (screen.rs).
    pub display: usize,
    pub rect: (i32, i32, i32, i32),
    pub w: u32,
    pub h: u32,
}

impl View {
    pub fn new(display: usize, rect: (i32, i32, i32, i32)) -> View {
        let (w, h) = agent_size((rect.2 - rect.0).max(0) as u32, (rect.3 - rect.1).max(0) as u32);
        View { display, rect, w, h }
    }

    fn src(&self) -> (f64, f64) {
        ((self.rect.2 - self.rect.0) as f64, (self.rect.3 - self.rect.1) as f64)
    }

    /// A point of the screenshot on the screen, in physical pixels.
    pub fn to_screen(&self, x: i64, y: i64) -> Result<(i32, i32), String> {
        if x < 0 || y < 0 || x >= self.w as i64 || y >= self.h as i64 {
            return Err(format!(
                "({x}, {y}) is outside the screenshot, which is {}×{} pixels.",
                self.w, self.h
            ));
        }
        let (sw, sh) = self.src();
        let px = self.rect.0 + ((x as f64 + 0.5) * sw / self.w as f64).floor() as i32;
        let py = self.rect.1 + ((y as f64 + 0.5) * sh / self.h as f64).floor() as i32;
        Ok((px.min(self.rect.2 - 1), py.min(self.rect.3 - 1)))
    }

    /// A point of the screen in the screenshot's pixels (outside it when off this screen).
    pub fn from_screen(&self, px: i32, py: i32) -> (i64, i64) {
        let (sw, sh) = self.src();
        let x = ((px - self.rect.0) as f64 * self.w as f64 / sw).floor() as i64;
        let y = ((py - self.rect.1) as f64 * self.h as f64 / sh).floor() as i64;
        (x, y)
    }

    /// A region of the screenshot, `[x0, y0, x1, y1]`, on the screen.
    pub fn region(&self, r: [i64; 4]) -> Result<(i32, i32, i32, i32), String> {
        let [x0, y0, x1, y1] = r;
        if x1 <= x0 || y1 <= y0 {
            return Err("The region's second corner must be below and right of the first.".into());
        }
        let (sw, sh) = self.src();
        let clamp = |v: i64, max: u32| v.clamp(0, max as i64) as f64;
        let left = self.rect.0 + (clamp(x0, self.w) * sw / self.w as f64).floor() as i32;
        let top = self.rect.1 + (clamp(y0, self.h) * sh / self.h as f64).floor() as i32;
        let right = self.rect.0 + (clamp(x1, self.w) * sw / self.w as f64).ceil() as i32;
        let bottom = self.rect.1 + (clamp(y1, self.h) * sh / self.h as f64).ceil() as i32;
        if right <= left || bottom <= top {
            return Err(format!("That region is outside the screenshot, which is {}×{} pixels.", self.w, self.h));
        }
        Ok((left, top, right, bottom))
    }
}

/// Ease in and out (cubic), as the overlay's glow follows it (src/computer/fx.ts).
#[cfg_attr(not(windows), allow(dead_code))] // Linux moves no mouse yet
pub fn ease(t: f64) -> f64 {
    let x = t.clamp(0.0, 1.0);
    if x < 0.5 {
        4.0 * x * x * x
    } else {
        1.0 - (-2.0 * x + 2.0).powi(3) / 2.0
    }
}

/// How long the mouse takes to glide from `a` to `b` (ms): longer for longer
/// ways, never a crawl. Nothing when it is already there.
pub fn glide_ms(a: (i32, i32), b: (i32, i32)) -> u64 {
    let d = (((b.0 - a.0) as f64).powi(2) + ((b.1 - a.1) as f64).powi(2)).sqrt();
    if d < 2.0 {
        return 0;
    }
    (240.0 + 16.0 * d.sqrt()).clamp(220.0, 850.0) as u64
}

/// The orange arrow Claude's mouse wears, `size` × `size` straight RGBA, and
/// its tip (the hot spot). Drawn here: an arrow in Lumo's orange with a white
/// edge and a soft shadow.
#[cfg_attr(not(windows), allow(dead_code))] // Linux moves no mouse yet
pub fn arrow_pixels(size: u32) -> (Vec<u8>, (u32, u32)) {
    // The classic arrow, on a 32-pixel grid.
    const SHAPE: [(f64, f64); 7] = [(1.5, 1.5), (1.5, 23.5), (6.8, 18.6), (10.2, 26.4), (14.4, 24.6), (11.0, 17.2), (17.6, 17.2)];
    let k = size as f64 / 32.0;
    let pts: Vec<(f64, f64)> = SHAPE.iter().map(|(x, y)| (x * k, y * k)).collect();
    let edge = 1.15 * k.max(0.85);
    let inside = |x: f64, y: f64, dx: f64, dy: f64| -> bool {
        let mut c = false;
        let n = pts.len();
        for i in 0..n {
            let (xi, yi) = (pts[i].0 + dx, pts[i].1 + dy);
            let (xj, yj) = (pts[(i + n - 1) % n].0 + dx, pts[(i + n - 1) % n].1 + dy);
            if (yi > y) != (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi {
                c = !c;
            }
        }
        c
    };
    let dist = |x: f64, y: f64| -> f64 {
        let n = pts.len();
        (0..n)
            .map(|i| {
                let (a, b) = (pts[i], pts[(i + 1) % n]);
                let (vx, vy) = (b.0 - a.0, b.1 - a.1);
                let t = (((x - a.0) * vx + (y - a.1) * vy) / (vx * vx + vy * vy)).clamp(0.0, 1.0);
                ((x - a.0 - t * vx).powi(2) + (y - a.1 - t * vy).powi(2)).sqrt()
            })
            .fold(f64::MAX, f64::min)
    };
    const ORANGE: (f64, f64, f64) = (255.0, 138.0, 31.0);
    const SS: usize = 4;
    let mut out = vec![0u8; (size * size * 4) as usize];
    for py in 0..size {
        for px in 0..size {
            let (mut r, mut g, mut b, mut a) = (0.0, 0.0, 0.0, 0.0);
            for sy in 0..SS {
                for sx in 0..SS {
                    let x = px as f64 + (sx as f64 + 0.5) / SS as f64;
                    let y = py as f64 + (sy as f64 + 0.5) / SS as f64;
                    let (cr, cg, cb, ca) = if inside(x, y, 0.0, 0.0) {
                        if dist(x, y) <= edge {
                            (255.0, 255.0, 255.0, 1.0)
                        } else {
                            (ORANGE.0, ORANGE.1, ORANGE.2, 1.0)
                        }
                    } else if inside(x, y, 0.9 * k, 1.4 * k) {
                        (0.0, 0.0, 0.0, 0.24)
                    } else {
                        (0.0, 0.0, 0.0, 0.0)
                    };
                    r += cr * ca;
                    g += cg * ca;
                    b += cb * ca;
                    a += ca;
                }
            }
            let n = (SS * SS) as f64;
            let i = ((py * size + px) * 4) as usize;
            if a > 0.0 {
                out[i] = (r / a).round() as u8;
                out[i + 1] = (g / a).round() as u8;
                out[i + 2] = (b / a).round() as u8;
            }
            out[i + 3] = (a / n * 255.0).round() as u8;
        }
    }
    let hot = ((1.5 * k).round() as u32, (1.5 * k).round() as u32);
    (out, hot)
}

/// A key as the keyboard has it: a Windows virtual-key code, or a character
/// whose key depends on the layout.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Key {
    Vk(u16),
    Char(char),
}

pub const VK_SHIFT: u16 = 0x10;
pub const VK_CONTROL: u16 = 0x11;
pub const VK_MENU: u16 = 0x12;
pub const VK_LWIN: u16 = 0x5B;
pub const VK_RETURN: u16 = 0x0D;
pub const VK_TAB: u16 = 0x09;
pub const VK_ESCAPE: u16 = 0x1B;

/// One key's name, as Claude writes them (xdotool's names, and the usual ones).
fn key_of(name: &str) -> Option<Key> {
    let lower = name.to_ascii_lowercase();
    let vk = match lower.as_str() {
        "ctrl" | "control" | "control_l" | "control_r" => VK_CONTROL,
        "shift" | "shift_l" | "shift_r" => VK_SHIFT,
        "alt" | "alt_l" | "alt_r" | "option" | "menu_alt" => VK_MENU,
        "super" | "super_l" | "super_r" | "win" | "windows" | "cmd" | "command" | "meta" => VK_LWIN,
        "return" | "enter" | "kp_enter" => VK_RETURN,
        "tab" => VK_TAB,
        "escape" | "esc" => VK_ESCAPE,
        "backspace" | "back_space" => 0x08,
        "delete" | "del" => 0x2E,
        "insert" | "ins" => 0x2D,
        "home" => 0x24,
        "end" => 0x23,
        "page_up" | "pageup" | "prior" | "pgup" => 0x21,
        "page_down" | "pagedown" | "next" | "pgdn" => 0x22,
        "up" | "arrowup" | "uparrow" => 0x26,
        "down" | "arrowdown" | "downarrow" => 0x28,
        "left" | "arrowleft" | "leftarrow" => 0x25,
        "right" | "arrowright" | "rightarrow" => 0x27,
        "space" => 0x20,
        "menu" | "apps" | "contextmenu" => 0x5D,
        "print" | "printscreen" | "print_screen" | "sys_req" => 0x2C,
        "caps_lock" | "capslock" => 0x14,
        "num_lock" | "numlock" => 0x90,
        "scroll_lock" | "scrolllock" => 0x91,
        "pause" | "break" => 0x13,
        "plus" => return Some(Key::Char('+')),
        "minus" => return Some(Key::Char('-')),
        "equal" | "equals" => return Some(Key::Char('=')),
        "comma" => return Some(Key::Char(',')),
        "period" | "dot" => return Some(Key::Char('.')),
        "slash" => return Some(Key::Char('/')),
        "backslash" => return Some(Key::Char('\\')),
        "semicolon" => return Some(Key::Char(';')),
        "apostrophe" | "quote" => return Some(Key::Char('\'')),
        "grave" | "backtick" => return Some(Key::Char('`')),
        "bracketleft" => return Some(Key::Char('[')),
        "bracketright" => return Some(Key::Char(']')),
        _ => {
            if let Some(n) = lower.strip_prefix('f').and_then(|n| n.parse::<u16>().ok()).filter(|n| (1..=24).contains(n)) {
                return Some(Key::Vk(0x70 + n - 1));
            }
            let mut chars = name.chars();
            let (Some(c), None) = (chars.next(), chars.next()) else { return None };
            return Some(match c.to_ascii_uppercase() {
                u @ 'A'..='Z' => Key::Vk(u as u16),
                d @ '0'..='9' => Key::Vk(d as u16),
                other => Key::Char(other),
            });
        }
    };
    Some(Key::Vk(vk))
}

/// "ctrl+shift+t" as keys to press in order (and let go of in reverse).
pub fn parse_keys(text: &str) -> Result<Vec<Key>, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Say which key to press.".into());
    }
    // "ctrl++": a plus after a plus is the key itself.
    let mut names: Vec<String> = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        match rest.find('+') {
            Some(0) => {
                names.push("+".into());
                rest = &rest[1..];
                rest = rest.strip_prefix('+').map(|r| if r.is_empty() { r } else { rest }).unwrap_or(rest);
            }
            Some(i) => {
                names.push(rest[..i].trim().to_string());
                rest = &rest[i + 1..];
            }
            None => {
                names.push(rest.trim().to_string());
                rest = "";
            }
        }
    }
    names
        .iter()
        .filter(|n| !n.is_empty())
        .map(|n| if n == "+" { Some(Key::Char('+')) } else { key_of(n) }.ok_or_else(|| format!("Unknown key: {n}.")))
        .collect()
}

/// Keys whose scan code is an extended one (arrows, the editing block, the Windows keys…).
#[cfg_attr(not(windows), allow(dead_code))] // Linux types nothing yet
pub fn is_extended(vk: u16) -> bool {
    matches!(vk, 0x21..=0x28 | 0x2C | 0x2D | 0x2E | 0x5B | 0x5C | 0x5D | 0x6F | 0x90 | 0xA3 | 0xA5)
}

/// A mouse button.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Button {
    Left,
    Right,
    Middle,
}

/// One tool call, read and checked.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Screenshot { display: Option<usize> },
    Zoom { region: [i64; 4] },
    Click { at: Option<(i64, i64)>, button: Button, count: u32, hold: Vec<Key> },
    Move { at: (i64, i64) },
    Drag { from: (i64, i64), to: (i64, i64) },
    Scroll { at: Option<(i64, i64)>, dx: i32, dy: i32, hold: Vec<Key> },
    Type { text: String },
    Keys { keys: Vec<Key>, repeat: u32, label: String },
    Wait { secs: f64 },
    Cursor,
}

impl Action {
    /// Only looks: no card, no Esc taken.
    pub fn looks(&self) -> bool {
        matches!(self, Action::Screenshot { .. } | Action::Zoom { .. } | Action::Wait { .. } | Action::Cursor)
    }
}

fn point(input: &Value, key: &str) -> Result<Option<(i64, i64)>, String> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(a)) if a.len() == 2 => match (a[0].as_f64(), a[1].as_f64()) {
            (Some(x), Some(y)) if x.is_finite() && y.is_finite() => Ok(Some((x.round() as i64, y.round() as i64))),
            _ => Err(format!("{key} must be two numbers, [x, y].")),
        },
        Some(_) => Err(format!("{key} must be two numbers, [x, y].")),
    }
}

fn held(input: &Value) -> Result<Vec<Key>, String> {
    match input.get("text").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
        Some(text) => parse_keys(text),
        None => Ok(Vec::new()),
    }
}

/// The action a tool call asks for, or why it can't be done.
pub fn parse(tool: &str, input: &Value) -> Result<Action, String> {
    let need = |key: &str| point(input, key)?.ok_or_else(|| format!("{key} is missing."));
    let click = |button: Button, count: u32| -> Result<Action, String> {
        Ok(Action::Click { at: point(input, "coordinate")?, button, count, hold: held(input)? })
    };
    match tool {
        "screenshot" => {
            let display = match input.get("display").and_then(Value::as_u64) {
                Some(0) => return Err("Screens are numbered from 1.".into()),
                Some(n) => Some(n as usize - 1),
                None => None,
            };
            Ok(Action::Screenshot { display })
        }
        "zoom" => {
            let r = input.get("region").and_then(Value::as_array).filter(|a| a.len() == 4).ok_or("region must be [x0, y0, x1, y1].")?;
            let mut region = [0i64; 4];
            for (i, v) in r.iter().enumerate() {
                region[i] = v.as_f64().filter(|f| f.is_finite()).ok_or("region must be four numbers.")?.round() as i64;
            }
            Ok(Action::Zoom { region })
        }
        "left_click" => click(Button::Left, 1),
        "right_click" => click(Button::Right, 1),
        "middle_click" => click(Button::Middle, 1),
        "double_click" => click(Button::Left, 2),
        "triple_click" => click(Button::Left, 3),
        "mouse_move" => Ok(Action::Move { at: need("coordinate")? }),
        "left_click_drag" => Ok(Action::Drag { from: need("start_coordinate")?, to: need("coordinate")? }),
        "scroll" => {
            let amount = input.get("scroll_amount").and_then(Value::as_i64).unwrap_or(3).clamp(1, 30) as i32;
            let (dx, dy) = match input.get("scroll_direction").and_then(Value::as_str) {
                Some("up") => (0, amount),
                Some("down") => (0, -amount),
                Some("left") => (-amount, 0),
                Some("right") => (amount, 0),
                _ => return Err("scroll_direction must be up, down, left or right.".into()),
            };
            Ok(Action::Scroll { at: point(input, "coordinate")?, dx, dy, hold: held(input)? })
        }
        "type" => {
            let text = input.get("text").and_then(Value::as_str).unwrap_or("");
            if text.is_empty() {
                return Err("There is no text to type.".into());
            }
            if text.chars().count() > MAX_TEXT {
                return Err(format!("At most {MAX_TEXT} characters at a time."));
            }
            Ok(Action::Type { text: text.to_string() })
        }
        "key" => {
            let label = input.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
            let keys = parse_keys(&label)?;
            let repeat = input.get("repeat").and_then(Value::as_u64).unwrap_or(1).clamp(1, 100) as u32;
            Ok(Action::Keys { keys, repeat, label })
        }
        "wait" => {
            let secs = input.get("duration").and_then(Value::as_f64).filter(|s| s.is_finite()).unwrap_or(1.0);
            Ok(Action::Wait { secs: secs.clamp(0.0, MAX_WAIT_SECS) })
        }
        "cursor_position" => Ok(Action::Cursor),
        other => Err(format!("Lumo has no tool called {other}.")),
    }
}

// ── Serving the calls ───────────────────────────────────────────────────────

/// What goes back to lumo-hook: `{"text"…, "image"…}` or `{"error"…}`.
fn refuse(message: impl Into<String>) -> Value {
    json!({ "error": message.into() })
}

/// One tool call from lumo-hook (pipe.rs), answered.
pub async fn serve(app: &AppHandle, request: &Value) -> Value {
    let tool = request.get("tool").and_then(Value::as_str).unwrap_or("").to_string();
    let input = request.get("input").cloned().unwrap_or_else(|| json!({}));
    if !cfg!(windows) {
        return refuse(t("Not available on Linux yet."));
    }
    let on = app.state::<crate::Shared>().settings.lock().unwrap().chat_computer_use;
    if !on {
        return refuse("Computer use is off in Lumo. The user can turn it on in Lumo's Settings, under Chat: Let Claude use the computer.");
    }
    if !TURN.load(Ordering::SeqCst) {
        return refuse("Lumo lets Claude use the computer only while it answers in the island's chat.");
    }
    if STOPPED.load(Ordering::SeqCst) {
        return refuse(STOPPED_TEXT);
    }
    let action = match parse(&tool, &input) {
        Ok(a) => a,
        Err(e) => return refuse(e),
    };
    // The glow, the orange mouse and the hand held still, from Claude's first call on.
    engage(app);
    if !action.looks() {
        hold_stop_key(app);
    }
    let app2 = app.clone();
    let answer = tauri::async_runtime::spawn_blocking(move || {
        let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
        perform(&app2, action)
    })
    .await
    .unwrap_or_else(|e| Err(e.to_string()));
    match answer {
        Ok(v) => v,
        Err(e) if STOPPED.load(Ordering::SeqCst) => refuse(format!("{e} {STOPPED_TEXT}")),
        Err(e) => refuse(e),
    }
}

/// The screen in use, picked at the first screenshot of the turn.
fn view() -> Result<View, String> {
    VIEW.lock()
        .unwrap_or_else(|e| e.into_inner())
        .ok_or_else(|| "Take a screenshot first: coordinates are in its pixels.".to_string())
}

fn base64(bytes: &[u8]) -> String {
    crate::claude::base64_for(bytes)
}

/// Lumo's windows let the mouse through while `f` clicks or drags.
fn hands_off<T>(app: &AppHandle, f: impl FnOnce() -> T) -> T {
    ACTING.store(true, Ordering::SeqCst);
    crate::island::let_mouse_through(app, true);
    std::thread::sleep(Duration::from_millis(40));
    let out = f();
    // The last click lands before the island takes the mouse back.
    std::thread::sleep(Duration::from_millis(80));
    ACTING.store(false, Ordering::SeqCst);
    crate::island::let_mouse_through(app, false);
    out
}

/// The island lets go of the keyboard (an Allow clicked on its card may have
/// taken it back to the chat), so it goes to the window Claude clicked last.
fn keyboard_back(app: &AppHandle) {
    if let Some(win) = crate::island::window(app) {
        crate::platform::set_activating(&win, false);
    }
    imp::refocus_target();
}

fn stopped() -> bool {
    STOPPED.load(Ordering::SeqCst)
}

/// A point of the screen, from the overlay's top left corner (physical pixels).
fn rel(view: &View, p: (i32, i32)) -> [i32; 2] {
    [p.0 - view.rect.0, p.1 - view.rect.1]
}

/// Where Claude's mouse is now (or `fallback`), from the overlay's corner.
fn mouse_rel(view: &View, fallback: (i32, i32)) -> [i32; 2] {
    rel(view, imp::cursor().unwrap_or(fallback))
}

/// The mouse glides to `to`, and the overlay's glow with it.
fn glide_to(app: &AppHandle, view: &View, to: (i32, i32)) -> Result<(), String> {
    let from = imp::cursor().unwrap_or(to);
    let ms = glide_ms(from, to);
    if ms > 0 {
        fx(app, json!({ "kind": "move", "from": rel(view, from), "to": rel(view, to), "ms": ms }));
    }
    imp::glide(from, to, ms, &stopped)
}

fn perform(app: &AppHandle, action: Action) -> Result<Value, String> {
    match action {
        Action::Screenshot { display } => {
            let rects = crate::screen::monitor_rects();
            if rects.is_empty() {
                return Err(t("Not available on Linux yet."));
            }
            let current = VIEW.lock().unwrap_or_else(|e| e.into_inner()).map(|v| v.display);
            let index = display.or(current).or_else(crate::screen::display_under_cursor).unwrap_or(0);
            let Some(&rect) = rects.get(index) else {
                return Err(format!("There are {} screens: pick one from 1 to {}.", rects.len(), rects.len()));
            };
            let view = View::new(index, rect);
            let png = crate::screen::unseen(app, |hidden| crate::screen::grab_png(rect, view.w, view.h, hidden))?;
            let moved = VIEW.lock().unwrap_or_else(|e| e.into_inner()).replace(view).is_none_or(|v| v.rect != rect);
            // Another screen: the glow goes with Claude.
            if moved {
                if let Some(win) = app.get_webview_window(OVERLAY) {
                    overlay_place(&win, rect);
                }
            }
            fx(app, json!({ "kind": "look" }));
            Ok(json!({
                "image": base64(&png),
                "text": format!(
                    "Screen {} of {}, {}×{} pixels (Lumo's island is left out). Coordinates for the other tools are in these pixels.",
                    index + 1, rects.len(), view.w, view.h
                ),
            }))
        }
        Action::Zoom { region } => {
            let view = view()?;
            let rect = view.region(region)?;
            let (w, h) = zoom_size((rect.2 - rect.0) as u32, (rect.3 - rect.1) as u32);
            let png = crate::screen::unseen(app, |hidden| crate::screen::grab_png(rect, w, h, hidden))?;
            fx(app, json!({ "kind": "look" }));
            Ok(json!({
                "image": base64(&png),
                "text": format!("The region [{}, {}, {}, {}], enlarged. Coordinates stay those of the full screenshot.", region[0], region[1], region[2], region[3]),
            }))
        }
        Action::Click { at, button, count, hold } => {
            let view = view()?;
            let target = at.map(|(x, y)| view.to_screen(x, y)).transpose()?;
            hands_off(app, || {
                if let Some(t) = target {
                    glide_to(app, &view, t)?;
                }
                if stopped() {
                    return Err("Stopped before the click.".to_string());
                }
                let here = imp::cursor().or(target).unwrap_or((view.rect.0, view.rect.1));
                let name = match button {
                    Button::Left => "left",
                    Button::Right => "right",
                    Button::Middle => "middle",
                };
                fx(app, json!({ "kind": "click", "at": rel(&view, here), "button": name, "count": count }));
                imp::click(button, count, &hold)
            })?;
            Ok(json!({ "text": "Done. Take a screenshot to see what changed." }))
        }
        Action::Move { at } => {
            let view = view()?;
            let to = view.to_screen(at.0, at.1)?;
            hands_off(app, || glide_to(app, &view, to))?;
            Ok(json!({ "text": "Done." }))
        }
        Action::Drag { from, to } => {
            let view = view()?;
            let (a, b) = (view.to_screen(from.0, from.1)?, view.to_screen(to.0, to.1)?);
            hands_off(app, || {
                glide_to(app, &view, a)?;
                let ms = glide_ms(a, b).max(300) + 150;
                fx(app, json!({ "kind": "drag", "from": rel(&view, a), "to": rel(&view, b), "ms": ms }));
                imp::drag(a, b, ms)
            })?;
            Ok(json!({ "text": "Done. Take a screenshot to see what changed." }))
        }
        Action::Scroll { at, dx, dy, hold } => {
            let view = view()?;
            let target = at.map(|(x, y)| view.to_screen(x, y)).transpose()?;
            hands_off(app, || {
                if let Some(t) = target {
                    glide_to(app, &view, t)?;
                }
                fx(app, json!({ "kind": "scroll", "at": mouse_rel(&view, (view.rect.0, view.rect.1)), "dx": dx, "dy": dy }));
                imp::scroll(dx, dy, &hold, &stopped)
            })?;
            Ok(json!({ "text": "Done." }))
        }
        Action::Type { text } => {
            keyboard_back(app);
            if let Ok(view) = view() {
                fx(app, json!({ "kind": "type", "at": mouse_rel(&view, (view.rect.0, view.rect.1)), "text": text }));
            }
            let typed = imp::type_text(&text, &stopped)?;
            Ok(json!({ "text": format!("Typed {typed} characters.") }))
        }
        Action::Keys { keys, repeat, label } => {
            keyboard_back(app);
            if let Ok(view) = view() {
                fx(app, json!({ "kind": "key", "at": mouse_rel(&view, (view.rect.0, view.rect.1)), "keys": label }));
            }
            // Esc is ours while Claude acts: let go of it while Claude presses it.
            let escape = keys.contains(&Key::Vk(VK_ESCAPE));
            if escape {
                release_stop_key(app);
            }
            let result = imp::press(&keys, repeat, &stopped);
            if escape && !stopped() {
                hold_stop_key(app);
            }
            result?;
            Ok(json!({ "text": "Done." }))
        }
        Action::Wait { secs } => {
            if let Ok(view) = view() {
                let ms = (secs * 1000.0) as u64;
                fx(app, json!({ "kind": "wait", "at": mouse_rel(&view, (view.rect.0, view.rect.1)), "ms": ms }));
            }
            let until = std::time::Instant::now() + Duration::from_secs_f64(secs);
            while std::time::Instant::now() < until && !stopped() {
                std::thread::sleep(Duration::from_millis(100));
            }
            Ok(json!({ "text": "Done waiting." }))
        }
        Action::Cursor => {
            let view = view()?;
            let (px, py) = imp::cursor().ok_or("The mouse can't be found.")?;
            let (x, y) = view.from_screen(px, py);
            let off = x < 0 || y < 0 || x >= view.w as i64 || y >= view.h as i64;
            Ok(json!({ "text": if off { format!("[{x}, {y}] — outside this screen.") } else { format!("[{x}, {y}]") } }))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    fn unavailable<T>() -> Result<T, String> {
        Err(t("Not available on Linux yet."))
    }

    pub fn cursor() -> Option<(i32, i32)> {
        None
    }
    pub fn glide(_from: (i32, i32), _to: (i32, i32), _ms: u64, _stop: &dyn Fn() -> bool) -> Result<(), String> {
        unavailable()
    }
    pub fn click(_b: Button, _count: u32, _hold: &[Key]) -> Result<(), String> {
        unavailable()
    }
    pub fn drag(_a: (i32, i32), _b: (i32, i32), _ms: u64) -> Result<(), String> {
        unavailable()
    }
    pub fn scroll(_dx: i32, _dy: i32, _hold: &[Key], _stop: &dyn Fn() -> bool) -> Result<(), String> {
        unavailable()
    }
    pub fn take_mouse(_on: bool) {}
    pub fn recover() {}
    pub fn type_text(_text: &str, _stop: &dyn Fn() -> bool) -> Result<usize, String> {
        unavailable()
    }
    pub fn press(_keys: &[Key], _repeat: u32, _stop: &dyn Fn() -> bool) -> Result<(), String> {
        unavailable()
    }
    pub fn refocus_target() {}
}

#[cfg(windows)]
mod imp {
    use super::*;

    use ::windows::Win32::Foundation::POINT;
    use ::windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, VkKeyScanW, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN,
        MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
        MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
    };
    use ::windows::Win32::Foundation::HWND;
    use ::windows::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetForegroundWindow, GetWindowThreadProcessId, IsWindow, SetCursorPos, SetForegroundWindow,
    };
    use std::sync::atomic::AtomicIsize;

    /// The window in front after Claude's last click or drag, when not Lumo's.
    static TARGET: AtomicIsize = AtomicIsize::new(0);

    /// Remembers the window Claude's click brought to the front.
    fn note_target() {
        std::thread::sleep(Duration::from_millis(60));
        let front = unsafe { GetForegroundWindow() };
        if !front.is_invalid() && !is_lumo(front) {
            TARGET.store(front.0 as isize, Ordering::Relaxed);
        }
    }

    fn is_lumo(hwnd: HWND) -> bool {
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        pid == std::process::id()
    }

    /// Lumo has the keyboard: back to the window Claude clicked last, if it is still there.
    pub fn refocus_target() {
        if !lumo_in_front() {
            return;
        }
        let target = HWND(TARGET.load(Ordering::Relaxed) as *mut _);
        if target.is_invalid() || !unsafe { IsWindow(Some(target)) }.as_bool() {
            return;
        }
        // Lumo is in front, so Windows lets it hand the front over.
        let _ = unsafe { SetForegroundWindow(target) };
        std::thread::sleep(Duration::from_millis(80));
    }

    /// UTF-16 units typed at once; a pause between batches lets slow apps keep up.
    const BATCH: usize = 24;
    const PAUSE: Duration = Duration::from_millis(8);
    const WHEEL_DELTA: i32 = 120;

    fn send(inputs: &[INPUT]) -> bool {
        unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) as usize == inputs.len() }
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS, data: i32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 { mi: MOUSEINPUT { dx: 0, dy: 0, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        }
    }

    fn key_input(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        }
    }

    /// A key as virtual-key code and the Shift, Ctrl, Alt it needs on this layout.
    fn resolve(key: Key) -> Result<(u16, Vec<u16>), String> {
        match key {
            Key::Vk(vk) => Ok((vk, Vec::new())),
            Key::Char(c) => {
                let mut units = [0u16; 2];
                let encoded = c.encode_utf16(&mut units);
                if encoded.len() != 1 {
                    return Err(format!("No key types {c} on this keyboard."));
                }
                let scan = unsafe { VkKeyScanW(units[0]) };
                if scan == -1 {
                    return Err(format!("No key types {c} on this keyboard."));
                }
                let vk = (scan as u16) & 0xFF;
                let shifts = (scan as u16) >> 8;
                let mut mods = Vec::new();
                if shifts & 1 != 0 {
                    mods.push(VK_SHIFT);
                }
                if shifts & 2 != 0 {
                    mods.push(VK_CONTROL);
                }
                if shifts & 4 != 0 {
                    mods.push(VK_MENU);
                }
                Ok((vk, mods))
            }
        }
    }

    fn vk_event(vk: u16, up: bool) -> INPUT {
        let mut flags = if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) };
        if is_extended(vk) {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        key_input(vk, 0, flags)
    }

    /// Holds `keys` down (in order), runs `f`, lets them go (in reverse).
    fn holding<T>(keys: &[Key], f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let mut vks = Vec::new();
        for k in keys {
            let (vk, mods) = resolve(*k)?;
            vks.extend(mods);
            vks.push(vk);
        }
        let down: Vec<INPUT> = vks.iter().map(|vk| vk_event(*vk, false)).collect();
        if !down.is_empty() && !send(&down) {
            return Err("Windows refused the keys.".into());
        }
        let out = f();
        let up: Vec<INPUT> = vks.iter().rev().map(|vk| vk_event(*vk, true)).collect();
        if !up.is_empty() {
            send(&up);
        }
        out
    }

    /// The keyboard is in one of Lumo's own windows (the island's chat).
    fn lumo_in_front() -> bool {
        let front = unsafe { GetForegroundWindow() };
        !front.is_invalid() && is_lumo(front)
    }

    fn keyboard_ready() -> Result<(), String> {
        if lumo_in_front() {
            return Err("The keyboard is in Lumo's island: click the window to type in first.".into());
        }
        if !crate::selection::keys_released(Duration::from_secs(2)) {
            return Err("The user is holding keys down: try again in a moment.".into());
        }
        Ok(())
    }

    pub fn cursor() -> Option<(i32, i32)> {
        let mut p = POINT::default();
        unsafe { GetCursorPos(&mut p) }.ok()?;
        Some((p.x, p.y))
    }

    /// The mouse glides from `from` to `to` in `ms`, on the overlay's curve.
    pub fn glide(from: (i32, i32), to: (i32, i32), ms: u64, stop: &dyn Fn() -> bool) -> Result<(), String> {
        let start = std::time::Instant::now();
        let total = ms as f64;
        while ms > 0 {
            let t = start.elapsed().as_secs_f64() * 1000.0 / total;
            if t >= 1.0 || stop() {
                break;
            }
            let e = ease(t);
            let x = from.0 + ((to.0 - from.0) as f64 * e).round() as i32;
            let y = from.1 + ((to.1 - from.1) as f64 * e).round() as i32;
            let _ = unsafe { SetCursorPos(x, y) };
            std::thread::sleep(Duration::from_millis(6));
        }
        if stop() {
            return Err("Stopped.".into());
        }
        unsafe { SetCursorPos(to.0, to.1) }.map_err(|_| "Windows refused to move the mouse.".to_string())?;
        std::thread::sleep(Duration::from_millis(30));
        Ok(())
    }

    fn flags(button: Button) -> (MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS) {
        match button {
            Button::Left => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
            Button::Right => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            Button::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        }
    }

    pub fn click(button: Button, count: u32, hold: &[Key]) -> Result<(), String> {
        let (down, up) = flags(button);
        holding(hold, || {
            for i in 0..count {
                if i > 0 {
                    std::thread::sleep(Duration::from_millis(40));
                }
                if !send(&[mouse(down, 0), mouse(up, 0)]) {
                    return Err("Windows refused the click.".into());
                }
            }
            Ok(())
        })?;
        note_target();
        Ok(())
    }

    /// Presses at `a`, glides to `b` in `ms` (the app sees a drag, not a jump), lets go.
    pub fn drag(a: (i32, i32), b: (i32, i32), ms: u64) -> Result<(), String> {
        if !send(&[mouse(MOUSEEVENTF_LEFTDOWN, 0)]) {
            return Err("Windows refused the click.".into());
        }
        std::thread::sleep(Duration::from_millis(80));
        // Never stopped half way: the button has to come up.
        let moved = glide(a, b, ms.saturating_sub(140), &|| false);
        std::thread::sleep(Duration::from_millis(60));
        send(&[mouse(MOUSEEVENTF_LEFTUP, 0)]);
        note_target();
        moved
    }

    pub fn scroll(dx: i32, dy: i32, hold: &[Key], stop: &dyn Fn() -> bool) -> Result<(), String> {
        holding(hold, || {
            let (flag, steps, sign) = if dy != 0 { (MOUSEEVENTF_WHEEL, dy.abs(), dy.signum()) } else { (MOUSEEVENTF_HWHEEL, dx.abs(), dx.signum()) };
            for _ in 0..steps {
                if stop() {
                    break;
                }
                send(&[mouse(flag, sign * WHEEL_DELTA)]);
                std::thread::sleep(Duration::from_millis(20));
            }
            Ok(())
        })
    }

    // ── Claude's mouse: the orange arrow, and the hand held still ────────────

    use ::windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use ::windows::Win32::Graphics::Gdi::{
        CreateBitmap, CreateDIBSection, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use ::windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use ::windows::Win32::System::Threading::GetCurrentThreadId;
    use ::windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, CopyIcon, CreateIconIndirect, DestroyIcon, GetMessageW, GetSystemMetrics, PostThreadMessageW,
        SetSystemCursor, SetWindowsHookExW, SystemParametersInfoW, UnhookWindowsHookEx, HCURSOR, HICON, ICONINFO,
        LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, SM_CXCURSOR, SPI_SETCURSORS, SYSTEM_CURSOR_ID,
        SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, WH_MOUSE_LL, WM_QUIT,
    };
    use std::sync::atomic::AtomicU32;

    /// The system's cursors Claude's arrow stands in for: the arrow, the text
    /// beam, the hand, the busy ones, the resize ones… so it stays orange
    /// whatever it is over.
    const CURSORS: &[u32] = &[32512, 32513, 32514, 32515, 32516, 32642, 32643, 32644, 32645, 32646, 32648, 32649, 32650, 32651];

    /// The hand's mouse is held still (the hook drops what it does).
    static HELD: AtomicBool = AtomicBool::new(false);
    /// The thread that runs the hook, while there is one.
    static HOOK_THREAD: AtomicU32 = AtomicU32::new(0);
    /// The arrow is orange now.
    static ORANGE: AtomicBool = AtomicBool::new(false);

    /// Marks that the system's cursors were swapped, for `recover` after a crash.
    fn marker() -> std::path::PathBuf {
        crate::settings::local_dir().join("computer-cursor")
    }

    /// Claude takes the mouse (the orange arrow, the hand held still), or gives it back.
    pub fn take_mouse(on: bool) {
        // From the turn, the cards and Esc at once: one change at a time.
        static ONE: Mutex<()> = Mutex::new(());
        let _one = ONE.lock().unwrap_or_else(|e| e.into_inner());
        HELD.store(on, Ordering::SeqCst);
        if on {
            start_hook();
        } else {
            stop_hook();
        }
        orange(on);
    }

    pub fn recover() {
        stop_hook();
        if marker().exists() {
            restore_cursors();
        }
    }

    fn restore_cursors() {
        unsafe {
            let _ = SystemParametersInfoW(SPI_SETCURSORS, 0, None, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0));
        }
        let _ = std::fs::remove_file(marker());
    }

    fn orange(on: bool) {
        if ORANGE.swap(on, Ordering::SeqCst) == on {
            return;
        }
        if !on {
            restore_cursors();
            return;
        }
        let Some(arrow) = make_arrow() else {
            ORANGE.store(false, Ordering::SeqCst);
            return;
        };
        let _ = std::fs::write(marker(), b"1");
        for id in CURSORS {
            // SetSystemCursor keeps (and later destroys) the handle it is given: a copy each.
            if let Ok(copy) = unsafe { CopyIcon(arrow) } {
                let _ = unsafe { SetSystemCursor(HCURSOR(copy.0), SYSTEM_CURSOR_ID(*id)) };
            }
        }
        let _ = unsafe { DestroyIcon(arrow) };
    }

    /// The orange arrow (super::arrow_pixels) as a cursor of the system's size.
    fn make_arrow() -> Option<HICON> {
        let size = unsafe { GetSystemMetrics(SM_CXCURSOR) }.clamp(32, 256) as u32;
        let (rgba, hot) = super::arrow_pixels(size);
        unsafe {
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: size as i32,
                    biHeight: -(size as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            let color = CreateDIBSection(None, &info, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
            if bits.is_null() {
                let _ = DeleteObject(color.into());
                return None;
            }
            // BGRA, straight alpha, as a 32-bit cursor takes it.
            let dst = std::slice::from_raw_parts_mut(bits as *mut u8, rgba.len());
            for (d, s) in dst.chunks_exact_mut(4).zip(rgba.chunks_exact(4)) {
                d.copy_from_slice(&[s[2], s[1], s[0], s[3]]);
            }
            let mask = CreateBitmap(size as i32, size as i32, 1, 1, None);
            let icon = CreateIconIndirect(&ICONINFO { fIcon: false.into(), xHotspot: hot.0, yHotspot: hot.1, hbmMask: mask, hbmColor: color });
            let _ = DeleteObject(color.into());
            let _ = DeleteObject(mask.into());
            icon.ok()
        }
    }

    /// Drops the hand's mouse moves, clicks and wheel while `HELD`; what
    /// Lumo sends (injected) goes through.
    unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && HELD.load(Ordering::Relaxed) {
            let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            if info.flags & LLMHF_INJECTED == 0 {
                return LRESULT(1);
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }

    fn start_hook() {
        if HOOK_THREAD.load(Ordering::SeqCst) != 0 {
            return;
        }
        let (tx, rx) = std::sync::mpsc::channel::<u32>();
        std::thread::spawn(move || unsafe {
            let module = GetModuleHandleW(None).ok().map(|m| m.into());
            let Ok(hhook) = SetWindowsHookExW(WH_MOUSE_LL, Some(hook), module, 0) else {
                crate::log::line("computer use: the mouse hook could not be set");
                let _ = tx.send(0);
                return;
            };
            let _ = tx.send(GetCurrentThreadId());
            // A low-level hook runs on its thread's messages, until WM_QUIT.
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
            let _ = UnhookWindowsHookEx(hhook);
        });
        if let Ok(id) = rx.recv_timeout(Duration::from_secs(2)) {
            HOOK_THREAD.store(id, Ordering::SeqCst);
        }
    }

    fn stop_hook() {
        let id = HOOK_THREAD.swap(0, Ordering::SeqCst);
        if id != 0 {
            let _ = unsafe { PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0)) };
        }
    }

    pub fn press(keys: &[Key], repeat: u32, stop: &dyn Fn() -> bool) -> Result<(), String> {
        keyboard_ready()?;
        let Some((last, mods)) = keys.split_last() else { return Ok(()) };
        for _ in 0..repeat {
            if stop() {
                break;
            }
            holding(mods, || {
                let (vk, extra) = resolve(*last)?;
                holding(&extra.iter().map(|v| Key::Vk(*v)).collect::<Vec<_>>(), || {
                    if send(&[vk_event(vk, false), vk_event(vk, true)]) { Ok(()) } else { Err("Windows refused the keys.".to_string()) }
                })
            })?;
            std::thread::sleep(Duration::from_millis(25));
        }
        Ok(())
    }

    pub fn type_text(text: &str, stop: &dyn Fn() -> bool) -> Result<usize, String> {
        keyboard_ready()?;
        let front = unsafe { GetForegroundWindow() };
        let mut typed = 0usize;
        let mut pending: Vec<u16> = Vec::new();
        let flush = |pending: &mut Vec<u16>, typed: &mut usize| -> Result<(), String> {
            for chunk in pending.chunks(BATCH) {
                if stop() {
                    return Err(format!("Stopped after {typed} characters."));
                }
                if unsafe { GetForegroundWindow() } != front {
                    return Err(format!("Another window came to the front: typing stopped after {typed} characters."));
                }
                let inputs: Vec<INPUT> = chunk
                    .iter()
                    .flat_map(|&u| [key_input(0, u, KEYEVENTF_UNICODE), key_input(0, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)])
                    .collect();
                if !send(&inputs) {
                    return Err(format!("The window in front refused the keys after {typed} characters."));
                }
                *typed += String::from_utf16_lossy(chunk).chars().count();
                std::thread::sleep(PAUSE);
            }
            pending.clear();
            Ok(())
        };
        for c in text.chars() {
            match c {
                '\r' => continue,
                '\n' | '\t' => {
                    flush(&mut pending, &mut typed)?;
                    let vk = if c == '\n' { VK_RETURN } else { VK_TAB };
                    if stop() {
                        return Err(format!("Stopped after {typed} characters."));
                    }
                    send(&[vk_event(vk, false), vk_event(vk, true)]);
                    typed += 1;
                    std::thread::sleep(PAUSE);
                }
                _ => {
                    let mut units = [0u16; 2];
                    pending.extend_from_slice(c.encode_utf16(&mut units));
                }
            }
        }
        flush(&mut pending, &mut typed)?;
        Ok(typed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screenshots_are_sent_at_a_size_every_model_reads_whole() {
        assert_eq!(agent_size(1280, 720), (1280, 720), "small enough already");
        let (w, h) = agent_size(1920, 1080);
        assert!(w <= 1456 && (w as f64) * (h as f64) <= MAX_PIXELS * 1.01, "{w}×{h}");
        assert!((w as f64 / h as f64 - 16.0 / 9.0).abs() < 0.01, "keeps its shape");
        let (w, h) = agent_size(3840, 2160);
        assert!(w <= 1456 && (w as f64) * (h as f64) <= MAX_PIXELS * 1.01, "{w}×{h}");
        assert_eq!(agent_size(1080, 1920).1, agent_size(1920, 1080).0, "a portrait screen too");
        assert_eq!(agent_size(0, 0), (0, 0));
    }

    #[test]
    fn coordinates_go_from_the_screenshot_to_the_screen_and_back() {
        // A 4K screen right of the main one, sent at a smaller size.
        let v = View::new(1, (1920, 0, 5760, 2160));
        let (x, y) = v.to_screen(0, 0).unwrap();
        assert_eq!((x, y), (1921, 1), "the middle of the first screenshot pixel");
        let (x, y) = v.to_screen(v.w as i64 - 1, v.h as i64 - 1).unwrap();
        assert!(x < 5760 && y < 2160 && x > 5750 && y > 2150, "{x},{y}");
        assert!(v.to_screen(v.w as i64, 0).is_err(), "outside the screenshot");
        assert!(v.to_screen(-1, 5).is_err());
        let (sx, sy) = v.to_screen(500, 300).unwrap();
        assert_eq!(v.from_screen(sx, sy), (500, 300));
        // Same size: one to one.
        let v = View::new(0, (0, 0, 1280, 720));
        assert_eq!(v.to_screen(100, 200).unwrap(), (100, 200));
        assert_eq!(v.region([10, 20, 110, 70]).unwrap(), (10, 20, 110, 70));
        assert!(v.region([110, 20, 10, 70]).is_err());
        assert_eq!(v.region([1200, 700, 5000, 5000]).unwrap(), (1200, 700, 1280, 720), "kept on the screen");
    }

    #[test]
    fn a_zoom_enlarges_a_small_region_up_to_four_times() {
        assert_eq!(zoom_size(200, 100), (800, 400));
        let (w, h) = zoom_size(1000, 1000);
        assert!(w <= 1456 && (w as f64) * (h as f64) <= MAX_PIXELS * 1.01);
    }

    #[test]
    fn key_names_are_read_as_claude_writes_them() {
        assert_eq!(parse_keys("ctrl+s").unwrap(), [Key::Vk(VK_CONTROL), Key::Vk(b'S' as u16)]);
        assert_eq!(parse_keys("Return").unwrap(), [Key::Vk(VK_RETURN)]);
        assert_eq!(parse_keys("ctrl+shift+Page_Down").unwrap(), [Key::Vk(VK_CONTROL), Key::Vk(VK_SHIFT), Key::Vk(0x22)]);
        assert_eq!(parse_keys("alt+F4").unwrap(), [Key::Vk(VK_MENU), Key::Vk(0x73)]);
        assert_eq!(parse_keys("super").unwrap(), [Key::Vk(VK_LWIN)]);
        assert_eq!(parse_keys("ctrl++").unwrap(), [Key::Vk(VK_CONTROL), Key::Char('+')]);
        assert_eq!(parse_keys("ctrl+plus").unwrap(), [Key::Vk(VK_CONTROL), Key::Char('+')]);
        assert_eq!(parse_keys("ctrl+/").unwrap(), [Key::Vk(VK_CONTROL), Key::Char('/')]);
        assert_eq!(parse_keys("7").unwrap(), [Key::Vk(b'7' as u16)]);
        assert!(parse_keys("ctrl+banana").is_err());
        assert!(parse_keys("  ").is_err());
        assert!(is_extended(0x25) && is_extended(0x2E) && !is_extended(0x41));
    }

    #[test]
    fn tool_calls_are_read_and_checked() {
        assert_eq!(parse("screenshot", &json!({})).unwrap(), Action::Screenshot { display: None });
        assert_eq!(parse("screenshot", &json!({ "display": 2 })).unwrap(), Action::Screenshot { display: Some(1) });
        assert!(parse("screenshot", &json!({ "display": 0 })).is_err());
        assert_eq!(
            parse("double_click", &json!({ "coordinate": [10, 20], "text": "shift" })).unwrap(),
            Action::Click { at: Some((10, 20)), button: Button::Left, count: 2, hold: vec![Key::Vk(VK_SHIFT)] }
        );
        assert_eq!(parse("left_click", &json!({})).unwrap(), Action::Click { at: None, button: Button::Left, count: 1, hold: vec![] });
        assert!(parse("left_click", &json!({ "coordinate": "10,20" })).is_err());
        assert!(parse("mouse_move", &json!({})).is_err());
        assert_eq!(
            parse("scroll", &json!({ "scroll_direction": "down", "scroll_amount": 5 })).unwrap(),
            Action::Scroll { at: None, dx: 0, dy: -5, hold: vec![] }
        );
        assert!(parse("scroll", &json!({ "scroll_direction": "sideways" })).is_err());
        assert_eq!(
            parse("key", &json!({ "text": "Tab", "repeat": 500 })).unwrap(),
            Action::Keys { keys: vec![Key::Vk(VK_TAB)], repeat: 100, label: "Tab".into() }
        );
        assert!(parse("type", &json!({ "text": "" })).is_err());
        assert!(parse("type", &json!({ "text": "x".repeat(MAX_TEXT + 1) })).is_err());
        assert_eq!(parse("wait", &json!({ "duration": 999 })).unwrap(), Action::Wait { secs: MAX_WAIT_SECS });
        assert!(parse("format_disk", &json!({})).is_err());
        assert!(parse("zoom", &json!({ "region": [0, 0, 10] })).is_err());
        assert!(Action::Screenshot { display: None }.looks() && Action::Cursor.looks());
        assert!(!Action::Type { text: "x".into() }.looks());
    }

    #[test]
    fn the_mouse_glides_on_an_eased_curve_longer_for_longer_ways() {
        assert_eq!(ease(0.0), 0.0);
        assert_eq!(ease(1.0), 1.0);
        assert!((ease(0.5) - 0.5).abs() < 1e-9);
        assert!(ease(0.1) < 0.1 && ease(0.9) > 0.9, "slow out, slow in");
        assert_eq!(ease(-1.0), 0.0);
        assert_eq!(ease(2.0), 1.0);
        assert_eq!(glide_ms((10, 10), (11, 10)), 0, "already there");
        let short = glide_ms((0, 0), (100, 0));
        let long = glide_ms((0, 0), (2000, 1000));
        assert!(short >= 220 && short < long && long <= 850, "{short} {long}");
    }

    #[test]
    fn claudes_arrow_is_orange_with_a_white_edge_and_its_tip_is_the_hot_spot() {
        for size in [32u32, 48, 64] {
            let (px, hot) = arrow_pixels(size);
            assert_eq!(px.len(), (size * size * 4) as usize);
            let at = |x: u32, y: u32| {
                let i = ((y * size + x) * 4) as usize;
                (px[i], px[i + 1], px[i + 2], px[i + 3])
            };
            let k = size as f64 / 32.0;
            // Inside the body: Lumo's orange, opaque.
            let (r, g, b, a) = at((5.0 * k) as u32, (14.0 * k) as u32);
            assert_eq!((r, g, b, a), (255, 138, 31, 255), "size {size}");
            // Far corner: nothing.
            assert_eq!(at(size - 1, 0).3, 0);
            // The tip is the hot spot, near the top left.
            assert!(hot.0 <= 3 * size / 32 && hot.1 <= 3 * size / 32, "{hot:?}");
            // Some white edge and some soft shadow.
            assert!(px.chunks_exact(4).any(|p| p == [255, 255, 255, 255]));
            assert!(px.chunks_exact(4).any(|p| p[0] == 0 && p[3] > 0 && p[3] < 128));
        }
    }

    #[test]
    fn nothing_is_done_outside_a_turn_or_after_esc() {
        // The state machine alone: serve() needs the app.
        begin_turn();
        assert!(TURN.load(Ordering::SeqCst) && !STOPPED.load(Ordering::SeqCst));
        assert!(view().is_err(), "a new turn starts without a screen");
        *VIEW.lock().unwrap() = Some(View::new(0, (0, 0, 800, 600)));
        assert!(view().is_ok());
        begin_turn();
        assert!(view().is_err(), "each turn picks its screen again");
        TURN.store(false, Ordering::SeqCst);
    }
}
