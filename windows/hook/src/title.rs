//! The title of a Claude Code session, from the end of its transcript: the
//! last `custom-title` entry (the user's own, `/rename`), else the last
//! `ai-title` one (the title Claude Code gives the session itself). Entries are
//! told by their type, so a message that only quotes one is no title.
//!
//! Only the tail is read: Claude Code writes the title again every 40 to 80 KB,
//! so 256 KB always holds the latest, and a long session costs no more than a
//! short one.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::Value;

/// How much of the transcript's end is read.
const TAIL: u64 = 256 * 1024;
/// Longest title passed on; the island shows far less.
const MAX_TITLE: usize = 120;

/// The session's title, or None when it has none yet or the file can't be read.
pub fn session_title(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut tail = Vec::with_capacity((len - start) as usize);
    file.take(TAIL).read_to_end(&mut tail).ok()?;
    // Started mid-file: the first line is cut, and not one to read.
    title_in(&tail, start > 0)
}

/// The title in `tail`, the end of a transcript; `cut` when its first line is
/// a piece of a longer one.
pub fn title_in(tail: &[u8], cut: bool) -> Option<String> {
    let mut lines: Vec<&[u8]> = tail.split(|b| *b == b'\n').collect();
    if cut && !lines.is_empty() {
        lines.remove(0);
    }
    let mut ai_title = None;
    for line in lines.iter().rev() {
        let has = |needle: &[u8]| line.windows(needle.len()).any(|w| w == needle);
        if !has(b"custom-title") && !has(b"ai-title") {
            continue;
        }
        let Ok(entry) = serde_json::from_slice::<Value>(line) else { continue };
        let text = |key: &str| entry.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
        match entry.get("type").and_then(Value::as_str) {
            Some("custom-title") => {
                if let Some(title) = text("customTitle") {
                    return Some(shorten(title));
                }
            }
            Some("ai-title") if ai_title.is_none() => ai_title = text("aiTitle").map(shorten),
            _ => {}
        }
    }
    ai_title
}

/// One line, at most MAX_TITLE characters.
fn shorten(title: &str) -> String {
    let one_line = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= MAX_TITLE {
        return one_line;
    }
    let mut cut: String = one_line.chars().take(MAX_TITLE - 1).collect();
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(entries: &[&str]) -> Vec<u8> {
        let mut out = entries.join("\n");
        out.push('\n');
        out.into_bytes()
    }

    #[test]
    fn the_users_title_wins_over_claude_codes_and_the_last_one_counts() {
        let t = lines(&[
            r#"{"type":"ai-title","aiTitle":"Old guess"}"#,
            r#"{"type":"custom-title","customTitle":"Dark theme in settings"}"#,
            r#"{"type":"user","message":{"content":"hi"}}"#,
            r#"{"type":"ai-title","aiTitle":"Newer guess"}"#,
        ]);
        assert_eq!(title_in(&t, false).as_deref(), Some("Dark theme in settings"));
        let t = lines(&[r#"{"type":"ai-title","aiTitle":"Old"}"#, r#"{"type":"ai-title","aiTitle":"Fix the export button"}"#]);
        assert_eq!(title_in(&t, false).as_deref(), Some("Fix the export button"));
    }

    #[test]
    fn a_line_that_only_mentions_a_title_is_not_one() {
        let t = lines(&[
            r#"{"type":"ai-title","aiTitle":"Real title"}"#,
            r#"{"type":"user","message":{"content":"grep for \"type\":\"custom-title\" please"}}"#,
        ]);
        assert_eq!(title_in(&t, false).as_deref(), Some("Real title"));
        assert_eq!(title_in(&lines(&[r#"{"type":"user","message":"nothing"}"#]), false), None);
        assert_eq!(title_in(b"", false), None);
    }

    #[test]
    fn a_cut_first_line_is_skipped_and_a_long_title_is_shortened() {
        let t = lines(&[r#"tle","customTitle":"Half a line"}"#, r#"{"type":"ai-title","aiTitle":"Whole"}"#]);
        assert_eq!(title_in(&t, true).as_deref(), Some("Whole"));
        let long = format!(r#"{{"type":"custom-title","customTitle":"{}"}}"#, "a ".repeat(200));
        let title = title_in(&lines(&[&long]), false).unwrap();
        assert_eq!(title.chars().count(), MAX_TITLE);
        assert!(title.ends_with('…'));
    }

    #[test]
    fn the_title_is_read_from_the_end_of_a_long_file() {
        let dir = std::env::temp_dir().join(format!("lumo-title-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.jsonl");
        let filler = format!("{}\n", r#"{"type":"assistant","message":"x"}"#).repeat(20_000);
        let body = format!("{}\n{filler}{}\n", r#"{"type":"custom-title","customTitle":"Too far back"}"#, r#"{"type":"ai-title","aiTitle":"Near the end"}"#);
        std::fs::write(&path, body).unwrap();
        assert_eq!(session_title(&path).as_deref(), Some("Near the end"));
        assert_eq!(session_title(&dir.join("missing.jsonl")), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
