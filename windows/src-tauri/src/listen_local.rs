// Listening on this PC (listen.rs keeps the watches and fires them): a file
// or a folder, a program or a port, a web page, Windows itself (its
// notifications, the battery, the network, a USB drive, the user coming
// back), one of the user's own tools. Lumo looks at them itself, a little
// while apart, and only while something listens to them: a folder's listing
// every few seconds, the running programs once for all the watches on them,
// a page once a minute.
//
// What changed is told against the last look: the first look after a watch
// starts (or after a restart) only remembers how things are. A state (a
// program running, a port open, a page answering) fires when it becomes
// true, and listening once also when it is already true at the first look.
//
// The other sources are heard rather than looked at (listen_events.rs): an
// email, a service's news, an agent's hook, a call to a webhook, an event on
// the calendar. What they name, and how they are told, is here too.

use std::collections::{BTreeMap, HashSet};
use std::net::{SocketAddr, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

/// What a watch on a file or a folder waits for.
pub const FS_UNTILS: &[&str] = &["created", "changed", "deleted", "download"];
/// What a watch on a program (its executable's name) or a port waits for.
pub const PROCESS_UNTILS: &[&str] = &["started", "exited", "port_open", "port_closed"];
/// What a watch on a web page waits for.
pub const WEB_UNTILS: &[&str] = &["changed", "up", "down", "contains"];
/// What a watch on the inbox waits for: any new email, one from someone, one with words in its subject.
pub const EMAIL_UNTILS: &[&str] = &["new", "from", "subject"];
/// What a watch on a service waits for; `soon`: an event on the calendar coming up.
pub const SERVICE_UNTILS: &[&str] = &["event", "succeeded", "failed", "soon"];
/// What a watch on Windows waits for.
pub const WINDOWS_UNTILS: &[&str] = &["notification", "battery_low", "plugged", "unplugged", "offline", "online", "usb", "back"];
/// What a watch on an agent waits for: its turn ends, it asks for a permission or a reply, it fails.
pub const AGENT_UNTILS: &[&str] = &["finished", "permission", "failed"];
/// What a webhook waits for: a call.
pub const WEBHOOK_UNTILS: &[&str] = &["called"];
/// What a watch on one of the user's tools waits for: what it prints changes, or shows a text.
pub const TOOL_UNTILS: &[&str] = &["changed", "contains"];

/// The services a watch can listen to: its name in a watch, as it is shown, its pill.
pub const SERVICES: &[(&str, &str, &str)] = &[
    ("calendar", "Calendar", ""),
    ("vercel", "Vercel", "integration_vercel"),
    ("stripe", "Stripe", "integration_stripe"),
    ("n8n", "n8n", "integration_n8n"),
    ("resend", "Resend", "integration_resend"),
    ("notion", "Notion", "integration_notion"),
    ("calcom", "Cal.com", "integration_calcom"),
];
/// The agents a watch can listen to: their hook tag (`lumo_agent`; Claude Code has none) and name.
pub const AGENTS: &[(&str, &str)] = &[
    ("any", ""),
    ("claude", "Claude Code"),
    ("codex", "Codex"),
    ("gemini", "Gemini CLI"),
    ("antigravity", "Antigravity"),
    ("cursor", "Cursor"),
    ("copilot", "Copilot CLI"),
    ("opencode", "OpenCode"),
    ("amp", "Amp"),
    ("hermes", "Hermes"),
    ("muse", "Muse Code"),
];
/// What a watch on Windows names when it names nothing: this PC.
pub const PC: &str = "pc";
/// A watch on the notifications from any app, or on any agent.
pub const ANY: &str = "any";
/// The minutes before an event, the battery's percent, the minutes away, the
/// minutes between two runs of a tool, when a watch gives none, and the most each can be.
pub fn amount_of(source: &str, until: &str, amount: u32) -> u32 {
    let (default, max) = match (source, until) {
        ("service", "soon") => (10, 24 * 60),
        ("windows", "battery_low") => (20, 99),
        ("windows", "back") => (5, 24 * 60),
        ("tool", _) => (15, 24 * 60),
        _ => return 0,
    };
    if amount == 0 { default } else { amount.min(max) }
}

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
        "email" => EMAIL_UNTILS,
        "service" => SERVICE_UNTILS,
        "windows" => WINDOWS_UNTILS,
        "agent" => AGENT_UNTILS,
        "webhook" => WEBHOOK_UNTILS,
        "tool" => TOOL_UNTILS,
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

/// A service or an agent by its name in a watch, whatever way it was written ("Cal.com", "Claude Code").
pub fn canonical(source: &str, target: &str) -> String {
    let squash = |s: &str| s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect::<String>();
    let given = squash(target);
    let named = |key: &str, name: &str| squash(key) == given || (!name.is_empty() && squash(name) == given);
    match source {
        "service" => SERVICES.iter().find(|(key, name, _)| named(key, name)).map(|s| s.0.to_string()),
        "agent" => AGENTS.iter().find(|(key, name)| named(key, name) || (*key == "claude" && given == "claudecode")).map(|a| a.0.to_string()),
        _ => None,
    }
    .unwrap_or_else(|| target.trim().to_lowercase())
}

/// What a watch names when it is given nothing: the inbox, this PC, any app, any agent, a webhook.
fn default_target(source: &str, until: &str) -> Option<&'static str> {
    match (source, until) {
        ("email", "new") => Some("inbox"),
        ("service", "soon") => Some("calendar"),
        ("windows", "notification") => Some(ANY),
        ("windows", _) => Some(PC),
        ("agent", _) => Some(ANY),
        ("webhook", _) => Some("webhook"),
        _ => None,
    }
}

