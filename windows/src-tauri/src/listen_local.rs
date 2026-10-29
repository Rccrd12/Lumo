// Listening on this PC (listen.rs keeps the watches and fires them): a file
// or a folder, a program or a port, a web page. Lumo looks at them itself, a
// little while apart, and only while something listens to them: a folder's
// listing every few seconds, the running programs once for all the watches
// on them, a page once a minute.
//
// What changed is told against the last look: the first look after a watch
// starts (or after a restart) only remembers how things are. A state (a
// program running, a port open, a page answering) fires when it becomes
// true, and listening once also when it is already true at the first look.

use std::collections::{BTreeMap, HashSet};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

/// What a watch on a file or a folder waits for.
pub const FS_UNTILS: &[&str] = &["created", "changed", "deleted", "download"];
/// What a watch on a program (its executable's name) or a port waits for.
pub const PROCESS_UNTILS: &[&str] = &["started", "exited", "port_open", "port_closed"];
/// What a watch on a web page waits for.
pub const WEB_UNTILS: &[&str] = &["changed", "up", "down", "contains"];

/// The names of a folder's files (or of the one file watched): (size, modified Unix ms).
pub type Listing = BTreeMap<String, (u64, u64)>;

/// A folder with more than this many files is looked at only this far.
const MAX_FILES: usize = 5000;
/// Names browsers give a download until it is done.
const PARTIAL: &[&str] = &[".crdownload", ".part", ".partial", ".download", ".opdownload", ".tmp"];
/// A new file counts as downloaded once it stopped changing for this long.
const SETTLED_MS: u64 = 3000;
/// A page bigger than this is read only this far.
const MAX_PAGE: usize = 2 * 1024 * 1024;
const MAX_TARGET: usize = 2000;
const MAX_TEXT: usize = 200;

pub fn untils(source: &str) -> &'static [&'static str] {
    match source {
        "fs" => FS_UNTILS,
        "process" => PROCESS_UNTILS,
        "web" => WEB_UNTILS,
        _ => &[],
    }
}

// ── What a watch names ────────────────────────────────────────────────────────

/// `C:\…`, `C:/…` or `\\server\share\…`.
fn absolute(path: &str) -> bool {
    let b = path.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/')) || path.starts_with("\\\\")
}

/// A program as Windows lists it: its executable's name, in lower case, with `.exe`.
pub fn program_name(target: &str) -> String {
    let name = target.trim().to_lowercase();
    if name.contains('.') {
        name
    } else {
        format!("{name}.exe")
    }
}

/// `3000`, `:3000`, `localhost:3000`, `port 3000`.
pub fn port_of(target: &str) -> Option<u16> {
    let text = target.trim().to_ascii_lowercase();
    let text = text.strip_prefix("port").unwrap_or(&text).trim();
    let text = text.rsplit(':').next().unwrap_or(text).trim().trim_end_matches('/');
    text.parse::<u16>().ok().filter(|p| *p > 0)
}

/// The target as it is kept, or why it can't be listened to. `home`: where `~` leads.
pub fn target(source: &str, until: &str, target: &str, text: &str, home: &Path) -> Result<String, String> {
    let target = target.trim().trim_matches('"').trim();
    if target.is_empty() || target.chars().count() > MAX_TARGET || target.contains(['"', '[', ']', '\n', '\r']) {
        return Err("Give the target as one line, without quotes or brackets.".into());
    }
    if !untils(source).contains(&until) {
        return Err(format!("event must be one of {} for {source}.", untils(source).join(", ")));
    }
    match source {
        "fs" => {
            let path = match target.strip_prefix('~') {
                Some(rest) => home.join(rest.trim_start_matches(['\\', '/'])).to_string_lossy().to_string(),
                None => target.to_string(),
            };
            if !absolute(&path) {
                return Err("Give the file or folder as a full path, like C:\\Users\\name\\Downloads.".into());
            }
            Ok(path.trim_end_matches(['\\', '/']).to_string() + if path.len() == 3 { "\\" } else { "" })
        }
        "process" if until.starts_with("port_") => {
            port_of(target).map(|p| p.to_string()).ok_or_else(|| "Give the port as a number, like 3000.".into())
        }
        "process" => {
            if target.contains(['\\', '/', ':', '*', '?', '<', '>', '|']) || target.chars().count() > 100 {
                return Err("Give the program as its executable's name, like node.exe.".into());
            }
            Ok(program_name(target))
        }
        "web" => {
            let lower = target.to_ascii_lowercase();
            if !(lower.starts_with("https://") || lower.starts_with("http://")) || target.contains(char::is_whitespace) {
                return Err("Give the page as a link starting with https://.".into());
            }
            if until == "contains" && (text.trim().is_empty() || text.chars().count() > MAX_TEXT) {
                return Err(format!("contains needs the text to wait for, at most {MAX_TEXT} characters."));
            }
            Ok(target.to_string())
        }
        _ => Err("source must be fs, process or web.".into()),
    }
}

