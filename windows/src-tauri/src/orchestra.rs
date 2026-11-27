// Orchestra mode: a coordinator that plans and hands the work out, and
// threads that do it. Each member is a chat of its own (chat.rs), answered by
// the model picked for its role: the coordinator never touches a file, it has
// only the tools below to start threads, write to them, read them and ask the
// user; each thread has the chat's tools, minus agents of its own, plus a
// folder of copies (workspace.rs) shared by every thread of the orchestra.
//
// The user writes to the coordinator or to any thread. Members write to each
// other with their tools. A message to a member that is answering is given to
// it at its next step, after the tool it is running (`with_mail`, read by
// tools.rs call_for_chat); one to a member that is not starts a turn for it.
//
// Lumo knows which thread is changing which file of the shared folder
// (`claim`): another thread that tries to change it is told who has it, and
// the coordinator is told too. A thread lets its files go when its turn ends.
//
// Members are answered by the chat's API providers and local models only
// (claude.rs, openai_compat.rs, local_chat.rs): each adds this module's
// tools and words for a member's chat (`shape_tools`, `note`).
//
// %LOCALAPPDATA%\com.rccrd12.lumo\orchestra\<id>.json keeps each orchestra:
// its members, what they said, and their conversations as plain turns.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::chat::{self, Chat};
use crate::island::WINDOW_LABEL;

pub const COORDINATOR: &str = "coordinator";
/// Every member's chat id starts so: `orch-<orchestra>-m-<member>`.
const PREFIX: &str = "orch-";
const MEMBER: &str = "-m-";

pub const START_THREAD: &str = "start_thread";
pub const MESSAGE_THREAD: &str = "message_thread";
pub const READ_THREAD: &str = "read_thread";
pub const LIST_THREADS: &str = "list_threads";
pub const STOP_THREAD: &str = "stop_thread";
pub const ASK_USER: &str = "ask_user";
pub const MESSAGE_COORDINATOR: &str = "message_coordinator";
pub const SHARE_FILE: &str = "share_file";
/// Every tool of this module (the plan tool is the chat's own name, `update_plan`).
pub const NAMES: [&str; 8] = [START_THREAD, MESSAGE_THREAD, READ_THREAD, LIST_THREADS, STOP_THREAD, ASK_USER, MESSAGE_COORDINATOR, SHARE_FILE];

/// The most threads an orchestra holds.
const MAX_THREADS: usize = 8;
/// The most characters of a message a member reads of another's in `read_thread`.
const READ_CLIP: usize = 4_000;

// ── What is kept ──────────────────────────────────────────────────────────────

