// The calendar of the live activities: the iCal file at the address the user
// pasted in Settings → Island (Google Calendar's "secret address in iCal
// format", or any published calendar). Fetched only when the island asks,
// never more than every few minutes; read in src/core/calendar.ts.
//
// The address is a secret (anyone who has it can read the calendar), so it
// stays in the credential store, like the keys.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::Url;

use crate::i18n::{t, tf};
use crate::{net, secrets};

pub const URL_KEY: &str = "calendar-ics-url";
const MAX_ICS: usize = 8 * 1024 * 1024;

/// After a 429 (too many requests), no request before this moment: asking
/// again while the server limits the address only keeps the limit on. Google
/// answers 429 to an iCal address read too often.
static NOT_BEFORE: Mutex<Option<Instant>> = Mutex::new(None);
/// Bumped by each new address: a fetch of the old one, still on its way,
/// leaves no wait behind for the new one.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// The wait after a 429 when the server names none, and the longest kept.
const LIMITED_WAIT: Duration = Duration::from_secs(30 * 60);
const LIMITED_WAIT_MAX: Duration = Duration::from_secs(6 * 60 * 60);

/// The wait a 429 asks for: its Retry-After in seconds, never under
/// LIMITED_WAIT (Google's is short, its limit is not) nor over LIMITED_WAIT_MAX.
fn limited_wait(retry_after: Option<&str>) -> Duration {
    let asked = retry_after.and_then(|v| v.trim().parse::<u64>().ok()).map(Duration::from_secs);
    asked.unwrap_or(LIMITED_WAIT).clamp(LIMITED_WAIT, LIMITED_WAIT_MAX)
}

fn limited() -> String {
    t("Too many requests: the calendar's server asks Lumo to wait. He tries again later.")
}

/// A new address in Settings: the wait asked for the old one no longer holds.
pub fn address_changed() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    *NOT_BEFORE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// The Google calendar an address of Google Calendar's reads
/// (calendar.google.com/calendar/ical/<id>/private-…/basic.ics), so the
/// island does not show it twice when the same calendar is read through
/// Google sign-in too. Only the calendar's ID leaves here, never the address.
#[tauri::command(async)]
pub fn calendar_google_id() -> Option<String> {
    google_id(&ics_url(&secrets::get(URL_KEY)?).ok()?)
}

fn google_id(url: &Url) -> Option<String> {
    if url.host_str() != Some("calendar.google.com") {
        return None;
    }
    let mut parts = url.path_segments()?;
    (parts.next()? == "calendar" && parts.next()? == "ical").then_some(())?;
    let id = percent_decode(parts.next()?)?;
    (!id.is_empty()).then_some(id)
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `webcal://` is `https://`; anything else must be http or https.
pub fn ics_url(raw: &str) -> Result<Url, String> {
    let raw = raw.trim();
    let raw = match raw.strip_prefix("webcal://") {
        Some(rest) => format!("https://{rest}"),
        None => raw.to_string(),
    };
    let url = Url::parse(&raw).map_err(|_| t("That is not a calendar address."))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return Err(t("That is not a calendar address."));
    }
    Ok(url)
}

/// The calendar file, or null when no address is set.
#[tauri::command]
pub async fn calendar_fetch() -> Result<Option<String>, String> {
    if crate::integrations::PAUSED.load(std::sync::atomic::Ordering::Relaxed) {
        return Ok(None);
    }
    let generation = GENERATION.load(Ordering::SeqCst);
    let Some(raw) = secrets::get(URL_KEY) else { return Ok(None) };
    let url = ics_url(&raw)?;
    if NOT_BEFORE.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|at| Instant::now() < at) {
        return Err(limited());
    }
    let client = net::client(&url, Duration::from_secs(20))?;
    let response = get(&client, &url).await?;
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let header = response.headers().get(reqwest::header::RETRY_AFTER).and_then(|v| v.to_str().ok());
        let wait = limited_wait(header);
        if GENERATION.load(Ordering::SeqCst) == generation {
            *NOT_BEFORE.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now() + wait);
        }
        return Err(limited());
    }
    if !response.status().is_success() {
        return Err(tf("The calendar address answered {code}.", &[("code", response.status().as_str())]));
    }
    let bytes = net::read_capped(response, MAX_ICS).await?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if !text.contains("BEGIN:VCALENDAR") {
        return Err(t("That is not a calendar address."));
    }
    Ok(Some(text))
}

