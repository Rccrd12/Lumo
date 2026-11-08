// Built-in read-only GitHub tools for the chat's API and local model providers
// (claude.rs, openai_compat.rs, local_chat.rs).
//
// Offered only when the user lets the AI read GitHub (Settings → General →
// Security → GitHub, `ai_github_access`, off until turned on), has saved a
// GitHub token in Lumo's credential store (`secrets::present("github-token")`)
// and Lumo is not paused. Every
// response is formatted concisely so small local models get the facts they need
// (PR status, CI checks, files changed, issues, commits, workflow runs) without
// drowning their context window.

use std::sync::atomic::Ordering;
use std::time::Duration;

use reqwest::Url;
use serde_json::{json, Value};

use crate::claude_code::Activity;
use crate::github::{self, CiState, GitHubPulse, ReviewState};
use crate::integrations::PAUSED;
use crate::net;
use crate::secrets;

pub const OVERVIEW: &str = "github_overview";
pub const PRS: &str = "github_prs";
pub const PR_VIEW: &str = "github_pr_view";
pub const ISSUES: &str = "github_issues";
pub const REPOS: &str = "github_repos";
pub const CI_RUNS: &str = "github_ci_runs";

pub const NAMES: [&str; 6] = [OVERVIEW, PRS, PR_VIEW, ISSUES, REPOS, CI_RUNS];

pub const NOTE: &str = " GitHub is connected: use github_overview, github_prs, github_pr_view, github_issues, github_repos and github_ci_runs to read the user's pull requests, reviews, repositories, issues, commits and GitHub Actions CI runs instead of guessing or saying you cannot see their GitHub.";

const TIMEOUT: Duration = Duration::from_secs(12);
const API_BASE: &str = "https://api.github.com";

/// Whether GitHub tools may be offered and called right now.
pub fn enabled() -> bool {
    !PAUSED.load(Ordering::Relaxed) && allowed(&crate::settings::load()) && secrets::present("github-token")
}

/// Whether Security lets the AI read GitHub: only a plain "read" does.
pub fn allowed(settings: &crate::settings::Settings) -> bool {
    settings.ai_github_access == "read"
}

fn token() -> Result<String, String> {
    if PAUSED.load(Ordering::Relaxed) {
        return Err("Lumo is paused.".into());
    }
    if !allowed(&crate::settings::load()) {
        return Err("The user doesn't let the AI read GitHub (Lumo's Settings → Security → GitHub).".into());
    }
    secrets::get("github-token").ok_or_else(|| "GitHub is not connected in Lumo (no GitHub token configured).".into())
}

fn client() -> reqwest::Client {
    static CLIENT: std::sync::LazyLock<reqwest::Client> = std::sync::LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .unwrap_or_default()
    });
    CLIENT.clone()
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> (String, String, Value) {
    let schema = json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    });
    (name.to_string(), description.to_string(), schema)
}

/// The GitHub tools, as the chat's API and local providers take them.
pub fn api_tools() -> Vec<(String, String, Value)> {
    vec![
        tool(
            OVERVIEW,
            "Reads the user's GitHub overview: their open pull requests (with CI and review status), pull requests waiting for their review, and the default-branch CI status of their recently pushed repositories. Use this first when the user asks what is happening on their GitHub.",
            json!({}),
            &[],
        ),
        tool(
            PRS,
            "Lists or searches GitHub pull requests. Give `repo` (owner/name) to list pull requests in one repository, or `query` (GitHub search syntax such as `author:@me` or `org:vercel is:open`) to search across GitHub.",
            json!({
                "repo": { "type": "string", "description": "Repository as owner/name, or a github.com repository URL." },
                "state": { "type": "string", "enum": ["open", "closed", "all"], "description": "Filter by state (default: open)." },
                "query": { "type": "string", "description": "Search query across GitHub pull requests when not listing a single repository." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 30, "description": "Maximum pull requests to return (default: 15)." },
            }),
            &[],
        ),
        tool(
            PR_VIEW,
            "Reads one GitHub pull request in detail: title, author, branches, description, review state, CI check runs, changed files and recent comments. Set `include_diff` to true to include short file patches.",
            json!({
                "target": { "type": "string", "description": "Pull request as owner/repo#number or its github.com URL." },
                "repo": { "type": "string", "description": "Repository as owner/name (if `target` is not used)." },
                "number": { "type": "integer", "minimum": 1, "description": "Pull request number (with `repo`)." },
                "include_diff": { "type": "boolean", "description": "Include short unified diff patches of changed files (default: false)." },
            }),
            &[],
        ),
        tool(
            ISSUES,
            "Lists, searches or reads GitHub issues. Give `target` (`owner/repo#number` or URL) or `repo` + `number` to read one issue with its comments; give `repo` or `query` to list or search issues.",
            json!({
                "target": { "type": "string", "description": "Single issue as owner/repo#number or its github.com URL." },
                "repo": { "type": "string", "description": "Repository as owner/name." },
                "number": { "type": "integer", "minimum": 1, "description": "Issue number to read in detail (with `repo`)." },
                "state": { "type": "string", "enum": ["open", "closed", "all"], "description": "Filter by state when listing (default: open)." },
                "query": { "type": "string", "description": "Search query across GitHub issues." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 30, "description": "Maximum issues to return (default: 15)." },
            }),
            &[],
        ),
        tool(
            REPOS,
            "Lists the user's (or an owner's) GitHub repositories, or inspects one repository (`repo` as owner/name) with its branches and recent commits.",
            json!({
                "repo": { "type": "string", "description": "Repository as owner/name to inspect its details, branches and recent commits." },
                "owner": { "type": "string", "description": "GitHub username or organization whose repositories to list (omit for the signed-in user)." },
                "branch": { "type": "string", "description": "Branch or ref for recent commits when `repo` is given." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 30, "description": "Maximum items to return (default: 15)." },
            }),
            &[],
        ),
        tool(
            CI_RUNS,
            "Lists recent GitHub Actions workflow runs for `repo` (owner/name), or inspects one workflow run's jobs and failed steps when `run_id` is given.",
            json!({
                "repo": { "type": "string", "description": "Repository as owner/name, or its github.com URL." },
                "branch": { "type": "string", "description": "Optional branch name to filter workflow runs." },
                "status": { "type": "string", "enum": ["in_progress", "queued", "completed", "failure", "success"], "description": "Optional status/conclusion filter." },
                "run_id": { "type": "integer", "minimum": 1, "description": "Workflow run ID to inspect its jobs and steps." },
                "limit": { "type": "integer", "minimum": 1, "maximum": 25, "description": "Maximum runs to list (default: 10)." },
            }),
            &["repo"],
        ),
    ]
}

