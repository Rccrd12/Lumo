// The chat, whoever answers it: the conversation, the system prompt, and which
// provider a turn goes to. Each provider's own wire format lives in its module:
// claude.rs (Anthropic), openai_compat.rs (OpenAI, Google AI, OpenRouter),
// local_chat.rs (Ollama, LM Studio, any OpenAI-compatible server), and the
// signed-in CLIs: claude_code.rs (Claude Code), antigravity_cli.rs
// (Antigravity CLI) and codex_chat.rs (Codex).
//
// API keys never leave the credential store and file bytes never cross the IPC
// boundary: the island sends the question and gets the answer's text back.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::Poll;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::chat_usage::ChatUsage;
use crate::island::WINDOW_LABEL;
use crate::screen::{self, ScreenContext};
use crate::settings::Settings;
use crate::{antigravity_cli, claude, claude_code, codex_chat, local_chat, openai_compat, secrets};

pub const ANTHROPIC: &str = "anthropic";

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatContext {
    File { name: String, path: String },
    Window { app_name: String, title: String, url: Option<String> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatReply {
    pub text: String,
    /// The Claude Code session, Antigravity CLI conversation or Codex thread
    /// that answered (claude_code.rs, antigravity_cli.rs, codex_chat.rs), so a chat from the history can be
    /// continued where it left off.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// The user pressed Stop: `text` is what was written until then (maybe nothing).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub stopped: bool,
    /// How many plain turns the conversation holds after this one, so the
    /// island knows where to cut it when a message is edited (`Chat::rewind`).
    pub turns: usize,
}

impl ChatReply {
    pub fn answer(text: String, session: Option<String>) -> Self {
        ChatReply { text, session, stopped: false, turns: 0 }
    }

    pub fn stopped(text: String, session: Option<String>) -> Self {
        ChatReply { text, session, stopped: true, turns: 0 }
    }
}

/// The Stop button of the turn being answered. Claude Code checks it while it
/// reads the CLI's output (claude_code.rs); a request to an API is dropped as
/// soon as it is pressed (`Chat::unless_stopped`), which closes the connection.
#[derive(Default)]
pub struct Stop {
    stopped: AtomicBool,
    notify: tokio::sync::Notify,
}

impl Stop {
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        // A permit is kept when nobody waits yet, so `wait` cannot miss it.
        self.notify.notify_one();
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    async fn wait(&self) {
        while !self.is_stopped() {
            self.notify.notified().await;
        }
    }
}

/// A model a provider offers, for the picker in the chat view.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
}

// ── Conversation ──────────────────────────────────────────────────────────────

/// The conversation is kept twice: in the wire format of the provider that
/// answered last (Claude's carries web search blocks no other provider would
/// understand), and as plain text turns. Switching provider mid-conversation
/// rebuilds the history from the plain turns, so nothing in one provider's
/// format is ever sent to another.
#[derive(Default)]
pub struct Chat {
    /// The island's id for this chat (chats.ts), on the events its answer sends.
    id: String,
    inner: Mutex<Conversation>,
    /// The Stop of the turn being answered; a fresh one for each turn.
    stop: Mutex<Arc<Stop>>,
}

#[derive(Default)]
struct Conversation {
    /// Bumped by every reset, so an answer that lands after "New chat" is dropped.
    epoch: u64,
    /// The provider `native` belongs to.
    owner: Option<String>,
    native: Vec<Value>,
    /// `{"role", "content": text}` turns, the same whoever answered.
    plain: Vec<Value>,
    /// The Claude Code session (or Antigravity CLI conversation) the island's
    /// chat continues (claude_code.rs, antigravity_cli.rs).
    cli_session: Option<String>,
    /// The provider `cli_session` belongs to: one CLI never resumes the other's.
    cli_owner: Option<String>,
    /// Folders the user shared from File Explorer in this chat: Claude Code
    /// keeps reading them on the turns after (explorer.rs).
    cli_dirs: Vec<String>,
    /// Files the user added in this chat (name, path in the inbox). Claude Code
    /// is told about them again when it starts a fresh session on turns carried
    /// as text, after a message was edited.
    files: Vec<(String, String)>,
}

/// What a provider needs to build one turn.
pub struct Turn {
    epoch: u64,
    provider: String,
    /// No earlier turn: the file or window context rides along with this one.
    pub first: bool,
    /// The earlier turns, in this provider's format.
    pub history: Vec<Value>,
}

impl Chat {
    pub fn new(id: &str) -> Self {
        Chat { id: id.to_string(), ..Default::default() }
    }

    /// A chat of the tool workshop (the Tools tab's Add a tool, src/views/forge.ts):
    /// its id says so, and its answers get the workshop's instructions too.
    pub fn is_workshop(&self) -> bool {
        is_workshop(&self.id)
    }

    /// The island's id for this chat.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// Where this chat's answer tells the island how it is going.
    pub fn events(&self) -> ChatEvents {
        ChatEvents { chat: self.id.clone() }
    }

    pub fn reset(&self) {
        let mut c = self.inner.lock().unwrap();
        let epoch = c.epoch + 1;
        *c = Conversation { epoch, ..Default::default() };
    }

    /// Starts a turn with `provider`, converting the history if another
    /// provider answered the previous turns.
    pub fn begin(&self, provider: &str) -> Turn {
        let mut c = self.inner.lock().unwrap();
        if c.owner.as_deref() != Some(provider) {
            c.native = c.plain.clone();
            c.owner = Some(provider.to_string());
        }
        Turn {
            epoch: c.epoch,
            provider: provider.to_string(),
            first: c.plain.is_empty(),
            history: c.native.clone(),
        }
    }

    /// Puts a chat from the history back: its turns as plain text, and the
    /// session to continue, if a CLI answered it (as `cli_session` gave it).
    pub fn restore(&self, turns: Vec<(String, String)>, cli_session: Option<String>) {
        let mut c = self.inner.lock().unwrap();
        let epoch = c.epoch + 1;
        let plain = turns
            .into_iter()
            .filter(|(role, _)| role == "user" || role == "assistant")
            .map(|(role, content)| json!({ "role": role, "content": content }))
            .collect();
        let (cli_owner, cli_session) = match cli_session.as_deref().map(untag_session) {
            Some((owner, id)) => (Some(owner.to_string()), Some(id.to_string())),
            None => (None, None),
        };
        *c = Conversation { epoch, plain, cli_session, cli_owner, ..Default::default() };
    }

    /// An edited message: the conversation goes back to its first `keep` turns
    /// and continues from there. What came after is forgotten, and so is the
    /// Claude Code session, which remembers every turn: the next one starts
    /// afresh with the kept turns carried as text. Shared folders and files
    /// stay readable.
    pub fn rewind(&self, keep: usize) {
        let mut c = self.inner.lock().unwrap();
        c.epoch += 1;
        c.plain.truncate(keep);
        c.native.truncate(keep);
        if c.native.len() != c.plain.len() {
            c.owner = None; // rebuilt from the plain turns on the next one
        }
        c.cli_session = None;
        c.cli_owner = None;
    }

    /// How many plain turns the conversation holds.
    pub fn turns(&self) -> usize {
        self.inner.lock().unwrap().plain.len()
    }

    /// Remembers a file the user added to this chat.
    pub fn note_file(&self, name: &str, path: &str) {
        let mut c = self.inner.lock().unwrap();
        if !c.files.iter().any(|(_, p)| p == path) {
            c.files.push((name.to_string(), path.to_string()));
            let excess = c.files.len().saturating_sub(8);
            c.files.drain(..excess);
        }
    }

    /// The files added in this chat, oldest first.
    pub fn files(&self) -> Vec<(String, String)> {
        self.inner.lock().unwrap().files.clone()
    }

    /// A new Stop for the turn that starts now.
    pub fn arm(&self) -> Arc<Stop> {
        let stop = Arc::new(Stop::default());
        *self.stop.lock().unwrap() = stop.clone();
        stop
    }

    /// The Stop of the current turn.
    pub fn stopper(&self) -> Arc<Stop> {
        self.stop.lock().unwrap().clone()
    }

    /// The Stop button: ends the turn being answered, if there is one.
    pub fn stop(&self) {
        self.stopper().stop();
    }

    /// Runs `work` unless Stop is pressed first: then it is dropped (an HTTP
    /// request with it, which closes the connection) and the result is None.
    pub async fn unless_stopped<F: Future>(&self, work: F) -> Option<F::Output> {
        let stop = self.stopper();
        let mut work = std::pin::pin!(work);
        let mut stopped = std::pin::pin!(stop.wait());
        std::future::poll_fn(|cx| {
            if let Poll::Ready(out) = work.as_mut().poll(cx) {
                return Poll::Ready(Some(out));
            }
            stopped.as_mut().poll(cx).map(|_| None)
        })
        .await
    }

    /// The CLI session that answered this conversation last, as the island
    /// keeps it with the chat (`restore` takes it back): Claude Code's id as it
    /// is, as chats were saved before; another CLI's tagged with its provider.
    pub fn cli_session(&self) -> Option<String> {
        let c = self.inner.lock().unwrap();
        let id = c.cli_session.as_deref()?;
        Some(match c.cli_owner.as_deref() {
            Some(owner) if owner != claude_code::PROVIDER => format!("{owner}:{id}"),
            _ => id.to_string(),
        })
    }

    /// The session `provider` resumes: its own only, never another CLI's.
    pub fn cli_session_for(&self, provider: &str) -> Option<String> {
        let c = self.inner.lock().unwrap();
        c.cli_session.clone().filter(|_| c.cli_owner.as_deref() == Some(provider))
    }

    /// The folders Claude Code may read in this chat, with `shared` added.
    pub fn cli_dirs(&self, shared: Option<String>) -> Vec<String> {
        let mut c = self.inner.lock().unwrap();
        if let Some(dir) = shared.filter(|d| !c.cli_dirs.contains(d)) {
            c.cli_dirs.push(dir);
            let excess = c.cli_dirs.len().saturating_sub(8);
            c.cli_dirs.drain(..excess);
        }
        c.cli_dirs.clone()
    }

    /// Remembers the CLI session of `turn`, unless the chat was reset since.
    pub fn set_cli_session(&self, turn: &Turn, id: &str) {
        let mut c = self.inner.lock().unwrap();
        if c.epoch == turn.epoch {
            c.cli_session = Some(id.to_string());
            c.cli_owner = Some(turn.provider.clone());
        }
    }

    /// Records a finished turn: the user message and the answer in the
    /// provider's format, and their plain text. Only a successful turn is
    /// recorded, so the history always matches what the model saw.
    pub fn commit(&self, turn: &Turn, user: Value, assistant: Value, user_text: &str, answer: &str) {
        let mut c = self.inner.lock().unwrap();
        if c.epoch != turn.epoch || c.owner.as_deref() != Some(turn.provider.as_str()) {
            return;
        }
        c.native.push(user);
        c.native.push(assistant);
        c.plain.push(json!({ "role": "user", "content": user_text }));
        c.plain.push(json!({ "role": "assistant", "content": answer }));
    }
}

/// The events of one chat's answer, tagged with its id: the island shows them
/// only while that chat is on screen.
#[derive(Clone)]
pub struct ChatEvents {
    chat: String,
}

impl ChatEvents {
    /// The text of the answer written so far.
    pub fn delta(&self, app: &AppHandle, text: &str) {
        let _ = app.emit_to(WINDOW_LABEL, "chat-delta", json!({ "chat": self.chat, "text": text }));
    }

    /// What the answer is doing while no text shows (claude_code.rs Activity).
    pub fn activity(&self, app: &AppHandle, activity: impl Serialize) {
        let _ = app.emit_to(WINDOW_LABEL, "chat-activity", json!({ "chat": self.chat, "activity": activity }));
    }

    /// A file the answer read, edited or created (claude_code.rs FileTouch):
    /// the chat lists it, and may open it from now on (chat_files.rs).
    pub fn file(&self, app: &AppHandle, file: &claude_code::FileTouch) {
        crate::chat_files::remember(&file.path);
        let _ = app.emit_to(WINDOW_LABEL, "chat-file", json!({ "chat": self.chat, "kind": file.kind, "path": file.path }));
    }
}

// ── Every chat ────────────────────────────────────────────────────────────────

/// The chats Rust holds a conversation for, by the island's chat id: the one
/// on screen, and those still being answered in the background after the user
/// moved to another one. Each has its own Stop, so answers never mix.
#[derive(Default)]
pub struct Chats {
    map: Mutex<HashMap<String, Arc<Chat>>>,
}

impl Chats {
    /// The chat with this id; a fresh one when Rust has none yet.
    pub fn get(&self, id: &str) -> Arc<Chat> {
        let mut map = self.map.lock().unwrap();
        map.entry(id.to_string()).or_insert_with(|| Arc::new(Chat::new(id))).clone()
    }

    /// The chat on screen is now `id`: the others are forgotten once no
    /// answer holds them (an answer being written keeps its chat alive, and
    /// commits to it, until it is done).
    pub fn focus(&self, id: &str) -> Arc<Chat> {
        let mut map = self.map.lock().unwrap();
        map.retain(|k, chat| k == id || Arc::strong_count(chat) > 1);
        map.entry(id.to_string()).or_insert_with(|| Arc::new(Chat::new(id))).clone()
    }

    /// The Stop button of one chat; the others keep being answered.
    pub fn stop(&self, id: &str) {
        let chat = self.map.lock().unwrap().get(id).cloned();
        if let Some(chat) = chat {
            chat.stop();
        }
    }
}

// ── System prompt ─────────────────────────────────────────────────────────────

/// How any model sets a timer on the island: Lumo starts it from that line and
/// hides it (src/core/compact.ts takeTimers). Plain words only: it also goes
/// on Claude Code's command line.
macro_rules! timer_note {
    () => {
        "Lumo can show a timer on the island. When the user asks for a timer or to be reminded in some time, write on a line of its own [[timer 10m: what it is for]], with the length as 90s, 10m or 1h30m, and say in a few words that it is set; Lumo starts it and hides that line. Only when they ask for one."
    };
}
/// `timer_note`, for the models that have Lumo's set_timer tool
/// (island_tools.rs): the tool first, the line when it is missing. Plain words
/// only: it also goes on the CLIs' command lines.
macro_rules! timer_tool_note {
    () => {
        "Lumo can show a timer on the island. When the user asks for a timer or to be reminded in some time, call Lumo's set_timer tool and say in a few words that it is set; only when they ask for one. If that tool is missing or fails, write instead on a line of its own [[timer 10m: what it is for]], with the length as 90s, 10m or 1h30m."
    };
}
pub(crate) use timer_tool_note;

/// How the CLIs that can act (Claude Code, Antigravity) wait for GitHub
/// without holding the turn open: Lumo's listen, stop_listening and
/// list_listening tools (island_tools.rs), or the `[[listen …]]` line without
/// them. Lumo keeps the watch (listen.rs) and hides that line
/// (src/core/listen.ts). Plain words only: it goes on the command line.
macro_rules! listen_tool_note {
    () => {
        " When the user wants something done or to be told once something happens to a pull request on GitHub (its checks finish, it is approved, ready to merge, merged or closed), never wait, sleep or poll for it yourself: call Lumo's listen tool with source github.pr, the real owner/repository#number as target, the event, and what to do then (left out when they only want to be told); with mode every for checks or green it fires again for each new commit, until the pull request is merged or closed; say in a few words that Lumo is listening, and end your answer. The same goes for this PC: source fs with a file or folder's full path as target (created, changed, deleted, or download for a finished download in it), source process with a program's executable name (started, exited) or a port number (port_open, port_closed), source web with a link (changed, up, down, or contains with the text to wait for); any of them can use mode every. Lumo watches and tells the user; with something to do, it then sends you a message in this chat starting with GitHub: (Lumo: for this PC) that says what happened and what you meant to do, and you do it then, asking for permissions as usual. If what happened is not what you waited for (the checks failed, it was closed, it has conflicts), do not do it: tell the user what happened, and fix it only if they asked you to. To merge once it is ready, listen for ready with the merge as what to do then; a merge you start yourself is done at once, so tell the user right away. Never run a command that waits, such as gh pr checks --watch, gh run watch or a sleep loop: Lumo stops it. To stop listening, call stop_listening; list_listening says what Lumo listens to. If those tools are missing or fail, write instead, as plain text on a line of its own at the end of your answer, [[listen owner/repo#123 event: what to do then]] (or [[listen owner/repo#123 every checks: what to do then]]) or [[unlisten owner/repo#123]]; on this PC, [[listen fs \"C:\\path\" every download: what to do then]], [[listen process \"node.exe\" exited]], [[listen web \"https://…\" contains \"text\"]] or [[unlisten web \"https://…\"]]."
    };
}
pub(crate) use listen_tool_note;

/// `answer`, with the lines for Lumo (`[[timer …]]`, `[[listen …]]`,
/// `[[unlisten …]]`) that were written earlier in the turn, in a message
/// before a tool call, added back: the CLIs return only their last message.
pub fn keep_lumo_lines(answer: String, said: &str) -> String {
    let mut out = answer;
    for marker in lumo_markers(said) {
        if !out.contains(marker) {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(marker);
            out.push('\n');
        }
    }
    out
}

/// The `[[timer …]]`, `[[listen …]]` and `[[unlisten …]]` in `text`, wherever
/// they were written: on a line of their own, in a sentence or in backticks.
fn lumo_markers(text: &str) -> Vec<&str> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("[[") {
        let tail = &rest[start..];
        let Some(end) = tail[2..].find("]]").map(|e| e + 4) else { break };
        let marker = &tail[..end];
        let word = marker[2..].trim_start().to_ascii_lowercase();
        let ours = ["timer", "listen", "unlisten"]
            .iter()
            .any(|w| word.starts_with(w) && word[w.len()..].starts_with(|c: char| c.is_whitespace() || c == ']'));
        if ours && !marker[2..end - 2].contains("[[") {
            found.push(marker);
            rest = &tail[end..];
        } else {
            rest = &tail[2..];
        }
    }
    found
}

