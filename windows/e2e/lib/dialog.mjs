// Windows' own message boxes of a process (a "#32770" window), read and
// answered through UI Automation, as a hand would click their buttons: no page
// can reach them, which is what they are there for (confirmed.rs by_hand).

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = String.raw`
param([int]$Owner, [string]$Press, [int]$Seconds)
$tab = [string][char]9
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LumoE2eBox {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(150);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(50);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
}
"@
# Screen pixels, as UI Automation gives them.
[void][LumoE2eBox]::SetProcessDPIAware()
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$root = $A::RootElement
$cond = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, "#32770")),
  (New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $Owner)))
$end = (Get-Date).AddSeconds($Seconds)
$box = $null
$mine = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $Owner)
$isBox = New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, "#32770")
while ((Get-Date) -lt $end) {
  # UI Automation shows a box with an owner (the island) under its owner, not
  # on the desktop: looked for at both places.
  $box = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
  if (-not $box) {
    foreach ($top in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $mine)) {
      $box = $top.FindFirst([System.Windows.Automation.TreeScope]::Children, $isBox)
      if ($box) { break }
    }
  }
  if ($box) { break }
  Start-Sleep -Milliseconds 200
}
if (-not $box) {
  # What the process has on screen instead, to tell why.
  $tops = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $mine)
  $seen = ($tops | ForEach-Object { $_.Current.ClassName + " '" + $_.Current.Name + "'" }) -join " | "
  Write-Output ("NONE" + $tab + "" + $tab + $seen)
  exit
}
$all = $box.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
# On one line: a box's text may hold line breaks (the files a write names),
# and the answer is read from the last line printed.
$text = (($all | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) -join " | ") -replace "[\r\n]+", " "
# A task dialog's own buttons are panes with nothing to invoke: they are
# found by name, after the text, and clicked with the real mouse.
$invoke = [System.Windows.Automation.InvokePattern]::Pattern
$buttons = @($all | Where-Object {
  $p = $null
  $_.Current.Name -and ($_.TryGetCurrentPattern($invoke, [ref]$p) -or
    $_.Current.ControlType.ProgrammaticName -in @("ControlType.Button", "ControlType.Pane"))
})
$names = ($buttons | ForEach-Object { $_.Current.Name }) -join " | "
$hit = $buttons | Where-Object { $_.Current.Name -eq $Press } | Select-Object -First 1
if (-not $hit) {
  $kinds = ($all | ForEach-Object { $_.Current.ControlType.ProgrammaticName + " '" + $_.Current.Name + "'" }) -join " | "
  Write-Output ("NOBUTTON" + $tab + $names + $tab + $kinds)
  exit
}
# Lumo's box greys its Yes out for a moment (confirmed.rs YES_AFTER_MS): a
# hand waits for it, as a click on it before does nothing.
$ready = (Get-Date).AddSeconds(5)
while (-not $hit.Current.IsEnabled -and (Get-Date) -lt $ready) { Start-Sleep -Milliseconds 100 }
$r = $hit.Current.BoundingRectangle
[LumoE2eBox]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
Write-Output ("PRESSED" + $tab + $names + $tab + $text)
`;

/**
 * Waits up to `seconds` for a message box of process `pid` and presses its
 * button named `press`. Returns { found, pressed, buttons, text }.
 */
export function answerBox(pid, press, seconds = 10) {
  const script = join(tmpdir(), "lumo-e2e-dialog.ps1");
  writeFileSync(script, SCRIPT);
  const out = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Owner", String(pid), "-Press", press, "-Seconds", String(seconds)],
    { encoding: "utf8", timeout: (seconds + 20) * 1000 },
  );
  const line = (out.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
  const [state, buttons = "", text = ""] = line.split("\t");
  return { found: state === "PRESSED" || state === "NOBUTTON", pressed: state === "PRESSED", buttons, text, raw: line || out.stderr };
}

const WINDOWS = String.raw`
param([int]$Owner)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [System.Windows.Automation.AutomationElement]
$mine = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, $Owner)
foreach ($w in $A::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $mine)) {
  Write-Output $w.Current.Name
}
`;

/** The titles of the windows process `pid` shows on screen (hidden ones are not listed). */
export function windowsOnScreen(pid) {
  const script = join(tmpdir(), "lumo-e2e-windows.ps1");
  writeFileSync(script, WINDOWS);
  const out = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Owner", String(pid)],
    { encoding: "utf8", timeout: 20_000 },
  );
  return (out.stdout ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

const PICKER = String.raw`
param([int]$Owner, [int]$Seconds)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class LumoE2ePicker {
  public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  public static string Class(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static string Title(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
  public static IntPtr Find(uint owner) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == owner && IsWindowVisible(h) && Class(h) == "#32770") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
[void][LumoE2ePicker]::SetProcessDPIAware()
$end = (Get-Date).AddSeconds($Seconds)
$h = [IntPtr]::Zero
while ((Get-Date) -lt $end) {
  $h = [LumoE2ePicker]::Find([uint32]$Owner)
  if ($h -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 200
}
if ($h -eq [IntPtr]::Zero) { Write-Output '{"found":false}'; exit }
Start-Sleep -Milliseconds 500
$r = New-Object LumoE2ePicker+RECT
[void][LumoE2ePicker]::GetWindowRect($h, [ref]$r)
$owner = [LumoE2ePicker]::GetWindow($h, 4)
$ownerPid = [uint32]0
if ($owner -ne [IntPtr]::Zero) { [void][LumoE2ePicker]::GetWindowThreadProcessId($owner, [ref]$ownerPid) }
$o = [ordered]@{
  found = $true
  hwnd = $h.ToInt64()
  rect = @{ x = $r.Left; y = $r.Top; w = $r.Right - $r.Left; h = $r.Bottom - $r.Top }
  title = [LumoE2ePicker]::Title($h)
  owner = $owner.ToInt64()
  ownerPid = $ownerPid
  ownerTitle = $(if ($owner -ne [IntPtr]::Zero) { [LumoE2ePicker]::Title($owner) } else { "" })
  ownerTopmost = $(if ($owner -ne [IntPtr]::Zero) { ([LumoE2ePicker]::GetWindowLong($owner, -20) -band 8) -ne 0 } else { $false })
}
Write-Output ($o | ConvertTo-Json -Compress)
`;

/**
 * Waits up to `seconds` for a file or folder picker of process `pid` (Windows'
 * own "#32770" window) and tells where it is (`rect`, screen pixels) and whose
 * it is: its owner window, and whether that one is always on top. A window
 * owned by another always shows over it; one of no one's opens under a window
 * that is always on top, as the island is. (Which window a point shows can't
 * tell it: the island lets the mouse through where it isn't.)
 */
export function filePicker(pid, seconds = 10) {
  const script = join(tmpdir(), "lumo-e2e-picker.ps1");
  writeFileSync(script, PICKER);
  const out = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Owner", String(pid), "-Seconds", String(seconds)],
    { encoding: "utf8", timeout: (seconds + 20) * 1000 },
  );
  const line = (out.stdout ?? "").trim().split(/\r?\n/).pop() ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return { found: false, raw: line || out.stderr };
  }
}