/// Live activity label shown on the island while a GitHub tool runs.
pub fn activity(name: &str, input: &Value) -> Activity {
    let target = input
        .get("target")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::trim)
        .or_else(|| input.get("repo").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(str::trim))
        .unwrap_or("");
    let detail = match (name, target) {
        (OVERVIEW, _) => "GitHub".to_string(),
        (_, "") => format!("GitHub ({})", name.trim_start_matches("github_").replace('_', " ")),
        (_, t) => format!("GitHub · {}", clip(t, 36)),
    };
    Activity::new("tool", detail)
}

/// Executes one of Lumo's built-in GitHub tools.
pub async fn call(name: &str, input: &Value) -> (String, bool) {
    let tok = match token() {
        Ok(t) => t,
        Err(e) => return (e, true),
    };
    let res = match name {
        OVERVIEW => overview(&tok).await,
        PRS => prs(&tok, input).await,
        PR_VIEW => pr_view(&tok, input).await,
        ISSUES => issues(&tok, input).await,
        REPOS => repos(&tok, input).await,
        CI_RUNS => ci_runs(&tok, input).await,
        _ => Err(format!("Unknown GitHub tool: {name}")),
    };
    match res {
        Ok(text) => (text, false),
        Err(err) => (err, true),
    }
}

// ── Validation & HTTP helpers ─────────────────────────────────────────────────

fn valid_segment(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 100
        && s != "."
        && s != ".."
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Parses `"owner/repo"` or `"https://github.com/owner/repo/..."` into `(owner, repo)`.
pub fn parse_repo(raw: &str) -> Option<(String, String)> {
    let s = raw.trim().trim_start_matches('<').trim_end_matches('>');
    let s = s.split_once("://").map_or(s, |(_, rest)| rest);
    let s = s.strip_prefix("www.").unwrap_or(s);
    let s = s.strip_prefix("github.com/").unwrap_or(s);
    let s = s.split(['?', '#']).next().unwrap_or(s).trim_matches('/');
    let mut parts = s.split('/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim().trim_end_matches(".git");
    (valid_segment(owner) && valid_segment(repo)).then(|| (owner.to_string(), repo.to_string()))
}

/// Parses `"owner/repo#42"`, `"owner/repo/pull/42"`, `"owner/repo/issues/42"`, or a GitHub URL.
pub fn parse_item_ref(raw: &str) -> Option<(String, String, u64)> {
    let s = raw.trim().trim_start_matches('<').trim_end_matches('>');
    let s = s.split_once("://").map_or(s, |(_, rest)| rest);
    let s = s.strip_prefix("www.").unwrap_or(s);
    let s = s.strip_prefix("github.com/").unwrap_or(s);
    let s = s.split('?').next().unwrap_or(s);
    if let Some((repo_part, num_part)) = s.split_once('#') {
        let (owner, repo) = parse_repo(repo_part)?;
        let num: u64 = num_part.trim().parse().ok()?;
        return (num > 0).then_some((owner, repo, num));
    }
    let parts: Vec<&str> = s.trim_matches('/').split('/').collect();
    match parts.as_slice() {
        [owner, repo, "pull" | "pulls" | "issues", num, ..] => {
            let repo = repo.trim_end_matches(".git");
            let n: u64 = num.parse().ok()?;
            (valid_segment(owner) && valid_segment(repo) && n > 0).then(|| ((*owner).to_string(), repo.to_string(), n))
        }
        _ => None,
    }
}

fn item_from_input(input: &Value) -> Result<(String, String, u64), String> {
    if let Some(target) = input.get("target").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        return parse_item_ref(target)
            .ok_or_else(|| "Give `target` as owner/repo#number or a github.com pull/issue URL.".to_string());
    }
    let repo_raw = input.get("repo").and_then(Value::as_str).unwrap_or("");
    let (owner, repo) = parse_repo(repo_raw).ok_or_else(|| "Give `repo` as owner/name.".to_string())?;
    let number = input
        .get("number")
        .and_then(|v| v.as_u64().or_else(|| v.as_str()?.trim().trim_start_matches('#').parse().ok()))
        .filter(|n| *n > 0)
        .ok_or_else(|| "Give `number` (a positive integer) or `target` as owner/repo#number.".to_string())?;
    Ok((owner, repo, number))
}

fn limit_of(input: &Value, default: usize, max: usize) -> usize {
    input
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, max))
        .unwrap_or(default)
}

