// Dropped files are copied into %LOCALAPPDATA%\com.rccrd12.lumo\inbox so the original is
// never touched and the copy survives the drag source going away.
// The inbox only holds what waits in the field: the question that takes a
// file moves it into its chat's own folder, inbox\chats\<chat> (`adopt`),
// the one the chat's CLI reads (`cli_inbox`), and the folder goes with its
// chat (`forget_chat`). The × of a file waiting deletes it (`release`), and
// what no field holds when Lumo starts goes (`tidy`).

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::settings;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFile {
    pub name: String,
    pub path: String,
    pub size: u64,
}

pub fn inbox_dir() -> PathBuf {
    settings::local_dir().join("inbox")
}

/// A picture in the inbox, at most this big, can be previewed in the chat.
const MAX_PREVIEW_BYTES: u64 = 8 * 1024 * 1024;

/// The MIME type of a picture the webview shows, by its extension.
pub fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        _ => return None,
    })
}

/// A picture the user attached (dropped, pasted or picked), as a data URL for
/// the chat's preview. Only a file directly in the inbox or in a chat's
/// folder of it, and only a picture: the page can't use this to read anything else.
pub fn preview(path: &str) -> Option<String> {
    let path = Path::new(path);
    if !is_chat_copy(path) {
        return None;
    }
    picture_data(&path.canonicalize().ok()?)
}

/// Directly in the inbox: a file the user attached (dropped, pasted or
/// picked) that waits for its question.
pub fn in_inbox(path: &Path) -> bool {
    let (Ok(inbox), Ok(real)) = (inbox_dir().canonicalize(), path.canonicalize()) else { return false };
    real.parent() == Some(inbox.as_path())
}

/// Directly in the inbox, or directly in a chat's folder of it: a file the
/// user attached, waiting or sent, or one a chat's AI wrote beside it.
pub fn is_chat_copy(path: &Path) -> bool {
    let (Ok(inbox), Ok(real)) = (inbox_dir().canonicalize(), path.canonicalize()) else { return false };
    let Some(parent) = real.parent() else { return false };
    parent == inbox || parent.parent() == Some(inbox.join("chats").as_path())
}

/// A picture at most MAX_PREVIEW_BYTES big, as a data URL; None for any other file.
pub fn picture_data(real: &Path) -> Option<String> {
    let mime = image_mime(real)?;
    let meta = std::fs::metadata(real).ok()?;
    if !meta.is_file() || meta.len() > MAX_PREVIEW_BYTES {
        return None;
    }
    let bytes = std::fs::read(real).ok()?;
    Some(format!("data:{mime};base64,{}", crate::claude::base64_for(&bytes)))
}

// ── Paths a real drop delivered ─────────────────────────────────────────────
//
// `ingest_file` is callable from the page, so on its own it would copy any file
// the user can read (a script injected into the page could pull in ~/.ssh).
// Only paths the OS just delivered through a real drop are accepted: WebView2's
// drop objects on Windows (webview_drop.rs), Tauri's drag-drop window event
// elsewhere (lib.rs). Each is good once, for a couple of minutes.

const DROP_VALID_FOR: Duration = Duration::from_secs(120);
const DROP_MAX_PENDING: usize = 64;

static DROPPED: std::sync::Mutex<Vec<(String, std::time::Instant)>> = std::sync::Mutex::new(Vec::new());

/// Records paths that came from a real drop.
pub fn allow_dropped<I: IntoIterator<Item = String>>(paths: I) {
    let mut list = DROPPED.lock().unwrap_or_else(|e| e.into_inner());
    let now = std::time::Instant::now();
    list.retain(|(_, at)| now.duration_since(*at) < DROP_VALID_FOR);
    for p in paths {
        list.push((p, now));
    }
    let excess = list.len().saturating_sub(DROP_MAX_PENDING);
    list.drain(..excess);
}

/// True (once) when `path` was delivered by a drop in the last couple of minutes.
fn take_dropped(path: &str) -> bool {
    let mut list = DROPPED.lock().unwrap_or_else(|e| e.into_inner());
    let now = std::time::Instant::now();
    list.retain(|(_, at)| now.duration_since(*at) < DROP_VALID_FOR);
    match list.iter().position(|(p, _)| p == path) {
        Some(i) => {
            list.remove(i);
            true
        }
        None => false,
    }
}

