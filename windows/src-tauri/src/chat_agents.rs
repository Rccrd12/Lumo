// The agents a chat's answer started, and the chat's sign of life
// (concept: concepts/sotto-agenti).
//
// A CLI that answers in the island's chat can start agents of its own (Claude
// Code's Agent tool, Codex's collaborators, Antigravity's subagents, Cursor's
// tasks). They work in parallel, often in the background after the turn that
// started them ended, and until now the chat showed nothing of them: it looked
// finished, or stuck. Each provider now tells the island about each of its
// agents with one event, `chat-agent`, always the agent's whole state (never a
// diff), so the island's Agents card (src/views/agents-card.ts) can draw it as
// it comes, and the last one it got is the truth.
//
// The sign of life, `chat-signal`, says a chat's answer is still moving: a
// piece of text, a tool call starting or ending, a retry, a line of a CLI's
// output. The island reads "no signal for N s" from the time of the last one
// (src/core/chat-agents.ts). It goes at most once a second per chat, so a
// fast stream costs nothing, and never while nothing happens (0 % CPU when
// the island is hidden).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::claude_code::Activity;
use crate::island::WINDOW_LABEL;

/// Epoch milliseconds, as the island's clock counts them.
pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A mark of its own for one run of a CLI (a turn, a server), for the ids of
/// the agents it names only by their place in that run (`step-5`, `task-1`):
/// the same place in a later run is another agent, and the island keeps a
/// chat's rows by id, so the same id would never show again once ended. The
/// time keeps it apart from the runs of an earlier Lumo, the count from runs
/// of the same millisecond.
pub fn run_mark() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    format!("{:x}-{}", now_ms(), NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst))
}

/// Where an agent stands. Done, failed and stopped are final: an agent in one
/// of them never changes again.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    /// At work.
    Working,
    /// Waiting for something outside it: `waiting_for` says what.
    Waiting,
    /// Finished its task.
    Done,
    /// Ended with an error, or its CLI ended under it.
    Failed,
    /// Stopped by the user, or by the CLI that started it.
    Stopped,
}

impl AgentState {
    pub fn is_final(self) -> bool {
        matches!(self, AgentState::Done | AgentState::Failed | AgentState::Stopped)
    }
}

/// One agent a chat's answer started: what `chat-agent` carries.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRow {
    /// The agent's id in its CLI (Claude Code's task id, Codex's thread id…),
    /// unique in the chat.
    pub id: String,
    /// The provider that runs it (a providers.ts id: claude-code, codex, antigravity-cli, cursor…).
    pub source: String,
    /// Its task, as the CLI described it ("Transcribe L03–L04"), cut short.
    pub title: String,
    pub state: AgentState,
    /// With `Waiting`: "permission" (a card waits for the user) or "rate_limit".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub waiting_for: Option<&'static str>,
    /// What it is doing now (its last tool call), worded by the island as the typing line is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub now: Option<Activity>,
    /// The CLI's own one-line account of its progress, when it gives one (Claude Code's progress summaries).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// How many tool calls it made so far.
    pub steps: u64,
    /// How many tokens it used so far, when the CLI says.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<u64>,
    /// Epoch ms: when it started, and when Lumo last heard of it.
    pub started_at: u64,
    pub last_signal_at: u64,
    /// Epoch ms, once final.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    /// Why it failed, or what its CLI said when it ended, cut short.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// It goes on after the turn that started it (a background agent).
    pub background: bool,
    /// The island may stop this one agent alone (`chat_stop_agent`).
    pub can_stop: bool,
    /// Its CLI can pass it a message from the chat (Claude Code's SendMessage):
    /// the island offers Ask on it.
    pub can_ask: bool,
    /// How many times it was taken up again after it ended (a message sent
    /// to it resumes it): a row of a later round replaces the ended one.
    pub round: u32,
    /// The last message its CLI sent it, and its answer once it came.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub talk: Option<AgentTalk>,
    /// With `Waiting` for "queue": its place in line (a local model's agents run one at a time).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue: Option<u32>,
}

/// A message the chat's CLI sent one of its agents (Claude Code's SendMessage),
/// and the agent's answer: the island's "Talking to …" box.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTalk {
    /// The tool call that sent it: one box per call.
    pub call: String,
    pub message: String,
    /// Epoch ms.
    pub sent_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replied_at: Option<u64>,
    /// Why it did not reach the agent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed: Option<String>,
}

