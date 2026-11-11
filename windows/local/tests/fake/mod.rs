// A fake model server: each connection gets the next reply of a script, as
// Ollama, LM Studio or Unsloth Studio would send it, and every request's body
// is kept for the test to look at.

#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use lumo_local::{Doing, Endpoint, Hooks, Loaded, MORE};
use serde_json::{json, Value};

pub enum Reply {
    /// Event lines (`data: …`), then the connection closes.
    Events(Vec<String>),
    /// Event lines, then the connection stays open until the client goes
    /// (LM Studio after `[DONE]`, or a stream that hangs).
    Hold(Vec<String>),
    /// A status and a JSON body, as a whole answer or a refusal.
    Json(u16, String),
    /// The head of a streamed answer, then the connection closes.
    Headers,
    /// The head of a streamed answer, these bytes as they are, then the close.
    Raw(Vec<u8>),
    /// Event lines one at a time, this long apart, then the connection closes
    /// (a model that takes its time over a long call).
    Paced(Vec<String>, Duration),
}

pub struct Fake {
    pub url: String,
    requests: Arc<Mutex<Vec<Value>>>,
}

impl Fake {
    pub fn requests(&self) -> Vec<Value> {
        self.requests.lock().unwrap().clone()
    }

    pub fn endpoint(&self) -> Endpoint {
        let client = |b: reqwest::ClientBuilder| b.no_proxy().build().unwrap();
        Endpoint {
            url: format!("{}/v1/chat/completions", self.url),
            authorization: "Bearer test".into(),
            streaming: client(reqwest::Client::builder().read_timeout(Duration::from_secs(10))),
            whole: client(reqwest::Client::builder().timeout(Duration::from_secs(10))),
            stall: Duration::from_secs(1),
        }
    }
}

pub fn serve(replies: Vec<Reply>) -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let kept = requests.clone();
    std::thread::spawn(move || {
        for reply in replies {
            let Ok((conn, _)) = listener.accept() else { return };
            let kept = kept.clone();
            std::thread::spawn(move || reply_on(conn, reply, kept));
        }
    });
    Fake { url, requests }
}

fn reply_on(mut conn: TcpStream, reply: Reply, kept: Arc<Mutex<Vec<Value>>>) {
    let _ = conn.set_read_timeout(Some(Duration::from_secs(10)));
    let body = read_request(&mut conn);
    kept.lock().unwrap().push(serde_json::from_slice(&body).unwrap_or(Value::Null));
    let sse = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
    let lines = |events: &[String]| events.iter().map(|e| format!("data: {e}\n\n")).collect::<String>();
    let hold = match reply {
        Reply::Events(events) => {
            let _ = conn.write_all(format!("{sse}{}", lines(&events)).as_bytes());
            false
        }
        Reply::Hold(events) => {
            let _ = conn.write_all(format!("{sse}{}", lines(&events)).as_bytes());
            true
        }
        Reply::Json(status, body) => {
            let head = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = conn.write_all(format!("{head}{body}").as_bytes());
            false
        }
        Reply::Headers => {
            let _ = conn.write_all(sse.as_bytes());
            false
        }
        Reply::Raw(bytes) => {
            let _ = conn.write_all(sse.as_bytes());
            let _ = conn.write_all(&bytes);
            false
        }
        Reply::Paced(events, gap) => {
            let _ = conn.write_all(sse.as_bytes());
            for event in &events {
                let _ = conn.write_all(lines(std::slice::from_ref(event)).as_bytes());
                let _ = conn.flush();
                std::thread::sleep(gap);
            }
            false
        }
    };
    let _ = conn.flush();
    if !hold {
        let _ = conn.shutdown(std::net::Shutdown::Write);
    }
    // Until the client closes its side (or gives up on the answer).
    let mut sink = [0u8; 8192];
    while matches!(conn.read(&mut sink), Ok(n) if n > 0) {}
}

/// One request: the head up to the blank line, then `Content-Length` bytes.
fn read_request(conn: &mut TcpStream) -> Vec<u8> {
    let mut data = Vec::new();
    let mut buf = [0u8; 8192];
    let end = loop {
        if let Some(i) = data.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        match conn.read(&mut buf) {
            Ok(0) | Err(_) => return Vec::new(),
            Ok(n) => data.extend_from_slice(&buf[..n]),
        }
    };
    let head = String::from_utf8_lossy(&data[..end]).to_lowercase();
    let length = head.lines().find_map(|l| l.strip_prefix("content-length:")).and_then(|n| n.trim().parse::<usize>().ok()).unwrap_or(0);
    while data.len() < end + length {
        match conn.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => data.extend_from_slice(&buf[..n]),
        }
    }
    data[end..(end + length).min(data.len())].to_vec()
}

// ── What servers send ────────────────────────────────────────────────────────

pub fn text(s: &str) -> String {
    json!({ "choices": [{ "delta": { "content": s } }] }).to_string()
}

pub fn reasoning(s: &str) -> String {
    json!({ "choices": [{ "delta": { "content": null, "reasoning_content": s } }] }).to_string()
}