/// How to write math, for every provider that answers in the chat: the island
/// draws standard LaTeX, and a macro from the user's own files (`\dd`) would
/// show as its name.
macro_rules! math_note {
    () => {
        " Write math as $…$ or $$…$$ with standard LaTeX commands only: never macros defined in the user's own files, even when quoting them."
    };
}
pub(crate) use math_note;

/// The tool workshop's chats: their ids start so (src/core/tools.ts WORKSHOP_PREFIX).
pub fn is_workshop(chat_id: &str) -> bool {
    chat_id.starts_with("forge-")
}

/// What the tool workshop adds to every provider's instructions: what a tool
/// is, and how to hand one over (src/core/tools.ts parseDraft reads it). Plain
/// words only: it also goes on Claude Code's command line.
macro_rules! workshop_note {
    () => {
        " This chat is Lumo's tool workshop. Here you help the user make a tool, or bring in a script or program they already have, so that Lumo and its agents can use it. A tool is a small program that does one job, a description that tells an AI when to use it, and its parameters. The user may not read code: talk about what the tool does in plain words, ask at most one or two short questions when something important is unclear, and never ask them to edit code. On Windows prefer Python or PowerShell, with no extra packages unless they are needed, and say which ones. The script gets its parameters as a JSON object on standard input and in the LUMO_TOOL_INPUT environment variable, and prints its result as text on standard output; for a script that already exists and takes command line arguments, map the parameters with args instead, writing {name} for the value of a parameter. Each time the tool is ready or changes, end your answer with the whole tool: first a fenced code block whose language is lumo-tool, holding JSON with name, description, entry, params, permissions, command, and optionally args and timeout in seconds; then, after a blank line, for each file of the tool, a fenced code block whose language is lumo-file followed by a space and the file name, holding the whole file. params is a list of objects with name, type as string, number, integer or boolean, description and required. permissions lists what the tool needs, from network, read, write and system, and Lumo holds the tool to it: a Python or Node tool that does something it did not declare is stopped, so declare all it needs and no more. read means files outside its own folder, write means changing files anywhere but the folder named by the LUMO_TOOL_WORK environment variable, which is where the tool may write its own files and also its temporary folder. Before agents can use a saved tool, a second AI reviews it and explains it to the user, so keep the code plain and readable and never do anything the description does not say. entry is the file that runs: one of the files, or the full path of a script the user already has on their computer, which then runs where it is and needs no lumo-file block. Write the description for an AI: what the tool does, when to use it and what it returns. command is the word the user types after a slash in any of Lumo's chats to call the tool, such as pdfcraft for /pdfcraft: short, lower case letters, digits and dashes, easy to remember, and never new, history, model, effort, attach, screen, permissions, timer, compact, context, clear, usage, credits or skills. Give every tool one, unless calling it by hand makes no sense (a tool only an agent would use in the middle of a task): then write an empty string. Keep the command a tool already has unless the user asks to change it; when they ask to remove it, write an empty string. Lumo shows the draft to the user, who can try it and save it with a click: never save, install or register the tool yourself, and never say it is saved. Keep the words around the blocks short: what the tool does, what it needs and how to use it. When the user tells you how a try went, fix the tool and give it again whole."
    };
}
pub(crate) use workshop_note;

