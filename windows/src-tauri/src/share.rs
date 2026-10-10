// What the chat's screen button shares besides screenshots: the windows open
// on the user's computer and the tabs open in Edge and Chrome — each one with
// what it shows, not only its name. Only when the user picks it, from a list
// the menu asks for when it opens.
//
// Windows: a window's text is read through UI Automation, the interface
// screen readers use (the page in a browser, the document in Word or
// Notepad, the lines of a list…). The document a window shows, when it is
// found on disk (desk.rs), goes as its path for the CLIs to read.
//
// Tabs: Edge and Chrome keep their open tabs (address and title) in their
// session file, read here and never written. The tab on screen in a browser
// window is read from that window like any other; a tab in the background is
// downloaded from its address — without the user's cookies, so a page that
// needs a login shows what anyone would see. Nothing is fetched until the
// user picks the tab, and only http and https addresses.
//
// The page only ever names what Rust listed: a window or a tab that was not
// in the last list is never read, so a script in the page cannot point Lumo
// at a window or an address of its choosing.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::i18n::t;
use crate::screen::{clip_title, WindowInfo};

/// Characters of text, all windows (or all tabs) of one message together.
const TEXT_BUDGET: usize = 36_000;
/// Characters of text one window or tab gets at most.
const MAX_ONE: usize = 16_000;
/// Characters one gets at least, however many share the budget.
const MIN_ONE: usize = 1_500;
/// Tabs read at most for one message: the others go with their address only.
const MAX_TABS_READ: usize = 12;
/// A page downloaded for a tab, at most.
const MAX_PAGE_BYTES: usize = 3 * 1024 * 1024;
const PAGE_TIMEOUT: Duration = Duration::from_secs(10);

/// A window the user shared, with what it shows.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedWindow {
    pub title: String,
    pub app: String,
    /// Its text, as UI Automation reads it; empty when it gives none.
    #[serde(default)]
    pub text: String,
    /// The text was cut to fit.
    #[serde(default)]
    pub cut: bool,
    /// The document it shows, found on disk (desk.rs); empty if none.
    #[serde(default)]
    pub document: String,
}

/// A tab open in Edge or Chrome.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    /// "<browser>|<profile>|<tab>": what the page names it by.
    pub id: String,
    /// "Edge" or "Chrome".
    pub browser: String,
    pub title: String,
    pub url: String,
    /// The tab on screen in its window.
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub cut: bool,
    /// Where the text came from: "page" (read in the browser), "web"
    /// (downloaded from its address), "" (none).
    #[serde(default)]
    pub source: String,
}

// ── What the page may name ──────────────────────────────────────────────────

/// The windows and tabs the last lists gave the page, by id.
static LISTED_WINDOWS: Mutex<Vec<(i64, WindowInfo)>> = Mutex::new(Vec::new());
static LISTED_TABS: Mutex<Vec<BrowserTab>> = Mutex::new(Vec::new());
/// Documents found for a shared window: the only paths a CLI is given the folder of.
static FOUND_DOCUMENTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn remember_document(path: &str) {
    let mut list = FOUND_DOCUMENTS.lock().unwrap_or_else(|e| e.into_inner());
    if !list.iter().any(|p| p == path) {
        list.push(path.to_string());
    }
    let excess = list.len().saturating_sub(64);
    list.drain(..excess);
}

/// True for a document path a shared window gave (not one a page made up).
pub fn was_found(path: &str) -> bool {
    FOUND_DOCUMENTS.lock().unwrap_or_else(|e| e.into_inner()).iter().any(|p| p == path)
}

// ── Pure parts ────────────────────────────────────────────────────────────────

/// What each of `count` windows or tabs may take of the budget.
pub fn share_of_budget(count: usize) -> usize {
    (TEXT_BUDGET / count.max(1)).clamp(MIN_ONE, MAX_ONE)
}

/// `text` tidied (no runs of blank lines or spaces) and cut to `max`
/// characters; true when it was cut.
pub fn tidy_text(text: &str, max: usize) -> (String, bool) {
    let mut out = String::new();
    let mut blank = 0;
    for line in text.lines() {
        let line: String = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            blank += 1;
            continue;
        }
        if !out.is_empty() {
            out.push_str(if blank > 0 { "\n\n" } else { "\n" });
        }
        blank = 0;
        out.push_str(&line);
    }
    if out.chars().count() <= max {
        return (out, false);
    }
    let mut cut: String = out.chars().take(max).collect();
    // At the end of a line or a word, where there is one near.
    if let Some(i) = cut.rfind(['\n', ' ']).filter(|&i| i > cut.len() / 2) {
        cut.truncate(i);
    }
    cut.push_str(" […]");
    (cut, true)
}

/// The shared windows as the model reads them.
pub fn windows_text(list: &[SharedWindow], with_paths: bool) -> String {
    if list.is_empty() {
        return String::new();
    }
    let mut out = String::from("Windows the user shared just now, with what each one shows (read from the screen):\n");
    for w in list {
        let app = if w.app.is_empty() { String::new() } else { format!(" app=\"{}\"", attr(&w.app)) };
        out.push_str(&format!("<window title=\"{}\"{app}>\n", attr(&w.title)));
        if with_paths && !w.document.is_empty() {
            out.push_str(&format!("(The document this window shows is on disk: {} — read it from there for the whole of it.)\n", w.document));
        }
        if w.text.trim().is_empty() {
            out.push_str("(No text could be read from this window.)\n");
        } else {
            out.push_str(w.text.trim());
            out.push('\n');
            if w.cut {
                out.push_str("(Cut: the window shows more than this.)\n");
            }
        }
        out.push_str("</window>\n");
    }
    out
}

