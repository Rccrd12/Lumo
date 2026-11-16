// An email's text, for the Email pill (mail.rs): the files attached as its
// BODYSTRUCTURE says, its headers in any charset, its parts, and its body as
// plain text.

use crate::mail::PREVIEW_CHARS;
use crate::mail_imap::{literal_size, Part};

// ── Attachments ───────────────────────────────────────────────────────────────

/// A file attached to an email received, as its BODYSTRUCTURE says.
#[derive(Clone, Debug, PartialEq)]
pub struct Attached {
    /// The part's number, for `BODY[…]`: "2", "1.3".
    pub(crate) section: String,
    pub name: String,
    pub mime: String,
    pub(crate) encoding: String,
    /// Its size as sent (in base64, a third more than the file).
    pub(crate) size: usize,
}

impl Attached {
    /// About how much the file weighs.
    pub(crate) fn file_size(&self) -> usize {
        if self.encoding.eq_ignore_ascii_case("base64") { self.size / 4 * 3 } else { self.size }
    }
}

/// A piece of a FETCH answer, for its BODYSTRUCTURE: a parenthesis, a string
/// (an atom, a quoted string, a literal) or NIL.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Tok {
    Open,
    Close,
    Word(String),
    Nil,
}

pub(crate) fn tokens(unit: &[Part]) -> Vec<Tok> {
    let mut out = Vec::new();
    for part in unit {
        let text = match part {
            Part::Literal(bytes) => {
                out.push(Tok::Word(String::from_utf8_lossy(bytes).to_string()));
                continue;
            }
            Part::Text(text) => text,
        };
        // The "{123}" that ends a line is the literal next to it.
        let text = if literal_size(text).is_some() { &text[..text.rfind('{').unwrap_or(text.len())] } else { text.as_str() };
        let mut chars = text.chars().peekable();
        while let Some(&c) = chars.peek() {
            match c {
                '(' => {
                    chars.next();
                    out.push(Tok::Open);
                }
                ')' => {
                    chars.next();
                    out.push(Tok::Close);
                }
                '"' => {
                    chars.next();
                    let mut s = String::new();
                    while let Some(c) = chars.next() {
                        match c {
                            '\\' => s.extend(chars.next()),
                            '"' => break,
                            c => s.push(c),
                        }
                    }
                    out.push(Tok::Word(s));
                }
                c if c.is_whitespace() => {
                    chars.next();
                }
                _ => {
                    let mut s = String::new();
                    while let Some(&c) = chars.peek() {
                        if c.is_whitespace() || c == '(' || c == ')' {
                            break;
                        }
                        s.push(c);
                        chars.next();
                    }
                    out.push(if s.eq_ignore_ascii_case("NIL") { Tok::Nil } else { Tok::Word(s) });
                }
            }
        }
    }
    out
}

/// A BODYSTRUCTURE as a tree: lists of strings and lists.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Node {
    List(Vec<Node>),
    Str(String),
    Nil,
}

pub(crate) fn node(toks: &[Tok], i: &mut usize, depth: usize) -> Option<Node> {
    if depth > 32 {
        return None;
    }
    match toks.get(*i)? {
        Tok::Open => {
            *i += 1;
            let mut list = Vec::new();
            loop {
                if toks.get(*i)? == &Tok::Close {
                    *i += 1;
                    return Some(Node::List(list));
                }
                list.push(node(toks, i, depth + 1)?);
            }
        }
        Tok::Close => None,
        Tok::Word(w) => {
            *i += 1;
            Some(Node::Str(w.clone()))
        }
        Tok::Nil => {
            *i += 1;
            Some(Node::Nil)
        }
    }
}

/// The files attached to an email, from a FETCH answer with its BODYSTRUCTURE.
pub(crate) fn attached_files(unit: &[Part]) -> Vec<Attached> {
    let toks = tokens(unit);
    let Some(at) = toks.iter().position(|t| matches!(t, Tok::Word(w) if w.eq_ignore_ascii_case("BODYSTRUCTURE"))) else {
        return Vec::new();
    };
    let mut i = at + 1;
    let mut out = Vec::new();
    if let Some(tree) = node(&toks, &mut i, 0) {
        walk(&tree, "", &mut out, 0);
    }
    out
}

