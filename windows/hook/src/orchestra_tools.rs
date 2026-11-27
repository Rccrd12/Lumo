//! The orchestra's tools (src-tauri/src/orchestra.rs), as an MCP server lists
//! them. One file for both sides, as island_tools.rs: lumo-hook's MCP server
//! offers them to a CLI that is a member of an orchestra (mcp.rs, with
//! `--tools=island`, when `LUMO_CHAT_ID` is a member's chat), and the app
//! reads this very file (`#[path]`) to offer them to its API providers and
//! local models. The coordinator gets its own; a thread its own.
//! Only serde_json here.

use serde_json::{json, Value};

/// Every member's chat id: `orch-<orchestra>-m-<member>`.
pub const PREFIX: &str = "orch-";
pub const MEMBER: &str = "-m-";
pub const COORDINATOR: &str = "coordinator";

pub const START_THREAD: &str = "start_thread";
pub const MESSAGE_THREAD: &str = "message_thread";
pub const READ_THREAD: &str = "read_thread";
pub const LIST_THREADS: &str = "list_threads";
pub const STOP_THREAD: &str = "stop_thread";
pub const ASK_USER: &str = "ask_user";
pub const MESSAGE_COORDINATOR: &str = "message_coordinator";
pub const SHARE_FILE: &str = "share_file";
pub const READ_MESSAGES: &str = "read_messages";
/// Every tool of the orchestra (the plan tool is the chat's own, `update_plan`).
pub const NAMES: [&str; 9] = [START_THREAD, MESSAGE_THREAD, READ_THREAD, LIST_THREADS, STOP_THREAD, ASK_USER, MESSAGE_COORDINATOR, SHARE_FILE, READ_MESSAGES];

/// The orchestra and the member of a chat id, when it is a member's.
pub fn parse_chat(chat: &str) -> Option<(&str, &str)> {
    let rest = chat.strip_prefix(PREFIX)?;
    let (id, member) = rest.split_once(MEMBER)?;
    (!id.is_empty() && !member.is_empty()).then_some((id, member))
}

/// One tool: its name, what it does, and the JSON schema of its input.
fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": { "type": "object", "properties": properties, "required": required, "additionalProperties": false },
    })
}

fn ask_tool() -> Value {
    tool(
        ASK_USER,
        "Puts a decision in front of the user as a card with 2 to 4 options, one recommended. Use it when a choice would change the user's goal or cannot be undone. The user's choice comes later as a new message: end your turn after calling it unless other work does not depend on the answer.",
        json!({
            "question": { "type": "string", "description": "The question, short." },
            "options": {
                "type": "array", "minItems": 2, "maxItems": 4,
                "items": {
                    "type": "object",
                    "properties": {
                        "label": { "type": "string", "description": "A few words, with no letter or number in front: the card letters the options A, B, C, D itself." },
                        "consequence": { "type": "string", "description": "One sentence: what happens if chosen." },
                    },
                    "required": ["label", "consequence"],
                    "additionalProperties": false,
                },
            },
            "recommended": { "type": "integer", "description": "The index of the option you recommend, from 0." },
        }),
        &["question", "options", "recommended"],
    )
}

fn message_thread_tool() -> Value {
    tool(
        MESSAGE_THREAD,
        "Sends a message to a thread of the orchestra. A thread that is working reads it at its next step; one that is not starts working on it.",
        json!({
            "thread": { "type": "string", "description": "The thread's id (t1, t2…) or its title." },
            "message": { "type": "string" },
        }),
        &["thread", "message"],
    )
}

fn read_messages_tool() -> Value {
    tool(
        READ_MESSAGES,
        "Gives you the messages that came for you since you last read them (from the user, the coordinator, other threads, Lumo). Call it between the steps of a long task, so a change of plan reaches you at once.",
        json!({}),
        &[],
    )
}

/// The coordinator's tools: it plans and hands out the work, nothing else.
pub fn coordinator_tools() -> Vec<Value> {
    vec![
        tool(
            START_THREAD,
            "Starts a thread: a worker with its own chat and model that does one part of the job. It does not see this conversation: give it everything it needs in the task. It reports to you with a message when it is done or blocked.",
            json!({
                "title": { "type": "string", "description": "A short name for the thread, 2 to 4 words." },
                "task": { "type": "string", "description": "The whole task: goal, context, files, constraints, and what to report." },
            }),
            &["title", "task"],
        ),
        message_thread_tool(),
        tool(
            READ_THREAD,
            "Reads a thread: its state, what it is doing, and its last messages.",
            json!({
                "thread": { "type": "string", "description": "The thread's id (t1, t2…) or its title." },
                "last": { "type": "integer", "description": "How many of its last messages, 6 if left out." },
            }),
            &["thread"],
        ),
        tool(LIST_THREADS, "Lists the threads: their id, title, task, state, what each is doing and the files each is changing.", json!({}), &[]),
        tool(
            STOP_THREAD,
            "Stops a thread's work at once. It keeps its chat and can be given more with message_thread.",
            json!({ "thread": { "type": "string", "description": "The thread's id or title." } }),
            &["thread"],
        ),
        ask_tool(),
        read_messages_tool(),
    ]
}

/// A thread's tools, besides the chat's own.
pub fn thread_tools() -> Vec<Value> {
    vec![
        tool(
            MESSAGE_COORDINATOR,
            "Sends a message to the coordinator when you need something from it: another thread, a decision about your task, help when you are blocked. Your answers in your chat reach it by themselves. With done true, your task is finished: say what you did and where the results are.",
            json!({
                "message": { "type": "string" },
                "done": { "type": "boolean", "description": "True when your task is finished." },
            }),
            &["message"],
        ),
        message_thread_tool(),
        ask_tool(),
        tool(
            SHARE_FILE,
            "Hands the user and the coordinator a file you made (a report, a plan, a result): it shows as a card they can open. Markdown files open beside the chat. The path: one in the orchestra's shared folder, or a full path.",
            json!({
                "path": { "type": "string", "description": "The file's path." },
                "note": { "type": "string", "description": "Optional: one line on what it is." },
            }),
            &["path"],
        ),
        read_messages_tool(),
    ]
}

/// The tools of the member whose chat is `chat`; none for another chat.
pub fn tools_for(chat: &str) -> Vec<Value> {
    match parse_chat(chat) {
        Some((_, COORDINATOR)) => coordinator_tools(),
        Some(_) => thread_tools(),
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_member_gets_its_role_tools_and_another_chat_none() {
        let names = |chat: &str| tools_for(chat).iter().map(|t| t["name"].as_str().unwrap_or("").to_string()).collect::<Vec<_>>();
        let coordinator = names("orch-abc-m-coordinator");
        assert!(coordinator.contains(&START_THREAD.to_string()) && !coordinator.contains(&SHARE_FILE.to_string()));
        let thread = names("orch-abc-m-t2");
        assert!(thread.contains(&MESSAGE_COORDINATOR.to_string()) && !thread.contains(&START_THREAD.to_string()));
        assert!(names("chat-123").is_empty());
        assert_eq!(parse_chat("orch-abc-m-t2"), Some(("abc", "t2")));
        // Every tool listed is one of NAMES, and has a schema.
        for t in coordinator_tools().into_iter().chain(thread_tools()) {
            assert!(NAMES.contains(&t["name"].as_str().unwrap()));
            assert_eq!(t["inputSchema"]["type"], "object");
        }
    }
}
