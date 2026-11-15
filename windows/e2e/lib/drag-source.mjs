// A program of the test's own whose windows sit under the island, for what a
// hand does there with the mouse (island.rs spawn_cursor_poll, `came_near`,
// platform may_carry_file and window_moving; src/island/window-move.ts):
//
// - a maximised window, as a File Explorer or a browser under the island:
//   its left half a text box (a press there and a drag select text, holding
//   the mouse capture as any window does), its right half a file to pick up
//   (a press there starts a real OLE drag of a file, DoDragDrop with
//   CF_HDROP, what File Explorer and the desktop do), and its title bar, by
//   which Windows moves it (its move loop, GUI_INMOVESIZE);
// - a small ordinary window, to be moved by its title bar across the island.
//
// It answers one line per command on stdin. While a file is being dragged its
// window's thread is in DoDragDrop: commands that need the window wait for it
// to end, so the flows ask only once the button is let go.
//
// Built once per run with Windows PowerShell's own C# compiler (Add-Type
// -OutputAssembly), as lib/capture.mjs: no dependency, nothing to install.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OUT } from "./app.mjs";

const SOURCE = String.raw`
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class LumoE2eDragSource {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

  static Form big, mover;
  static TextBox text;
  static Label file;
  static string path;
  // What the last DoDragDrop came back with: "none" before any.
  static volatile string dropped = "none";

  [STAThread]
  public static void Main(string[] args) {
    SetProcessDPIAware();
    path = args.Length > 0 ? args[0] : System.IO.Path.Combine(System.IO.Path.GetTempPath(), "lumo-e2e-drop.txt");
    Rectangle b = Screen.PrimaryScreen.Bounds;

    big = new Form();
    big.Text = "Lumo e2e: a window under the island";
    big.StartPosition = FormStartPosition.Manual;
    big.Bounds = new Rectangle(b.Width / 4, b.Height / 4, b.Width / 2, b.Height / 2);
    big.BackColor = Color.White;
    text = new TextBox();
    text.Multiline = true;
    text.ScrollBars = ScrollBars.None;
    text.Font = new Font("Segoe UI", 14);
    text.Dock = DockStyle.Left;
    string line = "Some text under the island, to be selected by dragging over it. ";
    text.Text = line + line + line + "\r\n" + line + line + line + "\r\n" + line + line + line;
    file = new Label();
    file.Text = "A file to pick up: " + System.IO.Path.GetFileName(path);
    file.TextAlign = ContentAlignment.MiddleCenter;
    file.BackColor = Color.LightSteelBlue;
    file.Dock = DockStyle.Fill;
    file.MouseDown += delegate (object s, MouseEventArgs e) {
      if (e.Button != MouseButtons.Left) return;
      dropped = "dragging";
      DataObject data = new DataObject(DataFormats.FileDrop, new string[] { path });
      dropped = file.DoDragDrop(data, DragDropEffects.Copy).ToString();
    };
    big.Controls.Add(file);
    big.Controls.Add(text);
    big.Resize += delegate { text.Width = big.ClientSize.Width / 2; };

    mover = new Form();
    mover.Text = "Lumo e2e: a window to move";
    mover.StartPosition = FormStartPosition.Manual;
    mover.Bounds = new Rectangle(40, b.Height - 260, 360, 180);
    mover.BackColor = Color.Honeydew;

    big.Shown += delegate { new Thread(Read) { IsBackground = true }.Start(); };
    Application.Run(big);
  }

  // To the front. If Windows says no (it may, to a program started by a
  // test), an Alt press first, which lets the next SetForegroundWindow through.
  static void ToFront(Form f) {
    f.Activate();
    if (GetForegroundWindow() == f.Handle) return;
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(f.Handle);
  }

  static string Rect(Form f) {
    return string.Format("{0} {1} {2} {3}", f.Left, f.Top, f.Width, f.Height);
  }

  // The middle of the title bar's height, on the screen: between the window's
  // top (a maximised one starts above the screen's) and its client area.
  static int TitleY(Form f) {
    int client = f.PointToScreen(Point.Empty).Y;
    int top = Math.Max(f.Top, Screen.FromControl(f).Bounds.Top);
    return (top + client) / 2;
  }

  static string On(Func<string> f) {
    return (string)big.Invoke(f);
  }

  static void Read() {
    Console.WriteLine("ready");
    string line;
    while ((line = Console.ReadLine()) != null) {
      string answer = "?";
      switch (line.Trim()) {
        case "show":
          // The big window, maximised and in front, its text not selected.
          answer = On(delegate {
            mover.Hide();
            big.Show();
            big.WindowState = FormWindowState.Maximized;
            text.Select(0, 0);
            dropped = "none";
            ToFront(big);
            Application.DoEvents();
            return TitleY(big) + " " + text.PointToScreen(Point.Empty).Y + " " + file.PointToScreen(Point.Empty).X;
          });
          break;
        case "state":
          answer = On(delegate { return big.WindowState + " " + Rect(big); });
          break;
        case "selected":
          answer = On(delegate { return text.SelectionLength.ToString(); });
          break;
        case "dropped":
          answer = dropped;
          break;
        case "mover":
          // The small window alone, in front, back at its place.
          answer = On(delegate {
            big.WindowState = FormWindowState.Normal;
            big.Hide();
            Rectangle b = Screen.PrimaryScreen.Bounds;
            mover.Bounds = new Rectangle(40, b.Height - 260, 360, 180);
            mover.Show();
            ToFront(mover);
            Application.DoEvents();
            return Rect(mover) + " " + TitleY(mover);
          });
          break;
        case "moverAt":
          answer = On(delegate { return Rect(mover); });
          break;
        case "hide":
          answer = On(delegate { mover.Hide(); big.WindowState = FormWindowState.Minimized; return "ok"; });
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

const DIR = join(OUT, "fake-drag");
const EXE = join(DIR, "LumoE2eDragSource.exe");
/** The file the program offers to pick up. */
export const DROP_FILE = join(DIR, "lumo-e2e-drop.txt");

function build() {
  const source = join(DIR, "drag-source.cs");
  mkdirSync(DIR, { recursive: true });
  writeFileSync(DROP_FILE, "A file carried under the island by the end-to-end tests.\n");
  // Built again when its source changed since.
  if (existsSync(EXE) && existsSync(source) && readFileSync(source, "utf8") === SOURCE) return;
  rmSync(EXE, { force: true });
  writeFileSync(source, SOURCE);
  const ps = `Add-Type -TypeDefinition ([IO.File]::ReadAllText('${source.replace(/'/g, "''")}')) ` +
    `-ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly '${EXE.replace(/'/g, "''")}' -OutputType ConsoleApplication`;
  const out = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 120_000 });
  if (!existsSync(EXE)) throw new Error(`the fake drag source did not build: ${out.stdout}\n${out.stderr}`);
}

