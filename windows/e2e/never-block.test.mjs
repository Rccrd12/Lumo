// Never block Claude Code: whatever state Lumo is in, the relay answers at
// once or hands the request back to the terminal, and never allows by itself.

import assert from "node:assert/strict";
import { after } from "node:test";

import { Lumo } from "./lib/app.mjs";
import { flow, step } from "./lib/flow.mjs";
import { behavior } from "./lib/hook.mjs";

const G = "Never block";
const app = new Lumo("never-block");
after(() => app.close());

flow(G, "Lumo closed: the relay answers at once, with no decision", null, async () => {
  const agent = app.agent("closed");
  const t0 = Date.now();
  const reply = await agent.permission("Bash", { command: "npm test" }).result(5_000);
  step(`lumo-hook exited ${reply.code} after ${Date.now() - t0} ms: ${reply.stdout.trim() || "(nothing)"}`);
  assert.equal(reply.code, 0);
  assert.equal(behavior(reply), null, "with Lumo closed, no decision may be made");
  assert.ok(reply.ms < 2_000, `the relay took ${reply.ms} ms (it gives the pipe 300 ms)`);
});

flow(G, "Events nobody waits on return at once", app, async () => {
  await app.launch();
  const agent = app.agent("events");
  for (const event of [
    { hook_event_name: "SessionStart", source: "startup" },
    { hook_event_name: "UserPromptSubmit", prompt: "hello" },
    { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "README.md" } },
    { hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "README.md" }, tool_response: {} },
    { hook_event_name: "Stop" },
  ]) {
    const reply = await agent.send(event).result(5_000);
    step(`${event.hook_event_name}: ${reply.ms} ms`);
    assert.ok(reply.ms < 2_000, `${event.hook_event_name} took ${reply.ms} ms`);
  }
});

flow(G, "Lumo quits while a card waits: the terminal takes over", app, async () => {
  if (!app.proc) await app.launch();
  const agent = app.agent("quit");
  await agent.start();
  const req = agent.permission("Bash", { command: "echo waiting" });
  await app.d.visible(".cp-approval .cp-action.allow, .allow-btn", 10_000, "the card");
  step("the card is up: Lumo is killed");
  const t0 = Date.now();
  await app.quit();
  const reply = await req.result(10_000);
  step(`lumo-hook answered ${Date.now() - t0} ms later: ${reply.stdout.trim() || "(nothing)"}`);
  assert.equal(behavior(reply), null, "no decision may come from a Lumo that went away");
});