impl AgentTalk {
    pub fn new(call: &str, message: &str) -> Self {
        AgentTalk { call: call.to_string(), message: talk_text(message), sent_at: now_ms(), reply: None, replied_at: None, failed: None }
    }

    /// Neither answered nor failed yet.
    pub fn pending(&self) -> bool {
        self.reply.is_none() && self.failed.is_none()
    }

    /// The agent's answer: the first one only.
    pub fn answer(&mut self, text: &str) {
        if self.pending() && !text.trim().is_empty() {
            self.reply = Some(talk_text(text));
            self.replied_at = Some(now_ms());
        }
    }
}

/// The longest a message or an answer goes to the "Talking to …" box.
const MAX_TALK: usize = 1500;

/// `text` for the "Talking to …" box: its lines kept, cut short.
pub fn talk_text(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= MAX_TALK {
        return text.to_string();
    }
    let cut: String = text.chars().take(MAX_TALK - 1).collect();
    format!("{}…", cut.trim_end())
}

impl AgentRow {
    /// A new agent, at work from now.
    pub fn new(id: impl Into<String>, source: &str, title: &str) -> Self {
        let now = now_ms();
        AgentRow {
            id: id.into(),
            source: source.to_string(),
            title: crate::claude_code::short(title),
            state: AgentState::Working,
            waiting_for: None,
            now: None,
            summary: None,
            steps: 0,
            tokens: None,
            started_at: now,
            last_signal_at: now,
            ended_at: None,
            error: None,
            background: false,
            can_stop: false,
            can_ask: false,
            round: 0,
            talk: None,
            queue: None,
        }
    }

    /// A message sent to it after it ended took it up again: at work, in a new round.
    pub fn reopen(&mut self) {
        if !self.state.is_final() {
            return;
        }
        self.round += 1;
        self.state = AgentState::Working;
        self.waiting_for = None;
        self.now = None;
        self.ended_at = None;
        self.error = None;
        self.heard();
    }

    /// Lumo heard of it just now.
    pub fn heard(&mut self) {
        self.last_signal_at = now_ms();
    }

    /// It ended, as `state` says; nothing changes once it has.
    pub fn end(&mut self, state: AgentState, error: Option<String>) {
        if self.state.is_final() {
            return;
        }
        let now = now_ms();
        self.state = state;
        self.waiting_for = None;
        self.queue = None;
        self.now = None;
        self.ended_at = Some(now);
        self.last_signal_at = now;
        if let Some(error) = error.map(|e| crate::claude_code::short(&e)).filter(|e| !e.is_empty()) {
            self.error = Some(error);
        }
    }
}

/// The longest a summary goes to the island: an agent's last message can be
/// pages long, and the card shows a line or two of it.
const MAX_SUMMARY: usize = 240;

/// `text` as an agent's summary: on one line, cut short.
pub fn summary_of(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= MAX_SUMMARY {
        return line;
    }
    let cut: String = line.chars().take(MAX_SUMMARY - 1).collect();
    format!("{}…", cut.trim_end())
}

/// The agents of one chat's CLI, by id, in the order they started: what each
/// provider keeps while it reads its CLI's output. `changed` hands back the
/// rows that changed since it was last asked, to be sent.
#[derive(Default, Debug)]
pub struct Agents {
    rows: Vec<AgentRow>,
    dirty: Vec<String>,
}

impl Agents {
    pub fn get(&self, id: &str) -> Option<&AgentRow> {
        self.rows.iter().find(|r| r.id == id)
    }

    /// The agent `id`, made with `make` the first time it is heard of. Marked
    /// changed and heard of: whatever the caller does with it is news.
    pub fn upsert(&mut self, id: &str, make: impl FnOnce() -> AgentRow) -> &mut AgentRow {
        if !self.dirty.iter().any(|d| d == id) {
            self.dirty.push(id.to_string());
        }
        let pos = match self.rows.iter().position(|r| r.id == id) {
            Some(pos) => pos,
            None => {
                self.rows.push(make());
                self.rows.len() - 1
            }
        };
        let row = &mut self.rows[pos];
        row.heard();
        row
    }

    /// The agent `id`, if it is known, marked changed.
    pub fn touch(&mut self, id: &str) -> Option<&mut AgentRow> {
        let pos = self.rows.iter().position(|r| r.id == id)?;
        if !self.dirty.iter().any(|d| d == id) {
            self.dirty.push(id.to_string());
        }
        let row = &mut self.rows[pos];
        row.heard();
        Some(row)
    }

