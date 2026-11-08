// One turn of the chat: the request, the answer, and as many rounds of tool
// calls as the model makes (up to `Rules::max_rounds`), with the checks that
// send a model back once when it got something wrong. The app does what only
// it can through `Hooks`: shows the answer, runs the tools, loads more of them.

use std::future::Future;
use std::time::Duration;

use serde_json::{json, Value};

use crate::guard::{announces, asks_change, call_input, claims_change, claims_done, written_call, without_images};
use crate::native::calls_in_text;
use crate::sse::progressive_filter;
use crate::transport::{ask_whole, stream, Endpoint, Failure, Seen};

/// The tool that loads more of Lumo's tools, by name (local_profile.rs).
pub const MORE: &str = "lumo_tools";

/// What the island says the answer is doing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Doing {
    /// The model reads the prompt (streamed: until anything of the answer comes).
    Prompt,
    /// The model is at work, with nothing more said: it answers whole.
    Thinking,
    /// The model reasons (its reasoning stays hidden).
    Reasoning,
    /// The model writes a call of this tool.
    Calling(String),
    /// The server's engine dropped the request: asked again, `attempt` of `of`.
    Retrying { attempt: u8, of: u8 },
    /// The model got something wrong and is sent back once.
    Correcting(Correction),
}

/// Why the model is sent back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Correction {
    /// It wrote a tool call in its text instead of making it.
    Written,
    /// It said a file changed, or that it was done, and no tool did it.
    SaidDone,
    /// It stopped before the tool it announced, or left the change undone.
    Stopped,
}

/// How many times an engine that dropped a request is asked again.
const ENGINE_RETRIES: u8 = 3;

/// Tools loaded in the middle of a turn, and what the request carries from then on.
pub struct Loaded {
    /// The tools loaded (none when nothing asked for is in the catalog).
    pub wanted: Vec<String>,
    /// The request's `tools`, their names, and its system message.
    pub tools: Value,
    pub names: Vec<String>,
    pub system: String,
}

pub trait Hooks {
    /// The text of the answer so far, as the island shows it.
    fn shown(&mut self, text: &str);
    fn doing(&mut self, doing: Doing);
    /// What a request of the turn took, in tokens, as soon as the server says
    /// (each round of tools has its own): how full the context is now.
    fn used(&mut self, _tokens: u64) {}
    /// The system message for a request with no tools (a model that refused them).
    fn without_tools(&mut self) -> String;
    /// More tools for `name` called with `input`: `lumo_tools`, or a tool of
    /// the catalog not loaded yet. None for a tool `offered` has, or none at all.
    fn load(&mut self, name: &str, input: &Value, offered: &[String]) -> Option<Loaded>;
    /// Every tool there is, for a model that made one up.
    fn known(&self) -> Vec<String>;
    /// Runs a tool: what it answered, and whether it failed.
    fn call(&mut self, name: &str, input: Value) -> impl Future<Output = (String, bool)> + Send;
}

/// What a turn goes by.
pub struct Rules<'a> {
    /// Names the server and the model, for what this session remembers of them.
    pub key: String,
    /// The user's question.
    pub query: &'a str,
    /// The chat has a workspace to work on copies in.
    pub workspace: bool,
    /// The tools that change a copy.
    pub changes: &'a [&'a str],
    pub max_rounds: usize,
    /// How long to wait before asking again a server whose engine failed.
    pub pause: Duration,
    /// The question as it goes to a model that doesn't see: what replaces it
    /// when the server refuses its pictures (a PDF's text where its pages
    /// went). None: the pictures are only taken out.
    pub text_only: Option<Value>,
}

/// How the turn ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum End {
    Answer,
    /// At the length limit.
    Cut,
    /// The model still called tools after the last round.
    Rounds,
}

/// A turn's answer, and what it took.
#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    /// What the model said before each round of tools.
    pub said: Vec<String>,
    /// Its last answer.
    pub text: String,
    pub end: End,
    /// The tokens of the last request that said.
    pub used: Option<u64>,
    pub rounds: usize,
    /// Answered whole, the stream having hung.
    pub whole: bool,
    /// What was put right on the way, in order (for the log).
    pub fixes: Vec<&'static str>,
    /// What the server said when it failed on the way, in order (for the log).
    pub notes: Vec<String>,
}

