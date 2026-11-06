// The lines of an answer streamed as server-sent events (the OpenAI API's
// chat completions, as Ollama, LM Studio and llama.cpp send them), the tool
// calls put back together from their pieces, and `<think>` blocks taken out.

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
    let Some(payload) = line.strip_prefix("data:").map(str::trim_start) else { return false };
    payload.contains("finish_reason")
        && serde_json::from_str::<Value>(payload).ok().is_some_and(|j| j.pointer("/choices/0/finish_reason").is_some_and(Value::is_string))
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
    if let Some(total) = json.pointer("/usage/total_tokens").and_then(Value::as_u64).filter(|_| json.pointer("/choices/0/delta/content").is_none()) {
        return Some(Event::Usage(total));
    }
    let delta = json.pointer("/choices/0/delta")?;
    if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array).filter(|c| !c.is_empty()) {
        return Some(Event::Calls(calls.clone()));
    }
    match delta.get("content").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        Some(text) => Some(Event::Text(text.to_string())),
        None => ["reasoning_content", "reasoning"]
            .iter()
            .any(|k| delta.get(*k).and_then(Value::as_str).is_some_and(|r| !r.is_empty()))
            .then_some(Event::Reasoning),
    }
}

/// The tool calls of an answer, put together from their pieces: each one's
/// id, name and arguments (a JSON text), in order.
#[derive(Default)]
pub struct CallParts {
    pub calls: Vec<Value>,
}

impl CallParts {
    pub fn feed(&mut self, pieces: &[Value]) {
        for (n, piece) in pieces.iter().enumerate() {
            let index = piece["index"].as_u64().map(|i| i as usize).unwrap_or(self.calls.len().max(n));
            if index > 64 {
                continue;
            }
            while self.calls.len() <= index {
                self.calls.push(json!({ "id": "", "name": "", "arguments": "" }));
            }
            let call = &mut self.calls[index];
            if let Some(id) = piece["id"].as_str().filter(|id| !id.is_empty()) {
                call["id"] = json!(id);
            }
            if let Some(name) = piece.pointer("/function/name").and_then(Value::as_str) {
                let joined = format!("{}{name}", call["name"].as_str().unwrap_or(""));
                call["name"] = json!(joined);
            }
            match piece.pointer("/function/arguments") {
                Some(Value::String(more)) => {
                    let joined = format!("{}{more}", call["arguments"].as_str().unwrap_or(""));
                    call["arguments"] = json!(joined);
                }
                // Some servers send the arguments as an object.
                Some(v @ Value::Object(_)) => call["arguments"] = json!(v.to_string()),
                _ => {}
            }
        }
    }

    pub fn done(self) -> Vec<Value> {
        self.calls.into_iter().filter(|c| c["name"].as_str().is_some_and(|n| !n.is_empty())).collect()
    }
}

/// Removes finished `<think>…</think>` blocks (reasoning models such as DeepSeek-R1).
pub fn filter_thinking_blocks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<think>") {
        let Some(len) = rest[start..].find("</think>") else { break };
        out.push_str(&rest[..start]);
        rest = &rest[start + len + "</think>".len()..];
    }
    out.push_str(rest);
    out.trim().to_string()
}

/// For the text shown while streaming: finished blocks go, and so does
/// everything after a block that has not been closed yet.
pub fn progressive_filter(text: &str) -> String {
    let cleaned = filter_thinking_blocks(text);
    match cleaned.find("<think>") {
        Some(at) => cleaned[..at].trim().to_string(),
        None => cleaned,
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
        // A tag that is only half written is not a block yet.
        assert_eq!(progressive_filter("text <thi"), "text <thi");
    }
}
