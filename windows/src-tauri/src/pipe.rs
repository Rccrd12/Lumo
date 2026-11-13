// Relay server for lumo-hook.
//
// The named pipe `\\.\pipe\lumo-<sid>`, one instance per connection. Every
// hook event is forwarded to the island as a `hook` event. `PermissionRequest`
// is the only one that keeps its connection open: it waits for the island's
// decision and writes it back on the same connection, which is how approving
// from the island works.
//
// Only this account can open the pipe (its access list, platform::
// relay_pipe_attributes), and a connection known to come from another account
// is dropped unheard.
//
// Claude Code is never blocked by us. Three things guarantee it:
//   * lumo-hook gives the connection 300 ms and exits cleanly if we are closed;
//   * we only wait for a human once the island has *confirmed* the card is on
//     screen, so a paused island or a webview that is not listening costs a few
//     hundred milliseconds, not two minutes;
//   * whatever happens we drop the connection after the decision timeout, and
//     the terminal takes over.
//
// What we write back is the bare word `allow`, `always` or `deny` — or, when the request
// was Claude Code asking a question, `{"answers":{…}}` with what was picked on
// the island. Turning either into the documented hookSpecificOutput JSON is
// lumo-hook's job, so the wire format Claude Code expects lives in exactly
// one place.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::mpsc;

use crate::island::WINDOW_LABEL;
use crate::log;
use crate::session_window;

/// Slightly under lumo-hook's own 110 s wait, so we always answer first.
const DECISION_TIMEOUT: Duration = Duration::from_secs(108);
/// An email's card waits longer: its fields can be changed before Send
/// (mail.rs deliver). lumo-hook's MAIL_SEND_BUDGET counts on it.
pub const MAIL_CARD_TIMEOUT: Duration = Duration::from_secs(300);
/// How long the island gets to say "the card is up". This is the whole of B4:
/// without it, an island that is paused, hidden behind a crashed webview or
/// simply not listening would leave Claude Code staring at a prompt nobody can
/// see for nearly two minutes.
const ACK_TIMEOUT: Duration = Duration::from_millis(800);
const MAX_PAYLOAD: usize = 1 << 20;
/// How long to wait before making a fresh pipe instance again after a failure.
const REOPEN_RETRY: Duration = Duration::from_secs(1);

/// What the island can say about a permission request.
pub enum Reply {
    /// The card is on screen and a human can act on it.
    Ack,
    /// A human clicked: `allow` or `deny`.
    Decision(String),
    /// Nobody can act on it — paused, or another request already holds the card.
    Decline,
}

/// Permission requests the island has been told about.
#[derive(Default)]
pub struct Pending(pub Mutex<HashMap<String, mpsc::Sender<Reply>>>);

static COUNTER: AtomicU64 = AtomicU64::new(1);

tokio::task_local! {
    /// The island chat whose tool call is running (tools.rs `call_for_chat`
    /// sets it for the call): a card raised during the call (`ask`: a tool's
    /// Allow / Deny, a web search, an email to send) puts that chat in
    /// "waiting for your permission" while it is up, not "no signal".
    pub static CHAT: String;
}

/// Requests of the island chat's own Antigravity CLI run: the only ones Auto
/// may allow without a click (src/island/hooks.ts). Kept here so a
/// mistake in the page can never allow a Claude Code or Codex request.
static AUTO_ALLOWABLE: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn with_auto_allowable<T>(f: impl FnOnce(&mut HashSet<String>) -> T) -> T {
    f(AUTO_ALLOWABLE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashSet::new))
}

/// The cards of an email Lumo itself is about to send (mail.rs deliver): the
/// only ones whose Send may carry the email as the user changed it on the
/// card (`answer_mail`). Never an agent's request through the relay.
static MAIL_CARDS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn with_mail_cards<T>(f: impl FnOnce(&mut HashSet<String>) -> T) -> T {
    f(MAIL_CARDS.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashSet::new))
}

