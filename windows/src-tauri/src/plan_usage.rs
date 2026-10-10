// The Claude plan's usage asked of Anthropic, when the user turned it on
// (Settings → Agents → Plan usage → "Ask Anthropic", off by default).
//
// Claude Code's status line only runs in a terminal session, and its chat
// answers give the 5-hour figure only near the limit: someone who codes in
// VS Code never sees the 5 hours move. Claude Code's own /usage asks
// api.anthropic.com/api/oauth/usage with the account it is signed in with;
// this does the same, read only:
//
// - the access token is read from Claude Code's credentials file at each ask
//   (~/.claude/.credentials.json, or $CLAUDE_CONFIG_DIR) and kept nowhere —
//   not in memory between asks, not in the log, not in the settings;
// - it goes to api.anthropic.com only, over https;
// - nothing is ever refreshed or written: an expired sign-in is for Claude
//   Code to renew, and the answer says to open it.
//
// The answer is turned into the status line's shape (`five_hour` /
// `seven_day` → `used_percentage`, `resets_at` in epoch seconds), which the
// island already reads (core/plan.ts parseClaudePlan).

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::i18n::{t, tf};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_BODY: usize = 64 * 1024;

/// Claude Code's folder: $CLAUDE_CONFIG_DIR when set, else ~/.claude.
fn claude_dir() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| crate::platform::home_dir().join(".claude"))
}

/// The access token in Claude Code's credentials, if it is still valid.
fn token_from(credentials: &Value, now_ms: i64) -> Result<String, String> {
    let oauth = credentials.get("claudeAiOauth").ok_or_else(|| t("Claude Code is not signed in with a Claude plan."))?;
    let token = oauth
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| t("Claude Code is not signed in with a Claude plan."))?;
    if let Some(expires) = oauth.get("expiresAt").and_then(Value::as_i64) {
        if expires <= now_ms {
            return Err(t("Claude Code's sign-in has expired: open Claude Code once to renew it."));
        }
    }
    Ok(token.to_string())
}

fn read_token() -> Result<String, String> {
    let path = claude_dir().join(".credentials.json");
    let bytes = std::fs::read(&path).map_err(|_| t("Claude Code is not signed in with a Claude plan."))?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| t("Claude Code is not signed in with a Claude plan."))?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    token_from(&value, now)
}

/// One window of the answer (`utilization` 0–100, `resets_at` RFC 3339) in
/// the status line's shape; None when it says nothing usable.
fn window(v: &Value) -> Option<Value> {
    let used = v.get("utilization").and_then(Value::as_f64).filter(|u| u.is_finite() && *u >= 0.0)?;
    let resets = match v.get("resets_at") {
        Some(Value::String(s)) => crate::chat_usage::rfc3339_ms(s)? as f64 / 1000.0,
        Some(Value::Number(n)) => {
            let n = n.as_f64()?;
            if n > 1e12 { n / 1000.0 } else { n }
        }
        _ => return None,
    };
    if resets <= 0.0 {
        return None;
    }
    Some(json!({ "used_percentage": used.min(200.0), "resets_at": resets.round() }))
}

/// The answer as the status line's `rate_limits`.
pub fn rate_limits(answer: &Value) -> Value {
    let mut out = Map::new();
    for key in ["five_hour", "seven_day"] {
        if let Some(w) = answer.get(key).and_then(window) {
            out.insert(key.to_string(), w);
        }
    }
    Value::Object(out)
}

/// Asks Anthropic for the plan's usage, as `rate_limits`.
pub async fn fetch() -> Result<Value, String> {
    let token = tauri::async_runtime::spawn_blocking(read_token).await.map_err(|e| e.to_string())??;
    let url = reqwest::Url::parse(USAGE_URL).map_err(|e| e.to_string())?;
    let client = crate::net::client(&url, TIMEOUT)?;
    let response = client
        .get(url)
        .bearer_auth(&token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| tf("Network error: {error}", &[("error", &e.to_string())]))?;
    drop(token);
    let status = response.status();
    let body = crate::net::read_capped(response, MAX_BODY).await?;
    if status.as_u16() == 401 || status.as_u16() == 403 {
        return Err(t("Claude Code's sign-in has expired: open Claude Code once to renew it."));
    }
    if !status.is_success() {
        return Err(tf("Anthropic did not answer ({status}).", &[("status", &status.as_u16().to_string())]));
    }
    let answer: Value = serde_json::from_slice(&body).map_err(|_| t("Anthropic's answer could not be read."))?;
    let limits = rate_limits(&answer);
    if limits.as_object().is_none_or(|m| m.is_empty()) {
        return Err(t("Anthropic's answer could not be read."));
    }
    Ok(limits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_becomes_the_status_lines_shape() {
        let answer = json!({
            "five_hour": { "utilization": 83.0, "resets_at": "2026-10-10T18:00:00.000Z" },
            "seven_day": { "utilization": 75, "resets_at": "2026-10-14T21:00:00+00:00" },
            "seven_day_opus": null,
        });
        let limits = rate_limits(&answer);
        assert_eq!(limits["five_hour"]["used_percentage"], json!(83.0));
        assert_eq!(limits["five_hour"]["resets_at"], json!(1_791_655_200.0));
        assert_eq!(limits["seven_day"]["used_percentage"], json!(75.0));
        // A window without its figure is left out, not made up.
        assert!(rate_limits(&json!({ "five_hour": { "resets_at": "2026-10-10T18:00:00Z" } })).as_object().unwrap().is_empty());
    }

    #[test]
    fn the_token_must_be_there_and_valid() {
        let ok = json!({ "claudeAiOauth": { "accessToken": "sk-ant-oat-x", "expiresAt": 2_000 } });
        assert_eq!(token_from(&ok, 1_000).unwrap(), "sk-ant-oat-x");
        assert!(token_from(&ok, 3_000).is_err(), "expired");
        assert!(token_from(&json!({}), 0).is_err(), "an API key sign-in has no plan");
    }
}
