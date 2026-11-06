//! The text of a PDF, for a model that can't open the file itself (a local
//! model, the OpenAI-compatible APIs): the words on its pages, in order, as
//! far as the file says what they are. No library: the objects are read from
//! the file, their streams inflated (`inflate`, RFC 1950/1951), each page's
//! text operators followed, and each font's ToUnicode map applied. A scan
//! (pictures only), an encrypted file or one past `MAX_FILE` gives None.

use std::collections::{HashMap, HashSet};

/// The biggest PDF read.
const MAX_FILE: u64 = 40 * 1024 * 1024;
/// The most one stream inflates to.
const MAX_STREAM: usize = 16 * 1024 * 1024;
/// The most all of a document's streams give, together: a page that names the
/// same stream again and again (`/Contents [4 0 R 4 0 R …]`) adds it each time.
const MAX_DOC: usize = 64 * 1024 * 1024;

/// The text of the PDF at `path`, at most `limit` characters; None when
/// there is none to read.
pub fn text(path: &str, limit: usize) -> Option<String> {
    if std::fs::metadata(path).ok()?.len() > MAX_FILE {
        return None;
    }
    text_of(&std::fs::read(path).ok()?, limit)
}

fn text_of(file: &[u8], limit: usize) -> Option<String> {
    if !file.starts_with(b"%PDF") && find(file, b"%PDF", 0).is_none_or(|i| i > 1024) {
        return None;
    }
    let doc = Doc::read(file);
    if doc.encrypted {
        return None;
    }
    let mut out = String::new();
    let mut fonts: HashMap<u32, Font> = HashMap::new();
    for (page, resources) in doc.pages() {
        let names = font_names(&doc, resources.as_ref(), &mut fonts);
        let mut content = Vec::new();
        let contents = page.get(b"Contents".as_slice()).map(|c| doc.resolve(c)).unwrap_or(&Obj::Null);
        let parts: Vec<&Obj> = match contents {
            Obj::Arr(items) => items.iter().collect(),
            _ => vec![page.get(b"Contents".as_slice()).unwrap_or(&Obj::Null)],
        };
        for part in parts {
            if let Some(bytes) = doc.stream_of(part) {
                content.extend_from_slice(&bytes);
                content.push(b'\n');
            }
        }
        let page_text = page_text(&content, &names, &fonts);
        let page_text = page_text.trim();
        if !page_text.is_empty() {
            if !out.is_empty() {
                out.push_str("\n\n");
            }
            out.push_str(page_text);
        }
        if out.chars().count() >= limit {
            break;
        }
    }
    let out: String = out.chars().take(limit).collect();
    out.chars().any(char::is_alphanumeric).then_some(out)
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= hay.len() {
        return None;
    }
    hay[from..].windows(needle.len()).position(|w| w == needle).map(|i| i + from)
}

// ── Objects ───────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
enum Obj {
    Null,
    Bool(bool),
    Num(f64),
    Str(Vec<u8>),
    Name(Vec<u8>),
    Arr(Vec<Obj>),
    Dict(Dict),
    Ref(u32),
    /// A keyword: a content stream's operator, `stream`, `endobj`…
    Op(Vec<u8>),
}

type Dict = HashMap<Vec<u8>, Obj>;

impl Obj {
    fn dict(&self) -> Option<&Dict> {
        match self {
            Obj::Dict(d) => Some(d),
            _ => None,
        }
    }
    fn num(&self) -> Option<f64> {
        match self {
            Obj::Num(n) => Some(*n),
            _ => None,
        }
    }
    fn is_name(&self, name: &[u8]) -> bool {
        matches!(self, Obj::Name(n) if n == name)
    }
}

fn is_space(c: u8) -> bool {
    matches!(c, 0 | 9 | 10 | 12 | 13 | 32)
}

fn is_delim(c: u8) -> bool {
    matches!(c, b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%')
}

struct Lexer<'a> {
    b: &'a [u8],
    i: usize,
}

impl<'a> Lexer<'a> {
    fn new(b: &'a [u8], i: usize) -> Self {
        Lexer { b, i }
    }

    fn skip_space(&mut self) {
        while let Some(&c) = self.b.get(self.i) {
            if is_space(c) {
                self.i += 1;
            } else if c == b'%' {
                while self.b.get(self.i).is_some_and(|c| *c != b'\n' && *c != b'\r') {
                    self.i += 1;
                }
            } else {
                break;
            }
        }
    }

