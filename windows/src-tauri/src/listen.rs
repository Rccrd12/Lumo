// Listening: the chat waits for GitHub without holding a turn open. Claude
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

use crate::i18n::tf;
use crate::island::WINDOW_LABEL;
use crate::{log, platform, secrets};

/// What a watch can wait for on a pull request.
pub const UNTILS: &[&str] = &["checks", "green", "approved", "ready", "merged", "closed"];
/// Once: the watch ends when it fires. Every: it fires for each new commit.
pub const MODES: &[&str] = &["once", "every"];
/// What can listen every time: what happens again with each push.
pub const EVERY_UNTILS: &[&str] = &["checks", "green"];
/// Where a watch listens. Only GitHub's pull requests for now.
pub const SOURCES: &[&str] = &["github.pr"];
/// What fired, newest last, at most this many.
const MAX_HISTORY: usize = 50;
/// At most this many watches at once; the oldest goes for a new one.
const MAX_WATCHES: usize = 20;
/// A watch nobody needed for this long stops by itself, saying so.
const MAX_AGE_MS: u64 = 7 * 24 * 3_600_000;
/// Right after a push GitHub lists no checks yet: none counts as none only after this.
const NO_CHECKS_GRACE_MS: u64 = 3 * 60_000;
/// GitHub answering "not found" (or no access) this many times running ends the watch.
const MAX_MISSES: u32 = 3;
/// How often GitHub is asked, signed in or not (60 calls an hour without).
const EVERY_SIGNED_IN: Duration = Duration::from_secs(30);
const EVERY_ANONYMOUS: Duration = Duration::from_secs(120);
/// Without signing in GitHub answers 60 times an hour, and a look at the
/// checks asks 3 times: each watch adds this much, so it stays under that.
const ANONYMOUS_PER_WATCH: Duration = Duration::from_secs(240);
const TASK_CHARS: usize = 2000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Watch {
    pub id: u64,
    /// "owner/repo"
    pub repo: String,
    pub number: u64,
    /// One of UNTILS.
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
}

fn pull_requests() -> String {
    SOURCES[0].to_string()
}

fn once() -> String {
    MODES[0].to_string()
}