/// A drop's copy into the inbox. `progress` hears the bytes copied so far and
/// the file's size as they arrive: the island's upload bar follows them.
pub fn ingest(source: &str, progress: &mut dyn FnMut(u64, u64)) -> Result<DroppedFile, String> {
    if !take_dropped(source) {
        return Err(crate::i18n::t("Only files dropped on the island can be added."));
    }
    copy_in_with(Path::new(source), progress)
}

/// Copies `src` into the inbox, as a drop does. Callers check first that the
/// user chose it: a real drop or the picker (`ingest`), or a file of a folder
/// they shared that their question names (explorer.rs).
pub fn copy_in(src: &Path) -> Result<DroppedFile, String> {
    copy_in_with(src, &mut |_, _| {})
}

/// The bytes a copy reads and writes at a time.
const COPY_CHUNK: usize = 1 << 20;
/// How often a copy says how far it is, at most: often enough for a smooth bar.
const PROGRESS_EVERY: Duration = Duration::from_millis(40);

/// `copy_in`, saying how far it is: `progress(done, total)` once at the start,
/// every `PROGRESS_EVERY` or so, and once with every byte there.
pub fn copy_in_with(src: &Path, progress: &mut dyn FnMut(u64, u64)) -> Result<DroppedFile, String> {
    let source = src.to_string_lossy();
    let source = source.as_ref();
    let meta = std::fs::metadata(src)
        .map_err(|e| crate::i18n::tf("Cannot read {path}: {error}", &[("path", source), ("error", &e.to_string())]))?;
    if meta.is_dir() {
        return Err(crate::i18n::t("Folders can't be dropped yet."));
    }

    let dir = ready_inbox()?;

    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());

    let dest = unique_in(&dir, &name);

    // Written by hand rather than with `std::fs::copy`, which carries the
    // source's timestamps across (CopyFileEx): a new file is born with the
    // time *we* copied it.
    let cannot_copy = |e: std::io::Error| crate::i18n::tf("Cannot copy: {error}", &[("error", &e.to_string())]);
    let mut from = std::fs::File::open(src).map_err(cannot_copy)?;
    let mut to = std::fs::File::options().write(true).create_new(true).open(&dest).map_err(cannot_copy)?;
    if let Err(e) = copy_reporting(&mut from, &mut to, meta.len(), progress) {
        drop(to);
        let _ = std::fs::remove_file(&dest);
        return Err(cannot_copy(e));
    }
    drop(to);

    Ok(DroppedFile {
        name,
        path: dest.to_string_lossy().to_string(),
        size: meta.len(),
    })
}

/// `std::io::copy` in chunks, telling `progress` the bytes written and `size`
/// (the file's length when the copy started; a file still growing reports
/// its bytes, never more than it, until the last call has them all).
fn copy_reporting(
    from: &mut impl std::io::Read,
    to: &mut impl std::io::Write,
    size: u64,
    progress: &mut dyn FnMut(u64, u64),
) -> std::io::Result<u64> {
    let mut buf = vec![0u8; COPY_CHUNK];
    let mut done = 0u64;
    let mut said = std::time::Instant::now();
    progress(0, size);
    loop {
        let n = match from.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        to.write_all(&buf[..n])?;
        done += n as u64;
        if said.elapsed() >= PROGRESS_EVERY {
            said = std::time::Instant::now();
            progress(done.min(size), size);
        }
    }
    to.flush()?;
    let total = size.max(done);
    progress(total, total);
    Ok(done)
}

