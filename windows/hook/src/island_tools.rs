//! Lumo's island tools, as an MCP server lists them: a timer (`set_timer`) and
//! listening (`listen`, `stop_listening`, `list_listening`). One file for both
//! sides, as mail_tools.rs: lumo-hook's MCP server offers them to the CLIs
//! (mcp.rs, `--tools=island`: Claude Code, Codex, Antigravity, Gemini CLI and
//! the others), and the app reads this very file (`#[path]`, island_tools.rs)
//! to offer them to its API providers, so what every model is told it can
//! listen to never drifts apart again (the CLIs once kept being told only pull
//! requests, after Lumo had learnt all of GitHub). The app checks that the
//! lists below are its own (listen.rs, listen_local.rs, listen_github.rs).
//! Only serde_json here.

use serde_json::{json, Value};

pub const SET_TIMER: &str = "set_timer";
pub const LISTEN: &str = "listen";
pub const UNLISTEN: &str = "stop_listening";
pub const LIST: &str = "list_listening";

/// The longest timer: a day.
pub const MAX_SECONDS: u64 = 24 * 3600;
pub const MAX_LABEL: usize = 80;
/// The longest "then": what the model will do once it happens.
pub const MAX_TASK: usize = 500;

/// Where a watch listens, as listen.rs SOURCES.
pub const SOURCES: &[&str] = &[
    "github.pr", "fs", "process", "web", "email", "service", "windows", "agent", "webhook", "tool", "github.issue", "github.branch", "github.workflow",
    "github.release", "github.deploy", "github.notifications", "github.security", "github.discussion", "github.stars",
];
/// Once (the default) or every time, as listen.rs MODES.
pub const MODES: &[&str] = &["once", "every"];
/// Every event of every source, once each, in SOURCES' order (island_tools.rs events).
pub const EVENTS: &[&str] = &[
    "checks", "green", "approved", "ready", "merged", "closed", "comment", "review", "changes", "commit",
    "created", "changed", "deleted", "download", "started", "exited", "port_open", "port_closed", "up", "down", "contains", "gone",
    "new", "from", "subject", "event", "succeeded", "failed", "soon",
    "notification", "battery_low", "plugged", "unplugged", "offline", "online", "usb", "back", "finished", "permission", "called",
    "opened", "labeled", "assigned", "reopened", "red", "release", "prerelease", "tag", "waiting",
    "mention", "review_requested", "assign", "any", "dependabot", "code_scanning", "secret", "critical", "answer", "answered",
    "star", "fork", "stars", "watcher",
];

/// One tool, as `tools/list` gives it: name, what it does, the JSON schema of its input.
fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false,
        },
    })
}

