// Sending an email for the AI, once the user clicked Send on its card
// (mail.rs serve, `mail_send`): Settings → General → Security → Email set to
// "Read and send". Nothing here decides whether to send: it only sends.
//
// It speaks SMTP to the account's own server with the address and app
// password the Email pill already reads the inbox with (secrets.rs), over TLS
// from the first byte (port 465) or after STARTTLS (587), with the same
// rustls and root certificates as the IMAP side. The email is plain text,
// UTF-8, its body in base64; with files attached it is multipart/mixed, the
// text first, then each file in base64. A reply carries In-Reply-To and
// References, so it lands in the conversation. Gmail keeps a copy in Sent by
// itself; for the others mail.rs puts one there over IMAP when the server
// didn't (`sent_copy`).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio_rustls::rustls::pki_types::ServerName;
use tokio_rustls::TlsConnector;

use crate::claude::base64_for;

/// The whole exchange, from connecting to QUIT.
const TIMEOUT: Duration = Duration::from_secs(60);
/// What one answer of the server may weigh.
const MAX_REPLY: usize = 64 * 1024;
/// At most this many people, To and Cc together.
pub const MAX_RECIPIENTS: usize = 20;
pub const MAX_SUBJECT: usize = 300;
pub const MAX_BODY: usize = 100_000;
/// At most this many files attached.
pub const MAX_ATTACHMENTS: usize = 10;
/// The files attached weigh at most this together: in base64 they stay under
/// the 25 MB Gmail and Outlook take.
pub const MAX_ATTACHED_BYTES: u64 = 18 * 1024 * 1024;

/// A file attached to an email.
#[derive(Debug, Clone, PartialEq)]
pub struct Attachment {
    pub name: String,
    pub mime: &'static str,
    pub bytes: Vec<u8>,
}

/// One email to send.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Outgoing {
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub subject: String,
    pub body: String,
    pub attachments: Vec<Attachment>,
    /// A reply: the Message-ID it answers (`<…>`), and the conversation's References.
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
}

/// An email that went: the server it went through, the email as it went
/// (for the copy in Sent) and its Message-ID.
pub struct Sent {
    pub host: String,
    pub data: String,
    pub message_id: String,
}

