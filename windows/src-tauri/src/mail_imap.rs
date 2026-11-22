// IMAP itself, for the Email pill (mail.rs): the server of an address, a TLS
// connection to the server the user typed, signing in, the commands and their
// answers, and a FETCH answer read into an email (mail_parse.rs).

use std::sync::Arc;

use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_rustls::rustls::{self, pki_types::ServerName, ClientConfig, RootCertStore};
use tokio_rustls::{client::TlsStream, TlsConnector};

use crate::i18n::{t, tf};
use crate::log;
use crate::mail::{idle_for, outlook_personal, timed_for, BODY_BYTES, BODY_CHARS, FETCH, IDLE_ANSWER, MAX_READ, Message, WAKE};
use crate::mail_agents::uid_of;
use crate::mail_parse::{clean_header, decode_words, extract_text, parse_from, parse_headers, preview, tidy};

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
        // Outlook.com, on any country's ending (hotmail.co.uk, outlook.de…).
        _ if outlook_personal(&domain, "") => "outlook.office365.com".to_string(),
        "icloud.com" | "me.com" | "mac.com" => "imap.mail.me.com".to_string(),
        "yahoo.com" | "yahoo.it" | "ymail.com" => "imap.mail.yahoo.com".to_string(),
        "libero.it" => "imapmail.libero.it".to_string(),
        "aol.com" => "imap.aol.com".to_string(),
        d => format!("imap.{d}"),
    };
    (host, 993)
}

pub(crate) fn is_gmail(host: &str) -> bool {
    host.ends_with("gmail.com") || host.ends_with("googlemail.com")
}

