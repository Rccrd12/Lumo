//! `lumo-hook --mcp`: Lumo's computer use, as an MCP server Claude Code starts
//! for the island's chat (claude_code.rs passes it with `--mcp-config` when
//! Settings → Chat → "Let Claude use the computer" is on).
//!
//! It speaks MCP over stdin and stdout (JSON-RPC, one message per line) and
//! hands every tool call to Lumo over the same pipe or socket as the hooks
//! (`{"lumo_computer": {"tool": …, "input": …}}`), then gives Claude Code
//! Lumo's answer: a screenshot, or what was done. The app decides everything:
//! whether computer use is on, whether a chat turn is running, whether the
//! user pressed Esc. Nothing is clicked or typed here.
//!
//! The tools copy the names and inputs of Claude's own computer use tool
//! (`screenshot`, `left_click`, `type`, `key`…), which the models know well.

use std::io::{BufRead, Read, Write};
use std::sync::mpsc;
use std::time::Duration;

use serde_json::{json, Value};

/// The longest a call may take: `wait` asks for up to a minute, and a typed
/// text or a drag needs a little more.
const CALL_BUDGET: Duration = Duration::from_secs(90);
/// What Lumo may answer with, at most: a screenshot is well under this.
const MAX_ANSWER: usize = 24 * 1024 * 1024;
/// The protocol version answered when the client names none we know.
const PROTOCOL: &str = "2025-06-18";
const KNOWN_PROTOCOLS: &[&str] = &["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

const INSTRUCTIONS: &str = "Lumo's tools to see and use the user's Windows desktop: take a screenshot first, \
then click, type and press keys at coordinates in that screenshot's pixels. Take a new screenshot after \
acting to check what happened. Prefer other tools (commands, files) when they can do the job. The user can \
press Esc at any time to stop you.";

/// One tool: its name, what it does, and the JSON schema of its input.
fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false,
        },
    })
}

fn coordinate(what: &str) -> Value {
    json!({
        "type": "array",
        "items": { "type": "integer", "minimum": 0 },
        "minItems": 2,
        "maxItems": 2,
        "description": format!("[x, y] {what}, in the pixels of the last screenshot."),
    })
}

fn modifiers() -> Value {
    json!({ "type": "string", "description": "Keys to hold during the action, e.g. \"shift\" or \"ctrl+shift\"." })
}

/// Every tool Lumo offers, as `tools/list` gives them.
pub fn tools() -> Vec<Value> {
    let click = |name: &str, what: &str| {
        tool(
            name,
            &format!("{what} at a point of the screen (or where the mouse is, without a coordinate)."),
            json!({ "coordinate": coordinate("where to click"), "text": modifiers() }),
            &[],
        )
    };
    vec![
        tool(
            "screenshot",
            "Takes a screenshot of the screen Claude is working on. Lumo's own island is left out of it. \
Coordinates for every other tool are in this screenshot's pixels.",
            json!({ "display": { "type": "integer", "minimum": 1, "description": "Which screen, from 1, when there are several. Keeps the one in use when left out." } }),
            &[],
        ),
        tool(
            "zoom",
            "A closer, sharper look at a region of the screen, to read small text. Coordinates stay those of the full screenshot.",
            json!({
                "region": {
                    "type": "array",
                    "items": { "type": "integer", "minimum": 0 },
                    "minItems": 4,
                    "maxItems": 4,
                    "description": "[x0, y0, x1, y1]: top left and bottom right, in the pixels of the last screenshot.",
                },
            }),
            &["region"],
        ),
        click("left_click", "Left click"),
        click("right_click", "Right click"),
        click("middle_click", "Middle click"),
        click("double_click", "Double click"),
        click("triple_click", "Triple click (selects a line or a paragraph)"),
        tool(
            "mouse_move",
            "Moves the mouse without clicking, e.g. to show a tooltip or open a menu on hover.",
            json!({ "coordinate": coordinate("where to move the mouse") }),
            &["coordinate"],
        ),
        tool(
            "left_click_drag",
            "Presses the left button at one point, drags to another and lets go.",
            json!({ "start_coordinate": coordinate("where the drag starts"), "coordinate": coordinate("where it ends") }),
            &["start_coordinate", "coordinate"],
        ),
        tool(
            "scroll",
            "Turns the mouse wheel at a point (or where the mouse is).",
            json!({
                "coordinate": coordinate("where to scroll"),
                "scroll_direction": { "type": "string", "enum": ["up", "down", "left", "right"] },
                "scroll_amount": { "type": "integer", "minimum": 1, "maximum": 30, "description": "Wheel clicks, 3 is about a few lines." },
                "text": modifiers(),
            }),
            &["scroll_direction"],
        ),
        tool(
            "type",
            "Types text where the keyboard is (click the field first). A line break presses Enter.",
            json!({ "text": { "type": "string", "maxLength": 5000 } }),
            &["text"],
        ),
        tool(
            "key",
            "Presses a key or a combination: \"Return\", \"Tab\", \"Escape\", \"ctrl+s\", \"alt+tab\", \"Page_Down\", \"super\".",
            json!({
                "text": { "type": "string" },
                "repeat": { "type": "integer", "minimum": 1, "maximum": 100, "description": "How many times, 1 by default." },
            }),
            &["text"],
        ),
        tool(
            "wait",
            "Waits, e.g. for a page or an app to load, then go on with a screenshot.",
            json!({ "duration": { "type": "number", "minimum": 0, "maximum": 60, "description": "Seconds." } }),
            &["duration"],
        ),
        tool("cursor_position", "Where the mouse is, in the pixels of the last screenshot.", json!({}), &[]),
    ]
}

