// The lines of an answer streamed as server-sent events (the OpenAI API's
// chat completions, as Ollama, LM Studio and llama.cpp send them), the tool
// calls put back together from their pieces, and `<think>` / `<thought>` blocks taken out.

use serde_json::{json, Value};

/// One server-sent event line.
#[derive(Debug, PartialEq)]
pub enum Event {
    /// `data: [DONE]`: the answer is complete. Some servers (LM Studio) keep
    /// the connection open after it, so the stream ends here, not at its close.
    Done,
    /// A piece of the answer's text.
    Text(String),
    /// Pieces of tool calls, each with its `index` (the OpenAI API streams a
    /// call's arguments in pieces; Ollama sends each call whole).
    Calls(Vec<Value>),
    /// What the request and its answer took, in tokens (the last event, with
    /// `stream_options.include_usage`).
    Usage(u64),
    /// A piece of the model's reasoning (`reasoning_content`, Ollama's
    /// `reasoning`), never shown: it only says the model is thinking.
    Reasoning,
    /// An error event.
    Error(String),
}

/// Whether an event line says the answer is over (`finish_reason` set): only
/// the usage chunk and `[DONE]` may follow.
pub fn finish_reason(line: &str) -> bool {
    finish_reason_of(line).is_some()
}

/// The reason an event line says the answer ended ("stop", "length"…), read
/// from its own field: the same word in the text or a tool's arguments is not it.
pub fn finish_reason_of(line: &str) -> Option<String> {
    let payload = line.strip_prefix("data:").map(str::trim_start)?;
    if !payload.contains("finish_reason") {
        return None;
    }
    let json = serde_json::from_str::<Value>(payload).ok()?;
    json.pointer("/choices/0/finish_reason").and_then(Value::as_str).map(str::to_string)
}

/// One server-sent event line, or None for anything else (other lines, a
/// delta without content).
pub fn parse_sse_line(line: &str) -> Option<Event> {
    let payload = line.strip_prefix("data:")?.trim_start();
    if payload == "[DONE]" {
        return Some(Event::Done);
    }
    let json: Value = serde_json::from_str(payload).ok()?;
    if let Some(msg) = json.pointer("/error/message").and_then(Value::as_str) {
        return Some(Event::Error(msg.to_string()));
    }
    // LM Studio and llama.cpp also say it as `{"error": "…"}`.
    if let Some(error) = json.get("error").filter(|e| !e.is_null()) {
        return Some(Event::Error(error.as_str().map(str::to_string).unwrap_or_default()));
    }
    // What the answer says comes first: the calls and the text of a chunk
    // that also carries the usage (vLLM's continuous usage, a server that
    // ends with both) are read all the same; `usage_of` reads its usage.
    if let Some(delta) = json.pointer("/choices/0/delta") {
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array).filter(|c| !c.is_empty()) {
            return Some(Event::Calls(calls.clone()));
        }
        if let Some(text) = delta.get("content").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            return Some(Event::Text(text.to_string()));
        }
        if ["reasoning_content", "reasoning"].iter().any(|k| delta.get(*k).and_then(Value::as_str).is_some_and(|r| !r.is_empty())) {
            return Some(Event::Reasoning);
        }
    }
    json.pointer("/usage/total_tokens").and_then(Value::as_u64).map(Event::Usage)
}

/// The tokens an event line says the request and its answer took, whatever
/// else it carries.
pub fn usage_of(line: &str) -> Option<u64> {
    let payload = line.strip_prefix("data:").map(str::trim_start)?;
    if !payload.contains("total_tokens") {
        return None;
    }
    let json = serde_json::from_str::<Value>(payload).ok()?;
    json.pointer("/usage/total_tokens").and_then(Value::as_u64)
}

/// The tool calls of an answer, put together from their pieces: each one's
/// id, name and arguments (a JSON text), in order.
#[derive(Default)]
pub struct CallParts {
    pub calls: Vec<Value>,
    /// For each `index` the server gave, the call its pieces go to now.
    slots: Vec<(u64, usize)>,
}

/// The most calls one answer is put together from.
const MAX_CALLS: usize = 65;