fn clip(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        trimmed.to_string()
    } else {
        let mut s: String = trimmed.chars().take(max_chars).collect();
        s.push('…');
        s
    }
}

fn one_line(text: &str, max_chars: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    clip(&flat, max_chars)
}

async fn rest_get(token: &str, path: &str, params: &[(&str, String)]) -> Result<Value, String> {
    let mut url = Url::parse(&format!("{API_BASE}/{}", path.trim_start_matches('/')))
        .map_err(|_| "Invalid GitHub API URL.".to_string())?;
    if !params.is_empty() {
        let mut qp = url.query_pairs_mut();
        for (k, v) in params {
            qp.append_pair(k, v);
        }
    }
    let response = client()
        .get(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "Lumo")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| format!("GitHub connection failed: {e}"))?;
    let status = response.status();
    let bytes = net::read_capped(response, net::MAX_BODY).await?;
    if !status.is_success() {
        let msg = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| format!("HTTP {}", status.as_u16()));
        return Err(format!("GitHub API error ({}): {msg}", status.as_u16()));
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid JSON from GitHub.".into())
}

async fn graphql(token: &str, query: &str) -> Result<Value, String> {
    let response = client()
        .post("https://api.github.com/graphql")
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .header("User-Agent", "Lumo")
        .json(&json!({ "query": query }))
        .send()
        .await
        .map_err(|e| format!("GitHub connection failed: {e}"))?;
    let status = response.status();
    let bytes = net::read_capped(response, net::MAX_BODY).await?;
    if !status.is_success() {
        return Err(format!("GitHub GraphQL HTTP {}", status.as_u16()));
    }
    serde_json::from_slice(&bytes).map_err(|_| "Invalid JSON from GitHub.".into())
}

// ── Tool implementations ──────────────────────────────────────────────────────

fn ci_word(ci: CiState) -> &'static str {
    match ci {
        CiState::Pending => "CI running",
        CiState::Success => "CI passing",
        CiState::Failure => "CI failing",
        CiState::Unknown => "no CI",
    }
}

fn review_word(r: ReviewState) -> &'static str {
    match r {
        ReviewState::Approved => "approved",
        ReviewState::ChangesRequested => "changes requested",
        ReviewState::Pending => "review required",
        ReviewState::Unknown => "no review state",
    }
}

pub fn format_pulse(pulse: &GitHubPulse) -> String {
    let mut out = Vec::new();
    out.push(format!("Signed in as @{}", if pulse.login.is_empty() { "unknown" } else { &pulse.login }));

    if pulse.my_prs.is_empty() {
        out.push("\nOpen pull requests by you: none.".into());
    } else {
        out.push(format!("\nOpen pull requests by you ({}):", pulse.my_prs.len()));
        for pr in &pulse.my_prs {
            let draft = if pr.is_draft { " [draft]" } else { "" };
            out.push(format!(
                "- {}{} — {} ({}, {}) {}",
                pr.id,
                draft,
                one_line(&pr.title, 90),
                ci_word(pr.ci),
                review_word(pr.review),
                pr.url
            ));
        }
    }

    if pulse.to_review.is_empty() {
        out.push("\nPull requests waiting for your review: none.".into());
    } else {
        out.push(format!("\nPull requests waiting for your review ({}):", pulse.to_review.len()));
        for pr in &pulse.to_review {
            let draft = if pr.is_draft { " [draft]" } else { "" };
            out.push(format!("- {}{} — {} {}", pr.id, draft, one_line(&pr.title, 90), pr.url));
        }
    }

    if !pulse.main_ci.is_empty() {
        out.push(format!("\nDefault-branch CI on recent repositories ({}):", pulse.main_ci.len()));
        for r in &pulse.main_ci {
            out.push(format!("- {} ({}) — {} {}", r.repo, r.branch, ci_word(r.ci), r.url));
        }
    }
    out.join("\n")
}

