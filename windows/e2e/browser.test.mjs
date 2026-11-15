// Lumo's browser for agents (browser.rs): hidden WebView2 tabs inside Lumo,
// driven through the DevTools protocol, reached the way the island chat's
// Claude Code reaches them, by the real `lumo-hook --mcp --tools=browser`
// (lib/mcp.mjs). Off at first: refused, naming the setting. On: a tab opens
// with no window on screen, reads the page as text with [k] refs, types and
// clicks by ref (the page's own script runs and calls home), scrolls, takes a
// screenshot of the page as drawn, works beside a second tab of another chat
// at the same time, and closes.
// The pages come from a small server of the test's own on 127.0.0.1, never at
// "/" (the driver names a webview showing "/" the island).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before } from "node:test";

import { HOOK, Lumo, OUT } from "./lib/app.mjs";
import { windowsOnScreen } from "./lib/dialog.mjs";
import { sleep } from "./lib/driver.mjs";
import { flow, step } from "./lib/flow.mjs";
import { imageOf, mcpClient, textOf } from "./lib/mcp.mjs";
import { decodePng } from "./lib/png.mjs";

const G = "Agent browser";
const app = new Lumo("browser");

const NAMES = ["browser_open", "browser_read", "browser_click", "browser_type", "browser_scroll", "browser_screenshot", "browser_close"];
// The page's background, looked for in the screenshot: no default of any browser.
const GREEN = [31, 138, 112];
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Lumo e2e page</title>
<style>
  html, body { margin: 0; background: rgb(${GREEN.join(", ")}); color: #fff; font: 16px sans-serif; }
  main { padding: 16px; height: 220px; }
  .tall { height: 4000px; }
</style></head>
<body>
<main>
  <h1>Hello from e2e</h1>
  <input id="name" aria-label="Your name" placeholder="Your name">
  <button id="go" type="button">Go</button>
  <p id="out"></p>
</main>
<div class="tall"></div>
<script>
  document.getElementById("go").addEventListener("click", async () => {
    const v = document.getElementById("name").value;
    await fetch("/clicked?v=" + encodeURIComponent(v));
    document.getElementById("out").textContent = "Thanks, " + v;
  });
</script>
</body></html>`;
const SECOND = `<!doctype html>
<html><head><meta charset="utf-8"><title>Lumo e2e second</title></head>
<body><h1>Second page</h1><a href="/page.html">Back to the first</a></body></html>`;

/** The values the page's Go button sent home, in order. */
const clicked = [];
let server = null;
let base = "";
/** The chat's relay, and a second one of another chat. */
let a = null;
let b = null;
let browsing = false;
let tab = 0;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const page = (html) => res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
    if (url.pathname === "/page.html") page(PAGE);
    else if (url.pathname === "/second.html") page(SECOND);
    else if (url.pathname === "/clicked") {
      clicked.push(url.searchParams.get("v"));
      res.writeHead(204).end();
    } else res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}/`;
});
after(async () => {
  await a?.close();
  await b?.close();
  server?.close();
  await app.close();
});

/** A relay of chat `chat`, its handshake done. */
async function relay(chat) {
  const m = mcpClient(HOOK, { env: app.env, chat });
  const hello = await m.init();
  step(`lumo-hook --mcp of chat ${chat}: protocol ${hello.protocolVersion}`);
  return m;
}

/** A tool call written in the flow's story, its text returned with the result. */
async function call(m, name, args, ms = 30_000) {
  const t0 = Date.now();
  const r = await m.call(name, args, ms);
  const text = textOf(r);
  step(`${name} ${JSON.stringify(args)} → ${r.isError ? "ERROR " : ""}${Date.now() - t0} ms: ${text.split("\n").slice(0, 3).join(" | ").slice(0, 200)}`);
  return { r, text };
}

/** A call that must work: its text. */
async function ok(m, name, args, ms) {
  const { r, text } = await call(m, name, args, ms);
  assert.ok(!r.isError, `${name} failed: ${text}`);
  return text;
}

/** Lumo again, with Let agents browse the web on (Settings → Security). */
async function browsingOn() {
  if (browsing) return;
  await a?.close();
  a = null;
  await app.quit();
  await app.launch({ settings: { chatBrowser: true } });
  a = await relay("e2e-browser");
  browsing = true;
}

/** The first page's tab, opened if no flow has yet. */
async function pageTab() {
  await browsingOn();
  if (!tab) await openPage();
  return tab;
}

/** Opens the first page in a new tab: its number. */
async function openPage() {
  // The first tab starts the browser's own WebView2: slower than the rest.
  const text = await ok(a, "browser_open", { url: base + "page.html" }, 55_000);
  const n = Number(/^Tab (\d+):/.exec(text)?.[1]);
  assert.ok(n > 0, `browser_open names its tab: ${text}`);
  assert.match(text, /Lumo e2e page/, "the answer has the page's title");
  tab = n;
  return n;
}