/// The target as it is kept, or why it can't be listened to. `home`: where `~` leads.
pub fn target(source: &str, until: &str, target: &str, text: &str, home: &Path) -> Result<String, String> {
    let target = target.trim().trim_matches('"').trim();
    if target.chars().count() > MAX_TARGET || target.contains(['"', '[', ']', '\n', '\r']) {
        return Err("Give the target as one line, without quotes or brackets.".into());
    }
    if !untils(source).contains(&until) {
        if untils(source).is_empty() {
            return Err("source must be fs, process, web, email, service, windows, agent, webhook or tool.".into());
        }
        return Err(format!("event must be one of {} for {source}.", untils(source).join(", ")));
    }
    // What has only one thing to listen to, whatever was given.
    if matches!((source, until), ("email", "new") | ("windows", "battery_low" | "plugged" | "unplugged" | "offline" | "online" | "usb" | "back")) {
        return Ok(default_target(source, until).unwrap_or(PC).to_string());
    }
    let target = match default_target(source, until) {
        Some(default) if target.is_empty() => default,
        _ => target,
    };
    if target.is_empty() {
        return Err("Give the target as one line, without quotes or brackets.".into());
    }
    let wants_text = |text: &str| -> Result<(), String> {
        if text.trim().is_empty() || text.chars().count() > MAX_TEXT {
            return Err(format!("contains needs the text to wait for, at most {MAX_TEXT} characters."));
        }
        Ok(())
    };
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
            if until == "contains" {
                wants_text(text)?;
            }
            Ok(target.to_string())
        }
        "email" => {
            if target.chars().count() > MAX_TEXT {
                return Err(format!("Give the sender or the words of the subject, at most {MAX_TEXT} characters."));
            }
            Ok(target.split_whitespace().collect::<Vec<_>>().join(" "))
        }
        "service" => {
            let key = canonical(source, target);
            let names = SERVICES.iter().map(|s| s.0).collect::<Vec<_>>().join(", ");
            if !SERVICES.iter().any(|s| s.0 == key) {
                return Err(format!("Give the service as one of {names}."));
            }
            if (key == "calendar") != (until == "soon") {
                return Err("soon is for the calendar, which has only soon.".into());
            }
            Ok(key)
        }
        "windows" => Ok(if target.eq_ignore_ascii_case(ANY) { ANY.to_string() } else { target.chars().take(100).collect() }),
        "agent" => {
            let key = canonical(source, target);
            if !AGENTS.iter().any(|a| a.0 == key) {
                return Err(format!("Give the agent as one of {}.", AGENTS.iter().map(|a| a.0).collect::<Vec<_>>().join(", ")));
            }
            Ok(key)
        }
        "webhook" => {
            let name: String = target
                .to_lowercase()
                .chars()
                .map(|c| if c.is_alphanumeric() { c } else { '-' })
                .collect::<String>()
                .split('-')
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>()
                .join("-");
            if name.is_empty() {
                return Err("Give the webhook a name, like deploys.".into());
            }
            Ok(name.chars().take(40).collect())
        }
        "tool" => {
            if target.len() > 48 || !target.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
                return Err("Give the tool by its id, as list of the user's tools says.".into());
            }
            if until == "contains" {
                wants_text(text)?;
            }
            Ok(target.to_string())
        }
        _ => Err("source must be fs, process, web, email, service, windows, agent, webhook or tool.".into()),
    }
}

