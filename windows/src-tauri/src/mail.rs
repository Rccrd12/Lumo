// The Email pill: new messages in the user's inbox, read over IMAP with an app
// password (Gmail, Outlook, iCloud, any IMAP server), for the closed island's
// email preview and the pill's card. The server says when one arrives (IDLE),
// so it shows within seconds.
//
// Read only, by construction: the inbox is opened with EXAMINE (the server
// refuses any change to it), message bodies are fetched with BODY.PEEK (they
// stay unread), and there is no command here that sends, moves or deletes
// anything. The address, the server and the app password are in the credential
// store (secrets.rs); the connection is TLS only, to the server the user typed.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio_rustls::rustls::{self, pki_types::ServerName, ClientConfig, RootCertStore};
use tokio_rustls::{client::TlsStream, TlsConnector};

use crate::i18n::{t, tf};
use crate::integrations::{emit, IntegrationUpdate};
use crate::island::WINDOW_LABEL;
use crate::{log, secrets};

pub const ID: &str = "integration_mail";
pub const ADDRESS_KEY: &str = "mail-address";
pub const SERVER_KEY: &str = "mail-imap-server";
pub const PASSWORD_KEY: &str = "mail-app-password";

/// One step with the server: connect and sign in, look, or end an IDLE.
const TIMEOUT: Duration = Duration::from_secs(25);
/// What one check may read from the server, all answers together.
const MAX_READ: usize = 4 * 1024 * 1024;
/// The newest unread messages kept: the island shows three, and the next ones
/// move up when one is ignored.
const FETCH: usize = 8;
/// Of each message's body, enough for a preview and for the AI to answer it.
const BODY_BYTES: usize = 24 * 1024;
const BODY_CHARS: usize = 6000;
const PREVIEW_CHARS: usize = 180;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Message {
    /// The server's UID, with the account, so the island shows it once.
    pub id: String,
    pub from: String,
    pub address: String,
    pub subject: String,
    pub preview: String,
    pub body: String,
    pub date: String,
    /// Where to read it in the browser, for a webmail we know.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
}

/// The highest UID seen per account: what is above it is new. The first
/// check only takes note, so what was already unread is not announced.
static LAST_UID: Mutex<Option<(String, u32)>> = Mutex::new(None);
/// What the island was last sent, so an unchanged inbox sends nothing.
static LAST_SENT: Mutex<Option<String>> = Mutex::new(None);

// ── Watching the inbox ────────────────────────────────────────────────────────

/// Woken by the pill's Refresh, a change of settings or of the keys.
static WAKE: Notify = Notify::const_new();
/// Bumped when the address, server or password change: the connection is redone.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Look again now (Refresh).
pub fn wake() {
    *LAST_SENT.lock().unwrap() = None;
    WAKE.notify_one();
}

/// The keys changed: sign in again with the new ones.
pub fn keys_changed() {
    GENERATION.fetch_add(1, Ordering::Relaxed);
    WAKE.notify_one();
}

/// The server tells Lumo about a new email as it arrives (IMAP IDLE), on one
/// connection kept open while the pill is on. A server without IDLE is asked
/// every 30 seconds instead. Nothing happens while the pill is off, Lumo is
/// paused or the keys are missing.
pub async fn run(app: AppHandle) {
    tokio::time::sleep(Duration::from_secs(4)).await;
    let mut backoff = RETRY_FIRST;
    loop {
        if !crate::integrations::enabled(&app, ID) || crate::integrations::PAUSED.load(Ordering::Relaxed) {
            let _ = tokio::time::timeout(Duration::from_secs(60), WAKE.notified()).await;
            continue;
        }
        let Some((address, password)) = secrets::get(ADDRESS_KEY).zip(secrets::get(PASSWORD_KEY)) else {
            let _ = tokio::time::timeout(Duration::from_secs(60), WAKE.notified()).await;
            continue;
        };
        let server = secrets::get(SERVER_KEY).unwrap_or_default();
        let (host, port) = server_of(&server, &address);
        match watch(&app, &host, port, &address, &password).await {
            Ok(()) => backoff = RETRY_FIRST,
            Err(error) => {
                fail(&app, error);
                // Waits before trying again (longer each time), unless woken.
                let _ = tokio::time::timeout(backoff, WAKE.notified()).await;
                backoff = (backoff * 2).min(RETRY_MOST);
            }
        }
    }
}

const RETRY_FIRST: Duration = Duration::from_secs(30);
const RETRY_MOST: Duration = Duration::from_secs(600);
/// How long one IDLE lasts before Lumo looks again anyway. The server should
/// say at once when an email arrives, but some (Gmail) can be slow to: looking
/// every 20 seconds costs one tiny SEARCH, as only new emails are fetched.
const IDLE_FOR: Duration = Duration::from_secs(20);
/// Without IDLE, how often the inbox is asked.
const POLL_EVERY: Duration = Duration::from_secs(30);

/// One connection: sign in, then look each time the server says something
/// changed. Returns Ok when it should be redone (keys changed, pill off).
async fn watch(app: &AppHandle, host: &str, port: u16, address: &str, password: &str) -> Result<(), String> {
    let generation = GENERATION.load(Ordering::Relaxed);
    let mut imap = timed(host, sign_in(host, port, address, password)).await?;
    let idle = imap.capabilities.iter().any(|c| c == "IDLE");
    let account = format!("{address}@{host}");
    let mut known = std::collections::HashMap::new();
    loop {
        imap.read = 0;
        let (unread, messages) = timed(host, look(&mut imap, host, &mut known)).await?;
        report(app, &account, host, unread, messages);
        let stop = || {
            GENERATION.load(Ordering::Relaxed) != generation
                || !crate::integrations::enabled(app, ID)
                || crate::integrations::PAUSED.load(Ordering::Relaxed)
        };
        if stop() {
            let _ = tokio::time::timeout(Duration::from_secs(5), imap.run("LOGOUT")).await;
            return Ok(());
        }
        if idle {
            imap.idle(host).await?;
        } else {
            let _ = tokio::time::timeout(POLL_EVERY, WAKE.notified()).await;
        }
        if stop() {
            let _ = tokio::time::timeout(Duration::from_secs(5), imap.run("LOGOUT")).await;
            return Ok(());
        }
    }
}

/// A step that must not hang: the server has TIMEOUT to answer.
async fn timed<T>(host: &str, step: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::time::timeout(TIMEOUT, step)
        .await
        .unwrap_or_else(|_| Err(tf("{server} did not answer in time.", &[("server", host)])))
}

