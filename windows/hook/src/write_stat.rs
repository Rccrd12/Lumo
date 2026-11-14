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
//! start and end with are set aside, and what is left is compared line by line
//! as the island's diff does (diff.ts, a longest common subsequence) while it
//! is small, else counted in any order; a change that only moves lines is
//! still a change (`+n −n`, never nothing). A replacement made everywhere
//! (`replace_all`, `AllowMultiple`, `expected_replacements`) counts once per
//! place it is made. A file too big to read quickly, on a network share, held
//! only in the cloud (OneDrive's files on demand) or one that can't be read
//! gives no numbers rather than wrong ones, and no download. The relay gives
//! up after a moment anyway (main.rs STAT_BUDGET).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// The most of a file on disk read to compare a whole-file write with.
const MAX_FILE: u64 = 4 * 1024 * 1024;
/// Past this many cells of the line table, lines are counted in any order (diff.ts DIFF_MAX_CELLS).
const MAX_CELLS: usize = 1_000_000;

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
    let path = PATH_FIELDS.iter().find_map(|k| map.get(*k).and_then(Value::as_str)).filter(|p| !p.trim().is_empty());
    // A whole-file write: its new text against the file on disk.
    if let Some(text) = WHOLE_FIELDS.iter().find_map(|k| map.get(*k).and_then(Value::as_str)) {
        let old = on_disk(&resolve(path?, cwd)?)?;
        let (added, removed) = lines_changed(&old, text);
        return Some(Stat { added, removed, bytes: Some(text.len()) });
    }
    // Replacements, wherever they are (MultiEdit's `edits`, Antigravity's
    // chunks), each as many times as it is made. The file is read only for a
    // replacement made everywhere, and once.
    let mut file: Option<Option<String>> = None;
    let mut total = (0, 0);
    let mut any = false;
    pairs(input, map.get("expected_replacements"), &mut |old, new, every| {
        let times = match every {
            Every::Times(n) => n,
            Every::Once => 1,
            Every::Everywhere => {
                let text = file.get_or_insert_with(|| path.and_then(|p| resolve(p, cwd)).and_then(|p| on_disk(&p)));
                text.as_deref().filter(|_| !old.is_empty()).map_or(1, |t| t.matches(old).count().max(1))
            }
        };
        let (a, r) = lines_changed(old, new);
        total.0 += a * times;
        total.1 += r * times;
        any = true;
    });
    any.then_some(Stat { added: total.0, removed: total.1, bytes: None })
}

/// How many times a replacement is made.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Every {
    /// Once: the old text is unique in the file.
    Once,
    /// As many times as the agent says (Gemini CLI's `expected_replacements`).
    Times(usize),
    /// Everywhere the old text is (`replace_all`, Antigravity's `AllowMultiple`).
    Everywhere,
}

/// Every old/new pair in `value`, at any depth, with how many times it is
/// made: its own flags, else `expected` (the request's `expected_replacements`).
fn pairs(value: &Value, expected: Option<&Value>, f: &mut dyn FnMut(&str, &str, Every)) {
    match value {
        Value::Object(map) => {
            for (old, new) in PAIRS {
                if let (Some(o), Some(n)) = (map.get(*old).and_then(Value::as_str), map.get(*new).and_then(Value::as_str)) {
                    let flag = |k: &str| map.get(k).and_then(Value::as_bool) == Some(true);
                    let times = map.get("expected_replacements").or(expected).and_then(Value::as_u64).filter(|&n| n > 1);
                    let every = if flag("replace_all") || flag("AllowMultiple") {
                        Every::Everywhere
                    } else if let Some(n) = times {
                        Every::Times(usize::try_from(n).unwrap_or(usize::MAX))
                    } else {
                        Every::Once
                    };
                    f(o, n, every);
                }
            }
            map.values().for_each(|v| pairs(v, expected, f));
        }
        Value::Array(items) => items.iter().for_each(|v| pairs(v, expected, f)),
        _ => {}
    }
}

