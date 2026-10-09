// The folder open in File Explorer, for the chat — only when the user asks for it.
//
// The chat's screen button offers "Folder open in File Explorer". Opening the
// menu asks only which folder that is, for its label; clicking the entry lists
// it (names, sizes, dates, never contents) and the chat sends that listing with
// the next question. A file of that folder the question names is then copied
// into the inbox, exactly like one picked with the paperclip (files.rs), and
// Claude Code is given the folder itself (--add-dir) so it can read the others.
// Nothing runs in the background and only folders the user shared this session
// can be read from.
//
// Windows: the front-most File Explorer window (EnumWindows, which goes front
// to back) and its folder through the Shell's COM objects (IShellWindows), on
// a thread of their own. Linux: not available yet.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::files::DroppedFile;
use crate::i18n::t;

/// The listing is for context, not an inventory.
pub const MAX_ENTRIES: usize = 300;
/// A file the question names is copied only up to this size (what the
/// Anthropic API takes in one request); Claude Code can still read a bigger one.
const MAX_ATTACH: u64 = 32 * 1024 * 1024;

/// One file or subfolder, as the chat shows it and the model reads it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub name: String,
    #[serde(default)]
    pub dir: bool,
    #[serde(default)]
    pub size: u64,
    /// Local time, "2026-10-08 09:05"; empty when unknown.
    #[serde(default)]
    pub modified: String,
}

/// The folder open in File Explorer. `entries` is empty until the user shares it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerFolder {
    pub path: String,
    pub name: String,
    #[serde(default)]
    pub entries: Vec<FolderEntry>,
    /// Entries past MAX_ENTRIES, left out of the listing.
    #[serde(default)]
    pub omitted: usize,
}

// ── Pure parts ────────────────────────────────────────────────────────────────

/// A `file:` URL as a Windows path: `file:///C:/My%20Docs` → `C:\My Docs`,
/// `file://server/share` → `\\server\share`. Anything else is not a folder.
#[cfg_attr(not(windows), allow(dead_code))] // only File Explorer gives one
pub fn path_from_file_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("file://").or_else(|| url.strip_prefix("FILE://"))?;
    let bytes = percent_decode(rest)?;
    let decoded = String::from_utf8(bytes).ok()?.replace('/', "\\");
    let path = match decoded.strip_prefix('\\') {
        // file:///C:/x → \C:\x
        Some(local) if local.as_bytes().get(1) == Some(&b':') => local.to_string(),
        Some(_) => return None,
        // file://server/share → server\share
        None if !decoded.is_empty() => format!("\\\\{decoded}"),
        None => return None,
    };
    looks_like_folder(&path).then_some(path)
}

/// `%`-escaped UTF-8 text back as it was (a name the page sent in a header).
pub fn percent_decode_text(s: &str) -> Option<String> {
    String::from_utf8(percent_decode(s)?).ok()
}

fn percent_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len());
    let mut bytes = s.bytes();
    while let Some(b) = bytes.next() {
        if b == b'%' {
            let hi = (bytes.next()? as char).to_digit(16)?;
            let lo = (bytes.next()? as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
        } else {
            out.push(b);
        }
    }
    Some(out)
}

/// A path File Explorer gave that can be a folder on disk: not one of the
/// Shell's virtual places (This PC, Quick access, a library: `::{GUID}`…).
#[cfg_attr(not(windows), allow(dead_code))] // only File Explorer gives one
pub fn looks_like_folder(path: &str) -> bool {
    let p = path.trim();
    !p.is_empty() && !p.starts_with("::") && !p.contains('\0') && (p.starts_with("\\\\") || p.as_bytes().get(1) == Some(&b':') || p.starts_with('/'))
}

/// A folder's name for the menu and the chip: its last part, or the drive.
pub fn folder_name(path: &str) -> String {
    let trimmed = path.trim_end_matches(['\\', '/']);
    match trimmed.rsplit(['\\', '/']).next() {
        Some(last) if !last.is_empty() => last.to_string(),
        _ => path.to_string(),
    }
}

/// Folders first, then files, by name ignoring case; past `max` they are only counted.
pub fn cap_listing(mut entries: Vec<FolderEntry>, max: usize) -> (Vec<FolderEntry>, usize) {
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    let omitted = entries.len().saturating_sub(max);
    entries.truncate(max);
    (entries, omitted)
}