/// The shared tabs as the model reads them.
pub fn tabs_text(list: &[BrowserTab]) -> String {
    if list.is_empty() {
        return String::new();
    }
    let mut out = String::from("Browser tabs the user shared just now, with their pages' text:\n");
    for tab in list {
        let active = if tab.active { " active=\"true\"" } else { "" };
        out.push_str(&format!(
            "<tab browser=\"{}\" title=\"{}\" url=\"{}\"{active}>\n",
            attr(&tab.browser),
            attr(&tab.title),
            attr(&tab.url)
        ));
        match (tab.text.trim().is_empty(), tab.source.as_str()) {
            (true, _) => out.push_str("(Only its title and address: its page could not be read.)\n"),
            (false, src) => {
                if src == "web" {
                    out.push_str("(Downloaded from its address without the user's login: a page behind a login may differ from what they see.)\n");
                }
                out.push_str(tab.text.trim());
                out.push('\n');
                if tab.cut {
                    out.push_str("(Cut: the page has more than this.)\n");
                }
            }
        }
        out.push_str("</tab>\n");
    }
    out
}

/// A value inside double quotes, on one line.
fn attr(s: &str) -> String {
    clip_title(s).replace('"', "'")
}

/// The text of a downloaded page: the body without its scripts, styles and
/// tags (mail.rs reads HTML the same way); plain text as it is.
pub fn page_text(body: &[u8], content_type: &str) -> String {
    let text = String::from_utf8_lossy(body);
    let ct = content_type.to_ascii_lowercase();
    if ct.contains("html") || (ct.is_empty() && text.trim_start().starts_with('<')) {
        // `<noscript>` and inline SVG are noise for the reader.
        let lower = text.to_ascii_lowercase();
        let mut kept = String::with_capacity(text.len());
        let mut i = 0;
        while i < text.len() {
            let next = ["<noscript", "<svg", "<template"]
                .iter()
                .filter_map(|tag| lower[i..].find(tag).map(|at| (i + at, *tag)))
                .min_by_key(|(at, _)| *at);
            let Some((at, tag)) = next else {
                kept.push_str(&text[i..]);
                break;
            };
            kept.push_str(&text[i..at]);
            let close = format!("</{}>", &tag[1..]);
            i = lower[at..].find(&close).map(|e| at + e + close.len()).unwrap_or(text.len());
        }
        return crate::mail::strip_html(&kept);
    }
    if ct.starts_with("text/") || ct.contains("json") || ct.contains("xml") || ct.is_empty() {
        return text.to_string();
    }
    String::new()
}

// ── Edge's and Chrome's session files ───────────────────────────────────────
//
// "SNSS", a version, then commands: a 16-bit size, an 8-bit id and its data.
// Replayed in order they give the windows, their tabs and each tab's pages
// (components/sessions, session_service_commands.cc).

/// A tab as its session file says, before it is a `BrowserTab`.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionTab {
    pub tab: i32,
    pub url: String,
    pub title: String,
    pub selected: bool,
    pub window: i32,
}

#[derive(Default)]
struct TabState {
    window: Option<i32>,
    index: Option<i32>,
    navs: BTreeMap<i32, (String, String)>,
    current: Option<i32>,
    order: usize,
    closed: bool,
}

#[derive(Default)]
struct WindowState {
    selected: Option<i32>,
    kind: i32,
    order: usize,
    closed: bool,
}

const SET_TAB_WINDOW: u8 = 0;
const SET_TAB_INDEX_IN_WINDOW: u8 = 2;
const PRUNED_FROM_BACK: u8 = 5;
const UPDATE_TAB_NAVIGATION: u8 = 6;
const SET_SELECTED_NAVIGATION_INDEX: u8 = 7;
const SET_SELECTED_TAB_IN_INDEX: u8 = 8;
const SET_WINDOW_TYPE: u8 = 9;
const PRUNED_FROM_FRONT: u8 = 11;
const TAB_CLOSED: u8 = 16;
const WINDOW_CLOSED: u8 = 17;
const PRUNED: u8 = 24;
/// The developer tools' own windows.
const WINDOW_TYPE_DEVTOOLS: i32 = 3;

fn i32_at(data: &[u8], at: usize) -> Option<i32> {
    data.get(at..at + 4).map(|b| i32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// Reads a `base::Pickle`: its 4-byte header, then 4-byte aligned fields.
struct Pickle<'a> {
    data: &'a [u8],
    at: usize,
}

impl<'a> Pickle<'a> {
    fn new(data: &'a [u8]) -> Self {
        Pickle { data, at: 4 }
    }

    fn int(&mut self) -> Option<i32> {
        let v = i32_at(self.data, self.at)?;
        self.at += 4;
        Some(v)
    }

    fn bytes(&mut self, len: usize) -> Option<&'a [u8]> {
        let out = self.data.get(self.at..self.at.checked_add(len)?)?;
        self.at += len.div_ceil(4) * 4;
        Some(out)
    }

    fn string(&mut self) -> Option<String> {
        let len = usize::try_from(self.int()?).ok()?;
        Some(String::from_utf8_lossy(self.bytes(len)?).to_string())
    }

    fn string16(&mut self) -> Option<String> {
        let len = usize::try_from(self.int()?).ok()?;
        let raw = self.bytes(len.checked_mul(2)?)?;
        let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        Some(String::from_utf16_lossy(&units))
    }
}

