// Settings → Updates: is there a newer Windows build on GitHub, and if so,
// download its installer and run it.
//
// The check runs when Settings → Updates → Check for updates is clicked, and once
// when Lumo opens unless Settings turns that off (src/core/update-check.ts); no
// telemetry, nothing about this computer is sent. The download only ever starts
// from a click on Update now, and Settings shows its progress. The installer is
// the one this copy of Lumo came from, as the release workflow publishes it
// (.github/workflows/windows.yml, named by scripts/pack.mjs): the NSIS
// setup.exe, run without a window (INSTALLER_ARGS), or the .msi, through
// msiexec with its progress bar (MSI_ARGS). Running the setup.exe over an .msi
// install would leave a second Lumo beside the first. Lumo quits right after
// starting the installer so its files can be replaced, and the installer opens
// the new Lumo when it is done.
//
// The beta channel (Settings → Updates → Beta versions, off unless turned on)
// is one more release, the `windows-beta` pre-release that
// .github/workflows/windows-beta.yml publishes: main with every open pull
// request merged in, versioned as the next patch with the build's number
// (0.18.1-312). Its notes carry the list of what is in it, which Settings
// shows. A beta never takes the place of a newer release: 0.18.1 is newer than
// 0.18.1-312, so the release comes as a plain update. Going back from a beta
// to the release before it is the one install of an older version allowed.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::i18n::{t, tf};
use crate::{log, net};

/// The GitHub repository whose releases are checked: the one place it is named.
pub const UPDATE_REPO: &str = "Rccrd12/Lumo";

/// Windows releases are tagged `windows-v0.2.1` (the `windows-latest` rolling
/// release does not match, and neither does any other tag, like a plain `v*`).
const TAG_PREFIX: &str = "windows-v";

/// The beta channel's one pre-release, replaced by every beta build.
const BETA_TAG: &str = "windows-beta";

/// Where the beta's notes hold the list of what is in it, as JSON, up to ` -->`
/// (scripts/beta.mjs BETA_MARK).
const BETA_MARK: &str = "<!-- lumo-beta ";

/// Hosts a release download may come from: github.com, then the CDN it redirects to.
const DOWNLOAD_HOSTS: [&str; 3] = [
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

/// How the downloaded installer runs. These are switches of Tauri's NSIS
/// template: `/S` without any window, `/UPDATE` over the installed Lumo as it
/// is (no question about reinstalling, the shortcuts and the WebView left
/// alone), `/R` opens Lumo again once the files are replaced.
const INSTALLER_ARGS: [&str; 3] = ["/S", "/UPDATE", "/R"];

/// How msiexec runs a downloaded .msi, after `/i <file>`: a progress bar and
/// no question (`/passive`), never a restart of the computer, and Tauri's WiX
/// template opens Lumo again when it is done (AUTOLAUNCHAPP). The .msi
/// installs for every user, so Windows asks for an administrator's consent.
const MSI_ARGS: [&str; 3] = ["/passive", "/norestart", "AUTOLAUNCHAPP=True"];

/// The .msi's upgrade code (bundle.windows.wix.upgradeCode in tauri.conf.json):
/// Windows Installer knows Lumo by it.
const MSI_UPGRADE_CODE: &str = "{664695E2-338F-541B-8D41-6266D176533C}";

/// The two installers a release carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// `Lumo-Windows-<v>-setup.exe`, NSIS, for the current user.
    Setup,
    /// `Lumo-Windows-<v>.msi`, Windows Installer, for every user.
    Msi,
}

impl Kind {
    fn suffix(self) -> &'static str {
        match self {
            Kind::Setup => "-setup.exe",
            Kind::Msi => ".msi",
        }
    }
}

/// Which installer this copy of Lumo came from. The setup.exe leaves its
/// uninstall.exe beside lumo.exe; without one, a Lumo that Windows Installer
/// knows came from the .msi. Anything else (a build run from its folder) takes
/// the setup.exe, which needs no administrator.
fn installed_kind() -> Kind {
    let setup = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|dir| dir.join("uninstall.exe").is_file()))
        .unwrap_or(false);
    if !setup && crate::platform::msi_installed(MSI_UPGRADE_CODE) {
        Kind::Msi
    } else {
        Kind::Setup
    }
}

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
    /// The release's installer of the kind this copy came from:
    /// `Lumo-Windows-<latest>-setup.exe` or `Lumo-Windows-<latest>.msi`.
    asset_url: Option<String>,
    /// This build is a beta (its version has a pre-release part).
    current_beta: bool,
    /// The beta channel's build, when it was asked for and one is published.
    beta: Option<BetaInfo>,
}

