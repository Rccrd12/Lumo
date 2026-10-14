// Gemini Live's control_computer: the few settings a person changes from the
// taskbar — the volume, the screen's brightness, the power plan — and locking
// the computer. Each runs once, when the model calls the tool during a call;
// nothing here watches anything.
//
// Windows: the default speakers' volume through Core Audio
// (IAudioEndpointVolume), the brightness through WMI (only a laptop's own
// screen offers it), the power plan through PowerSetActiveScheme, the lock
// through LockWorkStation. "Do not disturb" has no interface an app may use,
// so it is not here.

use serde::{Deserialize, Serialize};

/// What the model asks for.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    /// Volume to `value` %, or how it is when there is none.
    Volume,
    VolumeUp,
    VolumeDown,
    Mute,
    Unmute,
    /// Brightness to `value` %, or how it is when there is none.
    Brightness,
    BrightnessUp,
    BrightnessDown,
    /// The power plan named by `plan`, or the one in use.
    PowerPlan,
    Lock,
}

/// How much one "up" or "down" moves, in %.
pub const STEP: u32 = 10;

/// The state after the action, for the model to tell the user.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Done {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brightness: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub power_plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
}

/// The three plans Windows ships, by the names the model uses.
pub fn plan_guid(name: &str) -> Option<u128> {
    match name.trim().to_ascii_lowercase().replace([' ', '-'], "_").as_str() {
        "saver" | "power_saver" | "battery_saver" | "energy_saver" => Some(0xa1841308_3541_4fab_bc81_f71556f20b4a),
        "balanced" => Some(0x381b4222_f694_41f0_9685_ff5bb260df2e),
        "performance" | "high_performance" => Some(0x8c5e7fda_e8bf_4a96_9a85_a6e23a8c635c),
        _ => None,
    }
}

pub fn plan_name(guid: u128) -> String {
    match guid {
        0xa1841308_3541_4fab_bc81_f71556f20b4a => "saver".into(),
        0x381b4222_f694_41f0_9685_ff5bb260df2e => "balanced".into(),
        0x8c5e7fda_e8bf_4a96_9a85_a6e23a8c635c => "performance".into(),
        _ => "custom".into(),
    }
}

/// A level moved by `delta` %, kept within 0–100.
pub fn stepped(now: u32, delta: i32) -> u32 {
    (now as i32 + delta).clamp(0, 100) as u32
}

fn percent(value: Option<f64>) -> Result<Option<u32>, String> {
    match value {
        None => Ok(None),
        Some(v) if v.is_finite() && (0.0..=100.0).contains(&v) => Ok(Some(v.round() as u32)),
        Some(_) => Err("The value is a percentage, from 0 to 100.".into()),
    }
}

/// Runs one action. Blocking.
pub fn run(action: Action, value: Option<f64>, plan: Option<&str>) -> Result<Done, String> {
    let value = percent(value)?;
    match action {
        Action::Volume => {
            if let Some(v) = value {
                imp::set_volume(v)?;
            }
            volume_state()
        }
        Action::VolumeUp | Action::VolumeDown => {
            let now = imp::volume()?.0;
            let delta = if action == Action::VolumeUp { STEP as i32 } else { -(STEP as i32) };
            imp::set_volume(stepped(now, delta))?;
            volume_state()
        }
        Action::Mute | Action::Unmute => {
            imp::set_mute(action == Action::Mute)?;
            volume_state()
        }
        Action::Brightness => {
            if let Some(v) = value {
                imp::set_brightness(v)?;
            }
            Ok(Done { brightness: Some(imp::brightness()?), ..Done::default() })
        }
        Action::BrightnessUp | Action::BrightnessDown => {
            let now = imp::brightness()?;
            let delta = if action == Action::BrightnessUp { STEP as i32 } else { -(STEP as i32) };
            imp::set_brightness(stepped(now, delta))?;
            Ok(Done { brightness: Some(imp::brightness()?), ..Done::default() })
        }
        Action::PowerPlan => {
            if let Some(name) = plan.filter(|p| !p.trim().is_empty()) {
                let guid = plan_guid(name).ok_or("The power plan is \"saver\", \"balanced\" or \"performance\".")?;
                imp::set_plan(guid)?;
            }
            Ok(Done { power_plan: Some(plan_name(imp::plan()?)), ..Done::default() })
        }
        Action::Lock => {
            imp::lock()?;
            Ok(Done { locked: Some(true), ..Done::default() })
        }
    }
}

fn volume_state() -> Result<Done, String> {
    let (volume, muted) = imp::volume()?;
    Ok(Done { volume: Some(volume), muted: Some(muted), ..Done::default() })
}

mod imp {
    use ::windows::core::GUID;
    use ::windows::Win32::Foundation::{LocalFree, HLOCAL, WIN32_ERROR};
    use ::windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use ::windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use ::windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
    use ::windows::Win32::System::Power::{PowerGetActiveScheme, PowerSetActiveScheme};
    use ::windows::Win32::System::Shutdown::LockWorkStation;

