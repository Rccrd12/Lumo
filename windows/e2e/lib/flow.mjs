// One user flow = one node:test test, timed, with what it did written down
// and, when it fails, screenshots of the island and of the whole screen.
// Every result goes to e2e-out/results.jsonl for the run's summary.

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { OUT } from "./app.mjs";

const SHOTS = join(OUT, "shots");
mkdirSync(SHOTS, { recursive: true });

let steps = [];
/** A line in the current flow's story, shown when it fails. */
export function step(text) {
  steps.push(text);
  console.log(`    · ${text}`);
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/** The whole screen as the user would see it (the webview's own shot has no transparency). */
function desktopShot(file) {
  const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
[System.Drawing.Graphics]::FromImage($bmp).CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('${file.replace(/'/g, "''")}')`;
  spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore", timeout: 15_000 });
}

/**
 * A flow of `group`. `app` is the Lumo it drives (for the screenshots).
 * `todo` marks a known bug: it runs and is reported, but does not fail the run.
 */
export function flow(group, name, app, fn, { todo } = {}) {
  test(name, todo ? { todo } : {}, async () => {
    steps = [];
    const t0 = Date.now();
    const shots = [];
    let error = null;
    try {
      await fn();
    } catch (err) {
      error = err;
      const base = `${slug(group)}--${slug(name)}`;
      try {
        if (app?.d?.sid) {
          const png = await app.d.shot();
          writeFileSync(join(SHOTS, `${base}-island.png`), png);
          // Where the artifact cannot be opened, the log carries the picture.
          if (process.env.LUMO_E2E_SHOTS_IN_LOG === "1") {
            const b64 = png.toString("base64");
            for (let i = 0; i < b64.length; i += 4000) console.log(`B64 ${base} ${b64.slice(i, i + 4000)}`);
          }
          shots.push(`${base}-island.png`);
          step(`island at failure: ${JSON.stringify(await app.state())}`);
        }
      } catch {}
      desktopShot(join(SHOTS, `${base}-screen.png`));
      shots.push(`${base}-screen.png`);
      throw err;
    } finally {
      const result = {
        group,
        name,
        status: error ? (todo ? "known" : "failed") : "passed",
        ms: Date.now() - t0,
        error: error ? String(error.message ?? error) : null,
        todo: todo ?? null,
        steps,
        shots,
      };
      appendFileSync(join(OUT, "results.jsonl"), JSON.stringify(result) + "\n");
    }
  });
}
