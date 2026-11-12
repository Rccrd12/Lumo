//! How much a file tool's request changes, for the line under the file on its
//! card: lines added and removed, and the size a whole-file write leaves.
//!
//! Read by the relay from the request as it came, before any text is cut, so
//! a change of any size gets true numbers. A whole-file write (Claude Code's
//! Write, Antigravity's write_to_file, Gemini CLI's write_file…) is compared
//! with the file as it is on disk: rewriting 8,000 lines to add 50 says
//! `+50 −0`, and a rewrite that drops a chapter says so. A replacement
//! (old/new text, each of MultiEdit's edits, each of Antigravity's chunks) is
//! compared with the text it replaces.
//!
//! The comparison is quick and never slows the agent: the lines both texts
//! start and end with are set aside, and what is left is counted line by line,
//! in any order (a line moved within the change counts as neither added nor
//! removed). A file too big to read quickly, or one that can't be read, gives
//! no numbers rather than wrong ones.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// The most of a file on disk read to compare a whole-file write with.
const MAX_FILE: u64 = 16 * 1024 * 1024;

/// The keys of a whole-file write's new text.
const WHOLE_FIELDS: &[&str] = &["content", "CodeContent", "file_text"];
/// The keys of a replacement: the text replaced, the text put in its place.
const PAIRS: &[(&str, &str)] = &[
    ("old_string", "new_string"),
    ("TargetContent", "ReplacementContent"),
    ("Target", "Replacement"),
    ("old_str", "new_str"),
    ("oldString", "newString"),
];
/// The keys naming the file a tool writes.
const PATH_FIELDS: &[&str] = &["file_path", "TargetFile", "Path", "path", "AbsolutePath", "FilePath", "filePath"];

/// What a request changes: lines added and removed, and for a whole-file
/// write the bytes the file will have.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stat {
    pub added: usize,
    pub removed: usize,
    pub bytes: Option<usize>,
}

/// The numbers of a file tool's `input`, `cwd` being where a relative path
/// starts. None when nothing in it writes text, or the file to compare with
/// could not be read.
pub fn of_request(input: &Value, cwd: &str) -> Option<Stat> {
    let map = input.as_object()?;
    // A whole-file write: its new text against the file on disk.
    if let Some(text) = WHOLE_FIELDS.iter().find_map(|k| map.get(*k).and_then(Value::as_str)) {
        let path = PATH_FIELDS.iter().find_map(|k| map.get(*k).and_then(Value::as_str)).filter(|p| !p.trim().is_empty())?;
        let old = on_disk(&resolve(path, cwd))?;
        let (added, removed) = lines_changed(&old, text);
        return Some(Stat { added, removed, bytes: Some(text.len()) });
    }
    // Replacements, wherever they are (MultiEdit's `edits`, Antigravity's chunks).
    let mut total = (0, 0);
    let mut any = false;
    pairs(input, &mut |old, new| {
        let (a, r) = lines_changed(old, new);
        total.0 += a;
        total.1 += r;
        any = true;
    });
    any.then_some(Stat { added: total.0, removed: total.1, bytes: None })
}

/// Every old/new pair in `value`, at any depth.
fn pairs(value: &Value, f: &mut dyn FnMut(&str, &str)) {
    match value {
        Value::Object(map) => {
            for (old, new) in PAIRS {
                if let (Some(o), Some(n)) = (map.get(*old).and_then(Value::as_str), map.get(*new).and_then(Value::as_str)) {
                    f(o, n);
                }
            }
            map.values().for_each(|v| pairs(v, f));
        }
        Value::Array(items) => items.iter().for_each(|v| pairs(v, f)),
        _ => {}
    }
}

/// `path` as the tool means it: relative to `cwd`, `file://` read as a path.
fn resolve(path: &str, cwd: &str) -> PathBuf {
    let p = path.trim();
    let p = p.strip_prefix("file:///").or_else(|| p.strip_prefix("file://")).unwrap_or(p);
    let p = Path::new(p);
    if p.is_absolute() || cwd.is_empty() { p.to_path_buf() } else { Path::new(cwd).join(p) }
}

/// The file's text now: empty when there is none yet (a new file), None
/// when it is too big to read quickly or can't be read.
fn on_disk(path: &Path) -> Option<String> {
    match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(String::new()),
        Err(_) => None,
        Ok(m) if !m.is_file() || m.len() > MAX_FILE => None,
        Ok(_) => std::fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned()),
    }
}