/// A role's provider, model and effort ("" each: the chat's own).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Pick {
    pub provider: String,
    pub model: String,
    pub effort: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Step {
    pub step: String,
    pub status: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Opt {
    pub label: String,
    pub consequence: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Card {
    pub question: String,
    pub options: Vec<Opt>,
    pub recommended: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chose: Option<usize>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct FileRef {
    pub path: String,
    pub name: String,
    pub markdown: bool,
}

/// One line of a member's chat as the island shows it.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Message {
    pub id: String,
    pub at: u64,
    /// "user", "assistant", "relay", "card", "file" or "note".
    pub kind: String,
    /// "user", "coordinator", a thread's id, or "lumo".
    pub from: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card: Option<Card>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<FileRef>,
    /// A note's kind: "lock", "started", "stopped", "error".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// A message to this member: "queued" until it reads it, then "mid-turn"
    /// (read at a step of its answer) or "woke" (it started a turn).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivered: Option<String>,
    /// A message this member sent: to whom.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    /// A "lock" note: the member changing the file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub holder: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Activity {
    pub kind: String,
    pub detail: String,
}

/// A message waiting for its member to read it.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Mail {
    pub from: String,
    pub text: String,
    /// The id of its line in the member's chat, marked when it is read.
    pub line: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Member {
    pub id: String,
    pub chat: String,
    pub title: String,
    pub task: String,
    pub pick: Pick,
    /// "idle", "working", "waiting", "done", "failed" or "stopped".
    pub state: String,
    pub activity: Option<Activity>,
    pub plan: Vec<Step>,
    pub messages: Vec<Message>,
    /// Its conversation as plain turns, to give it back after Lumo restarts.
    pub history: Vec<(String, String)>,
    pub mail: Vec<Mail>,
    /// It said its task is done (message_coordinator with done).
    pub done: bool,
    /// A turn of its is running.
    #[serde(skip)]
    pub running: bool,
}

/// A file of the shared folder a thread is changing.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Lock {
    pub path: String,
    pub member: String,
    #[serde(skip)]
    key: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Orchestra {
    pub id: String,
    pub title: String,
    pub created: u64,
    pub updated: u64,
    pub coordinator: Member,
    pub threads: Vec<Member>,
    /// The coordinator's plan.
    pub plan: Vec<Step>,
    /// The pick a new thread starts with.
    pub thread_pick: Pick,
    /// The last id given to a line.
    pub next: u64,
    #[serde(skip)]
    pub locks: Vec<Lock>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub updated: u64,
    pub working: bool,
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

/// The chat id of member `member` of orchestra `id`.
pub fn member_chat(id: &str, member: &str) -> String {
    format!("{PREFIX}{id}{MEMBER}{member}")
}

/// The orchestra and the member of a chat id, when it is a member's.
pub fn parse_chat(chat: &str) -> Option<(&str, &str)> {
    let rest = chat.strip_prefix(PREFIX)?;
    let (id, member) = rest.split_once(MEMBER)?;
    (!id.is_empty() && !member.is_empty()).then_some((id, member))
}

/// The chat whose folder of copies a chat works in (workspace.rs dir): the
/// orchestra's one for every member, else its own.
pub fn shared_folder(chat: &str) -> String {
    match parse_chat(chat) {
        Some((id, _)) => format!("{PREFIX}{id}"),
        None => chat.to_string(),
    }
}

impl Member {
    fn new(id: &str, orchestra: &str, title: &str, task: &str, pick: Pick) -> Self {
        Member {
            id: id.to_string(),
            chat: member_chat(orchestra, id),
            title: title.to_string(),
            task: task.to_string(),
            pick,
            state: "idle".into(),
            ..Default::default()
        }
    }

    fn waits_for_user(&self) -> bool {
        self.messages.iter().any(|m| m.kind == "card" && m.card.as_ref().is_some_and(|c| c.chose.is_none()))
    }

    /// Its state once no turn runs.
    fn settled(&self) -> &'static str {
        if self.waits_for_user() {
            "waiting"
        } else if self.done {
            "done"
        } else {
            "idle"
        }
    }
}

impl Orchestra {
    pub fn new(id: &str, coordinator: Pick, thread: Pick) -> Self {
        let at = now();
        Orchestra {
            id: id.to_string(),
            created: at,
            updated: at,
            coordinator: Member::new(COORDINATOR, id, "Coordinator", "", coordinator),
            thread_pick: thread,
            ..Default::default()
        }
    }

    fn line_id(&mut self) -> String {
        self.next += 1;
        format!("m{}", self.next)
    }

    pub fn member(&self, id: &str) -> Option<&Member> {
        if id == COORDINATOR {
            Some(&self.coordinator)
        } else {
            self.threads.iter().find(|t| t.id == id)
        }
    }

    pub fn member_mut(&mut self, id: &str) -> Option<&mut Member> {
        if id == COORDINATOR {
            Some(&mut self.coordinator)
        } else {
            self.threads.iter_mut().find(|t| t.id == id)
        }
    }

    /// A thread named by the model: its id ("t2"), or its title.
    fn find_thread(&self, name: &str) -> Option<String> {
        let name = name.trim();
        let lower = name.to_lowercase();
        self.threads
            .iter()
            .find(|t| t.id == name)
            .or_else(|| self.threads.iter().find(|t| t.title.to_lowercase() == lower))
            .map(|t| t.id.clone())
    }

    fn title_of(&self, member: &str) -> String {
        match member {
            "user" => "the user".into(),
            "lumo" => "Lumo".into(),
            COORDINATOR => "the coordinator".into(),
            id => self.member(id).map(|m| format!("thread \"{}\" ({id})", m.title)).unwrap_or_else(|| id.to_string()),
        }
    }

    fn push(&mut self, member: &str, mut line: Message) -> Option<String> {
        let id = self.line_id();
        line.id = id.clone();
        line.at = now();
        self.updated = line.at;
        self.member_mut(member)?.messages.push(line);
        Some(id)
    }

    /// A message from `from` (the user, a member, Lumo) to `to`: a line of
    /// `to`'s chat, waiting for it to read it. Whether `to` must be woken
    /// (no turn of its runs).
    pub fn deliver(&mut self, from: &str, to: &str, text: &str) -> Result<bool, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("The message is empty.".into());
        }
        let running = self.member(to).ok_or_else(|| format!("There is no member {to}."))?.running;
        let kind = if from == "user" { "user" } else { "relay" };
        let line = Message { kind: kind.into(), from: from.into(), text: text.into(), delivered: Some("queued".into()), ..Default::default() };
        let line = self.push(to, line).unwrap_or_default();
        // What the sender wrote shows in its own chat too, as sent.
        if from != "user" && from != "lumo" && from != to {
            self.push(from, Message { kind: "relay".into(), from: from.into(), to: Some(to.into()), text: text.into(), ..Default::default() });
        }
        let member = self.member_mut(to).expect("checked above");
        member.mail.push(Mail { from: from.into(), text: text.into(), line });
        // A new message: a thread that was done or stopped is not any more.
        member.done = false;
        if member.state == "stopped" || member.state == "done" || member.state == "failed" {
            member.state = "idle".into();
        }
        Ok(!running)
    }

    /// The messages `member` has not read, as one text, each marked read as `how`.
    pub fn take_mail(&mut self, member: &str, how: &str) -> Option<String> {
        let mail = std::mem::take(&mut self.member_mut(member)?.mail);
        if mail.is_empty() {
            return None;
        }
        let lines: Vec<String> = mail.iter().map(|m| m.line.clone()).collect();
        if let Some(m) = self.member_mut(member) {
            for line in m.messages.iter_mut().filter(|l| lines.contains(&l.id)) {
                line.delivered = Some(how.into());
            }
        }
        self.updated = now();
        if mail.len() == 1 && mail[0].from == "user" {
            return Some(mail[0].text.clone());
        }
        Some(mail.iter().map(|m| format!("[From {}]\n{}", self.title_of(&m.from), m.text)).collect::<Vec<_>>().join("\n\n"))
    }

    /// A new thread, its task as its first message from the coordinator.
    pub fn start_thread(&mut self, title: &str, task: &str) -> Result<String, String> {
        let (title, task) = (title.trim(), task.trim());
        if title.is_empty() || task.is_empty() {
            return Err("A thread needs a title and a task.".into());
        }
        if self.threads.len() >= MAX_THREADS {
            return Err(format!("An orchestra has at most {MAX_THREADS} threads: give the work to one that is done, with message_thread."));
        }
        let n = self.threads.iter().filter_map(|t| t.id.strip_prefix('t')?.parse::<u32>().ok()).max().unwrap_or(0) + 1;
        let id = format!("t{n}");
        let thread = Member::new(&id, &self.id.clone(), &clip(title, 60), task, self.thread_pick.clone());
        self.threads.push(thread);
        let started = Message { kind: "note".into(), from: id.clone(), note: Some("started".into()), text: clip(title, 60), ..Default::default() };
        self.push(COORDINATOR, started);
        self.deliver(COORDINATOR, &id, task)?;
        // The task shows once in the coordinator's chat: as the thread it started.
        if let Some(c) = self.member_mut(COORDINATOR) {
            if c.messages.last().is_some_and(|m| m.kind == "relay" && m.to.as_deref() == Some(id.as_str())) {
                c.messages.pop();
            }
        }
        Ok(id)
    }

    /// The decision card `line` of `member` answered with option `choice`:
    /// the answer goes to the member as a message from the user.
    pub fn answer(&mut self, member: &str, line: &str, choice: usize) -> Result<bool, String> {
        let m = self.member_mut(member).ok_or("No such member.")?;
        let card = m.messages.iter_mut().find(|l| l.id == line).and_then(|l| l.card.as_mut()).ok_or("No such card.")?;
        if card.chose.is_some() {
            return Err("Already answered.".into());
        }
        let opt = card.options.get(choice).cloned().ok_or("No such option.")?;
        card.chose = Some(choice);
        let question = card.question.clone();
        let text = format!("My answer to \"{question}\": {}", opt.label);
        let wake = self.deliver("user", member, &text)?;
        // The card shows the choice: no second line for it.
        if let Some(m) = self.member_mut(member) {
            if let Some(last) = m.messages.last_mut() {
                last.kind = "user".into();
                last.note = Some("answer".into());
            }
        }
        Ok(wake)
    }

    /// `member` may change `path` of the shared folder: no other member
    /// whose turn is running is changing it. Taken for `member` until its turn ends.
    pub fn claim(&mut self, member: &str, path: &str) -> Result<(), String> {
        let key = lock_key(path);
        if key.is_empty() {
            return Ok(());
        }
        let held = self.locks.iter().find(|l| l.key == key && l.member != member).cloned();
        if let Some(held) = held {
            let holder_runs = self.member(&held.member).is_some_and(|m| m.running);
            if holder_runs {
                let who = self.member(&held.member).map(|m| m.title.clone()).unwrap_or_default();
                let mine = self.member(member).map(|m| m.title.clone()).unwrap_or_default();
                // The note, in the chat of who tried and in the coordinator's:
                // who tried (`from`), the file (`text`), who has it (`holder`).
                let note = Message { kind: "note".into(), from: member.into(), note: Some("lock".into()), text: path.trim().into(), holder: Some(held.member.clone()), ..Default::default() };
                self.push(member, note.clone());
                // The coordinator is told: it may share the work out again.
                if member != COORDINATOR {
                    let line = self.push(COORDINATOR, Message { delivered: Some("queued".into()), ..note }).unwrap_or_default();
                    let text = format!(
                        "Thread \"{mine}\" ({member}) tried to change {path}, which thread \"{who}\" ({}) is changing right now. Lumo stopped it and told it to wait or to write to {}. Coordinate them if needed.",
                        held.member, held.member
                    );
                    self.coordinator.mail.push(Mail { from: "lumo".into(), text, line });
                }
                return Err(format!(
                    "{path} is being changed right now by thread \"{who}\" ({}): nothing was written. Don't change it: write to {} with message_thread to agree on it, or work on something else and try again later.",
                    held.member, held.member
                ));
            }
            self.locks.retain(|l| l.key != key);
        }
        if !self.locks.iter().any(|l| l.key == key) {
            self.locks.push(Lock { path: path.trim().to_string(), member: member.to_string(), key });
        }
        Ok(())
    }

    fn release(&mut self, member: &str) {
        self.locks.retain(|l| l.member != member);
    }

    /// What the island is sent: everything but the conversations and the mail itself.
    pub fn snapshot(&self) -> Value {
        let member = |m: &Member| {
            json!({
                "id": m.id, "chat": m.chat, "title": m.title, "task": m.task, "pick": m.pick,
                "state": m.state, "activity": m.activity, "plan": m.plan, "queued": m.mail.len(),
                "messages": m.messages,
            })
        };
        json!({
            "id": self.id, "title": self.title, "created": self.created, "updated": self.updated,
            "coordinator": member(&self.coordinator),
            "threads": self.threads.iter().map(member).collect::<Vec<_>>(),
            "plan": self.plan,
            "locks": self.locks,
        })
    }
}

