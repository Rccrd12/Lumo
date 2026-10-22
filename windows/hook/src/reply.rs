//! What the relay prints back to the agent — the only place that knows each
//! agent's stdout contract. Same replies as the Mac relay (HookServer.swift).
//!
//! The one rule that matters: **nothing that allows anything is ever printed
//! without a decision a human clicked.** With no decision the reply is silence,
//! an empty `{}`, or Copilot's explicit "ask", and every agent then asks in its
//! own terminal exactly as if Lumo were not installed.

use serde_json::{json, Map, Value};

/// The agents whose permission requests the island can answer: Claude Code
/// (no `--agent`), Codex, Copilot CLI and Muse Code. Any decision for another
/// agent is ignored here too, whatever the app sent.
pub fn takes_decisions(agent: &str) -> bool {
    matches!(agent, "" | "codex" | "copilot" | "muse")
}

/// Agents that read a JSON object on stdout after every hook and get `{}` —
/// "no opinion" — when there is nothing to say.
fn wants_json(agent: &str) -> bool {
    matches!(agent, "gemini" | "antigravity" | "copilot" | "muse")
}

/// The line to print for `event` from `agent`, given the island's `decision`
/// (`None`: nobody clicked) and, for Claude Code's AskUserQuestion, the
/// question as it was asked.
pub fn stdout(agent: &str, event: &str, decision: Option<&str>, question: Option<&Value>) -> Option<String> {
    if event != "PermissionRequest" {
        // Antigravity reads "{}" on PreToolUse as a denial. "ask" keeps its own prompt
        // (and the user's Always Allow): Lumo never allows a tool by itself.
        if agent.eq_ignore_ascii_case("antigravity") && event == "PreToolUse" {
            return Some(r#"{"decision":"ask"}"#.to_string());
        }
        return wants_json(agent).then(|| "{}".to_string());
    }
    let decision = decision.filter(|_| takes_decisions(agent));
    match agent {
        // Copilot CLI and Muse Code read a bare permissionDecision. Copilot is
        // fail-closed: it must always get valid JSON, so silence is an "ask".
        "copilot" | "muse" => {
            let word = match decision.map(str::trim) {
                Some("allow" | "always") => Some("allow"),
                Some("deny") => Some("deny"),
                _ => None,
            };
            match word {
                Some(word) => Some(json!({ "permissionDecision": word }).to_string()),
                None if agent == "copilot" => Some(json!({ "permissionDecision": "ask" }).to_string()),
                None => None,
            }
        }
        // Claude Code and Codex share the documented hookSpecificOutput. Only
        // Claude Code asks questions.
        "" => decision.and_then(|d| decision_json(d, question)),
        _ => decision.and_then(|d| decision_json(d, None)),
    }
}

/// The Antigravity tools the island's own chat (antigravity_cli.rs) shows a
/// card for: shell commands, MCP tools and the browser — what agy would ask
/// about, and what runs on nobody's say once agy's own confirmation is off.
/// Reading and writing workspace files needs none.
pub fn island_card_tool(tool: &str) -> bool {
    island_card(tool, None)
}

/// `island_card_tool`, knowing the call's input: a call of Lumo's own email
/// or plan tool through agy's `call_mcp_tool` gets no card either.
pub fn island_card(tool: &str, input: Option<&serde_json::Value>) -> bool {
    // Lumo's email tools only read the user's mailbox, its plan tool only shows (mcp.rs).
    if crate::mcp::lumo_call(tool, input).is_some_and(|name| crate::mcp::MAIL_NAMES.contains(&name) || name == crate::mcp::PLAN_NAME) {
        return false;
    }
    let tool = tool.to_ascii_lowercase();
    ["command", "shell", "terminal", "mcp", "browser"].iter().any(|w| tool.contains(w))
}

/// An Antigravity file tool that changes something (`write_to_file`,
/// `replace_file_content`…) outside the run's workspace (`workspaces`, agy's
/// `workspacePaths`). agy would ask about it, but its own confirmation is off
/// in the island's chat, so it is a card. A path that cannot be placed for
/// sure (`..`, no workspace known) is one too. Reading stays free: the chat
/// reads the documents the user has open, wherever they are.
pub fn writes_outside(tool: &str, input: Option<&Value>, workspaces: &[String]) -> bool {
    let tool = tool.to_ascii_lowercase();
    if !["write", "replace", "edit", "delete", "remove", "move", "rename", "create"].iter().any(|w| tool.contains(w)) {
        return false;
    }
    let Some(input) = input.and_then(Value::as_object) else { return false };
    let roots: Vec<String> = workspaces.iter().map(|w| norm_path(w)).filter(|w| !w.is_empty()).collect();
    input
        .iter()
        .filter(|(key, _)| ["file", "path", "target", "dest"].iter().any(|w| key.to_ascii_lowercase().contains(w)))
        .filter_map(|(_, value)| value.as_str())
        .filter(|path| !path.trim().is_empty())
        .any(|path| {
            let p = norm_path(path);
            if p.split('/').any(|part| part == "..") {
                return true;
            }
            // A relative path is the workspace's own.
            let absolute = p.starts_with('/') || p.as_bytes().get(1) == Some(&b':');
            absolute && !roots.iter().any(|r| p == *r || p.starts_with(&format!("{r}/")))
        })
}

/// A path to compare: forward slashes, lower case (Windows), no `file://`, no trailing slash.
fn norm_path(path: &str) -> String {
    let p = path.trim();
    let p = p.strip_prefix("file:///").or_else(|| p.strip_prefix("file://")).unwrap_or(p);
    let p = p.replace('\\', "/").to_lowercase();
    let p = if p.as_bytes().get(2) == Some(&b':') && p.starts_with('/') { p[1..].to_string() } else { p };
    p.trim_end_matches('/').to_string()
}

/// The tools of the island's Claude Code chat (asking every time) that get a
/// card from its PreToolUse hook: what runs a command, changes a file or goes
/// to the network or an MCP server. Reading is left to Claude Code.
pub fn claude_card_tool(tool: &str) -> bool {
    // Lumo's tools that only look (a screenshot, a wait) or read email need no card.
    let looking = tool.starts_with("mcp__") && crate::mcp::lumo_tool(tool).is_some_and(crate::mcp::only_reads);
    // The user's own tools: Lumo asks for each call itself (tools.rs approve).
    let users = tool.starts_with("mcp__lumo_tools__");
    !looking
        && !users
        && (matches!(tool, "Bash" | "PowerShell" | "Edit" | "MultiEdit" | "Write" | "NotebookEdit" | "WebFetch")
            || tool.starts_with("mcp__"))
}

/// Whether a shell command would sit waiting for something to happen: GitHub's
/// own watchers (`gh pr checks --watch`, `gh run watch`), a long sleep, or a
/// loop that sleeps. Such a command holds the island's chat with nothing to
/// show; Lumo listens instead (claude_wait_denied).
pub fn blocking_wait(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| c.is_whitespace() || matches!(c, ';' | '&' | '|' | '(' | ')' | '{' | '}' | '"' | '\''))
        .filter(|w| !w.is_empty())
        .collect();
    let has = |seq: &[&str]| words.windows(seq.len()).any(|w| w == seq);
    if (has(&["gh", "pr", "checks"]) && words.contains(&"--watch")) || has(&["gh", "run", "watch"]) {
        return true;
    }
    let sleeps: Vec<usize> = words
        .iter()
        .enumerate()
        .filter(|(_, w)| matches!(**w, "sleep" | "start-sleep" | "timeout"))
        .map(|(i, _)| i)
        .collect();
    if sleeps.is_empty() {
        return false;
    }
    if words.iter().any(|w| matches!(*w, "while" | "until" | "for" | "do")) {
        return true;
    }
    // A single long sleep: the first number after it, in seconds (30, 30s, 2m, 1h).
    sleeps.iter().any(|&i| {
        words[i + 1..].iter().take(3).find_map(|w| seconds(w.trim_start_matches(['-', '/']))).is_some_and(|s| s >= 30.0)
    })
}

