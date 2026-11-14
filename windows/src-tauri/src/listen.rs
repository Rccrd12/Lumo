// Listening: the chat waits for something without holding a turn open. Claude
// calls Lumo's listen tool, which becomes the line
// `[[listen owner/repo#12 ready: merge it]]` (island_tools.rs), or writes that
// line in an answer itself (chat.rs listen_tool_note, src/core/listen.ts takes
// it out); Lumo keeps that watch here, asks GitHub about the pull request now
// and then, and once what it waited for happens (or can no longer happen)
// tells the island (`listen-fired`). With a task, the chat that asked sends Claude a message
// saying what happened and what it meant to do then; without one, the island
// only says it.
//
// A watch listens once (it ends when it fires) or every time: a watch on the
// checks that listens every time fires once for each new commit pushed, and
// ends only with the pull request. A watch can be paused from the island's
// Listening panel; what fired is kept in a short history for that panel.
//
// Besides GitHub's pull requests, a watch can listen on this PC: a file or a
// folder, a program or a port, a web page, Windows itself, one of the user's
// tools (listen_local.rs looks at them, in a loop of its own, a few seconds
// apart). Others are heard as they happen (listen_events.rs): an email, a
// service's news, an agent's hook, a call to a webhook, an event on the
// calendar coming up. A watch that listens every time and fires too often in
// an hour is paused, saying so.
//
// GitHub is asked with the token the user gave the GitHub pill, else through
// their own `gh` (which signs in by itself: Lumo never sees its token), else
// without signing in (public repositories only). Nothing at all is asked while
// no watch is on, or while Lumo is paused. The watches are kept in a file so
// a restart goes on listening.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;

use crate::i18n::{t, tf};
use crate::island::WINDOW_LABEL;
use crate::listen_local::{self, Listing};
use crate::{log, platform, secrets};

/// What a watch can wait for on a pull request (listen_local.rs: on this PC).
pub const UNTILS: &[&str] = &["checks", "green", "approved", "ready", "merged", "closed"];
/// Once: the watch ends when it fires. Every: it fires for each new commit.
pub const MODES: &[&str] = &["once", "every"];
/// What can listen every time: what happens again with each push.
pub const EVERY_UNTILS: &[&str] = &["checks", "green"];
/// Where a watch listens: GitHub's pull requests, a file or a folder, a
/// program or a port, a web page, the inbox, a service (or the calendar),
/// Windows, an agent, a webhook, one of the user's tools.
pub const SOURCES: &[&str] = &["github.pr", "fs", "process", "web", "email", "service", "windows", "agent", "webhook", "tool"];
/// The sources the loop on this PC looks at; the others are heard (listen_events.rs).
const POLLED: &[&str] = &["fs", "process", "web", "windows", "tool"];
pub const GITHUB: &str = "github.pr";
/// What fired, newest last, at most this many.
const MAX_HISTORY: usize = 50;
/// At most this many watches at once; the oldest goes for a new one.
const MAX_WATCHES: usize = 20;
/// A watch nobody needed for this long stops by itself, saying so.
const MAX_AGE_MS: u64 = 7 * 24 * 3_600_000;
/// Right after a push GitHub lists no checks yet: none counts as none only after
/// this, and only when no Actions run of the commit is still queued or running
/// (actions_of): a run GitHub has not given its jobs yet lists no checks either.
const NO_CHECKS_GRACE_MS: u64 = 3 * 60_000;
/// GitHub answering "not found" (or no access) this many times running ends the watch.
const MAX_MISSES: u32 = 3;
/// How often GitHub is asked, signed in or not (60 calls an hour without).
const EVERY_SIGNED_IN: Duration = Duration::from_secs(30);
const EVERY_ANONYMOUS: Duration = Duration::from_secs(120);
/// Without signing in GitHub answers 60 times an hour, and a look at the
/// checks asks up to 4 times (the pull request, its check runs, its statuses,
/// its Actions runs when no check is listed): each watch adds this much, so it
/// stays under that.
const ANONYMOUS_PER_WATCH: Duration = Duration::from_secs(300);
/// How many times one look at a pull request's checks asks GitHub, at most.
#[cfg(test)]
const ASKS_PER_LOOK: usize = 4;
const TASK_CHARS: usize = 2000;
/// How often the files, programs and ports are looked at.
const LOCAL_EVERY: Duration = Duration::from_secs(5);
/// How often a web page is asked for.
const WEB_EVERY_MS: u64 = 60_000;
/// How often Windows' notifications are read.
const NOTIFICATIONS_EVERY_MS: u64 = 15_000;
/// Back at the computer: input in the last this many ms.
const BACK_MS: u64 = 10_000;
/// A watch listening every time that fires this often in an hour is paused.
const MAX_FIRES_PER_HOUR: usize = 12;
const HOUR_MS: u64 = 3_600_000;
/// A page is down only once it failed to answer this many looks running (a
/// minute apart): one slow answer or a hiccup on the way is not an outage.
const WEB_DOWN_AFTER: u32 = 3;
/// Watch::warning.
const TOKEN: &str = "token";
const TOO_OFTEN: &str = "too_often";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Watch {
    pub id: u64,
    /// "owner/repo" (GitHub only; empty for the other sources).
    pub repo: String,
    pub number: u64,
    /// One of UNTILS, or of the source's (listen_local.rs).
    pub until: String,
    /// What Claude meant to do once it happens; empty: only tell the user.
    pub task: String,
    /// The chat that asked (src/core/chats.ts id).
    pub chat_id: String,
    /// Unix ms.
    pub started_at: u64,
    /// Where it listens (SOURCES); older files have none: GitHub's pull requests.
    #[serde(default = "pull_requests")]
    pub source: String,
    /// One of MODES; older files have none: once.
    #[serde(default = "once")]
    pub mode: String,
    /// Paused from the Listening panel: GitHub is not asked about it.
    #[serde(default)]
    pub paused: bool,
    /// How many times it fired (listening every time).
    #[serde(default)]
    pub fired: u32,
    /// The commit it last fired on (listening every time): it waits for the next one.
    #[serde(default)]
    pub last_sha: String,
    /// What a watch on this PC names: a path, a program, a port, a link.
    #[serde(default)]
    pub target: String,
    /// The words a page (or a tool) is waited to show (contains).
    #[serde(default)]
    pub text: String,
    /// The minutes before an event, the battery's percent, the minutes away,
    /// the minutes between two runs of a tool (listen_local::amount_of); 0 for the rest.
    #[serde(default)]
    pub amount: u32,
    /// Why the Listening panel warns about it: "" none, "token" (GitHub turns
    /// the GitHub pill's token down: the watch waits, it is not ended), or
    /// "too_often" (paused for firing MAX_FIRES_PER_HOUR times in an hour,
    /// until it is resumed).
    #[serde(default)]
    pub warning: String,
}

fn pull_requests() -> String {
    SOURCES[0].to_string()
}

fn once() -> String {
    MODES[0].to_string()
}

impl Watch {
    /// "owner/repo#12", a folder's name, a program, ":3000", a page's address.
    pub fn label(&self) -> String {
        if self.source == GITHUB {
            format!("{}#{}", self.repo, self.number)
        } else {
            listen_local::label(&self.source, &self.until, &self.target)
        }
    }

    pub fn github(&self) -> bool {
        self.source == GITHUB
    }

    /// Looked at by the loop on this PC (else heard, or GitHub's).
    fn polled(&self) -> bool {
        POLLED.contains(&self.source.as_str())
    }
}

/// What the island is told when a watch ends.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Fired {
    pub watch: Watch,
    /// What it waited for happened; false: it can no longer (checks failed, closed…).
    pub met: bool,
    /// What happened, in the user's language.
    pub summary: String,
    /// The watch is over (false: it listens every time and goes on).
    pub ended: bool,
}

/// What fired, as the Listening panel's history shows it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Past {
    pub watch: Watch,
    pub met: bool,
    pub summary: String,
    /// Unix ms.
    pub at: u64,
}

impl Store {
    /// What was kept per watch for the watches that are gone (replaced, the
    /// oldest let go, cancelled): ids are never used again.
    fn forget_gone(&mut self) {
        let ids: std::collections::HashSet<u64> = self.watches.iter().map(|w| w.id).collect();
        self.misses.retain(|id, _| ids.contains(id));
        self.seen.retain(|id, _| ids.contains(id));
        self.fires.retain(|id, _| ids.contains(id));
        self.heads.retain(|id, _| ids.contains(id));
    }
}

#[derive(Default)]
struct Store {
    watches: Vec<Watch>,
    next_id: u64,
    /// "not found" answers running, per watch.
    misses: HashMap<u64, u32>,
    history: Vec<Past>,
    loaded: bool,
    /// What the last look saw, per watch on this PC (not kept across a restart).
    seen: HashMap<u64, Seen>,
    /// When each watch fired in the last hour.
    fires: HashMap<u64, Vec<u64>>,
    /// The pull request's head commit at the last look, and since when (Unix ms), per watch.
    heads: HashMap<u64, (String, u64)>,
}

#[derive(Default)]
struct Seen {
    /// A folder's files, or the USB drives.
    files: Option<Listing>,
    /// Whether the state it waits for held at the last look.
    on: Option<bool>,
    /// When the page was last asked for, the notifications read, the tool run (Unix ms).
    asked: u64,
    /// The newest notification seen (Unix seconds).
    mark: i64,
    /// A web page's looks running that got no answer (or an error), while the
    /// PC itself was online.
    fails: u32,
    /// The words the page showed at the last look (a watch on what it shows):
    /// what changed is told from them. Only in memory: after a restart the
    /// first change is told without them.
    text: Option<String>,
}

static STORE: LazyLock<Mutex<Store>> = LazyLock::new(|| Mutex::new(Store::default()));
static WAKE: LazyLock<Notify> = LazyLock::new(Notify::new);
/// The loop on this PC's own.
static WAKE_LOCAL: LazyLock<Notify> = LazyLock::new(Notify::new);

/// Both loops look again (a watch was added or resumed).
fn wake() {
    WAKE.notify_one();
    WAKE_LOCAL.notify_one();
}

fn file() -> PathBuf {
    platform::local_dir().join("listening.json")
}

fn history_file() -> PathBuf {
    platform::local_dir().join("listening-history.json")
}

/// The next watch id, kept so an id is never given twice, even after its
/// watch went (the chat's lines of what was heard name their watch by id).
fn next_id_file() -> PathBuf {
    platform::local_dir().join("listening-next-id.json")
}