/// A path of the shared folder as locks compare it: Windows' case, either slash.
fn lock_key(path: &str) -> String {
    let p = path.trim().replace('\\', "/").to_lowercase();
    let p = p.trim_start_matches("./").trim_matches('/');
    p.split('/').filter(|s| !s.is_empty() && *s != ".").collect::<Vec<_>>().join("/")
}

// ── Every orchestra ───────────────────────────────────────────────────────────

static ALL: Mutex<Option<HashMap<String, Orchestra>>> = Mutex::new(None);
/// Each member's conversation, by its chat id.
static CHATS: Mutex<Option<HashMap<String, Arc<Chat>>>> = Mutex::new(None);

fn all() -> MutexGuard<'static, Option<HashMap<String, Orchestra>>> {
    ALL.lock().unwrap_or_else(|e| e.into_inner())
}

fn dir() -> PathBuf {
    crate::platform::local_dir().join("orchestra")
}

fn file_of(id: &str) -> PathBuf {
    dir().join(format!("{}.json", crate::workspace::safe_id(id)))
}

fn load(id: &str) -> Option<Orchestra> {
    let text = std::fs::read_to_string(file_of(id)).ok()?;
    let mut o: Orchestra = serde_json::from_str(&text).ok()?;
    // A turn that was running when Lumo closed is over.
    for m in std::iter::once(&mut o.coordinator).chain(o.threads.iter_mut()) {
        if m.state == "working" {
            m.state = "stopped".into();
        }
        m.activity = None;
    }
    Some(o)
}

fn save(o: &Orchestra) {
    let _ = std::fs::create_dir_all(dir());
    if let Ok(text) = serde_json::to_string(o) {
        let path = file_of(&o.id);
        let temp = path.with_extension("json.tmp");
        if std::fs::write(&temp, text).is_ok() {
            let _ = std::fs::rename(&temp, &path);
        }
    }
}

/// `f` on orchestra `id` (read from its file the first time); with `app`,
/// the island is then sent it and it is saved. None: there is no such orchestra.
fn with<T>(app: Option<&AppHandle>, id: &str, f: impl FnOnce(&mut Orchestra) -> T) -> Option<T> {
    let mut guard = all();
    let map = guard.get_or_insert_with(HashMap::new);
    if !map.contains_key(id) {
        let o = load(id)?;
        map.insert(id.to_string(), o);
    }
    let o = map.get_mut(id)?;
    let out = f(o);
    // Only what changes what the island shows is kept: the rest (a turn
    // starting, the words for a member) changes nothing on disk.
    if let Some(app) = app {
        let _ = app.emit_to(WINDOW_LABEL, "orchestra-update", o.snapshot());
        save(o);
    }
    Some(out)
}

