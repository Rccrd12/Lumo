# Lumo — guide for AI coding agents

Lumo for Windows is a Tauri app (`windows/`), a fork of a macOS app by Louis Raillé (credited in README.md and LICENSE-ASSETS.md), which is not in this repository. Lumo, a small ring of light living at the top of the screen, shows AI coding agent sessions (Claude Code, Codex, Gemini CLI, Antigravity and more) and a few integrations, and lets the user approve, answer, chat and drop files from the island.

## Where things are
- `windows/` — the Tauri app for Windows: Rust in `src-tauri/`, TypeScript in `src/`, the `lumo-hook` relay in `hook/`, the local models' chat loop in `local/` (crate `lumo-local`, no Tauri, so its fake-server tests run on any system). `windows/README.md` documents the app.
- `windows/src/core/pills.ts` — single source of truth for all declared pills (workspace tools, agents, AI providers, services). Every pill ID, color, category and subtitle lives here.
- `windows/assets/sounds/` — the 22 WAV sounds (served and bundled by `windows/vite.config.ts`).
- `windows/i18n-source/Localizable.xcstrings` — the string catalog; `node windows/scripts/gen-strings.mjs` turns it into `windows/src/i18n/strings.json` (never edit by hand). Windows-only strings live in `windows/src/i18n/extra.json`.
- `windows/screenshots/` — reference screenshots of the shipped views.
- `windows/e2e/` — end-to-end tests of the real app (real mouse, real `lumo-hook`), run on every PR by `.github/workflows/windows-e2e.yml`; see `windows/e2e/README.md`.
- `docs/AGENTS.md` — the hook payload protocol for agents.

## Build
```
cd windows && npm install && npm run tauri dev
```
Checks: `cd windows && npx tsc --noEmit && npm test`, then `cargo build --release -p lumo-hook && cargo test --workspace`.

## Rules
- Tauri 2, Rust + TypeScript with no front-end framework. No third-party dependencies unless truly unavoidable. The character is drawn in code (Canvas 2D), no Rive/Lottie/images.
- Secrets live in the OS credential store (Windows Credential Manager), never on disk or in git.
- No telemetry. Network calls only to services the user configured. Exception, the user's choice: images in chat answers (a line that is only `![alt](https://…)`) are downloaded by `windows/src-tauri/src/web_image.rs`, automatically only from `AUTO_HOSTS` (Wikimedia), from any other site after a click on Load image (https, public addresses only, image types only, 8 MB at most; the site sees the full address the AI wrote, so never add a host to `AUTO_HOSTS` whose owner could read who asked for what); Settings → Security → Images from the web turns it off. Exception, the user's choice: once when Lumo opens, `windows/src-tauri/src/updater.rs` asks GitHub for the releases of `UPDATE_REPO` (no data about the computer is sent, the download only starts from a click on Update now); Settings → Updates → Check when Lumo opens turns it off.
- Never block Claude Code: if the app doesn't answer, the hook exits immediately.
- Never overwrite `~/.claude/settings.json`: dated backup, merge, show the diff, write only after the user confirms.
- Never send an email or approve a Claude Code or Codex permission without an explicit click.
- Performance: 0 % CPU when the island is hidden.
- Keep the app identifier `com.rccrd12.lumo` (data folders, credential store entries, the WebView's data and permissions depend on it).
- Lumo's names are its own everywhere: the `lumo` crate and binary, the `lumo-hook` relay, `%APPDATA%`/`%LOCALAPPDATA%\com.rccrd12.lumo`, the `lumo_agent` hook tag, `LUMO_*` variables. The names the app had before 0.4.1 appear only in `windows/src-tauri/src/migrate.rs` and `windows/src/core/legacy.ts`, which move the user's data once and recognise hooks installed before; never write them anywhere else, nor the original project's name outside the credits in README.md and LICENSE-ASSETS.md. The repository is `Rccrd12/Lumo` (`UPDATE_REPO` in `windows/src-tauri/src/updater.rs`).
- Never restyle what already ships (pills, cards, Settings, chat…): existing views stay exactly as they are in `main`, which is the released build. Change the look of an existing view only when explicitly asked.
- Pill IDs are stable contract values (credential store, settings, hook routing): never rename an existing pill ID.
- New views follow the existing app style. `windows/screenshots/` are references for new work, not a reason to change existing views.
- Every release adds its CHANGELOG.md section, a row in the README Versions table, and bumps the version in `windows/src-tauri/tauri.conf.json`, `windows/package.json` and `windows/Cargo.toml` (the release workflows check they match the tag).
