// Feasibility spike for end-to-end tests (not a test suite yet).
// Drives the real Lumo build (`--features e2e`, DevTools on 127.0.0.1:9222)
// through msedgedriver (W3C WebDriver on :4444), attached to its WebView2,
// with nothing but fetch: no WebdriverIO, no new dependency.
//
// node e2e/spike.mjs <path to lumo-hook.exe> <out dir>   (Lumo already running)

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [hook, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const W = "http://127.0.0.1:4444";
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wd(method, path, body) {
  const res = await fetch(W + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json).slice(0, 400)}`);
  return json.value;
}

const results = {};
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    const v = await fn();
    results[name] = { ok: true, ms: Date.now() - t0, value: v };
    log("OK  ", name, Date.now() - t0, "ms", v === undefined ? "" : JSON.stringify(v).slice(0, 300));
    return v;
  } catch (err) {
    results[name] = { ok: false, ms: Date.now() - t0, error: String(err) };
    log("FAIL", name, String(err).slice(0, 500));
    return undefined;
  }
};

const shot = async (name) => {
  const b64 = await wd("GET", `/session/${sid}/screenshot`);
  writeFileSync(join(out, `${name}.png`), Buffer.from(b64, "base64"));
  return `${name}.png`;
};
const js = (script, args = []) => wd("POST", `/session/${sid}/execute/sync`, { script, args });

// Runs lumo-hook the way Claude Code does: the event JSON on stdin, the reply on stdout.
function runHook(payload) {
  return new Promise((resolve) => {
    const p = spawn(hook, [], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const t0 = Date.now();
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
    p.stdin.end(JSON.stringify(payload));
  });
}

// The first visible element for `css`, or an error after `ms`.
async function visible(css, ms = 10000) {
  const t0 = Date.now();
  for (let i = 0; Date.now() - t0 < ms; i++) {
    const found = await wd("POST", `/session/${sid}/elements`, { using: "css selector", value: css });
    for (const el of found) {
      const shown = await wd("GET", `/session/${sid}/element/${el[ELEMENT]}/displayed`).catch(() => false);
      if (shown) return { id: el[ELEMENT], tries: i };
    }
    await sleep(200);
  }
  throw new Error(`no visible ${css} after ${ms} ms`);
}
const click = (el) => wd("POST", `/session/${sid}/element/${el.id}/click`, {});
const ps = (cmd) => new Promise((resolve) => {
  const p = spawn("powershell", ["-NoProfile", "-Command", cmd], { stdio: ["ignore", "pipe", "pipe"] });
  let o = "";
  p.stdout.on("data", (d) => (o += d));
  p.on("close", () => resolve(o.trim()));
});
const cursor = (x, y) => ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`);
const cpu = () => ps("(Get-Process lumo | Measure-Object CPU -Sum).Sum").then(Number);

const base = {
  session_id: "e2e-spike-0001",
  transcript_path: "C:\\e2e\\transcript.jsonl",
  cwd: process.cwd(),
  permission_mode: "default",
};

let sid;
await step("devtools targets", async () => {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
      return list.map((t) => `${t.type} ${t.url} ${t.title}`);
    } catch { await sleep(500); }
  }
  throw new Error("no DevTools on 9222 after 30 s");
});
const session = await step("new session", async () => {
  const v = await wd("POST", "/session", {
    capabilities: { alwaysMatch: { browserName: "webview2", "ms:edgeOptions": { debuggerAddress: "127.0.0.1:9222" } } },
  });
  sid = v.sessionId;
  return { sessionId: v.sessionId, caps: Object.keys(v.capabilities || {}) };
});
if (!session) {
  writeFileSync(join(out, "results.json"), JSON.stringify(results, null, 2));
  process.exit(1);
}
await sleep(4000);

const handles = (await step("window handles", () => wd("GET", `/session/${sid}/window/handles`))) || [];
const windows = {};
for (const [i, h] of handles.entries()) {
  await step(`window ${i}`, async () => {
    await wd("POST", `/session/${sid}/window`, { handle: h });
    const info = await js(
      "return { url: location.href, title: document.title, w: innerWidth, h: innerHeight, vis: document.visibilityState, body: document.body.className, n: document.querySelectorAll('*').length }",
    );
    windows[h] = info;
    try { info.shot = await shot(`start-${i}`); } catch (e) { info.shot = String(e).slice(0, 200); }
    return info;
  });
}
const island = handles.find((h) => /index\.html|\/$/.test(windows[h]?.url || "") && !/settings|computer/.test(windows[h]?.url || ""));
log("island handle", island);
if (island) await wd("POST", `/session/${sid}/window`, { handle: island });