/// Message-IDs as a header takes them: only `<…>` with nothing in them that
/// could end the header or start another one.
pub fn message_ids(raw: &str) -> String {
    raw.split_whitespace()
        .filter(|id| id.len() > 2 && id.starts_with('<') && id.ends_with('>') && id[1..id.len() - 1].chars().all(|c| c.is_ascii_graphic() && c != '<' && c != '>'))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The MIME type of a file attached, by its extension.
pub fn mime_of(name: &str) -> &'static str {
    if let Some(mime) = crate::files::image_mime(std::path::Path::new(name)) {
        return mime;
    }
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

/// A file name as RFC 2231 has it in `filename*=`: UTF-8, anything but
/// letters, digits and a few marks as %XX.
fn percent_name(name: &str) -> String {
    name.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// `bytes` in base64 lines of 76, each ended by CRLF.
fn base64_lines(out: &mut String, bytes: &[u8]) {
    let encoded = base64_for(bytes);
    for line in encoded.as_bytes().chunks(76) {
        out.push_str(std::str::from_utf8(line).unwrap_or(""));
        out.push_str("\r\n");
    }
}

/// A plain address: something@somewhere, nothing that could end a command or
/// a header (spaces, line breaks, `<>`, commas…).
pub fn valid_address(a: &str) -> bool {
    let Some((user, domain)) = a.split_once('@') else { return false };
    !user.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && a.len() <= 254
        && !domain.contains('@')
        && a.chars().all(|c| c.is_ascii_graphic() && !"<>()[],;:\\\"".contains(c))
}

/// The server to send through, for the account's address and the IMAP server
/// the user typed (or none): the usual one for the big providers, else the
/// IMAP server's `smtp.` sibling. 465 is TLS at once, 587 STARTTLS.
pub fn server_of(imap_typed: &str, address: &str) -> (String, u16) {
    let (imap, _) = crate::mail::server_of(imap_typed, address);
    match imap.as_str() {
        "imap.gmail.com" => return ("smtp.gmail.com".into(), 465),
        "outlook.office365.com" => {
            let domain = address.rsplit('@').next().unwrap_or("").to_ascii_lowercase();
            // Outlook.com's own addresses, else a work or school account.
            let personal = ["outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.it", "hotmail.it", "live.it"];
            return (if personal.contains(&domain.as_str()) { "smtp-mail.outlook.com" } else { "smtp.office365.com" }.into(), 587);
        }
        "imap.mail.me.com" => return ("smtp.mail.me.com".into(), 587),
        "imap.mail.yahoo.com" => return ("smtp.mail.yahoo.com".into(), 465),
        "imapmail.libero.it" => return ("smtp.libero.it".into(), 465),
        "imap.aol.com" => return ("smtp.aol.com".into(), 465),
        _ => {}
    }
    match imap.strip_prefix("imap.") {
        Some(rest) => (format!("smtp.{rest}"), 465),
        None => (format!("smtp.{}", address.rsplit('@').next().unwrap_or("").trim().to_ascii_lowercase()), 465),
    }
}

/// `secs` since the epoch as an email's Date: "Wed, 28 Oct 2026 21:51:05 +0000".
fn date(secs: u64) -> String {
    const DAYS: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    // "2026-10-28T21:51:05Z"
    let iso = crate::live::rfc3339(secs);
    let (y, m, d) = (&iso[0..4], iso[5..7].parse::<usize>().unwrap_or(1), &iso[8..10]);
    let weekday = DAYS[((secs / 86_400) % 7) as usize];
    format!("{weekday}, {} {} {y} {} +0000", d.trim_start_matches('0'), MONTHS[m - 1], &iso[11..19])
}

/// A header's words: as they are in plain ASCII, else as RFC 2047 encoded
/// words of whole characters, each line short enough for any server.
fn header_text(text: &str) -> String {
    if text.chars().all(|c| (' '..='~').contains(&c)) {
        return text.to_string();
    }
    let mut words = Vec::new();
    let mut chunk = String::new();
    for c in text.chars() {
        if chunk.len() + c.len_utf8() > 45 {
            words.push(format!("=?UTF-8?B?{}?=", base64_for(chunk.as_bytes())));
            chunk.clear();
        }
        chunk.push(c);
    }
    if !chunk.is_empty() {
        words.push(format!("=?UTF-8?B?{}?=", base64_for(chunk.as_bytes())));
    }
    words.join("\r\n ")
}

/// The email as it goes after DATA: headers, then the text in base64 lines,
/// which never start with a dot (nothing to escape).
pub fn message(from: &str, mail: &Outgoing, secs: u64, id: &str) -> String {
    let mut out = String::new();
    out.push_str(&format!("From: {from}\r\n"));
    // A draft may have nobody yet.
    if !mail.to.is_empty() {
        out.push_str(&format!("To: {}\r\n", mail.to.join(", ")));
    }
    if !mail.cc.is_empty() {
        out.push_str(&format!("Cc: {}\r\n", mail.cc.join(", ")));
    }
    let subject: String = mail.subject.chars().filter(|c| !c.is_control()).collect();
    out.push_str(&format!("Subject: {}\r\n", header_text(&subject)));
    out.push_str(&format!("Date: {}\r\n", date(secs)));
    let domain = from.rsplit('@').next().unwrap_or("lumo.local");
    out.push_str(&format!("Message-ID: <{id}@{domain}>\r\n"));
    if let Some(answered) = mail.in_reply_to.as_deref().map(message_ids).filter(|i| !i.is_empty()) {
        out.push_str(&format!("In-Reply-To: {answered}\r\n"));
    }
    if let Some(thread) = mail.references.as_deref().map(message_ids).filter(|r| !r.is_empty()) {
        // Folded, one id a line: a long conversation never makes a line too long.
        out.push_str(&format!("References: {}\r\n", thread.split(' ').collect::<Vec<_>>().join("\r\n ")));
    }
    out.push_str("MIME-Version: 1.0\r\n");
    let body = mail.body.replace("\r\n", "\n").replace('\n', "\r\n");
    const TEXT: &str = "Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n";
    if mail.attachments.is_empty() {
        out.push_str(TEXT);
        base64_lines(&mut out, body.as_bytes());
        return out;
    }
    // Base64 and these headers never hold "=_", so the boundary is in no part.
    let boundary = format!("=_lumo_{id}");
    out.push_str(&format!("Content-Type: multipart/mixed; boundary=\"{boundary}\"\r\n\r\n"));
    out.push_str(&format!("--{boundary}\r\n{TEXT}"));
    base64_lines(&mut out, body.as_bytes());
    for file in &mail.attachments {
        let name: String = file.name.chars().filter(|c| !c.is_control() && *c != '"' && *c != '\\').collect();
        out.push_str(&format!("--{boundary}\r\n"));
        out.push_str(&format!("Content-Type: {}; name=\"{}\"\r\n", file.mime, header_text(&name)));
        out.push_str(&format!("Content-Disposition: attachment; filename*=UTF-8''{}\r\n", percent_name(&name)));
        out.push_str("Content-Transfer-Encoding: base64\r\n\r\n");
        base64_lines(&mut out, &file.bytes);
    }
    out.push_str(&format!("--{boundary}--\r\n"));
    out
}

/// One answer: its code and its lines' words. A long answer (EHLO's) comes on
/// several lines, "250-…" until "250 …".
async fn reply<S: AsyncRead + Unpin>(stream: &mut BufReader<S>) -> Result<(u16, Vec<String>), String> {
    let mut lines = Vec::new();
    let mut read = 0;
    loop {
        let mut line = String::new();
        let n = stream.read_line(&mut line).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("The mail server closed the connection.".into());
        }
        read += n;
        if read > MAX_REPLY {
            return Err("The mail server's answer is too long.".into());
        }
        let line = line.trim_end().to_string();
        let code = line.get(0..3).and_then(|c| c.parse::<u16>().ok()).ok_or("The mail server answered something unexpected.")?;
        let last = line.as_bytes().get(3) != Some(&b'-');
        lines.push(line.get(4..).unwrap_or("").to_string());
        if last {
            return Ok((code, lines));
        }
    }
}

/// Writes `text` out at once (a TLS stream holds it until flushed).
async fn write<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut BufReader<S>, text: &str) -> Result<(), String> {
    stream.get_mut().write_all(text.as_bytes()).await.map_err(|e| e.to_string())?;
    stream.get_mut().flush().await.map_err(|e| e.to_string())
}

