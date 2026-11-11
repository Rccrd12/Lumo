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
    await this.watchPresses();
    // The launch greeting first: the flows start from the closed island. The
    // page sets itself up before it greets (main.ts, island.launch()), which
    // on a slow machine is seconds after #island exists: wait for the
    // greeting to come out, then for the island to close after it.
    await this.d
      .until("const i = document.getElementById('island'); return i.classList.contains('greet-light') || i.getBoundingClientRect().height >= 60", 20_000, "the launch greeting")
      .catch(() => console.log("    · no launch greeting seen"));
    await this.closed();
    // Closed and staying closed: nothing of the launch is left to come out.
    await sleep(1_500);
    if ((await this.islandHeight()) >= 60) await this.closed();
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

  /**
   * Clicks an element (an id from the driver) with the real mouse, as a hand
   * would: the cursor goes there, waits for the island to take the mouse
   * (Rust lets clicks through it everywhere else), and presses.
   */
  async click(id) {
    await this.aim(id);
    await this.mouse.down();
    await sleep(50);
    await this.mouse.up();
  }

  /**
   * Puts the real cursor on an element's centre and leaves it there. The
   * island may grow or shift as the cursor comes onto it, and the page may
   * place the cursor a few pixels from where the screen maths say: the page's
   * own mousemove tells where the cursor really is, and the aim is corrected
   * until it sits on the element, as an eye following it would.
   */
  async aim(id) {
    // The element's centre, or for one partly under others (a resize grip
    // under the chat's field) the first point along its middle that is its own.
    const where = () => this.d.js(`
      const el = arguments[0], r = devicePixelRatio, b = el.getBoundingClientRect();
      let cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const own = (x, y) => { const e = document.elementFromPoint(x, y); return e === el || el.contains(e); };
      if (!own(cx, cy)) {
        const tall = b.height >= b.width;
        for (let i = 1; i < 40; i++) {
          const x = tall ? cx : b.left + (b.width * i) / 40, y = tall ? b.top + (b.height * i) / 40 : cy;
          if (own(x, y)) { cx = x; cy = y; break; }
        }
      }
      return { cx, cy, x: (screenX + cx) * r, y: (screenY + cy) * r, r, seen: window.__e2eMove ?? null };`, this.d.ref(id));
    const onIt = () => this.d.js(`
      const m = window.__e2eMove; if (!m) return "no mousemove seen";
      const e = document.elementFromPoint(m[0], m[1]);
      return arguments[0] === e || arguments[0].contains(e) ? "on target" : "on " + (e ? e.className || e.tagName : "nothing");`, this.d.ref(id));
    let hit = "";
    for (let round = 0; round < 3; round++) {
      let t = await where();
      // A pixel off on a new round, so the page hears a move even if the
      // cursor is already there.
      let at = { x: t.x + round, y: t.y };
      for (let i = 0; i < 6; i++) {
        // Only a move the page heard after this one counts: an older reading
        // would send the cursor off by however far it was.
        await this.d.js("window.__e2eMove = null");
        await this.mouse.move(at.x, at.y);
        let seen = null;
        for (let k = 0; k < 8 && !seen; k++) {
          await sleep(80);
          t = await where();
          seen = t.seen;
        }
        if (!seen) {
          // The page did not hear it: aim by the element's place alone.
          at = { x: t.x, y: t.y };
          continue;
        }
        // Where the page saw the cursor, against where the element's centre is now.
        const dx = t.cx - seen[0], dy = t.cy - seen[1];
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2) break;
        // More than a correction (the island moved under the cursor): start
        // again from the element's place.
        at = Math.abs(dx) > 60 || Math.abs(dy) > 60 ? { x: t.x, y: t.y } : { x: at.x + dx * t.r, y: at.y + dy * t.r };
      }
      await sleep(150);
      hit = await onIt();
      if (hit === "on target") return hit;
      console.log(`    · aim: ${hit}`);
      await sleep(400);
    }
    return hit;
  }

  /** What the page saw of the last mouse press (set by watchPresses), for a flow's story. */
  async lastPress() {
    return this.d.js("return window.__e2ePress ?? null");
  }

  /** Notes every press the page receives, before the page's own handlers. */
  async watchPresses() {
    await this.d.js(`
      if (!window.__e2eWatch) {
        window.__e2eWatch = true;
        window.addEventListener("mousemove", (e) => { window.__e2eMove = [e.clientX, e.clientY]; }, true);
        window.addEventListener("mousedown", (e) => {
          const t = e.target;
          window.__e2ePress = { at: [e.clientX, e.clientY], target: (t.id ? "#" + t.id : "") + "." + String(t.className || t.tagName).split(" ").join(".") };
        }, true);
      }`);
  }

  /** The cursor far from the island. */
  async away() {
    const s = await this.screen();
    await this.mouse.move(s.w / 2, s.h - 40);
  }

  /** The island's height on the page: closed (or hidden) under 60, open above 100. */
  async islandHeight() {
    return this.d.js("return document.getElementById('island').getBoundingClientRect().height");
  }

  /**
   * Waits for the island to be closed (or hidden): no greeting, no card, no
   * home. The cursor passes over it and leaves, as after a click: an island
   * the cursor never left stays open.
   */
  async closed(ms = 20_000) {
    if ((await this.islandHeight()) >= 60) {
      const box = await this.islandBox();
      await this.mouse.move(box.x + box.w / 2, box.y + Math.min(20, box.h / 2));
      await sleep(300);
    }
    await this.away();
    await this.d.until("return document.getElementById('island').getBoundingClientRect().height < 60", ms, "the island closing");
  }

  /** Opens the island as a user does: the cursor onto it, then a click on the closed island. */
  async open() {
    const s = await this.screen();
    for (let attempt = 1; ; attempt++) {
      // The wake strip at the edge, then the closed island it brings out.
      await this.mouse.move(s.w / 2, 2);
      await sleep(600);
      const box = await this.islandBox();
      await this.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
      await sleep(500);
      if ((await this.islandHeight()) < 100) {
        await this.mouse.down();
        await sleep(60);
        await this.mouse.up();
      }
      try {
        await this.d.until("return document.getElementById('island').getBoundingClientRect().height > 100", 4_000, "the island opening on a click");
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        await this.away();
        await sleep(1_000);
      }
    }
    // The cursor stays over it, so it stays open.
    const open = await this.islandBox();
    await this.mouse.move(open.x + open.w / 2, open.y + 20);
  }

  /** The island's width once it has stopped moving (it springs to a new size). */
  async settledWidth() {
    let last = (await this.islandBox()).cssW;
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      const now = (await this.islandBox()).cssW;
      if (Math.abs(now - last) < 0.5) return Math.round(now);
      last = now;
    }
    return Math.round(last);
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

