// What is on the user's screen, for the chat — only when they ask for it.
//
// The screen button in the chat offers "Open windows" and one entry per
// display. Nothing here runs until the user clicks one of them: there is no
// background capture, no timer, nothing kept in memory. The window list is
// titles and app names only. A screenshot is one PNG per display, downscaled
// so its long edge is at most 1568 px (what Claude reads at full detail),
// written to the same inbox as dropped files (files.rs) so Claude Code can
// read it from its path; the island shows it first, and Cancel deletes it.
//
// Windows: EnumWindows for the list, GDI for the capture, WIC for the PNG,
// all through the `windows` crate. Linux: not available yet.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::i18n::t;
use crate::platform::LocalTime;

/// A screenshot's long edge, at most: Claude's own limit before it downscales.
#[cfg_attr(not(windows), allow(dead_code))] // Linux has no capture yet
pub const MAX_EDGE: u32 = 1568;
/// The list is for context, not an inventory.
const MAX_WINDOWS: usize = 60;
const MAX_TITLE_CHARS: usize = 160;

/// One open window, as the chat shows it and the model reads it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub title: String,
    pub app: String,
    /// The window the user was in (the one in front, Coucou aside).
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub minimized: bool,
}

/// One display the user can capture. `index` is its place in the menu.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Display {
    pub index: usize,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

/// A screenshot just written to the inbox, with a data URL for the preview.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    /// The display it shows, from 0, in menu order.
    pub display: usize,
    pub name: String,
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub preview: String,
}

/// A screenshot the user kept, as the chat sends it back with a question.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShotRef {
    pub name: String,
    pub path: String,
}

/// What the user added from the screen button, sent once with the next question.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenContext {
    #[serde(default)]
    pub windows: Vec<WindowInfo>,
    #[serde(default)]
    pub shots: Vec<ShotRef>,
}

impl ScreenContext {
    pub fn is_empty(&self) -> bool {
        self.windows.is_empty() && self.shots.is_empty()
    }
}

// ── Pure parts ────────────────────────────────────────────────────────────────

/// The size a `width` × `height` capture is saved at: the same, or scaled
/// down so the long edge is `max`, keeping the aspect ratio.
#[cfg_attr(not(windows), allow(dead_code))] // Linux has no capture yet
pub fn fit(width: u32, height: u32, max: u32) -> (u32, u32) {
    let long = width.max(height);
    if long <= max || long == 0 {
        return (width, height);
    }
    let scale = |v: u32| (((v as u64 * max as u64) + long as u64 / 2) / long as u64).max(1) as u32;
    if width >= height {
        (max, scale(height))
    } else {
        (scale(width), max)
    }
}

/// The inbox file name of a screenshot of display `index` (from 0), taken at `at`.
#[cfg_attr(not(windows), allow(dead_code))] // Linux has no capture yet
pub fn shot_file_name(at: &LocalTime, index: usize) -> String {
    format!(
        "screenshot-{:04}-{:02}-{:02}-{:02}{:02}{:02}-screen{}.png",
        at.year,
        at.month,
        at.day,
        at.hour,
        at.minute,
        at.second,
        index + 1
    )
}

/// An executable's name without its folder or `.exe`: "Code", "chrome".
#[cfg_attr(not(windows), allow(dead_code))] // Linux has no capture yet
pub fn app_name(exe_path: &str) -> String {
    let file = exe_path.rsplit(['\\', '/']).next().unwrap_or(exe_path);
    match file.len().checked_sub(4) {
        Some(cut) if file.is_char_boundary(cut) && file[cut..].eq_ignore_ascii_case(".exe") => file[..cut].to_string(),
        _ => file.to_string(),
    }
}

/// A title cut to a sensible length, on one line.
pub fn clip_title(title: &str) -> String {
    let one_line: String = title.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let trimmed = one_line.trim();
    if trimmed.chars().count() <= MAX_TITLE_CHARS {
        return trimmed.to_string();
    }
    let mut cut: String = trimmed.chars().take(MAX_TITLE_CHARS - 1).collect();
    cut.push('…');
    cut
}