fn chat_of(member: &Member) -> Arc<Chat> {
    let mut guard = CHATS.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    map.entry(member.chat.clone())
        .or_insert_with(|| {
            let chat = Chat::new(&member.chat);
            if !member.history.is_empty() {
                chat.restore(member.history.clone(), None, None, None);
            }
            Arc::new(chat)
        })
        .clone()
}

fn held_chat(chat: &str) -> Option<Arc<Chat>> {
    CHATS.lock().unwrap_or_else(|e| e.into_inner()).as_ref()?.get(chat).cloned()
}

/// The settings a member's turn goes by: the user's, with its role's pick.
fn settings_for(app: &AppHandle, pick: &Pick) -> crate::settings::Settings {
    let base = app.state::<crate::Shared>().settings.lock().unwrap_or_else(|e| e.into_inner()).clone();
    chat::with_pick(base, Some(&pick.provider), Some(&pick.model), Some(&pick.effort))
}

/// Starts a turn for `member` of `id` when none runs and it has messages to read.
fn wake(app: &AppHandle, id: &str, member: &str) {
    let start = with(None, id, |o| match o.member_mut(member) {
        Some(m) if !m.running && !m.mail.is_empty() => {
            m.running = true;
            true
        }
        _ => false,
    });
    if start == Some(true) {
        tauri::async_runtime::spawn(run(app.clone(), id.to_string(), member.to_string()));
    }
}

/// A member's turns, one after the other while messages come for it. Boxed:
/// a turn calls tools that wake members, which spawn this.
fn run(app: AppHandle, id: String, member: String) -> Pin<Box<dyn Future<Output = ()> + Send>> {
    Box::pin(async move {
        loop {
            let next = with(Some(&app), &id, |o| {
                let query = o.take_mail(&member, "woke");
                let m = o.member_mut(&member)?;
                let Some(query) = query else {
                    m.running = false;
                    m.activity = None;
                    if m.state == "working" {
                        m.state = m.settled().into();
                    }
                    o.release(&member);
                    return None;
                };
                m.state = "working".into();
                m.activity = Some(Activity { kind: "thinking".into(), detail: String::new() });
                let m = o.member(&member)?.clone();
                Some((query, m.pick.clone(), chat_of(&m)))
            })
            .flatten();
            let Some((query, pick, conversation)) = next else { return };
            let settings = settings_for(&app, &pick);
            let reply = if is_cli(&settings.chat_provider) {
                Err(crate::i18n::t("Orchestra members can only be API or local models: pick one for this role."))
            } else {
                Box::pin(chat::send(&app, &conversation, &settings, query.clone(), None, None)).await
            };
            with(Some(&app), &id, |o| {
                match reply {
                    Ok(r) => {
                        let text = r.text.trim().to_string();
                        if !text.is_empty() {
                            o.push(&member, Message { kind: "assistant".into(), from: member.clone(), text: text.clone(), ..Default::default() });
                        }
                        if let Some(m) = o.member_mut(&member) {
                            m.history.push((query, r.kept.unwrap_or(text)));
                            m.state = if r.stopped { "stopped".into() } else { "working".into() };
                        }
                        if r.stopped {
                            o.push(&member, Message { kind: "note".into(), from: "lumo".into(), note: Some("stopped".into()), ..Default::default() });
                        }
                    }
                    Err(e) => {
                        o.push(&member, Message { kind: "note".into(), from: "lumo".into(), note: Some("error".into()), text: e, ..Default::default() });
                        if let Some(m) = o.member_mut(&member) {
                            m.state = "failed".into();
                        }
                    }
                }
                o.release(&member);
                if let Some(m) = o.member_mut(&member) {
                    // Stopped or failed: what came meanwhile waits for the next message.
                    if m.state != "working" {
                        m.running = false;
                        m.activity = None;
                    }
                }
            });
            let goes_on = with(None, &id, |o| o.member(&member).is_some_and(|m| m.running)).unwrap_or(false);
            if !goes_on {
                return;
            }
        }
    })
}

fn is_cli(provider: &str) -> bool {
    provider == crate::claude_code::PROVIDER
        || provider == crate::antigravity_cli::PROVIDER
        || provider == crate::codex_chat::PROVIDER
        || crate::acp_chat::Agent::of(provider).is_some()
}

// ── What the providers ask of it ──────────────────────────────────────────────

/// One tool: its name, what it does, and the JSON schema of its input.
fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> (String, String, Value) {
    let schema = json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false });
    (name.to_string(), description.to_string(), schema)
}

