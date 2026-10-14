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

fn save(list: &[Reminder]) {
    let path = file();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string(list) {
        let _ = std::fs::write(path, text);
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

/// The reminders due by `now`, taken off `list`; `started` marks the ones
/// missed while Lumo was off (due before it started), and the ones missed by
/// more than STALE_MS are dropped.
pub fn take_due(list: &mut Vec<Reminder>, now: u64, started: u64) -> Vec<Due> {
    let (due, rest): (Vec<Reminder>, Vec<Reminder>) = list.drain(..).partition(|r| r.at <= now);
    *list = rest;
    due.into_iter()
        .filter(|r| now.saturating_sub(r.at) <= STALE_MS)
        .map(|r| Due { missed: r.at < started, reminder: r })
        .collect()
}

pub fn add(at: u64, text: &str) -> Result<Reminder, String> {
    let mut s = STORE.lock().unwrap();
    load(&mut s);
    let text = check(at, text, now_ms(), s.list.len())?;
    let id = s.list.iter().map(|r| r.id).max().unwrap_or(0) + 1;
    let r = Reminder { id, at, text };
    s.list.push(r.clone());
    s.list.sort_by_key(|r| r.at);
    save(&s.list);
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
        save(&s.list);
        s.version += 1;
        CHANGED.notify_all();
    }
    gone
}

/// The thread that rings them.
pub fn start(app: AppHandle) {
    let started = now_ms();
    std::thread::spawn(move || loop {
        // The island listens once its page has loaded: a reminder missed while
        // Lumo was off waits for it rather than ringing to no one.
        if now_ms() < started + STARTUP_MS {
            std::thread::sleep(Duration::from_millis(started + STARTUP_MS - now_ms()));
        }
        let mut s = STORE.lock().unwrap();
        load(&mut s);
        let due = take_due(&mut s.list, now_ms(), started);
        if !due.is_empty() {
            save(&s.list);
            drop(s);
            for d in due {
                let _ = app.emit_to(WINDOW_LABEL, "reminder-due", d);
            }
            continue;
        }
        let version = s.version;
        // Asleep until the next is due, or the list changes; with none, until it changes.
        let wait = s.list.iter().map(|r| r.at).min().map(|at| Duration::from_millis(at.saturating_sub(now_ms()).max(1)));
        // Waking once an hour at most keeps a clock change (or a sleep) from
        // pushing a reminder late.
        let wait = wait.unwrap_or(Duration::from_secs(3600)).min(Duration::from_secs(3600));
        let _ = CHANGED.wait_timeout_while(s, wait, |s| s.version == version);
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
        let started = 100 * H;
        let mut list = vec![r(1, 99 * H), r(2, 101 * H), r(3, 200 * H), r(4, started - STALE_MS - H)];
        let due = take_due(&mut list, 101 * H, started);
        assert_eq!(due.iter().map(|d| (d.reminder.id, d.missed)).collect::<Vec<_>>(), [(1, true), (2, false)]);
        assert_eq!(list, [r(3, 200 * H)], "the stale one is dropped, the later one stays");
        assert!(take_due(&mut list, 150 * H, started).is_empty());
    }
}