/// The attachments in a part (RFC 3501's body): each part of a multipart in turn, else the part itself.
fn walk(part: &Node, section: &str, out: &mut Vec<Attached>, depth: usize) {
    let Node::List(items) = part else { return };
    if depth > 12 {
        return;
    }
    if matches!(items.first(), Some(Node::List(_))) {
        for (n, child) in items.iter().take_while(|c| matches!(c, Node::List(_))).enumerate() {
            let at = if section.is_empty() { (n + 1).to_string() } else { format!("{section}.{}", n + 1) };
            walk(child, &at, out, depth + 1);
        }
        return;
    }
    let word = |i: usize| match items.get(i) {
        Some(Node::Str(s)) => s.clone(),
        _ => String::new(),
    };
    let (kind, sub) = (word(0).to_ascii_lowercase(), word(1).to_ascii_lowercase());
    // After the size: a text part has its lines, an email its envelope, body and lines; then MD5, then the disposition.
    let ext = match (kind.as_str(), sub.as_str()) {
        ("text", _) => 8,
        ("message", "rfc822") => 10,
        _ => 7,
    };
    let (disposition, disposition_params) = match items.get(ext + 1) {
        Some(Node::List(d)) => (
            match d.first() {
                Some(Node::Str(s)) => s.to_ascii_lowercase(),
                _ => String::new(),
            },
            d.get(1),
        ),
        _ => (String::new(), None),
    };
    let name = param_of(disposition_params, "filename").or_else(|| param_of(items.get(2), "name"));
    // An attachment, or a named file not shown inside the text (an inline
    // PDF, as Apple Mail sends it); not the pictures of an HTML email.
    let attached = disposition == "attachment"
        || (disposition.is_empty() && name.is_some() && kind != "text")
        || (disposition == "inline" && name.is_some() && kind != "image" && kind != "text");
    if !attached {
        return;
    }
    let name = name.unwrap_or_else(|| if sub == "rfc822" { "email.eml".to_string() } else { format!("attachment-{}", out.len() + 1) });
    out.push(Attached {
        section: if section.is_empty() { "1".into() } else { section.to_string() },
        name,
        mime: format!("{kind}/{sub}"),
        encoding: word(5),
        size: word(6).parse().unwrap_or(0),
    });
}

/// A parameter of a part (`("name" "a.pdf" …)`): plain, RFC 2047 words, or
/// RFC 2231 (`filename*=UTF-8''…`, in pieces `filename*0*`, `filename*1`…).
pub(crate) fn param_of(params: Option<&Node>, key: &str) -> Option<String> {
    let Some(Node::List(items)) = params else { return None };
    let pairs: Vec<(String, &str)> = items
        .chunks(2)
        .filter_map(|p| match p {
            [Node::Str(k), Node::Str(v)] => Some((k.to_ascii_lowercase(), v.as_str())),
            _ => None,
        })
        .collect();
    let get = |k: &str| pairs.iter().find(|(name, _)| name == k).map(|(_, v)| *v);
    let text = if let Some(v) = get(key) {
        decode_words(v)
    } else if let Some(v) = get(&format!("{key}*")) {
        utf8_or_1252(&percent_decode(v.splitn(3, '\'').nth(2).unwrap_or(v)))
    } else {
        let mut bytes = Vec::new();
        for n in 0..64 {
            let (v, encoded) = match (get(&format!("{key}*{n}*")), get(&format!("{key}*{n}"))) {
                (Some(v), _) => (v, true),
                (None, Some(v)) => (v, false),
                _ => break,
            };
            // Only the first piece says its charset (`UTF-8''`).
            let v = if n == 0 && encoded { v.splitn(3, '\'').nth(2).unwrap_or(v) } else { v };
            bytes.extend(if encoded { percent_decode(v) } else { v.as_bytes().to_vec() });
        }
        if bytes.is_empty() {
            return None;
        }
        utf8_or_1252(&bytes)
    };
    let name = clean_header(&text);
    (!name.is_empty()).then_some(name)
}

