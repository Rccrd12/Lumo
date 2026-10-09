// How much the chat's provider has left, for the quiet line next to the model
// picker (Settings → Chat → "Show remaining usage in the chat").
//
// Nothing here makes a call of its own for Anthropic or OpenAI: their rate
// limit headers come back with every answer the chat already asked for, and
// are read off those responses. OpenRouter puts nothing of the kind on its
// answers, so its key's credits are asked from its own key endpoint, with the
// user's OpenRouter key, only while the option is on (chat_usage in lib.rs).
// Google, the local servers and the custom one: nothing is read.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::HeaderMap;
use serde::Serialize;
use serde_json::Value;

use crate::{net, openai_compat, secrets};

/// A rate limit bucket: what is left, out of how much, and when it is full again.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub remaining: u64,
    pub limit: Option<u64>,
    /// Epoch milliseconds.
    pub resets_at: Option<i64>,
}

/// An OpenRouter key's credits, in US dollars. No `limit`: the key has no cap.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Credits {
    pub remaining: Option<f64>,
    pub limit: Option<f64>,
    pub used: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatUsage {
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<Quota>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requests: Option<Quota>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits: Option<Credits>,
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(str::trim).filter(|v| !v.is_empty())
}

fn count(headers: &HeaderMap, name: &str) -> Option<u64> {
    header(headers, name)?.parse().ok()
}

// ── Anthropic ─────────────────────────────────────────────────────────────────

/// One `anthropic-ratelimit-<kind>-{remaining,limit,reset}` bucket; the reset
/// is an RFC 3339 time.
fn anthropic_quota(headers: &HeaderMap, kind: &str) -> Option<Quota> {
    let name = |part: &str| format!("anthropic-ratelimit-{kind}-{part}");
    Some(Quota {
        remaining: count(headers, &name("remaining"))?,
        limit: count(headers, &name("limit")),
        resets_at: header(headers, &name("reset")).and_then(rfc3339_ms),
    })
}

/// What the Messages API said is left. `tokens` is the most restrictive of the
/// token limits in effect; an account that only gets the input-token one sees that.
pub fn from_anthropic(headers: &HeaderMap) -> Option<ChatUsage> {
    let tokens = anthropic_quota(headers, "tokens").or_else(|| anthropic_quota(headers, "input-tokens"));
    let requests = anthropic_quota(headers, "requests");
    if tokens.is_none() && requests.is_none() {
        return None;
    }
    Some(ChatUsage { provider: crate::chat::ANTHROPIC.into(), tokens, requests, credits: None })
}

// ── OpenAI ────────────────────────────────────────────────────────────────────

/// One `x-ratelimit-{remaining,limit,reset}-<kind>` bucket; the reset is a
/// duration from now ("6m0s", "1s", "20ms").
fn openai_quota(headers: &HeaderMap, kind: &str, now: i64) -> Option<Quota> {
    let name = |part: &str| format!("x-ratelimit-{part}-{kind}");
    Some(Quota {
        remaining: count(headers, &name("remaining"))?,
        limit: count(headers, &name("limit")),
        resets_at: header(headers, &name("reset")).and_then(duration_ms).map(|ms| now + ms),
    })
}

pub fn from_openai(headers: &HeaderMap, now: i64) -> Option<ChatUsage> {
    let tokens = openai_quota(headers, "tokens", now);
    let requests = openai_quota(headers, "requests", now);
    if tokens.is_none() && requests.is_none() {
        return None;
    }
    Some(ChatUsage { provider: "openai".into(), tokens, requests, credits: None })
}

// ── OpenRouter ────────────────────────────────────────────────────────────────

/// `GET /api/v1/key`: `{"data": {"limit": 10 | null, "usage": 1.5, "limit_remaining": 8.5 | null}}`.
pub fn from_openrouter_key(json: &Value) -> Option<ChatUsage> {
    let data = json.get("data")?.as_object()?;
    let num = |key: &str| data.get(key).and_then(Value::as_f64).filter(|v| v.is_finite());
    let limit = num("limit");
    let used = num("usage");
    let remaining = num("limit_remaining").or_else(|| Some((limit? - used?).max(0.0)));
    if limit.is_none() && used.is_none() {
        return None;
    }
    Some(ChatUsage {
        provider: "openrouter".into(),
        tokens: None,
        requests: None,
        credits: Some(Credits { remaining: remaining.filter(|_| limit.is_some()), limit, used }),
    })
}