/// `path` as the tool means it: relative to `cwd`, `file://` read as a path.
/// None for a path the relay never reads: on another computer (`\\server\share`,
/// `//server/share`, `file://server/…`) or one of Windows' own (`\\?\`, `\\.\`):
/// touching it could wait on the network, or sign in to a server.
fn resolve(path: &str, cwd: &str) -> Option<PathBuf> {
    let p = path.trim();
    let p = p.strip_prefix("file:///").map(str::to_string).or_else(|| p.strip_prefix("file://").map(|rest| format!("//{rest}"))).unwrap_or_else(|| p.to_string());
    let far = |s: &str| s.starts_with("\\\\") || s.starts_with("//") || s.starts_with("\\/") || s.starts_with("/\\");
    if far(&p) {
        return None;
    }
    let full = if Path::new(&p).is_absolute() || cwd.is_empty() { PathBuf::from(&p) } else { Path::new(cwd).join(&p) };
    (!far(&full.to_string_lossy())).then_some(full)
}

/// The file's text now: empty when there is none yet (a new file), None
/// when it is too big to read quickly, held only in the cloud, or can't be read.
fn on_disk(path: &Path) -> Option<String> {
    match std::fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(String::new()),
        Err(_) => None,
        Ok(m) if !m.is_file() || m.len() > MAX_FILE || in_the_cloud(&m) => None,
        Ok(_) => std::fs::read(path).ok().map(|b| String::from_utf8_lossy(&b).into_owned()),
    }
}

/// A file whose text is not on this computer yet (OneDrive's files on demand,
/// an offline file): reading it would download it first.
#[cfg(windows)]
fn in_the_cloud(m: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const OFFLINE: u32 = 0x0000_1000;
    const RECALL_ON_OPEN: u32 = 0x0004_0000;
    const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    m.file_attributes() & (OFFLINE | RECALL_ON_OPEN | RECALL_ON_DATA_ACCESS) != 0
}

#[cfg(not(windows))]
fn in_the_cloud(_: &std::fs::Metadata) -> bool {
    false
}

/// Lines added and removed going from `old` to `new`: the lines both start
/// and end with set aside, the rest compared as the island's diff does (a
/// longest common subsequence) while it is small, else counted line by line
/// in any order. Lines as the island counts them (diff.ts splitLines): a last
/// line break ends a line, it does not start one; `\r\n` is a line break.
pub fn lines_changed(old: &str, new: &str) -> (usize, usize) {
    let a = split_lines(old);
    let b = split_lines(new);
    let start = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let end = a[start..].iter().rev().zip(b[start..].iter().rev()).take_while(|(x, y)| x == y).count();
    let (a, b) = (&a[start..a.len() - end], &b[start..b.len() - end]);
    if a.len().saturating_mul(b.len()) <= MAX_CELLS {
        let common = common_lines(a, b);
        return (b.len() - common, a.len() - common);
    }
    let mut counts: HashMap<&str, isize> = HashMap::new();
    for line in a {
        *counts.entry(line).or_default() += 1;
    }
    for line in b {
        *counts.entry(line).or_default() -= 1;
    }
    let removed = counts.values().filter(|&&n| n > 0).map(|&n| n as usize).sum();
    let added: usize = counts.values().filter(|&&n| n < 0).map(|&n| (-n) as usize).sum();
    if added == 0 && removed == 0 && a != b {
        // The same lines in another order: every line not in its place is a
        // change, never "nothing changes" (a check moved after what it guards).
        let moved = a.iter().zip(b).filter(|(x, y)| x != y).count();
        return (moved, moved);
    }
    (added, removed)
}

