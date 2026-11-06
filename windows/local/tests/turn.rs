// Whole turns against a fake server: every way a local model or its server
// went wrong in use, and what Lumo does about it.

mod fake;

use std::time::{Duration, Instant};

use fake::*;
use lumo_local::{run, Correction, Doing, End, Failure, Outcome, Rules, MORE};
use serde_json::{json, Value};

const CHANGES: &[&str] = &["workspace_write", "workspace_edit", "workspace_delete"];

fn rules<'a>(key: &str, query: &'a str) -> Rules<'a> {
    Rules { key: key.to_string(), query, workspace: true, changes: CHANGES, max_rounds: 8, pause: Duration::ZERO }
}

/// Runs a turn of `body` on a server with `replies`.
fn turn(replies: Vec<Reply>, body: &mut Value, rules: &Rules, island: &mut Island) -> (Result<Outcome, Failure>, Vec<Value>) {
    let fake = serve(replies);
    let outcome = block_on(run(&fake.endpoint(), body, rules, island));
    (outcome, fake.requests())
}

#[test]
fn a_plain_answer_streams_in() {
    let mut island = Island::default();
    let mut body = question("Ciao", &[]);
    let (outcome, requests) = turn(vec![answer("Ciao Riccardo.")], &mut body, &rules("plain", "Ciao"), &mut island);
    let outcome = outcome.unwrap();
    assert_eq!((outcome.text.as_str(), outcome.end, outcome.used, outcome.rounds), ("Ciao Riccardo.", End::Answer, Some(50), 0));
    assert!(!outcome.whole && outcome.fixes.is_empty());
    assert_eq!(island.doing[0], Doing::Prompt);
    assert_eq!(island.shown.last().unwrap(), "Ciao Riccardo.");
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["stream"], true);
    assert_eq!(requests[0]["messages"][1]["content"], "Ciao");
}

#[test]
fn thinking_stays_hidden_and_says_the_prompt_is_read() {
    let mut island = Island::default();
    let mut body = question("Quanto fa 2+2?", &[]);
    let replies = vec![Reply::Events(vec![reasoning("hmm"), text("<think>conto"), text("</think>Fa 4."), finish("stop"), DONE.into()])];
    let (outcome, _) = turn(replies, &mut body, &rules("think", ""), &mut island);
    assert_eq!(outcome.unwrap().text, "Fa 4.");
    assert_eq!(island.doing, [Doing::Prompt, Doing::Reasoning]);
    assert!(island.shown.iter().all(|s| !s.contains("conto") && !s.contains("hmm")));
}

#[test]
fn an_answer_opened_empty_is_still_reading_the_prompt() {
    // LM Studio opens the stream with an empty role delta before it has read the prompt.
    let mut island = Island::default();
    let opened = json!({ "choices": [{ "delta": { "role": "assistant", "content": "" } }] }).to_string();
    let replies = vec![Reply::Events(vec![opened, text("Ciao."), finish("stop"), DONE.into()])];
    let (outcome, _) = turn(replies, &mut question("Ciao", &[]), &rules("opened", ""), &mut island);
    assert_eq!(outcome.unwrap().text, "Ciao.");
    assert_eq!(island.doing, [Doing::Prompt]);
}

#[test]
fn each_round_says_how_full_the_context_is() {
    let mut island = Island::default();
    let mut body = question("Timer di 5 minuti", &["set_timer"]);
    let replies = vec![
        Reply::Events(vec![call("c1", "set_timer", "{\"minutes\":5}"), finish("tool_calls"), usage(40), DONE.into()]),
        answer("Fatto."),
    ];
    let (outcome, _) = turn(replies, &mut body, &rules("rounds-used", ""), &mut island);
    assert_eq!(outcome.unwrap().used, Some(50));
    assert_eq!(island.used, [40, 50]);
}