impl Outcome {
    /// The whole answer: what was said before the tools, then the last answer.
    /// The same words said twice in a row (a model that repeats itself
    /// after a tool) are said once.
    pub fn answer(&self) -> String {
        let mut parts: Vec<&str> = Vec::new();
        for s in self.said.iter().chain([&self.text]).map(|s| s.trim()).filter(|s| !s.is_empty()) {
            if parts.last() != Some(&s) {
                parts.push(s);
            }
        }
        parts.join("\n\n")
    }
}

/// Whether the stream of `key` (server and model) hung in this session, after
/// noting that it did when `now`.
pub fn hung(key: &str, now: bool) -> bool {
    static HUNG: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());
    let mut hung = HUNG.lock().unwrap_or_else(|e| e.into_inner());
    if now && !hung.iter().any(|k| k == key) {
        hung.push(key.to_string());
    }
    hung.iter().any(|k| k == key)
}

/// The names of the tools `body` offers.
fn offered(body: &Value) -> Vec<String> {
    body["tools"].as_array().map(|t| t.iter().filter_map(|t| t.pointer("/function/name").and_then(Value::as_str)).map(str::to_string).collect()).unwrap_or_default()
}

fn push(body: &mut Value, messages: impl IntoIterator<Item = Value>) {
    if let Some(m) = body["messages"].as_array_mut() {
        m.extend(messages);
    }
}

