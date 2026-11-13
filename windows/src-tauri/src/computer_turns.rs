// One agent at a time on the computer (computer.rs).
//
// The island chat's Claude Code and the agents it starts share one screen
// and one mouse. Before each of Lumo's computer tools runs, the chat's own
// PreToolUse hook (claude_code.rs chat_settings, lumo-hook --computer-turn)
// asks here for the turn, with the agent that calls (Claude Code's
// `agent_id`, "main" for the conversation itself):
// * nobody holds the computer, or the caller does: it goes on (and Claude
//   Code's own permission card still asks for the click: nothing is allowed
//   here);
// * someone else holds it: the caller waits in line, a while at most
//   (QUEUE_WAIT), then is told its place and to try again; it keeps that
//   place while it does (WAITER_GRACE).
// The holder keeps the computer until it ends (its row is final, or the
// turn is over), or until it has left it unused for HOLDER_IDLE with
// someone waiting; "Give it the turn" on a waiting row puts it first in line.
// Esc empties the line: every waiter is told at once that the user stopped
// the computer.
//
// The island sees the line as `computer-turns` (the holder and each waiter's
// place and since when), sent only when it changes: nothing runs on a timer.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

/// The conversation itself, not one of its agents.
pub const MAIN: &str = "main";
/// How long a caller waits in line in one go: the relay gives up a little
/// later (lumo-hook COMPUTER_TURN_BUDGET), and Claude Code's hook timeout
/// later still (claude_code.rs).
pub const QUEUE_WAIT: Duration = Duration::from_secs(90);
/// The holder that left the computer unused this long, with someone
/// waiting and no card up for it, passes the turn.
const HOLDER_IDLE_MS: u64 = 20_000;
/// A waiter told to try again keeps its place this long.
const WAITER_GRACE_MS: u64 = 30_000;
/// How often a waiting connection looks again when nothing wakes it.
const LOOK_AGAIN: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
struct Holder {
    chat: String,
    agent: String,
    since: u64,
    active: u64,
    calls: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Waiter {
    chat: String,
    agent: String,
    since: u64,
    asked: u64,
}

/// What a caller is told.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ask {
    Go,
    /// Its place in line (1 is next) and how many wait.
    Wait { place: usize, of: usize },
}