/// The timer and the listening tools, as `tools/list` gives them.
pub fn island_tools() -> Vec<Value> {
    let target = || json!({
        "source": {
            "type": "string",
            "enum": SOURCES,
            "description": "Where to listen. All of GitHub, not only pull requests: github.pr (one pull request), \
github.branch (a branch's commits and checks, main too), github.workflow (a GitHub Actions workflow's runs, on every \
branch or on one), github.issue (a repository's issues, or one issue), github.release (releases and tags), \
github.deploy (deployments), github.notifications (the user's own notifications: mentions, review requests), \
github.security (Dependabot, code scanning and secret scanning alerts), github.discussion, github.stars (stars, forks, \
watchers). On this PC and elsewhere: fs: a file or a folder on this PC. process: a program running on this PC, or a \
port on it. web: a web page. email: the user's inbox (the Email pill). service: one of the user's services (vercel, \
stripe, n8n, resend, notion, calcom) or their calendar. windows: Windows itself. agent: a coding agent's session \
(Claude Code, Codex and the others). webhook: an address on this PC that other programs can call. tool: one of the \
user's own tools, run now and then.",
        },
        "target": {
            "type": "string",
            "description": "What to listen to: for github.pr, owner/repository#number or the pull request's link; \
for fs, the full path (C:\\Users\\name\\Downloads, or ~\\Downloads); for process, the executable's name (node.exe) or, \
with port_open or port_closed, the port number; for web, the link; for email, the sender (from) or words of the \
subject (subject), nothing for new; for service, the service, or calendar; for windows, the app whose notifications \
to wait for, else nothing; for agent, any or one of claude, codex, gemini, antigravity, cursor, copilot, opencode, \
amp, hermes, muse; for webhook, a short name; for tool, the tool's id. For github.branch, owner/repository@branch; for \
github.workflow, owner/repository, or owner/repository@branch for the runs on one branch; for github.issue, \
owner/repository, or owner/repository#number for one issue; for github.notifications, all or owner/repository; for the \
other github sources, owner/repository.",
        },
    });
    let mut watch = target();
    watch["event"] = json!({
        "type": "string",
        "enum": EVENTS,
        "description": "github.pr: checks (finished, passed or failed), green (passed), approved, ready (checks \
passed and it can be merged), merged, closed. fs: created, changed, deleted, download (a download finished in the \
folder). process: started, exited, port_open, port_closed. web: changed (what the page shows), up, down, contains \
(the page shows text), gone (the page no longer shows text). email: new, from, subject. service: event, succeeded, failed, or soon for the calendar (an \
event starts within amount minutes). windows: notification, battery_low, plugged, unplugged, offline, online, usb (a \
drive is connected), back (the user is back after amount minutes away). agent: finished, permission (it asks for a \
permission or a reply), failed. webhook: called. tool: changed (what it prints), contains. github.pr also: comment, \
review, changes (changes requested), commit (a new commit pushed). github.issue: opened, comment, labeled, assigned, \
closed, reopened. github.branch: commit, checks, green, red (checks failed). github.workflow: finished, succeeded, \
failed, started. github.release: release, prerelease, tag. github.deploy: started, succeeded, failed, waiting (for \
approval). github.notifications: mention, review_requested, assign, comment, any. github.security: dependabot, \
code_scanning, secret, critical. github.discussion: opened, answer, answered (an answer marked). github.stars: star, \
fork, watcher, stars (amount stars reached).",
    });
    watch["mode"] = json!({
        "type": "string",
        "enum": MODES,
        "description": "once (the default): it ends when the event happens. every: it fires again each time; on \
github.pr for checks or green once for each new commit, and for comment, review, changes or commit each time, until \
the pull request is merged or closed; on the rest of GitHub, each time it happens.",
    });
    watch["text"] = json!({
        "type": "string",
        "maxLength": 200,
        "description": "contains and gone (web, tool): the text; soon (calendar): words the event's title must have. \
github.issue: the label the issues must have; github.workflow: the workflow's name or file (Windows CI, ci.yml); \
github.deploy: the environment (production); github.discussion opened: the category. Leave it out for any.",
    });
    watch["amount"] = json!({
        "type": "integer",
        "minimum": 1,
        "maximum": 100_000_000,
        "description": "service soon: the minutes before the event (10). windows battery_low: the percent (20); \
back: the minutes away (5). tool: the minutes between two runs (15), at most 1440. github.stars stars: the stars to \
reach (100). Leave it out for the rest.",
    });
    watch["then"] = json!({
        "type": "string",
        "maxLength": MAX_TASK,
        "description": "What you will do then, e.g. merge it with gh pr merge --squash. Leave it out when the user \
only wants to be told.",
    });
    vec![
        tool(
            SET_TIMER,
            "Starts a timer on Lumo's island. Use it only when the user asks for a timer or to be reminded in some \
time, then say in a few words that it is set.",
            json!({
                "seconds": { "type": "integer", "minimum": 1, "maximum": MAX_SECONDS, "description": "How long: 600 for 10 minutes." },
                "label": { "type": "string", "maxLength": MAX_LABEL, "description": "What it is for, in a few words, in the user's language." },
            }),
            &["seconds"],
        ),
        tool(
            LISTEN,
            "Lumo listens for an event and tells the user once it happens; with something to do then, it sends you a \
message in this chat that says what happened, and you do it then. It listens to all of GitHub (a pull request, a \
branch such as main, a workflow's runs, issues, releases…) and to this PC: see source. Use it instead of waiting, \
sleeping or polling yourself, then say in a few words that Lumo will listen once the user confirms (they click Listen) \
and end your answer.",
            watch,
            &["source", "target", "event"],
        ),
        tool(UNLISTEN, "Stops listening to something Lumo listens to.", target(), &["target"]),
        tool(LIST, "Lists what Lumo is listening to, in every chat.", json!({}), &[]),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_source_and_event_is_offered_once() {
        let tools = island_tools();
        let listen = tools.iter().find(|t| t["name"] == LISTEN).unwrap();
        let props = &listen["inputSchema"]["properties"];
        assert_eq!(props["source"]["enum"], json!(SOURCES));
        assert_eq!(props["event"]["enum"], json!(EVENTS));
        for (i, e) in EVENTS.iter().enumerate() {
            assert!(!EVENTS[..i].contains(e), "{e} twice");
        }
        // Each source is explained, not only listed: the CLIs once believed listen took pull requests only.
        let words = props["source"]["description"].as_str().unwrap();
        for source in SOURCES {
            assert!(words.contains(source), "{source} is not explained");
        }
    }
}
