// Claude Code and the Antigravity CLI as Settings → Agents shows them: whether
// each is installed, which version, and a button that opens its own sign-in.
// Lumo never reads or keeps their sign-in: the CLI asks for it in a window of
// its own, as it would in a terminal.

use std::io::Read;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;

use crate::{antigravity_cli, claude_code, platform};

/// How long `--version` may take before the version shows as unknown.
const VERSION_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliInfo {
    pub installed: bool,
    /// Where it is installed, for the technical details.
    pub path: Option<String>,
    /// Its version, as `--version` says it ("2.1.3"); None when it didn't.
    pub version: Option<String>,
}

/// The CLI behind a chat provider, best first; None for any other provider.
fn candidates(provider: &str) -> Option<Vec<PathBuf>> {
    match provider {
        claude_code::PROVIDER => Some(platform::claude_candidates()),
        antigravity_cli::PROVIDER => Some(platform::agy_candidates()),
        _ => None,
    }
}

/// Whether `provider`'s CLI is installed, where, and which version. Blocking:
/// runs `<cli> --version`, with no window.
pub fn info(provider: &str) -> Option<CliInfo> {
    let exe = candidates(provider)?.into_iter().next();
    let Some(exe) = exe else {
        return Some(CliInfo { installed: false, path: None, version: None });
    };
    let version = version_of(&exe);
    Some(CliInfo { installed: true, path: Some(exe.to_string_lossy().into_owned()), version })
}

fn version_of(exe: &std::path::Path) -> Option<String> {
    let mut cmd = claude_code::cli_command(exe);
    cmd.arg("--version").stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    platform::no_console(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let Some(mut out) = child.stdout.take() else {
        claude_code::kill_tree(&mut child);
        return None;
    };
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = (&mut out).take(4096).read_to_string(&mut text);
        let _ = tx.send(text);
    });
    let text = rx.recv_timeout(VERSION_TIMEOUT).ok();
    claude_code::kill_tree(&mut child);
    parse_version(&text?)
}

/// The first version number in `text`: "2.1.3 (Claude Code)" → "2.1.3".
fn parse_version(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() && (i == 0 || !(bytes[i - 1].is_ascii_digit() || bytes[i - 1] == b'.')) {
            let mut end = i;
            let mut dots = 0;
            while end < bytes.len() && (bytes[end].is_ascii_digit() || (bytes[end] == b'.' && end + 1 < bytes.len() && bytes[end + 1].is_ascii_digit())) {
                if bytes[end] == b'.' {
                    dots += 1;
                }
                end += 1;
            }
            if dots >= 1 {
                return Some(text[i..end].to_string());
            }
            i = end.max(i + 1);
        } else {
            i += 1;
        }
    }
    None
}

/// Opens `provider`'s CLI in a window of its own, in the folder the island's
/// chat works in, where it asks the user to sign in (or `/login` does).
pub fn sign_in(provider: &str) -> Result<(), String> {
    let exe = candidates(provider)
        .ok_or_else(|| "unknown provider".to_string())?
        .into_iter()
        .next()
        .ok_or_else(|| crate::i18n::t("It isn't installed yet."))?;
    let dir = claude_code::work_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut cmd = claude_code::cli_command(&exe);
    cmd.current_dir(&dir);
    platform::new_console(&mut cmd);
    match cmd.spawn() {
        Ok(_) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_the_first_number_with_a_dot() {
        assert_eq!(parse_version("2.1.3 (Claude Code)\n").as_deref(), Some("2.1.3"));
        assert_eq!(parse_version("agy version 1.0.12").as_deref(), Some("1.0.12"));
        assert_eq!(parse_version("v0.9").as_deref(), Some("0.9"));
        assert_eq!(parse_version("build 42, 3.4.5").as_deref(), Some("3.4.5"));
        assert_eq!(parse_version("x64 tool").as_deref(), None);
        assert_eq!(parse_version("").as_deref(), None);
    }
}
