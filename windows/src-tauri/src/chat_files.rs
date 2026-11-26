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
//
// An answer may name a file in its text, by its name or its whole path, or
// link it ([name](path)): `chat_file_find` turns those names into the paths
// the island may open, and only for files the chat already knows, the inbox's
// and those beside them (concepts/file-cliccabili-in-chat).

use std::path::Path;
use std::sync::{LazyLock, Mutex};

use crate::platform;

/// The newest paths are kept past this many.
const MAX_PATHS: usize = 2000;

/// What runs, or makes something run, when opened by its type: shown in File
/// Explorer instead. The one list for every place Lumo opens a file by its
/// type (here, and Gemini Live's live.rs is_runnable).
const RUNS: &[&str] = &[
    "exe", "com", "bat", "cmd", "ps1", "psm1", "psd1", "ps1xml", "psc1", "vbs", "vbe", "vb", "js", "jse", "wsf", "wsh", "ws",
    "msi", "msp", "mst", "scr", "pif", "cpl", "hta", "lnk", "url", "reg", "inf", "jar", "jnlp", "application", "appref-ms",
    "msc", "gadget", "scf", "py", "pyw", "pl", "rb", "sh", "bash", "zsh", "fish", "run", "bin", "command", "scpt", "app",
    "settingcontent-ms", "library-ms", "search-ms", "searchconnector-ms", "appx", "msix", "appxbundle", "msixbundle",
    "appinstaller", "dll", "ocx", "sys", "chm", "xbap", "website", "wsb", "ins", "isp", "its",
    // Add-ins, connections, disk images and archives that mount or unpack and
    // run, troubleshooters, sandboxes that run a command at start.
    "xll", "rdp", "iso", "img", "vhd", "vhdx", "cab", "diagcab", "wsc", "sct",
    // Documents with macros (and the old formats, which carry them without
    // saying so), databases that run them, OneNote's, web archives.
    "docm", "dotm", "xlsm", "xltm", "xlam", "pptm", "potm", "ppam", "ppsm", "sldm", "doc", "dot", "xls", "xlt", "xla",
    "xlsb", "ppt", "pot", "pps", "mdb", "mde", "accdb", "accde", "accdr", "ade", "adp", "one", "onepkg", "mht", "mhtml",
    // Themes, which fetch from a network share (and hand it the Windows login).
    "theme", "themepack", "deskthemepack",
    // Updates that install, Python zip apps and bytecode the launcher runs,
    // Office add-ins that install, Excel web queries and SYLK (DDE).
    "msu", "pyz", "pyzw", "pyc", "pyo", "vsto", "iqy", "slk",
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
    with_store(|s| s.paths.contains(&k)) || crate::files::is_chat_copy(Path::new(path))
}

/// Opened by its type, it would run something (or has no type to open it
/// with): never opened that way, whoever asks.
pub fn runs(path: &str) -> bool {
    let name = path.rsplit(['/', '\\']).next().unwrap_or("").to_lowercase();
    // Windows drops the dots and spaces a name ends with: "a.cmd. " is a.cmd.
    let name = name.trim_end_matches([' ', '.']);
    // A stream of a file (`a.txt:x.exe`) is not a document to open.
    if name.contains(':') {
        return true;
    }
    // A name with no dot has no type to open it with either.
    match name.rsplit_once('.') {
        Some((_, ext)) => RUNS.contains(&ext),
        None => true,
    }
}

/// A path that names a place on another computer (`\\server\share`,
/// `//server`): never looked at, since even asking whether it is there would
/// hand the server the Windows login.
fn remote(path: &str) -> bool {
    let p = path.trim();
    p.starts_with("\\\\") || p.starts_with("//") || p.starts_with("\\/") || p.starts_with("/\\")
}