/// `\\.\pipe\lumo-<sid>` — must match lumo-hook's `pipe_path()` exactly.
pub fn pipe_name() -> String {
    let key = crate::platform::current_user_sid()
        .unwrap_or_else(|| std::env::var("USERNAME").unwrap_or_else(|_| "user".into()));
    format!(r"\\.\pipe\lumo-{key}")
}

pub fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let name = pipe_name();
        // first_pipe_instance also means we refuse to join a pipe somebody else
        // already owns under our name, rather than serving on top of it.
        let mut server = match create_instance(&name, true) {
            Ok(s) => s,
            Err(err) => {
                log::line(format!("cannot open the relay pipe: {err}"));
                return;
            }
        };
        loop {
            if server.connect().await.is_err() {
                // A relay that came and went before it was taken (ERROR_NO_DATA)
                // leaves the instance broken until it is disconnected: every
                // later connect on it would fail too.
                let _ = server.disconnect();
                tokio::time::sleep(Duration::from_millis(200)).await;
                continue;
            }
            // Hand the connected instance to a task and listen on a fresh one.
            // A fresh instance that cannot be made now is tried again: giving
            // up would leave every hook unheard until Lumo restarts.
            let mut failed = false;
            let next = loop {
                match create_instance(&name, false) {
                    Ok(s) => break s,
                    Err(err) => {
                        if !std::mem::replace(&mut failed, true) {
                            log::line(format!("cannot reopen the relay pipe: {err} (trying again)"));
                        }
                        tokio::time::sleep(REOPEN_RETRY).await;
                    }
                }
            };
            let connected = std::mem::replace(&mut server, next);
            let app = app.clone();
            tauri::async_runtime::spawn(async move { handle(app, connected).await });
        }
    });
}

/// A pipe instance only this account can open (platform::relay_pipe_attributes),
/// or one with the default security if that cannot be made.
fn create_instance(name: &str, first: bool) -> std::io::Result<NamedPipeServer> {
    let mut options = ServerOptions::new();
    options.first_pipe_instance(first);
    match crate::platform::relay_pipe_attributes() {
        // SAFETY: a SECURITY_ATTRIBUTES made once and never freed.
        Some(attributes) => unsafe { options.create_with_security_attributes_raw(name, attributes as *mut std::ffi::c_void) },
        None => options.create(name),
    }
}

/// One accepted relay connection, whatever carries it.
trait Relay: AsyncRead + AsyncWrite + Unpin {
    /// Ends the conversation once everything has been written.
    fn finish(&mut self) {}
    /// The relay process on the other end, where the OS says.
    fn client_pid(&self) -> Option<u32> {
        None
    }
    /// False only when the process on the other end is known to run as
    /// another account. One that cannot be read (an elevated relay) passes:
    /// the pipe's access list already let only this account in.
    fn client_is_ours(&self) -> bool {
        true
    }
}

impl Relay for NamedPipeServer {
    fn finish(&mut self) {
        let _ = self.disconnect();
    }
    fn client_pid(&self) -> Option<u32> {
        use std::os::windows::io::AsRawHandle;
        crate::platform::pipe_client_pid(self.as_raw_handle())
    }
    fn client_is_ours(&self) -> bool {
        use std::os::windows::io::AsRawHandle;
        match crate::platform::pipe_client_sid(self.as_raw_handle()) {
            Some(theirs) => crate::platform::current_user_sid().is_some_and(|mine| mine == theirs),
            None => true,
        }
    }
}