/// The first id no watch had: past the saved watches, the past ones and the
/// kept high-water mark.
fn first_free_id(saved: &[Watch], history: &[Past], kept: u64) -> u64 {
    let most = saved.iter().map(|w| w.id).chain(history.iter().map(|p| p.watch.id)).max().unwrap_or(0);
    (most + 1).max(kept)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn with_store<R>(f: impl FnOnce(&mut Store) -> R) -> R {
    let mut s = STORE.lock().unwrap();
    if !s.loaded {
        s.loaded = true;
        let saved: Vec<Watch> = std::fs::read_to_string(file())
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        s.history = std::fs::read_to_string(history_file())
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        let mark: u64 = std::fs::read_to_string(next_id_file()).ok().and_then(|text| text.trim().parse().ok()).unwrap_or(0);
        s.next_id = first_free_id(&saved, &s.history, mark);
        let (keep, gone): (Vec<Watch>, Vec<Watch>) = saved.into_iter().partition(kept);
        s.watches = keep;
        // A page watched before only public https pages could be (plain http,
        // this PC, the local network) is no longer watched: it goes to the
        // past ones, saying why, rather than vanishing.
        let pages: Vec<Watch> = gone.into_iter().filter(|w| w.source == "web").collect();
        if !pages.is_empty() {
            for w in &pages {
                remember(&mut s, w, false, &t("Not a public https page, so Lumo no longer watches it."));
            }
            save(&s.watches);
        }
    }
    f(&mut s)
}

fn write<T: Serialize + ?Sized>(path: PathBuf, value: &T) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string(value) {
        let _ = std::fs::write(path, text);
    }
}

fn save(watches: &[Watch]) {
    write(file(), watches);
}

/// Whether `mode` is one, and allowed for `until`: on this PC everything can
/// listen every time, on a pull request only what each push brings again.
pub fn mode_ok(source: &str, until: &str, mode: &str) -> bool {
    mode == "once" || (mode == "every" && (source != GITHUB || EVERY_UNTILS.contains(&until)))
}

/// A watch read back from the file that can still listen.
fn kept(w: &Watch) -> bool {
    if w.github() {
        return valid(&w.repo, w.number, &w.until);
    }
    listen_local::target(&w.source, &w.until, &w.target, &w.text, &platform::home_dir()).is_ok_and(|t| t == w.target)
}

/// A repository and pull request we are willing to put in a GitHub URL.
pub fn valid(repo: &str, number: u64, until: &str) -> bool {
    let name_ok = |s: &str| !s.is_empty() && s.len() <= 100 && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    let repo_ok = matches!(repo.split_once('/'), Some((owner, name)) if name_ok(owner) && name_ok(name));
    repo_ok && (1..=1_000_000_000).contains(&number) && UNTILS.contains(&until)
}

/// Adds a watch (the same pull request and event again replaces the old one).
/// `replace`: the watch this one is an edit of (push).
pub fn add(repo: &str, number: u64, until: &str, mode: &str, task: &str, chat_id: &str, replace: Option<u64>) -> Result<Watch, String> {
    let repo = repo.trim();
    let until = until.trim().to_ascii_lowercase();
    if !valid(repo, number, &until) {
        return Err(format!("not a pull request to listen to: {repo}#{number} {until}"));
    }
    let mode = match mode.trim().to_ascii_lowercase() {
        m if m.is_empty() => once(),
        m => m,
    };
    if !mode_ok(GITHUB, &until, &mode) {
        return Err(format!("only {} can listen every time", EVERY_UNTILS.join(" or ")));
    }
    let watch = Watch {
        id: 0,
        repo: repo.to_string(),
        number,
        until,
        task: task.to_string(),
        chat_id: chat_id.to_string(),
        started_at: 0,
        source: pull_requests(),
        mode,
        paused: false,
        fired: 0,
        last_sha: String::new(),
        target: String::new(),
        text: String::new(),
        amount: 0,
        warning: String::new(),
    };
    Ok(push(watch, replace))
}

/// Adds a watch on this PC: a file or a folder (`fs`), a program or a port
/// (`process`), a web page (`web`). The same target and event again replaces the old one.
/// `replace`: the watch this one is an edit of (push).
#[allow(clippy::too_many_arguments)]
pub fn add_local(source: &str, target: &str, until: &str, mode: &str, text: &str, amount: u32, task: &str, chat_id: &str, replace: Option<u64>) -> Result<Watch, String> {
    let source = source.trim().to_ascii_lowercase();
    let until = until.trim().to_ascii_lowercase();
    let text: String = text.trim().chars().take(200).collect();
    let target = listen_local::target(&source, &until, target, &text, &platform::home_dir())?;
    let mode = match mode.trim().to_ascii_lowercase() {
        m if m.is_empty() => once(),
        m => m,
    };
    if !mode_ok(&source, &until, &mode) {
        return Err("mode must be once or every".into());
    }
    let watch = Watch {
        id: 0,
        repo: String::new(),
        number: 0,
        // `soon`: the words an event's title has, when it names some.
        text: if matches!(until.as_str(), "contains" | "soon" | "gone") { text } else { String::new() },
        amount: listen_local::amount_of(&source, &until, amount),
        until,
        task: task.to_string(),
        chat_id: chat_id.to_string(),
        started_at: 0,
        source,
        mode,
        paused: false,
        fired: 0,
        last_sha: String::new(),
        target,
        warning: String::new(),
    };
    Ok(push(watch, replace))
}

/// Whether two watches listen to the same thing for the same event.
fn same(a: &Watch, b: &Watch) -> bool {
    a.source == b.source
        && a.until == b.until
        && if a.github() { a.repo.eq_ignore_ascii_case(&b.repo) && a.number == b.number } else { a.target.eq_ignore_ascii_case(&b.target) }
}

/// Whether an edit still listens to the same thing for the same event: what
/// it saw before still stands (the commit it fired on, the last look).
fn same_listening(a: &Watch, b: &Watch) -> bool {
    a.source == b.source && a.until == b.until && a.target == b.target && a.repo == b.repo && a.number == b.number
}

/// Keeps a new watch, with its id and start; the same one before goes.
///
/// `replace`: the watch it is an edit of (the Listening panel's Edit). The
/// edit takes its place and its id, so a webhook keeps its address and the
/// island keeps what it knows of it, and stays paused if it was. What was seen
/// is kept only when it still listens to the same thing for the same event.
/// It takes no room of its own: no other watch goes for it.
fn push(mut watch: Watch, replace: Option<u64>) -> Watch {
    watch.task = watch.task.trim().chars().take(TASK_CHARS).collect();
    watch.chat_id = watch.chat_id.chars().take(64).collect();
    watch.started_at = now_ms();
    let watch = with_store(|s| {
        let (watch, made_room) = place(s, watch, replace);
        // The oldest that went for it is in the history, saying so, rather than vanishing.
        let count = MAX_WATCHES.to_string();
        for gone in &made_room {
            let summary = tf("Stopped listening to {what} to make room: at most {count} at once", &[("what", &gone.label()), ("count", &count)]);
            remember(s, gone, false, &summary);
        }
        save(&s.watches);
        write(next_id_file(), &s.next_id);
        watch
    });
    wake();
    watch
}

/// push's work on the store, the files aside: the watch as kept, and the
/// oldest watches that went to make room for it.
fn place(s: &mut Store, mut watch: Watch, replace: Option<u64>) -> (Watch, Vec<Watch>) {
    let mut made_room = Vec::new();
    if let Some(i) = replace.and_then(|id| s.watches.iter().position(|w| w.id == id)) {
        let before = s.watches[i].clone();
        watch.id = before.id;
        // Always a later start than the watch it edits: a look still going on
        // with the copy from before the edit is told apart by it (current).
        watch.started_at = watch.started_at.max(before.started_at + 1);
        watch.paused = before.paused;
        watch.fired = before.fired;
        // A pause for firing too often still says why while it lasts.
        watch.warning = if before.paused && before.warning == TOO_OFTEN { before.warning.clone() } else { String::new() };
        if same_listening(&before, &watch) {
            watch.last_sha = before.last_sha.clone();
            // Other words to wait for, or another threshold: whether the state
            // held was about the old ones. Unknown again, as for a new watch,
            // so listening every time doesn't fire for a change that never
            // happened. What was told (a calendar's events) stays.
            if before.text != watch.text || before.amount != watch.amount {
                if let Some(seen) = s.seen.get_mut(&watch.id) {
                    seen.on = None;
                }
            }
        } else {
            s.misses.remove(&watch.id);
            s.seen.remove(&watch.id);
            s.fires.remove(&watch.id);
            s.heads.remove(&watch.id);
        }
        // In its place: the watch is never missing from the list, so the
        // webhook's secret (listen_events::prune) is never let go meanwhile.
        s.watches[i] = watch.clone();
        s.watches.retain(|w| w.id == watch.id || !same(w, &watch));
    } else {
        s.watches.retain(|w| !same(w, &watch));
        while s.watches.len() >= MAX_WATCHES {
            made_room.push(s.watches.remove(0));
        }
        watch.id = s.next_id;
        s.next_id += 1;
        s.watches.push(watch.clone());
    }
    s.forget_gone();
    (watch, made_room)
}

/// Stops listening to a pull request (`until` None: to every event on it).
pub fn cancel(repo: &str, number: u64, until: Option<&str>) -> usize {
    with_store(|s| {
        let before = s.watches.len();
        s.watches
            .retain(|w| !(w.github() && w.repo.eq_ignore_ascii_case(repo.trim()) && w.number == number && until.is_none_or(|u| w.until == u)));
        s.forget_gone();
        save(&s.watches);
        before - s.watches.len()
    })
}

/// Stops listening to a target on this PC, for every event.
pub fn cancel_local(source: &str, target: &str) -> usize {
    let source = source.trim().to_ascii_lowercase();
    let target = target.trim().trim_end_matches(['\\', '/']).to_lowercase();
    with_store(|s| {
        let before = s.watches.len();
        s.watches.retain(|w| {
            let named = w.target.trim_end_matches(['\\', '/']).to_lowercase();
            !(w.source == source
                && (named == target || listen_local::program_name(&target) == named || listen_local::canonical(&source, &target) == named))
        });
        s.forget_gone();
        save(&s.watches);
        before - s.watches.len()
    })
}

/// Stops one watch, by its id.
pub fn stop(id: u64) -> bool {
    with_store(|s| {
        let before = s.watches.len();
        s.watches.retain(|w| w.id != id);
        s.misses.remove(&id);
        s.seen.remove(&id);
        s.fires.remove(&id);
        s.heads.remove(&id);
        save(&s.watches);
        before != s.watches.len()
    })
}

/// Pauses or resumes one watch (`id` None: every one). How many changed.
/// Resuming one paused for firing too often takes that warning away.
pub fn pause(id: Option<u64>, paused: bool) -> usize {
    let n = with_store(|s| {
        let mut n = 0;
        for w in s.watches.iter_mut().filter(|w| id.is_none_or(|id| w.id == id)) {
            if !paused && w.warning == TOO_OFTEN {
                w.warning.clear();
            }
            if w.paused != paused {
                w.paused = paused;
                n += 1;
            }
        }
        save(&s.watches);
        n
    });
    if !paused {
        wake();
    }
    n
}

