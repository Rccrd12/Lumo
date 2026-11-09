// The images in the chat's answers (views/rich/image.ts): a line that is
// only `![alt](https://…)` shows the picture at once. The user chose this over
// asking site by site; Settings → Security → Images from the web turns it off,
// and then nothing is downloaded here either.
//
// The island never reaches the site itself: its CSP lets images in only from
// the app, data: and blob:. Lumo downloads the bytes here and hands them over
// as they are, and the island shows them through a blob: URL. That way every
// rule is kept in one place:
// - https only, on its usual port, with no user name or password in the URL;
// - only public addresses: never this machine or the local network, whether
//   the URL names the address or a name resolves to it. The name is resolved
//   here and the connection goes to the very addresses checked, so a name that
//   answers a public address to the check and 127.0.0.1 to the connection (DNS
//   rebinding) reaches nothing. The request names the host exactly as it was
//   pinned (`example.com.` goes out as `example.com`). Redirects are followed by hand, at most three,
//   each checked again the same way;
// - no proxy (it would resolve the name itself), no cookies, nothing about the
//   user: the site is told only "Lumo";
// - 15 seconds and 8 MB at most;
// - PNG, JPEG, GIF, WebP and AVIF only, the type the server names matching
//   the bytes' own signature. Never SVG, which can carry scripts.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::Duration;

use reqwest::Url;

/// The most of an image that is downloaded.
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
/// How long an image may take, redirects and all.
const TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);
/// Redirects followed before giving up.
const MAX_REDIRECTS: usize = 3;
/// What the site is told is asking: the app's name, nothing about the user.
const AGENT: &str = "Lumo";
/// The only port: https's own.
const PORT: u16 = 443;

