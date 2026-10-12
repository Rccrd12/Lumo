// The operating system's calls, behind one set of names: the rest of the app
// calls `platform::…` and never touches Win32 directly.

use std::path::PathBuf;

mod windows;
pub use self::windows::*;

/// Wall-clock time in the user's time zone, for log lines and backup names.
pub struct LocalTime {
    pub year: u32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

/// The user's home directory, where `.claude/settings.json` lives.
pub fn home_dir() -> PathBuf {
    std::env::var_os(HOME_VAR)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// How the desktop Mochi's window can be placed and clicked on this system.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DesktopMode {
    /// Placed anywhere, and a cursor poll drives click-through, the eyes and
    /// the drag, exactly like the island.
    Poll,
    /// Mochi stays in the island.
    Off,
}

impl DesktopMode {
    pub fn as_str(self) -> &'static str {
        match self {
            DesktopMode::Poll => "poll",
            DesktopMode::Off => "off",
        }
    }

    /// The space a saved spot is measured in: physical pixels of the whole
    /// desktop, as the OS reports monitors. A spot from another space is not
    /// trusted.
    pub fn space(self) -> &'static str {
        "screen"
    }
}