/// The system prompt for `chat`: Lumo's, and the workshop's for a workshop
/// chat. `timer_tool`: the provider gets Lumo's set_timer tool.
pub fn system_prompt_in(chat: &Chat, web_search: bool, timer_tool: bool) -> String {
    let base = system_prompt(web_search, timer_tool);
    if chat.is_workshop() {
        format!("{base}{}", workshop_note!())
    } else {
        base
    }
}

/// Lumo's instructions. Greets the user by their first name when the account
/// has one worth using (identity.rs), and only claims web search where the
/// provider runs it (Claude).
pub fn system_prompt(web_search: bool, timer_tool: bool) -> String {
    system_prompt_for(crate::identity::first_name(), web_search, timer_tool)
}

fn system_prompt_for(first_name: Option<&str>, web_search: bool, timer_tool: bool) -> String {
    let opening = match first_name {
        Some(name) => format!("You are Lumo, {name}'s personal AI assistant living at the top of their screen."),
        None => "You are Lumo, a personal AI assistant living at the top of the user's screen.".to_string(),
    };
    let abilities = if web_search {
        "You have web search access and can help with absolutely anything — research, coding, finding places, recommendations, tasks, questions."
    } else {
        "You can help with absolutely anything — research, coding, recommendations, tasks, questions. You have no web access: say so when something needs current information."
    };
    format!(
        "{opening} {abilities} \
Respond in the user's language. Be thorough and complete — use as much detail as the task requires. \
Use light Markdown when it helps: short paragraphs, bullet lists, **bold**, `inline code` and fenced code blocks. Avoid tables and big headings: the chat window is small. \
Lumo may tell you which windows and documents are open on the user's computer, and attach the one in front when the question is about it: use them, and never say you can't see what they have open when it is there. {}{}",
        if timer_tool { timer_tool_note!() } else { timer_note!() },
        math_note!()
    )
}

