// The text the user selected in another app, for the chat — only when they
// press the "Ask about the selected text" shortcut.
//
// Windows has no common way to read another app's selection, so this does what
// the user would: it waits for the shortcut's keys to come up, presses copy in
// the app in front, reads the text, and puts the clipboard back the way it was
// (every format it held, images included). Copy is Ctrl+C, except in terminals
// and editors with a terminal inside, where Ctrl+C with nothing selected would
// interrupt what is running (a Claude Code session, a build): there it is
// Ctrl+Insert, which only ever copies. Nothing runs before the key press, and
// nothing is kept once the text is handed to the chat.
//
// Linux: X11 and Wayland keep the selection apart from the clipboard (the
// "primary" selection), so it is read as it is with xclip, xsel or wl-paste,
// and nothing is pressed.

use serde::Serialize;

use crate::i18n::t;

/// The chat is for questions about a passage, not a whole book.
pub const MAX_CHARS: usize = 20_000;

/// What was selected, and where.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selected {
    pub text: String,
    /// The app it was selected in ("chrome", "WINWORD"), when known.
    pub app: String,
    /// That app's window title (the page, the document), when known.
    pub title: String,
}

/// The keys that copy in the app in front.
#[cfg_attr(not(windows), allow(dead_code))] // Linux reads the primary selection
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopyKeys {
    CtrlC,
    CtrlInsert,
}

/// Apps where Ctrl+C can mean "stop": terminals, and the editors and IDEs that
/// have a terminal inside. Names as `screen::app_name` gives them, any case.
#[cfg_attr(not(windows), allow(dead_code))]
const TERMINAL_APPS: &[&str] = &[
    "WindowsTerminal", "OpenConsole", "conhost", "cmd", "powershell", "pwsh", "wsl", "bash",
    "wezterm-gui", "alacritty", "mintty", "kitty", "Tabby", "Hyper", "ConEmu", "ConEmu64",
    "FluentTerminal", "MobaXterm", "putty", "Warp", "Code", "Code - Insiders", "VSCodium",
    "Cursor", "Windsurf", "Zed", "idea64", "pycharm64", "webstorm64", "clion64", "goland64",
    "rider64", "rustrover64", "phpstorm64", "studio64", "datagrip64",
];

/// Window classes of the console and of Windows Terminal, whatever runs in them.
#[cfg_attr(not(windows), allow(dead_code))]
const TERMINAL_CLASSES: &[&str] = &["ConsoleWindowClass", "CASCADIA_HOSTING_WINDOW_CLASS", "PseudoConsoleWindow"];

/// How to copy in the app `app` whose window class is `class`.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn copy_keys(app: &str, class: &str) -> CopyKeys {
    let terminal = TERMINAL_APPS.iter().any(|a| a.eq_ignore_ascii_case(app))
        || TERMINAL_CLASSES.iter().any(|c| c.eq_ignore_ascii_case(class));
    if terminal {
        CopyKeys::CtrlInsert
    } else {
        CopyKeys::CtrlC
    }
}

/// The text as the chat takes it: trimmed, at most `MAX_CHARS`, `None` when
/// nothing is left.
pub fn tidy(text: &str) -> Option<String> {
    let text = text.replace("\r\n", "\n").replace('\0', "");
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if text.chars().count() <= MAX_CHARS {
        return Some(text.to_string());
    }
    let mut cut: String = text.chars().take(MAX_CHARS).collect();
    cut.push_str("\n[…]");
    Some(cut)
}

fn nothing_selected() -> String {
    t("Nothing is selected. Select some text in another app, then press the shortcut again.")
}

