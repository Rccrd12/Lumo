// Settings → Updates: is there a newer Windows build on GitHub, and if so,
// download its installer and run it.
//
// Nothing here runs on its own: the check and the download only ever start from
// a click in Settings (no telemetry, no background calls). The installer is the
// same NSIS setup.exe the release workflow publishes (.github/workflows/windows.yml,
// named by scripts/pack.mjs), run with its own window so the user sees every
// step; Lumo quits right after starting it so its files can be replaced.
//
// The app was called Coucou up to 0.3.0, and the installers were named
// `Coucou-Windows-<v>-setup.exe`. Releases from 0.3.1 on carry
// `Lumo-Windows-<v>-setup.exe` plus the same file under its old name, which is
// what an installed 0.3.0 looks for; this build prefers the new name and still
// accepts the old one.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::i18n::{t, tf};
use crate::{log, net};

/// The GitHub repository whose releases are checked: the one place it is named.
pub const UPDATE_REPO: &str = "Rccrd12/coucou-agent";

/// Windows releases are tagged `windows-v0.2.1` (the `windows-latest` rolling
/// release does not match, and neither do the Mac's `v*` or `linux-v*` tags).
const TAG_PREFIX: &str = "windows-v";

/// Hosts a release download may come from: github.com, then the CDN it redirects to.
const DOWNLOAD_HOSTS: [&str; 3] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

/// No installer is anywhere near this; a bigger answer is not one.
const MAX_INSTALLER: u64 = 400 * 1024 * 1024;

/// What Settings shows after a check.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// This build's version.
    current: String,
    /// The newest Windows release on GitHub.
    latest: String,
    /// True when `latest` is newer than `current`.
    newer: bool,
    /// The release's notes, cut to a readable length.
    notes: String,
    /// `Lumo-Windows-<latest>-setup.exe` of that release, or the same
    /// installer under its old name `Coucou-Windows-<latest>-setup.exe`.
    asset_url: Option<String>,
}

#[derive(Deserialize)]
struct Release {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    #[serde(default)]
    name: String,
    #[serde(default)]
    browser_download_url: String,
}

/// A version as the release tags and Cargo write it: `1.2.3`, `1.2.3-beta.1`.
/// A pre-release sorts before the release it leads to.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    /// False for a pre-release (so it sorts first), true for the release.
    release: bool,
    pre: String,
}