fn seconds(word: &str) -> Option<f64> {
    let (num, unit) = word.split_at(word.find(|c: char| !c.is_ascii_digit() && c != '.').unwrap_or(word.len()));
    let n: f64 = num.parse().ok()?;
    match unit {
        "" | "s" => Some(n),
        "m" => Some(n * 60.0),
        "h" => Some(n * 3600.0),
        _ => None,
    }
}

/// Claude Code's PreToolUse reply to a command that would wait on GitHub:
/// denied, with what to do instead.
pub fn claude_wait_denied() -> String {
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "Lumo: do not wait for GitHub (or anything else) in a command, it holds the user's chat. Write [[listen owner/repo#123 event: what to do then]] on a line of its own in your answer instead, say Lumo is listening, and end your answer: Lumo watches GitHub and messages you when it happens.",
        }
    })
    .to_string()
}

/// Claude Code's PreToolUse reply to such a card: allowed only after a click
/// on Allow. Anything else is a deny, with a reason Claude reads: `-p` has
/// nobody else to ask.
pub fn claude_island(decision: Option<&str>) -> String {
    let (verdict, reason) = match decision.map(str::trim) {
        Some("allow" | "always") => ("allow", "Allowed in Lumo"),
        Some("deny") => ("deny", "Denied in Lumo"),
        _ => ("deny", "Nobody approved it in Lumo"),
    };
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": verdict,
            "permissionDecisionReason": reason,
        }
    })
    .to_string()
}