/// Pages nobody means when they speak of their tabs.
fn is_blank_page(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    u.is_empty()
        || u == "about:blank"
        || u.starts_with("chrome://newtab")
        || u.starts_with("edge://newtab")
        || u.starts_with("chrome-search://")
        || u.starts_with("chrome://new-tab-page")
}

fn tab_entry<'a>(tabs: &'a mut HashMap<i32, TabState>, seen: &mut usize, id: i32) -> &'a mut TabState {
    *seen += 1;
    let order = *seen;
    tabs.entry(id).or_insert_with(|| TabState { order, ..Default::default() })
}

fn window_entry(windows: &mut HashMap<i32, WindowState>, id: i32) -> &mut WindowState {
    let order = windows.len();
    windows.entry(id).or_insert_with(|| WindowState { order, ..Default::default() })
}

/// The open tabs a session file describes, window by window, in tab order.
/// An encrypted or unknown file gives none.
pub fn parse_session(bytes: &[u8]) -> Vec<SessionTab> {
    if bytes.len() < 8 || &bytes[..4] != b"SNSS" || !matches!(i32_at(bytes, 4), Some(1) | Some(3)) {
        return Vec::new();
    }
    let mut tabs: HashMap<i32, TabState> = HashMap::new();
    let mut windows: HashMap<i32, WindowState> = HashMap::new();
    let mut seen = 0usize;
    let mut at = 8;
    while at + 2 <= bytes.len() {
        let size = u16::from_le_bytes([bytes[at], bytes[at + 1]]) as usize;
        at += 2;
        if size == 0 || at + size > bytes.len() {
            break;
        }
        let id = bytes[at];
        let data = &bytes[at + 1..at + size];
        at += size;
        let pair = || Some((i32_at(data, 0)?, i32_at(data, 4)?));
        match id {
            SET_TAB_WINDOW => {
                if let Some((window, tab)) = pair() {
                    tab_entry(&mut tabs, &mut seen, tab).window = Some(window);
                    window_entry(&mut windows, window);
                }
            }
            SET_TAB_INDEX_IN_WINDOW => {
                if let Some((tab, index)) = pair() {
                    tab_entry(&mut tabs, &mut seen, tab).index = Some(index);
                }
            }
            PRUNED_FROM_BACK => {
                if let Some((tab, index)) = pair() {
                    tab_entry(&mut tabs, &mut seen, tab).navs.retain(|&i, _| i < index);
                }
            }
            UPDATE_TAB_NAVIGATION => {
                let mut p = Pickle::new(data);
                let parsed = (|| Some((p.int()?, p.int()?, p.string()?, p.string16()?)))();
                if let Some((tab, index, url, title)) = parsed {
                    tab_entry(&mut tabs, &mut seen, tab).navs.insert(index, (url, title));
                }
            }
            SET_SELECTED_NAVIGATION_INDEX => {
                if let Some((tab, index)) = pair() {
                    tab_entry(&mut tabs, &mut seen, tab).current = Some(index);
                }
            }
            SET_SELECTED_TAB_IN_INDEX => {
                if let Some((window, index)) = pair() {
                    window_entry(&mut windows, window).selected = Some(index);
                }
            }
            SET_WINDOW_TYPE => {
                if let Some((window, kind)) = pair() {
                    window_entry(&mut windows, window).kind = kind;
                }
            }
            PRUNED_FROM_FRONT => {
                if let Some((tab, count)) = pair() {
                    let t = tab_entry(&mut tabs, &mut seen, tab);
                    t.navs = t.navs.iter().filter(|(&i, _)| i >= count).map(|(&i, v)| (i - count, v.clone())).collect();
                    t.current = t.current.map(|c| (c - count).max(0));
                }
            }
            PRUNED => {
                if let (Some((tab, index)), Some(count)) = (pair(), i32_at(data, 8)) {
                    let t = tab_entry(&mut tabs, &mut seen, tab);
                    t.navs = t
                        .navs
                        .iter()
                        .filter(|(&i, _)| i < index || i >= index + count)
                        .map(|(&i, v)| (if i >= index + count { i - count } else { i }, v.clone()))
                        .collect();
                    t.current = t.current.map(|c| {
                        if c >= index + count {
                            c - count
                        } else if c >= index {
                            (index - 1).max(0)
                        } else {
                            c
                        }
                    });
                }
            }
            TAB_CLOSED => {
                if let Some(tab) = i32_at(data, 0) {
                    tab_entry(&mut tabs, &mut seen, tab).closed = true;
                }
            }
            WINDOW_CLOSED => {
                if let Some(window) = i32_at(data, 0) {
                    window_entry(&mut windows, window).closed = true;
                }
            }
            _ => {}
        }
    }

    let mut out: Vec<(usize, i32, usize, SessionTab)> = Vec::new();
    for (&id, tab) in &tabs {
        let Some(window) = tab.window else { continue };
        let Some(w) = windows.get(&window) else { continue };
        if tab.closed || w.closed || w.kind == WINDOW_TYPE_DEVTOOLS {
            continue;
        }
        let nav = tab
            .current
            .and_then(|c| tab.navs.get(&c))
            .or_else(|| tab.navs.values().next_back());
        let Some((url, title)) = nav else { continue };
        if is_blank_page(url) {
            continue;
        }
        let index = tab.index.unwrap_or(i32::MAX);
        out.push((
            w.order,
            index,
            tab.order,
            SessionTab {
                tab: id,
                url: url.clone(),
                title: if title.trim().is_empty() { url.clone() } else { title.clone() },
                selected: tab.index.is_some() && tab.index == w.selected,
                window,
            },
        ));
    }
    out.sort_by_key(|(w, i, o, _)| (*w, *i, *o));
    out.into_iter().map(|(_, _, _, t)| t).collect()
}