    /// The agents still at work (or waiting).
    pub fn open(&self) -> usize {
        self.rows.iter().filter(|r| !r.state.is_final()).count()
    }

    /// Every agent still open ends as `state` (its CLI ended under it).
    pub fn end_open(&mut self, state: AgentState, error: &str) {
        let ids: Vec<String> = self.rows.iter().filter(|r| !r.state.is_final()).map(|r| r.id.clone()).collect();
        for id in ids {
            if let Some(row) = self.touch(&id) {
                row.end(state, Some(error.to_string()));
            }
        }
    }

    /// The agents' ids, in the order they started.
    pub fn ids(&self) -> impl Iterator<Item = String> + '_ {
        self.rows.iter().map(|r| r.id.clone())
    }

    /// The rows changed since the last call, in the order they started.
    pub fn changed(&mut self) -> Vec<AgentRow> {
        if self.dirty.is_empty() {
            return Vec::new();
        }
        let dirty = std::mem::take(&mut self.dirty);
        self.rows.iter().filter(|r| dirty.contains(&r.id)).cloned().collect()
    }
}

/// Tells the island about one agent of the chat `chat`.
pub fn emit_agent(app: &AppHandle, chat: &str, row: &AgentRow) {
    let _ = app.emit_to(WINDOW_LABEL, "chat-agent", json!({ "chat": chat, "agent": row }));
}

/// Tells the island about every agent that changed.
pub fn emit_changed(app: &AppHandle, chat: &str, agents: &mut Agents) {
    for row in agents.changed() {
        emit_agent(app, chat, &row);
    }
}

/// What a provider reading its CLI calls after each line it read, on
/// whichever thread reads it: the agents that changed go to the island, and,
/// with `true`, a sign of life. A provider keeps its `Agents` where its CLI
/// lives, and a `Tell` with them for when the CLI ends on another thread.
pub type Tell = Arc<dyn Fn(&mut Agents, bool) + Send + Sync>;

/// The `Tell` of the chat `chat`.
pub fn teller(app: &AppHandle, chat: &str) -> Tell {
    let app = app.clone();
    let events = crate::chat::ChatEvents::new(chat);
    Arc::new(move |agents: &mut Agents, alive: bool| {
        if alive {
            events.signal(&app);
        }
        events.agents(&app, agents);
    })
}

/// A `Tell` that tells nobody: a run with no chat (Lumo's supervisor, a
/// task from Gemini Live), or a test. What changed is still taken, so it
/// never piles up.
pub fn silent() -> Tell {
    Arc::new(|agents: &mut Agents, _| {
        agents.changed();
    })
}

/// The sign of life goes at most this often per chat.
const SIGNAL_INTERVAL: Duration = Duration::from_secs(1);

/// When each chat's sign of life last went.
static SIGNALS: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

/// True when a sign of life for `chat` may go now (one a second at most).
fn signal_due(chat: &str) -> bool {
    let mut all = SIGNALS.lock().unwrap_or_else(|e| e.into_inner());
    let all = all.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    match all.get(chat) {
        Some(last) if now.duration_since(*last) < SIGNAL_INTERVAL => false,
        _ => {
            // A chat that ended long ago is forgotten, so the map stays small.
            all.retain(|_, at| now.duration_since(*at) < Duration::from_secs(600));
            all.insert(chat.to_string(), now);
            true
        }
    }
}

/// The chat `chat`'s answer moved just now: a piece of text, a tool call
/// starting or ending, a retry, a line of a CLI's output. Cheap to call on
/// every chunk: it goes at most once a second.
pub fn signal(app: &AppHandle, chat: &str) {
    if chat.is_empty() || !signal_due(chat) {
        return;
    }
    let _ = app.emit_to(WINDOW_LABEL, "chat-signal", json!({ "chat": chat, "at": now_ms() }));
}

/// How often work that tells nothing until it ends (a whole answer, a tool
/// call, a model's load) says the chat is alive while it runs.
pub const HEARTBEAT: Duration = Duration::from_secs(10);