/// Runs one turn on `body` (a chat completions request, its last message the
/// user's). The body grows with the turn: whatever ends the turn (its future
/// dropped on Stop included), its user message is still where it was, without
/// its pictures if the server refused them.
pub async fn run<H: Hooks>(to: &Endpoint, body: &mut Value, rules: &Rules<'_>, hooks: &mut H) -> Result<Outcome, Failure> {
    let mut names = offered(body);
    // A model whose stream hung once in this session answers whole from then on.
    let mut whole = hung(&rules.key, false);
    let mut said: Vec<String> = Vec::new();
    let mut fixes = Vec::new();
    let mut used = None;
    let mut rounds = 0;
    // Each check sends the model back once a turn.
    let (mut written, mut claimed, mut stopped, mut silent) = (false, false, false, false);
    // A copy changed by a tool in this turn.
    let mut changed = false;
    // A workspace tool ran in this turn: the model is at work on a file.
    let mut on_copy = false;
    let mut notes: Vec<String> = Vec::new();
    // A refusal (400) asked again once as it was; an engine that failed,
    // three times for each request (then once whole): what failed once may
    // not fail again.
    let mut asked_again = false;
    let mut engine_retries: u8 = 0;
    // The calls that changed something, as they were made: one made again
    // the same is not made twice.
    let mut made: Vec<(String, String, String)> = Vec::new();
    // What the island says next, when the loop goes round for a reason of its own.
    let mut next: Option<Doing> = None;
    loop {
        hooks.doing(next.take().unwrap_or(if whole { Doing::Thinking } else { Doing::Prompt }));
        let before = said.join("\n\n");
        let after_before = |visible: &str| if before.is_empty() { visible.to_string() } else { format!("{before}\n\n{visible}") };
        let answer = if whole {
            let answer = ask_whole(to, body).await;
            if let Ok(a) = &answer {
                if !a.text.is_empty() {
                    hooks.shown(&after_before(&progressive_filter(&a.text)));
                }
            }
            answer
        } else {
            stream(to, body, |seen| match seen {
                // Nothing new yet in this round: the text so far isn't sent
                // again, or the island would drop the dots that say what the
                // answer is doing.
                Seen::Text(visible) if visible.is_empty() => {}
                Seen::Text(visible) => hooks.shown(&after_before(&visible)),
                Seen::Reasoning => hooks.doing(Doing::Reasoning),
                Seen::Calling(name) => hooks.doing(Doing::Calling(name)),
            })
            .await
        };
        if let Err(e) = &answer {
            notes.push(format!("{}{e:?}", if whole { "whole: " } else { "" }));
        }
        let answer = match answer {
            // A model that doesn't see refuses the pictures: once more with the text alone.
            Err(Failure::Status(400 | 422, _)) if without_images(body) => {
                if let (Some(text), Some(last)) = (&rules.text_only, body["messages"].as_array_mut().and_then(|m| m.last_mut())) {
                    *last = text.clone();
                }
                fixes.push("without pictures");
                continue;
            }
            // LM Studio's engine failed this request ("terminated", "fetch
            // failed"): the same request after a moment, three times, then
            // whole for this turn. Nothing to do with the stream: not remembered.
            Err(e) if e.is_engine() && engine_retries < ENGINE_RETRIES => {
                engine_retries += 1;
                next = Some(Doing::Retrying { attempt: engine_retries, of: ENGINE_RETRIES });
                fixes.push("asked again");
                tokio::time::sleep(rules.pause).await;
                continue;
            }
            Err(e) if e.is_engine() && !whole => {
                whole = true;
                fixes.push("answered whole");
                continue;
            }
            Err(e) if e.is_engine() => return Err(e),
            // A refusal may be the server failing to read what the model
            // wrote (a tool call it couldn't parse): the same request once more.
            Err(Failure::Status(400 | 422, _)) if !asked_again => {
                asked_again = true;
                fixes.push("asked again");
                continue;
            }
            // A model that takes no tools refuses the first request with
            // them: once more without. Not once tools have run in this turn.
            Err(Failure::Status(400 | 422, _)) if body.get("tools").is_some() && rounds == 0 => {
                body.as_object_mut().map(|b| b.remove("tools"));
                body["messages"][0]["content"] = json!(hooks.without_tools());
                names.clear();
                fixes.push("without tools");
                continue;
            }
            // The stream hung halfway (LM Studio, on some tool calls with long
            // text in their arguments) or closed with nothing: the same
            // request, not streamed, from then on with this model.
            Err(Failure::CutShort) if !whole => {
                whole = hung(&rules.key, true);
                fixes.push("answered whole");
                continue;
            }
            other => other?,
        };
        // The next request has its own retries.
        engine_retries = 0;
        let mut answer = answer;
        // Calls the model wrote in its own format, that the server left in
        // the text (Gemma's `<|tool_call>…`): made into calls.
        if answer.calls.is_empty() && !names.is_empty() {
            if let Some((calls, rest)) = calls_in_text(&answer.text, &names) {
                answer.calls = calls;
                answer.text = rest;
                fixes.push("call read from the text");
                hooks.shown(&after_before(&answer.text));
            }
        }
        if let Some(tokens) = answer.used {
            used = Some(tokens);
            hooks.used(tokens);
        }
        let tools = body.get("tools").is_some();
        // A tool call written in the answer as text (`[[workspace_edit …]]`)
        // does nothing: the model is told so once, and what it wrote goes.
        if answer.calls.is_empty() && !written && tools {
            if let Some(name) = written_call(&answer.text, &names) {
                written = true;
                fixes.push("call written as text");
                push(body, [
                    json!({ "role": "assistant", "content": answer.text }),
                    json!({ "role": "user", "content": format!("(Lumo: {name} written in your answer is only text: nothing was done. Call the {name} tool itself, as a function call, then answer. Never write a tool call in your answer, and never say something was done when no tool did it.)") }),
                ]);
                hooks.shown(&before);
                next = Some(Doing::Correcting(Correction::Written));
                continue;
            }
        }
        // "I changed the file" with no tool that changed one: the model is told once.
        if answer.calls.is_empty() && !claimed && rules.workspace && !changed && asks_change(rules.query) && claims_change(&answer.text) {
            claimed = true;
            fixes.push("change said, not made");
            push(body, [
                json!({ "role": "assistant", "content": answer.text }),
                json!({ "role": "user", "content": "(Lumo: you said a file was changed, but no tool changed one in this answer: nothing changed. Call workspace_write or workspace_edit on the copy now, or tell the user plainly that it wasn't done.)" }),
            ]);
            hooks.shown(&before);
            next = Some(Doing::Correcting(Correction::SaidDone));
            continue;
        }
        // "It's set" with no tool called in the whole turn, or "Let me read
        // it first" and nothing more: the model is told once.
        // So is a change asked for, a file copied or read, and the answer
        // ending with nothing changed ("I copied it, now I'll read it").
        let nothing_ran = rounds == 0 && !claims_change(&answer.text);
        let left_undone = rules.workspace && on_copy && !changed && asks_change(rules.query);
        if answer.calls.is_empty() && tools && !stopped && !answer.cut && ((nothing_ran && claims_done(&answer.text)) || announces(&answer.text) || left_undone) {
            stopped = true;
            let said_done = nothing_ran && claims_done(&answer.text);
            fixes.push(if said_done { "done said, not made" } else { "stopped before the tool" });
            let note = if said_done {
                "(Lumo: you said it was done, but you called no tool: nothing was done. Call the tool that does it now, or tell the user plainly that you can't.)"
            } else {
                "(Lumo: you said what you would do next, but called no tool, so nothing happened and the user is still waiting. Call the tool now and finish the task.)"
            };
            push(body, [json!({ "role": "assistant", "content": answer.text }), json!({ "role": "user", "content": note })]);
            hooks.shown(&before);
            next = Some(Doing::Correcting(if said_done { Correction::SaidDone } else { Correction::Stopped }));
            continue;
        }
        // Nothing written after the tools' results (Gemma, at times, with a
        // long search result): the model is asked once for the answer.
        if answer.calls.is_empty() && rounds > 0 && !silent && !answer.cut && answer.text.trim().is_empty() {
            silent = true;
            fixes.push("no answer after the tools");
            push(body, [json!({ "role": "user", "content": "(Lumo: you wrote nothing after the tool results. Answer the user now from what the tools returned; if they didn't answer the question, say so.)" })]);
            hooks.shown(&before);
            next = Some(Doing::Correcting(Correction::Stopped));
            continue;
        }
        if answer.calls.is_empty() || !tools || rounds == rules.max_rounds {
            let end = if !answer.calls.is_empty() && tools {
                End::Rounds
            } else if answer.cut {
                End::Cut
            } else {
                End::Answer
            };
            return Ok(Outcome { said, text: answer.text, end, used, rounds, whole, fixes, notes });
        }
        rounds += 1;
        if !answer.text.is_empty() {
            said.push(answer.text.clone());
        }
        let calls: Vec<Value> = answer
            .calls
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let id = c["id"].as_str().filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| format!("call_{rounds}_{i}"));
                json!({ "id": id, "type": "function", "function": { "name": c["name"], "arguments": c["arguments"] } })
            })
            .collect();
        let mut replies = vec![json!({ "role": "assistant", "content": answer.text, "tool_calls": calls })];
        for call in &calls {
            let name = call.pointer("/function/name").and_then(Value::as_str).unwrap_or_default();
            let reply = |text: String| json!({ "role": "tool", "tool_call_id": call["id"], "name": name, "content": text });
            // Arguments that aren't JSON go back to the model, never as `{}` to the tool.
            let Some(input) = call_input(call.pointer("/function/arguments").and_then(Value::as_str).unwrap_or_default()) else {
                fixes.push("arguments not JSON");
                replies.push(reply(format!("The arguments of this {name} call aren't valid JSON (it may have been cut off): nothing was done. Call it again with a JSON object.")));
                continue;
            };
            // More of Lumo's tools, from now on: asked for by name, or called
            // straight from the catalog.
            if let Some(loaded) = hooks.load(name, &input, &names) {
                let text = if loaded.wanted.is_empty() {
                    "None of those is in the catalog: nothing was loaded.".to_string()
                } else if name == MORE {
                    format!("Loaded: {}. Call them now.", loaded.wanted.join(", "))
                } else {
                    format!("{name} is loaded now, nothing was done yet: call it again with its arguments.")
                };
                body["tools"] = loaded.tools;
                body["messages"][0]["content"] = json!(loaded.system);
                names = loaded.names;
                fixes.push("tools loaded");
                replies.push(reply(text));
                continue;
            }
            // A tool the model made up: said as such, with the real ones.
            if !names.iter().any(|n| n == name) {
                fixes.push("made-up tool");
                replies.push(reply(format!(
                    "There is no tool named {name}: nothing was done. These are the only tools: {}. Tell the user plainly if none of them can do it.",
                    hooks.known().join(", ")
                )));
                continue;
            }
            // The same change asked for again: done already, not twice.
            let arguments = input.to_string();
            if let Some((_, _, before)) = made.iter().find(|(n, a, _)| n == name && *a == arguments) {
                fixes.push("same call again");
                replies.push(reply(format!("This exact {name} call already ran in this answer ({before}): nothing was done again. Don't repeat it; answer the user.")));
                continue;
            }
            let (text, failed) = hooks.call(name, input).await;
            if !failed && name.starts_with("workspace_") {
                on_copy = true;
            }
            if !failed && rules.changes.contains(&name) {
                changed = true;
                made.push((name.to_string(), arguments, text.clone()));
            }
            replies.push(reply(text));
        }
        push(body, replies);
    }
}