pub fn list() -> Vec<Watch> {
    with_store(|s| s.watches.clone())
}

pub fn history() -> Vec<Past> {
    with_store(|s| s.history.clone())
}

pub fn clear_history() {
    with_store(|s| {
        s.history.clear();
        write(history_file(), &s.history);
    })
}

fn remember(s: &mut Store, watch: &Watch, met: bool, summary: &str) {
    s.history.push(Past { watch: watch.clone(), met, summary: summary.to_string(), at: now_ms() });
    let over = s.history.len().saturating_sub(MAX_HISTORY);
    s.history.drain(..over);
    write(history_file(), &s.history);
}

/// Where the watch a look worked from (`w`, a copy from list()) is kept, if it
/// still is that watch: None once it was stopped, or edited while the look
/// went on. An edit keeps the id (place) but starts later, so what a look at
/// the watch before the edit found (another pull request, another page) is
/// never taken for the edit's: it fires nothing and is not kept as seen.
fn current(s: &Store, w: &Watch) -> Option<usize> {
    s.watches.iter().position(|k| k.id == w.id && k.started_at == w.started_at)
}

/// What the last look at `w` saw, made when there is none; None when `w` is
/// no longer the watch kept (current).
fn seen_mut<'a>(s: &'a mut Store, w: &Watch) -> Option<&'a mut Seen> {
    current(s, w)?;
    Some(s.seen.entry(w.id).or_default())
}

/// Keeps what a watch on what something says last said (`print`), when there
/// was nothing yet: the next change is told against it.
fn first_print(w: &Watch, print: String) {
    with_store(|s| {
        if let Some(i) = current(s, w) {
            s.watches[i].last_sha = print;
            save(&s.watches);
        }
    });
}

/// The watch a look worked from (`w`) fired, if it is still that one (current).
fn take(w: &Watch, met: bool, summary: &str, again_on: Option<&str>) -> Option<(Watch, bool, bool)> {
    with_store(|s| {
        let i = current(s, w)?;
        Some(taken(s, i, met, summary, again_on))
    })
}

/// The watch at `i` fired: taken out, or (listening every time, and it can
/// happen again) kept, waiting for the next time. The watch as it fired,
/// whether it ended, and whether it was paused for firing too often.
fn taken(s: &mut Store, i: usize, met: bool, summary: &str, again_on: Option<&str>) -> (Watch, bool, bool) {
    let now = now_ms();
    let id = s.watches[i].id;
    s.misses.remove(&id);
    let ended = s.watches[i].mode != "every" || again_on.is_none();
    let mut too_often = false;
    let watch = if ended {
        s.seen.remove(&id);
        s.fires.remove(&id);
        s.heads.remove(&id);
        s.watches.remove(i)
    } else {
        let fires = s.fires.entry(id).or_default();
        fires.retain(|at| now.saturating_sub(*at) < HOUR_MS);
        fires.push(now);
        too_often = fires.len() >= MAX_FIRES_PER_HOUR;
        let w = &mut s.watches[i];
        w.fired += 1;
        w.last_sha = again_on.unwrap_or("").to_string();
        if too_often {
            w.paused = true;
            w.warning = TOO_OFTEN.to_string();
            s.fires.remove(&id);
        }
        s.watches[i].clone()
    };
    remember(s, &watch, met, summary);
    if too_often {
        let count = MAX_FIRES_PER_HOUR.to_string();
        let paused = tf("Paused {what}: it happened {count} times in an hour", &[("what", &watch.label()), ("count", &count)]);
        remember(s, &watch, false, &paused);
    }
    save(&s.watches);
    (watch, ended, too_often)
}

// ── What GitHub says about a pull request ─────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub enum Checks {
    /// Nothing reported (yet).
    None,
    Pending,
    Passed,
    /// The names of the ones that failed.
    Failed(Vec<String>),
    /// Stopped before they said anything, and nothing else failed: the names
    /// of the ones cancelled. Not green, as a failure, but said as it is.
    Cancelled(Vec<String>),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Review {
    None,
    Approved,
    ChangesRequested,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PrState {
    pub open: bool,
    pub merged: bool,
    pub draft: bool,
    pub mergeable: Option<bool>,
    /// GitHub's mergeable_state: clean, blocked, dirty, behind, unstable, unknown…
    pub mergeable_state: String,
    pub head_sha: String,
    pub checks: Checks,
    pub review: Review,
}

impl PrState {
    /// The pull request itself (`GET /repos/{repo}/pulls/{n}`), checks and reviews not asked yet.
    pub fn from_pull(v: &Value) -> Option<Self> {
        let state = v.get("state")?.as_str()?;
        Some(PrState {
            open: state == "open",
            merged: v["merged"].as_bool().unwrap_or(false) || v["merged_at"].is_string(),
            draft: v["draft"].as_bool().unwrap_or(false),
            mergeable: v["mergeable"].as_bool(),
            mergeable_state: v["mergeable_state"].as_str().unwrap_or("unknown").to_string(),
            head_sha: v["head"]["sha"].as_str().unwrap_or("").to_string(),
            checks: Checks::None,
            review: Review::None,
        })
    }
}

/// The checks on a commit: its check runs (Actions and apps) and its commit statuses.
pub fn checks_of(runs: Option<&Value>, status: Option<&Value>) -> Checks {
    let mut pending = false;
    let mut failed = Vec::new();
    let mut cancelled = Vec::new();
    let mut any = false;
    for run in runs.and_then(|r| r["check_runs"].as_array()).into_iter().flatten() {
        any = true;
        let name = run["name"].as_str().unwrap_or("check").to_string();
        if run["status"].as_str() != Some("completed") {
            pending = true;
            continue;
        }
        match run["conclusion"].as_str() {
            Some("failure" | "timed_out" | "action_required" | "startup_failure") => failed.push(name),
            Some("cancelled" | "stale") => cancelled.push(name),
            _ => {}
        }
    }
    for st in status.and_then(|s| s["statuses"].as_array()).into_iter().flatten() {
        any = true;
        let name = st["context"].as_str().unwrap_or("status").to_string();
        match st["state"].as_str() {
            Some("pending") => pending = true,
            Some("failure" | "error") => failed.push(name),
            _ => {}
        }
    }
    if !failed.is_empty() {
        // A failure is final for the commit even while others still run.
        Checks::Failed(failed)
    } else if pending {
        Checks::Pending
    } else if !cancelled.is_empty() {
        Checks::Cancelled(cancelled)
    } else if any {
        Checks::Passed
    } else {
        Checks::None
    }
}

/// The commit's Actions runs (`GET /repos/{repo}/actions/runs?head_sha=…`),
/// asked when it lists no checks: a run still queued, waiting or running whose
/// jobs GitHub has not created yet lists no check, and must not read as none.
/// A run that ended failing before any job (a broken workflow file, say) is a
/// failure; one cancelled before its jobs (superseded by a newer push) is not,
/// beside a run that went through. Every run cancelled, nothing ran: that
/// passes nothing (a pull request whose CI never ran is not green).
pub fn actions_of(checks: Checks, actions: Option<&Value>) -> Checks {
    if checks != Checks::None {
        return checks;
    }
    let mut pending = false;
    let mut failed = Vec::new();
    let mut cancelled = Vec::new();
    let mut ran = false;
    let mut any = false;
    for run in actions.and_then(|a| a["workflow_runs"].as_array()).into_iter().flatten() {
        any = true;
        let name = run["name"].as_str().unwrap_or("workflow").to_string();
        if run["status"].as_str() != Some("completed") {
            pending = true;
            continue;
        }
        match run["conclusion"].as_str() {
            Some("failure" | "startup_failure" | "timed_out") => failed.push(name),
            // Waiting for someone to approve the run: it hasn't run yet.
            Some("action_required") => pending = true,
            // Stopped before it said anything: it passes nothing by itself.
            Some("cancelled" | "stale") => cancelled.push(name),
            _ => ran = true,
        }
    }
    if !failed.is_empty() {
        Checks::Failed(failed)
    } else if pending {
        Checks::Pending
    } else if !ran && !cancelled.is_empty() {
        Checks::Cancelled(cancelled)
    } else if any {
        Checks::Passed
    } else {
        Checks::None
    }
}

/// Each reviewer's last say (`GET /repos/{repo}/pulls/{n}/reviews`, oldest first).
pub fn review_of(reviews: Option<&Value>) -> Review {
    let mut last: HashMap<String, String> = HashMap::new();
    for r in reviews.and_then(Value::as_array).into_iter().flatten() {
        let who = r["user"]["login"].as_str().unwrap_or("").to_string();
        let state = r["state"].as_str().unwrap_or("");
        if matches!(state, "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED") {
            last.insert(who, state.to_string());
        }
    }
    if last.values().any(|s| s == "CHANGES_REQUESTED") {
        Review::ChangesRequested
    } else if last.values().any(|s| s == "APPROVED") {
        Review::Approved
    } else {
        Review::None
    }
}

/// How long the pull request has had this head commit, as far as Lumo saw:
/// a push starts the wait for the checks GitHub has not listed yet again.
fn head_age(heads: &mut HashMap<u64, (String, u64)>, id: u64, sha: &str, now: u64) -> u64 {
    let (seen, since) = heads.entry(id).or_insert_with(|| (sha.to_string(), now));
    if seen != sha {
        *seen = sha.to_string();
        *since = now;
    }
    now.saturating_sub(*since)
}

/// Whether the watch ends with this state of the pull request: (met, summary).
/// `age_ms`: how long its head commit has been seen (head_age), for the checks GitHub has not listed yet.
pub fn judge(w: &Watch, pr: &PrState, age_ms: u64) -> Option<(bool, String)> {
    let label = w.label();
    let pr_var = [("pr", label.as_str())];
    let listed = |names: &[String]| {
        let mut list = names.iter().take(4).cloned().collect::<Vec<_>>().join(", ");
        if names.len() > 4 {
            list.push_str(", …");
        }
        list
    };
    let failed_names = |names: &[String]| tf("Checks failed on {pr}: {checks}", &[("pr", &label), ("checks", &listed(names))]);
    let cancelled_names = |names: &[String]| tf("Checks were cancelled on {pr}: {checks}", &[("pr", &label), ("checks", &listed(names))]);
    if pr.merged {
        return Some((matches!(w.until.as_str(), "merged" | "closed"), tf("{pr} was merged", &pr_var)));
    }
    if !pr.open {
        return Some((w.until == "closed", tf("{pr} was closed without being merged", &pr_var)));
    }
    // Listening every time: the commit it fired on is done with.
    if w.mode == "every" && !w.last_sha.is_empty() && w.last_sha == pr.head_sha {
        return None;
    }
    let settled = |c: &Checks| match c {
        Checks::Passed => Some(true),
        Checks::None if age_ms >= NO_CHECKS_GRACE_MS => Some(true),
        Checks::Failed(_) | Checks::Cancelled(_) => Some(false),
        _ => None,
    };
    match w.until.as_str() {
        "checks" => match &pr.checks {
            Checks::Failed(names) => Some((true, failed_names(names))),
            Checks::Cancelled(names) => Some((true, cancelled_names(names))),
            c if settled(c) == Some(true) => Some((true, tf("Checks passed on {pr}", &pr_var))),
            _ => None,
        },
        "green" => match &pr.checks {
            Checks::Failed(names) => Some((false, failed_names(names))),
            Checks::Cancelled(names) => Some((false, cancelled_names(names))),
            c if settled(c) == Some(true) => Some((true, tf("Checks passed on {pr}", &pr_var))),
            _ => None,
        },
        "approved" => match pr.review {
            Review::Approved => Some((true, tf("{pr} was approved", &pr_var))),
            Review::ChangesRequested => Some((false, tf("Changes were requested on {pr}", &pr_var))),
            Review::None => None,
        },
        "ready" => {
            match &pr.checks {
                Checks::Failed(names) => return Some((false, failed_names(names))),
                Checks::Cancelled(names) => return Some((false, cancelled_names(names))),
                _ => {}
            }
            if pr.mergeable == Some(false) || pr.mergeable_state == "dirty" {
                return Some((false, tf("{pr} has merge conflicts", &pr_var)));
            }
            let checks_done = settled(&pr.checks) == Some(true);
            let can_merge = pr.mergeable == Some(true) && matches!(pr.mergeable_state.as_str(), "clean" | "has_hooks" | "unstable");
            (!pr.draft && checks_done && can_merge).then(|| (true, tf("{pr} is ready to merge", &pr_var)))
        }
        // Waiting for the merge or the close: nothing else ends it.
        _ => None,
    }
}

// ── Asking GitHub ─────────────────────────────────────────────────────────────

enum Answer {
    Found(Value),
    /// 404, or 401/403 for a repository it can't see.
    Missing,
    /// GitHub turns the token down (401): expired or revoked. That says
    /// nothing about the pull request, so it must not end the watch.
    Unauthorized,
    /// No connection, rate limit, `gh` not there…: ask again later.
    Unknown,
}

/// What an answer from GitHub's REST API is, from its status alone.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Found,
    Missing,
    Unauthorized,
    Unknown,
}