fn ask_tool() -> (String, String, Value) {
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
                        "label": { "type": "string", "description": "A few words." },
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

fn message_thread_tool() -> (String, String, Value) {
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

pub fn coordinator_tools() -> Vec<(String, String, Value)> {
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
        crate::island_tools::plan_tool(),
    ]
}

fn thread_tools() -> Vec<(String, String, Value)> {
    vec![
        tool(
            MESSAGE_COORDINATOR,
            "Sends a message to the coordinator: what you did, a question, a problem. With done true, your task is finished: say what you did and where the results are.",
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
            "Hands the user and the coordinator a file you made in the shared folder (a report, a plan, a result): it shows as a card they can open. Markdown files open beside the chat.",
            json!({
                "path": { "type": "string", "description": "The file's path in the shared folder." },
                "note": { "type": "string", "description": "Optional: one line on what it is." },
            }),
            &["path"],
        ),
    ]
}

/// The tools of a member's chat: the coordinator's own only; a thread's the
/// chat's, without agents of its own, with the shared folder's and its own.
pub fn shape_tools(chat_id: &str, tools: &mut Vec<(String, String, Value)>) {
    let Some((_, member)) = parse_chat(chat_id) else { return };
    if member == COORDINATOR {
        *tools = coordinator_tools();
        return;
    }
    tools.retain(|(id, _, _)| id != crate::api_agents::RUN);
    if !tools.iter().any(|(id, _, _)| id == crate::workspace::COPY) {
        tools.extend(crate::workspace::api_tools());
    }
    if !tools.iter().any(|(id, _, _)| id == crate::island_tools::UPDATE_PLAN) {
        tools.push(crate::island_tools::plan_tool());
    }
    tools.extend(thread_tools());
}

/// What a member is told besides Lumo's instructions: its role, the others,
/// and how messages come.
pub fn note(chat_id: &str) -> String {
    let Some((id, member)) = parse_chat(chat_id) else { return String::new() };
    let (id, member) = (id.to_string(), member.to_string());
    let Some(text) = with(None, &id, |o| note_for(o, &member)) else { return String::new() };
    text
}

fn note_for(o: &Orchestra, member: &str) -> String {
    let threads = if o.threads.is_empty() {
        "There are no threads yet.".to_string()
    } else {
        o.threads.iter().map(|t| format!("- {} \"{}\": {} ({})", t.id, t.title, clip(&t.task, 160), t.state)).collect::<Vec<_>>().join("\n")
    };
    if member == COORDINATOR {
        return format!(
            "\n\nYou are the coordinator of an orchestra in Lumo. You never do the work yourself: you have no file, terminal or browser tools, only your own. \
You understand what the user wants, make a plan (update_plan), split the work into threads (start_thread), each with a clear, self-contained task, and follow them: \
you can write to them (message_thread), read them (read_thread, list_threads) and stop them (stop_thread). \
Threads share one folder of copies of the user's files: they copy files in, read and change them there, and hand finished files over with share_file. \
Two threads never change the same file at once: Lumo tells you when one tries. \
Messages from threads, from Lumo and the user's answers to your cards come to you as new messages that start with [From …]. While you are working they may also come inside a tool's result, between <lumo-messages> tags: read them and change your plan if needed. \
The user sees every thread and can talk to each directly. Keep your answers to the user short: what is going on, what you decided, what you need. Use ask_user for a decision that changes the user's goal. \
Don't start threads for a simple question you can answer yourself, and don't start the same work twice: check list_threads first.\n\nThe threads:\n{threads}"
        );
    }
    let me = o.member(member);
    let title = me.map(|m| m.title.as_str()).unwrap_or(member);
    let task = me.map(|m| m.task.as_str()).unwrap_or("");
    format!(
        "\n\nYou are thread {member} \"{title}\" of an orchestra in Lumo: a coordinator plans the job and gives each thread a part of it. Your task, from the coordinator:\n{task}\n\n\
Do your task with your tools. The files you work on are copies in a folder shared by every thread: copy files in with workspace_copy, change them there, and hand a finished file to the user with share_file. \
When you are done, or blocked, or need a decision, write to the coordinator with message_coordinator (done true when your task is finished). You may write to another thread with message_thread. \
The user can write to you directly: do what they ask, and tell the coordinator when it changes your task. Use ask_user only for a decision the user must make. \
Messages from the coordinator, other threads, Lumo and the user come as new messages that start with [From …]. While you are working they may also come inside a tool's result, between <lumo-messages> tags: read them at once and change what you do if needed. \
Lumo stops you from changing a file another thread is changing right now, and says who: then don't change it, write to that thread or work on something else.\n\nThe threads:\n{threads}"
    )
}

/// A call to one of this module's tools, or a member's plan: what goes back to
/// the model. None: not a call for this module (the chat's own tools run it).
pub fn call(app: &AppHandle, chat_id: &str, name: &str, input: &Value) -> Option<(String, bool)> {
    let (id, member) = parse_chat(chat_id)?;
    if !NAMES.contains(&name) && name != crate::island_tools::UPDATE_PLAN {
        return None;
    }
    let (id, member) = (id.to_string(), member.to_string());
    let s = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("").to_string();
    let coordinator = member == COORDINATOR;
    let mut woken: Vec<String> = Vec::new();
    let answer = with(Some(app), &id, |o| -> Result<String, String> {
        match name {
            n if n == crate::island_tools::UPDATE_PLAN => {
                let (text, failed) = crate::island_tools::plan_answer(input);
                if failed {
                    return Err(text);
                }
                let steps: Vec<Step> = serde_json::from_value(input.get("plan").cloned().unwrap_or_default()).unwrap_or_default();
                if coordinator {
                    o.plan = steps;
                } else if let Some(m) = o.member_mut(&member) {
                    m.plan = steps;
                }
                Ok(text)
            }
            START_THREAD if coordinator => {
                let thread = o.start_thread(&s("title"), &s("task"))?;
                woken.push(thread.clone());
                Ok(format!("Thread {thread} started. It works on its own and writes to you when it is done or needs you."))
            }
            MESSAGE_THREAD => {
                let to = o.find_thread(&s("thread")).ok_or_else(|| format!("There is no thread {}. The threads: {}.", s("thread"), o.threads.iter().map(|t| t.id.as_str()).collect::<Vec<_>>().join(", ")))?;
                if to == member {
                    return Err("That is you.".into());
                }
                let wakes = o.deliver(&member, &to, &s("message"))?;
                if wakes {
                    woken.push(to.clone());
                    Ok(format!("Sent: {to} starts working on it."))
                } else {
                    Ok(format!("Sent: {to} is working and reads it at its next step."))
                }
            }
            MESSAGE_COORDINATOR if !coordinator => {
                let wakes = o.deliver(&member, COORDINATOR, &s("message"))?;
                if input.get("done").and_then(Value::as_bool) == Some(true) {
                    if let Some(m) = o.member_mut(&member) {
                        m.done = true;
                    }
                }
                if wakes {
                    woken.push(COORDINATOR.to_string());
                }
                Ok("Sent to the coordinator.".into())
            }
            READ_THREAD if coordinator => {
                let t = o.find_thread(&s("thread")).ok_or_else(|| format!("There is no thread {}.", s("thread")))?;
                let last = input.get("last").and_then(Value::as_u64).unwrap_or(6).clamp(1, 30) as usize;
                let t = o.member(&t).ok_or("No such thread.")?;
                let mut out = format!("{} \"{}\": {}{}\nTask: {}\n", t.id, t.title, t.state, activity_words(t), t.task);
                for m in t.messages.iter().rev().take(last).collect::<Vec<_>>().into_iter().rev() {
                    let who = if m.kind == "assistant" { "it said".to_string() } else if let Some(to) = &m.to { format!("it wrote to {to}") } else { format!("from {}", m.from) };
                    out.push_str(&format!("\n[{} — {who}]\n{}\n", m.kind, clip(&m.text, READ_CLIP)));
                }
                Ok(out)
            }
            LIST_THREADS if coordinator => {
                if o.threads.is_empty() {
                    return Ok("No threads yet.".into());
                }
                Ok(o.threads
                    .iter()
                    .map(|t| {
                        let files: Vec<&str> = o.locks.iter().filter(|l| l.member == t.id).map(|l| l.path.as_str()).collect();
                        let files = if files.is_empty() { String::new() } else { format!("; changing {}", files.join(", ")) };
                        format!("- {} \"{}\": {}{}{files}\n  Task: {}", t.id, t.title, t.state, activity_words(t), clip(&t.task, 300))
                    })
                    .collect::<Vec<_>>()
                    .join("\n"))
            }
            STOP_THREAD if coordinator => {
                let t = o.find_thread(&s("thread")).ok_or_else(|| format!("There is no thread {}.", s("thread")))?;
                stop_member(o, &t);
                Ok(format!("{t} stopped."))
            }
            ASK_USER => {
                let options: Vec<Opt> = serde_json::from_value(input.get("options").cloned().unwrap_or_default()).unwrap_or_default();
                let question = s("question");
                if question.trim().is_empty() || !(2..=4).contains(&options.len()) {
                    return Err("A card needs a question and 2 to 4 options.".into());
                }
                let recommended = input.get("recommended").and_then(Value::as_u64).unwrap_or(0) as usize;
                let card = Card { question, recommended: recommended.min(options.len() - 1), options, chose: None };
                o.push(&member, Message { kind: "card".into(), from: member.clone(), card: Some(card), ..Default::default() });
                Ok("The card is in front of the user. Their choice comes as a new message: end your turn now unless other work does not depend on it.".into())
            }
            SHARE_FILE if !coordinator => {
                let folder = crate::workspace::dir(&shared_folder(chat_id));
                let path = inside(&folder, &s("path")).ok_or_else(|| format!("{} is not a file of the shared folder.", s("path")))?;
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let markdown = matches!(path.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref(), Some("md" | "markdown"));
                let file = FileRef { path: path.to_string_lossy().to_string(), name, markdown };
                // The island may open it and show it in its folder (chat_files.rs).
                crate::chat_files::remember(&file.path);
                let note = s("note");
                o.push(&member, Message { kind: "file".into(), from: member.clone(), text: note.clone(), file: Some(file.clone()), ..Default::default() });
                o.push(COORDINATOR, Message { kind: "file".into(), from: member.clone(), text: note, file: Some(file.clone()), ..Default::default() });
                Ok(format!("Shared {} with the user and the coordinator.", file.name))
            }
            _ => Err(crate::tools::not_offered(name)),
        }
    })?;
    for m in woken {
        wake(app, &id, &m);
    }
    Some(match answer {
        Ok(text) => (text, false),
        Err(text) => (text, true),
    })
}

fn activity_words(m: &Member) -> String {
    match &m.activity {
        Some(a) if !a.detail.is_empty() => format!(", {} {}", a.kind, a.detail),
        _ => String::new(),
    }
}

/// `path` of `folder`, when it is a file inside it.
fn inside(folder: &Path, path: &str) -> Option<PathBuf> {
    let path = path.trim();
    if path.is_empty() {
        return None;
    }
    let given = Path::new(path);
    let full = if given.is_absolute() { given.to_path_buf() } else { folder.join(given) };
    let full = std::fs::canonicalize(full).ok()?;
    let folder = std::fs::canonicalize(folder).ok()?;
    (full.starts_with(&folder) && full.is_file()).then_some(full)
}

/// Before a tool of a member's chat runs: what it is doing shows on its row,
/// and a change to a file of the shared folder another thread is changing is
/// refused (the answer for the model).
pub fn before(app: &AppHandle, chat_id: &str, name: &str, input: &Value) -> Result<(), String> {
    let Some((id, member)) = parse_chat(chat_id) else { return Ok(()) };
    let (id, member) = (id.to_string(), member.to_string());
    let changes = [crate::workspace::WRITE, crate::workspace::EDIT, crate::workspace::DELETE].contains(&name);
    let path = input.get("path").and_then(Value::as_str).unwrap_or("").to_string();
    let activity = if crate::workspace::NAMES.contains(&name) {
        let a = crate::workspace::activity(name, input);
        Activity { kind: a.kind.into(), detail: a.detail }
    } else {
        Activity { kind: "tool".into(), detail: crate::claude_code::pretty_tool(name) }
    };
    let result = with(Some(app), &id, |o| {
        if let Some(m) = o.member_mut(&member) {
            m.activity = Some(activity);
        }
        if changes {
            o.claim(&member, &path)
        } else {
            Ok(())
        }
    });
    // The coordinator heard of a clash: it reads it now, or at its next step.
    if matches!(result, Some(Err(_))) {
        wake(app, &id, COORDINATOR);
    }
    result.unwrap_or(Ok(()))
}

/// After a tool of a member's chat ran: the messages that came for it
/// meanwhile go with the tool's answer, so it reads them at this step.
pub fn with_mail(app: &AppHandle, chat_id: &str, text: String) -> String {
    let Some((id, member)) = parse_chat(chat_id) else { return text };
    let (id, member) = (id.to_string(), member.to_string());
    let mail = with(Some(app), &id, |o| {
        let mail = o.take_mail(&member, "mid-turn");
        if let Some(m) = o.member_mut(&member) {
            m.activity = Some(Activity { kind: "thinking".into(), detail: String::new() });
        }
        mail
    })
    .flatten();
    match mail {
        Some(mail) => format!(
            "{text}\n\n<lumo-messages>\nWhile you were working, new messages came for you. Read them now: they may change what you do next.\n\n{mail}\n</lumo-messages>"
        ),
        None => text,
    }
}

fn stop_member(o: &mut Orchestra, member: &str) {
    let Some(m) = o.member_mut(member) else { return };
    m.mail.clear();
    let chat = m.chat.clone();
    if m.running {
        if let Some(chat) = held_chat(&chat) {
            chat.stop();
        }
    }
    o.release(member);
}

// ── Commands ──────────────────────────────────────────────────────────────────

fn new_id() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u64(now());
    format!("{:x}{:04x}", now(), h.finish() & 0xffff)
}

