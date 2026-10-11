// Settings → General → Energy: how hard Lumo works.
//
// - "none": nothing is spared — the inbox, the calendar, GitHub, the
//   integrations and the plan usage are asked more often, near real time;
// - "light": as Lumo always was (the default way of working);
// - "saver": energy saving — fewer frames on the closed island, Lumo dozes
//   while the mouse is away, and everything is asked less often;
// - "auto": "saver" on battery, and on mains power what `energy_on_power`
//   says ("none" or "light").
//
// The page computes the same thing (src/core/energy.ts) for what it draws;
// Rust uses it for its own pollers (mail.rs, integrations.rs) and the cursor
// poll (island.rs). Whether the computer runs on battery is asked of the
// system every POWER_EVERY, a call that costs nothing.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::platform;

/// How hard Lumo works right now.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effort {
    Realtime,
    Light,
    Saver,
}

/// The effort a setting asks for, given the power source.
pub fn effective(mode: &str, on_power: &str, on_battery: bool) -> Effort {
    match mode {
        "none" => Effort::Realtime,
        "saver" => Effort::Saver,
        "auto" if on_battery => Effort::Saver,
        "auto" if on_power == "none" => Effort::Realtime,
        _ => Effort::Light,
    }
}

/// One value for each effort.
pub fn pick<T>(realtime: T, light: T, saver: T) -> T {
    match current() {
        Effort::Realtime => realtime,
        Effort::Light => light,
        Effort::Saver => saver,
    }
}

static EFFORT: AtomicU8 = AtomicU8::new(1);
static ON_BATTERY: AtomicBool = AtomicBool::new(false);

pub fn current() -> Effort {
    match EFFORT.load(Ordering::Relaxed) {
        0 => Effort::Realtime,
        2 => Effort::Saver,
        _ => Effort::Light,
    }
}

pub fn on_battery() -> bool {
    ON_BATTERY.load(Ordering::Relaxed)
}

/// How often the power source is asked.
const POWER_EVERY: Duration = Duration::from_secs(20);

/// Works the effort out again from the settings and the power source; the
/// pollers that wait long are woken when it changed.
pub fn refresh(app: &AppHandle) {
    let (mode, on_power) = app
        .try_state::<crate::Shared>()
        .map(|shared| {
            let s = shared.settings.lock().unwrap();
            (s.energy_mode.clone(), s.energy_on_power.clone())
        })
        .unwrap_or_else(|| ("light".into(), "light".into()));
    let effort = effective(&mode, &on_power, on_battery());
    let code = match effort {
        Effort::Realtime => 0,
        Effort::Light => 1,
        Effort::Saver => 2,
    };
    if EFFORT.swap(code, Ordering::Relaxed) != code {
        crate::log::line(format!("energy: {effort:?}"));
        crate::mail::wake();
        crate::integrations::wake_github_loops();
    }
}

/// Watches the power source: unplugged or plugged in, the pages are told
/// (`energy-power`) and the effort follows.
pub fn start(app: AppHandle) {
    ON_BATTERY.store(platform::on_battery(), Ordering::Relaxed);
    refresh(&app);
    std::thread::spawn(move || loop {
        std::thread::sleep(POWER_EVERY);
        let now = platform::on_battery();
        if ON_BATTERY.swap(now, Ordering::Relaxed) != now {
            crate::log::line(format!("power: {}", if now { "battery" } else { "mains" }));
            let _ = app.emit("energy-power", now);
            refresh(&app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_setting_and_the_power_source_make_the_effort() {
        assert_eq!(effective("none", "light", true), Effort::Realtime);
        assert_eq!(effective("light", "none", true), Effort::Light);
        assert_eq!(effective("saver", "none", false), Effort::Saver);
        assert_eq!(effective("auto", "light", true), Effort::Saver);
        assert_eq!(effective("auto", "none", true), Effort::Saver);
        assert_eq!(effective("auto", "light", false), Effort::Light);
        assert_eq!(effective("auto", "none", false), Effort::Realtime);
        // Anything else is the usual way.
        assert_eq!(effective("", "", true), Effort::Light);
        assert_eq!(effective("turbo", "none", false), Effort::Light);
    }
}
