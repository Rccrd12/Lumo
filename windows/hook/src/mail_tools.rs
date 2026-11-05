//! Lumo's email tools, as an MCP server lists them: the ones that read, the
//! ones that send (each email on Lumo's card first) and the ones that change
//! the mailbox (each change on a card). One file for both sides: lumo-hook's
//! MCP server offers them to the CLIs (mcp.rs), and the app reads this very
//! file (`#[path]`, tools.rs) to offer them to its API providers (Anthropic,
//! OpenAI, Google, OpenRouter and the local model servers), so the names,
//! words and inputs never drift apart. Only serde_json here.

use serde_json::{json, Value};

/// One tool, as `tools/list` gives it: name, what it does, the JSON schema of its input.
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

/// Lumo's email tools that read, as `tools/list` gives them.
pub fn mail_tools() -> Vec<Value> {
    let count = json!({ "type": "integer", "minimum": 1, "maximum": 25, "description": "How many, newest first: 10 by default." });
    let folder = |what: &str| json!({ "type": "string", "description": format!("Optional: {what}") });
    vec![
        tool(
            "mail_recent",
            "The newest emails of the user's inbox (or of another folder), newest first, read or not (each says \
whether it is unread), with sender, date, subject, the start of the text and an id to read it in full.",
            json!({
                "count": count,
                "unread_only": { "type": "boolean", "description": "Only the unread ones." },
                "folder": folder("a folder other than the inbox: a name mail_folders gives, or sent, drafts, archive, trash, spam."),
            }),
            &[],
        ),
        tool(
            "mail_search",
            "Searches the user's email, newest first: on Gmail all the mail, elsewhere every folder but the trash \
and spam, or only the folder given. On Gmail the query is a Gmail search (\"from:amazon newer_than:30d\", \
\"subject:invoice\", \"has:attachment\"); elsewhere, words found in the email.",
            json!({
                "query": { "type": "string", "minLength": 1, "maxLength": 300 },
                "count": count,
                "folder": folder("only this folder: a name mail_folders gives, or inbox, sent, drafts, archive, trash, spam."),
            }),
            &["query"],
        ),
        tool(
            "mail_read",
            "One email in full: its text, sender, date and subject, and the files attached to it, numbered. It \
stays unread if it was.",
            json!({ "id": { "type": "string", "description": "The id mail_recent or mail_search gave." } }),
            &["id"],
        ),
        tool(
            "mail_attachment",
            "Saves a file attached to an email with the files attached to the chat, and gives its full path: then \
read it as you read any file the user attached (a PDF, a picture, a document). It stays in the mailbox too.",
            json!({
                "id": { "type": "string", "description": "The email's id." },
                "attachment": { "type": "string", "description": "The file's number in mail_read's list (\"1\"), or its name. Optional when the email has one file." },
            }),
            &["id"],
        ),
        tool(
            "mail_folders",
            "The folders of the user's mailbox, what each is for (sent, drafts, trash…) and how many emails, read \
and unread, it holds.",
            json!({}),
            &[],
        ),
    ]
}

/// The email tools' names, as `mail_tools()` lists them. They only read.
pub const MAIL_NAMES: &[&str] = &["mail_recent", "mail_search", "mail_read", "mail_attachment", "mail_folders"];

/// The tool that sends a new email: Lumo shows it on a card and sends it only on the user's click.
pub const MAIL_SEND: &str = "mail_send";

/// The tools that send or write an email (`--tools=mail,mailsend`): every email sent on Lumo's card first.
pub const MAIL_SEND_NAMES: &[&str] = &[MAIL_SEND, "mail_reply", "mail_forward", "mail_draft"];

/// The tools that change the mailbox (`mailmanage`), each change on Lumo's card first.
pub const MAIL_MANAGE_NAMES: &[&str] = &["mail_mark", "mail_move", "mail_archive", "mail_trash"];

/// Any of Lumo's email tools: Lumo answers them as `lumo_mail`.
pub fn mail_tool(name: &str) -> bool {
    MAIL_NAMES.contains(&name) || MAIL_SEND_NAMES.contains(&name) || MAIL_MANAGE_NAMES.contains(&name)
}