async fn handle(app: AppHandle, mut pipe: impl Relay) {
    // Another account's process on our pipe gets nothing, and is heard from in nothing.
    if !pipe.client_is_ours() {
        log::line("relay connection from another account refused");
        pipe.finish();
        return;
    }
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.contains(&b'\n') || buf.len() > MAX_PAYLOAD {
                    break;
                }
            }
            Err(_) => return,
        }
    }
    let line = match buf.iter().position(|b| *b == b'\n') {
        Some(i) => &buf[..i],
        None => &buf[..],
    };
    let Ok(mut payload) = serde_json::from_slice::<Value>(line) else { return };
    // A tool call of the chat's computer use, of Lumo's email tools, of its
    // plan tool, of the island's timer and GitHub tools or of the user's own
    // tools (lumo-hook --mcp): one answer line.
    let answer = if let Some(request) = payload.get("lumo_computer") {
        Some(crate::computer::serve(&app, request).await)
    } else if let Some(request) = payload.get("lumo_mail") {
        Some(in_chat(&app, request, crate::mail::serve(&app, request)).await)
    } else if let Some(request) = payload.get("lumo_tool") {
        Some(in_chat(&app, request, crate::tools::serve_call(&app, request)).await)
    } else if payload.get("lumo_tools").is_some() {
        Some(crate::tools::serve_list())
    } else if let Some(request) = payload.get("lumo_island").filter(|r| r.is_object()) {
        // An object: a hook event of the island's own chat carries
        // `"lumo_island": true` instead, and goes on below as an event.
        Some(crate::island_tools::serve(request))
    } else {
        payload.get("lumo_plan").map(|request| crate::antigravity_cli::serve_plan(&app, request))
    };
    if let Some(answer) = answer {
        let _ = pipe.write_all(format!("{answer}\n").as_bytes()).await;
        let _ = pipe.flush().await;
        // A screenshot is bigger than the pipe's buffer, and disconnecting
        // drops what the relay has not read yet: it closes its end once it has
        // the whole line.
        let _ = tokio::time::timeout(Duration::from_secs(10), async {
            let mut rest = [0u8; 64];
            while let Ok(n) = pipe.read(&mut rest).await {
                if n == 0 {
                    break;
                }
            }
        })
        .await;
        pipe.finish();
        return;
    }
    crate::migrate::payload(&mut payload);
    if !payload.is_object() {
        return;
    }

    let event = payload
        .get("hook_event_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    note_session_window(&pipe, &payload, &event);
    crate::listen_events::heard_hook(&app, &event, &payload);
    // Counts for the weekly recap — never the command, path or prompt itself.
    crate::recap::observe(&app, &payload);

    if event == "SessionEnd" {
        crate::session_rules::session_ended(&payload);
    }
    if event != "PermissionRequest" {
        // The status line relay calls in with every Claude Code update: not log-worthy.
        if event != "StatusLine" {
            log::line(format!("hook {event}"));
        }
        let _ = app.emit_to(WINDOW_LABEL, "hook", payload);
        pipe.finish();
        return;
    }

    let (id, mut rx) = pending_request(&app);
    crate::recap::note_request(&app, &id, &payload);
    // Allowed for this session already ("Allow for this session"): no card.
    if crate::session_rules::arrive(&id, &payload) {
        app.state::<Pending>().0.lock().unwrap().remove(&id);
        log::line(format!("hook PermissionRequest id={id} allowed for this session"));
        crate::recap::record_decision(&app, &id, "always");
        let _ = pipe.write_all(b"always\n").await;
        let _ = pipe.flush().await;
        pipe.finish();
        return;
    }
    // The card offers "Allow for this session" only where it can be kept.
    if crate::session_rules::can_remember(&id) {
        payload["lumo_session_allow"] = json!(true);
    }
    let island_agy = payload.get("lumo_island") == Some(&json!(true))
        && payload.get("lumo_agent").and_then(Value::as_str) == Some("antigravity");
    if island_agy {
        with_auto_allowable(|set| set.insert(id.clone()));
    }
    payload["request_id"] = json!(id);
    let payload_cut = payload.get("lumo_input_cut") == Some(&json!(true));
    log::line(format!("hook PermissionRequest id={id}"));
    let tool_name = payload.get("tool_name").and_then(Value::as_str).map(str::to_string);
    let tool_input = payload.get("tool_input").cloned().unwrap_or(Value::Null);
    let _ = app.emit_to(WINDOW_LABEL, "hook", payload);

    // While Claude uses the computer, the hand gets its mouse back to answer.
    crate::computer::card_up(&app);
    // Answered in the terminal (or in the Claude app) instead: Claude Code ends
    // the relay, its end of the connection closes, and the island drops the
    // card at once rather than keep offering a question already settled.
    let decided = async { Some(wait_for_decision(&id, &mut rx, DECISION_TIMEOUT).await) };
    let gone = async {
        client_gone(&mut pipe).await;
        None
    };
    let decision = match first_of(decided, gone).await {
        Some(d) => d,
        None => {
            log::line(format!("hook id={id} answered elsewhere"));
            let _ = app.emit_to(WINDOW_LABEL, "hook-settled", id.clone());
            None
        }
    };
    crate::computer::card_down(&app);
    // A request the relay had to cut (lumo_input_cut) was never on the card
    // whole: nothing allows it from here, whatever came back. The agent asks
    // in its own terminal instead, as if Lumo were closed.
    let cut = payload_cut;
    let decision = match decision {
        Some(d) if cut && matches!(d.trim(), "allow" | "always" | "edits") => {
            log::line(format!("hook id={id} allow refused: the request was cut"));
            None
        }
        other => other,
    };
    app.state::<Pending>().0.lock().unwrap().remove(&id);
    with_auto_allowable(|set| set.remove(&id));
    crate::session_rules::answered(&id, decision.as_deref().unwrap_or(""));

    // Allowed on the card for one of the user's tools: that click is the one
    // its call needs (tools.rs), not a second card.
    if matches!(decision.as_deref(), Some("allow" | "always" | "edits")) {
        if let Some(tool) = &tool_name {
            crate::tools::note_allowed(tool, &tool_input);
        }
    }
    // No decision: say nothing at all. lumo-hook then writes nothing to stdout
    // and Claude Code asks in the terminal, exactly as if Lumo were closed.
    if let Some(d) = decision {
        let _ = pipe.write_all(format!("{d}\n").as_bytes()).await;
        let _ = pipe.flush().await;
    }
    pipe.finish();
}

