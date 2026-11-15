//! While the computer is in use, a click on the island must not bring it to
//! the front: Windows would close what goes away when it loses the front (the
//! Start menu, Search, a browser's suggestions, a drop-down), which the agent
//! may just have opened, and its next action would type into nothing.
//!
//! WS_EX_NOACTIVATE is not enough: WebView2 brings its window to the front on
//! a click whatever the window's styles (the e2e flow saw the island take the
//! keyboard with the style on the island and on each of WebView2's own
//! windows). So, held, a left click over the island never reaches it: a
//! low-level mouse hook keeps the press and its release from every window and
//! hands them to the page, which clicks what is under them
//! (src/island/held-clicks.ts). No window gets the click, none is brought to
//! the front, nothing the agent opened closes.
//!
//! Held only while core/computer.ts islandHoldsClicks says so: no hook
//! otherwise. The island given the keyboard on purpose (focus_window) lets go.

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU32, Ordering};
use std::sync::mpsc::SyncSender;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use ::windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use ::windows::Win32::Graphics::Gdi::ScreenToClient;
use ::windows::Win32::System::LibraryLoader::GetModuleHandleW;
use ::windows::Win32::System::Threading::GetCurrentThreadId;
use ::windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, GetWindowRect, IsWindowVisible, PostThreadMessageW, SetWindowsHookExW,
    UnhookWindowsHookEx, MSG, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_QUIT,
};
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::island::PollGate;

/// The island's window, while held.
static ISLAND: AtomicIsize = AtomicIsize::new(0);
/// Whether the island lets the mouse through right now (island.rs PollGate).
static GATE: OnceLock<Arc<PollGate>> = OnceLock::new();
/// The hook's thread, 0 when there is none.
static THREAD: AtomicU32 = AtomicU32::new(0);
/// To the helper that tells the page: a press (true) or a release, where.
static TX: Mutex<Option<SyncSender<(bool, POINT)>>> = Mutex::new(None);
/// A press was kept from the island: its release is kept too, wherever it lands.
static PRESSED: AtomicBool = AtomicBool::new(false);

/// Holds the island's clicks (`hold`), or lets them go.
pub fn set(app: &AppHandle, hold: bool) {
    if hold {
        start(app);
    } else {
        stop();
    }
}

fn start(app: &AppHandle) {
    if THREAD.load(Ordering::SeqCst) != 0 {
        return;
    }
    let Some(win) = crate::island::window(app) else { return };
    let Ok(hwnd) = win.hwnd() else { return };
    if let Some(shared) = tauri::Manager::try_state::<crate::Shared>(app) {
        let _ = GATE.set(shared.gate.clone());
    }
    ISLAND.store(hwnd.0 as isize, Ordering::SeqCst);
    PRESSED.store(false, Ordering::SeqCst);

    // The helper: asleep on its channel, gone with the hook.
    let (tx, rx) = std::sync::mpsc::sync_channel::<(bool, POINT)>(8);
    *TX.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
    let app = app.clone();
    std::thread::spawn(move || {
        while let Ok((down, p)) = rx.recv() {
            tell_page(&app, down, p);
        }
    });

    let (id_tx, id_rx) = std::sync::mpsc::channel::<u32>();
    std::thread::spawn(move || unsafe {
        let module = GetModuleHandleW(None).ok().map(|m| m.into());
        let Ok(hhook) = SetWindowsHookExW(WH_MOUSE_LL, Some(hook), module, 0) else {
            crate::log::line("island clicks: the mouse hook could not be set");
            let _ = id_tx.send(0);
            return;
        };
        let _ = id_tx.send(GetCurrentThreadId());
        // A low-level hook runs on its thread's messages, until WM_QUIT.
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {}
        let _ = UnhookWindowsHookEx(hhook);
    });
    if let Ok(id) = id_rx.recv_timeout(Duration::from_secs(2)) {
        THREAD.store(id, Ordering::SeqCst);
        if id != 0 {
            crate::log::line("island clicks held");
        }
    }
}

fn stop() {
    TX.lock().unwrap_or_else(|e| e.into_inner()).take();
    let id = THREAD.swap(0, Ordering::SeqCst);
    if id != 0 {
        let _ = unsafe { PostThreadMessageW(id, WM_QUIT, WPARAM(0), LPARAM(0)) };
        crate::log::line("island clicks free");
    }
    PRESSED.store(false, Ordering::SeqCst);
}

/// Whether `p` is on the island: inside its window while it takes the mouse
/// (off its shape it lets the mouse through, island.rs). Nothing here sends a
/// message to a window: the hook must answer at once.
fn on_island(p: POINT) -> bool {
    let hwnd = HWND(ISLAND.load(Ordering::Relaxed) as *mut _);
    if hwnd.is_invalid() || !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return false;
    }
    if GATE.get().is_some_and(|g| g.lets_mouse_through()) {
        return false;
    }
    let mut r = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut r) }.is_err() {
        return false;
    }
    p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom
}

/// Keeps the left button's presses on the island, and their releases, from
/// every window. Quick and never waiting: the helper tells the page.
unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let msg = wparam.0 as u32;
        if msg == WM_LBUTTONDOWN || msg == WM_LBUTTONUP {
            let info = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            let down = msg == WM_LBUTTONDOWN;
            let kept = if down { on_island(info.pt) } else { PRESSED.swap(false, Ordering::SeqCst) };
            if kept {
                if down {
                    PRESSED.store(true, Ordering::SeqCst);
                }
                if let Ok(tx) = TX.try_lock() {
                    if let Some(tx) = tx.as_ref() {
                        let _ = tx.try_send((down, info.pt));
                    }
                }
                return LRESULT(1);
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// The page clicks what is at `p` (screen pixels): told in the window's own
/// pixels, which it turns into its CSS pixels (its devicePixelRatio holds the
/// island's zoom too, which the window's scale factor does not).
fn tell_page(app: &AppHandle, down: bool, p: POINT) {
    let Some(win) = crate::island::window(app) else { return };
    let Ok(hwnd) = win.hwnd() else { return };
    let mut at = p;
    if !unsafe { ScreenToClient(HWND(hwnd.0), &mut at) }.as_bool() {
        return;
    }
    let _ = app.emit_to(crate::island::WINDOW_LABEL, "held-click", json!({ "down": down, "x": at.x, "y": at.y }));
}