/// What the island gets: the newest unread emails, and the ones that are new.
fn report(app: &AppHandle, account: &str, host: &str, unread: usize, messages: Vec<Message>) {
    let newest = messages.iter().filter_map(|m| uid_of(&m.id)).max().unwrap_or(0);
    let fresh: Vec<Message> = {
        let mut last = LAST_UID.lock().unwrap();
        let seen = match last.as_ref() {
            Some((a, seen)) if a == account => Some(*seen),
            _ => None,
        };
        let fresh = match seen {
            Some(seen) => messages.iter().filter(|m| uid_of(&m.id).is_some_and(|u| u > seen)).cloned().collect(),
            None => Vec::new(),
        };
        *last = Some((account.to_string(), newest.max(seen.unwrap_or(0))));
        fresh
    };
    // Only what changed reaches the island: a quiet inbox wakes nothing.
    let data = json!({ "messages": messages, "unread": unread, "inbox": inbox_link(host) });
    let text = data.to_string();
    let changed = {
        let mut sent = LAST_SENT.lock().unwrap();
        let changed = sent.as_deref() != Some(text.as_str());
        *sent = Some(text);
        changed
    };
    if changed {
        emit(app, IntegrationUpdate { id: ID, data, error: None, event: None });
    }
    if !fresh.is_empty() {
        let _ = app.emit_to(WINDOW_LABEL, "mail-new", &fresh);
    }
}

fn fail(app: &AppHandle, error: String) {
    *LAST_SENT.lock().unwrap() = None;
    log::line(format!("[mail] {error}"));
    emit(app, IntegrationUpdate { id: ID, data: json!({}), error: Some(error), event: None });
}

fn uid_of(id: &str) -> Option<u32> {
    id.rsplit(':').next()?.parse().ok()
}

/// The server the user typed ("imap.example.com" or "imap.example.com:993"),
/// or the usual one for the address's provider.
pub fn server_of(typed: &str, address: &str) -> (String, u16) {
    let typed = typed.trim().trim_start_matches("imaps://").trim_end_matches('/');
    if !typed.is_empty() {
        if let Some((host, port)) = typed.rsplit_once(':') {
            if let Ok(port) = port.parse::<u16>() {
                return (host.to_ascii_lowercase(), port);
            }
        }
        return (typed.to_ascii_lowercase(), 993);
    }
    let domain = address.rsplit('@').next().unwrap_or("").trim().to_ascii_lowercase();
    let host = match domain.as_str() {
        "gmail.com" | "googlemail.com" => "imap.gmail.com".to_string(),
        "outlook.com" | "hotmail.com" | "live.com" | "msn.com" | "outlook.it" | "hotmail.it" | "live.it" => {
            "outlook.office365.com".to_string()
        }
        "icloud.com" | "me.com" | "mac.com" => "imap.mail.me.com".to_string(),
        "yahoo.com" | "yahoo.it" | "ymail.com" => "imap.mail.yahoo.com".to_string(),
        "libero.it" => "imapmail.libero.it".to_string(),
        "aol.com" => "imap.aol.com".to_string(),
        "proton.me" | "protonmail.com" => "127.0.0.1".to_string(),
        d => format!("imap.{d}"),
    };
    // Proton Mail is read through its Bridge, on this computer.
    let port = if host == "127.0.0.1" { 1143 } else { 993 };
    (host, port)
}

fn is_gmail(host: &str) -> bool {
    host.ends_with("gmail.com") || host.ends_with("googlemail.com")
}

fn inbox_link(host: &str) -> Option<String> {
    if is_gmail(host) {
        Some("https://mail.google.com/mail/u/0/#inbox".into())
    } else if host.contains("office365") || host.contains("outlook") {
        Some("https://outlook.live.com/mail/0/inbox".into())
    } else {
        None
    }
}

fn message_link(host: &str, message_id: &str) -> Option<String> {
    let id = message_id.trim().trim_start_matches('<').trim_end_matches('>');
    if !is_gmail(host) || id.is_empty() {
        return inbox_link(host);
    }
    let encoded: String = id
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'-' | b'_' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect();
    Some(format!("https://mail.google.com/mail/u/0/#search/rfc822msgid%3A{encoded}"))
}

// ── IMAP ──────────────────────────────────────────────────────────────────────

/// A piece of an answer: the text of a line, or a literal (`{n}` bytes) inside it.
#[derive(Debug, Clone, PartialEq)]
enum Part {
    Text(String),
    Literal(Vec<u8>),
}

struct Imap {
    stream: BufReader<TlsStream<TcpStream>>,
    tag: u32,
    read: usize,
    capabilities: Vec<String>,
}

fn tls() -> Result<Arc<ClientConfig>, String> {
    let roots = RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Arc::new(config))
}

impl Imap {
    async fn connect(host: &str, port: u16) -> Result<Self, String> {
        let unreachable = |_| tf("Can't reach {server}.", &[("server", host)]);
        let tcp = TcpStream::connect((host, port)).await.map_err(unreachable)?;
        let name = ServerName::try_from(host.to_string()).map_err(|_| tf("Not a valid address: {address}", &[("address", host)]))?;
        let stream = TlsConnector::from(tls()?)
            .connect(name, tcp)
            .await
            .map_err(|e| tf("No secure connection to {server}: {error}", &[("server", host), ("error", &e.to_string())]))?;
        let mut imap = Imap { stream: BufReader::new(stream), tag: 0, read: 0, capabilities: Vec::new() };
        // The greeting.
        let greeting = imap.read_unit().await?;
        match greeting.first() {
            Some(Part::Text(line)) if line.starts_with("* OK") || line.starts_with("* PREAUTH") => Ok(imap),
            _ => Err(tf("{server} is not an IMAP server.", &[("server", host)])),
        }
    }

