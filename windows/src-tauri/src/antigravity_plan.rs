// Antigravity CLI quotas — the same idea as codex_plan.rs.
//
// Lumo asks the Antigravity CLI itself: `agy -p /usage --output-format json`
// is agy's own /usage panel (antigravity.google/docs/cli/commands/usage)
// printed once, without a model turn. Lumo makes no network call of its own
// and reads no credential: agy answers with its own sign-in (kept in the
// system keyring), exactly as /usage does in a terminal, and nothing is
// installed or written (`--log-file` goes to the null device, so no log is
// left behind per ask). It runs only when the pill shows or is clicked, at
// most once at a time, for 20 s at most, and is skipped while Lumo is paused.
//
// The answer, as agy prints it:
//   { "status": "SUCCESS", "command": { "name": "usage", "data": { "groups": [
//     { "name": "Gemini Models", "buckets": [ { "id": "gemini-weekly",
//       "window": "weekly", "remaining_fraction": 0.31,
//       "reset_time": "2026-10-16T09:00:00Z" } ] }, … ] } } }
// Only the groups and their buckets reach the webview, with `reset_time` in
// epoch seconds.

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{self, AtomicBool};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::claude_code::kill_tree;
use crate::platform;

/// agy asks its backend before it answers: a little longer than Codex's 15 s.
const TIMEOUT: Duration = Duration::from_secs(20);
/// Everything we are willing to read back; the answer is a few hundred bytes.
const MAX_OUTPUT: u64 = 1024 * 1024;
/// More groups or buckets than this is not a quota answer.
const MAX_ITEMS: usize = 12;

/// Windows' null device: agy writes its log nowhere.
const NULL_DEVICE: &str = "NUL";

static BUSY: AtomicBool = AtomicBool::new(false);

struct NotBusy;
impl Drop for NotBusy {
    fn drop(&mut self) {
        BUSY.store(false, atomic::Ordering::Release);
    }
}

/// The fixed command line: nothing in it comes from outside.
fn args() -> [&'static str; 6] {
    ["-p", "/usage", "--output-format", "json", "--log-file", NULL_DEVICE]
}

/// agy's quota groups, or `None` when agy is not installed, not signed in,
/// slow, already being asked, or Lumo is paused. Blocking: call it off the
/// main thread.
pub fn read() -> Option<Value> {
    if crate::integrations::PAUSED.load(atomic::Ordering::Relaxed) {
        return None;
    }
    if BUSY.swap(true, atomic::Ordering::AcqRel) {
        return None;
    }
    let _busy = NotBusy;

    let exe = platform::agy_candidates().into_iter().next()?;
    let mut cmd = Command::new(&exe);
    cmd.args(args()).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    platform::no_console(&mut cmd);
    let mut child = cmd.spawn().ok()?;

    // Both streams are read, so neither can fill up and stall agy; the
    // answer is looked for on stdout first.
    let out = Output::read(child.stdout.take(), MAX_OUTPUT);
    let err = Output::read(child.stderr.take(), MAX_OUTPUT);

    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < TIMEOUT => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                kill_tree(&mut child);
                return None;
            }
        }
    }
    let out = out.after_exit();
    let err = err.after_exit();
    quotas(&String::from_utf8_lossy(&out)).or_else(|| quotas(&String::from_utf8_lossy(&err)))
}

/// How long the output is still read once agy has ended: a program it
/// started that still holds the output open must not hold Lumo too.
const AFTER_EXIT: Duration = Duration::from_secs(2);

/// One output of a program of agy's, read on a thread of its own to its end
/// (what is past `cap` is read and dropped, so the program never stalls).
pub(crate) struct Output {
    bytes: Arc<Mutex<Vec<u8>>>,
    done: mpsc::Receiver<()>,
}

impl Output {
    pub(crate) fn read(stream: Option<impl Read + Send + 'static>, cap: u64) -> Output {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let (tx, done) = mpsc::channel();
        let kept = bytes.clone();
        std::thread::spawn(move || {
            if let Some(mut stream) = stream {
                let mut buf = [0u8; 8192];
                while let Ok(n) = stream.read(&mut buf) {
                    if n == 0 {
                        break;
                    }
                    let mut all = kept.lock().unwrap_or_else(|e| e.into_inner());
                    let room = (cap as usize).saturating_sub(all.len());
                    all.extend_from_slice(&buf[..n.min(room)]);
                }
            }
            let _ = tx.send(());
        });
        Output { bytes, done }
    }