/// How a watch is called: the file or folder's name, the program, `:3000`, the page's address.
pub fn label(source: &str, until: &str, target: &str) -> String {
    match source {
        "fs" => last_part(target).to_string(),
        "process" if until.starts_with("port_") => format!(":{target}"),
        "web" => {
            let rest = target.split_once("://").map_or(target, |(_, r)| r);
            let rest = rest.strip_prefix("www.").unwrap_or(rest).trim_end_matches('/');
            if rest.chars().count() > 40 {
                rest.chars().take(39).collect::<String>() + "…"
            } else {
                rest.to_string()
            }
        }
        _ => target.to_string(),
    }
}

// ── Files and folders ─────────────────────────────────────────────────────────

fn modified_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The folder's files, or the one file (none while it isn't there); None when it can't be read.
pub fn listing(path: &Path) -> Option<Listing> {
    let mut out = Listing::new();
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Some(out),
        Err(_) => return None,
    };
    if !meta.is_dir() {
        let name = path.file_name()?.to_string_lossy().to_string();
        out.insert(name, (meta.len(), modified_ms(&meta)));
        return Some(out);
    }
    for entry in std::fs::read_dir(path).ok()?.flatten().take(MAX_FILES) {
        let Ok(meta) = entry.metadata() else { continue };
        let size = if meta.is_dir() { 0 } else { meta.len() };
        out.insert(entry.file_name().to_string_lossy().to_string(), (size, modified_ms(&meta)));
    }
    Some(out)
}

/// A new file that is a finished download: not a browser's partial one, not
/// empty, and not changed for a moment.
pub fn downloaded(name: &str, size: u64, modified: u64, now: u64) -> bool {
    let lower = name.to_lowercase();
    !PARTIAL.iter().any(|p| lower.ends_with(p)) && !lower.starts_with('~') && size > 0 && now.saturating_sub(modified) >= SETTLED_MS
}

/// What a look at the folder says for `until`: the names that fire it, and
/// the listing to remember (a download still going stays new for the next look).
pub fn judge_files(until: &str, before: &Listing, after: Listing, now: u64) -> (Vec<String>, Listing) {
    let added: Vec<String> = after.keys().filter(|k| !before.contains_key(*k)).cloned().collect();
    let removed: Vec<String> = before.keys().filter(|k| !after.contains_key(*k)).cloned().collect();
    let changed: Vec<String> = after.iter().filter(|(k, v)| before.get(*k).is_some_and(|b| b != *v)).map(|(k, _)| k.clone()).collect();
    match until {
        "created" => (added, after),
        "deleted" => (removed, after),
        "changed" => ([added, removed, changed].concat(), after),
        "download" => {
            let (ready, going): (Vec<String>, Vec<String>) =
                added.into_iter().partition(|name| after.get(name).is_some_and(|(size, modified)| downloaded(name, *size, *modified, now)));
            let mut keep = after;
            for name in going {
                keep.remove(&name);
            }
            (ready, keep)
        }
        _ => (Vec::new(), after),
    }
}

/// At most four names, then "…".
pub fn names_text(names: &[String]) -> String {
    let mut text = names.iter().take(4).cloned().collect::<Vec<_>>().join(", ");
    if names.len() > 4 {
        text.push_str(", …");
    }
    text
}

/// A path's last name (`C:\\Users\\me\\Downloads`: Downloads), the path itself for a drive.
pub fn last_part(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['\\', '/']);
    match trimmed.rsplit(['\\', '/']).next() {
        Some(name) if !name.is_empty() && !name.ends_with(':') => name,
        _ => path,
    }
}