/// The image at `url`, its bytes as the site sent them (the island reads
/// their type from their first bytes, as `sniff` does here).
#[tauri::command]
pub async fn web_image(url: String) -> Result<tauri::ipc::Response, String> {
    if !crate::settings::load().web_images {
        return Err("Images from the web are turned off in Settings.".into());
    }
    let bytes = tokio::time::timeout(TIMEOUT, download(&url))
        .await
        .map_err(|_| "The image took too long.".to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

async fn download(raw: &str) -> Result<Vec<u8>, String> {
    let mut url = parse(raw)?;
    for _ in 0..=MAX_REDIRECTS {
        let host = check_url(&url)?;
        url = as_pinned(&url, &host)?;
        let addrs = resolve(&host).await?;
        let client = pinned_client(&host, &addrs)?;
        let response = client
            .get(url.clone())
            .header("Accept", "image/avif,image/webp,image/png,image/jpeg,image/gif")
            .send()
            .await
            .map_err(|e| format!("{} didn't answer: {}", host.name(), if e.is_timeout() { "too slow" } else { "no connection" }))?;
        let status = response.status();
        if status.is_redirection() {
            let location = response.headers().get("location").and_then(|l| l.to_str().ok()).unwrap_or("");
            url = next_hop(&url, location)?;
            continue;
        }
        if !status.is_success() {
            return Err(format!("{} answered {}.", host.name(), status.as_u16()));
        }
        let named = response.headers().get("content-type").and_then(|c| c.to_str().ok()).and_then(content_type);
        let Some(named) = named else {
            return Err("That address is not an image Lumo shows (PNG, JPEG, GIF, WebP or AVIF).".into());
        };
        if response.content_length().is_some_and(|n| n > MAX_BYTES as u64) {
            return Err("The image is bigger than 8 MB.".into());
        }
        let bytes = read_capped(response).await?;
        return match sniff(&bytes) {
            Some(kind) if kind == named => Ok(bytes),
            _ => Err("The file is not the image it says it is.".into()),
        };
    }
    Err("The image redirects too many times.".into())
}

/// The body, refused as soon as it passes `MAX_BYTES`.
async fn read_capped(mut response: reqwest::Response) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "The image stopped halfway.".to_string())? {
        if body.len() + chunk.len() > MAX_BYTES {
            return Err("The image is bigger than 8 MB.".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// A client that reaches `host` only at `addrs`: no redirects of its own, no
/// proxy, no cookies (reqwest keeps none unless asked).
fn pinned_client(host: &Host, addrs: &[SocketAddr]) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .user_agent(AGENT)
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none());
    if let Host::Name(name) = host {
        builder = builder.resolve_to_addrs(name, addrs);
    }
    builder.build().map_err(|e| e.to_string())
}

/// The URL as it is requested: its host written exactly as the name checked
/// and pinned. The URL parser keeps a final dot (`example.com.`) and the
/// client looks the pin up by the host as written, so a name with the dot
/// would miss its pin and be resolved again, out of reach of the check (DNS
/// rebinding). Written as the pinned name, the request can only use the pin.
fn as_pinned(url: &Url, host: &Host) -> Result<Url, String> {
    let Host::Name(name) = host else {
        return Ok(url.clone());
    };
    let mut pinned = url.clone();
    if pinned.host_str() != Some(name.as_str()) {
        pinned.set_host(Some(name)).map_err(|_| "Not a web address.".to_string())?;
    }
    if pinned.host_str() == Some(name.as_str()) {
        Ok(pinned)
    } else {
        Err(format!("{name} is not a public https address."))
    }
}

// ── Addresses ───────────────────────────────────────────────────────────────

/// Where an image is: a name to resolve, or an address the URL gives as is.
#[derive(Debug, PartialEq)]
enum Host {
    Name(String),
    Ip(IpAddr),
}

impl Host {
    fn name(&self) -> String {
        match self {
            Host::Name(name) => name.clone(),
            Host::Ip(ip) => ip.to_string(),
        }
    }
}

fn parse(raw: &str) -> Result<Url, String> {
    Url::parse(raw.trim()).map_err(|_| "Not a web address.".to_string())
}

/// The URL's host when the URL may be opened at all: https, the usual port,
/// no user name or password, and a host that can only be on the internet. A
/// name is checked again once resolved (`resolve`).
fn check_url(url: &Url) -> Result<Host, String> {
    let refused = || format!("{} is not a public https address.", url.host_str().unwrap_or("This"));
    if url.scheme() != "https" {
        return Err("Only https images are shown.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(refused());
    }
    // `port()` is None for https's own port, written or not.
    if url.port().is_some_and(|p| p != PORT) {
        return Err(refused());
    }
    // The URL parser already wrote any address in its usual form (127.1,
    // 2130706433 and 0x7f000001 all become 127.0.0.1), IPv6 in brackets.
    let host = url.host_str().ok_or_else(refused)?;
    if let Ok(ip) = host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>() {
        return if is_public(ip) { Ok(Host::Ip(ip)) } else { Err(refused()) };
    }
    let name = host.trim_end_matches('.').to_ascii_lowercase();
    let local = name == "localhost"
        || !name.contains('.')
        || [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".arpa"].iter().any(|s| name.ends_with(s));
    if local {
        Err(refused())
    } else {
        Ok(Host::Name(name))
    }
}

/// The addresses to connect to: every one the name gave must be public, or none is used.
async fn resolve(host: &Host) -> Result<Vec<SocketAddr>, String> {
    let name = match host {
        Host::Ip(ip) => return Ok(vec![SocketAddr::new(*ip, PORT)]),
        Host::Name(name) => name,
    };
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((name.as_str(), PORT))
        .await
        .map_err(|_| format!("{name} was not found."))?
        .collect();
    if addrs.is_empty() || addrs.iter().any(|a| !is_public(a.ip())) {
        return Err(format!("{name} is not a public https address."));
    }
    Ok(addrs)
}

/// Where a redirect leads, from the page that sent it: checked like the first
/// address before anything is opened.
fn next_hop(from: &Url, location: &str) -> Result<Url, String> {
    let broken = || "The image sent a broken redirect.".to_string();
    if location.trim().is_empty() {
        return Err(broken());
    }
    let next = from.join(location.trim()).map_err(|_| broken())?;
    check_url(&next)?;
    Ok(next)
}

/// Only addresses on the internet: never this machine, the local network,
/// link-local, shared (CGNAT), multicast, documentation or reserved ranges,
/// in IPv4 or in any IPv6 form that carries an IPv4 address.
fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || v4.is_multicast()
                || a == 0
                || (a == 100 && (64..128).contains(&b))
                || (a == 192 && b == 0 && c == 0)
                || (a == 198 && (b == 18 || b == 19))
                || a >= 240)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let seg = v6.segments();
            let first = seg[0];
            let v4 = |hi: u16, lo: u16| IpAddr::V4(Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8));
            // NAT64 (64:ff9b::/96) carries an IPv4 address at its end, 6to4
            // (2002::/16) right after the prefix: they count as that address.
            if seg[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
                return is_public(v4(seg[6], seg[7]));
            }
            if first == 0x2002 {
                return is_public(v4(seg[1], seg[2]));
            }
            // Teredo (2001::/32), benchmarking (2001:2::/48), documentation
            // (2001:db8::/32) and the old IPv4-compatible ::a.b.c.d (::/96,
            // with :: and ::1).
            if (first == 0x2001 && (seg[1] == 0 || seg[1] == 0x0db8 || (seg[1] == 2 && seg[2] == 0)))
                || seg[..6] == [0, 0, 0, 0, 0, 0]
            {
                return false;
            }
            // Past those, only global unicast (2000::/3) is on the internet.
            // That leaves out loopback, multicast, unique local (fc00::/7),
            // link-local, the discard prefix (100::/64) and the rest of
            // 64:ff9b::/32, whose local-use NAT64 prefix (64:ff9b:1::/48)
            // would carry a local network's address in a form not read here.
            (first & 0xe000) == 0x2000
        }
    }
}

