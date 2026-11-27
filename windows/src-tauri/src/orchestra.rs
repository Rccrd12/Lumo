// Projects (the island calls them so; the code, orchestras): a coordinator
// that plans and hands the work out, and threads that do it. A project has a
// name, an icon, what the user wants to work on (its goal, which every member
// is told), a folder of the user's where the threads work, and the model and
// effort of each role. Each member is a chat of its own (chat.rs), answered by
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

pub use crate::orchestra_tool_defs::{
    parse_chat, ASK_USER, COORDINATOR, LIST_THREADS, MESSAGE_COORDINATOR, MESSAGE_THREAD, NAMES, READ_MESSAGES, READ_THREAD, SHARE_FILE, START_THREAD,
    STOP_THREAD,
};
use crate::orchestra_tool_defs::{MEMBER, PREFIX};

/// The most threads an orchestra holds.
const MAX_THREADS: usize = 8;
/// The most characters of a message a member reads of another's in `read_thread`.
const READ_CLIP: usize = 4_000;
/// The most characters of a project's goal ("What do you want to work on?").
pub const GOAL_MAX: usize = 8_000;
/// The most characters of a project's name.
const TITLE_MAX: usize = 60;
/// A usage limit that says no time: tried again after this long (seconds).
const LIMIT_RETRY: u64 = 15 * 60;
/// What the coordinator answers when a thread's answer needs nothing from it:
/// kept in its conversation, never shown.
pub const QUIET: &str = "[quiet]";
/// What a member stopped by a usage limit is told when they reset.
const RESUMED: &str = "The usage limits have reset: go on with your task from where you stopped.";

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
    /// Claude Code's task id (TaskCreate's), for its TaskUpdate.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub id: String,
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
    /// A "limit" note: when the member goes on (ms since the epoch); none when it waits for the user.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<u64>,
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
    /// "idle", "working", "waiting", "paused" (a usage limit), "done", "failed" or "stopped".
    pub state: String,
    pub activity: Option<Activity>,
    pub plan: Vec<Step>,
    pub messages: Vec<Message>,
    /// Its conversation as plain turns, to give it back after Lumo restarts.
    pub history: Vec<(String, String)>,
    pub mail: Vec<Mail>,
    /// It said its task is done (message_coordinator with done).
    pub done: bool,
    /// Stopped by a usage limit: when it goes on by itself (ms since the epoch).
    pub resume_at: Option<u64>,
    /// A turn of its is running.
    #[serde(skip)]
    pub running: bool,
    /// It wrote to the coordinator during this turn: its answer is not sent on too.
    #[serde(skip)]
    pub wrote_coordinator: bool,
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
    /// Its icon (one of the island's, core/project-icons.ts) and its colour ("#rrggbb"; "" for none).
    pub icon: String,
    pub color: String,
    /// What the user wants to work on: every member is told it.
    pub goal: String,
    /// The user's folder the threads work in ("": the project's own shared folder only).
    pub folder: String,
    /// Its environment: the user's GitHub repositories ("owner/name") Lumo
    /// clones for it (`ensure_repos`), in its folder or its own.
    pub repos: Vec<String>,
    /// A member stopped by a usage limit goes on by itself once they reset.
    pub resume: bool,
    pub created: u64,
    pub updated: u64,
    pub coordinator: Member,
    pub threads: Vec<Member>,
    /// The coordinator's plan.
    pub plan: Vec<Step>,
    /// The pick a new thread starts with.
    pub thread_pick: Pick,
    /// The files members handed over (share_file): the reader may open them.
    pub shared: Vec<String>,
    /// The last id given to a line.
    pub next: u64,
    #[serde(skip)]
    pub locks: Vec<Lock>,
}

/// What New project and a project's settings set.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Project {
    pub title: String,
    pub icon: String,
    pub color: String,
    pub goal: String,
    pub folder: String,
    pub repos: Vec<String>,
    pub coordinator: Pick,
    pub thread: Pick,
    pub resume: bool,
}

