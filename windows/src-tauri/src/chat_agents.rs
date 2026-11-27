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
use serde_json::{json, Value};
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
    /// With `Waiting`: "permission" (a card waits for the user), "rate_limit", "queue", "paused" or "retry" (its CLI tries an API request again).
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
    /// With `Waiting` for "queue": its place in line (a local model's agents run as many at once as its server's slots).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue: Option<u32>,
    /// What ended it under its work: "cli" when its CLI ended while it was
    /// still at work (`Agents::end_open`). The island offers Resume for those,
    /// read from this field, never from the words of `error`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_by: Option<&'static str>,
    /// The row of the agent that started this one, when an agent started it
    /// (an Antigravity CLI subagent's own subagents): the island draws it
    /// under that one (concepts/agy-sotto-agenti-annidati).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    /// Its own plan, when it wrote one (its TodoWrite, its update_plan): the
    /// island shows how far along it is (concepts/piano-dei-sotto-agenti).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<Vec<PlanStep>>,
    /// The user stopped it and its CLI was asked to: it is stopping until the
    /// CLI says it stopped (concepts/sotto-agenti-completo, "Lo sto fermando").
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub stopping: bool,
    /// It finished but its CLI says it wrote no report (Claude Code's
    /// `summary_is_report: false`): the island says so, with its last progress
    /// line, never its task said again (concepts/sotto-agenti-completo).
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub no_report: bool,
    /// The commands it left running in the background (Claude Code's
    /// `local_bash` tasks it owns), while they run: its opened row lists them
    /// ("In sfondo", concepts/sotto-agenti-completo/6-riga-aperta).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub commands: Vec<BackgroundCommand>,
    /// The command it waits on now (Claude Code's `local_bash` task of its
    /// own, in the foreground), while it runs: a long silence is that
    /// command at work, not the agent stuck (concepts/segnale-agenti).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running: Option<BackgroundCommand>,
    /// With `Waiting` for "retry": its CLI tries its request again after an
    /// API error (Claude Code's `subagent_retry`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry: Option<AgentRetry>,
    /// Whether a tool call of its waits for its result, when its CLI tells
    /// (Claude Code): silent with none, it is writing (its answer, a long file).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_call: Option<bool>,
    /// Its CLI says it is alive every few seconds, apart from its agents
    /// (Claude Code's `keep_alive` and heartbeats): with no word from it at
    /// all for long, the island says the CLI no longer answers.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub heartbeat: bool,
}

/// An agent's request tried again after an API error, as its CLI says.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRetry {
    /// This try, of `max`.
    pub attempt: u64,
    pub max: u64,
    /// How long its CLI waits before it, from `at` (epoch ms).
    pub delay_ms: u64,
    pub at: u64,
    /// The API's HTTP status (529 overloaded, 429 rate limit…), when given.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u64>,
    /// Its CLI's kind of error, when given.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

/// A command an agent left running in the background.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundCommand {
    /// Its task id in its CLI.
    pub id: String,
    /// The command, or what its CLI calls it, cut short.
    pub text: String,
    /// Epoch ms: when Lumo first saw it running.
    pub since: u64,
}

/// One step of an agent's plan, as src/core/agent-plan.ts has them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PlanStep {
    pub text: String,
    /// "pending", "active", "done" or "skipped".
    pub status: &'static str,
}

/// Steps kept of an agent's plan (agent-plan.ts MAX_STEPS).
const MAX_PLAN_STEPS: usize = 40;
/// Longest step text kept.
const MAX_STEP_TEXT: usize = 200;

/// Where a step stands, whatever the tool calls it (agent-plan.ts stepStatus).
pub fn step_status(raw: &str) -> &'static str {
    let s = raw.trim().to_ascii_lowercase().replace([' ', '-'], "_");
    match s.as_str() {
        "completed" | "complete" | "done" | "finished" | "success" => "done",
        "in_progress" | "inprogress" | "active" | "running" | "doing" | "current" => "active",
        "cancelled" | "canceled" | "skipped" | "deleted" | "removed" | "abandoned" => "skipped",
        _ => "pending",
    }
}

/// A step's text, on one line, cut short; None when there is none.
pub fn step_text(raw: &str) -> Option<String> {
    let line = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() {
        return None;
    }
    if line.chars().count() <= MAX_STEP_TEXT {
        return Some(line);
    }
    let cut: String = line.chars().take(MAX_STEP_TEXT - 1).collect();
    Some(format!("{}…", cut.trim_end()))
}