    fn regular(&mut self) -> &'a [u8] {
        let start = self.i;
        while self.b.get(self.i).is_some_and(|c| !is_space(*c) && !is_delim(*c)) {
            self.i += 1;
        }
        &self.b[start..self.i]
    }

    /// The next object, `depth` deep in arrays and dictionaries.
    fn next(&mut self) -> Option<Obj> {
        self.next_in(0)
    }

    fn next_in(&mut self, depth: usize) -> Option<Obj> {
        if depth > 64 {
            return None;
        }
        self.skip_space();
        let c = *self.b.get(self.i)?;
        match c {
            b'/' => {
                self.i += 1;
                let raw = self.regular();
                Some(Obj::Name(unescape_name(raw)))
            }
            b'(' => Some(Obj::Str(self.literal())),
            b'<' if self.b.get(self.i + 1) == Some(&b'<') => {
                self.i += 2;
                let mut d = Dict::new();
                loop {
                    self.skip_space();
                    if self.b.get(self.i..self.i + 2) == Some(b">>") {
                        self.i += 2;
                        break;
                    }
                    if self.i >= self.b.len() {
                        break;
                    }
                    // A key, then its value; a stray token is skipped.
                    if let Obj::Name(key) = self.next_in(depth + 1)? {
                        let value = self.next_in(depth + 1)?;
                        d.insert(key, value);
                    }
                }
                Some(Obj::Dict(d))
            }
            b'<' => Some(Obj::Str(self.hex())),
            b'[' => {
                self.i += 1;
                let mut items = Vec::new();
                loop {
                    self.skip_space();
                    match self.b.get(self.i) {
                        None => break,
                        Some(b']') => {
                            self.i += 1;
                            break;
                        }
                        _ => items.push(self.next_in(depth + 1)?),
                    }
                }
                Some(Obj::Arr(items))
            }
            b']' | b'>' | b')' | b'{' | b'}' => {
                self.i += 1;
                Some(Obj::Op(vec![c]))
            }
            b'0'..=b'9' | b'+' | b'-' | b'.' => {
                let raw = self.regular();
                let n: f64 = std::str::from_utf8(raw).ok().and_then(|s| s.parse().ok()).unwrap_or(0.0);
                // "12 0 R": a reference.
                if raw.iter().all(u8::is_ascii_digit) {
                    let back = self.i;
                    self.skip_space();
                    let generation = self.regular();
                    if !generation.is_empty() && generation.iter().all(u8::is_ascii_digit) {
                        self.skip_space();
                        if self.b.get(self.i) == Some(&b'R') && self.b.get(self.i + 1).is_none_or(|c| is_space(*c) || is_delim(*c)) {
                            self.i += 1;
                            return Some(Obj::Ref(n as u32));
                        }
                    }
                    self.i = back;
                }
                Some(Obj::Num(n))
            }
            _ => {
                let word = self.regular();
                if word.is_empty() {
                    self.i += 1;
                    return Some(Obj::Op(vec![c]));
                }
                Some(match word {
                    b"true" => Obj::Bool(true),
                    b"false" => Obj::Bool(false),
                    b"null" => Obj::Null,
                    _ => Obj::Op(word.to_vec()),
                })
            }
        }
    }

    fn literal(&mut self) -> Vec<u8> {
        self.i += 1;
        let mut out = Vec::new();
        let mut depth = 1;
        while let Some(&c) = self.b.get(self.i) {
            self.i += 1;
            match c {
                b'\\' => {
                    let Some(&e) = self.b.get(self.i) else { break };
                    self.i += 1;
                    match e {
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'0'..=b'7' => {
                            let mut v = u32::from(e - b'0');
                            for _ in 0..2 {
                                match self.b.get(self.i) {
                                    Some(&d @ b'0'..=b'7') => {
                                        v = v * 8 + u32::from(d - b'0');
                                        self.i += 1;
                                    }
                                    _ => break,
                                }
                            }
                            out.push(v as u8);
                        }
                        // A line break after "\" continues the string.
                        b'\r' => {
                            if self.b.get(self.i) == Some(&b'\n') {
                                self.i += 1;
                            }
                        }
                        b'\n' => {}
                        other => out.push(other),
                    }
                }
                b'(' => {
                    depth += 1;
                    out.push(c);
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    out.push(c);
                }
                _ => out.push(c),
            }
        }
        out
    }

    fn hex(&mut self) -> Vec<u8> {
        self.i += 1;
        let mut digits = Vec::new();
        while let Some(&c) = self.b.get(self.i) {
            self.i += 1;
            if c == b'>' {
                break;
            }
            if let Some(d) = (c as char).to_digit(16) {
                digits.push(d as u8);
            }
        }
        if digits.len() % 2 == 1 {
            digits.push(0);
        }
        digits.chunks(2).map(|p| p[0] << 4 | p[1]).collect()
    }
}

/// A name's `#xx` escapes.
fn unescape_name(raw: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'#' && i + 2 < raw.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&raw[i + 1..i + 3]).unwrap_or("x"), 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(raw[i]);
        i += 1;
    }
    out
}

// ── The document ──────────────────────────────────────────────────────────────

struct Doc {
    objects: HashMap<u32, (Obj, Option<Vec<u8>>)>,
    encrypted: bool,
    /// Bytes the streams may still give (`MAX_DOC`).
    left: std::cell::Cell<usize>,
}