/// A size as people read it: "812 B", "1.2 KB", "34.5 MB".
pub fn size_text(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64 / 1024.0;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// (year, month, day) → days since 1970-01-01.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let m = month as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Unix seconds as "2026-10-08 09:05", shifted by `offset` seconds (the time zone).
pub fn stamp(unix: i64, offset: i64) -> String {
    let secs = unix + offset;
    let (y, mo, d) = civil_from_days(secs.div_euclid(86_400));
    let in_day = secs.rem_euclid(86_400);
    format!("{y:04}-{mo:02}-{d:02} {:02}:{:02}", in_day / 3600, in_day % 3600 / 60)
}

/// The user's time zone now, in seconds east of UTC, to the quarter hour.
fn utc_offset() -> i64 {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let l = crate::platform::local_time();
    let local = days_from_civil(l.year as i64, l.month, l.day) * 86_400 + (l.hour * 3600 + l.minute * 60 + l.second) as i64;
    ((local - now) as f64 / 900.0).round() as i64 * 900
}

/// Lowercase text with each character's position kept, so a match in it is a
/// match in what the user typed.
fn fold(s: &str) -> Vec<char> {
    s.chars().flat_map(char::to_lowercase).collect()
}

/// Letters, digits, `_` and `-` belong to a name; anything else (spaces,
/// quotes, punctuation) can stand around one.
fn is_name_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-'
}

/// Where `needle` first stands in `hay` as a whole name: nothing name-like
/// right before or after it. `bare`: the name is given without its extension,
/// so a `.ext` right after it means another file.
fn find_name(hay: &[char], needle: &[char], bare: bool) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    (0..=hay.len() - needle.len()).find(|&i| {
        if hay[i..i + needle.len()] != *needle {
            return false;
        }
        let before = i.checked_sub(1).map(|j| hay[j]);
        let after = hay.get(i + needle.len()).copied();
        let next = hay.get(i + needle.len() + 1).copied();
        before.is_none_or(|c| !is_name_char(c))
            && after.is_none_or(|c| !is_name_char(c))
            && !(bare && after == Some('.') && next.is_some_and(char::is_alphanumeric))
    })
}

/// The files `query` names, as indices into `names`, in the order the user
/// wrote them, one per mention. A name matches ignoring case, with or without its extension
/// (a bare stem of three characters or more), in quotes or not.
pub fn mentioned_files(query: &str, names: &[&str]) -> Vec<usize> {
    let hay = fold(query);
    let mut found: Vec<(usize, std::cmp::Reverse<usize>, usize)> = Vec::new();
    for (i, name) in names.iter().enumerate() {
        let full = fold(name);
        let mut best = find_name(&hay, &full, false).map(|at| (at, full.len()));
        let stem = Path::new(name).file_stem().map(|s| fold(&s.to_string_lossy())).unwrap_or_default();
        if best.is_none() && stem.len() >= 3 && stem.len() < full.len() {
            best = find_name(&hay, &stem, true).map(|at| (at, stem.len()));
        }
        if let Some((at, len)) = best {
            found.push((at, std::cmp::Reverse(len), i));
        }
    }
    // Earliest first; at the same place the longer name ("report final.pdf"
    // over "report.pdf"), then the folder's order. A name inside one already
    // taken is the same mention.
    found.sort();
    let mut end = 0;
    let mut out = Vec::new();
    for (at, std::cmp::Reverse(len), i) in found {
        if out.is_empty() || at >= end {
            out.push(i);
            end = at + len;
        }
    }
    out
}

/// What the shared folder adds before the question. `with_paths`: the model
/// can read the files itself (Claude Code, given the folder).
pub fn context_text(folder: &ExplorerFolder, with_paths: bool) -> String {
    let path = folder.path.replace('"', "&quot;");
    let mut out = format!(
        "The user shared the folder open in File Explorer just now (name, size, last modified; folders end with /):\n<explorer_folder path=\"{path}\">\n"
    );
    for e in folder.entries.iter().take(MAX_ENTRIES) {
        let name = crate::screen::clip_title(&e.name);
        let when = if e.modified.is_empty() { String::new() } else { format!(", {}", e.modified) };
        if e.dir {
            out.push_str(&format!("- {name}/ — folder{when}\n"));
        } else {
            out.push_str(&format!("- {name} — {}{when}\n", size_text(e.size)));
        }
    }
    let left_out = folder.omitted + folder.entries.len().saturating_sub(MAX_ENTRIES);
    if folder.entries.is_empty() && left_out == 0 {
        out.push_str("(empty)\n");
    }
    if left_out > 0 {
        out.push_str(&format!("({left_out} more not listed)\n"));
    }
    out.push_str("</explorer_folder>\n");
    out.push_str(if with_paths {
        "You can read the files in this folder from its path.\n"
    } else {
        "You can't open these files yourself: a file the user names in their message is attached to it. If they ask about one that isn't attached, ask them to name it.\n"
    });
    out
}