/// The beta channel's build, for Settings.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BetaInfo {
    /// `0.18.1-312`.
    version: String,
    /// True when it is newer than this build.
    newer: bool,
    /// When GitHub published it.
    published_at: String,
    /// Its installer of the kind this copy came from.
    asset_url: Option<String>,
    /// The pull requests merged into it.
    included: Vec<BetaPull>,
    /// The open pull requests left out, with what each conflicts with.
    excluded: Vec<BetaPull>,
}

/// One pull request in (or left out of) the beta, as its notes list it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BetaPull {
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    updated_at: String,
    /// What a pull request left out conflicts with: "main", or another one's number.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    with: Option<String>,
    /// Why it was left out: "conflict", "checks" (its Windows CI failed) or
    /// "pending" (its checks were still running).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Deserialize, Default)]
struct BetaManifest {
    #[serde(default)]
    included: Vec<BetaPull>,
    #[serde(default)]
    excluded: Vec<BetaPull>,
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
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    #[serde(default)]
    name: String,
    #[serde(default)]
    browser_download_url: String,
    /// What GitHub computed of the file when it was published: `sha256:<hex>`.
    #[serde(default)]
    digest: Option<String>,
}

/// The SHA-256 GitHub published for each installer the last check offered,
/// by download address: the downloaded file must match it (download_and_run).
static DIGESTS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// The hex of a `sha256:<hex>` digest, lower case; None for anything else.
fn sha256_of(digest: &str) -> Option<String> {
    let hex = digest.trim().strip_prefix("sha256:")?.to_ascii_lowercase();
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then_some(hex)
}

/// Keeps the digests of every installer in `releases`.
fn remember_digests(releases: &[Release]) {
    let found: HashMap<String, String> = releases
        .iter()
        .flat_map(|r| r.assets.iter())
        .filter_map(|a| Some((a.browser_download_url.clone(), sha256_of(a.digest.as_deref()?)?)))
        .collect();
    DIGESTS.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).extend(found);
}

fn expected_digest(url: &Url) -> Option<String> {
    DIGESTS.lock().unwrap_or_else(|e| e.into_inner()).as_ref()?.get(url.as_str()).cloned()
}

/// A version as the release tags and Cargo write it: `1.2.3`, `1.2.3-beta.1`,
/// `1.2.3-312`. A pre-release sorts before the release it leads to, and
/// pre-releases sort as semver says: part by part, numbers as numbers
/// (`-312` before `-1000`), a number before a word.
#[derive(Debug, Clone, PartialEq, Eq)]
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

impl Version {
    fn is_beta(&self) -> bool {
        !self.release
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (self.major, self.minor, self.patch, self.release)
            .cmp(&(other.major, other.minor, other.patch, other.release))
            .then_with(|| compare_pre(&self.pre, &other.pre))
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

fn compare_pre(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let mut a = a.split('.');
    let mut b = b.split('.');
    loop {
        match (a.next(), b.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(x), Some(y)) => {
                let order = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(x), Ok(y)) => x.cmp(&y),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => x.cmp(y),
                };
                if order != Ordering::Equal {
                    return order;
                }
            }
        }
    }
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

/// What an installer's file name starts with, as scripts/pack.mjs writes it;
/// it ends with its kind's suffix.
const INSTALLER_PREFIX: &str = "Lumo-Windows-";

/// The installer's name for `version`.
fn installer_name(version: &str, kind: Kind) -> String {
    format!("{INSTALLER_PREFIX}{version}{}", kind.suffix())
}