/// The selection in the app in front. Runs on a worker thread: on Windows it
/// waits for the shortcut's keys to be released, at most a couple of seconds.
pub fn grab() -> Result<Selected, String> {
    imp::grab()
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    /// Runs `cmd args`, at most two seconds. `None` when the tool isn't installed.
    fn read(cmd: &str, args: &[&str]) -> Option<Result<String, ()>> {
        let mut child = match Command::new(cmd).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
            Err(_) => return Some(Err(())),
        };
        // Read while it runs, so a long selection can't fill the pipe and stall it.
        let stdout = child.stdout.take();
        let reader = std::thread::spawn(move || {
            let mut out = Vec::new();
            if let Some(stdout) = stdout {
                let _ = stdout.take(4 * MAX_CHARS as u64).read_to_end(&mut out);
            }
            out
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        let ok = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.success(),
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break false;
                }
            }
        };
        let out = reader.join().unwrap_or_default();
        Some(if ok { Ok(String::from_utf8_lossy(&out).into_owned()) } else { Err(()) })
    }

    pub fn grab() -> Result<Selected, String> {
        let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
        let wl: (&str, &[&str]) = ("wl-paste", &["--primary", "--no-newline", "--type", "text/plain"]);
        let xclip: (&str, &[&str]) = ("xclip", &["-o", "-selection", "primary"]);
        let xsel: (&str, &[&str]) = ("xsel", &["-o", "-p"]);
        let tools = if wayland { [wl, xclip, xsel] } else { [xclip, xsel, wl] };
        for (cmd, args) in tools {
            match read(cmd, args) {
                None => continue,
                Some(Ok(text)) => {
                    let text = tidy(&text).ok_or_else(nothing_selected)?;
                    return Ok(Selected { text, app: String::new(), title: String::new() });
                }
                Some(Err(())) => return Err(nothing_selected()),
            }
        }
        Err(t("Install xclip (or wl-clipboard on Wayland) to share the selected text."))
    }
}

#[cfg(windows)]
mod imp {
    use super::*;

    use std::time::{Duration, Instant};