/// A project as the list of projects shows it.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub icon: String,
    pub color: String,
    pub goal: String,
    pub updated: u64,
    /// "waiting" (a member asks the user), "working", "paused" (a usage limit), "done", "stopped" or "idle".
    pub state: String,
    /// How many of its members are at work.
    pub working: usize,
    /// The member that asks the user, when one does.
    pub asking: String,
    pub plan_done: usize,
    pub plan_total: usize,
    pub coordinator: Pick,
    pub thread: Pick,
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

    /// What the user set for the project (New project, its settings): the
    /// coordinator's pick, and the threads' for the threads to come and for
    /// those started with it (one the user gave a model of its own keeps it).
    pub fn apply(&mut self, p: Project) -> Result<(), String> {
        let title = clip(p.title.trim(), TITLE_MAX);
        if title.is_empty() {
            return Err(crate::i18n::t("A project needs a name."));
        }
        let folder = p.folder.trim().trim_matches('"').to_string();
        if !folder.is_empty() && !Path::new(&folder).is_absolute() {
            return Err(crate::i18n::t("The project's folder must be a full path."));
        }
        let color = p.color.trim();
        let hex = color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit());
        self.title = title;
        self.icon = p.icon.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(32).collect();
        self.color = if hex { color.to_lowercase() } else { String::new() };
        self.goal = p.goal.trim().chars().take(GOAL_MAX).collect();
        self.folder = folder;
        self.repos = repos_of(&p.repos);
        self.resume = p.resume;
        self.coordinator.pick = p.coordinator;
        for m in self.threads.iter_mut().filter(|m| m.pick == self.thread_pick) {
            m.pick = p.thread.clone();
        }
        self.thread_pick = p.thread;
        self.updated = now();
        Ok(())
    }

    /// The model and effort of one member, from the model button of its chat:
    /// the coordinator's is the project's own; a thread's is that thread's
    /// only, the others and those to come keep the project's.
    pub fn set_pick(&mut self, member: &str, pick: Pick) -> Result<(), String> {
        self.member_mut(member).ok_or_else(|| format!("There is no member {member}."))?.pick = pick;
        self.updated = now();
        Ok(())
    }

    /// How the list of projects shows it.
    pub fn summary(&self) -> Summary {
        let members: Vec<&Member> = std::iter::once(&self.coordinator).chain(self.threads.iter()).collect();
        let working = members.iter().filter(|m| m.state == "working").count();
        let asking = members.iter().find(|m| m.state == "waiting" || m.waits_for_user()).map(|m| m.id.clone()).unwrap_or_default();
        let state = if !asking.is_empty() {
            "waiting"
        } else if working > 0 {
            "working"
        } else if members.iter().any(|m| m.state == "paused") {
            "paused"
        } else if !self.threads.is_empty() && self.threads.iter().all(|t| t.state == "done") {
            "done"
        } else if members.iter().any(|m| m.state == "stopped" || m.state == "failed") {
            "stopped"
        } else {
            "idle"
        };
        Summary {
            id: self.id.clone(),
            title: self.title.clone(),
            icon: self.icon.clone(),
            color: self.color.clone(),
            goal: self.goal.clone(),
            updated: self.updated,
            state: state.into(),
            working,
            asking,
            plan_done: self.plan.iter().filter(|s| s.status == "completed").count(),
            plan_total: self.plan.len(),
            coordinator: self.coordinator.pick.clone(),
            thread: self.thread_pick.clone(),
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

    /// A thread's answer in its own chat, sent on to the coordinator as this
    /// project's threads report: the user sees it in the thread, the
    /// coordinator reads it (with what the user had written, when the user
    /// asked) and sums it up or says nothing. Whether the coordinator must be
    /// woken: not while it answers, nor stopped by the user or a usage limit.
    pub fn forward_reply(&mut self, thread: &str, text: &str, user: Option<&str>) -> bool {
        let text = text.trim();
        if text.is_empty() || thread == COORDINATOR || self.member(thread).is_none() {
            return false;
        }
        let line = Message { kind: "relay".into(), from: thread.into(), text: text.into(), note: Some("reply".into()), delivered: Some("queued".into()), ..Default::default() };
        let line = self.push(COORDINATOR, line).unwrap_or_default();
        let mut mail = String::from("(Its answer in its own chat: the user sees it there.)\n");
        if let Some(asked) = user.map(str::trim).filter(|u| !u.is_empty()) {
            mail.push_str(&format!("The user had written to it:\n{}\n\nIt answered:\n", clip(asked, READ_CLIP)));
        }
        mail.push_str(&clip(text, READ_CLIP * 2));
        let c = &mut self.coordinator;
        c.mail.push(Mail { from: thread.into(), text: mail, line });
        !c.running && c.state != "stopped" && c.state != "paused"
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
        self.claim_as(member, path, false)
    }

    /// `claim`, for a change already made (a CLI's, seen after it wrote,
    /// `touched`): the member is told by a message, as it can't be stopped.
    pub fn claim_as(&mut self, member: &str, path: &str, made: bool) -> Result<(), String> {
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
                if made {
                    let text = format!(
                        "You changed {path}, which thread \"{who}\" ({}) is changing right now. Don't change it again: write to {} with message_thread to agree on it, and check that neither change undid the other.",
                        held.member, held.member
                    );
                    if let Some(m) = self.member_mut(member) {
                        let line = m.messages.last().map(|l| l.id.clone()).unwrap_or_default();
                        m.mail.push(Mail { from: "lumo".into(), text: text.clone(), line });
                    }
                    return Err(text);
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
                "messages": m.messages, "resumeAt": m.resume_at,
            })
        };
        json!({
            "id": self.id, "title": self.title, "created": self.created, "updated": self.updated,
            "icon": self.icon, "color": self.color, "goal": self.goal, "folder": self.folder, "repos": self.repos, "resume": self.resume,
            "threadPick": self.thread_pick,
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

fn conversation_id(id: &str, member: &str) -> String {
    member_chat(id, member)
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

// ── Its environment: the user's GitHub repositories ───────────────────────────

/// The most repositories a project's environment holds.
const MAX_REPOS: usize = 8;

/// The repositories the user picked, as "owner/name", once each.
fn repos_of(raw: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for r in raw {
        let Some((owner, name)) = crate::github_tools::parse_repo(r) else { continue };
        let full = format!("{owner}/{name}");
        if !out.iter().any(|x| x.eq_ignore_ascii_case(&full)) && out.len() < MAX_REPOS {
            out.push(full);
        }
    }
    out
}

/// Where the repositories of a project are cloned: its folder, or its own in
/// Lumo's data when it has none.
fn repos_base(o: &Orchestra) -> PathBuf {
    if o.folder.is_empty() {
        dir().join(crate::workspace::safe_id(&o.id)).join("repos")
    } else {
        PathBuf::from(&o.folder)
    }
}

/// Each repository of the project and its folder: its name, or
/// "owner-name" when two share a name.
fn repo_dirs(o: &Orchestra) -> Vec<(String, PathBuf)> {
    let base = repos_base(o);
    o.repos
        .iter()
        .map(|full| {
            let (owner, name) = full.split_once('/').unwrap_or(("", full));
            let shared = o.repos.iter().filter(|r| r.rsplit('/').next().is_some_and(|n| n.eq_ignore_ascii_case(name))).count() > 1;
            let folder = if shared { format!("{owner}-{name}") } else { name.to_string() };
            (full.clone(), base.join(folder))
        })
        .collect()
}

/// One clone at a time, so two members starting together never clone the same repository twice.
static CLONING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The project's repositories not cloned yet are cloned (`git clone`, with
/// the user's own git; the GitHub token saved in Lumo, when there is one,
/// goes to git in its environment only, never on its command line or on
/// disk), and the coordinator's chat says so. A folder already there is
/// left as it is. Before every turn: nothing to do once they are there.
async fn ensure_repos(app: &AppHandle, id: &str) {
    let missing: Vec<(String, PathBuf)> = with(None, id, |o| repo_dirs(o)).unwrap_or_default().into_iter().filter(|(_, d)| !d.exists()).collect();
    if missing.is_empty() {
        return;
    }
    let _one = CLONING.lock().await;
    for (full, folder) in missing {
        if folder.exists() {
            continue;
        }
        let token = crate::secrets::get("github-token");
        let (url, target) = (format!("https://github.com/{full}.git"), folder.clone());
        let done = tauri::async_runtime::spawn_blocking(move || clone_repo(&url, &target, token.as_deref())).await.unwrap_or_else(|e| Err(e.to_string()));
        let line = match done {
            Ok(()) => Message { kind: "note".into(), from: "lumo".into(), note: Some("cloned".into()), text: full.clone(), holder: Some(folder.to_string_lossy().to_string()), ..Default::default() },
            Err(e) => Message { kind: "note".into(), from: "lumo".into(), note: Some("clone-failed".into()), text: format!("{full}: {e}"), ..Default::default() },
        };
        with(Some(app), id, |o| o.push(COORDINATOR, line));
    }
}

fn clone_repo(url: &str, folder: &Path, token: Option<&str>) -> Result<(), String> {
    if let Some(parent) = folder.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut cmd = std::process::Command::new("git");
    cmd.arg("clone").arg("--quiet").arg(url).arg(folder);
    // Never a prompt for a password: git fails at once instead.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    if let Some(token) = token.filter(|t| !t.is_empty()) {
        let basic = crate::claude::base64_for(format!("x-access-token:{token}").as_bytes());
        cmd.env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraheader")
            .env("GIT_CONFIG_VALUE_0", format!("AUTHORIZATION: basic {basic}"));
    }
    crate::platform::no_console(&mut cmd);
    let out = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            crate::i18n::t("Git is not installed on this PC.")
        } else {
            e.to_string()
        }
    })?;
    if out.status.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&out.stderr);
    Err(said.lines().map(str::trim).rfind(|l| !l.is_empty()).unwrap_or("git clone failed").to_string())
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
                // Only the user's words woke it: the coordinator reads them with its answer.
                let asked_by_user = o.member(&member).is_some_and(|m| !m.mail.is_empty() && m.mail.iter().all(|x| x.from == "user"));
                let query = o.take_mail(&member, "woke");
                let m = o.member_mut(&member)?;
                m.wrote_coordinator = false;
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
                m.resume_at = None;
                m.activity = Some(Activity { kind: "thinking".into(), detail: String::new() });
                let m = o.member(&member)?.clone();
                // A CLI is told its role with its first message: Lumo can't add to its instructions.
                let role = if m.history.is_empty() { note_for(o, &member, true) } else { String::new() };
                Some((query, role, m.pick.clone(), chat_of(&m), o.folder.clone(), asked_by_user))
            })
            .flatten();
            let Some((query, role, pick, conversation, project_folder, asked_by_user)) = next else { return };
            // Its environment's repositories, cloned before the first turn that needs them.
            ensure_repos(&app, &id).await;
            let repo_folders: Vec<PathBuf> = with(None, &id, |o| repo_dirs(o).into_iter().map(|(_, d)| d).collect()).unwrap_or_default();
            let settings = settings_for(&app, &pick);
            let cli = is_cli(&settings.chat_provider);
            let reply = if cli && member == COORDINATOR && settings.chat_provider != crate::claude_code::PROVIDER {
                // Only Claude Code's own tools can be taken away: another CLI would do the work itself.
                Err(crate::i18n::t("The coordinator can be an API model, a local model or Claude Code: pick one of them for it."))
            } else {
                let query = if cli && !role.is_empty() { format!("{}\n\n---\n\n{query}", role.trim()) } else { query.clone() };
                if cli {
                    // The orchestra's shared folder: the CLI may read and write it.
                    let folder = crate::workspace::dir(&shared_folder(&conversation_id(&id, &member)));
                    let _ = std::fs::create_dir_all(&folder);
                    conversation.cli_dirs(Some(folder.to_string_lossy().to_string()));
                    // The project's own folder of the user's: where it works.
                    if !project_folder.is_empty() {
                        conversation.cli_dirs(Some(project_folder.clone()));
                    }
                    // Its repositories, when they are not in it.
                    for folder in repo_folders.iter().filter(|d| project_folder.is_empty() || !d.starts_with(&project_folder)) {
                        conversation.cli_dirs(Some(folder.to_string_lossy().to_string()));
                    }
                }
                Box::pin(chat::send(&app, &conversation, &settings, query, None, None)).await
            };
            let mut tell_coordinator = false;
            let resume = with(Some(&app), &id, |o| {
                let mut resume = None;
                match reply {
                    Ok(r) => {
                        let text = r.text.trim().to_string();
                        // The coordinator with nothing to say: kept in its conversation, not shown.
                        let quiet = member == COORDINATOR && text.starts_with(QUIET);
                        if !text.is_empty() && !quiet {
                            o.push(&member, Message { kind: "assistant".into(), from: member.clone(), text: text.clone(), ..Default::default() });
                        }
                        // A thread's answer reaches the coordinator by itself, unless it wrote to it meanwhile.
                        let wrote = o.member(&member).is_some_and(|m| m.wrote_coordinator);
                        if member != COORDINATOR && !r.stopped && !wrote {
                            tell_coordinator = o.forward_reply(&member, &text, asked_by_user.then_some(query.as_str()));
                        }
                        if let Some(m) = o.member_mut(&member) {
                            m.history.push((query, r.kept.unwrap_or(text)));
                            m.state = if r.stopped { "stopped".into() } else { "working".into() };
                        }
                        if r.stopped {
                            o.push(&member, Message { kind: "note".into(), from: "lumo".into(), note: Some("stopped".into()), ..Default::default() });
                        }
                    }
                    Err(e) => match limit_wait(&e, now() / 1000, local_minute()) {
                        // A usage limit: the member waits for it to reset, and goes on then when the project says so.
                        Some(wait) => {
                            let until = o.resume.then(|| now() + wait * 1000);
                            o.push(&member, Message { kind: "note".into(), from: "lumo".into(), note: Some("limit".into()), text: e, until, ..Default::default() });
                            if let Some(m) = o.member_mut(&member) {
                                m.state = if until.is_some() { "paused".into() } else { "failed".into() };
                                m.resume_at = until;
                            }
                            resume = until;
                        }
                        None => {
                            o.push(&member, Message { kind: "note".into(), from: "lumo".into(), note: Some("error".into()), text: e, ..Default::default() });
                            if let Some(m) = o.member_mut(&member) {
                                m.state = "failed".into();
                            }
                        }
                    },
                }
                o.release(&member);
                if let Some(m) = o.member_mut(&member) {
                    // Stopped or failed: what came meanwhile waits for the next message.
                    if m.state != "working" {
                        m.running = false;
                        m.activity = None;
                    }
                }
                resume
            })
            .flatten();
            if let Some(until) = resume {
                resume_later(&app, &id, &member, until);
            }
            if tell_coordinator {
                wake(&app, &id, COORDINATOR);
            }
            let goes_on = with(None, &id, |o| o.member(&member).is_some_and(|m| m.running)).unwrap_or(false);
            if !goes_on {
                return;
            }
        }
    })
}

