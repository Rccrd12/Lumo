// Gemini Live's type_text: what the user asked Gemini to write, typed into the
// text box they clicked in, as the keyboard would type it. It runs only when
// the model calls the tool during a call, and types into whatever window is in
// front — never Lumo's own.
//
// It never presses Enter: a line break is Shift+Enter, which starts a new line
// in a text box, an email or a chat without sending it. In a terminal (or an
// editor with one inside) even that could run a command, so line breaks are
// typed as spaces there. Tabs are spaces too: a Tab key would move to another
// field. Nothing is typed while a modifier key is down (Ctrl+letter would be
// a shortcut), and typing stops if the user moves to another window.
//
// Windows: SendInput with Unicode characters, so any language types as it is,
// whatever the keyboard layout. Linux: xdotool on X11, wtype on Wayland.

use serde::Serialize;

/// A message, a paragraph, a form: not a book.
pub const MAX_CHARS: usize = 5000;

/// What was typed, and where.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Typed {
    pub chars: usize,
    /// The app in front ("chrome", "WINWORD"), when known.
    pub app: String,
    /// Its window title, when known.
    pub title: String,
    /// Line breaks were typed as spaces: the window is a terminal.
    pub flattened: bool,
}

/// One step of typing.
#[derive(Debug, Clone, PartialEq)]
pub enum Piece {
    Text(String),
    /// Shift+Enter: a new line, never Send.
    Break,
}

/// Text as it is typed: lines with breaks between them (spaces in a terminal),
/// tabs as spaces, other control characters left out, at most MAX_CHARS.
pub fn pieces(text: &str, terminal: bool) -> Vec<Piece> {
    let text: String = text.replace("\r\n", "\n").replace('\r', "\n").chars().take(MAX_CHARS).collect();
    let mut out = Vec::new();
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            if terminal {
                push_text(&mut out, " ");
            } else {
                out.push(Piece::Break);
            }
        }
        let line: String = line.chars().map(|c| if c == '\t' { ' ' } else { c }).filter(|c| !c.is_control()).collect();
        push_text(&mut out, &line);
    }
    out
}

fn push_text(out: &mut Vec<Piece>, text: &str) {
    if text.is_empty() {
        return;
    }
    match out.last_mut() {
        Some(Piece::Text(t)) => t.push_str(text),
        _ => out.push(Piece::Text(text.to_string())),
    }
}

/// How many characters the pieces type.
#[cfg_attr(windows, allow(dead_code))] // Windows counts as it goes
pub fn count(pieces: &[Piece]) -> usize {
    pieces.iter().map(|p| if let Piece::Text(t) = p { t.chars().count() } else { 1 }).sum()
}

/// Terminals as Linux names them, beyond the ones selection.rs knows.
fn linux_terminal(app: &str) -> bool {
    let a = app.to_lowercase();
    ["term", "konsole", "kitty", "alacritty", "tilix", "ptyxis", "kgx", "foot", "guake", "yakuake", "console"]
        .iter()
        .any(|w| a.contains(w))
}

/// A window where a line break could run a command.
pub fn is_terminal(app: &str, class: &str) -> bool {
    crate::selection::is_terminal(app, class) || linux_terminal(app) || linux_terminal(class)
}

fn lumo_in_front() -> String {
    "Lumo's own window is in front, not the user's text box: ask the user to click in the box where the text goes, then try again.".into()
}

fn nothing_in_front() -> String {
    "No window is in front: ask the user to click in the box where the text goes, then try again.".into()
}

/// Types `text` into the window in front. Blocking.
pub fn type_text(text: &str) -> Result<Typed, String> {
    if text.trim().is_empty() {
        return Err("There is no text to type.".into());
    }
    imp::type_text(text)
}

#[cfg(windows)]
mod imp {
    use super::*;

    use std::time::Duration;