/// A browser's folder of profiles, and how its windows are named.
struct Browser {
    name: &'static str,
    /// The executable, as screen.rs names a window's app.
    exe: &'static str,
    /// The profiles' folder, under %LOCALAPPDATA% on Windows, ~/.config on Linux.
    dir: &'static str,
}

#[cfg(windows)]
const BROWSERS: &[Browser] = &[
    Browser { name: "Edge", exe: "msedge", dir: "Microsoft\\Edge\\User Data" },
    Browser { name: "Chrome", exe: "chrome", dir: "Google\\Chrome\\User Data" },
];

#[cfg(not(windows))]
const BROWSERS: &[Browser] = &[
    Browser { name: "Edge", exe: "msedge", dir: "microsoft-edge" },
    Browser { name: "Chrome", exe: "chrome", dir: "google-chrome" },
    Browser { name: "Chromium", exe: "chromium", dir: "chromium" },
];

fn profiles_root(browser: &Browser) -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from)?;
    #[cfg(not(windows))]
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| crate::platform::home_dir().join(".config"));
    let root = base.join(browser.dir);
    root.is_dir().then_some(root)
}

/// The profiles open now, from "Local State"; every profile when it does not say.
fn open_profiles(root: &Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(root.join("Local State")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let list: Vec<String> = v
        .pointer("/profile/last_active_profiles")?
        .as_array()?
        .iter()
        .filter_map(|p| p.as_str().map(str::to_string))
        .collect();
    (!list.is_empty()).then_some(list)
}

/// The newest session file of a profile.
fn session_file(profile: &Path) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    let mut consider = |path: PathBuf| {
        let Ok(modified) = std::fs::metadata(&path).and_then(|m| m.modified()) else { return };
        if best.as_ref().is_none_or(|(at, _)| modified > *at) {
            best = Some((modified, path));
        }
    };
    if let Ok(dir) = std::fs::read_dir(profile.join("Sessions")) {
        for entry in dir.flatten() {
            if entry.file_name().to_string_lossy().starts_with("Session_") {
                consider(entry.path());
            }
        }
    }
    consider(profile.join("Current Session"));
    best.map(|(_, p)| p)
}

/// The browser has a window open (Windows), or holds its profile lock (Linux).
fn is_running(browser: &Browser, root: &Path, apps: &HashSet<String>) -> bool {
    if cfg!(windows) {
        apps.contains(browser.exe)
    } else {
        let _ = apps;
        root.join("SingletonLock").symlink_metadata().is_ok()
    }
}

/// Every tab open in Edge and Chrome, browser by browser. Blocking.
pub fn tabs() -> Result<Vec<BrowserTab>, String> {
    let apps: HashSet<String> = if cfg!(windows) {
        crate::screen::windows().unwrap_or_default().into_iter().map(|w| w.app.to_ascii_lowercase()).collect()
    } else {
        HashSet::new()
    };
    let mut out = Vec::new();
    for browser in BROWSERS {
        let Some(root) = profiles_root(browser) else { continue };
        if !is_running(browser, &root, &apps) {
            continue;
        }
        let wanted = open_profiles(&root);
        let Ok(entries) = std::fs::read_dir(&root) else { continue };
        let mut profiles: Vec<String> = entries
            .flatten()
            .filter(|e| e.path().join("Sessions").is_dir() || e.path().join("Current Session").is_file())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|name| wanted.as_ref().is_none_or(|w| w.contains(name)))
            .collect();
        profiles.sort();
        for profile in profiles {
            let Some(file) = session_file(&root.join(&profile)) else { continue };
            let Ok(bytes) = std::fs::read(&file) else { continue };
            for tab in parse_session(&bytes) {
                out.push(BrowserTab {
                    id: format!("{}|{profile}|{}", browser.name, tab.tab),
                    browser: browser.name.to_string(),
                    title: clip_title(&tab.title),
                    url: tab.url,
                    active: tab.selected,
                    ..Default::default()
                });
            }
        }
    }
    *LISTED_TABS.lock().unwrap_or_else(|e| e.into_inner()) = out.clone();
    Ok(out)
}

/// The windows, as screen.rs lists them, remembered so the page can pick among them. Blocking.
pub fn windows() -> Result<Vec<WindowInfo>, String> {
    let list = crate::screen::windows()?;
    *LISTED_WINDOWS.lock().unwrap_or_else(|e| e.into_inner()) = list.iter().map(|w| (w.id, w.clone())).collect();
    Ok(list)
}

// ── Reading them ────────────────────────────────────────────────────────────

/// The windows the page picked (by id, from the last list; all of them when
/// `ids` is empty), each with its text and its document. Blocking.
pub fn read_windows(ids: &[i64]) -> Result<Vec<SharedWindow>, String> {
    let listed = LISTED_WINDOWS.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let picked: Vec<(i64, WindowInfo)> = if ids.is_empty() {
        listed
    } else {
        ids.iter().filter_map(|id| listed.iter().find(|(i, _)| i == id).cloned()).collect()
    };
    if picked.is_empty() {
        return Err(t("That window isn't open anymore."));
    }
    let each = share_of_budget(picked.len());
    let reader = imp::Reader::new();
    let mut out = Vec::new();
    for (id, info) in &picked {
        let raw = reader.as_ref().map(|r| r.window_text(*id, each + 1)).unwrap_or_default();
        let (text, cut) = tidy_text(&raw, each);
        let document = crate::desk::documents(std::slice::from_ref(info))
            .into_iter()
            .next()
            .map(|d| d.path)
            .unwrap_or_default();
        if !document.is_empty() {
            remember_document(&document);
        }
        out.push(SharedWindow { title: info.title.clone(), app: info.app.clone(), text, cut, document });
    }
    Ok(out)
}

