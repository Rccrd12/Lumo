// Lumo under test: the build made with --features e2e, started with a
// profile of its own (USERPROFILE, APPDATA, LOCALAPPDATA in e2e-out), the
// WebDriver attached to its windows, the real mouse, and a fake agent.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Driver, sleep } from "./driver.mjs";
import { runHook } from "./hook.mjs";
import { Mouse } from "./input.mjs";

const WINDOWS = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const OUT = process.env.LUMO_E2E_OUT ?? join(WINDOWS, "e2e-out");
const EXE = process.env.LUMO_EXE ?? join(WINDOWS, "target", "debug", "lumo.exe");
export const HOOK = process.env.LUMO_HOOK ?? join(WINDOWS, "target", "release", "lumo-hook.exe");
const EDGEDRIVER = process.env.MSEDGEDRIVER ?? "msedgedriver";
const ON_CI = process.env.GITHUB_ACTIONS === "true";

if (process.platform !== "win32") throw new Error("The end-to-end tests drive the Windows app: run them on Windows.");
if (!ON_CI && process.env.LUMO_E2E_LOCAL !== "1") {
  throw new Error("The end-to-end tests start and stop Lumo. Close your own Lumo and set LUMO_E2E_LOCAL=1 to run them here.");
}

let edgedriver = null;
async function ensureDriver() {
  try {
    await fetch("http://127.0.0.1:4444/status");
    return;
  } catch {}
  edgedriver = spawn(EDGEDRIVER, ["--port=4444"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch("http://127.0.0.1:4444/status");
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error("msedgedriver did not start on port 4444");
}

async function devtoolsUp(up, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    let ok = false;
    try {
      ok = (await fetch("http://127.0.0.1:9222/json/version")).ok;
    } catch {}
    if (ok === up) return;
    if (Date.now() > end) throw new Error(up ? "Lumo's DevTools port never opened (is it built with --features e2e?)" : "Lumo did not quit");
    await sleep(200);
  }
}

export class Lumo {
  /** `name` names the profile folder; flows of one file share it. */
  constructor(name) {
    this.name = name;
    this.profile = join(OUT, "profiles", name);
    this.d = new Driver();
    this.mouse = null;
    this.proc = null;
    this.handles = {};
    this.sessions = 0;
  }

  get env() {
    return {
      ...process.env,
      USERPROFILE: join(this.profile, "home"),
      APPDATA: join(this.profile, "roaming"),
      LOCALAPPDATA: join(this.profile, "local"),
    };
  }

  /** Starts Lumo; `fresh` starts from an empty profile. */
  async launch({ fresh = true } = {}) {
    if (fresh) {
      rmSync(this.profile, { recursive: true, force: true });
      // The webview keeps its own storage under the real %LOCALAPPDATA%
      // whatever the variables say: emptied on the CI machine only.
      if (ON_CI) rmSync(join(process.env.LOCALAPPDATA, "com.rccrd12.lumo", "EBWebView"), { recursive: true, force: true });
    }
    for (const dir of ["home", "roaming", "local", "home/e2e-app"]) mkdirSync(join(this.profile, dir), { recursive: true });
    await ensureDriver();
    this.proc = spawn(EXE, [], { env: this.env, stdio: "ignore", detached: false });
    await devtoolsUp(true);
    await this.d.attach();
    // The island's page may still be loading when DevTools opens.
    for (let i = 0; ; i++) {
      this.handles = await this.d.windows();
      if (this.handles.island && this.handles.settings) break;
      if (i > 50) throw new Error(`Lumo's windows did not all come up: ${Object.keys(this.handles).join(", ")}`);
      await sleep(200);
    }
    await this.d.switchTo(this.handles.island);
    await this.d.until("return !!document.getElementById('island')", 15_000, "the island's page");
    if (!this.mouse) {
      this.mouse = new Mouse();
      await this.mouse.start();
    }
    await this.away();
  }

  /** Quits Lumo the hard way, as a crash or a shutdown would. */
  async quit() {
    await this.d.detach();
    if (this.proc) {
      spawnSync("taskkill", ["/PID", String(this.proc.pid), "/T", "/F"], { stdio: "ignore" });
      this.proc = null;
    }
    await devtoolsUp(false).catch(() => {});
  }

  async close() {
    await this.quit();
    this.mouse?.stop();
    this.mouse = null;
    if (edgedriver) {
      edgedriver.kill();
      edgedriver = null;
    }
  }

  // ── The island ───────────────────────────────────────────────────────────

  /** The screen, in physical pixels (what the mouse uses). */
  async screen() {
    return this.d.js("const r = devicePixelRatio; return { w: screen.width * r, h: screen.height * r, r }");
  }

  /** The island's box on the screen, in physical pixels. */
  async islandBox() {
    return this.d.js(`
      const r = devicePixelRatio, b = document.getElementById('island').getBoundingClientRect();
      return { x: (screenX + b.left) * r, y: (screenY + b.top) * r, w: b.width * r, h: b.height * r, cssW: b.width, cssH: b.height };`);
  }

  /** An element's centre on the screen, in physical pixels. */
  async onScreen(css) {
    return this.d.js(`
      const r = devicePixelRatio, e = [...document.querySelectorAll(arguments[0])].find((e) => e.offsetParent);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: (screenX + b.left + b.width / 2) * r, y: (screenY + b.top + b.height / 2) * r };`, css);
  }

  /** The cursor far from the island. */
  async away() {
    const s = await this.screen();
    await this.mouse.move(s.w / 2, s.h - 40);
  }

  /** The cursor on the island (or on its wake strip while it is hidden): it opens. */
  async hover() {
    const s = await this.screen();
    const box = await this.islandBox();
    const y = box.h > 30 ? box.y + Math.min(24, box.h / 2) : 2;
    await this.mouse.move(s.w / 2, y);
    await this.d.until("return document.getElementById('island').getBoundingClientRect().height > 100", 8_000, "the island opening under the cursor");
  }

  /** What the island shows: the views on screen, its size. */
  async state() {
    return this.d.js(`
      const b = document.getElementById('island').getBoundingClientRect();
      return {
        views: [...document.querySelectorAll('#views > .view')].filter((v) => v.offsetParent && v.classList.contains('on')).map((v) => v.className),
        island: [Math.round(b.width), Math.round(b.height)],
        body: document.body.className,
      };`);
  }

  // ── A fake agent ─────────────────────────────────────────────────────────

  /** A Claude Code session of its own, for one flow. */
  agent(label = "flow") {
    this.sessions += 1;
    mkdirSync(join(this.profile, "home", "e2e-app"), { recursive: true });
    const base = {
      session_id: `e2e-${this.name}-${this.sessions}-${label}`,
      transcript_path: join(this.profile, "home", `${label}.jsonl`),
      cwd: join(this.profile, "home", "e2e-app"),
      permission_mode: "default",
    };
    const send = (payload, opts) => runHook(HOOK, { ...base, ...payload }, { env: this.env, cwd: base.cwd, ...opts });
    return {
      id: base.session_id,
      send,
      async start(prompt = "e2e: do the thing") {
        await send({ hook_event_name: "SessionStart", source: "startup" }).result();
        await send({ hook_event_name: "UserPromptSubmit", prompt }).result();
      },
      permission(tool_name, tool_input) {
        return send({ hook_event_name: "PermissionRequest", tool_name, tool_input, permission_suggestions: [] });
      },
    };
  }
}

