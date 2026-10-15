// Gemini Live's computer_status: how the computer is doing — the processor,
// the memory, the disks, the battery — and which programs use the most. It is
// measured once, when the model calls the tool during a call: half a second of
// counting, then nothing runs until the next call.
//
// Windows: GetSystemTimes for the processor, GlobalMemoryStatusEx for the
// memory, GetDiskFreeSpaceExW for each fixed drive, GetSystemPowerStatus for
// the battery, and a snapshot of the processes (Toolhelp) with their times and
// working sets, added up by program (Chrome's many processes are one Chrome).

use serde::Serialize;
use std::collections::HashMap;

/// How long the processor is watched.
pub const SAMPLE_MS: u64 = 500;
/// Programs named in each list.
pub const TOP: usize = 5;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub drive: String,
    pub free_gb: f64,
    pub total_gb: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Battery {
    pub percent: u32,
    pub charging: bool,
    /// Minutes left on battery, when Windows knows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minutes_left: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Program {
    pub name: String,
    /// Share of the whole processor, %.
    pub cpu_percent: f64,
    pub memory_mb: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub cpu_percent: f64,
    pub memory_used_gb: f64,
    pub memory_total_gb: f64,
    pub disks: Vec<Disk>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub battery: Option<Battery>,
    pub uptime_hours: f64,
    pub busiest: Vec<Program>,
    pub biggest: Vec<Program>,
}

/// One process between two counts: its program, processor time in 100 ns units, working set.
#[derive(Debug, Clone, PartialEq)]
pub struct Sample {
    pub name: String,
    pub busy: u64,
    pub memory: u64,
}

pub fn gb(bytes: u64) -> f64 {
    (bytes as f64 / 1_073_741_824.0 * 10.0).round() / 10.0
}

fn one_decimal(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// Busy share of the processor between two (idle, kernel, user) counts; kernel includes idle.
pub fn cpu_share(before: (u64, u64, u64), after: (u64, u64, u64)) -> f64 {
    let idle = after.0.saturating_sub(before.0);
    let total = after.1.saturating_sub(before.1) + after.2.saturating_sub(before.2);
    if total == 0 {
        return 0.0;
    }
    one_decimal(100.0 * (total.saturating_sub(idle)) as f64 / total as f64)
}

/// "chrome.exe" → "chrome".
pub fn program_name(exe: &str) -> String {
    let e = exe.trim();
    e.strip_suffix(".exe").or_else(|| e.strip_suffix(".EXE")).unwrap_or(e).to_string()
}

/// The programs busiest and biggest, processes of one program added up.
/// `elapsed` is the wall time between the counts, 100 ns units, and
/// `cores` the logical processors (a process's time runs on all of them).
pub fn rank(before: &HashMap<u32, Sample>, after: &HashMap<u32, Sample>, elapsed: u64, cores: u32) -> (Vec<Program>, Vec<Program>) {
    let mut by_name: HashMap<String, (u64, u64)> = HashMap::new();
    for (pid, s) in after {
        // The idle "process" is not a program.
        if *pid == 0 || s.name.is_empty() {
            continue;
        }
        let busy = before.get(pid).filter(|b| b.name == s.name).map(|b| s.busy.saturating_sub(b.busy)).unwrap_or(0);
        let e = by_name.entry(program_name(&s.name)).or_default();
        e.0 += busy;
        e.1 += s.memory;
    }
    let whole = (elapsed.max(1) * cores.max(1) as u64) as f64;
    let programs: Vec<Program> = by_name
        .into_iter()
        .map(|(name, (busy, memory))| Program { name, cpu_percent: one_decimal(100.0 * busy as f64 / whole), memory_mb: memory / 1_048_576 })
        .collect();
    let mut busiest: Vec<Program> = programs.iter().filter(|p| p.cpu_percent > 0.0).cloned().collect();
    busiest.sort_by(|a, b| b.cpu_percent.total_cmp(&a.cpu_percent).then_with(|| a.name.cmp(&b.name)));
    busiest.truncate(TOP);
    let mut biggest = programs;
    biggest.sort_by(|a, b| b.memory_mb.cmp(&a.memory_mb).then_with(|| a.name.cmp(&b.name)));
    biggest.truncate(TOP);
    (busiest, biggest)
}

/// Measures. Blocking, for about SAMPLE_MS.
pub fn status() -> Result<Status, String> {
    imp::status()
}

mod imp {
    use super::*;
    use std::time::{Duration, Instant};

    use ::windows::core::PCWSTR;
    use ::windows::Win32::Foundation::{CloseHandle, FILETIME};
    use ::windows::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives};
    use ::windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use ::windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use ::windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use ::windows::Win32::System::SystemInformation::{GetSystemInfo, GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX, SYSTEM_INFO};
    use ::windows::Win32::System::Threading::{GetProcessTimes, GetSystemTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    const DRIVE_FIXED: u32 = 3;

    fn ticks(t: FILETIME) -> u64 {
        ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64
    }

    fn system_times() -> (u64, u64, u64) {
        let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
        unsafe {
            let _ = GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user));
        }
        (ticks(idle), ticks(kernel), ticks(user))
    }

    fn processes() -> HashMap<u32, Sample> {
        let mut out = HashMap::new();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
            let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut more = Process32FirstW(snap, &mut entry).is_ok();
            while more {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                let pid = entry.th32ProcessID;
                let (mut busy, mut memory) = (0u64, 0u64);
                if let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                    let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
                    if GetProcessTimes(process, &mut c, &mut e, &mut k, &mut u).is_ok() {
                        busy = ticks(k) + ticks(u);
                    }
                    let mut counters = PROCESS_MEMORY_COUNTERS { cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32, ..Default::default() };
                    if GetProcessMemoryInfo(process, &mut counters, counters.cb).is_ok() {
                        memory = counters.WorkingSetSize as u64;
                    }
                    let _ = CloseHandle(process);
                }
                out.insert(pid, Sample { name, busy, memory });
                more = Process32NextW(snap, &mut entry).is_ok();
            }
            let _ = CloseHandle(snap);
        }
        out
    }

    fn disks() -> Vec<Disk> {
        let mask = unsafe { GetLogicalDrives() };
        let mut out = Vec::new();
        for i in 0..26u32 {
            if mask & (1 << i) == 0 {
                continue;
            }
            let letter = (b'A' + i as u8) as char;
            let root: Vec<u16> = format!("{letter}:\\").encode_utf16().chain(Some(0)).collect();
            unsafe {
                if GetDriveTypeW(PCWSTR(root.as_ptr())) != DRIVE_FIXED {
                    continue;
                }
                let (mut free, mut total) = (0u64, 0u64);
                if GetDiskFreeSpaceExW(PCWSTR(root.as_ptr()), Some(&mut free), Some(&mut total), None).is_ok() && total > 0 {
                    out.push(Disk { drive: format!("{letter}:"), free_gb: gb(free), total_gb: gb(total) });
                }
            }
        }
        out
    }

    fn battery() -> Option<Battery> {
        let mut s = SYSTEM_POWER_STATUS::default();
        unsafe { GetSystemPowerStatus(&mut s) }.ok()?;
        // 128: no battery; 255: unknown.
        if s.BatteryFlag & 128 != 0 || s.BatteryLifePercent > 100 {
            return None;
        }
        Some(Battery {
            percent: s.BatteryLifePercent as u32,
            charging: s.ACLineStatus == 1,
            minutes_left: (s.BatteryLifeTime != u32::MAX && s.ACLineStatus != 1).then_some(s.BatteryLifeTime / 60),
        })
    }

    pub fn status() -> Result<Status, String> {
        let cores = unsafe {
            let mut info = SYSTEM_INFO::default();
            GetSystemInfo(&mut info);
            info.dwNumberOfProcessors
        };
        let cpu_before = system_times();
        let before = processes();
        let start = Instant::now();
        std::thread::sleep(Duration::from_millis(SAMPLE_MS));
        let cpu_after = system_times();
        let after = processes();
        let elapsed = start.elapsed().as_nanos() as u64 / 100;
        let (busiest, biggest) = rank(&before, &after, elapsed, cores);

        let mut memory = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        unsafe { GlobalMemoryStatusEx(&mut memory) }.map_err(|e| e.message())?;
        Ok(Status {
            cpu_percent: cpu_share(cpu_before, cpu_after),
            memory_used_gb: gb(memory.ullTotalPhys.saturating_sub(memory.ullAvailPhys)),
            memory_total_gb: gb(memory.ullTotalPhys),
            disks: disks(),
            battery: battery(),
            uptime_hours: one_decimal(unsafe { GetTickCount64() } as f64 / 3_600_000.0),
            busiest,
            biggest,
        })
    }
}

