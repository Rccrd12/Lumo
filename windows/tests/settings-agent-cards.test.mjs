// Settings → Agents: Claude Code and Antigravity, one card each
// (src/settings/sections/agent-cards.ts). What works said in words, with a
// check; what is missing, a button; and a write to an agent's config still
// only after its diff is shown.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom } from "./fakedom.mjs";
import { calls, internals, sent } from "./tauri.mjs";

installFakeDom();
const { antigravityCard, claudeCard } = await import("../src/settings/sections/agent-cards.ts");

let answers;
const plainInvoke = internals.invoke;
internals.invoke = async (cmd, args) => {
  const result = await plainInvoke(cmd, args);
  if (cmd in answers) return typeof answers[cmd] === "function" ? answers[cmd](args) : answers[cmd];
  return result;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  calls.length = 0;
  answers = {};
});

const STATUS = {
  installed: true, current: true, planRelayInstalled: false,
  settingsPath: "C:\\Users\\me\\.claude\\settings.json", hookPath: "C:\\lumo-hook.exe", hookReady: true,
};

const labels = (card) => card.find(".setting-label").map((l) => l.textContent);
const row = (card, label) => card.find(".setting").find((r) => r.find(".setting-label")[0]?.textContent === label);

test("Claude Code: installed with its version, sign-in, sessions and plan in one card, the files folded away", async () => {
  answers.cli_info = { installed: true, path: "C:\\Users\\me\\.local\\bin\\claude.exe", version: "2.1.3" };
  const card = claudeCard({ ...STATUS });
  await flush();
  assert.deepEqual(sent("cli_info"), [{ provider: "claude-code" }]);
  assert.equal(card.find(".agent-card-state")[0].textContent, "All connected");
  assert.deepEqual(labels(card).slice(0, 5), ["Installed on this PC", "Sign-in", "Terminal sessions in the island", "Plan usage", "Ask Anthropic"]);
  assert.equal(row(card, "Installed on this PC").find(".setting-hint")[0].textContent, "Version 2.1.3");
  assert.equal(row(card, "Installed on this PC").find(".agent-card-check").length, 1);
  // The paths are under Technical details.
  const details = card.find("details")[0];
  assert.ok(details.find(".path").some((p) => p.textContent === STATUS.settingsPath));
  // Sign-in opens Claude Code's own window.
  row(card, "Sign-in").find("button")[0].fire("click");
  assert.deepEqual(sent("cli_sign_in"), [{ provider: "claude-code" }]);
});

test("Claude Code not connected: Connect… shows the diff first, and writes nothing on its own", async () => {
  answers.cli_info = { installed: true, path: "claude.exe", version: null };
  answers.hooks_preview = { diff: "+ \"hooks\": {}", backup: "settings.json.bak", fingerprint: "f" };
  const card = claudeCard({ ...STATUS, installed: false });
  await flush();
  assert.equal(card.find(".agent-card-state")[0].textContent, "One step missing");
  row(card, "Terminal sessions in the island").find("button")[0].fire("click");
  await flush();
  assert.deepEqual(sent("hooks_preview"), [{ install: true }]);
  assert.equal(card.find(".diff").length, 1);
  assert.deepEqual(sent("hooks_apply"), []);
});

test("not installed: the command to install it, to copy", async () => {
  answers.cli_info = { installed: false, path: null, version: null };
  const card = claudeCard({ ...STATUS, installed: false });
  await flush();
  assert.equal(card.find(".agent-card-state")[0].textContent, "Not installed");
  assert.equal(row(card, "Installed on this PC").find("code")[0].textContent, "irm https://claude.ai/install.ps1 | iex");
  assert.ok(row(card, "Sign-in").find("button")[0].disabled);
});

test("Antigravity: without Lumo's hooks, agy's skipped commands are said, and Connect… goes through the diff", async () => {
  answers.cli_info = { installed: true, path: "agy.exe", version: "1.4.7" };
  answers.agent_hooks_preview = { diff: "+ hook", backup: "", path: "hooks.json", fingerprint: "f" };
  const hooks = { id: "antigravity", name: "Antigravity", installed: false, path: "C:\\Users\\me\\.gemini\\config\\hooks.json", hookReady: true, approvals: true, note: "" };
  const card = antigravityCard(hooks, {});
  await flush();
  assert.deepEqual(sent("cli_info"), [{ provider: "antigravity-cli" }]);
  assert.equal(card.find(".agent-card-state")[0].textContent, "One step missing");
  const sessions = row(card, "Sessions and commands in the island");
  assert.match(sessions.find(".setting-hint")[0].textContent, /skips the commands/);
  sessions.find("button")[0].fire("click");
  await flush();
  assert.deepEqual(sent("agent_hooks_preview"), [{ agent: "antigravity", install: true }]);
  assert.deepEqual(sent("agent_hooks_apply"), []);
});