impl Doc {
    /// Every "N G obj" in the file, the later of two with one number winning
    /// (an update appended to the file), then those packed in object streams.
    fn read(file: &[u8]) -> Doc {
        let mut objects = HashMap::new();
        let mut at = 0;
        while let Some(i) = find(file, b"obj", at) {
            at = i + 3;
            if file.get(i + 3).is_some_and(|c| !is_space(*c) && !is_delim(*c)) {
                continue;
            }
            let Some(number) = object_number(file, i) else { continue };
            let mut lx = Lexer::new(file, i + 3);
            let Some(obj) = lx.next() else { continue };
            lx.skip_space();
            let mut raw = None;
            if file[lx.i..].starts_with(b"stream") {
                let mut start = lx.i + 6;
                if file.get(start) == Some(&b'\r') {
                    start += 1;
                }
                if file.get(start) == Some(&b'\n') {
                    start += 1;
                }
                // A length past the file's end (1e20, say) is not one: the
                // file's own `endstream` is looked for instead.
                let said = obj
                    .dict()
                    .and_then(|d| d.get(b"Length".as_slice()))
                    .and_then(Obj::num)
                    .filter(|n| n.is_finite() && *n >= 0.0 && *n <= file.len() as f64)
                    .map(|n| n as usize)
                    .filter(|n| start.checked_add(*n).is_some_and(|end| end <= file.len()));
                let end = said
                    .filter(|n| {
                        let end = start + n;
                        {
                            let mut after = Lexer::new(file, end);
                            after.skip_space();
                            file[after.i..].starts_with(b"endstream")
                        }
                    })
                    .map(|n| start + n)
                    .or_else(|| {
                        let mut end = find(file, b"endstream", start)?;
                        while end > start && matches!(file[end - 1], b'\r' | b'\n') {
                            end -= 1;
                        }
                        Some(end)
                    });
                if let Some(end) = end.filter(|end| *end >= start) {
                    raw = Some(file[start..end].to_vec());
                    at = end;
                }
            }
            objects.insert(number, (obj, raw));
        }
        let mut doc = Doc { objects, encrypted: false, left: std::cell::Cell::new(MAX_DOC) };
        doc.unpack_object_streams();
        doc.encrypted = doc.objects.values().any(|(o, _)| o.dict().is_some_and(|d| d.contains_key(b"Encrypt".as_slice()) && (d.contains_key(b"Root".as_slice()) || d.get(b"Type".as_slice()).is_some_and(|t| t.is_name(b"XRef")))))
            || trailer_says_encrypt(file);
        doc
    }

    fn unpack_object_streams(&mut self) {
        let packed: Vec<u32> = self.objects.iter().filter(|(_, (o, raw))| raw.is_some() && o.dict().and_then(|d| d.get(b"Type".as_slice())).is_some_and(|t| t.is_name(b"ObjStm"))).map(|(n, _)| *n).collect();
        for number in packed {
            let Some(bytes) = self.stream(number) else { continue };
            let Some(d) = self.objects.get(&number).and_then(|(o, _)| o.dict()) else { continue };
            let count = d.get(b"N".as_slice()).and_then(Obj::num).unwrap_or(0.0) as usize;
            let first = d.get(b"First".as_slice()).and_then(Obj::num).unwrap_or(0.0) as usize;
            let mut header = Lexer::new(&bytes, 0);
            let mut pairs = Vec::new();
            for _ in 0..count.min(100_000) {
                let (Some(Obj::Num(n)), Some(Obj::Num(off))) = (header.next(), header.next()) else { break };
                pairs.push((n as u32, off as usize));
            }
            for (n, off) in pairs {
                let Some(at) = first.checked_add(off).filter(|at| *at < bytes.len()) else { continue };
                if let Some(obj) = Lexer::new(&bytes, at).next() {
                    self.objects.entry(n).or_insert((obj, None));
                }
            }
        }
    }

    fn get(&self, number: u32) -> &Obj {
        self.objects.get(&number).map(|(o, _)| o).unwrap_or(&Obj::Null)
    }

    /// `obj`, through its references.
    fn resolve<'a>(&'a self, mut obj: &'a Obj) -> &'a Obj {
        for _ in 0..16 {
            match obj {
                Obj::Ref(n) => obj = self.get(*n),
                _ => return obj,
            }
        }
        &Obj::Null
    }

    fn stream_of(&self, obj: &Obj) -> Option<Vec<u8>> {
        match obj {
            Obj::Ref(n) => self.stream(*n),
            _ => None,
        }
    }

    /// Object `number`'s stream, decoded: Flate, or none at all; any other
    /// filter (a picture's) gives None.
    fn stream(&self, number: u32) -> Option<Vec<u8>> {
        let (obj, raw) = self.objects.get(&number)?;
        let raw = raw.as_ref()?;
        let d = obj.dict()?;
        let filters: Vec<&Obj> = match d.get(b"Filter".as_slice()).map(|f| self.resolve(f)) {
            None | Some(Obj::Null) => Vec::new(),
            Some(Obj::Arr(items)) => items.iter().collect(),
            Some(other) => vec![other],
        };
        let left = self.left.get();
        if left == 0 || raw.len() > left {
            return None;
        }
        let mut data = raw.clone();
        for f in filters {
            if f.is_name(b"FlateDecode") || f.is_name(b"Fl") {
                data = inflate_zlib(&data, MAX_STREAM.min(left));
                if data.is_empty() {
                    return None;
                }
            } else {
                return None;
            }
        }
        self.left.set(left - data.len().min(left));
        Some(data)
    }