    /// One line from the server, with the literals it announces.
    async fn read_unit(&mut self) -> Result<Vec<Part>, String> {
        let mut parts = Vec::new();
        loop {
            let mut line = Vec::new();
            let n = self.stream.read_until(b'\n', &mut line).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Err(t("The mail server closed the connection."));
            }
            self.count(n)?;
            let text = String::from_utf8_lossy(&line).trim_end_matches(['\r', '\n']).to_string();
            let literal = literal_size(&text);
            parts.push(Part::Text(text));
            let Some(size) = literal else { return Ok(parts) };
            self.count(size)?;
            let mut bytes = vec![0u8; size];
            self.stream.read_exact(&mut bytes).await.map_err(|e| e.to_string())?;
            parts.push(Part::Literal(bytes));
        }
    }

    fn count(&mut self, n: usize) -> Result<(), String> {
        self.read += n;
        if self.read > MAX_READ {
            return Err(t("The mail server sent too much."));
        }
        Ok(())
    }

    /// Sends a command; the untagged answers, or why the server said no.
    async fn run(&mut self, command: &str) -> Result<Vec<Vec<Part>>, String> {
        self.tag += 1;
        let tag = format!("L{}", self.tag);
        let line = format!("{tag} {command}\r\n");
        let stream = self.stream.get_mut();
        stream.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        stream.flush().await.map_err(|e| e.to_string())?;
        let mut untagged = Vec::new();
        loop {
            let unit = self.read_unit().await?;
            let Some(Part::Text(first)) = unit.first() else { continue };
            if let Some(rest) = first.strip_prefix(&format!("{tag} ")) {
                if rest.starts_with("OK") {
                    return Ok(untagged);
                }
                return Err(rest.split_once(' ').map_or(rest, |x| x.1).trim().to_string());
            }
            untagged.push(unit);
        }
    }
}

impl Imap {
    async fn send(&mut self, line: &str) -> Result<(), String> {
        let stream = self.stream.get_mut();
        stream.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        stream.flush().await.map_err(|e| e.to_string())
    }

    /// Waits in IDLE until the server says the mailbox changed, Lumo is
    /// woken, or IDLE_FOR goes by; then ends the IDLE.
    async fn idle(&mut self, host: &str) -> Result<(), String> {
        self.tag += 1;
        let tag = format!("L{}", self.tag);
        self.send(&format!("{tag} IDLE\r\n")).await?;
        timed(host, self.idling(&tag)).await?;
        let deadline = tokio::time::Instant::now() + IDLE_FOR;
        loop {
            // The server speaks, or the time is up, or Lumo is woken.
            let wait = tokio::time::timeout_at(deadline, WAKE.notified());
            let changed = match first_of(self.read_unit(), wait).await {
                First::A(unit) => {
                    let unit = unit?;
                    matches!(unit.first(), Some(Part::Text(line)) if line.starts_with("* ") && (line.ends_with("EXISTS") || line.ends_with("EXPUNGE") || line.contains(" FETCH ")))
                }
                First::B(_) => true,
            };
            self.read = 0;
            if changed {
                break;
            }
        }
        self.send("DONE\r\n").await?;
        timed(host, self.done(&tag)).await
    }

    /// The server's "+ idling".
    async fn idling(&mut self, tag: &str) -> Result<(), String> {
        loop {
            let unit = self.read_unit().await?;
            match unit.first() {
                Some(Part::Text(line)) if line.starts_with('+') => return Ok(()),
                Some(Part::Text(line)) if line.starts_with(&format!("{tag} ")) => {
                    return Err(line[tag.len() + 1..].trim().to_string());
                }
                _ => {}
            }
        }
    }

    /// The IDLE's own answer, after DONE.
    async fn done(&mut self, tag: &str) -> Result<(), String> {
        loop {
            let unit = self.read_unit().await?;
            if let Some(Part::Text(line)) = unit.first() {
                if let Some(rest) = line.strip_prefix(&format!("{tag} ")) {
                    return if rest.starts_with("OK") { Ok(()) } else { Err(rest.trim().to_string()) };
                }
            }
        }
    }
}

enum First<A, B> {
    A(A),
    B(B),
}

/// Whichever of two futures is ready first; the other is dropped.
async fn first_of<A: std::future::Future, B: std::future::Future>(a: A, b: B) -> First<A::Output, B::Output> {
    let mut a = std::pin::pin!(a);
    let mut b = std::pin::pin!(b);
    std::future::poll_fn(|cx| {
        if let std::task::Poll::Ready(v) = a.as_mut().poll(cx) {
            return std::task::Poll::Ready(First::A(v));
        }
        if let std::task::Poll::Ready(v) = b.as_mut().poll(cx) {
            return std::task::Poll::Ready(First::B(v));
        }
        std::task::Poll::Pending
    })
    .await
}

/// `{123}` at the end of a line announces 123 bytes that follow it.
fn literal_size(line: &str) -> Option<usize> {
    let open = line.strip_suffix('}')?.rfind('{')?;
    line[open + 1..line.len() - 1].trim_end_matches('+').parse().ok()
}

/// A string as IMAP takes it: quoted, with `\` and `"` escaped.
fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Connected, signed in, the inbox open read only.
async fn sign_in(host: &str, port: u16, address: &str, password: &str) -> Result<Imap, String> {
    let mut imap = Imap::connect(host, port).await?;
    // App passwords are shown with spaces ("abcd efgh ijkl mnop"); Google takes them either way.
    imap.run(&format!("LOGIN {} {}", quoted(address.trim()), quoted(password.trim())))
        .await
        .map_err(|why| sign_in_error(host, &why))?;
    let caps = imap.run("CAPABILITY").await?;
    imap.capabilities = caps
        .iter()
        .filter_map(|u| match u.first() {
            Some(Part::Text(line)) => line.strip_prefix("* CAPABILITY"),
            _ => None,
        })
        .flat_map(|rest| rest.split_whitespace().map(str::to_ascii_uppercase).collect::<Vec<_>>())
        .collect();
    imap.run("EXAMINE INBOX").await?;
    Ok(imap)
}

/// Why the server refused, in words: the usual cases said plainly.
fn sign_in_error(host: &str, why: &str) -> String {
    let lower = why.to_ascii_lowercase();
    if lower.contains("application-specific password") || lower.contains("app password") {
        return t("Gmail wants an app password here, not your account's password. Create one at myaccount.google.com/apppasswords (it needs 2-Step Verification) and paste it in Settings → Email.");
    }
    if lower.contains("authenticationfailed") || lower.contains("invalid credentials") || lower.contains("login failed") {
        return t("The address or the app password is wrong.");
    }
    // "[ALERT] … https://… (Failure)": the words, without the code and the address.
    let words: Vec<&str> = why
        .split_whitespace()
        .filter(|w| !w.starts_with('[') && !w.starts_with("http") && *w != "(Failure)")
        .collect();
    tf("{server} refused to sign in: {error}", &[("server", host), ("error", words.join(" ").trim_end_matches(':'))])
}

