// "Allow for this session" on a permission card.
//
// A click on it allows the request on screen, and Lumo remembers it: the same
// request from the same session of the same agent is then allowed without a
// card until that session ends (SessionEnd) or Lumo quits. Nothing is written
// anywhere — the rules live in memory only.
//
// The same request means the same tool with the same command, the same file,
// or — for an MCP tool — the same tool. Anything else needs a card again.
//
// Claude Code also gets the click as `always` (pipe.rs): lumo-hook then hands
// it the session rules Claude Code itself suggested, so it stops asking too.
// Codex, Copilot, Muse and the island chat's Antigravity CLI have no such
// thing, so for them these rules are the whole of it.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use serde_json::Value;

/// Remembered rules: session scope → the requests allowed in it.
static RULES: Mutex<Option<HashMap<String, HashSet<String>>>> = Mutex::new(None);
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
/// URL; the tool alone for an MCP tool; the tool and its whole input otherwise.
/// None for a question, which is answered, not allowed.
pub fn rule(payload: &Value) -> Option<String> {
    let tool = payload.get("tool_name").and_then(Value::as_str).filter(|t| !t.is_empty())?;
    if tool == "AskUserQuestion" {
        return None;
    }
    let input = payload.get("tool_input").unwrap_or(&Value::Null);
    let field = |keys: &[&str]| keys.iter().find_map(|k| input.get(*k).and_then(Value::as_str)).map(str::to_string);
    let what = if let Some(command) = field(&["command", "cmd"]) {
        format!("command\n{command}")
    } else if let Some(path) = field(&["file_path", "notebook_path", "path"]) {
        format!("file\n{path}")
    } else if let Some(url) = field(&["url"]) {
        format!("url\n{url}")
    } else if tool.starts_with("mcp__") {
        "tool".to_string()
    } else {
        format!("input\n{input}")
    };
    Some(format!("{tool}\n{what}"))
}

/// A card for `request_id` is about to come up: what to remember if it is
/// allowed for the session. Returns true when the session already allowed this
/// very request, and no card is needed.
pub fn arrive(request_id: &str, payload: &Value) -> bool {
    let (Some(scope), Some(rule)) = (scope(payload), rule(payload)) else { return false };
    if with(&RULES, |rules| rules.get(&scope).is_some_and(|set| set.contains(&rule))) {
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
        with(&RULES, |rules| rules.entry(scope).or_default().insert(rule));
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
    fn agents_never_share_a_session_rule() {
        let mut codex = request("s-agents", "Bash", json!({ "command": "ls" }));
        codex["lumo_agent"] = json!("codex");
        assert!(!arrive("a1", &codex));
        answered("a1", "always");
        assert!(!arrive("a2", &request("s-agents", "Bash", json!({ "command": "ls" }))));
        assert!(arrive("a3", &codex));
    }

    #[test]
    fn what_counts_as_the_same_request() {
        let r = |tool: &str, input: Value| rule(&request("s", tool, input));
        assert_eq!(r("mcp__github__create_issue", json!({ "title": "a" })), r("mcp__github__create_issue", json!({ "title": "b" })));
        assert_ne!(r("WebFetch", json!({ "url": "https://a.dev" })), r("WebFetch", json!({ "url": "https://b.dev" })));
        assert_ne!(r("Bash", json!({ "command": "ls" })), r("PowerShell", json!({ "command": "ls" })));
        assert_eq!(r("AskUserQuestion", json!({ "questions": [] })), None);
        assert_eq!(rule(&json!({ "session_id": "s" })), None);
        // No session id: nothing can be remembered.
        assert!(!arrive("n1", &json!({ "tool_name": "Bash", "tool_input": { "command": "ls" } })));
        assert!(!can_remember("n1"));
    }
}