pub fn call(id: &str, name: &str, arguments: &str) -> String {
    json!({ "choices": [{ "delta": { "tool_calls": [{ "index": 0, "id": id, "type": "function", "function": { "name": name, "arguments": arguments } }] } }] }).to_string()
}

pub fn finish(reason: &str) -> String {
    json!({ "choices": [{ "delta": {}, "finish_reason": reason }] }).to_string()
}

pub fn usage(total: u64) -> String {
    json!({ "choices": [], "usage": { "prompt_tokens": total - 10, "completion_tokens": 10, "total_tokens": total } }).to_string()
}

pub const DONE: &str = "[DONE]";

/// A streamed answer of `s`, as LM Studio and Ollama end one.
pub fn answer(s: &str) -> Reply {
    Reply::Events(vec![text(s), finish("stop"), usage(50), DONE.into()])
}

/// A streamed call of one tool.
pub fn calls(id: &str, name: &str, arguments: &str) -> Reply {
    Reply::Events(vec![call(id, name, arguments), finish("tool_calls"), DONE.into()])
}

/// A whole (not streamed) answer.
pub fn whole(text: &str, calls: &[(&str, &str, &str)]) -> Reply {
    let calls: Vec<Value> = calls.iter().map(|(id, name, args)| json!({ "id": id, "type": "function", "function": { "name": name, "arguments": args } })).collect();
    let mut message = json!({ "role": "assistant", "content": text });
    if !calls.is_empty() {
        message["tool_calls"] = json!(calls);
    }
    let reason = if calls.is_empty() { "stop" } else { "tool_calls" };
    Reply::Json(200, json!({ "choices": [{ "message": message, "finish_reason": reason }], "usage": { "total_tokens": 77 } }).to_string())
}

// ── The request and the app ──────────────────────────────────────────────────

pub fn tools(names: &[String]) -> Value {
    json!(names.iter().map(|n| json!({ "type": "function", "function": { "name": n, "description": "", "parameters": { "type": "object" } } })).collect::<Vec<_>>())
}

pub fn request(user: Value, offered: &[&str]) -> Value {
    let mut body = json!({
        "model": "m",
        "messages": [{ "role": "system", "content": "system" }, user],
        "stream": true,
        "max_tokens": 8192,
        "stream_options": { "include_usage": true },
    });
    if !offered.is_empty() {
        body["tools"] = tools(&offered.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    }
    body
}

pub fn question(s: &str, offered: &[&str]) -> Value {
    request(json!({ "role": "user", "content": s }), offered)
}

/// The app, as the turn sees it: what it showed, the tools it ran.
#[derive(Default)]
pub struct Island {
    pub shown: Vec<String>,
    pub doing: Vec<Doing>,
    pub ran: Vec<(String, Value)>,
    /// The tools that can be loaded.
    pub catalog: Vec<String>,
    /// Every tool there is.
    pub all: Vec<String>,
    /// The tools fail.
    pub failing: bool,
    /// What each request took, as the turn said it.
    pub used: Vec<u64>,
    /// The plans Lumo made of a list in the answer.
    pub plans: Vec<Value>,
    /// When the island was hushed and when it spoke again.
    pub hushed: Vec<bool>,
}

impl Hooks for Island {
    fn shown(&mut self, text: &str) {
        self.shown.push(text.to_string());
    }

    fn doing(&mut self, doing: Doing) {
        self.doing.push(doing);
    }

    fn used(&mut self, tokens: u64) {
        self.used.push(tokens);
    }

    fn without_tools(&mut self) -> String {
        "system without tools".into()
    }

    fn load(&mut self, name: &str, input: &Value, offered: &[String]) -> Option<Loaded> {
        let wanted: Vec<String> = if name == MORE {
            input["names"].as_array()?.iter().filter_map(Value::as_str).filter(|n| self.catalog.iter().any(|c| c == n)).map(str::to_string).collect()
        } else if self.catalog.iter().any(|c| c == name) && !offered.iter().any(|o| o == name) {
            vec![name.to_string()]
        } else {
            return None;
        };
        let names: Vec<String> = offered.iter().cloned().chain(wanted.iter().cloned()).collect();
        Some(Loaded { system: format!("system with {}", names.join(", ")), tools: tools(&names), names, wanted })
    }

    fn known(&self) -> Vec<String> {
        self.all.clone()
    }

    fn call(&mut self, name: &str, input: Value) -> impl std::future::Future<Output = (String, bool)> + Send {
        self.ran.push((name.to_string(), input));
        let answer = (format!("{name} done"), self.failing);
        async move { answer }
    }

    fn show_plan(&mut self, input: &Value) {
        self.plans.push(input.clone());
    }

    fn hush(&mut self, on: bool) {
        self.hushed.push(on);
    }
}

pub fn block_on<T>(f: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
}

/// What the request said last (the content of its last message).
pub fn last_said(request: &Value) -> String {
    let m = request["messages"].as_array().unwrap().last().unwrap();
    m["content"].as_str().unwrap_or_default().to_string()
}

/// The names of the tools a request offered.
pub fn offered(request: &Value) -> Vec<String> {
    request["tools"].as_array().map(|t| t.iter().map(|t| t["function"]["name"].as_str().unwrap().to_string()).collect()).unwrap_or_default()
}