/// The version in the middle of an installer's file name, and its kind.
fn installer_middle(name: &str) -> Option<(&str, Kind)> {
    let rest = name.strip_prefix(INSTALLER_PREFIX)?;
    [Kind::Setup, Kind::Msi]
        .into_iter()
        .find_map(|kind| rest.strip_suffix(kind.suffix()).map(|middle| (middle, kind)))
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

/// The download address of `release`'s asset named `name`, when it is one
/// `update_install` accepts.
fn asset_url(release: &Release, name: &str) -> Option<String> {
    release
        .assets
        .iter()
        .find(|a| a.name == name)
        .map(|a| a.browser_download_url.clone())
        .filter(|u| Url::parse(u).is_ok_and(|u| is_release_download(&u)))
}

/// The beta channel's build in GitHub's list, when one is published.
fn beta_build(releases: &[Release], mine: Option<&Version>, kind: Kind) -> Option<BetaInfo> {
    let release = releases.iter().find(|r| r.tag_name == BETA_TAG && !r.draft)?;
    // Its version is in its installers' names (scripts/pack.mjs); a beta's has a pre-release.
    let (version, raw) = release
        .assets
        .iter()
        .filter_map(|a| {
            let (middle, k) = installer_middle(&a.name)?;
            let version = parse_version(middle).filter(|v| v.is_beta())?;
            (k == kind && installer_kind(&a.name).is_some()).then(|| (version, middle.to_string()))
        })
        .max_by(|a, b| a.0.cmp(&b.0))?;
    let manifest = beta_manifest(release.body.as_deref().unwrap_or(""));
    Some(BetaInfo {
        newer: mine.is_none_or(|mine| version > *mine),
        asset_url: asset_url(release, &installer_name(&raw, kind)),
        version: raw,
        published_at: release.published_at.clone().unwrap_or_default(),
        included: manifest.included,
        excluded: manifest.excluded,
    })
}

/// The list in a beta's notes; an empty one when there is none or it cannot be read.
fn beta_manifest(body: &str) -> BetaManifest {
    let Some(start) = body.find(BETA_MARK) else {
        return BetaManifest::default();
    };
    let rest = &body[start + BETA_MARK.len()..];
    let Some(end) = rest.find("-->") else {
        return BetaManifest::default();
    };
    let mut manifest: BetaManifest = serde_json::from_str(rest[..end].trim()).unwrap_or_default();
    const MAX: usize = 100;
    manifest.included.truncate(MAX);
    manifest.excluded.truncate(MAX);
    manifest
}

fn compare(current: &str, releases: Vec<Release>, kind: Kind, beta: bool) -> Result<UpdateInfo, String> {
    let mine = parse_version(current);
    let beta = if beta { beta_build(&releases, mine.as_ref(), kind) } else { None };
    let Some((latest, raw, release)) = newest_windows_release(releases) else {
        return Err(t("No Windows release has been published yet."));
    };
    let newer = mine.as_ref().is_none_or(|mine| latest > *mine);
    let asset_url = asset_url(&release, &installer_name(&raw, kind));
    Ok(UpdateInfo {
        current: current.to_string(),
        latest: raw,
        newer,
        notes: short_notes(release.body.as_deref()),
        asset_url,
        current_beta: mine.is_some_and(|v| v.is_beta()),
        beta,
    })
}

/// True for `https://github.com/<UPDATE_REPO>/releases/download/<tag>/Lumo-Windows-<v>-setup.exe`
/// (or `….msi`): the only addresses `update_install` starts a download from.
/// The tag is `windows-v<v>`, or `windows-beta` for a beta's installer.
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
    let Some(kind) = installer_kind(file) else {
        return false;
    };
    if tag == BETA_TAG {
        return installer_middle(file).and_then(|(middle, _)| parse_version(middle)).is_some_and(|v| v.is_beta());
    }
    tag.starts_with(TAG_PREFIX) && installer_name(&tag[TAG_PREFIX.len()..], kind) == file
}

/// The version an accepted installer address carries.
fn installer_version(url: &Url) -> Option<Version> {
    let file = url.path_segments()?.next_back()?;
    parse_version(installer_middle(file)?.0)
}

/// The kind of `Lumo-Windows-<version>-setup.exe` or `Lumo-Windows-<version>.msi`,
/// with nothing but a version in the middle; None for any other name.
fn installer_kind(name: &str) -> Option<Kind> {
    let (middle, kind) = installer_middle(name)?;
    let plain = !middle.is_empty() && middle.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    (plain && parse_version(middle).is_some()).then_some(kind)
}

/// Where a redirect may lead while downloading: GitHub and its release CDN, over https.
fn is_download_host(url: &Url) -> bool {
    url.scheme() == "https" && url.host_str().is_some_and(|h| DOWNLOAD_HOSTS.contains(&h))
}

fn user_agent(app: &AppHandle) -> String {
    format!("Lumo/{} (+https://github.com/{UPDATE_REPO})", app.package_info().version)
}