/// How a watch is called: the file or folder's name, the program, `:3000`,
/// the page's address, the service, the agent, the app.
pub fn label(source: &str, until: &str, target: &str) -> String {
    match source {
        "fs" => last_part(target).to_string(),
        "email" if until == "new" => "Email".into(),
        "service" => SERVICES.iter().find(|s| s.0 == target).map_or(target, |s| s.1).to_string(),
        "agent" if target == ANY => "Agents".into(),
        "agent" => AGENTS.iter().find(|a| a.0 == target).map_or(target, |a| a.1).to_string(),
        "windows" if target == PC || target == ANY => "Windows".into(),
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

// ── Windows ───────────────────────────────────────────────────────────────────

/// Whether this PC has a way out to the internet: the route a packet would
/// take is asked for, and nothing is sent (connecting a UDP socket only picks
/// the route).
pub fn online() -> bool {
    ["1.1.1.1:53", "[2606:4700:4700::1111]:53"].iter().any(|to| {
        let from = if to.starts_with('[') { "[::]:0" } else { "0.0.0.0:0" };
        UdpSocket::bind(from).and_then(|s| s.connect(to)).is_ok()
    })
}

/// A notification from `app` is one the watch waits for (`any`: from every app but Lumo).
pub fn notification_matches(target: &str, app: &str) -> bool {
    !app.eq_ignore_ascii_case("lumo") && (target == ANY || app.to_lowercase().contains(&target.to_lowercase()))
}

// ── Email, agents, services ───────────────────────────────────────────────────

/// An email is one the watch waits for: any, one from someone (the name or the address), one with words in its subject.
pub fn mail_matches(until: &str, target: &str, from: &str, address: &str, subject: &str) -> bool {
    let want = target.to_lowercase();
    match until {
        "new" => true,
        "from" => from.to_lowercase().contains(&want) || address.to_lowercase().contains(&want),
        "subject" => want.split_whitespace().all(|word| subject.to_lowercase().contains(word)),
        _ => false,
    }
}

/// What an agent's hook event is, for a watch on it: its turn ended, it asks
/// for a permission or a reply, it failed. None: nothing a watch waits for.
pub fn hook_until(event: &str, message: &str, notification_type: &str, status: &str) -> Option<&'static str> {
    match event {
        "Stop" | "stop" if status == "error" => Some("failed"),
        "Stop" | "stop" => Some("finished"),
        "StopFailure" => Some("failed"),
        "PermissionRequest" => Some("permission"),
        "Notification" if message.trim_end().ends_with('?') || matches!(notification_type, "agent_needs_input" | "elicitation_dialog" | "elicitation_url_dialog" | "permission_prompt") => {
            Some("permission")
        }
        _ => None,
    }
}

/// The agent a hook event came from (its `lumo_agent` tag; none: Claude Code).
pub fn agent_of(tag: &str) -> &str {
    if tag.is_empty() { "claude" } else { tag }
}

/// An agent's name, as the island shows it.
pub fn agent_name(tag: &str) -> String {
    AGENTS.iter().find(|a| a.0 == tag && !a.1.is_empty()).map_or_else(|| tag.to_string(), |a| a.1.to_string())
}

/// Something a service did, for a watch on it: whether it went well, and what it was about.
#[derive(Debug, Clone, PartialEq)]
pub struct News {
    pub ok: bool,
    pub what: String,
}

/// What is new on a service since its last report (`before`; None: the first,
/// which only takes note). `event`: what the report itself says happened (a
/// deploy, a payment, a run: ok, and its name).
pub fn service_news(service: &str, before: Option<&serde_json::Value>, after: &serde_json::Value, event: Option<(bool, &str)>) -> Vec<News> {
    if let Some((ok, what)) = event {
        return vec![News { ok, what: what.to_string() }];
    }
    let Some(before) = before else { return Vec::new() };
    let (list, title, stamp) = match service {
        "resend" => ("emails", "subject", ""),
        "notion" => ("pages", "title", "lastEditedAt"),
        "calcom" => ("bookings", "title", ""),
        _ => return Vec::new(),
    };
    let key = |item: &serde_json::Value| format!("{}|{}", item["id"].as_str().map_or_else(|| item["id"].to_string(), str::to_string), item[stamp].as_str().unwrap_or(""));
    let seen: HashSet<String> = before[list].as_array().into_iter().flatten().map(key).collect();
    after[list]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| !seen.contains(&key(item)))
        .map(|item| News {
            ok: !matches!(item["lastEvent"].as_str(), Some("bounced" | "complained" | "failed")),
            what: item[title].as_str().unwrap_or("").to_string(),
        })
        .collect()
}

