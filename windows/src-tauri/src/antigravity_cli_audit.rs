// Audit of the subagents of Antigravity CLI (thread "Controllare i sotto-agenti
// di Antigravity e Codex"). Every test here FAILS on the code as it is: each
// one is a bug, written as the behaviour the user should see.

use super::*;

fn brain() -> PathBuf {
    let b = std::env::temp_dir().join(format!("lumo-audit-{}", chat_agents::run_mark())).join(".gemini").join("antigravity-cli").join("brain");
    std::fs::create_dir_all(&b).unwrap();
    b
}

fn transcript(brain: &std::path::Path, id: &str) -> (PathBuf, String) {
    let logs = brain.join(id).join(".system_generated").join("logs");
    std::fs::create_dir_all(&logs).unwrap();
    let path = logs.join("transcript.jsonl");
    let slashed = path.to_string_lossy().replace('\\', "/");
    let uri = if slashed.starts_with('/') { format!("file://{slashed}") } else { format!("file:///{slashed}") };
    (path, uri)
}

fn append(path: &std::path::Path, lines: &[String]) {
    use std::io::Write as _;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
    for l in lines {
        writeln!(f, "{l}").unwrap();
    }
}

fn started_by(sender: &str, prompt: &str) -> String {
    json!({ "source": "SYSTEM", "type": "SYSTEM_MESSAGE", "status": "DONE", "content": format!("[Message] sender={sender} content={prompt}") }).to_string()
}

fn calls(calls: Value) -> String {
    json!({ "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE", "tool_calls": calls }).to_string()
}

fn result(content: &str) -> String {
    json!({ "source": "MODEL", "type": "GENERIC", "status": "DONE", "content": content }).to_string()
}

fn answer(text: &str) -> String {
    json!({ "source": "MODEL", "type": "PLANNER_RESPONSE", "status": "DONE", "content": text }).to_string()
}

/// The main stream starting one subagent per role, its transcript at `uri` (DONE: it names it).
fn spawn(step: u64, role: &str, conv: &str, uri: &str) -> String {
    json!({ "event": "step_update", "step_update": { "conversation_id": "main-1", "step_index": step, "state": "DONE", "step_type": "subagent", "tool_name": "invoke_subagent",
        "subagent_info": { "subagents": [{ "type_name": "self", "role": role, "conversation_id": conv, "log_uri": uri }] } } })
    .to_string()
}

fn invoke(roles: &[(&str, &str)]) -> String {
    let list: Vec<Value> = roles.iter().map(|(r, p)| json!({ "role": r, "initial_prompt": p })).collect();
    calls(json!([{ "name": "invoke_subagent", "args": { "Subagents": Value::Array(list).to_string() } }]))
}

fn kids_of<'a>(run: &'a Run, parent: &str) -> Vec<&'a AgentRow> {
    run.subagents.agents.ids().filter_map(|id| run.subagents.agents.get(&id)).filter(|r| r.parent.as_deref() == Some(parent)).collect()
}

fn clean(brain: &std::path::Path) {
    let _ = std::fs::remove_dir_all(brain.parent().unwrap().parent().unwrap().parent().unwrap());
}

/// BUG 1: two coordinators at work. A's child shows in the same look as A's
/// call that started it, while B still waits for one of its own: A's child
/// is marked "looked at" before A asked for it, and is never shown. A then
/// waits 30 s ("0 of 1 finished") and turns Done while its child still works.
#[test]
fn bug1_a_child_seen_while_a_sibling_waits_is_never_lost() {
    let brain = brain();
    let (a, ua) = transcript(&brain, "coord-a");
    let (b, ub) = transcript(&brain, "coord-b");
    let mut run = Run::default();
    run.feed(spawn(2, "Coordinator A", "coord-a", &ua).as_bytes());
    run.feed(spawn(3, "Coordinator B", "coord-b", &ub).as_bytes());
    let row_a = run.subagents.spawns[0].row.clone();
    // B asked for a child that has not shown yet: B is "wanted".
    append(&b, &[started_by("main-1", "Batch B"), invoke(&[("B child", "Do B")])]);
    append(&a, &[started_by("main-1", "Batch A")]);
    run.subagents.read_transcripts();
    // In the next 1.5 s: A starts its child, and the child's transcript appears.
    append(&a, &[invoke(&[("A child", "Do A")])]);
    let (ac, _) = transcript(&brain, "a-child");
    append(&ac, &[started_by("coord-a", "Do A")]);
    run.subagents.read_transcripts();
    run.subagents.read_transcripts();
    let titles: Vec<String> = kids_of(&run, &row_a).iter().map(|r| r.title.clone()).collect();
    clean(&brain);
    assert_eq!(titles, ["A child"], "A's child must show under A");
}