/// The length of the longest common subsequence of `a` and `b`, two rows at a time.
fn common_lines(a: &[&str], b: &[&str]) -> usize {
    let mut prev = vec![0u32; b.len() + 1];
    let mut row = vec![0u32; b.len() + 1];
    for x in a {
        for (j, y) in b.iter().enumerate() {
            row[j + 1] = if x == y { prev[j] + 1 } else { prev[j + 1].max(row[j]) };
        }
        std::mem::swap(&mut prev, &mut row);
    }
    prev[b.len()] as usize
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
    fn lines_only_moved_are_still_a_change() {
        // A check moved after what it guards: the same lines, another order.
        let old = "@echo off\nif not exist C:\\safe exit /b\ndel /q C:\\data\\*\n";
        let new = "@echo off\ndel /q C:\\data\\*\nif not exist C:\\safe exit /b\n";
        assert_eq!(lines_changed(old, new), (1, 1));
        // One line moved past a hundred others is one line, as the island's diff says.
        let lines: Vec<String> = (0..102).map(|i| format!("line {i}\n")).collect();
        let mut moved = lines.clone();
        let first = moved.remove(1);
        moved.insert(101, first);
        assert_eq!(lines_changed(&lines.concat(), &moved.concat()), (1, 1));
        // Too big to compare in order: still never "nothing".
        let big: Vec<String> = (0..3_000).map(|i| format!("row {i}\n")).collect();
        let mut swapped = big.clone();
        swapped.swap(0, 2_999);
        let (a, r) = lines_changed(&big.concat(), &swapped.concat());
        assert!(a > 0 && r > 0, "{a} {r}");
    }

    #[test]
    fn a_replacement_made_everywhere_counts_each_place() {
        let dir = std::env::temp_dir().join(format!("lumo-write-stat-all-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("a.ts");
        std::fs::write(&file, "foo();\nbar();\nfoo();\nfoo();\n").unwrap();
        let path = file.to_string_lossy().to_string();
        let s = of_request(&json!({ "file_path": path, "old_string": "foo();", "new_string": "foo(1);", "replace_all": true }), "").unwrap();
        assert_eq!((s.added, s.removed), (3, 3), "Claude Code's replace_all");
        let s = of_request(&json!({ "TargetFile": path, "ReplacementChunks": [{ "TargetContent": "foo();", "ReplacementContent": "x", "AllowMultiple": true }] }), "").unwrap();
        assert_eq!((s.added, s.removed), (3, 3), "Antigravity's AllowMultiple");
        let s = of_request(&json!({ "file_path": path, "old_string": "a", "new_string": "b", "expected_replacements": 5 }), "").unwrap();
        assert_eq!((s.added, s.removed), (5, 5), "Gemini CLI's expected_replacements");
        let s = of_request(&json!({ "file_path": path, "edits": [{ "old_string": "bar();", "new_string": "baz();" }, { "old_string": "foo();", "new_string": "", "replace_all": true }] }), "").unwrap();
        assert_eq!((s.added, s.removed), (1, 4), "MultiEdit, each edit its own way");
        // A file that can't be read: once, rather than nothing.
        let s = of_request(&json!({ "file_path": dir.join("none.ts").to_string_lossy(), "old_string": "a", "new_string": "b", "replace_all": true }), "").unwrap();
        assert_eq!((s.added, s.removed), (1, 1));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_file_on_another_computer_is_never_read() {
        for path in [r"\\server\share\a.txt", "//server/share/a.txt", "file://server/share/a.txt", r"\\?\UNC\server\share\a.txt", r"\\.\pipe\lumo"] {
            assert_eq!(resolve(path, ""), None, "{path}");
            assert_eq!(of_request(&json!({ "file_path": path, "content": "a\n" }), ""), None, "{path}");
        }
        // Nor a relative path where the agent works on a share.
        assert_eq!(resolve("a.txt", r"\\server\share\proj"), None);
        assert!(resolve("file:///C:/proj/a.txt", "").is_some());
        assert!(resolve("a.txt", "/home/me/proj").is_some());
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
