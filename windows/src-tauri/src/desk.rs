// What is open on the user's computer, for the chat (Settings → Chat →
// "Tell the AI what's open"): the windows, front to back, and the documents
// they show, found on disk from their titles ("Report.pdf - Adobe Acrobat").
//
// Only the chat's own provider hears it, with the question it goes with;
// nothing is kept. Claude Code and Antigravity CLI get the documents' paths
// and may read their folders; the other providers get the document in front
// attached, when the question is about it.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::screen::WindowInfo;

/// A document a window shows, and where it is.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OpenDocument {
    pub name: String,
    pub path: String,
    pub app: String,
    /// In the window the user was in.
    pub active: bool,
}

/// The kinds of files worth finding: what people open and ask about.
const DOCUMENT_EXTS: &[&str] = &[
    "pdf", "docx", "doc", "odt", "rtf", "txt", "md", "xlsx", "xls", "xlsm", "ods", "csv", "pptx", "ppt", "odp",
    "epub", "png", "jpg", "jpeg", "gif", "webp", "svg", "html", "htm", "json", "xml", "py", "js", "ts", "rs",
];

/// Apps that hide the extension in their title, and what their files are.
const APP_EXTS: &[(&str, &[&str])] = &[
    ("winword", &["docx", "doc", "rtf", "odt"]),
    ("excel", &["xlsx", "xlsm", "xls", "csv", "ods"]),
    ("powerpnt", &["pptx", "ppt", "odp"]),
    ("acrord32", &["pdf"]),
    ("acrobat", &["pdf"]),
    ("sumatrapdf", &["pdf"]),
    ("foxitpdfreader", &["pdf"]),
    ("notepad", &["txt", "md"]),
];

/// At most this many documents go with a question.
const MAX_DOCUMENTS: usize = 4;
/// Windows looked at for documents, front to back.
const MAX_WINDOWS_LOOKED: usize = 10;

/// File names a window title names: "Report.pdf - Adobe Acrobat" → ["Report.pdf"];
/// for an app that hides extensions ("Budget - Excel"), the name with each of
/// its extensions.
pub fn names_in_title(title: &str, app: &str) -> Vec<String> {
    let mut out = Vec::new();
    // "Report.pdf - Adobe Acrobat Reader (64-bit)", "Notes.md — Visual Studio Code",
    // "● main.rs - Lumo - Visual Studio Code": the parts between separators.
    let normalized = title.replace(['\u{2014}', '\u{2013}', '|'], " - ");
    let parts: Vec<&str> = normalized
        .split(" - ")
        .map(|p| p.trim().trim_start_matches(['●', '*', '•']).trim())
        .filter(|p| !p.is_empty())
        .collect();
    for part in &parts {
        // The name may be followed by words ("Report.pdf and 3 more pages").
        if let Some(name) = file_name_in(part) {
            if !out.contains(&name) {
                out.push(name);
            }
        }
    }
    if out.is_empty() {
        let app = app.to_ascii_lowercase();
        if let Some((_, exts)) = APP_EXTS.iter().find(|(a, _)| app.starts_with(a)) {
            if let Some(stem) = parts.first().filter(|s| s.chars().count() <= 120) {
                // "Documento1" is a new, unsaved document: nothing to find.
                if !is_untitled(stem) {
                    for ext in exts.iter() {
                        out.push(format!("{stem}.{ext}"));
                    }
                }
            }
        }
    }
    out
}

/// The longest prefix of `text` that ends in a known extension, as a file name.
fn file_name_in(text: &str) -> Option<String> {
    let lower = text.to_ascii_lowercase();
    let mut best: Option<usize> = None;
    for ext in DOCUMENT_EXTS {
        let dotted = format!(".{ext}");
        let mut from = 0;
        while let Some(i) = lower[from..].find(&dotted) {
            let end = from + i + dotted.len();
            // The extension ends the name: what follows is not a letter.
            let next = lower[end..].chars().next();
            if next.is_none_or(|c| !c.is_alphanumeric()) && from + i > 0 {
                best = Some(best.map_or(end, |b| b.max(end)));
            }
            from = end;
        }
    }
    let end = best?;
    let name = text[..end].trim().trim_matches(['"', '\'', '(', '[']).trim();
    // A path in the title: only its last part.
    let name = name.rsplit(['\\', '/']).next().unwrap_or(name).trim();
    (!name.is_empty() && name.chars().count() <= 200).then(|| name.to_string())
}

