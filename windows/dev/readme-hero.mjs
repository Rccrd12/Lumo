// Records the README's main video (docs/media/hero.gif) on a real Windows
// desktop: the running Lumo, a pretend Claude Code session sent through the
// real lumo-hook.exe, the real mouse clicking Allow, and ffmpeg recording the
// top of the screen. Nothing real runs: the "npm test" Lumo is asked about is
// only a hook event, and the Allow goes back to this script.
//
// Record with a Lumo of its own, not yours: quit Lumo, start the same lumo.exe
// with USERPROFILE, APPDATA, LOCALAPPDATA and WEBVIEW2_USER_DATA_FOLDER pointing
// into an empty folder, with `{"language": "en"}` as its
// roaming\com.rccrd12.lumo\settings.json, then run (with your normal env):
//
//   node dev/readme-hero.mjs lumo-hero.mp4
//
// Keys in Windows Credential Manager are shared, so that Lumo may still show
// your calendar or GitHub on the home: watch the video and cut those seconds
// before it goes in docs/media. Needs ffmpeg (winget install Gyan.FFmpeg).

import { spawn, execFileSync } from "node:child_process";
import { existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const OUT = process.argv[2] ?? join(process.cwd(), "lumo-hero.mp4");
const LOCAL = process.env.LOCALAPPDATA;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

// ── What it needs ─────────────────────────────────────────────────────────────
function findHook() {
  const candidates = [join(LOCAL, "com.rccrd12.lumo", "bin", "lumo-hook.exe"), join(LOCAL, "com.rccrd12.lumo", "lumo-hook.exe")];
  return candidates.find(existsSync) ?? null;
}
function findFfmpeg() {
  try { return execFileSync("where", ["ffmpeg"], { encoding: "utf8" }).split(/\r?\n/)[0].trim(); } catch {}
  const winget = join(LOCAL, "Microsoft", "WinGet", "Packages");
  if (existsSync(winget)) {
    for (const d of readdirSync(winget).filter((d) => d.toLowerCase().includes("ffmpeg"))) {
      const base = join(winget, d);
      for (const sub of readdirSync(base)) {
        const exe = join(base, sub, "bin", "ffmpeg.exe");
        if (existsSync(exe)) return exe;
      }
    }
  }
  return null;
}
const HOOK = findHook();
const FFMPEG = findFfmpeg();
const running = execFileSync("tasklist", ["/FI", "IMAGENAME eq lumo.exe"], { encoding: "utf8" }).toLowerCase().includes("lumo.exe");
console.log(JSON.stringify({ hook: HOOK, ffmpeg: FFMPEG, lumoRunning: running }));
if (process.argv.includes("--check")) process.exit(0);
if (!HOOK || !FFMPEG || !running) {
  console.error("Missing: " + [!HOOK && "lumo-hook.exe", !FFMPEG && "ffmpeg (winget install Gyan.FFmpeg)", !running && "Lumo running"].filter(Boolean).join(", "));
  process.exit(1);
}

// ── The mouse and the screen, in physical pixels (one PowerShell kept open) ──
const PS = String.raw`
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class M {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
"@
[void][M]::SetProcessDPIAware()
Write-Output ("ready " + [M]::GetSystemMetrics(0) + " " + [M]::GetSystemMetrics(1))
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null -or $line -eq "quit") { break }
  $p = $line.Split(" ")
  switch ($p[0]) {
    "move" { [void][M]::SetCursorPos([int]$p[1], [int]$p[2]); Write-Output "ok" }
    "down" { [M]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Write-Output "ok" }
    "up" { [M]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); Write-Output "ok" }
    "find" {
      # The orange Allow button inside x,y,w,h: the middle of its orange pixels.
      $x=[int]$p[1]; $y=[int]$p[2]; $w=[int]$p[3]; $h=[int]$p[4]
      $bmp = New-Object System.Drawing.Bitmap $w, $h
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
      $minX=99999; $minY=99999; $maxX=-1; $maxY=-1; $n=0
      for ($j=0; $j -lt $h; $j+=2) { for ($i=0; $i -lt $w; $i+=2) {
        $c = $bmp.GetPixel($i, $j)
        if ($c.R -gt 225 -and $c.G -gt 140 -and $c.G -lt 195 -and $c.B -lt 80) {
          $n++; if ($i -lt $minX) {$minX=$i}; if ($i -gt $maxX) {$maxX=$i}; if ($j -lt $minY) {$minY=$j}; if ($j -gt $maxY) {$maxY=$j}
        } } }
      $g.Dispose(); $bmp.Dispose()
      if ($n -lt 200) { Write-Output "none $n" } else { Write-Output ("at " + ($x + [int](($minX+$maxX)/2)) + " " + ($y + [int](($minY+$maxY)/2)) + " " + ($maxX-$minX) + " " + ($maxY-$minY) + " " + $n) }
    }
  }
}
`;
const psFile = join(tmpdir(), "lumo-readme-mouse.ps1");
writeFileSync(psFile, PS);
const ps = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", psFile], { stdio: ["pipe", "pipe", "inherit"] });
const waiting = [];
let buf = "";
ps.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) waiting.shift()?.(line);
  }
});
const ask = (cmd) => { const p = new Promise((r) => waiting.push(r)); if (cmd) ps.stdin.write(cmd + "\n"); return p; };
const [, SW, SH] = (await ask()).split(" ").map(Number);
let at = { x: Math.round(SW * 0.62), y: Math.round(SH * 0.55) };
const move = (x, y) => { at = { x: Math.round(x), y: Math.round(y) }; return ask(`move ${at.x} ${at.y}`); };
async function glide(x, y, ms = 700) {
  const from = { ...at }, steps = Math.max(1, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    await wait(16);
  }
}

