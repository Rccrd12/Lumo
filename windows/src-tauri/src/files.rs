// Dropped files are copied into %LOCALAPPDATA%\com.rccrd12.lumo\inbox so the original is
// never touched and the copy survives the drag source going away.
// The inbox is swept of anything older than a week.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use crate::settings;

const KEEP_FOR: Duration = Duration::from_secs(7 * 24 * 60 * 60);

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
/// the chat's preview. Only a file directly in the inbox, and only a picture:
/// the page can't use this to read anything else.
pub fn preview(path: &str) -> Option<String> {
    let path = Path::new(path);
    let inbox = inbox_dir().canonicalize().ok()?;
    let real = path.canonicalize().ok()?;
    if real.parent() != Some(inbox.as_path()) {
        return None;
    }
    picture_data(&real)
}

/// Directly in the inbox: a file the user attached (dropped, pasted or picked).
pub fn in_inbox(path: &Path) -> bool {
    let (Ok(inbox), Ok(real)) = (inbox_dir().canonicalize(), path.canonicalize()) else { return false };
    real.parent() == Some(inbox.as_path())
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

pub fn ingest(source: &str) -> Result<DroppedFile, String> {
    if !take_dropped(source) {
        return Err(crate::i18n::t("Only files dropped on the island can be added."));
    }
    copy_in(Path::new(source))
}

/// Copies `src` into the inbox, as a drop does. Callers check first that the
/// user chose it: a real drop or the picker (`ingest`), or a file of a folder
/// they shared that their question names (explorer.rs).
pub fn copy_in(src: &Path) -> Result<DroppedFile, String> {
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

    // Written by hand rather than with `std::fs::copy`: CopyFileEx carries the
    // source's timestamps across, so a file last edited three years ago would
    // sit in the inbox looking older than the sweep window until restamped, and
    // a sweep running meanwhile (another drop, a screenshot) deleted it. A new
    // file is born with the time *we* copied it.
    let cannot_copy = |e: std::io::Error| crate::i18n::tf("Cannot copy: {error}", &[("error", &e.to_string())]);
    let mut from = std::fs::File::open(src).map_err(cannot_copy)?;
    let mut to = std::fs::File::options().write(true).create_new(true).open(&dest).map_err(cannot_copy)?;
    if let Err(e) = std::io::copy(&mut from, &mut to) {
        drop(to);
        let _ = std::fs::remove_file(&dest);
        return Err(cannot_copy(e));
    }
    drop(to);
    sweep(&dir);

    Ok(DroppedFile {
        name,
        path: dest.to_string_lossy().to_string(),
        size: meta.len(),
    })
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
    sweep(&dir);
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
    let dest = new_inbox_file(&name)?;
    std::fs::write(&dest, bytes).map_err(|e| crate::i18n::tf("Cannot copy: {error}", &[("error", &e.to_string())]))?;
    Ok(DroppedFile {
        name: dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(name),
        path: dest.to_string_lossy().to_string(),
        size: bytes.len() as u64,
    })
}

/// Drops anything copied here more than a week ago. `ingest` stamps every copy
/// with the time it landed, so this really is the age of the copy and not the
/// age of whatever the user happened to drag in.
fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let Ok(copied) = meta.modified() else { continue };
        if now.duration_since(copied).map(|age| age > KEEP_FOR).unwrap_or(false) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        for p in [&png.path, &txt.path] {
            let _ = std::fs::remove_file(p);
        }
        let _ = std::fs::remove_file(&outside);
        assert_eq!(image_mime(Path::new("a/Photo.JPG")), Some("image/jpeg"));
        assert_eq!(image_mime(Path::new("a/doc.pdf")), None);
    }

    #[test]
    fn ingest_copies_and_never_overwrites() {
        let tmp = std::env::temp_dir().join(format!("lumo-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let source = tmp.join("note.txt");
        std::fs::write(&source, b"hello").unwrap();

        let drop = |p: &Path| allow_dropped([p.to_string_lossy().to_string()]);
        drop(&source);
        let first = ingest(source.to_str().unwrap()).unwrap();
        assert_eq!(first.name, "note.txt");
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");

        // A second drop of the same name must not clobber the first copy.
        std::fs::write(&source, b"second").unwrap();
        drop(&source);
        let second = ingest(source.to_str().unwrap()).unwrap();
        assert_ne!(first.path, second.path);
        assert_eq!(std::fs::read(&first.path).unwrap(), b"hello");
        assert_eq!(std::fs::read(&second.path).unwrap(), b"second");

        // Folders are refused rather than silently ignored.
        drop(&tmp);
        assert!(ingest(tmp.to_str().unwrap()).is_err());

        // An ancient source must not arrive already older than the sweep window.
        let old_source = tmp.join("ancient.txt");
        std::fs::write(&old_source, b"old").unwrap();
        let long_ago = SystemTime::now() - KEEP_FOR - Duration::from_secs(60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&old_source)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        drop(&old_source);
        let aged = ingest(old_source.to_str().unwrap()).unwrap();
        assert!(
            Path::new(&aged.path).exists(),
            "a file copied just now was swept as if it were a week old"
        );
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
        assert!(got.name.starts_with("shot") && got.name.ends_with(".png"), "{}", got.name);
        assert!(Path::new(&got.path).starts_with(inbox_dir()));
        assert_eq!(std::fs::read(&got.path).unwrap(), b"\x89PNG");
        assert_eq!(got.size, 4);
        let again = write_in("shot.png", b"2").unwrap();
        assert_ne!(again.path, got.path, "never overwritten");
        let _ = std::fs::remove_file(&got.path);
        let _ = std::fs::remove_file(&again.path);
        assert!(write_in("big.bin", &vec![0u8; MAX_PASTE + 1]).is_err());
    }
}

#[cfg(test)]
mod drop_tests {
    use super::*;

    // One test: the list is process-wide and tests run in parallel.
    #[test]
    fn only_a_dropped_path_is_ingested_once_and_the_list_stays_bounded() {
        let p = "/tmp/lumo-test-not-dropped.txt".to_string();
        assert!(ingest(&p).is_err(), "never dropped");
        allow_dropped([p.clone()]);
        assert!(take_dropped(&p));
        assert!(!take_dropped(&p), "good once");

        allow_dropped((0..200).map(|i| format!("/tmp/bounded-{i}")));
        assert!(DROPPED.lock().unwrap().len() <= DROP_MAX_PENDING);
        assert!(take_dropped("/tmp/bounded-199"));
        assert!(!take_dropped("/tmp/bounded-0"));
    }
}