fn not_found() -> String {
    crate::i18n::t("This orchestra no longer exists.")
}

#[tauri::command]
pub fn orchestra_list() -> Vec<Summary> {
    let mut out: Vec<Summary> = Vec::new();
    let held: HashMap<String, (String, u64, bool)> = all()
        .as_ref()
        .map(|m| {
            m.values()
                .map(|o| (o.id.clone(), (o.title.clone(), o.updated, o.coordinator.running || o.threads.iter().any(|t| t.running))))
                .collect()
        })
        .unwrap_or_default();
    if let Ok(entries) = std::fs::read_dir(dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let id = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if let Some((title, updated, working)) = held.get(&id) {
                out.push(Summary { id, title: title.clone(), updated: *updated, working: *working });
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
            out.push(Summary {
                id,
                title: v["title"].as_str().unwrap_or_default().to_string(),
                updated: v["updated"].as_u64().unwrap_or_default(),
                working: false,
            });
        }
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.updated));
    out
}

#[tauri::command]
pub fn orchestra_create(app: AppHandle) -> Value {
    let settings = app.state::<crate::Shared>().settings.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let o = Orchestra::new(&new_id(), settings.orchestra_coordinator.clone(), settings.orchestra_thread.clone());
    let snapshot = o.snapshot();
    save(&o);
    all().get_or_insert_with(HashMap::new).insert(o.id.clone(), o);
    snapshot
}