/// Gemini Live's computer_status.
#[tauri::command]
pub async fn pc_status() -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(status).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(name: &str, busy: u64, memory: u64) -> Sample {
        Sample { name: name.into(), busy, memory }
    }

    #[test]
    fn the_processor_share_leaves_idle_out() {
        // 1000 ticks went by in kernel+user, 750 of them idle.
        assert_eq!(cpu_share((0, 0, 0), (750, 800, 200)), 25.0);
        assert_eq!(cpu_share((5, 5, 5), (5, 5, 5)), 0.0);
    }

    #[test]
    fn processes_of_one_program_are_one_program() {
        let before = HashMap::from([(1, sample("chrome.exe", 0, 0)), (2, sample("chrome.exe", 0, 0)), (3, sample("Code.exe", 0, 0))]);
        let after = HashMap::from([
            (0, sample("[System Process]", 999, 0)),
            (1, sample("chrome.exe", 100, 300 << 20)),
            (2, sample("chrome.exe", 100, 200 << 20)),
            (3, sample("Code.exe", 50, 900 << 20)),
            // New since the first count: its time is not counted, its memory is.
            (4, sample("notepad.exe", 70, 10 << 20)),
        ]);
        let (busiest, biggest) = rank(&before, &after, 1000, 1);
        assert_eq!(busiest[0], Program { name: "chrome".into(), cpu_percent: 20.0, memory_mb: 500 });
        assert_eq!(busiest[1].name, "Code");
        assert!(!busiest.iter().any(|p| p.name == "notepad"));
        assert_eq!(biggest[0].name, "Code");
        assert_eq!(biggest.len(), 3);
    }

    #[test]
    fn a_reused_process_id_starts_from_zero() {
        let before = HashMap::from([(7, sample("old.exe", 5000, 0))]);
        let after = HashMap::from([(7, sample("new.exe", 40, 0))]);
        let (busiest, _) = rank(&before, &after, 1000, 1);
        assert!(busiest.is_empty());
    }

    #[test]
    fn sizes_read_in_gigabytes() {
        assert_eq!(gb(16 * 1_073_741_824), 16.0);
        assert_eq!(gb(1_610_612_736), 1.5);
        assert_eq!(program_name("chrome.exe"), "chrome");
    }
}
