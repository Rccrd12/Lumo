// Listening to what is heard rather than looked at (listen.rs keeps the
// watches): an email the Email pill read (mail.rs), a service's news
// (integrations.rs), an agent's hook event (pipe.rs), a call to a webhook on
// this PC, an event on the calendar coming up (the island reads the calendar,
// src/island/listen-calendar.ts, and says so with `listen_fire`). Nothing runs
// for them while nothing listens: each is only checked against the watches
// when it happens anyway, and the webhooks' server starts with the first
// webhook, then waits for a call without doing anything.
//
// A webhook is an address on 127.0.0.1 only, ending with a secret of its own,
// which the credential store keeps (never the watches' file): a program on
// this PC that knows the address calls it, and the watch fires with what the
// call sent.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde_json::Value;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::i18n::tf;
use crate::listen::{self, Watch};
use crate::listen_local::{self, News};
use crate::{log, secrets};

/// Where the webhooks' server listens: the first of these ports that is free, on 127.0.0.1 only.
const PORTS: std::ops::RangeInclusive<u16> = 47621..=47630;
const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 64 * 1024;
/// How much of what a call sent is told.
const BODY_CHARS: usize = 300;
/// The webhooks' secrets, by watch, in the credential store.
const SECRETS_KEY: &str = "listen-webhooks";

/// The watches on a source that are on.
fn heard(source: &str) -> Vec<Watch> {
    listen::list().into_iter().filter(|w| w.source == source && !w.paused).collect()
}

/// Why a watch can't listen yet: `needs:` and what to turn on first (the
/// Listening panel says it in words). Checked when it is added.
pub fn available(app: &AppHandle, source: &str, target: &str) -> Result<(), String> {
    let pill_on = |pill: &str| if crate::integrations::enabled(app, pill) { Ok(()) } else { Err(format!("needs:{pill}")) };
    match source {
        "email" => pill_on("integration_mail"),
        "service" if target == "calendar" => {
            if secrets::present(crate::calendar::URL_KEY) {
                Ok(())
            } else {
                Err("needs:calendar".into())
            }
        }
        "service" => match listen_local::SERVICES.iter().find(|s| s.0 == target) {
            Some((_, _, pill)) => pill_on(pill),
            None => Err("needs:service".into()),
        },
        "tool" => crate::tools::listenable(target).map(|_| ()).map_err(|_| "needs:trusted_tool".into()),
        _ => Ok(()),
    }
}

// ── Email ─────────────────────────────────────────────────────────────────────

/// New emails the Email pill read (newest first).
pub fn heard_mail(app: &AppHandle, fresh: &[crate::mail::Message]) {
    if fresh.is_empty() {
        return;
    }
    for w in heard("email") {
        let matching: Vec<_> = fresh.iter().filter(|m| listen_local::mail_matches(&w.until, &w.target, &m.from, &m.address, &m.subject)).collect();
        let Some(m) = matching.first() else { continue };
        let from = if m.from.trim().is_empty() { m.address.as_str() } else { m.from.as_str() };
        let subject = listen_local::excerpt(&m.subject, 120);
        let summary = if matching.len() > 1 {
            let count = matching.len().to_string();
            tf("{count} new emails, the newest from {from}: {subject}", &[("count", &count), ("from", from), ("subject", &subject)])
        } else {
            tf("New email from {from}: {subject}", &[("from", from), ("subject", &subject)])
        };
        listen::fire(app, w.id, true, summary, Some(""));
    }
}

// ── Services ──────────────────────────────────────────────────────────────────

/// Each service's last report, to tell what is new in the next.
static LAST: LazyLock<Mutex<HashMap<&'static str, Value>>> = LazyLock::new(Default::default);

/// What a service's news is called.
fn news_summary(service: &str, name: &str, news: &News) -> String {
    let what = [("what", news.what.as_str())];
    match (service, news.ok) {
        ("vercel", true) => tf("{what} was deployed on Vercel", &what),
        ("vercel", false) => tf("The deploy of {what} failed on Vercel", &what),
        ("stripe", _) => tf("New payment on Stripe: {what}", &what),
        ("n8n", true) => tf("{what} ran on n8n", &what),
        ("n8n", false) => tf("{what} failed on n8n", &what),
        ("resend", true) => tf("Sent with Resend: {what}", &what),
        ("resend", false) => tf("Not delivered by Resend: {what}", &what),
        ("notion", _) => tf("Changed in Notion: {what}", &what),
        ("calcom", _) => tf("New booking on Cal.com: {what}", &what),
        _ => tf("{app}: {text}", &[("app", name), ("text", &news.what)]),
    }
}