/// `work`, with a sign of life for the chat `chat` every HEARTBEAT while it
/// runs: it is working, not stuck, and the island must not say "no signal".
/// The timer lives only as long as `work`, which ends by itself (its own
/// timeout, the user's Stop). `work` comes boxed (`Box::pin`): a call or a
/// request is a large future, and held here by value it made the chat's
/// whole answer twice as large, past what the debug build's stack holds.
pub async fn alive_while<T>(app: &AppHandle, chat: &str, mut work: impl std::future::Future<Output = T> + Unpin) -> T {
    loop {
        match tokio::time::timeout(HEARTBEAT, &mut work).await {
            Ok(done) => return done,
            Err(_) => signal(app, chat),
        }
    }
}

/// The chat `chat`'s answer waits for the user (`Some("permission")`: a card
/// is up) or stops waiting (`None`). Always sent, never held back: while it
/// waits, the island says so instead of "no signal".
pub fn signal_waiting(app: &AppHandle, chat: &str, waiting: Option<&str>) {
    if chat.is_empty() {
        return;
    }
    let _ = app.emit_to(WINDOW_LABEL, "chat-signal", json!({ "chat": chat, "at": now_ms(), "waiting": waiting }));
}

// ── Stopping one agent ────────────────────────────────────────────────────────

/// What stops one agent of a chat's CLI: Claude Code's `stop_task`, written
/// on its stdin. Each provider that can registers one per chat while its CLI
/// runs, and takes it away when the CLI ends.
pub type StopAgent = Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

/// Each chat's stopper, with the number it was registered under.
static STOPPERS: Mutex<Option<HashMap<String, (u64, StopAgent)>>> = Mutex::new(None);
static NEXT_STOPPER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// The chat `chat`'s CLI can stop one of its agents with `stop` from now on.
/// The number it gives is for `forget_stopper_of`.
pub fn register_stopper(chat: &str, stop: StopAgent) -> u64 {
    let n = NEXT_STOPPER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let mut all = STOPPERS.lock().unwrap_or_else(|e| e.into_inner());
    all.get_or_insert_with(HashMap::new).insert(chat.to_string(), (n, stop));
    n
}

/// The chat `chat`'s CLI ended: none of its agents can be stopped any more.
/// (The CLIs that stop agents today use `forget_stopper_of`.)
#[allow(dead_code)]
pub fn forget_stopper(chat: &str) {
    let mut all = STOPPERS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(all) = all.as_mut() {
        all.remove(chat);
    }
}

/// `forget_stopper`, only while the chat's stopper is still the one
/// registered as `n`: a CLI ended on another thread after the chat started a
/// new one never takes the new one's away.
pub fn forget_stopper_of(chat: &str, n: u64) {
    let mut all = STOPPERS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(all) = all.as_mut() {
        if all.get(chat).is_some_and(|(have, _)| *have == n) {
            all.remove(chat);
        }
    }
}