/// The text of a tab on screen, read from its browser's window (Windows).
fn read_on_screen(tab: &BrowserTab, max: usize) -> String {
    if !cfg!(windows) || !tab.active {
        return String::new();
    }
    let exe = BROWSERS.iter().find(|b| b.name == tab.browser).map(|b| b.exe).unwrap_or_default();
    let title = tab.title.trim();
    if title.is_empty() {
        return String::new();
    }
    // Its window's title starts with the tab's: "GitHub - Google Chrome",
    // "GitHub and 3 more pages - Personal - Microsoft Edge".
    let Ok(windows) = crate::screen::windows() else { return String::new() };
    let Some(window) = windows.iter().find(|w| w.app.eq_ignore_ascii_case(exe) && w.title.starts_with(title)) else {
        return String::new();
    };
    imp::Reader::new().map(|r| r.window_text(window.id, max)).unwrap_or_default()
}

/// A tab's page, downloaded from its address (http and https only).
async fn download(url: &str, max: usize) -> String {
    let Ok(parsed) = reqwest::Url::parse(url) else { return String::new() };
    if !matches!(parsed.scheme(), "http" | "https") {
        return String::new();
    }
    let Ok(client) = crate::net::client(&parsed, PAGE_TIMEOUT) else { return String::new() };
    let response = client
        .get(parsed.clone())
        .header(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        )
        .header("Accept", "text/html,text/plain;q=0.9,*/*;q=0.5")
        .send()
        .await;
    let Ok(response) = response else {
        crate::log::line(format!("[tabs] {} unreachable", crate::net::host_for_log(&parsed)));
        return String::new();
    };
    if !response.status().is_success() {
        crate::log::line(format!("[tabs] {} answered {}", crate::net::host_for_log(&parsed), response.status().as_u16()));
        return String::new();
    }
    let content_type =
        response.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    let Ok(body) = crate::net::read_capped(response, MAX_PAGE_BYTES).await else { return String::new() };
    page_text(&body, &content_type).chars().take(max * 3).collect()
}

/// The tabs the page picked (by id, from the last list; all of them when
/// `ids` is empty), each with its page's text.
pub async fn read_tabs(ids: Vec<String>) -> Result<Vec<BrowserTab>, String> {
    let listed = LISTED_TABS.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let mut picked: Vec<BrowserTab> = if ids.is_empty() {
        listed
    } else {
        ids.iter().filter_map(|id| listed.iter().find(|t| &t.id == id).cloned()).collect()
    };
    if picked.is_empty() {
        return Err(t("That tab isn't open anymore."));
    }
    let each = share_of_budget(picked.len().min(MAX_TABS_READ));
    // The tabs on screen first: they are read from the browser itself.
    let mut order: Vec<usize> = (0..picked.len()).collect();
    order.sort_by_key(|&i| !picked[i].active);
    for (n, i) in order.into_iter().enumerate() {
        if n >= MAX_TABS_READ {
            break;
        }
        let tab = picked[i].clone();
        let on_screen = tauri::async_runtime::spawn_blocking(move || read_on_screen(&tab, each + 1)).await.unwrap_or_default();
        let (raw, source) = if on_screen.trim().is_empty() {
            (download(&picked[i].url, each + 1).await, "web")
        } else {
            (on_screen, "page")
        };
        let (text, cut) = tidy_text(&raw, each);
        let tab = &mut picked[i];
        tab.source = if text.is_empty() { String::new() } else { source.to_string() };
        tab.text = text;
        tab.cut = cut;
    }
    Ok(picked)
}

/// A screenshot of one listed window, for the providers that see images. Blocking.
pub fn window_shot(id: i64) -> Result<crate::screen::Shot, String> {
    let listed = LISTED_WINDOWS.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let Some((_, info)) = listed.into_iter().find(|(i, _)| *i == id) else {
        return Err(t("That window isn't open anymore."));
    };
    if info.minimized {
        return Err(t("That window is minimized."));
    }
    crate::screen::capture_window(id)
}

// ── UI Automation ───────────────────────────────────────────────────────────

#[cfg(not(windows))]
mod imp {
    /// No UI Automation on Linux: windows give their titles only.
    pub struct Reader;

    impl Reader {
        pub fn new() -> Option<Reader> {
            None
        }

        pub fn window_text(&self, _id: i64, _max: usize) -> String {
            String::new()
        }
    }
}

#[cfg(windows)]
mod imp {
    use ::windows::core::Interface;
    use ::windows::Win32::Foundation::HWND;
    use ::windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use ::windows::Win32::System::Variant::VARIANT;
    use ::windows::Win32::UI::Accessibility::{
        CUIAutomation, CUIAutomation8, IUIAutomation, IUIAutomation2, IUIAutomationCondition, IUIAutomationElement,
        IUIAutomationTextPattern, TreeScope_Descendants, TreeScope_Subtree, UIA_CONTROLTYPE_ID, UIA_ControlTypePropertyId,
        UIA_DataItemControlTypeId, UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_HeaderItemControlTypeId,
        UIA_HyperlinkControlTypeId, UIA_IsTextPatternAvailablePropertyId, UIA_ListItemControlTypeId, UIA_NamePropertyId,
        UIA_TextControlTypeId, UIA_TextPatternId, UIA_TreeItemControlTypeId, UIA_ValueValuePropertyId,
    };