fn parse_version(text: &str) -> Option<Version> {
    let text = text.trim().trim_start_matches('v');
    // Build metadata (`+…`) does not order versions.
    let text = text.split('+').next()?;
    let (core, pre) = match text.split_once('-') {
        Some((core, pre)) => (core, pre.to_string()),
        None => (text, String::new()),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(Version { major, minor, patch, release: pre.is_empty(), pre })
}

/// The newest published Windows release in GitHub's list, with its version.
fn newest_windows_release(releases: Vec<Release>) -> Option<(Version, String, Release)> {
    releases
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease)
        .filter_map(|r| {
            let raw = r.tag_name.strip_prefix(TAG_PREFIX)?.to_string();
            let version = parse_version(&raw)?;
            Some((version, raw, r))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
}

/// What an installer's file name starts with, best first: the current name,
/// then the one releases kept for installs from before the rename.
const INSTALLER_PREFIXES: [&str; 2] = ["Lumo-Windows-", "Coucou-Windows-"];
const INSTALLER_SUFFIX: &str = "-setup.exe";

/// The installer's names for `version`, best first, as scripts/pack.mjs writes them.
fn installer_names(version: &str) -> [String; 2] {
    INSTALLER_PREFIXES.map(|prefix| format!("{prefix}{version}{INSTALLER_SUFFIX}"))
}

/// The version in the middle of an installer's file name, either name.
fn installer_middle(name: &str) -> Option<&str> {
    INSTALLER_PREFIXES
        .iter()
        .find_map(|prefix| name.strip_prefix(prefix))?
        .strip_suffix(INSTALLER_SUFFIX)
}

/// Release notes, without trailing blank space and cut to a length that fits.
fn short_notes(body: Option<&str>) -> String {
    const MAX: usize = 1500;
    let body = body.unwrap_or("").replace("\r\n", "\n");
    let body = body.trim();
    if body.chars().count() <= MAX {
        return body.to_string();
    }
    let cut: String = body.chars().take(MAX).collect();
    format!("{}…", cut.trim_end())
}

fn compare(current: &str, releases: Vec<Release>) -> Result<UpdateInfo, String> {
    let Some((latest, raw, release)) = newest_windows_release(releases) else {
        return Err(t("No Windows release has been published yet."));
    };
    let newer = parse_version(current).is_none_or(|mine| latest > mine);
    let asset_url = installer_names(&raw).iter().find_map(|name| {
        release
            .assets
            .iter()
            .find(|a| &a.name == name)
            .map(|a| a.browser_download_url.clone())
            .filter(|u| Url::parse(u).is_ok_and(|u| is_release_download(&u)))
    });
    Ok(UpdateInfo {
        current: current.to_string(),
        latest: raw,
        newer,
        notes: short_notes(release.body.as_deref()),
        asset_url,
    })
}

/// True for `https://github.com/<UPDATE_REPO>/releases/download/<tag>/Lumo-Windows-<v>-setup.exe`
/// (or `Coucou-Windows-<v>-setup.exe`, its name before the rename):
/// the only address `update_install` starts a download from.
fn is_release_download(url: &Url) -> bool {
    if url.scheme() != "https" || url.host_str() != Some("github.com") || url.port().is_some() {
        return false;
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() {
        return false;
    }
    let prefix = format!("/{UPDATE_REPO}/releases/download/").to_ascii_lowercase();
    let path = url.path();
    if !path.to_ascii_lowercase().starts_with(&prefix) {
        return false;
    }
    let rest = &path[prefix.len()..];
    let mut parts = rest.split('/');
    let (Some(tag), Some(file), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    // The file carries the tag's own version: windows-v1.2.3 → Lumo-Windows-1.2.3-setup.exe.
    tag.starts_with(TAG_PREFIX)
        && is_installer_file(file)
        && installer_names(&tag[TAG_PREFIX.len()..]).iter().any(|name| name == file)
}

/// The version an accepted installer address carries.
fn installer_version(url: &Url) -> Option<Version> {
    let file = url.path_segments()?.next_back()?;
    parse_version(installer_middle(file)?)
}

/// `Lumo-Windows-<version>-setup.exe` (or its old `Coucou-Windows-` name), with
/// nothing but a version in the middle.
fn is_installer_file(name: &str) -> bool {
    let Some(middle) = installer_middle(name) else {
        return false;
    };
    !middle.is_empty()
        && middle.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
        && parse_version(middle).is_some()
}

/// Where a redirect may lead while downloading: GitHub and its release CDN, over https.
fn is_download_host(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str().is_some_and(|h| DOWNLOAD_HOSTS.contains(&h))
}

fn user_agent(app: &AppHandle) -> String {
    format!("Coucou/{} (+https://github.com/{UPDATE_REPO})", app.package_info().version)
}

/// Settings → Updates → Check for updates. Asks GitHub for the repository's
/// releases (one anonymous request, nothing about this computer in it) and
/// compares the newest Windows one with this build.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<UpdateInfo, String> {
    if !cfg!(windows) {
        return Err(t("Updating from Settings is only available on Windows. On Linux, update Lumo the way you installed it."));
    }
    let current = app.package_info().version.to_string();
    let url = Url::parse(&format!("https://api.github.com/repos/{UPDATE_REPO}/releases?per_page=30"))
        .map_err(|e| e.to_string())?;
    let client = net::client(&url, Duration::from_secs(20))?;
    let response = client
        .get(url)
        .header("User-Agent", user_agent(&app))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| tf("Could not reach GitHub: {error}", &[("error", &e.to_string())]))?;
    let status = response.status();
    if status.as_u16() == 403 || status.as_u16() == 429 {
        return Err(t("GitHub is limiting requests right now. Try again in a few minutes."));
    }
    if status.as_u16() == 404 {
        return Err(t("No Windows release has been published yet."));
    }
    if !status.is_success() {
        return Err(tf("GitHub answered with an error ({status}).", &[("status", status.as_str())]));
    }
    let body = net::read_capped(response, net::MAX_BODY).await?;
    let releases: Vec<Release> = serde_json::from_slice(&body)
        .map_err(|_| t("GitHub's answer could not be read."))?;
    let info = compare(&current, releases)?;
    log::line(format!("update check: current {} latest {} newer {}", info.current, info.latest, info.newer));
    Ok(info)
}

/// One install at a time: a second click while downloading does nothing.
static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone)]
struct Progress {
    received: u64,
    /// 0 when GitHub did not say how big the file is.
    total: u64,
}

