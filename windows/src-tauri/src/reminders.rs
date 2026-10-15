// Reminders at a time of day ("remind me at 9 tomorrow to call the bank"), set
// by Gemini Live's set_reminder. Unlike the island's timers they are kept in a
// file, so a restart, or a night with the computer off, doesn't lose them: one
// that came due while Lumo was not running rings as soon as it starts again.
//
// One thread sleeps until the next one is due (or the list changes) and then
// tells the island (`reminder-due`), which rings and shows it. It wakes for
// nothing else, so it costs nothing while it waits.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::island::WINDOW_LABEL;
use crate::platform;

/// A reminder is a line, not a note.
pub const MAX_TEXT: usize = 200;
pub const MAX_REMINDERS: usize = 100;
/// How far ahead one may be set.
pub const MAX_AHEAD_MS: u64 = 366 * 24 * 3_600_000;
/// How long after starting the first reminders may ring.
const STARTUP_MS: u64 = 10_000;
/// How long one note shows on the closed island (core/compact.ts NOTICE_MS).
const NOTE_MS: u64 = 4_500;
/// Missed by more than this while Lumo was off: dropped without ringing.
pub const STALE_MS: u64 = 7 * 24 * 3_600_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reminder {
    pub id: u32,
    /// Unix ms at which it rings.
    pub at: u64,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Due {
    pub reminder: Reminder,
    /// It came due while Lumo wasn't running.
    pub missed: bool,
}

struct Store {
    loaded: bool,
    list: Vec<Reminder>,
    /// Bumped on each change, so the waiting thread looks again.
    version: u64,
}

static STORE: Mutex<Store> = Mutex::new(Store { loaded: false, list: Vec::new(), version: 0 });
static CHANGED: Condvar = Condvar::new();

fn file() -> PathBuf {
    platform::local_dir().join("reminders.json")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load(s: &mut Store) {
    if s.loaded {
        return;
    }
    s.loaded = true;
    s.list = std::fs::read_to_string(file()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    s.list.retain(|r| !r.text.trim().is_empty());
    s.list.truncate(MAX_REMINDERS);
}

/// Writes beside the file and renames over it, as settings.rs does: a crash
/// or a full disk leaves the reminders that were there rather than half a file.
fn save(list: &[Reminder]) -> std::io::Result<()> {
    use std::io::Write;
    let path = file();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_vec(list).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let temp = path.with_extension(format!("json.lumo-{}", std::process::id()));
    let written = std::fs::File::create(&temp)
        .and_then(|mut file| file.write_all(&text).and_then(|()| file.sync_all()))
        .and_then(|()| std::fs::rename(&temp, &path));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
}

/// A save whose failure only goes in the log: the reminder is already gone
/// from the list in memory, so there is nothing to tell the user.
fn save_noted(list: &[Reminder]) {
    if let Err(err) = save(list) {
        crate::log::line(format!("could not save the reminders: {err}"));
    }
}

/// The text as kept: one line, capped.
pub fn clean_text(text: &str) -> String {
    let one: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    one.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_TEXT).collect()
}

/// Checks a new reminder against the time now.
pub fn check(at: u64, text: &str, now: u64, count: usize) -> Result<String, String> {
    let text = clean_text(text);
    if text.is_empty() {
        return Err("Say what the reminder is for.".into());
    }
    if at <= now {
        return Err("That time has already gone by: say a time still to come.".into());
    }
    if at - now > MAX_AHEAD_MS {
        return Err("A reminder can be set up to a year ahead.".into());
    }
    if count >= MAX_REMINDERS {
        return Err(format!("There are already {MAX_REMINDERS} reminders: cancel some first."));
    }
    Ok(text)
}

/// At most this many ring at once: the closed island keeps four notes waiting
/// and drops the oldest, so the rest wait their turn (and stay on disk until
/// they have had it) rather than going by unseen.
const AT_ONCE: usize = 4;

/// The reminders due by `now`, taken off `list`, `AT_ONCE` at most and the
/// oldest first; `started` marks the ones missed while Lumo was off (due
/// before it started), and the ones missed by more than STALE_MS are dropped.
pub fn take_due(list: &mut Vec<Reminder>, now: u64, started: u64) -> Vec<Due> {
    let (due, mut rest): (Vec<Reminder>, Vec<Reminder>) = list.drain(..).partition(|r| r.at <= now);
    let mut due: Vec<Reminder> = due.into_iter().filter(|r| now.saturating_sub(r.at) <= STALE_MS).collect();
    due.sort_by_key(|r| r.at);
    if due.len() > AT_ONCE {
        rest.extend(due.split_off(AT_ONCE));
        rest.sort_by_key(|r| r.at);
    }
    *list = rest;
    due.into_iter().map(|r| Due { missed: r.at < started, reminder: r }).collect()
}

pub fn add(at: u64, text: &str) -> Result<Reminder, String> {
    let mut s = STORE.lock().unwrap();
    load(&mut s);
    let text = check(at, text, now_ms(), s.list.len())?;
    let id = s.list.iter().map(|r| r.id).max().unwrap_or(0).saturating_add(1);
    let r = Reminder { id, at, text };
    s.list.push(r.clone());
    s.list.sort_by_key(|r| r.at);
    // Kept only once it is on disk: a reminder Lumo could not write would be
    // lost at the next restart, and the user was told it was set.
    if let Err(err) = save(&s.list) {
        crate::log::line(format!("could not save the reminders: {err}"));
        s.list.retain(|r| r.id != id);
        return Err("Could not keep that reminder.".into());
    }
    s.version += 1;
    CHANGED.notify_all();
    Ok(r)
}

pub fn list() -> Vec<Reminder> {
    let mut s = STORE.lock().unwrap();
    load(&mut s);
    s.list.clone()
}

pub fn cancel(id: u32) -> bool {
    let mut s = STORE.lock().unwrap();
    load(&mut s);
    let before = s.list.len();
    s.list.retain(|r| r.id != id);
    let gone = s.list.len() != before;
    if gone {
        save_noted(&s.list);
        s.version += 1;
        CHANGED.notify_all();
    }
    gone
}

/// The thread that rings them.
pub fn start(app: AppHandle) {
    let started = now_ms();
    std::thread::spawn(move || {
        // The island listens once its page has loaded: a reminder missed while
        // Lumo was off waits for it rather than ringing to no one. Waited out
        // once, here: inside the loop a clock put back would wait it out again,
        // in a sleep the list changing cannot interrupt.
        std::thread::sleep(Duration::from_millis(STARTUP_MS));
        loop {
            let mut s = STORE.lock().unwrap();
            load(&mut s);
            let due = take_due(&mut s.list, now_ms(), started);
            if !due.is_empty() {
                save_noted(&s.list);
                drop(s);
                let rang = due.len();
                for d in due {
                    let _ = app.emit_to(WINDOW_LABEL, "reminder-due", d);
                }
                // More than a handful came due together (Lumo was off for a
                // while): the next ones wait for these to have been read.
                std::thread::sleep(Duration::from_millis(NOTE_MS * rang as u64));
                continue;
            }
            let version = s.version;
            // Asleep until the next is due, or the list changes; with none, until it changes.
            let wait =
                s.list.iter().map(|r| r.at).min().map(|at| Duration::from_millis(at.saturating_sub(now_ms()).max(1)));
            // Waking once an hour at most keeps a clock change (or a sleep) from
            // pushing a reminder late.
            let wait = wait.unwrap_or(Duration::from_secs(3600)).min(Duration::from_secs(3600));
            let _ = CHANGED.wait_timeout_while(s, wait, |s| s.version == version);
        }
    });
}

#[tauri::command]
pub fn reminders_add(at: u64, text: String) -> Result<Reminder, String> {
    add(at, &text)
}

#[tauri::command]
pub fn reminders_list() -> Vec<Reminder> {
    list()
}

#[tauri::command]
pub fn reminders_cancel(id: u32) -> bool {
    cancel(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: u64 = 3_600_000;

    #[test]
    fn a_reminder_needs_words_and_a_time_to_come() {
        assert_eq!(check(10 * H, "  call\nthe   bank ", 5 * H, 0).unwrap(), "call the bank");
        assert!(check(10 * H, "   ", 5 * H, 0).is_err());
        assert!(check(5 * H, "x", 5 * H, 0).is_err(), "now is too late");
        assert!(check(5 * H + MAX_AHEAD_MS + 1, "x", 5 * H, 0).is_err());
        assert!(check(10 * H, "x", 5 * H, MAX_REMINDERS).is_err());
        assert_eq!(clean_text(&"y".repeat(MAX_TEXT + 5)).len(), MAX_TEXT);
    }

    #[test]
    fn due_ones_ring_once_and_missed_ones_say_so() {
        let r = |id, at| Reminder { id, at, text: format!("r{id}") };
        let started = 1000 * H;
        let mut list = vec![r(1, 999 * H), r(2, 1001 * H), r(3, 1100 * H), r(4, started - STALE_MS - H)];
        let due = take_due(&mut list, 1001 * H, started);
        assert_eq!(due.iter().map(|d| (d.reminder.id, d.missed)).collect::<Vec<_>>(), [(1, true), (2, false)]);
        assert_eq!(list, [r(3, 1100 * H)], "the stale one is dropped, the later one stays");
        assert!(take_due(&mut list, 1050 * H, started).is_empty());
    }

    #[test]
    fn a_pile_of_missed_ones_rings_a_few_at_a_time() {
        let r = |id, at| Reminder { id, at, text: format!("r{id}") };
        let started = 1000 * H;
        let mut list: Vec<Reminder> = (1..=7).map(|id| r(id, (990 + u64::from(id)) * H)).collect();
        let first = take_due(&mut list, started, started);
        assert_eq!(first.iter().map(|d| d.reminder.id).collect::<Vec<_>>(), [1, 2, 3, 4], "the oldest first");
        assert_eq!(list.len(), 3, "the rest wait their turn rather than being dropped");
        let then = take_due(&mut list, started, started);
        assert_eq!(then.iter().map(|d| d.reminder.id).collect::<Vec<_>>(), [5, 6, 7]);
        assert!(list.is_empty());
    }
}
