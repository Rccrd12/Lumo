// The chat's files (src/core/chat-files.ts): the files attached in a chat, and
// those Claude Code or Antigravity CLI read, edited or created while answering
// it, which the island lists to open again.
//
// The page names a file by its path, so it could name any file: only a file
// the user attached (directly in the inbox) or one an answer reported here
// (`remember`, from the `chat-file` events) may be opened, shown in File
// Explorer or previewed. That list is kept in chat-files.json, so a past chat
// still opens its files after a restart.
//
// A file is never run: a program or a script (an AI may have just written it)
// is shown in File Explorer instead of being opened.

use std::path::Path;
use std::sync::{LazyLock, Mutex};

use crate::platform;

/// The newest paths are kept past this many.
const MAX_PATHS: usize = 2000;

/// What runs, or makes something run, when opened by its type: shown in File Explorer instead.
const RUNS: &[&str] = &[
    "exe", "com", "bat", "cmd", "ps1", "psm1", "psd1", "ps1xml", "psc1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "ws",
    "msi", "msp", "mst", "scr", "pif", "cpl", "hta", "lnk", "url", "reg", "inf", "jar", "application", "appref-ms",
    "msc", "gadget", "scf", "py", "pyw", "sh", "settingcontent-ms", "library-ms", "search-ms", "appx", "msix",
    "appxbundle", "msixbundle", "dll", "sys", "chm", "xbap", "website",
];

#[derive(Default)]
struct Store {
    /// Normalised paths (`key`), oldest first.
    paths: Vec<String>,
    loaded: bool,
}

static STORE: LazyLock<Mutex<Store>> = LazyLock::new(|| Mutex::new(Store::default()));

fn file() -> std::path::PathBuf {
    platform::local_dir().join("chat-files.json")
}

/// The same file whatever its case or slashes (Windows paths).
fn key(path: &str) -> String {
    path.trim().replace('/', "\\").to_lowercase()
}

fn with_store<R>(f: impl FnOnce(&mut Store) -> R) -> R {
    let mut s = STORE.lock().unwrap_or_else(|p| p.into_inner());
    if !s.loaded {
        s.loaded = true;
        s.paths = std::fs::read_to_string(file()).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
    }
    f(&mut s)
}

/// Adds `path` to `paths` (once, as the newest), the oldest going past MAX_PATHS.
fn added(paths: &mut Vec<String>, path: &str) -> bool {
    let k = key(path);
    if paths.last() == Some(&k) {
        return false;
    }
    paths.retain(|p| *p != k);
    paths.push(k);
    if paths.len() > MAX_PATHS {
        let extra = paths.len() - MAX_PATHS;
        paths.drain(..extra);
    }
    true
}

/// An answer used this file: the island may open it from now on.
pub fn remember(path: &str) {
    with_store(|s| {
        if added(&mut s.paths, path) {
            let path = file();
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if let Ok(text) = serde_json::to_string(&s.paths) {
                let _ = std::fs::write(path, text);
            }
        }
    });
}

/// A file of a chat: one an answer reported, or one the user attached.
fn allowed(path: &str) -> bool {
    let k = key(path);
    with_store(|s| s.paths.contains(&k)) || crate::files::in_inbox(Path::new(path))
}

/// Opened by its type, it would run something.
fn runs(path: &str) -> bool {
    let name = path.rsplit(['/', '\\']).next().unwrap_or("").to_lowercase();
    // Windows drops the dots and spaces a name ends with: "a.cmd. " is a.cmd.
    let name = name.trim_end_matches([' ', '.']);
    // A name with no dot has no type to open it with either.
    match name.rsplit_once('.') {
        Some((_, ext)) => RUNS.contains(&ext),
        None => true,
    }
}

/// What a click on a chat's file did: "opened", "shown" (in File Explorer),
/// "missing" (deleted or moved since), or "refused" (not a file of a chat).
#[tauri::command(async)]
pub fn chat_file_open(path: String) -> &'static str {
    if !allowed(&path) {
        return "refused";
    }
    let p = Path::new(&path);
    if !p.exists() {
        return "missing";
    }
    if p.is_dir() {
        platform::reveal_folder(&path);
        return "shown";
    }
    if runs(&path) {
        platform::reveal_file(&path);
        return "shown";
    }
    platform::open_file(&path);
    "opened"
}

/// "Open file location": File Explorer on its folder, the file selected.
#[tauri::command(async)]
pub fn chat_file_reveal(path: String) -> &'static str {
    if !allowed(&path) {
        return "refused";
    }
    let p = Path::new(&path);
    if p.exists() {
        platform::reveal_file(&path);
        return "shown";
    }
    // Gone: its folder still says where it was.
    match p.parent().filter(|d| d.is_dir()) {
        Some(dir) => {
            platform::reveal_folder(&dir.to_string_lossy());
            "shown"
        }
        None => "missing",
    }
}

/// A chat's picture as a data URL, for its preview; None for any other file.
#[tauri::command(async)]
pub fn chat_file_preview(path: String) -> Option<String> {
    if !allowed(&path) {
        return None;
    }
    crate::files::picture_data(&Path::new(&path).canonicalize().ok()?)
}

/// Which of a chat's files are still there, so a deleted one shows as such.
#[tauri::command(async)]
pub fn chat_files_present(paths: Vec<String>) -> Vec<bool> {
    paths.iter().map(|p| allowed(p) && Path::new(p).exists()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_is_kept_once_as_the_newest_and_the_oldest_go() {
        let mut paths = Vec::new();
        assert!(added(&mut paths, r"C:\Users\me\a.txt"));
        assert!(added(&mut paths, r"C:\Users\me\b.txt"));
        assert!(!added(&mut paths, "c:/users/ME/b.txt"), "the same file, written another way");
        assert!(added(&mut paths, r"C:\Users\me\A.txt"));
        assert_eq!(paths, vec![r"c:\users\me\b.txt".to_string(), r"c:\users\me\a.txt".to_string()]);
        for i in 0..MAX_PATHS + 3 {
            added(&mut paths, &format!(r"C:\f{i}.txt"));
        }
        assert_eq!(paths.len(), MAX_PATHS);
        assert_eq!(paths.last().unwrap(), &format!(r"c:\f{}.txt", MAX_PATHS + 2));
    }

    #[test]
    fn programs_and_scripts_are_never_opened_by_their_type() {
        for p in [r"C:\x\setup.exe", r"C:\x\run.BAT", r"C:\x\a.ps1", r"C:\x\game.py", r"C:\x\link.lnk", r"C:\x\noext", r"C:\x\evil.cmd. ", "/home/x/a.sh"] {
            assert!(runs(p), "{p}");
        }
        for p in [r"C:\x\report.pdf", r"C:\x\notes.md", r"C:\x\photo.JPG", r"C:\x\data.json", r"C:\x\page.html"] {
            assert!(!runs(p), "{p}");
        }
    }

    #[test]
    fn a_file_nobody_reported_is_refused() {
        assert_eq!(chat_file_open(r"C:\Windows\System32\secret-of-nobody.txt".into()), "refused");
        assert_eq!(chat_file_reveal(r"C:\Windows\System32\secret-of-nobody.txt".into()), "refused");
        assert_eq!(chat_file_preview(r"C:\Windows\System32\secret-of-nobody.png".into()), None);
        assert_eq!(chat_files_present(vec![r"C:\Windows\System32\secret-of-nobody.txt".into()]), vec![false]);
    }
}