// ── Folders the user shared ───────────────────────────────────────────────────

/// Folders shared this session: only files of these can be copied in, and
/// only these are given to Claude Code.
static SHARED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

fn remember(path: &Path) {
    let mut list = SHARED.lock().unwrap_or_else(|e| e.into_inner());
    list.retain(|p| p != path);
    list.push(path.to_path_buf());
    let excess = list.len().saturating_sub(16);
    list.drain(..excess);
}

/// True when the user shared `path` from the screen button this session.
pub fn was_shared(path: &str) -> bool {
    let path = Path::new(path);
    SHARED.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|p| p == path)
}

/// Hidden and system files (desktop.ini, Thumbs.db; dotfiles on Linux), which
/// File Explorer doesn't show either.
fn is_hidden(name: &str, meta: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const HIDDEN: u32 = 0x2;
        const SYSTEM: u32 = 0x4;
        let _ = name;
        meta.file_attributes() & (HIDDEN | SYSTEM) != 0
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        name.starts_with('.')
    }
}

/// What is in `dir`: names, sizes and dates, capped.
pub fn list_folder(dir: &Path) -> Result<(Vec<FolderEntry>, usize), String> {
    let offset = utc_offset();
    let read = std::fs::read_dir(dir).map_err(|e| crate::i18n::tf("Couldn't read the folder: {error}", &[("error", &e.to_string())]))?;
    let mut entries = Vec::new();
    for entry in read.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        if is_hidden(&name, &meta) {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| stamp(d.as_secs() as i64, offset))
            .unwrap_or_default();
        entries.push(FolderEntry { name, dir: meta.is_dir(), size: if meta.is_dir() { 0 } else { meta.len() }, modified });
    }
    Ok(cap_listing(entries, MAX_ENTRIES))
}

/// The folder open in File Explorer, its path and name only: the menu's label.
pub fn peek() -> Result<Option<ExplorerFolder>, String> {
    Ok(imp::front_folder()?.map(|path| ExplorerFolder {
        name: folder_name(&path.to_string_lossy()),
        path: path.to_string_lossy().to_string(),
        entries: Vec::new(),
        omitted: 0,
    }))
}

/// The user clicked the entry: that folder with what is in it, remembered as shared.
pub fn share() -> Result<Option<ExplorerFolder>, String> {
    let Some(path) = imp::front_folder()? else { return Ok(None) };
    let (entries, omitted) = list_folder(&path)?;
    remember(&path);
    Ok(Some(ExplorerFolder {
        name: folder_name(&path.to_string_lossy()),
        path: path.to_string_lossy().to_string(),
        entries,
        omitted,
    }))
}

/// The file of shared folder `folder` that `query` names first, copied into
/// the inbox like a picked file; `None` when it names none (or only folders,
/// or a file too big to send).
pub fn attach(folder: &str, query: &str) -> Result<Option<DroppedFile>, String> {
    if !was_shared(folder) {
        return Err(t("Only a folder shared from the screen button can be read."));
    }
    let dir = Path::new(folder);
    let mut files: Vec<(String, u64)> = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        if meta.is_file() && !is_hidden(&name, &meta) {
            files.push((name, meta.len()));
        }
    }
    files.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
    for i in mentioned_files(query, &names) {
        let (name, size) = &files[i];
        let path = dir.join(name);
        if *size > MAX_ATTACH || !crate::chat::is_inside(dir, &path) {
            continue;
        }
        return crate::files::copy_in(&path).map(Some);
    }
    Ok(None)
}

// ── Platform ──────────────────────────────────────────────────────────────────

#[cfg(not(windows))]
mod imp {
    use super::*;

    pub fn front_folder() -> Result<Option<PathBuf>, String> {
        Err(t("Not available on Linux yet."))
    }
}

#[cfg(windows)]
mod imp {
    use super::*;

