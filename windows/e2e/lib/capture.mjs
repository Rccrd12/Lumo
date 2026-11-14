// A screen capture tool of the test's own, under the name of a real one
// (Greenshot.exe): Lumo knows capture tools by their program (island.rs
// CAPTURE_TOOLS), so a small Windows Forms program by that name stands for
// it. Its windows: an ordinary one (clicked first, so the program is in front
// and may bring its other windows to the front), a second ordinary one, the
// capture's overlay (always on top, over the whole display, dimmed) and an
// image pinned to the screen (always on top, small). It answers one line per
// command on stdin, and lists the always-on-top windows front to back, which
// is what the flows check: whether Lumo is above or under them.
//
// Built once per run with Windows PowerShell's own C# compiler (Add-Type
// -OutputAssembly): no dependency, nothing to install.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OUT } from "./app.mjs";

const SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class LumoE2eCapture {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

  // Shown without taking the keyboard, as a capture's overlay first is.
  class Quiet : Form {
    protected override bool ShowWithoutActivation { get { return true; } }
  }

  static Form main, other, overlay, pin;

  static Form Make(Form f, string title, Rectangle at, bool top, Color color) {
    f.Text = title;
    f.StartPosition = FormStartPosition.Manual;
    f.Bounds = at;
    f.TopMost = top;
    f.BackColor = color;
    if (top) { f.FormBorderStyle = FormBorderStyle.None; f.ShowInTaskbar = false; }
    return f;
  }

  [STAThread]
  public static void Main() {
    SetProcessDPIAware();
    Rectangle b = Screen.PrimaryScreen.Bounds;
    main = Make(new Form(), "Fake capture tool", new Rectangle(b.Width / 2 - 200, b.Height / 2 - 100, 400, 200), false, Color.White);
    other = Make(new Form(), "Fake capture tool, options", new Rectangle(b.Width / 2 - 200, b.Height / 2 + 140, 400, 140), false, Color.WhiteSmoke);
    overlay = Make(new Quiet(), "Fake capture overlay", b, true, Color.Black);
    overlay.Opacity = 0.4;
    pin = Make(new Quiet(), "Fake pinned image", new Rectangle(b.Width / 2 - 150, b.Height - 280, 300, 180), true, Color.SteelBlue);
    main.Shown += delegate { new Thread(Read) { IsBackground = true }.Start(); };
    Application.Run(main);
  }

  static string Rect(Form f) {
    return string.Format("{0} {1} {2} {3}", f.Left, f.Top, f.Width, f.Height);
  }

  static string Hwnd(Form f) {
    return f.Handle.ToInt64().ToString();
  }

  static string Front(Form f) {
    return GetForegroundWindow() == f.Handle ? "front" : "not-front";
  }

  // Visible always-on-top windows, front to back: "hwnd:pid".
  static string Order() {
    List<string> list = new List<string>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (IsWindowVisible(h) && (GetWindowLong(h, -20) & 0x8) != 0) {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        list.Add(h.ToInt64() + ":" + pid);
      }
      return true;
    }, IntPtr.Zero);
    return string.Join(" ", list.ToArray());
  }

  static string On(Func<string> f) {
    return (string)main.Invoke(f);
  }

  static void Read() {
    Console.WriteLine("ready " + On(delegate { return Rect(main); }));
    string line;
    while ((line = Console.ReadLine()) != null) {
      string answer = "?";
      switch (line.Trim()) {
        case "capture":
          // The overlay comes up first, then one of the tool's ordinary
          // windows comes to the front (Lumo climbs above every window on top,
          // the overlay included), then the overlay comes to the front.
          On(delegate { overlay.Show(); other.Show(); other.Activate(); return ""; });
          Thread.Sleep(800);
          answer = On(delegate { overlay.Activate(); return ""; });
          Thread.Sleep(300);
          answer = On(delegate { return Hwnd(overlay) + " " + Front(overlay); });
          break;
        case "end":
          answer = On(delegate { overlay.Hide(); other.Hide(); main.Activate(); return Front(main); });
          break;
        case "pin":
          On(delegate { pin.Show(); pin.Activate(); return ""; });
          Thread.Sleep(300);
          answer = On(delegate { return Hwnd(pin) + " " + Front(pin); });
          break;
        case "unpin":
          answer = On(delegate { pin.Hide(); main.Activate(); return Front(main); });
          break;
        case "order":
          answer = On(Order);
          break;
        case "quit":
          On(delegate { Application.Exit(); return ""; });
          return;
      }
      Console.WriteLine(answer);
    }
  }
}
`;

const DIR = join(OUT, "fake-capture");
// The program's name is what Lumo goes by: Greenshot is one it knows.
const EXE = join(DIR, "Greenshot.exe");

function build() {
  if (existsSync(EXE)) return;
  mkdirSync(DIR, { recursive: true });
  const source = join(DIR, "capture.cs");
  writeFileSync(source, SOURCE);
  const ps = `Add-Type -TypeDefinition ([IO.File]::ReadAllText('${source.replace(/'/g, "''")}')) ` +
    `-ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly '${EXE.replace(/'/g, "''")}' -OutputType ConsoleApplication`;
  const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 120_000 });
  if (!existsSync(EXE)) throw new Error(`the fake capture tool did not build: ${out.stdout}\n${out.stderr}`);
}

export class FakeCapture {
  /** Builds and starts it; `main` is its ordinary window's place on the screen. */
  async start() {
    build();
    this.proc = spawn(EXE, [], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    this.pid = this.proc.pid;
    this.waiting = [];
    let buf = "";
    this.proc.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.waiting.shift()?.(line);
      }
    });
    const ready = await this.answer(new Promise((r) => this.waiting.push(r)));
    const [, x, y, w, h] = ready.split(" ").map(Number);
    this.main = { x, y, w, h };
  }

  async answer(promise, ms = 15_000) {
    let timer;
    const late = new Promise((_, no) => (timer = setTimeout(() => no(new Error("the fake capture tool did not answer")), ms)));
    try {
      return await Promise.race([promise, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  send(cmd) {
    const done = new Promise((r) => this.waiting.push(r));
    this.proc.stdin.write(cmd + "\n");
    return this.answer(done);
  }

  /** Opens the capture as a tool that brings its own window first does; { hwnd, front }. */
  async capture() {
    const [hwnd, front] = (await this.send("capture")).split(" ");
    return { hwnd, front: front === "front" };
  }

  /** Closes the capture: the tool's ordinary window comes to the front. */
  end() {
    return this.send("end");
  }

  /** Pins an image to the screen, in front; { hwnd, front }. */
  async pin() {
    const [hwnd, front] = (await this.send("pin")).split(" ");
    return { hwnd, front: front === "front" };
  }

  unpin() {
    return this.send("unpin");
  }

  /** The visible always-on-top windows, front to back: [{ hwnd, pid }]. */
  async order() {
    return (await this.send("order"))
      .split(" ")
      .filter(Boolean)
      .map((w) => {
        const [hwnd, pid] = w.split(":");
        return { hwnd, pid: Number(pid) };
      });
  }

  stop() {
    try {
      this.proc.stdin.write("quit\n");
    } catch {}
    setTimeout(() => {
      try {
        this.proc.kill();
      } catch {}
    }, 2_000).unref();
  }
}