    /// The pages in order, each with the resources it has or inherits.
    fn pages(&self) -> Vec<(&Dict, Option<Dict>)> {
        let catalog = self.objects.values().find_map(|(o, _)| o.dict().filter(|d| d.get(b"Type".as_slice()).is_some_and(|t| t.is_name(b"Catalog"))));
        let mut pages = Vec::new();
        if let Some(root) = catalog.and_then(|c| c.get(b"Pages".as_slice())) {
            let mut seen = HashSet::new();
            self.walk(root, None, &mut pages, &mut seen, 0);
        }
        if pages.is_empty() {
            // No page tree to follow: the pages as numbered.
            let mut numbers: Vec<&u32> = self.objects.iter().filter(|(_, (o, _))| o.dict().and_then(|d| d.get(b"Type".as_slice())).is_some_and(|t| t.is_name(b"Page"))).map(|(n, _)| n).collect();
            numbers.sort();
            for n in numbers {
                if let Some(d) = self.get(*n).dict() {
                    pages.push((d, d.get(b"Resources".as_slice()).and_then(|r| self.resolve(r).dict()).cloned()));
                }
            }
        }
        pages
    }

    fn walk<'a>(&'a self, node: &'a Obj, inherited: Option<Dict>, pages: &mut Vec<(&'a Dict, Option<Dict>)>, seen: &mut HashSet<u32>, depth: usize) {
        if depth > 64 || pages.len() > 5000 {
            return;
        }
        if let Obj::Ref(n) = node {
            if !seen.insert(*n) {
                return;
            }
        }
        let Some(d) = self.resolve(node).dict() else { return };
        let resources = d.get(b"Resources".as_slice()).and_then(|r| self.resolve(r).dict()).cloned().or(inherited);
        match d.get(b"Kids".as_slice()).map(|k| self.resolve(k)) {
            Some(Obj::Arr(kids)) => {
                for kid in kids {
                    self.walk(kid, resources.clone(), pages, seen, depth + 1);
                }
            }
            _ => pages.push((d, resources)),
        }
    }
}

fn trailer_says_encrypt(file: &[u8]) -> bool {
    let mut at = 0;
    while let Some(i) = find(file, b"trailer", at) {
        at = i + 7;
        if let Some(Obj::Dict(d)) = Lexer::new(file, i + 7).next() {
            if d.contains_key(b"Encrypt".as_slice()) {
                return true;
            }
        }
    }
    false
}

/// The number of the object whose "obj" keyword is at `i` ("12 0 obj").
fn object_number(file: &[u8], i: usize) -> Option<u32> {
    let mut j = i;
    let back_space = |j: &mut usize| {
        let start = *j;
        while *j > 0 && is_space(file[*j - 1]) {
            *j -= 1;
        }
        *j < start
    };
    let back_digits = |j: &mut usize| {
        let end = *j;
        while *j > 0 && file[*j - 1].is_ascii_digit() {
            *j -= 1;
        }
        (*j < end).then(|| &file[*j..end])
    };
    if !back_space(&mut j) {
        return None;
    }
    back_digits(&mut j)?;
    if !back_space(&mut j) {
        return None;
    }
    let number = back_digits(&mut j)?;
    if j > 0 && !is_space(file[j - 1]) && !is_delim(file[j - 1]) {
        return None;
    }
    std::str::from_utf8(number).ok()?.parse().ok()
}

// ── Fonts ─────────────────────────────────────────────────────────────────────

#[derive(Default)]
struct Font {
    /// Codes of two bytes (a Type0 font), else one.
    wide: bool,
    /// What each code is, from the font's ToUnicode map.
    unicode: HashMap<u32, String>,
}

/// The page's font names (`/F1`) and the object each is, its fonts read
/// into `fonts` once.
fn font_names(doc: &Doc, resources: Option<&Dict>, fonts: &mut HashMap<u32, Font>) -> HashMap<Vec<u8>, u32> {
    let mut names = HashMap::new();
    let Some(list) = resources.and_then(|r| r.get(b"Font".as_slice())).and_then(|f| doc.resolve(f).dict()) else { return names };
    for (name, value) in list {
        let Obj::Ref(n) = value else { continue };
        names.insert(name.clone(), *n);
        if fonts.contains_key(n) {
            continue;
        }
        let d = doc.get(*n).dict();
        let wide = d.and_then(|d| d.get(b"Subtype".as_slice())).is_some_and(|s| s.is_name(b"Type0"));
        let unicode = d.and_then(|d| d.get(b"ToUnicode".as_slice())).and_then(|t| doc.stream_of(t)).map(|cmap| parse_cmap(&cmap)).unwrap_or_default();
        fonts.insert(*n, Font { wide, unicode });
    }
    names
}

fn code_of(bytes: &[u8]) -> u32 {
    bytes.iter().take(4).fold(0, |v, b| v << 8 | u32::from(*b))
}

fn utf16(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes.chunks(2).map(|p| u16::from(p[0]) << 8 | u16::from(*p.get(1).unwrap_or(&0))).collect();
    String::from_utf16_lossy(&units)
}