/// Sends `line` and wants an answer with code `want`.
async fn command<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut BufReader<S>, line: &str, want: u16, step: &str) -> Result<Vec<String>, String> {
    write(stream, &format!("{line}\r\n")).await?;
    expect(stream, want, step).await
}

async fn expect<S: AsyncRead + Unpin>(stream: &mut BufReader<S>, want: u16, step: &str) -> Result<Vec<String>, String> {
    let (code, lines) = reply(stream).await?;
    if code == want {
        Ok(lines)
    } else {
        Err(format!("The mail server refused {step}: {code} {}", lines.join(" ")))
    }
}

/// After the greeting: says hello, signs in, sends.
async fn session<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut BufReader<S>,
    host: &str,
    address: &str,
    password: &str,
    recipients: &[String],
    data: &str,
) -> Result<(), String> {
    let caps = command(stream, "EHLO lumo", 250, "the greeting").await?;
    let auth = caps.iter().find(|c| c.to_ascii_uppercase().starts_with("AUTH")).map(|c| c.to_ascii_uppercase()).unwrap_or_default();
    let signed_in = if auth.split_whitespace().any(|m| m == "PLAIN") || auth.is_empty() {
        let token = base64_for(format!("\0{address}\0{password}").as_bytes());
        command(stream, &format!("AUTH PLAIN {token}"), 235, "the sign-in").await
    } else {
        command(stream, "AUTH LOGIN", 334, "the sign-in").await?;
        command(stream, &base64_for(address.as_bytes()), 334, "the sign-in").await?;
        command(stream, &base64_for(password.as_bytes()), 235, "the sign-in").await
    };
    signed_in.map_err(|e| {
        format!("{e}. The server {host} didn't take the address and app password the Email pill uses: some accounts need sending allowed for app passwords.")
    })?;
    command(stream, &format!("MAIL FROM:<{address}>"), 250, "the sender").await?;
    for to in recipients {
        write(stream, &format!("RCPT TO:<{to}>\r\n")).await?;
        let (code, lines) = reply(stream).await?;
        if code != 250 && code != 251 {
            return Err(format!("The mail server refused the address {to}: {code} {}", lines.join(" ")));
        }
    }
    command(stream, "DATA", 354, "the email").await?;
    write(stream, data).await?;
    command(stream, ".", 250, "the email").await?;
    let _ = command(stream, "QUIT", 221, "goodbye").await;
    Ok(())
}

