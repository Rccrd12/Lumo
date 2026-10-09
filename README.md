<div align="center">

<img src="windows/src-tauri/icons/128x128@2x.png" width="96" alt="Lumo icon">

# Lumo

**A tiny friend that lives at the top of your screen on Windows and Linux and keeps an eye on your AI coding agent sessions.**

Approve permissions, watch your agents work, drop a file, chat with Claude — all without leaving what you're doing.

[![Version](https://img.shields.io/github/v/release/Rccrd12/Lumo?filter=windows-v*&label=version&color=0A84FF)](https://github.com/Rccrd12/Lumo/releases)
![Windows 10/11](https://img.shields.io/badge/Windows-10%2F11-0078D4?logo=windows&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-AppImage%20%7C%20deb%20%7C%20rpm-FCC624?logo=linux&logoColor=black)
![Tauri 2](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)
![Code: MIT](https://img.shields.io/badge/code-MIT-green)

<img src="windows/screenshots/greeting.png" width="640" alt="Lumo lighting up at launch">

</div>

---

Lumo is a fork of [Louis-CFM/coucou](https://github.com/Louis-CFM/coucou) (Coucou, by Louis Raillé) that keeps only the Windows and Linux app (a [Tauri 2](https://tauri.app) app in [`windows/`](windows/)). The app, its character and the repository are called Lumo here. The full documentation of the app is in [`windows/README.md`](windows/README.md).

Meet **Lumo**: a small ring of light that peeks out of the top edge of your screen, lights up to say hello, follows your cursor with its eyes, gets annoyed when you poke it (and dizzy if you insist), and tells you the moment Claude Code needs you.

## Features

- 🤖 **Claude Code, Codex, Copilot CLI, Muse Code, Gemini CLI, Antigravity, Cursor, OpenCode, Amp, Hermes, Claude Desktop and other agents, live** — see every session in the island: what it reads, edits and runs, step by step. Tag a hook payload with `coucou_agent` to give any agent its own pill (see [`docs/AGENTS.md`](docs/AGENTS.md)). Finished? Lumo does a happy little jump.
- See what Claude is editing, live: each file modification shows the file name and +N −M counts in the ticker, click it to read the full diff.
- ✅ **Approve and answer from the island** — permission requests show up with **Allow / Deny** for Claude Code (from any terminal), Codex, Copilot CLI and Muse Code; `AskUserQuestion` prompts show the choices right in the island. Nothing is ever allowed without your click.
- 🧑‍💻 **Open terminal** — brings the window a session runs in to the front.
- 💬 **Chat with Claude, Google AI (Gemini), OpenAI, OpenRouter, or a local model (Ollama, LM Studio, any OpenAI-compatible server)** — click the model name above the chat box to switch provider and model. Cloud providers use your own API key.
- 🧠 **Chat with your Claude plan** — pick **Claude Code** above the chat box and the island talks to the Claude Code CLI you already use, no API key; every action it wants to take comes up as an Allow / Deny card.
- 🖼️ **Show the chat your screen** — your open windows or a screenshot, only when you ask; `Ctrl+Alt+P` asks about the screen, `Ctrl+Alt+X` about the selected text, from any app.
- 📊 **Plan usage** — small pills in the island's header show your 5-hour and weekly Claude plan limits, and your Codex limits. Off by default; Settings → Agents → Plan usage.
- 📋 **Declare the tools you use** — Settings → Pills & integrations: pick your main tool (VS Code, Cursor, Codex or Antigravity), then up to 4 more agents, chat providers and services.
- 📎 **Drop a file on the island** — Lumo turns into a box and swallows it, then answers questions about it.
- 🖥️ **Lumo on the desktop** — drag Lumo out of the island to set him loose on your desktop: he follows your cursor, wears his outfit, flies home for alerts and comes back where you left him.
- 🧲 **An island that docks anywhere** — drag it to the top, bottom, left or right edge, resize it, zoom it.
- 🔌 **Integrations** — Stripe payments, n8n workflows, GitHub (open PRs, reviews requested, CI status, contributions), Vercel deployments, Resend emails, Notion, Cal.com. Each one gets its own little colored Lumo.
- 👗 **Dress Lumo up** — right-click him for the wardrobe, and pick his look there: a ring of light, a dot, a soft drop or a firefly. He also dresses up for the seasons on his own.
- ⌨️ **Keyboard shortcuts** — open the chat, jump to an alert or a terminal, switch pills, mute or open the wardrobe from anywhere; all customizable in Settings → Shortcuts.
- 🎭 **A real character** — idle breathing, blinks, eyes on a sphere that follow your mouse, emotes, handcrafted sounds, a greeting on launch.
- 🫥 **Invisible when idle** — hides away when nothing is running, peeks out when you hover the top edge of the screen.
- 📅 **Weekly recap** — every Monday Lumo sums up the past week: time coding, sessions, files, lines changed, commands, permissions, top agent and project. Share it as a 1080 × 1920 image with Lumo — project names optional. All local.
- 🌍 **10 languages** — English, 中文, हिन्दी, Español, العربية, Français, বাংলা, Português, Русский, Bahasa Indonesia. Pick one in Settings → General → Language.
- 🔒 **Private by design** — no telemetry, no account. Keys live in Windows Credential Manager or the Linux Secret Service (GNOME Keyring, KWallet). The app only talks to the services you plug in.

<table>
<tr>
<td><img src="windows/screenshots/approval.png" alt="A Claude Code permission request, with Deny and Allow"></td>
<td><img src="windows/screenshots/chat.png" alt="Chatting with Claude from the island"></td>
</tr>
<tr>
<td><img src="windows/screenshots/overview.png" alt="The overview: the focused integration on the left, the other pills on the right"></td>
<td><img src="windows/screenshots/drop.png" alt="Lumo turned into a box, waiting for a file"></td>
</tr>
</table>

## Versions

Windows and Linux builds are in Releases under the `windows-v*` and `linux-v*` tags; the newest Windows installer is always at [`windows-latest`](https://github.com/Rccrd12/Lumo/releases/tag/windows-latest). See [CHANGELOG.md](CHANGELOG.md) for the full notes of each version.

| Windows and Linux | Date | Highlights |
|-------------------|------|------------|
| [0.3.1](https://github.com/Rccrd12/Lumo/releases/tag/windows-v0.3.1) | Oct 8, 2026 | Now called Lumo, settings inside the island, a floating island that docks near the edges, choose how it opens and closes, it no longer disappears on its own |
| [0.3.0](https://github.com/Rccrd12/Lumo/releases/tag/windows-v0.3.0) | Oct 8, 2026 | Chat with your Claude plan through Claude Code, your screen on request, an island that docks on any edge and resizes, Settings in sections with updates |

## Install

### Windows

Download **[Lumo-Windows.msi](https://github.com/Rccrd12/Lumo/releases/download/windows-latest/Lumo-Windows.msi)** or **[Lumo-Windows-setup.exe](https://github.com/Rccrd12/Lumo/releases/download/windows-latest/Lumo-Windows-setup.exe)** (Windows 10/11, always the newest version) and run it. You can also [build it from source](#build-from-source).

**Windows will show a warning the first time — that's expected.** The installer isn't code-signed yet, so SmartScreen doesn't know the publisher:

1. A **"Windows protected your PC"** screen appears, with *Publisher: Unknown publisher*.
2. Click **More info** (*Informations complémentaires* in French). This reveals a **Run anyway** button.
3. Click **Run anyway** (*Exécuter quand même*). The installer starts normally.

This is only because the app isn't signed with a paid certificate yet. Lumo is open source, and Microsoft Defender scans the installer as clean.

**Settings… → Updates → Check for updates** looks for the newest `windows-v*` release of this repository, only when you click it.

**Coming from Coucou 0.3.0?** The app was called Coucou before 0.3.1. Download the installer above and run it: it replaces Coucou with Lumo, one app in Settings → Apps, one Start menu entry, one autostart entry, with your settings, keys, hooks and history as they were.

There is no notch on a PC, so the island slides out of the top edge of the screen
instead of hiding inside one. See [`windows/README.md`](windows/README.md) for the
rest of the differences.

### Linux

Linux builds are published from `linux-v*` tags in [Releases](https://github.com/Rccrd12/Lumo/releases), x86_64 only; until one is there, [build it from source](#build-from-source).

- **AppImage** (any distribution): `chmod +x Lumo-Linux-*.AppImage`, then run it.
- **Debian / Ubuntu**: `sudo apt install ./Lumo-Linux-*.deb` (replaces the `coucou` package)
- **Fedora / openSUSE**: `sudo dnf install ./Lumo-Linux-*.rpm` (replaces the `coucou` package)

Check a download with `sha256sum -c SHA256SUMS --ignore-missing`.

The island sits on the top edge on compositors with layer-shell — COSMIC, KDE
Plasma, Hyprland, Sway and other wlroots compositors. GNOME has no layer-shell,
so there it runs through XWayland as a dock window at the top of the screen. See [`windows/README.md`](windows/README.md#linux).

### Build from source

**Windows** — requirements: [Rust](https://rustup.rs), Node 22.18+, MSVC build tools.

```powershell
git clone https://github.com/Rccrd12/Lumo.git
cd Lumo/windows
npm install
npm run tauri dev           # live-reloading development build
npm run pack                # installer lands in windows/release/
```

**Linux** — requirements: [Rust](https://rustup.rs), Node 22.18+, and the WebKitGTK,
gtk-layer-shell and appindicator development packages (Debian/Ubuntu names below).

```bash
sudo apt install build-essential pkg-config \
  libwebkit2gtk-4.1-dev libgtk-layer-shell-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev libdbus-1-dev patchelf \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good
git clone https://github.com/Rccrd12/Lumo.git
cd Lumo/windows
npm install
npm run pack                # AppImage, .deb and .rpm land in windows/release/
```

## Setup

Click the Lumo icon in the system tray → **Settings…**

| What | Why | Where the key goes |
|---|---|---|
| **Claude Code hooks** | live sessions and approvals | Settings → Agents → Claude Code → **Install hooks** — Lumo backs up `~/.claude/settings.json`, merges its hooks and shows you the diff before writing anything |
| **Other agents** | their sessions in the island | Settings → Agents, same backup, diff and confirmation |
| **Plan usage** | Claude and Codex limits in the island's header | Settings → Agents → Plan usage |
| **Anthropic API key** | chat and questions about files | Settings → Chat → Claude · Windows Credential Manager / Secret Service |
| **Google AI, OpenAI, OpenRouter keys** | chat with other providers | Settings → Chat → Chat providers · Windows Credential Manager / Secret Service |
| **Local models** | chat with Ollama, LM Studio or an OpenAI-compatible server | Settings → Chat → Local models |
| Stripe, n8n, GitHub, Vercel, Resend, Notion, Cal.com | the service pills | Settings → Pills & integrations · Windows Credential Manager / Secret Service, all optional |

If Lumo isn't running, the hook exits immediately: **Claude Code is never blocked.**

The full list of supported agents, what each one installs and how it answers is in [`windows/README.md`](windows/README.md#supported-agents).

## Shortcuts

| Do this | Lumo does that |
|---|---|
| Move the mouse to the very top-centre of the screen | peeks out and says hi 👋 |
| Click the small island | opens |
| Click Lumo | squish + annoyed; 3 times fast and he's 😵‍💫 dizzy |
| Right-click Lumo | the wardrobe |
| Drag a file onto the island | turns into a box and swallows it |
| Drag Lumo out of the island | he moves onto your desktop |
| `Ctrl+Alt+Space` | opens the chat, from any app |
| `Ctrl+Alt+P` / `Ctrl+Alt+X` | asks about your screen / the selected text |
| `Ctrl+Alt+A` | jumps to the waiting permission or question |
| `Ctrl+Alt+T` | brings the session's window forward |
| `Ctrl+Alt+→` / `Ctrl+Alt+←` | next / previous pill |
| `Ctrl+Alt+S` | mutes or unmutes Lumo |
| `Ctrl+Alt+G` | opens the wardrobe |
| `Esc` | closes the island |

Every global shortcut can be changed or turned off in **Settings… → Shortcuts**. On Linux, global shortcuts work in an X11 session; on Wayland, Settings lists commands to bind in your desktop's own keyboard settings.

## How it works

- A [Tauri 2](https://tauri.app) app (Rust + TypeScript): the island is a transparent, always-on-top window that never steals focus; Lumo is drawn in Canvas 2D, with no images.
- Claude Code and the other agents' hooks go through a tiny `coucou-hook` relay: a named pipe on Windows, a Unix socket in `$XDG_RUNTIME_DIR` on Linux. For approvals it waits for your click, and gives up within moments if the app doesn't answer.
- On Wayland the island is a gtk-layer-shell overlay anchored to the top edge, and click-through is its input region.
- Integrations are lightweight pollers, paused when nothing is watching.
- Details and differences from the original Mac app in [`windows/README.md`](windows/README.md).

## Privacy

- No telemetry, no account, no background update checks.
- Keys live in Windows Credential Manager or the Linux Secret Service, never on disk and never in the interface.
- The only network requests Lumo makes are to the services you configure yourself.
- Screenshots and the window list are taken only when you ask, and shown to you before anything is sent.
- The log and the weekly recap history stay on your machine.

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Lumo is a fork of [Louis-CFM/coucou](https://github.com/Louis-CFM/coucou), the Coucou app created by [Louis Raillé](https://louisraille.fr).

## License

- **Code:** [MIT](LICENSE) — use it, fork it, learn from it, just keep the copyright notice.
- **The name Lumo, the Lumo character, its icon, sounds and screenshots:** © Riccardo Gentili, all rights reserved — see [LICENSE-ASSETS.md](LICENSE-ASSETS.md).
- **The names Coucou and Mochi, the Mochi character and Coucou's icon, sounds and media:** © Louis Raillé. That is why this fork has a name and a character of its own.