/// The member's turns go on at `until` (ms), when it is still waiting for the
/// usage limits then (no message woke it meanwhile, it was not stopped).
fn resume_later(app: &AppHandle, id: &str, member: &str, until: u64) {
    let key = format!("{id}/{member}/{until}");
    {
        let mut armed = ARMED.lock().unwrap_or_else(|e| e.into_inner());
        if armed.contains(&key) {
            return;
        }
        armed.push(key.clone());
    }
    let (app, id, member) = (app.clone(), id.to_string(), member.to_string());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(until.saturating_sub(now()))).await;
        ARMED.lock().unwrap_or_else(|e| e.into_inner()).retain(|k| k != &key);
        let wakes = with(Some(&app), &id, |o| {
            let m = o.member_mut(&member)?;
            if m.state != "paused" || m.resume_at != Some(until) {
                return None;
            }
            m.resume_at = None;
            m.state = "idle".into();
            o.deliver("lumo", &member, RESUMED).ok()
        })
        .flatten();
        if wakes == Some(true) {
            wake(&app, &id, &member);
        }
    });
}

/// The waits already set (orchestra/member/until), so one is never set twice.
static ARMED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The local time's minute of the day, for a limit that resets at "3pm".
fn local_minute() -> u32 {
    let t = crate::platform::local_time();
    t.hour * 60 + t.minute
}