/// The unread count and the newest unread emails; `known` keeps the ones
/// already fetched on this connection, so only new ones are asked for.
async fn look(imap: &mut Imap, host: &str, known: &mut std::collections::HashMap<u32, Message>) -> Result<(usize, Vec<Message>), String> {
    let found = imap.run("UID SEARCH UNSEEN").await?;
    let mut uids = search_uids(&found);
    let unread = uids.len();
    uids.sort_unstable();
    let newest: Vec<u32> = uids.iter().rev().take(FETCH).copied().collect();
    known.retain(|uid, _| newest.contains(uid));
    let missing: Vec<u32> = newest.iter().copied().filter(|u| !known.contains_key(u)).collect();
    if !missing.is_empty() {
        let set = missing.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let fetched = imap
            .run(&format!(
                "UID FETCH {set} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.{BODY_BYTES}>)"
            ))
            .await?;
        for unit in &fetched {
            if let Some(m) = parse_fetch(unit, host) {
                if let Some(uid) = uid_of(&m.id) {
                    known.insert(uid, m);
                }
            }
        }
    }
    let mut messages: Vec<Message> = newest.iter().filter_map(|u| known.get(u).cloned()).collect();
    messages.sort_by_key(|m| std::cmp::Reverse(uid_of(&m.id).unwrap_or(0)));
    Ok((unread, messages))
}

fn search_uids(units: &[Vec<Part>]) -> Vec<u32> {
    units
        .iter()
        .filter_map(|u| match u.first() {
            Some(Part::Text(line)) => line.strip_prefix("* SEARCH"),
            _ => None,
        })
        .flat_map(|rest| rest.split_whitespace().filter_map(|n| n.parse().ok()).collect::<Vec<u32>>())
        .collect()
}

