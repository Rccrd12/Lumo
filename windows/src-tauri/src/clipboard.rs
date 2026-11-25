// Files copied in File Explorer, pasted in the chat with Ctrl+V.
//
// The chat's text field takes what WebView2 gives the page on paste: text, or
// an image (a Win+Shift+S screenshot) as bytes (files.rs `write_in`). Files
// copied in File Explorer are on the clipboard as CF_HDROP, a list of paths,
// which the page may not see at all: the island asks here, on the paste only,
// and the first file of the list is copied into the inbox like a dropped one.
//
// The text on the clipboard is read here too, for the right-click menu's
// Paste (src/views/context-menu.ts): the page may not read it by itself.

use std::path::PathBuf;

use crate::files::DroppedFile;

/// The first regular file of what was copied: the chat takes one file at a
/// time, like the paperclip. Folders are skipped.
pub fn first_file(paths: &[PathBuf]) -> Option<&PathBuf> {
    paths.iter().find(|p| std::fs::metadata(p).map(|m| m.is_file()).unwrap_or(false))
}

/// The paste in the chat found no text: the file copied in File Explorer, if
/// any, copied into the inbox. `None` when the clipboard holds no file.
pub fn paste_copied_file() -> Result<Option<DroppedFile>, String> {
    let paths = imp::copied_paths();
    match first_file(&paths) {
        Some(path) => crate::files::copy_in(path).map(Some),
        None => Ok(None),
    }
}

/// Longest text Paste puts in a field.
const MAX_TEXT: usize = 1 << 20;

/// The text on the clipboard, if there is some.
pub fn text() -> Option<String> {
    imp::text().map(|t| t.chars().take(MAX_TEXT).collect::<String>()).filter(|t| !t.is_empty())
}

/// Puts `paths` on the clipboard as File Explorer copies files (CF_HDROP),
/// to paste in a folder or in another app. Whether it went.
pub fn put_paths(paths: &[PathBuf]) -> bool {
    !paths.is_empty() && imp::put_paths(&drop_files(paths))
}

/// A DROPFILES block: its 20-byte header (the list starts at byte 20, wide
/// characters), then each path in UTF-16 ending with a zero, and one zero more.
fn drop_files(paths: &[PathBuf]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&20u32.to_le_bytes());
    out.extend_from_slice(&[0u8; 12]);
    out.extend_from_slice(&1u32.to_le_bytes());
    for p in paths {
        for unit in p.to_string_lossy().encode_utf16().chain(std::iter::once(0)) {
            out.extend_from_slice(&unit.to_le_bytes());
        }
    }
    out.extend_from_slice(&[0, 0]);
    out
}

mod imp {
    use super::*;

    use std::os::windows::ffi::OsStringExt;
    use std::time::{Duration, Instant};