/// The line, as the island draws it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnsView {
    pub holder: Option<HolderView>,
    pub waiting: Vec<WaiterView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HolderView {
    pub chat: String,
    pub agent: String,
    pub since_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaiterView {
    pub chat: String,
    pub agent: String,
    pub since_ms: u64,
    pub place: usize,
}

/// The line itself: pure, the clock given, so the tests drive it.
#[derive(Debug, Default)]
pub struct Turns {
    holder: Option<Holder>,
    waiting: Vec<Waiter>,
}

impl Turns {
    fn holds(&self, chat: &str, agent: &str) -> bool {
        self.holder.as_ref().is_some_and(|h| h.chat == chat && h.agent == agent)
    }

    fn place(&self, chat: &str, agent: &str) -> Option<usize> {
        self.waiting.iter().position(|w| w.chat == chat && w.agent == agent)
    }

    /// `agent` of `chat` asks for the computer at `now`.
    pub fn ask(&mut self, chat: &str, agent: &str, now: u64) -> Ask {
        if self.holds(chat, agent) {
            if let Some(h) = self.holder.as_mut() {
                h.active = now;
            }
            return Ask::Go;
        }
        let at = match self.place(chat, agent) {
            Some(i) => {
                self.waiting[i].asked = now;
                i
            }
            None => {
                self.waiting.push(Waiter { chat: chat.into(), agent: agent.into(), since: now, asked: now });
                self.waiting.len() - 1
            }
        };
        // Free, and first in line: its turn.
        if self.holder.is_none() && at == 0 {
            let w = self.waiting.remove(0);
            self.holder = Some(Holder { chat: w.chat, agent: w.agent, since: now, active: now, calls: 0 });
            return Ask::Go;
        }
        Ask::Wait { place: at + 1, of: self.waiting.len() }
    }

    /// The holder that left the computer unused for HOLDER_IDLE, with someone
    /// waiting, no call running and no card up (`cards`): the turn passes.
    pub fn pass_if_due(&mut self, now: u64, cards: bool) -> bool {
        let due = self.holder.as_ref().is_some_and(|h| h.calls == 0 && now.saturating_sub(h.active) >= HOLDER_IDLE_MS);
        if due && !cards && !self.waiting.is_empty() {
            self.holder = None;
            return true;
        }
        false
    }

    /// Waiters that stopped asking a while ago (they gave up) leave the line.
    pub fn expire(&mut self, now: u64) -> bool {
        let before = self.waiting.len();
        self.waiting.retain(|w| now.saturating_sub(w.asked) < WAITER_GRACE_MS);
        self.waiting.len() != before
    }

    /// The agents of `chat` still open are `ids`: those that ended leave the
    /// line, and hand the computer on if they had it. The conversation itself
    /// leaves only with its turn (`turn_end`).
    pub fn agents_open(&mut self, chat: &str, ids: &[String]) -> bool {
        let ended = |c: &str, a: &str| c == chat && a != MAIN && !ids.iter().any(|i| i == a);
        let before = self.waiting.len();
        self.waiting.retain(|w| !ended(&w.chat, &w.agent));
        let mut changed = self.waiting.len() != before;
        if self.holder.as_ref().is_some_and(|h| ended(&h.chat, &h.agent)) {
            self.holder = None;
            changed = true;
        }
        changed
    }

    /// The turn of `chat` is over: the computer is no longer its, nor its agents'.
    pub fn turn_end(&mut self, chat: &str) -> bool {
        let before = self.waiting.len();
        self.waiting.retain(|w| w.chat != chat);
        let mut changed = self.waiting.len() != before;
        if self.holder.as_ref().is_some_and(|h| h.chat == chat) {
            self.holder = None;
            changed = true;
        }
        changed
    }

    /// "Give it the turn": first in line.
    pub fn put_first(&mut self, chat: &str, agent: &str) -> bool {
        match self.place(chat, agent) {
            Some(0) | None => false,
            Some(i) => {
                let w = self.waiting.remove(i);
                self.waiting.insert(0, w);
                true
            }
        }
    }

    /// A call of the holder starts (computer.rs serve): it is using it.
    pub fn call_start(&mut self, now: u64) {
        if let Some(h) = self.holder.as_mut() {
            h.calls += 1;
            h.active = now;
        }
    }

    pub fn call_done(&mut self, now: u64) {
        if let Some(h) = self.holder.as_mut() {
            h.calls = h.calls.saturating_sub(1);
            h.active = now;
        }
    }

    /// A card came or went: the holder waiting on the user's click is using
    /// the computer, and once answered has HOLDER_IDLE again for the call it
    /// was allowed to reach it.
    pub fn touch(&mut self, now: u64) {
        if let Some(h) = self.holder.as_mut() {
            h.active = h.active.max(now);
        }
    }

    /// Esc: nobody has the computer, nobody waits.
    pub fn clear(&mut self) -> bool {
        let changed = self.holder.is_some() || !self.waiting.is_empty();
        self.holder = None;
        self.waiting.clear();
        changed
    }

    /// Someone other than the holder is waiting: a call with no turn is refused.
    pub fn busy(&self) -> bool {
        self.holder.is_some() || !self.waiting.is_empty()
    }

    pub fn view(&self) -> TurnsView {
        TurnsView {
            holder: self.holder.as_ref().map(|h| HolderView { chat: h.chat.clone(), agent: h.agent.clone(), since_ms: h.since }),
            waiting: self
                .waiting
                .iter()
                .enumerate()
                .map(|(i, w)| WaiterView { chat: w.chat.clone(), agent: w.agent.clone(), since_ms: w.since, place: i + 1 })
                .collect(),
        }
    }
}

// ── The app's one line ──────────────────────────────────────────────────────

static TURNS: Mutex<Turns> = Mutex::new(Turns { holder: None, waiting: Vec::new() });
/// What the island was last told.
static SHOWN: Mutex<Option<TurnsView>> = Mutex::new(None);
/// Wakes the connections waiting in line when the line changes.
static CHANGED: tokio::sync::Notify = tokio::sync::Notify::const_new();

fn now_ms() -> u64 {
    crate::chat_agents::now_ms()
}

/// `f` on the line; when it says the line changed, the waiters look again
/// and the island is told.
fn with<R: Runtime, T>(app: &AppHandle<R>, f: impl FnOnce(&mut Turns) -> (T, bool)) -> T {
    let (out, changed, view) = {
        let mut turns = TURNS.lock().unwrap_or_else(|e| e.into_inner());
        let (out, changed) = f(&mut turns);
        (out, changed, turns.view())
    };
    if changed {
        CHANGED.notify_waiters();
    }
    show(app, view);
    out
}

/// Tells the island the line, when it differs from what it was told.
fn show<R: Runtime>(app: &AppHandle<R>, view: TurnsView) {
    let mut shown = SHOWN.lock().unwrap_or_else(|e| e.into_inner());
    if shown.as_ref() == Some(&view) || (shown.is_none() && view == TurnsView::default()) {
        return;
    }
    let _ = app.emit_to(crate::island::WINDOW_LABEL, "computer-turns", &view);
    *shown = Some(view);
}

/// How a wait in line ended: the relay's answer line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Waited {
    Go,
    Wait { place: usize, of: usize },
    /// The user pressed Esc.
    Stopped,
    /// No turn with the computer is running: the call's own refusal speaks.
    Closed,
}