fn is_untitled(stem: &str) -> bool {
    let s = stem.to_ascii_lowercase();
    ["documento", "document", "cartel", "book", "presentazione", "presentation", "untitled", "senza titolo", "nuovo"]
        .iter()
        .any(|w| s.starts_with(w) && s[w.len()..].trim().chars().all(|c| c.is_ascii_digit()))
}

/// Where a file named `name` is: the shortcut the system keeps for recently
/// opened files, else (`search`) a search of the user's folders, which can
/// take a few seconds. Blocking.
fn locate(name: &str, search: bool) -> Option<PathBuf> {
    if let Some(p) = recent(name) {
        return Some(p);
    }
    if !search {
        return None;
    }
    let found = crate::live::find(name, None).ok()?;
    found
        .into_iter()
        .filter(|f| !f.dir)
        .map(|f| PathBuf::from(f.path))
        .find(|p| p.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(name)))
}

#[cfg(windows)]
fn recent(name: &str) -> Option<PathBuf> {
    let dir = std::env::var_os("APPDATA").map(PathBuf::from)?.join("Microsoft\\Windows\\Recent");
    let link = dir.join(format!("{name}.lnk"));
    if !link.is_file() {
        return None;
    }
    let target = shortcut_target(&link)?;
    target.is_file().then_some(target)
}

/// Where a .lnk points (IShellLink).
#[cfg(windows)]
fn shortcut_target(link: &Path) -> Option<PathBuf> {
    use windows::core::{Interface, HSTRING};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
    unsafe {
        // This blocking thread may not have COM yet; a second call is harmless.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let shell: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
        let file: IPersistFile = shell.cast().ok()?;
        file.Load(&HSTRING::from(link.as_os_str()), STGM_READ).ok()?;
        let mut buf = [0u16; 1024];
        shell.GetPath(&mut buf, std::ptr::null_mut(), 0).ok()?;
        let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let path = String::from_utf16_lossy(&buf[..len]);
        (!path.is_empty()).then(|| PathBuf::from(path))
    }
}

/// Linux: the desktop's list of recently used files (recently-used.xbel).
#[cfg(not(windows))]
fn recent(name: &str) -> Option<PathBuf> {
    let file = crate::platform::home_dir().join(".local/share/recently-used.xbel");
    let text = std::fs::read_to_string(file).ok()?;
    let mut best = None;
    for part in text.split("href=\"file://").skip(1) {
        let Some(end) = part.find('"') else { continue };
        let path = crate::explorer::percent_decode_text(&part[..end])?;
        let p = PathBuf::from(&path);
        if p.file_name().is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(name)) && p.is_file() {
            best = Some(p);
        }
    }
    best
}

/// Found paths, by name, for a minute: a question every few seconds does not
/// search the disk again.
static FOUND: Mutex<Vec<(String, Option<PathBuf>, Instant)>> = Mutex::new(Vec::new());
const REMEMBER: Duration = Duration::from_secs(60);

fn locate_cached(name: &str, search: bool) -> Option<PathBuf> {
    {
        let cache = FOUND.lock().unwrap();
        if let Some((_, p, _)) = cache.iter().find(|(n, _, at)| n == name && at.elapsed() < REMEMBER) {
            return p.clone();
        }
    }
    let p = locate(name, search);
    // A miss without the search is not remembered: the search may find it later.
    if p.is_none() && !search {
        return None;
    }
    let mut cache = FOUND.lock().unwrap();
    cache.retain(|(n, _, at)| n != name && at.elapsed() < REMEMBER);
    cache.push((name.to_string(), p.clone(), Instant::now()));
    p
}

/// The documents the windows show, front to back. Blocking.
pub fn documents(windows: &[WindowInfo]) -> Vec<OpenDocument> {
    let mut out: Vec<OpenDocument> = Vec::new();
    // The disk is searched for the window in front only, once: the others are
    // found from the recent files alone, so a question never waits long.
    let mut search_left = true;
    for w in windows.iter().take(MAX_WINDOWS_LOOKED) {
        let names = names_in_title(&w.title, &w.app);
        let search = w.active && search_left && !names.is_empty();
        if search {
            search_left = false;
        }
        for name in names {
            if out.len() >= MAX_DOCUMENTS || out.iter().any(|d| d.name.eq_ignore_ascii_case(&name)) {
                continue;
            }
            if let Some(path) = locate_cached(&name, search) {
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or(name);
                out.push(OpenDocument { name, path: path.to_string_lossy().to_string(), app: w.app.clone(), active: w.active });
                // One file per window: the first name that is found.
                break;
            }
        }
    }
    out
}