impl Watch {
    /// "owner/repo#12"
    pub fn label(&self) -> String {
        format!("{}#{}", self.repo, self.number)
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

#[derive(Default)]
struct Store {
    watches: Vec<Watch>,
    next_id: u64,
    /// "not found" answers running, per watch.
    misses: HashMap<u64, u32>,
    history: Vec<Past>,
    loaded: bool,
}

static STORE: LazyLock<Mutex<Store>> = LazyLock::new(|| Mutex::new(Store::default()));
static WAKE: LazyLock<Notify> = LazyLock::new(Notify::new);

fn file() -> PathBuf {
    platform::local_dir().join("listening.json")
}

fn history_file() -> PathBuf {
    platform::local_dir().join("listening-history.json")
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
        s.next_id = saved.iter().map(|w| w.id).max().unwrap_or(0) + 1;
        s.watches = saved.into_iter().filter(|w| valid(&w.repo, w.number, &w.until)).collect();
        s.history = std::fs::read_to_string(history_file())
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
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

/// Whether `mode` is one, and allowed for `until`.
pub fn mode_ok(until: &str, mode: &str) -> bool {
    mode == "once" || (mode == "every" && EVERY_UNTILS.contains(&until))
}

/// A repository and pull request we are willing to put in a GitHub URL.
pub fn valid(repo: &str, number: u64, until: &str) -> bool {
    let name_ok = |s: &str| !s.is_empty() && s.len() <= 100 && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    let repo_ok = matches!(repo.split_once('/'), Some((owner, name)) if name_ok(owner) && name_ok(name));
    repo_ok && (1..=1_000_000_000).contains(&number) && UNTILS.contains(&until)
}

/// Adds a watch (the same pull request and event again replaces the old one).
pub fn add(repo: &str, number: u64, until: &str, mode: &str, task: &str, chat_id: &str) -> Result<Watch, String> {
    let repo = repo.trim();
    let until = until.trim().to_ascii_lowercase();
    if !valid(repo, number, &until) {
        return Err(format!("not a pull request to listen to: {repo}#{number} {until}"));
    }
    let mode = match mode.trim().to_ascii_lowercase() {
        m if m.is_empty() => once(),
        m => m,
    };
    if !mode_ok(&until, &mode) {
        return Err(format!("only {} can listen every time", EVERY_UNTILS.join(" or ")));
    }
    let task: String = task.trim().chars().take(TASK_CHARS).collect();
    let chat_id: String = chat_id.chars().take(64).collect();
    let watch = with_store(|s| {
        s.watches.retain(|w| !(w.repo.eq_ignore_ascii_case(repo) && w.number == number && w.until == until));
        while s.watches.len() >= MAX_WATCHES {
            s.watches.remove(0);
        }
        let watch = Watch {
            id: s.next_id,
            repo: repo.to_string(),
            number,
            until,
            task,
            chat_id,
            started_at: now_ms(),
            source: pull_requests(),
            mode,
            paused: false,
            fired: 0,
            last_sha: String::new(),
        };
        s.next_id += 1;
        s.watches.push(watch.clone());
        save(&s.watches);
        watch
    });
    WAKE.notify_one();
    Ok(watch)
}

/// Stops listening to a pull request (`until` None: to every event on it).
pub fn cancel(repo: &str, number: u64, until: Option<&str>) -> usize {
    with_store(|s| {
        let before = s.watches.len();
        s.watches
            .retain(|w| !(w.repo.eq_ignore_ascii_case(repo.trim()) && w.number == number && until.is_none_or(|u| w.until == u)));
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
        save(&s.watches);
        before != s.watches.len()
    })
}

/// Pauses or resumes one watch (`id` None: every one). How many changed.
pub fn pause(id: Option<u64>, paused: bool) -> usize {
    let n = with_store(|s| {
        let mut n = 0;
        for w in s.watches.iter_mut().filter(|w| id.is_none_or(|id| w.id == id) && w.paused != paused) {
            w.paused = paused;
            n += 1;
        }
        save(&s.watches);
        n
    });
    if !paused {
        WAKE.notify_one();
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

/// The watch fired: taken out, or (listening every time on a pull request
/// still open) kept, waiting for the next commit. The watch as it fired, and
/// whether it ended.
fn take(id: u64, met: bool, summary: &str, again_on: Option<&str>) -> Option<(Watch, bool)> {
    with_store(|s| {
        let i = s.watches.iter().position(|w| w.id == id)?;
        s.misses.remove(&id);
        let ended = s.watches[i].mode != "every" || again_on.is_none();
        let watch = if ended {
            s.watches.remove(i)
        } else {
            let w = &mut s.watches[i];
            w.fired += 1;
            w.last_sha = again_on.unwrap_or("").to_string();
            w.clone()
        };
        remember(s, &watch, met, summary);
        save(&s.watches);
        Some((watch, ended))
    })
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
    let mut any = false;
    for run in runs.and_then(|r| r["check_runs"].as_array()).into_iter().flatten() {
        any = true;
        let name = run["name"].as_str().unwrap_or("check").to_string();
        if run["status"].as_str() != Some("completed") {
            pending = true;
            continue;
        }
        if matches!(run["conclusion"].as_str(), Some("failure" | "cancelled" | "timed_out" | "action_required" | "startup_failure")) {
            failed.push(name);
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

/// Whether the watch ends with this state of the pull request: (met, summary).
/// `age_ms`: how long it has listened, for the checks GitHub has not listed yet.
pub fn judge(w: &Watch, pr: &PrState, age_ms: u64) -> Option<(bool, String)> {
    let label = w.label();
    let pr_var = [("pr", label.as_str())];
    let failed_names = |names: &[String]| {
        let mut list = names.iter().take(4).cloned().collect::<Vec<_>>().join(", ");
        if names.len() > 4 {
            list.push_str(", …");
        }
        tf("Checks failed on {pr}: {checks}", &[("pr", &label), ("checks", &list)])
    };
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
        Checks::Failed(_) => Some(false),
        _ => None,
    };
    match w.until.as_str() {
        "checks" => match &pr.checks {
            Checks::Failed(names) => Some((true, failed_names(names))),
            c if settled(c) == Some(true) => Some((true, tf("Checks passed on {pr}", &pr_var))),
            _ => None,
        },
        "green" => match &pr.checks {
            Checks::Failed(names) => Some((false, failed_names(names))),
            c if settled(c) == Some(true) => Some((true, tf("Checks passed on {pr}", &pr_var))),
            _ => None,
        },
        "approved" => match pr.review {
            Review::Approved => Some((true, tf("{pr} was approved", &pr_var))),
            Review::ChangesRequested => Some((false, tf("Changes were requested on {pr}", &pr_var))),
            Review::None => None,
        },
        "ready" => {
            if let Checks::Failed(names) = &pr.checks {
                return Some((false, failed_names(names)));
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
    /// No connection, rate limit, `gh` not there…: ask again later.
    Unknown,
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
    match response.status().as_u16() {
        200..=299 => response.json().await.map(Answer::Found).unwrap_or(Answer::Unknown),
        // Rate limited: a 403 with nothing left.
        403 if response.headers().get("x-ratelimit-remaining").and_then(|v| v.to_str().ok()) == Some("0") => Answer::Unknown,
        401 | 403 | 404 => Answer::Missing,
        _ => Answer::Unknown,
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
    Unknown,
}

/// The pull request as it stands, with what `until` needs to know.
async fn fetch(via: Via, token: Option<&str>, w: &Watch) -> Read {
    let base = format!("repos/{}/pulls/{}", w.repo, w.number);
    let pull = match ask(via, token, base.clone()).await {
        Answer::Found(v) => v,
        Answer::Missing => return Read::Missing,
        Answer::Unknown => return Read::Unknown,
    };
    let Some(mut pr) = PrState::from_pull(&pull) else { return Read::Unknown };
    if pr.open && matches!(w.until.as_str(), "checks" | "green" | "ready") && !pr.head_sha.is_empty() {
        let commit = format!("repos/{}/commits/{}", w.repo, pr.head_sha);
        let runs = match ask(via, token, format!("{commit}/check-runs?per_page=100")).await {
            Answer::Found(v) => Some(v),
            _ => return Read::Unknown,
        };
        let status = match ask(via, token, format!("{commit}/status")).await {
            Answer::Found(v) => Some(v),
            _ => None,
        };
        pr.checks = checks_of(runs.as_ref(), status.as_ref());
    }
    if pr.open && w.until == "approved" {
        match ask(via, token, format!("{base}/reviews?per_page=100")).await {
            Answer::Found(v) => pr.review = review_of(Some(&v)),
            _ => return Read::Unknown,
        }
    }
    Read::State(pr)
}

/// `again_on`: the commit it fired on, when the pull request is still open
/// (a watch that listens every time goes on, waiting for the next one).
fn fire(app: &AppHandle, id: u64, met: bool, summary: String, again_on: Option<&str>) {
    if let Some((watch, ended)) = take(id, met, &summary, again_on) {
        let how = if met { "met" } else { "not met" };
        log::line(format!("listen: {} {} {} ({how})", watch.label(), watch.until, if ended { "ended" } else { "fired" }));
        let _ = app.emit_to(WINDOW_LABEL, "listen-fired", Fired { watch, met, summary, ended });
        changed(app);
    }
}

pub fn changed(app: &AppHandle) {
    let _ = app.emit_to(WINDOW_LABEL, "listen-changed", list());
}

/// One look at every watch.
async fn round(app: &AppHandle) -> Via {
    let (via, token) = via().await;
    let now = now_ms();
    for w in list() {
        let age = now.saturating_sub(w.started_at);
        if age >= MAX_AGE_MS {
            fire(app, w.id, false, tf("Stopped listening to {pr} after a week", &[("pr", &w.label())]), None);
            continue;
        }
        if w.paused {
            continue;
        }
        match fetch(via, token.as_deref(), &w).await {
            Read::State(pr) => {
                with_store(|s| s.misses.remove(&w.id));
                if let Some((met, summary)) = judge(&w, &pr, age) {
                    let again_on = (pr.open && !pr.head_sha.is_empty()).then_some(pr.head_sha.as_str());
                    fire(app, w.id, met, summary, again_on);
                }
            }
            Read::Missing => {
                let misses = with_store(|s| {
                    let n = s.misses.entry(w.id).or_insert(0);
                    *n += 1;
                    *n
                });
                if misses >= MAX_MISSES {
                    fire(app, w.id, false, tf("Lumo can't read {pr} on GitHub", &[("pr", &w.label())]), None);
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
    tauri::async_runtime::spawn(async move {
        // Watches kept from before a restart: say so to the island.
        changed(&app);
        loop {
            if list().iter().all(|w| w.paused) {
                WAKE.notified().await;
                continue;
            }
            let via = if crate::integrations::PAUSED.load(Ordering::Relaxed) { Via::Token } else { round(&app).await };
            let on = list().iter().filter(|w| !w.paused).count();
            let every = if via == Via::Anonymous { anonymous_every(on) } else { EVERY_SIGNED_IN };
            let _ = tokio::time::timeout(every, WAKE.notified()).await;
        }
    });
}

#[tauri::command(async)]
pub fn listen_add(app: AppHandle, repo: String, number: u64, until: String, mode: Option<String>, task: String, chat_id: String) -> Result<Watch, String> {
    let watch = add(&repo, number, &until, mode.as_deref().unwrap_or(""), &task, &chat_id)?;
    log::line(format!("listen: {} {} {}", watch.label(), watch.until, watch.mode));
    changed(&app);
    Ok(watch)
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
    use super::*;
    use serde_json::json;

    #[test]
    fn without_signing_in_it_stays_under_githubs_hourly_limit() {
        for n in 1..=MAX_WATCHES {
            let rounds_an_hour = 3600 / anonymous_every(n).as_secs() as usize;
            assert!(rounds_an_hour * n * 3 <= 60, "{n} watches");
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
        }
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
    }

    #[test]
    fn only_what_happens_again_with_each_push_can_listen_every_time() {
        assert!(mode_ok("checks", "every") && mode_ok("green", "every"));
        assert!(mode_ok("merged", "once") && mode_ok("ready", "once"));
        assert!(!mode_ok("merged", "every") && !mode_ok("ready", "every"));
        assert!(!mode_ok("checks", "always"));
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
    fn a_file_from_before_reads_as_once_on_a_pull_request() {
        let old = r#"[{"id":3,"repo":"o/r","number":5,"until":"ready","task":"merge","chatId":"c","startedAt":7}]"#;
        let read: Vec<Watch> = serde_json::from_str(old).unwrap();
        assert_eq!(read[0].source, "github.pr");
        assert_eq!(read[0].mode, "once");
        assert!(!read[0].paused);
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
