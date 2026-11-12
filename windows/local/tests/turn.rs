// Whole turns against a fake server: every way a local model or its server
// went wrong in use, and what Lumo does about it.

mod fake;

use std::time::{Duration, Instant};

use fake::*;
use lumo_local::{run, Correction, Doing, End, Failure, Outcome, Plan, Rules, MORE};
use serde_json::{json, Value};

const CHANGES: &[&str] = &["workspace_write", "workspace_edit", "workspace_delete"];

fn rules<'a>(key: &str, query: &'a str) -> Rules<'a> {
    Rules { key: key.to_string(), query, workspace: true, changes: CHANGES, max_rounds: 8, pause: Duration::ZERO, text_only: None, plan: None }
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
fn a_pdf_s_pages_a_model_refuses_go_again_as_its_text() {
    let mut island = Island::default();
    let user = json!({ "role": "user", "content": [{ "type": "image_url", "image_url": { "url": "data:image/png;base64,AA" } }, { "type": "text", "text": "Cosa c'è?" }] });
    let text = json!({ "role": "user", "content": "File: a.pdf\nFile contents:\ne^x = 1 + x\n\nCosa c'è?" });
    let mut body = request(user, &[]);
    let replies = vec![Reply::Json(400, json!({ "error": "image input is not supported" }).to_string()), answer("Una formula.")];
    let r = Rules { text_only: Some(text.clone()), ..rules("pdf-pages", "") };
    let (outcome, requests) = turn(replies, &mut body, &r, &mut island);
    assert_eq!(outcome.unwrap().fixes, ["without pictures"]);
    assert_eq!(requests[1]["messages"][1], text);
    assert_eq!(body["messages"][1], text);
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
fn nothing_written_after_the_tools_asks_once_for_the_answer() {
    let mut island = Island::default();
    let replies = vec![calls("c1", "web_search", "{\"query\":\"Cracovia\"}"), answer(""), answer("Ecco le notizie.")];
    let (outcome, requests) = turn(replies, &mut question("Cerca Cracovia", &["web_search"]), &rules("silent", ""), &mut island);
    let outcome = outcome.unwrap();
    assert_eq!((outcome.text.as_str(), outcome.fixes.as_slice()), ("Ecco le notizie.", ["no answer after the tools"].as_slice()));
    assert!(requests[2]["messages"].to_string().contains("you wrote nothing after the tool results"));
    // Silent a second time: that is the answer (the chat says there was no text).
    let replies = vec![calls("c1", "web_search", "{\"query\":\"x\"}"), answer(""), answer("")];
    let (outcome, requests) = turn(replies, &mut question("Cerca x", &["web_search"]), &rules("silent-twice", ""), &mut Island::default());
    assert_eq!(outcome.unwrap().text, "");
    assert_eq!(requests.len(), 3);
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

// ── The plan (plan.rs) ───────────────────────────────────────────────────────

const PLAN_ABC: &str = r#"{"plan":[{"step":"A","status":"in_progress"},{"step":"B","status":"pending"},{"step":"C","status":"pending"}]}"#;
const PLAN_DONE: &str = r#"{"plan":[{"step":"A","status":"completed"},{"step":"B","status":"completed"},{"step":"C","status":"completed"}]}"#;

#[test]
fn a_plan_left_behind_the_work_is_reminded_then_checked_at_the_end() {
    let mut island = Island::default();
    let replies = vec![
        calls("c1", "update_plan", PLAN_ABC),
        calls("c2", "workspace_write", "{\"path\":\"a\"}"),
        calls("c3", "workspace_write", "{\"path\":\"b\"}"),
        answer("Fatto!"),
        Reply::Events(vec![text("Aggiorno il piano."), call("c4", "update_plan", PLAN_DONE), finish("tool_calls"), DONE.into()]),
        answer("OK"),
    ];
    let mut body = question("Fai A, B e C", &["update_plan", "workspace_write"]);
    let (outcome, requests) = turn(replies, &mut body, &rules("plan-behind", ""), &mut island);
    let outcome = outcome.unwrap();
    assert_eq!(outcome.fixes, ["plan reminded", "plan behind the work"]);
    // One round of other tools: nothing yet; two: the reminder, under the result.
    assert_eq!(last_said(&requests[2]), "workspace_write done");
    let reminded = last_said(&requests[3]);
    assert!(reminded.starts_with("workspace_write done\n\n(Lumo: your plan on the Plan island shows step 1 \"A\" in progress"), "{reminded}");
    // The answer with the plan behind: sent back once, unseen. The answer
    // stays as it was shown, and nothing more is shown or said meanwhile.
    assert!(last_said(&requests[4]).contains("still shows 3 of 3 steps not completed"), "{}", last_said(&requests[4]));
    assert_eq!(outcome.answer(), "Fatto!");
    assert_eq!(island.shown.last().unwrap(), "Fatto!");
    assert!(!island.shown.iter().any(|s| s.contains("Aggiorno") || s.contains("OK")));
    assert_eq!(island.hushed, [true, false]);
    assert_eq!(island.doing.last(), Some(&Doing::Prompt), "{:?}", island.doing);
    assert_eq!(island.ran.last().unwrap(), &("update_plan".to_string(), serde_json::from_str::<Value>(PLAN_DONE).unwrap()));
    assert_eq!(requests.len(), 6);
}

#[test]
fn a_plan_kept_up_to_date_is_left_alone() {
    let mut island = Island::default();
    let a_done = r#"{"plan":[{"step":"A","status":"completed"},{"step":"B","status":"in_progress"}]}"#;
    let replies = vec![
        calls("c1", "update_plan", PLAN_ABC),
        calls("c2", "workspace_write", "{\"path\":\"a\"}"),
        calls("c3", "update_plan", a_done),
        answer("Ho fatto A, B te lo lascio."),
    ];
    let (outcome, requests) = turn(replies, &mut question("Fai A e B", &["update_plan", "workspace_write"]), &rules("plan-ok", ""), &mut island);
    assert!(outcome.unwrap().fixes.is_empty());
    assert_eq!(requests.len(), 4);
    // A question with no tools in a chat whose plan is under way: nothing about it.
    let earlier = Plan::from_input(&serde_json::from_str::<Value>(PLAN_ABC).unwrap());
    let r = Rules { plan: earlier, ..rules("plan-earlier", "") };
    let (outcome, requests) = turn(vec![answer("Sono le 15.")], &mut question("Che ore sono?", &["update_plan"]), &r, &mut Island::default());
    assert!(outcome.unwrap().fixes.is_empty());
    assert_eq!(requests.len(), 1);
}

#[test]
fn a_plan_from_an_earlier_question_left_behind_is_reminded_too() {
    let earlier = Plan::from_input(&serde_json::from_str::<Value>(PLAN_ABC).unwrap());
    let r = Rules { plan: earlier, ..rules("plan-earlier-behind", "") };
    let replies = vec![calls("c1", "workspace_write", "{\"path\":\"a\"}"), answer("Fatto A."), calls("c2", "update_plan", PLAN_DONE), answer("Fatto A.")];
    let (outcome, requests) = turn(replies, &mut question("Continua", &["update_plan", "workspace_write"]), &r, &mut Island::default());
    assert_eq!(outcome.unwrap().fixes, ["plan behind the work"]);
    assert!(last_said(&requests[2]).contains("step 1 \"A\" in progress"));
}

#[test]
fn a_list_of_steps_before_the_first_tools_is_shown_as_the_plan() {
    // The plan tool isn't loaded: it is, so the model can tick the list off.
    let mut island = Island { catalog: vec!["update_plan".into()], ..Island::default() };
    let first = Reply::Events(vec![
        text("Ecco come procedo:\n\n1. Creare la cartella\n2. Scrivere index.html\n\nInizio."),
        call("c1", "workspace_write", "{\"path\":\"a\"}"),
        finish("tool_calls"),
        DONE.into(),
    ]);
    let ticked = r#"{"plan":[{"step":"Creare la cartella","status":"completed"},{"step":"Scrivere index.html","status":"completed"}]}"#;
    let replies = vec![first, answer("Fatto."), calls("c2", "update_plan", ticked), answer("Fatto.")];
    let (outcome, requests) = turn(replies, &mut question("Fammi un sito", &["workspace_write"]), &rules("plan-list", ""), &mut island);
    let outcome = outcome.unwrap();
    assert_eq!(outcome.fixes, ["list shown as the plan", "plan behind the work"]);
    assert_eq!(island.plans, [json!({ "plan": [{ "step": "Creare la cartella", "status": "in_progress" }, { "step": "Scrivere index.html", "status": "pending" }] })]);
    assert_eq!(offered(&requests[1]), ["workspace_write", "update_plan"]);
    assert!(last_said(&requests[1]).contains("is now shown to the user as your plan on the Plan island, step 1 \"Creare la cartella\" in progress"), "{}", last_said(&requests[1]));
    assert_eq!(island.ran.last().unwrap().0, "update_plan");
}

#[test]
fn a_list_is_no_plan_when_the_tool_can_t_be_had_or_a_plan_was_made() {
    // No plan tool to load: the list stays text.
    let mut island = Island::default();
    let first = Reply::Events(vec![text("1. A\n2. B"), call("c1", "workspace_write", "{\"path\":\"a\"}"), finish("tool_calls"), DONE.into()]);
    let (outcome, requests) = turn(vec![first, answer("Ok.")], &mut question("Fai", &["workspace_write"]), &rules("plan-list-none", ""), &mut island);
    assert!(outcome.unwrap().fixes.is_empty());
    assert!(island.plans.is_empty());
    assert_eq!(last_said(&requests[1]), "workspace_write done");
    // Made with the tool in the same answer: the tool's plan is the plan.
    let mut island = Island::default();
    let first = Reply::Events(vec![text("1. A\n2. B"), call("c1", "update_plan", PLAN_ABC), finish("tool_calls"), DONE.into()]);
    let (_, requests) = turn(vec![first, answer("Ok.")], &mut question("Fai", &["update_plan"]), &rules("plan-list-tool", ""), &mut island);
    assert!(island.plans.is_empty());
    assert_eq!(last_said(&requests[1]), "update_plan done");
}

#[test]
fn a_job_of_several_changes_with_no_plan_is_asked_for_one_once() {
    let mut island = Island { catalog: vec!["update_plan".into()], ..Island::default() };
    let replies = vec![
        calls("c1", "workspace_write", "{\"path\":\"a\"}"),
        calls("c2", "workspace_write", "{\"path\":\"b\"}"),
        calls("c3", "update_plan", PLAN_ABC),
        answer("Fatto A."),
    ];
    let (outcome, requests) = turn(replies, &mut question("Fammi un sito", &["workspace_write"]), &rules("plan-ask", ""), &mut island);
    let outcome = outcome.unwrap();
    assert_eq!(outcome.fixes[0], "plan asked for");
    assert_eq!(last_said(&requests[1]), "workspace_write done");
    assert!(last_said(&requests[2]).starts_with("workspace_write done\n\n(Lumo: this job is taking several steps"), "{}", last_said(&requests[2]));
    assert_eq!(offered(&requests[2]), ["workspace_write", "update_plan"]);
    // Rounds that only read change nothing: no plan asked for.
    let replies = vec![calls("c1", "web_search", "{\"q\":1}"), calls("c2", "web_search", "{\"q\":2}"), answer("Ecco.")];
    let (outcome, _) = turn(replies, &mut question("Cerca", &["web_search", "update_plan"]), &rules("plan-ask-read", ""), &mut Island::default());
    assert!(outcome.unwrap().fixes.is_empty());
}

#[test]
fn an_answer_whose_plan_check_goes_back_to_work_stays() {
    // Asked, unseen, to put its plan right after its answer, the model goes
    // back to work with other tools: the answer it gave stays, on the island
    // and in what is kept of the turn.
    let mut island = Island::default();
    let replies = vec![
        calls("c1", "update_plan", PLAN_ABC),
        calls("c2", "workspace_write", "{\"path\":\"a\"}"),
        calls("c3", "workspace_write", "{\"path\":\"b\"}"),
        answer("Fatto A."),
        calls("c4", "workspace_write", "{\"path\":\"c\"}"),
        answer("Fatto anche C."),
    ];
    let mut body = question("Fai A, B e C", &["update_plan", "workspace_write"]);
    let (outcome, requests) = turn(replies, &mut body, &rules("plan-back-to-work", ""), &mut island);
    let outcome = outcome.unwrap();
    assert_eq!(requests.len(), 6);
    assert_eq!(island.hushed, [true, false]);
    assert_eq!(outcome.answer(), "Fatto A.\n\nFatto anche C.");
    assert_eq!(island.shown.last().unwrap(), "Fatto A.\n\nFatto anche C.");
}

#[test]
fn a_plan_check_whose_call_is_left_in_the_text_stays_unseen() {
    let mut island = Island::default();
    let check = format!("Aggiorno il piano.<tool_call>{{\"name\":\"update_plan\",\"arguments\":{PLAN_DONE}}}</tool_call>");
    let replies = vec![
        calls("c1", "update_plan", PLAN_ABC),
        calls("c2", "workspace_write", "{\"path\":\"a\"}"),
        calls("c3", "workspace_write", "{\"path\":\"b\"}"),
        answer("Fatto!"),
        answer(&check),
        answer("OK"),
    ];
    let mut body = question("Fai A, B e C", &["update_plan", "workspace_write"]);
    let (outcome, _) = turn(replies, &mut body, &rules("plan-check-text", ""), &mut island);
    let outcome = outcome.unwrap();
    assert_eq!(outcome.answer(), "Fatto!");
    assert!(!island.shown.iter().any(|s| s.contains("Aggiorno")), "{:?}", island.shown);
    assert_eq!(island.shown.last().unwrap(), "Fatto!");
    assert_eq!(island.ran.last().unwrap().0, "update_plan");
}

#[test]
fn a_long_call_after_some_text_is_said_until_it_is_made() {
    // The text before the call isn't sent again while the call comes in, or
    // the island would drop "Calling workspace_write" a moment after saying it.
    let mut island = Island::default();
    let mut events = vec![text("Scrivo il file."), call("c1", "workspace_write", "{\"path\":\"a\",\"content\":\"")];
    events.extend((0..6).map(|_| call("", "", "riga ")));
    events.extend([call("", "", "\"}"), finish("tool_calls"), DONE.into()]);
    let replies = vec![Reply::Paced(events, Duration::from_millis(100)), answer("Fatto.")];
    let (outcome, _) = turn(replies, &mut question("Scrivi a", &["workspace_write"]), &rules("long-call", ""), &mut island);
    assert_eq!(outcome.unwrap().answer(), "Scrivo il file.\n\nFatto.");
    assert!(island.doing.contains(&Doing::Calling("workspace_write".into())));
    let again = island.shown.iter().filter(|s| *s == "Scrivo il file.").count();
    assert!(again <= 2, "{:?}", island.shown);
}

#[test]
fn half_a_thinking_tag_never_shows() {
    let mut island = Island::default();
    let events = vec![text("Ecco. <thi"), text("nk>penso"), text(" ancora"), text("</think>Risposta."), finish("stop"), DONE.into()];
    let (outcome, _) = turn(vec![Reply::Paced(events, Duration::from_millis(100))], &mut question("x", &[]), &rules("half-tag", ""), &mut island);
    assert_eq!(outcome.unwrap().text, "Ecco. Risposta.");
    assert!(!island.shown.iter().any(|s| s.contains('<')), "{:?}", island.shown);
    assert_eq!(island.shown.last().unwrap(), "Ecco. Risposta.");
}

#[test]
fn endless_call_arguments_are_too_large() {
    let piece = "x".repeat(lumo_local::transport::MAX_LINE / 2);
    let mut events = vec![call("c1", "workspace_write", "{\"content\":\"")];
    events.extend((0..10).map(|_| call("", "", &piece)));
    events.extend([call("", "", "\"}"), finish("tool_calls"), DONE.into()]);
    let mut island = Island::default();
    let (outcome, _) = turn(vec![Reply::Events(events), answer("Fatto.")], &mut question("x", &["workspace_write"]), &rules("endless-args", ""), &mut island);
    assert_eq!(outcome.unwrap_err(), Failure::TooLarge);
    assert!(island.ran.is_empty());
}

#[test]
fn every_piece_of_the_stream_is_a_sign_of_life() {
    // A model that reasons for long shows nothing, yet each piece that comes
    // says it is at work: the island never takes it for stuck.
    let mut island = Island::default();
    let mut events: Vec<String> = (0..4).map(|_| reasoning("hmm")).collect();
    events.extend([text("Fa 4."), finish("stop"), DONE.into()]);
    let (outcome, _) = turn(vec![Reply::Paced(events, Duration::from_millis(50))], &mut question("2+2?", &[]), &rules("signal-chunks", ""), &mut island);
    assert_eq!(outcome.unwrap().text, "Fa 4.");
    // Before any text showed: the request, and at least one piece of
    // reasoning on its own. The network may join pieces that come 50 ms
    // apart, but not the reasoning with the text, 200 ms later. The answer
    // is one more sign after the text.
    let before_text = island.signals_before_text.unwrap();
    assert!(before_text >= 1 + 2, "{before_text}");
    assert!(island.signals > before_text, "{}", island.signals);

    // A tool starting and ending is one too, and so is the whole answer of a
    // model that streams no more.
    let mut island = Island::default();
    let replies = vec![calls("c1", "set_timer", "{\"minutes\":5}"), answer("Fatto.")];
    let (outcome, _) = turn(replies, &mut question("Timer di 5 minuti", &["set_timer"]), &rules("signal-tools", ""), &mut island);
    assert_eq!(outcome.unwrap().text, "Fatto.");
    let before = island.signals_at_call[0];
    // Request, at least one piece, answer, then the call starting.
    assert!(before >= 4, "{before}");
    // The call ending, the next request, its piece and its answer.
    assert!(island.signals >= before + 4, "{}", island.signals);
    lumo_local::turn::hung("signal-whole", true);
    let mut island = Island::default();
    let (outcome, _) = turn(vec![whole("Ciao.", &[])], &mut question("Ciao", &[]), &rules("signal-whole", ""), &mut island);
    assert_eq!(outcome.unwrap().text, "Ciao.");
    assert_eq!(island.signals, 2, "the request and the whole answer");
}
