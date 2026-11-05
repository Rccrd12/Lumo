// Tool calls a model wrote in its own format, in the text of its answer,
// because the server didn't turn them into calls: Gemma's
// `<|tool_call>call:name{key:<|"|>text<|"|>}<tool_call|>`, and the
// `<tool_call>{"name": …, "arguments": …}</tool_call>` of Qwen, Hermes and
// others. Each becomes a real call, `{id, name, arguments}` as a streamed
// one is, and leaves the text.

use serde_json::{json, Map, Value};

const GEMMA_OPEN: &str = "<|tool_call>";
const GEMMA_CLOSE: &str = "<tool_call|>";
const GEMMA_QUOTE: &str = "<|\"|>";
const OPEN: &str = "<tool_call>";
const CLOSE: &str = "</tool_call>";

/// A tool's name and its input.
type Named = (String, Value);

/// The calls of `names` written in `text`, and the text without them. None
/// when there is none.
pub fn calls_in_text(text: &str, names: &[String]) -> Option<(Vec<Value>, String)> {
    let mut calls = Vec::new();
    let mut rest = String::new();
    let mut at = 0;
    while let Some((start, end, call)) = next_call(text, at) {
        rest.push_str(&text[at..start]);
        at = end;
        match call {
            Some((name, input)) if names.contains(&name) => {
                calls.push(json!({ "id": "", "name": name, "arguments": input.to_string() }));
            }
            // A call of a tool not offered stays as it was: the other checks see it.
            _ => rest.push_str(&text[start..end]),
        }
    }
    rest.push_str(&text[at..]);
    (!calls.is_empty()).then(|| (calls, rest.trim().to_string()))
}

/// The next call written at or after `from`: where it starts and ends, and
/// its name and input when they could be read.
fn next_call(text: &str, from: usize) -> Option<(usize, usize, Option<Named>)> {
    let tail = &text[from..];
    let gemma = tail.find(GEMMA_OPEN);
    let other = tail.find(OPEN);
    let (start, gemma) = match (gemma, other) {
        (Some(g), Some(o)) if o < g => (o, false),
        (Some(g), _) => (g, true),
        (None, Some(o)) => (o, false),
        (None, None) => return None,
    };
    let start = from + start;
    let (open, close) = if gemma { (GEMMA_OPEN, GEMMA_CLOSE) } else { (OPEN, CLOSE) };
    let body_from = start + open.len();
    // Unclosed (cut off): up to the end.
    let (body_to, end) = match text[body_from..].find(close) {
        Some(i) => (body_from + i, body_from + i + close.len()),
        None => (text.len(), text.len()),
    };
    let body = text[body_from..body_to].trim();
    let call = if gemma { gemma_call(body) } else { json_call(body) };
    Some((start, end, call))
}

/// `{"name": "x", "arguments": {…}}` (arguments may be a JSON text).
fn json_call(body: &str) -> Option<Named> {
    let v: Value = serde_json::from_str(body).ok()?;
    let name = v.get("name")?.as_str()?.to_string();
    let input = match v.get("arguments").or_else(|| v.get("parameters")) {
        Some(Value::String(s)) => serde_json::from_str(s).ok()?,
        Some(o @ Value::Object(_)) => o.clone(),
        None => json!({}),
        _ => return None,
    };
    Some((name, input))
}

/// `call:name{key:<|"|>text<|"|>,n:3}`.
fn gemma_call(body: &str) -> Option<Named> {
    let body = body.strip_prefix("call:").unwrap_or(body);
    let brace = body.find('{')?;
    let name = body[..brace].trim().to_string();
    if name.is_empty() || name.contains(char::is_whitespace) {
        return None;
    }
    let mut p = Parser { s: &body[brace..], at: 0 };
    let input = p.value()?;
    input.is_object().then_some((name, input))
}

struct Parser<'a> {
    s: &'a str,
    at: usize,
}