#[tauri::command]
pub fn orchestra_open(id: String) -> Result<Value, String> {
    with(None, &id, |o| o.snapshot()).ok_or_else(not_found)
}

#[tauri::command]
pub fn orchestra_send(app: AppHandle, id: String, to: String, text: String) -> Result<(), String> {
    let wakes = with(Some(&app), &id, |o| {
        if o.title.is_empty() && to == COORDINATOR {
            o.title = clip(text.trim().lines().next().unwrap_or(""), 60);
        }
        o.deliver("user", &to, &text)
    })
    .ok_or_else(not_found)??;
    if wakes {
        wake(&app, &id, &to);
    }
    Ok(())
}

#[tauri::command]
pub fn orchestra_answer(app: AppHandle, id: String, member: String, message: String, choice: usize) -> Result<(), String> {
    let wakes = with(Some(&app), &id, |o| o.answer(&member, &message, choice)).ok_or_else(not_found)??;
    if wakes {
        wake(&app, &id, &member);
    }
    Ok(())
}

#[tauri::command]
pub fn orchestra_stop(app: AppHandle, id: String, member: Option<String>) -> Result<(), String> {
    with(Some(&app), &id, |o| {
        let members: Vec<String> = match member {
            Some(m) => vec![m],
            None => std::iter::once(COORDINATOR.to_string()).chain(o.threads.iter().map(|t| t.id.clone())).collect(),
        };
        for m in members {
            stop_member(o, &m);
        }
    })
    .ok_or_else(not_found)
}

#[tauri::command]
pub fn orchestra_set_picks(app: AppHandle, id: String, coordinator: Option<Pick>, thread: Option<Pick>) -> Result<Value, String> {
    with(Some(&app), &id, |o| {
        if let Some(c) = coordinator {
            o.coordinator.pick = c;
        }
        if let Some(t) = thread {
            for m in o.threads.iter_mut() {
                m.pick = t.clone();
            }
            o.thread_pick = t;
        }
        o.snapshot()
    })
    .ok_or_else(not_found)
}

#[tauri::command]
pub fn orchestra_delete(id: String) {
    let o = with(None, &id, |o| {
        for m in std::iter::once(COORDINATOR.to_string()).chain(o.threads.iter().map(|t| t.id.clone())).collect::<Vec<_>>() {
            stop_member(o, &m);
        }
        std::iter::once(o.coordinator.chat.clone()).chain(o.threads.iter().map(|t| t.chat.clone())).collect::<Vec<_>>()
    });
    if let Some(chats) = o {
        if let Some(map) = CHATS.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            for c in &chats {
                map.remove(c);
            }
        }
    }
    if let Some(map) = all().as_mut() {
        map.remove(&id);
    }
    let _ = std::fs::remove_file(file_of(&id));
    crate::workspace::delete(&format!("{PREFIX}{id}"));
}

#[derive(Serialize)]
pub struct FileText {
    name: String,
    path: String,
    text: String,
}