/// The folder a watch's files are in: the folder itself, or the watched file's.
pub fn folder_of(target: &str) -> String {
    if PathBuf::from(target).is_dir() {
        return last_part(target).to_string();
    }
    let trimmed = target.trim_end_matches(['\\', '/']);
    let parent = trimmed.rsplit_once(['\\', '/']).map_or(trimmed, |(parent, _)| parent);
    last_part(parent).to_string()
}

// ── Programs and ports ────────────────────────────────────────────────────────

/// Something answers on the port, on this PC.
pub fn port_open(port: u16) -> bool {
    let wait = Duration::from_millis(400);
    ["127.0.0.1", "[::1]"]
        .iter()
        .filter_map(|host| format!("{host}:{port}").parse::<SocketAddr>().ok())
        .any(|addr| TcpStream::connect_timeout(&addr, wait).is_ok())
}

pub fn running(names: &HashSet<String>, program: &str) -> bool {
    names.contains(program)
}

// ── Web pages ─────────────────────────────────────────────────────────────────

/// A page as it answered: its status (None: no answer at all) and its text.
pub struct Page {
    pub status: Option<u16>,
    pub text: String,
}

impl Page {
    pub fn up(&self) -> bool {
        self.status.is_some_and(|s| s < 400)
    }
}

fn client() -> reqwest::Client {
    static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .unwrap_or_default()
    });
    CLIENT.clone()
}

/// The page, read at most MAX_PAGE far; an HTML page as the words it shows.
pub async fn page(url: &str) -> Page {
    let Ok(mut response) = client().get(url).header("User-Agent", "Lumo").send().await else {
        return Page { status: None, text: String::new() };
    };
    let status = response.status().as_u16();
    let html = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("html"));
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        body.extend_from_slice(&chunk);
        if body.len() >= MAX_PAGE {
            body.truncate(MAX_PAGE);
            break;
        }
    }
    let raw = String::from_utf8_lossy(&body);
    Page { status: Some(status), text: if html { page_text(&raw) } else { raw.trim().to_string() } }
}