/// `%E2%80%99` and the like, as bytes.
pub(crate) fn percent_decode(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if let Some(b) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

// ── Messages ──────────────────────────────────────────────────────────────────

/// "Name: value" pairs, folded lines unfolded.
pub(crate) fn parse_headers(raw: &[u8]) -> Vec<(String, String)> {
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
pub(crate) fn parse_from(raw: &str) -> (String, String) {
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
pub(crate) fn in_charset(bytes: &[u8], charset: &str) -> String {
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
pub(crate) fn utf8_or_1252(bytes: &[u8]) -> String {
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
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&c| if le { u16::from_le_bytes(c) } else { u16::from_be_bytes(c) })
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
pub(crate) fn clean_header(text: &str) -> String {
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

pub(crate) fn decode_body(encoding: &str, bytes: &[u8]) -> Vec<u8> {
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
                if whole_tag(&lower[i..], skip) {
                    let close = format!("</{}", &skip[1..]);
                    let mut at = i + skip.len();
                    i = loop {
                        match lower[at..].find(&close).map(|e| at + e) {
                            Some(e) if whole_tag(&lower[e..], &close) => break e,
                            Some(e) => at = e + close.len(),
                            None => break bytes.len(),
                        }
                    };
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

/// Whether `text` starts with the tag `name` ("<head", "</head") as a whole
/// name: `<head>` or `<head …>`, never `<header>`.
fn whole_tag(text: &str, name: &str) -> bool {
    text.starts_with(name) && text[name.len()..].chars().next().is_none_or(|c| c == '>' || c == '/' || c.is_ascii_whitespace())
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
pub(crate) fn tidy(text: &str) -> String {
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

pub(crate) fn preview(text: &str) -> String {
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
    fn the_files_attached_come_from_the_bodystructure() {
        // A text with its HTML, a PDF and a picture named in UTF-8 (RFC 2231), a picture inside the HTML.
        let line = concat!(
            r#"* 1 FETCH (UID 9 BODYSTRUCTURE ((("TEXT" "PLAIN" ("CHARSET" "utf-8") NIL NIL "7BIT" 12 1 NIL NIL NIL)"#,
            r#"("TEXT" "HTML" ("CHARSET" "utf-8") NIL NIL "QUOTED-PRINTABLE" 40 2 NIL NIL NIL) "ALTERNATIVE" ("BOUNDARY" "b2") NIL NIL)"#,
            r#"("IMAGE" "PNG" ("NAME" "logo.png") "<logo>" NIL "BASE64" 400 NIL ("INLINE" ("FILENAME" "logo.png")) NIL)"#,
            r#"("APPLICATION" "PDF" ("NAME" "=?UTF-8?Q?Fattura_n=C2=B0_7.pdf?=") NIL NIL "BASE64" 1336 NIL ("ATTACHMENT" ("FILENAME" "=?UTF-8?Q?Fattura_n=C2=B0_7.pdf?=")) NIL)"#,
            r#"("IMAGE" "JPEG" NIL NIL NIL "BASE64" 800 NIL ("attachment" ("filename*" "UTF-8''foto%20citt%C3%A0.jpg")) NIL) "MIXED" ("BOUNDARY" "b1") NIL NIL))"#,
        );
        let files = attached_files(&[Part::Text(line.into())]);
        let names: Vec<(&str, &str, &str)> = files.iter().map(|f| (f.section.as_str(), f.name.as_str(), f.mime.as_str())).collect();
        assert_eq!(names, [("3", "Fattura n° 7.pdf", "application/pdf"), ("4", "foto città.jpg", "image/jpeg")]);
        assert_eq!(files[0].file_size(), 1002);
        // One part only, the whole email a PDF; a name that came as a literal.
        let single = [
            Part::Text(r#"* 2 FETCH (UID 3 BODYSTRUCTURE ("APPLICATION" "PDF" ("NAME" {5}"#.into()),
            Part::Literal(b"a.pdf".to_vec()),
            Part::Text(r#") NIL NIL "BASE64" 100 NIL NIL NIL))"#.into()),
        ];
        let one = attached_files(&single);
        assert_eq!((one[0].section.as_str(), one[0].name.as_str()), ("1", "a.pdf"));
        // RFC 2231 in pieces.
        let pieces = Node::List(["filename*0*", "UTF-8''Analisi%20", "filename*1", "2.pdf"].iter().map(|s| Node::Str(s.to_string())).collect());
        assert_eq!(param_of(Some(&pieces), "filename").as_deref(), Some("Analisi 2.pdf"));
        assert!(attached_files(&[Part::Text("* 1 FETCH (UID 9 BODYSTRUCTURE (\"TEXT\" \"PLAIN\" NIL NIL NIL \"7BIT\" 1 1))".into())]).is_empty());
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
        assert_eq!(strip_html("<html><head><title>x</title></head><body><header>Newsletter</header><p>Hi</p></body></html>").trim(), "Newsletter\nHi");
        assert_eq!(strip_html("<head>\n<style>p{}</style></head ><p>Ok</p>").trim(), "Ok");
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
}