// ── The pretend Claude Code ──────────────────────────────────────────────────
const cwd = "C:\\dev\\lumo";
const session_id = "lumo-demo-" + Date.now();
function hook(payload) {
  // A plain Claude Code session: nothing from the Claude app or Lumo in the env.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLAUDE|LUMO_)/i.test(k)) delete env[k];
  const p = spawn(HOOK, [payload.hook_event_name], { stdio: ["pipe", "pipe", "pipe"], env });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  const done = new Promise((r) => p.on("close", () => r(out.trim())));
  p.stdin.end(JSON.stringify({ session_id, cwd, transcript_path: "", ...payload }));
  return done;
}

// ── Recording: the top of the screen, around its middle ──────────────────────
const W = Math.min(SW, Math.round(SW * 0.62 / 2) * 2), H = Math.round(Math.min(SH, W * 0.42) / 2) * 2;
const X = Math.round((SW - W) / 2 / 2) * 2;
log(`screen ${SW}x${SH}, recording ${W}x${H} at ${X},0 → ${OUT}`);
await move(at.x, at.y);
const ff = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "gdigrab", "-framerate", "30", "-offset_x", String(X), "-offset_y", "0",
  "-video_size", `${W}x${H}`, "-draw_mouse", "1", "-i", "desktop", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "16", "-pix_fmt", "yuv420p", OUT],
  { stdio: ["pipe", "inherit", "inherit"] });
await wait(1800);

try {
  log("session starts");
  await hook({ hook_event_name: "SessionStart", source: "startup" });
  await hook({ hook_event_name: "UserPromptSubmit", prompt: "Add a dark mode toggle to the settings" });
  await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: `${cwd}\\src\\settings.ts` } });
  await wait(1600);
  await hook({ hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: `${cwd}\\src\\settings.ts` }, tool_response: {} });
  await hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: `${cwd}\\src\\settings.ts`, old_string: "a\nb\nc", new_string: "a\nb\nc\nd\ne\nf\ng" } });
  await wait(1600);
  await hook({ hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: `${cwd}\\src\\settings.ts` }, tool_response: {} });
  log("permission");
  const reply = hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test", description: "Run the test suite" }, permission_suggestions: [] });
  await wait(1400);
  let found = null;
  for (let k = 0; k < 10 && !found; k++) {
    const r = await ask(`find ${X} 0 ${W} ${H}`);
    log(r);
    if (r.startsWith("at ")) found = r.split(" ").slice(1).map(Number);
    else await wait(300);
  }
  if (!found) throw new Error("Allow button not found on screen");
  await glide(found[0] + 6, found[1] + 2, 900);
  await wait(350);
  await ask("down"); await wait(90); await ask("up");
  log("decision", (await Promise.race([reply, wait(8000).then(() => "timeout")])).slice(0, 200));
  await glide(Math.round(SW * 0.66), Math.round(SH * 0.6), 700);
  await hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } });
  await wait(1800);
  await hook({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: {} });
  await hook({ hook_event_name: "Stop", last_assistant_message: "Dark mode toggle added, tests green" });
  await wait(3500);
} catch (e) {
  console.error(String(e));
} finally {
  ff.stdin.write("q");
  await new Promise((r) => ff.on("close", r));
  await hook({ hook_event_name: "SessionEnd", reason: "other" }).catch(() => {});
  ps.stdin.write("quit\n");
  log("saved", OUT);
}
