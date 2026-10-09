# Contributing to Lumo

Thanks for wanting to help Lumo grow up! 🫶

## Getting started

The app lives in `windows/` (Tauri: Rust in `src-tauri/`, TypeScript in `src/`,
the `lumo-hook` relay in `hook/`, package `coucou-hook`). You need [Rust](https://rustup.rs) and
[Node 22.18+](https://nodejs.org); on Linux, also the system libraries listed in
[windows/README.md](windows/README.md#linux).

```bash
cd windows
npm install
npm run tauri dev      # live-reloading development build
```

Run the checks before opening a pull request:

```bash
cd windows
npx tsc --noEmit                        # type check
npm test                                # island tests
cargo build --release -p coucou-hook    # the app bundles the relay
cargo test --workspace                  # Rust tests
```

## Translations

The interface strings come from `windows/i18n-source/Localizable.xcstrings`,
turned into `windows/src/i18n/strings.json` by `node scripts/gen-strings.mjs`
(never edit `strings.json` by hand). Strings that only Windows and Linux show go
in `windows/src/i18n/extra.json`, keyed by the English text, with every language.

## Good first contributions

- A new agent: any agent already gets its own automatic pill by sending `coucou_agent` in its hook payload (see `docs/AGENTS.md`). Add an entry in `windows/src/core/pills.ts` only if you want it to be declarable in Settings.
- A new emote or sound for Lumo.
- Bug fixes — please describe how to reproduce.

## Rules of the house

- Secrets go in the OS credential store (Windows Credential Manager, Secret Service on Linux), never on disk or in git.
- No telemetry, no network calls except to services the user configured.
- Never block Claude Code: if the app doesn't answer, the hook must exit right away.
- Never write `~/.claude/settings.json` without a backup and the user's confirmation.
- Keep it light: 0 % CPU when the island is hidden.

## Pull requests

- One topic per PR, with a short GIF or screenshot for anything visual.
- Type check and tests must pass with no new warnings.