/// A service's news is what the watch waits for: anything, what went well, what failed.
pub fn news_matches(until: &str, news: &News) -> bool {
    match until {
        "event" => true,
        "succeeded" => news.ok,
        "failed" => !news.ok,
        _ => false,
    }
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

/// A request's first line and headers: its method, its path, how long its body is.
pub fn request_head(head: &str) -> Option<(String, String, usize)> {
    let mut lines = head.lines();
    let mut first = lines.next()?.split_whitespace();
    let method = first.next()?.to_ascii_uppercase();
    let path = first.next()?.to_string();
    first.next().filter(|v| v.starts_with("HTTP/"))?;
    let length = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.trim().eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse().ok())
        .unwrap_or(0);
    Some((method, path, length))
}

/// The secret a webhook's address ends with, from a request's path (`/abc…?x=1`: abc…).
pub fn hook_token(path: &str) -> &str {
    let path = path.split(['?', '#']).next().unwrap_or("");
    path.trim_matches('/')
}

/// What a call sent, as a line: at most `max` characters, on one line.
pub fn excerpt(text: &str, max: usize) -> String {
    let one = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= max {
        return one;
    }
    one.chars().take(max.saturating_sub(1)).collect::<String>() + "…"
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

    #[test]
    fn the_other_sources_name_their_target() {
        let home = Path::new("C:\\Users\\me");
        assert_eq!(target("email", "new", "", "", home).unwrap(), "inbox");
        assert_eq!(target("email", "from", "  Marco   Rossi ", "", home).unwrap(), "Marco Rossi");
        assert!(target("email", "subject", "", "", home).is_err());
        assert_eq!(target("service", "succeeded", "Vercel", "", home).unwrap(), "vercel");
        assert_eq!(target("service", "event", "Cal.com", "", home).unwrap(), "calcom");
        assert_eq!(target("service", "soon", "", "", home).unwrap(), "calendar");
        assert!(target("service", "soon", "stripe", "", home).is_err());
        assert!(target("service", "event", "calendar", "", home).is_err());
        assert!(target("service", "event", "jira", "", home).is_err());
        assert_eq!(target("windows", "battery_low", "whatever", "", home).unwrap(), PC);
        assert_eq!(target("windows", "notification", "", "", home).unwrap(), ANY);
        assert_eq!(target("windows", "notification", "WhatsApp", "", home).unwrap(), "WhatsApp");
        assert_eq!(target("agent", "finished", "", "", home).unwrap(), ANY);
        assert_eq!(target("agent", "failed", "Claude Code", "", home).unwrap(), "claude");
        assert_eq!(target("agent", "permission", "Gemini CLI", "", home).unwrap(), "gemini");
        assert!(target("agent", "finished", "skynet", "", home).is_err());
        assert_eq!(target("webhook", "called", "My Deploys!", "", home).unwrap(), "my-deploys");
        assert_eq!(target("webhook", "called", "", "", home).unwrap(), "webhook");
        assert_eq!(target("tool", "changed", "prices_check", "", home).unwrap(), "prices_check");
        assert!(target("tool", "contains", "prices_check", "", home).is_err());
        assert!(target("tool", "changed", "../x", "", home).is_err());
        assert!(target("nowhere", "changed", "x", "", home).is_err());
        // What is kept reads back the same.
        for (source, until, t) in [("email", "from", "Marco Rossi"), ("service", "event", "calcom"), ("agent", "finished", "any"), ("webhook", "called", "my-deploys"), ("windows", "usb", "pc")] {
            assert_eq!(target(source, until, t, "", home).unwrap(), t);
        }
    }

    #[test]
    fn amounts_have_a_default_and_a_ceiling() {
        assert_eq!(amount_of("service", "soon", 0), 10);
        assert_eq!(amount_of("windows", "battery_low", 150), 99);
        assert_eq!(amount_of("windows", "back", 0), 5);
        assert_eq!(amount_of("tool", "changed", 30), 30);
        assert_eq!(amount_of("fs", "created", 30), 0);
    }

    #[test]
    fn the_other_sources_have_short_names() {
        assert_eq!(label("service", "event", "calcom"), "Cal.com");
        assert_eq!(label("agent", "finished", "codex"), "Codex");
        assert_eq!(label("agent", "finished", ANY), "Agents");
        assert_eq!(label("windows", "usb", PC), "Windows");
        assert_eq!(label("windows", "notification", "Slack"), "Slack");
        assert_eq!(label("email", "new", "inbox"), "Email");
        assert_eq!(label("email", "from", "marco"), "marco");
        assert_eq!(canonical("agent", "Claude Code"), "claude");
        assert_eq!(canonical("service", "N8N"), "n8n");
    }

    #[test]
    fn emails_and_notifications_are_matched() {
        assert!(mail_matches("new", "inbox", "A", "a@x.com", "Hi"));
        assert!(mail_matches("from", "marco", "Marco Rossi", "m@x.com", "Hi"));
        assert!(mail_matches("from", "@acme.com", "Billing", "bill@acme.com", "Hi"));
        assert!(!mail_matches("from", "marco", "Anna", "anna@x.com", "Marco"));
        assert!(mail_matches("subject", "invoice october", "A", "a@x.com", "Your October invoice"));
        assert!(!mail_matches("subject", "invoice march", "A", "a@x.com", "Your October invoice"));
        assert!(notification_matches(ANY, "WhatsApp"));
        assert!(notification_matches("whats", "WhatsApp"));
        assert!(!notification_matches(ANY, "Lumo"));
        assert!(!notification_matches("slack", "WhatsApp"));
    }

    #[test]
    fn agents_hooks_are_read() {
        assert_eq!(hook_until("Stop", "", "", ""), Some("finished"));
        assert_eq!(hook_until("stop", "", "", "error"), Some("failed"));
        assert_eq!(hook_until("StopFailure", "", "", ""), Some("failed"));
        assert_eq!(hook_until("PermissionRequest", "", "", ""), Some("permission"));
        assert_eq!(hook_until("Notification", "Shall I go on?", "", ""), Some("permission"));
        assert_eq!(hook_until("Notification", "Working", "", ""), None);
        assert_eq!(hook_until("PreToolUse", "", "", ""), None);
        assert_eq!(agent_of(""), "claude");
        assert_eq!(agent_name("gemini"), "Gemini CLI");
        assert_eq!(agent_name("newagent"), "newagent");
    }

    #[test]
    fn a_service_says_what_is_new() {
        use serde_json::json;
        assert_eq!(service_news("vercel", None, &json!({}), Some((false, "site"))), vec![News { ok: false, what: "site".into() }]);
        let before = json!({ "bookings": [{ "id": 1, "title": "Call" }] });
        let after = json!({ "bookings": [{ "id": 2, "title": "Demo" }, { "id": 1, "title": "Call" }] });
        assert_eq!(service_news("calcom", Some(&before), &after, None), vec![News { ok: true, what: "Demo".into() }]);
        assert!(service_news("calcom", None, &after, None).is_empty(), "the first report only takes note");
        let pages = |at: &str| json!({ "pages": [{ "id": "p", "title": "Plan", "lastEditedAt": at }] });
        assert_eq!(service_news("notion", Some(&pages("1")), &pages("2"), None).len(), 1);
        assert!(service_news("notion", Some(&pages("1")), &pages("1"), None).is_empty());
        let mails = json!({ "emails": [{ "id": "e", "subject": "Welcome", "lastEvent": "bounced" }] });
        let news = service_news("resend", Some(&json!({ "emails": [] })), &mails, None);
        assert!(!news[0].ok && news_matches("failed", &news[0]) && !news_matches("succeeded", &news[0]) && news_matches("event", &news[0]));
    }

    #[test]
    fn a_webhook_call_is_read() {
        let head = "POST /abc123?x=1 HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 12\r\n";
        assert_eq!(request_head(head), Some(("POST".into(), "/abc123?x=1".into(), 12)));
        assert_eq!(request_head("GET / HTTP/1.1"), Some(("GET".into(), "/".into(), 0)));
        assert_eq!(request_head("hello"), None);
        assert_eq!(hook_token("/abc123?x=1"), "abc123");
        assert_eq!(excerpt("a\n  b   c", 10), "a b c");
        assert_eq!(excerpt("abcdefghij", 5), "abcd…");
    }
}
