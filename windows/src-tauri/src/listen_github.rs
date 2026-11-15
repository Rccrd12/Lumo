// Listening to the rest of GitHub, besides a pull request's state (listen.rs):
// an issue or a repository's issues, a branch's commits and checks, a
// workflow's runs, the releases and tags, the deployments, the user's
// notifications, the security alerts, the discussions, the stars and forks;
// and, on a pull request, its new comments, reviews and commits.
//
// These are events, not states: each look asks GitHub what happened since the
// watch's cursor (`Watch::last_sha`), and a watch that listens every time
// moves the cursor to what it fired on. Most cursors are a time
// (`2026-11-15T19:00:00Z`, the way GitHub writes them, so two compare as
// text); with no cursor yet, the watch's start. What GitHub dates nowhere (a
// branch's head, the tags, the counts of stars) is first written down without
// firing, and what changes from it then fires.
//
// The watch is kept like one on this PC: `source` (SOURCES), `target` (the
// repository, `owner/repo@branch`, `owner/repo#12`, or `all` for the
// notifications), `text` (an issue's label, a workflow, an environment, a
// discussion's category; empty: any) and `amount` (the stars to reach).
// GitHub is asked as for a pull request: the GitHub pill's token, else `gh`,
// else without signing in (listen.rs `ask`), every 30 seconds signed in.
// What the user does themselves (their own comments, reviews, issues) never
// fires: it is no news to them.

use serde_json::{json, Value};

use crate::i18n::{n_, t, tf};
use crate::listen::{self, Answer, Checks, Via, Watch};

/// Where a watch listens on GitHub, besides a pull request's state.
pub const SOURCES: &[&str] = &[
    "github.issue",
    "github.branch",
    "github.workflow",
    "github.release",
    "github.deploy",
    "github.notifications",
    "github.security",
    "github.discussion",
    "github.stars",
];

/// What happens on a pull request, rather than what state it is in (listen.rs UNTILS has them too).
pub const PR_EVENTS: &[&str] = &["comment", "review", "changes", "commit"];

const ISSUE_UNTILS: &[&str] = &["opened", "comment", "labeled", "assigned", "closed", "reopened"];
const BRANCH_UNTILS: &[&str] = &["commit", "checks", "green", "red"];
const WORKFLOW_UNTILS: &[&str] = &["finished", "succeeded", "failed", "started"];
const RELEASE_UNTILS: &[&str] = &["release", "prerelease", "tag"];
const DEPLOY_UNTILS: &[&str] = &["started", "succeeded", "failed", "waiting"];
const NOTIFICATION_UNTILS: &[&str] = &["mention", "review_requested", "assign", "comment", "any"];
const SECURITY_UNTILS: &[&str] = &["dependabot", "code_scanning", "secret", "critical"];
const DISCUSSION_UNTILS: &[&str] = &["opened", "answer", "answered"];
const STAR_UNTILS: &[&str] = &["star", "fork", "stars", "watcher"];

/// The notifications on every repository.
pub const ALL: &str = "all";
const MAX_TEXT: usize = 100;
/// How much of a comment's words a summary carries.
const EXCERPT: usize = 140;
/// How many tags are kept as seen.
const TAGS_KEPT: usize = 30;

pub fn is_source(source: &str) -> bool {
    SOURCES.contains(&source)
}

pub fn untils(source: &str) -> &'static [&'static str] {
    match source {
        "github.issue" => ISSUE_UNTILS,
        "github.branch" => BRANCH_UNTILS,
        "github.workflow" => WORKFLOW_UNTILS,
        "github.release" => RELEASE_UNTILS,
        "github.deploy" => DEPLOY_UNTILS,
        "github.notifications" => NOTIFICATION_UNTILS,
        "github.security" => SECURITY_UNTILS,
        "github.discussion" => DISCUSSION_UNTILS,
        "github.stars" => STAR_UNTILS,
        _ => &[],
    }
}

/// The stars to reach, when the watch gives none, and the most it can be (listen_local::amount_of).
pub fn amount_of(source: &str, until: &str, amount: u32) -> Option<u32> {
    (source == "github.stars" && until == "stars").then(|| if amount == 0 { 100 } else { amount.min(100_000_000) })
}

/// Whether the watch takes `text` (a label, a workflow, an environment, a category).
pub fn takes_text(source: &str, until: &str) -> bool {
    match source {
        "github.issue" => matches!(until, "opened" | "labeled" | "assigned" | "closed" | "reopened"),
        "github.workflow" | "github.deploy" => true,
        "github.discussion" => until == "opened",
        _ => false,
    }
}

// ── What a watch names ────────────────────────────────────────────────────────

/// A GitHub name: an owner or a repository.
fn name_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// `owner/repo`, as GitHub's addresses take it.
pub fn repo_ok(repo: &str) -> bool {
    matches!(repo.split_once('/'), Some((owner, name)) if name_ok(owner) && name_ok(name))
}

/// A branch's name, as git takes it, that is safe in an address once encoded.
fn branch_ok(branch: &str) -> bool {
    !branch.is_empty()
        && branch.len() <= 200
        && !branch.contains("..")
        && !branch.starts_with(['/', '.', '-'])
        && !branch.ends_with(['/', '.'])
        && branch.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | '+'))
}

/// What a person writes for a repository, trimmed: a link, `owner/repo.git`.
fn bare(text: &str) -> &str {
    let text = text.trim().trim_start_matches('<').trim_end_matches('>');
    let text = text.split_once("://").map_or(text, |(_, rest)| rest);
    let text = text.strip_prefix("www.").unwrap_or(text);
    let text = text.strip_prefix("github.com/").unwrap_or(text);
    text.trim_end_matches('/')
}

/// `owner/repo`, from what was written; with `.git` or a link around it.
fn repo_of(text: &str) -> Option<String> {
    let text = bare(text);
    let mut parts = text.split('/');
    let (owner, name) = (parts.next()?, parts.next()?);
    let repo = format!("{owner}/{}", name.trim_end_matches(".git"));
    // Only owner/repo, or a link to it, or to its tree (`/tree/main`, read by branch_of).
    (repo_ok(&repo) && matches!(parts.next(), None | Some("tree" | "issues" | "actions" | "releases" | "discussions"))).then_some(repo)
}

/// `owner/repo@branch`, `owner/repo branch`, or a link to the branch (`…/tree/main`).
fn branch_of(text: &str) -> Option<(String, String)> {
    let text = bare(text);
    let (repo, branch) = if let Some((repo, branch)) = text.split_once('@') {
        (repo.trim().to_string(), branch.trim().to_string())
    } else if let Some((repo, branch)) = text.split_once(char::is_whitespace) {
        (repo.trim().to_string(), branch.trim().to_string())
    } else if let Some((repo, branch)) = text.split_once("/tree/") {
        (repo.to_string(), branch.to_string())
    } else {
        return None;
    };
    let repo = repo_of(&repo)?;
    let branch = branch.trim_start_matches("refs/heads/").to_string();
    branch_ok(&branch).then_some((repo, branch))
}

/// `owner/repo#12` or a link to the issue.
fn issue_of(text: &str) -> Option<(String, u64)> {
    let text = bare(text);
    let (repo, number) = if let Some((repo, number)) = text.split_once('#') {
        (repo.trim().to_string(), number.trim().to_string())
    } else {
        let parts: Vec<&str> = text.split('/').collect();
        match parts.as_slice() {
            [owner, name, "issues" | "pull" | "discussions", number, ..] => (format!("{owner}/{name}"), number.to_string()),
            _ => return None,
        }
    };
    let number: u64 = number.parse().ok().filter(|n| (1..=1_000_000_000).contains(n))?;
    repo_ok(&repo).then_some((repo, number))
}