/// How long (seconds) a member stopped by `error` waits before it goes on,
/// when `error` is a usage limit; None for any other error. The time it says
/// ("|1764280800", "resets 3pm", "try again in 2 hours"), else `LIMIT_RETRY`;
/// a minute more, as a limit resets on the minute. `now` in seconds, `minute`
/// the local minute of the day.
fn limit_wait(error: &str, now: u64, minute: u32) -> Option<u64> {
    let lower = error.to_lowercase();
    const SAID: [&str; 11] = [
        "usage limit", "limit reached", "hit your limit", "rate limit", "rate_limit", "too many requests", "quota", " 429", "(429", "limit resets", "resets at",
    ];
    if !SAID.iter().any(|s| lower.contains(s)) && !lower.starts_with("429") {
        return None;
    }
    let wait = at_epoch(&lower, now).or_else(|| at_clock(&lower, minute)).or_else(|| after_while(&lower)).unwrap_or(LIMIT_RETRY);
    Some(wait.clamp(60, 24 * 3600) + 60)
}

/// "…|1764280800" (Claude Code's limit): seconds (or ms) since the epoch.
fn at_epoch(text: &str, now: u64) -> Option<u64> {
    let digits: String = text.split('|').nth(1)?.chars().take_while(char::is_ascii_digit).collect();
    let n: u64 = digits.parse().ok()?;
    let secs = if digits.len() >= 13 { n / 1000 } else { n };
    (digits.len() >= 10 && secs > now).then(|| secs - now)
}

/// "resets 3pm", "resets at 15:00", "resets 3:30 pm (Europe/Rome)": the next time the clock says it.
fn at_clock(text: &str, minute: u32) -> Option<u64> {
    let rest = text.split("resets").nth(1)?.trim_start();
    let rest = rest.strip_prefix("at").unwrap_or(rest).trim_start();
    let hour: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let mut h: u32 = hour.parse().ok()?;
    let mut tail = &rest[hour.len()..];
    let mut m = 0;
    let mut clock = false;
    if let Some(after) = tail.strip_prefix(':') {
        let mins: String = after.chars().take_while(char::is_ascii_digit).collect();
        m = mins.parse().ok()?;
        tail = &after[mins.len()..];
        clock = true;
    }
    let tail = tail.trim_start();
    if tail.starts_with("pm") || tail.starts_with("p.m") {
        h = h % 12 + 12;
        clock = true;
    } else if tail.starts_with("am") || tail.starts_with("a.m") {
        h %= 12;
        clock = true;
    }
    if !clock || h > 23 || m > 59 {
        return None;
    }
    let target = h * 60 + m;
    Some(u64::from((target + 1440 - minute % 1440) % 1440) * 60)
}