/// What GitHub's answer means: `remaining` is its x-ratelimit-remaining header,
/// `retry_after` whether it sent a retry-after one, `token_sent` whether the
/// question carried the GitHub pill's token. A rate limit (the hourly one, or
/// the secondary one that only sends retry-after) is asked again later; a 401
/// with a token is the token's fault, not the pull request's.
fn kind_of(status: u16, remaining: Option<&str>, retry_after: bool, token_sent: bool) -> Kind {
    match status {
        200..=299 => Kind::Found,
        403 | 429 if remaining == Some("0") || retry_after => Kind::Unknown,
        401 if token_sent => Kind::Unauthorized,
        401 | 403 | 404 => Kind::Missing,
        _ => Kind::Unknown,
    }
}

/// Shared by every watch, like integrations.rs's: one set of TLS roots, one pool.
fn client() -> reqwest::Client {
    static CLIENT: LazyLock<reqwest::Client> =
        LazyLock::new(|| reqwest::Client::builder().timeout(Duration::from_secs(15)).build().unwrap_or_default());
    CLIENT.clone()
}

async fn rest(token: Option<&str>, path: &str) -> Answer {
    let mut req = client()
        .get(format!("https://api.github.com/{path}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Lumo");
    if let Some(token) = token {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    let Ok(response) = req.send().await else { return Answer::Unknown };
    let headers = response.headers();
    let remaining = headers.get("x-ratelimit-remaining").and_then(|v| v.to_str().ok());
    match kind_of(response.status().as_u16(), remaining, headers.contains_key("retry-after"), token.is_some()) {
        Kind::Found => response.json().await.map(Answer::Found).unwrap_or(Answer::Unknown),
        Kind::Missing => Answer::Missing,
        Kind::Unauthorized => Answer::Unauthorized,
        Kind::Unknown => Answer::Unknown,
    }
}

/// `gh api <path>`: the user's own GitHub CLI, signed in by itself.
async fn gh(path: String) -> Answer {
    let out = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("gh");
        cmd.args(["api", "-H", "Accept: application/vnd.github+json", &path]);
        platform::no_console(&mut cmd);
        cmd.output()
    })
    .await;
    let Ok(Ok(out)) = out else { return Answer::Unknown };
    if out.status.success() {
        return serde_json::from_slice(&out.stdout).map(Answer::Found).unwrap_or(Answer::Unknown);
    }
    let said = String::from_utf8_lossy(&out.stderr).to_string() + &String::from_utf8_lossy(&out.stdout);
    if said.contains("Not Found") || said.contains("HTTP 404") {
        Answer::Missing
    } else {
        Answer::Unknown
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Via {
    Token,
    Gh,
    Anonymous,
}

/// How GitHub is asked this round: the pill's token, else `gh` when it is
/// there and signed in, else without signing in.
async fn via() -> (Via, Option<String>) {
    if let Some(token) = secrets::get("github-token") {
        return (Via::Token, Some(token));
    }
    let gh_ok = tauri::async_runtime::spawn_blocking(|| {
        let mut cmd = std::process::Command::new("gh");
        cmd.args(["auth", "status"]);
        platform::no_console(&mut cmd);
        cmd.output().map(|o| o.status.success()).unwrap_or(false)
    })
    .await
    .unwrap_or(false);
    if gh_ok {
        (Via::Gh, None)
    } else {
        (Via::Anonymous, None)
    }
}

async fn ask(via: Via, token: Option<&str>, path: String) -> Answer {
    match via {
        Via::Gh => gh(path).await,
        _ => rest(token, &path).await,
    }
}

enum Read {
    State(PrState),
    Missing,
    /// The GitHub pill's token was turned down (Answer::Unauthorized).
    Unauthorized,
    Unknown,
}

/// The pull request as it stands, with what `until` needs to know.
async fn fetch(via: Via, token: Option<&str>, w: &Watch) -> Read {
    let base = format!("repos/{}/pulls/{}", w.repo, w.number);
    let pull = match ask(via, token, base.clone()).await {
        Answer::Found(v) => v,
        Answer::Missing => return Read::Missing,
        Answer::Unauthorized => return Read::Unauthorized,
        Answer::Unknown => return Read::Unknown,
    };
    let Some(mut pr) = PrState::from_pull(&pull) else { return Read::Unknown };
    if pr.open && matches!(w.until.as_str(), "checks" | "green" | "ready") && !pr.head_sha.is_empty() {
        let commit = format!("repos/{}/commits/{}", w.repo, pr.head_sha);
        let runs = match ask(via, token, format!("{commit}/check-runs?per_page=100")).await {
            Answer::Found(v) => Some(v),
            Answer::Unauthorized => return Read::Unauthorized,
            _ => return Read::Unknown,
        };
        let status = match ask(via, token, format!("{commit}/status")).await {
            Answer::Found(v) => Some(v),
            _ => None,
        };
        pr.checks = checks_of(runs.as_ref(), status.as_ref());
        if pr.checks == Checks::None {
            // No check listed: maybe Actions has runs whose jobs aren't there yet.
            let path = format!("repos/{}/actions/runs?head_sha={}&per_page=100", w.repo, pr.head_sha);
            match ask(via, token, path).await {
                Answer::Found(v) => pr.checks = actions_of(Checks::None, Some(&v)),
                // Actions off, or a token that can't read it: what the checks say stands.
                Answer::Missing => {}
                Answer::Unauthorized => return Read::Unauthorized,
                Answer::Unknown => return Read::Unknown,
            }
        }
    }
    if pr.open && w.until == "approved" {
        match ask(via, token, format!("{base}/reviews?per_page=100")).await {
            Answer::Found(v) => pr.review = review_of(Some(&v)),
            Answer::Unauthorized => return Read::Unauthorized,
            _ => return Read::Unknown,
        }
    }
    Read::State(pr)
}

/// `again_on`: the commit it fired on, when the pull request is still open
/// (a watch that listens every time goes on, waiting for the next one).
/// `w`: the watch as the look that saw it happen had it (take).
pub(crate) fn fire(app: &AppHandle, w: &Watch, met: bool, summary: String, again_on: Option<&str>) {
    let fired = take(w, met, &summary, again_on);
    tell(app, fired, met, summary);
}

/// An event on the calendar coming up (`at`: its start, `key`: its title),
/// for the calendar watch `id`: it fires unless that event was told already
/// (listen_local::calendar_next). What was told is read and written under the
/// same lock, so two events at the same start heard at once both stay told.
/// Whether it fired.
pub(crate) fn fire_calendar(app: &AppHandle, id: u64, summary: String, at: u64, key: &str) -> bool {
    let fired = with_store(|s| {
        let i = s.watches.iter().position(|w| w.id == id && w.source == "service" && w.target == "calendar" && !w.paused)?;
        let told = listen_local::calendar_next(&s.watches[i].last_sha, at, key)?;
        Some(taken(s, i, true, &summary, Some(&told)))
    });
    let any = fired.is_some();
    tell(app, fired, true, summary);
    any
}

/// The island is told what fired (take, taken).
fn tell(app: &AppHandle, fired: Option<(Watch, bool, bool)>, met: bool, summary: String) {
    if let Some((watch, ended, too_often)) = fired {
        let how = if met { "met" } else { "not met" };
        log::line(format!("listen: {} {} {} ({how})", watch.label(), watch.until, if ended { "ended" } else { "fired" }));
        if too_often {
            log::line(format!("listen: {} paused, fired {MAX_FIRES_PER_HOUR} times in an hour", watch.label()));
        }
        let _ = app.emit_to(WINDOW_LABEL, "listen-fired", Fired { watch, met, summary, ended });
        changed(app);
    }
}

/// Sets a watch's warning to `to` when it is `from` (None: whatever it is).
/// Whether it changed; then it is saved.
fn warn(id: u64, from: Option<&str>, to: &str) -> bool {
    with_store(|s| {
        let Some(w) = s.watches.iter_mut().find(|w| w.id == id) else { return false };
        if w.warning == to || from.is_some_and(|from| w.warning != from) {
            return false;
        }
        w.warning = to.to_string();
        save(&s.watches);
        true
    })
}

pub fn changed(app: &AppHandle) {
    let watches = list();
    crate::listen_events::prune(&watches);
    let _ = app.emit_to(WINDOW_LABEL, "listen-changed", watches);
}

/// One look at every watch.
async fn round(app: &AppHandle) -> Via {
    let (via, token) = via().await;
    let now = now_ms();
    for w in list().into_iter().filter(|w| w.github()) {
        let age = now.saturating_sub(w.started_at);
        if age >= MAX_AGE_MS {
            fire(app, &w, false, tf("Stopped listening to {pr} after a week", &[("pr", &w.label())]), None);
            continue;
        }
        if w.paused {
            continue;
        }
        match fetch(via, token.as_deref(), &w).await {
            Read::State(pr) => {
                // Edited or stopped while GitHub was asked: this answer was about the watch before.
                let Some(since_push) = with_store(|s| {
                    current(s, &w)?;
                    s.misses.remove(&w.id);
                    Some(head_age(&mut s.heads, w.id, &pr.head_sha, now))
                }) else {
                    continue;
                };
                // GitHub answers again: the token is fine (again).
                if warn(w.id, Some(TOKEN), "") {
                    changed(app);
                }
                if let Some((met, summary)) = judge(&w, &pr, since_push) {
                    let again_on = (pr.open && !pr.head_sha.is_empty()).then_some(pr.head_sha.as_str());
                    fire(app, &w, met, summary, again_on);
                }
            }
            Read::Missing => {
                let misses = with_store(|s| {
                    current(s, &w)?;
                    let n = s.misses.entry(w.id).or_insert(0);
                    *n += 1;
                    Some(*n)
                })
                .unwrap_or(0);
                if misses >= MAX_MISSES {
                    fire(app, &w, false, tf("Lumo can't read {pr} on GitHub", &[("pr", &w.label())]), None);
                }
            }
            // An expired or revoked token ends no watch: the Listening panel
            // says so, and the watch goes on once GitHub takes the token again.
            Read::Unauthorized => {
                if warn(w.id, None, TOKEN) {
                    log::line(format!("listen: {}: GitHub turned the token down", w.label()));
                    changed(app);
                }
            }
            Read::Unknown => {}
        }
    }
    via
}

/// How long between two rounds without signing in, for this many watches.
fn anonymous_every(watches: usize) -> Duration {
    EVERY_ANONYMOUS.max(ANONYMOUS_PER_WATCH * watches.min(MAX_WATCHES) as u32)
}

/// The listening loop: asleep while there is no watch, else a look every
/// little while, and at once when one is added.
pub fn start(app: AppHandle) {
    let app_local = app.clone();
    tauri::async_runtime::spawn(async move {
        // Watches kept from before a restart: say so to the island, and a
        // webhook gets its server back.
        changed(&app);
        if list().iter().any(|w| w.source == "webhook") {
            crate::listen_events::ensure_server(&app);
        }
        loop {
            if list().iter().all(|w| w.paused || !w.github()) {
                WAKE.notified().await;
                continue;
            }
            let via = if crate::integrations::PAUSED.load(Ordering::Relaxed) { Via::Token } else { round(&app).await };
            let on = list().iter().filter(|w| !w.paused && w.github()).count();
            let every = if via == Via::Anonymous { anonymous_every(on) } else { EVERY_SIGNED_IN };
            let _ = tokio::time::timeout(every, WAKE.notified()).await;
        }
    });
    tauri::async_runtime::spawn(async move {
        loop {
            if list().iter().all(|w| w.paused || !w.polled()) {
                WAKE_LOCAL.notified().await;
                continue;
            }
            if !crate::integrations::PAUSED.load(Ordering::Relaxed) {
                local_round(&app_local).await;
            }
            let _ = tokio::time::timeout(LOCAL_EVERY, WAKE_LOCAL.notified()).await;
        }
    });
}

// ── Looking at this PC ────────────────────────────────────────────────────────

/// The summary a state that became true fires with.
fn state_summary(w: &Watch) -> String {
    let what = w.label();
    let what = what.as_str();
    match (w.source.as_str(), w.until.as_str()) {
        ("process", "started") => tf("{what} started", &[("what", what)]),
        ("process", "exited") => tf("{what} exited", &[("what", what)]),
        ("process", "port_open") => tf("Port {port} is open", &[("port", &w.target)]),
        ("process", "port_closed") => tf("Port {port} closed", &[("port", &w.target)]),
        ("web", "up") => tf("{what} is up", &[("what", what)]),
        ("web", "down") => tf("{what} is down", &[("what", what)]),
        ("web", "gone") => tf("{what} no longer shows “{text}”", &[("what", what), ("text", &w.text)]),
        ("windows", "plugged") => t("The PC is plugged in"),
        ("windows", "unplugged") => t("The PC runs on its battery"),
        ("windows", "offline") => t("The PC is offline"),
        ("windows", "online") => t("The PC is back online"),
        ("windows", "back") => t("You're back at the computer"),
        _ => tf("{what} now shows “{text}”", &[("what", what), ("text", &w.text)]),
    }
}

/// A state the watch waits for held (`holds`) at this look: it fires when it
/// became true, and listening once also when it already was at the first look.
fn state(app: &AppHandle, w: &Watch, holds: bool) {
    let Some(before) = with_store(|s| seen_mut(s, w).map(|seen| seen.on.replace(holds))) else { return };
    let fires = holds && if w.mode == "every" { before == Some(false) } else { true };
    if fires {
        fire(app, w, true, state_summary(w), Some(w.last_sha.as_str()));
    }
}

/// A page changed: what is told, with the words that went and came when the
/// last look's words are known (`before`).
fn page_changed(w: &Watch, before: Option<&str>, after: &str) -> String {
    let what = w.label();
    match before.and_then(|before| listen_local::change_excerpt(before, after)) {
        Some((gone, came)) => {
            let or_dash = |s: &str| if s.is_empty() { "—".to_string() } else { s.to_string() };
            let (gone, came) = (or_dash(&gone), or_dash(&came));
            tf("{what} changed: “{before}” → “{after}”", &[("what", &what), ("before", &gone), ("after", &came)])
        }
        None => tf("{what} changed", &[("what", &what)]),
    }
}

/// A folder's files changed (`names`): what is told.
fn files_summary(w: &Watch, names: &[String]) -> String {
    let place = listen_local::folder_of(&w.target);
    let names = listen_local::names_text(names);
    let vars = [("place", place.as_str()), ("names", names.as_str())];
    match w.until.as_str() {
        "created" => tf("New in {place}: {names}", &vars),
        "deleted" => tf("Gone from {place}: {names}", &vars),
        "download" => tf("Downloaded in {place}: {names}", &vars),
        _ => tf("Changed in {place}: {names}", &vars),
    }
}

/// One look at every watch on this PC.
async fn local_round(app: &AppHandle) {
    let now = now_ms();
    let watches: Vec<Watch> = list().into_iter().filter(|w| w.polled() && !w.paused).collect();
    let programs = if watches.iter().any(|w| w.source == "process" && !w.until.starts_with("port_")) {
        tauri::async_runtime::spawn_blocking(platform::process_names).await.unwrap_or_default()
    } else {
        Default::default()
    };
    for w in watches {
        if w.mode != "every" && now.saturating_sub(w.started_at) >= MAX_AGE_MS {
            fire(app, &w, false, tf("Stopped listening to {pr} after a week", &[("pr", &w.label())]), None);
            continue;
        }
        match w.source.as_str() {
            "fs" => {
                let path = PathBuf::from(&w.target);
                let Ok(Some(after)) = tauri::async_runtime::spawn_blocking(move || listen_local::listing(&path)).await else { continue };
                // Edited or stopped while the folder was read: the listing is another folder's.
                let Some(before) = with_store(|s| seen_mut(s, &w).map(|seen| seen.files.take())) else { continue };
                let Some(before) = before else {
                    with_store(|s| seen_mut(s, &w).map(|seen| seen.files = Some(after)));
                    continue;
                };
                let (names, keep) = listen_local::judge_files(&w.until, &before, after, now_ms());
                with_store(|s| seen_mut(s, &w).map(|seen| seen.files = Some(keep)));
                if !names.is_empty() {
                    fire(app, &w, true, files_summary(&w, &names), Some(""));
                }
            }
            "process" => {
                let holds = match w.until.as_str() {
                    "started" => listen_local::running(&programs, &w.target),
                    "exited" => !listen_local::running(&programs, &w.target),
                    until => {
                        let Ok(port) = w.target.parse::<u16>() else { continue };
                        let open = tauri::async_runtime::spawn_blocking(move || listen_local::port_open(port)).await.unwrap_or(false);
                        (until == "port_open") == open
                    }
                };
                state(app, &w, holds);
            }
            "web" => {
                if !due(w.id, now, WEB_EVERY_MS) {
                    continue;
                }
                // A page saved before only public https pages were watched
                // (this PC, the local network): never opened, never "down".
                if crate::web_image::public_url(&w.target).is_err() {
                    continue;
                }
                // The PC itself offline: no page would answer, and that says
                // nothing about this one. No look, and the failures running stay as they were.
                if !tauri::async_runtime::spawn_blocking(listen_local::online).await.unwrap_or(true) {
                    continue;
                }
                let page = listen_local::page(&w.target).await;
                let up = page.up();
                // Edited or stopped while the page was asked for: the answer is the old page's.
                let Some(fails) = with_store(|s| {
                    let seen = seen_mut(s, &w)?;
                    seen.fails = if up { 0 } else { seen.fails.saturating_add(1) };
                    Some(seen.fails)
                }) else {
                    continue;
                };
                // A page that doesn't answer neither shows a text nor stops
                // showing it, nor changed: only up and down are about that.
                if !up && !matches!(w.until.as_str(), "up" | "down") {
                    continue;
                }
                match w.until.as_str() {
                    "changed" => {
                        let print = listen_local::fingerprint(&page.text);
                        let Some(before) = with_store(|s| seen_mut(s, &w).map(|seen| seen.text.replace(page.text.clone()))) else { continue };
                        if w.last_sha.is_empty() {
                            first_print(&w, print);
                        } else if print != w.last_sha {
                            fire(app, &w, true, page_changed(&w, before.as_deref(), &page.text), Some(print.as_str()));
                        }
                    }
                    "up" => state(app, &w, up),
                    // Down only after a few looks running without an answer.
                    // The looks before that say neither (the page may be
                    // coming back), so a page already down when Lumo starts
                    // isn't told as newly down at the third look.
                    "down" => {
                        if up {
                            state(app, &w, false);
                        } else if fails >= WEB_DOWN_AFTER {
                            state(app, &w, true);
                        }
                    }
                    "gone" => state(app, &w, !listen_local::contains(&page, &w.text)),
                    _ => state(app, &w, listen_local::contains(&page, &w.text)),
                }
            }
            "windows" => windows(app, &w, now).await,
            "tool" => tool(app, &w, now).await,
            _ => {}
        }
    }
}

/// Whether the watch's turn came (`every_ms` since it last looked): it looks now.
fn due(id: u64, now: u64, every_ms: u64) -> bool {
    with_store(|s| {
        let seen = s.seen.entry(id).or_default();
        let due = now.saturating_sub(seen.asked) >= every_ms;
        if due {
            seen.asked = now;
        }
        due
    })
}

/// One look at Windows, for a watch on it.
async fn windows(app: &AppHandle, w: &Watch, now: u64) {
    match w.until.as_str() {
        "notification" => {
            if !due(w.id, now, NOTIFICATIONS_EVERY_MS) {
                return;
            }
            let handle = app.clone();
            let read = tauri::async_runtime::spawn_blocking(move || crate::notifications::read(&handle)).await;
            let list = match read {
                Ok(Ok(list)) => list,
                Ok(Err(why)) => {
                    log::line(format!("listen: notifications: {why}"));
                    fire(app, w, false, t("Windows doesn't let Lumo read the notifications"), None);
                    return;
                }
                Err(_) => return,
            };
            let newest = list.iter().map(|n| n.at).max().unwrap_or(0);
            // None: the first look, which only takes note of what is there.
            let before = with_store(|s| {
                let seen = seen_mut(s, w)?;
                let before = seen.on.is_some().then_some(seen.mark);
                seen.on = Some(true);
                seen.mark = seen.mark.max(newest);
                before
            });
            let Some(before) = before else { return };
            let fresh: Vec<_> = list.iter().filter(|n| n.at > before && listen_local::notification_matches(&w.target, &n.app)).collect();
            if let Some(n) = fresh.first() {
                let text = listen_local::excerpt(&n.text, 200);
                fire(app, w, true, tf("{app}: {text}", &[("app", &n.app), ("text", &text)]), Some(""));
            }
        }
        "usb" => {
            let drives: Listing = tauri::async_runtime::spawn_blocking(platform::removable_drives)
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|d| (d, (0, 0)))
                .collect();
            let before = with_store(|s| seen_mut(s, w).and_then(|seen| seen.files.replace(drives.clone())));
            let Some(before) = before else { return };
            let added: Vec<String> = drives.keys().filter(|d| !before.contains_key(*d)).cloned().collect();
            if !added.is_empty() {
                fire(app, w, true, tf("A USB drive was connected: {drives}", &[("drives", &listen_local::names_text(&added))]), Some(""));
            }
        }
        "back" => {
            let idle = tauri::async_runtime::spawn_blocking(platform::idle_ms).await.unwrap_or(0);
            let away = idle >= w.amount as u64 * 60_000;
            let Some(before) = with_store(|s| {
                let seen = seen_mut(s, w)?;
                let before = seen.on;
                // Away until the input comes back, whatever the look in between.
                if away || idle < BACK_MS {
                    seen.on = Some(away);
                }
                Some(before)
            }) else {
                return;
            };
            if before == Some(true) && idle < BACK_MS {
                fire(app, w, true, state_summary(w), Some(""));
            }
        }
        "battery_low" | "plugged" | "unplugged" => {
            let Some(power) = tauri::async_runtime::spawn_blocking(platform::power).await.ok().flatten() else { return };
            match w.until.as_str() {
                "plugged" => state(app, w, power.plugged),
                "unplugged" => state(app, w, !power.plugged),
                _ => {
                    let Some(percent) = power.percent else { return };
                    let low = !power.plugged && percent <= w.amount;
                    let Some(before) = with_store(|s| seen_mut(s, w).map(|seen| seen.on.replace(low))) else { return };
                    if low && (w.mode != "every" || before == Some(false)) {
                        let percent = percent.to_string();
                        fire(app, w, true, tf("The battery is at {percent}%", &[("percent", &percent)]), Some(""));
                    }
                }
            }
        }
        until => {
            let online = tauri::async_runtime::spawn_blocking(listen_local::online).await.unwrap_or(true);
            state(app, w, (until == "online") == online);
        }
    }
}

/// One run of the user's tool, when its turn came, for a watch on what it prints.
async fn tool(app: &AppHandle, w: &Watch, now: u64) {
    if !due(w.id, now, w.amount.max(1) as u64 * 60_000) {
        return;
    }
    let id = w.target.clone();
    let Ok(run) = tauri::async_runtime::spawn_blocking(move || crate::tools::run_listened(&id)).await else { return };
    let run = match run {
        Ok(run) => run,
        Err(why) => {
            fire(app, w, false, tf("Lumo can no longer run {tool}: {why}", &[("tool", &w.target), ("why", &why)]), None);
            return;
        }
    };
    if !run.ok {
        log::line(format!("listen: tool {} failed", w.target));
        return;
    }
    match w.until.as_str() {
        "contains" => state(app, w, run.output.to_lowercase().contains(&w.text.trim().to_lowercase())),
        _ => {
            let print = listen_local::fingerprint(run.output.trim());
            if w.last_sha.is_empty() {
                first_print(w, print);
            } else if print != w.last_sha {
                let said = listen_local::excerpt(&run.output, 200);
                fire(app, w, true, tf("{tool} says: {output}", &[("tool", &w.target), ("output", &said)]), Some(print.as_str()));
            }
        }
    }
}

/// `replace`: the watch this is an edit of, which it takes the place and the id of (push).
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn listen_add(
    app: AppHandle,
    repo: String,
    number: u64,
    until: String,
    mode: Option<String>,
    task: String,
    chat_id: String,
    replace: Option<u64>,
) -> Result<Watch, String> {
    let watch = add(&repo, number, &until, mode.as_deref().unwrap_or(""), &task, &chat_id, replace)?;
    log::line(format!("listen: {} {} {}", watch.label(), watch.until, watch.mode));
    changed(&app);
    Ok(watch)
}

/// A watch on this PC, or on what Lumo hears (add_local). An error starting
/// with `needs:` names what to turn on first (listen_events::available).
/// `replace`: the watch this is an edit of (push).
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn listen_add_local(
    app: AppHandle,
    source: String,
    target: String,
    until: String,
    mode: Option<String>,
    text: Option<String>,
    amount: Option<u32>,
    task: String,
    chat_id: String,
    replace: Option<u64>,
) -> Result<Watch, String> {
    let kind = source.trim().to_ascii_lowercase();
    let text = text.unwrap_or_default();
    let named = listen_local::target(&kind, until.trim().to_ascii_lowercase().as_str(), &target, text.trim(), &platform::home_dir())?;
    crate::listen_events::available(&app, &kind, &named)?;
    let watch = add_local(&source, &target, &until, mode.as_deref().unwrap_or(""), &text, amount.unwrap_or(0), &task, &chat_id, replace)?;
    if watch.source == "webhook" {
        crate::listen_events::ensure_server(&app);
        // An edit kept the webhook's id, and with it its secret: the address
        // the programs were given still works. A new one gets its own.
        crate::listen_events::token_for(watch.id);
    }
    log::line(format!("listen: {} {} {} {}", watch.source, watch.label(), watch.until, watch.mode));
    changed(&app);
    Ok(watch)
}

#[tauri::command(async)]
pub fn listen_cancel_local(app: AppHandle, source: String, target: String) -> usize {
    let n = cancel_local(&source, &target);
    changed(&app);
    n
}

#[tauri::command(async)]
pub fn listen_stop(app: AppHandle, id: u64) -> bool {
    let done = stop(id);
    changed(&app);
    done
}

/// `id` None: every watch.
#[tauri::command(async)]
pub fn listen_pause(app: AppHandle, id: Option<u64>, paused: bool) -> usize {
    let n = pause(id, paused);
    changed(&app);
    n
}

#[tauri::command(async)]
pub fn listen_history() -> Vec<Past> {
    history()
}

#[tauri::command(async)]
pub fn listen_history_clear() {
    clear_history()
}

#[tauri::command(async)]
pub fn listen_cancel(app: AppHandle, repo: String, number: u64, until: Option<String>) -> usize {
    let n = cancel(&repo, number, until.as_deref());
    changed(&app);
    n
}

#[tauri::command(async)]
pub fn listen_list() -> Vec<Watch> {
    list()
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_watch_id_is_never_given_twice_after_a_restart() {
        let w = |id| Watch { id, ..watch("checks") };
        let past = |id| Past { watch: w(id), met: true, summary: String::new(), at: 0 };
        assert_eq!(first_free_id(&[], &[], 0), 1);
        assert_eq!(first_free_id(&[w(3), w(7)], &[], 0), 8);
        // A watch that went is still in the past ones, or only in the mark.
        assert_eq!(first_free_id(&[w(3)], &[past(9)], 0), 10);
        assert_eq!(first_free_id(&[w(3)], &[], 12), 12);
    }

    use super::*;
    use serde_json::json;

    #[test]
    fn without_signing_in_it_stays_under_githubs_hourly_limit() {
        for n in 1..=MAX_WATCHES {
            let rounds_an_hour = 3600 / anonymous_every(n).as_secs() as usize;
            assert!(rounds_an_hour * n * ASKS_PER_LOOK <= 60, "{n} watches");
        }
    }

    fn watch(until: &str) -> Watch {
        Watch {
            id: 1,
            repo: "o/r".into(),
            number: 12,
            until: until.into(),
            task: String::new(),
            chat_id: "c".into(),
            started_at: 0,
            source: pull_requests(),
            mode: once(),
            paused: false,
            fired: 0,
            last_sha: String::new(),
            target: String::new(),
            text: String::new(),
            amount: 0,
            warning: String::new(),
        }
    }

    /// A store already read from its file, holding these watches.
    fn store(watches: Vec<Watch>) -> Store {
        Store { next_id: watches.iter().map(|w| w.id).max().unwrap_or(0) + 1, watches, loaded: true, ..Default::default() }
    }

    #[test]
    fn a_token_github_turns_down_or_a_rate_limit_ends_no_watch() {
        assert_eq!(kind_of(200, Some("4999"), false, true), Kind::Found);
        // The token expired or was revoked: the token's fault, not the pull request's.
        assert_eq!(kind_of(401, None, false, true), Kind::Unauthorized);
        assert_eq!(kind_of(401, None, false, false), Kind::Missing);
        // The hourly limit, and the secondary one that only says when to come back.
        assert_eq!(kind_of(403, Some("0"), false, true), Kind::Unknown);
        assert_eq!(kind_of(403, Some("4000"), true, true), Kind::Unknown);
        assert_eq!(kind_of(429, None, true, false), Kind::Unknown);
        assert_eq!(kind_of(429, Some("0"), false, false), Kind::Unknown);
        assert_eq!(kind_of(429, None, false, false), Kind::Unknown);
        // A repository it can't see, or none.
        assert_eq!(kind_of(403, Some("4000"), false, true), Kind::Missing);
        assert_eq!(kind_of(403, None, false, false), Kind::Missing);
        assert_eq!(kind_of(404, None, false, true), Kind::Missing);
        assert_eq!(kind_of(502, None, false, true), Kind::Unknown);
    }

    #[test]
    fn a_look_at_the_watch_before_an_edit_lands_on_nothing() {
        let page = Watch { id: 5, source: "web".into(), until: "changed".into(), target: "https://a.example/".into(), started_at: 100, ..watch("checks") };
        let mut s = store(vec![page.clone()]);
        assert_eq!(current(&s, &page), Some(0));
        assert!(seen_mut(&mut s, &page).is_some());
        // Edited (another page) while a look at the old one went on.
        let (kept, _) = place(&mut s, Watch { id: 0, target: "https://b.example/".into(), started_at: 100, ..page.clone() }, Some(5));
        assert_eq!(kept.id, 5);
        assert!(kept.started_at > page.started_at, "an edit always starts later, even in the same millisecond");
        assert_eq!(current(&s, &page), None, "the old copy is no longer the watch");
        assert!(seen_mut(&mut s, &page).is_none());
        assert!(!s.seen.contains_key(&5), "nothing seen of the old page comes back");
        assert_eq!(current(&s, &kept), Some(0));
        // Stopped: nothing either.
        s.watches.clear();
        assert_eq!(current(&s, &kept), None);
    }

    #[test]
    fn other_words_to_wait_for_are_not_known_to_hold_yet() {
        let shop = Watch { id: 5, source: "web".into(), until: "contains".into(), target: "https://shop.example/x".into(), text: "Sold out".into(), mode: "every".into(), last_sha: "told".into(), ..watch("checks") };
        let mut s = store(vec![shop.clone()]);
        s.seen.insert(5, Seen { on: Some(false), fails: 1, ..Default::default() });
        let (kept, _) = place(&mut s, Watch { id: 0, text: "Add to cart".into(), last_sha: String::new(), ..shop.clone() }, Some(5));
        assert_eq!(kept.last_sha, "told");
        let seen = &s.seen[&5];
        assert_eq!((seen.on, seen.fails), (None, 1), "whether it held was about the old words");
        // Only what to do then changes: what held still does.
        s.seen.get_mut(&5).unwrap().on = Some(true);
        place(&mut s, Watch { id: 0, task: "buy it".into(), ..kept.clone() }, Some(5));
        assert_eq!(s.seen[&5].on, Some(true));
        // Another threshold, the same.
        let low = Watch { id: 6, source: "windows".into(), until: "battery_low".into(), amount: 20, mode: "every".into(), ..watch("checks") };
        s.watches.push(low.clone());
        s.seen.insert(6, Seen { on: Some(false), ..Default::default() });
        place(&mut s, Watch { id: 0, amount: 50, ..low }, Some(6));
        assert_eq!(s.seen[&6].on, None);
    }

    #[test]
    fn an_edit_keeps_the_watch_its_id_and_what_still_stands() {
        let hook = Watch {
            id: 5,
            source: "webhook".into(),
            until: "called".into(),
            target: "deploys".into(),
            repo: String::new(),
            number: 0,
            mode: "every".into(),
            paused: true,
            fired: 3,
            last_sha: "seen".into(),
            warning: TOO_OFTEN.into(),
            ..watch("checks")
        };
        let other = Watch { id: 6, ..watch("merged") };
        let mut s = store(vec![hook.clone(), other]);
        s.seen.insert(5, Seen::default());
        s.fires.insert(5, vec![1]);
        s.misses.insert(5, 1);
        s.heads.insert(5, ("abc".into(), 1));
        // What to do then changes: the same webhook, the same event.
        let edit = Watch { id: 0, task: "deploy it".into(), paused: false, fired: 0, last_sha: String::new(), warning: String::new(), ..hook.clone() };
        let (kept, made_room) = place(&mut s, edit, Some(5));
        assert!(made_room.is_empty());
        assert_eq!((kept.id, kept.paused, kept.fired, kept.last_sha.as_str(), kept.task.as_str()), (5, true, 3, "seen", "deploy it"));
        assert_eq!(kept.warning, TOO_OFTEN, "still paused for firing too often");
        assert_eq!(s.watches.iter().map(|w| w.id).collect::<Vec<_>>(), [5, 6], "in its place, no new id");
        assert_eq!(s.next_id, 7);
        assert!(s.seen.contains_key(&5) && s.fires.contains_key(&5) && s.misses.contains_key(&5) && s.heads.contains_key(&5));
        // Another name: the same id (so the same address), but what was seen goes.
        let renamed = Watch { target: "releases".into(), last_sha: String::new(), ..kept.clone() };
        let (kept, _) = place(&mut s, renamed, Some(5));
        assert_eq!(kept.id, 5);
        assert!(kept.last_sha.is_empty());
        assert!(!s.seen.contains_key(&5) && !s.fires.contains_key(&5) && !s.misses.contains_key(&5) && !s.heads.contains_key(&5));
        // A token warning goes with the edit: the next look says it again if it must.
        s.watches[1].warning = TOKEN.into();
        let (kept, _) = place(&mut s, Watch { id: 0, task: "x".into(), ..watch("merged") }, Some(6));
        assert_eq!((kept.id, kept.warning.as_str()), (6, ""));
        // A watch it no longer names makes a new one.
        let (kept, _) = place(&mut s, Watch { id: 0, number: 77, ..watch("merged") }, Some(404));
        assert_eq!(kept.id, 7);
    }

    #[test]
    fn the_watch_after_the_last_makes_room_and_an_edit_takes_none() {
        let full: Vec<Watch> = (1..=MAX_WATCHES as u64).map(|id| Watch { id, number: id, ..watch("merged") }).collect();
        let mut s = store(full);
        let edit = Watch { id: 0, task: "merge it".into(), number: 3, ..watch("merged") };
        let (kept, made_room) = place(&mut s, edit, Some(3));
        assert!(made_room.is_empty());
        assert_eq!(kept.id, 3);
        assert_eq!(s.watches.len(), MAX_WATCHES);
        // An edit that now names what another listens to: that one goes.
        let (kept, made_room) = place(&mut s, Watch { id: 0, number: 4, ..watch("merged") }, Some(3));
        assert!(made_room.is_empty());
        assert_eq!(kept.id, 3);
        assert!(!s.watches.iter().any(|w| w.id == 4));
        assert_eq!(s.watches.len(), MAX_WATCHES - 1);
        place(&mut s, Watch { id: 0, number: 98, ..watch("merged") }, None);
        // Full again: a new one makes the oldest go, handed back to be told.
        let (kept, made_room) = place(&mut s, Watch { id: 0, number: 99, ..watch("merged") }, None);
        assert_eq!(made_room.iter().map(|w| w.id).collect::<Vec<_>>(), [1]);
        assert_eq!(kept.id, MAX_WATCHES as u64 + 2);
        assert_eq!(s.watches.len(), MAX_WATCHES);
    }

    #[test]
    fn a_page_says_what_changed_and_what_it_no_longer_shows() {
        let page = Watch { source: "web".into(), until: "changed".into(), target: "https://example.com/p".into(), repo: String::new(), number: 0, ..watch("checks") };
        let told = page_changed(&page, Some("Price 10 euro today"), "Price 12 euro today");
        assert!(told.contains("example.com/p") && told.contains("10") && told.contains("12"), "{told}");
        let added = page_changed(&page, Some("In stock"), "In stock now");
        assert!(added.contains("—") && added.contains("now"), "{added}");
        // The words before unknown (a restart): only that it changed.
        assert!(!page_changed(&page, None, "x").contains("—"));
        let gone = Watch { until: "gone".into(), text: "Sold out".into(), ..page };
        let told = state_summary(&gone);
        assert!(told.contains("example.com/p") && told.contains("Sold out"), "{told}");
    }

    fn open(checks: Checks) -> PrState {
        PrState {
            open: true,
            merged: false,
            draft: false,
            mergeable: Some(true),
            mergeable_state: "clean".into(),
            head_sha: "abc".into(),
            checks,
            review: Review::None,
        }
    }

    #[test]
    fn only_a_real_repository_and_event_is_listened_to() {
        assert!(valid("Rccrd12/Lumo", 5, "merged"));
        assert!(valid("a.b/c-d_e", 1, "ready"));
        assert!(!valid("Rccrd12", 5, "merged"));
        assert!(!valid("o/r/x", 5, "merged"));
        assert!(!valid("../r", 5, "merged"));
        assert!(!valid("o/r?x=1", 5, "merged"));
        assert!(!valid("o/r", 0, "merged"));
        assert!(!valid("o/r", 5, "deployed"));
    }

    #[test]
    fn a_merge_ends_every_watch_and_meets_merged_and_closed() {
        let merged = PrState { open: false, merged: true, ..open(Checks::Pending) };
        assert_eq!(judge(&watch("merged"), &merged, 0).map(|j| j.0), Some(true));
        assert_eq!(judge(&watch("closed"), &merged, 0).map(|j| j.0), Some(true));
        assert_eq!(judge(&watch("ready"), &merged, 0).map(|j| j.0), Some(false));
        let closed = PrState { open: false, ..open(Checks::Pending) };
        assert_eq!(judge(&watch("merged"), &closed, 0).map(|j| j.0), Some(false));
        assert_eq!(judge(&watch("closed"), &closed, 0).map(|j| j.0), Some(true));
    }

    #[test]
    fn merged_waits_whatever_the_checks_say() {
        assert_eq!(judge(&watch("merged"), &open(Checks::Failed(vec!["ci".into()])), 0), None);
        assert_eq!(judge(&watch("merged"), &open(Checks::Passed), 0), None);
    }

    #[test]
    fn checks_end_either_way_green_only_on_success() {
        let failed = open(Checks::Failed(vec!["build".into()]));
        assert_eq!(judge(&watch("checks"), &failed, 0).map(|j| j.0), Some(true));
        assert_eq!(judge(&watch("green"), &failed, 0).map(|j| j.0), Some(false));
        assert!(judge(&watch("green"), &failed, 0).unwrap().1.contains("build"));
        assert_eq!(judge(&watch("green"), &open(Checks::Pending), 0), None);
        assert_eq!(judge(&watch("green"), &open(Checks::Passed), 0).map(|j| j.0), Some(true));
    }

    #[test]
    fn no_checks_yet_is_not_success_until_the_grace_is_over() {
        assert_eq!(judge(&watch("green"), &open(Checks::None), 10_000), None);
        assert_eq!(judge(&watch("green"), &open(Checks::None), NO_CHECKS_GRACE_MS).map(|j| j.0), Some(true));
    }

    #[test]
    fn the_wait_for_checks_starts_again_with_each_push() {
        let mut heads = HashMap::new();
        assert_eq!(head_age(&mut heads, 1, "abc", 1_000), 0);
        assert_eq!(head_age(&mut heads, 1, "abc", 1_000 + NO_CHECKS_GRACE_MS), NO_CHECKS_GRACE_MS);
        // A push long after listening began: no checks listed yet is not success.
        let later = 10 * NO_CHECKS_GRACE_MS;
        let age = head_age(&mut heads, 1, "def", later);
        assert_eq!(age, 0);
        let pushed = PrState { head_sha: "def".into(), ..open(Checks::None) };
        assert_eq!(judge(&watch("green"), &pushed, age), None);
        assert_eq!(head_age(&mut heads, 1, "def", later + 60_000), 60_000);
        // Each watch counts on its own.
        assert_eq!(head_age(&mut heads, 2, "def", later + 60_000), 0);
    }

    #[test]
    fn ready_needs_green_checks_a_clean_merge_and_no_draft() {
        assert_eq!(judge(&watch("ready"), &open(Checks::Passed), 0).map(|j| j.0), Some(true));
        assert_eq!(judge(&watch("ready"), &open(Checks::Pending), 0), None);
        let draft = PrState { draft: true, ..open(Checks::Passed) };
        assert_eq!(judge(&watch("ready"), &draft, 0), None);
        let blocked = PrState { mergeable_state: "blocked".into(), ..open(Checks::Passed) };
        assert_eq!(judge(&watch("ready"), &blocked, 0), None, "waits for the review it needs");
        let unknown = PrState { mergeable: None, mergeable_state: "unknown".into(), ..open(Checks::Passed) };
        assert_eq!(judge(&watch("ready"), &unknown, 0), None, "GitHub is still working it out");
        let conflict = PrState { mergeable: Some(false), mergeable_state: "dirty".into(), ..open(Checks::Passed) };
        assert_eq!(judge(&watch("ready"), &conflict, 0).map(|j| j.0), Some(false));
    }

    #[test]
    fn approved_follows_each_reviewers_last_say() {
        let reviews = json!([
            { "user": { "login": "a" }, "state": "CHANGES_REQUESTED" },
            { "user": { "login": "b" }, "state": "COMMENTED" },
            { "user": { "login": "a" }, "state": "APPROVED" },
        ]);
        assert_eq!(review_of(Some(&reviews)), Review::Approved);
        let blocked = json!([
            { "user": { "login": "a" }, "state": "APPROVED" },
            { "user": { "login": "b" }, "state": "CHANGES_REQUESTED" },
        ]);
        assert_eq!(review_of(Some(&blocked)), Review::ChangesRequested);
        assert_eq!(review_of(Some(&json!([]))), Review::None);
        let pr = PrState { review: Review::Approved, ..open(Checks::Pending) };
        assert_eq!(judge(&watch("approved"), &pr, 0).map(|j| j.0), Some(true));
    }

    #[test]
    fn checks_read_runs_and_statuses_together() {
        let runs = json!({ "check_runs": [
            { "name": "build", "status": "completed", "conclusion": "success" },
            { "name": "lint", "status": "completed", "conclusion": "skipped" },
        ]});
        assert_eq!(checks_of(Some(&runs), None), Checks::Passed);
        let running = json!({ "check_runs": [{ "name": "test", "status": "in_progress", "conclusion": null }] });
        assert_eq!(checks_of(Some(&running), None), Checks::Pending);
        let status = json!({ "statuses": [{ "context": "vercel", "state": "failure" }] });
        assert_eq!(checks_of(Some(&running), Some(&status)), Checks::Failed(vec!["vercel".into()]));
        assert_eq!(checks_of(Some(&json!({ "check_runs": [] })), Some(&json!({ "statuses": [] }))), Checks::None);
        // A check cancelled (its run stopped half way): not green, said as cancelled;
        // beside one that failed, a failure; beside one still running, wait for it.
        let stopped = json!({ "check_runs": [
            { "name": "build", "status": "completed", "conclusion": "success" },
            { "name": "e2e", "status": "completed", "conclusion": "cancelled" },
        ]});
        assert_eq!(checks_of(Some(&stopped), None), Checks::Cancelled(vec!["e2e".into()]));
        assert_eq!(checks_of(Some(&stopped), Some(&status)), Checks::Failed(vec!["vercel".into()]));
        let still = json!({ "check_runs": [
            { "name": "e2e", "status": "completed", "conclusion": "cancelled" },
            { "name": "test", "status": "in_progress", "conclusion": null },
        ]});
        assert_eq!(checks_of(Some(&still), None), Checks::Pending);
    }

    #[test]
    fn a_queued_actions_run_without_jobs_is_not_no_checks() {
        let none = checks_of(Some(&json!({ "check_runs": [] })), Some(&json!({ "statuses": [] })));
        // Windows CI and E2E queued, GitHub has not created their jobs yet.
        let queued = json!({ "workflow_runs": [
            { "name": "Windows CI", "status": "queued", "conclusion": null },
            { "name": "Windows E2E", "status": "queued", "conclusion": null },
        ]});
        let checks = actions_of(none.clone(), Some(&queued));
        assert_eq!(checks, Checks::Pending);
        // Long after the push it still waits: not "Checks passed".
        assert_eq!(judge(&watch("green"), &open(checks.clone()), 10 * NO_CHECKS_GRACE_MS), None);
        assert_eq!(judge(&watch("checks"), &open(checks.clone()), 10 * NO_CHECKS_GRACE_MS), None);
        assert_eq!(judge(&watch("ready"), &open(checks), 10 * NO_CHECKS_GRACE_MS), None);
        for status in ["in_progress", "requested", "waiting", "pending"] {
            let run = json!({ "workflow_runs": [{ "name": "ci", "status": status, "conclusion": null }] });
            assert_eq!(actions_of(Checks::None, Some(&run)), Checks::Pending, "{status}");
        }
        let approval = json!({ "workflow_runs": [{ "name": "ci", "status": "completed", "conclusion": "action_required" }] });
        assert_eq!(actions_of(Checks::None, Some(&approval)), Checks::Pending);
    }

    #[test]
    fn a_repository_without_actions_runs_keeps_the_three_minutes() {
        let none = actions_of(Checks::None, Some(&json!({ "total_count": 0, "workflow_runs": [] })));
        assert_eq!(none, Checks::None);
        assert_eq!(judge(&watch("green"), &open(none.clone()), 10_000), None);
        assert_eq!(judge(&watch("green"), &open(none.clone()), NO_CHECKS_GRACE_MS).map(|j| j.0), Some(true));
        // Actions not readable (off, or the token can't): the same.
        assert_eq!(actions_of(Checks::None, None), Checks::None);
    }

    #[test]
    fn actions_runs_only_speak_when_no_check_is_listed() {
        let queued = json!({ "workflow_runs": [{ "name": "ci", "status": "queued", "conclusion": null }] });
        assert_eq!(actions_of(Checks::Passed, Some(&queued)), Checks::Passed);
        let failed = Checks::Failed(vec!["build".into()]);
        assert_eq!(actions_of(failed.clone(), Some(&queued)), failed);
        // A run that ended before any job: a broken workflow fails, a superseded one doesn't.
        let broken = json!({ "workflow_runs": [
            { "name": "Windows CI", "status": "completed", "conclusion": "startup_failure" },
            { "name": "Windows E2E", "status": "completed", "conclusion": "cancelled" },
        ]});
        assert_eq!(actions_of(Checks::None, Some(&broken)), Checks::Failed(vec!["Windows CI".into()]));
        let done = json!({ "workflow_runs": [
            { "name": "Windows CI", "status": "completed", "conclusion": "success" },
            { "name": "Windows E2E", "status": "completed", "conclusion": "cancelled" },
        ]});
        assert_eq!(actions_of(Checks::None, Some(&done)), Checks::Passed);
        // Every run cancelled in the queue: nothing ran, so nothing passed.
        let stopped = json!({ "workflow_runs": [
            { "name": "Windows CI", "status": "completed", "conclusion": "cancelled" },
            { "name": "Windows E2E", "status": "completed", "conclusion": "cancelled" },
        ]});
        let stopped = actions_of(Checks::None, Some(&stopped));
        assert_eq!(stopped, Checks::Cancelled(vec!["Windows CI".into(), "Windows E2E".into()]));
        assert_ne!(judge(&watch("green"), &open(stopped.clone()), 10 * NO_CHECKS_GRACE_MS).map(|j| j.0), Some(true), "never green");
        // Said as cancelled, not as failed.
        let said = judge(&watch("green"), &open(stopped), 0).expect("it ends the wait").1;
        let as_failed = judge(&watch("green"), &open(Checks::Failed(vec!["Windows CI".into(), "Windows E2E".into()])), 0).unwrap().1;
        assert!(said.contains("Windows CI") && said != as_failed, "{said}");
    }

    #[test]
    fn only_what_happens_again_with_each_push_can_listen_every_time() {
        assert!(mode_ok(GITHUB, "checks", "every") && mode_ok(GITHUB, "green", "every"));
        assert!(mode_ok(GITHUB, "merged", "once") && mode_ok(GITHUB, "ready", "once"));
        assert!(!mode_ok(GITHUB, "merged", "every") && !mode_ok(GITHUB, "ready", "every"));
        assert!(!mode_ok(GITHUB, "checks", "always"));
        // On this PC everything can happen again.
        assert!(mode_ok("fs", "created", "every") && mode_ok("web", "changed", "every") && mode_ok("process", "started", "every"));
    }

    #[test]
    fn listening_every_time_waits_for_the_next_commit() {
        let every = Watch { mode: "every".into(), last_sha: "abc".into(), ..watch("checks") };
        // The commit it already fired on: nothing new.
        assert_eq!(judge(&every, &open(Checks::Passed), 0), None);
        let pushed = PrState { head_sha: "def".into(), ..open(Checks::Passed) };
        assert_eq!(judge(&every, &pushed, 0).map(|j| j.0), Some(true));
        // A merge still ends it.
        let merged = PrState { open: false, merged: true, ..open(Checks::Passed) };
        assert_eq!(judge(&every, &merged, 0).map(|j| j.0), Some(false));
    }

    #[test]
    fn a_watch_on_this_pc_is_named_by_its_target() {
        let w = Watch { source: "fs".into(), until: "download".into(), target: "C:\\Users\\me\\Downloads".into(), repo: String::new(), number: 0, ..watch("checks") };
        assert_eq!(w.label(), "Downloads");
        assert!(!w.github());
        let again = Watch { id: 2, target: "c:\\users\\me\\downloads".into(), ..w.clone() };
        assert!(same(&w, &again));
        assert!(!same(&w, &Watch { until: "created".into(), ..w.clone() }));
        assert!(!same(&w, &watch("checks")));
    }

    #[test]
    fn a_file_from_before_reads_as_once_on_a_pull_request() {
        let old = r#"[{"id":3,"repo":"o/r","number":5,"until":"ready","task":"merge","chatId":"c","startedAt":7}]"#;
        let read: Vec<Watch> = serde_json::from_str(old).unwrap();
        assert_eq!(read[0].source, "github.pr");
        assert_eq!(read[0].mode, "once");
        assert!(!read[0].paused);
        assert!(read[0].target.is_empty() && read[0].text.is_empty());
    }

    #[test]
    fn the_pull_request_is_read_from_the_rest_answer() {
        let v = json!({ "state": "closed", "merged": true, "draft": false, "mergeable": null, "mergeable_state": "unknown", "head": { "sha": "f00" } });
        let pr = PrState::from_pull(&v).unwrap();
        assert!(pr.merged && !pr.open);
        assert_eq!(pr.head_sha, "f00");
        assert!(PrState::from_pull(&json!({ "message": "Not Found" })).is_none());
    }
}