    fn speakers() -> Result<IAudioEndpointVolume, String> {
        let none = || "No speakers or headphones were found.".to_string();
        unsafe {
            // Already set up on this thread is fine.
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|_| none())?;
            let device = devices.GetDefaultAudioEndpoint(eRender, eConsole).map_err(|_| none())?;
            device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).map_err(|_| none())
        }
    }

    /// The volume in %, and whether it is muted.
    pub fn volume() -> Result<(u32, bool), String> {
        let v = speakers()?;
        unsafe {
            let level = v.GetMasterVolumeLevelScalar().map_err(|e| e.message())?;
            let muted = v.GetMute().map(|b| b.as_bool()).unwrap_or(false);
            Ok(((level * 100.0).round() as u32, muted))
        }
    }

    pub fn set_volume(percent: u32) -> Result<(), String> {
        let v = speakers()?;
        unsafe {
            v.SetMasterVolumeLevelScalar(percent.min(100) as f32 / 100.0, std::ptr::null()).map_err(|e| e.message())?;
            // Turning it up means wanting to hear it.
            if percent > 0 {
                let _ = v.SetMute(false, std::ptr::null());
            }
        }
        Ok(())
    }

    pub fn set_mute(on: bool) -> Result<(), String> {
        let v = speakers()?;
        unsafe { v.SetMute(on, std::ptr::null()).map_err(|e| e.message()) }
    }

    fn powershell(script: &str) -> Result<String, String> {
        let mut cmd = std::process::Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        let out = crate::platform::no_console(&mut cmd).output().map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !text.is_empty() {
            Ok(text)
        } else {
            Err(no_brightness())
        }
    }

    fn no_brightness() -> String {
        "This screen's brightness can't be changed from Windows: only a laptop's own screen allows it. An external monitor has its own buttons.".into()
    }

    pub fn brightness() -> Result<u32, String> {
        let text = powershell("(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1).CurrentBrightness")?;
        text.lines().next().and_then(|l| l.trim().parse::<u32>().ok()).ok_or_else(no_brightness)
    }

    pub fn set_brightness(percent: u32) -> Result<(), String> {
        // The number is ours, never the model's text.
        let script = format!(
            "Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{{Timeout=1;Brightness=[byte]{}}} -ErrorAction Stop | Out-Null; 'ok'",
            percent.min(100)
        );
        powershell(&script).map(|_| ())
    }

    pub fn plan() -> Result<u128, String> {
        unsafe {
            let mut active: *mut GUID = std::ptr::null_mut();
            let err = PowerGetActiveScheme(None, &mut active);
            if err != WIN32_ERROR(0) || active.is_null() {
                return Err("Couldn't read the power plan.".into());
            }
            let guid = (*active).to_u128();
            let _ = LocalFree(Some(HLOCAL(active as *mut _)));
            Ok(guid)
        }
    }

    pub fn set_plan(guid: u128) -> Result<(), String> {
        let guid = GUID::from_u128(guid);
        let err = unsafe { PowerSetActiveScheme(None, Some(&guid)) };
        if err == WIN32_ERROR(0) {
            Ok(())
        } else {
            Err("This computer doesn't have that power plan: many recent laptops only have \"balanced\", and set how hard they work in Settings → System → Power instead.".into())
        }
    }

    pub fn lock() -> Result<(), String> {
        unsafe { LockWorkStation() }.map_err(|e| e.message())
    }
}

/// Gemini Live's control_computer.
#[tauri::command]
pub async fn pc_control(action: Action, value: Option<f64>, plan: Option<String>) -> Result<Done, String> {
    tauri::async_runtime::spawn_blocking(move || run(action, value, plan.as_deref())).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_are_known_by_their_everyday_names() {
        assert_eq!(plan_guid("Power saver"), plan_guid("saver"));
        assert_eq!(plan_guid("high-performance"), plan_guid("performance"));
        assert_eq!(plan_name(plan_guid("balanced").unwrap()), "balanced");
        assert_eq!(plan_guid("turbo"), None);
        assert_eq!(plan_name(0), "custom");
    }

    #[test]
    fn levels_stay_between_0_and_100() {
        assert_eq!(stepped(95, 10), 100);
        assert_eq!(stepped(5, -10), 0);
        assert_eq!(stepped(40, 10), 50);
        assert!(percent(Some(140.0)).is_err());
        assert!(percent(Some(f64::NAN)).is_err());
        assert_eq!(percent(Some(33.4)).unwrap(), Some(33));
        assert_eq!(percent(None).unwrap(), None);
    }

    #[test]
    fn actions_read_as_the_model_writes_them() {
        let a: Action = serde_json::from_str("\"volume_up\"").unwrap();
        assert_eq!(a, Action::VolumeUp);
        let a: Action = serde_json::from_str("\"power_plan\"").unwrap();
        assert_eq!(a, Action::PowerPlan);
    }
}