/// The window context line, as ClaudeService.chat() writes it.
pub fn window_line(app_name: &str, title: &str, url: Option<&str>) -> String {
    let mut text = format!("Context — App: {app_name}, Window: {title}");
    if let Some(url) = url {
        text.push_str(&format!(", URL: {url}"));
    }
    text
}

/// What goes with this turn: a file whenever it is given (the page sends each
/// one once, with the question asked after it was added, mid-conversation too),
/// the window only with the first question.
pub fn turn_context(first: bool, context: Option<&ChatContext>) -> Option<&ChatContext> {
    context.filter(|c| first || matches!(c, ChatContext::File { .. }))
}

/// The plain-text record of what the user asked, context included.
pub fn plain_question(first: bool, context: Option<&ChatContext>, query: &str) -> String {
    match turn_context(first, context) {
        Some(ChatContext::File { name, .. }) => format!("File: {name}\n\n{query}"),
        Some(ChatContext::Window { app_name, title, url }) => {
            format!("{}\n\n{query}", window_line(app_name, title, url.as_deref()))
        }
        None => query.to_string(),
    }
}

// ── Which provider ────────────────────────────────────────────────────────────

/// The model chosen for `provider`, or its default.
pub fn model_for(settings: &Settings, provider: &str) -> String {
    if provider == ANTHROPIC {
        let m = settings.model.trim();
        return if m.is_empty() { claude::DEFAULT_MODEL.to_string() } else { m.to_string() };
    }
    settings
        .chat_models
        .get(provider)
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .or_else(|| openai_compat::provider(provider).map(|p| p.default_model.to_string()))
        .unwrap_or_default()
}

/// A file rides along only if it is one of Lumo's own copies of a dropped
/// file (files.rs puts them in the inbox). The page names the path, so without
/// this any file the user can read could be sent to a chat provider.
fn checked_context(context: ChatContext) -> Result<ChatContext, String> {
    match context {
        ChatContext::File { name, path } => {
            let inbox = crate::files::inbox_dir();
            if !is_inside(&inbox, std::path::Path::new(&path)) {
                return Err(crate::i18n::t("Only a file dropped on the island can be sent with a question."));
            }
            Ok(ChatContext::File { name, path })
        }
        other => Ok(other),
    }
}

/// True when `path` is a regular file directly inside `dir`, both resolved
/// (no `..`, no symlink pointing out of it).
pub(crate) fn is_inside(dir: &std::path::Path, path: &std::path::Path) -> bool {
    let (Ok(dir), Ok(file)) = (dir.canonicalize(), path.canonicalize()) else { return false };
    file.parent() == Some(dir.as_path())
        && std::fs::symlink_metadata(&file).map(|m| m.is_file()).unwrap_or(false)
}

/// Screenshots ride along only from the inbox, where screen.rs writes them —
/// the same rule as a dropped file.
fn checked_screen(mut screen: ScreenContext) -> Result<ScreenContext, String> {
    let inbox = crate::files::inbox_dir();
    let paths = screen.shots.iter().chain(screen.files.iter());
    if paths.map(|s| std::path::Path::new(&s.path)).any(|p| !is_inside(&inbox, p)) {
        return Err(crate::i18n::t("Only a file dropped on the island can be sent with a question."));
    }
    // A shared window's document is named only when Rust found it (share.rs).
    for w in &mut screen.shared_windows {
        if !crate::share::was_found(&w.document) {
            w.document.clear();
        }
    }
    Ok(screen)
}

/// Who can look at a screenshot: Claude Code reads it from the inbox, the
/// Anthropic API and the OpenAI-compatible clouds take it as an image. The
/// local model servers get text only.
fn sees_images(provider: &str) -> bool {
    provider.is_empty() || provider == ANTHROPIC || is_cli(provider) || openai_compat::provider(provider).is_some()
}

