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
$text = ($all | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) -join " | "
# A box's buttons are what can be pressed in it (a task dialog's own
# buttons are not all of control type Button).
$invoke = [System.Windows.Automation.InvokePattern]::Pattern
$buttons = @($all | Where-Object { $p = $null; $_.Current.Name -and $_.TryGetCurrentPattern($invoke, [ref]$p) })
$names = ($buttons | ForEach-Object { $_.Current.Name }) -join " | "
$hit = $buttons | Where-Object { $_.Current.Name -eq $Press } | Select-Object -First 1
if (-not $hit) {
  $kinds = ($all | ForEach-Object { $_.Current.ControlType.ProgrammaticName + " '" + $_.Current.Name + "'" }) -join " | "
  Write-Output ("NOBUTTON" + $tab + $names + $tab + $kinds)
  exit
}
$hit.GetCurrentPattern($invoke).Invoke()
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