#[test]
fn the_island_says_what_the_model_is_doing() {
    // Reasoning, then a call, then the answer; a second call of another tool is said too.
    let mut island = Island::default();
    let replies = vec![
        Reply::Events(vec![reasoning("hmm"), call("c1", "set_timer", "{\"minutes\":5}"), finish("tool_calls"), DONE.into()]),
        answer("Fatto."),
    ];
    let (outcome, _) = turn(replies, &mut question("Timer di 5 minuti", &["set_timer"]), &rules("doing", ""), &mut island);
    assert_eq!(outcome.unwrap().text, "Fatto.");
    assert_eq!(island.doing, [Doing::Prompt, Doing::Reasoning, Doing::Calling("set_timer".into()), Doing::Prompt]);
    // Reasoning written in the text, hidden by its tags, is reasoning too.
    let mut island = Island::default();
    let replies = vec![Reply::Events(vec![text("<think>conto"), text("</think>Fa 4."), finish("stop"), DONE.into()])];
    let (outcome, _) = turn(replies, &mut question("2+2?", &[]), &rules("doing-think", ""), &mut island);
    assert_eq!(outcome.unwrap().text, "Fa 4.");
    assert_eq!(island.doing, [Doing::Prompt, Doing::Reasoning]);
}

#[test]
fn a_retry_and_a_model_sent_back_are_said() {
    let mut island = Island::default();
    let failing = || Reply::Events(vec![json!({ "error": "terminated" }).to_string()]);
    let (outcome, _) = turn(vec![failing(), failing(), answer("Eccomi.")], &mut question("Ci sei?", &[]), &rules("doing-retry", ""), &mut island);
    assert_eq!(outcome.unwrap().text, "Eccomi.");
    assert_eq!(island.doing, [Doing::Prompt, Doing::Retrying { attempt: 1, of: 3 }, Doing::Retrying { attempt: 2, of: 3 }]);
    let mut island = Island::default();
    let replies = vec![answer("Ho impostato il timer."), calls("c1", "set_timer", "{\"minutes\":1}"), answer("Fatto.")];
    let (outcome, _) = turn(replies, &mut question("Timer di un minuto", &["set_timer"]), &rules("doing-back", ""), &mut island);
    assert_eq!(outcome.unwrap().text, "Fatto.");
    assert!(island.doing.contains(&Doing::Correcting(Correction::SaidDone)), "{:?}", island.doing);
}

#[test]
fn a_tool_round_then_the_answer() {
    let mut island = Island::default();
    let mut body = question("Timer di 5 minuti", &["set_timer"]);
    let replies = vec![
        Reply::Events(vec![text("Metto il timer."), call("c1", "set_timer", "{\"minutes\":"), call("", "", "5}"), finish("tool_calls"), DONE.into()]),
        answer("Fatto."),
    ];
    let (outcome, requests) = turn(replies, &mut body, &rules("round", ""), &mut island);
    let outcome = outcome.unwrap();
    assert_eq!(island.ran, [("set_timer".to_string(), json!({ "minutes": 5 }))]);
    assert_eq!((outcome.rounds, outcome.answer().as_str()), (1, "Metto il timer.\n\nFatto."));
    assert_eq!(island.shown.last().unwrap(), "Metto il timer.\n\nFatto.");
    let messages = requests[1]["messages"].as_array().unwrap();
    assert_eq!(messages[2]["tool_calls"][0]["id"], "c1");
    assert_eq!(messages[2]["tool_calls"][0]["function"]["arguments"], "{\"minutes\":5}");
    assert_eq!((messages[3]["role"].as_str(), messages[3]["tool_call_id"].as_str()), (Some("tool"), Some("c1")));
    assert_eq!(messages[3]["content"], "set_timer done");
}

#[test]
fn an_ollama_call_comes_whole_with_its_arguments_as_an_object() {
    let mut island = Island::default();
    let mut body = question("Timer di 3 minuti", &["set_timer"]);
    let ollama = json!({ "choices": [{ "delta": { "role": "assistant", "content": "", "tool_calls": [{ "function": { "name": "set_timer", "arguments": { "minutes": 3 } } }] }, "finish_reason": "tool_calls" }] });
    let replies = vec![Reply::Events(vec![ollama.to_string(), DONE.into()]), answer("Ok.")];
    let (outcome, requests) = turn(replies, &mut body, &rules("ollama", ""), &mut island);
    assert_eq!(outcome.unwrap().text, "Ok.");
    assert_eq!(island.ran, [("set_timer".to_string(), json!({ "minutes": 3 }))]);
    // No id from the server: one is made up, the same for the call and its result.
    assert_eq!(requests[1]["messages"][2]["tool_calls"][0]["id"], "call_1_0");
    assert_eq!(requests[1]["messages"][3]["tool_call_id"], "call_1_0");
}