async fn overview(token: &str) -> Result<String, String> {
    let root = graphql(token, github::PULSE_QUERY).await?;
    let pulse = GitHubPulse::parse(&root, 0).ok_or_else(|| "GitHub returned no viewer data (check token scopes).".to_string())?;
    Ok(format_pulse(&pulse))
}

async fn prs(token: &str, input: &Value) -> Result<String, String> {
    let limit = limit_of(input, 15, 30);
    let state = match input.get("state").and_then(Value::as_str).unwrap_or("open") {
        "closed" => "closed",
        "all" => "all",
        _ => "open",
    };
    if let Some(repo_raw) = input.get("repo").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        let (owner, repo) = parse_repo(repo_raw).ok_or_else(|| "Give `repo` as owner/name.".to_string())?;
        let data = rest_get(
            token,
            &format!("repos/{owner}/{repo}/pulls"),
            &[("state", state.into()), ("per_page", limit.to_string()), ("sort", "updated".into()), ("direction", "desc".into())],
        )
        .await?;
        let items = data.as_array().map(Vec::as_slice).unwrap_or(&[]);
        if items.is_empty() {
            return Ok(format!("No {state} pull requests in {owner}/{repo}."));
        }
        let mut lines = vec![format!("Pull requests in {owner}/{repo} ({state}, showing {}):", items.len())];
        for pr in items.iter().take(limit) {
            let num = pr["number"].as_u64().unwrap_or(0);
            let title = one_line(pr["title"].as_str().unwrap_or(""), 90);
            let user = pr["user"]["login"].as_str().unwrap_or("?");
            let st = if pr["merged_at"].is_string() { "merged" } else { pr["state"].as_str().unwrap_or(state) };
            let draft = if pr["draft"].as_bool().unwrap_or(false) { ", draft" } else { "" };
            let head = pr["head"]["ref"].as_str().unwrap_or("");
            let base = pr["base"]["ref"].as_str().unwrap_or("");
            let url = pr["html_url"].as_str().unwrap_or("");
            lines.push(format!("- #{num} [{st}{draft}] {title} (by @{user}, {head} -> {base}) {url}"));
        }
        return Ok(lines.join("\n"));
    }

    let raw_query = input.get("query").and_then(Value::as_str).unwrap_or("").trim();
    let q = if raw_query.is_empty() {
        if state == "all" { "is:pr involves:@me".to_string() } else { format!("is:pr is:{state} involves:@me") }
    } else if raw_query.contains("is:pr") || raw_query.contains("type:pr") {
        raw_query.to_string()
    } else if state == "all" {
        format!("is:pr {raw_query}")
    } else {
        format!("is:pr is:{state} {raw_query}")
    };
    let data = rest_get(
        token,
        "search/issues",
        &[("q", q.clone()), ("per_page", limit.to_string()), ("sort", "updated".into()), ("order", "desc".into())],
    )
    .await?;
    let total = data["total_count"].as_u64().unwrap_or(0);
    let items = data["items"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    if items.is_empty() {
        return Ok(format!("No pull requests matched `{q}`."));
    }
    let mut lines = vec![format!("Pull requests matching `{q}` ({total} total, showing {}):", items.len())];
    for item in items.iter().take(limit) {
        let num = item["number"].as_u64().unwrap_or(0);
        let title = one_line(item["title"].as_str().unwrap_or(""), 90);
        let user = item["user"]["login"].as_str().unwrap_or("?");
        let st = item["state"].as_str().unwrap_or("");
        let draft = if item["draft"].as_bool().unwrap_or(false) { ", draft" } else { "" };
        let url = item["html_url"].as_str().unwrap_or("");
        let repo = item["repository_url"]
            .as_str()
            .and_then(|u| u.strip_prefix("https://api.github.com/repos/"))
            .unwrap_or("");
        let prefix = if repo.is_empty() { format!("#{num}") } else { format!("{repo}#{num}") };
        lines.push(format!("- {prefix} [{st}{draft}] {title} (by @{user}) {url}"));
    }
    Ok(lines.join("\n"))
}