impl CallParts {
    pub fn feed(&mut self, pieces: &[Value]) {
        for piece in pieces {
            let id = piece["id"].as_str().filter(|id| !id.is_empty());
            let name = piece.pointer("/function/name").and_then(Value::as_str).filter(|n| !n.is_empty());
            let at = match piece["index"].as_u64() {
                Some(index) => match self.slots.iter().find(|(i, _)| *i == index).map(|(_, at)| *at) {
                    // Another id at an index already taken is another call:
                    // Ollama, before it numbered them, sent every call whole
                    // with index 0.
                    Some(at) if id.is_some_and(|id| self.calls[at]["id"].as_str().is_some_and(|had| !had.is_empty() && had != id)) => self.start(Some(index)),
                    Some(at) => Some(at),
                    None => self.start(Some(index)),
                },
                // No index: a piece of a call already begun goes on with it
                // (by its id, or the last one when it has neither id nor
                // name); any other is a call of its own.
                None => match id {
                    Some(id) => self.calls.iter().position(|c| c["id"] == id).or_else(|| self.start(None)),
                    None if name.is_none() => self.calls.len().checked_sub(1),
                    None => self.start(None),
                },
            };
            let Some(at) = at else { continue };
            let call = &mut self.calls[at];
            if let Some(id) = id {
                call["id"] = json!(id);
            }
            if let (Some(name), Some(Value::String(had))) = (name, call.get_mut("name")) {
                // A name sent again whole with each piece is said once.
                if had != name {
                    had.push_str(name);
                }
            }
            match piece.pointer("/function/arguments") {
                Some(Value::String(more)) => {
                    if let Some(Value::String(had)) = call.get_mut("arguments") {
                        had.push_str(more);
                    }
                }
                // Some servers send the arguments as an object.
                Some(v @ Value::Object(_)) => call["arguments"] = json!(v.to_string()),
                _ => {}
            }
        }
    }

    /// A new call, for the server's `index` from now on. None past MAX_CALLS.
    fn start(&mut self, index: Option<u64>) -> Option<usize> {
        if self.calls.len() >= MAX_CALLS {
            return None;
        }
        self.calls.push(json!({ "id": "", "name": "", "arguments": "" }));
        let at = self.calls.len() - 1;
        if let Some(index) = index {
            self.slots.retain(|(i, _)| *i != index);
            self.slots.push((index, at));
        }
        Some(at)
    }

    /// The bytes of the calls so far, their names and arguments.
    pub fn size(&self) -> usize {
        self.calls.iter().flat_map(|c| [&c["name"], &c["arguments"]]).filter_map(Value::as_str).map(str::len).sum()
    }

    pub fn done(self) -> Vec<Value> {
        self.calls.into_iter().filter(|c| c["name"].as_str().is_some_and(|n| !n.is_empty())).collect()
    }
}

/// The tags a model writes its reasoning between, in the text itself:
/// `<think>` (DeepSeek-R1, Qwen) and `<thought>` (Gemma through Google AI).
const THINKING_TAGS: [(&str, &str); 2] = [("<think>", "</think>"), ("<thought>", "</thought>")];

/// The first reasoning block that opens in `text`: where, and its tags.
fn first_opening(text: &str) -> Option<(usize, &'static str, &'static str)> {
    THINKING_TAGS.iter().filter_map(|(open, close)| text.find(open).map(|at| (at, *open, *close))).min_by_key(|(at, _, _)| *at)
}