/// `work`, a call lumo-hook --mcp makes for a CLI that answers in the
/// island's chat `request["chat"]` (its LUMO_CHAT_ID): run as that chat's
/// own (tools.rs `call_for_chat`), a card it raises puts the chat in
/// "waiting for your permission", and it says the chat is alive while it
/// runs (the CLI writes nothing meanwhile). A call that names no chat (a CLI
/// in the user's terminal, a lumo-hook from before) just runs.
async fn in_chat<T>(app: &AppHandle, request: &Value, work: impl std::future::Future<Output = T>) -> T {
    match request.get("chat").and_then(Value::as_str).filter(|c| !c.is_empty()) {
        Some(chat) => crate::chat_agents::alive_while(app, chat, CHAT.scope(chat.to_string(), work)).await,
        None => work.await,
    }
}

/// Resolves once the relay has gone (end of stream or a broken pipe). It sends
/// nothing after its one line, so any read result means it is done.
async fn client_gone(pipe: &mut impl Relay) {
    let mut probe = [0u8; 64];
    loop {
        match pipe.read(&mut probe).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

/// Whichever of two futures finishes first; `a` when both are ready.
async fn first_of<T>(a: impl std::future::Future<Output = T>, b: impl std::future::Future<Output = T>) -> T {
    use std::task::Poll;
    let mut a = std::pin::pin!(a);
    let mut b = std::pin::pin!(b);
    std::future::poll_fn(|cx| {
        if let Poll::Ready(v) = a.as_mut().poll(cx) {
            return Poll::Ready(v);
        }
        b.as_mut().poll(cx)
    })
    .await
}

/// A new request id, waiting for the island's replies.
fn pending_request(app: &AppHandle) -> (String, mpsc::Receiver<Reply>) {
    let id = format!("{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed));
    let (tx, rx) = mpsc::channel::<Reply>(4);
    app.state::<Pending>().0.lock().unwrap().insert(id.clone(), tx);
    (id, rx)
}

/// Lumo's own Allow / Deny card, for a call of one of the user's tools
/// (tools.rs): `payload` is shaped as a permission request, and the click
/// comes back as `allow` or `deny`. None when the island couldn't show it.
///
/// An email's card (`lumo_mail_send`) waits MAIL_CARD_TIMEOUT, and its Send
/// may come back as `{"revised": …}`: the email as the user changed it.
pub async fn ask(app: &AppHandle, mut payload: Value) -> Option<String> {
    let (id, mut rx) = pending_request(app);
    payload["request_id"] = json!(id);
    let mail = payload.get("lumo_mail_send").is_some_and(Value::is_object);
    let wait = if mail { MAIL_CARD_TIMEOUT } else { DECISION_TIMEOUT };
    if mail {
        payload["lumo_card_secs"] = json!(MAIL_CARD_TIMEOUT.as_secs());
        with_mail_cards(|set| set.insert(id.clone()));
    }
    log::line(format!("tool card id={id}"));
    // "" outside a chat's tool call: signal_waiting then says nothing.
    let chat = CHAT.try_with(String::clone).unwrap_or_default();
    let _ = app.emit_to(WINDOW_LABEL, "hook", payload);
    let decision = with_card(
        // While Claude uses the computer, the hand gets its mouse back to
        // answer, as for an agent's card. The chat that asked (if any) is
        // waiting for the user, not stuck (chat_agents.rs).
        || {
            crate::computer::card_up(app);
            crate::chat_agents::signal_waiting(app, &chat, Some("permission"));
        },
        // Also when Stop drops the turn that asked, mid-wait: else the count
        // stayed up and Claude never had the mouse again until Lumo restarted.
        |answered| {
            crate::computer::card_down(app);
            crate::chat_agents::signal_waiting(app, &chat, None);
            app.state::<Pending>().0.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            with_mail_cards(|set| set.remove(&id));
            // Nobody answers it any more: it leaves the island.
            if !answered {
                let _ = app.emit_to(WINDOW_LABEL, "hook-settled", id.clone());
            }
        },
        wait_for_decision(&id, &mut rx, wait),
    )
    .await;
    // A card of Lumo's own is never kept for a session.
    decision.map(|d| if d == "always" { "allow".to_string() } else { d })
}

/// Waits for `decision` with a card up: `up` first, then `end(answered)`
/// however the wait ends, answered or not, or dropped half way (Stop drops
/// the turn that asked, and its future with it).
async fn with_card<T>(
    up: impl FnOnce(),
    end: impl FnOnce(bool),
    decision: impl std::future::Future<Output = Option<T>>,
) -> Option<T> {
    up();
    let mut card = CardUp { end: Some(end), answered: false };
    let decision = decision.await;
    card.answered = decision.is_some();
    decision
}

/// A card's end, run when it is dropped (`with_card`).
struct CardUp<F: FnOnce(bool)> {
    end: Option<F>,
    answered: bool,
}

impl<F: FnOnce(bool)> Drop for CardUp<F> {
    fn drop(&mut self) {
        if let Some(end) = self.end.take() {
            end(self.answered);
        }
    }
}

/// Finds, once per session, the window it runs in — see session_window.rs.
///
/// Only while the session is unknown, so the process snapshot is not taken on
/// every event. The relay must still be running for its parents to be found:
/// a permission request always is (it waits for us), a quick event may already
/// have exited, and then a later event of the session tries again.
fn note_session_window(pipe: &impl Relay, payload: &Value, event: &str) {
    let Some(session) = payload.get("session_id").and_then(Value::as_str) else { return };
    if event == "SessionEnd" {
        session_window::forget(session);
        return;
    }
    if session_window::known(session) {
        return;
    }
    let Some(relay) = pipe.client_pid() else { return };
    let ancestors = crate::platform::process_ancestors(relay);
    // No ancestors: the relay was already gone, so try again next time. Some,
    // but none with a window (a classic console): settled, VS Code it is.
    if !ancestors.is_empty() {
        let owner = crate::platform::first_with_window(&ancestors);
        session_window::remember(session, owner.unwrap_or(session_window::NO_WINDOW));
    }
}

/// Two waits: a short one for "the card is up", then the long one for a human.
async fn wait_for_decision(id: &str, rx: &mut mpsc::Receiver<Reply>, wait: Duration) -> Option<String> {
    match tokio::time::timeout(ACK_TIMEOUT, rx.recv()).await {
        Ok(Some(Reply::Ack)) => {}
        // A click that beats the ack is still a click.
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered {}", loggable(&d)));
            return Some(d);
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} not shown — terminal takes over"));
            return None;
        }
        Ok(None) => return None,
        Err(_) => {
            log::line(format!("hook id={id} island never acknowledged — terminal takes over"));
            return None;
        }
    }

    match tokio::time::timeout(wait, rx.recv()).await {
        Ok(Some(Reply::Decision(d))) => {
            log::line(format!("hook id={id} answered {}", loggable(&d)));
            Some(d)
        }
        Ok(Some(Reply::Decline)) => {
            log::line(format!("hook id={id} released without a decision"));
            None
        }
        _ => {
            log::line(format!("hook id={id} timed out — terminal takes over"));
            None
        }
    }
}

/// The log says a question was answered, or an email changed, never with what.
fn loggable(decision: &str) -> &str {
    if decision.starts_with(REVISED) { "send, as the user changed it" } else if decision.starts_with('{') { "a question" } else { decision }
}

/// How an email's Send changed by the user starts (`answer_mail`).
const REVISED: &str = "{\"revised\":";

fn send(app: &AppHandle, request_id: &str, reply: Reply, keep: bool) {
    let sender = {
        let pending = app.state::<Pending>();
        let mut map = pending.0.lock().unwrap();
        if keep { map.get(request_id).cloned() } else { map.remove(request_id) }
    };
    match sender {
        Some(tx) => {
            let _ = tx.try_send(reply);
        }
        None => log::line(format!("reply for id={request_id} — no pending request")),
    }
}

/// The island has the card on screen; the long wait may begin.
pub fn acknowledge(app: &AppHandle, request_id: &str) {
    send(app, request_id, Reply::Ack, true);
}

/// Nobody can act on this one — paused, or another card already holds the view.
pub fn decline(app: &AppHandle, request_id: &str) {
    log::line(format!("decline id={request_id}"));
    send(app, request_id, Reply::Decline, false);
}

/// Called by the island's buttons. Only ever a bare word — `allow`, `always`
/// (allowed for this session, session_rules.rs), `edits` (a plan approved with
/// "let it edit files without asking") or `deny`: turning it into the agent's
/// JSON is lumo-hook's job, and every agent's reply there reads `always` and
/// `edits` as an allow.
pub fn answer(app: &AppHandle, request_id: &str, decision: &str) {
    let word = match decision {
        "allow" => "allow",
        "always" => "always",
        "edits" => "edits",
        _ => "deny",
    };
    log::line(format!("decision id={request_id} {word}"));
    send(app, request_id, Reply::Decision(word.to_string()), false);
}

/// Send on an email's card the user changed (views.ts): the email as it is
/// now on the card, for mail.rs to check and send instead of the AI's. Only
/// for a card of Lumo's own email (`ask`); any other request is left as it is.
pub fn answer_mail(app: &AppHandle, request_id: &str, revised: Value) {
    if !with_mail_cards(|set| set.contains(request_id)) {
        log::line(format!("decision id={request_id} refused: not an email's card"));
        return;
    }
    log::line(format!("decision id={request_id} send, as the user changed it"));
    // One line, as every decision: serde_json escapes the text's own newlines.
    send(app, request_id, Reply::Decision(json!({ "revised": revised }).to_string()), false);
}

/// Auto in the island chat's Antigravity CLI run allows a command that only
/// looks. Refused for any other request: those always wait for a click.
pub fn auto_allow(app: &AppHandle, request_id: &str) {
    if !with_auto_allowable(|set| set.contains(request_id)) {
        log::line(format!("auto-allow refused id={request_id}: not the island chat's Antigravity CLI run"));
        return;
    }
    answer(app, request_id, "allow");
}

/// Called when an option is picked for a question Claude Code asked. `answers`
/// maps each question's text to the chosen label, which is the shape
/// AskUserQuestion takes them in.
pub fn answer_question(app: &AppHandle, request_id: &str, answers: &HashMap<String, serde_json::Value>) {
    log::line(format!("decision id={request_id} answered a question"));
    // One line: the relay reads up to the first newline.
    let line = json!({ "answers": answers }).to_string();
    send(app, request_id, Reply::Decision(line), false);
}

#[cfg(test)]
mod tests {
    use super::*;

    impl Relay for tokio::io::DuplexStream {}

    fn block_on<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    /// A card answered in the terminal: the relay hanging up is seen at once,
    /// and a relay that is still waiting is not mistaken for one that left.
    #[test]
    fn a_relay_that_hangs_up_is_seen_at_once() {
        block_on(async {
            let (mut ours, theirs) = tokio::io::duplex(64);
            let waiting = tokio::time::timeout(Duration::from_millis(50), client_gone(&mut ours)).await;
            assert!(waiting.is_err(), "a live relay must not count as gone");
            drop(theirs);
            let gone = tokio::time::timeout(Duration::from_millis(50), client_gone(&mut ours)).await;
            assert!(gone.is_ok(), "a closed relay must be seen at once");
        });
    }

    /// A card of Lumo's own (`ask`) that Stop drops while it waits: the hand's
    /// count goes down all the same, and the card is said to be gone.
    #[test]
    fn a_card_dropped_while_it_waits_still_ends() {
        use std::sync::atomic::AtomicIsize;
        block_on(async {
            let up = AtomicIsize::new(0);
            let ends = Mutex::new(Vec::new());
            let (tx, mut rx) = mpsc::channel::<String>(1);
            // Stop: the turn's future, and the wait in it, dropped half way.
            let waiting = with_card(
                || {
                    up.fetch_add(1, Ordering::SeqCst);
                },
                |answered| {
                    up.fetch_sub(1, Ordering::SeqCst);
                    ends.lock().unwrap().push(answered);
                },
                rx.recv(),
            );
            assert!(tokio::time::timeout(Duration::from_millis(30), waiting).await.is_err());
            assert_eq!(up.load(Ordering::SeqCst), 0, "the card count went back down");
            assert_eq!(*ends.lock().unwrap(), vec![false]);
            // Answered: the same end, once, told it was.
            tx.send("allow".into()).await.unwrap();
            let answer = with_card(
                || {
                    up.fetch_add(1, Ordering::SeqCst);
                },
                |answered| {
                    up.fetch_sub(1, Ordering::SeqCst);
                    ends.lock().unwrap().push(answered);
                },
                rx.recv(),
            )
            .await;
            assert_eq!(answer.as_deref(), Some("allow"));
            assert_eq!(up.load(Ordering::SeqCst), 0);
            assert_eq!(*ends.lock().unwrap(), vec![false, true]);
        });
    }

    #[test]
    fn first_of_takes_whichever_ends_first() {
        block_on(async {
            let slow = async {
                tokio::time::sleep(Duration::from_secs(5)).await;
                "slow"
            };
            assert_eq!(first_of(slow, async { "fast" }).await, "fast");
            assert_eq!(first_of(async { "a" }, async { "b" }).await, "a");
        });
    }
}