/// Marks the window the user was in: the foreground one when it is in the
/// list, else the first (front-most) one — Coucou's own island, which the
/// click just went to, is never listed.
#[cfg_attr(not(windows), allow(dead_code))] // Linux has no capture yet
pub fn mark_active(list: &mut [WindowInfo], foreground: Option<usize>) {
    for w in list.iter_mut() {
        w.active = false;
    }
    let pick = foreground.filter(|i| *i < list.len()).or(if list.is_empty() { None } else { Some(0) });
    if let Some(i) = pick {
        list[i].active = true;
    }
}

/// The window list as the model reads it, front to back.
pub fn windows_text(list: &[WindowInfo]) -> String {
    let mut out = String::from("Windows open on the user's computer, front to back (titles and app names only, shared by the user just now):\n");
    for w in list.iter().take(MAX_WINDOWS) {
        let title = clip_title(&w.title);
        let app = clip_title(&w.app);
        out.push_str("- ");
        out.push_str(&title);
        if !app.is_empty() {
            out.push_str(&format!(" — {app}"));
        }
        if w.active {
            out.push_str(" (active)");
        }
        if w.minimized {
            out.push_str(" (minimized)");
        }
        out.push('\n');
    }
    out
}

/// What the screen context adds before the question. `with_paths`: the model
/// reads the screenshots from the inbox (Claude Code); otherwise the images
/// travel with the message and only their names are said.
pub fn context_text(screen: &ScreenContext, with_paths: bool) -> String {
    let mut out = String::new();
    if !screen.shots.is_empty() {
        if with_paths {
            out.push_str("The user shared screenshots of their screen, taken just now at their request. Read them from these paths:\n");
            for s in &screen.shots {
                out.push_str(&format!("- {}: {}\n", clip_title(&s.name), s.path));
            }
        } else {
            let names: Vec<String> = screen.shots.iter().map(|s| clip_title(&s.name)).collect();
            out.push_str(&format!(
                "The user shared screenshots of their screen, taken just now at their request (attached: {}).\n",
                names.join(", ")
            ));
        }
        out.push('\n');
    }
    if !screen.windows.is_empty() {
        out.push_str(&windows_text(&screen.windows));
        out.push('\n');
    }
    out
}

/// The menu order of displays given as (x, y, primary): the primary display
/// first, then the others left to right, top to bottom.
#[cfg_attr(not(windows), allow(dead_code))] // Linux has no capture yet
pub fn display_order(rects: &[(i32, i32, bool)]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..rects.len()).collect();
    order.sort_by_key(|&i| {
        let (x, y, primary) = rects[i];
        (!primary, x, y)
    });
    order
}

// ── Screenshots Coucou wrote ──────────────────────────────────────────────────

/// Screenshots taken this session: only these can be deleted from the page.
static TAKEN: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn remember(path: &Path) {
    let mut list = TAKEN.lock().unwrap_or_else(|e| e.into_inner());
    list.push(path.to_path_buf());
    let excess = list.len().saturating_sub(64);
    list.drain(..excess);
}

/// Cancel in the preview, or a screenshot removed before it was sent: deletes
/// the file. Anything that is not one of this session's screenshots is left alone.
pub fn discard(paths: &[String]) {
    let mut list = TAKEN.lock().unwrap_or_else(|e| e.into_inner());
    for p in paths {
        let path = PathBuf::from(p);
        if let Some(i) = list.iter().position(|taken| *taken == path) {
            let _ = std::fs::remove_file(&path);
            list.remove(i);
        }
    }
}

fn preview_url(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(format!("data:image/png;base64,{}", crate::claude::base64_for(&bytes)))
}

// ── Platform ──────────────────────────────────────────────────────────────────

/// The displays, in menu order. Asked when the menu opens; captures nothing.
pub fn displays() -> Result<Vec<Display>, String> {
    imp::displays()
}

/// The visible top-level windows, front to back, Coucou's own aside.
pub fn windows() -> Result<Vec<WindowInfo>, String> {
    imp::windows()
}

/// Captures display `index`, or every display when `None`, into the inbox.
/// `settle`: the island was just asked to keep out of the picture (lib.rs);
/// give the compositor a frame or two to drop it first.
pub fn capture(index: Option<usize>, settle: bool) -> Result<Vec<Shot>, String> {
    let shots = imp::capture(index, settle)?;
    let mut out = Vec::new();
    for (display, path, width, height) in shots {
        remember(&path);
        let preview = match preview_url(&path) {
            Ok(url) => url,
            Err(e) => {
                discard(&[path.to_string_lossy().to_string()]);
                return Err(e);
            }
        };
        out.push(Shot {
            display,
            name: path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
            path: path.to_string_lossy().to_string(),
            width,
            height,
            preview,
        });
    }
    Ok(out)
}