impl Waited {
    pub fn line(&self) -> String {
        match self {
            Waited::Go => "go".into(),
            Waited::Wait { place, of } => format!("wait {place} {of}"),
            Waited::Stopped => "stopped".into(),
            Waited::Closed => "closed".into(),
        }
    }
}

/// `agent` of `chat` waits for the computer, QUEUE_WAIT at most. `open`
/// says whether a turn with the computer still runs and whether Esc stopped
/// it (computer.rs); `cards`, whether a card waits on the island.
pub async fn wait_turn<R: Runtime>(
    app: &AppHandle<R>,
    chat: &str,
    agent: &str,
    open: impl Fn() -> Option<bool>,
    cards: impl Fn() -> bool,
) -> Waited {
    let deadline = tokio::time::Instant::now() + QUEUE_WAIT;
    loop {
        match open() {
            None => return Waited::Closed,
            Some(true) => return Waited::Stopped,
            Some(false) => {}
        }
        // Asked for before looking, so a change between the look and the wait still wakes it.
        let changed = CHANGED.notified();
        let now = now_ms();
        let ask = with(app, |t| {
            let mut changed = t.expire(now);
            changed |= t.pass_if_due(now, cards());
            let before = t.view();
            let ask = t.ask(chat, agent, now);
            (ask, changed || t.view() != before)
        });
        let Ask::Wait { place, of } = ask else { return Waited::Go };
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            return Waited::Wait { place, of };
        }
        let _ = tokio::time::timeout(left.min(LOOK_AGAIN), changed).await;
    }
}

/// The agents of `chat` still open (chat_agents.rs, on each change): those
/// that ended leave the line. Only a look while nobody uses the computer.
pub fn agents_open<R: Runtime>(app: &AppHandle<R>, chat: &str, ids: &[String]) {
    {
        let turns = TURNS.lock().unwrap_or_else(|e| e.into_inner());
        if !turns.busy() {
            return;
        }
    }
    with(app, |t| ((), t.agents_open(chat, ids)));
}

