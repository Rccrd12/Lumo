// The calendar of the live activities: the iCal file at the address the user
// pasted in Settings → Island (Google Calendar's "secret address in iCal
// format", or any published calendar). Fetched only when the island asks,
// never more than every few minutes; read in src/core/calendar.ts.
//
// The address is a secret (anyone who has it can read the calendar), so it
// stays in the credential store, like the keys.

use std::time::Duration;

use reqwest::Url;

use crate::i18n::{t, tf};
use crate::{net, secrets};

pub const URL_KEY: &str = "calendar-ics-url";
const MAX_ICS: usize = 8 * 1024 * 1024;

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
    let Some(raw) = secrets::get(URL_KEY) else { return Ok(None) };
    let url = ics_url(&raw)?;
    let client = net::client(&url, Duration::from_secs(20))?;
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|_| tf("Can't reach {server}.", &[("server", url.host_str().unwrap_or(""))]))?;
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
}