async fn tls(host: &str, tcp: TcpStream) -> Result<tokio_rustls::client::TlsStream<TcpStream>, String> {
    let name = ServerName::try_from(host.to_string()).map_err(|_| format!("Not a valid server: {host}"))?;
    TlsConnector::from(crate::mail::tls()?)
        .connect(name, tcp)
        .await
        .map_err(|e| format!("No secure connection to {host}: {e}"))
}

async fn exchange(host: &str, port: u16, address: &str, password: &str, recipients: &[String], data: &str) -> Result<(), String> {
    let tcp = TcpStream::connect((host, port)).await.map_err(|_| format!("Can't reach the mail server {host}."))?;
    if port == 465 {
        let mut stream = BufReader::new(tls(host, tcp).await?);
        expect(&mut stream, 220, "the connection").await?;
        return session(&mut stream, host, address, password, recipients, data).await;
    }
    // 587 and the others: plain until STARTTLS, never signing in before it.
    let mut plain = BufReader::new(tcp);
    expect(&mut plain, 220, "the connection").await?;
    let caps = command(&mut plain, "EHLO lumo", 250, "the greeting").await?;
    if !caps.iter().any(|c| c.eq_ignore_ascii_case("STARTTLS")) {
        return Err(format!("The mail server {host} offers no secure connection: Lumo doesn't send without one."));
    }
    command(&mut plain, "STARTTLS", 220, "a secure connection").await?;
    let mut stream = BufReader::new(tls(host, plain.into_inner()).await?);
    session(&mut stream, host, address, password, recipients, data).await
}

/// A new Message-ID's left part, and the time it is from.
pub fn new_id() -> (String, u64) {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
    (format!("{}.{}.lumo", now.as_nanos(), std::process::id()), now.as_secs())
}