/// Settings → Updates → Update now. Downloads the installer `update_check`
/// found into a temporary folder, starts it with its own window, then quits so
/// it can replace Lumo's files. Only GitHub release downloads of this
/// repository are accepted.
#[tauri::command]
pub async fn update_install(app: AppHandle, url: String) -> Result<(), String> {
    if !cfg!(windows) {
        return Err(t("Updating from Settings is only available on Windows. On Linux, update Lumo the way you installed it."));
    }
    let url = Url::parse(url.trim()).map_err(|_| t("Only installers from Lumo's GitHub releases can be installed."))?;
    if !is_release_download(&url) {
        return Err(t("Only installers from Lumo's GitHub releases can be installed."));
    }
    // Never an older (or the same) build than the one running.
    let current = parse_version(&app.package_info().version.to_string());
    if let (Some(offered), Some(current)) = (installer_version(&url), current) {
        if offered <= current {
            return Err(t("That version is not newer than the one installed."));
        }
    }
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err(t("An update is already being installed."));
    }
    let result = download_and_run(&app, url).await;
    match result {
        Ok(()) => {
            // Leave the click its answer, then quit so the installer can replace the files.
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(900)).await;
                handle.exit(0);
            });
            Ok(())
        }
        Err(err) => {
            INSTALLING.store(false, Ordering::SeqCst);
            log::line(format!("update install failed: {err}"));
            Err(err)
        }
    }
}