/** The [k] of the control of a read whose text (what follows its [k]) matches `line`. */
function ref(read, line) {
  // Every [k] of each line: inline controls share one ("[1] textbox … [2] button …").
  for (const l of read.split("\n")) {
    for (const m of l.matchAll(/\[(\d+)\]\s*([^[]*)/g)) if (line.test(m[2].trim())) return Number(m[1]);
  }
  assert.fail(`no [k] for ${line} in:\n${read}`);
}

/** The scroll position a read reports. */
function scrollOf(read) {
  const y = Number(/Scroll:\s*(\d+)/.exec(read)?.[1]);
  assert.ok(Number.isFinite(y), `the read says where the page is scrolled:\n${read.slice(0, 300)}`);
  return y;
}

/** Lumo's windows on screen, written down. */
/** A window of this machine found by its exact title: a picture of it, as the user sees it. */
function windowShot(title, file) {
  const ps = `${WIN32}
$h = [LumoE2eWin]::FindWindow([NullString]::Value, '${title.replace(/'/g, "''")}')
$r = New-Object LumoE2eWin+R
[void][LumoE2eWin]::GetWindowRect($h, [ref]$r)
$w = $r.Ri - $r.L; $ht = $r.B - $r.T
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $w, $ht
[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save('${file.replace(/'/g, "''")}')`;
  spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore", timeout: 15_000 });
}

/** The window's own X: WM_CLOSE, as a click on it sends. */
function closeWindow(title) {
  const ps = `${WIN32}
$h = [LumoE2eWin]::FindWindow([NullString]::Value, '${title.replace(/'/g, "''")}')
[void][LumoE2eWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)`;
  spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore", timeout: 15_000 });
}

const WIN32 = `Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class LumoE2eWin {
  public struct R { public int L, T, Ri, B; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
"@`;

function shown() {
  const titles = windowsOnScreen(app.proc.pid);
  step(`Lumo's windows on screen: ${JSON.stringify(titles)}`);
  return titles;
}

flow(G, "Browsing off: the tools are listed and refused, naming the setting", app, async () => {
  await app.launch({ settings: { chatBrowser: false } });
  const m = await relay("e2e-browser-off");
  try {
    const names = (await m.list()).map((t) => t.name);
    step(`tools: ${names.join(", ")}`);
    for (const name of NAMES) assert.ok(names.includes(name), `${name} is listed`);
    const { r, text } = await call(m, "browser_open", { url: base + "page.html" });
    assert.equal(r.isError, true, "browser_open is refused while browsing is off");
    assert.match(text, /Settings/, "the refusal says where to turn it on");
    assert.match(text, /Security/, "the refusal names the Security page");
    assert.equal(clicked.length, 0);
  } finally {
    await m.close();
  }
});

flow(G, "Browsing on: a tab opens hidden, with the page loaded", app, async () => {
  await browsingOn();
  const names = (await a.list()).map((t) => t.name);
  for (const name of NAMES) assert.ok(names.includes(name), `${name} is listed`);
  const was = shown();
  await openPage();
  const now = shown();
  assert.ok(!now.some((t) => /browser|e2e page/i.test(t)), "the tab's window is not on screen");
  assert.ok(now.length <= was.length, "no new window came on screen");
});

flow(G, "Read, type and click by ref: the page's script runs and calls home", app, async () => {
  const n = await pageTab();
  const read = await ok(a, "browser_read", { tab: n });
  assert.match(read, /Hello from e2e/, "the page's heading");
  assert.match(read, new RegExp(`^Tab ${n}\\b`), "the read starts with its tab");
  const go = ref(read, /^button "Go"/);
  const field = ref(read, /"Your name"/);
  step(`refs: field [${field}], Go [${go}]`);

  await ok(a, "browser_type", { tab: n, ref: field, text: "Lumo e2e" });
  const typed = await ok(a, "browser_read", { tab: n });
  assert.match(typed, /= "Lumo e2e"/, "the field holds what was typed");

  const sent = clicked.length;
  const answer = await ok(a, "browser_click", { tab: n, ref: go });
  assert.match(answer, new RegExp(`Clicked \\[${go}\\]`));
  for (let i = 0; clicked.length === sent && i < 50; i++) await sleep(100);
  step(`the page called home with: ${JSON.stringify(clicked.slice(sent))}`);
  assert.deepEqual(clicked.slice(sent), ["Lumo e2e"], "the click ran the page's own script, with the typed value");

  let thanked = "";
  for (let i = 0; i < 10 && !/Thanks, Lumo e2e/.test(thanked); i++) {
    if (i) await sleep(500);
    thanked = await ok(a, "browser_read", { tab: n });
  }
  assert.match(thanked, /Thanks, Lumo e2e/, "the read shows what the script wrote");
});

flow(G, "Scroll and screenshot: the page moves, and the picture is the page", app, async () => {
  const n = await pageTab();
  const top = scrollOf(await ok(a, "browser_read", { tab: n }));
  await ok(a, "browser_scroll", { tab: n, direction: "down" });
  let y = top;
  for (let i = 0; i < 10 && y <= top; i++) {
    if (i) await sleep(200);
    y = scrollOf(await ok(a, "browser_read", { tab: n }));
  }
  step(`scrolled from ${top} to ${y}`);
  assert.ok(y > top, "scrolling down moved the page");

  const { r, text } = await call(a, "browser_screenshot", { tab: n });
  assert.ok(!r.isError, `browser_screenshot failed: ${text}`);
  const img = imageOf(r);
  assert.ok(img, "the answer has an image");
  assert.equal(img.mimeType, "image/png");
  const png = decodePng(Buffer.from(img.data, "base64"));
  step(`the screenshot: ${png.width} × ${png.height}`);
  assert.ok(png.width > 100 && png.height > 100, "a picture of the page, not an empty one");
  const said = /(\d+)\s*[×x]\s*(\d+)/.exec(text);
  if (said) assert.deepEqual([Number(said[1]), Number(said[2])], [png.width, png.height], "the text gives the image's own size");
  // The middle of the page, scrolled past the heading: only its background.
  const i = (Math.floor(png.height / 2) * png.width + Math.floor(png.width / 2)) * 4;
  const px = [...png.rgba.subarray(i, i + 3)];
  step(`its middle pixel: rgb(${px.join(", ")})`);
  assert.ok(px.every((v, k) => Math.abs(v - GREEN[k]) <= 8), `the page is drawn: rgb(${px.join(", ")}) is not rgb(${GREEN.join(", ")})`);
});

flow(G, "Two tabs at once: another chat's tab works beside it, and each chat sees only its own", app, async () => {
  const n = await pageTab();
  b ??= await relay("e2e-browser-other");
  // Two relays, two calls in flight together: a new tab loads while the first is read.
  const t0 = Date.now();
  const [opened, read] = await Promise.all([ok(b, "browser_open", { url: base + "second.html" }, 55_000), ok(a, "browser_read", { tab: n })]);
  step(`both answered within ${Date.now() - t0} ms`);
  const m = Number(/^Tab (\d+):/.exec(opened)?.[1]);
  assert.ok(m > 0 && m !== n, `a tab of its own: ${opened}`);
  assert.match(read, /Hello from e2e/);
  assert.match(await ok(b, "browser_read", { tab: m }), /Second page/);
  assert.match(await ok(a, "browser_read", { tab: n }), /Hello from e2e/, "the first tab still shows its page");
  assert.ok(!shown().some((t) => /browser|e2e/i.test(t)), "neither tab is on screen");

  const { r, text } = await call(a, "browser_read", { tab: m });
  assert.equal(r.isError, true, "a chat can't read another chat's tab");
  assert.match(text, new RegExp(`No tab ${m} in this chat`));
  await ok(b, "browser_close", { tab: m });
});

flow(G, "Watch: the tab comes on screen as a window of its own, and closing it only hides it", app, async () => {
  const n = await pageTab();
  await ok(a, "browser_scroll", { tab: n, direction: "up", pages: 10 });
  // The Agents card's Watch, as the island calls it; the tab has no agent of its own, so "main".
  await app.d.js("window.__TAURI_INTERNALS__.invoke('chat_browser_watch', { chatId: 'e2e-browser', agentId: 'main' }); return true");
  let title = "";
  for (let i = 0; i < 30 && !title; i++) {
    if (i) await sleep(200);
    title = windowsOnScreen(app.proc.pid).find((t) => /^Lumo · 127\.0\.0\.1 · /.test(t)) ?? "";
  }
  step(`the watched window: ${JSON.stringify(title)}`);
  assert.equal(title, "Lumo · 127.0.0.1 · Lumo e2e page", "the window says its site, then the page's title");
  await sleep(800);
  const shot = join(OUT, "shots", "agent-browser-watch.png");
  windowShot(title, shot);
  if (existsSync(shot)) {
    const b64 = readFileSync(shot).toString("base64");
    step(`the window's picture: ${b64.length} base64 characters`);
    for (let i = 0; i < b64.length; i += 4000) console.log(`B64 watch ${b64.slice(i, i + 4000)}`);
  }

  closeWindow(title);
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) {
    if (i) await sleep(200);
    gone = !windowsOnScreen(app.proc.pid).includes(title);
  }
  assert.ok(gone, "its X hides the window");
  assert.match(await ok(a, "browser_read", { tab: n }), /Hello from e2e/, "and the tab is still there, for the agent");
});

flow(G, "Close: the tab is gone, and its number with it", app, async () => {
  const n = await pageTab();
  assert.match(await ok(a, "browser_close", { tab: n }), new RegExp(`Tab ${n} closed`));
  tab = 0;
  const { r, text } = await call(a, "browser_read", { tab: n });
  assert.equal(r.isError, true, "a closed tab can't be read");
  assert.match(text, new RegExp(`No tab ${n} in this chat`));
});