/// A drive's path, `C:\…` or `C:/…`.
fn on_drive(path: &str) -> bool {
    let b = path.as_bytes();
    b.len() > 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

/// A name an answer wrote that may stand for a file: a whole path on a drive,
/// or a name or a short path under a known folder; never a parent folder's
/// `..`, another computer's place, a stream (`a:b`) or anything too long.
fn usable_name(name: &str) -> bool {
    let n = name.trim();
    !n.is_empty()
        && n.len() <= 400
        && !remote(n)
        && !n.split(['\\', '/']).any(|part| part == "..")
        && !n.chars().any(|c| c.is_control() || matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
        && (on_drive(n) || !n.contains(':'))
        && (on_drive(n) || !n.starts_with(['\\', '/']))
}

/// The folders a chat's known files are in: a file named beside one of them
/// or in a folder or two under it, that folder itself and the one above it,
/// may be opened.
fn known_dirs(known: &[String]) -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    for path in known.iter().filter(|p| on_drive(p.trim()) && allowed(p)) {
        let Some(d) = Path::new(path.trim()).parent().filter(|d| d.parent().is_some()) else { continue };
        if !dirs.iter().any(|x| key(&x.to_string_lossy()) == key(&d.to_string_lossy())) {
            dirs.push(d.to_path_buf());
        }
    }
    dirs
}

/// `path` is a folder of `dirs` or the one above it, or inside one at most
/// two folders down.
fn near(path: &Path, dirs: &[std::path::PathBuf]) -> bool {
    let k = key(&path.to_string_lossy());
    let mut up: Vec<String> = Vec::new();
    let mut at = Some(path);
    for _ in 0..3 {
        let Some(p) = at else { break };
        up.push(key(&p.to_string_lossy()));
        at = p.parent();
    }
    dirs.iter().any(|d| {
        up.contains(&key(&d.to_string_lossy())) || d.parent().is_some_and(|above| key(&above.to_string_lossy()) == k)
    })
}

/// What an answer's name stands for: the file or folder, once it is there.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct FoundFile {
    pub path: String,
    pub folder: bool,
}

/// The file or folder `name` stands for, among the chat's `known` files, the
/// inbox and the folders they are in; None when it is none of them or not there.
fn find_one(name: &str, known: &[String], dirs: &[std::path::PathBuf]) -> Option<FoundFile> {
    let n = name.trim().trim_start_matches("file:///");
    if !usable_name(n) {
        return None;
    }
    let found = |p: &Path| -> Option<FoundFile> {
        let meta = std::fs::metadata(p).ok()?;
        // Windows' own separators: the path is shown, copied and opened as it is.
        Some(FoundFile { path: p.to_string_lossy().replace('/', "\\"), folder: meta.is_dir() })
    };
    if on_drive(n) {
        let p = Path::new(n);
        if allowed(n) || near(p, dirs) {
            return found(p);
        }
        return None;
    }
    // A known file of that name, the newest first (the island lists them so).
    let lower = n.replace('/', "\\").to_lowercase();
    for path in known.iter().filter(|p| on_drive(p.trim()) && allowed(p)) {
        let k = key(path);
        if k.ends_with(&format!("\\{lower}")) {
            if let Some(f) = found(Path::new(path.trim())) {
                return Some(f);
            }
        }
    }
    // Beside the chat's own files first: a file of the same name in the inbox
    // may be another chat's attachment.
    for dir in dirs {
        let p = dir.join(n);
        if p.exists() && near(&p, dirs) {
            return found(&p);
        }
    }
    let p = crate::files::inbox_dir().join(n);
    if p.exists() && crate::files::in_inbox(&p) {
        return found(&p);
    }
    None
}

/// The files and folders an answer named (its links, the names and paths in
/// its text): each one's path, or None. `known` are the chat's files as the
/// island lists them; only those this side knows count. What is found may be
/// opened from then on.
#[tauri::command(async)]
pub fn chat_file_find(names: Vec<String>, known: Vec<String>) -> Vec<Option<FoundFile>> {
    let dirs = known_dirs(&known);
    names
        .iter()
        .take(200)
        .map(|name| {
            let found = find_one(name, &known, &dirs);
            if let Some(f) = &found {
                remember(&f.path);
            }
            found
        })
        .collect()
}

/// "Open with…": Windows asks which app opens the file. Never for a file that
/// would run something: that one is shown in File Explorer.
#[tauri::command(async)]
pub fn chat_file_open_with(path: String) -> &'static str {
    if !allowed(&path) {
        return "refused";
    }
    let p = Path::new(&path);
    if !p.is_file() {
        return "missing";
    }
    if runs(&path) {
        platform::reveal_file(&path);
        return "shown";
    }
    platform::open_with(&path);
    "opened"
}

