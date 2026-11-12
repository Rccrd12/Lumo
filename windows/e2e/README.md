# End-to-end tests

The real Lumo, driven the way a person uses it, on every pull request that
touches `windows/` (`.github/workflows/windows-e2e.yml`, on `windows-latest`).

- **The app**: built with `--features e2e` and `src-tauri/tauri.e2e.conf.json`,
  the release's code plus the WebView2 DevTools port (9222) the WebDriver
  attaches to. That build is never shipped.
- **The page**: `msedgedriver` of the machine's WebView2 version attaches to the
  island and Settings windows (`lib/driver.mjs`, a WebDriver client on `fetch`,
  no dependencies).
- **The mouse**: a real one (`lib/input.mjs`, `SetCursorPos` and `mouse_event`).
  Lumo follows the OS cursor from Rust, so a page click alone never opens the
  island or drags a grip.
- **The agent**: a fake Claude Code that runs the real `lumo-hook.exe` with hook
  JSON on stdin and reads what it answers (`lib/hook.mjs`).
- **The profile**: each file starts Lumo in its own folder under
  `e2e-out/profiles` (`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`), so a run never
  touches anyone's settings.

## Flows

| File | What it checks |
| --- | --- |
| `chat-text.test.mjs` | A sent question's multiplications (`8*10^-9`) keep their stars, with no italics |
| `formula-ink.test.mjs` | No box cuts a formula's ink (subscripts, fractions, the last letter's lean): the chat's formulas, the steps card's step, the step before and the list, the calculator's top line; each box photographed as shown and with nothing cut, the two compared (`lib/ink.mjs`, `lib/png.mjs`) |
| `permission.test.mjs` | Allow and Deny reach Claude Code (closed island and full card), the 600 ms click guard, a small and a 400 KB Write, a long plan, a question, two requests in line |
| `never-block.test.mjs` | The relay answers at once when Lumo is closed, events nobody waits on, Lumo quitting while a card waits |
| `island-size.test.mjs` | The chat's size across a restart, and resizing the chat leaves the home's size alone |
| `pickers.test.mjs` | Choose… in the Listening form: Windows' folder picker belongs to the island, so it shows over it, and a click in it keeps the form open |
| `settings-island.test.mjs` | Settings inside the island: the relay installed from there after Windows' own Yes (Cancel writes nothing), the Settings window staying shut, no write without its preview, and the separate Settings window made only when first opened, showing its page |

A new flow is a `flow(group, name, app, async () => { … })` in a
`*.test.mjs` file; `step()` lines are printed in the run's log. A known bug can
be marked `{ todo: "…" }`: it runs and is reported without failing the run.

## Reading a run

The run's page shows a table of every flow (`summary.mjs`). On a failure the
`e2e` artifact holds a screenshot of the island and of the desktop
(`e2e-out/shots`), `results.jsonl` and each profile's `lumo.log`.

## Running them on your PC

They start and stop Lumo and move your mouse, so close your own Lumo first:

```powershell
cd windows
cargo build --release -p lumo-hook
npx tauri build --debug --no-bundle --features e2e --config src-tauri/tauri.e2e.conf.json
$env:MSEDGEDRIVER = "C:\path\to\msedgedriver.exe"   # the version of your WebView2
$env:LUMO_E2E_LOCAL = "1"
node --test --test-concurrency=1 --test-reporter=spec "e2e/*.test.mjs"
```