pub fn format_pr_detail(
    owner: &str,
    repo: &str,
    pr: &Value,
    checks: Option<&Value>,
    files: Option<&Value>,
    comments: Option<&Value>,
    include_diff: bool,
) -> String {
    let num = pr["number"].as_u64().unwrap_or(0);
    let title = pr["title"].as_str().unwrap_or("");
    let user = pr["user"]["login"].as_str().unwrap_or("?");
    let state = if pr["merged"].as_bool().unwrap_or(false) {
        "merged"
    } else {
        pr["state"].as_str().unwrap_or("unknown")
    };
    let draft = if pr["draft"].as_bool().unwrap_or(false) { " (draft)" } else { "" };
    let head = pr["head"]["ref"].as_str().unwrap_or("?");
    let base = pr["base"]["ref"].as_str().unwrap_or("?");
    let mergeable = pr["mergeable_state"].as_str().unwrap_or("unknown");
    let additions = pr["additions"].as_u64().unwrap_or(0);
    let deletions = pr["deletions"].as_u64().unwrap_or(0);
    let changed = pr["changed_files"].as_u64().unwrap_or(0);
    let url = pr["html_url"].as_str().unwrap_or("");

    let mut out = vec![
        format!("{owner}/{repo}#{num}: {title}"),
        format!("State: {state}{draft} | Author: @{user} | Branches: {head} -> {base} | Mergeable: {mergeable}"),
        format!("Changes: {changed} files (+{additions} -{deletions}) | URL: {url}"),
    ];

    let body = pr["body"].as_str().unwrap_or("").trim();
    if !body.is_empty() {
        out.push(format!("\nDescription:\n{}", clip(body, 1800)));
    }

    if let Some(runs) = checks.and_then(|c| c["check_runs"].as_array()) {
        if !runs.is_empty() {
            out.push(format!("\nCI checks ({}):", runs.len()));
            for run in runs.iter().take(20) {
                let name = run["name"].as_str().unwrap_or("check");
                let status = run["status"].as_str().unwrap_or("");
                let conclusion = run["conclusion"].as_str().unwrap_or("");
                let verdict = if status == "completed" && !conclusion.is_empty() { conclusion } else { status };
                out.push(format!("- {name}: {verdict}"));
            }
        }
    }

    if let Some(list) = files.and_then(Value::as_array) {
        if !list.is_empty() {
            out.push(format!("\nChanged files (showing {} of {}):", list.len().min(25), changed.max(list.len() as u64)));
            for f in list.iter().take(25) {
                let name = f["filename"].as_str().unwrap_or("?");
                let status = f["status"].as_str().unwrap_or("modified");
                let add = f["additions"].as_u64().unwrap_or(0);
                let del = f["deletions"].as_u64().unwrap_or(0);
                out.push(format!("- {name} ({status}, +{add} -{del})"));
                if include_diff {
                    if let Some(patch) = f["patch"].as_str().filter(|p| !p.is_empty()) {
                        out.push(format!("```diff\n{}\n```", clip(patch, 700)));
                    }
                }
            }
        }
    }

    if let Some(list) = comments.and_then(Value::as_array) {
        if !list.is_empty() {
            let start = list.len().saturating_sub(8);
            out.push(format!("\nRecent comments ({} of {}):", list.len() - start, list.len()));
            for c in &list[start..] {
                let author = c["user"]["login"].as_str().unwrap_or("?");
                let date = c["created_at"].as_str().unwrap_or("");
                let text = one_line(c["body"].as_str().unwrap_or(""), 260);
                out.push(format!("- @{author} ({date}): {text}"));
            }
        }
    }

    out.join("\n")
}

async fn pr_view(token: &str, input: &Value) -> Result<String, String> {
    let (owner, repo, number) = item_from_input(input)?;
    let include_diff = input.get("include_diff").and_then(Value::as_bool).unwrap_or(false);
    let pr = rest_get(token, &format!("repos/{owner}/{repo}/pulls/{number}"), &[]).await?;
    let sha = pr["head"]["sha"].as_str().unwrap_or("").to_string();

    let files = rest_get(token, &format!("repos/{owner}/{repo}/pulls/{number}/files"), &[("per_page", "25".into())]).await.ok();
    let comments = rest_get(token, &format!("repos/{owner}/{repo}/issues/{number}/comments"), &[("per_page", "15".into())]).await.ok();
    let checks = if valid_segment(&sha) {
        rest_get(token, &format!("repos/{owner}/{repo}/commits/{sha}/check-runs"), &[("per_page", "25".into())]).await.ok()
    } else {
        None
    };
    Ok(format_pr_detail(&owner, &repo, &pr, checks.as_ref(), files.as_ref(), comments.as_ref(), include_diff))
}