/// A file a thread shared, for the reader beside the chat: only one of the orchestra's folder.
#[tauri::command]
pub fn orchestra_read_file(id: String, path: String) -> Result<FileText, String> {
    let folder = crate::workspace::dir(&format!("{PREFIX}{id}"));
    let full = inside(&folder, &path).ok_or_else(|| crate::i18n::t("This file is not in the orchestra's folder."))?;
    let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(1_000_000)]).to_string();
    let name = full.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    Ok(FileText { name, path: full.to_string_lossy().to_string(), text })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn orchestra() -> Orchestra {
        Orchestra::new("abc", Pick::default(), Pick { provider: "ollama".into(), model: "qwen".into(), effort: String::new() })
    }

    #[test]
    fn a_member_chat_names_its_orchestra_and_shares_its_folder() {
        let chat = member_chat("abc", "t2");
        assert_eq!(parse_chat(&chat), Some(("abc", "t2")));
        assert_eq!(shared_folder(&chat), "orch-abc");
        assert_eq!(shared_folder(&member_chat("abc", COORDINATOR)), "orch-abc");
        assert_eq!(shared_folder("chat-123"), "chat-123");
        assert_eq!(parse_chat("orch-abc"), None);
    }

    #[test]
    fn the_coordinator_starts_threads_with_their_task_as_first_message() {
        let mut o = orchestra();
        let id = o.start_thread("Analisi CSV", "Leggi vendite.csv e riassumi").unwrap();
        assert_eq!(id, "t1");
        let t = o.member("t1").unwrap();
        assert_eq!(t.pick.provider, "ollama", "a thread takes the thread pick");
        assert_eq!(t.mail.len(), 1);
        assert_eq!(t.messages[0].kind, "relay");
        assert_eq!(t.messages[0].from, COORDINATOR);
        // The coordinator's chat says the thread started, once.
        assert_eq!(o.coordinator.messages.len(), 1);
        assert_eq!(o.coordinator.messages[0].note.as_deref(), Some("started"));
        assert_eq!(o.start_thread("Grafici", "x").unwrap(), "t2");
        assert!(o.start_thread("", "x").is_err());
    }

    #[test]
    fn a_message_to_a_working_member_waits_for_its_next_step() {
        let mut o = orchestra();
        o.start_thread("A", "task").unwrap();
        assert_eq!(o.take_mail("t1", "woke").as_deref(), Some("[From the coordinator]\ntask"));
        o.member_mut("t1").unwrap().running = true;
        let wakes = o.deliver("user", "t1", "usa anche il file 2").unwrap();
        assert!(!wakes, "it is working: no new turn");
        let line = o.member("t1").unwrap().messages.last().unwrap().clone();
        assert_eq!((line.kind.as_str(), line.delivered.as_deref()), ("user", Some("queued")));
        assert_eq!(o.member("t1").unwrap().mail.len(), 1);
        assert_eq!(o.take_mail("t1", "mid-turn").as_deref(), Some("usa anche il file 2"));
        assert_eq!(o.member("t1").unwrap().messages.last().unwrap().delivered.as_deref(), Some("mid-turn"));
        assert_eq!(o.take_mail("t1", "mid-turn"), None);
    }

    #[test]
    fn threads_write_to_each_other_and_both_chats_show_it() {
        let mut o = orchestra();
        o.start_thread("A", "a").unwrap();
        o.start_thread("B", "b").unwrap();
        o.take_mail("t1", "woke");
        o.take_mail("t2", "woke");
        assert!(o.deliver("t1", "t2", "ho finito lo schema").unwrap());
        let sent = o.member("t1").unwrap().messages.last().unwrap();
        assert_eq!((sent.kind.as_str(), sent.to.as_deref()), ("relay", Some("t2")));
        assert_eq!(o.take_mail("t2", "woke").as_deref(), Some("[From thread \"A\" (t1)]\nho finito lo schema"));
        assert_eq!(o.find_thread("b").as_deref(), Some("t2"), "by title too");
    }

    #[test]
    fn a_file_another_working_thread_changes_is_refused_and_the_coordinator_told() {
        let mut o = orchestra();
        o.start_thread("A", "a").unwrap();
        o.start_thread("B", "b").unwrap();
        o.take_mail(COORDINATOR, "woke");
        o.member_mut("t1").unwrap().running = true;
        o.member_mut("t2").unwrap().running = true;
        o.member_mut(COORDINATOR).unwrap().running = true;
        assert!(o.claim("t1", "src\\App.ts").is_ok());
        assert!(o.claim("t1", "src/app.ts").is_ok(), "its own lock");
        let refused = o.claim("t2", "./src/app.ts").unwrap_err();
        assert!(refused.contains("\"A\" (t1)"), "{refused}");
        assert_eq!(o.member("t2").unwrap().messages.last().unwrap().note.as_deref(), Some("lock"));
        assert_eq!(o.coordinator.mail.len(), 1, "the coordinator hears of it");
        // A turn that ended lets its files go.
        o.release("t1");
        assert!(o.claim("t2", "src/app.ts").is_ok());
        // A holder whose turn is over doesn't keep it either.
        o.member_mut("t2").unwrap().running = false;
        assert!(o.claim("t1", "src/app.ts").is_ok());
        assert_eq!(o.locks.len(), 1);
        assert_eq!(o.locks[0].member, "t1");
    }

    #[test]
    fn a_card_answered_goes_back_to_who_asked_once() {
        let mut o = orchestra();
        let card = Card { question: "Quale formato?".into(), options: vec![Opt { label: "PDF".into(), consequence: "".into() }, Opt { label: "MD".into(), consequence: "".into() }], recommended: 1, chose: None };
        let line = o.push(COORDINATOR, Message { kind: "card".into(), from: COORDINATOR.into(), card: Some(card), ..Default::default() }).unwrap();
        assert_eq!(o.coordinator.settled(), "waiting");
        assert!(o.answer(COORDINATOR, &line, 1).unwrap());
        assert_eq!(o.coordinator.messages[0].card.as_ref().unwrap().chose, Some(1));
        assert!(o.take_mail(COORDINATOR, "woke").unwrap().contains("MD"));
        assert_eq!(o.coordinator.settled(), "idle");
        assert!(o.answer(COORDINATOR, &line, 0).is_err());
    }

    #[test]
    fn the_coordinator_has_only_its_own_tools_and_threads_no_agents() {
        let mut tools = vec![("workspace_write".to_string(), String::new(), json!({})), (crate::api_agents::RUN.to_string(), String::new(), json!({}))];
        shape_tools(&member_chat("abc", COORDINATOR), &mut tools);
        let names: Vec<&str> = tools.iter().map(|t| t.0.as_str()).collect();
        assert!(names.contains(&START_THREAD) && names.contains(&ASK_USER));
        assert!(!names.contains(&"workspace_write") && !names.contains(&crate::api_agents::RUN));
        let mut tools = vec![(crate::api_agents::RUN.to_string(), String::new(), json!({}))];
        shape_tools(&member_chat("abc", "t1"), &mut tools);
        let names: Vec<&str> = tools.iter().map(|t| t.0.as_str()).collect();
        assert!(!names.contains(&crate::api_agents::RUN));
        assert!(names.contains(&crate::workspace::WRITE) && names.contains(&MESSAGE_COORDINATOR) && names.contains(&SHARE_FILE));
        let mut plain = vec![(crate::api_agents::RUN.to_string(), String::new(), json!({}))];
        shape_tools("chat-1", &mut plain);
        assert_eq!(plain.len(), 1, "a normal chat is left as it is");
    }

    #[test]
    fn the_snapshot_leaves_the_conversations_out() {
        let mut o = orchestra();
        o.start_thread("A", "a").unwrap();
        o.member_mut("t1").unwrap().history.push(("q".into(), "a".into()));
        let s = o.snapshot();
        assert!(s["threads"][0].get("history").is_none());
        assert_eq!(s["threads"][0]["queued"], 1);
        assert_eq!(s["coordinator"]["chat"], "orch-abc-m-coordinator");
    }
}
