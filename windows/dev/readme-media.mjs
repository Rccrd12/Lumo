// Records the README's videos of the island (docs/media/home.gif, plan.gif,
// chat.gif) from the real island in a browser: dev/look-preview.html with a
// pretend Claude Code, a drawn mouse pointer, and Playwright's recording.
// Not part of the app, and not one of its dependencies: it needs Playwright
// with Chromium (`npx playwright install chromium` once) and ffmpeg on PATH.
//
//   npm run dev                      (in another terminal)
//   node dev/readme-media.mjs        (from windows/; LUMO_DEV_URL for another port)
//
// docs/media/hero.gif is recorded on a real Windows desktop instead, with a
// Lumo of its own: dev/readme-hero.mjs.

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  console.error("Playwright is needed: npm i -g playwright && npx playwright install chromium");
  process.exit(1);
}

const BASE = (process.env.LUMO_DEV_URL ?? "http://localhost:1420") + "/dev/look-preview.html?";
const MEDIA = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs/media");
const BG = "radial-gradient(120% 140% at 50% 0%, #3a4560 0%, #232a3a 55%, #1a1f2b 100%)";
const POINTER = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="22" height="26" viewBox="0 0 22 26"><path d="M2 2 L2 20 L7 15.5 L10.5 23 L13.5 21.6 L10 14.3 L16.5 14.3 Z" fill="white" stroke="black" stroke-width="1.6" stroke-linejoin="round"/></svg>')}`;

/** The island at `query`, recorded in `dir`; what a scene needs to act. */
async function stage(query, width, height, dir) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width, height }, recordVideo: { dir, size: { width, height } } });
  // The music tile shows a song, as Windows' media session would hand it over.
  await ctx.addInitScript(() => {
    window.__lumoMock = { media_now: () => ({ title: "Midnight City", artist: "M83", app: "Spotify", playing: true }) };
  });
  const page = await ctx.newPage();
  const opened = Date.now();
  await page.goto(BASE + query);
  await page.waitForTimeout(800);
  await page.addStyleTag({ content: `#bar{display:none!important} html,body{background:${BG}!important}
    #pointer{position:fixed;left:0;top:0;width:22px;height:26px;z-index:100000;pointer-events:none;background:url("${POINTER}");display:none}` });
  await page.evaluate(() => {
    const p = document.createElement("div");
    p.id = "pointer";
    document.body.append(p);
    window.hook = (payload) => window.__lumoListeners.get("hook")?.({ event: "hook", id: 0, payload });
    window.emitEv = (event, payload) => window.__lumoListeners.get(event)?.({ event, id: 0, payload });
  });
  let at = { x: width / 2, y: height + 30 };
  const s = {
    page,
    wait: (ms) => page.waitForTimeout(ms),
    hook: (payload) => page.evaluate((p) => window.hook(p), payload),
    async move(x, y, ms = 600) {
      await page.evaluate(() => (document.getElementById("pointer").style.display = "block"));
      const from = { ...at }, steps = Math.max(1, Math.round(ms / 16));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const nx = from.x + (x - from.x) * e, ny = from.y + (y - from.y) * e;
        await page.mouse.move(nx, ny);
        await page.evaluate(([px, py]) => (document.getElementById("pointer").style.transform = `translate(${px - 2}px,${py - 2}px)`), [nx, ny]);
        await page.waitForTimeout(16);
      }
      at = { x, y };
    },
    async moveTo(selector, ms = 600) {
      const box = await page.locator(selector).first().boundingBox();
      await s.move(box.x + box.width / 2, box.y + box.height / 2, ms);
    },
    async click() {
      await page.mouse.down();
      await page.waitForTimeout(90);
      await page.mouse.up();
    },
    start: 0,
    mark() { s.start = (Date.now() - opened) / 1000; },
    async close() {
      await ctx.close();
      await browser.close();
    },
  };
  return s;
}