async fn download_and_run(app: &AppHandle, url: Url) -> Result<(), String> {
    let file_name = url
        .path_segments()
        .and_then(|mut s| s.next_back())
        .filter(|n| is_installer_file(n))
        .ok_or_else(|| t("Only installers from Lumo's GitHub releases can be installed."))?
        .to_string();

    // Redirects stay on GitHub and its download CDN.
    let policy = reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() > 5 {
            attempt.error("too many redirects")
        } else if is_download_host(attempt.url()) {
            attempt.follow()
        } else {
            attempt.stop()
        }
    });
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .redirect(policy)
        .build()
        .map_err(|e| e.to_string())?;
    let mut response = client
        .get(url.clone())
        .header("User-Agent", user_agent(app))
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|e| tf("The download failed: {error}", &[("error", &e.to_string())]))?;
    if !is_download_host(response.url()) {
        return Err(t("Only installers from Lumo's GitHub releases can be installed."));
    }
    if !response.status().is_success() {
        return Err(tf("The download failed: {error}", &[("error", response.status().as_str())]));
    }
    let total = response.content_length().unwrap_or(0);
    if total > MAX_INSTALLER {
        return Err(t("The server's answer is too large."));
    }

    let mut bytes: Vec<u8> = Vec::with_capacity(total as usize);
    let mut last = Instant::now();
    let _ = app.emit("update-progress", Progress { received: 0, total });
    loop {
        let chunk = tokio::time::timeout(Duration::from_secs(60), response.chunk())
            .await
            .map_err(|_| tf("The download failed: {error}", &[("error", "timeout")]))?
            .map_err(|e| tf("The download failed: {error}", &[("error", &e.to_string())]))?;
        let Some(chunk) = chunk else { break };
        if bytes.len() as u64 + chunk.len() as u64 > MAX_INSTALLER {
            return Err(t("The server's answer is too large."));
        }
        bytes.extend_from_slice(&chunk);
        if last.elapsed() >= Duration::from_millis(150) {
            last = Instant::now();
            let _ = app.emit("update-progress", Progress { received: bytes.len() as u64, total });
        }
    }
    if total > 0 && bytes.len() as u64 != total {
        return Err(tf("The download failed: {error}", &[("error", "incomplete")]));
    }
    // An NSIS installer is a Windows program: it starts with "MZ".
    if !bytes.starts_with(b"MZ") {
        return Err(tf("The download failed: {error}", &[("error", "not an installer")]));
    }
    let _ = app.emit("update-progress", Progress { received: bytes.len() as u64, total: bytes.len() as u64 });

    // %TEMP%\Coucou-update\Lumo-Windows-<v>-setup.exe (the folder kept its old
    // name); installers from earlier updates are cleared first.
    let dir = std::env::temp_dir().join("Coucou-update");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| tf("Could not save the installer: {error}", &[("error", &e.to_string())]))?;
    let path = dir.join(&file_name);
    let partial = dir.join(format!("{file_name}.part"));
    std::fs::write(&partial, &bytes).map_err(|e| tf("Could not save the installer: {error}", &[("error", &e.to_string())]))?;
    std::fs::rename(&partial, &path).map_err(|e| tf("Could not save the installer: {error}", &[("error", &e.to_string())]))?;
    log::line(format!("update: downloaded {} ({} bytes)", file_name, bytes.len()));

    // Its own window, as when the user double-clicks it: the NSIS installer
    // (per-user, no admin prompt) asks before it does anything.
    std::process::Command::new(&path)
        .current_dir(&dir)
        .spawn()
        .map_err(|e| tf("Could not start the installer: {error}", &[("error", &e.to_string())]))?;
    log::line("update: installer started, quitting");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, assets: &[&str]) -> Release {
        Release {
            tag_name: tag.into(),
            draft: false,
            prerelease: false,
            body: Some("Notes\r\n".into()),
            assets: assets
                .iter()
                .map(|name| Asset {
                    name: (*name).into(),
                    browser_download_url: format!("https://github.com/{UPDATE_REPO}/releases/download/{tag}/{name}"),
                })
                .collect(),
        }
    }

    #[test]
    fn versions_order_like_semver() {
        let v = |s: &str| parse_version(s).unwrap();
        assert!(v("0.2.1") > v("0.2.0"));
        assert!(v("0.10.0") > v("0.9.9"));
        assert!(v("1.0.0") > v("0.99.99"));
        assert!(v("0.3.0") > v("0.3.0-beta.2"));
        assert!(v("0.3.0-beta.2") > v("0.2.9"));
        assert_eq!(v("v0.2.0"), v("0.2.0+build.7"));
        assert!(parse_version("0.2").is_none());
        assert!(parse_version("0.2.x").is_none());
        assert!(parse_version("0.2.0.1").is_none());
        assert!(parse_version("latest").is_none());
    }

    #[test]
    fn the_newest_windows_release_wins_whatever_the_order() {
        let mut beta = release("windows-v0.9.0", &["Lumo-Windows-0.9.0-setup.exe"]);
        beta.prerelease = true;
        let releases = vec![
            release("windows-v0.2.1", &["Coucou-Windows-0.2.1-setup.exe", "Coucou-Windows-0.2.1.msi"]),
            release("windows-latest", &["Lumo-Windows-setup.exe", "Coucou-Windows-setup.exe"]),
            release("v0.5.0", &["Coucou.dmg"]),
            release("linux-v0.4.0", &[]),
            release("windows-v0.3.1", &["Coucou-Windows-0.3.1-setup.exe", "Lumo-Windows-0.3.1-setup.exe", "Lumo-Windows-0.3.1.msi"]),
            release("windows-v0.3.0", &["Coucou-Windows-0.3.0-setup.exe"]),
            beta,
        ];
        let info = compare("0.2.0", releases).unwrap();
        assert_eq!(info.latest, "0.3.1");
        assert!(info.newer);
        assert_eq!(info.notes, "Notes");
        // The new name wins over the copy kept under the old one, whatever their order.
        assert_eq!(
            info.asset_url.as_deref(),
            Some(format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.1/Lumo-Windows-0.3.1-setup.exe").as_str())
        );
    }

    #[test]
    fn a_release_with_only_the_old_installer_name_still_updates() {
        let info = compare("0.2.0", vec![release("windows-v0.3.0", &["Coucou-Windows-0.3.0-setup.exe"])]).unwrap();
        assert_eq!(
            info.asset_url.as_deref(),
            Some(format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.0/Coucou-Windows-0.3.0-setup.exe").as_str())
        );
    }

    #[test]
    fn the_same_or_an_older_release_is_not_newer() {
        let info = compare("0.3.0", vec![release("windows-v0.3.0", &["Coucou-Windows-0.3.0-setup.exe"])]).unwrap();
        assert!(!info.newer);
        let info = compare("0.4.0", vec![release("windows-v0.3.0", &[])]).unwrap();
        assert!(!info.newer);
        assert_eq!(info.asset_url, None);
        assert!(compare("0.2.0", vec![release("windows-latest", &[])]).is_err());
        assert!(compare("0.2.0", vec![]).is_err());
    }

    #[test]
    fn only_this_repositorys_installers_are_downloaded() {
        let ok = |s: &str| is_release_download(&Url::parse(s).unwrap());
        assert!(ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.0/Coucou-Windows-0.3.0-setup.exe")));
        assert!(ok("https://github.com/rccrd12/Coucou-Agent/releases/download/windows-v0.3.0/Coucou-Windows-0.3.0-setup.exe"));
        // Another repository, host, scheme, file or tag.
        assert!(!ok("https://github.com/someone/else/releases/download/windows-v0.3.0/Coucou-Windows-0.3.0-setup.exe"));
        assert!(!ok(&format!("https://evil.example/{UPDATE_REPO}/releases/download/windows-v0.3.0/Coucou-Windows-0.3.0-setup.exe")));
        assert!(!ok(&format!("http://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.0/Coucou-Windows-0.3.0-setup.exe")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.0/Coucou-Windows-0.3.0.msi")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.0/payload.exe")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/v0.3.0/Coucou-Windows-0.3.0-setup.exe")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.0/x/Coucou-Windows-0.3.0-setup.exe")));
        assert!(!ok(&format!("https://github.com:8443/{UPDATE_REPO}/releases/download/windows-v0.3.0/Coucou-Windows-0.3.0-setup.exe")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.0/Coucou-Windows-0.3.0-setup.exe?x=1")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.0/Coucou-Windows-..-setup.exe")));
        // The file must carry its tag's version.
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.4.0/Coucou-Windows-0.3.0-setup.exe")));
        let url = Url::parse(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.4.1/Coucou-Windows-0.4.1-setup.exe")).unwrap();
        assert_eq!(installer_version(&url), parse_version("0.4.1"));
    }

    #[test]
    fn the_new_installer_name_is_held_to_the_same_rules() {
        let ok = |s: &str| is_release_download(&Url::parse(s).unwrap());
        assert!(ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.1/Lumo-Windows-0.3.1-setup.exe")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.1/Lumo-Windows-0.3.1.msi")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.1/Lumo-Windows-..-setup.exe")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.4.0/Lumo-Windows-0.3.1-setup.exe")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.1/Lumo-0.3.1-setup.exe")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.1/Lumo-Windows-Coucou-Windows-0.3.1-setup.exe")));
        assert!(!ok("https://github.com/someone/else/releases/download/windows-v0.3.1/Lumo-Windows-0.3.1-setup.exe"));
        let url = Url::parse(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.4.1/Lumo-Windows-0.4.1-setup.exe")).unwrap();
        assert_eq!(installer_version(&url), parse_version("0.4.1"));
        assert!(is_installer_file("Lumo-Windows-0.4.1-setup.exe"));
        assert!(is_installer_file("Coucou-Windows-0.4.1-setup.exe"));
        assert!(!is_installer_file("Lumo-Windows-setup.exe"));
    }

    #[test]
    fn redirects_stay_on_github() {
        let ok = |s: &str| is_download_host(&Url::parse(s).unwrap());
        assert!(ok("https://objects.githubusercontent.com/github-production-release-asset/1/2?x=y"));
        assert!(ok("https://release-assets.githubusercontent.com/github-production-release-asset/1/2"));
        assert!(ok("https://github.com/a/b"));
        assert!(!ok("http://objects.githubusercontent.com/x"));
        assert!(!ok("https://objects.githubusercontent.com.evil.example/x"));
        assert!(!ok("https://example.com/x"));
    }

    #[test]
    fn long_notes_are_cut() {
        assert_eq!(short_notes(None), "");
        assert_eq!(short_notes(Some("  a\r\nb  ")), "a\nb");
        let long = "x".repeat(4000);
        let cut = short_notes(Some(&long));
        assert_eq!(cut.chars().count(), 1501);
        assert!(cut.ends_with('…'));
    }
}