/// The words a page shows: no scripts, styles or tags, spaces collapsed, so a
/// page that only changes a hidden token or a script does not count as changed.
pub fn page_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 4);
    let lower = html.to_ascii_lowercase();
    let mut i = 0;
    while i < html.len() {
        let rest = &lower[i..];
        let skip_to = ["script", "style", "noscript", "template"].iter().find_map(|tag| {
            rest.strip_prefix('<')
                .filter(|r| r.starts_with(tag) && r[tag.len()..].starts_with([' ', '>', '\t', '\n', '\r']))
                .map(|_| rest.find(&format!("</{tag}")).map_or(html.len(), |end| i + end))
        });
        if let Some(end) = skip_to {
            i = end.max(i + 1);
            continue;
        }
        if rest.starts_with('<') {
            i += rest.find('>').map_or(rest.len(), |end| end + 1);
            out.push(' ');
            continue;
        }
        let next = rest.find('<').map_or(html.len(), |n| i + n);
        out.push_str(&html[i..next]);
        i = next;
    }
    let text = out.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'");
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A page's fingerprint (FNV-1a), the same from one version of Lumo to the next.
pub fn fingerprint(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

pub fn contains(page: &Page, text: &str) -> bool {
    page.up() && page.text.to_lowercase().contains(&text.trim().to_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(list: &[(&str, u64, u64)]) -> Listing {
        list.iter().map(|(n, s, m)| (n.to_string(), (*s, *m))).collect()
    }

    #[test]
    fn targets_are_read_and_checked() {
        let home = Path::new("C:\\Users\\me");
        assert_eq!(target("fs", "created", "C:\\Users\\me\\Downloads\\", "", home).unwrap(), "C:\\Users\\me\\Downloads");
        assert_eq!(target("fs", "download", "~/Downloads", "", home).unwrap(), home.join("Downloads").to_string_lossy());
        assert_eq!(target("fs", "changed", "D:\\", "", home).unwrap(), "D:\\");
        assert!(target("fs", "created", "Downloads", "", home).is_err());
        assert!(target("fs", "started", "C:\\x", "", home).is_err());
        assert_eq!(target("process", "exited", "Code", "", home).unwrap(), "code.exe");
        assert_eq!(target("process", "started", "node.exe", "", home).unwrap(), "node.exe");
        assert!(target("process", "started", "C:\\bin\\node.exe", "", home).is_err());
        assert_eq!(target("process", "port_open", "localhost:3000", "", home).unwrap(), "3000");
        assert_eq!(target("process", "port_closed", ":8080", "", home).unwrap(), "8080");
        assert!(target("process", "port_open", "lots", "", home).is_err());
        assert_eq!(target("web", "changed", "https://example.com/a", "", home).unwrap(), "https://example.com/a");
        assert!(target("web", "changed", "example.com", "", home).is_err());
        assert!(target("web", "contains", "https://example.com", " ", home).is_err());
        assert!(target("web", "contains", "https://example.com", "In stock", home).is_ok());
        assert!(target("web", "up", "https://example.com/\"]]", "", home).is_err());
    }

    #[test]
    fn labels_are_short() {
        assert_eq!(label("fs", "created", "C:\\Users\\me\\Downloads"), "Downloads");
        assert_eq!(label("process", "port_open", "3000"), ":3000");
        assert_eq!(label("process", "exited", "node.exe"), "node.exe");
        assert_eq!(label("web", "up", "https://www.example.com/"), "example.com");
        assert_eq!(label("fs", "changed", "D:\\"), "D:\\");
        assert_eq!(folder_of("C:\\nowhere-at-all\\report.pdf"), "nowhere-at-all");
    }

    #[test]
    fn a_folder_says_what_came_and_went() {
        let before = files(&[("a.txt", 1, 10), ("b.txt", 2, 10)]);
        let after = files(&[("a.txt", 5, 20), ("c.txt", 3, 10)]);
        assert_eq!(judge_files("created", &before, after.clone(), 0).0, vec!["c.txt"]);
        assert_eq!(judge_files("deleted", &before, after.clone(), 0).0, vec!["b.txt"]);
        assert_eq!(judge_files("changed", &before, after.clone(), 0).0, vec!["c.txt", "b.txt", "a.txt"]);
        assert!(judge_files("created", &after, after.clone(), 0).0.is_empty());
    }

    #[test]
    fn a_download_counts_once_it_is_done() {
        let before = files(&[]);
        let now = 100_000;
        // Still downloading: a partial name, an empty placeholder, a file still growing.
        let going = files(&[("a.pdf.crdownload", 50, now - 10_000), ("a.pdf", 0, now - 10_000), ("b.zip", 9, now - 500)]);
        let (ready, keep) = judge_files("download", &before, going, now);
        assert!(ready.is_empty());
        assert!(keep.is_empty());
        // Done: the next look tells it.
        let done = files(&[("a.pdf", 50, now), ("b.zip", 9, now - 500)]);
        let (ready, keep) = judge_files("download", &before, done, now + 5_000);
        assert_eq!(ready, vec!["a.pdf", "b.zip"]);
        assert_eq!(keep.len(), 2);
    }

    #[test]
    fn a_page_is_its_words() {
        let html = "<html><head><style>p{}</style><script>var t = 123;</script></head><body><p>In&nbsp;stock</p>\n<p>Price: 10 &amp; up</p><noscript>x</noscript></body></html>";
        assert_eq!(page_text(html), "In stock Price: 10 & up");
        assert_eq!(fingerprint("abc"), fingerprint("abc"));
        assert_ne!(fingerprint("abc"), fingerprint("abd"));
        let page = Page { status: Some(200), text: "In stock now".into() };
        assert!(contains(&page, "in STOCK"));
        assert!(!contains(&Page { status: Some(500), text: "In stock".into() }, "in stock"));
        assert!(!Page { status: None, text: String::new() }.up());
    }

    #[test]
    fn ports_are_read() {
        assert_eq!(port_of("3000"), Some(3000));
        assert_eq!(port_of("port 8080"), Some(8080));
        assert_eq!(port_of("http://localhost:5173/"), Some(5173));
        assert_eq!(port_of("0"), None);
        assert_eq!(port_of("node"), None);
    }
}