/// The OpenRouter key's credits. No key: nothing is asked, and nothing comes back.
pub async fn openrouter() -> Result<Option<ChatUsage>, String> {
    let Some(p) = openai_compat::provider("openrouter") else { return Ok(None) };
    let Some(key) = secrets::get(p.key) else { return Ok(None) };
    let url = openai_compat::url(p, "key")?;
    let response = net::client(&url, Duration::from_secs(10))?
        .get(url)
        .bearer_auth(&key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("OpenRouter {}", response.status()));
    }
    let bytes = net::read_capped(response, net::MAX_ERROR_BODY).await?;
    let json: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(from_openrouter_key(&json))
}

// ── Times ─────────────────────────────────────────────────────────────────────

/// Days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's days_from_civil).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// "2026-10-08T12:34:56Z", with optional fractions and a numeric offset, as epoch ms.
pub fn rfc3339_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    if !matches!(b[10], b'T' | b't' | b' ') {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let part = s.get(from..to)?;
        part.bytes().all(|c| c.is_ascii_digit()).then(|| part.parse().ok())?
    };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, se) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut rest = &s[19..];
    let mut ms = 0;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits = frac.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let first3 = format!("{:0<3}", &frac[..digits.min(3)]);
        ms = first3.parse::<i64>().ok()?;
        rest = &frac[digits..];
    }
    let offset_min = match rest {
        "Z" | "z" => 0,
        _ => {
            let ob = rest.as_bytes();
            if ob.len() != 6 || ob[3] != b':' || !matches!(ob[0], b'+' | b'-') {
                return None;
            }
            let hh: i64 = rest[1..3].parse().ok()?;
            let mm: i64 = rest[4..6].parse().ok()?;
            let sign = if ob[0] == b'-' { -1 } else { 1 };
            sign * (hh * 60 + mm)
        }
    };
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + se - offset_min * 60;
    Some(secs * 1000 + ms)
}