/// The target as it is kept, or why it can't be listened to (listen_local::target asks it for these sources).
pub fn target(source: &str, until: &str, target: &str, text: &str) -> Result<String, String> {
    if text.chars().count() > MAX_TEXT || text.contains(['"', '[', ']', '\n', '\r']) {
        return Err(format!("Give the text as one line, at most {MAX_TEXT} characters, without quotes or brackets."));
    }
    let repo_wanted = || "Give the repository as owner/repository.".to_string();
    match source {
        "github.issue" => {
            if let Some((repo, number)) = issue_of(target) {
                if until == "opened" {
                    return Err("opened is for a repository: give owner/repository, without the issue's number.".into());
                }
                return Ok(format!("{repo}#{number}"));
            }
            repo_of(target).ok_or_else(|| "Give the repository as owner/repository, or one issue as owner/repository#12.".into())
        }
        "github.branch" => branch_of(target)
            .map(|(repo, branch)| format!("{repo}@{branch}"))
            .ok_or_else(|| "Give the branch as owner/repository@branch, like Rccrd12/Lumo@main.".into()),
        "github.workflow" => {
            if let Some((repo, branch)) = branch_of(target) {
                return Ok(format!("{repo}@{branch}"));
            }
            repo_of(target).ok_or_else(|| "Give the repository as owner/repository, or owner/repository@branch for one branch.".into())
        }
        "github.notifications" => {
            let given = target.trim();
            if given.is_empty() || given.eq_ignore_ascii_case(ALL) || given == "*" {
                return Ok(ALL.to_string());
            }
            repo_of(given).ok_or_else(|| "Give the repository as owner/repository, or all for every repository.".into())
        }
        "github.release" | "github.deploy" | "github.security" | "github.discussion" | "github.stars" => repo_of(target).ok_or_else(repo_wanted),
        _ => Err(format!("source must be one of {}.", SOURCES.join(", "))),
    }
}

/// The repository a watch is on (`all` for the notifications on every one).
pub fn repo(target: &str) -> &str {
    target.split(['@', '#']).next().unwrap_or(target)
}

fn branch(target: &str) -> Option<&str> {
    target.split_once('@').map(|(_, b)| b)
}

fn issue_number(target: &str) -> Option<u64> {
    target.split_once('#').and_then(|(_, n)| n.parse().ok())
}

/// How a watch is called: `Rccrd12/Lumo · main`, `Windows beta · main`, `Issues · Rccrd12/Lumo`…
pub fn label(source: &str, target: &str, text: &str) -> String {
    let repo = repo(target);
    let kind = |key: &str, what: &str| format!("{} · {what}", t(key));
    match source {
        "github.issue" if issue_number(target).is_some() => target.to_string(),
        "github.issue" => kind("Issues", repo),
        "github.branch" => target.replace('@', " · "),
        "github.workflow" => {
            let name = if text.is_empty() { t("Workflow") } else { text.to_string() };
            format!("{name} · {}", branch(target).unwrap_or(repo))
        }
        "github.release" => kind("Releases", repo),
        "github.deploy" => kind("Deploys", if text.is_empty() { repo } else { text }),
        "github.notifications" if target == ALL => t("Notifications"),
        "github.notifications" => kind("Notifications", repo),
        "github.security" => kind("Security", repo),
        "github.discussion" => kind("Discussions", repo),
        "github.stars" => kind("Stars", repo),
        _ => target.to_string(),
    }
}

