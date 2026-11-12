// Google Calendar read through Google's own API, with the user's Google
// account: a new event shows on the island within a minute, where the iCal
// address (calendar.rs) waits for Google to write its file again, hours later.
//
// Each user brings their own OAuth client (Settings → Island → Google
// Calendar walks them through Google Cloud Console): its ID and secret, and
// the refresh token Google gives at sign-in, stay in the credential store. The
// access token, good for an hour, lives only in memory. Nothing of it is in
// the code nor on disk.
//
// Sign-in is Google's flow for desktop apps: the browser opens Google's page,
// and Google sends it back to an address on 127.0.0.1 that Lumo listens on for
// that moment only (with PKCE, so a code caught on the way is worth nothing).
// Lumo asks to see the events and the list of calendars, never to change them.
//
// The island's page does the rest (src/core/google-calendar.ts): which
// calendars, what changed since the last look (`syncToken`), the events of the
// next days. It asks through `google_calendar_get`, which reaches only the
// Calendar API's calendar list and events, with the token added here.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::{StatusCode, Url};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::i18n::{t, tf};
use crate::{log, net, secrets};

pub const CLIENT_ID_KEY: &str = "google-calendar-client-id";
pub const CLIENT_SECRET_KEY: &str = "google-calendar-client-secret";
/// Google's lasting permission: written only by a sign-in, never by the front end.
pub const REFRESH_KEY: &str = "google-calendar-refresh-token";

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";
const API_BASE: &str = "https://www.googleapis.com/calendar/v3";
const EVENTS_SCOPE: &str = "https://www.googleapis.com/auth/calendar.events.readonly";
const LIST_SCOPE: &str = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";

/// How long the browser has to come back before the sign-in gives up.
const SIGN_IN_WAIT: Duration = Duration::from_secs(5 * 60);
/// An access token is renewed this long before Google says it ends.
const TOKEN_MARGIN: Duration = Duration::from_secs(60);
const MAX_REQUEST_HEAD: usize = 16 * 1024;

/// The access token and when it stops working.
static ACCESS: Mutex<Option<(String, Instant)>> = Mutex::new(None);
/// Google refused the refresh token (password changed, access removed from
/// the account): only a new sign-in helps.
static NEEDS_SIGN_IN: AtomicBool = AtomicBool::new(false);
/// A sign-in waiting for the browser, and the Cancel that ends it.
static SIGNING_IN: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn sign_in_again() -> String {
    t("Google closed Lumo's access: sign in again in Settings → Island.")
}

/// The client's ID or secret changed in Settings: the token they gave goes.
pub fn client_changed() {
    *lock(&ACCESS) = None;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// The client's ID and secret are stored.
    client: bool,
    /// Google gave its lasting permission, and it still holds as far as Lumo knows.
    signed_in: bool,
    /// Google refused that permission: sign in again.
    needs_sign_in: bool,
    /// A sign-in is waiting for the browser.
    signing_in: bool,
}

#[tauri::command(async)]
pub fn google_calendar_status() -> Status {
    Status {
        client: secrets::present(CLIENT_ID_KEY) && secrets::present(CLIENT_SECRET_KEY),
        signed_in: secrets::present(REFRESH_KEY),
        needs_sign_in: NEEDS_SIGN_IN.load(Ordering::Relaxed),
        signing_in: SIGNING_IN.load(Ordering::Relaxed),
    }
}

/// Opens Google's sign-in in the browser and waits for it to come back (five
/// minutes at most, or until Cancel). Ok once the permission is stored.
#[tauri::command]
pub async fn google_calendar_sign_in(app: AppHandle) -> Result<(), String> {
    let (Some(client_id), Some(client_secret)) = (secrets::get(CLIENT_ID_KEY), secrets::get(CLIENT_SECRET_KEY)) else {
        return Err(t("Paste your Google client's ID and secret first."));
    };
    if SIGNING_IN.swap(true, Ordering::SeqCst) {
        return Err(t("A sign-in is already waiting in the browser."));
    }
    CANCEL.store(false, Ordering::SeqCst);
    let result = sign_in(client_id.trim(), client_secret.trim()).await;
    SIGNING_IN.store(false, Ordering::SeqCst);
    if result.is_ok() {
        NEEDS_SIGN_IN.store(false, Ordering::SeqCst);
        let _ = app.emit_to(crate::island::WINDOW_LABEL, "calendar-changed", ());
    }
    result
}