/// A session as `Chat::cli_session` gave it: its CLI and its id. Untagged, it
/// is Claude Code's.
fn untag_session(saved: &str) -> (&str, &str) {
    match saved.split_once(':') {
        Some((owner, id)) if owner == antigravity_cli::PROVIDER || owner == codex_chat::PROVIDER => (owner, id),
        _ => (claude_code::PROVIDER, saved),
    }
}

/// The providers that run a signed-in CLI on this computer. Given paths, they
/// read dropped files and screenshots themselves.
fn is_cli(provider: &str) -> bool {
    provider == claude_code::PROVIDER || provider == antigravity_cli::PROVIDER || provider == codex_chat::PROVIDER
}

/// The question with the screen context in front of it, and the screenshots
/// to send as images (none for the CLIs, which are given their paths).
fn with_screen(provider: &str, screen: Option<&ScreenContext>, query: String) -> Result<(String, Vec<String>), String> {
    let Some(screen) = screen.filter(|s| !s.is_empty()) else { return Ok((query, Vec::new())) };
    if !screen.shots.is_empty() && !sees_images(provider) {
        return Err(crate::i18n::t("Screenshots need the Claude Code or Anthropic provider."));
    }
    let cli = is_cli(provider);
    // The other providers are sent the screenshots and the files themselves.
    let images = if cli { Vec::new() } else { screen.shots.iter().chain(screen.files.iter()).map(|s| s.path.clone()).collect() };
    Ok((format!("{}{query}", screen::context_text(screen, cli)), images))
}

/// One chat turn with the provider chosen in the settings. `screen` is what
/// the user added from the screen button, sent with this question only.
pub async fn send(
    app: &AppHandle,
    chat: &Chat,
    settings: &Settings,
    query: String,
    context: Option<ChatContext>,
    screen: Option<ScreenContext>,
) -> Result<ChatReply, String> {
    let mut usage = None;
    let reply = dispatch(app, chat, settings, query, context, screen, &mut usage).await;
    // What the provider said is left, read off this very answer (chat_usage.rs).
    if settings.chat_show_usage {
        if let Some(usage) = usage {
            let _ = app.emit("chat-usage", usage);
        }
    }
    reply
}

async fn dispatch(
    app: &AppHandle,
    chat: &Chat,
    settings: &Settings,
    query: String,
    context: Option<ChatContext>,
    screen: Option<ScreenContext>,
    usage: &mut Option<ChatUsage>,
) -> Result<ChatReply, String> {
    let mut context = context.map(checked_context).transpose()?;
    // One of Claude Code's commands ("/context") goes alone, exactly as typed:
    // nothing of the screen, the windows or the email in front of it, or
    // Claude Code takes it for a question (claude_code.rs). Antigravity CLI's
    // few the same (antigravity_cli.rs).
    let command = (settings.chat_provider == claude_code::PROVIDER && claude_code::is_command(&query))
        || (settings.chat_provider == antigravity_cli::PROVIDER && antigravity_cli::is_command(&query));
    let mut screen = if command { None } else { screen.map(checked_screen).transpose()? };
    // Settings → Chat → "Tell the AI what's open": the windows and their
    // documents go with every question (desk.rs).
    if settings.chat_share_open && !command {
        let (windows, documents) = tauri::async_runtime::spawn_blocking(crate::desk::now).await.unwrap_or_default();
        let s = screen.get_or_insert_with(ScreenContext::default);
        if s.windows.is_empty() {
            s.windows = windows;
        }
        // The providers that cannot read files: the document in front goes
        // along, when the question is about it and nothing else does.
        if !is_cli(&settings.chat_provider) && context.is_none() {
            let front = documents.iter().find(|d| d.active).or(documents.first());
            if let Some(doc) = front.filter(|d| crate::desk::asks_about(&query, d)) {
                let path = std::path::PathBuf::from(&doc.path);
                let copied = tauri::async_runtime::spawn_blocking(move || crate::files::copy_in(&path))
                    .await
                    .unwrap_or_else(|e| Err(e.to_string()));
                match copied {
                    Ok(f) => context = Some(ChatContext::File { name: f.name, path: f.path }),
                    Err(e) => crate::log::line(format!("[desk] {e}")),
                }
            }
        }
        s.documents = documents;
    }
    // The Email pill: a question about email gets the newest emails, read or
    // not, so every provider can answer it, not only those with a mail tool of
    // their own.
    if !command && crate::mail::asks_about(&query) && crate::integrations::enabled(app, crate::mail::ID) {
        if let Some(text) = crate::mail::for_chat(app).await {
            screen.get_or_insert_with(ScreenContext::default).mail = text;
        }
    }
    chat.arm();
    let more: Vec<(String, String)> =
        screen.as_ref().map(|s| s.files.iter().map(|f| (f.name.clone(), f.path.clone())).collect()).unwrap_or_default();
    let reply = send_to(app, chat, settings, query, context.clone(), screen, usage).await;
    // What the island's tools asked for during the turn (island_tools.rs), as
    // the lines the island reads; a failed turn, or one stopped before it
    // said anything, drops them.
    let asked = crate::island_tools::take(chat.id());
    let mut reply = reply?;
    if !asked.is_empty() && !(reply.stopped && reply.text.is_empty()) {
        reply.text = keep_lumo_lines(std::mem::take(&mut reply.text), &asked);
    }
    // Remembered once it went, for a fresh Claude Code session after an edit.
    if let Some(ChatContext::File { name, path }) = &context {
        chat.note_file(name, path);
    }
    for (name, path) in &more {
        chat.note_file(name, path);
    }
    reply.turns = chat.turns();
    Ok(reply)
}

async fn send_to(
    app: &AppHandle,
    chat: &Chat,
    settings: &Settings,
    query: String,
    context: Option<ChatContext>,
    screen: Option<ScreenContext>,
    usage: &mut Option<ChatUsage>,
) -> Result<ChatReply, String> {
    let provider = settings.chat_provider.as_str();
    let model = model_for(settings, provider);
    let (query, images) = with_screen(provider, screen.as_ref(), query)?;
    if provider == ANTHROPIC || provider.is_empty() {
        return claude::send(app, chat, &model, query, context, &images, usage).await;
    }
    if is_cli(provider) {
        // A folder shared from File Explorer: the CLI may read the rest of it itself.
        let folder = screen.as_ref().and_then(|s| s.folder.as_ref()).map(|f| f.path.clone()).filter(|p| crate::explorer::was_shared(p));
        // So may it the folders of the documents open (found by Rust, desk.rs),
        // and of those the shared windows show (share.rs).
        let shown = screen.as_ref().map(|s| s.shared_windows.as_slice()).unwrap_or_default().iter().map(|w| w.document.as_str());
        let open = screen.as_ref().map(|s| s.documents.as_slice()).unwrap_or_default().iter().map(|d| d.path.as_str());
        for path in open.chain(shown).filter(|p| !p.is_empty()) {
            if let Some(dir) = std::path::Path::new(path).parent() {
                chat.cli_dirs(Some(dir.to_string_lossy().to_string()));
            }
        }
        if provider == antigravity_cli::PROVIDER {
            return antigravity_cli::send(app, chat, &model, &settings.chat_permission_mode, query, context, folder).await;
        }
        if provider == codex_chat::PROVIDER {
            return codex_chat::send(app, chat, &model, &settings.chat_effort, &settings.chat_permission_mode, query, context, folder).await;
        }
        let computer = settings.chat_computer_use;
        return claude_code::send(app, chat, &model, &settings.chat_effort, &settings.chat_permission_mode, computer, query, context, folder)
            .await;
    }
    if let Some(p) = openai_compat::provider(provider) {
        return openai_compat::send(app, chat, p, &model, query, context, &images, usage).await;
    }
    if let Some(server) = local_chat::server(settings, provider) {
        return local_chat::send(app, chat, &server, &model, query, context).await;
    }
    Err(format!("Unknown chat provider: {provider}"))
}