/// Removes finished reasoning blocks (`<think>…</think>`, `<thought>…</thought>`).
pub fn filter_thinking_blocks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some((start, open, close)) = first_opening(rest) {
        let Some(len) = rest[start + open.len()..].find(close) else { break };
        out.push_str(&rest[..start]);
        rest = &rest[start + open.len() + len + close.len()..];
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// For the text shown while streaming: finished blocks go, and so does
/// everything after a block that has not been closed yet.
pub fn progressive_filter(text: &str) -> String {
    let cleaned = filter_thinking_blocks(text);
    match first_opening(&cleaned) {
        Some((at, _, _)) => cleaned[..at].trim().to_string(),
        None => cleaned,
    }
}

/// `text` as it streams in, without the start of a reasoning tag it may end
/// with (`<thi`), which the next piece may make a block: never shown halfway.
pub fn without_half_tag(text: &str) -> &str {
    let half = THINKING_TAGS.iter().flat_map(|(open, _)| (1..open.len()).map(|n| &open[..n])).filter(|part| text.ends_with(part)).map(str::len).max();
    match half {
        Some(n) => text[..text.len() - n].trim_end(),
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_and_tool_calls_are_taken_from_the_event_stream() {
        let text = |s: &str| Some(Event::Text(s.into()));
        let line = r#"data: {"choices":[{"delta":{"content":"Hel"}}]}"#;
        assert_eq!(parse_sse_line(line), text("Hel"));
        let line = r#"data:{"choices":[{"delta":{"content":"lo"}}]}"#;
        assert_eq!(parse_sse_line(line), text("lo"));
        assert_eq!(parse_sse_line("data: [DONE]"), Some(Event::Done));
        assert!(finish_reason(r#"data: {"choices":[{"delta":{},"finish_reason":"stop"}]}"#));
        // The reason is its own field's, not a word of the text.
        assert_eq!(finish_reason_of(r#"data: {"choices":[{"delta":{"content":"length"},"finish_reason":"stop"}]}"#).as_deref(), Some("stop"));
        assert_eq!(finish_reason_of(r#"data: {"choices":[{"delta":{},"finish_reason":"length"}]}"#).as_deref(), Some("length"));

        assert!(!finish_reason(r#"data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}]}"#));
        assert_eq!(parse_sse_line(""), None);
        assert_eq!(parse_sse_line(": keep-alive"), None);
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"role":"assistant"}}]}"#), None);
        // Reasoning only says the model is thinking (LM Studio's field, then Ollama's).
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"content":null,"reasoning_content":"x"}}]}"#), Some(Event::Reasoning));
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"content":"","reasoning":"x"}}]}"#), Some(Event::Reasoning));
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"content":""}}]}"#), None);
        // The last event says what the request and its answer took.
        assert_eq!(parse_sse_line(r#"data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":34,"total_tokens":1234}}"#), Some(Event::Usage(1234)));
        assert_eq!(parse_sse_line("data: not json"), None);
        assert_eq!(parse_sse_line(r#"data: {"error":{"message":"out of memory"}}"#), Some(Event::Error("out of memory".into())));
        let line = r#"data: {"choices":[{"delta":{"content":"","tool_calls":[{"index":0,"id":"c1","function":{"name":"set_timer"}}]}}]}"#;
        assert!(matches!(parse_sse_line(line), Some(Event::Calls(c)) if c.len() == 1));
    }

    #[test]
    fn a_tool_call_streamed_in_pieces_is_put_back_together() {
        let mut parts = CallParts::default();
        parts.feed(&[json!({"index":0,"id":"c1","function":{"name":"set_","arguments":""}})]);
        parts.feed(&[json!({"index":0,"function":{"name":"timer","arguments":"{\"min"}})]);
        parts.feed(&[json!({"index":0,"function":{"arguments":"utes\":5}"}}), json!({"index":1,"function":{"name":"listen","arguments":{"source":"x"}}})]);
        // A piece without a name is no call.
        parts.feed(&[json!({"index":2,"function":{"arguments":"{}"}})]);
        let calls = parts.done();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0], json!({"id":"c1","name":"set_timer","arguments":"{\"minutes\":5}"}));
        assert_eq!(calls[1]["name"], "listen");
        assert_eq!(calls[1]["arguments"], r#"{"source":"x"}"#);
    }

    #[test]
    fn finished_thinking_blocks_go_and_an_open_one_hides_what_follows() {
        assert_eq!(filter_thinking_blocks("<think>hmm</think>\n\nThe answer."), "The answer.");
        assert_eq!(filter_thinking_blocks("a<think>x</think>b<think>y</think>c"), "abc");
        assert_eq!(filter_thinking_blocks("plain"), "plain");
        // Streaming: nothing of an unfinished block shows.
        assert_eq!(progressive_filter("Sure. <think>let me think"), "Sure.");
        assert_eq!(progressive_filter("<think>still thinking"), "");
        assert_eq!(progressive_filter("<think>done</think>Visible <think>again"), "Visible");
        // A tag that is only half written is not a block yet, but while the
        // answer streams in it isn't shown until it is one or isn't.
        assert_eq!(progressive_filter("text <thi"), "text <thi");
        assert_eq!(without_half_tag("text <thi"), "text");
        assert_eq!(without_half_tag("text <thou"), "text");
        assert_eq!(without_half_tag("text <"), "text");
        assert_eq!(without_half_tag("a <b"), "a <b");
        assert_eq!(without_half_tag("text"), "text");
    }

    #[test]
    fn a_chunk_with_the_usage_keeps_its_calls_and_text() {
        let calls = r#"data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"set_timer","arguments":"{}"}}]}}],"usage":{"total_tokens":120}}"#;
        assert!(matches!(parse_sse_line(calls), Some(Event::Calls(c)) if c.len() == 1));
        assert_eq!(usage_of(calls), Some(120));
        let text = r#"data: {"choices":[{"delta":{"content":"Ciao"}}],"usage":{"total_tokens":121}}"#;
        assert_eq!(parse_sse_line(text), Some(Event::Text("Ciao".into())));
        assert_eq!(usage_of(text), Some(121));
        assert_eq!(parse_sse_line(r#"data: {"choices":[{"delta":{"content":""}}],"usage":{"total_tokens":122}}"#), Some(Event::Usage(122)));
        assert_eq!(usage_of(r#"data: {"choices":[{"delta":{"content":"total_tokens"}}]}"#), None);
    }

    #[test]
    fn calls_all_numbered_0_or_not_numbered_stay_apart() {
        // Ollama before it numbered them: each call whole, every one index 0.
        let mut parts = CallParts::default();
        parts.feed(&[
            json!({"index":0,"id":"a","function":{"name":"set_timer","arguments":"{\"minutes\":1}"}}),
            json!({"index":0,"id":"b","function":{"name":"listen","arguments":"{}"}}),
        ]);
        let calls = parts.done();
        assert_eq!(calls.len(), 2);
        assert_eq!((calls[0]["name"].as_str(), calls[1]["name"].as_str()), (Some("set_timer"), Some("listen")));
        assert_eq!(calls[0]["arguments"], "{\"minutes\":1}");
        // No index at all: each call of its own, and its pieces go on with it.
        let mut parts = CallParts::default();
        parts.feed(&[json!({"id":"a","function":{"name":"set_timer","arguments":"{\"min"}})]);
        parts.feed(&[json!({"function":{"arguments":"utes\":2}"}})]);
        parts.feed(&[json!({"id":"b","function":{"name":"listen","arguments":"{}"}})]);
        let calls = parts.done();
        assert_eq!(calls.len(), 2);
        assert_eq!((calls[0]["name"].as_str(), calls[0]["arguments"].as_str()), (Some("set_timer"), Some("{\"minutes\":2}")));
        assert_eq!(calls[1]["name"], "listen");
        // A name sent again with each piece of the same call is said once.
        let mut parts = CallParts::default();
        parts.feed(&[json!({"index":0,"id":"a","function":{"name":"set_timer","arguments":"{"}})]);
        parts.feed(&[json!({"index":0,"id":"a","function":{"name":"set_timer","arguments":"}"}})]);
        assert_eq!(parts.done(), [json!({"id":"a","name":"set_timer","arguments":"{}"})]);
    }

    #[test]
    fn gemmas_thought_blocks_go_too() {
        let gemma = "<thought>The user said \"Ciao\".\nPlan:\n1. Greet.</thought>Ciao! Come posso aiutarti oggi?";
        assert_eq!(filter_thinking_blocks(gemma), "Ciao! Come posso aiutarti oggi?");
        assert_eq!(progressive_filter("<thought>The user said"), "");
        assert_eq!(progressive_filter("<think>a</think>Yes <thought>b</thought>and no"), "Yes and no");
        assert_eq!(progressive_filter("Done. <thought>more"), "Done.");
    }
}