    use std::sync::mpsc;
    use std::time::Duration;

    use ::windows::core::{w, Interface, BOOL, PCWSTR};
    use ::windows::Win32::Foundation::{HWND, LPARAM};
    use ::windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IServiceProvider, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
    };
    use ::windows::Win32::System::Variant::VARIANT;
    use ::windows::Win32::UI::Shell::{
        Folder2, IShellBrowser, IShellFolderViewDual, IShellWindows, IWebBrowser2, SID_STopLevelBrowser, ShellWindows,
    };
    use ::windows::Win32::UI::WindowsAndMessaging::{EnumWindows, FindWindowExW, GetClassNameW, IsWindowVisible};

    /// File Explorer asked over COM can hang along with explorer.exe: past this
    /// the menu says there is no folder rather than wait.
    const COM_TIMEOUT: Duration = Duration::from_secs(3);

    /// The front-most File Explorer window: EnumWindows goes front to back.
    fn front_explorer() -> Option<isize> {
        unsafe extern "system" fn each(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let found = unsafe { &mut *(lparam.0 as *mut Option<isize>) };
            let mut buf = [0u16; 64];
            let len = unsafe { GetClassNameW(hwnd, &mut buf) };
            if unsafe { IsWindowVisible(hwnd) }.as_bool() && String::from_utf16_lossy(&buf[..len.max(0) as usize]) == "CabinetWClass" {
                *found = Some(hwnd.0 as isize);
                return false.into(); // found: stop
            }
            true.into()
        }
        let mut found: Option<isize> = None;
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&mut found as *mut _ as isize));
        }
        found
    }

    /// The folder `browser` shows, or None for a virtual place.
    unsafe fn folder_of(browser: &IWebBrowser2) -> Option<String> {
        unsafe {
            let item = browser
                .Document()
                .and_then(|doc| doc.cast::<IShellFolderViewDual>())
                .and_then(|view| view.Folder())
                .and_then(|folder| folder.cast::<Folder2>())
                .and_then(|folder| folder.Self_());
            if let Ok(item) = item {
                if !item.IsFileSystem().map(|v| v.as_bool()).unwrap_or(false) {
                    return None; // This PC, Quick access, the Recycle Bin, a library…
                }
                if let Ok(path) = item.Path() {
                    let path = path.to_string();
                    if looks_like_folder(&path) {
                        return Some(path);
                    }
                }
            }
            browser.LocationURL().ok().and_then(|url| path_from_file_url(&url.to_string()))
        }
    }

    /// The window of one tab: Windows 11 lists every tab of a window apart.
    unsafe fn tab_window(browser: &IWebBrowser2) -> Option<isize> {
        unsafe {
            let provider: IServiceProvider = browser.cast().ok()?;
            let shell: IShellBrowser = provider.QueryService(&SID_STopLevelBrowser).ok()?;
            shell.GetWindow().ok().map(|h| h.0 as isize)
        }
    }

    /// The folder of window `top`, through IShellWindows. COM is set up on the calling thread.
    unsafe fn folder_in(top: isize) -> Option<String> {
        unsafe {
            let windows: IShellWindows = CoCreateInstance(&ShellWindows, None, CLSCTX_ALL).ok()?;
            let count = windows.Count().ok()?;
            let mut matches: Vec<IWebBrowser2> = Vec::new();
            for i in 0..count {
                let Ok(item) = windows.Item(&VARIANT::from(i)) else { continue };
                let Ok(browser) = item.cast::<IWebBrowser2>() else { continue };
                if browser.HWND().map(|h| h.0) == Ok(top) {
                    matches.push(browser);
                }
            }
            // Several tabs: the one in front is the first tab window in z-order.
            let active = FindWindowExW(Some(HWND(top as *mut _)), None, w!("ShellTabWindowClass"), PCWSTR::null()).ok();
            let pick = active
                .and_then(|tab| matches.iter().find(|b| tab_window(b) == Some(tab.0 as isize)))
                .or(matches.first())?;
            folder_of(pick)
        }
    }

    pub fn front_folder() -> Result<Option<PathBuf>, String> {
        let Some(top) = front_explorer() else { return Ok(None) };
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let com = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            let found = unsafe { folder_in(top) };
            if com.is_ok() {
                unsafe { CoUninitialize() };
            }
            let _ = tx.send(found);
        });
        let found = rx.recv_timeout(COM_TIMEOUT).ok().flatten();
        Ok(found.map(PathBuf::from).filter(|p| p.is_dir()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, dir: bool, size: u64) -> FolderEntry {
        FolderEntry { name: name.into(), dir, size, modified: String::new() }
    }

    #[test]
    fn file_urls_become_windows_paths_and_virtual_places_are_none() {
        assert_eq!(path_from_file_url("file:///C:/Users/me/My%20Docs").as_deref(), Some("C:\\Users\\me\\My Docs"));
        assert_eq!(path_from_file_url("file:///D:/").as_deref(), Some("D:\\"));
        assert_eq!(path_from_file_url("file:///C:/Users/%C3%A9l%C3%A8ve").as_deref(), Some("C:\\Users\\élève"));
        assert_eq!(path_from_file_url("file://server/share/Docs").as_deref(), Some("\\\\server\\share\\Docs"));
        assert_eq!(path_from_file_url(""), None, "This PC has no URL");
        assert_eq!(path_from_file_url("::{20D04FE0-3AEA-1069-A2D8-08002B30309D}"), None);
        assert_eq!(path_from_file_url("https://example.com/x"), None);
        assert_eq!(path_from_file_url("file:///C:/bad%2"), None, "a cut escape");
        assert_eq!(path_from_file_url("file:///C:/bad%ff"), None, "not UTF-8");
        assert_eq!(path_from_file_url("file:///"), None);
        assert!(!looks_like_folder("::{031E4825-7B94-4DC3-B131-E946B44C8DD5}\\Documents.library-ms"));
        assert!(!looks_like_folder(""));
        assert!(looks_like_folder("C:\\Users\\me"));
        assert!(looks_like_folder("\\\\nas\\photos"));
        assert_eq!(percent_decode_text("Screenshot%202026-10-08%20%C3%A9.png").as_deref(), Some("Screenshot 2026-10-08 é.png"));
        assert_eq!(percent_decode_text("bad%ff"), None);
    }

    #[test]
    fn a_folder_is_named_after_its_last_part() {
        assert_eq!(folder_name("C:\\Users\\me\\Documents\\Contracts"), "Contracts");
        assert_eq!(folder_name("C:\\Users\\me\\Docs\\"), "Docs");
        assert_eq!(folder_name("D:\\"), "D:");
        assert_eq!(folder_name("/home/me/pdfs"), "pdfs");
    }

    #[test]
    fn mentioned_files_match_ignoring_case_extension_and_quotes() {
        let names = ["file.pdf", "Bilancio 2025.xlsx", "report.pdf", "report.docx", "a.txt", "notes.md"];
        let m = |q: &str| mentioned_files(q, &names).into_iter().map(|i| names[i]).collect::<Vec<_>>();
        assert_eq!(m("mi leggi il file 'file.pdf'?"), ["file.pdf"]);
        assert_eq!(m("mi leggi il file \"FILE.PDF\""), ["file.pdf"]);
        assert_eq!(m("riassumi bilancio 2025"), ["Bilancio 2025.xlsx"], "no extension");
        assert_eq!(m("compare report.docx with notes"), ["report.docx", "notes.md"]);
        assert_eq!(m("open report.pdf"), ["report.pdf"], "the other report has another extension");
        assert_eq!(m("what is in a.txt?"), ["a.txt"]);
        assert!(m("write a summary").is_empty(), "a short stem alone is a word, not a file");
        assert!(m("myfile.pdf and reports").is_empty(), "only whole names");
        assert!(m("old-notes.md").is_empty());
        assert!(m("").is_empty());
        // The same stem for two files: the first in the folder's order.
        assert_eq!(m("the report"), ["report.pdf"]);
        // At the same place, the longer name wins.
        let names = ["report.pdf", "report final.pdf"];
        assert_eq!(mentioned_files("read report final.pdf", &names), [1]);
    }

    #[test]
    fn the_listing_puts_folders_first_and_is_capped() {
        let (list, omitted) = cap_listing(vec![entry("b.pdf", false, 1), entry("Zeta", true, 0), entry("A.pdf", false, 2), entry("alpha", true, 0)], 300);
        assert_eq!(list.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(), ["alpha", "Zeta", "A.pdf", "b.pdf"]);
        assert_eq!(omitted, 0);
        let many: Vec<FolderEntry> = (0..350).map(|i| entry(&format!("f{i:03}.txt"), false, 1)).collect();
        let (list, omitted) = cap_listing(many, MAX_ENTRIES);
        assert_eq!(list.len(), MAX_ENTRIES);
        assert_eq!(omitted, 50);
    }

    #[test]
    fn sizes_and_dates_read_like_people_write_them() {
        assert_eq!(size_text(0), "0 B");
        assert_eq!(size_text(812), "812 B");
        assert_eq!(size_text(1536), "1.5 KB");
        assert_eq!(size_text(34 * 1024 * 1024 + 512 * 1024), "34.5 MB");
        assert_eq!(size_text(3 * 1024 * 1024 * 1024), "3.0 GB");
        assert_eq!(stamp(0, 0), "1970-01-01 00:00");
        assert_eq!(stamp(1_791_450_300, 0), "2026-10-08 09:05");
        assert_eq!(stamp(1_791_450_300, 2 * 3600), "2026-10-08 11:05");
        assert_eq!(stamp(1_709_164_800, 0), "2024-02-29 00:00", "a leap day");
        for days in [-1, 0, 19_000, 20_734, 2_932_896] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
    }

    #[test]
    fn the_context_lists_the_folder_and_says_what_was_left_out() {
        let folder = ExplorerFolder {
            path: "C:\\Users\\me\\Docs".into(),
            name: "Docs".into(),
            entries: vec![
                FolderEntry { name: "Old".into(), dir: true, size: 0, modified: "2026-10-01 14:02".into() },
                FolderEntry { name: "file.pdf".into(), dir: false, size: 1536, modified: "2026-10-08 09:05".into() },
            ],
            omitted: 41,
        };
        let cli = context_text(&folder, true);
        assert!(cli.contains("<explorer_folder path=\"C:\\Users\\me\\Docs\">\n- Old/ — folder, 2026-10-01 14:02\n- file.pdf — 1.5 KB, 2026-10-08 09:05\n(41 more not listed)\n</explorer_folder>\n"), "{cli}");
        assert!(cli.contains("read the files in this folder"));
        let api = context_text(&folder, false);
        assert!(api.contains("You can't open these files yourself"));
        let empty = ExplorerFolder { entries: vec![], omitted: 0, ..folder };
        assert!(context_text(&empty, true).contains("(empty)\n</explorer_folder>"));
    }

    #[test]
    fn only_a_shared_folder_gives_its_named_file_and_only_a_regular_file_inside_it() {
        let base = std::env::temp_dir().join(format!("coucou-explorer-{}", std::process::id()));
        let dir = base.join("Docs");
        std::fs::create_dir_all(dir.join("Sub")).unwrap();
        std::fs::write(dir.join("file.pdf"), b"%PDF").unwrap();
        std::fs::write(dir.join("Sub").join("inner.txt"), b"x").unwrap();
        std::fs::write(base.join("secret.txt"), b"s").unwrap();
        let folder = dir.to_string_lossy().to_string();

        assert!(attach(&folder, "read file.pdf").is_err(), "never shared");
        remember(&dir);
        assert!(was_shared(&folder));
        let got = attach(&folder, "mi leggi il file 'file.pdf'?").unwrap().unwrap();
        assert_eq!(got.name, "file.pdf");
        assert_eq!(std::fs::read(&got.path).unwrap(), b"%PDF");
        assert!(Path::new(&got.path).starts_with(crate::files::inbox_dir()));
        let _ = std::fs::remove_file(&got.path);

        assert!(attach(&folder, "open Sub").unwrap().is_none(), "a folder is not attached");
        assert!(attach(&folder, "open inner.txt").unwrap().is_none(), "only the folder itself, not below");
        assert!(attach(&folder, "open ../secret.txt").unwrap().is_none());
        assert!(attach(&folder, "nothing named here").unwrap().is_none());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("secret.txt"), dir.join("link.txt")).unwrap();
            assert!(attach(&folder, "read link.txt").unwrap().is_none(), "a link pointing out of the folder");
        }

        let (list, omitted) = list_folder(&dir).unwrap();
        assert_eq!(omitted, 0);
        assert_eq!(list[0], FolderEntry { name: "Sub".into(), dir: true, size: 0, modified: list[0].modified.clone() });
        assert!(list.iter().any(|e| e.name == "file.pdf" && e.size == 4 && e.modified.len() == 16));
        let _ = std::fs::remove_dir_all(&base);
    }
}
