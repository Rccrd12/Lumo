// Gemini Live's arrange_windows: the user's windows, named the way they say
// them ("VS Code", "the Excel one", "Chrome"), brought to the front, put on
// the left or right half of their screen, maximised, minimised, restored or
// closed. It runs once, when the model calls the tool during a call.
//
// Closing asks the window to close, as its × does: an app with unsaved work
// asks the user itself, nothing is ever lost here. Lumo's own windows are never
// in the list (screen.rs leaves them out).
//
// Windows: the window list from screen.rs, ShowWindow, SetWindowPos inside the
// work area of the window's display (the taskbar left free), WM_CLOSE.

use serde::{Deserialize, Serialize};

use crate::screen::WindowInfo;

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Focus,
    Left,
    Right,
    Maximize,
    Minimize,
    Restore,
    Close,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Done {
    pub title: String,
    pub app: String,
}

/// The window `query` names, best match first: words of its title or its
/// app's name ("code" finds Visual Studio Code by its app, Code.exe).
pub fn pick<'a>(list: &'a [WindowInfo], query: &str) -> Option<&'a WindowInfo> {
    let mut best: Option<(u32, usize)> = None;
    for (i, w) in list.iter().enumerate() {
        let by_app = crate::live::match_score(query, &w.app).map(|s| s + 30);
        let by_title = crate::live::match_score(query, &w.title);
        let both = crate::live::match_score(query, &format!("{} {}", w.title, w.app));
        let Some(score) = by_app.max(by_title).max(both) else { continue };
        // Ties go to the window nearer the front (the list goes front to back).
        if best.is_none_or(|(s, _)| score > s) {
            best = Some((score, i));
        }
    }
    best.map(|(_, i)| &list[i])
}

/// The left or right half of a work area (left, top, right, bottom).
pub fn half(area: (i32, i32, i32, i32), right: bool) -> (i32, i32, i32, i32) {
    let (l, t, r, b) = area;
    let mid = l + (r - l) / 2;
    if right {
        (mid, t, r, b)
    } else {
        (l, t, mid, b)
    }
}

/// Does `action` to the window `query` names. Blocking.
pub fn run(query: &str, action: Action) -> Result<Done, String> {
    if query.trim().is_empty() {
        return Err("Say which window, by its app or its title.".into());
    }
    let list = crate::screen::windows()?;
    let w = pick(&list, query).ok_or_else(|| format!("No open window matches \"{}\". list_windows says which are open.", query.trim()))?;
    imp::apply(w.id as isize, action)?;
    Ok(Done { title: w.title.clone(), app: w.app.clone() })
}

mod imp {
    use super::*;

    use ::windows::Win32::Foundation::{HWND, LPARAM, RECT, WPARAM};
    use ::windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
    use ::windows::Win32::Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST};
    use ::windows::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, IsIconic, IsWindow, IsZoomed, PostMessageW, SetForegroundWindow, SetWindowPos, ShowWindow,
        SwitchToThisWindow, SWP_NOACTIVATE, SWP_NOZORDER, SW_MAXIMIZE, SW_MINIMIZE, SW_RESTORE, WM_CLOSE,
    };

    fn front(hwnd: HWND) {
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            // Windows lets only the app in front hand the front over; when that
            // is refused, the switch Alt+Tab makes.
            if !SetForegroundWindow(hwnd).as_bool() {
                SwitchToThisWindow(hwnd, true);
            }
        }
    }

    /// The window's visible frame vs. its rectangle: Windows 10 and 11 draw
    /// an invisible border around most windows, which must be left out of a half.
    fn border(hwnd: HWND) -> (i32, i32, i32, i32) {
        unsafe {
            let mut outer = RECT::default();
            let mut frame = RECT::default();
            if GetWindowRect(hwnd, &mut outer).is_err()
                || DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut frame as *mut _ as *mut _, std::mem::size_of::<RECT>() as u32).is_err()
            {
                return (0, 0, 0, 0);
            }
            (frame.left - outer.left, frame.top - outer.top, outer.right - frame.right, outer.bottom - frame.bottom)
        }
    }

    fn snap(hwnd: HWND, right: bool) -> Result<(), String> {
        unsafe {
            if IsIconic(hwnd).as_bool() || IsZoomed(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if !GetMonitorInfoW(monitor, &mut info).as_bool() {
                return Err("Couldn't find the window's screen.".into());
            }
            let w = info.rcWork;
            let (l, t, r, b) = half((w.left, w.top, w.right, w.bottom), right);
            let (bl, bt, br, bb) = border(hwnd);
            SetWindowPos(hwnd, None, l - bl, t - bt, (r - l) + bl + br, (b - t) + bt + bb, SWP_NOZORDER | SWP_NOACTIVATE)
                .map_err(|e| e.message())?;
        }
        front(hwnd);
        Ok(())
    }

    pub fn apply(raw: isize, action: Action) -> Result<(), String> {
        let hwnd = HWND(raw as *mut _);
        if !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
            return Err("That window just closed.".into());
        }
        match action {
            Action::Focus => front(hwnd),
            Action::Left => snap(hwnd, false)?,
            Action::Right => snap(hwnd, true)?,
            Action::Maximize => unsafe {
                let _ = ShowWindow(hwnd, SW_MAXIMIZE);
                front(hwnd);
            },
            Action::Minimize => unsafe {
                let _ = ShowWindow(hwnd, SW_MINIMIZE);
            },
            Action::Restore => unsafe {
                let _ = ShowWindow(hwnd, SW_RESTORE);
                front(hwnd);
            },
            // As the window's own ×: the app asks about unsaved work itself.
            Action::Close => unsafe {
                PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)).map_err(|e| e.message())?;
            },
        }
        Ok(())
    }
}

/// Gemini Live's arrange_windows.
#[tauri::command]
pub async fn pc_window(window: String, action: Action) -> Result<Done, String> {
    tauri::async_runtime::spawn_blocking(move || run(&window, action)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(id: i64, title: &str, app: &str) -> WindowInfo {
        WindowInfo { id, title: title.into(), app: app.into(), active: false, minimized: false }
    }

    #[test]
    fn windows_are_found_by_their_app_or_their_title() {
        let list = [
            win(1, "lib.rs - Lumo - Visual Studio Code", "Code"),
            win(2, "Budget 2026.xlsx - Excel", "EXCEL"),
            win(3, "YouTube - Google Chrome", "chrome"),
            win(4, "Inbox - Google Chrome", "chrome"),
        ];
        assert_eq!(pick(&list, "code").unwrap().id, 1);
        assert_eq!(pick(&list, "Visual Studio Code").unwrap().id, 1);
        assert_eq!(pick(&list, "excel").unwrap().id, 2);
        assert_eq!(pick(&list, "budget").unwrap().id, 2);
        assert_eq!(pick(&list, "chrome").unwrap().id, 3, "the one in front first");
        assert_eq!(pick(&list, "inbox").unwrap().id, 4);
        assert!(pick(&list, "spotify").is_none());
        assert!(pick(&list, "  ").is_none());
    }

    #[test]
    fn halves_split_the_work_area() {
        assert_eq!(half((0, 0, 1920, 1040), false), (0, 0, 960, 1040));
        assert_eq!(half((0, 0, 1920, 1040), true), (960, 0, 1920, 1040));
        assert_eq!(half((1920, 0, 3840, 1080), true), (2880, 0, 3840, 1080));
    }

    #[test]
    fn actions_read_as_the_model_writes_them() {
        let a: Action = serde_json::from_str("\"maximize\"").unwrap();
        assert_eq!(a, Action::Maximize);
    }
}