#[test]
fn lm_studio_keeping_the_connection_open_after_the_answer_ends_it_all_the_same() {
    let mut island = Island::default();
    let mut body = question("Che tempo fa?", &[]);
    let started = Instant::now();
    let replies = vec![Reply::Hold(vec![text("Sole."), finish("stop"), usage(42), DONE.into()])];
    let (outcome, _) = turn(replies, &mut body, &rules("hold", ""), &mut island);
    assert_eq!(outcome.unwrap().used, Some(42));
    assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
    // No [DONE]: the finish_reason ends it a moment later.
    let started = Instant::now();
    let (outcome, _) = turn(vec![Reply::Hold(vec![text("Sole."), finish("stop")])], &mut question("x", &[]), &rules("hold2", ""), &mut island);
    assert_eq!(outcome.unwrap().text, "Sole.");
    assert!(started.elapsed() < Duration::from_secs(4), "{:?}", started.elapsed());
}

#[test]
fn a_stream_that_hangs_halfway_is_asked_again_whole_and_remembered() {
    let key = "lmstudio\0gemma-hung";
    let mut island = Island::default();
    let mut body = question("Riscrivi il file più lungo", &["workspace_write"]);
    let long = format!("{{\"path\":\"a.txt\",\"content\":\"{}\"}}", "parola ".repeat(500));
    let started = Instant::now();
    let replies = vec![
        // The call starts, then nothing more: LM Studio's hang.
        Reply::Hold(vec![call("c1", "workspace_write", "{\"path\":\"a.txt\",\"content\":\"parola ")]),
        whole("", &[("c1", "workspace_write", &long)]),
        whole("Fatto: il file è più lungo.", &[]),
    ];
    let (outcome, requests) = turn(replies, &mut body, &rules(key, "Riscrivi il file più lungo"), &mut island);
    let outcome = outcome.unwrap();
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    assert!(outcome.whole);
    assert_eq!(outcome.fixes, ["answered whole"]);
    assert_eq!(outcome.notes, ["CutShort"]);
    assert_eq!((outcome.text.as_str(), outcome.used), ("Fatto: il file è più lungo.", Some(77)));
    assert_eq!(island.ran.len(), 1);
    assert_eq!(island.ran[0].1["content"].as_str().unwrap().len(), 3500);
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0]["stream"], true);
    for r in &requests[1..] {
        assert_eq!(r["stream"], false);
        assert!(r.get("stream_options").is_none());
    }
    // The next turn with the same model goes whole from the start.
    let mut island = Island::default();
    let (outcome, requests) = turn(vec![whole("Ciao.", &[])], &mut question("Ciao", &[]), &rules(key, ""), &mut island);
    assert!(outcome.unwrap().fixes.is_empty());
    assert_eq!(requests[0]["stream"], false);
    assert_eq!(island.doing[0], Doing::Thinking);
    assert_eq!(island.shown, ["Ciao."]);
}

#[test]
fn a_slow_prompt_is_not_a_hang() {
    // Nothing for longer than the stall before the first word: the model reads.
    let mut island = Island::default();
    let fake = serve(vec![Reply::Hold(vec![json!({ "choices": [{ "delta": { "role": "assistant" } }] }).to_string()])]);
    let mut body = question("Ciao", &[]);
    let r = rules("slow-prompt", "");
    let waited = block_on(async { tokio::time::timeout(Duration::from_millis(2500), run(&fake.endpoint(), &mut body, &r, &mut island)).await });
    assert!(waited.is_err(), "it gave up while the prompt was read");
}