    use ::windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE,
        VIRTUAL_KEY, VK_RETURN, VK_SHIFT,
    };
    use ::windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    /// UTF-16 units sent at once; a pause between batches lets slow apps keep up.
    const BATCH: usize = 24;
    const PAUSE: Duration = Duration::from_millis(8);

    fn input(vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
        }
    }

    fn send(inputs: &[INPUT]) -> bool {
        unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) as usize == inputs.len() }
    }

    pub fn type_text(text: &str) -> Result<Typed, String> {
        let front = unsafe { GetForegroundWindow() };
        if front.is_invalid() {
            return Err(nothing_in_front());
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(front, Some(&mut pid)) };
        if pid == std::process::id() {
            return Err(lumo_in_front());
        }
        let app = crate::screen::exe_name(pid);
        let title = crate::screen::clip_title(&crate::selection::window_text(front));
        let terminal = is_terminal(&app, &crate::selection::class_name(front));
        if !crate::selection::keys_released(Duration::from_secs(2)) {
            return Err("Keys are held down on the keyboard: try again once they are let go.".into());
        }
        let pieces = pieces(text, terminal);
        let mut typed = 0usize;
        for piece in &pieces {
            match piece {
                Piece::Text(t) => {
                    let units: Vec<u16> = t.encode_utf16().collect();
                    for chunk in units.chunks(BATCH) {
                        // The user moved to another window: the rest would go there.
                        if unsafe { GetForegroundWindow() } != front {
                            return Err(format!("The user moved to another window: typing stopped after {typed} characters."));
                        }
                        let inputs: Vec<INPUT> = chunk
                            .iter()
                            .flat_map(|&u| {
                                [input(VIRTUAL_KEY(0), u, KEYEVENTF_UNICODE), input(VIRTUAL_KEY(0), u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)]
                            })
                            .collect();
                        if !send(&inputs) {
                            return Err(format!("The window in front refused the keys after {typed} characters."));
                        }
                        typed += String::from_utf16_lossy(chunk).chars().count();
                        std::thread::sleep(PAUSE);
                    }
                }
                Piece::Break => {
                    let none = KEYBD_EVENT_FLAGS(0);
                    let keys = [
                        input(VK_SHIFT, 0, none),
                        input(VK_RETURN, 0, none),
                        input(VK_RETURN, 0, KEYEVENTF_KEYUP),
                        input(VK_SHIFT, 0, KEYEVENTF_KEYUP),
                    ];
                    if !send(&keys) {
                        return Err(format!("The window in front refused the keys after {typed} characters."));
                    }
                    typed += 1;
                    std::thread::sleep(PAUSE);
                }
            }
        }
        Ok(Typed { chars: typed, app, title, flattened: terminal && pieces_had_breaks(text) })
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;

    use std::process::{Command, Stdio};

    fn run(cmd: &str, args: &[&str]) -> Option<String> {
        let out = Command::new(cmd).args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn wayland() -> bool {
        std::env::var("XDG_SESSION_TYPE").is_ok_and(|s| s.eq_ignore_ascii_case("wayland"))
            || std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var_os("DISPLAY").is_none()
    }

    fn missing() -> String {
        "Typing needs xdotool (X11) or wtype (Wayland), and it isn't installed: tell the user.".into()
    }

    pub fn type_text(text: &str) -> Result<Typed, String> {
        if wayland() {
            // Wayland says nothing of the window in front: line breaks go as
            // spaces, in case it is a terminal.
            if crate::platform::find_on_path("wtype").is_none() {
                return Err(missing());
            }
            let pieces = pieces(text, true);
            for piece in &pieces {
                if let Piece::Text(t) = piece {
                    run("wtype", &["--", t]).ok_or_else(|| "The text couldn't be typed.".to_string())?;
                }
            }
            return Ok(Typed { chars: count(&pieces), app: String::new(), title: String::new(), flattened: pieces_had_breaks(text) });
        }
        if crate::platform::find_on_path("xdotool").is_none() {
            return Err(missing());
        }
        let pid = run("xdotool", &["getactivewindow", "getwindowpid"]).ok_or_else(nothing_in_front)?;
        if pid.parse::<u32>().ok() == Some(std::process::id()) {
            return Err(lumo_in_front());
        }
        let class = run("xdotool", &["getactivewindow", "getwindowclassname"]).unwrap_or_default();
        let title = crate::screen::clip_title(&run("xdotool", &["getactivewindow", "getwindowname"]).unwrap_or_default());
        let terminal = is_terminal(&class, &class);
        let pieces = pieces(text, terminal);
        for piece in &pieces {
            let ok = match piece {
                Piece::Text(t) => run("xdotool", &["type", "--clearmodifiers", "--delay", "8", "--", t]),
                Piece::Break => run("xdotool", &["key", "--clearmodifiers", "shift+Return"]),
            };
            ok.ok_or_else(|| "The text couldn't be typed.".to_string())?;
        }
        Ok(Typed { chars: count(&pieces), app: class, title, flattened: terminal && pieces_had_breaks(text) })
    }
}

/// The text has line breaks (which a terminal gets as spaces).
fn pieces_had_breaks(text: &str) -> bool {
    text.chars().take(MAX_CHARS).any(|c| c == '\n' || c == '\r')
}

/// Types the text into the window in front (Gemini Live's type_text).
#[tauri::command]
pub async fn live_type(text: String) -> Result<Typed, String> {
    tauri::async_runtime::spawn_blocking(move || type_text(&text)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_breaks_are_shift_enter_and_never_a_plain_enter() {
        assert_eq!(
            pieces("Ciao Marco,\r\nci vediamo domani.\n\nLuca", false),
            [
                Piece::Text("Ciao Marco,".into()),
                Piece::Break,
                Piece::Text("ci vediamo domani.".into()),
                Piece::Break,
                Piece::Break,
                Piece::Text("Luca".into()),
            ]
        );
    }

    #[test]
    fn a_terminal_gets_one_line_and_tabs_are_spaces() {
        assert_eq!(pieces("ls -la\nrm -rf x", true), [Piece::Text("ls -la rm -rf x".into())]);
        assert_eq!(pieces("a\tb\u{7}c", false), [Piece::Text("a bc".into())]);
        assert!(pieces_had_breaks("a\nb") && !pieces_had_breaks("ab"));
    }

    #[test]
    fn the_text_is_capped_and_counted() {
        let long = "x".repeat(MAX_CHARS + 50);
        assert_eq!(count(&pieces(&long, false)), MAX_CHARS);
        assert_eq!(count(&pieces("è\nü", false)), 3);
        assert!(type_text("   ").is_err());
    }

    #[test]
    fn terminals_are_known_on_both_systems() {
        assert!(is_terminal("WindowsTerminal", ""));
        assert!(is_terminal("", "ConsoleWindowClass"));
        assert!(is_terminal("Code", ""), "an editor with a terminal inside");
        assert!(is_terminal("gnome-terminal-server", "Gnome-terminal"));
        assert!(is_terminal("konsole", "konsole"));
        assert!(!is_terminal("chrome", "Chrome_WidgetWin_1"));
        assert!(!is_terminal("WINWORD", "OpusApp"));
    }
}