/// What is open now: the windows and their documents. Blocking.
pub fn now() -> (Vec<WindowInfo>, Vec<OpenDocument>) {
    let windows = crate::screen::windows().unwrap_or_default();
    let docs = documents(&windows);
    (windows, docs)
}

/// The documents as the model reads them. `with_paths`: it reads them itself.
pub fn documents_text(docs: &[OpenDocument], with_paths: bool) -> String {
    if docs.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "Documents open on the user's computer right now, found from their windows (the user lets Lumo share them with every message):\n",
    );
    for d in docs {
        let front = if d.active { ", in front" } else { "" };
        if with_paths {
            out.push_str(&format!("- {} (in {}{front}): {}\n", d.name, d.app, d.path));
        } else {
            out.push_str(&format!("- {} (in {}{front})\n", d.name, d.app));
        }
    }
    if with_paths {
        out.push_str("When the question is about one of them (\"the PDF I have open\", \"this document\"), read it from its path yourself; don't ask the user to share it.\n");
    }
    out
}

/// Whether `query` is about the document in front: it names it, or speaks of
/// "the PDF", "this file", "the page" and the like.
pub fn asks_about(query: &str, doc: &OpenDocument) -> bool {
    let q = query.to_lowercase();
    let stem = Path::new(&doc.name).file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    if stem.chars().count() >= 4 && q.contains(&stem) {
        return true;
    }
    const WORDS: &[&str] = &[
        "pdf", "document", "file", "pagin", "page", "foglio", "sheet", "slide", "presentazion", "presentation",
        "tabella", "table", "capitolo", "chapter", "aperto", "aperta", "open", "questo", "questa", "this",
        "word", "excel", "powerpoint", "libro", "book", "articolo", "article", "contratto", "contract",
    ];
    WORDS.iter().any(|w| q.contains(w))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_name_their_files() {
        assert_eq!(names_in_title("Report 2026.pdf - Adobe Acrobat Reader (64-bit)", "Acrobat"), ["Report 2026.pdf"]);
        assert_eq!(names_in_title("manuale.pdf e altre 3 pagine - Personale - Microsoft Edge", "msedge"), ["manuale.pdf"]);
        assert_eq!(names_in_title("● main.rs - Lumo - Visual Studio Code", "Code"), ["main.rs"]);
        assert_eq!(names_in_title("Budget - Excel", "EXCEL"), ["Budget.xlsx", "Budget.xlsm", "Budget.xls", "Budget.csv", "Budget.ods"]);
        assert_eq!(names_in_title("Tesi - Word", "WINWORD")[0], "Tesi.docx");
        assert!(names_in_title("Documento1 - Word", "WINWORD").is_empty());
        assert!(names_in_title("YouTube - Google Chrome", "chrome").is_empty());
        assert_eq!(names_in_title(r"C:\Users\me\Desktop\notes.txt - Notepad", "notepad"), ["notes.txt"]);
    }

    #[test]
    fn a_question_about_the_open_document_is_seen() {
        let d = OpenDocument { name: "Contratto affitto.pdf".into(), path: "C:\\x.pdf".into(), app: "Acrobat".into(), active: true };
        assert!(asks_about("Mi spieghi cosa dice la pagina 45 del PDF che ho aperto?", &d));
        assert!(asks_about("riassumi contratto affitto", &d));
        assert!(!asks_about("che tempo fa domani a Roma?", &d));
    }

    #[test]
    fn the_text_gives_paths_only_to_who_reads_them() {
        let d = OpenDocument { name: "a.pdf".into(), path: "C:\\docs\\a.pdf".into(), app: "Acrobat".into(), active: true };
        assert!(documents_text(std::slice::from_ref(&d), true).contains("C:\\docs\\a.pdf"));
        assert!(!documents_text(std::slice::from_ref(&d), false).contains("C:\\docs"));
        assert!(documents_text(&[], true).is_empty());
    }
}