async fn issues(token: &str, input: &Value) -> Result<String, String> {
    let has_single = input.get("target").and_then(Value::as_str).is_some_and(|s| !s.trim().is_empty())
        || input.get("number").is_some_and(|v| !v.is_null());
    if has_single {
        let (owner, repo, number) = item_from_input(input)?;
        let issue = rest_get(token, &format!("repos/{owner}/{repo}/issues/{number}"), &[]).await?;
        let comments = rest_get(token, &format!("repos/{owner}/{repo}/issues/{number}/comments"), &[("per_page", "15".into())]).await.ok();
        let title = issue["title"].as_str().unwrap_or("");
        let state = issue["state"].as_str().unwrap_or("unknown");
        let user = issue["user"]["login"].as_str().unwrap_or("?");
        let url = issue["html_url"].as_str().unwrap_or("");
        let labels: Vec<&str> = issue["labels"]
            .as_array()
            .map(|a| a.iter().filter_map(|l| l["name"].as_str()).collect())
            .unwrap_or_default();
        let mut out = vec![
            format!("{owner}/{repo}#{number}: {title}"),
            format!(
                "State: {state} | Author: @{user}{} | URL: {url}",
                if labels.is_empty() { String::new() } else { format!(" | Labels: {}", labels.join(", ")) }
            ),
        ];
        let body = issue["body"].as_str().unwrap_or("").trim();
        if !body.is_empty() {
            out.push(format!("\nDescription:\n{}", clip(body, 2000)));
        }
        if let Some(list) = comments.as_ref().and_then(Value::as_array).filter(|l| !l.is_empty()) {
            let start = list.len().saturating_sub(8);
            out.push(format!("\nRecent comments ({} of {}):", list.len() - start, list.len()));
            for c in &list[start..] {
                let author = c["user"]["login"].as_str().unwrap_or("?");
                let date = c["created_at"].as_str().unwrap_or("");
                let text = one_line(c["body"].as_str().unwrap_or(""), 260);
                out.push(format!("- @{author} ({date}): {text}"));
            }
        }
        return Ok(out.join("\n"));
    }

    let limit = limit_of(input, 15, 30);
    let state = match input.get("state").and_then(Value::as_str).unwrap_or("open") {
        "closed" => "closed",
        "all" => "all",
        _ => "open",
    };

    if let Some(repo_raw) = input.get("repo").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        let (owner, repo) = parse_repo(repo_raw).ok_or_else(|| "Give `repo` as owner/name.".to_string())?;
        let data = rest_get(
            token,
            &format!("repos/{owner}/{repo}/issues"),
            &[("state", state.into()), ("per_page", (limit + 10).min(50).to_string()), ("sort", "updated".into())],
        )
        .await?;
        let items: Vec<&Value> = data
            .as_array()
            .map(|a| a.iter().filter(|i| i.get("pull_request").is_none()).take(limit).collect())
            .unwrap_or_default();
        if items.is_empty() {
            return Ok(format!("No {state} issues in {owner}/{repo}."));
        }
        let mut lines = vec![format!("Issues in {owner}/{repo} ({state}, showing {}):", items.len())];
        for item in items {
            let num = item["number"].as_u64().unwrap_or(0);
            let title = one_line(item["title"].as_str().unwrap_or(""), 90);
            let user = item["user"]["login"].as_str().unwrap_or("?");
            let st = item["state"].as_str().unwrap_or(state);
            let url = item["html_url"].as_str().unwrap_or("");
            lines.push(format!("- #{num} [{st}] {title} (by @{user}) {url}"));
        }
        return Ok(lines.join("\n"));
    }

    let raw_query = input.get("query").and_then(Value::as_str).unwrap_or("").trim();
    let q = if raw_query.is_empty() {
        if state == "all" { "is:issue involves:@me".to_string() } else { format!("is:issue is:{state} involves:@me") }
    } else if raw_query.contains("is:issue") || raw_query.contains("type:issue") {
        raw_query.to_string()
    } else if state == "all" {
        format!("is:issue {raw_query}")
    } else {
        format!("is:issue is:{state} {raw_query}")
    };
    let data = rest_get(
        token,
        "search/issues",
        &[("q", q.clone()), ("per_page", limit.to_string()), ("sort", "updated".into()), ("order", "desc".into())],
    )
    .await?;
    let total = data["total_count"].as_u64().unwrap_or(0);
    let items = data["items"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    if items.is_empty() {
        return Ok(format!("No issues matched `{q}`."));
    }
    let mut lines = vec![format!("Issues matching `{q}` ({total} total, showing {}):", items.len())];
    for item in items.iter().take(limit) {
        let num = item["number"].as_u64().unwrap_or(0);
        let title = one_line(item["title"].as_str().unwrap_or(""), 90);
        let user = item["user"]["login"].as_str().unwrap_or("?");
        let st = item["state"].as_str().unwrap_or("");
        let url = item["html_url"].as_str().unwrap_or("");
        let repo = item["repository_url"]
            .as_str()
            .and_then(|u| u.strip_prefix("https://api.github.com/repos/"))
            .unwrap_or("");
        let prefix = if repo.is_empty() { format!("#{num}") } else { format!("{repo}#{num}") };
        lines.push(format!("- {prefix} [{st}] {title} (by @{user}) {url}"));
    }
    Ok(lines.join("\n"))
}