/// The models `provider` offers. Asked only when the user opens the picker on
/// that provider, and only once it has a key (or, for a local server, an
/// address): nothing is sent anywhere before that.
pub async fn models(settings: &Settings, provider: &str) -> Result<Vec<ModelInfo>, String> {
    let no_key = || crate::i18n::t("No API key — add it in Settings.");
    if provider == ANTHROPIC {
        let key = secrets::get(claude::KEY).ok_or_else(no_key)?;
        return claude::models(&key).await;
    }
    if provider == claude_code::PROVIDER {
        return Ok(claude_code::models());
    }
    if provider == antigravity_cli::PROVIDER {
        return antigravity_cli::models().await;
    }
    if provider == codex_chat::PROVIDER {
        return codex_chat::models().await;
    }
    if let Some(p) = openai_compat::provider(provider) {
        let key = secrets::get(p.key).ok_or_else(no_key)?;
        return openai_compat::models(p, &key).await;
    }
    if let Some(server) = local_chat::server(settings, provider) {
        return local_chat::models(&server).await;
    }
    Err(format!("Unknown chat provider: {provider}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lumo_lines_are_kept_wherever_they_were_written() {
        let said = "PR opened: `[[listen Rccrd12/Lumo#30 ready: merge it]]` and [[ Timer 10m pasta]].\n[[listen o/r#3]]\nnot [[ours]] nor [[listening]]";
        assert_eq!(lumo_markers(said), ["[[listen Rccrd12/Lumo#30 ready: merge it]]", "[[ Timer 10m pasta]]", "[[listen o/r#3]]"]);
        assert_eq!(keep_lumo_lines("Waiting.".into(), said), "Waiting.\n[[listen Rccrd12/Lumo#30 ready: merge it]]\n[[ Timer 10m pasta]]\n[[listen o/r#3]]\n");
        assert_eq!(keep_lumo_lines("Ok `[[listen o/r#3]]`".into(), "[[listen o/r#3]]"), "Ok `[[listen o/r#3]]`");
    }

    fn turn_texts(history: &[Value]) -> Vec<(String, Value)> {
        history
            .iter()
            .map(|m| (m["role"].as_str().unwrap().to_string(), m["content"].clone()))
            .collect()
    }

    #[test]
    fn a_restored_chat_continues_as_plain_turns() {
        let chat = Chat::default();
        chat.restore(vec![("user".into(), "hi".into()), ("system".into(), "x".into()), ("assistant".into(), "hello".into())], Some("s".into()));
        assert_eq!(chat.cli_session().as_deref(), Some("s"));
        assert_eq!(chat.cli_session_for("claude-code").as_deref(), Some("s"));
        assert_eq!(chat.cli_session_for("antigravity-cli"), None, "never another CLI's session");
        let t = chat.begin("openai");
        assert!(!t.first);
        assert_eq!(turn_texts(&t.history), vec![("user".into(), json!("hi")), ("assistant".into(), json!("hello"))]);
        chat.reset();
        assert_eq!(chat.cli_session(), None);
    }

    #[test]
    fn each_cli_resumes_only_its_own_session() {
        let chat = Chat::default();
        let t = chat.begin("claude-code");
        chat.set_cli_session(&t, "claude-session");
        assert_eq!(chat.cli_session_for("claude-code").as_deref(), Some("claude-session"));
        assert_eq!(chat.cli_session_for("antigravity-cli"), None);
        // Another provider answering in between keeps it.
        let _ = chat.begin("openai");
        assert_eq!(chat.cli_session_for("claude-code").as_deref(), Some("claude-session"));
        // Antigravity CLI takes over: its conversation is the one kept now.
        let t = chat.begin("antigravity-cli");
        chat.set_cli_session(&t, "agy-conversation");
        assert_eq!(chat.cli_session_for("antigravity-cli").as_deref(), Some("agy-conversation"));
        assert_eq!(chat.cli_session_for("claude-code"), None);
        // The island keeps it tagged, and gets it back to the right CLI.
        let saved = chat.cli_session().unwrap();
        assert_eq!(saved, "antigravity-cli:agy-conversation");
        chat.rewind(0);
        assert_eq!(chat.cli_session_for("antigravity-cli"), None);
        assert_eq!(chat.cli_session(), None);
        chat.restore(vec![], Some(saved));
        assert_eq!(chat.cli_session_for("antigravity-cli").as_deref(), Some("agy-conversation"));
        assert_eq!(chat.cli_session_for("claude-code"), None);
        // A Claude Code session goes untagged, as chats were saved before.
        let t = chat.begin("claude-code");
        chat.set_cli_session(&t, "0b5a8f2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b");
        assert_eq!(chat.cli_session().as_deref(), Some("0b5a8f2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b"));
        chat.restore(vec![], Some("0b5a8f2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b".into()));
        assert_eq!(chat.cli_session_for("claude-code").as_deref(), Some("0b5a8f2e-1c3d-4e5f-8a9b-0c1d2e3f4a5b"));
        assert_eq!(chat.cli_session_for("antigravity-cli"), None);
        chat.restore(vec![], None);
        assert_eq!(chat.cli_session(), None);
    }

    fn qa(q: &str, a: &str) -> (Value, Value) {
        (json!({"role":"user","content":q}), json!({"role":"assistant","content":a}))
    }

    #[test]
    fn an_edited_message_rewinds_the_conversation_and_forgets_the_cli_session() {
        let chat = Chat::default();
        for (q, a) in [("one", "1"), ("two", "2"), ("three", "3")] {
            let t = chat.begin("anthropic");
            let (u, r) = qa(q, a);
            chat.commit(&t, u, r, q, a);
        }
        chat.set_cli_session(&chat.begin("anthropic"), "s");
        chat.cli_dirs(Some("C:\\PDFs".into()));
        chat.note_file("a.pdf", "/inbox/a.pdf");
        assert_eq!(chat.turns(), 6);

        // An answer still on its way when the edit lands is dropped.
        let late = chat.begin("anthropic");
        chat.rewind(2);
        let (u, r) = qa("late", "x");
        chat.commit(&late, u, r, "late", "x");
        assert_eq!(chat.turns(), 2);

        assert_eq!(chat.cli_session(), None, "Claude Code starts afresh on the kept turns");
        assert_eq!(chat.cli_dirs(None), ["C:\\PDFs"]);
        assert_eq!(chat.files(), vec![("a.pdf".to_string(), "/inbox/a.pdf".to_string())]);
        let t = chat.begin("anthropic");
        assert!(!t.first);
        assert_eq!(turn_texts(&t.history), vec![("user".into(), json!("one")), ("assistant".into(), json!("1"))]);

        chat.rewind(0);
        assert!(chat.begin("claude-code").first);
        chat.rewind(99); // nothing to cut: no harm
        chat.reset();
        assert!(chat.files().is_empty());
    }

    #[test]
    fn stop_drops_the_request_and_only_the_current_turn() {
        fn block_on<T>(f: impl Future<Output = T>) -> T {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
        }
        let chat = Chat::default();
        // Stop pressed with nothing running is forgotten by the next turn.
        chat.stop();
        chat.arm();
        let quick: Option<u8> = block_on(chat.unless_stopped(async { 7 }));
        assert_eq!(quick, Some(7));

        let stop = chat.arm();
        let never = std::future::pending::<u8>();
        let pressed = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(30));
            stop.stop();
        });
        assert_eq!(block_on(chat.unless_stopped(never)), None);
        pressed.join().unwrap();
        assert!(chat.stopper().is_stopped());
        chat.arm();
        assert!(!chat.stopper().is_stopped());
    }

    #[test]
    fn a_reply_says_when_it_was_stopped() {
        let r = serde_json::to_value(ChatReply::answer("hi".into(), None)).unwrap();
        assert_eq!(r, json!({"text":"hi","turns":0}));
        let r = serde_json::to_value(ChatReply::stopped("h".into(), Some("s".into()))).unwrap();
        assert_eq!(r, json!({"text":"h","session":"s","stopped":true,"turns":0}));
    }

    #[test]
    fn a_shared_folder_stays_readable_until_the_chat_ends() {
        let chat = Chat::default();
        assert!(chat.cli_dirs(None).is_empty());
        assert_eq!(chat.cli_dirs(Some("C:\\PDFs".into())), ["C:\\PDFs"]);
        assert_eq!(chat.cli_dirs(Some("C:\\PDFs".into())), ["C:\\PDFs"], "once");
        assert_eq!(chat.cli_dirs(None), ["C:\\PDFs"], "the next turn too");
        chat.reset();
        assert!(chat.cli_dirs(None).is_empty());
        for i in 0..20 {
            chat.cli_dirs(Some(format!("C:\\d{i}")));
        }
        assert_eq!(chat.cli_dirs(None).len(), 8);
    }

    #[test]
    fn a_turn_is_recorded_only_once_it_succeeds() {
        let chat = Chat::default();
        let t = chat.begin("anthropic");
        assert!(t.first);
        assert!(t.history.is_empty());
        // A failed turn records nothing: the next one is still the first.
        let t = chat.begin("anthropic");
        assert!(t.first);
        chat.commit(&t, json!({"role":"user","content":[{"type":"text","text":"hi"}]}), json!({"role":"assistant","content":[{"type":"text","text":"hello"}]}), "hi", "hello");
        let t = chat.begin("anthropic");
        assert!(!t.first);
        assert_eq!(t.history.len(), 2);
        assert!(t.history[0]["content"].is_array());
    }

    #[test]
    fn switching_provider_never_sends_claude_blocks_to_another_one() {
        let chat = Chat::default();
        let t = chat.begin("anthropic");
        let blocks = json!([
            {"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{"query":"x"}},
            {"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[]},
            {"type":"text","text":"Found it."}
        ]);
        chat.commit(&t, json!({"role":"user","content":[{"type":"text","text":"look"}]}), json!({"role":"assistant","content":blocks}), "look", "Found it.");

        let t = chat.begin("openai");
        assert!(!t.first);
        assert_eq!(
            turn_texts(&t.history),
            vec![("user".into(), json!("look")), ("assistant".into(), json!("Found it."))]
        );
        let raw = serde_json::to_string(&t.history).unwrap();
        assert!(!raw.contains("web_search"), "{raw}");

        // And back: Claude gets the plain turns too, including OpenAI's answer.
        chat.commit(&t, json!({"role":"user","content":"more"}), json!({"role":"assistant","content":"Sure."}), "more", "Sure.");
        let t = chat.begin("anthropic");
        assert_eq!(t.history.len(), 4);
        assert_eq!(t.history[3], json!({"role":"assistant","content":"Sure."}));
        assert!(!serde_json::to_string(&t.history).unwrap().contains("web_search"));
    }

    #[test]
    fn a_chat_being_answered_survives_moving_to_another_one() {
        let chats = Chats::default();
        let answering = chats.get("a");
        let t = answering.begin("openai");
        // The user opens another chat, then a third: "a" is still being answered.
        chats.focus("b").reset();
        chats.focus("c");
        let a = chats.get("a");
        assert!(Arc::ptr_eq(&a, &answering));
        a.commit(&t, json!({"role":"user","content":"q"}), json!({"role":"assistant","content":"a"}), "q", "a");
        assert_eq!(chats.get("a").turns(), 2);
        assert_eq!(chats.get("c").turns(), 0);
        // Its own Stop only.
        let other = chats.get("c");
        other.arm();
        answering.arm();
        chats.stop("a");
        assert!(answering.stopper().is_stopped());
        assert!(!other.stopper().is_stopped());
        // Done and off screen: forgotten when another chat comes on screen.
        drop((a, answering, other));
        chats.focus("d");
        assert_eq!(chats.map.lock().unwrap().len(), 1);
    }

    #[test]
    fn an_answer_that_lands_after_a_reset_or_a_switch_is_dropped() {
        let chat = Chat::default();
        let t = chat.begin("openai");
        chat.reset();
        chat.commit(&t, json!({"role":"user","content":"q"}), json!({"role":"assistant","content":"a"}), "q", "a");
        assert!(chat.begin("openai").first);

        let t = chat.begin("openai");
        let _other = chat.begin("google");
        chat.commit(&t, json!({"role":"user","content":"q"}), json!({"role":"assistant","content":"a"}), "q", "a");
        assert!(chat.begin("google").first);
    }

    #[test]
    fn the_prompt_greets_by_first_name_and_claims_web_search_only_for_claude() {
        let p = system_prompt_for(Some("Ada"), true, true);
        assert!(p.starts_with("You are Lumo, Ada's personal AI assistant living at the top of their screen."));
        assert!(p.contains("web search access"));
        assert!(p.contains("light Markdown"));
        let p = system_prompt_for(None, false, false);
        assert!(p.starts_with("You are Lumo, a personal AI assistant living at the top of the user's screen."));
        assert!(!p.contains("web search"));
        assert!(p.contains("no web access"));
        // The timer: Lumo's tool where the provider has it, the line otherwise.
        assert!(system_prompt_for(None, false, true).contains("set_timer tool"));
        assert!(!p.contains("set_timer") && p.contains("[[timer 10m"));
    }

    #[test]
    fn a_file_goes_with_any_question_and_the_window_with_the_first_only() {
        let file = ChatContext::File { name: "a.txt".into(), path: "/x/a.txt".into() };
        assert_eq!(plain_question(true, Some(&file), "why?"), "File: a.txt\n\nwhy?");
        // Dropped mid-conversation: it goes with the next question all the same.
        assert_eq!(plain_question(false, Some(&file), "why?"), "File: a.txt\n\nwhy?");
        let win = ChatContext::Window { app_name: "Code".into(), title: "main.rs".into(), url: None };
        assert_eq!(plain_question(true, Some(&win), "q"), "Context — App: Code, Window: main.rs\n\nq");
        assert_eq!(plain_question(false, Some(&win), "q"), "q");
        assert_eq!(window_line("Edge", "Docs", Some("https://x.dev")), "Context — App: Edge, Window: Docs, URL: https://x.dev");
    }

    #[test]
    fn the_model_comes_from_the_settings_or_the_provider_default() {
        let mut s = Settings::default();
        assert_eq!(model_for(&s, "anthropic"), claude::DEFAULT_MODEL);
        assert_eq!(model_for(&s, "openai"), openai_compat::provider("openai").unwrap().default_model);
        assert_eq!(model_for(&s, "ollama"), "");
        s.chat_models.insert("openai".into(), " gpt-x ".into());
        s.chat_models.insert("ollama".into(), "llama3.2".into());
        s.model = "claude-haiku-4-5".into();
        assert_eq!(model_for(&s, "openai"), "gpt-x");
        assert_eq!(model_for(&s, "ollama"), "llama3.2");
        assert_eq!(model_for(&s, "anthropic"), "claude-haiku-4-5");
    }

    #[test]
    fn the_screen_goes_in_front_of_the_question_as_paths_images_or_a_refusal() {
        use crate::screen::{ShotRef, WindowInfo};
        let screen = ScreenContext {
            windows: vec![WindowInfo { id: 0, title: "Docs".into(), app: "msedge".into(), active: true, minimized: false }],
            shots: vec![ShotRef { name: "Screen 1".into(), path: "/inbox/s1.png".into() }],
            selection: None,
            selections: Vec::new(),
            files: Vec::new(),
            folder: None,
            shared_windows: Vec::new(),
            tabs: Vec::new(),
            documents: Vec::new(),
            mail: String::new(),
        };
        for cli in ["claude-code", "antigravity-cli"] {
            let (q, images) = with_screen(cli, Some(&screen), "what is this?".into()).unwrap();
            assert!(q.contains("Read them from these paths:\n- Screen 1: /inbox/s1.png"), "{cli}");
            assert!(q.contains("- Docs — msedge (active)"));
            assert!(q.ends_with("what is this?"));
            assert!(images.is_empty(), "{cli} reads the file itself");
        }

        for provider in ["anthropic", "openai", "google", "openrouter"] {
            let (q, images) = with_screen(provider, Some(&screen), "q".into()).unwrap();
            assert_eq!(images, vec!["/inbox/s1.png".to_string()], "{provider}");
            assert!(!q.contains("/inbox/s1.png"));
            assert!(q.contains("(attached: Screen 1)"));
        }

        assert_eq!(
            with_screen("ollama", Some(&screen), "q".into()).unwrap_err(),
            "Screenshots need the Claude Code or Anthropic provider."
        );
        // The window list alone is text: every provider takes it.
        let windows_only = ScreenContext { shots: vec![], ..screen.clone() };
        let (q, images) = with_screen("ollama", Some(&windows_only), "q".into()).unwrap();
        assert!(q.starts_with("Windows open on the user's computer") && q.ends_with("q") && images.is_empty());

        // So is a selection, for every provider.
        let selected = ScreenContext {
            selection: Some(crate::screen::SelectionRef { text: "Le contrat\n".into(), app: "Acrobat".into(), title: "bail.pdf".into() }),
            ..Default::default()
        };
        for provider in ["claude-code", "anthropic", "openai", "ollama"] {
            let (q, images) = with_screen(provider, Some(&selected), "translate".into()).unwrap();
            assert_eq!(
                q,
                "The user selected this text in Acrobat (\"bail.pdf\") and shared it just now:\n<selected_text>\nLe contrat\n</selected_text>\n\ntranslate",
                "{provider}"
            );
            assert!(images.is_empty());
        }

        assert_eq!(with_screen("openai", None, "q".into()).unwrap(), ("q".to_string(), vec![]));
        assert_eq!(with_screen("ollama", Some(&ScreenContext::default()), "q".into()).unwrap(), ("q".to_string(), vec![]));
    }

    #[test]
    fn only_screenshots_in_the_inbox_ride_along() {
        use crate::screen::ShotRef;
        let outside = ScreenContext { shots: vec![ShotRef { name: "x".into(), path: "/etc/passwd".into() }], ..Default::default() };
        assert!(checked_screen(outside).is_err());
        assert!(checked_screen(ScreenContext::default()).is_ok());
    }

    #[test]
    fn only_files_in_the_inbox_ride_along() {
        let base = std::env::temp_dir().join(format!("lumo-chat-ctx-{}", std::process::id()));
        let inbox = base.join("inbox");
        std::fs::create_dir_all(inbox.join("sub")).unwrap();
        std::fs::write(inbox.join("a.txt"), b"a").unwrap();
        std::fs::write(base.join("secret.txt"), b"s").unwrap();
        std::fs::write(inbox.join("sub").join("b.txt"), b"b").unwrap();
        assert!(is_inside(&inbox, &inbox.join("a.txt")));
        assert!(!is_inside(&inbox, &base.join("secret.txt")));
        assert!(!is_inside(&inbox, &inbox.join("..").join("secret.txt")));
        assert!(!is_inside(&inbox, &inbox.join("sub").join("b.txt")));
        assert!(!is_inside(&inbox, &inbox.join("missing.txt")));
        assert!(!is_inside(&inbox, &inbox));
        let _ = std::fs::remove_dir_all(&base);
    }
}
