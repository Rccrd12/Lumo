//! Sessions another program starts on its own, not the user in a terminal: a
//! tool that asks `claude -p` about a hundred files, eight at a time, an app
//! built on the Agent SDK. The island groups them under that program (one row,
//! no sound or alert for every answer), so the relay says which they are and,
//! when it can, which program started them.
//!
//! * Claude Code says so itself: `-p` and the Agent SDKs set
//!   CLAUDE_CODE_ENTRYPOINT to `sdk-cli`, `sdk-ts` or `sdk-py`.
//! * Any program can say so for any agent with `LUMO_BACKGROUND=1` (and `0`
//!   to have its sessions shown one by one after all), and give its own name
//!   with `LUMO_LAUNCHER`.
//! * A program that knows how many questions it will ask in all says so with
//!   `LUMO_BATCH_TOTAL`, and the island shows how far along it is.
//! * Otherwise the name is the first process above the relay that is neither
//!   the agent, its runtime nor a shell. A terminal or an editor up there means
//!   a person started it: no name, the island says "In background".

/// Claude Code's entry points when nobody is typing to it.
const HEADLESS_ENTRYPOINTS: &[&str] = &["sdk-cli", "sdk-ts", "sdk-py"];

/// Longest program name passed on.
const MAX_NAME: usize = 40;

/// How many processes up the chain are looked at.
pub const MAX_DEPTH: usize = 12;

/// Between the relay and the program that started the agent: the agent
/// itself, the runtime it is installed with, the shell that ran the hook.
const IN_BETWEEN: &[&str] = &[
    "lumo-hook", "claude", "codex", "agy", "gemini", "copilot", "cursor-agent", "opencode", "amp", "hermes",
    "node", "bun", "deno", "npx", "pnpm", "yarn", "uv", "uvx", "cmd", "powershell", "pwsh", "bash", "sh", "zsh",
    "conhost", "openconsole", "git-bash", "mintty", "wsl", "wslhost",
];

/// Where a person is: their terminal, their editor, the desktop. The session
/// was started by hand, through whatever is below them.
const BY_HAND: &[&str] = &[
    "windowsterminal", "explorer", "code", "code - insiders", "cursor", "windsurf", "idea64", "pycharm64",
    "webstorm64", "rider64", "zed", "alacritty", "wezterm-gui", "hyper", "tabby", "warp", "lumo", "claude-desktop",
    "services", "svchost", "wininit", "sihost", "userinit",
];

/// The session runs on its own, started by a program and not by the user.
pub fn is_background(agent: &str, env: &dyn Fn(&str) -> Option<String>) -> bool {
    match env("LUMO_BACKGROUND").as_deref().map(str::trim) {
        Some("1") => return true,
        Some("0") => return false,
        _ => {}
    }
    // Claude Code's own variable: only Claude Code's hooks read it, so an agent
    // a headless Claude Code happened to start is not taken for one.
    agent.is_empty()
        && env("CLAUDE_CODE_ENTRYPOINT").is_some_and(|e| HEADLESS_ENTRYPOINTS.contains(&e.trim()))
}

/// Most questions a batch may say it has.
const MAX_TOTAL: u32 = 1_000_000;

/// How many questions the program will ask in all, when it says (LUMO_BATCH_TOTAL).
pub fn batch_total(env: &dyn Fn(&str) -> Option<String>) -> Option<u32> {
    env("LUMO_BATCH_TOTAL")?.trim().parse::<u32>().ok().filter(|n| (1..=MAX_TOTAL).contains(n))
}

/// The program's name: LUMO_LAUNCHER, else read from `chain` (the executables
/// above the relay, nearest first), which is only asked for when needed.
pub fn launcher(env: &dyn Fn(&str) -> Option<String>, chain: impl FnOnce() -> Vec<String>) -> Option<String> {
    if let Some(name) = env("LUMO_LAUNCHER").map(|n| clean(&n)).filter(|n| !n.is_empty()) {
        return Some(name);
    }
    from_chain(&chain())
}

/// The first executable of `chain` that started the agent, as a name to show.
pub fn from_chain(chain: &[String]) -> Option<String> {
    for exe in chain.iter().take(MAX_DEPTH) {
        let stem = stem(exe);
        if stem.is_empty() || IN_BETWEEN.contains(&stem.as_str()) {
            continue;
        }
        if BY_HAND.contains(&stem.as_str()) {
            return None;
        }
        let name = pretty(exe);
        return (!name.is_empty()).then_some(name);
    }
    None
}

/// The executable's name, lowercase, without its folder or `.exe`.
fn stem(exe: &str) -> String {
    let file = exe.rsplit(['/', '\\']).next().unwrap_or_default().trim().to_ascii_lowercase();
    file.strip_suffix(".exe").unwrap_or(&file).to_string()
}