/// Ends a sign-in waiting for the browser.
#[tauri::command]
pub fn google_calendar_cancel() {
    if SIGNING_IN.load(Ordering::SeqCst) {
        CANCEL.store(true, Ordering::SeqCst);
    }
}

/// Removes the access: Google is told to forget it (when it can be reached),
/// and the permission, the client's ID and its secret leave the credential store.
#[tauri::command]
pub async fn google_calendar_sign_out(app: AppHandle) -> Result<(), String> {
    if let Some(token) = secrets::get(REFRESH_KEY) {
        if let Ok(url) = Url::parse(REVOKE_URL) {
            if let Ok(client) = net::client(&url, Duration::from_secs(10)) {
                let _ = client.post(url).form(&[("token", token.as_str())]).send().await;
            }
        }
    }
    *lock(&ACCESS) = None;
    NEEDS_SIGN_IN.store(false, Ordering::SeqCst);
    for key in [REFRESH_KEY, CLIENT_ID_KEY, CLIENT_SECRET_KEY] {
        secrets::clear(key)?;
    }
    let _ = app.emit_to(crate::island::WINDOW_LABEL, "calendar-changed", ());
    Ok(())
}

#[derive(Serialize)]
pub struct Answer {
    status: u16,
    body: Value,
}

/// A GET to the Calendar API: `path` under /calendar/v3, only the calendar
/// list or a calendar's events. Null when not signed in (or Lumo is paused).
/// A 410 comes back as an answer: the `syncToken` is too old, and the page
/// starts that calendar again.
#[tauri::command]
pub async fn google_calendar_get(path: String, query: Vec<(String, String)>) -> Result<Option<Answer>, String> {
    if crate::integrations::PAUSED.load(Ordering::Relaxed) || !secrets::present(REFRESH_KEY) {
        return Ok(None);
    }
    let url = api_url(&path, &query)?;
    let client = net::client(&url, Duration::from_secs(20))?;
    let mut response = send(&client, &url, &access_token().await?).await?;
    if response.status() == StatusCode::UNAUTHORIZED {
        // Ended early (revoked, or the clock was off): a new one, once.
        *lock(&ACCESS) = None;
        response = send(&client, &url, &access_token().await?).await?;
    }
    let status = response.status();
    let body = net::read_capped(response, net::MAX_BODY).await?;
    if status.is_success() || status == StatusCode::GONE {
        let body = serde_json::from_slice(&body).unwrap_or(Value::Null);
        return Ok(Some(Answer { status: status.as_u16(), body }));
    }
    Err(api_error(status, &body))
}

async fn send(client: &reqwest::Client, url: &Url, token: &str) -> Result<reqwest::Response, String> {
    client
        .get(url.clone())
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| tf("Can't reach {server}.", &[("server", url.host_str().unwrap_or(""))]))
}

/// What a refused request says. Google answers 403 with a reason when it
/// limits the requests, and when the Calendar API is off in the user's project.
fn api_error(status: StatusCode, body: &[u8]) -> String {
    let reason = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.pointer("/error/errors/0/reason").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_default();
    if status == StatusCode::TOO_MANY_REQUESTS || reason.contains("RateLimitExceeded") || reason == "quotaExceeded" {
        return t("Too many requests: Google asks Lumo to wait. He tries again later.");
    }
    if reason == "accessNotConfigured" {
        return t("The Google Calendar API is off in your Google Cloud project: turn it on there.");
    }
    if status == StatusCode::FORBIDDEN {
        return sign_in_again();
    }
    tf("Google Calendar answered {code}.", &[("code", status.as_str())])
}