/// Waits between tries: a request that fails right after the computer wakes,
/// or while the network changes, mostly succeeds a few seconds later.
const RETRY_WAITS: [Duration; 2] = [Duration::from_secs(2), Duration::from_secs(5)];

/// The answer to a GET, tried again after a lost connection, a timeout or a
/// passing server error (5xx) before the failure is shown. Not after a 429:
/// asking again at once is what the server asked not to do.
async fn get(client: &reqwest::Client, url: &Url) -> Result<reqwest::Response, String> {
    let mut waits = RETRY_WAITS.iter();
    loop {
        let result = client.get(url.clone()).send().await;
        let passing = match &result {
            Ok(response) => should_retry(response.status()),
            Err(_) => true,
        };
        match waits.next() {
            Some(wait) if passing => tokio::time::sleep(*wait).await,
            _ => {
                return result.map_err(|_| tf("Can't reach {server}.", &[("server", url.host_str().unwrap_or(""))]));
            }
        }
    }
}

fn should_retry(status: reqwest::StatusCode) -> bool {
    status.is_server_error()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calendar_addresses_are_web_addresses() {
        assert_eq!(ics_url("webcal://p01.icloud.com/x.ics").unwrap().as_str(), "https://p01.icloud.com/x.ics");
        assert!(ics_url(" https://calendar.google.com/calendar/ical/a/private-b/basic.ics ").is_ok());
        assert!(ics_url("file:///etc/passwd").is_err());
        assert!(ics_url("not a url").is_err());
    }

    #[test]
    fn a_google_address_names_its_calendar() {
        let id = |s: &str| google_id(&ics_url(s).unwrap());
        assert_eq!(id("https://calendar.google.com/calendar/ical/me%40gmail.com/private-abc/basic.ics").as_deref(), Some("me@gmail.com"));
        assert_eq!(
            id("https://calendar.google.com/calendar/ical/it.italian%23holiday%40group.v.calendar.google.com/public/basic.ics").as_deref(),
            Some("it.italian#holiday@group.v.calendar.google.com")
        );
        assert_eq!(id("https://p01.icloud.com/calendar/ical/x/basic.ics"), None);
        assert_eq!(id("https://calendar.google.com/calendar/embed?src=x"), None);
        assert_eq!(id("https://calendar.google.com/calendar/ical/%zz/basic.ics"), None);
    }

    #[test]
    fn passing_server_errors_are_tried_again() {
        assert!(should_retry(reqwest::StatusCode::SERVICE_UNAVAILABLE));
        assert!(!should_retry(reqwest::StatusCode::NOT_FOUND));
        assert!(!should_retry(reqwest::StatusCode::OK));
    }

    #[test]
    fn too_many_requests_is_not_asked_again_at_once() {
        assert!(!should_retry(reqwest::StatusCode::TOO_MANY_REQUESTS));
    }

    #[test]
    fn a_limited_address_waits_at_least_half_an_hour() {
        assert_eq!(limited_wait(None), LIMITED_WAIT);
        assert_eq!(limited_wait(Some("30")), LIMITED_WAIT);
        assert_eq!(limited_wait(Some("Wed, 21 Oct 2026 07:28:00 GMT")), LIMITED_WAIT);
        assert_eq!(limited_wait(Some(" 7200 ")), Duration::from_secs(7200));
        assert_eq!(limited_wait(Some("999999")), LIMITED_WAIT_MAX);
    }
}
