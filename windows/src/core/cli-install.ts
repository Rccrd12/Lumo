// How Claude Code and the Antigravity CLI are installed: the commands their
// makers give for PowerShell, shown with a copy button where one is missing
// (views/chat-fix.ts, settings/sections/agent-cards.ts). Lumo never runs them.

export const INSTALL_COMMANDS = {
  claude: "irm https://claude.ai/install.ps1 | iex",
  agy: "irm https://antigravity.google/cli/install.ps1 | iex",
} as const;