pub fn turn_end<R: Runtime>(app: &AppHandle<R>, chat: &str) {
    with(app, |t| ((), t.turn_end(chat)));
}

pub fn put_first<R: Runtime>(app: &AppHandle<R>, chat: &str, agent: &str) {
    with(app, |t| ((), t.put_first(chat, agent)));
}

pub fn clear<R: Runtime>(app: &AppHandle<R>) {
    with(app, |t| ((), t.clear()));
}

/// A call that passed the gate starts: the holder is using the computer.
/// False when the line is busy and nobody holds it (the call skipped the gate).
pub fn call_start() -> bool {
    let mut turns = TURNS.lock().unwrap_or_else(|e| e.into_inner());
    if turns.holder.is_none() && !turns.waiting.is_empty() {
        return false;
    }
    turns.call_start(now_ms());
    true
}

pub fn call_done() {
    TURNS.lock().unwrap_or_else(|e| e.into_inner()).call_done(now_ms());
    CHANGED.notify_waiters();
}

/// A card came or went: a holder waiting on the user keeps its turn.
pub fn cards_changed() {
    CHANGED.notify_waiters();
}

/// The card of a computer tool was answered: the holder, which waited on it,
/// keeps the computer a while from the click, for the call it was allowed.
/// Before the card leaves the count (computer.rs card_down), so no waiter
/// takes the turn in between. Any other card leaves the holder's time alone.
pub fn card_answered() {
    TURNS.lock().unwrap_or_else(|e| e.into_inner()).touch(now_ms());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(id: &str) -> String {
        id.to_string()
    }

    #[test]
    fn the_first_gets_the_computer_and_the_others_wait_in_order() {
        let mut t = Turns::default();
        assert_eq!(t.ask("c", MAIN, 0), Ask::Go);
        assert_eq!(t.ask("c", "a1", 10), Ask::Wait { place: 1, of: 1 });
        assert_eq!(t.ask("c", "a2", 20), Ask::Wait { place: 2, of: 2 });
        // Asking again keeps the place, and when it first asked.
        assert_eq!(t.ask("c", "a1", 30), Ask::Wait { place: 1, of: 2 });
        assert_eq!(t.view().waiting[0].since_ms, 10);
        // The holder again: on it goes.
        assert_eq!(t.ask("c", MAIN, 40), Ask::Go);
        let v = t.view();
        assert_eq!(v.holder.as_ref().map(|h| h.agent.as_str()), Some(MAIN));
        assert_eq!(v.waiting.iter().map(|w| (w.agent.as_str(), w.place)).collect::<Vec<_>>(), [("a1", 1), ("a2", 2)]);
    }

    #[test]
    fn the_turn_passes_when_the_holder_ends_or_leaves_it_unused() {
        let mut t = Turns::default();
        t.ask("c", "a1", 0);
        t.ask("c", "a2", 0);
        t.ask("c", "a3", 0);
        // Using it: it keeps it, however long a call takes.
        t.call_start(1_000);
        assert!(!t.pass_if_due(60_000, false));
        t.call_done(60_000);
        assert!(!t.pass_if_due(70_000, false), "not yet unused long enough");
        // A card waits for the user's click: it keeps it.
        assert!(!t.pass_if_due(90_000, true));
        assert!(t.pass_if_due(90_000, false));
        // Free: only the first in line gets it.
        assert_eq!(t.ask("c", "a3", 90_001), Ask::Wait { place: 2, of: 2 });
        assert_eq!(t.ask("c", "a2", 90_002), Ask::Go);
        // a2 ends: the next one's turn.
        assert!(t.agents_open("c", &[s("a3")]));
        assert_eq!(t.ask("c", "a3", 90_003), Ask::Go);
        // Nobody waits: an idle holder keeps it.
        assert!(!t.pass_if_due(500_000, false));
    }

    #[test]
    fn a_holder_answered_on_its_card_keeps_the_turn_for_the_call_it_was_allowed() {
        let mut t = Turns::default();
        assert_eq!(t.ask("c", MAIN, 0), Ask::Go);
        t.ask("c", "a1", 0);
        // Its card stays up 25 s: it keeps it.
        assert!(!t.pass_if_due(25_000, true));
        // The click: the card goes, the holder is fresh again.
        t.touch(25_000);
        assert!(!t.pass_if_due(25_001, false));
        assert_eq!(t.ask("c", "a1", 25_002), Ask::Wait { place: 1, of: 1 });
        // The allowed call arrives and ends: then, unused, it passes.
        t.call_start(26_000);
        t.call_done(27_000);
        assert!(!t.pass_if_due(40_000, false));
        assert!(t.pass_if_due(47_000, false));
        assert_eq!(t.ask("c", "a1", 47_001), Ask::Go);
    }

    #[test]
    fn ended_agents_leave_the_line_and_the_conversation_only_with_its_turn() {
        let mut t = Turns::default();
        t.ask("c", MAIN, 0);
        t.ask("c", "a1", 0);
        t.ask("d", "b1", 0);
        assert!(t.agents_open("c", &[]));
        assert_eq!(t.view().waiting.iter().map(|w| w.agent.as_str()).collect::<Vec<_>>(), ["b1"], "another chat's stays");
        assert!(t.view().holder.is_some(), "the conversation holds it still");
        assert!(t.turn_end("c"));
        assert!(t.view().holder.is_none());
        assert_eq!(t.ask("d", "b1", 1), Ask::Go);
        assert!(!t.turn_end("c"), "nothing of it left");
    }

    #[test]
    fn give_it_the_turn_puts_it_first_and_esc_empties_the_line() {
        let mut t = Turns::default();
        t.ask("c", MAIN, 0);
        t.ask("c", "a1", 0);
        t.ask("c", "a2", 0);
        assert!(t.put_first("c", "a2"));
        assert_eq!(t.view().waiting.iter().map(|w| (w.agent.as_str(), w.place)).collect::<Vec<_>>(), [("a2", 1), ("a1", 2)]);
        assert!(!t.put_first("c", "a2"), "already first");
        assert!(!t.put_first("c", "zz"));
        assert_eq!(t.view().holder.map(|h| h.agent), Some(s(MAIN)), "the holder keeps it until it passes");
        assert!(t.busy());
        assert!(t.clear());
        assert_eq!(t.view(), TurnsView::default());
        assert!(!t.busy());
    }

    #[test]
    fn a_waiter_that_stopped_asking_leaves_the_line() {
        let mut t = Turns::default();
        t.ask("c", MAIN, 0);
        t.ask("c", "a1", 0);
        t.ask("c", "a2", 20_000);
        assert!(!t.expire(25_000));
        assert!(t.expire(31_000));
        assert_eq!(t.view().waiting.iter().map(|w| (w.agent.as_str(), w.place)).collect::<Vec<_>>(), [("a2", 1)]);
    }

    #[test]
    fn the_island_reads_the_line_in_camel_case() {
        let mut t = Turns::default();
        t.ask("c", "a1", 5);
        t.ask("c", "a2", 7);
        let v = serde_json::to_value(t.view()).unwrap();
        assert_eq!(v["holder"], serde_json::json!({ "chat": "c", "agent": "a1", "sinceMs": 5 }));
        assert_eq!(v["waiting"][0], serde_json::json!({ "chat": "c", "agent": "a2", "sinceMs": 7, "place": 1 }));
    }

    #[test]
    fn the_relay_reads_one_word_and_the_place() {
        assert_eq!(Waited::Go.line(), "go");
        assert_eq!(Waited::Wait { place: 2, of: 3 }.line(), "wait 2 3");
        assert_eq!(Waited::Stopped.line(), "stopped");
        assert_eq!(Waited::Closed.line(), "closed");
    }
}