/// A service pill's report (integrations.rs emit): `event`, what it says
/// happened (a deploy, a payment, a run), as ok and its name.
pub fn heard_service(app: &AppHandle, pill: &str, data: &Value, failed: bool, event: Option<(bool, &str)>) {
    let Some(&(service, name, _)) = listen_local::SERVICES.iter().find(|s| !s.2.is_empty() && s.2 == pill) else { return };
    if failed {
        return;
    }
    let before = LAST.lock().unwrap().insert(service, data.clone());
    let watches: Vec<Watch> = heard("service").into_iter().filter(|w| w.target == service).collect();
    if watches.is_empty() {
        return;
    }
    let news = listen_local::service_news(service, before.as_ref(), data, event);
    for w in watches {
        if let Some(n) = news.iter().find(|n| listen_local::news_matches(&w.until, n)) {
            listen::fire(app, w.id, true, news_summary(service, name, n), Some(""));
        }
    }
}

// ── Agents ────────────────────────────────────────────────────────────────────

/// An agent's hook event (pipe.rs), for the watches on agents. The island's
/// own chat is not one of them.
pub fn heard_hook(app: &AppHandle, event: &str, payload: &Value) {
    if payload.get("lumo_island") == Some(&Value::Bool(true)) {
        return;
    }
    let text = |key: &str| payload.get(key).and_then(Value::as_str).unwrap_or("");
    let Some(until) = listen_local::hook_until(event, text("message"), text("notification_type"), text("status")) else { return };
    let watches: Vec<Watch> = heard("agent").into_iter().filter(|w| w.until == until).collect();
    if watches.is_empty() {
        return;
    }
    let tag = listen_local::agent_of(text("lumo_agent"));
    let agent = listen_local::agent_name(tag);
    let project = listen_local::last_part(text("cwd"));
    for w in watches.into_iter().filter(|w| w.target == listen_local::ANY || w.target == tag) {
        let vars = [("agent", agent.as_str()), ("project", project)];
        let summary = match (until, project.is_empty()) {
            ("finished", false) => tf("{agent} finished in {project}", &vars),
            ("finished", true) => tf("{agent} finished", &vars),
            ("permission", false) => tf("{agent} is waiting for you in {project}", &vars),
            ("permission", true) => tf("{agent} is waiting for you", &vars),
            (_, false) => tf("{agent} failed in {project}", &vars),
            (_, true) => tf("{agent} failed", &vars),
        };
        listen::fire(app, w.id, true, summary, Some(""));
    }
}

// ── The calendar ──────────────────────────────────────────────────────────────

/// The island saw an event on the calendar coming up (`at`: its start, Unix
/// ms) for a watch on it. Each event fires a watch once.
#[tauri::command(async)]
pub fn listen_fire(app: AppHandle, id: u64, summary: String, at: u64) -> bool {
    let Some(w) = listen::list().into_iter().find(|w| w.id == id && w.source == "service" && w.target == "calendar" && !w.paused) else {
        return false;
    };
    if w.last_sha.parse::<u64>().is_ok_and(|last| at <= last) {
        return false;
    }
    listen::fire(&app, id, true, listen_local::excerpt(&summary, BODY_CHARS), Some(&at.to_string()));
    true
}

// ── Webhooks ──────────────────────────────────────────────────────────────────

static PORT: Mutex<Option<u16>> = Mutex::new(None);
/// The secrets as the credential store has them (None: not read yet).
static TOKENS: Mutex<Option<HashMap<u64, String>>> = Mutex::new(None);