// A session, then a permission request, through the real relay and pipe.
await step("hook SessionStart", () => runHook({ ...base, hook_event_name: "SessionStart", source: "startup" }));
await step("hook UserPromptSubmit", () => runHook({ ...base, hook_event_name: "UserPromptSubmit", prompt: "e2e spike: say hello" }));
await sleep(1000);
await step("shot after session", () => shot("island-session"));

const pending = runHook({
  ...base,
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "echo hello from the e2e spike", description: "Say hello" },
});
const button = await step("allow button appears", () => visible(".cp-approval .cp-action.allow, .allow-btn"));
await step("shot card", () => shot("island-card"));
if (button) {
  await sleep(800); // CLICK_GUARD_MS is 600
  await step("click Allow", () => click(button));
}
const reply = await step("hook reply", () =>
  Promise.race([pending, sleep(20000).then(() => ({ timeout: true }))]),
);
results.verdict = { allowed: /"behavior"\s*:\s*"allow"/.test(reply?.stdout || "") };

// A Write of 400 KB (the case #203 fixed): the closed card, then the full card from a click on it.
const big = "x".repeat(400 * 1024);
const pendingWrite = runHook({ ...base, hook_event_name: "PermissionRequest", tool_name: "Write", tool_input: { file_path: "C:\\e2e\\big.txt", content: big } });
const compactWrite = await step("write: closed card", () => visible(".cp-approval", 10000));
if (compactWrite) {
  await sleep(800);
  await step("write: open full card", () => click(compactWrite));
  const full = await step("write: full card Allow", () => visible(".allow-btn", 5000));
  await step("write: shot full card", () => shot("island-write-full"));
  if (full) { await sleep(800); await step("write: click Allow", () => click(full)); }
}
const writeReply = await step("write: hook reply", () => Promise.race([pendingWrite, sleep(15000).then(() => ({ timeout: true }))]));
results.verdict.writeAllowed = /"behavior"\s*:\s*"allow"/.test(writeReply?.stdout || "");

// Hover: the island opens from the real cursor (Rust polls it), closes when it leaves.
await step("cursor away", () => cursor(512, 600));
await sleep(1500);
await step("shot closed", () => shot("island-closed"));
await step("cursor on island", () => cursor(512, 2));
await sleep(1500);
await step("shot hover", () => shot("island-hover"));
await step("hover dom", () => js("return { cls: document.body.className, views: [...document.querySelectorAll('[class*=view]')].filter(e => e.offsetParent).map(e => e.className).slice(0, 8) }"));
await step("cursor away again", () => cursor(512, 600));
await sleep(2000);
// The rule: 0 % CPU while the island is hidden. CPU seconds of lumo.exe over 10 s, idle.
const c0 = await cpu();
await sleep(10000);
const c1 = await cpu();
results.verdict.idleCpuSecondsPer10s = Math.round((c1 - c0) * 1000) / 1000;
log("verdict", results.verdict);
await sleep(500);
await step("shot after", () => shot("island-after"));

// The Settings window: made hidden at launch, shown on demand.
const settings = handles.find((h) => /settings/.test(windows[h]?.url || ""));
if (settings) {
  await step("settings switch", () => wd("POST", `/session/${sid}/window`, { handle: settings }));
  await step("settings text", () => js("return document.body.innerText.slice(0, 600)"));
  await step("settings shot (hidden)", () => shot("settings-hidden"));
}

await step("delete session", () => wd("DELETE", `/session/${sid}`));
writeFileSync(join(out, "results.json"), JSON.stringify({ windows, results }, null, 2));
// The run's artifacts are not readable from where this spike is reviewed: the
// screenshots also go to the log, base64 in lines.
for (const name of ["island-card", "island-write-full", "island-closed", "island-hover"]) {
  let b64;
  try { b64 = readFileSync(join(out, `${name}.png`)).toString("base64"); } catch { continue; }
  for (let i = 0; i < b64.length; i += 4000) console.log(`B64 ${name} ${b64.slice(i, i + 4000)}`);
}
log("verdict", results.verdict);
process.exit(results.verdict.allowed && results.verdict.writeAllowed ? 0 : 1);