fn parse_fetch(unit: &[Part], host: &str) -> Option<Message> {
    let Some(Part::Text(first)) = unit.first() else { return None };
    if !first.starts_with("* ") || !first.contains(" FETCH ") {
        return None;
    }
    let text: String = unit
        .iter()
        .filter_map(|p| match p {
            Part::Text(s) => Some(s.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(" ");
    let uid = text
        .split("UID ")
        .nth(1)
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|n| n.parse::<u32>().ok())?;
    let mut header: &[u8] = &[];
    let mut body: &[u8] = &[];
    let mut before = "";
    for part in unit {
        match part {
            Part::Text(s) => before = s,
            Part::Literal(bytes) if before.to_ascii_uppercase().contains("HEADER") => header = bytes,
            Part::Literal(bytes) => body = bytes,
        }
    }
    let headers = parse_headers(header);
    let field = |name: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str()).unwrap_or("");
    let (from, address) = parse_from(&decode_words(field("From")));
    let from = clean_header(&from);
    let subject = clean_header(&decode_words(field("Subject")));
    let content = extract_text(field("Content-Type"), field("Content-Transfer-Encoding"), body);
    let clean = tidy(&content);
    Some(Message {
        id: format!("{host}:{uid}"),
        from,
        address,
        subject: subject.trim().to_string(),
        preview: preview(&clean),
        body: clean.chars().take(BODY_CHARS).collect(),
        date: field("Date").trim().to_string(),
        link: message_link(host, field("Message-ID")),
    })
}

// ── Messages ──────────────────────────────────────────────────────────────────

/// "Name: value" pairs, folded lines unfolded.
fn parse_headers(raw: &[u8]) -> Vec<(String, String)> {
    let text = header_text(raw);
    let mut out: Vec<(String, String)> = Vec::new();
    for line in text.split('\n') {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        if line.starts_with([' ', '\t']) {
            if let Some(last) = out.last_mut() {
                last.1.push(' ');
                last.1.push_str(line.trim());
            }
            continue;
        }
        if let Some((k, v)) = line.split_once(':') {
            out.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    out
}

/// `"Ada Lovelace" <ada@example.com>` → ("Ada Lovelace", "ada@example.com").
fn parse_from(raw: &str) -> (String, String) {
    let raw = raw.trim();
    if let (Some(open), Some(close)) = (raw.rfind('<'), raw.rfind('>')) {
        if open < close {
            let address = raw[open + 1..close].trim().to_string();
            let name = raw[..open].trim().trim_matches('"').trim().to_string();
            let name = if name.is_empty() { address.clone() } else { name };
            return (name, address);
        }
    }
    (raw.to_string(), raw.to_string())
}

/// RFC 2047 words (`=?UTF-8?B?…?=`) in a header, decoded; the space between
/// two of them goes. Adjacent words in the same charset are joined before they
/// are read: senders split a character's bytes across two words ("McDonald=E2"
/// "=80=99s"), which read one by one would come out as "McDonaldâ€™s".
pub fn decode_words(raw: &str) -> String {
    fn flush(out: &mut String, pending: &mut Option<(String, Vec<u8>)>) {
        if let Some((charset, bytes)) = pending.take() {
            out.push_str(&in_charset(&bytes, &charset));
        }
    }
    let mut out = String::new();
    let mut pending: Option<(String, Vec<u8>)> = None;
    let mut rest = raw;
    while let Some(start) = rest.find("=?") {
        let (plain, tail) = rest.split_at(start);
        match decode_word(tail) {
            Some((charset, bytes, used)) => {
                let next_to_last = pending.is_some() && plain.trim().is_empty();
                match pending.as_mut() {
                    Some((cs, held)) if next_to_last && cs.eq_ignore_ascii_case(&charset) => held.extend(bytes),
                    _ => {
                        flush(&mut out, &mut pending);
                        if !next_to_last {
                            out.push_str(plain);
                        }
                        pending = Some((charset, bytes));
                    }
                }
                rest = &tail[used..];
            }
            None => {
                flush(&mut out, &mut pending);
                out.push_str(plain);
                out.push_str("=?");
                rest = &tail[2..];
            }
        }
    }
    flush(&mut out, &mut pending);
    out.push_str(rest);
    out
}

/// One encoded word at the start of `s`: its charset, its bytes and how many
/// bytes of `s` it took.
fn decode_word(s: &str) -> Option<(String, Vec<u8>, usize)> {
    let inner = s.strip_prefix("=?")?;
    let (charset, inner) = inner.split_once('?')?;
    let (encoding, inner) = inner.split_once('?')?;
    if charset.is_empty() || charset.contains(char::is_whitespace) {
        return None;
    }
    let end = inner.find("?=")?;
    let payload = &inner[..end];
    let bytes = match encoding.to_ascii_uppercase().as_str() {
        "B" => base64(payload.as_bytes()),
        "Q" => quoted_printable(payload.replace('_', " ").as_bytes()),
        _ => return None,
    };
    let used = 2 + charset.len() + 1 + encoding.len() + 1 + end + 2;
    Some((charset.to_string(), bytes, used))
}

/// Bytes in the given charset, as text. UTF-16 is read as such; anything else
/// as UTF-8 where the bytes are UTF-8 and as Windows-1252 (Latin-1 with the
/// curly quotes) where they are not, byte by byte, so one stray byte does not
/// spoil the rest. Text that was UTF-8 read as Windows-1252 on its way here
/// ("â€™") is put back.
fn in_charset(bytes: &[u8], charset: &str) -> String {
    let cs = charset.trim().trim_matches('"').to_ascii_lowercase();
    let cs = cs.split('*').next().unwrap_or(&cs);
    let text = match cs {
        "utf-16" | "utf16" | "ucs-2" => utf16(bytes, false),
        "utf-16be" | "unicodefffe" => utf16(bytes, false),
        "utf-16le" | "unicode" => utf16(bytes, true),
        "iso-8859-15" | "iso8859-15" | "latin9" if std::str::from_utf8(bytes).is_err() => {
            bytes.iter().map(|&b| if b == 0xA4 { '€' } else { cp1252(b) }).collect()
        }
        _ => utf8_or_1252(bytes),
    };
    repair(&text)
}

/// Valid UTF-8 runs as UTF-8, every other byte as Windows-1252.
fn utf8_or_1252(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(text) => {
                out.push_str(text);
                return out;
            }
            Err(e) => {
                let good = e.valid_up_to();
                out.push_str(std::str::from_utf8(&rest[..good]).unwrap_or_default());
                out.push(cp1252(rest[good]));
                rest = &rest[good + 1..];
            }
        }
    }
}

/// UTF-16, its byte order from the BOM, else `little_endian`.
fn utf16(bytes: &[u8], little_endian: bool) -> String {
    let (le, body) = match bytes {
        [0xFF, 0xFE, rest @ ..] => (true, rest),
        [0xFE, 0xFF, rest @ ..] => (false, rest),
        _ => (little_endian, bytes),
    };
    let units: Vec<u16> = body
        .chunks_exact(2)
        .map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
        .collect();
    String::from_utf16_lossy(&units)
}

/// UTF-8 that was read as Windows-1252 somewhere before ("McDonaldâ€™s",
/// "CaffÃ¨"), read again as UTF-8, word by word. A word that is not such a
/// mix-up stays as is: put back into Windows-1252 bytes it is not valid UTF-8
/// ("Caffè"), or it holds what Windows-1252 has not (an emoji).
fn repair(text: &str) -> String {
    if text.is_ascii() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut word = String::new();
    let fix = |word: &str, out: &mut String| {
        let bytes: Option<Vec<u8>> = if word.is_ascii() { None } else { word.chars().map(to_cp1252).collect() };
        match bytes.map(String::from_utf8) {
            Some(Ok(fixed)) if !fixed.is_ascii() => out.push_str(&fixed),
            _ => out.push_str(word),
        }
    };
    for c in text.chars() {
        if c.is_whitespace() {
            fix(&word, &mut out);
            word.clear();
            out.push(c);
        } else {
            word.push(c);
        }
    }
    fix(&word, &mut out);
    out
}

/// One Windows-1252 byte as a character: Latin-1, with the curly quotes,
/// dashes, the euro and the rest in 0x80–0x9F.
fn cp1252(b: u8) -> char {
    if (0x80..0xA0).contains(&b) { CP1252_HIGH[(b - 0x80) as usize] } else { b as char }
}

/// The byte a character is in Windows-1252, if it is there.
fn to_cp1252(c: char) -> Option<u8> {
    let code = c as u32;
    if code < 0x80 || (0xA0..=0xFF).contains(&code) {
        return Some(code as u8);
    }
    CP1252_HIGH.iter().position(|&h| h == c && !('\u{80}'..'\u{A0}').contains(&h)).map(|i| 0x80 + i as u8)
}

const CP1252_HIGH: [char; 32] = [
    '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8D}', 'Ž', '\u{8F}',
    '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9D}', 'ž', 'Ÿ',
];

/// A sender's name or a subject, ready to show: entities read (`&amp;`,
/// `&rsquo;`), control characters of Windows-1252 that came as numbers
/// (`&#146;`) read as the characters they stand for, and the apostrophe some
/// mailers turn into "ÿ" between two letters ("McDonaldÿs") put back.
fn clean_header(text: &str) -> String {
    let text = repair(&entities(text));
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    for (i, &c) in chars.iter().enumerate() {
        let letter = |j: Option<usize>| j.and_then(|j| chars.get(j)).is_some_and(|c| c.is_ascii_alphabetic());
        match c {
            '\u{80}'..='\u{9F}' => out.push(cp1252(c as u8)),
            'ÿ' if letter(i.checked_sub(1)) && letter(Some(i + 1)) => out.push('’'),
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Header bytes as text: UTF-8 when they are, else Windows-1252.
fn header_text(raw: &[u8]) -> String {
    in_charset(raw, "")
}

/// Base64, spaces and line breaks ignored; a cut-off end is dropped.
pub fn base64(input: &[u8]) -> Vec<u8> {
    fn value(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' | b'-' => Some(62),
            b'/' | b'_' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut acc = 0u32;
    let mut bits = 0;
    for &c in input {
        if c == b'=' {
            break;
        }
        let Some(v) = value(c) else { continue };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

pub fn quoted_printable(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < input.len() {
        let c = input[i];
        if c == b'=' {
            // A soft line break.
            if input.get(i + 1) == Some(&b'\r') && input.get(i + 2) == Some(&b'\n') {
                i += 3;
                continue;
            }
            if input.get(i + 1) == Some(&b'\n') {
                i += 2;
                continue;
            }
            let hex = input.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(b) = hex {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

/// A Content-Type's type and parameters: ("multipart/alternative", [("boundary", "x")]).
fn content_type(raw: &str) -> (String, Vec<(String, String)>) {
    let mut pieces = raw.split(';');
    let kind = pieces.next().unwrap_or("").trim().to_ascii_lowercase();
    let params = pieces
        .filter_map(|p| p.split_once('='))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().trim_matches('"').to_string()))
        .collect();
    (if kind.is_empty() { "text/plain".into() } else { kind }, params)
}

fn param<'a>(params: &'a [(String, String)], name: &str) -> &'a str {
    params.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str()).unwrap_or("")
}

fn decode_body(encoding: &str, bytes: &[u8]) -> Vec<u8> {
    match encoding.trim().to_ascii_lowercase().as_str() {
        "base64" => base64(bytes),
        "quoted-printable" => quoted_printable(bytes),
        _ => bytes.to_vec(),
    }
}

/// The readable text of a message (or one of its parts): the plain text when
/// there is one, else the HTML without its tags.
pub fn extract_text(ctype: &str, encoding: &str, body: &[u8]) -> String {
    extract(ctype, encoding, body, 0).map(|(text, _)| text).unwrap_or_default()
}

/// The text, and whether it is plain (preferred over HTML).
fn extract(ctype: &str, encoding: &str, body: &[u8], depth: usize) -> Option<(String, bool)> {
    let (kind, params) = content_type(ctype);
    if kind.starts_with("multipart/") && depth < 6 {
        let boundary = param(&params, "boundary");
        if boundary.is_empty() {
            return None;
        }
        let mut html: Option<String> = None;
        for part in split_parts(body, boundary) {
            let (head, content) = split_head(part);
            let headers = parse_headers(head);
            let get = |n: &str| headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(n)).map(|(_, v)| v.clone()).unwrap_or_default();
            if get("Content-Disposition").to_ascii_lowercase().starts_with("attachment") {
                continue;
            }
            match extract(&get("Content-Type"), &get("Content-Transfer-Encoding"), content, depth + 1) {
                Some((text, true)) if !text.trim().is_empty() => return Some((text, true)),
                Some((text, false)) if html.is_none() && !text.trim().is_empty() => html = Some(text),
                _ => {}
            }
        }
        return html.map(|h| (h, false));
    }
    let charset = param(&params, "charset");
    match kind.as_str() {
        "text/plain" => Some((in_charset(&decode_body(encoding, body), charset), true)),
        "text/html" => Some((strip_html(&in_charset(&decode_body(encoding, body), charset)), false)),
        _ => None,
    }
}

/// The parts between `--boundary` lines (the closing one may be cut off).
fn split_parts<'a>(body: &'a [u8], boundary: &str) -> Vec<&'a [u8]> {
    let marker = format!("--{boundary}");
    let marker = marker.as_bytes();
    let mut starts = Vec::new();
    let mut i = 0;
    while i + marker.len() <= body.len() {
        if &body[i..i + marker.len()] == marker && (i == 0 || body[i - 1] == b'\n') {
            starts.push(i);
            i += marker.len();
        } else {
            i += 1;
        }
    }
    let mut parts = Vec::new();
    for (n, &start) in starts.iter().enumerate() {
        let after = start + marker.len();
        if body.get(after..after + 2) == Some(b"--") {
            break;
        }
        let end = starts.get(n + 1).copied().unwrap_or(body.len());
        let part = &body[after..end];
        let part = part.strip_prefix(b"\r\n").or_else(|| part.strip_prefix(b"\n")).unwrap_or(part);
        parts.push(part);
    }
    parts
}

/// A part's headers and its content, split at the first blank line.
fn split_head(part: &[u8]) -> (&[u8], &[u8]) {
    for (i, w) in part.windows(2).enumerate() {
        if w == b"\n\n" {
            return (&part[..i], &part[i + 2..]);
        }
        if w == b"\n\r" && part.get(i + 2) == Some(&b'\n') {
            return (&part[..i], &part[i + 3..]);
        }
    }
    (part, &[])
}

/// HTML as text: no styles, scripts or tags, the common entities read.
pub fn strip_html(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let lower = html.to_ascii_lowercase();
    let mut i = 0;
    let bytes = html.as_bytes();
    while i < bytes.len() {
        if bytes[i] == b'<' {
            for skip in ["<style", "<script", "<head"] {
                if lower[i..].starts_with(skip) {
                    let close = format!("</{}", &skip[1..]);
                    i = lower[i..].find(&close).map(|e| i + e).unwrap_or(bytes.len());
                    break;
                }
            }
            if i >= bytes.len() {
                break;
            }
            let tag_end = html[i..].find('>').map(|e| i + e + 1).unwrap_or(bytes.len());
            let tag = &lower[i..tag_end];
            if tag.starts_with("<br") || tag.starts_with("<p") || tag.starts_with("</p") || tag.starts_with("<div") || tag.starts_with("</div") || tag.starts_with("<tr") || tag.starts_with("<li") {
                out.push('\n');
            }
            i = tag_end;
            continue;
        }
        let next = html[i..].find('<').map(|e| i + e).unwrap_or(bytes.len());
        out.push_str(&html[i..next]);
        i = next;
    }
    entities(&out)
}

/// `&rsquo;`, `&#8217;`, `&#x2019;` and the other common entities, read.
pub fn entities(text: &str) -> String {
    const NAMED: &[(&str, &str)] = &[
        ("nbsp", " "), ("lt", "<"), ("gt", ">"), ("quot", "\""), ("apos", "'"), ("amp", "&"),
        ("zwnj", ""), ("zwj", ""), ("shy", ""), ("lsquo", "‘"), ("rsquo", "’"), ("ldquo", "“"),
        ("rdquo", "”"), ("laquo", "«"), ("raquo", "»"), ("hellip", "…"), ("ndash", "–"), ("mdash", "—"),
        ("euro", "€"), ("pound", "£"), ("copy", "©"), ("reg", "®"), ("trade", "™"), ("deg", "°"),
        ("middot", "·"), ("bull", "•"), ("agrave", "à"), ("aacute", "á"), ("egrave", "è"),
        ("eacute", "é"), ("igrave", "ì"), ("iacute", "í"), ("ograve", "ò"), ("oacute", "ó"),
        ("ugrave", "ù"), ("uacute", "ú"), ("Agrave", "À"), ("Egrave", "È"), ("Eacute", "É"),
        ("ccedil", "ç"), ("ntilde", "ñ"), ("auml", "ä"), ("ouml", "ö"), ("uuml", "ü"), ("szlig", "ß"),
    ];
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let end = tail[1..].find(|c: char| c == ';' || c.is_whitespace() || c == '&').map(|e| e + 1);
        let decoded = end.filter(|&e| tail.as_bytes().get(e) == Some(&b';') && e <= 12).and_then(|e| {
            let name = &tail[1..e];
            let code = if let Some(hex) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
                u32::from_str_radix(hex, 16).ok()
            } else if let Some(dec) = name.strip_prefix('#') {
                dec.parse::<u32>().ok()
            } else {
                None
            };
            let text = match code {
                // 128–159 are Windows-1252's, as browsers read them (`&#146;` is ’).
                Some(c @ 0x80..=0x9F) => Some(cp1252(c as u8).to_string()),
                Some(c) => char::from_u32(c).map(|ch| if ch == '\u{a0}' { " ".to_string() } else { ch.to_string() }),
                None => NAMED.iter().find(|(n, _)| *n == name).map(|(_, v)| v.to_string()),
            };
            text.map(|t| (t, e + 1))
        });
        match decoded {
            Some((t, used)) => {
                out.push_str(&t);
                rest = &tail[used..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Lines trimmed, runs of blank lines down to one, quoted replies cut off.
fn tidy(text: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        // What follows "On … wrote:" / "> …" is the conversation before.
        if line.starts_with('>') {
            break;
        }
        if line.is_empty() && out.last().is_none_or(|l| l.is_empty()) {
            continue;
        }
        out.push(line);
    }
    while out.last().is_some_and(|l| l.is_empty()) {
        out.pop();
    }
    out.join("\n")
}

fn preview(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= PREVIEW_CHARS {
        return flat;
    }
    let cut: String = flat.chars().take(PREVIEW_CHARS).collect();
    format!("{}…", cut.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_comes_from_the_address_unless_typed() {
        assert_eq!(server_of("", "ada@gmail.com"), ("imap.gmail.com".into(), 993));
        assert_eq!(server_of("", "ada@outlook.it"), ("outlook.office365.com".into(), 993));
        assert_eq!(server_of("", "ada@example.org"), ("imap.example.org".into(), 993));
        assert_eq!(server_of("Mail.Example.org:1993", "ada@gmail.com"), ("mail.example.org".into(), 1993));
        assert_eq!(server_of("imaps://imap.example.org/", "x"), ("imap.example.org".into(), 993));
    }

    #[test]
    fn literals_are_announced_at_the_end_of_a_line() {
        assert_eq!(literal_size("* 1 FETCH (UID 4 BODY[TEXT]<0> {120}"), Some(120));
        assert_eq!(literal_size("* OK hello"), None);
        assert_eq!(literal_size("a {12+}"), Some(12));
    }

    #[test]
    fn imap_strings_are_quoted() {
        assert_eq!(quoted(r#"pa"ss\word"#), r#""pa\"ss\\word""#);
    }

    #[test]
    fn encoded_headers_are_read() {
        assert_eq!(decode_words("=?UTF-8?B?Q2lhbyDwn5GL?="), "Ciao 👋");
        assert_eq!(decode_words("=?ISO-8859-1?Q?Caf=E9_ouvert?= today"), "Café ouvert today");
        assert_eq!(decode_words("=?UTF-8?Q?a?= =?UTF-8?Q?b?="), "ab");
        assert_eq!(decode_words("Plain subject"), "Plain subject");
    }

    #[test]
    fn html_entities_are_read() {
        assert_eq!(entities("McDonald&rsquo;s &amp; co &#8217; &#x2019; &egrave; &unknown; 5 & 6"), "McDonald’s & co ’ ’ è &unknown; 5 & 6");
        assert_eq!(strip_html("<p>Caff&egrave;&nbsp;<b>pronto</b></p>").trim(), "Caffè pronto");
    }

    #[test]
    fn windows_1252_reads_as_it_should() {
        // "McDonald’s" with the curly apostrophe of Windows-1252, encoded or raw.
        assert_eq!(decode_words("=?windows-1252?Q?McDonald=92s_Italia?="), "McDonald’s Italia");
        assert_eq!(decode_words("=?ISO-8859-1?Q?McDonald=92s?="), "McDonald’s");
        assert_eq!(parse_headers(b"From: McDonald\x92s <a@b.c>\r\n")[0].1, "McDonald’s <a@b.c>");
        assert_eq!(in_charset(b"Prezzo 5\x80", "unknown-8bit"), "Prezzo 5€");
        assert_eq!(in_charset("Caffè".as_bytes(), "iso-8859-1"), "Caffè");
        assert_eq!(in_charset(b"\xA4 10", "iso-8859-15"), "€ 10");
    }

    #[test]
    fn real_senders_and_subjects_read_right() {
        let from = |raw: &str| clean_header(&parse_from(&decode_words(raw)).0);
        let subject = |raw: &str| clean_header(&decode_words(raw));
        // The curly apostrophe, in every way it comes.
        assert_eq!(from("=?UTF-8?Q?McDonald=E2=80=99s_Italia?= <news@mcdonalds.it>"), "McDonald’s Italia");
        assert_eq!(from("=?utf-8?B?TWNEb25hbGTigJlzIEl0YWxpYQ==?= <news@mcdonalds.it>"), "McDonald’s Italia");
        assert_eq!(from("\"=?UTF-8?Q?McDonald=E2=80=99s?= Italia\" <news@mcdonalds.it>"), "McDonald’s Italia");
        assert_eq!(from("=?windows-1252?Q?McDonald=92s_Italia?= <a@b.it>"), "McDonald’s Italia");
        // Its bytes split across two words, in Q or in B.
        assert_eq!(from("=?UTF-8?Q?McDonald=E2=80?= =?UTF-8?Q?=99s_Italia?= <a@b.it>"), "McDonald’s Italia");
        assert_eq!(from("=?UTF-8?B?TWNEb25hbGTi?=\r\n =?UTF-8?B?gJlzIEl0YWxpYQ==?= <a@b.it>"), "McDonald’s Italia");
        // UTF-8 read as Windows-1252 before it got here, and the "ÿ" some mailers leave.
        assert_eq!(from("McDonaldâ€™s Italia <a@b.it>"), "McDonald’s Italia");
        assert_eq!(from("McDonaldÿs Italia <a@b.it>"), "McDonald’s Italia");
        assert_eq!(subject("L&#146;offerta &amp; il regalo"), "L’offerta & il regalo");
        assert_eq!(subject("Aÿ, L'Haÿ-les-Roses"), "Aÿ, L'Haÿ-les-Roses");
        // Quotes, Italian accents and emoji.
        assert_eq!(subject("=?UTF-8?Q?=E2=80=9CSaldi=E2=80=9D_fino_al_50%_=E2=80=94_cos=C3=AC_=C3=A8_pi=C3=B9_facile?="), "“Saldi” fino al 50% — così è più facile");
        assert_eq!(subject("=?ISO-8859-1?Q?Perch=E9_s=EC=2C_citt=E0?="), "Perché sì, città");
        assert_eq!(subject("=?UTF-8?B?8J+OgSBVbiBwaWNjb2xvIHJlZ2FsbyBwZXIgdGUg8J+Ogg==?="), "🎁 Un piccolo regalo per te 🎂");
        assert_eq!(subject("=?utf-8?q?Huntr/x_o_Saja_Boys=3F?="), "Huntr/x o Saja Boys?");
        assert_eq!(subject("Re: =?UTF-8?Q?Caff=C3=A8?= domani"), "Re: Caffè domani");
        // UTF-16, rare but seen.
        assert_eq!(subject("=?UTF-16?B?/v8AQwBpAGEAbwAgIBk=?="), "Ciao ’");
        // A stray Latin-1 byte does not spoil the UTF-8 around it.
        assert_eq!(in_charset(b"Caff\xE8 \xE2\x80\x99", "utf-8"), "Caffè ’");
    }

    #[test]
    fn bodies_in_any_charset_read_right() {
        let qp = b"Content-Type: text/plain; charset=utf-8\r\n\r\nL=E2=80=99offerta =C3=A8 qui =F0=9F=8E=89";
        let (_, body) = split_head(qp);
        assert_eq!(extract_text("text/plain; charset=utf-8", "quoted-printable", body), "L’offerta è qui 🎉");
        assert_eq!(extract_text("text/plain; charset=\"windows-1252\"", "quoted-printable", b"Citt=E0 =96 l=92ora"), "Città – l’ora");
        assert_eq!(extract_text("text/html; charset=iso-8859-1", "", b"<p>Perch&eacute; l&#8217;ho &#146;detto&#148;</p>").trim(), "Perché l’ho ’detto”");
    }

    #[test]
    fn the_sender_is_split_into_name_and_address() {
        assert_eq!(parse_from("\"Ada Lovelace\" <ada@example.com>"), ("Ada Lovelace".into(), "ada@example.com".into()));
        assert_eq!(parse_from("<ada@example.com>"), ("ada@example.com".into(), "ada@example.com".into()));
        assert_eq!(parse_from("ada@example.com"), ("ada@example.com".into(), "ada@example.com".into()));
    }

    #[test]
    fn plain_text_is_preferred_and_decoded() {
        let body = b"--b1\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello <b>HTML</b></p>\r\n--b1\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaff=C3=A8 alle 10?\r\n--b1--\r\n";
        assert_eq!(extract_text("multipart/alternative; boundary=\"b1\"", "", body).trim(), "Caffè alle 10?");
        let html_only = b"--x\r\nContent-Type: text/html\r\nContent-Transfer-Encoding: base64\r\n\r\nPHA+SGVsbG8gJmFtcDsgYnllPC9wPg==\r\n--x--";
        assert_eq!(extract_text("multipart/mixed; boundary=x", "", html_only).trim(), "Hello & bye");
    }

    #[test]
    fn nested_parts_and_cut_off_bodies_still_give_text() {
        let body = b"--outer\r\nContent-Type: multipart/alternative; boundary=inner\r\n\r\n--inner\r\nContent-Type: text/plain\r\n\r\nInside\r\n--inner--\r\n--outer\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment\r\n\r\nJVBER";
        assert_eq!(extract_text("multipart/mixed; boundary=outer", "", body).trim(), "Inside");
        // Base64 cut in the middle of a group.
        assert_eq!(base64(b"SGVsbG8gd29y"), b"Hello wor");
        assert_eq!(base64(b"SGVsbG8gd29yb"), b"Hello wor");
    }

    #[test]
    fn quoted_replies_and_blank_runs_go() {
        assert_eq!(tidy("Hi\n\n\n  there \n> old\n> older"), "Hi\n\nthere");
    }

    #[test]
    fn a_fetch_answer_becomes_a_message() {
        let header = b"From: =?UTF-8?Q?Jos=C3=A9?= <jose@example.com>\r\nSubject: Lunch\r\nMessage-ID: <abc@mail.gmail.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n".to_vec();
        let unit = vec![
            Part::Text("* 3 FETCH (UID 42 BODY[HEADER.FIELDS (FROM SUBJECT)] {10}".into()),
            Part::Literal(header),
            Part::Text(" BODY[TEXT]<0> {5}".into()),
            Part::Literal(b"Hey!\n".to_vec()),
            Part::Text(")".into()),
        ];
        let m = parse_fetch(&unit, "imap.gmail.com").unwrap();
        assert_eq!(m.id, "imap.gmail.com:42");
        assert_eq!(m.from, "José");
        assert_eq!(m.address, "jose@example.com");
        assert_eq!(m.subject, "Lunch");
        assert_eq!(m.preview, "Hey!");
        assert_eq!(m.link.as_deref(), Some("https://mail.google.com/mail/u/0/#search/rfc822msgid%3Aabc%40mail.gmail.com"));
        assert_eq!(uid_of(&m.id), Some(42));
    }

    #[test]
    fn a_refused_sign_in_says_what_to_do() {
        let gmail = "[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)";
        assert!(sign_in_error("imap.gmail.com", gmail).contains("myaccount.google.com/apppasswords"));
        assert_eq!(sign_in_error("x", "[AUTHENTICATIONFAILED] Invalid credentials (Failure)"), "The address or the app password is wrong.");
        assert_eq!(
            sign_in_error("imap.example.org", "[UNAVAILABLE] Try later: https://example.org/status (Failure)"),
            "imap.example.org refused to sign in: Try later"
        );
    }

    #[test]
    fn search_answers_list_uids() {
        let units = vec![vec![Part::Text("* SEARCH 4 9 12".into())], vec![Part::Text("* OK".into())]];
        assert_eq!(search_uids(&units), vec![4, 9, 12]);
    }
}
