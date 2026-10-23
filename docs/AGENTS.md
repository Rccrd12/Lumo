# Lumo — third-party agent integration

Any tool that can run a command on its hook events, or write to a named pipe, can send events to Lumo for Windows and have its own pill next to Claude Code.

## The `lumo_agent` field

Add the optional field `lumo_agent` to any hook JSON payload. Lumo will create a pill labelled with the agent name and route all events to it.

**Validation:** the name must match `^[a-z0-9-]{1,24}$` (lowercase letters, digits and hyphens, 1–24 characters). An absent or invalid name routes the event to the Claude Code pill instead.

## Hook command

Configure your tool to call the Lumo relay, `lumo-hook.exe`, with `--agent <your-name>`. Lumo keeps it in `%LOCALAPPDATA%\com.rccrd12.lumo\bin\`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "type": "command", "command": "C:\\path\\to\\lumo-hook.exe --agent my-tool" }
    ]
  }
}
```

## Payload format

The relay adds `lumo_agent` to the JSON it forwards. You can also add it yourself if you talk to the pipe directly:

```json
{
  "hook_event_name": "UserPromptSubmit",
  "session_id": "my-session-1",
  "lumo_agent": "my-tool",
  "prompt": "Running task…"
}
```

Send newline-terminated JSON to the named pipe `\\.\pipe\lumo-<user-SID>`. The pipe name carries your Windows account's SID, so each user has their own.

## Supported events

All standard Claude Code hook events are supported. `PermissionRequest` gets an Allow / Deny
card for Claude Code, Codex (`codex`), GitHub Copilot CLI (`copilot`) and Muse Code (`muse`),
and for the shell commands of the island's own Antigravity CLI chat. A `PermissionRequest`
from any other agent is answered immediately with no decision, so the relay writes nothing
and the agent asks in its own terminal.

The pill lifecycle:

| Event | Effect |
|---|---|
| `SessionStart` | Creates the pill (if absent), sets state to idle |
| `UserPromptSubmit` | State → thinking; prompt shown in ticker |
| `PreToolUse` | State → working; tool label shown in ticker |
| `PostToolUse` / `PostToolUseFailure` | State → working |
| `Notification` | Rate-limit or question state if applicable |
| `Stop` | State → finished for 5 s; active declared pills (catalog + checked in Settings) reset to idle — all others are removed |
| `StopFailure` | State → error |
| `SessionEnd` | Active declared pills (catalog + checked in Settings) reset to idle — all others are removed |
| `SubagentStart` / `SubagentStop` | Step added to ticker |

## Declared pills

A **declared pill** is a catalog entry (`windows/src/core/pills.ts`) that has been enabled in **Settings → Active pills**. When a session ends for a declared pill, the pill stays visible and resets to idle instead of disappearing.

A catalog pill that is not checked in Settings behaves like any other agent: it gets an automatic pill when a session starts, and that pill is removed when the session ends.

Settings → Active pills offers Cursor (`agent_cursor`), Antigravity (`agent_antigravity`),
Codex (`agent_codex`), GitHub Copilot CLI (`agent_copilot`), Muse Code (`agent_muse`),
OpenCode (`agent_opencode`), Amp (`agent_amp`) and Hermes (`agent_hermes`); their hooks or
plugins are installed from **Settings → Agents**. Gemini CLI (`agent_gemini`) is retired,
replaced by Antigravity CLI: its ID stays reserved.

Claude Desktop (`agent_claude-desktop`) is there as well. Claude Code sessions started from the Claude desktop app's Code tab carry `CLAUDE_CODE_ENTRYPOINT=claude-desktop`; the relay tags them `lumo_agent: claude-desktop` on its own (an explicit `--agent` still wins), so nothing extra is installed. Declare the pill to keep it after the session ends; the ↗ button opens the Claude app.

## Real-world examples

### Gemini CLI

Retired: Google replaced Gemini CLI with Antigravity CLI, so Lumo no longer offers it.
Hooks installed before still work: they wrote to `~/.gemini/settings.json` with
`--agent gemini`, and the relay translates Gemini event names to canonical Lumo events.

| Gemini CLI event | Canonical event |
|---|---|
| `BeforeTool` | `PreToolUse` |
| `AfterTool` | `PostToolUse` |
| `BeforeAgent` | `UserPromptSubmit` |
| `AfterAgent` | `Stop` |

`AfterModel` is not installed — it fires on every response chunk and would flood the island.

### Antigravity — `agy`

Lumo supports Antigravity out of the box via **Settings → Agents → Antigravity**.
The installer writes to `~/.gemini/config/hooks.json` (timeouts in seconds) and uses
`--agent antigravity`. The relay translates `toolCall.name` / `conversationId` to the
island's `tool_name` / `session_id`.

| Antigravity event | Canonical event |
|---|---|
| `PreInvocation` | `UserPromptSubmit` |
| `PreToolUse` | `PreToolUse` |
| `PostToolUse` | `PostToolUse` |
| `PostInvocation` | `PostToolUse` |
| `Stop` | `Stop` |