/// The tools that only look: they never get a card (reply.rs) and Claude Code
/// may run them without asking (claude_code.rs passes them as allowed).
pub const LOOKING: &[&str] = &["screenshot", "zoom", "cursor_position", "wait"];

/// The name the server has in the island's `--mcp-config`: its tools are `mcp__lumo__<tool>`.
pub const SERVER: &str = "lumo";

/// Runs the server until Claude Code closes stdin.
pub fn run() -> ! {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(answer) = handle(&line, &call_lumo) {
            let _ = writeln!(out, "{answer}");
            let _ = out.flush();
        }
    }
    std::process::exit(0);
}

/// The answer to one message, or nothing for a notification. `lumo` hands a
/// tool call to the app (the pipe in `run`, a stand-in in the tests).
pub fn handle(line: &str, lumo: &dyn Fn(&Value) -> Result<Value, String>) -> Option<String> {
    let Ok(message) = serde_json::from_str::<Value>(line) else {
        return Some(error(Value::Null, -32700, "Parse error").to_string());
    };
    let id = message.get("id").cloned()?;
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL);
            let version = if KNOWN_PROTOCOLS.contains(&asked) { asked } else { PROTOCOL };
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": SERVER, "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS,
            })
        }
        "ping" => json!({}),
        "tools/list" => json!({ "tools": tools() }),
        "tools/call" => call(&params, lumo),
        _ => return Some(error(id, -32601, "Method not found").to_string()),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string())
}

fn error(id: Value, code: i32, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// A tool's result as MCP gives it: Lumo's image first when there is one, then its words.
fn call(params: &Value, lumo: &dyn Fn(&Value) -> Result<Value, String>) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or("");
    if !tools().iter().any(|t| t["name"] == name) {
        return failed(&format!("Lumo has no tool called {name}."));
    }
    let input = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let request = json!({ "lumo_computer": { "tool": name, "input": input } });
    let answer = match lumo(&request) {
        Ok(answer) => answer,
        Err(message) => return failed(&message),
    };
    if let Some(message) = answer.get("error").and_then(Value::as_str) {
        return failed(message);
    }
    let mut content = Vec::new();
    if let Some(data) = answer.get("image").and_then(Value::as_str).filter(|d| !d.is_empty()) {
        let mime = answer.get("mime").and_then(Value::as_str).unwrap_or("image/png");
        content.push(json!({ "type": "image", "data": data, "mimeType": mime }));
    }
    let text = answer.get("text").and_then(Value::as_str).unwrap_or("Done.");
    content.push(json!({ "type": "text", "text": text }));
    json!({ "content": content })
}

fn failed(message: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
}

/// Hands `request` to Lumo and reads its one-line answer, within CALL_BUDGET.
fn call_lumo(request: &Value) -> Result<Value, String> {
    let closed = || "Lumo isn't running, or its computer use is off. Ask the user to open Lumo and turn on Let Claude use the computer in Settings, under Chat.".to_string();
    let line = format!("{request}\n");
    let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
    std::thread::spawn(move || {
        let _ = tx.send(exchange(&line));
    });
    match rx.recv_timeout(CALL_BUDGET) {
        Ok(Some(bytes)) => serde_json::from_slice(&bytes).map_err(|_| closed()),
        Ok(None) => Err(closed()),
        Err(_) => Err("Lumo took too long to answer.".into()),
    }
}