    use ::windows::core::w;
    use ::windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
    use ::windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData, GetClipboardSequenceNumber,
        IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use ::windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
    use ::windows::Win32::System::Ole::CF_UNICODETEXT;
    use ::windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_CONTROL, VK_INSERT, VK_LWIN, VK_MENU, VK_RWIN,
        VK_SHIFT,
    };
    use ::windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, GetClassNameW, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
        HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE,
    };

    /// A clipboard bigger than this is not copied aside (and not put back).
    const MAX_SAVED: usize = 64 * 1024 * 1024;
    const VK_C: VIRTUAL_KEY = VIRTUAL_KEY(0x43);

    /// Formats that are GDI or private handles rather than memory: they can't be
    /// copied aside. Windows makes CF_DIB from CF_BITMAP, so images still come back.
    fn copyable(format: u32) -> bool {
        !matches!(format, 2 | 3 | 9 | 14 | 0x80..=0x8F | 0x200..=0x3FF)
    }

    /// A window no one sees, to own the clipboard while it is put back
    /// (SetClipboardData needs an owner).
    struct Owner(HWND);

    impl Owner {
        fn new() -> Option<Self> {
            let hwnd = unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    w!("STATIC"),
                    w!(""),
                    WINDOW_STYLE(0),
                    0,
                    0,
                    0,
                    0,
                    Some(HWND_MESSAGE),
                    None,
                    None,
                    None,
                )
            };
            hwnd.ok().map(Owner)
        }
    }

    impl Drop for Owner {
        fn drop(&mut self) {
            let _ = unsafe { DestroyWindow(self.0) };
        }
    }

    /// Opens the clipboard, waiting a little while another app holds it.
    fn open(owner: &Owner, wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        loop {
            if unsafe { OpenClipboard(Some(owner.0)) }.is_ok() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Everything the clipboard holds, format by format. `None` if it can't be opened.
    fn save(owner: &Owner) -> Option<Vec<(u32, Vec<u8>)>> {
        if !open(owner, Duration::from_millis(300)) {
            return None;
        }
        let mut out = Vec::new();
        let mut total = 0usize;
        let mut format = 0u32;
        loop {
            format = unsafe { EnumClipboardFormats(format) };
            if format == 0 {
                break;
            }
            if !copyable(format) {
                continue;
            }
            let Ok(handle) = (unsafe { GetClipboardData(format) }) else { continue };
            let memory = HGLOBAL(handle.0);
            let size = unsafe { GlobalSize(memory) };
            if size == 0 || total + size > MAX_SAVED {
                continue;
            }
            let ptr = unsafe { GlobalLock(memory) };
            if ptr.is_null() {
                continue;
            }
            let bytes = unsafe { std::slice::from_raw_parts(ptr as *const u8, size) }.to_vec();
            let _ = unsafe { GlobalUnlock(memory) };
            total += size;
            out.push((format, bytes));
        }
        let _ = unsafe { CloseClipboard() };
        Some(out)
    }

    fn put(format: u32, bytes: &[u8]) {
        unsafe {
            let Ok(memory) = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)) else { return };
            let ptr = GlobalLock(memory);
            if ptr.is_null() {
                let _ = GlobalFree(Some(memory));
                return;
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, bytes.len());
            let _ = GlobalUnlock(memory);
            // On success the clipboard owns the memory; otherwise it is still ours.
            if SetClipboardData(format, Some(HANDLE(memory.0))).is_err() {
                let _ = GlobalFree(Some(memory));
            }
        }
    }

    /// Puts back what `save` read. The copy is marked so that the clipboard
    /// history (Win+V) and cloud clipboard don't store it a second time.
    fn restore(owner: &Owner, saved: &[(u32, Vec<u8>)]) {
        if !open(owner, Duration::from_millis(500)) {
            return;
        }
        unsafe {
            let _ = EmptyClipboard();
            for (format, bytes) in saved {
                put(*format, bytes);
            }
            let exclude = RegisterClipboardFormatW(w!("ExcludeClipboardContentFromMonitorProcessing"));
            if exclude != 0 {
                put(exclude, &[0, 0, 0, 0]);
            }
            let _ = CloseClipboard();
        }
    }

    /// The text on the clipboard, once the app in front has finished copying.
    fn read_text(owner: &Owner, deadline: Instant) -> Option<String> {
        loop {
            if open(owner, Duration::from_millis(50)) {
                let text = unsafe {
                    if IsClipboardFormatAvailable(CF_UNICODETEXT.0 as u32).is_ok() {
                        GetClipboardData(CF_UNICODETEXT.0 as u32).ok().and_then(|handle| {
                            let memory = HGLOBAL(handle.0);
                            let ptr = GlobalLock(memory) as *const u16;
                            if ptr.is_null() {
                                return None;
                            }
                            let max = GlobalSize(memory) / 2;
                            let len = (0..max).find(|&i| *ptr.add(i) == 0).unwrap_or(max);
                            let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
                            let _ = GlobalUnlock(memory);
                            Some(text)
                        })
                    } else {
                        None
                    }
                };
                let _ = unsafe { CloseClipboard() };
                if text.is_some() {
                    return text;
                }
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn held(vk: VIRTUAL_KEY) -> bool {
        unsafe { (GetAsyncKeyState(vk.0 as i32) as u16 & 0x8000) != 0 }
    }

    /// Waits for Ctrl, Alt, Shift and the Windows key to come up, so the copy
    /// isn't read as Ctrl+Alt+C. False if they are still down after `wait`.
    fn keys_released(wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        while [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN].into_iter().any(held) {
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        true
    }

    fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
        let mut flags = if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) };
        if vk == VK_INSERT {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        }
    }

    fn press_copy(keys: CopyKeys) -> bool {
        let letter = match keys {
            CopyKeys::CtrlC => VK_C,
            CopyKeys::CtrlInsert => VK_INSERT,
        };
        let inputs = [key(VK_CONTROL, false), key(letter, false), key(letter, true), key(VK_CONTROL, true)];
        unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) as usize == inputs.len() }
    }

    fn window_text(hwnd: HWND) -> String {
        let mut buf = [0u16; 512];
        let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
        String::from_utf16_lossy(&buf[..len.max(0) as usize])
    }

    fn class_name(hwnd: HWND) -> String {
        let mut buf = [0u16; 128];
        let len = unsafe { GetClassNameW(hwnd, &mut buf) };
        String::from_utf16_lossy(&buf[..len.max(0) as usize])
    }

    pub fn grab() -> Result<Selected, String> {
        let front = unsafe { GetForegroundWindow() };
        if front.is_invalid() {
            return Err(nothing_selected());
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(front, Some(&mut pid)) };
        // The island itself: Ctrl+C would copy from the chat.
        if pid == std::process::id() {
            return Err(nothing_selected());
        }
        let app = crate::screen::exe_name(pid);
        let title = crate::screen::clip_title(&window_text(front));
        let keys = copy_keys(&app, &class_name(front));

        if !keys_released(Duration::from_secs(2)) {
            return Err(t("Let go of the keys, then press the shortcut again."));
        }
        let owner = Owner::new().ok_or_else(|| t("The clipboard is busy. Try again."))?;
        let saved = save(&owner).ok_or_else(|| t("The clipboard is busy. Try again."))?;
        let before = unsafe { GetClipboardSequenceNumber() };
        if !press_copy(keys) {
            return Err(nothing_selected());
        }
        // Wait for the app to copy; nothing changes when nothing is selected.
        let deadline = Instant::now() + Duration::from_millis(800);
        while unsafe { GetClipboardSequenceNumber() } == before {
            if Instant::now() >= deadline {
                return Err(nothing_selected());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let text = read_text(&owner, Instant::now() + Duration::from_millis(500));
        restore(&owner, &saved);
        let text = text.as_deref().and_then(tidy).ok_or_else(nothing_selected)?;
        Ok(Selected { text, app, title })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminals_copy_with_ctrl_insert_so_nothing_is_interrupted() {
        assert_eq!(copy_keys("WindowsTerminal", "CASCADIA_HOSTING_WINDOW_CLASS"), CopyKeys::CtrlInsert);
        assert_eq!(copy_keys("cmd", "ConsoleWindowClass"), CopyKeys::CtrlInsert);
        assert_eq!(copy_keys("anything", "ConsoleWindowClass"), CopyKeys::CtrlInsert, "any console window");
        assert_eq!(copy_keys("Code", "Chrome_WidgetWin_1"), CopyKeys::CtrlInsert, "VS Code has a terminal");
        assert_eq!(copy_keys("cursor", "Chrome_WidgetWin_1"), CopyKeys::CtrlInsert, "any case");
        assert_eq!(copy_keys("idea64", "SunAwtFrame"), CopyKeys::CtrlInsert);
    }

    #[test]
    fn other_apps_copy_with_ctrl_c() {
        assert_eq!(copy_keys("chrome", "Chrome_WidgetWin_1"), CopyKeys::CtrlC);
        assert_eq!(copy_keys("msedge", "Chrome_WidgetWin_1"), CopyKeys::CtrlC);
        assert_eq!(copy_keys("WINWORD", "OpusApp"), CopyKeys::CtrlC);
        assert_eq!(copy_keys("Acrobat", "AcrobatSDIWindow"), CopyKeys::CtrlC);
        assert_eq!(copy_keys("", ""), CopyKeys::CtrlC);
        assert_eq!(copy_keys("Codex", "x"), CopyKeys::CtrlC, "a name has to match whole");
    }

    #[test]
    fn the_text_is_trimmed_and_capped() {
        assert_eq!(tidy("  hello\r\nworld \n"), Some("hello\nworld".into()));
        assert_eq!(tidy(" \n\t "), None);
        assert_eq!(tidy(""), None);
        assert_eq!(tidy("a\0b"), Some("ab".into()));
        let long = "é".repeat(MAX_CHARS + 10);
        let cut = tidy(&long).unwrap();
        assert!(cut.ends_with("\n[…]"));
        assert_eq!(cut.chars().filter(|c| *c == 'é').count(), MAX_CHARS);
        let exact = "x".repeat(MAX_CHARS);
        assert_eq!(tidy(&exact), Some(exact.clone()));
    }
}