fn with_tokens<R>(f: impl FnOnce(&mut HashMap<u64, String>) -> (R, bool)) -> R {
    let mut tokens = TOKENS.lock().unwrap();
    let map = tokens.get_or_insert_with(|| secrets::get(SECRETS_KEY).and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default());
    let (out, changed) = f(map);
    if changed {
        let text = serde_json::to_string(map).unwrap_or_default();
        if let Err(e) = if map.is_empty() { secrets::clear(SECRETS_KEY) } else { secrets::set(SECRETS_KEY, &text) } {
            log::line(format!("listen: webhooks' secrets not kept: {e}"));
        }
    }
    out
}

/// 32 random bytes, as hex: std's hasher keys come from the system's random source.
fn random_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    (0..4u8)
        .map(|i| {
            let mut h = std::collections::hash_map::RandomState::new().build_hasher();
            h.write_u128(nanos);
            h.write_u8(i);
            format!("{:016x}", h.finish())
        })
        .collect()
}

/// The webhook's secret, made the first time.
pub fn token_for(id: u64) -> String {
    with_tokens(|map| match map.get(&id) {
        Some(token) => (token.clone(), false),
        None => {
            let token = random_token();
            map.insert(id, token.clone());
            (token, true)
        }
    })
}

/// The secrets of webhooks that no longer listen go (listen.rs changed).
pub fn prune(watches: &[Watch]) {
    let any = TOKENS.lock().unwrap().as_ref().is_none_or(|map| !map.is_empty());
    if !any {
        return;
    }
    with_tokens(|map| {
        let before = map.len();
        map.retain(|id, _| watches.iter().any(|w| w.id == *id && w.source == "webhook"));
        ((), map.len() != before)
    });
}

/// The webhooks' server, started the first time: its port, None when none was free.
pub fn ensure_server(app: &AppHandle) -> Option<u16> {
    let mut port = PORT.lock().unwrap();
    if port.is_some() {
        return *port;
    }
    for p in PORTS {
        let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", p)) else { continue };
        if listener.set_nonblocking(true).is_err() {
            continue;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move { serve(app, listener).await });
        log::line(format!("listen: webhooks on 127.0.0.1:{p}"));
        *port = Some(p);
        break;
    }
    *port
}

/// The webhook's address, for the Listening panel.
#[tauri::command(async)]
pub fn listen_webhook_url(app: AppHandle, id: u64) -> Option<String> {
    let w = listen::list().into_iter().find(|w| w.id == id && w.source == "webhook")?;
    let port = ensure_server(&app)?;
    Some(format!("http://127.0.0.1:{port}/{}", token_for(w.id)))
}

async fn serve(app: AppHandle, listener: std::net::TcpListener) {
    let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { return };
    loop {
        let Ok((stream, _)) = listener.accept().await else {
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = tokio::time::timeout(Duration::from_secs(10), answer(&app, stream)).await;
        });
    }
}

/// One call: read, matched to its webhook by the secret, answered.
async fn answer(app: &AppHandle, mut stream: tokio::net::TcpStream) {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    let head_end = loop {
        if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break end;
        }
        if buf.len() > MAX_HEAD {
            return;
        }
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let Some((_, path, length)) = listen_local::request_head(&head) else { return };
    let mut body = buf[head_end + 4..].to_vec();
    let want = length.min(MAX_BODY);
    while body.len() < want {
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => body.extend_from_slice(&chunk[..n]),
        }
    }
    body.truncate(want);
    let token = listen_local::hook_token(&path);
    let id = (!token.is_empty()).then(|| with_tokens(|map| (map.iter().find(|(_, t)| t.as_str() == token).map(|(id, _)| *id), false))).flatten();
    let watch = id.and_then(|id| listen::list().into_iter().find(|w| w.id == id && w.source == "webhook"));
    let reply: &[u8] = if watch.is_some() {
        b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 3\r\nConnection: close\r\n\r\nok\n"
    } else {
        b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    };
    let _ = stream.write_all(reply).await;
    let _ = stream.flush().await;
    let Some(w) = watch.filter(|w| !w.paused) else { return };
    let sent = listen_local::excerpt(&String::from_utf8_lossy(&body), BODY_CHARS);
    let summary = if sent.is_empty() {
        tf("{name} was called", &[("name", &w.target)])
    } else {
        tf("{name} was called: {body}", &[("name", &w.target), ("body", &sent)])
    };
    listen::fire(app, w.id, true, summary, Some(""));
}