/// The API's address for `path`, if it is one the page may ask: the calendar
/// list, or the events of one calendar (its ID percent-encoded by the page).
fn api_url(path: &str, query: &[(String, String)]) -> Result<Url, String> {
    let allowed = path == "/users/me/calendarList"
        || path
            .strip_prefix("/calendars/")
            .and_then(|rest| rest.strip_suffix("/events"))
            .is_some_and(|id| !id.is_empty() && !id.contains(['/', '?', '#', '\\']) && !id.contains(".."));
    let refused = || "not a Calendar API path".to_string();
    if !allowed {
        return Err(refused());
    }
    let mut url = Url::parse(&format!("{API_BASE}{path}")).map_err(|_| refused())?;
    if url.host_str() != Some("www.googleapis.com") || !url.path().starts_with("/calendar/v3/") {
        return Err(refused());
    }
    if !query.is_empty() {
        url.query_pairs_mut().extend_pairs(query.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    }
    Ok(url)
}

/// A token for the API: the one in memory while it lasts, else a new one
/// from the refresh token.
async fn access_token() -> Result<String, String> {
    if let Some((token, until)) = lock(&ACCESS).as_ref() {
        if Instant::now() + TOKEN_MARGIN < *until {
            return Ok(token.clone());
        }
    }
    let (Some(refresh), Some(client_id), Some(client_secret)) =
        (secrets::get(REFRESH_KEY), secrets::get(CLIENT_ID_KEY), secrets::get(CLIENT_SECRET_KEY))
    else {
        return Err(sign_in_again());
    };
    let answer = token_request(&[
        ("client_id", client_id.trim()),
        ("client_secret", client_secret.trim()),
        ("refresh_token", refresh.as_str()),
        ("grant_type", "refresh_token"),
    ])
    .await;
    match answer {
        Ok(token) => {
            NEEDS_SIGN_IN.store(false, Ordering::SeqCst);
            let value = token.access_token.clone();
            *lock(&ACCESS) = Some((token.access_token, Instant::now() + token.expires_in));
            Ok(value)
        }
        Err(TokenError::Refused) => {
            NEEDS_SIGN_IN.store(true, Ordering::SeqCst);
            Err(sign_in_again())
        }
        Err(TokenError::Other(message)) => Err(message),
    }
}

struct Token {
    access_token: String,
    expires_in: Duration,
    refresh_token: Option<String>,
    scope: String,
}

enum TokenError {
    /// invalid_grant or invalid_client: the permission or the client no longer holds.
    Refused,
    Other(String),
}

async fn token_request(form: &[(&str, &str)]) -> Result<Token, TokenError> {
    let url = Url::parse(TOKEN_URL).map_err(|e| TokenError::Other(e.to_string()))?;
    let client = net::client(&url, Duration::from_secs(20)).map_err(TokenError::Other)?;
    let response = client
        .post(url.clone())
        .form(form)
        .send()
        .await
        .map_err(|_| TokenError::Other(tf("Can't reach {server}.", &[("server", url.host_str().unwrap_or(""))])))?;
    let status = response.status();
    let body = net::read_capped(response, net::MAX_ERROR_BODY).await.map_err(TokenError::Other)?;
    let value: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    if !status.is_success() {
        let code = value.get("error").and_then(Value::as_str).unwrap_or("");
        if matches!(code, "invalid_grant" | "invalid_client" | "unauthorized_client") {
            return Err(TokenError::Refused);
        }
        return Err(TokenError::Other(tf("Google refused the sign-in ({code}).", &[("code", status.as_str())])));
    }
    parse_token(&value).ok_or_else(|| TokenError::Other(tf("Google refused the sign-in ({code}).", &[("code", status.as_str())])))
}

fn parse_token(v: &Value) -> Option<Token> {
    Some(Token {
        access_token: v.get("access_token")?.as_str()?.to_string(),
        expires_in: Duration::from_secs(v.get("expires_in").and_then(Value::as_u64).unwrap_or(3600)),
        refresh_token: v.get("refresh_token").and_then(Value::as_str).map(str::to_owned),
        scope: v.get("scope").and_then(Value::as_str).unwrap_or("").to_string(),
    })
}

// ── Sign-in ──────────────────────────────────────────────────────────────────

async fn sign_in(client_id: &str, client_secret: &str) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");
    let verifier = random_hex();
    let state = random_hex();
    if verifier.is_empty() || state.is_empty() {
        return Err(t("Lumo could not start the sign-in."));
    }
    let auth = auth_url(client_id, &redirect, &challenge(&verifier), &state);
    crate::platform::open_url(auth.as_str());

    let code = wait_for_code(&listener, &state).await?;
    drop(listener);

    let token = token_request(&[
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("code", code.as_str()),
        ("code_verifier", verifier.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("grant_type", "authorization_code"),
    ])
    .await
    .map_err(|e| match e {
        TokenError::Refused => t("Google refused the client: check its ID and secret."),
        TokenError::Other(message) => message,
    })?;
    if !has_scopes(&token.scope) {
        return Err(t("Google gave no access to the events: sign in again and tick both boxes."));
    }
    let Some(refresh) = token.refresh_token.as_deref() else {
        return Err(t("Google gave no lasting access: sign in again."));
    };
    secrets::set(REFRESH_KEY, refresh)?;
    *lock(&ACCESS) = Some((token.access_token, Instant::now() + token.expires_in));
    log::line("google calendar: signed in");
    Ok(())
}

/// Google's page, asking for the two read-only scopes and a lasting permission.
fn auth_url(client_id: &str, redirect: &str, challenge: &str, state: &str) -> Url {
    let scope = format!("{EVENTS_SCOPE} {LIST_SCOPE}");
    let mut url = Url::parse(AUTH_URL).expect("Google's address");
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect)
        .append_pair("response_type", "code")
        .append_pair("scope", &scope)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    url
}

