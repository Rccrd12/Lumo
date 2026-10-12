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

mod imp {
    use super::*;

    use std::os::windows::ffi::OsStringExt;
    use std::time::{Duration, Instant};

    use ::windows::Win32::Foundation::HGLOBAL;
    use ::windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard};
    use ::windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
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
