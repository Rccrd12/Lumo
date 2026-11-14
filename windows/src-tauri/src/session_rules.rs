// "Allow for this session" on a permission card.
//
// A click on it allows the request on screen, and Lumo remembers it: the same
// request from the same session of the same agent is then allowed without a
// card until that session ends (SessionEnd), sits unused for SESSION_IDLE (an
// agent that crashed or was closed sends no SessionEnd) or Lumo quits.
// Nothing is written anywhere — the rules live in memory only.
//
// The same request means the same tool with the same command (in the same
// folder, with the same other fields), the same file, the same page with the
// same method, or the same whole input (always, for an MCP server's tool: what
// its fields mean is its own). Anything else needs a card again. A
// request the relay had to cut (`lumo_input_cut`) is never remembered: two
// commands that only start and end alike are not the same request; nor one
// whose arguments the relay couldn't read (`lumo_input_unread`).
//
// These rules are the whole of it, for every agent. Claude Code gets the click
// as a plain allow: the rules it suggests itself (`npm run:*`, a whole MCP
// tool) reach further than what the card showed, so they are never handed
// back to it (lumo-hook's reply.rs). It asks Lumo again for the next request,
// and Lumo answers it from here at once.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

/// A session's rules go once it has asked nothing for this long.
const SESSION_IDLE: Duration = Duration::from_secs(12 * 60 * 60);

/// The requests a session allowed, and when it last asked.
type Allowed = (HashSet<String>, Instant);

/// Remembered rules: session scope → the requests allowed in it.
static RULES: Mutex<Option<HashMap<String, Allowed>>> = Mutex::new(None);
/// Requests on screen: request id → (scope, rule), kept until they are answered.
static WAITING: Mutex<Option<HashMap<String, (String, String)>>> = Mutex::new(None);

fn with<K, V, T>(map: &Mutex<Option<HashMap<K, V>>>, f: impl FnOnce(&mut HashMap<K, V>) -> T) -> T {
    f(map.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new))
}

/// The session a request belongs to: its agent and session id. None without a session id.
pub fn scope(payload: &Value) -> Option<String> {
    let session = payload.get("session_id").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    let agent = payload.get("lumo_agent").and_then(Value::as_str).unwrap_or("");
    Some(format!("{agent}\n{session}"))
}

