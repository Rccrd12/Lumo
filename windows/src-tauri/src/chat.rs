// The chat, whoever answers it: the conversation, the system prompt, and which
// provider a turn goes to. Each provider's own wire format lives in its module:
// claude.rs (Anthropic), openai_compat.rs (OpenAI, Google AI, OpenRouter) and
// local_chat.rs (Ollama, LM Studio, any OpenAI-compatible server).
//
// API keys never leave the credential store and file bytes never cross the IPC
// boundary: the island sends the question and gets the answer's text back.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::task::Poll;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::screen::{self, ScreenContext};
use crate::settings::Settings;
use crate::{claude, claude_code, local_chat, openai_compat, secrets};

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
    /// The Claude Code session that answered (claude_code.rs), so a chat from
    /// the history can be continued where it left off.
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
    /// The Claude Code session the island's chat continues (claude_code.rs).
    cli_session: Option<String>,
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
    /// Claude Code session to continue, if Claude Code answered it.
    pub fn restore(&self, turns: Vec<(String, String)>, cli_session: Option<String>) {
        let mut c = self.inner.lock().unwrap();
        let epoch = c.epoch + 1;
        let plain = turns
            .into_iter()
            .filter(|(role, _)| role == "user" || role == "assistant")
            .map(|(role, content)| json!({ "role": role, "content": content }))
            .collect();
        *c = Conversation { epoch, plain, cli_session, ..Default::default() };
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

    /// The Claude Code session to resume, if Claude Code answered this conversation.
    pub fn cli_session(&self) -> Option<String> {
        self.inner.lock().unwrap().cli_session.clone()
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

    /// Remembers the Claude Code session of `turn`, unless the chat was reset since.
    pub fn set_cli_session(&self, turn: &Turn, id: &str) {
        let mut c = self.inner.lock().unwrap();
        if c.epoch == turn.epoch {
            c.cli_session = Some(id.to_string());
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

// ── System prompt ─────────────────────────────────────────────────────────────

/// Mochi's instructions. Greets the user by their first name when the account
/// has one worth using (identity.rs), and only claims web search where the
/// provider runs it (Claude).
pub fn system_prompt(web_search: bool) -> String {
    system_prompt_for(crate::identity::first_name(), web_search)
}

fn system_prompt_for(first_name: Option<&str>, web_search: bool) -> String {
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
Use light Markdown when it helps: short paragraphs, bullet lists, **bold**, `inline code` and fenced code blocks. Avoid tables and big headings: the chat window is small."
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

/// The plain-text record of what the user asked, context included.
pub fn plain_question(first: bool, context: Option<&ChatContext>, query: &str) -> String {
    match context.filter(|_| first) {
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

/// A file rides along only if it is one of Coucou's own copies of a dropped
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
fn checked_screen(screen: ScreenContext) -> Result<ScreenContext, String> {
    let inbox = crate::files::inbox_dir();
    if screen.shots.iter().any(|s| !is_inside(&inbox, std::path::Path::new(&s.path))) {
        return Err(crate::i18n::t("Only a file dropped on the island can be sent with a question."));
    }
    Ok(screen)
}

/// Who can look at a screenshot: Claude Code reads it from the inbox, the
/// Anthropic API and the OpenAI-compatible clouds take it as an image. The
/// local model servers get text only.
fn sees_images(provider: &str) -> bool {
    provider.is_empty() || provider == ANTHROPIC || provider == claude_code::PROVIDER || openai_compat::provider(provider).is_some()
}

/// The question with the screen context in front of it, and the screenshots
/// to send as images (none for Claude Code, which is given their paths).
fn with_screen(provider: &str, screen: Option<&ScreenContext>, query: String) -> Result<(String, Vec<String>), String> {
    let Some(screen) = screen.filter(|s| !s.is_empty()) else { return Ok((query, Vec::new())) };
    if !screen.shots.is_empty() && !sees_images(provider) {
        return Err(crate::i18n::t("Screenshots need the Claude Code or Anthropic provider."));
    }
    let cli = provider == claude_code::PROVIDER;
    let images = if cli { Vec::new() } else { screen.shots.iter().map(|s| s.path.clone()).collect() };
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
    let context = context.map(checked_context).transpose()?;
    let screen = screen.map(checked_screen).transpose()?;
    chat.arm();
    let mut reply = send_to(app, chat, settings, query, context.clone(), screen).await?;
    // Remembered once it went, for a fresh Claude Code session after an edit.
    if let Some(ChatContext::File { name, path }) = &context {
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
) -> Result<ChatReply, String> {
    let provider = settings.chat_provider.as_str();
    let model = model_for(settings, provider);
    let (query, images) = with_screen(provider, screen.as_ref(), query)?;
    if provider == ANTHROPIC || provider.is_empty() {
        return claude::send(chat, &model, query, context, &images).await;
    }
    if provider == claude_code::PROVIDER {
        // A folder shared from File Explorer: Claude Code may read the rest of it itself.
        let folder = screen.as_ref().and_then(|s| s.folder.as_ref()).map(|f| f.path.clone()).filter(|p| crate::explorer::was_shared(p));
        return claude_code::send(app, chat, &model, &settings.chat_effort, query, context, folder).await;
    }
    if let Some(p) = openai_compat::provider(provider) {
        return openai_compat::send(chat, p, &model, query, context, &images).await;
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
        let t = chat.begin("openai");
        assert!(!t.first);
        assert_eq!(turn_texts(&t.history), vec![("user".into(), json!("hi")), ("assistant".into(), json!("hello"))]);
        chat.reset();
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
        let p = system_prompt_for(Some("Louis"), true);
        assert!(p.starts_with("You are Lumo, Louis's personal AI assistant living at the top of their screen."));
        assert!(p.contains("web search access"));
        assert!(p.contains("light Markdown"));
        let p = system_prompt_for(None, false);
        assert!(p.starts_with("You are Lumo, a personal AI assistant living at the top of the user's screen."));
        assert!(!p.contains("web search"));
        assert!(p.contains("no web access"));
    }

    #[test]
    fn context_goes_with_the_first_question_only() {
        let file = ChatContext::File { name: "a.txt".into(), path: "/x/a.txt".into() };
        assert_eq!(plain_question(true, Some(&file), "why?"), "File: a.txt\n\nwhy?");
        assert_eq!(plain_question(false, Some(&file), "why?"), "why?");
        let win = ChatContext::Window { app_name: "Code".into(), title: "main.rs".into(), url: None };
        assert_eq!(plain_question(true, Some(&win), "q"), "Context — App: Code, Window: main.rs\n\nq");
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
            windows: vec![WindowInfo { title: "Docs".into(), app: "msedge".into(), active: true, minimized: false }],
            shots: vec![ShotRef { name: "Screen 1".into(), path: "/inbox/s1.png".into() }],
            selection: None,
            folder: None,
        };
        let (q, images) = with_screen("claude-code", Some(&screen), "what is this?".into()).unwrap();
        assert!(q.contains("Read them from these paths:\n- Screen 1: /inbox/s1.png"));
        assert!(q.contains("- Docs — msedge (active)"));
        assert!(q.ends_with("what is this?"));
        assert!(images.is_empty(), "Claude Code reads the file itself");

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
        let base = std::env::temp_dir().join(format!("coucou-chat-ctx-{}", std::process::id()));
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
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(base.join("secret.txt"), inbox.join("link.txt")).unwrap();
            assert!(!is_inside(&inbox, &inbox.join("link.txt")));
        }
        let _ = std::fs::remove_dir_all(&base);
    }
}
