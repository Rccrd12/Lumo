// API keys live in the Windows Credential Manager — never on disk and never in
// the front end — the island can only ask whether a key is present.

use keyring::Entry;

const SERVICE: &str = crate::IDENTIFIER;

/// Every key Lumo may store. Anything outside this list is refused.
pub const KNOWN_KEYS: &[&str] = &[
    "anthropic-api-key",
    "openai-api-key",
    "google-api-key",
    "openrouter-api-key",
    "openai-compatible-key",
    // Unsloth Studio's own key, sk-unsloth-… (local_chat.rs): without it here
    // it was refused, and the settings page never said so.
    "unsloth-studio-key",
    "n8n-url",
    "n8n-api-key",
    "vercel-token",
    "github-token",
    "stripe-api-key",
    "resend-api-key",
    "notion-api-key",
    "calcom-api-key",
    // The Email pill (mail.rs): the inbox's address, its IMAP server and an app password.
    "mail-address",
    "mail-imap-server",
    "mail-app-password",
    // The other IMAP accounts (mail.rs MAX_ACCOUNTS): the same three, numbered.
    "mail-address-2",
    "mail-imap-server-2",
    "mail-app-password-2",
    "mail-address-3",
    "mail-imap-server-3",
    "mail-app-password-3",
    "mail-address-4",
    "mail-imap-server-4",
    "mail-app-password-4",
    "mail-address-5",
    "mail-imap-server-5",
    "mail-app-password-5",
    // The live activities' calendar (calendar.rs): its iCal address, secret by nature.
    "calendar-ics-url",
    // Google Calendar with the user's account (google_calendar.rs): their own
    // OAuth client's ID and secret, and the permission Google gave at sign-in.
    "google-calendar-client-id",
    "google-calendar-client-secret",
    "google-calendar-refresh-token",
    // The webhooks' secrets, by watch (listen_events.rs): without it here
    // none was ever stored, and every webhook got a new one at each launch.
    "listen-webhooks",
];

fn entry(key: &str) -> Option<Entry> {
    if !KNOWN_KEYS.contains(&key) {
        return None;
    }
    Entry::new(SERVICE, key).ok()
}

pub fn get(key: &str) -> Option<String> {
    entry(key)?.get_password().ok().filter(|v| !v.is_empty())
}

pub fn set(key: &str, value: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    if value.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry.set_password(value).map_err(|e| e.to_string())
}

pub fn clear(key: &str) -> Result<(), String> {
    let entry = entry(key).ok_or_else(|| format!("unknown key {key}"))?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub fn present(key: &str) -> bool {
    get(key).is_some()
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_mail_account_can_be_stored() {
        use crate::mail::{slot_key, ADDRESS_KEY, MAX_ACCOUNTS, PASSWORD_KEY, SERVER_KEY};
        for slot in 1..=MAX_ACCOUNTS {
            for base in [ADDRESS_KEY, SERVER_KEY, PASSWORD_KEY] {
                assert!(super::KNOWN_KEYS.contains(&slot_key(base, slot).as_str()), "{base} {slot}");
            }
        }
    }

    #[test]
    fn google_calendars_keys_can_be_stored() {
        use crate::google_calendar::{CLIENT_ID_KEY, CLIENT_SECRET_KEY, REFRESH_KEY};
        for key in [CLIENT_ID_KEY, CLIENT_SECRET_KEY, REFRESH_KEY] {
            assert!(super::KNOWN_KEYS.contains(&key), "{key}");
        }
    }

    #[test]
    fn the_webhooks_secrets_can_be_stored() {
        assert!(super::KNOWN_KEYS.contains(&crate::listen_events::SECRETS_KEY));
    }

    #[test]
    fn every_local_server_key_can_be_stored() {
        for id in ["custom", "unsloth"] {
            let entry = crate::local_chat::key_entry(id).unwrap();
            assert!(super::KNOWN_KEYS.contains(&entry), "{entry}");
        }
    }
}