fn exchange(line: &str) -> Option<Vec<u8>> {
    let mut pipe = crate::connect()?;
    pipe.write_all(line.as_bytes()).ok()?;
    let _ = pipe.flush();
    let mut buf = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        match pipe.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') || buf.len() > MAX_ANSWER {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let end = buf.iter().position(|b| *b == b'\n').unwrap_or(buf.len());
    buf.truncate(end);
    (!buf.is_empty()).then_some(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ask(line: &str, lumo: &dyn Fn(&Value) -> Result<Value, String>) -> Value {
        serde_json::from_str(&handle(line, lumo).expect("an answer")).unwrap()
    }

    fn never(_: &Value) -> Result<Value, String> {
        panic!("Lumo was not to be asked")
    }

    #[test]
    fn it_introduces_itself_and_lists_its_tools() {
        let v = ask(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{}}}"#, &never);
        assert_eq!(v["id"], 1);
        assert_eq!(v["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(v["result"]["serverInfo"]["name"], "lumo");
        assert!(v["result"]["capabilities"]["tools"].is_object());
        let v = ask(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1999-01-01"}}"#, &never);
        assert_eq!(v["result"]["protocolVersion"], PROTOCOL, "an unknown version gets ours");

        let v = ask(r#"{"jsonrpc":"2.0","id":"a","method":"tools/list"}"#, &never);
        let names: Vec<&str> = v["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        for n in ["screenshot", "zoom", "left_click", "double_click", "left_click_drag", "scroll", "type", "key", "wait", "cursor_position"] {
            assert!(names.contains(&n), "{n}");
        }
        for t in v["result"]["tools"].as_array().unwrap() {
            assert_eq!(t["inputSchema"]["type"], "object", "{}", t["name"]);
        }
        for n in LOOKING {
            assert!(names.contains(n), "{n}");
        }
    }

    #[test]
    fn notifications_get_no_answer_and_unknown_methods_an_error() {
        assert!(handle(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, &never).is_none());
        let v = ask(r#"{"jsonrpc":"2.0","id":7,"method":"resources/list"}"#, &never);
        assert_eq!(v["error"]["code"], -32601);
        let v = ask("not json", &never);
        assert_eq!(v["error"]["code"], -32700);
        let v = ask(r#"{"jsonrpc":"2.0","id":8,"method":"ping"}"#, &never);
        assert_eq!(v["result"], json!({}));
    }

    #[test]
    fn a_call_goes_to_lumo_and_comes_back_as_image_and_text() {
        let lumo = |req: &Value| -> Result<Value, String> {
            assert_eq!(req["lumo_computer"]["tool"], "screenshot");
            assert_eq!(req["lumo_computer"]["input"], json!({}));
            Ok(json!({ "image": "iVBOR", "text": "Screen 1 of 1, 1280×720." }))
        };
        let v = ask(r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"screenshot"}}"#, &lumo);
        let content = v["result"]["content"].as_array().unwrap();
        assert_eq!(content[0], json!({ "type": "image", "data": "iVBOR", "mimeType": "image/png" }));
        assert_eq!(content[1]["text"], "Screen 1 of 1, 1280×720.");
        assert!(v["result"].get("isError").is_none());

        let click = |req: &Value| -> Result<Value, String> {
            assert_eq!(req["lumo_computer"]["input"]["coordinate"], json!([10, 20]));
            Ok(json!({ "text": "Clicked." }))
        };
        let v = ask(r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"left_click","arguments":{"coordinate":[10,20]}}}"#, &click);
        assert_eq!(v["result"]["content"], json!([{ "type": "text", "text": "Clicked." }]));
    }

    #[test]
    fn what_lumo_refuses_and_unknown_tools_are_errors_claude_reads() {
        let refuse = |_: &Value| -> Result<Value, String> { Ok(json!({ "error": "The user pressed Esc." })) };
        let v = ask(r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"type","arguments":{"text":"hi"}}}"#, &refuse);
        assert_eq!(v["result"]["isError"], true);
        assert_eq!(v["result"]["content"][0]["text"], "The user pressed Esc.");

        let closed = |_: &Value| -> Result<Value, String> { Err("Lumo isn't running.".into()) };
        let v = ask(r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"key","arguments":{"text":"ctrl+s"}}}"#, &closed);
        assert_eq!(v["result"]["isError"], true);

        let v = ask(r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"format_disk"}}"#, &never);
        assert_eq!(v["result"]["isError"], true);
    }
}