// ── Image types ─────────────────────────────────────────────────────────────

/// The image types shown, by the name a server gives them.
const TYPES: [&str; 5] = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];

/// The image type a Content-Type header names, when it is one shown.
fn content_type(header: &str) -> Option<&'static str> {
    let name = header.split(';').next()?.trim().to_ascii_lowercase();
    let name = match name.as_str() {
        "image/jpg" | "image/pjpeg" => "image/jpeg",
        "image/x-png" => "image/png",
        other => other,
    };
    TYPES.iter().find(|t| **t == name).copied()
}

/// The image type the bytes' own signature says, when it is one shown.
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    // AVIF: an ISO box `ftyp` first, with avif or avis as its brand or among
    // the compatible ones that follow (each four bytes, after the version).
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        let size = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
        let end = size.clamp(12, bytes.len().min(256));
        let avif = |brand: &[u8]| brand == b"avif" || brand == b"avis";
        if avif(&bytes[8..12]) || bytes.get(16..end).is_some_and(|rest| rest.chunks_exact(4).any(avif)) {
            return Some("image/avif");
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).unwrap()
    }

    fn ip(raw: &str) -> IpAddr {
        raw.parse().unwrap()
    }

    // ── URLs ────────────────────────────────────────────────────────────────

    #[test]
    fn a_public_https_name_is_resolved_later() {
        assert_eq!(check_url(&url("https://upload.wikimedia.org/a/b.png")), Ok(Host::Name("upload.wikimedia.org".into())));
        assert_eq!(check_url(&url("https://Upload.Wikimedia.ORG./a.png")), Ok(Host::Name("upload.wikimedia.org".into())));
        assert_eq!(check_url(&url("https://example.com:443/a.png")), Ok(Host::Name("example.com".into())));
    }

    #[test]
    fn the_request_names_the_host_exactly_as_it_was_pinned() {
        for (raw, host, requested) in [
            ("https://example.com./a.png?x=1#f", "example.com", "https://example.com/a.png?x=1#f"),
            ("https://Upload.Wikimedia.ORG./a.png", "upload.wikimedia.org", "https://upload.wikimedia.org/a.png"),
            ("https://example.com/a.png", "example.com", "https://example.com/a.png"),
        ] {
            let from = url(raw);
            let checked = check_url(&from).unwrap();
            assert_eq!(checked, Host::Name(host.into()));
            let pinned = as_pinned(&from, &checked).unwrap();
            assert_eq!(pinned.as_str(), requested);
            // The key pinned_client gives resolve_to_addrs is the request's host.
            assert_eq!(pinned.host_str(), Some(checked.name().as_str()));
        }
        // An address is connected to as is: nothing to pin.
        let literal = url("https://93.184.216.34/a.png");
        assert_eq!(as_pinned(&literal, &check_url(&literal).unwrap()).unwrap(), literal);
        // A redirect to a name with the dot is pinned the same way.
        let next = next_hop(&url("https://example.com/a.png"), "https://cdn.example.org./b.png").unwrap();
        let checked = check_url(&next).unwrap();
        assert_eq!(as_pinned(&next, &checked).unwrap().as_str(), "https://cdn.example.org/b.png");
    }

    #[test]
    fn only_https_on_its_own_port() {
        for raw in [
            "http://example.com/a.png",
            "ftp://example.com/a.png",
            "file:///C:/a.png",
            "data:image/png;base64,AAAA",
            "javascript:alert(1)",
            "https://example.com:8443/a.png",
            "https://example.com:80/a.png",
        ] {
            assert!(check_url(&url(raw)).is_err(), "{raw}");
        }
    }

    #[test]
    fn a_user_name_or_password_in_the_url_is_refused() {
        assert!(check_url(&url("https://user@example.com/a.png")).is_err());
        assert!(check_url(&url("https://user:pass@example.com/a.png")).is_err());
        assert!(check_url(&url("https://:pass@example.com/a.png")).is_err());
    }

    #[test]
    fn local_names_are_refused_before_any_lookup() {
        for raw in [
            "https://localhost/a.png",
            "https://LOCALHOST./a.png",
            "https://app.localhost/a.png",
            "https://printer.local/a.png",
            "https://nas.lan/a.png",
            "https://router.home.arpa/a.png",
            "https://metadata.google.internal/a.png",
            "https://intranet/a.png",
        ] {
            assert!(check_url(&url(raw)).is_err(), "{raw}");
        }
    }

    #[test]
    fn a_literal_address_must_be_public() {
        assert_eq!(check_url(&url("https://93.184.216.34/a.png")), Ok(Host::Ip(ip("93.184.216.34"))));
        assert_eq!(check_url(&url("https://[2606:4700::1111]/a.png")), Ok(Host::Ip(ip("2606:4700::1111"))));
        for raw in [
            "https://127.0.0.1/a.png",
            "https://127.1/a.png",
            "https://2130706433/a.png",
            "https://0x7f000001/a.png",
            "https://0.0.0.0/a.png",
            "https://10.0.0.5/a.png",
            "https://172.16.3.4/a.png",
            "https://192.168.1.1/a.png",
            "https://169.254.169.254/a.png",
            "https://100.64.0.1/a.png",
            "https://224.0.0.1/a.png",
            "https://[::1]/a.png",
            "https://[::]/a.png",
            "https://[fd00::1]/a.png",
            "https://[fe80::1]/a.png",
            "https://[::ffff:127.0.0.1]/a.png",
            "https://[::ffff:192.168.0.1]/a.png",
            "https://[64:ff9b::a00:1]/a.png",
            "https://[2002:c0a8:101::]/a.png",
        ] {
            assert!(check_url(&url(raw)).is_err(), "{raw}");
        }
    }

    #[test]
    fn public_and_private_ranges() {
        for public in ["1.1.1.1", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.32.0.1", "2a00:1450::1", "::ffff:8.8.8.8", "64:ff9b::808:808"] {
            assert!(is_public(ip(public)), "{public}");
        }
        for private in [
            "127.0.0.1",
            "10.1.2.3",
            "172.31.255.255",
            "192.168.0.1",
            "169.254.1.1",
            "100.64.0.0",
            "100.127.255.255",
            "0.1.2.3",
            "255.255.255.255",
            "240.0.0.1",
            "239.1.1.1",
            "192.0.0.8",
            "198.18.0.1",
            "192.0.2.1",
            "::1",
            "::",
            "::7f00:1",
            "fc00::1",
            "fdff::1",
            "fe80::1",
            "febf::1",
            "fec0::1",
            "ff02::1",
            "2001:db8::1",
            "2001:0:4136:e378::1",
            "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
            "2002:7f00:1::",
            "64:ff9b:1::a00:1",
            "64:ff9b:1:a00:1::",
            "100::1",
            "2001:2::1",
        ] {
            assert!(!is_public(ip(private)), "{private}");
        }
    }

    fn block_on<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(f)
    }

    #[test]
    fn a_literal_address_is_used_as_is_and_a_local_one_never_reached() {
        assert_eq!(block_on(resolve(&Host::Ip(ip("1.1.1.1")))), Ok(vec![SocketAddr::new(ip("1.1.1.1"), 443)]));
        // Refused before any connection or lookup: nothing is tried.
        for raw in ["https://127.0.0.1/a.png", "https://localhost/a.png", "https://[::1]/a.png", "http://example.com/a.png", "not a url"] {
            assert!(block_on(download(raw)).is_err(), "{raw}");
        }
    }

    #[test]
    fn each_redirect_is_checked_like_the_first_address() {
        let from = url("https://example.com/img/a.png");
        assert_eq!(next_hop(&from, "/b.png").unwrap().as_str(), "https://example.com/b.png");
        assert_eq!(next_hop(&from, "c.png").unwrap().as_str(), "https://example.com/img/c.png");
        assert_eq!(next_hop(&from, "https://cdn.example.org/d.png").unwrap().as_str(), "https://cdn.example.org/d.png");
        for bad in ["http://example.com/a.png", "https://127.0.0.1/a.png", "https://localhost/x", "https://[::1]/x", "https://example.com:8080/x", "file:///etc/passwd", ""] {
            assert!(next_hop(&from, bad).is_err(), "{bad:?}");
        }
    }

    // ── Types ───────────────────────────────────────────────────────────────

    #[test]
    fn only_raster_types_are_named() {
        assert_eq!(content_type("image/png"), Some("image/png"));
        assert_eq!(content_type("IMAGE/JPEG; charset=binary"), Some("image/jpeg"));
        assert_eq!(content_type("image/jpg"), Some("image/jpeg"));
        assert_eq!(content_type("image/webp"), Some("image/webp"));
        assert_eq!(content_type("image/avif"), Some("image/avif"));
        assert_eq!(content_type("image/gif"), Some("image/gif"));
        for other in ["image/svg+xml", "text/html", "application/octet-stream", "", "image/x-icon", "image/bmp"] {
            assert_eq!(content_type(other), None, "{other}");
        }
    }

    #[test]
    fn the_bytes_say_what_they_are() {
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"), Some("image/png"));
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10]), Some("image/jpeg"));
        assert_eq!(sniff(b"GIF89a\x01\0\x01\0"), Some("image/gif"));
        assert_eq!(sniff(b"GIF87a\x01\0\x01\0"), Some("image/gif"));
        assert_eq!(sniff(b"RIFF\x24\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff(b"\0\0\0\x1cftypavif\0\0\0\0avifmif1"), Some("image/avif"));
        assert_eq!(sniff(b"\0\0\0\x1cftypmif1\0\0\0\0mif1avif"), Some("image/avif"));
        // An HEIC or an MP4 is an ftyp box too, but not an AVIF.
        assert_eq!(sniff(b"\0\0\0\x18ftypheic\0\0\0\0mif1heic"), None);
        assert_eq!(sniff(b"\0\0\0\x18ftypisom\0\0\x02\0isomiso2"), None);
        // A RIFF that is not a WebP (a WAV).
        assert_eq!(sniff(b"RIFF\x24\0\0\0WAVEfmt "), None);
        // SVG and HTML, however they start.
        assert_eq!(sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>"), None);
        assert_eq!(sniff(b"<?xml version=\"1.0\"?><svg/>"), None);
        assert_eq!(sniff(b"<!doctype html><img src=x>"), None);
        assert_eq!(sniff(b""), None);
        assert_eq!(sniff(b"\x89PN"), None);
    }
}