/// "try again in 2 hours", "retry after 30 seconds", "in 5 minutes".
fn after_while(text: &str) -> Option<u64> {
    let words: Vec<&str> = text.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).collect();
    words.windows(3).find_map(|w| {
        if w[0] != "in" && w[0] != "after" {
            return None;
        }
        let n: u64 = w[1].parse().ok()?;
        let unit = w[2];
        if unit.starts_with("sec") || unit == "s" {
            Some(n)
        } else if unit.starts_with("min") || unit == "m" {
            Some(n * 60)
        } else if unit.starts_with("hour") || unit.starts_with("hr") || unit == "h" {
            Some(n * 3600)
        } else {
            None
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

/// The orchestra's tools (hook/src/orchestra_tools.rs) as the chat's providers take them.
fn as_api(tools: Vec<Value>) -> Vec<(String, String, Value)> {
    tools
        .into_iter()
        .map(|v| (v["name"].as_str().unwrap_or("").to_string(), v["description"].as_str().unwrap_or("").to_string(), v["inputSchema"].clone()))
        .collect()
}

pub fn coordinator_tools() -> Vec<(String, String, Value)> {
    let mut tools = as_api(crate::orchestra_tool_defs::coordinator_tools());
    tools.push(crate::island_tools::plan_tool());
    tools
}

fn thread_tools() -> Vec<(String, String, Value)> {
    as_api(crate::orchestra_tool_defs::thread_tools())
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
    let Some(text) = with(None, &id, |o| note_for(o, &member, false)) else { return String::new() };
    text
}

/// `cli`: the member is a CLI, which works with its own tools on the user's files.
fn note_for(o: &Orchestra, member: &str, cli: bool) -> String {
    let threads = if o.threads.is_empty() {
        "There are no threads yet.".to_string()
    } else {
        o.threads.iter().map(|t| format!("- {} \"{}\": {} ({})", t.id, t.title, clip(&t.task, 160), t.state)).collect::<Vec<_>>().join("\n")
    };
    let project = project_words(o, member, cli);
    if member == COORDINATOR {
        return format!(
            "\n\nYou are the coordinator of a project in Lumo. You never do the work yourself: you have no file, terminal or browser tools, only your own. \
You understand what the user wants, make a plan (update_plan), split the work into threads (start_thread), each with a clear, self-contained task, and follow them: \
you can write to them (message_thread), read them (read_thread, list_threads) and stop them (stop_thread). \
Threads share one folder for what they make (some of them, the CLIs, also work on the user's files directly), and hand finished files over with share_file. \
Two threads never change the same file at once: Lumo tells you when one tries. \
Messages from threads, from Lumo and the user's answers to your cards come to you as new messages that start with [From …]. While you are working they may also come inside a tool's result, between <lumo-messages> tags: read them and change your plan if needed. \
Every answer a thread writes in its own chat comes to you by itself, marked \"Its answer in its own chat\": the user sees it there, and talks to each thread directly. Most of them need nothing from you (progress, or the user and the thread talking): then answer only {QUIET}, which the user never sees. Write to the user only when a thread finished its task (one or two sentences on what came of it, never its text again), needs the user, or failed; when several threads work together, wait for them and write one summary. \
A message a thread sends you itself (message_coordinator) is a request: do what it needs (start a thread, pass something on to another, unblock it). \
Keep your answers to the user short: what is going on, what you decided, what you need. Use ask_user for a decision that changes the user's goal. \
Don't start threads for a simple question you can answer yourself, and don't start the same work twice: check list_threads first.{project}\n\nThe threads:\n{threads}"
        );
    }
    let me = o.member(member);
    let title = me.map(|m| m.title.as_str()).unwrap_or(member);
    let task = me.map(|m| m.task.as_str()).unwrap_or("");
    let work = if cli {
        let folder = crate::workspace::dir(&format!("{PREFIX}{}", o.id));
        format!(
            "Do your task with your own tools. Put what you make for the others in the orchestra's shared folder, {}, and hand a finished file to the user with share_file (a full path works too). Call read_messages between the steps of a long task.",
            folder.display()
        )
    } else {
        "Do your task with your tools. The files you work on are copies in a folder shared by every thread: copy files in with workspace_copy, change them there, and hand a finished file to the user with share_file.".to_string()
    };
    format!(
        "\n\nYou are thread {member} \"{title}\" of a project in Lumo: a coordinator plans the job and gives each thread a part of it. Your task, from the coordinator:\n{task}\n\n\
{work} \
What you answer in your chat reaches the coordinator by itself, and the user sees it: you don't need to write to the coordinator to report. Write to it with message_coordinator only when you need something from it (another thread, a decision about your task, help when you are blocked), and with done true when your task is finished, saying what you did and where the results are. You may write to another thread with message_thread. \
The user can write to you directly: do what they ask, and tell the coordinator when it changes your task. Use ask_user only for a decision the user must make. \
Messages from the coordinator, other threads, Lumo and the user come as new messages that start with [From …]. While you are working they may also come inside a tool's result, between <lumo-messages> tags: read them at once and change what you do if needed. \
Lumo stops you from changing a file another thread is changing right now, and says who: then don't change it, write to that thread or work on something else.{project}\n\nThe threads:\n{threads}"
    )
}

/// The project a member works for: its name, what the user wants (its goal), and its folder.
fn project_words(o: &Orchestra, member: &str, cli: bool) -> String {
    let mut out = String::new();
    if !o.title.is_empty() {
        out.push_str(&format!("\n\nThe project is \"{}\".", o.title));
    }
    if !o.goal.is_empty() {
        out.push_str(&format!(" What the user wants to work on in it, in their words:\n<project-goal>\n{}\n</project-goal>\nKeep to it in everything you do.", o.goal));
    }
    if !o.folder.is_empty() {
        let how = if member == COORDINATOR {
            "the threads work on the files there: tell them which files their task is about"
        } else if cli {
            "work on the files there"
        } else {
            "copy the files you need from it with workspace_copy, giving their full paths"
        };
        out.push_str(&format!("\nThe project's folder is {}: {how}.", o.folder));
    }
    let repos = repo_dirs(o);
    if !repos.is_empty() {
        let list = repos.iter().map(|(full, d)| format!("{full} (cloned at {})", d.display())).collect::<Vec<_>>().join(", ");
        let how = if member == COORDINATOR {
            "the threads work in them: tell each which repository its task is about"
        } else if cli {
            "work in them with your own tools and your own git: make a branch of your own for your changes, commit them there, and push or open a pull request only when the task or the user asks; never push to the default branch or force-push unless the user says so"
        } else {
            "copy the files you need from them with workspace_copy, giving their full paths"
        };
        out.push_str(&format!("\nThe project's GitHub repositories, its environment: {list}: {how}."));
    }
    out
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
    // A CLI member works on the user's files itself: it may hand over one of them by its full path.
    let cli = with(None, &id, |o| o.member(&member).map(|m| m.pick.clone())).flatten().is_some_and(|pick| is_cli(&settings_for(app, &pick).chat_provider));
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
                if let Some(m) = o.member_mut(&member) {
                    m.wrote_coordinator = true;
                    if input.get("done").and_then(Value::as_bool) == Some(true) {
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
                let path = inside(&folder, &s("path"))
                    .or_else(|| cli.then(|| full_file(&s("path"))).flatten())
                    .ok_or_else(|| format!("{} is not a file of the shared folder.", s("path")))?;
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                let markdown = matches!(path.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref(), Some("md" | "markdown"));
                let file = FileRef { path: path.to_string_lossy().to_string(), name, markdown };
                // The island may open it and show it in its folder (chat_files.rs).
                crate::chat_files::remember(&file.path);
                if !o.shared.contains(&file.path) {
                    o.shared.push(file.path.clone());
                }
                let note = s("note");
                o.push(&member, Message { kind: "file".into(), from: member.clone(), text: note.clone(), file: Some(file.clone()), ..Default::default() });
                o.push(COORDINATOR, Message { kind: "file".into(), from: member.clone(), text: note, file: Some(file.clone()), ..Default::default() });
                Ok(format!("Shared {} with the user and the coordinator.", file.name))
            }
            READ_MESSAGES => Ok(o.take_mail(&member, "mid-turn").map(|m| format!("New messages:\n\n{m}")).unwrap_or_else(|| "No new messages.".into())),
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

/// A member's plan written with its CLI's own tools (Claude Code's TodoWrite,
/// TaskCreate and TaskUpdate; the update_plan of Codex, Gemini CLI, agy), as
/// the chat sends it to the Plan island (`chat-plan`): the project's plan
/// (the coordinator's) or the thread's. Any other chat's: nothing.
pub fn cli_plan(app: &AppHandle, chat_id: &str, tool: &str, input: &Value) {
    let Some((id, member)) = parse_chat(chat_id) else { return };
    let (id, member) = (id.to_string(), member.to_string());
    with(Some(app), &id, |o| {
        let coordinator = member == COORDINATOR;
        let Some(plan) = (if coordinator { Some(&mut o.plan) } else { o.member_mut(&member).map(|m| &mut m.plan) }) else { return };
        apply_plan_call(plan, tool, input);
    });
}

/// `plan` after a plan tool's call: a whole plan replaces it, a task created
/// joins it, a task updated moves on (or goes, deleted).
fn apply_plan_call(plan: &mut Vec<Step>, tool: &str, input: &Value) {
    let status = |s: &str| match crate::chat_agents::step_status(s) {
        "done" | "skipped" => "completed",
        "active" => "in_progress",
        _ => "pending",
    };
    let task_id = |v: &Value| match &v["taskId"] {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    };
    let text = |v: &Value, keys: &[&str]| keys.iter().filter_map(|k| v[*k].as_str()).find_map(crate::chat_agents::step_text);
    match tool {
        "TaskCreate" => {
            let Some(step) = text(input, &["subject", "content", "description", "title"]) else { return };
            let id = task_id(input);
            if plan.len() >= 40 || (!id.is_empty() && plan.iter().any(|s| s.id == id)) {
                return;
            }
            plan.push(Step { step, status: "pending".into(), id });
        }
        "TaskUpdate" => {
            let id = task_id(input);
            let Some(pos) = plan.iter().position(|s| !id.is_empty() && s.id == id) else { return };
            match input["status"].as_str() {
                Some("deleted") => {
                    plan.remove(pos);
                    return;
                }
                Some(s) => plan[pos].status = status(s).into(),
                None => {}
            }
            if let Some(t) = text(input, &["subject"]) {
                plan[pos].step = t;
            }
        }
        _ => {
            let Some(steps) = crate::chat_agents::plan_of(input) else { return };
            *plan = steps.into_iter().map(|s| Step { step: s.text, status: status(s.status).into(), id: String::new() }).collect();
        }
    }
}

/// Claude Code's own tools, which a coordinator on Claude Code goes without:
/// it plans and hands the work out, never does it.
const CLAUDE_CODE_OWN: &str = "Bash Edit Write MultiEdit NotebookEdit Read Glob Grep LS WebFetch WebSearch Task Agent KillShell BashOutput";

/// Claude Code's command line for a member's turn: the orchestra's tools
/// (lumo-hook's, `mcp__lumo__…`) allowed without asking, and for the
/// coordinator none of Claude Code's own. Any other chat's, as it is.
pub fn claude_code_args(chat_id: &str, mut args: Vec<String>) -> Vec<String> {
    let Some((_, member)) = parse_chat(chat_id) else { return args };
    let mine: Vec<String> = crate::orchestra_tool_defs::tools_for(chat_id)
        .iter()
        .filter_map(|t| t["name"].as_str().map(|n| format!("mcp__lumo__{n}")))
        .chain(std::iter::once("mcp__lumo__update_plan".to_string()))
        .collect();
    // `--allowedTools` takes all that follows it: the list goes on its own one, last.
    match args.iter().position(|a| a == "--allowedTools") {
        Some(i) if i + 1 < args.len() => args[i + 1] = format!("{} {}", args[i + 1], mine.join(" ")),
        _ => {
            args.push("--allowedTools".into());
            args.push(mine.join(" "));
        }
    }
    if member == COORDINATOR {
        let at = args.iter().position(|a| a == "--allowedTools").unwrap_or(args.len());
        args.insert(at, CLAUDE_CODE_OWN.into());
        args.insert(at, "--disallowedTools".into());
    }
    args
}

/// A call from a CLI member, through lumo-hook's MCP server
/// (`{"lumo_orchestra": {"tool": …, "input": …, "chat": …}}`, pipe.rs): the
/// answer, with the messages that came for it meanwhile.
pub fn serve(app: &AppHandle, request: &Value) -> Value {
    let chat = request["chat"].as_str().unwrap_or("");
    let tool = request["tool"].as_str().unwrap_or("");
    match call(app, chat, tool, &request["input"]) {
        Some((text, false)) => json!({ "text": with_mail(app, chat, text) }),
        Some((error, true)) => json!({ "error": with_mail(app, chat, error) }),
        None => json!({ "error": "This chat is not a member of an orchestra." }),
    }
}

fn activity_words(m: &Member) -> String {
    match &m.activity {
        Some(a) if !a.detail.is_empty() => format!(", {} {}", a.kind, a.detail),
        _ => String::new(),
    }
}

/// `path`, when it is the full path of a file.
fn full_file(path: &str) -> Option<PathBuf> {
    let given = Path::new(path.trim());
    let full = std::fs::canonicalize(given).ok()?;
    (given.is_absolute() && full.is_file()).then_some(full)
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

/// A file a CLI member read, changed or made (claude_code.rs FileTouch,
/// chat.rs ChatEvents::file): a change is the member's until its turn ends,
/// and one to a file another thread is changing is said to both and to the
/// coordinator (the CLI changed it already: it can't be refused).
pub fn touched(app: &AppHandle, chat_id: &str, kind: &str, path: &str) {
    let Some((id, member)) = parse_chat(chat_id) else { return };
    let (id, member) = (id.to_string(), member.to_string());
    let changed = kind != "read";
    let detail = path.rsplit(['/', '\\']).find(|s| !s.is_empty()).unwrap_or(path).to_string();
    let clash = with(Some(app), &id, |o| {
        if let Some(m) = o.member_mut(&member) {
            m.activity = Some(Activity { kind: if changed { "edit".into() } else { "read".into() }, detail });
        }
        changed && o.claim_as(&member, path, true).is_err()
    });
    if clash == Some(true) {
        wake(app, &id, COORDINATOR);
    }
}

/// A card of a member's turn (a permission, tools.rs or a CLI's) came up or
/// went (chat_agents.rs signal_waiting): it waits for the user meanwhile.
pub fn waiting(app: &AppHandle, chat_id: &str, waits: bool) {
    let Some((id, member)) = parse_chat(chat_id) else { return };
    let (id, member) = (id.to_string(), member.to_string());
    with(Some(app), &id, |o| {
        if let Some(m) = o.member_mut(&member).filter(|m| m.running) {
            m.state = if waits { "waiting".into() } else { "working".into() };
        }
    });
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
    if m.state == "paused" {
        m.state = "stopped".into();
        m.resume_at = None;
    }
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
    crate::i18n::t("This project no longer exists.")
}

#[tauri::command]
pub fn orchestra_list() -> Vec<Summary> {
    let mut out: Vec<Summary> = Vec::new();
    let held: HashMap<String, Summary> = all().as_ref().map(|m| m.values().map(|o| (o.id.clone(), o.summary())).collect()).unwrap_or_default();
    let mut held = held;
    if let Ok(entries) = std::fs::read_dir(dir()) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let id = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if let Some(summary) = held.remove(&id) {
                out.push(summary);
                continue;
            }
            if let Some(o) = load(&id) {
                out.push(o.summary());
            }
        }
    }
    out.sort_by_key(|s| std::cmp::Reverse(s.updated));
    out
}

/// A new project, as New project set it; empty until the user's first message.
#[tauri::command]
pub fn orchestra_create(project: Project) -> Result<Value, String> {
    let mut o = Orchestra::new(&new_id(), Pick::default(), Pick::default());
    o.apply(project)?;
    let snapshot = o.snapshot();
    save(&o);
    all().get_or_insert_with(HashMap::new).insert(o.id.clone(), o);
    Ok(snapshot)
}

/// A project's settings saved: its name, icon, goal, folder, models, resume.
#[tauri::command]
pub fn orchestra_update(app: AppHandle, id: String, project: Project) -> Result<Value, String> {
    with(Some(&app), &id, |o| o.apply(project).map(|_| o.snapshot())).ok_or_else(not_found)?
}

/// One member's model and effort, picked in its chat.
#[tauri::command]
pub fn orchestra_set_pick(app: AppHandle, id: String, member: String, pick: Pick) -> Result<Value, String> {
    with(Some(&app), &id, |o| o.set_pick(&member, pick).map(|_| o.snapshot())).ok_or_else(not_found)?
}

#[tauri::command]
pub fn orchestra_open(app: AppHandle, id: String) -> Result<Value, String> {
    let (snapshot, paused) = with(None, &id, |o| {
        let paused: Vec<(String, u64)> = std::iter::once(&o.coordinator)
            .chain(o.threads.iter())
            .filter(|m| m.state == "paused")
            .filter_map(|m| Some((m.id.clone(), m.resume_at?)))
            .collect();
        (o.snapshot(), paused)
    })
    .ok_or_else(not_found)?;
    // Waiting for the usage limits when Lumo closed: they go on as planned.
    for (member, until) in paused {
        resume_later(&app, &id, &member, until);
    }
    Ok(snapshot)
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
    // One of its folder, or one a member handed over by its full path (share_file).
    let handed = with(None, &id, |o| o.shared.iter().any(|p| p == &path)).unwrap_or(false);
    let full = inside(&folder, &path)
        .or_else(|| handed.then(|| full_file(&path)).flatten())
        .ok_or_else(|| crate::i18n::t("This file is not in the project's folder."))?;
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
    fn a_cli_that_changed_a_file_another_thread_is_changing_is_told_after() {
        let mut o = orchestra();
        o.start_thread("A", "a").unwrap();
        o.start_thread("B", "b").unwrap();
        o.take_mail("t2", "woke");
        o.member_mut("t1").unwrap().running = true;
        o.member_mut("t2").unwrap().running = true;
        assert!(o.claim_as("t1", "C:\\proj\\main.rs", true).is_ok());
        let told = o.claim_as("t2", "c:/proj/main.rs", true).unwrap_err();
        assert!(told.starts_with("You changed"), "{told}");
        assert_eq!(o.member("t2").unwrap().mail.len(), 1, "a CLI hears it as a message");
        assert_eq!(o.coordinator.mail.len(), 1);
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
    fn claude_code_as_coordinator_goes_without_its_own_tools() {
        let args = claude_code_args(&member_chat("abc", COORDINATOR), vec!["-p".into(), "--allowedTools".into(), "mcp__lumo__set_timer".into()]);
        let at = args.iter().position(|a| a == "--allowedTools").unwrap();
        assert_eq!(at, args.len() - 2, "its list stays last");
        assert!(args[at + 1].contains("mcp__lumo__set_timer") && args[at + 1].contains("mcp__lumo__start_thread"));
        assert_eq!(args[at - 2], "--disallowedTools");
        assert!(args[at - 1].contains("Bash") && args[at - 1].contains("Edit"));
        let thread = claude_code_args(&member_chat("abc", "t1"), vec!["-p".into()]);
        assert_eq!(thread, ["-p", "--allowedTools", &thread[2]]);
        assert!(thread[2].contains("mcp__lumo__message_coordinator") && !thread.iter().any(|a| a == "--disallowedTools"));
        assert_eq!(claude_code_args("chat-1", vec!["-p".into()]), ["-p"]);
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

    fn project(title: &str) -> Project {
        Project {
            title: title.into(),
            icon: "code".into(),
            color: "#A78BFA".into(),
            goal: "Add features, always with a concept first.".into(),
            folder: String::new(),
            repos: Vec::new(),
            coordinator: Pick { provider: "claude-code".into(), model: "opus".into(), effort: "high".into() },
            thread: Pick { provider: "codex".into(), model: "gpt-5.5".into(), effort: "medium".into() },
            resume: true,
        }
    }

    #[test]
    fn a_project_is_what_its_form_says_and_its_threads_follow_the_models() {
        let mut o = orchestra();
        o.start_thread("A", "a").unwrap();
        assert!(o.apply(project("  ")).is_err(), "a name is needed");
        let mut far = project("Lumo");
        far.folder = "Code\\Lumo".into();
        assert!(o.apply(far).is_err(), "a folder is a full path");
        let mut p = project("Lumo");
        p.icon = "code\"><script>".into();
        p.goal = "x".repeat(GOAL_MAX + 50);
        o.apply(p).unwrap();
        assert_eq!(o.title, "Lumo");
        assert_eq!(o.icon, "codescript", "only the letters of an icon's name");
        assert_eq!(o.color, "#a78bfa");
        assert_eq!(o.goal.chars().count(), GOAL_MAX);
        assert!(o.resume);
        assert_eq!(o.coordinator.pick.provider, "claude-code");
        assert_eq!(o.member("t1").unwrap().pick.provider, "codex", "a thread already started takes the new model");
        assert_eq!(o.thread_pick.model, "gpt-5.5");
        let mut bad = project("Lumo");
        bad.color = "red; background:url(x)".into();
        o.apply(bad).unwrap();
        assert_eq!(o.color, "", "only a #rrggbb colour");
        let s = o.snapshot();
        assert_eq!(s["icon"], "code");
        assert_eq!(s["threadPick"]["provider"], "codex");
    }

    #[test]
    fn every_member_is_told_the_goal_and_the_folder() {
        let mut o = orchestra();
        let mut p = project("Contratti");
        p.goal = "Confrontare i contratti.".into();
        p.folder = if cfg!(windows) { "C:\\Docs\\Contratti".into() } else { "/docs/contratti".into() };
        o.apply(p).unwrap();
        o.start_thread("A", "a").unwrap();
        let coord = note_for(&o, COORDINATOR, false);
        assert!(coord.contains("\"Contratti\"") && coord.contains("<project-goal>\nConfrontare i contratti.\n</project-goal>"));
        assert!(coord.contains("tell them which files"));
        assert!(note_for(&o, "t1", false).contains("workspace_copy"), "an API thread copies from the folder");
        assert!(note_for(&o, "t1", true).contains("work on the files there"), "a CLI works in it");
        let bare = orchestra();
        assert!(!note_for(&bare, COORDINATOR, false).contains("project's folder"));
    }

    #[test]
    fn the_list_says_where_each_project_stands() {
        let mut o = orchestra();
        o.apply(project("Lumo")).unwrap();
        assert_eq!(o.summary().state, "idle");
        o.start_thread("A", "a").unwrap();
        o.start_thread("B", "b").unwrap();
        o.member_mut("t1").unwrap().state = "working".into();
        let s = o.summary();
        assert_eq!((s.state.as_str(), s.working), ("working", 1));
        o.member_mut("t2").unwrap().state = "waiting".into();
        let s = o.summary();
        assert_eq!((s.state.as_str(), s.asking.as_str()), ("waiting", "t2"));
        for t in o.threads.iter_mut() {
            t.state = "done".into();
        }
        o.plan = vec![Step { step: "a".into(), status: "completed".into(), ..Default::default() }, Step { step: "b".into(), status: "pending".into(), ..Default::default() }];
        let s = o.summary();
        assert_eq!((s.state.as_str(), s.plan_done, s.plan_total), ("done", 1, 2));
        assert_eq!(s.thread.provider, "codex");
        o.member_mut("t1").unwrap().state = "paused".into();
        assert_eq!(o.summary().state, "paused");
    }

    #[test]
    fn a_usage_limit_waits_for_the_time_it_says() {
        let now = 1_764_270_000;
        // Claude Code: the reset as seconds since the epoch, after a bar.
        assert_eq!(limit_wait("Claude AI usage limit reached|1764273600", now, 0), Some(3600 + 60));
        // "resets 3pm", at 13:10 local time: 1 h 50 min, and a minute more.
        assert_eq!(limit_wait("5-hour limit reached ∙ resets 3pm", now, 13 * 60 + 10), Some(110 * 60 + 60));
        assert_eq!(limit_wait("You've hit your limit · resets 3:30 pm (Europe/Rome)", now, 15 * 60), Some(30 * 60 + 60));
        // Past it today: tomorrow.
        assert_eq!(limit_wait("usage limit reached, resets at 08:00", now, 9 * 60), Some(23 * 3600 + 60));
        assert_eq!(limit_wait("Rate limit exceeded: try again in 2 minutes", now, 0), Some(120 + 60));
        assert_eq!(limit_wait("429 Too Many Requests", now, 0), Some(LIMIT_RETRY + 60), "no time said: tried again later");
        // Not a limit: a failure as any other.
        assert_eq!(limit_wait("The model is not loaded.", now, 0), None);
        assert_eq!(limit_wait("prompt is too long: 210000 tokens > 200000 maximum", now, 0), None);
        assert_eq!(limit_wait("connection lost, 5 hours of work", now, 0), None);
    }

    #[test]
    fn a_member_stopped_by_a_limit_stays_stopped_when_the_user_stops_it() {
        let mut o = orchestra();
        o.start_thread("A", "a").unwrap();
        let m = o.member_mut("t1").unwrap();
        m.state = "paused".into();
        m.resume_at = Some(now() + 60_000);
        stop_member(&mut o, "t1");
        let m = o.member("t1").unwrap();
        assert_eq!((m.state.as_str(), m.resume_at), ("stopped", None));
    }

    #[test]
    fn a_cli_members_own_plan_tools_make_its_plan() {
        let mut plan = Vec::new();
        let steps = |p: &[Step]| p.iter().map(|s| format!("{}:{}", s.step, s.status)).collect::<Vec<_>>();
        // Claude Code's tasks: created one by one, then moved on by their ids.
        apply_plan_call(&mut plan, "TaskCreate", &json!({ "subject": "Read the PDF", "taskId": "1" }));
        apply_plan_call(&mut plan, "TaskCreate", &json!({ "subject": "Find the fees", "taskId": "2" }));
        apply_plan_call(&mut plan, "TaskCreate", &json!({ "subject": "Find the fees", "taskId": "2" }));
        apply_plan_call(&mut plan, "TaskUpdate", &json!({ "taskId": "1", "status": "completed" }));
        apply_plan_call(&mut plan, "TaskUpdate", &json!({ "taskId": 2, "status": "in_progress" }));
        assert_eq!(steps(&plan), ["Read the PDF:completed", "Find the fees:in_progress"]);
        apply_plan_call(&mut plan, "TaskUpdate", &json!({ "taskId": "2", "status": "deleted" }));
        assert_eq!(steps(&plan), ["Read the PDF:completed"]);
        // TodoWrite, or another CLI's update_plan: the whole plan.
        apply_plan_call(&mut plan, "TodoWrite", &json!({ "todos": [{ "content": "A", "status": "completed" }, { "content": "B", "status": "in_progress" }, { "content": "C", "status": "pending" }] }));
        assert_eq!(steps(&plan), ["A:completed", "B:in_progress", "C:pending"]);
        apply_plan_call(&mut plan, "update_plan", &json!({ "plan": [{ "step": "D", "status": "completed" }] }));
        assert_eq!(steps(&plan), ["D:completed"]);
        // A call with no step leaves it as it is.
        apply_plan_call(&mut plan, "update_plan", &json!({ "plan": [] }));
        assert_eq!(steps(&plan), ["D:completed"]);
    }

    #[test]
    fn a_threads_answer_reaches_the_coordinator_which_may_say_nothing() {
        let mut o = orchestra();
        o.start_thread("Via Roma", "task").unwrap();
        o.take_mail(COORDINATOR, "woke");
        // With what the user had written to it, marked as its answer in its own chat.
        assert!(o.forward_reply("t1", "Penali a pagina 6.", Some("Dove sono le penali?")));
        let line = o.coordinator.messages.last().unwrap().clone();
        assert_eq!((line.kind.as_str(), line.from.as_str(), line.note.as_deref(), line.text.as_str()), ("relay", "t1", Some("reply"), "Penali a pagina 6."));
        let mail = o.take_mail(COORDINATOR, "woke").unwrap();
        assert!(mail.starts_with("[From thread \"Via Roma\" (t1)]\n(Its answer in its own chat"), "{mail}");
        assert!(mail.contains("The user had written to it:\nDove sono le penali?") && mail.ends_with("It answered:\nPenali a pagina 6."), "{mail}");
        // Nothing in the thread's own chat: its answer is there already.
        assert!(o.member("t1").unwrap().messages.iter().all(|m| m.to.is_none()));
        // The coordinator at work, or stopped by the user, is not woken; an empty answer goes nowhere.
        o.coordinator.running = true;
        assert!(!o.forward_reply("t1", "Fatto.", None));
        o.coordinator.running = false;
        o.coordinator.state = "stopped".into();
        assert!(!o.forward_reply("t1", "Fatto.", None));
        assert!(!o.forward_reply("t1", "  ", None));
        assert_eq!(o.coordinator.mail.len(), 2);
        // The coordinator's own answer never goes back to it.
        assert!(!o.forward_reply(COORDINATOR, "x", None));
        // The coordinator is told how to say nothing.
        assert!(note_for(&o, COORDINATOR, false).contains(QUIET));
    }

    #[test]
    fn a_threads_own_model_is_its_only_and_the_coordinators_is_the_projects() {
        let mut o = orchestra();
        o.start_thread("A", "x").unwrap();
        o.start_thread("B", "x").unwrap();
        let mine = Pick { provider: "codex".into(), model: "gpt-6".into(), effort: "high".into() };
        o.set_pick("t1", mine.clone()).unwrap();
        assert_eq!(o.member("t1").unwrap().pick, mine);
        assert_eq!(o.member("t2").unwrap().pick, o.thread_pick, "the others keep the project's");
        let started = o.start_thread("C", "x").unwrap();
        assert_eq!(o.member(&started).unwrap().pick, o.thread_pick, "and so do those to come");
        let coord = Pick { provider: "claude-code".into(), model: "opus".into(), effort: String::new() };
        o.set_pick(COORDINATOR, coord.clone()).unwrap();
        assert_eq!(o.summary().coordinator, coord, "the coordinator's is the project's");
        assert!(o.set_pick("t9", coord).is_err());
        // The project's thread model saved again: the thread with its own keeps it.
        let fields = Project { title: "P".into(), coordinator: o.coordinator.pick.clone(), thread: Pick { provider: "ollama".into(), model: "llama".into(), effort: String::new() }, ..Default::default() };
        o.apply(fields).unwrap();
        assert_eq!(o.member("t1").unwrap().pick, mine);
        assert_eq!(o.member("t2").unwrap().pick.model, "llama");
    }

    #[test]
    fn its_environment_holds_the_users_repositories_each_in_a_folder_of_its_own() {
        let mut o = orchestra();
        let mut p = project("P");
        p.repos = vec!["Rccrd12/Lumo".into(), "https://github.com/rccrd12/lumo".into(), "acme/lumo.git".into(), "x".into(), "acme/site".into()];
        o.apply(p.clone()).unwrap();
        assert_eq!(o.repos, ["Rccrd12/Lumo", "acme/lumo", "acme/site"], "once each, by owner/name, anything else left out");
        // In its own folder of Lumo's while it has none; two of the same name by their owner too.
        let dirs = repo_dirs(&o);
        assert!(dirs[0].1.ends_with(Path::new("repos").join("Rccrd12-Lumo")), "{:?}", dirs[0].1);
        assert!(dirs[1].1.ends_with("acme-lumo") && dirs[2].1.ends_with("site"));
        // In its folder once it has one; every member is told where they are.
        p.folder = if cfg!(windows) { "C:\\Progetti\\P".into() } else { "/home/u/P".into() };
        o.apply(p).unwrap();
        assert!(repo_dirs(&o)[2].1.starts_with(&o.folder));
        let words = note_for(&o, "t1", true);
        assert!(words.contains("acme/site (cloned at ") && words.contains("branch of your own"), "{words}");
        assert!(note_for(&o, COORDINATOR, false).contains("tell each which repository"));
        assert!(o.snapshot()["repos"].as_array().is_some_and(|r| r.len() == 3));
    }
}
