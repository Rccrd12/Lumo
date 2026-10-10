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
// One screen at a time: the one under the mouse at the first screenshot of a
// turn, or the one Claude asks for. Screenshots are scaled down to what every
// model reads in full (1456 px on the long edge, about 1.15 megapixels), and
// Claude's coordinates, in those pixels, are scaled back up before acting.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

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

/// A chat turn that may use the computer starts.
pub fn begin_turn() {
    STOPPED.store(false, Ordering::SeqCst);
    *VIEW.lock().unwrap_or_else(|e| e.into_inner()) = None;
    TURN.store(true, Ordering::SeqCst);
}

/// The turn is over: nothing more is done, and Esc is the user's again.
pub fn end_turn<R: Runtime>(app: &AppHandle<R>) {
    TURN.store(false, Ordering::SeqCst);
    ACTING.store(false, Ordering::SeqCst);
    release_stop_key(app);
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
    use tauri::Emitter;
    let _ = app.emit_to(crate::island::WINDOW_LABEL, "computer-stopped", ());
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
    Keys { keys: Vec<Key>, repeat: u32 },
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
            let keys = parse_keys(input.get("text").and_then(Value::as_str).unwrap_or(""))?;
            let repeat = input.get("repeat").and_then(Value::as_u64).unwrap_or(1).clamp(1, 100) as u32;
            Ok(Action::Keys { keys, repeat })
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
            *VIEW.lock().unwrap_or_else(|e| e.into_inner()) = Some(view);
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
            Ok(json!({
                "image": base64(&png),
                "text": format!("The region [{}, {}, {}, {}], enlarged. Coordinates stay those of the full screenshot.", region[0], region[1], region[2], region[3]),
            }))
        }
        Action::Click { at, button, count, hold } => {
            let view = view()?;
            let target = at.map(|(x, y)| view.to_screen(x, y)).transpose()?;
            hands_off(app, || imp::click(target, button, count, &hold))?;
            Ok(json!({ "text": "Done. Take a screenshot to see what changed." }))
        }
        Action::Move { at } => {
            let (x, y) = view()?.to_screen(at.0, at.1)?;
            hands_off(app, || imp::move_to(x, y))?;
            Ok(json!({ "text": "Done." }))
        }
        Action::Drag { from, to } => {
            let view = view()?;
            let (a, b) = (view.to_screen(from.0, from.1)?, view.to_screen(to.0, to.1)?);
            hands_off(app, || imp::drag(a, b))?;
            Ok(json!({ "text": "Done. Take a screenshot to see what changed." }))
        }
        Action::Scroll { at, dx, dy, hold } => {
            let view = view()?;
            let target = at.map(|(x, y)| view.to_screen(x, y)).transpose()?;
            hands_off(app, || imp::scroll(target, dx, dy, &hold, &stopped))?;
            Ok(json!({ "text": "Done." }))
        }
        Action::Type { text } => {
            keyboard_back(app);
            let typed = imp::type_text(&text, &stopped)?;
            Ok(json!({ "text": format!("Typed {typed} characters.") }))
        }
        Action::Keys { keys, repeat } => {
            keyboard_back(app);
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
    pub fn move_to(_x: i32, _y: i32) -> Result<(), String> {
        unavailable()
    }
    pub fn click(_at: Option<(i32, i32)>, _b: Button, _count: u32, _hold: &[Key]) -> Result<(), String> {
        unavailable()
    }
    pub fn drag(_a: (i32, i32), _b: (i32, i32)) -> Result<(), String> {
        unavailable()
    }
    pub fn scroll(_at: Option<(i32, i32)>, _dx: i32, _dy: i32, _hold: &[Key], _stop: &dyn Fn() -> bool) -> Result<(), String> {
        unavailable()
    }
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

    pub fn move_to(x: i32, y: i32) -> Result<(), String> {
        unsafe { SetCursorPos(x, y) }.map_err(|_| "Windows refused to move the mouse.".to_string())?;
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

    pub fn click(at: Option<(i32, i32)>, button: Button, count: u32, hold: &[Key]) -> Result<(), String> {
        if let Some((x, y)) = at {
            move_to(x, y)?;
        }
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

    pub fn drag(a: (i32, i32), b: (i32, i32)) -> Result<(), String> {
        move_to(a.0, a.1)?;
        if !send(&[mouse(MOUSEEVENTF_LEFTDOWN, 0)]) {
            return Err("Windows refused the click.".into());
        }
        std::thread::sleep(Duration::from_millis(60));
        // In steps, so the app sees a drag and not a jump.
        const STEPS: i32 = 16;
        for i in 1..=STEPS {
            let x = a.0 + (b.0 - a.0) * i / STEPS;
            let y = a.1 + (b.1 - a.1) * i / STEPS;
            let _ = unsafe { SetCursorPos(x, y) };
            std::thread::sleep(Duration::from_millis(12));
        }
        std::thread::sleep(Duration::from_millis(60));
        send(&[mouse(MOUSEEVENTF_LEFTUP, 0)]);
        note_target();
        Ok(())
    }

    pub fn scroll(at: Option<(i32, i32)>, dx: i32, dy: i32, hold: &[Key], stop: &dyn Fn() -> bool) -> Result<(), String> {
        if let Some((x, y)) = at {
            move_to(x, y)?;
        }
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
        assert_eq!(parse("key", &json!({ "text": "Tab", "repeat": 500 })).unwrap(), Action::Keys { keys: vec![Key::Vk(VK_TAB)], repeat: 100 });
        assert!(parse("type", &json!({ "text": "" })).is_err());
        assert!(parse("type", &json!({ "text": "x".repeat(MAX_TEXT + 1) })).is_err());
        assert_eq!(parse("wait", &json!({ "duration": 999 })).unwrap(), Action::Wait { secs: MAX_WAIT_SECS });
        assert!(parse("format_disk", &json!({})).is_err());
        assert!(parse("zoom", &json!({ "region": [0, 0, 10] })).is_err());
        assert!(Action::Screenshot { display: None }.looks() && Action::Cursor.looks());
        assert!(!Action::Type { text: "x".into() }.looks());
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