/// `easy-uninstaller.exe` → `Easy Uninstaller`; a name with capitals of its
/// own (`MyTool.exe`) keeps them.
pub fn pretty(exe: &str) -> String {
    let file = exe.rsplit(['/', '\\']).next().unwrap_or_default().trim();
    let base = if file.to_ascii_lowercase().ends_with(".exe") { &file[..file.len() - 4] } else { file };
    let words: Vec<String> = base
        .split(['-', '_', '.', ' '])
        .filter(|w| !w.is_empty())
        .map(|w| {
            if w.chars().any(|c| c.is_uppercase()) {
                w.to_string()
            } else {
                let mut c = w.chars();
                c.next().map(|f| f.to_uppercase().chain(c).collect()).unwrap_or_default()
            }
        })
        .collect();
    clean(&words.join(" "))
}

/// One line of at most MAX_NAME characters, no control characters.
fn clean(name: &str) -> String {
    let one: String = name.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    one.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(MAX_NAME).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(vars: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |name| vars.iter().find(|(k, _)| *k == name).map(|(_, v)| v.to_string())
    }

    fn chain(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn claude_code_run_with_p_or_the_sdk_is_in_the_background() {
        assert!(is_background("", &env_of(&[("CLAUDE_CODE_ENTRYPOINT", "sdk-cli")])));
        assert!(is_background("", &env_of(&[("CLAUDE_CODE_ENTRYPOINT", "sdk-ts")])));
        assert!(is_background("", &env_of(&[("CLAUDE_CODE_ENTRYPOINT", "sdk-py")])));
        // In a terminal, or in the Claude app: a person is there.
        assert!(!is_background("", &env_of(&[("CLAUDE_CODE_ENTRYPOINT", "cli")])));
        assert!(!is_background("", &env_of(&[("CLAUDE_CODE_ENTRYPOINT", "claude-desktop")])));
        assert!(!is_background("", &|_| None));
        // Another agent's hook does not go by Claude Code's variable.
        assert!(!is_background("codex", &env_of(&[("CLAUDE_CODE_ENTRYPOINT", "sdk-cli")])));
    }

    #[test]
    fn any_program_can_say_so_or_say_otherwise() {
        assert!(is_background("codex", &env_of(&[("LUMO_BACKGROUND", "1")])));
        assert!(!is_background("", &env_of(&[("LUMO_BACKGROUND", "0"), ("CLAUDE_CODE_ENTRYPOINT", "sdk-cli")])));
    }

    #[test]
    fn the_program_is_the_first_one_above_the_agent_and_its_shells() {
        let c = chain(&["bash.exe", "claude.exe", "cmd.exe", "easy-uninstaller.exe", "explorer.exe"]);
        assert_eq!(from_chain(&c).as_deref(), Some("Easy Uninstaller"));
        let c = chain(&["node.exe", "MyTool.exe"]);
        assert_eq!(from_chain(&c).as_deref(), Some("MyTool"));
        let c = chain(&["C:\\Python313\\python.exe"]);
        assert_eq!(from_chain(&c).as_deref(), Some("Python"));
    }

    #[test]
    fn started_from_a_terminal_or_an_editor_it_has_no_name() {
        assert_eq!(from_chain(&chain(&["claude.exe", "pwsh.exe", "WindowsTerminal.exe"])), None);
        assert_eq!(from_chain(&chain(&["claude.exe", "Code.exe"])), None);
        assert_eq!(from_chain(&[]), None);
    }

    #[test]
    fn the_program_may_say_how_many_questions_in_all() {
        assert_eq!(batch_total(&env_of(&[("LUMO_BATCH_TOTAL", " 120 ")])), Some(120));
        assert_eq!(batch_total(&env_of(&[("LUMO_BATCH_TOTAL", "0")])), None);
        assert_eq!(batch_total(&env_of(&[("LUMO_BATCH_TOTAL", "-3")])), None);
        assert_eq!(batch_total(&env_of(&[("LUMO_BATCH_TOTAL", "lots")])), None);
        assert_eq!(batch_total(&|_| None), None);
    }

    #[test]
    fn the_program_may_name_itself() {
        let env = env_of(&[("LUMO_LAUNCHER", "  Easy\nUninstaller  ")]);
        assert_eq!(launcher(&env, || panic!("not needed")).as_deref(), Some("Easy Uninstaller"));
        assert_eq!(launcher(&|_| None, || chain(&["claude.exe", "foo_bar.exe"])).as_deref(), Some("Foo Bar"));
        let long = "x".repeat(100);
        assert_eq!(pretty(&long).chars().count(), MAX_NAME);
    }
}