#[test]
fn a_stream_closed_with_nothing_in_it_is_asked_again_whole() {
    let mut island = Island::default();
    let (outcome, requests) = turn(vec![Reply::Headers, whole("Eccomi.", &[])], &mut question("Ci sei?", &[]), &rules("closed", ""), &mut island);
    assert_eq!(outcome.unwrap().text, "Eccomi.");
    assert_eq!(requests.len(), 2);
    // Whole too, the server still gives nothing: it is said, not asked again.
    let replies = vec![Reply::Headers, Reply::Json(200, "not json".into())];
    let (outcome, requests) = turn(replies, &mut question("Ci sei?", &[]), &rules("closed2", ""), &mut island);
    let failure = outcome.unwrap_err();
    assert!(failure.is_cut_short(), "{failure:?}");
    assert_eq!(requests.len(), 2);
}

#[test]
fn server_errors_come_back_as_they_are() {
    let mut island = Island::default();
    let r = rules("errors", "");
    let (outcome, requests) = turn(vec![Reply::Events(vec![json!({ "error": { "message": "out of memory" } }).to_string()])], &mut question("x", &[]), &r, &mut island);
    assert_eq!(outcome.unwrap_err(), Failure::Server("out of memory".into()));
    assert_eq!(requests.len(), 1);
    let (outcome, _) = turn(vec![Reply::Json(404, "{}".into())], &mut question("x", &[]), &r, &mut island);
    assert_eq!(outcome.unwrap_err(), Failure::NotInstalled);
    let (outcome, _) = turn(vec![Reply::Json(500, json!({ "error": "boom" }).to_string())], &mut question("x", &[]), &r, &mut island);
    assert_eq!(outcome.unwrap_err(), Failure::Status(500, "boom".into()));
    // A refusal that isn't about pictures or tools is said at once.
    let too_long = || Reply::Json(400, json!({ "error": { "message": "context too long" } }).to_string());
    let (outcome, requests) = turn(vec![too_long(), too_long()], &mut question("x", &[]), &r, &mut island);
    assert_eq!(outcome.unwrap_err(), Failure::Status(400, "context too long".into()));
    assert_eq!(requests.len(), 2);
    let nobody = lumo_local::Endpoint { url: "http://127.0.0.1:1/v1/chat/completions".into(), ..serve(vec![]).endpoint() };
    assert_eq!(block_on(run(&nobody, &mut question("x", &[]), &r, &mut island)).unwrap_err(), Failure::Unreachable);
}

#[test]
fn an_endless_line_is_too_large() {
    let mut island = Island::default();
    let (outcome, _) = turn(vec![Reply::Raw(vec![b'x'; lumo_local::transport::MAX_LINE + 10])], &mut question("x", &[]), &rules("endless", ""), &mut island);
    assert_eq!(outcome.unwrap_err(), Failure::TooLarge);
}

#[test]
fn a_tool_call_written_as_text_sends_the_model_back_once() {
    let mut island = Island::default();
    let mut body = question("Cambia la riga", &["workspace_edit"]);
    let replies = vec![
        answer("Fatto.\n[[workspace_edit \"a.txt\" \"x\" \"y\"]]"),
        calls("c1", "workspace_edit", "{\"path\":\"a.txt\"}"),
        answer("Ora è fatto."),
    ];
    let (outcome, requests) = turn(replies, &mut body, &rules("written", "Cambia la riga"), &mut island);
    let outcome = outcome.unwrap();
    assert_eq!(outcome.fixes, ["call written as text"]);
    assert_eq!(outcome.answer(), "Ora è fatto.");
    assert!(last_said(&requests[1]).contains("workspace_edit written in your answer is only text"));
    assert_eq!(island.ran.len(), 1);
    // What it wrote went from the island.
    assert!(island.shown.contains(&String::new()));
    // Written again: once is enough, the answer stays.
    let mut island = Island::default();
    let replies = vec![answer("[[workspace_edit a]]"), answer("[[workspace_edit b]]")];
    let (outcome, requests) = turn(replies, &mut question("x", &["workspace_edit"]), &rules("written2", ""), &mut island);
    assert_eq!(outcome.unwrap().text, "[[workspace_edit b]]");
    assert_eq!(requests.len(), 2);
}