/// Antigravity's PreToolUse reply to such a card: `allow` only after a click
/// on Allow. Anything else — Deny, no click in time, an answer not understood
/// — is a deny: with agy's own confirmation off, nothing else stops it.
pub fn antigravity_island(decision: Option<&str>) -> String {
    match decision.map(str::trim) {
        Some("allow" | "always") => r#"{"decision":"allow"}"#.to_string(),
        Some("deny") => r#"{"decision":"deny","reason":"Denied from Lumo"}"#.to_string(),
        _ => r#"{"decision":"deny","reason":"Nobody approved it in Lumo"}"#.to_string(),
    }
}

/// The documented PermissionRequest output. Anything we do not recognise prints
/// nothing at all rather than guessing — silence is the safe answer.
/// See https://code.claude.com/docs/en/hooks
///
/// `question` is the AskUserQuestion input, when that is what is being asked:
/// the island may then answer it, which Claude Code takes as the same input
/// with an `answers` map added. Nothing else of the input can be changed from
/// the island, and no other tool's input can be changed at all.
pub fn decision_json(decision: &str, question: Option<&Value>) -> Option<String> {
    if decision.trim_start().starts_with('{') {
        let reply = serde_json::from_str::<Value>(decision).ok()?;
        let answers = reply.get("answers")?.as_object()?;
        let question = question?;
        if !answers_fit(question, answers) {
            return None;
        }
        let mut input = question.as_object()?.clone();
        input.insert("answers".into(), Value::Object(answers.clone()));
        return Some(
            json!({
                "hookSpecificOutput": {
                    "hookEventName": "PermissionRequest",
                    "decision": { "behavior": "allow", "updatedInput": input },
                }
            })
            .to_string(),
        );
    }
    let behavior = match decision.trim() {
        // "always" still answers a plain allow; remembering it is the island's
        // business, not the agent's.
        "allow" | "always" => r#"{"behavior":"allow"}"#.to_string(),
        "deny" => r#"{"behavior":"deny","message":"Denied from Lumo"}"#.to_string(),
        _ => return None,
    };
    Some(format!(
        r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{behavior}}}}}"#
    ))
}