impl Parser<'_> {
    fn rest(&self) -> &str {
        &self.s[self.at..]
    }

    fn skip_space(&mut self) {
        let trimmed = self.rest().trim_start();
        self.at = self.s.len() - trimmed.len();
    }

    fn eat(&mut self, token: &str) -> bool {
        self.skip_space();
        if self.rest().starts_with(token) {
            self.at += token.len();
            true
        } else {
            false
        }
    }

    fn value(&mut self) -> Option<Value> {
        self.skip_space();
        if self.eat(GEMMA_QUOTE) {
            let end = self.rest().find(GEMMA_QUOTE)?;
            let text = self.rest()[..end].to_string();
            self.at += end + GEMMA_QUOTE.len();
            return Some(Value::String(text));
        }
        if self.eat("{") {
            let mut map = Map::new();
            loop {
                if self.eat("}") {
                    return Some(Value::Object(map));
                }
                let colon = self.rest().find(':')?;
                let key = self.rest()[..colon].trim().trim_matches('"').to_string();
                self.at += colon + 1;
                let value = self.value()?;
                map.insert(key, value);
                if !self.eat(",") && !self.rest().trim_start().starts_with('}') {
                    return None;
                }
            }
        }
        if self.eat("[") {
            let mut items = Vec::new();
            loop {
                if self.eat("]") {
                    return Some(Value::Array(items));
                }
                items.push(self.value()?);
                if !self.eat(",") && !self.rest().trim_start().starts_with(']') {
                    return None;
                }
            }
        }
        // A bare word: a number, true, false, null, or text.
        let end = self.rest().find([',', '}', ']']).unwrap_or(self.rest().len());
        let word = self.rest()[..end].trim().to_string();
        self.at += end;
        Some(serde_json::from_str(&word).unwrap_or(Value::String(word)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> Vec<String> {
        vec!["workspace_write".into(), "workspace_read".into(), "set_timer".into()]
    }

    #[test]
    fn a_gemma_call_written_in_the_text_becomes_a_call() {
        let text = "<|tool_call>call:workspace_write{content:<|\"|>riga 1\nil cane, mangia {tutto}\n<|\"|>,path:<|\"|>notes.txt<|\"|>}<tool_call|>";
        let (calls, rest) = calls_in_text(text, &names()).unwrap();
        assert_eq!(rest, "");
        assert_eq!(calls[0]["name"], "workspace_write");
        let input: Value = serde_json::from_str(calls[0]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(input, json!({ "content": "riga 1\nil cane, mangia {tutto}\n", "path": "notes.txt" }));
        let (calls, rest) = calls_in_text("Lo rileggo. <|tool_call>call:workspace_read{path:<|\"|>frutti.txt<|\"|>}<tool_call|>", &names()).unwrap();
        assert_eq!((calls.len(), rest.as_str()), (1, "Lo rileggo."));
        let (calls, _) = calls_in_text("<|tool_call>call:set_timer{seconds:180,label:<|\"|>Pasta<|\"|>,repeat:false}<tool_call|>", &names()).unwrap();
        assert_eq!(calls[0]["arguments"], json!({ "seconds": 180, "label": "Pasta", "repeat": false }).to_string());
    }

    #[test]
    fn a_hermes_call_written_in_the_text_becomes_a_call() {
        let text = "Ok.\n<tool_call>\n{\"name\": \"set_timer\", \"arguments\": {\"seconds\": 60}}\n</tool_call>";
        let (calls, rest) = calls_in_text(text, &names()).unwrap();
        assert_eq!((rest.as_str(), calls[0]["arguments"].as_str()), ("Ok.", Some("{\"seconds\":60}")));
    }

    #[test]
    fn text_without_calls_or_with_unknown_ones_stays() {
        assert!(calls_in_text("Nessuna chiamata qui.", &names()).is_none());
        assert!(calls_in_text("<|tool_call>call:delete_all{}<tool_call|>", &names()).is_none());
        assert!(calls_in_text("<tool_call>not json</tool_call>", &names()).is_none());
    }
}