/// The tools that send, offered with `--tools=mail,mailsend`.
pub fn mail_send_tools() -> Vec<Value> {
    let people = |what: &str| json!({ "type": "array", "items": { "type": "string" }, "maxItems": 20, "description": what });
    let files = json!({ "type": "array", "items": { "type": "string" }, "maxItems": 10, "description": "Optional: full paths of files to attach, at most 18 MB together." });
    let id = json!({ "type": "string", "description": "The id mail_recent or mail_search gave." });
    vec![
        tool(
            MAIL_SEND,
            "Sends an email from the user's account (the one Lumo reads). The user sees it on a card in Lumo and \
it goes only if they click Send; if they discard it, nothing is sent. Use it only when the user asked to send \
an email, with the whole text ready to go, in the language they write to that person in. Files go as \
attachments when you give their full paths: the ones the user attached to the chat, or others on their \
computer they asked for (never one in app data or a hidden folder). To answer an email, use mail_reply.",
            json!({
                "to": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 20, "description": "Plain email addresses, like name@example.com." },
                "cc": people("Optional: more plain addresses, in copy."),
                "subject": { "type": "string", "maxLength": 300 },
                "body": { "type": "string", "minLength": 1, "description": "The email's whole text, plain text." },
                "attachments": files,
            }),
            &["to", "subject", "body"],
        ),
        tool(
            "mail_reply",
            "Answers an email in its own conversation: to its sender (reply_all: everyone who had it too), with \
\"Re:\" and the email quoted under the answer. On a card in Lumo first, sent only if the user clicks Send. Use \
it only when the user asked to answer, with the whole answer ready to go.",
            json!({
                "id": id,
                "body": { "type": "string", "minLength": 1, "description": "The answer, plain text; Lumo puts the email answered under it." },
                "reply_all": { "type": "boolean", "description": "Also to everyone the email went to or had in copy." },
                "cc": people("Optional: more plain addresses, in copy."),
                "attachments": files,
            }),
            &["id", "body"],
        ),
        tool(
            "mail_forward",
            "Forwards an email to someone, with the files attached to it (with_files false leaves them out), \
under a few words of the user's if you give them. On a card in Lumo first, sent only if the user clicks Send.",
            json!({
                "id": id,
                "to": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 20, "description": "Plain email addresses." },
                "cc": people("Optional: more plain addresses, in copy."),
                "body": { "type": "string", "description": "Optional: what to write above the email forwarded." },
                "with_files": { "type": "boolean", "description": "Forward its files too: true by default." },
            }),
            &["id", "to"],
        ),
        tool(
            "mail_draft",
            "Saves an email in the Drafts of the user's mailbox, not sent: they find it in their email app to \
read, finish and send themselves. With reply_to, a reply to that email, in its conversation.",
            json!({
                "to": people("Optional: plain addresses."),
                "cc": people("Optional: more plain addresses, in copy."),
                "subject": { "type": "string", "maxLength": 300 },
                "body": { "type": "string", "minLength": 1, "description": "The email's text, plain text." },
                "attachments": files,
                "reply_to": { "type": "string", "description": "Optional: the id of the email it answers." },
            }),
            &["body"],
        ),
    ]
}

/// The tools that change the mailbox, offered with `mailmanage`.
pub fn mail_manage_tools() -> Vec<Value> {
    let id = || json!({ "type": "string", "description": "The id mail_recent or mail_search gave." });
    vec![
        tool(
            "mail_mark",
            "Marks an email read or unread, and starred or not. The user approves it on a card in Lumo.",
            json!({
                "id": id(),
                "read": { "type": "boolean", "description": "true: read; false: unread." },
                "starred": { "type": "boolean", "description": "true: starred (flagged); false: not." },
            }),
            &["id"],
        ),
        tool(
            "mail_move",
            "Moves an email to another folder of the mailbox (on Gmail, a label). The user approves it on a card in Lumo.",
            json!({
                "id": id(),
                "folder": { "type": "string", "description": "A name mail_folders gives, or inbox, archive, spam." },
            }),
            &["id", "folder"],
        ),
        tool("mail_archive", "Archives an email: out of the inbox, kept in the archive. The user approves it on a card in Lumo.", json!({ "id": id() }), &["id"]),
        tool(
            "mail_trash",
            "Moves an email to the trash, where the user can still get it back: Lumo never deletes one for good. The \
user approves it on a card in Lumo.",
            json!({ "id": id() }),
            &["id"],
        ),
    ]
}