const box = (s) => {
  const [x, y, w, h] = s.split(" ").map(Number);
  return { x, y, w, h };
};

export class DragSource {
  async start() {
    build();
    this.proc = spawn(EXE, [DROP_FILE], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
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
    await this.answer(new Promise((r) => this.waiting.push(r)));
  }

  async answer(promise, ms = 15_000) {
    let timer;
    const late = new Promise((_, no) => (timer = setTimeout(() => no(new Error("the fake drag source did not answer")), ms)));
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

  /** The maximised window in front: where its title bar is, where its text starts, where the file's half starts. */
  async show() {
    const [titleY, textY, fileX] = (await this.send("show")).split(" ").map(Number);
    return { titleY, textY, fileX };
  }

  /** The maximised window's state ("Maximized", "Normal") and box. */
  async state() {
    const [state, ...rest] = (await this.send("state")).split(" ");
    return { state, ...box(rest.join(" ")) };
  }

  /** How many characters of the text are selected. */
  async selected() {
    return Number(await this.send("selected"));
  }

  /** What the last drag of the file came back with: "Copy" when taken, "None" when not, "none" before any. */
  dropped() {
    return this.send("dropped");
  }

  /** The small window alone in front; its box and its title bar's height. */
  async mover() {
    const [x, y, w, h, titleY] = (await this.send("mover")).split(" ").map(Number);
    return { x, y, w, h, titleY };
  }

  async moverAt() {
    return box(await this.send("moverAt"));
  }

  hide() {
    return this.send("hide");
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