/// Puts a branch's name (or an environment's, a label's) in an address.
fn encode(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

// ── Times ─────────────────────────────────────────────────────────────────────

/// Unix ms as GitHub writes a time: `2026-11-15T19:00:00Z`.
pub fn iso(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Days since 1970-01-01 to a civil date (Howard Hinnant's days_from_civil, backwards).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

/// What the watch fires after: its cursor, or its start.
pub fn since(w: &Watch) -> String {
    if w.last_sha.len() == 20 && w.last_sha.ends_with('Z') {
        w.last_sha.clone()
    } else {
        iso(w.started_at)
    }
}

/// A time GitHub wrote, cut to the second, to compare with a cursor.
fn time(v: &Value) -> &str {
    let s = v.as_str().unwrap_or("");
    // `2026-11-15T19:00:00.123Z` (GraphQL) and `2026-11-15T19:00:00Z` compare alike.
    if s.len() > 20 && s.as_bytes()[19] == b'.' {
        &s[..19]
    } else {
        s.strip_suffix('Z').unwrap_or(s)
    }
}

/// Whether GitHub's time `at` is after the cursor (both as GitHub writes them).
fn after(at: &Value, cursor: &str) -> bool {
    let at = time(at);
    !at.is_empty() && at > cursor.strip_suffix('Z').unwrap_or(cursor)
}

/// The cursor a time GitHub wrote moves to.
fn cursor_at(at: &Value) -> String {
    format!("{}Z", time(at))
}

// ── What happened ─────────────────────────────────────────────────────────────

/// What a look found.
#[derive(Debug, PartialEq)]
pub enum Look {
    /// It happened (`met`), or what it waited for can no longer (`!met`).
    /// `cursor`: where a watch that listens every time goes on from; None: it is over.
    Fire { met: bool, summary: String, cursor: Option<String> },
    /// Nothing yet; `Some`: the cursor to keep (what was there at the first look).
    Hold(Option<String>),
    Missing,
    Unauthorized,
    Unknown,
}

fn fire(met: bool, summary: String, cursor: impl Into<Option<String>>) -> Look {
    Look::Fire { met, summary, cursor: cursor.into() }
}

/// A comment's first words, on one line.
fn excerpt(text: &str) -> String {
    let one = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() > EXCERPT {
        one.chars().take(EXCERPT - 1).collect::<String>() + "…"
    } else {
        one
    }
}

fn login(v: &Value) -> &str {
    v["login"].as_str().unwrap_or("")
}

/// Someone other than the user (`me`, when it is known).
fn other(who: &str, me: Option<&str>) -> bool {
    me.is_none_or(|me| !who.eq_ignore_ascii_case(me))
}

/// The newest of what happened after the cursor (`items`: (time, summary)),
/// with how many more there were.
fn newest(mut items: Vec<(String, String)>) -> Option<(String, String)> {
    items.sort_by(|a, b| b.0.cmp(&a.0));
    let more = items.len().saturating_sub(1);
    let (at, summary) = items.into_iter().next()?;
    let summary = if more > 0 { tf("{summary} (and {count} more)", &[("summary", &summary), ("count", &more.to_string())]) } else { summary };
    Some((at, summary))
}

/// The newest item that happened fires; nothing new: hold.
fn fire_newest(items: Vec<(String, String)>) -> Look {
    match newest(items) {
        Some((at, summary)) => fire(true, summary, at),
        None => Look::Hold(None),
    }
}

/// A pull request's new comments (on the conversation and on the code).
pub fn pr_comments(what: &str, cursor: &str, issue: &Value, review: &Value, me: Option<&str>) -> Look {
    let items = [issue, review]
        .iter()
        .flat_map(|list| list.as_array().into_iter().flatten())
        .filter(|c| after(&c["created_at"], cursor) && other(login(&c["user"]), me))
        .map(|c| {
            let vars = [("what", what), ("who", login(&c["user"])), ("text", &excerpt(c["body"].as_str().unwrap_or("")))];
            (cursor_at(&c["created_at"]), tf("New comment on {what} from {who}: {text}", &vars))
        })
        .collect();
    fire_newest(items)
}

/// A pull request's new reviews (`changes_only`: only those that ask for changes).
pub fn pr_reviews(what: &str, cursor: &str, reviews: &Value, changes_only: bool, me: Option<&str>) -> Look {
    let items = reviews
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| after(&r["submitted_at"], cursor) && other(login(&r["user"]), me))
        .filter_map(|r| {
            let state = r["state"].as_str().unwrap_or("");
            let vars = [("what", what), ("who", login(&r["user"]))];
            let summary = match state {
                "CHANGES_REQUESTED" => tf("{who} asked for changes on {what}", &vars),
                _ if changes_only => return None,
                "APPROVED" => tf("{who} approved {what}", &vars),
                "COMMENTED" | "DISMISSED" => tf("{who} reviewed {what}", &vars),
                _ => return None,
            };
            Some((cursor_at(&r["submitted_at"]), summary))
        })
        .collect();
    fire_newest(items)
}

/// A new head commit on a branch or a pull request, against the one seen (`cursor`).
pub fn new_commit(what: &str, cursor: &str, sha: &str, message: &str) -> Look {
    if sha.is_empty() {
        return Look::Unknown;
    }
    if cursor.is_empty() {
        return Look::Hold(Some(sha.to_string()));
    }
    if cursor == sha {
        return Look::Hold(None);
    }
    let first = message.lines().next().unwrap_or("").trim();
    let text = if first.is_empty() { sha.chars().take(7).collect() } else { excerpt(first) };
    fire(true, tf("New commit on {what}: {text}", &[("what", what), ("text", &text)]), sha.to_string())
}

/// The checks of a branch's newest commit (`age_ms`: how long it has been the newest, as listen.rs head_age).
pub fn branch_checks(w: &Watch, sha: &str, checks: &Checks, age_ms: u64) -> Look {
    if w.mode == "every" && w.last_sha == sha {
        return Look::Hold(None);
    }
    let label = w.label();
    let failed = |names: &[String]| {
        let mut list = names.iter().take(4).cloned().collect::<Vec<_>>().join(", ");
        if names.len() > 4 {
            list.push_str(", …");
        }
        tf("Checks failed on {pr}: {checks}", &[("pr", &label), ("checks", &list)])
    };
    let passed = || tf("Checks passed on {pr}", &[("pr", &label)]);
    let done = match checks {
        Checks::Failed(names) => Some(Err(names.clone())),
        Checks::Passed => Some(Ok(())),
        Checks::None if age_ms >= listen::NO_CHECKS_GRACE_MS => Some(Ok(())),
        _ => None,
    };
    let sha = sha.to_string();
    match (w.until.as_str(), done) {
        (_, None) => Look::Hold(None),
        ("checks", Some(Ok(()))) => fire(true, passed(), sha),
        ("checks", Some(Err(names))) => fire(true, failed(&names), sha),
        ("green", Some(Ok(()))) => fire(true, passed(), sha),
        ("green", Some(Err(names))) => fire(false, failed(&names), sha),
        ("red", Some(Err(names))) => fire(true, failed(&names), sha),
        // Waiting for a failure, a commit that passed is done with, quietly.
        ("red", Some(Ok(()))) => Look::Hold(Some(sha)),
        _ => Look::Hold(None),
    }
}

/// Whether a workflow run is the one the watch names (`name`: its name or its file; empty: any).
fn workflow_named(run: &Value, name: &str) -> bool {
    if name.is_empty() {
        return true;
    }
    let path = run["path"].as_str().unwrap_or("");
    let file = path.rsplit('/').next().unwrap_or(path);
    let stem = file.rsplit_once('.').map_or(file, |(s, _)| s);
    run["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)) || file.eq_ignore_ascii_case(name) || stem.eq_ignore_ascii_case(name)
}

/// A workflow's runs (`GET /repos/{repo}/actions/runs`, newest first).
pub fn workflow_runs(w: &Watch, cursor: &str, runs: &Value) -> Look {
    let runs: Vec<&Value> = runs["workflow_runs"].as_array().into_iter().flatten().filter(|r| workflow_named(r, &w.text)).collect();
    let summary = |r: &Value, key: &str| {
        let name = r["name"].as_str().unwrap_or("workflow");
        let place = r["head_branch"].as_str().filter(|b| !b.is_empty()).unwrap_or(repo(&w.target));
        let conclusion = r["conclusion"].as_str().unwrap_or("");
        tf(key, &[("workflow", name), ("where", place), ("conclusion", conclusion)])
    };
    if w.until == "started" {
        let items = runs.iter().filter(|r| after(&r["created_at"], cursor)).map(|r| (cursor_at(&r["created_at"]), summary(r, n_("{workflow} started on {where}")))).collect();
        return fire_newest(items);
    }
    // Ended since the cursor; a run cancelled or skipped (superseded by a newer push) is no news.
    let mut ended: Vec<&&Value> = runs
        .iter()
        .filter(|r| r["status"].as_str() == Some("completed") && after(&r["updated_at"], cursor))
        .filter(|r| !matches!(r["conclusion"].as_str(), Some("cancelled" | "skipped" | "stale" | "neutral")) || w.until == "finished")
        .collect();
    ended.sort_by(|a, b| time(&b["updated_at"]).cmp(time(&a["updated_at"])));
    for r in ended {
        let ok = r["conclusion"].as_str() == Some("success");
        let failed = matches!(r["conclusion"].as_str(), Some("failure" | "timed_out" | "startup_failure" | "action_required"));
        let at = cursor_at(&r["updated_at"]);
        let said = if ok {
            summary(r, n_("{workflow} succeeded on {where}"))
        } else if failed {
            summary(r, n_("{workflow} failed on {where}"))
        } else {
            summary(r, n_("{workflow} ended on {where}: {conclusion}"))
        };
        match w.until.as_str() {
            "finished" => return fire(true, said, at),
            "succeeded" if ok => return fire(true, said, at),
            "failed" if failed => return fire(true, said, at),
            // Listening once, the other way it can end ends the wait.
            "succeeded" | "failed" if w.mode != "every" => return fire(false, said, at),
            _ => {}
        }
    }
    Look::Hold(None)
}

/// The releases (`GET /repos/{repo}/releases`): a new one published, or a new pre-release.
pub fn releases(w: &Watch, cursor: &str, list: &Value) -> Look {
    let pre = w.until == "prerelease";
    let repo = repo(&w.target);
    let items = list
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| !r["draft"].as_bool().unwrap_or(false) && r["prerelease"].as_bool().unwrap_or(false) == pre && after(&r["published_at"], cursor))
        .map(|r| {
            let name = r["name"].as_str().filter(|n| !n.trim().is_empty()).or(r["tag_name"].as_str()).unwrap_or("");
            let key = if pre { n_("New pre-release {name} in {repo}") } else { n_("New release {name} in {repo}") };
            (cursor_at(&r["published_at"]), tf(key, &[("name", name), ("repo", repo)]))
        })
        .collect();
    fire_newest(items)
}

/// The tags (`GET /repos/{repo}/tags`): the names seen are the cursor, one a line.
pub fn tags(w: &Watch, list: &Value) -> Look {
    let names: Vec<&str> = list.as_array().into_iter().flatten().filter_map(|t| t["name"].as_str()).take(TAGS_KEPT).collect();
    let print = names.join("\n");
    if w.last_sha.is_empty() {
        return Look::Hold(Some(print));
    }
    let seen: Vec<&str> = w.last_sha.lines().collect();
    let fresh: Vec<&&str> = names.iter().filter(|n| !seen.contains(n)).collect();
    let Some(first) = fresh.first() else {
        return if print != w.last_sha && !names.is_empty() { Look::Hold(Some(print)) } else { Look::Hold(None) };
    };
    let mut summary = tf("New tag {name} in {repo}", &[("name", first), ("repo", repo(&w.target))]);
    if fresh.len() > 1 {
        summary = tf("{summary} (and {count} more)", &[("summary", &summary), ("count", &(fresh.len() - 1).to_string())]);
    }
    fire(true, summary, print)
}

/// The deployments (`GET /repos/{repo}/deployments`, newest first) and, for
/// the ones that may have ended, their newest status (`statuses`, by id).
pub fn deployments(w: &Watch, cursor: &str, list: &Value, statuses: &[(u64, Value)]) -> Look {
    let env = |d: &Value| d["environment"].as_str().unwrap_or("").to_string();
    let named = |d: &&Value| w.text.is_empty() || env(d).eq_ignore_ascii_case(&w.text);
    let all: Vec<&Value> = list.as_array().into_iter().flatten().filter(named).collect();
    if w.until == "started" {
        let items = all
            .iter()
            .filter(|d| after(&d["created_at"], cursor))
            .map(|d| (cursor_at(&d["created_at"]), tf("Deploy to {env} started", &[("env", &env(d))])))
            .collect();
        return fire_newest(items);
    }
    let mut ended: Vec<(String, bool, String)> = Vec::new();
    for d in &all {
        let id = d["id"].as_u64().unwrap_or(0);
        let Some((_, status)) = statuses.iter().find(|(sid, _)| *sid == id) else { continue };
        let Some(newest) = status.as_array().and_then(|s| s.first()) else { continue };
        if !after(&newest["created_at"], cursor) {
            continue;
        }
        match newest["state"].as_str() {
            Some("success") => ended.push((cursor_at(&newest["created_at"]), true, tf("Deploy to {env} succeeded", &[("env", &env(d))]))),
            Some("failure" | "error") => ended.push((cursor_at(&newest["created_at"]), false, tf("Deploy to {env} failed", &[("env", &env(d))]))),
            _ => {}
        }
    }
    ended.sort_by(|a, b| b.0.cmp(&a.0));
    for (at, ok, said) in ended {
        match (w.until.as_str(), ok) {
            ("succeeded", true) | ("failed", false) => return fire(true, said, at),
            ("succeeded" | "failed", _) if w.mode != "every" => return fire(false, said, at),
            _ => {}
        }
    }
    Look::Hold(None)
}

/// The Actions runs waiting for someone to approve a deployment (`GET …/actions/runs?status=waiting`).
pub fn waiting(w: &Watch, cursor: &str, runs: &Value) -> Look {
    let env = if w.text.is_empty() { repo(&w.target).to_string() } else { w.text.clone() };
    let items = runs["workflow_runs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| after(&r["updated_at"], cursor))
        .map(|r| (cursor_at(&r["updated_at"]), tf("Deploy to {env} waits for approval", &[("env", &env)])))
        .collect();
    fire_newest(items)
}

/// The user's notifications (`GET /notifications`), by why they came.
pub fn notifications(w: &Watch, cursor: &str, list: &Value) -> Look {
    let items = list
        .as_array()
        .into_iter()
        .flatten()
        .filter(|n| after(&n["updated_at"], cursor))
        .filter_map(|n| {
            let reason = n["reason"].as_str().unwrap_or("");
            let key = match (w.until.as_str(), reason) {
                ("mention" | "any", "mention" | "team_mention") => n_("You were mentioned: {title} ({repo})"),
                ("review_requested" | "any", "review_requested") => n_("Your review was requested: {title} ({repo})"),
                ("assign" | "any", "assign") => n_("Assigned to you: {title} ({repo})"),
                ("comment", "comment" | "author" | "state_change") | ("any", _) => n_("New on GitHub: {title} ({repo})"),
                _ => return None,
            };
            let vars = [("title", n["subject"]["title"].as_str().unwrap_or("")), ("repo", n["repository"]["full_name"].as_str().unwrap_or(""))];
            Some((cursor_at(&n["updated_at"]), tf(key, &vars)))
        })
        .collect();
    fire_newest(items)
}

/// A repository's security alerts (Dependabot, code scanning, secret scanning), newest first.
pub fn alerts(w: &Watch, cursor: &str, kind: &str, list: &Value) -> Look {
    let repo = repo(&w.target);
    let items = list
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| after(&a["created_at"], cursor))
        .map(|a| {
            let title = match kind {
                "dependabot" => a["security_advisory"]["summary"].as_str(),
                "code_scanning" => a["rule"]["description"].as_str().or(a["rule"]["name"].as_str()),
                _ => a["secret_type_display_name"].as_str().or(a["secret_type"].as_str()),
            }
            .unwrap_or("");
            let key = match (w.until.as_str(), kind) {
                ("critical", _) => n_("Critical alert in {repo}: {title}"),
                (_, "dependabot") => n_("Dependabot alert in {repo}: {title}"),
                (_, "code_scanning") => n_("Code scanning alert in {repo}: {title}"),
                _ => n_("Secret found in {repo}: {title}"),
            };
            (cursor_at(&a["created_at"]), tf(key, &[("repo", repo), ("title", &excerpt(title))]))
        })
        .collect();
    fire_newest(items)
}

/// The discussions (GraphQL, the most recently updated first).
pub fn discussions(w: &Watch, cursor: &str, data: &Value, me: Option<&str>) -> Look {
    let repo = repo(&w.target);
    let nodes = data["data"]["repository"]["discussions"]["nodes"].as_array().cloned().unwrap_or_default();
    let items = nodes
        .iter()
        .filter_map(|d| {
            let title = d["title"].as_str().unwrap_or("");
            let vars = [("repo", repo), ("title", title)];
            match w.until.as_str() {
                "opened" => {
                    let category_ok = w.text.is_empty() || d["category"]["name"].as_str().is_some_and(|c| c.eq_ignore_ascii_case(&w.text));
                    (category_ok && after(&d["createdAt"], cursor) && other(login(&d["author"]), me))
                        .then(|| (cursor_at(&d["createdAt"]), tf("New discussion in {repo}: {title}", &vars)))
                }
                "answer" => {
                    let last = &d["comments"]["nodes"][0];
                    (after(&last["createdAt"], cursor) && other(login(&last["author"]), me))
                        .then(|| (cursor_at(&last["createdAt"]), tf("New answer in {repo}: {title}", &vars)))
                }
                _ => after(&d["answerChosenAt"], cursor).then(|| (cursor_at(&d["answerChosenAt"]), tf("Answer marked in {repo}: {title}", &vars))),
            }
        })
        .collect();
    fire_newest(items)
}

/// The repository's counts (`GET /repos/{repo}`): a new star, fork or
/// watcher against the count seen (the cursor), or a number of stars reached.
pub fn counts(w: &Watch, v: &Value) -> Look {
    let repo = repo(&w.target);
    let field = match w.until.as_str() {
        "fork" => "forks_count",
        "watcher" => "subscribers_count",
        _ => "stargazers_count",
    };
    let Some(count) = v[field].as_u64() else { return Look::Unknown };
    let vars = [("repo", repo), ("count", &count.to_string())];
    if w.until == "stars" {
        return if count >= u64::from(w.amount.max(1)) { fire(true, tf("{repo} reached {count} stars", &vars), None) } else { Look::Hold(None) };
    }
    let Ok(before) = w.last_sha.parse::<u64>() else { return Look::Hold(Some(count.to_string())) };
    if count <= before {
        // One taken back: the count to beat is the new one.
        return if count < before { Look::Hold(Some(count.to_string())) } else { Look::Hold(None) };
    }
    let key = match w.until.as_str() {
        "fork" => n_("{repo} was forked ({count})"),
        "watcher" => n_("{repo} has a new watcher ({count})"),
        _ => n_("{repo} has a new star ({count})"),
    };
    fire(true, tf(key, &vars), count.to_string())
}

/// An issue's (or a repository's issues') new issues, comments and events.
pub fn issues(w: &Watch, cursor: &str, list: &Value, me: Option<&str>) -> Look {
    let repo = repo(&w.target).to_string();
    let single = issue_number(&w.target);
    let labelled = |issue: &Value| {
        w.text.is_empty() || issue["labels"].as_array().into_iter().flatten().any(|l| l["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(&w.text)))
    };
    let what_of = |issue: &Value| match single {
        Some(n) => format!("{repo}#{n}"),
        None => format!("{repo}#{}", issue["number"].as_u64().unwrap_or(0)),
    };
    let items: Vec<(String, String)> = match w.until.as_str() {
        "opened" => list
            .as_array()
            .into_iter()
            .flatten()
            .filter(|i| i.get("pull_request").is_none() && after(&i["created_at"], cursor) && other(login(&i["user"]), me) && labelled(i))
            .map(|i| {
                let vars = [("what", what_of(i)), ("title", i["title"].as_str().unwrap_or("").to_string())];
                let vars: Vec<(&str, &str)> = vars.iter().map(|(k, v)| (*k, v.as_str())).collect();
                (cursor_at(&i["created_at"]), tf("New issue {what}: {title}", &vars))
            })
            .collect(),
        "comment" => list
            .as_array()
            .into_iter()
            .flatten()
            // A repository's comments hold the pull requests' too: only the issues'.
            .filter(|c| single.is_some() || c["html_url"].as_str().is_some_and(|u| u.contains("/issues/")))
            .filter(|c| after(&c["created_at"], cursor) && other(login(&c["user"]), me))
            .map(|c| {
                let number = c["issue_url"].as_str().and_then(|u| u.rsplit('/').next()).unwrap_or("");
                let what = single.map_or_else(|| format!("{repo}#{number}"), |n| format!("{repo}#{n}"));
                let text = excerpt(c["body"].as_str().unwrap_or(""));
                (cursor_at(&c["created_at"]), tf("New comment on {what} from {who}: {text}", &[("what", &what), ("who", login(&c["user"])), ("text", &text)]))
            })
            .collect(),
        until => list
            .as_array()
            .into_iter()
            .flatten()
            .filter(|e| e["event"].as_str() == Some(until) && after(&e["created_at"], cursor) && other(login(&e["actor"]), me))
            // A repository's events hold the pull requests' too: only the issues'.
            .filter(|e| single.is_some() || (e["issue"].is_object() && e["issue"].get("pull_request").is_none()))
            .filter(|e| match until {
                "labeled" => w.text.is_empty() || e["label"]["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(&w.text)),
                _ => single.is_some() || labelled(&e["issue"]),
            })
            .map(|e| {
                let what = what_of(&e["issue"]);
                let summary = match until {
                    "labeled" => tf("{what} got the label {label}", &[("what", &what), ("label", e["label"]["name"].as_str().unwrap_or(""))]),
                    "assigned" => tf("{what} was assigned to {who}", &[("what", &what), ("who", login(&e["assignee"]))]),
                    "reopened" => tf("{what} was reopened", &[("what", &what)]),
                    _ => tf("{what} was closed", &[("what", &what)]),
                };
                (cursor_at(&e["created_at"]), summary)
            })
            .collect(),
    };
    fire_newest(items)
}

// ── Asking GitHub ─────────────────────────────────────────────────────────────

/// How one round asks GitHub, and who the user is there (asked once, when needed).
pub struct Asker {
    pub via: Via,
    pub token: Option<String>,
    me: tokio::sync::OnceCell<Option<String>>,
}

impl Asker {
    pub fn new(via: Via, token: Option<String>) -> Self {
        Asker { via, token, me: tokio::sync::OnceCell::new() }
    }

    async fn get(&self, path: String) -> Answer {
        listen::ask(self.via, self.token.as_deref(), path).await
    }

    /// The user's own login, so what they do themselves fires nothing.
    async fn me(&self) -> Option<String> {
        self.me
            .get_or_init(|| async {
                if self.via == Via::Anonymous {
                    return None;
                }
                match self.get("user".into()).await {
                    Answer::Found(v) => v["login"].as_str().map(str::to_string),
                    _ => None,
                }
            })
            .await
            .clone()
    }

    /// The notifications: a fine-grained token gets none, so `gh` is asked then.
    async fn notifications(&self, path: String) -> Answer {
        let got = self.get(path.clone()).await;
        if self.via == Via::Token && matches!(got, Answer::Missing | Answer::Unauthorized) {
            if let Answer::Found(v) = listen::gh(path).await {
                return Answer::Found(v);
            }
        }
        got
    }

    /// A GraphQL query (only signed in: GitHub answers none without).
    async fn graphql(&self, query: &str, vars: &[(&str, &str)]) -> Answer {
        match self.via {
            Via::Anonymous => Answer::Missing,
            Via::Gh => {
                let mut args = vec!["api".to_string(), "graphql".into(), "-f".into(), format!("query={query}")];
                for (k, v) in vars {
                    args.push("-f".into());
                    args.push(format!("{k}={v}"));
                }
                graphql_answer(listen::gh_args(args).await)
            }
            Via::Token => {
                let body = json!({ "query": query, "variables": vars.iter().map(|(k, v)| (k.to_string(), json!(v))).collect::<serde_json::Map<_, _>>() });
                graphql_answer(listen::post(self.token.as_deref(), "graphql", &body).await)
            }
        }
    }
}

/// GraphQL answers 200 with its errors inside: a repository it can't see is missing.
fn graphql_answer(got: Answer) -> Answer {
    match got {
        Answer::Found(v) if v["data"]["repository"].is_object() => Answer::Found(v),
        Answer::Found(v) if v["errors"].is_array() => Answer::Missing,
        Answer::Found(_) => Answer::Unknown,
        other => other,
    }
}

const DISCUSSIONS: &str = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){discussions(first:20,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title createdAt answerChosenAt author{login} category{name} comments(last:1){nodes{createdAt author{login}}}}}}}";

/// `Look` from an answer, when the answer is all that is needed.
macro_rules! found {
    ($answer:expr) => {
        match $answer {
            Answer::Found(v) => v,
            Answer::Missing => return Look::Missing,
            Answer::Unauthorized => return Look::Unauthorized,
            Answer::Unknown => return Look::Unknown,
        }
    };
}

/// One look at a watch on GitHub's events (`age`: how long a commit has been
/// a branch's newest, as listen.rs head_age keeps it).
pub async fn look(ask: &Asker, w: &Watch, age: impl Fn(&str) -> u64) -> Look {
    let cursor = since(w);
    let repo = repo(&w.target).to_string();
    match w.source.as_str() {
        "github.pr" => {
            let what = w.label();
            let base = format!("repos/{}/pulls/{}", w.repo, w.number);
            let pull = found!(ask.get(base.clone()).await);
            let Some(pr) = listen::PrState::from_pull(&pull) else { return Look::Unknown };
            if pr.merged {
                return fire(false, tf("{pr} was merged", &[("pr", &what)]), None);
            }
            if !pr.open {
                return fire(false, tf("{pr} was closed without being merged", &[("pr", &what)]), None);
            }
            let me = ask.me().await;
            match w.until.as_str() {
                "commit" => {
                    let message = if !w.last_sha.is_empty() && w.last_sha != pr.head_sha {
                        match ask.get(format!("repos/{}/commits/{}", w.repo, pr.head_sha)).await {
                            Answer::Found(c) => c["commit"]["message"].as_str().unwrap_or("").to_string(),
                            _ => String::new(),
                        }
                    } else {
                        String::new()
                    };
                    new_commit(&what, &w.last_sha, &pr.head_sha, &message)
                }
                "comment" => {
                    let on_issue = found!(ask.get(format!("repos/{}/issues/{}/comments?since={cursor}&per_page=100", w.repo, w.number)).await);
                    let on_code = found!(ask.get(format!("{base}/comments?since={cursor}&per_page=100")).await);
                    pr_comments(&what, &cursor, &on_issue, &on_code, me.as_deref())
                }
                _ => {
                    let reviews = found!(ask.get(format!("{base}/reviews?per_page=100")).await);
                    pr_reviews(&what, &cursor, &reviews, w.until == "changes", me.as_deref())
                }
            }
        }
        "github.issue" => {
            let me = ask.me().await;
            let path = match (issue_number(&w.target), w.until.as_str()) {
                (_, "opened") => {
                    let labels = if w.text.is_empty() { String::new() } else { format!("&labels={}", encode(&w.text)) };
                    format!("repos/{repo}/issues?state=all&sort=created&direction=desc&per_page=30{labels}")
                }
                (Some(n), "comment") => format!("repos/{repo}/issues/{n}/comments?since={cursor}&per_page=100"),
                (None, "comment") => format!("repos/{repo}/issues/comments?sort=created&direction=desc&since={cursor}&per_page=50"),
                (Some(n), _) => format!("repos/{repo}/issues/{n}/events?per_page=100"),
                (None, _) => format!("repos/{repo}/issues/events?per_page=50"),
            };
            let list = found!(ask.get(path).await);
            issues(w, &cursor, &list, me.as_deref())
        }
        "github.branch" => {
            let branch = branch(&w.target).unwrap_or("main");
            let head = found!(ask.get(format!("repos/{repo}/commits/{}", encode(branch))).await);
            let sha = head["sha"].as_str().unwrap_or("").to_string();
            if sha.is_empty() {
                return Look::Unknown;
            }
            if w.until == "commit" {
                return new_commit(&w.label(), &w.last_sha, &sha, head["commit"]["message"].as_str().unwrap_or(""));
            }
            if w.mode == "every" && w.last_sha == sha {
                return Look::Hold(None);
            }
            let commit = format!("repos/{repo}/commits/{sha}");
            let runs = found!(ask.get(format!("{commit}/check-runs?per_page=100")).await);
            let status = match ask.get(format!("{commit}/status")).await {
                Answer::Found(v) => Some(v),
                _ => None,
            };
            let mut checks = listen::checks_of(Some(&runs), status.as_ref());
            if checks == Checks::None {
                match ask.get(format!("repos/{repo}/actions/runs?head_sha={sha}&per_page=100")).await {
                    Answer::Found(v) => checks = listen::actions_of(Checks::None, Some(&v)),
                    Answer::Missing => {}
                    Answer::Unauthorized => return Look::Unauthorized,
                    Answer::Unknown => return Look::Unknown,
                }
            }
            branch_checks(w, &sha, &checks, age(&sha))
        }
        "github.workflow" => {
            let on_branch = branch(&w.target).map(|b| format!("&branch={}", encode(b))).unwrap_or_default();
            let runs = found!(ask.get(format!("repos/{repo}/actions/runs?per_page=30{on_branch}")).await);
            workflow_runs(w, &cursor, &runs)
        }
        "github.release" if w.until == "tag" => tags(w, &found!(ask.get(format!("repos/{repo}/tags?per_page={TAGS_KEPT}")).await)),
        "github.release" => releases(w, &cursor, &found!(ask.get(format!("repos/{repo}/releases?per_page=10")).await)),
        "github.deploy" if w.until == "waiting" => {
            let runs = found!(ask.get(format!("repos/{repo}/actions/runs?status=waiting&per_page=10")).await);
            waiting(w, &cursor, &runs)
        }
        "github.deploy" => {
            let env = if w.text.is_empty() { String::new() } else { format!("&environment={}", encode(&w.text)) };
            let list = found!(ask.get(format!("repos/{repo}/deployments?per_page=5{env}")).await);
            let mut statuses = Vec::new();
            if w.until != "started" {
                // Only the newest few, and only those still changing since the cursor.
                for d in list.as_array().into_iter().flatten().take(3) {
                    let Some(id) = d["id"].as_u64() else { continue };
                    if let Answer::Found(s) = ask.get(format!("repos/{repo}/deployments/{id}/statuses?per_page=1")).await {
                        statuses.push((id, s));
                    }
                }
            }
            deployments(w, &cursor, &list, &statuses)
        }
        "github.notifications" => {
            let path = if w.target == ALL { "notifications".to_string() } else { format!("repos/{repo}/notifications") };
            let list = found!(ask.notifications(format!("{path}?since={cursor}&per_page=50")).await);
            notifications(w, &cursor, &list)
        }
        "github.security" => {
            let open = "state=open&sort=created&direction=desc&per_page=20";
            let kinds: &[(&str, &str)] = match w.until.as_str() {
                "dependabot" => &[("dependabot", "dependabot/alerts")],
                "code_scanning" => &[("code_scanning", "code-scanning/alerts")],
                "secret" => &[("secret", "secret-scanning/alerts")],
                _ => &[("dependabot", "dependabot/alerts"), ("code_scanning", "code-scanning/alerts")],
            };
            let critical = if w.until == "critical" { "&severity=critical" } else { "" };
            let mut found_any = None;
            for (kind, path) in kinds {
                let got = match ask.get(format!("repos/{repo}/{path}?{open}{critical}")).await {
                    Answer::Found(v) => v,
                    // Code scanning that isn't set up answers 404: the other kind still counts.
                    Answer::Missing if kinds.len() > 1 => continue,
                    Answer::Missing => return Look::Missing,
                    Answer::Unauthorized => return Look::Unauthorized,
                    Answer::Unknown => return Look::Unknown,
                };
                let look = alerts(w, &cursor, kind, &got);
                if let Look::Fire { .. } = look {
                    return look;
                }
                found_any = Some(look);
            }
            found_any.unwrap_or(Look::Missing)
        }
        "github.discussion" => {
            let (owner, name) = repo.split_once('/').unwrap_or((&repo, ""));
            let data = found!(ask.graphql(DISCUSSIONS, &[("owner", owner), ("name", name)]).await);
            let me = ask.me().await;
            discussions(w, &cursor, &data, me.as_deref())
        }
        "github.stars" => counts(w, &found!(ask.get(format!("repos/{repo}")).await)),
        _ => Look::Unknown,
    }
}

const CATEGORIES: &str = "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){discussionCategories(first:25){nodes{name}}}}";

/// At most this many names for the Listening panel's chips.
const MAX_NAMES: usize = 12;

/// The names a repository has for a watch's text, for the Listening panel to
/// offer: its workflows, its environments, its labels, its discussions'
/// categories. Empty when GitHub can't say.
#[tauri::command]
pub async fn listen_github_names(source: String, repo: String) -> Vec<String> {
    let Some(repo) = repo_of(&repo) else { return Vec::new() };
    let (via, token) = listen::via().await;
    let ask = Asker::new(via, token);
    let (got, list, field) = match source.as_str() {
        "github.workflow" => (ask.get(format!("repos/{repo}/actions/workflows?per_page=100")).await, "/workflows", "name"),
        "github.deploy" => (ask.get(format!("repos/{repo}/environments?per_page=100")).await, "/environments", "name"),
        "github.issue" => (ask.get(format!("repos/{repo}/labels?per_page=100")).await, "", "name"),
        "github.discussion" => {
            let (owner, name) = repo.split_once('/').unwrap_or((&repo, ""));
            (ask.graphql(CATEGORIES, &[("owner", owner), ("name", name)]).await, "/data/repository/discussionCategories/nodes", "name")
        }
        _ => return Vec::new(),
    };
    let Answer::Found(v) = got else { return Vec::new() };
    let items = if list.is_empty() { &v } else { v.pointer(list).unwrap_or(&Value::Null) };
    items
        .as_array()
        .into_iter()
        .flatten()
        // A workflow turned off runs no more.
        .filter(|item| item["state"].as_str().is_none_or(|s| s == "active"))
        .filter_map(|item| item[field].as_str())
        .filter(|name| !name.contains(['"', '[', ']']) && name.chars().count() <= MAX_TEXT)
        .take(MAX_NAMES)
        .map(str::to_string)
        .collect()
}

/// Why a watch ends when GitHub keeps saying it can't be read.
pub fn cant_read(w: &Watch) -> String {
    if w.source == "github.notifications" {
        return t("GitHub doesn't give Lumo your notifications: sign in with gh, or use a classic token with the notifications permission.");
    }
    tf("Lumo can't read {pr} on GitHub", &[("pr", &w.label())])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watch(source: &str, target: &str, until: &str) -> Watch {
        Watch {
            id: 1,
            repo: String::new(),
            number: 0,
            until: until.into(),
            task: String::new(),
            chat_id: String::new(),
            started_at: 1_763_233_200_000, // 2025-11-15T19:00:00Z
            source: source.into(),
            mode: "every".into(),
            paused: false,
            fired: 0,
            last_sha: String::new(),
            target: target.into(),
            text: String::new(),
            amount: 0,
            warning: String::new(),
        }
    }

    fn fired(look: Look) -> (bool, String, Option<String>) {
        match look {
            Look::Fire { met, summary, cursor } => (met, summary, cursor),
            other => panic!("expected it to fire, got {other:?}"),
        }
    }

    #[test]
    fn times_read_as_github_writes_them() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_763_233_200_000), "2025-11-15T19:00:00Z");
        assert_eq!(iso(951_782_400_000), "2000-02-29T00:00:00Z");
        let w = watch("github.release", "o/r", "release");
        assert_eq!(since(&w), "2025-11-15T19:00:00Z");
        assert!(after(&json!("2025-11-15T19:00:01Z"), "2025-11-15T19:00:00Z"));
        assert!(!after(&json!("2025-11-15T19:00:00Z"), "2025-11-15T19:00:00Z"));
        assert!(after(&json!("2025-11-15T19:00:00.500Z"), "2025-11-15T18:59:59Z"));
        assert!(!after(&json!(null), "2025-11-15T18:59:59Z"));
        assert_eq!(cursor_at(&json!("2025-11-15T19:00:00.500Z")), "2025-11-15T19:00:00Z");
    }

    #[test]
    fn targets_are_kept_in_one_form() {
        assert_eq!(target("github.branch", "commit", "Rccrd12/Lumo@main", ""), Ok("Rccrd12/Lumo@main".into()));
        assert_eq!(target("github.branch", "commit", "https://github.com/Rccrd12/Lumo/tree/feature/x", ""), Ok("Rccrd12/Lumo@feature/x".into()));
        assert_eq!(target("github.branch", "commit", "Rccrd12/Lumo main", ""), Ok("Rccrd12/Lumo@main".into()));
        assert!(target("github.branch", "commit", "Rccrd12/Lumo", "").is_err());
        assert!(target("github.branch", "commit", "Rccrd12/Lumo@../x", "").is_err());
        assert_eq!(target("github.workflow", "finished", "Rccrd12/Lumo", "Windows beta"), Ok("Rccrd12/Lumo".into()));
        assert_eq!(target("github.workflow", "finished", "Rccrd12/Lumo@main", ""), Ok("Rccrd12/Lumo@main".into()));
        assert_eq!(target("github.issue", "comment", "https://github.com/o/r/issues/12", ""), Ok("o/r#12".into()));
        assert_eq!(target("github.issue", "opened", "o/r.git", "bug"), Ok("o/r".into()));
        assert!(target("github.issue", "opened", "o/r#12", "").is_err());
        assert_eq!(target("github.notifications", "any", "", ""), Ok("all".into()));
        assert_eq!(target("github.notifications", "any", "o/r", ""), Ok("o/r".into()));
        assert_eq!(target("github.stars", "star", "github.com/o/r/", ""), Ok("o/r".into()));
        assert!(target("github.stars", "star", "o/r/x", "").is_err());
        assert!(target("github.workflow", "finished", "o/r", "a \"b\"").is_err());
        // What is kept reads back the same (listen.rs kept).
        for (source, kept) in [("github.branch", "o/r@main"), ("github.issue", "o/r#3"), ("github.notifications", "all"), ("github.workflow", "o/r@release/1.0")] {
            assert_eq!(target(source, untils(source)[1], kept, "").as_deref(), Ok(kept));
        }
    }

    #[test]
    fn labels_say_what_is_listened_to() {
        assert_eq!(label("github.branch", "o/r@main", ""), "o/r · main");
        assert_eq!(label("github.workflow", "o/r@main", "Windows beta"), "Windows beta · main");
        assert_eq!(label("github.workflow", "o/r", "Windows beta"), "Windows beta · o/r");
        assert_eq!(label("github.issue", "o/r#12", ""), "o/r#12");
        assert_eq!(label("github.issue", "o/r", ""), "Issues · o/r");
        assert_eq!(label("github.notifications", "all", ""), "Notifications");
        assert_eq!(label("github.deploy", "o/r", "production"), "Deploys · production");
    }

    #[test]
    fn a_pull_request_s_comments_and_reviews_after_the_cursor_and_not_the_user_s() {
        let cursor = "2025-11-15T19:00:00Z";
        let issue = json!([
            { "created_at": "2025-11-15T18:00:00Z", "user": { "login": "marco" }, "body": "old" },
            { "created_at": "2025-11-15T19:05:00Z", "user": { "login": "Rccrd12" }, "body": "mine" },
            { "created_at": "2025-11-15T19:02:00Z", "user": { "login": "marco" }, "body": "Please   rename\nthis" },
        ]);
        let review = json!([{ "created_at": "2025-11-15T19:03:00Z", "user": { "login": "anna" }, "body": "nit" }]);
        let (met, summary, cursor_after) = fired(pr_comments("o/r#3", cursor, &issue, &review, Some("rccrd12")));
        assert!(met);
        assert_eq!(summary, "New comment on o/r#3 from anna: nit (and 1 more)");
        assert_eq!(cursor_after.as_deref(), Some("2025-11-15T19:03:00Z"));
        assert_eq!(pr_comments("o/r#3", "2025-11-15T19:03:00Z", &issue, &review, Some("Rccrd12")), Look::Hold(None));

        let reviews = json!([
            { "submitted_at": "2025-11-15T19:01:00Z", "user": { "login": "anna" }, "state": "COMMENTED" },
            { "submitted_at": "2025-11-15T19:04:00Z", "user": { "login": "anna" }, "state": "CHANGES_REQUESTED" },
            { "submitted_at": "2025-11-15T19:06:00Z", "user": { "login": "anna" }, "state": "PENDING" },
        ]);
        assert_eq!(fired(pr_reviews("o/r#3", cursor, &reviews, false, None)).1, "anna asked for changes on o/r#3 (and 1 more)");
        assert_eq!(fired(pr_reviews("o/r#3", cursor, &reviews, true, None)).1, "anna asked for changes on o/r#3");
        assert_eq!(pr_reviews("o/r#3", "2025-11-15T19:04:00Z", &reviews, true, None), Look::Hold(None));
    }

    #[test]
    fn a_new_commit_is_told_against_the_one_first_seen() {
        assert_eq!(new_commit("o/r · main", "", "abc1234", "x"), Look::Hold(Some("abc1234".into())));
        assert_eq!(new_commit("o/r · main", "abc1234", "abc1234", "x"), Look::Hold(None));
        let (met, summary, cursor) = fired(new_commit("o/r · main", "abc1234", "def5678", "Fix the island\n\nmore"));
        assert!(met);
        assert_eq!(summary, "New commit on o/r · main: Fix the island");
        assert_eq!(cursor.as_deref(), Some("def5678"));
        assert_eq!(fired(new_commit("x", "a", "def56789", "")).1, "New commit on x: def5678");
    }

    #[test]
    fn a_branch_s_checks_fire_once_a_commit() {
        let mut w = watch("github.branch", "o/r@main", "green");
        assert_eq!(branch_checks(&w, "s1", &Checks::Pending, 0), Look::Hold(None));
        assert_eq!(fired(branch_checks(&w, "s1", &Checks::Passed, 0)), (true, "Checks passed on o/r · main".into(), Some("s1".into())));
        let failed = Checks::Failed(vec!["build".into()]);
        assert_eq!(fired(branch_checks(&w, "s1", &failed, 0)), (false, "Checks failed on o/r · main: build".into(), Some("s1".into())));
        // No check at all: passed only after the grace.
        assert_eq!(branch_checks(&w, "s1", &Checks::None, 0), Look::Hold(None));
        assert!(matches!(branch_checks(&w, "s1", &Checks::None, listen::NO_CHECKS_GRACE_MS), Look::Fire { met: true, .. }));
        w.last_sha = "s1".into();
        assert_eq!(branch_checks(&w, "s1", &Checks::Passed, 0), Look::Hold(None));
        w.until = "red".into();
        w.last_sha.clear();
        assert_eq!(branch_checks(&w, "s2", &Checks::Passed, 0), Look::Hold(Some("s2".into())));
        assert!(matches!(branch_checks(&w, "s2", &failed, 0), Look::Fire { met: true, .. }));
    }

    #[test]
    fn a_workflow_s_runs_by_name_or_file_and_how_they_ended() {
        let mut w = watch("github.workflow", "o/r@main", "finished");
        w.text = "Windows beta".into();
        let cursor = "2025-11-15T19:00:00Z";
        let runs = json!({ "workflow_runs": [
            { "name": "Windows CI", "path": ".github/workflows/windows-ci.yml", "head_branch": "main", "status": "completed", "conclusion": "success", "created_at": "2025-11-15T19:01:00Z", "updated_at": "2025-11-15T19:09:00Z" },
            { "name": "Windows beta", "path": ".github/workflows/windows-beta.yml", "head_branch": "main", "status": "completed", "conclusion": "failure", "created_at": "2025-11-15T19:02:00Z", "updated_at": "2025-11-15T19:08:00Z" },
            { "name": "Windows beta", "path": ".github/workflows/windows-beta.yml", "head_branch": "main", "status": "in_progress", "conclusion": null, "created_at": "2025-11-15T19:10:00Z", "updated_at": "2025-11-15T19:10:00Z" },
        ]});
        assert_eq!(fired(workflow_runs(&w, cursor, &runs)), (true, "Windows beta failed on main".into(), Some("2025-11-15T19:08:00Z".into())));
        w.text = "windows-ci.yml".into();
        assert_eq!(fired(workflow_runs(&w, cursor, &runs)).1, "Windows CI succeeded on main");
        w.text = "Windows beta".into();
        w.until = "succeeded".into();
        assert_eq!(workflow_runs(&w, cursor, &runs), Look::Hold(None));
        w.mode = "once".into();
        assert!(!fired(workflow_runs(&w, cursor, &runs)).0);
        w.until = "started".into();
        assert_eq!(fired(workflow_runs(&w, cursor, &runs)), (true, "Windows beta started on main (and 1 more)".into(), Some("2025-11-15T19:10:00Z".into())));
    }

    #[test]
    fn releases_tags_and_counts() {
        let w = watch("github.release", "o/r", "prerelease");
        let list = json!([
            { "name": "", "tag_name": "windows-beta", "draft": false, "prerelease": true, "published_at": "2025-11-15T19:30:00Z" },
            { "name": "Lumo 0.22", "tag_name": "v0.22", "draft": false, "prerelease": false, "published_at": "2025-11-15T19:20:00Z" },
            { "name": "draft", "draft": true, "prerelease": true, "published_at": null },
        ]);
        assert_eq!(fired(releases(&w, "2025-11-15T19:00:00Z", &list)).1, "New pre-release windows-beta in o/r");
        let mut w = watch("github.release", "o/r", "release");
        assert_eq!(fired(releases(&w, "2025-11-15T19:00:00Z", &list)).1, "New release Lumo 0.22 in o/r");

        w.until = "tag".into();
        let tag_list = json!([{ "name": "v2" }, { "name": "v1" }]);
        assert_eq!(tags(&w, &tag_list), Look::Hold(Some("v2\nv1".into())));
        w.last_sha = "v1".into();
        assert_eq!(fired(tags(&w, &tag_list)), (true, "New tag v2 in o/r".into(), Some("v2\nv1".into())));
        w.last_sha = "v2\nv1".into();
        assert_eq!(tags(&w, &tag_list), Look::Hold(None));

        let mut w = watch("github.stars", "o/r", "star");
        assert_eq!(counts(&w, &json!({ "stargazers_count": 10 })), Look::Hold(Some("10".into())));
        w.last_sha = "10".into();
        assert_eq!(counts(&w, &json!({ "stargazers_count": 10 })), Look::Hold(None));
        assert_eq!(counts(&w, &json!({ "stargazers_count": 9 })), Look::Hold(Some("9".into())));
        assert_eq!(fired(counts(&w, &json!({ "stargazers_count": 11 }))), (true, "o/r has a new star (11)".into(), Some("11".into())));
        w.until = "stars".into();
        w.amount = 100;
        assert_eq!(counts(&w, &json!({ "stargazers_count": 99 })), Look::Hold(None));
        assert_eq!(fired(counts(&w, &json!({ "stargazers_count": 100 }))), (true, "o/r reached 100 stars".into(), None));
    }

    #[test]
    fn issues_events_and_comments_only_the_issues() {
        let cursor = "2025-11-15T19:00:00Z";
        let mut w = watch("github.issue", "o/r", "opened");
        w.text = "bug".into();
        let list = json!([
            { "number": 7, "title": "PR", "pull_request": {}, "created_at": "2025-11-15T19:05:00Z", "user": { "login": "anna" }, "labels": [{ "name": "bug" }] },
            { "number": 6, "title": "No label", "created_at": "2025-11-15T19:04:00Z", "user": { "login": "anna" }, "labels": [] },
            { "number": 5, "title": "The island won't open", "created_at": "2025-11-15T19:03:00Z", "user": { "login": "anna" }, "labels": [{ "name": "Bug" }] },
        ]);
        assert_eq!(fired(issues(&w, cursor, &list, None)).1, "New issue o/r#5: The island won't open");

        w.until = "comment".into();
        let comments = json!([
            { "html_url": "https://github.com/o/r/pull/7#issuecomment-1", "issue_url": "https://api.github.com/repos/o/r/issues/7", "created_at": "2025-11-15T19:06:00Z", "user": { "login": "anna" }, "body": "on a PR" },
            { "html_url": "https://github.com/o/r/issues/5#issuecomment-2", "issue_url": "https://api.github.com/repos/o/r/issues/5", "created_at": "2025-11-15T19:05:00Z", "user": { "login": "anna" }, "body": "Same here" },
        ]);
        assert_eq!(fired(issues(&w, cursor, &comments, None)).1, "New comment on o/r#5 from anna: Same here");

        w.until = "labeled".into();
        let events = json!([
            { "event": "labeled", "label": { "name": "bug" }, "created_at": "2025-11-15T19:07:00Z", "actor": { "login": "anna" }, "issue": { "number": 5, "labels": [] } },
            { "event": "labeled", "label": { "name": "bug" }, "created_at": "2025-11-15T19:08:00Z", "actor": { "login": "anna" }, "issue": { "number": 7, "pull_request": {} } },
        ]);
        assert_eq!(fired(issues(&w, cursor, &events, None)).1, "o/r#5 got the label bug");
        assert_eq!(issues(&w, cursor, &events, Some("anna")), Look::Hold(None));

        let mut one = watch("github.issue", "o/r#5", "closed");
        one.mode = "once".into();
        let events = json!([{ "event": "closed", "created_at": "2025-11-15T19:09:00Z", "actor": { "login": "anna" } }]);
        assert_eq!(fired(issues(&one, cursor, &events, None)).1, "o/r#5 was closed");
    }

    #[test]
    fn notifications_alerts_deployments_and_discussions() {
        let cursor = "2025-11-15T19:00:00Z";
        let w = watch("github.notifications", "all", "review_requested");
        let list = json!([
            { "reason": "mention", "updated_at": "2025-11-15T19:02:00Z", "subject": { "title": "Fix it" }, "repository": { "full_name": "o/r" } },
            { "reason": "review_requested", "updated_at": "2025-11-15T19:01:00Z", "subject": { "title": "Add listening" }, "repository": { "full_name": "o/r" } },
        ]);
        assert_eq!(fired(notifications(&w, cursor, &list)).1, "Your review was requested: Add listening (o/r)");
        let any = watch("github.notifications", "all", "any");
        assert_eq!(fired(notifications(&any, cursor, &list)).1, "You were mentioned: Fix it (o/r) (and 1 more)");

        let w = watch("github.security", "o/r", "dependabot");
        let list = json!([{ "created_at": "2025-11-15T19:03:00Z", "security_advisory": { "summary": "tar is unsafe" } }]);
        assert_eq!(fired(alerts(&w, cursor, "dependabot", &list)).1, "Dependabot alert in o/r: tar is unsafe");

        let mut w = watch("github.deploy", "o/r", "failed");
        w.text = "production".into();
        let list = json!([{ "id": 9, "environment": "production", "created_at": "2025-11-15T19:01:00Z" }, { "id": 8, "environment": "preview" }]);
        let statuses = vec![(9, json!([{ "state": "failure", "created_at": "2025-11-15T19:04:00Z" }]))];
        assert_eq!(fired(deployments(&w, cursor, &list, &statuses)), (true, "Deploy to production failed".into(), Some("2025-11-15T19:04:00Z".into())));
        w.until = "succeeded".into();
        assert_eq!(deployments(&w, cursor, &list, &statuses), Look::Hold(None));
        w.until = "started".into();
        assert_eq!(fired(deployments(&w, cursor, &list, &statuses)).1, "Deploy to production started");

        let w = watch("github.discussion", "o/r", "answer");
        let data = json!({ "data": { "repository": { "discussions": { "nodes": [
            { "title": "Ideas", "createdAt": "2025-11-01T00:00:00Z", "author": { "login": "anna" }, "category": { "name": "Ideas" },
              "comments": { "nodes": [{ "createdAt": "2025-11-15T19:05:00.000Z", "author": { "login": "marco" } }] } },
        ]}}}});
        assert_eq!(fired(discussions(&w, cursor, &data, Some("anna"))).1, "New answer in o/r: Ideas");
        assert_eq!(discussions(&w, cursor, &data, Some("marco")), Look::Hold(None));
    }
}