const cwd = "C:\\dev\\lumo";
const SCENES = {
  // The closed island with everything going on opens on the home; Y allows the waiting request.
  home: { query: "busy&plans&view=home&wait", width: 1000, height: 420, async play(s) {
    await s.page.evaluate(() => window.island.collapse());
    await s.wait(1200);
    s.mark();
    await s.move(640, 300, 10);
    await s.wait(1200);
    await s.move(500, 22, 900);
    await s.page.evaluate(() => window.island.expand("home"));
    await s.wait(1500);
    await s.moveTo(".home-btn.acc:visible", 900);
    await s.wait(400);
    await s.click();
    await s.wait(1800);
    await s.move(660, 380, 600);
    await s.wait(1500);
  } },
  // Claude Code asks to start a plan; Approve, and its steps tick off on the home.
  plan: { query: "x", width: 1000, height: 470, crop: "1000:330:0:0", async play(s) {
    const dir = "C:\\dev\\portfolio";
    await s.page.evaluate(() => window.island.collapse());
    await s.wait(1000);
    s.mark();
    await s.hook({ hook_event_name: "SessionStart", cwd: dir });
    await s.hook({ hook_event_name: "UserPromptSubmit", cwd: dir, prompt: "Add a dark mode toggle" });
    await s.wait(700);
    await s.hook({ hook_event_name: "PermissionRequest", cwd: dir, request_id: "rp", tool_name: "ExitPlanMode",
      tool_input: { plan: "1. Read the settings page\n2. Add the toggle\n3. Save it with the others\n4. Run the tests" } });
    await s.wait(1800);
    await s.moveTo(".allow-btn:visible", 800);
    await s.wait(250);
    await s.click();
    await s.wait(200);
    await s.page.evaluate(() => { window.island.setView("home"); window.State.notify(); });
    const steps = ["Read the settings page", "Add the toggle", "Save it with the others", "Run the tests"];
    for (let k = 0; k <= 4; k++) {
      await s.hook({ hook_event_name: "PreToolUse", cwd: dir, tool_name: "TodoWrite",
        tool_input: { todos: steps.map((content, i) => ({ content, status: i < k ? "completed" : i === k ? "in_progress" : "pending" })) } });
      await s.wait(1300);
    }
    await s.wait(1000);
  } },
  // A question typed in the chat; the answer streams in with a bar chart.
  chat: { query: "view=prompt&idle", width: 900, height: 470, async play(s) {
    const answer = "The slowest are the chat's tests: together they take more than half of the run.\n\n```lumo-chart bar Seconds per test file\nchat.test.mjs: 4.2\nmarkdown.test.mjs: 2.7\nrich-chart.test.mjs: 1.9\nhooks.test.mjs: 1.1\nmail-html.test.mjs: 0.6\n```\n\nWant me to split `chat.test.mjs` in two so they run side by side?";
    await s.page.evaluate((text) => {
      window.State.chatHistory = [];
      window.State.notify();
      window.__lumoMock = { ...window.__lumoMock, chat_send: async ({ chatId }) => {
        await new Promise((r) => setTimeout(r, 900));
        let shown = "";
        for (const word of text.split(/(?<=\s)/)) {
          shown += word;
          window.emitEv("chat-delta", { chat: chatId, text: shown });
          await new Promise((r) => setTimeout(r, 35));
        }
        return { text };
      } };
    }, answer);
    await s.wait(800);
    s.mark();
    await s.wait(500);
    await s.moveTo(".chat-input", 700);
    await s.click();
    await s.wait(200);
    await s.page.keyboard.type("Which of my test files are the slowest?", { delay: 45 });
    await s.wait(400);
    await s.page.keyboard.press("Enter");
    await s.move(860, 450, 500);
    await s.wait(7200);
  } },
};

const only = process.argv.slice(2);
for (const [name, scene] of Object.entries(SCENES)) {
  if (only.length && !only.includes(name)) continue;
  const dir = mkdtempSync(join(tmpdir(), `lumo-${name}-`));
  const s = await stage(scene.query, scene.width, scene.height, dir);
  await scene.play(s);
  await s.close();
  const webm = join(dir, readdirSync(dir).find((f) => f.endsWith(".webm")));
  const crop = scene.crop ? `crop=${scene.crop},` : "";
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(s.start), "-i", webm, "-vf",
    `${crop}fps=15,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
    join(MEDIA, `${name}.gif`)]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`docs/media/${name}.gif`);
}