    use ::windows::core::w;
    use ::windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
    use ::windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, SetClipboardData,
    };
    use ::windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
    use ::windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE};
    use ::windows::Win32::System::Ole::{CF_HDROP, CF_UNICODETEXT};
    use ::windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    /// More than this is a whole folder's worth: only the first is used anyway.
    const MAX_PATHS: u32 = 64;

    /// Opens the clipboard, waiting a little while another app holds it.
    fn open() -> bool {
        let deadline = Instant::now() + Duration::from_millis(300);
        loop {
            if unsafe { OpenClipboard(None) }.is_ok() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// CF_UNICODETEXT, up to its terminating zero (or the end of its block).
    pub fn text() -> Option<String> {
        if !open() {
            return None;
        }
        let mut out = None;
        unsafe {
            if IsClipboardFormatAvailable(CF_UNICODETEXT.0 as u32).is_ok() {
                if let Ok(handle) = GetClipboardData(CF_UNICODETEXT.0 as u32) {
                    let block = HGLOBAL(handle.0);
                    let units = (GlobalSize(block) / 2).min(MAX_TEXT * 2);
                    let data = GlobalLock(block) as *const u16;
                    if !data.is_null() {
                        let all = std::slice::from_raw_parts(data, units);
                        let end = all.iter().position(|&u| u == 0).unwrap_or(all.len());
                        out = Some(String::from_utf16_lossy(&all[..end]));
                        let _ = GlobalUnlock(block);
                    }
                }
            }
            let _ = CloseClipboard();
        }
        out
    }

    /// `block` (a DROPFILES, drop_files) as the clipboard's only content. The
    /// clipboard needs a window to own what is put on it: one no one sees,
    /// gone once it is put (the content stays).
    pub fn put_paths(block: &[u8]) -> bool {
        unsafe {
            let Ok(owner) = CreateWindowExW(
                WINDOW_EX_STYLE(0), w!("STATIC"), w!(""), WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, None, None,
            ) else {
                return false;
            };
            let deadline = Instant::now() + Duration::from_millis(300);
            let mut opened = false;
            while !opened && Instant::now() < deadline {
                opened = OpenClipboard(Some(owner)).is_ok();
                if !opened {
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
            let mut put = false;
            if opened {
                let _ = EmptyClipboard();
                if let Ok(memory) = GlobalAlloc(GMEM_MOVEABLE, block.len()) {
                    let ptr = GlobalLock(memory);
                    if ptr.is_null() {
                        let _ = GlobalFree(Some(memory));
                    } else {
                        std::ptr::copy_nonoverlapping(block.as_ptr(), ptr as *mut u8, block.len());
                        let _ = GlobalUnlock(memory);
                        // On success the clipboard owns the memory; otherwise it is still ours.
                        put = SetClipboardData(CF_HDROP.0 as u32, Some(HANDLE(memory.0))).is_ok();
                        if !put {
                            let _ = GlobalFree(Some(memory));
                        }
                    }
                }
                let _ = CloseClipboard();
            }
            let _ = DestroyWindow(owner);
            put
        }
    }

    /// The paths of CF_HDROP, front to back; empty when there is none or
    /// another app holds the clipboard past a short wait.
    pub fn copied_paths() -> Vec<PathBuf> {
        if !open() {
            return Vec::new();
        }
        let mut out = Vec::new();
        unsafe {
            if IsClipboardFormatAvailable(CF_HDROP.0 as u32).is_ok() {
                if let Ok(handle) = GetClipboardData(CF_HDROP.0 as u32) {
                    let drop = HDROP(handle.0);
                    let count = DragQueryFileW(drop, u32::MAX, None).min(MAX_PATHS);
                    for i in 0..count {
                        let len = DragQueryFileW(drop, i, None) as usize;
                        if len == 0 {
                            continue;
                        }
                        let mut buf = vec![0u16; len + 1];
                        let got = DragQueryFileW(drop, i, Some(&mut buf)) as usize;
                        buf.truncate(got.min(len));
                        out.push(PathBuf::from(std::ffi::OsString::from_wide(&buf)));
                    }
                }
            }
            let _ = CloseClipboard();
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_copied_file_is_a_dropfiles_block_of_wide_paths() {
        let block = drop_files(&[PathBuf::from(r"C:\a.png"), PathBuf::from("b")]);
        assert_eq!(&block[..4], &20u32.to_le_bytes(), "the list starts after the header");
        assert_eq!(&block[16..20], &1u32.to_le_bytes(), "wide characters");
        let units: Vec<u16> = block[20..].chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let mut want: Vec<u16> = r"C:\a.png".encode_utf16().collect();
        want.extend([0, b'b' as u16, 0, 0]);
        assert_eq!(units, want);
    }

    #[test]
    fn the_first_regular_file_is_the_one_pasted() {
        let dir = std::env::temp_dir().join(format!("lumo-clipboard-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("Folder")).unwrap();
        std::fs::write(dir.join("b.txt"), b"b").unwrap();
        std::fs::write(dir.join("a.pdf"), b"a").unwrap();
        let paths = vec![dir.join("Folder"), dir.join("gone.txt"), dir.join("b.txt"), dir.join("a.pdf")];
        assert_eq!(first_file(&paths), Some(&dir.join("b.txt")), "folders and missing files are skipped");
        assert_eq!(first_file(&paths[..2]), None);
        assert_eq!(first_file(&[]), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
