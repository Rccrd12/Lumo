// The Email pill: new messages in the user's inbox, read over IMAP with an app
// password (Gmail, Outlook, iCloud, any IMAP server), for the closed island's
// email preview and the pill's card.
//
// Read only, by construction: the inbox is opened with EXAMINE (the server
// refuses any change to it), message bodies are fetched with BODY.PEEK (they
// stay unread), and there is no command here that sends, moves or deletes
// anything. The address, the server and the app password are in the credential
// store (secrets.rs); the connection is TLS only, to the server the user typed.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
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

/// A whole check: connect, sign in, look, sign out.
const TIMEOUT: Duration = Duration::from_secs(25);
/// What one check may read from the server, all answers together.
const MAX_READ: usize = 4 * 1024 * 1024;
/// The newest unread messages fetched each time.
const FETCH: usize = 5;
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

// ── The poller ────────────────────────────────────────────────────────────────

pub async fn poll(app: AppHandle) {
    let Some((address, password)) = secrets::get(ADDRESS_KEY).zip(secrets::get(PASSWORD_KEY)) else { return };
    let server = secrets::get(SERVER_KEY).unwrap_or_default();
    let (host, port) = server_of(&server, &address);
    let checked = tokio::time::timeout(TIMEOUT, check(&host, port, &address, &password)).await;
    let (unread, messages) = match checked {
        Ok(Ok(found)) => found,
        Ok(Err(error)) => return fail(&app, error),
        Err(_) => return fail(&app, tf("{server} did not answer in time.", &[("server", &host)])),
    };
    let account = format!("{address}@{host}");
    let newest = messages.iter().filter_map(|m| uid_of(&m.id)).max().unwrap_or(0);
    let fresh: Vec<Message> = {
        let mut last = LAST_UID.lock().unwrap();
        let fresh = match last.as_ref() {
            Some((seen_account, seen)) if *seen_account == account => {
                messages.iter().filter(|m| uid_of(&m.id).is_some_and(|u| u > *seen)).cloned().collect()
            }
            _ => Vec::new(),
        };
        let floor = match last.as_ref() {
            Some((a, seen)) if *a == account => *seen,
            _ => 0,
        };
        *last = Some((account, newest.max(floor)));
        fresh
    };
    let link = inbox_link(&host);
    emit(&app, IntegrationUpdate {
        id: ID,
        data: json!({ "messages": messages, "unread": unread, "inbox": link }),
        error: None,
        event: None,
    });
    if !fresh.is_empty() {
        let _ = app.emit_to(WINDOW_LABEL, "mail-new", &fresh);
    }
}

fn fail(app: &AppHandle, error: String) {
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
        let mut imap = Imap { stream: BufReader::new(stream), tag: 0, read: 0 };
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

/// `{123}` at the end of a line announces 123 bytes that follow it.
fn literal_size(line: &str) -> Option<usize> {
    let open = line.strip_suffix('}')?.rfind('{')?;
    line[open + 1..line.len() - 1].trim_end_matches('+').parse().ok()
}

/// A string as IMAP takes it: quoted, with `\` and `"` escaped.
fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

async fn check(host: &str, port: u16, address: &str, password: &str) -> Result<(usize, Vec<Message>), String> {
    let mut imap = Imap::connect(host, port).await?;
    // App passwords are shown with spaces ("abcd efgh ijkl mnop"); Google takes them either way.
    imap.run(&format!("LOGIN {} {}", quoted(address.trim()), quoted(password.trim())))
        .await
        .map_err(|why| tf("{server} refused to sign in: {error}", &[("server", host), ("error", &why)]))?;
    imap.run("EXAMINE INBOX").await?;
    let found = imap.run("UID SEARCH UNSEEN").await?;
    let mut uids = search_uids(&found);
    let unread = uids.len();
    uids.sort_unstable();
    let newest: Vec<u32> = uids.iter().rev().take(FETCH).copied().collect();
    let mut messages = Vec::new();
    if !newest.is_empty() {
        let set = newest.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let fetched = imap
            .run(&format!(
                "UID FETCH {set} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID CONTENT-TYPE CONTENT-TRANSFER-ENCODING)] BODY.PEEK[TEXT]<0.{BODY_BYTES}>)"
            ))
            .await?;
        for unit in &fetched {
            if let Some(m) = parse_fetch(unit, host) {
                messages.push(m);
            }
        }
        messages.sort_by_key(|m| std::cmp::Reverse(uid_of(&m.id).unwrap_or(0)));
    }
    let _ = imap.run("LOGOUT").await;
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
    let subject = decode_words(field("Subject"));
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
    let text = String::from_utf8_lossy(raw);
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

/// RFC 2047 words (`=?UTF-8?B?…?=`) in a header, decoded; the space between two of them goes.
pub fn decode_words(raw: &str) -> String {
    let mut out = String::new();
    let mut rest = raw;
    let mut last_was_word = false;
    while let Some(start) = rest.find("=?") {
        let (plain, tail) = rest.split_at(start);
        let decoded = decode_word(tail);
        match decoded {
            Some((text, used)) => {
                if !(last_was_word && plain.trim().is_empty()) {
                    out.push_str(plain);
                }
                out.push_str(&text);
                rest = &tail[used..];
                last_was_word = true;
            }
            None => {
                out.push_str(plain);
                out.push_str("=?");
                rest = &tail[2..];
                last_was_word = false;
            }
        }
    }
    out.push_str(rest);
    out
}

/// One encoded word at the start of `s`: its text and how many bytes it took.
fn decode_word(s: &str) -> Option<(String, usize)> {
    let inner = s.strip_prefix("=?")?;
    let (charset, inner) = inner.split_once('?')?;
    let (encoding, inner) = inner.split_once('?')?;
    let end = inner.find("?=")?;
    let payload = &inner[..end];
    let bytes = match encoding.to_ascii_uppercase().as_str() {
        "B" => base64(payload.as_bytes()),
        "Q" => quoted_printable(payload.replace('_', " ").as_bytes()),
        _ => return None,
    };
    let used = 2 + charset.len() + 1 + encoding.len() + 1 + end + 2;
    Some((in_charset(&bytes, charset), used))
}

/// Bytes in the given charset, as text: UTF-8, Latin-1 and Windows-1252 (as
/// Latin-1); anything else is read as UTF-8.
fn in_charset(bytes: &[u8], charset: &str) -> String {
    let cs = charset.trim().trim_matches('"').to_ascii_lowercase();
    let cs = cs.split('*').next().unwrap_or(&cs);
    if matches!(cs, "iso-8859-1" | "iso8859-1" | "latin1" | "latin-1" | "windows-1252" | "cp1252" | "iso-8859-15")
        && std::str::from_utf8(bytes).is_err()
    {
        return bytes.iter().map(|&b| b as char).collect();
    }
    String::from_utf8_lossy(bytes).into_owned()
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
    out.replace("&nbsp;", " ")
        .replace("&#160;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&zwnj;", "")
        .replace("&amp;", "&")
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
    fn search_answers_list_uids() {
        let units = vec![vec![Part::Text("* SEARCH 4 9 12".into())], vec![Part::Text("* OK".into())]];
        assert_eq!(search_uids(&units), vec![4, 9, 12]);
    }
}