/// The inbox, created if needed, inside Lumo's private folder.
fn ready_inbox() -> Result<PathBuf, String> {
    let dir = inbox_dir();
    crate::platform::ensure_private_dir(&settings::local_dir()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// `dir/name`, or `dir/stem (2).ext`… when that name is taken: nothing in the
/// inbox is ever overwritten.
fn unique_in(dir: &Path, name: &str) -> PathBuf {
    let dest = dir.join(name);
    if !dest.exists() {
        return dest;
    }
    let as_path = Path::new(name);
    let stem = as_path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = as_path.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
    (2..1000)
        .map(|i| dir.join(format!("{stem} ({i}){ext}")))
        .find(|candidate| !candidate.exists())
        // A thousand copies under one name: the time tells this one apart.
        .unwrap_or_else(|| {
            let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            dir.join(format!("{stem} ({nanos}){ext}"))
        })
}

/// Where Lumo writes a file of its own for the chat (a screenshot): a fresh
/// path in the inbox under `name`, next to the dropped files Claude Code may read.
pub fn new_inbox_file(name: &str) -> Result<PathBuf, String> {
    let dir = ready_inbox()?;
    Ok(unique_in(&dir, name))
}

// ── Pasted in the chat ────────────────────────────────────────────────────────
//
// Ctrl+V in the chat's text field with an image on the clipboard (a Win+Shift+S
// screenshot) or a file the page can read: the page hands over its bytes and
// they land in the inbox like a dropped file. Nothing is read from disk here,
// so the page can only give what it already has.

/// What a paste can hand over in one go: what the Anthropic API takes in one request.
pub const MAX_PASTE: usize = 32 * 1024 * 1024;

/// A name the page gave, made safe for the inbox: its last part only, no
/// character Windows refuses in a name, no device name, not too long.
pub fn safe_file_name(name: &str) -> String {
    let last = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last
        .chars()
        .map(|c| if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') { '_' } else { c })
        .collect();
    // Windows drops trailing dots and spaces; a name of only those is no name.
    let mut cleaned = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if cleaned.chars().count() > 120 {
        let ext = Path::new(&cleaned).extension().map(|e| e.to_string_lossy().to_string()).filter(|e| e.len() <= 10);
        let stem: String = cleaned.chars().take(100).collect();
        cleaned = match ext {
            Some(ext) => format!("{}.{ext}", stem.trim_end_matches(['.', ' '])),
            None => stem,
        };
    }
    let stem = cleaned.split('.').next().unwrap_or("").to_ascii_uppercase();
    let device = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem.as_bytes()[3].is_ascii_digit());
    if cleaned.is_empty() || cleaned.chars().all(|c| c == '.') {
        "pasted".to_string()
    } else if device {
        format!("_{cleaned}")
    } else {
        cleaned
    }
}

/// Bytes pasted in the chat, written into the inbox under `name` (made safe).
pub fn write_in(name: &str, bytes: &[u8]) -> Result<DroppedFile, String> {
    if bytes.len() > MAX_PASTE {
        return Err(crate::i18n::t("This file is too big to paste. Attach it with the paperclip instead."));
    }
    let name = safe_file_name(name);
    let cannot_copy = |e: std::io::Error| crate::i18n::tf("Cannot copy: {error}", &[("error", &e.to_string())]);
    // The name is taken as the file is made (create_new): two pastes of
    // "image.png" at once each get a file of their own, neither written over.
    let mut attempts = 0;
    let (dest, mut file) = loop {
        let dest = new_inbox_file(&name)?;
        match std::fs::File::options().write(true).create_new(true).open(&dest) {
            Ok(file) => break (dest, file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && attempts < 10 => attempts += 1,
            Err(e) => return Err(cannot_copy(e)),
        }
    };
    if let Err(e) = std::io::Write::write_all(&mut file, bytes) {
        drop(file);
        let _ = std::fs::remove_file(&dest);
        return Err(cannot_copy(e));
    }
    drop(file);
    // Its own name, as a dropped file's: the inbox's may be "image (2).png",
    // and the chat's folder it moves to gives it this one back (`adopt`).
    Ok(DroppedFile {
        name,
        path: dest.to_string_lossy().to_string(),
        size: bytes.len() as u64,
    })
}

// ── Each chat's own folder ────────────────────────────────────────────────────
//
// A file lands in the inbox before any chat has it (dropped, pasted, a
// screenshot) and waits there while it is in the field. The question that
// takes it moves it into inbox\chats\<chat> (`adopt`), under the name it had
// on the computer, and from then on it is the chat's: the island, the AI and
// the CLIs the chat runs (Claude Code, Antigravity CLI) find it there, and
// the AI writes its own files beside it. Nothing sweeps that folder: it goes
// with its chat (`forget_chat`), and a file of it with the × of the chat's
// files or an edit that leaves it out (`forget_files`). The CLIs read
// without asking only their chat's folder, never another chat's; Settings →
// Security → "Other chats' files" on gives them the whole inbox instead.

/// Where the chats' folders are.
fn chats_dir() -> PathBuf {
    inbox_dir().join("chats")
}

/// The folder of `chat`'s files, by the island's id for it.
pub fn chat_dir(chat: &str) -> PathBuf {
    chats_dir().join(crate::workspace::safe_id(chat))
}

/// A file a question takes: the chat it goes to, where it waits, and the
/// name it had on the computer (the inbox's may be "notes (2).txt").
#[derive(serde::Deserialize, Debug, Clone)]
pub struct Adopt {
    pub chat: String,
    pub path: String,
    #[serde(default)]
    pub name: Option<String>,
}

/// Each file waiting in the inbox moves into its chat's folder; the new
/// path of each, in order (the same path for one that is not in the inbox,
/// or could not be moved). One that two chats name (sent by a Lumo before
/// this) is copied for all but the last of them.
pub fn adopt(items: &[Adopt]) -> Vec<String> {
    let ready = ready_inbox().is_ok();
    items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let later = items[i + 1..].iter().any(|o| o.chat != item.chat && path_key(&o.path) == path_key(&item.path));
            if ready {
                adopt_one(item, later)
            } else {
                item.path.clone()
            }
        })
        .collect()
}

fn adopt_one(item: &Adopt, copy: bool) -> String {
    let source = Path::new(&item.path);
    if item.chat.trim().is_empty() || !in_inbox(source) || !source.is_file() {
        return item.path.clone();
    }
    let dir = chat_dir(&item.chat);
    let Some(inbox_name) = source.file_name() else { return item.path.clone() };
    if std::fs::create_dir_all(&dir).is_err() {
        return item.path.clone();
    }
    // Given to its CLI by a Lumo before this one: the chat's folder already
    // has a link of this very file under the inbox's name, the path the CLI
    // knows. That one is the chat's, and the inbox's goes.
    let linked = dir.join(inbox_name);
    if same_file(source, &linked) {
        if !copy {
            let _ = std::fs::remove_file(source);
        }
        return linked.to_string_lossy().to_string();
    }
    // A new file: the name it had on the computer. One moved by a Lumo
    // before this keeps the inbox's, the name its chat's AI may know.
    let name = item.name.as_deref().map(safe_file_name).unwrap_or_else(|| inbox_name.to_string_lossy().to_string());
    let dest = unique_in(&dir, &name);
    if !copy && std::fs::rename(source, &dest).is_ok() {
        return dest.to_string_lossy().to_string();
    }
    // Open in another app (it can't move then), or another chat names it
    // too: a copy goes, and the inbox's waits for `tidy`.
    if std::fs::copy(source, &dest).is_ok() {
        return dest.to_string_lossy().to_string();
    }
    item.path.clone()
}

/// `a` and `b` hold the same file: a link of it, or a copy (same size, same
/// time written, which a copy keeps).
fn same_file(a: &Path, b: &Path) -> bool {
    let (Ok(a), Ok(b)) = (std::fs::metadata(a), std::fs::metadata(b)) else { return false };
    a.is_file() && b.is_file() && a.len() == b.len() && a.modified().ok().is_some() && a.modified().ok() == b.modified().ok()
}

/// The inbox folder the CLI of `chat` may read without asking: its own, or
/// the whole inbox with "Other chats' files" on (`others`). Created if needed.
pub fn cli_inbox(chat: &str, others: bool) -> String {
    let dir = if others { inbox_dir() } else { chat_dir(chat) };
    if ready_inbox().is_ok() {
        let _ = std::fs::create_dir_all(&dir);
    }
    dir.to_string_lossy().to_string()
}

/// The chat is deleted: its folder goes with it, the files it was sent and
/// the ones its AI wrote there.
pub fn forget_chat(chat: &str) {
    let dir = chat_dir(chat);
    // Never the inbox itself, whatever the id.
    if dir.parent() == Some(chats_dir().as_path()) {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Files taken out of `chat` (the × of its files, an edit that leaves them
/// out): each of `paths` directly in the chat's folder is deleted, never a
/// file anywhere else (one the AI read where it is). Returns how many went.
pub fn forget_files(chat: &str, paths: &[String]) -> usize {
    let Ok(dir) = chat_dir(chat).canonicalize() else { return 0 };
    paths
        .iter()
        .filter(|p| {
            let Ok(real) = Path::new(p.as_str()).canonicalize() else { return false };
            let file = std::fs::symlink_metadata(&real).is_ok_and(|m| m.is_file());
            file && real.parent() == Some(dir.as_path()) && std::fs::remove_file(&real).is_ok()
        })
        .count()
}

// ── Files waiting no field holds ──────────────────────────────────────────────
//
// The page names the files by path, so it could name any file: only a file
// directly in the inbox is ever deleted here (`in_inbox`), never a folder, and
// never one of the user's own files an answer read where it is.

/// The same file whatever its case or slashes (Windows paths).
fn path_key(path: &str) -> String {
    path.trim().replace('/', "\\").to_lowercase()
}

/// The × of files waiting in the field: each of `paths` that is in the inbox
/// and not in `keep` (another field still has it, or a chat a Lumo before
/// this one sent it to) is deleted. Returns how many went.
pub fn release(paths: &[String], keep: &[String]) -> usize {
    let kept: std::collections::HashSet<String> = keep.iter().map(|p| path_key(p)).collect();
    let mut gone = 0;
    for path in paths {
        if kept.contains(&path_key(path)) {
            continue;
        }
        let path = Path::new(path);
        if in_inbox(path) && path.is_file() && std::fs::remove_file(path).is_ok() {
            gone += 1;
        }
    }
    gone
}

/// When Lumo starts: every file of the inbox no field and no chat names in
/// `keep` is deleted (a file left in the field when Lumo closed, a
/// screenshot never sent). Returns how many went.
pub fn tidy(keep: &[String]) -> usize {
    tidy_in(&inbox_dir(), keep)
}

fn tidy_in(dir: &Path, keep: &[String]) -> usize {
    let kept: std::collections::HashSet<String> = keep.iter().map(|p| path_key(p)).collect();
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    let mut gone = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
        if !meta.is_file() || kept.contains(&path_key(&path.to_string_lossy())) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            gone += 1;
        }
    }
    gone
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_released_copy_goes_unless_another_chat_keeps_it() {
        let a = write_in("release-test-a.txt", b"a").unwrap();
        let b = write_in("release-test-b.txt", b"b").unwrap();
        let outside = std::env::temp_dir().join(format!("lumo-release-{}.txt", std::process::id()));
        std::fs::write(&outside, b"mine").unwrap();
        let paths = vec![a.path.clone(), b.path.to_uppercase(), outside.to_string_lossy().to_string(), inbox_dir().to_string_lossy().to_string()];
        // b is kept, named with other case and slashes.
        let gone = release(&paths, &[b.path.replace('\\', "/")]);
        assert_eq!(gone, 1);
        assert!(!Path::new(&a.path).exists(), "released");
        assert!(Path::new(&b.path).exists(), "another chat keeps it");
        assert!(outside.exists(), "a file outside the inbox is never deleted");
        assert!(inbox_dir().is_dir(), "nor the inbox itself");
        let _ = std::fs::remove_file(&b.path);
        let _ = std::fs::remove_file(&outside);
    }

    fn adopt(chat: &str, path: &str, name: Option<&str>) -> String {
        super::adopt(&[Adopt { chat: chat.into(), path: path.into(), name: name.map(String::from) }]).remove(0)
    }

    #[test]
    fn a_sent_file_moves_into_its_chat_under_the_name_it_had() {
        let chat = "test-adopt-moves";
        forget_chat(chat);
        let first = write_in("adopt-test.txt", b"first").unwrap();
        let second = write_in("adopt-test.txt", b"second").unwrap();
        assert_ne!(first.path, second.path, "two of a name wait side by side in the inbox");
        // The second goes: in the chat's folder, under its own name, and out of the inbox.
        let moved = adopt(chat, &second.path, Some("adopt-test.txt"));
        assert_eq!(Path::new(&moved), chat_dir(chat).join("adopt-test.txt"));
        assert_eq!(std::fs::read(&moved).unwrap(), b"second");
        assert!(!Path::new(&second.path).exists(), "it left the inbox");
        assert!(is_chat_copy(Path::new(&moved)) && !in_inbox(Path::new(&moved)));
        // Sent again (an edit): where it is.
        assert_eq!(adopt(chat, &moved, Some("adopt-test.txt")), moved);
        // A file the AI wrote there of that name is never written over.
        std::fs::write(chat_dir(chat).join("made.txt"), b"the AI's").unwrap();
        let other = write_in("made.txt", b"the user's").unwrap();
        let beside = adopt(chat, &other.path, Some("made.txt"));
        assert_eq!(Path::new(&beside), chat_dir(chat).join("made (2).txt"));
        assert_eq!(std::fs::read(chat_dir(chat).join("made.txt")).unwrap(), b"the AI's");
        // A file outside the inbox (read where it is), or no chat: as it is.
        let outside = std::env::temp_dir().join(format!("lumo-adopt-outside-{}.txt", std::process::id()));
        std::fs::write(&outside, b"mine").unwrap();
        assert_eq!(adopt(chat, &outside.to_string_lossy(), None), outside.to_string_lossy());
        assert!(outside.exists());
        assert_eq!(adopt("", &first.path, None), first.path);
        assert!(Path::new(&first.path).exists());
        // The CLI's folder: the chat's own, or the whole inbox.
        assert_eq!(cli_inbox(chat, false), chat_dir(chat).to_string_lossy());
        assert_eq!(cli_inbox(chat, true), inbox_dir().to_string_lossy());
        // The chat deleted: its folder goes, the files the AI wrote too.
        forget_chat(chat);
        assert!(!chat_dir(chat).exists());
        let _ = std::fs::remove_file(&first.path);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn a_link_an_older_lumo_gave_its_cli_stays_where_the_cli_knows_it() {
        let chat = "test-adopt-linked";
        forget_chat(chat);
        let sent = write_in("linked-test (2).tex", b"tex").unwrap();
        std::fs::create_dir_all(chat_dir(chat)).unwrap();
        let link = chat_dir(chat).join(Path::new(&sent.path).file_name().unwrap());
        std::fs::hard_link(&sent.path, &link).unwrap();
        let moved = adopt(chat, &sent.path, None);
        assert_eq!(Path::new(&moved), link.as_path());
        assert_eq!(std::fs::read(&link).unwrap(), b"tex");
        assert!(!Path::new(&sent.path).exists(), "the inbox's goes");
        forget_chat(chat);
    }

    #[test]
    fn a_file_two_old_chats_name_is_copied_for_one_and_moved_for_the_last() {
        let (a, b) = ("test-adopt-shared-a", "test-adopt-shared-b");
        forget_chat(a);
        forget_chat(b);
        let both = write_in("shared-test.txt", b"both").unwrap();
        let alone = write_in("alone-test.txt", b"alone").unwrap();
        let got = super::adopt(&[
            Adopt { chat: a.into(), path: both.path.clone(), name: None },
            Adopt { chat: a.into(), path: alone.path.clone(), name: None },
            Adopt { chat: b.into(), path: both.path.clone(), name: None },
        ]);
        // Moved by a Lumo before this one: under the inbox's name, the one its AI may know.
        let named = |f: &DroppedFile| Path::new(&f.path).file_name().unwrap().to_owned();
        assert_eq!(Path::new(&got[0]), chat_dir(a).join(named(&both)));
        assert_eq!(Path::new(&got[1]), chat_dir(a).join(named(&alone)));
        assert_eq!(Path::new(&got[2]), chat_dir(b).join(named(&both)));
        for p in [&got[0], &got[2]] {
            assert_eq!(std::fs::read(p).unwrap(), b"both");
        }
        assert!(!Path::new(&both.path).exists() && !Path::new(&alone.path).exists(), "both left the inbox");
        forget_chat(a);
        forget_chat(b);
    }

    #[test]
    fn only_files_in_the_chats_own_folder_are_forgotten() {
        let (a, b) = ("test-forget-a", "test-forget-b");
        forget_chat(a);
        forget_chat(b);
        for chat in [a, b] {
            std::fs::create_dir_all(chat_dir(chat).join("deeper")).unwrap();
            std::fs::write(chat_dir(chat).join("x.txt"), b"x").unwrap();
        }
        std::fs::write(chat_dir(a).join("deeper").join("y.txt"), b"y").unwrap();
        let waiting = write_in("forget-test.txt", b"w").unwrap();
        let outside = std::env::temp_dir().join(format!("lumo-forget-outside-{}.txt", std::process::id()));
        std::fs::write(&outside, b"mine").unwrap();
        let named = |p: PathBuf| p.to_string_lossy().to_string();
        let paths = vec![
            named(chat_dir(a).join("x.txt")),
            named(chat_dir(a).join("deeper").join("y.txt")),
            named(chat_dir(a).join("deeper")),
            named(chat_dir(a)),
            named(chat_dir(b).join("x.txt")),
            named(chat_dir(a).join("..").join(crate::workspace::safe_id(b)).join("x.txt")),
            waiting.path.clone(),
            named(outside.clone()),
        ];
        assert_eq!(forget_files(a, &paths), 1);
        assert!(!chat_dir(a).join("x.txt").exists());
        assert!(chat_dir(a).join("deeper").join("y.txt").exists(), "only directly in the folder");
        assert!(chat_dir(b).join("x.txt").exists(), "never another chat's");
        assert!(Path::new(&waiting.path).exists() && outside.exists());
        forget_chat(a);
        forget_chat(b);
        let _ = std::fs::remove_file(&waiting.path);
        let _ = std::fs::remove_file(&outside);
    }

    #[test]
    fn tidy_drops_every_waiting_file_nobody_names() {
        let dir = std::env::temp_dir().join(format!("lumo-tidy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("chats").join("a")).unwrap();
        for name in ["named.txt", "left.txt"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        std::fs::write(dir.join("chats").join("a").join("sent.txt"), b"x").unwrap();
        let keep = vec![dir.join("NAMED.txt").to_string_lossy().to_string()];
        assert_eq!(tidy_in(&dir, &keep), 1);
        assert!(!dir.join("left.txt").exists());
        assert!(dir.join("named.txt").exists());
        assert!(dir.join("chats").join("a").join("sent.txt").exists(), "a chat's folder is never tidied");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_a_picture_in_the_inbox_is_previewed() {
        let png = write_in("preview-test.png", &[0x89, b'P', b'N', b'G']).unwrap();
        let url = preview(&png.path).expect("a picture in the inbox");
        assert!(url.starts_with("data:image/png;base64,"), "{url}");
        let txt = write_in("preview-test.txt", b"secret").unwrap();
        assert!(preview(&txt.path).is_none(), "not a picture");
        let outside = std::env::temp_dir().join(format!("lumo-preview-{}.png", std::process::id()));
        std::fs::write(&outside, b"x").unwrap();
        assert!(preview(&outside.to_string_lossy()).is_none(), "not in the inbox");
        assert!(preview("C:\\nowhere\\x.png").is_none());
        // Sent: in its chat's folder, it is still previewed; deeper, never.
        let chat = "test-preview-chat";
        forget_chat(chat);
        let sent = super::adopt(&[Adopt { chat: chat.into(), path: png.path.clone(), name: None }]).remove(0);
        assert!(preview(&sent).is_some(), "{sent}");
        std::fs::create_dir_all(chat_dir(chat).join("deeper")).unwrap();
        let deeper = chat_dir(chat).join("deeper").join("x.png");
        std::fs::write(&deeper, [0x89, b'P', b'N', b'G']).unwrap();
        assert!(preview(&deeper.to_string_lossy()).is_none());
        forget_chat(chat);
        for p in [&png.path, &txt.path] {
            let _ = std::fs::remove_file(p);
        }
        let _ = std::fs::remove_file(&outside);
        assert_eq!(image_mime(Path::new("a/Photo.JPG")), Some("image/jpeg"));
        assert_eq!(image_mime(Path::new("a/doc.pdf")), None);
    }

    #[test]
    fn a_copy_says_how_far_it_is() {
        let data = vec![7u8; 3 * COPY_CHUNK + 5];
        let size = data.len() as u64;
        let mut heard = Vec::new();
        let mut out = Vec::new();
        let copied = copy_reporting(&mut std::io::Cursor::new(&data), &mut out, size, &mut |d, t| heard.push((d, t))).unwrap();
        assert_eq!(copied, size);
        assert_eq!(out, data);
        assert_eq!(heard.first(), Some(&(0, size)));
        assert_eq!(heard.last(), Some(&(size, size)));
        assert!(heard.windows(2).all(|w| w[0].0 <= w[1].0 && w[0].1 == w[1].1));

        // A file that grew since its size was read: never past 100 % before the end.
        let mut heard = Vec::new();
        copy_reporting(&mut std::io::Cursor::new(&data), &mut Vec::new(), 10, &mut |d, t| heard.push((d, t))).unwrap();
        assert!(heard[..heard.len() - 1].iter().all(|&(d, t)| d <= t));
        assert_eq!(heard.last(), Some(&(size, size)));

        // An empty file: there at once.
        let mut heard = Vec::new();
        copy_reporting(&mut std::io::Cursor::new(Vec::<u8>::new()), &mut Vec::new(), 0, &mut |d, t| heard.push((d, t))).unwrap();
        assert_eq!(heard, vec![(0, 0), (0, 0)]);
    }

    #[test]
    fn ingest_copies_and_never_overwrites() {
        let tmp = std::env::temp_dir().join(format!("lumo-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let source = tmp.join("note.txt");
        std::fs::write(&source, b"hello").unwrap();

        let drop = |p: &Path| allow_dropped([p.to_string_lossy().to_string()]);
        drop(&source);
        let first = ingest(source.to_str().unwrap(), &mut |_, _| {}).unwrap();
        assert_eq!(first.name, "note.txt");
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");

        // A second drop of the same name must not clobber the first copy.
        std::fs::write(&source, b"second").unwrap();
        drop(&source);
        let second = ingest(source.to_str().unwrap(), &mut |_, _| {}).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");
        assert_eq!(std::fs::read(&second.path).unwrap(), b"second");

        // Folders are refused rather than silently ignored.
        drop(&tmp);
        assert!(ingest(tmp.to_str().unwrap(), &mut |_, _| {}).is_err());

        // An ancient source arrives as a new file, born when it was copied.
        let old_source = tmp.join("ancient.txt");
        std::fs::write(&old_source, b"old").unwrap();
        let long_ago = SystemTime::now() - Duration::from_secs(8 * 24 * 60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&old_source)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        drop(&old_source);
        let aged = ingest(old_source.to_str().unwrap(), &mut |_, _| {}).unwrap();
        let born = std::fs::metadata(&aged.path).unwrap().modified().unwrap();
        assert!(born > long_ago, "the copy keeps the source's old time");
        let _ = std::fs::remove_file(&aged.path);

        let _ = std::fs::remove_file(&first.path);
        let _ = std::fs::remove_file(&second.path);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}

#[cfg(test)]
mod paste_tests {
    use super::*;

    #[test]
    fn a_pasted_name_is_only_a_name() {
        assert_eq!(safe_file_name("image.png"), "image.png");
        assert_eq!(safe_file_name("..\\..\\Windows\\evil.dll"), "evil.dll");
        assert_eq!(safe_file_name("../../.ssh/id_rsa"), "id_rsa");
        assert_eq!(safe_file_name("a:b*c?.txt"), "a_b_c_.txt");
        assert_eq!(safe_file_name("notes. . "), "notes");
        assert_eq!(safe_file_name(""), "pasted");
        assert_eq!(safe_file_name(".."), "pasted");
        assert_eq!(safe_file_name("dir/"), "pasted");
        assert_eq!(safe_file_name("CON"), "_CON");
        assert_eq!(safe_file_name("nul.txt"), "_nul.txt");
        assert_eq!(safe_file_name("com1.png"), "_com1.png");
        assert_eq!(safe_file_name("COMET.png"), "COMET.png");
        assert_eq!(safe_file_name("line\nbreak.txt"), "line_break.txt");
        let long = format!("{}.pdf", "x".repeat(300));
        let short = safe_file_name(&long);
        assert_eq!(short, format!("{}.pdf", "x".repeat(100)));
    }

    #[test]
    fn pasted_bytes_land_in_the_inbox_and_too_many_are_refused() {
        let got = write_in("../shot.png", b"\x89PNG").unwrap();
        assert_eq!(got.name, "shot.png", "its own name, whatever the inbox's");
        assert!(Path::new(&got.path).starts_with(inbox_dir()));
        assert_eq!(std::fs::read(&got.path).unwrap(), b"\x89PNG");
        assert_eq!(got.size, 4);
        let again = write_in("shot.png", b"2").unwrap();
        assert_ne!(again.path, got.path, "never overwritten");
        let _ = std::fs::remove_file(&got.path);
        let _ = std::fs::remove_file(&again.path);
        assert!(write_in("big.bin", &vec![0u8; MAX_PASTE + 1]).is_err());
    }

    #[test]
    fn pastes_of_the_same_name_at_once_never_write_over_each_other() {
        let name = format!("paste-race-{}.png", std::process::id());
        let pasted: Vec<DroppedFile> = std::thread::scope(|s| {
            let all: Vec<_> = (0..8u8).map(|n| {
                let name = &name;
                s.spawn(move || write_in(name, &[n; 64]).unwrap())
            }).collect();
            all.into_iter().map(|t| t.join().unwrap()).collect()
        });
        let paths: std::collections::HashSet<&str> = pasted.iter().map(|p| p.path.as_str()).collect();
        assert_eq!(paths.len(), 8, "each paste has a file of its own");
        let mut held: Vec<u8> = pasted.iter().map(|p| std::fs::read(&p.path).unwrap()[0]).collect();
        held.sort();
        assert_eq!(held, (0..8u8).collect::<Vec<_>>(), "and each holds its own bytes");
        for p in &pasted {
            let _ = std::fs::remove_file(&p.path);
        }
    }
}

#[cfg(test)]
mod drop_tests {
    use super::*;

    // One test: the list is process-wide and tests run in parallel.
    #[test]
    fn only_a_dropped_path_is_ingested_once_and_the_list_stays_bounded() {
        let p = "/tmp/lumo-test-not-dropped.txt".to_string();
        assert!(ingest(&p, &mut |_, _| {}).is_err(), "never dropped");
        allow_dropped([p.clone()]);
        assert!(take_dropped(&p));
        assert!(!take_dropped(&p), "good once");

        allow_dropped((0..200).map(|i| format!("/tmp/bounded-{i}")));
        assert!(DROPPED.lock().unwrap().len() <= DROP_MAX_PENDING);
        assert!(take_dropped("/tmp/bounded-199"));
        assert!(!take_dropped("/tmp/bounded-0"));
    }
}