/// What "the same request" is for this one: the tool and its command, file or
/// URL; the tool and its whole input otherwise. None for a question, which is
/// answered, not allowed, for a request the relay had to cut, and for one
/// whose arguments it couldn't read.
pub fn rule(payload: &Value) -> Option<String> {
    let tool = payload.get("tool_name").and_then(Value::as_str).filter(|t| !t.is_empty())?;
    let flag = |key: &str| payload.get(key).and_then(Value::as_bool) == Some(true);
    if tool == "AskUserQuestion" || flag("lumo_input_cut") || flag("lumo_input_unread") {
        return None;
    }
    // No input to look at (an agent's arguments the relay couldn't read are
    // cut before this): nothing the user saw to remember.
    let input = payload.get("tool_input").filter(|v| v.is_object())?;
    let field = |keys: &[&str]| keys.iter().find_map(|k| input.get(*k).and_then(Value::as_str)).map(str::to_string);
    let what = if !BUILT_IN.contains(&tool.to_ascii_lowercase().as_str()) {
        // An MCP server's tool, whatever the agent calls it (`mcp__s__t`,
        // Antigravity's `mcp_s_t`, `s/t`, Copilot's `s-t`), or any tool Lumo
        // doesn't know: its `url` or `path` may come with a method, a body, a
        // repository or a flag that change everything. Only the very same call.
        format!("input\n{input}")
    } else if let Some(command) = field(&["command", "cmd"]) {
        // The same command in another folder, or with another of its fields
        // (Codex's sandbox or escalation, a background run), is another
        // request: only what merely describes it (its description, its
        // timeout) may differ.
        let dir = field(&["workdir", "cwd", "directory", "dir"])
            .or_else(|| payload.get("cwd").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_default();
        let rest: serde_json::Map<String, Value> = input
            .as_object()
            .map(|o| {
                o.iter()
                    .filter(|(k, _)| !COMMAND_SAME.contains(&k.as_str()))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
            .unwrap_or_default();
        format!("command\n{command}\nin\n{dir}\nwith\n{}", Value::Object(rest))
    } else if let Some(path) = field(FILE_FIELDS) {
        format!("file\n{path}")
    } else if let Some(url) = field(&["url"]) {
        // GET allowed is not DELETE allowed.
        let method = field(&["method"]).map(|m| m.trim().to_ascii_uppercase()).unwrap_or_else(|| "GET".into());
        format!("url\n{method} {url}")
    } else {
        format!("input\n{input}")
    };
    Some(format!("{tool}\n{what}"))
}

/// The agents' own tools whose command, file or address says what they do
/// (Claude Code, Codex, Copilot, Gemini CLI, Antigravity, Cursor, OpenCode),
/// in lower case: the same command, file or address is the same request.
/// Any other tool is the same request only with the very same input.
const BUILT_IN: &[&str] = &[
    // Commands
    "bash", "powershell", "shell", "local_shell", "exec_command", "shell_command", "run_shell_command", "run_command",
    "run_in_terminal", "terminal",
    // Files
    "read", "write", "edit", "multiedit", "notebookedit", "view", "create", "str_replace", "str_replace_editor",
    "read_file", "write_file", "edit_file", "replace", "read_many_files", "write_to_file", "replace_file_content",
    "multi_replace_file_content", "create_file", "view_file", "list_dir", "glob", "grep", "ls",
    // Pages
    "webfetch", "web_fetch", "read_url_content", "fetch", "http",
];

/// Where the agents' file tools name their file: Claude Code's, Codex's and
/// Gemini CLI's, Antigravity's (`TargetFile`, its CLI's `Path`, its
/// `view_file`'s `AbsolutePath`), OpenCode's (`filePath`).
const FILE_FIELDS: &[&str] = &["file_path", "notebook_path", "path", "TargetFile", "Path", "AbsolutePath", "filePath"];

/// A command's fields that don't change what it does: the command itself and
/// its folder (in the rule on their own), what describes it, how long to wait.
const COMMAND_SAME: &[&str] = &["command", "cmd", "workdir", "cwd", "directory", "dir", "description", "timeout", "timeout_ms"];

/// A card for `request_id` is about to come up: what to remember if it is
/// allowed for the session. Returns true when the session already allowed this
/// very request, and no card is needed.
pub fn arrive(request_id: &str, payload: &Value) -> bool {
    let (Some(scope), Some(rule)) = (scope(payload), rule(payload)) else { return false };
    let allowed = with(&RULES, |rules| {
        // Sessions that ended without a word (no SessionEnd) are let go.
        rules.retain(|_, (_, last)| last.elapsed() < SESSION_IDLE);
        match rules.get_mut(&scope) {
            Some((set, last)) => {
                *last = Instant::now();
                set.contains(&rule)
            }
            None => false,
        }
    });
    if allowed {
        return true;
    }
    with(&WAITING, |waiting| waiting.insert(request_id.to_string(), (scope, rule)));
    false
}

/// Whether the request on screen can be allowed for its session.
pub fn can_remember(request_id: &str) -> bool {
    with(&WAITING, |waiting| waiting.contains_key(request_id))
}

/// The card for `request_id` was answered (or went): `always` remembers it.
pub fn answered(request_id: &str, decision: &str) {
    let Some((scope, rule)) = with(&WAITING, |waiting| waiting.remove(request_id)) else { return };
    if decision == "always" {
        with(&RULES, |rules| {
            let (set, last) = rules.entry(scope).or_insert_with(|| (HashSet::new(), Instant::now()));
            *last = Instant::now();
            set.insert(rule);
        });
    }
}

/// The session ended: its rules go.
pub fn session_ended(payload: &Value) {
    if let Some(scope) = scope(payload) {
        with(&RULES, |rules| rules.remove(&scope));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(session: &str, tool: &str, input: Value) -> Value {
        json!({ "hook_event_name": "PermissionRequest", "session_id": session, "tool_name": tool, "tool_input": input })
    }

    #[test]
    fn a_request_allowed_for_the_session_needs_no_second_card() {
        let first = request("s-same", "Bash", json!({ "command": "npm test" }));
        assert!(!arrive("r1", &first));
        assert!(can_remember("r1"));
        answered("r1", "always");
        assert!(!can_remember("r1"));
        assert!(arrive("r2", &request("s-same", "Bash", json!({ "command": "npm test", "description": "Run the tests" }))));
        // Another command, or another session, still asks.
        assert!(!arrive("r3", &request("s-same", "Bash", json!({ "command": "npm publish" }))));
        assert!(!arrive("r4", &request("s-other", "Bash", json!({ "command": "npm test" }))));
    }

    #[test]
    fn a_plain_allow_or_a_deny_remembers_nothing() {
        for (id, decision) in [("p1", "allow"), ("p2", "deny")] {
            assert!(!arrive(id, &request("s-plain", "Write", json!({ "file_path": "C:/a.txt" }))));
            answered(id, decision);
        }
        assert!(!arrive("p3", &request("s-plain", "Write", json!({ "file_path": "C:/a.txt" }))));
    }

    #[test]
    fn the_rules_end_with_the_session() {
        assert!(!arrive("e1", &request("s-end", "Edit", json!({ "file_path": "C:/b.rs", "old_string": "a" }))));
        answered("e1", "always");
        // The same file, another edit: the session allowed edits to it.
        assert!(arrive("e2", &request("s-end", "Edit", json!({ "file_path": "C:/b.rs", "old_string": "b" }))));
        session_ended(&json!({ "hook_event_name": "SessionEnd", "session_id": "s-end" }));
        assert!(!arrive("e3", &request("s-end", "Edit", json!({ "file_path": "C:/b.rs" }))));
    }

    #[test]
    fn the_rules_of_a_session_that_went_quiet_go() {
        assert!(!arrive("q1", &request("s-quiet", "Bash", json!({ "command": "make" }))));
        answered("q1", "always");
        assert!(arrive("q2", &request("s-quiet", "Bash", json!({ "command": "make" }))));
        // No SessionEnd ever came, and it asked nothing for SESSION_IDLE.
        with(&RULES, |rules| {
            if let Some((_, last)) = rules.get_mut("\ns-quiet") {
                *last = Instant::now().checked_sub(SESSION_IDLE + Duration::from_secs(1)).unwrap();
            }
        });
        assert!(!arrive("q3", &request("s-quiet", "Bash", json!({ "command": "make" }))));
    }

    #[test]
    fn agents_never_share_a_session_rule() {
        let mut codex = request("s-agents", "Bash", json!({ "command": "ls" }));
        codex["lumo_agent"] = json!("codex");
        assert!(!arrive("a1", &codex));
        answered("a1", "always");
        assert!(!arrive("a2", &request("s-agents", "Bash", json!({ "command": "ls" }))));
        assert!(arrive("a3", &codex));
    }

    #[test]
    fn a_command_allowed_in_one_folder_is_not_allowed_in_another() {
        let mut here = request("s-dir", "Bash", json!({ "command": "rm -rf build" }));
        here["cwd"] = json!("C:/proj/a");
        assert!(!arrive("d1", &here));
        answered("d1", "always");
        assert!(arrive("d2", &here));
        let mut there = here.clone();
        there["cwd"] = json!("C:/proj/b");
        assert!(!arrive("d3", &there), "another folder");
        // Codex says its folder in the input, and may ask to leave its sandbox.
        let r = |input: Value| rule(&request("s", "shell", input));
        assert_ne!(r(json!({ "command": "ls", "workdir": "C:/a" })), r(json!({ "command": "ls", "workdir": "C:/b" })));
        assert_ne!(r(json!({ "command": "ls" })), r(json!({ "command": "ls", "with_escalated_permissions": true })));
        assert_ne!(r(json!({ "command": "npm start" })), r(json!({ "command": "npm start", "run_in_background": true })));
        assert_eq!(r(json!({ "command": "ls", "timeout": 5 })), r(json!({ "command": "ls", "description": "List" })));
    }

    #[test]
    fn what_counts_as_the_same_request() {
        let r = |tool: &str, input: Value| rule(&request("s", tool, input));
        // An MCP tool: the same call, not every call of the tool.
        assert_ne!(r("mcp__github__create_issue", json!({ "title": "a" })), r("mcp__github__create_issue", json!({ "title": "b" })));
        assert_eq!(r("mcp__github__create_issue", json!({ "title": "a" })), r("mcp__github__create_issue", json!({ "title": "a" })));
        assert_ne!(r("WebFetch", json!({ "url": "https://a.dev" })), r("WebFetch", json!({ "url": "https://b.dev" })));
        // The same address with another method is another request.
        assert_eq!(r("WebFetch", json!({ "url": "https://a.dev", "prompt": "x" })), r("WebFetch", json!({ "url": "https://a.dev", "method": "get" })));
        assert_ne!(r("http", json!({ "url": "https://a.dev/1", "method": "GET" })), r("http", json!({ "url": "https://a.dev/1", "method": "DELETE" })));
        // An MCP server's http tool: only the very same call.
        let get = r("mcp__x__http", json!({ "url": "https://a.dev/1", "method": "GET" }));
        assert_ne!(get, r("mcp__x__http", json!({ "url": "https://a.dev/1", "method": "DELETE" })));
        assert_ne!(r("mcp__fs__write", json!({ "path": "C:/a", "content": "1" })), r("mcp__fs__write", json!({ "path": "C:/a", "content": "2" })));
        assert_eq!(get, r("mcp__x__http", json!({ "url": "https://a.dev/1", "method": "GET" })));
        assert_ne!(r("Bash", json!({ "command": "ls" })), r("PowerShell", json!({ "command": "ls" })));
        assert_eq!(r("AskUserQuestion", json!({ "questions": [] })), None);
        assert_eq!(rule(&json!({ "session_id": "s" })), None);
        // No input, or input that isn't fields: nothing to remember (a rule
        // "bash + null" would allow every other unreadable call).
        assert_eq!(rule(&json!({ "session_id": "s", "tool_name": "bash" })), None);
        assert_eq!(r("bash", json!("rm -rf ~")), None);
        // An MCP tool as Antigravity (`mcp_server_tool`), Copilot or others name
        // it: the same call, not the same path or address with other fields.
        for tool in ["mcp_github_create_or_update_file", "github-mcp-server-create_or_update_file", "github/create_or_update_file"] {
            let readme = |repo: &str, content: &str| r(tool, json!({ "path": "README.md", "repo": repo, "content": content }));
            assert_ne!(readme("public", "a"), readme("private", "a"), "{tool}");
            assert_ne!(readme("public", "a"), readme("public", "b"), "{tool}");
            assert_eq!(readme("public", "a"), readme("public", "a"), "{tool}");
        }
        assert_ne!(r("mcp_fetch_fetch", json!({ "url": "https://a.dev", "body": "1" })), r("mcp_fetch_fetch", json!({ "url": "https://a.dev", "body": "2" })));
        assert_ne!(r("mcp_shell_run", json!({ "command": "ls", "script": "a" })), r("mcp_shell_run", json!({ "command": "ls", "script": "b" })));
        // The agents' own tools keep their rules, in any case.
        assert!(r("RUN_COMMAND", json!({ "command": "ls" })).unwrap().starts_with("RUN_COMMAND\ncommand\nls\n"));
        assert_eq!(r("write_to_file", json!({ "path": "C:/a", "content": "1" })), r("write_to_file", json!({ "path": "C:/a", "content": "2" })));
        // Antigravity's and OpenCode's file tools: the same file, whatever they write there.
        assert_eq!(r("edit_file", json!({ "Path": "C:/a.tex", "Target": "x", "Replacement": "1" })), r("edit_file", json!({ "Path": "C:/a.tex", "Target": "y", "Replacement": "2" })));
        assert_ne!(r("edit_file", json!({ "Path": "C:/a.tex", "Target": "x", "Replacement": "1" })), r("edit_file", json!({ "Path": "C:/b.tex", "Target": "x", "Replacement": "1" })));
        assert_eq!(r("write_to_file", json!({ "TargetFile": "C:/a", "CodeContent": "1" })), Some("write_to_file\nfile\nC:/a".into()));
        assert_eq!(r("create_file", json!({ "Path": "C:/n.md", "Content": "1" })), r("create_file", json!({ "Path": "C:/n.md", "Content": "2" })));
        assert_eq!(r("edit", json!({ "filePath": "C:/a.ts", "oldString": "a", "newString": "b" })), Some("edit\nfile\nC:/a.ts".into()));
        // A command the relay had to cut: never "the same" as another.
        let mut cut = request("s", "Bash", json!({ "command": "npm run build && …" }));
        cut["lumo_input_cut"] = json!(true);
        assert_eq!(rule(&cut), None);
        assert!(!arrive("c1", &cut));
        assert!(!can_remember("c1"));
        // Nor arguments the relay couldn't read.
        let mut unread = request("s", "bash", json!({ "arguments": "{\"command\":\"ls\",\"x\":\"\\ud800\"}" }));
        unread["lumo_input_unread"] = json!(true);
        assert_eq!(rule(&unread), None);
        assert!(!arrive("u1", &unread));
        assert!(!can_remember("u1"));
        // No session id: nothing can be remembered.
        assert!(!arrive("n1", &json!({ "tool_name": "Bash", "tool_input": { "command": "ls" } })));
        assert!(!can_remember("n1"));
    }
}