/// Lines added and removed going from `old` to `new`: the lines both start
/// and end with set aside, the rest counted line by line in any order.
/// Lines as the island counts them (diff.ts splitLines): a last line break
/// ends a line, it does not start one; `\r\n` is a line break.
pub fn lines_changed(old: &str, new: &str) -> (usize, usize) {
    let a = split_lines(old);
    let b = split_lines(new);
    let start = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let end = a[start..].iter().rev().zip(b[start..].iter().rev()).take_while(|(x, y)| x == y).count();
    let (a, b) = (&a[start..a.len() - end], &b[start..b.len() - end]);
    let mut counts: HashMap<&str, isize> = HashMap::new();
    for line in a {
        *counts.entry(line).or_default() += 1;
    }
    for line in b {
        *counts.entry(line).or_default() -= 1;
    }
    let removed = counts.values().filter(|&&n| n > 0).map(|&n| n as usize).sum();
    let added = counts.values().filter(|&&n| n < 0).map(|&n| (-n) as usize).sum();
    (added, removed)
}

fn split_lines(text: &str) -> Vec<&str> {
    if text.is_empty() {
        return Vec::new();
    }
    let text = text.strip_suffix('\n').unwrap_or(text);
    text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lines_are_counted_as_the_island_counts_them() {
        assert_eq!(lines_changed("", ""), (0, 0));
        assert_eq!(lines_changed("", "a\nb\n"), (2, 0));
        assert_eq!(lines_changed("", "a\nb"), (2, 0));
        assert_eq!(lines_changed("a\nb\n", ""), (0, 2));
        assert_eq!(lines_changed("a\r\nb\r\n", "a\nb\n"), (0, 0), "line ends are not a change");
    }

    #[test]
    fn a_rewrite_that_only_adds_says_so() {
        let old: String = (0..8_700).map(|i| format!("riga {i}\n")).collect();
        let mut new = old.clone();
        let at = old.find("riga 8640\n").unwrap();
        new.insert_str(at, &"\\item nuovo\n".repeat(1_249));
        assert_eq!(lines_changed(&old, &new), (1_249, 0));
        // Two changes far apart: only what changed, not all that is between them.
        let new = old.replacen("riga 10\n", "riga dieci\n", 1).replacen("riga 8000\n", "riga ottomila\n", 1);
        assert_eq!(lines_changed(&old, &new), (2, 2));
        // A chapter dropped is lines removed.
        let start = old.find("riga 100\n").unwrap();
        let end = old.find("riga 600\n").unwrap();
        let new = format!("{}{}", &old[..start], &old[end..]);
        assert_eq!(lines_changed(&old, &new), (0, 500));
    }

    #[test]
    fn a_whole_file_write_is_compared_with_the_file_on_disk() {
        let dir = std::env::temp_dir().join(format!("lumo-write-stat-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("Analisi2.tex");
        std::fs::write(&file, "a\nb\nc\n").unwrap();
        let path = file.to_string_lossy().to_string();
        for (key, text) in [("file_path", "content"), ("TargetFile", "CodeContent"), ("path", "file_text")] {
            let s = of_request(&json!({ key: path, text: "a\nb\nnuova\nc\n" }), "").unwrap();
            assert_eq!(s, Stat { added: 1, removed: 0, bytes: Some(12) }, "{key}");
        }
        // Relative to where the agent works.
        let s = of_request(&json!({ "file_path": "Analisi2.tex", "content": "a\n" }), &dir.to_string_lossy()).unwrap();
        assert_eq!((s.added, s.removed), (0, 2));
        // A new file: all of it is added.
        let s = of_request(&json!({ "file_path": dir.join("new.txt").to_string_lossy(), "content": "x\ny\n" }), "").unwrap();
        assert_eq!(s, Stat { added: 2, removed: 0, bytes: Some(4) });
        // A folder can't be compared with: no numbers.
        assert_eq!(of_request(&json!({ "file_path": dir.to_string_lossy(), "content": "x" }), ""), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn replacements_are_compared_with_the_text_they_replace() {
        for (old, new) in PAIRS {
            let s = of_request(&json!({ "file_path": "C:/x.tex", *old: "a\nb\n", *new: "a\nB\nc\n" }), "").unwrap();
            assert_eq!(s, Stat { added: 2, removed: 1, bytes: None }, "{old}");
        }
        // Antigravity CLI's edit_file.
        let s = of_request(&json!({ "Path": "C:/x.tex", "Target": "\\label{def:serie}\n", "Replacement": "\\label{def:serie}\n\\section{Serie}\n" }), "").unwrap();
        assert_eq!((s.added, s.removed), (1, 0));
        // MultiEdit's edits and Antigravity's chunks, all together.
        let s = of_request(&json!({ "file_path": "C:/x", "edits": [{ "old_string": "a", "new_string": "b" }, { "old_string": "c", "new_string": "c\nd" }] }), "").unwrap();
        assert_eq!((s.added, s.removed), (2, 1));
        let s = of_request(&json!({ "TargetFile": "C:/x", "ReplacementChunks": [{ "TargetContent": "a", "ReplacementContent": "" }] }), "").unwrap();
        assert_eq!((s.added, s.removed), (0, 1));
        // Nothing written: no numbers.
        assert_eq!(of_request(&json!({ "command": "ls" }), ""), None);
        assert_eq!(of_request(&json!("text"), ""), None);
    }
}