/// "Copy file": the file on the clipboard as File Explorer copies one, to
/// paste in a folder, an email or another chat.
#[tauri::command(async)]
pub fn chat_file_copy(path: String) -> &'static str {
    if !allowed(&path) {
        return "refused";
    }
    if !Path::new(&path).exists() {
        return "missing";
    }
    if crate::clipboard::put_paths(&[std::path::PathBuf::from(&path)]) {
        "copied"
    } else {
        "failed"
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
        for p in [r"C:\x\setup.exe", r"C:\x\run.BAT", r"C:\x\a.ps1", r"C:\x\game.py", r"C:\x\link.lnk", r"C:\x\noext", r"C:\x\evil.cmd. ", "/home/x/a.sh",
            r"C:\x\box.wsb", r"C:\x\old.xls", r"C:\x\old.doc", r"C:\x\db.accde", r"C:\x\notes.one", r"C:\x\a.theme", r"C:\x\a.cab",
            r"C:\x\a.searchConnector-ms", r"C:\x\page.mht", r"C:\x\a.txt:x.exe",
            // Bug report #117.
            r"C:\x\update.msu", r"C:\x\tool.pyz", r"C:\x\tool.pyzw", r"C:\x\x.pyc", r"C:\x\addin.vsto", r"C:\x\q.iqy", r"C:\x\a.SLK"] {
            assert!(runs(p), "{p}");
        }
        for p in [r"C:\x\report.pdf", r"C:\x\notes.md", r"C:\x\photo.JPG", r"C:\x\data.json", r"C:\x\page.html"] {
            assert!(!runs(p), "{p}");
        }
    }

    #[test]
    fn names_that_reach_other_computers_or_climb_out_are_never_looked_at() {
        for n in [r"\\server\share\a.png", "//server/a.png", r"..\secret.txt", r"a\..\..\b.txt", "a.txt:x", "C:a.txt", r"\Windows\a.txt", "a|b.txt", ""] {
            assert!(!usable_name(n), "{n}");
        }
        for n in [r"C:\Users\me\a.png", "C:/Users/me/a.png", "pasted-2026-11-24-152045-line.png", r"figure\dipolo.png", "Dispense"] {
            assert!(usable_name(n), "{n}");
        }
    }

    #[test]
    fn a_file_beside_a_known_one_is_found_and_one_elsewhere_is_not() {
        let root = std::env::temp_dir().join(format!("lumo-find-{}", std::process::id()));
        let notes = root.join("Dispense");
        let figures = notes.join("figure");
        let elsewhere = root.join("Altro");
        for d in [&figures, &elsewhere] {
            std::fs::create_dir_all(d).unwrap();
        }
        let tex = notes.join("Fisica2.tex");
        for f in [&tex, &notes.join("Fisica2.pdf"), &figures.join("dipolo.png"), &elsewhere.join("segreto.txt")] {
            std::fs::write(f, b"x").unwrap();
        }
        let tex_path = tex.to_string_lossy().to_string();
        remember(&tex_path);
        let known = vec![tex_path.clone()];
        let found = chat_file_find(
            vec![
                "Fisica2.tex".into(),
                "Fisica2.pdf".into(),
                r"figure\dipolo.png".into(),
                figures.to_string_lossy().to_string(),
                elsewhere.join("segreto.txt").to_string_lossy().to_string(),
                "segreto.txt".into(),
                "manca.png".into(),
            ],
            known,
        );
        assert_eq!(found[0], Some(FoundFile { path: tex_path.replace('/', "\\"), folder: false }));
        assert!(found[1].as_ref().is_some_and(|f| f.path.ends_with("Fisica2.pdf")), "beside a known file");
        assert!(found[2].as_ref().is_some_and(|f| f.path.ends_with("dipolo.png")), "one folder down");
        assert!(found[3].as_ref().is_some_and(|f| f.folder), "the folder itself");
        assert_eq!(found[4], None, "a folder the chat never used, beside the one above");
        assert_eq!(found[5], None);
        assert_eq!(found[6], None, "not there");
        // Written with forward slashes, it comes back with Windows' own.
        let slashed = chat_file_find(vec![notes.join("Fisica2.pdf").to_string_lossy().replace('\\', "/")], vec![tex.to_string_lossy().to_string()]);
        assert!(slashed[0].as_ref().is_some_and(|f| !f.path.contains('/') && f.path.ends_with(r"Dispense\Fisica2.pdf")), "{slashed:?}");
        // What was found may be opened from now on.
        assert!(allowed(&found[1].as_ref().unwrap().path));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_nobody_reported_is_refused() {
        assert_eq!(chat_file_open(r"C:\Windows\System32\secret-of-nobody.txt".into()), "refused");
        assert_eq!(chat_file_reveal(r"C:\Windows\System32\secret-of-nobody.txt".into()), "refused");
        assert_eq!(chat_file_preview(r"C:\Windows\System32\secret-of-nobody.png".into()), None);
        assert_eq!(chat_files_present(vec![r"C:\Windows\System32\secret-of-nobody.txt".into()]), vec![false]);
        assert_eq!(chat_file_open_with(r"C:\Windows\System32\secret-of-nobody.txt".into()), "refused");
        assert_eq!(chat_file_copy(r"C:\Windows\System32\secret-of-nobody.txt".into()), "refused");
    }
}