pub(crate) fn inbox_link(host: &str) -> Option<String> {
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
pub(crate) enum Part {
    Text(String),
    Literal(Vec<u8>),
}

pub(crate) struct Imap {
    stream: BufReader<TlsStream<TcpStream>>,
    tag: u32,
    pub(crate) read: usize,
    /// What may be read before `read` is reset: MAX_READ, more for a file attached.
    pub(crate) limit: usize,
    pub(crate) capabilities: Vec<String>,
    /// The line being read: an IDLE that stops waiting in the middle of one
    /// (woken, or its time up) finds the rest of it next time.
    pending: Vec<u8>,
}

pub(crate) fn tls() -> Result<Arc<ClientConfig>, String> {
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
        let mut imap = Imap { stream: BufReader::new(stream), tag: 0, read: 0, limit: MAX_READ, capabilities: Vec::new(), pending: Vec::new() };
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
            // A line never reads past what is left to read: a server that never
            // ends one cannot fill the memory before `count` stops it.
            let room = self.limit.saturating_sub(self.read).saturating_sub(self.pending.len()).saturating_add(1) as u64;
            let n = (&mut self.stream).take(room).read_until(b'\n', &mut self.pending).await.map_err(|e| e.to_string())?;
            if n == 0 {
                self.pending.clear();
                return Err(t("The mail server closed the connection."));
            }
            let line = std::mem::take(&mut self.pending);
            self.count(line.len())?;
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
        // Saturating: a literal announced as {18446744073709551615} is too much,
        // never a wrap back to a small number.
        self.read = self.read.saturating_add(n);
        if self.read > self.limit {
            return Err(t("The mail server sent too much."));
        }
        Ok(())
    }

    /// Sends a command; the untagged answers, or why the server said no.
    pub(crate) async fn run(&mut self, command: &str) -> Result<Vec<Vec<Part>>, String> {
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
    /// `run`, with a string sent as a literal after the command: the
    /// server's "+" first, then its bytes.
    pub(crate) async fn run_literal(&mut self, command: &str, literal: &str) -> Result<Vec<Vec<Part>>, String> {
        self.tag += 1;
        let tag = format!("L{}", self.tag);
        self.send(&format!("{tag} {command} {{{}}}\r\n", literal.len())).await?;
        loop {
            let unit = self.read_unit().await?;
            match unit.first() {
                Some(Part::Text(line)) if line.starts_with('+') => break,
                Some(Part::Text(line)) if line.starts_with(&format!("{tag} ")) => {
                    let rest = &line[tag.len() + 1..];
                    return Err(rest.split_once(' ').map_or(rest, |x| x.1).trim().to_string());
                }
                _ => {}
            }
        }
        self.send(&format!("{literal}\r\n")).await?;
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

    async fn send(&mut self, line: &str) -> Result<(), String> {
        let stream = self.stream.get_mut();
        stream.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        stream.flush().await.map_err(|e| e.to_string())
    }

    /// Waits in IDLE until the server says the mailbox changed, Lumo is
    /// woken, or idle_for() goes by; then ends the IDLE.
    pub(crate) async fn idle(&mut self, host: &str) -> Result<(), String> {
        self.tag += 1;
        let tag = format!("L{}", self.tag);
        self.send(&format!("{tag} IDLE\r\n")).await?;
        timed_for(IDLE_ANSWER, host, self.idling(&tag)).await?;
        let deadline = tokio::time::Instant::now() + idle_for();
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
        timed_for(IDLE_ANSWER, host, self.done(&tag)).await
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

/// Both futures, run together, and both their outputs.
pub(crate) async fn both<A: std::future::Future, B: std::future::Future>(a: A, b: B) -> (A::Output, B::Output) {
    let mut a = std::pin::pin!(a);
    let mut b = std::pin::pin!(b);
    let (mut got_a, mut got_b) = (None, None);
    std::future::poll_fn(|cx| {
        if got_a.is_none() {
            if let std::task::Poll::Ready(v) = a.as_mut().poll(cx) {
                got_a = Some(v);
            }
        }
        if got_b.is_none() {
            if let std::task::Poll::Ready(v) = b.as_mut().poll(cx) {
                got_b = Some(v);
            }
        }
        if got_a.is_some() && got_b.is_some() {
            if let (Some(a), Some(b)) = (got_a.take(), got_b.take()) {
                return std::task::Poll::Ready((a, b));
            }
        }
        std::task::Poll::Pending
    })
    .await
}

/// `{123}` at the end of a line announces 123 bytes that follow it.
pub(crate) fn literal_size(line: &str) -> Option<usize> {
    let open = line.strip_suffix('}')?.rfind('{')?;
    line[open + 1..line.len() - 1].trim_end_matches('+').parse().ok()
}

/// A string as IMAP takes it: quoted, with `\` and `"` escaped.
pub(crate) fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Connected, signed in, the inbox open read only.
pub(crate) async fn sign_in(host: &str, port: u16, address: &str, password: &str) -> Result<Imap, String> {
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

/// Settings → Pills → Email: the promotional emails are left out.
pub(crate) fn hides_promotions(app: &AppHandle) -> bool {
    app.try_state::<crate::Shared>()
        .map(|shared| shared.settings.lock().unwrap().mail_hide_promotions)
        .unwrap_or(false)
}

/// The search for the unread emails: all of them, or without the promotional
/// ones — on Gmail its own Promotions category, elsewhere the emails that carry
/// an unsubscribe link (List-Unsubscribe, RFC 2369: newsletters and offers).
fn unseen_search(host: &str, hide_promotions: bool) -> &'static str {
    if !hide_promotions {
        "UID SEARCH UNSEEN"
    } else if is_gmail(host) {
        "UID SEARCH UNSEEN X-GM-RAW \"-category:promotions\""
    } else {
        "UID SEARCH UNSEEN NOT HEADER List-Unsubscribe \"\""
    }
}

/// The unread count and the newest unread emails; `known` keeps the ones
/// already fetched on this connection, so only new ones are asked for.
pub(crate) async fn look(
    imap: &mut Imap,
    host: &str,
    hide_promotions: bool,
    known: &mut std::collections::HashMap<u32, Message>,
) -> Result<(usize, Vec<Message>), String> {
    let search = unseen_search(host, hide_promotions);
    let found = match imap.run(search).await {
        Ok(found) => found,
        // A server that cannot filter so still lists every unread email.
        Err(why) if search != "UID SEARCH UNSEEN" => {
            log::line(format!("[mail] {host} cannot leave out the promotions: {why}"));
            imap.run("UID SEARCH UNSEEN").await?
        }
        Err(why) => return Err(why),
    };
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

pub(crate) fn search_uids(units: &[Vec<Part>]) -> Vec<u32> {
    units
        .iter()
        .filter_map(|u| match u.first() {
            Some(Part::Text(line)) => line.strip_prefix("* SEARCH"),
            _ => None,
        })
        .flat_map(|rest| rest.split_whitespace().filter_map(|n| n.parse().ok()).collect::<Vec<u32>>())
        .collect()
}

pub(crate) fn parse_fetch(unit: &[Part], host: &str) -> Option<Message> {
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
    // A FETCH the server sent on its own (another client changed a flag):
    // UID and FLAGS only, no email to show in place of the one known.
    if header.is_empty() {
        return None;
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
    fn promotions_are_left_out_only_when_asked() {
        assert_eq!(unseen_search("imap.gmail.com", false), "UID SEARCH UNSEEN");
        assert_eq!(unseen_search("imap.example.com", false), "UID SEARCH UNSEEN");
        assert_eq!(unseen_search("imap.gmail.com", true), r#"UID SEARCH UNSEEN X-GM-RAW "-category:promotions""#);
        assert_eq!(unseen_search("imap.example.com", true), r#"UID SEARCH UNSEEN NOT HEADER List-Unsubscribe """#);
    }

    #[test]
    fn imap_strings_are_quoted() {
        assert_eq!(quoted(r#"pa"ss\word"#), r#""pa\"ss\\word""#);
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
        // Another client marked it read meanwhile: the server says so on its own.
        let flags = vec![Part::Text("* 3 FETCH (UID 42 FLAGS (\\Seen))".into())];
        assert!(parse_fetch(&flags, "imap.gmail.com").is_none());
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