    /// Elements read at most when a window has no document to read whole.
    const MAX_ELEMENTS: i32 = 3000;

    /// UI Automation on this thread, for as long as it is needed.
    pub struct Reader {
        automation: Option<IUIAutomation>,
        com: bool,
    }

    impl Drop for Reader {
        fn drop(&mut self) {
            // Released before COM goes.
            self.automation = None;
            if self.com {
                unsafe { CoUninitialize() };
            }
        }
    }

    impl Reader {
        pub fn new() -> Option<Reader> {
            // S_FALSE (already on) counts; another model on this thread is fine too.
            let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
            let made: ::windows::core::Result<IUIAutomation> = unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }
                .or_else(|_| unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) });
            let reader = Reader { automation: made.ok(), com };
            let automation = reader.automation.as_ref()?;
            // An app that hangs never holds the chat for long.
            if let Ok(a2) = automation.cast::<IUIAutomation2>() {
                unsafe {
                    let _ = a2.SetConnectionTimeout(2_000);
                    let _ = a2.SetTransactionTimeout(4_000);
                }
            }
            Some(reader)
        }

        /// What window `id` shows, as text: a document's whole text when it
        /// has one (a page, Word, Notepad), else the names and values of what
        /// it lists, in order. Empty when it gives nothing.
        pub fn window_text(&self, id: i64, max: usize) -> String {
            let text = self.read(id, max);
            if !text.trim().is_empty() {
                return text;
            }
            // Chromium apps turn their accessibility on when first asked: once more, shortly after.
            std::thread::sleep(std::time::Duration::from_millis(450));
            self.read(id, max)
        }

        fn read(&self, id: i64, max: usize) -> String {
            let Some(automation) = &self.automation else { return String::new() };
            let hwnd = HWND(id as isize as *mut _);
            let Ok(root) = (unsafe { automation.ElementFromHandle(hwnd) }) else { return String::new() };
            let doc = self.document_text(automation, &root, max);
            if !doc.trim().is_empty() {
                return doc;
            }
            self.listed_text(automation, &root, max)
        }

        fn type_is(&self, automation: &IUIAutomation, kind: UIA_CONTROLTYPE_ID) -> Option<IUIAutomationCondition> {
            unsafe { automation.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(kind.0)) }.ok()
        }

        /// The whole text of the first document in the window (else of the
        /// first element that has a text to read whole).
        fn document_text(&self, automation: &IUIAutomation, root: &IUIAutomationElement, max: usize) -> String {
            let Ok(has_text) =
                (unsafe { automation.CreatePropertyCondition(UIA_IsTextPatternAvailablePropertyId, &VARIANT::from(true)) })
            else {
                return String::new();
            };
            let document = self
                .type_is(automation, UIA_DocumentControlTypeId)
                .and_then(|is_doc| unsafe { automation.CreateAndCondition(&is_doc, &has_text) }.ok());
            let mut tries: Vec<IUIAutomationCondition> = Vec::new();
            if let Some(d) = document {
                tries.push(d);
            }
            tries.push(has_text);
            for condition in tries {
                let Ok(element) = (unsafe { root.FindFirst(TreeScope_Subtree, &condition) }) else { continue };
                let text = unsafe {
                    element
                        .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                        .and_then(|p| p.DocumentRange())
                        .and_then(|r| r.GetText(max.min(i32::MAX as usize) as i32))
                        .map(|b| b.to_string())
                        .unwrap_or_default()
                };
                if !text.trim().is_empty() {
                    return text;
                }
            }
            String::new()
        }

        /// The names (and the values of fields) of the texts, links, list and
        /// tree items the window shows, in order, each once in a row.
        fn listed_text(&self, automation: &IUIAutomation, root: &IUIAutomationElement, max: usize) -> String {
            let kinds = [
                UIA_TextControlTypeId,
                UIA_HyperlinkControlTypeId,
                UIA_ListItemControlTypeId,
                UIA_TreeItemControlTypeId,
                UIA_DataItemControlTypeId,
                UIA_HeaderItemControlTypeId,
                UIA_EditControlTypeId,
            ];
            let conditions: Vec<Option<IUIAutomationCondition>> =
                kinds.iter().map(|k| self.type_is(automation, *k)).filter(Option::is_some).collect();
            let Ok(any) = (unsafe { automation.CreateOrConditionFromNativeArray(&conditions) }) else { return String::new() };
            let Ok(cache) = (unsafe { automation.CreateCacheRequest() }) else { return String::new() };
            unsafe {
                let _ = cache.AddProperty(UIA_NamePropertyId);
                let _ = cache.AddProperty(UIA_ControlTypePropertyId);
                let _ = cache.AddProperty(UIA_ValueValuePropertyId);
            }
            let Ok(found) = (unsafe { root.FindAllBuildCache(TreeScope_Descendants, &any, &cache) }) else { return String::new() };
            let count = unsafe { found.Length() }.unwrap_or(0).min(MAX_ELEMENTS);
            let mut out = String::new();
            let mut last = String::new();
            for i in 0..count {
                let Ok(el) = (unsafe { found.GetElement(i) }) else { continue };
                let name = unsafe { el.CachedName() }.map(|b| b.to_string()).unwrap_or_default();
                let kind = unsafe { el.CachedControlType() }.unwrap_or_default();
                let value = if kind == UIA_EditControlTypeId {
                    unsafe { el.GetCachedPropertyValue(UIA_ValueValuePropertyId) }
                        .ok()
                        .and_then(|v| ::windows::core::BSTR::try_from(&v).ok())
                        .map(|b| b.to_string())
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                let line = match (name.trim(), value.trim()) {
                    ("", "") => continue,
                    (n, "") => n.to_string(),
                    ("", v) => v.to_string(),
                    (n, v) => format!("{n}: {v}"),
                };
                if line == last {
                    continue;
                }
                out.push_str(&line);
                out.push('\n');
                last = line;
                if out.len() > max * 4 {
                    break;
                }
            }
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One command of a session file.
    fn command(id: u8, data: &[u8]) -> Vec<u8> {
        let mut out = ((data.len() + 1) as u16).to_le_bytes().to_vec();
        out.push(id);
        out.extend_from_slice(data);
        out
    }

    fn ints(values: &[i32]) -> Vec<u8> {
        values.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    /// An UpdateTabNavigation pickle: header, tab, index, url, title (UTF-16).
    fn navigation(tab: i32, index: i32, url: &str, title: &str) -> Vec<u8> {
        let mut body = ints(&[tab, index]);
        body.extend_from_slice(&(url.len() as i32).to_le_bytes());
        body.extend_from_slice(url.as_bytes());
        while body.len() % 4 != 0 {
            body.push(0);
        }
        let units: Vec<u16> = title.encode_utf16().collect();
        body.extend_from_slice(&(units.len() as i32).to_le_bytes());
        for u in &units {
            body.extend_from_slice(&u.to_le_bytes());
        }
        while body.len() % 4 != 0 {
            body.push(0);
        }
        // What follows the title in a real file (page state, transition…) is ignored.
        body.extend_from_slice(&ints(&[0, 0]));
        let mut out = (body.len() as u32).to_le_bytes().to_vec();
        out.extend_from_slice(&body);
        out
    }

    fn file(commands: &[Vec<u8>]) -> Vec<u8> {
        let mut out = b"SNSS".to_vec();
        out.extend_from_slice(&3i32.to_le_bytes());
        for c in commands {
            out.extend_from_slice(c);
        }
        out
    }

    #[test]
    fn a_session_file_gives_its_open_tabs_in_order_with_the_page_on_screen() {
        let bytes = file(&[
            command(SET_TAB_WINDOW, &ints(&[1, 10])),
            command(SET_TAB_WINDOW, &ints(&[1, 11])),
            command(SET_TAB_WINDOW, &ints(&[1, 12])),
            command(SET_TAB_INDEX_IN_WINDOW, &ints(&[10, 1])),
            command(SET_TAB_INDEX_IN_WINDOW, &ints(&[11, 0])),
            command(SET_TAB_INDEX_IN_WINDOW, &ints(&[12, 2])),
            command(UPDATE_TAB_NAVIGATION, &navigation(10, 0, "https://github.com/", "GitHub")),
            command(UPDATE_TAB_NAVIGATION, &navigation(10, 1, "https://github.com/Rccrd12/Lumo", "Rccrd12/Lumo")),
            command(SET_SELECTED_NAVIGATION_INDEX, &ints(&[10, 1])),
            command(UPDATE_TAB_NAVIGATION, &navigation(11, 0, "https://it.wikipedia.org/wiki/Luce", "Luce – Wikipedia")),
            command(UPDATE_TAB_NAVIGATION, &navigation(12, 0, "chrome://newtab/", "Nuova scheda")),
            command(SET_SELECTED_TAB_IN_INDEX, &ints(&[1, 1])),
            // A marker, and a command this reader does not know: both skipped.
            command(255, &[]),
            command(200, &ints(&[7])),
        ]);
        let tabs = parse_session(&bytes);
        assert_eq!(
            tabs.iter().map(|t| (t.title.as_str(), t.url.as_str(), t.selected)).collect::<Vec<_>>(),
            [
                ("Luce – Wikipedia", "https://it.wikipedia.org/wiki/Luce", false),
                ("Rccrd12/Lumo", "https://github.com/Rccrd12/Lumo", true),
            ],
            "in tab order, the page each tab is on, no new tab page"
        );
    }

    #[test]
    fn closed_tabs_windows_and_devtools_are_left_out() {
        let bytes = file(&[
            command(SET_TAB_WINDOW, &ints(&[1, 10])),
            command(SET_TAB_WINDOW, &ints(&[2, 20])),
            command(SET_TAB_WINDOW, &ints(&[3, 30])),
            command(SET_TAB_WINDOW, &ints(&[1, 11])),
            command(UPDATE_TAB_NAVIGATION, &navigation(10, 0, "https://a.example/", "A")),
            command(UPDATE_TAB_NAVIGATION, &navigation(11, 0, "https://b.example/", "B")),
            command(UPDATE_TAB_NAVIGATION, &navigation(20, 0, "https://c.example/", "C")),
            command(UPDATE_TAB_NAVIGATION, &navigation(30, 0, "devtools://devtools/", "DevTools")),
            command(SET_WINDOW_TYPE, &ints(&[3, WINDOW_TYPE_DEVTOOLS])),
            command(TAB_CLOSED, &ints(&[11, 0, 0, 0])),
            command(WINDOW_CLOSED, &ints(&[2, 0, 0, 0])),
        ]);
        let tabs = parse_session(&bytes);
        assert_eq!(tabs.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), ["A"]);
    }

    #[test]
    fn pruned_history_keeps_the_page_on_screen() {
        let bytes = file(&[
            command(SET_TAB_WINDOW, &ints(&[1, 10])),
            command(UPDATE_TAB_NAVIGATION, &navigation(10, 0, "https://old.example/", "Old")),
            command(UPDATE_TAB_NAVIGATION, &navigation(10, 1, "https://mid.example/", "Mid")),
            command(UPDATE_TAB_NAVIGATION, &navigation(10, 2, "https://now.example/", "Now")),
            command(SET_SELECTED_NAVIGATION_INDEX, &ints(&[10, 2])),
            command(PRUNED_FROM_FRONT, &ints(&[10, 1])),
        ]);
        assert_eq!(parse_session(&bytes)[0].title, "Now");
        let bytes = file(&[
            command(SET_TAB_WINDOW, &ints(&[1, 10])),
            command(UPDATE_TAB_NAVIGATION, &navigation(10, 0, "https://a.example/", "A")),
            command(UPDATE_TAB_NAVIGATION, &navigation(10, 1, "https://b.example/", "B")),
            command(PRUNED_FROM_BACK, &ints(&[10, 1])),
        ]);
        assert_eq!(parse_session(&bytes)[0].title, "A", "no selected page: the last one left");
    }

    #[test]
    fn an_encrypted_truncated_or_foreign_file_gives_nothing() {
        let mut encrypted = b"SNSS".to_vec();
        encrypted.extend_from_slice(&4i32.to_le_bytes());
        assert!(parse_session(&encrypted).is_empty());
        assert!(parse_session(b"PNG\x89").is_empty());
        assert!(parse_session(b"").is_empty());
        let mut cut = file(&[command(SET_TAB_WINDOW, &ints(&[1, 10])), command(UPDATE_TAB_NAVIGATION, &navigation(10, 0, "https://a.example/", "A"))]);
        cut.truncate(cut.len() - 5);
        assert!(parse_session(&cut).is_empty(), "the half-written command is not read");
        // A title with no text shows its address.
        let untitled = file(&[command(SET_TAB_WINDOW, &ints(&[1, 10])), command(UPDATE_TAB_NAVIGATION, &navigation(10, 0, "https://a.example/x", ""))]);
        assert_eq!(parse_session(&untitled)[0].title, "https://a.example/x");
    }

    #[test]
    fn text_is_tidied_and_cut_at_a_word() {
        assert_eq!(tidy_text("  a   b \n\n\n  c\n", 100), ("a b\n\nc".to_string(), false));
        let (cut, was) = tidy_text("one two three four five six", 12);
        assert!(was);
        assert_eq!(cut, "one two […]");
        assert_eq!(share_of_budget(1), MAX_ONE);
        assert_eq!(share_of_budget(1000), MIN_ONE);
        assert_eq!(share_of_budget(6), TEXT_BUDGET / 6);
    }

    #[test]
    fn a_page_is_read_without_its_scripts_and_markup() {
        let html = b"<html><head><title>T</title><style>p{}</style></head><body><script>var x=1</script><noscript>Enable JS</noscript><h1>Luce</h1><p>La luce &egrave; <b>bella</b>.</p><svg><text>icon</text></svg></body></html>";
        let text = page_text(html, "text/html; charset=utf-8");
        let (text, _) = tidy_text(&text, 1000);
        assert_eq!(text, "Luce\nLa luce è bella.");
        assert_eq!(page_text(b"plain words", "text/plain"), "plain words");
        assert_eq!(page_text(b"%PDF-1.7", "application/pdf"), "", "not text: nothing");
    }

    #[test]
    fn windows_and_tabs_read_as_blocks_with_what_they_show() {
        let w = SharedWindow {
            title: "Report.pdf - Adobe Acrobat".into(),
            app: "Acrobat".into(),
            text: "Page 1\nTotal: 42".into(),
            cut: true,
            document: "C:\\docs\\Report.pdf".into(),
        };
        let cli = windows_text(std::slice::from_ref(&w), true);
        assert!(cli.starts_with("Windows the user shared just now"));
        assert!(cli.contains("<window title=\"Report.pdf - Adobe Acrobat\" app=\"Acrobat\">\n(The document this window shows is on disk: C:\\docs\\Report.pdf"));
        assert!(cli.contains("Page 1\nTotal: 42\n(Cut: the window shows more than this.)\n</window>"));
        assert!(!windows_text(std::slice::from_ref(&w), false).contains("C:\\docs"), "a path only for who reads it");
        let empty = SharedWindow { title: "Game".into(), ..Default::default() };
        assert!(windows_text(&[empty], false).contains("(No text could be read from this window.)"));
        assert_eq!(windows_text(&[], true), "");

        let tab = |text: &str, source: &str| BrowserTab {
            id: "Edge|Default|1".into(),
            browser: "Edge".into(),
            title: "Say \"hi\"".into(),
            url: "https://example.com/".into(),
            active: true,
            text: text.into(),
            source: source.into(),
            ..Default::default()
        };
        let text = tabs_text(&[tab("Hello", "page")]);
        assert!(text.contains("<tab browser=\"Edge\" title=\"Say 'hi'\" url=\"https://example.com/\" active=\"true\">\nHello\n</tab>"));
        assert!(tabs_text(&[tab("Hello", "web")]).contains("without the user's login"));
        assert!(tabs_text(&[tab("", "")]).contains("(Only its title and address"));
        assert_eq!(tabs_text(&[]), "");
    }

    #[test]
    fn only_what_was_listed_can_be_read() {
        LISTED_WINDOWS.lock().unwrap().clear();
        assert!(read_windows(&[42]).is_err());
        assert!(!was_found("C:\\made\\up.pdf"));
        remember_document("C:\\docs\\a.pdf");
        assert!(was_found("C:\\docs\\a.pdf"));
    }
}