async fn repos(token: &str, input: &Value) -> Result<String, String> {
    let limit = limit_of(input, 15, 30);
    if let Some(repo_raw) = input.get("repo").and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
        let (owner, repo) = parse_repo(repo_raw).ok_or_else(|| "Give `repo` as owner/name.".to_string())?;
        let info = rest_get(token, &format!("repos/{owner}/{repo}"), &[]).await?;
        let default_branch = info["default_branch"].as_str().unwrap_or("main");
        let branch = input
            .get("branch")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|b| !b.is_empty())
            .unwrap_or(default_branch);
        let commit_params = vec![("per_page", limit.min(15).to_string()), ("sha", branch.to_string())];
        let commits = rest_get(token, &format!("repos/{owner}/{repo}/commits"), &commit_params).await;
        let branches = rest_get(token, &format!("repos/{owner}/{repo}/branches"), &[("per_page", "15".into())]).await;

        let desc = info["description"].as_str().unwrap_or("").trim();
        let stars = info["stargazers_count"].as_u64().unwrap_or(0);
        let forks = info["forks_count"].as_u64().unwrap_or(0);
        let open_issues = info["open_issues_count"].as_u64().unwrap_or(0);
        let lang = info["language"].as_str().unwrap_or("—");
        let vis = if info["private"].as_bool().unwrap_or(false) { "private" } else { "public" };
        let url = info["html_url"].as_str().unwrap_or("");

        let mut out = vec![
            format!("{owner}/{repo} ({vis}) — {url}"),
            format!("Language: {lang} | Default branch: {default_branch} | Stars: {stars} | Forks: {forks} | Open issues/PRs: {open_issues}"),
        ];
        if !desc.is_empty() {
            out.push(format!("Description: {}", one_line(desc, 220)));
        }
        if let Ok(Value::Array(br)) = branches {
            let names: Vec<&str> = br.iter().filter_map(|b| b["name"].as_str()).take(15).collect();
            if !names.is_empty() {
                out.push(format!("\nBranches: {}", names.join(", ")));
            }
        }
        if let Ok(Value::Array(cs)) = commits {
            if !cs.is_empty() {
                out.push(format!("\nRecent commits on `{branch}` ({}):", cs.len().min(limit)));
                for c in cs.iter().take(limit) {
                    let sha: String = c["sha"].as_str().unwrap_or("").chars().take(7).collect();
                    let msg = one_line(c["commit"]["message"].as_str().unwrap_or("").lines().next().unwrap_or(""), 95);
                    let author = c["author"]["login"]
                        .as_str()
                        .or_else(|| c["commit"]["author"]["name"].as_str())
                        .unwrap_or("?");
                    let date = c["commit"]["author"]["date"].as_str().unwrap_or("");
                    out.push(format!("- `{sha}` {msg} ({author}, {date})"));
                }
            }
        }
        return Ok(out.join("\n"));
    }

    let owner = input.get("owner").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty());
    let data = if let Some(who) = owner {
        if !valid_segment(who) {
            return Err("Invalid GitHub username or organization.".into());
        }
        rest_get(token, &format!("users/{who}/repos"), &[("sort", "pushed".into()), ("per_page", limit.to_string())]).await?
    } else {
        rest_get(
            token,
            "user/repos",
            &[("sort", "pushed".into()), ("affiliation", "owner,collaborator,organization_member".into()), ("per_page", limit.to_string())],
        )
        .await?
    };
    let list = data.as_array().map(Vec::as_slice).unwrap_or(&[]);
    if list.is_empty() {
        return Ok("No repositories found.".into());
    }
    let heading = match owner {
        Some(who) => format!("Repositories of @{who} (showing {}):", list.len()),
        None => format!("Your recently pushed repositories (showing {}):", list.len()),
    };
    let mut lines = vec![heading];
    for r in list.iter().take(limit) {
        let full = r["full_name"].as_str().unwrap_or("?");
        let vis = if r["private"].as_bool().unwrap_or(false) { "private" } else { "public" };
        let lang = r["language"].as_str().unwrap_or("—");
        let stars = r["stargazers_count"].as_u64().unwrap_or(0);
        let branch = r["default_branch"].as_str().unwrap_or("main");
        let desc = one_line(r["description"].as_str().unwrap_or(""), 80);
        let desc_part = if desc.is_empty() { String::new() } else { format!(" — {desc}") };
        lines.push(format!("- {full} ({vis}, {lang}, ★{stars}, default: {branch}){desc_part}"));
    }
    Ok(lines.join("\n"))
}

pub fn format_workflow_jobs(repo: &str, run_id: u64, jobs: &[Value]) -> String {
    if jobs.is_empty() {
        return format!("No jobs found for workflow run {run_id} in {repo}.");
    }
    let mut lines = vec![format!("Jobs for workflow run {run_id} in {repo} ({}):", jobs.len())];
    for j in jobs.iter().take(20) {
        let name = j["name"].as_str().unwrap_or("job");
        let status = j["status"].as_str().unwrap_or("");
        let conclusion = j["conclusion"].as_str().unwrap_or("");
        let verdict = if status == "completed" && !conclusion.is_empty() { conclusion } else { status };
        let url = j["html_url"].as_str().unwrap_or("");
        lines.push(format!("- {name}: {verdict} {url}"));
        if let Some(steps) = j["steps"].as_array() {
            for s in steps {
                let s_conc = s["conclusion"].as_str().unwrap_or("");
                let s_stat = s["status"].as_str().unwrap_or("");
                if matches!(s_conc, "failure" | "cancelled" | "timed_out") || s_stat == "in_progress" {
                    let s_name = s["name"].as_str().unwrap_or("step");
                    let label = if !s_conc.is_empty() { s_conc } else { s_stat };
                    lines.push(format!("    * step `{s_name}`: {label}"));
                }
            }
        }
    }
    lines.join("\n")
}

