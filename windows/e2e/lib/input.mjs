// The real mouse of the machine the tests run on. The island opens because
// Rust watches the cursor (island.rs), and a grip resizes it because Rust
// follows the cursor while the left button is held: page events cannot do
// either. One PowerShell stays open and moves the cursor through user32.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SETUP = String.raw`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class LumoE2eMouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  public static void Down() { mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero); }
  public static void Up() { mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero); }
}
"@
Write-Output "ready"
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null -or $line -eq "quit") { break }
  $p = $line.Split(" ")
  switch ($p[0]) {
    "move" { [void][LumoE2eMouse]::SetCursorPos([int]$p[1], [int]$p[2]) }
    "down" { [LumoE2eMouse]::Down() }
    "up" { [LumoE2eMouse]::Up() }
  }
  Write-Output "ok"
}
`;

export class Mouse {
  async start() {
    const script = join(tmpdir(), "lumo-e2e-mouse.ps1");
    writeFileSync(script, SETUP);
    this.ps = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { stdio: ["pipe", "pipe", "inherit"] });
    this.waiting = [];
    let buf = "";
    this.ps.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.waiting.shift()?.(line);
      }
    });
    await new Promise((r) => this.waiting.push(r));
  }

  send(cmd) {
    const done = new Promise((r) => this.waiting.push(r));
    this.ps.stdin.write(cmd + "\n");
    return done;
  }

  move(x, y) {
    return this.send(`move ${Math.round(x)} ${Math.round(y)}`);
  }

  down() {
    return this.send("down");
  }

  up() {
    return this.send("up");
  }

  /** Presses at `from`, moves to `to` in small steps, releases. */
  async drag(from, to, steps = 20) {
    await this.move(from.x, from.y);
    await new Promise((r) => setTimeout(r, 150));
    await this.down();
    for (let i = 1; i <= steps; i++) {
      await this.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 150));
    await this.up();
  }

  stop() {
    try {
      this.ps.stdin.write("quit\n");
    } catch {}
  }
}