/// The plan a call of Lumo's update_plan (`{"plan": [{step, status}]}`) or of
/// Claude Code's TodoWrite (`{"todos": [{content, status}]}`) gives: None when
/// it gives no step. `input` may be the object or its JSON text.
pub fn plan_of(input: &Value) -> Option<Vec<PlanStep>> {
    let parsed;
    let input = match input {
        Value::String(text) => {
            parsed = serde_json::from_str::<Value>(text).ok()?;
            &parsed
        }
        other => other,
    };
    let list = input.get("plan").or_else(|| input.get("todos")).or_else(|| input.get("steps")).and_then(Value::as_array)?;
    let steps: Vec<PlanStep> = list
        .iter()
        .filter_map(|item| {
            let text = ["step", "content", "text", "subject", "title"].iter().filter_map(|k| item[*k].as_str()).find(|t| !t.trim().is_empty())?;
            Some(PlanStep { text: step_text(text)?, status: step_status(item["status"].as_str().unwrap_or("")) })
        })
        .take(MAX_PLAN_STEPS)
        .collect();
    (!steps.is_empty()).then_some(steps)
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
    /// The agent was stopped before it answered: no answer will come.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub stopped: bool,
}

impl AgentTalk {
    pub fn new(call: &str, message: &str) -> Self {
        AgentTalk { call: call.to_string(), message: talk_text(message), sent_at: now_ms(), reply: None, replied_at: None, failed: None, stopped: false }
    }

    /// Neither answered nor failed yet, and its agent not stopped.
    pub fn pending(&self) -> bool {
        self.reply.is_none() && self.failed.is_none() && !self.stopped
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
            ended_by: None,
            parent: None,
            plan: None,
            stopping: false,
            no_report: false,
            commands: Vec::new(),
            running: None,
            retry: None,
            in_call: None,
            heartbeat: false,
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
        self.ended_by = None;
        self.stopping = false;
        self.no_report = false;
        self.running = None;
        self.retry = None;
        self.heard();
    }