#[test]
fn a_change_said_but_not_made_sends_the_model_back_once() {
    let query = "Modifica il file e allungalo";
    let mut island = Island::default();
    let replies = vec![answer("Ho modificato il file."), calls("c1", "workspace_edit", "{}"), answer("Ho modificato il file.")];
    let (outcome, requests) = turn(replies, &mut question(query, &["workspace_edit"]), &rules("claimed", query), &mut island);
    let outcome = outcome.unwrap();
    assert_eq!(outcome.fixes, ["change said, not made"]);
    assert!(last_said(&requests[1]).contains("no tool changed one"));
    assert_eq!((island.ran.len(), requests.len()), (1, 3));
    // A question that asks for no change, or a chat with no workspace: nothing to check.
    let mut island = Island::default();
    let (_, requests) = turn(vec![answer("Ho modificato il file.")], &mut question("Cosa c'è?", &["workspace_edit"]), &rules("claimed2", "Cosa c'è?"), &mut island);
    assert_eq!(requests.len(), 1);
    let no_workspace = Rules { workspace: false, ..rules("claimed3", query) };
    let (_, requests) = turn(vec![answer("Ho modificato il file.")], &mut question(query, &["workspace_edit"]), &no_workspace, &mut island);
    assert_eq!(requests.len(), 1);
}

#[test]
fn arguments_cut_off_go_back_to_the_model_not_to_the_tool() {
    let mut island = Island::default();
    let replies = vec![calls("c1", "workspace_write", "{\"path\":\"a.txt\",\"content\":\"tron"), answer("Riprovo.")];
    let (outcome, requests) = turn(replies, &mut question("Scrivi", &["workspace_write"]), &rules("json", ""), &mut island);
    assert_eq!(outcome.unwrap().fixes, ["arguments not JSON"]);
    assert!(island.ran.is_empty());
    assert!(last_said(&requests[1]).contains("aren't valid JSON"));
}

#[test]
fn a_made_up_tool_is_answered_with_the_real_ones() {
    let mut island = Island { all: vec!["set_timer".into(), "mail_read".into()], ..Island::default() };
    let replies = vec![calls("c1", "delete_everything", "{}"), answer("Non posso.")];
    let (outcome, requests) = turn(replies, &mut question("Cancella tutto", &["set_timer"]), &rules("made-up", ""), &mut island);
    assert_eq!(outcome.unwrap().fixes, ["made-up tool"]);
    assert!(island.ran.is_empty());
    let said = last_said(&requests[1]);
    assert!(said.contains("no tool named delete_everything") && said.contains("set_timer, mail_read"), "{said}");
}

#[test]
fn pictures_a_model_refuses_are_taken_out_and_the_question_asked_again() {
    let mut island = Island::default();
    let user = json!({ "role": "user", "content": [{ "type": "text", "text": "Cos'è?" }, { "type": "image_url", "image_url": { "url": "data:image/png;base64,AA" } }] });
    let mut body = request(user, &[]);
    let replies = vec![Reply::Json(400, json!({ "error": "Model does not support images" }).to_string()), answer("Non vedo immagini.")];
    let (outcome, requests) = turn(replies, &mut body, &rules("images", ""), &mut island);
    assert_eq!(outcome.unwrap().fixes, ["without pictures"]);
    assert_eq!(requests[1]["messages"][1]["content"], "Cos'è?");
    // The user message stays where it was, without its pictures, for the conversation.
    assert_eq!(body["messages"][1]["content"], "Cos'è?");
}

#[test]
fn tools_a_model_refuses_are_left_out_and_the_question_asked_again() {
    let mut island = Island::default();
    let refused = || Reply::Json(400, json!({ "error": { "message": "tools not supported" } }).to_string());
    let replies = vec![refused(), refused(), answer("Ciao.")];
    let (outcome, requests) = turn(replies, &mut question("Ciao", &["set_timer"]), &rules("no-tools", ""), &mut island);
    assert_eq!(outcome.unwrap().fixes, ["asked again", "without tools"]);
    assert!(requests[1].get("tools").is_some());
    assert!(requests[2].get("tools").is_none());
    assert_eq!(requests[2]["messages"][0]["content"], "system without tools");
}