async fn ci_runs(token: &str, input: &Value) -> Result<String, String> {
    let repo_raw = input.get("repo").and_then(Value::as_str).unwrap_or("");
    let (owner, repo) = parse_repo(repo_raw).ok_or_else(|| "Give `repo` as owner/name.".to_string())?;
    let full = format!("{owner}/{repo}");

    if let Some(run_id) = input.get("run_id").and_then(Value::as_u64).filter(|id| *id > 0) {
        let data = rest_get(token, &format!("repos/{owner}/{repo}/actions/runs/{run_id}/jobs"), &[("per_page", "25".into())]).await?;
        let jobs = data["jobs"].as_array().map(Vec::as_slice).unwrap_or(&[]);
        return Ok(format_workflow_jobs(&full, run_id, jobs));
    }

    let limit = limit_of(input, 10, 25);
    let mut params = vec![("per_page", limit.to_string())];
    if let Some(branch) = input.get("branch").and_then(Value::as_str).map(str::trim).filter(|b| !b.is_empty()) {
        params.push(("branch", branch.to_string()));
    }
    if let Some(status) = input.get("status").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()) {
        params.push(("status", status.to_string()));
    }
    let data = rest_get(token, &format!("repos/{owner}/{repo}/actions/runs"), &params).await?;
    let runs = data["workflow_runs"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    if runs.is_empty() {
        return Ok(format!("No GitHub Actions workflow runs found for {full}."));
    }
    let mut lines = vec![format!("Recent GitHub Actions runs in {full} (showing {}):", runs.len().min(limit))];
    for r in runs.iter().take(limit) {
        let id = r["id"].as_u64().unwrap_or(0);
        let name = r["name"].as_str().unwrap_or("Workflow");
        let title = one_line(r["display_title"].as_str().unwrap_or(""), 70);
        let branch = r["head_branch"].as_str().unwrap_or("?");
        let status = r["status"].as_str().unwrap_or("");
        let conclusion = r["conclusion"].as_str().unwrap_or("");
        let verdict = if status == "completed" && !conclusion.is_empty() { conclusion } else { status };
        let url = r["html_url"].as_str().unwrap_or("");
        lines.push(format!("- [run {id}] {name} on `{branch}` — {verdict}: {title} {url}"));
    }
    Ok(lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_plain_read_lets_the_ai_read_github_and_it_starts_off() {
        let with = |v: &str| crate::settings::Settings { ai_github_access: v.into(), ..crate::settings::Settings::default() };
        assert!(!allowed(&crate::settings::Settings::default()));
        assert!(allowed(&with("read")));
        assert!(!allowed(&with("none")));
        assert!(!allowed(&with("anything")));
    }

    #[test]
    fn parses_repositories_and_pull_or_issue_references() {
        assert_eq!(parse_repo("Rccrd12/Lumo"), Some(("Rccrd12".into(), "Lumo".into())));
        assert_eq!(parse_repo("https://github.com/Rccrd12/Lumo.git/pulls"), Some(("Rccrd12".into(), "Lumo".into())));
        assert_eq!(parse_repo("../etc/passwd"), None);
        assert_eq!(parse_repo("onlyowner"), None);

        assert_eq!(parse_item_ref("Rccrd12/Lumo#42"), Some(("Rccrd12".into(), "Lumo".into(), 42)));
        assert_eq!(parse_item_ref("https://github.com/Rccrd12/Lumo/pull/42/files"), Some(("Rccrd12".into(), "Lumo".into(), 42)));
        assert_eq!(parse_item_ref("https://github.com/Rccrd12/Lumo/issues/7?foo=1"), Some(("Rccrd12".into(), "Lumo".into(), 7)));
        assert_eq!(parse_item_ref("Rccrd12/Lumo#0"), None);
    }

    #[test]
    fn formats_pulse_pr_and_workflow_jobs_cleanly() {
        let pulse = GitHubPulse {
            login: "rccrd".into(),
            my_prs: vec![github::GitHubPr {
                id: "Rccrd12/Lumo#12".into(),
                title: "Improve island home".into(),
                url: "https://github.com/Rccrd12/Lumo/pull/12".into(),
                repo: "Rccrd12/Lumo".into(),
                number: 12,
                is_draft: false,
                ci: CiState::Pending,
                review: ReviewState::Approved,
                head_sha: Some("abc".into()),
            }],
            to_review: Vec::new(),
            main_ci: Vec::new(),
            fetched_at: 0,
        };
        let text = format_pulse(&pulse);
        assert!(text.contains("@rccrd"));
        assert!(text.contains("Rccrd12/Lumo#12"));
        assert!(text.contains("CI running, approved"));

        let jobs = vec![json!({
            "name": "build-windows",
            "status": "completed",
            "conclusion": "failure",
            "html_url": "https://github.com/Rccrd12/Lumo/actions/runs/99/job/1",
            "steps": [
                { "name": "Checkout", "status": "completed", "conclusion": "success" },
                { "name": "Cargo test", "status": "completed", "conclusion": "failure" }
            ]
        })];
        let jobs_text = format_workflow_jobs("Rccrd12/Lumo", 99, &jobs);
        assert!(jobs_text.contains("build-windows: failure"));
        assert!(jobs_text.contains("step `Cargo test`: failure"));
        assert!(!jobs_text.contains("Checkout"));
    }
}