    /// What was read, the program having ended: its end waited for
    /// AFTER_EXIT at most, then what came until then.
    pub(crate) fn after_exit(self) -> Vec<u8> {
        let _ = self.done.recv_timeout(AFTER_EXIT);
        std::mem::take(&mut *self.bytes.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// `after_exit`, as text: bytes that aren't UTF-8 (a console's code
    /// page) become �, the rest stays readable.
    pub(crate) fn text_after_exit(self) -> String {
        String::from_utf8_lossy(&self.after_exit()).into_owned()
    }
}

/// The groups of a `/usage` answer found in `text`: the whole text as one
/// JSON value, or any line of it (agy may print other lines around it).
pub fn quotas(text: &str) -> Option<Value> {
    let whole = std::iter::once(text.trim());
    whole
        .chain(text.lines().map(str::trim))
        .filter(|s| s.starts_with('{'))
        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
        .find_map(|v| groups_of(&v))
}

/// The answer's groups in the webview's shape, or `None` when it holds no
/// bucket with a figure (a failed run, a sign-in error).
fn groups_of(answer: &Value) -> Option<Value> {
    if answer.get("status").and_then(Value::as_str).is_some_and(|s| !s.eq_ignore_ascii_case("success")) {
        return None;
    }
    let groups = answer
        .pointer("/command/data/groups")
        .or_else(|| answer.pointer("/data/groups"))
        .or_else(|| answer.get("groups"))?
        .as_array()?;
    let kept: Vec<Value> = groups
        .iter()
        .take(MAX_ITEMS)
        .filter_map(|g| {
            let buckets: Vec<Value> = g.get("buckets")?.as_array()?.iter().take(MAX_ITEMS).filter_map(bucket).collect();
            if buckets.is_empty() {
                return None;
            }
            Some(json!({ "name": short(g.get("name").and_then(Value::as_str).unwrap_or("")), "buckets": buckets }))
        })
        .collect();
    (!kept.is_empty()).then(|| json!({ "groups": kept }))
}

/// One bucket: how much is left (0–1) and when it resets (epoch seconds).
fn bucket(b: &Value) -> Option<Value> {
    let left = b.get("remaining_fraction").and_then(Value::as_f64).filter(|f| f.is_finite())?.clamp(0.0, 1.0);
    let resets = match b.get("reset_time") {
        Some(Value::String(s)) => crate::chat_usage::rfc3339_ms(s)? as f64 / 1000.0,
        Some(Value::Number(n)) => {
            let n = n.as_f64()?;
            if n > 1e12 { n / 1000.0 } else { n }
        }
        _ => return None,
    };
    if resets <= 0.0 {
        return None;
    }
    Some(json!({
        "id": short(b.get("id").and_then(Value::as_str).unwrap_or("")),
        "window": short(b.get("window").and_then(Value::as_str).unwrap_or("")),
        "remainingFraction": left,
        "resetsAt": resets.round(),
    }))
}

/// A label from agy, kept short and printable.
fn short(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).take(40).collect::<String>().trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_is_read_whole_capped_and_never_waited_for_past_its_end() {
        let out = Output::read(Some(std::io::Cursor::new(b"abcdef".to_vec())), 4);
        assert_eq!(out.after_exit(), b"abcd");
        // Not UTF-8 (a console's code page): still text.
        let out = Output::read(Some(std::io::Cursor::new(b"gpt-5 \xe8 ok".to_vec())), 64);
        assert_eq!(out.text_after_exit(), "gpt-5 \u{fffd} ok");
        // A stream nobody closes: given up on after AFTER_EXIT.
        struct Never;
        impl Read for Never {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                std::thread::sleep(Duration::from_secs(3600));
                Ok(0)
            }
        }
        let began = Instant::now();
        assert!(Output::read(Some(Never), 64).after_exit().is_empty());
        assert!(began.elapsed() < AFTER_EXIT + Duration::from_secs(2));
    }

    const ANSWER: &str = r#"{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[
        {"name":"Gemini Models","description":["gemini-3.5-flash"],"buckets":[
            {"id":"gemini-5h","name":"5 Hour Limit Remaining","window":"5h","remaining_fraction":0.9,"reset_time":"2026-10-10T18:00:00Z"},
            {"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.31,"reset_time":"2026-10-14T21:00:00+00:00"}]},
        {"name":"Claude and GPT models","buckets":[
            {"id":"3p-weekly","window":"weekly","remaining_fraction":1,"reset_time":"2026-10-14T21:00:00Z"}]}]}},
        "num_turns":0}"#;

    #[test]
    fn the_answer_becomes_groups_of_buckets() {
        let q = quotas(ANSWER).unwrap();
        let groups = q["groups"].as_array().unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["name"], "Gemini Models");
        assert_eq!(groups[0]["buckets"][0]["window"], "5h");
        assert_eq!(groups[0]["buckets"][0]["remainingFraction"], json!(0.9));
        assert_eq!(groups[0]["buckets"][0]["resetsAt"], json!(1_791_655_200.0));
        assert_eq!(groups[0]["buckets"][1]["remainingFraction"], json!(0.31));
        assert_eq!(groups[1]["buckets"][0]["remainingFraction"], json!(1.0));
        // Nothing but the figures goes on: no descriptions, no bucket names.
        assert!(groups[0].get("description").is_none());
        assert!(groups[0]["buckets"][0].get("name").is_none());
    }

    #[test]
    fn the_answer_is_found_among_other_lines() {
        let text = format!("Checking for updates…\n{}\n", ANSWER.replace('\n', " "));
        assert!(quotas(&text).is_some());
    }

    #[test]
    fn a_failure_or_an_answer_without_figures_is_no_answer() {
        assert!(quotas("").is_none());
        assert!(quotas("Not signed in. Run agy to sign in.").is_none());
        assert!(quotas(r#"{"status":"ERROR","command":{"data":{"groups":[{"name":"G","buckets":[{"remaining_fraction":0.5,"reset_time":"2026-10-10T18:00:00Z"}]}]}}}"#).is_none());
        // A bucket without its reset time is left out, not made up.
        assert!(quotas(r#"{"command":{"data":{"groups":[{"name":"G","buckets":[{"remaining_fraction":0.5}]}]}}}"#).is_none());
    }

    #[test]
    fn odd_fractions_are_clamped() {
        let q = quotas(r#"{"groups":[{"name":"G","buckets":[{"remaining_fraction":1.7,"reset_time":1900000000}]}]}"#).unwrap();
        assert_eq!(q["groups"][0]["buckets"][0]["remainingFraction"], json!(1.0));
        assert_eq!(q["groups"][0]["buckets"][0]["resetsAt"], json!(1_900_000_000.0));
    }

    #[test]
    fn the_command_line_is_fixed() {
        let a = args();
        assert_eq!(&a[..4], &["-p", "/usage", "--output-format", "json"]);
        assert_eq!(a[4], "--log-file");
    }
}