/// BUG 2: a coordinator starts "Tester" then "Reviewer". Their folders in
/// agy's brain are found in folder order (on NTFS: by name, a random id),
/// and each takes the next role in the list: the titles can be swapped.
#[test]
fn bug2_each_child_gets_the_role_its_call_gave_it() {
    for (first, second) in [("zz-child", "aa-child"), ("aa-child", "zz-child")] {
        let brain = brain();
        let (c, uc) = transcript(&brain, "coord");
        let mut run = Run::default();
        run.feed(spawn(2, "Coordinator", "coord", &uc).as_bytes());
        let coord = run.subagents.spawns[0].row.clone();
        append(&c, &[started_by("main-1", "Coordinate"), invoke(&[("Tester", "Run the tests"), ("Reviewer", "Review the diff")])]);
        run.subagents.read_transcripts();
        let (t, _) = transcript(&brain, first);
        append(&t, &[started_by("coord", "Run the tests")]);
        let (r, _) = transcript(&brain, second);
        append(&r, &[started_by("coord", "Review the diff")]);
        run.subagents.read_transcripts();
        let tester = run.subagents.spawns.iter().find(|s| s.conversation.as_deref() == Some(first)).map(|s| s.row.clone()).unwrap();
        let title = run.subagents.agents.get(&tester).unwrap().title.clone();
        let parent = run.subagents.agents.get(&tester).unwrap().parent.clone();
        clean(&brain);
        assert_eq!(parent.as_deref(), Some(coord.as_str()));
        assert_eq!(title, "Tester", "the child told to run the tests (folder {first}) is the Tester");
    }
}

/// BUG 3: a subagent that tells one of its own subagents what to do
/// (send_message to the child) has that order taken as its report: its
/// summary, and the reply of a question the user asked it, are the order.
#[test]
fn bug3_a_message_to_its_own_child_is_not_its_report() {
    let brain = brain();
    let (c, uc) = transcript(&brain, "coord");
    let mut run = Run::default();
    run.feed(spawn(2, "Coordinator", "coord", &uc).as_bytes());
    let coord = run.subagents.spawns[0].row.clone();
    append(&c, &[
        started_by("main-1", "Coordinate"),
        calls(json!([{ "name": "send_message", "args": { "Recipient": "\"child-1\"", "Message": "\"Now do batch 2, skip the docs\"" } }])),
        result("Message sent to \"child-1\"."),
        answer("Both batches are done: 14 files fixed."),
    ]);
    run.subagents.read_transcripts();
    let summary = run.subagents.agents.get(&coord).unwrap().summary.clone();
    clean(&brain);
    assert_eq!(summary.as_deref(), Some("Both batches are done: 14 files fixed."));
}

/// BUG 4: any call whose name has "subagent" in it counts as starting one:
/// define_subagent, manage_subagents (kill), and an invoke_subagent that
/// failed. The subagent then "waits for its subagents: 0 of 1 finished" for
/// 30 s after its answer, for a child that never existed.
#[test]
fn bug4_only_a_call_that_started_a_subagent_counts() {
    for (name, args, res) in [
        ("define_subagent", json!({ "Name": "\"reviewer\"", "Prompt": "\"Review code\"" }), "Defined subagent reviewer."),
        ("manage_subagents", json!({ "Action": "\"kill\"", "ConversationIds": "[\"x\"]" }), "Killed 1 subagent."),
        ("invoke_subagent", json!({ "Subagents": "[{\"type_name\":\"reviewer\"}]" }), "Error: subagent reviewer not found or not allowed to be invoked"),
    ] {
        let brain = brain();
        let (c, uc) = transcript(&brain, "sub");
        let mut run = Run::default();
        run.feed(spawn(2, "Helper", "sub", &uc).as_bytes());
        let row = run.subagents.spawns[0].row.clone();
        append(&c, &[started_by("main-1", "Help"), calls(json!([{ "name": name, "args": args }])), result(res), answer("Done.")]);
        run.subagents.read_transcripts();
        let state = run.subagents.agents.get(&row).unwrap().state;
        let now = run.subagents.agents.get(&row).unwrap().now.clone();
        clean(&brain);
        assert_eq!(state, AgentState::Done, "{name}: it answered and started nobody, yet shows {now:?}");
    }
}