/// True when `answers` answers exactly the questions Claude Code asked: one entry
/// per question, keyed by its text; a single-select answer is one of its option
/// labels (a string), a multi-select answer a non-empty list of distinct labels
/// (Claude Code 2.1.136+ takes the list, as the Mac sends it). Same rule as
/// `QuestionPayload.accepts` on macOS.
fn answers_fit(question: &Value, answers: &Map<String, Value>) -> bool {
    let Some(items) = question.get("questions").and_then(|q| q.as_array()) else { return false };
    if items.is_empty() || items.len() != answers.len() {
        return false;
    }
    items.iter().all(|item| {
        let Some(text) = item.get("question").and_then(|q| q.as_str()) else { return false };
        let labels: Vec<&str> = item
            .get("options")
            .and_then(|o| o.as_array())
            .map(|opts| opts.iter().filter_map(|o| o.get("label").and_then(|l| l.as_str())).collect())
            .unwrap_or_default();
        let multi = item.get("multiSelect").and_then(|m| m.as_bool()).unwrap_or(false);
        match answers.get(text) {
            Some(Value::String(pick)) if !multi => labels.contains(&pick.as_str()),
            Some(Value::Array(picks)) if multi => {
                let picks: Vec<&str> = picks.iter().filter_map(|p| p.as_str()).collect();
                let mut seen = picks.clone();
                seen.sort_unstable();
                seen.dedup();
                !picks.is_empty() && seen.len() == picks.len() && picks.iter().all(|p| labels.contains(p))
            }
            _ => false,
        }
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_command_that_would_wait_on_github_is_told_to_let_lumo_listen() {
        for cmd in [
            "gh pr checks 22 --watch",
            "gh pr merge 22 --squash && gh pr checks 22 --watch --interval 30",
            "gh run watch 123456",
            "sleep 60 && gh pr view 22",
            "Start-Sleep -Seconds 120; gh pr view 22",
            "while true; do gh pr view 22 --json state; sleep 10; done",
            "until gh pr view 22 --json mergedAt -q .mergedAt | grep -q T; do sleep 5; done",
            "timeout /t 90",
        ] {
            assert!(blocking_wait(cmd), "{cmd}");
        }
        for cmd in ["gh pr merge 22 --squash", "gh pr checks 22", "sleep 2 && ls", "npm test -- --timeout 30000", "git status"] {
            assert!(!blocking_wait(cmd), "{cmd}");
        }
        let v: serde_json::Value = serde_json::from_str(&claude_wait_denied()).unwrap();
        assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "deny");
        assert!(v["hookSpecificOutput"]["permissionDecisionReason"].as_str().unwrap().contains("[[listen"));
    }

    use super::*;

    const AGENTS: &[&str] = &[
        "", "gemini", "antigravity", "cursor", "codex", "copilot", "muse", "opencode", "amp",
        "hermes", "claude-desktop", "my-tool",
    ];
    const EVENTS: &[&str] = &[
        "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure",
        "PermissionRequest", "Notification", "Stop", "StopFailure", "SessionEnd", "Interrupt",
        "SubagentStart", "SubagentStop", "",
    ];

    /// Whatever a reply says, does it let anything through?
    fn allows(out: &str) -> bool {
        let v: Value = serde_json::from_str(out).expect("every reply is JSON");
        let text = v.to_string();
        // Any decision counts as one, except "ask" (Antigravity's PreToolUse): that hands the
        // choice back to the agent's own prompt.
        let decided = v.get("decision").is_some_and(|d| d.as_str() != Some("ask"));
        text.contains("allow") || decided || v.get("permission").is_some() || v.get("continue").is_some()
    }

    #[test]
    fn nothing_is_ever_allowed_without_a_decision() {
        for agent in AGENTS {
            for event in EVENTS {
                if let Some(out) = stdout(agent, event, None, None) {
                    assert!(!allows(&out), "{agent:?} {event} printed {out} with nobody clicking");
                }
                // A decline, a timeout or garbage from the app is no decision either.
                for not_a_decision in ["", "ask", "maybe", "{\"permissionDecision\":\"allow\"}"] {
                    if let Some(out) = stdout(agent, event, Some(not_a_decision), None) {
                        assert!(!allows(&out), "{agent:?} {event} {not_a_decision:?} printed {out}");
                    }
                }
            }
        }
    }

    #[test]
    fn a_decision_only_counts_on_a_permission_request_from_an_agent_that_takes_one() {
        for agent in AGENTS {
            for event in EVENTS.iter().filter(|e| **e != "PermissionRequest") {
                if let Some(out) = stdout(agent, event, Some("allow"), None) {
                    assert!(!allows(&out), "{agent:?} {event}: {out}");
                }
            }
            let out = stdout(agent, "PermissionRequest", Some("allow"), None);
            assert_eq!(out.as_deref().is_some_and(allows), takes_decisions(agent), "{agent:?}: {out:?}");
        }
    }

    #[test]
    fn each_agent_gets_its_own_reply_shape() {
        let allow = r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#;
        let deny = r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied from Lumo"}}}"#;
        for agent in ["", "codex"] {
            assert_eq!(stdout(agent, "PermissionRequest", Some("allow"), None).unwrap(), allow);
            assert_eq!(stdout(agent, "PermissionRequest", Some("always"), None).unwrap(), allow);
            assert_eq!(stdout(agent, "PermissionRequest", Some("deny"), None).unwrap(), deny);
            assert_eq!(stdout(agent, "PermissionRequest", None, None), None);
            assert_eq!(stdout(agent, "PreToolUse", None, None), None);
        }
        for agent in ["copilot", "muse"] {
            assert_eq!(stdout(agent, "PermissionRequest", Some("allow"), None).unwrap(), r#"{"permissionDecision":"allow"}"#);
            assert_eq!(stdout(agent, "PermissionRequest", Some("deny"), None).unwrap(), r#"{"permissionDecision":"deny"}"#);
            assert_eq!(stdout(agent, "PreToolUse", None, None).unwrap(), "{}");
        }
        // Copilot is fail-closed: no decision is an explicit "ask", never silence.
        assert_eq!(stdout("copilot", "PermissionRequest", None, None).unwrap(), r#"{"permissionDecision":"ask"}"#);
        assert_eq!(stdout("muse", "PermissionRequest", None, None), None);
        // Antigravity needs a decision on PreToolUse: "ask" leaves it to Antigravity's own prompt;
        // other lifecycle events receive "{}".
        assert_eq!(stdout("antigravity", "PreToolUse", None, None).unwrap(), r#"{"decision":"ask"}"#);
        for event in ["PostToolUse", "UserPromptSubmit", "Stop"] {
            assert_eq!(stdout("antigravity", event, None, None).unwrap(), "{}");
        }
        // Gemini CLI reads "{}" as "no opinion".
        for event in ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"] {
            assert_eq!(stdout("gemini", event, None, None).unwrap(), "{}");
        }
        // Cursor: silence, which Cursor reads as "carry on as usual".
        for event in ["PreToolUse", "UserPromptSubmit", "Stop"] {
            assert_eq!(stdout("cursor", event, None, None), None);
        }
        // Hermes approvals are not supported: its decisions are never relayed.
        assert_eq!(stdout("hermes", "PermissionRequest", Some("allow"), None), None);
    }

    #[test]
    fn the_islands_antigravity_chat_is_allowed_only_after_a_click() {
        assert_eq!(antigravity_island(Some("allow")), r#"{"decision":"allow"}"#);
        assert_eq!(antigravity_island(Some("always")), r#"{"decision":"allow"}"#);
        assert_eq!(antigravity_island(Some("deny")), r#"{"decision":"deny","reason":"Denied from Lumo"}"#);
        for not_a_decision in [None, Some(""), Some("ask"), Some("maybe"), Some(r#"{"permissionDecision":"allow"}"#)] {
            let out = antigravity_island(not_a_decision);
            assert_eq!(out, r#"{"decision":"deny","reason":"Nobody approved it in Lumo"}"#, "{not_a_decision:?}");
        }
        assert!(island_card_tool("run_command"));
        assert!(island_card_tool("send_command_input"));
        assert!(island_card_tool("Shell"));
        assert!(!island_card_tool("view_file"));
        assert!(island_card_tool("mcp_github_create_issue"));
        assert!(island_card_tool("browser_click"));
        assert!(!island_card_tool("write_to_file"));
        let ws = ["C:\\Users\\me\\Lumo".to_string(), "C:\\Users\\me\\AppData\\Local\\com.rccrd12.lumo\\inbox".to_string()];
        let w = |tool: &str, input: Value| writes_outside(tool, Some(&input), &ws);
        assert!(w("write_to_file", json!({"TargetFile": "C:\\Users\\Public\\lumo-test.txt"})), "outside: a card");
        assert!(!w("write_to_file", json!({"TargetFile": "c:/users/me/lumo/src/a.rs"})), "its own folder");
        assert!(!w("replace_file_content", json!({"TargetFile": "file:///C:/Users/me/Lumo/a.md"})));
        assert!(!w("write_to_file", json!({"TargetFile": "notes/a.md"})), "relative: the workspace's");
        assert!(w("write_to_file", json!({"TargetFile": "C:\\Users\\me\\Lumo\\..\\x.txt"})), "leaves it");
        assert!(w("write_to_file", json!({"TargetFile": "C:\\Users\\me\\Lumo2\\x.txt"})), "a sibling is not inside");
        assert!(!w("view_file", json!({"AbsolutePath": "C:\\Users\\Public\\a.pdf"})), "reading is free");
        assert!(writes_outside("write_to_file", Some(&json!({"TargetFile": "/x/a"})), &[]), "no workspace known");
        assert!(!island_card_tool(""));
        assert!(!island_card_tool("mcp_lumo_mail_recent") && !island_card_tool("lumo/mail_read"), "Lumo's email only reads");
        assert!(island_card_tool("mcp_gmail_send_message"));
    }

    #[test]
    fn the_claude_chats_card_answers_its_pre_tool_use() {
        let allow: Value = serde_json::from_str(&claude_island(Some("allow"))).unwrap();
        assert_eq!(allow["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(allow["hookSpecificOutput"]["permissionDecision"], "allow");
        for not_allowed in [Some("deny"), None, Some(""), Some("maybe")] {
            let v: Value = serde_json::from_str(&claude_island(not_allowed)).unwrap();
            assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "deny", "{not_allowed:?}");
        }
        assert!(claude_card_tool("Bash") && claude_card_tool("PowerShell") && claude_card_tool("Write"));
        assert!(claude_card_tool("mcp__github__create_issue"));
        // Lumo's computer use: what acts gets a card, what only looks does not.
        assert!(claude_card_tool("mcp__lumo__left_click") && claude_card_tool("mcp__lumo__type") && claude_card_tool("mcp__lumo__key"));
        assert!(!claude_card_tool("mcp__lumo__screenshot") && !claude_card_tool("mcp__lumo__zoom") && !claude_card_tool("mcp__lumo__wait"));
        assert!(claude_card_tool("mcp__lumo2__screenshot"), "another server's screenshot is its own");
        assert!(!claude_card_tool("mcp__lumo_tools__benchmark"), "Lumo asks for the user's tools itself");
        assert!(!claude_card_tool("Read") && !claude_card_tool("Grep") && !claude_card_tool("AskUserQuestion"));
    }

    #[test]
    fn decision_json_matches_the_documented_shape() {
        assert_eq!(
            decision_json("allow", None).unwrap(),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert!(decision_json("always", None).unwrap().contains(r#""behavior":"allow""#));
    }

    #[test]
    fn anything_unrecognised_prints_nothing() {
        assert!(decision_json("", None).is_none());
        assert!(decision_json("maybe", None).is_none());
        // The shape the app used to send must not be mistaken for a decision.
        assert!(decision_json(r#"{"permissionDecision":"allow"}"#, None).is_none());
    }

    #[test]
    fn an_answered_question_goes_back_as_the_same_input_plus_answers() {
        let question = json!({
            "questions": [{ "question": "Which one?", "options": [{ "label": "A" }, { "label": "B" }] }]
        });
        let out = stdout("", "PermissionRequest", Some(r#"{"answers":{"Which one?":"B"}}"#), Some(&question)).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        let decision = &v["hookSpecificOutput"]["decision"];
        assert_eq!(decision["behavior"], "allow");
        assert_eq!(decision["updatedInput"]["questions"], question["questions"]);
        assert_eq!(decision["updatedInput"]["answers"]["Which one?"], "B");
        // Only Claude Code asks questions: an answer for anyone else is nothing.
        assert!(stdout("codex", "PermissionRequest", Some(r#"{"answers":{"Which one?":"B"}}"#), Some(&question)).is_none());
    }

    #[test]
    fn answers_are_only_accepted_for_a_question() {
        assert!(decision_json(r#"{"answers":{"q":"a"}}"#, None).is_none());
        let question = json!({ "questions": [] });
        assert!(decision_json(r#"{"answers":{}}"#, Some(&question)).is_none());
        assert!(decision_json(r#"{"answers":{"q":1}}"#, Some(&question)).is_none());
        assert!(decision_json(r#"{"command":"rm -rf /"}"#, Some(&question)).is_none());
    }

    #[test]
    fn answers_must_match_the_questions_asked() {
        let q = json!({ "questions": [
            { "question": "Which one?", "options": [{ "label": "A" }, { "label": "B" }] },
            { "question": "Extras?", "multiSelect": true,
              "options": [{ "label": "Tests" }, { "label": "Docs" }, { "label": "Lint" }] }
        ]});
        let ok = |a: &str| decision_json(a, Some(&q)).is_some();
        assert!(ok(r#"{"answers":{"Which one?":"A","Extras?":["Tests","Docs"]}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":"C","Extras?":["Tests"]}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":"A","Extras?":["Tests"],"Other?":"x"}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":"A"}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":["A"],"Extras?":["Tests"]}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":"A","Extras?":"Tests"}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":"A","Extras?":[]}}"#));
        assert!(!ok(r#"{"answers":{"Which one?":"A","Extras?":["Tests","Tests"]}}"#));
    }
}