/// Sends `mail` from the Email pill's account.
pub async fn send(mail: &Outgoing) -> Result<Sent, String> {
    let (address, password) = crate::secrets::get(crate::mail::ADDRESS_KEY)
        .zip(crate::secrets::get(crate::mail::PASSWORD_KEY))
        .ok_or_else(|| "Lumo has no email account yet: the user adds one in Lumo's Settings, under the Email pill.".to_string())?;
    let typed = crate::secrets::get(crate::mail::SERVER_KEY).unwrap_or_default();
    let (host, port) = server_of(&typed, &address);
    let (id, secs) = new_id();
    let data = message(&address, mail, secs, &id);
    let recipients: Vec<String> = mail.to.iter().chain(&mail.cc).cloned().collect();
    let message_id = format!("<{id}@{}>", address.rsplit('@').next().unwrap_or("lumo.local"));
    match tokio::time::timeout(TIMEOUT, exchange(&host, port, &address, &password, &recipients, &data)).await {
        Ok(Ok(())) => Ok(Sent { host, data, message_id }),
        Ok(Err(e)) => Err(e),
        Err(_) => Err(format!("The mail server {host} took too long to answer.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_addresses_only() {
        assert!(valid_address("ada@example.com"));
        assert!(valid_address("first.last+tag@mail.example.co.uk"));
        for bad in ["", "ada", "@example.com", "ada@", "ada@example", "a da@example.com", "ada@example.com\r\nRCPT TO:<x@y.z>", "<ada@example.com>", "ada@example.com,bob@example.com", "Ada <ada@example.com>"] {
            assert!(!valid_address(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_big_providers_send_through_their_own_servers() {
        assert_eq!(server_of("", "me@gmail.com"), ("smtp.gmail.com".into(), 465));
        assert_eq!(server_of("imap.gmail.com", "me@company.com"), ("smtp.gmail.com".into(), 465), "Google Workspace");
        assert_eq!(server_of("", "me@outlook.it"), ("smtp-mail.outlook.com".into(), 587));
        assert_eq!(server_of("outlook.office365.com", "me@school.edu"), ("smtp.office365.com".into(), 587));
        assert_eq!(server_of("", "me@icloud.com"), ("smtp.mail.me.com".into(), 587));
        assert_eq!(server_of("", "me@libero.it"), ("smtp.libero.it".into(), 465));
        assert_eq!(server_of("imap.example.org:993", "me@example.org"), ("smtp.example.org".into(), 465));
        assert_eq!(server_of("mail.example.org", "me@example.org"), ("smtp.example.org".into(), 465));
    }

    #[test]
    fn dates_read_as_emails_write_them() {
        assert_eq!(date(0), "Thu, 1 Jan 1970 00:00:00 +0000");
        // 2026-10-28T21:51:05Z, a Wednesday.
        assert_eq!(date(1_793_224_265), "Wed, 28 Oct 2026 21:51:05 +0000");
    }

    #[test]
    fn the_email_is_plain_text_in_utf8_with_its_headers() {
        let mail = Outgoing {
            to: vec!["ada@example.com".into()],
            cc: vec!["bob@example.com".into()],
            subject: "Città\r\nBcc: eve@example.com".into(),
            body: "Ciao Ada,\n.\nA presto".into(),
            ..Outgoing::default()
        };
        let text = message("me@example.it", &mail, 0, "1.2.lumo");
        let (head, body) = text.split_once("\r\n\r\n").unwrap();
        assert!(head.contains("From: me@example.it\r\nTo: ada@example.com\r\nCc: bob@example.com\r\n"));
        assert!(head.contains("Message-ID: <1.2.lumo@example.it>"));
        assert!(head.contains("Content-Type: text/plain; charset=utf-8"));
        assert!(!head.contains("\r\nBcc:"), "a line break in the subject never makes a header");
        let subject = head.lines().find(|l| l.starts_with("Subject: ")).unwrap();
        assert!(subject.starts_with("Subject: =?UTF-8?B?"));
        assert!(body.lines().all(|l| l.len() <= 76 && !l.starts_with('.')));
        assert_eq!(body, format!("{}\r\n", base64_for("Ciao Ada,\r\n.\r\nA presto".as_bytes())));
    }

    #[test]
    fn files_attached_follow_the_text_each_in_its_own_part() {
        let pdf = Attachment { name: "Analisi 2 è.pdf".into(), mime: mime_of("Analisi 2 è.pdf"), bytes: vec![0x25, 0x50, 0x44, 0x46, 0xff, 0x00] };
        let mail = Outgoing {
            to: vec!["ada@example.com".into()],
            cc: Vec::new(),
            subject: "Report".into(),
            body: "Eccolo".into(),
            attachments: vec![pdf.clone(), Attachment { name: "a\"b\r\n.txt".into(), mime: "text/plain", bytes: b"x".to_vec() }],
            ..Outgoing::default()
        };
        let text = message("me@example.it", &mail, 0, "1.2.lumo");
        let (head, rest) = text.split_once("\r\n\r\n").unwrap();
        assert!(head.contains("Content-Type: multipart/mixed; boundary=\"=_lumo_1.2.lumo\""));
        let parts: Vec<&str> = rest.split("--=_lumo_1.2.lumo").collect();
        assert_eq!(parts.len(), 5, "before, text, two files, the end: {parts:?}");
        assert!(parts[1].contains("Content-Type: text/plain; charset=utf-8"));
        assert!(parts[1].contains(&base64_for(b"Eccolo")));
        assert!(parts[2].contains("Content-Type: application/pdf; name=\"=?UTF-8?B?"));
        assert!(parts[2].contains("Content-Disposition: attachment; filename*=UTF-8''Analisi%202%20%C3%A8.pdf\r\n"));
        assert!(parts[2].contains(&base64_for(&pdf.bytes)));
        assert!(parts[3].contains("filename*=UTF-8''ab.txt\r\n"), "no quote or line break from a name gets into a header");
        assert_eq!(parts[4], "--\r\n");
        assert!(text.lines().all(|l| l.len() <= 998 && !l.starts_with('.')));
        assert_eq!(mime_of("x.DOCX"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        assert_eq!(mime_of("photo.JPG"), "image/jpeg");
        assert_eq!(mime_of("noext"), "application/octet-stream");
    }

    #[test]
    fn a_reply_names_the_email_it_answers_and_a_draft_may_have_nobody() {
        let reply = Outgoing {
            to: vec!["ada@example.com".into()],
            subject: "Re: Lunch".into(),
            body: "Yes".into(),
            in_reply_to: Some("<a1@example.com>".into()),
            references: Some("<a0@example.com> <a1@example.com>\r\nBcc: eve@example.com".into()),
            ..Outgoing::default()
        };
        let text = message("me@example.it", &reply, 0, "1.2.lumo");
        let (head, _) = text.split_once("\r\n\r\n").unwrap();
        assert!(head.contains("\r\nIn-Reply-To: <a1@example.com>\r\n"), "{head}");
        assert!(head.contains("\r\nReferences: <a0@example.com>\r\n <a1@example.com>\r\n"), "{head}");
        assert!(!head.contains("Bcc"), "only ids get into the header");
        let draft = Outgoing { body: "x".into(), ..Outgoing::default() };
        assert!(!message("me@example.it", &draft, 0, "1").contains("\r\nTo:"));
        assert_eq!(message_ids("<a@b> junk <c d> <e@f>"), "<a@b> <e@f>");
    }

    #[test]
    fn a_plain_subject_stays_as_it_is_and_a_long_one_folds() {
        assert_eq!(header_text("Invoice 42"), "Invoice 42");
        let long = header_text(&"è".repeat(60));
        assert!(long.lines().all(|l| l.trim_start().len() <= 76));
        assert!(long.contains("\r\n "));
    }

    #[test]
    fn a_conversation_with_a_server() {
        use tokio::io::{duplex, DuplexStream};
        async fn line(s: &mut BufReader<DuplexStream>) -> String {
            let mut line = String::new();
            s.read_line(&mut line).await.unwrap();
            line
        }
        async fn server(s: DuplexStream) -> (Vec<String>, String) {
            let mut s = BufReader::new(s);
            let mut said = Vec::new();
            for reply in ["250-smtp.example.com\r\n250 AUTH LOGIN PLAIN\r\n", "235 ok\r\n", "250 ok\r\n", "250 ok\r\n", "354 go\r\n"] {
                said.push(line(&mut s).await.trim_end().to_string());
                s.get_mut().write_all(reply.as_bytes()).await.unwrap();
            }
            let mut data = String::new();
            loop {
                let l = line(&mut s).await;
                if l == ".\r\n" {
                    break;
                }
                data.push_str(&l);
            }
            s.get_mut().write_all(b"250 queued\r\n").await.unwrap();
            said.push(line(&mut s).await.trim_end().to_string());
            s.get_mut().write_all(b"221 bye\r\n").await.unwrap();
            (said, data)
        }
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let (said, data) = runtime.block_on(async {
            let (client, other) = duplex(64 * 1024);
            let script = tokio::spawn(server(other));
            let mut stream = BufReader::new(client);
            session(&mut stream, "smtp.example.com", "me@example.com", "pw", &["ada@example.com".into()], "Subject: x\r\n\r\nhi\r\n")
                .await
                .unwrap();
            script.await.unwrap()
        });
        assert_eq!(said[0], "EHLO lumo");
        assert_eq!(said[1], format!("AUTH PLAIN {}", base64_for(b"\0me@example.com\0pw")));
        assert_eq!(said[2], "MAIL FROM:<me@example.com>");
        assert_eq!(said[3], "RCPT TO:<ada@example.com>");
        assert_eq!(said[4], "DATA");
        assert_eq!(said[5], "QUIT");
        assert_eq!(data, "Subject: x\r\n\r\nhi\r\n");
    }
}