/// Settings → Updates → Check for updates, and the check when Lumo opens. Asks GitHub for the repository's
/// releases (one anonymous request, nothing about this computer in it) and
/// compares the newest Windows one with this build; with `beta`, the beta
/// channel's build too.
#[tauri::command]
pub async fn update_check(app: AppHandle, beta: Option<bool>) -> Result<UpdateInfo, String> {
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
    remember_digests(&releases);
    let kind = installed_kind();
    let info = compare(&current, releases, kind, beta == Some(true))?;
    log::line(format!(
        "update check: current {} latest {} newer {} beta {} ({kind:?})",
        info.current,
        info.latest,
        info.newer,
        info.beta.as_ref().map_or("-", |b| b.version.as_str())
    ));
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

/// Settings → Updates → Update now (and Install the beta, Back to the
/// release). Downloads the installer `update_check` found into a temporary
/// folder, starts it, then quits so it can replace Lumo's files; the installer
/// opens Lumo again. Only GitHub release downloads of this repository are
/// accepted.
#[tauri::command]
pub async fn update_install(app: AppHandle, url: String) -> Result<(), String> {
    let url = Url::parse(url.trim()).map_err(|_| t("Only installers from Lumo's GitHub releases can be installed."))?;
    if !is_release_download(&url) {
        return Err(t("Only installers from Lumo's GitHub releases can be installed."));
    }
    let current = parse_version(&app.package_info().version.to_string());
    if let (Some(offered), Some(current)) = (installer_version(&url), current) {
        if !may_install(&current, &offered) {
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

/// Never an older (or the same) build than the one running, but for going
/// back from a beta to a release.
fn may_install(current: &Version, offered: &Version) -> bool {
    offered > current || (current.is_beta() && !offered.is_beta())
}

async fn download_and_run(app: &AppHandle, url: Url) -> Result<(), String> {
    let file_name = url
        .path_segments()
        .and_then(|mut s| s.next_back())
        .ok_or_else(|| t("Only installers from Lumo's GitHub releases can be installed."))?
        .to_string();
    let kind = installer_kind(&file_name)
        .ok_or_else(|| t("Only installers from Lumo's GitHub releases can be installed."))?;

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
    // An NSIS installer is a Windows program, which starts with "MZ"; an .msi
    // is a compound file, which starts with its own signature.
    let signature: &[u8] = match kind {
        Kind::Setup => b"MZ",
        Kind::Msi => &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1],
    };
    if !bytes.starts_with(signature) {
        return Err(tf("The download failed: {error}", &[("error", "not an installer")]));
    }
    // Byte for byte the file GitHub published, when it said what that is
    // (every release since GitHub computes it): a changed file is never run.
    match expected_digest(&url) {
        Some(expected) => {
            if crate::platform::sha256_hex(&bytes).as_deref() != Some(expected.as_str()) {
                log::line(format!("update: {file_name} does not match GitHub's SHA-256, not installed"));
                return Err(t("The downloaded installer does not match the one GitHub published."));
            }
        }
        None => log::line(format!("update: GitHub gave no SHA-256 for {file_name}")),
    }
    let _ = app.emit("update-progress", Progress { received: bytes.len() as u64, total: bytes.len() as u64 });

    // %TEMP%\Lumo-update\Lumo-Windows-<v>-setup.exe (or .msi); installers from
    // earlier updates are cleared first.
    let dir = std::env::temp_dir().join("Lumo-update");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| tf("Could not save the installer: {error}", &[("error", &e.to_string())]))?;
    let path = dir.join(&file_name);
    let partial = dir.join(format!("{file_name}.part"));
    std::fs::write(&partial, &bytes).map_err(|e| tf("Could not save the installer: {error}", &[("error", &e.to_string())]))?;
    std::fs::rename(&partial, &path).map_err(|e| tf("Could not save the installer: {error}", &[("error", &e.to_string())]))?;
    log::line(format!("update: downloaded {} ({} bytes)", file_name, bytes.len()));

    let mut command = match kind {
        // The NSIS installer is per-user, so no admin prompt either.
        Kind::Setup => {
            let mut c = std::process::Command::new(&path);
            c.args(INSTALLER_ARGS);
            c
        }
        Kind::Msi => {
            let system = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
            let mut c = std::process::Command::new(std::path::Path::new(&system).join("System32").join("msiexec.exe"));
            c.arg("/i").arg(&path).args(MSI_ARGS);
            c
        }
    };
    command
        .current_dir(&dir)
        .spawn()
        .map_err(|e| tf("Could not start the installer: {error}", &[("error", &e.to_string())]))?;
    log::line(format!("update: {kind:?} installer started, quitting"));
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
            published_at: None,
            assets: assets
                .iter()
                .map(|name| Asset {
                    name: (*name).into(),
                    browser_download_url: format!("https://github.com/{UPDATE_REPO}/releases/download/{tag}/{name}"),
                    digest: None,
                })
                .collect(),
        }
    }

    #[test]
    fn an_installer_is_checked_against_githubs_sha256() {
        let hex = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        // Windows' own SHA-256 gives the standard answer ("abc").
        assert_eq!(crate::platform::sha256_hex(b"abc").as_deref(), Some(hex));
        assert_eq!(sha256_of(&format!("sha256:{}", hex.to_uppercase())).as_deref(), Some(hex));
        assert_eq!(sha256_of("sha512:abc"), None);
        assert_eq!(sha256_of("sha256:1234"), None);
        let mut r = release("v9.9.9", &["Lumo-Windows-9.9.9-setup.exe", "Lumo-Windows-9.9.9.msi"]);
        r.assets[0].digest = Some(format!("sha256:{hex}"));
        remember_digests(&[r]);
        let url = |name: &str| Url::parse(&format!("https://github.com/{UPDATE_REPO}/releases/download/v9.9.9/{name}")).unwrap();
        assert_eq!(expected_digest(&url("Lumo-Windows-9.9.9-setup.exe")).as_deref(), Some(hex));
        assert_eq!(expected_digest(&url("Lumo-Windows-9.9.9.msi")), None);
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
            release("windows-v0.2.1", &["Lumo-Windows-0.2.1-setup.exe", "Lumo-Windows-0.2.1.msi"]),
            release("windows-latest", &["Lumo-Windows-setup.exe"]),
            release("v0.5.0", &["Lumo.dmg"]),
            release("windows-v0.3.1", &["Lumo-Windows-0.3.1.msi", "Lumo-Windows-0.3.1-setup.exe"]),
            release("windows-v0.3.0", &["Lumo-Windows-0.3.0-setup.exe"]),
            beta,
        ];
        let info = compare("0.2.0", releases, Kind::Setup, false).unwrap();
        assert_eq!(info.latest, "0.3.1");
        assert!(info.newer);
        assert_eq!(info.notes, "Notes");
        assert_eq!(
            info.asset_url.as_deref(),
            Some(format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.1/Lumo-Windows-0.3.1-setup.exe").as_str())
        );
    }

    #[test]
    fn an_msi_install_is_offered_the_msi() {
        let releases = vec![release("windows-v0.3.1", &["Lumo-Windows-0.3.1-setup.exe", "Lumo-Windows-0.3.1.msi"])];
        let info = compare("0.2.0", releases, Kind::Msi, false).unwrap();
        assert_eq!(
            info.asset_url.as_deref(),
            Some(format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.1/Lumo-Windows-0.3.1.msi").as_str())
        );
        // A release without its .msi offers nothing rather than the setup.exe.
        let info = compare("0.2.0", vec![release("windows-v0.3.1", &["Lumo-Windows-0.3.1-setup.exe"])], Kind::Msi, false).unwrap();
        assert!(info.newer);
        assert_eq!(info.asset_url, None);
    }

    #[test]
    fn the_upgrade_code_is_the_msi_s() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let code = conf["bundle"]["windows"]["wix"]["upgradeCode"].as_str().unwrap();
        assert_eq!(MSI_UPGRADE_CODE, format!("{{{}}}", code.to_ascii_uppercase()));
    }

    #[test]
    fn the_same_or_an_older_release_is_not_newer() {
        let info = compare("0.3.0", vec![release("windows-v0.3.0", &["Lumo-Windows-0.3.0-setup.exe"])], Kind::Setup, false).unwrap();
        assert!(!info.newer);
        let info = compare("0.4.0", vec![release("windows-v0.3.0", &[])], Kind::Setup, false).unwrap();
        assert!(!info.newer);
        assert_eq!(info.asset_url, None);
        assert!(compare("0.2.0", vec![release("windows-latest", &[])], Kind::Setup, false).is_err());
        assert!(compare("0.2.0", vec![], Kind::Setup, false).is_err());
    }

    #[test]
    fn only_this_repositorys_installers_are_downloaded() {
        let ok = |s: &str| is_release_download(&Url::parse(s).unwrap());
        assert!(ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.1/Lumo-Windows-0.3.1-setup.exe")));
        assert!(ok("https://github.com/rccrd12/lumo/releases/download/windows-v0.3.1/Lumo-Windows-0.3.1-setup.exe"));
        // Another repository, host, scheme, file or tag.
        assert!(!ok("https://github.com/someone/else/releases/download/windows-v0.3.1/Lumo-Windows-0.3.1-setup.exe"));
        assert!(!ok(&format!("https://evil.example/{UPDATE_REPO}/releases/download/windows-v0.3.1/Lumo-Windows-0.3.1-setup.exe")));
        assert!(!ok(&format!("http://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.1/Lumo-Windows-0.3.1-setup.exe")));
        assert!(ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.1/Lumo-Windows-0.3.1.msi")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.1/Lumo-Windows.msi")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.4.0/Lumo-Windows-0.3.1.msi")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.1/payload.exe")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/v0.3.1/Lumo-Windows-0.3.1-setup.exe")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.1/x/Lumo-Windows-0.3.1-setup.exe")));
        assert!(!ok(&format!("https://github.com:8443/{UPDATE_REPO}/releases/download/windows-v0.3.1/Lumo-Windows-0.3.1-setup.exe")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.1/Lumo-Windows-0.3.1-setup.exe?x=1")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.1/Lumo-Windows-..-setup.exe")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.3.1/Lumo-0.3.1-setup.exe")));
        // The file must carry its tag's version.
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.4.0/Lumo-Windows-0.3.1-setup.exe")));
        let url = Url::parse(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.4.1/Lumo-Windows-0.4.1-setup.exe")).unwrap();
        assert_eq!(installer_version(&url), parse_version("0.4.1"));
        let url = Url::parse(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.4.1/Lumo-Windows-0.4.1.msi")).unwrap();
        assert_eq!(installer_version(&url), parse_version("0.4.1"));
        assert_eq!(installer_kind("Lumo-Windows-0.4.1-setup.exe"), Some(Kind::Setup));
        assert_eq!(installer_kind("Lumo-Windows-0.4.1.msi"), Some(Kind::Msi));
        assert_eq!(installer_kind("Other-Windows-0.4.1-setup.exe"), None);
        assert_eq!(installer_kind("Lumo-Windows-setup.exe"), None);
        assert_eq!(installer_kind("Lumo-Windows.msi"), None);
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

    fn beta(version: &str, body: &str) -> Release {
        let mut r = release(BETA_TAG, &[&format!("Lumo-Windows-{version}-setup.exe"), &format!("Lumo-Windows-{version}.msi")]);
        r.prerelease = true;
        r.body = Some(body.into());
        r.published_at = Some("2026-11-08T11:00:00Z".into());
        r
    }

    const BETA_BODY: &str = "In this beta:\n- #146 Web search\n\n<!-- lumo-beta {\"version\":\"0.18.1-312\",\"included\":[{\"number\":146,\"title\":\"Web search \\u003c/b\\u003e --\\u003e\",\"updatedAt\":\"2026-11-08T10:00:00Z\"}],\"excluded\":[{\"number\":148,\"title\":\"Models\",\"updatedAt\":\"x\",\"reason\":\"conflict\",\"with\":\"146\"},{\"number\":149,\"title\":\"Red\",\"updatedAt\":\"y\",\"reason\":\"checks\"}]} -->";

    #[test]
    fn pre_releases_order_part_by_part() {
        let v = |s: &str| parse_version(s).unwrap();
        assert!(v("0.18.1-1000") > v("0.18.1-312"));
        assert!(v("0.18.1-312") > v("0.18.1-99"));
        assert!(v("0.18.1") > v("0.18.1-65535"));
        assert!(v("0.18.1-312") > v("0.18.0"));
        assert!(v("1.0.0-beta") > v("1.0.0-2"));
        assert!(v("1.0.0-beta.11") > v("1.0.0-beta.2"));
        assert!(v("1.0.0-alpha.1") > v("1.0.0-alpha"));
    }

    #[test]
    fn the_beta_is_read_only_when_asked_for() {
        let releases = || vec![release("windows-v0.18.0", &["Lumo-Windows-0.18.0-setup.exe"]), beta("0.18.1-312", BETA_BODY)];
        let info = compare("0.18.0", releases(), Kind::Setup, false).unwrap();
        assert_eq!(info.latest, "0.18.0", "the beta is never the release");
        assert!(!info.newer);
        assert_eq!(info.beta, None);
        assert!(!info.current_beta);

        let info = compare("0.18.0", releases(), Kind::Setup, true).unwrap();
        let b = info.beta.unwrap();
        assert_eq!(b.version, "0.18.1-312");
        assert!(b.newer);
        assert_eq!(b.published_at, "2026-11-08T11:00:00Z");
        assert_eq!(
            b.asset_url.as_deref(),
            Some(format!("https://github.com/{UPDATE_REPO}/releases/download/windows-beta/Lumo-Windows-0.18.1-312-setup.exe").as_str())
        );
        assert_eq!(b.included.len(), 1);
        assert_eq!(b.included[0].number, 146);
        assert_eq!(b.included[0].title, "Web search </b> -->");
        assert_eq!(b.excluded[0].with.as_deref(), Some("146"));
        assert_eq!(b.excluded[1].reason.as_deref(), Some("checks"));
        assert_eq!(b.excluded[1].with, None);

        let msi = compare("0.18.0", releases(), Kind::Msi, true).unwrap().beta.unwrap();
        assert!(msi.asset_url.unwrap().ends_with("/windows-beta/Lumo-Windows-0.18.1-312.msi"));
    }

    #[test]
    fn on_a_beta_the_release_after_it_is_an_update() {
        let releases = vec![release("windows-v0.18.1", &["Lumo-Windows-0.18.1-setup.exe"]), beta("0.18.1-312", "")];
        let info = compare("0.18.1-312", releases, Kind::Setup, true).unwrap();
        assert!(info.current_beta);
        assert!(info.newer, "0.18.1 is newer than its beta");
        let b = info.beta.unwrap();
        assert!(!b.newer);
        assert!(b.included.is_empty(), "notes without the list read as an empty one");

        // The release before the beta: offered to go back to, never as newer.
        let info = compare("0.18.1-312", vec![release("windows-v0.18.0", &["Lumo-Windows-0.18.0-setup.exe"])], Kind::Setup, true).unwrap();
        assert!(!info.newer);
        assert!(info.asset_url.is_some());
        assert_eq!(info.beta, None);
    }

    #[test]
    fn only_going_back_from_a_beta_installs_an_older_version() {
        let v = |s: &str| parse_version(s).unwrap();
        assert!(may_install(&v("0.18.0"), &v("0.18.1")));
        assert!(may_install(&v("0.18.0"), &v("0.18.1-312")));
        assert!(may_install(&v("0.18.1-312"), &v("0.18.1-318")));
        assert!(may_install(&v("0.18.1-312"), &v("0.18.0")), "back to the release");
        assert!(!may_install(&v("0.18.0"), &v("0.18.0")));
        assert!(!may_install(&v("0.18.1"), &v("0.18.0")));
        assert!(!may_install(&v("0.18.1"), &v("0.18.1-312")));
        assert!(!may_install(&v("0.18.1-318"), &v("0.18.1-312")), "an older beta, no");
    }

    #[test]
    fn beta_installers_come_only_from_the_beta_release() {
        let ok = |s: &str| is_release_download(&Url::parse(s).unwrap());
        assert!(ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-beta/Lumo-Windows-0.18.1-312-setup.exe")));
        assert!(ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-beta/Lumo-Windows-0.18.1-312.msi")));
        // A release's installer is not a beta's, and the other way round.
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-beta/Lumo-Windows-0.18.1-setup.exe")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-v0.18.1/Lumo-Windows-0.18.1-312-setup.exe")));
        assert!(!ok("https://github.com/someone/else/releases/download/windows-beta/Lumo-Windows-0.18.1-312-setup.exe"));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-beta/payload.exe")));
        assert!(!ok(&format!("https://github.com/{UPDATE_REPO}/releases/download/windows-beta-2/Lumo-Windows-0.18.1-312-setup.exe")));
    }

    #[test]
    fn a_broken_list_in_the_notes_reads_as_empty() {
        assert!(beta_manifest("").included.is_empty());
        assert!(beta_manifest("<!-- lumo-beta {not json -->").included.is_empty());
        assert!(beta_manifest("<!-- lumo-beta {\"included\":[]}").included.is_empty());
        assert_eq!(beta_manifest(BETA_BODY).included.len(), 1);
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