#[cfg(not(windows))]
mod imp {
    use super::*;

    fn unavailable<T>() -> Result<T, String> {
        Err(t("Not available on Linux yet."))
    }

    pub fn displays() -> Result<Vec<Display>, String> {
        unavailable()
    }

    pub fn windows() -> Result<Vec<WindowInfo>, String> {
        unavailable()
    }

    pub fn capture(_index: Option<usize>, _settle: bool) -> Result<Vec<(usize, PathBuf, u32, u32)>, String> {
        unavailable()
    }
}

#[cfg(windows)]
mod imp {
    use super::*;

    use std::collections::HashMap;
    use std::os::windows::ffi::OsStrExt;
    use std::time::Duration;

    use ::windows::core::{BOOL, GUID, PCWSTR, PWSTR};
    use ::windows::Win32::Foundation::{CloseHandle, GENERIC_WRITE, HWND, LPARAM, RECT};
    use ::windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use ::windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, EnumDisplayMonitors, GetDC,
        GetDIBits, GetMonitorInfoW, ReleaseDC, SelectObject, SetBrushOrgEx, SetStretchBltMode, StretchBlt,
        BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HALFTONE, HDC, HMONITOR, MONITORINFO, SRCCOPY,
    };
    use ::windows::Win32::Graphics::Imaging::{
        CLSID_WICImagingFactory, GUID_ContainerFormatPng, GUID_WICPixelFormat24bppBGR, IWICImagingFactory,
        WICBitmapEncoderNoCache,
    };
    use ::windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use ::windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use ::windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetForegroundWindow, GetWindow, GetWindowLongPtrW, GetWindowTextW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, GW_OWNER, MONITORINFOF_PRIMARY,
        WS_EX_TOOLWINDOW,
    };

    // ── Displays ──────────────────────────────────────────────────────────────

    /// Every monitor's rectangle in physical pixels, in menu order.
    fn monitors() -> Vec<(RECT, bool)> {
        unsafe extern "system" fn each(monitor: HMONITOR, _: HDC, _: *mut RECT, data: LPARAM) -> BOOL {
            let list = unsafe { &mut *(data.0 as *mut Vec<(RECT, bool)>) };
            let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            if unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool() {
                list.push((info.rcMonitor, info.dwFlags & MONITORINFOF_PRIMARY != 0));
            }
            true.into()
        }
        let mut found: Vec<(RECT, bool)> = Vec::new();
        unsafe {
            let _ = EnumDisplayMonitors(None, None, Some(each), LPARAM(&mut found as *mut _ as isize));
        }
        let keys: Vec<(i32, i32, bool)> = found.iter().map(|(r, p)| (r.left, r.top, *p)).collect();
        display_order(&keys).into_iter().map(|i| found[i]).collect()
    }

    pub fn displays() -> Result<Vec<Display>, String> {
        Ok(monitors()
            .into_iter()
            .enumerate()
            .map(|(index, (r, primary))| Display {
                index,
                width: (r.right - r.left).max(0) as u32,
                height: (r.bottom - r.top).max(0) as u32,
                primary,
            })
            .collect())
    }

    // ── Windows ───────────────────────────────────────────────────────────────

    struct Found {
        hwnd: isize,
        pid: u32,
        title: String,
        minimized: bool,
    }

    /// Classes of the desktop and the taskbar: always there, never what the user means.
    const SHELL_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

    fn is_cloaked(hwnd: HWND) -> bool {
        let mut cloaked = 0u32;
        let ok = unsafe {
            DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, std::mem::size_of::<u32>() as u32)
        };
        ok.is_ok() && cloaked != 0
    }

    fn class_name(hwnd: HWND) -> String {
        let mut buf = [0u16; 128];
        let len = unsafe { GetClassNameW(hwnd, &mut buf) };
        String::from_utf16_lossy(&buf[..len.max(0) as usize])
    }

    fn exe_name(pid: u32) -> String {
        unsafe {
            let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len);
            let _ = CloseHandle(process);
            if ok.is_err() {
                return String::new();
            }
            app_name(&String::from_utf16_lossy(&buf[..len as usize]))
        }
    }

    pub fn windows() -> Result<Vec<WindowInfo>, String> {
        unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let list = unsafe { &mut *(lparam.0 as *mut Vec<Found>) };
            unsafe {
                if !IsWindowVisible(hwnd).as_bool() || GetWindow(hwnd, GW_OWNER).is_ok() {
                    return true.into();
                }
                if GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW.0 != 0 || is_cloaked(hwnd) {
                    return true.into();
                }
                let mut text = [0u16; 512];
                let len = GetWindowTextW(hwnd, &mut text);
                if len <= 0 || SHELL_CLASSES.contains(&class_name(hwnd).as_str()) {
                    return true.into();
                }
                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
                list.push(Found {
                    hwnd: hwnd.0 as isize,
                    pid,
                    title: String::from_utf16_lossy(&text[..len as usize]),
                    minimized: IsIconic(hwnd).as_bool(),
                });
            }
            true.into()
        }

        let mut found: Vec<Found> = Vec::new();
        unsafe {
            EnumWindows(Some(collect), LPARAM(&mut found as *mut _ as isize))
                .map_err(|e| crate::i18n::tf("Couldn't list the windows: {error}", &[("error", &e.message())]))?;
        }
        let own = std::process::id();
        found.retain(|w| w.pid != own && !w.title.trim().is_empty());
        found.truncate(MAX_WINDOWS);

        let foreground = unsafe { GetForegroundWindow() }.0 as isize;
        let mut names: HashMap<u32, String> = HashMap::new();
        let mut list: Vec<WindowInfo> = found
            .iter()
            .map(|w| WindowInfo {
                title: clip_title(&w.title),
                app: names.entry(w.pid).or_insert_with(|| exe_name(w.pid)).clone(),
                active: false,
                minimized: w.minimized,
            })
            .collect();
        mark_active(&mut list, found.iter().position(|w| w.hwnd == foreground));
        Ok(list)
    }

    // ── Capture ───────────────────────────────────────────────────────────────

    /// Copies `r` of the desktop into a `w` × `h` bitmap (scaled with GDI's
    /// halftone filter when smaller) and returns it as tightly packed BGR rows.
    fn grab(r: RECT, w: u32, h: u32) -> Result<Vec<u8>, String> {
        let (src_w, src_h) = (r.right - r.left, r.bottom - r.top);
        let (dst_w, dst_h) = (w as i32, h as i32);
        unsafe {
            let screen = GetDC(None);
            if screen.is_invalid() {
                return Err("GetDC failed".into());
            }
            let mem = CreateCompatibleDC(Some(screen));
            let bitmap = CreateCompatibleBitmap(screen, dst_w, dst_h);
            if mem.is_invalid() || bitmap.is_invalid() {
                if !bitmap.is_invalid() {
                    let _ = DeleteObject(bitmap.into());
                }
                if !mem.is_invalid() {
                    let _ = DeleteDC(mem);
                }
                ReleaseDC(None, screen);
                return Err("Out of graphics memory".into());
            }
            let old = SelectObject(mem, bitmap.into());
            let copied = if (src_w, src_h) == (dst_w, dst_h) {
                BitBlt(mem, 0, 0, dst_w, dst_h, Some(screen), r.left, r.top, SRCCOPY).is_ok()
            } else {
                SetStretchBltMode(mem, HALFTONE);
                let _ = SetBrushOrgEx(mem, 0, 0, None);
                StretchBlt(mem, 0, 0, dst_w, dst_h, Some(screen), r.left, r.top, src_w, src_h, SRCCOPY).as_bool()
            };
            // GetDIBits wants the bitmap out of any device context.
            SelectObject(mem, old);

            let mut info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: dst_w,
                    biHeight: -dst_h, // top-down rows
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bgra = vec![0u8; w as usize * h as usize * 4];
            let lines = if copied {
                GetDIBits(mem, bitmap, 0, h, Some(bgra.as_mut_ptr() as *mut _), &mut info, DIB_RGB_COLORS)
            } else {
                0
            };
            let _ = DeleteObject(bitmap.into());
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            if !copied || lines != dst_h {
                return Err("The screen could not be copied".into());
            }
            Ok(bgra.chunks_exact(4).flat_map(|p| [p[0], p[1], p[2]]).collect())
        }
    }

    /// Writes 24-bit BGR rows as a PNG with the Windows Imaging Component.
    fn write_png(path: &std::path::Path, w: u32, h: u32, bgr: &[u8]) -> ::windows::core::Result<()> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        unsafe {
            let factory: IWICImagingFactory = CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)?;
            let stream = factory.CreateStream()?;
            stream.InitializeFromFilename(PCWSTR(wide.as_ptr()), GENERIC_WRITE.0)?;
            let encoder = factory.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null())?;
            encoder.Initialize(&stream, WICBitmapEncoderNoCache)?;
            let mut frame = None;
            let mut options = None;
            encoder.CreateNewFrame(&mut frame, &mut options)?;
            let frame = frame.ok_or_else(::windows::core::Error::empty)?;
            frame.Initialize(options.as_ref())?;
            frame.SetSize(w, h)?;
            let mut format: GUID = GUID_WICPixelFormat24bppBGR;
            frame.SetPixelFormat(&mut format)?;
            if format != GUID_WICPixelFormat24bppBGR {
                return Err(::windows::core::Error::empty());
            }
            frame.WritePixels(h, w * 3, bgr)?;
            frame.Commit()?;
            encoder.Commit()?;
        }
        Ok(())
    }

    fn save(index: usize, r: RECT) -> Result<(usize, PathBuf, u32, u32), String> {
        let (src_w, src_h) = ((r.right - r.left).max(0) as u32, (r.bottom - r.top).max(0) as u32);
        if src_w == 0 || src_h == 0 {
            return Err(t("That screen isn't connected anymore."));
        }
        let (w, h) = fit(src_w, src_h, MAX_EDGE);
        let pixels = grab(r, w, h)?;
        let path = crate::files::new_inbox_file(&shot_file_name(&crate::platform::local_time(), index))?;
        if let Err(e) = write_png(&path, w, h, &pixels) {
            let _ = std::fs::remove_file(&path);
            return Err(e.message());
        }
        Ok((index, path, w, h))
    }

    pub fn capture(index: Option<usize>, settle: bool) -> Result<Vec<(usize, PathBuf, u32, u32)>, String> {
        let all = monitors();
        let wanted: Vec<(usize, RECT)> = match index {
            Some(i) => vec![(i, all.get(i).map(|m| m.0).ok_or_else(|| t("That screen isn't connected anymore."))?)],
            None => all.iter().enumerate().map(|(i, m)| (i, m.0)).collect(),
        };
        // COM for WIC on this worker thread; S_FALSE (already on) is fine too.
        let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if settle {
            std::thread::sleep(Duration::from_millis(150));
        }
        let result = (|| {
            let mut out = Vec::new();
            for (i, r) in wanted {
                match save(i, r) {
                    Ok(shot) => out.push(shot),
                    Err(e) => {
                        for (_, path, _, _) in &out {
                            let _ = std::fs::remove_file(path);
                        }
                        return Err(e);
                    }
                }
            }
            Ok(out)
        })();
        if com.is_ok() {
            unsafe { CoUninitialize() };
        }
        result.map_err(|e| crate::i18n::tf("Couldn't take the screenshot: {error}", &[("error", &e)]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(title: &str, app: &str) -> WindowInfo {
        WindowInfo { title: title.into(), app: app.into(), active: false, minimized: false }
    }

    #[test]
    fn a_capture_is_scaled_down_to_a_long_edge_of_1568_keeping_its_shape() {
        assert_eq!(fit(1280, 720, MAX_EDGE), (1280, 720), "small enough already");
        assert_eq!(fit(1568, 1000, MAX_EDGE), (1568, 1000));
        assert_eq!(fit(3840, 2160, MAX_EDGE), (1568, 882));
        assert_eq!(fit(2560, 1440, MAX_EDGE), (1568, 882));
        assert_eq!(fit(1920, 1080, MAX_EDGE), (1568, 882));
        assert_eq!(fit(1440, 2560, MAX_EDGE), (882, 1568), "portrait display");
        assert_eq!(fit(5120, 1440, MAX_EDGE), (1568, 441), "ultrawide");
        assert_eq!(fit(100_000, 10, MAX_EDGE), (1568, 1), "never zero");
        assert_eq!(fit(0, 0, MAX_EDGE), (0, 0));
    }

    #[test]
    fn screenshots_are_named_by_time_and_screen() {
        let at = LocalTime { year: 2026, month: 10, day: 8, hour: 9, minute: 5, second: 3 };
        assert_eq!(shot_file_name(&at, 0), "screenshot-2026-10-08-090503-screen1.png");
        assert_eq!(shot_file_name(&at, 1), "screenshot-2026-10-08-090503-screen2.png");
    }

    #[test]
    fn app_names_and_titles_are_tidied() {
        assert_eq!(app_name("C:\\Program Files\\Microsoft VS Code\\Code.exe"), "Code");
        assert_eq!(app_name("C:\\Windows\\explorer.EXE"), "explorer");
        assert_eq!(app_name("/usr/bin/firefox"), "firefox");
        assert_eq!(app_name("é.exe"), "é");
        assert_eq!(app_name(""), "");
        assert_eq!(clip_title("  a\nb\t "), "a b");
        let long = "x".repeat(500);
        let clipped = clip_title(&long);
        assert_eq!(clipped.chars().count(), MAX_TITLE_CHARS);
        assert!(clipped.ends_with('…'));
    }

    #[test]
    fn the_foreground_window_is_marked_else_the_front_most_one() {
        let mut list = vec![win("a", "x"), win("b", "y"), win("c", "z")];
        mark_active(&mut list, Some(2));
        assert_eq!(list.iter().map(|w| w.active).collect::<Vec<_>>(), [false, false, true]);
        mark_active(&mut list, None);
        assert_eq!(list.iter().map(|w| w.active).collect::<Vec<_>>(), [true, false, false]);
        mark_active(&mut list, Some(9));
        assert!(list[0].active);
        let mut empty: Vec<WindowInfo> = Vec::new();
        mark_active(&mut empty, None);
    }

    #[test]
    fn the_window_list_reads_front_to_back() {
        let mut list = vec![win("main.rs — coucou", "Code"), win("Inbox", "outlook"), win("Notes", "")];
        list[0].active = true;
        list[1].minimized = true;
        let text = windows_text(&list);
        assert!(text.starts_with("Windows open on the user's computer, front to back"));
        assert!(text.contains("- main.rs — coucou — Code (active)\n"));
        assert!(text.contains("- Inbox — outlook (minimized)\n"));
        assert!(text.contains("- Notes\n"));
        let many: Vec<WindowInfo> = (0..100).map(|i| win(&format!("w{i}"), "a")).collect();
        assert_eq!(windows_text(&many).lines().count(), 1 + MAX_WINDOWS);
    }

    #[test]
    fn the_context_says_where_the_screenshots_are_or_only_names_them() {
        let screen = ScreenContext {
            windows: vec![win("Docs", "msedge")],
            shots: vec![
                ShotRef { name: "Screen 1".into(), path: "C:\\inbox\\screenshot-1.png".into() },
                ShotRef { name: "Screen 2".into(), path: "C:\\inbox\\screenshot-2.png".into() },
            ],
        };
        let cli = context_text(&screen, true);
        assert!(cli.contains("Read them from these paths:\n- Screen 1: C:\\inbox\\screenshot-1.png\n- Screen 2: C:\\inbox\\screenshot-2.png\n"));
        assert!(cli.contains("- Docs — msedge\n"));
        let api = context_text(&screen, false);
        assert!(api.contains("(attached: Screen 1, Screen 2)"));
        assert!(!api.contains("C:\\inbox"), "the API gets the images, not paths");
        assert_eq!(context_text(&ScreenContext::default(), true), "");
        assert!(ScreenContext::default().is_empty());
    }

    #[test]
    fn the_primary_display_comes_first_then_left_to_right() {
        assert_eq!(display_order(&[(1920, 0, false), (0, 0, true), (-1920, 0, false)]), vec![1, 2, 0]);
        assert_eq!(display_order(&[(0, 0, true)]), vec![0]);
        assert!(display_order(&[]).is_empty());
    }

    #[test]
    fn only_this_sessions_screenshots_can_be_discarded() {
        let dir = std::env::temp_dir().join(format!("coucou-screen-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ours = dir.join("screenshot-a.png");
        let other = dir.join("other.png");
        std::fs::write(&ours, b"png").unwrap();
        std::fs::write(&other, b"png").unwrap();
        remember(&ours);
        discard(&[ours.to_string_lossy().to_string(), other.to_string_lossy().to_string()]);
        assert!(!ours.exists());
        assert!(other.exists(), "never taken by Coucou: left alone");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