The relay answers `PreToolUse` with `{"decision":"ask"}`, so Antigravity's own permission
rules decide. One exception: the island's own chat with **Antigravity
CLI** runs `agy` headless (stream-json on stdin) with `LUMO_ISLAND_RUN=1`, where nothing can prompt. For that
run only, a shell command's `PreToolUse` (a tool name containing `command`, `shell` or
`terminal`) is forwarded as a `PermissionRequest`, shown as an Allow / Deny card over the
chat, and answered `{"decision":"allow"}` or `{"decision":"deny"}` after a click, or `ask`
(headless agy then skips the command) with no click. The `PreToolUse` hook is installed as
`--agent antigravity PreToolUse --wait 100` with a 110 s `timeout`, so the relay knows how long
it may wait; hooks installed without `--wait` (10 s timeout) give the card 8 s.

### GitHub Copilot CLI

Lumo supports Copilot CLI out of the box via **Settings → Agents → GitHub Copilot CLI**.
The installer writes to `~/.copilot/hooks/lumo.json` and uses `--agent copilot`.
Copilot CLI uses camelCase event names and `{"bash":"…","timeoutSec":N}` entries.
Copilot CLI is fail-closed on `permissionRequest`: the relay always outputs valid JSON
and returns `{"permissionDecision":"ask"}` on timeout so Copilot re-prompts in the terminal.
Lumo shows a real Allow / Deny card for Copilot approval requests.

| Copilot CLI event | Canonical event |
|---|---|
| `sessionStart` | `SessionStart` |
| `userPromptSubmitted` | `UserPromptSubmit` |
| `preToolUse` | `PreToolUse` |
| `permissionRequest` | `PermissionRequest` |
| `postToolUse` | `PostToolUse` |
| `agentStop` | `Stop` |
| `sessionEnd` | `SessionEnd` |
| `notification` | `Notification` |

### Muse Code

Lumo supports Muse Code out of the box via **Settings → Agents → Muse Code**.
The installer merges into `~/.config/muse/settings.json` and uses `--agent muse`.
Muse uses PascalCase event names. Lumo shows a real Allow / Deny card for Muse approval requests.

| Muse Code event | Canonical event |
|---|---|
| `SessionStart` | `SessionStart` |
| `UserPromptSubmit` | `UserPromptSubmit` |
| `PreToolUse` | `PreToolUse` |
| `PermissionRequest` | `PermissionRequest` |
| `PostToolUse` | `PostToolUse` |
| `Stop` | `Stop` |
| `SessionEnd` | `SessionEnd` |

### OpenCode

Lumo supports OpenCode via **Settings → Agents → OpenCode**.
The installer writes a JS plugin to `~/.config/opencode/plugins/lumo.js`, which starts the relay directly.
The plugin maps OpenCode event types to canonical Lumo names and forwards them fire-and-forget; OpenCode is never blocked.

| OpenCode event | Canonical event |
|---|---|
| `session.created` | `SessionStart` |
| `session.idle` | `Stop` |
| `session.error` | `StopFailure` |
| `session.deleted` | `SessionEnd` |
| `tool.execute.before` | `PreToolUse` |
| `tool.execute.after` | `PostToolUse` |
| `permission.asked` | `PermissionRequest` |

### Amp

Lumo supports Amp via **Settings → Agents → Amp**.
The installer writes a TypeScript plugin to `~/.config/amp/plugins/lumo.ts`, which starts the relay directly.
The `tool.call` handler returns `{ action: 'allow' }` so Amp always proceeds; all events are forwarded display-only.

| Amp event | Canonical event |
|---|---|
| `session.start` | `SessionStart` |
| `agent.start` | `UserPromptSubmit` |
| `tool.call` | `PreToolUse` |
| `tool.result` | `PostToolUse` |
| `agent.end` | `Stop` |

### Hermes Agent

Lumo supports Hermes via **Settings → Agents → Hermes → Install plugin**.
The installer writes a Python plugin to `~/.hermes/plugins/lumo/` and enables it in
`~/.hermes/config.yaml`. The plugin uses `on_session_start` (sends the platform when running
via the gateway), `post_llm_call` (sends the final response), and a `pre_approval_request`
observer hook that fires a `⏳ Approval pending in Hermes` step on the island.
Approving from the island requires `register_approval_transport`, which is not yet available
in Hermes 0.15.x; the Approvals toggle activates automatically once Hermes exposes it.
Every event is fire-and-forget: if the app is closed or unreachable, nothing is sent and Hermes carries on, handling approvals itself.

| Hermes event | Canonical event |
|---|---|
| `on_session_start` | `SessionStart` |
| `post_llm_call` | `Stop` |
| `pre_approval_request` | `PreToolUse` (observer only, shows "⏳ Approval pending in Hermes") |

### Any other tool

Follow the generic pattern: call `lumo-hook.exe --agent <your-name> <EventName>`
and let the relay forward the event.

## Quick test

With Lumo running, in PowerShell:

```powershell
'{"hook_event_name":"UserPromptSubmit","session_id":"t1","prompt":"hello","lumo_agent":"demo"}' |
  & "$env:LOCALAPPDATA\com.rccrd12.lumo\bin\lumo-hook.exe" --agent demo
```

A "demo" pill should appear in the island.