/// BUG 5: a coordinator stops one of its own subagents (manage_subagents
/// kill, in its transcript): that row is never told, it goes on "working"
/// (then "No signal") until the turn ends, and then turns green Done.
#[test]
fn bug5_a_child_its_coordinator_stopped_is_stopped() {
    let brain = brain();
    let (c, uc) = transcript(&brain, "coord");
    let mut run = Run::default();
    run.feed(spawn(2, "Coordinator", "coord", &uc).as_bytes());
    append(&c, &[started_by("main-1", "Coordinate"), invoke(&[("Slow one", "Do it")])]);
    run.subagents.read_transcripts();
    let (k, _) = transcript(&brain, "kid");
    append(&k, &[started_by("coord", "Do it")]);
    run.subagents.read_transcripts();
    let kid = run.subagents.resolve("kid").unwrap();
    append(&c, &[calls(json!([{ "name": "manage_subagents", "args": { "Action": "\"kill\"", "ConversationIds": "[\"kid\"]" } }])), result("Killed 1 subagent.")]);
    run.subagents.read_transcripts();
    let state = run.subagents.agents.get(&kid).unwrap().state;
    clean(&brain);
    assert_eq!(state, AgentState::Stopped);
}

/// BUG 6: the turn's answer came while a subagent was still at work (its
/// transcript has no answer): Lumo ends agy and every process it started,
/// and the row says Done, green, with no summary. It never finished: it
/// was cut off, and should say so (and offer Resume).
#[test]
fn bug6_a_subagent_cut_off_by_the_end_of_the_turn_is_not_done() {
    let brain = brain();
    let (c, uc) = transcript(&brain, "sub");
    let mut run = Run::default();
    run.feed(spawn(2, "Writer", "sub", &uc).as_bytes());
    let row = run.subagents.spawns[0].row.clone();
    append(&c, &[started_by("main-1", "Write the docs"), calls(json!([{ "name": "write_file", "args": { "Path": "\"C:\\\\w\\\\a.md\"" } }]))]);
    run.subagents.read_transcripts();
    run.feed(br#"{"event":"result","result":{"status":"SUCCESS","response":"I started a writer.","conversation_id":"main-1"}}"#);
    // What run_with_subagents does once the answer is in.
    run.subagents.read_transcripts();
    run.subagents.run_ended(AgentState::Done);
    let state = run.subagents.agents.get(&row).unwrap().state;
    clean(&brain);
    assert_ne!(state, AgentState::Done, "it never answered: it was cut off");
}

/// BUG 7: with 10 or more subagents from one call, Ask on the 10th is sent
/// to the 1st: its row id `agy-<mark>-2-10` holds the 1st's `agy-<mark>-2-1`.
#[test]
fn bug7_ask_reaches_the_tenth_subagent_not_the_first() {
    let mut run = Run::default();
    // Conversation ids as agy gives them: nothing in common with the place.
    let ids = ["9f2c", "41aa", "c03e", "7b19", "e5d0", "2a6f", "d8c4", "06be", "b37a", "5e91"];
    let list: Vec<Value> = ids.iter().enumerate().map(|(n, id)| json!({ "role": format!("Batch {}", n + 1), "conversation_id": id })).collect();
    run.feed(json!({ "event": "step_update", "step_update": { "step_index": 2, "state": "DONE", "step_type": "subagent", "subagent_info": { "subagents": list } } }).to_string().as_bytes());
    let tenth = run.subagents.spawns[9].row.clone();
    let ask = rewrite_ask_ids(&format!("Send it with send_message (Recipient: \"{tenth}\")"), Some(&run.subagents));
    assert!(ask.contains("\"5e91\""), "got {ask}");
}

/// BUG 8: swarm with 10+ workers: "w-10: [done]" on the board ends w-1 too
/// (`line.starts_with(name)`), while w-1 is still at work.
#[test]
fn bug8_the_board_saying_w10_is_done_does_not_end_w1() {
    let mut run = Run::default();
    run.feed(br#"{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"swarm","parameters":{"action":"add","name":"w","n":12}}}}"#);
    run.feed(br#"{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_info":{"name":"read_board","response":"w-10 [done] parser fixed"}}}"#);
    assert_eq!(run.subagents.agents.get("swarm-w-10").unwrap().state, AgentState::Done);
    assert_eq!(run.subagents.agents.get("swarm-w-1").unwrap().state, AgentState::Working);
}

/// BUG 9: swarm kill "test" also stops the worker "test-runner".
#[test]
fn bug9_killing_one_worker_stops_only_it() {
    let mut run = Run::default();
    run.feed(br#"{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"swarm","parameters":{"action":"add","name":"test"}}}}"#);
    run.feed(br#"{"event":"step_update","step_update":{"step_index":2,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"swarm","parameters":{"action":"add","name":"test-runner"}}}}"#);
    run.feed(br#"{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"tool","tool_info":{"name":"swarm","parameters":{"action":"kill","name":"test"}}}}"#);
    assert_eq!(run.subagents.agents.get("swarm-test").unwrap().state, AgentState::Stopped);
    assert_eq!(run.subagents.agents.get("swarm-test-runner").unwrap().state, AgentState::Working);
}

/// BUG 10: agy's brain holds one folder per conversation, and every subagent
/// is one: past 4000 (MAX_SCAN) the folders looked at are always the same
/// first 4000, already-looked ones included, and a new child past them is
/// never found.
#[test]
fn bug10_a_child_is_found_in_a_brain_of_many_conversations() {
    let brain = brain();
    for i in 0..MAX_SCAN {
        std::fs::create_dir_all(brain.join(format!("old-{i:05}"))).unwrap();
    }
    std::thread::sleep(Duration::from_millis(20));
    let (c, uc) = transcript(&brain, "coord");
    let mut run = Run::default();
    run.feed(spawn(2, "Coordinator", "coord", &uc).as_bytes());
    let coord = run.subagents.spawns[0].row.clone();
    // The old folders predate the turn.
    run.subagents.since = Some(SystemTime::now());
    std::thread::sleep(Duration::from_millis(20));
    append(&c, &[started_by("main-1", "Coordinate"), invoke(&[("Kid", "Do it")])]);
    run.subagents.read_transcripts();
    let (k, _) = transcript(&brain, "zzzz-kid");
    append(&k, &[started_by("coord", "Do it")]);
    for _ in 0..3 {
        run.subagents.read_transcripts();
    }
    let n = kids_of(&run, &coord).len();
    clean(&brain);
    assert_eq!(n, 1);
}

/// BUG 11 (also found by another thread): agy starts subagents from an
/// ordinary tool step (`step_type: "tool"` with `subagent_info.subagents`):
/// besides the right row ("Helper"), the same step makes a row "Agent" (or
/// the tool's title) that nothing ever ends: it works until the turn ends.
#[test]
fn bug11_subagents_from_a_tool_step_make_no_extra_row() {
    let mut run = Run::default();
    run.feed(br#"{"event":"step_update","step_update":{"step_index":6,"state":"ACTIVE","step_type":"tool","tool_info":{"name":"delegate"},"subagent_info":{"subagents":[{"conversation_id":"nested-1","role":"Helper"}]}}}"#);
    let titles: Vec<String> = run.subagents.agents.ids().filter_map(|id| run.subagents.agents.get(&id).map(|r| r.title.clone())).collect();
    assert_eq!(titles, ["Helper"]);
}

/// BUG 12 (also found by another thread): Stop on a subagent marks its row
/// Stopped at once and only asks the main agent, in words, to stop it: once
/// the turn's answer came the message has nowhere to go (agy's input is
/// closed), and the row says Stopped all the same. Here: the answer is in,
/// Stop is clicked, the row is Stopped though nothing reached agy.
#[test]
fn bug12_stop_after_the_answer_does_not_claim_a_stop() {
    let mut run = Run::default();
    run.feed(spawn(2, "Writer", "sub", "file:///C:/Users/me/.gemini/antigravity-cli/brain/sub/.system_generated/logs/transcript.jsonl").as_bytes());
    let row = run.subagents.spawns[0].row.clone();
    run.feed(br#"{"event":"result","result":{"status":"SUCCESS","response":"Started.","conversation_id":"main-1"}}"#);
    // run_with_subagents: stdin was dropped with the result; stop_one is still called.
    let stdin_open = run.result.is_none();
    let _line = run.subagents.stop_one(&row);
    let state = run.subagents.agents.get(&row).unwrap().state;
    assert!(stdin_open || state != AgentState::Stopped, "nothing was sent to agy, yet the row says Stopped");
}
