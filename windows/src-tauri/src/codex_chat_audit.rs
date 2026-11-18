// Audit of Codex's subagents (thread "Controllare i sotto-agenti di Antigravity
// e Codex"). Each test FAILS on the code as it is: what Antigravity CLI and
// Claude Code got with PR #318, Codex does not have.

use super::*;

const MAIN: &str = "main-thread";
const SUB: &str = "sub-thread";
const GRANDCHILD: &str = "grandchild-thread";

fn feed(sub: &mut Subagents, line: Value) {
    sub.feed(MAIN, line["method"].as_str().unwrap_or(""), &line["params"]);
}

fn spawned(sub: &mut Subagents, from: &str, to: &str, prompt: &str) {
    feed(sub, json!({ "method": "item/completed", "params": { "threadId": from, "item": {
        "type": "collabAgentToolCall", "id": format!("spawn-{to}"), "tool": "spawnAgent", "status": "completed",
        "senderThreadId": from, "receiverThreadIds": [to], "prompt": prompt, "agentsStates": {} } } }));
}

/// GAP 1: an agent a subagent started (spawnAgent with senderThreadId = the
/// subagent) is a row at the top level, never under the one that started it.
#[test]
fn gap1_a_codex_subagents_own_agent_sits_under_it() {
    let mut sub = Subagents::default();
    spawned(&mut sub, MAIN, SUB, "Coordinate the batches");
    spawned(&mut sub, SUB, GRANDCHILD, "Do batch 1");
    assert_eq!(sub.agents.get(GRANDCHILD).unwrap().parent.as_deref(), Some(SUB));
}

/// GAP 2: a subagent's own plan (turn/plan/updated on its thread) never
/// reaches its row: Codex rows have no plan chip.
#[test]
fn gap2_a_codex_subagents_plan_is_on_its_row() {
    let mut sub = Subagents::default();
    spawned(&mut sub, MAIN, SUB, "Fix the parser");
    feed(&mut sub, json!({ "method": "turn/plan/updated", "params": { "threadId": SUB, "plan": [
        { "step": "Read the parser", "status": "completed" }, { "step": "Fix it", "status": "inProgress" } ] } }));
    assert!(sub.agents.get(SUB).unwrap().plan.is_some());
}

/// BUG: a subagent's permission request (its own threadId) is answered at
/// once with "Lumo does not handle …" instead of the island's card.
#[test]
fn bug_a_subagents_permission_request_is_not_refused_with_an_error() {
    let answer = other_answer("item/commandExecution/requestApproval");
    assert!(answer.get("error").is_none(), "got {answer}");
}
