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
| `chat-text.test.mjs` | A sent question's multiplications (`8*10^-9`) keep their stars, with no italics; a long question folds, Show more opens it downwards from where it is read (the log is not carried to its end), Show less stays in sight in the middle of it and folds it back in view |
| `formula-ink.test.mjs` | No box cuts a formula's ink (subscripts, fractions, the last letter's lean): the chat's formulas, the steps card's step, the step before and the list, the calculator's top line; each box photographed as shown and with nothing cut, the two compared (`lib/ink.mjs`, `lib/png.mjs`) |
| `permission.test.mjs` | Allow and Deny reach Claude Code (closed island and full card), the 600 ms click guard, a small and a 400 KB Write (its whole numbers, and Allow), a 200 KB command (its beginning and its end, and Allow), two such commands in a row (the second card grows too, its Allow inside the island), arguments Lumo can't read (said on the card, no Allow, Deny reaches the agent), a long plan, a question, two requests in line |
| `never-block.test.mjs` | The relay answers at once when Lumo is closed, events nobody waits on, Lumo quitting while a card waits |
| `permission.test.mjs` (computer use) | A click on a computer action's card leaves the keyboard where it was, so what the agent opened stays open |
| `island-size.test.mjs` | The chat's size across a restart, and resizing the chat leaves the home's size alone |
| `pickers.test.mjs` | Choose… in the Listening form: Windows' folder picker belongs to the island, so it shows over it, and a click in it keeps the form open |
| `screen-capture.test.mjs` | A screen capture over the island (a small program of the test's own named `Greenshot.exe`, `lib/capture.mjs`): its overlay stays above the island even when the island climbed above it a moment before, the island neither hears nor opens under the capture's mouse, opens again once the capture ends, and keeps opening under the mouse while an image the tool pinned to the screen is in front; set to close on a click outside it, a click in a capture leaves the island open and one with no capture closes it |
| `settings-island.test.mjs` | Settings inside the island: the relay installed from there after Windows' own Yes (Cancel writes nothing), the Settings window staying shut, no write without its preview, Settings the island folded on its own back from the tray icon's Open, Escape in them leaving a pinned island open, and the separate Settings window made only when first opened, showing its page |
| `drag-under-island.test.mjs` | Under the island (a small program of the test's own, `lib/drag-source.mjs`): a file picked up there by a real OLE drag opens the drop zone at its own 640 × 176 (with sizes kept for other views, and a stale one under its own name) and arrives; a maximised window dragged by its title bar comes out of full screen and stays where it is let go; text selected by dragging is selected; a window carried across the island with Open on hover on does not open it, nor let go on it, and the next hover does. The island stays closed for all but the file |

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