/// A Go-style duration as OpenAI writes it ("6m0s", "1h2m3.5s", "20ms") in ms.
pub fn duration_ms(s: &str) -> Option<i64> {
    let mut rest = s.trim();
    if rest.is_empty() {
        return None;
    }
    let mut total = 0.0_f64;
    while !rest.is_empty() {
        let n = rest.bytes().take_while(|c| c.is_ascii_digit() || *c == b'.').count();
        if n == 0 {
            return None;
        }
        let value: f64 = rest[..n].parse().ok()?;
        rest = &rest[n..];
        let units: [(&str, f64); 7] =
            [("ms", 1.0), ("us", 0.001), ("µs", 0.001), ("ns", 0.000_001), ("h", 3_600_000.0), ("m", 60_000.0), ("s", 1000.0)];
        let (unit, scale) = units.iter().find(|(u, _)| rest.starts_with(u))?;
        total += value * scale;
        rest = &rest[unit.len()..];
    }
    Some(total.round() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderName, HeaderValue};
    use serde_json::json;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.insert(HeaderName::from_bytes(k.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
        }
        map
    }

    #[test]
    fn rfc3339_times_become_epoch_milliseconds() {
        assert_eq!(rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(rfc3339_ms("2026-10-08T12:00:30Z"), Some(1_791_460_830_000));
        assert_eq!(rfc3339_ms("2026-10-08T12:00:30.25Z"), Some(1_791_460_830_250));
        assert_eq!(rfc3339_ms("2026-10-08T14:00:30+02:00"), Some(1_791_460_830_000));
        assert_eq!(rfc3339_ms("2026-10-08T07:00:30.123456-05:00"), Some(1_791_460_830_123));
        assert_eq!(rfc3339_ms("2000-02-29T00:00:00Z"), Some(951_782_400_000));
        for bad in ["", "soon", "2026-10-08", "2026-13-08T00:00:00Z", "2026-10-08T12:00:30", "2026-10-08T12:00:30.Z", "2026-1O-08T12:00:30Z"] {
            assert_eq!(rfc3339_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn openai_durations_become_milliseconds() {
        assert_eq!(duration_ms("1s"), Some(1000));
        assert_eq!(duration_ms("6m0s"), Some(360_000));
        assert_eq!(duration_ms("20ms"), Some(20));
        assert_eq!(duration_ms("17.28s"), Some(17_280));
        assert_eq!(duration_ms("1h2m3.5s"), Some(3_723_500));
        assert_eq!(duration_ms("0s"), Some(0));
        for bad in ["", "s", "5", "5x", "1.2.3s"] {
            assert_eq!(duration_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn anthropic_rate_limit_headers_are_read() {
        let h = headers(&[
            ("anthropic-ratelimit-requests-limit", "50"),
            ("anthropic-ratelimit-requests-remaining", "49"),
            ("anthropic-ratelimit-requests-reset", "2026-10-08T12:00:30Z"),
            ("anthropic-ratelimit-tokens-limit", "30000"),
            ("anthropic-ratelimit-tokens-remaining", "27500"),
            ("anthropic-ratelimit-tokens-reset", "2026-10-08T12:00:31Z"),
        ]);
        let u = from_anthropic(&h).unwrap();
        assert_eq!(u.provider, "anthropic");
        assert_eq!(u.tokens, Some(Quota { remaining: 27_500, limit: Some(30_000), resets_at: Some(1_791_460_831_000) }));
        assert_eq!(u.requests, Some(Quota { remaining: 49, limit: Some(50), resets_at: Some(1_791_460_830_000) }));
        assert_eq!(
            serde_json::to_value(&u).unwrap(),
            json!({"provider":"anthropic","tokens":{"remaining":27500,"limit":30000,"resetsAt":1_791_460_831_000_i64},"requests":{"remaining":49,"limit":50,"resetsAt":1_791_460_830_000_i64}})
        );
    }

    #[test]
    fn anthropic_falls_back_to_input_tokens_and_ignores_a_gateway_without_headers() {
        let h = headers(&[
            ("anthropic-ratelimit-input-tokens-limit", "40000"),
            ("anthropic-ratelimit-input-tokens-remaining", "39000"),
            ("anthropic-ratelimit-input-tokens-reset", "not a date"),
        ]);
        let u = from_anthropic(&h).unwrap();
        assert_eq!(u.tokens, Some(Quota { remaining: 39_000, limit: Some(40_000), resets_at: None }));
        assert_eq!(u.requests, None);
        assert_eq!(from_anthropic(&headers(&[("content-type", "application/json")])), None);
        // A limit alone says nothing about what is left.
        assert_eq!(from_anthropic(&headers(&[("anthropic-ratelimit-tokens-limit", "10")])), None);
        assert_eq!(from_anthropic(&headers(&[("anthropic-ratelimit-tokens-remaining", "lots")])), None);
    }

    #[test]
    fn openai_rate_limit_headers_are_read() {
        let now = 1_000_000;
        let h = headers(&[
            ("x-ratelimit-limit-requests", "500"),
            ("x-ratelimit-remaining-requests", "499"),
            ("x-ratelimit-reset-requests", "120ms"),
            ("x-ratelimit-limit-tokens", "30000"),
            ("x-ratelimit-remaining-tokens", "29000"),
            ("x-ratelimit-reset-tokens", "2s"),
        ]);
        let u = from_openai(&h, now).unwrap();
        assert_eq!(u.provider, "openai");
        assert_eq!(u.tokens, Some(Quota { remaining: 29_000, limit: Some(30_000), resets_at: Some(now + 2000) }));
        assert_eq!(u.requests, Some(Quota { remaining: 499, limit: Some(500), resets_at: Some(now + 120) }));
        let only = from_openai(&headers(&[("x-ratelimit-remaining-tokens", "12")]), now).unwrap();
        assert_eq!(only.tokens, Some(Quota { remaining: 12, limit: None, resets_at: None }));
        assert_eq!(from_openai(&HeaderMap::new(), now), None);
    }

    #[test]
    fn openrouter_key_credits_are_read() {
        let capped = json!({"data":{"label":"sk-or-v1-abc","limit":10,"usage":1.5,"limit_remaining":8.5,"is_free_tier":false}});
        let u = from_openrouter_key(&capped).unwrap();
        assert_eq!(u.credits, Some(Credits { remaining: Some(8.5), limit: Some(10.0), used: Some(1.5) }));
        // An older answer without limit_remaining: worked out, never below zero.
        let old = json!({"data":{"limit":2,"usage":3.25}});
        assert_eq!(from_openrouter_key(&old).unwrap().credits.unwrap().remaining, Some(0.0));
        // No cap on the key: only what was spent.
        let open = json!({"data":{"limit":null,"usage":4.2,"limit_remaining":null}});
        assert_eq!(from_openrouter_key(&open).unwrap().credits, Some(Credits { remaining: None, limit: None, used: Some(4.2) }));
        assert_eq!(from_openrouter_key(&json!({"error":{"message":"No auth"}})), None);
        assert_eq!(from_openrouter_key(&json!({"data":{}})), None);
    }

    #[test]
    fn the_key_endpoint_is_openrouters_own() {
        let p = openai_compat::provider("openrouter").unwrap();
        assert_eq!(openai_compat::url(p, "key").unwrap().as_str(), "https://openrouter.ai/api/v1/key");
    }
}