#[test]
fn a_refusal_after_tools_ran_is_asked_again_with_them_never_without() {
    let mut island = Island::default();
    let refused = || Reply::Json(400, json!({ "error": "Failed to parse tool call" }).to_string());
    // Once: the same request again, and it goes.
    let replies = vec![calls("c1", "workspace_read", "{}"), refused(), answer("Letto.")];
    let (outcome, requests) = turn(replies, &mut question("Leggi", &["workspace_read"]), &rules("refused-once", ""), &mut island);
    let outcome = outcome.unwrap();
    assert_eq!((outcome.fixes.as_slice(), outcome.text.as_str()), (["asked again"].as_slice(), "Letto."));
    assert!(requests[2].get("tools").is_some());
    assert_eq!(outcome.notes, [r#"Status(400, "Failed to parse tool call")"#]);
    // Twice: said, the tools stay.
    let replies = vec![calls("c1", "workspace_read", "{}"), refused(), refused()];
    let (outcome, requests) = turn(replies, &mut question("Leggi", &["workspace_read"]), &rules("refused-twice", ""), &mut island);
    assert_eq!(outcome.unwrap_err(), Failure::Status(400, "Failed to parse tool call".into()));
    assert!(requests.iter().all(|r| r.get("tools").is_some()));
}

#[test]
fn an_answer_stopped_at_the_length_limit_says_so() {
    let mut island = Island::default();
    let replies = vec![Reply::Events(vec![text("Una storia lunga"), finish("length"), DONE.into()])];
    let (outcome, _) = turn(replies, &mut question("Scrivi una storia", &[]), &rules("length", ""), &mut island);
    assert_eq!(outcome.unwrap().end, End::Cut);
    // Answered whole, the same.
    lumo_local::turn::hung("length-whole", true);
    let (outcome, _) = turn(vec![Reply::Json(200, json!({ "choices": [{ "message": { "content": "Lunga" }, "finish_reason": "length" }] }).to_string())], &mut question("x", &[]), &rules("length-whole", ""), &mut island);
    assert_eq!(outcome.unwrap().end, End::Cut);
}

#[test]
fn a_tool_of_the_catalog_is_loaded_when_called_then_called_again() {
    let mut island = Island { catalog: vec!["mail_read".into(), "listen".into()], ..Island::default() };
    let replies = vec![calls("c1", "mail_read", "{}"), calls("c2", "mail_read", "{\"id\":1}"), answer("Ecco la mail.")];
    let (outcome, requests) = turn(replies, &mut question("Leggi la mail", &["set_timer", MORE]), &rules("catalog", ""), &mut island);
    assert_eq!(outcome.unwrap().fixes, ["tools loaded"]);
    assert_eq!(last_said(&requests[1]), "mail_read is loaded now, nothing was done yet: call it again with its arguments.");
    assert_eq!(offered(&requests[1]), ["set_timer", MORE, "mail_read"]);
    assert_eq!(requests[1]["messages"][0]["content"], "system with set_timer, lumo_tools, mail_read");
    assert_eq!(island.ran, [("mail_read".to_string(), json!({ "id": 1 }))]);
}

#[test]
fn tools_asked_for_by_name_are_loaded() {
    let mut island = Island { catalog: vec!["listen".into()], ..Island::default() };
    let replies = vec![calls("c1", MORE, "{\"names\":[\"listen\",\"nope\"]}"), calls("c2", MORE, "{\"names\":[\"nope\"]}"), answer("Ok.")];
    let (_, requests) = turn(replies, &mut question("Ascolta la cartella", &[MORE]), &rules("more", ""), &mut island);
    assert_eq!(last_said(&requests[1]), "Loaded: listen. Call them now.");
    assert_eq!(offered(&requests[1]), [MORE, "listen"]);
    assert_eq!(last_said(&requests[2]), "None of those is in the catalog: nothing was loaded.");
    assert!(island.ran.is_empty());
}

#[test]
fn a_model_that_keeps_calling_tools_stops_after_the_last_round() {
    let mut island = Island::default();
    let replies = (0..3).map(|i| calls(&format!("c{i}"), "set_timer", "{}")).collect();
    let r = Rules { max_rounds: 2, ..rules("rounds", "") };
    let (outcome, requests) = turn(replies, &mut question("x", &["set_timer"]), &r, &mut island);
    let outcome = outcome.unwrap();
    assert_eq!((outcome.end, outcome.rounds), (End::Rounds, 2));
    assert_eq!((island.ran.len(), requests.len()), (2, 3));
}

#[test]
fn stop_mid_answer_keeps_what_was_shown_and_the_question() {
    let mut island = Island::default();
    let mut body = question("Raccontami", &[]);
    let fake = serve(vec![Reply::Hold(vec![text("Mezza risposta")])]);
    let to = fake.endpoint();
    let r = rules("stop", "");
    let stopped = block_on(async { tokio::time::timeout(Duration::from_millis(800), run(&to, &mut body, &r, &mut island)).await });
    assert!(stopped.is_err());
    assert_eq!(island.shown.last().unwrap(), "Mezza risposta");
    assert_eq!(body["messages"][1]["content"], "Raccontami");
}

#[test]
fn lm_studio_s_engine_failing_is_asked_again_and_never_costs_the_tools() {
    let engine = "Engine protocol predict request failed: fetch failed";
    // In the stream, then as a 400: the same request again, tools and stream kept.
    let mut island = Island::default();
    let replies = vec![Reply::Events(vec![json!({ "error": engine }).to_string()]), Reply::Json(400, json!({ "error": "terminated" }).to_string()), answer("Eccomi.")];
    let (outcome, requests) = turn(replies, &mut question("Ci sei?", &["set_timer"]), &rules("engine", ""), &mut island);
    let outcome = outcome.unwrap();
    assert_eq!((outcome.text.as_str(), outcome.fixes.as_slice(), outcome.whole), ("Eccomi.", ["asked again", "asked again"].as_slice(), false));
    assert_eq!(outcome.notes.len(), 2);
    assert!(requests.iter().all(|r| r["stream"] == true && r.get("tools").is_some()));
    // Four times: whole for this turn, not remembered for the next.
    let mut island = Island::default();
    let failing = || Reply::Events(vec![json!({ "error": "terminated" }).to_string()]);
    let replies = vec![failing(), failing(), failing(), failing(), whole("Eccomi.", &[])];
    let (outcome, requests) = turn(replies, &mut question("Ci sei?", &[]), &rules("engine2", ""), &mut island);
    let outcome = outcome.unwrap();
    assert_eq!(outcome.fixes, ["asked again", "asked again", "asked again", "answered whole"]);
    assert_eq!((requests.len(), requests[4]["stream"].as_bool()), (5, Some(false)));
    let (_, requests) = turn(vec![answer("Ciao.")], &mut question("Ciao", &[]), &rules("engine2", ""), &mut island);
    assert_eq!(requests[0]["stream"], true);
    // Whole too, and again: said in the end.
    let replies = vec![failing(), failing(), failing(), failing(), Reply::Json(400, json!({ "error": "terminated" }).to_string())];
    let (outcome, _) = turn(replies, &mut question("Ci sei?", &[]), &rules("engine3", ""), &mut island);
    assert!(outcome.unwrap_err().is_engine());
}

#[test]
fn each_request_has_its_own_retries_when_the_engine_fails() {
    // Three failures before the tool call, three before the answer: streamed throughout.
    let mut island = Island::default();
    let failing = || Reply::Events(vec![json!({ "error": "terminated" }).to_string()]);
    let replies = vec![failing(), failing(), failing(), calls("c1", "set_timer", "{\"minutes\":5}"), failing(), failing(), failing(), answer("Fatto.")];
    let (outcome, requests) = turn(replies, &mut question("Timer di 5 minuti", &["set_timer"]), &rules("engine-rounds", ""), &mut island);
    let outcome = outcome.unwrap();
    assert_eq!((outcome.text.as_str(), outcome.whole, outcome.fixes.len()), ("Fatto.", false, 6));
    assert!(requests.iter().all(|r| r["stream"] == true));
}

#[test]
fn a_thing_said_done_with_no_tool_or_only_announced_goes_back_once() {
    // "I set it" with no tool called: back once, and then the tool is called.
    let mut island = Island::default();
    let replies = vec![answer("Ho impostato l'ascolto per la cartella Downloads."), calls("c1", "set_timer", "{\"minutes\":1}"), answer("Fatto.")];
    let (outcome, requests) = turn(replies, &mut question("Avvisami quando cambia la cartella", &["set_timer"]), &rules("said-done", ""), &mut island);
    let outcome = outcome.unwrap();
    assert_eq!((outcome.text.as_str(), outcome.fixes.as_slice()), ("Fatto.", ["done said, not made"].as_slice()));
    assert!(requests[1]["messages"].to_string().contains("you called no tool"));
    // "Let me read it first" and nothing more: back once; a second time, it is the answer.
    let mut island = Island::default();
    let replies = vec![answer("Let me read the file first."), answer("Let me read the file first.")];
    let (outcome, requests) = turn(replies, &mut question("Allungalo", &["workspace_read"]), &rules("announced", ""), &mut island);
    assert_eq!(outcome.unwrap().fixes, ["stopped before the tool"]);
    assert_eq!(requests.len(), 2);
    // A change asked for, the file copied, and the answer ends with nothing changed: back once.
    let mut island = Island::default();
    let replies = vec![calls("c1", "workspace_copy", "{\"path\":\"a.txt\"}"), answer("Copiato."), calls("c2", "workspace_edit", "{\"path\":\"a.txt\",\"old\":\"a\",\"new\":\"b\"}"), answer("Fatto.")];
    let (outcome, _) = turn(replies, &mut question("Nel file cambia a con b", &["workspace_copy", "workspace_edit"]), &rules("left-undone", "Nel file cambia a con b"), &mut island);
    let outcome = outcome.unwrap();
    assert_eq!((outcome.text.as_str(), outcome.fixes.as_slice()), ("Fatto.", ["stopped before the tool"].as_slice()));
    // A plain answer, or one with no tools offered, stays as it is.
    let (outcome, requests) = turn(vec![answer("Il file ha 12 righe.")], &mut question("Quante righe?", &["workspace_read"]), &rules("plain", ""), &mut Island::default());
    assert!(outcome.unwrap().fixes.is_empty());
    assert_eq!(requests.len(), 1);
}

#[test]
fn a_gemma_call_left_in_the_text_is_made() {
    let mut island = Island::default();
    let gemma = "<|tool_call>call:workspace_write{content:<|\"|>Mele\nPere\nBanane\n<|\"|>,path:<|\"|>frutti.txt<|\"|>}<tool_call|>";
    let replies = vec![answer(gemma), answer("Fatto: il terzo è Banane.")];
    let (outcome, requests) = turn(replies, &mut question("Crea frutti.txt", &["workspace_write"]), &rules("gemma-text", ""), &mut island);
    let outcome = outcome.unwrap();
    assert_eq!(outcome.fixes, ["call read from the text"]);
    assert_eq!(island.ran, [("workspace_write".to_string(), json!({ "content": "Mele\nPere\nBanane\n", "path": "frutti.txt" }))]);
    assert_eq!(requests[1]["messages"][2]["tool_calls"][0]["id"], "call_1_0");
    assert_eq!(outcome.answer(), "Fatto: il terzo è Banane.");
}

#[test]
fn the_same_change_asked_twice_is_made_once_and_said_once() {
    let mut island = Island::default();
    let write = "{\"path\":\"a.txt\",\"content\":\"lungo\"}";
    let replies = vec![
        Reply::Events(vec![text("Ho riscritto il file."), call("c1", "workspace_write", write), finish("tool_calls"), DONE.into()]),
        Reply::Events(vec![text("Ho riscritto il file."), call("c2", "workspace_write", write), finish("tool_calls"), DONE.into()]),
        answer("Ho riscritto il file."),
    ];
    let (outcome, requests) = turn(replies, &mut question("Riscrivi", &["workspace_write"]), &rules("twice", ""), &mut island);
    let outcome = outcome.unwrap();
    assert_eq!(island.ran.len(), 1);
    assert_eq!(outcome.fixes, ["same call again"]);
    assert!(last_said(&requests[2]).contains("already ran"));
    assert_eq!(outcome.answer(), "Ho riscritto il file.");
}