/// Stops the agent `agent` of the chat `chat`, if its CLI can.
pub fn stop(chat: &str, agent: &str) -> Result<(), String> {
    let all = STOPPERS.lock().unwrap_or_else(|e| e.into_inner());
    match all.as_ref().and_then(|all| all.get(chat)) {
        Some((_, stop)) => stop(agent),
        None => Err("This agent can't be stopped on its own.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_agent_is_sent_once_for_each_batch_of_changes_and_never_changes_once_ended() {
        let mut agents = Agents::default();
        agents.upsert("a1", || AgentRow::new("a1", "claude-code", "Transcribe L03"));
        agents.upsert("a1", || unreachable!()).steps += 1;
        agents.upsert("a2", || AgentRow::new("a2", "claude-code", "Transcribe L05"));
        let sent = agents.changed();
        assert_eq!(sent.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), ["a1", "a2"]);
        assert_eq!(sent[0].steps, 1);
        assert!(agents.changed().is_empty(), "nothing new, nothing sent");
        assert_eq!(agents.open(), 2);

        agents.touch("a1").unwrap().end(AgentState::Done, None);
        agents.touch("a1").unwrap().end(AgentState::Failed, Some("late".into()));
        let a1 = agents.get("a1").unwrap();
        assert_eq!(a1.state, AgentState::Done);
        assert!(a1.error.is_none() && a1.ended_at.is_some());
        assert!(agents.touch("missing").is_none());

        agents.end_open(AgentState::Failed, "Claude Code ended");
        let sent = agents.changed();
        assert_eq!(sent.len(), 2, "a1 (touched) and a2 (ended)");
        assert_eq!(agents.get("a2").unwrap().state, AgentState::Failed);
        assert_eq!(agents.get("a2").unwrap().error.as_deref(), Some("Claude Code ended"));
        assert_eq!(agents.open(), 0);
    }

    #[test]
    fn a_row_goes_to_the_island_in_its_shape() {
        let mut row = AgentRow::new("t1", "claude-code", "Transcribe   L03–L04\n");
        row.now = Some(Activity::new("read", "pag-037.png"));
        row.background = true;
        let v = serde_json::to_value(&row).unwrap();
        assert_eq!(v["title"], "Transcribe L03–L04");
        assert_eq!(v["state"], "working");
        assert_eq!(v["now"]["kind"], "read");
        assert_eq!(v["background"], true);
        assert!(v.get("startedAt").is_some() && v.get("lastSignalAt").is_some());
        assert!(v.get("waitingFor").is_none() && v.get("endedAt").is_none());
    }

    #[test]
    fn a_message_to_an_agent_and_its_round_go_to_the_island_and_it_is_taken_up_once_ended() {
        let mut row = AgentRow::new("t1", "claude-code", "Count");
        let v = serde_json::to_value(&row).unwrap();
        assert_eq!((v["canAsk"].as_bool(), v["round"].as_u64()), (Some(false), Some(0)));
        assert!(v.get("talk").is_none());
        // Not ended: nothing to take up.
        row.reopen();
        assert_eq!(row.round, 0);
        row.end(AgentState::Done, None);
        row.talk = Some(AgentTalk::new("toolu_S", "  What step?\nReply.  "));
        row.reopen();
        assert_eq!((row.state, row.round, row.ended_at), (AgentState::Working, 1, None));
        let talk = row.talk.as_mut().unwrap();
        assert_eq!(talk.message, "What step?\nReply.");
        talk.answer("Step 1.");
        talk.answer("Step 2.");
        assert_eq!(talk.reply.as_deref(), Some("Step 1."), "the first answer only");
        let v = serde_json::to_value(&row).unwrap();
        assert_eq!(v["talk"]["call"], "toolu_S");
        assert_eq!(v["talk"]["reply"], "Step 1.");
        assert!(v["talk"].get("sentAt").is_some() && v["talk"].get("failed").is_none());
        let long = "x".repeat(MAX_TALK + 10);
        assert_eq!(talk_text(&long).chars().count(), MAX_TALK);
    }

    #[test]
    fn the_sign_of_life_goes_once_a_second_per_chat() {
        assert!(signal_due("chat-signal-test-a"));
        assert!(!signal_due("chat-signal-test-a"));
        assert!(signal_due("chat-signal-test-b"));
    }

    #[test]
    fn an_agent_is_stopped_through_its_chats_cli_only() {
        assert!(stop("chat-stop-test", "a1").is_err());
        register_stopper("chat-stop-test", Box::new(|id| if id == "a1" { Ok(()) } else { Err("unknown".into()) }));
        assert!(stop("chat-stop-test", "a1").is_ok());
        assert!(stop("chat-stop-test", "a2").is_err());
        forget_stopper("chat-stop-test");
        assert!(stop("chat-stop-test", "a1").is_err());

        // A CLI that ended late never takes away the stopper of the one after it.
        let old = register_stopper("chat-stop-test-2", Box::new(|_| Err("old".into())));
        let new = register_stopper("chat-stop-test-2", Box::new(|_| Ok(())));
        forget_stopper_of("chat-stop-test-2", old);
        assert!(stop("chat-stop-test-2", "a1").is_ok());
        forget_stopper_of("chat-stop-test-2", new);
        assert!(stop("chat-stop-test-2", "a1").is_err());
    }

    #[test]
    fn a_summary_is_one_short_line() {
        assert_eq!(summary_of("  Done:\n 52 pages   transcribed. "), "Done: 52 pages transcribed.");
        let long = summary_of(&"word ".repeat(200));
        assert_eq!(long.chars().count(), MAX_SUMMARY);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn each_run_has_a_mark_of_its_own() {
        assert_ne!(run_mark(), run_mark());
    }

    #[test]
    fn a_silent_tell_takes_what_changed_all_the_same() {
        let mut agents = Agents::default();
        agents.upsert("a1", || AgentRow::new("a1", "codex", "x"));
        silent()(&mut agents, true);
        assert!(agents.changed().is_empty());
    }
}