/// A ToUnicode CMap's `bfchar` and `bfrange` entries.
fn parse_cmap(cmap: &[u8]) -> HashMap<u32, String> {
    let mut map = HashMap::new();
    let mut lx = Lexer::new(cmap, 0);
    let mut operands: Vec<Obj> = Vec::new();
    while let Some(tok) = lx.next() {
        match tok {
            Obj::Op(op) => {
                match op.as_slice() {
                    b"endbfchar" => {
                        for pair in operands.chunks(2) {
                            if let [Obj::Str(src), Obj::Str(dst)] = pair {
                                map.insert(code_of(src), utf16(dst));
                            }
                        }
                    }
                    b"endbfrange" => {
                        for triple in operands.chunks(3) {
                            let [Obj::Str(lo), Obj::Str(hi), dst] = triple else { continue };
                            let (lo, hi) = (code_of(lo), code_of(hi));
                            if hi < lo || hi - lo > 65_536 {
                                continue;
                            }
                            match dst {
                                Obj::Str(first) => {
                                    let mut units: Vec<u16> = first.chunks(2).map(|p| u16::from(p[0]) << 8 | u16::from(*p.get(1).unwrap_or(&0))).collect();
                                    for code in lo..=hi {
                                        map.insert(code, String::from_utf16_lossy(&units));
                                        if let Some(last) = units.last_mut() {
                                            *last = last.wrapping_add(1);
                                        }
                                    }
                                }
                                Obj::Arr(each) => {
                                    for (code, s) in (lo..=hi).zip(each) {
                                        if let Obj::Str(s) = s {
                                            map.insert(code, utf16(s));
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
                operands.clear();
            }
            other => operands.push(other),
        }
    }
    map
}

/// Windows-1252 (WinAnsi), what a simple font's codes mostly are.
fn win_ansi(b: u8) -> Option<char> {
    const HIGH: [u16; 32] = [
        0x20AC, 0, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017D, 0, 0, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014, 0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0, 0x017E, 0x0178,
    ];
    match b {
        0x20..=0x7E | 0xA0..=0xFF => Some(b as char),
        0x80..=0x9F => char::from_u32(u32::from(HIGH[usize::from(b - 0x80)])).filter(|c| *c != '\0'),
        _ => None,
    }
}

fn decode(font: Option<&Font>, bytes: &[u8], out: &mut String) {
    match font {
        Some(f) if f.wide => {
            for pair in bytes.chunks(2) {
                if let Some(s) = f.unicode.get(&code_of(pair)) {
                    out.push_str(s);
                }
            }
        }
        Some(f) if !f.unicode.is_empty() => {
            for b in bytes {
                match f.unicode.get(&u32::from(*b)) {
                    Some(s) => out.push_str(s),
                    None => out.extend(win_ansi(*b)),
                }
            }
        }
        _ => out.extend(bytes.iter().filter_map(|b| win_ansi(*b))),
    }
}

// ── Pages ─────────────────────────────────────────────────────────────────────

/// What a page's content stream writes: its text operators followed, a line
/// where the text moves down, a space where a new piece of text starts on the line.
fn page_text(content: &[u8], names: &HashMap<Vec<u8>, u32>, fonts: &HashMap<u32, Font>) -> String {
    let mut out = String::new();
    let mut lx = Lexer::new(content, 0);
    let mut operands: Vec<Obj> = Vec::new();
    let mut font: Option<&Font> = None;
    let mut line_y: Option<f64> = None;
    let newline = |out: &mut String| {
        while out.ends_with(' ') {
            out.pop();
        }
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
    };
    let space = |out: &mut String| {
        if !out.is_empty() && !out.ends_with([' ', '\n']) {
            out.push(' ');
        }
    };
    while let Some(tok) = lx.next() {
        let Obj::Op(op) = tok else {
            operands.push(tok);
            if operands.len() > 4096 {
                operands.clear();
            }
            continue;
        };
        let num = |i: usize| operands.get(i).and_then(Obj::num);
        match op.as_slice() {
            b"Tf" => {
                font = match operands.first() {
                    Some(Obj::Name(n)) => names.get(n).and_then(|n| fonts.get(n)),
                    _ => None,
                }
            }
            b"Tj" => {
                if let Some(Obj::Str(s)) = operands.last() {
                    decode(font, s, &mut out);
                }
            }
            b"'" | b"\"" => {
                newline(&mut out);
                if let Some(Obj::Str(s)) = operands.last() {
                    decode(font, s, &mut out);
                }
            }
            b"TJ" => {
                if let Some(Obj::Arr(items)) = operands.first() {
                    for item in items {
                        match item {
                            Obj::Str(s) => decode(font, s, &mut out),
                            // A wide gap: words apart.
                            Obj::Num(n) if *n < -200.0 => space(&mut out),
                            _ => {}
                        }
                    }
                }
            }
            b"Td" | b"TD" => {
                // Down a line. Along the line it is kerning as often as a
                // gap (the spaces are glyphs of their own): nothing added.
                if num(1).unwrap_or(0.0).abs() > 0.5 {
                    newline(&mut out);
                }
            }
            b"T*" => newline(&mut out),
            b"Tm" => {
                let y = num(5).unwrap_or(0.0);
                match line_y {
                    Some(last) if (last - y).abs() > 1.0 => newline(&mut out),
                    _ => space(&mut out),
                }
                line_y = Some(y);
            }
            b"BT" => space(&mut out),
            // An inline picture: its bytes, skipped up to "EI".
            b"ID" => {
                let mut i = lx.i + 1;
                while let Some(at) = find(content, b"EI", i) {
                    i = at + 2;
                    let before = at.checked_sub(1).map(|j| content[j]);
                    let after = content.get(at + 2).copied();
                    if before.is_some_and(is_space) && after.is_none_or(|c| is_space(c) || is_delim(c)) {
                        break;
                    }
                }
                lx.i = i.min(content.len());
            }
            _ => {}
        }
        operands.clear();
    }
    // Lines trimmed, runs of blank lines kept to one.
    let mut tidy = String::new();
    let mut blank = 0;
    for line in out.lines().map(str::trim) {
        if line.is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        tidy.push_str(line);
        tidy.push('\n');
    }
    tidy
}

// ── Inflate (RFC 1950 and 1951) ───────────────────────────────────────────────

/// A zlib stream (or a bare deflate one) inflated, at most `max` bytes. What
/// was inflated before an error is kept.
fn inflate_zlib(data: &[u8], max: usize) -> Vec<u8> {
    let zlib = data.len() >= 2 && data[0] & 0x0F == 8 && (u16::from(data[0]) << 8 | u16::from(data[1])) % 31 == 0;
    let mut out = Vec::new();
    let _ = inflate(if zlib { &data[2..] } else { data }, &mut out, max);
    out
}

struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
    buf: u32,
    count: u32,
}

impl Bits<'_> {
    fn take(&mut self, n: u32) -> Option<u32> {
        while self.count < n {
            let b = *self.data.get(self.pos)?;
            self.pos += 1;
            self.buf |= u32::from(b) << self.count;
            self.count += 8;
        }
        let v = self.buf & ((1u32 << n) - 1);
        self.buf = if n == 32 { 0 } else { self.buf >> n };
        self.count -= n;
        Some(v)
    }
}

struct Huffman {
    counts: [u16; 16],
    symbols: Vec<u16>,
}

impl Huffman {
    fn new(lengths: &[u8]) -> Huffman {
        let mut counts = [0u16; 16];
        for &l in lengths {
            counts[usize::from(l)] += 1;
        }
        counts[0] = 0;
        let mut offsets = [0u16; 16];
        for len in 1..15 {
            offsets[len + 1] = offsets[len] + counts[len];
        }
        let mut symbols = vec![0u16; lengths.len()];
        for (symbol, &l) in lengths.iter().enumerate() {
            if l != 0 {
                symbols[usize::from(offsets[usize::from(l)])] = symbol as u16;
                offsets[usize::from(l)] += 1;
            }
        }
        Huffman { counts, symbols }
    }

    fn decode(&self, bits: &mut Bits) -> Option<u16> {
        let (mut code, mut first, mut index) = (0i32, 0i32, 0i32);
        for len in 1..16 {
            code |= bits.take(1)? as i32;
            let count = i32::from(self.counts[len]);
            if code - count < first {
                return self.symbols.get((index + code - first) as usize).copied();
            }
            index += count;
            first += count;
            first <<= 1;
            code <<= 1;
        }
        None
    }
}

const LEN_BASE: [u16; 29] = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA: [u8; 29] = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE: [u16; 30] = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA: [u8; 30] = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const ORDER: [usize; 19] = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

fn inflate(data: &[u8], out: &mut Vec<u8>, max: usize) -> Option<()> {
    let mut bits = Bits { data, pos: 0, buf: 0, count: 0 };
    loop {
        let last = bits.take(1)?;
        match bits.take(2)? {
            0 => {
                bits.buf = 0;
                bits.count = 0;
                let p = bits.pos;
                let len = usize::from(*data.get(p)?) | usize::from(*data.get(p + 1)?) << 8;
                let block = data.get(p + 4..p + 4 + len)?;
                out.extend_from_slice(block);
                bits.pos = p + 4 + len;
            }
            1 => {
                let mut lengths = [0u8; 288];
                lengths[..144].fill(8);
                lengths[144..256].fill(9);
                lengths[256..280].fill(7);
                lengths[280..].fill(8);
                block(&mut bits, &Huffman::new(&lengths), &Huffman::new(&[5u8; 30]), out, max)?;
            }
            2 => {
                let lit_count = bits.take(5)? as usize + 257;
                let dist_count = bits.take(5)? as usize + 1;
                let code_count = bits.take(4)? as usize + 4;
                let mut code_lengths = [0u8; 19];
                for &i in &ORDER[..code_count] {
                    code_lengths[i] = bits.take(3)? as u8;
                }
                let codes = Huffman::new(&code_lengths);
                let mut lengths = Vec::with_capacity(lit_count + dist_count);
                while lengths.len() < lit_count + dist_count {
                    match codes.decode(&mut bits)? {
                        s @ 0..=15 => lengths.push(s as u8),
                        16 => {
                            let prev = *lengths.last()?;
                            for _ in 0..3 + bits.take(2)? {
                                lengths.push(prev);
                            }
                        }
                        17 => lengths.extend(std::iter::repeat_n(0, 3 + bits.take(3)? as usize)),
                        _ => lengths.extend(std::iter::repeat_n(0, 11 + bits.take(7)? as usize)),
                    }
                }
                if lengths.len() > lit_count + dist_count {
                    return None;
                }
                block(&mut bits, &Huffman::new(&lengths[..lit_count]), &Huffman::new(&lengths[lit_count..]), out, max)?;
            }
            _ => return None,
        }
        if last == 1 || out.len() >= max {
            out.truncate(max);
            return Some(());
        }
    }
}

fn block(bits: &mut Bits, lit: &Huffman, dist: &Huffman, out: &mut Vec<u8>, max: usize) -> Option<()> {
    loop {
        let symbol = lit.decode(bits)?;
        match symbol {
            0..=255 => out.push(symbol as u8),
            256 => return Some(()),
            _ => {
                let i = usize::from(symbol - 257);
                let len = usize::from(*LEN_BASE.get(i)?) + bits.take(u32::from(LEN_EXTRA[i]))? as usize;
                let d = usize::from(dist.decode(bits)?);
                let back = usize::from(*DIST_BASE.get(d)?) + bits.take(u32::from(DIST_EXTRA[d]))? as usize;
                if back > out.len() {
                    return None;
                }
                let start = out.len() - back;
                for k in 0..len {
                    out.push(out[start + k]);
                }
            }
        }
        if out.len() >= max {
            return Some(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }

    const FIXED: &str = "789c730a51d07733543034520849533037523007b15214343c527372f27514025cdc14351542b2145c4300cf310a18";
    const STORED: &str = "7801010c00f3ff73746f7265642062797465731fcf04d9";
    const DYNAMIC: &str = "78da0bc94855282ccd4cce56482aca2fcf5348cbaf50c82acd2d2856c82f4b2d5228014ae72456552aa4e4a7eb2984d04c31032313330b2b1b3b072717370f2f1fbf80a090b088a898b884a494b48cac9cbc82a292b28aaa9aba86a696b68eae9ebe81a191b189a999b985a595b58dad9dbd83a393b38bab9bbb87a797b78faf9f7f4060507048685878446454744c6c5c7c426252724a6a5a7a466656764e6e5e7e4161517149695979456555754d6d5d7d436353734b6b5b7b476757774f6f5fff848993264f993a6dfa8c99b366cf993b6ffe82858b162f59ba6cf98a95ab56af59bb6efd868d9b366fd9ba6dfb8e9dbb76efd9bb6fff8183870e1f397aecf88993a74e9f397beefc858b972e5fb97aedfa8d9bb76edfb97beffe83878f1e3f79faecf98b97af5ebf79fbeefd878f9f3e7ff9faedfb8f9fbf7efff9fbefbf4f696ebe42516a624a31386092f2138b5232f3d2159281b495427a6249aa8293a1918e42716a628982a189232de36234e246236e34e246236ed8441c008218006a";

    #[test]
    fn inflate_reads_each_kind_of_block() {
        assert_eq!(inflate_zlib(&unhex(FIXED), MAX_STREAM), b"BT /F1 12 Tf 72 712 Td (Hello, PDF!) Tj ET");
        assert_eq!(inflate_zlib(&unhex(STORED), MAX_STREAM), b"stored bytes");
        let mut expected = Vec::new();
        for _ in 0..4 {
            for _ in 0..3 {
                expected.extend_from_slice(b"The quick brown fox jumps over the lazy dog. ");
            }
            expected.extend(0..=255u8);
            expected.extend_from_slice(b"Lumo reads the boarding card: gate B12, seat 14A. ");
        }
        assert_eq!(inflate_zlib(&unhex(DYNAMIC), MAX_STREAM), expected);
        // Cut short, what came before stays; capped, no more than asked.
        assert!(inflate_zlib(&unhex(&DYNAMIC[..400]), MAX_STREAM).starts_with(b"The quick brown fox"));
        assert_eq!(inflate_zlib(&unhex(DYNAMIC), 10).len(), 10);
        assert!(inflate_zlib(b"not compressed at all", MAX_STREAM).len() < 100);
    }

    /// A PDF of `objects` ("N 0 obj ... endobj" each), streams given raw.
    fn pdf(objects: &[(u32, Vec<u8>)]) -> Vec<u8> {
        let mut out = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n".to_vec();
        for (n, body) in objects {
            out.extend_from_slice(format!("{n} 0 obj\n").as_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(b"\nendobj\n");
        }
        out.extend_from_slice(b"trailer\n<< /Root 1 0 R >>\n%%EOF\n");
        out
    }

    fn stream(dict: &str, data: &[u8]) -> Vec<u8> {
        let mut out = format!("<< {dict} /Length {} >>\nstream\n", data.len()).into_bytes();
        out.extend_from_slice(data);
        out.extend_from_slice(b"\nendstream");
        out
    }

    #[test]
    fn numbers_past_the_file_do_not_bring_it_down() {
        // A /Length of 1e20 once wrapped around to just before the stream's start.
        let file = b"%PDF-1.4\n1 0 obj\n<< /Length 100000000000000000000 >>\nstream\nendstream\nendobj\n2 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 2 0 R >>\n%%EOF\n";
        assert_eq!(text_of(file, 10_000), None);
        for length in ["-5", "1e400", "18446744073709551615"] {
            let file = format!("%PDF-1.4\n1 0 obj\n<< /Length {length} >>\nstream\nendstream\nendobj\n");
            assert_eq!(text_of(file.as_bytes(), 10_000), None);
        }
        // An object stream whose /First and offsets run past usize.
        let file = pdf(&[(1, stream("/Type /ObjStm /N 1 /First 100000000000000000000", b"7 18446744073709551615 << >>"))]);
        assert_eq!(text_of(&file, 10_000), None);
    }

    #[test]
    fn a_stream_named_again_and_again_stops_at_the_documents_budget() {
        let big = vec![b' '; 4 * 1024 * 1024];
        let refs = "6 0 R ".repeat(40);
        let file = pdf(&[
            (1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec()),
            (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec()),
            (3, format!("<< /Type /Page /Parent 2 0 R /Contents [{refs}] >>").into_bytes()),
            (6, stream("", &big)),
        ]);
        let doc = Doc::read(&file);
        let given: usize = (0..40).filter_map(|_| doc.stream(6)).map(|s| s.len()).sum();
        assert!(given <= MAX_DOC, "{given}");
        assert!(given >= MAX_DOC - big.len());
        assert_eq!(doc.stream(6), None);
        // The whole page, 160 MB as named, reads within the budget too.
        assert_eq!(text_of(&file, 10_000), None);
    }

    #[test]
    fn a_pdf_gives_its_pages_text_in_order() {
        let page2 = b"BT /F1 11 Tf 1 0 0 1 72 700 Tm (Gate) Tj 1 0 0 1 120 700 Tm (B12) Tj 1 0 0 1 72 680 Tm [(Seat) -300 (14A)] TJ ET".to_vec();
        let file = pdf(&[
            (1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec()),
            (2, b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 /Resources << /Font << /F1 5 0 R >> >> >>".to_vec()),
            // The first page's text is compressed (the FIXED stream: "Hello, PDF!").
            (3, b"<< /Type /Page /Parent 2 0 R /Contents 6 0 R >>".to_vec()),
            (4, b"<< /Type /Page /Parent 2 0 R /Contents [7 0 R] >>".to_vec()),
            (5, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_vec()),
            (6, stream("/Filter /FlateDecode", &unhex(FIXED))),
            (7, stream("", &page2)),
        ]);
        assert_eq!(text_of(&file, 10_000).unwrap(), "Hello, PDF!\n\nGate B12\nSeat 14A");
        assert_eq!(text_of(&file, 5).unwrap(), "Hello");
    }

    #[test]
    fn a_font_with_two_byte_codes_is_read_through_its_unicode_map() {
        let cmap = b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n2 beginbfchar <0003> <0020> <0011> <00E8> endbfchar\n1 beginbfrange <0024> <0026> <0041> endbfrange\nendcmap end end";
        let content = b"BT /C0 10 Tf 72 700 Td <00240025002600030011> Tj ET";
        let file = pdf(&[
            (1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec()),
            (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec()),
            (3, b"<< /Type /Page /Parent 2 0 R /Resources << /Font << /C0 4 0 R >> >> /Contents 5 0 R >>".to_vec()),
            (4, b"<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Roboto /Encoding /Identity-H /ToUnicode 6 0 R >>".to_vec()),
            (5, stream("", content)),
            (6, stream("", cmap)),
        ]);
        assert_eq!(text_of(&file, 10_000).unwrap(), "ABC è");
    }

    #[test]
    fn fonts_and_pages_packed_in_an_object_stream_are_found() {
        let objs = b"<< /Type /Catalog /Pages 2 0 R >> << /Type /Pages /Kids [3 0 R] /Count 1 >> << /Type /Page /Parent 2 0 R /Contents 5 0 R >>";
        let header = "1 0 2 34 3 76 ";
        let mut packed = header.as_bytes().to_vec();
        packed.extend_from_slice(objs);
        let file = pdf(&[
            (4, stream(&format!("/Type /ObjStm /N 3 /First {}", header.len()), &packed)),
            (5, stream("", b"BT (Caf\\351 \\(1\\)) Tj ET")),
        ]);
        assert_eq!(text_of(&file, 10_000).unwrap(), "Café (1)");
    }

    #[test]
    fn a_scan_an_encrypted_file_or_no_pdf_gives_nothing() {
        let scan = pdf(&[
            (1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec()),
            (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec()),
            (3, b"<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>".to_vec()),
            (4, stream("", b"q 595 0 0 842 0 0 cm /Im0 Do Q")),
        ]);
        assert_eq!(text_of(&scan, 100), None);
        let mut locked = pdf(&[(1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec())]);
        locked.extend_from_slice(b"trailer\n<< /Root 1 0 R /Encrypt 9 0 R >>\n");
        assert_eq!(text_of(&locked, 100), None);
        assert_eq!(text_of(b"hello", 100), None);
        assert_eq!(text_of(b"%PDF-1.4 garbage ( [ << 1 0 obj", 100), None);
    }
}