/// Both scopes granted: Google's page lets each box be unticked.
fn has_scopes(granted: &str) -> bool {
    let granted: Vec<&str> = granted.split_whitespace().collect();
    granted.contains(&EVENTS_SCOPE) && granted.contains(&LIST_SCOPE)
}

/// PKCE's S256: the verifier's SHA-256, base64url without padding.
fn challenge(verifier: &str) -> String {
    let digest = ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes());
    crate::claude::base64_for(digest.as_ref()).replace('+', "-").replace('/', "_").trim_end_matches('=').to_string()
}

/// 32 random bytes as hex (64 characters, which PKCE's verifier allows), or
/// "" without a random source.
fn random_hex() -> String {
    use ring::rand::SecureRandom;
    let mut bytes = [0u8; 32];
    if ring::rand::SystemRandom::new().fill(&mut bytes).is_err() {
        return String::new();
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// What the browser brought back to 127.0.0.1.
#[derive(Debug, PartialEq)]
enum Callback {
    Code(String),
    /// The user said no on Google's page (or Google refused the request).
    Refused(String),
    /// Not the sign-in's answer: a favicon, a stale tab, another state.
    Other,
}

fn read_callback(target: &str, state: &str) -> Callback {
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else { return Callback::Other };
    if url.path() != "/" {
        return Callback::Other;
    }
    let get = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    if get("state").as_deref() != Some(state) {
        return Callback::Other;
    }
    if let Some(error) = get("error") {
        return Callback::Refused(error);
    }
    get("code").filter(|c| !c.is_empty()).map_or(Callback::Other, Callback::Code)
}

/// The request line's target: "/?code=…" from "GET /?code=… HTTP/1.1".
fn request_target(head: &str) -> Option<&str> {
    let mut parts = head.lines().next()?.split_whitespace();
    (parts.next()? == "GET").then_some(())?;
    parts.next()
}

async fn wait_for_code(listener: &TcpListener, state: &str) -> Result<String, String> {
    let deadline = Instant::now() + SIGN_IN_WAIT;
    loop {
        if CANCEL.load(Ordering::SeqCst) {
            return Err(t("Sign-in cancelled."));
        }
        if Instant::now() >= deadline {
            return Err(t("The browser did not come back: sign in again."));
        }
        // A second at a time, so Cancel is heard.
        let Ok(Ok((mut stream, _))) = tokio::time::timeout(Duration::from_secs(1), listener.accept()).await else {
            continue;
        };
        let head = read_head(&mut stream).await.unwrap_or_default();
        match request_target(&head).map(|target| read_callback(target, state)) {
            Some(Callback::Code(code)) => {
                answer(&mut stream, "200 OK", &t("Done: Lumo can read your calendar."), &t("You can close this tab.")).await;
                return Ok(code);
            }
            Some(Callback::Refused(error)) => {
                answer(&mut stream, "200 OK", &t("Lumo did not get access to the calendar."), &t("You can close this tab.")).await;
                return Err(if error == "access_denied" {
                    t("Sign-in cancelled.")
                } else {
                    tf("Google refused the sign-in ({code}).", &[("code", error.as_str())])
                });
            }
            _ => answer(&mut stream, "404 Not Found", "", "").await,
        }
    }
}

async fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < MAX_REQUEST_HEAD {
        let n = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut chunk)).await.ok()?.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

async fn answer(stream: &mut TcpStream, status: &str, title: &str, line: &str) {
    let body = if title.is_empty() { String::new() } else { page(title, line) };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// The tab the browser lands on: Lumo's colours, his eyes, one sentence.
fn page(title: &str, line: &str) -> String {
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(
        "<!doctype html><meta charset=utf-8><meta name=viewport content=\"width=device-width\"><title>Lumo</title>\
<style>html{{background:#0b0c0e;color:#f5f6f8;font:15px system-ui,'Segoe UI',sans-serif}}\
body{{min-height:90vh;display:grid;place-items:center;text-align:center}}\
.e{{display:flex;gap:10px;justify-content:center;margin-bottom:18px}}\
.e i{{width:10px;height:24px;border-radius:5px;background:#fff7e0;box-shadow:0 0 12px #ffe9a8}}\
h1{{font-size:19px;font-weight:600;margin:0 0 6px}}p{{color:#9398a1;margin:0}}</style>\
<div><div class=e><i></i><i></i></div><h1>{}</h1><p>{}</p></div>",
        esc(title),
        esc(line)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_calendar_list_and_events_can_be_asked() {
        let q = vec![("maxResults".to_string(), "250".to_string())];
        let list = api_url("/users/me/calendarList", &q).unwrap();
        assert_eq!(list.as_str(), "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250");
        let events = api_url("/calendars/name%40gmail.com/events", &[]).unwrap();
        assert_eq!(events.as_str(), "https://www.googleapis.com/calendar/v3/calendars/name%40gmail.com/events");
        for bad in [
            "/calendars/x/events/123",
            "/calendars//events",
            "/calendars/../../drive/v3/files/events",
            "/calendars/a/b/events",
            "/users/me/settings",
            "@evil.example/calendars/x/events",
            ".evil.example/calendars/x/events",
            "/calendars/x?y/events",
            "",
        ] {
            assert!(api_url(bad, &[]).is_err(), "{bad}");
        }
    }

    #[test]
    fn query_values_are_encoded() {
        let q = vec![("syncToken".to_string(), "a+b/c=&d".to_string())];
        let url = api_url("/calendars/primary/events", &q).unwrap();
        assert_eq!(url.query(), Some("syncToken=a%2Bb%2Fc%3D%26d"));
    }

    #[test]
    fn the_pkce_challenge_is_rfc_7636s() {
        // RFC 7636, appendix B.
        assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn the_verifier_is_long_and_random() {
        let (a, b) = (random_hex(), random_hex());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    #[test]
    fn googles_page_asks_for_reading_only_and_a_lasting_permission() {
        let url = auth_url("id.apps.googleusercontent.com", "http://127.0.0.1:5000", "ch", "st");
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(url.host_str(), Some("accounts.google.com"));
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:5000");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["access_type"], "offline");
        assert_eq!(q["prompt"], "consent");
        assert!(q["scope"].split(' ').all(|s| s.ends_with(".readonly")));
    }

    #[test]
    fn the_browser_answer_is_read_only_with_its_state() {
        assert_eq!(read_callback("/?state=s1&code=4%2F0Ab&scope=x", "s1"), Callback::Code("4/0Ab".into()));
        assert_eq!(read_callback("/?state=s1&error=access_denied", "s1"), Callback::Refused("access_denied".into()));
        assert_eq!(read_callback("/?state=other&code=x", "s1"), Callback::Other);
        assert_eq!(read_callback("/?code=x", "s1"), Callback::Other);
        assert_eq!(read_callback("/favicon.ico", "s1"), Callback::Other);
        assert_eq!(read_callback("/?state=s1&code=", "s1"), Callback::Other);
        assert_eq!(request_target("GET /?a=b HTTP/1.1\r\nHost: x\r\n\r\n"), Some("/?a=b"));
        assert_eq!(request_target("POST / HTTP/1.1\r\n\r\n"), None);
        assert_eq!(request_target(""), None);
    }

    #[test]
    fn both_boxes_must_be_ticked() {
        assert!(has_scopes(&format!("{LIST_SCOPE} {EVENTS_SCOPE}")));
        assert!(!has_scopes(LIST_SCOPE));
        assert!(!has_scopes(""));
    }

    #[test]
    fn a_token_answer_is_read() {
        let v: Value = serde_json::from_str(r#"{"access_token":"ya29.x","expires_in":3599,"refresh_token":"1//r","scope":"a b"}"#).unwrap();
        let token = parse_token(&v).unwrap();
        assert_eq!(token.access_token, "ya29.x");
        assert_eq!(token.expires_in, Duration::from_secs(3599));
        assert_eq!(token.refresh_token.as_deref(), Some("1//r"));
        assert!(parse_token(&serde_json::json!({"error": "invalid_grant"})).is_none());
    }

    #[test]
    fn the_landing_page_escapes_its_text() {
        assert!(page("<b>", "x & y").contains("&lt;b&gt;"));
        assert!(page("a", "x & y").contains("x &amp; y"));
    }
}