    /// What it waited for is over: at work again.
    pub fn back_at_work(&mut self) {
        self.state = AgentState::Working;
        self.waiting_for = None;
        self.retry = None;
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
        self.stopping = false;
        self.running = None;
        self.retry = None;
        self.in_call = None;
        self.ended_at = Some(now);
        self.last_signal_at = now;
        // Stopped: a message it was asked will never be answered.
        if let Some(talk) = self.talk.as_mut().filter(|t| state == AgentState::Stopped && t.pending()) {
            talk.stopped = true;
        }
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
    /// Lumo's browser calls the agents made, as the CLI's stream told them,
    /// not passed on yet: agent, tool, input (browser.rs agent_called).
    browsed: Vec<(String, &'static str, Value)>,
}

impl Agents {
    /// Agent `id` called Lumo's browser tool `tool` with `input`: the tab it
    /// opens or uses is its own (`teller` passes it on).
    pub fn browsed(&mut self, id: &str, tool: &'static str, input: Value) {
        // A handful at most between two tells.
        if self.browsed.len() < 64 {
            self.browsed.push((id.to_string(), tool, input));
        }
    }

    /// The browser calls not passed on yet.
    pub fn take_browsed(&mut self) -> Vec<(String, &'static str, Value)> {
        std::mem::take(&mut self.browsed)
    }

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

    /// The agent `id`, if it is known, marked changed but not heard of:
    /// what changes is about its CLI, not news of the agent's own.
    pub fn mark(&mut self, id: &str) -> Option<&mut AgentRow> {
        let pos = self.rows.iter().position(|r| r.id == id)?;
        if !self.dirty.iter().any(|d| d == id) {
            self.dirty.push(id.to_string());
        }
        Some(&mut self.rows[pos])
    }

    /// The agents still at work (or waiting).
    pub fn open(&self) -> usize {
        self.rows.iter().filter(|r| !r.state.is_final()).count()
    }

    /// The ids of the agents still open, in the order they started.
    pub fn open_ids(&self) -> Vec<String> {
        self.rows.iter().filter(|r| !r.state.is_final()).map(|r| r.id.clone()).collect()
    }

    /// Every agent still open ends as `state` (its CLI ended under it):
    /// failed ones say so in `ended_by`, for the island's Resume.
    pub fn end_open(&mut self, state: AgentState, error: &str) {
        let ids: Vec<String> = self.rows.iter().filter(|r| !r.state.is_final()).map(|r| r.id.clone()).collect();
        for id in ids {
            if let Some(row) = self.touch(&id) {
                row.end(state, Some(error.to_string()));
                if state == AgentState::Failed {
                    row.ended_by = Some("cli");
                }
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

/// The agents still open of each provider in a chat (each provider's
/// `teller`), by chat: Claude Code's agents left at work in the background
/// and those an API model starts next in the same chat keep their tabs and
/// their place in line for the computer, each set its own.
type OpenSets = HashMap<String, HashMap<String, Vec<String>>>;
static OPEN_SETS: Mutex<Option<OpenSets>> = Mutex::new(None);

/// What a chat's turn lent its agents at work after the answer (the
/// computer, the email tools), by chat: each goes (is dropped) when the last
/// of the chat's agents ends. Locked after OPEN_SETS, never before.
type Kept = HashMap<String, Vec<Box<dyn std::any::Any + Send>>>;
static KEPT: Mutex<Option<Kept>> = Mutex::new(None);

/// The provider `source` has `open` agents in chat `chat` now: those of all
/// the chat's providers. None left: what the chat's turns lent them goes.
fn open_in_chat(chat: &str, source: &str, open: Vec<String>) -> Vec<String> {
    let mut all = OPEN_SETS.lock().unwrap_or_else(|e| e.into_inner());
    let sets = all.get_or_insert_with(HashMap::new).entry(chat.to_string()).or_default();
    if open.is_empty() {
        sets.remove(source);
    } else {
        sets.insert(source.to_string(), open);
    }
    let union: Vec<String> = sets.values().flatten().cloned().collect();
    let mut gone = Vec::new();
    if sets.is_empty() {
        all.as_mut().map(|a| a.remove(chat));
        gone = KEPT.lock().unwrap_or_else(|e| e.into_inner()).as_mut().and_then(|k| k.remove(chat)).unwrap_or_default();
    }
    // Let go with no lock held: ending the computer's turn tells the island.
    drop(all);
    drop(gone);
    union
}

/// `lent` (what a chat's turn gives its agents: the computer's turn, the
/// email tools) lives on while agents of the chat `chat` are at work after
/// the answer, and goes when the last of them ends. None at work: it is
/// given back, for the turn to end it now.
pub fn keep_while_agents<T: Send + 'static>(chat: &str, lent: T) -> Result<(), T> {
    let all = OPEN_SETS.lock().unwrap_or_else(|e| e.into_inner());
    if !all.as_ref().is_some_and(|a| a.contains_key(chat)) {
        return Err(lent);
    }
    KEPT.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).entry(chat.to_string()).or_default().push(Box::new(lent));
    Ok(())
}

/// The `Tell` of the provider `source`'s agents in the chat `chat`.
pub fn teller(app: &AppHandle, chat: &str, source: &str) -> Tell {
    let app = app.clone();
    let chat = chat.to_string();
    let source = source.to_string();
    let events = crate::chat::ChatEvents::new(&chat);
    Arc::new(move |agents: &mut Agents, alive: bool| {
        if alive {
            events.signal(&app);
        }
        // The tabs its agents opened or use are theirs, before those of the
        // agents that ended close.
        for (agent, tool, input) in agents.take_browsed() {
            crate::browser::agent_called(&app, &chat, &agent, tool, &input);
        }
        // An agent that ended waits for the computer no more, nor keeps it,
        // and its browser tabs close.
        let open = open_in_chat(&chat, &source, agents.open_ids());
        crate::computer_turns::agents_open(&app, &chat, &open);
        crate::browser::agents_open(&app, &chat, &open);
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
/// Its agents (api_agents.rs) may have several cards up at once: it waits
/// until the last one is answered.
pub fn signal_waiting(app: &AppHandle, chat: &str, waiting: Option<&str>) {
    if chat.is_empty() {
        return;
    }
    let still = {
        let mut open = OPEN_CARDS.lock().unwrap_or_else(|e| e.into_inner());
        cards_open(open.get_or_insert_with(HashMap::new), chat, waiting.is_some())
    };
    let waiting = if still { waiting.or(Some("permission")) } else { None };
    // A member of an orchestra waits for the user meanwhile (orchestra.rs).
    crate::orchestra::waiting(app, chat, waiting.is_some());
    let _ = app.emit_to(WINDOW_LABEL, "chat-signal", json!({ "chat": chat, "at": now_ms(), "waiting": waiting }));
}

/// The cards up for each chat's answer (signal_waiting).
static OPEN_CARDS: Mutex<Option<HashMap<String, usize>>> = Mutex::new(None);

/// One card of `chat` comes up (`up`) or goes: whether some are still up.
fn cards_open(open: &mut HashMap<String, usize>, chat: &str, up: bool) -> bool {
    let n = open.get(chat).copied().unwrap_or(0);
    let n = if up { n + 1 } else { n.saturating_sub(1) };
    if n == 0 {
        open.remove(chat);
    } else {
        open.insert(chat.to_string(), n);
    }
    n > 0
}

// ── A CLI started again under its agents ──────────────────────────────────────
//
// A chat's CLI lives between two turns, and so do the agents it started in
// the background. A message with another model, effort, permission mode,
// folder or set of tools needs a new CLI, and ending the old one ends them.
// That message is not sent while agents are at work: its turn fails with
// WOULD_STOP and the number of agents, and the island asks the user (wait
// for them, or send now and stop them: `allow_restart`).

/// What a turn fails with when it would end agents at work: then their number.
pub const WOULD_STOP: &str = "lumo-agents-would-stop:";

/// The error a turn ends with when starting its CLI again would end `open` agents.
pub fn would_stop(open: usize) -> String {
    format!("{WOULD_STOP}{open}")
}

/// The chats whose next message may start their CLI again all the same, and since when.
static RESTART_OK: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

/// How long the user's "send now" holds: the message goes at once, so a
/// stale one never ends agents without asking.
const RESTART_OK_FOR: Duration = Duration::from_secs(120);

/// The user said to send now: the chat's next message may end its agents.
pub fn allow_restart(chat: &str) {
    let mut all = RESTART_OK.lock().unwrap_or_else(|e| e.into_inner());
    all.get_or_insert_with(HashMap::new).insert(chat.to_string(), Instant::now());
}

/// Whether the chat's CLI may be started again under its agents: once, and
/// only shortly after the user said so.
pub fn restart_allowed(chat: &str) -> bool {
    let mut all = RESTART_OK.lock().unwrap_or_else(|e| e.into_inner());
    all.as_mut().and_then(|all| all.remove(chat)).is_some_and(|at| at.elapsed() < RESTART_OK_FOR)
}

/// `Some(open)` when a chat's CLI that answers with another key would end
/// `open` agents at work, unless the user allowed it (taken then).
pub fn in_the_way(chat: &str, open: usize) -> Option<usize> {
    (open > 0 && !restart_allowed(chat)).then_some(open)
}

// ── Stopping one agent ────────────────────────────────────────────────────────

/// What stops one agent of a chat's CLI: Claude Code's `stop_task`, written
/// on its stdin. Each provider that can registers one per chat while its CLI
/// runs, and takes it away when the CLI ends.
pub type StopAgent = Box<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

/// Each chat's stoppers, one per provider (its `source`), with the number
/// each was registered under, oldest first: Claude Code's agents left at work
/// in the background stay stoppable while another provider answers the chat.
type Stoppers = HashMap<String, Vec<(u64, String, StopAgent)>>;
static STOPPERS: Mutex<Option<Stoppers>> = Mutex::new(None);
static NEXT_STOPPER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

/// The chat `chat`'s CLI (the provider `source`) can stop one of its agents
/// with `stop` from now on, in place of that provider's stopper before. The
/// number it gives is for `forget_stopper_of`.
pub fn register_stopper(chat: &str, source: &str, stop: StopAgent) -> u64 {
    let n = NEXT_STOPPER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let mut all = STOPPERS.lock().unwrap_or_else(|e| e.into_inner());
    let list = all.get_or_insert_with(HashMap::new).entry(chat.to_string()).or_default();
    list.retain(|(_, s, _)| s != source);
    list.push((n, source.to_string(), stop));
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

/// The stopper registered as `n` goes, and only it: a CLI ended on another
/// thread after the chat started a new one never takes the new one's away,
/// nor another provider's.
pub fn forget_stopper_of(chat: &str, n: u64) {
    let mut all = STOPPERS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(all) = all.as_mut() {
        if let Some(list) = all.get_mut(chat) {
            list.retain(|(have, _, _)| *have != n);
            if list.is_empty() {
                all.remove(chat);
            }
        }
    }
}

/// Stops the agent `agent` of the chat `chat`, if its CLI can: the stopper of
/// the provider that runs it (`source`, its row's), else the newest.
pub fn stop(chat: &str, agent: &str, source: Option<&str>) -> Result<(), String> {
    let all = STOPPERS.lock().unwrap_or_else(|e| e.into_inner());
    let list = all.as_ref().and_then(|all| all.get(chat));
    let found = match source {
        Some(source) => list.and_then(|l| l.iter().rev().find(|(_, s, _)| s == source)),
        None => list.and_then(|l| l.last()),
    };
    match found {
        Some((_, _, stop)) => stop(agent),
        None => Err("This agent can't be stopped on its own.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plan_is_read_from_update_plan_or_todo_write_whatever_their_words() {
        let plan = plan_of(&json!({ "plan": [{ "step": "Read", "status": "completed" }, { "step": "Write", "status": "in_progress" }, { "step": " ", "status": "pending" }, { "step": "Check", "status": "cancelled" }] })).unwrap();
        assert_eq!(plan.iter().map(|s| (s.text.as_str(), s.status)).collect::<Vec<_>>(), [("Read", "done"), ("Write", "active"), ("Check", "skipped")]);
        // As its JSON text too (a transcript's argument), and TodoWrite's shape.
        let text = json!(r#"{"todos":[{"content":"One","status":"pending"}]}"#);
        assert_eq!(plan_of(&text).unwrap(), vec![PlanStep { text: "One".into(), status: "pending" }]);
        assert_eq!(plan_of(&json!({ "plan": [] })), None);
        assert_eq!(plan_of(&json!({ "nothing": 1 })), None);
        let long = "x".repeat(500);
        assert_eq!(plan_of(&json!({ "plan": [{ "step": long, "status": "pending" }] })).unwrap()[0].text.chars().count(), 200);
    }

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
    fn each_set_of_a_chats_agents_keeps_its_own_open() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(open_in_chat("sets-test", "claude-code", s(&["cc1", "cc2"])), s(&["cc1", "cc2"]));
        // Another provider's agents in the same chat: the first set's stay open.
        let mut both = open_in_chat("sets-test", "anthropic", s(&["api1"]));
        both.sort();
        assert_eq!(both, s(&["api1", "cc1", "cc2"]));
        // That set's agents end: only its own go.
        let mut left = open_in_chat("sets-test", "anthropic", Vec::new());
        left.sort();
        assert_eq!(left, s(&["cc1", "cc2"]));
        assert_eq!(open_in_chat("sets-test", "claude-code", Vec::new()), Vec::<String>::new());
        assert!(OPEN_SETS.lock().unwrap().as_ref().unwrap().get("sets-test").is_none(), "nothing kept");
        assert_eq!(open_in_chat("sets-other", "codex", s(&["x"])), s(&["x"]), "chats apart");
        open_in_chat("sets-other", "codex", Vec::new());
    }

    #[test]
    fn what_a_turn_lends_its_agents_goes_when_the_last_of_the_chat_ends() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static GONE: AtomicUsize = AtomicUsize::new(0);
        struct Lent;
        impl Drop for Lent {
            fn drop(&mut self) {
                GONE.fetch_add(1, Ordering::SeqCst);
            }
        }
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        // No agent at work: given back, for the turn to end it now.
        let back = keep_while_agents("lend-test", Lent);
        assert!(back.is_err());
        drop(back);
        assert_eq!(GONE.load(Ordering::SeqCst), 1);

        open_in_chat("lend-test", "claude-code", s(&["a1", "a2"]));
        open_in_chat("lend-test", "anthropic", s(&["b1"]));
        assert!(keep_while_agents("lend-test", Lent).is_ok());
        assert!(keep_while_agents("lend-test", Lent).is_ok(), "the next turn's too");
        assert!(keep_while_agents("lend-other", Lent).is_err(), "another chat's agents lend nothing");
        assert_eq!(GONE.load(Ordering::SeqCst), 2);
        open_in_chat("lend-test", "claude-code", s(&["a2"]));
        open_in_chat("lend-test", "claude-code", Vec::new());
        assert_eq!(GONE.load(Ordering::SeqCst), 2, "another provider's agent still works");
        open_in_chat("lend-test", "anthropic", Vec::new());
        assert_eq!(GONE.load(Ordering::SeqCst), 4, "the last one ended: both go");
    }

    #[test]
    fn an_agent_is_stopped_through_its_chats_cli_only() {
        assert!(stop("chat-stop-test", "a1", None).is_err());
        register_stopper("chat-stop-test", "claude-code", Box::new(|id| if id == "a1" { Ok(()) } else { Err("unknown".into()) }));
        assert!(stop("chat-stop-test", "a1", None).is_ok());
        assert!(stop("chat-stop-test", "a2", None).is_err());
        forget_stopper("chat-stop-test");
        assert!(stop("chat-stop-test", "a1", None).is_err());

        // A CLI that ended late never takes away the stopper of the one after it.
        let old = register_stopper("chat-stop-test-2", "claude-code", Box::new(|_| Err("old".into())));
        let new = register_stopper("chat-stop-test-2", "claude-code", Box::new(|_| Ok(())));
        forget_stopper_of("chat-stop-test-2", old);
        assert!(stop("chat-stop-test-2", "a1", None).is_ok());
        forget_stopper_of("chat-stop-test-2", new);
        assert!(stop("chat-stop-test-2", "a1", None).is_err());
    }

    #[test]
    fn another_provider_answering_the_chat_never_takes_the_stopper_of_agents_still_at_work() {
        // Claude Code's agents in the background, then an API model's run_agents in the same chat.
        let _claude_code = register_stopper("chat-stop-test-3", "claude-code", Box::new(|id| if id == "cc-agent" { Ok(()) } else { Err("unknown".into()) }));
        let api_run = register_stopper("chat-stop-test-3", "anthropic", Box::new(|id| if id == "api-1" { Ok(()) } else { Err("unknown".into()) }));
        assert!(stop("chat-stop-test-3", "api-1", Some("anthropic")).is_ok());
        assert!(stop("chat-stop-test-3", "cc-agent", Some("claude-code")).is_ok(), "each by its own provider's");
        forget_stopper_of("chat-stop-test-3", api_run);
        assert!(stop("chat-stop-test-3", "cc-agent", Some("claude-code")).is_ok(), "the run that ended takes only its own");
        assert!(stop("chat-stop-test-3", "cc-agent", None).is_ok());
        assert!(stop("chat-stop-test-3", "api-1", Some("anthropic")).is_err());
        forget_stopper("chat-stop-test-3");
    }

    #[test]
    fn a_summary_is_one_short_line() {
        assert_eq!(summary_of("  Done:\n 52 pages   transcribed. "), "Done: 52 pages transcribed.");
        let long = summary_of(&"word ".repeat(200));
        assert_eq!(long.chars().count(), MAX_SUMMARY);
        assert!(long.ends_with('…'));
    }

    #[test]
    fn an_agent_its_cli_ended_under_says_so_and_one_taken_up_again_no_more() {
        let mut agents = Agents::default();
        agents.upsert("a1", || AgentRow::new("a1", "claude-code", "x"));
        agents.upsert("a2", || AgentRow::new("a2", "claude-code", "y"));
        agents.touch("a2").unwrap().end(AgentState::Done, None);
        agents.end_open(AgentState::Failed, "Claude Code ended");
        assert_eq!(agents.get("a1").unwrap().ended_by, Some("cli"));
        assert_eq!(agents.get("a2").unwrap().ended_by, None, "it had finished");
        assert_eq!(serde_json::to_value(agents.get("a1").unwrap()).unwrap()["endedBy"], "cli");
        let mut stopped = Agents::default();
        stopped.upsert("s", || AgentRow::new("s", "claude-code", "x"));
        stopped.end_open(AgentState::Stopped, "");
        assert_eq!(stopped.get("s").unwrap().ended_by, None, "the user's Stop");
        let mut row = agents.get("a1").unwrap().clone();
        row.reopen();
        assert_eq!(row.ended_by, None);
    }

    #[test]
    fn a_cli_is_started_again_under_its_agents_only_once_the_user_said_so() {
        assert_eq!(in_the_way("restart-test", 0), None, "no agent at work");
        assert_eq!(in_the_way("restart-test", 3), Some(3));
        assert!(would_stop(3).starts_with(WOULD_STOP) && would_stop(3).ends_with('3'));
        allow_restart("restart-test");
        assert_eq!(in_the_way("restart-test", 3), None, "send now");
        assert_eq!(in_the_way("restart-test", 3), Some(3), "once");
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

    #[test]
    fn a_chat_waits_until_the_last_of_its_cards_is_answered() {
        let mut open = HashMap::new();
        assert!(cards_open(&mut open, "c", true));
        assert!(cards_open(&mut open, "c", true), "two agents, two cards");
        assert!(cards_open(&mut open, "d", true));
        assert!(cards_open(&mut open, "c", false), "one still up");
        assert!(!cards_open(&mut open, "c", false));
        assert!(!cards_open(&mut open, "c", false), "never below none");
        assert!(!cards_open(&mut open, "d", false) && open.is_empty());
    }
}
